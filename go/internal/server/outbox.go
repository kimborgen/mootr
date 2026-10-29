package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// The peer outbox (src/mail.ts, S-235): mail to an agent on a peer that doesn't answer waits here and is redelivered to
// its peer every STAM_OUTBOX_MS (default 30 s), oldest first. Rows older than seven days are dropped, with a
// mail:expired event on the sender.

const outboxExpire = 7 * 24 * time.Hour

// outboxPass runs one delivery pass at a time. A pass asked for while another runs runs once more after it, so mail
// queued meanwhile isn't left for the next tick (S-235 review).
type outboxPass struct {
	mu      sync.Mutex
	running chan struct{}
	again   bool
	// ctx is the daemon's, which StartOutbox sets: a pass a send asks for outlives the request.
	ctx context.Context
}

// drainOutbox is src/mail.ts drainOutbox: a delivery pass, or one more after the pass now running. The channel closes
// when the pass (and any it was asked to repeat) ends.
func (s *Server) drainOutbox() <-chan struct{} {
	o := &s.outbox
	o.mu.Lock()
	defer o.mu.Unlock()
	ctx := o.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	if o.running != nil {
		o.again = true
		return o.running
	}
	done := make(chan struct{})
	o.running = done
	go func() {
		for {
			o.mu.Lock()
			o.again = false
			o.mu.Unlock()
			if err := s.deliverOutbox(ctx); err != nil && ctx.Err() == nil {
				slog.Error(fmt.Sprintf("outbox: %v", err))
			}
			o.mu.Lock()
			if !o.again || ctx.Err() != nil {
				o.running = nil
				o.mu.Unlock()
				close(done)
				return
			}
			o.mu.Unlock()
		}
	}()
	return done
}

// StartOutbox is src/mail.ts startOutbox: a pass every STAM_OUTBOX_MS until ctx ends, and one now, so mail queued
// before a restart doesn't wait a whole tick.
func (s *Server) StartOutbox(ctx context.Context) {
	s.outbox.mu.Lock()
	s.outbox.ctx = ctx
	s.outbox.mu.Unlock()
	s.drainOutbox()
	every := envMillis("OUTBOX_MS", 30*time.Second)
	if every <= 0 {
		every = 30 * time.Second
	}
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.drainOutbox()
			}
		}
	}()
}

// deliverOutbox is src/mail.ts deliverOutbox. A network failure, a 5xx or any answer that is neither a 200 nor a 4xx
// keeps the mail and stops that peer's queue until the next pass, so the peer gets its mail in order. A 4xx is the
// peer's refusal: the mail is dropped, and the sender hears it as mail:failed and a notice.
func (s *Server) deliverOutbox(ctx context.Context) error {
	expired, err := s.db.OutboxExpire(ctx, time.Now().Add(-outboxExpire).UTC().Format("2006-01-02T15:04:05.000Z"))
	if err != nil {
		return err
	}
	for _, row := range expired {
		body, sender := s.outboxBody(ctx, row)
		if sender == "" {
			continue
		}
		ev := outboxEvent(row, body)
		if row.LastError != nil {
			ev.Set("last_error", jsfmt.StringValue(*row.LastError))
		} else {
			ev.Set("last_error", jsfmt.NullValue())
		}
		if err := s.db.AddEvent(ctx, sender, "mail:expired", ev); err != nil {
			return err
		}
	}
	rows, err := s.db.OutboxRows(ctx)
	if err != nil {
		return err
	}
	stopped := map[string]bool{}
	for _, row := range rows {
		p, ok := s.peers.ByName(row.Peer)
		if !ok || stopped[row.Peer] {
			continue
		}
		body, sender := s.outboxBody(ctx, row)
		r, err := s.peers.Call(ctx, p, http.MethodPost, "/api/mail", []byte(row.Body), peers.DefaultTimeout, false, nil)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			// A network failure: the row stays, and this peer's queue waits for the next pass.
			if err := s.db.OutboxFailed(ctx, row.MailID, row.Peer, err.Error()); err != nil {
				return err
			}
			stopped[row.Peer] = true
			continue
		}
		refused := r.Status >= 400 && r.Status < 500
		if r.Status != http.StatusOK && !refused {
			// Only a 200 is delivery and only a 4xx a refusal: a 5xx (busy, restarting) or any other answer keeps the row,
			// and this peer's queue waits.
			if err := s.db.OutboxFailed(ctx, row.MailID, row.Peer, s.peers.RedactText(p, replyError(r))); err != nil {
				return err
			}
			stopped[row.Peer] = true
			continue
		}
		if err := s.db.OutboxDelete(ctx, row.MailID, row.Peer); err != nil {
			return err
		}
		if sender == "" {
			continue
		}
		ev := outboxEvent(row, body)
		if refused {
			// The peer refused the mail (4xx): it is dropped, so the peer's queue moves on.
			reason := replyError(r)
			copyField(&ev, body, "subject")
			ev.Set("error", jsfmt.StringValue(reason))
			if err := s.db.AddEvent(ctx, sender, "mail:failed", ev); err != nil {
				return err
			}
			s.queueNotice(ctx, sender, "The mail you queued failed: "+row.MailID+" to "+strings.Join(textList(body), ", ")+", subject \""+body.Text("subject")+"\": "+reason)
			continue
		}
		if err := s.db.AddEvent(ctx, sender, "mail:delivered_late", ev); err != nil {
			return err
		}
	}
	return nil
}

// outboxBody is a queued mail's body and its sender, when the sender is an agent here (src/mail.ts senderOf).
func (s *Server) outboxBody(ctx context.Context, row db.OutboxRow) (jsfmt.Value, string) {
	body, err := jsfmt.Parse([]byte(row.Body))
	if err != nil || body.Kind != jsfmt.Object {
		return jsfmt.Value{Kind: jsfmt.Object}, ""
	}
	from := body.Text("from")
	if from == "" {
		return body, ""
	}
	if _, err := s.db.GetAgent(ctx, from); err != nil {
		if !errors.Is(err, db.ErrNotFound) {
			slog.Error(fmt.Sprintf("outbox: sender of %s: %v", row.MailID, err))
		}
		return body, ""
	}
	return body, from
}

// outboxEvent is the fields every outbox event carries: the mail, its peer, and its recipients there.
func outboxEvent(row db.OutboxRow, body jsfmt.Value) jsfmt.Value {
	ev := jsfmt.Value{Kind: jsfmt.Object}
	ev.Set("id", jsfmt.StringValue(row.MailID))
	ev.Set("peer", jsfmt.StringValue(row.Peer))
	copyField(&ev, body, "to")
	return ev
}

// copyField sets key from src when src has it: a field TS leaves undefined is left out of the event.
func copyField(dst *jsfmt.Value, src jsfmt.Value, key string) {
	if v, ok := src.Get(key); ok {
		dst.Set(key, v)
	}
}

// replyError is a peer's `error`, else its status (`${r.data?.error ?? r.status}`).
func replyError(r peers.Reply) string {
	if v, ok := r.Data.Get("error"); ok && v.Kind != jsfmt.Null {
		if v.Kind == jsfmt.String {
			return v.Str
		}
		return jsfmt.Compact(v)
	}
	return strconv.Itoa(r.Status)
}

// textList is the body's `to`, the strings in it.
func textList(body jsfmt.Value) []string {
	var out []string
	v, _ := body.Get("to")
	if v.Kind != jsfmt.Array {
		return out
	}
	for _, x := range v.Items {
		if x.Kind == jsfmt.String {
			out = append(out, x.Str)
		}
	}
	return out
}

// startForQueued is src/mail.ts's start of a stopped peer for queued mail (S-245): direct mail to a live recipient,
// from the human, the chief of staff, or an ancestor of a named recipient (mayStartPeer, S-1473), starts the peer once
// (peers.EnsureUp shares a run), then delivers the outbox. A failed start is logged; the mail stays queued.
func (s *Server) startForQueued(ctx context.Context, p config.Peer, from, fromName string, direct bool, to, named []string) error {
	if !direct {
		return nil
	}
	start, asked, err := s.queuedStart(ctx, p, from, to, named)
	if err != nil || !asked {
		return err
	}
	sender := fromName
	if sender == "" {
		sender = from
	}
	if !start {
		slog.Info(fmt.Sprintf("peer:start %s: not started: mail from %s to %s waits in the outbox", p.Name, sender, strings.Join(named, ", ")))
		return nil
	}
	slog.Info(fmt.Sprintf("peer:start %s: queued mail from %s", p.Name, sender))
	go func() {
		if err := s.peers.EnsureUp(p); err != nil {
			slog.Error(fmt.Sprintf("peer:start %s: %s", p.Name, s.peers.RedactText(p, err.Error())))
			return
		}
		s.drainOutbox()
	}()
	return nil
}

// queuedStart is whether queued mail starts p: asked when startsPeer finds a live recipient, and start when the sender
// may start the peer for one of those live recipients. Only the live ones count: being the ancestor of a recipient that
// is shut down doesn't let mail to an unrelated live one wake a paid machine (S-4100 review).
func (s *Server) queuedStart(ctx context.Context, p config.Peer, from string, to, named []string) (start, asked bool, err error) {
	live, err := s.startsPeer(ctx, p, to, named)
	if err != nil || len(live) == 0 {
		return false, false, err
	}
	may, err := s.mayStartPeer(ctx, from, live)
	return may, true, err
}

// startsPeer is src/mail.ts startsPeer: the peer has a start command, the mail isn't to 'all', and a named recipient was
// last seen neither archived nor shut down. It returns those live recipients; none means no start.
func (s *Server) startsPeer(ctx context.Context, p config.Peer, to, named []string) ([]string, error) {
	if p.Start == "" || contains(to, "all") || len(named) == 0 {
		return nil, nil
	}
	var live []string
	for _, id := range named {
		lifecycle, _, err := s.db.PeerAgentLifecycle(ctx, id)
		if err != nil {
			return nil, err
		}
		if lifecycle != "archived" && lifecycle != "shut_down" {
			live = append(live, id)
		}
	}
	return live, nil
}

// mayStartPeer is src/mail.ts mayStartPeer (S-1473): the human, the chief of staff, or an ancestor of a named recipient;
// a standing agent's routine mail must not wake a paid machine.
func (s *Server) mayStartPeer(ctx context.Context, sender string, named []string) (bool, error) {
	if sender == humanBox || sender == s.chiefOfStaffID(ctx) {
		return true, nil
	}
	below, err := s.treeBelow(ctx, sender)
	if err != nil {
		return false, err
	}
	for _, id := range named {
		if below[id] {
			return true, nil
		}
	}
	return false, nil
}

// treeBelow is src/tree.ts descendantsOf with its peer children: the agents here and the remembered peer agents below
// id, at any depth. A queued recipient is a peer's agent, so the walk must cross machines (s.descendants stays local).
func (s *Server) treeBelow(ctx context.Context, id string) (map[string]bool, error) {
	seen := map[string]bool{}
	var walk func(id string) error
	walk = func(id string) error {
		kids, err := s.db.ChildrenOf(ctx, id)
		if err != nil {
			return err
		}
		peerKids, err := s.db.PeerChildrenOf(ctx, id)
		if err != nil {
			return err
		}
		for _, k := range append(kids, peerKids...) {
			if seen[k] {
				continue
			}
			seen[k] = true
			if err := walk(k); err != nil {
				return err
			}
		}
		return nil
	}
	return seen, walk(id)
}

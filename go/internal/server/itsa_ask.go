package server

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"stam/internal/db"
	"stam/internal/jsfmt"
)

// What happens when an ITSA waits on the human (src/itsa-human.ts onStatus and askHuman, src/withdraw.ts; S-2849): an
// agent's or a script's move into a status flagged `human` adds the human as a participant and mails them once, in the
// ITSA's thread, saying what is asked; a move out of one settles the ask without them. The human's own moves send
// nothing. Left out without an error: the web push that closes the phones' notifications of a withdrawn ask, the push into
// the human's open view, and the peers (this daemon has none to hold a copy of the ask).

// askMail is the ask mail of an ITSA that entered a human status.
type askMail struct {
	sender, body, subject, replyTo string
	// stam is whether no agent asks, so stam asks in a stand-in's name (the mail is stam's own).
	stam bool
}

func isAskAgent(id string) bool { return id != "" && id != humanBox }

// latestMail is itsa-human.ts latestMail: the latest comment or update `who` left in the ITSA's thread since the status
// change `skip` changes back, or none.
func (s *Server) latestMail(ctx context.Context, x jsfmt.Value, who string, skip int) (jsfmt.Value, bool, error) {
	tid := x.Text("thread_id")
	if tid == "" {
		return jsfmt.Value{}, false, nil
	}
	mails, err := s.db.ThreadMail(ctx, tid, "")
	if err != nil {
		return jsfmt.Value{}, false, err
	}
	since, err := s.db.ItsaStatusSince(ctx, x.Text("id"), x.Text("created_at"), skip)
	if err != nil {
		return jsfmt.Value{}, false, err
	}
	for i := len(mails) - 1; i >= 0; i-- {
		m := mails[i]
		if k := m.Text("kind"); m.Text("from_id") == who && (k == "comment" || k == "update") && m.Text("created_at") >= since {
			return m, true, nil
		}
	}
	return jsfmt.Value{}, false, nil
}

// askFor is the mail itsa-human.ts askHuman sends for the ITSA x, which entered its status by `actor`'s move; nil when the
// status does not wait on the human or no agent can send it. skip says how many status changes back the owner's comment is
// looked for (the change before the latest, once the move is written).
func (s *Server) askFor(ctx context.Context, x jsfmt.Value, actor string, skip int) (*askMail, error) {
	st, ok := s.statusOf(x.Text("status"))
	if !ok || !st.Human {
		return nil, nil
	}
	owner := x.Text("owner")
	sender := ""
	switch {
	case isAskAgent(actor):
		sender = actor
	case isAskAgent(owner):
		sender = owner
	default:
		id, found, err := s.db.FirstActiveAgentID(ctx)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, nil
		}
		sender = id
	}
	var labels []string
	for _, a := range s.actionsOf(x.Text("status")) {
		labels = append(labels, a.Label)
	}
	actions := "reply here"
	if len(labels) > 0 {
		actions = strings.Join(labels, ", ")
	}
	repeated, has, err := s.latestMail(ctx, x, sender, skip)
	if err != nil {
		return nil, err
	}
	stam := !isAskAgent(actor) && !isAskAgent(owner)
	asker := "stam"
	if !stam {
		asker = s.agentLabel(ctx, sender)
	}
	latest := "The owner left no comment."
	if has {
		latest = db.JSTrim(repeated.Text("body"))
	}
	if s.tpl == nil {
		return nil, Errorf(http.StatusNotImplemented, "the templates the ask is written from are not loaded in this server")
	}
	body, err := s.tpl.Render("itsa-human", map[string]string{
		"asker": asker, "key": x.Text("key"), "title": x.Text("title"), "status": strings.ReplaceAll(x.Text("status"), "_", " "),
		"latest": latest, "actions": actions,
	}, "")
	if err != nil {
		return nil, err
	}
	a := &askMail{sender: sender, body: body, subject: x.Text("key") + " " + x.Text("title"), stam: stam}
	if has {
		a.replyTo = repeated.Text("id")
	}
	return a, nil
}

// askRefusal answers 501 for the ask a move would send, before the move is written: the checks the ask's send makes of what
// this daemon does not carry. A move that sends none, or the human's, passes.
func (s *Server) askRefusal(ctx context.Context, cur jsfmt.Value, newStatus, newOwner, actor string) error {
	next := cur
	next.Set("status", jsfmt.StringValue(newStatus))
	if newOwner != "" {
		next.Set("owner", jsfmt.StringValue(newOwner))
	} else {
		next.Set("owner", jsfmt.NullValue())
	}
	// The change before the latest, once the move is written, is the latest one before it.
	a, err := s.askFor(ctx, next, actor, 0)
	if err != nil || a == nil {
		return err
	}
	if !strings.HasPrefix(a.sender, "system:") {
		if _, err := s.person(ctx, jsfmt.StringValue(a.sender), true); err != nil {
			return err
		}
	}
	return s.sendNotPorted(ctx, a.sender, a.body, "ask", "", []string{humanBox}, a.stam)
}

// onStatus is itsa-human.ts onStatus, run after a change of status is written: an agent's move out of a human status settles
// the human's ask, and a move into one mails the ask. Errors are logged, never returned into the move that caused them.
func (s *Server) onStatus(ctx context.Context, x jsfmt.Value, actor, from string) {
	status := x.Text("status")
	if actor == humanBox || from == status {
		return
	}
	if fs, ok := s.statusOf(from); ok && fs.Human {
		if id, found, err := s.db.LastAsk(ctx, x.Text("id")); err != nil {
			slog.Error("ITSA human: last ask", "itsa", x.Text("key"), "err", err)
		} else if found {
			to, _ := s.statusOf(status)
			note := "@" + s.agentLabel(ctx, actor) + " moved " + x.Text("key") + " to " + status
			if err := s.withdrawFromHuman(ctx, []string{id}, actor, note, to.Human); err != nil {
				slog.Error("withdraw: "+note, "err", err)
			}
		}
	}
	if err := s.askHuman(ctx, x, actor); err != nil {
		slog.Error("ITSA human: mail for "+x.Text("key"), "err", err)
	}
}

// askHuman is itsa-human.ts askHuman: mails the human about an ITSA that just entered a human status. The sender is the agent
// that made the change, else the owner, else the agent standing in for stam.
func (s *Server) askHuman(ctx context.Context, x jsfmt.Value, actor string) error {
	a, err := s.askFor(ctx, x, actor, 1)
	if err != nil || a == nil {
		return err
	}
	if err := s.db.EnsureItsaParticipant(ctx, x.Text("id"), humanBox); err != nil {
		return err
	}
	in := jsfmt.Value{Kind: jsfmt.Object}
	in.Set("by", jsfmt.StringValue(a.sender))
	in.Set("body", jsfmt.StringValue(a.body))
	in.Set("subject", jsfmt.StringValue(a.subject))
	in.Set("from_stam", jsfmt.Value{Kind: jsfmt.Bool, Bool: a.stam})
	if a.replyTo != "" {
		in.Set("reply_to", jsfmt.StringValue(a.replyTo))
	}
	// The ask is stamped after the move's event, as in TS, where its send takes longer than a millisecond: a thread sorts by
	// time, and mail before event on a tie.
	time.Sleep(time.Millisecond)
	_, err = s.post(ctx, x.Text("id"), in, true)
	return err
}

// withdrawFromHuman is src/withdraw.ts withdrawFromHuman: the human's copy of each mail is read and marked withdrawn by
// `by`, and the thread is archived (a later reply brings it back) unless keepThread, where a new ask joins it at once.
func (s *Server) withdrawFromHuman(ctx context.Context, ids []string, by, note string, keepThread bool) error {
	if by == humanBox {
		return Errorf(http.StatusBadRequest, "the human's own answer isn't withdrawn")
	}
	var uniq []string
	for _, id := range ids {
		if !contains(uniq, id) {
			uniq = append(uniq, id)
		}
	}
	if len(uniq) == 0 {
		return nil
	}
	_, fresh, at, err := s.db.WithdrawFromHuman(ctx, uniq, by, sliceUnits(note, 500))
	if err != nil {
		return err
	}
	for _, w := range fresh {
		ev := jsfmt.Value{Kind: jsfmt.Object}
		ev.Set("id", jsfmt.StringValue(w.ID))
		ev.Set("by", jsfmt.StringValue(humanBox))
		ev.Set("at", jsfmt.StringValue(at))
		_ = s.hub.Emit("mail.read", ev)
	}
	if keepThread {
		return nil
	}
	byThread := map[string][]string{}
	var order []string
	for _, w := range fresh {
		if _, seen := byThread[w.ThreadID]; !seen {
			order = append(order, w.ThreadID)
		}
		byThread[w.ThreadID] = append(byThread[w.ThreadID], append([]string{w.ID}, w.IDs...)...)
	}
	for _, t := range order {
		var all []string
		for _, id := range byThread[t] {
			if !contains(all, id) {
				all = append(all, id)
			}
		}
		if err := s.db.ArchiveThread(ctx, humanBox, t, all); err != nil {
			return err
		}
	}
	return nil
}

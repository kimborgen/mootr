package server

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// Mail between machines (src/mail.ts, S-232 and after): a recipient on a peer, the mail a reply names when only a peer
// keeps it, and GET /api/mail/:id, which a peer asks for that mail.

// found is what resolveRecipient found.
type found int

const (
	foundAgent found = iota
	foundAbsent
	foundUnreachable
)

// recipient is an agent a mail goes to: Peer is nil for one here.
type recipient struct {
	Peer  *config.Peer
	Agent peers.Agent
}

// resolveRecipient is src/mail.ts resolveRecipient. Without a peer round trip, in this order: an exact local id, an exact
// id remembered from a peer (one that isn't archived, on a peer still configured), then a live local name. Only then the
// peers are asked. An id a peer's agent also has is refused rather than taken for the local one (S-577). skipPeers is for a
// forwarded send, which is already routed.
func (s *Server) resolveRecipient(ctx context.Context, ref string, skipPeers bool) (recipient, found, error) {
	local, err := s.db.GetAgent(ctx, ref)
	haveLocal := err == nil
	if err != nil && !errors.Is(err, db.ErrNotFound) {
		return recipient{}, foundAbsent, err
	}
	if haveLocal && local.ID == ref {
		if err := peers.RefuseAmbiguousID(ctx, s.db, ref, local.Name, local.Machine); err != nil {
			return recipient{}, foundAbsent, ambiguous(err)
		}
		return recipient{Agent: localAgent(local)}, foundAgent, nil
	}
	remembered, known, err := s.db.FindPeerAgent(ctx, ref)
	if err != nil {
		return recipient{}, foundAbsent, err
	}
	if known && remembered.ID == ref && !skipPeers {
		lifecycle, _, err := s.db.PeerAgentLifecycle(ctx, remembered.ID)
		if err != nil {
			return recipient{}, foundAbsent, err
		}
		if lifecycle != "archived" {
			if p, ok := s.peers.ByName(remembered.Machine); ok {
				if lifecycle == "" {
					lifecycle = "active"
				}
				return recipient{Peer: &p, Agent: peers.Agent{ID: remembered.ID, Name: remembered.Name, Machine: remembered.Machine, Lifecycle: lifecycle}}, foundAgent, nil
			}
		}
	}
	// A remembered exact id, even an archived one, is not a name: a local agent of that name doesn't stand in for it.
	var hits []peers.Hit
	if haveLocal && !(known && remembered.ID == ref) {
		a := localAgent(local)
		if a.Live() {
			return recipient{Agent: a}, foundAgent, nil
		}
		hits = append(hits, peers.Hit{Agent: a})
	}
	unreachable := false
	if !skipPeers {
		theirs, bad := s.peers.Hits(ctx, s.db, ref)
		hits, unreachable = append(hits, theirs...), bad
	}
	hit, err := peers.Pick(ref, hits)
	switch {
	case err != nil:
		return recipient{}, foundAbsent, ambiguous(err)
	case hit != nil:
		return recipient{Peer: hit.Peer, Agent: hit.Agent}, foundAgent, nil
	case unreachable:
		return recipient{}, foundUnreachable, nil
	}
	return recipient{}, foundAbsent, nil
}

func localAgent(a db.Agent) peers.Agent {
	return peers.Agent{ID: a.ID, Name: a.Name, Machine: a.Machine, Lifecycle: string(a.Lifecycle)}
}

// replyParent is src/mail.ts parentOf: the mail a reply names, this daemon's copy or one a peer keeps (its recipient's
// machine, S-359). Either is found only if the sending agent (via) may see it; with no via (the human, a local script)
// any is. unreachable says a peer couldn't be asked; hidden that a daemon keeps it but the agent isn't in its thread.
func (s *Server) replyParent(ctx context.Context, id string, via *peers.Via) (parent jsfmt.Value, ok, unreachable, hidden bool, err error) {
	x, here, err := s.db.GetMail(ctx, id)
	if err != nil {
		return jsfmt.Value{}, false, false, false, err
	}
	if here {
		if via != nil && !via.Boss {
			may, err := s.mayReadMail(ctx, via.Agent, x)
			if err != nil {
				return jsfmt.Value{}, false, false, false, err
			}
			if !may {
				return jsfmt.Value{}, false, false, true, nil
			}
		}
		return x, true, false, false, nil
	}
	if !mailIDRe.MatchString(id) {
		return jsfmt.Value{}, false, false, false, nil
	}
	rows, bad := s.peers.FanOutReport(ctx, "/api/mail/"+id, via)
	if len(rows) > 0 {
		return rows[0], true, bad, false, nil
	}
	if via == nil {
		return jsfmt.Value{}, false, bad, false, nil
	}
	held := s.peers.FanOut(ctx, "/api/mail/"+id+"/thread", nil)
	return jsfmt.Value{}, false, bad, len(held) > 0, nil
}

// mailIDRe is a mail id (db.newMailId: `m` and hex), the only ids GET /api/mail/:id answers.
var mailIDRe = regexp.MustCompile(`^m[0-9a-f]+$`)

// threadIDRe is a thread id a peer may forward: a mail id, which every thread and ITSA thread now has (db.NewMailID), or
// an older id of letters, digits, `_` and `-`. Never a path: no `/`, `.` or `\`.
var threadIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// checkForwardedIDs refuses a forwarded mail whose id or thread isn't one: the id names this mail's attachments folder
// (S-4100 review), so it is checked before anything is written.
func checkForwardedIDs(in *sendIn) error {
	if !in.forwarded {
		return nil
	}
	if in.mailID != "" && !mailIDRe.MatchString(in.mailID) {
		return refused("a forwarded mail_id is a mail id (m and hex digits), not %s", jsfmt.Quote(in.mailID))
	}
	if in.fwdThreadID != "" && !threadIDRe.MatchString(in.fwdThreadID) {
		return refused("a forwarded thread_id is a thread's id, not %s", jsfmt.Quote(in.fwdThreadID))
	}
	return nil
}

// mailRoute is GET /api/mail/:id (src/daemon.ts): the fields a reply to the mail needs, for a daemon whose copy is on a peer
// (S-359), as a list of none or one. A viewer sees it only if it may read the mail. A mail this daemon doesn't keep is
// asked of the peers, unless a peer asks.
func (s *Server) mailRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	id := r.PathValue("id")
	if !mailIDRe.MatchString(id) {
		return nil, Errorf(http.StatusNotFound, "no route GET %s", r.URL.Path)
	}
	x, here, err := s.db.GetMail(ctx, id)
	if err != nil {
		return nil, err
	}
	if !here {
		if c.Local {
			return []jsfmt.Value{}, nil
		}
		return s.peers.FanOut(ctx, "/api/mail/"+id, s.viaOf(ctx, c)), nil
	}
	if c.Caller.IsAgent() && !c.Boss {
		box := c.Caller.Agent
		if box == "" {
			return []jsfmt.Value{}, nil
		}
		may, err := s.mayReadMail(ctx, box, x)
		if err != nil {
			return nil, err
		}
		if !may {
			return []jsfmt.Value{}, nil
		}
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range []string{"id", "thread_id", "subject", "from_id", "itsa_id", "permission_id", "kind"} {
		if v, ok := x.Get(k); ok {
			out.Set(k, v)
		} else {
			out.Set(k, jsfmt.NullValue())
		}
	}
	return []jsfmt.Value{out}, nil
}

// attachmentsB64 is the sender's attachments as a peer gets them: each a name and its content in base64 (src/mail.ts).
func attachmentsB64(list []jsfmt.Value) ([]jsfmt.Value, error) {
	out := make([]jsfmt.Value, 0, len(list))
	for _, a := range list {
		name := a.Text("name")
		var data []byte
		switch {
		case a.Text("content_b64") != "":
			out = append(out, attachmentValue(nameOr(name, "attachment.txt"), a.Text("content_b64")))
			continue
		case a.Text("path") != "":
			b, err := os.ReadFile(a.Text("path"))
			if err != nil {
				return nil, err
			}
			data, name = b, nameOr(name, filepath.Base(a.Text("path")))
		default:
			data, name = []byte(a.Text("content")), nameOr(name, "attachment.txt")
		}
		out = append(out, attachmentValue(name, base64.StdEncoding.EncodeToString(data)))
	}
	return out, nil
}

func nameOr(name, fallback string) string {
	if name != "" {
		return name
	}
	return fallback
}

func attachmentValue(name, b64 string) jsfmt.Value {
	v := jsfmt.Value{Kind: jsfmt.Object}
	v.Set("name", jsfmt.StringValue(name))
	v.Set("content_b64", jsfmt.StringValue(b64))
	return v
}

// remoteSends is the peers a mail goes to, in the order first named, and each one's recipients. fromAll holds the
// recipients a limited sender's `all` expanded to (peer and id), so that peer still counts as a broadcast.
type remoteSends struct {
	peers   []config.Peer
	to      map[string][]string
	fromAll map[string]bool
}

// addFromAll adds a recipient that `all` expanded to.
func (r *remoteSends) addFromAll(p config.Peer, id string) {
	if r.fromAll == nil {
		r.fromAll = map[string]bool{}
	}
	r.fromAll[p.Name+"\x00"+id] = true
	r.add(p, id)
}

func (r *remoteSends) add(p config.Peer, id string) {
	if r.to == nil {
		r.to = map[string][]string{}
	}
	if _, ok := r.to[p.Name]; !ok {
		r.peers = append(r.peers, p)
	}
	r.to[p.Name] = append(r.to[p.Name], id)
}

// dropAll takes `all` off every peer's recipients, and a peer left with none.
func (r *remoteSends) dropAll() {
	kept := r.peers[:0]
	for _, p := range r.peers {
		var to []string
		for _, x := range r.to[p.Name] {
			if x != "all" {
				to = append(to, x)
			}
		}
		if len(to) == 0 {
			delete(r.to, p.Name)
			continue
		}
		r.to[p.Name] = to
		kept = append(kept, p)
	}
	r.peers = kept
}

// ids is every peer recipient, `all` included.
func (r *remoteSends) ids() []string {
	var out []string
	for _, p := range r.peers {
		out = append(out, r.to[p.Name]...)
	}
	return out
}

// forwardPayload is the mail as a peer stores it (src/mail.ts sendMail): the sender's resolved id and name, its own
// recipients there (and which of them the sender didn't name), the id and thread given here, and the attachments in base64.
func (s *Server) forwardPayload(in *sendIn, from, fromName, subject, body, replyTo, threadID, id string, autoThreaded bool, to []string, inferred map[string]bool, atts []jsfmt.Value) jsfmt.Value {
	v := jsfmt.Value{Kind: jsfmt.Object}
	set := func(k string, x jsfmt.Value) { v.Set(k, x) }
	set("from", jsfmt.StringValue(from))
	set("to", jsfmt.ArrayValue(stringValues(to)))
	var inf []string
	for _, x := range to {
		if inferred[x] {
			inf = append(inf, x)
		}
	}
	set("inferred", jsfmt.ArrayValue(stringValues(inf)))
	set("subject", jsfmt.StringValue(subject))
	set("body", jsfmt.StringValue(body))
	if replyTo != "" {
		set("reply_to", jsfmt.StringValue(replyTo))
	}
	set("attachments", jsfmt.ArrayValue(atts))
	set("thread_id", jsfmt.StringValue(threadID))
	set("mail_id", jsfmt.StringValue(id))
	if in.aboutItsa != "" {
		set("about_itsa", jsfmt.StringValue(in.aboutItsa))
	}
	if in.permissionID != "" {
		set("permission_id", jsfmt.StringValue(in.permissionID))
	}
	if kind := in.mailKind(); kind != "" {
		set("kind", jsfmt.StringValue(kind))
	}
	if in.fromStam {
		set("from_stam", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	}
	if autoThreaded {
		set("auto_threaded", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	}
	// An ITSA's post: the peer stores it under the ITSA with its kind and health, and interrupts only those it names.
	if in.itsa != nil {
		set("itsa_id", jsfmt.StringValue(in.itsa.id))
		if in.itsa.health != "" {
			set("health", jsfmt.StringValue(in.itsa.health))
		}
		// Only this peer's recipients: the others are no business of the peer's.
		var interrupt []string
		for _, x := range in.itsa.interrupt {
			if contains(to, x) {
				interrupt = append(interrupt, x)
			}
		}
		set("interrupt", jsfmt.ArrayValue(stringValues(interrupt)))
	}
	// A reach-checked post: the peer checks its own final recipients against it.
	if in.hasOnlyTo {
		set("only_to", jsfmt.ArrayValue(stringValues(in.onlyTo)))
	}
	fwd := jsfmt.Value{Kind: jsfmt.Object}
	fwd.Set("from_name", jsfmt.StringValue(fromName))
	set("forwarded", fwd)
	return v
}

// goneName is the name a refusal gives an agent nobody has any more: the one a peer last told us, else the last name its
// mail was sent under, else the reference itself.
func (s *Server) goneName(ctx context.Context, ref string) (string, error) {
	if p, ok, err := s.db.FindPeerAgent(ctx, ref); err != nil {
		return "", err
	} else if ok {
		return p.Name, nil
	}
	name, err := s.db.LastSenderName(ctx, ref)
	if err != nil || name != "" {
		return name, err
	}
	return ref, nil
}

// idLocks serializes work on one id: a forwarded mail's arrivals hold it from the check whether the mail is here through
// its folder and its store, so a second arrival of the id (the split of a broadcast and a queued part, an outbox retry)
// finds the first one's mail and merges, rather than racing it to the folder (S-4100 review).
type idLocks struct {
	mu sync.Mutex
	m  map[string]*idLock
}

type idLock struct {
	mu sync.Mutex
	// n is the holder and the waiters; the entry goes when it drops to zero.
	n int
}

// lock takes id's lock; the func it returns releases it.
func (l *idLocks) lock(id string) func() {
	l.mu.Lock()
	if l.m == nil {
		l.m = map[string]*idLock{}
	}
	e := l.m[id]
	if e == nil {
		e = &idLock{}
		l.m[id] = e
	}
	e.n++
	l.mu.Unlock()
	e.mu.Lock()
	return func() {
		e.mu.Unlock()
		l.mu.Lock()
		if e.n--; e.n == 0 {
			delete(l.m, id)
		}
		l.mu.Unlock()
	}
}

// holders is how many hold or wait for id's lock (a test's view).
func (l *idLocks) holders(id string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e := l.m[id]; e != nil {
		return e.n
	}
	return 0
}

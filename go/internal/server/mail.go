package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	neturl "net/url"
	"slices"
	"sort"
	"strconv"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// The mail reads of src/daemon.ts (S-2824): GET /api/agents/:id/inbox, POST /api/agents/:id/read and GET
// /api/threads/:id. A thread read adds the peers' part (S-3734). Not ported: the fan-out of the human's read to peers.

// mailRoutes registers the mail routes, in this file so the routes of other modules don't collide with them.
func (s *Server) mailRoutes() {
	s.handle("GET /api/agents/{id}/inbox", s.inbox)
	s.handle("POST /api/agents/{id}/read", s.readMail)
	s.handle("GET /api/threads/{id}", s.thread)
	s.handle("GET /api/mail/{id}", s.mailRoute)
	s.sendRoutes()
	s.threadRoutes()
}

// mailboxID is src/daemon.ts mailboxId: the human, or the id of the agent named; 404 for no such agent.
func (s *Server) mailboxID(ctx context.Context, ref string) (string, error) {
	if ref == humanBox {
		return humanBox, nil
	}
	a, err := s.db.GetAgent(ctx, ref)
	if errors.Is(err, db.ErrNotFound) {
		return "", Errorf(http.StatusNotFound, "no agent %s", ref)
	}
	return a.ID, err
}

// boxRef is src/daemon.ts boxRef: like mailboxID for a read about an agent this daemon may not have.
func (s *Server) boxRef(ctx context.Context, ref string) string {
	if ref == humanBox {
		return humanBox
	}
	if a, err := s.db.GetAgent(ctx, ref); err == nil {
		return a.ID
	}
	return ref
}

// number is JS Number(raw) for a query value, or fallback when it is absent.
func number(raw string, has bool, fallback int) int {
	if !has {
		return fallback
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return fallback
	}
	return int(f)
}

func (s *Server) inbox(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	if err := s.mayActAs(ctx, c.Caller, r.PathValue("id"), false); err != nil {
		return nil, err
	}
	box, err := s.mailboxID(ctx, r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	q := r.URL.Query()
	limit := number(q.Get("limit"), q.Has("limit"), 20)
	rows, err := s.db.Inbox(ctx, box, q.Get("unread") == "1", limit)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []jsfmt.Value{}
	}
	// The human's mail lives on whichever machine it was sent from: the peers' join, newest first, cut to the limit. A
	// peer's own request is its own box only.
	if box != humanBox || c.Local {
		return rows, nil
	}
	path := r.URL.EscapedPath()
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.RawQuery
	}
	rows = append(rows, s.peers.FanOut(ctx, path, s.viaOf(ctx, c))...)
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Text("created_at") > rows[j].Text("created_at") })
	if limit >= 0 && len(rows) > limit {
		rows = rows[:limit]
	}
	return rows, nil
}

// jsonBody reads a request body as a JSON object; an empty body is {}.
func jsonBody(r *http.Request) (jsfmt.Value, error) {
	b, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		return jsfmt.Value{}, err
	}
	if len(b) == 0 {
		return jsfmt.Value{Kind: jsfmt.Object}, nil
	}
	v, err := jsfmt.Parse(b)
	if err != nil || v.Kind != jsfmt.Object {
		return jsfmt.Value{}, Errorf(http.StatusBadRequest, "the body must be a JSON object")
	}
	return v, nil
}

func (s *Server) readMail(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	if err := s.mayActAs(ctx, c.Caller, r.PathValue("id"), false); err != nil {
		return nil, err
	}
	box, err := s.mailboxID(ctx, r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	// A test may hold this mailbox's read until it releases it (POST /api/test/read-hold); the read then finishes even
	// if its client is gone.
	if s.readHeld(box) {
		ctx = context.WithoutCancel(ctx)
	}
	// An agent's read carries a batch id (its MCP client, S-357): the mail is handed out in it and stays owed until a
	// batch holding it is acknowledged; the batch the client last got a reply to is acknowledged here.
	batch := ""
	if b := body.Text("batch"); box != humanBox && b != "" {
		batch = b
		if ack := body.Text("ack"); ack != "" {
			if err := s.db.AckDelivered(ctx, box, ack); err != nil {
				return nil, err
			}
		}
	}
	var ids []string
	if given, ok := body.Get("ids"); ok && given.Kind == jsfmt.Array && len(given.Items) > 0 {
		for _, it := range given.Items {
			ids = append(ids, anyString(it))
		}
	} else if box == humanBox {
		unread, err := s.db.Inbox(ctx, box, true, 10)
		if err != nil {
			return nil, err
		}
		for _, m := range unread {
			ids = append(ids, m.Text("id"))
		}
	} else if ids, err = s.db.DefaultRead(ctx, box, 10); err != nil {
		return nil, err
	}
	mails, fresh, at, err := s.db.ReadMail(ctx, box, ids, batch)
	if err != nil {
		return nil, err
	}
	// The views are told what was read, as db.readMail's mail.read events do.
	for _, id := range fresh {
		ev := jsfmt.Value{Kind: jsfmt.Object}
		ev.Set("id", jsfmt.StringValue(id))
		ev.Set("by", jsfmt.StringValue(box))
		ev.Set("at", jsfmt.StringValue(at))
		_ = s.hub.Emit("mail.read", ev)
	}
	if box == humanBox && len(fresh) > 0 {
		s.nudgeAutoArchive()
	}
	if mails == nil {
		mails = []jsfmt.Value{}
	}
	return mails, nil
}

// anyString is JS String(v) for a JSON value.
func anyString(v jsfmt.Value) string {
	if v.Kind == jsfmt.String {
		return v.Str
	}
	return jsfmt.Compact(v)
}

// viewerBox is src/daemon.ts viewerBox: the mailbox a read is for. The human, the CLI and peers name it with ?box (or
// none); an agent reads its own box, or one it may act as. The OpenCode server must name one. A box this daemon doesn't
// have is refused unless the caller is that agent or a boss: there is no peer to ask.
func (s *Server) viewerBox(ctx context.Context, c auth.Resolved, raw string) (string, error) {
	if !c.Caller.IsAgent() {
		return raw, nil
	}
	if raw == "" {
		if c.Caller.Kind == auth.OpenCode {
			return "", Errorf(http.StatusForbidden, "the OpenCode server must name the box it reads")
		}
		return c.Caller.Agent, nil
	}
	id := s.boxRef(ctx, raw)
	if _, err := s.db.GetAgent(ctx, id); err != nil && id != humanBox {
		if !errors.Is(err, db.ErrNotFound) {
			return "", err
		}
		return id, s.mayActAsRemote(ctx, c, id)
	}
	return id, s.mayActAs(ctx, c.Caller, id, false)
}

// mayActAsRemote is src/daemon.ts mayActAsRemote: may the caller act for a box on another machine (S-263)? The caller
// itself, a boss (here, or forwarded by a peer as its boss), the chief of staff and the assistant may; otherwise only a
// parent of the box, which the box's own daemon confirms by answering a probe of its inbox as the caller (via). Anything
// else, a peer answering for another id, or a peer that doesn't answer is a 403, before anything is read here. The
// OpenCode server names only its own agents.
func (s *Server) mayActAsRemote(ctx context.Context, c auth.Resolved, id string) error {
	me := c.Caller.Agent
	who := "the OpenCode server"
	if c.Caller.Kind == auth.Agent {
		who = s.agentLabel(ctx, me)
	}
	refuse := Errorf(http.StatusForbidden, "%s can't act as %s", who, id)
	if c.Caller.Kind != auth.Agent {
		return refuse
	}
	if id == me || c.Caller.Boss || s.chiefOfStaffID(ctx) == me || s.isAssistant(ctx, me) {
		return nil
	}
	hit, found, err := s.peers.Locate(ctx, s.db, id)
	if err != nil || found != peers.Found || hit.Peer == nil || hit.Agent.ID != id {
		return refuse
	}
	r, err := s.peers.Call(ctx, *hit.Peer, http.MethodGet, "/api/agents/"+neturl.PathEscape(id)+"/inbox?limit=0", nil, peers.DefaultTimeout, false, s.viaOf(ctx, c))
	if err != nil || r.Status != http.StatusOK {
		return refuse
	}
	return nil
}

func (s *Server) thread(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	box, err := s.viewerBox(ctx, c, r.URL.Query().Get("box"))
	if err != nil {
		return nil, err
	}
	// The id may be any mail in the thread, such as one cited in a brief (S-448); a peer is handed the thread id itself.
	tid := r.PathValue("id")
	if !c.Local {
		if tid, err = s.threadOfMail(ctx, tid, box, s.viaBox(ctx, c, box)); err != nil {
			return nil, err
		}
	}
	// A viewer reads only its own part of a thread, except one it may read whole.
	scope := ""
	if box != "" {
		whole, err := s.mayReadWholeThread(ctx, c, s.boxRef(ctx, box), tid)
		if err != nil {
			return nil, err
		}
		if !whole {
			scope = s.boxRef(ctx, box)
		}
	}
	rows, err := s.threadMail(ctx, tid, scope)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []jsfmt.Value{}
	}
	if c.Local {
		return rows, nil
	}
	// A whole thread is asked of the peers without the box, as the ITSA thread reads do.
	path := "/api/threads/" + tid
	if scope != "" {
		path = withBox(path, box)
	}
	all := foldMails(append(rows, s.peers.FanOut(ctx, path, s.viaBox(ctx, c, box))...))
	if all == nil {
		all = []jsfmt.Value{}
	}
	byCreated(all)
	return all, nil
}

// threadOfMail is src/daemon.ts threadOfMail: the thread a mail is in, asked of the peers when this daemon doesn't hold it,
// else the id itself.
func (s *Server) threadOfMail(ctx context.Context, id, box string, via *peers.Via) (string, error) {
	if t, err := s.db.MailThreadOf(ctx, id); err != nil || t != "" {
		return t, err
	}
	if rows := s.peers.FanOut(ctx, withBox("/api/mail/"+id+"/thread", box), via); len(rows) > 0 {
		if t := rows[0].Text("thread_id"); t != "" {
			return t, nil
		}
	}
	return id, nil
}

// mayReadWholeThread is src/mail-visibility.ts mayReadWholeThread: a thread the agent was granted (by the box itself), a
// thread with the human that one of the box's ancestors took part in. An ITSA's thread is read whole only by those the
// ITSA belongs to.
func (s *Server) mayReadWholeThread(ctx context.Context, c auth.Resolved, box, tid string) (bool, error) {
	reader := box
	if c.Caller.Kind == auth.Agent && c.Caller.Agent != "" {
		reader = s.boxRef(ctx, c.Caller.Agent)
	}
	return s.mayReadWholeThreadAs(ctx, reader, box, tid)
}

// mayReadWholeThreadAs is mayReadWholeThread for the agent `reader`, which may be reading a box it acts for.
func (s *Server) mayReadWholeThreadAs(ctx context.Context, reader, box, tid string) (bool, error) {
	if reader == box {
		if ok, err := s.db.ThreadGranted(ctx, tid, box); err != nil || ok {
			return ok, err
		}
	}
	itsas, err := s.db.ThreadItsaIDs(ctx, tid)
	if err != nil {
		return false, err
	}
	// An ITSA's thread is read whole by those the ITSA belongs to, as `reader`, the agent asking (S-480).
	if len(itsas) > 0 {
		for _, id := range itsas {
			if ok, err := s.mayReadItsaThreads(ctx, reader, id); err == nil && ok {
				return true, nil
			}
		}
		return false, nil
	}
	return s.sharedThread(ctx, box, tid)
}

// sharedThread is whether tid is a thread with the human that one of the box's ancestors took part in, and no ITSA's
// (src/mail-search.ts sharedThreads).
func (s *Server) sharedThread(ctx context.Context, box, tid string) (bool, error) {
	a, err := s.db.GetAgent(ctx, box)
	if errors.Is(err, db.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	human, err := s.db.ThreadIDsOf(ctx, humanBox)
	if err != nil {
		return false, err
	}
	if !slices.Contains(human, tid) {
		return false, nil
	}
	extra, err := s.db.ExtraParents(ctx)
	if err != nil {
		return false, err
	}
	anc, _ := s.ancestors(ctx, a, extra)
	for p := range anc {
		ts, err := s.db.ThreadIDsOf(ctx, p)
		if err != nil {
			return false, err
		}
		if slices.Contains(ts, tid) {
			return true, nil
		}
	}
	return false, nil
}

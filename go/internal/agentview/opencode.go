package agentview

import (
	"context"
	"encoding/base64"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// OpenCode is src/adapters/opencode-view.ts: OpenCode's part of the view. Stored messages come from stam's shared OpenCode
// server (GET /api/session/:sid/message), live deltas from its event stream (the lifecycle tells Event of each), and
// prompts, interrupts and permission replies go through its API. Every one of them shows in the agent's TUI too.
//
// Session binding. The agent's session is read from its row at each call, never from the row the caller read: a page, a
// status or a follower's re-read acts on the session the row names now (history stays readable for a stopped agent), and a
// send (a prompt, a permission reply, an interrupt) acts only on the session the agent runs now, bound with the lifecycle's
// generation (Send) and run with that session's slot held, as an answer to an ask is. A send that finds the agent moved on,
// or in a launch, is refused (409): it is not delivered into a session the agent no longer runs, and not into one a launch
// is replacing. The call is outside every mutex but holds the slot, so a stop or a relaunch's release orders after it.
//
// Followers. One per open live window, keyed by the agent, not by the session: an event is told of the session it names, the
// agent whose row has that session now is found, and its followers get it. A session the agent has left finds no agent, so
// a follower opened on one stops getting its events; the first event of the session the agent moved to finds the follower
// still on the old one, empties its window and reads the new session's messages again (Resync). A follower is removed
// when its window's last client leaves (Service.leave calls the stop Follow returned).
type OpenCode struct {
	DB *db.DB
	// Call is one call to the shared server (opencode.Server.Call): an answer's data, or an error that is the method, the
	// path and the status only.
	Call func(ctx context.Context, method, path string, body jsjson.Value) (jsjson.Value, error)
	// Interrupt is lifecycle's Interrupt: one interrupt of the agent's session, true once the server no longer lists it
	// active.
	Interrupt func(ctx context.Context, a db.Agent) (bool, error)
	// Send is lifecycle's ViewSend: do runs in the session the agent runs now, with that session's slot held (so a stop or a
	// relaunch orders after it), and not at all, sent false, when the agent runs none, is in a launch or has moved on. pid is
	// the permission a reply answers, "" for a prompt.
	Send func(ctx context.Context, id, pid string, do func(sid string) error) (sent bool, err error)
	// Has says whether this daemon runs OpenCode agents; nil: yes.
	Has func() bool

	mu        sync.Mutex
	followers map[string]map[*follower]struct{} // by agent id
}

// follower is one live window's feed.
type follower struct {
	live Sink
	// sid is the session the window shows, guarded by OpenCode.mu.
	sid string
}

// OpenCodeCaps are OpenCode's view capabilities.
var OpenCodeCaps = Caps{CanStream: true, CanSend: true, CanInterrupt: true, CanApprove: true}

func (o *OpenCode) Caps() Caps { return OpenCodeCaps }

func (o *OpenCode) Unavailable(a db.Agent) string {
	if o.Has != nil && !o.Has() {
		return "OpenCode isn't running on this daemon"
	}
	if a.SessionID == nil || *a.SessionID == "" {
		return a.Name + " has no OpenCode session yet"
	}
	return ""
}

// sessionOf is the session the agent's row names now.
func (o *OpenCode) sessionOf(ctx context.Context, a db.Agent) (string, error) {
	cur, err := o.DB.GetAgent(ctx, a.ID)
	if err != nil {
		return "", err
	}
	if cur.SessionID == nil || *cur.SessionID == "" {
		return "", refuse(409, cur.Name+" has no OpenCode session yet")
	}
	return *cur.SessionID, nil
}

// olderThan is OpenCode's message cursor: base64url JSON naming the message to continue from (seen on v2.0.26); `next` in
// descending order means older than it.
func olderThan(id string) string {
	var b strings.Builder
	b.WriteString(`{"id":`)
	jsjson.Quote(&b, id)
	b.WriteString(`,"order":"desc","direction":"next"}`)
	return base64.RawURLEncoding.EncodeToString([]byte(b.String()))
}

// Page is the newest limit messages before `before`, oldest first. One more than asked is read, to know whether older
// ones exist.
func (o *OpenCode) Page(ctx context.Context, a db.Agent, limit int, before string) (Page, error) {
	sid, err := o.sessionOf(ctx, a)
	if err != nil {
		return Page{}, err
	}
	q := "order=desc"
	if before != "" {
		q = "cursor=" + olderThan(before)
	}
	rows, err := o.Call(ctx, "GET", "/api/session/"+url.PathEscape(sid)+"/message?"+q+"&limit="+strconv.Itoa(limit+1), nil)
	if err != nil {
		return Page{}, err
	}
	list, _ := rows.([]any)
	more := len(list) > limit
	take := list
	if more {
		take = list[:limit]
	}
	out := Page{Messages: []*Message{}}
	for i := len(take) - 1; i >= 0; i-- {
		if m := FromOpenCode(take[i]); m != nil {
			out.Messages = append(out.Messages, m)
		}
	}
	if more {
		if id, ok := fieldOf(objOf(list[limit-1]), "id").(string); ok {
			out.Older = &id
		}
	}
	return out, nil
}

// Status is whether the session's turn is going, and its permissions waiting for an answer.
func (o *OpenCode) Status(ctx context.Context, a db.Agent) (bool, []*Permission, error) {
	sid, err := o.sessionOf(ctx, a)
	if err != nil {
		return false, nil, err
	}
	active, err := o.Call(ctx, "GET", "/api/session/active", nil)
	if err != nil {
		return false, nil, err
	}
	perms, err := o.Call(ctx, "GET", "/api/session/"+url.PathEscape(sid)+"/permission", nil)
	if err != nil {
		return false, nil, err
	}
	_, running := field(objOf(active), sid)
	out := []*Permission{}
	if list, ok := perms.([]any); ok {
		for _, p := range list {
			out = append(out, PermissionOf(p))
		}
	}
	return running, out, nil
}

// Follow opens a follower for the window, on the session the agent's row names now.
func (o *OpenCode) Follow(a db.Agent, live Sink) func() {
	sid := ""
	if cur, err := o.DB.GetAgent(context.Background(), a.ID); err == nil && cur.SessionID != nil {
		sid = *cur.SessionID
	}
	f := &follower{live: live, sid: sid}
	o.mu.Lock()
	if o.followers == nil {
		o.followers = map[string]map[*follower]struct{}{}
	}
	if o.followers[a.ID] == nil {
		o.followers[a.ID] = map[*follower]struct{}{}
	}
	o.followers[a.ID][f] = struct{}{}
	o.mu.Unlock()
	return func() {
		o.mu.Lock()
		defer o.mu.Unlock()
		delete(o.followers[a.ID], f)
		if len(o.followers[a.ID]) == 0 {
			delete(o.followers, a.ID)
		}
	}
}

// Followers is how many followers are open, for tests.
func (o *OpenCode) Followers() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	n := 0
	for _, fs := range o.followers {
		n += len(fs)
	}
	return n
}

// Event is told of each event of the server's stream, after the lifecycle handled it. It runs on the stream's goroutine and
// must not block: it takes no lifecycle or owner lock, makes no call to the server and writes to no client (a window's
// changes go out from its own timer). With no follower open it is a map read.
func (o *OpenCode) Event(typ string, d *jsjson.Object) {
	sid := strOr(d, "sessionID")
	if sid == "" {
		sid = strOr(d, "sessionId")
	}
	if sid == "" {
		return
	}
	o.mu.Lock()
	open := len(o.followers) > 0
	o.mu.Unlock()
	if !open {
		return
	}
	// The agent that has the session now: an event of a session the agent has left finds none.
	a, err := o.DB.AgentBySession(context.Background(), sid)
	if err != nil {
		return
	}
	o.mu.Lock()
	fs := make([]*follower, 0, len(o.followers[a.ID]))
	for f := range o.followers[a.ID] {
		fs = append(fs, f)
	}
	o.mu.Unlock()
	for _, f := range fs {
		f.apply(o, sid, typ, d)
	}
}

// apply is one event of session sid for the window: the window moved to a new session is emptied first, and read again.
func (f *follower) apply(o *OpenCode, sid, typ string, d *jsjson.Object) {
	o.mu.Lock()
	moved := f.sid != sid
	f.sid = sid
	o.mu.Unlock()
	result := evNone
	if moved {
		// Empties the window and fences off a read of the old session still in flight (Sink.Moved).
		f.live.Moved()
	}
	f.live.Update(func(s *Store) bool {
		result = ApplyEvent(s, typ, d)
		return result != evNone
	})
	// The window's own lock is not held: a resync takes it.
	if moved || result == evResync {
		f.live.Resync()
	}
}

// send hands the call to the lifecycle, which runs it in the session the agent runs now with the session's slot held, and
// not at all when the agent runs none, is in a launch, or has moved on: refused (409), nothing delivered. do is the call, made
// with the bound session.
func (o *OpenCode) send(ctx context.Context, a db.Agent, what, pid string, do func(sid string) error) error {
	sent, err := o.Send(ctx, a.ID, pid, do)
	if !sent && err == nil {
		return refuse(409, a.Name+" isn't running its OpenCode session right now, or moved to another, so "+what+" isn't sent; try again, or use the terminal")
	}
	return err
}

// Prompt sends text: 'queue' waits for the turn to end, 'steer' joins the running turn at its next step.
func (o *OpenCode) Prompt(ctx context.Context, a db.Agent, text, delivery string) error {
	return o.send(ctx, a, "the prompt", "", func(sid string) error {
		_, err := o.Call(ctx, "POST", "/api/session/"+url.PathEscape(sid)+"/prompt", jsjson.NewObject("text", text, "delivery", delivery))
		return err
	})
}

// Stop interrupts the agent's running turn (lifecycle's: it reads the row itself and holds the session's slot).
func (o *OpenCode) Stop(ctx context.Context, a db.Agent) (bool, error) { return o.Interrupt(ctx, a) }

// AnswerPermission replies to a permission request of the agent's session.
func (o *OpenCode) AnswerPermission(ctx context.Context, a db.Agent, request, decision string) error {
	return o.send(ctx, a, "the permission reply", request, func(sid string) error {
		_, err := o.Call(ctx, "POST", "/api/session/"+url.PathEscape(sid)+"/permission/"+url.PathEscape(request)+"/reply", jsjson.NewObject("decision", decision))
		return err
	})
}

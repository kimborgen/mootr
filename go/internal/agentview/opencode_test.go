package agentview

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
	"testing"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// call is one call the fake server was asked for.
type ocCall struct {
	method, path string
	body         string
}

// ocFake is the shared server as the source calls it: answers by path prefix, every call recorded.
type ocFake struct {
	mu      sync.Mutex
	calls   []ocCall
	answers map[string]string
	fail    error
}

func (f *ocFake) call(_ context.Context, method, path string, body jsjson.Value) (jsjson.Value, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b := ""
	if body != nil {
		b = jsjson.Stringify(body, "")
	}
	f.calls = append(f.calls, ocCall{method, path, b})
	if f.fail != nil {
		return nil, f.fail
	}
	for prefix, ans := range f.answers {
		if strings.HasPrefix(path, prefix) {
			v, err := jsjson.Parse([]byte(ans))
			return v, err
		}
	}
	return jsjson.NewObject(), nil
}

func (f *ocFake) paths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		out = append(out, c.method+" "+c.path)
	}
	return out
}

// recSink is a live window as the source sees it.
type recSink struct {
	mu      sync.Mutex
	store   Store
	changes int
	resyncs int
}

func (s *recSink) Update(fn func(*Store) bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if fn(&s.store) {
		s.changes++
	}
}
func (s *recSink) Moved() {
	s.mu.Lock()
	s.store = Store{Replaced: true, StatusDirty: true}
	s.mu.Unlock()
}
func (s *recSink) Resync() { s.mu.Lock(); s.resyncs++; s.mu.Unlock() }
func (s *recSink) state() (running, replaced bool, resyncs int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.store.Running, s.store.Replaced, s.resyncs
}

func ocAgent(t *testing.T, d *db.DB, id, sid string) db.Agent {
	t.Helper()
	if _, err := d.CreateAgent(context.Background(), db.NewAgent{ID: id, Name: "n-" + id, Role: "dev", Machine: "m", Harness: "opencode", Cwd: "/tmp", SessionID: &sid}); err != nil {
		t.Fatal(err)
	}
	a, err := d.GetAgent(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func ocSource(d *db.DB, f *ocFake, bind func(ctx context.Context, id string) (string, func() bool)) *OpenCode {
	// The lifecycle's send, as its test stubs it: the binding, its check, then the call.
	send := func(ctx context.Context, id, pid string, do func(string) error) (bool, error) {
		sid, held := bind(ctx, id)
		if sid == "" || !held() {
			return false, nil
		}
		return true, do(sid)
	}
	return &OpenCode{DB: d, Call: f.call, Send: send, Interrupt: func(context.Context, db.Agent) (bool, error) { return true, nil }}
}

func always(sid string) func(context.Context, string) (string, func() bool) {
	return func(context.Context, string) (string, func() bool) { return sid, func() bool { return true } }
}

// A page reads one more than asked, newest first, with the cursor of the message to continue from, and answers oldest
// first with the id for the next older page; a message the view leaves out is skipped.
func TestOpenCodePage(t *testing.T) {
	d := openDB(t)
	a := ocAgent(t, d, "p1", "ses_p1")
	f := &ocFake{answers: map[string]string{"/api/session/ses_p1/message": `[
		{"id":"m4","type":"user","text":"d","time":{"created":4}},
		{"id":"m3","type":"idle","outcome":"succeeded","time":{"created":3}},
		{"id":"m2","type":"user","text":"b","time":{"created":2}},
		{"id":"m1","type":"user","text":"a","time":{"created":1}}]`}}
	o := ocSource(d, f, always("ses_p1"))
	p, err := o.Page(context.Background(), a, 3, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := f.paths(); len(got) != 1 || got[0] != "GET /api/session/ses_p1/message?order=desc&limit=4" {
		t.Errorf("calls %v", got)
	}
	var ids []string
	for _, m := range p.Messages {
		ids = append(ids, m.ID)
	}
	if fmt.Sprint(ids) != "[m2 m4]" || p.Older == nil || *p.Older != "m2" {
		t.Errorf("page %v older %v", ids, p.Older)
	}
	if _, err := o.Page(context.Background(), a, 3, "m2"); err != nil {
		t.Fatal(err)
	}
	q := f.paths()[1]
	cursor := strings.TrimSuffix(strings.TrimPrefix(q, "GET /api/session/ses_p1/message?cursor="), "&limit=4")
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil || string(raw) != `{"id":"m2","order":"desc","direction":"next"}` {
		t.Errorf("cursor %q (%v) in %s", raw, err, q)
	}
	// The last page has no older one.
	f.answers["/api/session/ses_p1/message"] = `[{"id":"m1","type":"user","text":"a","time":{"created":1}}]`
	if p, _ := o.Page(context.Background(), a, 3, "m2"); p.Older != nil {
		t.Errorf("older %v at the start", *p.Older)
	}
}

// Every call acts on the session the row names when it is made, not the one the caller read: a window that moved to
// another session is read from that one.
func TestOpenCodeReadsTheCurrentSession(t *testing.T) {
	d := openDB(t)
	stale := ocAgent(t, d, "r1", "ses_old")
	if err := d.UpdateAgent(context.Background(), "r1", db.Field{Col: "session_id", Val: "ses_new"}); err != nil {
		t.Fatal(err)
	}
	f := &ocFake{answers: map[string]string{"/api/session/active": `{"ses_new":{"type":"busy"}}`, "/api/session/ses_new/permission": `[{"id":"p1","action":"bash","resources":["ls"]}]`}}
	o := ocSource(d, f, always("ses_new"))
	if _, err := o.Page(context.Background(), stale, 5, ""); err != nil {
		t.Fatal(err)
	}
	running, perms, err := o.Status(context.Background(), stale)
	if err != nil || !running || len(perms) != 1 || perms[0].ID != "p1" {
		t.Errorf("status %v %v %v", running, perms, err)
	}
	for _, p := range f.paths() {
		if strings.Contains(p, "ses_old") {
			t.Errorf("a call for the session the agent left: %s", p)
		}
	}
}

// A send is bound to the session the agent runs: refused (and nothing sent) when it runs none or has moved on since the
// binding, sent to the bound session otherwise.
func TestOpenCodeSendBinding(t *testing.T) {
	d := openDB(t)
	a := ocAgent(t, d, "s1", "ses_s1")
	ctx := context.Background()
	type send struct {
		name string
		do   func(o *OpenCode) error
		want string
	}
	sends := []send{
		{"prompt", func(o *OpenCode) error { return o.Prompt(ctx, a, "hi", "steer") }, "POST /api/session/ses_bound/prompt"},
		{"reply", func(o *OpenCode) error { return o.AnswerPermission(ctx, a, "per/1", "once") }, "POST /api/session/ses_bound/permission/per%2F1/reply"},
	}
	for _, s := range sends {
		t.Run(s.name, func(t *testing.T) {
			f := &ocFake{}
			// Runs no session, or a launch is in flight (the lifecycle's binding says "").
			if err := s.do(ocSource(d, f, always(""))); err == nil || len(f.paths()) != 0 {
				t.Errorf("an agent with no session: %v, calls %v", err, f.paths())
			}
			// Moved on between the binding and the send.
			moved := func(context.Context, string) (string, func() bool) { return "ses_bound", func() bool { return false } }
			err := s.do(ocSource(d, f, moved))
			if e, ok := AsError(err); !ok || e.Status != 409 || len(f.paths()) != 0 {
				t.Errorf("an agent that moved: %v, calls %v", err, f.paths())
			}
			// Held: sent to the bound session, whatever the row the caller read says.
			if err := s.do(ocSource(d, f, always("ses_bound"))); err != nil {
				t.Fatal(err)
			}
			if got := f.paths(); len(got) != 1 || got[0] != s.want {
				t.Errorf("calls %v, want %s", got, s.want)
			}
		})
	}
}

// Followers are removed with their windows: none stays after many open and close cycles, and a stop twice does no harm.
func TestOpenCodeFollowersCleanUp(t *testing.T) {
	d := openDB(t)
	a := ocAgent(t, d, "f1", "ses_f1")
	o := ocSource(d, &ocFake{}, always("ses_f1"))
	var stops []func()
	for i := 0; i < 300; i++ {
		stop := o.Follow(a, &recSink{})
		if i%3 == 0 {
			stop()
			stop()
		} else {
			stops = append(stops, stop)
		}
	}
	if got := o.Followers(); got != len(stops) {
		t.Fatalf("%d followers, want %d", got, len(stops))
	}
	for _, stop := range stops {
		stop()
	}
	if got := o.Followers(); got != 0 || len(o.followers) != 0 {
		t.Errorf("%d followers (%d agents) left after every window closed", got, len(o.followers))
	}
}

// An event reaches the followers of the agent that has its session now. One of a session the agent left finds none; the
// first one of the session it moved to empties the window and reads again.
func TestOpenCodeEventRouting(t *testing.T) {
	d := openDB(t)
	a := ocAgent(t, d, "e1", "ses_e1")
	other := ocAgent(t, d, "e2", "ses_e2")
	o := ocSource(d, &ocFake{}, always("ses_e1"))
	mine, theirs := &recSink{}, &recSink{}
	o.Follow(a, mine)
	o.Follow(other, theirs)
	ev := func(typ, sid string) {
		o.Event(typ, jsjson.NewObject("sessionID", sid))
	}
	ev("session.execution.started", "ses_e1")
	if running, replaced, resyncs := mine.state(); !running || replaced || resyncs != 0 {
		t.Errorf("an event of its session: running %v replaced %v resyncs %d", running, replaced, resyncs)
	}
	if running, _, _ := theirs.state(); running {
		t.Error("an event reached another agent's follower")
	}
	ev("session.execution.started", "ses_nobody")
	ev("session.execution.started", "")
	if _, _, resyncs := theirs.state(); resyncs != 0 {
		t.Error("an event of no agent's session did something")
	}
	// A turn's end asks for a read again.
	ev("session.execution.succeeded", "ses_e1")
	if running, _, resyncs := mine.state(); running || resyncs != 1 {
		t.Errorf("a turn's end: running %v resyncs %d", running, resyncs)
	}
	// The agent moves to another session.
	if err := d.UpdateAgent(context.Background(), "e1", db.Field{Col: "session_id", Val: "ses_e1b"}); err != nil {
		t.Fatal(err)
	}
	ev("session.execution.started", "ses_e1")
	if running, _, resyncs := mine.state(); running || resyncs != 1 {
		t.Errorf("an event of the session the agent left reached its follower: running %v resyncs %d", running, resyncs)
	}
	ev("session.execution.started", "ses_e1b")
	running, replaced, resyncs := mine.state()
	if !running || !replaced || resyncs != 2 {
		t.Errorf("the first event of the new session: running %v replaced %v resyncs %d", running, replaced, resyncs)
	}
	ev("session.execution.started", "ses_e1b")
	if _, _, resyncs := mine.state(); resyncs != 2 {
		t.Errorf("a second event of the new session read again: %d", resyncs)
	}
}

// The view's permission reply: refused for a source that takes none and for a body that is missing a field, recorded as an
// event when sent.
func TestServiceAnswerPermission(t *testing.T) {
	d := openDB(t)
	a := ocAgent(t, d, "v1", "ses_v1")
	f := &ocFake{}
	svc := &Service{DB: d}
	svc.Register("opencode", ocSource(d, f, always("ses_v1")))
	ctx := context.Background()
	status := func(err error) int {
		if e, ok := AsError(err); ok {
			return e.Status
		}
		if err != nil {
			return -1
		}
		return 0
	}
	for _, c := range []struct {
		name          string
		request, dec  jsjson.Value
		want          int
		callsExpected int
	}{
		{"no request", nil, "once", 400, 0},
		{"empty request", "", "once", 400, 0},
		{"no decision", "p1", nil, 400, 0},
		{"bad decision", "p1", "maybe", 400, 0},
		{"non-string decision", "p1", 3.0, 400, 0},
		{"once", "p1", "once", 0, 1},
	} {
		before := len(f.paths())
		got := status(svc.AnswerPermission(ctx, a, c.request, c.dec))
		if got != c.want || len(f.paths())-before != c.callsExpected {
			t.Errorf("%s: status %d, %d calls", c.name, got, len(f.paths())-before)
		}
	}
	evs, err := d.ListEvents(ctx, "v1", 10, "")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range evs {
		found = found || e.Type == "view-permission" && e.Data != nil && *e.Data == `{"request":"p1","decision":"once"}`
	}
	if !found {
		t.Errorf("no view-permission event: %v", evs)
	}
	// A harness whose source takes none: TS's 409.
	svc.Register("claude", &Claude{DB: d})
	c, err := d.CreateAgent(ctx, db.NewAgent{ID: "v2", Name: "v2", Role: "dev", Machine: "m", Harness: "claude", Cwd: "/tmp"})
	if err != nil {
		t.Fatal(err)
	}
	_ = c
	cl, _ := d.GetAgent(ctx, "v2")
	if e, ok := AsError(svc.AnswerPermission(ctx, cl, "p", "once")); !ok || e.Status != 409 {
		t.Errorf("a claude agent's reply: %v", e)
	}
}

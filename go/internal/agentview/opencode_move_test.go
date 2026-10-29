package agentview

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// stored is n stored assistant messages named PREFIX_00..., newest first as the server lists them.
func stored(prefix string, n int) string {
	var parts []string
	for i := n - 1; i >= 0; i-- {
		parts = append(parts, fmt.Sprintf(`{"id":"%s_%03d","type":"assistant","time":{"created":%d,"completed":%d},"content":[{"type":"text","text":"%s %d"}]}`, prefix, i, 1000+i, 1001+i, prefix, i))
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// events collects a view stream's frames.
type events struct {
	mu  sync.Mutex
	all []map[string]any
}

func (e *events) collect(t *testing.T, c *viewClient) {
	go func() {
		for {
			ev := c.next(t)
			if ev == nil {
				return
			}
			e.mu.Lock()
			e.all = append(e.all, ev)
			e.mu.Unlock()
		}
	}()
}

func (e *events) snapshot() []map[string]any {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]map[string]any(nil), e.all...)
}

func (e *events) from(n int) []map[string]any { return e.snapshot()[n:] }

// An open window whose agent moves to another session: a read of the old session that is still in flight when the first event
// of the new one comes must not put the old session's messages back (B), and a new session with more than a page of history
// shows its paging, in a state frame that carries its messages (C).
func TestOpenCodeMovedWindow(t *testing.T) {
	d := openDB(t)
	a := ocAgent(t, d, "mv1", "ses_old")
	f := &ocFake{answers: map[string]string{
		"/api/session/active":             `{}`,
		"/api/session/ses_old/permission": `[]`,
		"/api/session/ses_new/permission": `[]`,
		"/api/session/ses_old/message":    stored("old", 3),
		"/api/session/ses_new/message":    stored("new", pageSize+1),
	}}
	// The reads of the old session's messages wait at the gate once it is armed.
	var gmu sync.Mutex
	var gate, blocked chan struct{}
	o := ocSource(d, f, always("ses_old"))
	call := o.Call
	o.Call = func(ctx context.Context, method, path string, body jsjson.Value) (jsjson.Value, error) {
		gmu.Lock()
		g, b := gate, blocked
		if g != nil && strings.Contains(path, "ses_old/message") {
			blocked = nil
			gmu.Unlock()
			close(b)
			<-g
		} else {
			gmu.Unlock()
		}
		return call(ctx, method, path, body)
	}
	svc := &Service{DB: d, Done: make(chan struct{})}
	svc.Register("opencode", o)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := svc.Stream(w, r, a); err != nil {
			t.Errorf("stream: %v", err)
		}
	}))
	t.Cleanup(ts.Close)
	c := openView(t, ts.URL)
	var evs events
	first := c.next(t)
	if first["type"] != "state" || !strings.Contains(fmt.Sprint(first), "old_000") {
		t.Fatalf("first frame %v", first)
	}
	evs.collect(t, c)

	// A read of the old session begins (a turn of it ended) and is held in its Page.
	gmu.Lock()
	gate, blocked = make(chan struct{}), make(chan struct{})
	g, b := gate, blocked
	gmu.Unlock()
	o.Event("session.execution.succeeded", jsjson.NewObject("sessionID", "ses_old"))
	<-b
	// The agent moves: the row names the new session, and the new session's first event comes.
	if err := d.UpdateAgent(context.Background(), "mv1", db.Field{Col: "session_id", Val: "ses_new"}); err != nil {
		t.Fatal(err)
	}
	n := len(evs.snapshot())
	o.Event("session.execution.started", jsjson.NewObject("sessionID", "ses_new"))
	// The stale read finishes after the move.
	close(g)
	var state map[string]any
	waitFor(t, "the new session's state", func() bool {
		for _, ev := range evs.from(n) {
			if ev["type"] == "state" && strings.Contains(fmt.Sprint(ev), "new_049") {
				state = ev
				return true
			}
		}
		return false
	})
	// Nothing after the move shows a message of the old session, in a state or as a change.
	for _, ev := range evs.from(n) {
		if strings.Contains(fmt.Sprint(ev), "old_00") {
			t.Fatalf("a frame after the move shows the old session: %v", ev)
		}
	}
	// C: the state carries the new session's newest page and the cursor for the older ones.
	st := state["state"].(map[string]any)
	if st["older"] == nil {
		t.Errorf("the moved window lost its paging: %v", st["older"])
	}
	if msgs := st["messages"].([]any); len(msgs) != pageSize {
		t.Errorf("the state has %d messages, want %d", len(msgs), pageSize)
	}
	c.cancel()
}

// The first read of a window fails, after the agent moved to another session, with an error of the session it left: the
// joiner gets the new session's view, not a 502 (a failure is the first read's only while the window is on the session it
// read).
func TestOpenCodeFirstReadFailsAfterAMove(t *testing.T) {
	d := openDB(t)
	a := ocAgent(t, d, "mv2", "ses_old")
	f := &ocFake{answers: map[string]string{
		"/api/session/active":             `{}`,
		"/api/session/ses_new/permission": `[]`,
		"/api/session/ses_new/message":    stored("new", 3),
	}}
	blocked, gate := make(chan struct{}), make(chan struct{})
	o := ocSource(d, f, always("ses_old"))
	call := o.Call
	var once sync.Once
	o.Call = func(ctx context.Context, method, path string, body jsjson.Value) (jsjson.Value, error) {
		if strings.Contains(path, "ses_old/") {
			once.Do(func() { close(blocked) })
			<-gate
			return nil, errors.New("GET " + path + ": 500")
		}
		return call(ctx, method, path, body)
	}
	svc := &Service{DB: d, Done: make(chan struct{})}
	svc.Register("opencode", o)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := svc.Stream(w, r, a); err != nil {
			e, _ := AsError(err)
			w.WriteHeader(e.Status)
		}
	}))
	t.Cleanup(ts.Close)
	type result struct {
		c     *viewClient
		first map[string]any
	}
	got := make(chan result, 1)
	go func() {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL, nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			got <- result{}
			return
		}
		t.Cleanup(func() { res.Body.Close() })
		if res.StatusCode != 200 {
			got <- result{first: map[string]any{"status": res.StatusCode}}
			return
		}
		c := &viewClient{cancel: cancel, lines: bufio.NewScanner(res.Body)}
		got <- result{c: c, first: c.next(t)}
	}()
	<-blocked
	// The agent moves while the first read is in flight, and the new session's read lands.
	if err := d.UpdateAgent(context.Background(), "mv2", db.Field{Col: "session_id", Val: "ses_new"}); err != nil {
		t.Fatal(err)
	}
	o.Event("session.execution.started", jsjson.NewObject("sessionID", "ses_new"))
	waitFor(t, "the new session's read", func() bool {
		svc.mu.Lock()
		l := svc.lives["mv2"]
		svc.mu.Unlock()
		if l == nil {
			return false
		}
		l.mu.Lock()
		defer l.mu.Unlock()
		return len(l.store.Messages) == 3
	})
	// The stale first read fails now.
	close(gate)
	r := <-got
	if r.c == nil || r.first == nil || r.first["type"] != "state" || !strings.Contains(fmt.Sprint(r.first), "new_002") {
		t.Fatalf("the joiner got %v, want the new session's state", r.first)
	}
}

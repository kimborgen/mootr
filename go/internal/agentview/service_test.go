package agentview

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/db"
)

// openDB is an empty stam.db with the TS daemon's schema (testdata/mkdb.mjs).
func openDB(t *testing.T) *db.DB {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/db.ts")
	}
	home := t.TempDir()
	if out, err := exec.Command("node", "--no-warnings", "testdata/mkdb.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("mkdb.mjs: %v\n%s", err, out)
	}
	d, err := db.Open(context.Background(), filepath.Join(home, "stam.db"), db.Options{})
	must(t, err)
	t.Cleanup(func() { d.Close() })
	return d
}

// fakeSource is a harness whose follows are counted, and whose sink the test drives.
type fakeSource struct {
	mu      sync.Mutex
	follows int
	stops   int
	sink    Sink
}

func (f *fakeSource) Caps() Caps                  { return Caps{CanSend: true} }
func (f *fakeSource) Unavailable(db.Agent) string { return "" }
func (f *fakeSource) Page(context.Context, db.Agent, int, string) (Page, error) {
	return Page{Messages: []*Message{{ID: "m1", Role: "user", At: 1, Parts: []Part{{Type: "text", Text: "hi"}}}}}, nil
}
func (f *fakeSource) Status(context.Context, db.Agent) (bool, []*Permission, error) {
	return false, nil, nil
}
func (f *fakeSource) Follow(_ db.Agent, live Sink) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.follows++
	f.sink = live
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.stops++
	}
}
func (f *fakeSource) Prompt(context.Context, db.Agent, string, string) error { return nil }
func (f *fakeSource) Stop(context.Context, db.Agent) (bool, error)           { return false, nil }

func (f *fakeSource) counts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.follows, f.stops
}

// waitFor waits on a state the stream's goroutines reach, failing after a generous bound.
func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("never: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type viewClient struct {
	cancel context.CancelFunc
	lines  *bufio.Scanner
}

func openView(t *testing.T, url string) *viewClient {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	must(t, err)
	res, err := http.DefaultClient.Do(req)
	must(t, err)
	t.Cleanup(func() { cancel(); res.Body.Close() })
	return &viewClient{cancel: cancel, lines: bufio.NewScanner(res.Body)}
}

func (c *viewClient) next(t *testing.T) map[string]any {
	t.Helper()
	for c.lines.Scan() {
		if data, ok := strings.CutPrefix(c.lines.Text(), "data: "); ok {
			var ev map[string]any
			must(t, json.Unmarshal([]byte(data), &ev))
			return ev
		}
	}
	return nil
}

// TestLiveFollowStops: one follow serves every client of an agent's view; it stops when the last one leaves, and when
// the daemon stops, which also ends each stream.
func TestLiveFollowStops(t *testing.T) {
	src := &fakeSource{}
	done := make(chan struct{})
	svc := &Service{DB: openDB(t), Done: done}
	svc.Register("fake", src)
	a := db.Agent{ID: "a1", Name: "one", Harness: "fake"}
	ended := make(chan struct{}, 4)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := svc.Stream(w, r, a); err != nil {
			t.Errorf("stream: %v", err)
		}
		ended <- struct{}{}
	}))
	defer ts.Close()

	c1 := openView(t, ts.URL)
	if ev := c1.next(t); ev["type"] != "state" {
		t.Fatalf("first event %v", ev)
	}
	c2 := openView(t, ts.URL)
	c2.next(t)
	waitFor(t, "two viewers", func() bool { return svc.HasViewers("a1") })
	if f, s := src.counts(); f != 1 || s != 0 {
		t.Fatalf("follows %d stops %d with two clients", f, s)
	}
	// A change the source makes reaches the clients.
	src.sink.Update(func(s *Store) bool {
		s.Message("m2", func() *Message {
			return &Message{ID: "m2", Role: "assistant", At: 2, Parts: []Part{{Type: "text", Text: "yo"}}}
		})
		return true
	})
	if ev := c1.next(t); ev["type"] != "message" || ev["message"].(map[string]any)["id"] != "m2" {
		t.Errorf("c1 got %v", ev)
	}
	c1.cancel()
	<-ended
	if _, s := src.counts(); s != 0 {
		t.Fatal("the follow stopped with a client still open")
	}
	c2.cancel()
	<-ended
	waitFor(t, "the follow stops", func() bool { _, s := src.counts(); return s == 1 })
	if svc.OpenViews() != 0 {
		t.Fatal("the window stayed open")
	}

	// The daemon stops: an open stream ends, and its follow with it.
	c3 := openView(t, ts.URL)
	c3.next(t)
	close(done)
	select {
	case <-ended:
	case <-time.After(10 * time.Second):
		// Let ts.Close finish: it waits for every handler.
		c3.cancel()
		t.Fatal("the stream outlived the daemon")
	}
	waitFor(t, "the second follow stops", func() bool { _, s := src.counts(); return s == 2 })
	if f, _ := src.counts(); f != 2 {
		t.Errorf("follows %d", f)
	}
}

// stalledConn is a stream's connection to a client that never reads (internal/layout's stall_test.go): every write
// blocks until the write deadline is in the past, as a net.Conn's does. It is what http.ResponseController drives.
type stalledConn struct {
	mu       sync.Mutex
	cond     *sync.Cond
	header   http.Header
	deadline time.Time
	timer    *time.Timer
	entered  chan struct{}
}

func newStalledConn() *stalledConn {
	c := &stalledConn{header: http.Header{}, entered: make(chan struct{}, 64)}
	c.cond = sync.NewCond(&c.mu)
	return c
}

func (c *stalledConn) Header() http.Header { return c.header }
func (c *stalledConn) WriteHeader(int)     {}
func (c *stalledConn) FlushError() error   { return nil }

func (c *stalledConn) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.deadline = t
	if c.timer != nil {
		c.timer.Stop()
	}
	if !t.IsZero() {
		c.timer = time.AfterFunc(time.Until(t), func() { c.mu.Lock(); c.cond.Broadcast(); c.mu.Unlock() })
	}
	c.cond.Broadcast()
	return nil
}

func (c *stalledConn) Write(b []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entered <- struct{}{}
	for c.deadline.IsZero() || c.deadline.After(time.Now()) {
		c.cond.Wait()
	}
	return 0, errors.New("write deadline exceeded")
}

// TestStalledClientEnds: a client that stops reading parks its stream in a write; dropping it (past maxBuffered) and
// the daemon's stop each cut that write short, so the handler ends and the follow stops.
func TestStalledClientEnds(t *testing.T) {
	d := openDB(t)
	defer func(old time.Duration, max int) { writeTimeout, maxBuffered = old, max }(writeTimeout, maxBuffered)
	writeTimeout, maxBuffered = time.Hour, 64<<10
	for _, how := range []string{"dropped", "daemon stop"} {
		t.Run(how, func(t *testing.T) {
			src := &fakeSource{}
			done := make(chan struct{})
			svc := &Service{DB: d, Done: done}
			svc.Register("fake", src)
			conn := newStalledConn()
			ended := make(chan struct{})
			go func() {
				defer close(ended)
				_ = svc.Stream(conn, httptest.NewRequest("GET", "/api/agents/a1/view", nil), db.Agent{ID: "a1", Name: "one", Harness: "fake"})
			}()
			<-conn.entered // the state frame's write is blocked
			if how == "dropped" {
				big := strings.Repeat("x", 80<<10)
				for i := 0; i < 3; i++ {
					src.sink.Update(func(s *Store) bool {
						id := "big" + string(rune('a'+i))
						s.Message(id, func() *Message {
							return &Message{ID: id, Role: "assistant", At: 2, Parts: []Part{{Type: "text", Text: big}}}
						})
						return true
					})
				}
			} else {
				close(done)
			}
			select {
			case <-ended:
			case <-time.After(10 * time.Second):
				t.Fatal("the stalled stream never ended")
			}
			waitFor(t, "the follow stops", func() bool { _, s := src.counts(); return s == 1 })
			if svc.OpenViews() != 0 {
				t.Error("the window stayed open")
			}
		})
	}
}

// TestJoinerKeepsLive: the last client leaving while another is between its first read and joining doesn't drop the
// live window under the joiner: it joins the same window, whose follow goes on and reaches it.
func TestJoinerKeepsLive(t *testing.T) {
	src := &fakeSource{}
	svc := &Service{DB: openDB(t)}
	svc.Register("fake", src)
	a := db.Agent{ID: "a1", Name: "one", Harness: "fake"}
	ended := make(chan struct{}, 4)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = svc.Stream(w, r, a)
		ended <- struct{}{}
	}))
	defer ts.Close()
	c1 := openView(t, ts.URL)
	c1.next(t)
	var once sync.Once
	joinGap = func() {
		once.Do(func() {
			c1.cancel()
			<-ended
		})
	}
	defer func() { joinGap = nil }()
	c2 := openView(t, ts.URL)
	defer c2.cancel() // before ts.Close, which waits for its handler
	if ev := c2.next(t); ev["type"] != "state" {
		t.Fatalf("c2's first event %v", ev)
	}
	if f, s := src.counts(); f != 1 || s != 0 {
		t.Fatalf("follows %d stops %d: the window was dropped under the joiner", f, s)
	}
	src.mu.Lock()
	sink := src.sink
	src.mu.Unlock()
	sink.Update(func(s *Store) bool {
		s.Message("m2", func() *Message {
			return &Message{ID: "m2", Role: "assistant", At: 2, Parts: []Part{{Type: "text", Text: "yo"}}}
		})
		return true
	})
	if ev := c2.next(t); ev["type"] != "message" {
		t.Errorf("c2 got %v", ev)
	}
}

// TestStateFirst: a change flushed between a client joining the live and its stream starting reaches it after its
// state, and a change bigger than maxBuffered there doesn't drop it before it has its snapshot.
func TestStateFirst(t *testing.T) {
	defer func(max int) { maxBuffered = max }(maxBuffered)
	maxBuffered = 4 << 10
	src := &fakeSource{}
	svc := &Service{DB: openDB(t)}
	svc.Register("fake", src)
	a := db.Agent{ID: "a1", Name: "one", Harness: "fake"}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = svc.Stream(w, r, a) }))
	defer ts.Close()
	big := strings.Repeat("x", 8<<10)
	joinedGap = func(l *live) {
		l.Update(func(s *Store) bool {
			s.Message("m2", func() *Message {
				return &Message{ID: "m2", Role: "assistant", At: 2, Parts: []Part{{Type: "text", Text: big}}}
			})
			return true
		})
		l.flush()
	}
	defer func() { joinedGap = nil }()
	c := openView(t, ts.URL)
	defer c.cancel() // before ts.Close, which waits for its handler
	c.lines.Buffer(nil, 1<<20)
	if ev := c.next(t); ev == nil || ev["type"] != "state" {
		t.Fatalf("first event %v", ev)
	}
	if ev := c.next(t); ev == nil || ev["type"] != "message" {
		t.Fatalf("second event %v: the client was dropped", ev)
	}
}

// blockingSource's first read waits until released, so a stream is still joining.
type blockingSource struct {
	fakeSource
	release chan struct{}
}

func (b *blockingSource) Page(ctx context.Context, a db.Agent, n int, before string) (Page, error) {
	<-b.release
	return b.fakeSource.Page(ctx, a, n, before)
}

// TestJoiningEndsOnDone: the daemon stopping while a stream waits for its first read ends that stream, and the window
// is dropped once the read is done.
func TestJoiningEndsOnDone(t *testing.T) {
	src := &blockingSource{release: make(chan struct{})}
	done := make(chan struct{})
	svc := &Service{DB: openDB(t), Done: done}
	svc.Register("fake", src)
	ended := make(chan error, 1)
	go func() {
		ended <- svc.Stream(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil), db.Agent{ID: "a1", Name: "one", Harness: "fake"})
	}()
	waitFor(t, "the window opens", func() bool { return svc.OpenViews() == 1 })
	close(done)
	select {
	case err := <-ended:
		if err != nil {
			t.Fatalf("stream: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the joining stream outlived the daemon")
	}
	waitFor(t, "the follow stops", func() bool { _, s := src.counts(); return s == 1 })
	close(src.release)
}

// TestPromptQueuesPruned: an agent's prompt queue lives only while a prompt holds or waits for it, typed or refused.
func TestPromptQueuesPruned(t *testing.T) {
	d := openDB(t)
	ctx := context.Background()
	a, err := d.CreateAgent(ctx, db.NewAgent{ID: "a1", Name: "one", Role: "dev", Machine: "m", Harness: "claude", Cwd: "/"})
	must(t, err)
	must(t, d.UpdateAgent(ctx, "a1", db.Field{Col: "activity", Val: "working"}))
	free := true
	c := &Claude{DB: d, Type: func(context.Context, db.Agent, string) bool { return free }}
	must(t, c.Prompt(ctx, a, "hi", "queue"))
	waitFor(t, "the typed prompt's queue goes", func() bool { return c.Queues() == 0 })
	free = false
	if err := c.Prompt(ctx, a, "hi", "queue"); err == nil {
		t.Fatal("a prompt into a busy box was taken")
	}
	if n := c.Queues(); n != 0 {
		t.Errorf("a refused prompt left %d queues", n)
	}
}

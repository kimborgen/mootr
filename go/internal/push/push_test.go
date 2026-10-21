package push

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// writer is a push stream's response: it records what was written, and fails every write after the first fail
// writes when fail is set.
type writer struct {
	mu     sync.Mutex
	h      http.Header
	buf    strings.Builder
	writes int
	fail   int
	// block, when set, holds every write after the first until it is closed.
	block chan struct{}
}

func (w *writer) Header() http.Header { return w.h }
func (w *writer) WriteHeader(int)     {}
func (w *writer) Flush()              {}
func (w *writer) Write(b []byte) (int, error) {
	w.mu.Lock()
	w.writes++
	n, block, fail := w.writes, w.block, w.fail
	w.mu.Unlock()
	if block != nil && n > 1 {
		<-block
	}
	if fail > 0 && n > fail {
		return 0, errors.New("broken pipe")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.WriteString(string(b))
}

func (w *writer) text() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// ended waits for a stream's handler to return, failing the test after a second.
func ended(t *testing.T, done chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("%s: the stream is still served", what)
	}
}

// serve runs a stream for id on s until the returned stop is called, and waits until it can take pushes.
func serve(t *testing.T, s *Streams, id string, w *writer) (stop func(), done chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/api/agents/"+id+"/stream", nil).WithContext(ctx)
	done = make(chan struct{})
	connected := make(chan struct{})
	go func() {
		defer close(done)
		s.Serve(context.Background(), w, req, id, func() { close(connected) })
	}()
	select {
	case <-connected:
	case <-done:
	}
	return func() { cancel(); <-done }, done
}

// TestPush: a push reaches every stream of its agent as `data: {content, meta}`, and none of another agent's; with no
// stream it is no delivery.
func TestPush(t *testing.T) {
	s := New()
	if s.Push(context.Background(), "alx1", "hi", nil) || s.Has("alx1") {
		t.Fatal("a push with no stream was delivered")
	}
	var nilStreams *Streams
	if nilStreams.Push(context.Background(), "alx1", "hi", nil) {
		t.Fatal("nil streams delivered")
	}
	a, b, other := &writer{h: http.Header{}}, &writer{h: http.Header{}}, &writer{h: http.Header{}}
	stopA, _ := serve(t, s, "alx1", a)
	stopB, _ := serve(t, s, "alx1", b)
	stopO, _ := serve(t, s, "aly1", other)
	if !s.Has("alx1") || a.h.Get("Content-Type") != "text/event-stream" {
		t.Fatal("not connected")
	}
	if !s.Push(context.Background(), "alx1", "line one\nline \"two\"", map[string]string{"kind": "mail"}) {
		t.Fatal("not delivered")
	}
	want := ": connected\n\n" + `data: {"content":"line one\nline \"two\"","meta":{"kind":"mail"}}` + "\n\n"
	if a.text() != want || b.text() != want || other.text() != ": connected\n\n" {
		t.Errorf("a %q\nb %q\nother %q", a.text(), b.text(), other.text())
	}
	stopA()
	stopB()
	stopO()
	if s.Has("alx1") || s.Has("aly1") {
		t.Error("a stream outlived its client")
	}
}

// TestPushDrops: a stream whose write fails delivers nothing and is gone after; one that doesn't take the event within
// Timeout, or whose client left, is no delivery either. Another stream that wrote it still is.
func TestPushDrops(t *testing.T) {
	s := New()
	broken := &writer{h: http.Header{}, fail: 1}
	_, done := serve(t, s, "alz1", broken)
	if s.Push(context.Background(), "alz1", "lost", nil) {
		t.Fatal("a failed write was delivered")
	}
	ended(t, done, "a failed write")
	if s.Has("alz1") {
		t.Fatal("the broken stream stayed")
	}

	// A stream stuck on an earlier write never takes the next event.
	prev := Timeout
	Timeout = 50 * time.Millisecond
	t.Cleanup(func() { Timeout = prev })
	stuck := &writer{h: http.Header{}, block: make(chan struct{})}
	stopStuck, _ := serve(t, s, "alz2", stuck)
	first := make(chan bool)
	go func() { first <- s.Push(context.Background(), "alz2", "first", nil) }()
	for {
		stuck.mu.Lock()
		n := stuck.writes
		stuck.mu.Unlock()
		if n > 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	// The write blocked past the deadline: undelivered.
	if <-first {
		t.Fatal("a write still blocked was delivered")
	}
	if s.Push(context.Background(), "alz2", "second", nil) {
		t.Fatal("a stream that never took the event delivered it")
	}
	// The same with a cancelled push.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if s.Push(ctx, "alz2", "third", nil) {
		t.Fatal("a cancelled push was delivered")
	}
	// One good stream is enough.
	good := &writer{h: http.Header{}}
	stopGood, _ := serve(t, s, "alz2", good)
	if !s.Push(context.Background(), "alz2", "fourth", nil) || !strings.Contains(good.text(), "fourth") {
		t.Fatal("the good stream didn't deliver")
	}
	close(stuck.block)
	stopStuck()
	stopGood()
}

// TestPushStalledClient: over a real connection, a shim that stops reading fails a write once the socket's buffers
// fill; the write's deadline ends its stream, so it doesn't stay among the agent's streams.
func TestPushStalledClient(t *testing.T) {
	prev := Timeout
	Timeout = 100 * time.Millisecond
	t.Cleanup(func() { Timeout = prev })
	s := New()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.Serve(context.Background(), w, r, "als1", nil)
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The response is never read past its header.
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	for end := time.Now().Add(5 * time.Second); !s.Has("als1"); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatal("not connected")
		}
	}
	big := strings.Repeat("x", 1<<20)
	stalled := false
	for i := 0; i < 256 && !stalled; i++ {
		stalled = !s.Push(context.Background(), "als1", big, nil)
	}
	if !stalled {
		t.Fatal("256 MB went to a client that reads nothing")
	}
	for end := time.Now().Add(5 * time.Second); s.Has("als1"); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatal("the stalled stream stayed")
		}
	}
}

// TestPushPing: an idle stream writes a ping comment, and one whose ping fails is gone.
func TestPushPing(t *testing.T) {
	prev := Ping
	Ping = 10 * time.Millisecond
	t.Cleanup(func() { Ping = prev })
	s := New()
	w := &writer{h: http.Header{}, fail: 2}
	_, done := serve(t, s, "alp1", w)
	ended(t, done, "a failed ping")
	if !strings.HasPrefix(w.text(), ": connected\n\n: ping\n\n") || s.Has("alp1") {
		t.Errorf("%q, still there %v", w.text(), s.Has("alp1"))
	}
}

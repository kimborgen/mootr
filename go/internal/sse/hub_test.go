package sse

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/jsjson"
)

func TestKeepaliveIs25Seconds(t *testing.T) {
	if Keepalive != 25*time.Second {
		t.Fatalf("Keepalive = %v, want 25s (src/events.ts)", Keepalive)
	}
}

type stream struct {
	cancel context.CancelFunc
	lines  *bufio.Reader
	res    *http.Response
}

func connect(t *testing.T, url string) *stream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	s := &stream{cancel: cancel, lines: bufio.NewReader(res.Body), res: res}
	if got := s.chunk(t); got != ": connected\n\n" {
		t.Fatalf("first chunk %q", got)
	}
	return s
}

// chunk reads one SSE message, through its blank line.
func (s *stream) chunk(t *testing.T) string {
	t.Helper()
	var b strings.Builder
	for {
		line, err := s.lines.ReadString('\n')
		if err != nil {
			t.Fatalf("read: %v (so far %q)", err, b.String())
		}
		b.WriteString(line)
		if line == "\n" {
			return b.String()
		}
	}
}

func (s *stream) close() {
	s.cancel()
	s.res.Body.Close()
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func serve(h *Hub) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.Serve(w, r) })
}

func TestPingAndEmit(t *testing.T) {
	h := New(20 * time.Millisecond)
	ts := httptest.NewServer(serve(h))
	t.Cleanup(ts.Close)
	s := connect(t, ts.URL)
	defer s.close()
	if got := s.chunk(t); got != ": ping\n\n" {
		t.Fatalf("keepalive chunk %q", got)
	}
	// Emit before the client is listed would go nowhere; it is listed before its first chunk.
	if err := h.Emit("mail.sent", map[string]string{"id": "m1"}); err != nil {
		t.Fatal(err)
	}
	for {
		got := s.chunk(t)
		if got == ": ping\n\n" {
			continue
		}
		if got != "event: mail.sent\ndata: {\"id\":\"m1\"}\n\n" {
			t.Fatalf("event chunk %q", got)
		}
		break
	}
}

func TestEmitWithNoClientsIsANoop(t *testing.T) {
	h := New(time.Hour)
	// A value json can't marshal: with nobody connected it is never marshalled.
	if err := h.Emit("x", make(chan int)); err != nil {
		t.Fatalf("Emit with no clients: %v", err)
	}
}

// TestDisconnectFreesSlotAndGoroutines: clients that come and go leave no slot and no goroutine behind, and Close ends
// the rest.
func TestDisconnectFreesSlotAndGoroutines(t *testing.T) {
	h := New(10 * time.Millisecond)
	ts := httptest.NewServer(serve(h))
	before := runtime.NumGoroutine()

	var streams []*stream
	for range 20 {
		streams = append(streams, connect(t, ts.URL))
	}
	waitFor(t, "20 clients", func() bool { return h.Len() == 20 })
	for _, s := range streams[:10] {
		s.close()
	}
	waitFor(t, "10 slots freed", func() bool { return h.Len() == 10 })
	if err := h.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.Len() != 0 {
		t.Fatalf("after Close %d clients remain", h.Len())
	}
	for _, s := range streams[10:] {
		s.close()
	}
	ts.Close()
	http.DefaultClient.CloseIdleConnections()
	waitFor(t, "goroutines back to the baseline", func() bool { return runtime.NumGoroutine() <= before })

	// A closed hub takes no new client.
	if err := h.Serve(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil)); err != ErrClosed {
		t.Fatalf("Serve after Close = %v, want ErrClosed", err)
	}
}

// blockedWriter takes the first write, then blocks every later one until released: a client that stopped reading.
type blockedWriter struct {
	*httptest.ResponseRecorder
	once    sync.Once
	first   chan struct{}
	release chan struct{}
	n       int
}

func (w *blockedWriter) Write(b []byte) (int, error) {
	w.n++
	if w.n == 1 {
		w.once.Do(func() { close(w.first) })
		return w.ResponseRecorder.Write(b)
	}
	<-w.release
	return w.ResponseRecorder.Write(b)
}

func TestSlowClientIsDropped(t *testing.T) {
	h := New(time.Hour)
	w := &blockedWriter{ResponseRecorder: httptest.NewRecorder(), first: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- h.Serve(w, httptest.NewRequest(http.MethodGet, "/", nil)) }()
	<-w.first
	waitFor(t, "the client listed", func() bool { return h.Len() == 1 })
	// One event blocks in its write; the queue then fills, and the next Emit drops the client.
	for range QueueSize + 2 {
		if err := h.Emit("x", nil); err != nil {
			t.Fatal(err)
		}
	}
	close(w.release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a dropped client's stream didn't end")
	}
	if h.Len() != 0 {
		t.Fatalf("%d clients remain after the drop", h.Len())
	}
}

// TestAgentChanged: a burst for an agent sends one `agent.changed` after AgentCoalesce, the snapshot at flush time with
// the burst's patches over it and then the id; agents go out in first-change order; with no client nothing is queued.
func TestAgentChanged(t *testing.T) {
	h := New(time.Hour)
	h.AgentChanged("a1", nil)
	if h.PendingAgents() != 0 {
		t.Fatal("queued with no client")
	}
	ts := httptest.NewServer(serve(h))
	t.Cleanup(ts.Close)
	s := connect(t, ts.URL)
	defer s.close()
	state := "working"
	var mu sync.Mutex
	h.SetAgentSnapshot(func(id string) *jsjson.Object {
		if id == "a2" {
			return nil
		}
		mu.Lock()
		defer mu.Unlock()
		return jsjson.NewObject("state", "active", "activity", state, "unread", 0.0)
	})
	start := time.Now()
	h.AgentChanged("a1", jsjson.NewObject("activity", "patched", "x", 1.0))
	h.AgentChanged("a2", nil)
	h.AgentChanged("a1", jsjson.NewObject("x", 2.0))
	mu.Lock()
	state = "idle"
	mu.Unlock()
	if h.PendingAgents() != 2 {
		t.Fatalf("pending %d", h.PendingAgents())
	}
	if got := s.chunk(t); got != "event: agent.changed\ndata: {\"state\":\"active\",\"activity\":\"patched\",\"unread\":0,\"x\":2,\"id\":\"a1\"}\n\n" {
		t.Errorf("first: %q", got)
	}
	if waited := time.Since(start); waited < AgentCoalesce {
		t.Errorf("sent after %v, before the coalesce window", waited)
	}
	if got := s.chunk(t); got != "event: agent.changed\ndata: {\"id\":\"a2\"}\n\n" {
		t.Errorf("second: %q", got)
	}
	// The next change starts a new batch, with the snapshot as it is then.
	h.AgentChanged("a1", nil)
	if got := s.chunk(t); got != "event: agent.changed\ndata: {\"state\":\"active\",\"activity\":\"idle\",\"unread\":0,\"id\":\"a1\"}\n\n" {
		t.Errorf("next batch: %q", got)
	}
	// A batch whose clients all left is dropped.
	h.AgentChanged("a1", nil)
	s.close()
	waitFor(t, "the client to go", func() bool { return h.Len() == 0 })
	waitFor(t, "the batch to drop", func() bool { return h.PendingAgents() == 0 })
}

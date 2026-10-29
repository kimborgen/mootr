package layout

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// stalledConn is a stream's connection to a client that never reads: from write `from` on, a write blocks until the
// write deadline is in the past, as a net.Conn's does, and every deadline change is recorded, with whether Serve had
// returned by then; cleared closes when a deadline is first cleared. It is what http.ResponseController drives
// (SetWriteDeadline, FlushError).
type stalledConn struct {
	from int

	mu        sync.Mutex
	cond      *sync.Cond
	header    http.Header
	writes    int
	deadline  time.Time
	timer     *time.Timer
	returned  bool
	late      []time.Time
	changes   []time.Time
	cleared   chan struct{}
	entered   chan int
	enteredAt map[int]bool
}

func newStalledConn(from int) *stalledConn {
	c := &stalledConn{from: from, header: http.Header{}, entered: make(chan int, 16), enteredAt: map[int]bool{},
		cleared: make(chan struct{})}
	c.cond = sync.NewCond(&c.mu)
	return c
}

func (c *stalledConn) Header() http.Header { return c.header }
func (c *stalledConn) WriteHeader(int)     {}
func (c *stalledConn) FlushError() error   { return nil }

func (c *stalledConn) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.returned {
		c.late = append(c.late, t)
	}
	c.changes = append(c.changes, t)
	if t.IsZero() {
		select {
		case <-c.cleared:
		default:
			close(c.cleared)
		}
	}
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

var errTimeout = errors.New("write deadline exceeded")

func (c *stalledConn) Write(b []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.writes++
	if c.writes < c.from {
		return len(b), nil
	}
	c.entered <- c.writes
	for c.deadline.IsZero() || c.deadline.After(time.Now()) {
		c.cond.Wait()
	}
	return 0, errTimeout
}

// serveStalled runs s.Serve on conn in the background; the returned channel closes once Serve has returned, with
// conn marked returned first.
func serveStalled(t *testing.T, s *Store, conn *stalledConn, done chan struct{}) <-chan struct{} {
	t.Helper()
	ret := make(chan struct{})
	go func() {
		s.Serve(conn, httptest.NewRequest("GET", "/api/layout/stream", nil), "", done)
		conn.mu.Lock()
		conn.returned = true
		conn.mu.Unlock()
		close(ret)
	}()
	return ret
}

// within waits for ch, or fails the test naming what didn't happen.
func within(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("%s didn't happen within 5 s", what)
	}
}

func toggle(t *testing.T, s *Store, on bool) {
	t.Helper()
	if _, err := s.ApplyOps(opsOf(t, `[{"op":"tabBar","world":"main","pane":"p_0","on":`+strconv.FormatBool(on)+`}]`), nil, nil); err != nil {
		t.Fatal(err)
	}
}

// A client that stops reading never holds its stream. Each case blocks inside a write (the stalled connection says
// when it is entered) before it ends the stream: the write's own deadline, a drop past streamCap, and done.
func TestStalledStreams(t *testing.T) {
	t.Run("deadline", func(t *testing.T) {
		s := Open(t.TempDir())
		s.writeTimeout = 50 * time.Millisecond
		conn := newStalledConn(1)
		ret := serveStalled(t, s, conn, make(chan struct{}))
		<-conn.entered
		within(t, ret, "a write past its deadline ending the stream")
	})
	t.Run("dropped mid-write", func(t *testing.T) {
		s := Open(t.TempDir())
		s.writeTimeout = time.Hour
		big := strings.Repeat("k", 300_000)
		if _, err := s.ApplyOps(opsOf(t, `[{"op":"open","world":"main","key":"`+big+`"}]`), nil, nil); err != nil {
			t.Fatal(err)
		}
		conn := newStalledConn(1)
		ret := serveStalled(t, s, conn, make(chan struct{}))
		<-conn.entered
		for i := range 5 {
			toggle(t, s, i%2 == 0)
		}
		within(t, ret, "a stream over streamCap behind ending while its write is blocked")
	})
	t.Run("shutdown", func(t *testing.T) {
		s := Open(t.TempDir())
		s.writeTimeout = time.Hour
		conn := newStalledConn(1)
		done := make(chan struct{})
		ret := serveStalled(t, s, conn, done)
		<-conn.entered
		close(done)
		within(t, ret, "done ending a stream whose write is blocked")
	})
}

// Cancel before the deadline is set: Serve has taken an update and is about to write when done closes and the watcher
// cuts the stream. That write must not start (and so reset the deadline to now+timeout); it refuses, and Serve returns.
func TestCutBeforeWrite(t *testing.T) {
	s := Open(t.TempDir())
	s.writeTimeout = time.Hour
	conn := newStalledConn(2)
	done := make(chan struct{})
	cut := make(chan struct{})
	first := make(chan struct{})
	s.hooks.writing = func(n int) {
		if n == 1 {
			close(first)
		}
		if n == 2 {
			close(done)
			<-cut
		}
	}
	s.hooks.cut = func() { close(cut) }
	ret := serveStalled(t, s, conn, done)
	// The stream is subscribed once its first write starts; the change after it is write 2.
	<-first
	toggle(t, s, true)
	within(t, ret, "a write that would start after the cut refusing")
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.writes > 1 {
		t.Errorf("%d writes reached the connection; the one after the cut started", conn.writes)
	}
}

// A cut that comes late: the watcher has seen done and is held before it cuts until Serve has ended the stream
// itself. The cut then changes nothing, the cleared deadline stays, and the watcher has finished before Serve returns.
func TestLateCut(t *testing.T) {
	s := Open(t.TempDir())
	s.writeTimeout = time.Hour
	conn := newStalledConn(1 << 30)
	done := make(chan struct{})
	cutting, cut := make(chan struct{}), make(chan struct{})
	// Serve's loop waits for the watcher to have taken done, so the watcher can't see the stream finish first.
	s.hooks.ending = func() { <-cutting }
	s.hooks.cutting = func() {
		close(cutting)
		<-conn.cleared
	}
	s.hooks.cut = func() { close(cut) }
	ret := serveStalled(t, s, conn, done)
	close(done)
	within(t, ret, "Serve returning")
	select {
	case <-cut:
	default:
		t.Error("Serve returned before the watcher finished")
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if n := len(conn.changes); n == 0 || !conn.changes[n-1].IsZero() {
		t.Errorf("the deadline changed after Serve cleared it: %v", conn.changes)
	}
	if len(conn.late) > 0 {
		t.Errorf("the deadline changed %d times after Serve returned: %v", len(conn.late), conn.late)
	}
}

// A real connection: a client over TCP that never reads, with small socket buffers, holds no stream once done closes
// while a write to it is blocked.
func TestStalledTCPStream(t *testing.T) {
	s := Open(t.TempDir())
	s.writeTimeout = time.Hour
	big := strings.Repeat("k", 300_000)
	if _, err := s.ApplyOps(opsOf(t, `[{"op":"open","world":"main","key":"`+big+`"}]`), nil, nil); err != nil {
		t.Fatal(err)
	}
	done, ret := make(chan struct{}), make(chan struct{})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	writing := make(chan struct{}, 4)
	s.hooks.writing = func(int) { writing <- struct{}{} }
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.Serve(w, r, "", done)
		close(ret)
	}))
	srv.Listener = smallBuffers{ln}
	srv.Start()
	t.Cleanup(srv.Close)
	d := net.Dialer{Control: func(_, _ string, c syscall.RawConn) error {
		return c.Control(func(fd uintptr) { syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, 4096) })
	}}
	conn, err := d.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if _, err := conn.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	// The first event is 300 KB, past what the two small buffers hold: its write blocks.
	<-writing
	close(done)
	within(t, ret, "done ending a stream blocked on a real connection")
}

// smallBuffers is a listener whose connections send through a small buffer, so a client that doesn't read blocks the
// server's writes after a few KB rather than a few MB.
type smallBuffers struct{ net.Listener }

func (l smallBuffers) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if tc, ok := c.(*net.TCPConn); ok {
		tc.SetWriteBuffer(4096)
	}
	return c, err
}

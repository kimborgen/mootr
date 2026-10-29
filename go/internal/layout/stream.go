package layout

import (
	"errors"
	"net/http"
	"sync"
	"time"

	"stam/internal/jsjson"
)

// streamCap is how far, in bytes, a stream may fall behind (it stopped reading) before it is dropped; the client
// reconnects and gets the whole layout again (src/layout.ts STREAM_CAP).
const streamCap = 1 << 20

// pingEvery keeps an idle stream's connection open (src/layout.ts, 25 s).
const pingEvery = 25 * time.Second

// event is the stream's `layout` event for l.
func event(l *jsjson.Object) []byte {
	return []byte("event: layout\ndata: " + jsjson.Stringify(l, "") + "\n\n")
}

// writeTimeout is the longest one write to a stream may take before the client is dropped (sse.WriteTimeout).
const writeTimeout = 10 * time.Second

// subscriber is one open stream: what is queued for it, and whether it fell too far behind. kill closes on the drop,
// so a write already blocked on the client is cut short too.
type subscriber struct {
	mu      sync.Mutex
	queue   [][]byte
	pending int
	dropped bool
	wake    chan struct{}
	kill    chan struct{}
}

func newSubscriber() *subscriber {
	return &subscriber{wake: make(chan struct{}, 1), kill: make(chan struct{})}
}

// send queues data, or drops the stream once more than streamCap is waiting. It never blocks.
func (sub *subscriber) send(data []byte) {
	sub.mu.Lock()
	if !sub.dropped {
		if sub.pending > streamCap {
			sub.dropped = true
			sub.queue, sub.pending = nil, 0
			close(sub.kill)
		} else {
			sub.queue = append(sub.queue, data)
			sub.pending += len(data)
		}
	}
	sub.mu.Unlock()
	select {
	case sub.wake <- struct{}{}:
	default:
	}
}

// take is what is queued, and whether the stream was dropped.
func (sub *subscriber) take() ([][]byte, bool) {
	sub.mu.Lock()
	defer sub.mu.Unlock()
	q := sub.queue
	sub.queue = nil
	return q, sub.dropped
}

// written counts n bytes as sent, so they no longer count against streamCap.
func (sub *subscriber) written(n int) {
	sub.mu.Lock()
	sub.pending -= n
	sub.mu.Unlock()
}

// Serve is src/layout.ts streamLayout: server-sent events, the layout on connect and after every change, until the
// client goes, falls streamCap behind, or done closes. page is the x-stam-page header: a page id makes the page live
// while it holds the stream. Every write has a deadline, and a drop or done cuts a write already blocked short, as TS
// destroys a slow socket: a client that stops reading never holds the stream, its page, or a shutdown.
func (s *Store) Serve(w http.ResponseWriter, r *http.Request, page string, done <-chan struct{}) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	out := &streamOut{w: w, rc: http.NewResponseController(w), timeout: s.writeTimeout, hooks: &s.hooks}

	sub := newSubscriber()
	id := ""
	if pageID.MatchString(page) {
		id = page
	}
	s.mu.Lock()
	s.subs[sub] = true
	if id != "" {
		s.pages.open(id)
	}
	sub.send(event(s.layout))
	s.mu.Unlock()
	// Cleanup first on every way out: a closed stream leaves the set at once.
	defer func() {
		s.mu.Lock()
		delete(s.subs, sub)
		if id != "" {
			s.pages.close(id, s.now())
		}
		s.mu.Unlock()
	}()

	// A drop, done or the client going ends the stream: no write starts after it, and one blocked now is cut short.
	// Serve ends the stream itself before it joins the watcher, so a cut that comes late changes nothing, and the
	// watcher never outlives Serve.
	finished, watched := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(watched)
		select {
		case <-finished:
			return
		case <-sub.kill:
		case <-done:
		case <-r.Context().Done():
		}
		if s.hooks.cutting != nil {
			s.hooks.cutting()
		}
		out.cut()
	}()
	defer func() {
		if s.hooks.ending != nil {
			s.hooks.ending()
		}
		close(finished)
		out.release()
		<-watched
	}()

	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-done:
			return
		case <-sub.kill:
			return
		case <-ping.C:
			if out.write([]byte(": ping\n\n")) != nil {
				return
			}
		case <-sub.wake:
			q, dropped := sub.take()
			if dropped {
				return
			}
			for _, data := range q {
				if out.write(data) != nil {
					return
				}
				sub.written(len(data))
			}
		}
	}
}

// streamOut is a stream's writes and its connection's write deadline. One lock guards the end and every deadline
// change, so a write never starts, or moves the deadline, once the stream has ended; the lock is never held across
// the blocking write itself.
type streamOut struct {
	w       http.ResponseWriter
	rc      *http.ResponseController
	timeout time.Duration
	hooks   *streamHooks

	mu    sync.Mutex
	ended bool
	n     int
}

// errEnded is a write after the stream ended.
var errEnded = errors.New("layout: the stream has ended")

// write sends b with a fresh deadline, or refuses once the stream has ended.
func (o *streamOut) write(b []byte) error {
	o.mu.Lock()
	o.n++
	n := o.n
	o.mu.Unlock()
	if o.hooks.writing != nil {
		o.hooks.writing(n)
	}
	o.mu.Lock()
	if o.ended {
		o.mu.Unlock()
		return errEnded
	}
	// A deadline the writer doesn't support (a test recorder) is no error: the write just has none.
	_ = o.rc.SetWriteDeadline(time.Now().Add(o.timeout))
	o.mu.Unlock()
	if _, err := o.w.Write(b); err != nil {
		return err
	}
	return o.rc.Flush()
}

// cut ends the stream and moves the deadline to now, so a write blocked on the client returns, as TS destroys a slow
// socket.
func (o *streamOut) cut() {
	o.mu.Lock()
	if !o.ended {
		o.ended = true
		_ = o.rc.SetWriteDeadline(time.Now())
	}
	o.mu.Unlock()
	if o.hooks.cut != nil {
		o.hooks.cut()
	}
}

// release ends the stream as Serve's loop stops. A stream that ended on its own clears its deadline, since the
// connection may serve another request; one that was cut keeps the past deadline, so nothing more is written to that
// client. A cut after release changes nothing.
func (o *streamOut) release() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.ended {
		o.ended = true
		_ = o.rc.SetWriteDeadline(time.Time{})
	}
}

// streamHooks are a test's seams in Serve; all nil in the daemon. writing runs as write n starts, before its
// deadline is set; cutting as the watcher is about to cut the stream, and cut after it has; ending as Serve's loop has
// stopped, before it ends the stream and joins the watcher.
type streamHooks struct {
	writing func(n int)
	cutting func()
	cut     func()
	ending  func()
}

// pageGrace is how long a page stays live after its last stream closed, which a reload's reconnect beats
// (src/page-liveness.ts PAGE_GRACE).
const pageGrace = 60 * time.Second

// pageLiveness is src/page-liveness.ts PageLiveness: which web pages are live. A page this daemon hasn't seen since it
// started counts as seen at the start, so after a restart the pages get pageGrace to reconnect. The Store's mu guards it.
type pageLiveness struct {
	streams  map[string]int
	lastSeen map[string]time.Time
	started  time.Time
}

func newPageLiveness(started time.Time) *pageLiveness {
	return &pageLiveness{streams: map[string]int{}, lastSeen: map[string]time.Time{}, started: started}
}

func (p *pageLiveness) open(page string) { p.streams[page]++ }

func (p *pageLiveness) close(page string, now time.Time) {
	if left := p.streams[page] - 1; left > 0 {
		p.streams[page] = left
		return
	}
	delete(p.streams, page)
	p.lastSeen[page] = now
}

func (p *pageLiveness) live(page string, now time.Time) bool {
	if p.streams[page] > 0 {
		return true
	}
	seen, ok := p.lastSeen[page]
	if !ok {
		seen = p.started
	}
	return now.Sub(seen) < pageGrace
}

// prune forgets the pages whose grace is over; a page with an open stream is never forgotten.
func (p *pageLiveness) prune(now time.Time) {
	for page, t := range p.lastSeen {
		if p.streams[page] == 0 && now.Sub(t) >= pageGrace {
			delete(p.lastSeen, page)
		}
	}
}

// Package push is the live push streams, one per connected `stam mcp` shim (src/push.ts, S-2848 B1): the daemon writes
// a prompt for an agent as an event on its own shim's stream, and the shim hands it to Claude Code as a channel
// notification. Nothing is ever typed into a pane.
//
// Unlike TS, whose write returns before anything is known, a push here waits for its stream to write and flush the
// event, and reports it delivered only then: a stream that drops mid-push, or never takes the event, is no delivery,
// so the caller keeps the prompt's mail and notices queued. A write the kernel took counts as delivered, as in TS.
package push

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"
)

// Ping is how often an idle stream writes a comment, so proxies and the shim keep it open (src/push.ts).
var Ping = 25 * time.Second

// Timeout is how long a push waits for one stream to take and write its event.
var Timeout = 5 * time.Second

// Streams is the shims' streams, by agent.
type Streams struct {
	mu      sync.Mutex
	streams map[string]map[*stream]bool
}

type stream struct {
	events chan event
	// done is closed when the stream's handler returns: nothing more is written to it.
	done chan struct{}
}

type event struct {
	data []byte
	// written gets the write's outcome; buffered, so the stream never waits on a push that gave up.
	written chan error
}

// New returns an empty set of streams.
func New() *Streams { return &Streams{streams: map[string]map[*stream]bool{}} }

// Serve is src/push.ts addStream: it answers the request with the agent's event stream, calls connected once the stream
// can take pushes (src/push.ts schedules the agent's push there), and returns when the client goes away, a write
// fails, or ctx ends.
func (s *Streams) Serve(ctx context.Context, w http.ResponseWriter, r *http.Request, id string, connected func()) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	rc := http.NewResponseController(w)
	// Each write has Timeout to finish: a shim that stops reading fails the write once the socket's buffers fill, and
	// its stream ends, rather than holding the handler, and its place among the agent's streams, forever.
	write := func(b []byte) error {
		if err := rc.SetWriteDeadline(time.Now().Add(Timeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
			return err
		}
		if _, err := w.Write(b); err != nil {
			return err
		}
		return rc.Flush()
	}
	if write([]byte(": connected\n\n")) != nil {
		return
	}
	st := &stream{events: make(chan event), done: make(chan struct{})}
	s.mu.Lock()
	if s.streams[id] == nil {
		s.streams[id] = map[*stream]bool{}
	}
	s.streams[id][st] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.streams[id], st)
		if len(s.streams[id]) == 0 {
			delete(s.streams, id)
		}
		s.mu.Unlock()
		close(st.done)
	}()
	if connected != nil {
		connected()
	}
	ping := time.NewTicker(Ping)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ctx.Done():
			return
		case e := <-st.events:
			err := write(e.data)
			e.written <- err
			if err != nil {
				return
			}
		case <-ping.C:
			if write([]byte(": ping\n\n")) != nil {
				return
			}
		}
	}
}

// Has is src/push.ts hasStream: whether the agent's shim is connected.
func (s *Streams) Has(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.streams[id]) > 0
}

// Push is src/push.ts streamPush: it writes {content, meta} to each of the agent's streams and reports whether at least
// one wrote it. False when the agent has no stream, or none wrote it within Timeout or before ctx ended.
func (s *Streams) Push(ctx context.Context, id, content string, meta map[string]string) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	var targets []*stream
	for st := range s.streams[id] {
		targets = append(targets, st)
	}
	s.mu.Unlock()
	if len(targets) == 0 {
		return false
	}
	data, err := json.Marshal(struct {
		Content string            `json:"content"`
		Meta    map[string]string `json:"meta"`
	}{content, meta})
	if err != nil {
		return false
	}
	frame := append(append([]byte("data: "), data...), '\n', '\n')
	delivered := false
	for _, st := range targets {
		if s.pushOne(ctx, st, frame) {
			delivered = true
		}
	}
	return delivered
}

func (s *Streams) pushOne(ctx context.Context, st *stream, frame []byte) bool {
	timer := time.NewTimer(Timeout)
	defer timer.Stop()
	e := event{data: frame, written: make(chan error, 1)}
	select {
	case st.events <- e:
	case <-st.done:
		return false
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
	// The stream took the event and reports its write. A write still blocked at the deadline (a client that stopped
	// reading) counts as undelivered: the prompt may then come twice, but is never lost.
	select {
	case err := <-e.written:
		return err == nil
	case <-timer.C:
		return false
	}
}

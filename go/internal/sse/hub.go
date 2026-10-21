// Package sse is the daemon's event stream hub (GET /api/live, src/events.ts; S-2614): one SSE connection per web
// client, a first `: connected` comment, a `: ping` every 25 s, and events fanned out to every client.
//
// Each client runs in its own request goroutine and nowhere else, so a disconnect or Close ends it and frees its slot;
// no goroutine outlives its request. A client that stops reading is dropped, as src/events.ts drops one past its
// 1 MiB cap: its queue is full, or a write takes longer than WriteTimeout.
package sse

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"stam/internal/jsjson"
)

const (
	// Keepalive is the ping cadence (src/events.ts, the layout stream's too).
	Keepalive = 25 * time.Second
	// WriteTimeout is the longest one write to a client may take before the client is dropped.
	WriteTimeout = 10 * time.Second
	// QueueSize is how many events wait for a client before it counts as stopped reading.
	QueueSize = 256
	// AgentCoalesce is how long `agent.changed` waits to gather a burst (src/events.ts AGENT_COALESCE_MS, S-456): at
	// most four a second per agent, the latest state only.
	AgentCoalesce = 250 * time.Millisecond
)

// ErrClosed is returned by Serve once the hub is closing.
var ErrClosed = errors.New("sse: hub closed")

// Hub fans events out to the connected clients. The zero value is not usable; call New.
type Hub struct {
	keepalive time.Duration

	mu      sync.Mutex
	clients map[*client]struct{}
	closed  bool
	done    chan struct{}
	wg      sync.WaitGroup

	// The `agent.changed` batch (AgentChanged), under mu: each agent's merged patch, in first-change order, and the
	// timer that flushes it.
	pending  map[string]*jsjson.Object
	order    []string
	flush    *time.Timer
	snapshot atomic.Pointer[AgentSnapshot]
}

// AgentSnapshot is an agent's state for `agent.changed`, read when the event flushes; nil for an agent it can't read.
type AgentSnapshot func(id string) *jsjson.Object

type client struct {
	queue chan []byte
	// dropped closes when Emit finds the queue full; the client's goroutine then ends.
	dropped  chan struct{}
	dropOnce sync.Once
}

func (c *client) drop() { c.dropOnce.Do(func() { close(c.dropped) }) }

// New returns a hub that pings every keepalive (Keepalive in the daemon; tests pass less).
func New(keepalive time.Duration) *Hub {
	return &Hub{keepalive: keepalive, clients: map[*client]struct{}{}, done: make(chan struct{})}
}

// Len is the number of connected clients.
func (h *Hub) Len() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

// Serve streams to one client until it disconnects, falls behind, or the hub closes. It writes the response headers
// itself; an error after that is the stream's end, not something to send.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request) error {
	c := &client{queue: make(chan []byte, QueueSize), dropped: make(chan struct{})}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return ErrClosed
	}
	h.clients[c] = struct{}{}
	h.wg.Add(1)
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
		h.wg.Done()
	}()

	rc := http.NewResponseController(w)
	// The deadline is the stream's; the connection may serve another request after it.
	defer rc.SetWriteDeadline(time.Time{})
	write := func(b []byte) error {
		// A deadline the writer doesn't support (a test recorder) is no error: the write just has none.
		_ = rc.SetWriteDeadline(time.Now().Add(WriteTimeout))
		if _, err := w.Write(b); err != nil {
			return err
		}
		return rc.Flush()
	}
	hdr := w.Header()
	hdr.Set("Content-Type", "text/event-stream")
	hdr.Set("Cache-Control", "no-cache")
	hdr.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	if err := write([]byte(": connected\n\n")); err != nil {
		return err
	}
	ping := time.NewTicker(h.keepalive)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return nil
		case <-h.done:
			return nil
		case <-c.dropped:
			return nil
		case b := <-c.queue:
			if err := write(b); err != nil {
				return err
			}
		case <-ping.C:
			if err := write([]byte(": ping\n\n")); err != nil {
				return err
			}
		}
	}
}

// Emit sends one event to every client, as `event: TYPE` then `data: JSON`. With no client connected it returns
// before marshalling, as src/events.ts does.
func (h *Hub) Emit(event string, data any) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.clients) == 0 || h.closed {
		return nil
	}
	if data == nil {
		data = struct{}{}
	}
	body, err := json.Marshal(data)
	if err != nil {
		return err
	}
	msg := []byte("event: " + event + "\ndata: " + string(body) + "\n\n")
	for c := range h.clients {
		select {
		case c.queue <- msg:
		default:
			c.drop()
		}
	}
	return nil
}

// SetAgentSnapshot sets what `agent.changed` carries for an agent (src/events.ts setAgentSnapshot); the daemon sets it.
func (h *Hub) SetAgentSnapshot(fn AgentSnapshot) { h.snapshot.Store(&fn) }

// AgentChanged queues `agent.changed` for the agent (src/events.ts agentChanged): a burst within AgentCoalesce sends one
// event, the snapshot at flush time with the burst's patches over it and then the id. With no client connected
// nothing is queued and no timer armed.
func (h *Hub) AgentChanged(id string, patch *jsjson.Object) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.clients) == 0 || h.closed {
		return
	}
	if h.pending == nil {
		h.pending = map[string]*jsjson.Object{}
	}
	p, ok := h.pending[id]
	if !ok {
		p = jsjson.NewObject()
		h.pending[id] = p
		h.order = append(h.order, id)
	}
	for _, k := range patch.Keys() {
		v, _ := patch.Get(k)
		p.Set(k, v)
	}
	if h.flush == nil {
		h.flush = time.AfterFunc(AgentCoalesce, h.flushAgents)
	}
}

// flushAgents sends the batch; every client may have gone since the timer was armed, and then it is dropped.
func (h *Hub) flushAgents() {
	h.mu.Lock()
	pending, order := h.pending, h.order
	h.pending, h.order, h.flush = nil, nil, nil
	gone := len(h.clients) == 0 || h.closed
	h.mu.Unlock()
	if gone {
		return
	}
	var snap AgentSnapshot
	if fn := h.snapshot.Load(); fn != nil {
		snap = *fn
	}
	for _, id := range order {
		ev := jsjson.NewObject()
		var base *jsjson.Object
		if snap != nil {
			base = snap(id)
		}
		for _, o := range []*jsjson.Object{base, pending[id]} {
			for _, k := range o.Keys() {
				v, _ := o.Get(k)
				ev.Set(k, v)
			}
		}
		ev.Set("id", id)
		_ = h.Emit("agent.changed", json.RawMessage(jsjson.Stringify(ev, "")))
	}
}

// PendingAgents is how many agents await a flush (src/events.ts pendingCount).
func (h *Hub) PendingAgents() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.pending)
}

// Close ends every stream and waits, until ctx ends, for their goroutines to return. Serve refuses new clients after.
func (h *Hub) Close(ctx context.Context) error {
	h.mu.Lock()
	if !h.closed {
		h.closed = true
		close(h.done)
		if h.flush != nil {
			h.flush.Stop()
			h.pending, h.order, h.flush = nil, nil, nil
		}
	}
	h.mu.Unlock()
	waited := make(chan struct{})
	go func() {
		h.wg.Wait()
		close(waited)
	}()
	select {
	case <-waited:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

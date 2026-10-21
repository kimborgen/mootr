package mcp

import (
	"bufio"
	"context"
	"strings"
	"time"

	"stam/internal/jsfmt"
)

// startStream starts, once, the bridge from the daemon's SSE stream for this agent to notifications/claude/channel. It
// reconnects forever, so a daemon restart doesn't cut the agent off. An agent with no id yet has none to stream.
func (s *Server) startStream() {
	if s.id() == "" {
		return
	}
	s.streamOnce.Do(func() {
		go func() {
			for s.streamCtx.Err() == nil {
				s.streamOnceRun(s.streamCtx)
				select {
				case <-s.streamCtx.Done():
				case <-time.After(reconnectEvery):
				}
			}
		}()
	})
}

// streamOnceRun reads one connection's events until it ends or fails.
func (s *Server) streamOnceRun(ctx context.Context) {
	body, err := s.api.Stream(ctx, "/api/agents/"+s.id()+"/stream")
	if err != nil {
		return
	}
	defer body.Close()
	r := bufio.NewReaderSize(body, 1<<20)
	var data []string
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimSuffix(line, "\n")
		if line != "" {
			if d, ok := strings.CutPrefix(line, "data: "); ok {
				data = append(data, d)
			}
			continue
		}
		// A blank line ends the event.
		if len(data) > 0 {
			s.channel(strings.Join(data, "\n"))
		}
		data = nil
	}
}

// channel turns one event's data, {content, meta}, into a notification.
func (s *Server) channel(data string) {
	v, err := jsfmt.Parse([]byte(data))
	if err != nil {
		return
	}
	params := "{"
	sep := ""
	for _, k := range []string{"content", "meta"} {
		if m, ok := v.Get(k); ok {
			params += sep + jsfmt.Quote(k) + ":" + jsfmt.Compact(m)
			sep = ","
		}
	}
	s.send(`{"jsonrpc":"2.0","method":"notifications/claude/channel","params":` + params + `}}`)
}

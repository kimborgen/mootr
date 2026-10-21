package server

import (
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"stam/internal/api"
	"stam/internal/auth"
	"stam/internal/sse"
)

// health is GET /api/health (api/schemas/Health.yaml). `memory` is the Go runtime's, under the names the TS daemon's
// process.memoryUsage() uses: heapUsed the live heap, heapTotal the heap the runtime holds, rss from /proc, and
// external 0 (Go has no off-heap buffers to count). `stalls` stays empty: the Go daemon has no event loop to stall.
func (s *Server) health(_ *http.Request, _ auth.Resolved) (any, error) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	body := api.Health{Ok: true, Machine: s.cfg.Machine}
	if s.cfg.Release != "" {
		body.Release = &s.cfg.Release
	}
	body.Memory.HeapUsed = int(m.HeapAlloc)
	body.Memory.HeapTotal = int(m.HeapSys)
	body.Memory.Rss = rss(m.Sys)
	body.Stalls = []struct {
		At    time.Time `json:"at"`
		Label string    `json:"label"`
		Ms    int       `json:"ms"`
	}{}
	return body, nil
}

// rss is the process's resident set from /proc/self/statm, or fallback where there is no /proc.
func rss(fallback uint64) int {
	b, err := os.ReadFile("/proc/self/statm")
	if err == nil {
		if f := strings.Fields(string(b)); len(f) > 1 {
			if pages, err := strconv.Atoi(f[1]); err == nil {
				return pages * os.Getpagesize()
			}
		}
	}
	return int(fallback)
}

// live is GET /api/live, the daemon's event stream (src/events.ts). It carries every agent's mail headers and ITSA
// changes, so an agent's token can't read it (S-587).
func (s *Server) live(w http.ResponseWriter, r *http.Request, c auth.Resolved) error {
	if msg := auth.NotAgentToken(c.Caller, "read the daemon event stream"); msg != "" {
		return Errorf(http.StatusForbidden, "%s", msg)
	}
	if err := s.hub.Serve(w, r); err == sse.ErrClosed {
		return Errorf(http.StatusServiceUnavailable, "the daemon is stopping")
	}
	return nil
}

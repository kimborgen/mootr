package server

import (
	"context"
	"net/http"
	"time"

	"stam/internal/linearpoll"
)

// The Linear event source (src/sources/linear.ts, S-4331): the poller, and the dashboard's view of the issues it polls
// (GET /api/watch/state answers a `linear:` subject from it).
//
// The poller reads the bearer from the daemon's own login store (s.mcp), so no harness and no command line holds it. Its
// MCP calls stay on this daemon: a peer without the login leases a bearer from the settings home, as the MCP proxy does.

func (s *Server) linearStore() linearpoll.DBStore { return linearpoll.DBStore{DB: s.db, Svc: s.events} }

func (s *Server) newLinearPoller() *linearpoll.Poller {
	w := s.settings.Get().WatchLinear
	return linearpoll.New(linearpoll.Options{
		Store:  s.linearStore(),
		Client: linearpoll.NewClient(s.mcp, &http.Client{}),
		Tools: func() linearpoll.Tools {
			t := s.settings.Get().WatchLinear
			return linearpoll.Tools{Issue: t.Issue, Comments: t.Comments, TeamIssues: t.TeamIssues}
		},
		Interval: time.Duration(w.Seconds * float64(time.Second)),
	})
}

// startLinear starts the poller (src/daemon.ts at start); 0 seconds in watch.linearSeconds disables it. StartEvents stops it
// before the event service it ingests into.
func (s *Server) startLinear(ctx context.Context) {
	s.linear = s.newLinearPoller()
	s.linear.Start(ctx)
}

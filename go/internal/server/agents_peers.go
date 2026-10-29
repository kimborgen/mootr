package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/url"

	"stam/internal/api"
	"stam/internal/db"
	"stam/internal/jsfmt"
)

// peerAgents is the peers' part of GET /api/agents (src/daemon.ts): the same path and query asked of every peer that
// answers, the rows kept by this request's filter (a peer that ignores `state` or `ids` is filtered here too) and
// remembered here (S-235). A row whose id an agent here has is left out. A peer that is down adds nothing, as in TS. Each row keeps what its own daemon computed but its
// spawn brief (null, as here) and cost_raw, which only this daemon's own request carries; the cost mode and the human's
// default view are this daemon's.
func (s *Server) peerAgents(ctx context.Context, u *url.URL, keep func(db.Agent) bool, mine map[string]bool, mode api.AgentCostMode, views map[string]string) []api.Agent {
	path := u.EscapedPath()
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	rows := s.peers.FanOut(ctx, path, nil)
	out := []api.Agent{}
	var kept []jsfmt.Value
	for _, row := range rows {
		var a api.Agent
		if err := json.Unmarshal([]byte(jsfmt.Compact(row)), &a); err != nil || a.Id == "" {
			// A row this daemon can't read is left out, never guessed at; the log names the agent, not the row.
			slog.Warn("agents: a peer's row is not an agent", "id", row.Text("id"), "err", err)
			continue
		}
		// An id an agent here has is that agent's: the web keys agents by id, so a peer's row would replace it. Any agent
		// here counts, not only those this request lists.
		if mine[a.Id] || !keep(db.Agent{ID: a.Id, Name: a.Name, Lifecycle: a.Lifecycle}) {
			continue
		}
		kept = append(kept, row)
		a.FirstPrompt = nil
		a.CostRaw = nil
		a.Cost.Mode = mode
		a.Cost.Own.Subscription = nil
		a.Cost.Tree.Subscription = nil
		a.DefaultView = nil
		if v, ok := views[a.Id]; ok {
			dv := api.AgentDefaultView(v)
			a.DefaultView = &dv
		}
		out = append(out, a)
	}
	s.peers.Remember(ctx, s.db, kept)
	return out
}

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"stam/internal/auth"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// usageReadings is GET /api/usage/readings (src/daemon.ts): this machine's own subscription windows per configured
// account, which a peer reads to clear its window blockers (src/peer-readings.ts, S-2367). Only a peer may read it.
func (s *Server) usageReadings(r *http.Request, c auth.Resolved) (any, error) {
	if !c.Local {
		return nil, Errorf(http.StatusForbidden, "only a peer can read readings")
	}
	if s.life == nil {
		return struct{}{}, nil
	}
	out, err := s.life.ServedReadings(r.Context())
	if err != nil {
		return nil, err
	}
	return json.RawMessage(jsjson.Stringify(out, "")), nil
}

// usageSpend is GET /api/usage/spend (src/daemon.ts, src/peer-spend.ts serve): this machine's paid totals by period,
// which the other daemons add to their budgets (S-395). Only a peer may read it.
func (s *Server) usageSpend(r *http.Request, c auth.Resolved) (any, error) {
	if !c.Local {
		return nil, Errorf(http.StatusForbidden, "only a peer can read spend")
	}
	if s.life == nil {
		return struct{}{}, nil
	}
	out, err := s.life.LocalSpend(r.Context(), time.Now())
	if err != nil {
		return nil, err
	}
	return json.RawMessage(jsjson.Stringify(out, "")), nil
}

// decideHeld is why the decision model's call through the provider may not run, its system budget spent (src/budgets.ts
// providerHeld); "" with no lifecycle.
func (s *Server) decideHeld(provider string) string {
	if s.life == nil {
		return ""
	}
	return s.life.ProviderHeld(context.Background(), provider, time.Now())
}

// ledgerChanged has the budgets evaluated after the decision model's spend (src/budgets.ts ledgerChanged).
func (s *Server) ledgerChanged() {
	if s.life != nil {
		s.life.LedgerChanged("")
	}
}

// peerReadings is how the cost rules poll the peers' windows (lifecycle.PeerReadings), through the peers client.
type peerReadings struct{ s *Server }

func (p peerReadings) Peers() []string {
	var out []string
	for _, peer := range p.s.peers.Peers() {
		out = append(out, peer.Name)
	}
	return out
}

func (p peerReadings) Readings(ctx context.Context, name string) (int, []byte, error) {
	peer, ok := p.s.peers.ByName(name)
	if !ok {
		return 0, nil, fmt.Errorf("no peer %s", name)
	}
	reply, err := p.s.peers.Poll(ctx, peer, "/api/usage/readings", 4*time.Second)
	if err != nil {
		return 0, nil, err
	}
	return reply.Status, []byte(jsfmt.Compact(reply.Data)), nil
}

// Spend is one peer's GET /api/usage/spend, for the budgets (lifecycle.PeerSpend).
func (p peerReadings) Spend(ctx context.Context, name string) (int, []byte, error) {
	peer, ok := p.s.peers.ByName(name)
	if !ok {
		return 0, nil, fmt.Errorf("no peer %s", name)
	}
	reply, err := p.s.peers.Poll(ctx, peer, "/api/usage/spend", 4*time.Second)
	if err != nil {
		return 0, nil, err
	}
	return reply.Status, []byte(jsfmt.Compact(reply.Data)), nil
}

package server

import (
	"context"
	"time"

	"stam/internal/jsjson"
)

// snapshotTimeout bounds the reads behind one agent's `agent.changed`.
const snapshotTimeout = 5 * time.Second

// wireLive connects the database's agent changes to the live stream (src/db.ts updateAgent's events calls, src/daemon.ts
// setAgentSnapshot): a lifecycle or activity change queues `agent.changed`, and a change to archived also sends
// `agent.archived` {id} at once.
func (s *Server) wireLive() {
	s.hub.SetAgentSnapshot(s.agentSnapshot)
	s.db.ObserveAgents(func(id string, archived bool) {
		if archived {
			_ = s.hub.Emit("agent.archived", map[string]string{"id": id})
		}
		s.hub.AgentChanged(id, nil)
	})
}

// agentSnapshot is what `agent.changed` carries for an agent: its lifecycle as state, activity, context size, total
// spend and unread mail; nil when it can't be read.
func (s *Server) agentSnapshot(id string) *jsjson.Object {
	ctx, cancel := context.WithTimeout(context.Background(), snapshotTimeout)
	defer cancel()
	a, err := s.db.GetAgent(ctx, id)
	if err != nil {
		return nil
	}
	cost, err := s.db.AgentCost(ctx, id)
	if err != nil {
		return nil
	}
	unread, err := s.db.UnreadCount(ctx, id)
	if err != nil {
		return nil
	}
	var tokens jsjson.Value
	if a.ContextTokens != nil {
		tokens = float64(*a.ContextTokens)
	}
	return jsjson.NewObject("state", string(a.Lifecycle), "activity", string(a.Activity), "context_tokens", tokens, "cost_usd", cost,
		"unread", float64(unread))
}

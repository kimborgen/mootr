package server

import (
	"net/http"
	"strings"

	"stam/internal/api"
	"stam/internal/auth"
	"stam/internal/db"
)

// listAgents is GET /api/agents (src/daemon.ts): every agent here with the web tree's extras, each extra one grouped
// read for the whole list. `q` keeps the agents matching it, `role` those whose role or name contains it, standing
// agents first.
//
// Ported: parents, unread, cost_usd, pending_requests, chief_of_staff, view, default_view, waits. Placeholders until
// their modules are ported, shaped to the schema: cost (zero in every unit), cost_raw (empty, to a peer), blockers
// (empty), resting (null), in_itsa (true, as TS answers when the ITSA home can't be asked), and load (zero but its
// context_tokens). Not ported: the peers' agents (no fan-out yet), and `as`, which is refused with a 501 rather than
// answered unscoped.
func (s *Server) listAgents(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	q := r.URL.Query()
	// TS reads an empty as= as absent, except from an agent (resolveActors makes it the agent itself) or the OpenCode
	// server (a 403): those still get the 501.
	if q.Get("as") != "" || (q.Has("as") && c.IsAgent()) {
		return nil, Errorf(http.StatusNotImplemented, "as= is not ported to the Go daemon yet")
	}
	all, err := s.db.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	listed := all
	if text := q.Get("q"); text != "" {
		if listed, err = s.db.SearchAgents(ctx, text); err != nil {
			return nil, err
		}
	}
	extra, err := s.db.ExtraParents(ctx)
	if err != nil {
		return nil, err
	}
	unread, err := s.db.UnreadCounts(ctx)
	if err != nil {
		return nil, err
	}
	cost, err := s.db.CostByAgent(ctx)
	if err != nil {
		return nil, err
	}
	pending, err := s.db.PendingHumanRequests(ctx)
	if err != nil {
		return nil, err
	}
	views, err := s.db.AgentViews(ctx)
	if err != nil {
		return nil, err
	}
	byAgent, err := s.db.WaitsByAgent(ctx)
	if err != nil {
		return nil, err
	}
	waits, err := s.webWaits(ctx, byAgent)
	if err != nil {
		return nil, err
	}
	set := s.settings.Get()
	mode := api.AgentCostMode(set.CostMode)
	out := make([]api.Agent, 0, len(listed))
	for _, a := range listed {
		pub := publicAgent(a)
		pub.Parents = parentsOf(a, extra[a.ID])
		pub.Unread = unread[a.ID]
		pub.CostUsd = cost[a.ID]
		pub.Cost = api.AgentCost{Mode: mode}
		if c.Local {
			pub.CostRaw = &api.AgentRaw{Own: map[string]api.AgentRawAccount{}, Tree: map[string]api.AgentRawAccount{}}
		}
		pub.PendingRequests = pending[a.ID]
		pub.ChiefOfStaff = set.ChiefOfStaff != "" && (set.ChiefOfStaff == a.Name || set.ChiefOfStaff == a.ID)
		pub.Blockers = []api.AgentBlocker{}
		pub.Waits = waits[a.ID]
		if pub.Waits == nil {
			pub.Waits = []api.AgentWait{}
		}
		pub.InItsa = true
		pub.View = viewOf(a)
		if a.Standing != 0 && a.Lifecycle != "archived" {
			pub.Load = &api.AgentLoad{ContextTokens: a.ContextTokens}
		}
		if v, ok := views[a.ID]; ok {
			dv := api.AgentDefaultView(v)
			pub.DefaultView = &dv
		}
		out = append(out, pub)
	}
	if q.Has("role") {
		out = byRole(out, q.Get("role"))
	}
	return out, nil
}

// publicAgent is the agents row as the api sends it (src/agent-public.ts publicAgent): every column but token_hash.
func publicAgent(a db.Agent) api.Agent {
	return api.Agent{
		Id:                    a.ID,
		Name:                  a.Name,
		Role:                  a.Role,
		Machine:               a.Machine,
		Harness:               a.Harness,
		Model:                 a.Model,
		Effort:                a.Effort,
		Cwd:                   a.Cwd,
		ParentId:              a.ParentID,
		SessionId:             a.SessionID,
		TranscriptPath:        a.TranscriptPath,
		Lifecycle:             a.Lifecycle,
		Activity:              a.Activity,
		ActivityDetail:        a.ActivityDetail,
		ContextTokens:         a.ContextTokens,
		ContextWindow:         a.ContextWindow,
		Workspace:             a.Workspace,
		PersonalWorkspace:     a.PersonalWorkspace,
		Standing:              a.Standing,
		PendingAction:         a.PendingAction,
		IdleSince:             a.IdleSince,
		IdleNotified:          a.IdleNotified,
		ContextLevel:          a.ContextLevel,
		TokensAfterCompaction: a.TokensAfterCompaction,
		Capabilities:          a.Capabilities,
		PermissionMode:        a.PermissionMode,
		PermissionSource:      a.PermissionSource,
		Visibility:            a.Visibility,
		ChildNotices:          a.ChildNotices,
		LastMessage:           a.LastMessage,
		FirstPrompt:           a.FirstPrompt,
		UsageLast:             a.UsageLast,
		Kind:                  a.Kind,
		Type:                  a.Type,
		PausedBy:              a.PausedBy,
		ForwardedTo:           a.ForwardedTo,
		CreatedAt:             a.CreatedAt,
		UpdatedAt:             a.UpdatedAt,
	}
}

// parentsOf is src/db.ts parentsByChild for one agent: parent_id first, then agent_parents, each once.
func parentsOf(a db.Agent, extra []string) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(p string) {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	if a.ParentID != nil && *a.ParentID != "" {
		add(*a.ParentID)
	}
	for _, p := range extra {
		add(p)
	}
	return out
}

type viewCaps = struct {
	CanApprove   bool `json:"can_approve"`
	CanInterrupt bool `json:"can_interrupt"`
	CanSend      bool `json:"can_send"`
	CanStream    bool `json:"can_stream"`
}

// viewOf is src/agent-view.ts capabilities: what stam's own view of the agent offers, from its harness's view source
// (src/adapters/*-view.ts), or nil when the harness has none or the agent has no session to show yet.
func viewOf(a db.Agent) *viewCaps {
	set := func(p *string) bool { return p != nil && *p != "" }
	switch a.Harness {
	case "claude":
		if set(a.TranscriptPath) {
			return &viewCaps{CanSend: true, CanInterrupt: true}
		}
	case "codex", "opencode":
		if set(a.SessionID) {
			return &viewCaps{CanStream: true, CanSend: true, CanInterrupt: true, CanApprove: true}
		}
	}
	return nil
}

// byRole is src/db.ts agentsByRole: the agents whose role or name contains role (case-insensitive; empty keeps all),
// standing agents first, the order kept within each group.
func byRole(list []api.Agent, role string) []api.Agent {
	q := strings.ToLower(strings.TrimSpace(role))
	standing, rest := []api.Agent{}, []api.Agent{}
	for _, a := range list {
		if q != "" && !strings.Contains(strings.ToLower(a.Role+"\n"+a.Name), q) {
			continue
		}
		if a.Standing != 0 {
			standing = append(standing, a)
		} else {
			rest = append(rest, a)
		}
	}
	return append(standing, rest...)
}

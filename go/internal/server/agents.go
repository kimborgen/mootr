package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"stam/internal/api"
	"stam/internal/auth"
	"stam/internal/db"
)

// listAgents is GET /api/agents (src/daemon.ts): every agent here with the web tree's extras, each extra one grouped
// read for the whole list. `q` keeps the agents matching it, `role` those whose role or name contains it, standing
// agents first. Without `state` or `ids` it lists live agents only (S-3816): `state` is a comma list of listStates, and
// `ids` (ids or names) adds those agents in any state. Each row sends first_prompt as null (S-3808). `as` keeps the
// agents that agent may see (visibleTo).
//
// Ported: parents, unread, cost_usd, pending_requests, chief_of_staff, view, default_view, waits, open_ask (S-4021). Placeholders until
// their modules are ported, shaped to the schema: cost (zero in every unit), cost_raw (empty, to a peer), resting (null), in_itsa (true, as TS answers when the ITSA home can't be asked), and load (zero but its
// context_tokens). The peers' agents follow this daemon's (peerAgents).
func (s *Server) listAgents(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	q := r.URL.Query()
	keep := listFilter(q)
	if keep == nil {
		return nil, Errorf(http.StatusBadRequest, "state is a comma list of %s", strings.Join(listStates, ", "))
	}
	listed, err := s.db.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	// Every agent here, whatever the filter keeps: a peer's row never stands in for one (peerAgents).
	mine := make(map[string]bool, len(listed))
	for _, a := range listed {
		mine[a.ID] = true
	}
	if text := q.Get("q"); text != "" {
		if listed, err = s.db.SearchAgents(ctx, text); err != nil {
			return nil, err
		}
	}
	kept := listed[:0:0]
	for _, a := range listed {
		if keep(a) {
			kept = append(kept, a)
		}
	}
	listed = kept
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
	blockers, err := s.db.BlockersByAgent(ctx)
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
	held, err := s.heldItsas(ctx)
	if err != nil {
		return nil, err
	}
	askOf, _, err := s.openAskLinks(ctx, held)
	if err != nil {
		return nil, err
	}
	set := s.settings.Get()
	mode := api.AgentCostMode(set.CostMode)
	out := make([]api.Agent, 0, len(listed))
	for _, a := range listed {
		pub := publicAgent(a)
		// The whole spawn brief, never read from the list; the detail route keeps it (src/agent-public.ts listedAgent).
		pub.FirstPrompt = nil
		pub.Parents = parentsOf(a, extra[a.ID])
		pub.Unread = unread[a.ID]
		pub.CostUsd = cost[a.ID]
		pub.Cost = api.AgentCost{Mode: mode}
		if c.Local {
			pub.CostRaw = &api.AgentRaw{Own: map[string]api.AgentRawAccount{}, Tree: map[string]api.AgentRawAccount{}}
		}
		pub.PendingRequests = pending[a.ID]
		pub.ChiefOfStaff = set.ChiefOfStaff != "" && (set.ChiefOfStaff == a.Name || set.ChiefOfStaff == a.ID)
		pub.Blockers = apiBlockers(blockers[a.ID])
		pub.Waits = waits[a.ID]
		if pub.Waits == nil {
			pub.Waits = []api.AgentWait{}
		}
		// The open ask this agent waits on (S-3977, S-3982): its key, and the mail and kind of it, never the ask's text.
		if ask, ok := askOf[a.ID]; ok {
			key := ask.Text("key")
			pub.OpenAsk = &key
			detail := &struct {
				Kind api.AgentOpenAskDetailKind `json:"kind"`
				Mail *string                    `json:"mail"`
			}{Kind: api.AgentOpenAskDetailKind(askKindLabel[ask.Text("kind")])}
			if mail := ask.Text("thread_id"); mail != "" {
				detail.Mail = &mail
			}
			pub.OpenAskDetail = detail
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
	// The peers' agents join the list, unless a peer asks (its own list only); each carries its own daemon's extras.
	if !c.Local {
		out = append(out, s.peerAgents(ctx, r.URL, keep, mine, mode, views)...)
	}
	// resolveQuery has already made `as` the identity the caller may act as (an agent's token is itself).
	if viewer := q.Get("as"); viewer != "" {
		if out, err = s.visibleTo(ctx, viewer, out); err != nil {
			return nil, err
		}
	}
	if q.Has("role") {
		out = byRole(out, q.Get("role"))
	}
	return out, nil
}

// visibleTo is src/org.ts visibleTo: the rows an agent may see, under its visibility rules. An agent with the registry,
// or a viewer that isn't an agent here, sees them all; otherwise itself, those it may reach, the chief of staff, and
// with reach 'tree' its children on other machines, which only the list holds.
func (s *Server) visibleTo(ctx context.Context, viewer string, list []api.Agent) ([]api.Agent, error) {
	a, err := s.db.GetAgent(ctx, viewer)
	if errors.Is(err, db.ErrNotFound) {
		return list, nil
	}
	if err != nil {
		return nil, err
	}
	v := a.VisibilityOf()
	if v.Registry {
		return list, nil
	}
	allowed, _, err := s.reachable(ctx, a)
	if err != nil {
		return nil, err
	}
	cos := s.chiefOfStaffID(ctx)
	out := []api.Agent{}
	for _, x := range list {
		if x.Id == a.ID || allowed[x.Id] || (cos != "" && x.Id == cos) || (v.Reach == "tree" && x.ParentId != nil && *x.ParentId == a.ID) {
			out = append(out, x)
		}
	}
	return out, nil
}

// listStates are the lifecycle groups GET /api/agents can list (src/agent-public.ts LIST_STATES): live is active or
// paused, stopped is shut down.
var listStates = []string{"live", "stopped", "archived", "all"}

var listGroup = map[string]string{"active": "live", "paused": "live", "shut_down": "stopped", "archived": "archived"}

// listFilter is src/agent-public.ts listFilter: which agents the list keeps, from `state` and `ids`. Without `state` (or
// with it empty) it keeps live agents, or only the `ids` when they are given. Nil for a state it doesn't know.
func listFilter(q url.Values) func(db.Agent) bool {
	split := func(s string) map[string]bool {
		out := map[string]bool{}
		for _, p := range strings.Split(s, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out[p] = true
			}
		}
		return out
	}
	want := split(q.Get("ids"))
	state := q.Get("state")
	if state == "" && !q.Has("ids") {
		state = "live"
	}
	groups := split(state)
	for g := range groups {
		if !slices.Contains(listStates, g) {
			return nil
		}
	}
	return func(a db.Agent) bool {
		return groups["all"] || groups[listGroup[string(a.Lifecycle)]] || want[a.ID] || want[a.Name]
	}
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
		LaunchedAt:            a.LaunchedAt,
		ResumedAt:             a.ResumedAt,
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

// apiBlockers is the agent's blockers as src/blockers.ts gives them, the clear condition parsed; never nil. The
// generated type holds the clear as a map, so its keys come out sorted, as every field of this list does: it matches
// TS by value. GET /api/agents/:id keeps TS's order (blockerOut).
func apiBlockers(rows []db.Blocker) []api.AgentBlocker {
	out := make([]api.AgentBlocker, 0, len(rows))
	for _, b := range rows {
		ab := api.AgentBlocker{AgentId: b.AgentID, Kind: api.AgentBlockerKind(b.Kind), Account: b.Account, Reason: b.Reason, Since: b.Since}
		if b.Clear != nil {
			var clear map[string]any
			if json.Unmarshal([]byte(*b.Clear), &clear) == nil && clear != nil {
				ab.Clear = &clear
			}
		}
		out = append(out, ab)
	}
	return out
}

package mcp

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"strings"
	"time"

	"stam/internal/jsfmt"
)

// The agent tools of src/mcp.ts (S-4057, S-4085): workspace_share, find_agents, registry_info, spawn_agent, agent_control, compact_self and
// reconnect_mcp. The daemon judges who may and what the caller sees (GET /api/agents with `as` is filtered by its
// visibility); these send what the TS tools send and say what they say.

// remoteSpawn is how long a spawn on another machine may wait for that peer to start and deploy (S-234, S-236).
const remoteSpawn = 960 * time.Second

// errNoAgentName is the TypeError TS throws for `r.agent.name` when the reply has no agent, as after a forget.
var errNoAgentName = errors.New("Cannot read properties of undefined (reading 'name')")

func init() {
	tools = append(tools,
		tool{name: "workspace_share", listing: agentListings["workspace_share"], run: workspaceShare},
		tool{name: "find_agents", listing: agentListings["find_agents"], run: findAgents},
		tool{name: "registry_info", listing: agentListings["registry_info"], run: registryInfo},
		tool{name: "spawn_agent", listing: agentListings["spawn_agent"], run: spawnAgent},
		tool{name: "agent_control", listing: agentListings["agent_control"], run: agentControl},
		tool{name: "compact_self", listing: agentListings["compact_self"], run: compactSelf},
		tool{name: "reconnect_mcp", listing: agentListings["reconnect_mcp"], run: reconnectMCP},
	)
}

// copyMember sets out[to] to x[from] when x has it: `{to: x.from}`, which JSON.stringify leaves out when undefined.
func copyMember(out *jsfmt.Value, x jsfmt.Value, to, from string) {
	if v, ok := x.Get(from); ok {
		out.Set(to, v)
	}
}

// truthy is `!!x.k`.
func truthy(x jsfmt.Value, k string) bool {
	v, ok := x.Get(k)
	return ok && v.Truthy()
}

// nonEmpty is `x.k?.length`: an array with items.
func nonEmpty(x jsfmt.Value, k string) bool {
	v, ok := x.Get(k)
	return ok && v.Kind == jsfmt.Array && len(v.Items) > 0
}

// parseJSONMember is `x.k ? JSON.parse(x.k) : fallback`.
func parseJSONMember(x jsfmt.Value, k string, fallback jsfmt.Value) (jsfmt.Value, error) {
	v, ok := x.Get(k)
	if !ok || !v.Truthy() {
		return fallback, nil
	}
	p, err := jsfmt.Parse([]byte(jsString(v)))
	if err != nil {
		return jsfmt.Value{}, fmt.Errorf("%s isn't JSON", k)
	}
	return p, nil
}

// basename is node's path.basename: the last segment, trailing slashes ignored.
func basename(p string) string {
	p = strings.TrimRight(p, "/")
	return p[strings.LastIndex(p, "/")+1:]
}

func findAgents(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	query, hasQuery := a.Get("query")
	state, _ := a.Get("state")
	var q params
	if hasQuery && query.Truthy() {
		q.set("q", jsString(query))
	}
	if truthy(a, "role") {
		q.set("role", a.Text("role"))
	}
	// agentId ?? a.self
	if me := s.id(); me != "" {
		q.set("as", me)
	} else if truthy(a, "self") {
		q.set("as", a.Text("self"))
	}
	// The daemon lists only what is asked for (S-3816); the filter below still decides, for a daemon that lists all.
	stateText := jsString(state)
	switch {
	case state.Kind == jsfmt.String && stateText == "all":
		q.set("state", "all")
	case state.Kind == jsfmt.String && stateText == "archived":
		q.set("state", "archived")
	default:
		q.set("state", "live,stopped")
	}
	if !state.Truthy() && hasQuery && query.Truthy() {
		q.set("ids", jsString(query))
	}
	list, err := s.apiJSON(ctx, "GET", "/api/agents?"+q.String(), nil)
	if err != nil {
		return "", err
	}
	out := []jsfmt.Value{}
	for _, x := range list.Items {
		archived := x.Text("lifecycle") == "archived"
		if state.Truthy() {
			if !(stateText == "all" && state.Kind == jsfmt.String) && (stateText == "archived" && state.Kind == jsfmt.String) != archived {
				continue
			}
		} else if archived && !(hasQuery && query.Truthy() && query.Kind == jsfmt.String && (x.Text("id") == query.Str || x.Text("name") == query.Str)) {
			continue
		}
		row, err := agentRow(x)
		if err != nil {
			return "", err
		}
		out = append(out, row)
	}
	return jsfmt.Stringify(jsfmt.ArrayValue(out)), nil
}

// agentRow is one find_agents entry, built member by member as the TS object literal builds it.
func agentRow(x jsfmt.Value) (jsfmt.Value, error) {
	r := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range []string{"id", "name", "role"} {
		copyMember(&r, x, k, k)
	}
	if t, ok := x.Get("type"); ok && t.Kind != jsfmt.Null {
		r.Set("type", t)
	} else {
		r.Set("type", jsfmt.NullValue())
	}
	for _, k := range []string{"harness", "model", "machine"} {
		copyMember(&r, x, k, k)
	}
	caps, err := parseJSONMember(x, "capabilities", jsfmt.NullValue())
	if err != nil {
		return r, err
	}
	r.Set("capabilities", caps)
	resting := truthy(x, "resting")
	switch {
	case resting:
		r.Set("state", jsfmt.StringValue("resting"))
	case x.Text("lifecycle") == "active":
		copyMember(&r, x, "state", "activity")
	default:
		copyMember(&r, x, "state", "lifecycle")
	}
	if resting {
		rest, _ := x.Get("resting")
		v := jsfmt.Value{Kind: jsfmt.Object}
		copyMember(&v, rest, "reason", "reason")
		copyMember(&v, rest, "expected_wake", "expected_wake")
		r.Set("resting", v)
	}
	if truthy(x, "standing") {
		r.Set("standing", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	}
	if truthy(x, "personal_workspace") {
		pw, _ := x.Get("personal_workspace")
		r.Set("personal_workspace", pw)
		r.Set("workspace", jsfmt.StringValue(basename(jsString(pw))))
	}
	if truthy(x, "standing") && truthy(x, "load") {
		copyMember(&r, x, "load", "load")
	}
	blocked := nonEmpty(x, "blockers")
	if x.Text("lifecycle") == "paused" && !resting {
		by, err := parseJSONMember(x, "paused_by", jsfmt.ArrayValue(nil))
		if err != nil {
			return r, err
		}
		// [...parsed, ...(blockers ? ['stam'] : [])]
		items := append([]jsfmt.Value{}, by.Items...)
		if blocked {
			items = append(items, jsfmt.StringValue("stam"))
		}
		r.Set("paused_by", jsfmt.ArrayValue(items))
	}
	if nonEmpty(x, "waits") {
		ws, _ := x.Get("waits")
		r.Set("waits", pickEach(ws, "id", "kind", "target", "detail", "since", "until"))
	}
	// The open ask this agent waits on: its mail to open it in, and its kind (S-3982). Never the ask's text.
	if truthy(x, "open_ask_detail") {
		copyMember(&r, x, "open_ask", "open_ask_detail")
	}
	if blocked {
		bs, _ := x.Get("blockers")
		r.Set("blockers", pickEach(bs, "kind", "account", "reason", "since", "clear"))
	}
	return r, nil
}

// pickEach is `list.map((w) => ({k: w.k, ...}))`.
func pickEach(list jsfmt.Value, keys ...string) jsfmt.Value {
	items := make([]jsfmt.Value, len(list.Items))
	for i, w := range list.Items {
		items[i] = pick(w, keys...)
	}
	return jsfmt.ArrayValue(items)
}

func registryInfo(ctx context.Context, s *Server, _ jsfmt.Value) (string, error) {
	r, err := s.apiJSON(ctx, "GET", "/api/registry", nil)
	if err != nil {
		return "", err
	}
	return jsfmt.Stringify(r), nil
}

// machine is src/config.ts MACHINE: STAM_MACHINE, else the hostname.
func (s *Server) machine() string {
	if m := s.env("STAM_MACHINE"); m != "" {
		return m
	}
	h, _ := os.Hostname()
	return h
}

func spawnAgent(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	by, err := s.me(a)
	if err != nil {
		return "", err
	}
	// parent: undefined → you, "none" → null, else as given.
	parent := jsfmt.StringValue(by)
	if p, ok := a.Get("parent"); ok {
		parent = p
		if p.Kind == jsfmt.String && p.Str == "none" {
			parent = jsfmt.NullValue()
		}
	}
	// { ...a, self: undefined, by, parent, cwd: a.cwd ?? process.cwd() }
	body := jsfmt.Value{Kind: jsfmt.Object}
	for i, k := range a.Keys {
		if k != "self" {
			body.Set(k, a.Items[i])
		}
	}
	body.Set("by", jsfmt.StringValue(by))
	body.Set("parent", parent)
	if c, ok := a.Get("cwd"); ok && c.Kind != jsfmt.Null {
		body.Set("cwd", c)
	} else {
		cwd, err := s.cwd()
		if err != nil {
			return "", err
		}
		body.Set("cwd", jsfmt.StringValue(cwd))
	}
	var timeout time.Duration
	if m, ok := a.Get("machine"); ok && (m.Kind != jsfmt.String || m.Str != s.machine()) {
		timeout = remoteSpawn
	}
	r, err := s.apiJSONTimeout(ctx, "POST", "/api/agents", raw(body), timeout)
	if err != nil {
		return "", err
	}
	if r.Text("kind") == "ring" {
		ms, _ := r.Get("members")
		names := make([]string, len(ms.Items))
		for i, m := range ms.Items {
			names[i] = member(m, "name") + " (" + typeOrNone(m) + ")"
		}
		ring, _ := r.Get("ring")
		out := fmt.Sprintf("Started ring %s (%s, %s, up to %s rounds). Members: %s.", member(ring, "name"), member(ring, "id"),
			member(ring, "format"), member(ring, "max_rounds"), strings.Join(names, ", "))
		if truthy(r, "moderator") {
			mod, _ := r.Get("moderator")
			out += fmt.Sprintf(" Moderator: %s (%s).", member(mod, "name"), typeOrNone(mod))
		}
		return out + " You'll get its result by mail.", nil
	}
	if truthy(r, "queued") {
		urgent := ""
		if truthy(r, "urgent") {
			urgent = " (urgent: " + member(r, "urgent") + ")"
		}
		return fmt.Sprintf("Queued %s: place %s of %s%s for a developer slot on %s, all %s in use. Holders: %s. It starts by itself when a slot frees, and you get a notice then (or if it fails to start). Do not spawn it again.",
			member(r, "name"), member(r, "place"), member(r, "queue_length"), urgent, member(r, "machine"), member(r, "cap"), holdersText(r)), nil
	}
	onPr := ""
	if w, ok := r.Get("workspace"); ok && w.Kind == jsfmt.String && w.Str != "" {
		if wt, err := jsfmt.Parse([]byte(w.Str)); err == nil {
			tree, _ := wt.Get("worktree")
			if truthy(tree, "continues") {
				sha := "undefined"
				if base, ok := wt.Get("baseUsed"); ok && base.Kind == jsfmt.Object {
					sha = first(member(base, "sha"), 8)
				}
				onPr = fmt.Sprintf(" On the existing PR branch %s at %s.", member(tree, "branch"), sha)
			}
		}
	}
	warning := ""
	if truthy(r, "warning") {
		warning = "\nWarning: " + member(r, "warning")
	}
	return fmt.Sprintf("Spawned %s (%s) in %s.%s%s", member(r, "name"), member(r, "id"), member(r, "cwd"), onPr, warning), nil
}

// typeOrNone is `m.type ?? 'no type'`.
func typeOrNone(m jsfmt.Value) string {
	if t, ok := m.Get("type"); ok && t.Kind != jsfmt.Null {
		return str(t, true)
	}
	return "no type"
}

// holdersText is src/developer-cap.ts holdersText: each holder with its age and activity, or the names alone from a
// peer that sends no holder_info.
func holdersText(r jsfmt.Value) string {
	info, ok := r.Get("holder_info")
	if !ok || info.Kind != jsfmt.Array {
		hs, _ := r.Get("holders")
		names := make([]string, len(hs.Items))
		for i, h := range hs.Items {
			if h.Kind != jsfmt.Null {
				names[i] = jsString(h)
			}
		}
		return strings.Join(names, ", ")
	}
	parts := make([]string, len(info.Items))
	for i, h := range info.Items {
		var facts []string
		if age, ok := h.Get("age_ms"); !ok || age.Kind != jsfmt.Null {
			facts = append(facts, formatAge(age, ok))
		}
		if truthy(h, "activity") {
			facts = append(facts, member(h, "activity"))
		}
		parts[i] = member(h, "name")
		if len(facts) > 0 {
			parts[i] += " (" + strings.Join(facts, ", ") + ")"
		}
	}
	return strings.Join(parts, ", ")
}

// formatAge is src/developer-cap.ts formatAge: seconds under a minute, minutes under an hour, else hours and minutes.
func formatAge(v jsfmt.Value, ok bool) string {
	var ms float64
	if !ok || v.Kind != jsfmt.Number {
		return "NaNhNaNm"
	}
	fmt.Sscan(v.Num, &ms)
	min := math.Floor(ms / 60_000)
	switch {
	case min < 1:
		return fmt.Sprintf("%.0fs", math.Floor(ms/1000))
	case min < 60:
		return fmt.Sprintf("%.0fm", min)
	}
	return fmt.Sprintf("%.0fh%.0fm", math.Floor(min/60), math.Mod(min, 60))
}

func agentControl(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	by, err := s.me(a)
	if err != nil {
		return "", err
	}
	agent, action := member(a, "agent"), member(a, "action")
	// A queued spawn has no agent yet: its name is the path (S-2134).
	if action == "cancel" {
		body := jsfmt.Value{Kind: jsfmt.Object}
		body.Set("by", jsfmt.StringValue(by))
		r, err := s.apiJSON(ctx, "POST", "/api/slot-queue/"+agent+"/cancel", raw(body))
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%s: queued spawn cancelled on %s", member(r, "name"), member(r, "machine")), nil
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("by", jsfmt.StringValue(by))
	copyMember(&body, a, "note", "note")
	copyMember(&body, a, "reason", "note")
	for _, k := range []string{"force", "discard", "force_unpushed", "visibility", "child_notices", "parent", "name"} {
		copyMember(&body, a, k, k)
	}
	r, err := s.apiJSON(ctx, "POST", "/api/agents/"+agent+"/"+action, raw(body))
	if err != nil {
		return "", err
	}
	ag, ok := r.Get("agent")
	if !ok || ag.Kind == jsfmt.Null {
		return "", errNoAgentName
	}
	return member(ag, "name") + ": " + member(r, "result"), nil
}

// workspaceShare is src/mcp.ts workspace_share: the caller shares its own personal workspace; the daemon judges it.
func workspaceShare(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	id, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	copyMember(&body, a, "agent", "agent")
	copyMember(&body, a, "access", "access")
	body.Set("self", jsfmt.StringValue(id))
	r, err := s.apiJSON(ctx, "POST", "/api/agents/"+id+"/workspace-share", raw(body))
	if err != nil {
		return "", err
	}
	return r.Text("message"), nil
}

func compactSelf(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	id, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("by", jsfmt.StringValue(id))
	copyMember(&body, a, "instructions", "instructions")
	copyMember(&body, a, "prompt", "prompt_after")
	if _, err := s.apiJSON(ctx, "POST", "/api/agents/"+id+"/compact", raw(body)); err != nil {
		return "", err
	}
	return "Compaction is scheduled for when you end this turn. End your turn now.", nil
}

func reconnectMCP(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	id, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("by", jsfmt.StringValue(id))
	r, err := s.apiJSON(ctx, "POST", "/api/agents/"+id+"/reconnect-mcp", raw(body))
	if err != nil {
		return "", err
	}
	if r.Text("result") == "reconnected" {
		return "MCP servers reconnected.", nil
	}
	return "You will restart with reconnected MCP servers when you end your turn.", nil
}

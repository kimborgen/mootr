package mcp

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"sync"

	"stam/internal/jsfmt"
)

// tool is one MCP tool. listing is its entry in tools/list, the JSON src/mcp.ts's JSON.stringify gives
// {name, group, description, inputSchema}, byte for byte (mcp_test.go compares it with the TS module's).
type tool struct {
	name    string
	listing string
	run     func(ctx context.Context, s *Server, args jsfmt.Value) (string, error)
	// when is the feature the tool needs listed: "requirements" lists it only while the daemon says requirements are on.
	when string
	// validate refuses a call that can't run before the decision-steps check, so it costs no daemon request (S-4120).
	validate func(args jsfmt.Value) error
}

var tools = []tool{
	{
		name:    "whoami",
		listing: `{"name":"whoami","group":"registry","description":"Your own stam registry entry: id, name, role, state, the path to your conversation history file, and now (the daemon's clock, ISO UTC).","inputSchema":{"type":"object","properties":{"self":{"type":"string","description":"Your stam agent id. Needed only when your system prompt asks for it."}}}}`,
		run:     whoami,
	},
	{
		name:    "register",
		listing: `{"name":"register","group":"registry","description":"Join the stam registry, for an agent that stam did not spawn. Gives you an id so others can find and mail you.","inputSchema":{"type":"object","properties":{"name":{"type":"string","description":"Unique lowercase name with dashes, for example \"docs-writer\"."},"role":{"type":"string","description":"One or two sentences on what you work on."},"harness":{"type":"string","description":"Your harness, for example \"claude\", \"codex\", or \"opencode\"."},"model":{"type":"string"}},"required":["name","role"]}}`,
		run:     register,
	},
}

// toolOrder is the order src/mcp.ts defines the tools in; tools/list keeps it for the tools ported.
var toolOrder = []string{"whoami", "register", "workspace_share", "find_agents", "registry_info", "settings_ask", "usage_info", "cost_allocate", "cost_ack", "cost_switch", "cost_pause", "send_mail", "mail_attach", "withdraw_ask",
	"spawn_agent", "agent_control", "compact_self", "request_permission", "suggest_input", "answer_permission", "ring_create", "ring_submit", "ring_decide",
	"reconnect_mcp", "defer_thread", "list_inbox", "read_mail", "wait_for", "wait_done", "wake_me", "read_thread", "search_mail", "search",
	"itsa_create", "req_create", "req_get", "req_set", "req_check", "req_waive", "feedback", "retro", "itsa_get", "itsa_list", "itsa_set", "itsa_fields", "itsa_link", "itsa_post", "subscribe", "unsubscribe", "list_subscriptions",
	"layout_get", "layout_arrange"}

var (
	orderOnce sync.Once
	ordered   []tool
)

// orderedTools is tools in toolOrder, built once on first use as a copy: the init functions that fill tools have all run by
// then, and neither tools nor the copy changes while requests are served.
func orderedTools() []tool {
	orderOnce.Do(func() {
		rank := func(name string) int {
			for i, n := range toolOrder {
				if n == name {
					return i
				}
			}
			return len(toolOrder)
		}
		ordered = append([]tool(nil), tools...)
		sort.SliceStable(ordered, func(i, j int) bool { return rank(ordered[i].name) < rank(ordered[j].name) })
	})
	return ordered
}

func findTool(name string) *tool {
	list := orderedTools()
	for i := range list {
		if list[i].name == name {
			return &list[i]
		}
	}
	return nil
}

// toolList is the tools/list array. A tool that needs requirements is listed only while GET /api/req-enabled says
// {enabled: true}; a failed ask hides it, as in TS. A canary (a release's server proving it answers, CanaryEnv) asks
// nothing of the daemon, so it lists them hidden.
func (s *Server) toolList(ctx context.Context) string {
	reqOn := false
	for _, t := range orderedTools() {
		if t.when == "requirements" && s.getenv(CanaryEnv) == "" {
			reqOn = s.requirementsOn(ctx)
			break
		}
	}
	out := "["
	n := 0
	for _, t := range orderedTools() {
		if t.when == "requirements" && !reqOn {
			continue
		}
		if n > 0 {
			out += ","
		}
		out += t.listing
		n++
	}
	return out + "]"
}

// requirementsOn is `r?.enabled === true` for GET /api/req-enabled, false when the ask fails.
func (s *Server) requirementsOn(ctx context.Context) bool {
	b, err := s.api.Do(ctx, "GET", "/api/req-enabled", nil, 0)
	if err != nil {
		return false
	}
	v, err := jsfmt.Parse(b)
	if err != nil {
		return false
	}
	e, ok := v.Get("enabled")
	return ok && e.Kind == jsfmt.Bool && e.Bool
}

// me is src/mcp.ts me: the agent's id, else the `self` argument of a harness that shares one MCP process between agents.
func (s *Server) me(args jsfmt.Value) (string, error) {
	if id := s.id(); id != "" {
		return id, nil
	}
	if id := args.Text("self"); id != "" {
		return id, nil
	}
	return "", errors.New("Pass your stam id as `self`, or call `register` first if you have none.")
}

func whoami(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	id, err := s.me(args)
	if err != nil {
		return "", err
	}
	raw, err := s.api.Do(ctx, "GET", "/api/agents/"+url.PathEscape(id), nil, 0)
	if err != nil {
		return "", err
	}
	v, err := jsfmt.Parse(raw)
	if err != nil {
		return "", errors.New("the daemon's reply isn't JSON")
	}
	return jsfmt.Stringify(v), nil
}

// register joins the registry for an agent stam didn't spawn. The agent's own token, which the reply carries, is used
// for every later call (the shared token can't name an agent) and never shown.
func register(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	if id := s.id(); id != "" {
		return "Already registered as " + id + ".", nil
	}
	cwd, err := s.cwd()
	if err != nil {
		return "", err
	}
	// {...args, cwd, token: true}: the arguments in their order, cwd and token set in place or appended.
	body := jsfmt.Value{Kind: jsfmt.Object}
	set := func(k string, v jsfmt.Value) {
		for i, key := range body.Keys {
			if key == k {
				body.Items[i] = v
				return
			}
		}
		body.Keys, body.Items = append(body.Keys, k), append(body.Items, v)
	}
	for i, k := range args.Keys {
		set(k, args.Items[i])
	}
	set("cwd", jsfmt.Value{Kind: jsfmt.String, Str: cwd})
	set("token", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	raw, err := s.api.Do(ctx, "POST", "/api/register", raw(body), 0)
	if err != nil {
		return "", err
	}
	r, err := jsfmt.Parse(raw)
	if err != nil {
		return "", errors.New("the daemon's reply isn't JSON")
	}
	id := r.Text("id")
	if id == "" {
		return "", fmt.Errorf("the daemon registered no id")
	}
	s.mu.Lock()
	s.agentID = id
	s.overlay["STAM_AGENT_ID"] = id
	s.overlay["MOOTR_AGENT_ID"] = id
	if tok := r.Text("token"); tok != "" {
		s.overlay["STAM_TOKEN"] = tok
		s.overlay["MOOTR_TOKEN"] = tok
	}
	s.mu.Unlock()
	s.startStream()
	shown := jsfmt.Value{Kind: jsfmt.Object}
	for i, k := range r.Keys {
		if k != "token" {
			shown.Keys, shown.Items = append(shown.Keys, k), append(shown.Items, r.Items[i])
		}
	}
	return jsfmt.Stringify(shown), nil
}

package mcp

import (
	"context"
	"fmt"
	"strings"
	"time"

	"stam/internal/jsfmt"
)

// The cost tools of src/mcp.ts (S-3807): usage_info, cost_allocate, cost_ack, cost_switch and cost_pause. The daemon judges who may;
// these send what the TS tools send and say what they say.

// switchCall is src/client.ts SWITCH_CALL_MS: a switch waits for the agent's soft stop.
const switchCall = 240 * time.Second

func init() {
	tools = append(tools,
		tool{name: "usage_info", listing: costListings["usage_info"], run: usageInfo},
		tool{name: "cost_allocate", listing: costListings["cost_allocate"], run: costAllocate},
		tool{name: "cost_ack", listing: costListings["cost_ack"], run: costAck},
		tool{name: "cost_switch", listing: costListings["cost_switch"], run: costSwitch},
		tool{name: "cost_pause", listing: costListings["cost_pause"], run: costPause},
	)
}

// pick is the object literal {k: a.k, ...} of the TS tools: an argument not passed is left out, as JSON.stringify leaves
// out undefined.
func pick(args jsfmt.Value, keys ...string) jsfmt.Value {
	out := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range keys {
		if v, ok := args.Get(k); ok {
			out.Set(k, v)
		}
	}
	return out
}

// plural is `${n === 1 ? "" : "s"}`: an "s" unless n is 1.
func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func count(v jsfmt.Value, k string) int {
	x, _ := v.Get(k)
	return len(x.Items)
}

func costAllocate(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	me, err := s.me(args)
	if err != nil {
		return "", err
	}
	// { ...a, self: undefined, by: me(a) }
	body := jsfmt.Value{Kind: jsfmt.Object}
	for i, k := range args.Keys {
		if k != "self" {
			body.Set(k, args.Items[i])
		}
	}
	body.Set("by", jsfmt.StringValue(me))
	r, err := s.apiJSON(ctx, "POST", "/api/cost/allocate", raw(body))
	if err != nil {
		return "", err
	}
	if c, ok := r.Get("cleared"); ok {
		n := 0
		if c.Kind == jsfmt.Number && c.Num == "1" {
			n = 1
		}
		return fmt.Sprintf("Cleared %s allocation%s.", str(c, true), plural(n)), nil
	}
	x, _ := r.Get("allocation")
	scope := ""
	if x.Text("kind") == "usd" {
		scope = "$" + str(x.Get("amount")) + "/" + str(x.Get("period"))
	} else {
		scope = str(x.Get("percent")) + "% of " + str(x.Get("account")) + " " + strings.Replace(str(x.Get("window")), "_", "-", 1)
	}
	out := "Allocation " + str(x.Get("id")) + " on " + str(arg(args, "tree")) + ": " + scope + "."
	if w, ok := r.Get("warning"); ok && w.Truthy() {
		out += "\n\n" + str(w, true)
	}
	return out, nil
}

func costAck(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	me, err := s.me(args)
	if err != nil {
		return "", err
	}
	body := pick(args, "event")
	body.Set("by", jsfmt.StringValue(me))
	r, err := s.apiJSON(ctx, "POST", "/api/cost/ack", raw(body))
	if err != nil {
		return "", err
	}
	return jsfmt.Compact(r), nil
}

func costSwitch(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	me, err := s.me(args)
	if err != nil {
		return "", err
	}
	body := pick(args, "agent", "preset", "soft_stop_minutes")
	body.Set("by", jsfmt.StringValue(me))
	r, err := s.apiJSONTimeout(ctx, "POST", "/api/cost/switch", raw(body), switchCall)
	if err != nil {
		return "", err
	}
	from, to, preset := str(r.Get("from")), str(r.Get("to")), str(r.Get("preset"))
	if r.Text("status") == "quiescing" {
		return fmt.Sprintf("%s is finishing its step (up to %s minutes); then its work moves to %s on %s. You'll get a notice when it's done.", from, str(r.Get("minutes")), to, preset), nil
	}
	m, _ := r.Get("moved")
	moved := fmt.Sprintf("%d children, %s threads, %s unread mails", count(m, "children"), str(m.Get("threads")), str(m.Get("unread")))
	if v, ok := r.Get("interrupted"); ok && v.Truthy() {
		moved += "; its turn was interrupted"
	}
	if v, ok := r.Get("handover"); !ok || !v.Truthy() {
		moved += "; no HANDOVER.md"
	}
	return fmt.Sprintf("%s now continues as %s on %s (%s). %s is stopped and held as taken over.", from, to, preset, moved, from), nil
}

func costPause(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	me, err := s.me(args)
	if err != nil {
		return "", err
	}
	body := pick(args, "tree", "until", "account", "window", "clear", "reason")
	body.Set("by", jsfmt.StringValue(me))
	r, err := s.apiJSON(ctx, "POST", "/api/cost/pause", raw(body))
	if err != nil {
		return "", err
	}
	acked := ""
	if n := count(r, "acked"); n > 0 {
		acked = fmt.Sprintf("; acknowledged %d cost notice%s", n, plural(n))
	}
	n, root := count(r, "agents"), str(r.Get("root"))
	if r.Text("action") == "cleared" {
		return fmt.Sprintf("Cleared the cost pause on %s's tree (%d agent%s%s).", root, n, plural(n), acked), nil
	}
	return fmt.Sprintf("Paused %d agent%s in %s's tree: %s%s.", n, plural(n), root, str(r.Get("until")), acked), nil
}

// usageInfo is usage_info: GET /api/usage for days (7 by default), tree when given, and as the agent, with a pointer to
// activity_info.
func usageInfo(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	days := "7"
	if v, ok := args.Get("days"); ok && v.Kind != jsfmt.Null {
		days = str(v, true)
	}
	path := "/api/usage?days=" + days
	if v, ok := args.Get("tree"); ok && v.Truthy() {
		path += "&tree=" + uriComponent(str(v, true))
	}
	// agentId ?? a.self
	me := s.id()
	if me == "" {
		if v, ok := args.Get("self"); ok && v.Truthy() {
			me = str(v, true)
		}
	}
	if me != "" {
		path += "&as=" + uriComponent(me)
	}
	r, err := s.apiJSON(ctx, "GET", path, nil)
	if err != nil {
		return "", err
	}
	// { ...(detail === true ? r : compactUsage(r, me)), see_also }
	out := jsfmt.Value{Kind: jsfmt.Object}
	if r.Kind == jsfmt.Object {
		out = r
		if d, ok := args.Get("detail"); !ok || d.Kind != jsfmt.Bool || !d.Bool {
			out = compactUsage(r, me)
		}
	}
	out.Set("see_also", jsfmt.StringValue("For time and bottlenecks, call activity_info."))
	return jsfmt.Stringify(out), nil
}

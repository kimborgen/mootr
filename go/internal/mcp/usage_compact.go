package mcp

import (
	"sort"
	"strconv"

	"stam/internal/jsfmt"
)

// The compact default of usage_info (src/usage-compact.ts, S-4236): the windows with their projections, the top
// few trees, agents and models, the allocations and the machines. `detail: true` returns the whole route answer.

// usageTop is the rows kept per list; usageBlocked the blocked agents named in full.
const (
	usageTop     = 5
	usageBlocked = 10
)

func isObj(v jsfmt.Value) bool { return v.Kind == jsfmt.Object }

// pickKeys is src/usage-compact.ts pick: the listed keys that are there, in the list's order.
func pickKeys(o jsfmt.Value, keys ...string) jsfmt.Value {
	out := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range keys {
		if v, ok := o.Get(k); ok {
			out.Set(k, v)
		}
	}
	return out
}

// objRows is the object elements of an array, and nothing for any other value.
func objRows(v jsfmt.Value, ok bool) []jsfmt.Value {
	var out []jsfmt.Value
	if !ok || v.Kind != jsfmt.Array {
		return out
	}
	for _, it := range v.Items {
		if isObj(it) {
			out = append(out, it)
		}
	}
	return out
}

func rowsOf(o jsfmt.Value, key string) []jsfmt.Value {
	v, ok := o.Get(key)
	return objRows(v, ok)
}

func headOf(rows []jsfmt.Value, n int) jsfmt.Value {
	if len(rows) > n {
		rows = rows[:n]
	}
	return jsfmt.ArrayValue(append([]jsfmt.Value{}, rows...))
}

func lenOf(o jsfmt.Value, key string) int {
	if v, ok := o.Get(key); ok && v.Kind == jsfmt.Array {
		return len(v.Items)
	}
	return 0
}

func atLeast0(n int) jsfmt.Value {
	if n < 0 {
		n = 0
	}
	return jsfmt.IntValue(int64(n))
}

func compactWindow(w jsfmt.Value) jsfmt.Value {
	if !isObj(w) {
		return w
	}
	out := pickKeys(w, "estimate", "since", "change", "other", "agents", "trees", "worth", "projection", "other_trees")
	out.Set("by_model", headOf(rowsOf(w, "by_model"), usageTop))
	if n := lenOf(w, "by_agent") - len(rowsOf(w, "agents")); n > 0 {
		out.Set("more_agents", jsfmt.IntValue(int64(n)))
	}
	if h, ok := w.Get("history"); ok && isObj(h) {
		if p, ok := h.Get("percent_per_hour"); ok {
			out.Set("percent_per_hour", p)
		}
	}
	return out
}

func compactTotals(r jsfmt.Value, keys ...string) jsfmt.Value {
	return pickKeys(r, append([]string{"cost_usd", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write"}, keys...)...)
}

func compactTotalsOf(rows []jsfmt.Value, keys ...string) jsfmt.Value {
	out := make([]jsfmt.Value, 0, len(rows))
	for _, r := range rows {
		out = append(out, compactTotals(r, keys...))
	}
	return jsfmt.ArrayValue(out)
}

func compactTree(t jsfmt.Value) jsfmt.Value {
	out := pickKeys(t, "id", "name", "cost_usd", "tokens", "shares")
	out.Set("subagents", jsfmt.IntValue(int64(lenOf(t, "children"))))
	return out
}

// ownTree is the caller's node and its direct children (the usageTop dearest, by cost), each as compactTree: a root can
// hold every agent ever made, so the subtree is not walked.
func ownTree(t jsfmt.Value) jsfmt.Value {
	kids := rowsOf(t, "children")
	cost := func(v jsfmt.Value) float64 {
		c, ok := v.Get("cost_usd")
		if !ok || c.Kind != jsfmt.Number {
			return 0
		}
		f, _ := strconv.ParseFloat(c.Num, 64)
		return f
	}
	sort.SliceStable(kids, func(i, j int) bool { return cost(kids[i]) > cost(kids[j]) })
	out := compactTree(t)
	top := []jsfmt.Value{}
	for _, k := range kids[:min(len(kids), usageTop)] {
		top = append(top, compactTree(k))
	}
	out.Set("children", jsfmt.ArrayValue(top))
	if len(kids) > usageTop {
		out.Set("omitted_children", jsfmt.IntValue(int64(len(kids)-usageTop)))
	}
	return out
}

func findTree(trees []jsfmt.Value, id string) (jsfmt.Value, bool) {
	for _, t := range trees {
		if v, ok := t.Get("id"); ok && v.Kind == jsfmt.String && v.Str == id {
			return t, true
		}
		if inner, ok := findTree(rowsOf(t, "children"), id); ok {
			return inner, true
		}
	}
	return jsfmt.Value{}, false
}

// compactUsage is src/usage-compact.ts compactUsage; me is the calling agent, whose own tree is kept as own_tree.
func compactUsage(full jsfmt.Value, me string) jsfmt.Value {
	out := pickKeys(full, "note", "display_mode", "instructions", "subscriptions", "openrouter_reserve", "shares_note", "allocations", "tree", "machines", "paid_spend_by_machine", "sample_count", "filtered_agents")
	accounts := []jsfmt.Value{}
	for _, a := range rowsOf(full, "accounts") {
		acc := a
		acc.Keys, acc.Items = append([]string{}, a.Keys...), append([]jsfmt.Value{}, a.Items...)
		if sh, ok := a.Get("shares"); ok && isObj(sh) {
			ns := jsfmt.Value{Kind: jsfmt.Object}
			for i, k := range sh.Keys {
				ns.Set(k, compactWindow(sh.Items[i]))
			}
			acc.Set("shares", ns)
		}
		accounts = append(accounts, acc)
	}
	out.Set("accounts", jsfmt.ArrayValue(accounts))
	trees := rowsOf(full, "trees")
	kept := []jsfmt.Value{}
	for i, t := range trees {
		if id, _ := t.Get("id"); i < usageTop || (id.Kind == jsfmt.String && id.Str == "other") {
			kept = append(kept, compactTree(t))
		}
	}
	out.Set("trees", jsfmt.ArrayValue(kept))
	if me != "" {
		if own, ok := findTree(trees, me); ok {
			out.Set("own_tree", ownTree(own))
		}
	}
	if t, ok := full.Get("today"); ok && isObj(t) {
		out.Set("today", compactTotals(t))
	}
	out.Set("by_day", compactTotalsOf(rowsOf(full, "by_day"), "day"))
	models := rowsOf(full, "by_model")
	out.Set("by_model", compactTotalsOf(models[:min(len(models), usageTop)], "harness", "model"))
	agents := rowsOf(full, "by_agent")
	out.Set("by_agent", compactTotalsOf(agents[:min(len(agents), usageTop)], "agent_id", "agent", "type", "harness", "model"))
	out.Set("by_account", compactTotalsOf(rowsOf(full, "by_account"), "account"))
	blockedN := lenOf(full, "blocked")
	blocked := jsfmt.ArrayValue([]jsfmt.Value{})
	if b, ok := full.Get("blocked"); ok && b.Kind == jsfmt.Array {
		blocked = headOf(b.Items, usageBlocked)
	}
	out.Set("blocked", blocked)
	om := jsfmt.Value{Kind: jsfmt.Object}
	om.Set("trees", atLeast0(len(trees)-len(kept)))
	om.Set("by_model", atLeast0(len(models)-usageTop))
	om.Set("by_agent", atLeast0(len(agents)-usageTop))
	om.Set("blocked", atLeast0(blockedN-usageBlocked))
	om.Set("hint", jsfmt.StringValue("Compact by default. Pass detail: true for every agent, tree, model and cost unit with the hourly history (about 1 MB), or tree: AGENT for one tree's hourly history."))
	out.Set("omitted", om)
	return out
}

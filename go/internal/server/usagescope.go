package server

import (
	"context"
	"errors"
	"math"
	"strconv"

	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// What an agent's token may read of the usage summary (src/usage-scope.ts scopeSummary, S-593, S-3807). The human, the
// CLI and the bosses keep every number. Any other agent sees the windows' totals, forecasts and notices in full, but
// per-agent and per-tree shares only for its own tree and its ancestors' trees; every other tree collapses into one
// "other" line. The scoping runs on the finished answer, so cost notices and pacing keep using full totals.

// numberOf is Number(v) on a decoded JSON value: null is 0, a missing value or one that isn't a number NaN.
func numberOf(v jsfmt.Value, ok bool) float64 {
	if !ok {
		return math.NaN()
	}
	switch v.Kind {
	case jsfmt.Number:
		f, err := strconv.ParseFloat(v.Num, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	case jsfmt.Null:
		return 0
	case jsfmt.Bool:
		if v.Bool {
			return 1
		}
		return 0
	case jsfmt.String:
		return jsjson.ToNumber(v.Str)
	}
	return math.NaN()
}

// numValue is a number as JSON.stringify writes it: NaN and the infinities as null.
func numValue(f float64) jsfmt.Value {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return jsfmt.NullValue()
	}
	return jsfmt.Value{Kind: jsfmt.Number, Num: jsjson.Number(f)}
}

// scopeSum is usage-scope.ts sum: the total rounded to four places.
func scopeSum(xs []float64) float64 {
	t := 0.0
	for _, x := range xs {
		t += x
	}
	return math.Floor(t*1e4+0.5) / 1e4
}

// items is `v ?? []` for an array value.
func items(v jsfmt.Value, ok bool) []jsfmt.Value {
	if !ok || v.Kind != jsfmt.Array {
		return nil
	}
	return v.Items
}

// keepBy is the items whose key (a string member) is in visible.
func keepBy(xs []jsfmt.Value, key string, visible map[string]bool) []jsfmt.Value {
	out := []jsfmt.Value{}
	for _, x := range xs {
		if visible[x.Text(key)] {
			out = append(out, x)
		}
	}
	return out
}

// scopeWindow is scopeWindow: a window's shares with the agents and trees outside visible removed, their percent summed
// into other_trees.
func scopeWindow(w jsfmt.Value, visible map[string]bool) jsfmt.Value {
	if w.Kind != jsfmt.Object {
		return w
	}
	var hidden []float64
	for _, x := range items(w.Get("by_agent")) {
		if !visible[x.Text("id")] {
			hidden = append(hidden, numberOf(x.Get("percent")))
		}
	}
	out := shallowCopy(w)
	for _, k := range []string{"agents", "by_agent", "trees", "by_tree"} {
		out.Set(k, jsfmt.ArrayValue(keepBy(items(w.Get(k)), "id", visible)))
	}
	if h, ok := w.Get("history"); ok && h.Truthy() {
		hist := shallowCopy(h)
		for _, k := range []string{"trees", "agents"} {
			hist.Set(k, jsfmt.ArrayValue(keepBy(items(h.Get(k)), "id", visible)))
		}
		out.Set("history", hist)
	}
	other := jsfmt.Value{Kind: jsfmt.Object}
	other.Set("percent", numValue(scopeSum(hidden)))
	out.Set("other_trees", other)
	return out
}

// shallowCopy is a shallow copy of an object, as {...v}.
func shallowCopy(v jsfmt.Value) jsfmt.Value {
	return jsfmt.Value{Kind: v.Kind, Keys: append([]string(nil), v.Keys...), Items: append([]jsfmt.Value(nil), v.Items...)}
}

// scopeTrees is scopeTrees: the visible trees, each with its children scoped, and one "other" tree for the rest.
func scopeTrees(trees []jsfmt.Value, visible map[string]bool) []jsfmt.Value {
	keep, hidden := []jsfmt.Value{}, []jsfmt.Value{}
	for _, t := range trees {
		if !visible[t.Text("id")] {
			hidden = append(hidden, t)
			continue
		}
		c := shallowCopy(t)
		c.Set("children", jsfmt.ArrayValue(scopeTrees(items(t.Get("children")), visible)))
		keep = append(keep, c)
	}
	if len(hidden) == 0 {
		return keep
	}
	shares := jsfmt.Value{Kind: jsfmt.Object}
	costs, tokens := []float64{}, 0.0
	for _, t := range hidden {
		costs = append(costs, numberOf(t.Get("cost_usd")))
		tokens += numberOf(t.Get("tokens"))
		ts, _ := t.Get("shares")
		for i, acct := range ts.Keys {
			ws := ts.Items[i]
			for j, win := range ws.Keys {
				a, ok := shares.Get(acct)
				if !ok {
					a = jsfmt.Value{Kind: jsfmt.Object}
				}
				cur, ok := a.Get(win)
				if !ok {
					cur = jsfmt.Value{Kind: jsfmt.Object}
					cur.Set("estimate", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
					cur.Set("percent", numValue(0))
				}
				cur.Set("percent", numValue(scopeSum([]float64{numberOf(cur.Get("percent")), numberOf(ws.Items[j].Get("percent"))})))
				a.Set(win, cur)
				shares.Set(acct, a)
			}
		}
	}
	other := jsfmt.Value{Kind: jsfmt.Object}
	other.Set("id", jsfmt.StringValue("other"))
	other.Set("name", jsfmt.StringValue("other"))
	other.Set("cost_usd", numValue(scopeSum(costs)))
	other.Set("tokens", numValue(tokens))
	other.Set("shares", shares)
	other.Set("children", jsfmt.ArrayValue([]jsfmt.Value{}))
	return append(keep, other)
}

// scopeSummary is src/usage-scope.ts scopeSummary: GET /api/usage for an agent's token. visible is visibleAgents(caller).
func scopeSummary(s jsfmt.Value, visible map[string]bool) jsfmt.Value {
	out := shallowCopy(s)
	if accts, ok := s.Get("accounts"); ok && accts.Kind == jsfmt.Array {
		list := make([]jsfmt.Value, len(accts.Items))
		for i, a := range accts.Items {
			sh, ok := a.Get("shares")
			if !ok || !sh.Truthy() {
				list[i] = a
				continue
			}
			scoped := jsfmt.Value{Kind: jsfmt.Object}
			for j, win := range sh.Keys {
				scoped.Set(win, scopeWindow(sh.Items[j], visible))
			}
			c := shallowCopy(a)
			c.Set("shares", scoped)
			list[i] = c
		}
		out.Set("accounts", jsfmt.ArrayValue(list))
	}
	if trees, ok := s.Get("trees"); ok && trees.Kind == jsfmt.Array {
		out.Set("trees", jsfmt.ArrayValue(scopeTrees(trees.Items, visible)))
	}
	if rows, ok := s.Get("by_agent"); ok && rows.Kind == jsfmt.Array {
		var hidden []jsfmt.Value
		for _, r := range rows.Items {
			if !visible[r.Text("agent_id")] {
				hidden = append(hidden, r)
			}
		}
		kept := keepBy(rows.Items, "agent_id", visible)
		if len(hidden) > 0 {
			orZero := func(f float64) float64 {
				if math.IsNaN(f) {
					return 0
				}
				return f
			}
			col := func(k string) jsfmt.Value {
				n := 0.0
				for _, r := range hidden {
					n += orZero(numberOf(r.Get(k)))
				}
				return numValue(n)
			}
			var costs []float64
			for _, r := range hidden {
				costs = append(costs, orZero(numberOf(r.Get("cost_usd"))))
			}
			other := jsfmt.Value{Kind: jsfmt.Object}
			other.Set("agent_id", jsfmt.StringValue("other"))
			other.Set("agent", jsfmt.StringValue("other"))
			other.Set("cost_usd", numValue(scopeSum(costs)))
			for _, k := range []string{"tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write"} {
				other.Set(k, col(k))
			}
			other.Set("harness", jsfmt.StringValue(""))
			for _, k := range []string{"model", "today", "lifetime"} {
				other.Set(k, jsfmt.NullValue())
			}
			kept = append(kept, other)
		}
		out.Set("by_agent", jsfmt.ArrayValue(kept))
	}
	if allocs, ok := s.Get("allocations"); ok && allocs.Kind == jsfmt.Array {
		out.Set("allocations", jsfmt.ArrayValue(keepBy(allocs.Items, "root_id", visible)))
	}
	if cache, ok := s.Get("cache"); ok {
		if ttl, ok := cache.Get("ttl_5m_agents"); ok && ttl.Truthy() {
			c := shallowCopy(cache)
			c.Set("ttl_5m_agents", jsfmt.ArrayValue(keepBy(items(ttl, true), "agent_id", visible)))
			out.Set("cache", c)
		}
	}
	if blocked, ok := s.Get("blocked"); ok && blocked.Kind == jsfmt.Array {
		out.Set("blocked", jsfmt.ArrayValue(keepBy(blocked.Items, "agent_id", visible)))
	}
	return out
}

// usageTree resolves usage's tree= (an agent id or name) once, so the scope check and the summary judge the same
// agent: GetAgent's `id = ? OR name = ?` has no order, and an agent named after another's id must not pass the check
// as one and be summarised as the other. It returns nil for an unknown agent, and the lookup's error for any other
// failure, as TS's throwing getAgent fails the request.
func (s *Server) usageTree(ctx context.Context, tree string) (*db.Agent, error) {
	lookup := s.db.GetAgent
	if s.treeLookup != nil {
		lookup = s.treeLookup
	}
	a, err := lookup(ctx, tree)
	if errors.Is(err, db.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// mayReadTree is src/usage-scope.ts mayReadTree on the resolved tree agent: an unknown one (nil) is let through, so
// the route reports it as it always did; a known one is judged on its id.
func mayReadTree(visible map[string]bool, root *db.Agent) bool {
	return root == nil || visible[root.ID]
}

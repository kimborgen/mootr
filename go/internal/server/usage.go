package server

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"slices"
	"strings"
	"time"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
)

// usageSummary is GET /api/usage (src/daemon.ts, S-3807): the usage summary (lifecycle.UsageSummary) over `days` (14
// by default) for the agent types in `agents` (src/agent-class.ts; absent keeps every agent), with each machine's load
// and a peer-less request's paid spend per machine. An agent's token reads only its own and its ancestors' trees
// (scopeSummary), and `tree` (usage_info tree=AGENT: that tree's shares, allocations and typical issue) only of one of
// those.
func (s *Server) usageSummary(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	q := r.URL.Query()
	tree := q.Get("tree")
	viewer, scoped := s.usageViewer(ctx, c, q.Get("as"))
	// The tree agent, resolved once: the scope check and the tree view both use its id.
	var root *db.Agent
	if tree != "" {
		var err error
		if root, err = s.usageTree(ctx, tree); err != nil {
			// A failed lookup refuses, as TS's throwing getAgent fails the request: no summary goes out.
			if scoped {
				return nil, Errorf(http.StatusInternalServerError, "could not check which trees this agent may read")
			}
			return nil, err
		}
	}
	var visible map[string]bool
	if scoped {
		var err error
		if visible, err = s.visibleAgents(ctx, viewer); err != nil {
			return nil, err
		}
		if tree != "" && !mayReadTree(visible, root) {
			return nil, Errorf(http.StatusForbidden, "an agent reads the usage of its own tree and its ancestors' trees only, not %s's", tree)
		}
	}
	reg, err := s.agentRegistry()
	if err != nil {
		return nil, err
	}
	keep, err := reg.parseAgentFilter(q.Get("agents"))
	if err != nil {
		return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
	}
	if tree != "" && root == nil {
		return nil, Errorf(http.StatusNotFound, "no agent %s", tree)
	}
	if s.life == nil {
		return struct{}{}, nil
	}
	days := 14.0
	if q.Has("days") {
		days = jsjson.ToNumber(q.Get("days"))
	}
	cos := s.settings.Get().ChiefOfStaff
	opts := lifecycle.SummaryOptions{Days: days, TypeOf: func(a db.Agent) string { return reg.typeOf(a, cos) }, Now: float64(time.Now().UnixMilli()), Tree: root}
	if keep != nil {
		opts.Keep = keep.has
	}
	summary, err := s.life.UsageSummary(ctx, opts)
	if err != nil {
		return nil, err
	}
	full, err := jsfmt.Parse([]byte(jsjson.Stringify(summary, "")))
	if err != nil {
		return nil, err
	}
	// Each machine's load and its agents by state, for usage_info.
	machines, err := s.allMachines(ctx, c.Local)
	if err != nil {
		return nil, err
	}
	compact := make([]jsfmt.Value, len(machines))
	for i, m := range machines {
		compact[i] = compactMachine(m)
	}
	full.Set("machines", jsfmt.ArrayValue(compact))
	// Paid spend per machine (S-395): a peer's own request gets only its local totals.
	if !c.Local {
		spend, err := s.life.PaidSpendByMachine(ctx, time.Now())
		if err != nil {
			return nil, err
		}
		v, err := jsfmt.Parse([]byte(jsjson.Stringify(spend, "")))
		if err != nil {
			return nil, err
		}
		full.Set("paid_spend_by_machine", v)
	}
	if scoped {
		full = scopeSummary(full, visible)
	}
	return json.RawMessage(jsfmt.Compact(full)), nil
}

// usageIssues is GET /api/usage/issues (src/daemon.ts, S-3807): spend per ITSA, averages by configuration, and what no
// ITSA worked on (lifecycle.IssueCosts), over the last `days` days of samples or all of them. An agent's token sees
// only the ITSAs it belongs to (src/usage-scope.ts scopeIssueCosts); the totals and per-config rows stay.
func (s *Server) usageIssues(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	q := r.URL.Query()
	if s.life == nil {
		return struct{}{}, nil
	}
	var days *float64
	if q.Has("days") {
		d := jsjson.ToNumber(q.Get("days"))
		days = &d
	}
	costs, err := s.life.IssueCosts(ctx, days, float64(time.Now().UnixMilli()))
	if err != nil {
		return nil, err
	}
	out, err := jsfmt.Parse([]byte(jsjson.Stringify(costs, "")))
	if err != nil {
		return nil, err
	}
	if viewer, scoped := s.usageViewer(ctx, c, q.Get("as")); scoped {
		kept := []jsfmt.Value{}
		for _, x := range items(out.Get("issues")) {
			// An ITSA it can't be shown to (or one that is gone) is left out, not refused.
			if s.mayReadUsageItsa(ctx, viewer, x.Text("key")) {
				kept = append(kept, x)
			}
		}
		out.Set("issues", jsfmt.ArrayValue(kept))
	}
	return json.RawMessage(jsfmt.Compact(out)), nil
}

// usageSeries is GET /api/usage/series (src/daemon.ts, S-657, S-3807): spend over time split by a group
// (lifecycle.SpendSeries), for the Usage page's charts. An agent's token sees hidden agents as Other in a tree or agent
// series, and the ITSAs it doesn't belong to as Other in an ITSA series.
func (s *Server) usageSeries(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	q := r.URL.Query()
	group := "tree"
	if q.Has("group") {
		group = q.Get("group")
	}
	if !slices.Contains(lifecycle.SeriesGroups, group) {
		return nil, Errorf(http.StatusBadRequest, "group must be one of %s, not %s", strings.Join(lifecycle.SeriesGroups, ", "), group)
	}
	days := 14.0
	if q.Has("days") {
		days = jsjson.ToNumber(q.Get("days"))
	}
	if math.IsNaN(days) || math.IsInf(days, 0) || days < 1 || days > lifecycle.MaxDrillDays {
		raw := "null"
		if q.Has("days") {
			raw = q.Get("days")
		}
		return nil, Errorf(http.StatusBadRequest, "days must be a number from 1 to %d, not %s", lifecycle.MaxDrillDays, raw)
	}
	if s.life == nil {
		return struct{}{}, nil
	}
	o := lifecycle.SeriesOptions{Days: days, Group: group, Now: float64(time.Now().UnixMilli())}
	if viewer, scoped := s.usageViewer(ctx, c, q.Get("as")); scoped {
		visible, err := s.usageVisibleAgents(ctx, viewer)
		if err != nil {
			return nil, err
		}
		o.Visible = visible
		o.MayItsa = s.usageItsaFilter(ctx, viewer)
	}
	series, err := s.life.SpendSeries(ctx, o)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(jsjson.Stringify(series, "")), nil
}

// usageScope is GET /api/usage/scope (src/daemon.ts, S-657, S-3807): one drilled tree, ITSA, agent, model or harness
// for the Usage page (lifecycle.DrillScope). An agent's token reads only the trees and agents it may see and the ITSAs
// it belongs to, and the scope's rows hold only the agents it may see.
func (s *Server) usageScope(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	q := r.URL.Query()
	var named []string
	for _, k := range []string{"tree", "itsa", "agent"} {
		if q.Get(k) != "" {
			named = append(named, k)
		}
	}
	// model may be bare (any harness), a `harness · model` id as the series emits, or combined with an explicit harness.
	harness, model := q.Get("harness"), q.Get("model")
	if len(named) > 1 || (len(named) > 0 && (harness != "" || model != "")) {
		return nil, Errorf(http.StatusBadRequest, "scope takes one of tree, itsa or agent, or a harness and/or model")
	}
	viewer, scoped := s.usageViewer(ctx, c, q.Get("as"))
	o := lifecycle.ScopeOptions{Harness: harness, Now: float64(time.Now().UnixMilli())}
	switch {
	case len(named) > 0 && named[0] == "itsa":
		ref := q.Get("itsa")
		found, ok, err := s.db.FindItsa(ctx, ref)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, Errorf(http.StatusNotFound, "no ITSA %s", ref)
		}
		o.Kind, o.Ref = "itsa", found.Text("key")
	case len(named) > 0:
		// The agent, resolved once: the scope check and the scope both use its id.
		ref := q.Get(named[0])
		root, err := s.usageTree(ctx, ref)
		if err != nil {
			if scoped {
				return nil, Errorf(http.StatusInternalServerError, "could not check which trees this agent may read")
			}
			return nil, err
		}
		if root == nil {
			return nil, Errorf(http.StatusNotFound, "no agent %s", ref)
		}
		o.Kind, o.Ref = named[0], root.ID
	case model != "":
		o.Kind, o.Ref = "model", model
	case harness != "":
		o.Kind, o.Ref = "harness", harness
	default:
		return nil, Errorf(http.StatusBadRequest, "scope needs one of tree, itsa, model, harness or agent")
	}
	if scoped {
		visible, err := s.usageVisibleAgents(ctx, viewer)
		if err != nil {
			return nil, err
		}
		o.Visible = visible
		o.MayItsa = s.usageItsaFilter(ctx, viewer)
		if (o.Kind == "tree" || o.Kind == "agent") && !visible[o.Ref] {
			return nil, Errorf(http.StatusForbidden, "an agent reads the usage of its own tree and its ancestors' trees only, not %s's", o.Ref)
		}
		if o.Kind == "itsa" && !o.MayItsa(o.Ref) {
			return nil, Errorf(http.StatusForbidden, "an agent reads the cost of the ITSAs it belongs to only, not %s", o.Ref)
		}
	}
	o.Days = 14
	if q.Has("days") {
		o.Days = jsjson.ToNumber(q.Get("days"))
	}
	if math.IsNaN(o.Days) || math.IsInf(o.Days, 0) || o.Days < 1 || o.Days > lifecycle.MaxDrillDays {
		return nil, Errorf(http.StatusBadRequest, "days must be a number from 1 to %d, not %s", lifecycle.MaxDrillDays, q.Get("days"))
	}
	// An ITSA may ask for its own span: since=ISO (when it opened) and bucket=hour|day. since is RFC 3339, as the other
	// routes read Date.parse; TS's Date.parse also takes forms that aren't ISO.
	if raw := q.Get("since"); raw != "" {
		since := jsMS(raw)
		if math.IsNaN(since) {
			return nil, Errorf(http.StatusBadRequest, "since must be an ISO time, not %s", raw)
		}
		o.Since = &since
	}
	if o.Bucket = q.Get("bucket"); o.Bucket != "" && o.Bucket != "hour" && o.Bucket != "day" {
		return nil, Errorf(http.StatusBadRequest, "bucket must be hour or day, not %s", o.Bucket)
	}
	if s.life == nil {
		return struct{}{}, nil
	}
	scope, err := s.life.DrillScope(ctx, o)
	// An ITSA deleted since the route found it.
	if gone := (lifecycle.ErrNoItsa{}); errors.As(err, &gone) {
		return nil, Errorf(http.StatusNotFound, "%s", gone.Error())
	}
	if err != nil {
		return nil, err
	}
	return json.RawMessage(jsjson.Stringify(scope, "")), nil
}

// usageVisibleAgents is visibleAgents, or the test's stand-in.
func (s *Server) usageVisibleAgents(ctx context.Context, me string) (map[string]bool, error) {
	if s.usageVisible != nil {
		return s.usageVisible(ctx, me)
	}
	return s.visibleAgents(ctx, me)
}

// usageItsaFilter is src/usage-scope.ts itsaFilter: mayReadUsageItsa for one agent, each key checked once, since a long
// ITSA series asks about the same keys for every sample.
func (s *Server) usageItsaFilter(ctx context.Context, me string) func(key string) bool {
	seen := map[string]bool{}
	return func(key string) bool {
		ok, hit := seen[key]
		if !hit {
			ok = s.mayReadUsageItsa(ctx, me, key)
			seen[key] = ok
		}
		return ok
	}
}

// mayReadUsageItsa is src/usage-scope.ts mayItsa: whether an agent belongs to an ITSA (mayReadItsaThreads); a check
// that fails, as for an ITSA that is gone, is a no.
func (s *Server) mayReadUsageItsa(ctx context.Context, me, key string) bool {
	check := s.mayReadItsaThreads
	if s.usageItsaCheck != nil {
		check = s.usageItsaCheck
	}
	ok, err := check(ctx, me, key)
	return err == nil && ok
}

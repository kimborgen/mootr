package lifecycle

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// The Usage page's attribution summaries (src/attribution.ts windowSummary, treeTotals and the worth and daily history,
// src/usage.ts snapshot, S-3807): each account window's top and full agent, tree and model shares, its daily history,
// worth range, hourly history and projection, and every tree with its cost and share of each window. The summary
// polls them, so one pass is memoized for snapshotTTL. TS also memoizes the samples within a pass (withSampleMemo);
// that saves queries only, so it isn't ported.

const (
	dayMs = float64(24 * time.Hour / time.Millisecond)
	// byDayDays is src/attribution.ts BY_DAY_DAYS, worthSpan WORTH_MS and worthMin WORTH_MIN.
	byDayDays = 14
	worthSpan = dayMs
	worthMin  = 5
	// topShares is src/attribution.ts TOP.
	topShares = 5
	// snapshotTTL is src/usage.ts SNAPSHOT_TTL_MS.
	snapshotTTL = 30_000.0
	// EstimateNote is src/attribution.ts ESTIMATE_NOTE.
	EstimateNote = "Estimates: shares split each change in a window among stam agents by API-price-weighted tokens; other is change no stam agent explains."
)

// usdPerWeighted is src/attribution.ts USD_PER_WEIGHTED: one weighted unit is a millionth of a dollar. A variable, so
// 100 × it is a float product as in TS, not an exact constant.
var usdPerWeighted = 1 / 1_000_000.0

// treeIndex is src/attribution.ts TreeIndex: every agent and parent link, read once for a pass.
type treeIndex struct {
	agents   []db.Agent
	byRef    map[string]db.Agent
	parents  map[string][]string
	children map[string][]string
}

func (l *Lifecycle) treeIndex(ctx context.Context) (*treeIndex, error) {
	agents, err := l.db.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	edges, err := l.db.TreeEdges(ctx)
	if err != nil {
		return nil, err
	}
	x := &treeIndex{agents: agents, byRef: map[string]db.Agent{}, parents: map[string][]string{}, children: map[string][]string{}}
	// getAgent matches an id or a name; an id wins over another agent's name.
	for _, a := range agents {
		x.byRef[a.Name] = a
	}
	for _, a := range agents {
		x.byRef[a.ID] = a
	}
	for _, e := range edges {
		x.parents[e[0]] = append(x.parents[e[0]], e[1])
		x.children[e[1]] = append(x.children[e[1]], e[0])
	}
	return x, nil
}

// nameOf is src/attribution.ts nameOf: the agent's name, else the id.
func (x *treeIndex) nameOf(id string) string {
	if a, ok := x.byRef[id]; ok {
		return a.Name
	}
	return id
}

// members is src/attribution.ts treeMembers over the index: the agent and everything below it, each once, in TS's
// visiting order.
func (x *treeIndex) members(id string) []string {
	seen := map[string]bool{}
	var out []string
	stack := []string{id}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		out = append(out, cur)
		stack = append(stack, x.children[cur]...)
	}
	return out
}

func setOf(ids []string) map[string]bool {
	out := make(map[string]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out
}

// treeShareOf is src/attribution.ts treeShare over the index: the sum of the tree's agents' shares in s.
func (x *treeIndex) treeShareOf(id string, s windowShares) float64 {
	sum := 0.0
	for _, m := range x.members(id) {
		sum += s.agents[m]
	}
	return sum
}

// windowRoots is src/attribution.ts windowRoots: the topmost ancestor of each agent with a share, or the agent itself
// when it has no parents, each once.
func (x *treeIndex) windowRoots(ids []string) []string {
	var roots []string
	has := map[string]bool{}
	add := func(id string) {
		if !has[id] {
			has[id], roots = true, append(roots, id)
		}
	}
	for _, id := range ids {
		stack := []string{id}
		seen := map[string]bool{}
		parentless := true
		for len(stack) > 0 {
			cur := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if seen[cur] {
				continue
			}
			seen[cur] = true
			a, ok := x.byRef[cur]
			if !ok {
				continue
			}
			for _, p := range x.parents[a.ID] {
				parentless = false
				add(p)
				stack = append(stack, p)
			}
		}
		if parentless {
			add(id)
		}
	}
	return roots
}

// quantile is src/attribution.ts quantile over sorted values.
func quantile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	pos := float64(len(sorted)-1) * p
	lo, hi := int(math.Floor(pos)), int(math.Ceil(pos))
	return sorted[lo] + (sorted[hi]-sorted[lo])*(pos-float64(lo))
}

// worthOf is src/attribution.ts worthOf: a full window's worth, 100 / (scale × 1e6) dollars for each recent interval's
// scale, with the 20th and 80th percentiles as the range, or ±25% around the current scale with few samples; mid is
// also returned for the display context (nil when not calibrated).
func worthOf(cal calibration, now float64) (*jsjson.Object, *float64) {
	var percentUsed jsjson.Value
	if cal.current != nil {
		percentUsed = cal.current.used
	}
	since := now - worthSpan
	var scales []float64
	for _, iv := range cal.intervals {
		if iv.scale != nil && iv.toMs >= since {
			scales = append(scales, *iv.scale)
		}
	}
	if len(scales) == 0 {
		return jsjson.NewObject("estimate", true, "worth_usd", nil, "used_usd", nil, "left_usd", nil, "percent_used", percentUsed, "samples", 0.0), nil
	}
	usd := func(s float64) float64 { return (100 * usdPerWeighted) / s }
	vals := make([]float64, len(scales))
	for i, s := range scales {
		vals[i] = usd(s)
	}
	sort.Float64s(vals)
	var low, mid, high float64
	if len(vals) < worthMin {
		if cal.scale != nil {
			mid = usd(*cal.scale)
		} else {
			mid = quantile(vals, 0.5)
		}
		low, high = mid*0.75, mid*1.25
	} else {
		low, mid, high = quantile(vals, 0.2), quantile(vals, 0.5), quantile(vals, 0.8)
	}
	var used, left jsjson.Value
	if cal.current != nil {
		u := (cal.current.used / 100) * mid
		used, left = round2(u), round2(math.Max(0, mid-u))
	}
	m := round2(mid)
	return jsjson.NewObject("estimate", true, "worth_usd", jsjson.NewObject("low", round2(low), "mid", m, "high", round2(high)),
		"used_usd", used, "left_usd", left, "percent_used", percentUsed, "samples", float64(len(vals))), &m
}

// utcDay is new Date(t).toISOString().slice(0, 10).
func utcDay(t float64) string { return isoMs(t)[:10] }

// byDay is src/attribution.ts byDay: the percentage of a window consumed on each of the last days, oldest first.
func byDay(cal calibration, days int, now float64) []jsjson.Value {
	from := now - float64(days)*dayMs
	sums := map[string]float64{}
	for _, iv := range cal.intervals {
		if iv.toMs < from {
			continue
		}
		sums[utcDay(iv.toMs)] += iv.change
	}
	out := make([]jsjson.Value, 0, days)
	for k := days - 1; k >= 0; k-- {
		d := utcDay(now - float64(k)*dayMs)
		out = append(out, jsjson.NewObject("day", d, "percent", round2(sums[d])))
	}
	return out
}

// historyCalibration is src/attribution.ts historyCalibration: the calibration over the summary's whole history.
func (l *Lifecycle) historyCalibration(ctx context.Context, account, window string, now float64) (calibration, error) {
	return l.calibrate(ctx, account, window, now-byDayDays*dayMs-calibrationWarmup, now)
}

// projectionObject is a Projection as TS writes it, note only when there is one.
func projectionObject(p projection) *jsjson.Object {
	opt := func(s *string) jsjson.Value {
		if s == nil {
			return nil
		}
		return *s
	}
	o := jsjson.NewObject("estimate", true, "used_percentage", optNumber(p.usedPercentage), "percent_per_hour", optNumber(p.percentPerHour),
		"reaches_100_at", opt(p.reaches100At), "resets_at", opt(p.resetsAt))
	if p.note != "" {
		o.Set("note", p.note)
	}
	return o
}

// patternOf is src/attribution.ts patternOf: the projection with the usual-pattern forecast and the two paces.
func patternOf(h hourlyHistory, cal calibration, s windowShares, window string, now float64) *jsjson.Object {
	length, ok := windowLength[window]
	if !ok {
		length = windowLength["five_hour"]
	}
	o := projectionObject(s.projection)
	o.Set("pattern", patternProjection(h, s.projection, length, now))
	p7, p24 := paces(cal, s.projection, now)
	o.Set("pace_7d", p7)
	o.Set("pace_24h", p24)
	return o
}

// idShare is one entry of a share map, in its order.
type idShare struct {
	id string
	p  float64
}

// sortedShares is Object.entries(m).sort((x, y) => y[1] - x[1]): largest first, ties in insertion order.
func sortedShares(order []string, m map[string]float64) []idShare {
	out := make([]idShare, len(order))
	for i, k := range order {
		out[i] = idShare{k, m[k]}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].p > out[j].p })
	return out
}

func top[T any](xs []T) []T {
	if len(xs) > topShares {
		return xs[:topShares]
	}
	return xs
}

// windowSummary is src/attribution.ts windowSummary: one window's `shares` entry, with its worth's mid for the display
// context.
func windowSummary(x *treeIndex, s windowShares, cal calibration, now float64) (*jsjson.Object, *float64) {
	agents := sortedShares(s.agentOrder, s.agents)
	models := sortedShares(s.modelOrder, s.models)
	ids := make([]string, len(agents))
	for i, a := range agents {
		ids[i] = a.id
	}
	var trees []idShare
	for _, id := range x.windowRoots(ids) {
		if p := x.treeShareOf(id, s); p > 0 {
			trees = append(trees, idShare{id, p})
		}
	}
	sort.SliceStable(trees, func(i, j int) bool { return trees[i].p > trees[j].p })
	fullAgents := make([]jsjson.Value, len(agents))
	for i, a := range agents {
		fullAgents[i] = jsjson.NewObject("agent", x.nameOf(a.id), "id", a.id, "percent", round2(a.p))
	}
	fullTrees := make([]jsjson.Value, len(trees))
	for i, t := range trees {
		fullTrees[i] = jsjson.NewObject("root", x.nameOf(t.id), "id", t.id, "percent", round2(t.p))
	}
	byModel := make([]jsjson.Value, len(models))
	for i, m := range models {
		var name jsjson.Value
		if m.id != "" {
			name = m.id
		}
		byModel[i] = jsjson.NewObject("model", name, "percent", round2(m.p))
	}
	h := hourly(cal, now-byDayDays*dayMs)
	topIDs := ids
	if len(topIDs) > topShares {
		topIDs = topIDs[:topShares]
	}
	perAgent := agentRates(h, topIDs)
	var histTrees, histAgents []jsjson.Value
	for _, t := range top(trees) {
		members := setOf(x.members(t.id))
		histTrees = append(histTrees, jsjson.NewObject("root", x.nameOf(t.id), "id", t.id, "percent_per_hour", average(h, members), "by_hour", hourRates(h, members)))
	}
	for _, id := range topIDs {
		o := jsjson.NewObject("agent", x.nameOf(id), "id", id)
		r := perAgent[id]
		for _, k := range r.Keys() {
			v, _ := r.Get(k)
			o.Set(k, v)
		}
		histAgents = append(histAgents, o)
	}
	byHour, byWeekday := profile(h, nil)
	worth, mid := worthOf(cal, now)
	return jsjson.NewObject(
		"estimate", true,
		"since", s.since,
		"change", round2(s.change),
		"other", round2(s.other),
		"agents", orEmpty(top(fullAgents)),
		"trees", orEmpty(top(fullTrees)),
		"by_agent", orEmpty(fullAgents),
		"by_tree", orEmpty(fullTrees),
		"by_model", orEmpty(byModel),
		"by_day", byDay(cal, byDayDays, now),
		"worth", worth,
		"history", jsjson.NewObject("estimate", true, "days", float64(byDayDays), "percent_per_hour", average(h, nil), "by_hour", byHour, "by_weekday", byWeekday,
			"trees", orEmpty(histTrees), "agents", orEmpty(histAgents)),
		"projection", patternOf(h, cal, s, s.window, now),
	), mid
}

// treeSummary is src/attribution.ts treeSummary over the snapshot's windows: one tree's (the agent id's) estimated
// share of each account window, with its history and the window's pattern projection, for usage_info tree=.
func treeSummary(x *treeIndex, id string, now float64, windows []cachedWindow) *jsjson.Object {
	members := x.members(id)
	set := setOf(members)
	accounts := jsjson.NewObject()
	for _, w := range windows {
		h := hourly(w.cal, now-byDayDays*dayMs)
		byHour, byWeekday := profile(h, set)
		a, ok := accounts.Get(w.account)
		if !ok {
			a = jsjson.NewObject()
			accounts.Set(w.account, a)
		}
		a.(*jsjson.Object).Set(w.window, jsjson.NewObject(
			"estimate", true,
			"since", w.shares.since,
			"percent", round2(x.treeShareOf(id, w.shares)),
			"change", round2(w.shares.change),
			"other", round2(w.shares.other),
			"projection", patternOf(h, w.cal, w.shares, w.window, now),
			"history", jsjson.NewObject("estimate", true, "days", float64(byDayDays), "percent_per_hour", average(h, set), "by_hour", byHour, "by_weekday", byWeekday),
		))
	}
	names := make([]jsjson.Value, len(members))
	for i, m := range members {
		names[i] = x.nameOf(m)
	}
	return jsjson.NewObject("note", EstimateNote, "agent", x.nameOf(id), "id", id, "members", names, "accounts", accounts)
}

// orEmpty is a list that writes as [] when it has nothing, as a TS array does.
func orEmpty(xs []jsjson.Value) []jsjson.Value {
	if xs == nil {
		return []jsjson.Value{}
	}
	return xs
}

// cachedWindow is src/attribution.ts CachedWindow: one account window's shares and history calibration.
type cachedWindow struct {
	account, window string
	shares          windowShares
	cal             calibration
}

// orderedSums is a Map of account to spend, in insertion order.
type orderedSums struct {
	order []string
	m     map[string]float64
}

func (o *orderedSums) add(k string, v float64) {
	if o.m == nil {
		o.m = map[string]float64{}
	}
	if _, ok := o.m[k]; !ok {
		o.order = append(o.order, k)
	}
	o.m[k] += v
}

func (o orderedSums) costs() []AccountCost {
	out := make([]AccountCost, len(o.order))
	for i, k := range o.order {
		out[i] = AccountCost{Account: k, API: o.m[k]}
	}
	return out
}

// subtree is src/attribution.ts subtree: every agent at or below root, each once, following parent→child edges.
func subtree(root string, children map[string][]string) []string {
	seen := map[string]bool{}
	var out []string
	stack := []string{root}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
		stack = append(stack, children[id]...)
	}
	return out
}

func numOr0(v jsjson.Value) float64 {
	if n, ok := v.(float64); ok {
		return n
	}
	return 0
}

// treeTotals is src/attribution.ts treeTotals: every tree as a nested structure of its cost and tokens over days and
// its share of each window. ctx, when not nil, adds each node's modes; only, when not nil, counts just those agents and
// leaves out a node whose subtree has none.
func (l *Lifecycle) treeTotals(ctx context.Context, x *treeIndex, days, now float64, windows []cachedWindow, dctx DisplayCtx, only map[string]bool) ([]jsjson.Value, error) {
	since := utcDay(now - days*86_400_000)
	rows, err := l.db.Objects(ctx, "SELECT agent_id, account, SUM(cost_usd) AS cost_usd, SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_write) AS tokens FROM usage WHERE day >= ? GROUP BY agent_id, account", since)
	if err != nil {
		return nil, err
	}
	type own struct {
		cost, tokens float64
		accounts     orderedSums
	}
	totals := map[string]*own{}
	for _, r := range rows {
		id := jsText(field(r, "agent_id"))
		t := totals[id]
		if t == nil {
			t = &own{}
			totals[id] = t
		}
		cost := numOr0(field(r, "cost_usd"))
		t.cost += cost
		t.tokens += numOr0(field(r, "tokens"))
		t.accounts.add(jsText(field(r, "account")), cost)
	}
	byID := map[string]db.Agent{}
	for _, a := range x.agents {
		byID[a.ID] = a
	}
	children := map[string][]string{}
	hasParent := map[string]bool{}
	for _, a := range x.agents {
		for _, p := range x.parents[a.ID] {
			if _, ok := byID[p]; !ok {
				continue
			}
			hasParent[a.ID] = true
			children[p] = append(children[p], a.ID)
		}
	}
	keeps := func(id string) bool {
		if only == nil {
			return true
		}
		for _, m := range subtree(id, children) {
			if only[m] {
				return true
			}
		}
		return false
	}
	type node struct {
		obj  *jsjson.Object
		cost float64
		name string
	}
	byCost := func(ns []node) {
		sort.SliceStable(ns, func(i, j int) bool {
			if ns[i].cost != ns[j].cost {
				return ns[i].cost > ns[j].cost
			}
			return localeCompare(ns[i].name, ns[j].name) < 0
		})
	}
	var build func(id string, path map[string]bool) node
	build = func(id string, path map[string]bool) node {
		var ids []string
		for _, m := range subtree(id, children) {
			if only == nil || only[m] {
				ids = append(ids, m)
			}
		}
		cost, tokens := 0.0, 0.0
		var accounts orderedSums
		for _, m := range ids {
			t := totals[m]
			if t == nil {
				continue
			}
			cost += t.cost
			tokens += t.tokens
			for _, a := range t.accounts.order {
				accounts.add(a, t.accounts.m[a])
			}
		}
		shares := jsjson.NewObject()
		for _, w := range windows {
			p := 0.0
			for _, m := range ids {
				p += w.shares.agents[m]
			}
			if p > 0 {
				acct, _ := shares.Get(w.account)
				o, ok := acct.(*jsjson.Object)
				if !ok {
					o = jsjson.NewObject()
					shares.Set(w.account, o)
				}
				o.Set(w.window, jsjson.NewObject("estimate", true, "percent", round2(p)))
			}
		}
		next := map[string]bool{id: true}
		for k := range path {
			next[k] = true
		}
		var kids []node
		for _, k := range children[id] {
			if !next[k] && keeps(k) {
				kids = append(kids, build(k, next))
			}
		}
		byCost(kids)
		kidVals := make([]jsjson.Value, len(kids))
		for i, k := range kids {
			kidVals[i] = k.obj
		}
		name := id
		if a, ok := byID[id]; ok {
			name = a.Name
		}
		o := jsjson.NewObject("id", id, "name", name, "cost_usd", round2(cost), "tokens", tokens)
		if dctx != nil {
			o.Set("modes", RoundModes(Convert(accounts.costs(), dctx, nil)).JSON())
		}
		o.Set("shares", shares)
		o.Set("children", kidVals)
		return node{obj: o, cost: round2(cost), name: name}
	}
	var roots []node
	for _, a := range x.agents {
		if !hasParent[a.ID] && keeps(a.ID) {
			roots = append(roots, build(a.ID, map[string]bool{}))
		}
	}
	byCost(roots)
	out := make([]jsjson.Value, len(roots))
	for i, r := range roots {
		out[i] = r.obj
	}
	return out, nil
}

// snapshotCtx is src/usage.ts snapshotCtx: the display context from the settings and the snapshot's own worths.
type snapshotCtx struct {
	kind   func(string) string
	worths map[string]map[string]*float64
	prices map[string]float64
}

func (c snapshotCtx) Kind(account string) string { return c.kind(account) }

func (c snapshotCtx) Worth(account, window string) *float64 { return c.worths[account][window] }

func (c snapshotCtx) Price(account string) *float64 {
	if p, ok := c.prices[account]; ok {
		return &p
	}
	return nil
}

func newSnapshotCtx(set config.Settings, worths map[string]map[string]*float64) snapshotCtx {
	return snapshotCtx{kind: KindResolver(set), worths: worths, prices: set.CostShape.DisplayPrices}
}

// snapshot is src/usage.ts Snapshot: each account's window summaries (in the readings' order), the trees, and each
// window's shares and calibration.
type snapshot struct {
	accounts []string
	shares   map[string]*jsjson.Object
	worths   map[string]map[string]*float64
	trees    []jsjson.Value
	windows  []cachedWindow
}

type snapshotMemo struct {
	key   string
	at    float64
	value snapshot
}

// windowsOf is a reading's window names, in its order.
func readingWindowNames(r *jsjson.Object) []string {
	w, _ := field(r, "windows").(*jsjson.Object)
	return w.Keys()
}

// snapshotOf is src/usage.ts snapshot: the attribution pass the summary shares, memoized for snapshotTTL per days and
// the readings' accounts and windows.
func (l *Lifecycle) snapshotOf(ctx context.Context, reads []*jsjson.Object, days, now float64) (snapshot, error) {
	var parts []string
	for _, r := range reads {
		names := append([]string(nil), readingWindowNames(r)...)
		sort.Strings(names)
		parts = append(parts, jsText(field(r, "account"))+":"+strings.Join(names, ","))
	}
	key := jsjson.Number(days) + "|" + strings.Join(parts, ";")
	l.mu.Lock()
	memo := l.snapshot
	l.mu.Unlock()
	if memo != nil && memo.key == key && now >= memo.at && now-memo.at < snapshotTTL {
		return memo.value, nil
	}
	x, err := l.treeIndex(ctx)
	if err != nil {
		return snapshot{}, err
	}
	snap := snapshot{shares: map[string]*jsjson.Object{}, worths: map[string]map[string]*float64{}}
	for _, r := range reads {
		names := readingWindowNames(r)
		if len(names) == 0 {
			continue
		}
		account := jsText(field(r, "account"))
		snap.accounts = append(snap.accounts, account)
		snap.shares[account], snap.worths[account] = jsjson.NewObject(), map[string]*float64{}
		for _, window := range names {
			cal, err := l.historyCalibration(ctx, account, window, now)
			if err != nil {
				return snapshot{}, err
			}
			s, err := l.windowSharesOf(ctx, account, window, nil, now)
			if err != nil {
				return snapshot{}, err
			}
			snap.windows = append(snap.windows, cachedWindow{account: account, window: window, shares: s, cal: cal})
			summary, mid := windowSummary(x, s, cal, now)
			snap.shares[account].Set(window, summary)
			snap.worths[account][window] = mid
		}
	}
	if snap.trees, err = l.treeTotals(ctx, x, days, now, snap.windows, newSnapshotCtx(l.settings.Get(), snap.worths), nil); err != nil {
		return snapshot{}, err
	}
	l.mu.Lock()
	l.snapshot = &snapshotMemo{key: key, at: now, value: snap}
	l.mu.Unlock()
	return snap, nil
}

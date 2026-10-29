package lifecycle

import (
	"context"
	"encoding/json"
	"math"
	"sort"

	"stam/internal/adapters/claude"
	"stam/internal/jsjson"
)

// Issue costs (src/issue-costs.ts, S-155, S-3807): what each ITSA cost, from the usage samples and the ITSA events. An
// agent's spend in a 5-minute bucket counts toward the ITSAs it worked on at that time: the ones it owned that were
// active then, else the active ones it takes part in, else all of its ITSAs, split evenly; an agent with none is
// unattributed. An ITSA's config is the largest harness · model among its worker agents (no child agents), else the
// largest overall; its weekly percent is its own subscription spend over each account's 7-day worth (mid).
//
// Every $ is API-equivalent for Claude and Codex. Not ported yet: itsaCost (GET /api/itsas/:ref/cost) and the
// activity summary's attributor.

const (
	// sampleRetentionMs is src/db.ts SAMPLE_RETENTION_MS: how long usage samples are kept.
	sampleRetentionMs = 35 * dayMs
	typicalDays       = 28
	typicalTTL        = 10 * 60_000
)

// TypicalNote is src/issue-costs.ts TYPICAL_NOTE.
const TypicalNote = "Issues closed in the last 28 days and created in the last 35 (how long usage samples are kept), each at its whole own cost; matched by the harness and model of the issue's main worker. 7-day window only."

var activeCategories = map[string]bool{"active": true, "review": true}

// CostNote is src/issue-costs.ts COST_NOTE.
const CostNote = "Claude and Codex $ are API-equivalent (the tokens at API prices), not what a subscription bills. weekly_percent is an ITSA's own spend on subscription accounts as a share of that account's 7-day worth estimate (mid); null when that is not calibrated or there is no subscription spend."

// issueTot is src/issue-costs.ts Tot: a cost and its tokens.
type issueTot struct{ cost, in, out, cacheRead, cacheWrite float64 }

func (t *issueTot) add(s issueTot, share float64) {
	t.cost += s.cost * share
	t.in += s.in * share
	t.out += s.out * share
	t.cacheRead += s.cacheRead * share
	t.cacheWrite += s.cacheWrite * share
}

// json is outTot: the cost to six places and whole tokens.
func (t issueTot) json() *jsjson.Object {
	return jsjson.NewObject("cost_usd", issueRound(t.cost), "tokens_in", round(t.in), "tokens_out", round(t.out),
		"tokens_cache_read", round(t.cacheRead), "tokens_cache_write", round(t.cacheWrite))
}

// issueWins is src/issue-costs.ts WINS.
var issueWins = [2]string{"five_hour", "seven_day"}

// issueItem is src/issue-costs.ts Item.
type issueItem struct {
	id, key, title, status string
	kind                   *string
	category               *string
	closedAt               *string
	parentID               *string
	created                float64
	participants           map[string]bool
	owners                 []ownerAt
	statuses               []statusAt
	initialStatus          *string
	own                    issueTot
	// agents holds each agent with spend on the ITSA; configs and workerConfigs (agents without child agents) and
	// accounts the own cost per key.
	agents        map[string]bool
	configs       orderedSums
	workerConfigs orderedSums
	manager       float64
	accounts      orderedSums
	total         issueTot
	totalAccounts orderedSums
	// inWindow is the subscription spend inside each account's current window, per WINS entry, for own and total.
	inWindow, totalInWindow [2]orderedSums
	weekly                  *float64
	config                  *string
}

type ownerAt struct {
	at    float64
	owner *string
}

type statusAt struct {
	at float64
	to string
}

// typicalMemo is typicalIssue's memo: the per-config rows of one compute.
type typicalMemo struct {
	at   float64
	rows []configRow
}

// msOr is Date.parse: the time in ms, NaN when it doesn't parse.
func msOr(v jsjson.Value) float64 {
	s, ok := v.(string)
	if !ok {
		return math.NaN()
	}
	if t, ok := parseMs(s); ok {
		return t
	}
	return math.NaN()
}

func optText(v jsjson.Value) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func numOf(v jsjson.Value) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}

// issueRound is src/issue-costs.ts round: six places.
func issueRound(n float64) float64 { return round(n*1e6) / 1e6 }

// buildIssueItems is src/issue-costs.ts buildAttribution's items and attribute: each ITSA with its owner and status
// timelines and participants, and the function that splits an agent's spend at a moment over its ITSAs.
func (l *Lifecycle) buildIssueItems(ctx context.Context) ([]*issueItem, map[string]*issueItem, func(agent string, t float64) []*issueItem, error) {
	categoryOf := map[string]string{}
	for _, s := range l.settings.Get().Itsa.Statuses {
		switch s.Category {
		case "backlog", "ready", "active", "review", "closed":
			categoryOf[s.Name] = s.Category
		}
	}
	rows, err := l.db.Objects(ctx, "SELECT id, key, title, kind, status, parent_id, owner, created_at, closed_at FROM itsas")
	if err != nil {
		return nil, nil, nil, err
	}
	var list []*issueItem
	items := map[string]*issueItem{}
	for _, r := range rows {
		x := &issueItem{id: jsText(field(r, "id")), key: jsText(field(r, "key")), title: jsText(field(r, "title")), status: jsText(field(r, "status")),
			kind: optText(field(r, "kind")), closedAt: optText(field(r, "closed_at")), parentID: optText(field(r, "parent_id")),
			created: msOr(field(r, "created_at")), participants: map[string]bool{}, agents: map[string]bool{}}
		if c, ok := categoryOf[jsText(field(r, "status"))]; ok {
			x.category = &c
		}
		// `r.owner ? owner : null`: an empty owner is none.
		var owner *string
		if o := optText(field(r, "owner")); o != nil && *o != "" {
			owner = o
		}
		x.owners = []ownerAt{{math.Inf(-1), owner}}
		list = append(list, x)
		items[x.id] = x
	}

	// Events, oldest first. The owner before the first change is that change's `from`; the status before the first
	// change is the one the ITSA was created in.
	events, err := l.db.Objects(ctx, "SELECT itsa_id, ts, type, data FROM itsa_events WHERE type IN ('created', 'status', 'owner') ORDER BY id")
	if err != nil {
		return nil, nil, nil, err
	}
	firstOwner := map[string]*string{}
	var firstOrder []string
	for _, e := range events {
		x := items[jsText(field(e, "itsa_id"))]
		if x == nil {
			continue
		}
		ev := map[string]any{}
		if d, ok := field(e, "data").(string); ok && d != "" {
			if err := json.Unmarshal([]byte(d), &ev); err != nil {
				return nil, nil, nil, err
			}
		}
		switch field(e, "type") {
		case "created":
			if s, ok := ev["status"]; ok && s != nil {
				t := claude.JSString(s)
				x.initialStatus = &t
			}
		case "status":
			if x.initialStatus == nil {
				if f, ok := ev["from"].(string); ok {
					x.initialStatus = &f
				}
			}
			to := "undefined"
			if v, ok := ev["to"]; ok {
				to = "null"
				if v != nil {
					to = claude.JSString(v)
				}
			}
			x.statuses = append(x.statuses, statusAt{msOr(field(e, "ts")), to})
		case "owner":
			if _, ok := firstOwner[x.id]; !ok {
				firstOwner[x.id] = optText(ev["from"])
				firstOrder = append(firstOrder, x.id)
			}
			x.owners = append(x.owners, ownerAt{msOr(field(e, "ts")), optText(ev["to"])})
		}
	}
	for _, id := range firstOrder {
		items[id].owners[0] = ownerAt{math.Inf(-1), firstOwner[id]}
	}

	agentIdx := map[string]map[string]bool{}
	link := func(agent, id string) {
		if agentIdx[agent] == nil {
			agentIdx[agent] = map[string]bool{}
		}
		agentIdx[agent][id] = true
	}
	parts, err := l.db.Objects(ctx, "SELECT itsa_id, agent_id FROM itsa_participants")
	if err != nil {
		return nil, nil, nil, err
	}
	for _, p := range parts {
		x := items[jsText(field(p, "itsa_id"))]
		if x == nil {
			continue
		}
		agent := jsText(field(p, "agent_id"))
		x.participants[agent] = true
		link(agent, x.id)
	}
	for _, x := range list {
		for _, o := range x.owners {
			if o.owner != nil && *o.owner != "" {
				link(*o.owner, x.id)
			}
		}
	}

	agents, err := l.db.Objects(ctx, "SELECT id, created_at FROM agents")
	if err != nil {
		return nil, nil, nil, err
	}
	agentCreated := map[string]float64{}
	for _, a := range agents {
		agentCreated[jsText(field(a, "id"))] = msOr(field(a, "created_at"))
	}

	statusAtT := func(x *issueItem, t float64) *string {
		if t < x.created {
			return nil
		}
		var cur *statusAt
		for i := range x.statuses {
			if x.statuses[i].at > t {
				break
			}
			cur = &x.statuses[i]
		}
		if cur != nil {
			return &cur.to
		}
		return x.initialStatus
	}
	ownerAtT := func(x *issueItem, t float64) *string {
		var cur *ownerAt
		for i := range x.owners {
			if x.owners[i].at > t {
				break
			}
			cur = &x.owners[i]
		}
		if cur == nil {
			return nil
		}
		return cur.owner
	}
	attribute := func(agent string, t float64) []*issueItem {
		cands := agentIdx[agent]
		if len(cands) == 0 {
			return nil
		}
		created, known := agentCreated[agent]
		existed := !known || created <= t
		activeNow := func(x *issueItem) bool {
			if !existed {
				return false
			}
			s := statusAtT(x, t)
			return s != nil && activeCategories[categoryOf[*s]]
		}
		var candidates []*issueItem
		for _, x := range list {
			if cands[x.id] {
				candidates = append(candidates, x)
			}
		}
		pick := func(keep func(*issueItem) bool) []*issueItem {
			var out []*issueItem
			for _, x := range candidates {
				if keep(x) {
					out = append(out, x)
				}
			}
			return out
		}
		// Owner first; participation only when the agent owns no active ITSA then.
		split := pick(func(x *issueItem) bool { o := ownerAtT(x, t); return o != nil && *o == agent && activeNow(x) })
		if len(split) == 0 {
			split = pick(func(x *issueItem) bool { return x.participants[agent] && activeNow(x) })
		}
		if len(split) == 0 {
			split = candidates
		}
		return split
	}
	return list, items, attribute, nil
}

// issueCompute is src/issue-costs.ts Computed.
type issueCompute struct {
	items             []*issueItem
	unattributed, all issueTot
	since             *string
}

// defaultWorthMid is src/issue-costs.ts defaultWorthMid: each account's 7-day worth mid from its calibration, read once.
func (l *Lifecycle) defaultWorthMid(ctx context.Context, now float64) func(string) (*float64, error) {
	mids := map[string]*float64{}
	return func(account string) (*float64, error) {
		if m, ok := mids[account]; ok {
			return m, nil
		}
		cal, err := l.historyCalibration(ctx, account, "seven_day", now)
		if err != nil {
			return nil, err
		}
		_, mid := worthOf(cal, now)
		mids[account] = mid
		return mid, nil
	}
}

// computeIssues is src/issue-costs.ts compute: each ITSA's own spend from the samples since days before now (all of
// them when days is nil), split by the attribution, then its total with every descendant's own, its config and its
// weekly percent. worthMid is each account's 7-day worth mid.
func (l *Lifecycle) computeIssues(ctx context.Context, days *float64, now float64, worthMid func(string) (*float64, error)) (issueCompute, error) {
	var c issueCompute
	if days != nil {
		t := now - *days*dayMs
		if math.IsNaN(t) || math.Abs(t) > 8.64e15 {
			return c, errInvalidTime
		}
		since := isoMs(t)
		c.since = &since
	}
	list, items, attribute, err := l.buildIssueItems(ctx)
	if err != nil {
		return c, err
	}
	c.items = list
	edges, err := l.db.TreeEdges(ctx)
	if err != nil {
		return c, err
	}
	// Managers have child agents; their spend is not a worker's, so it never sets a config.
	managers := map[string]bool{}
	for _, e := range edges {
		managers[e[1]] = true
	}
	set := l.settings.Get()
	isSubscription := func(account string) bool {
		a, ok := set.CostAccounts[account]
		return ok && (a.Paid == nil || !*a.Paid)
	}
	starts := map[string]float64{}
	winStart := func(account, w string) (float64, error) {
		k := account + "|" + w
		if v, ok := starts[k]; ok {
			return v, nil
		}
		v, err := l.windowStart(ctx, account, w, now)
		starts[k] = v
		return v, err
	}
	q, args := "SELECT agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write FROM usage_samples ORDER BY rowid", []any(nil)
	if c.since != nil {
		q, args = "SELECT agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write FROM usage_samples WHERE bucket >= ? ORDER BY rowid", []any{*c.since}
	}
	samples, err := l.db.Objects(ctx, q, args...)
	if err != nil {
		return c, err
	}
	for _, s := range samples {
		tot := issueTot{numOf(field(s, "cost_usd")), numOf(field(s, "tokens_in")), numOf(field(s, "tokens_out")), numOf(field(s, "tokens_cache_read")), numOf(field(s, "tokens_cache_write"))}
		c.all.add(tot, 1)
		agent := jsText(field(s, "agent_id"))
		t := msOr(field(s, "bucket"))
		split := attribute(agent, t)
		if len(split) == 0 {
			c.unattributed.add(tot, 1)
			continue
		}
		account := jsText(field(s, "account"))
		var inWin []int
		if isSubscription(account) {
			for i, w := range issueWins {
				start, err := winStart(account, w)
				if err != nil {
					return c, err
				}
				if t >= start {
					inWin = append(inWin, i)
				}
			}
		}
		model := jsText(field(s, "model"))
		if model == "" {
			model = "unknown"
		}
		config := jsText(field(s, "harness")) + " · " + model
		manager := managers[agent]
		share := 1 / float64(len(split))
		for _, x := range split {
			x.own.add(tot, share)
			x.agents[agent] = true
			x.configs.add(config, tot.cost*share)
			if !manager {
				x.workerConfigs.add(config, tot.cost*share)
			} else {
				x.manager += tot.cost * share
			}
			x.accounts.add(account, tot.cost*share)
			for _, w := range inWin {
				x.inWindow[w].add(account, tot.cost*share)
			}
		}
	}

	// Totals: each ITSA's own plus every descendant's own, each once, children first.
	children := map[string][]*issueItem{}
	for _, x := range list {
		if x.parentID != nil && items[*x.parentID] != nil {
			children[*x.parentID] = append(children[*x.parentID], x)
		}
	}
	folded := map[string]bool{}
	addSums := func(into *orderedSums, from orderedSums) {
		for _, k := range from.order {
			into.add(k, from.m[k])
		}
	}
	var fold func(x *issueItem)
	fold = func(x *issueItem) {
		if folded[x.id] {
			return
		}
		folded[x.id] = true
		x.total.add(x.own, 1)
		addSums(&x.totalAccounts, x.accounts)
		for w := range issueWins {
			addSums(&x.totalInWindow[w], x.inWindow[w])
		}
		for _, ch := range children[x.id] {
			fold(ch)
			x.total.add(ch.total, 1)
			addSums(&x.totalAccounts, ch.totalAccounts)
			for w := range issueWins {
				addSums(&x.totalInWindow[w], ch.totalInWindow[w])
			}
		}
	}
	for _, x := range list {
		fold(x)
		x.config = topKey(x.workerConfigs)
		if x.config == nil {
			x.config = topKey(x.configs)
		}
		if x.weekly, err = weeklyPercent(x, isSubscription, worthMid); err != nil {
			return c, err
		}
	}
	return c, nil
}

// topKey is src/issue-costs.ts topKey: the key with the largest value, ties by name; nil when there are none.
func topKey(m orderedSums) *string {
	keys := append([]string(nil), m.order...)
	sort.SliceStable(keys, func(i, j int) bool { return localeCompare(keys[i], keys[j]) < 0 })
	var best *string
	bestV := math.Inf(-1)
	for _, k := range keys {
		if v := m.m[k]; v > bestV {
			k := k
			best, bestV = &k, v
		}
	}
	return best
}

// weeklyPercent is src/issue-costs.ts weeklyPercent: own subscription spend as a share of each account's 7-day worth,
// nil when one isn't calibrated or there is none.
func weeklyPercent(x *issueItem, isSubscription func(string) bool, worthMid func(string) (*float64, error)) (*float64, error) {
	pct, any := 0.0, false
	for _, account := range x.accounts.order {
		if !isSubscription(account) {
			continue
		}
		mid, err := worthMid(account)
		if err != nil {
			return nil, err
		}
		if mid == nil || *mid <= 0 {
			return nil, nil
		}
		pct += (x.accounts.m[account] / *mid) * 100
		any = true
	}
	if !any {
		return nil, nil
	}
	p := round2(pct)
	return &p, nil
}

// issueStats is src/issue-costs.ts stats over values (at least one): the count, median, average, min and max, each to
// six places.
type issueStats struct {
	n                         int
	median, average, min, max float64
}

func statsOfValues(values []float64) issueStats {
	v := append([]float64(nil), values...)
	sort.Float64s(v)
	n := len(v)
	var median float64
	if n%2 == 1 {
		median = v[(n-1)/2]
	} else {
		median = (v[n/2-1] + v[n/2]) / 2
	}
	sum := 0.0
	for _, x := range v {
		sum += x
	}
	return issueStats{n, issueRound(median), issueRound(sum / float64(n)), issueRound(v[0]), issueRound(v[n-1])}
}

// optStats is src/issue-costs.ts statsOf: the stats of the values that aren't nil, all null when none is.
func optStats(values []*float64) *jsjson.Object {
	var v []float64
	for _, x := range values {
		if x != nil {
			v = append(v, *x)
		}
	}
	if len(v) == 0 {
		return jsjson.NewObject("n", 0.0, "median", nil, "average", nil, "min", nil, "max", nil)
	}
	s := statsOfValues(v)
	return jsjson.NewObject("n", float64(s.n), "median", s.median, "average", s.average, "min", s.min, "max", s.max)
}

// issueCost is src/issue-costs.ts itemCost: an ITSA's own and total cost in every display unit, the window percents
// being its subscription spend in each current window over that window's worth.
func issueCost(x *issueItem, dctx DisplayCtx, mode string) (own, total Modes, out *jsjson.Object) {
	pct := func(m [2]orderedSums) *WindowPercent {
		var out [2]*float64
		for w, win := range issueWins {
			out[w] = fp(0)
			for _, account := range m[w].order {
				worth := dctx.Worth(account, win)
				if out[w] == nil || worth == nil || *worth <= 0 {
					out[w] = nil
				} else {
					out[w] = fp(*out[w] + (100*m[w].m[account])/(*worth))
				}
			}
		}
		return &WindowPercent{FiveHour: out[0], SevenDay: out[1]}
	}
	own = RoundModes(Convert(x.accounts.costs(), dctx, pct(x.inWindow)))
	total = RoundModes(Convert(x.totalAccounts.costs(), dctx, pct(x.totalInWindow)))
	return own, total, jsjson.NewObject("mode", mode, "own", own.JSON(), "total", total.JSON())
}

// configRow is a src/issue-costs.ts byConfig row: closed leaf issues with own spend, per config.
type configRow struct {
	config string
	stats  issueStats
	weekly *float64
	units  *jsjson.Object
}

func (r configRow) json() *jsjson.Object {
	o := jsjson.NewObject("config", r.config, "n", float64(r.stats.n), "median", r.stats.median, "average", r.stats.average,
		"min", r.stats.min, "max", r.stats.max, "median_weekly_percent", optNumber(r.weekly))
	if r.units != nil {
		o.Set("units", r.units)
	}
	return o
}

// byConfig is src/issue-costs.ts byConfig: closed issues with own spend and a config that keep holds, grouped by config,
// most issues first. With a display context, each row carries the stats in the api, week and real measures.
func byConfig(items []*issueItem, keep func(*issueItem) bool, dctx DisplayCtx, mode string) []configRow {
	type group struct {
		costs, weekly []float64
		modes         []Modes
	}
	var order []string
	groups := map[string]*group{}
	for _, x := range items {
		if x.kind == nil || *x.kind != "issue" || x.category == nil || *x.category != "closed" || x.own.cost <= 0 || x.config == nil || *x.config == "" || !keep(x) {
			continue
		}
		g := groups[*x.config]
		if g == nil {
			g = &group{}
			groups[*x.config] = g
			order = append(order, *x.config)
		}
		g.costs = append(g.costs, x.own.cost)
		if x.weekly != nil {
			g.weekly = append(g.weekly, *x.weekly)
		}
		if dctx != nil {
			own, _, _ := issueCost(x, dctx, mode)
			g.modes = append(g.modes, own)
		}
	}
	rows := make([]configRow, len(order))
	for i, config := range order {
		g := groups[config]
		row := configRow{config: config, stats: statsOfValues(g.costs)}
		if len(g.weekly) > 0 {
			w := round2(statsOfValues(g.weekly).median)
			row.weekly = &w
		}
		if dctx != nil {
			var api, week, real []*float64
			for _, m := range g.modes {
				api = append(api, fp(m.API))
				week = append(week, m.SevenDay)
				var r *float64
				if m.Subscription != nil {
					r = fp(*m.Subscription + m.PaidUSD)
				}
				real = append(real, r)
			}
			row.units = jsjson.NewObject("api", optStats(api), "week", optStats(week), "real", optStats(real))
		}
		rows[i] = row
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].stats.n != rows[j].stats.n {
			return rows[i].stats.n > rows[j].stats.n
		}
		return localeCompare(rows[i].config, rows[j].config) < 0
	})
	return rows
}

// IssueCosts is src/issue-costs.ts issueCosts (GET /api/usage/issues): each ITSA's own and total spend, its agents,
// config, weekly percent and cost in every display unit, most expensive first; the per-config averages; and what no
// ITSA worked on. days limits the samples (nil reads all); the display context is the cached snapshot's.
func (l *Lifecycle) IssueCosts(ctx context.Context, days *float64, now float64) (*jsjson.Object, error) {
	reads, err := l.AccountReadings(ctx, now)
	if err != nil {
		return nil, err
	}
	snap, err := l.snapshotOf(ctx, reads, 14, now)
	if err != nil {
		return nil, err
	}
	set := l.settings.Get()
	dctx := newSnapshotCtx(set, snap.worths)
	c, err := l.computeIssues(ctx, days, now, func(account string) (*float64, error) { return dctx.Worth(account, "seven_day"), nil })
	if err != nil {
		return nil, err
	}
	type issueRow struct {
		obj  *jsjson.Object
		cost float64
		key  string
	}
	rows := make([]issueRow, len(c.items))
	for i, x := range c.items {
		own := x.own.json()
		own.Set("manager_cost_usd", issueRound(x.manager))
		_, _, cost := issueCost(x, dctx, set.CostMode)
		var config jsjson.Value
		if x.config != nil {
			config = *x.config
		}
		rows[i] = issueRow{jsjson.NewObject("key", x.key, "title", x.title, "kind", optValue(x.kind), "status", x.status, "closed_at", optValue(x.closedAt),
			"own", own, "total", x.total.json(), "agents", float64(len(x.agents)), "config", config, "weekly_percent", optNumber(x.weekly), "cost", cost),
			issueRound(x.total.cost), x.key}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].cost != rows[j].cost {
			return rows[i].cost > rows[j].cost
		}
		return localeCompare(rows[i].key, rows[j].key) < 0
	})
	issues := make([]jsjson.Value, len(rows))
	for i, r := range rows {
		issues[i] = r.obj
	}
	cfg := byConfig(c.items, func(*issueItem) bool { return true }, dctx, set.CostMode)
	byCfg := make([]jsjson.Value, len(cfg))
	for i, r := range cfg {
		byCfg[i] = r.json()
	}
	var since jsjson.Value
	if c.since != nil {
		since = *c.since
	}
	return jsjson.NewObject("note", CostNote, "since", since, "issues", issues, "by_config", byCfg, "unattributed", c.unattributed.json(), "all", c.all.json()), nil
}

func optValue(s *string) jsjson.Value {
	if s == nil {
		return nil
	}
	return *s
}

// TypicalIssue is src/issue-costs.ts typicalIssue: what a finished issue with this config (harness · model of its
// main worker) used, over the issues closed in the last 28 days and created within the sample retention, each at its
// whole own cost. Nil when no such issue has that config. The rows are memoized for 10 minutes.
func (l *Lifecycle) TypicalIssue(ctx context.Context, config string, now float64) (*jsjson.Object, error) {
	l.mu.Lock()
	memo := l.typical
	l.mu.Unlock()
	if memo == nil || now < memo.at || now-memo.at >= typicalTTL {
		days := sampleRetentionMs / dayMs
		c, err := l.computeIssues(ctx, &days, now, l.defaultWorthMid(ctx, now))
		if err != nil {
			return nil, err
		}
		scanFrom, closedFrom := now-sampleRetentionMs, now-typicalDays*dayMs
		rows := byConfig(c.items, func(x *issueItem) bool {
			return x.created >= scanFrom && x.closedAt != nil && msOr(*x.closedAt) >= closedFrom
		}, nil, "")
		memo = &typicalMemo{at: now, rows: rows}
		l.mu.Lock()
		l.typical = memo
		l.mu.Unlock()
	}
	for _, r := range memo.rows {
		if r.config == config {
			return jsjson.NewObject("estimate", true, "note", TypicalNote, "config", config, "n", float64(r.stats.n), "median_cost_usd", r.stats.median,
				"median_weekly_percent", optNumber(r.weekly)), nil
		}
	}
	return nil, nil
}

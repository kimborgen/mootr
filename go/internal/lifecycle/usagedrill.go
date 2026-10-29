package lifecycle

import (
	"context"
	"errors"
	"math"
	"sort"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// Usage drill-down data (src/usage-drill.ts, S-657, S-3807): the spend series the Usage page charts, one row per day
// (per hour for days=1, from usage_samples), split into the top 5 groups plus "Other", over the period and the
// same-length period before it. Costs are the harness-reported API-equivalent $ in the `usage` table (or
// `usage_samples` for hourly and per-ITSA rows); ITSA attribution is issue-costs'. For an agent's token, hidden agents
// collapse into "Other" in a tree or agent series and an unreadable ITSA becomes "Other" in an ITSA series.
//
// A tree series groups an agent under one root, even in a DAG: the lexicographically smallest top ancestor reachable
// through any parent edge.
//
// The drill scope (GET /api/usage/scope) is in drillscope.go.

// SeriesGroups is src/usage-drill.ts SERIES_GROUPS.
var SeriesGroups = []string{"tree", "model", "harness", "agent", "itsa"}

// MaxDrillDays is src/usage-drill.ts MAX_DAYS: the most days a series or scope asks for.
const MaxDrillDays = 400

// modelSep is src/usage-drill.ts MODEL_SEP.
const modelSep = " · "

// SeriesNote is src/usage-drill.ts SERIES_NOTE.
const SeriesNote = "One row per bucket, split into the top 5 groups by period cost plus Other when there are more. previous_rows is the same-length period before it, one row per bucket over the same groups (a group outside them folds into Other). Every bucket of both periods has a row, zero when nothing was spent. Each group has a stable id (a tree root's agent id, an agent id, a harness, `harness · model`, or an ITSA key) and a display name; the model group also carries its harness. group=itsa reads usage_samples (kept 35 days) and puts spend on no ITSA under Unattributed; the other groups read the usage table and cover any period."

const otherID = "other"

// errSeriesDays is the RangeError TS's Array(n) throws for a day series over a fractional number of days.
var errSeriesDays = errors.New("usage series: invalid array length")

// drillTot is src/usage-drill.ts Tot: a cost, its tokens, and the cost in every display unit.
type drillTot struct {
	cost, in, out, cacheRead, cacheWrite float64
	modes                                Modes
}

func zeroDrill() drillTot { return drillTot{modes: ZeroModes()} }

// add is src/usage-drill.ts add: s times share into t, a null unit staying null.
func (t *drillTot) add(s drillTot, share float64) {
	t.cost += s.cost * share
	t.in += s.in * share
	t.out += s.out * share
	t.cacheRead += s.cacheRead * share
	t.cacheWrite += s.cacheWrite * share
	t.modes.API += s.modes.API * share
	t.modes.PaidUSD += s.modes.PaidUSD * share
	for _, p := range [][2]**float64{{&t.modes.FiveHour, &s.modes.FiveHour}, {&t.modes.SevenDay, &s.modes.SevenDay}, {&t.modes.Subscription, &s.modes.Subscription}} {
		if *p[0] == nil || *p[1] == nil {
			*p[0] = nil
		} else {
			*p[0] = fp(**p[0] + **p[1]*share)
		}
	}
}

func scaledDrill(t drillTot, share float64) drillTot {
	o := zeroDrill()
	o.add(t, share)
	return o
}

// rounded is roundTot: the cost to six places, whole tokens, rounded units.
func (t drillTot) rounded() drillTot {
	return drillTot{issueRound(t.cost), round(t.in), round(t.out), round(t.cacheRead), round(t.cacheWrite), RoundModes(t.modes)}
}

// fields are the Tot's keys, in TS's order, onto o.
func (t drillTot) fields(o *jsjson.Object) *jsjson.Object {
	o.Set("cost_usd", t.cost)
	o.Set("tokens_in", t.in)
	o.Set("tokens_out", t.out)
	o.Set("tokens_cache_read", t.cacheRead)
	o.Set("tokens_cache_write", t.cacheWrite)
	o.Set("modes", t.modes.JSON())
	return o
}

func (t drillTot) json() *jsjson.Object { return t.fields(jsjson.NewObject()) }

// drillTotOf is totOf: a row's Tot, its cost converted to every unit from its own account's spend.
func drillTotOf(r *jsjson.Object, dctx DisplayCtx) drillTot {
	cost := numOf(field(r, "cost_usd"))
	return drillTot{cost, numOf(field(r, "tokens_in")), numOf(field(r, "tokens_out")),
		numOf(field(r, "tokens_cache_read")), numOf(field(r, "tokens_cache_write")),
		RoundModes(Convert([]AccountCost{{Account: jsText(field(r, "account")), API: cost}}, dctx, nil))}
}

func dayKey(ms float64) string      { return isoMs(ms)[:10] }
func dayStartIso(day string) string { return day + "T00:00:00.000Z" }
func hourKey(ms float64) string     { return isoMs(math.Floor(ms/3_600_000) * 3_600_000) }

// bucketKey is an ISO sample time's bucket, sliced.
func bucketKey(iso, bucket string) string {
	if bucket == "hour" {
		return iso[:13] + ":00:00.000Z"
	}
	return iso[:10]
}

// drillCtx is src/usage-drill.ts Ctx: one request's agents, parent edges, memoized tree roots, ITSA keys and issue
// attribution.
type drillCtx struct {
	l         *Lifecycle
	ctx       context.Context
	agents    map[string]db.Agent
	parents   map[string][]string
	roots     map[string]string
	peerNames map[string]string
	// managers have a child agent, as issue-costs counts them.
	managers map[string]bool
	// itsaMeta is each ITSA by id, in table order (itsaOrder).
	itsaMeta  map[string]itsaMeta
	itsaOrder []string
	attribute func(agent string, t float64) []*issueItem
}

// itsaMeta is src/usage-drill.ts ItsaMeta.
type itsaMeta struct {
	key, title, status string
	owner, parent      *string
}

func (l *Lifecycle) newDrillCtx(ctx context.Context) (*drillCtx, error) {
	agents, err := l.db.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	edges, err := l.db.TreeEdges(ctx)
	if err != nil {
		return nil, err
	}
	d := &drillCtx{l: l, ctx: ctx, agents: map[string]db.Agent{}, parents: map[string][]string{}, roots: map[string]string{}, peerNames: map[string]string{},
		managers: map[string]bool{}, itsaMeta: map[string]itsaMeta{}}
	for _, a := range agents {
		d.agents[a.ID] = a
	}
	for _, e := range edges {
		d.parents[e[0]] = append(d.parents[e[0]], e[1])
		d.managers[e[1]] = true
	}
	rows, err := l.db.Objects(ctx, "SELECT id, key, title, status, owner, parent_id FROM itsas")
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		id := jsText(field(r, "id"))
		d.itsaMeta[id] = itsaMeta{jsText(field(r, "key")), jsText(field(r, "title")), jsText(field(r, "status")), optText(field(r, "owner")), optText(field(r, "parent_id"))}
		d.itsaOrder = append(d.itsaOrder, id)
	}
	return d, nil
}

// nameOf is src/usage-drill.ts nameOf: an agent's name, a peer agent's remembered one, else the id.
func (d *drillCtx) nameOf(id string) (string, error) {
	if a, ok := d.agents[id]; ok {
		return a.Name, nil
	}
	if n, ok := d.peerNames[id]; ok {
		return n, nil
	}
	rows, err := d.l.db.Objects(d.ctx, "SELECT name FROM peer_agents WHERE id = ?", id)
	if err != nil {
		return "", err
	}
	name := id
	if len(rows) > 0 {
		name = jsText(field(rows[0], "name"))
	}
	d.peerNames[id] = name
	return name, nil
}

// rootOf is src/usage-drill.ts rootOf: the lexicographically smallest top ancestor, memoized for the agent asked about.
func (d *drillCtx) rootOf(id string) string {
	if r, ok := d.roots[id]; ok && r != "" {
		return r
	}
	seen := map[string]bool{}
	var tops []string
	stack := []string{id}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		if ps := d.parents[cur]; len(ps) > 0 {
			stack = append(stack, ps...)
		} else {
			tops = append(tops, cur)
		}
	}
	root := id
	if len(tops) > 0 {
		sort.Strings(tops)
		root = tops[0]
	}
	d.roots[id] = root
	return root
}

// drillLeaf is src/usage-drill.ts Leaf: a bucket, a group (plus a harness for the model group), and its spend.
type drillLeaf struct {
	id, name, t, harness string
	tot                  drillTot
}

// keyFor is src/usage-drill.ts keyFor: a leaf's group id, name and harness for a non-ITSA series.
func (d *drillCtx) keyFor(group, agent, harness, model string) (id, name, h string, err error) {
	or := func(s string) string {
		if s == "" {
			return "unknown"
		}
		return s
	}
	switch group {
	case "tree":
		root := d.rootOf(agent)
		name, err := d.nameOf(root)
		return root, name, "", err
	case "agent":
		name, err := d.nameOf(agent)
		return agent, name, "", err
	case "harness":
		return or(harness), or(harness), "", nil
	case "model":
		return or(harness) + modelSep + or(model), or(model), or(harness), nil
	}
	return otherID, "Other", "", nil
}

// SeriesOptions is src/usage-drill.ts SeriesOpts: the days (1 to MaxDrillDays), the group, the time, and for an
// agent's token the agents it may see and the ITSAs it may read (nil for the human, the CLI and the bosses).
type SeriesOptions struct {
	Days    float64
	Group   string
	Now     float64
	Visible map[string]bool
	MayItsa func(key string) bool
}

// leavesFor is src/usage-drill.ts leavesFor: the leaves of [from, to) in the bucket; a day bucket runs over whole
// calendar days, dayUntil exclusive.
func (d *drillCtx) leavesFor(dctx DisplayCtx, o SeriesOptions, from, to float64, bucket, dayUntil string) ([]drillLeaf, error) {
	if o.Group == "itsa" {
		f, t := isoMs(from), isoMs(to)
		if bucket != "hour" {
			f, t = dayStartIso(dayKey(from)), dayStartIso(dayUntil)
		}
		return d.itsaLeaves(dctx, f, t, bucket, o.MayItsa)
	}
	hidden := func(agent string) bool {
		return (o.Group == "tree" || o.Group == "agent") && o.Visible != nil && !o.Visible[agent]
	}
	var out []drillLeaf
	push := func(agent, harness, model, t string, tot drillTot) error {
		if hidden(agent) {
			out = append(out, drillLeaf{id: otherID, name: "Other", t: t, tot: tot})
			return nil
		}
		id, name, h, err := d.keyFor(o.Group, agent, harness, model)
		out = append(out, drillLeaf{id: id, name: name, t: t, harness: h, tot: tot})
		return err
	}
	modelOr := func(r *jsjson.Object) string {
		if m := jsText(field(r, "model")); m != "" {
			return m
		}
		return "unknown"
	}
	if bucket == "hour" {
		rows, err := d.sampleRows(isoMs(from), isoMs(to))
		if err != nil {
			return nil, err
		}
		for _, s := range rows {
			if err := push(jsText(field(s, "agent_id")), jsText(field(s, "harness")), modelOr(s), hourKey(msOr(field(s, "bucket"))), drillTotOf(s, dctx)); err != nil {
				return nil, err
			}
		}
		return out, nil
	}
	rows, err := d.dailyRows(dayKey(from), dayUntil)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		if err := push(jsText(field(r, "agent_id")), jsText(field(r, "harness")), modelOr(r), jsText(field(r, "day")), drillTotOf(r, dctx)); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// dailyRows is src/usage-drill.ts dailyRows before conversion: the usage table per agent, account, harness, model and
// day over [since, until).
func (d *drillCtx) dailyRows(since, until string) ([]*jsjson.Object, error) {
	return d.l.db.Objects(d.ctx, `SELECT agent_id, account, harness, model, day, SUM(cost_usd) AS cost_usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
         SUM(tokens_cache_read) AS tokens_cache_read, SUM(tokens_cache_write) AS tokens_cache_write
       FROM usage WHERE day >= ? AND day < ? GROUP BY agent_id, account, harness, model, day ORDER BY day`, since, until)
}

func (d *drillCtx) sampleRows(from, to string) ([]*jsjson.Object, error) {
	return d.l.db.Objects(d.ctx, `SELECT agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write
       FROM usage_samples WHERE bucket >= ? AND bucket < ? ORDER BY bucket`, from, to)
}

// itsaLeaves is src/usage-drill.ts itsaLeaves: each sample split among the ITSAs its agent was on then; a sample on
// none goes to "Unattributed".
func (d *drillCtx) itsaLeaves(dctx DisplayCtx, from, to, bucket string, mayItsa func(string) bool) ([]drillLeaf, error) {
	if d.attribute == nil {
		_, _, attribute, err := d.l.buildIssueItems(d.ctx)
		if err != nil {
			return nil, err
		}
		d.attribute = attribute
	}
	rows, err := d.sampleRows(from, to)
	if err != nil {
		return nil, err
	}
	var out []drillLeaf
	for _, s := range rows {
		iso := jsText(field(s, "bucket"))
		t := bucketKey(iso, bucket)
		base := drillTotOf(s, dctx)
		split := d.attribute(jsText(field(s, "agent_id")), msOr(field(s, "bucket")))
		placed := false
		for _, x := range split {
			m, ok := d.itsaMeta[x.id]
			if !ok {
				continue
			}
			key := m.key
			placed = true
			id, name := key, key
			if mayItsa != nil && !mayItsa(key) {
				id, name = otherID, "Other"
			}
			out = append(out, drillLeaf{id: id, name: name, t: t, tot: scaledDrill(base, 1/float64(len(split)))})
		}
		if !placed {
			out = append(out, drillLeaf{id: "unattributed", name: "Unattributed", t: t, tot: base})
		}
	}
	return out, nil
}

// drillGroup is src/usage-drill.ts Group.
type drillGroup struct{ id, name, harness string }

func (g drillGroup) json() *jsjson.Object {
	o := jsjson.NewObject("id", g.id, "name", g.name)
	if g.harness != "" {
		o.Set("harness", g.harness)
	}
	return o
}

// bucketSums is a bucket's spend per group id, in insertion order.
type bucketSums struct {
	order []string
	m     map[string]*drillTot
}

func (b *bucketSums) add(id string, t drillTot) {
	if b.m == nil {
		b.m = map[string]*drillTot{}
	}
	cur, ok := b.m[id]
	if !ok {
		z := zeroDrill()
		cur = &z
		b.m[id] = cur
		b.order = append(b.order, id)
	}
	cur.add(t, 1)
}

// drillRow is one bucket's row: its time, its rounded total and each legend group's rounded spend.
type drillRow struct {
	t      string
	total  drillTot
	order  []string
	groups map[string]drillTot
}

func (r drillRow) json() *jsjson.Object {
	g := jsjson.NewObject()
	for _, id := range r.order {
		g.Set(id, r.groups[id].json())
	}
	o := r.total.fields(jsjson.NewObject("t", r.t))
	o.Set("groups", g)
	return o
}

// bucketRows is src/usage-drill.ts bucketRows: one row per bucket over the groups, ids outside chosen folded into
// Other, every group in every row.
func bucketRows(perBucket map[string]*bucketSums, keys []string, groups []drillGroup, chosen map[string]bool) []drillRow {
	uniq := map[string]bool{}
	var ts []string
	for _, k := range keys {
		if !uniq[k] {
			uniq[k] = true
			ts = append(ts, k)
		}
	}
	sort.Strings(ts)
	rows := make([]drillRow, len(ts))
	for i, t := range ts {
		row := drillRow{t: t, groups: map[string]drillTot{}}
		for _, g := range groups {
			if _, ok := row.groups[g.id]; !ok {
				row.order = append(row.order, g.id)
			}
			row.groups[g.id] = zeroDrill()
		}
		if b := perBucket[t]; b != nil {
			for _, id := range b.order {
				into := id
				if !chosen[id] {
					into = otherID
				}
				cur, ok := row.groups[into]
				if !ok {
					// TS adds into a missing Other here and throws; a zero-cost leaf outside the legend is all that
					// reaches it (previousRows adds Other for any spend), so it is dropped.
					continue
				}
				cur.add(*b.m[id], 1)
				row.groups[into] = cur
			}
		}
		total := zeroDrill()
		for _, id := range row.order {
			r := row.groups[id].rounded()
			row.groups[id] = r
			total.add(r, 1)
		}
		row.total = total.rounded()
		rows[i] = row
	}
	return rows
}

// drillAggregate is src/usage-drill.ts Aggregate.
type drillAggregate struct {
	groups []drillGroup
	rows   []drillRow
	total  drillTot
}

// aggregate is src/usage-drill.ts aggregate: the top 5 groups by period cost plus Other, one row per bucket.
func aggregate(leaves []drillLeaf, keys []string) drillAggregate {
	meta := map[string]drillGroup{}
	var order []string
	perGroup := map[string]*drillTot{}
	perBucket := map[string]*bucketSums{}
	buckets := append([]string(nil), keys...)
	for _, l := range leaves {
		if _, ok := meta[l.id]; !ok {
			meta[l.id] = drillGroup{l.id, l.name, l.harness}
		}
		g, ok := perGroup[l.id]
		if !ok {
			z := zeroDrill()
			g = &z
			perGroup[l.id] = g
			order = append(order, l.id)
		}
		g.add(l.tot, 1)
		b := perBucket[l.t]
		if b == nil {
			b = &bucketSums{}
			perBucket[l.t] = b
		}
		b.add(l.id, l.tot)
		buckets = append(buckets, l.t)
	}
	var top []string
	for _, id := range order {
		if id != otherID {
			top = append(top, id)
		}
	}
	sort.SliceStable(top, func(i, j int) bool {
		a, b := perGroup[top[i]].cost, perGroup[top[j]].cost
		if a != b {
			return a > b
		}
		return localeCompare(top[i], top[j]) < 0
	})
	if len(top) > 5 {
		top = top[:5]
	}
	chosen := setOf(top)
	hasOther := false
	for _, id := range order {
		hasOther = hasOther || !chosen[id]
	}
	var groups []drillGroup
	for _, id := range top {
		groups = append(groups, meta[id])
	}
	if hasOther {
		groups = append(groups, drillGroup{id: otherID, name: "Other"})
	}
	total := zeroDrill()
	for _, id := range order {
		total.add(*perGroup[id], 1)
	}
	return drillAggregate{groups, bucketRows(perBucket, buckets, groups, chosen), total}
}

// previousRows is src/usage-drill.ts previousRows: the previous period bucketed by the current legend; a group outside
// it folds into Other, which the legend gains (zero in the current rows) when spend folded and it had none.
func previousRows(leaves []drillLeaf, keys []string, agg *drillAggregate) []drillRow {
	chosen := map[string]bool{}
	hasOther := false
	for _, g := range agg.groups {
		if g.id != otherID {
			chosen[g.id] = true
		} else {
			hasOther = true
		}
	}
	perBucket := map[string]*bucketSums{}
	folded := false
	for _, l := range leaves {
		b := perBucket[l.t]
		if b == nil {
			b = &bucketSums{}
			perBucket[l.t] = b
		}
		b.add(l.id, l.tot)
		if !chosen[l.id] && l.tot.cost > 0 {
			folded = true
		}
	}
	if folded && !hasOther {
		agg.groups = append(agg.groups, drillGroup{id: otherID, name: "Other"})
		for i := range agg.rows {
			if _, ok := agg.rows[i].groups[otherID]; !ok {
				agg.rows[i].order = append(agg.rows[i].order, otherID)
			}
			agg.rows[i].groups[otherID] = zeroDrill().rounded()
		}
	}
	return bucketRows(perBucket, keys, agg.groups, chosen)
}

// SpendSeries is src/usage-drill.ts spendSeries (GET /api/usage/series): one row per day (per hour for days=1) over the
// top 5 groups plus Other, the same-length period before it, and both periods' totals.
func (l *Lifecycle) SpendSeries(ctx context.Context, o SeriesOptions) (*jsjson.Object, error) {
	now, days := o.Now, o.Days
	d, err := l.newDrillCtx(ctx)
	if err != nil {
		return nil, err
	}
	reads, err := l.AccountReadings(ctx, now)
	if err != nil {
		return nil, err
	}
	snap, err := l.snapshotOf(ctx, reads, 14, now)
	if err != nil {
		return nil, err
	}
	dctx := newSnapshotCtx(l.settings.Get(), snap.worths)
	bucket := "day"
	if days <= 1 {
		bucket = "hour"
	}
	from := now - days*dayMs
	spanDays := days
	if bucket == "day" {
		spanDays = days + 1
	}
	cur, err := d.leavesFor(dctx, o, from, now, bucket, dayKey(now+dayMs))
	if err != nil {
		return nil, err
	}
	prev, err := d.leavesFor(dctx, o, from-spanDays*dayMs, from, bucket, dayKey(from))
	if err != nil {
		return nil, err
	}
	step, key, count, prevCount := dayMs, dayKey, days+1, spanDays
	if bucket == "hour" {
		step, key, count, prevCount = 3_600_000, hourKey, 25, 24
	}
	if count != math.Trunc(count) || prevCount != math.Trunc(prevCount) {
		return nil, errSeriesDays
	}
	keysOf := func(start float64, n float64) []string {
		out := make([]string, int(n))
		for i := range out {
			out[i] = key(start + float64(i)*step)
		}
		return out
	}
	agg := aggregate(cur, keysOf(from, count))
	prevRows := previousRows(prev, keysOf(from-prevCount*step, prevCount), &agg)
	sum := zeroDrill()
	for _, l := range prev {
		sum.add(l.tot, 1)
	}
	groups := make([]jsjson.Value, len(agg.groups))
	for i, g := range agg.groups {
		groups[i] = g.json()
	}
	rowsJSON := func(rows []drillRow) []jsjson.Value {
		out := make([]jsjson.Value, len(rows))
		for i, r := range rows {
			out[i] = r.json()
		}
		return out
	}
	return jsjson.NewObject("note", SeriesNote, "days", days, "group", o.Group, "bucket", bucket, "groups", groups,
		"rows", rowsJSON(agg.rows), "previous_rows", rowsJSON(prevRows), "total", agg.total.rounded().json(), "previous", sum.rounded().json()), nil
}

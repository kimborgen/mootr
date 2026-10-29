package lifecycle

import (
	"context"
	"sort"
	"strings"

	"stam/internal/jsjson"
)

// The drill scope (src/usage-drill.ts drillScope, S-657, S-3807): one drilled tree, ITSA, model, harness or agent for
// the Usage page: its totals (own, children and total for an ITSA), its share of each subscription window, spend over
// time by agent, the agents and models tables, and for an ITSA its child ITSAs and typical cost. An agent's token's
// rows hold only the agents it may see.

// ScopeNote is src/usage-drill.ts SCOPE_NOTE.
const ScopeNote = "totals are the scope's cost and tokens over the period; an ITSA carries own, children and total, where total is own plus every descendant ITSA. windows is the scope's estimated share of each subscription window. by_agent is the agents table (in, out, cache read, cache write, cost), by_model the same by harness and model, and timeseries the spend over time by agent."

// ScopeOptions is src/usage-drill.ts ScopeOpts. Ref is the agent id for a tree or agent, the ITSA key for an ITSA, the
// model (bare, or `harness · model`) or the harness. Harness goes with a bare model. Since (ms) and Bucket (hour or
// day) are an ITSA's own span; Visible and MayItsa scope an agent's token (nil for the human, the CLI and the bosses).
type ScopeOptions struct {
	Days      float64
	Kind, Ref string
	Harness   string
	Since     *float64
	Bucket    string
	Now       float64
	Visible   map[string]bool
	MayItsa   func(key string) bool
}

// scopeRow is src/usage-drill.ts RawRow: a usage row before grouping.
type scopeRow struct {
	agent, harness, model, t string
	tot                      drillTot
}

// bucketKeys is src/usage-drill.ts bucketKeys: every bucket key from `from` through now's.
func bucketKeys(from, now float64, bucket string) []string {
	step, key := dayMs, dayKey
	if bucket == "hour" {
		step, key = 3_600_000, hourKey
	}
	var out []string
	for t := from; ; t += step {
		out = append(out, key(t))
		if key(t+step) > key(now) {
			break
		}
	}
	return out
}

// modelSelector is src/usage-drill.ts modelSelector: a model scope's harness (empty for any) and model.
func modelSelector(o ScopeOptions) (harness, model string) {
	if o.Harness != "" {
		return o.Harness, o.Ref
	}
	if i := strings.Index(o.Ref, modelSep); i >= 0 {
		return o.Ref[:i], o.Ref[i+len(modelSep):]
	}
	return "", o.Ref
}

// drillDisplay is src/usage-drill.ts drillCtx with displayContext: the cached snapshot and its display context.
func (l *Lifecycle) drillDisplay(ctx context.Context, now float64) (snapshot, snapshotCtx, error) {
	reads, err := l.AccountReadings(ctx, now)
	if err != nil {
		return snapshot{}, snapshotCtx{}, err
	}
	snap, err := l.snapshotOf(ctx, reads, 14, now)
	if err != nil {
		return snapshot{}, snapshotCtx{}, err
	}
	return snap, newSnapshotCtx(l.settings.Get(), snap.worths), nil
}

// DrillScope is src/usage-drill.ts drillScope (GET /api/usage/scope).
func (l *Lifecycle) DrillScope(ctx context.Context, o ScopeOptions) (*jsjson.Object, error) {
	now := o.Now
	own := o.Kind == "itsa"
	from := now - o.Days*dayMs
	if own && o.Since != nil {
		from = min(max(*o.Since, now-sampleRetentionMs), now)
	}
	bucket := "day"
	if own && o.Bucket != "" {
		bucket = o.Bucket
	} else if o.Days <= 1 {
		bucket = "hour"
	}
	d, err := l.newDrillCtx(ctx)
	if err != nil {
		return nil, err
	}
	snap, dctx, err := l.drillDisplay(ctx, now)
	if err != nil {
		return nil, err
	}
	if own {
		return d.itsaScope(dctx, o, from, now, bucket)
	}
	return d.plainScope(snap, dctx, o, from, now, bucket)
}

// scopeRows is src/usage-drill.ts scopeRows: the rows of a non-ITSA scope (tree members, one agent, a model or a
// harness), only the visible agents' when Visible is set.
func (d *drillCtx) scopeRows(x *treeIndex, dctx DisplayCtx, o ScopeOptions, from, now float64, bucket string) ([]scopeRow, error) {
	var members map[string]bool
	switch o.Kind {
	case "tree":
		members = setOf(x.members(o.Ref))
	case "agent":
		members = map[string]bool{o.Ref: true}
	}
	mh, mm := modelSelector(o)
	keep := func(agent, harness, model string) bool {
		if o.Visible != nil && !o.Visible[agent] {
			return false
		}
		if members != nil && !members[agent] {
			return false
		}
		if o.Kind == "model" && ((mh != "" && harness != mh) || model != mm) {
			return false
		}
		return o.Kind != "harness" || harness == o.Ref
	}
	modelOr := func(r *jsjson.Object) string {
		if m := jsText(field(r, "model")); m != "" {
			return m
		}
		return "unknown"
	}
	var out []scopeRow
	if bucket == "hour" {
		rows, err := d.sampleRows(isoMs(from), isoMs(now))
		if err != nil {
			return nil, err
		}
		for _, s := range rows {
			agent, harness, m := jsText(field(s, "agent_id")), jsText(field(s, "harness")), modelOr(s)
			if keep(agent, harness, m) {
				out = append(out, scopeRow{agent, harness, m, hourKey(msOr(field(s, "bucket"))), drillTotOf(s, dctx)})
			}
		}
		return out, nil
	}
	rows, err := d.dailyRows(dayKey(from), dayKey(now+dayMs))
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		agent, harness, m := jsText(field(r, "agent_id")), jsText(field(r, "harness")), modelOr(r)
		if keep(agent, harness, m) {
			out = append(out, scopeRow{agent, harness, m, jsText(field(r, "day")), drillTotOf(r, dctx)})
		}
	}
	return out, nil
}

// scopeDescriptor is src/usage-drill.ts scopeDescriptor: the scope's kind, id and name as the series names its group.
func (d *drillCtx) scopeDescriptor(o ScopeOptions) (*jsjson.Object, error) {
	switch o.Kind {
	case "model":
		h, m := modelSelector(o)
		id := m
		if h != "" {
			id = h + modelSep + m
		}
		out := jsjson.NewObject("kind", "model", "id", id, "name", m)
		if h != "" {
			out.Set("harness", h)
		}
		return out, nil
	case "tree", "agent":
		name, err := d.nameOf(o.Ref)
		return jsjson.NewObject("kind", o.Kind, "id", o.Ref, "name", name), err
	}
	return jsjson.NewObject("kind", o.Kind, "id", o.Ref, "name", o.Ref), nil
}

func (d *drillCtx) plainScope(snap snapshot, dctx snapshotCtx, o ScopeOptions, from, now float64, bucket string) (*jsjson.Object, error) {
	x, err := d.l.treeIndex(d.ctx)
	if err != nil {
		return nil, err
	}
	rows, err := d.scopeRows(x, dctx, o, from, now, bucket)
	if err != nil {
		return nil, err
	}
	total := zeroDrill()
	for _, r := range rows {
		total.add(r.tot, 1)
	}
	// A tree's window share is its every member's, not only those with rows this period.
	var members []string
	switch o.Kind {
	case "tree":
		members = x.members(o.Ref)
	case "agent":
		members = []string{o.Ref}
	default:
		seen := map[string]bool{}
		for _, r := range rows {
			if !seen[r.agent] {
				seen[r.agent] = true
				members = append(members, r.agent)
			}
		}
	}
	scope, err := d.scopeDescriptor(o)
	if err != nil {
		return nil, err
	}
	windows, err := d.windowSharesFor(snap, dctx, members, now)
	if err != nil {
		return nil, err
	}
	series, err := d.timeseries(rows, bucketKeys(from, now, bucket))
	if err != nil {
		return nil, err
	}
	return jsjson.NewObject("note", ScopeNote, "days", o.Days, "bucket", bucket, "scope", scope, "totals", total.rounded().json(),
		"windows", windows, "timeseries", series, "by_agent", d.byAgent(rows), "by_model", byModelRows(rows)), nil
}

// byAgent is src/usage-drill.ts aggregateBy by agent: the agents table, costliest first.
func (d *drillCtx) byAgent(rows []scopeRow) []jsjson.Value {
	var order []string
	tots := map[string]*drillTot{}
	for _, r := range rows {
		t, ok := tots[r.agent]
		if !ok {
			z := zeroDrill()
			t = &z
			tots[r.agent] = t
			order = append(order, r.agent)
		}
		t.add(r.tot, 1)
	}
	type row struct {
		obj  *jsjson.Object
		cost float64
	}
	out := make([]row, len(order))
	for i, id := range order {
		t := tots[id].rounded()
		o := jsjson.NewObject("id", id, "name", id, "role", nil, "harness", nil, "model", nil)
		if a, ok := d.agents[id]; ok {
			var model jsjson.Value
			if a.Model != nil {
				model = *a.Model
			}
			o = jsjson.NewObject("id", id, "name", a.Name, "role", a.Role, "harness", a.Harness, "model", model)
		}
		out[i] = row{t.fields(o), t.cost}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].cost > out[j].cost })
	vals := make([]jsjson.Value, len(out))
	for i, r := range out {
		vals[i] = r.obj
	}
	return vals
}

// byModelRows is src/usage-drill.ts aggregateBy by harness and model: the models table, costliest first.
func byModelRows(rows []scopeRow) []jsjson.Value {
	type acc struct {
		harness, model string
		tot            drillTot
	}
	var order []string
	tots := map[string]*acc{}
	for _, r := range rows {
		k := r.harness + "\x00" + r.model
		a, ok := tots[k]
		if !ok {
			a = &acc{r.harness, r.model, zeroDrill()}
			tots[k] = a
			order = append(order, k)
		}
		a.tot.add(r.tot, 1)
	}
	type row struct {
		obj  *jsjson.Object
		cost float64
	}
	out := make([]row, len(order))
	for i, k := range order {
		a := tots[k]
		t := a.tot.rounded()
		out[i] = row{t.fields(jsjson.NewObject("harness", a.harness, "model", a.model)), t.cost}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].cost > out[j].cost })
	vals := make([]jsjson.Value, len(out))
	for i, r := range out {
		vals[i] = r.obj
	}
	return vals
}

// timeseries is src/usage-drill.ts timeseries: the spend over time by agent, top 5 agents plus Other.
func (d *drillCtx) timeseries(rows []scopeRow, keys []string) (*jsjson.Object, error) {
	leaves := make([]drillLeaf, len(rows))
	for i, r := range rows {
		name, err := d.nameOf(r.agent)
		if err != nil {
			return nil, err
		}
		leaves[i] = drillLeaf{id: r.agent, name: name, t: r.t, tot: r.tot}
	}
	agg := aggregate(leaves, keys)
	groups := make([]jsjson.Value, len(agg.groups))
	for i, g := range agg.groups {
		groups[i] = g.json()
	}
	out := make([]jsjson.Value, len(agg.rows))
	for i, r := range agg.rows {
		out[i] = r.json()
	}
	return jsjson.NewObject("group", "agent", "groups", groups, "rows", out), nil
}

// windowSharesFor is src/usage-drill.ts windowSharesFor: the members' estimated share of every configured account's
// windows. A member whose share is unknown makes the percent null; a window with no worth and no share is left out.
func (d *drillCtx) windowSharesFor(snap snapshot, dctx snapshotCtx, members []string, now float64) ([]jsjson.Value, error) {
	out := []jsjson.Value{}
	spend := map[string]map[string]float64{}
	// share is src/usage.ts displayContext share: the agent's share of the account's current window, 0 with no use in
	// it, nil when the window isn't calibrated and the agent has spend in it.
	share := func(agent, account, window string) (*float64, error) {
		for _, w := range snap.windows {
			if w.account == account && w.window == window {
				if w.shares.scale != nil {
					return fp(w.shares.agents[agent]), nil
				}
				break
			}
		}
		k := account + "|" + window
		if spend[k] == nil {
			start, err := d.l.windowStart(d.ctx, account, window, now)
			if err != nil {
				return nil, err
			}
			rows, err := d.l.db.Objects(d.ctx, "SELECT agent_id, SUM(cost_usd) AS c FROM usage_samples WHERE account = ? AND bucket >= ? GROUP BY agent_id", account, isoMs(start))
			if err != nil {
				return nil, err
			}
			spend[k] = map[string]float64{}
			for _, r := range rows {
				spend[k][jsText(field(r, "agent_id"))] = numOf(field(r, "c"))
			}
		}
		if spend[k][agent] > 0 {
			return nil, nil
		}
		return fp(0), nil
	}
	for _, account := range d.l.settings.Get().CostShape.AccountOrder {
		for _, window := range issueWins {
			worth := dctx.Worth(account, window)
			percent := fp(0)
			for _, id := range members {
				s, err := share(id, account, window)
				if err != nil {
					return nil, err
				}
				if s == nil {
					percent = nil
					break
				}
				percent = fp(*percent + *s)
			}
			if worth == nil && !(percent != nil && *percent > 0) {
				continue
			}
			var p *float64
			if percent != nil {
				p = fp(round(*percent*100) / 100)
			}
			out = append(out, jsjson.NewObject("account", account, "window", window, "percent", optNumber(p), "worth_usd", optNumber(worth)))
		}
	}
	return out, nil
}

// itsaSubtree is src/usage-drill.ts itsaSubtree: every ITSA at or below root, each once, in visiting order.
func (d *drillCtx) itsaSubtree(root string, children map[string][]string) []string {
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

// ErrNoItsa is an ITSA scope whose ref names no ITSA.
type ErrNoItsa struct{ Ref string }

func (e ErrNoItsa) Error() string { return "no ITSA " + e.Ref }

func (d *drillCtx) itsaScope(dctx snapshotCtx, o ScopeOptions, from, now float64, bucket string) (*jsjson.Object, error) {
	var foundID string
	for _, id := range d.itsaOrder {
		if id == o.Ref || d.itsaMeta[id].key == o.Ref {
			foundID = id
			break
		}
	}
	if foundID == "" {
		return nil, ErrNoItsa{o.Ref}
	}
	found := d.itsaMeta[foundID]
	if d.attribute == nil {
		_, _, attribute, err := d.l.buildIssueItems(d.ctx)
		if err != nil {
			return nil, err
		}
		d.attribute = attribute
	}
	children := map[string][]string{}
	for _, id := range d.itsaOrder {
		if p := d.itsaMeta[id].parent; p != nil && *p != "" {
			children[*p] = append(children[*p], id)
		}
	}
	subtree := setOf(d.itsaSubtree(foundID, children))
	fromIso, toIso := isoMs(from), isoMs(now)
	if bucket != "hour" {
		fromIso, toIso = dayStartIso(dayKey(from)), dayStartIso(dayKey(now+dayMs))
	}
	kind := KindResolver(d.l.settings.Get())

	var perOrder []string
	perItsa := map[string]*drillTot{}
	var ownConfigs, ownWorkerConfigs orderedSums
	var inWindow [2]orderedSums
	starts := map[string]float64{}
	var rows []scopeRow
	samples, err := d.sampleRows(fromIso, toIso)
	if err != nil {
		return nil, err
	}
	for _, s := range samples {
		agent := jsText(field(s, "agent_id"))
		t := msOr(field(s, "bucket"))
		split := d.attribute(agent, t)
		var kept []string
		for _, x := range split {
			if subtree[x.id] {
				kept = append(kept, x.id)
			}
		}
		if len(kept) == 0 {
			continue
		}
		each := 1 / float64(len(split))
		base := drillTotOf(s, dctx)
		for _, id := range kept {
			p, ok := perItsa[id]
			if !ok {
				z := zeroDrill()
				p = &z
				perItsa[id] = p
				perOrder = append(perOrder, id)
			}
			p.add(scaledDrill(base, each), 1)
		}
		ownShare, hasOwn := 0.0, false
		for _, id := range kept {
			if id == foundID {
				ownShare += each
				hasOwn = true
			}
		}
		model := jsText(field(s, "model"))
		if model == "" {
			model = "unknown"
		}
		harness := jsText(field(s, "harness"))
		if hasOwn {
			config := harness + modelSep + model
			if d.managers[agent] {
				ownConfigs.add(config, base.cost*ownShare)
			} else {
				ownWorkerConfigs.add(config, base.cost*ownShare)
			}
		}
		keptShare := 0.0
		for range kept {
			keptShare += each
		}
		account := jsText(field(s, "account"))
		if kind(account) == "subscription" {
			for w, win := range issueWins {
				k := account + "|" + win
				start, ok := starts[k]
				if !ok {
					if start, err = d.l.windowStart(d.ctx, account, win, now); err != nil {
						return nil, err
					}
					starts[k] = start
				}
				if t >= start {
					inWindow[w].add(account, base.cost*keptShare)
				}
			}
		}
		if o.Visible == nil || o.Visible[agent] {
			rows = append(rows, scopeRow{agent, harness, model, bucketKey(jsText(field(s, "bucket")), bucket), scaledDrill(base, keptShare)})
		}
	}

	own := zeroDrill()
	if p := perItsa[foundID]; p != nil {
		own = *p
	}
	own = own.rounded()
	childTotal := zeroDrill()
	for _, id := range perOrder {
		if id != foundID {
			childTotal.add(*perItsa[id], 1)
		}
	}
	childSum := childTotal.rounded()
	sum := own
	sum.add(childSum, 1)
	config := topKey(ownWorkerConfigs)
	if config == nil {
		config = topKey(ownConfigs)
	}

	type child struct {
		obj  *jsjson.Object
		cost float64
		key  string
	}
	var kids []child
	for _, id := range d.itsaOrder {
		m := d.itsaMeta[id]
		if m.parent == nil || *m.parent != foundID || (o.MayItsa != nil && !o.MayItsa(m.key)) {
			continue
		}
		t := zeroDrill()
		for _, sub := range d.itsaSubtree(id, children) {
			if p := perItsa[sub]; p != nil {
				t.add(*p, 1)
			}
		}
		t = t.rounded()
		var owner jsjson.Value
		if m.owner != nil && *m.owner != "" {
			name, err := d.nameOf(*m.owner)
			if err != nil {
				return nil, err
			}
			owner = name
		}
		kids = append(kids, child{jsjson.NewObject("key", m.key, "title", m.title, "status", m.status, "owner", owner, "cost_usd", t.cost, "modes", t.modes.JSON()), t.cost, m.key})
	}
	sort.SliceStable(kids, func(i, j int) bool {
		if kids[i].cost != kids[j].cost {
			return kids[i].cost > kids[j].cost
		}
		return localeCompare(kids[i].key, kids[j].key) < 0
	})
	itsas := make([]jsjson.Value, len(kids))
	for i, k := range kids {
		itsas[i] = k.obj
	}

	windows := []jsjson.Value{}
	for w, win := range issueWins {
		for _, account := range inWindow[w].order {
			worth := dctx.Worth(account, win)
			var p *float64
			if worth != nil && *worth > 0 {
				p = fp(round(((100*inWindow[w].m[account])/(*worth))*100) / 100)
			}
			windows = append(windows, jsjson.NewObject("account", account, "window", win, "percent", optNumber(p), "worth_usd", optNumber(worth)))
		}
	}
	series, err := d.timeseries(rows, bucketKeys(from, now, bucket))
	if err != nil {
		return nil, err
	}
	var typical jsjson.Value
	if config != nil {
		t, err := d.l.TypicalIssue(d.ctx, *config, now)
		if err != nil {
			return nil, err
		}
		if t != nil {
			typical = t
		}
	}
	return jsjson.NewObject("note", ScopeNote, "days", o.Days, "bucket", bucket,
		"scope", jsjson.NewObject("kind", "itsa", "id", foundID, "key", found.key, "name", found.key+" "+found.title),
		"totals", jsjson.NewObject("own", own.json(), "children", childSum.json(), "total", sum.rounded().json()),
		"windows", windows, "timeseries", series, "by_agent", d.byAgent(rows), "by_model", byModelRows(rows), "itsas", itsas, "typical", typical), nil
}

package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"time"

	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// The usage summary (src/usage.ts summary, S-3807): GET /api/usage's answer before the route adds the machines and the
// peers' spend and scopes it for an agent's token. Every row's cost comes in every display unit (cost-display.go), from
// the snapshot's own window worths, so the Usage page switches unit without another fetch.

// SummaryNote is src/usage.ts summary's note.
const SummaryNote = "cost_usd is what the harness reports: API-equivalent for Claude Code (not billed on a subscription), provider cost for OpenCode."

// coldNote is src/cache-cold.ts summary's note.
const coldNote = "A cold turn is the first turn after a wake or a compaction whose cache write is over 80% of its context. Codex and OpenCode are not counted."

// decideDaySQL is src/usage.ts DECIDE_DAY_SQL: stam's OpenRouter decide spend per purpose and day, from its events.
const decideDaySQL = `SELECT COALESCE(json_extract(data, '$.purpose'), '') AS purpose, substr(ts, 1, 10) AS day, COUNT(*) AS n,
    SUM(COALESCE(json_extract(data, '$.cost'), 0)) AS cost_usd,
    SUM(COALESCE(json_extract(data, '$.tokens_in'), 0)) AS tokens_in,
    SUM(COALESCE(json_extract(data, '$.tokens_out'), 0)) AS tokens_out
  FROM events WHERE agent_id = 'stam' AND type = 'decide' AND COALESCE(json_extract(data, '$.provider'), 'openrouter') = 'openrouter' GROUP BY purpose, day`

// usageSums is the SUM columns the summary's tables read, in their order.
const usageSums = "ROUND(SUM(cost_usd), 4) AS cost_usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(tokens_cache_read) AS tokens_cache_read, SUM(tokens_cache_write) AS tokens_cache_write"

// usageCounters is src/usage.ts USAGE_COUNTERS.
var usageCounters = []string{"cost_usd", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write"}

// SummaryOptions is what summary takes: the days (Number(days ?? 14)), the agent types to keep (parseAgentFilter; nil
// keeps every agent), how an agent's type is read (src/agent-class.ts typeOf with the chief of staff), the time, and
// the tree agent for usage_info tree= (nil for none). The route resolves Tree once, so the tree view is built for the
// agent its scope check judged, never one a second id-or-name lookup picks.
type SummaryOptions struct {
	Days   float64
	Keep   map[string]bool
	TypeOf func(a db.Agent) string
	Now    float64
	Tree   *db.Agent
}

// errInvalidTime is the RangeError toISOString throws on a time that isn't one, such as days=abc's.
var errInvalidTime = errors.New("Invalid time value")

func numberValue(v jsjson.Value) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		return jsjson.ToNumber(x)
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	}
	return math.NaN()
}

// orZero is `Number(v) || 0`.
func orZero(v jsjson.Value) float64 {
	n := numberValue(v)
	if math.IsNaN(n) {
		return 0
	}
	return n
}

// agentOf is db.getAgent: the agent by id or name, false when there is none.
func (l *Lifecycle) agentOf(ctx context.Context, ref string) (db.Agent, bool, error) {
	a, err := l.db.GetAgent(ctx, ref)
	if errors.Is(err, db.ErrNotFound) {
		return db.Agent{}, false, nil
	}
	return a, err == nil, err
}

// typeOfRef is an id's agent type, untyped when it has no registry row (stam's own decide spend).
func (l *Lifecycle) typeOfRef(ctx context.Context, o SummaryOptions, id string) (string, error) {
	a, ok, err := l.agentOf(ctx, id)
	if err != nil || !ok {
		return "untyped", err
	}
	return o.TypeOf(a), nil
}

// keptAgentIDs is src/usage.ts keptAgentIds: the usage table's ids whose agent type is kept, in the table's order.
func (l *Lifecycle) keptAgentIDs(ctx context.Context, o SummaryOptions) ([]string, map[string]bool, error) {
	rows, err := l.db.Objects(ctx, "SELECT DISTINCT agent_id FROM usage")
	if err != nil {
		return nil, nil, err
	}
	var ids []string
	set := map[string]bool{}
	for _, r := range rows {
		id := jsText(field(r, "agent_id"))
		t, err := l.typeOfRef(ctx, o, id)
		if err != nil {
			return nil, nil, err
		}
		if o.Keep[t] {
			ids, set[id] = append(ids, id), true
		}
	}
	return ids, set, nil
}

// modesBy is src/usage.ts modesBy: the modes for each key of a usage query grouped further by account.
func (l *Lifecycle) modesBy(ctx context.Context, keySQL, where string, params []any, dctx DisplayCtx) (map[string]Modes, error) {
	rows, err := l.db.Objects(ctx, "SELECT "+keySQL+" AS k, account, SUM(cost_usd) AS c FROM usage"+where+" GROUP BY k, account", params...)
	if err != nil {
		return nil, err
	}
	var keys []string
	by := map[string]*orderedSums{}
	for _, r := range rows {
		k := jsText(field(r, "k"))
		m := by[k]
		if m == nil {
			m = &orderedSums{}
			by[k], keys = m, append(keys, k)
		}
		m.add(jsText(field(r, "account")), orZero(field(r, "c")))
	}
	out := map[string]Modes{}
	for _, k := range keys {
		out[k] = RoundModes(Convert(by[k].costs(), dctx, nil))
	}
	return out, nil
}

// accountsOf is src/usage.ts accountsOf: the API-equivalent spend per account for a usage query.
func (l *Lifecycle) accountsOf(ctx context.Context, where string, params []any) ([]AccountCost, error) {
	rows, err := l.db.Objects(ctx, "SELECT account, SUM(cost_usd) AS c FROM usage"+where+" GROUP BY account", params...)
	if err != nil {
		return nil, err
	}
	var s orderedSums
	for _, r := range rows {
		k := jsText(field(r, "account"))
		// new Map(rows.map(...)): a later row for the same account replaces the earlier.
		if s.m == nil {
			s.m = map[string]float64{}
		}
		if _, ok := s.m[k]; !ok {
			s.order = append(s.order, k)
		}
		s.m[k] = orZero(field(r, "c"))
	}
	return s.costs(), nil
}

// totalsRows is src/usage.ts totalsByAgent and totalsByModel: every key's counted rows for one scope.
func (l *Lifecycle) totalsRows(ctx context.Context, group string, key func(*jsjson.Object) string, where string, params []any) (map[string]*jsjson.Object, error) {
	cols := ""
	for _, c := range usageCounters {
		cols += ", SUM(" + c + ") AS " + c
	}
	rows, err := l.db.Objects(ctx, "SELECT "+group+", COUNT(*) AS n"+cols+" FROM usage"+where+" GROUP BY "+group, params...)
	if err != nil {
		return nil, err
	}
	out := map[string]*jsjson.Object{}
	for _, r := range rows {
		out[key(r)] = r
	}
	return out, nil
}

func modelKey(harness string, model jsjson.Value) string {
	m, _ := model.(string)
	return harness + "\x00" + m
}

func byModelKey(r *jsjson.Object) string {
	return modelKey(jsText(field(r, "harness")), field(r, "model"))
}

func byAgentKey(r *jsjson.Object) string { return jsText(field(r, "agent_id")) }

// harnessCounters is src/usage.ts HARNESS_COUNTERS: Codex reports no cost; an unknown harness reports everything.
var harnessCounters = map[string]map[string]bool{
	"codex": {"tokens_in": true, "tokens_out": true, "tokens_cache_read": true, "tokens_cache_write": true},
}

// totalsFor is src/usage.ts totalsFor: a grouped SUM row as totals, a counter the harness doesn't report and every
// counter of a key with no rows null. modes is nil when the caller has none (no modes key), else the modes, or the
// zero modes when the key has none.
func totalsFor(harness string, row *jsjson.Object, modes *Modes, hasModes bool) *jsjson.Object {
	out := jsjson.NewObject()
	for _, k := range usageCounters {
		out.Set(k, nil)
	}
	if hasModes {
		if modes == nil {
			z := ZeroModes()
			modes = &z
		}
		out.Set("modes", modes.JSON())
	}
	if row == nil || orZero(field(row, "n")) == 0 {
		return out
	}
	reports := harnessCounters[harness]
	for _, k := range usageCounters {
		if reports == nil || reports[k] {
			out.Set(k, numberValue(or0(field(row, k))))
		}
	}
	return out
}

// or0 is `v ?? 0` for Number(row[k] ?? 0).
func or0(v jsjson.Value) jsjson.Value {
	if v == nil {
		return 0.0
	}
	return v
}

func modesAt(m map[string]Modes, k string) *Modes {
	if x, ok := m[k]; ok {
		return &x
	}
	return nil
}

// kindCosts is src/attribution.ts kindCosts: a model's tokens priced per kind at the API prices, in USD, each kind null
// when unpriced or unreported, the total only when every reported kind is priced.
func kindCosts(prices map[string]price, model jsjson.Value, t *jsjson.Object) *jsjson.Object {
	none := jsjson.NewObject("cost_in", nil, "cost_out", nil, "cost_cache_read", nil, "cost_cache_write", nil, "cost_api_total", nil)
	name, ok := model.(string)
	if !ok {
		return none
	}
	p, ok := priceOf(prices, name)
	if !ok {
		return none
	}
	tokens := func(k string) *float64 {
		v := field(t, k)
		if v == nil {
			return nil
		}
		n := numberValue(v)
		return &n
	}
	usd := func(tokens, price *float64) *float64 {
		if tokens == nil || price == nil {
			return nil
		}
		v := (*tokens * *price) / 1e6
		return &v
	}
	in := p.input
	kinds := []struct {
		tokens, cost *float64
	}{}
	for _, k := range []struct {
		col   string
		price *float64
	}{{"tokens_in", &in}, {"tokens_out", p.output}, {"tokens_cache_read", p.cacheRead}, {"tokens_cache_write", p.cacheWrite}} {
		tk := tokens(k.col)
		kinds = append(kinds, struct{ tokens, cost *float64 }{tk, usd(tk, k.price)})
	}
	out := jsjson.NewObject("cost_in", optNumber(kinds[0].cost), "cost_out", optNumber(kinds[1].cost), "cost_cache_read", optNumber(kinds[2].cost),
		"cost_cache_write", optNumber(kinds[3].cost), "cost_api_total", nil)
	reported, priced, anyTokens := 0, true, false
	total := 0.0
	for _, k := range kinds {
		if k.tokens != nil {
			anyTokens = true
		}
		if k.tokens == nil || !(*k.tokens > 0) {
			continue
		}
		reported++
		if k.cost == nil {
			priced = false
			continue
		}
		total += *k.cost
	}
	switch {
	case reported > 0 && priced:
		out.Set("cost_api_total", total)
	case reported == 0 && anyTokens:
		out.Set("cost_api_total", 0.0)
	}
	return out
}

// spread copies src's keys onto dst, as {...dst, ...src}.
func spreadInto(dst, src *jsjson.Object) {
	for _, k := range src.Keys() {
		v, _ := src.Get(k)
		dst.Set(k, v)
	}
}

// decideSum is one purpose's decide spend over the days decideSpend accepts.
type decideSum struct{ n, cost, in, out float64 }

// decideSpend is src/usage.ts decideSpend: the decide rows of the days inDay accepts, summed per purpose, in order.
func decideSpend(rows []*jsjson.Object, inDay func(string) bool) ([]string, map[string]*decideSum) {
	var order []string
	out := map[string]*decideSum{}
	for _, r := range rows {
		if !inDay(jsText(field(r, "day"))) {
			continue
		}
		p := jsText(field(r, "purpose"))
		s := out[p]
		if s == nil {
			s = &decideSum{}
			out[p], order = s, append(order, p)
		}
		s.n += numberValue(field(r, "n"))
		s.cost += orZero(field(r, "cost_usd"))
		s.in += orZero(field(r, "tokens_in"))
		s.out += orZero(field(r, "tokens_out"))
	}
	return order, out
}

func (s *decideSum) row() *jsjson.Object {
	if s == nil {
		return nil
	}
	return jsjson.NewObject("n", s.n, "cost_usd", s.cost, "tokens_in", s.in, "tokens_out", s.out)
}

// fromFmt is a jsfmt value as a jsjson one.
func fromFmt(v jsfmt.Value) (jsjson.Value, error) { return jsjson.Parse([]byte(jsfmt.Compact(v))) }

// blocked is src/blockers.ts blocked: every blocked agent with its blockers, in the order of their first blocker.
func (l *Lifecycle) blocked(ctx context.Context) ([]jsjson.Value, error) {
	rows, err := l.db.Objects(ctx, "SELECT * FROM blockers ORDER BY since, rowid")
	if err != nil {
		return nil, err
	}
	var ids []string
	by := map[string][]jsjson.Value{}
	for _, r := range rows {
		if c, _ := field(r, "clear").(string); c != "" {
			parsed, err := jsjson.Parse([]byte(c))
			if err != nil {
				return nil, err
			}
			r.Set("clear", parsed)
		} else {
			r.Set("clear", nil)
		}
		id := jsText(field(r, "agent_id"))
		if _, ok := by[id]; !ok {
			ids = append(ids, id)
		}
		by[id] = append(by[id], r)
	}
	out := []jsjson.Value{}
	for _, id := range ids {
		a, ok, err := l.agentOf(ctx, id)
		if err != nil {
			return nil, err
		}
		name, lc, paused := id, "unknown", []jsjson.Value{}
		if ok {
			name, lc = a.Name, string(a.Lifecycle)
			for _, p := range pauseOwners(a) {
				paused = append(paused, p)
			}
		}
		out = append(out, jsjson.NewObject("agent_id", id, "agent", name, "lifecycle", lc, "paused_by", paused, "blockers", by[id]))
	}
	return out, nil
}

// coldSummary is src/cache-cold.ts summary: cold turns and tokens per day since since, their total, and the live agents
// whose latest detected cache window is 5 minutes.
func (l *Lifecycle) coldSummary(ctx context.Context, since, agentSQL string, agentArg []any) (*jsjson.Object, error) {
	byDay, err := l.db.Objects(ctx, "SELECT substr(ts, 1, 10) AS day, COUNT(*) AS turns, SUM(json_extract(data, '$.tokens')) AS tokens FROM events WHERE type = 'cache:cold' AND ts >= ?"+agentSQL+" GROUP BY day ORDER BY day", append([]any{since}, agentArg...)...)
	if err != nil {
		return nil, err
	}
	rows, err := l.db.Objects(ctx, "SELECT agent_id, json_extract(data, '$.ttl') AS ttl, ts FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE type = 'cache:ttl'"+agentSQL+" GROUP BY agent_id)", agentArg...)
	if err != nil {
		return nil, err
	}
	turns, tokens := 0.0, 0.0
	days := make([]jsjson.Value, len(byDay))
	for i, r := range byDay {
		days[i] = r
		turns += numberValue(field(r, "turns"))
		tokens += numberValue(or0(field(r, "tokens")))
	}
	short := []jsjson.Value{}
	for _, r := range rows {
		if field(r, "ttl") != "5m" {
			continue
		}
		a, ok, err := l.agentOf(ctx, jsText(field(r, "agent_id")))
		if err != nil {
			return nil, err
		}
		if ok && a.Lifecycle != "archived" {
			short = append(short, jsjson.NewObject("agent_id", a.ID, "agent", a.Name))
		}
	}
	return jsjson.NewObject("note", coldNote, "cold_by_day", days, "cold_total", jsjson.NewObject("turns", turns, "tokens", tokens), "ttl_5m_agents", short), nil
}

// agentTypeCounts is src/usage.ts agentTypeCounts: the agents with spend since since per type, ignoring the filter.
func (l *Lifecycle) agentTypeCounts(ctx context.Context, o SummaryOptions, since string) ([]jsjson.Value, error) {
	rows, err := l.db.Objects(ctx, "SELECT DISTINCT agent_id FROM usage WHERE day >= ?", since)
	if err != nil {
		return nil, err
	}
	var types []string
	n := map[string]float64{}
	for _, r := range rows {
		t, err := l.typeOfRef(ctx, o, jsText(field(r, "agent_id")))
		if err != nil {
			return nil, err
		}
		if _, ok := n[t]; !ok {
			types = append(types, t)
		}
		n[t]++
	}
	sort.SliceStable(types, func(i, j int) bool {
		if n[types[i]] != n[types[j]] {
			return n[types[i]] > n[types[j]]
		}
		return localeCompare(types[i], types[j]) < 0
	})
	out := make([]jsjson.Value, len(types))
	for i, t := range types {
		out[i] = jsjson.NewObject("type", t, "count", n[t])
	}
	return out, nil
}

// subscriptionRows is the summary's subscriptions: each harness's stored windows, Codex's as the newest reading across
// machines with a passed reset shown as reset (CodexView).
func (l *Lifecycle) subscriptionRows(ctx context.Context, now float64) ([]jsjson.Value, error) {
	rows, err := l.db.Objects(ctx, "SELECT name, data, updated_at FROM subscriptions")
	if err != nil {
		return nil, err
	}
	out := []jsjson.Value{}
	for _, r := range rows {
		name, updated := jsText(field(r, "name")), jsText(field(r, "updated_at"))
		windows, err := jsjson.Parse([]byte(jsText(field(r, "data"))))
		if err != nil {
			return nil, err
		}
		if name != "codex" {
			out = append(out, jsjson.NewObject("name", name, "windows", windows, "updated_at", updated))
			continue
		}
		v := l.CodexView(windows, &updated, now)
		merged := jsjson.NewObject()
		spreadInto(merged, v.Live)
		spreadInto(merged, v.Reset)
		at := updated
		if v.UpdatedAt != nil {
			at = *v.UpdatedAt
		}
		out = append(out, jsjson.NewObject("name", name, "windows", merged, "updated_at", at, "age_ms", optNumber(v.AgeMs)))
	}
	return out, nil
}

// UsageSummary is src/usage.ts summary: the windows, readings, shares and trees, and the period's spend by day, model,
// agent and account, every cost in each display unit. Keep narrows the spend tables and the trees to agents of those
// types; the windows, allocations, reserve and limits stay account-wide.
func (l *Lifecycle) UsageSummary(ctx context.Context, o SummaryOptions) (*jsjson.Object, error) {
	now := o.Now
	today := utcDay(now)
	if math.IsNaN(o.Days) || math.IsInf(o.Days, 0) {
		return nil, errInvalidTime
	}
	since := today
	if !(o.Days <= 1) {
		t := now - o.Days*86_400_000
		if math.Abs(t) > 8.64e15 {
			return nil, errInvalidTime
		}
		since = utcDay(t)
	}
	set := l.settings.Get()
	reads, err := l.AccountReadings(ctx, now)
	if err != nil {
		return nil, err
	}
	snap, err := l.snapshotOf(ctx, reads, o.Days, now)
	if err != nil {
		return nil, err
	}
	dctx := newSnapshotCtx(set, snap.worths)
	var keptList []string
	var kept map[string]bool
	trees := snap.trees
	if o.Keep != nil {
		if keptList, kept, err = l.keptAgentIDs(ctx, o); err != nil {
			return nil, err
		}
		x, err := l.treeIndex(ctx)
		if err != nil {
			return nil, err
		}
		if trees, err = l.treeTotals(ctx, x, o.Days, now, snap.windows, dctx, kept); err != nil {
			return nil, err
		}
	}
	keptJSON := ""
	if kept != nil {
		b, _ := json.Marshal(orEmptyStrings(keptList))
		keptJSON = string(b)
	}
	// only is the where clause and its params narrowed to the kept agents.
	only := func(where string, params ...any) (string, []any) {
		if kept == nil {
			return where, params
		}
		if where != "" {
			where += " AND"
		} else {
			where = " WHERE"
		}
		return where + " agent_id IN (SELECT value FROM json_each(?))", append(params, keptJSON)
	}
	agentSQL, agentArg := "", []any{}
	if kept != nil {
		agentSQL, agentArg = " AND agent_id IN (SELECT value FROM json_each(?))", []any{keptJSON}
	}

	subs, err := l.subscriptionRows(ctx, now)
	if err != nil {
		return nil, err
	}
	w, p := only("")
	life, err := l.totalsRows(ctx, "agent_id", byAgentKey, w, p)
	if err != nil {
		return nil, err
	}
	w, p = only(" WHERE day = ?", today)
	todayByAgent, err := l.totalsRows(ctx, "agent_id", byAgentKey, w, p)
	if err != nil {
		return nil, err
	}
	todayByModel, err := l.totalsRows(ctx, "harness, model", byModelKey, w, p)
	if err != nil {
		return nil, err
	}
	w, p = only("")
	lifeByModel, err := l.totalsRows(ctx, "harness, model", byModelKey, w, p)
	if err != nil {
		return nil, err
	}
	var decideRows []*jsjson.Object
	if o.Keep == nil || o.Keep["untyped"] {
		if decideRows, err = l.db.Objects(ctx, decideDaySQL); err != nil {
			return nil, err
		}
	}
	periodOrder, decidePeriod := decideSpend(decideRows, func(d string) bool { return d >= since })
	_, decideToday := decideSpend(decideRows, func(d string) bool { return d == today })
	_, decideLife := decideSpend(decideRows, func(string) bool { return true })

	w, p = only(" WHERE day = ?", today)
	todayAccounts, err := l.accountsOf(ctx, w, p)
	if err != nil {
		return nil, err
	}
	todayModes := RoundModes(Convert(todayAccounts, dctx, nil))
	modelSQL := "harness || char(0) || COALESCE(model, '')"
	type modesQuery struct {
		key, where string
		params     []any
	}
	var modes [9]map[string]Modes
	for i, q := range []modesQuery{
		{"day", " WHERE day >= ?", []any{since}},
		{modelSQL, " WHERE day >= ?", []any{since}},
		{"agent_id", " WHERE day >= ?", []any{since}},
		{modelSQL, " WHERE day = ?", []any{today}},
		{modelSQL, "", nil},
		{"agent_id", " WHERE day = ?", []any{today}},
		{"agent_id", "", nil},
		{"account", " WHERE day >= ?", []any{since}},
	} {
		w, p := only(q.where, q.params...)
		if modes[i], err = l.modesBy(ctx, q.key, w, p, dctx); err != nil {
			return nil, err
		}
	}
	dayModes, modelModes, agentModes, todayModelModes, lifeModelModes, todayAgentModes, lifeAgentModes, accountModes := modes[0], modes[1], modes[2], modes[3], modes[4], modes[5], modes[6], modes[7]
	// Stam's decide spend runs on openrouter (a paid account), so its units are all paid.
	decideModes := func(cost float64) *Modes {
		m := RoundModes(Convert([]AccountCost{{Account: "openrouter", API: cost}}, dctx, nil))
		return &m
	}

	accounts := make([]jsjson.Value, len(reads))
	for i, r := range reads {
		c := jsjson.NewObject()
		spreadInto(c, r)
		var shares jsjson.Value
		if len(readingWindowNames(r)) > 0 {
			if s, ok := snap.shares[jsText(field(r, "account"))]; ok {
				shares = s
			}
		}
		c.Set("shares", shares)
		accounts[i] = c
	}
	reserve, remaining := l.CreditReserve(ctx, msTime(now))
	views, err := l.AllocationViews(ctx, "", msTime(now))
	if err != nil {
		return nil, err
	}
	allocs := []jsjson.Value{}
	for _, v := range views {
		x, err := fromFmt(v)
		if err != nil {
			return nil, err
		}
		allocs = append(allocs, x)
	}

	todayRows, err := l.db.Objects(ctx, "SELECT "+usageSums+" FROM usage WHERE day = ?"+agentSQL, append([]any{today}, agentArg...)...)
	if err != nil {
		return nil, err
	}
	todayRow := todayRows[0]
	todayRow.Set("modes", todayModes.JSON())

	dayRows, err := l.db.Objects(ctx, "SELECT day, "+usageSums+" FROM usage WHERE day >= ?"+agentSQL+" GROUP BY day ORDER BY day", append([]any{since}, agentArg...)...)
	if err != nil {
		return nil, err
	}
	byDayList := make([]jsjson.Value, len(dayRows))
	for i, r := range dayRows {
		r.Set("modes", modesOr0(dayModes, jsText(field(r, "day"))).JSON())
		byDayList[i] = r
	}

	prices := l.prices()
	priced := func(model jsjson.Value, t *jsjson.Object) *jsjson.Object {
		spreadInto(t, kindCosts(prices, model, t))
		return t
	}
	modelRows, err := l.db.Objects(ctx, "SELECT harness, model, "+usageSums+" FROM usage WHERE day >= ? AND NOT (agent_id = 'stam' AND account IN ('openrouter', 'openrouter-system'))"+agentSQL+" GROUP BY harness, model", append([]any{since}, agentArg...)...)
	if err != nil {
		return nil, err
	}
	type costRow struct {
		obj  *jsjson.Object
		cost float64
	}
	var byModel []costRow
	for _, r := range modelRows {
		harness, model := jsText(field(r, "harness")), field(r, "model")
		key := modelKey(harness, model)
		row := jsjson.NewObject()
		spreadInto(row, r)
		spreadInto(row, kindCosts(prices, model, r))
		row.Set("modes", modesOr0(modelModes, key).JSON())
		row.Set("today", priced(model, totalsFor(harness, todayByModel[key], modesAt(todayModelModes, key), modesAt(todayModelModes, key) != nil)))
		row.Set("lifetime", priced(model, totalsFor(harness, lifeByModel[key], modesAt(lifeModelModes, key), modesAt(lifeModelModes, key) != nil)))
		byModel = append(byModel, costRow{row, numberValue(field(r, "cost_usd"))})
	}
	for _, purpose := range periodOrder {
		s := decidePeriod[purpose]
		todayCost := 0.0
		if t := decideToday[purpose]; t != nil {
			todayCost = t.cost
		}
		lifeCost := 0.0
		if t := decideLife[purpose]; t != nil {
			lifeCost = t.cost
		}
		cost := round(s.cost*1e4) / 1e4
		row := jsjson.NewObject("harness", "openrouter", "model", purpose, "cost_usd", cost, "modes", decideModes(s.cost).JSON(),
			"tokens_in", s.in, "tokens_out", s.out, "tokens_cache_read", 0.0, "tokens_cache_write", 0.0,
			"today", totalsFor("openrouter", decideToday[purpose].row(), decideModes(todayCost), true),
			"lifetime", totalsFor("openrouter", decideLife[purpose].row(), decideModes(lifeCost), true))
		byModel = append(byModel, costRow{row, cost})
	}
	// .sort((a, b) => b.cost_usd - a.cost_usd): a null cost counts as 0.
	sort.SliceStable(byModel, func(i, j int) bool { return nan0(byModel[i].cost) > nan0(byModel[j].cost) })
	byModelList := make([]jsjson.Value, len(byModel))
	for i, r := range byModel {
		byModelList[i] = r.obj
	}

	agentRows, err := l.db.Objects(ctx, "SELECT agent_id, "+usageSums+" FROM usage WHERE day >= ?"+agentSQL+" GROUP BY agent_id ORDER BY 2 DESC LIMIT 30", append([]any{since}, agentArg...)...)
	if err != nil {
		return nil, err
	}
	byAgent := make([]jsjson.Value, len(agentRows))
	for i, r := range agentRows {
		id := jsText(field(r, "agent_id"))
		a, ok, err := l.agentOf(ctx, id)
		if err != nil {
			return nil, err
		}
		name, typ, harness := id, "untyped", ""
		var model jsjson.Value
		if ok {
			name, typ, harness = a.Name, o.TypeOf(a), a.Harness
			if a.Model != nil {
				model = *a.Model
			}
		}
		r.Set("agent", name)
		r.Set("type", typ)
		r.Set("harness", harness)
		r.Set("model", model)
		r.Set("modes", modesOr0(agentModes, id).JSON())
		r.Set("today", totalsFor(harness, todayByAgent[id], modesAt(todayAgentModes, id), modesAt(todayAgentModes, id) != nil))
		r.Set("lifetime", totalsFor(harness, life[id], modesAt(lifeAgentModes, id), modesAt(lifeAgentModes, id) != nil))
		byAgent[i] = r
	}

	blocked, err := l.blocked(ctx)
	if err != nil {
		return nil, err
	}
	accountRows, err := l.db.Objects(ctx, "SELECT account, "+usageSums+" FROM usage WHERE day >= ?"+agentSQL+" GROUP BY account ORDER BY 2 DESC", append([]any{since}, agentArg...)...)
	if err != nil {
		return nil, err
	}
	byAccount := make([]jsjson.Value, len(accountRows))
	for i, r := range accountRows {
		r.Set("modes", modesOr0(accountModes, jsText(field(r, "account"))).JSON())
		byAccount[i] = r
	}
	samples, err := l.db.Objects(ctx, "SELECT COUNT(*) AS n FROM usage_samples")
	if err != nil {
		return nil, err
	}
	var filtered jsjson.Value
	if o.Keep != nil {
		types := make([]string, 0, len(o.Keep))
		for t := range o.Keep {
			types = append(types, t)
		}
		sort.Strings(types)
		list := make([]jsjson.Value, len(types))
		for i, t := range types {
			list[i] = t
		}
		filtered = list
	}
	cache, err := l.coldSummary(ctx, since, agentSQL, agentArg)
	if err != nil {
		return nil, err
	}
	typeCounts, err := l.agentTypeCounts(ctx, o, since)
	if err != nil {
		return nil, err
	}
	out := jsjson.NewObject(
		"note", SummaryNote,
		"display_mode", set.CostMode,
		"instructions", set.CostInstructions,
		"subscriptions", subs,
		"openrouter_reserve", jsjson.NewObject("reserve", reserve, "remaining", optNumber(remaining)),
		"accounts", accounts,
		"shares_note", EstimateNote,
		"trees", orEmpty(trees),
		"allocations", allocs,
	)
	// The tree view goes right after the allocations, as TS's spread puts it.
	if o.Tree != nil {
		view, err := l.treeView(ctx, *o.Tree, snap.windows, now)
		if err != nil {
			return nil, err
		}
		out.Set("tree", view)
	}
	rest := jsjson.NewObject(
		"today", todayRow,
		"by_day", byDayList,
		"by_model", byModelList,
		"by_agent", byAgent,
		"blocked", blocked,
		"by_account", byAccount,
		"sample_count", field(samples[0], "n"),
		"filtered_agents", filtered,
		"cache", cache,
		"agent_types", typeCounts,
	)
	for _, k := range rest.Keys() {
		v, _ := rest.Get(k)
		out.Set(k, v)
	}
	return out, nil
}

// treeView is src/usage.ts treeView: the tree's summary over the snapshot's windows, its allocations, and what a
// finished issue with its root's config typically used.
func (l *Lifecycle) treeView(ctx context.Context, root db.Agent, windows []cachedWindow, now float64) (*jsjson.Object, error) {
	x, err := l.treeIndex(ctx)
	if err != nil {
		return nil, err
	}
	view := treeSummary(x, root.ID, now, windows)
	views, err := l.AllocationViews(ctx, root.ID, msTime(now))
	if err != nil {
		return nil, err
	}
	allocs := []jsjson.Value{}
	for _, v := range views {
		a, err := fromFmt(v)
		if err != nil {
			return nil, err
		}
		allocs = append(allocs, a)
	}
	view.Set("allocations", allocs)
	model := "unknown"
	if root.Model != nil && *root.Model != "" {
		model = *root.Model
	}
	typical, err := l.TypicalIssue(ctx, root.Harness+" · "+model, now)
	if err != nil {
		return nil, err
	}
	if typical != nil {
		view.Set("typical_issue", typical)
	} else {
		view.Set("typical_issue", nil)
	}
	return view, nil
}

func nan0(f float64) float64 {
	if math.IsNaN(f) {
		return 0
	}
	return f
}

func modesOr0(m map[string]Modes, k string) Modes {
	if x, ok := m[k]; ok {
		return x
	}
	return ZeroModes()
}

func orEmptyStrings(xs []string) []string {
	if xs == nil {
		return []string{}
	}
	return xs
}

// msTime is a time in milliseconds as a time.Time.
func msTime(t float64) time.Time { return time.UnixMilli(int64(t)) }

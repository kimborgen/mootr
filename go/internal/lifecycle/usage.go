package lifecycle

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// The usage tables (src/usage.ts, S-2848 A3): per-agent spend and tokens by day and by 5-minute bucket, and the
// subscription windows each harness reports. A harness reports cumulative numbers per session (Claude Code: the status
// line's cost and the transcript's tokens). Each counter is tracked on its own: a drop restarts only that counter, a
// counter not reported keeps its baseline, and a new session restarts the token counters only.
//
// A window crossing a warn percentage (cost.subscriptionWarnPercent) warns the managers of the trees on its account and,
// when humanMail.when allows important, the human, once per window, threshold and reset; a window projected to reach
// 100% within 30 minutes warns the managers (costnotices.go); and today's spend passing cost.dailyWarnUsd mails the
// human once a day. Which warnings went out is kept in memory, as in TS, so a restart may warn again. Each reading and
// report also checks the trees' allocations on its account (allocations.go).

const (
	// baselineVersion is src/usage.ts BASELINE_VERSION: an older baseline is replaced and records nothing.
	baselineVersion = 2
	// sampleBucket is the usage_samples bucket (src/usage.ts SAMPLE_BUCKET_MS).
	sampleBucket = 5 * time.Minute
	// pruneEvery is how often the samples and window readings are pruned (src/usage.ts PRUNE_MS).
	pruneEvery = time.Hour
	// sampleRetention is src/db.ts SAMPLE_RETENTION_MS: samples and window readings are kept 35 days.
	sampleRetention = 35 * 24 * time.Hour
	// subscriptionSame is src/usage.ts SUBSCRIPTION_SAME_MS: the same reading again within it records nothing.
	subscriptionSame = 10 * time.Second
	// staleReading is src/readings.ts STALE_MS: an older subscription reading is unknown.
	staleReading = 15 * time.Minute
	// systemAccount is src/settings.ts SYSTEM_ACCOUNT: stam's own OpenRouter spend.
	systemAccount = "openrouter-system"
)

// counters are the baseline's keys, in the order report checks them: cost, then the four token counts (uncached
// input, output, cache read, cache write).
var counters = [...]string{"cost", "tin", "tout", "tcr", "tcw"}

type usageState struct {
	lastPrune        time.Time
	lastSubscription map[string]subscriptionSeen
	// warned is src/usage.ts warned: the window warnings and daily-spend mails sent, by key.
	warned map[string]bool
	// lastProjection is src/cost-notices.ts lastProjection: when each account:window projection was last checked, in
	// milliseconds.
	lastProjection map[string]float64
}

type subscriptionSeen struct {
	text string
	at   time.Time
}

// usageReport is one cumulative report: each counter in counters' order, nil when not reported, and the session's
// identity, nil for none.
type usageReport struct {
	counts  [len(counters)]*float64
	session *string
	// sessionCumulative: the counters are cumulative for the session id and never fall inside it (OpenCode): a lower
	// reading is a stale or out-of-order read, and a new session id starts every counter, cost too, at zero.
	sessionCumulative bool
}

// iso is new Date(t).toISOString().
func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// usagePlan is what a report does to the baseline: nothing, only the baseline (seed), or the baseline with the growth.
type usagePlan struct {
	baseline string
	delta    [len(counters)]float64
	// kind is planNone, planBaseline (the baseline alone is stored) or planRecord (the growth is recorded with it).
	kind int
}

const (
	planNone = iota
	planBaseline
	planRecord
)

// planUsage is src/usage.ts report's arithmetic: the growth of r over the baseline last (usage_last, nil for none),
// and the baseline that follows.
func planUsage(last *string, r usageReport) usagePlan {
	// The baseline lives on the agent, so it survives daemon restarts; a new agent has none.
	var old jsjson.Value
	if last != nil {
		if v, err := jsjson.Parse([]byte(*last)); err == nil {
			old = v
		}
	}
	base, _ := old.(*jsjson.Object)
	// An older baseline: seeded from this report, recording nothing, so a change in what a harness counts is never
	// mistaken for a session restart.
	if v, _ := base.Get("v"); jsjson.Truthy(old) && v != any(float64(baselineVersion)) {
		seed := jsjson.NewObject("v", float64(baselineVersion))
		if r.session != nil {
			seed.Set("id", *r.session)
		}
		for i, k := range counters {
			if r.counts[i] != nil {
				seed.Set(k, *r.counts[i])
			}
		}
		return usagePlan{kind: planBaseline, baseline: jsjson.Stringify(seed, "")}
	}
	baseID, hasID := base.Get("id")
	idChanged := r.session != nil && baseID != any(*r.session)
	next := jsjson.NewObject("v", float64(baselineVersion))
	if r.session != nil {
		next.Set("id", *r.session)
	} else if hasID {
		next.Set("id", baseID)
	}
	var delta [len(counters)]float64
	changed := idChanged
	for i, k := range counters {
		was, has := base.Get(k)
		value := r.counts[i]
		if value == nil {
			// Not reported now: the baseline stays, unless a new session restarts the token counters.
			if idChanged && (k != "cost" || r.sessionCumulative) {
				next.Set(k, 0.0)
			} else if has {
				next.Set(k, was)
			}
			continue
		}
		prev, _ := was.(float64)
		// A session's counters restart with a new session; cost does too when the harness counts it per session.
		if idChanged && (k != "cost" || r.sessionCumulative) {
			prev = 0
		}
		// A session-cumulative counter never falls inside its session: a lower reading is a stale or out-of-order read,
		// which records nothing and keeps the higher baseline.
		if r.sessionCumulative && !idChanged && *value < prev {
			next.Set(k, prev)
			continue
		}
		if *value >= prev {
			delta[i] = *value - prev
		} else {
			delta[i] = *value
		}
		next.Set(k, *value)
		if was != any(*value) {
			changed = true
		}
	}
	grew := false
	for _, d := range delta {
		grew = grew || d > 0
	}
	switch {
	case grew:
		return usagePlan{kind: planRecord, baseline: jsjson.Stringify(next, ""), delta: delta}
	case changed:
		return usagePlan{kind: planBaseline, baseline: jsjson.Stringify(next, "")}
	}
	return usagePlan{}
}

// reportUsage is src/usage.ts report for a report taken at now: the growth since the agent's baseline (usage_last) is
// added to its daily row and its sample bucket, and the live stream hears of it.
func (l *Lifecycle) reportUsage(ctx context.Context, a db.Agent, r usageReport, now time.Time) error {
	return l.reportUsageWith(ctx, a, r, now, nil)
}

// reportUsageWith is reportUsage with its database write bound to a session and launch, when there is a binding. A bound
// report is written under the owner's guard and, in the write's own transaction, only while the row still runs the bound
// session (db.RecordUsageWhile), from the baseline that transaction reads: so two reports landing together each add only
// their own growth, and a report a stop, launch, archive or switch overtook writes nothing and has no effects. The effects
// of a recorded report (rules, pruning, the live stream, allocations, budgets, the daily warning) run after the write,
// outside it.
func (l *Lifecycle) reportUsageWith(ctx context.Context, a db.Agent, r usageReport, now time.Time, bound *turnBind) error {
	given := false
	for _, c := range r.counts {
		given = given || c != nil
	}
	if !given {
		return nil
	}
	set := l.settings.Get()
	account := set.AccountFor(a.Harness, a.Model)
	acct, hasAcct := set.CostAccounts[account]
	// The windows are read before the write, outside any guard, and only for a report that grows from the baseline
	// the caller's row has: a paid account's cost counts as paid estimate only while a reported window reads 100%: the
	// harness has left the subscription and started charging (docs/cost-policy.md, build step 3). TS reads that window at
	// the current time, the rule below at the report's. A bound report whose baseline moved since the row was read
	// (another end wrote first) may grow where this reading said it doesn't: it then has no paid estimate.
	var at100Wall, at100Now bool
	if hasAcct && acct.Paid != nil && planUsage(a.UsageLast, r).kind == planRecord {
		at100Wall = *acct.Paid && l.windowAt100(ctx, a.Harness, time.Now())
		at100Now = !*acct.Paid && l.windowAt100(ctx, a.Harness, now)
	}
	// change is what the report does on the baseline last (the row's, read where the write reads it).
	var plan usagePlan
	change := func(last *string) db.UsageChange {
		plan = planUsage(last, r)
		switch plan.kind {
		case planBaseline:
			return db.UsageChange{Baseline: &plan.baseline}
		case planRecord:
			var paid, unreconciled float64
			if at100Wall {
				paid = plan.delta[0]
			}
			if orAccount(set, account) {
				unreconciled = plan.delta[0]
			}
			bucket := time.UnixMilli(now.UnixMilli() / sampleBucket.Milliseconds() * sampleBucket.Milliseconds())
			return db.UsageChange{Record: &db.Usage{AgentID: a.ID, Day: now.UTC().Format("2006-01-02"), Bucket: iso(bucket), Harness: a.Harness,
				Account: account, Model: a.Model, Cost: plan.delta[0], In: plan.delta[1], Out: plan.delta[2], CacheRead: plan.delta[3], CacheWrite: plan.delta[4],
				PaidEstimate: paid, Unreconciled: unreconciled, Baseline: plan.baseline}}
		}
		return db.UsageChange{}
	}
	// The same growth on a paid: false account is paid spend the user's rule forbids (src/rules.ts).
	rule := func() {
		if at100Now && plan.delta[0] > 0 {
			l.EvaluateRules(account, Trigger{Paid: &Paid{Source: a.Name + "'s cost grew $" + strconv.FormatFloat(plan.delta[0], 'f', 4, 64) + " while a window read 100%"}}, now)
		}
	}
	if bound == nil {
		if plan = planUsage(a.UsageLast, r); plan.kind == planRecord {
			rule()
		}
		c := change(a.UsageLast)
		switch {
		case c.Record != nil:
			if err := l.db.RecordUsage(ctx, *c.Record); err != nil {
				return err
			}
		case c.Baseline != nil:
			return l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "usage_last", Val: *c.Baseline})
		default:
			return nil
		}
	} else {
		held := false
		wrote, err := bound.write(func() error {
			l.turnAt(a.ID, "usage-commit")
			var err error
			held, err = l.db.RecordUsageWhile(ctx, a.ID, bound.ok, func(fresh db.Agent) db.UsageChange { return change(fresh.UsageLast) })
			return err
		})
		if err != nil || !wrote || !held || plan.kind != planRecord {
			return err
		}
		rule()
	}
	l.pruneUsage(ctx, now)
	// The system view's cost animation (S-456): the agent's total is filled in at flush.
	l.live.AgentChanged(a.ID, jsjson.NewObject())
	// The tree allocations on this account get a usd check when paid spend grows (allocations.go).
	l.checkUsdAllocations(ctx, account, now)
	// The budgets this spend can move are evaluated, on their chains.
	if account != "" {
		l.OnSpend(account, now)
	}
	l.checkDailySpend(ctx)
	return nil
}

// warnWindow is src/usage.ts reportSubscription's threshold loop: each warn percentage the window reached warns once per
// window and reset, the managers first, the human only when humanMail.when allows important.
func (l *Lifecycle) warnWindow(ctx context.Context, name, window string, used float64, resets *float64, now time.Time) {
	basis := "undefined"
	if resets != nil {
		basis = jsjson.Number(*resets)
	}
	for _, threshold := range l.settings.Get().SubscriptionWarnPercent {
		key := name + ":" + window + ":" + jsjson.Number(threshold) + ":" + basis
		if used < threshold || !l.firstWarning(key) {
			continue
		}
		l.windowWarning(ctx, name, window, used, threshold, resets, now)
		agents, err := l.db.ListAgents(ctx)
		if err != nil {
			slog.Error("usage", "err", err)
		}
		var running []string
		for _, a := range agents {
			if a.Lifecycle == "active" && a.Harness == name {
				running = append(running, a.Name)
			}
		}
		list := strings.Join(running, ", ")
		if list == "" {
			list = "none"
		}
		when := "at an unknown time"
		if resets != nil && *resets != 0 {
			when = utcSec(*resets)
		}
		win := firstUnderscore(window)
		l.warnHuman(ctx, name+" "+win+" usage at "+jsjson.Number(used)+"%", "subscription-warning", map[string]string{"name": name, "window": win,
			"percent": jsjson.Number(used), "threshold": jsjson.Number(threshold), "resets": when, "agents": list})
	}
}

// firstWarning records a warning's key, false when it was already sent.
func (l *Lifecycle) firstWarning(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.usage.warned[key] {
		return false
	}
	if l.usage.warned == nil {
		l.usage.warned = map[string]bool{}
	}
	l.usage.warned[key] = true
	return true
}

// checkDailySpend is src/usage.ts checkDailySpend: today's (UTC, by the clock) agent spend passing cost.dailyWarnUsd
// mails the human once a day, with the day's top agents.
func (l *Lifecycle) checkDailySpend(ctx context.Context) {
	threshold := l.settings.Get().DailyWarnUSD
	if threshold == 0 {
		return
	}
	day := time.Now().UTC().Format("2006-01-02")
	key := "daily:" + day
	l.mu.Lock()
	done := l.usage.warned[key]
	l.mu.Unlock()
	if done {
		return
	}
	spent, top, err := l.db.DaySpend(ctx, day, 5)
	if err != nil {
		slog.Error("usage", "err", err)
		return
	}
	if spent < threshold || !l.firstWarning(key) {
		return
	}
	names := make([]string, len(top))
	for i, r := range top {
		name := r.AgentID
		if a, err := l.db.GetAgent(ctx, r.AgentID); err == nil {
			name = a.Name
		}
		names[i] = name + " $" + jsjson.ToFixed(r.Cost, 2)
	}
	l.warnHuman(ctx, "Daily spend passed $"+jsjson.Number(threshold), "daily-spend-warning", map[string]string{"spent": jsjson.ToFixed(spent, 2),
		"threshold": jsjson.Number(threshold), "top": strings.Join(names, ", ")})
}

// warnHuman is src/usage.ts mailHuman for a warning: the human hears from system:cost only when humanMail.when allows
// important. A template that doesn't render sends nothing.
func (l *Lifecycle) warnHuman(ctx context.Context, subject, template string, vars map[string]string) {
	if !l.settings.Get().HumanMail.Allows("important") {
		return
	}
	body, err := l.render(template, vars)
	if err != nil {
		slog.Error("usage", "template", template, "err", err)
		return
	}
	l.goBG(func(ctx context.Context) { l.mailFromSystem(ctx, "cost", []string{humanID}, "[stam] "+subject, body) })
}

// SetSystemMail sets how stam sends its own mail from a system:NAME sender (the server's sendFromSystem, S-1239); nil
// sends nothing.
func (l *Lifecycle) SetSystemMail(send func(ctx context.Context, name string, to []string, subject, body string) bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.systemMail = send
}

// mailFromSystem is src/mail.ts sendFromSystem: false when there is no sender or the send failed.
func (l *Lifecycle) mailFromSystem(ctx context.Context, name string, to []string, subject, body string) bool {
	l.mu.Lock()
	send := l.systemMail
	l.mu.Unlock()
	if send == nil || !send(ctx, name, to, subject, body) {
		slog.Error("mail from system:"+name+" not sent", "subject", subject)
		return false
	}
	return true
}

// pruneUsage is src/usage.ts pruneSamples: samples and window readings older than sampleRetention go, at most once
// every pruneEvery.
func (l *Lifecycle) pruneUsage(ctx context.Context, now time.Time) {
	l.mu.Lock()
	due := now.Sub(l.usage.lastPrune) >= pruneEvery
	if due {
		l.usage.lastPrune = now
	}
	l.mu.Unlock()
	if due {
		_ = l.db.PruneUsage(ctx, iso(now.Add(-sampleRetention)))
	}
}

// orAccount is src/usage.ts orAccount: an account that bills to the OpenRouter credit, by its match and not its name.
func orAccount(set config.Settings, account string) bool {
	if account == "openrouter" || account == systemAccount {
		return true
	}
	acct, ok := set.CostAccounts[account]
	return ok && isOpenRouter(acct, account)
}

// isOpenRouter is src/accounts.ts isOpenRouter.
func isOpenRouter(acct config.CostAccount, name string) bool {
	if name == systemAccount {
		return true
	}
	return acct.Harness == "opencode" && (strings.HasPrefix(deref(acct.Model), "openrouter/") || name == "openrouter")
}

// windowAt100 is src/usage.ts windowAt100: the harness's latest subscription reading has a window at 100% that is fresh
// and hasn't reset. A reading older than staleReading is unknown, and malformed data reads as not at 100%.
func (l *Lifecycle) windowAt100(ctx context.Context, harness string, now time.Time) bool {
	data, updated, ok, err := l.db.Subscription(ctx, harness)
	if err != nil || !ok {
		return false
	}
	if at, err := time.Parse(time.RFC3339Nano, updated); err == nil && now.Sub(at) > staleReading {
		return false
	}
	v, err := jsjson.Parse([]byte(data))
	if err != nil {
		return false
	}
	var windows []jsjson.Value
	switch x := v.(type) {
	case *jsjson.Object:
		for _, k := range x.Keys() {
			w, _ := x.Get(k)
			windows = append(windows, w)
		}
	case []jsjson.Value:
		windows = x
	}
	for _, w := range windows {
		o, _ := w.(*jsjson.Object)
		used, _ := o.Get("used_percentage")
		if n, ok := used.(float64); !ok || n < 100 {
			continue
		}
		resets, _ := o.Get("resets_at")
		if r, ok := resets.(float64); !ok || r*1000 > float64(now.UnixMilli()) {
			return true
		}
	}
	return false
}

// reportSubscription is src/usage.ts reportSubscription for a reading taken at now: the harness's windows (Claude's
// five_hour and seven_day) are stored, each window's change gets a window_readings row, and the live stream hears when
// they changed. A key without a numeric used_percentage (Codex's credits) is stored but not recorded as a window.
func (l *Lifecycle) reportSubscription(ctx context.Context, name string, windows *jsjson.Object, now time.Time) error {
	at := iso(now)
	prevData, _, hasPrev, err := l.db.Subscription(ctx, name)
	if err != nil {
		return err
	}
	text := jsjson.Stringify(windows, "")
	if err := l.db.SaveSubscription(ctx, name, text, at); err != nil {
		return err
	}
	for _, k := range windows.Keys() {
		v, _ := windows.Get(k)
		w, _ := v.(*jsjson.Object)
		u, _ := w.Get("used_percentage")
		used, ok := u.(float64)
		if !ok {
			continue
		}
		var resets *float64
		if r, _ := w.Get("resets_at"); r != nil {
			if n, ok := r.(float64); ok {
				resets = &n
			}
		}
		if _, err := l.db.RecordWindowReading(ctx, name, k, used, resets, at); err != nil {
			return err
		}
		l.warnWindow(ctx, name, k, used, resets, now)
		// A window burning toward 100% within 30 minutes warns its managers (throttled).
		l.checkProjection(ctx, name, k, now)
		// A tree allocation on this window is checked at 80% and 100% of the allocation, once per reset; it never sets a
		// blocker.
		l.checkWindowAllocations(ctx, name, k, now)
	}
	l.pruneUsage(ctx, now)
	prev := "null"
	var prevValue jsjson.Value
	if hasPrev {
		if v, err := jsjson.Parse([]byte(prevData)); err == nil {
			prev = jsjson.Stringify(v, "")
			prevValue = v
		}
	}
	// The cost rules judge the accounts this reading covers.
	l.onReading(name, prevValue, windows, now)
	// A cost pause waiting on this account's window may now be clearable.
	l.goBG(func(ctx context.Context) { l.EvaluatePauses(ctx, now) })
	// An unchanged reading is the common case on every status line: only a change makes the web refetch /api/usage.
	if prev != text {
		_ = l.live.Emit("usage.changed", struct{}{})
	}
	return nil
}

// reportStatusline is src/usage.ts reportStatusline: the windows are stored before the cost, so report classifies the
// cost against this report's windows. The same reading as the harness's last within subscriptionSame is skipped.
func (l *Lifecycle) reportStatusline(ctx context.Context, a db.Agent, r usageReport, subscription jsjson.Value) error {
	if sub, ok := subscription.(*jsjson.Object); ok {
		text := jsjson.Stringify(sub, "")
		now := time.Now()
		l.mu.Lock()
		last, seen := l.usage.lastSubscription[a.Harness]
		due := !seen || last.text != text || now.Sub(last.at) >= subscriptionSame
		if due {
			if l.usage.lastSubscription == nil {
				l.usage.lastSubscription = map[string]subscriptionSeen{}
			}
			l.usage.lastSubscription[a.Harness] = subscriptionSeen{text, now}
		}
		l.mu.Unlock()
		if due {
			if err := l.reportSubscription(ctx, a.Harness, sub, now); err != nil {
				return err
			}
		}
	}
	if r.counts[0] == nil && r.counts[1] == nil && r.counts[3] == nil {
		return nil
	}
	return l.reportUsage(ctx, a, r, time.Now())
}

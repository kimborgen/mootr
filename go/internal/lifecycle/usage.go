package lifecycle

import (
	"context"
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
// Not ported (part B's cost signals): the paid-rule check, budgets, allocations, the daily-spend and window warnings
// to managers and the human, the window projection, and the reading observers of rules and cost pauses.

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
}

// iso is new Date(t).toISOString().
func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// reportUsage is src/usage.ts report for a report taken at now: the growth since the agent's baseline (usage_last) is
// added to its daily row and its sample bucket, and the live stream hears of it.
func (l *Lifecycle) reportUsage(ctx context.Context, a db.Agent, r usageReport, now time.Time) error {
	given := false
	for _, c := range r.counts {
		given = given || c != nil
	}
	if !given {
		return nil
	}
	// The baseline lives on the agent, so it survives daemon restarts; a new agent has none.
	var old jsjson.Value
	if a.UsageLast != nil {
		if v, err := jsjson.Parse([]byte(*a.UsageLast)); err == nil {
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
		return l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "usage_last", Val: jsjson.Stringify(seed, "")})
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
			if idChanged && k != "cost" {
				next.Set(k, 0.0)
			} else if has {
				next.Set(k, was)
			}
			continue
		}
		prev, _ := was.(float64)
		if idChanged && k != "cost" {
			prev = 0
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
	if !changed && !grew {
		return nil
	}
	if !grew {
		return l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "usage_last", Val: jsjson.Stringify(next, "")})
	}
	set := l.settings.Get()
	account := set.AccountFor(a.Harness, a.Model)
	// A paid account's cost counts as paid estimate only while a reported window reads 100%: the harness has left the
	// subscription and started charging (docs/cost-policy.md, build step 3). TS reads the window at the current time.
	var paid, unreconciled float64
	if acct, ok := set.CostAccounts[account]; ok && acct.Paid != nil && *acct.Paid && l.windowAt100(ctx, a.Harness, time.Now()) {
		paid = delta[0]
	}
	if orAccount(set, account) {
		unreconciled = delta[0]
	}
	bucket := time.UnixMilli(now.UnixMilli() / sampleBucket.Milliseconds() * sampleBucket.Milliseconds())
	if err := l.db.RecordUsage(ctx, db.Usage{AgentID: a.ID, Day: now.UTC().Format("2006-01-02"), Bucket: iso(bucket), Harness: a.Harness,
		Account: account, Model: a.Model, Cost: delta[0], In: delta[1], Out: delta[2], CacheRead: delta[3], CacheWrite: delta[4],
		PaidEstimate: paid, Unreconciled: unreconciled, Baseline: jsjson.Stringify(next, "")}); err != nil {
		return err
	}
	l.pruneUsage(ctx, now)
	// The system view's cost animation (S-456): the agent's total is filled in at flush.
	l.live.AgentChanged(a.ID, jsjson.NewObject())
	return nil
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
	}
	l.pruneUsage(ctx, now)
	prev := "null"
	if hasPrev {
		if v, err := jsjson.Parse([]byte(prevData)); err == nil {
			prev = jsjson.Stringify(v, "")
		}
	}
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

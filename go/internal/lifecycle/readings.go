package lifecycle

import (
	"context"
	"math"
	"strings"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// Cost readings (src/readings.ts accountReadings, S-3807): for each configured account, the harness's subscription
// windows and how fresh they are, the paid spend for today, the week and the month with the source it came from, and the
// account's budget and what is left of it. Readings only: nothing here blocks, stops or takes over an agent. The paid
// spend is the ledger's (paidspend.go).

// staleReadingMs is src/readings.ts STALE_MS: a reading older than this, while an agent on the account is active, is
// stale and counts as unknown.
const staleReadingMs = 15 * 60_000

// jsNumberOf is `typeof v === 'number'` on parsed JSON.
func jsNumberOf(v jsjson.Value) (float64, bool) {
	f, ok := v.(float64)
	return f, ok
}

// optNum is a number, or null.
func optNum(f float64, ok bool) jsjson.Value {
	if !ok {
		return nil
	}
	return f
}

// CodexView is src/codex-usage-view.ts CodexView: the windows still in force (and the extra keys, credits and planType,
// as stored), those whose reset passed, and the entry's time and age, the OLDEST window reading's, so a fresh window
// never makes an old one look fresh.
type CodexView struct {
	Live, Reset *jsjson.Object
	UpdatedAt   *string
	AgeMs       *float64
}

// codexAccount is the first configured account on Codex, in the file's order.
func codexAccount(set config.Settings) (string, config.CostAccount, bool) {
	for _, name := range set.CostShape.AccountOrder {
		if a := set.CostAccounts[name]; a.Harness == "codex" {
			return name, a, true
		}
	}
	return "", config.CostAccount{}, false
}

// CodexView is src/codex-usage-view.ts codexView (S-1361): the newest of this machine's and the peers' reading of each
// window, and a window whose reset time has passed shown as reset with the reading's age, never as its old percentage.
// data is the stored codex entry (nil for none), updatedAt its time (nil for none).
func (l *Lifecycle) CodexView(data jsjson.Value, updatedAt *string, now float64) CodexView {
	local := math.NaN()
	if updatedAt != nil {
		local = dateParse(*updatedAt)
	}
	finite := func(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }
	var oldest *float64
	peer := newWins()
	if name, acct, ok := codexAccount(l.settings.Get()); ok {
		peer = l.peerWindows(name, acct, now)
	}
	live, reset := jsjson.NewObject(), jsjson.NewObject()
	// A peer's `ID/window` key belongs to a `codex:ID` bucket, not to this entry.
	var names []string
	seen := map[string]bool{}
	ownKeys, _ := entries(data)
	if _, isObj := data.(*jsjson.Object); !isObj {
		ownKeys = nil
	}
	for _, k := range ownKeys {
		if !seen[k] {
			seen[k], names = true, append(names, k)
		}
	}
	for _, k := range peer.names() {
		if !seen[k] && !strings.Contains(k, "/") {
			seen[k], names = true, append(names, k)
		}
	}
	for _, name := range names {
		own := field(data, name)
		ownPct, hasOwn := jsNumberOf(field(own, "used_percentage"))
		p, hasPeer := peer.get(name)
		if !hasOwn && !hasPeer {
			live.Set(name, own)
			continue
		}
		// The newer of the two readings of this window.
		usePeer := hasPeer && (!hasOwn || !finite(local) || p.at > local)
		pct, at := ownPct, local
		var resets *float64
		if usePeer {
			pct, at, resets = p.pct, p.at, p.resets
		} else if r, ok := jsNumberOf(field(own, "resets_at")); ok {
			resets = &r
		}
		if finite(at) && (oldest == nil || at < *oldest) {
			a := at
			oldest = &a
		}
		if resets != nil && *resets*1000 <= now {
			from := now
			if finite(at) {
				from = at
			}
			reset.Set(name, jsjson.NewObject("reset", true, "resets_at", *resets, "age_ms", math.Max(0, now-from)))
			continue
		}
		w := jsjson.NewObject("used_percentage", pct)
		if resets != nil {
			w.Set("resets_at", *resets)
		}
		if finite(at) {
			w.Set("at", isoMs(at))
			w.Set("age_ms", math.Max(0, now-at))
		}
		live.Set(name, w)
	}
	if oldest == nil && finite(local) {
		oldest = &local
	}
	v := CodexView{Live: live, Reset: reset}
	if oldest != nil {
		s, age := isoMs(*oldest), math.Max(0, now-*oldest)
		v.UpdatedAt, v.AgeMs = &s, &age
	}
	return v
}

// subEntry is src/readings.ts Entry: a subscriptions row, its data nil when it isn't JSON.
type subEntry struct {
	data      jsjson.Value
	updatedAt string
}

func (l *Lifecycle) subEntry(ctx context.Context, name string) (*subEntry, error) {
	data, at, ok, err := l.db.Subscription(ctx, name)
	if err != nil || !ok {
		return nil, err
	}
	v, err := jsjson.Parse([]byte(data))
	if err != nil {
		v = nil
	}
	return &subEntry{data: v, updatedAt: at}, nil
}

// readingAge is src/readings.ts ageMs.
func readingAge(updatedAt *string, now float64) (float64, bool) {
	if updatedAt == nil || *updatedAt == "" {
		return 0, false
	}
	t := dateParse(*updatedAt)
	if math.IsNaN(t) {
		return 0, false
	}
	return math.Max(0, now-t), true
}

// readingStale is src/readings.ts isStale.
func readingStale(updatedAt *string, active bool, now float64) bool {
	age, ok := readingAge(updatedAt, now)
	return ok && age > staleReadingMs && active
}

// readingWindows is src/readings.ts windowsOf: the entries that carry a used_percentage.
func readingWindows(data jsjson.Value) *jsjson.Object {
	out := jsjson.NewObject()
	keys, vals := entries(data)
	for i, name := range keys {
		pct, ok := jsNumberOf(field(vals[i], "used_percentage"))
		if !ok {
			continue
		}
		r, ok := jsNumberOf(field(vals[i], "resets_at"))
		out.Set(name, jsjson.NewObject("used_percentage", pct, "resets_at", optNum(r, ok)))
	}
	return out
}

// truthy is JavaScript's truthiness of a parsed JSON value.
func truthy(v jsjson.Value) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// creditsFor is src/readings.ts creditsFor: Codex's credits balance, or OpenRouter's remaining credit; nil when the
// account has no such source.
func (l *Lifecycle) creditsFor(ctx context.Context, acct config.CostAccount, name string) (balance jsjson.Value, updatedAt *string, err error) {
	read := func(entry, key string, credits func(data jsjson.Value) jsjson.Value) (jsjson.Value, *string, error) {
		e, err := l.subEntry(ctx, entry)
		if err != nil || e == nil {
			return nil, nil, err
		}
		c := credits(e.data)
		if !truthy(c) {
			return nil, nil, nil
		}
		b, ok := jsNumberOf(field(c, key))
		return optNum(b, ok), &e.updatedAt, nil
	}
	if acct.Harness == "codex" {
		return read("codex", "balance", func(d jsjson.Value) jsjson.Value {
			if c := field(d, "credits"); c != nil {
				return c
			}
			return field(field(d, "windows"), "credits")
		})
	}
	if isOpenRouter(acct, name) {
		return read("openrouter", "remaining", func(d jsjson.Value) jsjson.Value { return field(d, "credits") })
	}
	return nil, nil, nil
}

// AccountReadings is src/readings.ts accountReadings: every configured account's reading, in the file's order.
func (l *Lifecycle) AccountReadings(ctx context.Context, now float64) ([]*jsjson.Object, error) {
	set := l.settings.Get()
	agents, err := l.db.ListLiveAgents(ctx)
	if err != nil {
		return nil, err
	}
	activeAccounts := map[string]bool{}
	for _, a := range agents {
		if a.Lifecycle == "active" {
			activeAccounts[set.AccountFor(a.Harness, a.Model)] = true
		}
	}
	at := time.UnixMilli(int64(now))
	out := []*jsjson.Object{}
	for _, name := range set.CostShape.AccountOrder {
		acct := set.CostAccounts[name]
		basis := basisOf(set, acct, name)
		isCodex := acct.Harness == "codex"
		sub, err := l.subEntry(ctx, acct.Harness)
		if err != nil {
			return nil, err
		}
		// Codex: the newest of this machine's and the peers' readings, a passed reset taken out (S-1361).
		var view *CodexView
		if isCodex {
			var data jsjson.Value
			var upd *string
			if sub != nil {
				data, upd = sub.data, &sub.updatedAt
			}
			v := l.CodexView(data, upd, now)
			view = &v
			if v.UpdatedAt != nil {
				sub = &subEntry{data: v.Live, updatedAt: *v.UpdatedAt}
			}
		}
		balance, creditsAt, err := l.creditsFor(ctx, acct, name)
		if err != nil {
			return nil, err
		}
		active := isCodex || activeAccounts[name]
		var subAt *string
		if sub != nil {
			subAt = &sub.updatedAt
		}
		subFresh := sub != nil && !readingStale(subAt, active, now)
		creditsFresh := creditsAt != nil && !readingStale(creditsAt, active, now)
		openrouter := isOpenRouter(acct, name)
		updatedAt := subAt
		if updatedAt == nil {
			updatedAt = creditsAt
		}

		// The ledger is always read: `paid` controls only whether report() accrues more, so turning it off never hides
		// spend that was already recorded. Codex reports no cost, so its period spend stays unknown.
		paid := func(per string) (*jsjson.Object, error) {
			since := sincePtr(per, at)
			switch {
			case basis == basisPriced:
				usd, err := l.pricedSpend(ctx, name, since, l.prices())
				return jsjson.NewObject("usd", usd, "source", "estimate"), err
			case isCodex:
				return jsjson.NewObject("usd", nil, "source", "unknown"), nil
			case openrouter:
				usd, err := l.db.Ledger(ctx, name, "cost_usd", since)
				return jsjson.NewObject("usd", usd, "source", "exact"), err
			}
			usd, err := l.db.Ledger(ctx, name, "paid_estimate_usd", since)
			source := "unknown"
			if subFresh {
				source = "estimate"
			}
			return jsjson.NewObject("usd", usd, "source", source), err
		}
		paidObj := jsjson.NewObject()
		for _, p := range [][2]string{{"today", "day"}, {"week", "week"}, {"month", "month"}} {
			v, err := paid(p[1])
			if err != nil {
				return nil, err
			}
			paidObj.Set(p[0], v)
		}

		var budget jsjson.Value
		if b := acct.Budget; b != nil {
			spent, ok, err := l.spentFor(ctx, name, basis, b.Per, at)
			if err != nil {
				return nil, err
			}
			var remaining jsjson.Value
			if ok {
				remaining = math.Max(0, b.USD-spent)
			}
			usd := jsjson.Value(b.USD)
			if math.IsNaN(b.USD) {
				usd = nil
			}
			budget = jsjson.NewObject("usd", usd, "per", b.Per, "spent", optNum(spent, ok), "remaining", remaining)
		}

		var provider jsjson.Value
		if p := payPerTokenProvider(set, acct, name); p != "" {
			provider = p
		}
		r := jsjson.NewObject("account", name, "match", set.CostShape.AccountMatch[name], "provider", provider)
		var data jsjson.Value
		if sub != nil {
			data = sub.data
		}
		r.Set("windows", readingWindows(data))
		if view != nil {
			r.Set("reset_windows", view.Reset)
		}
		var updated jsjson.Value
		if updatedAt != nil {
			updated = *updatedAt
		}
		r.Set("updated_at", updated)
		r.Set("age_ms", optNum(readingAge(updatedAt, now)))
		r.Set("stale", readingStale(updatedAt, active, now))
		r.Set("paid", paidObj)
		if creditsFresh {
			r.Set("balance", balance)
		} else {
			r.Set("balance", nil)
		}
		r.Set("budget", budget)
		out = append(out, r)
	}
	return out, nil
}

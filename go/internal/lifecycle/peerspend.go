package lifecycle

import (
	"context"
	"os"
	"strconv"
	"sync"
	"time"

	"stam/internal/jsjson"
)

// Paid spend across machines (src/peer-spend.ts, S-395, S-2848 B5a). A budget is one number for the whole system, so
// each daemon adds the peers' paid spend to its own when it evaluates a budget. A peer serves its own totals at GET
// /api/usage/spend (LocalSpend); this keeps each peer's last answer and refreshes it every peerSpendEvery. A peer that
// doesn't answer keeps its last total for peerSpendStale, then counts as zero, so an unreachable machine never holds a
// spawn on a stale or missing number.
//
// An answer is kept when it has a truthy global, as in TS. A total that isn't a number counts as 0 here; TS would add it
// as whatever it is.

// spendPers are src/peer-spend.ts PERS, in their order.
var spendPers = [...]string{"day", "week", "month", "cap"}

// PeerSpend is how the budgets reach the peers: their names, and one peer's GET /api/usage/spend, its status and body.
type PeerSpend interface {
	Peers() []string
	Spend(ctx context.Context, peer string) (status int, body []byte, err error)
}

type spendAnswer struct {
	at    float64
	spend *jsjson.Object
}

// spendState is the peers' last answers, in the order they first answered, and those whose answer went stale; under the
// Lifecycle's mu.
type spendState struct {
	source    PeerSpend
	order     []string
	cache     map[string]spendAnswer
	wentStale map[string]bool
}

// SetPeerSpend sets how the budgets read the peers' spend; nil reads none.
func (l *Lifecycle) SetPeerSpend(p PeerSpend) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.spend.source = p
}

// envVar is src/env.ts envVar: MOOTR_NAME, else STAM_NAME.
func envVar(name string) string {
	if v, ok := os.LookupEnv("MOOTR_" + name); ok {
		return v
	}
	return os.Getenv("STAM_" + name)
}

// envMs is `Number(envVar(name)) || fallback` in milliseconds.
func envMs(name string, fallback time.Duration) time.Duration {
	if n, err := strconv.ParseFloat(envVar(name), 64); err == nil && n != 0 && finite(n) {
		return time.Duration(n * float64(time.Millisecond))
	}
	return fallback
}

// peerSpendEvery is src/peer-spend.ts REFRESH_MS, and peerSpendStale STALE_MS.
func peerSpendEvery() time.Duration { return envMs("PEER_SPEND_MS", 30*time.Second) }
func peerSpendStale() time.Duration { return envMs("PEER_SPEND_STALE_MS", 10*time.Minute) }

// LocalSpend is src/peer-spend.ts localSpend, GET /api/usage/spend's answer: this machine's paid spend by period, global
// over every account and per configured account (in name order; TS gives the file's order), a period with no paid
// ledger as 0.
func (l *Lifecycle) LocalSpend(ctx context.Context, now time.Time) (*jsjson.Object, error) {
	totals := func(f func(per string) (float64, bool, error)) (*jsjson.Object, error) {
		o := jsjson.NewObject()
		for _, per := range spendPers {
			v, ok, err := f(per)
			if err != nil {
				return nil, err
			}
			if !ok {
				v = 0
			}
			o.Set(per, v)
		}
		return o, nil
	}
	accounts := jsjson.NewObject()
	for _, name := range sortedAccounts(l.settings.Get()) {
		t, err := totals(func(per string) (float64, bool, error) { return l.paidSpentIn(ctx, name, per, now) })
		if err != nil {
			return nil, err
		}
		accounts.Set(name, t)
	}
	global, err := totals(func(per string) (float64, bool, error) {
		v, err := l.paidSpentAll(ctx, per, now)
		return v, true, err
	})
	if err != nil {
		return nil, err
	}
	return jsjson.NewObject("global", global, "accounts", accounts), nil
}

// PaidSpendByMachine is GET /api/usage's paid_spend_by_machine (src/peer-spend.ts refresh, then perMachine): this
// machine's totals, then each configured peer's last answer, nil when it has none or it went stale.
func (l *Lifecycle) PaidSpendByMachine(ctx context.Context, now time.Time) (*jsjson.Object, error) {
	l.refreshPeerSpend(ctx, ms(now))
	local, err := l.LocalSpend(ctx, now)
	if err != nil {
		return nil, err
	}
	out := jsjson.NewObject(l.machine, local)
	l.mu.Lock()
	src := l.spend.source
	cache := make(map[string]spendAnswer, len(l.spend.cache))
	for k, v := range l.spend.cache {
		cache[k] = v
	}
	l.mu.Unlock()
	if src == nil {
		return out, nil
	}
	stale := float64(peerSpendStale().Milliseconds())
	for _, p := range src.Peers() {
		if c, ok := cache[p]; ok && ms(now)-c.at <= stale {
			out.Set(p, c.spend)
		} else {
			out.Set(p, nil)
		}
	}
	return out, nil
}

// peersSpent is src/peer-spend.ts peersSpent: what the peers still configured spent in a scope (an account, or global)
// over a period, from their last answers no older than peerSpendStale.
func (l *Lifecycle) peersSpent(scope, per string, now float64) float64 {
	l.mu.Lock()
	src := l.spend.source
	order := append([]string(nil), l.spend.order...)
	cache := make(map[string]spendAnswer, len(l.spend.cache))
	for k, v := range l.spend.cache {
		cache[k] = v
	}
	l.mu.Unlock()
	if src == nil {
		return 0
	}
	configured := map[string]bool{}
	for _, p := range src.Peers() {
		configured[p] = true
	}
	stale := float64(peerSpendStale().Milliseconds())
	sum := 0.0
	for _, name := range order {
		c, ok := cache[name]
		if !ok || now-c.at > stale || !configured[name] {
			continue
		}
		totals := field(c.spend, "global")
		if scope != globalScope {
			totals = field(field(c.spend, "accounts"), scope)
		}
		if n, ok := field(totals, per).(float64); ok {
			sum += n
		}
	}
	return sum
}

// refreshPeerSpend is src/peer-spend.ts refresh: each peer's totals asked for; the budgets are evaluated again when a
// total moved or a peer's last answer went stale, which it reports.
func (l *Lifecycle) refreshPeerSpend(ctx context.Context, now float64) bool {
	l.mu.Lock()
	src := l.spend.source
	l.mu.Unlock()
	if src == nil {
		return false
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	changed := false
	for _, p := range src.Peers() {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, 4*time.Second)
			defer cancel()
			status, body, err := src.Spend(cctx, p)
			if err != nil || status != 200 {
				return
			}
			v, err := jsjson.Parse(body)
			if err != nil || !jsjson.Truthy(field(v, "global")) {
				// Keep the last answer until it goes stale.
				return
			}
			spend, _ := v.(*jsjson.Object)
			text := jsjson.Stringify(spend, "")
			mu.Lock()
			defer mu.Unlock()
			l.mu.Lock()
			defer l.mu.Unlock()
			if l.spend.cache == nil {
				l.spend.cache, l.spend.wentStale = map[string]spendAnswer{}, map[string]bool{}
			}
			old, seen := l.spend.cache[p]
			if !seen {
				l.spend.order = append(l.spend.order, p)
			}
			if !seen || jsjson.Stringify(old.spend, "") != text {
				changed = true
			}
			l.spend.cache[p] = spendAnswer{at: now, spend: spend}
			if l.spend.wentStale[p] {
				delete(l.spend.wentStale, p)
				changed = true
			}
		}(p)
	}
	wg.Wait()
	// A peer whose last answer just went stale stops counting, which can lift a budget stop.
	stale := float64(peerSpendStale().Milliseconds())
	l.mu.Lock()
	for name, c := range l.spend.cache {
		if now-c.at > stale && !l.spend.wentStale[name] {
			l.spend.wentStale[name] = true
			changed = true
		}
	}
	l.mu.Unlock()
	if changed {
		l.EvaluateAllBudgets(time.Now(), "")
	}
	return changed
}

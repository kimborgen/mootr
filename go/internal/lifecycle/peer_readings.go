package lifecycle

import (
	"context"
	"log/slog"
	"math"
	"sync"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// Subscription readings across machines (src/peer-readings.ts, S-2367, S-2848 B4b): a window's wait clears on a fresh
// reading of the same account taken on any machine, so a machine whose agents are all paused still lifts its window
// blockers after a reset another machine has seen. Each daemon serves its windows per account at GET
// /api/usage/readings (ServedReadings); this keeps each peer's last answer and refreshes it every peerReadingsEvery.
// An account matches a peer's only by its name and match, and each reading is judged by its own at against
// staleReading. A peer's reading never sets a blocker.
//
// It fails closed: a peer that fails, answers something that isn't an object, or holds even one malformed window (a
// percentage or time that isn't a finite number, a reset missing or neither a finite number nor null) has its whole
// answer rejected and keeps its last one until that goes stale. A stale reading counts for nothing.

// peerReadingsEvery is src/peer-readings.ts REFRESH_MS.
const peerReadingsEvery = 30 * time.Second

// PeerReadings is how the rules reach the peers: their names, and one peer's GET /api/usage/readings, its status and
// body.
type PeerReadings interface {
	Peers() []string
	Readings(ctx context.Context, peer string) (status int, body []byte, err error)
}

type peerAnswer struct {
	at     float64
	served *jsjson.Object
}

// peerState is the peers' last answers, in the order they first answered, and those whose answer went stale; under
// the Lifecycle's mu.
type peerState struct {
	order     []string
	cache     map[string]peerAnswer
	wentStale map[string]bool
}

// SetPeerReadings sets how the rules read the peers' windows; nil reads none.
func (l *Lifecycle) SetPeerReadings(p PeerReadings) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.peerSource = p
}

// peerWindows is src/peer-readings.ts peerWindows: the newest fresh reading of each window of an account, over the peers
// still configured that answer for the same account with the same match.
func (l *Lifecycle) peerWindows(account string, acct config.CostAccount, now float64) wins {
	out := newWins()
	l.mu.Lock()
	src := l.peerSource
	order := append([]string(nil), l.peers.order...)
	cache := make(map[string]peerAnswer, len(l.peers.cache))
	for k, v := range l.peers.cache {
		cache[k] = v
	}
	l.mu.Unlock()
	if src == nil {
		return out
	}
	configured := map[string]bool{}
	for _, p := range src.Peers() {
		configured[p] = true
	}
	for _, name := range order {
		c := cache[name]
		if now-c.at > float64(staleReading.Milliseconds()) || !configured[name] {
			continue
		}
		s := field(c.served, account)
		match := field(s, "match")
		if s == nil || field(match, "harness") != any(acct.Harness) || !sameModel(field(match, "model"), acct.Model) {
			continue
		}
		windows, _ := field(s, "windows").(*jsjson.Object)
		for _, w := range windows.Keys() {
			v, _ := windows.Get(w)
			x, ok := peerWin(v)
			if !ok || !fresh(x.at, now) {
				continue
			}
			if have, ok := out.get(w); !ok || x.at > have.at {
				out.set(w, x)
			}
		}
	}
	return out
}

// sameModel is `(a.model ?? null) === (b.model ?? null)` for a peer's match and an account's.
func sameModel(v any, model *string) bool {
	if v == nil {
		return model == nil
	}
	s, ok := v.(string)
	return ok && model != nil && s == *model
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// wellFormed is whether a peer's answer can be trusted whole: every account an object, its windows an object, and each
// window one peerWin reads. One malformed window rejects the answer, since skipping it alone could drop the window at
// 100% that a '*' wait needs.
func wellFormed(served *jsjson.Object) bool {
	for _, account := range served.Keys() {
		v, _ := served.Get(account)
		s, ok := v.(*jsjson.Object)
		if !ok {
			return false
		}
		wv, has := s.Get("windows")
		if !has {
			continue
		}
		windows, ok := wv.(*jsjson.Object)
		if !ok {
			return false
		}
		for _, name := range windows.Keys() {
			w, _ := windows.Get(name)
			if _, ok := peerWin(w); !ok {
				return false
			}
		}
	}
	return true
}

// peerWin reads one served window, refusing anything malformed: pct and at must be finite numbers, and resets_at must
// be there, a finite number or null.
func peerWin(v any) (win, bool) {
	o, _ := v.(*jsjson.Object)
	pct, ok := field(v, "pct").(float64)
	at, okAt := field(v, "at").(float64)
	reset, okReset := o.Get("resets_at")
	if !ok || !okAt || !okReset || !finite(pct) || !finite(at) {
		return win{}, false
	}
	w := win{pct: pct, at: at}
	switch r := reset.(type) {
	case nil:
	case float64:
		if !finite(r) {
			return win{}, false
		}
		w.resets = &r
	default:
		return win{}, false
	}
	return w, true
}

// refreshPeerReadings is src/peer-readings.ts refresh: each peer's windows asked for; the rules are evaluated again when
// an answer moved or a peer's last answer went stale.
func (l *Lifecycle) refreshPeerReadings(ctx context.Context, now float64) {
	l.mu.Lock()
	src := l.peerSource
	l.mu.Unlock()
	if src == nil {
		return
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
			status, body, err := src.Readings(cctx, p)
			if err != nil || status != 200 {
				return
			}
			v, err := jsjson.Parse(body)
			served, ok := v.(*jsjson.Object)
			if err != nil || !ok || !wellFormed(served) {
				// Keep the last answer until it goes stale.
				return
			}
			text := jsjson.Stringify(served, "")
			mu.Lock()
			defer mu.Unlock()
			l.mu.Lock()
			defer l.mu.Unlock()
			if l.peers.cache == nil {
				l.peers.cache, l.peers.wentStale = map[string]peerAnswer{}, map[string]bool{}
			}
			old, seen := l.peers.cache[p]
			if !seen {
				l.peers.order = append(l.peers.order, p)
			}
			if !seen || jsjson.Stringify(old.served, "") != text {
				changed = true
			}
			l.peers.cache[p] = peerAnswer{at: now, served: served}
			if l.peers.wentStale[p] {
				delete(l.peers.wentStale, p)
				changed = true
			}
		}(p)
	}
	wg.Wait()
	// A peer whose last answer just went stale stops counting, which can lift a clear or re-set a window.
	l.mu.Lock()
	for name, c := range l.peers.cache {
		if now-c.at > float64(staleReading.Milliseconds()) && !l.peers.wentStale[name] {
			l.peers.wentStale[name] = true
			changed = true
		}
	}
	l.mu.Unlock()
	if changed {
		l.EvaluateAllRules(time.UnixMilli(int64(now)))
		// A fresh reading on any machine can clear a pause here too.
		l.EvaluatePauses(ctx, time.Now())
	}
}

// StartRules is the rules' part of daemon start (src/daemon.ts): the cost fallbacks left mid-run recovered first, before
// anything can evaluate one (recoverAtStart), every account evaluated, every blocked account probed from the first step
// (resumeProbes), the fallbacks that came due run, the cost pauses whose time or reset passed cleared and the rest
// timed, every budget evaluated, and the peers' readings and paid spend refreshed every peerReadingsEvery and
// peerSpendEvery until the daemon stops, the budgets evaluated again on that tick when their settings changed, and the
// OpenRouter credit polled (credits.go).
func (l *Lifecycle) StartRules() {
	l.recoverAtStart(l.ctx)
	l.EvaluateAllRules(time.Now())
	l.goBG(func(ctx context.Context) { l.EvaluatePauses(ctx, time.Now()) })
	if err := l.resumeProbes(l.ctx, ms(time.Now())); err != nil {
		slog.Error("cost probes", "err", err)
	}
	l.goBG(func(ctx context.Context) { l.evaluateFallbacks(ctx, time.Now()) })
	// Every budget, and the peers' paid spend refreshed every peerSpendEvery (src/daemon.ts evaluateAll and
	// peerSpend.start).
	// The same tick reads the budgets' settings: a raise or a removal (a settings change, which src/daemon.ts answers with
	// evaluateAll) lifts its blocker with no spend.
	l.budgetsMoved()
	l.EvaluateAllBudgets(time.Now(), "")
	// The OpenRouter credit: polled now when there is a key, then while an OpenRouter agent is active or held
	// (src/daemon.ts startCreditPolling).
	l.startCreditPolling()
	l.goBG(func(ctx context.Context) {
		l.refreshPeerSpend(ctx, ms(time.Now()))
		tick := time.NewTicker(peerSpendEvery())
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				moved := l.budgetsMoved()
				if !l.refreshPeerSpend(ctx, ms(time.Now())) && moved {
					l.EvaluateAllBudgets(time.Now(), "")
				}
			}
		}
	})
	l.goBG(func(ctx context.Context) {
		l.refreshPeerReadings(ctx, ms(time.Now()))
		tick := time.NewTicker(l.peerEvery)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				l.refreshPeerReadings(ctx, ms(time.Now()))
			}
		}
	})
}

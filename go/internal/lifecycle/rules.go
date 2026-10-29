package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// The user's rules that need no budget (src/rules.ts, docs/cost-policy.md Rule enforcement, S-2848 B4b): stam sets and
// clears the window, paid-forbidden and credits-out blockers from fresh readings and the adapters' cost signals. Every
// trigger goes through evaluateRules(account), one evaluation per account at a time, in arrival order; it is
// idempotent: re-adding a blocker keeps its since, and an unchanged one writes nothing.
//
//	window:ACCOUNT          set on a paid: false account when a fresh reading of this machine puts a window at 100%,
//	                        or on a limit signal; cleared per window by a fresh reading (here or on a peer) taken after
//	                        it was set that reads below 100%, or by the timer past its reset. A window that re-sets
//	                        within flapWindow of its last clear is held flapWindow more.
//	paid-forbidden:ACCOUNT  set when paid spend appears on a paid: false account; cleared by a fresh reading taken after
//	                        its windows' reset, or by the timer.
//	credits-out:ACCOUNT     set on a Claude account by a credits signal, cleared by its probe (probes.go); cleared by a
//	                        fresh balance of at least lowCreditsUsd (Codex: also window headroom).
//
// Where TS would set a blocker that nothing in the Go daemon can clear, it sets nothing here (S-2848: no blocker the Go
// daemon can't lift):
//   - A limit error that names no window always holds until a reset time: the one its message names, else defaultHold.
//     TS holds a Claude limit (whose StopFailure carries no message) until a fresh reading, which an account whose
//     agents are all paused never sends.
//   - A window at 100% with no reset time sets nothing; a paid-forbidden needs a window with a reset time.
//   - credits-out is set only on a Claude account, whose probe clears it: the balances that set the others come from
//     adapters the Go daemon doesn't run. One the TS daemon set on another account is kept, and cleared by a reading.
//   - A blocker the TS daemon recorded with no reset time stays on the agents it holds but spreads to no other.
//
// Not ported: the reviewer fallback on a limit at spawn (cost-fallback.ts); the spawn gate's refusal (admission.ts).

const (
	// defaultHold is src/rules.ts DEFAULT_HOLD_MS: a limit error with no reset time in its message holds this long.
	defaultHold = 30 * time.Minute
	// flapWindow is src/rules.ts FLAP_MS: a window that re-sets within this long of its last clear is held this long
	// more, so a reading that flips it can't pause and resume the account in a loop.
	flapWindow = 10 * time.Minute
	// resetMargin is the default margin past a window's reset before it clears unconfirmed (src/rules.ts
	// resetMarginMs).
	resetMargin = time.Minute
	// resetPassed is src/rules.ts RESET_PASSED.
	resetPassed = "its reset time passed; no fresh reading confirmed it"
)

// rulesState is the rules' per-account evaluation chain and timers, under the Lifecycle's mu.
type rulesState struct {
	// tails is each account's last queued evaluation, which the next waits for.
	tails map[string]chan struct{}
	// timers, dues and firedLate are src/rules.ts timers, dues and firedLate: each account's wake, when it is due (ms),
	// and the overdue wake that already fired.
	timers    map[string]*time.Timer
	dues      map[string]float64
	firedLate map[string]float64
}

// Trigger is src/rules.ts Trigger: a cost signal (its class, source, and the limit message if any), or paid spend.
type Trigger struct {
	Signal *Signal
	Paid   *Paid
}

// Signal is a limit or credits signal.
type Signal struct {
	Class, Source string
	Message       *string
}

// Paid is paid spend seen on a paid: false account.
type Paid struct{ Source string }

// win is src/rules.ts Win: a window's percentage, reset (seconds, nil for none) and when it was read (ms).
type win struct {
	pct    float64
	resets *float64
	at     float64
}

// wins is windows by name, in JavaScript's key order.
type wins struct{ o *jsjson.Object }

func newWins() wins { return wins{jsjson.NewObject()} }

func (w wins) set(name string, x win) { w.o.Set(name, x) }

func (w wins) get(name string) (win, bool) {
	v, ok := w.o.Get(name)
	x, _ := v.(win)
	return x, ok
}

func (w wins) names() []string { return w.o.Keys() }

func (w wins) clone() wins {
	out := newWins()
	for _, n := range w.names() {
		x, _ := w.get(n)
		out.set(n, x)
	}
	return out
}

type stamped struct{ usd, at float64 }

type spendControl struct {
	reached bool
	at      float64
}

// reading is src/rules.ts Reading.
type reading struct {
	windows wins
	balance *stamped
	spend   *spendControl
}

// step is src/rules.ts Step: what one rule kind wants for the account now.
type step struct {
	kind        string
	want        *want
	why         string
	unconfirmed bool
	// probed is a credits-out the account's probe clears (a Claude account), so it is clearable here.
	probed bool
}

// want is a blocker's reason and clear condition (nil for null).
type want struct {
	reason string
	clear  jsjson.Value
}

// ms is a time as JavaScript's Date.now().
func ms(t time.Time) float64 { return float64(t.UnixMilli()) }

// isoMs is new Date(t).toISOString().
func isoMs(t float64) string { return iso(time.UnixMilli(int64(t))) }

// utcSec is src/rules.ts utc: a reset time in seconds as "YYYY-MM-DD HH:MM UTC".
func utcSec(s float64) string {
	return time.UnixMilli(int64(s*1000)).UTC().Format("2006-01-02 15:04") + " UTC"
}

// dateParse is Date.parse for the ISO times stam writes; NaN when it isn't one.
func dateParse(v jsjson.Value) float64 {
	s, ok := v.(string)
	if !ok {
		return math.NaN()
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return math.NaN()
	}
	return ms(t)
}

// readNum is src/rules.ts num: a finite number, or a string that reads as one; ok is false otherwise.
func readNum(v jsjson.Value) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, !math.IsInf(x, 0) && !math.IsNaN(x)
	case string:
		if jsjson.Trim(x) == "" {
			return 0, false
		}
		n := jsjson.ToNumber(x)
		return n, !math.IsInf(n, 0) && !math.IsNaN(n)
	}
	return 0, false
}

// field is v[key] for an object v, nil for anything else (JavaScript's v?.[key] on parsed JSON).
func field(v jsjson.Value, key string) jsjson.Value {
	o, _ := v.(*jsjson.Object)
	x, _ := o.Get(key)
	return x
}

// entries is Object.entries(v) for parsed JSON: an object's keys or an array's indices, with their values.
func entries(v jsjson.Value) ([]string, []jsjson.Value) {
	switch x := v.(type) {
	case *jsjson.Object:
		keys := x.Keys()
		vals := make([]jsjson.Value, len(keys))
		for i, k := range keys {
			vals[i], _ = x.Get(k)
		}
		return keys, vals
	case []any:
		keys := make([]string, len(x))
		for i := range x {
			keys[i] = strconv.Itoa(i)
		}
		return keys, x
	}
	return nil, nil
}

// numOr is `v ?? d` read as a number, as JavaScript compares and adds a parsed JSON value.
func numOr(v jsjson.Value, d float64) float64 {
	if v == nil {
		return d
	}
	return jsjson.ToNumber(v)
}

// rulesOpenRouter is src/rules.ts isOpenRouter: an OpenCode account on an openrouter/ model.
func rulesOpenRouter(acct config.CostAccount) bool {
	return acct.Harness == "opencode" && strings.HasPrefix(deref(acct.Model), "openrouter/")
}

func (l *Lifecycle) margin() float64 { return float64(l.resetMargin.Milliseconds()) }

func fresh(at, now float64) bool { return now-at <= float64(staleReading.Milliseconds()) }

// full is src/rules.ts full: a window that reads 100% and hasn't reset.
func full(w win, now float64) bool { return w.pct >= 100 && (w.resets == nil || *w.resets*1000 > now) }

// deadline is src/rules.ts deadline: a window wait's timer, its reset plus the margin, or its flap hold's end when that
// is later.
func (l *Lifecycle) deadline(w jsjson.Value) float64 {
	return math.Max(jsjson.ToNumber(field(w, "resets_at"))*1000+l.margin(), numOr(field(w, "hold"), 0))
}

// timedOut is src/rules.ts timedOut: a window wait whose reset time, plus the margin, has passed.
func (l *Lifecycle) timedOut(w jsjson.Value, now float64) bool {
	return field(w, "resets_at") != nil && now >= l.deadline(w)
}

// readingFor is src/rules.ts readingFor: the subscriptions entries an account reads, its harness's (Codex's other
// buckets as codex:ID, their windows named ID/WINDOW), or OpenRouter's credit poll.
func (l *Lifecycle) readingFor(ctx context.Context, acct config.CostAccount) (reading, error) {
	r := reading{windows: newWins()}
	rows, err := l.db.Subscriptions(ctx)
	if err != nil {
		return r, err
	}
	for _, row := range rows {
		data, err := jsjson.Parse([]byte(row.Data))
		if err != nil {
			continue
		}
		if data == nil {
			data = jsjson.NewObject()
		}
		at := dateParse(row.UpdatedAt)
		if math.IsNaN(at) {
			continue
		}
		if rulesOpenRouter(acct) {
			// Only a balance the poll fetched counts, at the time it fetched it.
			usd, ok := readNum(field(field(data, "credits"), "remaining"))
			seen := dateParse(field(field(data, "credits"), "observed_at"))
			if row.Name == "openrouter" && ok && !math.IsNaN(seen) {
				r.balance = &stamped{usd, seen}
			}
			continue
		}
		h := acct.Harness
		if row.Name != h && !strings.HasPrefix(row.Name, h+":") {
			continue
		}
		prefix := ""
		if row.Name != h {
			prefix = row.Name[len(h)+1:] + "/"
		}
		names, vals := entries(data)
		for i, name := range names {
			pct, ok := readNum(field(vals[i], "used_percentage"))
			if !ok {
				continue
			}
			w := win{pct: pct, at: at}
			if s, ok := readNum(field(vals[i], "resets_at")); ok {
				w.resets = &s
			}
			r.windows.set(prefix+name, w)
		}
		if row.Name == h {
			if usd, ok := readNum(field(field(data, "credits"), "balance")); ok {
				r.balance = &stamped{usd, at}
			}
			if reached, ok := field(data, "spendControlReached").(bool); ok {
				r.spend = &spendControl{reached, at}
			}
		}
	}
	return r, nil
}

// acrossMachines is src/rules.ts acrossMachines: each window at its newest reading across this machine and its peers
// (all, what a clear reads), and this machine's windows not overtaken by a newer peer reading below 100% (own, what a
// set reads). A peer's reading below 100% is kept in window_resets, so the local reading stays overtaken.
func (l *Lifecycle) acrossMachines(ctx context.Context, account string, acct config.CostAccount, local wins, now float64) (all, own wins, err error) {
	all = local.clone()
	peer := l.peerWindows(account, acct, now)
	for _, name := range peer.names() {
		w, _ := peer.get(name)
		if w.pct < 100 {
			if err := l.db.NoteWindowReset(ctx, account, name, w.at); err != nil {
				return all, own, err
			}
		}
		if x, ok := all.get(name); !ok || w.at > x.at {
			all.set(name, w)
		}
	}
	own = newWins()
	for _, name := range local.names() {
		w, _ := local.get(name)
		reset, ok, err := l.db.WindowResetAt(ctx, account, name)
		if err != nil {
			return all, own, err
		}
		if !ok || w.at >= reset {
			own.set(name, w)
		}
	}
	return all, own, nil
}

// accountWindows is src/rules.ts accountWindows: the account's windows, each at its newest reading on any machine.
// The cost pauses read it (part B4c).
func (l *Lifecycle) accountWindows(ctx context.Context, account string, now float64) (wins, error) {
	acct, ok := l.settings.Get().CostAccounts[account]
	if !ok {
		return newWins(), nil
	}
	r, err := l.readingFor(ctx, acct)
	if err != nil {
		return newWins(), err
	}
	all, _, err := l.acrossMachines(ctx, account, acct, r.windows, now)
	return all, err
}

// ServedReadings is src/rules.ts servedReadings, GET /api/usage/readings: this machine's own windows per configured
// account, with the account's match, for a peer's peer readings.
func (l *Lifecycle) ServedReadings(ctx context.Context) (*jsjson.Object, error) {
	set := l.settings.Get()
	names := make([]string, 0, len(set.CostAccounts))
	for name := range set.CostAccounts {
		names = append(names, name)
	}
	sort.Strings(names)
	out := jsjson.NewObject()
	for _, name := range names {
		acct := set.CostAccounts[name]
		r, err := l.readingFor(ctx, acct)
		if err != nil {
			return nil, err
		}
		match := jsjson.NewObject("harness", acct.Harness)
		if acct.Model != nil {
			match.Set("model", *acct.Model)
		}
		windows := jsjson.NewObject()
		for _, n := range r.windows.names() {
			w, _ := r.windows.get(n)
			var resets jsjson.Value
			if w.resets != nil {
				resets = *w.resets
			}
			windows.Set(n, jsjson.NewObject("pct", w.pct, "resets_at", resets, "at", w.at))
		}
		out.Set(name, jsjson.NewObject("match", match, "windows", windows))
	}
	return out, nil
}

// EvaluateRules is src/rules.ts evaluateRules: one evaluation per account at a time, in arrival order, at now. The
// channel closes when it has run (or once the daemon stopped, without running).
func (l *Lifecycle) EvaluateRules(account string, t Trigger, now time.Time) <-chan struct{} {
	return l.onChain(account, func(ctx context.Context) error { return l.evaluate(ctx, account, &t, ms(now)) })
}

// onChain runs fn on the account's rules chain, after everything queued on it, and logs its error. The channel closes
// when fn has run (or once the daemon stopped, without running).
func (l *Lifecycle) onChain(account string, fn func(context.Context) error) <-chan struct{} {
	return l.chain(account, "cost rules", fn)
}

// chain is onChain for any key (the budgets key theirs by scope), its error logged under what.
func (l *Lifecycle) chain(account, what string, fn func(context.Context) error) <-chan struct{} {
	done := make(chan struct{})
	l.mu.Lock()
	if l.waited || l.ctx.Err() != nil {
		l.mu.Unlock()
		close(done)
		return done
	}
	if l.rules.tails == nil {
		l.rules.tails = map[string]chan struct{}{}
	}
	prev := l.rules.tails[account]
	l.rules.tails[account] = done
	l.bg.Add(1)
	l.bgRunning.Add(1)
	l.mu.Unlock()
	go func() {
		defer l.bg.Done()
		defer l.bgRunning.Add(-1)
		defer func() {
			l.mu.Lock()
			if l.rules.tails[account] == done {
				delete(l.rules.tails, account)
			}
			l.mu.Unlock()
			close(done)
		}()
		if prev != nil {
			if f := l.chainWaiting; f != nil {
				f(account)
			}
			<-prev
		}
		if err := fn(l.ctx); err != nil {
			slog.Error(what, "account", strings.TrimPrefix(account, budgetChain), "err", err)
		}
	}()
	return done
}

// EvaluateAllRules is src/rules.ts evaluateAll: every configured account, as at daemon start.
func (l *Lifecycle) EvaluateAllRules(now time.Time) {
	for account := range l.settings.Get().CostAccounts {
		l.EvaluateRules(account, Trigger{}, now)
	}
}

// onReading is src/rules.ts onReading: a reading was stored under this subscriptions name; the accounts it covers are
// evaluated, a Codex credits balance that dropped as paid spend.
func (l *Lifecycle) onReading(name string, prev, next jsjson.Value, now time.Time) {
	for account, acct := range l.settings.Get().CostAccounts {
		covers := rulesOpenRouter(acct)
		if name != "openrouter" {
			covers = !rulesOpenRouter(acct) && (name == acct.Harness || strings.HasPrefix(name, acct.Harness+":"))
		}
		if !covers {
			continue
		}
		t := Trigger{}
		was, okWas := readNum(field(field(prev, "credits"), "balance"))
		is, okIs := readNum(field(field(next, "credits"), "balance"))
		if name == acct.Harness && okWas && okIs && is < was {
			t.Paid = &Paid{Source: "credits balance fell from " + jsjson.Number(was) + " to " + jsjson.Number(is)}
		}
		l.EvaluateRules(account, t, now)
	}
}

type signalEvent struct {
	Source string `json:"source"`
	Class  string `json:"class"`
	Error  string `json:"error"`
}

// costSignal is src/rules.ts signal for a Claude StopFailure: the signal is recorded; a transient or auth one sets the
// account's error blocker and starts its probe (probes.go), a credits one starts the probe that clears its credits-out
// and evaluates the account, as a limit one does. The reviewer fallback on a limit at spawn isn't ported.
func (l *Lifecycle) costSignal(ctx context.Context, a db.Agent, s claude.CostSignal) {
	l.signal(ctx, a, s.Class, "StopFailure ("+s.Error+")", signalEvent{Source: "StopFailure", Class: s.Class, Error: s.Error})
}

// signal is src/rules.ts signal past its source: ev is recorded as the agent's cost:signal, and class acts on the
// agent's account, with source (src/rules.ts describe) as what it names.
func (l *Lifecycle) signal(ctx context.Context, a db.Agent, class, source string, ev any) {
	l.event(ctx, a.ID, "cost:signal", ev)
	account := l.settings.Get().AccountFor(a.Harness, a.Model)
	if account == "" {
		return
	}
	switch class {
	case "transient", "auth":
		now := ms(time.Now())
		l.goBG(func(ctx context.Context) {
			if err := l.onError(ctx, a, class, source, now); err != nil {
				slog.Error("cost error", "account", account, "err", err)
			}
		})
		return
	case "credits":
		// Before the evaluation is queued: a probe success already on the chain is older than it.
		if l.probed(account) {
			l.costProbes.mu.Lock()
			l.startProbe(account, ms(time.Now()))
			l.costProbes.mu.Unlock()
		}
	case "limit":
	default:
		return
	}
	l.EvaluateRules(account, Trigger{Signal: &Signal{Class: class, Source: source}}, time.Now())
}

// agentsOn is src/rules.ts agentsOn: every live agent on the account.
func (l *Lifecycle) agentsOn(ctx context.Context, account string) ([]db.Agent, error) {
	all, err := l.db.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	set := l.settings.Get()
	var out []db.Agent
	for _, a := range all {
		if (a.Lifecycle == "active" || a.Lifecycle == "paused") && set.AccountFor(a.Harness, a.Model) == account {
			out = append(out, a)
		}
	}
	return out, nil
}

// parsedBlocker is a blocker with its clear condition parsed (src/blockers.ts parse).
type parsedBlocker struct {
	db.Blocker
	clear jsjson.Value
}

func parseBlockers(rows []db.Blocker) ([]parsedBlocker, error) {
	out := make([]parsedBlocker, len(rows))
	for i, b := range rows {
		out[i].Blocker = b
		if b.Clear != nil && *b.Clear != "" {
			v, err := jsjson.Parse([]byte(*b.Clear))
			if err != nil {
				// TS's JSON.parse throws, and the evaluation stops before it changes anything.
				return nil, err
			}
			out[i].clear = v
		}
	}
	return out, nil
}

// plan is src/rules.ts plan: what the rules want for the account now, each rule kind's blocker or none. Its only
// writes are the account_holds row and window_resets.
func (l *Lifecycle) plan(ctx context.Context, account string, t *Trigger, now float64) ([]step, error) {
	acct, ok := l.settings.Get().CostAccounts[account]
	if !ok {
		return nil, nil
	}
	r, err := l.readingFor(ctx, acct)
	if err != nil {
		return nil, err
	}
	all, own, err := l.acrossMachines(ctx, account, acct, r.windows, now)
	if err != nil {
		return nil, err
	}
	// Clears read the newest reading on any machine; sets read only this machine's own.
	m := reading{windows: all, balance: r.balance, spend: r.spend}
	unpaid := acct.Paid != nil && !*acct.Paid
	// A window at 100% with no reset time is left out: nothing here would clear what it set.
	var freshFull []string
	for _, name := range own.names() {
		w, _ := own.get(name)
		if fresh(w.at, now) && full(w, now) && w.resets != nil {
			freshFull = append(freshFull, name)
		}
	}
	soonest := func() (string, bool) {
		best, found := "", false
		var at float64
		for _, name := range own.names() {
			w, _ := own.get(name)
			if fresh(w.at, now) && w.resets != nil && *w.resets*1000 > now && (!found || *w.resets < at) {
				best, at, found = name, *w.resets, true
			}
		}
		return best, found
	}
	rows, err := l.db.BlockersFor(ctx, account)
	if err != nil {
		return nil, err
	}
	blocks, err := parseBlockers(rows)
	if err != nil {
		return nil, err
	}
	existing := func(kind string) []parsedBlocker {
		var out []parsedBlocker
		for _, b := range blocks {
			if b.Kind == kind {
				out = append(out, b)
			}
		}
		return out
	}
	var steps []step

	// window
	{
		cur := jsjson.NewObject()
		for _, b := range existing("window") {
			names, vals := entries(field(b.clear, "windows"))
			for i, n := range names {
				cur.Set(n, vals[i])
			}
		}
		// A hold from an earlier limit error, kept past its agents.
		hold, held, err := l.heldUntil(ctx, account, now)
		if err != nil {
			return nil, err
		}
		if _, ok := cur.Get("*"); held && !ok {
			cur.Set("*", jsjson.NewObject("pct", nil, "resets_at", hold.ResetsAt/1000, "after", hold.Since, "source", hold.Source))
		}
		next := jsjson.NewObject()
		confirmed, unconfirmed := false, false
		for _, name := range cur.Keys() {
			w, _ := cur.Get(name)
			switch {
			case l.windowCleared(name, w, m, now):
				confirmed = true
			case l.timedOut(w, now):
				unconfirmed = true
			default:
				next.Set(name, w)
			}
		}
		if unpaid {
			for _, name := range freshFull {
				w, _ := own.get(name)
				c, _ := cur.Get(name)
				// { ...cur[name], pct, resets_at, after, hold }
				o := jsjson.NewObject()
				if co, ok := c.(*jsjson.Object); ok {
					o = copyObject(co)
				}
				o.Set("pct", w.pct)
				o.Set("resets_at", *w.resets)
				if field(c, "after") == nil {
					o.Set("after", isoMs(w.at))
				} else {
					o.Set("after", field(c, "after"))
				}
				o = l.withHold(ctx, o, c, account, name, now)
				next.Set(name, o)
			}
		}
		if t.Signal != nil && t.Signal.Class == "limit" {
			// The exhausted windows; with none, the fresh window that resets soonest, as the deadline; with no reset time
			// known, '*'.
			named := freshFull
			if len(named) == 0 {
				if s, ok := soonest(); ok {
					named = []string{s}
				} else {
					named = []string{"*"}
				}
			}
			for _, name := range named {
				w, known := own.get(name)
				var resets jsjson.Value
				var pct jsjson.Value
				if known && name != "*" {
					pct = w.pct
					if w.resets != nil {
						resets = *w.resets
					}
				}
				if name == "*" {
					// No window reading: the reset time the message names, else the default hold. TS does this only for a
					// limit with a message; here a messageless one (Claude's) holds too.
					message := ""
					if t.Signal.Message != nil {
						message = *t.Signal.Message
					}
					at, ok := parseResetTime(message, now)
					if !ok {
						at = now + float64(defaultHold.Milliseconds())
						t.Signal.Source += "; no reset time in the message, held 30 minutes"
					}
					resets = at / 1000
					if err := l.db.HoldAccount(ctx, account, db.AccountHold{ResetsAt: at, Source: t.Signal.Source, Since: isoMs(now)}); err != nil {
						return nil, err
					}
				}
				c, _ := cur.Get(name)
				o := jsjson.NewObject("pct", pct, "resets_at", resets, "after", isoMs(now), "source", t.Signal.Source)
				next.Set(name, l.withHold(ctx, o, c, account, name, now))
			}
		}
		if _, star := next.Get("*"); confirmed && held && !star {
			if err := l.db.DropHold(ctx, account); err != nil {
				return nil, err
			}
		}
		u := unconfirmed && !confirmed
		why := "a fresh reading"
		switch {
		case t.Signal != nil && t.Signal.Class == "limit":
			why = "a limit error, " + t.Signal.Source
		case u:
			why = resetPassed
		}
		s := step{kind: "window", why: why, unconfirmed: u}
		if next.Len() > 0 {
			s.want = &want{reason: windowReason(next), clear: jsjson.NewObject("windows", next)}
		}
		steps = append(steps, s)
	}

	// paid-forbidden
	{
		var cur *parsedBlocker
		if e := existing("paid-forbidden"); len(e) > 0 {
			cur = &e[0]
		}
		confirmed := cur != nil && l.paidCleared(cur.clear, m, now)
		_, waits := entries(field(cur.clearOrNil(), "windows"))
		unconfirmed := cur != nil && !confirmed && len(waits) > 0
		for _, w := range waits {
			unconfirmed = unconfirmed && l.timedOut(w, now)
		}
		var wnt *want
		if cur != nil && !confirmed && !unconfirmed {
			wnt = &want{reason: cur.Reason, clear: cur.clear}
		}
		if unpaid && t.Paid != nil && wnt == nil {
			// It clears when the exhausted windows reset; with none exhausted, the next to reset. With no window that has
			// a reset time, nothing here could clear it, so it isn't set.
			names := freshFull
			if len(names) == 0 {
				if s, ok := soonest(); ok {
					names = []string{s}
				}
			}
			if len(names) > 0 {
				windows := jsjson.NewObject()
				var parts []string
				for _, n := range names {
					w, _ := own.get(n)
					windows.Set(n, jsjson.NewObject("pct", w.pct, "resets_at", *w.resets, "after", isoMs(now)))
					parts = append(parts, n+" resets "+utcSec(*w.resets))
				}
				wnt = &want{reason: "paid spend on a paid: false account: " + t.Paid.Source + "; clears when " + strings.Join(parts, "; "),
					clear: jsjson.NewObject("windows", windows, "after", isoMs(now))}
			}
		}
		why := "the window reset"
		switch {
		case t.Paid != nil:
			why = t.Paid.Source
		case unconfirmed:
			why = resetPassed
		}
		steps = append(steps, step{kind: "paid-forbidden", want: wnt, why: why, unconfirmed: unconfirmed})
	}

	// credits-out: set only by a Claude credits error, which the account's probe clears (see above); one already recorded
	// is kept until a fresh balance clears it, or on Claude the probe.
	{
		low := 0.01
		if acct.LowCreditsUSD != nil {
			low = *acct.LowCreditsUSD
		}
		probed := acct.Harness == "claude"
		var wnt *want
		if t.Signal != nil && t.Signal.Class == "credits" && probed {
			wnt = &want{reason: "a credits error, " + t.Signal.Source + "; Claude reports no balance, so stam probes the account (1, 2, 4, 8, 16 minutes, then every 16) and clears this when one succeeds",
				clear: jsjson.NewObject("after", isoMs(now))}
		} else if e := existing("credits-out"); len(e) > 0 && !l.creditsCleared(acct, e[0].clear, m, low, now) {
			wnt = &want{reason: e[0].Reason, clear: e[0].clear}
		}
		why := "a fresh balance of at least $" + jsjson.Number(low)
		if t.Signal != nil {
			why = t.Signal.Source
		}
		steps = append(steps, step{kind: "credits-out", want: wnt, why: why, probed: probed})
	}
	return steps, nil
}

// clearOrNil is the blocker's parsed clear condition, nil for no blocker.
func (b *parsedBlocker) clearOrNil() jsjson.Value {
	if b == nil {
		return nil
	}
	return b.clear
}

// withHold sets o's hold as `hold: cur?.hold ?? flapHold(...)` does: the wait's own hold, else a flap hold when the
// window cleared within flapWindow, else none.
func (l *Lifecycle) withHold(ctx context.Context, o *jsjson.Object, cur jsjson.Value, account, name string, now float64) *jsjson.Object {
	if h := field(cur, "hold"); h != nil {
		o.Set("hold", h)
		return o
	}
	if at, ok, err := l.db.WindowClearAt(ctx, account, name); err == nil && ok && now-at < float64(flapWindow.Milliseconds()) {
		o.Set("hold", now+float64(flapWindow.Milliseconds()))
		return o
	}
	// `hold: undefined`, which JSON.stringify drops.
	return without(o, "hold")
}

// heldUntil is src/rules.ts heldUntil: the account's hold, deleted once its time and the margin passed.
func (l *Lifecycle) heldUntil(ctx context.Context, account string, now float64) (db.AccountHold, bool, error) {
	h, ok, err := l.db.HoldOf(ctx, account)
	if err != nil || !ok {
		return h, false, err
	}
	if now >= h.ResetsAt+l.margin() {
		return h, false, l.db.DropHold(ctx, account)
	}
	return h, true, nil
}

// windowCleared is src/rules.ts windowCleared: a fresh reading taken after the wait was set reads below 100%, and its
// hold, if any, has passed. A reading at 100% never clears it; '*' needs every window clear.
func (l *Lifecycle) windowCleared(name string, w jsjson.Value, r reading, now float64) bool {
	if numOr(field(w, "hold"), 0) > now {
		return false
	}
	after := dateParse(field(w, "after"))
	ok := func(x win) bool { return fresh(x.at, now) && x.at > after && x.pct < 100 }
	if name == "*" {
		names := r.windows.names()
		for _, n := range names {
			if x, _ := r.windows.get(n); !ok(x) {
				return false
			}
		}
		return len(names) > 0
	}
	x, found := r.windows.get(name)
	return found && ok(x)
}

// paidCleared is src/rules.ts paidCleared: every listed window reset, confirmed by a fresh reading taken after its
// reset (or, with no reset, one that reads below 100%).
func (l *Lifecycle) paidCleared(clear jsjson.Value, r reading, now float64) bool {
	after := dateParse(field(clear, "after"))
	names, waits := entries(field(clear, "windows"))
	if len(names) == 0 {
		all := r.windows.names()
		for _, n := range all {
			x, _ := r.windows.get(n)
			if !(fresh(x.at, now) && x.at > after && !full(x, now)) {
				return false
			}
		}
		return len(all) > 0
	}
	for i, n := range names {
		x, found := r.windows.get(n)
		if !found || !fresh(x.at, now) || x.at <= after {
			return false
		}
		if resets := field(waits[i], "resets_at"); resets != nil {
			if !(x.at >= jsjson.ToNumber(resets)*1000 && !full(x, now)) {
				return false
			}
		} else if full(x, now) {
			return false
		}
	}
	return true
}

// creditsCleared is src/rules.ts creditsCleared: a fresh reading taken after it was set shows a balance of at least
// low, or for Codex, no spend control and a window with headroom.
func (l *Lifecycle) creditsCleared(acct config.CostAccount, clear jsjson.Value, r reading, low, now float64) bool {
	after := dateParse(field(clear, "after"))
	if r.balance != nil && fresh(r.balance.at, now) && r.balance.at > after && r.balance.usd >= low {
		return true
	}
	if acct.Harness != "codex" {
		return false
	}
	if r.spend != nil && fresh(r.spend.at, now) && r.spend.at > after && r.spend.reached {
		return false
	}
	seen := 0
	for _, n := range r.windows.names() {
		x, _ := r.windows.get(n)
		if !fresh(x.at, now) || !(x.at > after) {
			continue
		}
		seen++
		if full(x, now) {
			return false
		}
	}
	return seen > 0
}

// windowReason is src/rules.ts windowReason: the waits in localeCompare order of their names.
func windowReason(waits *jsjson.Object) string {
	names := waits.Keys()
	sort.SliceStable(names, func(i, j int) bool { return localeCompare(names[i], names[j]) < 0 })
	parts := make([]string, len(names))
	for i, name := range names {
		w, _ := waits.Get(name)
		by := ""
		if src := field(w, "source"); jsjson.Truthy(src) {
			by = "limit error (" + jsjson.ToString(src) + "): "
		}
		if name == "*" {
			parts[i] = by + "no window named; waits for a fresh reading with every window below 100%"
			continue
		}
		pct := "?"
		if p := field(w, "pct"); p != nil {
			pct = jsjson.ToString(p)
		}
		resets := "at an unknown time"
		if r := field(w, "resets_at"); jsjson.Truthy(r) {
			resets = utcSec(jsjson.ToNumber(r))
		}
		parts[i] = by + name + " at " + pct + "%, resets " + resets
	}
	return strings.Join(parts, "; ")
}

// evaluate is src/rules.ts evaluate: the plan, its timer, then each step applied.
func (l *Lifecycle) evaluate(ctx context.Context, account string, t *Trigger, now float64) error {
	steps, err := l.plan(ctx, account, t, now)
	if err != nil {
		return err
	}
	// The timer goes in before any pause is delivered, which can take a while.
	l.scheduleRules(account, steps, now)
	for _, s := range steps {
		if err := l.applyRule(ctx, account, s, now); err != nil {
			return err
		}
	}
	return nil
}

// clearable is whether the Go daemon can lift what a wanted blocker waits for: every window wait has a reset time (the
// timer clears it), and a paid-forbidden lists windows that all do. A credits-out is clearable only on a Claude account,
// whose probe clears it (step.probed); elsewhere only a balance from an adapter the Go daemon doesn't run would.
func clearable(kind string, clear jsjson.Value) bool {
	_, waits := entries(field(clear, "windows"))
	switch kind {
	case "window", "paid-forbidden":
		for _, w := range waits {
			if _, ok := field(w, "resets_at").(float64); !ok {
				return false
			}
		}
		return len(waits) > 0
	}
	return false
}

// wantFor is what the step wants on one agent, given the blocker of its kind the agent has (nil for none). A window
// wait the Go daemon can't clear (no reset time, as the TS daemon recorded some) stays on an agent that already waits
// for that window and goes to no other: the others get the clearable waits alone, or nothing when none is left. Any
// other kind is all or nothing: an agent without it gets it only when it is clearable.
func (s step) wantFor(have *parsedBlocker) *want {
	if s.want == nil {
		return nil
	}
	if s.kind != "window" {
		if have == nil && !s.probed && !clearable(s.kind, s.want.clear) {
			return nil
		}
		return s.want
	}
	windows, _ := field(s.want.clear, "windows").(*jsjson.Object)
	var had []string
	if have != nil {
		had = windowNames(have.clear)
	}
	sub, all := jsjson.NewObject(), true
	for _, n := range windows.Keys() {
		w, _ := windows.Get(n)
		if _, ok := field(w, "resets_at").(float64); ok || contains(had, n) {
			sub.Set(n, w)
		} else {
			all = false
		}
	}
	if all {
		return s.want
	}
	if sub.Len() == 0 {
		return nil
	}
	return &want{reason: windowReason(sub), clear: jsjson.NewObject("windows", sub)}
}

// windowNames is src/rules.ts windowNames: the window names a window blocker's clear condition waits for.
func windowNames(clear jsjson.Value) []string {
	names, _ := entries(field(clear, "windows"))
	return names
}

type ruleEvent struct {
	Rule        string `json:"rule"`
	Account     string `json:"account"`
	Action      string `json:"action"`
	Reason      string `json:"reason"`
	Cleared     string `json:"cleared,omitempty"`
	Unconfirmed bool   `json:"unconfirmed,omitempty"`
}

// clearText is JSON.stringify(clear) as the blockers table stores it, nil for null.
func clearText(clear jsjson.Value) *string {
	if clear == nil {
		return nil
	}
	s := jsjson.Stringify(clear, "")
	return &s
}

// applyRule is src/rules.ts apply: every agent on the account brought to the wanted state, the blocker with this
// reason and clear condition, or none. Writes and events happen only on a change. A wait the Go daemon couldn't clear
// is kept where it is and added to no other agent, which gets the rest (wantFor).
func (l *Lifecycle) applyRule(ctx context.Context, account string, s step, now float64) error {
	if s.want == nil {
		rows, err := l.db.BlockersFor(ctx, account)
		if err != nil {
			return err
		}
		blocks, err := parseBlockers(rows)
		if err != nil {
			return err
		}
		for _, b := range blocks {
			if b.Kind != s.kind {
				continue
			}
			if err := l.clearRule(ctx, account, s, b, now); err != nil {
				return err
			}
		}
		return nil
	}
	agents, err := l.agentsOn(ctx, account)
	if err != nil {
		return err
	}
	for _, a := range agents {
		rows, err := l.db.BlockerRows(ctx, a.ID)
		if err != nil {
			return err
		}
		blocks, err := parseBlockers(rows)
		if err != nil {
			return err
		}
		var have *parsedBlocker
		for i := range blocks {
			if blocks[i].Kind == s.kind && blocks[i].Account == account {
				have = &blocks[i]
				break
			}
		}
		w := s.wantFor(have)
		if w == nil {
			if have != nil {
				// What it waited for cleared, and only waits it never had are left.
				if err := l.clearRule(ctx, account, s, *have, now); err != nil {
					return err
				}
			}
			continue
		}
		wantText := clearText(w.clear)
		if have != nil && have.Reason == w.reason && sameText(clearText(have.clear), wantText) {
			continue
		}
		if have == nil || have.Reason != w.reason {
			l.event(ctx, a.ID, "cost:rule", ruleEvent{Rule: s.kind, Account: account, Action: "set", Reason: w.reason})
		}
		// A window the new wait drops was cleared while the others stay blocked: its history goes in with the change.
		var clears *db.WindowClears
		if s.kind == "window" && have != nil {
			kept := windowNames(w.clear)
			var dropped []string
			for _, n := range windowNames(have.clear) {
				if !contains(kept, n) {
					dropped = append(dropped, n)
				}
			}
			if len(dropped) > 0 {
				clears = &db.WindowClears{Names: dropped, At: int64(now)}
			}
		}
		if _, err := l.AddBlocker(ctx, a.ID, NewBlocker{Kind: s.kind, Account: account, Reason: w.reason, Clear: wantText, Clears: clears}); err != nil {
			return err
		}
	}
	return nil
}

// clearRule clears one agent's blocker of the step's kind, with the windows it waited for as cleared.
func (l *Lifecycle) clearRule(ctx context.Context, account string, s step, b parsedBlocker, now float64) error {
	l.event(ctx, b.AgentID, "cost:rule", ruleEvent{Rule: s.kind, Account: account, Action: "clear", Reason: b.Reason, Cleared: s.why, Unconfirmed: s.unconfirmed})
	var clears *db.WindowClears
	if s.kind == "window" {
		clears = &db.WindowClears{Names: windowNames(b.clear), At: int64(now)}
	}
	_, err := l.ClearBlocker(ctx, b.AgentID, s.kind, account, s.why, clears)
	return err
}

func sameText(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// spawnBlockers is src/rules.ts spawnBlockers: the rule blockers a new agent on the account would carry now, those the
// Go daemon can clear.
func (l *Lifecycle) spawnBlockers(ctx context.Context, account string, now float64) ([]step, error) {
	steps, err := l.plan(ctx, account, &Trigger{}, now)
	if err != nil {
		return nil, err
	}
	var out []step
	for _, s := range steps {
		if w := s.wantFor(nil); w != nil {
			s.want = w
			out = append(out, s)
		}
	}
	return out, nil
}

// AttachSpawn is src/rules.ts attachSpawn: a new agent gets, before its launch, the rule blockers its account carries,
// and its error blocker (attachError), so it starts held as every other agent on it is. It runs on the account's rules
// chain, so an evaluation or a probe success that clears the account can't run between its plan and its write and leave
// the new agent held with no wake or probe. The attach runs under the daemon's context, not the request's: a caller
// that gives up mid-way can't leave the new agent with half its blockers.
func (l *Lifecycle) AttachSpawn(ctx context.Context, a db.Agent) error {
	account := l.settings.Get().AccountFor(a.Harness, a.Model)
	if account == "" {
		return nil
	}
	var err error
	ran := false
	<-l.onChain(account, func(ctx context.Context) error {
		ran, err = true, l.attachSpawn(ctx, a.ID, account)
		return nil
	})
	if !ran {
		// The daemon is stopping: the agent can't be checked against its account's blockers, so it must not launch.
		return errStopping
	}
	return err
}

// errStopping is AttachSpawn's answer once the daemon stopped and the rules chain runs nothing more.
var errStopping = errors.New("the daemon is stopping: the account's cost blockers can't be attached")

func (l *Lifecycle) attachSpawn(ctx context.Context, id, account string) error {
	now := ms(time.Now())
	steps, err := l.spawnBlockers(ctx, account, now)
	if err != nil {
		return err
	}
	if f := l.attaching; f != nil {
		f(account)
	}
	for _, s := range steps {
		l.event(ctx, id, "cost:rule", ruleEvent{Rule: s.kind, Account: account, Action: "set", Reason: s.want.reason})
		if _, err := l.AddBlocker(ctx, id, NewBlocker{Kind: s.kind, Account: account, Reason: s.want.reason, Clear: clearText(s.want.clear)}); err != nil {
			return err
		}
	}
	if len(steps) > 0 {
		l.scheduleRules(account, steps, now)
	}
	return l.attachError(ctx, id, account)
}

// attachError gives a new agent the account's error blocker, when a probed account has one, so it starts held with the
// rest; its probe's success clears it with theirs. TS refuses the spawn at its spawn gate instead, which isn't ported.
func (l *Lifecycle) attachError(ctx context.Context, id, account string) error {
	if !l.probed(account) {
		return nil
	}
	rows, err := l.db.BlockersFor(ctx, account)
	if err != nil {
		return err
	}
	for _, b := range rows {
		if b.Kind != "error" || b.AgentID == id {
			continue
		}
		l.event(ctx, id, "cost:rule", ruleEvent{Rule: "error", Account: account, Action: "set", Reason: b.Reason})
		_, err := l.AddBlocker(ctx, id, NewBlocker{Kind: "error", Account: account, Reason: b.Reason, Clear: b.Clear})
		return err
	}
	return nil
}

// scheduleRules is src/rules.ts schedule: one timer per account, at the earliest time a planned wait times out (a
// window, or a paid-forbidden once all its windows have) or a window's flap hold ends. A time already passed gets one
// immediate evaluation.
func (l *Lifecycle) scheduleRules(account string, steps []step, now float64) {
	due := math.Inf(1)
	for _, s := range steps {
		if s.want == nil {
			continue
		}
		_, waits := entries(field(s.want.clear, "windows"))
		if s.kind == "window" {
			for _, w := range waits {
				if h := field(w, "hold"); h != nil && jsjson.ToNumber(h) > now {
					due = math.Min(due, jsjson.ToNumber(h))
				}
				if field(w, "resets_at") != nil {
					due = math.Min(due, l.deadline(w))
				}
			}
		}
		if s.kind == "paid-forbidden" && len(waits) > 0 {
			latest, all := math.Inf(-1), true
			for _, w := range waits {
				r := field(w, "resets_at")
				if r == nil {
					all = false
					break
				}
				latest = math.Max(latest, jsjson.ToNumber(r)*1000+l.margin())
			}
			if all {
				due = math.Min(due, latest)
			}
		}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if t := l.rules.timers[account]; t != nil {
		t.Stop()
	}
	delete(l.rules.timers, account)
	delete(l.rules.dues, account)
	if math.IsInf(due, 1) || l.waited {
		return
	}
	wall := ms(time.Now())
	// An overdue wake fires once. The mark is set when the timer fires, not here: a later evaluation may replace a timer
	// that never ran, and that wake must still happen.
	if fired, ok := l.rules.firedLate[account]; due <= wall && ok && fired == due {
		return
	}
	if l.rules.timers == nil {
		l.rules.timers, l.rules.dues, l.rules.firedLate = map[string]*time.Timer{}, map[string]float64{}, map[string]float64{}
	}
	var timer *time.Timer
	timer = time.AfterFunc(time.Duration(math.Max(0, due-wall))*time.Millisecond, func() {
		l.mu.Lock()
		if l.rules.timers[account] != timer {
			l.mu.Unlock()
			return
		}
		delete(l.rules.timers, account)
		delete(l.rules.dues, account)
		l.rules.firedLate[account] = due
		l.mu.Unlock()
		l.EvaluateRules(account, Trigger{}, time.Now())
	})
	l.rules.timers[account] = timer
	l.rules.dues[account] = due
}

// pendingWake is src/rules.ts pendingWake: when the account's timer next evaluates (ms); ok is false for none.
func (l *Lifecycle) pendingWake(account string) (float64, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	due, ok := l.rules.dues[account]
	return due, ok
}

// reSpace is JavaScript's \s, which RE2's misses beyond ASCII.
const reSpace = `[\t\n\x{000b}\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var (
	resetClock = regexp.MustCompile(`(?i)\b(\d{1,2}):(\d{2})(?::\d{2})?` + reSpace + `*([ap]\.?m\.?)?`)
	resetZone  = regexp.MustCompile(`(?i)^` + reSpace + `*(?:UTC|GMT|Z\b|[+-]\d{2}:?\d{2})`)
	resetDated = regexp.MustCompile(`(?i)\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?` + reSpace + `+(\d{1,2})(?:st|nd|rd|th)?,?` + reSpace + `+(\d{4})\b`)
	resetMonth = regexp.MustCompile(`(?i)\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?` + reSpace + `+\d`)
	months     = []string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}
)

// parseResetTime is src/rules.ts parseResetTime: the reset time a limit message names, in ms: "try again at 3:25 PM"
// or "15:25" (the next such time of day, in the daemon's timezone), or a dated one, "Try again at Oct 17th, 2026 9:05
// AM". ok is false when it names no time, a date it can't read, or a zone (only local time is understood). A time up to
// an hour past means now.
func parseResetTime(message string, now float64) (float64, bool) {
	t := resetClock.FindStringSubmatchIndex(message)
	if t == nil {
		return 0, false
	}
	if resetZone.MatchString(message[t[1]:]) {
		return 0, false
	}
	h, _ := strconv.Atoi(message[t[2]:t[3]])
	mins, _ := strconv.Atoi(message[t[4]:t[5]])
	ap := ""
	if t[6] >= 0 {
		ap = strings.ToLower(message[t[6] : t[6]+1])
	}
	if mins > 59 || (ap != "" && (h < 1 || h > 12)) || (ap == "" && h > 23) {
		return 0, false
	}
	if ap == "p" && h < 12 {
		h += 12
	}
	if ap == "a" && h == 12 {
		h = 0
	}
	base := time.UnixMilli(int64(now)).In(time.Local)
	y, mo, d := base.Date()
	dated := resetDated.FindStringSubmatch(message)
	if dated != nil {
		for i, m := range months {
			if strings.EqualFold(dated[1], m) {
				mo = time.Month(i + 1)
			}
		}
		d, _ = strconv.Atoi(dated[2])
		y, _ = strconv.Atoi(dated[3])
	} else if resetMonth.MatchString(message) {
		return 0, false
	}
	at := ms(time.Date(y, mo, d, h, mins, 0, 0, time.Local))
	if dated == nil && at <= now {
		if now-at <= float64(time.Hour.Milliseconds()) {
			return now, true
		}
		at = ms(time.Date(y, mo, d+1, h, mins, 0, 0, time.Local))
	}
	return at, true
}

// icuRank is ICU's root collation order of the ASCII punctuation and symbols, which all sort before digits and
// letters.
const icuRank = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"

// collateKey is a character's primary weight in ICU's root order: punctuation and symbols in icuRank's order, then
// digits, then letters (case aside); other characters after, by code point.
func collateKey(r rune) int {
	if i := strings.IndexRune(icuRank, r); i >= 0 {
		return i
	}
	switch {
	case r >= '0' && r <= '9':
		return 100 + int(r-'0')
	case r >= 'a' && r <= 'z':
		return 200 + int(r-'a')
	case r >= 'A' && r <= 'Z':
		return 200 + int(r-'A')
	}
	return 1000 + int(r)
}

// localeCompare is String#localeCompare in Node's default (ICU root) collation, for the ASCII window names: primary
// weights first, then lowercase before uppercase.
func localeCompare(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	for i := 0; i < len(ra) && i < len(rb); i++ {
		if ka, kb := collateKey(ra[i]), collateKey(rb[i]); ka != kb {
			if ka < kb {
				return -1
			}
			return 1
		}
	}
	if len(ra) != len(rb) {
		if len(ra) < len(rb) {
			return -1
		}
		return 1
	}
	for i := range ra {
		la, lb := ra[i] >= 'a' && ra[i] <= 'z', rb[i] >= 'a' && rb[i] <= 'z'
		if la != lb {
			if la {
				return -1
			}
			return 1
		}
	}
	return 0
}

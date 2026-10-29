package lifecycle

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// Budget blockers (src/budgets.ts, docs/cost-policy.md Rule enforcement `budget:SCOPE`, S-2848 B5a). SCOPE is an account
// name, or global for all paid spend. When a scope's paid spend in the budget's period, on every machine, reaches the
// budget, every managed agent in scope gets a budget blocker; it clears when spend falls below the budget again: the
// period rolls over, the human raises or removes the budget (a settings change), or the ledger is corrected. Only the
// human raises a budget; no agent tool does.
//
// An evaluation is idempotent, as the rules' are: an unchanged blocker writes nothing, and a refreshed one keeps its
// since. It runs when paid spend is recorded (a usage report, a decision model call), at daemon start, when the peers'
// totals move, at a stopped scope's period rollover, for a new agent's account at its spawn, and when the budgets,
// accounts, providers, settings home or human mail in settings.json change (budgetsMoved, on the peer-spend tick:
// src/daemon.ts evaluates every budget on a settings change, and the Go daemon reads the file only when asked). Spend
// is read from the ledger, so a restart loses nothing. Unmanaged agents are never blocked.
//
// Notices: at 90% the managers of the trees in scope hear once per scope, period and budget (the chief of staff for the
// system account, which has no agents); a blocker set or cleared goes to each agent's manager (blockers.go). When the
// budget is reached, the human gets one mail from system:budgets per scope, period and budget amount, with a Decision to
// raise it or keep stopped; a mail that couldn't be sent is retried after 1, 2, 4, 8 and 16 minutes, then on the next
// evaluation.
// Only the settings home warns and mails; every machine blocks its own agents.
//
// The Go daemon has no spawn refusal (src/admission.ts admitSpawn, S-3545): a spawn onto a spent scope starts held by
// its budget blocker, as a forced spawn does in TS. SpawnHeld gives the refusal's reason.
//
// The agents' OpenRouter account is also held while the shared credit (credits.go's last reading) is down to the reserve
// kept for stam's own calls: the unspent part of openrouter-system's budget, or cost.openrouterSystemReserveUsd. A stale
// reading holds nothing and asks for a fresh one; a hold stays until a fresh reading clears it. Near the reserve, the
// managers and the chief of staff hear once per top-up (reserveNear).
//
// A raise or removal lifts its blocker within peerSpendEvery, not at once as TS's settings watcher does.

const (
	globalScope = "global"
	// budgetWarnAt is src/budgets.ts WARN_AT.
	budgetWarnAt = 0.9
	// budgetChain prefixes a scope's key on the rules chains, which are keyed by account.
	budgetChain = "\x00budget:"
	// budgetsReconciled is src/budgets.ts Cause 'reconciled': the ledger was corrected to the billed amount.
	budgetsReconciled = "reconciled"
	// agentPool is src/budgets.ts AGENT_POOL: the OpenRouter agents' account, which shares one credit with stam's own
	// calls (openrouter-system).
	agentPool = "openrouter"
	// nearReserve is src/budgets.ts NEAR_RESERVE: the reserve notice fires when the credit is within this multiple of
	// the reserve.
	nearReserve = 2
	// reserveBlock is src/budgets.ts RESERVE_BLOCK. It carries no amount, so a moving reserve doesn't rewrite the hold
	// on every poll.
	reserveBlock = "The OpenRouter credit is down to the reserve kept for stam's own model calls; it clears on a top-up"
)

// budgetState is the budgets' rollover timers, the human's mail tries, the settings last evaluated (budgetPrint), and
// the mail sender and retry delays tests replace; under the Lifecycle's mu. rolled, nil outside tests, runs in place of a rollover timer's evaluation, so a test
// whose clock is in the past keeps its stop.
type budgetState struct {
	timers map[string]*time.Timer
	tries  map[string]int
	seen   string
	primed bool
	send   func(ctx context.Context, to []string, subject, body string) bool
	delays []time.Duration
	rolled func(scope string)
}

// budgetPrint is what of the settings a budget's evaluation reads: the global budget, each account's match, provider and
// budget in name order, the providers' names (with an account's provider, they make its spend priced, basisOf), and the
// settings home and whether the human may be mailed (which decide whether this machine warns and mails). A raise, a
// removal, a new budget, an account's new match, a new provider, a moved home or human mail turned on changes it.
func budgetPrint(set config.Settings) string {
	var b strings.Builder
	add := func(name string, x *config.CostBudget) {
		if x != nil {
			fmt.Fprintf(&b, "%q budget %v %q %v\n", name, x.USD, x.Per, x.RaiseSteps)
		}
	}
	add(globalScope, set.GlobalBudget)
	for _, name := range sortedAccounts(set) {
		a := set.CostAccounts[name]
		model := "-"
		if a.Model != nil {
			model = strconv.Quote(*a.Model)
		}
		fmt.Fprintf(&b, "%q match %q %s provider %q\n", name, a.Harness, model, deref(a.Provider))
		add(name, a.Budget)
	}
	fmt.Fprintf(&b, "providers %q\n", set.ProviderNames)
	fmt.Fprintf(&b, "home %q mail %t\n", set.Home, set.HumanMail.Allows("necessary"))
	return b.String()
}

// budgetsMoved is whether the budgets' settings changed since it was last asked; the first call only records them.
func (l *Lifecycle) budgetsMoved() bool {
	now := budgetPrint(l.settings.Get())
	l.mu.Lock()
	defer l.mu.Unlock()
	was, primed := l.budgets.seen, l.budgets.primed
	l.budgets.seen, l.budgets.primed = now, true
	return primed && was != now
}

// budgetDelays is src/budgets.ts delays: the waits before the human's mail is tried again.
var budgetDelays = []time.Duration{time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 16 * time.Minute}

func (l *Lifecycle) budgetOf(set config.Settings, scope string) *config.CostBudget {
	if scope == globalScope {
		return set.GlobalBudget
	}
	return set.CostAccounts[scope].Budget
}

// budgetScopes is src/budgets.ts scopes: every scope with a budget, and every scope still carrying a budget blocker
// (its budget may have been removed).
func (l *Lifecycle) budgetScopes(ctx context.Context) ([]string, error) {
	set := l.settings.Get()
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	if set.GlobalBudget != nil {
		add(globalScope)
	}
	add(agentPool) // its reserve rule needs no budget
	for _, name := range sortedAccounts(set) {
		if set.CostAccounts[name].Budget != nil {
			add(name)
		}
	}
	held, err := l.db.BlockerAccounts(ctx, "budget")
	for _, s := range held {
		add(s)
	}
	return out, err
}

// agentsInScope is src/budgets.ts agentsIn: the live agents on the account, or every managed one for global; archived
// and unmanaged agents are left alone.
func (l *Lifecycle) agentsInScope(ctx context.Context, set config.Settings, scope string) ([]db.Agent, error) {
	all, err := l.db.ListAgents(ctx)
	var out []db.Agent
	for _, a := range all {
		account := set.AccountFor(a.Harness, a.Model)
		if isLive(a) && ((scope == globalScope && account != "") || (scope != globalScope && account == scope)) {
			out = append(out, a)
		}
	}
	return out, err
}

// spentIn is src/budgets.ts spentIn: the paid dollars spent against the budget in its own period on every machine (the
// peers' last known totals join this machine's); ok is false when the scope has no paid ledger.
func (l *Lifecycle) spentIn(ctx context.Context, scope string, b *config.CostBudget, now time.Time) (float64, bool, error) {
	var here float64
	var ok bool
	var err error
	if scope == globalScope {
		here, err = l.paidSpentAll(ctx, b.Per, now)
		ok = err == nil
	} else {
		here, ok, err = l.paidSpentIn(ctx, scope, b.Per, now)
	}
	if err != nil || !ok {
		return 0, false, err
	}
	return here + l.peersSpent(scope, b.Per, ms(now)), true, nil
}

// budgetWhat is src/budgets.ts what: "cap", or "PER budget".
func budgetWhat(b *config.CostBudget) string {
	if b.Per == "cap" {
		return "cap"
	}
	return b.Per + " budget"
}

// budgetPeriod is src/budgets.ts period: the period's first day, or cap.
func budgetPeriod(b *config.CostBudget, now time.Time) string {
	if s, ok := periodStart(b.Per, now); ok {
		return s
	}
	return "cap"
}

// roundCents is src/budgets.ts round: Math.round(n * 100) / 100.
func roundCents(n float64) float64 { return round(n*100) / 100 }

// spent is whether a spend reaches the budget (`spent >= b.usd`; NaN never does).
func spent(b *config.CostBudget, usd float64, ok bool) bool { return b != nil && ok && usd >= b.USD }

// SpawnHeld is src/budgets.ts spawnHeld: why a new agent on the account may not start, the OpenRouter credit down to
// the system reserve (for the agents' OpenRouter account), or its account's budget or the global one spent, read from
// the ledger so it holds with no agent on the scope yet; "" when none is.
func (l *Lifecycle) SpawnHeld(ctx context.Context, account string, now time.Time) string {
	set := l.settings.Get()
	if account == agentPool {
		r := l.reserveState(ctx, now)
		// A balance that may have moved (held, near the reserve, or too old to read) is refreshed, so a top-up with no
		// OpenRouter agent running still lifts the hold.
		if r.held || r.stale || (r.remaining != nil && *r.remaining <= r.reserve*nearReserve) {
			l.pollCreditsIfAny()
		}
		if r.held {
			return reserveReason(r.reserve)
		}
	}
	for _, scope := range []string{account, globalScope} {
		b := l.budgetOf(set, scope)
		if b == nil {
			continue
		}
		usd, ok, err := l.spentIn(ctx, scope, b, now)
		if err != nil {
			slog.Error("cost budget", "scope", scope, "err", err)
			continue
		}
		if spent(b, usd, ok) {
			who := "account " + account + "'s"
			if scope == globalScope {
				who = "the global"
			}
			return who + " " + budgetWhat(b) + " of $" + jsjson.Number(b.USD) + " is spent"
		}
	}
	return ""
}

// SystemHeld is src/budgets.ts systemHeld: why stam's own model calls may not run, the system account's budget spent;
// "" when it isn't or none is set. The agents' openrouter budget never holds them.
func (l *Lifecycle) SystemHeld(ctx context.Context, now time.Time) string {
	return l.accountHeld(ctx, systemAccount, now)
}

// ProviderHeld is src/budgets.ts providerHeld: the same for stam's own calls through another provider, its
// PROVIDER-system account; OpenRouter's is the system account itself.
func (l *Lifecycle) ProviderHeld(ctx context.Context, provider string, now time.Time) string {
	if provider == "openrouter" {
		return l.accountHeld(ctx, systemAccount, now)
	}
	return l.accountHeld(ctx, provider+"-system", now)
}

func (l *Lifecycle) accountHeld(ctx context.Context, account string, now time.Time) string {
	b := l.budgetOf(l.settings.Get(), account)
	if b == nil {
		return ""
	}
	usd, ok, err := l.spentIn(ctx, account, b, now)
	if err != nil {
		slog.Error("cost budget", "scope", account, "err", err)
		return ""
	}
	if !spent(b, usd, ok) {
		return ""
	}
	name := account
	if account == systemAccount {
		name = "system"
	}
	return "the " + name + " " + budgetWhat(b) + " of $" + jsjson.Number(b.USD) + " is spent"
}

// AttachBudget is src/budgets.ts attachSpawn: a new agent on a spent scope carries the budget blocker from the start.
// It waits for the evaluations.
func (l *Lifecycle) AttachBudget(ctx context.Context, a db.Agent) {
	if account := l.settings.Get().AccountFor(a.Harness, a.Model); account != "" {
		<-l.OnSpend(account, time.Now())
	}
}

// nextPeriod is src/budgets.ts nextPeriod: the first instant of the next period; false for a cap. A per that is none of
// day and week moves by a month, as TS's else does.
func nextPeriod(per string, now time.Time) (time.Time, bool) {
	start, ok := periodStart(per, now)
	if !ok {
		return time.Time{}, false
	}
	d, _ := time.Parse("2006-01-02", start)
	switch per {
	case "day":
		return d.AddDate(0, 0, 1), true
	case "week":
		return d.AddDate(0, 0, 7), true
	}
	return d.AddDate(0, 1, 0), true
}

// EvaluateBudgets is src/budgets.ts evaluateBudgets: one evaluation per scope at a time, in arrival order. cause is ""
// or budgetsReconciled. The channel closes when it has run.
func (l *Lifecycle) EvaluateBudgets(scope string, now time.Time, cause string) <-chan struct{} {
	return l.chain(budgetChain+scope, "cost budget", func(ctx context.Context) error { return l.evaluateBudget(ctx, scope, now, cause) })
}

// EvaluateAllBudgets is src/budgets.ts evaluateAll: every scope, as at daemon start. The channel closes when all have run.
func (l *Lifecycle) EvaluateAllBudgets(now time.Time, cause string) <-chan struct{} {
	scopes, err := l.budgetScopes(l.ctx)
	if err != nil {
		slog.Error("cost budget", "err", err)
	}
	waits := make([]<-chan struct{}, 0, len(scopes))
	for _, s := range scopes {
		waits = append(waits, l.EvaluateBudgets(s, now, cause))
	}
	return all(waits)
}

// all closes once every channel closed.
func all(waits []<-chan struct{}) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		for _, w := range waits {
			<-w
		}
		close(done)
	}()
	return done
}

// LedgerChanged is src/budgets.ts ledgerChanged: every writer of the paid ledger that isn't a usage report calls it
// after its write (the decision model's own spend; the OpenRouter reconciliation, ledgerrecon.go, with cause
// reconciled).
func (l *Lifecycle) LedgerChanged(cause string) { l.EvaluateAllBudgets(time.Now(), cause) }

// OnSpend is src/budgets.ts onSpend: the scopes a paid-spend report on the account can move, the account and global.
func (l *Lifecycle) OnSpend(account string, now time.Time) <-chan struct{} {
	return all([]<-chan struct{}{l.EvaluateBudgets(account, now, ""), l.EvaluateBudgets(globalScope, now, "")})
}

type budgetRuleEvent struct {
	Rule    string  `json:"rule"`
	Account string  `json:"account"`
	Action  string  `json:"action"`
	Reason  string  `json:"reason"`
	Cleared *string `json:"cleared,omitempty"`
}

// clearBudget drops one budget blocker, with its cost:rule event first, as TS does.
func (l *Lifecycle) clearBudget(ctx context.Context, x db.Blocker, scope, why string) error {
	l.event(ctx, x.AgentID, "cost:rule", budgetRuleEvent{Rule: "budget", Account: scope, Action: "clear", Reason: x.Reason, Cleared: &why})
	_, err := l.ClearBlocker(ctx, x.AgentID, "budget", scope, why, nil)
	return err
}

// sameJSON is JSON.stringify(parsed stored text) === JSON.stringify(clear).
func sameJSON(stored *string, text string) bool {
	if stored == nil {
		return false
	}
	v, err := jsjson.Parse([]byte(*stored))
	return err == nil && jsjson.Stringify(v, "") == text
}

// holdBudget is src/budgets.ts hold: every agent in the scope carries the budget blocker with this reason and clear.
func (l *Lifecycle) holdBudget(ctx context.Context, set config.Settings, scope, reason, clear string, existing []db.Blocker) error {
	in, err := l.agentsInScope(ctx, set, scope)
	if err != nil {
		return err
	}
	member := map[string]bool{}
	for _, a := range in {
		member[a.ID] = true
	}
	// An agent a settings change moved out of scope keeps nothing of this budget.
	for _, x := range existing {
		if !member[x.AgentID] {
			if err := l.clearBudget(ctx, x, scope, "the agent is no longer in this budget's scope"); err != nil {
				return err
			}
		}
	}
	for _, a := range in {
		rows, err := l.db.BlockerRows(ctx, a.ID)
		if err != nil {
			return err
		}
		var have *db.Blocker
		for i := range rows {
			if rows[i].Kind == "budget" && rows[i].Account == scope {
				have = &rows[i]
				break
			}
		}
		if have != nil && have.Reason == reason && sameJSON(have.Clear, clear) {
			continue
		}
		if have == nil || have.Reason != reason {
			l.event(ctx, a.ID, "cost:rule", budgetRuleEvent{Rule: "budget", Account: scope, Action: "set", Reason: reason})
		}
		if _, err := l.AddBlocker(ctx, a.ID, NewBlocker{Kind: "budget", Account: scope, Reason: reason, Clear: &clear}); err != nil {
			return err
		}
	}
	return nil
}

// budgetClear is a budget blocker's clear condition, in TS's key order.
type budgetClear struct {
	Per    string          `json:"per"`
	USD    json.RawMessage `json:"usd"`
	Period string          `json:"period"`
}

// evaluateBudget is src/budgets.ts evaluate.
func (l *Lifecycle) evaluateBudget(ctx context.Context, scope string, now time.Time, cause string) error {
	set := l.settings.Get()
	b := l.budgetOf(set, scope)
	var usd float64
	var ok bool
	if b != nil {
		var err error
		if usd, ok, err = l.spentIn(ctx, scope, b, now); err != nil {
			return err
		}
	}
	over := spent(b, usd, ok)
	var existing []db.Blocker
	rows, err := l.db.BlockersFor(ctx, scope)
	if err != nil {
		return err
	}
	for _, x := range rows {
		if x.Kind == "budget" {
			existing = append(existing, x)
		}
	}
	// The agents' OpenRouter scope is also held while the shared credit is down to the system's reserve.
	var credit *reserve
	if scope == agentPool && !over {
		r := l.reserveState(ctx, now)
		credit = &r
	}
	if credit != nil && credit.held {
		return l.holdBudget(ctx, set, scope, reserveBlock, `{"reserve":true}`, existing)
	}
	// A reading gone stale decides nothing: a standing hold stays until a fresh balance clears it.
	if credit != nil && credit.stale && anyReserve(existing) {
		l.pollCreditsIfAny()
		return nil
	}
	if credit != nil && credit.remaining != nil && l.isSettingsHome(set) && credit.reserve > 0 && *credit.remaining <= credit.reserve*nearReserve {
		l.reserveNear(ctx, *credit.remaining, credit.reserve, credit.basis, now)
	}
	if !over {
		why := "the period rolled over"
		switch {
		case len(existing) > 0 && allReserve(existing):
			why = "the OpenRouter credit was topped up above the system reserve"
		case b == nil:
			why = "the budget was removed"
		case raisedFrom(existing, b.USD):
			why = "the budget was raised to $" + jsjson.Number(b.USD)
		case cause == budgetsReconciled:
			why = "the ledger was corrected to the billed amount and the budget is no longer spent"
		}
		for _, x := range existing {
			if err := l.clearBudget(ctx, x, scope, why); err != nil {
				return err
			}
		}
		if b != nil && ok && usd >= b.USD*budgetWarnAt && l.isSettingsHome(set) {
			l.warnBudget(ctx, set, scope, b, usd, now)
		}
		return nil
	}
	who := "The " + scope
	if scope == globalScope {
		who = "The global"
	}
	reason := who + " " + budgetWhat(b) + " of $" + jsjson.Number(b.USD) + " is spent"
	text, err := json.Marshal(budgetClear{Per: b.Per, USD: json.RawMessage(jsjson.Number(b.USD)), Period: budgetPeriod(b, now)})
	if err != nil {
		return err
	}
	l.scheduleBudget(scope, b, now)
	if err := l.holdBudget(ctx, set, scope, reason, string(text), existing); err != nil {
		return err
	}
	if l.isSettingsHome(set) {
		l.mailBudget(ctx, set, scope, b, usd, now)
	}
	return nil
}

// reserve is src/budgets.ts reserveState's answer: the last OpenRouter credit reading against the reserve. remaining is
// nil when the reading is stale; basis names the credit capacity, which a top-up changes.
type reserve struct {
	remaining   *float64
	reserve     float64
	held, stale bool
	basis       string
}

// systemReserve is src/budgets.ts systemReserve: what stam keeps of the shared OpenRouter credit for its own calls, the
// unspent part of the system account's budget, or cost.openrouterSystemReserveUsd when that account has none.
func (l *Lifecycle) systemReserve(ctx context.Context, set config.Settings, now time.Time) float64 {
	if b := l.budgetOf(set, systemAccount); b != nil {
		usd, _, err := l.spentIn(ctx, systemAccount, b, now)
		if err != nil {
			slog.Error("cost budget", "scope", systemAccount, "err", err)
		}
		return math.Max(0, b.USD-usd)
	}
	return set.OpenRouterSystemReserveUSD
}

// reserveState is src/budgets.ts reserveState: the last credit reading (creditPoll keeps it in subscriptions) against
// the reserve. A reading the poll didn't fetch whole in the last staleReading is stale and never holds anything, as in
// the rules.
func (l *Lifecycle) reserveState(ctx context.Context, now time.Time) reserve {
	var c jsjson.Value
	if data, _, ok, err := l.db.Subscription(ctx, "openrouter"); err != nil {
		slog.Error("cost budget", "scope", agentPool, "err", err)
	} else if ok {
		if v, err := jsjson.Parse([]byte(data)); err == nil {
			c = field(v, "credits")
		}
	}
	r := reserve{reserve: l.systemReserve(ctx, l.settings.Get(), now)}
	seen := dateParse(field(c, "observed_at"))
	remaining, isNum := field(c, "remaining").(float64)
	fresh := isNum && !math.IsNaN(seen) && ms(now)-seen <= float64(staleReading.Milliseconds())
	if fresh {
		r.remaining = &remaining
	}
	r.held = r.remaining != nil && r.reserve > 0 && remaining <= r.reserve
	r.stale = !fresh
	r.basis = templateField(c, "total") + ":" + templateField(c, "key_limit")
	return r
}

// templateField is `${c?.[key]}` for a credits reading: undefined when missing, null, a number as JS prints it.
func templateField(c jsjson.Value, key string) string {
	o, _ := c.(*jsjson.Object)
	v, has := o.Get(key)
	switch x := v.(type) {
	case nil:
		if !has {
			return "undefined"
		}
		return "null"
	case string:
		return x
	case float64:
		return jsjson.Number(x)
	case bool:
		return strconv.FormatBool(x)
	}
	return jsjson.Stringify(v, "")
}

// CreditReserve is src/budgets.ts creditReserve: the system reserve and the credit left above it, nil when the last
// reading is stale (the Usage page's System card, GET /api/usage).
func (l *Lifecycle) CreditReserve(ctx context.Context, now time.Time) (float64, *float64) {
	r := l.reserveState(ctx, now)
	return r.reserve, r.remaining
}

// reserveReason is src/budgets.ts reserveReason, a refused spawn's reason.
func reserveReason(reserve float64) string {
	return "The OpenRouter credit is at the $" + jsjson.Number(roundCents(reserve)) + " kept for stam's own model calls; it clears on a top-up"
}

// isReserve is `x.clear?.reserve != null`.
func isReserve(x db.Blocker) bool {
	if x.Clear == nil {
		return false
	}
	v, err := jsjson.Parse([]byte(*x.Clear))
	if err != nil {
		return false
	}
	o, _ := v.(*jsjson.Object)
	r, has := o.Get("reserve")
	return has && r != nil
}

func anyReserve(xs []db.Blocker) bool {
	for _, x := range xs {
		if isReserve(x) {
			return true
		}
	}
	return false
}

func allReserve(xs []db.Blocker) bool {
	for _, x := range xs {
		if !isReserve(x) {
			return false
		}
	}
	return true
}

// raisedFrom is `existing.some((x) => x.clear?.usd !== b.usd)`.
func raisedFrom(existing []db.Blocker, usd float64) bool {
	for _, x := range existing {
		var v jsjson.Value
		if x.Clear != nil {
			v, _ = jsjson.Parse([]byte(*x.Clear))
		}
		if n, ok := field(v, "usd").(float64); !ok || n != usd {
			return true
		}
	}
	return false
}

// isSettingsHome is src/settings.ts isSettingsHome.
func (l *Lifecycle) isSettingsHome(set config.Settings) bool { return set.Home == l.machine }

// warnBudget is src/budgets.ts warn with src/cost-notices.ts budgetLow: the managers of the trees in scope (the chief of
// staff for the system account), once per scope, period and budget amount.
func (l *Lifecycle) warnBudget(ctx context.Context, set config.Settings, scope string, b *config.CostBudget, usd float64, now time.Time) {
	var managers []string
	if scope == systemAccount {
		if cos := l.chiefOfStaff(ctx); cos != "" {
			managers = []string{cos}
		}
	} else {
		in, err := l.agentsInScope(ctx, set, scope)
		if err != nil {
			slog.Error("cost budget", "scope", scope, "err", err)
			return
		}
		seen := map[string]bool{}
		for _, a := range in {
			if a.Lifecycle != "active" {
				continue
			}
			for _, m := range l.managerOf(ctx, a.ID) {
				if !seen[m] {
					seen[m] = true
					managers = append(managers, m)
				}
			}
		}
	}
	what := budgetWhat(b)
	stops := "Stam stops the agents on " + scope + " when it is spent"
	if scope == systemAccount {
		stops = "Stam skips its own model calls (mail gate, titles, summaries, decisions) when it is spent"
	}
	l.raise(ctx, noticeRaise{
		kind:     "budget-low",
		account:  scope,
		key:      "budget-low:" + scope + ":" + budgetPeriod(b, now) + ":" + jsjson.Number(b.USD),
		managers: managers,
		summary:  scope + " at " + jsjson.Number(round(usd/b.USD*100)) + "% of its " + what,
		detail: "Paid spend on " + scope + " is $" + jsjson.ToFixed(usd, 2) + " of its $" + jsjson.ToFixed(b.USD, 2) + " " + what + ". " + stops +
			"; only the human raises a budget, and stam asks them then.",
		usageOf: func(string) string {
			return "A budget is paid dollars, not a subscription window, so stam has no percentage share for it."
		},
	}, now)
}

// scheduleBudget is src/budgets.ts schedule: one timer per scope, a second after the next period rollover while the
// scope is stopped, so the stop lifts without a spend report or a restart. A cap has no rollover. The wait is at most
// setTimeout's 2^31-1 ms.
func (l *Lifecycle) scheduleBudget(scope string, b *config.CostBudget, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if t := l.budgets.timers[scope]; t != nil {
		t.Stop()
		delete(l.budgets.timers, scope)
	}
	at, ok := nextPeriod(b.Per, now)
	if !ok || l.waited {
		return
	}
	wait := time.Duration(math.Min(math.Max(0, float64(at.UnixMilli()+1000-time.Now().UnixMilli())), maxPauseWait)) * time.Millisecond
	if l.budgets.timers == nil {
		l.budgets.timers = map[string]*time.Timer{}
	}
	var t *time.Timer
	t = time.AfterFunc(wait, func() {
		l.mu.Lock()
		if l.budgets.timers[scope] == t {
			delete(l.budgets.timers, scope)
		}
		rolled := l.budgets.rolled
		l.mu.Unlock()
		if rolled != nil {
			rolled(scope)
			return
		}
		l.EvaluateBudgets(scope, time.Now(), "")
	})
	l.budgets.timers[scope] = t
}

// mailBudget is src/budgets.ts mailHuman: mail from system:budgets with the raise Decision, once per scope, period and
// budget amount. The options are the budget plus each raise step (raiseSteps, else half and the whole of it), at most
// three. A mail that couldn't be sent isn't recorded, and is tried again.
func (l *Lifecycle) mailBudget(ctx context.Context, set config.Settings, scope string, b *config.CostBudget, usd float64, now time.Time) {
	key := scope + ":" + budgetPeriod(b, now) + ":" + jsjson.Number(b.USD)
	if !set.HumanMail.Allows("necessary") {
		return
	}
	if mailed, err := l.db.BudgetMailed(ctx, key); err != nil || mailed {
		if err != nil {
			slog.Error("cost budget", "scope", scope, "err", err)
		}
		return
	}
	steps := b.RaiseSteps
	if len(steps) == 0 {
		steps = []float64{b.USD / 2, b.USD}
	}
	if len(steps) > 3 {
		steps = steps[:3]
	}
	options := make([]string, len(steps))
	for i, s := range steps {
		options[i] = "- Raise to $" + jsjson.Number(roundCents(b.USD+s)) + ": $" + jsjson.Number(roundCents(s)) + " more"
	}
	in, err := l.agentsInScope(ctx, set, scope)
	if err != nil {
		slog.Error("cost budget", "scope", scope, "err", err)
		return
	}
	names := make([]string, len(in))
	for i, a := range in {
		names[i] = a.Name
	}
	system := scope == systemAccount
	list := strings.Join(names[:min(6, len(names))], ", ")
	if len(names) > 6 {
		list += ", and " + strconv.Itoa(len(names)-6) + " more"
	}
	if list == "" {
		list = "none"
	}
	vars := map[string]string{
		"scope":    scope,
		"what":     budgetWhat(b),
		"spent":    jsjson.ToFixed(usd, 2),
		"usd":      jsjson.Number(b.USD),
		"stopped":  "Stam has stopped the agents on " + scope + " (" + list + ")",
		"keep":     "the agents stay stopped",
		"rollover": "They resume when the " + b.Per + " rolls over, or when you raise it.",
		"options":  strings.Join(options, "\n"),
		"path":     "cost.accounts." + scope + ".budget.usd",
	}
	if system {
		vars["stopped"], vars["keep"] = "Stam's own model calls (mail gate, titles, summaries, decisions) are skipped", "the calls stay skipped"
		vars["rollover"] = "The calls resume when the " + b.Per + " rolls over, or when you raise it."
	}
	if b.Per == "cap" {
		vars["rollover"] = "A cap holds until you raise it."
	}
	if scope == globalScope {
		vars["path"] = "cost.global.budget.usd"
	}
	body, err := l.render("budget-reached", vars)
	if err != nil {
		slog.Error("cost budget", "scope", scope, "err", err)
		return
	}
	l.mu.Lock()
	send := l.budgets.send
	l.mu.Unlock()
	if send == nil {
		send = func(ctx context.Context, to []string, subject, body string) bool {
			return l.mailFromSystem(ctx, "budgets", to, subject, body)
		}
	}
	if send == nil || !send(ctx, []string{humanID}, "[stam] "+scope+" "+budgetWhat(b)+" reached: raise it or keep stopped", body) {
		l.retryBudget(scope, key)
		return
	}
	l.mu.Lock()
	delete(l.budgets.tries, key)
	l.mu.Unlock()
	if err := l.db.RecordBudgetMail(ctx, key, iso(now)); err != nil {
		slog.Error("cost budget", "scope", scope, "err", err)
	}
}

// retryBudget is src/budgets.ts retry: an unsent mail is tried again after each delay in turn, then left to the next
// evaluation. A restart starts over, since daemon start evaluates every scope and the unsent mail isn't recorded.
func (l *Lifecycle) retryBudget(scope, key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delays := l.budgets.delays
	if delays == nil {
		delays = budgetDelays
	}
	i := l.budgets.tries[key]
	if i >= len(delays) || l.waited {
		return
	}
	if l.budgets.tries == nil {
		l.budgets.tries = map[string]int{}
	}
	l.budgets.tries[key] = i + 1
	time.AfterFunc(delays[i], func() { l.EvaluateBudgets(scope, time.Now(), "") })
}

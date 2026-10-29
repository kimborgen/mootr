package lifecycle

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// The OpenRouter credit balance (src/credits.ts, S-2848 B5b). Agents on an OpenRouter model, and stam's own calls,
// spend a credit the human tops up by hand, so stam polls the balance at start and while such agents are active or held,
// keeps it as the subscriptions entry `openrouter` (the rules, the reserve and the Usage view read it), and mails the
// human once per top-up when the balance drops below cost.openrouterWarnUsd. Each poll first corrects the ledger to the
// bill (ledgerrecon.go), right when /credits returns. A missing or failed call keeps the last valid figures, so an error
// can never make the balance look low or drop the key's cap.
//
// The Go daemon runs no OpenCode agents, so pollCreditsAfterTurn has no caller yet (src/adapters/opencode.ts calls it),
// and the OpenRouter error probe (src/cost-probes.ts probeKey) isn't ported (probes.go). The warning mail comes from
// system:cost (S-1239), and stays pending while it can't be sent.

const (
	// creditPollEvery is src/credits.ts POLL_MS.
	creditPollEvery = 5 * time.Minute
	// creditTurnCooldown is src/credits.ts TURN_COOLDOWN_MS: the shortest gap between polls a turn's end or the reserve
	// asks for.
	creditTurnCooldown = time.Minute
)

// creditState is the poller's last start and whether one runs, and the warning's sender and renderer and the reserve's
// poll request tests replace (src/budgets.ts setCreditPoller); under mu.
type creditState struct {
	lastPoll time.Time
	polling  bool
	send     func(ctx context.Context, to []string, subject, body string) bool
	render   func(name string, vars map[string]string) (string, error)
	poll     func()
}

// openRouterBase is src/llm/openrouter.ts base.
func openRouterBase() string {
	if v := envVar("OPENROUTER_URL"); v != "" {
		return v
	}
	return "https://openrouter.ai/api/v1"
}

// openRouterKey is stam's own OpenRouter key (src/llm/openrouter.ts openRouterKey).
func (l *Lifecycle) openRouterKey() string {
	home := ""
	if l.claude.Templates != nil {
		home = l.claude.Templates.Home
	}
	return config.KeyFor(home, "OPENROUTER_API_KEY", os.Getenv)
}

// openRouterGet is src/llm/openrouter.ts get: the parsed body, or nil when the call fails or answers non-2xx.
func openRouterGet(ctx context.Context, path, key string) jsjson.Value {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, openRouterBase()+path, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("authorization", "Bearer "+key)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil || res.StatusCode < 200 || res.StatusCode > 299 {
		return nil
	}
	v, err := jsjson.Parse(body)
	if err != nil {
		return nil
	}
	return v
}

// finiteNum is src/llm/openrouter.ts num: a finite number, else nil.
func finiteNum(v jsjson.Value) *float64 {
	if n, ok := v.(float64); ok && finite(n) {
		return &n
	}
	return nil
}

// creditBalance is openrouter.balance: GET /credits's total and usage; ok is false when the call failed.
func creditBalance(ctx context.Context, key string) (total, used *float64, ok bool) {
	c := openRouterGet(ctx, "/credits", key)
	if c == nil {
		return nil, nil, false
	}
	return finiteNum(field(field(c, "data"), "total_credits")), finiteNum(field(field(c, "data"), "total_usage")), true
}

// keyLimit is openrouter.keyLimit: GET /key's limit and what is left of it; ok is false when the call failed.
func keyLimit(ctx context.Context, key string) (limit, remaining *float64, ok bool) {
	k := openRouterGet(ctx, "/key", key)
	if k == nil {
		return nil, nil, false
	}
	return finiteNum(field(field(k, "data"), "limit")), finiteNum(field(field(k, "data"), "limit_remaining")), true
}

// creditBasis is src/credits.ts Basis: the capacity a warning was issued for; a later increase in either is a top-up.
type creditBasis struct {
	total, keyLimit *float64
}

// creditEntry is the stored entry's parts poll reads back: the figures, and the warning state.
type creditEntry struct {
	total, used, keyLimit, keyRemaining *float64
	observedAt                          jsjson.Value
	warned                              *creditBasis
	pending                             bool
}

// storedCredits is src/credits.ts stored: the last entry, empty when there is none or it isn't JSON. A figure that isn't
// a number reads as null.
func (l *Lifecycle) storedCredits(ctx context.Context) creditEntry {
	var e creditEntry
	data, _, ok, err := l.db.Subscription(ctx, "openrouter")
	if err != nil || !ok {
		return e
	}
	v, err := jsjson.Parse([]byte(data))
	if err != nil {
		return e
	}
	c := field(v, "credits")
	e.total, e.used, e.keyLimit, e.keyRemaining = finiteNum(field(c, "total")), finiteNum(field(c, "used")), finiteNum(field(c, "key_limit")), finiteNum(field(c, "key_remaining"))
	e.observedAt = field(c, "observed_at")
	if w, ok := field(v, "warned").(*jsjson.Object); ok {
		e.warned = &creditBasis{finiteNum(field(w, "total")), finiteNum(field(w, "key_limit"))}
	}
	e.pending = field(v, "pending") == any(true)
	return e
}

// numOrNull is a figure as the entry stores it.
func numOrNull(n *float64) jsjson.Value {
	if n == nil {
		return nil
	}
	return *n
}

func or64(a, b *float64) *float64 {
	if a != nil {
		return a
	}
	return b
}

// PollCredits is src/credits.ts pollCredits: one poll at a time. The account's total credits and usage, and the key's
// own limit when it has one; the remaining balance is the smaller of the two.
func (l *Lifecycle) PollCredits(ctx context.Context) {
	// The key is read from the secret store before l.mu is taken, so no file read happens under the lock.
	key := l.openRouterKey()
	if key == "" {
		return
	}
	l.mu.Lock()
	if l.credits.polling {
		l.mu.Unlock()
		return
	}
	l.credits.polling, l.credits.lastPoll = true, time.Now()
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		l.credits.polling = false
		l.mu.Unlock()
	}()
	prev := l.storedCredits(ctx)
	// Before /credits is read: later reports wait for the next poll.
	pending, err := l.reconSnapshot(ctx)
	if err != nil {
		slog.Error("credits", "err", err)
		return
	}
	cTotal, cUsed, cOK := creditBalance(ctx, key)
	// The account's billed spend since the last reading corrects the ledger, right when /credits returns, so nothing
	// recorded during the /key call is read as billed.
	if cUsed != nil {
		if err := l.reconcileLedger(ctx, pending, *cUsed); err != nil {
			slog.Error("credits", "err", err)
			return
		}
	}
	kLimit, kRemaining, kOK := keyLimit(ctx, key)
	total, used := or64(cTotal, prev.total), or64(cUsed, prev.used)
	// /key succeeding while its limit is absent means there is no cap: clear it, don't keep it.
	limit, keyRemaining := prev.keyLimit, prev.keyRemaining
	if kOK {
		limit, keyRemaining = kLimit, kRemaining
	}
	var account, remaining *float64
	if total != nil && used != nil {
		a := *total - *used
		account = &a
	}
	switch {
	case account != nil && keyRemaining != nil:
		m := min(*account, *keyRemaining)
		remaining = &m
	case account != nil:
		remaining = account
	default:
		remaining = keyRemaining
	}
	if remaining == nil {
		return // nothing valid this time: leave the last entry as it is
	}
	warned, stillPending, err := l.nextWarning(ctx, prev, *remaining, total, limit)
	if err != nil {
		// TS's render throws out of nextWarning into the poll's catch: nothing is written.
		slog.Error("credits", "err", err)
		return
	}
	// When the balance was last fetched whole: both calls answered this poll. A partial or failed poll keeps the
	// earlier time, so the cost rules never read old figures as fresh.
	observed := prev.observedAt
	if cOK && cTotal != nil && cUsed != nil && kOK {
		observed = iso(time.Now())
	}
	credits := jsjson.NewObject()
	credits.Set("total", numOrNull(total))
	credits.Set("used", numOrNull(used))
	credits.Set("remaining", *remaining)
	credits.Set("key_limit", numOrNull(limit))
	credits.Set("key_remaining", numOrNull(keyRemaining))
	credits.Set("observed_at", observed)
	entry := jsjson.NewObject()
	entry.Set("credits", credits)
	var w jsjson.Value
	if warned != nil {
		o := jsjson.NewObject()
		o.Set("total", numOrNull(warned.total))
		o.Set("key_limit", numOrNull(warned.keyLimit))
		w = o
	}
	entry.Set("warned", w)
	entry.Set("pending", stillPending)
	l.writeCredits(ctx, entry)
}

// writeCredits is src/credits.ts write: the entry stored, the accounts it covers evaluated, and the agents' OpenRouter
// budget scope evaluated, since it is held while the credit is down to the system's reserve.
func (l *Lifecycle) writeCredits(ctx context.Context, entry *jsjson.Object) {
	now := time.Now()
	if err := l.db.SaveSubscription(ctx, "openrouter", jsjson.Stringify(entry, ""), iso(now)); err != nil {
		slog.Error("credits", "err", err)
		return
	}
	l.onReading("openrouter", nil, entry, now)
	l.EvaluateBudgets(agentPool, now, "")
}

// nextWarning is src/credits.ts nextWarning: whether to mail the human, and the warning state to store, which rides in
// the entry so a restart keeps it. A warning re-arms when the balance climbs above the threshold or a top-up raises the
// capacity, and one that couldn't be sent stays pending and is tried on the next poll. A template that doesn't render
// is an error, and the poll then writes nothing, as TS's throw does.
func (l *Lifecycle) nextWarning(ctx context.Context, prev creditEntry, remaining float64, total, limit *float64) (*creditBasis, bool, error) {
	set := l.settings.Get()
	threshold := set.OpenRouterWarnUSD
	if threshold == 0 || remaining >= threshold {
		return nil, false, nil
	}
	now := creditBasis{total, limit}
	if !(prev.pending || prev.warned == nil || increased(*prev.warned, now)) {
		return prev.warned, false, nil
	}
	agents, err := l.db.ListAgents(ctx)
	if err != nil {
		slog.Error("credits", "err", err)
	}
	var names []string
	for _, a := range agents {
		if usesOpenRouter(a) {
			names = append(names, a.Name)
		}
	}
	// The responsible managers hear first; the human only when humanMail.when allows it.
	l.lowCredits(ctx, remaining, threshold, templateNum(total)+":"+templateNum(limit), time.Now())
	sent := true
	if set.HumanMail.Allows("important") {
		list := strings.Join(names, ", ")
		if list == "" {
			list = "none"
		}
		l.mu.Lock()
		render := l.credits.render
		l.mu.Unlock()
		if render == nil {
			render = l.render
		}
		body, err := render("credit-warning", map[string]string{"remaining": jsjson.ToFixed(remaining, 2), "threshold": jsjson.ToFixed(threshold, 2), "agents": list})
		if err != nil {
			return nil, false, err
		}
		l.mu.Lock()
		send := l.credits.send
		l.mu.Unlock()
		if send == nil {
			send = func(ctx context.Context, _ []string, subject, body string) bool {
				return l.mailFromSystem(ctx, "cost", []string{humanID}, subject, body)
			}
		}
		sent = send(ctx, []string{humanID}, "[stam] OpenRouter credit low: $"+jsjson.ToFixed(remaining, 2)+" left", body)
	}
	// Mark the top-up only once the mail is away (or the human chose not to be mailed); otherwise retry it while it is
	// pending.
	if sent {
		return &now, false, nil
	}
	return prev.warned, true, nil
}

// templateNum is `${n}` for a figure: null when there is none.
func templateNum(n *float64) string {
	if n == nil {
		return "null"
	}
	return jsjson.Number(*n)
}

// increased is src/credits.ts increased.
func increased(was, now creditBasis) bool {
	return (was.total != nil && now.total != nil && *now.total > *was.total) || (was.keyLimit != nil && now.keyLimit != nil && *now.keyLimit > *was.keyLimit)
}

// usesOpenRouter is src/credits.ts usesOpenRouter: an agent that spends OpenRouter credit.
func usesOpenRouter(a db.Agent) bool {
	return a.Lifecycle == "active" && onOpenRouter(a)
}

func onOpenRouter(a db.Agent) bool {
	return a.Harness == "opencode" && strings.HasPrefix(deref(a.Model), "openrouter/")
}

// pollCreditsIfActive is src/credits.ts pollIfActive: at most one poll every creditPollEvery, while an OpenRouter agent
// is active or held. One stam holds for credits-out, or for the system reserve (a budget blocker on openrouter), counts
// too: only a fresh balance clears it.
func (l *Lifecycle) pollCreditsIfActive(ctx context.Context) {
	agents, err := l.db.ListAgents(ctx)
	if err != nil {
		slog.Error("credits", "err", err)
		return
	}
	any := false
	for _, a := range agents {
		if usesOpenRouter(a) {
			any = true
			break
		}
		if !onOpenRouter(a) {
			continue
		}
		rows, err := l.db.BlockerRows(ctx, a.ID)
		if err != nil {
			slog.Error("credits", "err", err)
			continue
		}
		for _, b := range rows {
			if b.Kind == "credits-out" || (b.Kind == "budget" && b.Account == agentPool) {
				any = true
			}
		}
		if any {
			break
		}
	}
	if !any || !l.creditPollDue(creditPollEvery) {
		return
	}
	l.goBG(l.PollCredits)
}

// creditPollDue is whether the last poll started at least gap ago.
func (l *Lifecycle) creditPollDue(gap time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return time.Since(l.credits.lastPoll) >= gap
}

// pollCreditsIfAny is src/credits.ts's credit poller hook (src/credit-poller.ts): the reserve asks for a fresh balance
// when a spawn is refused or the reading is stale, so a top-up lifts the hold with no OpenRouter agent running. Not more
// often than after a turn.
func (l *Lifecycle) pollCreditsIfAny() {
	l.mu.Lock()
	poll := l.credits.poll
	l.mu.Unlock()
	if poll != nil {
		poll()
		return
	}
	if l.creditPollDue(creditTurnCooldown) {
		l.goBG(l.PollCredits)
	}
}

// PollCreditsAfterTurn is src/credits.ts pollCreditsAfterTurn: an OpenCode agent's turn ended, so the balance just
// moved. No caller yet (see the header).
func (l *Lifecycle) PollCreditsAfterTurn(a db.Agent) {
	if !strings.HasPrefix(deref(a.Model), "openrouter/") || !l.creditPollDue(creditTurnCooldown) {
		return
	}
	l.goBG(l.PollCredits)
}

// startCreditPolling is src/credits.ts startCreditPolling: once at daemon start when a key exists, then every minute
// pollCreditsIfActive decides.
func (l *Lifecycle) startCreditPolling() {
	if l.openRouterKey() != "" {
		l.goBG(l.PollCredits)
	}
	l.goBG(func(ctx context.Context) {
		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				l.pollCreditsIfActive(ctx)
			}
		}
	})
}

// managersOnOpenRouter is src/cost-notices.ts managersOnOpenRouter: the managers of every active OpenRouter agent, once
// each.
func (l *Lifecycle) managersOnOpenRouter(ctx context.Context) []string {
	agents, err := l.db.ListAgents(ctx)
	if err != nil {
		slog.Error("credits", "err", err)
	}
	var out []string
	seen := map[string]bool{}
	for _, a := range agents {
		if !usesOpenRouter(a) {
			continue
		}
		for _, m := range l.managerOf(ctx, a.ID) {
			if !seen[m] {
				seen[m] = true
				out = append(out, m)
			}
		}
	}
	return out
}

const creditUsage = "OpenRouter credit is not a subscription window, so stam has no percentage share for it."

// lowCredits is src/cost-notices.ts lowCredits: the OpenRouter balance fell below the warning threshold.
func (l *Lifecycle) lowCredits(ctx context.Context, remaining, threshold float64, basis string, now time.Time) {
	l.raise(ctx, noticeRaise{
		kind:     "credits-low",
		account:  agentPool,
		key:      "credits:" + jsjson.Number(threshold) + ":" + basis,
		managers: l.managersOnOpenRouter(ctx),
		summary:  "OpenRouter credit low: $" + jsjson.ToFixed(remaining, 2) + " left",
		detail: "The OpenRouter balance is $" + jsjson.ToFixed(remaining, 2) + ", below the $" + jsjson.ToFixed(threshold, 2) +
			" warning threshold. OpenCode agents on OpenRouter stop when it reaches zero.",
		usageOf: func(string) string { return creditUsage },
	}, now)
}

// reserveNear is src/cost-notices.ts reserveNear: the shared OpenRouter credit is near the share kept for stam's own
// calls. Once per top-up: basis names the credit capacity, so a top-up re-arms it.
func (l *Lifecycle) reserveNear(ctx context.Context, remaining, reserve float64, basis string, now time.Time) {
	managers := l.managersOnOpenRouter(ctx)
	if cos := l.chiefOfStaff(ctx); cos != "" && !contains(managers, cos) {
		managers = append(managers, cos)
	}
	r := jsjson.ToFixed(reserve, 2)
	l.raise(ctx, noticeRaise{
		kind:     "reserve-near",
		account:  agentPool,
		key:      "reserve-near:" + basis,
		managers: managers,
		summary:  "OpenRouter credit near the system reserve: $" + jsjson.ToFixed(remaining, 2) + " left",
		detail: "The OpenRouter balance is $" + jsjson.ToFixed(remaining, 2) + "; $" + r + " of it is kept for stam's own model calls " +
			"(mail gate, titles, summaries, decisions). When the balance falls to $" + r +
			", stam holds the agents on OpenRouter and refuses new ones until the human tops up.",
		usageOf: func(string) string { return creditUsage },
	}, now)
}

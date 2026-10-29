package lifecycle

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"strings"
	"time"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// Cost fallbacks (src/cost-fallback.ts, docs/cost-policy.md build step 14, S-2848 B4c): when a notice about a blocked
// agent goes cost.fallbackMinutes without its manager acting on it, stam applies the account's configured action and
// tells the chief of staff (the human, when the chief of staff can't take it).
//
// Each blocker-set notice whose kind has an action field gets a cost_fallbacks row with its due time and the blocker's
// generation (its since), so the timer survives a restart and never applies to a later blocker of the same kind; the
// blocker's clear retires the row. A row moves pending -> claimed -> running -> done. The claim is one statement that
// also refuses an archived agent or one with an archive or shut-down pending, so two runs never both have it. At start,
// before any timer is set, recoverFallbacks puts a claimed row back to pending (nothing happened yet) and reconciles a
// running one (a take-over's effects undone, a stop undone), retried once; a run whose claim a recovery put back stops
// before it acts (RunFallback). An explicit shut-down or kill cancels the agent's rows
// (CancelFallbacks).
//
//	window, paid-forbidden  onSubExhausted
//	budget                  onBudgetExhausted
//	credits-out             onCreditsOut
//	billing-unknown         onBillingUnknown
//	error                   the account's onError, else cost.onError (soft-stop unless set)
//
// The actions: wait (the default) leaves the agent held until its blocker clears; soft-stop and hard-stop work as wait,
// since the admission gate already holds a blocked agent; continue removes the blocker on a paid: true account (a
// cost:override event) and works as wait on any other.
//
// Not in the Go daemon yet: take-over, which needs cost_switch. A take-over runs its else action instead, and the
// notice and the result both say so. A reviewer's take-over to its own type's fallback chain (review.fallback), a
// reviewer's relaunch after a limit at spawn, and a pause or unpause through the agent pause routes counting as acting on a notice (those routes aren't in the Go daemon) are not
// ported either; cost_pause on the tree does count (costpause.go ackTree).

// stamActor is src/cost-fallback.ts STAM: who a fallback's override is by.
const stamActor = "stam"

// fallbackField is src/cost-fallback.ts FIELD: the account field naming the action for a blocker kind.
var fallbackField = map[string]string{
	"window":          "onSubExhausted",
	"paid-forbidden":  "onSubExhausted",
	"budget":          "onBudgetExhausted",
	"credits-out":     "onCreditsOut",
	"billing-unknown": "onBillingUnknown",
	"error":           "onError",
}

// fallbackAction is src/cost-fallback.ts FallbackAction: the action, its take-over targets, the action after them, and
// the config field it came from ("" for the default).
type fallbackAction struct {
	action string
	to     []string
	els    string
	field  string
}

// coversKind is src/cost-fallback.ts covers: whether a blocker kind has a fallback.
func coversKind(kind string) bool { return fallbackField[kind] != "" }

func (l *Lifecycle) fallbackMinutes() float64 { return l.settings.Get().CostFallbackMinutes }

func normalizeAction(a *config.CostAction, field string) fallbackAction {
	if a == nil {
		return fallbackAction{action: "wait", els: "wait"}
	}
	return fallbackAction{action: a.Action, to: a.To, els: a.Else, field: field}
}

// actionFor is src/cost-fallback.ts actionFor: the action configured for a blocker of this kind on this account.
func (l *Lifecycle) actionFor(account, kind string) fallbackAction {
	field := fallbackField[kind]
	if field == "" {
		return normalizeAction(nil, "")
	}
	s := l.settings.Get()
	acct, configured := s.CostAccounts[account]
	if a, ok := acct.Actions[field]; configured && ok {
		return normalizeAction(&a, account+"."+field)
	}
	if kind == "error" && s.CostOnError != nil {
		return normalizeAction(s.CostOnError, "onError")
	}
	// The global budget's blocker (its scope is no account) takes cost.global.onExhausted.
	if kind == "budget" && !configured && s.GlobalOnExhausted != "" {
		return normalizeAction(&config.CostAction{Action: s.GlobalOnExhausted, Else: "wait"}, "global.onExhausted")
	}
	return normalizeAction(nil, "")
}

// phrase is src/cost-fallback.ts phrase.
func (f fallbackAction) phrase() string {
	if f.action != "take-over" {
		return f.action
	}
	to := strings.Join(f.to, ", ")
	if to == "" {
		to = "(no preset)"
	}
	return "take over to " + to + ", else " + f.els
}

// takeOverMissing is what a take-over does in the Go daemon: its else action.
const takeOverMissing = "take-over isn't in the Go daemon yet"

// describeFallback is src/cost-fallback.ts describe: a sentence for the notice, what runs if nobody acts.
func (l *Lifecycle) describeFallback(account, kind string, _ db.Agent) string {
	if !coversKind(kind) {
		return ""
	}
	f := l.actionFor(account, kind)
	field := " (the default)"
	if f.field != "" {
		field = " (" + f.field + ")"
	}
	out := "If no manager acts on this agent within " + jsjson.Number(l.fallbackMinutes()) + " minutes, stam applies the fallback: " + f.phrase() + field + "."
	if f.action == "take-over" {
		out += " The " + takeOverMissing + ", so stam applies " + f.els + " instead."
	}
	return out
}

// armFallback is src/cost-fallback.ts arm: the timer of a blocker-set notice, for the blocker generation since.
func (l *Lifecycle) armFallback(ctx context.Context, n db.CostNotice, kind, since string, now time.Time) {
	if n.AgentID == nil || !coversKind(kind) {
		return
	}
	due := int64(math.Round(ms(now) + l.fallbackMinutes()*60_000))
	if err := l.db.ArmFallback(ctx, db.CostFallback{NoticeID: n.ID, AgentID: *n.AgentID, Kind: kind, Account: n.Account, BlockerSince: since, DueAt: due}); err != nil {
		slog.Error("cost fallback: arm", "event", n.ID, "err", err)
		return
	}
	l.scheduleFallbacks(ctx)
}

// retireFallback is src/cost-fallback.ts retire: the blocker cleared, so its pending fallbacks are done.
func (l *Lifecycle) retireFallback(ctx context.Context, id, kind, account string) {
	if !coversKind(kind) {
		return
	}
	if err := l.db.RetireFallbacks(ctx, id, kind, account); err != nil {
		slog.Error("cost fallback: retire", "agent", id, "err", err)
	}
}

// CancelFallbacks is src/cost-fallback.ts cancelPending, for the shutdown and kill actions (src/lifecycle.ts
// explicitShutdown): the agent's pending fallbacks end now, and a claimed or running one cancels before it acts.
func (l *Lifecycle) CancelFallbacks(ctx context.Context, id, why string) error {
	return l.db.CancelFallbacks(ctx, id, why)
}

// endingPending is whether an archive or shut-down is pending on the agent.
func endingPending(a db.Agent) bool {
	p, err := a.PendingActionOf()
	return err == nil && p != nil && (p.Type == "archive" || p.Type == "shutdown")
}

// fallbackPrior is what a running fallback's checks compare against: the agent's state at its claim.
type fallbackPrior struct {
	Lifecycle string   `json:"lifecycle"`
	Owners    []string `json:"owners"`
}

// who names an actor for a sentence: the human, an agent's name, or the id.
func (l *Lifecycle) who(ctx context.Context, id string) string {
	if id == humanID {
		return "the human"
	}
	if a, err := l.db.GetAgent(ctx, id); err == nil {
		return a.Name
	}
	return id
}

// unwanted is src/cost-fallback.ts unwanted: why the fallback no longer applies, "" when it does. A manager acked the
// notice, an explicit shut-down cancelled it, an archive or shut-down is pending, the blocker cleared or was replaced,
// or (once claimed) someone paused the agent since.
func (l *Lifecycle) unwanted(ctx context.Context, r db.CostFallback) (string, error) {
	n, ok, err := l.db.CostNoticeByID(ctx, r.NoticeID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "its notice is gone", nil
	}
	// Read fresh: r may predate the cancel.
	if now, ok, err := l.db.Fallback(ctx, r.NoticeID); err != nil {
		return "", err
	} else if ok && now.Cancel != nil {
		return *now.Cancel, nil
	}
	if n.AckedAt != nil {
		return l.who(ctx, deref(n.AckedBy)) + " acted on it", nil
	}
	a, aerr := l.db.GetAgent(ctx, r.AgentID)
	if aerr == nil && endingPending(a) {
		return a.Name + " is being archived or shut down", nil
	}
	rows, err := l.db.BlockerRows(ctx, r.AgentID)
	if err != nil {
		return "", err
	}
	state := "cleared"
	for _, b := range rows {
		if b.Kind == r.Kind && b.Account == r.Account {
			state = "replaced"
			if b.Since == r.BlockerSince {
				state = "same"
			}
		}
	}
	if state == "cleared" {
		return "the blocker cleared", nil
	}
	if state == "replaced" {
		return "the blocker was replaced by a newer one", nil
	}
	if r.Prior == nil || aerr != nil {
		return "", nil
	}
	var before fallbackPrior
	if err := json.Unmarshal([]byte(*r.Prior), &before); err != nil {
		return "", err
	}
	var added []string
	for _, o := range pauseOwners(a) {
		if !contains(before.Owners, o) {
			added = append(added, l.who(ctx, o))
		}
	}
	if len(added) > 0 {
		return strings.Join(added, ", ") + " paused it", nil
	}
	return "", nil
}

type fallbackStartEvent struct {
	Step   string `json:"step"`
	Event  string `json:"event"`
	Action string `json:"action"`
}

type fallbackDoneEvent struct {
	Step   string `json:"step"`
	Event  string `json:"event"`
	Result string `json:"result"`
	Told   string `json:"told"`
}

// runFallback is src/cost-fallback.ts run: one due fallback, claimed first so a second evaluation can't run it too.
func (l *Lifecycle) runFallback(ctx context.Context, r db.CostFallback) error {
	claimed, err := l.db.ClaimFallback(ctx, r.NoticeID, iso(time.Now()))
	if err != nil || !claimed {
		return err
	}
	done := func(result string) error { return l.db.FinishFallback(ctx, r.NoticeID, result) }
	a, err := l.db.GetAgent(ctx, r.AgentID)
	if err != nil || !isLive(a) || a.ForwardedTo != nil {
		return done("skipped: the agent is gone or taken over")
	}
	r.Prior = nil
	why, err := l.unwanted(ctx, r)
	if err != nil {
		return err
	}
	if why != "" {
		return done("skipped: " + why)
	}
	owners := pauseOwners(a)
	if owners == nil {
		owners = []string{}
	}
	prior, err := json.Marshal(fallbackPrior{Lifecycle: string(a.Lifecycle), Owners: owners})
	if err != nil {
		return err
	}
	text := string(prior)
	r.Prior = &text
	if ok, err := l.db.RunFallback(ctx, r.NoticeID, text); err != nil || !ok {
		return err
	}
	f := l.actionFor(r.Account, r.Kind)
	l.event(ctx, a.ID, "cost:fallback", fallbackStartEvent{Step: "start", Event: r.NoticeID, Action: f.phrase()})
	var result string
	if f.action == "take-over" {
		result, err = l.plainFallback(ctx, f.els, a, r)
		result = takeOverMissing + "; then " + result
	} else {
		result, err = l.plainFallback(ctx, f.action, a, r)
	}
	if err != nil {
		result = "failed: " + err.Error()
	}
	if now, err := l.db.GetAgent(ctx, a.ID); err == nil {
		a = now
	}
	told := l.tellFallback(ctx, a, r, f, result)
	if err := done(result); err != nil {
		return err
	}
	l.event(ctx, a.ID, "cost:fallback", fallbackDoneEvent{Step: "done", Event: r.NoticeID, Result: result, Told: told})
	return nil
}

type overrideBlocker struct {
	Kind    string `json:"kind"`
	Account string `json:"account"`
}

type overrideEvent struct {
	Blockers []overrideBlocker `json:"blockers"`
	By       string            `json:"by"`
	Fallback string            `json:"fallback"`
}

// plainFallback is src/cost-fallback.ts plain: an action with no targets. It returns the result sentence.
func (l *Lifecycle) plainFallback(ctx context.Context, name string, a db.Agent, r db.CostFallback) (string, error) {
	held := a.Name + " stays held until its " + r.Kind + " blocker clears"
	switch name {
	case "soft-stop", "hard-stop":
		return "waited: the admission gate already holds " + a.Name + ", so " + name + " works as wait; " + held, nil
	case "continue":
		// A spent budget lifts only on a rollover or a raise by the human, never by a fallback.
		if r.Kind == "budget" {
			return "waited: a spent budget is lifted only by a period rollover or a raise by the human, so continue works as wait; " + held, nil
		}
		if acct, ok := l.settings.Get().CostAccounts[r.Account]; !ok || acct.Paid == nil || !*acct.Paid {
			account := r.Account
			if account == "" {
				account = "the account"
			}
			return "waited: continue needs paid: true on " + account + ", so it works as wait; " + held, nil
		}
		l.event(ctx, a.ID, "cost:override", overrideEvent{Blockers: []overrideBlocker{{Kind: r.Kind, Account: r.Account}}, By: stamActor, Fallback: r.NoticeID})
		if _, err := l.ClearBlocker(ctx, a.ID, r.Kind, r.Account, "the cost fallback continued on paid account "+r.Account, nil); err != nil {
			return "", err
		}
		return "continued: removed " + a.Name + "'s " + r.Kind + " blocker on paid account " + r.Account + " (cost:override)", nil
	case "wait":
		return "waited: " + held, nil
	}
	return "waited: unknown action " + name + " works as wait; " + held, nil
}

// reachableChief is src/cost-fallback.ts reachableChief: the chief of staff when it can take the news (not the blocked
// agent, active, not taken over, unblocked); "" otherwise.
func (l *Lifecycle) reachableChief(ctx context.Context, blocked string) (db.Agent, bool) {
	id := l.chiefOfStaff(ctx)
	if id == "" || id == blocked {
		return db.Agent{}, false
	}
	cos, err := l.db.GetAgent(ctx, id)
	if err != nil || cos.Lifecycle != "active" || cos.ForwardedTo != nil {
		return db.Agent{}, false
	}
	if rows, err := l.db.BlockerRows(ctx, id); err != nil || len(rows) > 0 {
		return db.Agent{}, false
	}
	return cos, true
}

type fallbackToldEvent struct {
	Agent string `json:"agent"`
	Event string `json:"event"`
}

// tellFallback is src/cost-fallback.ts tell: the chief of staff hears what ran, or the human when it can't. It returns
// who was told: the chief of staff's name, human, or "".
func (l *Lifecycle) tellFallback(ctx context.Context, a db.Agent, r db.CostFallback, f fallbackAction, result string) string {
	var managers []string
	for _, m := range l.managerOf(ctx, a.ID) {
		managers = append(managers, l.who(ctx, m))
	}
	names := strings.Join(managers, ", ")
	if names == "" {
		names = "(none)"
	}
	blocker := r.Kind
	if r.Account != "" {
		blocker += " on " + r.Account
	}
	field := f.field
	if field == "" {
		field = "no configured action, so the default"
	}
	body, err := l.render("cost-fallback", map[string]string{"agent": a.Name, "event": r.NoticeID, "minutes": jsjson.Number(l.fallbackMinutes()), "blocker": blocker,
		"action": f.phrase(), "field": field, "result": result, "managers": names})
	if err != nil {
		slog.Error("cost fallback: tell", "event", r.NoticeID, "err", err)
		return ""
	}
	subject := "[stam] Cost fallback ran for " + a.Name + ": " + f.action
	if cos, ok := l.reachableChief(ctx, a.ID); ok {
		l.deliverCost(ctx, cos.ID, subject, body, nil)
		l.event(ctx, cos.ID, "cost:fallback-told", fallbackToldEvent{Agent: a.Name, Event: r.NoticeID})
		return cos.Name
	}
	if !l.settings.Get().HumanMail.Allows("necessary") {
		return ""
	}
	why := "The chief of staff is unavailable or blocked"
	if l.chiefOfStaff(ctx) == a.ID {
		why = "The chief of staff is the blocked agent"
	}
	l.deliverCost(ctx, humanID, subject, body+"\n\n"+why+", so this reaches you instead.", nil)
	return humanID
}

// evaluateFallbacks is src/cost-fallback.ts evaluate: every fallback due by now runs, then the timer is set for the next.
func (l *Lifecycle) evaluateFallbacks(ctx context.Context, now time.Time) {
	due, err := l.db.DueFallbacks(ctx, now.UnixMilli())
	if err != nil {
		slog.Error("cost fallbacks", "err", err)
	}
	for _, r := range due {
		if err := l.runFallback(ctx, r); err != nil {
			slog.Error("cost fallback", "event", r.NoticeID, "err", err)
		}
	}
	l.scheduleFallbacks(ctx)
}

// scheduleFallbacks is src/cost-fallback.ts schedule: one timer, for the soonest pending fallback.
func (l *Lifecycle) scheduleFallbacks(ctx context.Context) {
	due, ok, err := l.db.NextFallbackDue(ctx)
	if err != nil {
		slog.Error("cost fallbacks: schedule", "err", err)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fallbackTimer != nil {
		l.fallbackTimer.Stop()
		l.fallbackTimer = nil
	}
	if !ok || !l.recovered || l.waited || l.ctx.Err() != nil {
		return
	}
	wait := time.Duration(max(0, due-time.Now().UnixMilli())) * time.Millisecond
	l.fallbackTimer = time.AfterFunc(wait, func() {
		l.goBG(func(ctx context.Context) { l.evaluateFallbacks(ctx, time.Now()) })
	})
}

type fallbackRecoveredEvent struct {
	Step     string `json:"step"`
	Event    string `json:"event"`
	Attempts int    `json:"attempts"`
}

// recoverFallbacks is src/cost-fallback.ts recover: the rows a previous daemon left mid-run. A claimed row did nothing
// yet, so it runs again. A running row is reconciled, never repeated blindly: an agent taken over means the take-over got
// through; otherwise a taken-over blocker is dropped, a stop of an agent that ran is undone, and it retries once.
func (l *Lifecycle) recoverFallbacks(ctx context.Context) error {
	running, err := l.db.RecoverFallbacks(ctx)
	if err != nil {
		return err
	}
	for _, r := range running {
		done := func(result string) error { return l.db.FinishFallback(ctx, r.NoticeID, result) }
		a, err := l.db.GetAgent(ctx, r.AgentID)
		if err != nil {
			if err := done("skipped: the agent is gone"); err != nil {
				return err
			}
			continue
		}
		if a.ForwardedTo != nil {
			if err := done("took over (reconciled after a restart): " + a.Name + " continues as " + l.who(ctx, *a.ForwardedTo)); err != nil {
				return err
			}
			continue
		}
		if err := l.db.DropTakenOver(ctx, a.ID); err != nil {
			return err
		}
		var prior fallbackPrior
		if r.Prior != nil {
			_ = json.Unmarshal([]byte(*r.Prior), &prior)
		}
		if now, err := l.db.GetAgent(ctx, a.ID); err == nil && (prior.Lifecycle == "active" || prior.Lifecycle == "paused") && now.Lifecycle == "shut_down" {
			// A held agent comes back paused, as any resume of one does.
			if _, err := l.Resume(ctx, now, ""); err != nil {
				l.event(ctx, a.ID, "cost:fallback-resume-error", err.Error())
			}
		}
		l.event(ctx, a.ID, "cost:fallback", fallbackRecoveredEvent{Step: "recovered", Event: r.NoticeID, Attempts: r.Attempts})
		if r.Attempts >= 1 {
			err = done("failed: interrupted by a daemon restart twice")
		} else {
			err = l.db.RetryFallback(ctx, r.NoticeID)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// recoverAtStart is the first half of src/cost-fallback.ts reschedule, at daemon start: the rows left mid-run are
// recovered before anything evaluates. Until it has run no timer is set (scheduleFallbacks), so an evaluation can't
// claim a row this puts back to pending, or mark one running that this then retries: either would run it twice. TS's
// single thread can't interleave them.
func (l *Lifecycle) recoverAtStart(ctx context.Context) {
	if err := l.recoverFallbacks(ctx); err != nil {
		slog.Error("cost fallbacks: recover", "err", err)
	}
	l.mu.Lock()
	l.recovered = true
	l.mu.Unlock()
}

// startFallbacks is src/cost-fallback.ts reschedule, at daemon start: the rows left mid-run are recovered, the
// fallbacks that came due while the daemon was down run, and the timer is set for the rest.
func (l *Lifecycle) startFallbacks(ctx context.Context) {
	l.recoverAtStart(ctx)
	l.evaluateFallbacks(ctx, time.Now())
}

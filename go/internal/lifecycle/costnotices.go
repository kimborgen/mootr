package lifecycle

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"sort"
	"strings"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// Cost notices to the responsible manager (src/cost-notices.ts, docs/cost-policy.md build step 11, S-2848 B4c): a cost
// blocker set or cleared on an agent goes to the manager of its tree, the agent's direct parents, or the chief of staff
// for an agent without one, and to the human only when there is no manager and the human's mail setting allows it
// (important). A notice reaches a working manager as an in-turn notice and anyone else as mail from system:cost. It
// carries the event id, what happened, the tree's share of the window, the user's cost instructions and the manager's
// options.
// `cost_ack EVENT` records that a manager handled it and stops its fallback (fallback.go); a manager's ack withdraws the
// human's copy.
//
// The window and projection notices are raised from usage.go's reportSubscription, the budget notice (budgetLow) in
// budgets.go, the credits and reserve notices (lowCredits, reserveNear) in credits.go. The share line is the tree's
// estimate from attribution.go; the allocation notice (allocationWarning) is raised from allocations.go. Not ported:
// cost_switch's notice (B5e); and an account a reading's harness matches only by its model is the first such by name,
// where TS takes the first in the file.

const humanID = "human"

// SetCostMail sets how cost notices mail from a system:NAME sender (the server's sendFromSystemMail, which gives the
// mail's id) and withdraw the human's copy of one a manager handled (withdrawQuietly); nil sends and withdraws nothing.
func (l *Lifecycle) SetCostMail(send func(ctx context.Context, name string, to []string, subject, body string) (string, bool), withdraw func(ctx context.Context, ids []string, by, note string)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.costSend, l.costWithdraw = send, withdraw
}

func (l *Lifecycle) costMail() (func(ctx context.Context, name string, to []string, subject, body string) (string, bool), func(ctx context.Context, ids []string, by, note string)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.costSend, l.costWithdraw
}

// isLive is src/db.ts isLive.
func isLive(a db.Agent) bool { return a.Lifecycle == "active" || a.Lifecycle == "paused" }

// managerOf is src/cost-notices.ts managerOf: the agent's direct parents that exist, or the chief of staff when it has
// none (and isn't it). Empty when neither exists, so the caller can fall back to the human.
func (l *Lifecycle) managerOf(ctx context.Context, id string) []string {
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return nil
	}
	ids, _ := l.db.ParentsOf(ctx, a)
	var parents []string
	for _, p := range ids {
		if _, err := l.db.GetAgent(ctx, p); err == nil {
			parents = append(parents, p)
		}
	}
	if len(parents) > 0 {
		return parents
	}
	if cos := l.chiefOfStaff(ctx); cos != "" && cos != a.ID {
		return []string{cos}
	}
	return nil
}

// noticeRaise is src/cost-notices.ts Raise.
type noticeRaise struct {
	kind, account, window string
	resetsAt              *int
	agentID               *string
	key                   string
	managers              []string
	summary, detail       string
	usageOf               func(manager string) string
}

type costNoticeEvent struct {
	Event   string `json:"event"`
	Kind    string `json:"kind"`
	Account string `json:"account"`
}

// raise is src/cost-notices.ts raise: the event is recorded once (its key is unique) and one notice goes to each
// manager, or to the human when there is none. It returns the stored notice, nil for a duplicate or no recipient. A
// notice is a side effect of cost tracking and never fails what raised it: a failure is logged.
func (l *Lifecycle) raise(ctx context.Context, r noticeRaise, now time.Time) *db.CostNotice {
	targets := r.managers
	if len(targets) == 0 && l.settings.Get().HumanMail.Allows("important") {
		targets = []string{humanID}
	}
	if len(targets) == 0 {
		return nil
	}
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		slog.Error("cost notice", "err", err)
		return nil
	}
	n := db.CostNotice{ID: "cn-" + hex.EncodeToString(b), Key: r.key, Kind: r.kind, Account: r.account, Window: r.window, ResetsAt: r.resetsAt, AgentID: r.agentID,
		Managers: targets, CreatedAt: iso(now)}
	added, err := l.db.AddCostNotice(ctx, n)
	if err != nil {
		slog.Error("cost notice", "key", r.key, "err", err)
		return nil
	}
	if !added {
		return nil
	}
	instructions := strings.TrimSpace(l.settings.Get().CostInstructions)
	if instructions == "" {
		instructions = "(none set)"
	}
	subject := "[stam] Cost notice " + n.ID + ": " + r.summary
	for _, m := range targets {
		body, err := l.render("cost-notice", map[string]string{"event": n.ID, "summary": r.summary, "detail": r.detail, "usage": r.usageOf(m), "instructions": instructions})
		if err != nil {
			// TS's raise swallows this the same way, and arms no fallback for a notice that went to no one.
			slog.Error("cost notice", "event", n.ID, "err", err)
			return nil
		}
		id := n.ID
		l.deliverCost(ctx, m, subject, body, func(ctx context.Context, mailID string) { l.setHumanMail(ctx, id, mailID) })
		if m != humanID {
			l.event(ctx, m, "cost:notice", costNoticeEvent{Event: n.ID, Kind: r.kind, Account: n.Account})
		}
	}
	return &n
}

// deliverCost is src/cost-notices.ts deliver: a working manager gets an in-turn notice (it arrives after its next tool
// call); anyone else gets mail from system:cost, sent in the background, which reaches an idle manager as a prompt.
// onSent gets the id of the mail when it goes to the human.
func (l *Lifecycle) deliverCost(ctx context.Context, manager, subject, body string, onSent func(ctx context.Context, mailID string)) {
	send, _ := l.costMail()
	if manager != humanID {
		if a, err := l.db.GetAgent(ctx, manager); err == nil && a.Lifecycle == "active" && a.Activity == "working" {
			l.QueueNotice(ctx, manager, body, false)
			return
		}
	}
	if send == nil {
		return
	}
	l.goBG(func(ctx context.Context) {
		id, ok := send(ctx, "cost", []string{manager}, subject, body)
		if !ok {
			slog.Error("cost notice: mail not sent", "to", manager, "subject", subject)
			return
		}
		if manager == humanID && onSent != nil {
			onSent(ctx, id)
		}
	})
}

// setHumanMail is src/cost-notices.ts setHumanMail: the human's mail that carried a notice, once sent. An ack that
// landed before the mail was stored settles it now.
func (l *Lifecycle) setHumanMail(ctx context.Context, eventID, mailID string) {
	n, err := l.db.SetNoticeHumanMail(ctx, eventID, mailID)
	if err != nil {
		slog.Error("cost notice", "event", eventID, "err", err)
		return
	}
	if n.AckedAt != nil && n.AckedBy != nil && *n.AckedBy != humanID {
		l.settleHumanCopy(ctx, mailID, *n.AckedBy, eventID)
	}
}

// settleHumanCopy withdraws the human's copy of a notice a manager handled, naming who did.
func (l *Lifecycle) settleHumanCopy(ctx context.Context, mailID, by, eventID string) {
	_, withdraw := l.costMail()
	if withdraw == nil {
		return
	}
	name := by
	if a, err := l.db.GetAgent(ctx, by); err == nil {
		name = a.Name
	}
	withdraw(ctx, []string{mailID}, by, "Withdrawn by @"+name+": cost notice "+eventID+" handled")
}

// firstUnderscore is JavaScript's window.replace('_', '-'): the first underscore only.
func firstUnderscore(window string) string { return strings.Replace(window, "_", "-", 1) }

// shareLine is src/cost-notices.ts shareLine: the manager's tree's estimated share of a window, as a sentence for the
// notice; no share is claimed when no window reading exists yet. A failed estimate is logged and reads as none yet.
func (l *Lifecycle) shareLine(ctx context.Context, manager, account, window string) string {
	win := firstUnderscore(window)
	none := "No " + win + " reading yet to estimate this tree's share of " + account + "."
	harness := l.settings.Get().CostAccounts[account].Harness
	if harness == "" {
		return none
	}
	has, err := l.db.HasWindowReading(ctx, harness, window)
	if err != nil || !has {
		return none
	}
	s, err := l.windowSharesOf(ctx, account, window, nil, ms(time.Now()))
	if err != nil {
		logAttribution(err, "share line")
		return none
	}
	share, err := l.treeShare(ctx, manager, s)
	if err != nil {
		logAttribution(err, "share line")
		return none
	}
	return "This tree's estimated share of the " + win + " window on " + account + ": about " + jsjson.Number(roundCents(share)) +
		"% (stam's estimate, never a rule)."
}

// blockerUsage is src/cost-notices.ts blockerUsage: a share line per window of the blocker's account, or why there is
// none.
func (l *Lifecycle) blockerUsage(ctx context.Context, manager, account string) string {
	acct, ok := l.settings.Get().CostAccounts[account]
	if account == "" || !ok || acct.Harness == "" {
		return "No subscription window for this blocker."
	}
	windows, err := l.db.WindowNames(ctx, acct.Harness)
	if err != nil || len(windows) == 0 {
		return "No window reading yet to estimate this tree's share of " + account + "."
	}
	lines := make([]string, len(windows))
	for i, w := range windows {
		lines[i] = l.shareLine(ctx, manager, account, w)
	}
	return strings.Join(lines, "\n")
}

// managersOnAccount is src/cost-notices.ts managersOnAccount: the managers of every active agent on the account, once
// each, in the agents' order.
func (l *Lifecycle) managersOnAccount(ctx context.Context, account string) []string {
	agents, err := l.db.ListAgents(ctx)
	if err != nil {
		slog.Error("cost notice", "err", err)
	}
	set := l.settings.Get()
	var out []string
	seen := map[string]bool{}
	for _, a := range agents {
		if a.Lifecycle != "active" || set.AccountFor(a.Harness, a.Model) != account {
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

// accountForReading is src/cost-notices.ts accountForReading: the account a subscription reading belongs to. Its name
// is the harness (Claude) or codex:ID (Codex), so the harness part is matched: the account for the harness alone, else
// the first (by name) whose match names that harness with a model. "" when none does.
func (l *Lifecycle) accountForReading(name string) string {
	harness, _, _ := strings.Cut(name, ":")
	set := l.settings.Get()
	if a := set.AccountFor(harness, nil); a != "" {
		return a
	}
	names := make([]string, 0, len(set.CostAccounts))
	for n := range set.CostAccounts {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if set.CostAccounts[n].Harness == harness {
			return n
		}
	}
	return ""
}

// windowWarning is src/cost-notices.ts windowWarning: a subscription window crossed a warn percentage, and the managers
// of the trees on its account hear, once per window, threshold and reset.
func (l *Lifecycle) windowWarning(ctx context.Context, name, window string, percent, threshold float64, resetsAt *float64, now time.Time) {
	account := l.accountForReading(name)
	if account == "" {
		account = name
	}
	win := firstUnderscore(window)
	resets, basis := "at an unknown time", "none"
	var stored *int
	if resetsAt != nil {
		basis = jsjson.Number(*resetsAt)
		r := int(*resetsAt)
		stored = &r
		if *resetsAt != 0 {
			resets = utcSec(*resetsAt)
		}
	}
	pct, thr := jsjson.Number(percent), jsjson.Number(threshold)
	l.raise(ctx, noticeRaise{kind: "window", account: account, window: window, resetsAt: stored, key: "window:" + account + ":" + window + ":" + thr + ":" + basis,
		managers: l.managersOnAccount(ctx, account), summary: name + " " + win + " at " + pct + "% (threshold " + thr + "%)",
		detail:  "The " + win + " window is at " + pct + "%, past the " + thr + "% warning line, and resets " + resets + ".",
		usageOf: func(m string) string { return l.shareLine(ctx, m, account, window) }}, now)
}

const (
	// projectionEvery is src/cost-notices.ts PROJECTION_MS: the projection is checked at most this often per window.
	projectionEvery = 5 * float64(time.Minute/time.Millisecond)
	// projectionWithin is src/cost-notices.ts WITHIN_MS: a window projected to reach 100% this soon warns.
	projectionWithin = 30 * float64(time.Minute/time.Millisecond)
)

// checkProjection is src/cost-notices.ts checkProjection: a window projected to reach 100% within 30 minutes warns the
// managers of the trees on its account, once per window and reset. Throttled per account and window, so a status line
// refresh doesn't refit every time.
func (l *Lifecycle) checkProjection(ctx context.Context, name, window string, now time.Time) {
	account := l.accountForReading(name)
	if account == "" {
		return
	}
	t := ms(now)
	k := account + ":" + window
	l.mu.Lock()
	last, seen := l.usage.lastProjection[k]
	due := !seen || t-last >= projectionEvery
	if due {
		if l.usage.lastProjection == nil {
			l.usage.lastProjection = map[string]float64{}
		}
		l.usage.lastProjection[k] = t
	}
	l.mu.Unlock()
	if !due {
		return
	}
	s, err := l.windowSharesOf(ctx, account, window, nil, t)
	if err != nil {
		logAttribution(err, "projection")
		return
	}
	proj := s.projection
	if proj.reaches100At == nil {
		return
	}
	at, _ := parseMs(*proj.reaches100At)
	if !(at > t && at-t <= projectionWithin) {
		return
	}
	reaches, basis := *proj.reaches100At, "none"
	if proj.resetsAt != nil {
		basis = *proj.resetsAt
	}
	win := firstUnderscore(window)
	l.raise(ctx, noticeRaise{kind: "projection", account: account, window: window, key: "projection:" + account + ":" + window + ":" + basis,
		managers: l.managersOnAccount(ctx, account), summary: account + " " + win + " projected to reach 100% around " + reaches[11:16] + " UTC",
		detail:  "At the last 30 minutes' rate, " + account + "'s " + win + " window reaches 100% around " + strings.Replace(reaches, "T", " ", 1)[:16] + " UTC.",
		usageOf: func(m string) string { return l.shareLine(ctx, m, account, window) }}, now)
}

// blockerChanged is src/cost-notices.ts blockerChanged: a cost blocker was set or cleared on an agent, and its manager
// hears, whoever set it. when is the blocker's since for a set, or the clear time, so a refresh of the same blocker
// doesn't notify again. An archived or stopped agent gets no notice (S-787), and its clear still retires any fallback.
// A set arms the fallback for this generation of the blocker; a clear retires it.
func (l *Lifecycle) blockerChanged(ctx context.Context, id, kind, account, action, reason, when string, now time.Time) {
	// cost_switch tells the managers itself; its taken-over blocker is no news.
	if kind == "taken-over" {
		return
	}
	a, err := l.db.GetAgent(ctx, id)
	found := err == nil
	name := id
	if found {
		name = a.Name
	}
	what := kind
	if account != "" {
		what += " on " + account
	}
	var notice *db.CostNotice
	if found && isLive(a) {
		r := noticeRaise{kind: "blocker-clear", account: account, agentID: &id, managers: l.managerOf(ctx, id), summary: name + " unblocked: " + what,
			usageOf: func(m string) string { return l.blockerUsage(ctx, m, account) }}
		if action == "set" {
			r.kind, r.summary = "blocker-set", name+" blocked: "+what
			r.detail = "Stam set a cost blocker on " + name + ": " + reason + "."
			if d := l.describeFallback(account, kind, a); d != "" {
				r.detail += "\n" + d
			}
		} else {
			why := reason
			if why == "" {
				why = "its condition cleared"
			}
			r.detail = "The blocker on " + name + " cleared: " + why + "."
		}
		r.key = r.kind + ":" + id + ":" + kind + ":" + account + ":" + when
		notice = l.raise(ctx, r, now)
	}
	if notice != nil && action == "set" {
		l.armFallback(ctx, *notice, kind, when, now)
	}
	if action == "clear" {
		l.retireFallback(ctx, id, kind, account)
	}
}

// allocationWarning is src/cost-notices.ts allocationWarning: a tree reached 80% or 100% of its allocation
// (allocations.go). It goes to the tree's manager and to the tree's root, so unlike a window warning it never falls back
// to the human. basis is the window reset (or period start) the notice dedups on.
func (l *Lifecycle) allocationWarning(ctx context.Context, e allocationNotice, now time.Time) *db.CostNotice {
	root, ok, err := l.agentRef(ctx, e.root)
	if err != nil || !ok {
		return nil
	}
	// The tree's manager and the tree's root itself, each once.
	seen := map[string]bool{}
	var targets []string
	for _, id := range append(l.managerOf(ctx, root.ID), root.ID) {
		if seen[id] {
			continue
		}
		seen[id] = true
		if _, ok, _ := l.agentRef(ctx, id); id == humanID || ok {
			targets = append(targets, id)
		}
	}
	unit, ofUnit := jsjson.Number(e.used)+"%", jsjson.Number(e.of)+"%"
	what := "its " + firstUnderscore(e.window) + " allocation on " + e.account
	spend := firstUnderscore(e.window)
	if e.kind == "usd" {
		unit, ofUnit = "$"+jsjson.ToFixed(e.used, 2), "$"+jsjson.Number(e.of)
		what = "its " + e.period + " paid-spend allocation on " + e.account
		spend = e.period + " spend"
	}
	pct := jsjson.Number(round(e.usedPercent))
	lines := []string{"The tree rooted at " + root.Name + " has used about " + unit + " of " + ofUnit + " — " + pct + "% of " + what + "."}
	if e.projection != "" {
		lines = append(lines, e.projection)
	}
	if e.note != nil && *e.note != "" {
		lines = append(lines, "Note on the allocation: "+*e.note)
	}
	lines = append(lines, "Allocations are not enforced: this is a notice, not a stop, and what happens next is the manager's call.")
	rootID := root.ID
	return l.raise(ctx, noticeRaise{kind: "allocation", account: e.account, window: e.window, agentID: &rootID,
		key:      "allocation:" + e.allocation + ":" + jsjson.Number(e.threshold) + ":" + e.basis,
		managers: targets, summary: root.Name + " at " + pct + "% of its " + spend + " allocation (" + unit + " of " + ofUnit + ")",
		detail: strings.Join(lines, "\n"),
		usageOf: func(m string) string {
			if e.kind == "usd" {
				return "This tree's " + e.period + " paid spend on " + e.account + ": about $" + jsjson.ToFixed(e.used, 2) + " of its $" + jsjson.Number(e.of) + " allocation (stam's estimate)."
			}
			return l.shareLine(ctx, m, e.account, e.window)
		}}, now)
}

// AckResult is src/cost-notices.ts AckResult.
type AckResult struct {
	OK    bool   `json:"ok"`
	Event string `json:"event,omitempty"`
	Error string `json:"error,omitempty"`
}

type costAckEvent struct {
	Event string `json:"event"`
	Via   string `json:"via"`
}

// AckCostNotice is src/cost-notices.ts ack: by (an agent id, or human) handled the cost event, which stops its
// fallback; via names how (cost_ack, or the act that counted as one). A manager's ack withdraws the human's copy.
func (l *Lifecycle) AckCostNotice(ctx context.Context, eventID, by, via string) (AckResult, error) {
	before, ok, err := l.db.AckCostNotice(ctx, eventID, by, iso(time.Now()))
	if err != nil {
		return AckResult{}, err
	}
	if !ok {
		return AckResult{Error: "no cost notice " + eventID}, nil
	}
	if before.AckedAt != nil {
		return AckResult{Error: eventID + " was already acknowledged by " + deref(before.AckedBy)}, nil
	}
	if by != humanID {
		l.event(ctx, by, "cost:ack", costAckEvent{Event: eventID, Via: via})
		if before.HumanMailID != nil {
			l.settleHumanCopy(ctx, *before.HumanMailID, by, eventID)
		}
	}
	return AckResult{OK: true, Event: eventID}, nil
}

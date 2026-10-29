package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// Cost pauses (src/cost-pause.ts and src/cost-auth.ts, docs/cost-policy.md build step 12, S-2848 B4d): a manager pauses
// a tree until a subscription window resets or until a set time, and stam lifts the pause by itself.
//
// The pause is a manual cost blocker on every agent in the tree, recording who set it, why, and what clears it. As a
// blocker it pauses the agent through AddBlocker, and clearing the last one resumes it (blockers.go); this file only
// decides when the clear condition is met.
//
//	until=reset  clears when a fresh reading of the window, taken after the pause was set, reads below the percentage
//	             it had then; or, with no fresh reading, when the window's resets_at plus the rule margin passes,
//	             marked unconfirmed.
//	until=TIME   clears when the wall-clock time passes.
//
// Every reading evaluates the pauses (a peer's of the same account too), and one timer wakes them at the soonest clear
// time, so a paused tree that reports no reading still lifts. A tree also covers agents spawned into it later
// (AttachPause). Calling cost_pause acknowledges the tree's open cost notices, which stops their fallbacks.
//
// The tree is this daemon's agents: TS's walk also visits a peer's children (src/tree.ts peerChildrenOf), whose
// blockers live on the peer, so it can set nothing on them either. An until time is read as Date.parse reads the ISO
// forms (a date alone as UTC, a date and time with no offset as local time); the other forms Date.parse accepts are
// refused.

// pauseKind is src/cost-pause.ts KIND.
const pauseKind = "manual"

// maxPauseWait is the timer's longest wait in milliseconds, setTimeout's 2^31-1 (src/cost-pause.ts schedule): a
// Duration of a clear time centuries away would overflow and fire at once, again and again.
const maxPauseWait = 1<<31 - 1

// PauseOptions is src/cost-pause.ts PauseOptions: the tree root (an agent id or name), the manager (an agent id or
// human), and until ("reset" or an ISO time), account, window and reason, each nil when not given; Clear clears the
// pause early instead.
type PauseOptions struct {
	Root, By                       string
	Until, Account, Window, Reason *string
	Clear                          bool
}

// PauseResult is src/cost-pause.ts PauseResult: the agents the pause was set on or cleared from, by name, a sentence
// for what it waits for ("" when cleared), and the cost notices the call acknowledged.
type PauseResult struct {
	Root   string   `json:"root"`
	Action string   `json:"action"`
	Agents []string `json:"agents"`
	Until  string   `json:"until"`
	Acked  []string `json:"acked"`
}

// ForbiddenError is src/cost-auth.ts Forbidden: not allowed, as against a bad request; the route answers 403.
type ForbiddenError struct{ msg string }

func (e *ForbiddenError) Error() string { return e.msg }

// IsForbidden is whether err is a ForbiddenError.
func IsForbidden(err error) bool {
	var f *ForbiddenError
	return errors.As(err, &f)
}

// RemoteManager is src/cost-auth.ts RemoteManager: a manager on another machine, as a peer's forward named it (S-923).
// Boss is whether it is the chief of staff by this daemon's settings, or the assistant the peer vouches for.
type RemoteManager struct {
	Agent string
	Boss  bool
}

// mayManageTree is src/cost-auth.ts mayManageTree: the human, stam's own fallback, the executive assistant, the chief
// of staff, the root itself, or any ancestor of the root may manage the tree; anyone else may not. A manager with no row
// here may only as the remote manager the forward named: a boss, or an ancestor of the root through the parents peers
// listed.
func (l *Lifecycle) mayManageTree(ctx context.Context, by string, root db.Agent, remote *RemoteManager) bool {
	if by == humanID || by == stamActor {
		return true
	}
	a, err := l.db.GetAgent(ctx, by)
	if errors.Is(err, db.ErrNotFound) {
		return remote != nil && remote.Agent == by && (remote.Boss || l.ancestorsKnown(ctx, root)[by])
	}
	if err != nil {
		return false
	}
	if a.Kind != nil && *a.Kind == "assistant" {
		return true
	}
	if a.ID == root.ID {
		return true
	}
	if cos := l.chiefOfStaff(ctx); cos != "" && cos == a.ID {
		return true
	}
	seen := map[string]bool{}
	stack, _ := l.db.ParentsOf(ctx, root)
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[id] {
			continue
		}
		seen[id] = true
		if id == a.ID {
			return true
		}
		if p, err := l.db.GetAgent(ctx, id); err == nil {
			parents, _ := l.db.ParentsOf(ctx, p)
			stack = append(stack, parents...)
		}
	}
	return false
}

// ancestorsKnown is src/cost-auth.ts ancestorsKnown: every ancestor of root this daemon knows, through its own agents'
// parents and, past an agent it has no row for, the parents a peer listed for it.
func (l *Lifecycle) ancestorsKnown(ctx context.Context, root db.Agent) map[string]bool {
	seen := map[string]bool{}
	stack, _ := l.db.ParentsOf(ctx, root)
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[id] {
			continue
		}
		seen[id] = true
		var parents []string
		if p, err := l.db.GetAgent(ctx, id); err == nil {
			parents, _ = l.db.ParentsOf(ctx, p)
		} else {
			parents, _ = l.db.PeerParentsOf(ctx, id)
		}
		stack = append(stack, parents...)
	}
	return seen
}

// assertMayManageTree is src/cost-auth.ts assertMayManageTree: a ForbiddenError naming both when by may not manage
// root's tree.
func (l *Lifecycle) assertMayManageTree(ctx context.Context, by string, root db.Agent) error {
	return l.assertMayManageTreeAs(ctx, by, root, nil)
}

// assertMayManageTreeAs is assertMayManageTree for a manager that may be on another machine (remote).
func (l *Lifecycle) assertMayManageTreeAs(ctx context.Context, by string, root db.Agent, remote *RemoteManager) error {
	if l.mayManageTree(ctx, by, root, remote) {
		return nil
	}
	return &ForbiddenError{l.who(ctx, by) + " may not manage cost for " + root.Name + "'s tree: only the human, the chief of staff, or a manager of a tree inside its own tree may"}
}

// treeAgents is src/cost-pause.ts treeAgents: the root and its descendants, in tree order, archived ones left out.
func (l *Lifecycle) treeAgents(ctx context.Context, root db.Agent) ([]db.Agent, error) {
	var out []db.Agent
	seen := map[string]bool{}
	var walk func(id string) error
	walk = func(id string) error {
		if seen[id] {
			return nil
		}
		seen[id] = true
		if a, err := l.db.GetAgent(ctx, id); err == nil && a.Lifecycle != "archived" {
			out = append(out, a)
		}
		children, err := l.db.ChildrenOf(ctx, id)
		if err != nil {
			return err
		}
		for _, c := range children {
			if err := walk(c); err != nil {
				return err
			}
		}
		return nil
	}
	return out, walk(root.ID)
}

// accountOfTree is src/cost-pause.ts accountOfTree: the account of the first managed agent in the tree, "" for none.
func (l *Lifecycle) accountOfTree(agents []db.Agent) string {
	set := l.settings.Get()
	for _, a := range agents {
		if account := set.AccountFor(a.Harness, a.Model); account != "" {
			return account
		}
	}
	return ""
}

// manualBlocker is src/cost-pause.ts manualBlocker: the agent's manual pause, with its clear parsed; ok is false when
// it has none.
func (l *Lifecycle) manualBlocker(ctx context.Context, id string) (parsedBlocker, bool, error) {
	rows, err := l.db.BlockerRows(ctx, id)
	if err != nil {
		return parsedBlocker{}, false, err
	}
	for _, b := range rows {
		if b.Kind != pauseKind {
			continue
		}
		p := parsedBlocker{Blocker: b}
		if b.Clear != nil {
			p.clear, _ = jsjson.Parse([]byte(*b.Clear))
		}
		return p, true, nil
	}
	return parsedBlocker{}, false, nil
}

// pauseOnChain is src/cost-pause.ts pauseOnChain: the manual pause the agent's parent chain carries, if any.
func (l *Lifecycle) pauseOnChain(ctx context.Context, a db.Agent) (parsedBlocker, bool, error) {
	seen := map[string]bool{}
	stack, err := l.db.ParentsOf(ctx, a)
	if err != nil {
		return parsedBlocker{}, false, err
	}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[id] {
			continue
		}
		seen[id] = true
		p, err := l.db.GetAgent(ctx, id)
		if err != nil {
			continue
		}
		if b, ok, err := l.manualBlocker(ctx, id); err != nil || ok {
			return b, ok, err
		}
		parents, err := l.db.ParentsOf(ctx, p)
		if err != nil {
			return parsedBlocker{}, false, err
		}
		stack = append(stack, parents...)
	}
	return parsedBlocker{}, false, nil
}

type pauseInheritedEvent struct {
	Action string  `json:"action"`
	By     *string `json:"by,omitempty"`
	Reason string  `json:"reason"`
}

// AttachPause is src/cost-pause.ts attachSpawn: a new agent gets, before its launch, the pause its parent chain carries,
// so a tree stays paused for agents spawned into it while the pause holds.
//
// The chain is read again inside the agent's serial, which a cost_pause's set or clear of this agent also takes: a pause
// set or cleared since the first read wins (TS's single thread has no such gap), and one the agent already carries, from
// a cost_pause's second listing, isn't logged or set again.
func (l *Lifecycle) AttachPause(ctx context.Context, a db.Agent) error {
	if _, ok, err := l.pauseOnChain(ctx, a); err != nil || !ok {
		return err
	}
	if l.pauseAttach != nil {
		l.pauseAttach(a.ID)
	}
	return l.serial(ctx, a.ID, func(ctx context.Context) error {
		b, ok, err := l.pauseOnChain(ctx, a)
		if err != nil || !ok {
			return err
		}
		if own, has, err := l.manualBlocker(ctx, a.ID); err != nil || (has && deref(own.Clear) == deref(b.Clear)) {
			return err
		}
		e := pauseInheritedEvent{Action: "inherited", Reason: b.Reason}
		if by, ok := field(b.clear, "by").(string); ok {
			e.By = &by
		}
		l.event(ctx, a.ID, "cost:pause", e)
		_, err = l.AddBlocker(ctx, a.ID, NewBlocker{Kind: pauseKind, Reason: b.Reason, Clear: b.Clear})
		return err
	})
}

// closestWindow is src/cost-pause.ts closestWindow: the window closest to 100% among the account's fresh readings, for
// the default until=reset; ok is false when none is fresh.
func (l *Lifecycle) closestWindow(ctx context.Context, account string, now float64) (string, bool, error) {
	all, err := l.accountWindows(ctx, account, now)
	if err != nil {
		return "", false, err
	}
	type named struct {
		name string
		w    win
	}
	var cands []named
	for _, n := range all.names() {
		if w, _ := all.get(n); fresh(w.at, now) {
			cands = append(cands, named{n, w})
		}
	}
	sort.SliceStable(cands, func(i, j int) bool {
		a, b := math.Abs(100-cands[i].w.pct), math.Abs(100-cands[j].w.pct)
		if a != b {
			return a < b
		}
		return cands[i].w.pct > cands[j].w.pct
	})
	if len(cands) == 0 {
		return "", false, nil
	}
	return cands[0].name, true, nil
}

// parseUntil is Date.parse for the ISO forms: a full time with its offset, a date alone (UTC), or a date and time with
// no offset (local time). ok is false for anything else.
func parseUntil(s string) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, true
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t, true
	}
	for _, layout := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// resolveClear is src/cost-pause.ts resolveClear: the caller's until, account and window as a clear condition (its
// JSON, in TS's key order) and the pause's reason, or what is missing.
func (l *Lifecycle) resolveClear(ctx context.Context, o PauseOptions, root db.Agent, agents []db.Agent, now time.Time) (clear *jsjson.Object, reason string, err error) {
	byName := l.who(ctx, o.By)
	until := deref(o.Until)
	if until == "reset" {
		account := l.accountOfTree(agents)
		if o.Account != nil {
			account = *o.Account
		}
		if account == "" {
			return nil, "", fmt.Errorf("no cost account in %s's tree; pass account", root.Name)
		}
		wins, err := l.accountWindows(ctx, account, ms(now))
		if err != nil {
			return nil, "", err
		}
		window := deref(o.Window)
		if window == "" {
			pick, ok, err := l.closestWindow(ctx, account, ms(now))
			if err != nil {
				return nil, "", err
			}
			if !ok {
				return nil, "", fmt.Errorf("no fresh window reading on %s; pass window", account)
			}
			window = pick
		}
		var pct, resets jsjson.Value
		what := account + "'s " + window + " resets"
		if w, ok := wins.get(window); ok {
			pct = w.pct
			if w.resets != nil {
				resets = *w.resets
			}
			what = account + "'s " + window + " (at " + jsjson.Number(w.pct) + "%) resets"
		}
		clear = jsjson.NewObject("kind", "reset", "by", o.By, "after", iso(now), "account", account, "window", window, "pct", pct, "resets_at", resets)
		reason = byName + " paused the tree until " + what
	} else {
		at, ok := parseUntil(until)
		if !ok {
			shown := "undefined"
			if o.Until != nil {
				shown = quote(*o.Until)
			}
			return nil, "", fmt.Errorf("until must be \"reset\" or an ISO time, not %s", shown)
		}
		clear = jsjson.NewObject("kind", "time", "by", o.By, "after", iso(now), "until", iso(at))
		reason = byName + " paused the tree until " + iso(at)
	}
	if o.Reason != nil {
		reason = *o.Reason
	}
	return clear, reason, nil
}

// ackTree is src/cost-pause.ts ackTree: the open cost notices about the tree, those about any of its agents and the
// account-wide ones on its account, acknowledged by the acting manager; via names the tool. It returns their ids.
func (l *Lifecycle) ackTree(ctx context.Context, agents []db.Agent, by, via string) ([]string, error) {
	ids := map[string]bool{}
	for _, a := range agents {
		ids[a.ID] = true
	}
	account := l.accountOfTree(agents)
	open, err := l.db.OpenCostNotices(ctx)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, n := range open {
		if (n.AgentID != nil && ids[*n.AgentID]) || (n.AgentID == nil && account != "" && n.Account == account) {
			r, err := l.AckCostNotice(ctx, n.ID, by, via)
			if err != nil {
				return out, err
			}
			if r.OK {
				out = append(out, n.ID)
			}
		}
	}
	return out, nil
}

type pauseSetEvent struct {
	Action string          `json:"action"`
	By     string          `json:"by"`
	Reason string          `json:"reason"`
	Clear  json.RawMessage `json:"clear"`
}

type pauseClearRequested struct {
	Action    string `json:"action"`
	By        string `json:"by"`
	Requested bool   `json:"requested"`
}

type pauseClearedEvent struct {
	Action      string `json:"action"`
	Cleared     string `json:"cleared"`
	Unconfirmed bool   `json:"unconfirmed,omitempty"`
}

// dropPause is ClearBlocker for the agent's manual pause, with its cost:pause event recorded inside the agent's serial
// only when the pause is still there to drop, so a pause two callers clear at once logs one clear. With want, only the
// pause with that clear is dropped: an evaluation judges a pause outside the serial, so a new pause set since then stays.
func (l *Lifecycle) dropPause(ctx context.Context, id string, want *string, cleared string, e any) (dropped bool, err error) {
	_, err = l.clearBlocker(ctx, id, pauseKind, "", cleared, nil, func(ctx context.Context) bool {
		b, ok, err := l.manualBlocker(ctx, id)
		if err != nil || !ok || (want != nil && deref(b.Clear) != *want) {
			return false
		}
		l.event(ctx, id, "cost:pause", e)
		dropped = true
		return true
	})
	return dropped, err
}

// CostPause is src/cost-pause.ts costPause: it pauses the tree until its window resets or a set time, or clears an
// existing pause early. A permission refusal is a ForbiddenError.
func (l *Lifecycle) CostPause(ctx context.Context, o PauseOptions) (PauseResult, error) {
	root, err := l.db.GetAgent(ctx, o.Root)
	if err != nil {
		return PauseResult{}, fmt.Errorf("no agent %s", o.Root)
	}
	if err := l.assertMayManageTree(ctx, o.By, root); err != nil {
		return PauseResult{}, err
	}
	agents, err := l.treeAgents(ctx, root)
	if err != nil {
		return PauseResult{}, err
	}
	if l.pauseListed != nil {
		l.pauseListed(root.ID, false)
	}
	// As in TS, the call acknowledges the tree's notices before it checks its arguments.
	acked, err := l.ackTree(ctx, agents, o.By, "cost_pause")
	if err != nil {
		return PauseResult{}, err
	}
	names := []string{}
	if o.Clear {
		drop := func(a db.Agent) error {
			dropped, err := l.dropPause(ctx, a.ID, nil, "cleared by "+l.who(ctx, o.By), pauseClearRequested{Action: "clear", By: o.By, Requested: true})
			if dropped {
				names = append(names, a.Name)
			}
			return err
		}
		listed := map[string]bool{}
		for _, a := range agents {
			listed[a.ID] = true
			if err := drop(a); err != nil {
				return PauseResult{}, err
			}
		}
		// A spawn that landed after the tree was listed could inherit the pause from an ancestor not yet cleared. No listed
		// agent carries it now, so a later spawn inherits nothing, and listing the tree again clears the ones before.
		if l.pauseListed != nil {
			l.pauseListed(root.ID, true)
		}
		again, err := l.treeAgents(ctx, root)
		if err != nil {
			return PauseResult{}, err
		}
		for _, a := range again {
			if !listed[a.ID] {
				if err := drop(a); err != nil {
					return PauseResult{}, err
				}
			}
		}
		l.schedulePauses(ctx)
		return PauseResult{Root: root.Name, Action: "cleared", Agents: names, Acked: acked}, nil
	}
	if deref(o.Until) == "" {
		return PauseResult{}, errors.New("cost_pause needs until=reset or an ISO time, or clear")
	}
	clear, reason, err := l.resolveClear(ctx, o, root, agents, time.Now())
	if err != nil {
		return PauseResult{}, err
	}
	text := jsjson.Stringify(clear, "")
	set := func(ctx context.Context, a db.Agent) error {
		l.event(ctx, a.ID, "cost:pause", pauseSetEvent{Action: "set", By: o.By, Reason: reason, Clear: json.RawMessage(text)})
		if _, err := l.AddBlocker(ctx, a.ID, NewBlocker{Kind: pauseKind, Reason: reason, Clear: &text}); err != nil {
			return err
		}
		names = append(names, a.Name)
		return nil
	}
	listed := map[string]bool{}
	for _, a := range agents {
		listed[a.ID] = true
		if err := set(ctx, a); err != nil {
			return PauseResult{}, err
		}
	}
	// A spawn that landed after the tree was listed found no pause on its chain to inherit (TS's single thread has no such
	// gap). Every agent listed now carries the pause, so a later spawn inherits it, and listing the tree again catches the
	// ones before; one that already inherited this pause is only named.
	if l.pauseListed != nil {
		l.pauseListed(root.ID, true)
	}
	again, err := l.treeAgents(ctx, root)
	if err != nil {
		return PauseResult{}, err
	}
	// The check and the set share the agent's serial with its AttachPause, so the two never both log the pause.
	for _, a := range again {
		if listed[a.ID] {
			continue
		}
		err := l.serial(ctx, a.ID, func(ctx context.Context) error {
			if b, ok, err := l.manualBlocker(ctx, a.ID); err != nil {
				return err
			} else if ok && deref(b.Clear) == text {
				names = append(names, a.Name)
				return nil
			}
			return set(ctx, a)
		})
		if err != nil {
			return PauseResult{}, err
		}
	}
	l.schedulePauses(ctx)
	return PauseResult{Root: root.Name, Action: "paused", Agents: names, Until: reason, Acked: acked}, nil
}

// pauseCleared is src/cost-pause.ts cleared: how a pause clears now, ok false while it waits; unconfirmed marks a clear
// no fresh reading confirmed.
func (l *Lifecycle) pauseCleared(ctx context.Context, c jsjson.Value, now float64) (text string, unconfirmed, ok bool, err error) {
	if kind, _ := field(c, "kind").(string); kind == "time" {
		until := field(c, "until")
		at := dateParse(until)
		if !math.IsNaN(at) && now >= at {
			return "the set time " + claudeString(until) + " passed", false, true, nil
		}
		return "", false, false, nil
	}
	account, _ := field(c, "account").(string)
	window, _ := field(c, "window").(string)
	if account != "" && window != "" {
		all, err := l.accountWindows(ctx, account, now)
		if err != nil {
			return "", false, false, err
		}
		if w, found := all.get(window); found && fresh(w.at, now) && w.at > dateParse(field(c, "after")) {
			old := 100.0
			if p, isNum := field(c, "pct").(float64); isNum {
				old = p
			}
			if w.pct < old {
				return "a fresh reading of " + window + " on " + account + " is " + jsjson.Number(w.pct) + "%, below the " + jsjson.Number(old) + "% when it was paused", false, true, nil
			}
		}
	}
	if resets, isNum := field(c, "resets_at").(float64); isNum && now >= resets*1000+l.margin() {
		return "the " + window + " window on " + account + " reset (" + isoMs(resets*1000) + ") and no fresh reading confirmed it", true, true, nil
	}
	return "", false, false, nil
}

// claudeString is String(v) for a parsed JSON value.
func claudeString(v jsjson.Value) string {
	if s, ok := v.(string); ok {
		return s
	}
	return jsjson.Stringify(v, "")
}

// EvaluatePauses is src/cost-pause.ts evaluatePauses: every manual pause whose clear condition is met is lifted, then
// the timer is set for the next. It runs on every reading, at each pause's clear time, and once at daemon start.
func (l *Lifecycle) EvaluatePauses(ctx context.Context, now time.Time) {
	all, err := l.db.ListAgents(ctx)
	if err != nil {
		slog.Error("cost pauses", "err", err)
	}
	for _, a := range all {
		b, ok, err := l.manualBlocker(ctx, a.ID)
		if err != nil || !ok || b.clear == nil {
			continue
		}
		text, unconfirmed, ok, err := l.pauseCleared(ctx, b.clear, ms(now))
		if err != nil {
			slog.Error("cost pauses", "agent", a.ID, "err", err)
			continue
		}
		if !ok {
			continue
		}
		if l.pauseJudged != nil {
			l.pauseJudged(a.ID)
		}
		if _, err := l.dropPause(ctx, a.ID, b.Clear, text, pauseClearedEvent{Action: "clear", Cleared: text, Unconfirmed: unconfirmed}); err != nil {
			slog.Error("cost pauses", "agent", a.ID, "err", err)
		}
	}
	l.schedulePauses(ctx)
}

// schedulePauses is src/cost-pause.ts schedule: one timer, at the soonest clear time of a stored pause (a set time, or
// a window's reset plus the margin). Its read and its timer run under pauseMu, so a schedule that read before a new
// pause can't replace the timer one that read after it set.
func (l *Lifecycle) schedulePauses(ctx context.Context) {
	l.pauseMu.Lock()
	defer l.pauseMu.Unlock()
	if l.pauseTimer != nil {
		l.pauseTimer.Stop()
		l.pauseTimer = nil
	}
	all, err := l.db.ListAgents(ctx)
	if err != nil {
		slog.Error("cost pauses: schedule", "err", err)
		return
	}
	due := math.Inf(1)
	for _, a := range all {
		b, ok, err := l.manualBlocker(ctx, a.ID)
		if err != nil || !ok || b.clear == nil {
			continue
		}
		if kind, _ := field(b.clear, "kind").(string); kind == "time" {
			if at := dateParse(field(b.clear, "until")); !math.IsNaN(at) {
				due = math.Min(due, at)
			}
		} else if resets, isNum := field(b.clear, "resets_at").(float64); isNum {
			due = math.Min(due, resets*1000+l.margin())
		}
	}
	if math.IsInf(due, 1) || l.ctx.Err() != nil {
		return
	}
	// Capped at setTimeout's longest wait, as TS's is: a later clear time is evaluated early, finds nothing to clear and
	// sets the timer again.
	wait := time.Duration(math.Min(math.Max(0, due-ms(time.Now())), maxPauseWait)) * time.Millisecond
	l.pauseWait = wait
	l.pauseTimer = time.AfterFunc(wait, func() {
		l.goBG(func(ctx context.Context) { l.EvaluatePauses(ctx, time.Now()) })
	})
}

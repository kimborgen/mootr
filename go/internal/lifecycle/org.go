package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"regexp"
	"strconv"
	"sync"
	"time"

	"stam/internal/clock"
	"stam/internal/db"
)

// The org observers (src/org.ts watchActivity, S-2848 B2b): what an agent's activity change tells the agents above it.
// A blocked or errored agent tells its parents (else the chief of staff, else the human); a finished turn tells the
// parents that hear every turn; a subtree that went quiet tells the parents that hear tree-idle, once per idle period
// (idle_notified); and every change recomputes the 'children' waits up the tree.
//
// The db hands each change to observeOrg once its write commits; one goroutine handles them in order, so no two settles
// interleave and no handler runs inside a write. A settle's own writes carry the agents it settles in their context,
// and their changes are dropped, as TS's `settling` drops them: the settle counts those flips itself.
//
// A parent on another machine gets its notice through its daemon (deliver, off the org goroutine), retried while that
// machine doesn't answer.

type settlingKey struct{}

func settlingOf(ctx context.Context) map[string]bool {
	s, _ := ctx.Value(settlingKey{}).(map[string]bool)
	return s
}

// observeOrg is the db's activity observer: it queues the change for the org goroutine.
func (l *Lifecycle) observeOrg(ctx context.Context, c db.ActivityChange) {
	if settlingOf(ctx)[c.ID] {
		return
	}
	l.orgMu.Lock()
	l.orgQueue = append(l.orgQueue, c)
	l.orgMu.Unlock()
	select {
	case l.orgWake <- struct{}{}:
	default:
	}
}

// TellPeer delivers a notice to an agent this daemon doesn't hold (the server's tellWhere): "told", "absent" (no
// machine has it) or "unreachable"; an error is a refusal. want is the child-notices mode the agent must have, or "".
type TellPeer func(ctx context.Context, id, text, want string) (string, error)

// SetTellPeer sets how the org observers reach a parent on another machine.
func (l *Lifecycle) SetTellPeer(fn TellPeer) {
	l.orgMu.Lock()
	defer l.orgMu.Unlock()
	l.tellPeer = fn
}

// SetOwnerStopped sets what hears that an agent stopped (src/itsa-owners.ts watchOwnerStops): the server, which tells
// the owner of each parent ITSA of the ITSAs it holds. what is "was shut down" or "errored".
func (l *Lifecycle) SetOwnerStopped(fn func(ctx context.Context, id, name, what string)) {
	l.orgMu.Lock()
	defer l.orgMu.Unlock()
	l.ownerStopped = fn
}

// SetUnown sets what unowns an agent's ITSAs before a forget (src/itsa-owners.ts unownAgent): the server, which hands
// them to the agent's heir or leaves them unowned. how is "forgotten" or "archived".
func (l *Lifecycle) SetUnown(fn func(ctx context.Context, a db.Agent, how string) error) {
	l.orgMu.Lock()
	defer l.orgMu.Unlock()
	l.unown = fn
}

// SetAgentGone sets what drops an archived agent's event subscriptions and deliveries (S-4317): the server's event
// service. It runs after the agent is marked archived (or forgotten) and its notices are dropped, with no lifecycle lock held, since it
// waits for a delivery in flight.
func (l *Lifecycle) SetAgentGone(fn func(ctx context.Context, id string)) {
	l.orgMu.Lock()
	defer l.orgMu.Unlock()
	l.agentGone = fn
}

// tellAgentGone runs the hook SetAgentGone set, for an agent archived or forgotten, with no lifecycle lock held.
func (l *Lifecycle) tellAgentGone(ctx context.Context, id string) {
	l.orgMu.Lock()
	gone := l.agentGone
	l.orgMu.Unlock()
	if gone != nil {
		gone(ctx, id)
	}
}

// SetStartingDead sets what hears that an agent never started (src/lifecycle.ts startingDeadListeners, S-3070): the
// server, whose rings drop it, which lifecycle can't import (a ring may fall back to spawning a reviewer). It is called
// once the agent is marked stopped and its parent told, before a pending action runs.
func (l *Lifecycle) SetStartingDead(fn func(ctx context.Context, a db.Agent)) {
	l.orgMu.Lock()
	defer l.orgMu.Unlock()
	l.startingDead = fn
}

// reportStop hands an agent's stop to SetOwnerStopped's hook, off the org goroutine.
func (l *Lifecycle) reportStop(id, name, what string) {
	l.orgMu.Lock()
	fn := l.ownerStopped
	l.orgMu.Unlock()
	if fn != nil {
		l.goBG(func(ctx context.Context) { fn(ctx, id, name, what) })
	}
}

// shutDownRestart is the activity detail of a shutdown that is a restart or an archive in progress, not a stop.
var shutDownRestart = regexp.MustCompile(`^(restarting|archiving)`)

// onLifecycle is src/itsa-owners.ts's lifecycle observer: an owner that was shut down tells its ITSAs' parent owners.
// A restart or an archive in progress is no stop, nor a shutdown for a compaction (S-273), which is resumed right after;
// an error that also shuts the agent down (a failed launch) is told once, by the activity observer.
func (l *Lifecycle) onLifecycle(c db.ActivityChange) {
	if c.After != "shut_down" || c.Activity == "errored" || shutDownRestart.MatchString(deref(c.Detail)) {
		return
	}
	if p, ok := waitData(c.PendingAction); ok && get(p, "type") == "recover" && ptruthy(p, "compact") {
		return
	}
	l.reportStop(c.ID, c.Name, "was shut down")
}

// SetMailHuman sets how the org observers mail the human, for an agent with no parent and no chief of staff: the
// server's send, as stam's own mail from the agent.
func (l *Lifecycle) SetMailHuman(fn func(ctx context.Context, from, subject, body string) error) {
	l.orgMu.Lock()
	defer l.orgMu.Unlock()
	l.mailHuman = fn
}

// StartOrg is src/daemon.ts's org start: the waits stam derives rebuilt (before any observer, so the rebuild tells
// nobody), then the observer installed, then the tree-idle notices owed since the daemon went down, then the changes
// as they come.
func (l *Lifecycle) StartOrg() {
	if err := l.rebuildWaits(l.ctx); err != nil {
		slog.Error("org: rebuild waits", "err", err)
	}
	l.db.ObserveActivity(l.observeOrg)
	// Busy until the recovery below is done, so orgSettled waits for it.
	l.orgMu.Lock()
	l.orgBusy = true
	l.orgMu.Unlock()
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		defer l.db.ObserveActivity(nil)
		if err := l.recoverTreeIdle(l.ctx); err != nil && l.ctx.Err() == nil {
			slog.Error("org: recover tree-idle", "err", err)
		}
		for {
			l.orgMu.Lock()
			queue := l.orgQueue
			l.orgQueue = nil
			l.orgBusy = len(queue) > 0
			l.orgMu.Unlock()
			for _, c := range queue {
				if l.ctx.Err() != nil {
					return
				}
				if err := l.handleOrg(l.ctx, c); err != nil && l.ctx.Err() == nil {
					slog.Error("org", "agent", c.ID, "change", c.Kind, "err", err)
				}
			}
			l.orgMu.Lock()
			l.orgBusy = false
			idle := len(l.orgQueue) == 0
			l.orgMu.Unlock()
			if !idle {
				continue
			}
			select {
			case <-l.ctx.Done():
				return
			case <-l.orgWake:
			}
		}
	}()
}

// orgSettled is whether the org goroutine has nothing queued or running (for tests).
func (l *Lifecycle) orgSettled() bool {
	l.orgMu.Lock()
	defer l.orgMu.Unlock()
	return len(l.orgQueue) == 0 && !l.orgBusy
}

func (l *Lifecycle) handleOrg(ctx context.Context, c db.ActivityChange) error {
	switch c.Kind {
	case "activity":
		return l.onActivity(ctx, c)
	case "resting-waits":
		// A resting agent's waits changed (S-1982): recount above it, and announce what going quiet owes.
		if err := l.syncChildrenWaits(ctx, c.ID); err != nil {
			return err
		}
		a, err := l.db.GetAgent(ctx, c.ID)
		if err != nil {
			return ignoreGone(err)
		}
		if busy, err := l.db.IsBusy(ctx, a); err != nil || busy {
			return err
		}
		return l.announceTreeIdle(ctx, a)
	case "lifecycle":
		l.onLifecycle(c)
	case "sync":
		// The agent's parents changed (set-parent, an archive's reparent): its children wait and every ancestor's, as
		// src/daemon.ts control and src/lifecycle.ts cascadeChildren call syncChildrenWaits.
		return l.syncChildrenWaits(ctx, c.ID)
	case "resync":
		// A child was forgotten (Forget), or the agent's permission requests changed (OrgResync): its children wait and
		// what going quiet owes, as src/daemon.ts forget and src/permissions.ts do.
		if err := l.syncChildrenWaits(ctx, c.ID); err != nil {
			return err
		}
		a, err := l.db.GetAgent(ctx, c.ID)
		if err != nil {
			return ignoreGone(err)
		}
		return l.announceTreeIdle(ctx, a)
	case "peer-busy":
		// A peer agent turned busy or quiet: the children waits above it follow, and a local ancestor whose subtree
		// went quiet owes its notice (src/org.ts peerBusyChanged).
		if err := l.syncChildrenWaits(ctx, c.ID); err != nil {
			return err
		}
		parents, err := l.db.ParentMap(ctx)
		if err != nil {
			return err
		}
		for _, pid := range ancestorsIn(parents, c.ID) {
			p, err := l.db.GetAgent(ctx, pid)
			if errors.Is(err, db.ErrNotFound) {
				continue
			}
			if err != nil {
				return err
			}
			if err := l.announceTreeIdle(ctx, p); err != nil {
				return err
			}
		}
	}
	return nil
}

func ignoreGone(err error) error {
	if errors.Is(err, db.ErrNotFound) {
		return nil
	}
	return err
}

// onActivity is src/org.ts's onActivityChange observer.
func (l *Lifecycle) onActivity(ctx context.Context, c db.ActivityChange) error {
	a, err := l.db.GetAgent(ctx, c.ID)
	if err != nil {
		return ignoreGone(err)
	}
	detail := deref(c.Detail)
	if c.Before != "errored" && c.After == "errored" {
		l.reportStop(c.ID, c.Name, "errored")
	}
	switch {
	case c.After == "blocked":
		err = l.trouble(ctx, a, c.Name, "agent-blocked", c.Name+" is blocked", detail)
	case c.After == "errored":
		err = l.trouble(ctx, a, c.Name, "agent-errored", c.Name+" errored", detail)
	case c.Before == "working" && c.Requested == "idle" && c.RequestedDetail != nil && *c.RequestedDetail == "turn finished":
		// A turn that ended with open waits ends in 'waiting', but it is still a finished turn. A parent set to "turn"
		// hears now; "tree-idle" waits for the whole subtree below.
		var text string
		if text, err = l.render("child-turn-finished", map[string]string{"child": c.Name, "last": lastMessage(c.LastMessage)}); err != nil {
			break
		}
		text += "\n" + noticeClock(a, false)
		var parents []string
		if parents, err = l.db.ParentsOf(ctx, a); err != nil {
			break
		}
		for _, p := range parents {
			if err = l.tell(ctx, a, p, text, "turn"); err != nil {
				break
			}
		}
	}
	if err != nil {
		return err
	}
	// Going idle or errored can be the last descendant a pending ancestor waited on.
	if c.After == "idle" || c.After == "errored" {
		if err := l.announceTreeIdle(ctx, a); err != nil {
			return err
		}
	}
	// Any activity change moves this agent into or out of a parent's busy subtree.
	return l.syncChildrenWaits(ctx, c.ID)
}

// trouble is src/org.ts trouble: who hears about an agent's trouble. Its parents, here or on another machine; with
// none, the chief of staff; without one, the human. A parent on a machine that doesn't answer is still its parent: only
// when every parent is gone everywhere (absent) does the agent fall back.
func (l *Lifecycle) trouble(ctx context.Context, a db.Agent, name, template, subject, detail string) error {
	parents, err := l.db.ParentsOf(ctx, a)
	if err != nil {
		return err
	}
	text, err := l.render(template, map[string]string{"agent": name, "relation": "your child", "detail": detail})
	if err != nil {
		return err
	}
	text += "\n" + noticeClock(a, false)
	fallback, err := l.render(template, map[string]string{"agent": name, "relation": "an agent without a parent", "detail": detail})
	if err != nil {
		return err
	}
	fallback += "\n" + noticeClock(a, false)
	var away []string
	for _, p := range parents {
		if _, err := l.db.GetAgent(ctx, p); err == nil {
			l.QueueNotice(ctx, p, text, false)
		} else if errors.Is(err, db.ErrNotFound) {
			away = append(away, p)
		} else {
			return err
		}
	}
	here := len(parents) - len(away)
	if len(away) == 0 {
		if here == 0 {
			l.troubleFallback(ctx, a, subject, fallback)
		}
		return nil
	}
	l.goBG(func(ctx context.Context) {
		if l.deliverAll(ctx, a.ID, away, text, "") == "absent" && here == 0 {
			l.troubleFallback(ctx, a, subject, fallback)
		}
	})
	return nil
}

// troubleFallback tells the chief of staff about an agent with no parent, else mails the human.
func (l *Lifecycle) troubleFallback(ctx context.Context, a db.Agent, subject, text string) {
	if cos := l.chiefOfStaff(ctx); cos != "" && cos != a.ID {
		l.QueueNotice(ctx, cos, text, false)
		return
	}
	l.orgMu.Lock()
	mail := l.mailHuman
	l.orgMu.Unlock()
	if mail == nil {
		slog.Warn("org: no way to mail the human", "agent", a.ID, "subject", subject)
		return
	}
	if err := mail(ctx, a.ID, subject, text); err != nil {
		slog.Error("org: mail the human", "agent", a.ID, "err", err)
	}
}

// tell is src/org.ts tell: a notice for a parent here, when its child-notices mode is want ("" for any), or delivered
// to the daemon that has it, which checks want on its own record.
func (l *Lifecycle) tell(ctx context.Context, child db.Agent, parent, text, want string) error {
	p, err := l.db.GetAgent(ctx, parent)
	if errors.Is(err, db.ErrNotFound) {
		l.goBG(func(ctx context.Context) { l.deliver(ctx, child.ID, parent, text, want) })
		return nil
	}
	if err != nil {
		return err
	}
	if want == "" || l.childNoticesOf(p) == want {
		l.QueueNotice(ctx, p.ID, text, false)
	}
	return nil
}

// goBG runs fn off the org goroutine, counted in the daemon's background work; nothing once Wait began.
func (l *Lifecycle) goBG(fn func(ctx context.Context)) { l.tryBG(fn) }

// tryBG is goBG, saying whether fn will run: false once the daemon stopped, so a caller holding something for fn can
// let it go.
func (l *Lifecycle) tryBG(fn func(ctx context.Context)) bool {
	l.mu.Lock()
	if l.waited || l.ctx.Err() != nil {
		l.mu.Unlock()
		return false
	}
	l.bg.Add(1)
	l.bgRunning.Add(1)
	l.mu.Unlock()
	go func() {
		defer l.bg.Done()
		defer l.bgRunning.Add(-1)
		fn(l.ctx)
	}()
	return true
}

// Go runs fn in the daemon's background work, which Wait waits for; nothing once Wait began.
func (l *Lifecycle) Go(fn func(ctx context.Context)) { l.goBG(fn) }

// peerRetryFor is how long deliver keeps trying a machine that doesn't answer (src/org.ts RETRY_FOR_MS).
const peerRetryFor = 24 * time.Hour

type noticeFailedEvent struct {
	Parent string `json:"parent"`
	Text   string `json:"text"`
	Error  string `json:"error"`
}

// deliver is src/org.ts deliver: a notice for an agent on another machine, retried every STAM_PEER_RETRY_MS (30 s)
// while its machine doesn't answer, for up to a day. "told", "absent", or "failed" when it never got through or was
// refused, which is logged and recorded as an `org:notice-failed` event on the child.
func (l *Lifecycle) deliver(ctx context.Context, child, parent, text, want string) string {
	l.orgMu.Lock()
	tellPeer, retryFor := l.tellPeer, l.peerRetryFor
	l.orgMu.Unlock()
	if retryFor <= 0 {
		retryFor = peerRetryFor
	}
	every := 30 * time.Second
	if ms, err := strconv.Atoi(os.Getenv("STAM_PEER_RETRY_MS")); err == nil && ms > 0 {
		every = time.Duration(ms) * time.Millisecond
	}
	failed := func(why string) string {
		slog.Error("org: notice for a parent on another machine", "agent", child, "parent", parent, "err", why)
		l.event(context.WithoutCancel(ctx), child, "org:notice-failed", noticeFailedEvent{Parent: parent, Text: sliceUTF16(text, 120), Error: why})
		return "failed"
	}
	if tellPeer == nil {
		return failed("this daemon has no way to reach another machine")
	}
	for start := time.Now(); time.Since(start) < retryFor; {
		r, err := tellPeer(ctx, parent, text, want)
		if err != nil {
			return failed(err.Error())
		}
		if r != "unreachable" {
			return r
		}
		select {
		case <-ctx.Done():
			return failed("the daemon stopped before its machine answered")
		case <-time.After(every):
		}
	}
	return failed("its machine didn't answer for " + retryFor.String() + "; dropped")
}

// deliverAll delivers to each parent at once: "failed" when any failed, "absent" when every one is absent, else "told".
func (l *Lifecycle) deliverAll(ctx context.Context, child string, parents []string, text, want string) string {
	out := make([]string, len(parents))
	var wg sync.WaitGroup
	for i, p := range parents {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out[i] = l.deliver(ctx, child, p, text, want)
		}()
	}
	wg.Wait()
	all := "absent"
	for _, r := range out {
		if r == "failed" {
			return "failed"
		}
		if r != "absent" {
			all = "told"
		}
	}
	return all
}

// childNoticesOf is src/org.ts childNoticesOf: the parent's own setting, else settings.childNotices.
func (l *Lifecycle) childNoticesOf(a db.Agent) string {
	if a.ChildNotices != nil {
		switch v := string(*a.ChildNotices); v {
		case "turn", "tree-idle", "none":
			return v
		}
	}
	return l.settings.Get().ChildNotices
}

var jsSpace = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// lastMessage is src/org.ts lastMessage: the agent's last message on one line, at most 600 UTF-16 units.
func lastMessage(m *string) string {
	s := "(not reported)"
	if m != nil {
		s = *m
	}
	return sliceUTF16(jsSpace.ReplaceAllString(s, " "), 600)
}

// span is src/org.ts span: a duration as a short age, 14s, 14m, 2h 5m, 3d 4h.
func span(d time.Duration) string {
	s := max(int64(d/time.Second), 0)
	if s < 60 {
		return strconv.FormatInt(s, 10) + "s"
	}
	m := s / 60
	if m < 60 {
		return strconv.FormatInt(m, 10) + "m"
	}
	h := m / 60
	if h < 24 {
		return strconv.FormatInt(h, 10) + "h " + strconv.FormatInt(m%60, 10) + "m"
	}
	return strconv.FormatInt(h/24, 10) + "d " + strconv.FormatInt(h%24, 10) + "h"
}

// noticeClock is src/org.ts noticeClock (S-3468): the line a child notice ends with, the daemon's now to the minute and
// the child's age since its spawn. A tree-idle notice (idle) also says how long the child has been idle, from its stored
// idle_since, when that is set. All of it comes from the stored rows.
func noticeClock(a db.Agent, idle bool) string {
	at := clock.Now()
	line := "now " + at.UTC().Format("2006-01-02T15:04") + "Z · child age " + span(at.Sub(stamp(a.CreatedAt, at)))
	if idle && a.IdleSince != nil && *a.IdleSince != "" {
		line += " · idle " + span(at.Sub(stamp(*a.IdleSince, at)))
	}
	return line
}

// stamp parses an ISO time from a row; one it can't read counts as now, so its span is 0.
func stamp(s string, now time.Time) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return now
	}
	return t
}

// ancestorsIn is src/tree.ts ancestorsIn: every agent above id in parents, each once, nearest first.
func ancestorsIn(parents map[string][]string, id string) []string {
	seen := map[string]bool{}
	var out []string
	for i := -1; i < len(out); i++ {
		at := id
		if i >= 0 {
			at = out[i]
		}
		for _, p := range parents[at] {
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}

// busyCounts is src/tree.ts busyDescendantCounts: each agent's busy descendants, local and on peers, each counted once.
func (l *Lifecycle) busyCounts(ctx context.Context, parents map[string][]string) (map[string]int, error) {
	busy, err := l.db.BusyIDs(ctx)
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for _, b := range busy {
		for _, p := range ancestorsIn(parents, b) {
			counts[p]++
		}
	}
	return counts, nil
}

func isChildrenWait(w db.Wait) bool {
	return w.Kind == "children" && w.Target == nil && w.Source == "stam"
}

// syncChildrenWait is src/org.ts syncChildrenWait: the one 'children' wait for the agent, present while n agents below
// it are busy, with them counted in its detail. What it changed: "added", "cleared", "updated", or "".
func (l *Lifecycle) syncChildrenWait(ctx context.Context, id string, n int) (string, error) {
	ws, err := l.db.ListWaits(ctx, id)
	if err != nil {
		return "", err
	}
	var w *db.Wait
	for i := range ws {
		if isChildrenWait(ws[i]) {
			w = &ws[i]
			break
		}
	}
	if n == 0 {
		if w == nil {
			return "", nil
		}
		_, err := l.db.ClearWaits(ctx, id, "children", nil)
		return "cleared", err
	}
	detail := strconv.Itoa(n) + " children"
	if n == 1 {
		detail = "1 child"
	}
	switch {
	case w == nil:
		_, err = l.db.AddWait(ctx, db.NewWait{AgentID: id, Kind: "children", Source: "stam", Detail: &detail})
		return "added", err
	case deref(w.Detail) != detail || w.Detail == nil:
		return "updated", l.db.UpdateWaitDetail(ctx, w.ID, &detail)
	}
	return "", nil
}

// syncChildrenWaits is src/org.ts syncChildrenWaits: id's 'children' wait and every ancestor's, from one count of
// every agent's busy descendants. A wait it adds or clears can flip that agent between idle and waiting, one busy
// agent more or less for everyone above it: their counts move by one and they are settled again here. Then the agents
// this turned quiet, and everyone above them, are announced.
func (l *Lifecycle) syncChildrenWaits(ctx context.Context, id string) error {
	if settlingOf(ctx)[id] {
		return nil
	}
	parents, err := l.db.ParentMap(ctx)
	if err != nil {
		return err
	}
	counts, err := l.busyCounts(ctx, parents)
	if err != nil {
		return err
	}
	order := append([]string{id}, ancestorsIn(parents, id)...)
	due := map[string]bool{}
	settling := map[string]bool{}
	for k := range settlingOf(ctx) {
		settling[k] = true
	}
	for _, x := range order {
		due[x] = true
		settling[x] = true
	}
	sctx := context.WithValue(ctx, settlingKey{}, settling)
	var quiet []string
	quietSeen := map[string]bool{}
	addQuiet := func(x string) {
		if !quietSeen[x] {
			quietSeen[x] = true
			quiet = append(quiet, x)
		}
	}
	// The bound stops a cycle of agents that keep each other waiting, as in rebuildWaits.
	budget := len(order) * 50
	for len(order) > 0 {
		if budget--; budget < 0 {
			break
		}
		x := order[0]
		order = order[1:]
		delete(due, x)
		before, err := l.db.GetAgent(sctx, x)
		if errors.Is(err, db.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		changed, err := l.syncChildrenWait(sctx, x, counts[x])
		if err != nil {
			return err
		}
		if changed == "" {
			continue
		}
		now, err := l.db.GetAgent(sctx, x)
		if err != nil {
			return err
		}
		pending, err := l.db.HasPendingPermission(sctx, x)
		if err != nil {
			return err
		}
		var step int
		if db.RestOwned(now) {
			// A resting agent's activity stays as it was; it is busy while it has a wait. Only the children wait
			// changed, so its other waits are the ones it had before.
			ws, err := l.db.ListWaits(sctx, x)
			if err != nil {
				return err
			}
			n := len(ws)
			wasBusy := n > 0
			switch changed {
			case "added":
				wasBusy = n > 1
			case "cleared":
				wasBusy = true
			}
			if (n > 0) == wasBusy || pending {
				continue
			}
			step = -1
			if n > 0 {
				step = 1
			}
		} else {
			if now.Activity == before.Activity || pending {
				continue
			}
			step = -1
			if now.Activity == "waiting" {
				step = 1
			}
		}
		if step < 0 {
			addQuiet(x)
		}
		for _, p := range ancestorsIn(parents, x) {
			counts[p] += step
			if !due[p] {
				due[p] = true
				order = append(order, p)
			}
			if step < 0 {
				addQuiet(p)
			}
		}
	}
	return l.announceTreeIdleOf(ctx, quiet)
}

// ancestors is src/org.ts ancestors: every parent above the agent, walking only through agents here; a parent on
// another machine is listed but not walked above.
func (l *Lifecycle) ancestors(ctx context.Context, a db.Agent, seen map[string]bool, out *[]string) error {
	parents, err := l.db.ParentsOf(ctx, a)
	if err != nil {
		return err
	}
	for _, p := range parents {
		if seen[p] {
			continue
		}
		seen[p] = true
		*out = append(*out, p)
		pa, err := l.db.GetAgent(ctx, p)
		if errors.Is(err, db.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if err := l.ancestors(ctx, pa, seen, out); err != nil {
			return err
		}
	}
	return nil
}

// announceTreeIdle is src/org.ts announceTreeIdle: the agent and each ancestor.
func (l *Lifecycle) announceTreeIdle(ctx context.Context, a db.Agent) error {
	ids := []string{a.ID}
	if err := l.ancestors(ctx, a, map[string]bool{}, &ids); err != nil {
		return err
	}
	return l.announceTreeIdleOf(ctx, ids)
}

// needsTreeIdleNotice is src/org.ts needsTreeIdleNotice: an idle agent (or a resting one with no wait) finished a turn
// its parents haven't heard about (idle_notified differs from idle_since), and holds no pending permission request.
func (l *Lifecycle) needsTreeIdleNotice(ctx context.Context, a db.Agent) (bool, error) {
	quiet := a.Lifecycle == "active" && a.Activity == "idle"
	if !quiet && db.RestOwned(a) {
		busy, err := l.db.IsBusy(ctx, a)
		if err != nil {
			return false, err
		}
		quiet = !busy
	}
	if !quiet || a.IdleSince == nil || *a.IdleSince == "" || (a.IdleNotified != nil && *a.IdleNotified == *a.IdleSince) {
		return false, nil
	}
	pending, err := l.db.HasPendingPermission(ctx, a.ID)
	return !pending, err
}

// announceTreeIdleOf is src/org.ts announceTreeIdleOf: for each agent here owed a tree-idle notice whose subtree is
// quiet, the notice to its parents that hear tree-idle, and idle_notified set so it goes once. With a parent on another
// machine, the turn counts as told once that machine has the notice: a failed delivery leaves it owed for the next
// start (recoverTreeIdle), and while one is on its way a repeat call sends nothing, to local parents included.
func (l *Lifecycle) announceTreeIdleOf(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	parents, err := l.db.ParentMap(ctx)
	if err != nil {
		return err
	}
	var counts map[string]int
	for _, id := range ids {
		a, err := l.db.GetAgent(ctx, id)
		if errors.Is(err, db.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		owed, err := l.needsTreeIdleNotice(ctx, a)
		if err != nil || !owed {
			if err != nil {
				return err
			}
			continue
		}
		// Counted once the first agent is owed one: a write since (an earlier notice's) changes no busy-ness.
		if counts == nil {
			if counts, err = l.busyCounts(ctx, parents); err != nil {
				return err
			}
		}
		if counts[id] > 0 {
			continue
		}
		text, err := l.render("child-turn-finished", map[string]string{"child": a.Name, "last": lastMessage(a.LastMessage)})
		if err != nil {
			return err
		}
		text += "\n" + noticeClock(a, true)
		ps, err := l.db.ParentsOf(ctx, a)
		if err != nil {
			return err
		}
		key := a.ID + " " + *a.IdleSince
		l.orgMu.Lock()
		pending := l.treeIdlePending[key]
		l.orgMu.Unlock()
		if pending {
			continue
		}
		var away []string
		for _, p := range ps {
			if _, err := l.db.GetAgent(ctx, p); errors.Is(err, db.ErrNotFound) {
				away = append(away, p)
			} else if err != nil {
				return err
			} else if err := l.tell(ctx, a, p, text, "tree-idle"); err != nil {
				return err
			}
		}
		if len(away) == 0 {
			if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "idle_notified", Val: *a.IdleSince}); err != nil {
				return err
			}
			continue
		}
		l.orgMu.Lock()
		if l.treeIdlePending == nil {
			l.treeIdlePending = map[string]bool{}
		}
		l.treeIdlePending[key] = true
		l.orgMu.Unlock()
		since := *a.IdleSince
		l.goBG(func(ctx context.Context) {
			r := l.deliverAll(ctx, a.ID, away, text, "tree-idle")
			l.orgMu.Lock()
			delete(l.treeIdlePending, key)
			l.orgMu.Unlock()
			if r == "failed" {
				return
			}
			// Told only for the idle period it was about.
			if now, err := l.db.GetAgent(ctx, a.ID); err == nil && now.IdleSince != nil && *now.IdleSince == since {
				if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "idle_notified", Val: since}); err != nil {
					slog.Error("org: mark a tree-idle notice told", "agent", a.ID, "err", err)
				}
			}
		})
	}
	return nil
}

// recoverTreeIdle is src/org.ts recoverTreeIdle: after a restart, every agent once, for the notices a subtree that went
// quiet while the daemon was down still owes.
func (l *Lifecycle) recoverTreeIdle(ctx context.Context) error {
	all, err := l.db.ListAgents(ctx)
	if err != nil {
		return err
	}
	for _, a := range all {
		if err := l.announceTreeIdle(ctx, a); err != nil {
			return err
		}
	}
	return nil
}

package lifecycle

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"stam/internal/db"
)

// A start that never reaches a turn (S-3250, src/lifecycle.ts settleStart, startStalled and restartStalledStart). A
// promptless launch whose SessionStart hook was lost (a daemon restart right after the resume) settles at its prompt
// once no launch of it runs here; any other start still 'starting' with a live pane past settings.stuckStartMinutes is
// restarted once, then errored. Both are checked by reconcile, and both run in the agent's serial.

// startMarks are the events a harness start leaves: the clock and the count of the stuck-start check read them.
var startMarks = []string{"spawn", "resume", "starting:restart"}

type startingSettledEvent struct {
	Detail *string `json:"detail"`
}

type startingRestartEvent struct {
	Minutes float64 `json:"minutes"`
	Detail  *string `json:"detail"`
}

type startingStuckEvent struct {
	Restarted bool    `json:"restarted"`
	Minutes   float64 `json:"minutes"`
}

// settleStart is src/lifecycle.ts settleStart: a 'starting' agent with a live pane, no launch of it in flight here and its
// harness at an empty prompt goes idle, as SessionStart would take it, and its mail goes in. It does only what
// SessionStart does (no pending action runs), and only for an agent restartable says it may restart. Whether it settled.
func (l *Lifecycle) settleStart(ctx context.Context, a db.Agent, paneAlive bool) bool {
	// The cheap checks first, so a tick takes the agent's serial only for a start that may settle.
	if !settleCandidate(a, paneAlive) || l.launchingNow(a.ID) {
		return false
	}
	settled := false
	err := l.serial(ctx, a.ID, func(ctx context.Context) error {
		cur, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return err
		}
		if !settleCandidate(cur, paneAlive) || l.launchingNow(cur.ID) {
			return nil
		}
		if !l.restartable(ctx, cur) || !l.atPrompt(ctx, cur) {
			return nil
		}
		l.event(ctx, cur.ID, "starting:settled", startingSettledEvent{Detail: cur.ActivityDetail})
		l.update(ctx, cur.ID, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "ready"})
		l.SchedulePush(cur.ID)
		settled = true
		return nil
	})
	return err == nil && settled
}

// settleCandidate is the part of settleStart's check that reads only the agent row: a starting agent with a live pane
// and no prompt still to go in.
func settleCandidate(a db.Agent, paneAlive bool) bool {
	return a.Activity == "starting" && (a.ActivityDetail == nil || *a.ActivityDetail != "with prompt") && paneAlive
}

// restartable is src/lifecycle.ts restartable: the watchdog and the settle act only on an active agent that is not held,
// not taken over, has no pending stop and is not compacting.
func (l *Lifecycle) restartable(ctx context.Context, a db.Agent) bool {
	if a.Lifecycle != "active" || l.isHeld(ctx, a) || l.compactionRunning(a.ID) || pendingStop(a) != nil {
		return false
	}
	_, taken := l.takenOverBy(ctx, a)
	return !taken
}

// startStalled is src/lifecycle.ts startStalled (S-3250): past settings.stuckStartMinutes since its last start (or
// its last update), still 'starting' with a live pane, the agent is due a restart. A paused, held, taken-over or
// compacting agent, one with a pending stop, or one on another machine is left alone, and so is a launch still in
// its afterLaunch here until twice the bound, so a slow but live start is not restarted under itself.
func (l *Lifecycle) startStalled(ctx context.Context, a db.Agent, paneAlive bool, now time.Time) bool {
	minutes := l.settings.Get().StuckStartMinutes
	if minutes == 0 || a.Activity != "starting" || !paneAlive || a.Machine != l.machine || !l.restartable(ctx, a) {
		return false
	}
	since, ok := l.startedAt(ctx, a)
	if !ok {
		return false
	}
	elapsed := now.Sub(since)
	bound := time.Duration(minutes * float64(time.Minute))
	if l.launchingNow(a.ID) && elapsed < 2*bound {
		return false
	}
	return elapsed >= bound
}

// startedAt is when the agent's latest start mark was recorded, or its last update when it has none.
func (l *Lifecycle) startedAt(ctx context.Context, a db.Agent) (time.Time, bool) {
	at, err := l.db.LastEventAt(ctx, a.ID, startMarks)
	if err != nil {
		return time.Time{}, false
	}
	s := a.UpdatedAt
	if at != nil {
		s = *at
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	return t, err == nil
}

// restartStalledStart is src/lifecycle.ts restartStalledStart (S-3250): in the agent's serial, rechecked there, since of
// two checks (reconcile ticks every 5 s) the second sees the first's launch. The count lives in events, so a daemon
// restart can't grant a second restart: a start that the restart made, or one a daemon restart cut off before it
// launched, errors the agent instead.
//
// It returns the restart's launch, which settles when its afterLaunch does (nil when no launch was made).
func (l *Lifecycle) restartStalledStart(ctx context.Context, id string, now time.Time) (<-chan error, error) {
	var launched <-chan error
	err := l.serial(ctx, id, func(ctx context.Context) error {
		cur, err := l.db.GetAgent(ctx, id)
		if err != nil {
			return err
		}
		alive := l.tmux.HasSession(ctx, id) && !l.tmux.IsDead(ctx, id)
		if !l.startStalled(ctx, cur, alive, now) {
			return nil
		}
		minutes := l.settings.Get().StuckStartMinutes
		mins := strconv.FormatFloat(minutes, 'f', -1, 64)
		last, err := l.db.LatestEvent(ctx, id, startMarks)
		if err != nil {
			return err
		}
		if last != nil && (last.Type == "starting:restart" || markedStuck(last)) {
			l.event(ctx, id, "starting:stuck", startingStuckEvent{Restarted: true, Minutes: minutes})
			l.update(ctx, id, db.Field{Col: "activity", Val: "errored"},
				db.Field{Col: "activity_detail", Val: fmt.Sprintf("never reached a turn, even after a restart (%s min each)", mins)})
			return nil
		}
		l.event(ctx, id, "starting:restart", startingRestartEvent{Minutes: minutes, Detail: cur.ActivityDetail})
		// A spawn whose first prompt never went in has no conversation to resume: it starts afresh with it.
		fresh := last != nil && last.Type == "spawn" && !l.hasEvent(ctx, id, "first-prompt:delivered")
		prompt, kind := "", "restart"
		if fresh {
			kind = "spawn"
			if cur.FirstPrompt != nil {
				prompt = *cur.FirstPrompt
			}
		} else {
			prompt, err = l.render("restarted", map[string]string{"reason": fmt.Sprintf("it never reached a turn in %s minutes of starting", mins)})
			if err != nil {
				return err
			}
		}
		launched, err = l.startHarnessMarked(ctx, cur, prompt, !fresh, kind, true)
		return err
	})
	return launched, err
}

// markedStuck is whether a start mark is the stuck-start restart's own launch.
func markedStuck(e *db.Event) bool {
	var d struct {
		Stuck bool `json:"stuck"`
	}
	return e.Decode(&d) == nil && d.Stuck
}

package lifecycle

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/tmux"
)

// ReconcileEvery is how often the reconcile loop runs (src/daemon.ts runDaemon: every 5 s).
const ReconcileEvery = 5 * time.Second

// reconcileTimeout bounds one pass: its tmux snapshot and its writes.
const reconcileTimeout = 30 * time.Second

type reconcileState struct {
	// mu runs one pass at a time.
	mu sync.Mutex
	// server is the tmux server the last pass saw ("" for none), first taken when the loop starts.
	server     string
	reconciled bool
	// lossDeferred is agents whose tmux-server loss a pass saw but held back, since they changed after its snapshot
	// began (S-2125).
	lossDeferred map[string]bool
	// held is the agents whose running compaction already has its reconcile:held event (S-273).
	held      map[string]bool
	startedAt time.Time
	// listWarned is when a pass last logged an unreadable OpenCode listing (restop.go): once a minute while it lasts.
	listWarned time.Time
}

// StartReconcile notes the tmux server running now, so a daemon restart under a live server loses no agent, and runs
// the reconcile loop, and the idle compaction sweep beside it, until the daemon's context ends. Its first pass runs
// before it returns, so the API, which listens after, never serves the states from before a restart (src/daemon.ts
// reconciles before it listens, S-4371); a first pass still running after reconcileTimeout goes on in the loop, which
// starts its ticks once it ends, and the daemon listens meanwhile.
func (l *Lifecycle) StartReconcile() {
	ctx, cancel := context.WithTimeout(l.ctx, reconcileTimeout)
	l.reconcile.server, _ = l.tmux.ServerID(ctx)
	cancel()
	l.reconcile.startedAt = time.Now()
	l.startIdleSweep()
	booted := make(chan struct{})
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		// bootCtx bounds the first pass, as reconcileTimeout bounds every tick's.
		bootCtx, endBoot := context.WithTimeout(l.ctx, reconcileTimeout)
		l.Reconcile(bootCtx, l.tmux.SharedSnapshot(bootCtx))
		endBoot()
		close(booted)
		t := time.NewTicker(ReconcileEvery)
		defer t.Stop()
		for {
			select {
			case <-l.ctx.Done():
				return
			case <-t.C:
			}
			ctx, cancel := context.WithTimeout(l.ctx, reconcileTimeout)
			l.Reconcile(ctx, l.tmux.SharedSnapshot(ctx))
			cancel()
		}
	}()
	// The wait has a timer of its own, so a pass that ignores its context can't keep the daemon from listening.
	wait := time.NewTimer(reconcileTimeout)
	defer wait.Stop()
	select {
	case <-booted:
	case <-wait.C:
		slog.Warn("reconcile: the first pass outran its timeout; listening before it ends")
	case <-l.ctx.Done():
	}
}

type lostEvent struct {
	Reason string `json:"reason"`
	Resume bool   `json:"resume"`
}

type exitedEvent struct {
	Reason string `json:"reason"`
}

type startingDeadEvent struct {
	AfterMS *int64 `json:"after_ms"`
}

// sessionEndWait is src/daemon.ts SESSION_END_MS: how long an agent whose harness ended its session may keep a live
// pane before it is shut down (STAM_SESSION_END_MS, else a minute).
func sessionEndWait() time.Duration {
	if n, err := strconv.ParseFloat(os.Getenv("STAM_SESSION_END_MS"), 64); err == nil && n > 0 {
		return time.Duration(n * float64(time.Millisecond))
	}
	return time.Minute
}

// Reconcile is one pass of src/daemon.ts reconcile over a tmux snapshot: an active agent whose harness is gone is shut
// down, and one whose whole tmux server went (rather than one harness exiting) is marked lost with a pending recover,
// as TS marks it. A nil snapshot (a tmux call that failed without saying the server is gone) changes nothing.
//
// Ported: the lost server and the resume of the agents it took down, the harness exit and the resume after a
// context-limit exit, the session that ended long ago with its pane alive, the agent stuck starting with no pane, a start
// with a live pane that settles at its prompt or is restarted once and then errored (S-3250), the re-delivery of a first prompt a restart cut short, running compactions (held) and one a restart cut short, pending
// shutdowns (on a gone harness, and past their deadline), and the stale-working sweep. Not yet: pending archives (left
// for the TS daemon), the idle shut-down archive sweep, cost switches and ring seats a restart cut short.
func (l *Lifecycle) Reconcile(ctx context.Context, snap *tmux.Snapshot) {
	st := &l.reconcile
	st.mu.Lock()
	defer st.mu.Unlock()
	if snap == nil {
		slog.Warn("reconcile: tmux list-panes failed; skipped this tick")
		return
	}
	if st.lossDeferred == nil {
		st.lossDeferred = map[string]bool{}
	}
	if st.held == nil {
		st.held = map[string]bool{}
	}
	asOf := snap.StartedAt
	first := !st.reconciled
	st.reconciled = true
	serverLost := snap.Server != st.server || (first && snap.Server == "")
	st.server = snap.Server
	reason := "stam's tmux server stopped"
	if first && machineUptime() < time.Since(st.startedAt)+5*time.Minute {
		reason = "this machine restarted"
	}
	agents, err := l.db.ListLiveAgents(ctx)
	if err != nil {
		slog.Error("reconcile: agents unreadable", "err", err)
		return
	}
	now := time.Now()
	lost := false
	var listing activeListing
	for _, a := range agents {
		// Registered agents (no workspace) run outside stam: no terminal to check.
		if a.Workspace == nil || *a.Workspace == "" || a.Lifecycle == "archived" {
			continue
		}
		dead, listed := snap.Dead[a.ID]
		gone := !listed || dead
		// An agent changed since the snapshot began may have a session it doesn't show: the next pass decides.
		if gone && !asOf.IsZero() && !updatedBefore(a, asOf) {
			if serverLost {
				st.lossDeferred[a.ID] = true
			}
			continue
		}
		lostHere := serverLost || st.lossDeferred[a.ID]
		delete(st.lossDeferred, a.ID)
		if a.Activity == "starting" {
			// S-759: a first prompt this restart cut off before delivery is delivered again now.
			if (first || lostHere) && l.firstPromptLost(ctx, a) {
				l.bg.Add(1)
				go func(a db.Agent) {
					defer l.bg.Done()
					l.recoverFirstPrompt(l.ctx, a)
				}(a)
				continue
			}
			// S-1400: the server went down (a reboot) under a starting agent with a conversation to resume: lost like
			// any active agent and resumed, not aged by created_at into "never started".
			if lostHere && !listed && a.Lifecycle == "active" && a.SessionID != nil && *a.SessionID != "" {
				l.markLost(ctx, a, reason, lostOpts{})
				lost = true
				continue
			}
			if l.startingStuck(a, !gone, now) {
				l.markStartingDead(ctx, a)
			} else if !l.settleStart(ctx, a, !gone) && l.startStalled(ctx, a, !gone, now) {
				// S-3250: a promptless launch whose SessionStart was lost settles at its prompt; any other start still
				// stuck past settings.stuckStartMinutes restarts once, then errors. In the background, as the first prompt's.
				l.bg.Add(1)
				go func(id string) {
					defer l.bg.Done()
					if _, err := l.restartStalledStart(l.ctx, id, now); err != nil && l.ctx.Err() == nil {
						l.event(l.ctx, id, "pending-error", "Error: "+err.Error())
					}
				}(a.ID)
			}
			continue
		}
		// S-273: a compaction takes the harness down on purpose; it isn't an exit or a lost server. One event on the
		// first pass that holds it, so a test can wait for a pass that ran during it.
		if l.compactionRunning(a.ID) {
			if !st.held[a.ID] {
				st.held[a.ID] = true
				l.event(ctx, a.ID, "reconcile:held", nil)
			}
			continue
		}
		delete(st.held, a.ID)
		// S-578: the harness is gone, so a pending stop has no step to wait for; it runs before the checks below read
		// the downed harness as an exit. An archive past its deadline is runDueArchives'.
		if gone && pendingStop(a) != nil {
			if err := l.runPendingOnDead(ctx, a); err != nil {
				l.event(ctx, a.ID, "pending-error", "Error: "+err.Error())
			}
			continue
		}
		// S-4254: a stopped OpenCode agent's session the shared server still runs is stopped again.
		if orphanCandidate(a, gone) {
			l.restopOrphan(ctx, a, &listing)
		}
		// S-358: on the first pass, a compaction the daemon's restart cut short is finished and resumed.
		if first && a.Lifecycle == "active" && gone && l.compactionExit(ctx, a) {
			lost = true
			continue
		}
		if lostHere && !listed {
			switch {
			case a.Lifecycle == "active":
				l.markLost(ctx, a, reason, lostOpts{})
				lost = true
			case a.Lifecycle == "paused" && !(a.ActivityDetail != nil && strings.HasSuffix(*a.ActivityDetail, "unpause to resume")):
				l.update(ctx, a.ID, db.Field{Col: "activity", Val: "unknown"}, db.Field{Col: "activity_detail", Val: reason + "; unpause to resume"})
				l.event(ctx, a.ID, "tmux-lost", lostEvent{Reason: reason, Resume: false})
			}
			continue
		}
		switch {
		case a.Lifecycle == "active" && gone:
			l.harnessExited(a.ID)
			if l.contextExit(ctx, a) {
				lost = true
				break
			}
			l.update(ctx, a.ID, db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "activity", Val: "unknown"},
				db.Field{Col: "activity_detail", Val: "harness exited"})
			l.event(ctx, a.ID, "exited", nil)
			// S-4254: an OpenCode turn outlives its TUI in the shared server; it stops now, as a quit's would.
			if a.Harness == "opencode" {
				if fresh, err := l.db.GetAgent(ctx, a.ID); err == nil {
					l.restopOrphan(ctx, fresh, &listing)
				}
			}
		case a.Lifecycle == "active" && l.sessionEndedLong(ctx, a, now):
			// The harness ended its session but its pane lives on, so nothing can reach it: it shuts down like an exit.
			if err := l.tmux.KillSession(ctx, a.ID); err != nil {
				slog.Warn("reconcile: kill failed", "agent", a.ID, "err", err)
			}
			l.harnessExited(a.ID)
			if l.contextExit(ctx, a) {
				lost = true
				break
			}
			l.update(ctx, a.ID, db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "activity", Val: "unknown"},
				db.Field{Col: "activity_detail", Val: "harness ended its session"})
			l.event(ctx, a.ID, "exited", exitedEvent{Reason: db.SessionEnded})
			l.tellStopped(ctx, a, a.Name+"'s harness ended its session without exiting, so stam shut it down.")
		}
	}
	// The first pass also picks up agents marked lost before a daemon restart.
	if lost || first {
		l.recoverLostSoon()
	}
	// A switch whose soft stop a restart cut short goes on at its deadline.
	if first {
		if resumed := l.ResumeSwitches(ctx); len(resumed) > 0 {
			slog.Info("cost switch: resumed", "agents", resumed)
		}
	}
	l.runDueShutdowns(ctx, float64(now.UnixMilli()))
	l.reconcileStaleWorking(ctx)
}

// tellStopped is src/mail.ts tellStopped for a parent (else the chief of staff) on this machine: a parent elsewhere
// isn't told, since the peers aren't ported.
func (l *Lifecycle) tellStopped(ctx context.Context, a db.Agent, what string) {
	parent := l.parentOrChief(ctx, a)
	if parent == "" || parent == a.ID {
		return
	}
	if _, err := l.db.GetAgent(ctx, parent); err != nil {
		return
	}
	waiting := ""
	if counts, err := l.db.UnreadCounts(ctx); err == nil && counts[a.ID] > 0 {
		waiting = fmt.Sprintf(" %d unread mail wait for it.", counts[a.ID])
	}
	l.QueueNotice(ctx, parent, fmt.Sprintf("%s%s If its work should go on, resume it: agent_control resume (stam resume %s).", what, waiting, a.Name), false)
}

func (l *Lifecycle) update(ctx context.Context, id string, fields ...db.Field) {
	if err := l.db.UpdateAgent(ctx, id, fields...); err != nil {
		slog.Error("lifecycle: update failed", "agent", id, "err", err)
	}
}

// updatedBefore is whether the agent's row was last written before t (updated_at is in ms).
func updatedBefore(a db.Agent, t time.Time) bool {
	u, err := time.Parse(time.RFC3339Nano, a.UpdatedAt)
	return err == nil && u.Before(t.Truncate(time.Millisecond))
}

// startingStuck is src/lifecycle.ts startingStuck: starting, no live pane, past settings.startingTimeoutMinutes.
func (l *Lifecycle) startingStuck(a db.Agent, paneAlive bool, now time.Time) bool {
	if a.Activity != "starting" || paneAlive {
		return false
	}
	since, err := time.Parse(time.RFC3339Nano, a.CreatedAt)
	limit := time.Duration(l.settings.Get().StartingTimeoutMinutes * float64(time.Minute))
	return err == nil && now.Sub(since) >= limit
}

// markStartingDead is src/lifecycle.ts markStartingDead: unless the harness still runs a turn with no pane, or can't be
// asked (an OpenCode turn in the shared server), and re-read, it is marked stopped unless a launch began meanwhile, its parent (else the chief of staff) is told, its rings
// hear of it (SetStartingDead), and a pending shutdown runs. A pending archive is left for the TS daemon.
func (l *Lifecycle) markStartingDead(ctx context.Context, a db.Agent) {
	gen := l.genOf(a.ID)
	// Only an answer that no turn runs lets it on; a live turn or an unknown one waits.
	if alive, known := l.turnAlive(ctx, a); alive || !known {
		return
	}
	now, err := l.db.GetAgent(ctx, a.ID)
	if err != nil || !l.current(a.ID, gen) || (now.Lifecycle != "active" && now.Lifecycle != "paused") {
		return
	}
	if !l.startingStuck(now, l.tmux.HasSession(ctx, a.ID) && !l.tmux.IsDead(ctx, a.ID), time.Now()) {
		return
	}
	l.invalidate(a.ID)
	var after *int64
	if since, err := time.Parse(time.RFC3339Nano, now.CreatedAt); err == nil {
		ms := time.Since(since).Milliseconds()
		after = &ms
	}
	l.update(ctx, a.ID, db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "activity", Val: "unknown"},
		db.Field{Col: "activity_detail", Val: "never started: no harness process"})
	l.event(ctx, a.ID, "starting:dead", startingDeadEvent{AfterMS: after})
	mins := jsjson.Number(round(l.settings.Get().StartingTimeoutMinutes))
	l.tellParent(ctx, now, fmt.Sprintf("%s never started: no harness process after %s minutes; stam marked it stopped.", now.Name, mins))
	l.orgMu.Lock()
	heard := l.startingDead
	l.orgMu.Unlock()
	if heard != nil {
		if fresh, err := l.db.GetAgent(ctx, a.ID); err == nil {
			heard(ctx, fresh)
		}
	}
	if fresh, err := l.db.GetAgent(ctx, a.ID); err == nil {
		if err := l.runPendingOnDead(ctx, fresh); err != nil {
			l.event(ctx, a.ID, "pending-error", "Error: "+err.Error())
		}
	}
}

// sessionEndedLong is src/daemon.ts sessionEndedLong: the harness ended its session (SessionEnd) and, after
// sessionEndWait, has no new one. The Go daemon serves no MCP stream, so none can reach the agent either.
func (l *Lifecycle) sessionEndedLong(ctx context.Context, a db.Agent, now time.Time) bool {
	if a.Activity != "unknown" || a.ActivityDetail == nil || *a.ActivityDetail != db.SessionEnded {
		return false
	}
	last := a.UpdatedAt
	if h, err := l.db.LastHookAt(ctx, a.ID); err == nil && h != nil {
		last = *h
	}
	t, err := time.Parse(time.RFC3339Nano, last)
	return err == nil && now.Sub(t) >= sessionEndWait()
}

// machineUptime is how long the machine has run (/proc/uptime); a large value when it can't be read, so a failed read
// never claims a restart.
func machineUptime() time.Duration {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 1 << 62
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 1 << 62
	}
	s, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 1 << 62
	}
	return time.Duration(s * float64(time.Second))
}

// quote is a JSON string, as JSON.stringify writes it.
func quote(s string) string {
	var b strings.Builder
	jsjson.Quote(&b, s)
	return b.String()
}

type reconciledEvent struct {
	LastHook string `json:"last_hook"`
}

// reconcileStaleWorking is src/daemon.ts reconcileStaleWorking (S-188): a working agent whose harness sits at its
// prompt and has sent no hook for settings.staleWorkingMinutes missed its end-of-turn hook, so its turn ends as Stop
// would end it: its push is scheduled and its pending action runs.
func (l *Lifecycle) reconcileStaleWorking(ctx context.Context) {
	limit := time.Duration(l.settings.Get().StaleWorkingMinutes * float64(time.Minute))
	agents, err := l.db.ListLiveAgents(ctx)
	if err != nil {
		return
	}
	for _, a := range agents {
		if a.Lifecycle != "active" || a.Activity != "working" || a.Harness != "claude" {
			continue
		}
		last := a.UpdatedAt
		if h, err := l.db.LastHookAt(ctx, a.ID); err == nil && h != nil {
			last = *h
		}
		// A time that doesn't parse is no reason to wait, as NaN < limit is false in TS.
		if t, err := time.Parse(time.RFC3339Nano, last); err == nil && time.Since(t) < limit {
			continue
		}
		if !l.atPrompt(ctx, a) {
			continue
		}
		l.event(ctx, a.ID, "activity:reconciled", reconciledEvent{LastHook: last})
		l.update(ctx, a.ID, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "turn finished"})
		l.SchedulePush(a.ID)
		l.onIdleSoon(a.ID)
	}
}

// atPrompt is the Claude adapter's atPrompt: the agent's session shows an empty input box, with no spinner or dialog.
func (l *Lifecycle) atPrompt(ctx context.Context, a db.Agent) bool {
	if !l.tmux.HasSession(ctx, a.ID) {
		return false
	}
	screen, err := l.tmux.CapturePane(ctx, a.ID)
	return err == nil && claude.AtPrompt(screen)
}

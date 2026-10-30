package lifecycle

import (
	"context"
	"log/slog"
	"time"

	"stam/internal/db"
)

// The orphaned turn's stop (S-4254): a quit stops an OpenCode agent's turn after it writes the row shut down, and the
// stop lives in memory, so a stop that failed, one a daemon restart cut short, and a harness that exited (reconcile
// writes it shut down) each leave a stopped agent whose session the shared server may still run. Reconcile stops it
// again from the durable facts alone: the row (shut down, with no pane) and the server's own listing, so a
// restart re-stops it on its first pass. A paused agent is never one: stam pushes mail to it and compacts it in turns
// the server runs with no pane. A failure is reported once per session (owner.stopNoted). Not in TS.

// activeListing is one reconcile pass's read of the sessions the shared server lists as active, made on first use. A
// read that failed (a transport error, an error status, an answer of an odd shape) is no answer: it stops nothing.
type activeListing struct {
	read   bool
	active map[string]bool
	err    error
}

// activeNow is whether the server lists sid as active, and whether it could be asked.
func (l *Lifecycle) activeNow(ctx context.Context, list *activeListing, sid string) (active, known bool) {
	if !list.read {
		list.read = true
		list.active, list.err = l.opencode.ActiveSessions(ctx)
		if list.err != nil && time.Since(l.reconcile.listWarned) >= time.Minute {
			l.reconcile.listWarned = time.Now()
			slog.Warn("reconcile: OpenCode active sessions unreadable; no orphaned turn stopped", "err", list.err)
		}
	}
	if list.err != nil {
		return false, false
	}
	return list.active[sid], true
}

// restopOrphan stops again the session of a, an OpenCode agent shut down with no pane, when the server lists it as
// active, no launch is in flight, and the session's wait since its last re-stop is over (owner.restop), so one that
// never stops raises a stop-error ever more rarely. The checks, in order: the owner's generation and that no launch is in flight
// (idleGen), the listing, the row re-read (still stopped, the same session), then the stop listed only while no
// launch took a generation since and none is in flight (owner.restop), in one step under the owner's lock. From there
// the stop is any other: it asks keep before every interrupt and holds the session's slot until it publishes, so a later
// launch gives it up and its release waits for it.
func (l *Lifecycle) restopOrphan(ctx context.Context, a db.Agent, list *activeListing) {
	sid := l.serverTurn(a)
	if sid == "" {
		return
	}
	o := l.ownerOf(a.ID)
	gen, idle := o.idleGen()
	if !idle {
		return
	}
	active, known := l.activeNow(ctx, list, sid)
	if !known {
		return
	}
	if !active {
		o.restopped(sid)
		return
	}
	cur, err := l.db.GetAgent(ctx, a.ID)
	// The row as the pass read it, unchanged: a launch and a pause since, or any other write, is the next pass's.
	if err != nil || cur.Lifecycle != "shut_down" || l.serverTurn(cur) != sid || cur.UpdatedAt != a.UpdatedAt {
		return
	}
	// No live pane now either: a TUI that runs is the agent's, whatever the snapshot showed.
	if l.tmux.HasSession(ctx, a.ID) && !l.tmux.IsDead(ctx, a.ID) {
		return
	}
	if l.restopRead != nil {
		l.restopRead(a.ID)
	}
	e, slot, started := o.restop(sid, gen, time.Now())
	if !started {
		return
	}
	slog.Info("reconcile: stopping an orphaned OpenCode turn", "agent", a.ID, "session", sid)
	l.runStop(cur, sid, e, slot, gen)
}

// orphanCandidate is whether reconcile asks after a's session: a shut-down OpenCode agent with no pane. A paused one is
// not: stam still pushes mail to it, in a turn the server runs with no pane.
func orphanCandidate(a db.Agent, gone bool) bool {
	return gone && a.Harness == "opencode" && a.Lifecycle == "shut_down"
}

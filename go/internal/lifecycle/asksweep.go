package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"stam/internal/adapters/opencode"
	"stam/internal/db"
)

// The sweep of pending OpenCode asks (S-4280). An ask lives in memory until it is raised (owner.go), so a daemon restart or
// a drop of the event stream loses one that was parked or whose permission.asked was never heard. On every connect to the
// server's stream (the first one of a daemon, and each reconnect) the permissions each running OpenCode agent's session lists
// as pending are read, and the newest of those stam has no record of is raised, as an event's ask is.
//
// The sweep is one more transition of the agent's owner, never a path of its own: its binding (bindSweep) and its queueing
// (queueSweep) are taken under the owner's lock, its listing is outside every lock, and the ask it picks goes through the
// agent's raiser (queueRaise, raiseAsk), whose checks every ask passes: not answered (outside stam or by stam), not raised or
// parked already, the agent still running the ask's session, no stop of the session in flight (parked for its outcome). Beyond
// them it never replaces a newer ask: it queues nothing when any listed permission is raised or queued already (that ask is
// the dialog's), and its ask is dropped when an event's ask came after the sweep began (askSeq).
//
// Generation reads, from the connect to the action: bindSweep (session, generation, askSeq, the launch in flight: one step
// under owner.mu; "sweep-start" is just before), the listing (no lock), queueSweep (generation and session read again under
// owner.mu; "sweep-listed" is just before), then the raiser's own (raiseAsk: beginRaise, the listing, mayShow, shown; askSeq is
// read again at each).

// askSweep is the sweeps' own state: one runs at a time, a connect that comes while it runs makes it run again.
type askSweep struct {
	mu      sync.Mutex
	running bool
	again   bool
}

// sweepAsks is run at each connect to the server's event stream: it starts the sweep, or has the one running go through the
// agents again. It waits for nothing (the stream's goroutine is the caller).
func (l *Lifecycle) sweepAsks() {
	l.sweep.mu.Lock()
	if l.sweep.running {
		l.sweep.again = true
		l.sweep.mu.Unlock()
		return
	}
	l.sweep.running = true
	l.sweep.mu.Unlock()
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		for {
			l.sweepAllAsks(l.ctx)
			l.sweep.mu.Lock()
			again := l.sweep.again && l.ctx.Err() == nil
			l.sweep.again = false
			if !again {
				l.sweep.running = false
				l.sweep.mu.Unlock()
				return
			}
			l.sweep.mu.Unlock()
		}
	}()
}

// sweepAllAsks is one pass over the live OpenCode agents with a session, one after another.
func (l *Lifecycle) sweepAllAsks(ctx context.Context) {
	agents, err := l.seedAgents(ctx)
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("opencode: can't list the agents to sweep for asks", "err", err)
		}
		return
	}
	for _, a := range agents {
		if ctx.Err() != nil {
			return
		}
		l.sweepAgentAsks(ctx, a)
	}
}

// sweepAgentAsks is the sweep of one agent's session. A listing that fails is tried again askRetryAfter later (one retry
// armed per agent); one that says the server has no such session raises nothing.
func (l *Lifecycle) sweepAgentAsks(ctx context.Context, a db.Agent) {
	l.mu.Lock()
	d := l.dialogs
	l.mu.Unlock()
	if d == nil || l.opencode == nil {
		return
	}
	o := l.ownerOf(a.ID)
	turn := l.runningTurn(ctx, a.ID)
	l.askAt(a.ID, "sweep-start")
	sid, gen, seq, ok := o.bindSweep(turn)
	if !ok {
		return
	}
	lctx, cancel := context.WithTimeout(ctx, askListing.budget)
	asks, err := l.opencode.PendingAsks(lctx, sid)
	cancel()
	switch {
	case errors.Is(err, opencode.ErrSessionGone) || ctx.Err() != nil:
		return
	case err != nil:
		slog.Warn("opencode: the pending permissions of an agent's session weren't listed", "agent", a.ID, "err", err)
		if o.armSweepRetry() {
			l.sweepAgainAfter(a.ID)
		}
		return
	}
	l.askAt(a.ID, "sweep-listed")
	listed := make([]parkedAsk, 0, len(asks))
	for _, p := range asks {
		listed = append(listed, parkedAsk{sid: sid, pid: p.Permission, action: p.Action, details: p.Details})
	}
	if o.queueSweep(sid, gen, seq, listed, turn) {
		l.startRaiser(a.ID)
	}
}

// sweepAgainAfter sweeps the agent once more askRetryAfter from now, ending with the daemon.
func (l *Lifecycle) sweepAgainAfter(id string) {
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		if sleep(l.ctx, askRetryAfter) != nil {
			return
		}
		o := l.ownerOf(id)
		o.endSweepRetry()
		a, err := l.db.GetAgent(l.ctx, id)
		if err != nil || a.Harness != "opencode" || deref(a.SessionID) == "" {
			return
		}
		l.sweepAgentAsks(l.ctx, a)
	}()
}

package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"

	"stam/internal/adapters/opencode"
	"stam/internal/db"
)

// The turn stop (src/lifecycle.ts stopTurn, awaitTurnStop, releaseTurnStop): an OpenCode agent's turn runs in the shared
// server, so killing its TUI leaves the turn running. A shutdown, an archive or a cost switch interrupts the session
// there, retrying, until the server no longer lists it as active (src/adapters/opencode.ts stop). One stop is in flight
// per session: a second request joins it. Every operation on the session (a stop, a one-shot interrupt) acts only while it
// holds the session's slot, until its outcome is published; a launch's release cancels them all and takes the slot, so
// nothing begun before the launch acts after it. Each stop also belongs to the launch generation its shutdown or archive
// left (invalidate), and gives up once a later launch takes another, checked again with its publication. The state
// (stops, slots, generations) is the agent's owner's (owner.go), changed only through its methods. The stops are in
// memory, as TS's are: a daemon restart drops them, and a later archive or switch, finding none, stops the session
// again. The shared server itself is never stopped here.

// slotOp is one operation on a session in the shared server: a stop, or a one-shot interrupt. It acts only while it
// holds the session's slot (sessionSlot), and a release cancels it, waiting or holding.
type slotOp struct {
	// cancelled is set when the agent runs again: the operation gives up before its next call.
	cancelled atomic.Bool
	stop      chan struct{}
	once      sync.Once
}

// cancel gives the operation up, waking it if it waits for the slot.
func (o *slotOp) cancel() {
	o.cancelled.Store(true)
	o.once.Do(func() { close(o.stop) })
}

// sessionSlot is the session's exclusion (S-4237): at most one operation sends anything to the session in the shared
// server, from its first call until its outcome is published. A launch's release cancels every operation registered on
// it, then takes the slot itself, so nothing that began before the launch acts after it. A holder (a stop's goroutine,
// from waitSlot to publish; openCodeInterrupt while it holds the slot) follows the owner's lock rule (owner): it takes
// no serial and no transition lock, only its owner's lock and the db, each briefly.
type sessionSlot struct {
	// held has a token in it while an operation holds the slot.
	held chan struct{}
	// ops are the operations registered on the slot, waiting or holding; under the owner's lock.
	ops map[*slotOp]bool
}

// turnStop is one stop in flight (src/lifecycle.ts TurnStop).
type turnStop struct {
	slotOp
	done chan struct{}
	err  error
	// gen is the agent's launch generation the stop was asked for under.
	gen int
	// owner is the agent's owner, which reads and writes the stop's state.
	owner *owner
}

// errStopGivenUp is a stop's end when its agent ran again before the session was confirmed stopped.
var errStopGivenUp = errors.New("the agent was resumed before its session stopped")

// stopEvent is a stop-error event's data.
type stopEvent struct {
	Error string `json:"error"`
}

// serverTurn is the session an agent's turn may run in on the shared server, "" when it has none.
func (l *Lifecycle) serverTurn(a db.Agent) string {
	if a.Harness != "opencode" || l.opencode == nil {
		return ""
	}
	return deref(a.SessionID)
}

// stopSession is src/adapters/opencode.ts stop: the session interrupted up to opencode.StopAttempts times. Unlike TS, a
// session the server already answers is idle gets no interrupt. It is an error when the session still runs after the
// last one, or can't be told not to, unless keep says the agent runs again.
func (l *Lifecycle) stopSession(ctx context.Context, a db.Agent, sid string, keep func() bool) error {
	kept := func() bool { return keep == nil || keep() }
	if !kept() {
		return nil
	}
	stopped := false
	if active, err := l.opencode.Active(ctx, sid); err == nil && !active {
		stopped = true
	} else {
		stopped = l.opencode.InterruptSession(ctx, sid, opencode.StopAttempts, keep)
	}
	if !kept() || stopped {
		return nil
	}
	return fmt.Errorf("OpenCode still runs %s's session %s", a.Name, sid)
}

// stopTurn is src/lifecycle.ts stopTurn: the agent's session stopped in the background under the launch generation gen
// (the one its caller's invalidate took), joining a stop in flight. A stop that fails is a stop-error event.
func (l *Lifecycle) stopTurn(a db.Agent, gen int) {
	if sid := l.serverTurn(a); sid != "" {
		l.startStop(a, sid, gen)
	}
}

// startStop is the stop in flight for sid under gen, joined, or a new one started (owner.startStop): it is listed while
// it runs, so an await finds it, and registered on the session's slot from the start, so a launch's release cancels
// it, and it acts only while it holds the slot.
func (l *Lifecycle) startStop(a db.Agent, sid string, gen int) *turnStop {
	o := l.ownerOf(a.ID)
	e, slot, started := o.startStop(sid, gen)
	if !started {
		return e
	}
	l.bg.Add(1)
	// The slot's holder, from waitSlot to publish: it takes no serial and no transition lock (owner).
	go func() {
		defer l.bg.Done()
		// Asked before every interrupt: a later launch's generation gives the stop up, as its release would.
		keep := func() bool { return o.keep(&e.slotOp, gen) }
		if !o.waitSlot(l.ctx, slot, &e.slotOp) {
			// Given up, or the daemon stops, before it sent anything: unconfirmed, unless publish finds it given up.
			l.queueAsks(a.ID, l.publishStop(a, sid, e, fmt.Errorf("OpenCode still runs %s's session %s", a.Name, sid)))
			return
		}
		err := l.stopSession(l.ctx, a, sid, keep)
		if l.stopPublishing != nil {
			l.stopPublishing(a.ID)
		}
		parked := l.publishStop(a, sid, e, err)
		o.leaveSlot(slot, &e.slotOp)
		// The asks that came while it ran, unless it confirmed their permissions rejected or a launch took them over
		// (owner.publish).
		l.queueAsks(a.ID, parked)
	}()
	return e
}

// publishStop ends the stop through its owner (owner.publish), in its slot: a stop no longer the agent's confirmed
// nothing and writes nothing; else its failure is the row's note and a stop-error, or its confirmation clears an earlier
// note. It returns the asks parked for the stop that must be raised again.
func (l *Lifecycle) publishStop(a db.Agent, sid string, e *turnStop, err error) []parkedAsk {
	var checked func()
	if l.stopChecked != nil {
		checked = func() { l.stopChecked(a.ID) }
	}
	return l.ownerOf(a.ID).publish(sid, e, err, checked, func(err error, givenUp bool) {
		switch {
		case err != nil:
			l.stopFailed(a.ID, err)
		case !givenUp:
			l.stopConfirmed(a.ID)
		}
	})
}

// stopFailed records a stop that ended unconfirmed: a stop-error event, and on a row still shut down its detail, so the
// agent never reads as cleanly stopped while its session may run. A row the agent left since (a launch took it back)
// keeps its state. It is written even as the daemon stops, since a stop cut short by that is unconfirmed too.
func (l *Lifecycle) stopFailed(id string, err error) {
	ctx := context.WithoutCancel(l.ctx)
	shutDown := func(cur db.Agent) bool { return cur.Lifecycle == "shut_down" }
	if _, werr := l.db.UpdateAgentIf(ctx, id, shutDown, db.Field{Col: "activity_detail", Val: "stop failed: " + err.Error()}); werr != nil {
		slog.Error("lifecycle: update failed", "agent", id, "err", werr)
	}
	// The row first, so a reader that sees the event sees the row's note too.
	l.event(ctx, id, "stop-error", stopEvent{Error: err.Error()})
}

// stopConfirmed clears an earlier stop's failure note from a row still shut down: its session is confirmed stopped now.
func (l *Lifecycle) stopConfirmed(id string) {
	noted := func(cur db.Agent) bool {
		return cur.Lifecycle == "shut_down" && strings.HasPrefix(deref(cur.ActivityDetail), "stop failed: ")
	}
	if _, err := l.db.UpdateAgentIf(context.WithoutCancel(l.ctx), id, noted, db.Field{Col: "activity_detail", Val: "shut down"}); err != nil {
		slog.Error("lifecycle: update failed", "agent", id, "err", err)
	}
}

// turnStopOf is the stop in flight for sid, nil for none, whichever agent's owner lists it (tests ask by session).
func (l *Lifecycle) turnStopOf(sid string) *turnStop {
	l.mu.Lock()
	owners := make([]*owner, 0, len(l.owners))
	for _, o := range l.owners {
		owners = append(owners, o)
	}
	l.mu.Unlock()
	for _, o := range owners {
		if e := o.stopOf(sid); e != nil {
			return e
		}
	}
	return nil
}

// await waits for the stop to end: its error, or errStopGivenUp when its agent ran again first, since a stop given up
// confirmed nothing.
func (e *turnStop) await(ctx context.Context) error { return e.owner.await(ctx, e) }

// awaitTurnStop is src/lifecycle.ts awaitTurnStop: it confirms the agent's turn is stopped, waiting for the stop in
// flight, else starting one and waiting for it. Unlike TS, that stop is listed like any other, so a launch meanwhile
// makes it give up rather than interrupt the new turn. gen is the launch generation the caller's invalidate left. It is
// an error while the session may still run, a stop given up included.
func (l *Lifecycle) awaitTurnStop(ctx context.Context, a db.Agent, gen int) error {
	sid := l.serverTurn(a)
	if sid == "" {
		return nil
	}
	e := l.ownerOf(a.ID).stopUnder(sid, gen)
	if e == nil {
		e = l.startStop(a, sid, gen)
	}
	err := e.await(ctx)
	// A launch since gen owns the turn now, whatever the stop found, and whether or not its release saw the stop.
	if err == nil && l.launchedSince(a.ID, gen) {
		return errStopGivenUp
	}
	return err
}

// genOf is the agent's launch generation now.
func (l *Lifecycle) genOf(id string) int { return l.ownerOf(id).now() }

// releaseTurnStop is src/lifecycle.ts releaseTurnStop, before the agent runs again under the launch generation gen:
// every operation on its session (a stop, an interrupt) gives up, and this takes the session's slot once whatever held
// it has published, so nothing that began before the release acts after it. Only a launch still current may cancel
// (owner.release): a stale one (a quit took a later generation since) cancels nothing and answers false, so a newer
// shutdown's stop runs on, and its launch is abandoned. No lock is held while it waits for the slot.
func (l *Lifecycle) releaseTurnStop(ctx context.Context, a db.Agent, gen int) (bool, error) {
	o := l.ownerOf(a.ID)
	sid := l.serverTurn(a)
	if sid == "" {
		return o.current(gen), nil
	}
	slot := o.release(gen, sid)
	if slot == nil {
		return false, nil
	}
	if err := o.drainSlot(ctx, slot); err != nil {
		return false, err
	}
	return true, nil
}

// turnAlive is src/lifecycle.ts harnessTurnAlive (S-578): whether the harness still runs the agent's turn with no pane
// to show it. known is false when the server can't be asked, which must never be read as no turn. A harness with no
// server turn (Claude Code) answers no, known: its pane is the whole of it. Its GET reads and sends nothing that acts
// on the session, so it takes no slot: every consumer revalidates before it acts (markStartingDead rechecks its
// generation with current; Archive and runPendingOnDead go on only through archiveNow, which confirms the stop with
// awaitTurnStop). A consumer that acted on its answer alone would need the slot.
func (l *Lifecycle) turnAlive(ctx context.Context, a db.Agent) (alive, known bool) {
	if a.Harness != "opencode" {
		return false, true
	}
	if l.opencode == nil {
		return false, false
	}
	if deref(a.SessionID) == "" {
		return false, true
	}
	active, err := l.opencode.Active(ctx, *a.SessionID)
	if err != nil {
		return false, false
	}
	return active, true
}

// harnessAlive is src/lifecycle.ts harnessAlive: a live pane, else the harness's own turn state (turnAlive).
func (l *Lifecycle) harnessAlive(ctx context.Context, a db.Agent) (alive, known bool) {
	if l.harnessRunning(ctx, a) {
		return true, true
	}
	return l.turnAlive(ctx, a)
}

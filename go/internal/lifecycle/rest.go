package lifecycle

import (
	"context"
	"errors"
	"strings"
	"time"

	"stam/internal/db"
)

// The requested rest and the wake (src/lifecycle.ts requestRest, rest, wakeResting and startRestWaking, S-2237, S-4332).
// `rest: true` on wait_for or wake_me asks stam to rest the agent when its turn ends: its harness stops, it is paused
// with the rest as its one owner, and mail or a notice for it (its answer, a timer, a timeout) starts it again on its
// conversation. The request is kept on its wait (db.RequestRest), so a daemon restart keeps it; TS keeps it in memory.
//
// One consistent view decides a rest, so no wake is lost and none launches twice:
//   - Durable checks (the wait still open, no unpushed mail, no pending permission, no push since the turn end) are read
//     inside the rest's write transaction (db.RestNow); mail commits before it (refused) or after it (mail's
//     SchedulePush finds the agent resting, and wakes it).
//   - In-memory checks are read in the agent's serial, with its transition lock held for the rest (no switch, resume or
//     archive starts meanwhile). Those that can change outside serial are read again once the rest committed, before the
//     kill: a notice queued meanwhile (restFlight.poked, set by SchedulePush), a compaction that started, a terminal
//     client that attached. Any of them takes the rest back while the harness still runs (db.UndoRest).
//   - The wake runs in the agent's serial too, so it waits for a rest's kill, and sees the agent resting at most once.
//
// Not ported: the timing rules' rests (rest.afterMinutes, graceMinutes, the standing idle rest and its sweep), the idle
// compaction before a long rest, the web view's prompt wake, the ITSA assignment wake and the wake retries' backoff (a
// failed wake leaves the agent resting, and the next mail or notice tries again).

// restRequestDelay is src/lifecycle.ts REST_REQUEST_DELAY_MS: the harness finishes its turn-end hook before it stops.
const restRequestDelay = 3 * time.Second

// restSweepEvery is how often the rest loop looks for requested rests a restart left, and resting agents that
// something waits for.
var restSweepEvery = time.Minute

// restState is the rest's in-memory part, under the Lifecycle's mu: each agent's rest timer from its turn end, and the
// rests in flight between their in-memory checks and their re-check after the commit.
type restState struct {
	timers  map[string]*time.Timer
	flights map[string]*restFlight
	// delay is restRequestDelay, shorter in tests.
	delay time.Duration
	// committed, nil outside tests, runs in a rest right after its transaction committed, before its re-checks; killing
	// runs right before the kill.
	committed, killing func(id string)
}

// restFlight is one rest between its checks and its re-check: poked once a wake cause arrived meanwhile.
type restFlight struct{ poked bool }

func (l *Lifecycle) restDelay() time.Duration {
	if l.rest.delay > 0 {
		return l.rest.delay
	}
	return restRequestDelay
}

// restEnabled is src/lifecycle.ts restEnabled: STAM_REST_ENABLED (1 or 0) overrides rest.enabled. Test daemons turn it
// off (test/lib.sh), so an agent in an e2e test never rests mid-test.
func (l *Lifecycle) restEnabled() bool {
	switch envVar("REST_ENABLED") {
	case "1":
		return true
	case "0":
		return false
	}
	return l.settings.Get().Rest.Enabled
}

// isResting is src/lifecycle.ts isResting: paused with the rest as its one owner.
func isResting(a db.Agent) bool {
	owners := pauseOwners(a)
	return a.Lifecycle == "paused" && len(owners) == 1 && owners[0] == restOwner
}

// RequestRest is src/lifecycle.ts requestRest: the wait the agent just declared, w as its creation returned it, asks for
// a rest at its turn end.
func (l *Lifecycle) RequestRest(ctx context.Context, id string, w db.Wait) error {
	_, err := l.db.RequestRest(ctx, id, w.ID, w.Until)
	return err
}

// restTurnStarted is src/lifecycle.ts restTurnStarted's drop: a new turn makes its own request, if any.
func (l *Lifecycle) restTurnStarted(ctx context.Context, id string) {
	l.mu.Lock()
	if t := l.rest.timers[id]; t != nil {
		t.Stop()
		delete(l.rest.timers, id)
	}
	l.mu.Unlock()
	// The hook's request may end before this does; the drop must still land, or the old turn's rest would run.
	ctx = context.WithoutCancel(ctx)
	if _, err := l.db.DropRestRequests(ctx, id); err != nil {
		l.event(ctx, id, "standing:rest-error", "Error: "+err.Error())
	}
}

// restTurnEnded is src/lifecycle.ts restTurnEnded: a turn ended, so a rest its turn requested runs restDelay later.
func (l *Lifecycle) restTurnEnded(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.waited {
		return
	}
	if l.rest.timers == nil {
		l.rest.timers = map[string]*time.Timer{}
	}
	if t := l.rest.timers[id]; t != nil {
		t.Stop()
	}
	var t *time.Timer
	t = time.AfterFunc(l.restDelay(), func() {
		l.mu.Lock()
		mine := l.rest.timers[id] == t
		if mine {
			delete(l.rest.timers, id)
		}
		l.mu.Unlock()
		if mine {
			l.goBG(func(ctx context.Context) { l.restIfRequested(ctx, id) })
		}
	})
	l.rest.timers[id] = t
}

// restForget is src/lifecycle.ts restForget: an archived or forgotten agent's rest timer and flight go. A timer that
// fires anyway finds the agent not active, and does nothing.
func (l *Lifecycle) restForget(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if t := l.rest.timers[id]; t != nil {
		t.Stop()
		delete(l.rest.timers, id)
	}
	delete(l.rest.flights, id)
}

// restIfRequested rests the agent when one of its waits asks for it; a cheap read first, so a turn end without a request
// takes no serial and writes nothing.
func (l *Lifecycle) restIfRequested(ctx context.Context, id string) {
	ws, err := l.db.ListWaits(ctx, id)
	if err != nil {
		return
	}
	for _, w := range ws {
		if db.RestRequestOf(w) {
			if _, err := l.Rest(ctx, id); err != nil && l.ctx.Err() == nil {
				l.event(ctx, id, "standing:rest-error", "Error: "+err.Error())
			}
			return
		}
	}
}

type restRefusedEvent struct {
	Why string `json:"why"`
}

// Rest is src/lifecycle.ts rest for a requested rest: it says what it did, "resting" or why the agent stays up.
func (l *Lifecycle) Rest(ctx context.Context, id string) (string, error) {
	out := ""
	err := l.serial(ctx, id, func(ctx context.Context) error {
		var err error
		out, err = l.restLocked(ctx, id)
		return err
	})
	return out, err
}

func (l *Lifecycle) restLocked(ctx context.Context, id string) (string, error) {
	if !l.restEnabled() {
		return "rest disabled", nil
	}
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return "", ignoreGone(err)
	}
	if a.Lifecycle != "active" {
		return "not active", nil
	}
	// Held for the whole rest: a cost switch, a resume or an archive waits, or is refused, until the kill is done.
	release, err := l.acquire(a, "rest")
	if err != nil {
		return "in a transition", nil
	}
	defer release()
	if l.compactionRunning(id) {
		return "compacting", nil
	}
	if held, err := l.heldBy(ctx, a); err != nil || held != "" {
		return "held", err
	}
	if l.churning(ctx, id, time.Now()) {
		return "woken too often", nil
	}
	// Someone at its terminal (`stam attach`, a web terminal) is using it.
	if l.tmux.HasClients(ctx, id) {
		return "a terminal client", nil
	}
	l.mu.Lock()
	if len(l.notices[id]) > 0 {
		l.mu.Unlock()
		return "notices queued", nil
	}
	if l.rest.flights == nil {
		l.rest.flights = map[string]*restFlight{}
	}
	flight := &restFlight{}
	l.rest.flights[id] = flight
	l.mu.Unlock()
	land := func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		if l.rest.flights[id] == flight {
			delete(l.rest.flights, id)
		}
		return flight.poked
	}
	r, err := l.db.RestNow(ctx, id, time.Now(), l.restDelay())
	if err != nil || !r.Rested {
		land()
		if err == nil {
			l.event(ctx, id, "standing:rest-refused", restRefusedEvent{Why: r.Refused})
		}
		return r.Refused, err
	}
	if l.rest.committed != nil {
		l.rest.committed(id)
	}
	// The re-checks of what may have changed outside serial since the checks above. From here on, a wake cause finds the
	// agent resting (SchedulePush), and its wake waits for this serial.
	poked := land()
	why := ""
	switch {
	case poked:
		why = "a notice or mail arrived"
	case l.compactionRunning(id):
		why = "a compaction started"
	case l.tmux.HasClients(ctx, id):
		why = "a terminal client attached"
	}
	if why != "" {
		if _, err := l.db.UndoRest(ctx, id, why); err != nil {
			return "", err
		}
		l.SchedulePush(id)
		return "stays up: " + why, nil
	}
	if l.rest.killing != nil {
		l.rest.killing(id)
	}
	gen := l.nextGen(id)
	l.harnessExited(id)
	if err := l.killPane(ctx, id, gen, false); err != nil {
		return "", err
	}
	l.stopTurn(a, gen)
	return "resting", nil
}

// restPoke is src/mail.ts schedulePush's call of the rest waker: SchedulePush is the one place that sees every mail and
// notice. A rest in flight is poked, and takes itself back at its re-check; else, once the agent rests, it is woken. The
// flight is read before the agent: a rest that commits after the flight's read lands after it, so the read of the agent
// sees it resting.
func (l *Lifecycle) restPoke(id string) {
	l.mu.Lock()
	if f := l.rest.flights[id]; f != nil {
		f.poked = true
		l.mu.Unlock()
		return
	}
	l.mu.Unlock()
	if l.ctx == nil {
		// A Lifecycle made without New (a test's) runs nothing in the background.
		return
	}
	l.goBG(func(ctx context.Context) {
		if a, err := l.db.GetAgent(ctx, id); err == nil && isResting(a) {
			// A failure is its standing:wake-error event; the next mail or notice tries again.
			_, _ = l.WakeResting(ctx, id, "mail or a notice is waiting for you")
		}
	})
}

type standingWakeEvent struct {
	Why string `json:"why"`
}

type wakeHeldEvent struct {
	Why  string `json:"why"`
	Held string `json:"held"`
}

// errNothingWaiting is a wake with nothing for the agent: no unpushed mail, no notice.
var errNothingWaiting = errors.New("nothing is waiting for it")

// WakeResting is src/lifecycle.ts wakeResting: a resting agent starts again on its conversation, for mail or a notice
// waiting for it. A hold besides the rest (a cost blocker) keeps it down. In the agent's serial, so two wake causes
// resume it once: the second finds it no longer resting. A failed wake leaves it resting (the rest owner back on it),
// with a standing:wake-error event; the next mail or notice tries again.
func (l *Lifecycle) WakeResting(ctx context.Context, id, why string) (string, error) {
	out := ""
	err := l.serial(ctx, id, func(ctx context.Context) error {
		a, err := l.db.GetAgent(ctx, id)
		if err != nil || !isResting(a) {
			out = "not resting"
			return ignoreGone(err)
		}
		mail, err := l.db.Unpushed(ctx, id)
		if err != nil {
			return err
		}
		l.mu.Lock()
		notices := len(l.notices[id])
		l.mu.Unlock()
		if len(mail) == 0 && notices == 0 {
			out = errNothingWaiting.Error()
			return nil
		}
		held, err := l.blockedBy(ctx, id)
		if err != nil {
			return err
		}
		if len(held) > 0 {
			l.event(ctx, id, "standing:wake-held", wakeHeldEvent{Why: why, Held: joinHeld(held)})
			out = "stays down: " + joinHeld(held)
			return nil
		}
		l.event(ctx, id, "standing:wake", standingWakeEvent{Why: why})
		text, err := l.render("standing-wake", map[string]string{"why": why, "cwd": a.Cwd})
		if err != nil {
			return err
		}
		if out, err = l.resumeNow(ctx, id, text); err != nil {
			// Still resting, if the launch left it paused.
			if cur, gerr := l.db.GetAgent(ctx, id); gerr == nil && cur.Lifecycle == "paused" && len(pauseOwners(cur)) == 0 {
				l.update(ctx, id, db.Field{Col: "paused_by", Val: db.RestOwnerJSON})
			}
			l.event(ctx, id, "standing:wake-error", "Error: "+err.Error())
			return err
		}
		return nil
	})
	return out, err
}

func joinHeld(held []string) string { return strings.Join(held, "; ") }

// sweepRest is one pass of the rest loop: a requested rest a restart left (its turn-end timer gone with the old daemon)
// runs, and a resting agent with mail or a notice waiting is woken (mail that came while the daemon was down, or a
// timeout the first tick fired).
func (l *Lifecycle) sweepRest(ctx context.Context) {
	ids, err := l.db.RestRequesters(ctx)
	if err == nil {
		for _, id := range ids {
			l.restIfRequested(ctx, id)
		}
	}
	agents, err := l.db.ListAgents(ctx)
	if err != nil {
		return
	}
	for _, a := range agents {
		if isResting(a) {
			_, _ = l.WakeResting(ctx, a.ID, "mail or a notice is waiting for you")
		}
	}
}

// StartRest starts the rest loop: its first pass at once, then one every restSweepEvery until the daemon stops.
func (l *Lifecycle) StartRest() {
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		t := time.NewTicker(restSweepEvery)
		defer t.Stop()
		for {
			l.sweepRest(l.ctx)
			select {
			case <-l.ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

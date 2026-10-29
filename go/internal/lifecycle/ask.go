package lifecycle

import (
	"context"
	"errors"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/adapters/opencode"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// OpenCode asks (S-3980, src/adapters/opencode.ts): a permission.asked event on an agent's session is a harness dialog,
// a delegate ask in the human's thread like Claude Code's, answered through the session's permission reply endpoint. A
// permission.replied made outside stam (the TUI, the agent view) closes it. What stam replied and what was replied
// outside it, the asks raised and those parked are the agent's owner's (owner.go), in memory as TS's are: after a daemon
// restart the ask is read from its row, and its answer asks the server again whether the permission is still pending.
//
// A relaunch that keeps the session (a resume) follows a shutdown, an archive or a switch, whose stop interrupts the
// session; OpenCode rejects the pending permissions with it and says so (permission.replied), which closes their asks.
// An ask whose raise a launch overtook is closed again; a permission the server still lists stays answerable, as TS's.

// askListing bounds a raise's listing: up to attempts calls, pause apart, all within budget (the server's call
// timeout), after which the ask is parked (retryAsks).
var askListing = struct {
	attempts int
	pause    time.Duration
	budget   time.Duration
}{3, 200 * time.Millisecond, 10 * time.Second}

// askRetryAfter is when an ask whose listing failed is listed again, unless a server event for the agent comes first.
var askRetryAfter = 5 * time.Second

// openCodeAsk is TS onEvent's permission.asked raise, for the event's permission: queued for the agent's raiser
// (raiseAsk), so the event stream never waits on a raise's calls.
func (l *Lifecycle) openCodeAsk(a db.Agent, sid string, data *jsjson.Object) {
	action, details, ok := opencode.AskDialog(data)
	if !ok {
		return
	}
	if l.ownerOf(a.ID).queueEventRaise([]parkedAsk{{sid: sid, pid: opencode.AskOf(details).Permission, action: action, details: details}}) {
		l.startRaiser(a.ID)
	}
}

// queueAsks queues asks for the agent's raiser, started if none runs: one goroutine per agent raises them, in their
// order, under the daemon's context, until none is queued.
func (l *Lifecycle) queueAsks(id string, asks []parkedAsk) {
	if l.ownerOf(id).queueRaise(asks) {
		l.startRaiser(id)
	}
}

func (l *Lifecycle) startRaiser(id string) {
	o := l.ownerOf(id)
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		for {
			ask, ok := o.nextRaise()
			if !ok {
				return
			}
			l.raiseAsk(l.ctx, id, ask)
		}
	}()
}

// raiseAsk raises an ask once, only while its raise predicate holds (owner.raiseCheck), checked at its start, after
// its listing and after it is shown: never for a permission replied to outside stam first or raised already, nor for
// an agent no longer running the ask's session. While a stop of the session is in flight it is parked, for the stop's
// outcome (owner.publish): its interrupt rejects the permission, and a stop given up or failed raises it again. It is
// raised only for a permission the server lists as pending: one it no longer lists was answered, or belongs to a turn
// gone since (a late event), and is dropped; a listing that fails parks it until a later listing answers
// (retryAsks). One a reply, a stop, a launch or another session overtook while it was shown is closed again, by its
// permission id. The same event again raises nothing (owner.asked). Like TS's deferred raise it runs off the event
// stream; unlike it, the agent's raises run one at a time (its raiser, queueAsks), in the order they came, so an
// earlier ask's raise never replaces a later one.
func (l *Lifecycle) raiseAsk(ctx context.Context, id string, ask parkedAsk) {
	l.mu.Lock()
	d := l.dialogs
	l.mu.Unlock()
	if d == nil {
		return
	}
	o := l.ownerOf(id)
	turn := l.runningTurn(ctx, id)
	l.askAt(id, "raise")
	gen, v := o.beginRaise(ask, turn)
	if v != raiseGo {
		return
	}
	l.askAt(id, "listing")
	lctx, cancel := context.WithTimeout(ctx, askListing.budget)
	pending, err := l.listAsk(lctx, ask)
	cancel()
	switch {
	case errors.Is(err, opencode.ErrSessionGone) || ctx.Err() != nil:
		return
	case err != nil:
		if o.parkUnlisted(ask) {
			l.retryAsksAfter(id)
		}
		return
	case !pending:
		return
	}
	l.askAt(id, "listed")
	if o.mayShow(ask, gen, turn) != raiseGo {
		return
	}
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return
	}
	// Shown unless stam answered it meanwhile, read where the request standing is: an answer holds that while it acts.
	choose := func() claude.Dialog {
		if o.answeredNow(ask.pid) {
			return claude.Dialog{}
		}
		return claude.Dialog{Action: ask.action, Details: ask.details, Replaces: true}
	}
	if err := d.DialogShown(ctx, a, claude.Dialog{Replaces: true, Choose: choose}); err != nil {
		l.event(ctx, id, "permission-error", "Error: "+err.Error())
		return
	}
	l.askAt(id, "shown")
	if o.shown(ask, gen, turn) != raiseGo {
		l.closeAsk(ctx, d, id, ask.pid)
	}
}

// listAsk is whether the server lists the ask's permission as pending, asked up to askListing.attempts times while
// the listing fails, within ctx: ErrSessionGone, or the last failure.
func (l *Lifecycle) listAsk(ctx context.Context, ask parkedAsk) (bool, error) {
	var err error
	for i := 0; i < askListing.attempts; i++ {
		if i > 0 && sleep(ctx, askListing.pause) != nil {
			return false, ctx.Err()
		}
		var pending bool
		pending, err = l.opencode.Pending(ctx, ask.sid, ask.pid)
		if err == nil || errors.Is(err, opencode.ErrSessionGone) {
			return pending, err
		}
	}
	return false, err
}

// retryAsks queues for the raiser the asks parked for a listing that failed (owner.retryUnlisted), in their order:
// each is listed again, and parked again if that fails too. It runs on the agent's next server event, which it never
// holds up (it waits on nothing, and takes no lock while none is parked), or askRetryAfter later.
func (l *Lifecycle) retryAsks(id string) {
	if l.ownerOf(id).retryUnlisted() {
		l.startRaiser(id)
	}
}

// retryAsksAfter schedules retryAsks for askRetryAfter from now, ending with the daemon: the owner's retry due
// (retryArmed), one per agent at a time.
func (l *Lifecycle) retryAsksAfter(id string) {
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		t := time.NewTimer(askRetryAfter)
		defer t.Stop()
		select {
		case <-t.C:
			l.retryAsks(id)
		case <-l.ctx.Done():
		}
	}()
}

// runningTurn reads the agent's row: the session it runs in the shared server while it is active or paused, else "".
// Read under the owner's lock (bind, still, raiseCheck), it is paired with the generation: a launch writes a new
// session only under its own (updateIfCurrent).
func (l *Lifecycle) runningTurn(ctx context.Context, id string) func() string {
	return func() string {
		a, err := l.db.GetAgent(ctx, id)
		if err != nil || (a.Lifecycle != "active" && a.Lifecycle != "paused") {
			return ""
		}
		return l.serverTurn(a)
	}
}

// openCodeReplied is TS onEvent's permission.replied: a reply made outside stam closes the ask raised for its
// permission, or, one still being raised, has it closed (owner.shown), or drops one parked. stam's own reply closes
// nothing here: its answer settles the request.
func (l *Lifecycle) openCodeReplied(ctx context.Context, a db.Agent, pid string) {
	if pid == "" || !l.ownerOf(a.ID).repliedOutside(pid) {
		return
	}
	l.mu.Lock()
	d := l.dialogs
	l.mu.Unlock()
	if d != nil {
		l.closeAsk(ctx, d, a.ID, pid)
	}
}

// closeAsk withdraws the agent's pending ask if it is the one for pid, its human's mail with it.
func (l *Lifecycle) closeAsk(ctx context.Context, d Dialogs, id, pid string) {
	a, err := l.db.GetAgent(ctx, id)
	if err == nil {
		err = d.DialogClosedIf(ctx, a, func(details string) bool { return opencode.AskOf(details).Permission == pid })
	}
	if err != nil {
		// Recorded under a context of its own: ctx may be the one whose end made the close fail.
		ectx, cancel := context.WithTimeout(context.WithoutCancel(ctx), closeEventTimeout)
		defer cancel()
		l.event(ectx, id, "permission-error", "Error: "+err.Error())
	}
}

// closeEventTimeout bounds the recording of a failed close of an ask.
const closeEventTimeout = 5 * time.Second

// answerOpenCode is src/adapters/opencode.ts answerDialog: the ask's permission answered on the server, under the
// agent's current session, once for a yes and reject for a no. "gone", with nothing sent, when the agent no longer runs
// (archived, shut down), is in another session, or its session no longer lists the permission (a 404 on the listing
// included); "unsafe" for an ask with no permission, or a yes to a question (no single choice is safe); "failed", with
// the request left pending, when a call fails or the agent ran again meanwhile. The session is read from the row with
// the generation, in one step (owner.bindAnswer), and both are checked again after the session's slot is taken and before the
// reply (owner.still): a launch, a shutdown, an archive or a switch since, or another session, sends nothing. The answer
// holds the slot while it acts, as a stop does: a launch's release cancels it, and it sends nothing after that.
func (l *Lifecycle) answerOpenCode(ctx context.Context, a db.Agent, details string, approve bool) string {
	ask := opencode.AskOf(details)
	o := l.ownerOf(a.ID)
	turn := l.runningTurn(ctx, a.ID)
	l.askAt(a.ID, "answer")
	sid, gen, gone := o.bindAnswer(turn, ask.Permission, ask.Session)
	if gone {
		// Gone to every later raise and sweep too: the permission is not this agent's session's to ask for (bindAnswer).
		return "gone"
	}
	if ask.Permission == "" || (approve && ask.Action == "question") {
		return "unsafe"
	}
	op := slotOp{stop: make(chan struct{})}
	slot := o.joinSlot(sid, &op)
	if !o.waitSlot(ctx, slot, &op) {
		return "failed"
	}
	defer o.leaveSlot(slot, &op)
	// The slot's holder from here: it takes no serial and no transition lock (owner).
	keep := func() bool { return o.keep(&op, gen) && o.still(gen, sid, turn) }
	l.askAt(a.ID, "answer-slot")
	if !keep() {
		return "failed"
	}
	pending, err := l.opencode.Pending(ctx, sid, ask.Permission)
	switch {
	case errors.Is(err, opencode.ErrSessionGone):
		// Recorded as answered while the answer holds permMu, so a raise listed before shows it no second time.
		o.goneOutside(ask.Permission, gen, sid, turn)
		return "gone"
	case err != nil:
		return "failed"
	case !pending:
		o.goneOutside(ask.Permission, gen, sid, turn)
		return "gone"
	}
	l.askAt(a.ID, "answer-listed")
	if !keep() {
		return "failed"
	}
	// Marked before the reply: OpenCode's permission.replied for it can come before the reply's response.
	o.beginAnswer(ask.Permission)
	l.askAt(a.ID, "replying")
	err = l.opencode.Reply(ctx, sid, ask.Permission, approve)
	o.endAnswer(ask.Permission, err == nil)
	if err != nil {
		return "failed"
	}
	return "typed"
}

// askAt runs a test's hook at a step of an ask's raise or answer.
func (l *Lifecycle) askAt(id, step string) {
	if l.askStep != nil {
		l.askStep(id, step)
	}
}

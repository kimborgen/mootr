package lifecycle

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// owner is one agent's launch, stop and kill state (S-4237), and the one place it changes: the agent's launch
// generation and its latest launch's, its turn stops in flight and its sessions' slots (turnstop.go), and the kills of
// its pane in flight, and the replies to its OpenCode permissions (ask.go). Every transition is a method here, under mu, checked against the state it finds; nothing else
// reads or writes that state. External I/O runs outside mu (an HTTP call to the shared server, a tmux kill), and its
// result comes back through a method that accepts it only while the state still matches: a stale actor, an old launch
// or an old stop, never changes newer state.
//
// The lock rule: mu is held only for the state and the db writes that must land with a check (a guarded write, a
// stop's publication); it is never held while waiting on anything else, and whoever holds it, or a slot, or a kill in
// flight, never takes an agent's serial or transition lock (acquire) or anything that waits on them. Callers may wait
// for a slot, a pane (beginPane) or a kill (beginKill) holding serial or a transition: a slot is held for at most one
// stop's loop, and a kill or a launch's replace for its tmux calls, each bounded by its own deadline (tmux.Timeout, a
// kill's process sweep tmux.Grace, the kill as a whole killTimeout), plus one token write: a replace's kill, new
// session and, superseded, kill of what it made come to about 30-35 s at most, so those waits are bounded and can't
// cycle.
type owner struct {
	mu sync.Mutex
	// gen is the agent's launch generation (S-578): a stop takes the next one, so a launch still in flight notices it is
	// no longer wanted and starts nothing.
	gen int
	// launched is the latest launch's generation (beginLaunch): a stop or a quit of an earlier one must not act on it.
	launched int
	// stops is the turn stop in flight per session, slots each session's exclusion.
	stops map[string]*turnStop
	slots map[string]*sessionSlot
	// kills counts the kills of the agent's pane in flight; paneFree is signalled when it drops to 0.
	kills    int
	paneFree *sync.Cond
	// paneWaits counts the launches waiting in beginPane for a kill to end. replacing is set while a launch replaces
	// the pane (beginPane to endPane), and killWaits counts the kills waiting in beginKill for it to end.
	paneWaits int
	replacing bool
	killWaits int
	// answering is the OpenCode permissions stam replies to (ask.go), by id: in flight, or sent since the agent's last
	// launch, so a permission.replied for one that comes before the next launch is stam's own answer. replied is the
	// permissions answered outside stam since that launch, so an ask raised for one is closed, or never raised. asked is
	// the asks raised since that launch, by session and permission, so the same event again raises nothing.
	answering map[string]answerState
	replied   map[string]bool
	asked     map[askKey]bool
	// replay is, per permission, the event's ask that coalesced into a raise queued or in flight for it (queueEventRaise): if that
	// raise ends without the ask raised or parked, the event is queued once more (nextRaise).
	replay map[string]parkedAsk
	// parked is the asks waiting to be raised, in the order they came: for a stop of their session in flight, for a
	// launch to land (a stop it gave up handed them over), or for a listing that failed (retryArmed: a retry is due).
	parked     []parkedAsk
	retryArmed bool
	// unlistedWait is set while an ask is parked for a listing: an event finds nothing to retry without the lock.
	unlistedWait atomic.Bool
	// raises is the asks to raise, in the order they came; raiser is whether the agent's raiser runs (ask.go), the one
	// goroutine that raises them, off the event stream, one at a time.
	raises []parkedAsk
	raiser bool
	// askSeq counts the asks the server's events raised (queueEventRaise): a sweep (asksweep.go) of the permissions the
	// server lists records it before it asks, and its ask is dropped once an event's ask came since (raiseCheck), so the sweep
	// never replaces an ask newer than its listing.
	askSeq int
	// sweepRetry is whether a retry of a sweep whose listing failed is due (armSweepRetry), one at a time.
	sweepRetry bool
	// raisingNow is the permission the raiser took from its queue and is raising (nextRaise), until it takes the next.
	raisingNow string
	// launchEnd is the latest launch whose outcome is known (settleLaunch), launchOK whether it landed: its row written
	// active or paused.
	launchEnd int
	launchOK  bool
	// restops is the re-stops of each orphaned session reconcile started (restop.go), and when the next may start:
	// one that never stops is tried again ever more rarely, not on every pass. In memory: a restart tries at once.
	restops map[string]restopTry
	// stopNoted is the sessions whose stop failure was reported (a stop-error and the row's note) and not confirmed
	// since: a stop that fails again reports nothing more until one is confirmed, the agent is launched, or quit again.
	stopNoted map[string]bool
	// exec is the OpenCode session whose ends may end the agent's turn (startExec, endExec): one seen starting an
	// execution under a generation, or a credit for one end whose start the stream may not have shown (a fresh owner, a
	// reconnect).
	exec execMark
	// comp is the OpenCode compaction in flight or just done (occompact.go), notes the instructions the server's
	// compaction takes, and mark the post-compaction size's mark: the OpenCode compaction state, changed only by the
	// transitions below, each checked against the binding of the action that asks.
	comp  *ocComp
	notes ocNotes
	mark  *ocMark
}

// askKey is an ask's session and permission.
type askKey struct{ sid, pid string }

// parkedAsk is an ask to raise (ask.go): its session, permission, and the action and details it is raised with. Parked,
// stop is the stop it waits for, or launch the launch's generation; neither, its listing failed.
type parkedAsk struct {
	sid, pid, action, details string
	stop                      *turnStop
	launch                    int
	// swept is set for the ask a sweep of the server's listing raises, seen the askSeq it began under (raiseCheck).
	swept bool
	seen  int
}

// raiseVerdict is a raise's check (raiseCheck): go on, or it is dropped, or it is parked.
type raiseVerdict int

const (
	raiseDrop raiseVerdict = iota
	raiseGo
	raiseParked
)

// answerState is where stam's reply to a permission is.
type answerState int

const (
	answerInFlight answerState = iota + 1
	answerSent
)

// ownerOf is the agent's owner, made on first use. l.mu guards only the lookup.
func (l *Lifecycle) ownerOf(id string) *owner {
	l.mu.Lock()
	defer l.mu.Unlock()
	o := l.owners[id]
	if o == nil {
		o = newOwner()
		l.owners[id] = o
	}
	return o
}

func newOwner() *owner {
	// A fresh owner is one this daemon has never launched, stopped or switched: an execution the session runs now began
	// before the daemon did, its start unseen, so the credit lets one end bind under generation 0.
	o := &owner{stops: map[string]*turnStop{}, slots: map[string]*sessionSlot{}, answering: map[string]answerState{}, replied: map[string]bool{}, asked: map[askKey]bool{}, replay: map[string]parkedAsk{},
		exec: execMark{set: true}}
	o.paneFree = sync.NewCond(&o.mu)
	return o
}

// invalidate takes the next generation: any launch in flight is no longer current.
func (o *owner) invalidate() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.gen++
	// A new quit's stop reports its own failure.
	clear(o.stopNoted)
	return o.gen
}

// beginLaunch takes the next generation for a launch, which owns the agent from here (launchedSince).
func (o *owner) beginLaunch() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.gen++
	o.launched = o.gen
	// The launch runs the agent's session again: a later orphan of it is a new one (restop), and so is its failure.
	clear(o.restops)
	clear(o.stopNoted)
	return o.gen
}

func (o *owner) now() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.gen
}

func (o *owner) current(gen int) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.gen == gen
}

// launchedSince is whether a launch took a generation later than gen. Another invalidate (a reconcile's, a recovery's)
// doesn't count.
func (o *owner) launchedSince(gen int) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.launched > gen
}

// whileCurrent runs write while gen is still current, in one step with that check: no generation is taken between
// them. It reports whether write ran; checked, when set, runs between the check and the write.
func (o *owner) whileCurrent(gen int, checked func(), write func() (bool, error)) (bool, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.gen != gen {
		return false, nil
	}
	if checked != nil {
		checked()
	}
	return write()
}

// unlessLaunched runs write unless a launch took a generation later than gen, in one step with that check.
func (o *owner) unlessLaunched(gen int, write func() (bool, error)) (bool, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.launched > gen {
		return false, nil
	}
	return write()
}

// beginKill starts a kill of the agent's pane under gen, refused when a launch took a later generation: that launch's
// pane is not this kill's. own asks more: gen must still be current (a launch killing its own failed pane). Every kill
// begun is ended with endKill, and no pane begins while one is in flight (beginPane). A kill waits for a launch's
// replace of the pane in flight (S-4269), so it kills the pane the replace made, never the old one under it.
func (o *owner) beginKill(gen int, own bool) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	for o.replacing {
		o.killWaits++
		o.paneFree.Wait()
		o.killWaits--
	}
	if o.launched > gen || (own && o.gen != gen) {
		return false
	}
	o.kills++
	return true
}

func (o *owner) endKill() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.kills--
	if o.kills == 0 {
		o.paneFree.Broadcast()
	}
}

// tryPane is beginPane's step: begun when no kill is in flight and gen is still current; wait when a kill is in flight.
func (o *owner) tryPane(gen int) (begun, wait bool) {
	if o.kills > 0 {
		return false, true
	}
	return o.gen == gen, false
}

// beginPane is a launch's right to make its pane under gen: it waits until no kill of the pane is in flight, then
// needs gen current. Begun, the launch's own kill and remake of the pane (its replace) counts as a kill in flight from
// the same step (S-4269), ended with endPane once its new session is made or failed: a newer launch waits for all of
// it, so it never has its pane killed or its token replaced by an older one, and a kill (a later quit's) waits for it
// too, then kills the pane it made; the launch's own check after making it notices.
func (o *owner) beginPane(gen int) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	for {
		begun, wait := o.tryPane(gen)
		if !wait {
			if begun {
				o.kills++
				o.replacing = true
			}
			return begun
		}
		o.paneWaits++
		o.paneFree.Wait()
		o.paneWaits--
	}
}

// endPane ends beginPane's replace.
func (o *owner) endPane() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.endPaneLocked()
}

// endPaneIfCurrent ends the replace only while gen is still current, in one step with that check: a superseded one
// keeps its count, to kill what it made first (replacePane).
func (o *owner) endPaneIfCurrent(gen int) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.gen != gen {
		return false
	}
	o.endPaneLocked()
	return true
}

func (o *owner) endPaneLocked() {
	o.replacing = false
	o.kills--
	if o.kills == 0 {
		o.paneFree.Broadcast()
	}
}

// killTimeout bounds a kill of an agent's pane: a hung tmux must not hold a launch's beginPane.
const killTimeout = 10 * time.Second

// killPane kills the agent's tmux session under gen (killUnlessLaunched's rule, beginKill): never a pane a later
// launch made. The tmux call runs outside the owner's lock, bounded by killTimeout.
func (l *Lifecycle) killPane(ctx context.Context, id string, gen int, own bool) error {
	o := l.ownerOf(id)
	if !o.beginKill(gen, own) {
		return nil
	}
	defer o.endKill()
	if l.paneKilling != nil {
		l.paneKilling(id)
	}
	ctx, cancel := context.WithTimeout(ctx, killTimeout)
	defer cancel()
	return l.tmux.KillSession(ctx, id)
}

// replacePane is a launch's kill of the agent's old pane and make of its new one under gen, as one kill in flight
// (beginPane): begun is false when gen was no longer current, and nothing ran. A replace superseded by the time it
// ends kills what it made before its count ends: no later launch can have made a pane meanwhile, and one that failed
// before its own replace (whose launch generation refuses this launch's later killPane) would never reach this one, so
// the pane would be orphaned. It runs on a context the caller's end
// can't cancel, so a request's disconnect never leaves the replace half done; the kill is bounded by killTimeout, and
// make (the token and the new session) by the deadline every tmux call has.
func (l *Lifecycle) replacePane(ctx context.Context, id string, gen int, make func(ctx context.Context) error) (begun bool, err error) {
	o := l.ownerOf(id)
	if !o.beginPane(gen) {
		return false, nil
	}
	ended := false
	defer func() {
		if !ended {
			o.endPane()
		}
	}()
	ctx = context.WithoutCancel(ctx)
	kctx, cancel := context.WithTimeout(ctx, killTimeout)
	err = l.tmux.KillSession(kctx, id)
	cancel()
	if err == nil {
		if l.paneMaking != nil {
			l.paneMaking(id)
		}
		err = make(ctx)
		if l.paneMade != nil {
			l.paneMade(id)
		}
	}
	if ended = o.endPaneIfCurrent(gen); ended {
		return true, err
	}
	if l.paneKilling != nil {
		l.paneKilling(id)
	}
	kctx, cancel = context.WithTimeout(ctx, killTimeout)
	_ = l.tmux.KillSession(kctx, id)
	cancel()
	return true, err
}

// joinSlot registers op on sid's slot, made if it has none, under the owner's lock. Slots are never removed: one per
// session the agent ever ran, so a slot taken can't be replaced by another.
func (o *owner) joinSlot(sid string, op *slotOp) *sessionSlot {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.joinSlotLocked(sid, op)
}

func (o *owner) joinSlotLocked(sid string, op *slotOp) *sessionSlot {
	s := o.slots[sid]
	if s == nil {
		s = &sessionSlot{held: make(chan struct{}, 1), ops: map[*slotOp]bool{}}
		o.slots[sid] = s
	}
	if op != nil {
		s.ops[op] = true
	}
	return s
}

// unregister drops op from the slot.
func (o *owner) unregister(s *sessionSlot, op *slotOp) {
	o.mu.Lock()
	defer o.mu.Unlock()
	delete(s.ops, op)
}

// slotTake is one try at a slot: taken (the caller holds it), or wait (another holds it), or neither (op was cancelled:
// it gave up and is unregistered).
type slotTake int

const (
	slotGivenUp slotTake = iota
	slotTaken
	slotWait
)

// takeSlotNow is waitSlot's step, without the wait: the slot taken for op if it is free, kept only while op is still
// wanted. A nil op is a release's turn of the slot, which nothing cancels.
func (o *owner) takeSlotNow(s *sessionSlot, op *slotOp) slotTake {
	if op != nil && op.cancelled.Load() {
		o.unregister(s, op)
		return slotGivenUp
	}
	select {
	case s.held <- struct{}{}:
		return o.took(s, op)
	default:
		return slotWait
	}
}

// took is a slot just taken for op: kept, or given back at once if op was cancelled meanwhile.
func (o *owner) took(s *sessionSlot, op *slotOp) slotTake {
	if op != nil && op.cancelled.Load() {
		o.leaveSlot(s, op)
		return slotGivenUp
	}
	return slotTaken
}

// waitSlot takes the slot for op, registered by joinSlot (takeSlotNow, waiting while another holds it). It is false, op
// unregistered, when op is cancelled or ctx ends first; the owner's lock is not held while it waits.
func (o *owner) waitSlot(ctx context.Context, s *sessionSlot, op *slotOp) bool {
	for {
		switch o.takeSlotNow(s, op) {
		case slotTaken:
			return true
		case slotGivenUp:
			return false
		}
		var stop <-chan struct{}
		if op != nil {
			stop = op.stop
		}
		select {
		case s.held <- struct{}{}:
			return o.took(s, op) == slotTaken
		case <-stop:
		case <-ctx.Done():
			if op != nil {
				o.unregister(s, op)
			}
			return false
		}
	}
}

// leaveSlot unregisters op and gives the slot back.
func (o *owner) leaveSlot(s *sessionSlot, op *slotOp) {
	if op != nil {
		o.unregister(s, op)
	}
	<-s.held
}

// keep is whether op, begun under gen, may still act: not cancelled, and no launch took a generation since, in which
// case it is cancelled here. Asked before every call an operation sends (a stop's interrupts, the one-shot interrupt).
func (o *owner) keep(op *slotOp, gen int) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.launched > gen {
		op.cancelled.Store(true)
	}
	return !op.cancelled.Load()
}

// drainSlot is a current launch's turn of the slot (release): taken once whatever held it has published, and given
// straight back.
func (o *owner) drainSlot(ctx context.Context, s *sessionSlot) error {
	if !o.waitSlot(ctx, s, nil) {
		return ctx.Err()
	}
	o.leaveSlot(s, nil)
	return nil
}

// release is a launch's release of sid under gen (releaseTurnStop): only a launch still current may cancel, and it
// cancels every operation registered on the session's slot, which it returns for the launch to take. A stale launch
// (a quit took a later generation since) cancels nothing and gets nil.
func (o *owner) release(gen int, sid string) *sessionSlot {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.gen != gen {
		return nil
	}
	s := o.joinSlotLocked(sid, nil)
	for op := range s.ops {
		op.cancel()
	}
	// The permissions of the turns before this launch: stam's replies sent, the outside ones and the asks raised
	// forgotten (an ask raised for one later finds it no longer pending, the raise's listing checks); a reply in flight
	// stays marked. A parked ask stays: its stop, given up here, hands it to this launch (publish).
	for pid, st := range o.answering {
		if st == answerSent {
			delete(o.answering, pid)
		}
	}
	clear(o.replied)
	clear(o.asked)
	return s
}

// bind reads the agent's session (turn: the row's, while it runs) and its generation in one step under the owner's
// lock: a launch, which writes a new session only under a later generation (updateIfCurrent), comes before both or
// after both.
func (o *owner) bind(turn func() string) (sid string, gen int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return turn(), o.gen
}

// bindSignal is bind for an action taken at a signal that acts later (an OpenCode turn end's pending run and reads). It
// also reports whether a launch was in flight at this step: that launch owns the agent, so the signal is of a session it
// is replacing, and what the signal starts is bound to no session for good (signalSid), decided here under the lock. A
// check where the binding is used would pass once the launch settled and wrote its own session and start.
func (o *owner) bindSignal(turn func() string) (sid string, gen int, launching bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return turn(), o.gen, o.launched > o.launchEnd
}

// execMark is the execution an OpenCode turn end may end (S-4299): seen starting in session sid under gen, or, with no
// sid, a credit for one end under gen whose start went unseen. set is false when there is none.
type execMark struct {
	set bool
	sid string
	gen int
}

// startExec is an OpenCode execution's start in session sid, bound in one step: the agent's session (turn) and
// generation as bind reads them. The execution is the agent's to end only when the row runs sid and no launch is in
// flight: a launch in flight owns the agent, so a start it meets is of the session it replaces.
//
// Known gap (S-4299): the event carries only its session, and a resume keeps the session, so an old run's start sent
// before a launch began but read only after the launch settled (stream lag spanning a whole launch) is taken as the new
// launch's.
//
// ok is whether the start is the agent's: a start refused writes nothing, so it leaves no state that nothing clears.
func (o *owner) startExec(sid string, turn func() string) (cur string, gen int, ok bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	cur, gen = turn(), o.gen
	ok = cur == sid && o.launched <= o.launchEnd
	if ok {
		o.exec = execMark{set: true, sid: sid, gen: gen}
	}
	return cur, gen, ok
}

// endExec is bindSignal for an OpenCode execution's end in session sid, with whether the end binds: the execution it
// ends started (or was credited) under the generation now, in sid, the row runs sid and no launch is in flight, all read
// in this one step. A session's mark binds every end in that session under its generation (a compaction's start and an
// execution's start both mark it, and each has its end); only a credit is taken by the end it binds, since no start
// stands behind it. Any generation bump since the mark (a launch, a quit, an archive, a switch) leaves it stale, so an
// execution of an earlier launch never ends the current one, however late its end is read.
func (o *owner) endExec(sid string, turn func() string) (cur string, gen int, launching, binds bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	cur, gen, launching = turn(), o.gen, o.launched > o.launchEnd
	m := o.exec
	binds = m.set && m.gen == gen && (m.sid == "" || m.sid == sid) && cur == sid && sid != "" && !launching
	if binds && m.sid == "" {
		o.exec = execMark{}
	}
	return cur, gen, launching, binds
}

// creditExec is a (re)connect of the server's event stream: an execution's start may have gone by in the gap, so one end
// may bind under the generation now without it. A launch in flight gets none: its own executions start once it has
// settled and its prompt went in, after this connect, so the stream shows their starts.
func (o *owner) creditExec() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.launched > o.launchEnd {
		o.exec = execMark{}
		return
	}
	o.exec = execMark{set: true, gen: o.gen}
}

// signalSid is the session a signal's action binds to: none when a launch was in flight at the signal (bindSignal).
func signalSid(sid string, launching bool) string {
	if launching {
		return ""
	}
	return sid
}

// still is whether an action bound to sid under gen (bind) may act: gen is current, so no launch, shutdown, archive or
// switch began since, and the row still runs sid, read in the same step.
func (o *owner) still(gen int, sid string, turn func() string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.gen == gen && turn() == sid
}

// writeIf runs write only while the agent still runs sid under gen, both checked in one step with the write under the
// owner's lock (still): a launch, a stop, an archive or a switch since gen was bound makes it write nothing. It reports
// whether write ran. write is a db write and takes no agent lock.
func (o *owner) writeIf(gen int, sid string, turn func() string, write func() error) (bool, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.gen != gen || turn() != sid {
		return false, nil
	}
	return true, write()
}

// raiseCheck is an ask's raise predicate (ask.go), under the owner's lock. It is dropped for a permission answered
// outside stam (the reply came first, or stam's answer found it gone) or by stam (its reply in flight or sent, even
// while the ask was being shown), one raised or parked already (the same event again), or an agent no longer running
// ask's session; it is parked, for its stop's outcome, while a stop of the session is in flight, since its interrupt
// rejects the permission; it is dropped when gen, the raise's own (-1 at its start), is no longer current.
func (o *owner) raiseCheck(ask parkedAsk, gen int, turn func() string) raiseVerdict {
	if o.answered(ask.pid) || o.asked[askKey{ask.sid, ask.pid}] || o.parkedAt(ask.pid) >= 0 {
		return raiseDrop
	}
	// A swept ask is older than any ask an event raised after its listing: that one is the dialog's now.
	if ask.swept && o.askSeq != ask.seen {
		return raiseDrop
	}
	if e := o.stops[ask.sid]; e != nil && !e.cancelled.Load() {
		ask.stop = e
		o.parked = append(o.parked, ask)
		return raiseParked
	}
	if turn() != ask.sid || (gen >= 0 && o.gen != gen) {
		return raiseDrop
	}
	return raiseGo
}

// answered is whether pid was replied to, outside stam or by stam's own reply (in flight or sent).
func (o *owner) answered(pid string) bool {
	return o.replied[pid] || o.answering[pid] != 0
}

// answeredNow is answered under the owner's lock: an ask's raise reads it where the request standing is read.
func (o *owner) answeredNow(pid string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.answered(pid)
}

func (o *owner) parkedAt(pid string) int {
	for i, p := range o.parked {
		if p.pid == pid {
			return i
		}
	}
	return -1
}

// beginRaise is the start of an ask's raise (raiseCheck): its verdict, and the generation the raise runs under.
func (o *owner) beginRaise(ask parkedAsk, turn func() string) (int, raiseVerdict) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.gen, o.raiseCheck(ask, -1, turn)
}

// mayShow is the raise's check after its listing, right before the ask is shown.
func (o *owner) mayShow(ask parkedAsk, gen int, turn func() string) raiseVerdict {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.raiseCheck(ask, gen, turn)
}

// shown is the raise's check after the ask was shown: one that still holds is remembered as raised; else the ask must
// be closed again, and is parked if a stop began meanwhile.
func (o *owner) shown(ask parkedAsk, gen int, turn func() string) raiseVerdict {
	o.mu.Lock()
	defer o.mu.Unlock()
	v := o.raiseCheck(ask, gen, turn)
	if v == raiseGo {
		o.asked[askKey{ask.sid, ask.pid}] = true
	}
	return v
}

// parkUnlisted parks an ask whose listing failed, to raise once a listing answers (retryUnlisted); armed is whether a
// retry must be scheduled, none being due.
func (o *owner) parkUnlisted(ask parkedAsk) (armed bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.parkedAt(ask.pid) < 0 {
		ask.stop, ask.launch = nil, 0
		o.parked = append(o.parked, ask)
	}
	o.unlistedWait.Store(true)
	armed = !o.retryArmed
	o.retryArmed = true
	return armed
}

// retryUnlisted queues the asks parked for a listing that failed, in their order, and ends the retry due; start is
// whether a raiser must be started (queueRaise). With none parked it takes no lock.
func (o *owner) retryUnlisted() (start bool) {
	if !o.unlistedWait.Load() {
		return false
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.retryArmed = false
	o.unlistedWait.Store(false)
	return o.queueRaiseLocked(o.takeParkedLocked(func(p parkedAsk) bool { return p.stop == nil && p.launch == 0 }))
}

// queueRaise queues asks for the agent's raiser, in their order; start is whether none runs, and the caller must start
// it (raiser): one runs from here until the queue is empty.
func (o *owner) queueRaise(asks []parkedAsk) (start bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.queueRaiseLocked(asks)
}

func (o *owner) queueRaiseLocked(asks []parkedAsk) bool {
	if len(asks) == 0 {
		return false
	}
	for _, a := range asks {
		a.stop, a.launch = nil, 0
		o.raises = append(o.raises, a)
	}
	start := !o.raiser
	o.raiser = true
	return start
}

// queueEventRaise queues the asks a permission.asked event raised, counted (askSeq). An event for a permission stam has
// answered, raised, parked, queued or is raising is the same ask again (the entry already there stands for it) and is
// neither queued nor counted: it is not a newer ask.
func (o *owner) queueEventRaise(asks []parkedAsk) (start bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	var fresh []parkedAsk
	for _, a := range asks {
		if o.answered(a.pid) || o.asked[askKey{a.sid, a.pid}] || o.parkedAt(a.pid) >= 0 {
			continue
		}
		if o.raisingAt(a.pid) {
			// The raise there stands for this event while it can complete; if it ends without the ask raised or parked
			// (a launch moved the generation under it, say), nextRaise queues the event once more.
			o.replay[a.pid] = a
			continue
		}
		fresh = append(fresh, a)
	}
	if len(fresh) == 0 {
		return false
	}
	o.askSeq++
	return o.queueRaiseLocked(fresh)
}

// bindSweep is the start of a sweep of the agent's pending permissions: the session the agent runs and its generation, the
// askSeq, in one step (bindSignal). ok is false when the agent runs no session or a launch is in flight (it owns the agent).
func (o *owner) bindSweep(turn func() string) (sid string, gen, seq int, ok bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	sid = turn()
	return sid, o.gen, o.askSeq, sid != "" && o.launched <= o.launchEnd
}

// queueSweep queues the ask a sweep chose, the newest the server lists that stam has no record of, once the sweep's listing
// is checked in one step with the queueing: the agent still runs sid under gen (still). It queues nothing when any listed
// permission is raised already, or parked, queued or being raised: that ask is the dialog's, and the others listed are not to
// replace it. An event's ask that comes after is the newer one (askSeq, read again by raiseCheck). start is whether the
// raiser must be started.
func (o *owner) queueSweep(sid string, gen, seq int, listed []parkedAsk, turn func() string) (start bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.gen != gen || turn() != sid {
		return false
	}
	var pick *parkedAsk
	for i := range listed {
		a := listed[i]
		if o.asked[askKey{a.sid, a.pid}] || o.parkedAt(a.pid) >= 0 || o.raisingAt(a.pid) {
			return false
		}
		if o.answered(a.pid) {
			continue
		}
		pick = &listed[i]
	}
	if pick == nil {
		return false
	}
	pick.swept, pick.seen = true, seq
	return o.queueRaiseLocked([]parkedAsk{*pick})
}

// armSweepRetry says whether the caller must schedule the retry of a sweep, none being due.
func (o *owner) armSweepRetry() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	armed := !o.sweepRetry
	o.sweepRetry = true
	return armed
}

// endSweepRetry ends the retry due: the sweep it schedules is running.
func (o *owner) endSweepRetry() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.sweepRetry = false
}

// raisingQueued is whether an ask for pid is queued for the raiser (not the one being raised).
func (o *owner) raisingQueued(pid string) bool {
	for _, r := range o.raises {
		if r.pid == pid {
			return true
		}
	}
	return false
}

// raisingAt is whether an ask for pid is queued for the raiser, or the one it is raising.
func (o *owner) raisingAt(pid string) bool {
	if pid == o.raisingNow {
		return true
	}
	for _, r := range o.raises {
		if r.pid == pid {
			return true
		}
	}
	return false
}

// bindAnswer is bind for an answer to the permission pid of an ask for session ask: when the agent runs no session, or another
// than the ask's, the permission is gone, and is recorded as such in the same step as the binding (replied outside stam, a
// parked ask for it dropped): every later raise and sweep reads it, and no launch can come between the binding and the mark.
func (o *owner) bindAnswer(turn func() string, pid, ask string) (sid string, gen int, gone bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	sid, gen = turn(), o.gen
	if sid != "" && (ask == "" || ask == sid) {
		return sid, gen, false
	}
	if pid != "" {
		o.replied[pid] = true
		if i := o.parkedAt(pid); i >= 0 {
			o.parked = append(o.parked[:i], o.parked[i+1:]...)
		}
	}
	return sid, gen, true
}

// nextRaise is the raiser's next ask; with none queued the raiser ends (ok false).
func (o *owner) nextRaise() (ask parkedAsk, ok bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	// The raise that just ended, if an event coalesced into it and it left the ask neither raised nor parked: the event again,
	// once, first in line; its raise binds the generation as it is now.
	if r, ok := o.replay[o.raisingNow]; ok && o.raisingNow != "" {
		delete(o.replay, o.raisingNow)
		// First in line, so an event queued after it (a newer ask) is still raised after it.
		if !o.answered(r.pid) && !o.asked[askKey{r.sid, r.pid}] && o.parkedAt(r.pid) < 0 && !o.raisingQueued(r.pid) {
			o.raises = append([]parkedAsk{r}, o.raises...)
		}
	}
	if len(o.raises) == 0 {
		o.raiser = false
		o.raisingNow = ""
		return parkedAsk{}, false
	}
	ask = o.raises[0]
	o.raisingNow = ask.pid
	o.raises = o.raises[1:]
	return ask, true
}

// settleLaunch records the outcome of the launch under gen: landed (its row written active or paused) or not (failed,
// or superseded). The asks parked for it are returned to raise if it landed, else dropped, as are any parked for an
// earlier launch: that one is superseded.
func (o *owner) settleLaunch(gen int, landed bool) []parkedAsk {
	o.mu.Lock()
	defer o.mu.Unlock()
	if gen > o.launchEnd {
		o.launchEnd, o.launchOK = gen, landed
	}
	var raise []parkedAsk
	for _, p := range o.takeParkedLocked(func(p parkedAsk) bool { return p.launch != 0 && p.launch <= gen }) {
		if landed && p.launch == gen {
			raise = append(raise, p)
		}
	}
	return raise
}

// takeParkedLocked takes the parked asks match picks, in their order.
func (o *owner) takeParkedLocked(match func(p parkedAsk) bool) []parkedAsk {
	var took []parkedAsk
	kept := o.parked[:0]
	for _, p := range o.parked {
		if match(p) {
			took = append(took, p)
		} else {
			kept = append(kept, p)
		}
	}
	o.parked = kept
	return took
}

// repliedOutside records a permission.replied for pid: false for stam's own reply, else it is remembered (raiseCheck
// reads it), a parked ask for it dropped, and true.
func (o *owner) repliedOutside(pid string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.answering[pid] != 0 {
		return false
	}
	o.replied[pid] = true
	if i := o.parkedAt(pid); i >= 0 {
		o.parked = append(o.parked[:i], o.parked[i+1:]...)
	}
	return true
}

// goneOutside records that the server no longer lists pid, found by an answer bound to sid under gen (bind): it is
// remembered as replied outside stam, so a raise whose listing came before shows nothing for it, and a parked ask for
// it is dropped. An answer of an older launch, or of a session no longer run, records nothing.
func (o *owner) goneOutside(pid string, gen int, sid string, turn func() string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.gen != gen || turn() != sid {
		return
	}
	o.replied[pid] = true
	if i := o.parkedAt(pid); i >= 0 {
		o.parked = append(o.parked[:i], o.parked[i+1:]...)
	}
}

// beginAnswer marks pid as stam's reply in flight, before the reply is sent: its permission.replied can come before the
// reply's response.
func (o *owner) beginAnswer(pid string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.answering[pid] = answerInFlight
}

// endAnswer ends the reply to pid: one sent stays marked until the next launch, one that failed is unmarked.
func (o *owner) endAnswer(pid string, sent bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if sent {
		o.answering[pid] = answerSent
	} else {
		delete(o.answering, pid)
	}
}

// startStop is the stop in flight for sid under gen, joined (started false), or a new one listed and registered on the
// session's slot, replacing (and cancelling) one of another generation or given up. The replaced stop's cancel and its
// own publication (publish) are both under the owner's lock: it gives up before its check, or has published before it
// is replaced, never in between.
func (o *owner) startStop(sid string, gen int) (e *turnStop, slot *sessionSlot, started bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.startStopLocked(sid, gen)
}

// idleGen is the agent's generation now, and whether no launch is in flight under the owner's lock: every launch
// begun (beginLaunch) has settled (settleLaunch).
func (o *owner) idleGen() (gen int, idle bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.gen, o.launchEnd >= o.launched
}

// restopTry is the re-stops of one session so far, and the earliest the next may start.
type restopTry struct {
	n    int
	next time.Time
}

// restopFirstWait and restopMaxWait bound the wait between re-stops of a session that still runs: it doubles from the
// first to the max.
var (
	restopFirstWait = time.Minute
	restopMaxWait   = 30 * time.Minute
)

// restop is startStop for a stopped agent's orphaned session (S-4254) under gen, idleGen's, read before the row was:
// refused (nil, not started) once a launch took a generation since gen or one is in flight, in one step with the
// listing, and before the session's wait since its last re-stop is over. A launch that begins after it takes a later
// generation, so the stop gives up before it sends anything (keep), and the launch's release waits for the stop's slot.
func (o *owner) restop(sid string, gen int, now time.Time) (e *turnStop, slot *sessionSlot, started bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.launched > gen || o.launchEnd < o.launched {
		return nil, nil, false
	}
	try := o.restops[sid]
	if now.Before(try.next) {
		return nil, nil, false
	}
	e, slot, started = o.startStopLocked(sid, gen)
	if started {
		wait := restopMaxWait
		if try.n < 5 {
			wait = min(restopFirstWait<<try.n, restopMaxWait)
		}
		if o.restops == nil {
			o.restops = map[string]restopTry{}
		}
		o.restops[sid] = restopTry{n: try.n + 1, next: now.Add(wait)}
	}
	return e, slot, started
}

// noteFailureLocked is whether a stop failure of sid is to be reported: the first since the last confirmation (stopNoted).
// Under the owner's lock (publish's write).
func (o *owner) noteFailureLocked(sid string) bool {
	if o.stopNoted[sid] {
		return false
	}
	if o.stopNoted == nil {
		o.stopNoted = map[string]bool{}
	}
	o.stopNoted[sid] = true
	return true
}

// confirmedLocked forgets sid's reported failure: its stop is confirmed. Under the owner's lock.
func (o *owner) confirmedLocked(sid string) { delete(o.stopNoted, sid) }

// restopped forgets sid's re-stops: the server no longer runs it, so a later orphan of it is stopped at once.
func (o *owner) restopped(sid string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	delete(o.restops, sid)
}

// startStopLocked is startStop, under the owner's lock.
func (o *owner) startStopLocked(sid string, gen int) (e *turnStop, slot *sessionSlot, started bool) {
	// A stop of the same or a newer generation, still in flight, is joined: an older request never replaces a newer stop.
	live := o.stops[sid]
	if live != nil && !live.cancelled.Load() && live.gen >= gen {
		return live, nil, false
	}
	if live != nil {
		live.cancel()
	}
	e = &turnStop{slotOp: slotOp{stop: make(chan struct{})}, done: make(chan struct{}), gen: gen, owner: o}
	o.stops[sid] = e
	return e, o.joinSlotLocked(sid, &e.slotOp), true
}

// stopUnder is the stop in flight for sid under gen or a newer generation, nil when none is or it is an older one's.
func (o *owner) stopUnder(sid string, gen int) *turnStop {
	o.mu.Lock()
	defer o.mu.Unlock()
	if e := o.stops[sid]; e != nil && e.gen >= gen {
		return e
	}
	return nil
}

// await waits for the stop e to end: its outcome, or errStopGivenUp when it was given up, since a stop given up
// confirmed nothing. The outcome is read under the lock it was published under.
func (o *owner) await(ctx context.Context, e *turnStop) error {
	select {
	case <-e.done:
	case <-ctx.Done():
		return ctx.Err()
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if e.cancelled.Load() {
		return errStopGivenUp
	}
	return e.err
}

// stopOf is the stop in flight for sid, nil for none.
func (o *owner) stopOf(sid string) *turnStop {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.stops[sid]
}

// publish ends the stop e with err, the outcome of its calls: one check that it is still the agent's (not given up,
// and no launch took a generation since), then write (the row's note and event) with the outcome, then e unlisted, all
// under the owner's lock; then its waiters answered. A stop no longer the agent's confirmed nothing: its err is dropped.
// checked, when set, runs between the check and the write.
//
// It returns the asks parked for the stop (raiseCheck), unless it confirmed the session stopped: its interrupt rejected
// their permissions. A stop given up or failed may have left them pending, and its caller raises them again; but one a
// launch gave up hands them to that launch: they stay parked until it lands (settleLaunch), its row running the session
// again, or are dropped if it lands nowhere.
func (o *owner) publish(sid string, e *turnStop, err error, checked func(), write func(err error, givenUp bool)) []parkedAsk {
	o.mu.Lock()
	if e.cancelled.Load() || o.launched > e.gen {
		e.cancelled.Store(true)
		err = nil
	}
	if checked != nil {
		checked()
	}
	write(err, e.cancelled.Load())
	e.err = err
	if o.stops[sid] == e {
		delete(o.stops, sid)
	}
	parked := o.takeParkedLocked(func(p parkedAsk) bool { return p.stop == e })
	switch {
	case err == nil && !e.cancelled.Load():
		parked = nil
	case o.launched > e.gen && o.launchEnd < o.launched:
		for _, p := range parked {
			p.stop, p.launch = nil, o.launched
			o.parked = append(o.parked, p)
		}
		parked = nil
	case o.launched > e.gen && !o.launchOK:
		parked = nil
	}
	o.mu.Unlock()
	close(e.done)
	return parked
}

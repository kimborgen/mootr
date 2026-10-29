package lifecycle

import "time"

// The OpenCode compaction state (S-4237 PR 4e), held by the agent's owner and changed only by the transitions below. Each
// one is checked, under owner.mu, against the binding (turnBind) of the action that asks: the session it saw and the
// generation it was taken under at the signal, or, for an action bound from a row it read, that row's start. A stale
// actor, one that saw an earlier session, launch or start, finds the state refused, and never changes a successor's. The
// db writes the actions make go through the same check (turnBind.write, in one step with it), and no call to the server
// is made under mu: the result of one comes back as another transition.

// ocComp is the compaction in flight or just done for the binding b that reserved it.
type ocComp struct {
	b       *turnBind
	running bool
	at      time.Time
}

// ocMark is the post-compaction size's mark: the session whose next size report is the compaction's measured size. It
// belongs to the session, whichever launch reports in it: the compaction is the session's, and survives the TUI's
// restart.
type ocMark struct{ sid string }

// ocNotes is the instructions of the compaction the server is about to run, and the binding that set them (nil for the
// plugin route's).
type ocNotes struct {
	text string
	by   *turnBind
}

type reserveResult int

const (
	reserveGone reserveResult = iota
	reserveBusy
	reserveOK
)

// held is whether b may act now: its generation, and the session the row runs (and, for a row-bound b, its start). Under
// owner.mu.
func (o *owner) held(b *turnBind) bool {
	return b.sid != "" && o.gen == b.gen && b.turn() == b.sid
}

// busyLocked is whether a compaction of b's session runs or just ran (TS's dedupe). One of another session is a
// predecessor's: it doesn't block this one.
func (o *owner) busyLocked(b *turnBind) bool {
	c := o.comp
	return c != nil && c.b.sid == b.sid && (c.running || time.Since(c.at) < compactDedupe)
}

// busy is whether a compaction of b's session runs or just ran.
func (o *owner) busy(b *turnBind) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.busyLocked(b)
}

// reserve takes the compaction slot for b, before any I/O: refused if b is stale (reserveGone) or one of its session runs
// or just ran (reserveBusy).
func (o *owner) reserve(b *turnBind) reserveResult {
	o.mu.Lock()
	defer o.mu.Unlock()
	switch {
	case !o.held(b):
		return reserveGone
	case o.busyLocked(b):
		return reserveBusy
	}
	o.comp = &ocComp{b: b, running: true}
	return reserveOK
}

// unreserve ends a reservation that never started a compaction. Only b's own: a successor's is not touched.
func (o *owner) unreserve(b *turnBind) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.comp != nil && o.comp.b == b {
		o.comp = nil
	}
}

// finish ends b's compaction: done (the dedupe window starts) or failed (the slot is free). Only b's own.
func (o *owner) finish(b *turnBind, ok bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.comp == nil || o.comp.b != b {
		return
	}
	if ok {
		o.comp.running, o.comp.at = false, time.Now()
	} else {
		o.comp = nil
	}
}

// setNotes keeps the instructions of the compaction b asks the server for, only while b holds.
func (o *owner) setNotes(b *turnBind, text string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.held(b) {
		return false
	}
	o.notes = ocNotes{text: text, by: b}
	return true
}

// clearNotes drops b's instructions (its call failed); instructions set by another are left.
func (o *owner) clearNotes(b *turnBind) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.notes.by == b {
		o.notes = ocNotes{}
	}
}

// setNotesRoute and takeNotes are the plugin route's side: the instructions the server reads once.
func (o *owner) setNotesRoute(text string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.notes = ocNotes{text: text}
}

// takeNotesFor is the plugin's take for session sid, bound where its request began (owner.bindSignal gave gen, and refused
// a launch in flight there): the instructions, once, only while that generation is current, so no launch has begun since,
// and sid is the session the row runs (turn, read under the lock). Instructions a compaction set (ocNotes.by) go only
// while that compaction's session and generation are still the agent's. Any other asker leaves them in place.
func (o *owner) takeNotesFor(gen int, sid string, turn func() string) string {
	o.mu.Lock()
	defer o.mu.Unlock()
	if sid == "" || o.gen != gen || turn() != sid {
		return ""
	}
	// The compaction's own binding is compared by its session and generation, not asked again (its turn reads the row
	// with the context of the request that made it, which is over by now).
	if by := o.notes.by; by != nil && (by.sid != sid || by.gen != o.gen) {
		return ""
	}
	t := o.notes.text
	o.notes = ocNotes{}
	return t
}

func (o *owner) takeNotes() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	t := o.notes.text
	o.notes = ocNotes{}
	return t
}

// setMark marks b's session as just compacted: its next size report is the measured post-compaction size. Only while b
// holds, in one step with the check, with write (the cache mark's event) made under the same check.
func (o *owner) setMark(b *turnBind, write func() error) (bool, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.held(b) {
		return false, nil
	}
	if err := write(); err != nil {
		return false, err
	}
	o.mark = &ocMark{sid: b.sid}
	return true, nil
}

// measure is a size report's take of the mark: only a report of the marked session that still holds takes it, and it is
// taken only once write (the measured size, in the report's own transaction) has landed. A report of another session, a
// stale one, or one whose write was refused, leaves the mark for the next report of its session.
func (o *owner) measure(b *turnBind, write func() (bool, error)) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.mark == nil || o.mark.sid != b.sid || !o.held(b) {
		return false
	}
	if wrote, err := write(); err != nil || !wrote {
		return false
	}
	o.mark = nil
	return true
}

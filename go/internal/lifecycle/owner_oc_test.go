package lifecycle

import (
	"errors"
	"testing"
	"time"
)

// The OpenCode compaction state's transitions (owner_oc.go), on a bare owner and bindings with their own idea of the
// agent's session.

func ocBind(o *owner, sid string, gen int, runs *string) *turnBind {
	return &turnBind{o: o, gen: gen, sid: sid, turn: func() string { return *runs }}
}

func TestOwnerReserve(t *testing.T) {
	o := newOwner()
	runs := "s1"
	b1 := ocBind(o, "s1", 0, &runs)
	if got := o.reserve(b1); got != reserveOK {
		t.Fatalf("reserve: %v", got)
	}
	if got := o.reserve(ocBind(o, "s1", 0, &runs)); got != reserveBusy {
		t.Errorf("a second compaction of the session: %v", got)
	}
	// A binding that doesn't hold (another generation, or the agent runs another session) reserves nothing.
	if got := o.reserve(ocBind(o, "s1", 1, &runs)); got != reserveGone {
		t.Errorf("a stale generation: %v", got)
	}
	other := "s2"
	if got := o.reserve(ocBind(o, "s1", 0, &other)); got != reserveGone {
		t.Errorf("a session the agent left: %v", got)
	}
	if got := o.reserve(ocBind(o, "", 0, &runs)); got != reserveGone {
		t.Errorf("an empty session: %v", got)
	}
	// Done, the dedupe window holds the same session; another session's compaction isn't held by it.
	o.finish(b1, true)
	if got := o.reserve(ocBind(o, "s1", 0, &runs)); got != reserveBusy {
		t.Errorf("inside the dedupe window: %v", got)
	}
	runs = "s2"
	b2 := ocBind(o, "s2", 0, &runs)
	if got := o.reserve(b2); got != reserveOK {
		t.Errorf("another session after a predecessor's: %v", got)
	}
	// The predecessor's end, late, never frees the successor's slot.
	o.finish(b1, false)
	o.unreserve(b1)
	if !o.busy(b2) {
		t.Error("a stale end freed the successor's reservation")
	}
	o.finish(b2, false)
	if o.busy(b2) {
		t.Error("a failed compaction kept the slot")
	}
	o.comp = &ocComp{b: b1, at: time.Now().Add(-2 * compactDedupe)}
	if o.busy(b1) {
		t.Error("the dedupe window never ends")
	}
}

func TestOwnerNotes(t *testing.T) {
	o := newOwner()
	runs := "s1"
	b := ocBind(o, "s1", 0, &runs)
	if !o.setNotes(b, "keep") || o.notes.text != "keep" {
		t.Fatal("the instructions weren't kept")
	}
	if o.setNotes(ocBind(o, "s1", 3, &runs), "stale") || o.notes.text != "keep" {
		t.Error("a stale binding set instructions")
	}
	o.clearNotes(ocBind(o, "s1", 0, &runs))
	if o.notes.text != "keep" {
		t.Error("another binding cleared the instructions")
	}
	o.clearNotes(b)
	if o.notes.text != "" {
		t.Error("a binding's own instructions weren't cleared")
	}
	o.setNotesRoute("route")
	if got := o.takeNotes(); got != "route" || o.takeNotes() != "" {
		t.Errorf("the route's instructions %q, taken once", got)
	}
}

func TestOwnerMark(t *testing.T) {
	o := newOwner()
	runs := "s1"
	b := ocBind(o, "s1", 0, &runs)
	wrote := 0
	write := func() error { wrote++; return nil }
	if ok, _ := o.setMark(ocBind(o, "s1", 1, &runs), write); ok || wrote != 0 || o.mark != nil {
		t.Errorf("a stale binding set the mark (ok %v, wrote %d)", ok, wrote)
	}
	if ok, err := o.setMark(b, func() error { return errors.New("x") }); ok || err == nil || o.mark != nil {
		t.Errorf("a refused write set the mark: %v %v", ok, err)
	}
	if ok, _ := o.setMark(b, write); !ok || o.mark == nil || o.mark.sid != "s1" {
		t.Fatal("the mark wasn't set")
	}
	measured := func(b *turnBind, ok bool) bool {
		return o.measure(b, func() (bool, error) { return ok, nil })
	}
	other := "s2"
	if measured(ocBind(o, "s2", 0, &other), true) || o.mark == nil {
		t.Error("a report of another session took the mark")
	}
	if measured(ocBind(o, "s1", 4, &runs), true) || o.mark == nil {
		t.Error("a stale report took the mark")
	}
	if measured(b, false) || o.mark == nil {
		t.Error("a report whose write was refused took the mark")
	}
	if !measured(b, true) || o.mark != nil {
		t.Error("the marked session's report didn't take the mark")
	}
	if measured(b, true) {
		t.Error("the mark was taken twice")
	}
}

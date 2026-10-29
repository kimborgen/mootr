package lifecycle

import (
	"context"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/db"
)

// interruptSteps are src/adapters/claude.ts interrupt's waits: after each Esc, and between looks for the confirming
// "Interrupted" line (20 of them). Tests shorten them.
var interruptSteps = struct{ esc, look time.Duration }{400 * time.Millisecond, 250 * time.Millisecond}

// interrupt is src/adapters/claude.ts interrupt, the cost switch's courtesy at its deadline: Esc stops a running turn,
// as the human's does. With vim keys on, the first Esc only leaves INSERT mode, so a second one stops the turn. Each
// Esc goes in only while the turn still runs (stam's state and the spinner on screen), so an idle input, or a human's
// draft, is never touched; INSERT mode isn't restored, since an `i` typed then would land in the input. Claude Code
// runs no hook for an interrupted turn: it counts as confirmed only when a new "Interrupted" line appears. An OpenCode
// turn is interrupted in the shared server (openCodeInterrupt). Codex has no interrupt here (false).
func (l *Lifecycle) interrupt(ctx context.Context, a db.Agent) (bool, error) {
	if a.Harness == "opencode" {
		return l.openCodeInterrupt(ctx, a), nil
	}
	if a.Harness != "claude" {
		return false, nil
	}
	screen := func() string {
		if !l.tmux.HasSession(ctx, a.ID) {
			return ""
		}
		s, _ := l.tmux.CapturePane(ctx, a.ID)
		return s
	}
	running := func() bool {
		cur, err := l.db.GetAgent(ctx, a.ID)
		return err == nil && (cur.Activity == "working" || cur.Activity == "starting") && claude.ShowsSpinner(screen())
	}
	before := claude.InterruptMarks(screen())
	for i := 0; i < 2 && running(); i++ {
		insert := claude.ShowsInsert(screen())
		if err := l.tmux.SendKeys(ctx, a.ID, "Escape"); err != nil {
			return false, err
		}
		if err := sleep(ctx, interruptSteps.esc); err != nil {
			return false, err
		}
		if !insert {
			break
		}
	}
	for range 20 {
		if claude.InterruptMarks(screen()) > before {
			return true, nil
		}
		if err := sleep(ctx, interruptSteps.look); err != nil {
			return false, err
		}
	}
	return false, nil
}

// Interrupt is interrupt for the agent view's Esc (src/adapters/claude-view.ts stop).
func (l *Lifecycle) Interrupt(ctx context.Context, a db.Agent) (bool, error) {
	return l.interrupt(ctx, a)
}

// openCodeInterrupt is src/adapters/opencode.ts interrupt: one interrupt of the agent's session in the shared server,
// confirmed when the server no longer lists it as active; a state it can't read is no confirmation. It holds the
// session's slot (sessionSlot) while it acts, as a stop does: a launch since it began cancels it, and waits for it.
func (l *Lifecycle) openCodeInterrupt(ctx context.Context, a db.Agent) bool {
	if cur, err := l.db.GetAgent(ctx, a.ID); err == nil {
		a = cur
	}
	sid := l.serverTurn(a)
	if sid == "" {
		return false
	}
	o := l.ownerOf(a.ID)
	gen := o.now()
	op := slotOp{stop: make(chan struct{})}
	slot := o.joinSlot(sid, &op)
	if !o.waitSlot(ctx, slot, &op) {
		return false
	}
	defer o.leaveSlot(slot, &op)
	// The slot's holder from here: it takes no serial and no transition lock (owner).
	keep := func() bool { return o.keep(&op, gen) }
	return l.opencode.InterruptSession(ctx, sid, 1, keep) && keep()
}

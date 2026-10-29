package lifecycle

import (
	"context"
	"errors"
	"time"

	"stam/internal/adapters/opencode"
	"stam/internal/jsjson"
)

// What the OpenCode view (internal/agentview, src/adapters/opencode-view.ts) takes from the lifecycle: the server's events,
// and the session an agent runs, bound for a send.

// SetOpenCodeViewer sets who is told of each event of the shared server's stream, after the lifecycle has handled it: the
// agent view's live windows. fn runs on the stream's goroutine with no lifecycle or owner lock held, so it must not block:
// it applies the event to a window, which reads the agent's row once and takes only the window's own lock.
func (l *Lifecycle) SetOpenCodeViewer(fn func(typ string, data *jsjson.Object)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.openCodeViewer = fn
}

// viewEvent tells the viewer of an event. It runs after the event's own handling (a deferred call of onOpenCodeEvent), so
// a window never delays, and never comes before, the turn end's, the compaction's or the reconnect's own steps.
func (l *Lifecycle) viewEvent(ev opencode.Event) {
	l.mu.Lock()
	fn := l.openCodeViewer
	l.mu.Unlock()
	if fn != nil {
		fn(ev.Type, ev.Data)
	}
}

// viewCloseTimeout bounds the close of an ask after a reply from the view (a variable for the tests).
var viewCloseTimeout = 10 * time.Second

// ViewSend runs a send of the OpenCode view (a prompt, a permission reply) in the session the agent runs now, as an
// operation on that session's slot, the way answerOpenCode does: the session and the generation are bound together under
// the owner's lock (bindSignal), the slot is taken (a stop's or a launch's release is ordered after the send, and a launch's
// cancels one still waiting), and the binding is checked again with the slot held, just before do. do is the call to the
// server; it runs with the slot held and no mutex, so a stop begun meanwhile waits for it, and a relaunch's release drains
// the slot after it: the send can't reach a session after the agent's next one has taken over. pid is the permission a reply
// answers ("" for a prompt), marked in flight around do as an ask's answer is. It is false, with do not called, when the
// agent runs no session, a launch is in flight, or it has moved on or stopped by the time the slot is held.
//
// A reply that went through settles the ask raised for its permission, as an answer from the human's thread does: the mark
// in flight makes permission.replied for it ignored (openCodeReplied), so nothing else closes the ask. It is closed after the
// slot is given back, outside every lock, with the predicate-based close (closeAsk): only the ask for pid.
func (l *Lifecycle) ViewSend(ctx context.Context, id, pid string, do func(sid string) error) (bool, error) {
	sent, err := l.viewSend(ctx, id, pid, do)
	if sent && err == nil && pid != "" {
		l.mu.Lock()
		d := l.dialogs
		l.mu.Unlock()
		if d != nil {
			// The reply went through, whatever became of the request that made it: a client that left right after must not
			// leave the ask open, since nothing else closes it. A failure is recorded by closeAsk (a permission-error
			// event with the error's text only).
			cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), viewCloseTimeout)
			defer cancel()
			l.closeAsk(cctx, d, id, pid)
		}
	}
	return sent, err
}

func (l *Lifecycle) viewSend(ctx context.Context, id, pid string, do func(sid string) error) (bool, error) {
	o := l.ownerOf(id)
	turn := l.runningTurn(ctx, id)
	l.turnAt(id, "view-start")
	sid, gen, launching := o.bindSignal(turn)
	if sid == "" || launching {
		return false, nil
	}
	op := slotOp{stop: make(chan struct{})}
	slot := o.joinSlot(sid, &op)
	if !o.waitSlot(ctx, slot, &op) {
		return false, ctx.Err()
	}
	defer o.leaveSlot(slot, &op)
	// The slot's holder from here: it takes no serial and no transition lock (owner).
	l.turnAt(id, "view-slot")
	if !o.keep(&op, gen) || !o.still(gen, sid, turn) {
		return false, nil
	}
	if pid != "" {
		// Marked before the reply: OpenCode's permission.replied for it can come before the reply's response.
		o.beginAnswer(pid)
	}
	err := do(sid)
	if pid != "" {
		o.endAnswer(pid, err == nil)
	}
	return true, err
}

// OpenCodeCall is one call to the shared OpenCode server, for the view's reads and sends (the errors are the method, the
// path and the status only).
func (l *Lifecycle) OpenCodeCall(ctx context.Context, method, path string, body jsjson.Value) (jsjson.Value, error) {
	if l.opencode == nil {
		return nil, errNoOpenCode
	}
	return l.opencode.Call(ctx, method, path, body)
}

var errNoOpenCode = errors.New("OpenCode isn't running on this daemon")

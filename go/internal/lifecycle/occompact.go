package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// OpenCode compaction and MCP reconnect (src/adapters/opencode.ts compact, reconnectMcp; S-4237 PR 4e).
//
// Every entry binds at its signal (turnBind): a signal that has a generation (a turn end's report, a pending action's
// runner at the turn end) takes it before it reads the row; an entry that has only a row its caller read (a request, the
// reconnect, a pending action run by hand) binds to that row's session and start (rowBinding). The binding goes to the
// owner, which refuses a stale one before it reserves the compaction, claims the agent, sets or takes its pending
// action, or lets the call go (owner_oc.go). The compaction's state is the owner's: its reservation, the instructions
// the server will take, the mark of the post-compaction size, each changed only through a transition that checks the
// binding. The call to the server runs outside every lock, and its result comes back as another transition: the marks
// and the prompt are made only while the binding still holds, and a failure puts back the idle state the claim replaced
// only for the binding that made it. A pending compaction stays on the row as the agent's, and is taken only by a binding
// that holds (a launch since leaves it to that launch's turn end). The Claude paths (compact.go) are not touched.

// ocGone is what a compaction that finds its agent no longer running the session it was bound to answers: nothing was
// done, and it is no error.
func ocGone(a db.Agent) string { return a.Name + " no longer runs its session; nothing was compacted" }

// errCompactGone is an OpenCode compaction that found its agent no longer running its session: nothing was sent.
var errCompactGone = errors.New("the agent no longer runs the session")

// SetCompactInstructions is src/context.ts setCompactInstructions: the instructions of the compaction the server is
// about to run for the agent, none clearing them.
func (l *Lifecycle) SetCompactInstructions(id, text string) { l.ownerOf(id).setNotesRoute(text) }

// TakeCompactInstructions is src/context.ts takeCompactInstructions: the instructions set for the agent, once.
func (l *Lifecycle) TakeCompactInstructions(id string) string { return l.ownerOf(id).takeNotes() }

// ocDropped is droppedCompaction for a request bound to b: the event is recorded only while b holds, so a stale request
// that ends at the busy check leaves the successor's events alone.
func (l *Lifecycle) ocDropped(ctx context.Context, a db.Agent, b *turnBind, reason string) string {
	b.event(ctx, "compact:dropped", reasonEvent{Reason: reason})
	return a.Name + " is already compacting or was just compacted; this request is dropped"
}

func ocPending(instructions, prompt, reason string) *jsjson.Object {
	p := jsjson.NewObject("type", "compact")
	if instructions != "" {
		p.Set("instructions", instructions)
	}
	if prompt != "" {
		p.Set("prompt", prompt)
	}
	p.Set("reason", reason)
	return p
}

// ocRequest is requestCompaction for an OpenCode agent: compacted when its turn ends. b is the binding of the signal that
// asks (a turn end's forced compaction); none binds to the row a. A request for an agent that has left the session it
// was bound to is a no-op.
func (l *Lifecycle) ocRequest(ctx context.Context, a db.Agent, instructions, prompt, reason string, b *turnBind) (string, error) {
	if b == nil {
		b = l.rowBinding(ctx, a)
	}
	l.turnAt(a.ID, "request-bound")
	if !b.still() {
		return ocGone(a), nil
	}
	if b.o.busy(b) {
		return l.ocDropped(ctx, a, b, reason), nil
	}
	p := ocPending(instructions, prompt, reason)
	l.turnAt(a.ID, "request-checked")
	if isIdle(a) {
		return l.ocCompactNow(ctx, a, p, b)
	}
	if !b.update(ctx, db.Field{Col: "pending_action", Val: text(p)}) {
		return ocGone(a), nil
	}
	b.event(ctx, "pending", raw(p))
	return l.waiting(a), nil
}

// ocRunPending runs the pending compaction p of the row a for the binding b (the pending runner's, at a turn end or by
// hand). It stays on the row until the agent is claimed for it: the claim and the take are one step under the owner's
// lock, so a runner a launch overtook leaves it pending for that launch, and a compaction refused for any reason (busy,
// blocked, the agent not idle) is still the agent's pending one.
func (l *Lifecycle) ocRunPending(ctx context.Context, a db.Agent, p *jsjson.Object, b *turnBind) (string, error) {
	if a.PendingAction == nil {
		return "", nil
	}
	return l.ocCompact(ctx, a, p, b, *a.PendingAction)
}

// ocCompactNow is compactNow for an OpenCode agent bound to b, with no pending action to take.
func (l *Lifecycle) ocCompactNow(ctx context.Context, a db.Agent, p *jsjson.Object, b *turnBind) (string, error) {
	return l.ocCompact(ctx, a, p, b, "")
}

// ocCompact is compactNow for an OpenCode agent bound to b: the compaction is reserved, the agent claimed (only while b
// holds, in the claim's own transaction, with take, the pending action it runs, cleared in the same step), and the
// server asked to compact the session, with no relaunch (TS: relaunch false). The server's events set the agent's state
// afterwards.
func (l *Lifecycle) ocCompact(ctx context.Context, a db.Agent, p *jsjson.Object, b *turnBind, take string) (string, error) {
	switch b.o.reserve(b) {
	case reserveGone:
		return ocGone(a), nil
	case reserveBusy:
		return l.ocDropped(ctx, a, b, pstr(p, "reason")), nil
	}
	// setPending leaves the compaction as the agent's pending action; one being run from the row already is.
	setPending := func(v *jsjson.Object) bool {
		return take != "" || b.update(ctx, db.Field{Col: "pending_action", Val: text(v)})
	}
	if ok, reason := l.admit(ctx, a.ID, "compact"); !ok {
		b.o.unreserve(b)
		pending := jsjson.NewObject("type", "compact")
		for _, k := range without(p, "type").Keys() {
			v, _ := p.Get(k)
			pending.Set(k, v)
		}
		if !setPending(pending) {
			return ocGone(a), nil
		}
		return a.Name + " is blocked (" + reason + "); it compacts after it runs again", nil
	}
	// a may be stale (the idle sweep's row, a request's): the agent is claimed only if it is still idle in the same idle
	// period, and runs the bound session. A turn started since means it isn't idle: the compaction waits for its end.
	l.turnAt(a.ID, "compact-bound")
	claimed, taken := false, true
	_, err := b.write(func() error {
		l.turnAt(a.ID, "compact-claim")
		var e error
		claimed, e = l.db.ClaimIdleWhile(ctx, a.ID, a.IdleSince, "compacting: "+pstr(p, "reason"), b.ok)
		if e != nil || !claimed || take == "" {
			return e
		}
		if taken, e = l.db.TakePendingAction(ctx, a.ID, take); e == nil && !taken {
			// Cleared or replaced by someone else meanwhile: not this compaction's to run. The claim is put back.
			_, e = l.db.UpdateAgentIf(ctx, a.ID, b.ok, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "compaction not done"})
		}
		return e
	})
	if err != nil || (claimed && !taken) {
		b.o.unreserve(b)
		return "", err
	}
	if !claimed {
		b.o.unreserve(b)
		if !b.still() || !setPending(p) {
			return ocGone(a), nil
		}
		if take == "" {
			b.event(ctx, "pending", raw(p))
		}
		return l.waiting(a), nil
	}
	l.turnAt(a.ID, "claimed")
	err = l.ocTrack(ctx, a, p, b)
	if err == nil {
		return "", nil
	}
	l.restoreCompacting(ctx, b)
	if errors.Is(err, errCompactGone) {
		return ocGone(a), nil
	}
	return "", err
}

// ocTrack is trackCompaction for an OpenCode compaction: a `compact` event with an operation id, then `compact:done` or
// `compact:failed`. Its slot is the owner's, ended only for b.
func (l *Lifecycle) ocTrack(ctx context.Context, a db.Agent, p *jsjson.Object, b *turnBind) error {
	op, err := newOp()
	if err != nil {
		b.o.finish(b, false)
		return err
	}
	ev := copyObject(p)
	ev.Set("op", op)
	l.event(ctx, a.ID, "compact", raw(ev))
	if err := l.ocCompactCall(ctx, a, p, b); err != nil {
		b.o.finish(b, false)
		l.event(ctx, a.ID, "compact:failed", opFailedEvent{Op: op, Error: err.Error()})
		return err
	}
	b.o.finish(b, true)
	l.event(ctx, a.ID, "compact:done", opEvent{Op: op})
	return nil
}

// ocCompactCall is src/adapters/opencode.ts compact: the instructions are kept for the server's compaction, and the
// session's compaction is asked for (POST /api/session/SID/compact). The call is made only while b holds, rechecked
// right before it; once it returns, the compaction is marked, and its prompt queued in the bound session (never the
// row's: a stopped agent keeps its session_id), only while b still holds.
func (l *Lifecycle) ocCompactCall(ctx context.Context, a db.Agent, p *jsjson.Object, b *turnBind) error {
	l.turnAt(a.ID, "compact")
	// The check right before the call is the instructions' own: kept only while b holds, in one step with the check.
	if !b.o.setNotes(b, pstr(p, "instructions")) {
		return errCompactGone
	}
	if err := l.opencode.Compact(ctx, b.sid); err != nil {
		b.o.clearNotes(b)
		return err
	}
	l.turnAt(a.ID, "compacted")
	if !l.ocMark(ctx, a, b) {
		return nil
	}
	if prompt := compactPrompt(p); prompt != "" && b.still() {
		if err := l.opencode.Prompt(ctx, b.sid, prompt); err != nil {
			slog.Warn("opencode: prompt not delivered", "agent", a.ID, "err", err)
		}
	}
	return nil
}

// ocMark is markCompacted for a compaction bound to b: the cache mark is recorded and the session's measurement mark set
// together, only while b holds (owner.setMark). It reports whether b held.
func (l *Lifecycle) ocMark(ctx context.Context, a db.Agent, b *turnBind) bool {
	l.turnAt(a.ID, "compact-mark")
	marked, err := b.o.setMark(b, func() error {
		if m, ok := l.pendingColdMark(ctx, a.ID); !ok || m.Cause != "compaction" {
			cur, err := l.db.GetAgent(ctx, a.ID)
			if err != nil {
				return err
			}
			held, err := l.db.AddEventWhile(ctx, a.ID, "cache:mark", coldMark{Cause: "compaction", Seen: l.transcripts.LastID(deref(cur.TranscriptPath))}, b.ok)
			if err != nil {
				return err
			}
			if !held {
				return errCompactGone
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, errCompactGone) {
		slog.Warn("lifecycle: compaction not marked", "agent", a.ID, "err", err)
	}
	l.turnAt(a.ID, "compact-marked")
	return marked
}

// restoreCompacting puts back the idle state a compaction claimed (ClaimIdle), for one that failed or sent nothing, so the
// agent isn't left "compacting" with nothing to end it. Only for the binding that claimed, and only while the row still
// reads the claim: an agent stopped, relaunched or already moved on by the server's events keeps its own state.
func (l *Lifecycle) restoreCompacting(ctx context.Context, b *turnBind) {
	claimed := func(a db.Agent) bool {
		return b.ok(a) && a.Activity == "working" && strings.HasPrefix(deref(a.ActivityDetail), "compacting: ")
	}
	held := false
	wrote, err := b.write(func() error {
		var e error
		held, e = l.db.UpdateAgentIf(ctx, b.id, claimed, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "compaction not done"})
		return e
	})
	if err != nil {
		slog.Error("lifecycle: update failed", "agent", b.id, "err", err)
	}
	if wrote && held {
		l.SchedulePush(b.id)
	}
}

// reconnectOpenCode is src/adapters/opencode.ts reconnectMcp: the shared server keeps one MCP client per directory, and
// connect replaces the one for the directory it names, so it names the agent's (mcpScope). It is bound to the row its
// caller read: while the agent runs that session from that start, in that directory. proceed, when given, is asked right
// before the call and false sends nothing (a turn started meanwhile). An agent stopped, archived or relaunched since,
// into another session or the same, is left alone, as no error, with false. Whether the call was made is reported.
func (l *Lifecycle) reconnectOpenCode(ctx context.Context, a db.Agent, proceed func() bool) (bool, error) {
	b := l.rowBinding(ctx, a)
	if !b.still() {
		return false, nil
	}
	fresh, err := l.db.GetAgent(ctx, a.ID)
	if err != nil {
		return false, err
	}
	if fresh.Cwd != a.Cwd {
		return false, nil
	}
	l.turnAt(a.ID, "reconnect")
	if proceed != nil && !proceed() {
		return false, nil
	}
	if !b.still() {
		return false, nil
	}
	return true, l.opencode.ConnectMCP(ctx, a.Cwd)
}

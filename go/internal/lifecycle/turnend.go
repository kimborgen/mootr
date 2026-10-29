package lifecycle

import (
	"context"
	"log/slog"
	"time"

	"stam/internal/db"
)

// An OpenCode turn's end (src/adapters/opencode.ts updateContext, S-4237).
//
// Ownership. Nothing here owns state of its own. Every agent write is the agent owner's (owner.go): a usage or context
// write is made through owner.writeIf with the session and generation bound when the turn ended, so a stop, a launch, an
// archive or a session switch since writes nothing. The lock order is the daemon's (jobs.go): jobTracker.mu,
// Lifecycle.mu, owner.mu, the database. No call to the server is made under any of them; owner.mu is held for one check
// and one write.
//
// The one goroutine is a turn end's reads (readTurnEnd): one per execution end, through goBG, ended by the server's call
// timeout, writing only through the owner's guard. It is not a loop and starts nothing.

// turnAt runs a test's hook at a step of a turn end's reads, a compaction or a reconnect.
func (l *Lifecycle) turnAt(id, step string) {
	if l.turnStep != nil {
		l.turnStep(id, step)
	}
}

// readTurnEnd is TS updateContext, run after the idle write for the execution that ended in session sid under gen
// (bound with the session in one step). The reads and their writes are off the event stream, so a slow or failing
// server never delays the idle write already made, or the next event, or the next turn.
func (l *Lifecycle) readTurnEnd(id, sid string, gen int) {
	l.goBG(func(ctx context.Context) { l.turnEndReads(ctx, id, sid, gen) })
}

// turnBind is what an OpenCode action saw when it was bound: the session the agent ran and the generation it was taken
// under (owner.bindSignal, or rowBinding). An action bound at a signal (a turn end, a pending action's runner) takes the generation before it
// reads the row. An action bound to a row its caller read (a request, the reconnect) takes it where it starts, which is
// later than that read, so it also carries that row's start (epoch: the launch or resume the row shows), and holds only
// while the row still shows it with no launch in flight. What it writes it writes only while the agent still runs that
// session under that generation, checked under the owner's lock (write) and again in the write's own transaction on the
// row (ok).
type turnBind struct {
	l     *Lifecycle
	id    string
	o     *owner
	gen   int
	sid   string
	epoch string
	turn  func() string
	// ok is the predicate on a row: the agent runs sid (from epoch, if the binding has one).
	ok func(db.Agent) bool
}

// epochOf is the start a row's harness runs from: launched_at is the first start's, resumed_at every later one's, and
// both are written only by a launch (lifecycle.go), under its generation.
func epochOf(a db.Agent) string { return deref(a.LaunchedAt) + "|" + deref(a.ResumedAt) }

// turnBinding binds an action taken at a signal: sid and gen were read together (owner.bindSignal).
func (l *Lifecycle) turnBinding(ctx context.Context, id, sid string, gen int) *turnBind {
	// The row's start is read after the generation (a launch between them makes the generation stale): the transaction
	// of a write rechecks it, so a writer outside the owner's lock that moved the row to another start is refused too.
	epoch := ""
	if a, err := l.db.GetAgent(ctx, id); err == nil {
		epoch = epochOf(a)
	}
	o := l.ownerOf(id)
	// A launch in flight at the signal never reaches here with a session (owner.bindSignal): one begun since changes the
	// generation.
	return &turnBind{l: l, id: id, o: o, gen: gen, sid: sid, epoch: epoch, turn: l.runningTurn(ctx, id),
		ok: func(a db.Agent) bool { return sid != "" && running(a) && l.serverTurn(a) == sid && epochOf(a) == epoch }}
}

// rowBinding binds an action to the row its caller read, for an entry that has no signal of its own (a request): the
// session and the start the row shows, and the generation as the entry starts. A launch since the row was read has
// written another start, or, until it lands, is in flight (owner.launched is past owner.launchEnd): the binding finds
// itself stale however the generation compares, and the action acts on nothing.
func (l *Lifecycle) rowBinding(ctx context.Context, a db.Agent) *turnBind {
	sid, epoch := l.serverTurn(a), epochOf(a)
	if !running(a) {
		sid = ""
	}
	o := l.ownerOf(a.ID)
	return &turnBind{l: l, id: a.ID, o: o, gen: o.now(), sid: sid, epoch: epoch,
		// turn is read under the owner's lock, so it reads the launch state directly.
		turn: func() string {
			cur, err := l.db.GetAgent(ctx, a.ID)
			if err != nil || !running(cur) || epochOf(cur) != epoch || o.launched > o.launchEnd {
				return ""
			}
			return l.serverTurn(cur)
		},
		ok: func(cur db.Agent) bool {
			return sid != "" && running(cur) && l.serverTurn(cur) == sid && epochOf(cur) == epoch
		}}
}

// still is whether the bound session and generation are still the agent's.
func (b *turnBind) still() bool { return b.sid != "" && b.o.still(b.gen, b.sid, b.turn) }

// write runs a db write only while still, in one step with the check (owner.writeIf).
func (b *turnBind) write(w func() error) (bool, error) {
	if b.sid == "" {
		return false, nil
	}
	return b.o.writeIf(b.gen, b.sid, b.turn, w)
}

// event records an event for the agent only while it runs the bound session under the bound generation, the row checked
// in the write's own transaction (db.AddEventWhile). It reports whether it recorded.
func (b *turnBind) event(ctx context.Context, typ string, data any) bool {
	held := false
	wrote, err := b.write(func() error {
		var err error
		held, err = b.l.db.AddEventWhile(ctx, b.id, typ, data, b.ok)
		return err
	})
	if err != nil {
		slog.Error("lifecycle: event not recorded", "agent", b.id, "type", typ, "err", err)
	}
	return wrote && held
}

// update sets fields on the agent only while it runs the bound session under the bound generation, the row checked in
// the write's own transaction (db.UpdateAgentIf). It reports whether it wrote.
func (b *turnBind) update(ctx context.Context, fields ...db.Field) bool {
	held := false
	wrote, err := b.write(func() error {
		b.l.turnAt(b.id, "update-commit")
		var err error
		held, err = b.l.db.UpdateAgentIf(ctx, b.id, b.ok, fields...)
		return err
	})
	if err != nil {
		slog.Warn("lifecycle: update failed", "agent", b.id, "err", err)
	}
	return wrote && held
}

// turnEndReads reads the session's cumulative usage and reports it, then reads the last assistant message and sets the
// agent's context size from it. A read that fails is skipped silently, as in TS. A report or size is written only while
// the agent still runs sid under gen, checked in the write's own step (owner.writeIf) and, in its transaction, on the
// row (db.RecordUsageWhile, db.UpdateAgentIf). Usage is reported once per execution end: the baseline is read in that
// transaction, so two ends close together each add only the growth the other hadn't (reportUsageWith), and a
// session-cumulative reading below the baseline is ignored (usageReport). A reader a stop, launch, archive or switch
// overtook stops before its next call to the server.
func (l *Lifecycle) turnEndReads(ctx context.Context, id, sid string, gen int) {
	b := l.turnBinding(ctx, id, sid, gen)
	l.turnAt(id, "usage-read")
	if u, ok, err := l.opencode.SessionUsage(ctx, sid); err == nil && ok {
		in, out, cr, cw := u.Input, u.Output, u.CacheRead, u.CacheWrite
		r := usageReport{counts: [len(counters)]*float64{u.Cost, &in, &out, &cr, &cw}, session: &sid, sessionCumulative: true}
		if a, err := l.db.GetAgent(ctx, id); err == nil {
			// The row is read; the report's write comes next, in its own step with a baseline read again.
			l.turnAt(id, "usage-write")
			if err := l.reportUsageWith(ctx, a, r, time.Now(), b); err != nil {
				slog.Warn("lifecycle: usage report failed", "agent", id, "err", err)
			}
		}
	}
	if !b.still() {
		return
	}
	l.turnAt(id, "context-read")
	tokens, ok, err := l.opencode.ContextTokens(ctx, sid)
	if err != nil || !ok {
		return
	}
	l.turnAt(id, "context-write")
	if !b.update(ctx, db.Field{Col: "context_tokens", Val: sqlNumber(tokens)}) {
		return
	}
	l.turnAt(id, "context-written")
	l.contextAt(ctx, id, tokens, b)
}

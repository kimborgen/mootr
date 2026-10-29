package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"strconv"
	"time"

	"stam/internal/adapters/opencode"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// OpenCode agents (src/adapters/opencode.ts, S-4237): each agent's TUI attaches to the one shared server
// (opencode.Server), which runs their turns, takes their prompts through its API, and tells of their states on its
// event stream. A daemon restart keeps a healthy server, so the agents keep their sessions, and the stream is read
// again. A turn's stop, interrupt and state are turnstop.go's, its permission asks ask.go's, its jobs' waits jobs.go's,
// its end's usage and context size, a compaction and an MCP reconnect turnend.go's. Not yet ported: a turn's timeline
// items and vectors (TS's ingestSoon and indexTurnsSoon).

// openCodeSettle is afterLaunch's wait for an OpenCode TUI to come up before the first prompt goes in (TS: 2 s).
const openCodeSettle = 2 * time.Second

// HasOpenCode is whether this daemon runs OpenCode agents: its lifecycle has the shared server.
func (l *Lifecycle) HasOpenCode() bool { return l.opencode != nil }

// StartOpenCode is src/adapters/opencode.ts start, at the daemon's start: the server's config written, the server
// ensured, then its event stream followed until the daemon stops, even when that first start fails (before the network
// is up, say): the stream asks for the server again on each reconnect.
func (l *Lifecycle) StartOpenCode() {
	if l.opencode == nil {
		return
	}
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		if err := l.opencode.Refresh(); err != nil {
			slog.Error("opencode: config not written", "err", err)
		}
		if err := l.opencode.Ensure(l.ctx); err != nil && l.ctx.Err() == nil {
			slog.Error("opencode adapter failed to start", "err", err)
		}
		l.opencode.Follow(l.ctx, l.onOpenCodeConnect, func(ev opencode.Event) { l.onOpenCodeEvent(l.ctx, ev) })
	}()
}

// onOpenCodeConnect runs on each (re)connect to the server's event stream, before its first event.
func (l *Lifecycle) onOpenCodeConnect() {
	l.mu.Lock()
	hook := l.openCodeConnected
	owners := make([]*owner, 0, len(l.owners))
	for _, o := range l.owners {
		owners = append(owners, o)
	}
	l.mu.Unlock()
	// Each agent may end an execution whose start this stream never showed (owner.creditExec); an owner made later is
	// credited as it is made.
	for _, o := range owners {
		o.creditExec()
	}
	// The jobs the server runs now are read before the first event, and applied once read (jobs.go).
	l.seedJobs()
	// The asks the server lists as pending, whose events this stream missed (asksweep.go).
	l.sweepAsks()
	if hook != nil {
		hook()
	}
}

// openCodeAfterLaunch is src/adapters/opencode.ts afterLaunch. The first prompt goes to the session through the
// server's API, once the TUI has had openCodeSettle to come up and the gate admits it. OpenCode sends no event until the
// first turn, so an agent started without a prompt counts as idle once its TUI is up: only while it is still starting
// without a prompt on this launch, checked in one step with the write, so a turn that began meanwhile keeps its state.
func (l *Lifecycle) openCodeAfterLaunch(ctx context.Context, a db.Agent, prompt string, gen int, gate func() bool) error {
	if err := sleep(ctx, l.openCodeWait()); err != nil {
		return err
	}
	if prompt != "" {
		if !l.tmux.HasSession(ctx, a.ID) || l.tmux.IsDead(ctx, a.ID) {
			return errors.New("the OpenCode TUI exited")
		}
		if !gate() {
			return nil
		}
		now, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return err
		}
		return l.opencode.Prompt(ctx, deref(now.SessionID), prompt)
	}
	if !l.tmux.HasSession(ctx, a.ID) || l.tmux.IsDead(ctx, a.ID) {
		return nil
	}
	starting := func(now db.Agent) bool {
		return now.Activity == "starting" && deref(now.ActivityDetail) != "with prompt"
	}
	wrote, err := l.updateIfCurrent(ctx, a.ID, gen, starting, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "ready"})
	if err != nil {
		slog.Error("lifecycle: update failed", "agent", a.ID, "err", err)
	}
	if wrote {
		l.SchedulePush(a.ID)
	}
	return nil
}

func (l *Lifecycle) openCodeWait() time.Duration {
	if l.openCodeSettle > 0 {
		return l.openCodeSettle
	}
	return openCodeSettle
}

// pushOpenCode is src/adapters/opencode.ts pushPrompt: the text queued in the agent's session.
func (l *Lifecycle) pushOpenCode(ctx context.Context, a db.Agent, text string) bool {
	if l.opencode == nil || deref(a.SessionID) == "" {
		return false
	}
	if err := l.opencode.Prompt(ctx, *a.SessionID, text); err != nil {
		slog.Warn("opencode: prompt not delivered", "agent", a.ID, "err", err)
		return false
	}
	return true
}

// openCodeStateEvent is an opencode:TYPE event's data: the state the event set.
type openCodeStateEvent struct {
	Activity string  `json:"activity"`
	Detail   *string `json:"detail"`
}

// openCodeSignal is a failed execution's cost:signal (src/adapters/opencode.ts onEvent): the error's type and API
// status, each only when the error has one.
type openCodeSignal struct {
	Source string   `json:"source"`
	Class  string   `json:"class"`
	Error  *string  `json:"error,omitempty"`
	Status *float64 `json:"status,omitempty"`
}

// onOpenCodeEvent is src/adapters/opencode.ts onEvent: an event that names an agent's session sets the agent's state,
// and a turn's end pushes its mail and runs its pending action.
func (l *Lifecycle) onOpenCodeEvent(ctx context.Context, ev opencode.Event) {
	// The agent view's windows are told last, whichever way this returns (openview.go).
	defer l.viewEvent(ev)
	// The shells and child sessions the event tells of aren't an agent's own session: followed first (jobs.go).
	l.trackJobs(ctx, openCodeEventView{typ: ev.Type, data: ev.Data})
	sid := ocStr(ev.Data, "sessionID")
	if sid == "" {
		sid = ocStr(ev.Data, "sessionId")
	}
	if sid == "" {
		return
	}
	a, err := l.db.AgentBySession(ctx, sid)
	if err != nil {
		return
	}
	ocSession := sid
	set := func(activity string, detail *string) {
		l.update(ctx, a.ID, db.Field{Col: "activity", Val: activity}, db.Field{Col: "activity_detail", Val: detailVal(detail)})
		l.event(ctx, a.ID, "opencode:"+ev.Type, openCodeStateEvent{Activity: activity, Detail: detail})
	}
	text := func(s string) *string { return &s }
	// An ask whose listing failed is queued again on the agent's next event, before the event's own ask; its raiser
	// lists it, off the stream.
	l.retryAsks(a.ID)
	switch ev.Type {
	case "session.execution.started":
		// A completion notice starts this execution; the work it reports is over. Its end may end the turn only if it
		// started under this generation, in the session the row runs (owner.startExec, which names the known gap); a
		// start refused there writes no working state, which no end would clear.
		sid, gen, ok := l.ownerOf(a.ID).startExec(ocSession, l.runningTurn(ctx, a.ID))
		if !ok {
			return
		}
		set("working", nil)
		l.syncJobWaits(ctx, a.ID, sid, gen)
	case "session.tool.called":
		set("working", text("running a tool"))
	case "permission.asked":
		// Unlike TS, an action stam doesn't know is plain "permission": the server's text reaches neither the row nor the
		// event (S-4237).
		switch action := ocStr(ev.Data, "action"); {
		case action == "question":
			set("blocked", text("question"))
		case opencode.KnownPermissionAction(action):
			set("blocked", text("permission "+action))
		default:
			set("blocked", text("permission"))
		}
		// An ask in the human's thread (S-3980), answered through the reply endpoint for this permission id.
		l.openCodeAsk(a, sid, ev.Data)
	case "permission.replied":
		l.openCodeReplied(ctx, a, ocStr(ev.Data, "requestID"))
	case "form.created":
		set("blocked", text("question"))
	case "session.execution.succeeded", "session.execution.interrupted":
		detail := "turn finished"
		if ev.Type == "session.execution.interrupted" {
			detail = "interrupted"
		}
		// Bound here, with whether it ends the turn: an execution seen starting (or credited) under the generation now,
		// in the session the row runs, with no launch in flight (owner.endExec). One of an earlier launch or session,
		// however late it is read, writes nothing, records nothing and runs nothing of the turn's end, the mail push and
		// the credit poll included: the current turn's own end runs them.
		bound, gen, _, binds := l.ownerOf(a.ID).endExec(ocSession, l.runningTurn(ctx, a.ID))
		if !binds {
			l.jobAt(a.ID, "ended")
			return
		}
		// The waits first, so an execution that leaves work running ends waiting, never idle. Written under the
		// generation bound here: a stop or a launch since this event came first leaves the row to it (jobs.go).
		l.syncJobWaits(ctx, a.ID, bound, gen)
		l.jobAt(a.ID, "ended")
		if wrote, err := l.updateIfCurrent(ctx, a.ID, gen, nil, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: detail}); err != nil {
			slog.Error("lifecycle: update failed", "agent", a.ID, "err", err)
		} else if wrote {
			l.event(ctx, a.ID, "opencode:"+ev.Type, openCodeStateEvent{Activity: "idle", Detail: text(detail)})
		}
		// The session's usage and context size, read after the idle write and off the event stream (turnend.go).
		l.readTurnEnd(a.ID, bound, gen)
		l.SchedulePush(a.ID)
		l.PollCreditsAfterTurn(a)
		// Not ported: TS's ingestSoon and indexTurnsSoon here (the turn's timeline items and vectors); Go has no
		// activity or turn-vector module yet.
		l.onIdleAt(a.ID, bound, gen)
	case "session.execution.failed":
		// Unlike TS, nothing the server wrote is kept (S-4237): its message, or a type stam doesn't know, can hold a key
		// in some spelling. Only a known error type and the numeric API status reach the row, the event and the signal.
		errObj, _ := ocField(ev.Data, "error").(*jsjson.Object)
		typ, _ := ocField(errObj, "type").(string)
		if !opencode.KnownErrorType(typ) {
			typ = ""
		}
		status, hasStatus := ocField(errObj, "status").(float64)
		hasStatus = hasStatus && status == math.Trunc(status) && status >= 100 && status <= 599
		if cls := opencode.ClassifyError(ev.Raw); cls != "" {
			sig := openCodeSignal{Source: ev.Type, Class: cls}
			source := ev.Type
			if typ != "" {
				sig.Error = &typ
				source += " (" + typ + ")"
			}
			if hasStatus {
				sig.Status = &status
			}
			l.signal(ctx, a, cls, source, sig)
		}
		msg := "failed"
		switch {
		case typ != "":
			msg = typ
		case hasStatus:
			msg = "failed (" + strconv.Itoa(int(status)) + ")"
		}
		set("errored", text(msg))
		// Not ported: TS's ingestSoon (see the turn end above).
	case "session.compaction.started":
		// The server's compaction runs as an execution of the session, and its end is the turn's: its start is one
		// (owner.startExec), which a compaction that comes with no execution start of its own needs. A start refused
		// there writes nothing.
		if _, _, ok := l.ownerOf(a.ID).startExec(ocSession, l.runningTurn(ctx, a.ID)); ok {
			set("working", text("compacting"))
		}
	}
}

// ocField is o's value at key, nil when o is nil or lacks it.
func ocField(o *jsjson.Object, key string) jsjson.Value {
	if o == nil {
		return nil
	}
	v, _ := o.Get(key)
	return v
}

// ocStr is o's string at key, "" for any other value.
func ocStr(o *jsjson.Object, key string) string {
	s, _ := ocField(o, key).(string)
	return s
}

// detailVal is a detail as its column takes it: NULL for none.
func detailVal(d *string) any {
	if d == nil {
		return nil
	}
	return *d
}

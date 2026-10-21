package lifecycle

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// A pending action (src/lifecycle.ts Pending) is kept as the JSON object TS writes, in its key order, so a row the Go
// daemon writes reads the same to the TS daemon and compares equal as text (recoverOne's intent check).
//
// Ported: shutdown (with its final-round `at` deadline or `midTurn`), compact, restart and recover. A pending archive
// or MCP reconnect is left as it is, for the TS daemon: archiving isn't ported, and Claude Code has no reconnect.

// pendingOf is the agent's pending action, nil for none (or one that doesn't parse).
func pendingOf(a db.Agent) *jsjson.Object {
	if a.PendingAction == nil {
		return nil
	}
	v, err := jsjson.Parse([]byte(*a.PendingAction))
	if err != nil {
		return nil
	}
	o, _ := v.(*jsjson.Object)
	return o
}

func pstr(o *jsjson.Object, key string) string {
	v, _ := o.Get(key)
	s, _ := v.(string)
	return s
}

func pnum(o *jsjson.Object, key string) (float64, bool) {
	v, _ := o.Get(key)
	n, ok := v.(float64)
	return n, ok
}

// ptruthy is JavaScript truthiness of the key's value (`p.midTurn`).
func ptruthy(o *jsjson.Object, key string) bool {
	v, _ := o.Get(key)
	return jsjson.Truthy(v)
}

// phas is `p.key !== undefined`: present, null included.
func phas(o *jsjson.Object, key string) bool {
	_, ok := o.Get(key)
	return ok
}

// without is `{ ...o }` with key left out.
func without(o *jsjson.Object, key string) *jsjson.Object {
	out := jsjson.NewObject()
	for _, k := range o.Keys() {
		if k != key {
			v, _ := o.Get(k)
			out.Set(k, v)
		}
	}
	return out
}

func copyObject(o *jsjson.Object) *jsjson.Object { return without(o, "") }

func text(o *jsjson.Object) string { return jsjson.Stringify(o, "") }

// raw is o as event data, its key order kept.
func raw(o *jsjson.Object) json.RawMessage { return json.RawMessage(text(o)) }

// nowMS is Date.now().
func nowMS() float64 { return float64(time.Now().UnixMilli()) }

// isIdle is src/lifecycle.ts isIdle.
func isIdle(a db.Agent) bool {
	return a.Activity == "idle" || a.Activity == "waiting" || a.Activity == "errored"
}

func running(a db.Agent) bool { return a.Lifecycle == "active" || a.Lifecycle == "paused" }

// finalRoundMS is src/lifecycle.ts finalRoundMs: settings.archive.finalRoundMinutes in ms, at least 0.
func (l *Lifecycle) finalRoundMS() float64 {
	return math.Max(0, l.settings.Get().FinalRoundMinutes) * 60_000
}

func (l *Lifecycle) hasEvent(ctx context.Context, id, typ string) bool {
	ok, err := l.db.HasEvent(ctx, id, typ)
	return err == nil && ok
}

type reasonEvent struct {
	Reason string `json:"reason"`
}

type atEvent struct {
	At float64 `json:"at"`
}

// noteRoundSkipped is src/lifecycle.ts noteRoundSkipped: a stop without the agent's final round records why, once per
// run of its harness, unless it filed one.
func (l *Lifecycle) noteRoundSkipped(ctx context.Context, a db.Agent, reason string) {
	if l.hasEvent(ctx, a.ID, "retro_final") {
		return
	}
	if ok, err := l.db.HasEventSinceStart(ctx, a.ID, "archive:round-skipped"); err != nil || ok {
		return
	}
	l.event(ctx, a.ID, "archive:round-skipped", reasonEvent{Reason: reason})
}

func (l *Lifecycle) waiting(a db.Agent) string {
	return fmt.Sprintf("waiting for %s to finish its step", a.Name)
}

// ErrNotPorted is an action that would need what the Go daemon doesn't do yet; the control route answers it with a 501.
type ErrNotPorted struct{ What string }

func (e ErrNotPorted) Error() string { return e.What + " is not ported to the Go daemon yet" }

// whenIdle is src/lifecycle.ts whenIdle: an idle agent runs the action now; a working one keeps it pending for its turn
// end and is asked to wrap up. The wrap-up arrives as a prompt over its shim's stream; one that doesn't reach it (no
// stream, or a refused turn) leaves the action pending all the same, as in TS.
func (l *Lifecycle) whenIdle(ctx context.Context, a db.Agent, pending *jsjson.Object, wrapUp string) (string, error) {
	if !running(a) {
		return "", fmt.Errorf("%s is %s", a.Name, a.Lifecycle)
	}
	if isIdle(a) {
		r, err := l.runPending(ctx, a, pending)
		if r == "" && err == nil {
			r = "done"
		}
		return r, err
	}
	if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "pending_action", Val: text(pending)}); err != nil {
		return "", err
	}
	if wrapUp != "" {
		l.prompt(ctx, a, wrapUp, "prompt")
	}
	l.event(ctx, a.ID, "pending", raw(pending))
	return l.waiting(a), nil
}

// giveWrapUpTurn is src/lifecycle.ts giveWrapUpTurn (S-1618): a wrap-up pushed mid-turn may only start after that
// turn, so with no retro_final yet the stop waits for one more turn end, under a fresh final-round deadline.
func (l *Lifecycle) giveWrapUpTurn(ctx context.Context, a db.Agent, p *jsjson.Object) bool {
	if !ptruthy(p, "midTurn") || ptruthy(p, "waited") || l.hasEvent(ctx, a.ID, "retro_final") || !running(a) {
		return false
	}
	next := copyObject(p)
	at := nowMS() + l.finalRoundMS()
	next.Set("waited", true)
	next.Set("at", at)
	l.update(ctx, a.ID, db.Field{Col: "pending_action", Val: text(next)})
	l.event(ctx, a.ID, "pending:extra-turn", atEvent{At: at})
	return true
}

// leftForTS is a pending action the Go daemon leaves for the TS daemon.
func leftForTS(p *jsjson.Object) bool {
	typ := pstr(p, "type")
	return typ == "archive" || typ == "reconnect-mcp"
}

// runPending is src/lifecycle.ts runPending for the actions ported; a pending archive stays for the TS daemon.
func (l *Lifecycle) runPending(ctx context.Context, a db.Agent, p *jsjson.Object) (string, error) {
	if leftForTS(p) {
		return "", nil
	}
	if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "pending_action", Val: nil}); err != nil {
		return "", err
	}
	return l.runTaken(ctx, a, p)
}

// runTaken runs a pending action already cleared from the agent's row.
func (l *Lifecycle) runTaken(ctx context.Context, a db.Agent, p *jsjson.Object) (string, error) {
	typ := pstr(p, "type")
	if typ == "shutdown" && l.giveWrapUpTurn(ctx, a, p) {
		return l.waiting(a), nil
	}
	switch typ {
	case "shutdown":
		// The turn ended without retro_final after the round was asked for; a shutdown that didn't ask records nothing.
		if ptruthy(p, "midTurn") || phas(p, "at") {
			l.noteRoundSkipped(ctx, a, "turn_ended_no_round")
		}
		return "", l.quitHarness(ctx, a, "shut down")
	case "compact":
		return l.compactNow(ctx, a, p)
	case "restart":
		reason := pstr(p, "reason")
		if err := l.quitHarness(ctx, a, "restarting: "+reason); err != nil {
			return "", err
		}
		note, err := l.render("restarted", map[string]string{"reason": reason})
		if err != nil {
			return "", err
		}
		fresh, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return "", err
		}
		return "", l.StartHarness(ctx, fresh, note, true, "restart")
	}
	return "", nil
}

// OnIdle is src/lifecycle.ts onIdle, run when the agent's turn ends: its pending action runs. Not ported: the rest
// clock's turn end and MCP reconnects.
func (l *Lifecycle) OnIdle(ctx context.Context, id string) error {
	a, p, err := l.takePending(ctx, id, func(p *jsjson.Object) bool { return !leftForTS(p) })
	if err != nil || p == nil {
		return err
	}
	_, err = l.runTaken(ctx, a, p)
	return err
}

// takePending clears the agent's pending action when want accepts it and the row still holds it as read, and returns
// the agent and the action; nil when there is none, want refuses it, or another caller took it first. TS runs a
// pending action synchronously; here two turn ends, or a turn end and a deadline sweep, may race, and only the one
// whose clear lands runs it.
func (l *Lifecycle) takePending(ctx context.Context, id string, want func(*jsjson.Object) bool) (db.Agent, *jsjson.Object, error) {
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return a, nil, nil
	}
	p := pendingOf(a)
	if p == nil || !want(p) {
		return a, nil, nil
	}
	ok, err := l.db.TakePendingAction(ctx, id, *a.PendingAction)
	if err != nil || !ok {
		return a, nil, err
	}
	a.PendingAction = nil
	return a, p, nil
}

// onIdleSoon runs OnIdle in the background, as TS runs onIdle without awaiting it; a failure is a pending-error event.
func (l *Lifecycle) onIdleSoon(id string) {
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		if err := l.OnIdle(l.ctx, id); err != nil && l.ctx.Err() == nil {
			l.event(l.ctx, id, "pending-error", "Error: "+err.Error())
		}
	}()
}

// GracefulShutdown is src/lifecycle.ts explicitShutdown without now: an agent stops when its step ends. An active
// agent that hasn't filed its final round is asked for it (askShutdownRound). Cost fallbacks aren't ported, so none
// are cancelled.
func (l *Lifecycle) GracefulShutdown(ctx context.Context, a db.Agent) (string, error) {
	if a.Lifecycle == "active" && !l.hasEvent(ctx, a.ID, "retro_final") {
		return l.askShutdownRound(ctx, a)
	}
	wrapUp, err := l.render("shutdown-prepare", nil)
	if err != nil {
		return "", err
	}
	return l.whenIdle(ctx, a, jsjson.NewObject("type", "shutdown"), l.withRetroReminder(wrapUp))
}

// askShutdownRound is src/lifecycle.ts askShutdownRound (S-1402): the shutdown is the last moment the agent's context is
// live, so it is asked for its final round, idle or not. An idle agent's round is bounded by the final-round deadline
// (runDueShutdowns); a working one finishes its step first and stops at its turn end.
func (l *Lifecycle) askShutdownRound(ctx context.Context, a db.Agent) (string, error) {
	pending := jsjson.NewObject("type", "shutdown", "midTurn", true)
	if isIdle(a) {
		pending = jsjson.NewObject("type", "shutdown", "at", nowMS()+l.finalRoundMS())
	}
	if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "pending_action", Val: text(pending)}); err != nil {
		return "", err
	}
	wrapUp, err := l.archiveWrapUp()
	if err == nil {
		l.prompt(ctx, a, wrapUp, "prompt")
	}
	l.event(ctx, a.ID, "pending", raw(pending))
	return l.waiting(a), nil
}

// archiveWrapUp is src/lifecycle.ts archiveWrapUp: the shutdown's wrap-up, plus the final retro round (S-159).
func (l *Lifecycle) archiveWrapUp() (string, error) {
	prepare, err := l.render("shutdown-prepare", nil)
	if err != nil {
		return "", err
	}
	archive, err := l.render("shutdown-archive", nil)
	if err != nil {
		return "", err
	}
	return prepare + "\n\n" + archive, nil
}

// Restart is src/lifecycle.ts restart: the agent quits when its step ends and comes back on its session, told why.
func (l *Lifecycle) Restart(ctx context.Context, a db.Agent, reason string) (string, error) {
	wrapUp, err := l.render("restart-prepare", map[string]string{"reason": reason})
	if err != nil {
		return "", err
	}
	return l.whenIdle(ctx, a, jsjson.NewObject("type", "restart", "reason", reason), wrapUp)
}

// pendingStop is src/lifecycle.ts pendingStop: the agent's pending archive or shutdown.
func pendingStop(a db.Agent) *jsjson.Object {
	p := pendingOf(a)
	if p == nil {
		return nil
	}
	if t := pstr(p, "type"); t == "archive" || t == "shutdown" {
		return p
	}
	return nil
}

// runPendingOnDead is src/lifecycle.ts runPendingOnDead (S-578) for a pending shutdown: the harness is gone, so there is
// no step to wait for. A pending archive is left for the TS daemon.
// TS skips one whose stop is due (pendingStopDue), which only an archive can be, so a shutdown runs either way; the
// deadline sweep and this one may race, and only the one whose clear lands stops the harness.
func (l *Lifecycle) runPendingOnDead(ctx context.Context, a db.Agent) error {
	fresh, p, err := l.takePending(ctx, a.ID, func(p *jsjson.Object) bool { return pstr(p, "type") == "shutdown" })
	if err != nil || p == nil {
		return err
	}
	return l.quitHarness(ctx, fresh, "shut down")
}

// runDueShutdowns is the shutdown half of src/lifecycle.ts runDueArchives (S-1402): a shutdown past its final-round
// deadline stops the harness whatever its turn does. Pending archives are the TS daemon's.
func (l *Lifecycle) runDueShutdowns(ctx context.Context, now float64) {
	agents, err := l.db.ListPendingAgents(ctx)
	if err != nil {
		return
	}
	for _, a := range agents {
		p := pendingStop(a)
		if p == nil || pstr(p, "type") != "shutdown" {
			continue
		}
		at, ok := pnum(p, "at")
		if !ok || at > now {
			continue
		}
		// Taken as it was listed: the pending may have run or been replaced since.
		fresh, cur, err := l.takePending(ctx, a.ID, func(cur *jsjson.Object) bool {
			curAt, ok := pnum(cur, "at")
			return pstr(cur, "type") == "shutdown" && ok && curAt == at
		})
		if err != nil || cur == nil {
			continue
		}
		l.event(ctx, a.ID, "shutdown:final-round-timeout", atEvent{At: at})
		l.noteRoundSkipped(ctx, fresh, "deadline_no_round")
		if err := l.quitHarness(ctx, fresh, "shut down"); err != nil {
			slog.Warn("lifecycle: shutdown at the deadline failed", "agent", a.ID, "err", err)
		}
	}
}

package lifecycle

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// set writes fields on the agent's row.
func (l *live) set(id string, fields ...db.Field) {
	l.t.Helper()
	if err := l.db.UpdateAgent(l.ctx, id, fields...); err != nil {
		l.t.Fatal(err)
	}
}

func (l *live) idle(id string) {
	l.t.Helper()
	l.set(id, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "turn finished"})
}

// hook reports a Claude Code hook for the agent, as POST /api/hook/claude/:id does.
func (l *live) hook(id, event string) {
	l.t.Helper()
	if _, err := l.life.OnHook(l.ctx, "claude", l.agent(id), jsjson.NewObject("hook_event_name", event), new([]int64)); err != nil {
		l.t.Fatal(err)
	}
}

func (l *live) has(id, typ string) bool {
	ok, _ := l.db.HasEvent(l.ctx, id, typ)
	return ok
}

func pendingText(a db.Agent) string {
	if a.PendingAction == nil {
		return ""
	}
	return *a.PendingAction
}

// compacts is the fake's compaction log: one "STAM_COMPACTOR|STAM_AGENT_ID|stdin" line per headless run.
func (l *live) compacts() []string {
	b, _ := os.ReadFile(filepath.Join(l.base, "compacts"))
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

func (l *live) flag(name string, on bool) {
	l.t.Helper()
	path := filepath.Join(l.base, name)
	if !on {
		os.Remove(path)
		return
	}
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		l.t.Fatal(err)
	}
}

// TestShutdownRound: a shutdown asks an active agent for its final round, under the deadline when it is idle; with no
// shim to take the ask, the shutdown is pending all the same. A shutdown pending as TS writes it stops an idle agent at
// the deadline, gives a working one one more turn end and stops it there, and one that filed its round stops at once.
func TestShutdownRound(t *testing.T) {
	l := newLive(t)
	l.setSettings(`{"archive":{"finalRoundMinutes":0}}`)

	l.spawn("alpd1")
	l.idle("alpd1")
	before := time.Now().UnixMilli()
	if r, err := l.life.GracefulShutdown(l.ctx, l.agent("alpd1")); err != nil || r != "waiting for n-alpd1 to finish its step" {
		t.Fatalf("a shutdown that asks for the round: %q %v", r, err)
	}
	var p struct {
		Type string `json:"type"`
		At   int64  `json:"at"`
	}
	got := l.agent("alpd1")
	if err := json.Unmarshal([]byte(pendingText(got)), &p); err != nil || p.Type != "shutdown" || p.At < before || got.Lifecycle != "active" || !l.has("alpd1", "pending") {
		t.Fatalf("after the ask: %s pending %s", got.Lifecycle, pendingText(got))
	}
	if l.has("alpd1", "prompt:sent") {
		t.Fatal("an ask with no shim counted as sent")
	}
	// The deadline TS's askShutdownRound sets for an idle agent.
	l.set("alpd1", db.Field{Col: "pending_action", Val: fmt.Sprintf(`{"type":"shutdown","at":%d}`, time.Now().UnixMilli())})
	l.prime(l.life)
	l.reconcile(l.life)
	if got := l.agent("alpd1"); got.Lifecycle != "shut_down" || detailOf(got) != "shut down" || got.PendingAction != nil || l.tmux.HasSession(l.ctx, "alpd1") {
		t.Errorf("past the deadline: %s %q pending %v", got.Lifecycle, detailOf(got), got.PendingAction)
	}
	if !l.has("alpd1", "shutdown:final-round-timeout") {
		t.Error("no shutdown:final-round-timeout event")
	}
	if e := lastEvent(t, l, "alpd1", "archive:round-skipped"); e != `{"reason":"deadline_no_round"}` {
		t.Errorf("round-skipped: %s", e)
	}

	l.spawn("alpd2")
	l.set("alpd2", db.Field{Col: "activity", Val: "working"}, db.Field{Col: "pending_action", Val: `{"type":"shutdown","midTurn":true}`})
	// The step's end isn't the round's: one more turn, under a deadline.
	l.hook("alpd2", "Stop")
	l.until("the extra turn", func() bool { return l.has("alpd2", "pending:extra-turn") })
	if p := pendingText(l.agent("alpd2")); !strings.HasPrefix(p, `{"type":"shutdown","midTurn":true,"waited":true,"at":`) {
		t.Fatalf("after the step's end: %s", p)
	}
	if got := l.agent("alpd2"); got.Lifecycle != "active" {
		t.Fatalf("stopped at the step's end: %s", got.Lifecycle)
	}
	l.hook("alpd2", "UserPromptSubmit")
	l.hook("alpd2", "Stop")
	l.until("the stop at the turn end", func() bool { return l.agent("alpd2").Lifecycle == "shut_down" })
	if e := lastEvent(t, l, "alpd2", "archive:round-skipped"); e != `{"reason":"turn_ended_no_round"}` {
		t.Errorf("round-skipped: %s", e)
	}

	l.spawn("alpd3")
	if err := l.db.AddEvent(l.ctx, "alpd3", "retro_final", nil); err != nil {
		t.Fatal(err)
	}
	l.set("alpd3", db.Field{Col: "activity", Val: "working"})
	if r, err := l.life.GracefulShutdown(l.ctx, l.agent("alpd3")); err != nil || r != "waiting for n-alpd3 to finish its step" || pendingText(l.agent("alpd3")) != `{"type":"shutdown"}` {
		t.Fatalf("a working agent's wrap-up: %q %v", r, err)
	}
	l.idle("alpd3")
	if r, err := l.life.GracefulShutdown(l.ctx, l.agent("alpd3")); err != nil || r != "done" {
		t.Fatalf("shutdown after the round: %q %v", r, err)
	}
	if got := l.agent("alpd3"); got.Lifecycle != "shut_down" || l.has("alpd3", "archive:round-skipped") {
		t.Errorf("after the round: %s, round-skipped %v", got.Lifecycle, l.has("alpd3", "archive:round-skipped"))
	}
	if _, err := l.life.GracefulShutdown(l.ctx, l.agent("alpd3")); err == nil || err.Error() != "n-alpd3 is shut_down" {
		t.Errorf("a stopped agent's shutdown: %v", err)
	}
}

// TestCompactionRace: two compactions started at once (a request and a turn end's pending, past RequestCompaction's
// early check) put one compactor on the session, the other dropped; and two turn ends at once run the pending action
// once.
func TestCompactionRace(t *testing.T) {
	l := newLive(t)
	l.spawn("alpr9") // keeps the tmux server up while alpr1's session is down
	l.spawn("alpr1")
	l.idle("alpr1")
	l.flag("hold", true)
	results := make(chan string, 2)
	for i := 0; i < 2; i++ {
		go func() {
			r, err := l.life.compactNow(l.ctx, l.agent("alpr1"), jsjson.NewObject("type", "compact", "reason", fmt.Sprint("race ", i)))
			if err != nil {
				r = err.Error()
			}
			results <- r
		}()
	}
	dropped := <-results // the loser answers while the winner's compactor is held
	if dropped != "n-alpr1 is already compacting or was just compacted; this request is dropped" {
		t.Errorf("the second request: %q", dropped)
	}
	l.flag("hold", false)
	if r := <-results; r != "" {
		t.Errorf("the first request: %q", r)
	}
	if got := l.compacts(); len(got) != 1 {
		t.Errorf("compactor runs: %q", got)
	}

	l.spawn("alpr2")
	l.set("alpr2", db.Field{Col: "activity", Val: "working"}, db.Field{Col: "pending_action", Val: `{"type":"shutdown"}`})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := l.life.OnIdle(l.ctx, "alpr2"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if evs, _ := l.db.ListEvents(l.ctx, "alpr2", 20, "shutdown"); len(evs) != 1 {
		t.Errorf("shutdowns from 8 turn ends: %d", len(evs))
	}
}

// TestCompactionAndRestart: an idle agent is compacted at once, headless on its session with the instructions on
// stdin, then resumed; a request right after is dropped; a working one compacts at its turn end; a restart quits and
// resumes.
func TestCompactionAndRestart(t *testing.T) {
	l := newLive(t)
	l.spawn("alpc1")
	l.idle("alpc1")
	if r, err := l.life.RequestCompaction(l.ctx, l.agent("alpc1"), "keep the tests", "requested"); err != nil || r != "done" {
		t.Fatalf("compaction: %q %v", r, err)
	}
	ev := lastEvent(t, l, "alpc1", "compact")
	op := strings.TrimSuffix(strings.TrimPrefix(ev, `{"type":"compact","instructions":"keep the tests","reason":"requested","op":"`), `"}`)
	if len(op) != 36 {
		t.Fatalf("compact event: %s", ev)
	}
	if got := l.compacts(); len(got) != 1 || got[0] != "alpc1:"+op+"||/compact keep the tests" {
		t.Errorf("compactor runs: %q", got)
	}
	if e := lastEvent(t, l, "alpc1", "compact:done"); e != `{"op":"`+op+`"}` {
		t.Errorf("compact:done: %s", e)
	}
	// The relaunch's wake doesn't mark again over the compaction's mark.
	if marks, _ := l.db.ListEvents(l.ctx, "alpc1", 10, "cache:mark"); len(marks) != 1 || *marks[0].Data != `{"cause":"compaction"}` {
		t.Errorf("cache marks: %+v", marks)
	}
	if got := l.agent("alpc1"); got.Lifecycle != "active" || !l.has("alpc1", "resume") || !l.tmux.HasSession(l.ctx, "alpc1") {
		t.Errorf("after the compaction: %s %q, resumed %v", got.Lifecycle, detailOf(got), l.has("alpc1", "resume"))
	}
	if r, err := l.life.RequestCompaction(l.ctx, l.agent("alpc1"), "", "again"); err != nil || r != "n-alpc1 is already compacting or was just compacted; this request is dropped" {
		t.Errorf("a repeat: %q %v", r, err)
	}
	if e := lastEvent(t, l, "alpc1", "compact:dropped"); e != `{"reason":"again"}` {
		t.Errorf("compact:dropped: %s", e)
	}

	l.spawn("alpc2")
	l.set("alpc2", db.Field{Col: "activity", Val: "working"})
	if r, err := l.life.RequestCompaction(l.ctx, l.agent("alpc2"), "", "requested"); err != nil || r != "waiting for n-alpc2 to finish its step" {
		t.Fatalf("working compaction: %q %v", r, err)
	}
	if p := pendingText(l.agent("alpc2")); p != `{"type":"compact","reason":"requested"}` {
		t.Fatalf("pending: %s", p)
	}
	l.hook("alpc2", "Stop")
	l.until("the compaction at the turn end", func() bool { return l.has("alpc2", "compact:done") })
	if e := lastEvent(t, l, "alpc2", "compact"); !strings.HasPrefix(e, `{"type":"compact","reason":"requested","op":`) {
		t.Errorf("compact event: %s", e)
	}

	l.spawn("alpc3")
	l.idle("alpc3")
	if r, err := l.life.Restart(l.ctx, l.agent("alpc3"), "new tools"); err != nil || r != "done" {
		t.Fatalf("restart: %q %v", r, err)
	}
	if e := lastEvent(t, l, "alpc3", "shutdown"); e != `{"detail":"restarting: new tools"}` {
		t.Errorf("restart's shutdown: %s", e)
	}
	if got := l.agent("alpc3"); got.Lifecycle != "active" || !l.has("alpc3", "resume") || !l.tmux.HasSession(l.ctx, "alpc3") {
		t.Errorf("after the restart: %s %q", got.Lifecycle, detailOf(got))
	}
	if marks, _ := l.db.ListEvents(l.ctx, "alpc3", 10, "cache:mark"); len(marks) != 1 || *marks[0].Data != `{"cause":"wake"}` {
		t.Errorf("restart's cache marks: %+v", marks)
	}
}

// TestCompactionHeldAndFailed: reconcile holds an agent whose compaction runs (once), and a failed compaction records
// compact:failed and leaves no mark, so a retry isn't dropped.
func TestCompactionHeldAndFailed(t *testing.T) {
	l := newLive(t)
	l.spawn("alph9") // keeps the tmux server up while alph1's session is down
	l.spawn("alph1")
	l.idle("alph1")
	l.prime(l.life)
	l.flag("hold", true)
	done := make(chan error, 1)
	go func() {
		_, err := l.life.RequestCompaction(l.ctx, l.agent("alph1"), "", "requested")
		done <- err
	}()
	l.until("the compactor", func() bool { return strings.HasPrefix(l.compacts()[0], "alph1:") })
	l.reconcile(l.life)
	l.reconcile(l.life)
	if held, _ := l.db.ListEvents(l.ctx, "alph1", 10, "reconcile:held"); len(held) != 1 {
		t.Errorf("reconcile:held events: %d", len(held))
	}
	if got := l.agent("alph1"); got.Lifecycle != "active" || detailOf(got) != "compacting: requested" {
		t.Errorf("held: %s %q", got.Lifecycle, detailOf(got))
	}
	l.flag("hold", false)
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	l.spawn("alph2")
	l.idle("alph2")
	l.flag("fail", true)
	for i := 0; i < 2; i++ {
		if _, err := l.life.RequestCompaction(l.ctx, l.agent("alph2"), "", "requested"); err == nil || !strings.Contains(err.Error(), "fake compaction failed") {
			t.Fatalf("failed compaction %d: %v", i, err)
		}
		if evs, _ := l.db.ListEvents(l.ctx, "alph2", 10, "compact:failed"); len(evs) != i+1 {
			t.Fatalf("compact:failed events after %d: %d", i+1, len(evs))
		}
		l.idle("alph2")
	}
}

// TestContextExitResumes: a harness that exits near its context limit is compacted headless and resumed once the
// network answers, and its parent told; a second exit soon after isn't resumed.
func TestContextExitResumes(t *testing.T) {
	l := newLive(t)
	l.spawn("alpx9")
	l.spawn("alpx1", "alpx9")
	l.set("alpx1", db.Field{Col: "context_tokens", Val: 400000})
	l.idle("alpx1")
	l.prime(l.life)
	l.reconcile(l.life)
	l.holdNetwork()
	if err := l.tmux.KillSession(l.ctx, "alpx1"); err != nil {
		t.Fatal(err)
	}
	l.reconcile(l.life)
	if e := lastEvent(t, l, "alpx1", "exit:context"); e != `{"tokens":400000,"resumed":true}` {
		t.Errorf("exit:context: %s", e)
	}
	got := l.agent("alpx1")
	if got.Lifecycle != "shut_down" || detailOf(got) != "compacting, then resuming" ||
		pendingText(got) != `{"type":"recover","reason":"harness exited","compact":true,"tokens":400000}` {
		t.Fatalf("after the exit: %s %q pending %s", got.Lifecycle, detailOf(got), pendingText(got))
	}
	l.releaseNetwork()
	l.until("the recovery", func() bool { return l.has("alpx1", "recover") })
	if e := lastEvent(t, l, "alpx1", "recover"); e != `{"reason":"harness exited","compacted":true}` {
		t.Errorf("recover: %s", e)
	}
	if runs := l.compacts(); len(runs) != 1 || !strings.HasPrefix(runs[0], "alpx1:") || !strings.HasSuffix(runs[0], "||/compact") {
		t.Errorf("compactor runs: %q", runs)
	}
	if e := lastEvent(t, l, "alpx9", "notice:queued"); e != `{"text":"n-alpx1 exited at 400k context; compacted and resumed."}` {
		t.Errorf("parent's notice: %s", e)
	}
	if got := l.agent("alpx1"); got.Lifecycle != "active" || got.PendingAction != nil || !l.tmux.HasSession(l.ctx, "alpx1") {
		t.Errorf("resumed: %s %q pending %s", got.Lifecycle, detailOf(got), pendingText(got))
	}

	l.idle("alpx1")
	if err := l.tmux.KillSession(l.ctx, "alpx1"); err != nil {
		t.Fatal(err)
	}
	l.reconcile(l.life)
	if e := lastEvent(t, l, "alpx1", "exit:context"); e != `{"tokens":400000,"resumed":false}` {
		t.Errorf("second exit:context: %s", e)
	}
	if got := l.agent("alpx1"); got.Lifecycle != "shut_down" || detailOf(got) != "harness exited" || got.PendingAction != nil {
		t.Errorf("after the second exit: %s %q pending %s", got.Lifecycle, detailOf(got), pendingText(got))
	}
	if n := l.life.Notices("alpx9"); len(n) != 2 || n[1] != "n-alpx1 exited at 400k context again; not resumed." {
		t.Errorf("parent's notices: %q", n)
	}
}

// TestInterruptedCompaction: on a restarted daemon's first pass, an agent whose last event is a compaction with no end
// was being compacted, not exiting: it is compacted and resumed, quietly.
func TestInterruptedCompaction(t *testing.T) {
	l := newLive(t)
	l.spawn("alpi9")
	l.spawn("alpi1", "alpi9")
	l.idle("alpi1")
	if err := l.db.AddEvent(l.ctx, "alpi1", "compact", map[string]string{"op": "op-1"}); err != nil {
		t.Fatal(err)
	}
	if err := l.tmux.KillSession(l.ctx, "alpi1"); err != nil {
		t.Fatal(err)
	}
	l.holdNetwork()
	restarted := New(l.ctx, l.opts)
	t.Cleanup(func() { l.releaseNetwork(); l.stop(); restarted.Wait() })
	l.prime(restarted)
	l.reconcile(restarted)
	if e := lastEvent(t, l, "alpi1", "exit:compaction"); e != `{"tokens":0,"op":"op-1"}` {
		t.Errorf("exit:compaction: %s", e)
	}
	if p := pendingText(l.agent("alpi1")); p != `{"type":"recover","reason":"stam restarted during a compaction","compact":true,"tokens":0,"interrupted":"op-1"}` {
		t.Fatalf("pending: %s", p)
	}
	l.releaseNetwork()
	l.until("the recovery", func() bool { return l.has("alpi1", "recover") })
	if e := lastEvent(t, l, "alpi1", "recover"); e != `{"reason":"stam restarted during a compaction","compacted":true}` {
		t.Errorf("recover: %s", e)
	}
	if l.has("alpi9", "notice:queued") {
		t.Error("an interrupted compaction told the parent")
	}
}

// TestStaleWorking: a working agent at an empty prompt with no hook past settings.staleWorkingMinutes ends its turn.
func TestStaleWorking(t *testing.T) {
	l := newLive(t)
	l.setSettings(`{"staleWorkingMinutes":0.0001}`)
	l.spawn("alps1")
	l.set("alps1", db.Field{Col: "activity", Val: "working"})
	l.until("the fake's prompt", func() bool { return l.life.atPrompt(l.ctx, l.agent("alps1")) })
	sh := l.shim(l.life, "alps1")
	l.mail("alps1", "mlps1", "waiting for the turn end", false)
	l.prime(l.life)
	l.reconcile(l.life)
	if got := l.agent("alps1"); got.Activity != "idle" || detailOf(got) != "turn finished" {
		t.Errorf("after the sweep: %s %q", got.Activity, detailOf(got))
	}
	if e := lastEvent(t, l, "alps1", "activity:reconciled"); !strings.HasPrefix(e, `{"last_hook":"`) {
		t.Errorf("activity:reconciled: %s", e)
	}
	// The turn end it stood in for pushes the mail.
	if p := sh.next(t); !strings.Contains(p.Content, "mlps1") {
		t.Errorf("prompt %q", p.Content)
	}
}

// TestFirstPromptRecovery: a spawn whose first prompt a restart cut short is launched again with it on the first pass;
// one whose launch fails is stopped, errored, and its parent told.
func TestFirstPromptRecovery(t *testing.T) {
	l := newLive(t)
	l.spawn("alpf9")
	for _, id := range []string{"alpf1", "alpf2"} {
		// alpf2's launch fails: the Go daemon launches Claude Code only.
		harness := "claude"
		if id == "alpf2" {
			harness = "codex"
		}
		parent := "alpf9"
		if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: id, Name: "n-" + id, Machine: "test-machine", Harness: harness, Cwd: l.work, ParentID: &parent}); err != nil {
			t.Fatal(err)
		}
		l.set(id, db.Field{Col: "workspace", Val: `{"cwd":"` + l.work + `"}`}, db.Field{Col: "first_prompt", Val: "Do the work"},
			db.Field{Col: "activity", Val: "starting"}, db.Field{Col: "permission_mode", Val: "auto"})
		if err := l.db.AddEvent(l.ctx, id, "first-prompt:pending", nil); err != nil {
			t.Fatal(err)
		}
	}
	restarted := New(l.ctx, l.opts)
	t.Cleanup(func() { l.stop(); restarted.Wait() })
	l.prime(restarted)
	l.reconcile(restarted)
	l.until("alpf1's relaunch", func() bool { return l.has("alpf1", "spawn") })
	if !l.has("alpf1", "first-prompt:recover") || !l.tmux.HasSession(l.ctx, "alpf1") {
		t.Errorf("alpf1: recover %v, session %v", l.has("alpf1", "first-prompt:recover"), l.tmux.HasSession(l.ctx, "alpf1"))
	}
	l.until("alpf2's failure", func() bool { return l.has("alpf2", "first-prompt:failed") })
	got := l.agent("alpf2")
	if got.Lifecycle != "shut_down" || got.Activity != "errored" || !strings.HasPrefix(detailOf(got), "first prompt not delivered: ") {
		t.Errorf("alpf2: %s %s %q", got.Lifecycle, got.Activity, detailOf(got))
	}
	if n := l.life.Notices("alpf9"); len(n) != 0 {
		t.Errorf("notices on the first lifecycle: %q", n)
	}
	if n := restarted.Notices("alpf9"); len(n) != 1 || n[0] != "n-alpf2 never got its first prompt (n-alpf2 runs codex, which the Go daemon can't control yet); respawn it." {
		t.Errorf("parent's notices: %q", n)
	}
}

// TestStartingDead: an agent stuck starting with no pane is stopped, its parent told, and its pending shutdown run.
func TestStartingDead(t *testing.T) {
	l := newLive(t)
	l.setSettings(`{"startingTimeoutMinutes":0.0001}`)
	l.spawn("alpz9")
	l.idle("alpz9")
	parent := "alpz9"
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "alpz1", Name: "n-alpz1", Machine: "test-machine", Harness: "claude", Cwd: l.work, ParentID: &parent}); err != nil {
		t.Fatal(err)
	}
	l.set("alpz1", db.Field{Col: "workspace", Val: `{"cwd":"` + l.work + `"}`}, db.Field{Col: "activity", Val: "starting"},
		db.Field{Col: "pending_action", Val: `{"type":"shutdown"}`})
	l.prime(l.life)
	l.reconcile(l.life)
	if got := l.agent("alpz1"); got.Lifecycle != "shut_down" || got.PendingAction != nil || !l.has("alpz1", "starting:dead") || !l.has("alpz1", "shutdown") {
		t.Errorf("alpz1: %s %q pending %s, starting:dead %v", got.Lifecycle, detailOf(got), pendingText(got), l.has("alpz1", "starting:dead"))
	}
	if n := l.life.Notices("alpz9"); len(n) != 1 || n[0] != "n-alpz1 never started: no harness process after 0 minutes; stam marked it stopped." {
		t.Errorf("parent's notices: %q", n)
	}
}

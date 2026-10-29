package lifecycle

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/db"
)

func (l *live) addBlocker(id, kind, account, reason string) db.Blocker {
	l.t.Helper()
	b, err := l.life.AddBlocker(l.ctx, id, NewBlocker{Kind: kind, Account: account, Reason: reason})
	if err != nil {
		l.t.Fatal(err)
	}
	return b
}

func (l *live) clearBlocker(id, kind, account, cleared string) bool {
	l.t.Helper()
	resumed, err := l.life.ClearBlocker(l.ctx, id, kind, account, cleared, nil)
	if err != nil {
		l.t.Fatal(err)
	}
	return resumed
}

func (l *live) blockerRows(id string) []db.Blocker {
	l.t.Helper()
	rows, err := l.db.BlockerRows(l.ctx, id)
	if err != nil {
		l.t.Fatal(err)
	}
	return rows
}

// TestBlockers: the first blocker pauses an active agent with stam as the owner and tells it; another, or a refresh
// that keeps its since, changes nothing more; the mail it holds back waits. Clearing all but one keeps it paused;
// clearing the last resumes it with cost-resumed.md, and the held mail goes in.
func TestBlockers(t *testing.T) {
	l := newLive(t)
	l.spawn("alb1")
	l.idle("alb1")
	sh := l.shim(l.life, "alb1")
	if _, err := l.life.AddBlocker(l.ctx, "alb1", NewBlocker{Kind: "nope", Reason: "x"}); err == nil || !strings.Contains(err.Error(), "unknown blocker kind nope") {
		t.Errorf("an unknown kind: %v", err)
	}
	clear := `{"windows":{"five_hour":{"pct":100,"resets_at":1800000000,"after":"2026-01-01T00:00:00.000Z"}}}`
	b, err := l.life.AddBlocker(l.ctx, "alb1", NewBlocker{Kind: "window", Account: "claude-max", Reason: "five_hour at 100%", Clear: &clear})
	if err != nil {
		t.Fatal(err)
	}
	if b.AgentID != "alb1" || b.Kind != "window" || b.Account != "claude-max" || b.Since == "" || b.Clear == nil || *b.Clear != clear {
		t.Errorf("added %+v", b)
	}
	a := l.agent("alb1")
	if a.Lifecycle != "paused" || a.PausedBy != nil {
		t.Errorf("after the first: %s, paused_by %v", a.Lifecycle, a.PausedBy)
	}
	if e := lastEvent(t, l, "alb1", "blocker:add"); e != `{"kind":"window","account":"claude-max","reason":"five_hour at 100%"}` {
		t.Errorf("blocker:add %s", e)
	}
	if e := lastEvent(t, l, "alb1", "pause"); e != `{"owner":"stam"}` {
		t.Errorf("pause %s", e)
	}
	if p := sh.next(t); p.Content != l.render("pause", nil) {
		t.Errorf("the pause notice %q", p.Content)
	}
	if e := lastEvent(t, l, "alb1", "prompt:sent"); e != `{"kind":null}` {
		t.Errorf("prompt:sent %s", e)
	}

	// A refresh keeps its since; a second blocker adds no pause.
	time.Sleep(5 * time.Millisecond)
	again := l.addBlocker("alb1", "window", "claude-max", "five_hour at 100%, seven_day at 100%")
	if again.Since != b.Since || again.Reason != "five_hour at 100%, seven_day at 100%" || again.Clear != nil {
		t.Errorf("refreshed %+v, since was %s", again, b.Since)
	}
	l.addBlocker("alb1", "credits-out", "claude-max", "a credits error")
	if n := l.countEvents("alb1", "pause"); n != 1 {
		t.Errorf("%d pauses", n)
	}
	sh.none(t, "a second blocker")

	// Mail waits while it is blocked.
	l.mail("alb1", "mlb1", "held", false)
	l.life.pushIfIdle(l.ctx, "alb1")
	sh.none(t, "a blocked agent")

	if l.clearBlocker("alb1", "window", "claude-max", "a fresh reading") {
		t.Error("resumed with a blocker left")
	}
	if l.agent("alb1").Lifecycle != "paused" {
		t.Error("not paused with a blocker left")
	}
	if e := lastEvent(t, l, "alb1", "blocker:clear"); e != `{"kind":"window","account":"claude-max","cleared":"a fresh reading"}` {
		t.Errorf("blocker:clear %s", e)
	}
	if l.clearBlocker("alb1", "window", "claude-max", "again") {
		t.Error("a second clear of the same blocker resumed")
	}
	if !l.clearBlocker("alb1", "credits-out", "claude-max", "") {
		t.Fatal("the last clear didn't resume")
	}
	if a := l.agent("alb1"); a.Lifecycle != "active" || a.PausedBy != nil {
		t.Errorf("after the last: %s %v", a.Lifecycle, a.PausedBy)
	}
	want := l.render("cost-resumed", map[string]string{"blocker": "credits-out on claude-max", "reason": "a credits error", "cleared": "its condition cleared"})
	if p := sh.next(t); p.Content != want {
		t.Errorf("resumed with %q\nwant %q", p.Content, want)
	}
	if e := lastEvent(t, l, "alb1", "prompt:sent"); e != `{"kind":"unpause"}` {
		t.Errorf("prompt:sent %s", e)
	}
	if !l.has("alb1", "unpause") {
		t.Error("no unpause event")
	}
	// The held mail goes in once the agent is idle again.
	l.idle("alb1")
	l.life.SchedulePush("alb1")
	if p := sh.next(t); !strings.Contains(p.Content, "mlb1") {
		t.Errorf("the held mail %q", p.Content)
	}
}

// TestBlockerHumanPause: a blocker on an agent the human paused adds no owner; its clear leaves the agent paused for
// the human, and its held mail goes in as to any paused agent.
func TestBlockerHumanPause(t *testing.T) {
	l := newLive(t)
	l.spawn("alh1")
	l.idle("alh1")
	sh := l.shim(l.life, "alh1")
	l.set("alh1", db.Field{Col: "lifecycle", Val: "paused"}, db.Field{Col: "paused_by", Val: `["human"]`})
	l.addBlocker("alh1", "manual", "", "paused until a reset")
	if a := l.agent("alh1"); a.PausedBy == nil || *a.PausedBy != `["human"]` || l.has("alh1", "pause") {
		t.Errorf("the human's pause changed: %v", a.PausedBy)
	}
	l.mail("alh1", "mlh1", "while paused", false)
	if l.clearBlocker("alh1", "manual", "", "the set time passed") {
		t.Error("resumed an agent the human paused")
	}
	if a := l.agent("alh1"); a.Lifecycle != "paused" || a.PausedBy == nil || *a.PausedBy != `["human"]` {
		t.Errorf("after the clear: %s %v", a.Lifecycle, a.PausedBy)
	}
	if p := sh.next(t); !strings.Contains(p.Content, "mlh1") {
		t.Errorf("the mail held by the blocker %q", p.Content)
	}
}

// TestBlockersRestart: blockers live in the database, so a new daemon holds the agent: its launch comes back paused,
// without its prompt, and the launch-held event names the blockers. A cleared blocker stays cleared.
func TestBlockersRestart(t *testing.T) {
	l := newLive(t)
	l.spawn("alr1")
	l.idle("alr1")
	l.addBlocker("alr1", "window", "claude-max", "five_hour at 100%")
	opts := l.opts
	opts.Streams = newStreams()
	life2 := New(l.ctx, opts)
	t.Cleanup(life2.Wait)
	if !life2.isHeld(l.ctx, l.agent("alr1")) {
		t.Fatal("a new daemon doesn't hold the blocked agent")
	}
	if err := life2.StartHarness(l.ctx, l.agent("alr1"), "do the work", true, "resume"); err != nil {
		t.Fatal(err)
	}
	if e := lastEvent(t, l, "alr1", "launch-held"); e != `{"owners":[],"blockers":["window"]}` {
		t.Errorf("launch-held %s", e)
	}
	if e := lastEvent(t, l, "alr1", "cost:refused"); e != `{"kind":"resume","reason":"window on claude-max: five_hour at 100%"}` {
		t.Errorf("refused %s", e)
	}
	l.until("the relaunch", func() bool { return l.agent("alr1").Activity != "starting" || l.agent("alr1").Lifecycle == "paused" })
	if a := l.agent("alr1"); a.Lifecycle != "paused" {
		t.Errorf("relaunched %s", a.Lifecycle)
	}
	if _, err := life2.ClearBlocker(l.ctx, "alr1", "window", "claude-max", "a fresh reading", nil); err != nil {
		t.Fatal(err)
	}
	life3 := New(l.ctx, opts)
	t.Cleanup(life3.Wait)
	if len(l.blockerRows("alr1")) != 0 || life3.isHeld(l.ctx, l.agent("alr1")) {
		t.Error("a cleared blocker came back")
	}
}

// TestBlockersFailClosed: blockers that can't be read hold the agent.
func TestBlockersFailClosed(t *testing.T) {
	l := newLive(t)
	l.spawn("alf1")
	if l.life.isHeld(l.ctx, l.agent("alf1")) {
		t.Fatal("held with nothing")
	}
	execOn(t, l, "ALTER TABLE blockers RENAME TO blockers_gone")
	if !l.life.isHeld(l.ctx, l.agent("alf1")) {
		t.Error("not held when the blockers can't be read")
	}
}

// TestBlockerAddRacesResume: a blocker added while another's clear is about to resume the agent waits for that
// change, then pauses it again: the agent never ends active with a blocker (the add and clear, and the pause and
// resume they cause, run in serial).
func TestBlockerAddRacesResume(t *testing.T) {
	l := newLive(t)
	l.spawn("alc1")
	l.idle("alc1")
	l.addBlocker("alc1", "window", "claude-max", "five_hour at 100%")
	at, release := make(chan struct{}), make(chan struct{})
	l.life.resuming = func(string) {
		close(at)
		<-release
	}
	cleared := make(chan error, 1)
	go func() {
		_, err := l.life.ClearBlocker(l.ctx, "alc1", "window", "claude-max", "a fresh reading", nil)
		cleared <- err
	}()
	<-at
	// The add says when it waits for the agent's serial, which the clear holds.
	waiting := make(chan struct{})
	l.life.mu.Lock()
	l.life.serialWaiting = func(string) { close(waiting) }
	l.life.mu.Unlock()
	added := make(chan error, 1)
	go func() {
		_, err := l.life.AddBlocker(l.ctx, "alc1", NewBlocker{Kind: "credits-out", Account: "claude-max", Reason: "a credits error"})
		added <- err
	}()
	<-waiting
	l.life.mu.Lock()
	l.life.serialWaiting = nil
	l.life.mu.Unlock()
	select {
	case err := <-added:
		t.Errorf("the add ran inside the clear: %v", err)
	default:
	}
	l.life.resuming = nil
	close(release)
	if err := <-cleared; err != nil {
		t.Fatal(err)
	}
	if err := <-added; err != nil {
		t.Fatal(err)
	}
	if a := l.agent("alc1"); a.Lifecycle != "paused" || len(l.blockerRows("alc1")) != 1 {
		t.Errorf("after the race: %s with %d blockers", a.Lifecycle, len(l.blockerRows("alc1")))
	}
}

// TestBlockerRelaunch: an agent whose terminal went down while it was blocked comes back on its own conversation when
// the blocker clears, and a second resume while the first holds the transition is refused: one launch.
func TestBlockerRelaunch(t *testing.T) {
	l := newLive(t)
	l.spawn("all1")
	l.idle("all1")
	l.addBlocker("all1", "window", "claude-max", "five_hour at 100%")
	if err := l.tmux.KillSession(l.ctx, "all1"); err != nil {
		t.Fatal(err)
	}
	resumes := l.countEvents("all1", "resume")
	if _, _, err := l.db.DropBlocker(l.ctx, "all1", "window", "claude-max", nil); err != nil {
		t.Fatal(err)
	}
	text := l.render("cost-resumed", map[string]string{"blocker": "window on claude-max", "reason": "r", "cleared": "c"})
	// The first resume stops once it holds the transition, before it writes anything.
	at, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	l.life.acquired = func(string) {
		if calls.Add(1) == 1 {
			close(at)
			<-release
		}
	}
	first := make(chan error, 1)
	go func() {
		// Outside serial, so only the resume's own transition lock keeps the two apart.
		_, err := l.life.resumeNow(l.ctx, "all1", text)
		first <- err
	}()
	<-at
	if _, err := l.life.resumeNow(l.ctx, "all1", text); err == nil || !strings.Contains(err.Error(), "is being resumed") {
		t.Errorf("the second resume: %v", err)
	}
	if a := l.agent("all1"); a.Lifecycle != "paused" || l.tmux.HasSession(l.ctx, "all1") {
		t.Errorf("while the first is held: %s", a.Lifecycle)
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	l.life.acquired = nil
	l.until("the relaunch", func() bool { return l.tmux.HasSession(l.ctx, "all1") })
	if n := l.countEvents("all1", "resume"); n != resumes+1 {
		t.Errorf("%d launches", n-resumes)
	}
	if e := lastEvent(t, l, "all1", "resume"); !strings.Contains(e, `"--resume","11111111-2222-4333-8444-555555555555"`) {
		t.Errorf("resume %s", e)
	}
	if a := l.agent("all1"); a.Lifecycle != "active" || !l.has("all1", "unpause") {
		t.Errorf("after the relaunch: %s", a.Lifecycle)
	}
}

// TestBlockerDuringLaunch: a blocker that arrives while the harness starts keeps the first prompt back at the
// admission gate, right before it goes in: the prompt waits as an idle notice, and the agent leaves starting.
func TestBlockerDuringLaunch(t *testing.T) {
	l := newLive(t)
	session := "11111111-2222-4333-8444-" + strings.Repeat("5", 12)
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "ald1", Name: "n-ald1", Role: "developer", Machine: "test-machine", Harness: "claude",
		Cwd: l.work, SessionID: &session}); err != nil {
		t.Fatal(err)
	}
	hold := filepath.Join(l.base, "hold-box")
	if err := os.WriteFile(hold, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := l.life.StartHarness(l.ctx, l.agent("ald1"), "the first task", false, "spawn"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := l.db.PutBlocker(l.ctx, db.Blocker{AgentID: "ald1", Kind: "window", Account: "claude-max", Reason: "five_hour at 100%"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(hold); err != nil {
		t.Fatal(err)
	}
	l.until("the gate", func() bool { return l.has("ald1", "launch-held") })
	if e := lastEvent(t, l, "ald1", "launch-held"); e != `{"blockers":["window"],"late":true}` {
		t.Errorf("launch-held %s", e)
	}
	// The gate records the event, then moves the agent off starting, then queues the notice: wait for the last.
	l.until("the notice", func() bool { return len(l.life.Notices("ald1")) > 0 })
	if a := l.agent("ald1"); a.Activity != "idle" || a.ActivityDetail == nil || *a.ActivityDetail != "ready" {
		t.Errorf("activity %s %v", a.Activity, a.ActivityDetail)
	}
	if n := l.life.Notices("ald1"); len(n) != 1 || n[0] != "the first task" {
		t.Errorf("notices %v", n)
	}
	if strings.Contains(l.screenText("ald1"), "the first task") {
		t.Error("the prompt went in")
	}
}

// TestBlockerBeforeLaunchWrite: a blocker added after a launch's first held check, before it writes the agent's state,
// leaves the agent paused without its prompt: the final check and the write run in the agent's serial, so the launch
// never marks it active over the blocker.
func TestBlockerBeforeLaunchWrite(t *testing.T) {
	l := newLive(t)
	session := "11111111-2222-4333-8444-" + strings.Repeat("5", 12)
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "alw1", Name: "n-alw1", Role: "developer", Machine: "test-machine", Harness: "claude",
		Cwd: l.work, SessionID: &session}); err != nil {
		t.Fatal(err)
	}
	l.life.launching = func(id string) {
		if _, err := l.life.AddBlocker(l.ctx, id, NewBlocker{Kind: "window", Account: "claude-max", Reason: "five_hour at 100%"}); err != nil {
			t.Error(err)
		}
	}
	if err := l.life.StartHarness(l.ctx, l.agent("alw1"), "the first task", false, "spawn"); err != nil {
		t.Fatal(err)
	}
	l.life.launching = nil
	if a := l.agent("alw1"); a.Lifecycle != "paused" {
		t.Errorf("after the launch: %s", a.Lifecycle)
	}
	if e := lastEvent(t, l, "alw1", "launch-held"); e != `{"owners":[],"blockers":["window"]}` {
		t.Errorf("launch-held %s", e)
	}
	if e := lastEvent(t, l, "alw1", "spawn"); !strings.HasSuffix(e, `"prompt":false}`) {
		t.Errorf("spawn %s", e)
	}
}

// TestBlockerClearRelaunch: the last blocker's clear relaunches an agent whose terminal went down, from inside the
// agent's serial: the launch's final write runs in the same serial without waiting on it.
func TestBlockerClearRelaunch(t *testing.T) {
	l := newLive(t)
	l.spawn("alx1")
	l.idle("alx1")
	l.addBlocker("alx1", "window", "claude-max", "five_hour at 100%")
	if err := l.tmux.KillSession(l.ctx, "alx1"); err != nil {
		t.Fatal(err)
	}
	done := make(chan bool, 1)
	go func() { done <- l.clearBlocker("alx1", "window", "claude-max", "a fresh reading") }()
	select {
	case resumed := <-done:
		if !resumed {
			t.Error("not resumed")
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the clear's relaunch waited on its own serial")
	}
	l.until("the relaunch", func() bool { return l.tmux.HasSession(l.ctx, "alx1") })
	if a := l.agent("alx1"); a.Lifecycle != "active" {
		t.Errorf("after the relaunch: %s", a.Lifecycle)
	}
}

// TestStopWhileLaunchWaits: a stop while a launch waits on the agent's serial for its final write wins: the agent ends
// shut down, not marked active over the stop.
func TestStopWhileLaunchWaits(t *testing.T) {
	l := newLive(t)
	session := "11111111-2222-4333-8444-" + strings.Repeat("5", 12)
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "als1", Name: "n-als1", Role: "developer", Machine: "test-machine", Harness: "claude",
		Cwd: l.work, SessionID: &session}); err != nil {
		t.Fatal(err)
	}
	holding, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		done <- l.life.serial(l.ctx, "als1", func(context.Context) error {
			close(holding)
			<-release
			return nil
		})
	}()
	<-holding
	waiting := make(chan struct{}, 2)
	l.life.mu.Lock()
	l.life.serialWaiting = func(string) { waiting <- struct{}{} }
	l.life.mu.Unlock()
	launched := make(chan error, 1)
	go func() { launched <- l.life.StartHarness(l.ctx, l.agent("als1"), "the first task", false, "spawn") }()
	<-waiting
	// The stop cancels the launch and kills its session at once; its own write waits on the serial too.
	stopped := make(chan error, 1)
	go func() { stopped <- l.life.Shutdown(l.ctx, l.agent("als1")) }()
	<-waiting
	l.life.mu.Lock()
	l.life.serialWaiting = nil
	l.life.mu.Unlock()
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := <-launched; err != nil {
		t.Fatal(err)
	}
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
	if a := l.agent("als1"); a.Lifecycle != "shut_down" || a.Activity != "unknown" {
		t.Errorf("after the stop: %s %s", a.Lifecycle, a.Activity)
	}
	if l.tmux.HasSession(l.ctx, "als1") {
		t.Error("the session outlived the stop")
	}
	if l.has("als1", "spawn") {
		t.Error("the superseded launch recorded a spawn")
	}
}

// TestBlockerClearedDuringLaunch: a held agent's launch whose last blocker clears after its session started (the
// clear's resume makes it active) leaves it active: the final write reads held again rather than its first answer.
func TestBlockerClearedDuringLaunch(t *testing.T) {
	l := newLive(t)
	session := "11111111-2222-4333-8444-" + strings.Repeat("5", 12)
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "alu1", Name: "n-alu1", Role: "developer", Machine: "test-machine", Harness: "claude",
		Cwd: l.work, SessionID: &session}); err != nil {
		t.Fatal(err)
	}
	if err := l.db.UpdateAgent(l.ctx, "alu1", db.Field{Col: "lifecycle", Val: "paused"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := l.db.PutBlocker(l.ctx, db.Blocker{AgentID: "alu1", Kind: "window", Account: "claude-max", Reason: "five_hour at 100%"}, nil); err != nil {
		t.Fatal(err)
	}
	l.life.launching = func(id string) {
		if resumed, err := l.life.ClearBlocker(l.ctx, id, "window", "claude-max", "a fresh reading", nil); err != nil || !resumed {
			t.Errorf("the clear: %v, resumed %v", err, resumed)
		}
	}
	if err := l.life.StartHarness(l.ctx, l.agent("alu1"), "carry on", true, "resume"); err != nil {
		t.Fatal(err)
	}
	l.life.launching = nil
	if a := l.agent("alu1"); a.Lifecycle != "active" {
		t.Errorf("after the launch: %s", a.Lifecycle)
	}
}

// TestStopAfterLaunchWrite: a stop that comes while a launch past its generation check holds the agent's serial writes
// after the launch's write, so the agent ends shut down rather than marked active over the stop.
func TestStopAfterLaunchWrite(t *testing.T) {
	l := newLive(t)
	l.spawn("alt1")
	l.idle("alt1")
	holding, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		// Stands in for a launch's final write, in the serial.
		done <- l.life.serial(l.ctx, "alt1", func(ctx context.Context) error {
			close(holding)
			<-release
			return l.db.UpdateAgent(ctx, "alt1", db.Field{Col: "lifecycle", Val: "active"}, db.Field{Col: "activity", Val: "starting"})
		})
	}()
	<-holding
	waiting := make(chan struct{})
	l.life.mu.Lock()
	l.life.serialWaiting = func(string) { close(waiting) }
	l.life.mu.Unlock()
	stopped := make(chan error, 1)
	go func() { stopped <- l.life.Shutdown(l.ctx, l.agent("alt1")) }()
	<-waiting
	l.life.mu.Lock()
	l.life.serialWaiting = nil
	l.life.mu.Unlock()
	if a := l.agent("alt1"); a.Lifecycle == "shut_down" {
		t.Error("the stop wrote inside the launch's serial")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
	if a := l.agent("alt1"); a.Lifecycle != "shut_down" {
		t.Errorf("after the stop: %s", a.Lifecycle)
	}
}

// TestSerialLocksPruned: an agent's serial lock leaves the map once no one holds or waits for it.
func TestSerialLocksPruned(t *testing.T) {
	l := newLive(t)
	l.spawn("alsp1")
	l.addBlocker("alsp1", "window", "claude-max", "five_hour at 100%")
	l.clearBlocker("alsp1", "window", "claude-max", "a fresh reading")
	l.life.mu.Lock()
	n := len(l.life.serialLocks)
	l.life.mu.Unlock()
	if n != 0 {
		t.Errorf("%d serial locks left", n)
	}
}

package lifecycle

import (
	"context"
	"strings"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/adapters/opencode"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// resting starts an agent's harness, gives it a wait_for on the human that asks for a rest (timeout minutes, 30 when 0),
// and ends its turn: idle since now, after its launch's prompt, with the rest's delay a millisecond.
func (l *live) restReady(id string, timeout float64) db.Wait {
	l.t.Helper()
	l.t.Setenv("STAM_REST_ENABLED", "1")
	l.life.rest.delay = time.Millisecond
	l.spawn(id)
	if timeout == 0 {
		timeout = 30
	}
	w, err := l.life.DeclareWait(l.ctx, l.agent(id), Declare{On: "human", Timeout: &timeout})
	if err != nil {
		l.t.Fatal(err)
	}
	if err := l.life.RequestRest(l.ctx, id, w); err != nil {
		l.t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	l.set(id, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "idle_since", Val: iso(time.Now())})
	time.Sleep(5 * time.Millisecond)
	return l.waits(id)[0]
}

// rest rests the agent and checks it rested: paused with the rest its one owner, its harness gone.
func (l *live) rest(id string) {
	l.t.Helper()
	got, err := l.life.Rest(l.ctx, id)
	if err != nil || got != "resting" {
		l.t.Fatalf("rest %s: %q %v", id, got, err)
	}
	if a := l.agent(id); !isResting(a) || l.tmux.HasSession(l.ctx, id) {
		l.t.Fatalf("%s after the rest: %s %v, session %v", id, a.Lifecycle, a.PausedBy, l.tmux.HasSession(l.ctx, id))
	}
}

// mailFromHuman stores the human's mail to the agent and schedules its push, as the mail route does.
func (l *live) mailFromHuman(life *Lifecycle, id, mail string) {
	l.t.Helper()
	l.send("human", id, mail, "")
	life.SchedulePush(id)
}

// awake waits for the agent to be up again on its conversation, once, with its harness running.
func (l *live) awake(id string) {
	l.t.Helper()
	l.until(id+" awake", func() bool {
		a := l.agent(id)
		return a.Lifecycle == "active" && l.tmux.HasSession(l.ctx, id)
	})
}

// restartedOnDB is a daemon restarted on the same database: a lifecycle of its own, stopped at the test's end before the
// first one.
func (l *live) restartedOnDB() *Lifecycle {
	l.t.Helper()
	ctx, cancel := context.WithCancel(l.ctx)
	life := New(ctx, l.opts)
	life.rest.delay = time.Millisecond
	l.t.Cleanup(func() { cancel(); life.Wait() })
	return life
}

// serialUsers is how many hold or wait for the agent's serial lock; 0 when none does.
func (life *Lifecycle) serialUsers(id string) int {
	life.mu.Lock()
	defer life.mu.Unlock()
	if m := life.serialLocks[id]; m != nil {
		return m.users
	}
	return 0
}

// serialBlocked is how many calls are blocked on the agent's serial lock, held by another: queued behind it.
func (life *Lifecycle) serialBlocked(id string) int {
	life.mu.Lock()
	defer life.mu.Unlock()
	if m := life.serialLocks[id]; m != nil {
		return m.blocked
	}
	return 0
}

// TestRestAndWakeOnMail: a requested rest stops the harness at the turn end and pauses the agent with the rest as owner;
// the human's answer clears the wait and wakes it on its conversation, once, with the standing-wake prompt.
func TestRestAndWakeOnMail(t *testing.T) {
	l := newLive(t)
	l.restReady("arl1", 0)
	l.rest("arl1")
	if got := l.events("arl1", "standing:rest"); len(got) != 1 || !strings.Contains(got[0], `"reason":"wait"`) {
		t.Errorf("rest events: %v", got)
	}
	if d := detailOf(l.agent("arl1")); !strings.HasPrefix(d, "resting: waiting, expected wake ") {
		t.Errorf("detail: %q", d)
	}
	l.mailFromHuman(l.life, "arl1", "m00c0001")
	l.awake("arl1")
	if n := len(l.waits("arl1")); n != 0 {
		t.Errorf("the answer left %d waits", n)
	}
	if got := l.events("arl1", "standing:wake"); len(got) != 1 {
		t.Errorf("wakes: %v", got)
	}
	if got := l.events("arl1", "unpause"); len(got) != 1 {
		t.Errorf("relaunches: %v", got)
	}
}

// TestRestRefusals: no rest when the wait it asked with was answered first, when its turn started again (the request is
// dropped), when mail waits unpushed, or while a notice is queued.
func TestRestRefusals(t *testing.T) {
	l := newLive(t)
	l.restReady("arn1", 0)
	l.send("human", "arn1", "m00c0002", "")
	if got, _ := l.life.Rest(l.ctx, "arn1"); got != "no rest request" || l.agent("arn1").Lifecycle != "active" {
		t.Errorf("a wait answered first: %q", got)
	}
	l.restReady("arn2", 0)
	l.life.restTurnStarted(l.ctx, "arn2")
	if got, _ := l.life.Rest(l.ctx, "arn2"); got != "no rest request" {
		t.Errorf("a new turn: %q", got)
	}
	l.restReady("arn3", 0)
	l.send("aboss", "arn3", "m00c0003", "")
	if got, _ := l.life.Rest(l.ctx, "arn3"); got != "unpushed mail" {
		t.Errorf("unpushed mail: %q", got)
	}
	l.restReady("arn4", 0)
	l.life.mu.Lock()
	if l.life.notices == nil {
		l.life.notices = map[string][]notice{}
	}
	l.life.notices["arn4"] = []notice{{Text: "x"}}
	l.life.mu.Unlock()
	if got, _ := l.life.Rest(l.ctx, "arn4"); got != "notices queued" {
		t.Errorf("a queued notice: %q", got)
	}
	l.restReady("arn5", 0)
	t.Setenv("STAM_REST_ENABLED", "0")
	if got, _ := l.life.Rest(l.ctx, "arn5"); got != "rest disabled" {
		t.Errorf("rest disabled: %q", got)
	}
}

// TestRestDroppedOnOpenCodeTurnStart: an OpenCode execution that starts on an agent not already working is a new turn,
// so the rest its last turn asked for is dropped (src/adapters/opencode.ts onEvent): on the idle agent, and on one a
// wake left starting.
func TestRestDroppedOnOpenCodeTurnStart(t *testing.T) {
	for _, from := range []string{"idle", "starting"} {
		t.Run(from, func(t *testing.T) {
			// An OpenCode agent on a server, so the start runs in the session the row runs (owner.startExec).
			s := newStopLive(t)
			l := s.live
			l.restReady("aro1", 0)
			s.exec("UPDATE agents SET harness = 'opencode' WHERE id = 'aro1'")
			l.set("aro1", db.Field{Col: "activity", Val: from})
			sid := deref(l.agent("aro1").SessionID)
			l.life.onOpenCodeEvent(l.ctx, opencode.Event{Type: "session.execution.started", Data: jsjson.NewObject("sessionID", sid)})
			if a := l.agent("aro1"); a.Activity != "working" {
				t.Fatalf("after the execution started: %s", a.Activity)
			}
			l.set("aro1", db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "idle_since", Val: iso(time.Now().Add(-time.Second))})
			if got, _ := l.life.Rest(l.ctx, "aro1"); got != "no rest request" {
				t.Errorf("a rest after the OpenCode turn started: %q", got)
			}
		})
	}
}

// TestRestAtTurnEnd: the turn end (OnIdle) rests an agent whose wait asks for it, after the rest's delay.
func TestRestAtTurnEnd(t *testing.T) {
	l := newLive(t)
	l.restReady("art1", 0)
	if err := l.life.OnIdle(l.ctx, "art1"); err != nil {
		t.Fatal(err)
	}
	l.until("the rest", func() bool { return isResting(l.agent("art1")) && !l.tmux.HasSession(l.ctx, "art1") })
}

// TestRestSurvivesARestart: the request is on the wait, so a daemon that restarts before the turn-end timer fired rests
// the agent on its first sweep; one that restarts while it rests wakes it on the answer, and, separately, on the
// timeout its first tick fires.
func TestRestSurvivesARestart(t *testing.T) {
	l := newLive(t)
	l.restReady("ars1", 0)
	life2 := l.restartedOnDB()
	life2.sweepRest(l.ctx)
	if a := l.agent("ars1"); !isResting(a) || l.tmux.HasSession(l.ctx, "ars1") {
		t.Fatalf("after the restarted daemon's sweep: %s", a.Lifecycle)
	}
	life3 := l.restartedOnDB()
	l.mailFromHuman(life3, "ars1", "m00c0004")
	l.until("the wake", func() bool { return l.agent("ars1").Lifecycle == "active" && l.tmux.HasSession(l.ctx, "ars1") })

	// The timeout: due while the daemon was down, fired by the restarted daemon's first tick.
	w := l.restReady("ars2", 0)
	l.rest("ars2")
	past := iso(time.Now().Add(-time.Minute))
	if err := l.db.Write(l.ctx, func(c *sqlite.Conn) error {
		return sqlitex.Execute(c, "UPDATE waits SET until = ? WHERE id = ?", &sqlitex.ExecOptions{Args: []any{past, w.ID}})
	}); err != nil {
		t.Fatal(err)
	}
	life4 := l.restartedOnDB()
	if _, err := life4.TickWaits(l.ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	l.until("the wake on the timeout", func() bool { return l.agent("ars2").Lifecycle == "active" && l.tmux.HasSession(l.ctx, "ars2") })
	if got := l.events("ars2", "standing:wake"); len(got) != 1 {
		t.Errorf("wakes: %v", got)
	}
}

// TestNoticeBetweenRestCommitAndKill: a wake cause that arrives after the rest's checks and before its kill takes the
// rest back while the harness still runs; the agent never rests with something waiting for it.
func TestNoticeBetweenRestCommitAndKill(t *testing.T) {
	l := newLive(t)
	l.restReady("arc1", 0)
	l.life.rest.committed = func(id string) { l.mailFromHuman(l.life, id, "m00c0005") }
	if got, err := l.life.Rest(l.ctx, "arc1"); err != nil || got != "stays up: a notice or mail arrived" {
		t.Fatalf("rest: %q %v", got, err)
	}
	if a := l.agent("arc1"); a.Lifecycle != "active" || !l.tmux.HasSession(l.ctx, "arc1") {
		t.Errorf("after the undo: %s, session %v", a.Lifecycle, l.tmux.HasSession(l.ctx, "arc1"))
	}
	if got := l.events("arc1", "standing:rest-undone"); len(got) != 1 {
		t.Errorf("undo events: %v", got)
	}
}

// TestMailBetweenRestLandAndKill: mail that arrives once the rest committed and its flight landed finds the agent
// resting: its wake queues on the agent's serial behind the rest's kill, and starts it again after.
func TestMailBetweenRestLandAndKill(t *testing.T) {
	l := newLive(t)
	l.restReady("ark1", 0)
	l.life.rest.killing = func(id string) {
		l.mailFromHuman(l.life, id, "m00c0006")
		l.until("the wake blocked on serial", func() bool { return l.life.serialBlocked(id) == 1 })
	}
	if got, err := l.life.Rest(l.ctx, "ark1"); err != nil || got != "resting" {
		t.Fatalf("rest: %q %v", got, err)
	}
	l.life.rest.killing = nil
	l.awake("ark1")
	if got := l.events("ark1", "standing:wake"); len(got) != 1 {
		t.Errorf("wakes: %v", got)
	}
}

// TestTwoWakesLaunchOnce: mail and a timeout's notice at once both wake the resting agent; queued on its serial, the
// second finds it awake, so it launches once.
func TestTwoWakesLaunchOnce(t *testing.T) {
	l := newLive(t)
	l.restReady("arw1", 0)
	l.rest("arw1")
	hold, held := make(chan struct{}), make(chan struct{})
	go func() {
		_ = l.life.serial(l.ctx, "arw1", func(context.Context) error { close(held); <-hold; return nil })
	}()
	<-held
	l.mailFromHuman(l.life, "arw1", "m00c0007")
	l.life.QueueNotice(l.ctx, "arw1", "[stam] timed out", false)
	l.until("both wakes blocked on serial", func() bool { return l.life.serialBlocked("arw1") == 2 })
	close(hold)
	l.awake("arw1")
	if got := l.events("arw1", "standing:wake"); len(got) != 1 {
		t.Errorf("wakes: %v", got)
	}
	if got := l.events("arw1", "unpause"); len(got) != 1 {
		t.Errorf("relaunches: %v", got)
	}
}

// TestArchiveDuringRestKill: an archive that comes during the rest's kill queues on the agent's serial and archives it
// once the kill is done: its waits and rest state go, and a rest timer or a timeout firing after does nothing.
func TestArchiveDuringRestKill(t *testing.T) {
	l := newLive(t)
	l.restReady("ara1", 0)
	done := make(chan error, 1)
	l.life.rest.killing = func(id string) {
		// A turn-end timer still armed when the archive comes: the archive drops it.
		l.life.rest.delay = time.Hour
		l.life.restTurnEnded(id)
		go func() { _, err := l.life.Archive(l.ctx, l.agent(id), ArchiveOpts{}); done <- err }()
		l.until("the archive blocked on serial", func() bool { return l.life.serialBlocked(id) == 1 })
	}
	if got, err := l.life.Rest(l.ctx, "ara1"); err != nil || got != "resting" {
		t.Fatalf("rest: %q %v", got, err)
	}
	l.life.rest.killing = nil
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if a := l.agent("ara1"); a.Lifecycle != "archived" || len(l.waits("ara1")) != 0 {
		t.Fatalf("after the archive: %s, %d waits", a.Lifecycle, len(l.waits("ara1")))
	}
	l.life.mu.Lock()
	timers, flights := len(l.life.rest.timers), len(l.life.rest.flights)
	l.life.mu.Unlock()
	if timers != 0 || flights != 0 {
		t.Errorf("rest state left: %d timers, %d flights", timers, flights)
	}
	if got, _ := l.life.Rest(l.ctx, "ara1"); got != "not active" {
		t.Errorf("a rest after the archive: %q", got)
	}
	if n, _ := l.life.TickWaits(l.ctx, time.Now().Add(time.Hour)); n != 0 {
		t.Errorf("a tick after the archive fired %d", n)
	}
	if got, _ := l.life.WakeResting(l.ctx, "ara1", "x"); got != "not resting" || l.tmux.HasSession(l.ctx, "ara1") {
		t.Errorf("a wake after the archive: %q", got)
	}
}

// TestFailedWakeStaysResting: a wake whose launch fails leaves the agent resting, with the rest owner back on it and a
// standing:wake-error event; the next mail tries again and wakes it.
func TestFailedWakeStaysResting(t *testing.T) {
	l := newLive(t)
	l.restReady("arf1", 0)
	l.rest("arf1")
	sid := l.agent("arf1").SessionID
	l.set("arf1", db.Field{Col: "session_id", Val: nil})
	if got, err := l.life.WakeResting(l.ctx, "arf1", "x"); err != nil || got != errNothingWaiting.Error() {
		t.Errorf("a wake with nothing waiting: %q %v", got, err)
	}
	l.send("human", "arf1", "m00c0008", "")
	if _, err := l.life.WakeResting(l.ctx, "arf1", "mail"); err == nil || !strings.Contains(err.Error(), "no session to resume") {
		t.Fatalf("the failed wake: %v", err)
	}
	if a := l.agent("arf1"); !isResting(a) {
		t.Fatalf("after the failed wake: %s %v", a.Lifecycle, a.PausedBy)
	}
	if got := l.events("arf1", "standing:wake-error"); len(got) != 1 {
		t.Errorf("wake errors: %v", got)
	}
	l.set("arf1", db.Field{Col: "session_id", Val: *sid})
	l.mailFromHuman(l.life, "arf1", "m00c0009")
	l.awake("arf1")
}

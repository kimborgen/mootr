package lifecycle

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"

	"stam/internal/db"
)

// S-4254: reconcile stops again an OpenCode session the shared server still runs for an agent shut down or paused with
// no pane, from the row and the server's listing alone, and never one a launch owns.

// passed runs one reconcile pass after a first that took in the tmux server, so the second reads no lost server.
func (s *stopLive) passed() {
	s.t.Helper()
	s.reconcile(s.life)
}

// stopsEnded waits for every stop of sid to publish.
func (s *stopLive) stopsEnded(sid string) {
	s.t.Helper()
	s.until("every stop to end", func() bool { return s.life.turnStopOf(sid) == nil })
}

// restopPass runs a pass and fails the test at once unless it started a stop of sid: listed still, or done, an
// interrupt sent since or the session no longer active (its interrupt lands before it publishes).
func (s *stopLive) restopPass(sid string) {
	s.t.Helper()
	before := s.interruptsOf(sid)
	s.passed()
	if s.life.turnStopOf(sid) == nil && s.activeIn(sid) && s.interruptsOf(sid) == before {
		s.t.Fatalf("the pass started no stop of %s", sid)
	}
}

func (s *stopLive) activeIn(sid string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active[sid]
}

// A quit whose stop failed leaves the row noted and the session running: the next pass stops it, and the note clears.
func TestRestopAfterAFailedQuitStop(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("rs1", "active", true)
	s.set(func(s *stopLive) { s.stubborn = true })
	if err := s.life.Shutdown(s.ctx, a); err != nil {
		t.Fatal(err)
	}
	s.stopsEnded("ses_rs1")
	if a := s.agent("rs1"); !strings.HasPrefix(detailOf(a), "stop failed: ") {
		t.Fatalf("after the failed stop: %s/%q", a.Lifecycle, detailOf(a))
	}
	failed := s.interruptsOf("ses_rs1")
	s.set(func(s *stopLive) { s.stubborn = false })
	s.restopPass("ses_rs1")
	s.until("the session to stop", func() bool { return !s.activeIn("ses_rs1") })
	s.stopsEnded("ses_rs1")
	if n := s.interruptsOf("ses_rs1"); n != failed+1 {
		t.Errorf("%d interrupts; want %d", n, failed+1)
	}
	if a := s.agent("rs1"); a.Lifecycle != "shut_down" || detailOf(a) != "shut down" {
		t.Errorf("row %s/%q", a.Lifecycle, detailOf(a))
	}
	if n := s.countEvents("rs1", "stop-error"); n != 1 {
		t.Errorf("%d stop-errors; want the first stop's", n)
	}
	// Stopped, the session gets nothing more.
	s.passed()
	if n := s.interruptsOf("ses_rs1"); n != failed+1 {
		t.Errorf("%d interrupts after a pass over a stopped session", n)
	}
	s.sharedServerKept()
}

// A daemon restart in the middle of a quit's stop drops the stop: the new daemon's first pass stops the session.
func TestRestopAfterARestartMidStop(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("rs2", "active", true)
	ctx, cancel := context.WithCancel(s.ctx)
	old := New(ctx, s.opts)
	release := s.hold()
	defer release()
	if err := old.Shutdown(s.ctx, a); err != nil {
		t.Fatal(err)
	}
	s.until("the first interrupt", func() bool { return s.interruptsOf("ses_rs2") == 1 })
	s.set(func(s *stopLive) { s.active["ses_rs2"] = true })
	cancel()
	old.Wait()
	release()
	life := New(s.ctx, s.opts)
	s.life = life
	s.restopPass("ses_rs2")
	s.until("the session to stop", func() bool { return !s.activeIn("ses_rs2") })
	s.stopsEnded("ses_rs2")
	if n := s.interruptsOf("ses_rs2"); n != 2 {
		t.Errorf("%d interrupts; want 2", n)
	}
	if a := s.agent("rs2"); a.Lifecycle != "shut_down" || detailOf(a) != "shut down" {
		t.Errorf("row %s/%q", a.Lifecycle, detailOf(a))
	}
	s.sharedServerKept()
}

// A harness that exits under a running turn is shut down, and its turn stopped in the same pass.
func TestRestopOnHarnessExit(t *testing.T) {
	s := newStopLive(t)
	s.passed()
	s.ocRow("rs3", "active", true)
	if err := s.tmux.KillSession(s.ctx, "rs3"); err != nil {
		t.Fatal(err)
	}
	s.restopPass("ses_rs3")
	if a := s.agent("rs3"); a.Lifecycle != "shut_down" || detailOf(a) != "harness exited" {
		t.Fatalf("row %s/%q", a.Lifecycle, detailOf(a))
	}
	s.until("the session to stop", func() bool { return !s.activeIn("ses_rs3") })
	s.stopsEnded("ses_rs3")
	if n := s.interruptsOf("ses_rs3"); n != 1 {
		t.Errorf("%d interrupts; want 1", n)
	}
}

// Only a shut-down agent with no pane is stopped. A paused one is not, even with no pane: stam still pushes mail to
// it, in a turn the server runs. One whose TUI runs, an idle session, and a Claude agent get nothing either.
func TestRestopPicksOnlyOrphans(t *testing.T) {
	s := newStopLive(t)
	s.passed()
	s.ocRow("rs4", "shut_down", false)
	s.ocRow("rs5", "paused", true)
	s.ocRow("rs6", "shut_down", false)
	s.set(func(s *stopLive) { delete(s.active, "ses_rs6") })
	s.ocRow("rs7", "shut_down", true)
	claude := "ses_rs8"
	if _, err := s.db.CreateAgent(s.ctx, db.NewAgent{ID: "rs8", Name: "n-rs8", Role: "developer", Machine: "test-machine", Harness: "claude",
		Cwd: s.work, SessionID: &claude}); err != nil {
		t.Fatal(err)
	}
	s.live.set("rs8", db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "workspace", Val: `{"spec":{"kind":"dir","path":"` + s.work + `"},"cwd":"` + s.work + `"}`})
	s.set(func(s *stopLive) { s.active[claude] = true })
	s.ocRow("rs15", "paused", false)
	s.restopPass("ses_rs4")
	s.until("the orphan to stop", func() bool { return !s.activeIn("ses_rs4") })
	for _, id := range []string{"rs4", "rs5", "rs6", "rs7", "rs8", "rs15"} {
		s.stopsEnded("ses_" + id)
	}
	want := map[string]int{"rs4": 1, "rs5": 0, "rs6": 0, "rs7": 0, "rs8": 0, "rs15": 0}
	for id, n := range want {
		if got := s.interruptsOf("ses_" + id); got != n {
			t.Errorf("%s: %d interrupts; want %d", id, got, n)
		}
	}
}

// A session that never stops is tried again ever more rarely, not on every pass: each re-stop doubles the wait before
// the next, and one the server no longer runs is forgotten, so a later orphan of it is stopped at once.
func TestRestopBacksOff(t *testing.T) {
	s := newStopLive(t)
	s.passed()
	s.ocRow("rs16", "shut_down", false)
	s.set(func(s *stopLive) { s.stubborn = true })
	o := s.life.ownerOf("rs16")
	tries := func() restopTry {
		o.mu.Lock()
		defer o.mu.Unlock()
		return o.restops["ses_rs16"]
	}
	due := func() {
		o.mu.Lock()
		defer o.mu.Unlock()
		o.restops["ses_rs16"] = restopTry{n: o.restops["ses_rs16"].n, next: time.Now().Add(-time.Second)}
	}
	s.restopPass("ses_rs16")
	s.stopsEnded("ses_rs16")
	if n := s.countEvents("rs16", "stop-error"); n != 1 {
		t.Fatalf("%d stop-errors after the first re-stop", n)
	}
	first := s.interruptsOf("ses_rs16")
	for range 3 {
		s.passed()
	}
	if e := s.life.turnStopOf("ses_rs16"); e != nil || s.interruptsOf("ses_rs16") != first {
		t.Fatalf("a pass inside the wait stopped again: %d interrupts, was %d", s.interruptsOf("ses_rs16"), first)
	}
	if n := s.countEvents("rs16", "stop-error"); n != 1 {
		t.Errorf("%d stop-errors inside the wait", n)
	}
	if tr := tries(); tr.n != 1 || time.Until(tr.next) < restopFirstWait-time.Minute/2 {
		t.Errorf("after one re-stop: %+v", tr)
	}
	due()
	s.restopPass("ses_rs16")
	s.stopsEnded("ses_rs16")
	if n := s.countEvents("rs16", "stop-error"); n != 1 {
		t.Errorf("%d stop-errors after a second failed re-stop; want the first alone", n)
	}
	if tr := tries(); tr.n != 2 || time.Until(tr.next) < 2*restopFirstWait-time.Minute/2 {
		t.Errorf("the second wait didn't double: %+v", tr)
	}
	s.set(func(s *stopLive) { s.stubborn = false })
	due()
	s.restopPass("ses_rs16")
	s.stopsEnded("ses_rs16")
	s.passed()
	if tr := tries(); tr.n != 0 {
		t.Errorf("a stopped session's re-stops are kept: %+v", tr)
	}
	// Confirmed, a later failure of the session is reported again.
	s.set(func(s *stopLive) { s.stubborn = true; s.active["ses_rs16"] = true })
	s.restopPass("ses_rs16")
	s.stopsEnded("ses_rs16")
	if n := s.countEvents("rs16", "stop-error"); n != 2 {
		t.Errorf("%d stop-errors after a failure that follows a confirmation; want 2", n)
	}
}

// A turn stam starts on a paused agent with no pane (a mail push, through the server) runs on: a pass leaves it.
func TestRestopLeavesAPausedAgentsPushTurn(t *testing.T) {
	s := newStopLive(t)
	s.passed()
	s.ocRow("rs18", "paused", false)
	s.set(func(s *stopLive) { delete(s.active, "ses_rs18") })
	s.idle("rs18")
	s.mail("rs18", "mrs18", "first", false)
	s.life.pushIfIdle(s.ctx, "rs18")
	if got := s.unpushed("rs18"); len(got) != 0 {
		t.Fatalf("the push didn't go: unpushed %v", got)
	}
	s.mu.Lock()
	prompts := len(s.prompts)
	s.mu.Unlock()
	if prompts != 1 {
		t.Fatalf("%d prompts reached the server", prompts)
	}
	// The pushed turn runs in the server.
	s.set(func(s *stopLive) { s.active["ses_rs18"] = true })
	s.passed()
	s.passed()
	s.stopsEnded("ses_rs18")
	if n := s.interruptsOf("ses_rs18"); n != 0 {
		t.Errorf("%d interrupts reached the pushed turn", n)
	}
	if !s.activeIn("ses_rs18") {
		t.Error("the pushed turn stopped")
	}
}

// A listing that can't be read is no answer: the agent keeps its state and nothing is stopped, whatever the error.
func TestRestopUnreadableListing(t *testing.T) {
	for _, tc := range []struct {
		name string
		set  func(s *stopLive)
		hang bool
	}{
		{name: "status", set: func(s *stopLive) { s.broken = true }},
		{name: "empty", set: func(s *stopLive) { s.odd = "EMPTY" }},
		{name: "null", set: func(s *stopLive) { s.odd = "null" }},
		{name: "list", set: func(s *stopLive) { s.odd = `{"data":["ses_rs9"]}` }},
		{name: "not-json", set: func(s *stopLive) { s.odd = `<html>` }},
		{name: "timeout", hang: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newStopLive(t)
			s.passed()
			s.ocRow("rs9", "shut_down", false)
			s.live.set("rs9", db.Field{Col: "activity_detail", Val: "stop failed: x"})
			before := s.agent("rs9")
			if tc.set != nil {
				s.set(tc.set)
			}
			if tc.hang {
				// The server's own call timeout ends the question, made short here.
				defer s.holdNext("active")()
				s.opts.OpenCode.CallTimeout = 200 * time.Millisecond
			}
			s.passed()
			if e := s.life.turnStopOf("ses_rs9"); e != nil {
				t.Fatal("a stop was listed on an unreadable listing")
			}
			if n := s.interruptsOf("ses_rs9"); n != 0 {
				t.Errorf("%d interrupts", n)
			}
			if a := s.agent("rs9"); a.Lifecycle != before.Lifecycle || detailOf(a) != detailOf(before) || a.UpdatedAt != before.UpdatedAt {
				t.Errorf("row %s/%q; was %s/%q", a.Lifecycle, detailOf(a), before.Lifecycle, detailOf(before))
			}
			if n := s.countEvents("rs9", "stop-error"); n != 0 {
				t.Errorf("%d stop-errors", n)
			}
		})
	}
}

// A pass while a launch is in flight (begun, not yet landed) leaves its session alone, and so does the next, once the
// launch has landed.
func TestRestopSkipsALaunchInFlight(t *testing.T) {
	s := newStopLive(t)
	s.passed()
	s.ocRow("rs10", "shut_down", false)
	held, free := make(chan struct{}), make(chan struct{})
	s.life.launchReleasing = func(id string) {
		s.life.launchReleasing = nil
		close(held)
		<-free
	}
	launched := make(chan error, 1)
	go func() { launched <- s.life.StartHarness(s.ctx, s.agent("rs10"), "", true, "resume") }()
	<-held
	s.passed()
	if e := s.life.turnStopOf("ses_rs10"); e != nil {
		t.Error("a stop was listed under a launch in flight")
	}
	close(free)
	if err := <-launched; err != nil {
		t.Fatal(err)
	}
	s.until("the resume to land", func() bool { a := s.agent("rs10"); return a.Lifecycle == "active" && s.tmux.HasSession(s.ctx, "rs10") })
	s.passed()
	s.stopsEnded("ses_rs10")
	if n := s.interruptsOf("ses_rs10"); n != 0 {
		t.Errorf("%d interrupts reached the launch's turn", n)
	}
}

// A launch that begins between the pass's row read and its stop's listing wins: the stop is refused, and the launch's
// turn gets no interrupt. In flight: the launch is held at its release, after its generation. Landed: its row is active
// and its outcome known (launchEnd == launched) before the stop is asked for.
func TestRestopRefusedForALaunchAfterItsRead(t *testing.T) {
	for _, landed := range []bool{false, true} {
		name := "in-flight"
		if landed {
			name = "landed"
		}
		t.Run(name, func(t *testing.T) {
			s := newStopLive(t)
			s.passed()
			s.ocRow("rs11", "shut_down", false)
			launched := make(chan error, 1)
			releasing, free := make(chan struct{}), make(chan struct{})
			if !landed {
				s.life.launchReleasing = func(id string) {
					s.life.launchReleasing = nil
					close(releasing)
					<-free
				}
			}
			o := s.life.ownerOf("rs11")
			s.life.restopRead = func(id string) {
				s.life.restopRead = nil
				go func() { launched <- s.life.StartHarness(s.ctx, s.agent(id), "", true, "resume") }()
				if !landed {
					<-releasing
					return
				}
				if err := <-launched; err != nil {
					t.Error(err)
				}
				launched <- nil
				o.mu.Lock()
				settled := o.launchEnd == o.launched && o.launched > 0
				o.mu.Unlock()
				if a := s.agent(id); a.Lifecycle != "active" || !settled {
					t.Errorf("the launch didn't land: %s, settled %v", a.Lifecycle, settled)
				}
			}
			// Any stop listed for the session publishes: the flag says one was, even when it gave up at once.
			published := make(chan struct{}, 8)
			s.life.stopPublishing = func(string) { published <- struct{}{} }
			s.passed()
			s.stopsEnded("ses_rs11")
			if len(published) != 0 {
				t.Error("a stop was listed after a launch began")
			}
			close(free)
			if err := <-launched; err != nil {
				t.Fatal(err)
			}
			s.until("the resume to land", func() bool { return s.agent("rs11").Lifecycle == "active" })
			s.stopsEnded("ses_rs11")
			if n := s.interruptsOf("ses_rs11"); n != 0 {
				t.Errorf("%d interrupts reached the launch's turn", n)
			}
			if n := s.countEvents("rs11", "stop-error"); n != 0 {
				t.Errorf("%d stop-errors", n)
			}
		})
	}
}

// A launch that begins after the stop is listed, before its first interrupt (its question to the server held), makes
// it give up: keep, asked before the interrupt, finds the launch's generation, and the launch's turn gets no interrupt.
func TestRestopGivesUpForALaunchAfterItsListing(t *testing.T) {
	s := newStopLive(t)
	s.passed()
	s.ocRow("rs17", "shut_down", false)
	var ask func()
	s.life.restopRead = func(id string) {
		s.life.restopRead = nil
		// The pass's listing is done: the next question is the stop's own.
		ask = s.holdNext("active")
	}
	s.passed()
	defer ask()
	s.until("the stop's question to be held", func() bool { return s.inFlight("active") == 1 })
	stop := s.life.turnStopOf("ses_rs17")
	if stop == nil {
		t.Fatal("no stop listed")
	}
	gen := s.life.genOf("rs17")
	launched := make(chan error, 1)
	go func() { launched <- s.life.StartHarness(s.ctx, s.agent("rs17"), "", true, "resume") }()
	s.until("the launch's generation", func() bool { return s.life.launchedSince("rs17", gen) })
	ask()
	if err := <-launched; err != nil {
		t.Fatal(err)
	}
	if err := stop.await(s.ctx); err != errStopGivenUp {
		t.Errorf("the stop: %v; want it given up", err)
	}
	if n := s.interruptsOf("ses_rs17"); n != 0 {
		t.Errorf("%d interrupts reached the launch's turn", n)
	}
}

// A launch that begins while the re-stop's interrupt is in flight queues: its release blocks on the session's slot
// until the stop publishes, and only then does the launch go on; the stop sends nothing more.
func TestLaunchQueuesBehindARestop(t *testing.T) {
	s := newStopLive(t)
	s.passed()
	s.ocRow("rs12", "shut_down", false)
	post := s.holdNext("interrupt")
	defer post()
	s.passed()
	s.until("the re-stop's interrupt to be held", func() bool { return s.inFlight("interrupt") == 1 })
	stop := s.life.turnStopOf("ses_rs12")
	launched := make(chan error, 1)
	go func() { launched <- s.life.StartHarness(s.ctx, s.agent("rs12"), "", true, "resume") }()
	for !blockedIn(t, "(*owner).drainSlot") {
		select {
		case err := <-launched:
			t.Fatalf("the launch went on with the stop's interrupt in flight: %v", err)
		case <-time.After(10 * time.Millisecond):
		}
	}
	if s.tmux.HasSession(s.ctx, "rs12") {
		t.Error("the launch made its pane with the stop's interrupt in flight")
	}
	post()
	if err := <-launched; err != nil {
		t.Fatal(err)
	}
	if err := stop.await(s.ctx); err != errStopGivenUp {
		t.Errorf("the stop the launch released: %v", err)
	}
	s.until("the resume to land", func() bool { return s.agent("rs12").Lifecycle == "active" })
	if n := s.interruptsOf("ses_rs12"); n != 1 {
		t.Errorf("%d interrupts; want only the one in flight", n)
	}
}

// blockedIn is whether a goroutine the test t started waits, blocked, in fn.
func blockedIn(t *testing.T, fn string) bool {
	buf := make([]byte, 1<<20)
	buf = buf[:runtime.Stack(buf, true)]
	mine := "created by stam/internal/lifecycle." + t.Name() + " "
	for _, g := range strings.Split(string(buf), "\n\n") {
		if strings.Contains(g, fn) && strings.Contains(g, mine) && (strings.Contains(g, "[select") || strings.Contains(g, "[chan send")) {
			return true
		}
	}
	return false
}

// The pass's row may be stale: the row read again decides, so one that runs again, or moved to another session, gets
// no stop of the session the pass saw.
func TestRestopRereadsTheRow(t *testing.T) {
	s := newStopLive(t)
	stale := s.ocRow("rs13", "shut_down", false)
	s.live.set("rs13", db.Field{Col: "lifecycle", Val: "active"})
	s.life.restopOrphan(s.ctx, stale, &activeListing{})
	stale = s.ocRow("rs14", "shut_down", false)
	s.live.set("rs14", db.Field{Col: "session_id", Val: "ses_other"})
	s.life.restopOrphan(s.ctx, stale, &activeListing{})
	// Still shut down on the same session, but written since the pass read it (a resume that landed and then a
	// pause and a quit, say): the next pass decides.
	stale = s.ocRow("rs19", "shut_down", false)
	time.Sleep(2 * time.Millisecond)
	s.live.set("rs19", db.Field{Col: "activity_detail", Val: "written since"})
	s.life.restopOrphan(s.ctx, stale, &activeListing{})
	// The row unchanged, but a TUI runs now.
	stale = s.ocRow("rs20", "shut_down", true)
	s.life.restopOrphan(s.ctx, stale, &activeListing{})
	for _, sid := range []string{"ses_rs13", "ses_rs14", "ses_rs19", "ses_rs20"} {
		if e := s.life.turnStopOf(sid); e != nil {
			t.Errorf("%s: a stop was listed for a stale row", sid)
		}
		s.stopsEnded(sid)
		if n := s.interruptsOf(sid); n != 0 {
			t.Errorf("%s: %d interrupts", sid, n)
		}
	}
}

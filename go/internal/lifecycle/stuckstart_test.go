package lifecycle

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/db"
)

// The stuck-start cases of test/stuck-start.test.mjs (S-3250), on a live tmux server and the fake Claude Code.

// resumed starts a promptless resume and waits for its afterLaunch: the state a compaction's relaunch leaves.
func (l *live) resumed(id string) db.Agent {
	l.t.Helper()
	launched, err := l.life.startHarness(l.ctx, l.agent(id), "", true, "resume")
	if err != nil {
		l.t.Fatal(err)
	}
	if launched != nil {
		if err := <-launched; err != nil {
			l.t.Fatal(err)
		}
	}
	a := l.agent(id)
	if a.Activity != "starting" || detailOf(a) != "resuming" {
		l.t.Fatalf("%s after the resume: %s %q", id, a.Activity, detailOf(a))
	}
	return a
}

// promptTaken waits until the restart's launch has typed its prompt, the fake took it (BASE/typed) and the launch waits
// for the hook that never comes. Without a launch (nil) there is nothing to wait for.
func (l *live) promptTaken(id string, launched <-chan error) {
	l.t.Helper()
	if launched == nil {
		return
	}
	l.until("the restart's prompt to be taken", func() bool {
		b, _ := os.ReadFile(filepath.Join(l.base, "typed"))
		return len(b) > 0 && len(l.events(id, "first-prompt:awaiting-hook")) > 0
	})
}

// startEvents counts the agent's events of one type.
func (l *live) startEvents(id, typ string) int {
	l.t.Helper()
	return len(l.events(id, typ))
}

// stuckResumes counts the agent's resumes that the stuck-start restart made.
func (l *live) stuckResumes(id string) int {
	n := 0
	for _, d := range l.events(id, "resume") {
		if strings.Contains(d, `"stuck":true`) {
			n++
		}
	}
	return n
}

func (l *live) setActivity(id, activity, detail string) {
	l.t.Helper()
	fields := []db.Field{{Col: "activity", Val: activity}, {Col: "activity_detail", Val: detail}}
	if detail == "" {
		fields[1].Val = nil
	}
	if err := l.db.UpdateAgent(l.ctx, id, fields...); err != nil {
		l.t.Fatal(err)
	}
}

// TestSettleStartLostSessionStart: a promptless resume whose SessionStart was lost settles idle at its prompt, with its
// pending compaction still pending, as SessionStart would leave it.
func TestSettleStartLostSessionStart(t *testing.T) {
	l := newLive(t)
	l.spawn("stsa1")
	a := l.resumed("stsa1")
	if !l.life.settleStart(l.ctx, a, true) {
		t.Fatal("a resume at its prompt did not settle")
	}
	a = l.agent("stsa1")
	if a.Activity != "idle" || detailOf(a) != "ready" {
		t.Fatalf("after the settle: %s %q", a.Activity, detailOf(a))
	}
	if n := l.startEvents("stsa1", "starting:settled"); n != 1 {
		t.Fatalf("starting:settled events: %d", n)
	}

	// A settle does only what SessionStart does: a pending compaction stays pending, and nothing compacts.
	pending := `{"type":"compact","reason":"test"}`
	l.setActivity("stsa1", "starting", "resuming")
	if err := l.db.UpdateAgent(l.ctx, "stsa1", db.Field{Col: "pending_action", Val: pending}); err != nil {
		t.Fatal(err)
	}
	if !l.life.settleStart(l.ctx, l.agent("stsa1"), true) {
		t.Fatal("settle with a pending compaction")
	}
	if got := l.agent("stsa1").PendingAction; got == nil || *got != pending {
		t.Fatalf("pending action after the settle: %v", got)
	}
	if n := l.startEvents("stsa1", "compact"); n != 0 {
		t.Fatalf("compact events after the settle: %d", n)
	}
}

// TestSettleStartNotAtPromptOrDead: a settle needs a live pane and a start with no prompt still to go in.
func TestSettleStartNotAtPromptOrDead(t *testing.T) {
	l := newLive(t)
	l.spawn("stsa2")
	a := l.resumed("stsa2")
	if l.life.settleStart(l.ctx, a, false) {
		t.Fatal("settled with no live pane")
	}
	l.setActivity("stsa2", "starting", "with prompt")
	if l.life.settleStart(l.ctx, l.agent("stsa2"), true) {
		t.Fatal("settled with its prompt still to go in")
	}
	l.setActivity("stsa2", "starting", "resuming")
	if !l.life.settleStart(l.ctx, l.agent("stsa2"), true) {
		t.Fatal("did not settle once its launch was done")
	}
}

// TestSettleStartWaitsForLaunch: a launch still in its afterLaunch here is not settled, and once it landed it is.
// The launch hook runs between the launch's session and its write, so the check sees the launch in flight.
func TestSettleStartWaitsForLaunch(t *testing.T) {
	l := newLive(t)
	l.spawn("stsa3")
	l.setActivity("stsa3", "starting", "resuming")
	entered, release := make(chan struct{}), make(chan struct{})
	l.life.launching = func(id string) {
		if id == "stsa3" {
			close(entered)
			<-release
		}
	}
	var (
		launched <-chan error
		err      error
		done     = make(chan struct{})
	)
	go func() {
		defer close(done)
		launched, err = l.life.startHarness(l.ctx, l.agent("stsa3"), "", true, "resume")
	}()
	<-entered
	// The fake draws its prompt after the launch's session starts, so the settle is refused for the launch alone.
	l.until("the prompt to be drawn", func() bool { return l.life.atPrompt(l.ctx, l.agent("stsa3")) })
	if !l.life.launchingNow("stsa3") {
		t.Fatal("the launch is not in flight while its hook holds it")
	}
	if l.life.settleStart(l.ctx, l.agent("stsa3"), true) {
		t.Fatal("settled while its launch was in flight")
	}
	close(release)
	<-done
	if err != nil || launched == nil {
		t.Fatalf("launch: %v %v", launched, err)
	}
	if err := <-launched; err != nil {
		t.Fatal(err)
	}
	l.life.launching = nil
	if !l.life.settleStart(l.ctx, l.agent("stsa3"), true) {
		t.Fatal("did not settle once its launch landed")
	}
}

// TestSettleStartSupersededLaunch: a launch that is superseded before its write is no longer in flight.
func TestSettleStartSupersededLaunch(t *testing.T) {
	l := newLive(t)
	l.spawn("stsa4")
	l.setActivity("stsa4", "starting", "resuming")
	l.life.launching = func(id string) {
		if id == "stsa4" {
			l.life.invalidate(id)
		}
	}
	launched, err := l.life.startHarness(l.ctx, l.agent("stsa4"), "", true, "resume")
	l.life.launching = nil
	if err != nil || launched != nil {
		t.Fatalf("a superseded launch: %v %v", launched, err)
	}
	l.until("the new pane to draw", func() bool { return l.life.atPrompt(l.ctx, l.agent("stsa4")) })
	if !l.life.settleStart(l.ctx, l.agent("stsa4"), true) {
		t.Fatal("a superseded launch still counts as running")
	}
}

// TestSettleStartLeftAlone: a held, paused, not-active or stopping agent does not settle.
func TestSettleStartLeftAlone(t *testing.T) {
	l := newLive(t)
	for _, id := range []string{"stsb1", "stsb2", "stsb3"} {
		l.spawn(id)
		l.resumed(id)
	}
	l.addBlocker("stsb1", "window", "claude-max", "five_hour at 100%")
	if err := l.db.UpdateAgent(l.ctx, "stsb1", db.Field{Col: "lifecycle", Val: "active"}); err != nil {
		t.Fatal(err)
	}
	if l.life.settleStart(l.ctx, l.agent("stsb1"), true) {
		t.Fatal("settled while cost-held")
	}
	if err := l.db.UpdateAgent(l.ctx, "stsb2", db.Field{Col: "lifecycle", Val: "paused"}, db.Field{Col: "paused_by", Val: jsonText([]string{"human"})}); err != nil {
		t.Fatal(err)
	}
	if l.life.settleStart(l.ctx, l.agent("stsb2"), true) {
		t.Fatal("settled while paused")
	}
	stopping := `{"type":"archive","force":false}`
	if err := l.db.UpdateAgent(l.ctx, "stsb3", db.Field{Col: "pending_action", Val: stopping}); err != nil {
		t.Fatal(err)
	}
	if l.life.settleStart(l.ctx, l.agent("stsb3"), true) {
		t.Fatal("settled with a pending stop")
	}
	for _, id := range []string{"stsb1", "stsb2", "stsb3"} {
		if a := l.agent(id); a.Activity != "starting" {
			t.Errorf("%s after the checks: %s", id, a.Activity)
		}
	}
}

// TestStartStalledRestartsOnce: a start that never reaches a turn is restarted once, then errored. The count is in the
// events, so the errored one is told by its own restart's launch.
func TestStartStalledRestartsOnce(t *testing.T) {
	l := newLive(t)
	l.spawn("stsc1")
	a := l.resumed("stsc1")
	if l.life.startStalled(l.ctx, a, true, time.Now().Add(10*time.Minute)) {
		t.Fatal("stalled under the bound")
	}
	if !l.life.startStalled(l.ctx, a, true, time.Now().Add(20*time.Minute)) {
		t.Fatal("not stalled past the bound")
	}
	launched, err := l.life.restartStalledStart(l.ctx, "stsc1", time.Now().Add(20*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if n := l.startEvents("stsc1", "starting:restart"); n != 1 {
		t.Fatalf("starting:restart events: %d", n)
	}
	if n := len(l.events("stsc1", "resume")); n != 2 {
		t.Fatalf("resume events: %d", n)
	}
	if n := l.stuckResumes("stsc1"); n != 1 {
		t.Fatalf("the restart's own launch is not marked stuck: %d", n)
	}
	if a := l.agent("stsc1"); a.Activity != "starting" || a.Lifecycle != "active" {
		t.Fatalf("after the restart: %s %s", a.Lifecycle, a.Activity)
	}
	// The restart's afterLaunch types its prompt, which the fake takes; no hook follows, so the start is stuck again.
	l.promptTaken("stsc1", launched)
	if _, err := l.life.restartStalledStart(l.ctx, "stsc1", time.Now().Add(40*time.Minute)); err != nil {
		t.Fatal(err)
	}
	a = l.agent("stsc1")
	if a.Activity != "errored" || !strings.Contains(detailOf(a), "never reached a turn") {
		t.Fatalf("the restart's stuck start: %s %q", a.Activity, detailOf(a))
	}
	if n := l.startEvents("stsc1", "starting:restart"); n != 1 {
		t.Fatalf("restarted more than once: %d", n)
	}
	if n := l.startEvents("stsc1", "starting:stuck"); n != 1 {
		t.Fatalf("starting:stuck events: %d", n)
	}
}

// TestStartStalledCountPerStuckStart: the one restart counts per stuck start; a later launch that sticks is restarted.
func TestStartStalledCountPerStuckStart(t *testing.T) {
	l := newLive(t)
	l.spawn("stsc2")
	l.resumed("stsc2")
	if _, err := l.life.restartStalledStart(l.ctx, "stsc2", time.Now().Add(20*time.Minute)); err != nil {
		t.Fatal(err)
	}
	// The restart reached a turn; later the agent is resumed again, and that start sticks.
	l.setActivity("stsc2", "idle", "turn finished")
	l.resumed("stsc2")
	if _, err := l.life.restartStalledStart(l.ctx, "stsc2", time.Now().Add(20*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if n := l.startEvents("stsc2", "starting:restart"); n != 2 {
		t.Fatalf("starting:restart events: %d", n)
	}
	if a := l.agent("stsc2"); a.Activity != "starting" {
		t.Fatalf("after the second restart: %s", a.Activity)
	}
}

// TestStartStalledAfterDaemonRestart: a restart the old daemon recorded but cut off before it launched is not repeated by
// a new one: the count lives in events, not in the daemon's memory.
func TestStartStalledAfterDaemonRestart(t *testing.T) {
	l := newLive(t)
	l.spawn("stsd1")
	l.resumed("stsd1")
	l.life.event(l.ctx, "stsd1", "starting:restart", nil)
	launches := len(l.events("stsd1", "resume"))

	restarted := New(l.ctx, l.opts)
	t.Cleanup(restarted.Wait)
	if _, err := restarted.restartStalledStart(l.ctx, "stsd1", time.Now().Add(20*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if a := l.agent("stsd1"); a.Activity != "errored" {
		t.Fatalf("after the daemon restart: %s", a.Activity)
	}
	if n := len(l.events("stsd1", "resume")); n != launches {
		t.Fatalf("a second launch after the daemon restart: %d resumes, had %d", n, launches)
	}
}

// TestStartStalledTwoAtOnce: two restarts asked at once launch once.
func TestStartStalledTwoAtOnce(t *testing.T) {
	l := newLive(t)
	l.spawn("stsd2")
	l.resumed("stsd2")
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := l.life.restartStalledStart(l.ctx, "stsd2", time.Now().Add(20*time.Minute)); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if n := l.startEvents("stsd2", "starting:restart"); n != 1 {
		t.Fatalf("starting:restart events: %d", n)
	}
	if n := l.stuckResumes("stsd2"); n != 1 {
		t.Fatalf("stuck launches: %d", n)
	}
}

// TestStartStalledSlowStartLeftAlone: a start that reaches a turn is left alone.
func TestStartStalledSlowStartLeftAlone(t *testing.T) {
	l := newLive(t)
	l.spawn("stse1")
	l.resumed("stse1")
	l.setActivity("stse1", "working", "")
	if l.life.startStalled(l.ctx, l.agent("stse1"), true, time.Now().Add(20*time.Minute)) {
		t.Fatal("a working agent is stalled")
	}
	if _, err := l.life.restartStalledStart(l.ctx, "stse1", time.Now().Add(20*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if n := l.startEvents("stse1", "starting:restart"); n != 0 {
		t.Fatalf("starting:restart events: %d", n)
	}
	if a := l.agent("stse1"); a.Activity != "working" {
		t.Fatalf("after the check: %s", a.Activity)
	}
}

// TestStartStalledPausedOrNotActiveLeftAlone: a paused agent, or one not active, is left alone.
func TestStartStalledPausedOrNotActiveLeftAlone(t *testing.T) {
	l := newLive(t)
	l.spawn("stsf1")
	l.resumed("stsf1")
	if err := l.db.UpdateAgent(l.ctx, "stsf1", db.Field{Col: "lifecycle", Val: "paused"}, db.Field{Col: "paused_by", Val: jsonText([]string{"human"})}); err != nil {
		t.Fatal(err)
	}
	if l.life.startStalled(l.ctx, l.agent("stsf1"), true, time.Now().Add(20*time.Minute)) {
		t.Fatal("a paused agent is stalled")
	}
	if _, err := l.life.restartStalledStart(l.ctx, "stsf1", time.Now().Add(20*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if n := l.startEvents("stsf1", "starting:restart"); n != 0 {
		t.Fatalf("starting:restart events: %d", n)
	}
	if err := l.db.UpdateAgent(l.ctx, "stsf1", db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "paused_by", Val: nil}); err != nil {
		t.Fatal(err)
	}
	if l.life.startStalled(l.ctx, l.agent("stsf1"), true, time.Now().Add(20*time.Minute)) {
		t.Fatal("a shut-down agent is stalled")
	}
}

// TestStartStalledHeldLeftAlone: a cost-held agent is left alone, even while active.
func TestStartStalledHeldLeftAlone(t *testing.T) {
	l := newLive(t)
	l.spawn("stsg1")
	l.resumed("stsg1")
	l.addBlocker("stsg1", "window", "claude-max", "five_hour at 100%")
	if err := l.db.UpdateAgent(l.ctx, "stsg1", db.Field{Col: "lifecycle", Val: "active"}); err != nil {
		t.Fatal(err)
	}
	if l.life.startStalled(l.ctx, l.agent("stsg1"), true, time.Now().Add(20*time.Minute)) {
		t.Fatal("a cost-held agent is stalled")
	}
	if _, err := l.life.restartStalledStart(l.ctx, "stsg1", time.Now().Add(20*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if n := l.startEvents("stsg1", "starting:restart"); n != 0 {
		t.Fatalf("a held agent was restarted: %d", n)
	}
}

// TestStartStalledOtherMachineDeadPaneOrOff: an agent of another machine, a dead pane, or the check off, is left alone.
func TestStartStalledOtherMachineDeadPaneOrOff(t *testing.T) {
	l := newLive(t)
	l.spawn("stsh1")
	a := l.resumed("stsh1")
	later := time.Now().Add(20 * time.Minute)
	if l.life.startStalled(l.ctx, a, false, later) {
		t.Fatal("a dead pane is stalled: reconcile's startingStuck handles it")
	}
	peerRow := l.agent("stsh1")
	peerRow.Machine = "peer"
	if l.life.startStalled(l.ctx, peerRow, true, later) {
		t.Fatal("an agent of another machine is stalled")
	}
	l.setSettings(`{"stuckStartMinutes":0}`)
	if got := l.life.settings.Get().StuckStartMinutes; got != 0 {
		t.Fatalf("stuckStartMinutes 0 read as %v", got)
	}
	if l.life.startStalled(l.ctx, l.agent("stsh1"), true, later) {
		t.Fatal("0 does not turn the check off")
	}
}

// TestStuckStartSettingDefault: stuckStartMinutes is read from settings, 15 by default.
func TestStuckStartSettingDefault(t *testing.T) {
	l := newLive(t)
	if got := l.life.settings.Get().StuckStartMinutes; got != 15 {
		t.Fatalf("default stuckStartMinutes: %v", got)
	}
	l.setSettings(`{"stuckStartMinutes":7.5}`)
	if got := l.life.settings.Get().StuckStartMinutes; got != 7.5 {
		t.Fatalf("stuckStartMinutes 7.5 read as %v", got)
	}
	l.setSettings(`{"stuckStartMinutes":-1}`)
	if got := l.life.settings.Get().StuckStartMinutes; got != 15 {
		t.Fatalf("a negative stuckStartMinutes read as %v", got)
	}
}

// TestLateSessionStartKeepsTurn: a startup or resume SessionStart that lands while the agent works or waits on a
// dialog keeps that activity; a launch still starting goes idle, and a /clear still ends a turn.
func TestLateSessionStartKeepsTurn(t *testing.T) {
	l := newLive(t)
	l.spawn("stsi1")
	for _, c := range []struct{ from, source, want string }{
		{"working", "resume", "working"},
		{"blocked", "startup", "blocked"},
		{"starting", "resume", "idle"},
		{"working", "clear", "idle"},
	} {
		l.setActivity("stsi1", c.from, "")
		l.hookPayload("stsi1", `{"hook_event_name":"SessionStart","source":"`+c.source+`","session_id":"sess-late"}`)
		if got := string(l.agent("stsi1").Activity); got != c.want {
			t.Errorf("SessionStart %s from %s: %s, want %s", c.source, c.from, got, c.want)
		}
	}
}

// TestWatchdogAndLateSessionStart: a late SessionStart that lands after the watchdog judged the start stalled, and before
// its restart, leaves the agent idle; the restart rechecks in the agent's serial and does nothing. Only one of the two acts.
func TestWatchdogAndLateSessionStart(t *testing.T) {
	l := newLive(t)
	l.spawn("stsj1")
	a := l.resumed("stsj1")
	later := time.Now().Add(20 * time.Minute)
	if !l.life.startStalled(l.ctx, a, true, later) {
		t.Fatal("not stalled")
	}
	l.hookPayload("stsj1", `{"hook_event_name":"SessionStart","source":"resume","session_id":"sess-late"}`)
	if _, err := l.life.restartStalledStart(l.ctx, "stsj1", later); err != nil {
		t.Fatal(err)
	}
	if n := l.startEvents("stsj1", "starting:restart"); n != 0 {
		t.Fatalf("restarted after its SessionStart: %d", n)
	}
	if a := l.agent("stsj1"); a.Activity != "idle" {
		t.Fatalf("after the late SessionStart: %s", a.Activity)
	}
}

// TestWatchdogAndSettleOneAct: the settle and the watchdog both see a promptless start at its prompt; the settle goes
// first, and the watchdog then finds the agent idle and does nothing.
func TestWatchdogAndSettleOneAct(t *testing.T) {
	l := newLive(t)
	l.spawn("stsk1")
	a := l.resumed("stsk1")
	later := time.Now().Add(20 * time.Minute)
	if !l.life.settleStart(l.ctx, a, true) {
		t.Fatal("did not settle")
	}
	if _, err := l.life.restartStalledStart(l.ctx, "stsk1", later); err != nil {
		t.Fatal(err)
	}
	if n := l.startEvents("stsk1", "starting:restart"); n != 0 {
		t.Fatalf("the watchdog restarted a settled agent: %d", n)
	}
}

// TestStartStalledLaunchInFlight: a launch still in its afterLaunch is not restarted under itself until twice the bound.
func TestStartStalledLaunchInFlight(t *testing.T) {
	l := newLive(t)
	l.spawn("stsl1")
	l.setActivity("stsl1", "starting", "resuming")
	var inFlight, under, past bool
	l.life.launching = func(id string) {
		if id != "stsl1" {
			return
		}
		a := l.agent(id)
		inFlight = l.life.launchingNow(id)
		under = l.life.startStalled(l.ctx, a, true, time.Now().Add(20*time.Minute))
		past = l.life.startStalled(l.ctx, a, true, time.Now().Add(40*time.Minute))
	}
	launched, err := l.life.startHarness(l.ctx, l.agent("stsl1"), "", true, "resume")
	l.life.launching = nil
	if err != nil {
		t.Fatal(err)
	}
	if launched != nil {
		if err := <-launched; err != nil {
			t.Fatal(err)
		}
	}
	if !inFlight {
		t.Fatal("the launch is not in flight in its afterLaunch")
	}
	if under {
		t.Fatal("a launch in flight is restarted under itself, before twice the bound")
	}
	if !past {
		t.Fatal("a launch in flight is not stalled past twice the bound")
	}
}

// TestStuckStartOtherMachineMustFail: an agent of another machine is never restarted here, even when it is stalled.
func TestStuckStartOtherMachineMustFail(t *testing.T) {
	l := newLive(t)
	l.spawn("stsm2")
	l.resumed("stsm2")
	// The daemon of another machine: it finds this machine's agent and must leave it alone.
	opts := l.opts
	opts.Machine = "peer"
	peer := New(l.ctx, opts)
	t.Cleanup(peer.Wait)
	if _, err := peer.restartStalledStart(l.ctx, "stsm2", time.Now().Add(20*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if n := l.startEvents("stsm2", "starting:restart"); n != 0 {
		t.Fatalf("an agent of another machine was restarted: %d", n)
	}
}

// TestStuckStartSecondRestartMustFail: after a daemon restart, a start the restart made that sticks is errored, not
// restarted again: the count is the events', so a new daemon can't grant a second restart.
func TestStuckStartSecondRestartMustFail(t *testing.T) {
	l := newLive(t)
	l.spawn("stsm3")
	l.resumed("stsm3")
	launched, err := l.life.restartStalledStart(l.ctx, "stsm3", time.Now().Add(20*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	l.promptTaken("stsm3", launched)
	launches := len(l.events("stsm3", "resume"))
	restarted := New(l.ctx, l.opts)
	t.Cleanup(restarted.Wait)
	if _, err := restarted.restartStalledStart(l.ctx, "stsm3", time.Now().Add(40*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if a := l.agent("stsm3"); a.Activity != "errored" {
		t.Fatalf("the restart's stuck start after a daemon restart: %s", a.Activity)
	}
	if n := len(l.events("stsm3", "resume")); n != launches {
		t.Fatalf("a second restart after a daemon restart: %d resumes, had %d", n, launches)
	}
}

package lifecycle

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/adapters/opencode"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// OpenCode job waits (S-4237, jobs.go). The tests run on the scripted server of stopLive, which holds a call until the
// test lets it go, and on a manual clock for the grace: nothing waits on time.

// graceClock is the lifecycle's grace timer, fired by the test.
type graceClock struct {
	mu  sync.Mutex
	fns []func()
	ds  []time.Duration
}

func (c *graceClock) after(d time.Duration, f func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.fns, c.ds = append(c.fns, f), append(c.ds, d)
}

func (c *graceClock) pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.fns)
}

// fire runs every grace set so far, once.
func (c *graceClock) fire() {
	c.mu.Lock()
	fns := c.fns
	c.fns = nil
	c.mu.Unlock()
	for _, f := range fns {
		f()
	}
}

// newJobLive is an active OpenCode agent ses_ID, working, whose life has the manual grace clock.
func newJobLive(t *testing.T, id string) (*stopLive, *graceClock) {
	t.Helper()
	s := newStopLive(t)
	s.ocRow(id, "active", true)
	c := &graceClock{}
	s.life.jobAfter = c.after
	return s, c
}

func shellMade(id, session, command string) string {
	return `{"type":"shell.created","data":{"info":{"id":"` + id + `","command":"` + command + `","metadata":{"sessionID":"` + session + `"}}}}`
}

func shellExited(id string) string { return `{"type":"shell.exited","data":{"id":"` + id + `"}}` }

func childMade(id, parent, title string) string {
	return `{"type":"session.created","data":{"sessionID":"` + id + `","parentID":"` + parent + `","title":"` + title + `"}}`
}

func execution(kind, sid string) string {
	return `{"type":"session.execution.` + kind + `","data":{"sessionID":"` + sid + `"}}`
}

// shellListed is a running shell of the server's listing.
func shellListed(id, session, command string) string {
	return `{"id":"` + id + `","status":"running","command":"` + command + `","metadata":{"sessionID":"` + session + `"}}`
}

// jobWaits are the agent's waits as "kind|target|detail|data|source".
func (s *stopLive) jobWaits(id string) []string {
	s.t.Helper()
	var out []string
	for _, w := range s.waits(id) {
		out = append(out, w.Kind+"|"+deref(w.Target)+"|"+deref(w.Detail)+"|"+deref(w.Data)+"|"+w.Source)
	}
	return out
}

func (s *stopLive) wantWaits(id string, want ...string) {
	s.t.Helper()
	if got := strings.Join(s.jobWaits(id), "\n"); got != strings.Join(want, "\n") {
		s.t.Errorf("waits of %s:\n%s\nwant:\n%s", id, got, strings.Join(want, "\n"))
	}
}

func (s *stopLive) wantActivity(id, activity string) {
	s.t.Helper()
	if a := s.agent(id); string(a.Activity) != activity {
		s.t.Errorf("%s is %s/%q; want %s", id, a.Activity, detailOf(a), activity)
	}
}

// seeded waits until no seed runs.
func (s *stopLive) seeded() {
	s.t.Helper()
	s.until("the seed's end", func() bool {
		s.life.jobs.mu.Lock()
		defer s.life.jobs.mu.Unlock()
		return s.life.jobs.touched == nil
	})
}

// seedHeld starts a seed whose first read the server holds, until release.
func (s *stopLive) seedHeld() (release func()) {
	s.t.Helper()
	release = s.holdNext("active")
	s.life.seedJobs()
	s.until("the seed's first read", func() bool { return s.inFlight("active") == 1 })
	return release
}

const (
	shellWait = "job|sh1|background command \"sleep 100\"|{\"type\":\"shell\"}|hook"
	childWait = "job|ses_c1|sub-agent \"Explore\"|{\"type\":\"subagent\"}|hook"
)

// An execution that ends with a shell and a sub-agent running ends waiting: the waits are written before the idle, so
// the agent never passes through idle. The shell's end keeps its wait until the completion notice's execution starts,
// which clears it with the agent working, not idle; the grace after that does nothing.
func TestJobWaitsExecutionEnd(t *testing.T) {
	s, clock := newJobLive(t, "ajw1")
	sid := "ses_ajw1"
	var seen []string
	var mu sync.Mutex
	s.db.ObserveActivity(func(_ context.Context, c db.ActivityChange) {
		mu.Lock()
		defer mu.Unlock()
		if c.ID == "ajw1" && c.Kind == "activity" {
			seen = append(seen, c.After)
		}
	})
	defer s.db.ObserveActivity(nil)

	s.event(shellMade("sh1", sid, "sleep 100"))
	// Another session's shell, and a child that never ran, are not this agent's waits.
	s.event(shellMade("shx", "ses_other", "other"))
	s.event(childMade("ses_c0", sid, "Idle"))
	s.event(childMade("ses_c1", sid, "Explore"))
	s.event(execution("started", "ses_c1"))
	s.event(execution("succeeded", sid))
	s.wantWaits("ajw1", shellWait, childWait)
	s.wantActivity("ajw1", "waiting")
	mu.Lock()
	for _, a := range seen {
		if a == "idle" {
			t.Errorf("the agent passed through idle: %v", seen)
		}
	}
	mu.Unlock()

	// The shell exits: its wait stays for the completion notice.
	s.event(shellExited("sh1"))
	s.wantWaits("ajw1", shellWait, childWait)
	if clock.pending() != 1 {
		t.Errorf("%d graces set; want 1", clock.pending())
	}
	// The child ends too.
	s.event(execution("failed", "ses_c1"))
	if clock.pending() != 2 {
		t.Errorf("%d graces set; want 2", clock.pending())
	}
	// The notice's execution starts: the waits clear with the agent working.
	s.event(execution("started", sid))
	s.wantWaits("ajw1")
	s.wantActivity("ajw1", "working")
	clock.fire()
	s.wantWaits("ajw1")
	s.wantActivity("ajw1", "working")

	// An execution that leaves nothing running ends idle, as before.
	s.event(execution("succeeded", sid))
	s.wantActivity("ajw1", "idle")
	if d := detailOf(s.agent("ajw1")); d != "turn finished" {
		t.Errorf("detail %q", d)
	}
	if clock.ds != nil && clock.ds[0] != jobGrace {
		t.Errorf("grace %v; want %v", clock.ds[0], jobGrace)
	}
}

// A job that ends and no execution follows: after the grace its wait clears, with the agent waiting, only that target's.
func TestJobWaitsGrace(t *testing.T) {
	s, clock := newJobLive(t, "ajw2")
	sid := "ses_ajw2"
	s.event(shellMade("sh1", sid, "sleep 100"))
	s.event(shellMade("sh2", sid, "tail -f log"))
	s.event(execution("succeeded", sid))
	s.event(shellExited("sh1"))
	clock.fire()
	s.wantWaits("ajw2", "job|sh2|background command \"tail -f log\"|{\"type\":\"shell\"}|hook")
	s.wantActivity("ajw2", "waiting")
	s.event(shellExited("sh2"))
	clock.fire()
	s.wantWaits("ajw2")
	s.wantActivity("ajw2", "idle")
}

// A grace out after the agent left waiting, after a new launch, after the session changed, or after an archive clears
// nothing; neither does one for a job that runs again.
func TestJobWaitsGraceStale(t *testing.T) {
	cases := []struct {
		name string
		act  func(s *stopLive, id string)
	}{
		{"left waiting", func(s *stopLive, id string) { s.live.set(id, db.Field{Col: "activity", Val: "working"}) }},
		{"a new launch", func(s *stopLive, id string) { s.life.nextLaunchGen(id) }},
		{"a stop", func(s *stopLive, id string) { s.life.invalidate(id) }},
		{"another session", func(s *stopLive, id string) { s.live.set(id, db.Field{Col: "session_id", Val: "ses_other"}) }},
		{"an archive", func(s *stopLive, id string) { s.live.set(id, db.Field{Col: "lifecycle", Val: "archived"}) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, clock := newJobLive(t, "ajw3")
			sid := "ses_ajw3"
			s.event(shellMade("sh1", sid, "sleep 100"))
			s.event(execution("succeeded", sid))
			s.event(shellExited("sh1"))
			s.wantActivity("ajw3", "waiting")
			c.act(s, "ajw3")
			clock.fire()
			s.wantWaits("ajw3", shellWait)
		})
	}
	t.Run("running again", func(t *testing.T) {
		s, clock := newJobLive(t, "ajw3")
		sid := "ses_ajw3"
		s.event(childMade("ses_c1", sid, "Explore"))
		s.event(execution("started", "ses_c1"))
		s.event(execution("succeeded", sid))
		s.event(execution("succeeded", "ses_c1"))
		s.event(execution("started", "ses_c1"))
		clock.fire()
		s.wantWaits("ajw3", childWait)
	})
}

// A grace set for one launch never clears a newer launch's wait for the same target.
func TestJobWaitsGraceOlderLaunch(t *testing.T) {
	s, clock := newJobLive(t, "ajw4")
	sid := "ses_ajw4"
	s.event(shellMade("sh1", sid, "sleep 100"))
	s.event(execution("succeeded", sid))
	s.event(shellExited("sh1"))
	// The agent is launched again in the same session; the shell is tracked once more, and its wait written.
	s.life.ownerOf("ajw4").settleLaunch(s.life.nextLaunchGen("ajw4"), true)
	s.event(shellMade("sh1", sid, "sleep 100"))
	s.event(execution("started", sid))
	s.event(execution("succeeded", sid))
	s.wantWaits("ajw4", shellWait)
	clock.fire()
	s.wantWaits("ajw4", shellWait)
	s.wantActivity("ajw4", "waiting")
}

// A stop or a launch that comes between the end's waits and its idle takes the row: no idle is written over it, and the
// waits stand.
func TestJobWaitsStopBetweenWaitsAndIdle(t *testing.T) {
	for _, kind := range []string{"launch", "stop"} {
		t.Run(kind, func(t *testing.T) {
			s, _ := newJobLive(t, "ajw5")
			sid := "ses_ajw5"
			s.event(shellMade("sh1", sid, "sleep 100"))
			s.life.jobStep = func(id, step string) {
				if step != "ended" {
					return
				}
				s.life.jobStep = nil
				if kind == "launch" {
					s.life.nextLaunchGen(id)
				} else {
					s.life.invalidate(id)
				}
			}
			s.event(execution("succeeded", sid))
			s.wantWaits("ajw5", shellWait)
			s.wantActivity("ajw5", "working")
			if n := s.countEvents("ajw5", "opencode:session.execution.succeeded"); n != 0 {
				t.Errorf("%d idle events", n)
			}
		})
	}
}

// A job wait is written only for the session and generation it was bound to.
func TestJobWaitsWriteIsCurrent(t *testing.T) {
	s, _ := newJobLive(t, "ajw6")
	sid := "ses_ajw6"
	s.event(shellMade("sh1", sid, "sleep 100"))
	o := s.life.ownerOf("ajw6")
	sid2, gen := o.bind(s.life.runningTurn(s.ctx, "ajw6"))
	if sid2 != sid {
		t.Fatalf("bound %q", sid2)
	}
	s.life.invalidate("ajw6")
	if s.life.syncJobWaits(s.ctx, "ajw6", sid, gen) {
		t.Error("a wait was written under an old generation")
	}
	s.wantWaits("ajw6")
	if s.life.syncJobWaits(s.ctx, "ajw6", "ses_other", s.life.genOf("ajw6")) {
		t.Error("a wait was written for another session")
	}
	s.wantWaits("ajw6")
	if !s.life.syncJobWaits(s.ctx, "ajw6", sid, s.life.genOf("ajw6")) {
		t.Error("the current wait was refused")
	}
	s.wantWaits("ajw6", shellWait)
}

// A seed restores a shell and a child that run, and resyncs the waits of an idle agent: a daemon restart with a shell
// running ends the agent waiting. A working agent gets them at its execution's end.
func TestJobSeedRestoresWaits(t *testing.T) {
	s, _ := newJobLive(t, "ajw7")
	sid := "ses_ajw7"
	s.set(func(s *stopLive) {
		s.shells = shellListed("sh1", sid, "sleep 100") + `,{"id":"shx","status":"exited","command":"x","metadata":{"sessionID":"` + sid + `"}}`
		s.kids = map[string]string{sid: `{"id":"ses_c1","title":"Explore"},{"id":"ses_c2","title":"Done"}`}
		s.active["ses_c1"] = true
	})
	s.live.set("ajw7", db.Field{Col: "activity", Val: "idle"})
	// A fresh lifecycle, as after a daemon restart: it tracks nothing until its seed has read the server.
	life := New(s.ctx, s.opts)
	s.life = life
	life.seedJobs()
	s.seeded()
	s.wantWaits("ajw7", shellWait, childWait)
	s.wantActivity("ajw7", "waiting")

	// A working agent keeps its state; the waits come at the end.
	s.live.set("ajw7", db.Field{Col: "activity", Val: "working"})
	if err := s.db.ClearHookWaits(s.ctx, "ajw7"); err != nil {
		t.Fatal(err)
	}
	s.live.set("ajw7", db.Field{Col: "activity", Val: "working"})
	life.seedJobs()
	s.seeded()
	s.wantWaits("ajw7")
	s.wantActivity("ajw7", "working")
	s.event(execution("succeeded", sid))
	s.wantWaits("ajw7", shellWait, childWait)
	s.wantActivity("ajw7", "waiting")
}

// An event that arrives while a seed's reads are held keeps what it said: a shell that exited is not revived by the
// listing, one created is not dropped by it, a child that ended is not revived. Events after the seed's apply count as
// ever.
func TestJobSeedEventsDuringReads(t *testing.T) {
	s, clock := newJobLive(t, "ajw8")
	sid := "ses_ajw8"
	s.live.set("ajw8", db.Field{Col: "activity", Val: "idle"})
	s.set(func(s *stopLive) {
		s.shells = shellListed("sh1", sid, "sleep 100") + "," + shellListed("sh2", sid, "tail -f log")
		s.kids = map[string]string{sid: `{"id":"ses_c1","title":"Explore"}`}
		s.active["ses_c1"] = true
	})
	release := s.seedHeld()
	s.event(shellExited("sh1"))               // listed running, but ended since
	s.event(shellMade("sh3", sid, "new job")) // created since, not listed
	s.event(execution("succeeded", "ses_c1")) // listed running, but ended since
	s.event(childMade("ses_c3", sid, "Late")) // created since, not listed
	s.event(execution("started", "ses_c3"))
	release()
	s.seeded()
	// In the order they were tracked: the event's shell before the seed's.
	s.wantWaits("ajw8",
		"job|sh3|background command \"new job\"|{\"type\":\"shell\"}|hook",
		"job|sh2|background command \"tail -f log\"|{\"type\":\"shell\"}|hook",
		"job|ses_c3|sub-agent \"Late\"|{\"type\":\"subagent\"}|hook")
	s.wantActivity("ajw8", "waiting")
	// After the apply an event is plain tracking again.
	s.event(shellExited("sh2"))
	if clock.pending() == 0 {
		t.Error("no grace for a shell that exited after the seed")
	}
}

// An event after a seed's reads, before its apply, is the same case as during them: the touched set is read when the
// result is applied, so an event of the held children listing is kept too.
func TestJobSeedEventsAfterShellRead(t *testing.T) {
	s, _ := newJobLive(t, "ajw9")
	sid := "ses_ajw9"
	s.live.set("ajw9", db.Field{Col: "activity", Val: "idle"})
	s.set(func(s *stopLive) { s.shells = shellListed("sh1", sid, "sleep 100") })
	release := s.holdNext("children")
	s.life.seedJobs()
	s.until("the children read", func() bool { return s.inFlight("children") == 1 })
	s.event(shellExited("sh1"))
	release()
	s.seeded()
	s.wantWaits("ajw9")
	s.wantActivity("ajw9", "idle")
}

// A child session an event touched while the seed read, which nothing tracked (its session.created came before the stream
// connected), is adopted from the listing with the state the event gave: one that started is kept running, one that
// ended is not revived.
func TestJobSeedAdoptsAnUntrackedChild(t *testing.T) {
	s, _ := newJobLive(t, "ajw12")
	sid := "ses_ajw12"
	s.live.set("ajw12", db.Field{Col: "activity", Val: "idle"})
	s.set(func(s *stopLive) {
		s.kids = map[string]string{sid: `{"id":"ses_c1","title":"Explore"},{"id":"ses_c2","title":"Done"}`}
		s.active["ses_c1"], s.active["ses_c2"] = true, true
	})
	release := s.seedHeld()
	s.event(`{"type":"session.tool.called","data":{"sessionID":"ses_c1"}}`)
	s.event(execution("started", "ses_c1"))
	s.event(execution("succeeded", "ses_c2"))
	release()
	s.seeded()
	s.wantWaits("ajw12", childWait)
	s.wantActivity("ajw12", "waiting")
	// The one adopted as ended is tracked: when it runs again its wait comes with the next execution's end.
	s.event(execution("started", "ses_c2"))
	s.event(execution("started", sid))
	s.event(execution("succeeded", sid))
	s.wantWaits("ajw12", childWait, "job|ses_c2|sub-agent \"Done\"|{\"type\":\"subagent\"}|hook")
}

// A job the server runs and the tracker doesn't know (a daemon restart, no session.created replayed) is kept from the
// seed's listing when an event during the reads names it without changing its state: a tool call of a child session, an
// output of a shell. The parent then ends waiting, not idle.
func TestJobSeedKeepsListedJobsAnEventNamed(t *testing.T) {
	s, _ := newJobLive(t, "ajw14")
	sid := "ses_ajw14"
	s.live.set("ajw14", db.Field{Col: "activity", Val: "working"})
	s.set(func(s *stopLive) {
		s.shells = shellListed("sh1", sid, "sleep 100")
		s.kids = map[string]string{sid: `{"id":"ses_c1","title":"Explore"}`}
		s.active["ses_c1"] = true
	})
	release := s.seedHeld()
	s.event(`{"type":"session.tool.called","data":{"sessionID":"ses_c1"}}`)
	s.event(`{"type":"shell.output","data":{"id":"sh1"}}`)
	release()
	s.seeded()
	s.event(execution("succeeded", sid))
	s.wantWaits("ajw14", shellWait, childWait)
	s.wantActivity("ajw14", "waiting")
}

// The seed's resync writes only while the agent is idle or waiting, read in the write's own transaction: an agent that
// began an execution between the check and the write gets no waits then.
func TestJobSeedResyncRechecksActivity(t *testing.T) {
	s, _ := newJobLive(t, "ajw13")
	sid := "ses_ajw13"
	s.live.set("ajw13", db.Field{Col: "activity", Val: "idle"})
	s.set(func(s *stopLive) { s.shells = shellListed("sh1", sid, "sleep 100") })
	s.life.jobStep = func(id, step string) {
		if step == "seed-bound" {
			s.life.jobStep = nil
			s.live.set(id, db.Field{Col: "activity", Val: "working"})
		}
	}
	s.life.seedJobs()
	s.seeded()
	s.wantWaits("ajw13")
	s.wantActivity("ajw13", "working")
	// The tracking has it: the execution's end writes it.
	s.event(execution("succeeded", sid))
	s.wantWaits("ajw13", shellWait)
}

// Seeds that overlap coalesce: a connect while a seed runs makes one more seed follow it, once, since the running one's
// reads predate the connect, and the later one's listing wins. A seed that fails logs, leaves the tracking as it is, and
// ends, so the next one runs.
func TestJobSeedCoalescesAndFailsSafe(t *testing.T) {
	s, _ := newJobLive(t, "ajw10")
	sid := "ses_ajw10"
	s.live.set("ajw10", db.Field{Col: "activity", Val: "idle"})
	s.set(func(s *stopLive) { s.shells = shellListed("sh1", sid, "sleep 100") })
	release := s.holdNext("children")
	s.life.seedJobs()
	s.until("the children read", func() bool { return s.inFlight("children") == 1 })
	// The server went away and came back with another shell, and the stream connected again, twice.
	s.set(func(s *stopLive) { s.shells = shellListed("sh4", sid, "after restart") })
	s.life.seedJobs()
	s.life.seedJobs()
	release()
	s.seeded()
	if n := s.reads("GET /api/session/active"); n != 2 {
		t.Errorf("%d reads of the active list; want 2", n)
	}
	s.wantWaits("ajw10", "job|sh4|background command \"after restart\"|{\"type\":\"shell\"}|hook")

	// A failed seed leaves the waits and the tracking.
	s.set(func(s *stopLive) { s.failJobs = true; s.shells = "" })
	s.life.seedJobs()
	s.seeded()
	s.wantWaits("ajw10", "job|sh4|background command \"after restart\"|{\"type\":\"shell\"}|hook")
	s.set(func(s *stopLive) { s.failJobs = false })
	s.life.seedJobs()
	s.seeded()
	s.wantWaits("ajw10")
	if n := s.reads("GET /api/session/active"); n != 4 {
		t.Errorf("%d reads of the active list; want 4", n)
	}
}

// Events, seeds, launches and stops at once, under -race: no lock is taken in the wrong order (a deadlock hangs the
// test), and the tracker ends where the last event left it.
func TestJobConcurrentOrders(t *testing.T) {
	s, clock := newJobLive(t, "ajw11")
	sid := "ses_ajw11"
	var wg sync.WaitGroup
	run := func(f func(i int)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 30; i++ {
				f(i)
			}
		}()
	}
	run(func(i int) {
		s.life.onOpenCodeEvent(s.ctx, mustEvent(t, shellMade("shc", sid, "loop")))
		s.life.onOpenCodeEvent(s.ctx, mustEvent(t, execution("succeeded", sid)))
		s.life.onOpenCodeEvent(s.ctx, mustEvent(t, shellExited("shc")))
		s.life.onOpenCodeEvent(s.ctx, mustEvent(t, execution("started", sid)))
	})
	run(func(i int) { s.life.seedJobs() })
	run(func(i int) { s.life.invalidate("ajw11"); s.life.nextLaunchGen("ajw11") })
	run(func(i int) { clock.fire() })
	wg.Wait()
	s.seeded()
	s.life.onOpenCodeEvent(s.ctx, mustEvent(t, shellExited("shc")))
	s.life.onOpenCodeEvent(s.ctx, mustEvent(t, execution("started", sid)))
	s.wantWaits("ajw11")
}

// reads is how many calls of the form the server got.
func (s *stopLive) reads(call string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, p := range s.paths {
		if p == call {
			n++
		}
	}
	return n
}

// mustEvent parses one event of the stream.
func mustEvent(t *testing.T, text string) opencode.Event {
	t.Helper()
	v, err := jsjson.Parse([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	o := v.(*jsjson.Object)
	typ, _ := o.Get("type")
	data, _ := o.Get("data")
	return opencode.Event{Type: typ.(string), Data: data.(*jsjson.Object), Raw: v}
}

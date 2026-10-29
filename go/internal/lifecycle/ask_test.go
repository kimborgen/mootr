package lifecycle

import (
	"context"
	"strings"
	"testing"
	"time"

	"stam/internal/adapters/opencode"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// newAskLive is stopLive with its dialogs recorded (fakeDialogs), and an active OpenCode agent whose session lists
// the permissions given.
func newAskLive(t *testing.T, id string, perms ...string) (*stopLive, *fakeDialogs) {
	t.Helper()
	s := newStopLive(t)
	fd := &fakeDialogs{}
	s.life.SetDialogs(fd)
	s.ocRow(id, "active", true)
	s.set(func(s *stopLive) { s.perms["ses_"+id] = append([]string{}, perms...) })
	return s, fd
}

// event hands the lifecycle one event of the server's stream, as Follow does.
func (s *stopLive) event(text string) {
	s.t.Helper()
	v, err := jsjson.Parse([]byte(text))
	if err != nil {
		s.t.Fatal(err)
	}
	o := v.(*jsjson.Object)
	typ, _ := o.Get("type")
	data, _ := o.Get("data")
	s.life.onOpenCodeEvent(s.ctx, opencode.Event{Type: typ.(string), Data: data.(*jsjson.Object), Raw: v})
	s.raised()
}

// raised waits until every agent's raiser has raised what was queued for it (queueAsks).
func (s *stopLive) raised() {
	s.t.Helper()
	s.until("the raises queued", func() bool {
		s.life.mu.Lock()
		owners := make([]*owner, 0, len(s.life.owners))
		for _, o := range s.life.owners {
			owners = append(owners, o)
		}
		s.life.mu.Unlock()
		for _, o := range owners {
			o.mu.Lock()
			busy := o.raiser
			o.mu.Unlock()
			if busy {
				return false
			}
		}
		return true
	})
}

// asked is a permission.asked for pid in sid, with a fake key in its metadata.
func asked(sid, pid string) string {
	return `{"type":"permission.asked","data":{"id":"` + pid + `","sessionID":"` + sid + `","action":"shell","resources":["make test"],"metadata":{"key":"sk-or-v1-leak"}}}`
}

func replied(sid, pid string) string {
	return `{"type":"permission.replied","data":{"sessionID":"` + sid + `","requestID":"` + pid + `","reply":"once"}}`
}

// askDetails is the details an ask for pid in sid is raised with.
func askDetails(sid, pid string) string {
	v, _ := jsjson.Parse([]byte(asked(sid, pid)))
	data, _ := v.(*jsjson.Object).Get("data")
	_, d, _ := opencode.AskDialog(data.(*jsjson.Object))
	return d
}

// parked is the agent's parked asks.
func (s *stopLive) parked(id string) []parkedAsk {
	o := s.life.ownerOf(id)
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]parkedAsk(nil), o.parked...)
}

// listings is how many permission listings of sid the server got.
func (s *stopLive) listings(sid string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, p := range s.paths {
		if p == "GET /api/session/"+sid+"/permission" {
			n++
		}
	}
	return n
}

func (s *stopLive) gotReplies() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.replies...)
}

// A permission.asked raises one ask, with only the fields the mail reads and the answer needs; the same event again
// keeps it. A permission the server no longer lists (a late event of a turn gone since), or a session it no longer
// has, raises none. A listing that fails, unlike TS, raises nothing yet: the ask is parked, and raised on the agent's
// next event once a listing shows it pending, or dropped once one no longer does.
func TestOpenCodeAskRaise(t *testing.T) {
	s, fd := newAskLive(t, "aar1", "per_1")
	sid := "ses_aar1"
	s.event(asked(sid, "per_1"))
	got, n := fd.state()
	if want := `{"tool":"shell","input":{"command":"make test"},"action":"shell","permission":"per_1","session":"ses_aar1"}`; got != want || n != 1 {
		t.Fatalf("ask %s (%d requests)", got, n)
	}
	if a := s.agent("aar1"); a.Activity != "blocked" || deref(a.ActivityDetail) != "permission shell" {
		t.Errorf("agent %s %s", a.Activity, deref(a.ActivityDetail))
	}
	s.event(asked(sid, "per_1"))
	if _, n := fd.state(); n != 1 {
		t.Errorf("a duplicate event made %d requests", n)
	}
	s.event(asked(sid, "per_late"))
	if got, n := fd.state(); n != 1 || !strings.Contains(got, "per_1") {
		t.Errorf("a permission no longer listed raised %s (%d requests)", got, n)
	}
	s.set(func(s *stopLive) { delete(s.perms, sid) })
	s.event(asked(sid, "per_gone"))
	if _, n := fd.state(); n != 1 {
		t.Errorf("a session the server no longer has raised an ask")
	}
	for _, d := range fd.shown {
		if strings.Contains(d.Details, "leak") || strings.Contains(d.Action, "leak") {
			t.Errorf("the event's metadata reached the ask: %+v", d)
		}
	}
}

// A listing that fails raises nothing and drops nothing: the ask is parked, listed again (each listing retried within
// its call) on the agent's next server event, and raised once the server lists it, or dropped once it doesn't.
func TestOpenCodeAskListingFails(t *testing.T) {
	s, fd := newAskLive(t, "aaf1", "per_1", "per_2")
	sid := "ses_aaf1"
	s.set(func(s *stopLive) { s.listFail = true })
	s.event(asked(sid, "per_1"))
	if _, n := fd.state(); n != 0 {
		t.Fatal("a listing that failed raised the ask")
	}
	if n := s.listings(sid); n != askListing.attempts {
		t.Errorf("the listing was asked %d times", n)
	}
	// Still failing: parked still, and the next event lists it again.
	s.event(`{"type":"session.tool.called","data":{"sessionID":"` + sid + `"}}`)
	if _, n := fd.state(); n != 0 {
		t.Fatal("a listing that failed again raised the ask")
	}
	s.set(func(s *stopLive) { s.listFail = false })
	s.event(`{"type":"session.tool.called","data":{"sessionID":"` + sid + `"}}`)
	if got, n := fd.state(); got != askDetails(sid, "per_1") || n != 1 {
		t.Fatalf("after a listing answered: %q (%d requests)", got, n)
	}
	s.event(`{"type":"session.tool.called","data":{"sessionID":"` + sid + `"}}`)
	if _, n := fd.state(); n != 1 {
		t.Errorf("a retry raised it twice")
	}
	// One no longer listed when the listing answers is dropped.
	s.set(func(s *stopLive) { s.listFail = true })
	s.event(asked(sid, "per_late"))
	s.set(func(s *stopLive) { s.listFail = false })
	s.event(`{"type":"session.tool.called","data":{"sessionID":"` + sid + `"}}`)
	if got, n := fd.state(); got != askDetails(sid, "per_1") || n != 1 {
		t.Errorf("a parked ask no longer listed: %q (%d requests)", got, n)
	}
	if p := s.parked("aaf1"); len(p) != 0 {
		t.Errorf("parked %+v", p)
	}
}

// shortRetry makes the retry of an ask whose listing failed come after d, for the test.
func shortRetry(t *testing.T, d time.Duration) {
	was := askRetryAfter
	askRetryAfter = d
	t.Cleanup(func() { askRetryAfter = was })
}

// An ask whose listing failed, with no further event, is listed again by the retry's timer alone, and raised.
func TestOpenCodeAskRetriedByTheTimer(t *testing.T) {
	shortRetry(t, 20*time.Millisecond)
	s, fd := newAskLive(t, "aat1", "per_1")
	sid := "ses_aat1"
	s.set(func(s *stopLive) { s.listFail = true })
	s.event(asked(sid, "per_1"))
	if _, n := fd.state(); n != 0 {
		t.Fatal("a listing that failed raised the ask")
	}
	s.set(func(s *stopLive) { s.listFail = false })
	s.until("the timer's retry raised it", func() bool { got, n := fd.state(); return got == askDetails(sid, "per_1") && n == 1 })
	if p := s.parked("aat1"); len(p) != 0 {
		t.Errorf("parked %+v", p)
	}
}

// The event stream never waits on a raise: while an ask's listing is held, the agent's next event is handled. The
// whole listing has one budget, after which the ask is parked.
func TestOpenCodeAskListingOffTheStream(t *testing.T) {
	s, fd := newAskLive(t, "aaw1", "per_1")
	sid := "ses_aaw1"
	release := s.holdNext("permission")
	defer release()
	ev := func(text string) {
		v, _ := jsjson.Parse([]byte(text))
		o := v.(*jsjson.Object)
		typ, _ := o.Get("type")
		data, _ := o.Get("data")
		s.life.onOpenCodeEvent(s.ctx, opencode.Event{Type: typ.(string), Data: data.(*jsjson.Object), Raw: v})
	}
	ev(asked(sid, "per_1"))
	// The event returned with its raise still running: its listing is the raiser's.
	o := s.life.ownerOf("aaw1")
	o.mu.Lock()
	running := o.raiser
	o.mu.Unlock()
	if !running {
		t.Fatal("the event returned only once its raise ended")
	}
	s.until("the listing held", func() bool { return s.inFlight("permission") == 1 })
	ev(`{"type":"session.tool.called","data":{"sessionID":"` + sid + `"}}`)
	if a := s.agent("aaw1"); a.Activity != "working" || deref(a.ActivityDetail) != "running a tool" {
		t.Errorf("the next event, while the listing is held: %s %s", a.Activity, deref(a.ActivityDetail))
	}
	if s.inFlight("permission") != 1 {
		t.Fatal("the listing ended before the next event was handled")
	}
	release()
	s.raised()
	if got, n := fd.state(); got != askDetails(sid, "per_1") || n != 1 {
		t.Errorf("after the listing answered: %q (%d requests)", got, n)
	}

	// A listing past its budget, one call held: parked, after that one call, not raised.
	was := askListing.budget
	askListing.budget = 100 * time.Millisecond
	t.Cleanup(func() { askListing.budget = was })
	s.set(func(s *stopLive) { s.perms[sid] = []string{"per_2"} })
	held := s.holdNext("permission")
	defer held()
	s.event(asked(sid, "per_2"))
	if p := s.parked("aaw1"); len(p) != 1 || s.listings(sid) != 2 {
		t.Errorf("a listing past its budget: parked %+v, %d listings", p, s.listings(sid))
	}
	if got, _ := fd.state(); strings.Contains(got, "per_2") {
		t.Errorf("a listing past its budget raised %s", got)
	}
}

// The timer's retry against a stop, a launch and an archive, each before the retry and during its listing. A stop
// parks it (raised again when the stop fails); a launch before leaves it raised (the server still lists it), one
// during its listing drops it; an archive drops it either way.
func TestOpenCodeAskRetryInterleavings(t *testing.T) {
	shortRetry(t, 20*time.Millisecond)
	type when int
	const (
		before when = iota
		during
	)
	cases := []struct {
		name   string
		id     string
		at     when
		act    func(s *stopLive, id string) (end func())
		raised bool
		// parks: nothing stands until end, the stop's failure.
		parks bool
	}{
		{"a stop before", "air1", before, stopFor, true, true},
		{"a stop during", "air2", during, stopFor, true, true},
		{"a launch before", "air3", before, launchFor, true, false},
		{"a launch during", "air4", during, launchFor, false, false},
		{"an archive before", "air5", before, archiveFor, false, false},
		{"an archive during", "air6", during, archiveFor, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, fd := newAskLive(t, c.id, "per_1")
			sid := "ses_" + c.id
			s.set(func(s *stopLive) { s.listFail = true })
			s.event(asked(sid, "per_1"))
			end := func() {}
			if c.at == before {
				end = c.act(s, c.id)
			} else {
				var once bool
				s.life.askStep = func(id, step string) {
					if step == "listed" && !once {
						once = true
						end = c.act(s, id)
					}
				}
			}
			s.set(func(s *stopLive) { s.listFail = false })
			s.until("the timer's retry", func() bool { return !unlistedParked(s, c.id) })
			s.raised()
			s.life.askStep = nil
			if got, _ := fd.state(); c.parks && got != "" {
				t.Errorf("an ask stands while the stop is in flight: %s", got)
			}
			end()
			s.raised()
			if got, n := fd.state(); c.raised != (got == askDetails(sid, "per_1") && n == 1) || (!c.raised && len(fd.shown) != 0) {
				t.Errorf("raised %v: %q (%d requests, shown %d)", c.raised, got, n, len(fd.shown))
			}
			if p := s.parked(c.id); len(p) != 0 {
				t.Errorf("parked %+v", p)
			}
		})
	}
}

// stopFor starts a stop of the agent's session that will fail (stubborn), held at its listing; end lets it fail.
func stopFor(s *stopLive, id string) func() {
	s.set(func(s *stopLive) { s.stubborn = true })
	release := s.holdNext("active")
	e := s.life.startStop(s.agent(id), "ses_"+id, s.life.nextGen(id))
	s.until("the stop's listing", func() bool { return s.inFlight("active") == 1 })
	return func() {
		release()
		_ = e.await(s.ctx)
	}
}

// launchFor is a launch's generation and release, as a launch that keeps the session makes.
func launchFor(s *stopLive, id string) func() {
	if _, err := s.life.releaseTurnStop(s.ctx, s.agent(id), s.life.nextLaunchGen(id)); err != nil {
		s.t.Fatal(err)
	}
	return func() {}
}

// archiveFor archives the agent, paused so the archive needs no pane.
func archiveFor(s *stopLive, id string) func() {
	s.live.set(id, db.Field{Col: "lifecycle", Val: "paused"})
	if _, err := s.life.Archive(s.ctx, s.agent(id), ArchiveOpts{}); err != nil {
		s.t.Fatal(err)
	}
	return func() {}
}

// unlistedParked is whether an ask of the agent's is parked for a listing.
func unlistedParked(s *stopLive, id string) bool {
	for _, p := range s.parked(id) {
		if p.stop == nil && p.launch == 0 {
			return true
		}
	}
	return false
}

// The same permission asked again after another ask replaced it raises nothing: A, B, A leaves B, and one request for
// A. A launch forgets the asks raised before it.
func TestOpenCodeAskDuplicateAfterAnother(t *testing.T) {
	s, fd := newAskLive(t, "aad2", "per_a", "per_b")
	sid := "ses_aad2"
	s.event(asked(sid, "per_a"))
	s.event(asked(sid, "per_b"))
	s.event(asked(sid, "per_a"))
	if got, n := fd.state(); got != askDetails(sid, "per_b") || n != 2 || len(fd.withdrawn) != 1 {
		t.Fatalf("A, B, A left %q (%d requests, withdrawn %q)", got, n, fd.withdrawn)
	}
	if err := releaseNow(s.life, s.ctx, s.agent("aad2")); err != nil {
		t.Fatal(err)
	}
	s.event(asked(sid, "per_a"))
	if got, n := fd.state(); got != askDetails(sid, "per_a") || n != 3 {
		t.Errorf("after a launch: %q (%d requests)", got, n)
	}
}

// A reply made outside stam closes the ask of its permission: before the ask (none is raised), during its listing
// (none is shown), while it is shown (it is closed again), or after (closed). A reply for another permission, or
// stam's own reply, closes nothing.
func TestOpenCodeAskRepliedOutside(t *testing.T) {
	s, fd := newAskLive(t, "aao1", "per_before", "per_listing", "per_during", "per_after", "per_mine")
	sid := "ses_aao1"
	a := s.agent("aao1")

	s.event(replied(sid, "per_before"))
	s.event(asked(sid, "per_before"))
	if got, n := fd.state(); got != "" || n != 0 {
		t.Fatalf("a permission replied first raised %s", got)
	}

	s.life.askStep = func(_, step string) {
		if step == "listed" {
			s.life.openCodeReplied(s.ctx, a, "per_listing")
		}
	}
	s.event(asked(sid, "per_listing"))
	if got, n := fd.state(); got != "" || n != 0 {
		t.Fatalf("a reply during the listing raised %s", got)
	}
	s.life.askStep = func(_, step string) {
		if step == "shown" {
			s.life.openCodeReplied(s.ctx, a, "per_during")
		}
	}
	s.event(asked(sid, "per_during"))
	s.life.askStep = nil
	if got, n := fd.state(); got != "" || n != 1 {
		t.Fatalf("a reply during the raise left %s (%d requests)", got, n)
	}

	s.event(asked(sid, "per_after"))
	s.event(replied(sid, "per_other"))
	if got, _ := fd.state(); !strings.Contains(got, "per_after") {
		t.Fatalf("a reply for another permission closed the ask: %q", got)
	}
	s.event(replied(sid, "per_after"))
	if got, _ := fd.state(); got != "" {
		t.Fatalf("a reply after the raise left %s", got)
	}

	// stam's own reply, told of while it is in flight and after it returned: the request is the answer's to settle.
	s.event(asked(sid, "per_mine"))
	details, _ := fd.state()
	s.life.askStep = func(_, step string) {
		if step == "replying" {
			s.event(replied(sid, "per_mine"))
		}
	}
	if out := s.life.AnswerDialog(s.ctx, s.agent("aao1"), details, true, ""); out != "typed" {
		t.Fatalf("answer %s", out)
	}
	s.life.askStep = nil
	s.event(replied(sid, "per_mine"))
	if got, _ := fd.state(); got != details {
		t.Errorf("stam's own reply closed its ask: %q", got)
	}
}

// An ask that comes while a stop of the session is in flight is parked, never raised then: the stop's interrupt
// rejects the permission. A stop that confirms the session stopped drops it, and no late event raises it.
func TestOpenCodeAskMidStop(t *testing.T) {
	s, fd := newAskLive(t, "aas1", "per_1")
	sid := "ses_aas1"
	release := s.holdNext("interrupt")
	defer release()
	if err := s.life.Shutdown(s.ctx, s.agent("aas1")); err != nil {
		t.Fatal(err)
	}
	s.until("the stop's interrupt", func() bool { return s.inFlight("interrupt") == 1 })
	s.event(asked(sid, "per_1"))
	if _, n := fd.state(); n != 0 {
		t.Fatal("an ask was raised while the stop was in flight")
	}
	if p := s.parked("aas1"); len(p) != 1 {
		t.Fatalf("parked %+v", p)
	}
	release()
	if err := s.life.awaitTurnStop(s.ctx, s.agent("aas1"), s.life.genOf("aas1")); err != nil {
		t.Fatal(err)
	}
	// The interrupt rejected it: the server no longer lists it, and no late event raises it.
	s.event(asked(sid, "per_1"))
	if _, n := fd.state(); n != 0 {
		t.Error("a permission the stop rejected was raised")
	}
	if p := s.parked("aas1"); len(p) != 0 {
		t.Errorf("parked %+v", p)
	}
}

// An ask parked for a stop that ends without confirming the session stopped is raised once it ends, if the server
// still lists it and the agent still runs the session: a stop a launch gave up, a stop that failed (a refused
// archive's), and a stop that began during the raise's listing, or while the ask was shown.
func TestOpenCodeAskParkedForAStop(t *testing.T) {
	// A Resume: its launch gives the stop up, which hands the ask to it; it stays parked until the launch writes the
	// row active, and is raised then. One the launch never lands (it fails, or a stop supersedes it) is dropped.
	resumeAt := func(t *testing.T, id string, at func(s *stopLive)) (*stopLive, *fakeDialogs, error) {
		s, fd := newAskLive(t, id, "per_1")
		sid := "ses_" + id
		release := s.holdNext("active")
		defer release()
		if err := s.life.Shutdown(s.ctx, s.agent(id)); err != nil {
			t.Fatal(err)
		}
		s.until("the stop's listing", func() bool { return s.inFlight("active") == 1 })
		s.event(asked(sid, "per_1"))
		if _, n := fd.state(); n != 0 {
			t.Fatal("an ask was raised while the stop was in flight")
		}
		e := s.life.turnStopOf(sid)
		landing := make(chan struct{})
		gate := make(chan struct{})
		s.life.launching = func(string) {
			close(landing)
			<-gate
		}
		defer func() { s.life.launching = nil }()
		resumed := make(chan error, 1)
		go func() {
			_, err := s.life.Resume(s.ctx, s.agent(id), "")
			resumed <- err
		}()
		s.until("the stop given up", func() bool { return e.cancelled.Load() })
		release()
		<-landing
		if p := s.parked(id); len(p) != 1 || p[0].launch == 0 {
			t.Fatalf("parked for the launch: %+v", p)
		}
		if at != nil {
			at(s)
		}
		close(gate)
		err := <-resumed
		s.raised()
		return s, fd, err
	}
	t.Run("given up by a Resume", func(t *testing.T) {
		s, fd, err := resumeAt(t, "aag1", nil)
		if err != nil {
			t.Fatal(err)
		}
		if a := s.agent("aag1"); a.Lifecycle != "active" {
			t.Fatalf("lifecycle %s", a.Lifecycle)
		}
		if got, n := fd.state(); got != askDetails("ses_aag1", "per_1") || n != 1 {
			t.Errorf("after the Resume landed: %q (%d requests)", got, n)
		}
	})
	t.Run("a Resume superseded", func(t *testing.T) {
		s, fd, _ := resumeAt(t, "aag2", func(s *stopLive) { s.life.nextGen("aag2") })
		if _, n := fd.state(); n != 0 {
			t.Errorf("an ask raised for a launch that never landed (%d requests)", n)
		}
		if p := s.parked("aag2"); len(p) != 0 {
			t.Errorf("parked %+v", p)
		}
	})
	t.Run("failed", func(t *testing.T) {
		s, fd := newAskLive(t, "aaf2", "per_1")
		sid := "ses_aaf2"
		s.set(func(s *stopLive) { s.stubborn = true })
		release := s.holdNext("active")
		defer release()
		e := s.life.startStop(s.agent("aaf2"), sid, s.life.nextGen("aaf2"))
		s.until("the stop's listing", func() bool { return s.inFlight("active") == 1 })
		s.event(asked(sid, "per_1"))
		if _, n := fd.state(); n != 0 {
			t.Fatal("an ask was raised while the stop was in flight")
		}
		release()
		if err := e.await(s.ctx); err == nil {
			t.Fatal("the stubborn session's stop confirmed")
		}
		s.until("the parked ask raised", func() bool { got, n := fd.state(); return got == askDetails(sid, "per_1") && n == 1 })
	})
	for _, step := range []string{"listed", "shown"} {
		t.Run("begun at "+step, func(t *testing.T) {
			s, fd := newAskLive(t, "aab1", "per_1")
			sid := "ses_aab1"
			s.set(func(s *stopLive) { s.stubborn = true })
			release := s.holdNext("active")
			defer release()
			var e *turnStop
			s.life.askStep = func(id, at string) {
				if at == step {
					e = s.life.startStop(s.agent(id), sid, s.life.nextGen(id))
					s.until("the stop's listing", func() bool { return s.inFlight("active") == 1 })
				}
			}
			s.event(asked(sid, "per_1"))
			s.life.askStep = nil
			if got, _ := fd.state(); got != "" {
				t.Fatalf("an ask stands while a stop is in flight: %s", got)
			}
			// A stop begun during the listing: nothing is shown. One begun once it was shown: it is closed again.
			if want := map[string]int{"listed": 0, "shown": 1}[step]; len(fd.shown) != want {
				t.Fatalf("shown %d times while the stop is in flight", len(fd.shown))
			}
			release()
			if err := e.await(s.ctx); err == nil {
				t.Fatal("the stubborn session's stop confirmed")
			}
			s.until("the parked ask raised", func() bool { got, _ := fd.state(); return got == askDetails(sid, "per_1") })
		})
	}
}

// A launch that lands during an ask's listing, a real release, means no ask is shown; one that lands while it is
// shown closes it again, by its permission id: the turn that asked is the earlier launch's. A launch before the event
// leaves the ask it raises.
func TestOpenCodeAskMidLaunch(t *testing.T) {
	s, fd := newAskLive(t, "aal1", "per_1", "per_2", "per_3")
	sid := "ses_aal1"
	launch := func(id string) {
		if _, err := s.life.releaseTurnStop(s.ctx, s.agent(id), s.life.nextLaunchGen(id)); err != nil {
			t.Fatal(err)
		}
	}
	s.life.askStep = func(id, step string) {
		if step == "listed" {
			launch(id)
		}
	}
	s.event(asked(sid, "per_1"))
	if got, n := fd.state(); got != "" || n != 0 {
		t.Fatalf("a launch during the listing left %q (%d requests)", got, n)
	}
	s.life.askStep = func(id, step string) {
		if step == "shown" {
			launch(id)
		}
	}
	s.event(asked(sid, "per_2"))
	s.life.askStep = nil
	if got, n := fd.state(); got != "" || n != 1 || len(fd.withdrawn) != 1 || fd.withdrawn[0] != askDetails(sid, "per_2") {
		t.Fatalf("a launch while it was shown left %q (%d requests, withdrawn %q)", got, n, fd.withdrawn)
	}
	launch("aal1")
	s.event(asked(sid, "per_3"))
	if got, _ := fd.state(); got != askDetails(sid, "per_3") {
		t.Errorf("an ask after the launch: %q", got)
	}
}

// An event read for the agent's earlier session, whose launch wrote a new one before the raise began, raises nothing:
// the raise binds the row's session with its generation.
func TestOpenCodeAskAfterASessionChange(t *testing.T) {
	s, fd := newAskLive(t, "aac1", "per_1")
	sid := "ses_aac1"
	s.life.askStep = func(id, step string) {
		if step == "raise" {
			s.life.nextLaunchGen(id)
			s.live.set(id, db.Field{Col: "session_id", Val: "ses_new"})
		}
	}
	s.event(asked(sid, "per_1"))
	s.life.askStep = nil
	if len(fd.shown) != 0 {
		t.Errorf("an ask was shown for the earlier session: %+v", fd.shown)
	}
}

// The answer is sent to the ask's permission under the agent's current session: a yes as once, a no as reject. Gone,
// with nothing sent, for another session, a permission or session the server no longer lists, an agent shut down or
// archived; unsafe for a yes to a question or an ask with no permission; failed, with the request left pending, when
// the listing fails.
func TestOpenCodeAnswer(t *testing.T) {
	s, _ := newAskLive(t, "aan1", "per_yes", "per_no", "per_q")
	sid := "ses_aan1"
	a := s.agent("aan1")
	answer := func(details string, approve bool) string {
		return s.life.AnswerDialog(s.ctx, s.agent("aan1"), details, approve, "")
	}
	if out := answer(askDetails(sid, "per_yes"), true); out != "typed" {
		t.Errorf("yes: %s", out)
	}
	if out := answer(askDetails(sid, "per_no"), false); out != "typed" {
		t.Errorf("no: %s", out)
	}
	question := `{"tool":"question","input":{"pattern":""},"action":"question","permission":"per_q","session":"ses_aan1"}`
	cases := []struct {
		name, details string
		approve       bool
		want          string
	}{
		{"a yes to a question", question, true, "unsafe"},
		{"no permission", `{"tool":"shell","session":"ses_aan1"}`, true, "unsafe"},
		{"another session", askDetails("ses_other", "per_q"), false, "gone"},
		{"a permission no longer listed", askDetails(sid, "per_yes"), true, "gone"},
	}
	for _, c := range cases {
		if out := answer(c.details, c.approve); out != c.want {
			t.Errorf("%s: %s", c.name, out)
		}
	}
	if got := s.gotReplies(); len(got) != 2 || got[0] != sid+" per_yes once" || got[1] != sid+" per_no reject" {
		t.Fatalf("replies %q", got)
	}
	if out := answer(question, false); out != "typed" {
		t.Errorf("a no to a question: %s", out)
	}
	s.set(func(s *stopLive) { s.perms[sid] = []string{"per_x"}; s.listFail = true })
	if out := answer(askDetails(sid, "per_x"), true); out != "failed" {
		t.Errorf("a listing that failed: %s", out)
	}
	s.set(func(s *stopLive) { s.listFail = false; delete(s.perms, sid) })
	if out := answer(askDetails(sid, "per_x"), true); out != "gone" {
		t.Errorf("a session the server no longer has: %s", out)
	}
	s.set(func(s *stopLive) { s.perms[sid] = []string{"per_x"} })
	for _, lc := range []string{"archived", "shut_down"} {
		s.live.set(a.ID, db.Field{Col: "lifecycle", Val: lc})
		if out := answer(askDetails(sid, "per_x"), true); out != "gone" {
			t.Errorf("an agent %s: %s", lc, out)
		}
	}
	if got := s.gotReplies(); len(got) != 3 {
		t.Errorf("replies %q", got)
	}
}

// An answer and a launch, both orders. A launch whose release lands while the answer holds the session cancels it:
// nothing is sent for the earlier launch's ask, and the release waits for the answer to let the session go. An answer
// that begins after the launch acts under it: the permission the server still lists is the session's now.
func TestOpenCodeAnswerAcrossALaunch(t *testing.T) {
	s, _ := newAskLive(t, "aaL1", "per_1")
	sid := "ses_aaL1"
	at, gate := make(chan struct{}), make(chan struct{})
	s.life.askStep = func(_, step string) {
		if step == "answer-listed" {
			close(at)
			<-gate
		}
	}
	out := make(chan string, 1)
	go func() { out <- s.life.AnswerDialog(s.ctx, s.agent("aaL1"), askDetails(sid, "per_1"), true, "") }()
	<-at
	released := make(chan error, 1)
	go func() {
		gen := s.life.nextLaunchGen("aaL1")
		_, err := s.life.releaseTurnStop(s.ctx, s.agent("aaL1"), gen)
		released <- err
	}()
	o := s.life.ownerOf("aaL1")
	s.until("the release cancelled the answer", func() bool {
		o.mu.Lock()
		defer o.mu.Unlock()
		for op := range o.slots[sid].ops {
			if op.cancelled.Load() {
				return true
			}
		}
		return false
	})
	select {
	case <-released:
		t.Fatal("the release took the session while the answer held it")
	default:
	}
	close(gate)
	if got := <-out; got != "failed" {
		t.Errorf("the overtaken answer: %s", got)
	}
	if err := <-released; err != nil {
		t.Fatal(err)
	}
	s.life.askStep = nil
	if got := s.gotReplies(); len(got) != 0 {
		t.Fatalf("an answer the launch overtook was sent: %q", got)
	}
	if got := s.life.AnswerDialog(s.ctx, s.agent("aaL1"), askDetails(sid, "per_1"), true, ""); got != "typed" {
		t.Errorf("the answer after the launch: %s", got)
	}
	if got := s.gotReplies(); len(got) != 1 || got[0] != sid+" per_1 once" {
		t.Errorf("replies %q", got)
	}
}

// The answer binds the row's session to the generation in one step, and checks both again once it holds the slot and
// before the reply. A launch that wrote a new session before the bind leaves the earlier session's ask gone; a launch
// as the slot is taken cancels it before the listing; a row archived, or a real Archive, while it holds the slot
// sends nothing.
func TestOpenCodeAnswerSnapshot(t *testing.T) {
	answerAt := func(t *testing.T, id, step string, at func(s *stopLive, id string)) (*stopLive, string) {
		s, _ := newAskLive(t, id, "per_1")
		s.life.askStep = func(_, now string) {
			if now == step {
				at(s, id)
			}
		}
		out := s.life.AnswerDialog(s.ctx, s.agent(id), askDetails("ses_"+id, "per_1"), true, "")
		s.life.askStep = nil
		return s, out
	}
	t.Run("a launch before the bind", func(t *testing.T) {
		s, out := answerAt(t, "aab2", "answer", func(s *stopLive, id string) {
			gen := s.life.nextLaunchGen(id)
			if _, err := s.life.updateIfCurrent(s.ctx, id, gen, nil, db.Field{Col: "session_id", Val: "ses_new"}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.life.releaseTurnStop(s.ctx, s.agent(id), gen); err != nil {
				t.Fatal(err)
			}
		})
		if out != "gone" || len(s.gotReplies()) != 0 || s.listings("ses_aab2") != 0 {
			t.Errorf("%s, replies %q, %d listings", out, s.gotReplies(), s.listings("ses_aab2"))
		}
	})
	t.Run("a launch as the slot is taken", func(t *testing.T) {
		s, out := answerAt(t, "aas2", "answer-slot", func(s *stopLive, id string) { s.life.nextLaunchGen(id) })
		if out != "failed" || s.listings("ses_aas2") != 0 {
			t.Errorf("%s, %d listings", out, s.listings("ses_aas2"))
		}
	})
	t.Run("a row archived while it holds the slot", func(t *testing.T) {
		s, out := answerAt(t, "aaa2", "answer-listed", func(s *stopLive, id string) {
			s.live.set(id, db.Field{Col: "lifecycle", Val: "archived"})
		})
		if out != "failed" || len(s.gotReplies()) != 0 {
			t.Errorf("%s, replies %q", out, s.gotReplies())
		}
	})
	// A paused agent archives at once: its generation taken, then its stop waits for the answer's slot.
	t.Run("an Archive while it holds the slot", func(t *testing.T) {
		archived := make(chan error, 1)
		s, out := answerAt(t, "aaA2", "answer-listed", func(s *stopLive, id string) {
			s.live.set(id, db.Field{Col: "lifecycle", Val: "paused"})
			gen := s.life.genOf(id)
			go func() {
				_, err := s.life.Archive(s.ctx, s.agent(id), ArchiveOpts{})
				archived <- err
			}()
			s.until("the archive's generation", func() bool { return s.life.genOf(id) > gen })
		})
		if out != "failed" || len(s.gotReplies()) != 0 {
			t.Errorf("%s, replies %q", out, s.gotReplies())
		}
		if err := <-archived; err != nil {
			t.Fatal(err)
		}
		if a := s.agent("aaA2"); a.Lifecycle != "archived" {
			t.Errorf("lifecycle %s", a.Lifecycle)
		}
	})
}

// A relaunch that keeps the session (a resume after a shutdown) finds its permissions rejected by the shutdown's stop,
// as OpenCode does: the reply it tells of closes the ask, and the earlier ask's answer reads as gone, sending nothing.
func TestOpenCodeAskAcrossAResume(t *testing.T) {
	s, fd := newAskLive(t, "aar2", "per_1")
	sid := "ses_aar2"
	s.event(asked(sid, "per_1"))
	details, _ := fd.state()
	if err := s.life.Shutdown(s.ctx, s.agent("aar2")); err != nil {
		t.Fatal(err)
	}
	if err := s.life.awaitTurnStop(s.ctx, s.agent("aar2"), s.life.genOf("aar2")); err != nil {
		t.Fatal(err)
	}
	// OpenCode tells of the rejection on its stream.
	s.event(`{"type":"permission.replied","data":{"sessionID":"` + sid + `","requestID":"per_1","reply":"reject"}}`)
	if got, _ := fd.state(); got != "" {
		t.Fatalf("the stop's rejection left the ask %s", got)
	}
	if err := releaseNow(s.life, s.ctx, s.agent("aar2")); err != nil {
		t.Fatal(err)
	}
	s.live.set("aar2", db.Field{Col: "lifecycle", Val: "active"})
	if out := s.life.AnswerDialog(s.ctx, s.agent("aar2"), details, true, ""); out != "gone" {
		t.Errorf("the earlier ask's answer after the resume: %s", out)
	}
	if got := s.gotReplies(); len(got) != 0 {
		t.Errorf("replies %q", got)
	}
}

// Every answer returns: one waiting for the session's slot ends with the daemon (its context), sending nothing.
func TestOpenCodeAnswerEndsWithTheDaemon(t *testing.T) {
	s, _ := newAskLive(t, "aad1", "per_1")
	sid := "ses_aad1"
	release := s.holdNext("interrupt")
	defer release()
	// A one-shot interrupt holds the slot while its call is held.
	go s.life.openCodeInterrupt(s.ctx, s.agent("aad1"))
	s.until("the interrupt", func() bool { return s.inFlight("interrupt") == 1 })
	ctx, cancel := context.WithCancel(s.ctx)
	out := make(chan string, 1)
	go func() { out <- s.life.AnswerDialog(ctx, s.agent("aad1"), askDetails(sid, "per_1"), true, "") }()
	o := s.life.ownerOf("aad1")
	s.until("the answer waits for the slot", func() bool {
		o.mu.Lock()
		defer o.mu.Unlock()
		return len(o.slots[sid].ops) == 2
	})
	cancel()
	// A bound for a broken build only: an answer that ignores its context never returns.
	select {
	case got := <-out:
		if got != "failed" {
			t.Errorf("the answer as the daemon stopped: %s", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the answer didn't return when the daemon stopped")
	}
	release()
	if got := s.gotReplies(); len(got) != 0 {
		t.Errorf("replies %q", got)
	}
}

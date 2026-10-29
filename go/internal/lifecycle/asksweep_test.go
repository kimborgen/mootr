package lifecycle

import (
	"strings"
	"testing"
	"time"

	"stam/internal/db"
)

// The sweep of pending asks (S-4280, asksweep.go): at a connect to the server's stream, the permissions an OpenCode agent's
// session lists as pending are read, and the newest stam has no record of is raised.

// sweep runs the connect's sweep and waits for it, and for the raises it queued.
func (s *stopLive) sweep() {
	s.t.Helper()
	s.life.sweepAsks()
	s.until("the sweep ended", func() bool {
		s.life.sweep.mu.Lock()
		defer s.life.sweep.mu.Unlock()
		return !s.life.sweep.running
	})
	s.raised()
}

// A daemon that restarted (or a stream that dropped) with a permission pending, whose event was never heard, raises it from
// the listing; the same sweep again raises nothing more; a sweep of a session that lists none raises none.
func TestOpenCodeSweepRaisesWhatWasLost(t *testing.T) {
	s, fd := newAskLive(t, "asr1", "per_1")
	s.sweep()
	got, n := fd.state()
	if n != 1 || !strings.Contains(got, `"permission":"per_1"`) || !strings.Contains(got, `"session":"ses_asr1"`) {
		t.Fatalf("the sweep raised %q (%d requests)", got, n)
	}
	s.sweep()
	if _, n := fd.state(); n != 1 {
		t.Errorf("a second sweep made %d requests", n)
	}
	// The event of the same ask later keeps the one ask.
	s.event(asked("ses_asr1", "per_1"))
	if _, n := fd.state(); n != 1 {
		t.Errorf("the event after the sweep made %d requests", n)
	}
	s2, fd2 := newAskLive(t, "asr2")
	s2.sweep()
	if _, n := fd2.state(); n != 0 {
		t.Errorf("a session with nothing pending raised %d", n)
	}
}

// A parked ask (its listing failed) and a sweep: the ask is the dialog's already, and the sweep raises nothing besides it.
func TestOpenCodeSweepKeepsAParkedAsk(t *testing.T) {
	s, fd := newAskLive(t, "asp1", "per_1", "per_2")
	sid := "ses_asp1"
	s.set(func(s *stopLive) { s.listFail = true })
	s.event(asked(sid, "per_1"))
	if p := s.parked("asp1"); len(p) != 1 {
		t.Fatalf("parked %+v", p)
	}
	s.set(func(s *stopLive) { s.listFail = false })
	s.sweep()
	// Nothing besides per_1: the sweep neither replaced it with per_2 nor raised per_2 beside it.
	got, _ := fd.state()
	if strings.Contains(got, "per_2") {
		t.Errorf("the sweep raised a permission over the parked ask: %q", got)
	}
}

// The newest of the listed permissions is the one raised; the answered and the already raised ones are not.
func TestOpenCodeSweepPicksTheNewestUnseen(t *testing.T) {
	s, fd := newAskLive(t, "asn1", "per_1", "per_2", "per_3")
	sid := "ses_asn1"
	// per_3, the newest, was answered outside stam: per_2 is the newest of the rest.
	s.event(replied(sid, "per_3"))
	s.sweep()
	if got, n := fd.state(); n != 1 || !strings.Contains(got, `"permission":"per_2"`) {
		t.Fatalf("raised %q (%d requests)", got, n)
	}
	// per_2 is raised: a sweep with per_1 still listed does not replace it.
	s.sweep()
	if got, _ := fd.state(); !strings.Contains(got, `"permission":"per_2"`) {
		t.Errorf("a later sweep replaced the ask: %q", got)
	}
}

// A permission the server lists newer than one stam raised (by an event) is not raised over it: the older ask is the dialog's.
func TestOpenCodeSweepNeverReplacesARaisedAsk(t *testing.T) {
	s, fd := newAskLive(t, "asv1", "per_1")
	sid := "ses_asv1"
	s.event(asked(sid, "per_1"))
	s.pend(sid, "per_1", "per_2")
	s.sweep()
	got, _ := fd.state()
	if !strings.Contains(got, `"permission":"per_1"`) {
		t.Errorf("the sweep replaced the raised ask: %q", got)
	}
	fd.mu.Lock()
	n := len(fd.shown)
	fd.mu.Unlock()
	if n != 1 {
		t.Errorf("%d asks were shown", n)
	}
}

// A gone answer drops the ask parked for its permission, as it marks the permission.
func TestOpenCodeGoneAnswerDropsAParkedAsk(t *testing.T) {
	id := "asd1"
	s, _ := newAskLive(t, id, "per_1")
	sid := "ses_" + id
	s.set(func(s *stopLive) { s.listFail = true })
	s.event(asked(sid, "per_1"))
	if p := s.parked(id); len(p) != 1 {
		t.Fatalf("parked %+v", p)
	}
	other := strings.Replace(askDetails(sid, "per_1"), sid, "ses_other", 1)
	if out := s.life.AnswerDialog(s.ctx, s.agent(id), other, true, ""); out != "gone" {
		t.Fatalf("answer %s", out)
	}
	if p := s.parked(id); len(p) != 0 {
		t.Errorf("a gone answer left parked %+v", p)
	}
}

// A sweep never reopens an answered ask: answered by the human through stam, outside stam, or found gone.
func TestOpenCodeSweepNeverReopensAnAnswered(t *testing.T) {
	cases := []struct {
		name   string
		answer func(s *stopLive, fd *fakeDialogs, id, sid string)
	}{
		{"typed", func(s *stopLive, fd *fakeDialogs, id, sid string) {
			s.event(asked(sid, "per_1"))
			if out := s.life.AnswerDialog(s.ctx, s.agent(id), askDetails(sid, "per_1"), true, ""); out != "typed" {
				t.Fatalf("answer %s", out)
			}
			// The server still lists it, as a reply that is slow to settle would.
		}},
		{"outside", func(s *stopLive, fd *fakeDialogs, id, sid string) {
			s.event(asked(sid, "per_1"))
			s.event(replied(sid, "per_1"))
		}},
		{"outside unseen", func(s *stopLive, fd *fakeDialogs, id, sid string) {
			s.event(replied(sid, "per_1"))
		}},
		{"gone", func(s *stopLive, fd *fakeDialogs, id, sid string) {
			s.event(asked(sid, "per_1"))
			s.pend(sid)
			if out := s.life.AnswerDialog(s.ctx, s.agent(id), askDetails(sid, "per_1"), true, ""); out != "gone" {
				t.Fatalf("answer %s", out)
			}
			s.pend(sid, "per_1")
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			id := "asa1"
			s, fd := newAskLive(t, id, "per_1")
			c.answer(s, fd, id, "ses_"+id)
			fd.mu.Lock()
			fd.pending = nil
			before := len(fd.shown)
			fd.mu.Unlock()
			s.sweep()
			fd.mu.Lock()
			shown := len(fd.shown) - before
			fd.mu.Unlock()
			if got, _ := fd.state(); got != "" || shown != 0 {
				t.Errorf("the sweep reopened an answered ask: %q (%d shown)", got, shown)
			}
		})
	}
}

// An answer that finds the permission gone, because the agent no longer runs the session it names, leaves a marker too: a
// sweep of a session the server lists the permission in again does not raise it.
func TestOpenCodeGoneAnswerLeavesAMarker(t *testing.T) {
	id := "asg1"
	s, _ := newAskLive(t, id, "per_1")
	sid := "ses_" + id
	s.event(asked(sid, "per_1"))
	details := askDetails(sid, "per_1")
	// The answer names a session of the agent's past: gone, with the agent's own (current) generation to mark.
	other := strings.Replace(details, sid, "ses_other", 1)
	if out := s.life.AnswerDialog(s.ctx, s.agent(id), other, true, ""); out != "gone" {
		t.Fatalf("answer %s", out)
	}
	o := s.life.ownerOf(id)
	o.mu.Lock()
	marked := o.replied["per_1"]
	o.mu.Unlock()
	if !marked {
		t.Error("a gone answer left no marker")
	}
}

// A listing that fails is tried again by the retry's timer alone, once; a session the server has no more raises nothing and
// retries nothing.
func TestOpenCodeSweepRetriesAFailedListing(t *testing.T) {
	shortRetry(t, 20*time.Millisecond)
	s, fd := newAskLive(t, "asf1", "per_1")
	s.set(func(s *stopLive) { s.listFail = true })
	s.sweep()
	if _, n := fd.state(); n != 0 {
		t.Fatal("a listing that failed raised an ask")
	}
	s.set(func(s *stopLive) { s.listFail = false })
	s.until("the retry raised it", func() bool { got, n := fd.state(); return n == 1 && strings.Contains(got, "per_1") })
	s.life.bg.Wait()

	s2, fd2 := newAskLive(t, "asf2")
	s2.set(func(s *stopLive) { delete(s.perms, "ses_asf2") })
	s2.sweep()
	before := s2.listings("ses_asf2")
	time.Sleep(100 * time.Millisecond)
	if n := s2.listings("ses_asf2"); n != before {
		t.Errorf("a session gone was listed %d more times", n-before)
	}
	if _, n := fd2.state(); n != 0 {
		t.Errorf("a session gone raised %d", n)
	}
}

// No agent is swept when it runs no session, or is shut down; an agent of another harness is not swept at all.
func TestOpenCodeSweepSkipsWhatDoesNotRun(t *testing.T) {
	s, fd := newAskLive(t, "ass1", "per_1")
	s.life.invalidate("ass1")
	s.live.set("ass1", db.Field{Col: "lifecycle", Val: "shut_down"})
	s.sweep()
	if _, n := fd.state(); n != 0 {
		t.Errorf("a shut down agent raised %d", n)
	}
	if n := s.listings("ses_ass1"); n != 0 {
		t.Errorf("a shut down agent's session was listed %d times", n)
	}
}

// A connect while a sweep runs makes it go through the agents again, and a sweep in flight is waited for at cleanup.
func TestOpenCodeSweepCoalescesAndEnds(t *testing.T) {
	s, fd := newAskLive(t, "asc1", "per_1")
	release := s.holdNext("permission")
	s.life.sweepAsks()
	s.until("the listing held", func() bool { return s.inFlight("permission") == 1 })
	s.life.sweepAsks()
	s.life.sweepAsks()
	s.life.sweep.mu.Lock()
	again := s.life.sweep.again
	s.life.sweep.mu.Unlock()
	if !again {
		t.Error("a connect during a sweep did not ask for another pass")
	}
	release()
	s.until("the sweeps ended", func() bool {
		s.life.sweep.mu.Lock()
		defer s.life.sweep.mu.Unlock()
		return !s.life.sweep.running
	})
	s.raised()
	if _, n := fd.state(); n != 1 {
		t.Errorf("%d requests", n)
	}
}

// The listing a sweep has in flight is background work: the cleanup (bg.Wait) waits for it.
func TestOpenCodeSweepCleanupWaitsForTheListing(t *testing.T) {
	s, _ := newAskLive(t, "asw2", "per_1")
	release := s.holdNext("permission")
	defer release()
	s.life.sweepAsks()
	s.until("the listing held", func() bool { return s.inFlight("permission") == 1 })
	done := make(chan struct{})
	go func() { s.life.bg.Wait(); close(done) }()
	select {
	case <-done:
		t.Fatal("the cleanup did not wait for the listing in flight")
	case <-time.After(200 * time.Millisecond):
	}
	release()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the background work never ended")
	}
}

// Nothing the sweep logs or records holds the ask's text or the event's metadata.
func TestOpenCodeSweepLeaksNothing(t *testing.T) {
	shortRetry(t, 20*time.Millisecond)
	s, fd := newAskLive(t, "asl1", "per_1")
	s.set(func(s *stopLive) { s.listFail = true })
	s.sweep()
	s.set(func(s *stopLive) { s.listFail = false })
	s.until("raised", func() bool { _, n := fd.state(); return n == 1 })
	for _, ev := range []string{"permission-error", "permission-asked"} {
		got := lastEvent(t, s.live, "asl1", ev)
		for _, leak := range []string{"sk-or-v1", "Authorization", "Bearer"} {
			if strings.Contains(got, leak) {
				t.Errorf("event %s holds %q", ev, leak)
			}
		}
	}
	for _, d := range fd.shown {
		if strings.Contains(d.Details, "leak") {
			t.Errorf("the ask holds the event's metadata: %+v", d)
		}
	}
}

// A sweep while an event's ask is being raised (taken from the queue, not raised yet): that ask is the dialog's, and the
// newer permission the server lists is not raised over it.
func TestOpenCodeSweepWhileAnAskIsInFlight(t *testing.T) {
	id := "asi1"
	s, fd := newAskLive(t, id, "per_1", "per_2")
	sid := "ses_" + id
	fired := false
	s.life.askStep = func(aid, at string) {
		if at == "listed" && aid == id && !fired {
			fired = true
			s.life.sweepAsks()
			s.until("the sweep ended", func() bool {
				s.life.sweep.mu.Lock()
				defer s.life.sweep.mu.Unlock()
				return !s.life.sweep.running
			})
		}
	}
	s.event(asked(sid, "per_1"))
	s.life.askStep = nil
	if !fired {
		t.Fatal("the raise never reached listed")
	}
	got, _ := fd.state()
	if !strings.Contains(got, `"permission":"per_1"`) {
		t.Errorf("the dialog holds %q, want the event's per_1", got)
	}
	fd.mu.Lock()
	shown := len(fd.shown)
	fd.mu.Unlock()
	if shown != 1 {
		t.Errorf("%d asks were shown", shown)
	}
}

// The event of the permission a sweep is raising (told of while the sweep's ask is on the dialog) is the same ask, not a newer
// one: the ask stays, shown once, never closed and raised again.
func TestOpenCodeSweepAndItsOwnEvent(t *testing.T) {
	id := "ase1"
	s, fd := newAskLive(t, id, "per_1")
	sid := "ses_" + id
	for _, step := range []string{"raise", "listing", "listed", "shown"} {
		t.Run(step, func(t *testing.T) {
			fd.mu.Lock()
			fd.pending, fd.shown, fd.closed = nil, nil, 0
			fd.mu.Unlock()
			s.life.ownerOf(id).mu.Lock()
			s.life.ownerOf(id).asked = map[askKey]bool{}
			s.life.ownerOf(id).mu.Unlock()
			fired := false
			s.life.askStep = func(aid, at string) {
				if at == step && aid == id && !fired {
					fired = true
					s.life.onOpenCodeEvent(s.ctx, ocEvent(asked(sid, "per_1")))
				}
			}
			s.sweep()
			s.life.askStep = nil
			if !fired {
				t.Fatalf("the sweep never reached %s", step)
			}
			got, _ := fd.state()
			fd.mu.Lock()
			shown, closed := len(fd.shown), fd.closed
			fd.mu.Unlock()
			if !strings.Contains(got, `"permission":"per_1"`) || shown != 1 || closed != 0 {
				t.Errorf("the dialog holds %q, shown %d, closed %d", got, shown, closed)
			}
		})
	}
}

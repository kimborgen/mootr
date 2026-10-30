package lifecycle

import (
	"testing"
)

// holdReplace holds the next launch's replace of its pane (replacePane) with the old pane killed, before its token and
// new session.
func (s *stopLive) holdReplace() (in chan struct{}, free chan struct{}) {
	in, free = make(chan struct{}), make(chan struct{})
	s.life.paneMaking = func(string) {
		s.life.paneMaking = nil
		close(in)
		<-free
	}
	return in, free
}

// ownerWaits is the owner's launches waiting in beginPane and kills waiting in beginKill.
func (s *stopLive) ownerWaits(id string) (panes, kills int) {
	o := s.life.ownerOf(id)
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.paneWaits, o.killWaits
}

func tokenHash(s *stopLive, id string) string {
	if h := s.agent(id).TokenHash; h != nil {
		return h.Reveal()
	}
	return ""
}

// A launch's kill of the old pane, its token and its new pane are one kill in flight (S-4269): a newer launch waits in
// beginPane for all of it, and the older one, superseded, is abandoned without an error and makes no pane, so the newer
// one's pane is the agent's.
func TestNewerLaunchWaitsForTheReplace(t *testing.T) {
	s := newStopLive(t)
	s.ocRow("ats40", "active", true)
	in, free := s.holdReplace()
	older := make(chan error, 1)
	go func() { older <- s.life.StartHarness(s.ctx, s.agent("ats40"), "", true, "resume") }()
	<-in
	newer := make(chan error, 1)
	go func() { newer <- s.life.StartHarness(s.ctx, s.agent("ats40"), "", true, "resume") }()
	s.until("the newer launch to wait for the replace, or make its pane", func() bool {
		panes, _ := s.ownerWaits("ats40")
		return panes == 1 || s.countEvents("ats40", "resume") > 0
	})
	if panes, _ := s.ownerWaits("ats40"); panes != 1 {
		t.Fatal("the newer launch went on while the older one replaced the pane")
	}
	close(free)
	if err := <-older; err != nil {
		t.Errorf("the superseded launch: %v", err)
	}
	if err := <-newer; err != nil {
		t.Fatal(err)
	}
	s.until("the newer launch to land", func() bool { a := s.agent("ats40"); return a.Activity == "idle" && detailOf(a) == "ready" })
	if !s.tmux.HasSession(s.ctx, "ats40") {
		t.Error("the newer launch's pane is gone")
	}
	if n := s.countEvents("ats40", "resume"); n != 1 {
		t.Errorf("%d resume events", n)
	}
	if a := s.agent("ats40"); a.Lifecycle != "active" {
		t.Errorf("lifecycle %s", a.Lifecycle)
	}
}

// A shutdown or an archive that comes during a launch's replace waits in beginKill for it to end, then kills whatever
// pane is there: the launch, superseded, writes no token and makes no pane, and the row is the stop's. (An archive kills
// only a stopped agent's pane; an active one's takes a final round first.)
func TestStopWaitsForTheReplace(t *testing.T) {
	s := newStopLive(t)
	for _, c := range []struct {
		id, name, from, lifecycle string
		stop                      func(id string) error
	}{
		{"ats41", "shutdown", "active", "shut_down", func(id string) error { return s.life.Shutdown(s.ctx, s.agent(id)) }},
		{"ats43", "archive", "shut_down", "archived", func(id string) error { _, err := s.life.Archive(s.ctx, s.agent(id), ArchiveOpts{}); return err }},
	} {
		t.Run(c.name, func(t *testing.T) {
			s.ocRow(c.id, c.from, c.from == "active")
			before := tokenHash(s, c.id)
			in, free := s.holdReplace()
			launched := make(chan error, 1)
			go func() { launched <- s.life.StartHarness(s.ctx, s.agent(c.id), "", true, "resume") }()
			<-in
			stopped := make(chan error, 1)
			go func() { stopped <- c.stop(c.id) }()
			s.until("the "+c.name+" to wait for the replace, or end", func() bool {
				_, kills := s.ownerWaits(c.id)
				return kills == 1 || len(stopped) == 1
			})
			if _, kills := s.ownerWaits(c.id); kills != 1 {
				t.Fatalf("the %s went on while the launch replaced the pane", c.name)
			}
			close(free)
			if err := <-launched; err != nil {
				t.Errorf("the superseded launch: %v", err)
			}
			if err := <-stopped; err != nil {
				t.Fatal(err)
			}
			if s.tmux.HasSession(s.ctx, c.id) {
				t.Error("a pane outlived the " + c.name)
			}
			if h := tokenHash(s, c.id); h != before {
				t.Error("the superseded launch wrote its token")
			}
			if n := s.countEvents(c.id, "resume"); n != 0 {
				t.Errorf("%d resume events", n)
			}
			if a := s.agent(c.id); string(a.Lifecycle) != c.lifecycle {
				t.Errorf("lifecycle %s", a.Lifecycle)
			}
		})
	}
}

// A pause during a launch's replace kills nothing: it marks the row paused, and the launch, still current, makes its pane
// and lands paused (its held check in the serial), with its own token.
func TestPauseDuringTheReplace(t *testing.T) {
	s := newStopLive(t)
	s.ocRow("ats42", "active", true)
	before := tokenHash(s, "ats42")
	in, free := s.holdReplace()
	launched := make(chan error, 1)
	go func() { launched <- s.life.StartHarness(s.ctx, s.agent("ats42"), "", true, "resume") }()
	<-in
	if _, err := s.life.Pause(s.ctx, s.agent("ats42"), humanID); err != nil {
		t.Fatal(err)
	}
	close(free)
	if err := <-launched; err != nil {
		t.Fatal(err)
	}
	if !s.tmux.HasSession(s.ctx, "ats42") {
		t.Error("the paused launch's pane is gone")
	}
	if h := tokenHash(s, "ats42"); h == before {
		t.Error("the launch wrote no token")
	}
	if a := s.agent("ats42"); a.Lifecycle != "paused" {
		t.Errorf("lifecycle %s", a.Lifecycle)
	}
}

// A launch superseded by the time its replace ends kills the pane it made under the replace's own count (S-4269 F1):
// a newer launch that failed before its own replace leaves nothing else to remove it (the older launch's killPane is
// refused for it), and a launch after that waits in beginPane until the kill is done.
func TestSupersededReplaceKillsItsPane(t *testing.T) {
	s := newStopLive(t)
	made := func() (in chan struct{}, free chan struct{}) {
		in, free = make(chan struct{}), make(chan struct{})
		s.life.paneMade = func(string) {
			s.life.paneMade = nil
			close(in)
			<-free
		}
		return in, free
	}
	failNewer := func(id string) {
		s.life.SetFailLaunch([]string{"n-" + id})
		if err := s.life.StartHarness(s.ctx, s.agent(id), "", true, "resume"); err == nil {
			t.Fatal("the failing launch went on")
		}
		s.life.SetFailLaunch(nil)
	}
	t.Run("alone", func(t *testing.T) {
		// The older launch made its pane; a newer one takes a generation and fails before its replace. The older one's
		// replace kills its pane, and nothing is left.
		s.ocRow("ats44", "active", true)
		in, free := made()
		older := make(chan error, 1)
		go func() { older <- s.life.StartHarness(s.ctx, s.agent("ats44"), "", true, "resume") }()
		<-in
		failNewer("ats44")
		close(free)
		if err := <-older; err != nil {
			t.Errorf("the superseded launch: %v", err)
		}
		if s.tmux.HasSession(s.ctx, "ats44") {
			t.Error("the superseded launch's pane was orphaned")
		}
		if n := s.countEvents("ats44", "resume"); n != 0 {
			t.Errorf("%d resume events", n)
		}
	})
	t.Run("counted", func(t *testing.T) {
		// As above, with a third launch after the failed one: it waits in beginPane through the older one's kill of its
		// pane, which still holds the replace's count, then makes its own pane.
		s.ocRow("ats45", "active", true)
		in, free := made()
		older := make(chan error, 1)
		go func() { older <- s.life.StartHarness(s.ctx, s.agent("ats45"), "", true, "resume") }()
		<-in
		failNewer("ats45")
		third := make(chan error, 1)
		go func() { third <- s.life.StartHarness(s.ctx, s.agent("ats45"), "", true, "resume") }()
		s.until("the third launch to wait for the replace, or make its pane", func() bool {
			panes, _ := s.ownerWaits("ats45")
			return panes == 1 || s.countEvents("ats45", "resume") > 0
		})
		if panes, _ := s.ownerWaits("ats45"); panes != 1 {
			t.Fatal("the third launch went on while the older one replaced the pane")
		}
		killing, kill := make(chan struct{}), make(chan struct{})
		s.life.paneKilling = func(string) {
			s.life.paneKilling = nil
			close(killing)
			<-kill
		}
		close(free)
		select {
		case <-killing:
		case err := <-older:
			t.Fatalf("the superseded launch ended (%v) without killing its pane", err)
		}
		o := s.life.ownerOf("ats45")
		o.mu.Lock()
		kills, waits := o.kills, o.paneWaits
		o.mu.Unlock()
		if kills != 1 || waits != 1 {
			t.Errorf("at the superseded launch's kill: %d kills in flight, %d launches waiting", kills, waits)
		}
		close(kill)
		if err := <-older; err != nil {
			t.Errorf("the superseded launch: %v", err)
		}
		if err := <-third; err != nil {
			t.Fatal(err)
		}
		s.until("the third launch to land", func() bool { a := s.agent("ats45"); return a.Activity == "idle" && detailOf(a) == "ready" })
		if !s.tmux.HasSession(s.ctx, "ats45") {
			t.Error("the third launch's pane is gone")
		}
		if n := s.countEvents("ats45", "resume"); n != 1 {
			t.Errorf("%d resume events", n)
		}
	})
}

package lifecycle

import "testing"

// A raise reads stam's answers where it reads the request standing (Dialog.Choose, under the server's permMu, which an
// answer holds while it acts): these tests answer while a raise waits there, or just after it showed its ask.

// pend sets the session's pending permissions: what its listing answers from here.
func (s *stopLive) pend(sid string, pids ...string) {
	s.set(func(s *stopLive) { s.perms[sid] = append([]string{}, pids...) })
}

// answerWhileShown has the raise of sid's per_1 wait, before it reads the request standing, for the human's yes; first
// meanwhile runs before the answer. It returns the answer's outcome once the raise is done.
func answerWhileShown(s *stopLive, fd *fakeDialogs, id string, meanwhile func()) string {
	sid := "ses_" + id
	var out string
	fd.waiting = func() {
		meanwhile()
		out = s.life.AnswerDialog(s.ctx, s.agent(id), askDetails(sid, "per_1"), true, "")
		// The server settles the request, or closes it gone.
		fd.mu.Lock()
		fd.pending = nil
		fd.mu.Unlock()
	}
	s.event(asked(sid, "per_1"))
	s.raised()
	return out
}

// A permission stam answers while its raise waits to show it is not shown: the raise reads the answer where it reads
// the request standing.
func TestOpenCodeAskAnsweredWhileShown(t *testing.T) {
	s, fd := newAskLive(t, "asw1", "per_1")
	out := answerWhileShown(s, fd, "asw1", func() {})
	if out != "typed" {
		t.Fatalf("answer %s", out)
	}
	if got, n := fd.state(); got != "" || n != 0 {
		t.Errorf("the ask answered shown: %q (%d requests)", got, n)
	}
}

// A permission whose answer finds it gone while its raise waits to show it (replied to outside stam, its event not yet
// come, or its session gone; the raise listed it before) is not shown either: the answer records it.
func TestOpenCodeAskGoneWhileShown(t *testing.T) {
	for _, c := range []struct {
		name string
		gone func(s *stopLive, sid string)
	}{
		{"not listed", func(s *stopLive, sid string) { s.pend(sid) }},
		{"the session gone", func(s *stopLive, sid string) { s.set(func(s *stopLive) { delete(s.perms, sid) }) }},
	} {
		t.Run(c.name, func(t *testing.T) {
			s, fd := newAskLive(t, "agw1", "per_1")
			out := answerWhileShown(s, fd, "agw1", func() { c.gone(s, "ses_agw1") })
			if out != "gone" {
				t.Fatalf("answer %s", out)
			}
			if got, n := fd.state(); got != "" || n != 0 {
				t.Errorf("the ask gone shown: %q (%d requests)", got, n)
			}
		})
	}
}

// A gone answer of an older launch records nothing for the launch since: the permission, asked for in the new
// launch's session, is raised.
func TestOpenCodeAskGoneOfAnOlderLaunch(t *testing.T) {
	s, fd := newAskLive(t, "agw2")
	sid := "ses_agw2"
	release := s.holdNext("permission")
	defer release()
	answered := make(chan string, 1)
	go func() { answered <- s.life.AnswerDialog(s.ctx, s.agent("agw2"), askDetails(sid, "per_1"), true, "") }()
	s.until("the answer's listing", func() bool { return s.inFlight("permission") == 1 })
	gen := s.life.genOf("agw2")
	launched := make(chan struct{})
	go func() { launchFor(s, "agw2"); close(launched) }()
	s.until("the launch's generation", func() bool { return s.life.genOf("agw2") > gen })
	release()
	if out := <-answered; out != "gone" {
		t.Fatalf("answer %s", out)
	}
	<-launched
	s.pend(sid, "per_1")
	s.event(asked(sid, "per_1"))
	s.raised()
	if got, n := fd.state(); got != askDetails(sid, "per_1") || n != 1 {
		t.Errorf("the new launch's ask: %q (%d requests)", got, n)
	}
}

// One stam answers just after it was shown is closed again: the check after the show reads the answer too.
func TestOpenCodeAskAnsweredOnceShown(t *testing.T) {
	s, fd := newAskLive(t, "asw2", "per_1")
	sid := "ses_asw2"
	var out string
	s.life.askStep = func(_, step string) {
		if step == "shown" && out == "" {
			out = s.life.AnswerDialog(s.ctx, s.agent("asw2"), askDetails(sid, "per_1"), true, "")
		}
	}
	s.event(asked(sid, "per_1"))
	s.raised()
	s.life.askStep = nil
	if out != "typed" {
		t.Fatalf("answer %s", out)
	}
	if got, _ := fd.state(); got != "" || len(fd.withdrawn) != 1 || fd.withdrawn[0] != askDetails(sid, "per_1") {
		t.Errorf("standing %q, withdrawn %q", got, fd.withdrawn)
	}
}

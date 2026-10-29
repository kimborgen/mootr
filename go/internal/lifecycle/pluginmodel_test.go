package lifecycle

import (
	"stam/internal/db"
	"strings"
	"testing"
)

// The model test of the OpenCode plugin's routes (S-4237 PR 5): the notice and the compaction instructions, each asked for
// a session, crossed with the agent moving on (a stop, a new session, the same session resumed, a stop begun, a launch in
// flight) at every step of the take. An ask made after the intrusion began (the plugin's request found the agent as it
// was, the agent moved before the take) takes nothing: its notice stays queued, its instructions stay set, and nothing is
// marked delivered. An ask that began after the agent moved is the current launch's and is served (the same session
// resumed is then the same plugin).

type plugActor struct {
	name  string
	steps []string
	// run asks for the session's text; intrude is the "start" step: the agent moves after the caller found the agent and
	// before the route's binding.
	run func(s *stopLive, id string, intrude func()) string
	// pre sets what the ask takes; left says whether it is still there.
	pre  func(s *stopLive, id string)
	left func(s *stopLive, id string) bool
	// marked is the count of the delivery mark.
	marked func(s *stopLive, id string) string
}

func plugMarks(s *stopLive, id string) string {
	return s.query("SELECT count(*) FROM events WHERE agent_id = ? AND type = 'mail:notice'", id)
}

var plugActors = []plugActor{
	{name: "notice", steps: []string{"start", "notice-bound", "notice-taken"},
		pre: func(s *stopLive, id string) { s.life.QueueNotice(s.ctx, id, "NOTICE-TEXT", false) },
		left: func(s *stopLive, id string) bool {
			s.life.mu.Lock()
			defer s.life.mu.Unlock()
			return len(s.life.notices[id]) > 0
		},
		run: func(s *stopLive, id string, intrude func()) string {
			intrude()
			return s.life.SessionNotice(s.ctx, id, "ses_"+id)
		}},
	{name: "notes", steps: []string{"start", "notes-bound", "notes-take"},
		pre: func(s *stopLive, id string) { s.life.ownerOf(id).setNotesRoute("keep") },
		left: func(s *stopLive, id string) bool {
			o := s.life.ownerOf(id)
			o.mu.Lock()
			defer o.mu.Unlock()
			return o.notes.text != ""
		},
		run: func(s *stopLive, id string, intrude func()) string {
			intrude()
			return s.life.SessionCompactInstructions(s.ctx, id, "ses_"+id)
		}},
	// notesbound are instructions a compaction set (bound to its session and generation).
	{name: "notesbound", steps: []string{"start", "notes-bound", "notes-take"},
		pre: func(s *stopLive, id string) {
			sid, gen := "ses_"+id, s.life.ownerOf(id).now()
			if !s.life.ownerOf(id).setNotes(s.life.turnBinding(s.ctx, id, sid, gen), "keep") {
				s.t.Fatal("the instructions were not set")
			}
		},
		left: func(s *stopLive, id string) bool {
			o := s.life.ownerOf(id)
			o.mu.Lock()
			defer o.mu.Unlock()
			return o.notes.text != ""
		},
		run: func(s *stopLive, id string, intrude func()) string {
			intrude()
			return s.life.SessionCompactInstructions(s.ctx, id, "ses_"+id)
		}},
}

func TestOpenCodePluginModel(t *testing.T) {
	intruders := map[string]bool{}
	for _, in := range ocIntruders {
		switch in.name {
		case "stop", "newsession", "samesession", "stopping", "launching":
			intruders[in.name] = true
		}
	}
	for _, actor := range plugActors {
		for _, step := range actor.steps {
			for _, in := range ocIntruders {
				if !intruders[in.name] {
					continue
				}
				// A step inside the owner's lock can only be intruded on by a row write.
				if in.ownerOnly && step == "notes-take" {
					continue
				}
				t.Run(actor.name+"/"+step+"/"+in.name, func(t *testing.T) { plugRun(t, actor, step, in) })
			}
		}
	}
}

func plugRun(t *testing.T, actor plugActor, step string, in ocIntruder) {
	id := "atp1"
	s, _ := newJobLive(t, id)
	ocSeed(s, id)
	s.live.set(id, db.Field{Col: "activity", Val: "working"})
	actor.pre(s, id)
	marksBefore := plugMarks(s, id)
	fired := false
	intrude := func() {
		if fired {
			return
		}
		fired = true
		in.apply(s, id, 2, step == "notes-take")
	}
	run := intrude
	if step != "start" {
		run = func() {}
		s.life.turnStep = func(aid, at string) {
			if at == step && aid == id {
				intrude()
			}
		}
	}
	text := actor.run(s, id, run)
	s.life.turnStep = nil
	if !fired {
		t.Fatalf("the ask never reached %s", step)
	}
	// An ask that began before the agent moved is refused. One that began after it is the current launch's, except for
	// instructions a compaction of the old binding set.
	served := false
	switch {
	case step == "notes-take" && strings.HasPrefix(actor.name, "notes") && in.name == "samesession":
		// A row write that moves the owner's generation is a launch, and a launch takes it first; the row alone (the intruder
		// has only that inside the lock) leaves the take as it was.
		served = true
	case step != "start":
		served = false
	case in.name == "stop" || in.name == "newsession" || in.name == "launching":
		served = false
	case actor.name == "notesbound":
		served = false
	default:
		served = true
	}
	switch {
	case served:
		if text == "" {
			t.Errorf("an ask made after the agent moved was refused")
		}
	case actor.name == "notice" && step == "notice-taken":
		// The take was made while the binding held: its text is returned, but nothing is marked delivered once it lapsed.
		if text == "" {
			t.Errorf("the notice taken while bound was not returned")
		}
		if got := plugMarks(s, id); got != marksBefore {
			t.Errorf("a notice returned to a stale session was marked delivered: %s -> %s", marksBefore, got)
		}
	default:
		if text != "" {
			t.Errorf("a stale ask got %q", text)
		}
		if !actor.left(s, id) {
			t.Error("a refused ask took what it was not given")
		}
		if got := plugMarks(s, id); got != marksBefore {
			t.Errorf("a refused ask marked delivered: %s -> %s", marksBefore, got)
		}
	}
	if served && actor.left(s, id) {
		t.Error("an ask served left what it took")
	}
	if served && strings.HasPrefix(actor.name, "notice") {
		if got := plugMarks(s, id); got == marksBefore {
			t.Error("a notice returned was not marked delivered")
		}
	}
}

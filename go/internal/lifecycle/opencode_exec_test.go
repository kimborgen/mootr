package lifecycle

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"stam/internal/db"
)

// quietPushes keeps the turn end's mail push (a debounce timer) out of the test's lifetime: a push that fired while the
// test waits on the lifecycle's goroutines (bg.Wait) would add to them as the wait runs.
func quietPushes(s *stopLive) { s.life.debounce = time.Hour }

// pushScheduled is whether a mail push is scheduled for the agent (SchedulePush); quietPushes keeps it from firing.
func (s *stopLive) pushScheduled(id string) bool {
	s.life.mu.Lock()
	defer s.life.mu.Unlock()
	return s.life.pushTimers[id] != nil
}

// creditPolled is whether a credit poll has started (PollCredits records its start).
func (s *stopLive) creditPolled() bool {
	s.life.mu.Lock()
	defer s.life.mu.Unlock()
	return !s.life.credits.lastPoll.IsZero()
}

// openRouterAgent makes the agent an OpenRouter one, with a key and an OpenRouter that answers nothing, so a turn's end
// polls the credits (PollCreditsAfterTurn) and the poll's start is recorded.
func openRouterAgent(t *testing.T, s *stopLive, id string) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) }))
	t.Cleanup(srv.Close)
	t.Setenv("STAM_OPENROUTER_URL", srv.URL+"/api/v1")
	s.writeKey("test-key")
	s.exec("UPDATE agents SET model = 'openrouter/x' WHERE id = '" + id + "'")
}

// An execution's end read after a launch landed, of an execution that started before it (the old run of a resumed
// session, which keeps its id), ends nothing of the new launch's turn (S-4299): no idle, no turn-end event, no usage,
// no pending action, no mail push, no credit poll. The new launch's own execution, started after it settled, ends its
// turn as before.
func TestOpenCodeEndOfAnEarlierLaunch(t *testing.T) {
	for _, c := range []struct {
		name   string
		before func(s *stopLive, id string)
	}{
		// Started under the generation before the launch, seen on the stream.
		{"seen starting", func(s *stopLive, id string) { s.event(execution("started", "ses_"+id)) }},
		// The stream reconnected before the launch: its credit is of the generation it was given under.
		{"credited at a reconnect", func(s *stopLive, id string) { s.life.onOpenCodeConnect(); s.seeded() }},
		// A fresh owner (a daemon restart): its credit is of generation 0.
		{"credited at a restart", func(s *stopLive, id string) {}},
	} {
		t.Run(c.name, func(t *testing.T) {
			id := "aex1"
			sid := "ses_" + id
			s, _ := idleAgent(t, id)
			quietPushes(s)
			openRouterAgent(t, s, id)
			s.set(func(s *stopLive) {
				s.sessions[sid] = sessionOf(2, 100, 40, 10, 500, 60)
				s.messages[sid] = messageOf(120, 700)
			})
			c.before(s, id)
			// A resume lands: its generation, its start on the row, settled. The row runs the same session.
			gen := s.life.nextLaunchGen(id)
			s.live.set(id, db.Field{Col: "resumed_at", Val: ocStamp(9)}, db.Field{Col: "activity", Val: "working"},
				db.Field{Col: "pending_action", Val: ocPendingText})
			s.life.ownerOf(id).settleLaunch(gen, true)
			s.event(execution("succeeded", sid))
			s.life.bg.Wait()
			s.reportsDone()
			s.wantActivity(id, "working")
			if n := s.countEvents(id, "opencode:session.execution.succeeded"); n != 0 {
				t.Errorf("%d turn-end events for an earlier launch's execution", n)
			}
			if got := s.usageOf(id); got != s.usageEmpty() {
				t.Errorf("an earlier launch's execution reported usage: %s", got)
			}
			if got := s.compactsOf(); len(got) != 0 || s.agent(id).PendingAction == nil {
				t.Errorf("an earlier launch's execution ran the pending compaction: %v", got)
			}
			if s.pushScheduled(id) {
				t.Error("an earlier launch's execution scheduled a mail push")
			}
			if s.creditPolled() {
				t.Error("an earlier launch's execution polled the credits")
			}
			// The new launch's own execution: started after it settled, its end is the turn's.
			s.live.set(id, db.Field{Col: "pending_action", Val: nil})
			s.event(execution("started", sid))
			s.event(execution("succeeded", sid))
			s.life.bg.Wait()
			s.reportsDone()
			s.wantActivity(id, "idle")
			if n := s.countEvents(id, "opencode:session.execution.succeeded"); n != 1 {
				t.Errorf("%d turn-end events for the launch's own execution", n)
			}
			if got := s.usageOf(id); got == s.usageEmpty() {
				t.Error("the launch's own execution reported no usage")
			}
			if !s.pushScheduled(id) {
				t.Error("the launch's own execution scheduled no mail push")
			}
			if !s.creditPolled() {
				t.Error("the launch's own execution polled no credits")
			}
		})
	}
}

// The first end after a daemon restart (a fresh owner) or a reconnect, of an execution whose start the stream never
// showed, is the turn's end: a real end is not dropped for want of its start.
func TestOpenCodeEndWithItsStartUnseen(t *testing.T) {
	for _, reconnect := range []bool{false, true} {
		id := "aex2"
		s, _ := idleAgent(t, id)
		quietPushes(s)
		s.live.set(id, db.Field{Col: "activity", Val: "working"})
		if reconnect {
			// A launch lands, so nothing from before it binds; its execution's start went by while the stream was down,
			// and the reconnect credits it.
			s.life.ownerOf(id).settleLaunch(s.life.nextLaunchGen(id), true)
			s.life.onOpenCodeConnect()
			s.seeded()
		}
		s.event(execution("succeeded", "ses_"+id))
		s.life.bg.Wait()
		s.reportsDone()
		s.wantActivity(id, "idle")
	}
}

// The server's compaction ends with an execution's end and no execution start of its own: its compaction start is the
// start, so its end is the turn's, after a launch as well.
func TestOpenCodeCompactionEndsItsTurn(t *testing.T) {
	id := "aex3"
	sid := "ses_" + id
	s, _ := idleAgent(t, id)
	quietPushes(s)
	s.life.ownerOf(id).settleLaunch(s.life.nextLaunchGen(id), true)
	s.event(`{"type":"session.compaction.started","data":{"sessionID":"` + sid + `"}}`)
	s.wantActivity(id, "working")
	s.event(execution("succeeded", sid))
	s.life.bg.Wait()
	s.reportsDone()
	s.wantActivity(id, "idle")
}

// A compaction inside an execution, in one generation and session: the execution's start, the compaction's start, the
// compaction's end, then the execution's end. Each end is the turn's (owner.endExec keeps a session's mark), so the
// execution's own end leaves the agent idle, not working.
func TestOpenCodeCompactionInsideAnExecution(t *testing.T) {
	id := "aex4"
	sid := "ses_" + id
	s, _ := idleAgent(t, id)
	quietPushes(s)
	s.life.ownerOf(id).settleLaunch(s.life.nextLaunchGen(id), true)
	s.event(execution("started", sid))
	s.event(`{"type":"session.compaction.started","data":{"sessionID":"` + sid + `"}}`)
	s.event(execution("succeeded", sid))
	s.event(`{"type":"session.tool.called","data":{"sessionID":"` + sid + `"}}`)
	s.wantActivity(id, "working")
	s.event(execution("succeeded", sid))
	s.life.bg.Wait()
	s.reportsDone()
	s.wantActivity(id, "idle")
	if n := s.countEvents(id, "opencode:session.execution.succeeded"); n != 2 {
		t.Errorf("%d turn-end events for the compaction's end and the execution's", n)
	}
}

// A start refused (a launch in flight owns the agent, so it is of the session the launch replaces) writes nothing: no
// working state and no event, which no end would clear.
func TestOpenCodeRefusedStartWritesNothing(t *testing.T) {
	for _, typ := range []string{"session.execution.started", "session.compaction.started"} {
		t.Run(typ, func(t *testing.T) {
			id := "aex5"
			sid := "ses_" + id
			s, _ := idleAgent(t, id)
			quietPushes(s)
			gen := s.life.nextLaunchGen(id)
			defer s.life.ownerOf(id).settleLaunch(gen, false)
			s.event(`{"type":"` + typ + `","data":{"sessionID":"` + sid + `"}}`)
			s.wantActivity(id, "idle")
			if n := s.countEvents(id, "opencode:"+typ); n != 0 {
				t.Errorf("%d events for a refused start", n)
			}
		})
	}
}

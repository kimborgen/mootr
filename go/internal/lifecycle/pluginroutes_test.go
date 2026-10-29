package lifecycle

import (
	"context"
	"strings"
	"sync"
	"testing"

	"stam/internal/db"
)

// The plugin's notice and the Claude hook take from one queue: a notice is delivered to exactly one of them, however
// they interleave, and an answer's row goes with the text the plugin gets.
func TestSessionNoticeSharesTheHookQueue(t *testing.T) {
	id := "atn1"
	s, _ := idleAgent(t, id)
	sid := "ses_" + id
	s.life.QueueNotice(s.ctx, id, "N1", false)
	if got := s.life.SessionNotice(s.ctx, id, sid); got != "N1" {
		t.Fatalf("plugin notice %q", got)
	}
	if got := s.life.InTurnNotice(s.ctx, id); got != "" {
		t.Errorf("the hook got the notice the plugin took: %q", got)
	}
	if got := s.life.SessionNotice(s.ctx, id, sid); got != "" {
		t.Errorf("a second ask got %q", got)
	}
	if got := plugMarks(s, id); got != "1" {
		t.Errorf("marks %s", got)
	}

	// Both ask at once, many times: each notice reaches one of them.
	for i := 0; i < 50; i++ {
		s.life.QueueNotice(s.ctx, id, "R", false)
		var wg sync.WaitGroup
		got := make([]string, 2)
		wg.Add(2)
		go func() { defer wg.Done(); got[0] = s.life.SessionNotice(s.ctx, id, sid) }()
		go func() { defer wg.Done(); got[1] = s.life.InTurnNotice(s.ctx, id) }()
		wg.Wait()
		if n := strings.Count(got[0]+got[1], "R"); n != 1 {
			t.Fatalf("round %d: the notice was delivered %d times: %q", i, n, got)
		}
	}
}

// An answer's notice is stored with a row until its client acknowledges it. The plugin gives up after two seconds and
// swallows errors, so the text it was sent is no receipt: the row stays, and a restart that finds it unread replays the
// notice. A stale ask (a generation moved) takes neither the notice nor the row.
func TestSessionNoticeAnswerRow(t *testing.T) {
	id := "atn2"
	s, _ := idleAgent(t, id)
	// A working agent: an idle one is pushed the notice as a prompt at once.
	s.live.set(id, db.Field{Col: "activity", Val: "working"})
	rows := func() string { return s.query("SELECT count(*) FROM answer_notices WHERE agent_id = ?", id) }
	s.life.QueueAnswerNotice(s.ctx, id, "ANSWER")
	if rows() != "1" {
		t.Fatalf("answer rows %s", rows())
	}
	// A stale ask: the agent's generation moved before it.
	s.life.turnStep = func(aid, at string) {
		if at == "notice-bound" {
			s.life.turnStep = nil
			s.life.invalidate(id)
		}
	}
	if got := s.life.SessionNotice(s.ctx, id, "ses_"+id); got != "" {
		t.Fatalf("a stale ask got %q", got)
	}
	if rows() != "1" {
		t.Errorf("a stale ask took the answer's row: %s", rows())
	}
	// The plugin's response is lost (its timeout, a disconnect): the text was handed over, the row is still there.
	if got := s.life.SessionNotice(s.ctx, id, "ses_"+id); got != "ANSWER" {
		t.Fatalf("plugin notice %q", got)
	}
	if rows() != "1" {
		t.Errorf("the answer's row went with a response nobody acknowledged: %s", rows())
	}
	// A restart: the queue is in memory and gone, the row is restored and delivered again.
	s.life.mu.Lock()
	delete(s.life.notices, id)
	delete(s.life.unconfirmed, id)
	s.life.mu.Unlock()
	if err := s.life.RestoreAnswerNotices(s.ctx); err != nil {
		t.Fatal(err)
	}
	if got := s.life.SessionNotice(s.ctx, id, "ses_"+id); got != "ANSWER" {
		t.Errorf("after a restart: %q", got)
	}
	// The Claude hook's acknowledgement is what removes it.
	s.life.mu.Lock()
	held := append([]int64(nil), s.life.unconfirmed[id]...)
	s.life.mu.Unlock()
	for _, r := range held {
		s.life.AckNotice(s.ctx, id, r)
	}
	if rows() != "0" {
		t.Errorf("an acknowledged row stays: %s", rows())
	}
}

// Another session's plugin, an empty one and one for an agent that does not run the session get nothing, and take nothing.
func TestSessionNoticeOtherSession(t *testing.T) {
	id := "atn3"
	s, _ := idleAgent(t, id)
	s.life.QueueNotice(s.ctx, id, "N", false)
	for _, sid := range []string{"", "ses_other", "ses_" + id + "x"} {
		if got := s.life.SessionNotice(s.ctx, id, sid); got != "" {
			t.Errorf("session %q got %q", sid, got)
		}
	}
	if got := s.life.SessionCompactInstructions(s.ctx, id, "ses_other"); got != "" {
		t.Errorf("instructions %q", got)
	}
	if got := s.life.SessionNotice(s.ctx, id, "ses_"+id); got != "N" {
		t.Errorf("the notice was lost: %q", got)
	}
}

// Compaction instructions are taken once, and by the session that runs.
func TestSessionCompactInstructionsOnce(t *testing.T) {
	id := "atn4"
	s, _ := idleAgent(t, id)
	s.life.SetCompactInstructions(id, "keep the plan")
	if got := s.life.SessionCompactInstructions(s.ctx, id, "ses_other"); got != "" {
		t.Errorf("another session took %q", got)
	}
	if got := s.life.SessionCompactInstructions(s.ctx, id, "ses_"+id); got != "keep the plan" {
		t.Errorf("first take %q", got)
	}
	if got := s.life.SessionCompactInstructions(s.ctx, id, "ses_"+id); got != "" {
		t.Errorf("second take %q", got)
	}
}

// The instructions a compaction set are read by the plugin after the request that asked for the compaction is over: its
// binding is not asked again with that request's context.
func TestSessionCompactInstructionsAfterRequest(t *testing.T) {
	id := "atn5"
	s, a := idleAgent(t, id)
	ctx, cancel := context.WithCancel(s.ctx)
	if _, err := s.life.RequestCompaction(ctx, a, "keep the plan", "test"); err != nil {
		t.Fatal(err)
	}
	cancel()
	if got := s.life.SessionCompactInstructions(s.ctx, id, "ses_"+id); got != "keep the plan" {
		t.Errorf("instructions %q", got)
	}
}

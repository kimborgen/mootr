package lifecycle

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"stam/internal/db"
)

// What a daemon restart keeps (S-3774): a first prompt a restart cut off before it went in, and the deadline of an agent
// stuck starting. Both live in the database, so a new Lifecycle over it, as a restarted daemon makes, acts on them.

// starting makes an agent row left starting by a daemon that stopped mid-spawn: no session, the prompt stored, and the
// given first-prompt markers. A session id makes it resumable, as a spawn's is.
func (l *live) starting(id, prompt string, session bool, markers ...string) {
	l.t.Helper()
	in := db.NewAgent{ID: id, Name: "n-" + id, Role: "developer", Machine: "test-machine", Harness: "claude", Cwd: l.work}
	if session {
		s := "11111111-2222-4333-8444-" + strings.Repeat("6", 12)
		in.SessionID = &s
	}
	if _, err := l.db.CreateAgent(l.ctx, in); err != nil {
		l.t.Fatal(err)
	}
	fields := []db.Field{{Col: "workspace", Val: `{"spec":{"kind":"dir","path":"` + l.work + `"},"cwd":"` + l.work + `"}`},
		{Col: "permission_mode", Val: "auto"}, {Col: "activity", Val: "starting"}, {Col: "activity_detail", Val: "with prompt"}}
	if prompt != "" {
		fields = append(fields, db.Field{Col: "first_prompt", Val: prompt})
	}
	if err := l.db.UpdateAgent(l.ctx, id, fields...); err != nil {
		l.t.Fatal(err)
	}
	for _, m := range markers {
		if err := l.db.AddEvent(l.ctx, id, m, nil); err != nil {
			l.t.Fatal(err)
		}
	}
}

// typed is every prompt the fake Claude Code took, in order.
func (l *live) typed() []string {
	b, _ := os.ReadFile(filepath.Join(l.base, "typed"))
	if strings.TrimSpace(string(b)) == "" {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

// TestRestartRecoversFirstPrompt: after a restart, the first reconcile pass of a new Lifecycle on the same database types
// a first prompt that was stored and marked pending but never delivered, once. A launch marked delivered is never typed
// into again, by that pass or by a later restart's, and a row from before the markers is left alone.
func TestRestartRecoversFirstPrompt(t *testing.T) {
	l := newLive(t)
	l.spawn("anchor") // the tmux server the agents ran on, still up after the restart
	l.starting("rlost", "recover the lost prompt", true, "first-prompt:pending")
	l.starting("rdone", "already delivered", true, "first-prompt:pending", "first-prompt:delivered")
	l.starting("rold", "spawned before the markers", false)
	before := len(l.typed())

	restarted := New(l.ctx, l.opts)
	t.Cleanup(func() { l.stop(); restarted.Wait() })
	l.prime(restarted)
	l.reconcile(restarted)
	l.until("the stored prompt to be typed", func() bool {
		return len(l.events("rlost", "first-prompt:awaiting-hook")) > 0
	})
	restarted.firstPromptHook("rlost", "recover the lost prompt")
	l.until("the recovered prompt to be marked delivered", func() bool { return len(l.events("rlost", "first-prompt:delivered")) > 0 })
	got := l.typed()[before:]
	if len(got) != 1 || got[0] != `"recover the lost prompt"` {
		t.Fatalf("typed after the restart: %q", got)
	}
	if n := len(l.events("rlost", "first-prompt:recover")); n != 1 {
		t.Errorf("rlost recovered %d times", n)
	}
	for _, id := range []string{"rdone", "rold"} {
		if n := len(l.events(id, "first-prompt:recover")); n != 0 {
			t.Errorf("%s was recovered", id)
		}
	}

	// Another restart: the prompt is marked delivered now, so it isn't typed again.
	l.setActivity("rlost", "starting", "with prompt")
	again := New(l.ctx, l.opts)
	t.Cleanup(again.Wait)
	l.prime(again)
	l.reconcile(again)
	again.Wait()
	if n := len(l.events("rlost", "first-prompt:recover")); n != 1 {
		t.Errorf("a second restart recovered rlost again: %d", n)
	}
	if got := l.typed()[before:]; len(got) != 1 {
		t.Errorf("a second restart typed again: %q", got)
	}
}

// TestRestartKeepsStartingDeadline: the starting deadline counts from the agent's creation, stored in the database, so
// a new Lifecycle marks an agent dead that went past it while the daemon was down, and leaves one under it starting.
func TestRestartKeepsStartingDeadline(t *testing.T) {
	l := newLive(t)
	l.setSettings(`{"startingTimeoutMinutes": 10}`)
	l.spawn("anchor")
	l.starting("sold", "", false)
	l.starting("snew", "", false)
	l.exec("UPDATE agents SET created_at = ? WHERE id = 'sold'", time.Now().Add(-20*time.Minute).UTC().Format("2006-01-02T15:04:05.000Z"))
	l.exec("UPDATE agents SET created_at = ? WHERE id = 'snew'", time.Now().Add(-90*time.Second).UTC().Format("2006-01-02T15:04:05.000Z"))

	restarted := New(l.ctx, l.opts)
	t.Cleanup(func() { l.stop(); restarted.Wait() })
	l.prime(restarted)
	l.reconcile(restarted)
	if a := l.agent("sold"); a.Lifecycle != "shut_down" || detailOf(a) != "never started: no harness process" || len(l.events("sold", "starting:dead")) != 1 {
		t.Errorf("sold past its deadline: %s %q", a.Lifecycle, detailOf(a))
	}
	if a := l.agent("snew"); a.Lifecycle != "active" || a.Activity != "starting" || len(l.events("snew", "starting:dead")) != 0 {
		t.Errorf("snew under its deadline: %s %s", a.Lifecycle, a.Activity)
	}
}

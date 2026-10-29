package lifecycle

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// TestCompactPrompt (S-4304): a compaction's own prompt wins; the reasons that interrupt work get the continue
// prompt; an idle compaction gets none.
func TestCompactPrompt(t *testing.T) {
	for _, c := range []struct{ reason, prompt, want string }{
		{"requested by the agent", "", compactContinuePrompt},
		{"enforcement threshold", "", compactContinuePrompt},
		{"enforcement threshold", "own", "own"},
		{"requested", "", ""},
		{"idle for 5m", "", ""},
		{"shut down", "", ""},
	} {
		p := jsjson.NewObject("type", "compact", "reason", c.reason)
		if c.prompt != "" {
			p.Set("prompt", c.prompt)
		}
		if got := compactPrompt(p); got != c.want {
			t.Errorf("%q with prompt %q: %q, want %q", c.reason, c.prompt, got, c.want)
		}
	}
}

// TestOpenCodeCompactContinue (S-4304): an OpenCode compaction that cut into work ends with the continue prompt in its
// session, an idle one with none.
func TestOpenCodeCompactContinue(t *testing.T) {
	s, a := idleAgent(t, "acc1")
	if _, err := s.life.requestCompaction(s.ctx, a, "", "", "requested by the agent"); err != nil {
		t.Fatal(err)
	}
	if got := s.promptsOf(); len(got) != 1 || got[0] != "ses_acc1 "+compactContinuePrompt {
		t.Errorf("prompts %v", got)
	}
	s2, b := idleAgent(t, "acc2")
	if _, err := s2.life.requestCompaction(s2.ctx, b, "", "", "idle for 5m"); err != nil {
		t.Fatal(err)
	}
	if got := s2.promptsOf(); len(got) != 0 {
		t.Errorf("an idle compaction sent %v", got)
	}
}

// TestCompactPromptHeldAtStart (S-4304): a compaction's launch held at its first check keeps its prompt as an idle-only
// notice, once; another kind's prompt is dropped.
func TestCompactPromptHeldAtStart(t *testing.T) {
	l := newLive(t)
	l.spawn("acp1")
	l.idle("acp1")
	l.addBlocker("acp1", "window", "claude-max", "five_hour at 100%")
	if err := l.life.StartHarness(l.ctx, l.agent("acp1"), "continue it", true, "compact"); err != nil {
		t.Fatal(err)
	}
	if n := l.life.Notices("acp1"); len(n) != 1 || n[0] != "continue it" {
		t.Errorf("notices %v", n)
	}
	if e := lastEvent(t, l, "acp1", "spawn"); !strings.Contains(e, `"prompt":false`) && !strings.Contains(e, `"prompt":false}`) {
		t.Errorf("the held launch typed the prompt: %s", e)
	}
	l.spawn("acp2")
	l.idle("acp2")
	l.addBlocker("acp2", "window", "claude-max", "five_hour at 100%")
	if err := l.life.StartHarness(l.ctx, l.agent("acp2"), "other", true, "resume"); err != nil {
		t.Fatal(err)
	}
	if n := l.life.Notices("acp2"); len(n) != 0 {
		t.Errorf("a resume's prompt was kept: %v", n)
	}
}

// TestCompactPromptHeldLate (S-4304): a blocker added after the first check, before the launch's final write, keeps the
// prompt too, and once (the first check did not queue it).
func TestCompactPromptHeldLate(t *testing.T) {
	l := newLive(t)
	session := "11111111-2222-4333-8444-" + strings.Repeat("5", 12)
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "acp3", Name: "n-acp3", Role: "developer", Machine: "test-machine", Harness: "claude",
		Cwd: l.work, SessionID: &session}); err != nil {
		t.Fatal(err)
	}
	l.life.launching = func(id string) {
		if _, err := l.life.AddBlocker(l.ctx, id, NewBlocker{Kind: "window", Account: "claude-max", Reason: "five_hour at 100%"}); err != nil {
			t.Error(err)
		}
	}
	if err := l.life.StartHarness(l.ctx, l.agent("acp3"), "continue it", true, "compact"); err != nil {
		t.Fatal(err)
	}
	l.life.launching = nil
	if n := l.life.Notices("acp3"); len(n) != 1 || n[0] != "continue it" {
		t.Errorf("notices %v", n)
	}
}

// TestGracefulStopMidCompaction (S-4319): a daemon stopped while its compactor runs kills the compactor, records no
// compact:failed (its event can't be written on the stopped context), and so leaves the compaction "interrupted": the
// restarted daemon re-runs it exactly once (two compactor runs in all, the first killed) and resumes the agent.
func TestGracefulStopMidCompaction(t *testing.T) {
	l := newLive(t)
	l.spawn("acg1")
	l.idle("acg1")
	l.flag("hold", true)
	stopCtx, stop := context.WithCancel(l.ctx)
	done := make(chan error, 1)
	go func() {
		_, err := l.life.RequestCompaction(stopCtx, l.agent("acg1"), "", "requested by the agent")
		done <- err
	}()
	l.until("the compactor", func() bool { return l.compactsLen() == 1 })
	stop()
	if err := <-done; err == nil {
		t.Fatal("a stopped compaction reported success")
	}
	if l.has("acg1", "compact:failed") {
		t.Fatal("compact:failed was recorded: the restart would not see an interrupted compaction")
	}
	l.holdNetwork()
	restarted := New(l.ctx, l.opts)
	t.Cleanup(func() { l.releaseNetwork(); l.stop(); restarted.Wait() })
	l.prime(restarted)
	l.reconcile(restarted)
	l.flag("hold", false)
	l.releaseNetwork()
	l.until("the recovery", func() bool { return l.has("acg1", "recover") })
	if e := lastEvent(t, l, "acg1", "recover"); !strings.Contains(e, `"compacted":true`) {
		t.Errorf("recover: %s", e)
	}
	if n := l.compactsLen(); n != 2 {
		t.Errorf("%d compactor runs, want the killed one and one re-run", n)
	}
	if a := l.agent("acg1"); a.Lifecycle != "active" {
		t.Errorf("agent %s", a.Lifecycle)
	}
}

// TestSurvivingCompactorKilledOnRestart (S-4319): a compactor the old daemon left running (killed with SIGKILL, so its
// context never cancelled it) is found by its STAM_COMPACTOR marker and stopped before the recovery compacts again.
func TestSurvivingCompactorKilledOnRestart(t *testing.T) {
	l := newLive(t)
	l.spawn("acg2")
	l.idle("acg2")
	a := l.agent("acg2")
	if a.SessionID == nil || *a.SessionID == "" {
		t.Fatal("no session")
	}
	cmd := exec.Command("sh", "-c", "sleep 300; :", "x", "-p", "--resume", *a.SessionID)
	cmd.Dir = a.Cwd
	cmd.Env = append(os.Environ(), "STAM_COMPACTOR=acg2:op-1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(waited) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-waited })
	if err := l.db.AddEvent(l.ctx, "acg2", "compact", map[string]string{"op": "op-1"}); err != nil {
		t.Fatal(err)
	}
	if err := l.tmux.KillSession(l.ctx, "acg2"); err != nil {
		t.Fatal(err)
	}
	restarted := New(l.ctx, l.opts)
	t.Cleanup(func() { l.stop(); restarted.Wait() })
	l.prime(restarted)
	l.reconcile(restarted)
	l.until("the recovery", func() bool { return l.has("acg2", "recover") })
	if !l.has("acg2", "compact:killed") {
		t.Error("the surviving compactor wasn't reported killed")
	}
	select {
	case <-waited:
	case <-time.After(10 * time.Second):
		t.Error("the surviving compactor still runs")
	}
}

func (l *live) compactsLen() int {
	b, _ := os.ReadFile(filepath.Join(l.base, "compacts"))
	return len(strings.Fields(string(b)))
}

package lifecycle

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"stam/internal/adapters/claude"
	"stam/internal/db"
)

// fakePrompts is a Prompts that hands out fixed parts and records the agents it was asked about and forgot.
type fakePrompts struct {
	mu     sync.Mutex
	parts  claude.Parts
	err    error
	asked  []string
	forgot []string
}

func (f *fakePrompts) LaunchParts(_ context.Context, a db.Agent) (claude.Parts, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked = append(f.asked, a.ID)
	return f.parts, f.err
}

func (f *fakePrompts) ForgetLessons(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forgot = append(f.forgot, id)
}

// TestLaunchPromptParts: a launch asks SetPrompts' hook for the agent's parts and writes each into its system prompt
// and the shared workspaces into its settings; an archive forgets the agent's cached lessons; a hook that fails stops
// the launch before any session starts.
func TestLaunchPromptParts(t *testing.T) {
	l := newLive(t)
	shared := filepath.Join(l.base, "shared")
	fp := &fakePrompts{parts: claude.Parts{Org: "ORG-PART", Cost: "COST-PART", Lessons: "LESSONS-PART", Workspace: "WORKSPACE-PART",
		Itsa: "ITSA-PART", Requirements: "REQUIREMENTS-PART", Granted: []string{shared}}}
	l.life.SetPrompts(fp)
	l.spawn("alp1")
	prompt, err := os.ReadFile(filepath.Join(l.home, "agents", "alp1", "system-prompt.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{"ORG-PART", "COST-PART", "LESSONS-PART", "WORKSPACE-PART", "ITSA-PART", "REQUIREMENTS-PART"} {
		if !strings.Contains(string(prompt), part) {
			t.Errorf("the system prompt lacks %s", part)
		}
	}
	settings, err := os.ReadFile(filepath.Join(l.home, "agents", "alp1", "claude-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(settings), `"`+shared+`"`) {
		t.Errorf("the shared workspace isn't an additional directory: %s", settings)
	}
	// Paused, it archives at once, without the final round.
	l.idle("alp1")
	if _, err := l.life.Pause(l.ctx, l.agent("alp1"), "human"); err != nil {
		t.Fatal(err)
	}
	if _, err := l.life.Archive(l.ctx, l.agent("alp1"), ArchiveOpts{}); err != nil {
		t.Fatal(err)
	}
	fp.mu.Lock()
	asked, forgot := strings.Join(fp.asked, ","), strings.Join(fp.forgot, ",")
	fp.mu.Unlock()
	if asked != "alp1" || forgot != "alp1" {
		t.Errorf("asked %q, forgot %q; want alp1 once each", asked, forgot)
	}

	fp.mu.Lock()
	fp.err = errors.New("the home is gone")
	fp.mu.Unlock()
	session := "11111111-2222-4333-8444-" + strings.Repeat("6", 12)
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "alp2", Name: "n-alp2", Role: "developer", Machine: "test-machine", Harness: "claude",
		Cwd: l.work, SessionID: &session}); err != nil {
		t.Fatal(err)
	}
	if err := l.life.StartHarness(l.ctx, l.agent("alp2"), "", false, "spawn"); err == nil || err.Error() != "the home is gone" {
		t.Errorf("a failing hook: %v", err)
	}
	if l.tmux.HasSession(l.ctx, "alp2") {
		t.Error("a session started without the prompt's parts")
	}
}

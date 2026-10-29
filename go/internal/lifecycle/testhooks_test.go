package lifecycle

import (
	"strings"
	"testing"

	"stam/internal/db"
)

// TestFailLaunch: a named agent's launch fails once its row exists (POST /api/test/launch-fail), starting no session;
// a later call without the name lets it launch.
func TestFailLaunch(t *testing.T) {
	l := newLive(t)
	session := "11111111-2222-4333-8444-" + strings.Repeat("5", 12)
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "alf1", Name: "n-alf1", Role: "developer", Machine: "test-machine", Harness: "claude",
		Cwd: l.work, SessionID: &session}); err != nil {
		t.Fatal(err)
	}
	l.life.SetFailLaunch([]string{"n-alf1"})
	err := l.life.StartHarness(l.ctx, l.agent("alf1"), "", false, "spawn")
	if err == nil || err.Error() != "test: launch of n-alf1 failed" {
		t.Fatalf("launch: %v", err)
	}
	if l.agent("alf1").TokenHash != nil {
		t.Errorf("a failed launch minted a token")
	}
	l.life.SetFailLaunch(nil)
	if err := l.life.StartHarness(l.ctx, l.agent("alf1"), "", false, "spawn"); err != nil {
		t.Fatalf("launch after the names were cleared: %v", err)
	}
}

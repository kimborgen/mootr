package server

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/lifecycle"
	"stam/internal/push"
	"stam/internal/templates"
	"stam/internal/tmux"
)

// restartLife is a daemon start over the fixture's database (S-3923): a lifecycle with nothing in memory, as the daemon
// builds it at startup. It is stopped at the test's end.
func restartLife(t *testing.T, f *fixture) *lifecycle.Lifecycle {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	settings := config.NewSettingsFile(f.home, f.cfg.Machine)
	userHome := t.TempDir()
	// The checkout's templates, as the daemon renders them (the go module sits in the checkout's go/).
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	tpl := &templates.Set{Root: root, Home: f.home, UserHome: userHome, Settings: settings.Get, Machine: f.cfg.Machine}
	life := lifecycle.New(ctx, lifecycle.Options{DB: f.db, Tmux: &tmux.Client{Socket: "stam-test-none", Bin: "/bin/false"},
		Settings: settings, Machine: f.cfg.Machine,
		Claude: claude.Env{Templates: tpl, ClaudeBin: "/bin/false", Home: f.home, UserHome: userHome}, NetworkProbes: []string{"http://127.0.0.1:1/"},
		Streams: push.New(), PushDebounce: time.Hour})
	t.Cleanup(func() { cancel(); life.Wait() })
	return life
}

// TestAnswerNoticeRestartThroughAPI (S-3923): a parent's denial through the answer route writes the child's notice with
// the answer. A daemon start over the same database hands the child the notice once; the next hook confirms it, and the
// start after that hands it nothing.
func TestAnswerNoticeRestartThroughAPI(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id IN ('aboss', 'achild')")
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'aboss'", auth.Hash(parentTok))
	f.sql("UPDATE agents SET activity = 'working' WHERE id = 'achild'")
	f.srv.life = restartLife(t, f)

	id := f.ask(`{"action":"git push","reason":"ship it","audience":"delegate"}`)
	if code, body := f.answerAs(parentTok, nil, id, `{"by":"aboss","decision":"deny","note":"use the staging branch"}`); code != 200 {
		t.Fatalf("answer: %d %s", code, body)
	}

	// The daemon stops before the child takes the notice: a new start hands it over.
	first := restartLife(t, f)
	if err := first.RestoreAnswerNotices(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, rows := first.InTurnTake(context.Background(), "achild")
	if !strings.Contains(got, "use the staging branch") || len(rows) != 1 {
		t.Fatalf("after the restart the child is handed %q with rows %v, not the denial", got, rows)
	}
	// The client acknowledges the row through the real route, on the daemon that handed it; the start after it hands nothing.
	f.srv.life = first
	if rec := f.sendH("POST", fmt.Sprintf("/api/notices/achild/ack/%d", rows[0]), agentTok, nil, ""); rec.Code != 200 {
		t.Fatalf("ack: %d %s", rec.Code, rec.Body.String())
	}
	second := restartLife(t, f)
	if err := second.RestoreAnswerNotices(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The seeded mail the child also has may come back; the denial must not.
	if got := second.InTurnNotice(context.Background(), "achild"); strings.Contains(got, "use the staging branch") {
		t.Fatalf("a confirmed handoff came back after a restart: %q", got)
	}
}

// TestAnswerNoticeAckOnlySelf (S-3923): an agent acks only its own answer rows. The parent's token can't ack the child's
// row, so the row survives, and the next start still hands the child the denial.
func TestAnswerNoticeAckOnlySelf(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id IN ('aboss', 'achild')")
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'aboss'", auth.Hash(parentTok))
	f.sql("UPDATE agents SET activity = 'working' WHERE id = 'achild'")
	f.srv.life = restartLife(t, f)

	id := f.ask(`{"action":"git push","reason":"ship it","audience":"delegate"}`)
	if code, body := f.answerAs(parentTok, nil, id, `{"by":"aboss","decision":"deny","note":"use the staging branch"}`); code != 200 {
		t.Fatalf("answer: %d %s", code, body)
	}
	first := restartLife(t, f)
	if err := first.RestoreAnswerNotices(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, rows := first.InTurnTake(context.Background(), "achild")
	if len(rows) != 1 {
		t.Fatalf("the child's take carried rows %v, want one", rows)
	}
	f.srv.life = first
	if rec := f.sendH("POST", fmt.Sprintf("/api/notices/achild/ack/%d", rows[0]), parentTok, nil, ""); rec.Code == 200 {
		t.Fatalf("the parent acked the child's row: %d %s", rec.Code, rec.Body.String())
	}
	// The row was not acked, so a restart hands the child the denial again.
	second := restartLife(t, f)
	if err := second.RestoreAnswerNotices(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := second.InTurnNotice(context.Background(), "achild"); !strings.Contains(got, "use the staging branch") {
		t.Fatalf("after a refused ack the restart hands the child %q, not the denial", got)
	}
}

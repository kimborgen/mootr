package lifecycle

import (
	"strings"
	"testing"
	"time"

	"stam/internal/db"
)

// restarted is a daemon start over the same database: a Lifecycle with nothing in memory. Its push timer waits an hour, so
// no push runs during the test (the agent is working in any case).
func restarted(l *live) *Lifecycle {
	return &Lifecycle{db: l.db, debounce: time.Hour}
}

// TestAnswerNoticeRestart (S-3923): an answer's notice is stored when it is queued, so a restart before the agent takes
// it delivers it once, and a take before a restart leaves nothing to deliver again.
func TestAnswerNoticeRestart(t *testing.T) {
	l := newLive(t)
	l.waiter("anr1")
	l.set("anr1", db.Field{Col: "activity", Val: "working"})
	// The server's answer path queues the answer's notice through QueueAnswerNotice.
	l.life.QueueAnswerNotice(l.ctx, "anr1", "The human denied Run npm test: use the staging database.")

	first := restarted(l)
	if err := first.RestoreAnswerNotices(l.ctx); err != nil {
		t.Fatal(err)
	}
	got, rows := first.InTurnTake(l.ctx, "anr1")
	if !strings.Contains(got, "use the staging database") {
		t.Fatalf("after the restart the agent is handed %q, not the answer", got)
	}
	// The client printed the response, so it acknowledges the rows: the next start has nothing to hand over.
	for _, row := range rows {
		first.AckNotice(l.ctx, "anr1", row)
	}
	second := restarted(l)
	if err := second.RestoreAnswerNotices(l.ctx); err != nil {
		t.Fatal(err)
	}
	if got := second.InTurnNotice(l.ctx, "anr1"); strings.Contains(got, "use the staging database") {
		t.Fatalf("an acknowledged notice came back after a restart: %q", got)
	}
}

// TestAnswerNoticeArchivedDropped (S-3923): a row for an archived agent goes at the restart; a resting agent keeps its row.
func TestAnswerNoticeArchivedDropped(t *testing.T) {
	l := newLive(t)
	l.waiter("anr2")
	l.waiter("anr3")
	l.set("anr2", db.Field{Col: "activity", Val: "working"}, db.Field{Col: "lifecycle", Val: "archived"})
	l.set("anr3", db.Field{Col: "activity", Val: "working"}, db.Field{Col: "lifecycle", Val: "paused"})
	l.life.QueueAnswerNotice(l.ctx, "anr2", "archived agent's answer")
	l.life.QueueAnswerNotice(l.ctx, "anr3", "resting agent's answer")

	r := restarted(l)
	if err := r.RestoreAnswerNotices(l.ctx); err != nil {
		t.Fatal(err)
	}
	rows, err := l.db.AnswerNotices(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].AgentID != "anr3" {
		t.Fatalf("rows after the restart: %+v, want only the resting agent's", rows)
	}
	if got := r.InTurnNotice(l.ctx, "anr2"); got != "" {
		t.Fatalf("the archived agent was handed %q", got)
	}
}

// TestAnswerNoticeReplayedUnconfirmed (S-3923): a handoff that the agent's next hook never confirmed is handed again
// after a restart, so it is never lost.
func TestAnswerNoticeReplayedUnconfirmed(t *testing.T) {
	l := newLive(t)
	l.waiter("anr4")
	l.set("anr4", db.Field{Col: "activity", Val: "working"})
	l.life.QueueAnswerNotice(l.ctx, "anr4", "The human denied Run make: skip it.")
	first := restarted(l)
	if err := first.RestoreAnswerNotices(l.ctx); err != nil {
		t.Fatal(err)
	}
	if got := first.InTurnNotice(l.ctx, "anr4"); !strings.Contains(got, "skip it") {
		t.Fatalf("the handoff gave %q", got)
	}
	// No confirmation: the next start hands the same notice again.
	second := restarted(l)
	if err := second.RestoreAnswerNotices(l.ctx); err != nil {
		t.Fatal(err)
	}
	if got := second.InTurnNotice(l.ctx, "anr4"); !strings.Contains(got, "skip it") {
		t.Fatalf("an unconfirmed handoff was not replayed: %q", got)
	}
}

// TestForgetAgentNotices (S-3923): an archived agent's queued notices and rows go at once, without a restart.
func TestForgetAgentNotices(t *testing.T) {
	l := newLive(t)
	l.waiter("anr5")
	l.set("anr5", db.Field{Col: "activity", Val: "working"})
	l.life.QueueAnswerNotice(l.ctx, "anr5", "a denial about to be forgotten")
	l.life.ForgetAgentNotices(l.ctx, "anr5")
	rows, err := l.db.AnswerNotices(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.AgentID == "anr5" {
			t.Fatalf("a row survived the forget: %+v", r)
		}
	}
	if got := l.life.Notices("anr5"); len(got) != 0 {
		t.Fatalf("queued notices survived the forget: %q", got)
	}
}

// TestDraftNoticeStoresNoDraftText (S-3923): a draft's text reaches the agent's notice, and no answer_notices row holds it.
func TestDraftNoticeStoresNoDraftText(t *testing.T) {
	l := newLive(t)
	l.waiter("anr6")
	l.set("anr6", db.Field{Col: "activity", Val: "working"})
	l.life.QueueAnswerNoticeStored(l.ctx, "anr6", "your input box holds `ghp_TOKEN123`", "your input box holds (a draft, not stored)")
	if got := l.life.Notices("anr6"); len(got) != 1 || !strings.Contains(got[0], "ghp_TOKEN123") {
		t.Fatalf("the agent's notice is %q, want the draft's text", got)
	}
	rows, err := l.db.AnswerNotices(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if strings.Contains(r.Text, "ghp_TOKEN123") {
			t.Fatalf("a row holds the draft's text: %q", r.Text)
		}
	}
}

// TestArchiveDropsAnswerNotices (S-4155): the archive itself (archiveLocked) drops the agent's queued notices and answer
// rows, with no restart, so a later start hands the archived agent nothing.
func TestArchiveDropsAnswerNotices(t *testing.T) {
	l := newLive(t)
	l.spawn("anr7")
	l.idle("anr7")
	if _, err := l.life.Pause(l.ctx, l.agent("anr7"), "human"); err != nil {
		t.Fatal(err)
	}
	l.life.QueueAnswerNotice(l.ctx, "anr7", "The human denied Run npm run release: not this week.")
	if out, err := l.life.Archive(l.ctx, l.agent("anr7"), ArchiveOpts{}); err != nil || out != "done" {
		t.Fatalf("archive: %q %v", out, err)
	}
	rows, err := l.db.AnswerNotices(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.AgentID == "anr7" {
			t.Fatalf("a row survived the archive: %+v", r)
		}
	}
	if got := l.life.Notices("anr7"); len(got) != 0 {
		t.Fatalf("queued notices survived the archive: %q", got)
	}
	next := restarted(l)
	if err := next.RestoreAnswerNotices(l.ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := next.InTurnTake(l.ctx, "anr7"); strings.Contains(got, "not this week") {
		t.Fatalf("the archived agent was handed %q after a restart", got)
	}
}

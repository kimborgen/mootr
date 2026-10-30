package server

import (
	"context"
	"strings"
	"testing"
)

// rowsLike counts achild's answer_notices rows whose text holds part.
func (f *fixture) rowsLike(part string) int {
	return f.count("SELECT count(*) FROM answer_notices WHERE agent_id = 'achild' AND instr(text, ?) > 0", part)
}

const (
	heldPart  = "End your turn so stam can type it"
	typedPart = "typed into your input as written"
)

// TestInputNoticeAtEachStop (S-4155): the human's approval writes its own notice's row with the move to held, and the
// claim writes the typed notice's row with the move to approved, in place of the approval's. A daemon start over the
// database at each stop (after the approval, after the typing and before the claim, after the claim and before Enter,
// after Enter and before the notice is queued) hands the agent exactly one notice, and an approval claimed before the
// stop is never typed again.
func TestInputNoticeAtEachStop(t *testing.T) {
	for _, c := range []struct {
		stop, status, part string
	}{
		{"-approved", "held", heldPart},
		{"", "held", heldPart},
		{"-enter", "approved", typedPart},
		{"-typed", "approved", typedPart},
	} {
		t.Run("stop"+c.stop, func(t *testing.T) {
			f, _, tc, barrier := inputFixture(t)
			log := boxPane(f, tc, "achild")
			id := f.suggestID("git status")
			release := f.heldApproval(barrier, c.stop, id, "git status")
			if f.status(id) != c.status || f.count("SELECT count(*) FROM answer_notices WHERE agent_id = 'achild'") != 1 || f.rowsLike(c.part) != 1 {
				t.Fatalf("at the stop: status %s, rows %q", f.status(id), f.count1("SELECT group_concat(text, ' | ') FROM answer_notices WHERE agent_id = 'achild'"))
			}
			next := restartLife(t, f)
			must(t, next.RestoreAnswerNotices(context.Background()))
			got, _ := next.InTurnTake(context.Background(), "achild")
			other := heldPart
			if c.part == heldPart {
				other = typedPart
			}
			if strings.Count(got, c.part) != 1 || strings.Contains(got, other) {
				t.Fatalf("the start after the stop hands %q", got)
			}
			// The first daemon goes on: the line is typed once, and an approval already claimed is never typed again.
			if body := release(); !strings.Contains(body, `"outcome":"typed"`) {
				t.Fatalf("the approval: %s", body)
			}
			eventually(t, "the line submitted", func() bool { return readLog(log) == "git status\n" })
			must(t, f.srv.TypeHeldInput(context.Background(), "achild"))
			f.srv.retryHeldInputs(context.Background())
			if readLog(log) != "git status\n" || f.status(id) != "approved" {
				t.Errorf("after the retries: submitted %q, status %s", readLog(log), f.status(id))
			}
			if f.rowsLike(heldPart) != 0 {
				t.Errorf("the approval's row outlived its outcome")
			}
		})
	}
}

// TestInputNoticeBusyRow (S-4155): a busy agent's approval is held, and the agent is handed the approval's own row: one
// row, which a start before the take delivers once.
func TestInputNoticeBusyRow(t *testing.T) {
	f, n, _, _ := inputFixture(t)
	f.sql("UPDATE agents SET activity = 'working' WHERE id = 'achild'")
	id := f.suggestID("make lint")
	if code, body := f.approveInput(id, "make lint"); code != 200 || !strings.Contains(body, `"outcome":"held","why":"busy"`) {
		t.Fatalf("busy: %d %s", code, body)
	}
	if !hasNotice(n, "achild", heldPart) || f.rowsLike(heldPart) != 1 || f.count("SELECT count(*) FROM answer_notices WHERE agent_id = 'achild'") != 1 {
		t.Fatalf("notices %q, rows %d", n.all(), f.rowsLike(heldPart))
	}
	next := restartLife(t, f)
	must(t, next.RestoreAnswerNotices(context.Background()))
	if got, _ := next.InTurnTake(context.Background(), "achild"); strings.Count(got, heldPart) != 1 {
		t.Fatalf("the start hands %q", got)
	}
	// A second tap is a retry: it tells nothing again.
	if code, body := f.approveInput(id, "make lint"); code != 200 || !strings.Contains(body, `"outcome":"held"`) {
		t.Fatalf("a second tap: %d %s", code, body)
	}
	if f.rowsLike(heldPart) != 1 {
		t.Errorf("a second tap wrote another row: %d", f.rowsLike(heldPart))
	}
}

// TestInputNoticeDraftRow (S-4155, S-3923): a draft that holds the approval reaches the agent through the real draft path,
// and the one row, which replaced the approval's, keeps the notice without the draft.
func TestInputNoticeDraftRow(t *testing.T) {
	f, n, tc, _ := inputFixture(t)
	boxPane(f, tc, "achild", "BOX=export TOKEN=ghp_draft_secret")
	id := f.suggestID("make test")
	if code, body := f.approveInput(id, "make test"); code != 200 || !strings.Contains(body, `"why":"draft"`) {
		t.Fatalf("a draft: %d %s", code, body)
	}
	if !hasNotice(n, "achild", "your input box holds `export TOKEN=ghp_draft_secret`") {
		t.Errorf("notices %q", n.all())
	}
	if f.count("SELECT count(*) FROM answer_notices WHERE agent_id = 'achild'") != 1 || f.rowsLike("your input box holds (a draft, not stored)") != 1 || f.rowsLike("ghp_draft_secret") != 0 {
		t.Errorf("rows %q", f.count1("SELECT group_concat(text, ' | ') FROM answer_notices WHERE agent_id = 'achild'"))
	}
}

// TestInputNoticeUnsentRow (S-4155): an Enter that couldn't be sent after the claim replaces the claim's typed row with
// the failure's, in one transaction: the agent is never told both.
func TestInputNoticeUnsentRow(t *testing.T) {
	f, _, tc, barrier := inputFixture(t)
	boxPane(f, tc, "achild")
	id := f.suggestID("make deploy")
	release := f.heldApproval(barrier, "-enter", id, "make deploy")
	tc.Run(context.Background(), nil, "kill-session", "-t", "=achild")
	if body := release(); !strings.Contains(body, `"outcome":"failed"`) {
		t.Fatalf("the approval: %s", body)
	}
	if f.count("SELECT count(*) FROM answer_notices WHERE agent_id = 'achild'") != 1 || f.rowsLike("stam couldn't press Enter") != 1 {
		t.Errorf("rows %q", f.count1("SELECT group_concat(text, ' | ') FROM answer_notices WHERE agent_id = 'achild'"))
	}
}

// TestInputNoticeFailedTryDropsApprovalRow (S-4155): a first try that fails (here the claim's write, by an injected
// trigger: the move itself, or the typed row after the approval's was deleted in the same transaction) leaves the
// request held and drops the approval's row, so no restart tells the agent to end its turn.
func TestInputNoticeFailedTryDropsApprovalRow(t *testing.T) {
	for name, trigger := range map[string]string{
		"claim":     "CREATE TRIGGER fail_claim BEFORE UPDATE OF status ON permission_requests WHEN NEW.status = 'approved' BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END",
		"typed row": "CREATE TRIGGER fail_row BEFORE INSERT ON answer_notices WHEN instr(NEW.text, 'typed into your input') > 0 BEGIN SELECT RAISE(ABORT, 'injected row failure'); END",
	} {
		t.Run(name, func(t *testing.T) {
			f, _, tc, _ := inputFixture(t)
			log := boxPane(f, tc, "achild")
			id := f.suggestID("git show")
			f.sql(trigger)
			if code, body := f.approveInput(id, "git show"); code == 200 || !strings.Contains(body, "injected") {
				t.Fatalf("the approval: %d %s", code, body)
			}
			if f.status(id) != "held" || readLog(log) != "" {
				t.Errorf("status %s, submitted %q", f.status(id), readLog(log))
			}
			if n := f.count("SELECT count(*) FROM answer_notices WHERE agent_id = 'achild'"); n != 0 {
				t.Errorf("%d rows left: %q", n, f.count1("SELECT group_concat(text, ' | ') FROM answer_notices WHERE agent_id = 'achild'"))
			}
		})
	}
}

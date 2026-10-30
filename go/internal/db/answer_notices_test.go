package db

import (
	"context"
	"testing"
)

// TestMoveInputNoticedAtomic (S-3923): a move and its answer_notices row commit together. A write that is cut short
// (here, a cancelled context) moves nothing and writes no row; the same move with a live context does both.
func TestMoveInputNoticedAtomic(t *testing.T) {
	path := testDB(t)
	d := openTest(t, path)
	ctx := context.Background()
	newTestAgent(t, d, "anat", "atomic")
	future := "2999-01-01T00:00:00.000Z"
	r, _, err := d.CreateInputRequest(ctx, NewInput{AgentID: "anat", Reason: "r", Text: "ls", SHA256: "h", ExpiresAt: future})
	must(t, err)
	by := "human"
	if moved, err := d.MoveInputRequest(ctx, r.ID, "pending", "approved", MoveInput{By: &by}); err != nil || !moved {
		t.Fatal("approve", moved, err)
	}
	note := "typed, but Enter not sent"
	n := &NewAnswerNotice{AgentID: "anat", Text: "stam couldn't press Enter"}

	cut, cancel := context.WithCancel(ctx)
	cancel()
	if moved, row, err := d.MoveInputRequestNoticed(cut, r.ID, "approved", "failed", MoveInput{Note: &note}, n); err == nil || moved || row != 0 {
		t.Fatalf("a cut-short write moved %v, row %d, err %v", moved, row, err)
	}
	if got, _, _ := d.PermissionRequestByID(ctx, r.ID); got.Status != "approved" {
		t.Fatalf("the cut-short write left the request %s", got.Status)
	}
	if rows, _ := d.AnswerNotices(ctx); len(rows) != 0 {
		t.Fatalf("the cut-short write left rows: %+v", rows)
	}

	moved, row, err := d.MoveInputRequestNoticed(ctx, r.ID, "approved", "failed", MoveInput{Note: &note}, n)
	if err != nil || !moved || row == 0 {
		t.Fatalf("the live write moved %v, row %d, err %v", moved, row, err)
	}
	rows, _ := d.AnswerNotices(ctx)
	if len(rows) != 1 || rows[0].Text != n.Text || rows[0].ID != row {
		t.Fatalf("rows after the live write: %+v", rows)
	}
}

// TestMoveInputNoticedReplaces (S-4155): an outcome's row takes the place of the approval's in the move's transaction. A
// move that doesn't happen keeps the approval's row; one that does leaves only the outcome's.
func TestMoveInputNoticedReplaces(t *testing.T) {
	path := testDB(t)
	d := openTest(t, path)
	ctx := context.Background()
	newTestAgent(t, d, "anrp", "replaces")
	future := "2999-01-01T00:00:00.000Z"
	r, _, err := d.CreateInputRequest(ctx, NewInput{AgentID: "anrp", Reason: "r", Text: "ls", SHA256: "h", ExpiresAt: future})
	must(t, err)
	moved, approval, err := d.MoveInputRequestNoticed(ctx, r.ID, "pending", "held", MoveInput{}, &NewAnswerNotice{AgentID: "anrp", Text: "approved: end your turn"})
	if err != nil || !moved || approval == 0 {
		t.Fatal("approve", moved, approval, err)
	}
	typed := &NewAnswerNotice{AgentID: "anrp", Text: "typed into your input", Replaces: approval}
	if moved, row, err := d.MoveInputRequestNoticed(ctx, r.ID, "pending", "approved", MoveInput{}, typed); err != nil || moved || row != 0 {
		t.Fatalf("a move from the wrong status moved %v, row %d, err %v", moved, row, err)
	}
	if rows, _ := d.AnswerNotices(ctx); len(rows) != 1 || rows[0].ID != approval {
		t.Fatalf("a move that didn't happen dropped the approval's row: %+v", rows)
	}
	moved, row, err := d.MoveInputRequestNoticed(ctx, r.ID, "held", "approved", MoveInput{}, typed)
	if err != nil || !moved || row == 0 {
		t.Fatalf("the claim moved %v, row %d, err %v", moved, row, err)
	}
	if rows, _ := d.AnswerNotices(ctx); len(rows) != 1 || rows[0].ID != row || rows[0].Text != typed.Text {
		t.Fatalf("rows after the claim: %+v", rows)
	}
	// A notice with no move replaces the same way.
	draft, err := d.ReplaceAnswerNotice(ctx, NewAnswerNotice{AgentID: "anrp", Text: "a draft, not stored", Replaces: row})
	if err != nil || draft == 0 {
		t.Fatal("replace", draft, err)
	}
	if rows, _ := d.AnswerNotices(ctx); len(rows) != 1 || rows[0].ID != draft {
		t.Fatalf("rows after the replace: %+v", rows)
	}
}

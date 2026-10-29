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

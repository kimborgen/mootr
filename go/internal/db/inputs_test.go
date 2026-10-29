package db

import (
	"context"
	"testing"
)

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// TestInputRequests: a suggestion is created with a wait on the human, replacing the agent's pending and held ones
// with their waits in the same write; each move is conditional on the status (and, when asked, on not being expired),
// and sets only the fields it is given; the held box is a held request's note only.
func TestInputRequests(t *testing.T) {
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	ctx := context.Background()
	newTestAgent(t, d, "ain1", "typist")
	newTestAgent(t, d, "ain2", "other")
	future := "2999-01-01T00:00:00.000Z"
	a, replaced, err := d.CreateInputRequest(ctx, NewInput{AgentID: "ain1", Reason: "r", Text: "ls", SHA256: "h1", ExpiresAt: future})
	if err != nil || len(replaced) != 0 {
		t.Fatal(err, replaced)
	}
	if a.Kind != "input" || a.Status != "pending" || a.Audience != "human" || a.Action != "Type suggested input" || a.Text != "ls" || a.SHA256 != "h1" || a.ExpiresAt != future || a.SessionID != "" {
		t.Errorf("created %+v", a)
	}
	ws, _ := d.ListWaits(ctx, "ain1")
	if len(ws) != 1 || ws[0].Kind != "human" || deref(ws[0].Target) != a.ID || deref(ws[0].Detail) != "your approval" || ws[0].Source != "stam" {
		t.Errorf("waits %+v", ws)
	}

	// Approved: held for the session, with only the given fields set.
	by, note, session := "human", "approved", "s-1"
	if moved, err := d.MoveInputRequest(ctx, a.ID, "pending", "held", MoveInput{By: &by, Note: &note, Session: &session, Unexpired: true, Settle: true}); err != nil || !moved {
		t.Fatal("approve", moved, err)
	}
	if moved, _ := d.MoveInputRequest(ctx, a.ID, "pending", "held", MoveInput{}); moved {
		t.Error("a second approval moved it")
	}
	r, _, _ := d.PermissionRequestByID(ctx, a.ID)
	if r.Status != "held" || r.SessionID != "s-1" || r.Row.Text("decided_by") != "human" || r.Row.Text("note") != "approved" || r.Row.Text("decided_at") == "" {
		t.Errorf("held %+v", r.Row)
	}
	if ws, _ := d.ListWaits(ctx, "ain1"); len(ws) != 0 {
		t.Errorf("waits after the approval %+v", ws)
	}
	// A move with no fields keeps them.
	if moved, _ := d.MoveInputRequest(ctx, a.ID, "held", "held", MoveInput{}); !moved {
		t.Error("held to held")
	}
	if r, _, _ := d.PermissionRequestByID(ctx, a.ID); r.Row.Text("decided_by") != "human" || r.SessionID != "s-1" {
		t.Errorf("fields after an empty move %+v", r.Row)
	}
	// SameSession: the agent's session must still be the request's, in the same statement.
	execSQL(t, conn, "UPDATE agents SET session_id = 's-2' WHERE id = 'ain1'")
	if moved, _ := d.MoveInputRequest(ctx, a.ID, "held", "held", MoveInput{SameSession: true}); moved {
		t.Error("moved on another session")
	}
	execSQL(t, conn, "UPDATE agents SET session_id = 's-1' WHERE id = 'ain1'")
	if moved, _ := d.MoveInputRequest(ctx, a.ID, "held", "held", MoveInput{SameSession: true}); !moved {
		t.Error("didn't move on its own session")
	}

	box := "a draft"
	must(t, d.SetHeldBox(ctx, a.ID, &box))
	if r, _, _ := d.PermissionRequestByID(ctx, a.ID); r.Row.Text("note") != "box:a draft" {
		t.Errorf("box %q", r.Row.Text("note"))
	}
	must(t, d.SetHeldBox(ctx, a.ID, nil))
	if r, _, _ := d.PermissionRequestByID(ctx, a.ID); r.Row.Text("note") != "" {
		t.Errorf("box after clearing %q", r.Row.Text("note"))
	}

	// A newer suggestion replaces a pending one and leaves a held one (an approval waits to be typed, S-3830), and
	// another agent's alone.
	b, replaced, err := d.CreateInputRequest(ctx, NewInput{AgentID: "ain1", Text: "pwd", SHA256: "h2", ExpiresAt: future})
	must(t, err)
	if len(replaced) != 0 {
		t.Errorf("withdrew the held one %+v", replaced)
	}
	other, _, err := d.CreateInputRequest(ctx, NewInput{AgentID: "ain2", Text: "x", SHA256: "h3", ExpiresAt: future})
	must(t, err)
	c, replaced, err := d.CreateInputRequest(ctx, NewInput{AgentID: "ain1", Text: "make", SHA256: "h4", ExpiresAt: future})
	must(t, err)
	if len(replaced) != 1 || replaced[0] != (Replaced{ID: b.ID, Was: "pending"}) {
		t.Errorf("replaced %+v", replaced)
	}
	for id, want := range map[string]string{a.ID: "held", b.ID: "withdrawn", other.ID: "pending", c.ID: "pending"} {
		if r, _, _ := d.PermissionRequestByID(ctx, id); r.Status != want {
			t.Errorf("%s is %s, want %s", id, r.Status, want)
		}
	}
	if ws, _ := d.ListWaits(ctx, "ain1"); len(ws) != 1 || deref(ws[0].Target) != c.ID {
		t.Errorf("waits after the replacement %+v", ws)
	}
	if rs, _ := d.InputRequests(ctx, "pending", ""); len(rs) != 2 {
		t.Errorf("pending %+v", rs)
	}
	if rs, _ := d.InputRequests(ctx, "pending", "ain2"); len(rs) != 1 || rs[0].ID != other.ID {
		t.Errorf("ain2's pending %+v", rs)
	}

	// Unexpired: a suggestion past its time doesn't move.
	execSQL(t, conn, "UPDATE permission_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", c.ID)
	if moved, _ := d.MoveInputRequest(ctx, c.ID, "pending", "held", MoveInput{Unexpired: true}); moved {
		t.Error("an expired one moved")
	}
	if moved, _ := d.MoveInputRequest(ctx, c.ID, "pending", "expired", MoveInput{Settle: true}); !moved {
		t.Error("the expiry didn't move it")
	}
	if ws, _ := d.ListWaits(ctx, "ain1"); len(ws) != 0 {
		t.Errorf("waits after the expiry %+v", ws)
	}
	// Only a suggestion moves this way.
	if moved, _ := d.MoveInputRequest(ctx, "p1", "pending", "denied", MoveInput{}); moved {
		t.Error("a request that isn't input moved")
	}

	if _, ok, err := d.PermissionMail(ctx, c.ID); ok || err != nil {
		t.Error("a mail for a request with none", err)
	}
	execSQL(t, conn, "INSERT INTO mail (id, from_id, subject, body, created_at, permission_id) VALUES ('mi2', 'ain1', 's', 'b', '2026-01-02T00:00:00.000Z', ?), ('mi1', 'ain1', 's', 'b', '2026-01-01T00:00:00.000Z', ?)", c.ID, c.ID)
	if id, ok, err := d.PermissionMail(ctx, c.ID); id != "mi1" || !ok || err != nil {
		t.Errorf("the first mail %s %v %v", id, ok, err)
	}
}

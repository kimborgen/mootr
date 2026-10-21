package db

import (
	"context"
	"regexp"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

func execSQL(t *testing.T, conn *sqlite.Conn, q string, args ...any) {
	t.Helper()
	if err := sqlitex.Execute(conn, q, &sqlitex.ExecOptions{Args: args}); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

func count(t *testing.T, conn *sqlite.Conn, q string, args ...any) int {
	t.Helper()
	n := 0
	err := sqlitex.Execute(conn, q, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error { n = stmt.ColumnInt(0); return nil }})
	if err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return n
}

func newTestAgent(t *testing.T, d *DB, id, name string) Agent {
	t.Helper()
	a, err := d.CreateAgent(context.Background(), NewAgent{ID: id, Name: name, Role: "developer", Machine: "test-machine", Harness: "claude", Cwd: "/w"})
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func detail(a Agent) string {
	if a.ActivityDetail == nil {
		return "<nil>"
	}
	return *a.ActivityDetail
}

// TestUpdateAgentWaitsAndIdleSince: idle with open waits is waiting, named by the highest-ranked wait; going idle sets
// idle_since once, any other activity clears it, and an update that sets it itself keeps its value.
func TestUpdateAgentWaitsAndIdleSince(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	newTestAgent(t, d, "awrk1", "worker")
	newTestAgent(t, d, "aoth2", "other")
	get := func() Agent {
		a, err := d.GetAgent(ctx, "awrk1")
		if err != nil {
			t.Fatal(err)
		}
		return a
	}

	if err := d.UpdateAgent(ctx, "awrk1", Field{"activity", "idle"}, Field{"activity_detail", "turn finished"}); err != nil {
		t.Fatal(err)
	}
	a := get()
	if a.Activity != "idle" || detail(a) != "turn finished" || a.IdleSince == nil {
		t.Fatalf("idle without waits: %s %s idle_since %v", a.Activity, detail(a), a.IdleSince)
	}
	since := *a.IdleSince
	if err := d.UpdateAgent(ctx, "awrk1", Field{"activity", "idle"}, Field{"activity_detail", "again"}); err != nil {
		t.Fatal(err)
	}
	if a = get(); a.IdleSince == nil || *a.IdleSince != since {
		t.Errorf("a second idle moved idle_since from %s to %v", since, a.IdleSince)
	}
	if err := d.UpdateAgent(ctx, "awrk1", Field{"activity", "working"}, Field{"activity_detail", nil}); err != nil {
		t.Fatal(err)
	}
	if a = get(); a.IdleSince != nil || a.ActivityDetail != nil {
		t.Errorf("working kept idle_since %v, detail %s", a.IdleSince, detail(a))
	}

	conn := rawConn(t, path)
	execSQL(t, conn, "INSERT INTO waits (id, agent_id, kind, target, detail, since, source) VALUES ('w1', 'awrk1', 'job', 'build', NULL, '2026-01-01T00:00:00Z', 'hook')")
	execSQL(t, conn, "INSERT INTO waits (id, agent_id, kind, target, detail, since, source) VALUES ('w2', 'awrk1', 'agent', 'aoth2', NULL, '2026-01-02T00:00:00Z', 'declared')")
	if err := d.UpdateAgent(ctx, "awrk1", Field{"activity", "idle"}, Field{"activity_detail", "turn finished"}); err != nil {
		t.Fatal(err)
	}
	if a = get(); a.Activity != "waiting" || detail(a) != "waiting for other's reply (+1 more)" || a.IdleSince == nil {
		t.Errorf("idle with waits: %s %q idle_since %v", a.Activity, detail(a), a.IdleSince)
	}
	execSQL(t, conn, "DELETE FROM waits WHERE id = 'w2'")
	if err := d.UpdateAgent(ctx, "awrk1", Field{"activity", "idle"}); err != nil {
		t.Fatal(err)
	}
	if a = get(); detail(a) != "waiting for job build" {
		t.Errorf("one job wait: %q", detail(a))
	}
	if err := d.UpdateAgent(ctx, "awrk1", Field{"activity", "working"}, Field{"idle_since", "2026-03-03T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	if a = get(); a.IdleSince == nil || *a.IdleSince != "2026-03-03T00:00:00.000Z" {
		t.Errorf("an update's own idle_since was replaced: %v", a.IdleSince)
	}

	before := a.UpdatedAt
	if err := d.UpdateAgent(ctx, "awrk1", Field{"token_hash", "x"}); err == nil || !strings.Contains(err.Error(), "isn't updatable") {
		t.Errorf("token_hash update = %v, want refused", err)
	}
	if err := d.UpdateAgent(ctx, "awrk1", Field{"name = 'x', role", "y"}); err == nil {
		t.Error("a column name with SQL in it passed")
	}
	if a = get(); a.UpdatedAt != before || a.Name != "worker" {
		t.Errorf("a refused update wrote the row: %s %s", a.UpdatedAt, a.Name)
	}
}

// TestForgetAgent removes the agent's own rows and withdraws its pending requests, and leaves another agent's alone.
func TestForgetAgent(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	for _, id := range []string{"afgt7", "akp8x"} {
		newTestAgent(t, d, id, "n-"+id)
		if err := d.AddEvent(ctx, id, "spawn", nil); err != nil {
			t.Fatal(err)
		}
		execSQL(t, conn, "INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('m1', ?)", id)
		execSQL(t, conn, "INSERT INTO mail_deliveries (agent_id, mail_id, batch) VALUES (?, 'm1', 'b')", id)
		execSQL(t, conn, "INSERT INTO blockers (agent_id, kind, reason, since) VALUES (?, 'k', 'r', 's')", id)
		execSQL(t, conn, "INSERT INTO waits (id, agent_id, kind, since, source) VALUES (?, ?, 'human', 's', 'declared')", "w-"+id, id)
		execSQL(t, conn, "INSERT INTO agent_views (agent_id, view, updated_at) VALUES (?, '{}', 's')", id)
		execSQL(t, conn, "INSERT INTO workspace_grants (workspace, grantee_id, access, granted_by, granted_at) VALUES ('/p', ?, 'read', 'x', 's')", id)
		execSQL(t, conn, "INSERT INTO permission_requests (id, agent_id, action, reason, details, created_at, dialog) VALUES (?, ?, 'a', 'r', '{}', 's', 1)", "p-"+id, id)
	}
	if ok, err := d.HasPendingDialog(ctx, "afgt7"); err != nil || !ok {
		t.Fatalf("HasPendingDialog = %v, %v", ok, err)
	}
	if err := d.ForgetAgent(ctx, "afgt7"); err != nil {
		t.Fatal(err)
	}
	tables := map[string]string{
		"agents": "id", "events": "agent_id", "mail_recipients": "agent_id", "mail_deliveries": "agent_id", "blockers": "agent_id",
		"waits": "agent_id", "agent_views": "agent_id", "workspace_grants": "grantee_id",
	}
	for table, col := range tables {
		if n := count(t, conn, "SELECT COUNT(*) FROM "+table+" WHERE "+col+" = 'afgt7'"); n != 0 {
			t.Errorf("%s keeps %d rows of the forgotten agent", table, n)
		}
		if n := count(t, conn, "SELECT COUNT(*) FROM "+table+" WHERE "+col+" = 'akp8x'"); n != 1 {
			t.Errorf("%s has %d rows of the other agent, want 1", table, n)
		}
	}
	if n := count(t, conn, "SELECT COUNT(*) FROM permission_requests WHERE agent_id = 'afgt7' AND status = 'withdrawn' AND decided_at IS NOT NULL"); n != 1 {
		t.Errorf("the forgotten agent's request isn't withdrawn")
	}
	if ok, _ := d.HasPendingDialog(ctx, "akp8x"); !ok {
		t.Errorf("the other agent's dialog went")
	}
}

// TestNewAgentID: "a" and four characters of the alphabet, never an id an agent here or a peer's has.
func TestNewAgentID(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	re := regexp.MustCompile(`^a[abcdefghijkmnpqrstuvwxyz23456789]{4}$`)
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		id, err := d.NewAgentID(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !re.MatchString(id) {
			t.Fatalf("id %q", id)
		}
		seen[id] = true
	}
	if len(seen) < 190 {
		t.Errorf("only %d distinct ids of 200", len(seen))
	}
}

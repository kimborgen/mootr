package db

import (
	"context"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// switchState is every row a move or unmove writes, one line per row, in a fixed order.
func switchState(t *testing.T, d *DB) string {
	t.Helper()
	var b strings.Builder
	err := d.Read(context.Background(), func(conn *sqlite.Conn) error {
		for _, q := range []string{
			"SELECT id, name, IFNULL(parent_id, ''), IFNULL(forwarded_to, '') FROM agents ORDER BY id",
			"SELECT child_id, parent_id FROM agent_parents ORDER BY child_id, parent_id",
			"SELECT mail_id, agent_id, IFNULL(read_at, '') FROM mail_recipients ORDER BY mail_id, agent_id",
			"SELECT agent_id, mail_id, batch FROM mail_deliveries ORDER BY agent_id, mail_id",
			"SELECT id, IFNULL(owner, '') FROM itsas ORDER BY id",
			"SELECT itsa_id, agent_id FROM itsa_participants ORDER BY itsa_id, agent_id",
			"SELECT workspace, grantee_id FROM workspace_grants ORDER BY workspace, grantee_id",
		} {
			err := sqlitex.Execute(conn, q, &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
				for i := range stmt.ColumnCount() {
					b.WriteString(stmt.ColumnText(i) + "|")
				}
				b.WriteString("\n")
				return nil
			}})
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return b.String()
}

// TestSwitchMoveIsOneTransaction: a move that fails at its last write (the predecessor's forwarded_to) leaves every
// row as it was, and so does an unmove that fails at its last (forgetting the successor); src/cost-switch.ts runs each
// in db.transaction. The rows themselves are compared with TS in lifecycle's TestSwitchMoveMatchesTS.
func TestSwitchMoveIsOneTransaction(t *testing.T) {
	path := testDB(t)
	d := openTest(t, path)
	ctx := context.Background()
	const at = "2026-01-01T00:00:00.000Z"
	if err := d.Write(ctx, func(conn *sqlite.Conn) error {
		for _, q := range []string{
			"DELETE FROM agents", "DELETE FROM agent_parents", "DELETE FROM mail_recipients", "DELETE FROM mail_deliveries", "DELETE FROM itsas",
			"DELETE FROM itsa_participants", "DELETE FROM workspace_grants",
			"INSERT INTO agents (id, name, role, machine, harness, cwd, created_at, updated_at) VALUES ('am', 'mgr', '', 'test', 'claude', '/w', '" + at + "', '" + at + "')",
			"INSERT INTO agents (id, name, role, machine, harness, cwd, parent_id, created_at, updated_at) VALUES ('ax', 'x', '', 'test', 'claude', '/w', 'am', '" + at + "', '" + at + "')",
			"INSERT INTO agents (id, name, role, machine, harness, cwd, parent_id, created_at, updated_at) VALUES ('ac', 'c', '', 'test', 'claude', '/w', 'ax', '" + at + "', '" + at + "')",
			"INSERT INTO agent_parents (child_id, parent_id) VALUES ('am', 'ax')",
			"INSERT INTO mail (id, from_id, subject, body, created_at, thread_id) VALUES ('m1', 'am', 's', 'b', '" + at + "', 'm1')",
			"INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('m1', 'ax')",
			"INSERT INTO mail_deliveries (agent_id, mail_id, batch) VALUES ('ax', 'm1', 'b1')",
			"INSERT INTO itsas (id, key, title, status, owner, created_by, created_at, updated_at) VALUES ('i1', 'S-1', 'S-1', 'todo', 'ax', 'am', '" + at + "', '" + at + "')",
			"INSERT INTO itsa_participants (itsa_id, agent_id) VALUES ('i1', 'ax')",
			"INSERT INTO workspace_grants (workspace, grantee_id, access, granted_by, granted_at) VALUES ('/p', 'ax', 'read', 'am', '" + at + "')",
		} {
			if err := runSQL(conn, q); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	trigger := func(sql string) {
		t.Helper()
		if err := d.Write(ctx, func(conn *sqlite.Conn) error { return runSQL(conn, sql) }); err != nil {
			t.Fatal(err)
		}
	}
	before := switchState(t, d)
	pred, err := d.GetAgent(ctx, "ax")
	if err != nil {
		t.Fatal(err)
	}
	session := "s"
	spec := SuccessorSpec{Agent: NewAgent{ID: "as", Role: "", Machine: "test", Harness: "claude", Cwd: "/w", ParentID: pred.ParentID, SessionID: &session}}

	trigger("CREATE TRIGGER fail_forward BEFORE UPDATE OF forwarded_to ON agents BEGIN SELECT RAISE(ABORT, 'no forward'); END")
	if _, _, err := d.MoveToSuccessor(ctx, pred, spec, nil, "cheap"); err == nil || !strings.Contains(err.Error(), "no forward") {
		t.Fatalf("move: %v", err)
	}
	if got := switchState(t, d); got != before {
		t.Errorf("a failed move wrote:\n%s\nwas:\n%s", got, before)
	}
	trigger("DROP TRIGGER fail_forward")

	s, moved, err := d.MoveToSuccessor(ctx, pred, spec, nil, "cheap")
	if err != nil {
		t.Fatal(err)
	}
	if s.Name != "x-t2" || len(moved.Spawned) != 1 || len(moved.Adopted) != 1 || len(moved.Unread) != 1 || len(moved.ItsaOwned) != 1 || len(moved.ItsaJoined) != 1 {
		t.Fatalf("moved %s: %+v", s.Name, moved)
	}
	after := switchState(t, d)
	if after == before {
		t.Fatal("the move wrote nothing")
	}
	trigger("CREATE TRIGGER fail_forget BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT, 'no forget'); END")
	if err := d.Unmove(ctx, pred.ID, s.ID, moved); err == nil || !strings.Contains(err.Error(), "no forget") {
		t.Fatalf("unmove: %v", err)
	}
	if got := switchState(t, d); got != after {
		t.Errorf("a failed unmove wrote:\n%s\nwas:\n%s", got, after)
	}
	trigger("DROP TRIGGER fail_forget")
	if err := d.Unmove(ctx, pred.ID, s.ID, moved); err != nil {
		t.Fatal(err)
	}
	if got := switchState(t, d); got != before {
		t.Errorf("the unmove left:\n%s\nwas:\n%s", got, before)
	}
}

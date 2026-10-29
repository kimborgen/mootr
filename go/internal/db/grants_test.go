package db

import (
	"context"
	"testing"

	"zombiezen.com/go/sqlite"
)

// TestShareWorkspaceFollowsSwitch: a revoke named for an agent that a cost switch moved since the caller read it
// reaches the live successor (whose grant the switch copied) and the predecessor both, in the one write; an archived
// successor is not followed. A predecessor of a predecessor is in the chain too.
func TestShareWorkspaceFollowsSwitch(t *testing.T) {
	d := openTest(t, testDB(t))
	ctx := context.Background()
	const at = "2026-01-01T00:00:00.000Z"
	if err := d.Write(ctx, func(conn *sqlite.Conn) error {
		for _, q := range []string{
			"DELETE FROM agents", "DELETE FROM workspace_grants",
			"INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, forwarded_to, created_at, updated_at) VALUES ('a0', 'zero', '', 't', 'claude', '/w', 'shut_down', 'a1', '" + at + "', '" + at + "')",
			"INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, forwarded_to, created_at, updated_at) VALUES ('a1', 'one', '', 't', 'claude', '/w', 'shut_down', 'a2', '" + at + "', '" + at + "')",
			"INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, forwarded_to, created_at, updated_at) VALUES ('a2', 'two', '', 't', 'claude', '/w', 'active', 'a3', '" + at + "', '" + at + "')",
			"INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, created_at, updated_at) VALUES ('a3', 'three', '', 't', 'claude', '/w', 'archived', '" + at + "', '" + at + "')",
			"INSERT INTO workspace_grants (workspace, grantee_id, access, granted_by, granted_at) VALUES ('/p', 'a0', 'read', 'o', '" + at + "'), ('/p', 'a1', 'read', 'o', '" + at + "'), ('/p', 'a2', 'write', 'o', '" + at + "'), ('/q', 'a2', 'read', 'o', '" + at + "')",
		} {
			if err := runSQL(conn, q); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	owner := Agent{ID: "o", Machine: "t"}
	out, err := d.ShareWorkspace(ctx, "/p", owner, "a1", "none")
	if err != nil || out.Refusal != "" || out.Grantee.ID != "a2" || out.Removed != 3 || out.Held != "write" {
		t.Errorf("revoke via a1: %+v %v", out, err)
	}
	for _, id := range []string{"a0", "a1", "a2"} {
		if g, _ := d.GrantsTo(ctx, id); (id == "a2" && len(g) != 1) || (id != "a2" && len(g) != 0) {
			t.Errorf("%s keeps %+v", id, g)
		}
	}
	// A grant named for a stopped predecessor lands on the live successor; refusals write nothing.
	if out, err := d.ShareWorkspace(ctx, "/p", owner, "a0", "read"); err != nil || out.Grantee.ID != "a2" || out.Prev != "" {
		t.Errorf("grant via a0: %+v %v", out, err)
	}
	if g, _ := d.GrantsTo(ctx, "a0"); len(g) != 0 {
		t.Errorf("the grant landed on a0: %+v", g)
	}
	for _, tc := range []struct {
		owner Agent
		want  string
	}{{Agent{ID: "o", Machine: "elsewhere"}, "machine"}, {Agent{ID: "a2", Machine: "t"}, "self"}} {
		if out, err := d.ShareWorkspace(ctx, "/r", tc.owner, "a2", "write"); err != nil || out.Refusal != tc.want {
			t.Errorf("%+v: %+v %v", tc.owner, out, err)
		}
	}
	if out, err := d.ShareWorkspace(ctx, "/r", owner, "a3", "write"); err != nil || out.Refusal != "archived" {
		t.Errorf("an archived grantee: %+v %v", out, err)
	}
	if g, _ := d.GrantsTo(ctx, "a2"); len(g) != 2 {
		t.Errorf("a refusal wrote: %+v", g)
	}
}

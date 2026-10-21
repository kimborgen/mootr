package db

import (
	"context"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// A participant that left an ITSA (itsa_participants.left_at, S-3015) is not one of its members; a post does not bring it back,
// and an agent that only has left rows is tied to no ITSA.
func TestSoftLeftParticipant(t *testing.T) {
	path := testDB(t)
	d := openTest(t, path)
	ctx := context.Background()
	conn := rawConn(t, path)
	run := func(sql string, args ...any) {
		t.Helper()
		if err := sqlitex.Execute(conn, sql, &sqlitex.ExecOptions{Args: args}); err != nil {
			t.Fatal(err)
		}
	}
	var agent string
	if err := sqlitex.Execute(conn, "SELECT id FROM agents ORDER BY created_at LIMIT 1", &sqlitex.ExecOptions{ResultFunc: func(s *sqlite.Stmt) error {
		agent = s.ColumnText(0)
		return nil
	}}); err != nil || agent == "" {
		t.Fatalf("no agent in the fixture: %v", err)
	}
	run("INSERT INTO itsas (id, key, title, status, created_by, created_at, updated_at) VALUES ('ileft', 'S-1', 'Leave', 'backlog', 'human', 't', 't')")
	run("INSERT INTO itsa_participants (itsa_id, agent_id) VALUES ('ileft', ?)", agent)
	if got, err := d.ItsaParticipants(ctx, "ileft"); err != nil || len(got) != 1 {
		t.Fatalf("members %v, %v", got, err)
	}
	if _, tied, err := d.ItsaTies(ctx, agent); err != nil || !tied {
		t.Fatalf("a member is tied: %v, %v", tied, err)
	}
	run("UPDATE itsa_participants SET left_at = '2026-01-01T00:00:00.000Z' WHERE agent_id = ?", agent)
	if got, err := d.ItsaParticipants(ctx, "ileft"); err != nil || len(got) != 0 {
		t.Fatalf("a left row is no member: %v, %v", got, err)
	}
	if _, tied, err := d.ItsaTies(ctx, agent); err != nil || tied {
		t.Fatalf("a left row ties no one: %v, %v", tied, err)
	}
	// A post (ensureParticipant) leaves the row as it is.
	if err := d.EnsureItsaParticipant(ctx, "ileft", agent); err != nil {
		t.Fatal(err)
	}
	if got, err := d.ItsaParticipants(ctx, "ileft"); err != nil || len(got) != 0 {
		t.Fatalf("a post brought a left row back: %v, %v", got, err)
	}
}

// A file the TS daemon has not migrated to S-3015 is refused, like one without the other columns the queries read.
func TestRefusesAnUnmigratedParticipantTable(t *testing.T) {
	path := testDB(t)
	conn := rawConn(t, path)
	if err := sqlitex.ExecuteTransient(conn, "ALTER TABLE itsa_participants DROP COLUMN left_at", nil); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if _, err := Open(context.Background(), path, Options{}); err == nil || !strings.Contains(err.Error(), "itsa_participants") || !strings.Contains(err.Error(), "left_at") {
		t.Fatalf("Open err = %v, want a refusal naming itsa_participants.left_at", err)
	}
}

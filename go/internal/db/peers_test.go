package db

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// RememberPeerAgent writes the directory of other machines' agents as src/db.ts does: an unchanged agent is not written
// again, a reply without a lifecycle, parents or activity keeps what was known, and busy counts per rememberPeerAgent.
func TestRememberPeerAgent(t *testing.T) {
	ctx := context.Background()
	d := openTest(t, testDB(t))
	row := func(id string) (name, machine, lifecycle, parents string, busy int, busyAt string) {
		t.Helper()
		err := d.Read(ctx, func(conn *sqlite.Conn) error {
			return sqlitex.Execute(conn, "SELECT name, machine, COALESCE(lifecycle, '-'), COALESCE(parents, '-'), COALESCE(busy, -1), COALESCE(busy_at, '-') FROM peer_agents WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id},
				ResultFunc: func(s *sqlite.Stmt) error {
					name, machine, lifecycle, parents, busy, busyAt = s.ColumnText(0), s.ColumnText(1), s.ColumnText(2), s.ColumnText(3), s.ColumnInt(4), s.ColumnText(5)
					return nil
				}})
		})
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	if _, ok, err := d.PeerAgentByID(ctx, "p1"); err != nil || ok {
		t.Fatalf("unknown id: %v %v", ok, err)
	}
	// A spawn's reply: one parent, no activity (the busy flag stays unknown).
	if err := d.RememberPeerAgent(ctx, PeerAgentSeen{ID: "p1", Name: "far-one", Machine: "far", Lifecycle: "active", ParentID: "boss"}); err != nil {
		t.Fatal(err)
	}
	if n, m, lc, ps, busy, at := row("p1"); n != "far-one" || m != "far" || lc != "active" || ps != `["boss"]` || busy != -1 || at != "-" {
		t.Errorf("after a spawn: %s %s %s %s %d %s", n, m, lc, ps, busy, at)
	}
	// A listing: every parent, and a working agent is busy.
	if err := d.RememberPeerAgent(ctx, PeerAgentSeen{ID: "p1", Name: "far-one", Machine: "far", Lifecycle: "active", Parents: []string{"boss", "cos"}, Activity: "working"}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, ps, busy, at := row("p1"); ps != `["boss","cos"]` || busy != 1 || at == "-" {
		t.Errorf("after a listing: %s %d %s", ps, busy, at)
	}
	// A reply that says nothing of lifecycle, parents or activity keeps what is known; the name and machine follow it.
	if err := d.RememberPeerAgent(ctx, PeerAgentSeen{ID: "p1", Name: "renamed", Machine: "far2"}); err != nil {
		t.Fatal(err)
	}
	if n, m, lc, ps, busy, _ := row("p1"); n != "renamed" || m != "far2" || lc != "active" || ps != `["boss","cos"]` || busy != 1 {
		t.Errorf("after a bare reply: %s %s %s %s %d", n, m, lc, ps, busy)
	}
	// Idle is not busy; an archived agent is not busy whatever it does; a pending request or a resting wait is.
	for _, tc := range []struct {
		what string
		a    PeerAgentSeen
		busy int
	}{
		{"idle", PeerAgentSeen{Activity: "idle", Lifecycle: "active"}, 0},
		{"archived working", PeerAgentSeen{Activity: "working", Lifecycle: "archived"}, 0},
		{"pending request", PeerAgentSeen{Activity: "idle", Lifecycle: "active", PendingRequests: 1}, 1},
		{"resting with waits", PeerAgentSeen{Activity: "idle", Lifecycle: "paused", PausedBy: `["standing-idle"]`, Waits: 2}, 1},
		{"paused by someone else", PeerAgentSeen{Activity: "idle", Lifecycle: "paused", PausedBy: `["human"]`, Waits: 2}, 0},
	} {
		tc.a.ID, tc.a.Name, tc.a.Machine = "p2", "two", "far"
		if err := d.RememberPeerAgent(ctx, tc.a); err != nil {
			t.Fatal(err)
		}
		if _, _, _, _, busy, _ := row("p2"); busy != tc.busy {
			t.Errorf("%s: busy %d, want %d", tc.what, busy, tc.busy)
		}
	}
	// An unchanged agent is not written again: its updated_at stays.
	stamp := func() string {
		s := ""
		d.Read(ctx, func(conn *sqlite.Conn) error {
			return sqlitex.Execute(conn, "SELECT updated_at FROM peer_agents WHERE id = 'p3'", &sqlitex.ExecOptions{ResultFunc: func(st *sqlite.Stmt) error { s = st.ColumnText(0); return nil }})
		})
		return s
	}
	same := PeerAgentSeen{ID: "p3", Name: "three", Machine: "far", Lifecycle: "active", Parents: []string{"boss"}, Activity: "idle"}
	if err := d.RememberPeerAgent(ctx, same); err != nil {
		t.Fatal(err)
	}
	first := stamp()
	if err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "UPDATE peer_agents SET updated_at = 'marker' WHERE id = 'p3'", nil)
	}); err != nil {
		t.Fatal(err)
	}
	if err := d.RememberPeerAgent(ctx, same); err != nil {
		t.Fatal(err)
	}
	if got := stamp(); got != "marker" || first == "marker" {
		t.Errorf("an unchanged agent was written again: %q (first %q)", got, first)
	}
	// By id only: a name that equals an id is not that agent.
	if r, ok, err := d.PeerAgentByID(ctx, "p3"); err != nil || !ok || r.Name != "three" || r.Machine != "far" {
		t.Errorf("by id: %+v %v %v", r, ok, err)
	}
	if _, ok, _ := d.PeerAgentByID(ctx, "three"); ok {
		t.Error("PeerAgentByID matched a name")
	}
}

// Concurrent writes of one id end with the newest, and forgetting an agent drops what was remembered, so the next listing
// writes it (and every other) again.
func TestRememberPeerAgentConcurrentAndForget(t *testing.T) {
	ctx := context.Background()
	d := openTest(t, testDB(t))
	name := func(id string) string {
		n := ""
		d.Read(ctx, func(conn *sqlite.Conn) error {
			return sqlitex.Execute(conn, "SELECT name FROM peer_agents WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(s *sqlite.Stmt) error { n = s.ColumnText(0); return nil }})
		})
		return n
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := d.RememberPeerAgent(ctx, PeerAgentSeen{ID: "p1", Name: fmt.Sprintf("n%d", i%2), Machine: "far"}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	// The row and the remembered key agree: writing the name the row has again is skipped, the other is written.
	last := name("p1")
	other := "n0"
	if last == "n0" {
		other = "n1"
	}
	if err := d.RememberPeerAgent(ctx, PeerAgentSeen{ID: "p1", Name: other, Machine: "far"}); err != nil {
		t.Fatal(err)
	}
	if name("p1") != other {
		t.Errorf("a change after the race was skipped: row %q, wanted %q", name("p1"), other)
	}
	for _, id := range []string{"p2", "p3"} {
		if err := d.RememberPeerAgent(ctx, PeerAgentSeen{ID: id, Name: "agent-" + id, Machine: "far"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := d.ForgetPeerAgent(ctx, "agent-p2"); err != nil {
		t.Fatal(err)
	}
	if name("p2") != "" || name("p3") == "" {
		t.Errorf("forget by name: p2 %q, p3 %q", name("p2"), name("p3"))
	}
	// p3 was cleared from the cache with it: a row deleted behind its back is written again.
	if err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "DELETE FROM peer_agents WHERE id = 'p3'", nil)
	}); err != nil {
		t.Fatal(err)
	}
	if err := d.RememberPeerAgent(ctx, PeerAgentSeen{ID: "p2", Name: "agent-p2", Machine: "far"}); err != nil {
		t.Fatal(err)
	}
	if err := d.RememberPeerAgent(ctx, PeerAgentSeen{ID: "p3", Name: "agent-p3", Machine: "far"}); err != nil {
		t.Fatal(err)
	}
	if name("p2") == "" || name("p3") == "" {
		t.Errorf("after a forget the listing writes again: p2 %q, p3 %q", name("p2"), name("p3"))
	}
}

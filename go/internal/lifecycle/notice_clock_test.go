package lifecycle

import (
	"testing"
	"time"

	"stam/internal/clock"
	"stam/internal/db"
)

// fixClock pins the daemon's clock for a test and puts it back when the test ends.
func fixClock(t *testing.T, at time.Time) {
	t.Helper()
	old := clock.Now
	t.Cleanup(func() { clock.Now = old })
	clock.Now = func() time.Time { return at }
}

// TestNoticeClock is the clock line a child notice ends with (S-3468) against a fixed clock: the daemon's now to the
// minute, the child's age since its spawn, and, for a tree-idle notice, how long it has been idle.
func TestNoticeClock(t *testing.T) {
	fixClock(t, time.Date(2026, 10, 22, 2, 10, 30, 0, time.UTC))
	idle := "2026-10-22T02:09:00.000Z"
	a := db.Agent{CreatedAt: "2026-10-22T01:56:00.000Z", IdleSince: &idle}
	for _, c := range []struct {
		name string
		a    db.Agent
		idle bool
		want string
	}{
		{"turn finished has no idle part", a, false, "now 2026-10-22T02:10Z · child age 14m"},
		{"tree-idle adds the idle time", a, true, "now 2026-10-22T02:10Z · child age 14m · idle 1m"},
		{"tree-idle with no idle_since leaves it out", db.Agent{CreatedAt: a.CreatedAt}, true, "now 2026-10-22T02:10Z · child age 14m"},
		{"a bad spawn time counts as now", db.Agent{CreatedAt: "not a time", IdleSince: &idle}, true, "now 2026-10-22T02:10Z · child age 0s · idle 1m"},
		{"a bad idle time counts as now", db.Agent{CreatedAt: "2026-10-22T02:00:00.000Z", IdleSince: ptr("not a time")}, true, "now 2026-10-22T02:10Z · child age 10m · idle 0s"},
		{"spans of days and hours", db.Agent{CreatedAt: "2026-10-20T00:00:00.000Z"}, false, "now 2026-10-22T02:10Z · child age 2d 2h"},
	} {
		if got := noticeClock(c.a, c.idle); got != c.want {
			t.Errorf("%s: noticeClock = %q, want %q", c.name, got, c.want)
		}
	}
}

// TestNoticeClockPaths: each path that queues a child notice (turn finished, tree-idle, blocked, errored) queues it with
// the clock line at its end, built from the child's stored rows. Every child starts 'starting' with its spawn time pinned,
// so no idle change happens before the one under test, and a tree-idle child's idle_since is set in the same update.
func TestNoticeClockPaths(t *testing.T) {
	fixClock(t, time.Date(2026, 10, 22, 2, 10, 30, 0, time.UTC))
	l := newLive(t)
	l.life.StartOrg()
	spawn := func(id, parent string) {
		t.Helper()
		var p *string
		if parent != "" {
			p = &parent
		}
		if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: id, Name: "n-" + id, Role: "developer", Machine: "test-machine", Harness: "claude", Cwd: l.work, ParentID: p}); err != nil {
			t.Fatal(err)
		}
		execOn(l.t, l, "UPDATE agents SET created_at = '2026-10-22T02:00:00.000Z' WHERE id = '"+id+"'")
		l.set(id, db.Field{Col: "lifecycle", Val: "active"})
	}
	for _, p := range []string{"tp", "dp", "bp", "ep"} {
		spawn(p, "")
	}
	l.set("tp", db.Field{Col: "child_notices", Val: "turn"})
	l.set("dp", db.Field{Col: "child_notices", Val: "tree-idle"})
	for _, c := range [][2]string{{"tc", "tp"}, {"dc", "dp"}, {"bc", "bp"}, {"ec", "ep"}} {
		spawn(c[0], c[1])
	}
	// Each child is 10 minutes old, so the expected line ends with its age; the tree-idle child went idle at 02:09:00.
	clockLine := "\nnow 2026-10-22T02:10Z · child age 10m"

	// Turn finished: the parent set to "turn" hears it when the child's turn ends from working.
	l.set("tc", db.Field{Col: "activity", Val: "working"})
	l.orgSettle()
	l.turnEnds("tc")
	l.orgSettle()
	if got := l.life.Notices("tp"); len(got) != 1 || got[0] != "[stam] Your child agent n-tc finished its turn. Its last message: (not reported)"+clockLine {
		t.Errorf("turn finished: %q", got)
	}
	// Tree-idle: the parent set to "tree-idle" hears once the subtree is quiet, with how long the child has been idle.
	l.set("dc", db.Field{Col: "activity", Val: "working"})
	l.orgSettle()
	l.set("dc", db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "turn finished"}, db.Field{Col: "idle_since", Val: "2026-10-22T02:09:00.000Z"})
	l.orgSettle()
	if got := l.life.Notices("dp"); len(got) != 1 || got[0] != "[stam] Your child agent n-dc finished its turn. Its last message: (not reported)"+clockLine+" · idle 1m" {
		t.Errorf("tree-idle: %q", got)
	}
	// Blocked and errored: the parent hears the trouble, the text unchanged, with the clock line after it.
	l.set("bc", db.Field{Col: "activity", Val: "blocked"}, db.Field{Col: "activity_detail", Val: "a dialog"})
	l.set("ec", db.Field{Col: "activity", Val: "errored"}, db.Field{Col: "activity_detail", Val: "crashed"})
	l.orgSettle()
	if got := l.life.Notices("bp"); len(got) != 1 || got[0] != "[stam] Agent n-bc, your child, is blocked: a dialog. Open its terminal with `stam attach n-bc` or the web UI, or help it by mail. If it needs your user's sign-off, make sure the human knows, or answer its delegate ask."+clockLine {
		t.Errorf("blocked: %q", got)
	}
	if got := l.life.Notices("ep"); len(got) != 1 || got[0] != "[stam] Agent n-ec, your child, stopped with an error: crashed. Decide whether to resume, restart, or replace it."+clockLine {
		t.Errorf("errored: %q", got)
	}
}

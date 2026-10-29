package db

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

func dump(t *testing.T, conn *sqlite.Conn, q string, args ...any) string {
	t.Helper()
	var out []string
	err := sqlitex.Execute(conn, q, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
		var row []string
		for i := range stmt.ColumnCount() {
			if stmt.ColumnType(i) == sqlite.TypeNull {
				row = append(row, "NULL")
			} else {
				row = append(row, stmt.ColumnText(i))
			}
		}
		out = append(out, strings.Join(row, "|"))
		return nil
	}})
	if err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return strings.Join(out, "\n")
}

// TestUsageTables: a report's growth adds to its daily row and its sample bucket (a null model is NULL in one and ”
// in the other); a window reading gets a row only when it changes; pruning drops old samples and readings; and the
// agent's total spend and unread mail read as the live stream shows them.
func TestUsageTables(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	model := "claude-opus-5-5"
	u := Usage{AgentID: "aus1", Day: "2026-10-20", Bucket: "2026-10-20T10:05:00.000Z", Harness: "claude", Account: "", Cost: 0.5, In: 10, Out: 2,
		CacheRead: 100, CacheWrite: 7, PaidEstimate: 0.5, Unreconciled: 0}
	newTestAgent(t, d, "aus1", "user1")
	for i, m := range []*string{nil, &model} {
		u.Model, u.Baseline = m, fmt.Sprintf(`{"v":2,"n":%d}`, i)
		if err := d.RecordUsage(ctx, u); err != nil {
			t.Fatal(err)
		}
	}
	// The baseline goes with the growth: a write that fails stores neither.
	execSQL(t, conn, "CREATE TRIGGER fail_sample BEFORE INSERT ON usage_samples BEGIN SELECT RAISE(ABORT, 'no'); END")
	u.Baseline = `{"v":2,"n":9}`
	if err := d.RecordUsage(ctx, u); err == nil {
		t.Fatal("the failing record passed")
	}
	execSQL(t, conn, "DROP TRIGGER fail_sample")
	if got := dump(t, conn, "SELECT usage_last FROM agents WHERE id = 'aus1'"); got != `{"v":2,"n":1}` {
		t.Errorf("baseline: %s", got)
	}
	if got := dump(t, conn, "SELECT agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, paid_estimate_usd, unreconciled_usd FROM usage"); got != "aus1|2026-10-20|claude|claude-opus-5-5||1.0|20|4|200|14|1.0|0.0" {
		t.Errorf("daily row: %s", got)
	}
	if got := dump(t, conn, "SELECT model, bucket, cost_usd, tokens_in FROM usage_samples ORDER BY model"); got != "|2026-10-20T10:05:00.000Z|0.5|10\nclaude-opus-5-5|2026-10-20T10:05:00.000Z|0.5|10" {
		t.Errorf("samples: %s", got)
	}
	if cost, err := d.AgentCost(ctx, "aus1"); err != nil || cost != 1 {
		t.Errorf("agent cost %v %v", cost, err)
	}
	if cost, err := d.AgentCost(ctx, "anone1"); err != nil || cost != 0 {
		t.Errorf("no usage: %v %v", cost, err)
	}

	r, zero := 1.7e9, 0.0
	r2 := r + 1
	for i, w := range []struct {
		used   float64
		resets *float64
		added  bool
	}{{40, &r, true}, {40, &r, false}, {41, &r, true}, {41, nil, true}, {41, nil, false}, {41, &zero, true}, {41, &r2, true}} {
		added, err := d.RecordWindowReading(ctx, "claude", "five_hour", w.used, w.resets, fmt.Sprintf("2026-10-20T10:0%d:00.000Z", i))
		if err != nil || added != w.added {
			t.Errorf("reading %d: added %v %v, want %v", i, added, err, w.added)
		}
	}
	if _, err := d.RecordWindowReading(ctx, "claude", "seven_day", 41, &r, "2026-09-01T00:00:00.000Z"); err != nil {
		t.Fatal(err)
	}
	if err := d.SaveSubscription(ctx, "claude", `{"a":1}`, "2026-10-20T10:00:00.000Z"); err != nil {
		t.Fatal(err)
	}
	if err := d.SaveSubscription(ctx, "claude", `{"a":2}`, "2026-10-20T11:00:00.000Z"); err != nil {
		t.Fatal(err)
	}
	if data, at, ok, err := d.Subscription(ctx, "claude"); err != nil || !ok || data != `{"a":2}` || at != "2026-10-20T11:00:00.000Z" {
		t.Errorf("subscription %q %q %v %v", data, at, ok, err)
	}
	if _, _, ok, err := d.Subscription(ctx, "codex"); err != nil || ok {
		t.Errorf("no subscription: %v %v", ok, err)
	}

	execSQL(t, conn, "INSERT INTO usage_samples (agent_id, harness, bucket) VALUES ('aus1', 'claude', '2026-09-01T00:00:00.000Z')")
	if err := d.PruneUsage(ctx, "2026-10-01T00:00:00.000Z"); err != nil {
		t.Fatal(err)
	}
	if n, m := count(t, conn, "SELECT COUNT(*) FROM usage_samples"), count(t, conn, "SELECT COUNT(*) FROM window_readings"); n != 2 || m != 5 {
		t.Errorf("after pruning: %d samples, %d readings", n, m)
	}

	newTestAgent(t, d, "aus2", "reader")
	execSQL(t, conn, "INSERT INTO mail (id, thread_id, from_id, subject, body, created_at) VALUES ('m1', 'm1', 'human', 's', 'b', '2026-10-20T00:00:00.000Z'), ('m2', 'm2', 'human', 's', 'b', '2026-10-20T00:00:00.000Z'), ('m3', 'm3', 'human', 's', 'b', '2026-10-20T00:00:00.000Z'), ('m4', 'm4', 'human', 's', 'b', '2026-10-20T00:00:00.000Z')")
	execSQL(t, conn, "INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('m1', 'aus2'), ('m2', 'aus2'), ('m3', 'aus2'), ('m4', 'aus2')")
	execSQL(t, conn, "UPDATE mail_recipients SET read_at = '2026-10-20T00:00:00.000Z' WHERE mail_id = 'm3'")
	execSQL(t, conn, "INSERT INTO thread_defer_mail (mailbox_id, thread_id, mail_id) VALUES ('aus2', 'm2', 'm2')")
	if n, err := d.UnreadCount(ctx, "aus2"); err != nil || n != 2 {
		t.Errorf("unread %d %v", n, err)
	}
}

// TestAgentObserver: a lifecycle or activity change reaches the observer after its write commits, archived when the
// lifecycle became archived; the same value again, another column, a write that fails, and a missed claim don't.
func TestAgentObserver(t *testing.T) {
	ctx := context.Background()
	d := openTest(t, testDB(t))
	newTestAgent(t, d, "aobs1", "watched")
	var heard []string
	d.ObserveAgents(func(id string, archived bool) {
		// After the commit: the change reads back.
		a, err := d.GetAgent(ctx, id)
		if err != nil {
			t.Error(err)
		}
		heard = append(heard, fmt.Sprintf("%s:%s:%s:%v", id, a.Lifecycle, a.Activity, archived))
	})
	step := func(fields ...Field) {
		t.Helper()
		if err := d.UpdateAgent(ctx, "aobs1", fields...); err != nil {
			t.Fatal(err)
		}
	}
	step(Field{"activity", "working"})
	step(Field{"activity", "working"}, Field{"activity_detail", "again"})
	step(Field{"context_tokens", 5})
	step(Field{"lifecycle", "active"}, Field{"activity", "idle"})
	step(Field{"lifecycle", "active"})
	if claimed, err := d.ClaimIdle(ctx, "aobs1", nil, "compacting"); err != nil || claimed {
		t.Fatalf("claimed an agent in another idle period: %v %v", claimed, err)
	}
	a, _ := d.GetAgent(ctx, "aobs1")
	if claimed, err := d.ClaimIdle(ctx, "aobs1", a.IdleSince, "compacting"); err != nil || !claimed {
		t.Fatalf("claim: %v %v", claimed, err)
	}
	step(Field{"lifecycle", "archived"})
	if err := d.UpdateAgent(ctx, "aobs1", Field{"activity", "idle"}, Field{"no_such", 1}); err == nil {
		t.Fatal("an update of a column that isn't updatable passed")
	}
	if err := d.Write(ctx, func(conn *sqlite.Conn) error {
		d.noteChanged("aobs1", false)
		return errors.New("rolled back")
	}); err == nil {
		t.Fatal("the failing write passed")
	}
	// A mail that clears the last declared wait takes a waiting agent idle (syncWaits).
	newTestAgent(t, d, "aobs2", "waiter")
	execSQL(t, rawConn(t, d.path), "INSERT INTO waits (id, agent_id, kind, since, source) VALUES ('w1', 'aobs2', 'human', 's', 'declared')")
	heard = append(heard, "|")
	if err := d.UpdateAgent(ctx, "aobs2", Field{"activity", "idle"}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.StoreMail(ctx, Stored{ID: "mw1", ThreadID: "mw1", From: "human", FromName: "human", Subject: "s", Body: "b", To: []string{"aobs2"}}); err != nil {
		t.Fatal(err)
	}
	want := "aobs1:active:working:false aobs1:active:idle:false aobs1:active:working:false aobs1:archived:working:true | aobs2:active:waiting:false aobs2:active:idle:false"
	if got := strings.Join(heard, " "); got != want {
		t.Errorf("heard %s\nwant  %s", got, want)
	}
}

// TestWritePanic: a write whose callback panics rolls back, gives the writer connection back, and tells the observer
// nothing; the next write still runs.
func TestWritePanic(t *testing.T) {
	ctx := context.Background()
	d := openTest(t, testDB(t))
	newTestAgent(t, d, "apan1", "panicky")
	var heard []string
	d.ObserveAgents(func(id string, archived bool) { heard = append(heard, id) })
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("the panic didn't reach the caller")
			}
		}()
		_ = d.Write(ctx, func(conn *sqlite.Conn) error {
			if err := sqlitex.Execute(conn, "UPDATE agents SET activity_detail = 'lost' WHERE id = 'apan1'", nil); err != nil {
				return err
			}
			d.noteChanged("apan1", false)
			panic("boom")
		})
	}()
	// A deadline, so a connection that never came back fails the test instead of hanging it.
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := d.UpdateAgent(wctx, "apan1", Field{"activity", "working"}); err != nil {
		t.Fatal(err)
	}
	a, err := d.GetAgent(ctx, "apan1")
	if err != nil {
		t.Fatal(err)
	}
	if a.ActivityDetail != nil || strings.Join(heard, " ") != "apan1" {
		t.Errorf("detail %v, heard %v", a.ActivityDetail, heard)
	}
}

// TestRecordUsageWhile: a report is decided on the row the transaction reads, and written only while ok holds for that row.
func TestRecordUsageWhile(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	newTestAgent(t, d, "aus2", "user1")
	u := Usage{AgentID: "aus2", Day: "2026-10-20", Bucket: "2026-10-20T10:05:00.000Z", Harness: "opencode", Cost: 1, In: 5, Baseline: `{"v":2,"cost":1}`}
	seen := ""
	plan := func(a Agent) UsageChange {
		seen = deref(a.UsageLast)
		return UsageChange{Record: &u}
	}
	held, err := d.RecordUsageWhile(ctx, "aus2", func(Agent) bool { return false }, plan)
	if err != nil || held || seen != "" || dump(t, conn, "SELECT count(*) FROM usage") != "0" {
		t.Fatalf("refused: %v %v %q", held, err, seen)
	}
	held, err = d.RecordUsageWhile(ctx, "aus2", func(Agent) bool { return true }, plan)
	if err != nil || !held || dump(t, conn, "SELECT cost_usd, tokens_in FROM usage") != "1.0|5" {
		t.Fatalf("held: %v %v", held, err)
	}
	// The next plan sees the baseline the first left, and a baseline-only change records nothing.
	base := `{"v":2,"cost":1,"id":"s"}`
	if _, err := d.RecordUsageWhile(ctx, "aus2", func(Agent) bool { return true }, func(a Agent) UsageChange {
		seen = deref(a.UsageLast)
		return UsageChange{Baseline: &base}
	}); err != nil || seen != `{"v":2,"cost":1}` {
		t.Fatalf("second plan saw %q: %v", seen, err)
	}
	if got := dump(t, conn, "SELECT usage_last FROM agents WHERE id = 'aus2'"); got != base || dump(t, conn, "SELECT cost_usd FROM usage") != "1.0" {
		t.Errorf("baseline %s", got)
	}
}

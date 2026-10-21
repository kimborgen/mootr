package lifecycle

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// liveRec records what the lifecycle sends to the live stream.
type liveRec struct {
	mu   sync.Mutex
	sent []string
}

func (r *liveRec) Emit(event string, data any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, event)
	return nil
}

func (r *liveRec) AgentChanged(id string, patch *jsjson.Object) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, "changed:"+id+jsjson.Stringify(patch, ""))
}

func (r *liveRec) take() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := strings.Join(r.sent, " ")
	r.sent = nil
	return out
}

// query runs q on its own connection to the test's stam.db and returns its rows, columns joined by |.
func (l *live) query(q string, args ...any) string {
	l.t.Helper()
	conn, err := sqlite.OpenConn(filepath.Join(l.home, "stam.db"), sqlite.OpenReadOnly)
	if err != nil {
		l.t.Fatal(err)
	}
	defer conn.Close()
	var out []string
	err = sqlitex.Execute(conn, q, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
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
		l.t.Fatalf("%s: %v", q, err)
	}
	return strings.Join(out, "\n")
}

func (l *live) row(id, model string) {
	l.t.Helper()
	var m *string
	if model != "" {
		m = &model
	}
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: id, Name: "n-" + id, Role: "developer", Machine: "test-machine", Harness: "claude", Model: m, Cwd: l.work}); err != nil {
		l.t.Fatal(err)
	}
}

func num(v float64) *float64 { return &v }

// TestUsageReport: each counter grows its own line: a repeat records nothing, a counter not reported keeps its
// baseline, a drop restarts only that counter, a new session restarts the token counters (cost keeps its line), and an
// older baseline is replaced without recording. The growth lands in the day's row and the 5-minute sample, on the
// matched account, as paid estimate while a fresh window reads 100%, and the live stream hears of it.
func TestUsageReport(t *testing.T) {
	l := newLive(t)
	l.setSettings(`{"cost":{"accounts":{"max":{"match":{"harness":"claude","model":"claude-opus"},"paid":true},"other":{"match":{"harness":"claude","model":"claude-sonnet"}}}}}`)
	rec := &liveRec{}
	l.life.live = rec
	l.row("alpu1", "claude-opus-5-5")
	at := time.Date(2026, 10, 20, 10, 7, 30, 0, time.UTC)
	s1, s2 := "s1.jsonl", "s2.jsonl"
	report := func(r usageReport) {
		t.Helper()
		if err := l.life.reportUsage(l.ctx, l.agent("alpu1"), r, at); err != nil {
			t.Fatal(err)
		}
	}
	baseline := func() string { return deref(l.agent("alpu1").UsageLast) }
	daily := func() string {
		return l.query("SELECT day, account, model, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, paid_estimate_usd, unreconciled_usd FROM usage WHERE agent_id = 'alpu1'")
	}

	report(usageReport{counts: [5]*float64{num(1), num(10), num(5), num(100), num(50)}, session: &s1})
	if got := baseline(); got != `{"v":2,"id":"s1.jsonl","cost":1,"tin":10,"tout":5,"tcr":100,"tcw":50}` {
		t.Errorf("first baseline: %s", got)
	}
	if got := daily(); got != "2026-10-20|max|claude-opus-5-5|1.0|10|5|100|50|0.0|0.0" {
		t.Errorf("first row: %s", got)
	}
	if got := l.query("SELECT bucket, model, cost_usd FROM usage_samples WHERE agent_id = 'alpu1'"); got != "2026-10-20T10:05:00.000Z|claude-opus-5-5|1.0" {
		t.Errorf("sample: %s", got)
	}
	if got := rec.take(); got != "changed:alpu1{}" {
		t.Errorf("live: %q", got)
	}

	report(usageReport{counts: [5]*float64{num(1), num(10), num(5), num(100), num(50)}, session: &s1})
	if got := rec.take(); got != "" {
		t.Errorf("a repeat told the live stream: %q", got)
	}
	// Cost and input only: the other counters keep their baselines.
	report(usageReport{counts: [5]*float64{num(1.5), num(12)}})
	if got := baseline(); got != `{"v":2,"id":"s1.jsonl","cost":1.5,"tin":12,"tout":5,"tcr":100,"tcw":50}` {
		t.Errorf("partial baseline: %s", got)
	}
	// A new session: the token counters start over (20 is all new, not 8 more), cost keeps its line.
	report(usageReport{counts: [5]*float64{num(2), num(20)}, session: &s2})
	if got := baseline(); got != `{"v":2,"id":"s2.jsonl","cost":2,"tin":20,"tout":0,"tcr":0,"tcw":0}` {
		t.Errorf("new session baseline: %s", got)
	}
	// A drop restarts only that counter.
	report(usageReport{counts: [5]*float64{num(0.25), num(24)}, session: &s2})
	if got := daily(); got != "2026-10-20|max|claude-opus-5-5|2.25|36|5|100|50|0.0|0.0" {
		t.Errorf("after the restarts: %s", got)
	}

	// A fresh window at 100% that hasn't reset: the cost growth is paid estimate on a paid account.
	reset := float64(time.Now().Add(time.Hour).Unix())
	if err := l.db.SaveSubscription(l.ctx, "claude", fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%v}}`, reset), iso(time.Now())); err != nil {
		t.Fatal(err)
	}
	report(usageReport{counts: [5]*float64{num(1.25)}, session: &s2})
	if got := daily(); got != "2026-10-20|max|claude-opus-5-5|3.25|36|5|100|50|1.0|0.0" {
		t.Errorf("paid estimate: %s", got)
	}
	// A stale reading, or one whose window has reset, isn't.
	for _, sub := range []struct{ data, at string }{
		{fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%v}}`, reset), iso(time.Now().Add(-16 * time.Minute))},
		{fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%v}}`, float64(time.Now().Add(-time.Minute).Unix())), iso(time.Now())},
		{`{"five_hour":{"used_percentage":99}}`, iso(time.Now())},
	} {
		if err := l.db.SaveSubscription(l.ctx, "claude", sub.data, sub.at); err != nil {
			t.Fatal(err)
		}
		if l.life.windowAt100(l.ctx, "claude", time.Now()) {
			t.Errorf("at 100%%: %s at %s", sub.data, sub.at)
		}
	}

	// An older baseline is replaced from this report, recording nothing.
	l.set("alpu1", db.Field{Col: "usage_last", Val: `{"v":1,"cost":100}`})
	rec.take()
	report(usageReport{counts: [5]*float64{num(9), num(9)}, session: &s1})
	if got := baseline(); got != `{"v":2,"id":"s1.jsonl","cost":9,"tin":9}` {
		t.Errorf("seeded baseline: %s", got)
	}
	if got := daily(); got != "2026-10-20|max|claude-opus-5-5|3.25|36|5|100|50|1.0|0.0" {
		t.Errorf("the seed recorded: %s", got)
	}
	if got := rec.take(); got != "" {
		t.Errorf("the seed told the live stream: %q", got)
	}

	// Another model bills to its own account; an OpenRouter account's cost is unreconciled.
	l.row("alpu2", "claude-sonnet-5-5")
	if err := l.life.reportUsage(l.ctx, l.agent("alpu2"), usageReport{counts: [5]*float64{num(2)}}, at); err != nil {
		t.Fatal(err)
	}
	l.setSettings(`{"cost":{"accounts":{"openrouter":{"match":{"harness":"claude","model":"claude-sonnet"}},"oc":{"match":{"harness":"opencode","model":"openrouter/"}}}}}`)
	if err := l.life.reportUsage(l.ctx, l.agent("alpu2"), usageReport{counts: [5]*float64{num(3)}}, at.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if got := l.query("SELECT day, account, cost_usd, unreconciled_usd FROM usage WHERE agent_id = 'alpu2' ORDER BY day"); got != "2026-10-20|other|2.0|0.0\n2026-10-21|openrouter|1.0|1.0" {
		t.Errorf("accounts: %s", got)
	}
	set := l.life.settings.Get()
	if !orAccount(set, "openrouter") || !orAccount(set, systemAccount) || !orAccount(set, "oc") || orAccount(set, "other") || orAccount(set, "") {
		t.Error("orAccount")
	}
	m := "openrouter/x"
	for _, c := range []struct {
		acct config.CostAccount
		name string
		want bool
	}{
		{config.CostAccount{Harness: "opencode", Model: &m}, "ork", true},
		{config.CostAccount{Harness: "opencode"}, "ork", false},
		{config.CostAccount{Harness: "opencode"}, "openrouter", true},
		{config.CostAccount{Harness: "claude", Model: &m}, "ork", false},
		{config.CostAccount{Harness: "claude"}, systemAccount, true},
	} {
		if isOpenRouter(c.acct, c.name) != c.want {
			t.Errorf("isOpenRouter(%+v, %s) != %v", c.acct, c.name, c.want)
		}
	}
}

// TestStatusLineUsage: a Claude Code status line records its cost and the transcript's tokens, keyed on the session;
// its windows are stored first, each change of a window gets a reading, an unchanged reading tells the web nothing, and
// the same reading again within 10 s isn't stored.
func TestStatusLineUsage(t *testing.T) {
	l := newLive(t)
	rec := &liveRec{}
	l.life.live = rec
	l.row("alpv1", "")
	file := filepath.Join(l.base, "alpv1.jsonl")
	appendFile(t, file, `{"type":"assistant","message":{"id":"t1","usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":300,"cache_creation_input_tokens":20}}}`+"\n")
	// Every report hands in the row as it was before the first: the work reads the agent's baseline itself.
	stale := l.agent("alpv1")
	report := func(cost float64, used float64) {
		t.Helper()
		p, err := jsjson.Parse([]byte(fmt.Sprintf(`{"transcript_path":%q,"cost":{"total_cost_usd":%v},"rate_limits":{"five_hour":{"used_percentage":%v,"resets_at":1800000000},"seven_day":{"used_percentage":5}}}`, file, cost, used)))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := l.life.OnStatusLine(l.ctx, "claude", stale, p); err != nil {
			t.Fatal(err)
		}
	}
	report(0.5, 40)
	if got := l.query("SELECT account, model, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write FROM usage WHERE agent_id = 'alpv1'"); got != "|NULL|0.5|10|4|300|20" {
		t.Errorf("usage: %s", got)
	}
	if got := deref(l.agent("alpv1").UsageLast); got != fmt.Sprintf(`{"v":2,"id":%q,"cost":0.5,"tin":10,"tout":4,"tcr":300,"tcw":20}`, file) {
		t.Errorf("baseline: %s", got)
	}
	if got := rec.take(); got != "usage.changed changed:alpv1{}" {
		t.Errorf("live: %q", got)
	}
	appendFile(t, file, `{"type":"assistant","message":{"id":"t2","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`+"\n")
	report(0.75, 40)
	if got := rec.take(); got != "changed:alpv1{}" {
		t.Errorf("an unchanged reading: %q", got)
	}
	report(0.75, 41)
	report(0.75, 41) // the gate skips it; it's the same within 10 s anyway
	if got := l.query("SELECT name, window, used_percentage, resets_at FROM window_readings ORDER BY rowid"); got != "claude|five_hour|40.0|1800000000\nclaude|seven_day|5.0|NULL\nclaude|five_hour|41.0|1800000000" {
		t.Errorf("readings: %s", got)
	}
	if got := l.query("SELECT cost_usd, tokens_in FROM usage WHERE agent_id = 'alpv1'"); got != "0.75|11" {
		t.Errorf("usage after: %s", got)
	}
	// Stored again past the 10 s skip, an unchanged reading still tells the web nothing; a changed one does.
	rec.take()
	w, _ := jsjson.Parse([]byte(`{"five_hour":{"used_percentage":41,"resets_at":1800000000},"seven_day":{"used_percentage":5}}`))
	if err := l.life.reportSubscription(l.ctx, "claude", w.(*jsjson.Object), time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := rec.take(); got != "" {
		t.Errorf("an unchanged reading told the web: %q", got)
	}
	w, _ = jsjson.Parse([]byte(`{"five_hour":{"used_percentage":41,"resets_at":1800000000},"seven_day":{"used_percentage":6}}`))
	if err := l.life.reportSubscription(l.ctx, "claude", w.(*jsjson.Object), time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := rec.take(); got != "usage.changed" {
		t.Errorf("a changed reading: %q", got)
	}
	w, _ = jsjson.Parse([]byte(`{"five_hour":{"used_percentage":41,"resets_at":1800000000},"seven_day":{"used_percentage":5}}`))
	if err := l.life.reportSubscription(l.ctx, "claude", w.(*jsjson.Object), time.Now()); err != nil {
		t.Fatal(err)
	}
	rec.take()
	// The same reading within 10 s from another agent's report isn't stored again.
	l.row("alpv2", "")
	before := l.query("SELECT updated_at FROM subscriptions WHERE name = 'claude'")
	p, _ := jsjson.Parse([]byte(`{"rate_limits":{"five_hour":{"used_percentage":41,"resets_at":1800000000},"seven_day":{"used_percentage":5}}}`))
	if _, err := l.life.OnStatusLine(l.ctx, "claude", l.agent("alpv2"), p); err != nil {
		t.Fatal(err)
	}
	if after := l.query("SELECT updated_at FROM subscriptions WHERE name = 'claude'"); after != before {
		t.Errorf("a repeat within 10 s was stored: %s, then %s", before, after)
	}
}

// TestUsageReportAtomic: a report whose growth can't be recorded leaves the baseline as it was, so the next report
// counts that growth, once.
func TestUsageReportAtomic(t *testing.T) {
	l := newLive(t)
	l.row("alpx1", "claude-opus-5-5")
	at := time.Date(2026, 10, 20, 10, 7, 30, 0, time.UTC)
	s1 := "s1.jsonl"
	report := func(cost float64) error {
		return l.life.reportUsage(l.ctx, l.agent("alpx1"), usageReport{counts: [5]*float64{num(cost), num(10)}, session: &s1}, at)
	}
	if err := report(1); err != nil {
		t.Fatal(err)
	}
	execOn(t, l, "CREATE TRIGGER fail_sample BEFORE INSERT ON usage_samples BEGIN SELECT RAISE(ABORT, 'no'); END")
	if err := report(3); err == nil {
		t.Fatal("the failing report passed")
	}
	if got := deref(l.agent("alpx1").UsageLast); got != `{"v":2,"id":"s1.jsonl","cost":1,"tin":10,"tout":0,"tcr":0,"tcw":0}` {
		t.Fatalf("baseline after the failure: %s", got)
	}
	execOn(t, l, "DROP TRIGGER fail_sample")
	if err := report(3); err != nil {
		t.Fatal(err)
	}
	if got := l.query("SELECT cost_usd, tokens_in FROM usage WHERE agent_id = 'alpx1'"); got != "3.0|10" {
		t.Errorf("daily row: %s", got)
	}
}

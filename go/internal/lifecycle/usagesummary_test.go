package lifecycle

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// UsageSummary over the same rows as src/usage.ts summary (testdata/usageref.mjs on a copy of the database, its clock
// fixed at summaryNow), compared as JSON text: the window shares, worth, history and projection from a calibrated
// Claude window, the trees (a manager with two developers, one also adopted by a second root, and an untyped root),
// the spend tables in every unit, stam's decide spend by purpose, the blocked list, the cold-cache summary and the
// agent types, unfiltered and with an agents= filter.

const summarySettings = `{"cost":{"accounts":{"max":{"match":{"harness":"claude"}},"codex":{"match":{"harness":"codex"}},` +
	`"or":{"match":{"harness":"opencode","model":"openrouter/"}}},"display":{"mode":"five_hour","prices":{"max":200}},"instructions":"keep it cheap"}}`

const summaryRegistry = `{"prices":{"claude-opus-5-5":{"input":4,"output":20,"cacheRead":0.2,"cacheWrite":5},"claude-haiku-5-5":{"input":1,"output":5}}}`

// summaryNow is a Wednesday noon UTC.
var summaryNow = float64(time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC).UnixMilli())

// summaryTypes is typeOf over the shipped registry with no chief of staff: a registry type, an assistant, the intake,
// else untyped.
func summaryTypes(a db.Agent) string {
	switch {
	case a.Type != nil && map[string]bool{"developer": true, "manager": true, "reviewer": true}[*a.Type]:
		return *a.Type
	case a.Kind != nil && *a.Kind == "assistant":
		return "assistant"
	case a.Name == "intake" && (a.Type == nil || *a.Type == ""):
		return "intake"
	}
	return "untyped"
}

func summaryFixture(t *testing.T) *live {
	l, _ := newCostLive(t, summarySettings)
	if err := os.WriteFile(filepath.Join(l.home, "registry.json"), []byte(summaryRegistry), 0o600); err != nil {
		t.Fatal(err)
	}
	opus, haiku := "claude-opus-5-5", "claude-haiku-5-5"
	for _, a := range []struct {
		id, name, typ, parent, harness string
		model                          *string
	}{
		{"sr", "s-root", "manager", "", "claude", &opus},
		{"sd1", "s-dev-one", "developer", "sr", "claude", &opus},
		{"sd2", "s-dev-two", "developer", "sr", "claude", &haiku},
		{"so", "s-other", "", "", "opencode", nil},
		{"sx", "s-codex", "", "", "codex", nil},
	} {
		var p *string
		if a.parent != "" {
			p = &a.parent
		}
		if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: a.id, Name: a.name, Role: "test", Machine: "test-machine", Harness: a.harness, Model: a.model, Cwd: l.work, ParentID: p}); err != nil {
			t.Fatal(err)
		}
		l.set(a.id, db.Field{Col: "lifecycle", Val: "active"}, db.Field{Col: "activity", Val: "idle"})
		if a.typ != "" {
			l.set(a.id, db.Field{Col: "type", Val: a.typ})
		}
	}
	l.exec("INSERT INTO agent_parents (child_id, parent_id) VALUES ('sd2', 'so')")
	at := func(minutesAgo float64) string { return isoMs(summaryNow - minutesAgo*60_000) }
	day := func(daysAgo int) string { return utcDay(summaryNow - float64(daysAgo)*dayMs) }
	resets := strconv.FormatFloat(summaryNow/1000+3600, 'f', -1, 64)
	// A Claude window rising over four hours, with the developers' samples between the readings.
	for i, used := range []float64{10, 12, 15, 15, 19, 24, 26, 31} {
		m := float64(240 - i*30)
		l.exec("INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES ('claude', 'five_hour', ?, ?, ?)", at(m), used, resets)
		if i > 0 {
			bucket := isoMs(floorBucket(summaryNow - (m+10)*60_000))
			l.exec("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out) VALUES ('sd1', 'max', 'claude', ?, ?, 0.5, ?, ?)", opus, bucket, 1000*(i+1), 200)
			if i%2 == 0 {
				l.exec("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out) VALUES ('sd2', 'max', 'claude', ?, ?, 0.1, 5000, 400)", haiku, bucket)
			}
		}
	}
	l.exec("INSERT INTO subscriptions (name, data, updated_at) VALUES ('claude', ?, ?)", `{"five_hour":{"used_percentage":31,"resets_at":`+resets+`}}`, at(1))
	l.exec("INSERT INTO subscriptions (name, data, updated_at) VALUES ('codex', ?, ?)", `{"primary":{"used_percentage":40,"resets_at":`+resets+`}}`, at(3))
	for _, u := range []struct {
		agent, day, harness, account string
		model                        any
		cost                         float64
		in, out, cr                  int
	}{
		{"sd1", day(0), "claude", "max", opus, 2.5, 4000, 900, 10000},
		{"sd1", day(3), "claude", "max", opus, 1.25, 100, 50, 0},
		{"sd2", day(0), "claude", "max", haiku, 0.4, 20000, 1600, 0},
		{"sr", day(9), "claude", "max", opus, 3, 10, 10, 10},
		{"so", day(1), "opencode", "or", "openrouter/x", 0.3333, 10, 1, 0},
		{"sx", day(0), "codex", "codex", nil, 0, 500, 50, 25},
		{"stam", day(0), "openrouter", "openrouter-system", "intake", 0.01, 300, 20, 0},
		{"gone", day(20), "claude", "max", opus, 9, 1, 1, 1},
	} {
		l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			u.agent, u.day, u.harness, u.model, u.account, u.cost, u.in, u.out, u.cr)
	}
	for _, e := range []struct{ agent, ts, typ, data string }{
		{"stam", at(30), "decide", `{"purpose":"intake","cost":0.006,"tokens_in":200,"tokens_out":10}`},
		{"stam", at(60 * 30), "decide", `{"purpose":"intake","cost":0.004,"tokens_in":100,"tokens_out":10}`},
		{"stam", at(60 * 24 * 2), "decide", `{"purpose":"mail-check","cost":0.02,"tokens_in":900}`},
		{"stam", at(10), "decide", `{"purpose":"other","provider":"zed","cost":5}`},
		{"sd1", at(50), "cache:cold", `{"tokens":40000,"context":45000,"cause":"wake"}`},
		{"sd2", at(40), "cache:cold", `{"context":1000,"cause":"compact"}`},
		{"sd2", at(20), "cache:ttl", `{"ttl":"5m"}`},
		{"sd1", at(20), "cache:ttl", `{"ttl":"1h"}`},
	} {
		l.exec("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, ?)", e.agent, e.ts, e.typ, e.data)
	}
	l.exec("INSERT INTO blockers (agent_id, kind, account, reason, since, clear) VALUES ('sd1', 'window', 'max', 'full', ?, ?)", at(5), `{"resets_at":"x"}`)
	l.exec("INSERT INTO blockers (agent_id, kind, account, reason, since, clear) VALUES ('ghost', 'manual', '', 'held', ?, NULL)", at(9))
	return l
}

func TestUsageSummaryMatchesTS(t *testing.T) {
	for _, c := range []struct {
		days float64
		keep []string
	}{{14, nil}, {1, nil}, {7, []string{"developer"}}, {30, []string{"untyped", "manager"}}} {
		l := summaryFixture(t)
		var keep map[string]bool
		keepJSON := "null"
		if c.keep != nil {
			keep = setOf(c.keep)
			b, _ := json.Marshal(c.keep)
			keepJSON = string(b)
		}
		got, err := l.life.UsageSummary(l.ctx, SummaryOptions{Days: c.days, Keep: keep, TypeOf: summaryTypes, Now: summaryNow})
		if err != nil {
			t.Fatal(err)
		}
		g := jsjson.Stringify(got, "")
		w := usageRef(t, l, summarySettings, summaryRegistry, summaryNow, "summary", "", strconv.FormatFloat(c.days, 'f', -1, 64), keepJSON)
		if g != w {
			t.Errorf("days %v keep %v: summary differs\n go: %s\n ts: %s", c.days, c.keep, g, w)
			continue
		}
		// What the comparison stands on: a calibrated window with a worth and shares, and the trees nested.
		for _, want := range []string{`"worth_usd":{"low":`, `"by_tree":[{"root":"s-root"`, `"children":[{"id":"sd`} {
			if c.keep == nil && !strings.Contains(g, want) {
				t.Errorf("days %v: summary lacks %s: %s", c.days, want, g)
			}
		}
	}
}

// treeSummary over the snapshot's windows, as src/usage.ts summary's tree view builds it (without the allocations and
// typical issue treeView adds): a manager's tree, a root that adopted a developer, a leaf, and an agent with no share.
func TestTreeSummaryMatchesTS(t *testing.T) {
	l := summaryFixture(t)
	reads, err := l.life.AccountReadings(l.ctx, summaryNow)
	if err != nil {
		t.Fatal(err)
	}
	snap, err := l.life.snapshotOf(l.ctx, reads, 14, summaryNow)
	if err != nil {
		t.Fatal(err)
	}
	x, err := l.life.treeIndex(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"sr", "so", "sd2", "sx"} {
		g := jsjson.Stringify(treeSummary(x, id, summaryNow, snap.windows), "")
		w := usageRef(t, l, summarySettings, summaryRegistry, summaryNow, "tree", "", "14", id)
		if g != w {
			t.Errorf("tree %s differs\n go: %s\n ts: %s", id, g, w)
		}
		// What the comparison stands on: the manager's tree, its members and its share.
		if id == "sr" && !strings.Contains(g, `"members":["s-root","s-dev-two","s-dev-one"],"accounts":{"max":{"five_hour":{"estimate":true,"since":"2026-10-21T08:00:00.000Z","percent":17.85`) {
			t.Errorf("tree sr lacks its members or share: %s", g)
		}
	}
}

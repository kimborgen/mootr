package server

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"stam/internal/db"
)

// TestCostAck: POST /api/cost/ack records the ack by the agent named (by), or by the human with no by; a second ack and
// an unknown event answer ok false, an unknown agent 404s, and with auth.humanStrict a request with no by that doesn't
// come from the human is refused.
func TestCostAck(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	ctx := context.Background()
	for _, id := range []string{"cn-1", "cn-2"} {
		if _, err := f.db.AddCostNotice(ctx, db.CostNotice{ID: id, Key: id, Kind: "blocker-set", Managers: []string{"aboss"}, CreatedAt: "2026-10-22T00:00:00.000Z"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name, token, body string
		status            int
		want              string
	}{
		{"the manager", agentTok, `{"event":"cn-1","by":"achild"}`, 200, `{"ok":true,"event":"cn-1"}`},
		{"again", agentTok, `{"event":"cn-1","by":"achild"}`, 200, `{"ok":false,"error":"cn-1 was already acknowledged by achild"}`},
		{"an unknown event", agentTok, `{"event":"cn-9","by":"achild"}`, 200, `{"ok":false,"error":"no cost notice cn-9"}`},
		{"an unknown agent", sharedTok, `{"event":"cn-2","by":"anone"}`, 404, "no agent anone"},
		{"an agent for another", agentTok, `{"event":"cn-2","by":"aboss"}`, 403, "agent child can't act as aboss"},
		{"the human", sharedTok, `{"event":"cn-2"}`, 200, `{"ok":true,"event":"cn-2"}`},
	} {
		rec := f.do(call{method: "POST", path: "/api/cost/ack", token: tc.token, body: tc.body})
		if rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("%s: %d %s, want %d %s", tc.name, rec.Code, rec.Body.String(), tc.status, tc.want)
		}
	}
	if n, _, _ := f.db.CostNoticeByID(ctx, "cn-2"); n.AckedBy == nil || *n.AckedBy != "human" {
		t.Errorf("cn-2 acked by %v", n.AckedBy)
	}
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"auth":{"humanStrict":true}}`), 0o600))
	rec := f.do(call{method: "POST", path: "/api/cost/ack", token: sharedTok, body: `{"event":"cn-2"}`})
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "a cost notice is acknowledged by an agent (by) or the human") {
		t.Errorf("strict: %d %s", rec.Code, rec.Body.String())
	}
}

// TestCostPause: POST /api/cost/pause pauses the tree for the agent named (by; an agent's own token names itself) or the
// human with no by; a caller that is neither, and a manager outside the tree, get a 403, a bad until a 400, and the
// human's clear lifts it.
func TestCostPause(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	// Stopped, so a blocker only records itself and no harness is touched.
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id IN ('achild', 'aboss')")
	until := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	human := map[string]string{"X-Stam-Human": "1"}
	for _, tc := range []struct {
		name, token string
		header      map[string]string
		body        string
		status      int
		want        string
	}{
		{"no by and not the human", sharedTok, nil, `{"tree":"achild","until":"reset"}`, 403, "cost_pause needs an agent (by) or the human"},
		{"outside its tree", agentTok, nil, `{"tree":"aboss","until":"reset"}`, 403, "may not manage cost for"},
		{"a bad until", sharedTok, human, `{"tree":"achild","until":"soon"}`, 400, `until must be \"reset\" or an ISO time, not \"soon\"`},
		{"an unknown agent", sharedTok, nil, `{"tree":"achild","by":"anone","until":"reset"}`, 404, "no agent anone"},
		{"its own tree", agentTok, nil, `{"tree":"achild","until":"` + until + `","reason":"quiet"}`, 200, `"action":"paused","agents":["child"],"until":"quiet","acked":[]`},
		{"the human's clear", sharedTok, human, `{"tree":"achild","clear":true}`, 200, `"action":"cleared","agents":["child"],"until":"","acked":[]`},
	} {
		rec := f.do(call{method: "POST", path: "/api/cost/pause", token: tc.token, header: tc.header, body: tc.body})
		if rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("%s: %d %s, want %d %s", tc.name, rec.Code, rec.Body.String(), tc.status, tc.want)
		}
	}
	if n := f.count("SELECT count(*) FROM events WHERE agent_id = 'achild' AND type = 'cost:pause'"); n != 2 {
		t.Errorf("%d cost:pause events", n)
	}
	if n := f.count("SELECT count(*) FROM blockers WHERE kind = 'manual'"); n != 0 {
		t.Errorf("%d manual blockers left", n)
	}
}

// TestCostAllocate: POST /api/cost/allocate sets an allocation for the agent named (by) or the human with no by, and
// acknowledges the tree's cost notices; a caller that is neither gets a 403, an unknown agent a 404, and a refusal or a
// malformed allocation a 400. GET /api/cost/allocations lists them with their use, or one tree's, and clear removes one.
func TestCostAllocate(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	ctx := context.Background()
	if _, err := f.db.AddCostNotice(ctx, db.CostNotice{ID: "cn-1", Key: "k1", Kind: "blocker-set", AgentID: ptr("achild"), Managers: []string{"aboss"}, CreatedAt: "2026-10-22T00:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	human := map[string]string{"X-Stam-Human": "1"}
	win := func(tree string, pct string) string {
		return `{"tree":"` + tree + `","account":"claude","kind":"window","window":"five_hour","percent":` + pct + `}`
	}
	for _, tc := range []struct {
		name, method, path, token string
		header                    map[string]string
		body                      string
		status                    int
		want                      string
		// before runs first: a notice raised after the set, so only the clear acknowledges it.
		before func()
	}{
		{"no by and not the human", "POST", "/api/cost/allocate", sharedTok, nil, win("achild", "10"), 403, "an allocation needs an agent (by) or the human", nil},
		{"an unknown agent", "POST", "/api/cost/allocate", sharedTok, nil, `{"by":"anone","tree":"achild"}`, 404, "no agent anone", nil},
		{"outside its tree", "POST", "/api/cost/allocate", agentTok, nil, win("aboss", "10"), 400, "child may set an allocation only on trees inside its own tree", nil},
		{"malformed", "POST", "/api/cost/allocate", sharedTok, human, `{"tree":"achild","account":"claude","kind":"days"}`, 400, "an allocation kind must be 'window' or 'usd'", nil},
		{"its own tree", "POST", "/api/cost/allocate", agentTok, nil, win("achild", "10"), 200, `"root_id":"achild","account":"claude","kind":"window","window":"five_hour","percent":10,"amount":null,"period":"","set_by":"achild"`, nil},
		{"the human, over its child", "POST", "/api/cost/allocate", sharedTok, human, win("aboss", "5"), 200, `"warning":"warning: the allocations of boss's children add up to 10%, over boss's own 5% on five_hour allocation; not refused."`, nil},
		{"the list", "GET", "/api/cost/allocations", sharedTok, nil, "", 200, `"root":"child","used":0,"used_percent":0,"projection":{"estimate":true,`, nil},
		{"a tree's", "GET", "/api/cost/allocations?tree=child", sharedTok, nil, "", 200, `{"allocations":[{"id":"al-`, nil},
		{"an unknown tree", "GET", "/api/cost/allocations?tree=anone", sharedTok, nil, "", 404, "no agent anone", nil},
		{"clear", "POST", "/api/cost/allocate", sharedTok, human, `{"clear":true,"tree":"child","account":"claude","window":"five_hour"}`, 200, `{"cleared":1}`, func() {
			if _, err := f.db.AddCostNotice(ctx, db.CostNotice{ID: "cn-2", Key: "k2", Kind: "blocker-set", AgentID: ptr("achild"), Managers: []string{"aboss"}, CreatedAt: "2026-10-22T00:01:00.000Z"}); err != nil {
				t.Fatal(err)
			}
		}},
		{"one tree", "GET", "/api/cost/allocations?tree=boss", sharedTok, nil, "", 200, `{"allocations":[{"id":"al-`, nil},
	} {
		if tc.before != nil {
			tc.before()
		}
		rec := f.do(call{method: tc.method, path: tc.path, token: tc.token, header: tc.header, body: tc.body})
		if rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("%s: %d %s, want %d %s", tc.name, rec.Code, rec.Body.String(), tc.status, tc.want)
		}
	}
	if rec := f.do(call{method: "GET", path: "/api/cost/allocations?tree=child", token: sharedTok}); strings.Contains(rec.Body.String(), `"id":"al-`) {
		t.Errorf("the cleared tree's: %s", rec.Body.String())
	}
	if rec := f.do(call{method: "GET", path: "/api/cost/allocations?tree=boss", token: sharedTok}); strings.Count(rec.Body.String(), `"id":"al-`) != 1 || !strings.Contains(rec.Body.String(), `"root_id":"aboss"`) {
		t.Errorf("one tree's: %s", rec.Body.String())
	}
	if n := f.count(`SELECT count(*) FROM events WHERE agent_id = 'achild' AND type = 'cost:ack' AND data = '{"event":"cn-1","via":"cost_allocate"}'`); n != 1 {
		t.Errorf("%d acks of the tree's notice", n)
	}
	// The clear (the human's, so no cost:ack event, which goes to an agent that acks) acknowledged the notice raised
	// after the sets.
	if n := f.count(`SELECT count(*) FROM cost_notices WHERE id = 'cn-2' AND acked_by = 'human' AND acked_at IS NOT NULL`); n != 1 {
		t.Errorf("the clear left the notice raised before it open (%d)", n)
	}
}

// TestSpawnInheritsPause: an agent spawned into a paused tree carries the pause before its launch (which fails here, after
// the attach, for want of a registry).
func TestSpawnInheritsPause(t *testing.T) {
	f := newFixture(t, nil)
	real, err := filepath.Abs("../../..")
	must(t, err)
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "registry"), 0o755))
	defaults, err := os.ReadFile(filepath.Join(real, "registry", "defaults.json"))
	must(t, err)
	must(t, os.WriteFile(filepath.Join(root, "registry", "defaults.json"), defaults, 0o644))
	for _, dir := range []string{"templates", "blocks"} {
		must(t, os.CopyFS(filepath.Join(root, dir), os.DirFS(filepath.Join(real, dir))))
	}
	withLifeRoot(f, root)
	f.srv.tpl.Root = root
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"itsa":{"required":false}}`), 0o600))
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE lifecycle = 'active'")
	until := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	if rec := f.do(call{method: "POST", path: "/api/cost/pause", token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}, body: `{"tree":"aboss","until":"` + until + `","reason":"quiet"}`}); rec.Code != 200 {
		t.Fatalf("pause: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{method: "POST", path: "/api/agents", token: sharedTok, body: `{"name":"x4","harness":"claude","parent":"aboss","cwd":"` + f.home + `"}`}); rec.Code < 400 || strings.Contains(rec.Body.String(), "internal error") {
		t.Errorf("the launch: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT count(*) FROM blockers WHERE agent_id = (SELECT id FROM agents WHERE name = 'x4') AND kind = 'manual' AND reason = 'quiet'"); n != 1 {
		t.Errorf("x4 has %d manual blockers", n)
	}
	if n := f.count(`SELECT count(*) FROM events WHERE agent_id = (SELECT id FROM agents WHERE name = 'x4') AND type = 'cost:pause' AND data = '{"action":"inherited","by":"human","reason":"quiet"}'`); n != 1 {
		t.Errorf("x4 has %d inherited events", n)
	}
}

// TestSpawnHeldByBudget: a spawn onto a spent budget carries the budget blocker before its launch (src/budgets.ts
// attachSpawn; the Go daemon has no spawn refusal yet, S-3545).
func TestSpawnHeldByBudget(t *testing.T) {
	f := newFixture(t, nil)
	real, err := filepath.Abs("../../..")
	must(t, err)
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "registry"), 0o755))
	defaults, err := os.ReadFile(filepath.Join(real, "registry", "defaults.json"))
	must(t, err)
	must(t, os.WriteFile(filepath.Join(root, "registry", "defaults.json"), defaults, 0o644))
	for _, dir := range []string{"templates", "blocks"} {
		must(t, os.CopyFS(filepath.Join(root, dir), os.DirFS(filepath.Join(real, dir))))
	}
	withLifeRoot(f, root)
	f.srv.tpl.Root = root
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"itsa":{"required":false},"cost":{"accounts":{"max":{"match":{"harness":"claude"},"paid":true,"budget":{"usd":1,"per":"cap"}}}}}`), 0o600))
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE lifecycle = 'active'")
	f.sql("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, paid_estimate_usd) VALUES ('achild', '2026-10-01', 'claude', NULL, 'max', 3, 2)")
	if rec := f.do(call{method: "POST", path: "/api/agents", token: sharedTok, body: `{"name":"x5","harness":"claude","parent":"aboss","cwd":"` + f.home + `"}`}); rec.Code < 400 || strings.Contains(rec.Body.String(), "internal error") {
		t.Errorf("the launch: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT count(*) FROM blockers WHERE agent_id = (SELECT id FROM agents WHERE name = 'x5') AND kind = 'budget' AND account = 'max' AND reason = 'The max cap of $1 is spent'"); n != 1 {
		t.Errorf("x5 has %d budget blockers", n)
	}
}

// TestControlCancelsFallbacks: the shutdown and kill actions end the agent's pending cost fallbacks, as
// src/lifecycle.ts explicitShutdown does; a restart doesn't.
func TestControlCancelsFallbacks(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	ctx := context.Background()
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'achild'")
	for _, id := range []string{"cn-1", "cn-2"} {
		must(t, f.db.ArmFallback(ctx, db.CostFallback{NoticeID: id, AgentID: "achild", Kind: "error", Account: "max", BlockerSince: "s", DueAt: 1}))
	}
	f.do(call{method: "POST", path: "/api/agents/achild/restart", token: sharedTok, body: `{}`})
	if r, _, _ := f.db.Fallback(ctx, "cn-1"); r.State != "pending" {
		t.Errorf("a restart ended it: %s", r.State)
	}
	f.do(call{method: "POST", path: "/api/agents/achild/shutdown", token: sharedTok, body: `{}`})
	for _, id := range []string{"cn-1", "cn-2"} {
		if r, _, _ := f.db.Fallback(ctx, id); r.State != "done" || r.Result == nil || *r.Result != "skipped: the agent was shut down" {
			t.Errorf("%s: %s %v", id, r.State, r.Result)
		}
	}
}

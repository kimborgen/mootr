package server

import (
	"context"
	"strings"
	"testing"
)

// TestPermissionModesRoutes: the stale list holds the agents that follow the settings on another mode than the settings
// give them, running or left shut down by a failed switch; the human's settings change is logged with them; only the
// human applies, and an OpenCode agent is skipped for its next session.
func TestPermissionModesRoutes(t *testing.T) {
	f := controlFixture(t)
	f.sql("UPDATE agents SET lifecycle = 'shut_down', permission_mode = 'auto', permission_source = 'manual'")
	f.sql("UPDATE agents SET harness = 'opencode', lifecycle = 'paused', permission_source = NULL WHERE id = 'acodex'")
	f.sql("UPDATE agents SET permission_source = 'settings' WHERE id = 'aboss'")
	f.sql(`INSERT INTO events (agent_id, ts, type, data) VALUES ('aboss', '2026-01-01T00:00:00.000Z', 'permission-mode:failed', '{"error":"test: launch of boss failed"}')`)
	get := func() string { return f.do(call{path: "/api/permission-modes", token: agentTok}).Body.String() }
	if body := get(); !strings.HasPrefix(body, `{"settings":{"harness":{"claude":"auto","codex":"auto","opencode":"auto"},"types":{}},"harnesses":{"claude":[{"mode":"default","label":"Ask"`) ||
		!strings.Contains(body, `"types":["`) || !strings.HasSuffix(body, `"stale":[]}`) {
		t.Errorf("before a change: %s", body)
	}
	patch := `{"patch":{"permissionModes":{"harness":{"claude":"bypass","opencode":"bypass"},"types":{}}}}`
	if rec := f.do(call{method: "PATCH", path: "/api/config/settings", header: humanHeader(), body: patch}); rec.Code != 200 {
		t.Fatalf("the settings change: %d %s", rec.Code, rec.Body)
	}
	body := get()
	if !strings.Contains(body, `{"id":"aboss","name":"boss","harness":"claude","type":null,"mode":"auto","want":"bypass","inPlace":true,"failed":"test: launch of boss failed"}`) ||
		!strings.Contains(body, `{"id":"acodex","name":"coder","harness":"opencode","type":null,"mode":"auto","want":"bypass","inPlace":false,"failed":null}`) || strings.Count(body, `"id":`) != 2 {
		t.Errorf("after the change: %s", body)
	}
	logged := f.text(`SELECT data FROM events WHERE agent_id = 'human' AND type = 'permission-modes'`)
	if !strings.HasPrefix(logged, `{"by":"human","before":{"harness":{"claude":"auto","codex":"auto","opencode":"auto"},"types":{}},"after":{"harness":{"claude":"bypass","codex":"auto","opencode":"bypass"},"types":{}},"stale":[`) {
		t.Errorf("the change's log: %s", logged)
	}
	// The same settings again log nothing.
	f.do(call{method: "PATCH", path: "/api/config/settings", header: humanHeader(), body: patch})
	if n := f.text(`SELECT count(*) FROM events WHERE type = 'permission-modes'`); n != "1" {
		t.Errorf("%s changes logged, not 1", n)
	}
	for _, h := range []map[string]string{nil, {"X-Stam-Human": "1"}} {
		if rec := f.do(call{method: "POST", path: "/api/permission-modes/apply", token: sharedTok, header: h, body: `{}`}); rec.Code != 403 || !strings.Contains(rec.Body.String(), "only the human can apply permission modes") {
			t.Errorf("apply without the human's proof: %d %s", rec.Code, rec.Body)
		}
	}
	// Only the OpenCode agent stays: it is skipped, and nothing is applied.
	f.sql("UPDATE agents SET permission_source = 'manual' WHERE id = 'aboss'")
	rec := f.do(call{method: "POST", path: "/api/permission-modes/apply", header: humanHeader(), body: `{}`})
	want := `{"applied":[],"skipped":[{"name":"coder","reason":"opencode keeps a session's permission rules; it starts in bypass at its next new session"}],"stale":[{"id":"acodex"`
	if rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), want) {
		t.Errorf("apply: %d %s", rec.Code, rec.Body)
	}
	if ev := f.text(`SELECT data FROM events WHERE type = 'permission-modes:apply'`); ev != `{"by":"human","applied":[],"skipped":[{"name":"coder","reason":"opencode keeps a session's permission rules; it starts in bypass at its next new session"}]}` {
		t.Errorf("the apply's log: %s", ev)
	}
}

// TestPermissionModesApplyRelaunch: an agent a failed switch left shut down is resumed by apply; when that launch fails
// too, even with the request canceled mid-launch (the tab closed), its old mode and source come back, the failure is
// its latest switch event and apply lists it as skipped. A running agent gets its restart queued instead.
func TestPermissionModesApplyRelaunch(t *testing.T) {
	f := controlFixture(t)
	f.sql("UPDATE agents SET lifecycle = 'shut_down', permission_mode = 'auto', permission_source = 'manual'")
	f.sql("UPDATE agents SET permission_source = 'settings', session_id = '11111111-2222-4333-8444-555555555555' WHERE id = 'aboss'")
	f.sql(`INSERT INTO events (agent_id, ts, type, data) VALUES ('aboss', '2026-01-01T00:00:00.000Z', 'permission-mode:failed', '{"error":"test: launch of boss failed"}')`)
	patch := `{"patch":{"permissionModes":{"harness":{"claude":"bypass"},"types":{}}}}`
	if rec := f.do(call{method: "PATCH", path: "/api/config/settings", header: humanHeader(), body: patch}); rec.Code != 200 {
		t.Fatalf("the settings change: %d %s", rec.Code, rec.Body)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.srv.life.SetFailLaunch([]string{"boss"})
	f.srv.life.SetOnFailLaunch(cancel)
	rec := f.do(call{method: "POST", path: "/api/permission-modes/apply", header: humanHeader(), body: `{}`, ctx: ctx})
	if rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), `{"applied":[],"skipped":[{"name":"boss","reason":"test: launch of boss failed"}],"stale":[{"id":"aboss"`) {
		t.Errorf("apply with a failing relaunch: %d %s", rec.Code, rec.Body)
	}
	if ctx.Err() == nil {
		t.Fatal("the relaunch never reached the launch")
	}
	if row := f.text("SELECT permission_mode || ' ' || permission_source || ' ' || lifecycle FROM agents WHERE id = 'aboss'"); row != "auto settings shut_down" {
		t.Errorf("boss after the failed relaunch: %s", row)
	}
	if ev := f.text("SELECT type FROM events WHERE agent_id = 'aboss' AND type LIKE 'permission-mode%' ORDER BY id DESC LIMIT 1"); ev != "permission-mode:failed" {
		t.Errorf("boss's latest switch event: %s", ev)
	}
	// A running agent that follows the settings: its restart waits for the end of its step, and the switch is logged.
	f.srv.life.SetFailLaunch(nil)
	f.sql("UPDATE agents SET permission_source = 'manual' WHERE id = 'aboss'")
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'working', permission_source = 'settings' WHERE id = 'achild'")
	rec = f.do(call{method: "POST", path: "/api/permission-modes/apply", header: humanHeader(), body: `{}`})
	if rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), `{"applied":[{"name":"`) || !strings.Contains(rec.Body.String(), `"mode":"bypass"`) {
		t.Errorf("apply to a running agent: %d %s", rec.Code, rec.Body)
	}
	if pending := f.text("SELECT pending_action FROM agents WHERE id = 'achild'"); !strings.HasPrefix(pending, `{"type":"restart","reason":"permission mode changed to bypass"`) {
		t.Errorf("the running agent's pending restart: %s", pending)
	}
	if ev := f.text("SELECT data FROM events WHERE agent_id = 'achild' AND type = 'permission-mode:applied'"); ev != `{"from":"auto","mode":"bypass","by":"human"}` {
		t.Errorf("the running agent's applied event: %s", ev)
	}
}

// TestPermissionModeNeedsProof: an agent's own token, with no proof of the human, can't switch a mode.
func TestPermissionModeNeedsProof(t *testing.T) {
	f := controlFixture(t)
	if rec := f.do(call{method: "POST", path: "/api/agents/achild/permission-mode", token: agentTok, body: `{"mode":"bypass"}`}); rec.Code != 403 {
		t.Errorf("an agent's token without the human's proof: %d %s", rec.Code, rec.Body)
	}
}

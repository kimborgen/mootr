package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/lifecycle"
	"stam/internal/push"
	"stam/internal/templates"
	"stam/internal/tmux"
)

const bossTok = "boss-token-value"

// withLife gives the fixture's server a lifecycle whose tmux calls all fail at once (/bin/false), so no route here
// reaches a tmux server, and a token for aboss.
func withLife(f *fixture) {
	f.t.Helper()
	// A templates root with no registry: a spawn that gets as far as the capabilities fails there.
	withLifeRoot(f, f.t.TempDir())
}

// withLifeRoot is withLife with the templates under root, and push streams.
func withLifeRoot(f *fixture, root string) {
	f.t.Helper()
	withLifeRootTmux(f, root, "/bin/false")
}

// withLifeRootTmux is withLifeRoot with the tmux binary bin. Pass sessionTmux(t) for a launch that must start and
// stop sessions: /bin/true has every session, even a killed one, so an archive always fails (S-4167).
func withLifeRootTmux(f *fixture, root, bin string) {
	f.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	settings := config.NewSettingsFile(f.home, f.cfg.Machine)
	// A launch renders the system prompt, which reads the settings and walks up to the user's home, and writes the
	// agent's files under STAM_HOME: a test home and the fixture's.
	userHome := f.t.TempDir()
	tpl := &templates.Set{Root: root, Home: f.home, UserHome: userHome, Settings: settings.Get, Machine: f.cfg.Machine}
	// No real claude or network: a compactor that runs fails at once, and recovery's network wait never answers.
	life := lifecycle.New(ctx, lifecycle.Options{DB: f.db, Tmux: &tmux.Client{Socket: "stam-test-none", Bin: bin},
		Settings: settings, Machine: f.cfg.Machine,
		Claude: claude.Env{Templates: tpl, ClaudeBin: "/bin/false", Home: f.home, UserHome: userHome}, NetworkProbes: []string{"http://127.0.0.1:1/"},
		Streams: push.New(), PushDebounce: 20 * time.Millisecond})
	f.t.Cleanup(func() { cancel(); life.Wait() })
	f.srv.life = life
	life.SetUnown(f.srv.unownAgent)
	life.SetStartingDead(f.srv.ringMemberDead)
	life.SetAgentGone(f.srv.eventsAgentGone)
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'aboss'", auth.Hash(bossTok))
}

// TestHookRoute: an agent's own token reports its own hooks, and nobody else's; the reply is {} with no stdout, and
// the hook moves the agent and records hook:EVENT.
func TestHookRoute(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	post := func(token, path, body string) (int, string) {
		rec := f.do(call{method: "POST", path: path, token: token, body: body})
		return rec.Code, rec.Body.String()
	}
	for _, tc := range []struct {
		name, token, path string
		status            int
		error             string
	}{
		{"an agent for another agent", agentTok, "/api/hook/claude/aboss", 403, "agent child can't act as aboss"},
		{"a parent for its child", bossTok, "/api/hook/claude/achild", 403, "agent boss can't act as achild"},
		{"the OpenCode server for a Claude agent", serverTok, "/api/hook/claude/achild", 403, "the OpenCode server can't act as achild"},
		{"an unknown agent", sharedTok, "/api/hook/claude/anone", 404, "no agent anone"},
		{"a bad harness", sharedTok, "/api/hook/cl.aude/achild", 404, "no route"},
		{"an unported harness", agentTok, "/api/hook/codex/achild", 501, "codex hooks aren't ported"},
	} {
		code, body := post(tc.token, tc.path, `{"hook_event_name":"UserPromptSubmit"}`)
		if code != tc.status || !strings.Contains(body, tc.error) {
			t.Errorf("%s: %d %s, want %d %q", tc.name, code, body, tc.status, tc.error)
		}
	}
	// The codex hook named the codex adapter: nothing moved, no event.
	if evs, _ := f.db.ListEvents(context.Background(), "achild", 50, "hook:*"); len(evs) != 0 {
		t.Fatalf("a refused hook recorded %d events", len(evs))
	}

	code, body := post(agentTok, "/api/hook/claude/achild", `{"hook_event_name":"PreToolUse","tool_name":"Bash","session_id":"s"}`)
	if code != 200 || body != "{}" {
		t.Fatalf("own hook: %d %q, want 200 {}", code, body)
	}
	a, err := f.db.GetAgent(context.Background(), "achild")
	must(t, err)
	if a.Activity != "working" || a.ActivityDetail == nil || *a.ActivityDetail != "tool Bash" {
		t.Errorf("after PreToolUse: %s %v", a.Activity, a.ActivityDetail)
	}
	evs, err := f.db.ListEvents(context.Background(), "achild", 50, "hook:*")
	must(t, err)
	if len(evs) != 1 || evs[0].Type != "hook:PreToolUse" || evs[0].Data == nil || *evs[0].Data != `{"activity":"working","detail":"tool Bash"}` {
		t.Errorf("events = %+v", evs)
	}
	// The shared token reports for any agent, as TS lets it; an event with no activity has no data.
	if code, body = post(sharedTok, "/api/hook/claude/achild", `{"hook_event_name":"Notification","notification_type":"other"}`); code != 200 || body != "{}" {
		t.Errorf("shared token hook: %d %q", code, body)
	}
	evs, _ = f.db.ListEvents(context.Background(), "achild", 1, "hook:Notification")
	if len(evs) != 1 || evs[0].Data != nil {
		t.Errorf("Notification events = %+v", evs)
	}
	// The token is never in what the route records or answers.
	all, _ := f.db.ListEvents(context.Background(), "achild", 1000, "")
	b, _ := json.Marshal(all)
	if strings.Contains(string(b), agentTok) {
		t.Error("an event holds the agent's token")
	}
}

// TestStatusLineRoute: self only; a report sets the context size and window, and nobody views a session tmux can't
// list clients of.
func TestStatusLineRoute(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	report := `{"context_window":{"context_window_size":200000,"current_usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30}}}`
	rec := f.do(call{method: "POST", path: "/api/statusline/claude/aboss", token: agentTok, body: report})
	if rec.Code != 403 {
		t.Errorf("another agent's status line: %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(call{method: "POST", path: "/api/statusline/claude/achild", token: agentTok, body: report})
	if rec.Code != 200 || rec.Body.String() != `{"viewed":false}` {
		t.Fatalf("own status line: %d %s", rec.Code, rec.Body.String())
	}
	a, err := f.db.GetAgent(context.Background(), "achild")
	must(t, err)
	if a.ContextTokens == nil || *a.ContextTokens != 60 || a.ContextWindow == nil || *a.ContextWindow != 200000 {
		t.Errorf("context = %v / %v", a.ContextTokens, a.ContextWindow)
	}
}

// TestControlRoutes: only the human and the assistant kill or forget; an agent's own token is refused, naming
// itself or not, unless it is the assistant.
func TestControlRoutes(t *testing.T) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	for _, action := range []string{"kill", "forget"} {
		for _, body := range []string{``, `{}`, `{"by":"achild"}`, `{"by":"aboss"}`} {
			rec := f.do(call{method: "POST", path: "/api/agents/achild/" + action, token: agentTok, body: body})
			if rec.Code != 403 {
				t.Errorf("%s by the agent's token %s: %d %s", action, body, rec.Code, rec.Body.String())
			}
		}
		if rec := f.do(call{method: "POST", path: "/api/agents/anone/" + action, token: sharedTok}); rec.Code != 404 {
			t.Errorf("%s of no agent: %d", action, rec.Code)
		}
	}
	// No lifecycle here: a caller that passes the boss check meets the 501 after it, and touches nothing.
	f.sql("UPDATE agents SET kind = 'assistant' WHERE id = 'achild'")
	if rec := f.do(call{method: "POST", path: "/api/agents/aboss/kill", token: agentTok, body: `{"by":"achild"}`}); rec.Code != 501 {
		t.Errorf("kill by the assistant: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{method: "POST", path: "/api/agents/aboss/kill", token: agentTok, body: `{}`}); rec.Code != 501 {
		t.Errorf("kill by the assistant's own token, by defaulting to itself: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("UPDATE agents SET kind = NULL WHERE id = 'achild'")
	human := map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1"}
	if rec := f.do(call{method: "POST", path: "/api/agents/achild/kill", header: human}); rec.Code != 501 {
		t.Errorf("kill by the human: %d %s", rec.Code, rec.Body.String())
	}
}

// TestControlForgetRefusesRunning: forget refuses an agent that still runs, and forgets a stopped one with its rows.
func TestControlForget(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	rec := f.do(call{method: "POST", path: "/api/agents/achild/forget", token: sharedTok})
	if rec.Code != 409 {
		t.Errorf("forget a running agent: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'acodex'")
	rec = f.do(call{method: "POST", path: "/api/agents/acodex/forget", token: sharedTok})
	if rec.Code != 200 || rec.Body.String() != `{"result":"forgot coder"}` {
		t.Fatalf("forget a stopped agent: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.db.GetAgent(context.Background(), "acodex"); err == nil {
		t.Error("the forgotten agent is still there")
	}
	if _, err := f.db.GetAgent(context.Background(), "achild"); err != nil {
		t.Error("forget took another agent")
	}
}

// TestEventsActingGate: an agent reads its own events and its descendants', not its parents' or siblings'.
func TestEventsActingGate(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	for _, tc := range []struct {
		token, id string
		status    int
	}{
		{agentTok, "achild", 200},
		{agentTok, "aboss", 403},
		{agentTok, "acodex", 403},
		{bossTok, "achild", 200},
		{bossTok, "acodex", 200},
		{serverTok, "achild", 403},
		{sharedTok, "aboss", 200},
		{sharedTok, "anone", 404},
	} {
		rec := f.do(call{path: "/api/agents/" + tc.id + "/events", token: tc.token})
		if rec.Code != tc.status {
			t.Errorf("%s's events with %s: %d %s, want %d", tc.id, tc.token, rec.Code, rec.Body.String(), tc.status)
		}
	}
	rec := f.do(call{path: "/api/agents/achild/events?limit=0", token: agentTok})
	if rec.Code != 200 || rec.Body.String() != "[]" {
		t.Errorf("no events: %d %s", rec.Code, rec.Body.String())
	}
}

// TestSpawnRefusesUnported: a spawn asking for what the Go daemon can't do yet is a 501 naming it, before any row.
func TestSpawnRefusesUnported(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	for _, tc := range []struct {
		body, error string
	}{
		{`{"name":"x1","brief":"x"}`, "spawn: brief is not ported"},
		{`{"name":"x1","harness":"codex"}`, "spawn: codex is not ported"},
	} {
		rec := f.do(call{method: "POST", path: "/api/agents", token: sharedTok, body: tc.body})
		if rec.Code != 501 || !strings.Contains(rec.Body.String(), tc.error) {
			t.Errorf("%s: %d %s, want 501 %q", tc.body, rec.Code, rec.Body.String(), tc.error)
		}
	}
	// A spawn on another machine is the relay's (relay_test.go): with no such peer it is a 404 before any row.
	rec := f.do(call{method: "POST", path: "/api/agents", token: sharedTok, body: `{"name":"x1","machine":"elsewhere","harness":"claude"}`})
	if rec.Code != 404 || !strings.Contains(rec.Body.String(), "no peer machine elsewhere") {
		t.Errorf("a spawn on an unknown machine: %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(call{method: "POST", path: "/api/agents", token: sharedTok, body: `{"name":"x1","harness":"bogus","type":null}`})
	if rec.Code != 400 {
		t.Errorf("a null unported field and a bogus harness: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.db.GetAgent(context.Background(), "x1"); err == nil {
		t.Error("a refused spawn made a row")
	}
}

// TestSpawnRefusesBeforeTheRow: a daemon with no lifecycle, and a spawn naming an ITSA that doesn't exist, are refused
// before any row is made.
func TestSpawnRefusesBeforeTheRow(t *testing.T) {
	f := newFixture(t, nil)
	body := `{"name":"x2","harness":"claude","cwd":"` + f.home + `"}`
	if rec := f.do(call{method: "POST", path: "/api/agents", token: sharedTok, body: body}); rec.Code != 501 {
		t.Errorf("spawn with no lifecycle: %d %s", rec.Code, rec.Body.String())
	}
	withLife(f)
	body = `{"name":"x2","harness":"claude","parent":"aboss","itsa":"S-404","cwd":"` + f.home + `"}`
	rec := f.do(call{method: "POST", path: "/api/agents", token: sharedTok, body: body})
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "no ITSA S-404") {
		t.Errorf("spawn naming no ITSA: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.db.GetAgent(context.Background(), "x2"); err == nil {
		t.Error("a refused spawn made a row")
	}
}

// TestSpawnFailureStopsTheRow: a spawn that fails after its row is made (here: no registry for the capabilities)
// leaves the row shut down and errored with the reason, not starting.
func TestSpawnFailureStopsTheRow(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	body := `{"name":"x3","harness":"claude","cwd":"` + f.home + `"}`
	rec := f.do(call{method: "POST", path: "/api/agents", token: sharedTok, body: body})
	if rec.Code < 400 {
		t.Fatalf("spawn with no registry: %d %s", rec.Code, rec.Body.String())
	}
	a, err := f.db.GetAgent(context.Background(), "x3")
	if err != nil {
		t.Fatal(err)
	}
	if a.Lifecycle != "shut_down" || a.Activity != "errored" || a.ActivityDetail == nil || !strings.HasPrefix(*a.ActivityDetail, "launch failed: ") {
		t.Errorf("after the failed spawn: %s %s %v", a.Lifecycle, a.Activity, a.ActivityDetail)
	}
}

// TestControlActions: an agent controls itself and its children only, the human everyone; a compact with a prompt is
// refused as unported, and a lifecycle refusal is a 409 with its message.
func TestControlActions(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	const strangerTok = "stranger-token-value"
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'agone'", auth.Hash(strangerTok))
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'achild'")
	// The wrap-ups a restart and a shutdown render before they look at the agent.
	must(t, os.MkdirAll(filepath.Join(f.home, "templates"), 0o700))
	for _, name := range []string{"restart-prepare", "shutdown-prepare", "compacted-self"} {
		must(t, os.WriteFile(filepath.Join(f.home, "templates", name+".md"), []byte("wrap up"), 0o600))
	}
	for _, tc := range []struct {
		name, token, path, body string
		status                  int
		want                    string
	}{
		{"a stranger", strangerTok, "/api/agents/achild/restart", `{"by":"agone"}`, 403, `"agone may control only itself and its children"`},
		{"a stranger naming no one", strangerTok, "/api/agents/achild/restart", ``, 403, `"agone may control only itself and its children"`},
		{"a stranger's kill", strangerTok, "/api/agents/achild/kill", ``, 403, "only the human and the assistant may kill"},
		{"the parent", bossTok, "/api/agents/achild/restart", `{"by":"aboss"}`, 409, `{"error":"child is shut_down"}`},
		{"the agent itself", agentTok, "/api/agents/achild/restart", `{"by":"achild"}`, 409, `{"error":"child is shut_down"}`},
		{"the shared token", sharedTok, "/api/agents/achild/shutdown", `{}`, 409, `{"error":"child is shut_down"}`},
		{"a compact with a prompt", sharedTok, "/api/agents/achild/compact", `{"prompt":"go on"}`, 409, "child has no session to compact"},
		{"a resume with no session", sharedTok, "/api/agents/achild/resume", `{}`, 409, `{"error":"child has no session to resume"}`},
	} {
		rec := f.do(call{method: "POST", path: tc.path, token: tc.token, body: tc.body})
		if rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("%s: %d %s, want %d %s", tc.name, rec.Code, rec.Body.String(), tc.status, tc.want)
		}
	}
	f.sql("UPDATE agents SET lifecycle = 'archived', session_id = 's1' WHERE id = 'achild'")
	rec := f.do(call{method: "POST", path: "/api/agents/achild/resume", token: sharedTok, body: `{}`})
	if rec.Code != 409 || !strings.Contains(rec.Body.String(), "resuming an archived agent isn't ported") {
		t.Errorf("resume an archived agent: %d %s", rec.Code, rec.Body.String())
	}
	// A working agent's stop or restart is pending for its turn end; the ask goes to its shim, which isn't connected.
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'working' WHERE id = 'achild'")
	for _, tc := range []struct{ path, pending string }{
		{"/api/agents/achild/shutdown", `{"type":"shutdown","midTurn":true}`},
		{"/api/agents/achild/restart", `{"type":"restart","reason":"requested"}`},
	} {
		rec := f.do(call{method: "POST", path: tc.path, token: sharedTok, body: `{}`})
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"result":"waiting for child to finish its step"`) {
			t.Errorf("%s: %d %s", tc.path, rec.Code, rec.Body.String())
		}
		if a, err := f.db.GetAgent(context.Background(), "achild"); err != nil || a.PendingAction == nil || *a.PendingAction != tc.pending {
			t.Errorf("%s: pending %v %v", tc.path, a.PendingAction, err)
		}
	}
}

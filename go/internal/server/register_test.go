package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/mcp"
	"stam/internal/sse"
)

// TestRegister is src/daemon.ts POST /api/register: the refusals, the new row as TS writes it, and the public shape
// of the reply (no token_hash; the token only when asked for).
func TestRegister(t *testing.T) {
	f := newFixture(t, nil)
	post := func(body string) *httptest.ResponseRecorder {
		return f.do(call{method: "POST", path: "/api/register", token: sharedTok, body: body})
	}
	for _, tc := range []struct{ body, want string }{
		{`{}`, "name must be lowercase letters, digits, and dashes"},
		{`{"name":"Bad Name"}`, "name must be lowercase letters, digits, and dashes"},
		{`{"name":"-dash"}`, "name must be lowercase letters, digits, and dashes"},
		{`{"name":"` + strings.Repeat("a", 42) + `"}`, "name must be lowercase letters, digits, and dashes"},
	} {
		if rec := post(tc.body); rec.Code != 400 || envelope(t, rec)["error"] != tc.want {
			t.Errorf("%s: got %d %s, want 400 %q", tc.body, rec.Code, rec.Body.String(), tc.want)
		}
	}
	if rec := post(`{"name":"achild"}`); rec.Code != 409 || envelope(t, rec)["error"] != "name achild is taken" {
		t.Errorf("a taken name: got %d %s", rec.Code, rec.Body.String())
	}

	rec := post(`{"name":"  joiner ","role":"tester","cwd":"/w","model":"m1"}`)
	if rec.Code != 200 {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	must(t, json.Unmarshal(rec.Body.Bytes(), &got))
	// The row as TS's registerAgent returns it: no token_hash, and none of the list's extras.
	for _, k := range []string{"token_hash", "blockers", "waits", "parents", "cost", "unread", "chief_of_staff"} {
		if _, has := got[k]; has {
			t.Errorf("the reply carries %s: %v", k, got)
		}
	}
	if _, has := got["token"]; has {
		t.Errorf("a register without token: true got a token: %v", got)
	}
	want := map[string]any{"name": "joiner", "role": "tester", "cwd": "/w", "model": "m1", "harness": "external", "machine": "test-machine",
		"activity": "unknown", "child_notices": "tree-idle", "parent_id": nil, "session_id": nil, "effort": nil, "lifecycle": "active"}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	id, _ := got["id"].(string)
	ev, err := f.db.ListEvents(context.Background(), id, 10, "")
	must(t, err)
	if len(ev) != 1 || ev[0].Type != "register" {
		t.Errorf("events = %+v, want one register", ev)
	}
	a, err := f.db.GetAgent(context.Background(), id)
	must(t, err)
	if a.TokenHash != nil {
		t.Errorf("a register without a token stored a token hash")
	}
	// A null harness is TS's default; an empty model is none.
	rec = post(`{"name":"two","harness":null,"model":""}`)
	must(t, json.Unmarshal(rec.Body.Bytes(), &got))
	if got["harness"] != "external" || got["model"] != nil || got["role"] != "" {
		t.Errorf("defaults: %v", got)
	}
}

// TestRegisterToken: with token: true the agent gets its own token, stored only as its hash, which authenticates as the
// agent, and still does after the daemon restarts over the same database.
func TestRegisterToken(t *testing.T) {
	f := newFixture(t, nil)
	rec := f.do(call{method: "POST", path: "/api/register", token: sharedTok, body: `{"name":"own","token":true}`})
	var got struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &got))
	if rec.Code != 200 || len(got.Token) != 32 {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	a, err := f.db.GetAgent(context.Background(), got.ID)
	must(t, err)
	if a.TokenHash == nil || a.TokenHash.Reveal() != auth.Hash(got.Token) {
		t.Fatalf("the stored hash isn't the token's")
	}
	// `token` must be true itself, as TS's `body?.token === true`.
	rec = f.do(call{method: "POST", path: "/api/register", token: sharedTok, body: `{"name":"truthy","token":"yes"}`})
	if strings.Contains(rec.Body.String(), `"token"`) {
		t.Errorf("token: \"yes\" got a token: %s", rec.Body.String())
	}

	// The shared token can't act as an agent that has its own; the agent's token is that agent.
	if rec := f.do(call{path: "/api/agents/own/inbox", token: got.Token}); rec.Code != 200 {
		t.Fatalf("the agent's own token: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{path: "/api/agents/achild/inbox", token: got.Token}); rec.Code != 403 {
		t.Errorf("the token reads another agent's inbox: %d", rec.Code)
	}

	// A restart: a new server over the reopened file still knows the agent and its token.
	f.db.Close()
	d, err := db.Open(context.Background(), f.cfg.DBPath(), db.Options{})
	must(t, err)
	t.Cleanup(func() { d.Close() })
	hub := sse.New(20 * time.Millisecond)
	t.Cleanup(func() { hub.Close(context.Background()) })
	f.srv = New(f.cfg, config.NewSettingsFile(f.home, f.cfg.Machine), d, hub, nil)
	if rec := f.do(call{path: "/api/agents/own/inbox", token: got.Token}); rec.Code != 200 {
		t.Errorf("after a restart the token: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{path: "/api/agents/own", token: sharedTok}); rec.Code != 200 {
		t.Errorf("after a restart the agent: %d %s", rec.Code, rec.Body.String())
	}
}

// TestMCPRegisterThroughRoute: Go's MCP register calls POST /api/register on this server, and its later calls carry
// the agent's own token.
func TestMCPRegisterThroughRoute(t *testing.T) {
	f := newFixture(t, nil)
	ts := httptest.NewServer(f.srv)
	t.Cleanup(ts.Close)
	env := map[string]string{"STAM_URL": ts.URL, "STAM_TOKEN": sharedTok, "STAM_HOME": f.home}
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	dir := t.TempDir()
	none := ""
	m := mcp.New(mcp.Options{In: inR, Out: outW, Err: io.Discard, Getenv: func(k string) string { return env[k] },
		Cwd: func() (string, error) { return dir, nil }, Instructions: &none})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); inW.Close(); <-done })
	dec := json.NewDecoder(outR)
	ask := func(line string) map[string]any {
		t.Helper()
		go io.WriteString(inW, line+"\n")
		for {
			var msg map[string]any
			must(t, dec.Decode(&msg))
			if _, isReply := msg["id"]; isReply {
				return msg
			}
		}
	}
	ask(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`)
	reply := ask(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"register","arguments":{"name":"viamcp","role":"tests"}}}`)
	text := toolText(t, reply)
	if strings.Contains(text, `"token"`) || !strings.Contains(text, `"name":"viamcp"`) && !strings.Contains(text, `"name": "viamcp"`) {
		t.Fatalf("register's result: %s", text)
	}
	a, err := f.db.GetAgent(context.Background(), "viamcp")
	must(t, err)
	if a.Cwd != dir || a.TokenHash == nil {
		t.Errorf("the registered agent: cwd %q, has a token hash %v", a.Cwd, a.TokenHash != nil)
	}
	// whoami names no self: it is the registered agent, through its own token.
	if text := toolText(t, ask(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}`)); !strings.Contains(text, a.ID) {
		t.Errorf("whoami after register: %s", text)
	}
}

// toolText is a tools/call reply's text.
func toolText(t *testing.T, reply map[string]any) string {
	t.Helper()
	res, _ := reply["result"].(map[string]any)
	content, _ := res["content"].([]any)
	if len(content) == 0 {
		t.Fatalf("no content in %v", reply)
	}
	first, _ := content[0].(map[string]any)
	s, _ := first["text"].(string)
	return s
}

// TestTestRoutesOnlyWithHooks: a daemon without the test hooks has no /api/test/* pattern at all, not only the gate.
func TestTestRoutesOnlyWithHooks(t *testing.T) {
	for _, hooks := range []bool{false, true} {
		env := map[string]string{}
		if hooks {
			env["STAM_TEST_COST_HOOKS"] = "1"
		}
		f := newFixture(t, env)
		for _, p := range []string{"GET /api/test/kv", "POST /api/test/agent", "GET /api/test/blockers", "POST /api/test/seed-agents"} {
			method, path, _ := strings.Cut(p, " ")
			_, pattern := f.srv.mux.Handler(httptest.NewRequest(method, path, bytes.NewReader(nil)))
			if (pattern != "") != hooks {
				t.Errorf("hooks %v: %s pattern %q", hooks, p, pattern)
			}
		}
	}
	// A live-looking home (no test marker) never gets them, whatever the env says.
	f := newFixture(t, map[string]string{"STAM_TEST_COST_HOOKS": "1"})
	must(t, os.Remove(filepath.Join(f.home, config.TestHomeMarker)))
	cfg, err := config.Load(func(k string) string {
		return map[string]string{"STAM_HOME": f.home, "STAM_TEST_COST_HOOKS": "1", "STAM_TMUX_SOCKET": "stam-test-x"}[k]
	})
	must(t, err)
	srv := New(cfg, config.NewSettingsFile(f.home, cfg.Machine), f.db, f.hub, nil)
	if _, pattern := srv.mux.Handler(httptest.NewRequest("GET", "/api/test/kv", nil)); pattern != "" {
		t.Errorf("a home without the marker registered %q", pattern)
	}
}

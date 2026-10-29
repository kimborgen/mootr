package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/adapters/opencode"
	"stam/internal/config"
	"stam/internal/lifecycle"
	"stam/internal/push"
	"stam/internal/templates"
	"stam/internal/tmux"
)

// withLifeOpenCode is the lifecycle of an OpenCode daemon whose shared server is never started: an agent runs the session
// its row names, which is what the plugin routes bind to.
func withLifeOpenCode(f *fixture) {
	f.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	settings := config.NewSettingsFile(f.home, f.cfg.Machine)
	userHome := f.t.TempDir()
	root, err := filepath.Abs("../../..")
	must(f.t, err)
	tc := &tmux.Client{Socket: "stam-test-none", Bin: "/bin/false"}
	tpl := &templates.Set{Root: root, Home: f.home, UserHome: userHome, Settings: settings.Get, Machine: f.cfg.Machine}
	oc := &opencode.Server{Tmux: tc, Port: 1, Bin: filepath.Join(f.home, "no-opencode"),
		Config: func() opencode.Env { return opencode.Env{Home: f.home, Getenv: func(string) string { return "" }} }}
	life := lifecycle.New(ctx, lifecycle.Options{DB: f.db, Tmux: tc, Settings: settings, Machine: f.cfg.Machine,
		Claude: claude.Env{Templates: tpl, ClaudeBin: "/bin/false", Home: f.home, UserHome: userHome}, NetworkProbes: []string{"http://127.0.0.1:1/"},
		Streams: push.New(), PushDebounce: time.Hour, OpenCode: oc})
	f.srv.life = life
	f.t.Cleanup(func() { cancel(); life.Wait() })
}

// plugRows seeds the agents the plugin routes are asked about: achild runs OpenCode session ses_achild, aboss session
// ses_aboss (a Claude agent), and no agent has ses_nobody.
func plugRows(f *fixture) {
	f.t.Helper()
	f.sql("UPDATE agents SET harness = 'opencode', session_id = 'ses_achild', lifecycle = 'active' WHERE id = 'achild'")
	f.sql("UPDATE agents SET harness = 'claude', session_id = 'ses_aboss', lifecycle = 'active' WHERE id = 'aboss'")
}

func plugGet(f *fixture, token, route, sid string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.do(call{path: "/api/by-session/" + sid + "/" + route, token: token})
}

// A caller gets an agent's text only for a session it may act as. A forbidden caller and an unknown session get the same
// refusal, in status, body and headers, so neither says whether a session exists or whose it is; the answer names no
// agent. A caller that is not restricted gets TS's empty text for an unknown session.
func TestSessionRoutesAuth(t *testing.T) {
	f := newFixture(t, nil)
	withLifeOpenCode(f)
	plugRows(f)
	f.srv.life.QueueNotice(context.Background(), "achild", "SECRET-NOTICE", false)
	f.srv.life.SetCompactInstructions("achild", "SECRET-INSTRUCTIONS")
	for _, route := range []string{"notice", "system", "compact-instructions"} {
		t.Run(route, func(t *testing.T) {
			forbidden := plugGet(f, agentTok, route, "ses_aboss")
			unknown := plugGet(f, agentTok, route, "ses_nobody")
			if forbidden.Code != http.StatusForbidden || unknown.Code != http.StatusForbidden {
				t.Fatalf("forbidden %d, unknown %d, want both 403", forbidden.Code, unknown.Code)
			}
			if forbidden.Body.String() != unknown.Body.String() {
				t.Errorf("the refusals differ:\n%s\n%s", forbidden.Body.String(), unknown.Body.String())
			}
			for _, bad := range []string{"aboss", "achild", "ses_aboss", "ses_nobody", "SECRET"} {
				if strings.Contains(forbidden.Body.String(), bad) {
					t.Errorf("the refusal says %q: %s", bad, forbidden.Body.String())
				}
			}
			// The OpenCode server's token acts for an OpenCode agent only: a Claude agent's session is a refusal like an
			// unknown one's.
			if r := plugGet(f, serverTok, route, "ses_aboss"); r.Code != http.StatusForbidden || r.Body.String() != unknown.Body.String() {
				t.Errorf("the OpenCode token on a Claude agent's session: %d %s", r.Code, r.Body.String())
			}
			if r := plugGet(f, serverTok, route, "ses_nobody"); r.Code != http.StatusForbidden || r.Body.String() != unknown.Body.String() {
				t.Errorf("the OpenCode token on an unknown session: %d %s", r.Code, r.Body.String())
			}
			// The shared token reads any session; an unknown one is the empty answer.
			if r := plugGet(f, sharedTok, route, "ses_nobody"); r.Code != http.StatusOK || strings.TrimSpace(r.Body.String()) != "{}" {
				t.Errorf("the shared token on an unknown session: %d %s", r.Code, r.Body.String())
			}
		})
	}
	// Nothing was taken by a refused caller.
	if got := f.srv.life.SessionNotice(context.Background(), "achild", "ses_achild"); !strings.HasPrefix(got, "SECRET-NOTICE") {
		t.Errorf("a refused caller took the notice: %q", got)
	}
	if got := f.srv.life.SessionCompactInstructions(context.Background(), "achild", "ses_achild"); got != "SECRET-INSTRUCTIONS" {
		t.Errorf("a refused caller took the instructions: %q", got)
	}
}

func plugText(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Text *string `json:"text"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body %q (%v)", rec.Body.String(), err)
	}
	if out.Text == nil {
		return ""
	}
	return *out.Text
}

// The notice and the instructions are the agent's own, taken once; the system prompt is the Claude agent's render, with
// the OpenCode agent's harness and cwd.
func TestSessionRoutesServe(t *testing.T) {
	f := newFixture(t, nil)
	withLifeOpenCode(f)
	plugRows(f)
	ctx := context.Background()
	// The seeded agent has unread mail, which every call notes again; a queued notice comes before it, once.
	if got := plugText(t, plugGet(f, agentTok, "notice", "ses_achild")); strings.Contains(got, "NOTICE") || !strings.Contains(got, "unread mail") {
		t.Errorf("a notice with none queued: %q", got)
	}
	f.srv.life.QueueNotice(ctx, "achild", "NOTICE-ONE", false)
	if got := plugText(t, plugGet(f, serverTok, "notice", "ses_achild")); !strings.HasPrefix(got, "NOTICE-ONE") {
		t.Errorf("notice %q", got)
	}
	if got := plugText(t, plugGet(f, serverTok, "notice", "ses_achild")); strings.Contains(got, "NOTICE-ONE") {
		t.Errorf("the notice was delivered twice: %q", got)
	}
	f.srv.life.SetCompactInstructions("achild", "keep the plan")
	if got := plugText(t, plugGet(f, agentTok, "compact-instructions", "ses_achild")); got != "keep the plan" {
		t.Errorf("instructions %q", got)
	}
	if got := plugText(t, plugGet(f, agentTok, "compact-instructions", "ses_achild")); got != "" {
		t.Errorf("the instructions were taken twice: %q", got)
	}

	// The instructions slot is read for the agent's harness: OpenCode loads AGENTS.md itself, and not CLAUDE.md.
	work := t.TempDir()
	must(t, os.WriteFile(filepath.Join(work, "CLAUDE.md"), []byte("claude notes"), 0o600))
	f.sql("UPDATE agents SET cwd = ? WHERE id = 'achild'", work)
	a, err := f.db.GetAgent(ctx, "achild")
	must(t, err)
	parts, err := f.srv.promptParts(ctx, a, true)
	must(t, err)
	p, err := f.srv.promptSet()
	must(t, err)
	want, err := claude.SystemPrompt(ctx, p.Templates, "opencode", a, parts)
	must(t, err)
	if got := plugText(t, plugGet(f, agentTok, "system", "ses_achild")); got != want || !strings.Contains(got, a.Name) || !strings.Contains(got, filepath.Join(work, "CLAUDE.md")) {
		t.Errorf("system prompt:\n%q\nwant\n%q", got, want)
	}
}

// A session id that is no route's segment is no route.
func TestSessionRoutesBadSession(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	if r := f.do(call{path: "/api/by-session/a%2Fb/notice", token: sharedTok}); r.Code != http.StatusNotFound {
		t.Errorf("status %d", r.Code)
	}
}

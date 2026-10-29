package server

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mcpFixture is a fixture whose settings name one OAuth server and whose store holds a live grant for it. The daemon is
// its own settings home, as a test machine is.
func mcpFixture(t *testing.T) *fixture {
	t.Helper()
	// The fake provider's url is not https and resolves nowhere: the test allows what TS's tests allow (STAM_MCP_AUTH_INSECURE).
	t.Setenv("STAM_MCP_AUTH_INSECURE", "1")
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	setMcpSettings(t, f, `{"mcpServers":{"prov":{"url":"https://srv.example/mcp","auth":{"type":"oauth"}}}}`)
	grant := `{"prov":{"server_url":"https://srv.example/mcp","client_id":"c","token_endpoint":"https://x.example/t","access_token":"LIVE-BEARER","expires_at":9999999999999}}`
	must(t, os.WriteFile(filepath.Join(f.home, "mcp-auth.json"), []byte(grant), 0o600))
	return f
}

// setMcpSettings writes the settings file the daemon reads.
func setMcpSettings(t *testing.T, f *fixture, body string) {
	t.Helper()
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(body), 0o600))
}

// The token route: the human (the x-stam-human header with a shared token, or the trusted human) gets the bearer; a
// bare shared token doesn't, a peer never does (S-3212), and an agent only for a known ?agent=.
func TestMcpTokenRoute(t *testing.T) {
	f := mcpFixture(t)
	human := map[string]string{"X-Stam-Human": "1"}
	rec := f.sendH("GET", "/api/mcp/prov/token", sharedTok, human, "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"token":"LIVE-BEARER"`) || !strings.Contains(rec.Body.String(), `"url":"https://srv.example/mcp"`) {
		t.Errorf("the human's token: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{path: "/api/mcp/prov/token", token: sharedTok}); rec.Code != 403 || strings.Contains(rec.Body.String(), "LIVE-BEARER") {
		t.Errorf("a bare shared token got the bearer: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("GET", "/api/mcp/prov/token", "", trusted, ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), "LIVE-BEARER") {
		t.Errorf("the trusted human's token: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{path: "/api/mcp/prov/token", token: peerTok, header: human}); rec.Code != 403 || strings.Contains(rec.Body.String(), "LIVE-BEARER") {
		t.Errorf("a peer's token: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{path: "/api/mcp/prov/token", token: agentTok}); rec.Code != 403 {
		t.Errorf("an agent with no ?agent=: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{path: "/api/mcp/prov/token?agent=achild", token: agentTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), "LIVE-BEARER") {
		t.Errorf("a known agent: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{path: "/api/mcp/prov/token?agent=nosuch", token: agentTok}); rec.Code != 403 {
		t.Errorf("an unknown agent: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{path: "/api/mcp/no.such/token", token: sharedTok, header: human}); rec.Code != 404 || !strings.Contains(rec.Body.String(), "no route GET") {
		t.Errorf("a name no route matches: %d %s", rec.Code, rec.Body.String())
	}
}

// Under auth.humanStrict only the trusted human counts, and a local request doesn't (isHuman, S-543).
func TestMcpTokenRouteHumanStrict(t *testing.T) {
	f := mcpFixture(t)
	setMcpSettings(t, f, `{"auth":{"humanStrict":true},"mcpServers":{"prov":{"url":"https://srv.example/mcp","auth":{"type":"oauth"}}}}`)
	if rec := f.sendH("GET", "/api/mcp/prov/token", sharedTok, map[string]string{"X-Stam-Human": "1"}, ""); rec.Code != 403 {
		t.Errorf("strict: a header alone got the bearer: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("GET", "/api/mcp/prov/token", "", trusted, ""); rec.Code != 200 {
		t.Errorf("strict: the trusted human: %d %s", rec.Code, rec.Body.String())
	}
	local := map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Local": "1"}
	if rec := f.sendH("GET", "/api/mcp/prov/token", "", local, ""); rec.Code != 403 {
		t.Errorf("strict: a local request got the bearer: %d %s", rec.Code, rec.Body.String())
	}
}

// The status route: rows, and no token in any of them.
func TestMcpStatusRoute(t *testing.T) {
	f := mcpFixture(t)
	rec := f.do(call{path: "/api/mcp/status", token: sharedTok})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"name":"prov"`) || !strings.Contains(rec.Body.String(), `"logged_in":true`) {
		t.Errorf("status: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "LIVE-BEARER") {
		t.Errorf("status holds a token: %s", rec.Body.String())
	}
}

// Logout is the human's: an agent is refused, the shared token alone is refused, and the human's logout removes the grant.
func TestMcpLogoutRoute(t *testing.T) {
	f := mcpFixture(t)
	if rec := f.sendH("POST", "/api/mcp/prov/logout", agentTok, nil, ""); rec.Code != 403 {
		t.Errorf("an agent's logout: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("POST", "/api/mcp/prov/logout", sharedTok, nil, ""); rec.Code != 403 {
		t.Errorf("the shared token's logout (not the human): %d %s", rec.Code, rec.Body.String())
	}
	rec := f.sendH("POST", "/api/mcp/prov/logout", "", trusted, "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"logged_out":"prov"`) {
		t.Fatalf("the human's logout: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{path: "/api/mcp/prov/token", token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}}); rec.Code == 200 {
		t.Errorf("a token after logout: %d %s", rec.Code, rec.Body.String())
	}
}

// A provider's error that holds a token never reaches the response body or the log: the token route answers with the
// fixed message (S-3482 review).
func TestMcpTokenRouteProviderErrorNeverInTheBody(t *testing.T) {
	const leak = "Bearer sk-LEAK-IN-SENTENCE 1234"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":false,"error":"` + leak + `"}`))
	}))
	t.Cleanup(provider.Close)
	f := mcpFixture(t)
	grant := `{"prov":{"server_url":"https://srv.example/mcp","client_id":"c","token_endpoint":"` + provider.URL + `/token","access_token":"OLD","refresh_token":"R1","expires_at":1}}`
	must(t, os.WriteFile(filepath.Join(f.home, "mcp-auth.json"), []byte(grant), 0o600))
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	rec := f.sendH("GET", "/api/mcp/prov/token?refresh=1", sharedTok, map[string]string{"X-Stam-Human": "1"}, "")
	if rec.Code == 200 {
		t.Fatalf("a refused refresh answered 200: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "LEAK") || strings.Contains(rec.Body.String(), "sk-") {
		t.Errorf("the provider's error reached the response body: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unknown error") {
		t.Errorf("the body %s, want the fixed message", rec.Body.String())
	}
	if strings.Contains(logs.String(), "LEAK") || strings.Contains(logs.String(), "sk-") {
		t.Errorf("the provider's error reached the log: %s", logs.String())
	}
}

// TestMcpLoginRoute: only the trusted human starts a login (an agent's token or x-stam-human proves nothing), and a
// login from an Origin other than the canonical web origin is refused before any discovery. The OAuth callback needs no
// token: its single-use state is its protection, so an unknown state is a 400 page.
func TestMcpLoginRoute(t *testing.T) {
	f := mcpFixture(t)
	f.srv.setWebOrigin("https://web.example", true)
	for _, c := range []call{
		{method: "POST", path: "/api/mcp/prov/login", token: agentTok},
		{method: "POST", path: "/api/mcp/prov/login", token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}},
		{method: "POST", path: "/api/mcp/prov/logout", token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}},
	} {
		if rec := f.do(c); rec.Code != 403 || !strings.Contains(rec.Body.String(), "only the human can") {
			t.Errorf("%s %s with %s: %d %s", c.method, c.path, c.token, rec.Code, rec.Body)
		}
	}
	rec := f.do(call{method: "POST", path: "/api/mcp/prov/login", token: sharedTok, header: map[string]string{"X-Stam-Test-Human": humanKey, "Origin": "http://evil.example"}})
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "a login must come from https://web.example") {
		t.Errorf("a foreign Origin: %d %s", rec.Code, rec.Body)
	}
	rec = f.do(call{method: "GET", path: "/oauth/callback?code=x&state=nope"})
	if rec.Code != 400 || rec.Header().Get("Content-Type") != "text/html; charset=utf-8" || !strings.Contains(rec.Body.String(), "<p>Login failed: unknown or already used login state</p>") {
		t.Errorf("the callback with an unknown state: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{method: "GET", path: "/oauth/other"}); rec.Code != 401 {
		t.Errorf("another path without a token: %d", rec.Code)
	}
}

// TestServedOrigin: the first host in `tailscale serve status`'s own order whose handlers reach the port is the origin,
// every time, when two serve it; :443 is dropped, and no match, no Web and bad JSON give none.
func TestServedOrigin(t *testing.T) {
	status := `{"Web": {"other.tail.example:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8000"}}},
	  "zeta.tail.example:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:7999"}}},
	  "alpha.tail.example:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:7999"}}}}}`
	for i := 0; i < 20; i++ {
		if got := servedOrigin([]byte(status), 7999); got != "https://zeta.tail.example" {
			t.Fatalf("run %d: %q", i, got)
		}
	}
	if got := servedOrigin([]byte(status), 8000); got != "https://other.tail.example" {
		t.Errorf("port 8000: %q", got)
	}
	for _, s := range []string{status, `{}`, `{"Web": []}`, `not json`} {
		if got := servedOrigin([]byte(s), 1234); got != "" {
			t.Errorf("%s: %q", s, got)
		}
	}
}

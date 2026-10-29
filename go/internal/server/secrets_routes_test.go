package server

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/config"
)

const routeKey = "sk-route-secret-abcdef-7777" // gitleaks:allow

// TestSecretRoutes: the human sets, lists, tests and deletes a secret, and no answer or log line holds a value; an agent,
// the shared token without the human, and the peer token get 403 on every route and change nothing; a malformed body is a
// 400 with a fixed message, and a broken secrets.json a 409 that names it.
func TestSecretRoutes(t *testing.T) {
	f, _ := settingsFixture(t)
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	human := func(method, path, body string) (int, string) {
		t.Helper()
		rec := f.do(call{method: method, path: path, token: sharedTok, header: trusted, body: body})
		if strings.Contains(rec.Body.String(), routeKey) || strings.Contains(rec.Body.String(), routeKey[:20]) {
			t.Errorf("%s %s answered a value: %s", method, path, rec.Body)
		}
		return rec.Code, rec.Body.String()
	}
	if code, body := human("PUT", "/api/secrets/openai-main", `{"value":"`+routeKey+`","provider":"openai"}`); code != 200 || !strings.Contains(body, `"last4":"7777"`) || !strings.Contains(body, `"provider":"openai"`) {
		t.Fatalf("PUT: %d %s", code, body)
	}
	if code, body := human("GET", "/api/secrets", ""); code != 200 || !strings.Contains(body, `"name":"openai-main"`) {
		t.Errorf("GET: %d %s", code, body)
	}
	for _, c := range []struct {
		method, path, body string
		status             int
		error              string
	}{
		{"PUT", "/api/secrets/Bad..Name", `{"value":"x"}`, 400, "a secret name is 1-64 characters"},
		{"PUT", "/api/secrets/openai-main", `{"value":"` + routeKey + `"`, 400, "the request body is not valid JSON"},
		{"PUT", "/api/secrets/x", `{"value":"has space"}`, 400, "value must be printable ASCII with no spaces"},
		{"POST", "/api/secrets/openai-main/test", `{}`, 400, "no provider uses openai-main"},
		{"POST", "/api/secrets/openai-main/test", `{"provider":"openrouter"}`, 400, "openrouter doesn't use openai-main, so it isn't tested there"},
		{"POST", "/api/secrets/nobody/test", `{"provider":"openrouter"}`, 404, "no secret nobody"},
		{"DELETE", "/api/secrets/nobody", "", 404, "no secret nobody"},
	} {
		if code, body := human(c.method, c.path, c.body); code != c.status || !strings.Contains(body, c.error) {
			t.Errorf("%s %s %s: %d %s", c.method, c.path, c.body, code, body)
		}
	}
	file := filepath.Join(f.home, "secrets.json")
	before := readFile(t, file)
	for _, who := range []call{{token: agentTok}, {token: sharedTok}, {token: peerTok, header: map[string]string{"X-Stam-Local": "1"}}} {
		for _, r := range [][2]string{{"GET", "/api/secrets"}, {"PUT", "/api/secrets/openai-main"}, {"PUT", "/api/secrets/new-one"}, {"POST", "/api/secrets/openai-main/test"}, {"DELETE", "/api/secrets/openai-main"}} {
			c := who
			c.method, c.path, c.body = r[0], r[1], `{"value":"sk-agent-wrote-this-3333"}`
			if rec := f.do(c); rec.Code != 403 || strings.Contains(rec.Body.String(), routeKey) {
				t.Errorf("%s %s with %s: %d %s", c.method, c.path, c.token, rec.Code, rec.Body)
			}
		}
	}
	if readFile(t, file) != before {
		t.Errorf("a refused request changed secrets.json")
	}
	if code, body := human("DELETE", "/api/secrets/openai-main", ""); code != 200 || body != `{"removed":"openai-main"}` {
		t.Errorf("DELETE: %d %s", code, body)
	}
	must(t, os.WriteFile(file, []byte("{broken"), 0o600))
	for _, r := range [][3]string{{"GET", "/api/secrets", ""}, {"PUT", "/api/secrets/a", `{"value":"` + routeKey + `"}`}, {"DELETE", "/api/secrets/a", ""}, {"POST", "/api/secrets/a/test", "{}"}} {
		if code, body := human(r[0], r[1], r[2]); code != 409 || !strings.Contains(body, "secrets.json is not valid JSON; fix or remove it") {
			t.Errorf("%s %s over a broken store: %d %s", r[0], r[1], code, body)
		}
	}
	if readFile(t, file) != "{broken" {
		t.Errorf("a refused write over a broken store changed it")
	}
	if strings.Contains(logs.String(), routeKey) || !strings.Contains(logs.String(), "secret set: openai-main") || !strings.Contains(logs.String(), "secret deleted: openai-main") {
		t.Errorf("the log: %s", logs.String())
	}
}

// TestMigrateClientSecrets: at start the plain client secrets in the home's settings and in the token file move into the
// store, each replaced by its reference; a store name already holding another value is left alone, and a second start
// changes nothing. The log names servers, never values.
func TestMigrateClientSecrets(t *testing.T) {
	f, path := settingsFixture(t)
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	must(t, os.WriteFile(path, []byte(`{"mcpServers":{"a":{"url":"https://a","auth":{"type":"oauth","client_secret":"settings-secret-aaaa1"}},"b":{"url":"https://b","auth":{"client_secret":"settings-secret-bbbb2"}}}}`), 0o600))
	grants := filepath.Join(f.home, "mcp-auth.json")
	must(t, os.WriteFile(grants, []byte(`{"c":{"server_url":"https://c","client_id":"x","client_secret":"grant-secret-cccc3"}}`), 0o600))
	// b's store name already holds another value: b's secret stays in place.
	bName, _ := config.McpClientSecretName("b")
	_, err := f.srv.secrets.SetMcpClientSecret("b", "other-value-zzzz")
	must(t, err)
	f.srv.StartSecrets()
	aName, _ := config.McpClientSecretName("a")
	cName, _ := config.McpClientSecretName("c")
	text := readFile(t, path)
	if strings.Contains(text, "settings-secret-aaaa1") || !strings.Contains(text, `"secret": "`+aName+`"`) || !strings.Contains(text, "settings-secret-bbbb2") {
		t.Errorf("settings after the move: %s", text)
	}
	if g := readFile(t, grants); strings.Contains(g, "grant-secret-cccc3") || !strings.Contains(g, `"secret": "`+cName+`"`) {
		t.Errorf("the token file after the move: %s", g)
	}
	for name, want := range map[string]string{aName: "settings-secret-aaaa1", bName: "other-value-zzzz", cName: "grant-secret-cccc3"} {
		if got, _ := f.srv.secrets.Get(name); got.Reveal() != want {
			t.Errorf("%s holds the wrong value", name)
		}
	}
	if f.srv.settings.Get().McpServers == nil {
		t.Errorf("the settings weren't read again")
	}
	before, beforeGrants := readFile(t, path), readFile(t, grants)
	f.srv.StartSecrets()
	if readFile(t, path) != before || readFile(t, grants) != beforeGrants {
		t.Errorf("a second start changed a file")
	}
	for _, v := range []string{"settings-secret-aaaa1", "settings-secret-bbbb2", "grant-secret-cccc3", "other-value-zzzz"} {
		if strings.Contains(logs.String(), v) {
			t.Errorf("the log holds a value: %s", logs.String())
		}
	}
	if !strings.Contains(logs.String(), "moved a's client secret into the secret store as "+aName) || !strings.Contains(logs.String(), "b's client secret stays in place: "+bName+" holds another value") {
		t.Errorf("the log: %s", logs.String())
	}
}

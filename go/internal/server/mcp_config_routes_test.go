package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// mcpConfigFixture is the trusted human's fixture with a remote server that has a login (its grant held here) and a
// stdio one, both on this machine; nothing reaches past loopback.
func mcpConfigFixture(t *testing.T) (*fixture, *[]string) {
	t.Helper()
	var auths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auths = append(auths, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"remote-tool"}]}}`))
	}))
	t.Cleanup(srv.Close)
	f := mcpFixture(t)
	setMcpSettings(t, f, `{"mcpServers":{"prov":{"url":"`+srv.URL+`/mcp","auth":{"type":"oauth"}},`+
		`"local":{"command":"sh","args":["-c","read a; read b; read c; echo '{\"id\":2,\"result\":{\"tools\":[{\"name\":\"local-tool\"}]}}'; read d"]}}}`)
	grant := `{"prov":{"server_url":"` + srv.URL + `/mcp","client_id":"c","token_endpoint":"https://x.example/t","access_token":"LIVE-BEARER","expires_at":9999999999999}}`
	must(t, os.WriteFile(filepath.Join(f.home, "mcp-auth.json"), []byte(grant), 0o600))
	return f, &auths
}

// TestMcpConfigRoutesHumanOnly: test, import, registry and probe are the trusted human's; an agent's token and the
// x-stam-human header are refused before anything is read or reached. Parse reads only its text, so an agent may.
func TestMcpConfigRoutesHumanOnly(t *testing.T) {
	f, auths := mcpConfigFixture(t)
	for _, c := range []call{
		{method: "POST", path: "/api/mcp/prov/test", token: agentTok, body: `{}`},
		{method: "POST", path: "/api/mcp/prov/test", token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}},
		{method: "GET", path: "/api/mcp/import", token: agentTok},
		{method: "GET", path: "/api/mcp/registry", token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}},
		{method: "POST", path: "/api/mcp/registry/probe", token: agentTok, body: `{"url":"http://127.0.0.1:1/"}`},
	} {
		if rec := f.do(c); rec.Code != 403 || !strings.Contains(rec.Body.String(), "only the human can") {
			t.Errorf("%s %s with %s: %d %s", c.method, c.path, c.token, rec.Code, rec.Body)
		}
	}
	if len(*auths) != 0 {
		t.Errorf("a refused test reached the server: %q", *auths)
	}
	rec := f.do(call{method: "POST", path: "/api/mcp/parse", token: agentTok, body: `{"text":"{\"fs\":{\"command\":\"npx\"}}"}`})
	if rec.Code != 200 || rec.Body.String() != `{"servers":{"fs":{"command":"npx"}},"notes":[]}` {
		t.Errorf("an agent's parse: %d %s", rec.Code, rec.Body)
	}
	for body, want := range map[string]string{`{}`: "Paste an MCP server config.", `{"text":"{x"}`: "That is neither JSON nor a Codex TOML config.", `{"text":5}`: "No MCP servers found in that config."} {
		if rec := f.do(call{method: "POST", path: "/api/mcp/parse", token: sharedTok, body: body}); rec.Code != 400 || !strings.Contains(rec.Body.String(), want) {
			t.Errorf("parse %s: %d %s", body, rec.Code, rec.Body)
		}
	}
}

// TestMcpTestRoute: the human tests a configured server: a remote one with its stored bearer, a stdio one by
// spawning it, and an unknown name is a 404.
func TestMcpTestRoute(t *testing.T) {
	f, auths := mcpConfigFixture(t)
	rec := f.do(call{method: "POST", path: "/api/mcp/prov/test", token: sharedTok, header: trusted})
	if rec.Code != 200 || rec.Body.String() != `{"ok":true,"tools":["remote-tool"]}` || strings.Join(*auths, ",") != "Bearer LIVE-BEARER,Bearer LIVE-BEARER,Bearer LIVE-BEARER" {
		t.Errorf("the remote test: %d %s %q", rec.Code, rec.Body, *auths)
	}
	if rec := f.do(call{method: "POST", path: "/api/mcp/local/test", token: sharedTok, header: trusted}); rec.Code != 200 || rec.Body.String() != `{"ok":true,"tools":["local-tool"]}` {
		t.Errorf("the stdio test: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{method: "POST", path: "/api/mcp/nope/test", token: sharedTok, header: trusted}); rec.Code != 404 || !strings.Contains(rec.Body.String(), "no MCP server nope") {
		t.Errorf("an unknown server: %d %s", rec.Code, rec.Body)
	}
}

// TestMcpImportRoute: the scan reads HARNESS_HOME and the agents' folders, and marks each server against settings.
func TestMcpImportRoute(t *testing.T) {
	f, _ := mcpConfigFixture(t)
	harness := t.TempDir()
	folder := t.TempDir()
	t.Setenv("STAM_HARNESS_HOME", harness)
	must(t, os.WriteFile(filepath.Join(harness, ".claude.json"), []byte(`{"mcpServers":{"local":{"command":"other"},"fresh":{"url":"https://f.example/mcp"}}}`), 0o600))
	must(t, os.WriteFile(filepath.Join(folder, ".mcp.json"), []byte(`{"mcpServers":{"proj":{"command":"p"}}}`), 0o600))
	must(t, f.db.Write(context.Background(), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "UPDATE agents SET cwd = ? WHERE id = 'achild'", &sqlitex.ExecOptions{Args: []any{folder}})
	}))
	rec := f.do(call{path: "/api/mcp/import", token: sharedTok, header: trusted})
	body := rec.Body.String()
	if rec.Code != 200 || !strings.Contains(body, `{"name":"local","server":{"command":"other"},"group":"~/.claude.json","file":"`+harness+`/.claude.json","status":"differs","differences":["command: sh → other","args: [\"-c\",`) ||
		!strings.Contains(body, `"name":"fresh"`) || !strings.Contains(body, `{"name":"proj","server":{"command":"p"},"group":"`+folder+`/.mcp.json"`) {
		t.Errorf("the scan: %d %s", rec.Code, body)
	}
}

// TestMcpRegistryRoutes: the human browses the registry the base url names, with search and cursor passed on, and a
// probe needs an http or https url.
func TestMcpRegistryRoutes(t *testing.T) {
	var queries []string
	reg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.RawQuery)
		_, _ = w.Write([]byte(`{"servers":[{"server":{"name":"io.x/a","version":"1","remotes":[{"type":"streamable-http","url":"https://a.example/mcp"}]}}],"metadata":{"nextCursor":"n2"}}`))
	}))
	t.Cleanup(reg.Close)
	t.Setenv("STAM_MCP_REGISTRY_URL", reg.URL+"/v0.1/servers")
	f, _ := mcpConfigFixture(t)
	rec := f.do(call{path: "/api/mcp/registry?search=lin+ear&cursor=c1", token: sharedTok, header: trusted})
	want := `{"servers":[{"name":"io.x/a","version":"1","options":[{"kind":"remote","label":"Remote · https://a.example/mcp","server":{"url":"https://a.example/mcp"},"fields":[]}]}],"nextCursor":"n2"}`
	if rec.Code != 200 || rec.Body.String() != want || strings.Join(queries, ",") != "limit=30&search=lin+ear&cursor=c1" {
		t.Errorf("browse: %d %s %q", rec.Code, rec.Body, queries)
	}
	for _, body := range []string{`{}`, `{"url":"ftp://x"}`, `[1]`} {
		if rec := f.do(call{method: "POST", path: "/api/mcp/registry/probe", token: sharedTok, header: trusted, body: body}); rec.Code != 400 || !strings.Contains(rec.Body.String(), "a http or https url is required") {
			t.Errorf("probe %s: %d %s", body, rec.Code, rec.Body)
		}
	}
	if rec := f.do(call{method: "POST", path: "/api/mcp/registry/probe", token: sharedTok, header: trusted, body: `{"url":"https://api.githubcopilot.com/mcp/"}`}); rec.Code != 200 || rec.Body.String() != `{"auth":"gh"}` {
		t.Errorf("probe GitHub: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{method: "POST", path: "/api/mcp/registry/probe", token: sharedTok, header: trusted, body: `{"url":"` + reg.URL + `/open"}`}); rec.Code != 200 || rec.Body.String() != `{"auth":null}` {
		t.Errorf("probe an open server: %d %s", rec.Code, rec.Body)
	}
}

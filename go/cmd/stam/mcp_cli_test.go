package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// TestMcpLoginCommands: `stam mcp status` prints a line per server and the unreachable home; login prints the URL, or
// points at the web UI when the daemon refuses the CLI; logout prints the daemon's refusal, or that it logged out.
func TestMcpLoginCommands(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"GET /api/mcp/status": fixed(200, `{"servers":[{"name":"linear","type":"oauth","logged_in":true,"expires_at":1700000000000},`+
			`{"name":"gh","type":"gh","logged_in":false,"expires_at":null},{"name":"old","type":"oauth","logged_in":true,"local_grant":true}],`+
			`"home":{"name":"main","reachable":false,"error":null}}`),
		"POST /api/mcp/linear/login":  fixed(200, `{"url":"https://auth.example/authorize?x=1"}`),
		"POST /api/mcp/gh/login":      fixed(403, `{"error":"only the human can log in to an MCP server"}`),
		"POST /api/mcp/linear/logout": fixed(200, `{"logged_out":"linear"}`),
		"POST /api/mcp/gh/logout":     fixed(500, `{"error":"gh: log out on main, which keeps the MCP logins; this machine leases them from main"}`),
	})
	vars := map[string]string{"STAM_URL": s.URL}
	want := "linear           oauth  logged in (expires 2023-11-14T22:13:20.000Z)\ngh               gh     not logged in\n" +
		"old              oauth  local login on this machine\nmain is unreachable: its MCP logins are not listed.\n"
	if o := runCLI(t, vars, "", "mcp", "status"); o.code != 0 || o.stdout != want {
		t.Errorf("status = %+v\nwant %q", o, want)
	}
	if o := runCLI(t, vars, "", "mcp", "login", "linear"); o.stdout != "https://auth.example/authorize?x=1\n" {
		t.Errorf("login = %+v", o)
	}
	if o := runCLI(t, vars, "", "mcp", "login", "gh"); o.code != 0 || o.stdout != "Log in to gh from the web UI's Settings.\n" {
		t.Errorf("a refused login = %+v", o)
	}
	if o := runCLI(t, vars, "", "mcp", "logout", "linear"); o.code != 0 || o.stdout != "logged out of linear\n" {
		t.Errorf("logout = %+v", o)
	}
	if o := runCLI(t, vars, "", "mcp", "logout", "gh"); o.code != 1 || !strings.Contains(o.stderr, "log out on main, which keeps the MCP logins") {
		t.Errorf("a refused logout = %+v", o)
	}
	if o := runCLI(t, vars, "", "mcp", "login"); o.code != 1 || !strings.Contains(o.stderr, "usage: stam mcp login NAME") {
		t.Errorf("login without a name = %+v", o)
	}
}

// TestMcpProxy: the proxy sends each line with the daemon's bearer; a 401 asks the daemon for a refreshed token once
// and retries; the session id the server gives is sent after; a JSON answer and an SSE answer each print a line, a
// notification's 202 prints nothing, and a server error answers the request with a JSON-RPC error. A last line with no
// newline is cut short and dropped, as TS drops it.
func TestMcpProxy(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		body := string(buf[:n])
		mu.Lock()
		seen = append(seen, r.Header.Get("Authorization")+" "+r.Header.Get("Mcp-Session-Id"))
		mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer GOOD" {
			w.WriteHeader(401)
			return
		}
		switch {
		case strings.Contains(body, `"initialize"`):
			w.Header().Set("Mcp-Session-Id", "sess-1")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{ "jsonrpc": "2.0", "id": 1, "result": {} }`))
		case strings.Contains(body, "notifications/"):
			w.WriteHeader(202)
		case strings.Contains(body, "tools/list"):
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n\n"))
		default:
			w.WriteHeader(500)
			_, _ = w.Write([]byte("boom"))
		}
	}))
	t.Cleanup(srv.Close)
	s := newStub(t, map[string]func(int) (int, string){
		"GET /api/mcp/fake/token": func(n int) (int, string) {
			if n == 1 {
				return 200, `{"name":"fake","url":"` + srv.URL + `","token":"STALE","expires_at":null}`
			}
			return 200, `{"name":"fake","url":"` + srv.URL + `","token":"GOOD","expires_at":null}`
		},
	})
	stdin := `{"jsonrpc":"2.0","id":1,"method":"initialize"}` + "\n" + `{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n" +
		"not json\n" + `{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n" + `{"jsonrpc":"2.0","id":3,"method":"other"}` + "\n" +
		`{"jsonrpc":"2.0","id":4,"method":"cut short"}`
	o := runCLI(t, map[string]string{"STAM_URL": s.URL, "STAM_AGENT_ID": "a1"}, stdin, "mcp-proxy", "fake")
	want := `{"jsonrpc":"2.0","id":1,"result":{}}` + "\n" + `{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}` + "\n" +
		`{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"MCP server fake: HTTP 500 boom"}}` + "\n"
	if o.code != 0 || o.stdout != want {
		t.Fatalf("proxy = %+v\nwant %q", o, want)
	}
	if strings.Join(seen, ",") != "Bearer STALE ,Bearer GOOD ,Bearer GOOD sess-1,Bearer GOOD sess-1,Bearer GOOD sess-1" {
		t.Errorf("the server saw %q", seen)
	}
	var uris []string
	for _, c := range s.calls {
		uris = append(uris, c.path)
	}
	if strings.Join(uris, ",") != "/api/mcp/fake/token?agent=a1,/api/mcp/fake/token?agent=a1&refresh=1" {
		t.Errorf("token asks %q", uris)
	}
}

// TestSettingsMigrateCLI: `stam settings migrate` prints the report, --json the result, and exits 1 on a refusal.
func TestSettingsMigrateCLI(t *testing.T) {
	home := t.TempDir()
	vars := map[string]string{"STAM_HOME": home, "STAM_MACHINE": "peer"}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{"home":"peer"}`), 0o600))
	if o := runCLI(t, vars, "", "settings", "migrate"); o.code != 0 || o.stdout != "this is the settings home (peer); nothing to migrate\n" {
		t.Errorf("on the home = %+v", o)
	}
	if o := runCLI(t, vars, "", "settings", "migrate", "--json"); o.code != 0 || o.stdout != "{\n  \"home\": \"peer\"\n}\n" {
		t.Errorf("--json = %+v", o)
	}
	must(os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{"home":"main"}`), 0o600))
	if o := runCLI(t, vars, "", "settings", "migrate"); o.code != 1 || !strings.Contains(o.stdout, "no shared settings cached yet from main") {
		t.Errorf("no cache = %+v", o)
	}
	if o := runCLI(t, vars, "", "settings", "nope"); o.code != 1 || !strings.Contains(o.stderr, "usage: stam settings migrate") {
		t.Errorf("a bad subcommand = %+v", o)
	}
}

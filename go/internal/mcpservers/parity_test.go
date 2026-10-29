package mcpservers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"stam/internal/jsjson"
)

// runTS runs testdata/mcpref.mjs on input and returns what it prints.
func runTS(t *testing.T, input any) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	in, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", "--no-warnings", "testdata/mcpref.mjs")
	cmd.Stdin = bytes.NewReader(in)
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("mcpref.mjs: %v", err)
	}
	if len(out) == 0 || string(out) == "null" {
		t.Fatalf("mcpref.mjs printed nothing")
	}
	return string(out)
}

// settle is a result as mcpref.mjs prints it: the value, or {error} for a failure.
func settle(v jsjson.Value, err error) jsjson.Value {
	if err != nil {
		return jsjson.NewObject("error", err.Error())
	}
	return v
}

// sameLines fails with each TS and Go result side by side when the two lists differ.
func sameLines(t *testing.T, labels []string, goOut, tsOut string) {
	t.Helper()
	if goOut == tsOut {
		return
	}
	var g, w []json.RawMessage
	_ = json.Unmarshal([]byte(goOut), &g)
	_ = json.Unmarshal([]byte(tsOut), &w)
	if len(g) != len(w) {
		t.Fatalf("Go:\n%s\nTS:\n%s", goOut, tsOut)
	}
	for i := range g {
		if !bytes.Equal(g[i], w[i]) {
			label := fmt.Sprint(i)
			if i < len(labels) {
				label = labels[i]
			}
			t.Errorf("%s:\nGo: %s\nTS: %s", label, g[i], w[i])
		}
	}
}

var parseCases = []string{
	"",
	"   \n ",
	"{not json",
	`{"other": 1}`,
	`[1, 2]`,
	`"text"`,
	`{"mcpServers": {"gh": {"type": "http", "url": "https://api.example/mcp", "headers": {"Authorization": "Bearer x", "N": 5}},
	  "fs": {"command": "npx", "args": ["-y", "fs", 3, true, null, {"a": 1}, [1, [2, 3]]], "env": {"HOME": "/h", "N": 1.5, "O": {}, "Z": null}},
	  "old": {"type": "sse", "url": "https://old.example/sse"}, "trail": {"url": "https://t.example/sse/"},
	  "none": {"type": "stdio"}, "emptycmd": {"command": "", "url": ""}, "emptycmdurl": {"command": "", "url": "u"},
	  "off": {"command": "x", "enabled": false}, "on": {"command": "x", "enabled": "false"}, "str": "nope", "arr": [1]}}`,
	`{"fs": {"command": "npx"}, "web": {"url": "https://w.example/mcp"}}`,
	`{"fs": {"command": "npx"}, "meta": 1}`,
	`{"mcp": {"local": {"type": "local", "command": ["bunx", "srv", 2, "--flag"], "environment": {"K": "v"}},
	  "one": {"type": "local", "command": ["solo"]}, "none": {"command": []},
	  "remote": {"type": "remote", "url": "https://r.example/mcp", "headers": {"A": "1"}, "http_headers": {"A": "2", "B": "3"}, "enabled": false},
	  "both": {"command": ["a", "b"], "args": ["c"]}, "envnull": {"command": "x", "env": null, "environment": {"E": "1"}}}}`,
	`{"mcp": {"servers": {"s": {"command": "x"}}}}`,
	`{"mcp_servers": {"s": {"command": "x"}, "2": {"command": "two"}, "1": {"command": "one"}}}`,
	"[mcp_servers.linear]\nurl = \"https://mcp.linear.app/sse\"\nbearer_token_env_var = \"LINEAR_TOKEN\"\n" +
		"env_http_headers = { \"X-Key\" = \"KEY_VAR\", Other = \"O\" }\nhttp_headers = { \"X-A\" = \"1\" }\n\n" +
		"[mcp_servers.fs] # the files\ncommand = 'npx' # literal\nargs = [\"-y\", '@mcp/fs', 1_000, +5, 1e3, 0.25, -_, _, true, [\"n\", 2], { a = 1 }]\n" +
		"env = { HOME = \"/h\\tx\", Q = \"a\\\"b\", U = \"\\u00e9\\u0041\", S = \"\\\\u0041\", E = , \"#\" = \"x#y\" }\n" +
		"[mcp_servers.\"my server\"]\ncommand = \"go\"\nenabled = false\n[other]\nx = 1\n",
	"model = \"o3\"\n[mcp_servers.dotted]\nenv.A = \"1\"\nenv.B.C = \"2\"\ncommand = \"d\"\n[mcp_servers.2]\ncommand = \"two\"\n[mcp_servers.1]\ncommand = \"one\"\n",
	"model = \"o3\"\n",
	"[mcp_servers.x]\nargs = [\"only\"]\n",
	"mcp_servers = \"str\"\n[mcp_servers.x]\ncommand = \"c\"\n",
	"[mcp_servers.x]\ncommand = 5\n[mcp_servers.x.command]\na = 1\n",
	"[mcp_servers.x]\ncommand = \"c\"\nargs = [\"a\", [\"b\"]]\n[mcp_servers.x.args.1]\n",
	"[mcp_servers.x]\ncommand = \"c\"\n= 5\n\"\" = 6\nargs = [\"a\\\\\"]\nurl = \"u\" = \"v\"\n",
	"[mcp_servers.x]\r\ncommand = \"c\"\r\nargs = [ \"a\" , , \"b\", ]\r\n",
	"[mcp_servers.s]\ncommand = \"x\"\nargs = [\"unterminated\nenv = {A = \"1\", B = {C = 2}}\n",
	"key = 1\n{\"mcpServers\": {}}",
	"\n  [mcp_servers.late]\n  url = \"https://late.example/mcp\"",
	"{\"mcpServers\": {\"x\": {\"command\": \"c\"}}}\n[mcp_servers.y]\ncommand = \"d\"",
}

// TestParseMatchesTS: parseMcpConfig's servers, notes and refusals, for JSON from each harness and Codex TOML, match
// src/mcp-config.ts run by testdata/mcpref.mjs on the same texts.
func TestParseMatchesTS(t *testing.T) {
	ts := runTS(t, map[string]any{"op": "parse", "texts": parseCases})
	var out []any
	for _, c := range parseCases {
		v, err := ParseConfig(c)
		out = append(out, settle(v, err))
	}
	if !strings.Contains(ts, `"linear":{"url":"https://mcp.linear.app/sse",`) || !strings.Contains(ts, `"error":"Cannot create property 'x' on string 'str'"`) {
		t.Fatalf("the TS parse misses cases: %s", ts)
	}
	sameLines(t, parseCases, jsjson.Stringify(out, ""), ts)
}

// writeFiles writes each file under dir, making its folders.
func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// TestScanMatchesTS: the import scan of a fixture home (~/.claude.json with its projects, ~/.codex/config.toml, and
// OpenCode's opencode.json and .jsonc) and agent folders (a .mcp.json in a folder and at its git root), each server
// marked against settings.mcpServers, matches src/mcp-import.ts (with src/mcp-config.ts) on the same files.
func TestScanMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	home := t.TempDir()
	repo := filepath.Join(home, "repo")
	sub := filepath.Join(repo, "sub")
	writeFiles(t, home, map[string]string{
		".claude.json": `{"mcpServers": {"gh": {"type": "http", "url": "https://api.example/mcp", "headers": {"Authorization": "Bearer x"}},
		  "stam": {"command": "stam", "args": ["mcp"]}, "same": {"command": "npx", "args": ["s"], "env": {"B": "2", "A": "1"}}},
		  "projects": {"` + repo + `": {"mcpServers": {"proj": {"command": "p", "env": {"K": "v"}}}}, "/elsewhere": {"mcpServers": {"far": {"url": "https://far.example/sse"}}},
		  "` + home + `": {"mcpServers": {"homeproj": {"command": "h"}}}, "bad": 5, "empty": {}}}`,
		".codex/config.toml": "model = \"o3\"\n[mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\nbearer_token_env_var = \"T\"\n" +
			"[mcp_servers.differs]\ncommand = \"new\"\nargs = [\"a\"]\nenv = { ONLY_FOUND = \"x\", SHARED = \"changed\", SAME = \"s\" }\nhttp_headers = { H = \"1\" }\n",
		".config/opencode/opencode.jsonc": "{\n  // OpenCode's own config\n  \"mcp\": {\n    /* a block\n comment */ \"oc\": {\"type\": \"local\", \"command\": [\"oc\", \"--x\"], \"enabled\": false,},\n" +
			"    \"url\": {\"type\": \"remote\", \"url\": \"https://u.example/mcp\", \"headers\": {\"K\": \"a//b\"}},\n  },\n}\n",
		".config/opencode/opencode.json": `{"mcp": {"servers": {"plain": {"command": "pl"}}}}`,
		"repo/.mcp.json":                 `{"mcpServers": {"root": {"command": "r"}, "same": {"command": "npx", "args": ["s"], "env": {"A": "1", "B": "2"}}}}`,
		"repo/sub/.mcp.json":             `{"sub": {"url": "https://sub.example/mcp"}}`,
		"other/.mcp.json":                `{not json`,
	})
	if out, err := exec.Command("git", "init", "-q", repo).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	cwds := []string{sub, repo, "", filepath.Join(home, "other"), filepath.Join(home, "missing")}
	existing := `{"same": {"args": ["s"], "command": "npx", "env": {"A": "1", "B": "2"}},
	  "differs": {"command": "old", "env": {"ONLY_STAM": "y", "SHARED": "orig", "SAME": "s"}, "headers": {"H": "1"}, "auth": {"type": "oauth"}, "enabled": false},
	  "gh": {"url": "https://api.example/mcp", "headers": {"Authorization": "Bearer y"}}, "root": "truthy", "plain": 0}`
	var ex any
	if err := json.Unmarshal([]byte(existing), &ex); err != nil {
		t.Fatal(err)
	}
	ts := runTS(t, map[string]any{"op": "scan", "home": home, "cwds": cwds, "existing": ex})
	exGo, _ := jsjson.Parse([]byte(existing))
	got := jsjson.Stringify(ScanHarnesses(context.Background(), home, cwds, exGo), "")
	if !strings.Contains(ts, `"status":"differs"`) || !strings.Contains(ts, `"status":"same"`) || !strings.Contains(ts, `"name":"sub"`) {
		t.Fatalf("the TS scan misses cases: %s", ts)
	}
	sameLines(t, nil, got, ts)
}

// fakeRegistry is the MCP registry on loopback: each search names a page, and every query it was asked is kept.
type fakeRegistry struct {
	srv     *httptest.Server
	mu      sync.Mutex
	queries []string
}

const registryPage = `{"servers": [
  {"server": {"name": "io.x/multi", "version": "1.2.9", "description": "old"}},
  {"server": {"name": "io.x/multi", "version": "1.2.10", "description": "new", "title": "Multi",
    "remotes": [{"type": "sse", "url": "https://m.example/sse"}, {"type": "streamable-http", "url": "https://m.example/mcp",
      "headers": [{"name": "Authorization", "value": "Bearer {token}", "isSecret": true, "description": "the key"},
        {"name": "X-Fixed", "value": "v1"}, {"name": "X-Opt", "isRequired": false, "description": null}, {"value": "no name"}, null]}]}},
  {"server": {"name": "io.x/flagged", "version": "2.0.0", "remotes": [{"type": "sse", "url": "https://f.example/sse"}]},
    "_meta": {"io.modelcontextprotocol.registry/official": {"isLatest": true}}},
  {"server": {"name": "io.x/flagged", "version": "9.0.0"}},
  {"server": {"name": "io.x/pkgs", "version": "1.0", "websiteUrl": "https://pkgs.example", "repository": {"url": "https://github.com/x/pkgs"},
    "_meta": {"io.modelcontextprotocol.registry/publisher-provided": {"title": "From the publisher"}},
    "packages": [
      {"registryType": "npm", "identifier": "@x/srv", "version": "1.0.0",
        "packageArguments": [{"type": "positional", "value": "serve"}, {"type": "named", "name": "port", "value": 8080}, {"type": "named", "name": "user"}, "bad", null, [1]],
        "runtimeArguments": [{"type": "positional", "value": "-y"}, {"type": "named", "value": "nameless"}],
        "environmentVariables": [{"name": "API_KEY", "isSecret": true, "isRequired": true, "description": "key"},
          {"name": "MODE", "value": "fast"}, {"name": "URL", "value": "{base}/x", "default": "http://d", "isRequired": true}, {"name": "D", "default": "dv"}, {"description": "nameless"}]},
      {"registryType": "pypi", "identifier": "x-srv"},
      {"registryType": "oci", "identifier": "ghcr.io/x/srv", "version": "2"},
      {"registryType": "nuget", "identifier": "x"},
      {"registryType": "npm"}]}},
  {"server": {"name": "io.x/versions", "version": "1.0"}}, {"server": {"name": "io.x/versions", "version": "1"}},
  {"server": {"name": "io.x/versions", "version": "1.0.0-beta"}}, {"server": {"name": "io.x/versions", "version": "1.0.0-alpha"}},
  {"server": {"name": 7, "version": 3}},
  {"server": {"version": "1"}}, {"other": 1}, null
], "metadata": {"nextCursor": "c2"}}`

func newFakeRegistry(t *testing.T) *fakeRegistry {
	f := &fakeRegistry{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.queries = append(f.queries, r.Method+" "+r.URL.RawQuery+" "+r.Header.Get("Accept"))
		f.mu.Unlock()
		switch r.URL.Query().Get("search") {
		case "fail":
			w.WriteHeader(503)
		case "junk":
			_, _ = w.Write([]byte("<html>"))
		case "moved":
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
		case "empty":
			_, _ = w.Write([]byte(`{"servers": "no", "metadata": {"nextCursor": ""}}`))
		default:
			_, _ = w.Write([]byte(registryPage))
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeRegistry) take() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	q := f.queries
	f.queries = nil
	return q
}

type browseCall struct {
	Search string `json:"search"`
	Cursor string `json:"cursor,omitempty"`
}

// TestBrowseMatchesTS: a registry page (latest versions only, install options from remotes and packages, the next
// cursor), the registry's refusals, and the queries sent, with the base url's own query kept, match
// src/mcp-registry.ts against the same fake registry.
func TestBrowseMatchesTS(t *testing.T) {
	f := newFakeRegistry(t)
	base := f.srv.URL + "/v0.1/servers?limit=5&x=a+b%20c&y=%7E*&x=dup"
	calls := []browseCall{{Search: ""}, {Search: "a b~*é&=", Cursor: "next/1+2"}, {Search: "fail"}, {Search: "junk"}, {Search: "moved"}, {Search: "empty"}}
	ts := runTS(t, map[string]any{"op": "browse", "base": base, "calls": calls})
	tsQueries := f.take()
	r := NewRegistry(func() string { return base })
	var out []any
	var labels []string
	for _, c := range calls {
		v, err := r.Browse(context.Background(), c.Search, c.Cursor)
		out = append(out, settle(v, err))
		labels = append(labels, c.Search)
	}
	if !strings.Contains(ts, `"nextCursor":"c2"`) || !strings.Contains(ts, `"error":"the MCP registry answered HTTP 503"`) {
		t.Fatalf("the TS browse misses cases: %s", ts)
	}
	sameLines(t, labels, jsjson.Stringify(out, ""), ts)
	if g, w := strings.Join(f.take(), "\n"), strings.Join(tsQueries, "\n"); g != w {
		t.Errorf("queries:\nGo:\n%s\nTS:\n%s", g, w)
	}
}

// TestProbeMatchesTS: remoteAuth's answer for GitHub's server (with no request), a server that asks for OAuth, a 401
// without a challenge, an open server, an unreachable one and urls that don't parse matches src/mcp-registry.ts.
func TestProbeMatchesTS(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(r.Body)
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path+" "+r.Header.Get("Content-Type")+" "+r.Header.Get("Accept")+" "+r.Header.Get("Authorization")+" "+buf.String())
		mu.Unlock()
		switch r.URL.Path {
		case "/oauth":
			w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="x"`)
			w.WriteHeader(401)
		case "/bare":
			w.WriteHeader(401)
		case "/moved":
			http.Redirect(w, r, "/oauth", http.StatusTemporaryRedirect)
		}
	}))
	t.Cleanup(srv.Close)
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	urls := []string{"https://api.githubcopilot.com/mcp/", "https://API.GITHUBCOPILOT.COM/x", srv.URL + "/oauth", srv.URL + "/bare", srv.URL + "/open",
		srv.URL + "/moved", closed.URL + "/mcp", "http://", "ftp://x"}
	ts := runTS(t, map[string]any{"op": "probe", "urls": urls})
	mu.Lock()
	tsSeen := seen
	seen = nil
	mu.Unlock()
	r := NewRegistry(func() string { return "" })
	var out []any
	for _, u := range urls {
		if a := r.RemoteAuth(context.Background(), u); a != "" {
			out = append(out, a)
		} else {
			out = append(out, nil)
		}
	}
	if !strings.Contains(ts, `"gh","gh","oauth",null`) {
		t.Fatalf("the TS probe misses cases: %s", ts)
	}
	sameLines(t, urls, jsjson.Stringify(out, ""), ts)
	if g, w := strings.Join(seen, "\n"), strings.Join(tsSeen, "\n"); g != w {
		t.Errorf("requests:\nGo:\n%s\nTS:\n%s", g, w)
	}
}

// fakeMCP is a streamable-HTTP MCP server on loopback whose path picks its behaviour; it keeps each request's
// headers and body.
func fakeMCP(t *testing.T) (*httptest.Server, func() []string) {
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(r.Body)
		body := buf.String()
		mu.Lock()
		seen = append(seen, r.URL.Path+" "+r.Header.Get("Content-Type")+" | "+r.Header.Get("Accept")+" | "+r.Header.Get("Mcp-Session-Id")+" | "+r.Header.Get("X-Key")+" | "+body)
		mu.Unlock()
		initReq, list := strings.Contains(body, `"initialize"`), strings.Contains(body, `"tools/list"`)
		switch r.URL.Path {
		case "/json":
			w.Header().Set("Content-Type", "application/json")
			if initReq {
				w.Header().Set("Mcp-Session-Id", "sess-9")
				_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
			} else if list {
				_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"a"},{"name":5},{}]}}`))
			} else {
				w.WriteHeader(202)
			}
		case "/sse":
			w.Header().Set("Content-Type", "text/event-stream")
			if initReq {
				_, _ = w.Write([]byte("event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"note\"}\r\n\r\ndata: not json\n\ndata: {\"jsonrpc\":\"2.0\",\n data:\"id\":1,\"result\":{}}\n\n"))
			} else if list {
				_, _ = w.Write([]byte("data: {\"id\":2,\"result\":{\"tools\":[{\"name\":\"s\"}]}}\n\n"))
			}
		case "/initerr":
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"message":"bad init"}}`))
		case "/listerr":
			if list {
				_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":2,"error":"plain"}`))
			}
		case "/notools":
			if list {
				_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":2,"result":{}}`))
			}
		case "/boom":
			w.WriteHeader(500)
			_, _ = w.Write([]byte(strings.Repeat("é", 200)))
		case "/moved":
			http.Redirect(w, r, "/json", http.StatusFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, func() []string {
		mu.Lock()
		defer mu.Unlock()
		s := seen
		seen = nil
		return s
	}
}

// TestCheckMatchesTS: testServer's tools or error, for stdio servers (an answer, an RPC error, an exit, a missing
// command) and remote ones (JSON and SSE answers, a session id, an RPC error, an HTTP error, a redirect, an
// unreachable server), and the requests a remote one gets, match src/mcp-config.ts.
func TestCheckMatchesTS(t *testing.T) {
	srv, take := fakeMCP(t)
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	sh := func(script string) map[string]any {
		return map[string]any{"command": "sh", "args": []any{"-c", script}, "env": map[string]any{"GREETING": "hi"}}
	}
	answer := `read a; echo; echo 'noise'; echo '{"jsonrpc":"2.0","id":1,"result":{}}'; read b; read c; ` +
		`echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"$GREETING\"},{\"name\":\"t2\"}]}}"; read d`
	servers := [][2]any{
		{"answer", sh(answer)},
		{"initerr", sh(`read a; echo '{"id":1,"error":{"message":"no init"}}'; read b; read c; read d`)},
		{"listerr", sh(`read a; read b; read c; echo '{"id":2,"error":{}}'; read d`)},
		{"exits", sh(`exit 3`)},
		{"missing", map[string]any{"command": "/nonexistent/mcp-server"}},
		{"neither", map[string]any{"env": map[string]any{}}},
		{"json", map[string]any{"url": srv.URL + "/json", "headers": map[string]any{"X-Key": "k1"}}},
		{"sse", map[string]any{"url": srv.URL + "/sse"}},
		{"initerr-remote", map[string]any{"url": srv.URL + "/initerr"}},
		{"listerr-remote", map[string]any{"url": srv.URL + "/listerr"}},
		{"notools", map[string]any{"url": srv.URL + "/notools"}},
		{"boom", map[string]any{"url": srv.URL + "/boom"}},
		{"moved", map[string]any{"url": srv.URL + "/moved"}},
		{"closed", map[string]any{"url": closed.URL + "/mcp"}},
	}
	ts := runTS(t, map[string]any{"op": "check", "servers": servers})
	tsSeen := take()
	var out []any
	var labels []string
	noToken := func(context.Context, string) (string, error) { t.Error("no server here has an auth"); return "", nil }
	for _, s := range servers {
		b, _ := json.Marshal(s[1])
		v, _ := jsjson.Parse(b)
		out = append(out, Check(context.Background(), s[0].(string), v, noToken, noRedirects()))
		labels = append(labels, s[0].(string))
	}
	if !strings.Contains(ts, `{"ok":true,"tools":["hi","t2"]}`) || !strings.Contains(ts, `"error":"the server exited (3)"`) {
		t.Fatalf("the TS check misses cases: %s", ts)
	}
	sameLines(t, labels, jsjson.Stringify(out, ""), ts)
	if g, w := strings.Join(take(), "\n"), strings.Join(tsSeen, "\n"); g != w {
		t.Errorf("requests:\nGo:\n%s\nTS:\n%s", g, w)
	}
}

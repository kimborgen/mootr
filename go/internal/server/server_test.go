package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/api"
	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/sse"
	"stam/internal/templates"
)

// seeded is a stam.db built by the TS daemon's src/db.ts (testdata/seed.mjs), once per run; each test copies it.
var seeded string

func TestMain(m *testing.M) {
	// No test reads this machine's tailnet; one that needs nodes sets its own.
	tailscaleStatus = func(context.Context) []byte { return nil }
	dir, err := os.MkdirTemp("", "stam-server-seed-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	code := func() int {
		defer os.RemoveAll(dir)
		home := filepath.Join(dir, "home")
		if err := os.Mkdir(home, 0o700); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if out, err := exec.Command("node", "testdata/seed.mjs", home).CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "seed.mjs: %v\n%s", err, out)
			return 1
		}
		seeded = filepath.Join(home, "stam.db")
		before := dirFiles(".")
		code := m.Run()
		// A fixture that launches an agent with an empty claude.Env.Home writes agents/ under the working directory,
		// which is this package's source directory.
		if added := newFiles(before, dirFiles(".")); len(added) > 0 {
			fmt.Fprintf(os.Stderr, "tests wrote inside the package directory: %v\n", added)
			return 1
		}
		return code
	}()
	os.Exit(code)
}

// dirFiles is every path under dir, as a set.
func dirFiles(dir string) map[string]bool {
	files := map[string]bool{}
	_ = filepath.WalkDir(dir, func(p string, _ os.DirEntry, err error) error {
		if err == nil {
			files[p] = true
		}
		return nil
	})
	return files
}

// newFiles is the paths in after that are not in before, sorted.
func newFiles(before, after map[string]bool) []string {
	var added []string
	for p := range after {
		if !before[p] {
			added = append(added, p)
		}
	}
	sort.Strings(added)
	return added
}

const (
	sharedTok = "shared-token-value"
	peerTok   = "peer-token-value"
	agentTok  = "agent-token-value"
	serverTok = "opencode-token-value"
	humanKey  = "test-human-key"
)

type fixture struct {
	t    *testing.T
	home string
	cfg  config.Config
	db   *db.DB
	hub  *sse.Hub
	srv  *Server
}

// newFixture is a test home (marker and owner file, as test/lib.sh makes one) with the seeded stam.db, tokens, an
// agent token for achild and the OpenCode server's token. env adds to the environment config.Load reads.
func newFixture(t *testing.T, env map[string]string) *fixture { return newFixtureFrom(t, env, seeded) }

// newFixtureFrom is newFixture over another stam.db.
func newFixtureFrom(t *testing.T, env map[string]string, dbFile string) *fixture {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	must(t, os.Mkdir(home, 0o700))
	must(t, os.WriteFile(filepath.Join(root, "owner"), []byte("test"), 0o600))
	must(t, os.WriteFile(filepath.Join(home, config.TestHomeMarker), nil, 0o600))
	must(t, os.WriteFile(filepath.Join(home, "token"), []byte(sharedTok+"\n"), 0o600))
	must(t, os.WriteFile(filepath.Join(home, "peer-token"), []byte(peerTok+"\n"), 0o600))
	must(t, os.WriteFile(filepath.Join(home, "opencode-token"), []byte(auth.Hash(serverTok)), 0o600))
	b, err := os.ReadFile(dbFile)
	must(t, err)
	must(t, os.WriteFile(filepath.Join(home, "stam.db"), b, 0o600))

	vars := map[string]string{"STAM_HOME": home, "STAM_PORT": "7999", "STAM_MACHINE": "test-machine", "STAM_TMUX_SOCKET": "stam-test-x"}
	for k, v := range env {
		vars[k] = v
	}
	cfg, err := config.Load(func(k string) string { return vars[k] })
	must(t, err)
	d, err := db.Open(context.Background(), cfg.DBPath(), db.Options{})
	must(t, err)
	t.Cleanup(func() { d.Close() })
	must(t, d.Write(context.Background(), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "UPDATE agents SET token_hash = ? WHERE id = 'achild'", &sqlitex.ExecOptions{Args: []any{auth.Hash(agentTok)}})
	}))
	hub := sse.New(20 * time.Millisecond)
	t.Cleanup(func() { hub.Close(context.Background()) })
	st := config.NewSettingsFile(home, cfg.Machine)
	srv := New(cfg, st, d, hub, nil)
	// A quiet host for the slot queue's load guard, whatever this machine's load (S-2120).
	srv.devSlots.q.host = func() hostReading { return hostReading{load1: 0.1, freeBytes: 12 * gib} }
	// The checkout's templates, as the daemon renders the human's ask from (the go module sits in the checkout's go/).
	checkout, err := filepath.Abs("../../..")
	must(t, err)
	srv.UseTemplates(&templates.Set{Root: checkout, Home: home, UserHome: home, Settings: st.Get})
	return &fixture{t: t, home: home, cfg: cfg, db: d, hub: hub, srv: srv}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

type call struct {
	method, path, token string
	header              map[string]string
	host                string
	body                string
	// ctx is the request's context, when the test cancels it.
	ctx context.Context
}

func (f *fixture) do(c call) *httptest.ResponseRecorder {
	f.t.Helper()
	method := c.method
	if method == "" {
		method = http.MethodGet
	}
	r := httptest.NewRequest(method, c.path, strings.NewReader(c.body))
	if c.ctx != nil {
		r = r.WithContext(c.ctx)
	}
	r.Host = "127.0.0.1:7999"
	if c.host != "" {
		r.Host = c.host
	}
	if c.token != "" {
		r.Header.Set("Authorization", "Bearer "+c.token)
	}
	for k, v := range c.header {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, r)
	return rec
}

// envelope decodes an error answer and checks it is the {error} shape.
func envelope(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q is not JSON: %v", rec.Body.String(), err)
	}
	if _, ok := body["error"].(string); !ok {
		t.Fatalf("body %v has no error string", body)
	}
	return body
}

// TestCallerKinds is callerOf's parity: each token kind gets what TS gives it on the guards the first routes use.
func TestCallerKinds(t *testing.T) {
	f := newFixture(t, map[string]string{"STAM_TEST_COST_HOOKS": "1", "STAM_TEST_HUMAN_KEY": humanKey})
	human := map[string]string{"X-Stam-Test-Human": humanKey}
	cases := []struct {
		name   string
		c      call
		status int
		error  string
	}{
		{"none", call{path: "/api/agents"}, 401, "bad token"},
		{"a wrong token", call{path: "/api/agents", token: "nope"}, 401, "bad token"},
		{"a token's prefix", call{path: "/api/agents", token: sharedTok[:5]}, 401, "bad token"},
		{"an empty bearer", call{path: "/api/agents", header: map[string]string{"Authorization": "Bearer "}}, 401, "bad token"},
		{"the shared token", call{path: "/api/agents", token: sharedTok}, 200, ""},
		{"the peer token", call{path: "/api/agents", token: peerTok}, 200, ""},
		{"an agent token", call{path: "/api/agents", token: agentTok}, 200, ""},
		{"the test human", call{path: "/api/agents", header: human}, 200, ""},
		{"the shared token with x-stam-local", call{path: "/api/agents", token: sharedTok, header: map[string]string{"X-Stam-Local": "1"}}, 403, "peer headers need the peer token"},
		{"the shared token with x-stam-agent", call{path: "/api/agents", token: sharedTok, header: map[string]string{"X-Stam-Agent": "achild"}}, 403, "peer headers need the peer token"},
		{"an agent token on the event stream", call{path: "/api/live", token: agentTok}, 403, "an agent's token can't read the daemon event stream"},
		{"the OpenCode token on the event stream", call{path: "/api/live", token: serverTok}, 403, "an agent's token can't read the daemon event stream"},
		{"a peer forwarding an agent on the event stream", call{path: "/api/live", token: peerTok, header: map[string]string{"X-Stam-Local": "1", "X-Stam-Agent": "achild"}}, 403, "an agent's token can't"},
		{"an agent token on a test route", call{path: "/api/test/blockers", token: agentTok}, 403, "an agent's token can't call the test hooks"},
		{"the OpenCode token on a test route", call{path: "/api/test/blockers", token: serverTok}, 403, "an agent's token can't call the test hooks"},
		{"the shared token on a test route", call{path: "/api/test/blockers", token: sharedTok}, 200, ""},
		{"the shared token on a test path with no route", call{path: "/api/test/nope", token: sharedTok}, 404, "no route GET /api/test/nope"},
		{"the human writing without x-stam-human", call{method: "POST", path: "/api/agents", header: human}, 403, "a write needs the x-stam-human header"},
		{"the human naming another host", call{path: "/api/agents", header: human, host: "elsewhere:7999"}, 403, "must name this daemon as its host"},
		{"the human from another site", call{path: "/api/agents", header: map[string]string{"X-Stam-Test-Human": humanKey, "Origin": "http://elsewhere"}}, 403, "another site needs a token"},
		{"the human from its own page", call{path: "/api/agents", header: map[string]string{"X-Stam-Test-Human": humanKey, "Origin": "http://localhost:7999"}}, 200, ""},
		{"a wrong test human key", call{path: "/api/agents", header: map[string]string{"X-Stam-Test-Human": "nope"}}, 401, "bad token"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := f.do(tc.c)
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tc.status, rec.Body.String())
			}
			if tc.error != "" {
				if got := envelope(t, rec)["error"].(string); !strings.Contains(got, tc.error) {
					t.Fatalf("error = %q, want it to hold %q", got, tc.error)
				}
			}
		})
	}
}

func TestCallerOfKinds(t *testing.T) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	for _, tc := range []struct {
		header map[string]string
		want   auth.Caller
	}{
		{map[string]string{"Authorization": "Bearer " + peerTok}, auth.Caller{Kind: auth.Peer}},
		{map[string]string{"Authorization": "Bearer " + sharedTok}, auth.Caller{Kind: auth.Shared}},
		{map[string]string{"Authorization": "Bearer " + agentTok}, auth.Caller{Kind: auth.Agent, Agent: "achild"}},
		{map[string]string{"Authorization": "Bearer " + serverTok}, auth.Caller{Kind: auth.OpenCode}},
		{map[string]string{"X-Stam-Test-Human": humanKey}, auth.Caller{Kind: auth.Owner}},
		// A bad token falls through to the human's proof, as in TS.
		{map[string]string{"Authorization": "Bearer nope", "X-Stam-Test-Human": humanKey}, auth.Caller{Kind: auth.Owner}},
		{map[string]string{"Authorization": "Basic " + sharedTok}, auth.Caller{Kind: auth.None}},
		{map[string]string{}, auth.Caller{Kind: auth.None}},
	} {
		r := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
		for k, v := range tc.header {
			r.Header.Set(k, v)
		}
		got, err := f.srv.auth.CallerOf(r)
		must(t, err)
		if got != tc.want {
			t.Errorf("%v: caller = %+v, want %+v", tc.header["Authorization"], got, tc.want)
		}
	}
}

// TestCallerOfOwned: the human's proof is Owned with no token or with the shared token or a peer's beside it, as TS's
// owned is trustedHuman whatever the token; never with an agent's or the OpenCode server's token, a peer's forwarded agent,
// or x-stam-local, and never without the proof. The kind stays what the token says.
func TestCallerOfOwned(t *testing.T) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	for _, tc := range []struct {
		name   string
		header map[string]string
		kind   auth.Kind
		owned  bool
	}{
		{"the proof alone", map[string]string{}, auth.Owner, true},
		// Narrower than TS on purpose: x-stam-local is never the human, even with no token.
		{"the proof alone with x-stam-local", map[string]string{"X-Stam-Local": "1"}, auth.Owner, false},
		{"the shared token", map[string]string{"Authorization": "Bearer " + sharedTok}, auth.Shared, true},
		{"a peer's token", map[string]string{"Authorization": "Bearer " + peerTok}, auth.Shared, true},
		{"a peer's local call", map[string]string{"Authorization": "Bearer " + peerTok, "X-Stam-Local": "1"}, auth.Shared, false},
		{"a peer's forwarded agent", map[string]string{"Authorization": "Bearer " + peerTok, "X-Stam-Local": "1", "X-Stam-Agent": "achild"}, auth.Agent, false},
		{"an agent's token", map[string]string{"Authorization": "Bearer " + agentTok}, auth.Agent, false},
		{"the OpenCode server's token", map[string]string{"Authorization": "Bearer " + serverTok}, auth.OpenCode, false},
	} {
		for _, proof := range []bool{true, false} {
			r := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
			r.Host = "127.0.0.1:7999"
			for k, v := range tc.header {
				r.Header.Set(k, v)
			}
			if proof {
				r.Header.Set("X-Stam-Test-Human", humanKey)
			} else if tc.kind == auth.Owner {
				continue
			}
			got, err := f.srv.callerOf(r)
			must(t, err)
			if want := proof && tc.owned; got.Owned != want || got.Kind != tc.kind {
				t.Errorf("%s, proof %v: kind %s owned %v, want %s %v", tc.name, proof, got.Kind, got.Owned, tc.kind, want)
			}
		}
	}
	// A wrong key is no proof, and the refusal doesn't echo it.
	rec := f.do(call{path: "/api/agents", header: map[string]string{"X-Stam-Test-Human": "wrong-" + humanKey}})
	if rec.Code != 401 || strings.Contains(rec.Body.String(), humanKey) {
		t.Errorf("a wrong key: %d %s", rec.Code, rec.Body.String())
	}
}

// TestTestRoutesGate: /api/test/* answers only when both TS conditions hold; otherwise a 404 before any route.
func TestTestRoutesGate(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  map[string]string
		want string
	}{
		{"test hooks off", map[string]string{}, "not found"},
		{"a non-test tmux socket", map[string]string{"STAM_TEST_COST_HOOKS": "1", "STAM_TMUX_SOCKET": "stam"}, "not found"},
		{"both hold", map[string]string{"STAM_TEST_COST_HOOKS": "1"}, "no route GET /api/test/nope"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t, tc.env)
			rec := f.do(call{path: "/api/test/nope", token: sharedTok})
			if rec.Code != 404 || envelope(t, rec)["error"] != tc.want {
				t.Fatalf("got %d %s, want 404 %q", rec.Code, rec.Body.String(), tc.want)
			}
		})
	}
	t.Run("not a test home", func(t *testing.T) {
		f := newFixture(t, map[string]string{"STAM_TEST_COST_HOOKS": "1"})
		must(t, os.Remove(filepath.Join(f.home, config.TestHomeMarker)))
		cfg, err := config.Load(func(k string) string {
			return map[string]string{"STAM_HOME": f.home, "STAM_TEST_COST_HOOKS": "1", "STAM_TMUX_SOCKET": "stam-test-x"}[k]
		})
		must(t, err)
		if cfg.TestHome || cfg.TestHooks {
			t.Fatalf("TestHome %v TestHooks %v without the marker, want false", cfg.TestHome, cfg.TestHooks)
		}
	})
}

func TestErrorEnvelope(t *testing.T) {
	f := newFixture(t, nil)
	for _, c := range []call{
		{method: "GET", path: "/api/no-such-route", token: sharedTok},
		{method: "POST", path: "/api/health", token: sharedTok},
		{method: "HEAD", path: "/api/health", token: sharedTok},
		{method: "DELETE", path: "/api/agents", token: sharedTok},
		{method: "GET", path: "/api//agents", token: sharedTok},
		{method: "GET", path: "/api/./health", token: sharedTok},
		{method: "GET", path: "/api/agents/", token: sharedTok},
	} {
		rec := f.do(c)
		if rec.Code != 404 {
			t.Fatalf("%s %s: status %d, want 404", c.method, c.path, rec.Code)
		}
		if c.method == "HEAD" {
			continue
		}
		want := fmt.Sprintf("no route %s %s", c.method, c.path)
		if got := envelope(t, rec)["error"]; got != want {
			t.Fatalf("error = %q, want %q", got, want)
		}
	}
	if rec := f.do(call{method: "OPTIONS", path: "/api/agents"}); rec.Code != 403 || rec.Body.Len() != 0 {
		t.Fatalf("OPTIONS: %d %q, want an empty 403", rec.Code, rec.Body.String())
	}
}

// TestHumanOnMachine: the 409 refusal has exactly the schema's fields.
func TestHumanOnMachine(t *testing.T) {
	origin := "https://other.example"
	for _, o := range []*string{&origin, nil} {
		rec := httptest.NewRecorder()
		writeError(rec, HumanOnMachine("a write on other is the human's", "other", o))
		if rec.Code != http.StatusConflict {
			t.Fatalf("status %d, want 409", rec.Code)
		}
		body := envelope(t, rec)
		keys := []string{}
		for k := range body {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		if !reflect.DeepEqual(keys, []string{"error", "machine", "origin", "refusal"}) {
			t.Fatalf("keys = %v", keys)
		}
		var typed api.HumanOnMachineRefusal
		must(t, json.Unmarshal(rec.Body.Bytes(), &typed))
		if typed.Refusal != api.HumanOnMachineRefusalRefusalHumanOnMachine || typed.Machine != "other" || (o == nil) != (typed.Origin == nil) {
			t.Fatalf("refusal = %+v", typed)
		}
	}
}

func TestHealth(t *testing.T) {
	f := newFixture(t, nil)
	rec := f.do(call{path: "/api/health", token: sharedTok})
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	must(t, json.Unmarshal(rec.Body.Bytes(), &body))
	if body["ok"] != true || body["machine"] != "test-machine" || body["release"] != nil {
		t.Fatalf("body = %v", body)
	}
	if s, ok := body["stalls"].([]any); !ok || len(s) != 0 {
		t.Fatalf("stalls = %v, want []", body["stalls"])
	}
	mem, _ := body["memory"].(map[string]any)
	if rss, _ := mem["rss"].(float64); rss <= 0 {
		t.Fatalf("memory = %v, want an rss", mem)
	}
	f2 := newFixture(t, map[string]string{"STAM_RELEASE_ID": "abc123"})
	if got := f2.do(call{path: "/api/health", token: sharedTok}).Body.String(); !strings.Contains(got, `"release":"abc123"`) {
		t.Fatalf("health = %s, want release abc123", got)
	}
}

func agents(t *testing.T, f *fixture, c call) map[string]map[string]any {
	t.Helper()
	rec := f.do(c)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var list []map[string]any
	must(t, json.Unmarshal(rec.Body.Bytes(), &list))
	out := map[string]map[string]any{}
	for _, a := range list {
		out[a["id"].(string)] = a
	}
	return out
}

func TestAgentsExtras(t *testing.T) {
	f := newFixture(t, nil)
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"chiefOfStaff":"boss","cost":{"display":{"mode":"seven_day"}}}`), 0o600))
	got := agents(t, f, call{path: "/api/agents?state=all", token: sharedTok})
	if len(got) != 4 {
		t.Fatalf("agents = %d, want 4", len(got))
	}
	boss, child, coder, gone := got["aboss"], got["achild"], got["acodex"], got["agone"]
	check := func(name string, have, want any) {
		t.Helper()
		if !reflect.DeepEqual(have, want) {
			t.Errorf("%s = %#v, want %#v", name, have, want)
		}
	}
	check("child parents", child["parents"], []any{"aboss", "acodex"})
	check("boss parents", boss["parents"], []any{})
	check("child unread (one read, one deferred)", child["unread"], 1.0)
	check("child cost_usd", child["cost_usd"], 1.75)
	check("boss cost_usd", boss["cost_usd"], 0.0)
	check("child pending_requests (human only)", child["pending_requests"], 1.0)
	check("boss chief_of_staff", boss["chief_of_staff"], true)
	check("child chief_of_staff", child["chief_of_staff"], false)
	check("boss default_view", boss["default_view"], "terminal")
	check("child default_view", child["default_view"], nil)
	check("boss view (claude with a transcript)", boss["view"], map[string]any{"can_stream": false, "can_send": true, "can_interrupt": true, "can_approve": false})
	check("child view (no transcript)", child["view"], nil)
	check("coder view (codex with a thread)", coder["view"], map[string]any{"can_stream": true, "can_send": true, "can_interrupt": true, "can_approve": true})
	check("child cost mode", child["cost"].(map[string]any)["mode"], "seven_day")
	check("child load context_tokens", child["load"].(map[string]any)["context_tokens"], 4200.0)
	check("child effort", child["effort"], "low")
	check("child last_message", child["last_message"], "hello")
	if _, ok := gone["load"]; ok {
		t.Error("an archived standing agent has load")
	}
	if _, ok := boss["load"]; ok {
		t.Error("a non-standing agent has load")
	}
	for id, a := range got {
		if _, ok := a["token_hash"]; ok {
			t.Errorf("%s carries token_hash", id)
		}
		if _, ok := a["cost_raw"]; ok {
			t.Errorf("%s carries cost_raw without x-stam-local", id)
		}
	}
	local := agents(t, f, call{path: "/api/agents", token: peerTok, header: map[string]string{"X-Stam-Local": "1"}})
	if _, ok := local["achild"]["cost_raw"].(map[string]any); !ok {
		t.Errorf("a peer's call has no cost_raw: %v", local["achild"]["cost_raw"])
	}
	if raw := f.do(call{path: "/api/agents", token: sharedTok}).Body.String(); strings.Contains(raw, strings.Repeat("f", 64)) || strings.Contains(raw, auth.Hash(agentTok)) {
		t.Error("the agent list holds a token hash")
	}
}

func TestAgentsQueries(t *testing.T) {
	f := newFixture(t, nil)
	ids := func(c call) []string {
		rec := f.do(c)
		var list []struct {
			ID string `json:"id"`
		}
		must(t, json.Unmarshal(rec.Body.Bytes(), &list))
		out := []string{}
		for _, a := range list {
			out = append(out, a.ID)
		}
		return out
	}
	if got := ids(call{path: "/api/agents?q=cod", token: sharedTok}); !reflect.DeepEqual(got, []string{"acodex"}) {
		t.Errorf("q=cod: %v", got)
	}
	if got := ids(call{path: "/api/agents?q=achild", token: sharedTok}); !reflect.DeepEqual(got, []string{"achild"}) {
		t.Errorf("q=achild: %v", got)
	}
	// Standing first, created order kept within each group.
	if got := ids(call{path: "/api/agents?role=DEVELOPER&state=all", token: sharedTok}); !reflect.DeepEqual(got, []string{"achild", "agone"}) {
		t.Errorf("role=DEVELOPER: %v", got)
	}
	if got := ids(call{path: "/api/agents?role=&state=all", token: sharedTok}); !reflect.DeepEqual(got, []string{"achild", "agone", "aboss", "acodex"}) {
		t.Errorf("role=: %v", got)
	}
	if got := ids(call{path: "/api/agents?as=", token: sharedTok}); len(got) != 3 {
		t.Errorf("as= (empty) is absent in TS: %v", got)
	}
	// An agent's own as= is itself (TestAgentsVisibleTo); the OpenCode server naming no one is a 403, as is the shared
	// token naming an agent that has a token of its own (resolveActors).
	if got := ids(call{path: "/api/agents?as=", token: agentTok}); len(got) != 3 {
		t.Errorf("as= (empty) from an agent's token, which sees the registry: %v", got)
	}
	if rec := f.do(call{path: "/api/agents?as=", token: serverTok}); rec.Code != http.StatusForbidden {
		t.Errorf("as= (empty) from the OpenCode token: %d, want 403", rec.Code)
	}
	if rec := f.do(call{path: "/api/agents?as=achild", token: sharedTok}); rec.Code != http.StatusForbidden {
		t.Errorf("as=: %d, want 403", rec.Code)
	}
}

// TestAgentsListFilter: the list holds live agents unless state or ids asks for others (S-3816), refuses a state it
// doesn't know, and sends first_prompt as null while the detail keeps it (S-3808).
func TestAgentsListFilter(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'acodex'")
	f.sql("UPDATE agents SET lifecycle = 'paused' WHERE id = 'achild'")
	f.sql("UPDATE agents SET first_prompt = 'the whole spawn brief' WHERE id = 'aboss'")
	ids := func(path string) []string {
		t.Helper()
		out := []string{}
		for id := range agents(t, f, call{path: path, token: sharedTok}) {
			out = append(out, id)
		}
		sort.Strings(out)
		return out
	}
	for _, tc := range []struct {
		path string
		want []string
	}{
		{"/api/agents", []string{"aboss", "achild"}},
		{"/api/agents?state=live", []string{"aboss", "achild"}},
		{"/api/agents?state=stopped,archived", []string{"acodex", "agone"}},
		{"/api/agents?state=all", []string{"aboss", "achild", "acodex", "agone"}},
		{"/api/agents?ids=agone,coder", []string{"acodex", "agone"}},
		{"/api/agents?state=live&ids=gone", []string{"aboss", "achild", "agone"}},
		{"/api/agents?state=", []string{"aboss", "achild"}},
		{"/api/agents?ids=", []string{}},
	} {
		if got := ids(tc.path); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %v, want %v", tc.path, got, tc.want)
		}
	}
	if rec := f.do(call{path: "/api/agents?state=gone", token: sharedTok}); rec.Code != http.StatusBadRequest {
		t.Errorf("state=gone: %d, want 400", rec.Code)
	}
	for id, a := range agents(t, f, call{path: "/api/agents?state=all", token: sharedTok}) {
		if v, ok := a["first_prompt"]; !ok || v != nil {
			t.Errorf("%s first_prompt in the list = %#v, want null", id, v)
		}
	}
	if body := f.do(call{path: "/api/agents/aboss", token: sharedTok}).Body.String(); !strings.Contains(body, `"first_prompt":"the whole spawn brief"`) {
		t.Errorf("the detail lost first_prompt: %s", body)
	}
}

// TestAgentsVisibleTo: `as` keeps what that agent may see (src/org.ts visibleTo), and never widens what a token may
// see: an agent's token can't name another agent, and the shared token can't name one with its own token.
func TestAgentsVisibleTo(t *testing.T) {
	f := newFixture(t, nil)
	ids := func(path string) []string {
		t.Helper()
		out := []string{}
		for id := range agents(t, f, call{path: path, token: agentTok}) {
			out = append(out, id)
		}
		sort.Strings(out)
		return out
	}
	everyone := []string{"aboss", "achild", "acodex", "agone"}
	if got := ids("/api/agents?as=child&state=all"); !reflect.DeepEqual(got, everyone) {
		t.Errorf("an agent with the registry: %v, want %v", got, everyone)
	}
	// achild's parents are aboss (parent_id) and acodex (agent_parents); agone is its sibling.
	for _, tc := range []struct {
		visibility string
		want       []string
	}{
		{`{"reach":"parent","siblings":false,"registry":false}`, []string{"aboss", "achild", "acodex"}},
		{`{"reach":"tree","siblings":false,"registry":false}`, []string{"aboss", "achild", "acodex"}},
		{`{"reach":"tree","siblings":true,"registry":false}`, everyone},
		{`{"reach":"all","siblings":true,"registry":false}`, []string{"achild"}},
	} {
		f.sql("UPDATE agents SET visibility = '" + tc.visibility + "' WHERE id = 'achild'")
		if got := ids("/api/agents?as=&state=all"); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %v, want %v", tc.visibility, got, tc.want)
		}
	}
	// The chief of staff is always visible, and with reach 'tree' a child the viewer's own parent_id names.
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"chiefOfStaff":"gone"}`), 0o600))
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id = 'agone'")
	if got := ids("/api/agents?as="); !reflect.DeepEqual(got, []string{"achild", "agone"}) {
		t.Errorf("the chief of staff: %v, want [achild agone]", got)
	}
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{}`), 0o600))
	f.sql("UPDATE agents SET visibility = '{\"reach\":\"tree\",\"siblings\":false,\"registry\":false}' WHERE id = 'achild'")
	f.sql("UPDATE agents SET parent_id = 'achild' WHERE id = 'agone'")
	if got := ids("/api/agents?as=child&ids=agone"); !reflect.DeepEqual(got, []string{"agone"}) {
		t.Errorf("a child by ids: %v, want [agone]", got)
	}
	f.sql("UPDATE agents SET parent_id = 'aboss' WHERE id = 'agone'")
	// What ITSA tools ask to name owners: ids the viewer may not see are left out.
	if got := ids("/api/agents?as=child&ids=agone,coder"); !reflect.DeepEqual(got, []string{"acodex"}) {
		t.Errorf("ids under visibility: %v, want [acodex]", got)
	}
	// Must fail: as= never widens what a token sees.
	for _, tc := range []struct {
		name string
		c    call
		want string
	}{
		{"an agent's token naming another agent", call{path: "/api/agents?as=boss", token: agentTok}, "can't act as boss"},
		{"an agent's token naming another by id", call{path: "/api/agents?as=agone&ids=agone", token: agentTok}, "can't act as agone"},
		{"the shared token naming an agent with a token", call{path: "/api/agents?as=child", token: sharedTok}, "has its own token"},
	} {
		if rec := f.do(tc.c); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("%s: %d %s, want 403 %q", tc.name, rec.Code, rec.Body.String(), tc.want)
		}
	}
}

// TestNoSecretsInLogsOrErrors: what a refused or accepted request logs and answers never holds a token.
func TestNoSecretsInLogsOrErrors(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	f := newFixture(t, map[string]string{"STAM_TEST_COST_HOOKS": "1", "STAM_TEST_HUMAN_KEY": humanKey})
	slog.Info("config", "cfg", f.cfg, "token", f.cfg.Token)
	var bodies strings.Builder
	for _, c := range []call{
		{path: "/api/agents", token: "wrong-" + sharedTok},
		{path: "/api/agents", token: sharedTok, header: map[string]string{"X-Stam-Local": "1"}},
		{path: "/api/live", token: agentTok},
		{path: "/api/test/x", token: serverTok},
		{path: "/api/nope", token: peerTok},
		{method: "POST", path: "/api/agents", header: map[string]string{"X-Stam-Test-Human": humanKey}},
	} {
		bodies.WriteString(f.do(c).Body.String())
	}
	out := logs.String() + bodies.String() + fmt.Sprintf("%v %+v %#v", f.cfg, f.cfg, f.cfg)
	for _, secret := range []string{sharedTok, peerTok, agentTok, serverTok, humanKey, auth.Hash(agentTok), auth.Hash(serverTok)} {
		if strings.Contains(out, secret) {
			t.Fatalf("a secret leaked into logs, bodies or fmt: %q", secret)
		}
	}
	b, err := json.Marshal(f.cfg)
	must(t, err)
	if strings.Contains(string(b), sharedTok) || strings.Contains(string(b), peerTok) {
		t.Fatal("a token leaked into the config's JSON")
	}
}

// TestPanicIsAnEnvelope: a handler that panics answers a 500 envelope with no detail of the panic.
func TestPanicIsAnEnvelope(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	f := newFixture(t, nil)
	f.srv.handle("GET /api/boom", func(*http.Request, auth.Resolved) (any, error) { panic("boom " + sharedTok) })
	rec := f.do(call{path: "/api/boom", token: sharedTok})
	if rec.Code != 500 || envelope(t, rec)["error"] != "internal error" {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(logs.String(), sharedTok) {
		t.Fatal("the panic value reached the log")
	}
}

// TestLiveStream: GET /api/live is the hub's stream for the shared token; the request ends when the client goes.
func TestLiveStream(t *testing.T) {
	f := newFixture(t, nil)
	ts := httptest.NewServer(f.srv)
	t.Cleanup(ts.Close)
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/live", nil)
	must(t, err)
	req.Header.Set("Authorization", "Bearer "+sharedTok)
	req.Host = "127.0.0.1:7999"
	ctx, cancel := context.WithCancel(context.Background())
	res, err := http.DefaultClient.Do(req.WithContext(ctx))
	must(t, err)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("status %d type %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
	buf := make([]byte, len(": connected\n\n"))
	_, err = io.ReadFull(res.Body, buf)
	must(t, err)
	if string(buf) != ": connected\n\n" {
		t.Fatalf("first chunk %q", buf)
	}
	if f.hub.Len() != 1 {
		t.Fatalf("hub has %d clients, want 1", f.hub.Len())
	}
	cancel()
	res.Body.Close()
	deadline := time.Now().Add(5 * time.Second)
	for f.hub.Len() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the client's slot wasn't freed after it disconnected")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestAgentsBlockers: GET /api/agents and /api/agents/:id carry each agent's blockers, oldest first, the clear
// condition parsed; the show route keeps TS's key order, the clear's too.
func TestAgentsBlockers(t *testing.T) {
	f := newFixture(t, nil)
	f.sql(`INSERT INTO blockers (agent_id, kind, account, reason, since, clear) VALUES
		('achild', 'window', 'claude-max', 'five_hour at 100%', '2026-01-01T00:00:02.000Z', '{"windows":{"seven_day":{"pct":100},"five_hour":{"pct":100}}}'),
		('achild', 'manual', '', 'paused <until> & reset', '2026-01-01T00:00:01.000Z', NULL)`)
	got := agents(t, f, call{path: "/api/agents", token: sharedTok})
	want := []any{
		map[string]any{"agent_id": "achild", "kind": "manual", "account": "", "reason": "paused <until> & reset", "since": "2026-01-01T00:00:01.000Z", "clear": nil},
		map[string]any{"agent_id": "achild", "kind": "window", "account": "claude-max", "reason": "five_hour at 100%", "since": "2026-01-01T00:00:02.000Z",
			"clear": map[string]any{"windows": map[string]any{"seven_day": map[string]any{"pct": 100.0}, "five_hour": map[string]any{"pct": 100.0}}}},
	}
	if !reflect.DeepEqual(got["achild"]["blockers"], want) {
		t.Errorf("list blockers %#v", got["achild"]["blockers"])
	}
	if b := got["aboss"]["blockers"]; !reflect.DeepEqual(b, []any{}) {
		t.Errorf("an agent with none %#v", b)
	}
	body := f.do(call{path: "/api/agents/achild", token: sharedTok}).Body.String()
	if !strings.Contains(body, `"blockers":[{"agent_id":"achild","kind":"manual","account":"","reason":"paused <until> & reset","since":"2026-01-01T00:00:01.000Z","clear":null},{"agent_id":"achild","kind":"window","account":"claude-max","reason":"five_hour at 100%","since":"2026-01-01T00:00:02.000Z","clear":{"windows":{"seven_day":{"pct":100},"five_hour":{"pct":100}}}}]`) {
		t.Errorf("show %s", body)
	}
	if body := f.do(call{path: "/api/agents/aboss", token: sharedTok}).Body.String(); !strings.Contains(body, `"blockers":[]`) {
		t.Errorf("show with none %s", body)
	}
}

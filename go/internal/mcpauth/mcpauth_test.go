package mcpauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// mustParse parses a JSON literal in a test.
func mustParse(t *testing.T, s string) jsjson.Value {
	t.Helper()
	v, err := jsjson.Parse([]byte(s))
	if err != nil {
		t.Fatalf("parse %s: %v", s, err)
	}
	return v
}

// fixture is an Auth over a fresh home, with settings: machine is this daemon's name, home the settings home, and
// servers the settings' mcpServers as JSON.
type fixture struct {
	t        *testing.T
	a        *Auth
	settings config.Settings
}

func newFixture(t *testing.T, machine, home, servers string) *fixture {
	t.Helper()
	f := &fixture{t: t}
	f.settings = config.Settings{Home: home, McpServers: mustParse(t, servers)}
	f.a = New(Options{Home: t.TempDir(), Machine: machine, Settings: func() config.Settings { return f.settings }, Insecure: true})
	return f
}

// writeGrant writes the store with one grant, as the TS daemon would.
func (f *fixture) writeGrant(name, grant string) {
	f.t.Helper()
	s := jsjson.NewObject()
	s.Set(name, mustParse(f.t, grant))
	if err := f.a.write(s); err != nil {
		f.t.Fatal(err)
	}
}

// fakeProvider is a token endpoint: each request counts, is announced on arrived, waits for release, then answers.
type fakeProvider struct {
	srv     *httptest.Server
	calls   atomic.Int32
	arrived chan struct{}
	release chan struct{}
	status  int
	redir   bool
}

// newProvider starts a provider. With hold, its requests wait until the test closes release; otherwise they answer at once.
func newProvider(t *testing.T, status int, hold bool) *fakeProvider {
	p := &fakeProvider{arrived: make(chan struct{}, 64), release: make(chan struct{}), status: status}
	if !hold {
		close(p.release)
	}
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := p.calls.Add(1)
		p.arrived <- struct{}{}
		<-p.release
		if p.redir {
			http.Redirect(w, r, "http://elsewhere.invalid/", http.StatusFound)
			return
		}
		if p.status != 0 {
			w.WriteHeader(p.status)
			_, _ = w.Write([]byte(`{"error":"secret detail"}`))
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"NEW-` + string(rune('0'+n)) + `","refresh_token":"R2","expires_in":3600}`))
	}))
	t.Cleanup(p.srv.Close)
	return p
}

// storeJSON is one grant in the store's shape, for the store-format parity test.
const storeJSON = `{"s":{"server_url":"https://x.example/mcp","client_id":"c","token_endpoint":"https://x.example/t","access_token":"A","expires_at":1700000000000}}`

func TestPrivateIPMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/mcp-auth.ts")
	}
	ips := []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "172.32.0.1", "192.168.1.1", "100.64.0.1", "100.127.255.255",
		"169.254.1.1", "203.0.113.5", "198.51.100.7", "192.0.2.9", "224.0.0.1", "0.1.2.3", "8.8.8.8", "1.1.1.1", "999.1.1.1",
		"::1", "::", "fc00::1", "fd12::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "2606:4700::1111", "::ffff:10.0.0.1",
		"::ffff:8.8.8.8", "not-an-ip"}
	urls := []string{"http://127.0.0.1/x", "https://10.0.0.1/", "https://1.1.1.1/", "https://192.168.0.2:8443/", "nope"}
	tokens := []string{`{"access_token":"A","refresh_token":"B","expires_in":60}`, `{"ok":false,"error":"invalid_grant"}`,
		`{"ok":false}`, `{"ok":false,"error":"Bearer sk/LEAK 1234"}`, `{"ok":false,"error":"invalid_scope"}`,
		`{"authed_user":{"access_token":"U","refresh_token":"V","expires_in":5}}`, `{"x":1}`}
	// Every code Go echoes goes in too, so a code added to only one list fails the parity test (S-3503).
	codes := make([]string, 0, len(providerCodes))
	for code := range providerCodes {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	for _, code := range codes {
		tokens = append(tokens, `{"ok":false,"error":"`+code+`"}`)
	}
	raw := make([]json.RawMessage, 0, len(tokens))
	for _, tk := range tokens {
		raw = append(raw, json.RawMessage(tk))
	}
	dir := t.TempDir()
	casesFile := filepath.Join(dir, "cases.json")
	b, err := json.Marshal(map[string]any{"ips": ips, "urls": urls, "tokens": raw, "store": json.RawMessage(storeJSON)})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(casesFile, b, 0o600); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(dir, "home")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("node", "--no-warnings", "testdata/parity.mjs", home, casesFile).CombinedOutput()
	if err != nil {
		t.Fatalf("parity.mjs: %v\n%s", err, out)
	}
	want := mustParse(t, strings.TrimSpace(string(out))).(*jsjson.Object)

	wantIP, _ := want.Get("privateIp")
	for _, ip := range ips {
		v, _ := wantIP.(*jsjson.Object).Get(ip)
		if got := privateIP(ip); got != v.(bool) {
			t.Errorf("privateIP(%q) = %v, TS %v", ip, got, v)
		}
	}

	wantTok, _ := want.Get("tokenResponse")
	for i, tk := range tokens {
		w := wantTok.([]jsjson.Value)[i].(*jsjson.Object)
		got, err := tokenResponse(mustParse(t, tk))
		if msg, isErr := w.Get("error"); isErr {
			if err == nil || err.Error() != msg.(string) {
				t.Errorf("tokenResponse(%s) error %v, TS %v", tk, err, msg)
			}
			continue
		}
		if err != nil {
			t.Errorf("tokenResponse(%s) error %v, TS answered", tk, err)
			continue
		}
		okv, _ := w.Get("ok")
		if jsjson.Stringify(got, "") != jsjson.Stringify(okv, "") {
			t.Errorf("tokenResponse(%s) = %s, TS %s", tk, jsjson.Stringify(got, ""), jsjson.Stringify(okv, ""))
		}
	}

	wantEP, _ := want.Get("endpoint")
	for _, u := range urls {
		msg := "ok"
		if err := New(Options{}).assertEndpoint(context.Background(), u); err != nil {
			msg = err.Error()
		}
		w, _ := wantEP.(*jsjson.Object).Get(u)
		if msg != w.(string) {
			t.Errorf("assertEndpoint(%q) = %q, TS %q", u, msg, w)
		}
	}

	// The store file: the Go daemon writes the same bytes as TS's writeStore, 0600.
	goHome := t.TempDir()
	goAuth := New(Options{Home: goHome})
	if err := goAuth.write(mustParse(t, storeJSON).(*jsjson.Object)); err != nil {
		t.Fatal(err)
	}
	goFile, err := os.ReadFile(filepath.Join(goHome, "mcp-auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	tsStore, _ := want.Get("store")
	if string(goFile) != tsStore.(string) {
		t.Errorf("store file differs from TS:\n%s\nTS:\n%s", goFile, tsStore)
	}
	if mode, _ := want.Get("storeMode"); mode.(float64) != 0o600 {
		t.Errorf("TS store mode %v", mode)
	}
}

func TestStoreIsMode0600(t *testing.T) {
	f := newFixture(t, "m", "m", `{}`)
	if err := os.WriteFile(f.a.file(), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := f.a.write(jsjson.NewObject()); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(f.a.file())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("store mode %o, want 600", info.Mode().Perm())
	}
}

func TestEndpointRefusesHTTPAndPrivateUnlessInsecure(t *testing.T) {
	a := New(Options{})
	for _, u := range []string{"http://example.com/", "https://127.0.0.1/", "https://10.0.0.5/"} {
		if err := a.assertEndpoint(context.Background(), u); err == nil {
			t.Errorf("assertEndpoint(%q) allowed", u)
		}
	}
	a.opt.Insecure = true
	if err := a.assertEndpoint(context.Background(), "http://127.0.0.1:9/"); err != nil {
		t.Errorf("insecure test endpoint refused: %v", err)
	}
}

// oneServer is settings naming prov at url, with an oauth login.
func oneServer(url string) string {
	return `{"prov":{"url":"` + url + `","auth":{"type":"oauth"}}}`
}

const srvURL = "https://srv.example/mcp"

func TestRefreshNearExpiryReturnsNewToken(t *testing.T) {
	p := newProvider(t, 0, false)
	f := newFixture(t, "m", "m", oneServer(srvURL))
	f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","token_endpoint":"`+p.srv.URL+`/token","access_token":"OLD","refresh_token":"R1","expires_at":1}`)
	got, err := f.a.Token(context.Background(), "prov", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, "NEW-") {
		t.Errorf("token %q, want the refreshed one", got)
	}
	if n := p.calls.Load(); n != 1 {
		t.Errorf("%d refresh calls, want 1", n)
	}
	g, ok := f.a.storedGrant("prov")
	if !ok || g.refreshToken != "R2" || g.accessToken != got {
		t.Errorf("stored grant %+v is not the refreshed one", g)
	}
}

// Concurrent callers share one refresh: the provider sees one call, and every caller gets the one token.
func TestConcurrentRefreshIsSingleFlight(t *testing.T) {
	p := newProvider(t, 0, true)
	f := newFixture(t, "m", "m", oneServer(srvURL))
	f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","token_endpoint":"`+p.srv.URL+`/token","access_token":"OLD","refresh_token":"R1","expires_at":1}`)
	const n = 8
	tokens := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		tokens[0], errs[0] = f.a.Token(context.Background(), "prov", false)
	}()
	<-p.arrived // the first refresh is at the provider and in flight
	for i := 1; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tokens[i], errs[i] = f.a.Token(context.Background(), "prov", false)
		}(i)
	}
	close(p.release)
	wg.Wait()
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("caller %d: %v", i, errs[i])
		}
		if tokens[i] != tokens[0] {
			t.Errorf("caller %d got %q, the first got %q", i, tokens[i], tokens[0])
		}
	}
	if c := p.calls.Load(); c != 1 {
		t.Errorf("%d provider refreshes for %d callers, want 1", c, n)
	}
}

func TestFailedRefreshRefusesWithoutAStaleBearer(t *testing.T) {
	p := newProvider(t, http.StatusBadRequest, false)
	f := newFixture(t, "m", "m", oneServer(srvURL))
	f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","token_endpoint":"`+p.srv.URL+`/token","access_token":"STALE","refresh_token":"R1","expires_at":1}`)
	got, err := f.a.Token(context.Background(), "prov", false)
	if err == nil {
		t.Fatalf("a failed refresh returned %q, want a refusal", got)
	}
	if strings.Contains(err.Error(), "secret detail") || strings.Contains(err.Error(), "STALE") {
		t.Errorf("error leaks the body or the token: %v", err)
	}
	if got != "" {
		t.Errorf("returned %q after a failed refresh", got)
	}
}

func TestRedirectIsAnErrorNotFollowed(t *testing.T) {
	p := newProvider(t, 0, false)
	p.redir = true
	f := newFixture(t, "m", "m", oneServer(srvURL))
	f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","token_endpoint":"`+p.srv.URL+`/token","refresh_token":"R1","expires_at":1}`)
	if _, err := f.a.Token(context.Background(), "prov", false); err == nil || !strings.Contains(err.Error(), "HTTP 302") {
		t.Errorf("a redirect answered %v, want HTTP 302", err)
	}
}

func TestChangedServerURLNeedsALogin(t *testing.T) {
	f := newFixture(t, "m", "m", oneServer("https://new.example/mcp"))
	f.writeGrant("prov", `{"server_url":"https://old.example/mcp","client_id":"c","token_endpoint":"https://x.example/t","access_token":"A","expires_at":9999999999999}`)
	if _, err := f.a.Token(context.Background(), "prov", false); err == nil || !strings.Contains(err.Error(), "the server url changed") {
		t.Errorf("a moved server answered %v", err)
	}
	if _, err := f.a.TokenFor(context.Background(), "prov", false); err == nil {
		t.Error("TokenFor served a grant made for another url")
	}
}

func TestTokenForReturnsBearerAndURL(t *testing.T) {
	f := newFixture(t, "m", "m", oneServer(srvURL))
	f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","token_endpoint":"https://x.example/t","access_token":"LIVE","expires_at":9999999999999}`)
	b, err := f.a.TokenFor(context.Background(), "prov", false)
	if err != nil {
		t.Fatal(err)
	}
	if b.Token != "LIVE" || b.URL != srvURL || b.ExpiresAt == nil {
		t.Errorf("bearer %+v", b)
	}
}

func TestLogoutForgetsTheGrantAndStatusHoldsNoToken(t *testing.T) {
	f := newFixture(t, "m", "m", oneServer(srvURL))
	f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","token_endpoint":"https://x.example/t","access_token":"SECRET-ACCESS","refresh_token":"SECRET-REFRESH","expires_at":9999999999999}`)
	st, err := f.a.Rows(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := jsjson.Stringify(jsjson.NewObject("servers", st.Servers), "")
	if strings.Contains(out, "SECRET") {
		t.Errorf("status holds a token: %s", out)
	}
	if !strings.Contains(out, `"logged_in":true`) {
		t.Errorf("status %s, want logged in", out)
	}
	if err := f.a.Logout("prov"); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.a.storedGrant("prov"); ok {
		t.Error("the grant survived logout")
	}
	st, _ = f.a.Rows(context.Background())
	if out := jsjson.Stringify(jsjson.NewObject("servers", st.Servers), ""); !strings.Contains(out, `"logged_in":false`) {
		t.Errorf("status after logout %s", out)
	}
}

func TestGhServerUsesGhAuthToken(t *testing.T) {
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte("#!/bin/sh\necho GH-TOKEN-1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	f := newFixture(t, "m", "m", `{"gh":{"url":"https://api.example/mcp","auth":{"type":"gh"}}}`)
	if got, err := f.a.Token(context.Background(), "gh", false); err != nil || got != "GH-TOKEN-1" {
		t.Errorf("gh token %q, %v", got, err)
	}
}

// A peer keeps no bearer of its own: its token is refused naming the home, and its status says the home is unreachable
// and shows its old grant only as a local grant, never as logged in.
func TestPeerRefusesTokenAndReportsHomeDown(t *testing.T) {
	f := newFixture(t, "peer", "home", oneServer(srvURL))
	f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","token_endpoint":"https://x.example/t","access_token":"LOCAL-OLD","expires_at":9999999999999}`)
	if _, err := f.a.TokenFor(context.Background(), "prov", false); err == nil || !strings.Contains(err.Error(), "isn't in settings.peers") {
		t.Errorf("a peer's bearer answered %v", err)
	}
	st, err := f.a.Rows(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := jsjson.Stringify(jsjson.NewObject("servers", st.Servers, "home", st.Home), "")
	if strings.Contains(out, "LOCAL-OLD") || strings.Contains(out, `"logged_in":true`) {
		t.Errorf("a peer's status shows a bearer or a login: %s", out)
	}
	if !strings.Contains(out, `"local_grant":true`) || !strings.Contains(out, `"reachable":false`) || !strings.Contains(out, "isn't in settings.peers") {
		t.Errorf("a peer's status %s, want the local grant and the home unreachable", out)
	}
}

// A peer with no grant of its own is refused a logout, naming the home.
func TestPeerLogoutWithoutGrantNamesHome(t *testing.T) {
	f := newFixture(t, "peer", "home", oneServer(srvURL))
	if err := f.a.Logout("prov"); err == nil || !strings.Contains(err.Error(), "log out on home") {
		t.Errorf("a peer's logout answered %v", err)
	}
}

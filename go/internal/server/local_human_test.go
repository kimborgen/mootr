package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"stam/internal/config"
	"stam/internal/jsjson"
	"stam/internal/localhuman"
)

// localFixture is a daemon served on a real loopback listener (the local login reads the client's socket), with the
// code folder a test's and this user standing in for root, as e2e-local-human.sh sets them. sudo is answered "0".
func localFixture(t *testing.T, settings string) (*fixture, *httptest.Server) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "codes")
	f := relayFixture(t, "http://127.0.0.1:1", settings, map[string]string{
		"STAM_TEST_HUMAN_CODE_DIR": dir, "STAM_TEST_HUMAN_CODE_ROOT_UID": strconv.Itoa(os.Getuid()), "STAM_TEST_PASSWORDLESS_SUDO": "0",
	})
	ts := httptest.NewServer(f.srv)
	t.Cleanup(ts.Close)
	f.srv.hosts[strings.TrimPrefix(ts.URL, "http://")] = true
	return f, ts
}

// vouch is the page's command for a fresh secret, run as this user (root's stand-in); it returns the secret.
func vouch(t *testing.T, f *fixture, secret string) string {
	t.Helper()
	dir := f.srv.login.UserDir()
	must(t, os.MkdirAll(dir, 0o755))
	must(t, os.Chmod(filepath.Dir(dir), 0o755))
	must(t, os.Chmod(dir, 0o755))
	p := filepath.Join(dir, localhuman.NameOf(secret))
	must(t, os.WriteFile(p, nil, 0o644))
	must(t, os.Chmod(p, 0o644))
	return secret
}

// send is one request to the real listener; it returns the status and body.
func send(t *testing.T, ts *httptest.Server, method, path, body string, hdr map[string]string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	must(t, err)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	must(t, err)
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func setLocal(t *testing.T, f *fixture, on bool) {
	t.Helper()
	_, err := f.srv.settings.SetSetting("auth", jsjson.NewObject("localHuman", on))
	must(t, err)
}

// TestLocalLoginOff: with auth.localHuman off the login is reported off, names no folder, and spends no code.
func TestLocalLoginOff(t *testing.T) {
	f, ts := localFixture(t, "")
	if code, body := send(t, ts, "GET", "/api/human/login", "", nil); code != 200 || body != `{"enabled":false}` {
		t.Fatalf("GET: %d %s", code, body)
	}
	s := vouch(t, f, "AAAAAAAAAAAAAAAAAAAAAA")
	code, body := send(t, ts, "POST", "/api/human/login", `{"secret":"`+s+`"}`, map[string]string{"Origin": ts.URL, "Content-Type": "application/json"})
	if code != 404 || !strings.Contains(body, "local human login is off (settings auth.localHuman)") {
		t.Fatalf("POST: %d %s", code, body)
	}
}

// TestLocalLogin: with it on, only stam's own page on this machine logs in, once per code; its session is the human
// on a direct connection only, until logout or the setting goes off (seen at once, by a write or a read of a hand edit,
// and ending a login in flight too). Every login and refusal is logged, with no secret or token.
func TestLocalLogin(t *testing.T) {
	log := captureLog(t)
	f, ts := localFixture(t, `"auth":{"localHuman":true}`)
	code, body := send(t, ts, "GET", "/api/human/login", "", nil)
	if code != 200 || body != `{"enabled":true,"dir":"`+f.srv.login.UserDir()+`","passwordlessSudo":false}` {
		t.Fatalf("GET: %d %s", code, body)
	}
	page := map[string]string{"Origin": ts.URL, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin"}
	with := func(k, v string) map[string]string {
		h := map[string]string{}
		for a, b := range page {
			h[a] = b
		}
		if v == "" {
			delete(h, k)
		} else {
			h[k] = v
		}
		return h
	}
	s := vouch(t, f, "BBBBBBBBBBBBBBBBBBBBBB")
	body = `{"secret":"` + s + `"}`
	for _, c := range []struct {
		name   string
		hdr    map[string]string
		body   string
		status int
		msg    string
	}{
		{"no Origin", with("Origin", ""), body, 403, "log in from stam's own page"},
		{"another port", with("Origin", "http://127.0.0.1:1"), body, 403, "log in from stam's own page"},
		{"another site", with("Origin", "https://evil.example"), body, 403, "log in from stam's own page"},
		{"same-site, not same-origin", with("Sec-Fetch-Site", "same-site"), body, 403, "log in from stam's own page"},
		{"a peer's relay", with("X-Stam-Local", "1"), body, 403, "log in from a browser on this machine, at http://127.0.0.1:" + strconv.Itoa(f.cfg.Port) + "/"},
		{"not JSON", with("Content-Type", "text/plain"), body, 415, "the request must be JSON"},
		{"the name alone", page, `{"secret":"` + localhuman.NameOf(s) + `"}`, 403, "not a login secret"},
		{"a made-up secret", page, `{"secret":"CCCCCCCCCCCCCCCCCCCCCC"}`, 403, "no such code yet: run the command above first"},
	} {
		code, got := send(t, ts, "POST", "/api/human/login", c.body, c.hdr)
		if code != c.status || !strings.Contains(got, `"error":`+strconv.Quote(c.msg)) {
			t.Errorf("%s: %d %s", c.name, code, got)
		}
	}
	// A request that isn't a direct connection (no socket of its own) is refused too.
	if rec := f.do(call{method: "POST", path: "/api/human/login", header: page, body: body}); rec.Code != 403 {
		t.Errorf("not direct: %d %s", rec.Code, rec.Body)
	}
	code, got := send(t, ts, "POST", "/api/human/login", body, page)
	var sess struct {
		Token   string
		Expires int64
	}
	if code != 200 || json.Unmarshal([]byte(got), &sess) != nil || sess.Token == "" || sess.Expires == 0 {
		t.Fatalf("login: %d %s", code, got)
	}
	if code, got := send(t, ts, "POST", "/api/human/login", body, page); code != 403 || !strings.Contains(got, "already used") {
		t.Errorf("reuse: %d %s", code, got)
	}

	// The session is the human, on a direct connection only.
	bearer := func(extra ...string) map[string]string {
		h := map[string]string{"Authorization": "Bearer " + sess.Token}
		for i := 0; i+1 < len(extra); i += 2 {
			h[extra[i]] = extra[i+1]
		}
		return h
	}
	if code, got := send(t, ts, "GET", "/api/voice", "", bearer()); code != 200 || got != `{"configured":false}` {
		t.Errorf("a session's humanOnly: %d %s", code, got)
	}
	if code, _ := send(t, ts, "GET", "/api/voice", "", bearer("X-Stam-Local", "1")); code != 401 {
		t.Errorf("a session as a peer's relay: %d", code)
	}
	if rec := f.do(call{path: "/api/voice", header: bearer()}); rec.Code != 401 {
		t.Errorf("a session not on a direct connection: %d", rec.Code)
	}
	if code, got := send(t, ts, "GET", "/api/voice", "", map[string]string{"Authorization": "Bearer " + sharedTok, "X-Stam-Human": "1"}); code != 403 ||
		!strings.Contains(got, "through stam's login page at http://127.0.0.1:"+strconv.Itoa(f.cfg.Port)+"/") {
		t.Errorf("the shared token's humanOnly: %d %s", code, got)
	}

	// Logout ends it; a second login works; the setting off ends every session, with no request in between, and on
	// again doesn't bring one back.
	if code, got := send(t, ts, "POST", "/api/human/logout", "{}", with("Authorization", "Bearer "+sess.Token)); code != 200 || got != `{"ended":true}` {
		t.Fatalf("logout: %d %s", code, got)
	}
	if code, _ := send(t, ts, "GET", "/api/voice", "", bearer()); code != 401 {
		t.Errorf("after logout: %d", code)
	}
	login := func(secret string) {
		t.Helper()
		_, got := send(t, ts, "POST", "/api/human/login", `{"secret":"`+vouch(t, f, secret)+`"}`, page)
		must(t, json.Unmarshal([]byte(got), &sess))
		if code, _ := send(t, ts, "GET", "/api/voice", "", bearer()); code != 200 {
			t.Fatalf("a new session: %d", code)
		}
	}
	// Off through the daemon, then on again by hand, with nothing reading the settings in between.
	login("DDDDDDDDDDDDDDDDDDDDDD")
	file := filepath.Join(f.home, "settings.json")
	on, err := os.ReadFile(file)
	must(t, err)
	setLocal(t, f, false)
	must(t, os.WriteFile(file, on, 0o600))
	if code, _ := send(t, ts, "GET", "/api/voice", "", bearer()); code != 401 {
		t.Errorf("a session came back with the setting: %d", code)
	}
	// A hand edit off and on again, with only a read of the settings (any of the daemon's) in between.
	login("EEEEEEEEEEEEEEEEEEEEEE")
	off := strings.NewReplacer(`"localHuman": true`, `"localHuman": false`, `"localHuman":true`, `"localHuman":false`).Replace(string(on))
	must(t, os.WriteFile(file, []byte(off), 0o600))
	if f.srv.settings.Get().Auth.LocalHuman {
		t.Fatalf("the hand edit wasn't read:\n%s", on)
	}
	must(t, os.WriteFile(file, on, 0o600))
	if code, _ := send(t, ts, "GET", "/api/voice", "", bearer()); code != 401 {
		t.Errorf("a session came back after a hand edit: %d", code)
	}
	// The setting goes off between a login's code check and its session's start: no session starts.
	t.Cleanup(func() { afterRedeem = func() {} })
	afterRedeem = func() { setLocal(t, f, false) }
	code, got = send(t, ts, "POST", "/api/human/login", `{"secret":"`+vouch(t, f, "FFFFFFFFFFFFFFFFFFFFFF")+`"}`, page)
	afterRedeem = func() {}
	if code != 404 || strings.Contains(got, "token") {
		t.Errorf("a login the setting ended mid-way: %d %s", code, got)
	}

	out := log.String()
	for _, want := range []string{"local human login: a session started", "local human login refused: that login was already used", "local human login refused: log in from stam's own page",
		"local human login refused: local login went off during it"} {
		if !strings.Contains(out, want) {
			t.Errorf("no line %q", want)
		}
	}
	for _, secret := range []string{s, sess.Token} {
		if strings.Contains(out, secret) {
			t.Error("a secret or token was logged")
		}
	}
}

// TestLocalLoginOffer: a refused request claiming the human, directly from this machine with local login on, says a
// local login is there (localLogin); not without the claim, with the setting off, or for the human.
func TestLocalLoginOffer(t *testing.T) {
	f, ts := localFixture(t, `"auth":{"localHuman":true,"humanStrict":true}`)
	claim := map[string]string{"Authorization": "Bearer " + sharedTok, "X-Stam-Human": "1"}
	offer := func(hdr map[string]string) (int, bool) {
		code, body := send(t, ts, "GET", "/api/voice", "", hdr)
		var e struct{ LocalLogin bool }
		_ = json.Unmarshal([]byte(body), &e)
		return code, e.LocalLogin
	}
	if code, ok := offer(claim); code != 403 || !ok {
		t.Errorf("a token link's refusal: %d, offered %v", code, ok)
	}
	if _, ok := offer(map[string]string{"Authorization": "Bearer " + sharedTok}); ok {
		t.Error("offered without the claim")
	}
	setLocal(t, f, false)
	if _, ok := offer(claim); ok {
		t.Error("offered with local login off")
	}
}

// TestHumanWays: a refusal names only the ways this machine has: the login page, its served page only where the test
// key stands in for serve's proof, or with neither how to turn local login on.
func TestHumanWays(t *testing.T) {
	f := relayFixture(t, "http://127.0.0.1:1", "", nil)
	if got := f.srv.humanWays("stam"); got != "through stam's login page, once local login is on (auth.localHuman in settings.json)" {
		t.Errorf("neither: %q", got)
	}
	f.srv.setWebOrigin("https://pinned.example.com", true)
	if got := f.srv.humanWays("here"); got != "through here's page at https://pinned.example.com (tailscale serve)" {
		t.Errorf("served: %q", got)
	}
	setLocal(t, f, true)
	port := strconv.Itoa(f.cfg.Port)
	if got := f.srv.humanWays("stam"); got != "through stam's page at https://pinned.example.com (tailscale serve) or through stam's login page at http://127.0.0.1:"+port+"/" {
		t.Errorf("both: %q", got)
	}
	f.srv.setWebOrigin("", false)
	if got := f.srv.humanWays("stam"); got != "through stam's login page at http://127.0.0.1:"+port+"/" {
		t.Errorf("login only: %q", got)
	}
	// With no test key the Go daemon has no proof through serve, so a served page isn't a way.
	f.srv.setWebOrigin("https://pinned.example.com", true)
	f.srv.cfg.TestHumanKey = ""
	if got := f.srv.humanWays("stam"); got != "through stam's login page at http://127.0.0.1:"+port+"/" {
		t.Errorf("served, no test key: %q", got)
	}
}

// TestLocalLoginReloadOrder: a read that saw local login go off, held before its hooks end the sessions, holds back a
// later read that sees it on again: an old session's request waits for that read and is then refused, never let in
// between.
func TestLocalLoginReloadOrder(t *testing.T) {
	f, ts := localFixture(t, `"auth":{"localHuman":true}`)
	page := map[string]string{"Origin": ts.URL, "Content-Type": "application/json"}
	_, got := send(t, ts, "POST", "/api/human/login", `{"secret":"`+vouch(t, f, "GGGGGGGGGGGGGGGGGGGGGG")+`"}`, page)
	var sess struct{ Token string }
	must(t, json.Unmarshal([]byte(got), &sess))
	bearer := map[string]string{"Authorization": "Bearer " + sess.Token}
	if code, _ := send(t, ts, "GET", "/api/voice", "", bearer); code != 200 {
		t.Fatalf("the session: %d (login: %s)", code, got)
	}
	file := filepath.Join(f.home, "settings.json")
	on, err := os.ReadFile(file)
	must(t, err)
	off := strings.NewReplacer(`"localHuman": true`, `"localHuman": false`, `"localHuman":true`, `"localHuman":false`).Replace(string(on))

	// Reader A reads the off file and is held before its hooks.
	held, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { config.ReloadPause = nil })
	config.ReloadPause = func() {
		once.Do(func() {
			close(held)
			<-release
		})
	}
	must(t, os.WriteFile(file, []byte(off), 0o600))
	aDone := make(chan struct{})
	go func() {
		defer close(aDone)
		f.srv.settings.Get()
	}()
	<-held
	// On again by hand; the old session's request reads it, after A.
	must(t, os.WriteFile(file, on, 0o600))
	code := make(chan int, 1)
	go func() {
		c, _ := send(t, ts, "GET", "/api/voice", "", bearer)
		code <- c
	}()
	close(release)
	<-aDone
	if c := <-code; c != 401 {
		t.Errorf("the old session's request: %d, want 401", c)
	}
}

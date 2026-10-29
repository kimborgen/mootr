package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/clock"
)

// The peer far's UI is at its daemon url in these tests.
const farURL = "http://far:7878"

// uiHdr is a request from far's page: the Origin, then the headers given in pairs.
func uiHdr(origin string, kv ...string) map[string]string {
	h := map[string]string{"Origin": origin}
	for i := 0; i+1 < len(kv); i += 2 {
		h[kv[i]] = kv[i+1]
	}
	return h
}

// preflightOf is a CORS preflight from origin asking for method on path.
func preflightOf(f *fixture, origin, method, path string, kv ...string) (int, string) {
	f.t.Helper()
	rec := f.do(call{method: "OPTIONS", path: path, header: uiHdr(origin, append([]string{"Access-Control-Request-Method", method}, kv...)...)})
	return rec.Code, rec.Header().Get("Access-Control-Allow-Origin")
}

// TestPeerUIPreflight: a preflight is answered only from a configured peer's UI origin, only for the writes a peer's UI
// may make (the shared ones only on the settings home); anything else is an empty 403 with no CORS headers.
func TestPeerUIPreflight(t *testing.T) {
	f := relayFixture(t, farURL, "", nil)
	rec := f.do(call{method: "OPTIONS", path: "/api/config/settings", header: uiHdr(farURL, "Access-Control-Request-Method", "PATCH", "Access-Control-Request-Private-Network", "true")})
	h := rec.Header()
	if rec.Code != 204 || h.Get("Access-Control-Allow-Origin") != farURL || h.Get("Access-Control-Allow-Methods") != "PATCH" ||
		h.Get("Access-Control-Allow-Headers") != "content-type, x-stam-human, x-stam-test-human" || h.Get("Access-Control-Max-Age") != "600" ||
		h.Get("Access-Control-Allow-Private-Network") != "true" || h.Get("Vary") != "origin" {
		t.Fatalf("PATCH settings: %d %v", rec.Code, h)
	}
	for _, c := range []struct {
		name, origin, method, path string
		want                       int
	}{
		{"a type save", farURL, "POST", "/api/types/x", 204},
		{"a type removal", farURL, "DELETE", "/api/types/x", 204},
		{"the instructions", farURL, "POST", "/api/config/instructions", 204},
		{"a type's template", farURL, "POST", "/api/templates/type-x", 204},
		{"a permission answer", farURL, "POST", "/api/permissions/p1/answer", 204},
		{"an ITSA act", farURL, "POST", "/api/itsas/S-1/act", 204},
		{"an ITSA patch", farURL, "PATCH", "/api/itsas/S-1", 204},
		{"an agent kill", farURL, "POST", "/api/agents/a1/kill", 204},
		{"the raw registry", farURL, "POST", "/api/config/registry", 403},
		{"a spawn", farURL, "POST", "/api/agents", 403},
		{"a shell", farURL, "POST", "/api/shells", 403},
		{"mail", farURL, "POST", "/api/mail", 403},
		{"a kill as DELETE", farURL, "DELETE", "/api/agents/a1/kill", 403},
		{"no method asked", farURL, "", "/api/config/settings", 403},
		{"another site", "https://evil.example", "PATCH", "/api/config/settings", 403},
		{"another port of far", "http://far:1", "PATCH", "/api/config/settings", 403},
		{"its own page", "http://127.0.0.1:7999", "PATCH", "/api/config/settings", 403},
	} {
		code, acao := preflightOf(f, c.origin, c.method, c.path)
		if code != c.want || (c.want == 403) != (acao == "") {
			t.Errorf("%s: %d, allow-origin %q", c.name, code, acao)
		}
	}

	// Not the settings home: only the human's writes.
	g := relayFixture(t, farURL, `"home":"far"`, nil)
	if code, _ := preflightOf(g, farURL, "PATCH", "/api/config/settings"); code != 403 {
		t.Errorf("a non-home answered a shared write's preflight: %d", code)
	}
	if code, _ := preflightOf(g, farURL, "POST", "/api/agents/a1/kill"); code != 204 {
		t.Errorf("a non-home refused a human write's preflight: %d", code)
	}

	// A peer whose url names this daemon's own page: that page is this daemon's, never a peer's UI.
	own := relayFixture(t, "http://127.0.0.1:7999", "", nil)
	if code, acao := preflightOf(own, "http://127.0.0.1:7999", "PATCH", "/api/config/settings"); code != 403 || acao != "" {
		t.Errorf("its own page as a peer's: %d, allow-origin %q", code, acao)
	}
}

// TestPeerUIOrigins: a peer's UI origins are its url's own, that port on each of its tailnet names, and HTTPS on its
// full tailnet name; only this tailnet's nodes count.
func TestPeerUIOrigins(t *testing.T) {
	status := `{"Self":{"DNSName":"here.tail1.example."},"Peer":{
		"k1":{"DNSName":"far.tail1.example.","TailscaleIPs":["192.0.2.2","fd7a::2"]},
		"k2":{"DNSName":"near.other.example.","TailscaleIPs":["192.0.2.9"]}}}`
	list := parseTailnet([]byte(status))
	if len(list) != 1 || list[0].DNSName != "far.tail1.example." {
		t.Fatalf("nodes %v", list)
	}
	f := relayFixture(t, "http://192.0.2.2:7878", "", nil)
	f.srv.tailnet.list, f.srv.tailnet.at = list, time.Now()
	got := f.srv.peerUIOrigins(context.Background())
	var keys []string
	for o := range got {
		keys = append(keys, o)
	}
	slices.Sort(keys)
	want := []string{"http://192.0.2.2:7878", "http://[fd7a::2]:7878", "http://far.tail1.example:7878", "http://far:7878", "https://far.tail1.example"}
	if !slices.Equal(keys, want) {
		t.Errorf("origins %v\nwant %v", keys, want)
	}
	if o := f.srv.peerServeOrigin("http://192.0.2.2:7878"); o == nil || *o != "https://far.tail1.example" {
		t.Errorf("serve origin %v", o)
	}
	// A node of another tailnet is no peer's name: its address is the url's own origin only.
	if names := tailnetNames("near", list); names != nil {
		t.Errorf("another tailnet's node: %v", names)
	}
	if code, _ := preflightOf(f, "https://far.tail1.example", "POST", "/api/agents/a1/kill"); code != 204 {
		t.Errorf("far's served page: %d", code)
	}
}

// TestTailnetExpiry: a tailnet name is a peer's UI origin only by a list under a minute old. A request that finds the
// list older waits for a read, as TS's synchronous one, which every request meanwhile shares; a failed or timed-out
// read, or a request that ends first, names no one. A peer the tailnet drops loses its name at the next read. The
// peer's own url origin stays throughout.
func TestTailnetExpiry(t *testing.T) {
	var mu sync.Mutex
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	feed, waiting := make(chan []byte), make(chan struct{}, 16)
	var reads atomic.Int32
	oldNow, oldStatus, oldWaiting, oldTimeout := clock.Now, tailscaleStatus, tailnetWaiting, tailnetTimeout
	t.Cleanup(func() { clock.Now, tailscaleStatus, tailnetWaiting, tailnetTimeout = oldNow, oldStatus, oldWaiting, oldTimeout })
	clock.Now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	tailscaleStatus = func(ctx context.Context) []byte {
		reads.Add(1)
		select {
		case b := <-feed:
			return b
		case <-ctx.Done():
			return nil
		}
	}
	tailnetWaiting = func() { waiting <- struct{}{} }
	later := func() {
		mu.Lock()
		now = now.Add(time.Minute + time.Second)
		mu.Unlock()
	}
	awaitWaiters := func(n int) {
		t.Helper()
		for range n {
			select {
			case <-waiting:
			case <-time.After(10 * time.Second):
				t.Fatal("no request waited on a read of the tailnet")
			}
		}
	}
	give := func(b []byte) {
		t.Helper()
		select {
		case feed <- b:
		case <-time.After(10 * time.Second):
			t.Fatal("no read of the tailnet ran")
		}
	}

	f, ts, tc := termFixture(t, "")
	shellSession(t, tc, "sh-t1")
	// The fixture's peer far is at http://127.0.0.1:1; its tailnet name is an alias only tailscale gives.
	status := func(peers string) []byte {
		return []byte(`{"Self":{"DNSName":"here.tail1.example."},"Peer":{` + peers + `}}`)
	}
	far := status(`"k1":{"DNSName":"far.tail1.example.","TailscaleIPs":["127.0.0.1"]}`)
	alias := "http://far.tail1.example:1"
	opens := func(origin string) bool {
		got, _ := upgrades(t, ts, "/api/shells/sh-t1/tty", map[string]string{"X-Stam-Test-Human": humanKey, "Origin": origin})
		return got
	}
	allowed := func(origin string) bool {
		_, acao := preflightOf(f, origin, "POST", "/api/agents/a1/kill")
		return acao == origin
	}
	// during runs check in the background, answers the read it waits on with b, and returns check's answer.
	during := func(b []byte, check func(string) bool, origin string) bool {
		t.Helper()
		out := make(chan bool, 1)
		go func() { out <- check(origin) }()
		awaitWaiters(1)
		give(b)
		select {
		case ok := <-out:
			return ok
		case <-time.After(10 * time.Second):
			t.Fatal("a request never came back from its wait")
			return false
		}
	}

	// No list yet: the first request waits for the read and takes its name.
	if !during(far, allowed, alias) || !opens(alias) {
		t.Fatal("a fresh list's name isn't far's UI origin")
	}

	// Expired: the request waits for the new list and passes on it, a terminal socket as a write.
	later()
	if !during(far, opens, alias) || !allowed(alias) {
		t.Error("the name read again on an expired list isn't far's UI origin")
	}

	// A failed read names no one; far's own url still passes, with no wait.
	later()
	if during(nil, allowed, alias) || opens(alias) {
		t.Error("a failed read kept the names")
	}
	if !allowed("http://127.0.0.1:1") {
		t.Error("far's own url origin went with the names")
	}

	// A read that times out names no one.
	later()
	tailnetTimeout = time.Millisecond
	ok := allowed(alias)
	awaitWaiters(1)
	tailnetTimeout = oldTimeout
	if ok {
		t.Error("a timed-out read kept the names")
	}

	// Two requests on an expired list share one read.
	later()
	reads.Store(0)
	outs := make(chan bool, 2)
	for range 2 {
		go func() { outs <- allowed(alias) }()
	}
	awaitWaiters(2)
	give(far)
	for range 2 {
		select {
		case ok := <-outs:
			if !ok {
				t.Error("a request sharing the read was refused")
			}
		case <-time.After(10 * time.Second):
			t.Fatal("a request sharing the read never came back")
		}
	}
	if n := reads.Load(); n != 1 {
		t.Errorf("two waiting requests made %d reads", n)
	}

	// A request whose context ends first gets no names; the read it started still lands for the next one.
	later()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if names := f.srv.tailnetNodes(ctx); names != nil {
		t.Errorf("an ended request got %v", names)
	}
	awaitWaiters(1)
	give(far)
	if !opens(alias) {
		t.Error("the read an ended request started didn't land")
	}

	// A peer the tailnet no longer has loses its name at the next read.
	later()
	if during(status(`"k2":{"DNSName":"other.tail1.example.","TailscaleIPs":["192.0.2.9"]}`), allowed, alias) {
		t.Error("a removed peer's name stayed")
	}
}

// TestPeerUIWrites: a write from a peer's page carries the CORS header and passes the human's checks as from this
// daemon's own page, and must be JSON; without the human's proof, or from another site, it is refused. On the settings
// home it changes only shared keys, never MCP servers.
func TestPeerUIWrites(t *testing.T) {
	f := relayFixture(t, farURL, `"humanMail":{"when":"necessary"},"itsa":{"repos":{"own":"/home-repo"}}`, nil)
	human := func(kv ...string) map[string]string {
		return uiHdr(farURL, append([]string{"X-Stam-Test-Human", humanKey, "X-Stam-Human", "1", "Content-Type", "application/json"}, kv...)...)
	}
	patch := `{"patch":{"humanMail":{"when":"often"},"itsa":{"home":"far","repos":{},"wip":4},"peers":[]}}`
	rec := f.do(call{method: "PATCH", path: "/api/config/settings", header: human(), body: patch})
	if rec.Code != 200 || rec.Header().Get("Access-Control-Allow-Origin") != farURL || rec.Header().Get("Vary") != "origin, accept-encoding" {
		t.Fatalf("PATCH: %d %s %v", rec.Code, rec.Body, rec.Header())
	}
	b, err := os.ReadFile(filepath.Join(f.home, "settings.json"))
	must(t, err)
	var file struct {
		HumanMail struct{ When string }
		Itsa      map[string]any
		Peers     []map[string]any
	}
	must(t, json.Unmarshal(b, &file))
	if repos, _ := json.Marshal(file.Itsa["repos"]); file.HumanMail.When != "often" || file.Itsa["wip"] != 4.0 || string(repos) != `{"own":"/home-repo"}` ||
		file.Itsa["home"] != nil || len(file.Peers) != 1 {
		t.Errorf("the home's settings:\n%s", b)
	}
	var answer struct{ Text string }
	must(t, json.Unmarshal(rec.Body.Bytes(), &answer))
	if strings.Contains(answer.Text, `"peers"`) || !strings.Contains(answer.Text, `"often"`) {
		t.Errorf("the answer shows local keys or lacks the change:\n%s", answer.Text)
	}

	before := string(b)
	for _, c := range []struct {
		name   string
		path   string
		hdr    map[string]string
		body   string
		status int
		msg    string
	}{
		{"MCP servers", "/api/config/settings", human(), `{"patch":{"mcpServers":{"x":{"command":"true"}}}}`, 403, "MCP servers change only on here's own page"},
		{"not JSON", "/api/config/settings", human("Content-Type", "text/plain"), patch, 415, "a write from a peer must be JSON"},
		{"no x-stam-human", "/api/config/settings", uiHdr(farURL, "X-Stam-Test-Human", humanKey, "Content-Type", "application/json"), patch, 403, "a write needs the x-stam-human header"},
		{"no proof", "/api/config/settings", uiHdr(farURL, "X-Stam-Human", "1", "Content-Type", "application/json"), patch, 403, "only the human can change shared settings, through here's page (tailscale serve)"},
		{"no proof, a human write", "/api/agents/achild/set-child-notices", uiHdr(farURL, "X-Stam-Human", "1", "Content-Type", "application/json"), `{"child_notices":"none"}`, 403, "only the human can do this, through here's page (tailscale serve)"},
		{"another site", "/api/config/settings", uiHdr("https://evil.example", "X-Stam-Test-Human", humanKey, "X-Stam-Human", "1", "Content-Type", "application/json"), patch, 403, "a request from another site needs a token"},
		{"a raw registry write", "/api/config/registry", human(), `{"text":"{}"}`, 403, "a request from another site needs a token"},
	} {
		method := "PATCH"
		if c.path != "/api/config/settings" {
			method = "POST"
		}
		rec := f.do(call{method: method, path: c.path, header: c.hdr, body: c.body})
		if rec.Code != c.status || envelope(t, rec)["error"] != c.msg {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(f.home, "settings.json")); string(b) != before {
		t.Errorf("a refused write changed the settings:\n%s", b)
	}

	// The human's write for an agent here, from far's page, passes the checks (this fixture has no lifecycle to run it).
	rec = f.do(call{method: "POST", path: "/api/agents/achild/set-child-notices", header: human(), body: `{"child_notices":"none"}`})
	if rec.Code == 401 || rec.Code == 403 || rec.Code == 415 || rec.Header().Get("Access-Control-Allow-Origin") != farURL {
		t.Errorf("a control from far's page: %d %s", rec.Code, rec.Body)
	}
	// A read from far's page is no peer UI request: no CORS, and refused as from another site.
	rec = f.do(call{path: "/api/agents", header: uiHdr(farURL, "X-Stam-Test-Human", humanKey)})
	if rec.Code != 403 || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("a GET from far's page: %d %v", rec.Code, rec.Header())
	}

	// A mixed key holding only local paths changes nothing shared: the home gets no itsa from it.
	g := relayFixture(t, farURL, `"humanMail":{"when":"necessary"}`, nil)
	rec = g.do(call{method: "PATCH", path: "/api/config/settings", header: human(), body: `{"patch":{"itsa":{"repos":{"x":"/x"}}}}`})
	b, err = os.ReadFile(filepath.Join(g.home, "settings.json"))
	must(t, err)
	if rec.Code != 200 || strings.Contains(string(b), `"itsa"`) {
		t.Errorf("a local-only itsa patch: %d %s\n%s", rec.Code, rec.Body, b)
	}
}

// TestOwnHost: a serve found after boot names this daemon too, so the human's page there is let in without a restart;
// its origin is this daemon's own page.
func TestOwnHost(t *testing.T) {
	f := relayFixture(t, farURL, "", nil)
	served := call{path: "/api/agents", host: "solo.example.com", header: map[string]string{"X-Stam-Test-Human": humanKey}}
	if rec := f.do(served); rec.Code != 403 {
		t.Fatalf("an unknown host: %d", rec.Code)
	}
	f.srv.setWebOrigin("https://solo.example.com", true)
	if rec := f.do(served); rec.Code != 200 {
		t.Errorf("the served host: %d %s", rec.Code, rec.Body)
	}
	if !f.srv.sameOrigin("https://solo.example.com") || f.srv.sameOrigin("https://other.example.com") {
		t.Error("sameOrigin of the served origin")
	}
}

// TestSharedSettingsWeb: the home's shared settings name its web origin only when a serve gives one, in a changed
// answer and an unchanged one.
func TestSharedSettingsWeb(t *testing.T) {
	f := relayFixture(t, farURL, "", nil)
	peer := map[string]string{"X-Stam-Local": "1"}
	get := func(q string) map[string]any {
		rec := f.do(call{path: "/api/config/settings/shared" + q, token: peerTok, header: peer})
		var out map[string]any
		if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &out) != nil {
			t.Fatalf("GET%s: %d %s", q, rec.Code, rec.Body)
		}
		return out
	}
	if _, ok := get("")["web"]; ok {
		t.Error("a web origin with no serve")
	}
	f.srv.setWebOrigin("https://home.example.com", true)
	full := get("")
	if full["web"] != "https://home.example.com" {
		t.Errorf("changed: %v", full["web"])
	}
	if same := get("?rev=" + full["rev"].(string)); same["unchanged"] != true || same["web"] != "https://home.example.com" {
		t.Errorf("unchanged: %v", same)
	}
}

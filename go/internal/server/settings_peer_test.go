package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"stam/internal/jsjson"
)

// peerOwn is a non-home daemon's own settings.json: its home, peers and repos.
const peerOwn = `{"home":"test-machine","peers":[{"name":"test-machine","url":"http://home.invalid","token":"PEER-SECRET"}],"itsa":{"repos":{"p":"/p"}}}` + "\n"

// peerCache is the home's shared part as that daemon's cache holds it.
const peerCache = `{"rev":"r1","settings":{"chiefOfStaff":"achild","mail":{"titles":{"model":"m1"}},"itsa":{"keyPrefix":"H"},"debug":{},"boardViews":{"v1":{"name":"one"}},"mcpServers":{"s":{"command":"c","env":{"K":"ENV-SECRET"}}}}}` + "\n"

// peerFixture is a daemon on peer-m whose settings live on test-machine, with the home's shared part in its cache.
func peerFixture(t *testing.T) (*fixture, string) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey, "STAM_MACHINE": "peer-m"})
	path := filepath.Join(f.home, "settings.json")
	must(t, os.WriteFile(path, []byte(peerOwn), 0o600))
	must(t, os.WriteFile(filepath.Join(f.home, "settings.shared.json"), []byte(peerCache), 0o600))
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id = 'achild'")
	return f, path
}

// refusedForHome is whether a response is the 409 naming the home.
func refusedForHome(t *testing.T, rec *httptest.ResponseRecorder) bool {
	t.Helper()
	var out struct {
		Error, Home string
		Shared      []string
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code == 409 && out.Home == "test-machine" && strings.Contains(out.Error, "live on test-machine")
}

// TestSettingsOnAPeer: a non-home daemon shows the merged settings and writes only its local keys; a change to a shared
// key, a mixed one, and a fill that adds a view id the home lacks are 409s naming the home, and write nothing.
func TestSettingsOnAPeer(t *testing.T) {
	f, path := peerFixture(t)
	human := func(method, body string) *httptest.ResponseRecorder {
		return f.do(call{method: method, path: "/api/config/settings", token: sharedTok, header: trusted, body: body})
	}
	rec := f.do(call{path: "/api/config/settings", token: sharedTok})
	var got struct {
		Text, Home string
		Stale      bool
		Local      []string
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &got))
	if rec.Code != 200 || got.Home != "test-machine" || !got.Stale || !strings.Contains(got.Text, `"model": "m1"`) || !strings.Contains(got.Text, `"p": "/p"`) {
		t.Fatalf("GET on a peer: %d %s", rec.Code, rec.Body)
	}
	for _, body := range []string{
		`{"patch":{"mail":{"titles":{"model":"m2"}}}}`,
		`{"patch":{"itsa":{"keyPrefix":"P","repos":{"p3":"/p3"}}}}`,
		`{"patch":{"boardViews":{"v2":{"name":"two"}}},"fill":true}`,
	} {
		if rec := human("PATCH", body); !refusedForHome(t, rec) {
			t.Errorf("PATCH %s: %d %s", body, rec.Code, rec.Body)
		}
	}
	if readFile(t, path) != peerOwn {
		t.Fatalf("a refused change wrote the file: %s", readFile(t, path))
	}
	if rec := human("PATCH", `{"patch":{"boardViews":{"v1":{"name":"copy"}},"mail":{"x":1}},"fill":true}`); rec.Code != 200 || readFile(t, path) != peerOwn {
		t.Errorf("a fill that adds nothing: %d %s", rec.Code, rec.Body)
	}
	rec = human("PATCH", `{"patch":{"debug":{"stallMs":250},"itsa":{"repos":{"p2":"/p2"}}}}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `\"model\": \"m1\"`) {
		t.Fatalf("a local patch: %d %s", rec.Code, rec.Body)
	}
	if after := readFile(t, path); !strings.Contains(after, `"stallMs": 250`) || !strings.Contains(after, `"p2": "/p2"`) || strings.Contains(after, `"p": "/p"`) || strings.Contains(after, "keyPrefix") {
		t.Errorf("the local patch's file: %s", after)
	}
	if s := f.srv.settings.Get(); s.Itsa.KeyPrefix != "H" || s.Itsa.Repos["p2"] != "/p2" {
		t.Errorf("the merged settings: %+v", s.Itsa)
	}
	// localOnly: the page sent the shared part to the home, so it isn't a refusal here.
	if rec := human("PATCH", `{"patch":{"debug":{"stallMs":260},"mail":{"titles":{"model":"m9"}}},"localOnly":true}`); rec.Code != 200 || !strings.Contains(readFile(t, path), `"stallMs": 260`) || strings.Contains(readFile(t, path), "m9") {
		t.Errorf("a localOnly patch: %d %s", rec.Code, rec.Body)
	}
	// The merged text posted back with a local edit is local; with a shared edit it is refused.
	rec = f.do(call{path: "/api/config/settings", token: sharedTok})
	must(t, json.Unmarshal(rec.Body.Bytes(), &got))
	local := strings.Replace(got.Text, `"stallMs": 260`, `"stallMs": 300`, 1)
	if rec := human("POST", `{"text":`+jsonString(local)+`}`); rec.Code != 200 || !strings.Contains(readFile(t, path), `"stallMs": 300`) {
		t.Errorf("a POST with a local edit: %d %s", rec.Code, rec.Body)
	}
	before := readFile(t, path)
	shared := strings.Replace(local, `"model": "m1"`, `"model": "m4"`, 1)
	if rec := human("POST", `{"text":`+jsonString(shared)+`}`); !refusedForHome(t, rec) || readFile(t, path) != before {
		t.Errorf("a POST with a shared edit: %d %s", rec.Code, rec.Body)
	}
	if rec := human("POST", `{"text":"[1]"}`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "must be a JSON object") {
		t.Errorf("a POST of an array: %d %s", rec.Code, rec.Body)
	}
}

// TestSettingsAskOnAPeer: the chief of staff's ask about a shared key on a peer is a 409 and makes no request; its ask
// about a local key shows only that change and the approval writes it there; its POST of its own redacted GET with a
// local edit is an ask whose approval keeps every secret.
func TestSettingsAskOnAPeer(t *testing.T) {
	f, path := peerFixture(t)
	asAgent := func(method, body string) *httptest.ResponseRecorder {
		return f.do(call{method: method, path: "/api/config/settings", token: agentTok, body: body})
	}
	if rec := asAgent("PATCH", `{"patch":{"mail":{"titles":{"model":"m3"}}}}`); !refusedForHome(t, rec) {
		t.Errorf("a shared ask: %d %s", rec.Code, rec.Body)
	}
	id := ask(t, f, "PATCH", `{"patch":{"debug":{"stallMs":350},"itsa":{"repos":{"ask":"/ask"}}}}`)
	r, _, err := f.db.PermissionRequestByID(context.Background(), id)
	must(t, err)
	if !strings.Contains(r.Details, `+    "stallMs": 350`) || !strings.Contains(r.Details, `"ask": "/ask"`) || strings.Contains(r.Details, "SECRET") {
		t.Errorf("the ask's diff: %s", r.Details)
	}
	for _, l := range strings.Split(r.Details, "\n") {
		if strings.HasPrefix(l, "-") && strings.Contains(l, "keyPrefix") {
			t.Errorf("the diff removes a shared key: %s", r.Details)
		}
	}
	if readFile(t, path) != peerOwn {
		t.Fatalf("an ask wrote the file")
	}
	if out := answer(t, f, id, true); out["status"] != "approved" {
		t.Fatalf("the approval: %v", out)
	}
	after := readFile(t, path)
	if !strings.Contains(after, `"stallMs": 350`) || !strings.Contains(after, `"ask": "/ask"`) || strings.Contains(after, "keyPrefix") || !strings.Contains(after, "PEER-SECRET") {
		t.Errorf("the approved local change: %s", after)
	}
	// The redacted GET round trip.
	rec := asAgent("GET", "")
	var got struct{ Text string }
	must(t, json.Unmarshal(rec.Body.Bytes(), &got))
	if strings.Contains(got.Text, "SECRET") {
		t.Fatalf("the chief of staff read a secret: %s", got.Text)
	}
	edited := strings.Replace(got.Text, `"ask": "/ask"`, `"cos": "/cos"`, 1)
	if rec := asAgent("POST", `{"text":`+jsonString(strings.Replace(edited, `"model": "m1"`, `"model": "m9"`, 1))+`}`); !refusedForHome(t, rec) {
		t.Errorf("a redacted POST with a shared edit: %d %s", rec.Code, rec.Body)
	}
	if rec := asAgent("POST", `{"text":`+jsonString(strings.Replace(got.Text, `"command": "c"`, `"command": "other"`, 1))+`}`); rec.Code != 400 {
		t.Errorf("a redacted env under a changed command: %d %s", rec.Code, rec.Body)
	}
	id = ask(t, f, "POST", `{"text":`+jsonString(edited)+`}`)
	if out := answer(t, f, id, true); out["status"] != "approved" {
		t.Fatalf("the round trip's approval: %v", out)
	}
	if after := readFile(t, path); !strings.Contains(after, `"cos": "/cos"`) || !strings.Contains(after, "PEER-SECRET") || strings.Contains(after, "[redacted]") {
		t.Errorf("the round trip: %s", after)
	}
	// A shared key that arrives in the cache after the ask: the approval applies nothing.
	id = ask(t, f, "PATCH", `{"patch":{"debug":{"stallMs":400}}}`)
	must(t, f.srv.settings.WriteSharedCache(strings.Replace(peerCache, `"debug":{}`, `"debug":{"other":1}`, 1)))
	before := readFile(t, path)
	n := &notices{}
	f.srv.noticeHook = n.add
	if out := answer(t, f, id, true); out["status"] != "denied" || readFile(t, path) != before {
		t.Errorf("an approval made stale by the home: %v", out)
	}
	if got := n.all(); len(got) == 0 || !strings.Contains(strings.Join(got, "\n"), "was approved, but not applied: a setting it changes changed after you asked") {
		t.Errorf("its notice: %q", got)
	}
}

// TestSettingsSync: two daemons over sockets. The peer fetches the home's shared part into its cache and keeps its own
// local keys; only a peer fetches it, only from the home; a change on the home reaches the peer through the push; an
// invalid file on the home is a 503 and the peer keeps its cache; a home that is gone leaves the copy stale.
func TestSettingsSync(t *testing.T) {
	home, homePath := settingsFixture(t)
	peer, _ := peerFixture(t)
	homeTS := httptest.NewServer(home.srv)
	t.Cleanup(homeTS.Close)
	peerTS := httptest.NewServer(peer.srv)
	t.Cleanup(peerTS.Close)
	must(t, os.WriteFile(homePath, []byte(`{"peers":[{"name":"peer-m","url":"`+peerTS.URL+`","token":"`+sharedTok+`","peerToken":"`+peerTok+`"}],"mail":{"titles":{"model":"home-1"}},"itsa":{"repos":{"h":"/h"}},"mcpServers":{"s":{"command":"c"}}}`), 0o600))
	must(t, os.WriteFile(filepath.Join(peer.home, "settings.json"), []byte(`{"home":"test-machine","peers":[{"name":"test-machine","url":"`+homeTS.URL+`","token":"`+sharedTok+`","peerToken":"`+peerTok+`"}],"itsa":{"repos":{"p":"/p"}}}`), 0o600))
	must(t, os.Remove(filepath.Join(peer.home, "settings.shared.json")))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	peer.srv.syncShared()
	if s := peer.srv.settings.Get(); s.Itsa.Repos["p"] != "/p" || s.Itsa.Repos["h"] != "" || len(s.Peers) != 1 || s.Peers[0].Name != "test-machine" {
		t.Errorf("the peer's local keys: %+v %+v", s.Itsa.Repos, s.Peers)
	}
	model := func() string {
		v, _ := peer.srv.settings.View().Get("mail")
		return jsonOf(v)
	}
	if !strings.Contains(model(), "home-1") {
		t.Fatalf("the peer's shared keys: %s", model())
	}
	st := peer.srv.syncState()
	if st.Stale || st.Rev == nil || len(*st.Rev) != 64 || st.Home != "test-machine" {
		t.Errorf("sync state: %+v", st)
	}
	if strings.Contains(readFile(t, peer.srv.settings.SharedPath()), "peer-m") {
		t.Errorf("the cache holds the home's peers: %s", readFile(t, peer.srv.settings.SharedPath()))
	}

	local := map[string]string{"X-Stam-Local": "1"}
	if rec := home.do(call{path: "/api/config/settings/shared", token: sharedTok}); rec.Code != 403 {
		t.Errorf("a non-peer fetched the shared settings: %d", rec.Code)
	}
	if rec := home.do(call{path: "/api/config/settings/shared", token: agentTok, header: local}); rec.Code != 403 {
		t.Errorf("an agent's token with x-stam-local fetched them: %d", rec.Code)
	}
	if rec := peer.do(call{path: "/api/config/settings/shared", token: peerTok, header: local}); rec.Code != 409 {
		t.Errorf("a non-home daemon served them: %d", rec.Code)
	}
	if rec := peer.do(call{method: "POST", path: "/api/config/settings/changed", token: sharedTok, body: `{}`}); rec.Code != 403 {
		t.Errorf("a non-peer said they changed: %d", rec.Code)
	}
	if rec := home.do(call{path: "/api/config/settings/shared?rev=" + *st.Rev, token: peerTok, header: local}); rec.Body.String() != `{"unchanged":true,"rev":"`+*st.Rev+`"}` {
		t.Errorf("the same rev: %s", rec.Body)
	}

	// A change on the home reaches the peer through the push.
	home.srv.StartSettingsSync(ctx)
	peer.srv.StartSettingsSync(ctx)
	if rec := home.do(call{method: "PATCH", path: "/api/config/settings", token: sharedTok, header: trusted, body: `{"patch":{"mail":{"titles":{"model":"home-2"}}}}`}); rec.Code != 200 {
		t.Fatalf("the home's patch: %d %s", rec.Code, rec.Body)
	}
	waitFor(t, func() bool { return strings.Contains(model(), "home-2") }, "the push")

	// An invalid file on the home: 503, and the peer keeps its cache.
	good := readFile(t, homePath)
	must(t, os.WriteFile(homePath, []byte("{ not json"), 0o600))
	if rec := home.do(call{path: "/api/config/settings/shared", token: peerTok, header: local}); rec.Code != 503 {
		t.Errorf("an invalid file: %d %s", rec.Code, rec.Body)
	}
	peer.srv.syncShared()
	if st := peer.srv.syncState(); !st.Stale || st.LastError == nil || !strings.Contains(*st.LastError, "503") || !strings.Contains(model(), "home-2") {
		t.Errorf("after the home's invalid file: %+v %s", st, model())
	}
	must(t, os.WriteFile(homePath, []byte(good), 0o600))
	peer.srv.syncShared()
	if st := peer.srv.syncState(); st.Stale {
		t.Errorf("the home came back, still stale: %+v", st)
	}

	// The home is gone: the copy is stale, and the cached settings stay.
	homeTS.Close()
	peer.srv.syncShared()
	if st := peer.srv.syncState(); !st.Stale || st.LastError == nil || !strings.Contains(model(), "home-2") {
		t.Errorf("with the home gone: %+v %s", st, model())
	}
}

func jsonOf(v any) string { return jsjson.Stringify(v, "") }

// TestSettingsSyncBootRev: a peer that boots with a cache asks the home with the cached rev, so an unchanged home sends
// no settings and the cache stays; a push of the rev it already has fetches nothing, and a push of a new one fetches.
func TestSettingsSyncBootRev(t *testing.T) {
	peer, _ := peerFixture(t)
	var mu sync.Mutex
	var asked []string
	homeTS := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asked = append(asked, r.URL.RawQuery)
		mu.Unlock()
		w.Header().Set("content-type", "application/json")
		fmt.Fprint(w, `{"unchanged":true,"rev":"r1"}`)
	}))
	t.Cleanup(homeTS.Close)
	must(t, os.WriteFile(filepath.Join(peer.home, "settings.json"), []byte(`{"home":"test-machine","peers":[{"name":"test-machine","url":"`+homeTS.URL+`","token":"`+sharedTok+`","peerToken":"`+peerTok+`"}]}`), 0o600))
	cache := readFile(t, peer.srv.settings.SharedPath())
	fetches := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), asked...)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	peer.srv.StartSettingsSync(ctx)
	waitFor(t, func() bool { return len(fetches()) == 1 && peer.srv.syncState().FetchedAt != nil }, "the boot fetch")
	if got := fetches(); got[0] != "rev=r1" {
		t.Errorf("the boot fetch asked %q, not the cached rev", got[0])
	}
	if readFile(t, peer.srv.settings.SharedPath()) != cache || peer.srv.syncState().Stale {
		t.Errorf("an unchanged home changed the cache or left it stale: %+v", peer.srv.syncState())
	}
	if peer.srv.homeChanged("r1") {
		t.Errorf("a push of the rev the peer has started a sync")
	}
	if !peer.srv.homeChanged("r2") {
		t.Errorf("a push of a new rev started no sync")
	}
	waitFor(t, func() bool { return len(fetches()) >= 2 }, "the fetch for the new rev")
	// The route: a push of a new rev is answered at once and fetches.
	local := map[string]string{"X-Stam-Local": "1"}
	if rec := peer.do(call{method: "POST", path: "/api/config/settings/changed", token: peerTok, header: local, body: `{"rev":"r3"}`}); rec.Code != 200 {
		t.Fatalf("the push: %d %s", rec.Code, rec.Body)
	}
	waitFor(t, func() bool { return len(fetches()) >= 3 }, "the fetch for the pushed rev")
}

// TestPruneTypeFiles: a peer's own type template goes once the home's registry shows its type gone (masked, or named
// neither there nor among the shipped types); a shipped or listed type keeps its file, and a registry with no types
// proves nothing.
func TestPruneTypeFiles(t *testing.T) {
	f, _ := peerFixture(t)
	f.srv.tpl.Root = "../../.."
	dir := filepath.Join(f.home, "templates")
	must(t, os.MkdirAll(dir, 0o700))
	for _, n := range []string{"type-gone", "type-masked", "type-kept", "type-manager", "mail-to-human"} {
		must(t, os.WriteFile(filepath.Join(dir, n+".md"), []byte(n), 0o600))
	}
	left := func() string {
		var out []string
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			out = append(out, strings.TrimSuffix(e.Name(), ".md"))
		}
		return strings.Join(out, ",")
	}
	f.srv.pruneTypeFiles(jsjson.NewObject())
	f.srv.pruneTypeFiles(nil)
	if got := left(); got != "mail-to-human,type-gone,type-kept,type-manager,type-masked" {
		t.Fatalf("a registry with no types removed files: %s", got)
	}
	reg, err := jsjson.Parse([]byte(`{"types":{"kept":{"harness":"claude"},"masked":null}}`))
	must(t, err)
	f.srv.pruneTypeFiles(reg)
	if got := left(); got != "mail-to-human,type-kept,type-manager" {
		t.Errorf("after the prune: %s", got)
	}
}

package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"stam/internal/auth"
)

// testFixture is a test daemon: the test hooks on.
func testFixture(t *testing.T) *fixture {
	return newFixture(t, map[string]string{"STAM_TEST_COST_HOOKS": "1"})
}

// hook calls a test route with the shared token and decodes its answer into out (when not nil); it fails on a non-200.
func (f *fixture) hook(method, path, body string, out any) {
	f.t.Helper()
	rec := f.do(call{method: method, path: path, token: sharedTok, body: body})
	if rec.Code != 200 {
		f.t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body.String())
	}
	if out != nil {
		must(f.t, json.Unmarshal(rec.Body.Bytes(), out))
	}
}

// TestTestRoutesRefuseAgents: every test route refuses an agent's token before it runs, as TS does (S-1732).
func TestTestRoutesRefuseAgents(t *testing.T) {
	f := testFixture(t)
	for _, p := range []string{"POST /api/test/kv", "POST /api/test/agent", "GET /api/test/events", "POST /api/test/seed-agents", "GET /api/test/token-at-rest"} {
		method, path, _ := strings.Cut(p, " ")
		for _, tok := range []string{agentTok, serverTok} {
			rec := f.do(call{method: method, path: path, token: tok, body: `{"key":"k","value":"v"}`})
			if rec.Code != 403 || envelope(t, rec)["error"] != "an agent's token can't call the test hooks" {
				t.Errorf("%s: %d %s", p, rec.Code, rec.Body.String())
			}
		}
	}
	var kv struct{ Value *string }
	f.hook("GET", "/api/test/kv?key=k", "", &kv)
	if kv.Value != nil {
		t.Errorf("a refused write landed: %v", *kv.Value)
	}
}

func TestTestKVAndEvents(t *testing.T) {
	f := testFixture(t)
	var kv struct{ Value *string }
	f.hook("POST", "/api/test/kv", `{"key":"k","value":12}`, nil)
	f.hook("GET", "/api/test/kv?key=k", "", &kv)
	if kv.Value == nil || *kv.Value != "12" {
		t.Fatalf("kv = %v", kv.Value)
	}
	f.hook("POST", "/api/test/kv", `{"key":"k","value":null}`, nil)
	f.hook("GET", "/api/test/kv?key=k", "", &kv)
	if kv.Value != nil {
		t.Errorf("a null value didn't delete")
	}

	ctx := context.Background()
	must(t, f.db.AddEvent(ctx, "achild", "cost:signal", map[string]string{"a": "b"}))
	must(t, f.db.AddEvent(ctx, "aboss", "cost:other", nil))
	var rows []map[string]any
	f.hook("GET", "/api/test/events?agent=achild&type=cost:%25", "", &rows)
	if len(rows) != 1 || rows[0]["agent_id"] != "achild" || rows[0]["type"] != "cost:signal" || rows[0]["data"] != `{"a":"b"}` {
		t.Errorf("events = %v", rows)
	}
	f.hook("GET", "/api/test/events?type=cost:%25", "", &rows)
	if len(rows) != 2 {
		t.Errorf("events by type = %v", rows)
	}
}

// TestTestAgent: the raw agent write and its create; the token goes in hashed, refs resolve, an unknown agent is a 404.
func TestTestAgent(t *testing.T) {
	f := testFixture(t)
	f.hook("POST", "/api/test/agent", `{"agent":"anew","create":{"name":"newbie","harness":"codex"},"parent":"achild","token":"tok-x","activity":"idle","workspace":{"k":1},"first_prompt":null}`, nil)
	a, err := f.db.GetAgent(context.Background(), "newbie")
	must(t, err)
	if a.ID != "anew" || a.Harness != "codex" || a.Role != "dev" || a.Cwd != "/tmp" || a.Machine != envMachine() ||
		a.ParentID == nil || *a.ParentID != "achild" || a.Activity != "idle" || a.IdleSince == nil || a.Workspace == nil || *a.Workspace != `{"k":1}` {
		t.Errorf("agent = %+v", a)
	}
	if a.TokenHash == nil || a.TokenHash.Reveal() != auth.Hash("tok-x") {
		t.Errorf("token not stored as its hash")
	}
	f.hook("POST", "/api/test/agent", `{"agent":"newbie","activity":"working","token":null}`, nil)
	a, _ = f.db.GetAgent(context.Background(), "anew")
	if a.Activity != "working" || a.IdleSince != nil || a.TokenHash != nil {
		t.Errorf("second write = %+v", a)
	}
	rec := f.do(call{method: "POST", path: "/api/test/agent", token: sharedTok, body: `{"agent":"ghost","activity":"idle"}`})
	if rec.Code != 404 || envelope(t, rec)["error"] != "no agent ghost" {
		t.Errorf("unknown agent: %d %s", rec.Code, rec.Body.String())
	}
}

// TestTestTokenAtRest: a token that only went in hashed is not plain in any db file, and its hash is found.
func TestTestTokenAtRest(t *testing.T) {
	f := testFixture(t)
	var got map[string]bool
	f.hook("GET", "/api/test/token-at-rest?token="+agentTok, "", &got)
	if !reflect.DeepEqual(got, map[string]bool{"plain": false, "hashed": true}) {
		t.Errorf("agent token: %v", got)
	}
	f.hook("POST", "/api/test/kv", `{"key":"leak","value":"`+agentTok+`"}`, nil)
	f.hook("GET", "/api/test/token-at-rest?token="+agentTok, "", &got)
	if !got["plain"] {
		t.Errorf("a token written plain wasn't found: %v", got)
	}
}

// TestTestSeedAgents: the seeded tree, mail, waits and blockers, read back through GET /api/agents.
func TestTestSeedAgents(t *testing.T) {
	f := testFixture(t)
	var seeded map[string]any
	f.hook("POST", "/api/test/seed-agents", `{"count":16}`, &seeded)
	if seeded["seeded"] != 16.0 {
		t.Fatalf("seed: %v", seeded)
	}
	var stats map[string]any
	f.hook("POST", "/api/test/statements", `{"action":"start"}`, nil)
	var agents []map[string]any
	f.hook("GET", "/api/agents", "", &agents)
	f.hook("POST", "/api/test/statements", `{"action":"stop"}`, &stats)
	if n, _ := stats["statements"].(float64); n < 1 {
		t.Errorf("statements = %v", stats)
	}
	by := map[string]map[string]any{}
	for _, a := range agents {
		by[a["id"].(string)] = a
	}
	if by["id-3"]["unread"] != 3.0 || len(by["id-7"]["blockers"].([]any)) != 1 || !reflect.DeepEqual(by["id-1"]["parents"], []any{"id-0"}) {
		t.Errorf("seeded agents: id-3 %v id-7 %v id-1 %v", by["id-3"]["unread"], by["id-7"]["blockers"], by["id-1"]["parents"])
	}
	var kinds []string
	for _, w := range by["id-15"]["waits"].([]any) {
		kinds = append(kinds, w.(map[string]any)["kind"].(string))
	}
	sort.Strings(kinds)
	if !reflect.DeepEqual(kinds, []string{"event", "timer"}) {
		t.Errorf("id-15 waits %v", kinds)
	}
	rec := f.do(call{method: "POST", path: "/api/test/statements", token: sharedTok, body: `{"action":"stop"}`})
	if rec.Code != 400 || envelope(t, rec)["error"] != "action must be start, then stop" {
		t.Errorf("stop without start: %d %s", rec.Code, rec.Body.String())
	}
	var counts map[string]float64
	f.hook("GET", "/api/test/counts", "", &counts)
	if counts["agents"] < 16 || counts["mail"] < 24 {
		t.Errorf("counts %v", counts)
	}
}

// TestTestReadHold: a held read waits until the test releases it.
func TestTestReadHold(t *testing.T) {
	f := testFixture(t)
	f.hook("POST", "/api/test/read-hold", `{"agent":"achild","action":"hold"}`, nil)
	done := make(chan *httptest.ResponseRecorder)
	go func() {
		done <- f.do(call{method: "POST", path: "/api/agents/achild/read", token: agentTok, body: `{}`})
	}()
	select {
	case rec := <-done:
		t.Fatalf("a held read answered: %d %s", rec.Code, rec.Body.String())
	case <-time.After(100 * time.Millisecond):
	}
	f.hook("POST", "/api/test/read-hold", `{"agent":"achild","action":"release"}`, nil)
	if rec := <-done; rec.Code != 200 {
		t.Errorf("the released read: %d %s", rec.Code, rec.Body.String())
	}
	// A read whose client gave up while held still runs once released, as in TS (test/e2e-read-mail.sh).
	f.hook("POST", "/api/test/read-hold", `{"agent":"achild","action":"hold"}`, nil)
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("POST", "/api/agents/achild/read", strings.NewReader(`{"ids":["m1"]}`)).WithContext(ctx)
	req.Host = "127.0.0.1:7999"
	req.Header.Set("Authorization", "Bearer "+agentTok)
	gone := httptest.NewRecorder()
	served := make(chan struct{})
	go func() { f.srv.ServeHTTP(gone, req); close(served) }()
	for f.readsHeld() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	f.hook("POST", "/api/test/read-hold", `{"agent":"achild","action":"release"}`, nil)
	<-served
	if gone.Code != 200 {
		t.Errorf("the read whose client left: %d %s", gone.Code, gone.Body.String())
	}
	rec := f.do(call{method: "POST", path: "/api/test/read-hold", token: sharedTok, body: `{"agent":"achild","action":"x"}`})
	if rec.Code != 400 || envelope(t, rec)["error"] != "action must be hold or release" {
		t.Errorf("bad action: %d %s", rec.Code, rec.Body.String())
	}
}

// readsHeld is how many reads wait at a hold.
func (f *fixture) readsHeld() int {
	f.srv.tests.mu.Lock()
	defer f.srv.tests.mu.Unlock()
	return f.srv.tests.readsHeld
}

// TestTestItsaGate: the gate parks a passer until released and counts it while it waits.
func TestTestItsaGate(t *testing.T) {
	f := testFixture(t)
	var gate map[string]int
	f.hook("POST", "/api/test/itsa-gate", `{"action":"hold"}`, &gate)
	passed := make(chan error)
	go func() { passed <- f.srv.itsaGatePass(context.Background()) }()
	for gate["waiting"] != 1 {
		f.hook("POST", "/api/test/itsa-gate", `{"action":"status"}`, &gate)
	}
	f.hook("POST", "/api/test/itsa-gate", `{"action":"release"}`, &gate)
	must(t, <-passed)
	f.hook("POST", "/api/test/itsa-gate", `{}`, &gate)
	if gate["waiting"] != 0 {
		t.Errorf("waiting after release: %v", gate)
	}
}

// TestTestMailAndRows: the mail shapes, the permission, wait and usage writes and their refusals, and the purpose reads.
func TestTestMailAndRows(t *testing.T) {
	f := testFixture(t)
	f.hook("POST", "/api/test/mail", `{"action":"agent","id":"aold","name":"old"}`, nil)
	a, err := f.db.GetAgent(context.Background(), "old")
	must(t, err)
	if a.Lifecycle != "shut_down" || a.Role != "mail-archive test helper" {
		t.Errorf("mail agent %+v", a)
	}
	f.hook("POST", "/api/test/mail", `{"action":"read-all"}`, nil)
	for _, body := range []string{`{"action":"nope"}`, `{}`} {
		rec := f.do(call{method: "POST", path: "/api/test/mail", token: sharedTok, body: body})
		if rec.Code != 400 || envelope(t, rec)["error"] != "action must be agent, set-time, archive or read-all" {
			t.Errorf("%s: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	rec := f.do(call{method: "POST", path: "/api/test/permission", token: sharedTok, body: `{"id":"pnope","status":"denied"}`})
	if rec.Code != 404 || envelope(t, rec)["error"] != "no permission request pnope" {
		t.Errorf("permission: %d %s", rec.Code, rec.Body.String())
	}
	f.hook("POST", "/api/test/wait", `{"agent":"achild","kind":"timer","id":"wt1","until":"2030-01-01T00:00:00.000Z","data":{"x":1}}`, nil)
	w, err := f.db.GetWait(context.Background(), "wt1")
	must(t, err)
	if w.AgentID != "achild" || w.Source != "stam" || w.Data == nil || *w.Data != `{"x":1}` {
		t.Errorf("wait %+v", w)
	}
	rec = f.do(call{method: "POST", path: "/api/test/usage", token: sharedTok, body: `{"table":"nope"}`})
	if rec.Code != 400 || envelope(t, rec)["error"] != "table must be usage or usage_samples" {
		t.Errorf("usage table: %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(call{method: "POST", path: "/api/test/usage", token: sharedTok, body: `{"table":"usage","rows":[{"agent":"ghost"}]}`})
	if rec.Code != 400 || envelope(t, rec)["error"] != "no agent ghost" {
		t.Errorf("usage agent: %d %s", rec.Code, rec.Body.String())
	}
	f.hook("POST", "/api/test/usage", `{"table":"usage","rows":[{"agent":"achild","day":"2026-10-01","harness":"claude","model":"m","account":"acct-x","cost_usd":1.25}]}`, nil)
	var total map[string]float64
	f.hook("GET", "/api/test/usage-total?account=acct-x", "", &total)
	if total["cost_usd"] != 1.25 {
		t.Errorf("usage-total %v", total)
	}
	var list []map[string]any
	f.hook("GET", "/api/test/blockers?agent=achild", "", &list)
	if list == nil {
		t.Errorf("blockers answered null, want a list")
	}
	if rec := f.do(call{path: "/api/test/blockers?agent=ghost", token: sharedTok}); rec.Code != 404 {
		t.Errorf("blockers of an unknown agent: %d", rec.Code)
	}
	for _, p := range []string{"/api/test/peer-agents", "/api/test/req-waivers", "/api/test/cost-notices", "/api/test/cost-fallbacks", "/api/test/mail-pushed?agent=achild&subject=x"} {
		f.hook("GET", p, "", &list)
	}
	var n map[string]float64
	f.hook("GET", "/api/test/pending-unown", "", &n)
	f.hook("GET", "/api/test/switch-retries", "", &n)
	if rec := f.do(call{path: "/api/test/settings", token: sharedTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"home":"test-machine"`) {
		t.Errorf("settings: %d %s", rec.Code, rec.Body)
	}
}

// TestTestDeliveryFail: the trigger makes a delivery insert fail until it is dropped again.
func TestTestDeliveryFail(t *testing.T) {
	f := testFixture(t)
	f.hook("POST", "/api/test/delivery-fail", `{"fail":true}`, nil)
	if _, err := f.db.TestExec(context.Background(), "INSERT INTO mail_deliveries (agent_id, batch, mail_id) VALUES ('achild', 'b', 'm')"); err == nil || !strings.Contains(err.Error(), "injected") {
		t.Errorf("insert with the trigger: %v", err)
	}
	f.hook("POST", "/api/test/delivery-fail", `{"fail":false}`, nil)
	rows, err := f.db.TestRows(context.Background(), "SELECT name FROM sqlite_master WHERE name = 'fail_delivery'")
	must(t, err)
	if len(rows) != 0 {
		t.Errorf("the trigger stayed")
	}
}

// TestTestAwait: the request writes stall-awaiting and holds until stall-release exists.
func TestTestAwait(t *testing.T) {
	f := testFixture(t)
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- f.do(call{method: "POST", path: "/api/test/await", token: sharedTok}) }()
	for {
		if _, err := os.Stat(filepath.Join(f.home, "stall-awaiting")); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	must(t, os.WriteFile(filepath.Join(f.home, "stall-release"), nil, 0o600))
	if rec := <-done; rec.Code != 200 {
		t.Errorf("await: %d %s", rec.Code, rec.Body.String())
	}
}

// TestApplyTestSeedOwnNames: a seed's `parent` and `waits` may name, by name, an agent the same seed creates; the ref is
// read inside the seed's transaction, which a reader connection can't see.
func TestApplyTestSeedOwnNames(t *testing.T) {
	f := testFixture(t)
	file := filepath.Join(f.home, "test-seed.json")
	must(t, os.WriteFile(file, []byte(`{"agents":[{"agent":"aseedboss","create":{"name":"seedboss"}},{"agent":"aseedkid","create":{"name":"seedkid"},"parent":"seedboss"}],
		"waits":[{"agent":"seedkid","kind":"timer","id":"wkid"}]}`), 0o600))
	must(t, f.srv.ApplyTestSeed(context.Background()))
	kid, err := f.db.GetAgent(context.Background(), "seedkid")
	must(t, err)
	if kid.ParentID == nil || *kid.ParentID != "aseedboss" {
		t.Errorf("kid's parent %v, want aseedboss", kid.ParentID)
	}
	w, err := f.db.GetWait(context.Background(), "wkid")
	must(t, err)
	if w.AgentID != "aseedkid" {
		t.Errorf("the wait is %s's, want aseedkid", w.AgentID)
	}
}

// TestApplyTestSeed: test-seed.json lands in one transaction and is renamed; a bad seed writes nothing.
func TestApplyTestSeed(t *testing.T) {
	f := testFixture(t)
	file := filepath.Join(f.home, "test-seed.json")
	must(t, os.WriteFile(file, []byte(`{"agents":[{"agent":"aseed","create":{"name":"seedy"},"lifecycle":"starting"}],"events":[{"agent":"aseed","type":"spawn"}],
		"waits":[{"agent":"aseed","kind":"timer","id":"wseed"}]}`), 0o600))
	must(t, f.srv.ApplyTestSeed(context.Background()))
	a, err := f.db.GetAgent(context.Background(), "seedy")
	must(t, err)
	if a.Lifecycle != "starting" {
		t.Errorf("seeded agent %+v", a)
	}
	if _, err := os.Stat(file + ".done"); err != nil {
		t.Errorf("the seed wasn't renamed: %v", err)
	}
	if _, err := f.db.GetWait(context.Background(), "wseed"); err != nil {
		t.Errorf("seeded wait: %v", err)
	}
	must(t, os.WriteFile(file, []byte(`{"agents":[{"agent":"abad","create":{"name":"bad"}}],"permissions":[{"id":"pnope","status":"x"}]}`), 0o600))
	if err := f.srv.ApplyTestSeed(context.Background()); err == nil {
		t.Fatalf("a seed naming a missing permission request applied")
	}
	if _, err := f.db.GetAgent(context.Background(), "bad"); err == nil {
		t.Errorf("a failed seed left its agent")
	}
}

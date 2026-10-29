package server

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"stam/internal/config"
)

// cosNow is GET /api/chief-of-staff's chiefOfStaff, "" for null.
func (f *fixture) cosNow() string {
	f.t.Helper()
	rec := f.do(call{path: "/api/chief-of-staff", token: agentTok})
	var out struct{ ChiefOfStaff *string }
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &out) != nil {
		f.t.Fatalf("GET /api/chief-of-staff: %d %s", rec.Code, rec.Body)
	}
	return str0(out.ChiefOfStaff)
}

// TestCosType is test/e2e-cos.sh's contract: spawning the cos type makes the agent the chief of staff, only the human
// and the assistant spawn it and only one runs, the human alone starts and stops one through /api/cos, a chief of staff
// named the old way (chief_of_staff) still counts, and the name is in settings.json, so a restart keeps it.
func TestCosType(t *testing.T) {
	f := typeSpawnFixture(t)
	if rec := f.spawn(agentTok, `"type":"cos","name":"sneaky"`); rec.Code != 403 || !strings.Contains(rec.Body.String(), "only the human and the assistant spawn a chief of staff") {
		t.Fatalf("an agent's cos spawn: %d %s", rec.Code, rec.Body)
	}
	if got := f.cosNow(); got != "" {
		t.Fatalf("a chief of staff before any spawn: %q", got)
	}
	rec := f.human("POST", "/api/agents", `{"name":"chief","type":"cos","cwd":"`+f.home+`"}`)
	var a spawnedAgent
	_ = json.Unmarshal(rec.Body.Bytes(), &a)
	if rec.Code != 200 || str0(a.Model) != "claude-opus-5-5" || str0(a.Effort) != "medium" || a.Standing != 1 || a.Type != "cos" {
		t.Fatalf("the human's cos spawn: %d %s", rec.Code, rec.Body)
	}
	if got := f.cosNow(); got != "chief" {
		t.Fatalf("the spawn didn't set the chief of staff: %q", got)
	}
	if got := config.NewSettingsFile(f.home, f.cfg.Machine).Get().ChiefOfStaff; got != "chief" {
		t.Errorf("settings.json after a restart: chiefOfStaff %q", got)
	}
	if rec := f.human("POST", "/api/agents", `{"name":"chief2","type":"cos","cwd":"`+f.home+`"}`); rec.Code != 409 || !strings.Contains(rec.Body.String(), "chief is already the chief of staff") {
		t.Errorf("a second cos: %d %s", rec.Code, rec.Body)
	}
	if rec := f.human("POST", "/api/cos/start", ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"name":"chief"`) {
		t.Errorf("start with one active: %d %s", rec.Code, rec.Body)
	}
	for _, p := range []string{"/api/cos/stop", "/api/cos/start"} {
		if rec := f.do(call{method: "POST", path: p, token: agentTok, body: `{}`}); rec.Code != 403 || !strings.Contains(rec.Body.String(), "only the human starts or stops the chief of staff this way") {
			t.Errorf("an agent's %s: %d %s", p, rec.Code, rec.Body)
		}
	}
	if rec := f.human("POST", "/api/cos/stop", ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"lifecycle":"shut_down"`) {
		t.Fatalf("stop: %d %s", rec.Code, rec.Body)
	}
	if got := f.cosNow(); got != "" {
		t.Errorf("a chief of staff after stop: %q", got)
	}
	if rec := f.human("POST", "/api/cos/stop", ""); rec.Code != 404 || !strings.Contains(rec.Body.String(), "no chief of staff is active") {
		t.Errorf("stop with none: %d %s", rec.Code, rec.Body)
	}
	rec = f.human("POST", "/api/cos/start", "")
	var n struct{ Name, Type, Cwd, Role string }
	_ = json.Unmarshal(rec.Body.Bytes(), &n)
	if rec.Code != 200 || n.Name != "cos" || n.Type != "cos" || n.Cwd != filepath.Join(f.home, "cos") || n.Role != "Chief of staff" {
		t.Fatalf("start: %d %s", rec.Code, rec.Body)
	}
	if got := f.cosNow(); got != "cos" {
		t.Errorf("start didn't set the chief of staff: %q", got)
	}

	// The old way: chief_of_staff on the human's spawn names it; on anyone else's it is ignored.
	f.human("POST", "/api/cos/stop", "")
	if _, code, body := f.spawnAs(`"name":"nobody","harness":"claude","chief_of_staff":true`); code != 200 || f.cosNow() != "" {
		t.Errorf("chief_of_staff on a spawn that isn't the human's: %d %s, cos %q", code, body, f.cosNow())
	}
	if rec := f.human("POST", "/api/agents", `{"name":"legacy","harness":"claude","cwd":"`+f.home+`","chief_of_staff":true}`); rec.Code != 200 || f.cosNow() != "legacy" {
		t.Errorf("chief_of_staff spawn: %d %s, cos %q", rec.Code, rec.Body, f.cosNow())
	}
}

// TestCosName: POST /api/chief-of-staff (`stam cos`) is the human's and the assistant's; it names an agent, or clears
// the name with none, and an unknown agent is a 404.
func TestCosName(t *testing.T) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	if rec := f.do(call{method: "POST", path: "/api/chief-of-staff", token: agentTok, body: `{"agent":"achild"}`}); rec.Code != 403 || !strings.Contains(rec.Body.String(), "only the human and the assistant name the chief of staff") {
		t.Errorf("an agent names itself: %d %s", rec.Code, rec.Body)
	}
	if rec := f.human("POST", "/api/chief-of-staff", `{"agent":"nope"}`); rec.Code != 404 || !strings.Contains(rec.Body.String(), "no agent nope") {
		t.Errorf("an unknown agent: %d %s", rec.Code, rec.Body)
	}
	if rec := f.human("POST", "/api/chief-of-staff", `{"agent":"aboss"}`); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"chiefOfStaff":"boss"}` {
		t.Errorf("name aboss: %d %s", rec.Code, rec.Body)
	}
	if got := f.srv.settings.Get().ChiefOfStaff; got != "boss" {
		t.Errorf("setting: %q", got)
	}
	// The assistant may name one too.
	f.sql("UPDATE agents SET kind = 'assistant' WHERE id = 'aboss'")
	if rec := f.do(call{method: "POST", path: "/api/chief-of-staff", token: sharedTok, body: `{"by":"aboss","agent":"achild"}`}); rec.Code != 200 {
		t.Errorf("the assistant names one: %d %s", rec.Code, rec.Body)
	}
	if rec := f.human("POST", "/api/chief-of-staff", `{}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"chiefOfStaff":null`) {
		t.Errorf("clear: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/chief-of-staff", token: agentTok}); !strings.Contains(rec.Body.String(), `"setting":null`) {
		t.Errorf("GET after clear: %s", rec.Body)
	}
}

// TestCosOneAtATime: a cos spawn holds the spawn from its check to its end. While the first spawn is blocked inside the
// hold, a competing cos spawn is a 409; when the first fails, the hold is released and a retry spawns. Only the first
// spawn blocks in the hook, so without the hold the competing spawn succeeds, and without its release the retry is a
// 409: each fails here rather than hanging.
func TestCosOneAtATime(t *testing.T) {
	f := typeSpawnFixture(t)
	spawnCos := func(name string) *httptest.ResponseRecorder {
		return f.human("POST", "/api/agents", `{"name":"`+name+`","type":"cos","cwd":"`+f.home+`"}`)
	}
	var calls atomic.Int32
	entered, release := make(chan struct{}), make(chan error)
	f.srv.cos.held = func() error {
		if calls.Add(1) == 1 {
			entered <- struct{}{}
			return <-release
		}
		return nil
	}
	first := make(chan int, 1)
	go func() { first <- spawnCos("first").Code }()
	<-entered
	if rec := spawnCos("second"); rec.Code != 409 || !strings.Contains(rec.Body.String(), "a chief of staff is already starting") {
		t.Errorf("a cos spawn beside one in the hold: %d %s", rec.Code, rec.Body)
	}
	release <- errors.New("forced failure")
	if code := <-first; code == 200 {
		t.Fatalf("the forced failure spawned")
	}
	if rec := spawnCos("retry"); rec.Code != 200 || f.cosNow() != "retry" {
		t.Fatalf("the retry after a failed spawn: %d %s, cos %q", rec.Code, rec.Body, f.cosNow())
	}
	if n := f.count("SELECT count(*) FROM agents WHERE type = 'cos' AND lifecycle IN ('active', 'paused')"); n != 1 {
		t.Errorf("%d active cos", n)
	}
}

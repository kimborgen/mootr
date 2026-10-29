package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// registryFixture is a settings home with the checkout's registry, templates and blocks, and achild the chief of staff.
func registryFixture(t *testing.T) *fixture {
	f, _ := cosFixture(t)
	f.srv.tpl.Root = "../../.."
	return f
}

// human is a call with the human's proof.
func (f *fixture) human(method, path, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.do(call{method: method, path: path, token: sharedTok, header: trusted, body: body})
}

// TestTypeRoutes: the human saves a type checked against the registry, an invalid one is a 400 that writes nothing, an
// agent may not save one, and removal masks a shipped type, deletes a user one with its instructions, and refuses the
// default reviewer, a type another names, and a missing one.
func TestTypeRoutes(t *testing.T) {
	f := registryFixture(t)
	regPath := filepath.Join(f.home, "registry.json")
	rec := f.human("POST", "/api/types/tester", `{"description":" Writes tests. ","harness":"claude","model":"claude-haiku-5-5","effort":"low","child_notices":"none","visibility":{"reach":"tree"},"brief":"Do: {{task}}"}`)
	if rec.Code != 200 || rec.Body.String() != `{"description":"Writes tests.","harness":"claude","model":"claude-haiku-5-5","effort":"low","child_notices":"none","visibility":{"reach":"tree"},"brief":"Do: {{task}}"}` {
		t.Fatalf("save: %d %s", rec.Code, rec.Body)
	}
	saved := readFile(t, regPath)
	for _, tc := range []struct{ body, want string }{
		{`{"harness":"nope"}`, "unknown harness nope"},
		{`{"harness":"claude","effort":"huge"}`, "claude has no effort huge"},
		{`{"harness":"claude","child_notices":"loud"}`, "child notices must be"},
		{`{"harness":"claude","visibility":{"reach":"moon"}}`, "reach must be"},
		{`{"harness":"claude","blocks":{"order":["nope"]}}`, "unknown block id nope"},
		{`{"harness":"claude","blocks":{"replace":{"x":"/etc/passwd"}}}`, "unknown block id x"},
		{`{"harness":"claude","skills":["no-such-skill"]}`, "unknown skill no-such-skill"},
		{`{"harness":"claude","review":{"fallback":"nope"}}`, "fallback nope is not a reviewer type"},
		{`{"harness":"claude","default":true}`, "only a reviewer type can be the default reviewer"},
		{`{"harness":"claude","review":{"ring":{"format":"rounds","members":["reviewer","reviewer-opus"],"maxRounds":1}}}`, "a ring type has no harness"},
		{`{"review":{"ring":{"format":"rounds","members":["reviewer"],"maxRounds":1}}}`, "a ring needs at least 2 members"},
	} {
		if rec := f.human("POST", "/api/types/tester", tc.body); rec.Code != 400 || !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("%s: %d %s, want 400 %q", tc.body, rec.Code, rec.Body, tc.want)
		}
	}
	if rec := f.human("POST", "/api/types/reviewer-opus", `{"harness":"claude"}`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "reviewer-opus is the fallback of reviewer") {
		t.Errorf("dropping a fallback's review: %d %s", rec.Code, rec.Body)
	}
	if rec := f.human("POST", "/api/types/Bad", `{"harness":"claude"}`); rec.Code != 400 {
		t.Errorf("a bad name: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{method: "POST", path: "/api/types/tester", token: agentTok, body: `{"harness":"claude"}`}); rec.Code != 403 {
		t.Errorf("an agent saved a type: %d %s", rec.Code, rec.Body)
	}
	if readFile(t, regPath) != saved {
		t.Fatalf("a refused save wrote registry.json: %s", readFile(t, regPath))
	}
	// A type's instructions, then its removal with them.
	if rec := f.human("POST", "/api/templates/type-tester", `{"text":"TESTER RULES"}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"overridden":true`) {
		t.Fatalf("the type's template: %d %s", rec.Code, rec.Body)
	}
	if rec := f.human("DELETE", "/api/types/tester", ""); rec.Code != 200 || rec.Body.String() != `{"removed":"tester"}` {
		t.Errorf("remove a user type: %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(filepath.Join(f.home, "templates", "type-tester.md")); err == nil || strings.Contains(readFile(t, regPath), "tester") {
		t.Errorf("the removed type left its file or entry: %s", readFile(t, regPath))
	}
	if rec := f.human("DELETE", "/api/types/advisor", ""); rec.Code != 200 || !strings.Contains(readFile(t, regPath), `"advisor": null`) {
		t.Errorf("mask a shipped type: %d %s %s", rec.Code, rec.Body, readFile(t, regPath))
	}
	for path, code := range map[string]int{"/api/types/reviewer": 409, "/api/types/reviewer-opus": 409, "/api/types/advisor": 404} {
		if rec := f.human("DELETE", path, ""); rec.Code != code {
			t.Errorf("DELETE %s: %d %s, want %d", path, rec.Code, rec.Body, code)
		}
	}
	var reg struct {
		Types           map[string]json.RawMessage
		DefaultReviewer string
		Harnesses       map[string]map[string]any
	}
	rec = f.do(call{path: "/api/registry", token: sharedTok})
	must(t, json.Unmarshal(rec.Body.Bytes(), &reg))
	if _, ok := reg.Types["advisor"]; ok || reg.DefaultReviewer != "reviewer" || reg.Types["manager"] == nil {
		t.Errorf("the registry after the edits: %s", rec.Body)
	}
	if _, ok := reg.Harnesses["claude"]["version"]; !ok {
		t.Errorf("no claude version key: %v", reg.Harnesses["claude"])
	}
}

// TestTemplateRoutes: the list holds every template with its type's instructions; the human saves and resets one, an
// agent may not, and a name that is no template is a 404.
func TestTemplateRoutes(t *testing.T) {
	f := registryFixture(t)
	rec := f.do(call{path: "/api/templates", token: sharedTok})
	var list []struct {
		Name, Text, Default string
		Overridden          bool
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &list))
	names := map[string]bool{}
	for _, l := range list {
		names[l.Name] = true
	}
	if !names["type-manager"] || !names["system-prompt"] || !names["mail-to-human"] {
		t.Fatalf("the template list: %v", names)
	}
	if rec := f.human("POST", "/api/templates/mail-to-human", `{"text":"MINE"}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"text":"MINE","overridden":true`) {
		t.Errorf("save: %d %s", rec.Code, rec.Body)
	}
	if rec := f.human("POST", "/api/templates/mail-to-human", `{"reset":true}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"overridden":false`) {
		t.Errorf("reset: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{method: "POST", path: "/api/templates/mail-to-human", token: agentTok, body: `{"text":"X"}`}); rec.Code != 403 {
		t.Errorf("an agent saved a template: %d", rec.Code)
	}
	if rec := f.human("POST", "/api/templates/no-such", `{"text":"X"}`); rec.Code != 404 {
		t.Errorf("no template: %d %s", rec.Code, rec.Body)
	}
}

// TestConfigFileRoutes: the human reads and writes the registry and the instructions on the home; the chief of staff's
// registry POST is an ask whose approval writes it, and a stale or invalid one doesn't; another agent may only ask
// nothing.
func TestConfigFileRoutes(t *testing.T) {
	f := registryFixture(t)
	if rec := f.do(call{path: "/api/config/registry", token: sharedTok}); rec.Body.String() != `{"text":"{\n  \"presets\": {},\n  \"models\": {},\n  \"harnesses\": {}\n}\n"}` {
		t.Errorf("an absent registry: %s", rec.Body)
	}
	if rec := f.human("POST", "/api/config/instructions", `{"text":"Be kind."}`); rec.Code != 200 || readFile(t, filepath.Join(f.home, "instructions.md")) != "Be kind." {
		t.Errorf("instructions: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/config/instructions", token: agentTok}); rec.Body.String() != `{"text":"Be kind."}` {
		t.Errorf("read instructions: %s", rec.Body)
	}
	if rec := f.human("POST", "/api/config/registry", `{"text":"{ nope"}`); rec.Code != 400 {
		t.Errorf("invalid registry: %d", rec.Code)
	}
	if rec := f.do(call{method: "POST", path: "/api/config/instructions", token: agentTok, body: `{"text":"x"}`}); rec.Code != 403 {
		t.Errorf("an agent wrote the instructions: %d", rec.Code)
	}
	regPath := filepath.Join(f.home, "registry.json")
	if rec := f.do(call{method: "POST", path: "/api/config/registry", token: agentTok, body: `{"text":"[1]"}`}); rec.Code != 400 || !strings.Contains(rec.Body.String(), "must be a JSON object") {
		t.Errorf("an ask with an array: %d %s", rec.Code, rec.Body)
	}
	ask := func(text string) string {
		rec := f.do(call{method: "POST", path: "/api/config/registry", token: agentTok, body: `{"text":` + jsonString(text) + `}`})
		if rec.Code != 202 {
			t.Fatalf("registry ask: %d %s", rec.Code, rec.Body)
		}
		var out struct{ Requested string }
		must(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out.Requested
	}
	id := ask(`{"presets":{"mine":{"harness":"claude"}}}`)
	r, _, err := f.db.PermissionRequestByID(context.Background(), id)
	must(t, err)
	if r.Action != "Change stam registry" || !strings.Contains(r.Details, `+{"presets":{"mine"`) {
		t.Errorf("the ask: %s %s", r.Action, r.Details)
	}
	if _, err := os.Stat(regPath); err == nil {
		t.Fatalf("an ask wrote registry.json")
	}
	if out := answer(t, f, id, true); out["status"] != "approved" || readFile(t, regPath) != `{"presets":{"mine":{"harness":"claude"}}}` {
		t.Errorf("the approval: %v %s", out, readFile(t, regPath))
	}
	// Stale: registry.json changes between the ask and the approval.
	id = ask(`{"presets":{}}`)
	must(t, os.WriteFile(regPath, []byte(`{"models":{}}`), 0o644))
	n := &notices{}
	f.srv.noticeHook = n.add
	if out := answer(t, f, id, true); out["status"] != "denied" || readFile(t, regPath) != `{"models":{}}` {
		t.Errorf("a stale approval: %v %s", out, readFile(t, regPath))
	}
	if got := strings.Join(n.all(), "\n"); !strings.Contains(got, "the registry changed after you asked") {
		t.Errorf("its notice: %q", got)
	}
}

// TestRegistryOnAPeer: a non-home daemon shows the home's cached registry, instructions and type templates, and
// refuses every change to them with a 409 naming the home, writing nothing; its own other templates it changes.
func TestRegistryOnAPeer(t *testing.T) {
	f, _ := peerFixture(t)
	f.srv.tpl.Root = "../../.."
	f.srv.tpl.Machine = "peer-m"
	cache := strings.Replace(peerCache, `{"rev":"r1",`, `{"rev":"r1","registry":{"types":{"tester":{"description":"t","harness":"claude"}}},"instructions":"HOME RULES","templates":{"type-tester":"HOME TESTER"},`, 1)
	must(t, f.srv.settings.WriteSharedCache(cache))
	must(t, os.WriteFile(filepath.Join(f.home, "registry.json"), []byte(`{"types":{"local":{"harness":"claude"}}}`), 0o644))
	rec := f.do(call{path: "/api/config/registry", token: sharedTok})
	if !strings.Contains(rec.Body.String(), `\"tester\"`) || strings.Contains(rec.Body.String(), "local") || !strings.Contains(rec.Body.String(), `"home":"test-machine","stale":true`) {
		t.Errorf("the peer's registry: %s", rec.Body)
	}
	if rec := f.do(call{path: "/api/config/instructions", token: sharedTok}); !strings.Contains(rec.Body.String(), `"text":"HOME RULES"`) {
		t.Errorf("the peer's instructions: %s", rec.Body)
	}
	if rec := f.do(call{path: "/api/registry", token: sharedTok}); !strings.Contains(rec.Body.String(), `"tester":{`) || strings.Contains(rec.Body.String(), `"local":{`) {
		t.Errorf("the peer's merged registry: %s", rec.Body)
	}
	if got := f.srv.tpl.GlobalInstructions(); got != "HOME RULES" {
		t.Errorf("the agents' instructions: %q", got)
	}
	if got, err := f.srv.tpl.Template("type-tester", ""); err != nil || got != "HOME TESTER" {
		t.Errorf("the type template: %q %v", got, err)
	}
	before := readFile(t, filepath.Join(f.home, "registry.json"))
	for _, c := range []struct{ method, path, body string }{
		{"POST", "/api/types/tester", `{"harness":"claude"}`},
		{"DELETE", "/api/types/tester", ""},
		{"POST", "/api/config/registry", `{"text":"{}"}`},
		{"POST", "/api/config/instructions", `{"text":"x"}`},
		{"POST", "/api/templates/type-tester", `{"text":"x"}`},
		{"POST", "/api/templates/type-tester", `{"reset":true}`},
	} {
		if rec := f.human(c.method, c.path, c.body); !refusedForHome(t, rec) {
			t.Errorf("%s %s on a peer: %d %s", c.method, c.path, rec.Code, rec.Body)
		}
	}
	if rec := f.do(call{method: "POST", path: "/api/config/registry", token: agentTok, body: `{"text":"{}"}`}); !refusedForHome(t, rec) {
		t.Errorf("the chief of staff's registry ask on a peer: %d %s", rec.Code, rec.Body)
	}
	if readFile(t, filepath.Join(f.home, "registry.json")) != before {
		t.Errorf("a refused change wrote registry.json")
	}
	if _, err := os.Stat(filepath.Join(f.home, "instructions.md")); err == nil {
		t.Errorf("a refused change wrote instructions.md")
	}
	if rec := f.human("POST", "/api/templates/mail-to-human", `{"text":"local"}`); rec.Code != 200 {
		t.Errorf("a machine's own template: %d %s", rec.Code, rec.Body)
	}
}

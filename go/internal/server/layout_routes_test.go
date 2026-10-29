package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/jsjson"
	"stam/internal/layout"
)

// layoutOf decodes a layout answer, or the layout a 409 carries.
func layoutOf(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("not JSON: %s", body)
	}
	if l, ok := v["layout"].(map[string]any); ok {
		return l
	}
	return v
}

const emptyPut = `{"layout":{"version":0,"current":"a1","agentWorlds":{"a1":{"root":{"id":"r1","tabs":["agent:a1"],"active":"agent:a1"},"focused":"r1"}},"worlds":{}}}`

// TestLayoutRoutes: anyone with a token reads the layout; PUT replaces an empty one, once, for the human only; ops apply
// all or none for the human or an agent, a stale base is a 409 carrying the layout, bad fields are 400s,
// a batch applies once, and an agent's change is logged as its event.
func TestLayoutRoutes(t *testing.T) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	human := map[string]string{"X-Stam-Human": "1"}
	status := func(c call, want int, what string) []byte {
		t.Helper()
		rec := f.do(c)
		if rec.Code != want {
			t.Fatalf("%s: %d, want %d: %s", what, rec.Code, want, rec.Body)
		}
		return rec.Body.Bytes()
	}

	got := status(call{path: "/api/layout", token: agentTok}, 200, "an agent's GET")
	if string(got) != `{"version":0,"current":null,"agentWorlds":{},"worlds":{}}` {
		t.Errorf("a fresh layout is %s", got)
	}

	status(call{method: "PUT", path: "/api/layout", token: sharedTok, body: emptyPut}, 403, "PUT without x-stam-human")
	status(call{method: "PUT", path: "/api/layout", token: agentTok, header: human, body: emptyPut}, 403, "an agent's PUT")
	status(call{method: "PUT", path: "/api/layout", token: sharedTok, header: human, body: `{"layout":{"version":0}}`}, 400, "PUT of a non-layout")
	l := layoutOf(t, status(call{method: "PUT", path: "/api/layout", token: sharedTok, header: human, body: emptyPut}, 200, "the human's PUT"))
	if l["version"] != 1.0 || l["current"] != "a1" {
		t.Errorf("PUT gave %v", l)
	}
	if l := layoutOf(t, status(call{method: "PUT", path: "/api/layout", token: sharedTok, header: human, body: emptyPut}, 409, "a second PUT")); l["version"] != 1.0 {
		t.Errorf("a refused PUT carried %v", l)
	}

	ops := `{"ops":[{"op":"open","world":"main","key":"agent:b1"},{"op":"open","world":"main","key":"agent:b2","pane":"r1","split":"right"}]}`
	status(call{method: "POST", path: "/api/layout/ops", token: sharedTok, body: ops}, 403, "ops with no human and no by")
	status(call{method: "POST", path: "/api/layout/ops", token: agentTok, body: `{"by":"aboss","ops":[]}`}, 403, "an agent naming another")
	if l := layoutOf(t, status(call{method: "POST", path: "/api/layout/ops", token: sharedTok, header: human, body: ops}, 200, "the human's ops")); l["version"] != 2.0 {
		t.Errorf("ops gave version %v", l["version"])
	}
	if l := layoutOf(t, status(call{method: "POST", path: "/api/layout/ops", token: sharedTok, header: human, body: `{"base":1,"ops":[{"op":"focus","world":"main","pane":"r1"}]}`}, 409, "a stale base")); l["version"] != 2.0 {
		t.Errorf("a stale base's 409 carried %v", l)
	}
	for _, c := range []struct{ body, want string }{
		{`{"ops":{}}`, "ops must be a list of layout ops"},
		{`{"base":1.5,"ops":[]}`, "base must be a layout version"},
		{`{"base":null,"ops":[]}`, "base must be a layout version"},
		{`{"batch":3,"ops":[]}`, "batch must be a short string"},
		{`{"batch":"` + strings.Repeat("x", 65) + `","ops":[]}`, "batch must be a short string"},
		{`{"ops":[{"op":"open","world":"main","key":"agent:c"},{"op":"close","world":"main","key":"nope"}]}`, "no tab nope in world main"},
		{`{"ops":[{"op":"resize","world":"main","split":"n0","sizes":[1,1]}]}`, "no split n0 in world main"},
	} {
		body := status(call{method: "POST", path: "/api/layout/ops", token: sharedTok, header: human, body: c.body}, 400, c.body)
		if !strings.Contains(string(body), c.want) {
			t.Errorf("%s: %s, want %q", c.body, body, c.want)
		}
	}
	// A tree a setRoot would leave malformed is refused whole.
	status(call{method: "POST", path: "/api/layout/ops", token: sharedTok, header: human, body: `{"ops":[{"op":"setRoot","world":"main","root":{"id":"r","split":"row","children":[{"id":"x","tabs":[],"active":null}],"sizes":[0]}}]}`}, 400, "a bad tree")
	if l := layoutOf(t, status(call{path: "/api/layout", token: sharedTok}, 200, "GET")); l["version"] != 2.0 || strings.Contains(mustJSON(t, l), "agent:c") {
		t.Errorf("a refused batch changed the layout: %v", l)
	}

	batch := `{"batch":"bt1","ops":[{"op":"open","world":"main","key":"agent:d","pane":"r1","split":"down","ids":["pd","sd"]}]}`
	status(call{method: "POST", path: "/api/layout/ops", token: sharedTok, header: human, body: batch}, 200, "a batch")
	again := layoutOf(t, status(call{method: "POST", path: "/api/layout/ops", token: sharedTok, header: human, body: batch}, 200, "the batch again"))
	if again["version"] != 3.0 || strings.Count(mustJSON(t, again), `"pd"`) != 2 {
		t.Errorf("a repeated batch applied again: %v", again)
	}

	// An agent's own token acts as that agent, with by or without it (resolveBody names it).
	if l := layoutOf(t, status(call{method: "POST", path: "/api/layout/ops", token: agentTok, body: `{"ops":[{"op":"focus","world":"main","pane":"r1"}]}`}, 200, "an agent's ops")); l["version"] != 4.0 {
		t.Errorf("an agent's ops gave version %v", l["version"])
	}
	if ev := f.lastEvent("achild", "layout"); ev != `{"summary":"focus pane r1 in main"}` {
		t.Errorf("the agent's change was logged as %q", ev)
	}
	status(call{method: "PUT", path: "/api/layout", token: agentTok, body: `{"by":"achild","layout":{"version":0,"current":null,"agentWorlds":{},"worlds":{}}}`}, 403, "an agent's PUT with by")

	// The file is the layout, and a new store over the home serves the same.
	b, err := os.ReadFile(filepath.Join(f.home, "layout.json"))
	must(t, err)
	if want := status(call{path: "/api/layout", token: sharedTok}, 200, "GET"); mustCompact(t, b) != string(want) {
		t.Errorf("layout.json is %s, GET %s", b, want)
	}
	if reopened := jsjson.Stringify(layout.Open(f.home).Get(), ""); reopened != string(status(call{path: "/api/layout", token: sharedTok}, 200, "GET")) {
		t.Errorf("a reopened store has %v", reopened)
	}
}

// With auth.humanStrict the shared token with x-stam-human is no longer the human: it neither arranges nor replaces
// the layout. The human's own proof still does.
func TestLayoutStrict(t *testing.T) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"auth":{"humanStrict":true}}`), 0o600))
	cli := map[string]string{"X-Stam-Human": "1"}
	ops := `{"ops":[{"op":"open","world":"main","key":"agent:b1"}]}`
	if rec := f.do(call{method: "POST", path: "/api/layout/ops", token: sharedTok, header: cli, body: ops}); rec.Code != http.StatusForbidden {
		t.Errorf("the shared token's ops under strict: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{method: "PUT", path: "/api/layout", token: sharedTok, header: cli, body: emptyPut}); rec.Code != http.StatusForbidden {
		t.Errorf("the shared token's PUT under strict: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{method: "POST", path: "/api/layout/ops", token: sharedTok, header: trusted, body: ops}); rec.Code != http.StatusOK {
		t.Errorf("the human's ops under strict: %d %s", rec.Code, rec.Body)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	must(t, err)
	return string(b)
}

// mustCompact is a layout file's JSON without its indent, as the routes send it.
func mustCompact(t *testing.T, b []byte) string {
	t.Helper()
	v, err := jsjson.Parse(b)
	must(t, err)
	return jsjson.Stringify(v, "")
}

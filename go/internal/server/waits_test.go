package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestWaitsAuth: an agent manages its own waits and its children's (an agent's token names it as by); nobody else's. The
// human (no by) manages any; with humanStrict on, a shared token naming no one doesn't.
func TestWaitsAuth(t *testing.T) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	withLife(f)
	f.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT 'bother', 'other', role, machine, harness, cwd, lifecycle, activity, created_at, updated_at FROM agents WHERE id = 'aboss'")
	human := map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1"}
	add := func(token, agent, by string, header ...map[string]string) (int, string) {
		t.Helper()
		body := `{"kind":"timer","detail":"t"`
		if by != "" {
			body += `,"by":"` + by + `"`
		}
		c := call{method: "POST", path: "/api/agents/" + agent + "/waits", token: token, body: body + "}"}
		if len(header) > 0 {
			c.header = header[0]
		}
		rec := f.do(c)
		return rec.Code, rec.Body.String()
	}
	for _, tc := range []struct {
		name, token, agent, by string
		status                 int
		error                  string
	}{
		{"its own", agentTok, "achild", "achild", 200, ""},
		{"a parent for its child", bossTok, "achild", "aboss", 200, ""},
		{"the human", sharedTok, "aboss", "", 200, ""},
		{"an agent no by", agentTok, "achild", "", 200, ""},
		{"a second parent for its child", sharedTok, "achild", "acodex", 200, ""},
		{"a child for its parent", sharedTok, "aboss", "acodex", 403, "acodex may manage only its own waits or its children's"},
		{"an agent not a parent", sharedTok, "achild", "bother", 403, "bother may manage only its own waits or its children's"},
		{"an agent at another's path", agentTok, "aboss", "achild", 403, "can't act as aboss"},
		{"an agent as another", agentTok, "achild", "aboss", 403, "can't act as aboss"},
		{"an unknown agent", sharedTok, "anone", "", 404, "no agent anone"},
	} {
		if code, body := add(tc.token, tc.agent, tc.by); code != tc.status || !strings.Contains(body, tc.error) {
			t.Errorf("%s: %d %s", tc.name, code, body)
		}
	}
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"auth":{"humanStrict":true}}`), 0o600))
	if code, body := add(sharedTok, "achild", ""); code != 403 || !strings.Contains(body, "only the human, or an agent naming itself (by), manages waits") {
		t.Errorf("strict, a token naming no one: %d %s", code, body)
	}
	if code, body := add("", "achild", "", human); code != 200 {
		t.Errorf("strict, the human: %d %s", code, body)
	}
	if code, body := add(agentTok, "achild", ""); code != 200 {
		t.Errorf("strict, an agent's own token: %d %s", code, body)
	}
}

// TestWaitsRefusals: a bad request answers 400 with TS's text and writes nothing.
func TestWaitsRefusals(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('apeer', 'remote-one', 'elsewhere', '2026-10-01T00:00:00.000Z')")
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'idle' WHERE id = 'achild'")
	f.sql("INSERT INTO permission_requests (id, agent_id, action, reason, details, status, audience, created_at) VALUES ('pabc123', 'achild', 'a', 'r', 'd', 'denied', 'human', '2026-10-21T00:00:00.000Z')")
	writes := func() int {
		return f.count("SELECT count(*) FROM waits") + f.count("SELECT count(*) FROM events WHERE type LIKE 'wait:%'") + f.count("SELECT count(*) FROM wait_nudges")
	}
	for _, tc := range []struct {
		path, body string
		status     int
		error      string
	}{
		{"declared", `{"on":"event","by":"achild"}`, 400, "wait_for on 'event' needs a filter"},
		// Met before on a peer, with no peer to ask now: no agent, as TS's peerTarget answers.
		{"declared", `{"on":"agent","target":"apeer","by":"achild"}`, 400, "no agent apeer"},
		{"declared", `{"on":"agent","target":"remote-one","by":"achild"}`, 400, "no agent remote-one"},
		{"declared", `{"on":"mail","by":"achild"}`, 400, "on must be 'agent', 'human', or 'event'"},
		{"declared", `{"on":"agent","by":"achild"}`, 400, "wait_for on 'agent' needs target (an agent id or name)"},
		{"declared", `{"on":"agent","target":"nobody","by":"achild"}`, 400, "no agent nobody"},
		{"declared", `{"on":"agent","target":"agone","by":"achild"}`, 400, "no agent agone (archived)"},
		{"declared", `{"on":"human","timeout_minutes":0,"by":"achild"}`, 400, "timeout_minutes must be positive"},
		{"declared", `{"on":"human","expect_minutes":"x","by":"achild"}`, 400, "expect_minutes must be positive"},
		{"declared", `{"on":"human","note":"see pabc123","by":"achild"}`, 400, "request pabc123 is already denied"},
		{"wake", `{"in_minutes":5,"by":"achild"}`, 400, "wake_me needs a note"},
		{"wake", `{"note":"n","in_minutes":5,"cron":"* * * * *","by":"achild"}`, 400, "wake_me needs exactly one of in_minutes, at, cron, every_minutes"},
		{"wake", `{"note":"n","every_minutes":-1,"by":"achild"}`, 400, "every_minutes must be positive"},
		{"wake", `{"note":"n","at":"tomorrow","by":"achild"}`, 400, `at must be an ISO time, got \"tomorrow\"`},
		{"wake", `{"note":"n","cron":"61 * * * *","by":"achild"}`, 400, "cron minute out of range"},
		{"", `{"by":"achild"}`, 400, "a wait needs a kind"},
		{"", `{"kind":"x","source":"tmux","by":"achild"}`, 400, "source must be 'stam', 'hook', or 'declared'"},
		{"clear", `{"by":"achild"}`, 400, "clear a wait by id, or by kind and target"},
	} {
		path := "/api/agents/achild/waits"
		if tc.path != "" {
			path += "/" + tc.path
		}
		rec := f.do(call{method: "POST", path: path, token: agentTok, body: tc.body})
		if rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.error) {
			t.Errorf("%s %s: %d %s", tc.path, tc.body, rec.Code, rec.Body.String())
		}
		if n := writes(); n != 0 {
			t.Fatalf("%s %s wrote %d rows", tc.path, tc.body, n)
		}
	}
}

// TestWaitsRoutes: wait_for, wake_me and wait_done through the routes; GET waits and the agent listings show each wait
// with its mail thread resolved; wait_done clears only the agent's declared waits and timers, clear by id or by kind.
func TestWaitsRoutes(t *testing.T) {
	f := newFixture(t, nil)
	withLifeRoot(f, "../../..")
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'idle' WHERE id IN ('achild', 'aboss')")
	f.sql("INSERT INTO mail (id, from_id, subject, body, thread_id, created_at) VALUES ('m9', 'aboss', 's', 'b', 'm1', '2026-10-21T00:00:00.000Z')")
	post := func(path, body string) map[string]any {
		t.Helper()
		rec := f.do(call{method: "POST", path: "/api/agents/achild/waits" + path, token: agentTok, body: body})
		if rec.Code != 200 {
			t.Fatalf("%s %s: %d %s", path, body, rec.Code, rec.Body.String())
		}
		var out map[string]any
		must(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}
	declared := post("/declared", `{"on":"agent","target":"boss","thread":"m9","note":"the plan","by":"achild"}`)
	if declared["kind"] != "agent" || declared["target"] != "aboss" || declared["detail"] != "the plan" || declared["source"] != "declared" {
		t.Errorf("declared: %v", declared)
	}
	timer := post("/wake", `{"note":"look again","every_minutes":10,"by":"achild"}`)
	hook := post("", `{"kind":"job","source":"hook","target":"b1","by":"achild"}`)

	rec := f.do(call{path: "/api/agents/achild/waits", token: sharedTok})
	var got []map[string]any
	must(t, json.Unmarshal(rec.Body.Bytes(), &got))
	threads := map[any]any{}
	for _, w := range got {
		threads[w["id"]] = w["thread"]
	}
	if len(got) != 3 || threads[declared["id"]] != "m1" || threads[timer["id"]] != nil {
		t.Errorf("GET waits: %s", rec.Body.String())
	}
	if a := f.agent(t, "achild"); a["activity"] != "waiting" {
		t.Errorf("the waiter: %v %v", a["activity"], a["activity_detail"])
	}
	rec = f.do(call{path: "/api/agents", token: sharedTok})
	if !strings.Contains(rec.Body.String(), `"thread":"m1"`) {
		t.Errorf("listing waits: %s", rec.Body.String())
	}

	if out := post("/done", `{"id":"`+hook["id"].(string)+`","by":"achild"}`); out["cleared"] != false {
		t.Errorf("done on a hook wait: %v", out)
	}
	if out := post("/done", `{"id":"`+timer["id"].(string)+`","by":"achild"}`); out["cleared"] != true {
		t.Errorf("done on a timer: %v", out)
	}
	if out := post("/clear", `{"id":5,"by":"achild"}`); out["cleared"] != float64(0) {
		t.Errorf("clear by a number id: %v", out)
	}
	if out := post("/clear", `{"kind":"job","target":"b1","by":"achild"}`); out["cleared"] != float64(1) {
		t.Errorf("clear by kind: %v", out)
	}
	if out := post("/clear", `{"id":"`+declared["id"].(string)+`","by":"achild"}`); out["cleared"] != float64(1) {
		t.Errorf("clear by id: %v", out)
	}
	if a := f.agent(t, "achild"); a["activity"] != "idle" || a["activity_detail"] != "waits cleared" {
		t.Errorf("after the clears: %v %v", a["activity"], a["activity_detail"])
	}
}

// agent is GET /api/agents/:id's agent.
func (f *fixture) agent(t *testing.T, id string) map[string]any {
	t.Helper()
	rec := f.do(call{path: "/api/agents/" + id, token: sharedTok})
	var out map[string]any
	must(t, json.Unmarshal(rec.Body.Bytes(), &out))
	if a, ok := out["agent"].(map[string]any); ok {
		return a
	}
	return out
}

// TestParseAt: the forms parseAt documents, and some it refuses.
func TestParseAt(t *testing.T) {
	local := time.Date(2026, 10, 21, 14, 30, 0, 0, time.Local)
	for in, want := range map[string]time.Time{
		"2026-10-21T14:30:00Z":           time.Date(2026, 10, 21, 14, 30, 0, 0, time.UTC),
		" 2026-10-21T14:30:00.123+02:00": time.Date(2026, 10, 21, 12, 30, 0, 123e6, time.UTC),
		"2026-10-21T14:30Z":              time.Date(2026, 10, 21, 14, 30, 0, 0, time.UTC),
		"2026-10-21T14:30:00":            local,
		"2026-10-21T14:30:00.5":          local.Add(500 * time.Millisecond),
		"2026-10-21T14:30":               local,
		"2026-10-21":                     time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC),
	} {
		if got, ok := parseAt(in); !ok || !got.Equal(want) {
			t.Errorf("%q: %v %v, want %v", in, got, ok, want)
		}
	}
	for _, in := range []string{"2026-10-21 14:30", "Oct 21 2026", "2026", "tomorrow", ""} {
		if got, ok := parseAt(in); ok {
			t.Errorf("%q parsed as %v", in, got)
		}
	}
}

// TestRestRequest: `rest: true` on wait_for or wake_me asks for a rest on the wait it made (S-4332), as data.rest with the
// until it was asked with, and a standing:rest-requested event; the answer is the wait as made, without the flag, as TS
// answers. An agent type rest.types keeps up (the chief of staff, `cos`) asks for nothing.
func TestRestRequest(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'idle' WHERE id = 'achild'")
	for _, tc := range []struct{ path, body string }{
		{"declared", `{"on":"human","timeout_minutes":30,"rest":true,"by":"achild"}`},
		{"wake", `{"note":"n","in_minutes":5,"rest":true,"by":"achild"}`},
	} {
		rec := f.do(call{method: "POST", path: "/api/agents/achild/waits/" + tc.path, token: agentTok, body: tc.body})
		if rec.Code != 200 || strings.Contains(rec.Body.String(), `rest`) {
			t.Fatalf("%s: %d %s", tc.path, rec.Code, rec.Body.String())
		}
	}
	if n := f.count(`SELECT count(*) FROM waits WHERE agent_id = 'achild' AND json_extract(data, '$.rest') = 1 AND json_extract(data, '$.rest_until') = until`); n != 2 {
		t.Errorf("waits asking for a rest: %d", n)
	}
	if n := f.count("SELECT count(*) FROM events WHERE agent_id = 'achild' AND type = 'standing:rest-requested'"); n != 2 {
		t.Errorf("rest-requested events: %d", n)
	}
	// Without rest, or rest not exactly true, nothing is asked.
	f.do(call{method: "POST", path: "/api/agents/achild/waits/wake", token: agentTok, body: `{"note":"m","in_minutes":5,"rest":"yes","by":"achild"}`})
	if n := f.count(`SELECT count(*) FROM waits WHERE agent_id = 'achild' AND json_extract(data, '$.rest') IS NULL`); n != 1 {
		t.Errorf("a wait without a rest request: %d", n)
	}
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"chiefOfStaff":"achild"}`), 0o600))
	f.sql("DELETE FROM waits")
	if rec := f.do(call{method: "POST", path: "/api/agents/achild/waits/declared", token: agentTok, body: `{"on":"human","rest":true,"by":"achild"}`}); rec.Code != 200 {
		t.Fatalf("the chief of staff's wait: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count(`SELECT count(*) FROM waits WHERE json_extract(data, '$.rest') = 1`); n != 0 {
		t.Errorf("the chief of staff asked for a rest: %d", n)
	}
}

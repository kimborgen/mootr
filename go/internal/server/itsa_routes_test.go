package server

import (
	"net/http/httptest"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

func (f *fixture) body(rec *httptest.ResponseRecorder) jsfmt.Value {
	f.t.Helper()
	v, err := jsfmt.Parse(rec.Body.Bytes())
	must(f.t, err)
	return v
}

// create makes an ITSA as the human and returns its key.
func (f *fixture) createItsa(body string) string {
	f.t.Helper()
	rec := f.post2("POST", "/api/itsas", body)
	if rec.Code != 200 {
		f.t.Fatalf("create %s: %d %s", body, rec.Code, rec.Body.String())
	}
	return f.body(rec).Text("key")
}

func TestItsaStatusesRoute(t *testing.T) {
	f := newFixture(t, nil)
	rec := f.post2("GET", "/api/itsas/statuses", "")
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	got := rec.Body.String()
	if !strings.HasPrefix(got, `{"categories":["backlog","ready","active","review","closed"],"statuses":[{"name":"idea","category":"backlog","human":false},`) ||
		!strings.Contains(got, `{"name":"needs_input","category":"active","human":true}`) || !strings.HasSuffix(got, `{"name":"wont_do","category":"closed","human":false}]}`) {
		t.Errorf("statuses: %s", got)
	}
}

// ?q= is the text filter's other name, and `text` wins when both are given.
func TestItsaListQuery(t *testing.T) {
	f := newFixture(t, nil)
	f.createItsa(`{"title":"alpha one"}`)
	f.createItsa(`{"title":"beta two","summary":"alpha in the summary"}`)
	for q, n := range map[string]int{"?q=alpha": 2, "?text=beta": 1, "?text=beta&q=alpha": 1, "?q=%20": 2, "": 2} {
		rec := f.post2("GET", "/api/itsas"+q, "")
		if got := f.body(rec); len(got.Items) != n {
			t.Errorf("%q: %d ITSAs, want %d: %s", q, len(got.Items), n, rec.Body.String())
		}
	}
	if rec := f.post2("GET", "/api/itsas?category=closed", ""); rec.Body.String() != "[]" {
		t.Errorf("an empty list: %s", rec.Body.String())
	}
}

// ?since= filters on created_at by an age or an ISO time, and a bad one is a 400, not an empty list (S-1396).
func TestItsaListSince(t *testing.T) {
	f := newFixture(t, nil)
	f.createItsa(`{"title":"fresh one"}`)
	old := f.createItsa(`{"title":"old one"}`)
	f.sql("UPDATE itsas SET created_at = '2020-01-02T03:04:05.000Z' WHERE key = ?", old)
	for q, n := range map[string]int{
		"?since=24h":                         1,
		"?since=2d":                          1,
		"?since=2020-01-02T03:04:05Z":        2,
		"?since=2020-01-02T03:04:06Z":        1,
		"?since=2019-12-31":                  2,
		"?since=2020-01-02T04:04:05%2B01:00": 2,
	} {
		rec := f.post2("GET", "/api/itsas"+q, "")
		if got := f.body(rec); rec.Code != 200 || len(got.Items) != n {
			t.Errorf("%s: %d %d ITSAs, want %d: %s", q, rec.Code, len(got.Items), n, rec.Body.String())
		}
	}
	for _, bad := range []string{"", "yesterday", "24", "2026-02-30", "2026-10-21T08:00:00"} {
		if rec := f.post2("GET", "/api/itsas?since="+bad, ""); rec.Code != 400 || !strings.Contains(rec.Body.String(), "since expects an ISO time") {
			t.Errorf("since=%q: %d %s, want a 400", bad, rec.Code, rec.Body.String())
		}
	}
}

// Who an ITSA request acts as (src/daemon.ts itsaActor).
func TestItsaActor(t *testing.T) {
	f := newFixture(t, nil)
	for _, tc := range []struct {
		name, method, path, token string
		header                    map[string]string
		body                      string
		status                    int
		error                     string
	}{
		{"no by from the shared token", "POST", "/api/itsas", sharedTok, nil, `{"title":"x"}`, 403, "an ITSA action needs an agent (by) or the human"},
		{"by the human, not a human request", "POST", "/api/itsas", sharedTok, nil, `{"title":"x","by":"human"}`, 403, "only your user acts as the human on an ITSA"},
		{"by the human by another name", "POST", "/api/itsas", sharedTok, nil, `{"title":"x","by":"The Human"}`, 403, "only your user acts as the human on an ITSA"},
		{"by a system sender", "POST", "/api/itsas", sharedTok, human, `{"title":"x","by":"system:deploy-watch"}`, 403, "a system sender is named with system, not by"},
		{"as_system from the shared token", "POST", "/api/itsas", sharedTok, nil, `{"title":"x","as_system":"somebody"}`, 403, "only the human sends an ITSA action as a system sender"},
		{"a bad as_system", "POST", "/api/itsas", sharedTok, human, `{"title":"x","as_system":"Bad Name"}`, 400, "bad system sender Bad Name"},
		{"a blank by", "POST", "/api/itsas", sharedTok, nil, `{"title":"x","by":"  "}`, 403, "an ITSA action needs an agent (by) or the human"},
		{"an agent naming another", "POST", "/api/itsas", agentTok, nil, `{"title":"x","by":"boss"}`, 403, "agent child can't act as boss"},
		{"an agent starting a thread", "POST", "/api/itsas", agentTok, nil, `{"title":"x","thread_id":"m1"}`, 403, "thread_id is set only by stam"},
		{"the OpenCode server naming no one", "POST", "/api/itsas", serverTok, nil, `{"title":"x"}`, 403, "the OpenCode server's request must name its agent (by, from, or self)"},
		{"a bad id in the path", "GET", "/api/itsas/a.b", sharedTok, nil, "", 404, "no route GET /api/itsas/a.b"},
		{"an unknown ITSA", "GET", "/api/itsas/zzzz", sharedTok, nil, "", 404, "no ITSA zzzz"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := f.sendH(tc.method, tc.path, tc.token, tc.header, tc.body)
			if rec.Code != tc.status || errorOf(t, rec) != tc.error {
				t.Errorf("%d %s", rec.Code, rec.Body.String())
			}
		})
	}
	// An agent acts as itself: with no `by`, the ITSA is created by it.
	rec := f.sendH("POST", "/api/itsas", agentTok, nil, `{"title":"mine"}`)
	if rec.Code != 200 || f.body(rec).Text("created_by") != "achild" {
		t.Errorf("an agent's create: %d %s", rec.Code, rec.Body.String())
	}
	// The shared token as one of the allowed scripts sends an ITSA action as a system sender.
	key := f.createItsa(`{"title":"watched"}`)
	rec = f.sendH("PATCH", "/api/itsas/"+key, sharedTok, nil, `{"as_system":"deploy-watch","status":"merging"}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"status":"merging"`) {
		t.Errorf("deploy-watch: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT COUNT(*) FROM itsa_events WHERE actor = 'system:deploy-watch' AND type = 'status'"); n != 1 {
		t.Errorf("the status event is by the script: %d", n)
	}
}

// What an agent may change: an ITSA it belongs to; only the chief of staff or the human marks an incident or turns an ITSA
// into a retro item (S-480, S-2406).
func TestItsaAgentRules(t *testing.T) {
	f := newFixture(t, nil)
	key := f.createItsa(`{"title":"theirs","owner":"boss"}`)
	rec := f.sendH("PATCH", "/api/itsas/"+key, agentTok, nil, `{"title":"mine now"}`)
	if rec.Code != 403 || !strings.Contains(errorOf(t, rec), "child can't change "+key+": only its owner and participants") || !strings.Contains(errorOf(t, rec), "(boss)") {
		t.Errorf("an agent outside the ITSA: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("INSERT INTO itsa_participants (itsa_id, agent_id) SELECT id, 'achild' FROM itsas WHERE key = ?", key)
	if rec := f.sendH("PATCH", "/api/itsas/"+key, agentTok, nil, `{"title":"mine now"}`); rec.Code != 200 {
		t.Errorf("a participant: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("PATCH", "/api/itsas/"+key, agentTok, nil, `{"incident":true}`); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "marks an ITSA as an incident") {
		t.Errorf("an incident by an agent: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("PATCH", "/api/itsas/"+key, agentTok, nil, `{"kind":"retro"}`); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "retro item or feedback report") {
		t.Errorf("a retro kind by an agent: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"incident":true}`); rec.Code != 200 {
		t.Errorf("an incident by the human: %d %s", rec.Code, rec.Body.String())
	}
	// A retro item is an open board: a participant of it who is not a member in the stricter sense may not change it.
	f.sql("UPDATE itsas SET kind = 'retro' WHERE key = ?", key)
	f.sql("UPDATE itsas SET owner = 'aboss', created_by = 'aboss' WHERE key = ?", key)
	if rec := f.sendH("PATCH", "/api/itsas/"+key, agentTok, nil, `{"title":"nope"}`); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "only its owner, the owners of its parent ITSAs") {
		t.Errorf("a participant of a retro item: %d %s", rec.Code, rec.Body.String())
	}
}

// What this daemon does not do yet answers 501 and writes nothing.
func TestItsaNotPorted(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET model = 'claude-opus-5-5' WHERE id = 'achild'")
	key := f.createItsa(`{"title":"base","participants":["child"]}`)
	before := f.count("SELECT COUNT(*) FROM itsas")
	for _, tc := range []struct {
		name, method, path, body, token string
		header                          map[string]string
		want                            string
	}{
		{"a proposal", "POST", "/api/itsas", `{"title":"x","kind":"proposal"}`, sharedTok, human, "kind proposal"},
		{"the ask of an agent creating in a human status", "POST", "/api/itsas", `{"title":"x","status":"needs_input"}`, agentTok, nil, "waits on your user"},
		{"an agent moving to a human status", "PATCH", "/api/itsas/" + key, `{"status":"needs_review"}`, agentTok, nil, "comment first"},
		{"the queue route", "GET", "/api/itsas/queue", "", sharedTok, nil, "/api/itsas/queue is not ported"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := f.sendH(tc.method, tc.path, tc.token, tc.header, tc.body)
			if tc.name == "an agent moving to a human status" {
				// The comment-first rule answers before the ask does; the ask is 501 once a comment exists.
				if rec.Code != 400 {
					t.Fatalf("%d %s", rec.Code, rec.Body.String())
				}
				return
			}
			if rec.Code != 501 || !strings.Contains(errorOf(t, rec), tc.want) {
				t.Errorf("%d %s, want 501 naming %q", rec.Code, rec.Body.String(), tc.want)
			}
		})
	}
	if n := f.count("SELECT COUNT(*) FROM itsas"); n != before {
		t.Errorf("a 501 wrote %d ITSAs", n-before)
	}
	// An agent that has commented moves it to a human status: the ask mail is sent (itsa_ask_test.go compares it with TS).
	f.sql("UPDATE itsas SET thread_id = 'th1' WHERE key = ?", key)
	f.sql("INSERT INTO mail (id, from_id, subject, body, created_at, thread_id, kind) VALUES ('mc1', 'achild', 's', 'did x', '2999-01-01T00:00:00.000Z', 'th1', 'comment')")
	rec := f.sendH("PATCH", "/api/itsas/"+key, agentTok, nil, `{"status":"needs_review"}`)
	if rec.Code != 200 {
		t.Errorf("a commented move: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE kind = 'ask'"); n != 1 {
		t.Errorf("%d ask mails after the agent's move", n)
	}
	// The human's own move into a human status asks nothing of anyone.
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"needs_test"}`); rec.Code != 200 {
		t.Errorf("the human's move: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE kind = 'ask'"); n != 1 {
		t.Errorf("%d ask mails after the human's move", n)
	}
	// With a stage field defined, a close sets it from the process; no process applies to this ITSA, so nothing is set.
	f.sql("INSERT INTO itsa_fields (id, key, label, type, width, align, card, position, created_by, created_at, updated_at) VALUES ('fstage', 'stage', 'Stage', 'text', 'm', 'start', 'chip', 0, 'human', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')")
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"done"}`); rec.Code != 200 || f.count("SELECT COUNT(*) FROM itsa_field_values") != 0 {
		t.Errorf("a close with a stage field and no process: %d %s", rec.Code, rec.Body.String())
	}
}

// A daemon that is not the ITSA home proxies the request (itsa_proxy_test.go); with no such peer it says so.
func TestItsaNotHome(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, f.home+"/settings.json", `{"itsa":{"home":"elsewhere"}}`)
	for _, p := range []string{"/api/itsas", "/api/itsas/statuses", "/api/itsas/S-1"} {
		if rec := f.post2("GET", p, ""); rec.Code != 503 || !strings.Contains(errorOf(t, rec), "ITSA home 'elsewhere' is not a configured peer") {
			t.Errorf("%s: %d %s", p, rec.Code, rec.Body.String())
		}
	}
	if rec := f.post2("POST", "/api/itsas/S-1/post", `{"body":"x"}`); rec.Code != 503 || !strings.Contains(errorOf(t, rec), "ITSA home 'elsewhere' is not a configured peer") {
		t.Errorf("post: %d %s", rec.Code, rec.Body.String())
	}
}

// Links through an agent's token: it must belong to the ITSA, and a branch link needs the worktree check TS runs.
func TestItsaLinkRules(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, f.home+"/settings.json", `{"itsa":{"repos":{"r1":"/tmp"}}}`)
	key := f.createItsa(`{"title":"linked","owner":"boss"}`)
	rec := f.sendH("POST", "/api/itsas/"+key+"/links", agentTok, nil, `{"url":"https://example.com"}`)
	if rec.Code != 403 || !strings.Contains(errorOf(t, rec), "child can't change "+key) {
		t.Errorf("a stranger's link: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("INSERT INTO itsa_participants (itsa_id, agent_id) SELECT id, 'achild' FROM itsas WHERE key = ?", key)
	if rec := f.sendH("POST", "/api/itsas/"+key+"/links", agentTok, nil, `{"url":"https://example.com"}`); rec.Code != 200 {
		t.Errorf("a participant's link: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("POST", "/api/itsas/"+key+"/links", agentTok, nil, `{"system":"branch","external_id":"b","repo":"r1"}`); rec.Code != 501 || !strings.Contains(errorOf(t, rec), "worktrees") {
		t.Errorf("an agent's branch link: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("POST", "/api/itsas/"+key+"/links", `{"system":"branch","external_id":"b","repo":"unlisted"}`); rec.Code != 400 || !strings.Contains(errorOf(t, rec), "unknown repo unlisted: add it to settings.itsa.repos") {
		t.Errorf("a repo nothing lists: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("DELETE", "/api/itsas/"+key+"/links/x", ""); rec.Code != 404 || !strings.Contains(errorOf(t, rec), "no route") {
		t.Errorf("a link path that is no number: %d %s", rec.Code, rec.Body.String())
	}
}

const (
	answersBody = "Fix.\n  Answers: S-1, S-2\n"
	memoryBody  = "diff --git a/blocks/type-developer/99-memory.md b/blocks/type-developer/99-memory.md\n+x\n"
)

// The retro gate and closeAnswered are not ported: a write they would act on answers 501 and changes nothing.
func TestItsaRetroGate(t *testing.T) {
	f := newFixture(t, nil)
	key := f.createItsa(`{"title":"base","participants":["child"]}`)
	body := func(s string) string { return `{"body":` + jsfmt.Compact(jsfmt.StringValue(s)) + `}` }
	for _, tc := range []struct {
		name, method, path, payload, token string
		header                             map[string]string
		want                               int
		contains                           string
	}{
		{"an agent creating an answer", "POST", "/api/itsas", `{"title":"x","body":` + jsfmt.Compact(jsfmt.StringValue(answersBody)) + `}`, agentTok, nil, 501, "Answers:"},
		{"an agent creating a memory diff", "POST", "/api/itsas", `{"title":"x","body":` + jsfmt.Compact(jsfmt.StringValue(memoryBody)) + `}`, agentTok, nil, 501, "memory block"},
		{"an agent setting an answer", "PATCH", "/api/itsas/" + key, body(answersBody), agentTok, nil, 501, "Answers:"},
		{"an agent setting a memory diff", "PATCH", "/api/itsas/" + key, body(memoryBody), agentTok, nil, 501, "memory block"},
		{"a header after a CR", "PATCH", "/api/itsas/" + key, body("x\r" + memoryBody), agentTok, nil, 501, "memory block"},
		{"an indented Answers line", "PATCH", "/api/itsas/" + key, body("x\n \tAnswers: S-3"), agentTok, nil, 501, "Answers:"},
		{"the human creating one done", "POST", "/api/itsas", `{"title":"x","status":"done","body":` + jsfmt.Compact(jsfmt.StringValue(answersBody)) + `}`, sharedTok, human, 501, "closeAnswered"},
		{"the human creating an answer", "POST", "/api/itsas", `{"title":"x","body":` + jsfmt.Compact(jsfmt.StringValue(answersBody)) + `}`, sharedTok, human, 200, ""},
		{"the human with a memory diff", "POST", "/api/itsas", `{"title":"x","body":` + jsfmt.Compact(jsfmt.StringValue(memoryBody)) + `}`, sharedTok, human, 200, ""},
		{"the human setting an answer", "PATCH", "/api/itsas/" + key, body(answersBody), sharedTok, human, 200, ""},
		{"an agent's title edit on an answer", "PATCH", "/api/itsas/" + key, `{"title":"renamed"}`, agentTok, nil, 200, ""},
		{"an agent's rank edit on an answer", "PATCH", "/api/itsas/" + key, `{"rank":2}`, agentTok, nil, 200, ""},
		{"an agent's status change on an answer", "PATCH", "/api/itsas/" + key, `{"status":"in_progress"}`, agentTok, nil, 501, "Answers:"},
		{"the human closing an answer", "PATCH", "/api/itsas/" + key, `{"status":"done"}`, sharedTok, human, 501, "closeAnswered"},
		{"an agent closing one with the body in the same call", "PATCH", "/api/itsas/" + key, `{"status":"done","body":"Answers: S-1"}`, agentTok, nil, 501, "Answers:"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := f.sendH(tc.method, tc.path, tc.token, tc.header, tc.payload)
			if rec.Code != tc.want || (tc.contains != "" && !strings.Contains(errorOf(t, rec), tc.contains)) {
				t.Errorf("%d %s, want %d %q", rec.Code, rec.Body.String(), tc.want, tc.contains)
			}
		})
	}
	if n := f.count("SELECT COUNT(*) FROM itsas WHERE title = 'x' AND status = 'done'"); n != 0 {
		t.Errorf("a refused create wrote %d ITSAs", n)
	}
	if n := f.count("SELECT COUNT(*) FROM itsas WHERE key = ? AND status = 'done'", key); n != 0 {
		t.Error("a refused close changed the status")
	}
}

// A peer's agent only remembered here, with no peer answering for it, is no agent (a peer's agent is looked up live,
// itsa_peer_people_test.go), and an agent's token is refused the three reads TS keeps from it.
func TestItsaPeerAndAgentReads(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('apeer', 'remote-one', 'elsewhere', '2026-10-01T00:00:00.000Z')")
	if rec := f.sendH("POST", "/api/itsas", sharedTok, human, `{"title":"x","owner":"remote-one"}`); rec.Code != 400 || !strings.Contains(errorOf(t, rec), "no agent remote-one") {
		t.Errorf("a remembered peer's agent no peer answers for: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("POST", "/api/itsas", sharedTok, human, `{"title":"x","owner":"nobody-here"}`); rec.Code != 400 {
		t.Errorf("an unknown agent as owner: %d %s", rec.Code, rec.Body.String())
	}
	for _, tc := range []struct{ path, what string }{
		{"/api/itsas/queue", "read the merge queue"}, {"/api/itsas/attention", "read what waits on the human"},
		{"/api/itsas/S-1/cost", "read an ITSA's cost"},
	} {
		if rec := f.sendH("GET", tc.path, agentTok, nil, ""); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "can't "+tc.what) {
			t.Errorf("%s with an agent token: %d %s", tc.path, rec.Code, rec.Body.String())
		}
		// Attention is ported (itsa_human_test.go); the other two are still 501.
		wantCode := 501
		if tc.path == "/api/itsas/attention" {
			wantCode = 200
		}
		if rec := f.sendH("GET", tc.path, sharedTok, nil, ""); rec.Code != wantCode {
			t.Errorf("%s with the shared token: %d %s", tc.path, rec.Code, rec.Body.String())
		}
	}
	// The peer hooks are a peer's alone (itsa_peers_test.go).
	if rec := f.sendH("GET", "/api/itsas/incident-marked?itsa=S-1", sharedTok, nil, ""); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "only a peer can call this") {
		t.Errorf("incident-marked: %d %s", rec.Code, rec.Body.String())
	}
}

// Who defines fields: the human always; with a chief of staff set, only that agent; with none, any agent.
func TestItsaFieldRules(t *testing.T) {
	f := newFixture(t, nil)
	field := func(key string) string { return `{"key":"` + key + `","label":"L","type":"text"}` }
	if rec := f.sendH("POST", "/api/itsas/fields", agentTok, nil, field("one")); rec.Code != 200 {
		t.Errorf("an agent with no chief of staff set: %d %s", rec.Code, rec.Body.String())
	}
	writeFile(t, f.home+"/settings.json", `{"chiefOfStaff":"boss"}`)
	if rec := f.sendH("POST", "/api/itsas/fields", agentTok, nil, field("two")); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "only the chief of staff (boss) changes ITSA fields: mail boss to add, change, or remove a column") {
		t.Errorf("an agent besides the chief of staff: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("PATCH", "/api/itsas/fields/one", agentTok, nil, `{"label":"X"}`); rec.Code != 403 {
		t.Errorf("an edit by another agent: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("DELETE", "/api/itsas/fields/one", agentTok, nil, ""); rec.Code != 403 {
		t.Errorf("a removal by another agent: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("POST", "/api/itsas/fields/order", agentTok, nil, `{"order":["one"]}`); rec.Code != 403 {
		t.Errorf("an order by another agent: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("POST", "/api/itsas/fields", sharedTok, human, field("two")); rec.Code != 200 {
		t.Errorf("the human: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("POST", "/api/itsas/fields", sharedTok, human, `{"by":"boss","key":"three","label":"L","type":"text"}`); rec.Code != 200 {
		t.Errorf("the chief of staff by name: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT COUNT(*) FROM itsa_fields"); n != 3 {
		t.Errorf("%d fields, want 3", n)
	}
	if n := f.count("SELECT COUNT(*) FROM itsa_events WHERE itsa_id = 'fields' AND type = 'field_created'"); n != 3 {
		t.Errorf("%d field_created events, want 3", n)
	}
	// A path that is no ref is no route, and a daemon that is not the home would proxy.
	if rec := f.post2("PATCH", "/api/itsas/fields/a.b", `{}`); rec.Code != 404 || !strings.Contains(errorOf(t, rec), "no route") {
		t.Errorf("a key that is no ref: %d %s", rec.Code, rec.Body.String())
	}
	writeFile(t, f.home+"/settings.json", `{"itsa":{"home":"elsewhere"}}`)
	if rec := f.post2("GET", "/api/itsas/fields", ""); rec.Code != 503 || !strings.Contains(errorOf(t, rec), "is not a configured peer") {
		t.Errorf("not the home: %d %s", rec.Code, rec.Body.String())
	}
}

// A stage write is ported (process_run_test.go); with no process for the ITSA's kind it is plain. A link to a followed pull
// request starts the ITSA's watch on it (watch.syncItsa, events_test.go): none of its writes is refused.
func TestItsaStageAndWatchedLinks(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("INSERT INTO itsa_fields (id, key, label, type, width, align, card, position, created_by, created_at, updated_at) VALUES ('fstage', 'stage', 'Stage', 'text', 'm', 'start', 'chip', 0, 'human', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')")
	key := f.createItsa(`{"title":"base"}`)
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"fields":{"stage":"dev"}}`); rec.Code != 200 || f.count("SELECT COUNT(*) FROM itsa_field_values") != 1 {
		t.Errorf("a stage move: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("POST", "/api/itsas", `{"title":"staged","fields":{"stage":"dev"}}`); rec.Code != 200 || f.count("SELECT COUNT(*) FROM itsa_field_values") != 2 {
		t.Errorf("a create at a stage: %d %s", rec.Code, rec.Body.String())
	}
	// Clearing the stage moves it nowhere.
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"fields":{"stage":null}}`); rec.Code != 200 {
		t.Errorf("clearing the stage: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("DELETE FROM itsa_fields")
	for _, u := range []string{"https://github.com/some-org/some-repo/pull/12", "https://github.com/some-org/some-repo/issues/3?x=1", "http://linear.app/team/issue/ABC-12", "https://github.com/some-org/some-repo", "https://example.com/pull/1"} {
		if rec := f.post2("POST", "/api/itsas/"+key+"/links", `{"url":"`+u+`"}`); rec.Code != 200 {
			t.Errorf("adding %s: %d %s", u, rec.Code, rec.Body.String())
		}
	}
	if n := f.count("SELECT COUNT(*) FROM event_subscriptions WHERE created_by = 'stam'"); n != 3 {
		t.Errorf("%d link subscriptions, want one for each followed subject", n)
	}
}

// The observers of an ITSA change that this daemon does not carry (decision steps, the requirement check of a linked branch,
// the wake of a resting owner, the stage answer) make their write answer 501.
func TestItsaObservers(t *testing.T) {
	f := newFixture(t, nil)
	parent := f.createItsa(`{"title":"parent","owner":"boss"}`)
	kid := f.createItsa(`{"title":"kid","parent":"` + parent + `"}`)
	// A child closing under a parent whose owner is a live agent tells that owner, after the write (TestItsaOwnerNotices).
	if rec := f.post2("PATCH", "/api/itsas/"+kid, `{"status":"done"}`); rec.Code != 200 {
		t.Errorf("a child closing: %d %s", rec.Code, rec.Body.String())
	}
	writeFile(t, f.home+"/settings.json", `{"itsa":{"ownerNotices":"off"}}`)
	// Requirement checks.
	writeFile(t, f.home+"/settings.json", `{"itsa":{"ownerNotices":"off"},"requirements":{"enabled":true}}`)
	if rec := f.post2("PATCH", "/api/itsas/"+kid, `{"title":"edited"}`); rec.Code != 200 {
		t.Errorf("an edit with requirements on (checked after the write): %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("POST", "/api/itsas", `{"title":"new"}`); rec.Code != 200 {
		t.Errorf("a create with requirements on (checked after the write): %d %s", rec.Code, rec.Body.String())
	}
	writeFile(t, f.home+"/settings.json", `{"itsa":{"ownerNotices":"off"}}`)
	// A decision step on itsa-created or itsa-status.
	f.sql("CREATE TABLE decision_steps (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL, question TEXT NOT NULL, threshold REAL NOT NULL DEFAULT 0.5, action TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, builtin TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
	f.sql(`INSERT INTO decision_steps (id, name, trigger, question, action, enabled, created_at, updated_at) VALUES ('s1', 'n', '{"kind":"event","event":"itsa-status"}', 'q', '{}', 1, 'x', 'x')`)
	if rec := f.post2("PATCH", "/api/itsas/"+kid, `{"status":"in_progress"}`); rec.Code != 501 || !strings.Contains(errorOf(t, rec), "itsa-status") {
		t.Errorf("a status change with a step: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("POST", "/api/itsas", `{"title":"fine"}`); rec.Code != 200 {
		t.Errorf("a create with only an itsa-status step: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("UPDATE decision_steps SET enabled = 0")
	if rec := f.post2("PATCH", "/api/itsas/"+kid, `{"status":"in_progress"}`); rec.Code != 200 {
		t.Errorf("a status change with the step off: %d %s", rec.Code, rec.Body.String())
	}
	// An owner that is resting is woken with a notice.
	f.sql("UPDATE agents SET lifecycle = 'paused', paused_by = '[\"standing-idle\"]' WHERE id = 'achild'")
	if rec := f.post2("PATCH", "/api/itsas/"+kid, `{"owner":"child"}`); rec.Code != 501 || !strings.Contains(errorOf(t, rec), "resting agent") {
		t.Errorf("an owner that rests: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("UPDATE agents SET lifecycle = 'active', paused_by = NULL WHERE id = 'achild'")
	if rec := f.post2("PATCH", "/api/itsas/"+kid, `{"owner":"child"}`); rec.Code != 200 {
		t.Errorf("an owner that works: %d %s", rec.Code, rec.Body.String())
	}
	// With a stage field, a move into a human status is plain unless the ITSA's process is at a human node (process_run_test.go).
	f.sql("INSERT INTO itsa_fields (id, key, label, type, width, align, card, position, created_by, created_at, updated_at) VALUES ('fstage', 'stage', 'Stage', 'text', 'm', 'start', 'chip', 0, 'human', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')")
	if rec := f.post2("PATCH", "/api/itsas/"+kid, `{"status":"needs_input"}`); rec.Code != 200 {
		t.Errorf("a move into a human status with a stage field: %d %s", rec.Code, rec.Body.String())
	}
}

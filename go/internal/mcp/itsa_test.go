package mcp

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// itsaRoutes is the stub's answers for the ITSA tools; false when the route is none of them.
func (s *stub) itsaRoutes(w http.ResponseWriter, r *http.Request, body any) bool {
	obj, _ := body.(map[string]any)
	reply := func(code int, json string) bool {
		if code != 200 {
			w.WriteHeader(code)
		}
		io.WriteString(w, json)
		return true
	}
	q := r.URL.Query()
	switch {
	case r.Method == "GET" && r.URL.Path == "/api/agents":
		return reply(200, `[{"id":"o1","name":"owner-one"},{"id":"p1","name":"part-one"},{"id":"c1","name":"child-one"}]`)
	case r.Method == "POST" && r.URL.Path == "/api/itsas":
		switch obj["title"] {
		case "Boom":
			return reply(400, `{"error":"an ITSA needs a title"}`)
		case "One two three four five six":
			return reply(200, `{"id":"i3","key":"S-10","title":"One two three four five six","status":"backlog","owner":null}`)
		}
		return reply(200, `{"id":"i1","key":"S-9","title":"Made","status":"backlog","owner":"o1"}`)
	case r.Method == "GET" && r.URL.Path == "/api/itsas/S-1":
		return reply(200, `{"id":"i1","key":"S-1","title":"Big","status":"in_progress","kind":"project","summary":"sum","body":"line one\nline two","owner":"o1","open_ask_detail":{"mail":"m7","kind":"ITSA"},"parent_chain":[{"key":"S-0","title":"Root"}],"fields":{"stage":"dev","n":3,"flag":true,"o":{"a":[1,2]},"gone":null},"participants":["o1","p1","human","zz"],"links":[{"system":"github","external_id":"7","url":"https://x/7"},{"system":"url","external_id":null,"url":"https://y"}],"children":[{"key":"S-2","title":"Kid","status":"done","owner":"c1","rollup":{"backlog":0,"ready":1,"active":2,"review":3,"closed":4}},{"key":"S-3","title":"Orphan","status":"idea","owner":null}],"rollup":{"backlog":1,"ready":0,"active":0,"review":0,"closed":1}}`)
	case r.Method == "GET" && r.URL.Path == "/api/itsas/S-2":
		return reply(200, `{"id":"i2","key":"S-2","title":"Bare","status":"done","kind":null,"owner":null,"participants":[],"links":[],"children":[],"rollup":null}`)
	case r.Method == "GET" && r.URL.Path == "/api/mail/linked/i1":
		return reply(200, `[{"thread_id":"m1","subject":"Plan é","from_name":"boss","from_id":"b","last_at":"2026-10-01T10:00:00.000Z","mails":3},{"thread_id":"m2","subject":"One","from_name":null,"from_id":"u","last_at":"2026-10-02T10:00:00.000Z","mails":1}]`)
	case r.Method == "GET" && r.URL.Path == "/api/itsas":
		rows := map[string]string{
			"a": `{"id":"i1","key":"S-1","status":"backlog","owner":"o1","title":"Early","created_at":"2026-10-01T00:00:00.000Z","fields":{"stage":"dev"}}`,
			"b": `{"id":"i2","key":"S-2","status":"done","owner":null,"title":"Later é","created_at":"2026-10-03T00:00:00.000Z","fields":{}}`,
			"c": `{"id":"i3","key":"S-3","status":"idea","owner":"human","title":"Middle","created_at":"2026-10-02T00:00:00.000Z"}`,
		}
		switch {
		case q.Get("text") == "none":
			return reply(200, `[]`)
		case q.Get("participant") == "a1" && q.Get("status") == "":
			return reply(200, `[`+rows["b"]+`,`+rows["c"]+`,`+rows["a"]+`]`)
		case q.Get("participant") == "a1":
			return reply(200, `[`+rows["b"]+`,`+rows["a"]+`]`)
		case q.Get("participant") == "o1":
			return reply(200, `[`+rows["a"]+`,`+rows["c"]+`]`)
		}
		return reply(200, `[`+rows["a"]+`,`+rows["b"]+`]`)
	case r.Method == "PATCH" && r.URL.Path == "/api/itsas/S-1":
		if obj["status"] == "stale" {
			return reply(409, `{"error":"status changed: S-1 is done now, not stale"}`)
		}
		if _, ok := obj["incident"]; ok {
			return reply(200, `{"itsa":{"key":"S-1","owner":"o1"},"changes":{"status":{"from":"backlog","to":"done"},"owner":{"from":"o1","to":"human"},"participants":{"from":["o1"],"to":["o1","p1"]},"fields":{"from":{"a":1},"to":{"a":2}},"title":{"from":"x","to":"y"},"body":{"from":null,"to":""},"rank":{"from":1,"to":2.5}},"retro_offer":"Retro offered"}`)
		}
		return reply(200, `{"itsa":{"key":"S-1","owner":null},"changes":{}}`)
	case r.Method == "GET" && r.URL.Path == "/api/itsas/fields":
		return reply(200, `[{"key":"stage","label":"Stage","type":"choice","options":[{"value":"dev"},{"value":"qa"}],"description":"where it is"},{"key":"n","label":"N","type":"number","options":null,"description":null}]`)
	case r.Method == "POST" && r.URL.Path == "/api/itsas/fields":
		return reply(200, `{"key":"effort"}`)
	case r.Method == "PATCH" && r.URL.Path == "/api/itsas/fields/effort":
		return reply(200, `{"key":"effort"}`)
	case r.Method == "DELETE" && r.URL.Path == "/api/itsas/fields/effort":
		return reply(200, `{"removed":"effort","values":0}`)
	case r.Method == "POST" && r.URL.Path == "/api/itsas/fields/order":
		return reply(200, `[{"key":"n","label":"N","type":"number"},{"key":"stage","label":"Stage","type":"text"}]`)
	case r.Method == "POST" && r.URL.Path == "/api/itsas/S-1/links":
		return reply(200, `{"link":{"n":3,"system":"github","external_id":"7","url":"https://x/7"},"itsa":{}}`)
	case r.Method == "PATCH" && r.URL.Path == "/api/itsas/S-1/links/3":
		return reply(200, `{"n":3,"system":"branch","external_id":"b","url":""}`)
	case r.Method == "POST" && r.URL.Path == "/api/itsas/S-1/post":
		return reply(200, `{"id":"m9","thread_id":"m8","itsa_id":"i1"}`)
	case r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/itsas/") && strings.HasSuffix(r.URL.Path, "/post"):
		return reply(403, `{"error":"agent can't post to `+strings.Trim(strings.TrimSuffix(r.URL.Path, "/post"), "/api/itsas")+`"}`)
	}
	return false
}

// The ITSA tools ask the daemon what src/mcp.ts's ask, in the same form, and say what they say.
func TestItsaToolsMatchTS(t *testing.T) {
	lines := []string{
		call(1, "itsa_create", `{"title":"Made","summary":"s","parent":"S-0","kind":"issue","owner":"o1","links":[{"url":"https://x"}]}`),
		call(2, "itsa_create", `{"title":"One two three four five six","participants":null}`),
		call(3, "itsa_create", `{"title":"Boom","self":"a1"}`),
		call(4, "itsa_create", `{}`),
		call(5, "itsa_get", `{"ref":"S-1"}`),
		call(6, "itsa_get", `{"key":" S-2 "}`),
		call(7, "itsa_get", `{"ref":"S-404"}`),
		call(8, "itsa_get", `{}`),
		call(9, "itsa_get", `{"ref":"a b/é"}`),
		call(10, "itsa_list", `{}`),
		call(11, "itsa_list", `{"status":"a b","text":"é&=","kind":"","category":null}`),
		call(12, "itsa_list", `{"mine":true}`),
		call(13, "itsa_list", `{"mine":true,"status":"done"}`),
		call(14, "itsa_list", `{"participant":"o1","parent":"root"}`),
		call(15, "itsa_list", `{"text":"none"}`),
		call(16, "itsa_set", `{"ref":"S-1","status":"done","incident":false}`),
		call(17, "itsa_set", `{"ref":"S-1","title":"One two three four five six"}`),
		call(18, "itsa_set", `{"ref":"S-1"}`),
		call(19, "itsa_set", `{"title":"x"}`),
		call(20, "itsa_set", `{"ref":"S-1","status":"stale"}`),
		call(21, "itsa_fields", `{}`),
		call(22, "itsa_fields", `{"action":"create","key":"effort","label":"Effort","type":"number","options":null,"width":"s"}`),
		call(23, "itsa_fields", `{"action":"update","field":"effort","label":"E"}`),
		call(24, "itsa_fields", `{"action":"update"}`),
		call(25, "itsa_fields", `{"action":"remove","field":"effort"}`),
		call(26, "itsa_fields", `{"action":"order","order":["n","stage"]}`),
		call(27, "itsa_fields", `{"action":"bogus"}`),
		call(28, "itsa_link", `{"ref":"S-1","url":"https://x/7","system":"github","external_id":"7"}`),
		call(29, "itsa_link", `{"ref":"S-1","system":"branch","external_id":"b","repo":"r1","url":null}`),
		call(30, "itsa_link", `{"ref":"S-1","n":3,"review":{"verdict":"approve"},"tests":{"passed":1}}`),
		call(31, "itsa_link", `{"ref":"S-1","n":3}`),
		call(32, "itsa_link", `{"url":"x"}`),
		call(33, "itsa_post", `{"itsa":"S-1","body":"hello"}`),
		call(34, "itsa_post", `{"itsa":" S-1 ","body":"update","kind":"update","health":"at_risk","to":["human","p1"],"override":"why"}`),
		call(35, "itsa_post", `{"ref":"S-1","body":null,"kind":null}`),
		call(36, "itsa_post", `{"itsa":"S 7/é","body":"é","self":"a1"}`),
		call(37, "itsa_post", `{"body":"no ITSA"}`),
		call(38, "itsa_post", `{"itsa":"S-1"}`),
	}
	// With the agent's id in the environment, and without it: the `self` argument then names the agent, and a call that has
	// none fails the same way in both servers, in the same order of checks.
	var answers map[string]string
	for _, env := range []map[string]string{{"STAM_AGENT_ID": "a1"}, nil} {
		ts, g := both(t, env, lines, 38, 0, "")
		for id, want := range ts.byID {
			if g.byID[id] != want {
				t.Errorf("env %v: id %s differs\n ts: %s\n go: %s", env, id, want, g.byID[id])
			}
		}
		if len(g.byID) != 38 {
			t.Errorf("env %v: go answered %d requests", env, len(g.byID))
		}
		sameCalls(t, ts.calls, g.calls)
		if env == nil {
			if !strings.Contains(g.byID["4"], "Pass your stam id as `self`") {
				t.Errorf("without an id, itsa_create answered %s", g.byID["4"])
			}
			continue
		}
		answers = g.byID
	}
	for _, want := range []string{"Title is 6 words", "owner: owner-one", "open ask: m7 · ITSA", "participants: owner-one, part-one, human, zz", "linked mail (newest first):", "No ITSAs.", "Retro offered", "nothing changed", "reordered", "Recorded on link 3"} {
		found := false
		for _, l := range answers {
			found = found || strings.Contains(l, want)
		}
		if !found {
			t.Errorf("no answer holds %q", want)
		}
	}
}

package mcp

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// eventsRoutes is the stub's answers for the subscription tools; false when the route is none of them.
func (s *stub) eventsRoutes(w http.ResponseWriter, r *http.Request, body any) bool {
	obj, _ := body.(map[string]any)
	reply := func(code int, json string) bool {
		if code != 200 {
			w.WriteHeader(code)
		}
		io.WriteString(w, json)
		return true
	}
	switch {
	case r.Method == "POST" && r.URL.Path == "/api/subscriptions":
		if obj["subscriber_id"] == "stranger" {
			return reply(403, `{"error":"stranger isn't in your tree"}`)
		}
		sid, _ := json.Marshal(obj["subscriber_id"])
		return reply(200, `{"id":"es-1234567890","subscriber_id":`+string(sid)+`}`)
	case r.Method == "GET" && r.URL.Path == "/api/pr/github-repo":
		if r.URL.Query().Get("none") != "" {
			return reply(200, `{"github":null}`)
		}
		// S-4831: with agent the daemon answers that agent's worktree origin first; a3's worktree is o/wt.
		if r.URL.Query().Get("agent") == "a3" {
			return reply(200, `{"github":"o/wt"}`)
		}
		return reply(200, `{"github":"example/stam"}`)
	case r.Method == "DELETE" && (r.URL.Path == "/api/subscriptions/es-1" || r.URL.Path == "/api/subscriptions/es-old"):
		return reply(200, `{"removed":true}`)
	case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/api/subscriptions/"):
		return reply(404, `{"error":"no such subscription"}`)
	case r.Method == "GET" && r.URL.Path == "/api/subscriptions":
		if r.URL.Query().Get("by") == "a1" {
			return reply(200, `[{"id":"es-1","subscriber_kind":"agent","subscriber_id":"a1","filter":{"source":"github","subjects":["github:o/r#1","github:o/*"],"types":["pull_request.*"]},"note":"CI","expires_at":1792000000000},{"id":"es-2","subscriber_kind":"human","subscriber_id":"human","filter":{},"note":"","expires_at":null}]`)
		}
		if r.URL.Query().Get("by") == "a3" {
			return reply(200, `[{"id":"es-old","subscriber_kind":"agent","subscriber_id":"a3","filter":{"subjects":["github:o/r#7"],"types":["checks.completed"],"ends_on":["pull_request.merged"]}},{"id":"es-other","subscriber_kind":"agent","subscriber_id":"a3","filter":{"subjects":["github:o/r#8"],"ends_on":["pull_request.merged"]}},{"id":"es-plain","subscriber_kind":"agent","subscriber_id":"a3","filter":{"subjects":["github:o/r#7"]}},{"id":"es-multi","subscriber_kind":"agent","subscriber_id":"a3","filter":{"subjects":["github:o/r#7","github:o/r#8"],"ends_on":["pull_request.merged"]}}]`)
		}
		return reply(200, `[]`)
	}
	return false
}

// The subscription tools send the daemon what src/mcp.ts's send and say what they say.
func TestEventToolsMatchTS(t *testing.T) {
	lines := []string{
		call(1, "subscribe", `{"source":"github","subjects":["github:o/r#1"],"types":["pull_request.*"],"note":"CI","expires_in_minutes":30}`),
		call(2, "subscribe", `{"itsa":"S-1","source":"github"}`),
		call(3, "subscribe", `{"for":"human","actors":["a"],"exclude_actors":["bot"]}`),
		call(4, "subscribe", `{"for":"stranger","source":"github"}`),
		call(5, "subscribe", `{"for":"p1","unknown":1,"source":null}`),
		call(6, "unsubscribe", `{"id":"es-1"}`),
		call(7, "unsubscribe", `{"id":"es-9"}`),
		call(8, "unsubscribe", `{"id":"a/é b"}`),
		call(9, "list_subscriptions", `{}`),
		call(10, "list_subscriptions", `{"self":"a2"}`),
	}
	for _, env := range []map[string]string{{"STAM_AGENT_ID": "a1"}, nil} {
		ts, g := both(t, env, lines, 10, 0, "")
		for id, want := range ts.byID {
			if g.byID[id] != want {
				t.Errorf("env %v: id %s differs\n ts: %s\n go: %s", env, id, want, g.byID[id])
			}
		}
		if len(g.byID) != 10 {
			t.Errorf("env %v: go answered %d requests", env, len(g.byID))
		}
		sameCalls(t, ts.calls, g.calls)
		if env != nil {
			for _, want := range []string{"Subscribed (es-1234567890): you hear", "ITSA S-1", "the human", "es-1  agent:a1  source=github subjects=github:o/r#1,github:o/* types=pull_request.*  (CI)  expires 2026-10-"} {
				found := false
				for _, l := range g.byID {
					found = found || strings.Contains(l, want)
				}
				if !found {
					t.Errorf("no answer holds %q", want)
				}
			}
		}
		if env == nil && !strings.Contains(g.byID["10"], "No event subscriptions.") {
			t.Errorf("an empty list: %s", g.byID["10"])
		}
	}
}

// watch_pr and unwatch_pr send the daemon what src/mcp.ts's send and say what they say: the PR as a number, OWNER/REPO#N or a
// url, the preset events, the ending types, the replaced watch, the refusals.
func TestWatchPrMatchesTS(t *testing.T) {
	lines := []string{
		call(1, "watch_pr", `{"pr":7}`),
		call(2, "watch_pr", `{"pr":"#12","events":["checks","merged"]}`),
		call(3, "watch_pr", `{"pr":"o/r#7","for":"human"}`),
		call(4, "watch_pr", `{"pr":"https://github.com/o/r/pull/7/files","events":["reviews"],"for":"a3"}`),
		call(5, "watch_pr", `{"pr":"nonsense"}`),
		call(6, "watch_pr", `{"pr":"o/r#7","events":["bogus"]}`),
		call(7, "watch_pr", `{"pr":"o/r#7","for":"stranger"}`),
		call(8, "watch_pr", `{}`),
		call(9, "unwatch_pr", `{"pr":"o/r#7","for":"a3"}`),
		call(10, "unwatch_pr", `{"pr":"o/r#99"}`),
		call(11, "unwatch_pr", `{"pr":"9"}`),
		call(12, "watch_pr", `{"pr":"o/r#7","events":[],"for":"a3"}`),
		// As a3 itself (env nil): the earlier watch on that one PR goes, the watches on other PRs and the plain ones stay.
		call(13, "watch_pr", `{"pr":"o/r#7","self":"a3"}`),
		call(14, "unwatch_pr", `{"pr":"o/r#7","self":"a3"}`),
		// S-4831: a number with repo takes that repo with no lookup; a repo that differs from OWNER/REPO#N or a url, or isn't
		// OWNER/NAME, is refused; a bare number asks with the agent, whose worktree origin answers first.
		call(15, "watch_pr", `{"pr":7,"repo":" o/b "}`),
		call(16, "watch_pr", `{"pr":"o/r#7","repo":"x/y"}`),
		call(17, "watch_pr", `{"pr":"https://github.com/o/r/pull/7","repo":"O/R"}`),
		call(18, "watch_pr", `{"pr":7,"repo":"not a repo"}`),
		call(19, "unwatch_pr", `{"pr":7,"repo":"o/b"}`),
		call(20, "watch_pr", `{"pr":5,"self":"a3"}`),
	}
	for _, env := range []map[string]string{{"STAM_AGENT_ID": "a1"}, nil} {
		ts, g := both(t, env, lines, 20, 0, "")
		for id, want := range ts.byID {
			if g.byID[id] != want {
				t.Errorf("env %v: id %s differs\n ts: %s\n go: %s", env, id, want, g.byID[id])
			}
		}
		if len(g.byID) != 20 {
			t.Errorf("env %v: go answered %d requests", env, len(g.byID))
		}
		sameCalls(t, ts.calls, g.calls)
		if env != nil {
			for _, want := range []string{"Watching PR #7 (github:example/stam#7): checks.completed, review.submitted, comment.created, synchronize, merged, closed. A merge or close ends the watch.", "No watch on PR #99."} {
				found := false
				for _, l := range g.byID {
					found = found || strings.Contains(l, want)
				}
				if !found {
					t.Errorf("no answer holds %q", want)
				}
			}
		}
		if env == nil && !strings.Contains(g.byID["14"], "Stopped watching PR #7.") {
			t.Errorf("unwatch_pr as a3: %s", g.byID["14"])
		}
		// With no agent env, calls 15-19 name no agent, so they fail on that first, as TS does; call 20 runs as a3 only then (the
		// env's agent wins over self).
		for id, want := range map[string]string{"16": "is in o/r, but repo says x/y", "18": "repo is OWNER/NAME, not", "20": "github:o/wt#5"} {
			if (env == nil) != (id == "20") {
				continue
			}
			if !strings.Contains(g.byID[id], want) {
				t.Errorf("env %v: id %s lacks %q: %s", env, id, want, g.byID[id])
			}
		}
		if env != nil && !strings.Contains(g.byID["15"], "github:o/b#7") {
			t.Errorf("watch_pr with repo: %s", g.byID["15"])
		}
	}
}

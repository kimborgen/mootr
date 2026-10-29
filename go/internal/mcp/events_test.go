package mcp

import (
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
		return reply(200, `{"id":"es-1234567890"}`)
	case r.Method == "DELETE" && r.URL.Path == "/api/subscriptions/es-1":
		return reply(200, `{"removed":true}`)
	case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/api/subscriptions/"):
		return reply(404, `{"error":"no such subscription"}`)
	case r.Method == "GET" && r.URL.Path == "/api/subscriptions":
		if r.URL.Query().Get("by") == "a1" {
			return reply(200, `[{"id":"es-1","subscriber_kind":"agent","subscriber_id":"a1","filter":{"source":"github","subjects":["github:o/r#1","github:o/*"],"types":["pull_request.*"]},"note":"CI","expires_at":1792000000000},{"id":"es-2","subscriber_kind":"human","subscriber_id":"human","filter":{},"note":"","expires_at":null}]`)
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

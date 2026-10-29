package opencode

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// The calls of a turn's end and the control calls: what they read from the server's answers, and what they send.
func TestTurnEndCalls(t *testing.T) {
	var calls []string
	var bodies []string
	s := testServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		calls = append(calls, r.Method+" "+r.URL.RequestURI())
		bodies = append(bodies, string(b))
		switch r.URL.Path {
		case "/api/session/ses_a":
			fmt.Fprint(w, `{"data":{"cost":1.5,"tokens":{"input":10,"output":4,"reasoning":3,"cache":{"read":7,"write":2}}}}`)
		case "/api/session/ses_nocost":
			fmt.Fprint(w, `{"tokens":{"input":1}}`)
		case "/api/session/ses_none":
			fmt.Fprint(w, `{"cost":2}`)
		case "/api/session/ses_a/message":
			fmt.Fprint(w, `{"data":{"items":[{"tokens":{"input":100,"cache":{"read":50}}}]}}`)
		case "/api/session/ses_list/message":
			fmt.Fprint(w, `[{"tokens":{"input":5}}]`)
		case "/api/session/ses_empty/message":
			fmt.Fprint(w, `{"data":[]}`)
		default:
			fmt.Fprint(w, `{"data":{}}`)
		}
	}))
	ctx := context.Background()
	u, ok, err := s.SessionUsage(ctx, "ses_a")
	if err != nil || !ok || u.Cost == nil || *u.Cost != 1.5 || u.Input != 10 || u.Output != 7 || u.CacheRead != 7 || u.CacheWrite != 2 {
		t.Errorf("usage %+v %v %v", u, ok, err)
	}
	if u, ok, _ := s.SessionUsage(ctx, "ses_nocost"); !ok || u.Cost != nil || u.Input != 1 {
		t.Errorf("a session without cost: %+v %v", u, ok)
	}
	if _, ok, err := s.SessionUsage(ctx, "ses_none"); ok || err != nil {
		t.Errorf("a session without tokens: %v %v", ok, err)
	}
	if n, ok, err := s.ContextTokens(ctx, "ses_a"); n != 150 || !ok || err != nil {
		t.Errorf("context %v %v %v", n, ok, err)
	}
	if n, ok, _ := s.ContextTokens(ctx, "ses_list"); n != 5 || !ok {
		t.Errorf("a bare list: %v %v", n, ok)
	}
	if _, ok, _ := s.ContextTokens(ctx, "ses_empty"); ok {
		t.Error("no message counted")
	}
	if err := s.Compact(ctx, "ses_a"); err != nil {
		t.Error(err)
	}
	if err := s.ConnectMCP(ctx, "/work/a b"); err != nil {
		t.Error(err)
	}
	want := []string{
		"GET /api/session/ses_a", "GET /api/session/ses_nocost", "GET /api/session/ses_none",
		"GET /api/session/ses_a/message?limit=1&order=desc&type=assistant", "GET /api/session/ses_list/message?limit=1&order=desc&type=assistant",
		"GET /api/session/ses_empty/message?limit=1&order=desc&type=assistant",
		"POST /api/session/ses_a/compact", "POST /api/experimental/mcp/stam/connect?location%5Bdirectory%5D=%2Fwork%2Fa+b",
	}
	if fmt.Sprint(calls) != fmt.Sprint(want) {
		t.Errorf("calls:\n%v\nwant:\n%v", calls, want)
	}
	if bodies[6] != "{}" || bodies[7] != "{}" {
		t.Errorf("bodies %q %q", bodies[6], bodies[7])
	}
}

// A server that fails a read says only the method, path and status in the error, never the body it answered.
func TestTurnEndErrorBody(t *testing.T) {
	s := testServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		fmt.Fprint(w, `{"name":"UnknownError","data":{"message":"sk-or-v1-leak"}}`)
	}))
	_, _, err := s.SessionUsage(context.Background(), "ses_a")
	if err == nil || strings.Contains(err.Error(), "sk-or") || !strings.Contains(err.Error(), "500") {
		t.Errorf("error %v", err)
	}
}

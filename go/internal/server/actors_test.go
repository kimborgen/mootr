package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// The identity a write's body claims (by, from, self) is resolved once, in ServeHTTP, for every route (S-3795), as
// src/daemon.ts resolveActors runs before its route table. These tests walk the route table itself, so a route added
// later is covered without being listed.

// writeRoutes is every write pattern of the route table, but the /api/test/* hooks, which no agent's token reaches.
func writeRoutes(t *testing.T, s *Server) []string {
	t.Helper()
	var out []string
	for _, p := range s.patterns {
		method, path, _ := strings.Cut(p, " ")
		if writeMethod(method) && !strings.HasPrefix(path, "/api/test/") {
			out = append(out, p)
		}
	}
	if len(out) < 50 {
		t.Fatalf("only %d write routes in the table: is handle still recording them?", len(out))
	}
	return out
}

var wildcard = regexp.MustCompile(`\{(\w+)(\.\.\.)?\}`)

// routePath is a pattern's method and a path it matches: an agent's id is the token's own agent, so a route that acts
// as the agent in its path gets past that check, and every other wildcard is a plain word.
func routePath(pattern string) (string, string) { return routePathAs(pattern, "achild") }

// routePathAs is routePath with the agent id given.
func routePathAs(pattern, agent string) (string, string) {
	method, path, _ := strings.Cut(pattern, " ")
	return method, wildcard.ReplaceAllStringFunc(path, func(w string) string {
		if wildcard.FindStringSubmatch(w)[1] == "id" {
			return agent
		}
		return "x1"
	})
}

// peerOnly is whether ServeHTTP refuses a write route to every caller but a peer's daemon before the body matters: a
// notice for the peer's own agent, and the ITSA home's peer hooks.
func peerOnly(pattern string) bool {
	_, path := routePath(pattern)
	return pattern == "POST /api/agents/{id}/notice" || peerHookPath.MatchString(path)
}

// TestEveryWriteRouteRefusesAForeignActor: an agent's token naming another agent in by, from or self is refused with
// resolveActors' 403 on every write route, before the route runs.
func TestEveryWriteRouteRefusesAForeignActor(t *testing.T) {
	f := newFixture(t, nil)
	for _, p := range writeRoutes(t, f.srv) {
		method, path := routePath(p)
		for _, k := range []string{"by", "from", "self"} {
			rec := f.do(call{method: method, path: path, token: agentTok, body: `{"` + k + `":"aboss"}`})
			if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "agent child can't act as aboss") {
				t.Errorf("%s with %s naming another agent: %d %s, want 403 can't act as", p, k, rec.Code, rec.Body.String())
			}
		}
	}
}

// probe swaps the server's routes for ones that answer with the body they read, on the same patterns, so a test sees
// what every route would read after ServeHTTP's checks.
func probe(f *fixture) {
	mux := http.NewServeMux()
	for _, p := range f.srv.patterns {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(b)
		})
	}
	f.srv.mux = mux
}

// readBack is the body a probed route read, as a JSON object.
func readBack(t *testing.T, rec *httptest.ResponseRecorder, what string) map[string]any {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Errorf("%s: %d %s, want the route to run", what, rec.Code, rec.Body.String())
		return nil
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Errorf("%s: the route read %q, not a JSON object", what, rec.Body.String())
	}
	return got
}

// TestEveryWriteRouteReadsTheResolvedActor: whatever an agent's token sends, `{}`, its own name or nothing, every write
// route reads by, from and self as that agent; the OpenCode server's one named agent is all three.
func TestEveryWriteRouteReadsTheResolvedActor(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET harness = 'opencode' WHERE id = 'agone'")
	// The requirements routes answer a 404 while requirements are off, before the body matters.
	writeFile(t, f.home+"/settings.json", `{"requirements":{"enabled":true}}`)
	routes := writeRoutes(t, f.srv)
	probe(f)
	for _, p := range routes {
		method, path := routePath(p)
		for _, body := range []string{``, `{}`, `{"by":"child","x":1}`, `{"by":null,"from":""}`, `{"by":"aboss","by":"achild"}`} {
			if peerOnly(p) {
				break
			}
			got := readBack(t, f.do(call{method: method, path: path, token: agentTok, body: body}), p+" "+body)
			if got == nil {
				continue
			}
			for _, k := range []string{"by", "from", "self"} {
				if got[k] != "achild" {
					t.Errorf("%s with %q: the route read %s = %v, want achild", p, body, k, got[k])
				}
			}
		}
		// A peer forwarding its agent's call is that agent.
		got := readBack(t, f.do(call{method: method, path: path, token: peerTok, body: `{}`,
			header: map[string]string{"X-Stam-Local": "1", "X-Stam-Agent": "achild"}}), p+" forwarded")
		if got != nil && got["by"] != "achild" {
			t.Errorf("%s forwarded for achild: the route read by = %v", p, got["by"])
		}
		if peerOnly(p) {
			continue
		}
		method, path = routePathAs(p, "agone")
		got = readBack(t, f.do(call{method: method, path: path, token: serverTok, body: `{"from":"gone"}`}), p+" OpenCode")
		for _, k := range []string{"by", "from", "self"} {
			if got != nil && got[k] != "agone" {
				t.Errorf("%s from the OpenCode server naming gone: the route read %s = %v, want agone", p, k, got[k])
			}
		}
	}
}

// TestWriteActorEdges is the rest of resolveActors' contract on the routes: who acts as given, the OpenCode server's
// refusals, and bodies that are no object, won't parse or are too large.
func TestWriteActorEdges(t *testing.T) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	f.sql("UPDATE agents SET harness = 'opencode' WHERE id = 'agone'")
	routes := writeRoutes(t, f.srv)
	probe(f)
	human := map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1"}
	const send = "/api/mail"

	// The human, and a peer's own call, act as given; a peer's own body is not even reparsed.
	if got := readBack(t, f.do(call{method: "POST", path: send, header: human, body: `{"by":"aboss","from":"achild"}`}), "human"); got["by"] != "aboss" || got["from"] != "achild" || got["self"] != nil {
		t.Errorf("the human's claims: %v, want them as given", got)
	}
	raw := `{"from":"achild", "n":1.50}`
	if rec := f.do(call{method: "POST", path: send, token: peerTok, header: map[string]string{"X-Stam-Local": "1"}, body: raw}); rec.Code != 200 || rec.Body.String() != raw {
		t.Errorf("a peer's own call: %d %q, want its body as sent", rec.Code, rec.Body.String())
	}
	// A peer forwarding its agent may not name another.
	if rec := f.do(call{method: "POST", path: send, token: peerTok, header: map[string]string{"X-Stam-Local": "1", "X-Stam-Agent": "achild"}, body: `{"from":"aboss"}`}); rec.Code != http.StatusForbidden {
		t.Errorf("a forwarded agent naming another: %d, want 403", rec.Code)
	}
	// A repeated key is read as JSON.parse reads it, its last value, and the route reads only that one.
	if rec := f.do(call{method: "POST", path: send, token: agentTok, body: `{"by":"achild","by":"aboss"}`}); rec.Code != http.StatusForbidden {
		t.Errorf("a repeated by naming another last: %d, want 403", rec.Code)
	}
	if rec := f.do(call{method: "POST", path: send, token: agentTok, body: `{"by":"aboss","by":"achild"}`}); strings.Count(rec.Body.String(), `"by"`) != 1 {
		t.Errorf("a repeated by: the route read %s, want one by", rec.Body.String())
	}

	// Only the identity fields are rewritten: every other value reaches the route as sent, a number past a double too.
	if rec := f.do(call{method: "POST", path: send, token: agentTok, body: ` {"n" : 1e400, "x":{"a":1.50,"a":2}, "by":"child"} `}); rec.Body.String() != `{"n":1e400,"x":{"a":1.50,"a":2},"by":"achild","from":"achild","self":"achild"}` {
		t.Errorf("an agent's body: the route read %s", rec.Body.String())
	}

	// The OpenCode server must name an OpenCode agent, except where the path or the body's `agent` names it.
	for _, tc := range []struct{ body, want string }{
		{`{}`, "the OpenCode server's request must name its agent"},
		{`{"by":"achild"}`, "the OpenCode server can't act as achild"},
	} {
		if rec := f.do(call{method: "POST", path: send, token: serverTok, body: tc.body}); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("OpenCode %s: %d %s, want 403 %s", tc.body, rec.Code, rec.Body.String(), tc.want)
		}
	}
	exempt := 0
	for _, p := range routes {
		method, path := routePathAs(p, "agone")
		if peerOnly(p) || !opencodeNamed.MatchString(path) && !opencodeNamesAgent(method, path) && !bodyNamesAgent.MatchString(method+" "+path) {
			continue
		}
		exempt++
		if rec := f.do(call{method: method, path: path, token: serverTok, body: `{}`}); rec.Code != http.StatusOK {
			t.Errorf("%s from the OpenCode server naming no one: %d %s, want the route to check its agent", p, rec.Code, rec.Body.String())
		}
	}
	if exempt == 0 {
		t.Error("no route names the OpenCode server's agent in its path or body")
	}

	// A body that is no object, or won't parse, is a 400, never a 500; one past the bound is a 413.
	for _, tc := range []struct {
		token, body string
		status      int
	}{
		{agentTok, `[]`, 400},
		{agentTok, `"achild"`, 400},
		{serverTok, `null`, 400},
		{agentTok, `{"by":`, 400},
		{sharedTok, `{"by":`, 400},
	} {
		if rec := f.do(call{method: "POST", path: send, token: tc.token, body: tc.body}); rec.Code != tc.status {
			t.Errorf("%s: %d %s, want %d", tc.body, rec.Code, rec.Body.String(), tc.status)
		}
	}
	// The shared token's array is no identity claim: the route reads it as sent.
	if rec := f.do(call{method: "POST", path: send, token: sharedTok, body: `[1]`}); rec.Code != 200 || rec.Body.String() != `[1]` {
		t.Errorf("the shared token's array: %d %q", rec.Code, rec.Body.String())
	}
	r := httptest.NewRequest("POST", send, io.LimitReader(spaces{}, maxBody+1))
	r.Host = "127.0.0.1:7999"
	r.Header.Set("Authorization", "Bearer "+agentTok)
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, r)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("a body past the bound: %d, want 413", rec.Code)
	}
}

// spaces is an endless body of spaces.
type spaces struct{}

func (spaces) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = ' '
	}
	return len(p), nil
}

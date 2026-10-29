package server

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"stam/internal/auth"
)

// TestActingGate: every `acting` route in src/agent-routes.ts runs mayActAs on the agent in its path before any routing,
// whatever its segment count (S-4237): the OpenCode server's token and an unrelated agent's get 403 on another agent's
// route, with and without a `by`, and a percent-encoded path is no route; the agent itself, its parent, the human and a
// peer pass. Strict off, an unclaimed `by` doesn't make a token caller the human; strict on, the human is only the human's
// proof.
func TestActingGate(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/agent-routes.ts")
	}
	out, err := exec.Command("node", "--no-warnings", "testdata/actingroutes.mjs").Output()
	if err != nil {
		t.Fatalf("actingroutes.mjs: %v", err)
	}
	var routes []struct{ Method, Path string }
	must(t, json.Unmarshal(out, &routes))
	// Each Go acting route is reached by TS's table, and each of TS's routes is one Go gates for achild.
	for _, r := range actingRoutes {
		hit := false
		for _, tr := range routes {
			hit = hit || (tr.Method == r.method && r.re.MatchString("/api/agents/achild"+tr.Path))
		}
		if !hit {
			t.Errorf("Go's acting route %s %s isn't in TS's table", r.method, r.re)
		}
	}
	for _, tr := range routes {
		if id, ok := matchActing(tr.Method, "/api/agents/achild"+tr.Path); !ok || id != "achild" {
			t.Errorf("matchActing(%s %s) = %q, %v", tr.Method, tr.Path, id, ok)
		}
	}
	if len(routes) < 20 {
		t.Fatalf("TS's table gave %d acting routes", len(routes))
	}

	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	withLife(f)
	const otherTok = "other-agent-token-value"
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'agone'", auth.Hash(otherTok))
	bossTokOr(f)
	human := map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1"}
	type caller struct {
		name, token, by string
		header          map[string]string
	}
	var sendTo func(method, path string, c caller) (int, string)
	refused := []caller{
		{"the OpenCode server", serverTok, "", nil},
		{"the OpenCode server naming achild", serverTok, "achild", nil},
		{"an unrelated agent", otherTok, "", nil},
		{"an unrelated agent naming itself", otherTok, "agone", nil},
	}
	send := func(tr struct{ Method, Path string }, c caller) (int, string) {
		t.Helper()
		return sendTo(tr.Method, "/api/agents/achild"+tr.Path, c)
	}
	sendTo = func(method, path string, c caller) (int, string) {
		t.Helper()
		body := ""
		if method == "POST" {
			body = `{}`
			if c.by != "" {
				body = `{"by":"` + c.by + `"}`
			}
		}
		// A passing GET of the stream or the view stays open; its context ends it.
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer cancel()
		rec := f.do(call{method: method, path: path, token: c.token, header: c.header, body: body, ctx: ctx})
		return rec.Code, rec.Body.String()
	}
	for _, strict := range []bool{false, true} {
		passing := []caller{{"the agent itself", agentTok, "achild", nil}, {"its parent", bossTok, "aboss", nil}, {"a peer", peerTok, "", nil}}
		if strict {
			must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"auth":{"humanStrict":true}}`), 0o600))
			passing = append(passing, caller{"the human", "", "", human})
		} else {
			passing = append(passing, caller{"the human", sharedTok, "", nil})
		}
		for _, tr := range routes {
			for _, c := range refused {
				// POST /waits isn't a route that names the OpenCode server's agent, so resolveActors refuses its unclaimed
				// request first, as in TS.
				want := "can't act as achild"
				if tr.Method == "POST" && tr.Path == "/waits" && c.token == serverTok && c.by == "" {
					want = "the OpenCode server's request must name its agent"
				}
				if code, body := send(tr, c); code != 403 || !strings.Contains(body, want) {
					t.Errorf("strict %v, %s at %s %s: %d %s, want 403 %s", strict, c.name, tr.Method, tr.Path, code, body, want)
				}
				// A percent-encoded character is no route, as in TS, so no handler gets a path the gate didn't judge: in
				// the agent's id, in the route's first segment, and in its last (a thread's action).
				segs := strings.Split(tr.Path, "/")
				encoded := []string{"/api/agents/ach%69ld" + tr.Path}
				for _, i := range []int{1, len(segs) - 1} {
					e := append([]string(nil), segs...)
					e[i] = fmt.Sprintf("%%%02x", e[i][0]) + e[i][1:]
					encoded = append(encoded, "/api/agents/achild"+strings.Join(e, "/"))
				}
				for _, path := range encoded {
					if code, body := sendTo(tr.Method, path, c); code != 404 || !strings.Contains(body, "no route") {
						t.Errorf("strict %v, %s at %s %s: %d %s, want 404", strict, c.name, tr.Method, path, code, body)
					}
				}
			}
			for _, c := range passing {
				// Go's push stream is the agent's own (pushStream): a parent's token is refused there by the handler.
				if c.token == bossTok && tr.Path == "/stream" {
					continue
				}
				// A route's own rule may still refuse (a peer isn't the human under strict); the gate's refusal names achild.
				if code, body := send(tr, c); code == 403 && strings.Contains(body, "act as achild") {
					t.Errorf("strict %v, %s at %s %s: %d %s", strict, c.name, tr.Method, tr.Path, code, body)
				}
				// An encoded path is no route for a caller the gate passes too, as in TS.
				if code, body := sendTo(tr.Method, "/api/agents/ach%69ld"+tr.Path, c); code != 404 || !strings.Contains(body, "no route") {
					t.Errorf("strict %v, %s at %s ach%%69ld%s: %d %s, want 404", strict, c.name, tr.Method, tr.Path, code, body)
				}
			}
		}
	}
}

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"stam/internal/auth"
)

// TestPromptRoutesAccess: the instructions and inventory of an agent are the acting gate's (src/agent-routes.ts
// `acting`): the agent itself, its ancestors, the shared and peer tokens; not a parent's or a sibling's, nor the
// OpenCode server for a Claude agent. An unknown agent is a 404. A type's inventory is every token's; an unknown type is
// a 404 and an unknown harness a 400.
func TestPromptRoutesAccess(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'aboss'", auth.Hash(bossTok))
	for _, route := range []string{"instructions", "inventory"} {
		for _, tc := range []struct {
			name, agent, token string
			status             int
			error              string
		}{
			{"an agent on itself", "achild", agentTok, 200, ""},
			{"a parent on its child", "achild", bossTok, 200, ""},
			{"the shared token", "aboss", sharedTok, 200, ""},
			{"the peer token", "aboss", peerTok, 200, ""},
			{"an agent on its parent", "aboss", agentTok, 403, "agent child can't act as aboss"},
			{"an agent on a sibling", "agone", agentTok, 403, "agent child can't act as agone"},
			{"the OpenCode server on a Claude agent", "achild", serverTok, 403, "the OpenCode server can't act as achild"},
			{"an unknown agent", "nope", sharedTok, 404, "no agent nope"},
		} {
			t.Run(route+"/"+tc.name, func(t *testing.T) {
				rec := f.send("GET", "/api/agents/"+tc.agent+"/"+route, tc.token, "")
				if rec.Code != tc.status {
					t.Fatalf("status %d, want %d: %.300s", rec.Code, tc.status, rec.Body.String())
				}
				if tc.error != "" {
					if got := envelope(t, rec)["error"]; got != tc.error {
						t.Fatalf("error %q, want %q", got, tc.error)
					}
				}
			})
		}
	}
	for _, tc := range []struct {
		name, path string
		status     int
		want       string
	}{
		{"a type", "/api/types/reviewer/inventory", 200, `"type":"reviewer"`},
		{"a type with another harness", "/api/types/reviewer/inventory?harness=codex", 200, `"harness":"codex"`},
		{"an unknown type", "/api/types/nope/inventory", 404, "no agent type nope"},
		{"an unknown harness", "/api/types/reviewer/inventory?harness=nope", 400, "unknown harness nope"},
		{"an empty harness", "/api/types/reviewer/inventory?harness=", 400, "unknown harness "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := f.send("GET", tc.path, agentTok, "")
			if rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.want) {
				t.Fatalf("%d %.300s, want %d with %s", rec.Code, rec.Body.String(), tc.status, tc.want)
			}
		})
	}
}

// TestPromptRoutesKeepSecrets: no MCP server env or header value, and no token, reaches the instructions or the
// inventory; the server's name does. With no summaries model every prose block (the mcp-tools layer's note on other
// servers included) is off and a tool schema is summarized by its own description, so no request waits on a model.
func TestPromptRoutesKeepSecrets(t *testing.T) {
	f := newFixture(t, nil)
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"mcpServers":{"ghsrv":{"command":"gh","env":{"GITHUB_TOKEN":"ghp_envsecret"}},`+
		`"websrv":{"url":"https://example.invalid","headers":{"X-Api":"hdrsecret"}}}}`), 0o600))
	for _, path := range []string{"/api/agents/achild/instructions", "/api/agents/achild/inventory", "/api/types/developer/inventory"} {
		rec := f.send("GET", path, sharedTok, "")
		if rec.Code != 200 {
			t.Fatalf("%s: %d %.300s", path, rec.Code, rec.Body.String())
		}
		body := rec.Body.String()
		for _, secret := range []string{"ghp_envsecret", "hdrsecret", sharedTok, agentTok, peerTok} {
			if strings.Contains(body, secret) {
				t.Errorf("%s leaks %q", path, secret)
			}
		}
		if !strings.Contains(body, "ghsrv") || !strings.Contains(body, "websrv") {
			t.Errorf("%s doesn't name the MCP servers", path)
		}
	}
	// The instructions are {parts}, as src/agent-instructions.ts agentInstructionParts returns them.
	var ins struct {
		Parts []struct{ Label string } `json:"parts"`
	}
	if rec := f.send("GET", "/api/agents/achild/instructions", sharedTok, ""); json.Unmarshal(rec.Body.Bytes(), &ins) != nil || len(ins.Parts) == 0 || ins.Parts[0].Label != "System prompt" {
		t.Errorf("instructions aren't {parts}: %.200s", rec.Body.String())
	}
	var inv struct {
		Layers []struct {
			Key    string `json:"key"`
			Blocks []struct {
				Title        string  `json:"title"`
				Summary      *string `json:"summary"`
				SummaryState string  `json:"summaryState"`
			} `json:"blocks"`
		} `json:"layers"`
	}
	must(t, json.Unmarshal(f.send("GET", "/api/agents/achild/inventory", sharedTok, "").Body.Bytes(), &inv))
	sources := 0
	for _, l := range inv.Layers {
		for _, b := range l.Blocks {
			switch {
			case l.Key == "mcp-tools" && b.SummaryState == "source" && b.Summary != nil && *b.Summary != "":
				sources++
			case b.SummaryState == "off":
			default:
				t.Errorf("block %s/%s: state %q", l.Key, b.Title, b.SummaryState)
			}
		}
	}
	if sources == 0 {
		t.Error("no tool schema is summarized by its description")
	}
}

// TestPromptRoutesRedactHomeBearer: off the ITSA home, a home that answers an error echoing the bearer it got is
// reported as TS reports it (`the ITSA home NAME refused: WHY`, the status when there is no error text), with the
// peer's tokens redacted from both the error and the daemon's log; the routes still answer.
func TestPromptRoutesRedactHomeBearer(t *testing.T) {
	f := newFixture(t, nil)
	var mu sync.Mutex
	var sent []string
	bare := false
	home := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bearer := r.Header.Get("Authorization")
		mu.Lock()
		sent = append(sent, bearer)
		noText := bare
		mu.Unlock()
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		if noText {
			_, _ = w.Write([]byte(`{}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "proxy saw " + bearer})
	}))
	t.Cleanup(home.Close)
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"itsa":{"home":"farhome"},"peers":[{"name":"farhome","url":"`+home.URL+`","token":"home-peer-secret-4711"}]}`), 0o600))
	logs := captureServerLogs(t)
	for _, path := range []string{"/api/agents/achild/instructions", "/api/agents/achild/inventory"} {
		if rec := f.send("GET", path, sharedTok, ""); rec.Code != 200 {
			t.Fatalf("%s: %d %.300s", path, rec.Code, rec.Body.String())
		}
	}
	_, err := f.srv.homeGet(context.Background(), "/api/itsas/fields")
	mu.Lock()
	bearers := slices.Clone(sent)
	bare = true
	mu.Unlock()
	if len(bearers) == 0 || !strings.HasPrefix(bearers[0], "Bearer ") {
		t.Fatalf("the home was never asked with a bearer: %q", bearers)
	}
	if err == nil || err.Error() != "the ITSA home farhome refused: proxy saw Bearer [redacted]" {
		t.Errorf("the error: %v", err)
	}
	if _, err := f.srv.homeGet(context.Background(), "/api/itsas/fields"); err == nil || err.Error() != "the ITSA home farhome refused: 502" {
		t.Errorf("no error text: %v", err)
	}
	out := logs.String()
	if !strings.Contains(out, "the ITSA home farhome refused: proxy saw Bearer [redacted]") {
		t.Errorf("the failed read isn't logged: %s", out)
	}
	for _, b := range bearers {
		if strings.Contains(out, strings.TrimPrefix(b, "Bearer ")) {
			t.Errorf("the log holds the bearer the home echoed: %s", out)
			break
		}
	}
}

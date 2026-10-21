package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"stam/internal/db"
)

// TestAgentChangedStream: an agent's activity or lifecycle change reaches /api/live as one coalesced `agent.changed`
// with its state, activity, context size, spend and unread mail; a change to archived sends `agent.archived` first.
func TestAgentChangedStream(t *testing.T) {
	f := newFixture(t, nil)
	ts := httptest.NewServer(f.srv)
	t.Cleanup(ts.Close)
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/live", nil)
	must(t, err)
	req.Header.Set("Authorization", "Bearer "+sharedTok)
	req.Host = "127.0.0.1:7999"
	// A deadline, so a missing event fails the read instead of hanging the test.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	res, err := http.DefaultClient.Do(req.WithContext(ctx))
	must(t, err)
	defer res.Body.Close()
	lines := bufio.NewReader(res.Body)
	next := func() (string, map[string]any) {
		t.Helper()
		var event string
		for {
			line, err := lines.ReadString('\n')
			must(t, err)
			switch {
			case strings.HasPrefix(line, "event: "):
				event = strings.TrimSpace(strings.TrimPrefix(line, "event: "))
			case strings.HasPrefix(line, "data: "):
				var data map[string]any
				must(t, json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &data))
				return event, data
			}
		}
	}
	if line, _ := lines.ReadString('\n'); line != ": connected\n" {
		t.Fatalf("first line %q", line)
	}

	bg := context.Background()
	must(t, f.db.UpdateAgent(bg, "achild", db.Field{Col: "activity", Val: "working"}, db.Field{Col: "context_tokens", Val: 1234}))
	must(t, f.db.UpdateAgent(bg, "achild", db.Field{Col: "activity", Val: "idle"}))
	a, err := f.db.GetAgent(bg, "achild")
	must(t, err)
	unread, err := f.db.UnreadCount(bg, "achild")
	must(t, err)
	cost, err := f.db.AgentCost(bg, "achild")
	must(t, err)
	event, data := next()
	if event != "agent.changed" || data["id"] != "achild" || data["state"] != string(a.Lifecycle) || data["activity"] != string(a.Activity) ||
		data["context_tokens"] != 1234.0 || data["unread"] != float64(unread) || data["cost_usd"] != cost || len(data) != 6 {
		t.Errorf("%s %v", event, data)
	}

	must(t, f.db.UpdateAgent(bg, "achild", db.Field{Col: "lifecycle", Val: "archived"}))
	if event, data := next(); event != "agent.archived" || len(data) != 1 || data["id"] != "achild" {
		t.Errorf("archive: %s %v", event, data)
	}
	if event, data := next(); event != "agent.changed" || data["state"] != "archived" {
		t.Errorf("after the archive: %s %v", event, data)
	}
}

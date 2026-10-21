package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestPushStreamRoute: an agent's own token opens its push stream, and nobody else's agent token does, its parent's
// included. The stream's connecting pushes the agent's unread mail, and a mail sent to the idle agent then reaches the
// stream as its next prompt. A daemon with no lifecycle answers 501.
func TestPushStreamRoute(t *testing.T) {
	f := newFixture(t, nil)
	if rec := f.do(call{method: "GET", path: "/api/agents/achild/stream", token: agentTok}); rec.Code != 501 {
		t.Errorf("no lifecycle: %d %s", rec.Code, rec.Body.String())
	}
	withLifeRoot(f, "../../..")
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'idle' WHERE id = 'achild'")
	ts := httptest.NewServer(f.srv)
	t.Cleanup(ts.Close)
	// Over HTTP with a deadline, so a stream that opens where it shouldn't fails the test instead of hanging it.
	open := func(token, path string, wait time.Duration) (*http.Response, *bufio.Reader) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), wait)
		t.Cleanup(cancel)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+path, nil)
		must(t, err)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Host = "127.0.0.1:7999"
		res, err := http.DefaultClient.Do(req)
		must(t, err)
		t.Cleanup(func() { res.Body.Close() })
		return res, bufio.NewReader(res.Body)
	}
	for _, tc := range []struct {
		name, token, path string
		status            int
		error             string
	}{
		{"an agent for another agent", agentTok, "/api/agents/aboss/stream", 403, "agent child can't act as aboss"},
		{"a parent for its child", bossTok, "/api/agents/achild/stream", 403, "agent boss can't act as achild"},
		{"an unknown agent", sharedTok, "/api/agents/anone/stream", 404, "no agent anone"},
	} {
		res, body := open(tc.token, tc.path, 5*time.Second)
		b, _ := io.ReadAll(body)
		if res.StatusCode != tc.status || !strings.Contains(string(b), tc.error) {
			t.Errorf("%s: %d %s", tc.name, res.StatusCode, b)
		}
	}

	res, lines := open(agentTok, "/api/agents/achild/stream", 20*time.Second)
	if line, _ := lines.ReadString('\n'); res.StatusCode != 200 || line != ": connected\n" || res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("stream: %d %q %s", res.StatusCode, line, res.Header.Get("Content-Type"))
	}
	next := func() string {
		t.Helper()
		for {
			line, err := lines.ReadString('\n')
			must(t, err)
			data, ok := strings.CutPrefix(line, "data: ")
			if !ok {
				continue
			}
			var p struct {
				Content string            `json:"content"`
				Meta    map[string]string `json:"meta"`
			}
			must(t, json.Unmarshal([]byte(data), &p))
			if p.Meta["kind"] != "mail" {
				t.Errorf("meta %v", p.Meta)
			}
			return p.Content
		}
	}
	// The connect's push: the mail the fixture left unread.
	if p := next(); !strings.HasPrefix(p, "[stam] You have 1 unread mail.") || !strings.HasSuffix(p, "\n- m1 from boss: s") {
		t.Fatalf("connect prompt %q", p)
	}
	rec := f.do(call{method: "POST", path: "/api/mail", token: bossTok, body: `{"from":"aboss","to":["achild"],"subject":"hello there","body":"b"}`})
	if rec.Code != 200 {
		t.Fatalf("send: %d %s", rec.Code, rec.Body.String())
	}
	var sent struct {
		ID string `json:"id"`
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &sent))
	if p := next(); !strings.HasPrefix(p, "[stam] You have 2 unread mail.") || !strings.Contains(p, "\n- "+sent.ID+" from boss: hello there\n") {
		t.Errorf("prompt %q", p)
	}
	// The push marks the mail it named.
	for end := time.Now().Add(20 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if left, err := f.db.Unpushed(context.Background(), "achild"); err == nil && len(left) == 0 {
			break
		}
		if time.Now().After(end) {
			t.Fatal("the pushed mail stayed unpushed")
		}
	}
}

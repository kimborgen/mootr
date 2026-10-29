package server

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
)

// logBuffer captures what the daemon logs while a test runs.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *logBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func captureLog(t *testing.T) *logBuffer {
	b := &logBuffer{}
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(b, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })
	return b
}

// TestStrictOffLogs: with auth.humanStrict off, a request with no `by` that only the old rule lets act is allowed and
// logged as one strict would refuse (S-2159), and a token-less browser write is logged with why it was refused (S-426).
// No credential is in a line.
func TestStrictOffLogs(t *testing.T) {
	log := captureLog(t)
	f := relayFixture(t, "http://127.0.0.1:1", "", nil)
	const off = "auth.humanStrict off (this was allowed; turning it on would refuse it): "
	f.do(call{method: "POST", path: "/api/agents/achild/set-child-notices", token: sharedTok, body: `{"child_notices":"none"}`})
	f.do(call{method: "POST", path: "/api/agents", token: sharedTok, body: `{"name":"x","harness":"nope"}`})
	rec := f.do(call{method: "POST", path: "/api/permissions/p000000/answer?token=" + sharedTok, header: map[string]string{"Origin": "https://other.example", "X-Stam-Human": "1"}, body: `{}`})
	if rec.Code != 401 {
		t.Fatalf("a token-less answer: %d %s", rec.Code, rec.Body)
	}
	out := log.String()
	for _, want := range []string{
		off + "agent control with no by",
		off + "spawn with no by",
		"direct request refused: POST /api/permissions/:id/answer origin=https://other.example: not trustedHuman",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("no line %q in\n%s", want, out)
		}
	}
	if strings.Contains(out, sharedTok) {
		t.Error("a token was logged")
	}
}

// TestStrictHint: under strict, a refusal of a request that claims the human without the proof tells the CLI to answer
// from the web UI; with strict off, or no claim, there's no hint.
func TestStrictHint(t *testing.T) {
	claim := map[string]string{"X-Stam-Human": "1"}
	for _, c := range []struct {
		name   string
		strict bool
		header map[string]string
		hint   bool
	}{
		{"strict, claiming the human", true, claim, true},
		{"strict, no claim", true, nil, false},
		{"strict off", false, claim, false},
	} {
		f := relayFixture(t, "http://127.0.0.1:1", map[bool]string{true: `"auth":{"humanStrict":true}`, false: ""}[c.strict], nil)
		rec := f.do(call{method: "POST", path: "/api/agents/achild/kill", token: sharedTok, header: c.header, body: `{}`})
		body := envelope(t, rec)
		if (c.strict && rec.Code != 403) || (body["hint"] == "answer from stam's web UI") != c.hint {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body)
		}
	}
}

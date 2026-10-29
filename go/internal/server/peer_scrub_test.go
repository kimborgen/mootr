package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"stam/internal/config"
)

// TestPeerRefusalScrubbed: a real call site end to end (S-3994). The ITSA home refuses an owner-stopped report with an
// error that echoes a token; ownerStopped logs the refusal, and the log says [redacted] for each token the call could
// expose: the home's shared, peer and lease tokens, and this daemon's own shared, peer and lease tokens. The lease GET to
// the settings home (mcpHomeGet), which reads its answer outside the peer client's Call, is scrubbed the same way.
func TestPeerRefusalScrubbed(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "mcp-lease-token"), "own-lease-value\n")
	logs := captureServerLogs(t)
	var echo atomic.Value
	home := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `{"error":"refused: Bearer `+echo.Load().(string)+` is unknown here"}`)
	}))
	t.Cleanup(home.Close)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"itsa":{"home":"farhome"},"peers":[{"name":"farhome","url":"`+home.URL+
		`","token":"far-shared-value","peerToken":"far-peer-value","leaseToken":"far-lease-value"}]}`)
	far := config.Peer{Name: "farhome", URL: home.URL, Token: "far-shared-value", PeerToken: "far-peer-value", LeaseToken: "far-lease-value"}
	for name, tok := range map[string]string{
		"the home's shared token": "far-shared-value", "the home's peer token": "far-peer-value", "the home's lease token": "far-lease-value",
		"our shared token": sharedTok, "our peer token": peerTok, "our lease token": "own-lease-value",
	} {
		echo.Store(tok)
		logs.Reset()
		f.srv.ownerStopped(context.Background(), "achild", "child", "errored")
		got := logs.String()
		if strings.Contains(got, tok) || !strings.Contains(got, "refused: Bearer [redacted] is unknown here") {
			t.Errorf("%s: the log reads %q", name, got)
		}
		status, body, err := f.srv.mcpHomeGet(context.Background(), far, "/api/peer/mcp/status")
		if err != nil || status != http.StatusForbidden || string(body) != `{"error":"refused: Bearer [redacted] is unknown here"}` {
			t.Errorf("%s: the lease GET answered %d %s %v", name, status, body, err)
		}
	}
	// The lease token rotated after the server started: the new one is redacted at once.
	writeFile(t, filepath.Join(f.home, "mcp-lease-token"), "rotated-lease-value\n")
	echo.Store("rotated-lease-value")
	logs.Reset()
	f.srv.ownerStopped(context.Background(), "achild", "child", "errored")
	if got := logs.String(); strings.Contains(got, "rotated-lease-value") || !strings.Contains(got, "refused: Bearer [redacted] is unknown here") {
		t.Errorf("a rotated lease token: the log reads %q", got)
	}
}

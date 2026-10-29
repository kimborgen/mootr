package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/config"
	"stam/internal/mcpauth"
)

const leaseSecret = "LEASE-SECRET-VALUE"

// leaseFixture is mcpFixture with the server shared with peers, a lease token on the home, and a grant that lives an hour.
func leaseFixture(t *testing.T) *fixture {
	t.Helper()
	f := mcpFixture(t)
	setMcpSettings(t, f, `{"mcpServers":{"prov":{"url":"https://srv.example/mcp","auth":{"type":"oauth"},"shareWithPeers":true}}}`)
	grant := `{"prov":{"server_url":"https://srv.example/mcp","client_id":"c","token_endpoint":"https://x.example/t","access_token":"LIVE-BEARER","expires_at":` + nowMsString(time.Hour) + `}}`
	must(t, os.WriteFile(filepath.Join(f.home, "mcp-auth.json"), []byte(grant), 0o600))
	must(t, os.WriteFile(filepath.Join(f.home, "mcp-lease-token"), []byte(leaseSecret+"\n"), 0o600))
	return f
}

// nowMsString is a time d from now, in ms since the epoch, as JSON number text.
func nowMsString(d time.Duration) string {
	return strconv.FormatInt(time.Now().Add(d).UnixMilli(), 10)
}

func leaseCall(f *fixture, method, path, token string) *httptest.ResponseRecorder {
	f.t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(""))
	r.Host = "127.0.0.1:7999"
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, r)
	return rec
}

// captureServerLogs sends the default slog logger to a buffer until the test ends.
func captureServerLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// The bearer: the lease token alone passes; no bearer is 401, anything else 403, and the peer and the shared token don't
// reach the routes (S-3176).
func TestPeerLeaseBearer(t *testing.T) {
	f := leaseFixture(t)
	if rec := leaseCall(f, http.MethodGet, "/api/peer/mcp/prov/lease", ""); rec.Code != 401 {
		t.Errorf("no bearer: %d %s", rec.Code, rec.Body.String())
	}
	for _, tok := range []string{sharedTok, peerTok, agentTok, "wrong"} {
		if rec := leaseCall(f, http.MethodGet, "/api/peer/mcp/prov/lease", tok); rec.Code != 403 || strings.Contains(rec.Body.String(), "LIVE-BEARER") {
			t.Errorf("bearer %q: %d %s", tok, rec.Code, rec.Body.String())
		}
	}
	if rec := leaseCall(f, http.MethodPost, "/api/peer/mcp/prov/lease", leaseSecret); rec.Code != 405 {
		t.Errorf("POST with the lease token: %d %s", rec.Code, rec.Body.String())
	}
}

// The lease: the url, the bearer and the expiry, and a log line naming the server, the caller and the expiry, never the
// token.
func TestPeerLeaseGrantAndLog(t *testing.T) {
	f := leaseFixture(t)
	logs := captureServerLogs(t)
	rec := leaseCall(f, http.MethodGet, "/api/peer/mcp/prov/lease", leaseSecret)
	if rec.Code != 200 {
		t.Fatalf("the lease: %d %s", rec.Code, rec.Body.String())
	}
	var got struct {
		URL         string  `json:"url"`
		AccessToken string  `json:"access_token"`
		ExpiresAt   float64 `json:"expires_at"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.URL != "https://srv.example/mcp" || got.AccessToken != "LIVE-BEARER" || got.ExpiresAt <= float64(time.Now().UnixMilli()) {
		t.Errorf("lease %+v", got)
	}
	if !strings.Contains(logs.String(), "mcp lease: prov to ") || !strings.Contains(logs.String(), "expires ") {
		t.Errorf("no lease log line: %s", logs.String())
	}
	if strings.Contains(logs.String(), "LIVE-BEARER") || strings.Contains(logs.String(), leaseSecret) {
		t.Errorf("a token reached the log: %s", logs.String())
	}
}

// Refusals reach the peer with the status and message the auth gives them, and an over-cap ?refresh=1 is refused before
// anything else.
func TestPeerLeaseRefusals(t *testing.T) {
	f := leaseFixture(t)
	if rec := leaseCall(f, http.MethodGet, "/api/peer/mcp/nosuch/lease", leaseSecret); rec.Code != 404 {
		t.Errorf("an unknown server: %d %s", rec.Code, rec.Body.String())
	}
	if rec := leaseCall(f, http.MethodGet, "/api/peer/mcp/no.such/lease", leaseSecret); rec.Code != 404 {
		t.Errorf("a name no route matches: %d %s", rec.Code, rec.Body.String())
	}
	setMcpSettings(t, f, `{"mcpServers":{"prov":{"url":"https://srv.example/mcp","auth":{"type":"oauth"}}}}`)
	if rec := leaseCall(f, http.MethodGet, "/api/peer/mcp/prov/lease", leaseSecret); rec.Code != 403 || !strings.Contains(rec.Body.String(), "shareWithPeers is off") {
		t.Errorf("a server not shared: %d %s", rec.Code, rec.Body.String())
	}
}

// A daemon that is not the settings home refuses the lease route, naming the home (S-3176).
func TestPeerLeaseNotTheHome(t *testing.T) {
	f := leaseFixture(t)
	setMcpSettings(t, f, `{"home":"far","mcpServers":{"prov":{"url":"https://srv.example/mcp","auth":{"type":"oauth"},"shareWithPeers":true}}}`)
	rec := leaseCall(f, http.MethodGet, "/api/peer/mcp/prov/lease", leaseSecret)
	if rec.Code != 409 || !strings.Contains(rec.Body.String(), `"home":"far"`) {
		t.Errorf("not the home: %d %s", rec.Code, rec.Body.String())
	}
}

// The status route on the home: the shared servers' rows, with no token.
func TestPeerLeaseStatus(t *testing.T) {
	f := leaseFixture(t)
	rec := leaseCall(f, http.MethodGet, "/api/peer/mcp/status", leaseSecret)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"name":"prov"`) || !strings.Contains(rec.Body.String(), `"logged_in":true`) {
		t.Errorf("status: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "LIVE-BEARER") || strings.Contains(rec.Body.String(), leaseSecret) {
		t.Errorf("status holds a token: %s", rec.Body.String())
	}

	// A server that isn't shared is left out, even with a live login: shareWithPeers decides the rows a peer sees.
	setMcpSettings(t, f, `{"mcpServers":{"prov":{"url":"https://srv.example/mcp","auth":{"type":"oauth"},"shareWithPeers":true},"hidden":{"url":"https://hid.example/mcp","auth":{"type":"oauth"}}}}`)
	grant := `{"prov":{"server_url":"https://srv.example/mcp","client_id":"c","token_endpoint":"https://x.example/t","access_token":"LIVE-BEARER","expires_at":` + nowMsString(time.Hour) + `},` +
		`"hidden":{"server_url":"https://hid.example/mcp","client_id":"c","token_endpoint":"https://x.example/t","access_token":"HIDDEN-BEARER","expires_at":` + nowMsString(time.Hour) + `}}`
	must(t, os.WriteFile(filepath.Join(f.home, "mcp-auth.json"), []byte(grant), 0o600))
	rec = leaseCall(f, http.MethodGet, "/api/peer/mcp/status", leaseSecret)
	if rec.Code != 200 || strings.Contains(rec.Body.String(), `"name":"hidden"`) || strings.Contains(rec.Body.String(), "HIDDEN-BEARER") {
		t.Errorf("status shows an unshared server: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"name":"prov"`) {
		t.Errorf("status lost the shared server: %s", rec.Body.String())
	}
}

// Rotation takes effect at once: the old lease token is refused on the next request, the new one is accepted.
func TestPeerLeaseRotation(t *testing.T) {
	f := leaseFixture(t)
	if rec := leaseCall(f, http.MethodGet, "/api/peer/mcp/prov/lease", leaseSecret); rec.Code != 200 {
		t.Fatalf("before rotation: %d", rec.Code)
	}
	must(t, mcpauth.RotateLeaseToken(f.home))
	if rec := leaseCall(f, http.MethodGet, "/api/peer/mcp/prov/lease", leaseSecret); rec.Code != 403 {
		t.Errorf("the old token after rotation: %d %s", rec.Code, rec.Body.String())
	}
	raw, err := os.ReadFile(filepath.Join(f.home, "mcp-lease-token"))
	must(t, err)
	if rec := leaseCall(f, http.MethodGet, "/api/peer/mcp/prov/lease", strings.TrimSpace(string(raw))); rec.Code != 200 {
		t.Errorf("the new token: %d %s", rec.Code, rec.Body.String())
	}
}

// The caller a lease is logged for: the remote address, or behind tailscale serve (loopback only) the last forwarded address.
func TestLeaseCallerNamesTheForwardedClient(t *testing.T) {
	cases := []struct {
		remote, xff, want string
	}{
		{"127.0.0.1:5555", "203.0.113.9, 198.51.100.4", "198.51.100.4"},
		{"198.51.100.7:5555", "203.0.113.9", "198.51.100.7"},
		{"127.0.0.1:5555", "", "127.0.0.1"},
		{"", "", "a peer"},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "/api/peer/mcp/prov/lease", nil)
		r.RemoteAddr = c.remote
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := leaseCaller(r); got != c.want {
			t.Errorf("leaseCaller(%q, xff %q) = %q, want %q", c.remote, c.xff, got, c.want)
		}
	}
}

// A peer's lease reaches its home over the daemon's own peer client: the home's lease route answers the lease token the
// peer sends, and the peer holds the lease in memory.
func TestPeerLeaseReachesTheHomeOverHTTP(t *testing.T) {
	home := leaseFixture(t)
	ts := httptest.NewServer(home.srv)
	t.Cleanup(ts.Close)
	peer := newFixture(t, map[string]string{"STAM_MACHINE": "peer-machine", "STAM_MCP_AUTH_INSECURE": "1"})
	setMcpSettings(t, peer, `{"home":"test-machine","peers":[{"name":"test-machine","url":"`+ts.URL+`","leaseToken":"`+leaseSecret+`"}],"mcpServers":{"prov":{"url":"https://srv.example/mcp","auth":{"type":"oauth"}}}}`)
	b, err := peer.srv.mcp.TokenFor(context.Background(), "prov", false)
	if err != nil {
		t.Fatalf("the peer's lease: %v", err)
	}
	if b.Token != "LIVE-BEARER" || b.URL != "https://srv.example/mcp" {
		t.Errorf("the peer's bearer %q for %q, want the home's lease", b.Token, b.URL)
	}
	if raw, err := os.ReadFile(filepath.Join(peer.home, "mcp-auth.json")); err == nil && strings.Contains(string(raw), "LIVE-BEARER") {
		t.Errorf("the lease reached the peer's store")
	}
}

// A redirect from the home is not followed: no second address gets a request, so none gets the lease token. The target
// is another port on the same host, and then a plain-http address reached from an https home (a downgrade).
func TestHomeGetNeverFollowsARedirect(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(target.Close)
	redirect := func(to string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, to+r.URL.Path, http.StatusFound) }
	}
	f := leaseFixture(t)

	plain := httptest.NewServer(redirect(target.URL))
	t.Cleanup(plain.Close)
	status, _, err := f.srv.mcpHomeGet(context.Background(), config.Peer{Name: "home", URL: plain.URL, PeerToken: leaseSecret}, "/api/peer/mcp/prov/lease")
	if err != nil || status != http.StatusFound {
		t.Errorf("another port: status %d, %v, want the redirect returned as it came", status, err)
	}

	tls := httptest.NewTLSServer(redirect(target.URL))
	t.Cleanup(tls.Close)
	saved := homeClient
	homeClient = tls.Client()
	homeClient.CheckRedirect = saved.CheckRedirect
	t.Cleanup(func() { homeClient = saved })
	status, _, err = f.srv.mcpHomeGet(context.Background(), config.Peer{Name: "home", URL: tls.URL, PeerToken: leaseSecret}, "/api/peer/mcp/prov/lease")
	if err != nil || status != http.StatusFound {
		t.Errorf("a downgrade: status %d, %v, want the redirect returned as it came", status, err)
	}
	if n := hits.Load(); n != 0 {
		t.Errorf("the redirect target got %d requests, want none", n)
	}
}

// A home that answers after five seconds still answers: the lease path has its own limit, and the home stays up.
func TestHomeGetAnswersAfterFiveSecondsAndStaysUp(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(5 * time.Second)
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(slow.Close)
	f := leaseFixture(t)
	status, _, err := f.srv.mcpHomeGet(context.Background(), config.Peer{Name: "home", URL: slow.URL, PeerToken: leaseSecret}, "/api/peer/mcp/status")
	if err != nil || status != http.StatusOK {
		t.Errorf("a five-second answer: status %d, %v", status, err)
	}
	if !f.srv.peers.Up("home") {
		t.Errorf("the home was marked down by a slow answer")
	}
}

// A home that never answers: the lease fails as unreachable once the client's limit passes, and the home stays up. The
// limit is shortened for the test; the production limit is checked to be TS peerCall's 8 s.
func TestPeerLeaseHomeThatNeverAnswers(t *testing.T) {
	if homeTimeout != 8*time.Second {
		t.Errorf("the home's limit is %v, want TS peerCall's 8 s", homeTimeout)
	}
	release := make(chan struct{})
	silent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(silent.Close)
	t.Cleanup(func() { close(release) }) // runs before silent.Close: cleanups run last in first
	saved := homeClient
	homeClient = &http.Client{Timeout: 200 * time.Millisecond, CheckRedirect: saved.CheckRedirect}
	t.Cleanup(func() { homeClient = saved })

	t.Setenv("STAM_MCP_AUTH_INSECURE", "1")
	peer := newFixture(t, map[string]string{"STAM_MACHINE": "peer-machine"})
	setMcpSettings(t, peer, `{"home":"test-machine","peers":[{"name":"test-machine","url":"`+silent.URL+`","leaseToken":"`+leaseSecret+`"}],"mcpServers":{"prov":{"url":"https://srv.example/mcp","auth":{"type":"oauth"}}}}`)
	start := time.Now()
	_, err := peer.srv.mcp.TokenFor(context.Background(), "prov", false)
	if err == nil || !strings.Contains(err.Error(), "is unreachable") {
		t.Errorf("a home that never answers: %v, want unreachable", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("the call took %v, want the client's limit", elapsed)
	}
	if !peer.srv.peers.Up("test-machine") {
		t.Errorf("the home was marked down by a timeout")
	}
}

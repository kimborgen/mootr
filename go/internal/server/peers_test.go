package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"stam/internal/config"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// The peers client talks to a real Go daemon over a socket as a peer: the peer token is accepted, x-stam-local is honoured
// from it and from nothing else, and the agent it forwards is the one the daemon acts for.
func TestPeersClientToAGoDaemon(t *testing.T) {
	f := newFixture(t, nil)
	ts := httptest.NewServer(f.srv)
	t.Cleanup(ts.Close)
	// httptest names the host 127.0.0.1:port; the daemon's own-host check applies to owner requests only.
	mk := func(token, peerToken string) (*peers.Client, config.Peer) {
		p := config.Peer{Name: "far", URL: ts.URL, Token: config.Secret(token), PeerToken: config.Secret(peerToken)}
		return peers.New(peers.Options{Settings: func() config.Settings { return config.Settings{Peers: []config.Peer{p}} }, Machine: "here"}), p
	}
	ctx := context.Background()

	c, p := mk(sharedTok, peerTok)
	r, err := c.Call(ctx, p, http.MethodGet, "/api/agents", nil, peers.DefaultTimeout, false, nil)
	if err != nil || r.Status != 200 || r.Data.Kind != jsfmt.Array || len(r.Data.Items) == 0 {
		t.Fatalf("agents as a peer: %+v %v", r, err)
	}
	if rows := c.FanOut(ctx, "/api/agents", nil); len(rows) != len(r.Data.Items) {
		t.Errorf("fan-out gave %d agents, a call %d", len(rows), len(r.Data.Items))
	}
	if err := c.EnsureUp(p); err != nil {
		t.Errorf("EnsureUp on a daemon that answers: %v", err)
	}
	// The agent a peer forwards is the one the daemon acts for (the event stream is refused to an agent's token).
	r, err = c.Call(ctx, p, http.MethodGet, "/api/live", nil, peers.DefaultTimeout, false, &peers.Via{Agent: "achild"})
	if err != nil || r.Status != 403 || !strings.Contains(r.Data.Text("error"), "an agent's token can't") {
		t.Errorf("a forwarded agent: %+v %v", r, err)
	}
	// The shared token as the bearer sends the peer headers: refused, and the refusal names no token.
	c2, p2 := mk(sharedTok, "")
	r, err = c2.Call(ctx, p2, http.MethodGet, "/api/agents", nil, peers.DefaultTimeout, false, nil)
	if err != nil || r.Status != 403 || !strings.Contains(r.Data.Text("error"), "peer headers need the peer token") {
		t.Errorf("the shared token with x-stam-local: %+v %v", r, err)
	}
	if strings.Contains(jsfmt.Compact(r.Data), sharedTok) {
		t.Error("a refusal quotes the token")
	}
	// A daemon that is gone is down, and a list skips it.
	ts.Close()
	if _, err := c.Call(ctx, p, http.MethodGet, "/api/agents", nil, time.Second, false, nil); err == nil || c.Up("far") {
		t.Errorf("a stopped daemon: %v up %v", err, c.Up("far"))
	}
	if _, bad := c.FanOutReport(ctx, "/api/agents", nil); !bad {
		t.Error("a list over a stopped daemon did not say unreachable")
	}
}

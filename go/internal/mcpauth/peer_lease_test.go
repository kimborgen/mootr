package mcpauth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// homeReply is one answer of a scripted home: a status and body, or an error when the home doesn't answer.
type homeReply struct {
	status int
	body   string
	err    error
}

// leaseHome is a scripted settings home. Each request gets the next reply, and the last one repeats. It records the path
// and the bearer of each request. With gate set, a request waits until the test closes it; arrived is told when one comes.
type leaseHome struct {
	replies []homeReply
	gate    chan struct{}
	arrived chan struct{}

	mu      sync.Mutex
	paths   []string
	bearers []string
}

func (h *leaseHome) get(ctx context.Context, p config.Peer, path string) (int, []byte, error) {
	h.mu.Lock()
	h.paths = append(h.paths, path)
	h.bearers = append(h.bearers, p.Bearer())
	i := len(h.paths) - 1
	h.mu.Unlock()
	if h.arrived != nil {
		h.arrived <- struct{}{}
	}
	if h.gate != nil {
		select {
		case <-h.gate:
		case <-ctx.Done():
			return 0, nil, ctx.Err()
		}
	}
	r := h.replies[len(h.replies)-1]
	if i < len(h.replies) {
		r = h.replies[i]
	}
	return r.status, []byte(r.body), r.err
}

func (h *leaseHome) requests() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.paths...)
}

// peerFixture is a peer (machine peer) whose settings home is home, with leaseToken as its lease token and the scripted
// home as its answers. The server is oneServer(srvURL).
func peerFixture(t *testing.T, h *leaseHome, leaseToken string) *fixture {
	t.Helper()
	f := &fixture{t: t}
	f.settings = config.Settings{
		Home:       "home",
		McpServers: mustParse(t, oneServer(srvURL)),
		Peers:      []config.Peer{{Name: "home", URL: "https://home.example", LeaseToken: config.Secret(leaseToken)}},
	}
	f.a = New(Options{Home: t.TempDir(), Machine: "peer", Settings: func() config.Settings { return f.settings }, Insecure: true, HomeGet: h.get})
	return f
}

// leaseBody is the home's answer to a lease: the url, the bearer, and when the bearer expires (ms).
func leaseBody(url, token string, expires float64) string {
	return fmt.Sprintf(`{"url":%q,"access_token":%q,"expires_at":%.0f}`, url, token, expires)
}

// inAnHour is an expiry an hour from now, in ms, as the home sends it.
func inAnHour() float64 { return float64(time.Now().Add(time.Hour).UnixMilli()) }

// A peer's bearer is the home's lease: the url and the bearer come with the expiry, the request carries the lease token,
// and nothing is written to the store.
func TestPeerLeaseGrantsTheHomesBearer(t *testing.T) {
	exp := inAnHour()
	h := &leaseHome{replies: []homeReply{{status: http.StatusOK, body: leaseBody(srvURL, "LEASED-1", exp)}}}
	f := peerFixture(t, h, "LEASE-SECRET")
	b, err := f.a.TokenFor(context.Background(), "prov", false)
	if err != nil {
		t.Fatalf("TokenFor: %v", err)
	}
	if b.Token != "LEASED-1" || b.URL != srvURL || b.ExpiresAt == nil || *b.ExpiresAt != exp {
		t.Errorf("bearer %+v, want the home's lease", b)
	}
	if got := h.requests(); len(got) != 1 || got[0] != "/api/peer/mcp/prov/lease" {
		t.Errorf("requests %v, want one lease request", got)
	}
	if h.bearers[0] != "LEASE-SECRET" {
		t.Errorf("the request carried %q, want the lease token from settings.peers", h.bearers[0])
	}
	if _, err := os.Stat(filepath.Join(f.a.opt.Home, "mcp-auth.json")); !os.IsNotExist(err) {
		t.Errorf("the lease reached the store: %v", err)
	}
}

// A copy of a lease serves until 60 s before it expires; a forced ask goes to the home again.
func TestPeerLeaseIsKeptUntilItsMargin(t *testing.T) {
	h := &leaseHome{replies: []homeReply{{status: http.StatusOK, body: leaseBody(srvURL, "LEASED-1", inAnHour())}}}
	f := peerFixture(t, h, "LEASE-SECRET")
	for i := 0; i < 2; i++ {
		if _, err := f.a.TokenFor(context.Background(), "prov", false); err != nil {
			t.Fatal(err)
		}
	}
	if got := h.requests(); len(got) != 1 {
		t.Errorf("%d home requests for two asks, want 1: %v", len(got), got)
	}
	if _, err := f.a.TokenFor(context.Background(), "prov", true); err != nil {
		t.Fatal(err)
	}
	if got := h.requests(); len(got) != 2 || got[1] != "/api/peer/mcp/prov/lease?refresh=1" {
		t.Errorf("a forced ask requested %v, want the refresh", got)
	}
}

// A lease that expires within the margin is not kept, so the next ask goes to the home.
func TestPeerLeaseNearExpiryIsAskedAgain(t *testing.T) {
	soon := float64(time.Now().Add(30 * time.Second).UnixMilli())
	h := &leaseHome{replies: []homeReply{{status: http.StatusOK, body: leaseBody(srvURL, "LEASED-1", soon)}}}
	f := peerFixture(t, h, "LEASE-SECRET")
	for i := 0; i < 2; i++ {
		if _, err := f.a.TokenFor(context.Background(), "prov", false); err != nil {
			t.Fatal(err)
		}
	}
	if got := h.requests(); len(got) != 2 {
		t.Errorf("%d home requests for two asks of a lease inside its margin, want 2", len(got))
	}
}

// waitJoined waits until n asks have joined the fetch of key, so each one is waiting on the fetch when the home answers.
func waitJoined(t *testing.T, a *Auth, key string, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		a.leaseMu.Lock()
		joined := 0
		if f := a.leasing[key]; f != nil {
			joined = f.joined
		}
		a.leaseMu.Unlock()
		if joined >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d asks joined the fetch, want %d", joined, n)
		}
		time.Sleep(time.Millisecond)
	}
}

// askBearer is TokenFor's answer for the test server, as an error when the bearer is not the one the test leases.
func askBearer(a *Auth, ctx context.Context, want string) error {
	b, err := a.TokenFor(ctx, "prov", false)
	if err == nil && b.Token != want {
		err = fmt.Errorf("token %q, want %q", b.Token, want)
	}
	return err
}

// Asks that come while one fetch from the home runs share that fetch: the home is asked once.
func TestPeerLeaseSingleFlight(t *testing.T) {
	h := &leaseHome{
		replies: []homeReply{{status: http.StatusOK, body: leaseBody(srvURL, "LEASED-1", inAnHour())}},
		gate:    make(chan struct{}),
		arrived: make(chan struct{}, 16),
	}
	f := peerFixture(t, h, "LEASE-SECRET")
	const asks = 5
	results := make(chan error, asks)
	go func() { results <- askBearer(f.a, context.Background(), "LEASED-1") }()
	<-h.arrived // the home has the request
	for i := 1; i < asks; i++ {
		go func() { results <- askBearer(f.a, context.Background(), "LEASED-1") }()
	}
	waitJoined(t, f.a, "prov\n"+srvURL, asks-1)
	close(h.gate)
	for i := 0; i < asks; i++ {
		if err := <-results; err != nil {
			t.Errorf("ask %d: %v", i, err)
		}
	}
	if got := h.requests(); len(got) != 1 {
		t.Errorf("%d home requests for %d concurrent asks, want 1", len(got), asks)
	}
}

// The first caller going away doesn't cancel the fetch: the others still get the bearer, and the caller that went away
// gets its own cancellation.
func TestPeerLeaseFirstCallerCancelledOthersStillGetTheBearer(t *testing.T) {
	h := &leaseHome{
		replies: []homeReply{{status: http.StatusOK, body: leaseBody(srvURL, "LEASED-1", inAnHour())}},
		gate:    make(chan struct{}),
		arrived: make(chan struct{}, 16),
	}
	f := peerFixture(t, h, "LEASE-SECRET")
	ctxA, cancelA := context.WithCancel(context.Background())
	aErr := make(chan error, 1)
	go func() {
		_, err := f.a.TokenFor(ctxA, "prov", false)
		aErr <- err
	}()
	<-h.arrived
	bErr := make(chan error, 1)
	go func() { bErr <- askBearer(f.a, context.Background(), "LEASED-1") }()
	waitJoined(t, f.a, "prov\n"+srvURL, 1)
	cancelA()
	if err := <-aErr; !errors.Is(err, context.Canceled) {
		t.Errorf("the cancelled caller returned %v, want its own context.Canceled", err)
	}
	close(h.gate)
	if err := <-bErr; err != nil {
		t.Errorf("the other caller: %v", err)
	}
	if got := h.requests(); len(got) != 1 {
		t.Errorf("%d home requests, want 1: the cancelled caller must not cancel the fetch", len(got))
	}
}

// A failed fetch isn't kept: the next ask goes to the home again and gets the lease.
func TestPeerLeaseFailedFetchIsNotKept(t *testing.T) {
	h := &leaseHome{replies: []homeReply{
		{status: http.StatusInternalServerError, body: `{}`},
		{status: http.StatusOK, body: leaseBody(srvURL, "LEASED-1", inAnHour())},
	}}
	f := peerFixture(t, h, "LEASE-SECRET")
	if _, err := f.a.TokenFor(context.Background(), "prov", false); err == nil {
		t.Fatal("the failed fetch answered a bearer")
	}
	if err := askBearer(f.a, context.Background(), "LEASED-1"); err != nil {
		t.Errorf("the next ask: %v", err)
	}
	if got := h.requests(); len(got) != 2 {
		t.Errorf("%d home requests, want 2: a failure must not be kept", len(got))
	}
}

// A lease whose expiry is already past is refused, and not kept: the next ask goes to the home again.
func TestPeerLeaseRefusesAnExpiredLease(t *testing.T) {
	past := float64(time.Now().Add(-time.Second).UnixMilli())
	h := &leaseHome{replies: []homeReply{
		{status: http.StatusOK, body: leaseBody(srvURL, "EXPIRED", past)},
		{status: http.StatusOK, body: leaseBody(srvURL, "LEASED-1", inAnHour())},
	}}
	f := peerFixture(t, h, "LEASE-SECRET")
	b, err := f.a.TokenFor(context.Background(), "prov", false)
	if err == nil || !strings.Contains(err.Error(), "already expired") || b.Token != "" {
		t.Errorf("an expired lease answered %+v, %v", b, err)
	}
	if err := askBearer(f.a, context.Background(), "LEASED-1"); err != nil {
		t.Errorf("the next ask: %v", err)
	}
	if got := h.requests(); len(got) != 2 {
		t.Errorf("%d home requests, want 2: an expired lease must not be kept", len(got))
	}
}

// A lease for another url is dropped, and the home is asked once more; the second lease names the settings url.
func TestPeerLeaseForAnotherURLIsAskedOnce(t *testing.T) {
	h := &leaseHome{replies: []homeReply{
		{status: http.StatusOK, body: leaseBody("https://other.example/mcp", "WRONG", inAnHour())},
		{status: http.StatusOK, body: leaseBody(srvURL, "RIGHT", inAnHour())},
	}}
	f := peerFixture(t, h, "LEASE-SECRET")
	b, err := f.a.TokenFor(context.Background(), "prov", false)
	if err != nil {
		t.Fatalf("TokenFor: %v", err)
	}
	if b.Token != "RIGHT" {
		t.Errorf("token %q, want the lease for the settings url", b.Token)
	}
	if got := h.requests(); len(got) != 2 || got[1] != "/api/peer/mcp/prov/lease?refresh=1" {
		t.Errorf("requests %v, want the lease and one refresh", got)
	}
}

// When the second lease names another url too, no bearer is returned: both urls are named, and no token is.
func TestPeerLeaseTwoOtherURLsAreRefused(t *testing.T) {
	other := leaseBody("https://other.example/mcp", "NEVER-USED", inAnHour())
	h := &leaseHome{replies: []homeReply{{status: http.StatusOK, body: other}}}
	f := peerFixture(t, h, "LEASE-SECRET")
	b, err := f.a.TokenFor(context.Background(), "prov", false)
	if err == nil || !strings.Contains(err.Error(), "https://other.example/mcp") || !strings.Contains(err.Error(), srvURL) {
		t.Fatalf("TokenFor answered %v, want a refusal naming both urls", err)
	}
	if b.Token != "" || strings.Contains(err.Error(), "NEVER-USED") {
		t.Errorf("a bearer for another url was returned: %+v, %v", b, err)
	}
}

// Each refusal of the home names what to check, and no answer carries the lease token.
func TestPeerLeaseRefusalsNameTheFix(t *testing.T) {
	cases := []struct {
		name  string
		reply homeReply
		want  string
	}{
		{"unauthorized", homeReply{status: http.StatusUnauthorized, body: `{"error":"bad token"}`}, "home refused the lease token (401: bad token)"},
		{"forbidden", homeReply{status: http.StatusForbidden, body: `{}`}, "home refused the lease token (403)"},
		{"over the cap", homeReply{status: http.StatusConflict, body: `{"error":"over the cap"}`}, "home has no lease for it: over the cap. Re-login or refresh on home, then retry"},
		{"server error", homeReply{status: http.StatusInternalServerError}, "home answered 500"},
		{"unreachable", homeReply{err: errors.New("connection refused")}, "the home home is unreachable"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := &leaseHome{replies: []homeReply{c.reply}}
			f := peerFixture(t, h, "LEASE-SECRET")
			_, err := f.a.TokenFor(context.Background(), "prov", false)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("answered %v, want %q", err, c.want)
			}
			if err != nil && strings.Contains(err.Error(), "LEASE-SECRET") {
				t.Errorf("the lease token reached the error: %v", err)
			}
		})
	}
}

// A peer with no settings.peers entry for its home, or no lease token in it, is told what to add.
func TestPeerLeaseNeedsItsHomeEntry(t *testing.T) {
	h := &leaseHome{replies: []homeReply{{status: http.StatusOK, body: leaseBody(srvURL, "X", inAnHour())}}}
	f := peerFixture(t, h, "LEASE-SECRET")
	f.settings.Peers = nil
	if _, err := f.a.TokenFor(context.Background(), "prov", false); err == nil || !strings.Contains(err.Error(), "isn't in settings.peers") {
		t.Errorf("no entry answered %v", err)
	}
	f.settings.Peers = []config.Peer{{Name: "home", URL: "https://home.example"}}
	if _, err := f.a.TokenFor(context.Background(), "prov", false); err == nil || !strings.Contains(err.Error(), "leaseToken is missing; copy the value of STAM_HOME/mcp-lease-token from home") {
		t.Errorf("no lease token answered %v", err)
	}
	if got := h.requests(); len(got) != 0 {
		t.Errorf("the home was asked without a lease token: %v", got)
	}
}

// The status lists the home's shared rows, each marked leased from the home, and the home reachable.
func TestPeerStatusMarksTheHomesRows(t *testing.T) {
	exp := inAnHour()
	body := fmt.Sprintf(`{"servers":[{"name":"prov","type":"oauth","logged_in":true,"expires_at":%.0f}]}`, exp)
	h := &leaseHome{replies: []homeReply{{status: http.StatusOK, body: body}}}
	f := peerFixture(t, h, "LEASE-SECRET")
	st, err := f.a.Rows(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := jsjson.Stringify(jsjson.NewObject("servers", st.Servers, "home", st.Home), "")
	if !strings.Contains(out, `"leased_from":"home"`) || !strings.Contains(out, `"logged_in":true`) || !strings.Contains(out, `"reachable":true`) {
		t.Errorf("status %s, want the home's row leased from home and the home reachable", out)
	}
	if got := h.requests(); len(got) != 1 || got[0] != "/api/peer/mcp/status" || h.bearers[0] != "LEASE-SECRET" {
		t.Errorf("requests %v with bearers %v, want one status request with the lease token", got, h.bearers)
	}
}

// A home that refuses or doesn't answer leaves its rows out and says why; the peer's own rows stay.
func TestPeerStatusReportsAHomeThatDoesNotAnswer(t *testing.T) {
	cases := []struct {
		name  string
		reply homeReply
		want  string
	}{
		{"refused", homeReply{status: http.StatusForbidden, body: `{}`}, "refused the lease token"},
		{"unreachable", homeReply{err: errors.New("connection refused")}, "is unreachable"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := &leaseHome{replies: []homeReply{c.reply}}
			f := peerFixture(t, h, "LEASE-SECRET")
			st, err := f.a.Rows(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			out := jsjson.Stringify(jsjson.NewObject("servers", st.Servers, "home", st.Home), "")
			if !strings.Contains(out, `"reachable":false`) || !strings.Contains(out, c.want) || strings.Contains(out, `"logged_in":true`) {
				t.Errorf("status %s, want the home unreachable with %q and no login", out, c.want)
			}
		})
	}
}

// A peer's logout deletes the grant it still holds from before the lease, and nothing else.
func TestPeerLogoutDeletesItsOwnGrant(t *testing.T) {
	h := &leaseHome{replies: []homeReply{{status: http.StatusOK, body: leaseBody(srvURL, "X", inAnHour())}}}
	f := peerFixture(t, h, "LEASE-SECRET")
	f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","token_endpoint":"https://x.example/t","access_token":"LOCAL-OLD","expires_at":9999999999999}`)
	if err := f.a.Logout("prov"); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if _, ok := f.a.storedGrant("prov"); ok {
		t.Errorf("the peer kept its old grant after logout")
	}
}

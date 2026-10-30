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
	// A cancelled request fails before the gate, so a test whose fetch runs on a cancelled context fails every time.
	if err := ctx.Err(); err != nil {
		return 0, nil, err
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
	if b.Token != "LEASED-1" {
		t.Errorf("TokenFor answered %s, want the home's lease", tokenDiff(b.Token, "LEASED-1"))
	}
	if b.URL != srvURL || b.ExpiresAt == nil || *b.ExpiresAt != exp {
		t.Errorf("bearer url %s, expiry %v, want the home's lease", b.URL, b.ExpiresAt)
	}
	if got := h.requests(); len(got) != 1 || got[0] != "/api/peer/mcp/prov/lease" {
		t.Errorf("requests %v, want one lease request", got)
	}
	if h.bearers[0] != "LEASE-SECRET" {
		t.Errorf("the request carried %s, want the lease token from settings.peers", tokenDiff(h.bearers[0], "LEASE-SECRET"))
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
		err = fmt.Errorf("TokenFor answered %s", tokenDiff(b.Token, want))
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
		t.Errorf("an expired lease answered %s", tokenResult{b.Token, err})
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
		t.Errorf("TokenFor answered %s, want the lease for the settings url", tokenDiff(b.Token, "RIGHT"))
	}
	if got := h.requests(); len(got) != 2 || got[1] != "/api/peer/mcp/prov/lease" {
		t.Errorf("requests %v, want the lease and one plain re-ask (S-3472)", got)
	}
}

// When the second lease names another url too, no bearer is returned: this machine's url is named, and neither the
// token nor the home's url is, since that url may carry a credential (S-4416).
func TestPeerLeaseTwoOtherURLsAreRefused(t *testing.T) {
	other := leaseBody("https://other.example/mcp?access_token=URL-SECRET", "NEVER-USED-SECRET", inAnHour())
	h := &leaseHome{replies: []homeReply{{status: http.StatusOK, body: other}}}
	f := peerFixture(t, h, "LEASE-SECRET")
	for _, ask := range []func() (string, error){
		func() (string, error) {
			b, err := f.a.TokenFor(context.Background(), "prov", false)
			return b.Token, err
		},
		func() (string, error) { return f.a.Token(context.Background(), "prov", true) },
	} {
		tok, err := ask()
		if err == nil || tok != "" {
			t.Fatalf("answered %s, want a refusal", tokenResult{tok, err})
		}
		noSecret(t, "the mismatch error", err.Error())
		if !strings.Contains(err.Error(), "the home leases a token for another url, but this machine's settings name "+srvURL) {
			t.Errorf("the mismatch error doesn't name this machine's url")
		}
		if strings.Contains(err.Error(), "other.example") {
			t.Errorf("the mismatch error names the home's url")
		}
	}
}

// homeRefusal is a home's refusal body with error text msg, as its lease route sends it.
func homeRefusal(msg string) string {
	return jsjson.Stringify(jsjson.NewObject("error", msg), "")
}

// Each refusal of the home names what to check, with the home's cause in this machine's words when it is a known one,
// and no answer carries the lease token.
func TestPeerLeaseRefusalsNameTheFix(t *testing.T) {
	cases := []struct {
		name  string
		reply homeReply
		want  string
	}{
		{"no bearer", homeReply{status: http.StatusUnauthorized, body: homeRefusal("the MCP lease route needs the lease token as a Bearer")}, "home refused the lease token (401: the MCP lease route needs the lease token as a Bearer)"},
		{"wrong token", homeReply{status: http.StatusForbidden, body: homeRefusal("not the lease token")}, "home refused the lease token (403: not the lease token)"},
		{"not shared", homeReply{status: http.StatusForbidden, body: homeRefusal("prov is not shared with peers (shareWithPeers is off)")}, "home refused the lease token (403: prov is not shared with peers (shareWithPeers is off))"},
		{"forbidden", homeReply{status: http.StatusForbidden, body: `{}`}, "home refused the lease token (403)"},
		{"no server", homeReply{status: http.StatusNotFound, body: homeRefusal("no MCP server named prov")}, "home answered 404: no MCP server named prov"},
		{"gh", homeReply{status: http.StatusBadRequest, body: homeRefusal("prov uses gh; a peer uses its own gh login")}, "home answered 400: prov uses gh; a peer uses its own gh login"},
		{"not logged in", homeReply{status: http.StatusConflict, body: homeRefusal("prov is not logged in on this home")}, "home has no lease for it: prov is not logged in on this home. Re-login or refresh on home, then retry"},
		{"never expires", homeReply{status: http.StatusConflict, body: homeRefusal("prov's grant never expires, so it is not leased")}, "home has no lease for it: prov's grant never expires, so it is not leased."},
		{"ends soon", homeReply{status: http.StatusConflict, body: homeRefusal("prov's grant ends within a minute, so it is not leased")}, "home has no lease for it: prov's grant ends within a minute, so it is not leased."},
		{"bad cap", homeReply{status: http.StatusConflict, body: homeRefusal("prov's leaseMaxSeconds must be a positive integer (settings mcpServers.prov.leaseMaxSeconds)")}, "prov's leaseMaxSeconds must be a positive integer"},
		{"over the cap", homeReply{status: http.StatusConflict, body: homeRefusal("prov's token lives 7200 s, over the 3600 s cap: the provider issues longer-lived tokens than peers accept (settings mcpServers.prov.leaseMaxSeconds)")}, "home has no lease for it: prov's token lives longer than the lease cap: the provider issues longer-lived tokens than peers accept (settings mcpServers.prov.leaseMaxSeconds)."},
		{"not the home", homeReply{status: http.StatusConflict, body: homeRefusal("home is not the settings home; MCP leases come from other")}, "home has no lease for it: it is not the settings home"},
		{"provider failed", homeReply{status: http.StatusBadGateway, body: homeRefusal("prov: the home could not get a token (token endpoint answered 400)")}, "home answered 502: the home could not get a token from the provider; see the home's log"},
		{"unknown cause", homeReply{status: http.StatusConflict, body: homeRefusal("over the cap")}, "home has no lease for it. Re-login or refresh on home, then retry"},
		{"cause on another status", homeReply{status: http.StatusInternalServerError, body: homeRefusal("prov is not logged in on this home")}, "home answered 500"},
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
				t.Errorf("the lease token reached the error")
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
		t.Errorf("the status lacks the home's row leased from home or the home reachable")
	}
	if got := h.requests(); len(got) != 1 || got[0] != "/api/peer/mcp/status" || h.bearers[0] != "LEASE-SECRET" {
		t.Errorf("requests %v, want one status request with the lease token", got)
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
				t.Errorf("the status doesn't show the home unreachable with %q and no login", c.want)
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

// waitQueued waits until n forced asks wait on the fetch queued behind the running fetch of key (S-3472). The count is
// taken under leaseMu in the same critical section that puts the ask on the queued fetch, so each one is past any
// choice of fetch and waits on that one's done.
func waitQueued(t *testing.T, a *Auth, key string, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		a.leaseMu.Lock()
		joined := 0
		if f := a.leasing[key]; f != nil && f.queued != nil {
			joined = f.queued.joined
		}
		a.leaseMu.Unlock()
		if joined >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d forced asks wait on the queued fetch, want %d", joined, n)
		}
		time.Sleep(time.Millisecond)
	}
}

// askToken is TokenFor's bearer for the test server, forced or not.
func askToken(a *Auth, ctx context.Context, force bool) (string, error) {
	b, err := a.TokenFor(ctx, "prov", force)
	return b.Token, err
}

type tokenResult struct {
	token string
	err   error
}

// String shows a result without its token, so a failing test prints no bearer.
func (r tokenResult) String() string {
	return fmt.Sprintf("{a %d-byte token, err %v}", len(r.token), r.err)
}

// tokenDiff says how a token differs from the one wanted without printing either, so a failing test prints no bearer.
func tokenDiff(got, want string) string {
	if got == "" {
		return "no token"
	}
	return fmt.Sprintf("a %d-byte token that differs from the %d-byte one wanted", len(got), len(want))
}

func goAsk(a *Auth, ctx context.Context, force bool) chan tokenResult {
	c := make(chan tokenResult, 1)
	go func() {
		tok, err := askToken(a, ctx, force)
		c <- tokenResult{tok, err}
	}()
	return c
}

// A forced ask that comes while a non-forced fetch runs never gets that fetch's lease: it waits for it, then fetches
// again, and the newer lease is the one the cache serves after (S-3472).
func TestPeerLeaseForcedAskDuringAFetchGetsANewerLease(t *testing.T) {
	h := &leaseHome{
		replies: []homeReply{
			{status: http.StatusOK, body: leaseBody(srvURL, "BEARER-OLD", inAnHour())},
			{status: http.StatusOK, body: leaseBody(srvURL, "BEARER-NEW", inAnHour())},
		},
		gate:    make(chan struct{}),
		arrived: make(chan struct{}, 16),
	}
	f := peerFixture(t, h, "LEASE-SECRET")
	plain := goAsk(f.a, context.Background(), false)
	<-h.arrived
	fresh := goAsk(f.a, context.Background(), true)
	waitQueued(t, f.a, "prov\n"+srvURL, 1)
	if got := h.requests(); len(got) != 1 {
		t.Fatalf("the forced ask fetched while the first fetch ran: %v", got)
	}
	close(h.gate)
	if r := <-plain; r.err != nil || r.token != "BEARER-OLD" {
		t.Errorf("the plain ask: %s", r)
	}
	if r := <-fresh; r.err != nil || r.token != "BEARER-NEW" {
		t.Errorf("the forced ask got %s, want the newer lease, not the one of the fetch it came during", r)
	}
	if got := h.requests(); len(got) != 2 || got[0] != "/api/peer/mcp/prov/lease" || got[1] != "/api/peer/mcp/prov/lease?refresh=1" {
		t.Errorf("requests %v, want the lease and then one refresh", got)
	}
	if tok, err := askToken(f.a, context.Background(), false); err != nil || tok != "BEARER-NEW" {
		t.Errorf("the cache serves %s, want the newer lease", tokenResult{tok, err})
	}
}

// Non-forced asks during a fetch share it; forced ones during it share the one forced fetch after it: two fetches for
// any number of asks (S-3472). Five forced asks at once make two, as test/e2e-mcp-lease-peer.sh checks.
func TestPeerLeaseForcedAsksShareTheNextFetch(t *testing.T) {
	cases := []struct {
		name          string
		first         bool // whether the first ask is forced
		plain, forced int
	}{
		{"two plain and two forced during a plain fetch", false, 2, 2},
		{"four forced during a forced fetch", true, 0, 4},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := &leaseHome{
				replies: []homeReply{
					{status: http.StatusOK, body: leaseBody(srvURL, "BEARER-FIRST", inAnHour())},
					{status: http.StatusOK, body: leaseBody(srvURL, "BEARER-SECOND", inAnHour())},
				},
				gate:    make(chan struct{}),
				arrived: make(chan struct{}, 16),
			}
			f := peerFixture(t, h, "LEASE-SECRET")
			key := "prov\n" + srvURL
			first := goAsk(f.a, context.Background(), c.first)
			<-h.arrived
			var plains, forced []chan tokenResult
			for i := 0; i < c.plain; i++ {
				plains = append(plains, goAsk(f.a, context.Background(), false))
			}
			for i := 0; i < c.forced; i++ {
				forced = append(forced, goAsk(f.a, context.Background(), true))
			}
			waitJoined(t, f.a, key, c.plain)
			waitQueued(t, f.a, key, c.forced)
			close(h.gate)
			for i, ch := range append([]chan tokenResult{first}, plains...) {
				if r := <-ch; r.err != nil || r.token != "BEARER-FIRST" {
					t.Errorf("ask %d of the first fetch: %s", i, r)
				}
			}
			for i, ch := range forced {
				if r := <-ch; r.err != nil || r.token != "BEARER-SECOND" {
					t.Errorf("forced ask %d: %s, want the second fetch's lease", i, r)
				}
			}
			if got := h.requests(); len(got) != 2 || got[1] != "/api/peer/mcp/prov/lease?refresh=1" {
				t.Errorf("requests %v, want two: the running fetch and one forced fetch after it", got)
			}
		})
	}
}

// The forced ask that queued the next fetch going away doesn't cancel it: it runs apart from every caller, and the
// asks that joined it get its lease.
func TestPeerLeaseQueuedFetchOutlivesTheAskThatQueuedIt(t *testing.T) {
	h := &leaseHome{
		replies: []homeReply{
			{status: http.StatusOK, body: leaseBody(srvURL, "BEARER-OLD", inAnHour())},
			{status: http.StatusOK, body: leaseBody(srvURL, "BEARER-NEW", inAnHour())},
		},
		gate:    make(chan struct{}),
		arrived: make(chan struct{}, 16),
	}
	f := peerFixture(t, h, "LEASE-SECRET")
	key := "prov\n" + srvURL
	plain := goAsk(f.a, context.Background(), false)
	<-h.arrived
	ctxA, cancelA := context.WithCancel(context.Background())
	a := goAsk(f.a, ctxA, true)
	waitQueued(t, f.a, key, 1)
	b := goAsk(f.a, context.Background(), true)
	waitQueued(t, f.a, key, 2)
	cancelA()
	if r := <-a; !errors.Is(r.err, context.Canceled) {
		t.Errorf("the ask that went away returned %s, want its own context.Canceled", r)
	}
	close(h.gate)
	<-plain
	if r := <-b; r.err != nil || r.token != "BEARER-NEW" {
		t.Errorf("the ask that joined the queued fetch: %s", r)
	}
}

// A non-forced ask during a forced fetch joins it, and a forced fetch queued behind a plain one commits last: the cache
// ends on the newest lease, never on an older fetch's (S-3472).
func TestPeerLeaseNewerFetchIsNeverRegressed(t *testing.T) {
	h := &leaseHome{
		replies: []homeReply{
			{status: http.StatusOK, body: leaseBody(srvURL, "BEARER-1", inAnHour())},
			{status: http.StatusOK, body: leaseBody(srvURL, "BEARER-2", inAnHour())},
			{status: http.StatusOK, body: leaseBody(srvURL, "BEARER-3", inAnHour())},
		},
		gate:    make(chan struct{}),
		arrived: make(chan struct{}, 16),
	}
	f := peerFixture(t, h, "LEASE-SECRET")
	key := "prov\n" + srvURL
	first := goAsk(f.a, context.Background(), false)
	<-h.arrived
	forced := goAsk(f.a, context.Background(), true)
	waitQueued(t, f.a, key, 1)
	late := goAsk(f.a, context.Background(), false) // joins the running fetch, not the queued one
	waitJoined(t, f.a, key, 1)
	close(h.gate)
	for _, c := range []struct {
		name string
		ch   chan tokenResult
		want string
	}{{"the first ask", first, "BEARER-1"}, {"the late plain ask", late, "BEARER-1"}, {"the forced ask", forced, "BEARER-2"}} {
		if r := <-c.ch; r.err != nil || r.token != c.want {
			t.Errorf("%s got %s, want its fetch's lease", c.name, r)
		}
	}
	if tok, _ := askToken(f.a, context.Background(), false); tok != "BEARER-2" {
		t.Errorf("the cache serves %s, want the newest fetch's", tokenDiff(tok, "BEARER-2"))
	}
	if got := h.requests(); len(got) != 2 {
		t.Errorf("requests %v, want 2", got)
	}

	// An older fetch's result arriving after a newer one's is dropped, a lease or a refusal alike.
	for _, late := range []struct {
		l   heldLease
		err error
	}{{heldLease{url: srvURL, token: "BEARER-STALE", expiresAt: inAnHour()}, nil}, {heldLease{}, errors.New("prov: home answered 500")}} {
		f.a.leaseMu.Lock()
		cur := f.a.held[key]
		late.l.seq = cur.seq - 1
		f.a.commitLease(key, cur.seq-1, late.l, late.err)
		got := f.a.held[key]
		f.a.leaseMu.Unlock()
		if got.token != "BEARER-2" {
			t.Errorf("an older fetch's result (%v) replaced the newer lease with %s", late.err, tokenDiff(got.token, "BEARER-2"))
		}
	}
}

// A forced ask whose lease names another url is asked again without ?refresh=1: the url is the home's settings, which
// a refresh doesn't change (S-3472).
func TestPeerLeaseURLMismatchReaskIsNotForced(t *testing.T) {
	h := &leaseHome{replies: []homeReply{
		{status: http.StatusOK, body: leaseBody("https://other.example/mcp", "BEARER-OLD-URL", inAnHour())},
		{status: http.StatusOK, body: leaseBody(srvURL, "BEARER-SYNCED", inAnHour())},
	}}
	f := peerFixture(t, h, "LEASE-SECRET")
	if tok, err := askToken(f.a, context.Background(), true); err != nil || tok != "BEARER-SYNCED" {
		t.Fatalf("got %s, want the synced lease", tokenResult{tok, err})
	}
	if got := h.requests(); len(got) != 2 || got[0] != "/api/peer/mcp/prov/lease?refresh=1" || got[1] != "/api/peer/mcp/prov/lease" {
		t.Errorf("requests %v, want the forced lease and one plain re-ask", got)
	}
}

// Fail closed (S-3472): a home that refuses or answers badly gives no bearer and drops the cached lease, so the next ask
// doesn't hand out a token the home no longer leases. Each error is named for what it is, with no token.
func TestPeerLeaseRefusalDropsTheCachedLease(t *testing.T) {
	other := leaseBody("https://other.example/mcp", "BEARER-OTHER", inAnHour())
	past := leaseBody(srvURL, "BEARER-EXPIRED", float64(time.Now().Add(-time.Second).UnixMilli()))
	cases := []struct {
		name  string
		reply homeReply
		want  string
	}{
		{"401", homeReply{status: http.StatusUnauthorized, body: `{"error":"bad lease token"}`}, "refused the lease token (401"},
		{"403", homeReply{status: http.StatusForbidden, body: `{"error":"not shared"}`}, "refused the lease token (403"},
		{"404", homeReply{status: http.StatusNotFound, body: `{"error":"no MCP server named it"}`}, "answered 404"},
		{"409", homeReply{status: http.StatusConflict, body: `{"error":"not logged in"}`}, "has no lease for it"},
		{"500", homeReply{status: http.StatusInternalServerError, body: `{"error":"boom"}`}, "answered 500"},
		{"not JSON", homeReply{status: http.StatusOK, body: `<html>proxy</html>`}, "answered something that is not JSON"},
		{"200 without a lease", homeReply{status: http.StatusOK, body: `{"url":"` + srvURL + `"}`}, "answered 200 without a lease"},
		{"another url", homeReply{status: http.StatusOK, body: other}, "the home leases a token for another url"},
		{"already expired", homeReply{status: http.StatusOK, body: past}, "already expired"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := &leaseHome{replies: []homeReply{{status: http.StatusOK, body: leaseBody(srvURL, "BEARER-CACHED", inAnHour())}}}
			f := peerFixture(t, h, "LEASE-SECRET")
			if tok, err := askToken(f.a, context.Background(), false); err != nil || tok != "BEARER-CACHED" {
				t.Fatalf("the first lease: %s", tokenResult{tok, err})
			}
			h.replies = []homeReply{c.reply}
			for _, force := range []bool{true, false} {
				tok, err := askToken(f.a, context.Background(), force)
				if msg := fmt.Sprint(err); strings.Contains(msg, "BEARER") || strings.Contains(msg, "LEASE-SECRET") {
					t.Errorf("force=%v error names a token", force)
					continue
				}
				if err == nil || !strings.Contains(err.Error(), c.want) || tok != "" {
					t.Errorf("force=%v answered %s, want no bearer and %q", force, tokenResult{tok, err}, c.want)
					continue
				}
				if strings.Contains(err.Error(), "unreachable") {
					t.Errorf("force=%v error %q names an unreachable home", force, err)
				}
			}
		})
	}
}

// An unreachable home is named so and gives a forced ask no bearer, but the cached lease is kept, so the peer serves it
// until its margin (S-3472).
func TestPeerLeaseUnreachableHomeKeepsTheCachedLease(t *testing.T) {
	h := &leaseHome{replies: []homeReply{{status: http.StatusOK, body: leaseBody(srvURL, "BEARER-KEPT", inAnHour())}}}
	f := peerFixture(t, h, "LEASE-SECRET")
	if tok, err := askToken(f.a, context.Background(), false); err != nil || tok != "BEARER-KEPT" {
		t.Fatalf("the first lease: %s", tokenResult{tok, err})
	}
	h.replies = []homeReply{{err: errors.New("connection refused")}}
	tok, err := askToken(f.a, context.Background(), true)
	if err == nil || !strings.Contains(err.Error(), "the home home is unreachable") || tok != "" || strings.Contains(err.Error(), "BEARER") {
		t.Errorf("the forced ask answered %s", tokenResult{tok, err})
	}
	if tok, err := askToken(f.a, context.Background(), false); err != nil || tok != "BEARER-KEPT" {
		t.Errorf("the next ask got %s, want the kept lease", tokenResult{tok, err})
	}
}

// noSecret fails when text carries SECRET, without printing the text, so a failing test doesn't show the secret.
func noSecret(t *testing.T, where, text string) {
	t.Helper()
	if strings.Contains(text, "SECRET") {
		t.Errorf("a secret reached %s", where)
	}
}

// The status keeps only the fields it shows of each home row: a token or an unknown field the home sends is dropped.
func TestPeerStatusRowsKeepOnlyTheShownFields(t *testing.T) {
	exp := inAnHour()
	body := fmt.Sprintf(`{"servers":[{"name":"prov","type":"oauth","logged_in":true,"expires_at":%.0f,`+
		`"access_token":"ACCESS-SECRET","refresh_token":"REFRESH-SECRET","extra":{"note":"EXTRA-SECRET"}}]}`, exp)
	h := &leaseHome{replies: []homeReply{{status: http.StatusOK, body: body}}}
	f := peerFixture(t, h, "LEASE-SECRET")
	st, err := f.a.Rows(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := jsjson.Stringify(jsjson.NewObject("servers", st.Servers, "home", st.Home), "")
	noSecret(t, "the status", out)
	want := fmt.Sprintf(`{"name":"prov","type":"oauth","logged_in":true,"expires_at":%.0f,"leased_from":"home"}`, exp)
	if !strings.Contains(out, want) {
		t.Errorf("status rows don't hold the shown fields %s", want)
	}
}

// No text of the home's reaches an error or the status: a credential in any shape, quoted, escaped or inside a known
// cause, gives a local message, and the status keeps its frame (S-4416).
func TestPeerHomeErrorCarriesNoHomeText(t *testing.T) {
	cases := []struct {
		name   string
		status int
		msg    string
	}{
		{"bearer", http.StatusUnauthorized, "refresh failed: Bearer BEARER-SECRET rejected"},
		{"quoted bearer", http.StatusUnauthorized, "Bearer 'QUOTED-SECRET'"},
		{"quoted form value", http.StatusConflict, "access_token='FORM-SECRET'&refresh_token=\"FORM2-SECRET\""},
		{"escaped JSON", http.StatusConflict, `{\"access_token\":\"ESCAPED-SECRET\"}`},
		{"unicode escaped", http.StatusConflict, "access_token=UNICODE-SECRET"},
		{"opaque run", http.StatusForbidden, "key gho_SECRET0123456789abcdefABCDEF0123456789"}, // gitleaks:allow
		{"known cause with a tail", http.StatusConflict, "prov is not logged in on this home TAIL-SECRET"},
		{"known cause with a head", http.StatusConflict, "HEAD-SECRET prov is not logged in on this home"},
		{"provider answer", http.StatusBadGateway, "prov: the home could not get a token (Bearer PROVIDER-SECRET access_token='P2-SECRET')"},
		{"over the cap with a secret", http.StatusConflict, "prov's token lives CAP-SECRET s, over the 1 s cap: the provider issues longer-lived tokens than peers accept (settings mcpServers.prov.leaseMaxSeconds)"},
		{"not the home with a secret", http.StatusConflict, "MACHINE-SECRET is not the settings home; MCP leases come from HOME-SECRET"},
		{"unreadable settings", http.StatusForbidden, "prov: the settings could not be read, so sharing can't be checked (SETTINGS-SECRET)"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := &leaseHome{replies: []homeReply{{status: c.status, body: homeRefusal(c.msg)}}}
			f := peerFixture(t, h, "LEASE-SECRET")
			_, err := f.a.TokenFor(context.Background(), "prov", false)
			if err == nil {
				t.Fatal("TokenFor answered no error")
			}
			noSecret(t, "the TokenFor error", err.Error())
			if _, err := f.a.Token(context.Background(), "prov", true); err == nil {
				t.Fatal("Token answered no error")
			} else {
				noSecret(t, "the Token error", err.Error())
			}
			st, err := f.a.Rows(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			home := jsjson.Stringify(st.Home, "")
			noSecret(t, "the status", home)
			if !strings.Contains(home, `"reachable":false`) || !strings.Contains(home, "MCP status: home ") {
				t.Errorf("the status lost its frame for the refusal")
			}
		})
	}
}

// A cause is bounded, so a long server name doesn't fill the error.
func TestPeerHomeCauseIsBounded(t *testing.T) {
	name := strings.Repeat("p", 400)
	cause := homeCause(name, http.StatusConflict, name+" is not logged in on this home")
	if cause == "" || len(cause) > homeCauseMax {
		t.Errorf("the cause is %d bytes, want a known cause of at most %d", len(cause), homeCauseMax)
	}
}

// A home row's name and type reach the status only as this machine's own words: a row for a server this machine
// doesn't have is dropped, and a type that isn't an auth type is left out (S-4416).
func TestPeerStatusRowsCarryNoHomeText(t *testing.T) {
	cases := []struct {
		name string
		row  string
		kept bool
	}{
		{"a secret in the name", `{"name":"Bearer NAME-SECRET","type":"oauth","logged_in":true,"expires_at":null}`, false},
		{"a secret in the type of another server", `{"name":"other","type":"TYPE-SECRET","logged_in":true,"expires_at":null}`, false},
		{"a local server with a secret type", `{"name":"prov","type":"Bearer TYPE-SECRET","logged_in":true,"expires_at":null}`, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := &leaseHome{replies: []homeReply{{status: http.StatusOK, body: `{"servers":[` + c.row + `]}`}}}
			f := peerFixture(t, h, "LEASE-SECRET")
			st, err := f.a.Rows(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			out := jsjson.Stringify(jsjson.NewObject("servers", st.Servers, "home", st.Home), "")
			noSecret(t, "the status", out)
			kept := strings.Contains(out, `{"name":"prov","logged_in":true,"expires_at":null,"leased_from":"home"}`)
			if kept != c.kept {
				t.Errorf("the local row without its type is shown: %v, want %v", kept, c.kept)
			}
			if !c.kept && strings.Contains(out, `"leased_from"`) {
				t.Errorf("a row for a server this machine doesn't have is shown")
			}
		})
	}
}

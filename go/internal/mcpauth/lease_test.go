package mcpauth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// shared is settings naming prov at srvURL, shared with peers, with an oauth login; extra is merged into prov's entry.
func shared(extra string) string {
	if extra != "" {
		extra = "," + extra
	}
	return `{"prov":{"url":"` + srvURL + `","auth":{"type":"oauth"},"shareWithPeers":true` + extra + `}}`
}

// grantEndingIn is a stored grant that ends offsetMs from now, with a refresh token when withRefresh.
func grantEndingIn(offsetMs int64, withRefresh bool) string {
	refresh := ""
	if withRefresh {
		refresh = `,"refresh_token":"R1"`
	}
	return fmt.Sprintf(`{"server_url":"%s","client_id":"c","token_endpoint":"https://x.example/t","access_token":"LIVE"%s,"expires_at":%.0f}`,
		srvURL, refresh, nowMs()+float64(offsetMs))
}

// leaseErr asserts err is a LeaseError with status and a message that contains want.
func leaseErr(t *testing.T, err error, status int, want string) {
	t.Helper()
	var le *LeaseError
	if !errors.As(err, &le) {
		t.Fatalf("got %v, want a LeaseError %d (%s)", err, status, want)
	}
	if le.Status != status || !strings.Contains(le.Message, want) {
		t.Errorf("got %d %q, want %d containing %q", le.Status, le.Message, status, want)
	}
}

// leaseCase is one refusal of leaseFor: the server asked for, its settings, the grant on the home (empty for none), and
// what leaseFor answers.
type leaseCase struct {
	name     string
	servers  string
	grant    string
	force    bool
	status   int
	message  string
	provider bool // whether the refusal is decided after the provider could be called
	granted  bool // a lease is granted, not refused: TestLeaseRefusals skips it, and the parity test compares it
}

// leaseCases are the refusals of leaseFor, and one grant, shared with the TS parity test.
func leaseCases() []leaseCase {
	const hour = 3600_000
	return []leaseCase{
		{name: "a granted lease", servers: shared(""), grant: grantEndingIn(hour/2, false), granted: true},
		{name: "unknown server", servers: shared(""), grant: grantEndingIn(hour/2, false), status: 404, message: "no MCP server named nosuch"},
		{name: "not shared", servers: `{"prov":{"url":"` + srvURL + `","auth":{"type":"oauth"}}}`, grant: grantEndingIn(hour/2, false), status: 403, message: "shareWithPeers is off"},
		{name: "gh", servers: `{"prov":{"url":"` + srvURL + `","auth":{"type":"gh"},"shareWithPeers":true}}`, grant: grantEndingIn(hour/2, false), status: 400, message: "uses gh"},
		{name: "not logged in", servers: shared(""), grant: "", status: 409, message: "is not logged in on this home"},
		{name: "never expires", servers: shared(""), grant: `{"server_url":"` + srvURL + `","access_token":"LIVE"}`, status: 409, message: "never expires"},
		{name: "a cap that is not a positive integer", servers: shared(`"leaseMaxSeconds":0`), grant: grantEndingIn(hour/2, false), status: 409, message: "must be a positive integer"},
		{name: "a fractional cap", servers: shared(`"leaseMaxSeconds":1.5`), grant: grantEndingIn(hour/2, false), status: 409, message: "must be a positive integer"},
		{name: "a text cap", servers: shared(`"leaseMaxSeconds":"60"`), grant: grantEndingIn(hour/2, false), status: 409, message: "must be a positive integer"},
		{name: "a token over the default cap", servers: shared(""), grant: grantEndingIn(2*hour, false), status: 409, message: "over the 3600 s cap"},
		{name: "a token over the server's cap", servers: shared(`"leaseMaxSeconds":60`), grant: grantEndingIn(hour/2, false), status: 409, message: "over the 60 s cap"},
		{name: "a token that ends within a minute", servers: shared(""), grant: grantEndingIn(30_000, false), status: 409, message: "ends within a minute"},
		{name: "a forced refresh over the cap is refused before the provider", servers: shared(""), grant: grantEndingIn(2*hour, true), force: true, status: 409, message: "over the 3600 s cap", provider: true},
	}
}

func TestLeaseRefusals(t *testing.T) {
	for _, c := range leaseCases() {
		if c.granted {
			continue // a grant, not a refusal: TestLeaseMatchesTS compares it
		}
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t, "m", "m", c.servers)
			p := newProvider(t, 0, false)
			grant := c.grant
			if grant != "" && strings.Contains(grant, "token_endpoint") {
				grant = strings.Replace(grant, "https://x.example/t", p.srv.URL+"/token", 1)
			}
			if grant != "" {
				f.writeGrant("prov", grant)
			}
			name := "prov"
			if c.name == "unknown server" {
				name = "nosuch"
			}
			_, err := f.a.LeaseFor(context.Background(), name, c.force)
			leaseErr(t, err, c.status, c.message)
			if n := p.calls.Load(); n != 0 {
				t.Errorf("%d provider calls for a refusal, want 0", n)
			}
		})
	}
}

// A lease for a shared server with a grant that lives an hour: the peer gets the url, the bearer and the expiry, with no
// refresh.
func TestLeaseGrantsTheBearerAndTheExpiry(t *testing.T) {
	f := newFixture(t, "m", "m", shared(""))
	f.writeGrant("prov", grantEndingIn(3_000_000, false))
	l, err := f.a.LeaseFor(context.Background(), "prov", false)
	if err != nil {
		t.Fatal(err)
	}
	if l.URL != srvURL || l.AccessToken != "LIVE" || l.ExpiresAt <= nowMs() {
		t.Errorf("lease %+v", l)
	}
}

// A lease with a longer cap than the default is granted when the token fits it.
func TestLeaseCapRaisedByTheServer(t *testing.T) {
	f := newFixture(t, "m", "m", shared(`"leaseMaxSeconds":7200`))
	f.writeGrant("prov", grantEndingIn(2*3600_000, false))
	if _, err := f.a.LeaseFor(context.Background(), "prov", false); err != nil {
		t.Errorf("a token within the server's cap: %v", err)
	}
}

// Rotation writes a new token at once: the old one is refused, the new one matches, the file is 0600, and no temp file is
// left beside it.
func TestRotateLeaseTokenRevokesTheOldOne(t *testing.T) {
	home := t.TempDir()
	f := newFixture(t, "m", "m", shared(""))
	f.a.opt.Home = home
	if err := RotateLeaseToken(home); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(filepath.Join(home, "mcp-lease-token"))
	if err != nil {
		t.Fatal(err)
	}
	if !f.a.LeaseTokenMatches(strings.TrimSpace(string(first))) {
		t.Fatal("the new token doesn't match")
	}
	if err := RotateLeaseToken(home); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(filepath.Join(home, "mcp-lease-token"))
	if string(second) == string(first) {
		t.Fatal("rotation kept the token")
	}
	if f.a.LeaseTokenMatches(strings.TrimSpace(string(first))) {
		t.Error("the old lease token still matches after rotation")
	}
	info, err := os.Stat(filepath.Join(home, "mcp-lease-token"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("lease token mode %o, want 600", info.Mode().Perm())
	}
	left, _ := filepath.Glob(filepath.Join(home, "*.tmp"))
	if len(left) != 0 {
		t.Errorf("rotation left temp files: %v", left)
	}
}

// A missing or empty lease file matches nothing, so every request is refused.
func TestNoLeaseFileMatchesNothing(t *testing.T) {
	f := newFixture(t, "m", "m", shared(""))
	if f.a.LeaseTokenMatches("") || f.a.LeaseTokenMatches("anything") {
		t.Error("a missing lease file matched")
	}
	if err := os.WriteFile(f.a.leaseTokenFile(), []byte("\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if f.a.LeaseTokenMatches("") {
		t.Error("an empty lease file matched the empty bearer")
	}
}

func TestSameSecret(t *testing.T) {
	if !SameSecret("abc", "abc") || SameSecret("abc", "abd") || SameSecret("abc", "abcd") || SameSecret("", "x") {
		t.Error("SameSecret compares wrongly")
	}
}

// TestEnsureLeaseToken: the token is made once, mode 0600, in a home that may not exist yet; a later start keeps it,
// and narrows a looser mode back to 0600.
func TestEnsureLeaseToken(t *testing.T) {
	home := filepath.Join(t.TempDir(), "new-home")
	file := filepath.Join(home, "mcp-lease-token")
	if err := EnsureLeaseToken(home); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(file)
	if info, _ := os.Stat(file); err != nil || len(first) < 32 || info.Mode().Perm() != 0o600 {
		t.Fatalf("the new token: %d bytes, %v, %v", len(first), info.Mode(), err)
	}
	if err := os.Chmod(file, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureLeaseToken(home); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(file)
	if info, _ := os.Stat(file); string(again) != string(first) || info.Mode().Perm() != 0o600 {
		t.Errorf("a second start: kept %v, mode %v", string(again) == string(first), info.Mode())
	}
}

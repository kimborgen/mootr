package mcpauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"stam/internal/jsjson"
)

// The lease (S-3176, S-2738 B-lease): the settings home leases a short-lived access token for a shared server to a peer
// that presents the lease token. This file is the home side: the lease token, its rotation, the refusals of leaseFor, and
// the shared status rows. It ports src/mcp-auth.ts leaseFor, sharedStatus and the token helpers in src/config.ts.

// LeaseError is a refusal of a lease, with the status the route answers it with.
type LeaseError struct {
	Status  int
	Message string
}

func (e *LeaseError) Error() string { return e.Message }

// Lease is what a peer gets: the server's url and a bearer for it, and when the bearer expires (in ms since the epoch).
type Lease struct {
	URL         string
	AccessToken string
	ExpiresAt   float64
}

// The longest lifetime a lease may carry, in seconds, when the server names none (leaseCapSeconds in TS).
const leaseCapDefault = 3600

// The lease must outlive the peer's cache of it, so a token that ends within this long is refused (60 s, in ms).
const leaseMinRemainingMs = 60_000

// leaseTokenFile is STAM_HOME/mcp-lease-token. It is apart from the peer token, so a rotation revokes leases without
// breaking the peer link (S-3176).
func (a *Auth) leaseTokenFile() string { return filepath.Join(a.opt.Home, "mcp-lease-token") }

// LeaseTokenMatches is whether presented is the lease token: read from the file on each call, so a rotation needs no
// restart, and compared in constant time. A missing or empty file matches nothing.
func (a *Auth) LeaseTokenMatches(presented string) bool {
	raw, err := os.ReadFile(a.leaseTokenFile())
	if err != nil {
		return false
	}
	secret := strings.TrimSpace(string(raw))
	if secret == "" {
		return false
	}
	return SameSecret(presented, secret)
}

// SameSecret is whether two secrets are equal, compared in constant time over their sha256 digests, so the length of
// the presented one isn't checked against the other's (sameSecret in TS).
func SameSecret(presented, secret string) bool {
	a := sha256.Sum256([]byte(presented))
	b := sha256.Sum256([]byte(secret))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

// EnsureLeaseToken is src/config.ts ensureLeaseToken, run once at startup: a missing lease token is created, mode 0600,
// with O_EXCL, so two daemons starting on one home never both write one; an existing one is kept and narrowed to 0600.
func EnsureLeaseToken(home string) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	file := filepath.Join(home, "mcp-lease-token")
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, fs.ErrExist) {
		_ = os.Chmod(file, 0o600)
		return nil
	}
	if err != nil {
		return err
	}
	token, err := newLeaseToken()
	if err == nil {
		_, err = f.WriteString(token)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(file)
	}
	return err
}

// newLeaseToken is 24 random bytes, base64url.
func newLeaseToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// RotateLeaseToken writes a new lease token to home/mcp-lease-token: a temp file mode 0600, renamed over the old one, so
// the old token is refused at once. The token is written to the file only, never returned or printed.
func RotateLeaseToken(home string) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	token, err := newLeaseToken()
	if err != nil {
		return err
	}
	file := filepath.Join(home, "mcp-lease-token")
	tmp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(tmp, []byte(token), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, file); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// leaseCap is the server's lifetime cap in seconds: leaseMaxSeconds, a safe positive integer, or 3600 when absent. Any
// other value refuses the lease, so a bad value never means "no cap".
func leaseCap(name string, server *jsjson.Object) (int64, error) {
	v, present := server.Get("leaseMaxSeconds")
	if !present {
		return leaseCapDefault, nil
	}
	n, ok := v.(float64)
	if ok && n == math.Trunc(n) && n > 0 && n <= 9007199254740991 {
		return int64(n), nil
	}
	return 0, &LeaseError{Status: 409, Message: fmt.Sprintf("%s's leaseMaxSeconds must be a positive integer (settings mcpServers.%s.leaseMaxSeconds)", name, name)}
}

// overCap is the refusal of a token that lives longer than the cap. It names no token.
func overCap(name string, remainingMs float64, cap int64) *LeaseError {
	return &LeaseError{Status: 409, Message: fmt.Sprintf("%s's token lives %d s, over the %d s cap: the provider issues longer-lived tokens than peers accept (settings mcpServers.%s.leaseMaxSeconds)", name, int64(math.Round(remainingMs/1000)), cap, name)}
}

// LeaseFor is the lease of a server the settings share (leaseFor in TS). Every refusal is a *LeaseError with its status: a
// server not shared is 403, a gh server 400, a server with no grant on this home 409. A failure inside the refresh is not a
// LeaseError and the route answers it 502. A refresh that would only bring a token over the cap is refused before the
// provider is called.
func (a *Auth) LeaseFor(ctx context.Context, name string, force bool) (Lease, error) {
	server, ok := a.server(name)
	if !ok || server == nil {
		return Lease{}, &LeaseError{Status: 404, Message: fmt.Sprintf("no MCP server named %s", name)}
	}
	if share, _ := server.Get("shareWithPeers"); share != true {
		return Lease{}, &LeaseError{Status: 403, Message: fmt.Sprintf("%s is not shared with peers (shareWithPeers is off)", name)}
	}
	if typ, _ := authType(server); typ == "gh" {
		return Lease{}, &LeaseError{Status: 400, Message: fmt.Sprintf("%s uses gh; a peer uses its own gh login", name)}
	}
	cap, err := leaseCap(name, server)
	if err != nil {
		return Lease{}, err
	}
	g, has := a.storedGrant(name)
	if !has || (g.accessToken == "" && g.refreshToken == "") {
		return Lease{}, &LeaseError{Status: 409, Message: fmt.Sprintf("%s is not logged in on this home", name)}
	}
	if !g.hasExpiry || g.expiresAt == 0 {
		return Lease{}, &LeaseError{Status: 409, Message: fmt.Sprintf("%s's grant never expires, so it is not leased", name)}
	}
	// A grant already over the cap is refused before a forced refresh, so the provider isn't called for it again.
	if force && g.expiresAt-nowMs() > float64(cap)*1000 {
		return Lease{}, overCap(name, g.expiresAt-nowMs(), cap)
	}
	got, err := a.TokenFor(ctx, name, force)
	if err != nil {
		return Lease{}, err
	}
	if got.ExpiresAt == nil || *got.ExpiresAt == 0 {
		return Lease{}, &LeaseError{Status: 409, Message: fmt.Sprintf("%s's grant never expires, so it is not leased", name)}
	}
	exp := *got.ExpiresAt
	if exp <= nowMs()+leaseMinRemainingMs {
		return Lease{}, &LeaseError{Status: 409, Message: fmt.Sprintf("%s's grant ends within a minute, so it is not leased", name)}
	}
	// The cap is on the lifetime the peer would hold: rotating the lease token can't revoke a bearer already sent, so a
	// token that lives longer is refused, not shortened.
	if remaining := exp - nowMs(); remaining > float64(cap)*1000 {
		return Lease{}, overCap(name, remaining, cap)
	}
	return Lease{URL: got.URL, AccessToken: got.Token, ExpiresAt: exp}, nil
}

// SharedRows are the status rows of the servers the settings share, for a peer: no token in them (sharedStatus in TS).
func (a *Auth) SharedRows(ctx context.Context) []jsjson.Value {
	return a.localRows(ctx, func(name string) bool {
		s, _ := a.server(name)
		share, _ := s.Get("shareWithPeers")
		return share == true
	})
}

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

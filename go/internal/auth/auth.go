// Package auth tells who a request is from, as src/daemon.ts callerOf does (S-2614), and holds the guards routes use.
//
// Every token comparison is on sha256 digests with subtle.ConstantTimeCompare, so neither a token's bytes nor its
// length leak through timing. No token or hash is ever put in an error or a log line.
package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"stam/internal/config"
)

// Kind is the kind of credential a request carries.
type Kind string

const (
	// Peer is another daemon's peer token (STAM_HOME/peer-token, S-545).
	Peer Kind = "peer"
	// Shared is the shared token (STAM_HOME/token): the human's and the CLI's.
	Shared Kind = "shared"
	// Agent is an agent's own launch token, or an agent a peer forwards (x-stam-agent).
	Agent Kind = "agent"
	// OpenCode is the OpenCode server's token (S-240): it names an OpenCode agent, never the human.
	OpenCode Kind = "opencode"
	// Owner is the human, proven without a token (trustedHuman).
	Owner Kind = "owner"
	// None is a request with no credential this daemon accepts.
	None Kind = "none"
)

// Caller is who a request is from (src/daemon.ts Caller).
type Caller struct {
	Kind Kind
	// Agent is the agent's id, for Kind Agent.
	Agent string
	// Boss and Assistant are what a peer says of the agent it forwards (x-stam-agent-boss, x-stam-agent-assistant).
	Boss, Assistant bool
	// Scope is a forwarded agent's branch scope (x-stam-branch-scope): tree, foreign or none; empty when not sent.
	Scope string
}

// IsAgent is whether the caller is an agent's or the OpenCode server's token: neither proves the human or a peer.
func (c Caller) IsAgent() bool { return c.Kind == Agent || c.Kind == OpenCode }

// Hash is the sha256 hex digest of a token (src/agent-token.ts hashToken).
func Hash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Lookup finds the agent whose launch token hashes to hash; ok false when none does.
type Lookup func(ctx context.Context, hash string) (id string, ok bool, err error)

// Auth holds what callerOf compares against.
type Auth struct {
	shared, peer [sha256.Size]byte
	lookup       Lookup
	// serverTokenFile holds the OpenCode server's token hash; read on each request that needs it, as TS does.
	serverTokenFile string
	testHumanKey    [sha256.Size]byte
	hasTestKey      bool
	// LocalHuman is whether a request carries a live local human session on a direct loopback connection (S-613),
	// set by the server; nil is never.
	LocalHuman func(*http.Request) bool
}

// New returns the Auth of a config, with lookup for agents' tokens.
func New(c config.Config, lookup Lookup) *Auth {
	a := &Auth{
		shared:          sha256.Sum256([]byte(c.Token.Reveal())),
		peer:            sha256.Sum256([]byte(c.PeerToken.Reveal())),
		lookup:          lookup,
		serverTokenFile: filepath.Join(c.Home, "opencode-token"),
	}
	if k := c.TestHumanKey.Reveal(); k != "" {
		a.testHumanKey, a.hasTestKey = sha256.Sum256([]byte(k)), true
	}
	return a
}

// CallerOf is src/daemon.ts callerOf: the peer token, then the shared token, then an agent's own, then the OpenCode
// server's, then the trusted human, else none. A lookup failure is an error (a 500), never a silent none.
func (a *Auth) CallerOf(r *http.Request) (Caller, error) {
	token, bearer := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if bearer {
		sum := sha256.Sum256([]byte(token))
		// Both compared, so which one matched doesn't show in the time taken.
		peer := subtle.ConstantTimeCompare(sum[:], a.peer[:]) == 1
		shared := subtle.ConstantTimeCompare(sum[:], a.shared[:]) == 1
		if peer {
			return Caller{Kind: Peer}, nil
		}
		if shared {
			return Caller{Kind: Shared}, nil
		}
		hash := hex.EncodeToString(sum[:])
		id, ok, err := a.lookup(r.Context(), hash)
		if err != nil {
			return Caller{}, errors.New("auth: agent token lookup failed")
		}
		if ok {
			return Caller{Kind: Agent, Agent: id}, nil
		}
		if server := a.serverTokenHash(); server != "" && subtle.ConstantTimeCompare([]byte(hash), []byte(server)) == 1 {
			return Caller{Kind: OpenCode}, nil
		}
	}
	if a.TrustedHuman(r) {
		return Caller{Kind: Owner}, nil
	}
	return Caller{Kind: None}, nil
}

// IsShared is whether token is the shared token, for an attachment URL that carries it (src/daemon.ts mediaToken).
func (a *Auth) IsShared(token string) bool {
	sum := sha256.Sum256([]byte(token))
	return token != "" && subtle.ConstantTimeCompare(sum[:], a.shared[:]) == 1
}

// IsPeer is whether token is the peer token, for a terminal socket that carries it (src/daemon.ts tokenAuth).
func (a *Auth) IsPeer(token string) bool {
	sum := sha256.Sum256([]byte(token))
	return token != "" && subtle.ConstantTimeCompare(sum[:], a.peer[:]) == 1
}

// TrustedHuman is src/daemon.ts trustedHuman. Ported: the test key, in a test home only (S-634), then a local human
// session (LocalHuman, S-613). Not yet ported, so never true here: the tailscale serve login (owner, root-owned loopback
// socket, client IP).
func (a *Auth) TrustedHuman(r *http.Request) bool {
	if a.hasTestKey {
		if got := r.Header.Get("X-Stam-Test-Human"); got != "" {
			sum := sha256.Sum256([]byte(got))
			if subtle.ConstantTimeCompare(sum[:], a.testHumanKey[:]) == 1 {
				return true
			}
		}
	}
	return a.LocalHuman != nil && a.LocalHuman(r)
}

func (a *Auth) serverTokenHash() string {
	b, err := os.ReadFile(a.serverTokenFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// Resolved is a request's caller after the peer rules (src/daemon.ts handler): a peer acts as the shared token,
// except that it may forward an agent and reach the peer-only routes (Local).
type Resolved struct {
	Caller
	// Verified is what CallerOf found, before a peer's forwarding.
	Verified Kind
	// Local is a peer's daemon-to-daemon call (x-stam-local: 1): it unlocks the peer-only routes.
	Local bool
	// Owned is src/daemon.ts owned: the request proves the human (TrustedHuman), whatever token it also carries, but
	// never with an agent's or the OpenCode server's token, nor with x-stam-local. Set by the server's callerOf.
	Owned bool
}

// ErrPeerHeaders refuses the shared token sending a peer's headers (S-545, S-1064): any holder could forge them.
var ErrPeerHeaders = errors.New("peer headers need the peer token (settings.peers[].peerToken); the shared token can't send them")

// Resolve applies the peer rules to a verified caller.
func Resolve(verified Caller, h http.Header) (Resolved, error) {
	local := h.Get("X-Stam-Local") == "1"
	_, agentHeader := h["X-Stam-Agent"]
	if verified.Kind == Shared && (local || agentHeader) {
		return Resolved{}, ErrPeerHeaders
	}
	out := Resolved{Caller: verified, Verified: verified.Kind}
	if verified.Kind != Peer {
		return out, nil
	}
	out.Local = local
	if forwarded := h.Get("X-Stam-Agent"); local && forwarded != "" {
		out.Caller = Caller{
			Kind:      Agent,
			Agent:     forwarded,
			Boss:      h.Get("X-Stam-Agent-Boss") == "1",
			Assistant: h.Get("X-Stam-Agent-Assistant") == "1",
			Scope:     parseScope(h.Get("X-Stam-Branch-Scope")),
		}
		return out, nil
	}
	out.Caller = Caller{Kind: Shared}
	return out, nil
}

// parseScope is src/branch-scope.ts parseScope: only a known scope passes.
func parseScope(v string) string {
	switch v {
	case "tree", "foreign", "none":
		return v
	}
	return ""
}

// NotAgentToken is src/daemon.ts notAgentToken: the agent's own token, or the OpenCode server's, can't do what. It
// returns the 403 message, or "" when the caller passes.
func NotAgentToken(c Caller, what string) string {
	if c.IsAgent() {
		return "an agent's token can't " + what
	}
	return ""
}

package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/config"
)

func TestHashIsTheTSHash(t *testing.T) {
	// sha256("abc"), as src/agent-token.ts hashToken gives it.
	if got := Hash("abc"); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("Hash = %s", got)
	}
}

func TestResolve(t *testing.T) {
	h := func(kv ...string) http.Header {
		out := http.Header{}
		for i := 0; i < len(kv); i += 2 {
			out.Set(kv[i], kv[i+1])
		}
		return out
	}
	for _, tc := range []struct {
		name     string
		verified Caller
		header   http.Header
		want     Resolved
		err      error
	}{
		{"a peer acts as the shared token", Caller{Kind: Peer}, h(), Resolved{Caller: Caller{Kind: Shared}, Verified: Peer}, nil},
		{"a peer's local call", Caller{Kind: Peer}, h("X-Stam-Local", "1"), Resolved{Caller: Caller{Kind: Shared}, Verified: Peer, Local: true}, nil},
		{"a peer forwards an agent", Caller{Kind: Peer}, h("X-Stam-Local", "1", "X-Stam-Agent", "a1", "X-Stam-Agent-Boss", "1", "X-Stam-Branch-Scope", "tree"),
			Resolved{Caller: Caller{Kind: Agent, Agent: "a1", Boss: true, Scope: "tree"}, Verified: Peer, Local: true}, nil},
		{"a forward without x-stam-local is no forward", Caller{Kind: Peer}, h("X-Stam-Agent", "a1"), Resolved{Caller: Caller{Kind: Shared}, Verified: Peer}, nil},
		{"an unknown scope is dropped", Caller{Kind: Peer}, h("X-Stam-Local", "1", "X-Stam-Agent", "a1", "X-Stam-Branch-Scope", "all"),
			Resolved{Caller: Caller{Kind: Agent, Agent: "a1"}, Verified: Peer, Local: true}, nil},
		{"the shared token can't send x-stam-local", Caller{Kind: Shared}, h("X-Stam-Local", "1"), Resolved{}, ErrPeerHeaders},
		{"the shared token can't send x-stam-agent", Caller{Kind: Shared}, h("X-Stam-Agent", ""), Resolved{}, ErrPeerHeaders},
		{"an agent's headers prove nothing", Caller{Kind: Agent, Agent: "a1"}, h("X-Stam-Local", "1", "X-Stam-Agent", "a2"),
			Resolved{Caller: Caller{Kind: Agent, Agent: "a1"}, Verified: Agent}, nil},
	} {
		got, err := Resolve(tc.verified, tc.header)
		if err != tc.err || got != tc.want {
			t.Errorf("%s: got %+v, %v; want %+v, %v", tc.name, got, err, tc.want, tc.err)
		}
	}
}

func TestNotAgentToken(t *testing.T) {
	for kind, refused := range map[Kind]bool{Agent: true, OpenCode: true, Shared: false, Peer: false, Owner: false} {
		if got := NotAgentToken(Caller{Kind: kind}, "x") != ""; got != refused {
			t.Errorf("%s: refused %v, want %v", kind, got, refused)
		}
	}
}

// fakeAuth is an Auth over a temp home whose opencode-token file holds the hash of "server", with a lookup that knows
// agent "a1" by the hash of "agent" and fails on the hash of "broken".
func fakeAuth(t *testing.T, shared, peer, testKey string) *Auth {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "opencode-token"), []byte(Hash("server")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{Home: home, Token: config.Secret(shared), PeerToken: config.Secret(peer), TestHumanKey: config.Secret(testKey)}
	return New(cfg, func(_ context.Context, hash string) (string, bool, error) {
		switch hash {
		case Hash("agent"):
			return "a1", true, nil
		case Hash("broken"):
			return "", false, errors.New("db down")
		}
		return "", false, nil
	})
}

func TestCallerOf(t *testing.T) {
	bearer := func(tok string) map[string]string { return map[string]string{"Authorization": "Bearer " + tok} }
	with := func(m map[string]string, k, v string) map[string]string {
		out := map[string]string{k: v}
		for a, b := range m {
			out[a] = b
		}
		return out
	}
	key := map[string]string{"X-Stam-Test-Human": "key"}
	for _, tc := range []struct {
		name         string
		shared, peer string
		testKey      string
		header       map[string]string
		want         Caller
		wantErr      bool
	}{
		{"peer", "shared", "peer", "", bearer("peer"), Caller{Kind: Peer}, false},
		{"shared", "shared", "peer", "", bearer("shared"), Caller{Kind: Shared}, false},
		{"agent", "shared", "peer", "", bearer("agent"), Caller{Kind: Agent, Agent: "a1"}, false},
		{"opencode server (its token file matches)", "shared", "peer", "", bearer("server"), Caller{Kind: OpenCode}, false},
		{"owner by the test key", "shared", "peer", "key", key, Caller{Kind: Owner}, false},
		{"none", "shared", "peer", "key", map[string]string{}, Caller{Kind: None}, false},
		{"peer equal to shared is peer", "same", "same", "", bearer("same"), Caller{Kind: Peer}, false},
		{"a lookup error is an error, not none", "shared", "peer", "", bearer("broken"), Caller{}, true},
		{"an unknown bearer with the test key is owner", "shared", "peer", "key", with(bearer("nope"), "X-Stam-Test-Human", "key"), Caller{Kind: Owner}, false},
		{"an agent token with the test key stays agent", "shared", "peer", "key", with(bearer("agent"), "X-Stam-Test-Human", "key"), Caller{Kind: Agent, Agent: "a1"}, false},
		{"the shared token with the test key stays shared", "shared", "peer", "key", with(bearer("shared"), "X-Stam-Test-Human", "key"), Caller{Kind: Shared}, false},
		{"no test key configured: the header is none", "shared", "peer", "", key, Caller{Kind: None}, false},
		{"no test key configured: an empty header is none", "shared", "peer", "", map[string]string{"X-Stam-Test-Human": ""}, Caller{Kind: None}, false},
		{"a wrong test key is none", "shared", "peer", "key", map[string]string{"X-Stam-Test-Human": "kex"}, Caller{Kind: None}, false},
		{"not a bearer is none", "shared", "peer", "", map[string]string{"Authorization": "Token shared"}, Caller{Kind: None}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := fakeAuth(t, tc.shared, tc.peer, tc.testKey)
			r := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
			for k, v := range tc.header {
				r.Header.Set(k, v)
			}
			got, err := a.CallerOf(r)
			if (err != nil) != tc.wantErr || got != tc.want {
				t.Fatalf("got %+v, %v; want %+v, error %v", got, err, tc.want, tc.wantErr)
			}
			if err != nil && (strings.Contains(err.Error(), "broken") || strings.Contains(err.Error(), Hash("broken"))) {
				t.Fatalf("the error names the token: %v", err)
			}
		})
	}
	t.Run("no opencode-token file", func(t *testing.T) {
		a := fakeAuth(t, "shared", "peer", "")
		os.Remove(a.serverTokenFile)
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("Authorization", "Bearer server")
		if got, _ := a.CallerOf(r); got.Kind != None {
			t.Fatalf("got %+v, want none", got)
		}
	})
}

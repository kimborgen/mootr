package mcpauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// fakeAuthServer is an MCP server with its OAuth metadata, registration and token endpoints on one loopback server.
type fakeAuthServer struct {
	srv      *httptest.Server
	mu       sync.Mutex
	issuer   string // the issuer the metadata claims; the server's own URL when ""
	resource string // the protected resource the metadata names; the MCP url when ""
	regs     int
	forms    []url.Values
	secret   string // the client_secret registration returns
}

func newAuthServer(t *testing.T) *fakeAuthServer {
	f := &fakeAuthServer{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		base := f.srv.URL
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/mcp":
			w.Header().Set("www-authenticate", `Bearer resource_metadata="`+base+`/prm"`)
			w.WriteHeader(401)
		case "/prm":
			res := f.resource
			if res == "" {
				res = base + "/mcp"
			}
			fmt.Fprintf(w, `{"resource":%q,"authorization_servers":[%q],"scopes_supported":["read"]}`, res, base)
		case "/.well-known/oauth-authorization-server":
			iss := f.issuer
			if iss == "" {
				iss = base
			}
			fmt.Fprintf(w, `{"issuer":%q,"authorization_endpoint":%q,"token_endpoint":%q,"registration_endpoint":%q}`, iss, base+"/authorize", base+"/token", base+"/register")
		case "/register":
			f.regs++
			fmt.Fprintf(w, `{"client_id":"reg-client","client_secret":%q}`, f.secret)
		case "/token":
			_ = r.ParseForm()
			f.forms = append(f.forms, r.PostForm)
			_, _ = w.Write([]byte(`{"access_token":"AT","refresh_token":"RT","expires_in":3600}`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// loginFixture is an auth whose settings name the fake server as `prov`, with a secret store.
func loginFixture(t *testing.T, f *fakeAuthServer, auth string) *fixture {
	fx := newFixture(t, "m", "m", `{"prov":{"url":"`+f.srv.URL+`/mcp","auth":`+auth+`}}`)
	fx.a.opt.Secrets = config.NewSecrets(fx.a.opt.Home, func(string) string { return "" })
	return fx
}

// TestLogin: a login discovers the metadata, registers a client, sends the human to the authorize URL with PKCE and a
// state, and the callback exchanges the code with the verifier; the registration's client secret goes into the secret
// store and the grant keeps only its reference. The state is single use.
func TestLogin(t *testing.T) {
	const secret = "registered-client-secret-1"
	f := newAuthServer(t)
	f.secret = secret
	fx := loginFixture(t, f, `{"type":"oauth"}`)
	ctx := context.Background()
	u, err := fx.a.StartLogin(ctx, "prov", "https://web.example/oauth/callback")
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(u)
	q := parsed.Query()
	if parsed.Path != "/authorize" || q.Get("client_id") != "reg-client" || q.Get("code_challenge_method") != "S256" || q.Get("redirect_uri") != "https://web.example/oauth/callback" ||
		q.Get("resource") != f.srv.URL+"/mcp" || q.Get("scope") != "read" || q.Get("state") == "" || q.Get("response_type") != "code" {
		t.Fatalf("authorize url %s", u)
	}
	if !strings.HasPrefix(parsed.RawQuery, "response_type=code&client_id=reg-client&redirect_uri=") {
		t.Errorf("the parameters aren't in TS's order: %s", parsed.RawQuery)
	}
	name, err := fx.a.FinishLogin(ctx, "CODE", q.Get("state"))
	if err != nil || name != "prov" {
		t.Fatalf("finish: %q %v", name, err)
	}
	form := f.forms[0]
	sum := sha256.Sum256([]byte(form.Get("code_verifier")))
	if form.Get("code") != "CODE" || base64.RawURLEncoding.EncodeToString(sum[:]) != q.Get("code_challenge") || form.Get("client_secret") != secret || form.Get("grant_type") != "authorization_code" {
		t.Errorf("token form %v", form)
	}
	store := jsjson.Stringify(fx.a.read(), "")
	ref, _ := config.McpClientSecretName("prov")
	if strings.Contains(store, secret) || !strings.Contains(store, `"client_secret":{"secret":"`+ref+`"}`) || !strings.Contains(store, `"access_token":"AT"`) {
		t.Errorf("the grant: %s", store)
	}
	if v, _ := fx.a.opt.Secrets.Get(ref); v.Reveal() != secret {
		t.Errorf("the store doesn't hold the registration's secret")
	}
	if _, err := fx.a.FinishLogin(ctx, "CODE", q.Get("state")); err == nil || err.Error() != "unknown or already used login state" {
		t.Errorf("a second use of the state: %v", err)
	}
	// Logout forgets the grant and the secret the registration made.
	if err := fx.a.Logout("prov"); err != nil {
		t.Fatal(err)
	}
	if _, ok := fx.a.opt.Secrets.Get(ref); ok {
		t.Errorf("logout kept the registration's secret")
	}
}

// TestLoginRefusals: a peer, a gh server, metadata that names another resource or issuer, and a configured secret the
// store can't give each refuse the login before the human is sent anywhere.
func TestLoginRefusals(t *testing.T) {
	ctx := context.Background()
	f := newAuthServer(t)
	peer := loginFixture(t, f, `{"type":"oauth"}`)
	peer.settings.Home = "main"
	peer.a.opt.Machine = "p"
	cases := map[string]struct {
		fx   *fixture
		set  func()
		want string
	}{
		"a peer":           {peer, nil, "prov: log in on main, which keeps the MCP logins"},
		"gh":               {loginFixture(t, f, `{"type":"gh"}`), nil, "prov logs in with gh, not OAuth"},
		"another resource": {loginFixture(t, f, `{"type":"oauth"}`), func() { f.resource = f.srv.URL + "/other" }, "names " + f.srv.URL + "/other"},
		"another issuer":   {loginFixture(t, f, `{"type":"oauth"}`), func() { f.issuer = "https://evil.example" }, "claims issuer https://evil.example"},
		"a missing secret": {loginFixture(t, f, `{"type":"oauth","client_id":"c","client_secret":{"secret":"nope"}}`), nil, "its client secret nope isn't in the secret store"},
		"no auth":          {loginFixture(t, f, `null`), nil, "MCP server prov has no auth configured"},
	}
	for name, c := range cases {
		f.mu.Lock()
		f.resource, f.issuer = "", ""
		f.mu.Unlock()
		if c.set != nil {
			f.mu.Lock()
			c.set()
			f.mu.Unlock()
		}
		u, err := c.fx.a.StartLogin(ctx, "prov", "https://web.example/oauth/callback")
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %q %v, want %q", name, u, err, c.want)
		}
	}
	if f.regs != 0 {
		t.Errorf("%d registrations for refused logins", f.regs)
	}
}

// TestLoginStateExpires: a state older than ten minutes is refused before any code is exchanged, and is gone after.
func TestLoginStateExpires(t *testing.T) {
	f := newAuthServer(t)
	fx := loginFixture(t, f, `{"type":"oauth"}`)
	ctx := context.Background()
	u, err := fx.a.StartLogin(ctx, "prov", "https://web.example/oauth/callback")
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(u)
	state := parsed.Query().Get("state")
	fx.a.loginMu.Lock()
	p := fx.a.logins[state]
	p.at = time.Now().Add(-loginTTL - time.Second)
	fx.a.logins[state] = p
	fx.a.loginMu.Unlock()
	if _, err := fx.a.FinishLogin(ctx, "CODE", state); err == nil || err.Error() != "the login state has expired" {
		t.Errorf("an expired state: %v", err)
	}
	if _, err := fx.a.FinishLogin(ctx, "CODE", state); err == nil || err.Error() != "unknown or already used login state" {
		t.Errorf("the expired state again: %v", err)
	}
	if len(f.forms) != 0 {
		t.Errorf("a code was exchanged for an expired state: %v", f.forms)
	}
}

// TestLogoutKeepsNamedSecret: a client secret under the server's own store name that the settings name too stays at
// logout, since the next login needs it (S-2736); the grant goes.
func TestLogoutKeepsNamedSecret(t *testing.T) {
	ref, _ := config.McpClientSecretName("prov")
	f := newAuthServer(t)
	fx := loginFixture(t, f, `{"type":"oauth","client_id":"c","client_secret":{"secret":"`+ref+`"}}`)
	if _, err := fx.a.opt.Secrets.SetMcpClientSecret("prov", "configured-secret-77"); err != nil {
		t.Fatal(err)
	}
	if err := fx.a.update(func(s *jsjson.Object) *jsjson.Object {
		s.Set("prov", jsjson.NewObject("client_id", "c", "client_secret", jsjson.NewObject("secret", ref), "access_token", "AT"))
		return s
	}); err != nil {
		t.Fatal(err)
	}
	if err := fx.a.Logout("prov"); err != nil {
		t.Fatal(err)
	}
	if _, ok := fx.a.read().Get("prov"); ok {
		t.Errorf("logout kept the grant")
	}
	if v, ok := fx.a.opt.Secrets.Get(ref); !ok || v.Reveal() != "configured-secret-77" {
		t.Errorf("logout removed the secret the settings name")
	}
}

package mcpauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// The login flow (src/mcp-auth.ts startLogin, finishLogin, S-50): discovery of the protected resource and its
// authorization server, dynamic client registration when no client_id is configured, PKCE with S256, and a single-use
// state kept in memory for ten minutes. A client secret the login used is kept in the secret store once the login has
// worked, and the grant names it (S-2736).

// loginTTL is how long a started login's state stays valid.
const loginTTL = 10 * time.Minute

// pendingLogin is a started login, keyed by its state.
type pendingLogin struct {
	name, verifier, redirect, clientID string
	clientSecret                       jsjson.Value
	tokenEndpoint, resource            string
	scopes                             []string
	at                                 time.Time
}

func trimSlash(s string) string { return strings.TrimRight(s, "/") }

func b64url(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// refuseOnPeer is src/mcp-auth.ts refuseOnPeer: a peer issues no logins; the error names the home.
func (a *Auth) refuseOnPeer(name, what string) error {
	if a.isSettingsHome() {
		return nil
	}
	home := a.opt.Settings().Home
	return fmt.Errorf("%s: %s on %s, which keeps the MCP logins; this machine leases them from %s", name, what, home, home)
}

// getJSON is fetchJson of a GET; any error is the caller's "not found here".
func (a *Auth) getJSON(ctx context.Context, target string) (jsjson.Value, error) {
	return a.fetchJSON(ctx, http.MethodGet, target, nil, nil)
}

// postJSON posts a JSON body after the trust check.
func (a *Auth) postJSON(ctx context.Context, target string, body jsjson.Value) (jsjson.Value, error) {
	if err := a.assertEndpoint(ctx, target); err != nil {
		return nil, err
	}
	h := http.Header{}
	h.Set("content-type", "application/json")
	return a.fetchJSON(ctx, http.MethodPost, target, h, []byte(jsjson.Stringify(body, "")))
}

var resourceMetadata = regexp.MustCompile(`resource_metadata="([^"]+)"`)

// hasAuthServers is `md?.authorization_servers?.length`.
func hasAuthServers(md jsjson.Value) bool {
	s, ok := field(md, "authorization_servers").([]jsjson.Value)
	return ok && len(s) > 0
}

// discover is the protected-resource metadata of a server url: first the 401's WWW-Authenticate resource_metadata, then
// /.well-known/oauth-protected-resource with the url's path, then at the origin.
func (a *Auth) discover(ctx context.Context, resourceURL string) (jsjson.Value, error) {
	init := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"stam","version":"2"}}}`
	if req, err := http.NewRequestWithContext(ctx, http.MethodPost, resourceURL, strings.NewReader(init)); err == nil {
		req.Header.Set("content-type", "application/json")
		req.Header.Set("accept", "application/json, text/event-stream")
		if res, err := a.cli.Do(req); err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusUnauthorized {
				if m := resourceMetadata.FindStringSubmatch(res.Header.Get("www-authenticate")); m != nil && a.assertEndpoint(ctx, m[1]) == nil {
					if md, err := a.getJSON(ctx, m[1]); err == nil && hasAuthServers(md) {
						return md, nil
					}
				}
			}
		}
	}
	u, err := url.Parse(resourceURL)
	if err != nil {
		return nil, fmt.Errorf("not a url: %s", resourceURL)
	}
	origin := u.Scheme + "://" + u.Host
	for _, c := range []string{origin + "/.well-known/oauth-protected-resource" + u.EscapedPath(), origin + "/.well-known/oauth-protected-resource"} {
		if md, err := a.getJSON(ctx, c); err == nil && hasAuthServers(md) {
			return md, nil
		}
	}
	return nil, fmt.Errorf("no OAuth protected-resource metadata for %s", resourceURL)
}

// authServerMetadata is the authorization server's metadata (RFC 8414, then OIDC discovery). Its issuer must be the one
// it was fetched for, and every endpoint it names must pass the trust check.
func (a *Auth) authServerMetadata(ctx context.Context, issuer string) (jsjson.Value, error) {
	if err := a.assertEndpoint(ctx, issuer); err != nil {
		return nil, err
	}
	base := trimSlash(issuer)
	for _, c := range []string{base + "/.well-known/oauth-authorization-server", base + "/.well-known/openid-configuration"} {
		md, err := a.getJSON(ctx, c)
		if err != nil || !jsjson.Truthy(field(md, "authorization_endpoint")) || !jsjson.Truthy(field(md, "token_endpoint")) {
			continue
		}
		claimed := field(md, "issuer")
		claimedText := ""
		if claimed != nil {
			claimedText = jsjson.ToString(claimed)
		}
		if trimSlash(claimedText) != base {
			return nil, fmt.Errorf("authorization-server metadata for %s claims issuer %s", base, jsString(claimed))
		}
		for _, k := range []string{"authorization_endpoint", "token_endpoint", "registration_endpoint"} {
			if v := field(md, k); jsjson.Truthy(v) {
				if err := a.assertEndpoint(ctx, jsjson.ToString(v)); err != nil {
					return nil, err
				}
			}
		}
		return md, nil
	}
	return nil, fmt.Errorf("no OAuth authorization-server metadata for %s", issuer)
}

// jsString is a value as a template literal shows it: "undefined" for none.
func jsString(v jsjson.Value) string {
	if v == nil {
		return "undefined"
	}
	return jsjson.ToString(v)
}

// registerClient registers stam as a public client with PKCE (RFC 7591) when no client_id is configured.
func (a *Auth) registerClient(ctx context.Context, md jsjson.Value, redirect string, scopes []string) (string, jsjson.Value, error) {
	endpoint := field(md, "registration_endpoint")
	if !jsjson.Truthy(endpoint) {
		return "", nil, errors.New("the server has no dynamic registration endpoint and no client_id is configured")
	}
	body := jsjson.NewObject("client_name", "stam", "redirect_uris", []jsjson.Value{redirect},
		"grant_types", []jsjson.Value{"authorization_code", "refresh_token"}, "response_types", []jsjson.Value{"code"},
		"token_endpoint_auth_method", "none")
	if len(scopes) > 0 {
		body.Set("scope", strings.Join(scopes, " "))
	}
	reg, err := a.postJSON(ctx, jsjson.ToString(endpoint), body)
	if err != nil {
		return "", nil, err
	}
	id := field(reg, "client_id")
	if !jsjson.Truthy(id) {
		return "", nil, errors.New("dynamic client registration returned no client_id")
	}
	return jsjson.ToString(id), field(reg, "client_secret"), nil
}

// resourceMatches is whether the protected resource's `resource` has the server url's origin and is its path or a
// prefix of it, so metadata can't point the grant at another host or a sibling path.
func resourceMatches(prmResource, serverURL string) bool {
	r, err1 := url.Parse(prmResource)
	s, err2 := url.Parse(serverURL)
	if err1 != nil || err2 != nil || r.Scheme == "" || r.Host == "" || r.Scheme != s.Scheme || !strings.EqualFold(r.Host, s.Host) {
		return false
	}
	rp, sp := trimSlash(r.EscapedPath()), trimSlash(s.EscapedPath())
	return rp == "" || sp == rp || strings.HasPrefix(sp, rp+"/")
}

// strings of a JSON array value; nil when it is none.
func stringList(v jsjson.Value) ([]string, bool) {
	arr, ok := v.([]jsjson.Value)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		out = append(out, jsjson.ToString(x))
	}
	return out, true
}

// StartLogin begins a login and returns the authorize URL to open; redirect is the web UI's /oauth/callback. A
// configured client secret the store can't give fails here, before the human goes to the browser.
func (a *Auth) StartLogin(ctx context.Context, name, redirect string) (string, error) {
	if err := a.refuseOnPeer(name, "log in"); err != nil {
		return "", err
	}
	serverURL, typ, err := a.authFor(ctx, name)
	if err != nil {
		return "", err
	}
	if typ != "oauth" {
		return "", fmt.Errorf("%s logs in with gh, not OAuth", name)
	}
	prm, err := a.discover(ctx, serverURL)
	if err != nil {
		return "", err
	}
	if res := field(prm, "resource"); jsjson.Truthy(res) && !resourceMatches(jsjson.ToString(res), serverURL) {
		return "", fmt.Errorf("protected-resource metadata for %s names %s", serverURL, jsjson.ToString(res))
	}
	servers, _ := field(prm, "authorization_servers").([]jsjson.Value)
	md, err := a.authServerMetadata(ctx, jsjson.ToString(servers[0]))
	if err != nil {
		return "", err
	}
	srv, _ := a.server(name)
	auth := field(srv, "auth")
	scopes, ok := stringList(field(auth, "scopes"))
	if !ok {
		scopes, _ = stringList(field(prm, "scopes_supported"))
	}
	clientID, clientSecret := "", jsjson.Value(nil)
	if id := field(auth, "client_id"); jsjson.Truthy(id) {
		clientID, clientSecret = jsjson.ToString(id), field(auth, "client_secret")
	} else if clientID, clientSecret, err = a.registerClient(ctx, md, redirect, scopes); err != nil {
		return "", err
	}
	if _, err := a.clientSecretValue(name, clientSecret); err != nil {
		return "", err
	}
	resource := serverURL
	if res := field(prm, "resource"); res != nil {
		resource = jsjson.ToString(res)
	}
	state, err := b64url(24)
	if err != nil {
		return "", err
	}
	verifier, err := b64url(32)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	a.loginMu.Lock()
	for k, p := range a.logins {
		if time.Since(p.at) > loginTTL {
			delete(a.logins, k)
		}
	}
	a.logins[state] = pendingLogin{name: name, verifier: verifier, redirect: redirect, clientID: clientID, clientSecret: clientSecret,
		tokenEndpoint: jsjson.ToString(field(md, "token_endpoint")), resource: resource, scopes: scopes, at: time.Now()}
	a.loginMu.Unlock()
	params := [][2]string{{"response_type", "code"}, {"client_id", clientID}, {"redirect_uri", redirect}, {"state", state},
		{"code_challenge", challenge}, {"code_challenge_method", "S256"}, {"resource", resource}}
	if len(scopes) > 0 {
		params = append(params, [2]string{"scope", strings.Join(scopes, " ")})
	}
	q := make([]string, len(params))
	for i, p := range params {
		q[i] = url.QueryEscape(p[0]) + "=" + url.QueryEscape(p[1])
	}
	endpoint := jsjson.ToString(field(md, "authorization_endpoint"))
	sep := "?"
	if strings.Contains(endpoint, "?") {
		sep = "&"
	}
	return endpoint + sep + strings.Join(q, "&"), nil
}

// FinishLogin completes a login: it checks the single-use state, exchanges the code with the PKCE verifier and the
// resource it was issued for, and stores the grant. It returns the server's name.
func (a *Auth) FinishLogin(ctx context.Context, code, state string) (string, error) {
	a.loginMu.Lock()
	p, ok := a.logins[state]
	delete(a.logins, state)
	a.loginMu.Unlock()
	if !ok {
		return "", errors.New("unknown or already used login state")
	}
	if time.Since(p.at) > loginTTL {
		return "", errors.New("the login state has expired")
	}
	srv, _ := a.server(p.name)
	serverURL, _ := field(srv, "url").(string)
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", p.redirect)
	form.Set("client_id", p.clientID)
	form.Set("code_verifier", p.verifier)
	form.Set("resource", p.resource)
	secret, err := a.clientSecretValue(p.name, p.clientSecret)
	if err != nil {
		return "", err
	}
	if secret != "" {
		form.Set("client_secret", secret)
	}
	raw, err := a.postForm(ctx, p.tokenEndpoint, form)
	if err != nil {
		return "", err
	}
	tok, err := tokenResponse(raw)
	if err != nil {
		return "", err
	}
	if !jsjson.Truthy(field(tok, "access_token")) {
		return "", errors.New("the token endpoint returned no access_token")
	}
	kept, err := a.keepClientSecret(p.name, p.clientSecret)
	if err != nil {
		return "", err
	}
	return p.name, a.saveTokens(p.name, tok, grantParams{serverURL: serverURL, clientID: p.clientID, tokenEndpoint: p.tokenEndpoint,
		resource: p.resource, clientSecret: kept, scopes: p.scopes}, nil)
}

// keepClientSecret is the reference a grant keeps for a client secret: a settings reference as it is, and a plain string
// (a registration's, or an old settings value) moved into the store under the server's name first.
func (a *Auth) keepClientSecret(server string, secret jsjson.Value) (jsjson.Value, error) {
	if !jsjson.Truthy(secret) {
		return nil, nil
	}
	if _, ok := config.IsSecretRef(secret); ok {
		return secret, nil
	}
	if a.opt.Secrets == nil {
		return nil, fmt.Errorf("%s: there is no secret store to keep its client secret in", server)
	}
	name, err := a.opt.Secrets.SetMcpClientSecret(server, jsjson.ToString(secret))
	if err != nil {
		return nil, err
	}
	return jsjson.NewObject("secret", name), nil
}

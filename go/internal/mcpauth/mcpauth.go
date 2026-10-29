// Package mcpauth holds the daemon's OAuth logins for remote MCP servers (S-50): the grants in STAM_HOME/mcp-auth.json
// (mode 0600), the bearer the proxy asks for (token, tokenFor), the refresh near expiry (one per server at a time, S-3176),
// the `gh` login, the status rows, and the lease: a home leases its bearers to a peer (S-3176, LeaseFor), and a peer holds
// a copy of a lease in memory only (S-3177, peerLease). It ports src/mcp-auth.ts.
//
// A trust boundary: every URL a bearer is sent to must be https and public (assertEndpoint), no request follows a
// redirect, and a token never reaches an error message, a log line or a status row.
package mcpauth

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// Options is what the auth reads: the home (the store is Home/mcp-auth.json), this daemon's name (the settings home is
// this machine when settings.home names it), the settings, and Insecure, which lets a test use loopback http.
type Options struct {
	Home     string
	Machine  string
	Settings func() config.Settings
	Insecure bool
	// Client is the client for the provider's endpoints; nil is a 15 s client that follows no redirect.
	Client *http.Client
	// HomeGet is a GET to the settings home's peer routes, with the bearer p carries (its lease token). It returns the
	// home's status and body; an error when the home doesn't answer. Nil on a machine that never leases.
	HomeGet func(ctx context.Context, p config.Peer, path string) (int, []byte, error)
	// Secrets is the home's secret store, which holds the client secrets (S-2736); nil reads as an empty store.
	Secrets *config.Secrets
}

// Auth is the daemon's MCP auth.
type Auth struct {
	opt Options
	cli *http.Client

	// mu guards the store file (each read-modify-write) and the refreshes in flight; ghMu the gh cache, held across gh.
	mu         sync.Mutex
	refreshing map[string]*flight
	ghMu       sync.Mutex
	ghAt       time.Time
	ghTok      string

	// afterTemp, when set by a test, runs once a write has its temp file and before it writes.
	afterTemp func()

	// leaseMu guards the leases a peer holds in memory and the fetches in flight (S-3177). Nothing here is written to disk.
	leaseMu sync.Mutex
	held    map[string]heldLease
	leasing map[string]*leaseFlight

	// loginMu guards the logins started and not yet finished, by state (login.go). They live in memory only.
	loginMu sync.Mutex
	logins  map[string]pendingLogin
}

// flight is one refresh in flight: its callers wait on done and share err.
type flight struct {
	done chan struct{}
	err  error
}

// New returns the auth of opt.
func New(opt Options) *Auth {
	cli := opt.Client
	if cli == nil {
		cli = &http.Client{
			Timeout:       15 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	sweepTemps(opt.Home)
	return &Auth{opt: opt, cli: cli, refreshing: map[string]*flight{}, held: map[string]heldLease{}, leasing: map[string]*leaseFlight{}, logins: map[string]pendingLogin{}}
}

// tempName is a store temp file: `.mcp-auth.PID.RANDOM.tmp`, named by the daemon that writes it (write).
var tempName = regexp.MustCompile(`^\.mcp-auth\.([1-9][0-9]*)\.[0-9]+\.tmp$`)

// sweepTemps removes the temp files a crashed daemon left between CreateTemp and Rename in write: each holds a whole
// store, secrets included, so none is kept. A file whose writer is alive is kept, since that writer may still rename it
// over the store. Nothing else in home matches the pattern.
func sweepTemps(home string) {
	if home == "" {
		return
	}
	entries, _ := os.ReadDir(home)
	for _, e := range entries {
		m := tempName.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		pid, err := strconv.Atoi(m[1])
		if err == nil && pid <= math.MaxInt32 && deadPID(pid) {
			_ = os.Remove(filepath.Join(home, e.Name()))
		}
	}
}

// deadPID is whether no process has pid. Signal 0 answers ESRCH only when there is none; any other answer (the process
// is alive, or this one may not signal it) means it may still write.
func deadPID(pid int) bool {
	return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
}

// The longest a `gh auth token` answer is kept: the proxy asks often, and gh shouldn't run each time.
const ghCacheFor = 5 * time.Minute

// The grant store: its path, and the whole file as a JS-ordered object (keys are server names).
func (a *Auth) file() string { return filepath.Join(a.opt.Home, "mcp-auth.json") }

// load reads the store; a missing, unreadable or non-object file is an empty store, as store() in TS.
func (a *Auth) load() *jsjson.Object {
	raw, err := os.ReadFile(a.file())
	if err != nil {
		return jsjson.NewObject()
	}
	v, err := jsjson.Parse(raw)
	if err != nil {
		return jsjson.NewObject()
	}
	o, ok := v.(*jsjson.Object)
	if !ok {
		return jsjson.NewObject()
	}
	return o
}

// write saves the whole store, mode 0600, as TS's writeStore writes it. It goes to a temp file beside the store, is
// fsynced, and is renamed over it, so a reader sees the old store or the new one, never a truncated or half-written
// file. The temp file is created 0600 (CreateTemp), so the store is never readable by another user while it is written.
func (a *Auth) write(s *jsjson.Object) error {
	tmp, err := os.CreateTemp(a.opt.Home, fmt.Sprintf(".mcp-auth.%d.*.tmp", os.Getpid()))
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op once the rename has moved it
	if a.afterTemp != nil {
		a.afterTemp()
	}
	_, werr := tmp.WriteString(jsjson.Stringify(s, "  ") + "\n")
	if werr == nil {
		werr = tmp.Sync()
	}
	if cerr := tmp.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return werr
	}
	if err := os.Rename(tmp.Name(), a.file()); err != nil {
		return err
	}
	return os.Chmod(a.file(), 0o600)
}

// read is the store as a reader sees it: under mu, so a read never overlaps a write this daemon makes.
func (a *Auth) read() *jsjson.Object {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.load()
}

// update applies fn to the store and writes the result, under mu, so no other write to the store lands between its
// read and its write.
func (a *Auth) update(fn func(*jsjson.Object) *jsjson.Object) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.write(fn(a.load()))
}

// grant is one server's stored login, read from its entry in the store.
type grant struct {
	serverURL, clientID, tokenEndpoint, resource string
	accessToken, refreshToken                    string
	clientSecret                                 jsjson.Value
	scopes                                       []string
	expiresAt                                    float64
	hasExpiry                                    bool
}

func grantOf(e *jsjson.Object) grant {
	g := grant{
		serverURL:     str(e, "server_url"),
		clientID:      str(e, "client_id"),
		tokenEndpoint: str(e, "token_endpoint"),
		resource:      str(e, "resource"),
		accessToken:   str(e, "access_token"),
		refreshToken:  str(e, "refresh_token"),
	}
	g.clientSecret, _ = e.Get("client_secret")
	if v, ok := e.Get("scopes"); ok {
		if list, ok := v.([]jsjson.Value); ok {
			for _, s := range list {
				if t, ok := s.(string); ok {
					g.scopes = append(g.scopes, t)
				}
			}
		}
	}
	if n, ok := num(e, "expires_at"); ok {
		g.expiresAt, g.hasExpiry = n, true
	}
	return g
}

// str is the string at key, "" when it is absent or not a string.
func str(o *jsjson.Object, key string) string {
	v, _ := o.Get(key)
	s, _ := v.(string)
	return s
}

// num is the number at key, and whether there is one.
func num(o *jsjson.Object, key string) (float64, bool) {
	v, _ := o.Get(key)
	n, ok := v.(float64)
	return n, ok
}

// field is the value at key of a parsed JSON value, nil when it is not an object or has no such key.
func field(v jsjson.Value, key string) jsjson.Value {
	o, ok := v.(*jsjson.Object)
	if !ok {
		return nil
	}
	x, _ := o.Get(key)
	return x
}

// The IPv6 prefixes privateIP refuses, as src/mcp-auth.ts writes them.
var (
	ula       = regexp.MustCompile(`^f[cd][0-9a-f]{2}:`)
	linkLocal = regexp.MustCompile(`^fe[89ab][0-9a-f]:`)
	multicast = regexp.MustCompile(`^ff[0-9a-f]{2}:`)
)

// privateIP is true for a loopback, private, link-local, CGNAT, or otherwise non-global address, and for an address it
// can't parse (src/mcp-auth.ts privateIp, the same rules in the same order).
func privateIP(ip string) bool {
	v := strings.ToLower(ip)
	if strings.HasPrefix(v, "::ffff:") {
		return privateIP(v[7:])
	}
	if strings.Contains(v, ":") {
		return v == "::1" || v == "::" || ula.MatchString(v) || linkLocal.MatchString(v) || multicast.MatchString(v)
	}
	parts := strings.Split(v, ".")
	if len(parts) != 4 {
		return true
	}
	var p [4]int
	for i, s := range parts {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 || n > 255 {
			return true
		}
		p[i] = n
	}
	a, b, c := p[0], p[1], p[2]
	switch {
	case a == 0 || a == 10 || a == 127 || a >= 224:
		return true
	case a == 169 && b == 254:
		return true
	case a == 172 && b >= 16 && b <= 31:
		return true
	case a == 192 && b == 168:
		return true
	case a == 100 && b >= 64 && b <= 127: // CGNAT
		return true
	case a == 192 && b == 0 && c == 2: // TEST-NET-1
		return true
	case a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)):
		return true
	case a == 203 && b == 0 && c == 113: // TEST-NET-3
		return true
	}
	return false
}

// assertEndpoint refuses a URL a bearer or a credential could be sent to unless it is https (unless a test opted out)
// and its host is public: an address literal is checked as it is, a name by every address it resolves to.
func (a *Auth) assertEndpoint(ctx context.Context, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("not a url: %s", raw)
	}
	if a.opt.Insecure {
		return nil
	}
	if u.Scheme != "https" {
		return fmt.Errorf("MCP auth requires https, not %s://%s", u.Scheme, u.Host)
	}
	host := u.Hostname()
	if net.ParseIP(host) != nil {
		if privateIP(host) {
			return fmt.Errorf("MCP auth refuses the private address %s", host)
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(addrs) == 0 {
		return fmt.Errorf("MCP auth can't resolve %s", host)
	}
	for _, addr := range addrs {
		if privateIP(addr.IP.String()) {
			return fmt.Errorf("MCP auth refuses %s (%s)", host, addr.IP.String())
		}
	}
	return nil
}

// fetchJSON sends one request and reads its JSON answer; an empty answer is an empty object. A non-2xx answer is an
// error that names the status and the URL, never the body, which can hold a credential.
func (a *Auth) fetchJSON(ctx context.Context, method, target string, header http.Header, body []byte) (jsjson.Value, error) {
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("request to %s: %w", target, err)
	}
	req.Header.Set("accept", "application/json")
	for k, vs := range header {
		req.Header[k] = vs
	}
	res, err := a.cli.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request to %s failed", target)
	}
	defer res.Body.Close()
	text, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("reading %s failed", target)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("HTTP %d from %s", res.StatusCode, target)
	}
	if len(bytes.TrimSpace(text)) == 0 {
		return jsjson.NewObject(), nil
	}
	// A parse error may quote the body, which can hold a credential, so the message is fixed (S-3503).
	v, err := jsjson.Parse(text)
	if err != nil {
		return nil, fmt.Errorf("an OAuth endpoint answered non-JSON from %s", target)
	}
	return v, nil
}

// postForm posts a form to a token endpoint, after the trust check.
func (a *Auth) postForm(ctx context.Context, target string, form url.Values) (jsjson.Value, error) {
	if err := a.assertEndpoint(ctx, target); err != nil {
		return nil, err
	}
	h := http.Header{}
	h.Set("content-type", "application/x-www-form-urlencoded")
	return a.fetchJSON(ctx, http.MethodPost, target, h, []byte(form.Encode()))
}

// providerCodes are the provider errors that may be echoed, and nothing else, so no token-shaped string a provider puts in
// its error can pass: the OAuth codes of RFC 6749 §5.2 and the authorization errors, and the error codes of Slack's
// oauth.v2.access (its Errors table, the `ok: false` answer; docs.slack.dev/reference/methods/oauth.v2.access).
var providerCodes = map[string]bool{
	// RFC 6749.
	"invalid_request": true, "invalid_client": true, "invalid_grant": true, "unauthorized_client": true,
	"unsupported_grant_type": true, "invalid_scope": true, "access_denied": true, "server_error": true,
	"temporarily_unavailable": true,
	// Slack oauth.v2.access.
	"accesslimited": true, "account_inactive": true, "bad_client_secret": true, "bad_redirect_uri": true,
	"cannot_install_an_org_installed_app": true, "deprecated_endpoint": true, "ekm_access_denied": true,
	"enterprise_is_restricted": true, "fatal_error": true, "internal_error": true, "invalid_arg_name": true,
	"invalid_arguments": true, "invalid_array_arg": true, "invalid_auth": true, "invalid_charset": true,
	"invalid_client_id": true, "invalid_code": true, "invalid_code_verifier": true, "invalid_form_data": true,
	"invalid_grant_type": true, "invalid_post_type": true, "invalid_refresh_token": true, "method_deprecated": true,
	"missing_post_type": true, "missing_scope": true, "no_permission": true, "no_scopes": true,
	"not_allowed_token_type": true, "not_authed": true, "oauth_authorization_url_mismatch": true,
	"org_login_required": true, "pkce_not_allowed": true, "preview_feature_not_available": true, "ratelimited": true,
	"request_timeout": true, "service_unavailable": true, "team_access_not_granted": true, "team_added_to_org": true,
	"token_expired": true, "token_revoked": true, "two_factor_setup_required": true, "user_email_unverified": true,
}

// tokenResponse is what the token endpoint's answer means here. Slack answers 200 with `ok: false` and an `error`, and
// its user token sits under `authed_user`, which is used when the top level has no access_token (tokenResponse in TS).
func tokenResponse(tok jsjson.Value) (jsjson.Value, error) {
	if ok, isBool := field(tok, "ok").(bool); isBool && !ok {
		// The provider's error is echoed only when it is one of the OAuth error codes (providerCodes). Anything else is a
		// fixed message: a provider can put a token or a secret in its error, and that must not reach an error, a log or
		// a status.
		msg := "unknown error"
		if e, isStr := field(tok, "error").(string); isStr && providerCodes[e] {
			msg = e
		}
		return nil, fmt.Errorf("the token endpoint refused: %s", msg)
	}
	if !jsjson.Truthy(field(tok, "access_token")) {
		if au := field(tok, "authed_user"); jsjson.Truthy(field(au, "access_token")) {
			return jsjson.NewObject(
				"access_token", field(au, "access_token"),
				"refresh_token", field(au, "refresh_token"),
				"expires_in", field(au, "expires_in"),
			), nil
		}
	}
	return tok, nil
}

// grantParams are what a grant keeps about its server and client, as saveTokens takes them.
type grantParams struct {
	serverURL, clientID, tokenEndpoint, resource string
	clientSecret                                 jsjson.Value
	scopes                                       []string
}

// saveTokens stores the tokens of a grant under name. A refresh keeps the old refresh_token when the response omits
// one (prev is the grant being refreshed); a response with no expires_in gets no expiry, so an old one never passes
// as the new token's (S-3176).
func (a *Auth) saveTokens(name string, tok jsjson.Value, p grantParams, prev *jsjson.Object) error {
	e := jsjson.NewObject("server_url", p.serverURL, "client_id", p.clientID)
	if jsjson.Truthy(p.clientSecret) {
		e.Set("client_secret", p.clientSecret)
	}
	e.Set("token_endpoint", p.tokenEndpoint)
	e.Set("resource", p.resource)
	if len(p.scopes) > 0 {
		e.Set("scopes", scopesValue(p.scopes))
	}
	if at := field(tok, "access_token"); jsjson.Truthy(at) {
		e.Set("access_token", jsjson.ToString(at))
	}
	if rt := field(tok, "refresh_token"); jsjson.Truthy(rt) {
		e.Set("refresh_token", jsjson.ToString(rt))
	} else if prev != nil {
		if old, _ := prev.Get("refresh_token"); jsjson.Truthy(old) {
			e.Set("refresh_token", old)
		}
	}
	if n, ok := field(tok, "expires_in").(float64); ok {
		e.Set("expires_at", float64(time.Now().UnixMilli())+n*1000)
	}
	return a.update(func(s *jsjson.Object) *jsjson.Object {
		s.Set(name, e)
		return s
	})
}

// without is the store with name's entry removed, keys in their order.
func without(s *jsjson.Object, name string) *jsjson.Object {
	out := jsjson.NewObject()
	for _, k := range s.Keys() {
		if k != name {
			v, _ := s.Get(k)
			out.Set(k, v)
		}
	}
	return out
}

func scopesValue(scopes []string) []jsjson.Value {
	out := make([]jsjson.Value, 0, len(scopes))
	for _, s := range scopes {
		out = append(out, s)
	}
	return out
}

// clientSecretValue is src/mcp-auth.ts clientSecretValue, the secret a request sends: a plain string is checked and used
// until the write path moves it into the store. A reference is read from the secret store, and one the store doesn't
// give (absent, or a store that can't be read) is an error, never a silent drop. Only an entry tagged `mcp` is a client
// secret, so a provider's key never goes to an MCP server's token endpoint. The error names the entry, never its value.
func (a *Auth) clientSecretValue(server string, secret jsjson.Value) (string, error) {
	if !jsjson.Truthy(secret) {
		return "", nil
	}
	if v, ok := secret.(string); ok {
		if !checkCredential(v) {
			return "", fmt.Errorf("invalid %s's client secret", server)
		}
		return v, nil
	}
	name, ok := config.IsSecretRef(secret)
	if !ok {
		return "", fmt.Errorf("invalid %s's client secret", server)
	}
	if a.opt.Secrets != nil {
		if provider, held := a.opt.Secrets.ProviderOf(name); held && provider != "mcp" {
			return "", fmt.Errorf("%s: %s is not an MCP client secret", server, name)
		}
		if v, held := a.opt.Secrets.Get(name); held {
			return v.Reveal(), nil
		}
	}
	// Client secrets live in each machine's own store, and only the home machine's holds them.
	if !a.isSettingsHome() {
		return "", fmt.Errorf("%s: log in on the home machine, which keeps its client secret", server)
	}
	return "", fmt.Errorf("%s: its client secret %s isn't in the secret store", server, name)
}

// checkCredential is src/llm/http.ts checkCredential: printable ASCII, no space.
func checkCredential(v string) bool {
	for _, r := range v {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return v != ""
}

// refresh trades a grant's refresh_token for a new access token and stores it.
func (a *Auth) refresh(ctx context.Context, name string, g grant, prev *jsjson.Object) error {
	if g.refreshToken == "" || g.tokenEndpoint == "" || g.clientID == "" {
		return fmt.Errorf("%s has no refresh_token", name)
	}
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {g.refreshToken}, "client_id": {g.clientID}}
	if g.resource != "" {
		form.Set("resource", g.resource)
	}
	secret, err := a.clientSecretValue(name, g.clientSecret)
	if err != nil {
		return err
	}
	if secret != "" {
		form.Set("client_secret", secret)
	}
	answer, err := a.postForm(ctx, g.tokenEndpoint, form)
	if err != nil {
		return err
	}
	tok, err := tokenResponse(answer)
	if err != nil {
		return err
	}
	return a.saveTokens(name, tok, grantParams{
		serverURL:     g.serverURL,
		clientID:      g.clientID,
		tokenEndpoint: g.tokenEndpoint,
		resource:      g.resource,
		clientSecret:  g.clientSecret,
		scopes:        g.scopes,
	}, prev)
}

// refreshOnce runs one refresh of name at a time: a caller that arrives while one runs waits for it and shares its
// result, since a provider that rotates refresh tokens revokes the family when two refreshes race (S-3176). A caller
// after a refresh that left the grant fresh doesn't refresh again, unless it forces one.
func (a *Auth) refreshOnce(ctx context.Context, name string, force bool) error {
	a.mu.Lock()
	if f, ok := a.refreshing[name]; ok {
		a.mu.Unlock()
		return f.wait(ctx)
	}
	s := a.load()
	e, ok := s.Get(name)
	eo, isObj := e.(*jsjson.Object)
	if !ok || !isObj {
		a.mu.Unlock()
		return nil
	}
	g := grantOf(eo)
	if g.refreshToken == "" {
		a.mu.Unlock()
		return nil
	}
	if !force && g.hasExpiry && g.expiresAt != 0 && float64(time.Now().UnixMilli()) <= g.expiresAt-60_000 {
		a.mu.Unlock()
		return nil
	}
	f := &flight{done: make(chan struct{})}
	a.refreshing[name] = f
	a.mu.Unlock()

	// The refresh runs on its own: a provider that rotates the refresh token has already done so, so a caller that
	// goes away mid-request must not cancel the request and lose the new token. It has its own bounded timeout, as the
	// TS fetch has. The caller that started it waits like the others, and can give up with its own context.
	go func() {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), refreshTimeout)
		defer cancel()
		f.err = a.refresh(rctx, name, g, eo)
		a.mu.Lock()
		delete(a.refreshing, name)
		a.mu.Unlock()
		close(f.done)
	}()
	return f.wait(ctx)
}

// refreshTimeout bounds one refresh, as the TS fetch's 15 s does.
const refreshTimeout = 15 * time.Second

// wait is the refresh's result, or the caller's own cancellation if that comes first.
func (f *flight) wait(ctx context.Context) error {
	select {
	case <-f.done:
		return f.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// server is one entry of settings.mcpServers.
type server struct {
	name string
	obj  *jsjson.Object
}

// servers lists settings.mcpServers in JavaScript's key order, as Object.entries reads it (an array reads by index).
func (a *Auth) servers() []server {
	var out []server
	switch v := a.opt.Settings().McpServers.(type) {
	case *jsjson.Object:
		for _, k := range v.Keys() {
			x, _ := v.Get(k)
			o, _ := x.(*jsjson.Object)
			out = append(out, server{name: k, obj: o})
		}
	case []jsjson.Value:
		for i, x := range v {
			o, _ := x.(*jsjson.Object)
			out = append(out, server{name: strconv.Itoa(i), obj: o})
		}
	}
	return out
}

// server returns the entry named name, and whether there is one.
func (a *Auth) server(name string) (*jsjson.Object, bool) {
	for _, s := range a.servers() {
		if s.name == name {
			return s.obj, true
		}
	}
	return nil, false
}

// authType is the server's auth.type and whether it has an auth at all (a falsy auth is none).
func authType(s *jsjson.Object) (string, bool) {
	if s == nil {
		return "", false
	}
	v, _ := s.Get("auth")
	if !jsjson.Truthy(v) {
		return "", false
	}
	return jsjson.ToString(field(v, "type")), true
}

// authFor is the url and auth of a server that has one; any other is an error that names what is missing.
func (a *Auth) authFor(ctx context.Context, name string) (string, string, error) {
	s, _ := a.server(name)
	typ, has := authType(s)
	if !has {
		return "", "", fmt.Errorf("MCP server %s has no auth configured", name)
	}
	u, _ := s.Get("url")
	target, _ := u.(string)
	if target == "" {
		return "", "", fmt.Errorf("MCP server %s has no url", name)
	}
	if err := a.assertEndpoint(ctx, target); err != nil {
		return "", "", err
	}
	return target, typ, nil
}

// Token is the current bearer of a server: `gh`'s token, or the stored access token, refreshed with the refresh token
// when it is within a minute of expiry or when force is set. A grant made for another server url is refused, so a
// token never follows a moved server.
func (a *Auth) Token(ctx context.Context, name string, force bool) (string, error) {
	target, typ, err := a.authFor(ctx, name)
	if err != nil {
		return "", err
	}
	if typ == "gh" {
		return a.ghToken(ctx)
	}
	if !a.isSettingsHome() {
		l, err := a.peerLease(ctx, name, force, target)
		return l.token, err
	}
	g, ok := a.storedGrant(name)
	if !ok || (g.accessToken == "" && g.refreshToken == "") {
		return "", fmt.Errorf("%s is not logged in", name)
	}
	if g.serverURL != target {
		return "", fmt.Errorf("%s: the server url changed; log in again", name)
	}
	stale := !g.hasExpiry || g.expiresAt == 0 || float64(time.Now().UnixMilli()) > g.expiresAt-60_000
	if g.refreshToken != "" && (force || stale) {
		if err := a.refreshOnce(ctx, name, force); err != nil {
			return "", err
		}
		g, _ = a.storedGrant(name)
	}
	if g.accessToken == "" {
		return "", fmt.Errorf("%s is not logged in", name)
	}
	return g.accessToken, nil
}

// storedGrant is the stored login of name, and whether there is one.
func (a *Auth) storedGrant(name string) (grant, bool) {
	s := a.read()
	e, ok := s.Get(name)
	eo, isObj := e.(*jsjson.Object)
	if !ok || !isObj {
		return grant{}, false
	}
	return grantOf(eo), true
}

// Bearer is the proxy's answer: the server's name and url, the bearer, and when it expires (nil when it never does).
type Bearer struct {
	Name      string
	URL       string
	Token     string
	ExpiresAt *float64
}

// TokenFor is the bearer and the url to reach a server with it (tokenFor in TS).
func (a *Auth) TokenFor(ctx context.Context, name string, force bool) (Bearer, error) {
	target, typ, err := a.authFor(ctx, name)
	if err != nil {
		return Bearer{}, err
	}
	if typ != "gh" && !a.isSettingsHome() {
		l, err := a.peerLease(ctx, name, force, target)
		if err != nil {
			return Bearer{}, err
		}
		exp := l.expiresAt
		return Bearer{Name: name, URL: target, Token: l.token, ExpiresAt: &exp}, nil
	}
	value, err := a.Token(ctx, name, force)
	if err != nil {
		return Bearer{}, err
	}
	out := Bearer{Name: name, URL: target, Token: value}
	if g, ok := a.storedGrant(name); ok && g.hasExpiry {
		exp := g.expiresAt
		out.ExpiresAt = &exp
	}
	return out, nil
}

// isSettingsHome is whether this daemon is the settings home, the one that keeps the logins (isSettingsHome in TS).
func (a *Auth) isSettingsHome() bool { return a.opt.Settings().Home == a.opt.Machine }

// ghToken is the user's `gh auth token`, cached for five minutes (ghToken in TS).
func (a *Auth) ghToken(ctx context.Context) (string, error) {
	a.ghMu.Lock()
	defer a.ghMu.Unlock()
	if a.ghTok != "" && time.Since(a.ghAt) < ghCacheFor {
		return a.ghTok, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "gh", "auth", "token").Output()
	if err != nil {
		return "", errors.New("gh is not logged in")
	}
	tok := strings.TrimSpace(string(out))
	if tok == "" {
		return "", errors.New("gh is not logged in")
	}
	a.ghTok, a.ghAt = tok, time.Now()
	return tok, nil
}

// Logout forgets a server's stored login. Only the settings home holds one: a peer with no grant of its own is refused,
// naming the home. A client secret the registration made goes with it; one the settings name stays, since the next
// login needs it (S-2736).
func (a *Auth) Logout(name string) error {
	if _, ok := a.read().Get(name); !ok && !a.isSettingsHome() {
		home := a.opt.Settings().Home
		return fmt.Errorf("%s: log out on %s, which keeps the MCP logins; this machine leases them from %s", name, home, home)
	}
	var ref jsjson.Value
	if err := a.update(func(s *jsjson.Object) *jsjson.Object {
		ref = field(field(s, name), "client_secret")
		return without(s, name)
	}); err != nil {
		return err
	}
	secret, isRef := config.IsSecretRef(ref)
	own, _ := config.McpClientSecretName(name)
	if !isRef || secret != own || a.opt.Secrets == nil {
		return nil
	}
	srv, _ := a.server(name)
	if named, _ := config.IsSecretRef(field(field(srv, "auth"), "client_secret")); named == secret {
		return nil
	}
	_, err := a.opt.Secrets.Remove(secret)
	return err
}

// MoveClientSecrets is the token file's half of src/mcp-auth.ts migrateClientSecrets: each grant's plain client_secret
// becomes a reference to the store name move gives it; false leaves it in place. Nothing is written when none moved.
func (a *Auth) MoveClientSecrets(move func(server, value string) (string, bool)) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := a.load()
	changed := false
	for _, server := range s.Keys() {
		e, _ := field(s, server).(*jsjson.Object)
		value, _ := field(e, "client_secret").(string)
		if value == "" {
			continue
		}
		if ref, ok := move(server, value); ok {
			e.Set("client_secret", jsjson.NewObject("secret", ref))
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return a.write(s)
}

// Status is the status page: its rows, and on a peer the home's state (null on the home).
type Status struct {
	Servers []jsjson.Value
	Home    *jsjson.Object
}

// Rows is the status rows of this daemon, as the route answers them: `servers`, `home`. No row carries a token.
func (a *Auth) Rows(ctx context.Context) (Status, error) {
	if !a.isSettingsHome() {
		return a.peerRows(ctx), nil
	}
	return Status{Servers: a.localRows(ctx, func(string) bool { return true })}, nil
}

// peerRows are a peer's own rows: its gh logins, and any grant it still holds from before the lease. Then the home's
// shared rows, each marked leased_from the home. A home that doesn't answer leaves its rows out and says why, so no
// stale login is shown (peerStatus in TS).
func (a *Auth) peerRows(ctx context.Context) Status {
	home := a.opt.Settings().Home
	var rows []jsjson.Value
	s := a.read()
	for _, sv := range a.servers() {
		typ, has := authType(sv.obj)
		if !has {
			continue
		}
		if typ == "gh" {
			_, err := a.ghToken(ctx)
			rows = append(rows, jsjson.NewObject("name", sv.name, "type", "gh", "logged_in", err == nil, "expires_at", nil))
		} else if _, ok := s.Get(sv.name); ok {
			rows = append(rows, jsjson.NewObject("name", sv.name, "type", "oauth", "logged_in", false, "expires_at", nil, "local_grant", true))
		}
	}
	status, data, err := a.homeGet(ctx, "MCP status", "/api/peer/mcp/status")
	if err == nil && status != http.StatusOK {
		err = homeError("MCP status", home, status, data)
	}
	if err != nil {
		return Status{Servers: rows, Home: jsjson.NewObject("name", home, "reachable", false, "error", err.Error())}
	}
	leased, _ := field(data, "servers").([]jsjson.Value)
	for _, v := range leased {
		if row, ok := v.(*jsjson.Object); ok {
			row.Set("leased_from", home)
			rows = append(rows, row)
		}
	}
	return Status{Servers: rows, Home: jsjson.NewObject("name", home, "reachable", true)}
}

// heldLease is a peer's copy of a lease: the server's url, its bearer, and when it expires (ms). It is kept in memory
// only, per server and url.
type heldLease struct {
	url, token string
	expiresAt  float64
}

// leaseFlight is one fetch from the home in flight; its callers wait on done and share the result.
type leaseFlight struct {
	done   chan struct{}
	joined int // the asks that waited on this fetch, counted under leaseMu
	lease  heldLease
	err    error
}

// leaseTimeout bounds one fetch from the home. The fetch runs apart from the caller that started it, as a refresh does.
const leaseTimeout = 15 * time.Second

// peerLease is a peer's lease of server name for url want (peerLease in TS, S-3177). A copy serves until 60 s before it
// expires, and one fetch from the home serves every caller that asks while it runs. A forced ask joining a fetch that is
// already running gets that fetch's lease (the TS behaviour; S-3177 lists it as a follow-up).
func (a *Auth) peerLease(ctx context.Context, name string, force bool, want string) (heldLease, error) {
	key := name + "\n" + want
	a.leaseMu.Lock()
	if cur, ok := a.held[key]; ok && !force && cur.url == want && nowMs() <= cur.expiresAt-60_000 {
		a.leaseMu.Unlock()
		return cur, nil
	}
	if f, ok := a.leasing[key]; ok {
		f.joined++
		a.leaseMu.Unlock()
		return f.wait(ctx)
	}
	f := &leaseFlight{done: make(chan struct{})}
	a.leasing[key] = f
	a.leaseMu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), leaseTimeout)
		defer cancel()
		l, err := a.leaseMatching(ctx, name, want, force)
		a.leaseMu.Lock()
		if err == nil {
			a.held[key] = l
		}
		delete(a.leasing, key)
		a.leaseMu.Unlock()
		f.lease, f.err = l, err
		close(f.done)
	}()
	return f.wait(ctx)
}

// wait is the lease the fetch brings, or the caller's own context error when the caller goes away first.
func (f *leaseFlight) wait(ctx context.Context) (heldLease, error) {
	select {
	case <-f.done:
		return f.lease, f.err
	case <-ctx.Done():
		return heldLease{}, ctx.Err()
	}
}

// leaseMatching is the home's lease for name, asked once more when it names another url than want. A lease for another
// url is never used: it belongs to a different resource. Both urls are named in the error; no token is.
func (a *Auth) leaseMatching(ctx context.Context, name, want string, force bool) (heldLease, error) {
	l, err := a.leaseFromHome(ctx, name, force)
	if err != nil {
		return heldLease{}, err
	}
	if l.url != want {
		if l, err = a.leaseFromHome(ctx, name, true); err != nil {
			return heldLease{}, err
		}
	}
	if l.url != want {
		return heldLease{}, fmt.Errorf("%s: the home leases a token for %s, but this machine's settings name %s; the token is not used. Make the url of %s the same on both machines, then retry", name, l.url, want, name)
	}
	return l, nil
}

// leaseFromHome asks the home for a lease of name, forced with ?refresh=1 (leaseFromHome in TS).
func (a *Auth) leaseFromHome(ctx context.Context, name string, force bool) (heldLease, error) {
	home := a.opt.Settings().Home
	path := "/api/peer/mcp/" + url.PathEscape(name) + "/lease"
	if force {
		path += "?refresh=1"
	}
	status, data, err := a.homeGet(ctx, name, path)
	if err != nil {
		return heldLease{}, err
	}
	o, _ := data.(*jsjson.Object)
	tok, exp := "", 0.0
	var ok bool
	if o != nil {
		tok = str(o, "access_token")
		exp, ok = num(o, "expires_at")
	}
	if status != http.StatusOK || tok == "" || !ok {
		return heldLease{}, homeError(name, home, status, data)
	}
	// The home is trusted to name the expiry of the bearer it leases. A bearer already past its expiry is refused, not used.
	if exp <= nowMs() {
		return heldLease{}, fmt.Errorf("%s: %s sent a lease that has already expired; the bearer is not used. Refresh %s on %s, then retry", name, home, name, home)
	}
	slog.Info(fmt.Sprintf("mcp lease: %s from %s, expires %s", name, home, time.UnixMilli(int64(exp)).UTC().Format(time.RFC3339Nano)))
	return heldLease{url: str(o, "url"), token: tok, expiresAt: exp}, nil
}

// homeGet is a GET to the settings home's peer routes with the lease token from settings.peers, the only bearer the home's
// lease routes accept. what names the request in each error. Nothing here returns or logs the token.
func (a *Auth) homeGet(ctx context.Context, what, path string) (int, jsjson.Value, error) {
	home := a.opt.Settings().Home
	var peer config.Peer
	found := false
	for _, p := range a.opt.Settings().Peers {
		if p.Name == home {
			peer, found = p, true
		}
	}
	if !found {
		return 0, nil, fmt.Errorf("%s: %s isn't in settings.peers, so its MCP logins can't be leased", what, home)
	}
	if peer.LeaseToken == "" {
		return 0, nil, fmt.Errorf("%s: settings.peers[%s].leaseToken is missing; copy the value of STAM_HOME/mcp-lease-token from %s into it", what, home, home)
	}
	unreachable := fmt.Errorf("%s: the home %s is unreachable, so its MCP logins can't be leased; start %s and retry", what, home, home)
	if a.opt.HomeGet == nil {
		return 0, nil, unreachable
	}
	peer.PeerToken = peer.LeaseToken
	status, raw, err := a.opt.HomeGet(ctx, peer, path)
	if err != nil {
		return 0, nil, unreachable
	}
	// An empty answer is an empty object, as the peer client reads it, so the status still says what the home answered.
	if len(raw) == 0 {
		return status, jsjson.NewObject(), nil
	}
	data, err := jsjson.Parse(raw)
	if err != nil {
		return 0, nil, unreachable
	}
	return status, data, nil
}

// homeError is the error for a home answer that isn't the one asked for. Each status says what to do; the home's message
// names the cause, and no answer carries a token.
func homeError(what, home string, status int, data jsjson.Value) error {
	why := ""
	if o, ok := data.(*jsjson.Object); ok {
		if msg := str(o, "error"); msg != "" {
			why = ": " + msg
		}
	}
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%s: %s refused the lease token (%d%s). Check that settings.peers[%s].leaseToken is the value of STAM_HOME/mcp-lease-token on %s, and that the server has shareWithPeers on %s", what, home, status, why, home, home, home)
	case http.StatusConflict:
		return fmt.Errorf("%s: %s has no lease for it%s. Re-login or refresh on %s, then retry", what, home, why, home)
	}
	return fmt.Errorf("%s: %s answered %d%s", what, home, status, why)
}

// localRows are the rows of the servers that have an auth (and pass only).
func (a *Auth) localRows(ctx context.Context, only func(string) bool) []jsjson.Value {
	var rows []jsjson.Value
	s := a.read()
	for _, sv := range a.servers() {
		typ, has := authType(sv.obj)
		if !has || !only(sv.name) {
			continue
		}
		if typ == "gh" {
			_, err := a.ghToken(ctx)
			rows = append(rows, jsjson.NewObject("name", sv.name, "type", "gh", "logged_in", err == nil, "expires_at", nil))
			continue
		}
		var logged bool
		var expires jsjson.Value
		if e, ok := s.Get(sv.name); ok {
			if eo, isObj := e.(*jsjson.Object); isObj {
				g := grantOf(eo)
				logged = g.accessToken != "" || g.refreshToken != ""
				if g.hasExpiry {
					expires = g.expiresAt
				}
			}
		}
		rows = append(rows, jsjson.NewObject("name", sv.name, "type", "oauth", "logged_in", logged, "expires_at", expires))
	}
	return rows
}

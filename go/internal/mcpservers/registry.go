package mcpservers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"stam/internal/jsjson"
)

// The registry is src/mcp-registry.ts (S-53): the official MCP registry, public and without auth, browsed for the
// human with each server turned into install options. GET <base>?limit=30&search=&cursor= answers {servers: [{server,
// _meta}], metadata: {nextCursor}}; only the latest version of each name is shown, and each page is cached for ten
// minutes.

// DefaultRegistry is the registry read when MCP_REGISTRY_URL doesn't point at another (a test's fake).
const DefaultRegistry = "https://registry.modelcontextprotocol.io/v0.1/servers"

const (
	cacheFor        = 10 * time.Minute
	registryTimeout = 10 * time.Second
	probeTimeout    = 4 * time.Second
	officialMeta    = "io.modelcontextprotocol.registry/official"
	publisherMeta   = "io.modelcontextprotocol.registry/publisher-provided"
	maxAnswer       = 16 << 20
)

// Registry browses the MCP registry with a page cache.
type Registry struct {
	// Base is the registry's url, read on each fetch.
	Base   func() string
	Client *http.Client
	Now    func() time.Time

	mu    sync.Mutex
	cache map[string]cachedPage
}

type cachedPage struct {
	at   time.Time
	page *jsjson.Object
}

// noRedirects is a client that never follows a redirect: the answer is the configured server's own.
func noRedirects() *http.Client {
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// NewRegistry is a Registry reading its base from base, "" for the default.
func NewRegistry(base func() string) *Registry {
	return &Registry{Base: base, Client: noRedirects(), Now: time.Now}
}

// fetchError is the message fetch rejects with: a timeout's DOMException, or "fetch failed" for any other failure.
func fetchError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return errors.New("The operation was aborted due to timeout")
	}
	return errors.New("fetch failed")
}

// Browse is browseRegistry: a page of registry servers, {servers, nextCursor?}, from the cache when it is under ten
// minutes old. An error is the registry's failure, for a 500.
func (r *Registry) Browse(ctx context.Context, search, cursor string) (*jsjson.Object, error) {
	key := search + "\x00" + cursor
	r.mu.Lock()
	hit, ok := r.cache[key]
	r.mu.Unlock()
	if ok && r.Now().Sub(hit.at) < cacheFor {
		return hit.page, nil
	}
	base := r.Base()
	if base == "" {
		base = DefaultRegistry
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, errors.New("Invalid URL")
	}
	q := parseSearchParams(u.RawQuery)
	q.set("limit", "30")
	if search != "" {
		q.set("search", search)
	}
	if cursor != "" {
		q.set("cursor", cursor)
	}
	u.RawQuery = q.encode()
	ctx, cancel := context.WithTimeout(ctx, registryTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fetchError(err)
	}
	req.Header.Set("accept", "application/json")
	res, err := r.Client.Do(req)
	if err != nil {
		return nil, fetchError(err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("the MCP registry answered HTTP %d", res.StatusCode)
	}
	body, _ := io.ReadAll(io.LimitReader(res.Body, maxAnswer))
	json, err := jsjson.Parse(body)
	if err != nil {
		json = jsjson.NewObject()
	}
	list, _ := prop(json, "servers").([]any)
	servers := []any{}
	for _, e := range latestOnly(list) {
		servers = append(servers, toEntry(prop(e, "server")))
	}
	page := jsjson.NewObject("servers", servers)
	if next := prop(prop(json, "metadata"), "nextCursor"); truthy(next) {
		page.Set("nextCursor", str(next))
	}
	now := r.Now()
	r.mu.Lock()
	if r.cache == nil {
		r.cache = map[string]cachedPage{}
	}
	// An expired page is dropped as a new one comes in, so the cache holds only what a browse within ten minutes reads.
	for k, c := range r.cache {
		if now.Sub(c.at) >= cacheFor {
			delete(r.cache, k)
		}
	}
	r.cache[key] = cachedPage{at: now, page: page}
	r.mu.Unlock()
	return page, nil
}

// searchParams is a URLSearchParams: ordered name and value pairs.
type searchParams [][2]string

// parseSearchParams reads a query as URLSearchParams does: & separated, + as a space, and percent escapes decoded
// where they are valid.
func parseSearchParams(raw string) searchParams {
	var out searchParams
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		name, value, _ := strings.Cut(part, "=")
		out = append(out, [2]string{formDecode(name), formDecode(value)})
	}
	return out
}

func formDecode(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	var b []byte
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			b = append(b, unhex(s[i+1])<<4|unhex(s[i+2]))
			i += 2
			continue
		}
		b = append(b, s[i])
	}
	return string(bytes.ToValidUTF8(b, []byte("�")))
}

func isHex(c byte) bool {
	return '0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F'
}

func unhex(c byte) byte {
	switch {
	case c <= '9':
		return c - '0'
	case c <= 'F':
		return c - 'A' + 10
	}
	return c - 'a' + 10
}

// set is URLSearchParams#set: the first pair of that name takes the value and the others go; a new name goes last.
func (p *searchParams) set(name, value string) {
	out := (*p)[:0:0]
	done := false
	for _, kv := range *p {
		if kv[0] != name {
			out = append(out, kv)
		} else if !done {
			out = append(out, [2]string{name, value})
			done = true
		}
	}
	if !done {
		out = append(out, [2]string{name, value})
	}
	*p = out
}

// encode is application/x-www-form-urlencoded as URLSearchParams writes it: letters, digits and *-._ as they are,
// a space as +, every other byte of the UTF-8 percent-encoded.
func (p searchParams) encode() string {
	parts := make([]string, len(p))
	for i, kv := range p {
		parts[i] = formEncode(kv[0]) + "=" + formEncode(kv[1])
	}
	return strings.Join(parts, "&")
}

func formEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case 'a' <= c && c <= 'z', 'A' <= c && c <= 'Z', '0' <= c && c <= '9', strings.IndexByte("*-._", c) >= 0:
			b.WriteByte(c)
		case c == ' ':
			b.WriteByte('+')
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// localeCompare approximates String#localeCompare for version labels: punctuation before digits before letters, and
// letters by their lower case first, a lower-case letter before its upper case only when all else ties.
func localeCompare(a, b string) int {
	class := func(r rune) (int, rune) {
		switch {
		case unicode.IsDigit(r):
			return 1, r
		case unicode.IsLetter(r):
			return 2, unicode.ToLower(r)
		}
		return 0, r
	}
	ra, rb := []rune(a), []rune(b)
	for i := 0; i < len(ra) && i < len(rb); i++ {
		ca, ka := class(ra[i])
		cb, kb := class(rb[i])
		if ca != cb {
			return ca - cb
		}
		if ka != kb {
			if ka < kb {
				return -1
			}
			return 1
		}
	}
	if len(ra) != len(rb) {
		return len(ra) - len(rb)
	}
	for i := range ra {
		if ra[i] != rb[i] {
			if unicode.IsLower(ra[i]) {
				return -1
			}
			return 1
		}
	}
	return 0
}

// CompareVersions compares two versions, numerically where both parts are numbers (1.2.10 > 1.2.9); its sign is the
// order.
func CompareVersions(a, b string) float64 {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var sa, sb jsjson.Value
		if i < len(pa) {
			sa = pa[i]
		}
		if i < len(pb) {
			sb = pb[i]
		}
		na, nb := math.NaN(), math.NaN()
		if sa != nil {
			na = jsjson.ToNumber(sa)
		}
		if sb != nil {
			nb = jsjson.ToNumber(sb)
		}
		if !math.IsNaN(na) && !math.IsInf(na, 0) && !math.IsNaN(nb) && !math.IsInf(nb, 0) {
			if na != nb {
				return na - nb
			}
			continue
		}
		x, _ := sa.(string)
		y, _ := sb.(string)
		if c := localeCompare(x, y); c != 0 {
			return float64(c)
		}
	}
	return 0
}

// latestOnly is one entry per server name, in the order names first appear: the one flagged latest, or else its
// highest version.
func latestOnly(list []any) []any {
	var order []string
	byName := map[string][]any{}
	for _, e := range list {
		n := prop(prop(e, "server"), "name")
		if !truthy(n) {
			continue
		}
		k := jsjson.Stringify(n, "")
		if _, ok := byName[k]; !ok {
			order = append(order, k)
		}
		byName[k] = append(byName[k], e)
	}
	version := func(e jsjson.Value) string {
		v := prop(prop(e, "server"), "version")
		if nullish(v) {
			return ""
		}
		return str(v)
	}
	out := []any{}
	for _, k := range order {
		group := byName[k]
		var latest jsjson.Value
		for _, e := range group {
			if prop(prop(prop(e, "_meta"), officialMeta), "isLatest") == true {
				latest = e
				break
			}
		}
		if latest == nil {
			byVersion := append([]any(nil), group...)
			sort.SliceStable(byVersion, func(i, j int) bool {
				return CompareVersions(version(byVersion[j]), version(byVersion[i])) < 0
			})
			latest = byVersion[0]
		}
		out = append(out, latest)
	}
	return out
}

// fixedArgs is a package's fixed arguments in order: a positional value as it is, a named one as --name=value. One
// with no fixed value is the user's to give, and is skipped.
func fixedArgs(list jsjson.Value) []string {
	var out []string
	items, _ := list.([]any)
	for _, a := range items {
		o, ok := obj(a)
		if !ok {
			continue
		}
		value, has := o.Get("value")
		if !has || value == nil {
			continue
		}
		switch prop(o, "type") {
		case "positional":
			out = append(out, str(value))
		case "named":
			name, has := o.Get("name")
			if !has {
				name = undefined{}
			}
			out = append(out, "--"+str(name)+"="+str(value))
		}
	}
	return out
}

// run is RUN: the command line that runs a package of each registry type, following the registry's own hints.
var run = map[string]func(id, version string) []string{
	"npm":  func(id, v string) []string { return []string{"npx", "-y", id + "@" + v} },
	"pypi": func(id, v string) []string { return []string{"uvx", id + "==" + v} },
	"oci":  func(id, v string) []string { return []string{"docker", "run", "-i", "--rm", id + ":" + v} },
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// field is one input a server needs before it runs, {in, name, description?, required, secret, prefill?}.
func field(in string, e *jsjson.Object, required, prefill jsjson.Value) *jsjson.Object {
	f := jsjson.NewObject("in", in, "name", str(prop(e, "name")))
	if d, ok := e.Get("description"); ok {
		f.Set("description", d)
	}
	f.Set("required", required)
	f.Set("secret", prop(e, "isSecret") == true)
	if prefill != nil {
		f.Set("prefill", prefill)
	}
	return f
}

func packageOption(p jsjson.Value) *jsjson.Object {
	kind := "undefined"
	if t, ok := obj(p); ok {
		if v, has := t.Get("registryType"); has {
			kind = str(v)
		}
	}
	build, ok := run[kind]
	if !ok || !truthy(prop(p, "identifier")) {
		return nil
	}
	version := prop(p, "version")
	if nullish(version) {
		version = ""
	}
	args := build(str(prop(p, "identifier")), str(version))
	for _, a := range append(fixedArgs(prop(p, "packageArguments")), fixedArgs(prop(p, "runtimeArguments"))...) {
		if !contains(args, a) {
			args = append(args, a)
		}
	}
	fields := []any{}
	envs, _ := prop(p, "environmentVariables").([]any)
	for _, x := range envs {
		e, ok := obj(x)
		if !ok || !truthy(prop(e, "name")) {
			continue
		}
		value, isStr := prop(e, "value").(string)
		fixed := isStr && !strings.Contains(value, "{")
		var prefill jsjson.Value
		if fixed {
			prefill = value
		} else if d, ok := prop(e, "default").(string); ok {
			prefill = d
		}
		fields = append(fields, field("env", e, !fixed && prop(e, "isRequired") == true, prefill))
	}
	rest := make([]any, len(args)-1)
	for i, a := range args[1:] {
		rest[i] = a
	}
	return jsjson.NewObject("kind", "local", "label", kind+" · "+strings.Join(args, " "),
		"server", jsjson.NewObject("command", args[0], "args", rest), "fields", fields)
}

func remoteOption(r jsjson.Value) *jsjson.Object {
	u := prop(r, "url")
	if !truthy(u) {
		return nil
	}
	fields := []any{}
	headers, _ := prop(r, "headers").([]any)
	for _, x := range headers {
		h, ok := obj(x)
		if !ok || !truthy(prop(h, "name")) {
			continue
		}
		value, isStr := prop(h, "value").(string)
		fixed := isStr && !strings.Contains(value, "{")
		var prefill jsjson.Value
		if fixed {
			prefill = value
		}
		fields = append(fields, field("headers", h, !fixed && prop(h, "isRequired") != false, prefill))
	}
	o := jsjson.NewObject("kind", "remote", "label", "Remote · "+str(u), "server", jsjson.NewObject("url", str(u)), "fields", fields)
	if prop(r, "type") == "sse" {
		o.Set("note", SSENote)
	}
	return o
}

// OptionsFor is the ways to reach a registry server: its streamable-http remotes (its SSE ones when it has none),
// then its packages.
func OptionsFor(server jsjson.Value) []any {
	remotes, _ := prop(server, "remotes").([]any)
	var chosen []any
	for _, want := range []string{"streamable-http", "sse"} {
		for _, r := range remotes {
			if prop(r, "type") == want {
				chosen = append(chosen, r)
			}
		}
		if len(chosen) > 0 {
			break
		}
	}
	out := []any{}
	for _, r := range chosen {
		if o := remoteOption(r); o != nil {
			out = append(out, o)
		}
	}
	packages, _ := prop(server, "packages").([]any)
	for _, p := range packages {
		if o := packageOption(p); o != nil {
			out = append(out, o)
		}
	}
	return out
}

func toEntry(s jsjson.Value) *jsjson.Object {
	stringOr := func(v jsjson.Value) jsjson.Value {
		if nullish(v) {
			return ""
		}
		return str(v)
	}
	e := jsjson.NewObject("name", stringOr(prop(s, "name")))
	if t, ok := prop(s, "title").(string); ok {
		e.Set("title", t)
	} else if t, ok := prop(prop(prop(s, "_meta"), publisherMeta), "title").(string); ok {
		e.Set("title", t)
	}
	if d, ok := prop(s, "description").(string); ok {
		e.Set("description", d)
	}
	e.Set("version", stringOr(prop(s, "version")))
	if w, ok := prop(s, "websiteUrl").(string); ok {
		e.Set("websiteUrl", w)
	}
	if r, ok := prop(prop(s, "repository"), "url").(string); ok {
		e.Set("repository", r)
	}
	e.Set("options", OptionsFor(s))
	return e
}

var copilotHost = regexp.MustCompile(`(?i)(^|\.)githubcopilot\.com$`)

// RemoteAuth is remoteAuth: the login a remote server likely needs, "gh", "oauth" or "" for none. GitHub's server
// takes the GitHub CLI; any other that answers an unauthenticated initialize with a 401 and a WWW-Authenticate header
// takes OAuth. No credential is sent to find out.
func (r *Registry) RemoteAuth(ctx context.Context, raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	if copilotHost.MatchString(u.Hostname()) {
		return "gh"
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	body := jsjson.Stringify(initialize(1), "")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), strings.NewReader(body))
	if err != nil {
		return ""
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json, text/event-stream")
	res, err := r.Client.Do(req)
	if err != nil {
		return ""
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxAnswer))
	res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized && res.Header.Get("www-authenticate") != "" {
		return "oauth"
	}
	return ""
}

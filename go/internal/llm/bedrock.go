package llm

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
	"stam/internal/secrets"
)

// The Amazon Bedrock adapter (src/llm/bedrock.ts, S-2117): the Converse API (`POST /model/MODEL/converse` on
// bedrock-runtime.REGION.amazonaws.com). It authenticates with a Bedrock API key as a bearer token when the config names
// one, else with AWS credentials from the chain, signed with SigV4: the environment (AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), then the profile's static keys in ~/.aws/credentials or ~/.aws/config, then
// the EC2 instance role (IMDSv2, at 169.254.169.254 only, never through a proxy). A configured profile reads only that
// profile; SSO and assume-role profiles are not read. A JSON-schema request is a forced tool call whose input is the
// answer. Bedrock reports no cost, so Complete prices the call from its tokens. No credential is ever in an error: a
// refusal is fixed text that quotes nothing.

type bedrockConfig struct {
	region, endpoint, profile string
	apiKey                    *keyRef
	temperature               *float64
}

type bedrock struct {
	l   *Layer
	id  string
	c   *bedrockConfig
	url string
}

func (b *bedrock) ID() string      { return b.id }
func (b *bedrock) Unmetered() bool { return false }

// Keyless: the chain may find an instance role only by asking, so HasKey holds without a known key.
func (b *bedrock) Keyless() bool { return b.c.apiKey == nil && b.c.profile == "" }

// APIKey is the API key, or the chain's access key id when it is known without a call.
func (b *bedrock) APIKey() string {
	if b.c.apiKey != nil {
		return b.l.resolveKey(b.c.apiKey)
	}
	if c := b.l.knownCredentials(b.c); c != nil {
		return c.accessKeyID
	}
	return ""
}

func (b *bedrock) Complete(ctx context.Context, req Request) (Result, error) {
	url := b.url + "/model/" + encodeURIComponent(req.Model) + "/converse"
	payload := jsjson.Stringify(b.body(req), "")
	headers := map[string]string{"content-type": "application/json", "accept": "application/json"}
	if b.c.apiKey != nil {
		k := b.l.resolveKey(b.c.apiKey)
		if k == "" {
			return Result{}, errors.New("no API key")
		}
		if !secrets.CheckCredential(k) {
			return Result{}, errors.New("invalid API key")
		}
		headers["authorization"] = "Bearer " + k
	} else {
		c := b.l.credentials(ctx, b.c)
		if c == nil {
			return Result{}, fmt.Errorf("no AWS credentials for provider %s (region %s)", b.id, b.c.region)
		}
		if !secrets.CheckCredential(c.accessKeyID) {
			return Result{}, errors.New("invalid AWS access key id")
		}
		if c.sessionToken != "" && !secrets.CheckCredential(c.sessionToken) {
			return Result{}, errors.New("invalid AWS session token")
		}
		signed, err := sign("POST", url, headers, payload, "bedrock", b.c.region, *c, b.l.now())
		if err != nil {
			return Result{}, failed(err)
		}
		for k, v := range signed {
			headers[k] = v
		}
	}
	data, err := post(ctx, b.l.client, url, headers, payload)
	// A dead or revoked key answers 401 or 403, as does a model whose access isn't granted: fixed text that quotes nothing.
	var h *HTTPError
	if errors.As(err, &h) && (h.Status == 401 || h.Status == 403) {
		return Result{}, &HTTPError{Status: h.Status, Message: fmt.Sprintf("key invalid or access denied (HTTP %d)", h.Status)}
	}
	if err != nil {
		return Result{}, err
	}
	return b.result(data, req), nil
}

// body is the Converse request: the system prompt apart, and consecutive messages of one role joined into one message
// of several text blocks, as Converse wants the turns to alternate.
func (b *bedrock) body(req Request) *jsjson.Object {
	var system []jsjson.Value
	var turns []jsjson.Value
	var last *jsjson.Object
	lastRole := ""
	for _, m := range req.Messages {
		text := jsjson.NewObject("text", m.Content)
		if m.Role == "system" {
			system = append(system, text)
			continue
		}
		if last != nil && lastRole == m.Role {
			c, _ := last.Get("content")
			last.Set("content", append(c.([]jsjson.Value), text))
			continue
		}
		last, lastRole = jsjson.NewObject("role", m.Role, "content", []jsjson.Value{text}), m.Role
		turns = append(turns, last)
	}
	if turns == nil {
		turns = []jsjson.Value{}
	}
	o := jsjson.NewObject("messages", turns)
	if len(system) > 0 {
		o.Set("system", system)
	}
	inference := jsjson.NewObject("maxTokens", req.MaxTokens)
	if req.Temperature != nil {
		inference.Set("temperature", *req.Temperature)
	} else if b.c.temperature != nil {
		inference.Set("temperature", *b.c.temperature)
	}
	o.Set("inferenceConfig", inference)
	if s := req.JSONSchema; s != nil {
		spec := jsjson.NewObject("toolSpec", jsjson.NewObject("name", s.Name, "description", "Give the answer.", "inputSchema", jsjson.NewObject("json", s.Schema)))
		o.Set("toolConfig", jsjson.NewObject("tools", []jsjson.Value{spec}, "toolChoice", jsjson.NewObject("tool", jsjson.NewObject("name", s.Name))))
	}
	return o
}

// result reads a Converse answer. One cut off at the token limit, or stopped by a guardrail or content filter, is no
// answer; a schema's answer is the forced tool call's input, or the text of a model that answered in text.
func (b *bedrock) result(data jsjson.Value, req Request) Result {
	u := get(data, "usage")
	r := Result{Model: req.Model, InputTokens: number(get(u, "inputTokens")), OutputTokens: number(get(u, "outputTokens"))}
	blocks, _ := get(get(get(data, "output"), "message"), "content").([]jsjson.Value)
	stop := get(data, "stopReason")
	if stop != "end_turn" && stop != "stop_sequence" && stop != "tool_use" {
		return r
	}
	if req.JSONSchema != nil {
		for _, bl := range blocks {
			tool := get(bl, "toolUse")
			if get(tool, "name") != req.JSONSchema.Name {
				continue
			}
			in := get(tool, "input")
			if _, obj := in.(*jsjson.Object); obj {
				text := jsjson.Stringify(in, "")
				r.Text = &text
				return r
			}
			if _, list := in.([]jsjson.Value); list {
				text := jsjson.Stringify(in, "")
				r.Text = &text
				return r
			}
			break
		}
	}
	var texts []string
	for _, bl := range blocks {
		if t, ok := get(bl, "text").(string); ok {
			texts = append(texts, t)
		}
	}
	if len(texts) > 0 {
		text := strings.Join(texts, "")
		r.Text = &text
	}
	return r
}

// parseBedrockConfig reads a bedrock entry that config.Settings.ProviderIDs lists (parseBedrockConfig's checks are
// there): its region, its endpoint as an origin, its key, profile and temperature.
func parseBedrockConfig(o map[string]any, c *providerConfig) *bedrockConfig {
	str := func(k string) string {
		s, _ := o[k].(string)
		return jsjson.Trim(s)
	}
	b := &bedrockConfig{region: str("region"), profile: str("profile"), apiKey: c.apiKey, temperature: c.temperature}
	if e := str("endpoint"); e != "" {
		b.endpoint, _ = config.EndpointOrigin(e)
	}
	return b
}

// base is bedrockBase: the endpoint, else the region's runtime.
func (c *bedrockConfig) base() string {
	if c.endpoint != "" {
		return strings.TrimRight(c.endpoint, "/")
	}
	return "https://bedrock-runtime." + c.region + ".amazonaws.com"
}

// The credential chain.

func (l *Layer) now() time.Time {
	if l.o.Now != nil {
		return l.o.Now()
	}
	return time.Now()
}

func (l *Layer) env(name string) string { return jsjson.Trim(l.o.Getenv(name)) }

// resolveKey is src/llm/openai.ts resolveKey: a set variable over the stored secret.
func (l *Layer) resolveKey(r *keyRef) string { return resolveKey(l.o.Home, l.o.Getenv, r) }

func resolveKey(home string, getenv func(string) string, r *keyRef) string {
	if r.env != "" {
		if v := jsjson.Trim(getenv(r.env)); v != "" {
			return v
		}
	}
	if r.secret != "" {
		return secrets.Get(home, r.secret, getenv)
	}
	return ""
}

func (l *Layer) fromEnv() *awsCredentials {
	id, secret := l.env("AWS_ACCESS_KEY_ID"), l.env("AWS_SECRET_ACCESS_KEY")
	if id == "" || secret == "" {
		return nil
	}
	return &awsCredentials{id, secret, l.env("AWS_SESSION_TOKEN")}
}

var (
	iniHead = regexp.MustCompile(`^\[` + jsSpaceClass + `*(.+?)` + jsSpaceClass + `*\]$`)
	iniKV   = regexp.MustCompile(`^([^=]+?)` + jsSpaceClass + `*=` + jsSpaceClass + `*((?s:.)*)$`)
)

// jsSpaceClass is JavaScript's \s as one character class.
const jsSpaceClass = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// iniSection is one INI section's keys, lowercased: `[name]` in the credentials file, `[profile name]` (or `[default]`)
// in config. Nil when the file can't be read or has no such section.
func iniSection(file string, names []string) map[string]string {
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	text, err := io.ReadAll(io.LimitReader(f, 1<<20))
	if err != nil {
		return nil
	}
	out := map[string]string{}
	found, current, inSection := false, "", false
	sc := bufio.NewScanner(strings.NewReader(strings.ReplaceAll(string(text), "\r\n", "\n")))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		s := jsjson.Trim(sc.Text())
		if s == "" || strings.HasPrefix(s, "#") || strings.HasPrefix(s, ";") {
			continue
		}
		if m := iniHead.FindStringSubmatch(s); m != nil {
			current = spaces.ReplaceAllString(m[1], " ")
			inSection = false
			for _, n := range names {
				if n == current {
					found, inSection = true, true
				}
			}
			continue
		}
		if m := iniKV.FindStringSubmatch(s); m != nil && current != "" && inSection {
			out[strings.ToLower(m[1])] = jsjson.Trim(m[2])
		}
	}
	if !found {
		return nil
	}
	return out
}

func (l *Layer) fromProfile(name string) *awsCredentials {
	home := l.o.Getenv("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	credsFile := l.env("AWS_SHARED_CREDENTIALS_FILE")
	if credsFile == "" {
		credsFile = filepath.Join(home, ".aws", "credentials")
	}
	configFile := l.env("AWS_CONFIG_FILE")
	if configFile == "" {
		configFile = filepath.Join(home, ".aws", "config")
	}
	configNames := []string{"profile " + name}
	if name == "default" {
		configNames = []string{"default", "profile default"}
	}
	for _, s := range []map[string]string{iniSection(credsFile, []string{name}), iniSection(configFile, configNames)} {
		if s["aws_access_key_id"] != "" && s["aws_secret_access_key"] != "" {
			return &awsCredentials{s["aws_access_key_id"], s["aws_secret_access_key"], s["aws_session_token"]}
		}
	}
	return nil
}

// roleCache is the instance role's credentials, kept until five minutes before they expire. A lookup that finds none
// (not on EC2) is not retried for five minutes.
type roleCache struct {
	mu    sync.Mutex
	creds *awsCredentials
	until time.Time
	set   bool
}

const roleMiss = 5 * time.Minute

func (l *Layer) cachedRole() *awsCredentials {
	l.role.mu.Lock()
	defer l.role.mu.Unlock()
	if l.role.set && l.now().Before(l.role.until) {
		return l.role.creds
	}
	return nil
}

func (l *Layer) fromInstanceRole(ctx context.Context) *awsCredentials {
	if strings.ToLower(l.env("AWS_EC2_METADATA_DISABLED")) == "true" {
		return nil
	}
	l.role.mu.Lock()
	defer l.role.mu.Unlock()
	if l.role.set && l.now().Before(l.role.until) {
		return l.role.creds
	}
	creds, until := l.askRole(ctx)
	if creds == nil {
		until = l.now().Add(roleMiss)
	}
	l.role.creds, l.role.until, l.role.set = creds, until, true
	return creds
}

// metadataBase is the EC2 metadata service. TS honours AWS_EC2_METADATA_SERVICE_ENDPOINT; Go never reads it, so the
// role's credentials come only from the link-local service.
const metadataBase = "http://169.254.169.254"

// askRole is IMDSv2: a token, the role's name, then its credentials, each call bounded by its own second. The lookup is
// shared and its answer cached, a miss included, so it runs apart from the caller's context, as TS's does: a canceled
// caller must not cache a miss for everyone.
func (l *Layer) askRole(ctx context.Context) (*awsCredentials, time.Time) {
	ctx = context.WithoutCancel(ctx)
	call := func(method, path string, header map[string]string) (string, bool) {
		ctx, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, method, metadataBase+path, nil)
		if err != nil {
			return "", false
		}
		for k, v := range header {
			req.Header.Set(k, v)
		}
		res, err := l.metadata.Do(req)
		if err != nil {
			return "", false
		}
		defer res.Body.Close()
		b, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		return string(b), err == nil && res.StatusCode >= 200 && res.StatusCode <= 299
	}
	token, ok := call("PUT", "/latest/api/token", map[string]string{"x-aws-ec2-metadata-token-ttl-seconds": "21600"})
	if !ok {
		return nil, time.Time{}
	}
	h := map[string]string{"x-aws-ec2-metadata-token": token}
	list, ok := call("GET", "/latest/meta-data/iam/security-credentials/", h)
	name := ""
	if ok {
		name, _, _ = strings.Cut(list, "\n")
		name = jsjson.Trim(name)
	}
	if name == "" {
		return nil, time.Time{}
	}
	text, ok := call("GET", "/latest/meta-data/iam/security-credentials/"+encodeURIComponent(name), h)
	if !ok {
		return nil, time.Time{}
	}
	j, err := jsjson.Parse([]byte(text))
	if err != nil {
		return nil, time.Time{}
	}
	id, ok1 := get(j, "AccessKeyId").(string)
	secret, ok2 := get(j, "SecretAccessKey").(string)
	if !ok1 || !ok2 {
		return nil, time.Time{}
	}
	token2, _ := get(j, "Token").(string)
	until := l.now().Add(roleMiss)
	if exp, ok := get(j, "Expiration").(string); ok {
		if t, err := time.Parse(time.RFC3339, exp); err == nil {
			until = t.Add(-5 * time.Minute)
		}
	}
	return &awsCredentials{id, secret, token2}, until
}

// knownCredentials are the chain's credentials known without a network call: the environment, a profile, a cached role.
func (l *Layer) knownCredentials(c *bedrockConfig) *awsCredentials {
	if c.profile != "" {
		return l.fromProfile(c.profile)
	}
	if e := l.fromEnv(); e != nil {
		return e
	}
	profile := l.env("AWS_PROFILE")
	if profile == "" {
		profile = "default"
	}
	if p := l.fromProfile(profile); p != nil {
		return p
	}
	return l.cachedRole()
}

func (l *Layer) credentials(ctx context.Context, c *bedrockConfig) *awsCredentials {
	if k := l.knownCredentials(c); k != nil || c.profile != "" {
		return k
	}
	return l.fromInstanceRole(ctx)
}

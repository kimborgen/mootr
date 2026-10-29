package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"stam/internal/jsjson"
)

// stubAWS is each fixture access key id's secret, so the stub can check a signature.
var stubAWS = map[string]string{"AKIDENV": "env-secret-10", "AKIDPROF": "prof-secret-12", "AKIDCFG": "cfg-secret-13", "AKIDROLE": "role-secret-8"}

// metadata is a transport for Go's metadata calls: it records the host each was made to, then serves it from the stub,
// under prefix. TS reaches the stub through AWS_EC2_METADATA_SERVICE_ENDPOINT, which Go doesn't read.
func (s *stub) metadata(prefix string) http.RoundTripper {
	return roundTrip(func(r *http.Request) (*http.Response, error) {
		s.mu.Lock()
		s.hosts = append(s.hosts, r.URL.Host)
		s.mu.Unlock()
		r = r.Clone(r.Context())
		u, _ := url.Parse(s.srv.URL)
		r.URL.Scheme, r.URL.Host, r.URL.Path, r.Host = u.Scheme, u.Host, prefix+r.URL.Path, ""
		return (&http.Transport{}).RoundTrip(r)
	})
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// metaHosts are the hosts of Go's metadata calls since the last call.
func (s *stub) metaHosts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.hosts
	s.hosts = nil
	return out
}

// imds is IMDSv2: a token for a PUT with a TTL, then the role list and the role's credentials for that token.
func (s *stub) imds(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/none/") {
		s.record("IMDS none " + r.URL.Path)
		w.WriteHeader(404)
		return
	}
	tok := r.Header.Get("x-aws-ec2-metadata-token")
	s.record(fmt.Sprintf("IMDS %s %s ttl=%q token=%v", r.Method, r.URL.Path, r.Header.Get("x-aws-ec2-metadata-token-ttl-seconds"), tok == "imds-token-7"))
	switch {
	case r.Method == "PUT" && r.URL.Path == "/latest/api/token" && r.Header.Get("x-aws-ec2-metadata-token-ttl-seconds") != "":
		_, _ = io.WriteString(w, "imds-token-7")
	case tok != "imds-token-7":
		w.WriteHeader(401)
	case r.URL.Path == "/latest/meta-data/iam/security-credentials/":
		_, _ = io.WriteString(w, "stub-role\nother-role")
	case r.URL.Path == "/latest/meta-data/iam/security-credentials/stub-role":
		_, _ = io.WriteString(w, `{"Code":"Success","AccessKeyId":"AKIDROLE","SecretAccessKey":"role-secret-8","Token":"role-token-9","Expiration":"2099-01-01T00:00:00Z"}`)
	default:
		w.WriteHeader(404)
	}
}

// converse records a Converse call, its signature checked rather than recorded (it holds the time), and answers by the
// case, the first system block's text.
func (s *stub) converse(w http.ResponseWriter, r *http.Request, body []byte) {
	auth := r.Header.Get("authorization")
	if strings.HasPrefix(auth, "AWS4-HMAC-SHA256 ") {
		cred, _, _ := strings.Cut(strings.TrimPrefix(auth, "AWS4-HMAC-SHA256 Credential="), ",")
		parts := strings.Split(cred, "/")
		verdict := "bad"
		if len(parts) == 5 {
			now, _ := time.Parse("20060102T150405Z", r.Header.Get("x-amz-date"))
			c := awsCredentials{parts[0], stubAWS[parts[0]], r.Header.Get("x-amz-security-token")}
			h := map[string]string{"content-type": r.Header.Get("content-type"), "accept": r.Header.Get("accept")}
			if want, err := sign(r.Method, "http://"+r.Host+r.URL.RequestURI(), h, string(body), parts[3], parts[2], c, now); err == nil && want["authorization"] == auth && strings.HasPrefix(r.Header.Get("x-amz-date"), parts[1]) {
				verdict = "ok"
			}
		}
		auth = "sigv4 " + verdict
		if len(parts) == 5 {
			auth = fmt.Sprintf("sigv4 %s/%s/%s %s", parts[0], parts[2], parts[3], verdict)
		}
	}
	s.record(fmt.Sprintf("%s %s auth=%q token=%q type=%q accept=%q %s", r.Method, r.URL.RequestURI(), auth, r.Header.Get("x-amz-security-token"), r.Header.Get("content-type"), r.Header.Get("accept"), body))
	var req struct{ System []struct{ Text string } }
	_ = json.Unmarshal(body, &req)
	name := ""
	if len(req.System) > 0 {
		name = req.System[0].Text
	}
	answer := func(status int, text string) {
		w.WriteHeader(status)
		_, _ = io.WriteString(w, text)
	}
	switch name {
	case "br-tool":
		answer(200, `{"output":{"message":{"role":"assistant","content":[{"text":"thinking"},{"toolUse":{"toolUseId":"t1","name":"other","input":{"no":1}}},{"toolUse":{"toolUseId":"t2","name":"tool_summary","input":{"tool":"x","n":[1,2]}}}]}},"stopReason":"tool_use","usage":{"inputTokens":40,"outputTokens":9}}`)
	case "br-toolstr":
		answer(200, `{"output":{"message":{"content":[{"text":"in "},{"toolUse":{"name":"tool_summary","input":"str"}},{"text":"text"}]}},"stopReason":"tool_use","usage":{}}`)
	case "br-textjson":
		answer(200, `{"output":{"message":{"content":[{"text":"{\"tool\":\"y\"}"}]}},"stopReason":"end_turn","usage":{"inputTokens":"7","outputTokens":2}}`)
	case "br-cut":
		answer(200, `{"output":{"message":{"content":[{"text":"partial"}]}},"stopReason":"max_tokens","usage":{"inputTokens":5,"outputTokens":80}}`)
	case "br-guard":
		answer(200, `{"output":{"message":{"content":[{"text":"no"}]}},"stopReason":"guardrail_intervened","usage":{"inputTokens":5,"outputTokens":1}}`)
	case "br-403":
		answer(403, `{"message":"sk-leak-6 is not authorized"}`)
	case "br-401":
		answer(401, `sk-leak-6`)
	case "br-429":
		w.Header().Set("retry-after", "3")
		answer(429, `{"message":"slow down"}`)
	case "br-500":
		answer(500, ``)
	default:
		answer(200, `{"output":{"message":{"role":"assistant","content":[{"text":"he"},{"text":"llo"}]}},"stopReason":"end_turn","usage":{"inputTokens":12,"outputTokens":"3"}}`)
	}
}

// TestBedrockMatchesTS: src/llm/bedrock.ts and its credential chain, asked the same cases by TS and Go against the
// loopback stub, which checks each SigV4 signature and stands in for the EC2 metadata service. The requests (URL,
// bearer key or a verified signature's key id and scope, session token, body) and the results or errors match:
//   - a Bedrock API key, with the provider's temperature, and Converse's merged turns;
//   - environment keys with a session token, a named profile in the credentials file, one in the config file, a
//     profile whose session token is malformed, and a missing profile;
//   - answers: text, a forced tool call (and one whose input is not an object), text for a schema, a cut and a
//     guardrail, 401, 403, 429 with Retry-After, and 500;
//   - an endpoint that is not an origin, and an API key that isn't set.
//
// A second run has no keys in the environment or the default profile, so the instance role answers, fetched once; a
// third turns the metadata service off. No result or event names a key, a secret or the answer of a refusal.
func TestBedrockMatchesTS(t *testing.T) {
	s := newStub(t)
	home := t.TempDir()
	creds := filepath.Join(home, "aws-credentials")
	cfg := filepath.Join(home, "aws-config")
	must(t, os.WriteFile(creds, []byte("# fixture\n[ work ]\naws_access_key_id = AKIDPROF\r\nAWS_Secret_Access_Key=prof-secret-12\n[badtok]\naws_access_key_id=AKIDPROF\naws_secret_access_key=prof-secret-12\naws_session_token = bad token\n[cfg]\naws_access_key_id=AKIDWRONG\n"), 0o600))
	must(t, os.WriteFile(cfg, []byte("[default]\nregion=us-east-1\n; comment\n[profile   cfg]\naws_access_key_id=AKIDCFG\naws_secret_access_key=cfg-secret-13\naws_session_token=cfg-token-14\n"), 0o600))
	u := s.srv.URL
	settings := `{"providers":{
		"brk":{"kind":"bedrock","region":"us-east-1","endpoint":"` + u + `/","apiKey":{"env":"BR_KEY"},"temperature":0.2},
		"brenv":{"kind":"bedrock","region":"eu-west-1","endpoint":"` + u + `"},
		"brprof":{"kind":"bedrock","region":"us-east-1","endpoint":"` + u + `","profile":"work"},
		"brcfg":{"kind":"bedrock","region":"ap-south-1","endpoint":"` + u + `","profile":" cfg "},
		"brtok":{"kind":"bedrock","region":"us-east-1","endpoint":"` + u + `","profile":"badtok"},
		"brnone":{"kind":"bedrock","region":"us-east-1","endpoint":"` + u + `","profile":"missing"},
		"brnokey":{"kind":"bedrock","region":"us-east-1","endpoint":"` + u + `","apiKey":{"env":"MISSING_KEY"}},
		"brbad":{"kind":"bedrock","region":"us-east-1","endpoint":"http://example.com"}}}`
	registry := `{"prices":{"brenv:anthropic.claude-3:0":{"input":3,"output":15}}}`
	base := map[string]string{"HOME": home, "AWS_SHARED_CREDENTIALS_FILE": creds, "AWS_CONFIG_FILE": cfg, "AWS_EC2_METADATA_SERVICE_ENDPOINT": u, "BR_KEY": " br-secret-5 "}
	with := func(extra map[string]string) map[string]string {
		env := map[string]string{}
		for _, m := range []map[string]string{base, extra} {
			for k, v := range m {
				env[k] = v
			}
		}
		return env
	}
	more := []Message{{"user", "more"}, {"assistant", "a"}, {"assistant", "b"}, {"system", "also"}}
	refs := []string{"brk:a", "brenv:a", "brprof:a", "brcfg:a", "brtok:a", "brnone:a", "brnokey:a", "brbad:a"}
	leaks := []string{"secret", "leak", "token-", "AKID", "bad token"}
	check := func(r parityRun) {
		t.Helper()
		got := r.ev.text()
		for _, res := range r.results {
			got += jsjson.Stringify(res, "")
		}
		for _, l := range leaks {
			if strings.Contains(got, l) {
				t.Errorf("a result or event names %q: %s", l, got)
			}
		}
		for _, line := range append(r.tsSeen, r.goSeen...) {
			if strings.Contains(line, ` bad"`) {
				t.Errorf("a bad signature: %s", line)
			}
		}
	}

	r := parity{settings, registry, with(map[string]string{"AWS_ACCESS_KEY_ID": "AKIDENV", "AWS_SECRET_ACCESS_KEY": " env-secret-10 ", "AWS_SESSION_TOKEN": "env-token-11"}), []tcase{
		{"br-ok", "brk:anthropic.claude-3:0", nil, false, more},
		{"br-tool", "brenv:anthropic.claude-3:0", zero(), true, nil},
		{"br-toolstr", "brenv:us.meta(x)!*'~", nil, true, nil},
		{"br-textjson", "brprof:m", nil, true, nil},
		{"br-cut", "brcfg:m", nil, false, nil},
		{"br-guard", "brenv:m", nil, false, nil},
		{"br-401", "brk:m", nil, false, nil},
		{"br-403", "brenv:m", nil, false, nil},
		{"br-429", "brenv:m", nil, false, nil},
		{"br-500", "brprof:m", nil, false, nil},
		{"br-ok", "brtok:m", nil, false, nil},
		{"br-ok", "brnone:m", nil, false, nil},
		{"br-ok", "brnokey:m", nil, false, nil},
		{"br-ok", "brbad:m", nil, false, nil},
	}, refs}.run(t, home, s)
	check(r)
	if n := strings.Count(strings.Join(r.goSeen, "\n"), ` ok"`); n != 8 {
		t.Errorf("%d signed calls verified, want 8:\n%s", n, strings.Join(r.goSeen, "\n"))
	}

	r = parity{settings, registry, with(nil), []tcase{
		{"br-ok", "brenv:m", nil, false, nil},
		{"br-tool", "brenv:m", nil, true, nil},
		{"br-ok", "brprof:m", nil, false, nil},
		{"br-ok", "brnone:m", nil, false, nil},
	}, refs}.run(t, home, s)
	check(r)
	if hosts := s.metaHosts(); len(hosts) != 3 || slices.ContainsFunc(hosts, func(h string) bool { return h != "169.254.169.254" }) {
		t.Errorf("Go's metadata calls went to %v, not 169.254.169.254 only", hosts)
	}
	if n := strings.Count(strings.Join(r.goSeen, "\n"), "IMDS PUT"); n != 1 {
		t.Errorf("the role was asked %d times, want once:\n%s", n, strings.Join(r.goSeen, "\n"))
	}

	r = parity{settings, registry, with(map[string]string{"AWS_EC2_METADATA_DISABLED": "TRUE"}), []tcase{
		{"br-ok", "brenv:m", nil, false, nil},
	}, refs}.run(t, home, s)
	check(r)
	if len(r.goSeen) != 0 {
		t.Errorf("the metadata service was asked while off: %v", r.goSeen)
	}
}

// TestBedrockRoleCache: the instance role's credentials are kept until five minutes before they expire, and a lookup
// that finds none is not retried for five minutes (src/llm/bedrock.ts fromInstanceRole), on the layer's clock.
func TestBedrockRoleCache(t *testing.T) {
	s := newStub(t)
	now := time.Date(2098, 12, 31, 23, 0, 0, 0, time.UTC)
	env := map[string]string{"HOME": t.TempDir()}
	l := New(Options{Getenv: func(k string) string { return env[k] }, Now: func() time.Time { return now }, Metadata: s.metadata("")})
	cfg := &bedrockConfig{region: "us-east-1"}
	ask := func() string {
		if c := l.credentials(context.Background(), cfg); c != nil {
			return c.accessKeyID
		}
		return ""
	}
	puts := func() int { return strings.Count(strings.Join(s.take(), "\n"), "IMDS PUT") }
	if ask() != "AKIDROLE" || puts() != 1 {
		t.Fatal("the role was not fetched")
	}
	now = now.Add(54 * time.Minute)
	if ask() != "AKIDROLE" || puts() != 0 {
		t.Error("the role was fetched again before it was due")
	}
	now = now.Add(time.Minute)
	if ask() != "AKIDROLE" || puts() != 1 {
		t.Error("the role was not fetched again five minutes before it expires")
	}
	l = New(Options{Getenv: func(k string) string { return env[k] }, Now: func() time.Time { return now }, Metadata: s.metadata("/none")})
	if ask() != "" || len(s.take()) != 1 {
		t.Fatal("a miss")
	}
	now = now.Add(4 * time.Minute)
	if ask() != "" || len(s.take()) != 0 {
		t.Error("a miss was retried within five minutes")
	}
	now = now.Add(time.Minute)
	if ask(); len(s.take()) != 1 {
		t.Error("a miss was not retried after five minutes")
	}
}

// TestRoleLookupCanceled: the instance role's lookup is shared and its answer cached, a miss too, so a caller canceled
// before or during it must not cache a miss for every later call; src/llm/bedrock.ts's lookup has only its own timeouts.
func TestRoleLookupCanceled(t *testing.T) {
	s := newStub(t)
	l := New(Options{Getenv: func(k string) string { return map[string]string{"HOME": t.TempDir()}[k] }, Metadata: s.metadata("")})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if c := l.fromInstanceRole(ctx); c == nil || c.accessKeyID != "AKIDROLE" {
		t.Errorf("a canceled caller's lookup found no role")
	}
	if c := l.credentials(context.Background(), &bedrockConfig{region: "us-east-1"}); c == nil || c.accessKeyID != "AKIDROLE" {
		t.Errorf("the next call found no role")
	}
}

// TestMetadataAddress: Go asks the metadata service at 169.254.169.254 only. AWS_EC2_METADATA_SERVICE_ENDPOINT, which
// src/llm/bedrock.ts honours, is ignored, and the default transport never uses a proxy, even with a proxy in the
// environment and on the layer's own client.
func TestMetadataAddress(t *testing.T) {
	s := newStub(t)
	env := map[string]string{"HOME": t.TempDir(), "AWS_EC2_METADATA_SERVICE_ENDPOINT": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9", "http_proxy": "http://127.0.0.1:9"}
	l := New(Options{Getenv: func(k string) string { return env[k] }, Metadata: s.metadata("")})
	if c := l.fromInstanceRole(context.Background()); c == nil || c.accessKeyID != "AKIDROLE" {
		t.Fatal("no role")
	}
	if hosts := s.metaHosts(); len(hosts) != 3 || slices.ContainsFunc(hosts, func(h string) bool { return h != "169.254.169.254" }) {
		t.Errorf("the metadata calls went to %v", hosts)
	}
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:9")
	proxied := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
	tr, ok := New(Options{HTTP: proxied}).metadata.Transport.(*http.Transport)
	if !ok || tr.Proxy != nil {
		t.Errorf("the metadata transport can use a proxy: %T", New(Options{}).metadata.Transport)
	}
}

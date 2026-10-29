package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"stam/internal/config"
	"stam/internal/jsjson"
)

const orKey = "sk-or-secret-1"

// stub is a loopback provider: it records each request and answers by the case, the first message's text. Under
// /latest/ it is the EC2 metadata service, and a Converse call is answered by bedrockStub.
type stub struct {
	mu   sync.Mutex
	seen []string
	srv  *httptest.Server
	// hosts are the hosts Go's metadata calls were made to, before metadata sent them to the stub.
	hosts []string
}

func (s *stub) record(line string) {
	s.mu.Lock()
	s.seen = append(s.seen, line)
	s.mu.Unlock()
}

func newStub(t *testing.T) *stub {
	s := &stub{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(r.URL.Path, "/latest/") {
			s.imds(w, r)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/converse") {
			s.converse(w, r, body)
			return
		}
		s.mu.Lock()
		s.seen = append(s.seen, fmt.Sprintf("%s %s auth=%q api-key=%q type=%q %s", r.Method, r.URL.RequestURI(), r.Header.Get("authorization"), r.Header.Get("api-key"), r.Header.Get("content-type"), body))
		s.mu.Unlock()
		var req struct {
			Messages []struct{ Content string }
		}
		_ = json.Unmarshal(body, &req)
		name := ""
		if len(req.Messages) > 0 {
			name = req.Messages[0].Content
		}
		answer := func(status int, text string) {
			w.WriteHeader(status)
			_, _ = io.WriteString(w, text)
		}
		switch name {
		case "or-ok":
			answer(200, `{"model":"x/y-2","choices":[{"message":{"content":"{\"a\":1}"}}],"usage":{"prompt_tokens":10,"completion_tokens":"5","cost":"0.0012"}}`)
		case "or-bare":
			answer(200, `{"choices":[{"message":{"content":7}}]}`)
		case "or-429":
			w.Header().Set("retry-after", "7")
			answer(429, `{"error":"slow down"}`)
		case "or-500":
			answer(500, ``)
		case "or-notjson":
			answer(200, `<html>no</html>`)
		case "cut":
			answer(200, `{"model":"m","choices":[{"message":{"content":"partial"},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}`)
		case "refusal":
			answer(200, `{"choices":[{"message":{"content":"no","refusal":"I can't"}}],"usage":{"prompt_tokens":3,"completion_tokens":4}}`)
		case "redirect":
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
		default:
			answer(200, `{"model":"served","choices":[{"message":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":200}}`)
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *stub) take() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.seen
	s.seen = nil
	return out
}

// tcase is one request, as Go asks it and as the TS reference script gets it.
type tcase struct {
	name, model string
	temp        *float64
	schema      bool
	more        []Message
}

func (c tcase) request() Request {
	r := Request{Model: c.model, Messages: append([]Message{{"system", c.name}, {"user", "Tool: Read\nInput: {\"file\":\"a\"}"}}, c.more...), MaxTokens: 80, Temperature: c.temp}
	if c.schema {
		r.JSONSchema = &JSONSchema{Name: "tool_summary", Schema: jsjson.NewObject("type", "object", "properties", jsjson.NewObject("tool", jsjson.NewObject("type", "string")), "required", []jsjson.Value{"tool"}, "additionalProperties", false)}
	}
	return r
}

func (c tcase) ts() *jsjson.Object {
	r := c.request()
	o := jsjson.NewObject("model", r.Model, "messages", r.messages(), "maxTokens", r.MaxTokens)
	if c.temp != nil {
		o.Set("temperature", *c.temp)
	}
	if r.JSONSchema != nil {
		o.Set("jsonSchema", jsjson.NewObject("name", r.JSONSchema.Name, "schema", r.JSONSchema.Schema))
	}
	return o
}

func zero() *float64 { z := 0.0; return &z }

// TestCompleteMatchesTS: src/llm/index.ts complete, parseModelRef and hasKey, and the OpenRouter, OpenAI-compatible and
// Azure adapters, asked the same cases by TS and Go against one loopback stub. The requests each side sent (URL,
// headers, body) and the results or errors match. The one difference: an answer that is not JSON is TS's SyntaxError,
// which quotes the answer, and Go's fixed text.
func TestCompleteMatchesTS(t *testing.T) {
	s := newStub(t)
	home := t.TempDir()
	// A closed port (port 1 is one fetch refuses to dial).
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	closed := "http://" + ln.Addr().String()
	ln.Close()
	settings := `{"providers":{
		"oai":{"kind":"openai-compatible","baseUrl":"` + s.srv.URL + `/v1/","apiKey":{"env":"OAI_KEY"},"temperature":0.3},
		"local":{"kind":"openai-compatible","baseUrl":"` + s.srv.URL + `/local","maxTokensParam":"max_completion_tokens"},
		"az":{"kind":"azure","endpoint":"` + s.srv.URL + `/az","apiVersion":"2024-10-21","deployment":"dep 1/x","apiKey":{"secret":"azkey"}},
		"az1":{"kind":"azure","endpoint":"` + s.srv.URL + `/az1/openai/v1","apiVersion":"x","apiKey":{"env":"AZ1_KEY","secret":"none"}},
		"nokey":{"kind":"openai-compatible","baseUrl":"` + s.srv.URL + `/nk","apiKey":{"env":"MISSING_KEY"}},
		"badkey":{"kind":"openai-compatible","baseUrl":"` + s.srv.URL + `/bk","apiKey":{"env":"BAD_KEY"}},
		"down":{"kind":"openai-compatible","baseUrl":"` + closed + `","apiKey":{"env":"OAI_KEY"}},
		"openrouter":{"kind":"openai-compatible","baseUrl":"http://127.0.0.1:1"},
		"broken":{"kind":"azure"}}}`
	registry := `{"prices":{"oai:priced":{"input":1,"output":2},"bare":{"input":3,"output":4},"oai:half":{"input":1}}}`
	must(t, os.WriteFile(filepath.Join(home, "secrets.json"), []byte(`{"secrets":{"azkey":{"value":"az-secret-2"}}}`), 0o600))
	env := map[string]string{"OPENROUTER_API_KEY": orKey, "STAM_OPENROUTER_URL": s.srv.URL + "/or", "OAI_KEY": " oai-secret-3 ", "AZ1_KEY": "az1-secret-4", "BAD_KEY": "bad secret"}
	cases := []tcase{
		{"or-ok", "x/y", zero(), true, nil},
		{"or-bare", "openrouter:a/b", nil, false, nil},
		{"or-429", "x/y", nil, false, nil},
		{"or-500", "x/y", nil, false, nil},
		{"or-notjson", "x/y", nil, false, nil},
		{"oai-fallback", "oai:gpt-x", nil, true, nil},
		{"oai-priced", "oai:priced", zero(), false, nil},
		{"oai-bare", "oai:bare", nil, false, nil},
		{"oai-half", "oai:half", nil, false, nil},
		{"cut", "oai:m", nil, false, nil},
		{"refusal", "oai:m", nil, false, nil},
		{"local-free", "local:llama", nil, false, nil},
		{"local-bare", "local:bare", nil, false, nil},
		{"az-dated", "az:whatever", nil, false, nil},
		{"az1-v1", "az1:gpt-4o", zero(), true, nil},
		{"nokey", "nokey:m", nil, false, nil},
		{"badkey", "badkey:m", nil, false, nil},
		{"down", "down:m", nil, false, nil},
		{"broken", "broken:x", nil, false, nil},
		{"redirect", "oai:m", nil, false, nil},
	}
	refs := []string{"oai:a", "openrouter:b", "broken:x", ":x", "x", "nokey:", "local:a", "nokey:a", "az:a", "badkey:a", "x/y:free"}

	r := parity{settings, registry, env, cases, refs}.run(t, home, s)
	if len(r.goSeen) < 15 {
		t.Errorf("only %d requests reached the stub", len(r.goSeen))
	}
	// An unpriced model is logged once, with no key in it.
	if got := r.ev.text(); strings.Count(got, "llm:unpriced") != 5 || strings.Contains(got, "secret") {
		t.Errorf("the unpriced events: %s", got)
	}
	for _, res := range r.results {
		if strings.Contains(jsjson.Stringify(res, ""), "secret") {
			t.Errorf("a result names a key: %s", jsjson.Stringify(res, ""))
		}
	}
}

// parity is one run of the reference script and of Go on the same settings, registry, environment and cases.
type parity struct {
	settings, registry string
	env                map[string]string
	cases              []tcase
	refs               []string
}

type parityRun struct {
	tsSeen, goSeen []string
	ev             *events
	results        []jsjson.Value
}

// run writes home's settings.json and registry.json, asks the cases in TS and then in Go, and fails the test when the
// results (parseModelRef and hasKey of each ref, then each case's result or error) or the requests the stub saw differ.
// The one difference allowed: an answer that is not JSON is TS's SyntaxError, which quotes the answer, and Go's fixed
// text.
func (p parity) run(t *testing.T, home string, s *stub) parityRun {
	t.Helper()
	must(t, os.WriteFile(filepath.Join(home, "settings.json"), []byte(p.settings), 0o600))
	must(t, os.WriteFile(filepath.Join(home, "registry.json"), []byte(p.registry), 0o600))
	reqs := make([]jsjson.Value, len(p.cases))
	for i, c := range p.cases {
		reqs[i] = c.ts()
	}
	envObj := jsjson.NewObject()
	for k, v := range p.env {
		envObj.Set(k, v)
	}
	refVals := make([]jsjson.Value, len(p.refs))
	for i, r := range p.refs {
		refVals[i] = r
	}
	cmd := exec.Command("node", "--no-warnings", "testdata/llmref.mjs")
	cmd.Stdin = strings.NewReader(jsjson.Stringify(jsjson.NewObject("home", home, "env", envObj, "refs", refVals, "requests", reqs), ""))
	cmd.Stderr = os.Stderr
	tsOut, err := cmd.Output()
	if err != nil {
		t.Fatalf("llmref.mjs: %v", err)
	}
	tsSeen := s.take()

	set, err := config.ParseSettings([]byte(p.settings), "m")
	must(t, err)
	reg, err := jsjson.Parse([]byte(p.registry))
	must(t, err)
	ev := &events{}
	l := New(Options{Settings: func() config.Settings { return set }, Registry: func() *jsjson.Object { return reg.(*jsjson.Object) }, Events: ev, Home: home, Getenv: func(k string) string { return p.env[k] }, Metadata: s.metadata("")})
	parsed, keys, results := []jsjson.Value{}, []jsjson.Value{}, []jsjson.Value{}
	for _, r := range p.refs {
		pr, m := l.ParseModelRef(r)
		parsed = append(parsed, jsjson.NewObject("provider", pr, "model", m))
		keys = append(keys, l.HasKey(r))
	}
	for _, c := range p.cases {
		r, err := l.Complete(context.Background(), c.request())
		results = append(results, resultJSON(r, err))
	}
	goOut := jsjson.Stringify(jsjson.NewObject("parsed", parsed, "hasKey", keys, "results", results), "")
	goSeen := s.take()

	ts := regexp.MustCompile(`"error":"(?:[^"\\]|\\.)*is not valid JSON"`).ReplaceAllString(string(tsOut), `"error":"the answer is not JSON"`)
	if ts != goOut {
		t.Errorf("results differ\n  ts %s\n  go %s", ts, goOut)
	}
	if strings.Join(tsSeen, "\n") != strings.Join(goSeen, "\n") {
		t.Errorf("requests differ\n  ts:\n%s\n  go:\n%s", strings.Join(tsSeen, "\n"), strings.Join(goSeen, "\n"))
	}
	return parityRun{tsSeen, goSeen, ev, results}
}

// TestNoRedirects: a provider that redirects, with 307 so the body would be resent, to its own host or to another, gets
// no second request. TS's OpenRouter adapter follows redirects (src/llm/openrouter.ts); Go refuses them in every
// adapter, so the key never reaches the target.
func TestNoRedirects(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"x"}}]}`)
	}))
	t.Cleanup(target.Close)
	src := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/same/landed" {
			mu.Lock()
			hits++
			mu.Unlock()
			return
		}
		if strings.HasPrefix(r.URL.Path, "/same") {
			http.Redirect(w, r, "/same/landed", http.StatusTemporaryRedirect)
			return
		}
		http.Redirect(w, r, target.URL+"/landed", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(src.Close)
	for _, base := range []string{src.URL + "/same", src.URL + "/other"} {
		set, err := config.ParseSettings([]byte(`{"providers":{"oai":{"kind":"openai-compatible","baseUrl":"`+base+`","apiKey":{"env":"OAI_KEY"}}}}`), "m")
		must(t, err)
		env := map[string]string{"OPENROUTER_API_KEY": orKey, "STAM_OPENROUTER_URL": base, "OAI_KEY": "oai-secret-3"}
		l := New(Options{Settings: func() config.Settings { return set }, Registry: func() *jsjson.Object { return jsjson.NewObject() }, Events: &events{}, Home: t.TempDir(), Getenv: func(k string) string { return env[k] }})
		for _, model := range []string{"x/y", "oai:m"} {
			_, err := l.Complete(context.Background(), tcase{name: "redirect", model: model}.request())
			if err == nil || err.Error() != "request failed: TypeError" {
				t.Errorf("%s %s: %v", base, model, err)
			}
		}
	}
	if hits != 0 {
		t.Errorf("a redirect target got %d requests", hits)
	}
}

// resultJSON is the reference script's shape of a result or an error.
func resultJSON(r Result, err error) jsjson.Value {
	if err != nil {
		o := jsjson.NewObject("error", err.Error(), "status", nil, "retryAfterMs", nil)
		if h, ok := err.(*HTTPError); ok {
			o.Set("status", h.Status)
			if h.HasRetryAfter {
				o.Set("retryAfterMs", float64(h.RetryAfter.Milliseconds()))
			}
		}
		return o
	}
	var text, cost, priced jsjson.Value
	if r.Text != nil {
		text = *r.Text
	}
	if r.Cost != nil {
		cost = *r.Cost
	}
	if r.Priced != "" {
		priced = r.Priced
	}
	return jsjson.NewObject("text", text, "model", r.Model, "usage", jsjson.NewObject("inputTokens", r.InputTokens, "outputTokens", r.OutputTokens), "costUsd", cost, "priced", priced)
}

type events struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (e *events) AddEvent(_ context.Context, agent, typ string, data any) error {
	b, _ := json.Marshal(data)
	e.mu.Lock()
	defer e.mu.Unlock()
	fmt.Fprintf(&e.buf, "%s %s %s\n", agent, typ, b)
	return nil
}

func (e *events) text() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.buf.String()
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

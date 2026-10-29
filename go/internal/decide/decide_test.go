package decide

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
)

const secretKey = "sk-or-secret-value-123"

// events records what a Client writes.
type events struct {
	mu     sync.Mutex
	events []struct{ agent, typ, data string }
	spend  []struct {
		purpose string
		cost    float64
		in, out int64
	}
	exact []float64
}

func (e *events) AddEvent(_ context.Context, agent, typ string, data any) error {
	b, _ := json.Marshal(data)
	e.mu.Lock()
	defer e.mu.Unlock()
	e.events = append(e.events, struct{ agent, typ, data string }{agent, typ, string(b)})
	return nil
}

func (e *events) RecordDecideSpend(_ context.Context, purpose string, cost float64, in, out int64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.spend = append(e.spend, struct {
		purpose string
		cost    float64
		in, out int64
	}{purpose, cost, in, out})
	return nil
}

func (e *events) AddExactPending(_ context.Context, usd float64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.exact = append(e.exact, usd)
	return nil
}

func (e *events) types() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for _, ev := range e.events {
		out = append(out, ev.typ)
	}
	return out
}

func setup(t *testing.T, h http.HandlerFunc, set config.Settings, env map[string]string) (*Client, *events, string) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	home := t.TempDir()
	if set.DecisionsModel == "" {
		set.DecisionsModel = "microsoft/microsoft-decision-1"
	}
	vars := map[string]string{"STAM_OPENROUTER_URL": srv.URL, "OPENROUTER_API_KEY": secretKey}
	for k, v := range env {
		vars[k] = v
	}
	ev := &events{}
	return New(Options{Settings: func() config.Settings { return set }, Events: ev, Home: home, Getenv: func(k string) string { return vars[k] }}), ev, home
}

func asked() []Named { return []Named{{"answer", Noul("is it yes?")}} }

// The body is what JSON.stringify gives for the same call in src/llm/openrouter.ts decisions(): compared with node.
func TestRequestMatchesTS(t *testing.T) {
	var got []byte
	var auth string
	c, _, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
		auth = r.Header.Get("authorization")
		io.WriteString(w, `{"model":"m","answers":{"answer":{"noul":0.5}}}`)
	}, config.Settings{}, nil)
	state := jsjson.NewObject("tool", "mail", "arguments", jsjson.NewObject("body", "é<&>  \"q\"", "n", 3.5, "list", []any{true, nil, "x"}), "by", jsjson.NewObject("name", "a", "role", nil))
	qs := []Named{
		{"answer", Noul("is it <yes>?")},
		{"pick", Question{Type: "choice", Instructions: "which", Criteria: []Criterion{{"b", "second"}, {"a", "first"}}}},
		{"score", Question{Type: "score", Instructions: "how", Labels: []string{"low", "high"}}},
	}
	if _, f := c.Decide(context.Background(), state, qs, "decide:test", 0); f != nil {
		t.Fatalf("failure %+v", f)
	}
	want, err := exec.Command("node", "-e", `
const state = { tool: 'mail', arguments: { body: 'é<&>  "q"', n: 3.5, list: [true, null, 'x'] }, by: { name: 'a', role: null } };
const questions = { answer: { type: 'noul', instructions: 'is it <yes>?' }, pick: { type: 'choice', instructions: 'which', criteria: { b: 'second', a: 'first' } }, score: { type: 'score', instructions: 'how', criteria: ['low', 'high'] } };
process.stdout.write(JSON.stringify({ model: 'microsoft/microsoft-decision-1', state, questions }));`).Output()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Errorf("body\n got %s\nwant %s", got, want)
	}
	if auth != "Bearer "+secretKey {
		t.Errorf("authorization %q", auth)
	}
}

func TestAnswersAndSpend(t *testing.T) {
	c, ev, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/decisions" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		io.WriteString(w, `{"model":"served-model","answers":{"answer":{"type":"noul","noul":0.73},"bad":{"noul":1.5},"str":{"noul":"0.2"}},"usage":{"cost":0.01,"input_tokens":12,"output_tokens":3}}`)
	}, config.Settings{}, nil)
	changed := 0
	c.o.LedgerChanged = func() { changed++ }
	res, f := c.Decide(context.Background(), "state text", asked(), "decide:step:st1", time.Second)
	if f != nil {
		t.Fatalf("failure %+v", f)
	}
	if p, ok := res.Noul("answer"); !ok || p != 0.73 {
		t.Errorf("answer = %v %v", p, ok)
	}
	for _, name := range []string{"bad", "str", "missing"} {
		if _, ok := res.Noul(name); ok {
			t.Errorf("%s is no answer", name)
		}
	}
	if res.Model != "served-model" {
		t.Errorf("model %q", res.Model)
	}
	if len(ev.spend) != 1 || ev.spend[0].purpose != "decide:step:st1" || ev.spend[0].cost != 0.01 || ev.spend[0].in != 12 || ev.spend[0].out != 3 {
		t.Errorf("spend %+v", ev.spend)
	}
	if len(ev.events) != 1 || ev.events[0].typ != "decide" || ev.events[0].agent != "stam" ||
		ev.events[0].data != `{"purpose":"decide:step:st1","model":"served-model","cost":0.01,"tokens_in":12,"tokens_out":3}` {
		t.Errorf("events %+v", ev.events)
	}
	// A call with a cost has the budgets evaluated (src/budgets.ts ledgerChanged).
	if changed != 1 {
		t.Errorf("ledger changed %d times", changed)
	}
	// Its cost is billed money, for the reconciliation to take out of the bill (src/reconcile.ts addExactPending).
	if len(ev.exact) != 1 || ev.exact[0] != 0.01 {
		t.Errorf("exact pending %v", ev.exact)
	}
}

// A caller that has already given up gets the same failure as an aborted call, and the event names it.
func TestCancelledContext(t *testing.T) {
	called := false
	c, ev, _ := setup(t, func(w http.ResponseWriter, r *http.Request) { called = true }, config.Settings{}, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res, f := c.Decide(ctx, "s", asked(), "p", time.Second)
	if res != nil || f == nil || f.Kind != "other" || f.Error != "request failed: AbortError" {
		t.Fatalf("result %v failure %+v", res, f)
	}
	if got := ev.types(); len(got) != 1 || got[0] != "decide:error" || ev.events[0].data != `{"purpose":"p","error":"request failed: AbortError"}` {
		t.Errorf("events %+v", ev.events)
	}
	if called {
		t.Error("the model was called for a context that had ended")
	}
}

func TestFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		h      http.HandlerFunc
		kind   string
		status int
		retry  time.Duration
		err    string
		data   string
	}{
		{"rate limit", func(w http.ResponseWriter, r *http.Request) { w.Header().Set("retry-after", "7"); w.WriteHeader(429) }, "rate-limit", 429, 7 * time.Second, "HTTP 429", `{"purpose":"p","error":"HTTP 429","status":429}`},
		{"capped", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("retry-after", "99999")
			w.WriteHeader(500)
		}, "server", 500, 5 * time.Minute, "HTTP 500", `{"purpose":"p","error":"HTTP 500","status":500}`},
		{"zero", func(w http.ResponseWriter, r *http.Request) { w.Header().Set("retry-after", "0"); w.WriteHeader(503) }, "server", 503, 0, "HTTP 503", `{"purpose":"p","error":"HTTP 503","status":503}`},
		{"unauthorised", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) }, "other", 401, 0, "HTTP 401", `{"purpose":"p","error":"HTTP 401","status":401}`},
		{"not json", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "<html>") }, "other", 0, 0, "no answers in the response", `{"purpose":"p","error":"no answers in the response"}`},
		{"no answers", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"model":"m"}`) }, "other", 0, 0, "no answers in the response", `{"purpose":"p","error":"no answers in the response"}`},
		{"answers a string", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"answers":"yes"}`) }, "other", 0, 0, "no answers in the response", `{"purpose":"p","error":"no answers in the response"}`},
		{"timeout", func(w http.ResponseWriter, r *http.Request) { time.Sleep(600 * time.Millisecond) }, "other", 0, 0, "request failed: TimeoutError", `{"purpose":"p","error":"request failed: TimeoutError"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, ev, _ := setup(t, tc.h, config.Settings{}, nil)
			res, f := c.Decide(context.Background(), "s", asked(), "p", 200*time.Millisecond)
			if res != nil || f == nil {
				t.Fatalf("result %v failure %v", res, f)
			}
			// A Retry-After of 0 is not no header: only the 429 and 5xx cases here that set one have it.
			hasRetry := tc.name == "rate limit" || tc.name == "capped" || tc.name == "zero"
			if f.Kind != tc.kind || f.Status != tc.status || f.RetryAfter != tc.retry || f.HasRetryAfter != hasRetry || f.Error != tc.err {
				t.Errorf("failure %+v", *f)
			}
			if got := ev.types(); len(got) != 1 || got[0] != "decide:error" || ev.events[0].data != tc.data || ev.events[0].agent != "stam" {
				t.Errorf("events %+v", ev.events)
			}
			if len(ev.spend) != 0 {
				t.Errorf("a failed call recorded a spend: %+v", ev.spend)
			}
		})
	}
}

// A refused connection names its code and nothing else; the key is in no failure and no event.
func TestNoKeyInFailures(t *testing.T) {
	c, ev, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {}, config.Settings{}, nil)
	c.o.Getenv = func(k string) string {
		return map[string]string{"STAM_OPENROUTER_URL": "http://127.0.0.1:1", "OPENROUTER_API_KEY": secretKey}[k]
	}
	_, f := c.Decide(context.Background(), "s", asked(), "p", time.Second)
	if f == nil || f.Error != "request failed: ECONNREFUSED" {
		t.Fatalf("failure %+v", f)
	}
	all := f.Error
	for _, e := range ev.events {
		all += e.data
	}
	if strings.Contains(all, secretKey) {
		t.Error("the key is in a failure or an event")
	}
	// A key a header cannot carry is refused with fixed text, whatever it holds.
	c.o.Getenv = func(k string) string {
		return map[string]string{"STAM_OPENROUTER_URL": "http://127.0.0.1:1", "OPENROUTER_API_KEY": "bad key\nwith-" + secretKey}[k]
	}
	_, f = c.Decide(context.Background(), "s", asked(), "p", time.Second)
	if f == nil || f.Error != "invalid API key" || strings.Contains(ev.events[len(ev.events)-1].data, secretKey) {
		t.Errorf("failure %+v events %+v", f, ev.events)
	}
}

// No key is a failure with no event and no call (as TS); the other refusals are events that say why.
func TestRefusedBeforeTheCall(t *testing.T) {
	calls := 0
	h := func(w http.ResponseWriter, r *http.Request) { calls++; io.WriteString(w, `{"answers":{}}`) }

	c, ev, _ := setup(t, h, config.Settings{}, map[string]string{"OPENROUTER_API_KEY": ""})
	if _, f := c.Decide(context.Background(), "s", asked(), "p", 0); f == nil || f.Error != "no API key" || len(ev.events) != 0 {
		t.Errorf("no key: %+v %+v", f, ev.events)
	}
	c, ev, _ = setup(t, h, config.Settings{DecisionsModel: "myazure:gpt-4o", ProviderIDs: []string{"myazure"}}, nil)
	if _, f := c.Decide(context.Background(), "s", asked(), "p", 0); f == nil || !strings.Contains(f.Error, "the myazure provider is not ported to the Go daemon yet") || ev.types()[0] != "decide:error" {
		t.Errorf("provider: %+v %+v", f, ev.events)
	}
	// OpenRouter ids hold colons: a prefix that is no configured provider is part of the id.
	c, _, _ = setup(t, h, config.Settings{DecisionsModel: "meta-llama/llama-3:free"}, nil)
	if _, f := c.Decide(context.Background(), "s", asked(), "p", 0); f != nil {
		t.Errorf("an OpenRouter id with a colon: %+v", f)
	}
	// A spent system budget: the held reason is the failure, with its event, and no call goes out (src/budgets.ts
	// providerHeld, asked with the provider).
	c, ev, _ = setup(t, h, config.Settings{}, nil)
	var asked_ string
	c.o.Held = func(p string) string { asked_ = p; return "the system day budget of $8 is spent" }
	if _, f := c.Decide(context.Background(), "s", asked(), "p", 0); f == nil || f.Error != "the system day budget of $8 is spent" || ev.types()[0] != "decide:error" || asked_ != "openrouter" {
		t.Errorf("budget: %+v %+v %q", f, ev.events, asked_)
	}
	if calls != 1 {
		t.Errorf("%d calls reached the endpoint, want only the OpenRouter id's", calls)
	}
}

func TestProvider(t *testing.T) {
	for _, tc := range []struct{ ref, id, model string }{
		{"microsoft/microsoft-decision-1", "openrouter", "microsoft/microsoft-decision-1"},
		{"openrouter:x/y", "openrouter", "x/y"},
		{"myazure:gpt-4o", "myazure", "gpt-4o"},
		{"unknown:gpt", "openrouter", "unknown:gpt"},
		{":x", "openrouter", ":x"},
	} {
		if id, m := provider(tc.ref, []string{"myazure"}); id != tc.id || m != tc.model {
			t.Errorf("%q -> %s %s", tc.ref, id, m)
		}
	}
}

// The real stub the TS tests use answers a Go call as it does a TS one (P=0.NN markers).
func TestAgainstTheTSStub(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command("node", "../../../test/decide-stub.mjs", dir)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	var url string
	for i := 0; i < 200 && url == ""; i++ {
		if b, err := os.ReadFile(filepath.Join(dir, "url")); err == nil {
			url = strings.TrimSpace(string(b))
		}
		time.Sleep(25 * time.Millisecond)
	}
	if url == "" {
		t.Fatal("the stub did not start")
	}
	c, ev, _ := setup(t, nil, config.Settings{}, map[string]string{"STAM_OPENROUTER_URL": url})
	res, f := c.Decide(context.Background(), "P=0.81 anything", asked(), "decide:step:x", 5*time.Second)
	if f != nil {
		t.Fatalf("failure %+v", f)
	}
	if p, ok := res.Noul("answer"); !ok || p != 0.81 {
		t.Errorf("the stub's answer: %v %v", p, ok)
	}
	// STUB:FAIL is a 500 with Retry-After: 0, STUB:WAIT one with 3600 (capped to 5 minutes).
	_, f = c.Decide(context.Background(), "STUB:FAIL", asked(), "p", 5*time.Second)
	if f == nil || f.Kind != "server" || f.RetryAfter != 0 {
		t.Errorf("STUB:FAIL: %+v", f)
	}
	_, f = c.Decide(context.Background(), "STUB:WAIT", asked(), "p", 5*time.Second)
	if f == nil || f.Kind != "server" || f.RetryAfter != 5*time.Minute {
		t.Errorf("STUB:WAIT: %+v", f)
	}
	if len(ev.spend) != 1 {
		t.Errorf("spend rows %d", len(ev.spend))
	}
}

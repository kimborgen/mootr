// Package decide is src/decide.ts: one cheap call to a small decision model that answers fixed questions about a piece of
// state (the steps, the requirement checks, the process runs). The call is OpenRouter's alpha decisions endpoint:
//
//	POST {STAM_OPENROUTER_URL or https://openrouter.ai/api/alpha}/decisions
//	{"model": id, "state": <string|object|array>, "questions": {"<name>": <question>}}
//	-> {"model": id, "answers": {"<name>": <answer>}, "usage": {...}}
//
// The key is stam's own (keys.go); the model is settings.decisions.model. The cost is recorded in stam's usage under the
// openrouter-system account, attributed to stam with the purpose as the model. A failure never panics into a caller's path:
// Decide returns a Failure and records a `decide:error` event that names its cause. No key, token or header value is ever in
// a failure's text or a log line.
//
// The budgets come in through Options: Held refuses a call once its provider's system budget is spent (src/budgets.ts
// providerHeld), and LedgerChanged has the budgets evaluated after a call with a cost (ledgerChanged).
//
// A response's cost is billed money, so it is added to the reconcile's exact pending total (src/reconcile.ts
// addExactPending), which the OpenRouter ledger's reconciliation takes out of the bill first.
//
// Not ported: a model on another provider (settings.providers: OpenAI-compatible, Azure, Bedrock, and the completion-based
// askByCompletion they use) fails with a cause that says so.
package decide

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"stam/internal/config"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/llm"
	"stam/internal/secrets"
)

// DefaultTimeout is a decide call's, 20 seconds.
const DefaultTimeout = 20 * time.Second

// Question is one question to the model: a noul (P(yes)), a choice among Criteria's keys, or a score with labels.
type Question struct {
	Type         string
	Instructions string
	// Criteria are a choice's keys and descriptions, in order.
	Criteria []Criterion
	// Labels are a score's criteria.
	Labels []string
}

// Criterion is one choice of a choice question.
type Criterion struct{ Key, Description string }

// Noul is a noul question.
func Noul(instructions string) Question { return Question{Type: "noul", Instructions: instructions} }

// Named is a question with its name, in the order asked.
type Named struct {
	Name string
	Question
}

func (q Question) json() *jsjson.Object {
	o := jsjson.NewObject("type", q.Type, "instructions", q.Instructions)
	switch q.Type {
	case "choice":
		c := jsjson.NewObject()
		for _, k := range q.Criteria {
			c.Set(k.Key, k.Description)
		}
		o.Set("criteria", c)
	case "score":
		l := make([]any, len(q.Labels))
		for i, s := range q.Labels {
			l[i] = s
		}
		o.Set("criteria", l)
	}
	return o
}

// Result is a model's answers: one entry per question name, shaped by the question's type.
type Result struct {
	Model   string
	Answers jsfmt.Value
	Usage   jsfmt.Value
}

// Noul is a noul question's probability, or false when the answer is missing or outside 0..1.
func (r *Result) Noul(name string) (float64, bool) {
	if r == nil {
		return 0, false
	}
	a, ok := r.Answers.Get(name)
	if !ok {
		return 0, false
	}
	n, ok := a.Get("noul")
	if !ok || n.Kind != jsfmt.Number {
		return 0, false
	}
	f, err := strconv.ParseFloat(n.Num, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > 1 {
		return 0, false
	}
	return f, true
}

// Failure is why a call failed. Kind tells a rate limit (429) or a server error (5xx), which a caller may retry, from
// anything else (no key, a network error, a timeout, a bad body). RetryAfter is the Retry-After header, when there was one.
type Failure struct {
	Kind       string
	Status     int
	RetryAfter time.Duration
	// HasRetryAfter tells a header of 0 from none (retryAfterMs is 0 for one and undefined for the other).
	HasRetryAfter bool
	Error         string
}

// Events is where a failure and a spend are recorded: *db.DB.
type Events interface {
	AddEvent(ctx context.Context, agentID, typ string, data any) error
	RecordDecideSpend(ctx context.Context, purpose string, cost float64, tokensIn, tokensOut int64) error
	AddExactPending(ctx context.Context, usd float64) error
}

// Options is what a Client needs from the daemon.
type Options struct {
	Settings func() config.Settings
	Events   Events
	// Home is STAM_HOME, where the secret store and opencode.env are.
	Home   string
	Getenv func(string) string
	// HTTP is the client for the calls; nil is a client with no timeout of its own (each call has its deadline).
	HTTP *http.Client
	// Held is why a call through the provider may not run now, its system budget spent, or ""; nil holds nothing.
	Held func(provider string) string
	// LedgerChanged runs after a call's cost is recorded, when it isn't zero; nil runs nothing.
	LedgerChanged func()
}

// Client asks the decision model.
type Client struct {
	o      Options
	client *http.Client
}

// New returns a Client.
func New(o Options) *Client {
	if o.Getenv == nil {
		o.Getenv = os.Getenv
	}
	h := o.HTTP
	if h == nil {
		h = &http.Client{}
	}
	return &Client{o: o, client: h}
}

func (c *Client) base() string {
	if u := c.o.Getenv("STAM_OPENROUTER_URL"); u != "" {
		return u
	}
	return "https://openrouter.ai/api/alpha"
}

// HasKey is whether stam's own OpenRouter key is set, so a caller can skip a call that cannot be made.
func (c *Client) HasKey() bool { return c.key() != "" }

func (c *Client) key() string { return secrets.KeyFor(c.o.Home, "OPENROUTER_API_KEY", c.o.Getenv) }

// provider is the provider a `provider:model` name means: a prefix that is a configured provider, else OpenRouter, which
// takes the whole string (its ids hold colons: `meta-llama/llama-3:free`).
func provider(ref string, ids []string) (id, model string) {
	if i := strings.IndexByte(ref, ':'); i > 0 {
		for _, p := range ids {
			if p == ref[:i] && p != "openrouter" {
				return p, ref[i+1:]
			}
		}
		if ref[:i] == "openrouter" {
			return "openrouter", ref[i+1:]
		}
	}
	return "openrouter", ref
}

// Decide is decideWithFailure: the answers and no failure, or no result and the failure, with an event either way (a missing
// key aside, as in TS). purpose names what the call is for (`decide:mail-check`); it is recorded with the cost.
func (c *Client) Decide(ctx context.Context, state jsjson.Value, questions []Named, purpose string, timeout time.Duration) (*Result, *Failure) {
	set := c.o.Settings()
	prov, model := provider(set.DecisionsModel, set.ProviderIDs)
	if prov != "openrouter" {
		return nil, c.fail(ctx, purpose, Failure{Kind: "other", Error: fmt.Sprintf("the %s provider is not ported to the Go daemon yet; set settings.decisions.model to an OpenRouter model", prov)})
	}
	// One read of the key: the call below uses this snapshot, not a second read.
	key := c.key()
	if key == "" {
		return nil, &Failure{Kind: "other", Error: "no API key"}
	}
	if c.o.Held != nil {
		if held := c.o.Held(prov); held != "" {
			return nil, c.fail(ctx, purpose, Failure{Kind: "other", Error: held})
		}
	}
	if !secrets.CheckCredential(key) {
		return nil, c.fail(ctx, purpose, Failure{Kind: "other", Error: "invalid API key"})
	}
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	qs := jsjson.NewObject()
	for _, q := range questions {
		qs.Set(q.Name, q.json())
	}
	body := jsjson.Stringify(jsjson.NewObject("model", model, "state", state, "questions", qs), "")
	data, fail := c.post(ctx, key, []byte(body), timeout)
	if fail != nil {
		return nil, c.fail(ctx, purpose, *fail)
	}
	answers, ok := data.Get("answers")
	if !ok || (answers.Kind != jsfmt.Object && answers.Kind != jsfmt.Array) {
		return nil, c.fail(ctx, purpose, Failure{Kind: "other", Error: "no answers in the response"})
	}
	usage, _ := data.Get("usage")
	if usage.Kind != jsfmt.Object {
		usage = jsfmt.Value{Kind: jsfmt.Object}
	}
	used := model
	if m, ok := data.Get("model"); ok && m.Kind != jsfmt.Null {
		used = jsToString(m)
	}
	c.recordSpend(ctx, purpose, used, number(usage, "cost"), int64(number(usage, "input_tokens")), int64(number(usage, "output_tokens")))
	return &Result{Model: used, Answers: answers, Usage: usage}, nil
}

// post is the decisions call. Its failures carry fixed text: a transport error becomes `request failed: CODE`, as src/llm/http.ts
// send does, since the library's own error can quote a header, the key among them.
func (c *Client) post(ctx context.Context, key string, body []byte, timeout time.Duration) (jsfmt.Value, *Failure) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(c.base(), "/")+"/decisions", bytes.NewReader(body))
	if err != nil {
		return jsfmt.Value{}, &Failure{Kind: "other", Error: "request failed: Error"}
	}
	req.Header.Set("authorization", "Bearer "+key)
	req.Header.Set("content-type", "application/json")
	res, err := c.client.Do(req)
	if err != nil {
		return jsfmt.Value{}, &Failure{Kind: "other", Error: "request failed: " + llm.TransportCode(err)}
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		kind := "other"
		if res.StatusCode == 429 {
			kind = "rate-limit"
		} else if res.StatusCode >= 500 {
			kind = "server"
		}
		ra, hasRA := llm.RetryAfter(res.Header.Get("retry-after"))
		return jsfmt.Value{}, &Failure{Kind: kind, Status: res.StatusCode, RetryAfter: ra, HasRetryAfter: hasRA, Error: fmt.Sprintf("HTTP %d", res.StatusCode)}
	}
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return jsfmt.Value{}, &Failure{Kind: "other", Error: "no answers in the response"}
	}
	v, err := jsfmt.Parse(raw)
	if err != nil {
		// res.json().catch(() => null): a body that is not JSON has no answers.
		return jsfmt.Value{Kind: jsfmt.Null}, nil
	}
	return v, nil
}

// fail records the failure as a `decide:error` event, which names its cause, and returns it.
func (c *Client) fail(ctx context.Context, purpose string, f Failure) *Failure {
	data := struct {
		Purpose string `json:"purpose"`
		Error   string `json:"error"`
		Status  int    `json:"status,omitempty"`
	}{purpose, f.Error, f.Status}
	if err := c.o.Events.AddEvent(context.WithoutCancel(ctx), "stam", "decide:error", data); err != nil {
		slog.Warn("decide: the error event was not recorded", "purpose", purpose)
	}
	return &f
}

// recordSpend is src/decide.ts recordSpend: the usage row and a `decide` event. The tokens ride along so the Usage By model
// view can split stam's spend by purpose.
func (c *Client) recordSpend(ctx context.Context, purpose, model string, cost float64, tokensIn, tokensOut int64) {
	ctx = context.WithoutCancel(ctx)
	if err := c.o.Events.RecordDecideSpend(ctx, purpose, cost, tokensIn, tokensOut); err != nil {
		slog.Warn("decide: the spend was not recorded", "purpose", purpose)
	}
	// The response's own cost is billed money: the reconciliation takes it out of the bill before it scales OpenCode's.
	// Every call here is OpenRouter's (a model on another provider fails before the call).
	if err := c.o.Events.AddExactPending(ctx, cost); err != nil {
		slog.Warn("decide: the exact pending cost was not recorded", "purpose", purpose)
	}
	data := struct {
		Purpose   string  `json:"purpose"`
		Model     string  `json:"model"`
		Cost      float64 `json:"cost"`
		TokensIn  int64   `json:"tokens_in"`
		TokensOut int64   `json:"tokens_out"`
	}{purpose, model, cost, tokensIn, tokensOut}
	if err := c.o.Events.AddEvent(ctx, "stam", "decide", data); err != nil {
		slog.Warn("decide: the event was not recorded", "purpose", purpose)
	}
	// Stam's own calls count against the global budget (and the system account's).
	if cost > 0 && c.o.LedgerChanged != nil {
		c.o.LedgerChanged()
	}
}

// number is `Number(v[key]) || 0` for a JSON number or numeric string.
func number(v jsfmt.Value, key string) float64 {
	m, ok := v.Get(key)
	if !ok {
		return 0
	}
	var f float64
	switch m.Kind {
	case jsfmt.Number:
		f, _ = strconv.ParseFloat(m.Num, 64)
	case jsfmt.String:
		f, _ = strconv.ParseFloat(strings.TrimSpace(m.Str), 64)
	case jsfmt.Bool:
		if m.Bool {
			f = 1
		}
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	return f
}

// jsToString is String(v) for a scalar.
func jsToString(v jsfmt.Value) string {
	switch v.Kind {
	case jsfmt.String:
		return v.Str
	case jsfmt.Number:
		return v.Num
	case jsfmt.Bool:
		return strconv.FormatBool(v.Bool)
	}
	return jsfmt.Compact(v)
}

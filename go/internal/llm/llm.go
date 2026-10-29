// Package llm is src/llm: the one place stam's own model calls go through. Complete asks a model for text; a provider is
// an adapter keyed by id: OpenRouter, built in, and the OpenAI-compatible and Azure ones built from settings.providers.
//
// A model is named `provider:model`. With no provider named, or a prefix that is no configured provider (OpenRouter ids
// such as `meta-llama/llama-3:free` contain colons), the default provider, `openrouter`, takes the whole string.
//
// No key or credential value is ever in an error's text, an event or a log line: transport failures are fixed text
// (`request failed: CODE`), and an answer that is not JSON is named, not quoted.
//
// Not ported: listModels, balance, keyLimit, checkKey and testSecret.
package llm

import (
	"context"
	"log/slog"
	"math"
	"net"
	"net/http"
	"os"
	"slices"
	"sync"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// DefaultProvider is OpenRouter, which takes any model name that names no configured provider.
const DefaultProvider = "openrouter"

// Message is one chat message: system, user or assistant.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// JSONSchema constrains the answer (structured output). Strict is true unless set.
type JSONSchema struct {
	Name   string
	Schema *jsjson.Object
	Strict *bool
}

func (j *JSONSchema) format() *jsjson.Object {
	strict := true
	if j.Strict != nil {
		strict = *j.Strict
	}
	return jsjson.NewObject("type", "json_schema", "json_schema", jsjson.NewObject("name", j.Name, "strict", strict, "schema", j.Schema))
}

// Request is what a caller asks: the model as `provider:model` or a bare model id (the default provider's).
type Request struct {
	Model     string
	Messages  []Message
	MaxTokens int
	// Temperature is left out of the request when nil (some reasoning models reject any temperature).
	Temperature *float64
	JSONSchema  *JSONSchema
	// Timeout bounds the call when set; the context cancels it.
	Timeout time.Duration
}

func (r Request) messages() []jsjson.Value {
	out := make([]jsjson.Value, len(r.Messages))
	for i, m := range r.Messages {
		out[i] = jsjson.NewObject("role", m.Role, "content", m.Content)
	}
	return out
}

// Result is a model's answer. Text is nil when the provider gave no usable text.
type Result struct {
	Text *string
	// Model is the model the provider says answered; the requested model when it says nothing.
	Model                     string
	InputTokens, OutputTokens float64
	// Cost is the billed cost in USD, when the provider reports one or stam priced the call (Priced says how).
	Cost   *float64
	Priced string
}

// Adapter is a provider. Complete fails with an *HTTPError for a non-2xx answer, and with fixed text otherwise.
type Adapter interface {
	ID() string
	// APIKey is the provider's key, "" when it has none.
	APIKey() string
	// Keyless is a provider that takes no key (a local Ollama): HasKey is true without one.
	Keyless() bool
	// Unmetered is a server that bills nothing: a model with no catalogue price books $0, not the fallback.
	Unmetered() bool
	Complete(ctx context.Context, req Request) (Result, error)
}

// Events is where the layer records an unpriced model: *db.DB.
type Events interface {
	AddEvent(ctx context.Context, agentID, typ string, data any) error
}

// Options is what the layer needs from the daemon.
type Options struct {
	Settings func() config.Settings
	// Registry is the merged registry (src/registry.ts registry()); its prices price a call no provider bills.
	Registry func() *jsjson.Object
	Events   Events
	// Home is STAM_HOME, where the secret store is.
	Home   string
	Getenv func(string) string
	// HTTP is the client for the calls; nil is a client with no timeout of its own.
	HTTP *http.Client
	// Now is the clock SigV4 signs with and the instance role's cache reads; nil is time.Now.
	Now func() time.Time
	// Metadata carries the EC2 metadata service's calls; nil is a direct transport, never a proxy. Tests serve the
	// service's fixtures through it.
	Metadata http.RoundTripper
}

// Layer is the provider registry and the calls through it.
type Layer struct {
	o      Options
	client *http.Client
	// metadata is the EC2 metadata service's client: no proxy, no redirects.
	metadata *http.Client
	// unpriced holds the models whose fallback price was logged: once per model, not per call.
	mu       sync.Mutex
	unpriced map[string]bool
	role     roleCache
}

// New returns a Layer.
func New(o Options) *Layer {
	if o.Getenv == nil {
		o.Getenv = os.Getenv
	}
	if o.HTTP == nil {
		o.HTTP = &http.Client{}
	}
	meta := o.Metadata
	if meta == nil {
		meta = &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: time.Second}).DialContext}
	}
	return &Layer{o: o, client: o.HTTP, metadata: noRedirects(&http.Client{Transport: meta}), unpriced: map[string]bool{}}
}

// adapters is the built-in OpenRouter and the providers settings.providers configures, rebuilt from the settings on
// each use (src/llm/index.ts sync). A configured id never replaces OpenRouter.
func (l *Layer) adapters() map[string]Adapter {
	out := map[string]Adapter{DefaultProvider: &openRouter{l: l}}
	set := l.o.Settings()
	for id, v := range set.Providers {
		if id == DefaultProvider || !slices.Contains(set.ProviderIDs, id) {
			continue
		}
		if a := l.configured(id, v); a != nil {
			out[id] = a
		}
	}
	return out
}

// Provider is the adapter of that id, or nil.
func (l *Layer) Provider(id string) Adapter { return l.adapters()[id] }

// ParseModelRef splits a model name into its provider and model id.
func (l *Layer) ParseModelRef(ref string) (provider, model string) {
	return parseModelRef(ref, l.adapters())
}

func parseModelRef(ref string, adapters map[string]Adapter) (string, string) {
	for i := 0; i < len(ref); i++ {
		if ref[i] == ':' {
			if _, ok := adapters[ref[:i]]; ok && i > 0 {
				return ref[:i], ref[i+1:]
			}
			break
		}
	}
	return DefaultProvider, ref
}

func (l *Layer) resolve(ref string) (Adapter, string) {
	adapters := l.adapters()
	p, m := parseModelRef(ref, adapters)
	return adapters[p], m
}

// HasKey is whether the model's provider has a key (or takes none), so a caller can skip a call that cannot be made.
func (l *Layer) HasKey(ref string) bool {
	a, _ := l.resolve(ref)
	return a.APIKey() != "" || a.Keyless()
}

// Complete asks the model. A result with no cost, from a provider that reports none, is priced from its tokens, so a call
// through OpenAI or Azure never books $0.
func (l *Layer) Complete(ctx context.Context, req Request) (Result, error) {
	a, model := l.resolve(req.Model)
	req.Model = model
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	r, err := a.Complete(ctx, req)
	if err != nil || r.Cost != nil || a.ID() == DefaultProvider {
		return r, err
	}
	cost, priced := l.price(a.ID(), model, r.InputTokens, r.OutputTokens, a.Unmetered())
	r.Cost, r.Priced = &cost, priced
	if priced == "fallback" {
		l.mu.Lock()
		first := !l.unpriced[a.ID()+":"+model]
		l.unpriced[a.ID()+":"+model] = true
		l.mu.Unlock()
		if first && l.o.Events != nil {
			data := struct {
				Provider  string  `json:"provider"`
				Model     string  `json:"model"`
				CostUSD   float64 `json:"cost_usd"`
				TokensIn  float64 `json:"tokens_in"`
				TokensOut float64 `json:"tokens_out"`
			}{a.ID(), model, cost, r.InputTokens, r.OutputTokens}
			if err := l.o.Events.AddEvent(context.WithoutCancel(ctx), "stam", "llm:unpriced", data); err != nil {
				slog.Warn("llm: the unpriced event was not recorded", "provider", a.ID())
			}
		}
	}
	return r, nil
}

// FallbackInput and FallbackOutput are the price, USD per million tokens, of a model with none: dearer than any model in
// the registry, so an unpriced model overstates its spend rather than hides it (src/llm/pricing.ts FALLBACK_PRICE).
const (
	FallbackInput  = 15
	FallbackOutput = 75
)

// price is src/llm/pricing.ts priceCall: the registry's price by `provider:model`, then by the bare model id.
func (l *Layer) price(provider, model string, in, out float64, unmetered bool) (float64, string) {
	var prices *jsjson.Object
	if l.o.Registry != nil {
		if r := l.o.Registry(); r != nil {
			prices, _ = get(r, "prices").(*jsjson.Object)
		}
	}
	p := get(prices, provider+":"+model)
	if p == nil {
		p = get(prices, model)
	}
	input, okIn := get(p, "input").(float64)
	output, okOut := get(p, "output").(float64)
	known := okIn && okOut
	if !known && unmetered {
		return 0, "free"
	}
	if !known {
		input, output = FallbackInput, FallbackOutput
	}
	return (float64(in*input) + float64(out*output)) / 1e6, map[bool]string{true: "catalog", false: "fallback"}[known]
}

// get is v?.[key] for a parsed object, nil otherwise.
func get(v jsjson.Value, key string) jsjson.Value {
	o, ok := v.(*jsjson.Object)
	if !ok || o == nil {
		return nil
	}
	x, _ := o.Get(key)
	return x
}

// number is `Number(v) || 0`.
func number(v jsjson.Value) float64 {
	n := jsjson.ToNumber(v)
	if math.IsNaN(n) {
		return 0
	}
	return n
}

// usage reads an answer's token counts: Number(usage.prompt_tokens) || 0 and the same for completion_tokens.
func usage(data jsjson.Value) (in, out float64, u jsjson.Value) {
	u = get(data, "usage")
	return number(get(u, "prompt_tokens")), number(get(u, "completion_tokens")), u
}

// answerModel is String(data?.model ?? req.model).
func answerModel(data jsjson.Value, asked string) string {
	if m := get(data, "model"); m != nil {
		return jsjson.ToString(m)
	}
	return asked
}

// firstChoice is data?.choices?.[0].
func firstChoice(data jsjson.Value) jsjson.Value {
	if c, ok := get(data, "choices").([]jsjson.Value); ok && len(c) > 0 {
		return c[0]
	}
	return nil
}

package llm

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"

	"stam/internal/config"
	"stam/internal/jsjson"
	"stam/internal/secrets"
)

// The OpenAI-compatible and Azure OpenAI adapters (src/llm/openai.ts): chat completions with a key and a base URL, built
// from a provider's config in settings.providers. Neither reports a cost, so Complete prices the call from its tokens.

// keyRef is where a key comes from: an environment variable, or a name in the secret store.
type keyRef struct{ env, secret string }

// providerConfig is parseProviderConfig's result: the supported kinds with their required strings.
type providerConfig struct {
	kind                      string
	baseURL, maxTokensParam   string
	endpoint, apiVersion, dep string
	apiKey                    *keyRef
	temperature               *float64
}

// parseProviderConfig is src/llm/openai.ts parseProviderConfig; a bedrock entry is its key and temperature here and the
// rest in parseBedrockConfig, as the caller takes only the entries config.Settings.ProviderIDs lists (parseBedrockConfig's
// checks are there). Nil for anything else.
func parseProviderConfig(v any) *providerConfig {
	o, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	str := func(m map[string]any, k string) string {
		s, _ := m[k].(string)
		return jsjson.Trim(s)
	}
	c := &providerConfig{}
	if k, ok := o["apiKey"].(map[string]any); ok && (str(k, "env") != "" || str(k, "secret") != "") {
		c.apiKey = &keyRef{env: str(k, "env"), secret: str(k, "secret")}
	}
	if t, ok := o["temperature"].(float64); ok && !math.IsInf(t, 0) && !math.IsNaN(t) {
		c.temperature = &t
	}
	switch o["kind"] {
	case "openai-compatible":
		if c.baseURL = str(o, "baseUrl"); c.baseURL == "" {
			return nil
		}
		c.kind = "openai-compatible"
		if o["maxTokensParam"] == "max_completion_tokens" {
			c.maxTokensParam = "max_completion_tokens"
		}
		return c
	case "azure":
		if c.endpoint, c.apiVersion = str(o, "endpoint"), str(o, "apiVersion"); c.endpoint == "" || c.apiVersion == "" {
			return nil
		}
		c.kind, c.dep = "azure", str(o, "deployment")
		return c
	case "bedrock":
		c.kind = "bedrock"
		return c
	}
	return nil
}

// Provider is a settings.providers entry as src/llm's parsers read it (parseBedrockConfig, else parseProviderConfig), for
// a reader outside the model layer: the OpenCode adapter's provider blocks (src/adapters/opencode-providers.ts).
type Provider struct {
	// Kind is openai-compatible, azure or bedrock.
	Kind string
	// BaseURL is an openai-compatible provider's. Endpoint, APIVersion and Deployment are an Azure provider's; a Bedrock
	// one has Region, Profile, and Endpoint as its origin.
	BaseURL, Endpoint, APIVersion, Deployment, Region, Profile string
	key                                                        *keyRef
}

// ParseProvider is the entry as a Provider, or nil when neither parser takes it (config.ProviderParses).
func ParseProvider(v any) *Provider {
	if !config.ProviderParses(v) {
		return nil
	}
	c := parseProviderConfig(v)
	p := &Provider{Kind: c.kind, BaseURL: c.baseURL, Endpoint: c.endpoint, APIVersion: c.apiVersion, Deployment: c.dep, key: c.apiKey}
	if c.kind == "bedrock" {
		b := parseBedrockConfig(v.(map[string]any), c)
		p.Region, p.Profile, p.Endpoint = b.region, b.profile, b.endpoint
	}
	return p
}

// Key is src/llm/openai.ts resolveKey: the key's variable when set, over its stored secret; "" for no key.
func (p *Provider) Key(home string, getenv func(string) string) string {
	if p.key == nil {
		return ""
	}
	return resolveKey(home, getenv, p.key)
}

// configured is the adapter a settings.providers entry builds, or nil when it parses as none.
func (l *Layer) configured(id string, v any) Adapter {
	c := parseProviderConfig(v)
	switch {
	case c == nil:
		return nil
	case c.kind == "bedrock":
		b := parseBedrockConfig(v.(map[string]any), c)
		return &bedrock{l: l, id: id, c: b, url: b.base()}
	}
	return &openAI{l: l, id: id, c: c}
}

// openAI is an OpenAI-compatible or an Azure provider.
type openAI struct {
	l  *Layer
	id string
	c  *providerConfig
}

func (a *openAI) ID() string { return a.id }

// Keyless and Unmetered: an OpenAI-compatible server configured with no key (a local Ollama or vLLM).
func (a *openAI) Keyless() bool   { return a.c.kind == "openai-compatible" && a.c.apiKey == nil }
func (a *openAI) Unmetered() bool { return a.Keyless() }

// APIKey is resolveKey: a set variable over the stored secret.
func (a *openAI) APIKey() string {
	r := a.c.apiKey
	if r == nil {
		return ""
	}
	if r.env != "" {
		if v := jsjson.Trim(a.l.o.Getenv(r.env)); v != "" {
			return v
		}
	}
	if r.secret != "" {
		return secrets.Get(a.l.o.Home, r.secret, a.l.o.Getenv)
	}
	return ""
}

var azureV1 = regexp.MustCompile(`/openai/v1$`)

func (a *openAI) Complete(ctx context.Context, req Request) (Result, error) {
	k := a.APIKey()
	headers := map[string]string{}
	var url string
	var body *jsjson.Object
	if a.c.kind == "azure" {
		if k == "" {
			return Result{}, errors.New("no API key")
		}
		if !secrets.CheckCredential(k) {
			return Result{}, errors.New("invalid API key")
		}
		headers["api-key"] = k
		endpoint := strings.TrimRight(a.c.endpoint, "/")
		model := a.c.dep
		if model == "" {
			model = req.Model
		}
		// The v1 API names the model in the body; the dated API names the deployment in the path.
		if a.c.apiVersion == "v1" || azureV1.MatchString(endpoint) {
			if !azureV1.MatchString(endpoint) {
				endpoint += "/openai/v1"
			}
			url, body = endpoint+"/chat/completions", a.body(req, model, "max_completion_tokens")
		} else {
			url = fmt.Sprintf("%s/openai/deployments/%s/chat/completions?api-version=%s", endpoint, encodeURIComponent(model), encodeURIComponent(a.c.apiVersion))
			body = a.body(req, "", "max_completion_tokens")
		}
	} else {
		if k == "" && a.c.apiKey != nil {
			return Result{}, errors.New("no API key")
		}
		if k != "" {
			if !secrets.CheckCredential(k) {
				return Result{}, errors.New("invalid API key")
			}
			headers["authorization"] = "Bearer " + k
		}
		param := a.c.maxTokensParam
		if param == "" {
			param = "max_tokens"
		}
		url, body = strings.TrimRight(a.c.baseURL, "/")+"/chat/completions", a.body(req, req.Model, param)
	}
	data, err := post(ctx, a.l.client, url, headers, jsjson.Stringify(body, ""))
	if err != nil {
		return Result{}, err
	}
	in, out, _ := usage(data)
	r := Result{Model: answerModel(data, req.Model), InputTokens: in, OutputTokens: out}
	// A refusal, a filtered answer or one cut off at the token limit is no answer: its text may be partial.
	choice := firstChoice(data)
	finish := get(choice, "finish_reason")
	cut := jsjson.Truthy(get(get(choice, "message"), "refusal")) || finish == "length" || finish == "content_filter"
	if content, ok := get(get(choice, "message"), "content").(string); ok && !cut {
		r.Text = &content
	}
	return r, nil
}

// body is the fields both APIs share: the model (when named), the messages, the JSON-schema constraint, the token limit
// and the temperature, the request's or else the config's.
func (a *openAI) body(req Request, model, tokensParam string) *jsjson.Object {
	b := jsjson.NewObject()
	if model != "" {
		b.Set("model", model)
	}
	b.Set("messages", req.messages())
	if req.JSONSchema != nil {
		b.Set("response_format", req.JSONSchema.format())
	}
	b.Set(tokensParam, req.MaxTokens)
	if t := req.Temperature; t != nil {
		b.Set("temperature", *t)
	} else if a.c.temperature != nil {
		b.Set("temperature", *a.c.temperature)
	}
	return b
}

// encodeURIComponent is JavaScript's: every byte but A-Z a-z 0-9 - _ . ! ~ * ' ( ) percent-encoded.
func encodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

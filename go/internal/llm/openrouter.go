package llm

import (
	"context"
	"errors"

	"stam/internal/jsjson"
	"stam/internal/secrets"
)

// openRouter is src/llm/openrouter.ts complete: chat completions with usage accounting. The key is stam's own (the secret
// store's `stam` slot); the base URL is STAM_OPENROUTER_URL when set, so a test stubs every call.
type openRouter struct{ l *Layer }

func (o *openRouter) ID() string      { return DefaultProvider }
func (o *openRouter) Keyless() bool   { return false }
func (o *openRouter) Unmetered() bool { return false }

func (o *openRouter) APIKey() string {
	return secrets.KeyFor(o.l.o.Home, "OPENROUTER_API_KEY", o.l.o.Getenv)
}

// base is envVar('OPENROUTER_URL'): MOOTR_ before STAM_.
func (o *openRouter) base() string {
	for _, name := range []string{"MOOTR_OPENROUTER_URL", "STAM_OPENROUTER_URL"} {
		if u := o.l.o.Getenv(name); u != "" {
			return u
		}
	}
	return "https://openrouter.ai/api/v1"
}

func (o *openRouter) Complete(ctx context.Context, req Request) (Result, error) {
	key := o.APIKey()
	if key == "" {
		return Result{}, errors.New("no API key")
	}
	if !secrets.CheckCredential(key) {
		return Result{}, errors.New("invalid API key")
	}
	body := jsjson.NewObject("model", req.Model, "messages", req.messages())
	if req.JSONSchema != nil {
		body.Set("response_format", req.JSONSchema.format())
	}
	body.Set("max_tokens", req.MaxTokens)
	if req.Temperature != nil {
		body.Set("temperature", *req.Temperature)
	}
	body.Set("usage", jsjson.NewObject("include", true))
	data, err := post(ctx, o.l.client, o.base()+"/chat/completions", map[string]string{"authorization": "Bearer " + key}, jsjson.Stringify(body, ""))
	if err != nil {
		return Result{}, err
	}
	in, out, u := usage(data)
	cost := number(get(u, "cost"))
	r := Result{Model: answerModel(data, req.Model), InputTokens: in, OutputTokens: out, Cost: &cost}
	if content, ok := get(get(firstChoice(data), "message"), "content").(string); ok {
		r.Text = &content
	}
	return r, nil
}

package catalog

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"stam/internal/jsjson"
)

// modelsTTL is how long the OpenRouter catalogue is served from memory.
const modelsTTL = 6 * time.Hour

// OpenRouter is src/model-catalog.ts openRouterModels over src/llm/openrouter.ts listModels: OpenRouter's public model
// catalogue, kept in memory for six hours and fetched once for every caller that asks meanwhile. A failed refresh keeps
// the last catalogue.
type OpenRouter struct {
	// Base is the API base, STAM_OPENROUTER_URL or https://openrouter.ai/api/v1.
	Base   func() string
	Client *http.Client
	Now    func() time.Time

	mu       sync.Mutex
	at       time.Time
	models   []jsjson.Value
	inflight chan struct{}
	err      error
	// waiting counts the callers waiting for a fetch, for tests.
	waiting int
}

// NewOpenRouter is the catalogue at base (the default when it gives ""), with no redirects followed, as TS's
// `redirect: 'manual'`.
func NewOpenRouter(base func() string) *OpenRouter {
	return &OpenRouter{
		Base: func() string {
			if b := base(); b != "" {
				return b
			}
			return "https://openrouter.ai/api/v1"
		},
		Client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		Now:    time.Now,
	}
}

// Models is the catalogue, [{id, name, in, out}], with prices in USD per million tokens or null.
func (o *OpenRouter) Models(ctx context.Context) ([]jsjson.Value, error) {
	o.mu.Lock()
	if o.models != nil && o.Now().Sub(o.at) < modelsTTL {
		defer o.mu.Unlock()
		return o.models, nil
	}
	wait := o.inflight
	if wait == nil {
		wait = make(chan struct{})
		o.inflight = wait
		// The fetch is the catalogue's, not this request's: a caller that goes away leaves it to the others.
		go o.refresh(context.WithoutCancel(ctx), wait)
	}
	o.waiting++
	o.mu.Unlock()
	select {
	case <-wait:
	case <-ctx.Done():
		o.mu.Lock()
		o.waiting--
		o.mu.Unlock()
		return nil, ctx.Err()
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.waiting--
	if o.err != nil {
		return nil, o.err
	}
	return o.models, nil
}

func (o *OpenRouter) refresh(ctx context.Context, done chan struct{}) {
	models, err := o.fetch(ctx)
	o.mu.Lock()
	switch {
	case err == nil:
		o.at, o.models, o.err = o.Now(), models, nil
	case o.models != nil:
		o.err = nil
	default:
		o.err = err
	}
	o.inflight = nil
	o.mu.Unlock()
	close(done)
}

// fetch is listModels: GET BASE/models, each entry with a string id.
func (o *OpenRouter) fetch(ctx context.Context) ([]jsjson.Value, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", o.Base()+"/models", nil)
	if err != nil {
		return nil, errors.New("fetch failed")
	}
	req.Header.Set("accept", "application/json")
	res, err := o.Client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, errors.New("The operation was aborted due to timeout")
		}
		return nil, errors.New("fetch failed")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("OpenRouter answered HTTP %d for its models", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	// A body that isn't JSON reads as {}: no models.
	parsed, _ := jsjson.Parse(body)
	data, _ := get(parsed, "data").([]jsjson.Value)
	out := []jsjson.Value{}
	for _, m := range data {
		id, ok := get(m, "id").(string)
		if !ok {
			continue
		}
		name := id
		if n, ok := get(m, "name").(string); ok && n != "" {
			name = n
		}
		pricing := get(m, "pricing")
		out = append(out, jsjson.NewObject("id", id, "name", name, "in", perMillion(get(pricing, "prompt")), "out", perMillion(get(pricing, "completion"))))
	}
	return out, nil
}

// get is v[key] for an object, else nil (TS's optional chaining).
func get(v jsjson.Value, key string) jsjson.Value {
	o, _ := v.(*jsjson.Object)
	x, _ := o.Get(key)
	return x
}

// perMillion is src/llm/openrouter.ts perMillion: a price in USD per token as USD per million, rounded to six places;
// null when it is missing, empty, or not a non-negative number.
func perMillion(v jsjson.Value) jsjson.Value {
	if v == nil || v == "" {
		return nil
	}
	n := jsjson.ToNumber(v)
	if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
		return nil
	}
	f, _ := strconv.ParseFloat(jsjson.ToFixed(n*1e6, 6), 64)
	return f
}

// HarnessModels is src/model-catalog.ts harnessModels: the registry's models that run on harness (every one when it is
// ""), named and priced from the registry where it can.
func HarnessModels(registry *jsjson.Object, harness string) []jsjson.Value {
	models, _ := get(registry, "models").(*jsjson.Object)
	out := []jsjson.Value{}
	for _, id := range models.Keys() {
		m, _ := models.Get(id)
		if harness != "" && !runsOn(get(m, "harnesses"), harness) {
			continue
		}
		name := id
		if n, ok := get(m, "name").(string); ok && n != "" {
			name = n
		}
		price := get(get(registry, "prices"), id)
		out = append(out, jsjson.NewObject("id", id, "name", name, "in", get(price, "input"), "out", get(price, "output")))
	}
	return out
}

// runsOn is `!m.harnesses || m.harnesses.includes(harness)`: no list means every harness; a string list is searched
// as a substring, as String#includes does.
func runsOn(list jsjson.Value, harness string) bool {
	switch l := list.(type) {
	case []jsjson.Value:
		for _, h := range l {
			if h == harness {
				return true
			}
		}
		return false
	case string:
		return l == "" || strings.Contains(l, harness)
	}
	return !jsjson.Truthy(list)
}

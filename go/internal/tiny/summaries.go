package tiny

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"stam/internal/catalog"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/llm"
)

// Tool-call summaries (src/tool-summaries.ts, S-1481): the conversation view shows each tool call as two short fields,
// the tool in plain English and what the agent is doing. Each call is summarised once and stored by agent, call id and a
// hash of its name and input, so a request naming a call with another input neither reads nor fixes its summary. A
// stored summary carries the hash of the model and prompt it was asked with (S-1843): shown with another hash, or none,
// it shows at once and is asked again.

const (
	summaryPurpose = "tool-summary"
	callTimeout    = 15 * time.Second
	laneConc       = 3
	laneMax        = 60
	// BatchMax is how many calls one request may name; IDChars how long an id or a name may be; WaitMax the longest
	// wait.
	BatchMax   = 40
	IDChars    = 200
	inputChars = 2000
	WaitMax    = 10 * time.Second
	toolWords  = 3
	toolChars  = 40
	doingChars = 160
)

// summaryFields are TOOL_SUMMARY_FIELDS: the schema's field descriptions.
var summaryFields = struct{ tool, doing string }{"the tool in plain English, 1-3 words", "what the agent is doing, one short sentence of at most 12 words"}

// ToolCall is one call the view shows. HasInput tells an input of null from none (callText reads them apart).
type ToolCall struct {
	ID, Name string
	Input    jsjson.Value
	HasInput bool
}

type summaryConfig struct {
	enabled             bool
	model, instructions string
	maxWords            int
}

// on is the step on with its toggle and a model; an empty model turns it off (S-1843).
func (c summaryConfig) on() bool { return c.enabled && c.model != "" }

func (s *Steps) summaryConfig() summaryConfig {
	set := s.o.Settings()
	t := set.Tiny.ToolSummary
	return summaryConfig{t.Enabled, t.Model, catalog.ToolSummaryPrompt(set), catalog.ToolSummaryMaxWords}
}

type summaries struct {
	s    *Steps
	lane *lane
	mu   sync.Mutex
	// failed holds the calls whose answer failed or was refused, with the config they were asked with; a restart or a
	// switch of model or prompt asks them again.
	failed map[string]bool
}

func newSummaries(s *Steps) *summaries {
	return &summaries{s: s, lane: newLane(laneConc, laneMax, func() bool { return s.summaryConfig().on() }), failed: map[string]bool{}}
}

func (m *summaries) isFailed(key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.failed[key]
}

func (m *summaries) fail(key string) {
	m.mu.Lock()
	m.failed[key] = true
	m.mu.Unlock()
}

func failedAt(key, cfg string) string { return key + "\x00" + cfg }

// CallHash is callHash: the sha256 of a call's name and input, which a summary is stored for and read back by.
func CallHash(c ToolCall) string {
	in := "null"
	if c.HasInput {
		in = jsjson.Stringify(c.Input, "")
	}
	return sha(c.Name + "\x00" + in)
}

// ConfigHash is src/config-hash.ts configHash: the sha256 hex of the parts as a JSON list.
func ConfigHash(parts ...jsjson.Value) string { return sha(jsjson.Stringify(parts, "")) }

// ToolSummaries is toolSummaries: the summaries for a batch of an agent's calls, in priority order (the first is asked
// first). Stored ones come back at once; missing and stale ones are queued ahead of older batches, and the answer waits up
// to waitFor (at most WaitMax) for them. A call still unanswered then is pending; one that failed is in neither, nor is one that can't be
// asked now (no key, or the system budget spent).
func (s *Steps) ToolSummaries(ctx context.Context, agent string, calls []ToolCall, waitFor time.Duration) (*jsjson.Object, error) {
	m := s.sums
	c := s.summaryConfig()
	on := c.on()
	cfg := ConfigHash(c.model, c.instructions, c.maxWords)
	out := jsjson.NewObject()
	canAsk := on && s.askBlocked(c.model) == ""
	type asked struct {
		j    *job
		call ToolCall
		hash string
		key  string
	}
	var batch []asked
	seen := map[string]bool{}
	for _, call := range calls[:min(len(calls), BatchMax)] {
		if seen[call.ID] {
			continue
		}
		seen[call.ID] = true
		hash := CallHash(call)
		stored, found, err := s.storedSummary(ctx, agent, call.ID, hash)
		if err != nil {
			return nil, err
		}
		key := agent + "\x00" + call.ID + "\x00" + hash
		if found {
			out.Set(call.ID, shown(stored))
			// A stored summary with another model or prompt hash (or none) is stale: it shows until the new one lands.
			if !canAsk || (stored.ConfigHash != nil && *stored.ConfigHash == cfg) {
				continue
			}
		}
		if canAsk && !m.isFailed(failedAt(key, cfg)) {
			j := m.lane.get(key, func() func(context.Context) {
				return func(ctx context.Context) { m.summarize(ctx, agent, call, hash, key, c, cfg) }
			})
			batch = append(batch, asked{j, call, hash, key})
		}
	}
	jobs := make([]*job, len(batch))
	for i, a := range batch {
		jobs[i] = a.j
	}
	m.lane.promote(jobs)
	if waitFor > 0 && len(jobs) > 0 {
		wctx, cancel := context.WithTimeout(ctx, min(waitFor, WaitMax))
		wait(wctx, jobs)
		cancel()
	}
	pending := []jsjson.Value{}
	// A call dropped off the queue (or by the step turning off) is still pending: the next request queues it again. A
	// stale one stays pending until its new summary lands.
	for _, a := range batch {
		stored, found, err := s.storedSummary(ctx, agent, a.call.ID, a.hash)
		if err != nil {
			return nil, err
		}
		if found {
			out.Set(a.call.ID, shown(stored))
			if stored.ConfigHash != nil && *stored.ConfigHash == cfg {
				continue
			}
		}
		if !m.isFailed(failedAt(a.key, cfg)) {
			pending = append(pending, a.call.ID)
		}
	}
	return jsjson.NewObject("enabled", on, "summaries", out, "pending", pending), nil
}

func (s *Steps) storedSummary(ctx context.Context, agent, id, hash string) (db.ToolSummary, bool, error) {
	got, err := s.o.Store.ToolSummary(ctx, agent, id, hash)
	if errors.Is(err, db.ErrNotFound) {
		return got, false, nil
	}
	return got, err == nil, err
}

func shown(t db.ToolSummary) *jsjson.Object {
	return jsjson.NewObject("tool", t.Tool, "doing", t.Doing)
}

func (m *summaries) summarize(ctx context.Context, agent string, call ToolCall, hash, key string, c summaryConfig, cfg string) {
	s := m.s
	// A spent system budget or no key for the model's provider: nothing is asked, and not remembered as failed, so a
	// fixed key or a new budget window summarises the call on a later request.
	if s.askBlocked(c.model) != "" {
		return
	}
	zero := 0.0
	schema := jsjson.NewObject("type", "object",
		"properties", jsjson.NewObject("tool", jsjson.NewObject("type", "string", "description", summaryFields.tool), "doing", jsjson.NewObject("type", "string", "description", summaryFields.doing)),
		"required", []jsjson.Value{"tool", "doing"}, "additionalProperties", false)
	r, err := s.o.LLM.Complete(ctx, llm.Request{
		Model:       c.model,
		Messages:    []llm.Message{{Role: "system", Content: c.instructions}, {Role: "user", Content: CallText(call)}},
		JSONSchema:  &llm.JSONSchema{Name: "tool_summary", Schema: schema},
		MaxTokens:   80,
		Temperature: &zero,
		Timeout:     callTimeout,
	})
	if err != nil {
		// A canceled call was turned off, not failed; it is asked again once the step is back on.
		canceled := ctx.Err() != nil
		typ := "tool-summary:error"
		if canceled {
			typ = "tool-summary:canceled"
		} else {
			m.fail(failedAt(key, cfg))
		}
		s.event(ctx, typ, struct {
			Agent string `json:"agent"`
			Call  string `json:"call"`
			Error string `json:"error"`
		}{agent, call.ID, err.Error()})
		return
	}
	p, _ := s.o.LLM.ParseModelRef(c.model)
	to := spendFor(p)
	model := served(to, r.Model)
	s.recordSpend(ctx, summaryPurpose, model, r, to)
	sum, ok := ParseToolSummary(r.Text, c.maxWords)
	if !ok {
		m.fail(failedAt(key, cfg))
		s.event(ctx, "tool-summary:refused", struct {
			Agent string `json:"agent"`
			Call  string `json:"call"`
		}{agent, call.ID})
		return
	}
	if err := s.o.Store.SetToolSummary(context.WithoutCancel(ctx), agent, call.ID, hash, sum.Tool, sum.Doing, model, cfg); err != nil {
		s.event(ctx, "tool-summary:error", struct {
			Agent string `json:"agent"`
			Call  string `json:"call"`
			Error string `json:"error"`
		}{agent, call.ID, "the summary was not stored"})
	}
}

// QueuedCalls is the calls waiting in the queue, first asked first, for tests: each key's call id.
func (s *Steps) QueuedCalls() []string {
	keys := s.sums.lane.queued()
	for i, k := range keys {
		keys[i] = strings.SplitN(k, "\x00", 3)[1]
	}
	return keys
}

// CallText is callText: the tool name and its input, cut to 2000 UTF-16 code units.
func CallText(c ToolCall) string {
	in := ""
	if c.HasInput {
		if str, ok := c.Input.(string); ok {
			in = str
		} else {
			in = jsjson.Stringify(c.Input, "")
		}
	}
	return "Tool: " + c.Name + "\nInput: " + jsSlice(in, inputChars)
}

// jsLen is a string's .length: its UTF-16 code units.
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

// jsSlice is .slice(0, n) in UTF-16 code units. A cut through a surrogate pair drops the pair's first half, which Go
// can't hold on its own (TS keeps it as a lone surrogate).
func jsSlice(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

// jsSpace is JavaScript's \s: Go's RE2 \s is ASCII only. jsSpaceSet is its members, to put in another class.
const (
	jsSpaceSet = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`
	jsSpace    = `[` + jsSpaceSet + `]`
)

var (
	fence  = regexp.MustCompile("^```(?:json)?" + jsSpace + "*((?s:.)*?)" + jsSpace + "*```$")
	spaces = regexp.MustCompile(jsSpace + "+")
)

// unfence is raw.trim() with a ```json fence around it taken off, and the answer parsed as a JSON object (not a list).
func unfence(raw *string) (*jsjson.Object, bool) {
	if raw == nil {
		return nil, false
	}
	text := fence.ReplaceAllString(jsjson.Trim(*raw), "$1")
	v, err := jsjson.Parse([]byte(text))
	o, ok := v.(*jsjson.Object)
	return o, err == nil && ok
}

// squeeze is .replace(/\s+/g, ' ').trim().
func squeeze(s string) string { return jsjson.Trim(spaces.ReplaceAllString(s, " ")) }

// words is s.split(' ').filter(Boolean).length.
func words(s string) int {
	n := 0
	for _, w := range strings.Split(s, " ") {
		if w != "" {
			n++
		}
	}
	return n
}

// Summary is a parsed tool summary.
type Summary struct{ Tool, Doing string }

// ParseToolSummary is parseToolSummary: a JSON object (a ```json fence around it is allowed) with both fields as text,
// tool at most three words and doing at most maxWords. False otherwise.
func ParseToolSummary(raw *string, maxWords int) (Summary, bool) {
	o, ok := unfence(raw)
	if !ok {
		return Summary{}, false
	}
	tv, _ := o.Get("tool")
	dv, _ := o.Get("doing")
	t, ok1 := tv.(string)
	d, ok2 := dv.(string)
	if !ok1 || !ok2 {
		return Summary{}, false
	}
	t, d = squeeze(t), squeeze(d)
	if t == "" || d == "" || words(t) > toolWords || words(d) > maxWords || jsLen(t) > toolChars || jsLen(d) > doingChars {
		return Summary{}, false
	}
	return Summary{t, d}, true
}

// ReadCalls is readCalls: a request's calls, each with an id and a name, both short text.
func ReadCalls(raw jsjson.Value) ([]ToolCall, error) {
	list, ok := raw.([]jsjson.Value)
	if !ok {
		return nil, errors.New("calls must be a list")
	}
	out := make([]ToolCall, len(list))
	for i, v := range list {
		o, _ := v.(*jsjson.Object)
		id, _ := get(o, "id").(string)
		name, _ := get(o, "name").(string)
		if o == nil || id == "" || jsLen(id) > IDChars || name == "" || jsLen(name) > IDChars {
			return nil, errors.New("each call needs an id and a name")
		}
		in, has := o.Get("input")
		out[i] = ToolCall{ID: id, Name: name, Input: in, HasInput: has}
	}
	return out, nil
}

func get(o *jsjson.Object, key string) jsjson.Value {
	if o == nil {
		return nil
	}
	v, _ := o.Get(key)
	return v
}

package tiny

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"stam/internal/catalog"
	"stam/internal/jsjson"
	"stam/internal/llm"
)

// Tool names (src/tool-names.ts, S-1933): the conversation view names a tool call by one stored label per tool, from
// the seeded built-ins or, for any other tool, a tiny model asked once and stored by harness and tool name for ever.
// Every answer, good, partial or empty, ends in a stored label or a failure remembered until a restart, never a retry.

const (
	namePurpose = "tool-name"
	// NamesMax is how many names one request may give; NameChars how long one may be.
	NamesMax   = 40
	NameChars  = 200
	labelChars = 30
)

type names struct {
	s    *Steps
	lane *lane
	mu   sync.Mutex
	// failed holds the tools whose answer failed or was refused since this process started.
	failed map[string]bool
}

func newNames(s *Steps) *names {
	return &names{s: s, lane: newLane(laneConc, laneMax, func() bool { return s.nameModel() != "" }), failed: map[string]bool{}}
}

// nameModel is the model the step asks, "" while the step is off (its toggle in Settings › Tiny models).
func (s *Steps) nameModel() string {
	t := s.o.Settings().Tiny.ToolNames
	if !t.Enabled {
		return ""
	}
	return t.Model
}

func (n *names) isFailed(key string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.failed[key]
}

func (n *names) fail(key string) {
	n.mu.Lock()
	n.failed[key] = true
	n.mu.Unlock()
}

// ToolNames is toolNames: the label for each of an agent's tools (raw names, the first asked first). Seeded and stored
// labels come back at once; a missing one is queued and the answer waits up to waitFor (at most WaitMax) for it. A tool
// still unnamed then is pending; one that failed is in neither, so the view shows its prettified name.
func (s *Steps) ToolNames(ctx context.Context, harness string, raw []string, waitFor time.Duration) (*jsjson.Object, error) {
	n := s.names
	m := s.nameModel()
	enabled := m != "" && s.askBlocked(m) == ""
	labels := jsjson.NewObject()
	var jobs []*job
	seenTool := map[string]bool{}
	raw = raw[:min(len(raw), NamesMax)]
	for _, name := range raw {
		_, tool := SplitTool(name, harness)
		have := SeededLabel(harness, tool)
		if have == "" {
			var err error
			if have, err = s.o.Store.ToolName(ctx, harness, tool); err != nil {
				return nil, err
			}
		}
		if have != "" {
			labels.Set(name, have)
			continue
		}
		key := harness + "\x00" + tool
		if !enabled || seenTool[tool] || n.isFailed(key) {
			continue
		}
		seenTool[tool] = true
		jobs = append(jobs, n.lane.get(key, func() func(context.Context) {
			return func(ctx context.Context) { n.name(ctx, harness, tool, key, m) }
		}))
	}
	n.lane.promote(jobs)
	if waitFor > 0 && len(jobs) > 0 {
		wctx, cancel := context.WithTimeout(ctx, min(waitFor, WaitMax))
		wait(wctx, jobs)
		cancel()
	}
	pending := []jsjson.Value{}
	for _, name := range raw {
		if v, _ := labels.Get(name); v != nil && v != "" {
			continue
		}
		_, tool := SplitTool(name, harness)
		stored, err := s.o.Store.ToolName(ctx, harness, tool)
		if err != nil {
			return nil, err
		}
		if stored != "" {
			labels.Set(name, stored)
		} else if enabled && !n.isFailed(harness+"\x00"+tool) {
			pending = append(pending, name)
		}
	}
	return jsjson.NewObject("enabled", enabled, "labels", labels, "pending", pending), nil
}

func (n *names) name(ctx context.Context, harness, tool, key, model string) {
	s := n.s
	// A spent system budget or no key: nothing is asked, and not remembered as failed.
	if s.askBlocked(model) != "" {
		return
	}
	zero := 0.0
	schema := jsjson.NewObject("type", "object",
		"properties", jsjson.NewObject("label", jsjson.NewObject("type", "string", "description", "the tool in plain English, 1-3 words")),
		"required", []jsjson.Value{"label"}, "additionalProperties", false)
	r, err := s.o.LLM.Complete(ctx, llm.Request{
		Model:       model,
		Messages:    []llm.Message{{Role: "system", Content: catalog.ToolNameInstructions}, {Role: "user", Content: "Tool: " + tool}},
		JSONSchema:  &llm.JSONSchema{Name: "tool_name", Schema: schema},
		MaxTokens:   30,
		Temperature: &zero,
		Timeout:     callTimeout,
	})
	if err != nil {
		// A canceled call was turned off, not failed; it is asked again once a model is back.
		typ := "tool-name:canceled"
		if ctx.Err() == nil {
			typ = "tool-name:error"
			n.fail(key)
		}
		s.event(ctx, typ, struct {
			Harness string `json:"harness"`
			Tool    string `json:"tool"`
			Error   string `json:"error"`
		}{harness, tool, err.Error()})
		return
	}
	p, _ := s.o.LLM.ParseModelRef(model)
	to := spendFor(p)
	used := served(to, r.Model)
	s.recordSpend(ctx, namePurpose, used, r, to)
	label, ok := ParseToolLabel(r.Text)
	if !ok {
		n.fail(key)
		s.event(ctx, "tool-name:refused", struct {
			Harness string `json:"harness"`
			Tool    string `json:"tool"`
		}{harness, tool})
		return
	}
	if err := s.o.Store.SetToolName(context.WithoutCancel(ctx), harness, tool, label, used); err != nil {
		s.event(ctx, "tool-name:error", struct {
			Harness string `json:"harness"`
			Tool    string `json:"tool"`
			Error   string `json:"error"`
		}{harness, tool, "the label was not stored"})
	}
}

// QueuedTools is the tools waiting in the queue, first asked first, for tests.
func (s *Steps) QueuedTools() []string {
	keys := s.names.lane.queued()
	for i, k := range keys {
		_, keys[i], _ = strings.Cut(k, "\x00")
	}
	return keys
}

// ParseToolLabel is parseToolLabel: a JSON object (a ```json fence around it is allowed) with a label of at most three
// words and 30 characters. False for anything else.
func ParseToolLabel(raw *string) (string, bool) {
	o, ok := unfence(raw)
	if !ok {
		return "", false
	}
	v, _ := o.Get("label")
	l, ok := v.(string)
	if !ok {
		return "", false
	}
	l = squeeze(l)
	if l == "" || words(l) > catalog.ToolNameMaxWords || jsLen(l) > labelChars {
		return "", false
	}
	return l, true
}

// ReadNames is readNames: a request's tool names, each short text.
func ReadNames(raw jsjson.Value) ([]string, error) {
	list, ok := raw.([]jsjson.Value)
	if !ok {
		return nil, errors.New("names must be a list")
	}
	out := make([]string, len(list))
	for i, v := range list {
		s, ok := v.(string)
		if !ok || s == "" || jsLen(s) > NameChars {
			return nil, errors.New("each name must be text, at most 200 characters")
		}
		out[i] = s
	}
	return out, nil
}

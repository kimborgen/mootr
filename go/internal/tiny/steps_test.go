package tiny

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/llm"
)

// store is an in-memory Store with src/db.ts's write rules.
type store struct {
	mu     sync.Mutex
	sums   map[string]db.ToolSummary
	names  map[string]string
	blocks map[string][2]string
	mail   map[string]*mailRow
	// readHook runs in MailTitleRow once the row is read, outside the lock, for a test that pauses a request there.
	readHook func(id string)
	events   []string
	spend    []string
}

func (s *store) AddEvent(_ context.Context, agent, typ string, data any) error {
	b, _ := json.Marshal(data)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, typ+" "+string(b))
	return nil
}

func (s *store) RecordSpend(_ context.Context, purpose, provider, account string, cost float64, in, out int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.spend = append(s.spend, fmt.Sprintf("%s %s %s", purpose, provider, account))
	return nil
}

func (s *store) AddExactPending(context.Context, float64) error { return nil }

func (s *store) ToolSummary(_ context.Context, agent, id, hash string) (db.ToolSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	got, ok := s.sums[agent+"|"+id+"|"+hash]
	if !ok {
		return got, db.ErrNotFound
	}
	return got, nil
}

func (s *store) SetToolSummary(_ context.Context, agent, id, hash, tool, doing, model, cfg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := agent + "|" + id + "|" + hash
	if old, ok := s.sums[k]; ok && old.ConfigHash != nil && *old.ConfigHash == cfg {
		return nil
	}
	s.sums[k] = db.ToolSummary{Tool: tool, Doing: doing, ConfigHash: &cfg}
	return nil
}

func (s *store) ToolName(_ context.Context, harness, name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.names[harness+"|"+name], nil
}

func (s *store) SetToolName(_ context.Context, harness, name, label, model string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.names[harness+"|"+name]; !ok {
		s.names[harness+"|"+name] = label
	}
	return nil
}

func (s *store) BlockSummary(_ context.Context, hash string) (string, *string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.blocks[hash]
	if !ok {
		return "", nil, db.ErrNotFound
	}
	return b[0], &b[1], nil
}

func (s *store) SetBlockSummary(_ context.Context, hash, summary, model, cfg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.blocks[hash] = [2]string{summary, cfg}
	return nil
}

func (s *store) count(prefix string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, e := range s.events {
		if strings.HasPrefix(e, prefix) {
			n++
		}
	}
	return n
}

// fx is the steps over the real stub endpoint the TS tests use (test/decide-stub.mjs) and an in-memory store.
type fx struct {
	t     *testing.T
	steps *Steps
	st    *store
	dir   string
	set   atomic.Pointer[config.Settings]
	mu    sync.Mutex
	env   map[string]string
}

func newFx(t *testing.T) *fx {
	f := &fx{t: t, dir: t.TempDir(), st: &store{sums: map[string]db.ToolSummary{}, names: map[string]string{}, blocks: map[string][2]string{}}}
	cmd := exec.Command("node", "../../../test/decide-stub.mjs", f.dir)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	var u string
	for i := 0; i < 500 && u == ""; i++ {
		if b, err := os.ReadFile(filepath.Join(f.dir, "url")); err == nil {
			u = strings.TrimSpace(string(b))
		}
		time.Sleep(10 * time.Millisecond)
	}
	if u == "" {
		t.Fatal("the stub did not start")
	}
	f.env = map[string]string{"OPENROUTER_API_KEY": "test-key", "STAM_OPENROUTER_URL": u}
	f.settings(`{"tiny":{"toolSummary":{"enabled":true}},"instructions":{"summaries":{"model":"m"}}}`)
	get := func() config.Settings { return *f.set.Load() }
	layer := llm.New(llm.Options{Settings: get, Home: t.TempDir(), Getenv: func(k string) string {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.env[k]
	}})
	f.steps = New(Options{LLM: layer, Settings: get, Store: f.st})
	return f
}

// settings replaces the settings and tells the steps, as a write through stam does.
func (f *fx) settings(text string) {
	s, err := config.ParseSettings([]byte(text), "m")
	if err != nil {
		f.t.Fatal(err)
	}
	f.set.Store(&s)
	if f.steps != nil {
		f.steps.Refresh()
	}
}

func (f *fx) setEnv(k, v string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.env[k] = v
}

// calls is the stub's count of chat calls.
func (f *fx) calls() int {
	b, _ := os.ReadFile(filepath.Join(f.dir, "titles"))
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}

func (f *fx) hang() { must(f.t, os.WriteFile(filepath.Join(f.dir, "hang"), nil, 0o644)) }

func (f *fx) release() {
	_ = os.Remove(filepath.Join(f.dir, "hang"))
	must(f.t, os.WriteFile(filepath.Join(f.dir, "release"), nil, 0o644))
}

func (f *fx) until(what string, fn func() bool) {
	f.t.Helper()
	for i := 0; i < 500; i++ {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.t.Fatalf("timed out waiting for %s", what)
}

func (f *fx) sums(agent string, wait time.Duration, calls ...ToolCall) string {
	f.t.Helper()
	got, err := f.steps.ToolSummaries(context.Background(), agent, calls, wait)
	if err != nil {
		f.t.Fatal(err)
	}
	return jsjson.Stringify(got, "")
}

func (f *fx) stored(agent string, c ToolCall) (db.ToolSummary, bool) {
	got, err := f.st.ToolSummary(context.Background(), agent, c.ID, CallHash(c))
	return got, err == nil
}

func call(id, name string, input ...jsjson.Value) ToolCall {
	c := ToolCall{ID: id, Name: name}
	if len(input) > 0 {
		c.Input, c.HasInput = input[0], true
	}
	return c
}

func cmdInput(command string) jsjson.Value { return jsjson.NewObject("command", command) }

// seededAnswer is a call whose input carries the stub's answer.
func seededAnswer(id, answer string) ToolCall {
	return call(id, "Bash", cmdInput("echo TOOLSUM="+strings.ReplaceAll(url.QueryEscape(answer), "+", "%20")))
}

const stubRead = `{"tool":"stub Read","doing":"doing the stub work of Read"}`

// TestToolSummaries: src/tool-summaries.ts against the stub, as test/tool-summaries.test.mjs runs it: a miss is asked
// once and stored, a hit makes no call, the same call asked twice at once is asked once, the cost lands under
// openrouter-system, and a summary is read back only for the input it was made from.
func TestToolSummaries(t *testing.T) {
	f := newFx(t)
	read := call("toolu_1", "Read", jsjson.NewObject("file_path", "/a.ts"))
	if got := f.sums("ag-1", 5*time.Second, read); got != `{"enabled":true,"summaries":{"toolu_1":`+stubRead+`},"pending":[]}` {
		t.Errorf("a miss: %s", got)
	}
	if f.calls() != 1 || f.sums("ag-1", 0, read) != `{"enabled":true,"summaries":{"toolu_1":`+stubRead+`},"pending":[]}` || f.calls() != 1 {
		t.Errorf("a hit made a call: %d", f.calls())
	}
	// Keyed by agent too.
	if got := f.sums("ag-2", 5*time.Second, read); !strings.Contains(got, "stub Read") || f.calls() != 2 {
		t.Errorf("another agent: %s %d", got, f.calls())
	}
	if !slices.Contains(f.st.spend, "tool-summary openrouter openrouter-system") || f.st.count(`decide {"purpose":"tool-summary"`) != 2 {
		t.Errorf("the spend: %v %v", f.st.spend, f.st.events)
	}
	// No wait: pending, then stored.
	grep := call("nowait", "Grep")
	if got := f.sums("ag-1", 0, grep); got != `{"enabled":true,"summaries":{},"pending":["nowait"]}` {
		t.Errorf("no wait: %s", got)
	}
	f.until("the summary stored", func() bool { _, ok := f.stored("ag-1", grep); return ok })
	// Twice at once: one call.
	before := f.calls()
	edit := call("twice", "Edit")
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if got := f.sums("ag-1", 5*time.Second, edit, edit); !strings.Contains(got, "stub Edit") {
				t.Errorf("twice: %s", got)
			}
		}()
	}
	wg.Wait()
	if f.calls() != before+1 {
		t.Errorf("one call asked twice at once made %d calls", f.calls()-before)
	}
	// Read back only for its input.
	forged := seededAnswer("poison", `{"tool":"forged","doing":"a forged summary"}`)
	real := call("poison", "Bash", cmdInput("ls"))
	if !strings.Contains(f.sums("ag-p", 5*time.Second, forged), `"forged"`) || !strings.Contains(f.sums("ag-p", 5*time.Second, real), "stub Bash") || !strings.Contains(f.sums("ag-p", 0, forged), `"forged"`) {
		t.Error("a summary was read back for another input")
	}
}

// TestToolSummariesStale: with the step off stored summaries show and nothing is asked (a blank model reads as the
// default, in TS's settings too, so only the toggle turns it off); a stale summary (another
// config, or none) shows at once, is asked once and replaced; a stale one whose new answer fails keeps showing.
func TestToolSummariesStale(t *testing.T) {
	f := newFx(t)
	ctx := context.Background()
	stale := call("off-stored", "Bash")
	must(t, f.st.SetToolSummary(ctx, "ag-off", stale.ID, CallHash(stale), "run command", "listing files", "m", "any-hash"))
	f.settings(`{"tiny":{"toolSummary":{"enabled":false}}}`)
	want := `{"enabled":false,"summaries":{"off-stored":{"tool":"run command","doing":"listing files"}},"pending":[]}`
	if got := f.sums("ag-off", 500*time.Millisecond, stale, call("off-new", "Bash")); got != want {
		t.Errorf("off: %s", got)
	}
	if f.calls() != 0 {
		t.Errorf("off made %d calls", f.calls())
	}
	f.settings(`{"tiny":{"toolSummary":{"enabled":true}}}`)
	c := call("stale", "Read", jsjson.NewObject("file_path", "/stale.ts"))
	must(t, f.st.SetToolSummary(ctx, "ag-s", c.ID, CallHash(c), "old tool", "old doing", "m", "old-config"))
	nohash := call("nohash", "Read", jsjson.NewObject("file_path", "/nohash.ts"))
	f.st.sums["ag-s|nohash|"+CallHash(nohash)] = db.ToolSummary{Tool: "bare tool", Doing: "bare doing"}
	if got := f.sums("ag-s", 0, c, nohash); got != `{"enabled":true,"summaries":{"stale":{"tool":"old tool","doing":"old doing"},"nohash":{"tool":"bare tool","doing":"bare doing"}},"pending":["stale","nohash"]}` {
		t.Errorf("stale: %s", got)
	}
	f.until("both replaced", func() bool {
		a, _ := f.stored("ag-s", c)
		b, _ := f.stored("ag-s", nohash)
		return a.Tool == "stub Read" && b.Tool == "stub Read"
	})
	if got := f.sums("ag-s", 0, c, nohash); got != `{"enabled":true,"summaries":{"stale":`+stubRead+`,"nohash":`+stubRead+`},"pending":[]}` || f.calls() != 2 {
		t.Errorf("current: %s %d", got, f.calls())
	}
	fail := call("stale-fail", "Bash", cmdInput("STUB:FAIL"))
	must(t, f.st.SetToolSummary(ctx, "ag-sf", fail.ID, CallHash(fail), "kept tool", "kept doing", "m", "old-config"))
	if got := f.sums("ag-sf", 0, fail); got != `{"enabled":true,"summaries":{"stale-fail":{"tool":"kept tool","doing":"kept doing"}},"pending":["stale-fail"]}` {
		t.Errorf("stale, failing: %s", got)
	}
	f.until("the regeneration to fail", func() bool { return f.st.count(`tool-summary:error {"agent":"ag-sf"`) == 1 })
	if got := f.sums("ag-sf", 0, fail); got != `{"enabled":true,"summaries":{"stale-fail":{"tool":"kept tool","doing":"kept doing"}},"pending":[]}` || f.calls() != 3 {
		t.Errorf("after the failure: %s %d", got, f.calls())
	}
}

// TestToolSummariesQueue: bad answers store nothing and aren't asked again; a wait that runs out lists the call as
// pending; a newer batch goes ahead of an older one; calls dropped off a full queue come back pending and are queued
// again; turning the step off drops the queue (still pending) and cancels calls in flight, asked again once it is on.
func TestToolSummariesQueue(t *testing.T) {
	f := newFx(t)
	bad := []ToolCall{seededAnswer("notjson", "run command"), seededAnswer("nofield", `{"tool":"run"}`), seededAnswer("toolong", `{"tool":"run","doing":"`+strings.Repeat("w ", 20)+`"}`)}
	if got := f.sums("ag-1", 5*time.Second, bad...); got != `{"enabled":true,"summaries":{},"pending":[]}` || f.calls() != 3 || f.st.count("tool-summary:refused") != 3 {
		t.Errorf("bad answers: %s %d", got, f.calls())
	}
	f.sums("ag-1", 500*time.Millisecond, bad...)
	if f.calls() != 3 {
		t.Error("a refused call was asked again")
	}

	// Three hung calls fill every slot.
	f.hang()
	hung := []ToolCall{call("h1", "Bash", cmdInput("STUB:HANG")), call("h2", "Bash", cmdInput("STUB:HANG")), call("h3", "Bash", cmdInput("STUB:HANG"))}
	f.sums("ag-q", 0, hung...)
	f.until("three calls in flight", func() bool { return f.calls() == 6 })
	if got := f.sums("ag-q", 50*time.Millisecond, hung[0]); got != `{"enabled":true,"summaries":{},"pending":["h1"]}` || f.calls() != 6 {
		t.Errorf("a wait that runs out: %s %d", got, f.calls())
	}
	f.sums("ag-q", 0, call("old1", "Old"), call("old2", "Old"))
	f.sums("ag-q", 0, call("new1", "New"), call("old2", "Old"))
	if got := f.steps.QueuedCalls(); !slices.Equal(got, []string{"new1", "old2", "old1"}) {
		t.Errorf("the queue: %v", got)
	}
	// Two batches of 35: the second goes first, and the first's last ten drop off the 60-call queue.
	var many []ToolCall
	for i := range 70 {
		many = append(many, call(fmt.Sprintf("q%d", i), "Bash"))
	}
	f.sums("ag-full", 0, many[:35]...)
	if got := f.sums("ag-full", 0, many[35:]...); strings.Count(got, `"q`) != 35 {
		t.Errorf("the second batch: %s", got)
	}
	queued := f.steps.QueuedCalls()
	if len(queued) != 60 || slices.Contains(queued, "q25") || slices.Contains(queued, "old1") {
		t.Errorf("the full queue: %d %v", len(queued), queued[50:])
	}
	if got := f.sums("ag-full", 0, many[25:35]...); !strings.Contains(got, `"pending":["q25","q26","q27","q28","q29","q30","q31","q32","q33","q34"]`) || !slices.Contains(f.steps.QueuedCalls(), "q25") {
		t.Errorf("the dropped calls, asked again: %s", got)
	}
	// Turned off: the queue drops (still pending) and the calls in flight are canceled.
	f.settings(`{"tiny":{"toolSummary":{"enabled":false}}}`)
	f.until("the hung calls canceled", func() bool { return f.st.count("tool-summary:canceled") == 3 })
	if len(f.steps.QueuedCalls()) != 0 {
		t.Errorf("the queue after the step was turned off: %v", f.steps.QueuedCalls())
	}
	f.release()
	f.settings(`{"tiny":{"toolSummary":{"enabled":true}}}`)
	if got := f.sums("ag-q", 5*time.Second, call("h1", "Bash", cmdInput("echo"))); !strings.Contains(got, "stub Bash") {
		t.Errorf("back on: %s", got)
	}
	if got := f.sums("ag-q", 0, hung[0]); got != `{"enabled":true,"summaries":{},"pending":["h1"]}` {
		t.Errorf("a canceled call isn't asked again: %s", got)
	}
}

// TestToolSummariesNoKey: with no OpenRouter key nothing is asked and nothing is failed, so a key fixes it.
func TestToolSummariesNoKey(t *testing.T) {
	f := newFx(t)
	f.setEnv("OPENROUTER_API_KEY", "")
	glob := call("nokey", "Glob")
	if got := f.sums("ag-1", 500*time.Millisecond, glob); got != `{"enabled":true,"summaries":{},"pending":[]}` || f.calls() != 0 {
		t.Errorf("no key: %s %d", got, f.calls())
	}
	f.setEnv("OPENROUTER_API_KEY", "test-key")
	if got := f.sums("ag-1", 5*time.Second, glob); !strings.Contains(got, "stub Glob") {
		t.Errorf("with a key: %s", got)
	}
}

// TestToolNames: src/tool-names.ts against the stub, as test/tool-names.test.mjs runs it: seeded built-ins need no
// model, an MCP tool is named by its tool part once for every agent of the harness, a bad answer is never retried, and
// with the step off seeded and stored labels still come back.
func TestToolNames(t *testing.T) {
	f := newFx(t)
	ctx := context.Background()
	names := func(harness string, wait time.Duration, raw ...string) string {
		t.Helper()
		got, err := f.steps.ToolNames(ctx, harness, raw, wait)
		if err != nil {
			t.Fatal(err)
		}
		return jsjson.Stringify(got, "")
	}
	if got := names("claude", 5*time.Second, "Bash", "mcp__stam__send_mail", "mcp__other__send_mail", "Bash"); got != `{"enabled":true,"labels":{"Bash":"Bash","mcp__stam__send_mail":"Stub send_mail","mcp__other__send_mail":"Stub send_mail"},"pending":[]}` || f.calls() != 1 {
		t.Errorf("claude: %s %d", got, f.calls())
	}
	if !slices.Contains(f.st.spend, "tool-name openrouter openrouter-system") {
		t.Errorf("the spend: %v", f.st.spend)
	}
	// Per harness: codex names the same tool `stam.send_mail`, its own label.
	if got := names("codex", 5*time.Second, "stam.send_mail", "exec_command"); got != `{"enabled":true,"labels":{"exec_command":"Bash","stam.send_mail":"Stub send_mail"},"pending":[]}` || f.calls() != 2 {
		t.Errorf("codex: %s %d", got, f.calls())
	}
	bad := "TOOLNAME=" + url.QueryEscape(`{"label":"one two three four"}`)
	if got := names("claude", 5*time.Second, bad); got != `{"enabled":true,"labels":{},"pending":[]}` || f.st.count("tool-name:refused") != 1 {
		t.Errorf("a bad answer: %s", got)
	}
	names("claude", 500*time.Millisecond, bad)
	if f.calls() != 3 {
		t.Errorf("a refused tool was asked again: %d calls", f.calls())
	}
	if got := names("opencode", 0, "webfetch_x"); got != `{"enabled":true,"labels":{},"pending":["webfetch_x"]}` {
		t.Errorf("no wait: %s", got)
	}
	f.until("the label stored", func() bool { l, _ := f.st.ToolName(ctx, "opencode", "webfetch_x"); return l != "" })
	f.settings(`{"tiny":{"toolNames":{"enabled":false}}}`)
	if got := names("claude", 500*time.Millisecond, "Read", "mcp__stam__send_mail", "mcp__stam__new_tool"); got != `{"enabled":false,"labels":{"Read":"Read","mcp__stam__send_mail":"Stub send_mail"},"pending":[]}` || f.calls() != 4 {
		t.Errorf("off: %s %d", got, f.calls())
	}
}

// TestBlockSummaries: src/block-summaries.ts against the stub, as test/block-summaries.test.mjs runs it: a miss is
// pending, then cached; a change of prompt asks again; with no model the stored summary still shows, and a missing one
// is off; a failed call is failed until the config changes.
func TestBlockSummaries(t *testing.T) {
	f := newFx(t)
	ctx := context.Background()
	text := "Keep it tidy."
	hash := TextHash(text)
	sum := func(text string) string {
		t.Helper()
		got, err := f.steps.BlockSummary(ctx, TextHash(text), text, "")
		if err != nil {
			t.Fatal(err)
		}
		return jsjson.Stringify(got, "")
	}
	if got := sum(text); got != `{"state":"pending"}` {
		t.Errorf("a miss: %s", got)
	}
	f.until("the summary cached", func() bool { _, _, err := f.st.BlockSummary(ctx, hash); return err == nil })
	if got := sum(text); got != `{"summary":"Stub mail title words.","state":"auto"}` || f.calls() != 1 {
		t.Errorf("a hit: %s %d", got, f.calls())
	}
	if !slices.Contains(f.st.spend, "block-summary openrouter openrouter-system") {
		t.Errorf("the spend: %v", f.st.spend)
	}
	f.settings(`{"instructions":{"summaries":{"model":"m"}},"tiny":{"blockSummaries":{"instructions":"Mine."}}}`)
	if got := sum(text); got != `{"state":"pending"}` {
		t.Errorf("a new prompt: %s", got)
	}
	f.until("asked again", func() bool { return f.calls() == 2 })
	f.settings(`{}`)
	if got := sum(text); !strings.Contains(got, `"state":"auto"`) {
		t.Errorf("off, stored: %s", got)
	}
	if got := sum("Other."); got != `{"state":"off"}` {
		t.Errorf("off, missing: %s", got)
	}
	f.settings(`{"instructions":{"summaries":{"model":"m"}}}`)
	if got := sum("STUB:FAIL"); got != `{"state":"pending"}` {
		t.Errorf("a failing block: %s", got)
	}
	f.until("the call to fail", func() bool { return f.st.count("block-summary:error") == 1 })
	if got := sum("STUB:FAIL"); got != `{"state":"failed"}` {
		t.Errorf("failed: %s", got)
	}
}

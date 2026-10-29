package instructions

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf16"

	"stam/internal/db"
	"stam/internal/search"
)

// Lessons from similar work against TS (testdata/lessonsref.mjs on the same home, with the stub embedder): taskText,
// lessonsFor's items and scores, renderLessons and lessonsPrompt with its retro:lessons event, over retro items in open,
// done and closed-as-not-a-lesson statuses, bodies with header lines and long details, summaries with trailing
// punctuation, and settings with k clamped, k not an integer, and lessons off.

type lessonHit struct {
	Key   string  `json:"key"`
	Score float64 `json:"score"`
}

type lessonsAgent struct {
	Task     string          `json:"task"`
	Hits     []lessonHit     `json:"hits"`
	Rendered string          `json:"rendered"`
	Prompt   string          `json:"prompt"`
	Event    json.RawMessage `json:"event"`
}

func stubEmbedding(ref, text string) db.Embedding {
	v := search.StubVector(text)
	b := make([]byte, 4*len(v))
	for i, f := range v {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(f))
	}
	return db.Embedding{Source: "itsa", Ref: ref, Model: search.StubModel, Dim: len(v), Vec: b, Hash: search.HashOf(text)}
}

func TestLessonsMatchTS(t *testing.T) {
	for _, c := range []struct{ name, settings string }{
		{"default", `{}`},
		{"k-two", `{"retro":{"lessons":{"k":2}}}`},
		{"k-clamped", `{"retro":{"lessons":{"k":20}}}`},
		{"k-not-integer", `{"retro":{"lessons":{"k":2.5}}}`},
		{"off", `{"retro":{"lessons":{"enabled":false}}}`},
	} {
		t.Run(c.name, func(t *testing.T) { runLessons(t, c.name, c.settings) })
	}
}

func runLessons(t *testing.T, name, settings string) {
	h := newTestHome(t, settings)
	h.p.Index = search.New(h.db, func() search.Provider { return search.Stub })
	at := "2026-01-01T00:00:00Z"
	h.sql("INSERT INTO itsas (id, key, kind, title, status, created_by, created_at, updated_at) VALUES ('rp', 'S-100', 'retros', 'Retros', 'in_progress', 'human', ?, ?)", at, at)
	long := strings.Repeat("deploy watcher details keep going ", 12)
	items := []struct{ id, key, title, summary, body, status, text string }{
		{"r1", "S-101", "Deploy flake", "Deploy watcher flakes on restart.", "Kind: improve\nTarget: deploy\n\n" + long + "\nsecond line\nthird line", "idea", "deploy watcher restart flake"},
		{"r2", "S-102", "Go parity tests", "", "Kind: went_well\n\nParity tests against TS caught a wrong prompt.", "done", "go parity tests prompt ts"},
		{"r3", "S-103", "Bad idea", "Prompt parity was a waste;", "", "wont_do", "go parity prompt waste"},
		{"r4", "S-104", "Shell chaining", "  Run one   shell command\nper call:  ", "Kind: instruction\nTarget: brief\n", "todo", "shell command chaining dialog"},
		{"r5", "S-105", "Unrelated", "Phone layout at 360 px", "Body text", "idea", "phone layout css"},
		{"r6", "S-106", "Prompt tokens", "Prompt tokens add up", "", "in_progress", "go prompt parity tokens"},
		{"r7", "S-107", "Dup", "A duplicate parity lesson", "", "duplicate", "go parity prompt tokens"},
		{"r8", "S-108", "Canceled", "A canceled parity lesson", "", "canceled", "go parity prompt tokens"},
	}
	// Long eligible lessons near one task, so the block meets its 1200-character cap before k.
	for i := range 6 {
		items = append(items, struct{ id, key, title, summary, body, status, text string }{
			fmt.Sprintf("b%d", i), fmt.Sprintf("S-12%d", i), "Budget", strings.Repeat("Token budget lesson summary words ", 3) + fmt.Sprint(i),
			"Kind: idea\n\n" + strings.Repeat("budget detail text runs long ", 10), "idea", fmt.Sprintf("token budget lesson %d", i)})
	}
	var embs []db.Embedding
	for _, x := range items {
		h.sql("INSERT INTO itsas (id, key, parent_id, kind, title, summary, body, status, created_by, created_at, updated_at) VALUES (?, ?, 'rp', 'retro', ?, ?, ?, ?, 'human', ?, ?)",
			x.id, x.key, x.title, nullable(x.summary), nullable(x.body), x.status, at, at)
		embs = append(embs, stubEmbedding(x.id, x.text))
	}
	// A lesson whose score is exactly the 0.25 floor: the task "floorword" embeds to one word, and this vector holds that
	// word plus 15 others, each 1, so the cosine is 1/4 with no rounding in either language.
	h.sql("INSERT INTO itsas (id, key, parent_id, kind, title, summary, status, created_by, created_at, updated_at) VALUES ('rf', 'S-130', 'rp', 'retro', 'Floor', 'At the floor', 'idea', 'human', ?, ?)", at, at)
	embs = append(embs, floorEmbedding(t, "rf", "floorword"))
	// A retro item outside Retros is never a lesson.
	h.sql("INSERT INTO itsas (id, key, kind, title, status, created_by, created_at, updated_at) VALUES ('r9', 'S-109', 'retro', 'Stray go parity prompt', 'idea', 'human', ?, ?)", at, at)
	embs = append(embs, stubEmbedding("r9", "go parity prompt"))
	if err := h.db.PutEmbeddings(h.ctx, embs); err != nil {
		t.Fatal(err)
	}
	agents := []struct {
		id   string
		cols map[string]any
	}{
		{"dev", map[string]any{"type": "developer", "role": "Port the Go prompt parity tests", "first_prompt": "Port the system prompt parts to Go with parity tests against TS."}},
		{"ops", map[string]any{"role": "deploy", "first_prompt": "The deploy watcher flakes after a restart; fix the flake."}},
		{"none", map[string]any{"role": "", "first_prompt": "zzz qqq"}},
		{"blank", map[string]any{"role": "   "}},
		{"budget", map[string]any{"role": "token budget lesson"}},
		{"floor", map[string]any{"role": "floorword"}},
		// The task cap (1500 UTF-16 units) falls inside an astral character, and the matching words come after it.
		{"longtask", map[string]any{"role": strings.Repeat("r", 1498), "first_prompt": "\U0001F600 deploy watcher restart flake"}},
	}
	got := map[string]lessonsAgent{}
	for _, a := range agents {
		row := h.agent(a.id, a.cols)
		g := lessonsAgent{Task: TaskText(row)}
		hits := h.p.LessonsFor(h.ctx, g.Task, h.p.Settings().RetroLessons.K)
		g.Hits = []lessonHit{}
		for _, x := range hits {
			g.Hits = append(g.Hits, lessonHit{x.Key, x.Score})
		}
		var err error
		if g.Rendered, err = h.p.RenderLessons(hits); err != nil {
			t.Fatal(err)
		}
		g.Prompt = h.p.LessonsPrompt(h.ctx, row)
		if ev, ok := lastEvent(t, h, a.id); ok {
			g.Event = ev
		}
		got[a.id] = g
	}
	var want struct {
		Agents map[string]lessonsAgent `json:"agents"`
	}
	ids := []string{}
	for _, a := range agents {
		ids = append(ids, a.id)
	}
	h.ts("testdata/lessonsref.mjs", map[string]any{"agents": ids}, &want)
	for _, id := range ids {
		g, w := got[id], want.Agents[id]
		if len(g.Hits) != len(w.Hits) {
			t.Errorf("%s hits: go %v, ts %v", id, g.Hits, w.Hits)
		} else {
			for i := range g.Hits {
				if g.Hits[i].Key != w.Hits[i].Key || math.Abs(g.Hits[i].Score-w.Hits[i].Score) > 1e-9 {
					t.Errorf("%s hit %d: go %v, ts %v", id, i, g.Hits[i], w.Hits[i])
				}
			}
		}
		if g.Task != w.Task || g.Rendered != w.Rendered || g.Prompt != w.Prompt {
			t.Errorf("%s:\n--- go\ntask %q\n%s\n%s\n--- ts\ntask %q\n%s\n%s", id, g.Task, g.Rendered, g.Prompt, w.Task, w.Rendered, w.Prompt)
		}
		if !jsonEqual(g.Event, w.Event) {
			t.Errorf("%s event: go %s, ts %s", id, g.Event, w.Event)
		}
	}
	if name == "default" && (len(got["dev"].Hits) < 2 || !strings.Contains(got["ops"].Rendered, "S-101")) {
		t.Errorf("the fixture finds too few lessons: %+v", got)
	}
	if name != "off" {
		// The branches the fixture is for: the block cap, the exact floor, the task cap, and the closed statuses.
		if b := got["budget"]; len(b.Hits) >= 4 && strings.Count(b.Rendered, "- S-12") >= len(b.Hits) || name == "default" && len(b.Hits) < 4 {
			t.Errorf("budget: the block cap isn't met (%d hits):\n%s", len(b.Hits), b.Rendered)
		}
		if f := got["floor"].Hits; len(f) != 1 || f[0].Key != "S-130" || f[0].Score != lessonFloor {
			t.Errorf("floor: hits %v, want S-130 at exactly %v", f, lessonFloor)
		}
		if l := got["longtask"]; len(l.Hits) != 0 || utf16Len(l.Task) != taskChars {
			t.Errorf("longtask: the task cap doesn't hold (%d units, hits %v)", utf16Len(l.Task), l.Hits)
		}
		for _, a := range got {
			for _, x := range a.Hits {
				if x.Key == "S-103" || x.Key == "S-107" || x.Key == "S-108" {
					t.Errorf("a closed retro item %s is a lesson", x.Key)
				}
			}
		}
	}
}

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// floorEmbedding is a vector for ref holding word's stub index and 15 other indices, each 1: its cosine with word's
// stub vector is exactly 0.25.
func floorEmbedding(t *testing.T, ref, word string) db.Embedding {
	t.Helper()
	q := search.StubVector(word)
	at := -1
	for i, x := range q {
		if x != 0 {
			if at >= 0 {
				t.Fatalf("%q embeds to more than one index", word)
			}
			at = i
		}
	}
	v := make([]float32, len(q))
	v[at] = 1
	for i, n := 0, 0; n < 15; i++ {
		if i != at {
			v[i], n = 1, n+1
		}
	}
	b := make([]byte, 4*len(v))
	for i, f := range v {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(f))
	}
	return db.Embedding{Source: "itsa", Ref: ref, Model: search.StubModel, Dim: len(v), Vec: b, Hash: search.HashOf(word)}
}

// lastEvent is the agent's latest retro:lessons event data, without its ms.
func lastEvent(t *testing.T, h *testHome, id string) (json.RawMessage, bool) {
	t.Helper()
	evs, err := h.db.ListEvents(h.ctx, id, 1, "retro:lessons")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range evs {
		if e.Data == nil {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(*e.Data), &m); err != nil {
			t.Fatal(err)
		}
		delete(m, "ms")
		b, _ := json.Marshal(m)
		return b, true
	}
	return json.RawMessage("null"), false
}

func jsonEqual(a, b json.RawMessage) bool {
	var x, y any
	if len(a) == 0 {
		a = json.RawMessage("null")
	}
	if len(b) == 0 {
		b = json.RawMessage("null")
	}
	return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && reflect.DeepEqual(x, y)
}

// gateIndex is an embedder each Embed call of which hands the test its own release channel and waits for it to close,
// and that counts Nearest calls.
type gateIndex struct {
	Embedder
	entered chan chan struct{}
	nearest *atomic.Int32
}

func newGateIndex(inner Embedder) gateIndex {
	return gateIndex{inner, make(chan chan struct{}, 8), &atomic.Int32{}}
}

func (g gateIndex) Embed(texts []string) [][]float32 {
	release := make(chan struct{})
	g.entered <- release
	<-release
	return g.Embedder.Embed(texts)
}

func (g gateIndex) Nearest(ctx context.Context, src string, q []float32, refs map[string]bool, k int, minScore float64) ([]search.Near, error) {
	g.nearest.Add(1)
	return g.Embedder.Nearest(ctx, src, q, refs, k, minScore)
}

// lessonsHome is a home with one retro item and one agent whose task finds it, and a gated embedder.
func lessonsHome(t *testing.T) (*testHome, gateIndex, db.Agent) {
	h := newTestHome(t, `{}`)
	g := newGateIndex(search.New(h.db, func() search.Provider { return search.Stub }))
	h.p.Index = g
	seedLesson(h)
	return h, g, h.agent("a1", map[string]any{"role": "go parity"})
}

// seedLesson adds Retros (S-1) and one retro item under it, S-2 "go parity", with its stub vector.
func seedLesson(h *testHome) {
	h.t.Helper()
	at := "2026-01-01T00:00:00Z"
	h.sql("INSERT INTO itsas (id, key, kind, title, status, created_by, created_at, updated_at) VALUES ('rp', 'S-1', 'retros', 'Retros', 'in_progress', 'human', ?, ?)", at, at)
	h.sql("INSERT INTO itsas (id, key, parent_id, kind, title, status, created_by, created_at, updated_at) VALUES ('r1', 'S-2', 'rp', 'retro', 'go parity', 'idea', 'human', ?, ?)", at, at)
	if err := h.db.PutEmbeddings(h.ctx, []db.Embedding{stubEmbedding("r1", "go parity")}); err != nil {
		h.t.Fatal(err)
	}
}

// An embedder slower than the timeout gives no lessons and a timedOut event, and the cache keeps the empty block, so a
// read doesn't compute it again, until it is forgotten.
func TestLessonsTimeout(t *testing.T) {
	h, g, a := lessonsHome(t)
	h.p.LessonsTimeout = 20 * time.Millisecond
	exited := make(chan struct{}, 1)
	orig := lessonsWorkerDone
	lessonsWorkerDone = func() { exited <- struct{}{} }
	t.Cleanup(func() { lessonsWorkerDone = orig })
	if _, ok := h.p.CachedLessons("a1"); ok {
		t.Fatal("cached before warm")
	}
	if text := h.p.WarmLessons(context.Background(), a); text != "" {
		t.Errorf("a timed-out warm gave %q", text)
	}
	ev, _ := lastEvent(t, h, "a1")
	if !jsonEqual(ev, json.RawMessage(`{"items":[],"timedOut":true}`)) {
		t.Errorf("timed-out event: %s", ev)
	}
	// The worker may have given up before it embedded (its database read saw the deadline) or be held in Embed.
	select {
	case release := <-g.entered:
		close(release)
		<-exited
	case <-exited:
	}
	if n := g.nearest.Load(); n != 0 {
		t.Errorf("Nearest ran %d times after the caller gave up", n)
	}
	if text, ok := h.p.CachedLessons("a1"); !ok || text != "" {
		t.Errorf("cache after warm: %q %v", text, ok)
	}
	h.p.ForgetLessons("a1")
	if _, ok := h.p.CachedLessons("a1"); ok {
		t.Error("cached after forget")
	}
}

// A caller that gives up while the embedder runs: once the embedder returns, the worker exits without searching, so
// nothing fills the index after the caller is gone.
func TestLessonsNoSearchAfterGivingUp(t *testing.T) {
	h, g, a := lessonsHome(t)
	h.p.LessonsTimeout = time.Minute
	exited := make(chan struct{}, 1)
	orig := lessonsWorkerDone
	lessonsWorkerDone = func() { exited <- struct{}{} }
	t.Cleanup(func() { lessonsWorkerDone = orig })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan string, 1)
	go func() { done <- h.p.LessonsPrompt(ctx, a) }()
	release := <-g.entered
	cancel()
	if text := <-done; text != "" {
		t.Errorf("a prompt whose caller gave up: %q", text)
	}
	close(release)
	select {
	case <-exited:
	case <-time.After(10 * time.Second):
		t.Fatal("the worker didn't exit after the embedder returned")
	}
	if n := g.nearest.Load(); n != 0 {
		t.Errorf("Nearest ran %d times after the caller gave up", n)
	}
	if ev, _ := lastEvent(t, h, "a1"); !jsonEqual(ev, json.RawMessage(`{"items":[],"timedOut":true}`)) {
		t.Errorf("event: %s", ev)
	}
}

// A warm that ends after ForgetLessons (the agent was archived) doesn't put the agent back in the cache.
func TestLessonsWarmAfterForget(t *testing.T) {
	h, g, a := lessonsHome(t)
	h.p.LessonsTimeout = time.Minute
	done := make(chan string, 1)
	go func() { done <- h.p.WarmLessons(context.Background(), a) }()
	release := <-g.entered
	h.p.ForgetLessons("a1")
	close(release)
	if text := <-done; !strings.Contains(text, "S-2") {
		t.Errorf("the warm's own result: %q", text)
	}
	if text, ok := h.p.CachedLessons("a1"); ok {
		t.Errorf("a warm that ended after forget was kept: %q", text)
	}
}

// Of two overlapping warms, the one started later is kept, whichever ends first: each Embed has its own release, so
// the order the warms end in is the test's.
func TestLessonsOverlappingWarms(t *testing.T) {
	for _, laterFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "later ends first", false: "earlier ends first"}[laterFirst], func(t *testing.T) {
			h, g, a := lessonsHome(t)
			h.p.LessonsTimeout = time.Minute
			first := make(chan string, 1)
			go func() { first <- h.p.WarmLessons(context.Background(), a) }()
			releaseFirst := <-g.entered
			// The later warm's task finds nothing, so the two blocks differ.
			h.sql("UPDATE agents SET role = 'zzz qqq' WHERE id = 'a1'")
			b, err := h.db.GetAgent(h.ctx, "a1")
			if err != nil {
				t.Fatal(err)
			}
			second := make(chan string, 1)
			go func() { second <- h.p.WarmLessons(context.Background(), b) }()
			releaseSecond := <-g.entered
			var one, two string
			if laterFirst {
				close(releaseSecond)
				two = <-second
				close(releaseFirst)
				one = <-first
			} else {
				close(releaseFirst)
				one = <-first
				close(releaseSecond)
				two = <-second
			}
			if !strings.Contains(one, "S-2") || two != "" {
				t.Fatalf("the warms' own results: %q, %q", one, two)
			}
			if text, ok := h.p.CachedLessons("a1"); !ok || text != "" {
				t.Errorf("cache after overlapping warms: %q %v, want the later warm's empty block", text, ok)
			}
		})
	}
}

// A warm that starts while ForgetLessons runs takes its ticket after the forget's delete, so its block is kept.
func TestLessonsWarmDuringForget(t *testing.T) {
	h, _, a := lessonsHome(t)
	h.p.Index = search.New(h.db, func() search.Provider { return search.Stub })
	h.p.LessonsTimeout = time.Minute
	warmed := make(chan string, 1)
	orig := forgetHook
	forgetHook = func() {
		forgetHook = func() {}
		// The forget holds the cache lock here, so the warm takes its ticket after the delete. The lock is probed
		// before the warm starts, so only the forget can hold it. A forget that dropped the lock between its ticket
		// and its delete fails here, and the warm then finishes first, so the delete drops its block and the checks
		// below fail too.
		unlocked := h.p.lessons.mu.TryLock()
		if unlocked {
			h.p.lessons.mu.Unlock()
		}
		go func() { warmed <- h.p.WarmLessons(context.Background(), a) }()
		if unlocked {
			t.Error("the forget doesn't hold the cache lock between its ticket and its delete")
			text := <-warmed
			warmed <- text
		}
	}
	t.Cleanup(func() { forgetHook = orig })
	h.p.ForgetLessons("a1")
	if text := <-warmed; !strings.Contains(text, "S-2") {
		t.Fatalf("the warm's result: %q", text)
	}
	if text, ok := h.p.CachedLessons("a1"); !ok || !strings.Contains(text, "S-2") {
		t.Errorf("the warm that started during the forget wasn't kept: %q %v", text, ok)
	}
}

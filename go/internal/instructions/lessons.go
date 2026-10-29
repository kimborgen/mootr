package instructions

import (
	"context"
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/search"
)

// Lessons from similar work (src/retro-lessons.ts and src/retro.ts lessonsFor and renderLessons, S-725): the retro items
// nearest an agent's task by meaning, for the system prompt and the prompt after a compaction. A slow or missing
// embedder gives none: an agent never waits on lessons longer than LessonsTimeout.

// Embedder is the part of the search index lessons use (search.Index).
type Embedder interface {
	Embed(texts []string) [][]float32
	Nearest(ctx context.Context, src string, q []float32, refs map[string]bool, k int, minScore float64) ([]search.Near, error)
}

const (
	// LessonsTimeout is src/retro-lessons.ts LESSONS_TIMEOUT_MS: the longest a spawn waits for its lessons.
	LessonsTimeout = 1500 * time.Millisecond
	// taskChars caps the task text, in UTF-16 code units (the embedder reads about 250 tokens).
	taskChars        = 1500
	lessonMaxChars   = 1200
	lessonDetailMax  = 200
	lessonFloor      = 0.25
	retroParentKind  = "retros"
	retroParentTitle = "Retros"
	retroKind        = "retro"
)

// lessonStatusesOut are src/retro.ts LESSON_STATUSES_OUT: retro items closed as not lessons.
var lessonStatusesOut = map[string]bool{"duplicate": true, "wont_do": true, "canceled": true}

// Lesson is a retro item near the task, with its score.
type Lesson struct {
	db.LessonItem
	Score float64
}

// lessonCache is src/retro-lessons.ts cache: the block last computed per agent. gen is each agent's ticket count: a warm
// takes a ticket when it starts and keeps its block only if no later warm or forget took one since, so a warm that ends
// after the agent was forgotten (archived) can't put it back, and of two overlapping warms the later-started one wins.
type lessonCache struct {
	mu  sync.Mutex
	m   map[string]string
	gen map[string]uint64
}

// ticket takes the agent's next ticket.
func (c *lessonCache) ticket(id string) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ticketLocked(id)
}

// ticketLocked is ticket with c.mu held.
func (c *lessonCache) ticketLocked(id string) uint64 {
	if c.gen == nil {
		c.gen = map[string]uint64{}
	}
	c.gen[id]++
	return c.gen[id]
}

// lessonsWorkerDone runs when a LessonsPrompt worker returns; a test swaps it to see the worker exit.
var lessonsWorkerDone = func() {}

// forgetHook runs inside ForgetLessons' critical section, between its ticket and its delete; a test swaps it.
var forgetHook = func() {}

// TaskText is src/retro-lessons.ts taskText: the type, role and first prompt, capped.
func TaskText(a db.Agent) string {
	var parts []string
	for _, s := range []string{deref(a.Type), a.Role, deref(a.FirstPrompt)} {
		if s != "" {
			parts = append(parts, s)
		}
	}
	return jsPrefix(strings.Join(parts, "\n"), taskChars)
}

// LessonsFor is src/retro.ts lessonsFor: the k open (or done) retro items nearest text, at or above the floor, best
// first. Nothing when the embedder is down or fails.
func (p *Prompts) LessonsFor(ctx context.Context, text string, k int) []Lesson {
	q := squeeze(text)
	if q == "" || k < 1 || p.Index == nil {
		return nil
	}
	all, err := p.DB.LessonItems(ctx, retroParentKind, retroParentTitle, retroKind)
	if err != nil {
		return nil
	}
	items := map[string]db.LessonItem{}
	for _, x := range all {
		if !lessonStatusesOut[x.Status] {
			items[x.ID] = x
		}
	}
	if len(items) == 0 {
		return nil
	}
	vecs := p.Index.Embed([]string{q})
	// The caller may have given up while the embedder ran (LessonsPrompt's timeout): then nothing more runs, so a late
	// worker neither searches nor fills the index's cache.
	if len(vecs) == 0 || ctx.Err() != nil {
		return nil
	}
	refs := map[string]bool{}
	for id := range items {
		refs[id] = true
	}
	near, err := p.Index.Nearest(ctx, "itsa", vecs[0], refs, -1, math.Inf(-1))
	if err != nil {
		return nil
	}
	var out []Lesson
	for _, n := range near {
		if x, ok := items[n.Ref]; ok && n.Score >= lessonFloor {
			out = append(out, Lesson{x, n.Score})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > k {
		out = out[:k]
	}
	return out
}

// headerLines are a retro body's header lines (Kind, Target, Reporter, On), with JavaScript's . (no line terminator).
var headerLines = regexp.MustCompile("^(?:[A-Z][A-Za-z]*: [^\n\r  ]*\n)+\n?")

// trailingPunct is /[.:;]+$/.
var trailingPunct = regexp.MustCompile(`[.:;]+$`)

// RenderLessons is src/retro.ts renderLessons: one line per lesson (key, summary and the first lines of its details),
// the whole under 1200 characters, in the lessons template; "" when there are none.
func (p *Prompts) RenderLessons(lessons []Lesson) (string, error) {
	var lines []string
	used := 0
	for _, x := range lessons {
		details := jsjson.Trim(headerLines.ReplaceAllString(x.Body, ""))
		var first []string
		for _, l := range strings.Split(details, "\n") {
			if l != "" && len(first) < 2 {
				first = append(first, l)
			}
		}
		d := strings.Join(first, " ")
		if jsLen(d) > lessonDetailMax {
			d = jsjson.TrimEnd(jsPrefix(d, lessonDetailMax)) + "…"
		}
		line := "- " + x.Key + " " + trailingPunct.ReplaceAllString(squeeze(x.Summary), "")
		if d != "" {
			line += ": " + d
		}
		n := jsLen(line)
		if len(lines) > 0 && used+n > lessonMaxChars {
			break
		}
		lines = append(lines, jsPrefix(line, lessonMaxChars))
		used += n
	}
	if len(lines) == 0 {
		return "", nil
	}
	return p.Templates.Render("lessons", map[string]string{"items": strings.Join(lines, "\n")}, "")
}

// LessonsPrompt is src/retro-lessons.ts lessonsPrompt: the agent's lessons block, "" when lessons are off, nothing is
// similar, or the embedder is down or slower than LessonsTimeout. It records a retro:lessons event with the items, the
// time taken, and timedOut when it gave up waiting.
func (p *Prompts) LessonsPrompt(ctx context.Context, a db.Agent) string {
	s := p.Settings().RetroLessons
	if !s.Enabled {
		return ""
	}
	t0 := time.Now()
	timeout := p.LessonsTimeout
	if timeout == 0 {
		timeout = LessonsTimeout
	}
	wctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	done := make(chan []Lesson, 1)
	go func() {
		defer lessonsWorkerDone()
		done <- p.LessonsFor(wctx, TaskText(a), s.K)
	}()
	var hits []Lesson
	timedOut := false
	select {
	case hits = <-done:
	case <-wctx.Done():
		timedOut = true
	}
	text := ""
	if !timedOut {
		var err error
		if text, err = p.RenderLessons(hits); err != nil {
			return ""
		}
	}
	keys := []jsjson.Value{}
	for _, h := range hits {
		keys = append(keys, h.Key)
	}
	data := jsjson.NewObject("items", keys, "ms", float64(time.Since(t0).Milliseconds()))
	if timedOut {
		data.Set("timedOut", true)
	}
	// The event is recorded even when the caller gave up.
	_ = p.DB.AddEvent(context.WithoutCancel(ctx), a.ID, "retro:lessons", json.RawMessage(jsjson.Stringify(data, "")))
	return text
}

// WarmLessons is src/retro-lessons.ts warmLessons: the agent's lessons block, computed now and kept for CachedLessons.
// A warm that a later warm or ForgetLessons overtook returns its block but doesn't keep it.
func (p *Prompts) WarmLessons(ctx context.Context, a db.Agent) string {
	t := p.lessons.ticket(a.ID)
	text := p.LessonsPrompt(ctx, a)
	p.lessons.mu.Lock()
	defer p.lessons.mu.Unlock()
	if p.lessons.gen[a.ID] != t {
		return text
	}
	if p.lessons.m == nil {
		p.lessons.m = map[string]string{}
	}
	p.lessons.m[a.ID] = text
	return text
}

// CachedLessons is src/retro-lessons.ts cachedLessons: the block last computed for the agent; ok false when none was,
// so an agent whose block is empty isn't recomputed on every read.
func (p *Prompts) CachedLessons(id string) (string, bool) {
	p.lessons.mu.Lock()
	defer p.lessons.mu.Unlock()
	text, ok := p.lessons.m[id]
	return text, ok
}

// ForgetLessons is src/retro-lessons.ts forgetLessons: drops the agent's cached block (it was archived), and takes a
// ticket so a warm still running doesn't keep its block.
// Both happen in one critical section, so a warm that starts during the forget takes its ticket after the delete and
// keeps its block.
func (p *Prompts) ForgetLessons(id string) {
	p.lessons.mu.Lock()
	defer p.lessons.mu.Unlock()
	p.lessons.ticketLocked(id)
	forgetHook()
	delete(p.lessons.m, id)
}

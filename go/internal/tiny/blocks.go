package tiny

import (
	"context"
	"errors"
	"regexp"
	"sync"

	"stam/internal/catalog"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/llm"
)

// Block summaries (src/block-summaries.ts, S-878): a short, automatic summary of an instruction text block, cached by
// the sha256 of its text and the model and prompt it was asked with (S-1684). A caller is never blocked or delayed: a
// miss is queued and shows as pending. With no model set nothing is asked (state off); a failure is remembered in memory
// only, so a restart tries the block again.

const (
	blockPurpose = "block-summary"
	blockConc    = 2
	blockMax     = 100
	blockText    = 4000
	blockChars   = 200
)

type blockJob struct {
	hash, text, title, model, prompt, config string
}

type blocks struct {
	s       *Steps
	mu      sync.Mutex
	queue   []*blockJob
	asked   map[string]bool
	running map[*blockJob]context.CancelFunc
	// failed holds each failed block's config: a change of model or prompt asks it again.
	failed map[string]string
	// skipped counts blocks dropped because the queue was full, logged as one event once the queue drains.
	skipped int
}

func newBlocks(s *Steps) *blocks {
	return &blocks{s: s, asked: map[string]bool{}, running: map[*blockJob]context.CancelFunc{}, failed: map[string]string{}}
}

// blockModel is instructions.summaries.model, "" when off.
func (s *Steps) blockModel() string { return s.o.Settings().Tiny.BlockSummariesModel }

// blockPrompt is summaryPrompt: the human's override, or the shipped one when blank.
func (s *Steps) blockPrompt() string {
	if own := s.o.Settings().Tiny.BlockSummaryInstructions; jsjson.Trim(own) != "" {
		return own
	}
	return catalog.BlockSummaryPrompt
}

// TextHash is textHash: the sha256 hex a block is cached by.
func TextHash(text string) string { return sha(text) }

// BlockSummary is summaryFor: the cached summary of this block (state auto), or pending with the call queued, off with
// no model, or failed for a call that failed since this process started. hash is TextHash(text); title is the block's
// label, when it has one.
func (s *Steps) BlockSummary(ctx context.Context, hash, text, title string) (*jsjson.Object, error) {
	b := s.blocks
	m := s.blockModel()
	prompt := s.blockPrompt()
	config := ConfigHash(m, prompt)
	summary, asked, err := s.o.Store.BlockSummary(ctx, hash)
	if err != nil && !errors.Is(err, db.ErrNotFound) {
		return nil, err
	}
	// A summary asked with another model or prompt is a miss, so editing either asks again. With the model off, the
	// stored summary still shows.
	if err == nil && (m == "" || (asked != nil && *asked == config)) {
		return jsjson.NewObject("summary", summary, "state", "auto"), nil
	}
	if m == "" {
		return jsjson.NewObject("state", "off"), nil
	}
	b.mu.Lock()
	failed := b.failed[hash] == config && b.failed[hash] != ""
	b.mu.Unlock()
	if failed {
		return jsjson.NewObject("state", "failed"), nil
	}
	b.enqueue(&blockJob{hash: hash, text: text, title: title, model: m, prompt: prompt, config: config})
	return jsjson.NewObject("state", "pending"), nil
}

func (b *blocks) enqueue(j *blockJob) {
	b.mu.Lock()
	if b.asked[j.hash] {
		b.mu.Unlock()
		return
	}
	if len(b.queue) >= blockMax {
		b.skipped++
		b.mu.Unlock()
		return
	}
	b.asked[j.hash] = true
	b.queue = append(b.queue, j)
	b.mu.Unlock()
	// The calls start after the caller returns, so a caller is never held up by a model.
	go b.pump()
}

func (b *blocks) pump() {
	b.mu.Lock()
	for len(b.running) < blockConc && len(b.queue) > 0 && b.s.blockModel() != "" {
		j := b.queue[0]
		b.queue = b.queue[1:]
		ctx, cancel := context.WithCancel(context.Background())
		b.running[j] = cancel
		go func() {
			b.summarize(ctx, j)
			cancel()
			b.mu.Lock()
			delete(b.running, j)
			delete(b.asked, j.hash)
			b.mu.Unlock()
			b.pump()
		}()
	}
	flush := len(b.queue) == 0
	b.mu.Unlock()
	if flush {
		b.flushSkipped()
	}
}

func (b *blocks) flushSkipped() {
	b.mu.Lock()
	n := b.skipped
	b.skipped = 0
	b.mu.Unlock()
	if n > 0 {
		b.s.event(context.Background(), "block-summary:skipped", struct {
			Count  int    `json:"count"`
			Reason string `json:"reason"`
		}{n, "queue full"})
	}
}

// stop is the model turned off: nothing queued runs, and calls in flight stop.
func (b *blocks) stop() {
	b.mu.Lock()
	b.queue = nil
	b.asked = map[string]bool{}
	for _, cancel := range b.running {
		cancel()
	}
	b.mu.Unlock()
	b.flushSkipped()
}

func (b *blocks) setFailed(j *blockJob) {
	b.mu.Lock()
	b.failed[j.hash] = j.config
	b.mu.Unlock()
}

func (b *blocks) summarize(ctx context.Context, j *blockJob) {
	s := b.s
	if s.blockModel() == "" {
		return
	}
	// No key for the model's provider, or its system budget spent: nothing can be asked, so the block is failed, not
	// pending forever.
	if s.askBlocked(j.model) != "" {
		b.setFailed(j)
		return
	}
	user := jsSlice(j.text, blockText)
	if j.title != "" {
		user = "Block: " + j.title + "\n\n" + user
	}
	zero := 0.0
	r, err := s.o.LLM.Complete(ctx, llm.Request{
		Model:       j.model,
		Messages:    []llm.Message{{Role: "system", Content: j.prompt}, {Role: "user", Content: user}},
		MaxTokens:   120,
		Temperature: &zero,
		Timeout:     callTimeout,
	})
	if err != nil {
		// A canceled call was turned off, not failed; the block is asked again if the model returns.
		typ := "block-summary:canceled"
		if ctx.Err() == nil {
			typ = "block-summary:error"
			b.setFailed(j)
		}
		s.event(ctx, typ, struct {
			Hash  string `json:"hash"`
			Error string `json:"error"`
		}{j.hash, err.Error()})
		return
	}
	p, _ := s.o.LLM.ParseModelRef(j.model)
	to := spendFor(p)
	used := served(to, r.Model)
	s.recordSpend(ctx, blockPurpose, used, r, to)
	summary, ok := CleanSummary(r.Text)
	if !ok {
		b.setFailed(j)
		return
	}
	if err := s.o.Store.SetBlockSummary(context.WithoutCancel(ctx), j.hash, summary, used, j.config); err != nil {
		s.event(ctx, "block-summary:error", struct {
			Hash  string `json:"hash"`
			Error string `json:"error"`
		}{j.hash, "the summary was not stored"})
	}
}

var (
	marks = regexp.MustCompile("[*_`#]")
	label = regexp.MustCompile(`^` + jsSpace + `*(?i:summary|title)` + jsSpace + `*:` + jsSpace + `*`)
)

// CleanSummary is cleanSummary: one line, without Markdown marks, a "Summary:" label, or extra whitespace, cut to 200
// characters. False when nothing is left.
func CleanSummary(raw *string) (string, bool) {
	if raw == nil {
		return "", false
	}
	s := spaces.ReplaceAllString(marks.ReplaceAllString(*raw, ""), " ")
	s = jsjson.Trim(jsSlice(jsjson.Trim(label.ReplaceAllString(s, "")), blockChars))
	return s, s != ""
}

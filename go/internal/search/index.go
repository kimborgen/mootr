package search

import (
	"context"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"log/slog"
	"math"
	"sort"
	"sync"
	"time"

	"stam/internal/db"
)

// The embedding index of src/vectors.ts (S-141, S-3735): one table keyed by source, an indexing queue that embeds in
// batches off the request path, a backfill for items with no vector from the current embedder, and brute-force cosine
// search over one source. The queue holds refs, not text: each source's Resolve reads an item's text when its batch is
// embedded. A full queue drops new refs, and the backfill picks them up later. One goroutine (Run) does all of the
// indexing, so it stops with its context; a failure is logged and waits for a later backfill, never dropped silently.

// Provider is which embedder runs: "stub", "local" or "off" (src/embed.ts provider).
type Provider string

const (
	Stub  Provider = "stub"
	Local Provider = "local"
	Off   Provider = "off"
)

// ProviderOf is src/embed.ts provider: the environment's EMBEDDER (stub or off) wins over the setting.
func ProviderOf(env string, settingOff bool) Provider {
	switch env {
	case "stub":
		return Stub
	case "off":
		return Off
	}
	if settingOff {
		return Off
	}
	return Local
}

// Model is src/embed.ts currentModel: the model the provider writes vectors with, "" when search is off.
func (p Provider) Model() string {
	switch p {
	case Stub:
		return StubModel
	case Local:
		return LocalModel
	}
	return ""
}

// Batch is src/embed.ts BATCH: the items embedded per flush.
const Batch = 16

const (
	// pauseMin is the least pause between batches, so a backlog doesn't spike the CPU.
	pauseMin     = 200 * time.Millisecond
	backfillPage = 200
	// DefaultQueueCap is how many refs wait at most.
	DefaultQueueCap = 2000
)

// retrySchedule is the backfill's retries after a failed batch: 1, 5, then 15 minutes, then an hour between tries.
var retrySchedule = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour}

// Source is one kind of item the index holds. Resolve reads its text (ok false when the item is gone); Pending lists up
// to limit refs with no vector from model, or a stale one, newest first (nil for a source with no backfill).
type Source struct {
	Name    string
	Resolve func(ctx context.Context, ref string) (text string, ok bool, err error)
	Pending func(ctx context.Context, model string, limit int) ([]string, error)
}

// Index is the embedding index over a database.
type Index struct {
	db       *db.DB
	provider func() Provider
	sources  []Source
	// QueueCap is the queue's size; tests lower it to make it overflow.
	QueueCap int
	// RetrySchedule is the waits before the backfill after a failed batch; tests shorten it.
	RetrySchedule []time.Duration

	mu         sync.Mutex
	queue      []string
	queued     map[string]bool
	overflowed bool
	retries    int
	wake       chan struct{}
	backfillCh chan struct{}

	cacheMu sync.Mutex
	cache   map[string]*vectors

	warnOnce sync.Once
}

// vectors is a source's decoded vectors under one model, with each ref's place (src/db.ts decodedEmbeddingsOf).
type vectors struct {
	rows []decoded
	pos  map[string]int
}

type decoded struct {
	ref  string
	vec  []float32
	norm float64
}

// New makes an index; provider is read on every use, so a settings change takes effect at once.
func New(d *db.DB, provider func() Provider, sources ...Source) *Index {
	return &Index{db: d, provider: provider, sources: sources, QueueCap: DefaultQueueCap, RetrySchedule: retrySchedule, queued: map[string]bool{},
		wake: make(chan struct{}, 1), backfillCh: make(chan struct{}, 1), cache: map[string]*vectors{}}
}

// model is the model this index writes and reads vectors of: the stub's only. The local model runs only in the TS
// daemon, so with it nothing is queued here (TS would queue and retry until its install is done) and search is by keyword.
func (x *Index) model() string {
	if x.provider() == Stub {
		return StubModel
	}
	return ""
}

func key(src, ref string) string { return src + "\x00" + ref }

func splitKey(k string) (string, string) {
	for i := 0; i < len(k); i++ {
		if k[i] == 0 {
			return k[:i], k[i+1:]
		}
	}
	return k, ""
}

// HashOf is src/vectors.ts hashOf: the sha1 of the embedded text, hex.
func HashOf(text string) string {
	sum := sha1.Sum([]byte(text))
	return hex.EncodeToString(sum[:])
}

// Embed is src/embed.ts embed: vectors for texts, in order; nil when the provider is off or not ready. The local model
// runs only in the TS daemon (transformers.js), so here it is never ready and search falls back to keywords.
func (x *Index) Embed(texts []string) [][]float32 {
	switch x.provider() {
	case Stub:
		out := make([][]float32, len(texts))
		for i, t := range texts {
			out[i] = StubVector(t)
		}
		return out
	case Local:
		x.warnOnce.Do(func() {
			slog.Warn("embedder: the local model is not ported to the Go daemon; search by meaning falls back to keywords")
		})
	}
	return nil
}

// Enqueue is src/vectors.ts enqueue: queues an item for indexing; false when the queue is full (the backfill indexes it
// later). Nothing is queued while search is off.
func (x *Index) Enqueue(src, ref string) bool {
	if x.model() == "" {
		return true
	}
	k := key(src, ref)
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.queued[k] {
		return true
	}
	if len(x.queue) >= x.QueueCap {
		x.overflowed = true
		return false
	}
	x.queued[k] = true
	x.queue = append(x.queue, k)
	select {
	case x.wake <- struct{}{}:
	default:
	}
	return true
}

// IndexMail queues a stored mail; a new mail starts the backfill's retry schedule over.
func (x *Index) IndexMail(id string) {
	x.mu.Lock()
	x.retries = 0
	x.mu.Unlock()
	x.Enqueue("mail", id)
}

// Backfill asks the worker for a backfill.
func (x *Index) Backfill() {
	select {
	case x.backfillCh <- struct{}{}:
	default:
	}
}

// take removes up to n keys from the front of the queue.
func (x *Index) take(n int) []string {
	x.mu.Lock()
	defer x.mu.Unlock()
	n = min(n, len(x.queue))
	keys := append([]string(nil), x.queue[:n]...)
	x.queue = x.queue[n:]
	for _, k := range keys {
		delete(x.queued, k)
	}
	return keys
}

func (x *Index) clearQueue() {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.queue, x.queued = nil, map[string]bool{}
}

func (x *Index) queueLen() int {
	x.mu.Lock()
	defer x.mu.Unlock()
	return len(x.queue)
}

// Run is the indexing worker: a backfill at start (src/daemon.ts), then the queue as it fills, a backfill when asked,
// and the retries after a failure. It returns when ctx ends.
func (x *Index) Run(ctx context.Context) {
	var retry *time.Timer
	var retryC <-chan time.Time
	w := &worker{x: x, ctx: ctx, schedule: func() {
		if retry != nil {
			return
		}
		x.mu.Lock()
		wait := x.RetrySchedule[min(x.retries, len(x.RetrySchedule)-1)]
		x.retries++
		x.mu.Unlock()
		retry = time.NewTimer(wait)
		retryC = retry.C
	}}
	defer func() {
		if retry != nil {
			retry.Stop()
		}
	}()
	w.backfill()
	for {
		select {
		case <-ctx.Done():
			return
		case <-x.wake:
			w.drain()
		case <-x.backfillCh:
			w.backfill()
		case <-retryC:
			retry, retryC = nil, nil
			w.backfill()
		}
	}
}

// worker is the state of Run's goroutine.
type worker struct {
	x           *Index
	ctx         context.Context
	schedule    func()
	backfilling bool
}

func (w *worker) logErr(what string, err error) {
	if w.ctx.Err() == nil {
		slog.Error("embedder: " + what + ": " + err.Error())
	}
}

func (w *worker) sleep(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-w.ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// drain is src/vectors.ts drain: works the queue a batch at a time until it's empty. An embedder that isn't ready drops
// what's queued, and a retry backfills it later.
func (w *worker) drain() {
	x := w.x
	for w.ctx.Err() == nil {
		keys := x.take(Batch)
		if len(keys) == 0 {
			break
		}
		started := time.Now()
		embedded, err := w.flush(keys)
		took := time.Since(started)
		if err != nil {
			// A failed write (a full disk, say) drops this queue; the backfill retries it later.
			w.logErr("indexing", err)
			x.clearQueue()
			w.schedule()
			break
		}
		if embedded < 0 {
			x.clearQueue()
			w.schedule()
			break
		}
		if embedded > 0 {
			x.mu.Lock()
			x.retries = 0
			x.mu.Unlock()
		}
		// Pause only after work that loaded the CPU, for as long as the batch took (at least pauseMin).
		if x.queueLen() > 0 && embedded > 0 && !w.sleep(max(pauseMin, took)) {
			return
		}
	}
	x.mu.Lock()
	again := x.overflowed && len(x.queue) == 0
	if again {
		x.overflowed = false
	}
	x.mu.Unlock()
	if again && !w.backfilling {
		w.backfill()
	}
}

type job struct {
	src, ref, text, hash string
}

// flush is src/vectors.ts flush: embeds a batch and stores the vectors. It returns how many were embedded, or -1 when the
// embedder isn't ready.
func (w *worker) flush(keys []string) (int, error) {
	x := w.x
	model := x.model()
	if model == "" {
		return -1, nil
	}
	var todo []job
	for _, k := range keys {
		src, ref := splitKey(k)
		s := x.source(src)
		if s == nil {
			continue
		}
		text, ok, err := s.Resolve(w.ctx, ref)
		if err != nil {
			return 0, err
		}
		if !ok {
			continue
		}
		j := job{src, ref, text, HashOf(text)}
		// Text the index already has is skipped, and its vector marked current.
		hash, m, has, err := x.db.EmbeddingRow(w.ctx, src, ref)
		if err != nil {
			return 0, err
		}
		if has && hash == j.hash && m == model {
			if err := x.db.TouchEmbedding(w.ctx, src, ref); err != nil {
				return 0, err
			}
			continue
		}
		todo = append(todo, j)
	}
	if len(todo) == 0 {
		return 0, nil
	}
	texts := make([]string, len(todo))
	for i, j := range todo {
		texts[i] = j.text
	}
	vecs := x.Embed(texts)
	if vecs == nil {
		return -1, nil
	}
	// An item edited while its text was embedding is queued again; a deleted one is skipped.
	var rows []db.Embedding
	var fresh []decoded
	var freshSrc []string
	var stale []job
	for i, j := range todo {
		text, ok, err := x.source(j.src).Resolve(w.ctx, j.ref)
		if err != nil {
			return 0, err
		}
		if !ok {
			continue
		}
		if HashOf(text) != j.hash {
			stale = append(stale, j)
			continue
		}
		rows = append(rows, db.Embedding{Source: j.src, Ref: j.ref, Model: model, Dim: len(vecs[i]), Vec: encode(vecs[i]), Hash: j.hash})
		fresh = append(fresh, decoded{ref: j.ref, vec: vecs[i], norm: norm(vecs[i])})
		freshSrc = append(freshSrc, j.src)
	}
	if len(rows) > 0 {
		if err := x.db.PutEmbeddings(w.ctx, rows); err != nil {
			return 0, err
		}
		for i, d := range fresh {
			x.cachePut(freshSrc[i], model, d)
		}
	}
	for _, j := range stale {
		x.Enqueue(j.src, j.ref)
	}
	return len(rows), nil
}

func (x *Index) source(name string) *Source {
	for i := range x.sources {
		if x.sources[i].Name == name {
			return &x.sources[i]
		}
	}
	return nil
}

// backfill is src/vectors.ts backfill: queues each source's pending items a page at a time, and waits for each page to
// index before the next. A page that doesn't index stops that source's backfill.
func (w *worker) backfill() {
	model := w.x.model()
	if model == "" || w.backfilling {
		return
	}
	w.backfilling = true
	defer func() { w.backfilling = false }()
	for _, s := range w.x.sources {
		if s.Pending != nil && w.ctx.Err() == nil {
			w.backfillSource(s, model)
		}
	}
}

func (w *worker) backfillSource(s Source, model string) {
	for w.ctx.Err() == nil {
		refs, err := s.Pending(w.ctx, model, backfillPage)
		if err != nil {
			w.logErr("backfill "+s.Name, err)
			return
		}
		if len(refs) == 0 {
			return
		}
		for _, ref := range refs {
			// A full queue is worked off before the next ref goes in.
			for !w.x.Enqueue(s.Name, ref) {
				if w.ctx.Err() != nil {
					return
				}
				w.drain()
			}
		}
		w.drain()
		again, err := s.Pending(w.ctx, model, 1)
		if err != nil {
			w.logErr("backfill "+s.Name, err)
			return
		}
		if len(again) > 0 && again[0] == refs[0] {
			return
		}
	}
}

// Remove is src/vectors.ts remove: forgets an item's vector and any queued job for it.
func (x *Index) Remove(ctx context.Context, src, ref string) error {
	k := key(src, ref)
	x.mu.Lock()
	if x.queued[k] {
		delete(x.queued, k)
		for i, q := range x.queue {
			if q == k {
				x.queue = append(x.queue[:i:i], x.queue[i+1:]...)
				break
			}
		}
	}
	x.mu.Unlock()
	if err := x.db.DeleteEmbedding(ctx, src, ref); err != nil {
		return err
	}
	x.cacheMu.Lock()
	for ck, v := range x.cache {
		if s, _ := splitKey(ck); s == src {
			v.remove(ref)
		}
	}
	x.cacheMu.Unlock()
	return nil
}

func encode(v []float32) []byte {
	b := make([]byte, 4*len(v))
	for i, f := range v {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(f))
	}
	return b
}

func decode(ref string, dim int, raw []byte) (decoded, bool) {
	if len(raw) != dim*4 {
		return decoded{}, false
	}
	v := make([]float32, dim)
	for i := range v {
		v[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[4*i:]))
	}
	return decoded{ref: ref, vec: v, norm: norm(v)}, true
}

func norm(v []float32) float64 {
	n := 0.0
	for _, f := range v {
		n += float64(f) * float64(f)
	}
	return math.Sqrt(n)
}

func (v *vectors) remove(ref string) {
	i, ok := v.pos[ref]
	if !ok {
		return
	}
	last := v.rows[len(v.rows)-1]
	v.rows = v.rows[:len(v.rows)-1]
	delete(v.pos, ref)
	if i < len(v.rows) {
		v.rows[i] = last
		v.pos[last.ref] = i
	}
}

// cachePut is src/db.ts cachePut: a stored vector replaces the cached one of its source, under its model only.
func (x *Index) cachePut(src, model string, d decoded) {
	x.cacheMu.Lock()
	defer x.cacheMu.Unlock()
	for ck, v := range x.cache {
		if s, _ := splitKey(ck); s != src {
			continue
		}
		v.remove(d.ref)
		if ck != key(src, model) {
			continue
		}
		v.pos[d.ref] = len(v.rows)
		v.rows = append(v.rows, d)
	}
}

// vectorsOf is a source's vectors under model, read from the table once and kept in step by cachePut and Remove.
func (x *Index) vectorsOf(ctx context.Context, src, model string) ([]decoded, error) {
	x.cacheMu.Lock()
	defer x.cacheMu.Unlock()
	ck := key(src, model)
	v, ok := x.cache[ck]
	if !ok {
		rows, err := x.db.EmbeddingsOf(ctx, src, model)
		if err != nil {
			return nil, err
		}
		v = &vectors{pos: map[string]int{}}
		for _, r := range rows {
			if d, ok := decode(r.Ref, r.Dim, r.Vec); ok {
				v.pos[d.ref] = len(v.rows)
				v.rows = append(v.rows, d)
			}
		}
		x.cache[ck] = v
	}
	return append([]decoded(nil), v.rows...), nil
}

// Near is a ref and its cosine with the query.
type Near struct {
	Ref   string
	Score float64
}

// Nearest is src/vectors.ts nearest: the items of src nearest to q, best first, at most k (k < 0 for all), each at least
// min. refs, when not nil, limits the search to some.
func (x *Index) Nearest(ctx context.Context, src string, q []float32, refs map[string]bool, k int, minScore float64) ([]Near, error) {
	model := x.model()
	if model == "" {
		return nil, nil
	}
	nq := norm(q)
	if nq == 0 {
		return nil, nil
	}
	rows, err := x.vectorsOf(ctx, src, model)
	if err != nil {
		return nil, err
	}
	var out []Near
	for _, r := range rows {
		if refs != nil && !refs[r.ref] {
			continue
		}
		if len(r.vec) != len(q) || r.norm == 0 {
			continue
		}
		dot := 0.0
		for i := range q {
			dot += float64(q[i]) * float64(r.vec[i])
		}
		if s := dot / (nq * r.norm); s >= minScore {
			out = append(out, Near{r.ref, s})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if k >= 0 && len(out) > k {
		out = out[:k]
	}
	return out, nil
}

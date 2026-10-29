package search

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"stam/internal/db"
)

// openDB is an empty stam.db with the TS daemon's schema (testdata/mkdb.mjs).
func openDB(t *testing.T) *db.DB {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/db.ts")
	}
	home := t.TempDir()
	if out, err := exec.Command("node", "--no-warnings", "testdata/mkdb.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("mkdb.mjs: %v\n%s", err, out)
	}
	if _, err := os.Stat(filepath.Join(home, "stam.db")); err != nil {
		t.Fatal(err)
	}
	d, err := db.Open(context.Background(), filepath.Join(home, "stam.db"), db.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

// items is a fake source: refs and their text, stored when the test says, listed as pending while they lack a vector.
type items struct {
	d    *db.DB
	mu   sync.Mutex
	text map[string]string
	// fail is how many more Resolve calls of a ref fail.
	fail map[string]int
	// listed is closed by the first Pending call, the worker's start-up backfill; until open is set, Pending lists
	// nothing, so a test can tell that backfill from a later one.
	listed   chan struct{}
	listOnce sync.Once
	open     bool
}

func (it *items) put(ref, text string) {
	it.mu.Lock()
	defer it.mu.Unlock()
	it.text[ref] = text
}

func (it *items) source() Source {
	return Source{
		Name: "mail",
		Resolve: func(_ context.Context, ref string) (string, bool, error) {
			it.mu.Lock()
			defer it.mu.Unlock()
			if it.fail[ref] > 0 {
				it.fail[ref]--
				return "", false, errors.New("disk full")
			}
			text, ok := it.text[ref]
			return text, ok, nil
		},
		Pending: func(ctx context.Context, model string, limit int) ([]string, error) {
			defer it.listOnce.Do(func() { close(it.listed) })
			it.mu.Lock()
			if !it.open {
				it.mu.Unlock()
				return nil, nil
			}
			refs := make([]string, 0, len(it.text))
			for r := range it.text {
				refs = append(refs, r)
			}
			it.mu.Unlock()
			sort.Strings(refs)
			var out []string
			for _, r := range refs {
				_, m, ok, err := it.d.EmbeddingRow(ctx, "mail", r)
				if err != nil {
					return nil, err
				}
				if (!ok || m != model) && len(out) < limit {
					out = append(out, r)
				}
			}
			return out, nil
		},
	}
}

func newItems(d *db.DB) *items {
	return &items{d: d, text: map[string]string{}, fail: map[string]int{}, listed: make(chan struct{}), open: true}
}

// run starts the index's worker until the test ends.
func run(t *testing.T, x *Index) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		x.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
}

// allIndexed waits, on the table's state, until every ref has a vector from the stub.
func allIndexed(t *testing.T, d *db.DB, refs ...string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		missing := ""
		for _, r := range refs {
			_, m, ok, err := d.EmbeddingRow(context.Background(), "mail", r)
			if err != nil {
				t.Fatal(err)
			}
			if !ok || m != StubModel {
				missing = r
				break
			}
		}
		if missing == "" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s was never indexed", missing)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func stub() Provider { return Stub }

// A batch whose read fails is dropped from the queue and retried by the backfill on the retry schedule: the item is
// indexed after the retry, not lost.
func TestFailedBatchRetries(t *testing.T) {
	d := openDB(t)
	it := newItems(d)
	x := New(d, stub, it.source())
	x.RetrySchedule = []time.Duration{20 * time.Millisecond}
	run(t, x)
	it.put("m1", "users keep getting redirected")
	it.mu.Lock()
	it.fail["m1"] = 1
	it.mu.Unlock()
	x.IndexMail("m1")
	allIndexed(t, d, "m1")
	it.mu.Lock()
	defer it.mu.Unlock()
	if it.fail["m1"] != 0 {
		t.Errorf("the failing read was never made")
	}
}

// With a queue of one, the refs a full queue dropped are indexed by the backfill that runs once the queue drains.
func TestQueueOverflowBackfills(t *testing.T) {
	d := openDB(t)
	it := newItems(d)
	x := New(d, stub, it.source())
	x.QueueCap = 1
	// Long retries, so only the overflow's backfill can index the dropped refs.
	x.RetrySchedule = []time.Duration{time.Hour}
	// The start-up backfill lists nothing and is over before the refs exist.
	it.open = false
	run(t, x)
	<-it.listed
	refs := []string{"m1", "m2", "m3", "m4", "m5"}
	for _, r := range refs {
		it.put(r, "text of "+r)
	}
	it.mu.Lock()
	it.open = true
	it.mu.Unlock()
	dropped := 0
	for _, r := range refs {
		if !x.Enqueue("mail", r) {
			dropped++
		}
	}
	allIndexed(t, d, refs...)
	if dropped == 0 {
		t.Errorf("a queue of one dropped nothing; the test didn't overflow it")
	}
}

// Search with the local model set queues nothing on this daemon and embeds no query.
func TestLocalQueuesNothing(t *testing.T) {
	d := openDB(t)
	it := newItems(d)
	x := New(d, func() Provider { return Local }, it.source())
	it.put("m1", "text")
	x.IndexMail("m1")
	if n := x.queueLen(); n != 0 {
		t.Errorf("%d queued with the local model", n)
	}
	if v := x.Embed([]string{"q"}); v != nil {
		t.Errorf("a query vector with the local model: %v", v)
	}
}

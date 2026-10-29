package catalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/jsjson"
)

// fakeOpenRouter is a loopback catalogue: it answers status (200 by default) with one model named after the fetch's
// count, and waits on hold, when set, before it answers.
type fakeOpenRouter struct {
	fetches atomic.Int32
	status  atomic.Int32
	hold    chan struct{}
}

func (f *fakeOpenRouter) start(t *testing.T) *OpenRouter {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := f.fetches.Add(1)
		if f.hold != nil {
			<-f.hold
		}
		if s := f.status.Load(); s != 0 {
			w.WriteHeader(int(s))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"m/` + string(rune('0'+n)) + `"}]}`))
	}))
	t.Cleanup(srv.Close)
	return NewOpenRouter(func() string { return srv.URL })
}

func modelIDs(t *testing.T, o *OpenRouter) string {
	t.Helper()
	models, err := o.Models(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return jsjson.Stringify(models, "")
}

// TestOpenRouterCache: the catalogue is served from memory within six hours and fetched again after; a refresh that
// fails then (a 503) serves the last catalogue, and with none yet it is the error.
func TestOpenRouterCache(t *testing.T) {
	f := &fakeOpenRouter{}
	o := f.start(t)
	now := time.Unix(1000, 0)
	o.Now = func() time.Time { return now }
	first := modelIDs(t, o)
	if first != `[{"id":"m/1","name":"m/1","in":null,"out":null}]` || modelIDs(t, o) != first || f.fetches.Load() != 1 {
		t.Fatalf("within the TTL: %s, %d fetches", first, f.fetches.Load())
	}
	now = now.Add(modelsTTL)
	if got := modelIDs(t, o); got != `[{"id":"m/2","name":"m/2","in":null,"out":null}]` || f.fetches.Load() != 2 {
		t.Errorf("after the TTL: %s, %d fetches", got, f.fetches.Load())
	}
	now = now.Add(modelsTTL)
	f.status.Store(503)
	if got := modelIDs(t, o); got != `[{"id":"m/2","name":"m/2","in":null,"out":null}]` || f.fetches.Load() != 3 {
		t.Errorf("a failed refresh: %s, %d fetches", got, f.fetches.Load())
	}
	fresh := NewOpenRouter(o.Base)
	if _, err := fresh.Models(context.Background()); err == nil || err.Error() != "OpenRouter answered HTTP 503 for its models" {
		t.Errorf("a failed first fetch: %v", err)
	}
}

// TestOpenRouterSharedFetch: callers that ask while a fetch is under way wait for it, and all get its catalogue.
func TestOpenRouterSharedFetch(t *testing.T) {
	f := &fakeOpenRouter{hold: make(chan struct{})}
	o := f.start(t)
	const callers = 8
	var wg sync.WaitGroup
	out := make([]string, callers)
	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			models, err := o.Models(context.Background())
			if err == nil {
				out[i] = jsjson.Stringify(models, "")
			}
		}()
	}
	// Release the fetch once every caller waits for one.
	for {
		o.mu.Lock()
		n := o.waiting
		o.mu.Unlock()
		if n == callers {
			break
		}
		time.Sleep(time.Millisecond)
	}
	close(f.hold)
	wg.Wait()
	if n := f.fetches.Load(); n != 1 {
		t.Errorf("%d fetches for %d callers, not 1", n, callers)
	}
	for i, got := range out {
		if got != `[{"id":"m/1","name":"m/1","in":null,"out":null}]` {
			t.Errorf("caller %d: %q", i, got)
		}
	}
}

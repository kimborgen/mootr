package tiny

import (
	"context"
	"slices"
	"testing"
)

// TestLaneStaleHandle: the queue src/tool-summaries.ts and src/tool-names.ts share. Go's get and promote lock apart, so
// a request can promote a job that another request's promote or a stop dropped in between. That stale handle must not
// come back: re-queued, it would bump a live job and run beside the job a later get makes for its key, two paid calls
// for one thing. The lane is off, so nothing runs and the queue stays as promote leaves it.
func TestLaneStaleHandle(t *testing.T) {
	noop := func() func(context.Context) { return func(context.Context) {} }
	closed := func(j *job) bool {
		select {
		case <-j.done:
			return true
		default:
			return false
		}
	}
	off := func() bool { return false }
	// staleA is a lane of one place where request A got job a, then request B promoted a and b pushed a past the end.
	staleA := func(t *testing.T) (*lane, *job) {
		l := newLane(1, 1, off)
		a := l.get("a", noop)
		l.promote([]*job{l.get("a", noop)})
		l.promote([]*job{l.get("b", noop)})
		if !closed(a) || !slices.Equal(l.queued(), []string{"b"}) {
			t.Fatalf("a dropped: %v %v", closed(a), l.queued())
		}
		return l, a
	}

	t.Run("dropped by another promote", func(t *testing.T) {
		l, a := staleA(t)
		l.promote([]*job{a})
		if got := l.queued(); !slices.Equal(got, []string{"b"}) {
			t.Errorf("the stale a came back: %v", got)
		}
	})

	t.Run("replaced by a later get", func(t *testing.T) {
		l, a := staleA(t)
		a2 := l.get("a", noop)
		if a2 == a {
			t.Fatal("get returned the dropped job")
		}
		l.promote([]*job{a})
		if slices.Contains(l.queue, a) || l.jobs["a"] != a2 {
			t.Errorf("the stale a came back: queued %v, a2 recorded %v", slices.Contains(l.queue, a), l.jobs["a"] == a2)
		}
		l.promote([]*job{a2})
		if len(l.queue) != 1 || l.queue[0] != a2 {
			t.Errorf("the queue holds %v", l.queued())
		}
	})

	t.Run("dropped by a stop", func(t *testing.T) {
		l := newLane(1, 10, off)
		x := l.get("x", noop)
		l.stop()
		l.promote([]*job{x})
		if !closed(x) || len(l.queued()) != 0 || l.jobs["x"] != nil {
			t.Errorf("after a stop: closed %v, queued %v", closed(x), l.queued())
		}
	})
}

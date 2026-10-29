package lifecycle

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

// An OpenCode execution's end binds only to the execution it ends (S-4299): one seen starting, or credited, under the
// generation now, in the session the row runs, with no launch in flight; one start or credit binds one end.
func TestOwnerExec(t *testing.T) {
	runs := "ses_a"
	turn := func() string { return runs }
	land := func(o *owner) int {
		g := o.beginLaunch()
		o.settleLaunch(g, true)
		return g
	}
	ends := func(o *owner, sid string) bool {
		_, _, _, binds := o.endExec(sid, turn)
		return binds
	}
	cases := []struct {
		name string
		do   func(o *owner) bool
		want bool
	}{
		{"a fresh owner's credit binds one end", func(o *owner) bool { return ends(o, "ses_a") }, true},
		{"the credit binds only one", func(o *owner) bool { ends(o, "ses_a"); return ends(o, "ses_a") }, false},
		{"a start binds its end", func(o *owner) bool { land(o); o.startExec("ses_a", turn); return ends(o, "ses_a") }, true},
		// A compaction's start and an execution's start in one generation: each has its end, and both are the turn's.
		{"a start's mark binds each end of its generation", func(o *owner) bool {
			land(o)
			o.startExec("ses_a", turn)
			o.startExec("ses_a", turn)
			ends(o, "ses_a")
			return ends(o, "ses_a")
		}, true},
		{"a launch since the start", func(o *owner) bool { o.startExec("ses_a", turn); land(o); return ends(o, "ses_a") }, false},
		{"a quit since the start", func(o *owner) bool { o.startExec("ses_a", turn); o.invalidate(); return ends(o, "ses_a") }, false},
		{"a launch since the credit", func(o *owner) bool { land(o); return ends(o, "ses_a") }, false},
		{"a launch since a reconnect's credit", func(o *owner) bool { o.creditExec(); land(o); return ends(o, "ses_a") }, false},
		{"a reconnect credits one end", func(o *owner) bool { land(o); o.creditExec(); return ends(o, "ses_a") }, true},
		{"a reconnect during a launch credits none", func(o *owner) bool {
			g := o.beginLaunch()
			o.creditExec()
			o.settleLaunch(g, true)
			return ends(o, "ses_a")
		}, false},
		{"a start during a launch", func(o *owner) bool {
			g := o.beginLaunch()
			o.startExec("ses_a", turn)
			o.settleLaunch(g, true)
			return ends(o, "ses_a")
		}, false},
		{"an end during a launch", func(o *owner) bool {
			g := land(o)
			o.startExec("ses_a", turn)
			o.mu.Lock()
			o.launched = g + 1
			o.gen = g
			o.mu.Unlock()
			return ends(o, "ses_a")
		}, false},
		{"a start of another session", func(o *owner) bool { land(o); o.startExec("ses_b", turn); return ends(o, "ses_b") }, false},
		{"an end of another session", func(o *owner) bool { land(o); o.startExec("ses_a", turn); return ends(o, "ses_b") }, false},
		{"an end with no session", func(o *owner) bool { return ends(o, "") }, false},
		// The row's session moved with no generation bump (no production path does; each guard is checked alone).
		{"an end of a session the row moved to", func(o *owner) bool {
			land(o)
			o.startExec("ses_a", turn)
			runs = "ses_b"
			return ends(o, "ses_b")
		}, false},
		{"a start of a session the row did not run", func(o *owner) bool {
			land(o)
			o.startExec("ses_b", turn)
			runs = "ses_b"
			return ends(o, "ses_b")
		}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			runs = "ses_a"
			if got := c.do(newOwner()); got != c.want {
				t.Errorf("binds %v, want %v", got, c.want)
			}
		})
	}
	// The row that runs no session (shut down, archived): its session's end binds nothing, credited or started.
	t.Run("the row runs no session", func(t *testing.T) {
		o := newOwner()
		runs = ""
		defer func() { runs = "ses_a" }()
		if ends(o, "ses_a") {
			t.Error("an end bound with the row running no session")
		}
		if ends(o, "") {
			t.Error("an end of no session bound with the row running none")
		}
	})
}

// An end that waits on the owner's lock while a launch lands is read after it: the launch's generation leaves the
// execution it started before stale. The end is observed blocked on the lock (its goroutine's stack in endExec's Lock)
// before the launch's state changes, so the order is the one the race needs, not one a scheduler happened to pick.
func TestOwnerExecEndQueuedBehindLaunch(t *testing.T) {
	o := newOwner()
	turn := func() string { return "ses_a" }
	o.startExec("ses_a", turn)
	o.mu.Lock()
	got := make(chan bool, 1)
	go func() {
		_, _, _, binds := o.endExec("ses_a", turn)
		got <- binds
	}()
	waitBlockedIn(t, "lifecycle.(*owner).endExec")
	// The launch begins and lands while the end waits: its generation, then its outcome, as beginLaunch and
	// settleLaunch write them.
	o.gen++
	o.launched = o.gen
	o.launchEnd, o.launchOK = o.gen, true
	o.mu.Unlock()
	if <-got {
		t.Error("an end of an execution started before a launch bound after it landed")
	}
}

// waitBlockedIn waits until a goroutine waits on a mutex inside fn.
func waitBlockedIn(t *testing.T, fn string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	buf := make([]byte, 1<<20)
	for time.Now().Before(deadline) {
		n := runtime.Stack(buf, true)
		for _, g := range strings.Split(string(buf[:n]), "\n\n") {
			if (strings.Contains(g, "[sync.Mutex.Lock") || strings.Contains(g, "[semacquire")) && strings.Contains(g, fn) {
				return
			}
		}
		runtime.Gosched()
	}
	t.Fatalf("no goroutine blocked on a lock in %s", fn)
}

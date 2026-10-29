package lifecycle

import (
	"context"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// The lifecycle's side of the test routes (POST /api/test/cost and /api/test/launch-fail, src/daemon.ts): a test runs
// a timer's work now, or reports what an adapter would, instead of waiting for it. Only the server's /api/test/* routes,
// which answer a test daemon alone, call these.

// testState is the test routes' state: the agent names whose launch fails (src/test-hooks.ts failLaunch), always empty
// outside a test daemon. Under l.mu.
type testState struct {
	failLaunch map[string]bool
	// onFailLaunch runs as a launch is made to fail, for a test that acts mid-launch (a request canceled).
	onFailLaunch func()
}

// SetFailLaunch makes the named agents' launches fail once their row exists, replacing the names set before
// (POST /api/test/launch-fail).
func (l *Lifecycle) SetFailLaunch(names []string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.tests.failLaunch = map[string]bool{}
	for _, n := range names {
		l.tests.failLaunch[n] = true
	}
}

// SetArchiveStopped runs fn in each archive right after it stopped the harness, before the worktree is touched; Go tests
// only, set before the archive starts.
func (l *Lifecycle) SetArchiveStopped(fn func(id string)) { l.archiveStopped = fn }

// TestRunDueArchives runs the pending archives due at now (runDueArchives), as the reconcile tick does; Go tests only.
func (l *Lifecycle) TestRunDueArchives(ctx context.Context, now float64) { l.runDueArchives(ctx, now) }

// SetOnFailLaunch runs fn each time a launch SetFailLaunch names is made to fail, before it fails; Go tests only.
func (l *Lifecycle) SetOnFailLaunch(fn func()) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.tests.onFailLaunch = fn
}

func (l *Lifecycle) launchFails(name string) bool {
	l.mu.Lock()
	fails, fn := l.tests.failLaunch[name], l.tests.onFailLaunch
	l.mu.Unlock()
	if fails && fn != nil {
		fn()
	}
	return fails
}

// StamBin is stam's own command, as agents run it (GET /api/test/stam-bin, src/config.ts STAM_BIN).
func (l *Lifecycle) StamBin() string { return l.claude.Bin }

// TestReading stores a subscription reading as an adapter reports one (the cost route's `reading`).
func (l *Lifecycle) TestReading(ctx context.Context, name string, windows *jsjson.Object) error {
	return l.reportSubscription(ctx, name, windows, time.Now())
}

// TestFallbacksDue runs the cost fallbacks due by now (the cost route's `fallback-due`).
func (l *Lifecycle) TestFallbacksDue(ctx context.Context, now time.Time) {
	l.evaluateFallbacks(ctx, now)
}

// TestProbe runs the account's error probe now (the cost route's `probe-due`).
func (l *Lifecycle) TestProbe(ctx context.Context, account string) error {
	return l.runProbe(ctx, account, ms(time.Now()))
}

// testSignalEvent is the cost:signal a test records: src/rules.ts signal's data as the cost route gives it.
type testSignalEvent struct {
	Source string `json:"source"`
	Class  string `json:"class"`
}

// TestSignal records a provider error signal on the agent as its adapter would (the cost route's `error`).
func (l *Lifecycle) TestSignal(ctx context.Context, a db.Agent, source, class string) {
	l.signal(ctx, a, class, source, testSignalEvent{Source: source, Class: class})
}

// TestSpend reports the agent's cumulative cost as its adapter would, which books it on the agent's account (the cost
// route's `spend`).
func (l *Lifecycle) TestSpend(ctx context.Context, a db.Agent, cost float64) error {
	var r usageReport
	r.counts[0] = &cost
	return l.reportUsage(ctx, a, r, time.Now())
}

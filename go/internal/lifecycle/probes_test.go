package lifecycle

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// The tests of probes.go, after test/cost-probes.test.mjs: errors come through the Claude hook handler (StopFailure),
// probes are stubbed or run as turns, and the schedule is read, not waited for.

const probeSettings = `{"cost":{"accounts":{"max":{"match":{"harness":"claude"},"paid":false},"plus":{"match":{"harness":"codex"},"paid":false}}}}`

// fail is a StopFailure with this error on the agent, as Claude Code's hook sends it.
func (l *live) fail(id, e string) {
	l.t.Helper()
	if _, err := l.life.OnHook(l.ctx, "claude", l.agent(id), jsjson.NewObject("hook_event_name", "StopFailure", "error", e), new([]int64)); err != nil {
		l.t.Fatal(err)
	}
}

// answered is the agent's model answering: a Stop, or a PostToolUse with tool.
func (l *live) answered(id, event string) {
	l.t.Helper()
	p := jsjson.NewObject("hook_event_name", "Stop", "last_assistant_message", "done")
	if event == "PostToolUse" {
		p = jsjson.NewObject("hook_event_name", "PostToolUse", "tool_name", "Bash")
	}
	if _, err := l.life.OnHook(l.ctx, "claude", l.agent(id), p, new([]int64)); err != nil {
		l.t.Fatal(err)
	}
}

// of is the agent's blocker of this kind, nil for none.
func (l *live) of(id, kind string) *db.Blocker {
	l.t.Helper()
	for _, b := range l.blockerRows(id) {
		if b.Kind == kind {
			return &b
		}
	}
	return nil
}

func (l *live) runProbe(account string, now time.Time) {
	l.t.Helper()
	if err := l.life.runProbe(l.ctx, account, ms(now)); err != nil {
		l.t.Fatal(err)
	}
}

func (l *live) probeTurn(account string) string {
	_, _, turn, _ := l.life.nextProbe(account)
	return turn
}

func (l *live) admitted(id string) (bool, string) { return l.life.admit(l.ctx, id, "mail") }

// restartProbes drops the in-memory probing, as a daemon restart does.
func (l *live) restartProbes() {
	p := &l.life.costProbes
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, s := range p.states {
		if s.timer != nil {
			s.timer.Stop()
		}
	}
	p.states, p.gens, p.told = nil, nil, nil
}

// mailbox records the stam mail the probes send, and the system senders it names.
type mailbox struct {
	mu      sync.Mutex
	sent    []string
	senders []string
}

func (m *mailbox) send(_ context.Context, name string, to []string, subject, body string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, strings.Join(to, ",")+"|"+subject+"|"+body)
	m.senders = append(m.senders, name)
	return true
}

func (m *mailbox) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sent)
}

func newProbeLive(t *testing.T) (*live, *mailbox) {
	l := newLive(t)
	l.setSettings(probeSettings)
	// Only the test's own agents are on the account, as the TS tests archive every other.
	all, err := l.db.ListAgents(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range all {
		l.set(a.ID, db.Field{Col: "lifecycle", Val: "archived"})
	}
	box := &mailbox{}
	l.life.SetSystemMail(box.send)
	return l, box
}

// TestProbesTransientError: a transient error after the harness's retries blocks every agent on the account and spares
// the human; one probe is due a minute out, and a second error refreshes the reason but neither resets nor adds a probe.
// The signal classes route: billing to credits-out, auth and transient to error, anything else nowhere.
func TestProbesTransientError(t *testing.T) {
	l, box := newProbeLive(t)
	l.spawn("alpa1")
	l.spawn("alpa2")
	t0 := time.Now()
	l.fail("alpa1", "overloaded")
	l.until("the error blocker on both", func() bool {
		return l.of("alpa1", "error") != nil && l.of("alpa2", "error") != nil && l.agent("alpa2").Lifecycle == "paused"
	})
	b := l.of("alpa1", "error")
	if !strings.Contains(b.Reason, "a provider error after the harness's retries, StopFailure (overloaded); stam probes the account") || b.Account != "max" {
		t.Errorf("blocker %+v", b)
	}
	if !strings.HasPrefix(deref(b.Clear), `{"after":"`) || !strings.HasSuffix(deref(b.Clear), `","class":"transient"}`) {
		t.Errorf("clear %s", deref(b.Clear))
	}
	if l.agent("alpa1").Lifecycle != "paused" {
		t.Error("not paused")
	}
	if ok, _ := l.admitted("alpa1"); ok {
		t.Error("admitted")
	}
	if box.count() != 0 {
		t.Error("the human was mailed for a transient error")
	}
	attempt, due, _, ok := l.life.nextProbe("max")
	if !ok || attempt != 0 || due-ms(t0) < 60000 || due-ms(time.Now()) > 60000 {
		t.Errorf("probe %d %v %v", attempt, due, ok)
	}
	l.fail("alpa2", "server_error")
	l.until("the refreshed reason", func() bool { return strings.Contains(l.of("alpa1", "error").Reason, "server_error") })
	if attempt, _, _, _ := l.life.nextProbe("max"); attempt != 0 {
		t.Errorf("attempt %d", attempt)
	}
	l.fail("alpa1", "max_output_tokens")
	if got := l.events("alpa1", "cost:signal"); strings.Join(got, " ") != `{"source":"StopFailure","class":"transient","error":"overloaded"}` {
		t.Errorf("signals %v", got)
	}
}

// TestProbesBackoff: the probe backs off 1, 2, 4, 8, 16, then 16 minutes, one per account, and its success clears every
// agent.
func TestProbesBackoff(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alpb1")
	l.spawn("alpb2")
	var calls atomic.Int32
	var ok atomic.Bool
	l.life.prober = func(_ context.Context, account string, _ config.CostAccount) (probeOutcome, error) {
		if account != "max" {
			t.Errorf("probed %s", account)
		}
		calls.Add(1)
		if ok.Load() {
			return "ok", nil
		}
		return "fail", nil
	}
	if err := l.life.onError(l.ctx, l.agent("alpb1"), "transient", "StopFailure (overloaded)", ms(time.Now())); err != nil {
		t.Fatal(err)
	}
	if l.of("alpb1", "error") == nil || l.of("alpb2", "error") == nil {
		t.Fatal("not blocked")
	}
	var waits []float64
	for range 6 {
		now := time.Now()
		l.runProbe("max", now)
		_, due, _, _ := l.life.nextProbe("max")
		waits = append(waits, (due-ms(now))/60000)
	}
	if got := fmt.Sprint(waits); got != "[2 4 8 16 16 16]" {
		t.Errorf("waits %s", got)
	}
	if calls.Load() != 6 {
		t.Errorf("%d probes", calls.Load())
	}
	if l.of("alpb1", "error") == nil {
		t.Error("a failed probe cleared")
	}
	ok.Store(true)
	l.runProbe("max", time.Now())
	l.until("both cleared", func() bool {
		return l.of("alpb1", "error") == nil && l.of("alpb2", "error") == nil && l.agent("alpb1").Lifecycle == "active" && l.agent("alpb2").Lifecycle == "active"
	})
	if _, _, _, ok := l.life.nextProbe("max"); ok {
		t.Error("still probing")
	}
	if e := lastEvent(t, l, "alpb1", "blocker:clear"); !strings.Contains(e, "a probe of max succeeded") {
		t.Errorf("blocker:clear %s", e)
	}
}

// TestProbesAuthMail: an auth error mails the human once per account per outage, through auth, transient and auth
// again and two at once; the mark is on the blocker, and the next outage mails again.
func TestProbesAuthMail(t *testing.T) {
	l, box := newProbeLive(t)
	l.spawn("alpm1")
	l.spawn("alpm2")
	l.life.prober = func(context.Context, string, config.CostAccount) (probeOutcome, error) { return "ok", nil }
	auth := func(id, source string) {
		if err := l.life.onError(l.ctx, l.agent(id), "auth", source, ms(time.Now())); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	for _, id := range []string{"alpm1", "alpm2"} {
		wg.Add(1)
		go func() { defer wg.Done(); auth(id, "StopFailure (authentication_failed)") }()
	}
	wg.Wait()
	l.until("the human mail", func() bool { return box.count() == 1 })
	box.mu.Lock()
	m, from := box.sent[0], box.senders[0]
	box.mu.Unlock()
	if from != "cost" {
		t.Errorf("sent from system:%s, not system:cost", from)
	}
	if !strings.HasPrefix(m, "human|[stam] max: authentication error stops its agents|") || !strings.Contains(m, "Fix the login") || !strings.Contains(m, "n-alpm1") {
		t.Errorf("mail %s", m)
	}
	if c := deref(l.of("alpm2", "error").Clear); !strings.HasSuffix(c, `"class":"auth","human":true}`) {
		t.Errorf("clear %s", c)
	}
	if err := l.life.onError(l.ctx, l.agent("alpm1"), "transient", "StopFailure (overloaded)", ms(time.Now())); err != nil {
		t.Fatal(err)
	}
	if c := deref(l.of("alpm1", "error").Clear); !strings.HasSuffix(c, `"class":"transient","human":true}`) {
		t.Errorf("the transient error dropped the mark: %s", c)
	}
	// A restart forgets who was told; the blocker's mark keeps the outage told.
	l.restartProbes()
	auth("alpm2", "StopFailure (authentication_failed)")
	if box.count() != 1 {
		t.Errorf("%d mails in one outage", box.count())
	}
	l.runProbe("max", time.Now())
	l.until("cleared", func() bool { return l.of("alpm1", "error") == nil && l.of("alpm2", "error") == nil })
	auth("alpm1", "StopFailure (authentication_failed)")
	l.until("the second outage's mail", func() bool { return box.count() == 2 })
}

// TestProbesClaudeTurn: a billing error sets credits-out on the account and probes with one agent's turn while the rest
// stay held; a failure holds it again, and a Stop from the next probe turn clears all.
func TestProbesClaudeTurn(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alpt1")
	l.spawn("alpt2")
	sh := l.shim(l.life, "alpt1")
	l.fail("alpt1", "billing_error")
	l.until("credits-out and the probe", func() bool {
		_, _, _, ok := l.life.nextProbe("max")
		return l.of("alpt1", "credits-out") != nil && l.of("alpt2", "credits-out") != nil && l.agent("alpt1").Lifecycle == "paused" && ok
	})
	if r := l.of("alpt1", "credits-out").Reason; r != "a credits error, StopFailure (billing_error); Claude reports no balance, so stam probes the account (1, 2, 4, 8, 16 minutes, then every 16) and clears this when one succeeds" {
		t.Errorf("reason %s", r)
	}
	if p := sh.next(t); p.Content != l.render("pause", nil) {
		t.Errorf("the pause %q", p.Content)
	}
	l.runProbe("max", time.Now())
	if turn := l.probeTurn("max"); turn != "alpt1" {
		t.Fatalf("turn %q", turn)
	}
	if l.agent("alpt1").Lifecycle != "active" || l.of("alpt1", "credits-out") == nil {
		t.Error("the probe agent isn't running past its blocker")
	}
	if p := sh.next(t); p.Content != l.render("cost-probe-turn", map[string]string{"blocker": "credits-out on max"}) {
		t.Errorf("the probe turn %q", p.Content)
	}
	if ok, _ := l.admitted("alpt1"); !ok {
		t.Error("the probe agent isn't admitted")
	}
	if ok, _ := l.admitted("alpt2"); ok || l.agent("alpt2").Lifecycle != "paused" {
		t.Error("the rest aren't held")
	}
	l.fail("alpt1", "billing_error")
	l.until("held again", func() bool { return l.agent("alpt1").Lifecycle == "paused" && l.probeTurn("max") == "" })
	if ok, _ := l.admitted("alpt1"); ok {
		t.Error("admitted after its turn failed")
	}
	if attempt, _, _, _ := l.life.nextProbe("max"); attempt != 1 {
		t.Errorf("attempt %d", attempt)
	}
	l.runProbe("max", time.Now())
	if turn := l.probeTurn("max"); turn != "alpt1" {
		t.Fatalf("second turn %q", turn)
	}
	l.answered("alpt1", "Stop")
	l.until("credits-out cleared", func() bool {
		return l.of("alpt1", "credits-out") == nil && l.of("alpt2", "credits-out") == nil && l.agent("alpt2").Lifecycle == "active"
	})
	if e := lastEvent(t, l, "alpt2", "blocker:clear"); !strings.Contains(e, "n-alpt1's turn, the probe, got a model response") {
		t.Errorf("blocker:clear %s", e)
	}
	if _, _, _, ok := l.life.nextProbe("max"); ok {
		t.Error("still probing")
	}
}

// TestProbesStaleSuccess: a success clears only the generation it tested. A probe turn's Stop accepted before a newer
// billing error, and held until that error is in, clears nothing and leaves the probing on; an endpoint probe's success
// that a newer failure overtook while it ran clears nothing either, and the next probe tests the new failure and may
// clear it.
func TestProbesStaleSuccess(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alps1")
	l.fail("alps1", "billing_error")
	l.until("credits-out", func() bool { return l.of("alps1", "credits-out") != nil && l.agent("alps1").Lifecycle == "paused" })
	l.runProbe("max", time.Now())
	if l.probeTurn("max") != "alps1" {
		t.Fatal("no probe turn")
	}
	gen := l.life.probeGen("max")
	at, release := make(chan struct{}), make(chan struct{})
	l.life.succeeding = func(string) {
		close(at)
		<-release
	}
	l.answered("alps1", "Stop")
	<-at
	l.fail("alps1", "billing_error")
	l.until("the newer error in", func() bool { return l.life.probeGen("max") == gen+1 })
	<-l.life.EvaluateRules("max", Trigger{}, time.Now())
	close(release)
	l.until("the success settled", func() bool { return l.life.bgRunning.Load() == 0 })
	if l.of("alps1", "credits-out") == nil {
		t.Error("an older success cleared the newer billing error")
	}
	if _, _, turn, ok := l.life.nextProbe("max"); !ok || turn != "" {
		t.Errorf("probe %q %v", turn, ok)
	}

	l2, _ := newProbeLive(t)
	l2.spawn("alps2")
	if err := l2.life.onError(l2.ctx, l2.agent("alps2"), "transient", "old failure", ms(time.Now())); err != nil {
		t.Fatal(err)
	}
	running, outcome := make(chan struct{}), make(chan probeOutcome)
	l2.life.prober = func(context.Context, string, config.CostAccount) (probeOutcome, error) {
		close(running)
		return <-outcome, nil
	}
	done := make(chan struct{})
	go func() { defer close(done); l2.runProbe("max", time.Now()) }()
	<-running
	if err := l2.life.onError(l2.ctx, l2.agent("alps2"), "auth", "new failure", ms(time.Now())); err != nil {
		t.Fatal(err)
	}
	outcome <- "ok"
	<-done
	if l2.of("alps2", "error") == nil {
		t.Error("the newer failure cleared")
	}
	if attempt, _, _, _ := l2.life.nextProbe("max"); attempt != 1 {
		t.Errorf("attempt %d", attempt)
	}
	l2.life.prober = func(context.Context, string, config.CostAccount) (probeOutcome, error) { return "ok", nil }
	l2.runProbe("max", time.Now())
	l2.until("cleared by a probe of the new generation", func() bool { return l2.of("alps2", "error") == nil })
}

// TestProbesGuardedClear: a success that is clearing the account when a newer failure arrives leaves the blockers it
// hasn't dropped yet: the generation is checked again inside each agent's serial, right before the drop. The newer
// failure's own writes then put the blocker back on every agent, and probing starts again.
func TestProbesGuardedClear(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alpg1")
	l.spawn("alpg2")
	l.fail("alpg1", "overloaded")
	l.until("both held", func() bool { return l.agent("alpg1").Lifecycle == "paused" && l.agent("alpg2").Lifecycle == "paused" })
	l.runProbe("max", time.Now())
	if l.probeTurn("max") != "alpg1" {
		t.Fatalf("turn %q", l.probeTurn("max"))
	}
	gen := l.life.probeGen("max")
	// The other agent's serial is held, so the success's clear of it waits there.
	held, release := make(chan struct{}), make(chan struct{})
	go func() {
		_ = l.life.serial(l.ctx, "alpg2", func(context.Context) error {
			close(held)
			<-release
			return nil
		})
	}()
	<-held
	waiting := make(chan struct{}, 1)
	l.life.serialWaiting = func(id string) {
		if id == "alpg2" {
			select {
			case waiting <- struct{}{}:
			default:
			}
		}
	}
	l.answered("alpg1", "Stop")
	<-waiting
	// A newer failure is registered while the clear waits; its blocker writes queue behind the success on the chain.
	l.life.costProbes.mu.Lock()
	l.life.startProbe("max", ms(time.Now()))
	l.life.costProbes.mu.Unlock()
	if l.life.probeGen("max") != gen+1 {
		t.Fatal("no newer generation")
	}
	close(release)
	l.until("the success settled", func() bool { return l.life.bgRunning.Load() == 0 })
	if l.of("alpg2", "error") == nil {
		t.Error("the success dropped a blocker after a newer failure")
	}
	if _, _, _, ok := l.life.nextProbe("max"); !ok {
		t.Error("probing stopped")
	}
	// The newer failure's writes, on the chain behind the success, block every agent again.
	if err := l.life.onError(l.ctx, l.agent("alpg2"), "transient", "StopFailure (overloaded)", ms(time.Now())); err != nil {
		t.Fatal(err)
	}
	l.until("both blocked again", func() bool { return l.of("alpg1", "error") != nil && l.of("alpg2", "error") != nil })
}

// TestProbesSpawnDuringClear: a spawn's attach that comes while a success is clearing the account waits for it on the
// account's chain, so it can't copy a blocker the success is about to drop and leave the new agent held with no probe.
func TestProbesSpawnDuringClear(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alpd1")
	l.spawn("alpd2")
	l.fail("alpd1", "overloaded")
	l.until("both held", func() bool { return l.agent("alpd1").Lifecycle == "paused" && l.agent("alpd2").Lifecycle == "paused" })
	l.runProbe("max", time.Now())
	if l.probeTurn("max") != "alpd1" {
		t.Fatalf("turn %q", l.probeTurn("max"))
	}
	held, release := make(chan struct{}), make(chan struct{})
	go func() {
		_ = l.life.serial(l.ctx, "alpd2", func(context.Context) error {
			close(held)
			<-release
			return nil
		})
	}()
	<-held
	waiting, queued := make(chan struct{}, 1), make(chan struct{}, 1)
	l.life.serialWaiting = func(id string) {
		if id == "alpd2" {
			select {
			case waiting <- struct{}{}:
			default:
			}
		}
	}
	l.life.chainWaiting = func(string) {
		select {
		case queued <- struct{}{}:
		default:
		}
	}
	l.answered("alpd1", "Stop")
	<-waiting
	l.row("alpd3", "")
	attached := make(chan error, 1)
	go func() { attached <- l.life.AttachSpawn(l.ctx, l.agent("alpd3")) }()
	select {
	case <-queued:
	case err := <-attached:
		// Not on the chain: it ran while the success was mid-clear.
		if err != nil {
			t.Fatal(err)
		}
		attached <- nil
	}
	close(release)
	if err := <-attached; err != nil {
		t.Fatal(err)
	}
	l.until("the success settled", func() bool { return l.life.bgRunning.Load() == 0 })
	if b := l.of("alpd3", "error"); b != nil {
		t.Errorf("the spawn was left with %+v and no probe", b)
	}
	if l.of("alpd2", "error") != nil {
		t.Error("not cleared")
	}
}

// TestProbesSpawnInherits: a spawn onto an account in an outage gets its error blocker before launch, auth (with the
// human's mark) and transient alike, and the probe's success clears it with the rest.
func TestProbesSpawnInherits(t *testing.T) {
	l, box := newProbeLive(t)
	l.spawn("alpi1")
	l.life.prober = func(context.Context, string, config.CostAccount) (probeOutcome, error) { return "ok", nil }
	if err := l.life.onError(l.ctx, l.agent("alpi1"), "auth", "StopFailure (authentication_failed)", ms(time.Now())); err != nil {
		t.Fatal(err)
	}
	l.row("alpi2", "")
	if err := l.life.AttachSpawn(l.ctx, l.agent("alpi2")); err != nil {
		t.Fatal(err)
	}
	b := l.of("alpi2", "error")
	if b == nil || b.Reason != l.of("alpi1", "error").Reason || !strings.HasSuffix(deref(b.Clear), `"class":"auth","human":true}`) {
		t.Fatalf("the spawn's blocker %+v", b)
	}
	l.until("the one mail", func() bool { return box.count() == 1 })
	l.runProbe("max", time.Now())
	l.until("both cleared", func() bool { return l.of("alpi1", "error") == nil && l.of("alpi2", "error") == nil })
	if err := l.life.onError(l.ctx, l.agent("alpi1"), "transient", "StopFailure (overloaded)", ms(time.Now())); err != nil {
		t.Fatal(err)
	}
	l.row("alpi3", "")
	if err := l.life.AttachSpawn(l.ctx, l.agent("alpi3")); err != nil {
		t.Fatal(err)
	}
	if b := l.of("alpi3", "error"); b == nil || !strings.HasSuffix(deref(b.Clear), `"class":"transient"}`) {
		t.Errorf("the transient spawn's blocker %+v", b)
	}
	if box.count() != 1 {
		t.Errorf("%d mails", box.count())
	}
}

// TestProbesAbandonedTurn: a probe turn that shows nothing by the next step is abandoned and held again, and another
// agent probes; a model response mid-turn (a tool ran) clears the account.
func TestProbesAbandonedTurn(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alpn1")
	l.spawn("alpn2")
	l.fail("alpn1", "overloaded")
	l.until("both held", func() bool {
		return l.of("alpn2", "error") != nil && l.agent("alpn1").Lifecycle == "paused" && l.agent("alpn2").Lifecycle == "paused"
	})
	l.runProbe("max", time.Now())
	if l.probeTurn("max") != "alpn1" {
		t.Fatalf("turn %q", l.probeTurn("max"))
	}
	l.runProbe("max", time.Now())
	if l.probeTurn("max") != "alpn2" {
		t.Fatalf("the abandoned agent went first: %q", l.probeTurn("max"))
	}
	l.until("the first held again", func() bool { return l.agent("alpn1").Lifecycle == "paused" })
	l.answered("alpn2", "PostToolUse")
	l.until("cleared", func() bool { return l.of("alpn1", "error") == nil && l.agent("alpn1").Lifecycle == "active" })
}

// TestProbesAbandonedLast: the agent of an abandoned probe turn is picked last, even when it is already paused again.
func TestProbesAbandonedLast(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alpq1")
	l.spawn("alpq2")
	l.fail("alpq1", "overloaded")
	l.until("both held", func() bool { return l.agent("alpq1").Lifecycle == "paused" && l.agent("alpq2").Lifecycle == "paused" })
	l.runProbe("max", time.Now())
	if l.probeTurn("max") != "alpq1" {
		t.Fatalf("turn %q", l.probeTurn("max"))
	}
	if err := l.life.serial(l.ctx, "alpq1", func(ctx context.Context) error { _, err := l.life.pauseNow(ctx, "alpq1", ""); return err }); err != nil {
		t.Fatal(err)
	}
	l.runProbe("max", time.Now())
	if l.probeTurn("max") != "alpq2" {
		t.Errorf("the abandoned agent probed again: %q", l.probeTurn("max"))
	}
}

// TestProbesTurnRelaunch: a probe agent whose terminal went down while it was held is launched again for its turn: the
// launch's held check lets it past its account's probe blockers.
func TestProbesTurnRelaunch(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alpl1")
	l.fail("alpl1", "overloaded")
	l.until("held", func() bool { return l.agent("alpl1").Lifecycle == "paused" })
	if err := l.tmux.KillSession(l.ctx, "alpl1"); err != nil {
		t.Fatal(err)
	}
	l.runProbe("max", time.Now())
	if l.probeTurn("max") != "alpl1" {
		t.Fatalf("turn %q", l.probeTurn("max"))
	}
	l.until("the relaunch", func() bool { return l.tmux.HasSession(l.ctx, "alpl1") && l.agent("alpl1").Lifecycle == "active" })
	if l.has("alpl1", "launch-held") {
		t.Error("the probe launch was held")
	}
}

// TestProbesResume: at daemon start, a Claude account with an error blocker is probed from the first step, and an
// account the Go daemon doesn't probe isn't. A probe turn running at the restart is taken up again, and its Stop still
// clears the account.
func TestProbesResume(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alpr1")
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "alpr2", Name: "n-alpr2", Role: "developer", Machine: "test-machine", Harness: "codex", Cwd: l.work}); err != nil {
		t.Fatal(err)
	}
	clear := `{"after":"2026-10-21T00:00:00.000Z","class":"transient"}`
	for _, b := range []db.Blocker{{AgentID: "alpr1", Kind: "error", Account: "max", Reason: "a provider error", Clear: &clear},
		{AgentID: "alpr2", Kind: "error", Account: "plus", Reason: "a provider error", Clear: &clear}} {
		if _, _, err := l.db.PutBlocker(l.ctx, b, nil); err != nil {
			t.Fatal(err)
		}
	}
	t0 := time.Now()
	if err := l.life.resumeProbes(l.ctx, ms(t0)); err != nil {
		t.Fatal(err)
	}
	if _, due, _, ok := l.life.nextProbe("max"); !ok || due != ms(t0)+60000 {
		t.Errorf("max %v %v", due, ok)
	}
	if _, _, _, ok := l.life.nextProbe("plus"); ok {
		t.Error("a codex account is probed")
	}

	l2, _ := newProbeLive(t)
	l2.spawn("alpr3")
	l2.fail("alpr3", "overloaded")
	l2.until("held", func() bool { return l2.agent("alpr3").Lifecycle == "paused" })
	l2.runProbe("max", time.Now())
	if l2.agent("alpr3").Lifecycle != "active" {
		t.Fatal("no probe turn")
	}
	l2.restartProbes()
	if err := l2.life.resumeProbes(l2.ctx, ms(time.Now())); err != nil {
		t.Fatal(err)
	}
	if l2.probeTurn("max") != "alpr3" {
		t.Fatalf("turn %q", l2.probeTurn("max"))
	}
	if ok, _ := l2.admitted("alpr3"); !ok {
		t.Error("not admitted")
	}
	l2.answered("alpr3", "Stop")
	l2.until("cleared", func() bool { return l2.of("alpr3", "error") == nil })
}

// TestProbesExemption: the probe exemption admits only the probe agent, and only past its account's probe blockers; an
// agent with another blocker is never picked.
func TestProbesExemption(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alpx1")
	l.spawn("alpx2")
	l.fail("alpx1", "overloaded")
	l.until("both held", func() bool { return l.agent("alpx1").Lifecycle == "paused" && l.agent("alpx2").Lifecycle == "paused" })
	l.addBlocker("alpx2", "budget", "max", "budget spent")
	l.runProbe("max", time.Now())
	if l.probeTurn("max") != "alpx1" {
		t.Fatalf("turn %q", l.probeTurn("max"))
	}
	if ok, _ := l.admitted("alpx1"); !ok {
		t.Error("the probe agent isn't admitted")
	}
	if ok, _ := l.admitted("alpx2"); ok {
		t.Error("another agent on the account is admitted")
	}
	for _, kind := range []string{"budget", "window"} {
		l.addBlocker("alpx1", kind, "max", kind+" hit")
		if ok, reason := l.admitted("alpx1"); ok || !strings.HasPrefix(reason, kind+" on max") {
			t.Errorf("%s: %v %q", kind, ok, reason)
		}
		l.clearBlocker("alpx1", kind, "max", "")
	}
	l.runProbe("max", time.Now())
	if l.probeTurn("max") == "alpx2" || l.agent("alpx2").Lifecycle != "paused" {
		t.Error("the budget-blocked agent probes")
	}
	// It isn't even tried: no probe turn starts on it.
	for _, e := range l.events("alpx2", "cost:probe") {
		if strings.Contains(e, `"turn":true`) || strings.Contains(e, `"error"`) {
			t.Errorf("a probe turn was tried on the budget-blocked agent: %s", e)
		}
	}
}

// TestProbesHumanPauseWins: a human pause that lands while the probe's resume waits on the agent's serial wins: the
// agent stays paused by the human, and no probe turn runs.
func TestProbesHumanPauseWins(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alph1")
	l.fail("alph1", "overloaded")
	l.until("held", func() bool { return l.agent("alph1").Lifecycle == "paused" })
	held, release := make(chan struct{}), make(chan struct{})
	go func() {
		_ = l.life.serial(l.ctx, "alph1", func(context.Context) error {
			close(held)
			<-release
			return nil
		})
	}()
	<-held
	waiting := make(chan struct{}, 1)
	l.life.serialWaiting = func(string) {
		select {
		case waiting <- struct{}{}:
		default:
		}
	}
	done := make(chan struct{})
	go func() { defer close(done); l.runProbe("max", time.Now()) }()
	<-waiting
	l.set("alph1", db.Field{Col: "paused_by", Val: `["human"]`})
	close(release)
	<-done
	if a := l.agent("alph1"); a.Lifecycle != "paused" || strings.Join(pauseOwners(a), ",") != "human" {
		t.Errorf("%s %v", a.Lifecycle, pauseOwners(a))
	}
	if l.probeTurn("max") != "" {
		t.Error("a probe turn ran")
	}
}

// TestProbesNonClaude: an account the Go daemon can't probe (Codex, OpenRouter) gets no error blocker from a transient
// or auth error, no probe and no mail: nothing here could clear it.
func TestProbesNonClaude(t *testing.T) {
	l, box := newProbeLive(t)
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "alpo1", Name: "n-alpo1", Role: "developer", Machine: "test-machine", Harness: "codex", Cwd: l.work}); err != nil {
		t.Fatal(err)
	}
	for _, class := range []string{"transient", "auth"} {
		if err := l.life.onError(l.ctx, l.agent("alpo1"), class, "turn/completed", ms(time.Now())); err != nil {
			t.Fatal(err)
		}
	}
	if rows := l.blockerRows("alpo1"); len(rows) != 0 {
		t.Errorf("blockers %+v", rows)
	}
	if _, _, _, ok := l.life.nextProbe("plus"); ok || box.count() != 0 {
		t.Errorf("probed %v, %d mails", ok, box.count())
	}
}

// TestProbesClearedElsewhere: blockers cleared another way while a probe runs stop probing without an error.
func TestProbesClearedElsewhere(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alpe1")
	if err := l.life.onError(l.ctx, l.agent("alpe1"), "transient", "failure", ms(time.Now())); err != nil {
		t.Fatal(err)
	}
	running, release := make(chan struct{}), make(chan struct{})
	l.life.prober = func(context.Context, string, config.CostAccount) (probeOutcome, error) {
		close(running)
		<-release
		return "fail", nil
	}
	done := make(chan struct{})
	go func() { defer close(done); l.runProbe("max", time.Now()) }()
	<-running
	l.clearBlocker("alpe1", "error", "max", "fallback continue")
	close(release)
	<-done
	if _, _, _, ok := l.life.nextProbe("max"); ok {
		t.Error("still probing")
	}
}

// holdSerial holds the agent's serial until the returned release is called, and makes waiting receive once a later
// serial call on the agent is about to wait for it.
func (l *live) holdSerial(id string) (waiting <-chan struct{}, release func()) {
	l.t.Helper()
	held, free := make(chan struct{}), make(chan struct{})
	go func() {
		_ = l.life.serial(l.ctx, id, func(context.Context) error { close(held); <-free; return nil })
	}()
	<-held
	w := make(chan struct{}, 1)
	l.life.mu.Lock()
	l.life.serialWaiting = func(got string) {
		if got == id {
			select {
			case w <- struct{}{}:
			default:
			}
		}
	}
	l.life.mu.Unlock()
	return w, func() { close(free) }
}

// TestProbesTurnStale: a probe turn waiting on its agent's serial while the probing ends (a success, or the blockers
// cleared) starts nothing: the agent stays paused, and no turn is recorded.
func TestProbesTurnStale(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alpt1")
	l.fail("alpt1", "overloaded")
	l.until("the agent held", func() bool { return l.of("alpt1", "error") != nil && l.agent("alpt1").Lifecycle == "paused" })
	l.life.costProbes.mu.Lock()
	s := l.life.costProbes.states["max"]
	l.life.costProbes.mu.Unlock()
	waiting, release := l.holdSerial("alpt1")
	done := make(chan error, 1)
	go func() { done <- l.life.startTurn(l.ctx, "max", s, "") }()
	<-waiting
	l.life.costProbes.mu.Lock()
	l.life.stopProbe("max")
	l.life.costProbes.mu.Unlock()
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if a := l.agent("alpt1"); a.Lifecycle != "paused" {
		t.Errorf("lifecycle %s", a.Lifecycle)
	}
	if s.turn != "" || l.countEvents("alpt1", "cost:probe") != 0 {
		t.Errorf("turn %q, events %v", s.turn, l.events("alpt1", "cost:probe"))
	}
}

// TestProbesClearLogged: a success logs the cost:rule clear only for a blocker still there to drop: one cleared another
// way while the success waited on the agent's serial logs nothing.
func TestProbesClearLogged(t *testing.T) {
	l, _ := newProbeLive(t)
	l.spawn("alpl1")
	l.fail("alpl1", "overloaded")
	l.until("the agent held", func() bool { return l.of("alpl1", "error") != nil })
	l.life.costProbes.mu.Lock()
	s, gen := l.life.costProbes.states["max"], l.life.costProbes.gens["max"]
	l.life.costProbes.mu.Unlock()
	waiting, release := l.holdSerial("alpl1")
	done := make(chan error, 1)
	go func() { done <- l.life.probeSucceeded(l.ctx, "max", "a probe of max succeeded", gen, s) }()
	<-waiting
	if _, _, err := l.db.DropBlocker(l.ctx, "alpl1", "error", "max", nil); err != nil {
		t.Fatal(err)
	}
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	for _, e := range l.events("alpl1", "cost:rule") {
		if strings.Contains(e, `"action":"clear"`) {
			t.Errorf("logged a clear: %s", e)
		}
	}
}

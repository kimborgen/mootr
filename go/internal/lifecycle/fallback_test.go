package lifecycle

import (
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/db"
)

// The tests of fallback.go, after test/cost-fallback.test.mjs: a notice arms its fallback, the row is made due by hand,
// and an evaluation runs it, as the timer would.

// fallbackOf is the agent's newest fallback row as "state|result".
func (l *live) fallbackOf(agent string) string {
	l.t.Helper()
	return l.query("SELECT state, COALESCE(result, '') FROM cost_fallbacks WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1", agent)
}

// due makes every pending fallback due and runs an evaluation, as its timer would.
func (l *live) due(life *Lifecycle) {
	l.t.Helper()
	l.exec("UPDATE cost_fallbacks SET due_at = 0 WHERE state = 'pending'")
	life.evaluateFallbacks(l.ctx, time.Now())
}

// TestFallbackArmed: a blocker-set notice arms one fallback for the blocker's generation, due cost.fallbackMinutes
// later; a blocker kind with no action field (manual) arms none.
func TestFallbackArmed(t *testing.T) {
	l, _ := newCostLive(t, `{"chiefOfStaff":"n-cos","cost":{"fallbackMinutes":2,"accounts":{"max":{"match":{"harness":"claude"}}}}}`)
	l.member("cos", "")
	l.member("dev", "cos")
	before := time.Now().UnixMilli()
	b := l.addBlocker("dev", "error", "max", "a provider error")
	id := l.noticeID("blocker-set")
	got := l.query("SELECT notice_id, agent_id, kind, account, blocker_since, state, attempts, due_at FROM cost_fallbacks")
	parts := strings.Split(got, "|")
	if len(parts) != 8 || strings.Join(parts[:7], "|") != id+"|dev|error|max|"+b.Since+"|pending|0" {
		t.Fatalf("row %s", got)
	}
	if due, _ := strconv.ParseInt(parts[7], 10, 64); due < before+120_000 || due > time.Now().UnixMilli()+120_000 {
		t.Errorf("due %d", due)
	}
	l.addBlocker("dev", "manual", "", "paused by the manager")
	if n := l.query("SELECT count(*) FROM cost_fallbacks"); n != "1" {
		t.Errorf("rows %s", n)
	}
}

// TestFallbackRuns: past its time a fallback applies the account's action, here cost.onError's default soft-stop, which
// works as wait; the chief of staff hears what ran, with the agent's managers. A notice its manager acked in time runs
// nothing.
func TestFallbackRuns(t *testing.T) {
	l, box := newCostLive(t, costSettings)
	l.member("cos", "")
	l.member("cost", "cos")
	l.member("dev", "cost")
	l.member("dev2", "cost")
	l.addBlocker("dev", "error", "max", "a provider error")
	id := l.noticeID("blocker-set")
	l.addBlocker("dev2", "error", "max", "a provider error")
	acked := l.noticeID("blocker-set")
	if r, _ := l.life.AckCostNotice(l.ctx, acked, "cost", "cost_ack"); !r.OK {
		t.Fatal(r)
	}
	l.until("the notices' mail", func() bool { return len(box.mails()) == 2 })
	l.due(l.life)
	result := "waited: the admission gate already holds n-dev, so soft-stop works as wait; n-dev stays held until its error blocker clears"
	if got := l.fallbackOf("dev"); got != "done|"+result {
		t.Errorf("row %s", got)
	}
	if got := l.fallbackOf("dev2"); got != "done|skipped: n-cost acted on it" {
		t.Errorf("acked row %s", got)
	}
	if got := strings.Join(l.events("dev", "cost:fallback"), " "); got != `{"step":"start","event":"`+id+`","action":"soft-stop"} {"step":"done","event":"`+id+`","result":"`+result+`","told":"n-cos"}` {
		t.Errorf("events %s", got)
	}
	if l.countEvents("dev2", "cost:fallback") != 0 {
		t.Error("the acked fallback ran")
	}
	if e := lastEvent(t, l, "cos", "cost:fallback-told"); e != `{"agent":"n-dev","event":"`+id+`"}` {
		t.Errorf("told %s", e)
	}
	l.until("the chief of staff's mail", func() bool { return len(box.mails()) == 3 })
	want := "cos|[stam] Cost fallback ran for n-dev: soft-stop|[stam] Cost fallback for n-dev: no manager acted on cost notice " + id +
		" (error on max) within 15 minutes, so stam applied the fallback, soft-stop (onError).\n\nResult: " + result + "\n\nn-dev's managers: n-cost."
	if m := box.mails()[2]; !strings.HasPrefix(m, want) {
		t.Errorf("mail\n%s\nwant prefix\n%s", m, want)
	}
	if l.agent("dev").Lifecycle == "active" {
		t.Error("the agent runs")
	}
}

// TestFallbackTakeOver: the Go daemon has no cost_switch, so a take-over runs its else action, and the notice and the
// result say so. With else continue on a paid account the blocker is removed (cost:override), so the agent never sits
// with nothing done; with else wait it stays held.
func TestFallbackTakeOver(t *testing.T) {
	l, box := newCostLive(t, `{"chiefOfStaff":"n-cos","cost":{"accounts":{
		"max":{"match":{"harness":"claude"},"paid":true,"onError":{"action":"take-over","to":["other"],"else":"continue"},"onSubExhausted":{"action":"take-over","to":["other"]}},
		"other":{"match":{"harness":"codex"}}}}}`)
	l.member("cos", "")
	l.spawn("alft1", "cos")
	l.addBlocker("alft1", "error", "max", "a provider error")
	id := l.noticeID("blocker-set")
	l.until("the notice", func() bool { return len(box.mails()) == 1 })
	if m := box.mails()[0]; !strings.Contains(m, "stam applies the fallback: take over to other, else continue (max.onError). The take-over isn't in the Go daemon yet, so stam applies continue instead.") {
		t.Errorf("notice %s", m)
	}
	l.due(l.life)
	result := "take-over isn't in the Go daemon yet; then continued: removed n-alft1's error blocker on paid account max (cost:override)"
	if got := l.fallbackOf("alft1"); got != "done|"+result {
		t.Errorf("row %s", got)
	}
	if e := lastEvent(t, l, "alft1", "cost:override"); e != `{"blockers":[{"kind":"error","account":"max"}],"by":"stam","fallback":"`+id+`"}` {
		t.Errorf("override %s", e)
	}
	if l.of("alft1", "error") != nil {
		t.Error("the else action left the blocker")
	}
	l.until("the agent resumed", func() bool { return l.agent("alft1").Lifecycle == "active" })

	l.addBlocker("alft1", "window", "max", "five_hour at 100%")
	l.due(l.life)
	if got := l.fallbackOf("alft1"); got != "done|take-over isn't in the Go daemon yet; then waited: n-alft1 stays held until its window blocker clears" {
		t.Errorf("row %s", got)
	}
	if l.of("alft1", "window") == nil || l.agent("alft1").Lifecycle != "paused" {
		t.Error("the else wait let the agent go")
	}
}

// TestFallbackTakeOverMatchesTS names the gap (S-3687): a take-over moves the work in TS (src/cost-switch.ts), not here.
func TestFallbackTakeOverMatchesTS(t *testing.T) {
	t.Skip("not in the Go daemon yet (S-3687): the take-over (src/cost-fallback.ts through src/cost-switch.ts) and the reviewer's take-over and relaunch (review.fallback); a take-over runs its else action")
}

// TestFallbackContinue: continue removes the blocker only on a paid account; on another it works as wait, and it never
// lifts a budget blocker.
func TestFallbackContinue(t *testing.T) {
	l, _ := newCostLive(t, `{"chiefOfStaff":"n-cos","cost":{"onError":"continue","accounts":{"max":{"match":{"harness":"claude"},"paid":false,"onBudgetExhausted":"continue"}}}}`)
	l.member("cos", "")
	l.member("dev", "cos")
	l.addBlocker("dev", "error", "max", "a provider error")
	l.due(l.life)
	if got := l.fallbackOf("dev"); got != "done|waited: continue needs paid: true on max, so it works as wait; n-dev stays held until its error blocker clears" {
		t.Errorf("row %s", got)
	}
	l.addBlocker("dev", "budget", "max", "the budget is spent")
	l.due(l.life)
	if got := l.fallbackOf("dev"); got != "done|waited: a spent budget is lifted only by a period rollover or a raise by the human, so continue works as wait; n-dev stays held until its budget blocker clears" {
		t.Errorf("row %s", got)
	}
	if l.of("dev", "error") == nil || l.of("dev", "budget") == nil || l.countEvents("dev", "cost:override") != 0 {
		t.Error("a blocker was lifted")
	}
}

// TestFallbackGeneration: a timer belongs to one blocker generation. A clear retires it, and a newer blocker of the same
// kind skips it.
func TestFallbackGeneration(t *testing.T) {
	l, _ := newCostLive(t, costSettings)
	l.member("cos", "")
	l.member("dev", "cos")
	l.member("dev2", "cos")
	l.addBlocker("dev", "error", "max", "a provider error")
	l.clearBlocker("dev", "error", "max", "a probe succeeded")
	if got := l.fallbackOf("dev"); got != "done|skipped: the blocker cleared" {
		t.Errorf("cleared row %s", got)
	}
	l.addBlocker("dev2", "error", "max", "a provider error")
	l.exec("UPDATE blockers SET since = '2099-01-01T00:00:00.000Z' WHERE agent_id = 'dev2'")
	l.due(l.life)
	if got := l.fallbackOf("dev2"); got != "done|skipped: the blocker was replaced by a newer one" {
		t.Errorf("replaced row %s", got)
	}
	if l.countEvents("dev", "cost:fallback")+l.countEvents("dev2", "cost:fallback") != 0 {
		t.Error("a fallback ran")
	}
}

// TestFallbackRestart: the rows outlive the daemon, and none runs twice. One that came due while it was down runs once
// at start, and a further start doesn't run it again; two evaluations at once run it once. A claimed row (nothing done
// yet) runs again; a running row is reconciled and retried once, and a second interruption gives up.
func TestFallbackRestart(t *testing.T) {
	l, _ := newCostLive(t, costSettings)
	l.member("cos", "")
	l.member("dev", "cos")
	l.member("dev2", "cos")
	l.member("dev3", "cos")
	l.member("dev4", "cos")
	for _, id := range []string{"dev", "dev2", "dev3", "dev4"} {
		l.addBlocker(id, "error", "max", "a provider error")
	}
	start := func() *Lifecycle {
		life := New(l.ctx, l.opts)
		life.startFallbacks(l.ctx)
		return life
	}
	l.exec("UPDATE cost_fallbacks SET due_at = 0 WHERE agent_id = 'dev'")
	l.exec("UPDATE cost_fallbacks SET state = 'claimed', ran_at = 'x' WHERE agent_id = 'dev2'")
	l.exec(`UPDATE cost_fallbacks SET state = 'running', prior = '{"lifecycle":"paused","owners":[]}' WHERE agent_id = 'dev3'`)
	l.exec(`UPDATE cost_fallbacks SET state = 'running', attempts = 1, prior = '{"lifecycle":"paused","owners":[]}' WHERE agent_id = 'dev4'`)
	l.exec("UPDATE cost_fallbacks SET due_at = 0 WHERE agent_id IN ('dev2', 'dev3', 'dev4')")
	start()
	waited := "done|waited: the admission gate already holds n-%s, so soft-stop works as wait; n-%s stays held until its error blocker clears"
	for _, id := range []string{"dev", "dev2", "dev3"} {
		if got := l.fallbackOf(id); got != strings.ReplaceAll(waited, "%s", id) {
			t.Errorf("%s row %s", id, got)
		}
	}
	if got := l.fallbackOf("dev4"); got != "done|failed: interrupted by a daemon restart twice" {
		t.Errorf("dev4 row %s", got)
	}
	if got := strings.Join(l.events("dev3", "cost:fallback"), " "); !strings.HasPrefix(got, `{"step":"recovered","event":"`) || !strings.Contains(got, `"attempts":0} {"step":"start"`) {
		t.Errorf("dev3 events %s", got)
	}
	if got := l.query("SELECT attempts FROM cost_fallbacks WHERE agent_id = 'dev3'"); got != "1" {
		t.Errorf("dev3 attempts %s", got)
	}
	start()
	for _, id := range []string{"dev", "dev2", "dev3"} {
		if n := l.countEvents(id, "cost:fallback"); (id == "dev3" && n != 3) || (id != "dev3" && n != 2) {
			t.Errorf("%s ran again: %d events", id, n)
		}
	}

	// Two daemons' evaluations at once: the claim lets one run it.
	l.member("dev5", "cos")
	l.addBlocker("dev5", "error", "max", "a provider error")
	l.exec("UPDATE cost_fallbacks SET due_at = 0 WHERE agent_id = 'dev5'")
	other := New(l.ctx, l.opts)
	var wg sync.WaitGroup
	for _, life := range []*Lifecycle{l.life, other} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			life.evaluateFallbacks(l.ctx, time.Now())
		}()
	}
	wg.Wait()
	if n := l.countEvents("dev5", "cost:fallback"); n != 2 {
		t.Errorf("dev5 events %d", n)
	}
}

// TestFallbackRecoverRace: recovery can't race a live evaluation into running a row twice. No timer is set before the
// start's recovery has run, and a run whose claim a recovery put back to pending stops before it acts; the row then
// runs once.
func TestFallbackRecoverRace(t *testing.T) {
	l, _ := newCostLive(t, costSettings)
	l.member("cos", "")
	l.member("dev", "cos")
	l.addBlocker("dev", "error", "max", "a provider error")
	id := l.noticeID("blocker-set")

	fresh := New(l.ctx, l.opts)
	fresh.scheduleFallbacks(l.ctx)
	if fresh.fallbackTimer != nil {
		t.Error("a timer was set before the recovery")
	}
	fresh.recoverAtStart(l.ctx)
	fresh.scheduleFallbacks(l.ctx)
	if fresh.fallbackTimer == nil {
		t.Error("no timer after the recovery")
	} else {
		fresh.fallbackTimer.Stop()
	}

	// An evaluation claims the row; a recovery puts it back to pending before the run marks it running.
	if claimed, err := l.db.ClaimFallback(l.ctx, id, iso(time.Now())); err != nil || !claimed {
		t.Fatal(claimed, err)
	}
	fresh.recoverAtStart(l.ctx)
	if ok, err := l.db.RunFallback(l.ctx, id, `{"lifecycle":"paused","owners":[]}`); err != nil || ok {
		t.Errorf("the run went on after the recovery: %v %v", ok, err)
	}
	if got := l.fallbackOf("dev"); got != "pending|" {
		t.Errorf("row %s", got)
	}
	l.due(l.life)
	if n := l.countEvents("dev", "cost:fallback"); n != 2 {
		t.Errorf("%d cost:fallback events, want one run", n)
	}
}

// TestFallbackCancel: an explicit shut-down ends the agent's pending fallback at once, and a claimed or running one
// cancels before it acts; the claim refuses an archived agent, or one with an archive or shut-down pending.
func TestFallbackCancel(t *testing.T) {
	l, _ := newCostLive(t, costSettings)
	l.member("cos", "")
	for _, id := range []string{"dev", "dev2", "dev3", "dev4"} {
		l.member(id, "cos")
		l.addBlocker(id, "error", "max", "a provider error")
	}
	if err := l.life.CancelFallbacks(l.ctx, "dev", "the agent was shut down"); err != nil {
		t.Fatal(err)
	}
	if got := l.fallbackOf("dev"); got != "done|skipped: the agent was shut down" {
		t.Errorf("pending row %s", got)
	}
	l.exec("UPDATE cost_fallbacks SET state = 'running' WHERE agent_id = 'dev2'")
	if err := l.life.CancelFallbacks(l.ctx, "dev2", "the agent was shut down"); err != nil {
		t.Fatal(err)
	}
	r, ok, err := l.db.Fallback(l.ctx, l.query("SELECT notice_id FROM cost_fallbacks WHERE agent_id = 'dev2'"))
	if err != nil || !ok {
		t.Fatal(err)
	}
	if why, _ := l.life.unwanted(l.ctx, r); why != "the agent was shut down" {
		t.Errorf("running row's check %q", why)
	}
	l.set("dev3", db.Field{Col: "lifecycle", Val: "archived"})
	l.set("dev4", db.Field{Col: "pending_action", Val: `{"type":"shutdown"}`})
	l.due(l.life)
	for _, id := range []string{"dev3", "dev4"} {
		if got := l.fallbackOf(id); got != "done|skipped: the agent is archived, or its archive or shut-down is pending" {
			t.Errorf("%s row %s", id, got)
		}
	}
}

// TestFallbackChiefBlocked: when the chief of staff is blocked, or is the blocked agent, the human gets the fallback's
// news as mail, saying why.
func TestFallbackChiefBlocked(t *testing.T) {
	l, box := newCostLive(t, costSettings)
	// The chief of staff has a manager of its own here, so its blocker has a notice and a fallback.
	l.member("boss", "")
	l.member("cos", "boss")
	l.member("dev", "cos")
	l.addBlocker("cos", "error", "max", "a provider error")
	l.addBlocker("dev", "error", "max", "a provider error")
	l.until("the notices", func() bool { return len(box.mails()) == 2 })
	// Running while still blocked, as a probe turn does: its blockers alone make it unreachable.
	l.set("cos", db.Field{Col: "lifecycle", Val: "active"})
	l.due(l.life)
	l.until("the human's mails", func() bool { return len(box.mails()) == 4 })
	var human []string
	for _, m := range box.mails()[2:] {
		if strings.HasPrefix(m, "human|[stam] Cost fallback ran for ") {
			human = append(human, m)
		}
	}
	joined := strings.Join(human, "\n---\n")
	if len(human) != 2 || !strings.Contains(joined, "The chief of staff is the blocked agent, so this reaches you instead.") ||
		!strings.Contains(joined, "The chief of staff is unavailable or blocked, so this reaches you instead.") {
		t.Errorf("human mail %s", joined)
	}
	if !strings.HasSuffix(lastEvent(t, l, "dev", "cost:fallback"), `"told":"human"}`) {
		t.Errorf("told %s", lastEvent(t, l, "dev", "cost:fallback"))
	}
}

// TestFallbackChiefContinued: a chief of staff whose own fallback continued on a paid account is active and unblocked
// again, but it is still the blocked agent, so the human hears what ran, not the chief itself.
func TestFallbackChiefContinued(t *testing.T) {
	l, box := newCostLive(t, `{"chiefOfStaff":"n-cos","cost":{"onError":"continue","accounts":{"max":{"match":{"harness":"claude"},"paid":true}}}}`)
	l.member("boss", "")
	l.member("cos", "boss")
	l.addBlocker("cos", "error", "max", "a provider error")
	l.until("the notice", func() bool { return len(box.mails()) == 1 })
	l.due(l.life)
	if l.of("cos", "error") != nil || l.agent("cos").Lifecycle != "active" {
		t.Fatalf("continue left the chief of staff %s with its blocker %v", l.agent("cos").Lifecycle, l.of("cos", "error"))
	}
	if !strings.HasSuffix(lastEvent(t, l, "cos", "cost:fallback"), `"told":"human"}`) {
		t.Errorf("told %s", lastEvent(t, l, "cos", "cost:fallback"))
	}
	if l.countEvents("cos", "cost:fallback-told") != 0 {
		t.Error("the chief of staff was told of its own fallback")
	}
	// The clear's notice goes to boss; the fallback's news to the human.
	var human []string
	l.until("the human's mail", func() bool {
		human = nil
		for _, m := range box.mails() {
			if strings.HasPrefix(m, "human|") {
				human = append(human, m)
			}
		}
		return len(human) > 0
	})
	if len(human) != 1 || !strings.HasPrefix(human[0], "human|[stam] Cost fallback ran for n-cos: continue|") || !strings.HasSuffix(human[0], "The chief of staff is the blocked agent, so this reaches you instead.") {
		t.Errorf("human mail %q", human)
	}
}

package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

const unpaidMax = `{"cost":{"accounts":{"max":{"match":{"harness":"claude"},"paid":false}}}}`

// reading stores a subscriptions reading taken at at.
func (l *live) reading(name, data string, at time.Time) {
	l.t.Helper()
	if err := l.db.SaveSubscription(l.ctx, name, data, iso(at)); err != nil {
		l.t.Fatal(err)
	}
}

// rules runs one evaluation of the account's rules at now and waits for it.
func (l *live) rules(account string, tr Trigger, now time.Time) {
	l.t.Helper()
	<-l.life.EvaluateRules(account, tr, now)
}

func (l *live) clearOf(id string) string {
	l.t.Helper()
	rows := l.blockerRows(id)
	if len(rows) != 1 {
		l.t.Fatalf("%s has %d blockers", id, len(rows))
	}
	return deref(rows[0].Clear)
}

// TestRulesWindow: a fresh reading at 100% on a paid: false account blocks its agents with the window and its reset,
// once (a second evaluation writes nothing); the clear condition is the text TS stores. A fresh reading below 100%
// taken after it clears it and resumes the agent, and records the clear; the window re-setting within the flap window
// is held flapWindow more, and the account wakes at the hold's end.
func TestRulesWindow(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	l.spawn("alrw1")
	l.idle("alrw1")
	now := time.Now().Truncate(time.Millisecond)
	resets := now.Add(time.Hour).Unix()
	read := now.Add(-time.Minute)
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%d},"seven_day":{"used_percentage":40,"resets_at":%d}}`, resets, resets+86400), read)
	l.rules("max", Trigger{}, now)
	reason := "five_hour at 100%, resets " + utcSec(float64(resets))
	if rows := l.blockerRows("alrw1"); len(rows) != 1 || rows[0].Kind != "window" || rows[0].Account != "max" || rows[0].Reason != reason {
		t.Fatalf("blockers %+v", rows)
	}
	if got, want := l.clearOf("alrw1"), fmt.Sprintf(`{"windows":{"five_hour":{"pct":100,"resets_at":%d,"after":"%s"}}}`, resets, iso(read)); got != want {
		t.Errorf("clear\n got %s\nwant %s", got, want)
	}
	if e := lastEvent(t, l, "alrw1", "cost:rule"); e != `{"rule":"window","account":"max","action":"set","reason":"`+reason+`"}` {
		t.Errorf("cost:rule %s", e)
	}
	if a := l.agent("alrw1"); a.Lifecycle != "paused" {
		t.Errorf("lifecycle %s", a.Lifecycle)
	}
	if due, ok := l.life.pendingWake("max"); !ok || due != float64(resets)*1000+60000 {
		t.Errorf("wake %v %v", due, ok)
	}
	rules, adds := l.countEvents("alrw1", "cost:rule"), l.countEvents("alrw1", "blocker:add")
	l.rules("max", Trigger{}, now.Add(time.Second))
	if l.countEvents("alrw1", "cost:rule") != rules || l.countEvents("alrw1", "blocker:add") != adds {
		t.Error("an unchanged evaluation wrote")
	}

	cleared := now.Add(2 * time.Minute)
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":40,"resets_at":%d}}`, resets), now.Add(time.Minute))
	l.rules("max", Trigger{}, cleared)
	if rows := l.blockerRows("alrw1"); len(rows) != 0 {
		t.Fatalf("after a fresh reading below 100%%: %+v", rows)
	}
	if e := lastEvent(t, l, "alrw1", "cost:rule"); e != `{"rule":"window","account":"max","action":"clear","reason":"`+reason+`","cleared":"a fresh reading"}` {
		t.Errorf("cost:rule %s", e)
	}
	if got := l.query("SELECT window, at FROM window_clears WHERE account = 'max'"); got != fmt.Sprintf("five_hour|%d", cleared.UnixMilli()) {
		t.Errorf("window_clears %s", got)
	}
	l.until("the resume", func() bool { return l.agent("alrw1").Lifecycle == "active" })

	// Back at 100% three minutes after the clear: held ten minutes more.
	again := now.Add(5 * time.Minute)
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%d}}`, resets), now.Add(4*time.Minute))
	l.rules("max", Trigger{}, again)
	hold := again.Add(flapWindow).UnixMilli()
	if got, want := l.clearOf("alrw1"), fmt.Sprintf(`{"windows":{"five_hour":{"pct":100,"resets_at":%d,"after":"%s","hold":%d}}}`, resets, iso(now.Add(4*time.Minute)), hold); got != want {
		t.Errorf("flap clear\n got %s\nwant %s", got, want)
	}
	if due, _ := l.life.pendingWake("max"); due != float64(hold) {
		t.Errorf("wake %v, want the hold's end %d", due, hold)
	}
	// A reading below 100% within the hold clears nothing.
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":10,"resets_at":%d}}`, resets), now.Add(6*time.Minute))
	l.rules("max", Trigger{}, now.Add(7*time.Minute))
	if len(l.blockerRows("alrw1")) != 1 {
		t.Error("a reading inside the hold cleared it")
	}
}

// TestRulesPaidAccountUnblocked: a paid account at 100% sets no window blocker, and an agent on no account none at all.
func TestRulesPaidAccountUnblocked(t *testing.T) {
	l := newLive(t)
	l.setSettings(`{"cost":{"accounts":{"max":{"match":{"harness":"claude"},"paid":true}}}}`)
	l.spawn("alrp1")
	now := time.Now()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%d}}`, now.Add(time.Hour).Unix()), now)
	l.rules("max", Trigger{}, now)
	if len(l.blockerRows("alrp1")) != 0 {
		t.Error("a paid account was blocked")
	}
}

// TestRulesNoResetTime: a window at 100% with no reset time sets nothing (nothing here would clear it), and a paid
// spend with no window that has a reset time sets no paid-forbidden.
func TestRulesNoResetTime(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	l.spawn("alrn1")
	now := time.Now()
	l.reading("claude", `{"five_hour":{"used_percentage":100}}`, now)
	l.rules("max", Trigger{Paid: &Paid{Source: "n-alrn1's cost grew $0.5000 while a window read 100%"}}, now)
	if rows := l.blockerRows("alrn1"); len(rows) != 0 {
		t.Errorf("blockers %+v", rows)
	}
}

// TestRulesLimitSignal: a Claude StopFailure rate_limit is recorded and, with no fresh window to name, holds the
// account for the default 30 minutes ('*', an account hold, a wake at its end), where TS would wait for a reading that
// a paused account never sends. With a fresh window, the one that resets soonest is the deadline.
func TestRulesLimitSignal(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	l.spawn("alrl1")
	before := time.Now()
	if _, err := l.life.OnHook(l.ctx, "claude", l.agent("alrl1"), jsjson.NewObject("hook_event_name", "StopFailure", "error", "rate_limit"), new([]int64)); err != nil {
		t.Fatal(err)
	}
	if e := lastEvent(t, l, "alrl1", "cost:signal"); e != `{"source":"StopFailure","class":"limit","error":"rate_limit"}` {
		t.Errorf("cost:signal %s", e)
	}
	l.until("the hold", func() bool { return len(l.blockerRows("alrl1")) == 1 })
	source := "StopFailure (rate_limit); no reset time in the message, held 30 minutes"
	if r := l.blockerRows("alrl1")[0]; r.Reason != "limit error ("+source+"): no window named; waits for a fresh reading with every window below 100%" {
		t.Errorf("reason %s", r.Reason)
	}
	var clear struct {
		Windows map[string]struct {
			Pct      *float64 `json:"pct"`
			ResetsAt float64  `json:"resets_at"`
			Source   string   `json:"source"`
		} `json:"windows"`
	}
	text := l.clearOf("alrl1")
	if err := json.Unmarshal([]byte(text), &clear); err != nil {
		t.Fatal(err)
	}
	star := clear.Windows["*"]
	at := star.ResetsAt * 1000
	if star.Pct != nil || star.Source != source || at < float64(before.Add(defaultHold).UnixMilli()) || at > float64(time.Now().Add(defaultHold).UnixMilli()) {
		t.Errorf("clear %s", text)
	}
	if !strings.HasPrefix(text, `{"windows":{"*":{"pct":null,"resets_at":`) {
		t.Errorf("key order %s", text)
	}
	if got := l.query("SELECT source FROM account_holds WHERE account = 'max'"); got != source {
		t.Errorf("account_holds %q", got)
	}
	if due, ok := l.life.pendingWake("max"); !ok || due != at+60000 {
		t.Errorf("wake %v, want %v", due, at+60000)
	}

	// A fresh window not at 100%: it resets soonest, so it is the deadline.
	l2 := newLive(t)
	l2.setSettings(unpaidMax)
	l2.spawn("alrl2")
	now := time.Now()
	resets := now.Add(2 * time.Hour).Unix()
	l2.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":60,"resets_at":%d},"seven_day":{"used_percentage":50,"resets_at":%d}}`, resets, resets+86400), now)
	l2.rules("max", Trigger{Signal: &Signal{Class: "limit", Source: "StopFailure (rate_limit)"}}, now)
	if got, want := l2.clearOf("alrl2"), fmt.Sprintf(`{"windows":{"five_hour":{"pct":60,"resets_at":%d,"after":"%s","source":"StopFailure (rate_limit)"}}}`, resets, iso(now)); got != want {
		t.Errorf("named clear\n got %s\nwant %s", got, want)
	}
	if r := l2.blockerRows("alrl2")[0]; r.Reason != "limit error (StopFailure (rate_limit)): five_hour at 60%, resets "+utcSec(float64(resets)) {
		t.Errorf("named reason %s", r.Reason)
	}
}

// TestRulesClearNeedsFresh: only a fresh reading below 100% clears a window: one at 100% (with no reset time, so it
// sets nothing either) and a stale one below 100% leave it, and the same reading while fresh clears it.
func TestRulesClearNeedsFresh(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	l.spawn("alrf1")
	now := time.Now().Truncate(time.Millisecond)
	resets := now.Add(2 * time.Hour).Unix()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":60,"resets_at":%d}}`, resets), now)
	l.rules("max", Trigger{Signal: &Signal{Class: "limit", Source: "StopFailure (rate_limit)"}}, now)
	if len(l.blockerRows("alrf1")) != 1 {
		t.Fatal("not blocked")
	}
	l.reading("claude", `{"five_hour":{"used_percentage":100,"resets_at":null}}`, now.Add(time.Second))
	l.rules("max", Trigger{}, now.Add(time.Second))
	if len(l.blockerRows("alrf1")) != 1 {
		t.Fatal("a reading at 100% cleared the window")
	}
	took := now.Add(2 * time.Second)
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":60,"resets_at":%d}}`, resets), took)
	l.rules("max", Trigger{}, took.Add(staleReading+time.Second))
	if len(l.blockerRows("alrf1")) != 1 {
		t.Fatal("a stale reading cleared the window")
	}
	l.rules("max", Trigger{}, took)
	l.until("the fresh clear", func() bool { return len(l.blockerRows("alrf1")) == 0 })
}

// TestRulesTimerClears: a window whose reset passed clears on the account's timer with no reading, marked unconfirmed.
func TestRulesTimerClears(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	l.life.resetMargin = 20 * time.Millisecond
	l.spawn("alrt1")
	now := time.Now()
	resets := now.Add(1500 * time.Millisecond).Unix()
	if resets*1000 <= now.UnixMilli() {
		resets++
	}
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%d}}`, resets), now)
	l.rules("max", Trigger{}, now)
	if len(l.blockerRows("alrt1")) != 1 {
		t.Fatal("not blocked")
	}
	l.until("the timer's clear", func() bool { return len(l.blockerRows("alrt1")) == 0 })
	if e := lastEvent(t, l, "alrt1", "cost:rule"); !strings.HasSuffix(e, `"action":"clear","reason":"five_hour at 100%, resets `+utcSec(float64(resets))+`","cleared":"`+resetPassed+`","unconfirmed":true}`) {
		t.Errorf("cost:rule %s", e)
	}
}

// TestRulesPaidForbidden: paid spend on a paid: false account sets paid-forbidden until the exhausted window resets;
// the usage report that sees the cost grow while a window reads 100% is that trigger.
func TestRulesPaidForbidden(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	l.spawn("alrf1")
	now := time.Now().Truncate(time.Millisecond)
	resets := now.Add(time.Hour).Unix()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%d}}`, resets), now)
	// The first report's whole cost is growth from no baseline.
	s := "s.jsonl"
	if err := l.life.reportUsage(l.ctx, l.agent("alrf1"), usageReport{counts: [5]*float64{num(0.5)}, session: &s}, now); err != nil {
		t.Fatal(err)
	}
	l.until("paid-forbidden", func() bool { return len(l.blockerRows("alrf1")) == 2 })
	var paid db.Blocker
	for _, b := range l.blockerRows("alrf1") {
		if b.Kind == "paid-forbidden" {
			paid = b
		}
	}
	if paid.Reason != "paid spend on a paid: false account: n-alrf1's cost grew $0.5000 while a window read 100%; clears when five_hour resets "+utcSec(float64(resets)) {
		t.Errorf("reason %s", paid.Reason)
	}
	if got := deref(paid.Clear); !strings.HasPrefix(got, fmt.Sprintf(`{"windows":{"five_hour":{"pct":100,"resets_at":%d,"after":"`, resets)) || !strings.Contains(got, `"}},"after":"`) {
		t.Errorf("clear %s", got)
	}
}

// fakePeers is a PeerReadings with set answers.
type fakePeers struct {
	mu      sync.Mutex
	answers map[string]func() (int, []byte, error)
}

func (f *fakePeers) Peers() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for n := range f.answers {
		out = append(out, n)
	}
	return out
}

func (f *fakePeers) Readings(_ context.Context, peer string) (int, []byte, error) {
	f.mu.Lock()
	a := f.answers[peer]
	f.mu.Unlock()
	return a()
}

func (f *fakePeers) answer(peer string, status int, body string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers[peer] = func() (int, []byte, error) { return status, []byte(body), err }
}

// TestRulesPeerReadings: a peer's fresh reading below 100% for the same account clears a window a local reading set,
// and overtakes that local reading so it sets nothing again. It fails closed: a peer that errors, answers non-200 or
// something that isn't JSON, or serves a window whose percentage, time or reset isn't a number (or names another
// match), clears nothing.
func TestRulesPeerReadings(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	l.spawn("alrr1")
	peers := &fakePeers{answers: map[string]func() (int, []byte, error){}}
	l.life.SetPeerReadings(peers)
	now := time.Now().Truncate(time.Millisecond)
	resets := now.Add(time.Hour).Unix()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%d}}`, resets), now.Add(-2*time.Minute))
	l.rules("max", Trigger{}, now)
	if len(l.blockerRows("alrr1")) != 1 {
		t.Fatal("not blocked")
	}
	peerAt := now.Add(-time.Minute).UnixMilli()
	served := func(win string) string {
		return `{"max":{"match":{"harness":"claude"},"windows":{"five_hour":` + win + `}}}`
	}
	bad := []struct {
		name   string
		status int
		body   string
		err    error
	}{
		{"an error", 0, "", errors.New("down")},
		{"a 500", 500, served(fmt.Sprintf(`{"pct":10,"resets_at":%d,"at":%d}`, resets, peerAt)), nil},
		{"not JSON", 200, "{nope", nil},
		{"not an object", 200, "[1]", nil},
		{"a string pct", 200, served(fmt.Sprintf(`{"pct":"10","resets_at":%d,"at":%d}`, resets, peerAt)), nil},
		{"no at", 200, served(fmt.Sprintf(`{"pct":10,"resets_at":%d}`, resets)), nil},
		{"a string reset", 200, served(fmt.Sprintf(`{"pct":10,"resets_at":"soon","at":%d}`, peerAt)), nil},
		{"no resets_at", 200, served(fmt.Sprintf(`{"pct":10,"at":%d}`, peerAt)), nil},
		{"an infinite pct", 200, served(fmt.Sprintf(`{"pct":-1e999,"resets_at":%d,"at":%d}`, resets, peerAt)), nil},
		{"an infinite reset", 200, served(fmt.Sprintf(`{"pct":10,"resets_at":1e999,"at":%d}`, peerAt)), nil},
		{"another match", 200, `{"max":{"match":{"harness":"claude","model":"x"},"windows":{"five_hour":` + fmt.Sprintf(`{"pct":10,"resets_at":%d,"at":%d}`, resets, peerAt) + `}}}`, nil},
		{"a stale reading", 200, served(fmt.Sprintf(`{"pct":10,"resets_at":%d,"at":%d}`, resets, now.Add(-time.Hour).UnixMilli())), nil},
	}
	for _, c := range bad {
		peers.answer("far", c.status, c.body, c.err)
		l.life.refreshPeerReadings(l.ctx, ms(now))
		l.rules("max", Trigger{}, now)
		if len(l.blockerRows("alrr1")) != 1 {
			t.Fatalf("%s cleared the window", c.name)
		}
		// A bad answer after a good one would keep the good one; start each case clean.
		l.life.mu.Lock()
		l.life.peers = peerState{}
		l.life.mu.Unlock()
	}
	// Not even the stale reading below 100% counts as a reset.
	if got := l.query("SELECT count(*) FROM window_resets"); got != "0" {
		t.Errorf("window_resets from a bad answer: %s", got)
	}
	peers.answer("far", 200, served(fmt.Sprintf(`{"pct":10,"resets_at":%d,"at":%d}`, resets, peerAt)), nil)
	l.life.refreshPeerReadings(l.ctx, ms(now))
	l.until("the peer's clear", func() bool { return len(l.blockerRows("alrr1")) == 0 })
	if got := l.query("SELECT window, at FROM window_resets WHERE account = 'max'"); got != fmt.Sprintf("five_hour|%d", peerAt) {
		t.Errorf("window_resets %s", got)
	}
	// The local 100% reading is older than the peer's: it sets nothing again.
	l.rules("max", Trigger{}, now.Add(time.Second))
	if len(l.blockerRows("alrr1")) != 0 {
		t.Error("an overtaken local reading set the window again")
	}
}

// TestRulesServedReadings: GET /api/usage/readings' body: each account's match and this machine's windows.
func TestRulesServedReadings(t *testing.T) {
	l := newLive(t)
	l.setSettings(`{"cost":{"accounts":{"max":{"match":{"harness":"claude"},"paid":false},"oc":{"match":{"harness":"opencode","model":"openrouter/"}}}}}`)
	at := time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC)
	l.reading("claude", `{"five_hour":{"used_percentage":12.5,"resets_at":1800000000},"seven_day":{"used_percentage":3}}`, at)
	out, err := l.life.ServedReadings(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got := jsjson.Stringify(out, ""); got != fmt.Sprintf(`{"max":{"match":{"harness":"claude"},"windows":{"five_hour":{"pct":12.5,"resets_at":1800000000,"at":%d},"seven_day":{"pct":3,"resets_at":null,"at":%d}}},"oc":{"match":{"harness":"opencode","model":"openrouter/"},"windows":{}}}`, at.UnixMilli(), at.UnixMilli()) {
		t.Errorf("served %s", got)
	}
}

// TestRulesNoSpread: a blocker the TS daemon recorded that nothing here can clear (a window with no reset) stays on its
// agent and isn't added to the account's other agents, nor to a new one. A Claude credits-out it recorded spreads: the
// account's probe clears it.
func TestRulesNoSpread(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	l.spawn("alro1")
	l.spawn("alro2")
	noReset := `{"windows":{"*":{"pct":null,"resets_at":null,"after":"2026-10-21T00:00:00.000Z","source":"turn/completed"}}}`
	credits := `{"after":"2026-10-21T00:00:00.000Z"}`
	for _, b := range []db.Blocker{{AgentID: "alro1", Kind: "window", Account: "max", Reason: "ts window", Clear: &noReset},
		{AgentID: "alro1", Kind: "credits-out", Account: "max", Reason: "a credits error", Clear: &credits}} {
		if _, _, err := l.db.PutBlocker(l.ctx, b, nil); err != nil {
			t.Fatal(err)
		}
	}
	l.rules("max", Trigger{}, time.Now())
	if n := len(l.blockerRows("alro1")); n != 2 {
		t.Errorf("the first agent has %d blockers", n)
	}
	kinds := func(id string) string { return strings.Join(l.life.blockerKinds(l.ctx, id), ",") }
	if got := kinds("alro2"); got != "credits-out" {
		t.Errorf("the second got %q", got)
	}
	l.row("alro3", "")
	if err := l.life.AttachSpawn(l.ctx, l.agent("alro3")); err != nil {
		t.Fatal(err)
	}
	if got := kinds("alro3"); got != "credits-out" {
		t.Errorf("a new agent got %q", got)
	}
}

// TestRulesAttachSpawn: a new agent on a blocked account gets its window blocker before it launches, and the account's
// wake for its reset.
func TestRulesAttachSpawn(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	now := time.Now()
	resets := now.Add(time.Hour).Unix()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%d}}`, resets), now)
	l.row("alra1", "")
	if err := l.life.AttachSpawn(l.ctx, l.agent("alra1")); err != nil {
		t.Fatal(err)
	}
	if rows := l.blockerRows("alra1"); len(rows) != 1 || rows[0].Kind != "window" {
		t.Errorf("blockers %+v", rows)
	}
	// No evaluation armed the account's timer: the attach does, for the reset it waits for.
	if due, ok := l.life.pendingWake("max"); !ok || due != float64(resets*1000+60000) {
		t.Errorf("wake %v %v", due, ok)
	}
	if e := lastEvent(t, l, "alra1", "cost:rule"); !strings.HasPrefix(e, `{"rule":"window","account":"max","action":"set","reason":"five_hour at 100%`) {
		t.Errorf("cost:rule %s", e)
	}
}

// TestRulesAttachRequestGone: the attach runs under the daemon's context, so a spawn request that went away first still
// leaves the new agent with its account's blockers, not half of them.
func TestRulesAttachRequestGone(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	now := time.Now()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%d}}`, now.Add(time.Hour).Unix()), now)
	l.row("alrg1", "")
	ctx, cancel := context.WithCancel(l.ctx)
	cancel()
	if err := l.life.AttachSpawn(ctx, l.agent("alrg1")); err != nil {
		t.Fatal(err)
	}
	if rows := l.blockerRows("alrg1"); len(rows) != 1 || rows[0].Kind != "window" {
		t.Errorf("blockers %+v", rows)
	}
}

// TestRulesAttachSpawnChained: an evaluation that clears the account while a spawn's attach is between its plan and
// its write runs after the attach, so it clears the new agent too instead of leaving it held with no wake.
func TestRulesAttachSpawnChained(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	l.spawn("alrc1")
	now := time.Now().Truncate(time.Millisecond)
	resets := now.Add(time.Hour).Unix()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%d}}`, resets), now)
	l.rules("max", Trigger{}, now)
	if len(l.blockerRows("alrc1")) != 1 {
		t.Fatal("not blocked")
	}
	l.row("alrc2", "")
	waiting := make(chan struct{}, 1)
	l.life.chainWaiting = func(string) {
		select {
		case waiting <- struct{}{}:
		default:
		}
	}
	var cleared <-chan struct{}
	l.life.attaching = func(string) {
		// The clearing reading lands after the attach planned: on the chain, its evaluation queues behind the attach.
		l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":40,"resets_at":%d}}`, resets), now.Add(time.Second))
		cleared = l.life.EvaluateRules("max", Trigger{}, now.Add(time.Second))
		select {
		case <-cleared:
		case <-waiting:
		}
	}
	if err := l.life.AttachSpawn(l.ctx, l.agent("alrc2")); err != nil {
		t.Fatal(err)
	}
	<-cleared
	for _, id := range []string{"alrc1", "alrc2"} {
		if rows := l.blockerRows(id); len(rows) != 0 {
			t.Errorf("%s still held: %+v", id, rows)
		}
	}
}

// TestRulesAttachAfterStop: once the daemon stopped, the rules chain runs nothing, so AttachSpawn fails instead of
// letting a spawn onto a blocked account launch unblocked.
func TestRulesAttachAfterStop(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	now := time.Now()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%d}}`, now.Add(time.Hour).Unix()), now)
	l.row("alrz1", "")
	l.life.mu.Lock()
	l.life.waited = true
	l.life.mu.Unlock()
	if err := l.life.AttachSpawn(l.ctx, l.agent("alrz1")); !errors.Is(err, errStopping) {
		t.Errorf("err %v", err)
	}
}

// TestRulesPeerMalformedWindow: one malformed window rejects a peer's whole answer, so a '*' wait (every window below
// 100%) doesn't clear on the answer's other windows when the malformed one could be the full one.
func TestRulesPeerMalformedWindow(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	l.spawn("alrm1")
	peers := &fakePeers{answers: map[string]func() (int, []byte, error){}}
	l.life.SetPeerReadings(peers)
	now := time.Now().Truncate(time.Millisecond)
	l.rules("max", Trigger{Signal: &Signal{Class: "limit", Source: "StopFailure (rate_limit)"}}, now)
	if !strings.Contains(l.clearOf("alrm1"), `"*"`) {
		t.Fatalf("no '*' wait: %s", l.clearOf("alrm1"))
	}
	resets, peerAt := now.Add(time.Hour).Unix(), now.Add(time.Second).UnixMilli()
	answer := func(seven string) string {
		return fmt.Sprintf(`{"max":{"match":{"harness":"claude"},"windows":{"five_hour":{"pct":10,"resets_at":%d,"at":%d},"seven_day":%s}}}`, resets, peerAt, seven)
	}
	peers.answer("far", 200, answer(fmt.Sprintf(`{"pct":"100","resets_at":%d,"at":%d}`, resets, peerAt)), nil)
	l.life.refreshPeerReadings(l.ctx, ms(now.Add(2*time.Second)))
	l.rules("max", Trigger{}, now.Add(2*time.Second))
	if len(l.blockerRows("alrm1")) != 1 {
		t.Fatal("a malformed window let the '*' wait clear")
	}
	peers.answer("far", 200, answer(fmt.Sprintf(`{"pct":20,"resets_at":%d,"at":%d}`, resets, peerAt)), nil)
	l.life.refreshPeerReadings(l.ctx, ms(now.Add(2*time.Second)))
	l.until("the well-formed clear", func() bool { return len(l.blockerRows("alrm1")) == 0 })
}

// TestRulesLegacyWaitKept: a TS wait with no reset time on one agent doesn't stop a newly exhausted window from
// spreading: the unblocked sibling and a new spawn get the clearable wait alone, with the reset's wake armed, and the
// legacy wait stays on its agent only.
func TestRulesLegacyWaitKept(t *testing.T) {
	l := newLive(t)
	l.setSettings(unpaidMax)
	l.spawn("alrw1")
	l.spawn("alrw2")
	legacy := `{"windows":{"seven_day":{"pct":null,"resets_at":null,"after":"2026-10-21T00:00:00.000Z","source":"turn/completed"}}}`
	if _, _, err := l.db.PutBlocker(l.ctx, db.Blocker{AgentID: "alrw1", Kind: "window", Account: "max", Reason: "ts window", Clear: &legacy}, nil); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Truncate(time.Millisecond)
	resets := now.Add(time.Hour).Unix()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":100,"resets_at":%d}}`, resets), now)
	l.rules("max", Trigger{}, now)
	if c := l.clearOf("alrw1"); !strings.Contains(c, `"seven_day"`) || !strings.Contains(c, `"five_hour"`) {
		t.Errorf("the legacy agent's wait %s", c)
	}
	want := fmt.Sprintf(`{"windows":{"five_hour":{"pct":100,"resets_at":%d,"after":"%s"}}}`, resets, iso(now))
	if c := l.clearOf("alrw2"); c != want {
		t.Errorf("the sibling's wait\n got %s\nwant %s", c, want)
	}
	if due, ok := l.life.pendingWake("max"); !ok || due != float64(resets*1000+60000) {
		t.Errorf("wake %v %v", due, ok)
	}
	sets := len(l.events("alrw2", "cost:rule"))
	l.rules("max", Trigger{}, now.Add(time.Second))
	if c := l.clearOf("alrw2"); c != want || len(l.events("alrw2", "cost:rule")) != sets {
		t.Errorf("a second evaluation changed the sibling: %s", c)
	}
	l.row("alrw3", "")
	if err := l.life.AttachSpawn(l.ctx, l.agent("alrw3")); err != nil {
		t.Fatal(err)
	}
	if c := l.clearOf("alrw3"); c != want {
		t.Errorf("the spawn's wait %s", c)
	}
	// five_hour clears: the agents that waited only for it resume, and the legacy wait stays on its own agent.
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":40,"resets_at":%d}}`, resets), now.Add(2*time.Second))
	l.rules("max", Trigger{}, now.Add(2*time.Second))
	if c := l.clearOf("alrw1"); c != legacy {
		t.Errorf("the legacy agent's wait after the clear %s", c)
	}
	for _, id := range []string{"alrw2", "alrw3"} {
		if rows := l.blockerRows(id); len(rows) != 0 {
			t.Errorf("%s got the legacy wait: %+v", id, rows)
		}
	}
}

type rulesRef struct {
	Reset []struct {
		M   string   `json:"m"`
		Now float64  `json:"now"`
		At  *float64 `json:"at"`
	} `json:"reset"`
	Names  []string `json:"names"`
	Sorted []string `json:"sorted"`
}

// TestRulesMatchTS: parseResetTime and the window names' order match src/rules.ts and Node's localeCompare, in a
// timezone with summer time.
func TestRulesMatchTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/rules.ts")
	}
	zone, err := time.LoadLocation("Europe/Oslo")
	if err != nil {
		t.Skip("no zoneinfo")
	}
	out := filepath.Join(t.TempDir(), "out.json")
	cmd := exec.Command("node", "--no-warnings", "testdata/rulesref.mjs", out)
	cmd.Env = append(os.Environ(), "TZ=Europe/Oslo")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("node: %v\n%s", err, b)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var ref rulesRef
	if err := json.Unmarshal(raw, &ref); err != nil {
		t.Fatal(err)
	}
	local := time.Local
	time.Local = zone
	defer func() { time.Local = local }()
	for _, c := range ref.Reset {
		at, ok := parseResetTime(c.M, c.Now)
		if (c.At == nil) != !ok || (ok && at != *c.At) {
			t.Errorf("parseResetTime(%q, %v) = %v %v, want %v", c.M, c.Now, at, ok, c.At)
		}
	}
	names := append([]string(nil), ref.Names...)
	waits := jsjson.NewObject()
	for _, n := range names {
		waits.Set(n, jsjson.NewObject("pct", 1.0))
	}
	var order []string
	for _, part := range strings.Split(windowReason(waits), "; ") {
		switch {
		case strings.HasPrefix(part, "no window named"):
			order = append(order, "*")
		case strings.HasPrefix(part, "waits for a fresh reading"):
			// The rest of '*''s reason, which has a "; " of its own.
		default:
			order = append(order, part[:strings.Index(part, " at 1%")])
		}
	}
	if strings.Join(order, "|") != strings.Join(ref.Sorted, "|") {
		t.Errorf("order\n got %v\nwant %v", order, ref.Sorted)
	}
}

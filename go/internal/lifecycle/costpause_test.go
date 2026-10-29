package lifecycle

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// The tests of costpause.go, after test/cost-pause.test.mjs: agents are rows with no harness, so a pause only records
// itself and its clear makes the row active again.

const pauseSettings = `{"chiefOfStaff":"n-cos","cost":{"accounts":{"max":{"match":{"harness":"claude"},"paid":false}}}}`

// pauseTree makes cos, mgr under it, root under mgr and child under root, and other outside the tree.
func pauseTree(t *testing.T, settings string) (*live, *costBox) {
	l, box := newCostLive(t, settings)
	l.member("cos", "")
	l.member("mgr", "cos")
	l.member("root", "mgr")
	l.member("child", "root")
	l.member("other", "")
	return l, box
}

func strp(s string) *string { return &s }

func (l *live) pause(o PauseOptions) PauseResult {
	l.t.Helper()
	r, err := l.life.CostPause(l.ctx, o)
	if err != nil {
		l.t.Fatal(err)
	}
	return r
}

// manual is the agent's manual blocker, nil for none.
func (l *live) manual(id string) *db.Blocker { return l.of(id, "manual") }

// TestPauseReset: until=reset holds every agent in the tree with the window closest to 100% and its percentage then; a
// fresh reading taken before the pause clears nothing, nor one at the same percentage; one taken after it and below
// clears the whole tree and resumes it.
func TestPauseReset(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	now := time.Now()
	resets := now.Add(time.Hour).Unix()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":90,"resets_at":%d},"seven_day":{"used_percentage":40,"resets_at":%d}}`, resets, resets+86400), now.Add(-time.Minute))
	r := l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp("reset")})
	reason := "n-mgr paused the tree until max's five_hour (at 90%) resets"
	if r.Action != "paused" || strings.Join(r.Agents, ",") != "n-root,n-child" || r.Until != reason || len(r.Acked) != 0 {
		t.Fatalf("result %+v", r)
	}
	for _, id := range []string{"root", "child"} {
		b := l.manual(id)
		if b == nil || b.Reason != reason || l.agent(id).Lifecycle != "paused" {
			t.Fatalf("%s: %+v %s", id, b, l.agent(id).Lifecycle)
		}
		clear := deref(b.Clear)
		if !strings.HasPrefix(clear, `{"kind":"reset","by":"mgr","after":"`) || !strings.HasSuffix(clear, fmt.Sprintf(`","account":"max","window":"five_hour","pct":90,"resets_at":%d}`, resets)) {
			t.Errorf("%s clear %s", id, clear)
		}
		if e := lastEvent(t, l, id, "cost:pause"); e != `{"action":"set","by":"mgr","reason":"`+reason+`","clear":`+clear+`}` {
			t.Errorf("%s event %s", id, e)
		}
	}
	if l.manual("mgr") != nil || l.manual("other") != nil {
		t.Error("the pause went outside the tree")
	}

	// The same percentage after the pause, or a lower one from before it, clears nothing.
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":90,"resets_at":%d}}`, resets), time.Now().Add(time.Second))
	l.life.EvaluatePauses(l.ctx, time.Now().Add(2*time.Second))
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":10,"resets_at":%d}}`, resets), now.Add(-time.Second))
	l.life.EvaluatePauses(l.ctx, time.Now().Add(2*time.Second))
	if l.manual("root") == nil {
		t.Fatal("a reading that isn't a fresh one below 90% cleared the pause")
	}

	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":40,"resets_at":%d}}`, resets), time.Now().Add(time.Second))
	l.life.EvaluatePauses(l.ctx, time.Now().Add(2*time.Second))
	text := "a fresh reading of five_hour on max is 40%, below the 90% when it was paused"
	for _, id := range []string{"root", "child"} {
		if l.manual(id) != nil || l.agent(id).Lifecycle != "active" {
			t.Errorf("%s still paused", id)
		}
		if e := lastEvent(t, l, id, "cost:pause"); e != `{"action":"clear","cleared":"`+text+`"}` {
			t.Errorf("%s event %s", id, e)
		}
		if e := lastEvent(t, l, id, "blocker:clear"); e != `{"kind":"manual","account":"","cleared":"`+text+`"}` {
			t.Errorf("%s blocker:clear %s", id, e)
		}
	}
	// A second evaluation finds nothing to clear and logs nothing.
	l.life.EvaluatePauses(l.ctx, time.Now().Add(3*time.Second))
	if n := l.countEvents("root", "cost:pause"); n != 2 {
		t.Errorf("%d cost:pause events", n)
	}
}

// TestPauseResetUnconfirmed: with no fresh reading, a reset pause clears once its resets_at plus the margin passes,
// marked unconfirmed; an explicit window with no reading has no percentage, so any fresh reading of it below 100%
// confirms it.
func TestPauseResetUnconfirmed(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	l.life.resetMargin = 20 * time.Millisecond
	now := time.Now()
	resets := now.Add(time.Hour).Unix()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":95,"resets_at":%d}}`, resets), now)
	l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp("reset")})
	l.life.EvaluatePauses(l.ctx, time.Unix(resets, 0).Add(10*time.Millisecond))
	if l.manual("root") == nil {
		t.Fatal("cleared inside the margin")
	}
	at := time.Unix(resets, 0).Add(time.Second)
	l.life.EvaluatePauses(l.ctx, at)
	text := "the five_hour window on max reset (" + iso(time.Unix(resets, 0)) + ") and no fresh reading confirmed it"
	if l.manual("root") != nil || lastEvent(t, l, "root", "cost:pause") != `{"action":"clear","cleared":"`+text+`","unconfirmed":true}` {
		t.Errorf("after the reset: %v %s", l.manual("root"), lastEvent(t, l, "root", "cost:pause"))
	}

	r := l.pause(PauseOptions{Root: "child", By: "mgr", Until: strp("reset"), Window: strp("seven_day"), Reason: strp("weekly quiet")})
	if r.Until != "weekly quiet" {
		t.Errorf("until %q", r.Until)
	}
	if clear := deref(l.manual("child").Clear); !strings.HasSuffix(clear, `","account":"max","window":"seven_day","pct":null,"resets_at":null}`) {
		t.Errorf("clear %s", clear)
	}
	l.reading("claude", `{"seven_day":{"used_percentage":99}}`, time.Now().Add(time.Second))
	l.life.EvaluatePauses(l.ctx, time.Now().Add(2*time.Second))
	if l.manual("child") != nil {
		t.Error("a fresh reading below 100% left the pause")
	}
}

// TestPauseTime: until a time clears when the time passes, by the timer too, and the result names the time.
func TestPauseTime(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	until := time.Now().Add(time.Hour).UTC()
	r := l.pause(PauseOptions{Root: "root", By: "human", Until: strp(until.Format(time.RFC3339Nano)), Reason: strp("quiet hours")})
	if r.Until != "quiet hours" || l.agent("root").Lifecycle != "paused" {
		t.Fatalf("result %+v", r)
	}
	clear := deref(l.manual("root").Clear)
	if !strings.HasPrefix(clear, `{"kind":"time","by":"human","after":"`) || !strings.HasSuffix(clear, `","until":"`+iso(until)+`"}`) {
		t.Errorf("clear %s", clear)
	}
	l.life.EvaluatePauses(l.ctx, until.Add(-time.Second))
	if l.manual("root") == nil {
		t.Fatal("cleared before its time")
	}
	l.life.EvaluatePauses(l.ctx, until)
	if l.manual("root") != nil || lastEvent(t, l, "root", "cost:pause") != `{"action":"clear","cleared":"the set time `+iso(until)+` passed"}` {
		t.Errorf("at its time: %s", lastEvent(t, l, "root", "cost:pause"))
	}

	// The timer: a pause a moment away lifts with no evaluation called.
	soon := time.Now().Add(200 * time.Millisecond)
	l.pause(PauseOptions{Root: "child", By: "mgr", Until: strp(soon.Format(time.RFC3339Nano))})
	// The blocker goes before the resume that follows it in the same serial, so wait for both.
	l.until("the timer's clear and resume", func() bool { return l.manual("child") == nil && l.agent("child").Lifecycle == "active" })
}

// TestPauseStart: a new daemon's evaluation times the pauses it finds stored.
func TestPauseStart(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp(time.Now().Add(time.Hour).Format(time.RFC3339Nano))})
	fresh := New(l.ctx, l.opts)
	fresh.EvaluatePauses(l.ctx, time.Now())
	fresh.pauseMu.Lock()
	timer := fresh.pauseTimer
	fresh.pauseMu.Unlock()
	if timer == nil {
		t.Fatal("no timer for the stored pause")
	}
	timer.Stop()
}

// TestPauseSpawn: an agent spawned under a paused tree, at any depth, inherits the pause, and the tree's clear releases
// it too; one outside the tree inherits nothing.
func TestPauseSpawn(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp(time.Now().Add(time.Hour).Format(time.RFC3339Nano)), Reason: strp("quiet")})
	l.member("late", "child")
	// The pause is found up the chain, past a parent that doesn't carry it.
	l.exec("DELETE FROM blockers WHERE agent_id = 'child'")
	if err := l.life.AttachPause(l.ctx, l.agent("late")); err != nil {
		t.Fatal(err)
	}
	if l.manual("late") == nil || deref(l.manual("late").Clear) != deref(l.manual("root").Clear) {
		t.Fatalf("late inherited %+v", l.manual("late"))
	}
	if e := lastEvent(t, l, "late", "cost:pause"); e != `{"action":"inherited","by":"mgr","reason":"quiet"}` {
		t.Errorf("event %s", e)
	}
	l.member("out", "other")
	if err := l.life.AttachPause(l.ctx, l.agent("out")); err != nil || l.manual("out") != nil {
		t.Errorf("outside the tree: %v %+v", err, l.manual("out"))
	}
	r := l.pause(PauseOptions{Root: "root", By: "mgr", Clear: true})
	if strings.Join(r.Agents, ",") != "n-root,n-late" || l.manual("late") != nil {
		t.Errorf("clear %+v", r)
	}
}

// TestPauseClear: clear lifts the pause early on the whole tree, logs one clear each, and names whom; a second clear
// finds nothing. An archived agent is left out of the tree, but not its live children.
func TestPauseClear(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	l.member("gone", "root")
	l.set("gone", db.Field{Col: "lifecycle", Val: "archived"})
	l.member("under", "gone")
	set := l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp(time.Now().Add(24 * time.Hour).Format(time.RFC3339Nano))})
	if strings.Join(set.Agents, ",") != "n-root,n-child,n-under" || l.manual("gone") != nil {
		t.Fatalf("set %+v, archived %+v", set, l.manual("gone"))
	}
	r := l.pause(PauseOptions{Root: "root", By: "mgr", Clear: true})
	if r.Action != "cleared" || strings.Join(r.Agents, ",") != "n-root,n-child,n-under" || r.Until != "" {
		t.Fatalf("result %+v", r)
	}
	for _, id := range []string{"root", "child"} {
		if l.manual(id) != nil || l.agent(id).Lifecycle != "active" {
			t.Errorf("%s still paused", id)
		}
		if e := lastEvent(t, l, id, "cost:pause"); e != `{"action":"clear","by":"mgr","requested":true}` {
			t.Errorf("%s event %s", id, e)
		}
		if e := lastEvent(t, l, id, "blocker:clear"); e != `{"kind":"manual","account":"","cleared":"cleared by n-mgr"}` {
			t.Errorf("%s blocker:clear %s", id, e)
		}
	}
	if r := l.pause(PauseOptions{Root: "root", By: "human", Clear: true}); len(r.Agents) != 0 || l.countEvents("root", "cost:pause") != 2 {
		t.Errorf("a second clear %+v", r)
	}
}

// TestPausePermissions: the human, stam, the assistant, the chief of staff, an ancestor and the root itself may; an
// unrelated agent and a child may not, and the refusal sets nothing.
func TestPausePermissions(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	l.member("ea", "")
	l.set("ea", db.Field{Col: "kind", Val: "assistant"})
	root := l.agent("root")
	for by, want := range map[string]bool{"human": true, "stam": true, "ea": true, "cos": true, "mgr": true, "root": true, "other": false, "child": false, "gone": false} {
		if got := l.life.mayManageTree(l.ctx, by, root, nil); got != want {
			t.Errorf("mayManageTree(%s) = %v", by, got)
		}
	}
	// The chief of staff manages a tree it isn't above too; a manager only its own.
	l.member("lone", "")
	for by, want := range map[string]bool{"cos": true, "mgr": false} {
		if got := l.life.mayManageTree(l.ctx, by, l.agent("lone"), nil); got != want {
			t.Errorf("mayManageTree(%s, lone) = %v", by, got)
		}
	}
	// A manager on another machine (S-923) may only as the remote manager a peer's forward named: as a boss, or as an
	// ancestor through the parents a peer listed (kid's parent pmid is a peer's agent under far).
	l.member("kid", "pmid")
	if err := l.db.RememberPeerAgent(l.ctx, db.PeerAgentSeen{ID: "pmid", Name: "pmid", Machine: "peer", Parents: []string{"far"}}); err != nil {
		t.Fatal(err)
	}
	kid := l.agent("kid")
	for _, tc := range []struct {
		name   string
		root   db.Agent
		remote *RemoteManager
		want   bool
	}{
		{"no forward", kid, nil, false},
		{"a forward for another agent", kid, &RemoteManager{Agent: "near", Boss: true}, false},
		{"a boss", root, &RemoteManager{Agent: "far", Boss: true}, true},
		{"an ancestor through a peer's parents", kid, &RemoteManager{Agent: "far"}, true},
		{"no ancestor", root, &RemoteManager{Agent: "far"}, false},
	} {
		if got := l.life.mayManageTree(l.ctx, "far", tc.root, tc.remote); got != tc.want {
			t.Errorf("%s: mayManageTree(far) = %v", tc.name, got)
		}
	}
	_, err := l.life.CostPause(l.ctx, PauseOptions{Root: "root", By: "other", Until: strp("reset")})
	if !IsForbidden(err) || err.Error() != "n-other may not manage cost for n-root's tree: only the human, the chief of staff, or a manager of a tree inside its own tree may" {
		t.Errorf("refusal %v", err)
	}
	if len(l.blockerRows("root")) != 0 {
		t.Error("a refused pause set a blocker")
	}
}

// TestPauseErrors: what a pause needs, said back; the call acknowledges the tree's notices first, as in TS.
func TestPauseErrors(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	for _, c := range []struct {
		o    PauseOptions
		want string
	}{
		{PauseOptions{Root: "nobody", By: "human", Until: strp("reset")}, "no agent nobody"},
		{PauseOptions{Root: "root", By: "human"}, "cost_pause needs until=reset or an ISO time, or clear"},
		{PauseOptions{Root: "root", By: "human", Until: strp("soon")}, `until must be "reset" or an ISO time, not "soon"`},
		{PauseOptions{Root: "root", By: "human", Until: strp("reset")}, "no fresh window reading on max; pass window"},
		{PauseOptions{Root: "root", By: "human", Until: strp("reset"), Account: strp("")}, "no cost account in n-root's tree; pass account"},
	} {
		if _, err := l.life.CostPause(l.ctx, c.o); err == nil || err.Error() != c.want || IsForbidden(err) {
			t.Errorf("%+v: %v, want %s", c.o, err, c.want)
		}
	}
	l.setSettings(`{"chiefOfStaff":"n-cos","cost":{"accounts":{"max":{"match":{"harness":"codex"}}}}}`)
	if _, err := l.life.CostPause(l.ctx, PauseOptions{Root: "root", By: "human", Until: strp("reset")}); err == nil || err.Error() != "no cost account in n-root's tree; pass account" {
		t.Errorf("no managed agent: %v", err)
	}
	if len(l.blockerRows("root")) != 0 {
		t.Error("a bad pause set a blocker")
	}
}

// TestPauseClosestWindow: the default window is the fresh one closest to 100%, the higher on a tie; a stale one never.
func TestPauseClosestWindow(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	now := time.Now()
	l.reading("claude", `{"five_hour":{"used_percentage":95},"seven_day":{"used_percentage":105},"opus":{"used_percentage":70}}`, now)
	if w, ok, err := l.life.closestWindow(l.ctx, "max", ms(now)); err != nil || !ok || w != "seven_day" {
		t.Errorf("closest %s %v %v", w, ok, err)
	}
	if _, ok, _ := l.life.closestWindow(l.ctx, "max", ms(now.Add(staleReading+time.Second))); ok {
		t.Error("a stale reading was picked")
	}
}

// TestPauseUntilForms: Date.parse's ISO forms; anything else is refused.
func TestPauseUntilForms(t *testing.T) {
	for in, want := range map[string]string{
		"2026-10-22T10:00:00.000Z":  "2026-10-22T10:00:00.000Z",
		"2026-10-22T12:00:00+02:00": "2026-10-22T10:00:00.000Z",
		"2026-10-22":                "2026-10-22T00:00:00.000Z",
		"2026-10-22T10:00":          iso(time.Date(2026, 10, 22, 10, 0, 0, 0, time.Local)),
		"2026-10-22T10:00:30":       iso(time.Date(2026, 10, 22, 10, 0, 30, 0, time.Local)),
	} {
		if at, ok := parseUntil(in); !ok || iso(at) != want {
			t.Errorf("%s: %s %v, want %s", in, iso(at), ok, want)
		}
	}
	for _, in := range []string{"", "reset", "tomorrow", "10:00"} {
		if _, ok := parseUntil(in); ok {
			t.Errorf("%q parsed", in)
		}
	}
}

// TestPauseAcks: the call acknowledges the tree's open notices, about its agents and account-wide on its account, as
// the acting manager, even when its arguments are bad; notices about another tree or account stay open.
func TestPauseAcks(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	l.addBlocker("child", "error", "max", "a provider error")
	about := l.noticeID("blocker-set")
	l.addBlocker("other", "error", "max", "a provider error")
	outside := l.noticeID("blocker-set")
	for _, n := range []db.CostNotice{{ID: "cn-wide", Key: "window:max", Kind: "window", Account: "max"}, {ID: "cn-else", Key: "window:else", Kind: "window", Account: "else"}} {
		n.Managers, n.CreatedAt = []string{"cos"}, iso(time.Now())
		if _, err := l.db.AddCostNotice(l.ctx, n); err != nil {
			t.Fatal(err)
		}
	}
	_, err := l.life.CostPause(l.ctx, PauseOptions{Root: "root", By: "mgr"})
	if err == nil {
		t.Fatal("no until passed")
	}
	acked := l.query("SELECT id || ':' || COALESCE(acked_by, '') FROM cost_notices ORDER BY id")
	want := []string{about + ":mgr", outside + ":", "cn-else:", "cn-wide:mgr"}
	for _, w := range want {
		if !strings.Contains("\n"+acked+"\n", "\n"+w+"\n") {
			t.Errorf("acks\n%s\nwant %s", acked, w)
		}
	}
	if e := lastEvent(t, l, "mgr", "cost:ack"); e != `{"event":"cn-wide","via":"cost_pause"}` && e != `{"event":"`+about+`","via":"cost_pause"}` {
		t.Errorf("cost:ack %s", e)
	}
	if got := l.query("SELECT state FROM cost_fallbacks WHERE notice_id = ?", about); got != "pending" {
		t.Errorf("fallback %s", got)
	}
	l.due(l.life)
	if got := l.fallbackOf("child"); got != "done|skipped: n-mgr acted on it" {
		t.Errorf("fallback after the ack %s", got)
	}
	r := l.pause(PauseOptions{Root: "root", By: "mgr", Clear: true})
	if len(r.Acked) != 0 {
		t.Errorf("acked twice %v", r.Acked)
	}
}

// TestPausePeerReading: a peer's fresh reading of the same account, taken after the pause and below its percentage,
// clears it as the refresh that brings it in.
func TestPausePeerReading(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	peers := &fakePeers{answers: map[string]func() (int, []byte, error){}}
	l.life.SetPeerReadings(peers)
	now := time.Now()
	resets := now.Add(time.Hour).Unix()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":90,"resets_at":%d}}`, resets), now.Add(-time.Minute))
	l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp("reset")})
	peers.answer("far", 200, fmt.Sprintf(`{"max":{"match":{"harness":"claude"},"windows":{"five_hour":{"pct":20,"resets_at":%d,"at":%d}}}}`, resets, now.Add(time.Second).UnixMilli()), nil)
	l.life.refreshPeerReadings(l.ctx, ms(now.Add(2*time.Second)))
	if l.manual("root") != nil || l.manual("child") != nil {
		t.Error("the peer's reading left the pause")
	}
}

// TestPauseStartRules: the daemon's start evaluates the pauses, which times the stored ones.
func TestPauseStartRules(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp(time.Now().Add(time.Hour).Format(time.RFC3339Nano))})
	timer := func() *time.Timer {
		l.life.pauseMu.Lock()
		defer l.life.pauseMu.Unlock()
		return l.life.pauseTimer
	}
	l.life.pauseMu.Lock()
	l.life.pauseTimer.Stop()
	l.life.pauseTimer = nil
	l.life.pauseMu.Unlock()
	l.life.StartRules()
	l.until("the start's timer", func() bool { return timer() != nil })
}

// TestPauseOnReading: a status line's reading evaluates the pauses.
func TestPauseOnReading(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	resets := time.Now().Add(time.Hour).Unix()
	l.reading("claude", fmt.Sprintf(`{"five_hour":{"used_percentage":90,"resets_at":%d}}`, resets), time.Now().Add(-time.Second))
	l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp("reset")})
	// The reading must be taken after the pause, to the millisecond.
	set := time.Now().UnixMilli()
	l.until("a later millisecond", func() bool { return time.Now().UnixMilli() > set })
	p, err := jsjson.Parse([]byte(fmt.Sprintf(`{"rate_limits":{"five_hour":{"used_percentage":30,"resets_at":%d}}}`, resets)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.life.OnStatusLine(l.ctx, "claude", l.agent("child"), p); err != nil {
		t.Fatal(err)
	}
	l.until("the reading's clear", func() bool { return l.manual("root") == nil && l.manual("child") == nil })
}

// TestPauseFarUntil: a clear time centuries away gets the timer's longest wait, not an overflowed one that fires at once,
// and the pause holds.
func TestPauseFarUntil(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp("9999-12-31")})
	l.life.EvaluatePauses(l.ctx, time.Now())
	l.life.pauseMu.Lock()
	wait := l.life.pauseWait
	l.life.pauseMu.Unlock()
	if wait != maxPauseWait*time.Millisecond {
		t.Errorf("wait %v, want %v", wait, maxPauseWait*time.Millisecond)
	}
	if l.manual("root") == nil || l.countEvents("root", "cost:pause") != 1 {
		t.Error("the far pause cleared")
	}
}

// TestPauseRepausedMidEvaluation: a pause set again between an evaluation's verdict on the old one and its drop stays.
func TestPauseRepausedMidEvaluation(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	until := time.Now().Add(time.Hour)
	l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp(until.Format(time.RFC3339Nano))})
	again := false
	l.life.pauseJudged = func(id string) {
		if again {
			return
		}
		again = true
		if _, err := l.life.CostPause(l.ctx, PauseOptions{Root: "root", By: "mgr", Until: strp(until.Add(24 * time.Hour).Format(time.RFC3339Nano)), Reason: strp("later")}); err != nil {
			t.Error(err)
		}
	}
	l.life.EvaluatePauses(l.ctx, until)
	if !again {
		t.Fatal("no verdict")
	}
	for _, id := range []string{"root", "child"} {
		if b := l.manual(id); b == nil || b.Reason != "later" {
			t.Errorf("%s: the new pause was dropped: %+v", id, b)
		}
	}
}

// TestPauseSpawnMidPause: an agent spawned into the tree after the pause listed it, whose inherit found no pause yet, is
// paused too; one whose inherit found the new pause is named and not set again.
func TestPauseSpawnMidPause(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	until := strp(time.Now().Add(time.Hour).Format(time.RFC3339Nano))
	spawn := func(id string) {
		l.member(id, "child")
		if err := l.life.AttachPause(l.ctx, l.agent(id)); err != nil {
			t.Error(err)
		}
	}
	l.life.pauseListed = func(_ string, again bool) {
		if !again {
			spawn("late")
		}
	}
	r := l.pause(PauseOptions{Root: "root", By: "mgr", Until: until, Reason: strp("quiet")})
	if l.manual("late") == nil || strings.Join(r.Agents, ",") != "n-root,n-child,n-late" {
		t.Errorf("late escaped: %+v %+v", l.manual("late"), r)
	}
	// One spawned after the blockers are set inherits the pause before the second listing.
	l.life.pauseListed = func(_ string, again bool) {
		if again {
			spawn("last")
		}
	}
	r = l.pause(PauseOptions{Root: "child", By: "mgr", Until: until})
	if l.manual("last") == nil || l.countEvents("last", "cost:pause") != 1 || !strings.HasSuffix(strings.Join(r.Agents, ","), ",n-last") {
		t.Errorf("last: %+v, %d events, %+v", l.manual("last"), l.countEvents("last", "cost:pause"), r)
	}
	// One the second listing paused before its own inherit ran isn't logged or set again by the inherit.
	l.life.pauseListed = func(_ string, again bool) {
		if again {
			l.member("dup", "child")
		}
	}
	l.pause(PauseOptions{Root: "child", By: "mgr", Until: until, Reason: strp("dup")})
	if err := l.life.AttachPause(l.ctx, l.agent("dup")); err != nil {
		t.Fatal(err)
	}
	if b := l.manual("dup"); b == nil || b.Reason != "dup" || l.countEvents("dup", "cost:pause") != 1 {
		t.Errorf("dup: %+v, %d events", b, l.countEvents("dup", "cost:pause"))
	}
}

// TestPauseAttachRepaused: a spawn whose inherit read an older pause, which a new pause replaced before the inherit set
// it, carries the new pause, logged once by the new pause's set.
func TestPauseAttachRepaused(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp(time.Now().Add(time.Hour).Format(time.RFC3339Nano)), Reason: strp("first")})
	l.member("new", "child")
	l.life.pauseAttach = func(string) {
		l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp(time.Now().Add(2 * time.Hour).Format(time.RFC3339Nano)), Reason: strp("second")})
	}
	if err := l.life.AttachPause(l.ctx, l.agent("new")); err != nil {
		t.Fatal(err)
	}
	if b := l.manual("new"); b == nil || b.Reason != "second" || l.countEvents("new", "cost:pause") != 1 {
		t.Errorf("new: %+v, %d events", b, l.countEvents("new", "cost:pause"))
	}
}

// TestPauseAttachCleared: a spawn whose inherit read a pause that a clear lifted before the inherit set it starts free.
func TestPauseAttachCleared(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp(time.Now().Add(time.Hour).Format(time.RFC3339Nano))})
	l.member("new", "child")
	l.life.pauseAttach = func(string) { l.pause(PauseOptions{Root: "root", By: "mgr", Clear: true}) }
	if err := l.life.AttachPause(l.ctx, l.agent("new")); err != nil {
		t.Fatal(err)
	}
	if b := l.manual("new"); b != nil {
		t.Errorf("new is held by a cleared pause: %+v", b)
	}
}

// TestPauseSpawnMidClear: a spawn that lands after a clear listed the tree, and inherits the pause from an ancestor the
// clear hasn't reached yet, is cleared by the clear's second listing.
func TestPauseSpawnMidClear(t *testing.T) {
	l, _ := pauseTree(t, pauseSettings)
	l.pause(PauseOptions{Root: "root", By: "mgr", Until: strp(time.Now().Add(time.Hour).Format(time.RFC3339Nano))})
	l.life.pauseListed = func(_ string, again bool) {
		if !again {
			l.member("late", "child")
			if err := l.life.AttachPause(l.ctx, l.agent("late")); err != nil {
				t.Error(err)
			}
			if l.manual("late") == nil {
				t.Error("late didn't inherit the pause")
			}
		}
	}
	r := l.pause(PauseOptions{Root: "root", By: "mgr", Clear: true})
	if b := l.manual("late"); b != nil || strings.Join(r.Agents, ",") != "n-root,n-child,n-late" {
		t.Errorf("late stayed held: %+v %+v", b, r)
	}
}

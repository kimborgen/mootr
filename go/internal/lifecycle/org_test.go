package lifecycle

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/db"
)

// withoutClock drops a notice's clock line (S-3468). TestNoticeClock checks that line on its own, against a fixed clock,
// so the routing checks here read the notice text alone.
func withoutClock(s string) string {
	if i := strings.LastIndex(s, "\nnow "); i >= 0 {
		return s[:i]
	}
	return s
}

func noClocks(notices []string) []string {
	out := make([]string, len(notices))
	for i, n := range notices {
		out[i] = withoutClock(n)
	}
	return out
}

// orgAgent makes an idle active agent row under parent ("" for none), with no harness.
func (l *live) orgAgent(id, parent string) {
	l.t.Helper()
	var p *string
	if parent != "" {
		p = &parent
	}
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: id, Name: "n-" + id, Role: "developer", Machine: "test-machine", Harness: "claude", Cwd: l.work, ParentID: p}); err != nil {
		l.t.Fatal(err)
	}
	l.set(id, db.Field{Col: "lifecycle", Val: "active"}, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: nil})
	// Its parents have heard of this idle period already.
	execOn(l.t, l, "UPDATE agents SET idle_notified = idle_since WHERE id = '"+id+"'")
}

// orgSettle waits until the org goroutine has handled every change so far.
func (l *live) orgSettle() {
	l.t.Helper()
	l.until("the org observers", l.life.orgSettled)
}

func (l *live) children(id string) string {
	l.t.Helper()
	for _, w := range l.waits(id) {
		if isChildrenWait(w) {
			return deref(w.Detail)
		}
	}
	return ""
}

func (l *live) turnEnds(id string) {
	l.t.Helper()
	l.set(id, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "turn finished"})
}

// TestOrgChildrenWaits: a busy descendant gives each agent above it a 'children' wait counting its busy descendants,
// which turns an idle one waiting; when the last goes quiet the waits clear up the tree, and each quiet agent's
// tree-idle parents hear once.
func TestOrgChildrenWaits(t *testing.T) {
	l := newLive(t)
	l.orgAgent("alo1", "")
	l.orgAgent("alo2", "alo1")
	l.orgAgent("alo3", "alo2")
	l.life.StartOrg()
	l.orgSettle()
	l.set("alo3", db.Field{Col: "activity", Val: "working"})
	l.orgSettle()
	if got := l.children("alo2") + "|" + l.children("alo1"); got != "1 child|2 children" {
		t.Errorf("children waits %s", got)
	}
	if a := l.agent("alo2"); a.Activity != "waiting" || detailOf(a) != "waiting for 1 child" {
		t.Errorf("alo2: %s %q", a.Activity, detailOf(a))
	}
	l.turnEnds("alo3")
	l.orgSettle()
	if got := l.children("alo2") + "|" + l.children("alo1"); got != "|" {
		t.Errorf("children waits after the turn %s", got)
	}
	if a := l.agent("alo1"); a.Activity != "idle" {
		t.Errorf("alo1: %s %q", a.Activity, detailOf(a))
	}
	want3 := l.render("child-turn-finished", map[string]string{"child": "n-alo3", "last": "(not reported)"})
	if got := noClocks(l.life.Notices("alo2")); len(got) != 1 || got[0] != want3 {
		t.Errorf("alo2's notices %q", got)
	}
	// alo2 waited on its child within one idle period and started no turn: alo1 is owed nothing.
	if got := noClocks(l.life.Notices("alo1")); len(got) != 0 {
		t.Errorf("alo1's notices %q", got)
	}
	// Once per idle period: more quiet writes, and a waiting spell that doesn't end the idle period, tell nobody again.
	l.set("alo3", db.Field{Col: "activity_detail", Val: "still idle"})
	note := "t"
	w, err := l.db.AddWait(l.ctx, db.NewWait{AgentID: "alo3", Kind: "timer", Source: "stam", Detail: &note})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.db.ClearWait(l.ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	l.orgSettle()
	if n := len(noClocks(l.life.Notices("alo2"))); n != 1 {
		t.Errorf("alo2 has %d notices, want 1: %q", n, noClocks(l.life.Notices("alo2")))
	}
	// Errored ends the idle period (idle_since clears): the parent hears of the error, and of the next quiet turn.
	l.set("alo3", db.Field{Col: "activity", Val: "errored"})
	l.set("alo3", db.Field{Col: "activity", Val: "idle"})
	l.orgSettle()
	if n := len(noClocks(l.life.Notices("alo2"))); n != 3 {
		t.Errorf("alo2 has %d notices, want 3: %q", n, noClocks(l.life.Notices("alo2")))
	}
}

// TestOrgTrouble: a blocked or errored agent tells its parents; with none, the chief of staff; with none, the human by
// mail. A parent on another machine gets it through its daemon.
func TestOrgTrouble(t *testing.T) {
	l := newLive(t)
	l.orgAgent("alb1", "")
	l.orgAgent("alb2", "alb1")
	l.orgAgent("alb3", "")
	l.orgAgent("alb4", "apeer9")
	var mu sync.Mutex
	var mailed []string
	l.life.SetMailHuman(func(_ context.Context, from, subject, body string) error {
		mu.Lock()
		defer mu.Unlock()
		mailed = append(mailed, from+"|"+subject+"|"+body)
		return nil
	})
	peer := l.fakePeer(map[string]string{"apeer9": "told"})
	l.life.StartOrg()
	l.set("alb2", db.Field{Col: "activity", Val: "blocked"}, db.Field{Col: "activity_detail", Val: "a dialog"})
	l.set("alb3", db.Field{Col: "activity", Val: "errored"}, db.Field{Col: "activity_detail", Val: "crashed"})
	l.set("alb4", db.Field{Col: "activity", Val: "blocked"}, db.Field{Col: "activity_detail", Val: "x"})
	l.orgSettle()
	blocked := l.render("agent-blocked", map[string]string{"agent": "n-alb2", "relation": "your child", "detail": "a dialog"})
	if got := noClocks(l.life.Notices("alb1")); len(got) != 1 || got[0] != blocked {
		t.Errorf("parent's notices %q", got)
	}
	errored := l.render("agent-errored", map[string]string{"agent": "n-alb3", "relation": "an agent without a parent", "detail": "crashed"})
	mu.Lock()
	if len(mailed) != 1 || withoutClock(mailed[0]) != "alb3|n-alb3 errored|"+errored {
		t.Errorf("mailed %q", mailed)
	}
	mu.Unlock()
	want4 := l.render("agent-blocked", map[string]string{"agent": "n-alb4", "relation": "your child", "detail": "x"})
	l.until("the peer parent's notice", func() bool { return len(peer.sent()) == 1 })
	if got := peer.sent(); withoutClock(got[0]) != "apeer9||"+want4 {
		t.Errorf("sent to the peer %q", got)
	}
	// With a chief of staff, an orphan's trouble goes to it.
	l.setSettings(`{"chiefOfStaff":"n-alb1"}`)
	l.set("alb3", db.Field{Col: "activity", Val: "blocked"}, db.Field{Col: "activity_detail", Val: "again"})
	l.orgSettle()
	again := l.render("agent-blocked", map[string]string{"agent": "n-alb3", "relation": "an agent without a parent", "detail": "again"})
	if got := noClocks(l.life.Notices("alb1")); len(got) != 2 || got[1] != again {
		t.Errorf("chief of staff's notices %q", got)
	}
}

// TestOrgTurnNotices: a parent set to "turn" hears each finished turn, a waiting end included, and not the tree-idle
// notice; one set to "none" hears neither.
func TestOrgTurnNotices(t *testing.T) {
	l := newLive(t)
	l.orgAgent("alt5", "")
	l.orgAgent("alt6", "")
	l.orgAgent("alt7", "alt5")
	execOn(t, l, "INSERT INTO agent_parents (child_id, parent_id) VALUES ('alt7', 'alt6')")
	l.set("alt5", db.Field{Col: "child_notices", Val: "turn"})
	l.set("alt6", db.Field{Col: "child_notices", Val: "none"})
	l.life.StartOrg()
	l.set("alt7", db.Field{Col: "activity", Val: "working"}, db.Field{Col: "last_message", Val: "done  \n now"})
	l.orgSettle()
	note := "tick"
	if _, err := l.db.AddWait(l.ctx, db.NewWait{AgentID: "alt7", Kind: "timer", Source: "stam", Detail: &note}); err != nil {
		t.Fatal(err)
	}
	l.turnEnds("alt7")
	l.orgSettle()
	if a := l.agent("alt7"); a.Activity != "waiting" {
		t.Errorf("alt7 %s", a.Activity)
	}
	want := l.render("child-turn-finished", map[string]string{"child": "n-alt7", "last": "done now"})
	if got := noClocks(l.life.Notices("alt5")); len(got) != 1 || got[0] != want {
		t.Errorf("turn parent's notices %q", got)
	}
	if got := noClocks(l.life.Notices("alt6")); len(got) != 0 {
		t.Errorf("none parent's notices %q", got)
	}
	// Going idle without finishing a turn (an interrupt) is no turn.
	l.set("alt7", db.Field{Col: "activity", Val: "working"})
	l.set("alt7", db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "interrupted"})
	l.orgSettle()
	if got := noClocks(l.life.Notices("alt5")); len(got) != 1 {
		t.Errorf("turn parent's notices after an interrupt %q", got)
	}
}

// TestOrgRebuild: at start, a stale children wait clears and a missing one is added, a pending request gets its human
// wait and an answered one loses it, a declared wait on a settled request clears and one on a pending request is tied
// to it; then a quiet subtree's owed tree-idle notice goes out.
func TestOrgRebuild(t *testing.T) {
	l := newLive(t)
	l.orgAgent("alr1", "")
	l.orgAgent("alr2", "alr1")
	l.orgAgent("alr3", "")
	l.orgAgent("alr4", "alr3")
	l.orgAgent("alr5", "")
	l.orgAgent("alr6", "alr5")
	l.orgAgent("alr7", "alr6")
	l.set("alr2", db.Field{Col: "activity", Val: "working"})
	l.set("alr7", db.Field{Col: "activity", Val: "working"})
	stale := "3 children"
	l.orgAgent("alr8", "")
	for _, id := range []string{"alr3", "alr8"} {
		if _, err := l.db.AddWait(l.ctx, db.NewWait{AgentID: id, Kind: "children", Source: "stam", Detail: &stale}); err != nil {
			t.Fatal(err)
		}
	}
	execOn(t, l, `INSERT INTO permission_requests (id, agent_id, action, reason, details, audience, status, created_at, decided_at) VALUES
		('pb00001', 'alr4', 'x', 'r', '{}', 'human', 'pending', '2026-10-21T00:00:01.000Z', NULL),
		('pb00002', 'alr4', 'x', 'r', '{}', 'human', 'approved', '2026-10-21T00:00:02.000Z', '2026-10-21T00:00:03.000Z')`)
	gone := "pb00002"
	for _, w := range []db.NewWait{
		{AgentID: "alr4", Kind: "human", Source: "stam", Target: &gone},
		{AgentID: "alr4", Kind: "human", Source: "declared", Target: &gone},
		{AgentID: "alr4", Kind: "human", Source: "declared", Detail: ptr("about pb00001")},
	} {
		if _, err := l.db.AddWait(l.ctx, w); err != nil {
			t.Fatal(err)
		}
	}
	// alr4 is quiet with a turn its parent hasn't heard of; its parent hears tree-idle.
	l.set("alr4", db.Field{Col: "idle_notified", Val: nil})
	l.life.StartOrg()
	l.orgSettle()
	// alr6 turns waiting on its child, one busy agent more under alr5: a second pass counts it.
	if got := l.children("alr1") + "|" + l.children("alr3") + "|" + l.children("alr5"); got != "1 child|1 child|2 children" {
		// alr4 waits on the human now, which is busy to alr3.
		t.Errorf("children waits %s", got)
	}
	if a := l.agent("alr8"); l.children("alr8") != "" || a.Activity != "idle" {
		t.Errorf("alr8 with no busy child: %q %s", l.children("alr8"), a.Activity)
	}
	var got []string
	for _, w := range l.waits("alr4") {
		got = append(got, w.Source+":"+w.Kind+":"+deref(w.Target))
	}
	if strings.Join(got, ",") != "declared:human:pb00001,stam:human:pb00001" {
		t.Errorf("alr4's waits %v", got)
	}
}

// TestOrgRecoverTreeIdle: a subtree that went quiet while the daemon was down owes its notice, sent at start once.
func TestOrgRecoverTreeIdle(t *testing.T) {
	l := newLive(t)
	l.orgAgent("alq1", "")
	l.orgAgent("alq2", "alq1")
	l.set("alq2", db.Field{Col: "idle_notified", Val: nil})
	l.life.StartOrg()
	l.orgSettle()
	want := l.render("child-turn-finished", map[string]string{"child": "n-alq2", "last": "(not reported)"})
	if got := noClocks(l.life.Notices("alq1")); len(got) != 1 || got[0] != want {
		t.Errorf("notices %q", got)
	}
	if a := l.agent("alq2"); a.IdleNotified == nil || a.IdleSince == nil || *a.IdleNotified != *a.IdleSince {
		t.Errorf("idle_notified %v, idle_since %v", a.IdleNotified, a.IdleSince)
	}
}

// TestOrgPeerBusy: a peer agent turning busy gives its local parent a children wait, and quiet again clears it.
func TestOrgPeerBusy(t *testing.T) {
	l := newLive(t)
	l.orgAgent("alp1", "")
	l.life.StartOrg()
	l.orgSettle()
	seen := db.PeerAgentSeen{ID: "apeer8", Name: "far", Machine: "elsewhere", Lifecycle: "active", Parents: []string{"alp1"}, Activity: "working"}
	if err := l.db.RememberPeerAgent(l.ctx, seen); err != nil {
		t.Fatal(err)
	}
	l.orgSettle()
	if got := l.children("alp1"); got != "1 child" {
		t.Errorf("children wait %q", got)
	}
	seen.Activity = "idle"
	if err := l.db.RememberPeerAgent(l.ctx, seen); err != nil {
		t.Fatal(err)
	}
	l.orgSettle()
	if got := l.children("alp1"); got != "" {
		t.Errorf("children wait after %q", got)
	}
}

// TestOrgTreeIdleOwed: an agent that finishes a turn while a child is still busy owes its parent the tree-idle notice
// until that child goes quiet; then the child's parent and the grandparent each hear once.
func TestOrgTreeIdleOwed(t *testing.T) {
	l := newLive(t)
	l.orgAgent("ali1", "")
	l.orgAgent("ali2", "ali1")
	l.orgAgent("ali3", "ali2")
	l.life.StartOrg()
	l.orgSettle()
	l.set("ali3", db.Field{Col: "activity", Val: "working"})
	l.set("ali2", db.Field{Col: "activity", Val: "working"})
	l.turnEnds("ali2")
	l.orgSettle()
	if a := l.agent("ali2"); a.Activity != "waiting" {
		t.Errorf("ali2: %s %q", a.Activity, detailOf(a))
	}
	if got := noClocks(l.life.Notices("ali1")); len(got) != 0 {
		t.Errorf("ali1 heard while ali3 was busy: %q", got)
	}
	l.turnEnds("ali3")
	l.orgSettle()
	want3 := l.render("child-turn-finished", map[string]string{"child": "n-ali3", "last": "(not reported)"})
	if got := noClocks(l.life.Notices("ali2")); len(got) != 1 || got[0] != want3 {
		t.Errorf("ali2's notices %q", got)
	}
	want2 := l.render("child-turn-finished", map[string]string{"child": "n-ali2", "last": "(not reported)"})
	if got := noClocks(l.life.Notices("ali1")); len(got) != 1 || got[0] != want2 {
		t.Errorf("ali1's notices %q", got)
	}
	if got := l.children("ali1"); got != "" {
		t.Errorf("ali1's children wait %q", got)
	}
}

// TestOrgRestingWaits: a wait makes a resting agent busy to its parent, and the last wait cleared makes it quiet, which
// owes the tree-idle notice. Errored, its activity doesn't follow its waits, so only the resting-waits change tells.
func TestOrgRestingWaits(t *testing.T) {
	l := newLive(t)
	l.orgAgent("alw1", "")
	l.orgAgent("alw2", "alw1")
	l.orgAgent("alw3", "alw2")
	since := "2026-10-21T00:00:00.000Z"
	l.set("alw2", db.Field{Col: "lifecycle", Val: "paused"}, db.Field{Col: "paused_by", Val: `["standing-idle"]`},
		db.Field{Col: "activity", Val: "errored"}, db.Field{Col: "idle_since", Val: since}, db.Field{Col: "idle_notified", Val: since})
	l.life.StartOrg()
	l.orgSettle()
	note := "tick"
	w, err := l.db.AddWait(l.ctx, db.NewWait{AgentID: "alw2", Kind: "timer", Source: "stam", Detail: &note})
	if err != nil {
		t.Fatal(err)
	}
	l.orgSettle()
	if got := l.children("alw1"); got != "1 child" {
		t.Errorf("children wait %q", got)
	}
	if a := l.agent("alw2"); a.Activity != "errored" {
		t.Errorf("alw2: %s", a.Activity)
	}
	l.set("alw2", db.Field{Col: "idle_notified", Val: nil})
	if _, err := l.db.ClearWait(l.ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	l.orgSettle()
	if got := l.children("alw1"); got != "" {
		t.Errorf("children wait after %q", got)
	}
	want := l.render("child-turn-finished", map[string]string{"child": "n-alw2", "last": "(not reported)"})
	if got := noClocks(l.life.Notices("alw1")); len(got) != 1 || got[0] != want {
		t.Errorf("notices %q", got)
	}
	// Its children wait is a wait too: a busy child makes it busy to its parent, one more busy agent there.
	l.set("alw3", db.Field{Col: "activity", Val: "working"})
	l.orgSettle()
	if got := l.children("alw2") + "|" + l.children("alw1"); got != "1 child|2 children" {
		t.Errorf("children waits with a busy grandchild %s", got)
	}
	l.turnEnds("alw3")
	l.orgSettle()
	if got := l.children("alw2") + "|" + l.children("alw1"); got != "|" {
		t.Errorf("children waits after %s", got)
	}
}

// TestOrgForget: forgetting a shut-down child settles its parent again, so a children wait it held goes (src/daemon.ts
// forget), and the parent's owed notice goes out.
func TestOrgForget(t *testing.T) {
	l := newLive(t)
	l.setSettings(`{"itsa":{"home":"test-machine"}}`)
	l.orgAgent("alg1", "")
	l.orgAgent("alg2", "alg1")
	l.orgAgent("alg3", "alg2")
	l.orgAgent("alg4", "")
	execOn(t, l, "INSERT INTO agent_parents (child_id, parent_id) VALUES ('alg1', 'alg4')")
	l.set("alg3", db.Field{Col: "activity", Val: "working"})
	l.life.StartOrg()
	l.orgSettle()
	l.set("alg2", db.Field{Col: "lifecycle", Val: "shut_down"})
	l.orgSettle()
	if got := l.children("alg1"); got != "2 children" {
		t.Fatalf("children wait before %q", got)
	}
	// alg1 owes its parent a notice, held while its subtree is busy.
	l.set("alg1", db.Field{Col: "idle_notified", Val: nil})
	unowned := ""
	l.life.SetUnown(func(_ context.Context, a db.Agent, how string) error { unowned = a.ID + " " + how; return nil })
	if _, err := l.life.Forget(l.ctx, l.agent("alg2")); err != nil {
		t.Fatal(err)
	}
	if unowned != "alg2 forgotten" {
		t.Errorf("the forget unowned %q, want alg2's ITSAs", unowned)
	}
	l.orgSettle()
	if a := l.agent("alg1"); l.children("alg1") != "" || a.Activity != "idle" {
		t.Errorf("alg1 after the forget: %q %s", l.children("alg1"), a.Activity)
	}
	if got := noClocks(l.life.Notices("alg4")); len(got) != 1 {
		t.Errorf("alg1's parent heard %q", got)
	}
}

// TestOrgConcurrent: turns finishing on many children at once give each parent one notice per child, and leave no
// children wait behind.
func TestOrgConcurrent(t *testing.T) {
	l := newLive(t)
	l.orgAgent("alc0", "")
	l.orgAgent("alt0", "")
	l.set("alt0", db.Field{Col: "child_notices", Val: "turn"})
	const n = 8
	ids := make([]string, n)
	for i := range ids {
		ids[i] = "alc" + strconv.Itoa(i+1)
		l.orgAgent(ids[i], "alc0")
		execOn(t, l, "INSERT INTO agent_parents (child_id, parent_id) VALUES ('"+ids[i]+"', 'alt0')")
	}
	l.life.StartOrg()
	l.orgSettle()
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 3 {
				if err := l.db.UpdateAgent(l.ctx, id, db.Field{Col: "activity", Val: "working"}); err != nil {
					t.Error(err)
				}
				if err := l.db.UpdateAgent(l.ctx, id, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "turn finished"}); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	l.orgSettle()
	if a := l.agent("alc0"); l.children("alc0") != "" || a.Activity != "idle" {
		t.Errorf("alc0: %q %s", l.children("alc0"), a.Activity)
	}
	if got := len(noClocks(l.life.Notices("alt0"))); got != 3*n {
		t.Errorf("the turn parent heard %d turns, want %d", got, 3*n)
	}
	// Each child's last idle period is told once; earlier ones may be told or not, depending on when the parent was
	// quiet, but never twice.
	if got := len(noClocks(l.life.Notices("alc0"))); got < n || got > 3*n {
		t.Errorf("the tree-idle parent heard %d notices", got)
	}
	for _, id := range ids {
		if a := l.agent(id); a.IdleNotified == nil || a.IdleSince == nil || *a.IdleNotified != *a.IdleSince {
			t.Errorf("%s: idle_notified %v, idle_since %v", id, a.IdleNotified, a.IdleSince)
		}
	}
}

// TestOrgBusySubtreeGuard: an owed agent with a busy child tells nobody yet, even when its own change is handled before
// the child's (announceTreeIdle's busy-subtree check), and tells once the child is quiet.
func TestOrgBusySubtreeGuard(t *testing.T) {
	l := newLive(t)
	l.orgAgent("alh1", "")
	l.orgAgent("alh2", "alh1")
	l.orgAgent("alh3", "alh2")
	execOn(t, l, "UPDATE agents SET activity = 'working', idle_since = NULL WHERE id = 'alh3'")
	execOn(t, l, "UPDATE agents SET activity = 'idle', idle_since = '2026-10-21T00:00:00.000Z', idle_notified = NULL WHERE id = 'alh2'")
	if err := l.life.announceTreeIdle(l.ctx, l.agent("alh2")); err != nil {
		t.Fatal(err)
	}
	if got := noClocks(l.life.Notices("alh1")); len(got) != 0 {
		t.Errorf("told with a busy child: %q", got)
	}
	if a := l.agent("alh2"); a.IdleNotified != nil {
		t.Errorf("marked told: %v", *a.IdleNotified)
	}
	execOn(t, l, "UPDATE agents SET activity = 'idle' WHERE id = 'alh3'")
	if err := l.life.announceTreeIdle(l.ctx, l.agent("alh2")); err != nil {
		t.Fatal(err)
	}
	if got := noClocks(l.life.Notices("alh1")); len(got) != 1 {
		t.Errorf("once quiet: %q", got)
	}
}

// fakeTell stands in for the server's tellWhere: each agent's outcome ("told", "absent", "unreachable", or "refuse" for
// an error), recording each call as "id|want|text" with the outcome it got. An agent not in outcomes is absent.
type fakeTell struct {
	mu       sync.Mutex
	outcomes map[string]string
	calls    []string
	got      []string
}

func (l *live) fakePeer(outcomes map[string]string) *fakeTell {
	f := &fakeTell{outcomes: outcomes}
	l.life.SetTellPeer(func(_ context.Context, id, text, want string) (string, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls = append(f.calls, id+"|"+want+"|"+text)
		f.got = append(f.got, f.outcomes[id])
		switch r := f.outcomes[id]; r {
		case "":
			return "absent", nil
		case "refuse":
			return "", errors.New("far refused the notice: no")
		default:
			return r, nil
		}
	})
	return f
}

func (f *fakeTell) set(id, outcome string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.outcomes[id] = outcome
}

// sent is what was delivered: the calls whose outcome was "told".
func (f *fakeTell) sent() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for i, c := range f.calls {
		if f.got[i] == "told" {
			out = append(out, c)
		}
	}
	return out
}

// asked is how many calls carried want.
func (f *fakeTell) asked(want string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if strings.SplitN(c, "|", 3)[1] == want {
			n++
		}
	}
	return n
}

func (f *fakeTell) tries() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// TestOrgPeerDelivery: a parent on another machine that no machine has leaves the agent to the fallback; one whose
// machine doesn't answer is retried, without holding the org goroutine, and after the retry window the notice is
// dropped with an event; a refusal fails at once with an event.
func TestOrgPeerDelivery(t *testing.T) {
	t.Setenv("STAM_PEER_RETRY_MS", "20")
	l := newLive(t)
	l.orgAgent("ald1", "apeer1")
	l.orgAgent("ald2", "apeer2")
	l.orgAgent("ald3", "apeer3")
	l.orgAgent("ald4", "")
	l.orgAgent("ald5", "ald4")
	l.setSettings(`{"chiefOfStaff":"n-ald4"}`)
	peer := l.fakePeer(map[string]string{"apeer2": "unreachable", "apeer3": "refuse"})
	l.life.StartOrg()
	// Gone everywhere: the chief of staff hears instead.
	l.set("ald1", db.Field{Col: "activity", Val: "blocked"}, db.Field{Col: "activity_detail", Val: "one"})
	l.until("the fallback", func() bool { return len(noClocks(l.life.Notices("ald4"))) == 1 })
	// A machine that doesn't answer: retried while the org goes on with other changes.
	l.set("ald2", db.Field{Col: "activity", Val: "blocked"}, db.Field{Col: "activity_detail", Val: "two"})
	l.until("a few tries", func() bool { return peer.tries() >= 4 })
	l.set("ald5", db.Field{Col: "activity", Val: "errored"}, db.Field{Col: "activity_detail", Val: "local"})
	l.until("a local notice meanwhile", func() bool { return len(noClocks(l.life.Notices("ald4"))) == 2 })
	// Its machine answers: told, and no event.
	peer.set("apeer2", "told")
	l.until("the retried notice", func() bool { return len(peer.sent()) == 1 })
	if got := l.countEvents("ald2", "org:notice-failed"); got != 0 {
		t.Errorf("%d failure events for a notice that got through", got)
	}
	// A refusal fails at once.
	l.set("ald3", db.Field{Col: "activity", Val: "blocked"}, db.Field{Col: "activity_detail", Val: "three"})
	l.until("the refusal's event", func() bool { return l.countEvents("ald3", "org:notice-failed") == 1 })
	if got := lastEvent(t, l, "ald3", "org:notice-failed"); !strings.Contains(got, `"parent":"apeer3"`) || !strings.Contains(got, "refused") {
		t.Errorf("refusal event %s", got)
	}
	// A machine that never answers within the window: dropped, with an event.
	l.life.orgMu.Lock()
	l.life.peerRetryFor = 100 * time.Millisecond
	l.life.orgMu.Unlock()
	peer.set("apeer2", "unreachable")
	l.set("ald2", db.Field{Col: "activity", Val: "errored"}, db.Field{Col: "activity_detail", Val: "again"})
	l.until("the dropped notice's event", func() bool { return l.countEvents("ald2", "org:notice-failed") == 1 })
	if got := lastEvent(t, l, "ald2", "org:notice-failed"); !strings.Contains(got, "didn't answer") {
		t.Errorf("drop event %s", got)
	}
}

// TestOrgPeerTreeIdle: a tree-idle notice for a parent on another machine counts as told once that machine has it: a
// failed delivery leaves it owed, and while one is on its way a repeat call sends nothing.
func TestOrgPeerTreeIdle(t *testing.T) {
	t.Setenv("STAM_PEER_RETRY_MS", "20")
	l := newLive(t)
	l.orgAgent("ale1", "apeer5")
	peer := l.fakePeer(map[string]string{"apeer5": "refuse"})
	l.life.StartOrg()
	l.orgSettle()
	l.set("ale1", db.Field{Col: "activity", Val: "working"})
	l.turnEnds("ale1")
	// The turn notice goes to the peer too, which checks the parent's mode on its own record.
	l.until("the refused tree-idle notice", func() bool { return peer.asked("tree-idle") == 1 && l.countEvents("ale1", "org:notice-failed") == 2 })
	if a := l.agent("ale1"); a.IdleNotified != nil && *a.IdleNotified == *a.IdleSince {
		t.Error("a refused notice marked told")
	}
	// Still owed: the next announce sends it again, and this time it gets through, once, while repeats wait on it.
	peer.set("apeer5", "unreachable")
	if err := l.life.announceTreeIdle(l.ctx, l.agent("ale1")); err != nil {
		t.Fatal(err)
	}
	l.until("a try", func() bool { return peer.asked("tree-idle") >= 2 })
	if err := l.life.announceTreeIdle(l.ctx, l.agent("ale1")); err != nil {
		t.Fatal(err)
	}
	peer.set("apeer5", "told")
	l.until("marked told", func() bool {
		a := l.agent("ale1")
		return a.IdleNotified != nil && *a.IdleNotified == *a.IdleSince
	})
	l.orgSettle()
	if got := peer.sent(); len(got) != 1 || !strings.HasPrefix(got[0], "apeer5|tree-idle|") {
		t.Errorf("delivered %q", got)
	}
}

// TestOrgOwnerStops: an agent shut down, or errored, is reported once to the ITSA owners' hook; a pause, a restart, an
// archive in progress, a shutdown for a compaction, and a failed launch's shutdown (told as the error) are not.
func TestOrgOwnerStops(t *testing.T) {
	l := newLive(t)
	var mu sync.Mutex
	var got []string
	l.life.SetOwnerStopped(func(_ context.Context, id, name, what string) {
		mu.Lock()
		got = append(got, id+" "+name+" "+what)
		mu.Unlock()
	})
	reports := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), got...)
	}
	for _, id := range []string{"als1", "als2", "als3", "als4", "als5", "als6"} {
		l.orgAgent(id, "")
	}
	l.life.StartOrg()
	l.set("als1", db.Field{Col: "lifecycle", Val: "shut_down"})
	l.set("als2", db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "activity_detail", Val: "restarting: a new model"})
	l.set("als3", db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "pending_action", Val: `{"type":"recover","compact":true}`})
	l.set("als4", db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "activity", Val: "errored"})
	l.set("als5", db.Field{Col: "activity", Val: "errored"})
	l.set("als6", db.Field{Col: "lifecycle", Val: "paused"})
	l.orgSettle()
	// Every report started while the org handled the changes; once none runs, each has been made.
	l.until("the reports made", func() bool { return l.life.bgRunning.Load() == 0 })
	want := map[string]bool{"als1 n-als1 was shut down": true, "als4 n-als4 errored": true, "als5 n-als5 errored": true}
	if r := reports(); len(r) != 3 || !want[r[0]] || !want[r[1]] || !want[r[2]] {
		t.Errorf("reports %q", r)
	}
}

// TestForgetTellsEventsTheAgentIsGone (S-4317): forgetting an agent runs the same hook an archive does, once, after the
// agent's row is gone and with no lifecycle lock held.
func TestForgetTellsEventsTheAgentIsGone(t *testing.T) {
	l := newLive(t)
	l.setSettings(`{"itsa":{"home":"test-machine"}}`)
	l.orgAgent("alf1", "")
	l.set("alf1", db.Field{Col: "lifecycle", Val: "shut_down"})
	l.life.SetUnown(func(context.Context, db.Agent, string) error { return nil })
	var gone []string
	l.life.SetAgentGone(func(ctx context.Context, id string) {
		l.life.mu.Lock()
		l.life.mu.Unlock()
		l.life.orgMu.Lock()
		l.life.orgMu.Unlock()
		_, err := l.life.db.GetAgent(ctx, id)
		gone = append(gone, id+" row gone: "+strconv.FormatBool(err != nil))
	})
	if _, err := l.life.Forget(l.ctx, l.agent("alf1")); err != nil {
		t.Fatal(err)
	}
	if len(gone) != 1 || gone[0] != "alf1 row gone: true" {
		t.Errorf("the hook heard %v", gone)
	}
}

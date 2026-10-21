package db

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func ptr(s string) *string { return &s }

// state is the agent's activity and detail, as "activity: detail".
func state(t *testing.T, d *DB, id string) string {
	t.Helper()
	a, err := d.GetAgent(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return string(a.Activity) + ": " + detail(a)
}

// TestWaitsSyncActivity: an idle agent that gets a wait turns waiting with the top wait's summary, the summary follows
// the ranked top wait as waits come and go, and the last wait cleared leaves it idle with "waits cleared".
func TestWaitsSyncActivity(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	newTestAgent(t, d, "aws1", "waiter")
	newTestAgent(t, d, "aws2", "waitboss")
	execSQL(t, conn, "UPDATE agents SET lifecycle = 'active', activity = 'idle', activity_detail = NULL WHERE id = 'aws1'")

	timer, err := d.AddWait(ctx, NewWait{AgentID: "aws1", Kind: "timer", Source: "stam", Detail: ptr("timer: tick")})
	if err != nil {
		t.Fatal(err)
	}
	if got := state(t, d, "aws1"); got != "waiting: waiting for timer: tick" {
		t.Errorf("first wait: %s", got)
	}
	// An agent wait ranks above a timer, and with no detail names the agent.
	agent, err := d.AddWait(ctx, NewWait{AgentID: "aws1", Kind: "agent", Source: "declared", Target: ptr("aws2")})
	if err != nil {
		t.Fatal(err)
	}
	if got := state(t, d, "aws1"); got != "waiting: waiting for waitboss's reply (+1 more)" {
		t.Errorf("an agent wait: %s", got)
	}
	if ok, err := d.ClearWait(ctx, agent.ID); err != nil || !ok {
		t.Fatalf("clear: %v %v", ok, err)
	}
	if got := state(t, d, "aws1"); got != "waiting: waiting for timer: tick" {
		t.Errorf("back to the timer: %s", got)
	}
	if ok, _ := d.ClearWait(ctx, agent.ID); ok {
		t.Error("a wait cleared twice")
	}
	if ok, err := d.ClearWait(ctx, timer.ID); err != nil || !ok {
		t.Fatalf("clear: %v %v", ok, err)
	}
	if got := state(t, d, "aws1"); got != "idle: waits cleared" {
		t.Errorf("no waits: %s", got)
	}
	// A working agent's waits don't change its activity.
	execSQL(t, conn, "UPDATE agents SET activity = 'working', activity_detail = 'busy' WHERE id = 'aws1'")
	if _, err := d.AddWait(ctx, NewWait{AgentID: "aws1", Kind: "job", Source: "hook", Target: ptr("b1"), Detail: ptr("npm test")}); err != nil {
		t.Fatal(err)
	}
	if got := state(t, d, "aws1"); got != "working: busy" {
		t.Errorf("working: %s", got)
	}
	// ClearWaits matches a nil target only to waits with none.
	if n, err := d.ClearWaits(ctx, "aws1", "job", nil); err != nil || n != 0 {
		t.Errorf("nil target: %d %v", n, err)
	}
	if n, err := d.ClearWaits(ctx, "aws1", "job", ptr("b1")); err != nil || n != 1 {
		t.Errorf("by target: %d %v", n, err)
	}
}

// TestWaitsClearBySource: ClearAgentWait clears only the agent's own wait, and only with one of the sources named.
func TestWaitsClearBySource(t *testing.T) {
	ctx := context.Background()
	d := openTest(t, testDB(t))
	newTestAgent(t, d, "awc1", "one")
	newTestAgent(t, d, "awc2", "two")
	hook, err := d.AddWait(ctx, NewWait{AgentID: "awc1", Kind: "job", Source: "hook", Target: ptr("b1")})
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := d.ClearAgentWait(ctx, "awc1", hook.ID, "declared", "stam"); ok {
		t.Error("a hook wait cleared as declared")
	}
	if ok, _ := d.ClearAgentWait(ctx, "awc2", hook.ID); ok {
		t.Error("another agent's wait cleared")
	}
	if _, err := d.GetWait(ctx, hook.ID); err != nil {
		t.Fatalf("the wait is gone: %v", err)
	}
	if ok, err := d.ClearAgentWait(ctx, "awc1", hook.ID, "stam", "hook"); err != nil || !ok {
		t.Errorf("own source: %v %v", ok, err)
	}
	if _, err := d.GetWait(ctx, hook.ID); err == nil {
		t.Error("still there")
	}
}

// TestReplaceHookWaits: a kept hook wait keeps its id and since, one no longer reported goes, a new one is added, other
// kinds and sources stay, and two reported with one new target are both added, as TS does.
func TestReplaceHookWaits(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	newTestAgent(t, d, "awr1", "jobs")
	if err := d.ReplaceHookWaits(ctx, "awr1", "job", []HookWait{{Target: "b1", Detail: "one"}, {Target: "b2", Detail: "two"}}); err != nil {
		t.Fatal(err)
	}
	timer, _ := d.AddWait(ctx, NewWait{AgentID: "awr1", Kind: "timer", Source: "hook", Target: ptr("c1")})
	declared, _ := d.AddWait(ctx, NewWait{AgentID: "awr1", Kind: "job", Source: "declared", Target: ptr("b2")})
	before, _ := d.ListWaits(ctx, "awr1")
	execSQL(t, conn, "UPDATE waits SET since = '2026-01-01T00:00:00.000Z' WHERE target = 'b1'")
	b1 := ""
	for _, w := range before {
		if deref(w.Target) == "b1" {
			b1 = w.ID
		}
	}
	if err := d.ReplaceHookWaits(ctx, "awr1", "job", []HookWait{{Target: "b1", Detail: "renamed"}, {Target: "b3", Detail: "x"}, {Target: "b3", Detail: "y"}}); err != nil {
		t.Fatal(err)
	}
	after, _ := d.ListWaits(ctx, "awr1")
	var got []string
	for _, w := range after {
		s := w.Source + " " + w.Kind + " " + deref(w.Target) + " " + deref(w.Detail)
		switch w.ID {
		case b1:
			s += " kept@" + w.Since
		case timer.ID, declared.ID:
			s += " kept"
		}
		got = append(got, s)
	}
	want := "hook job b1 one kept@2026-01-01T00:00:00.000Z|declared job b2  kept|hook job b3 x|hook job b3 y|hook timer c1  kept"
	if g := strings.Join(got, "|"); g != want {
		t.Errorf("after:\n got %s\nwant %s", g, want)
	}
	if err := d.ClearHookWaits(ctx, "awr1"); err != nil {
		t.Fatal(err)
	}
	if left, _ := d.ListWaits(ctx, "awr1"); len(left) != 1 || left[0].ID != declared.ID {
		t.Errorf("after clearing the hook waits: %+v", left)
	}
}

// TestFireWait: due waits are declared timeouts and stam's timers, not hook waits; firing moves or clears one with its
// event, and a wait cleared or moved since it was read is left alone with no event.
func TestFireWait(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	newTestAgent(t, d, "awf1", "fire")
	past := "2026-10-21T00:00:00.000Z"
	add := func(kind, source string) Wait {
		t.Helper()
		w, err := d.AddWait(ctx, NewWait{AgentID: "awf1", Kind: kind, Source: source, Until: ptr(past)})
		if err != nil {
			t.Fatal(err)
		}
		return w
	}
	declared, timer := add("agent", "declared"), add("timer", "stam")
	add("timer", "hook")
	add("job", "stam")
	due, err := d.DueWaits(ctx, "2026-10-21T00:00:01.000Z")
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 2 || due[0].ID != declared.ID || due[1].ID != timer.ID {
		t.Fatalf("due: %+v", due)
	}
	if due, _ := d.DueWaits(ctx, "2026-10-20T23:59:59.000Z"); len(due) != 0 {
		t.Errorf("due early: %+v", due)
	}
	events := func() int {
		return count(t, conn, "SELECT count(*) FROM events WHERE agent_id = 'awf1' AND type LIKE 'wait:t%'")
	}

	next := "2026-10-22T00:00:00.000Z"
	if fired, err := d.FireWait(ctx, timer, &next, "wait:tick", map[string]any{"id": timer.ID}); err != nil || !fired {
		t.Fatalf("move: %v %v", fired, err)
	}
	if w, _ := d.GetWait(ctx, timer.ID); deref(w.Until) != next {
		t.Errorf("until %v", deref(w.Until))
	}
	// The read it fired from is stale now: the wait moved.
	if fired, _ := d.FireWait(ctx, timer, &next, "wait:tick", nil); fired {
		t.Error("fired a moved wait")
	}
	if fired, err := d.FireWait(ctx, declared, nil, "wait:timeout", nil); err != nil || !fired {
		t.Fatalf("clear: %v %v", fired, err)
	}
	if _, err := d.GetWait(ctx, declared.ID); err == nil {
		t.Error("the fired wait is still there")
	}
	if fired, _ := d.FireWait(ctx, declared, nil, "wait:timeout", nil); fired {
		t.Error("fired a cleared wait")
	}
	if n := events(); n != 2 {
		t.Errorf("%d events, want 2", n)
	}
}

// TestClaimNudge: a nudge is claimed once per key, and an error from fn writes neither the wait nor the claim.
func TestClaimNudge(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	newTestAgent(t, d, "awn1", "nudge")
	var claims []bool
	for i := 0; i < 2; i++ {
		if _, err := d.AddWaitWith(ctx, NewWait{AgentID: "awn1", Kind: "agent", Source: "declared"}, func(tx WaitTx, w Wait) error {
			ok, err := tx.ClaimNudge("t", "awn1", "th", "m1")
			claims = append(claims, ok)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	if fmt.Sprint(claims) != "[true false]" {
		t.Errorf("claims %v", claims)
	}
	if _, err := d.AddWaitWith(ctx, NewWait{AgentID: "awn1", Kind: "human", Source: "declared"}, func(tx WaitTx, w Wait) error {
		if _, err := tx.ClaimNudge("t2", "awn1", "th", "m1"); err != nil {
			return err
		}
		return fmt.Errorf("no")
	}); err == nil {
		t.Fatal("no error")
	}
	if n := count(t, conn, "SELECT count(*) FROM waits WHERE agent_id = 'awn1' AND kind = 'human'"); n != 0 {
		t.Errorf("%d human waits", n)
	}
	if n := count(t, conn, "SELECT count(*) FROM wait_nudges WHERE target_id = 't2'"); n != 0 {
		t.Errorf("%d claims", n)
	}
}

package server

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"stam/internal/jsfmt"
	"stam/internal/ring"
	"stam/internal/tmux"
)

// A ring member that never started (test/ring-start-dead.test.mjs, S-3070, S-3862): the ring is decided at once, as incomplete or
// on its type's fallback, and a restart's sweep finishes what a crash between the two steps left.

// deadFixture is ringTypeFixture, whose rv-a type (Claude) is the fallback the tests record, and rv-cdx a Codex type. Its
// lifecycle tells the rings of an agent that never started, as server.New's does (withLifeRootTmux).
func deadFixture(t *testing.T) *fixture { return ringTypeFixture(t) }

var deadN int

// ringAgent is an active agent with a workspace: stuck, it has been starting for 20 minutes, past the starting timeout.
func (f *fixture) ringAgent(stuck bool, typ, harness string) string {
	f.t.Helper()
	deadN++
	id, name := fmt.Sprintf("ad%03d", deadN), fmt.Sprintf("m%d", deadN)
	activity, created := "idle", time.Now().UTC().Format(time.RFC3339Nano)
	if stuck {
		activity, created = "starting", time.Now().Add(-20*time.Minute).UTC().Format(time.RFC3339Nano)
	}
	var tp any
	if typ != "" {
		tp = typ
	}
	f.sql(`INSERT INTO agents (id, name, role, machine, harness, cwd, created_at, updated_at, type, workspace, lifecycle, activity)
		VALUES (?, ?, '', 'test-machine', ?, ?, ?, ?, ?, ?, 'active', ?)`, id, name, harness, f.home, created, created, tp,
		`{"spec":{"kind":"dir","path":"`+f.home+`"},"cwd":"`+f.home+`"}`, activity)
	return id
}

// deadRing is the human's ring of the members, reviewing one PR.
func (f *fixture) deadRing(format string, members []string, extra string) string {
	f.t.Helper()
	names := make([]string, len(members))
	for i, id := range members {
		names[i] = `"` + f.agentField2(id, "name") + `"`
	}
	deadN++
	rec := f.human("POST", "/api/rings", fmt.Sprintf(`{"name":"r%d","format":"%s","topic":"Review PR 972","max_rounds":2,"members":[%s]%s}`, deadN, format, strings.Join(names, ","), extra))
	if rec.Code != 200 {
		f.t.Fatalf("the ring: %d %s", rec.Code, rec.Body)
	}
	v, _ := jsfmt.Parse(rec.Body.Bytes())
	return v.Text("id")
}

func (f *fixture) agentField2(id, col string) string {
	return f.text("SELECT COALESCE("+col+", '') FROM agents WHERE id = ?", id)
}

// neverStarted is a reconcile pass in which no agent has a session: each stuck one is marked never started.
func (f *fixture) neverStarted() {
	f.srv.life.Reconcile(context.Background(), &tmux.Snapshot{Server: "t", Dead: map[string]bool{}})
}

func (f *fixture) ringApprove(ringID, id string) (int, string) {
	return f.submitAs(ringID, id, `,"agree":true,"verdict":"approve"`)
}

// submitAs submits for the member with the shared token, as a peer would for its agent: the members here have no tokens.
func (f *fixture) submitAs(ringID, id, extra string) (int, string) {
	f.t.Helper()
	rec := f.post2("POST", "/api/rings/"+ringID+"/submit", `{"by":"`+id+`","text":"ok"`+extra+`}`)
	v, _ := jsfmt.Parse(rec.Body.Bytes())
	return rec.Code, v.Text("result") + v.Text("error")
}

func (f *fixture) ringCol(ringID, col string) string {
	return f.text("SELECT COALESCE("+col+", '') FROM rings WHERE id = ?", ringID)
}

func (f *fixture) evCount(id, typ string) int {
	return f.count("SELECT COUNT(*) FROM events WHERE agent_id = ? AND type = ?", id, typ)
}

func TestRingMemberNeverStarted(t *testing.T) {
	f := deadFixture(t)
	// A member that never started makes the ring incomplete, even when every other member approved.
	a, b, dead := f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude"), f.ringAgent(true, "", "claude")
	r := f.deadRing("rounds", []string{a, b, dead}, "")
	f.ringApprove(r, a)
	f.ringApprove(r, b)
	if got := f.ringCol(r, "status"); got != "running" {
		t.Fatalf("the round should wait on the member that never started: %s", got)
	}
	f.neverStarted()
	if got := f.agentField2(dead, "lifecycle"); got != "shut_down" {
		t.Fatalf("the dead member is %s", got)
	}
	res := f.ringCol(r, "result")
	if f.ringCol(r, "status") != "done" || !strings.HasPrefix(res, "Incomplete: "+f.agentField2(dead, "name")+" never submitted") || strings.Contains(res, "all members agreed") {
		t.Errorf("an incomplete ring: %s %q", f.ringCol(r, "status"), res)
	}
	if f.evCount(dead, "ring:dropped") != 1 || f.evCount(dead, "ring:missing") != 1 {
		t.Errorf("dropped %d, missing %d", f.evCount(dead, "ring:dropped"), f.evCount(dead, "ring:missing"))
	}
	// The ring is done: nobody posts a verdict into it, the dead member that starts late included.
	for _, id := range []string{dead, a} {
		if code, msg := f.ringApprove(r, id); code != 409 || !strings.Contains(msg, "is done") {
			t.Errorf("a late submit: %d %q", code, msg)
		}
	}
	// The ring's mail names no verdict line.
	if body := f.text("SELECT body FROM mail WHERE subject = ?", "Ring "+f.ringCol(r, "name")+" ended"); !strings.Contains(body, "Incomplete: ") || strings.Contains(body, "pr_review") {
		t.Errorf("the ring's mail: %q", body)
	}

	// A fire ring whose current turn is the dead member: incomplete, and nobody gets a turn.
	dead2, c, d := f.ringAgent(true, "", "claude"), f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude")
	r2 := f.deadRing("fire", []string{dead2, c, d}, "")
	before := len(f.turnNotices(c)) + len(f.turnNotices(d))
	f.neverStarted()
	if f.ringCol(r2, "status") != "done" || !strings.HasPrefix(f.ringCol(r2, "result"), "Incomplete: ") {
		t.Errorf("the fire ring: %s %q", f.ringCol(r2, "status"), f.ringCol(r2, "result"))
	}
	if after := len(f.turnNotices(c)) + len(f.turnNotices(d)); after != before {
		t.Errorf("the members were prompted: %d notices, was %d", after, before)
	}
	if got := f.ringCol(r2, "members"); got != `["`+c+`","`+d+`"]` {
		t.Errorf("members %s", got)
	}

	// An agent in no ring is marked dead as before.
	lone := f.ringAgent(true, "", "claude")
	f.neverStarted()
	if f.agentField2(lone, "lifecycle") != "shut_down" || f.evCount(lone, "ring:dropped") != 0 {
		t.Errorf("the lone agent: %s, dropped %d", f.agentField2(lone, "lifecycle"), f.evCount(lone, "ring:dropped"))
	}
}

// A dead moderator is dropped and the members decide; a moderated ring with a dead member is never told the members agree.
func TestRingModeratorNeverStarted(t *testing.T) {
	f := deadFixture(t)
	a, b, mod := f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude"), f.ringAgent(true, "", "claude")
	r := f.deadRing("rounds", []string{a, b}, `,"moderator":"`+f.agentField2(mod, "name")+`"`)
	f.ringApprove(r, a)
	f.ringApprove(r, b)
	if got := f.ringCol(r, "status"); got != "moderating" {
		t.Fatalf("status %s", got)
	}
	f.neverStarted()
	if f.ringCol(r, "moderator_id") != "" || f.ringCol(r, "status") != "done" || strings.HasPrefix(f.ringCol(r, "result"), "Incomplete") {
		t.Errorf("the members' round decides: %q %s %q", f.ringCol(r, "moderator_id"), f.ringCol(r, "status"), f.ringCol(r, "result"))
	}

	c, d, dead, mod2 := f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude"), f.ringAgent(true, "", "claude"), f.ringAgent(false, "", "claude")
	r2 := f.deadRing("rounds", []string{c, d, dead}, `,"moderator":"`+f.agentField2(mod2, "name")+`"`)
	before := len(f.turnNotices(mod2))
	f.ringApprove(r2, c)
	f.ringApprove(r2, d)
	f.neverStarted()
	if f.ringCol(r2, "status") != "done" || !strings.HasPrefix(f.ringCol(r2, "result"), "Incomplete: ") {
		t.Errorf("the moderated ring: %s %q", f.ringCol(r2, "status"), f.ringCol(r2, "result"))
	}
	for _, n := range f.turnNotices(mod2)[before:] {
		t.Errorf("the moderator was prompted: %q", n)
	}
}

// fallbackAllowed: never the dead member's own type or harness, and every member that died counts, not only the last.
func TestRingFallbackAllowed(t *testing.T) {
	f := deadFixture(t)
	fb := ring.Fallback{Type: "rv-a"}
	for _, tc := range []struct {
		dead []ring.Dead
		want bool
	}{
		{nil, false},
		{[]ring.Dead{{Type: "rv-a", Harness: "codex"}}, false},
		{[]ring.Dead{{Type: "rv-cdx", Harness: "claude"}}, false},
		{[]ring.Dead{{Type: "rv-cdx", Harness: "codex"}}, true},
		{[]ring.Dead{{Type: "x", Harness: "claude"}, {Type: "rv-cdx", Harness: "codex"}}, false},
	} {
		if got := f.srv.fallbackAllowed(fb, tc.dead); got != tc.want {
			t.Errorf("%v: %v", tc.dead, got)
		}
	}
	if f.srv.fallbackAllowed(ring.Fallback{Type: "nosuch"}, []ring.Dead{{Type: "x", Harness: "codex"}}) {
		t.Errorf("an unknown fallback type is allowed")
	}
}

// A ring whose member never started falls back on its recorded fallback: the ring ends, its other live members are retired, and
// the single reviewer runs under the ring's name from the spawn-time request; a later pass spawns no second one. A fallback the
// dead member's own harness can't supply leaves the ring incomplete and retires no one. (The dead member runs on Codex, which
// this daemon can't archive yet, so only Claude members are retired here.)
func TestRingFallsBackWhenAMemberNeverStarted(t *testing.T) {
	f := deadFixture(t)
	a, b, dead := f.ringAgent(false, "x", "claude"), f.ringAgent(false, "x", "claude"), f.ringAgent(true, "rv-cdx", "codex")
	r := f.deadRing("rounds", []string{a, b, dead}, `,"fallback":{"type":"rv-a","body":{"prompt":"raw task","cwd":"`+f.home+`"}}`)
	name := f.ringCol(r, "name")
	f.neverStarted()
	until(t, "the fallback reviewer", func() bool {
		return f.agentField(name, "type") == "rv-a" && f.agentField2(a, "lifecycle") == "archived" && f.agentField2(b, "lifecycle") == "archived"
	})
	if got := f.ringCol(r, "result"); f.ringCol(r, "status") != "done" || !strings.Contains(got, "so it fell back to a single rv-a reviewer") {
		t.Errorf("the ring: %s %q", f.ringCol(r, "status"), got)
	}
	if got := f.agentField(name, "first_prompt"); got != "R: raw task" {
		t.Errorf("the reviewer's brief %q", got)
	}
	if got := f.agentField(name, "parent_id"); got != "" {
		t.Errorf("the human's fallback has parent %q", got)
	}
	f.neverStarted()
	if n := f.count("SELECT COUNT(*) FROM agents WHERE name = ?", name); n != 1 {
		t.Errorf("%d reviewers named %s", n, name)
	}
	if code, msg := f.ringApprove(r, b); code != 409 || !strings.Contains(msg, "is done") {
		t.Errorf("a late verdict: %d %q", code, msg)
	}

	// The fallback runs on the dead member's harness: refused, so the ring is incomplete and the survivor stays.
	c, dead2 := f.ringAgent(false, "rv-cdx", "claude"), f.ringAgent(true, "x", "claude")
	r2 := f.deadRing("rounds", []string{c, dead2}, `,"fallback":{"type":"rv-a","body":{"prompt":"t"}}`)
	f.neverStarted()
	// (The pass with no sessions stops the idle survivor too; an incomplete ring doesn't retire it.)
	if !strings.HasPrefix(f.ringCol(r2, "result"), "Incomplete: ") || f.agentField2(c, "lifecycle") == "archived" {
		t.Errorf("no fallback: %q, survivor %s", f.ringCol(r2, "result"), f.agentField2(c, "lifecycle"))
	}
	if got := f.agentField(f.ringCol(r2, "name"), "id"); got != "" {
		t.Errorf("a fallback reviewer %s was spawned", got)
	}
}

// The restart sweep decides a ring whose member was marked never started before its ring heard of it, and prompts nobody; a
// second sweep finds nothing. A member marked dead before it joined, one revived since, a moderator marked dead before the ring,
// and a member taken over are not swept.
func TestRingRestartSweep(t *testing.T) {
	f := deadFixture(t)
	dead, a, b := f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude")
	r := f.deadRing("fire", []string{dead, a, b}, "")
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = ?", dead)
	f.sql("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'starting:dead', '{}')", dead, time.Now().UTC().Format(time.RFC3339Nano))
	before := len(f.turnNotices(a))
	failures, _, err := f.srv.ringEngine().SweepDeadMembers(context.Background(), f.srv.db, f.srv.fallbackAllowed)
	if err != nil || len(failures) != 1 {
		t.Fatalf("the sweep: %d %v", len(failures), err)
	}
	if f.ringCol(r, "status") != "done" || !strings.HasPrefix(f.ringCol(r, "result"), "Incomplete: ") {
		t.Errorf("the swept ring: %s %q", f.ringCol(r, "status"), f.ringCol(r, "result"))
	}
	if len(f.turnNotices(a)) != before || f.evCount(a, "ring:missing") != 0 {
		t.Errorf("the survivor was prompted or dropped")
	}
	if failures, _, _ := f.srv.ringEngine().SweepDeadMembers(context.Background(), f.srv.db, f.srv.fallbackAllowed); len(failures) != 0 {
		t.Errorf("a second sweep found %d", len(failures))
	}

	// A swept moderator whose members don't agree yet starts their next round, and still prompts nobody: the open seats are
	// prompted once, after the sweep.
	e, g, dm := f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude")
	r3 := f.deadRing("rounds", []string{e, g}, `,"moderator":"`+f.agentField2(dm, "name")+`"`)
	f.submitAs(r3, e, `,"agree":false`)
	f.submitAs(r3, g, `,"agree":false`)
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = ?", dm)
	f.sql("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'starting:dead', '{}')", dm, time.Now().UTC().Format(time.RFC3339Nano))
	prompted := len(f.turnNotices(e)) + len(f.turnNotices(g))
	if failures, effects, err := f.srv.ringEngine().SweepDeadMembers(context.Background(), f.srv.db, f.srv.fallbackAllowed); err != nil || len(failures) != 0 || len(effects) != 0 {
		t.Errorf("the moderator's sweep: %d failures, %d effects, %v", len(failures), len(effects), err)
	}
	if got := f.ringStatus(r3); got != "running|2|0" || f.ringCol(r3, "moderator_id") != "" || len(f.turnNotices(e))+len(f.turnNotices(g)) != prompted {
		t.Errorf("the moderator's ring: %s, moderator %q", got, f.ringCol(r3, "moderator_id"))
	}

	ago := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	c, d, old, revived, held, mod := f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude")
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id IN (?, ?, ?, ?)", old, revived, held, mod)
	f.sql("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'starting:dead', '{}')", old, ago)
	f.sql("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'starting:dead', '{}')", mod, ago)
	r2 := f.deadRing("rounds", []string{c, d, old, revived, held}, `,"moderator":"`+f.agentField2(mod, "name")+`"`)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	f.sql("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'starting:dead', '{}')", revived, now)
	f.sql("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'resume', '{}')", revived, now)
	f.sql("UPDATE agents SET forwarded_to = ? WHERE id = ?", c, held)
	f.sql("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'starting:dead', '{}')", held, now)
	if failures, _, _ := f.srv.ringEngine().SweepDeadMembers(context.Background(), f.srv.db, f.srv.fallbackAllowed); len(failures) != 0 {
		t.Errorf("swept %d", len(failures))
	}
	if got := strings.Count(f.ringCol(r2, "members"), ","); got != 4 || f.ringCol(r2, "moderator_id") != mod {
		t.Errorf("members %s, moderator %q", f.ringCol(r2, "members"), f.ringCol(r2, "moderator_id"))
	}
}

// The death and the ring's transaction are separate commits in Go: a resume or a takeover in between, or a ring joined after the
// death, keeps the seat. MemberFailed rechecks it in its own transaction and leaves the ring untouched, retiring no one.
func TestRingMemberFailedRechecksTheSeat(t *testing.T) {
	f := deadFixture(t)
	dead := func(id string) {
		f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = ?", id)
		f.sql("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'starting:dead', '{}')", id, time.Now().UTC().Format(time.RFC3339Nano))
	}
	fb := `,"fallback":{"type":"rv-a","body":{"prompt":"t"}}`
	for _, tc := range []struct {
		name string
		// between runs after the death and before MemberFailed; late joins the ring only after the death.
		between func(seat, other string)
		late    bool
	}{
		{"a resume", func(seat, _ string) {
			f.sql("UPDATE agents SET lifecycle = 'active' WHERE id = ?", seat)
			f.sql("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'resume', '{}')", seat, time.Now().UTC().Format(time.RFC3339Nano))
		}, false},
		{"a takeover", func(seat, other string) { f.sql("UPDATE agents SET forwarded_to = ? WHERE id = ?", other, seat) }, false},
		{"a ring joined after the death", nil, true},
	} {
		a, seat := f.ringAgent(false, "x", "claude"), f.ringAgent(false, "rv-cdx", "codex")
		var r string
		if !tc.late {
			r = f.deadRing("rounds", []string{a, seat}, fb)
		}
		dead(seat)
		if tc.late {
			r = f.deadRing("rounds", []string{a, seat}, fb)
		}
		if tc.between != nil {
			tc.between(seat, a)
		}
		members := f.ringCol(r, "members")
		failures, effects, err := f.srv.ringEngine().MemberFailed(context.Background(), f.srv.db, seat, f.srv.fallbackAllowed)
		if err != nil || len(failures) != 0 || len(effects) != 0 {
			t.Errorf("%s: %d failures, %d effects, %v", tc.name, len(failures), len(effects), err)
		}
		if f.ringCol(r, "status") != "running" || f.ringCol(r, "members") != members || f.evCount(seat, "ring:dropped") != 0 {
			t.Errorf("%s: the ring is %s, members %s, dropped %d", tc.name, f.ringCol(r, "status"), f.ringCol(r, "members"), f.evCount(seat, "ring:dropped"))
		}
		if f.agentField2(a, "lifecycle") != "active" {
			t.Errorf("%s: the other member is %s", tc.name, f.agentField2(a, "lifecycle"))
		}
	}
}

// A ring the old code dropped, with only ring:dropped and the member off the list, is incomplete when its survivor approves. A
// dead moderator of such a ring doesn't make it incomplete.
func TestRingDroppedByOldCode(t *testing.T) {
	f := deadFixture(t)
	a, dead := f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude")
	r := f.deadRing("rounds", []string{a, dead}, "")
	f.sql("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'ring:dropped', ?)", dead, time.Now().UTC().Format(time.RFC3339Nano), `{"ring":"`+r+`","why":"never started: no harness process"}`)
	f.sql("UPDATE rings SET members = ?, max_rounds = 1 WHERE id = ?", `["`+a+`"]`, r)
	f.ringApprove(r, a)
	if res := f.ringCol(r, "result"); f.ringCol(r, "status") != "done" || !strings.HasPrefix(res, "Incomplete: ") || strings.Contains(res, "all members agreed") {
		t.Errorf("the old ring: %s %q", f.ringCol(r, "status"), res)
	}
	// The reason is the mail's: the last round ended, not an agreement.
	if body := f.text("SELECT body FROM mail WHERE subject = ?", "Ring "+f.ringCol(r, "name")+" ended"); strings.Contains(body, "all members agreed") || !strings.Contains(body, "the last round ended") {
		t.Errorf("the old ring's mail: %q", body)
	}

	b, c, mod := f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude"), f.ringAgent(false, "", "claude")
	r2 := f.deadRing("rounds", []string{b, c}, `,"moderator":"`+f.agentField2(mod, "name")+`"`)
	f.sql("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'ring:dropped', ?)", mod, time.Now().UTC().Format(time.RFC3339Nano), `{"ring":"`+r2+`","why":"never started: no harness process"}`)
	f.sql("UPDATE rings SET moderator_id = NULL WHERE id = ?", r2)
	f.ringApprove(r2, b)
	f.ringApprove(r2, c)
	if res := f.ringCol(r2, "result"); f.ringCol(r2, "status") != "done" || strings.HasPrefix(res, "Incomplete") || !strings.Contains(res, "Final submissions") {
		t.Errorf("the old moderated ring: %s %q", f.ringCol(r2, "status"), res)
	}
}

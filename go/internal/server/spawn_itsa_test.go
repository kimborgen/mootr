package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// spawnFixture is a fixture whose spawns start: the checkout's templates and registry, and a tmux that succeeds with no
// session.
func spawnFixture(t *testing.T) *fixture {
	f := newFixture(t, nil)
	withLifeRootTmux(f, "../../..", sessionTmux(t))
	return f
}

// spawn posts a spawn with token and the body's fields, in the fixture's home.
func (f *fixture) spawn(token, fields string) *httptest.ResponseRecorder {
	f.t.Helper()
	body := `{"cwd":"` + f.home + `"`
	if fields != "" {
		body += "," + fields
	}
	return f.do(call{method: "POST", path: "/api/agents", token: token, body: body + "}"})
}

// spawned is a successful spawn's agent id and name.
func (f *fixture) spawned(token, fields string) (id, name string) {
	f.t.Helper()
	rec := f.spawn(token, fields)
	if rec.Code != 200 {
		f.t.Fatalf("spawn %s: %d %s", fields, rec.Code, rec.Body.String())
	}
	var a struct{ ID, Name string }
	must(f.t, json.Unmarshal(rec.Body.Bytes(), &a))
	return a.ID, a.Name
}

// participants is the ITSA's members, sorted and comma-joined.
func (f *fixture) participants(key string) string {
	f.t.Helper()
	ids, err := f.db.ItsaParticipants(context.Background(), f.itsaID(key))
	must(f.t, err)
	return strings.Join(ids, ",")
}

// TestSpawnFreeName: a nameless spawn takes the first free name; with every name taken it takes NAME-2.
func TestSpawnFreeName(t *testing.T) {
	f := spawnFixture(t)
	if _, name := f.spawned(sharedTok, `"harness":"claude"`); name != "otter" {
		t.Errorf("first free name %s, want otter", name)
	}
	if _, name := f.spawned(sharedTok, `"harness":"claude","name":"  "`); name != "heron" {
		t.Errorf("a blank name: %s, want heron", name)
	}
	for i, n := range spawnNames {
		f.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, created_at, updated_at) VALUES (?, ?, '', 'test-machine', 'claude', '/tmp', '', '') ON CONFLICT DO NOTHING", "afree"+string(rune('a'+i)), n)
	}
	f.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, created_at, updated_at) VALUES ('afree2', 'otter-2', '', 'test-machine', 'claude', '/tmp', '', '')")
	name, err := f.srv.freeName(context.Background())
	must(t, err)
	if name != "heron-2" {
		t.Errorf("with every name and otter-2 taken: %s, want heron-2", name)
	}
}

// TestSpawnDefaultPreset: a spawn with no harness or model gets settings.spawnDefaults.preset's harness, model and
// effort, an explicit effort winning; a named model skips it; an unknown preset is a 400 before any row.
func TestSpawnDefaultPreset(t *testing.T) {
	f := spawnFixture(t)
	f.setProcessSettings(`{"spawnDefaults":{"preset":"fast"}}`)
	id, _ := f.spawned(sharedTok, `"name":"p1","effort":"max"`)
	if a := f.agent(t, id); a["harness"] != "claude" || a["model"] != "claude-haiku-5-5" || a["effort"] != "max" {
		t.Errorf("the default preset: %v %v %v", a["harness"], a["model"], a["effort"])
	}
	id, _ = f.spawned(sharedTok, `"name":"p2","model":"claude-opus-5-5"`)
	if a := f.agent(t, id); a["model"] != "claude-opus-5-5" || a["effort"] != nil {
		t.Errorf("a named model: %v %v", a["model"], a["effort"])
	}
	f.setProcessSettings(`{"spawnDefaults":{"preset":"nope"}}`)
	if rec := f.spawn(sharedTok, `"name":"p3"`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "no preset nope; see stam registry") {
		t.Errorf("an unknown preset: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.db.GetAgent(context.Background(), "p3"); err == nil {
		t.Error("the refused spawn made a row")
	}
}

// TestSpawnItsaOwner: `itsa` makes the new agent the owner, and its first prompt starts with the owner block; an agent may
// give only an ITSA it may change (403), an unknown ITSA is a 400, and neither leaves a row.
func TestSpawnItsaOwner(t *testing.T) {
	f := spawnFixture(t)
	parent := f.createItsa(`{"title":"epic","owner":"boss"}`)
	key := f.createItsa(`{"title":"the fix","summary":"one line","parent":"` + parent + `"}`)
	id, _ := f.spawned(bossTok, `"name":"o1","by":"aboss","itsa":"`+key+`","prompt":"do it"`)
	if owner := f.text("SELECT owner FROM itsas WHERE key = ?", key); owner != id {
		t.Errorf("owner %s, want %s", owner, id)
	}
	first := f.text("SELECT first_prompt FROM agents WHERE id = ?", id)
	if !strings.HasPrefix(first, "You now own ITSA "+key+": the fix.") || !strings.Contains(first, "Parent chain: "+parent+" epic (backlog)") || !strings.HasSuffix(first, "\n\ndo it") {
		t.Errorf("first prompt:\n%s", first)
	}
	other := f.createItsa(`{"title":"not yours","owner":"human"}`)
	if rec := f.spawn(agentTok, `"name":"o2","by":"achild","itsa":"`+other+`"`); rec.Code != 403 || !strings.Contains(rec.Body.String(), "child can't change "+other) {
		t.Errorf("an ITSA the agent may not change: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.spawn(sharedTok, `"name":"o3","itsa":"S-9999"`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "no ITSA S-9999") {
		t.Errorf("an unknown ITSA: %d %s", rec.Code, rec.Body.String())
	}
	for _, n := range []string{"o2", "o3"} {
		if _, err := f.db.GetAgent(context.Background(), n); err == nil {
			t.Errorf("the refused spawn %s made a row", n)
		}
	}
}

// TestSpawnParticipate: `participate` adds the new agent to each ITSA with the owner unchanged, deduplicated; a list
// that isn't ITSA refs is a 400, and one the agent may not change a 403, before any row.
func TestSpawnParticipate(t *testing.T) {
	f := spawnFixture(t)
	a := f.createItsa(`{"title":"a","owner":"boss"}`)
	b := f.createItsa(`{"title":"b","participants":["boss"]}`)
	id, _ := f.spawned(bossTok, `"name":"q1","by":"aboss","participate":["`+a+`","`+b+`","`+a+`"]`)
	if got := f.participants(a); got != "aboss,"+id && got != id+",aboss" {
		t.Errorf("%s participants %s", a, got)
	}
	if got := f.participants(b); !strings.Contains(got, id) {
		t.Errorf("%s participants %s", b, got)
	}
	if owner := f.text("SELECT owner FROM itsas WHERE key = ?", a); owner != "aboss" {
		t.Errorf("the owner changed to %s", owner)
	}
	for _, tc := range []struct {
		fields string
		code   int
		want   string
	}{
		{`"participate":"` + a + `"`, 400, "participate is a list of ITSA ids or keys"},
		{`"participate":["` + a + `",""]`, 400, "participate is a list of ITSA ids or keys"},
		{`"participate":["S-9999"]`, 400, "no ITSA S-9999"},
	} {
		if rec := f.spawn(sharedTok, `"name":"q2",`+tc.fields); rec.Code != tc.code || !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("%s: %d %s", tc.fields, rec.Code, rec.Body.String())
		}
	}
	other := f.createItsa(`{"title":"other","owner":"human"}`)
	if rec := f.spawn(agentTok, `"name":"q3","by":"achild","participate":["`+other+`"]`); rec.Code != 403 {
		t.Errorf("an ITSA the agent may not change: %d %s", rec.Code, rec.Body.String())
	}
	for _, n := range []string{"q2", "q3"} {
		if _, err := f.db.GetAgent(context.Background(), n); err == nil {
			t.Errorf("the refused spawn %s made a row", n)
		}
	}
}

// TestSpawnJoinsParentItsa: under settings.itsa.required a spawn with a parent joins the parent's most recently updated
// open ITSA it owns, else one it takes part in; with `itsa` it doesn't; with itsa.required off it doesn't.
func TestSpawnJoinsParentItsa(t *testing.T) {
	f := spawnFixture(t)
	part := f.createItsa(`{"title":"part","participants":["boss"]}`)
	if id, _ := f.spawned(bossTok, `"name":"j0","by":"aboss"`); f.participants(part) != "aboss,"+id && f.participants(part) != id+",aboss" {
		t.Errorf("joined only by participation: %s", f.participants(part))
	}
	open := f.createItsa(`{"title":"open","owner":"boss","status":"in_progress"}`)
	closed := f.createItsa(`{"title":"closed","owner":"boss"}`)
	f.sql("UPDATE itsas SET status = 'done', updated_at = '2999-01-01T00:00:00.000Z' WHERE key = ?", closed)
	id, _ := f.spawned(bossTok, `"name":"j1","by":"aboss"`)
	if !strings.Contains(f.participants(open), id) || strings.Contains(f.participants(closed), id) || strings.Contains(f.participants(part), id) {
		t.Errorf("open %s, closed %s, part %s", f.participants(open), f.participants(closed), f.participants(part))
	}
	own := f.createItsa(`{"title":"own","owner":"boss"}`)
	id, _ = f.spawned(bossTok, `"name":"j2","by":"aboss","itsa":"`+own+`"`)
	if strings.Contains(f.participants(open), id) {
		t.Errorf("a spawn with itsa joined the parent's ITSA too")
	}
	f.setProcessSettings(`{"itsa":{"required":false}}`)
	id, _ = f.spawned(bossTok, `"name":"j3","by":"aboss"`)
	if strings.Contains(f.participants(open), id) {
		t.Errorf("joined with itsa.required off")
	}
}

// TestSpawnUrgent: urgent incident needs an ITSA, or an ancestor, with the incident mark (403 before any row); the other
// reasons only order the slot queue, which no spawn here enters, so they spawn as usual.
func TestSpawnUrgent(t *testing.T) {
	f := spawnFixture(t)
	epic := f.createItsa(`{"title":"epic"}`)
	key := f.createItsa(`{"title":"fire","parent":"` + epic + `"}`)
	if rec := f.spawn(sharedTok, `"name":"u1","urgent":"incident","itsa":"`+key+`"`); rec.Code != 403 || !strings.Contains(rec.Body.String(), "urgent: incident needs an ITSA") {
		t.Errorf("an unmarked incident: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.spawn(sharedTok, `"name":"u1","urgent":"incident"`); rec.Code != 403 {
		t.Errorf("an incident with no ITSA: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.db.GetAgent(context.Background(), "u1"); err == nil {
		t.Error("a refused incident made a row")
	}
	f.sql("UPDATE itsas SET incident = 1 WHERE key = ?", epic)
	f.spawned(sharedTok, `"name":"u1","urgent":"incident","itsa":"`+key+`"`)
	f.spawned(sharedTok, `"name":"u2","urgent":"red-main"`)
}

// TestSpawnItsaGate: a spawn's `itsa` lookup waits while a test holds the ITSA gate.
func TestSpawnItsaGate(t *testing.T) {
	f := testFixture(t)
	withLifeRootTmux(f, "../../..", sessionTmux(t))
	key := f.createItsa(`{"title":"gated"}`)
	var gate map[string]int
	f.hook("POST", "/api/test/itsa-gate", `{"action":"hold"}`, &gate)
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- f.spawn(sharedTok, `"name":"g1","itsa":"`+key+`"`) }()
	until(t, "the spawn waits at the gate", func() bool {
		f.hook("POST", "/api/test/itsa-gate", `{"action":"status"}`, &gate)
		return gate["waiting"] == 1
	})
	select {
	case rec := <-done:
		t.Fatalf("the spawn passed a held gate: %d %s", rec.Code, rec.Body.String())
	case <-time.After(50 * time.Millisecond):
	}
	f.hook("POST", "/api/test/itsa-gate", `{"action":"release"}`, &gate)
	if rec := <-done; rec.Code != 200 {
		t.Errorf("after the release: %d %s", rec.Code, rec.Body.String())
	}
}

// TestSpawnFailureUndoesItsas: a spawn whose launch fails gives its ITSA back to the previous owner and leaves the ITSAs
// it joined.
func TestSpawnFailureUndoesItsas(t *testing.T) {
	f := newFixture(t, nil)
	withLifeRoot(f, "../../..")
	owned := f.createItsa(`{"title":"owned","owner":"boss"}`)
	joined := f.createItsa(`{"title":"joined","owner":"boss"}`)
	if rec := f.spawn(bossTok, `"name":"f1","by":"aboss","itsa":"`+owned+`","participate":["`+joined+`"]`); rec.Code < 400 {
		t.Fatalf("the launch didn't fail: %d %s", rec.Code, rec.Body.String())
	}
	a, err := f.db.GetAgent(context.Background(), "f1")
	must(t, err)
	if a.Activity != "errored" {
		t.Errorf("the failed agent is %s", a.Activity)
	}
	if owner := f.text("SELECT owner FROM itsas WHERE key = ?", owned); owner != "aboss" {
		t.Errorf("owner after the failure %s, want aboss", owner)
	}
	for _, k := range []string{owned, joined} {
		if got := f.participants(k); strings.Contains(got, a.ID) {
			t.Errorf("%s still has the failed agent: %s", k, got)
		}
	}
}

// TestForgetUnownsItsas: a forgotten owner's open ITSAs pass to its live parent, status kept, with a handoff event and a
// notice for the active ones; a closed one is only unowned. With no live heir they become unowned and an active one goes
// back to ready, and the parent ITSA's owner hears it.
func TestForgetUnownsItsas(t *testing.T) {
	f := spawnFixture(t)
	n := &notices{}
	f.srv.noticeHook = n.add
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id IN ('agone', 'acodex')")
	active := f.createItsa(`{"title":"active","owner":"gone","status":"in_progress"}`)
	idle := f.createItsa(`{"title":"idle","owner":"gone"}`)
	shut := f.createItsa(`{"title":"shut","owner":"gone"}`)
	f.sql("UPDATE itsas SET status = 'done' WHERE key = ?", shut)
	if rec := f.post2("POST", "/api/agents/agone/forget", `{}`); rec.Code != 200 {
		t.Fatalf("forget: %d %s", rec.Code, rec.Body.String())
	}
	for _, k := range []string{active, idle} {
		if owner := f.text("SELECT owner FROM itsas WHERE key = ?", k); owner != "aboss" || !strings.Contains(f.participants(k), "aboss") {
			t.Errorf("%s: owner %s, participants %s", k, owner, f.participants(k))
		}
	}
	if st := f.itsaStatus(active); st != "in_progress" {
		t.Errorf("the handed-off ITSA moved to %s", st)
	}
	if owner := f.text("SELECT owner FROM itsas WHERE key = ?", shut); owner != "" || f.itsaStatus(shut) != "done" {
		t.Errorf("the closed ITSA: owner %q, status %s", owner, f.itsaStatus(shut))
	}
	if ev := f.text("SELECT data FROM itsa_events WHERE itsa_id = ? AND type = 'handoff'", f.itsaID(active)); ev != `"Owner @gone forgotten; ownership passed to @boss."` {
		t.Errorf("handoff event %s", ev)
	}
	if got := n.all(); len(got) != 1 || !strings.Contains(got[0], "aboss: [stam] gone was forgotten, so you now own these ITSAs: "+active+` "active" (in_progress).`) {
		t.Errorf("notices %q", got)
	}

	// No live heir: the parent is archived and there is no chief of staff.
	f.sql("UPDATE agents SET lifecycle = 'archived' WHERE id = 'aboss'")
	epic := f.createItsa(`{"title":"epic","owner":"child"}`)
	kid := f.createItsa(`{"title":"kid","owner":"coder","status":"in_progress","parent":"` + epic + `"}`)
	if rec := f.post2("POST", "/api/agents/acodex/forget", `{}`); rec.Code != 200 {
		t.Fatalf("forget with no heir: %d %s", rec.Code, rec.Body.String())
	}
	if owner := f.text("SELECT owner FROM itsas WHERE key = ?", kid); owner != "" || f.itsaStatus(kid) != "ready" {
		t.Errorf("with no heir: owner %q, status %s", owner, f.itsaStatus(kid))
	}
	until(t, "the parent owner's notice", func() bool {
		for _, s := range n.all() {
			if strings.HasPrefix(s, "achild: ") && strings.Contains(s, "coder was forgotten, so its ITSAs are now unowned") && strings.Contains(s, kid+` "kid" (in_progress)`) {
				return true
			}
		}
		return false
	})
}

// TestForgetOffHome: off the ITSA home the unown would go to the home, which the Go daemon can't ask, so the forget is a
// 409 and the agent stays.
func TestForgetOffHome(t *testing.T) {
	f := spawnFixture(t)
	f.setProcessSettings(`{"itsa":{"home":"elsewhere"}}`)
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'agone'")
	rec := f.post2("POST", "/api/agents/agone/forget", `{}`)
	if rec.Code != 409 || !strings.Contains(rec.Body.String(), "can't forget gone: its ITSAs can't be unowned yet") {
		t.Errorf("forget off the home: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.db.GetAgent(context.Background(), "agone"); err != nil {
		t.Error("the agent was forgotten")
	}
}

// TestSpawnFailureUndoesParentJoin: a spawn whose launch fails leaves the parent's ITSA it joined.
func TestSpawnFailureUndoesParentJoin(t *testing.T) {
	f := newFixture(t, nil)
	withLifeRoot(f, "../../..")
	key := f.createItsa(`{"title":"open","owner":"boss","status":"in_progress"}`)
	if rec := f.spawn(bossTok, `"name":"f2","by":"aboss"`); rec.Code < 400 {
		t.Fatalf("the launch didn't fail: %d %s", rec.Code, rec.Body.String())
	}
	a, err := f.db.GetAgent(context.Background(), "f2")
	must(t, err)
	if got := f.participants(key); strings.Contains(got, a.ID) {
		t.Errorf("the parent's ITSA still has the failed agent: %s", got)
	}
	if n := f.text("SELECT COUNT(*) FROM itsa_events WHERE itsa_id = ? AND type = 'participants' AND data LIKE ?", f.itsaID(key), "%"+a.ID+"%"); n != "2" {
		t.Errorf("participants events naming the agent: %s, want the join and its undo", n)
	}
}

// TestForgetReviewer: a forgotten reviewer leaves the ITSAs it joined and doesn't own (a soft leave: the row stays, marked
// left, with a participants event); one tied to no ITSA forgets as any agent.
func TestForgetReviewer(t *testing.T) {
	f := spawnFixture(t)
	f.sql("UPDATE agents SET lifecycle = 'shut_down', type = 'reviewer' WHERE id IN ('agone', 'acodex')")
	if rec := f.post2("POST", "/api/agents/acodex/forget", `{}`); rec.Code != 200 {
		t.Fatalf("forget an untied reviewer: %d %s", rec.Code, rec.Body.String())
	}
	key := f.createItsa(`{"title":"reviewed","owner":"boss","participants":["gone"]}`)
	if rec := f.post2("POST", "/api/agents/agone/forget", `{}`); rec.Code != 200 {
		t.Fatalf("forget a reviewer with a participant row: %d %s", rec.Code, rec.Body.String())
	}
	if got := f.participants(key); strings.Contains(got, "agone") {
		t.Errorf("the reviewer is still a member: %s", got)
	}
	if left := f.text("SELECT left_at FROM itsa_participants WHERE itsa_id = ? AND agent_id = 'agone'", f.itsaID(key)); left == "" {
		t.Error("the reviewer's row was removed or not marked left")
	}
	if n := f.text("SELECT COUNT(*) FROM itsa_events WHERE itsa_id = ? AND type = 'participants' AND actor = 'agone'", f.itsaID(key)); n != "1" {
		t.Errorf("participants events by the reviewer: %s", n)
	}
}

// TestForgetKeepsAgentOnFailure: an unown that fails for a reason other than a guard's refusal (here the 501 of a
// non-process proposal's status change) fails the forget and keeps the agent and its ITSA.
func TestForgetKeepsAgentOnFailure(t *testing.T) {
	f := spawnFixture(t)
	f.sql("UPDATE agents SET lifecycle = 'archived' WHERE id = 'aboss'")
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'agone'")
	key := f.createItsa(`{"title":"retro proposal","owner":"gone","status":"in_progress"}`)
	f.sql("UPDATE itsas SET kind = 'proposal' WHERE key = ?", key)
	rec := f.post2("POST", "/api/agents/agone/forget", `{}`)
	if rec.Code != 409 || !strings.Contains(rec.Body.String(), "can't forget gone: its ITSAs can't be unowned yet (an ITSA of kind proposal") {
		t.Errorf("forget: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.db.GetAgent(context.Background(), "agone"); err != nil {
		t.Error("the agent was forgotten")
	}
	if owner := f.text("SELECT owner FROM itsas WHERE key = ?", key); owner != "agone" {
		t.Errorf("the ITSA's owner %q", owner)
	}
}

package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// S-4163, the Go mirror of test/mail-itsa-human.test.mjs: the owner of an ITSA mails the human directly when the human takes
// part in it. Every other case is rerouted to the parent (S-548): a non-owner participant, an owner the human isn't in the
// ITSA with, a forged `itsa` field naming an ITSA the agent doesn't own, and an ITSA reassigned away from the agent.
// The seeded agent child (achild) has aboss as its first parent.
func TestOwnerMailsHumanInItsa(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	// A model that may mail the human, so its post to them isn't quiet (humanMailBlock).
	f.sql("UPDATE agents SET model = NULL WHERE id = 'achild'")
	// child owns `owned`, and the human takes part in it.
	owned := f.createItsa(`{"title":"Owned","owner":"child","participants":["human"]}`)
	// boss owns `theirs`, with the human in it; child takes part in it but doesn't own it.
	theirs := f.createItsa(`{"title":"Theirs","owner":"boss","participants":["human","child"]}`)
	// child owns `noHuman`, which the human isn't in.
	noHuman := f.createItsa(`{"title":"No human","owner":"child","participants":["boss"]}`)

	post := func(key, body string) (rerouted string, id string) {
		t.Helper()
		rec := f.sendH("POST", "/api/itsas/"+key+"/post", agentTok, nil, body)
		if rec.Code != 200 {
			t.Fatalf("post to %s: %d %s", key, rec.Code, rec.Body.String())
		}
		v := f.body(rec)
		return v.Text("rerouted"), v.Text("id")
	}
	toHuman := func(id string) int {
		return f.count("SELECT COUNT(*) FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'", id)
	}

	if rerouted, id := post(owned, `{"body":"Result","to":["human"]}`); rerouted != "" || toHuman(id) != 1 {
		t.Errorf("the owner in its ITSA: rerouted %q, %d copies to the human", rerouted, toHuman(id))
	}
	if rerouted, id := post(theirs, `{"body":"Not mine","to":["human"]}`); rerouted != "boss" || toHuman(id) != 0 {
		t.Errorf("a participant that doesn't own it: rerouted %q, %d copies to the human", rerouted, toHuman(id))
	}
	if rerouted, id := post(noHuman, `{"body":"Result","to":["human"]}`); rerouted != "boss" || toHuman(id) != 0 {
		t.Errorf("the owner, the human not in it: rerouted %q, %d copies to the human", rerouted, toHuman(id))
	}

	// The `itsa` field names `theirs`, which child doesn't own: the mail isn't direct, though child owns `owned`.
	rec := f.sendH("POST", "/api/mail", agentTok, nil, `{"to":["human"],"subject":"Forged","body":"Result","new_thread":true,"itsa":"`+theirs+`"}`)
	if rec.Code != 200 {
		t.Fatalf("forged itsa: %d %s", rec.Code, rec.Body.String())
	}
	if v := f.body(rec); v.Text("rerouted") != "boss" || toHuman(v.Text("id")) != 0 {
		t.Errorf("a forged itsa field: rerouted %q, %s", v.Text("rerouted"), rec.Body.String())
	}

	// Reassigned: child no longer owns `owned`, so its mail to the human goes to its parent.
	f.sql("UPDATE itsas SET owner = 'boss' WHERE key = ?", owned)
	if rerouted, _ := post(owned, `{"body":"Result","to":["human"]}`); rerouted != "boss" {
		t.Errorf("an ITSA reassigned away: rerouted %q", rerouted)
	}
}

// The human's reply in an ITSA's thread reaches its owner, and no chief of staff or parent is added (S-4163).
func TestHumanReplyReachesItsaOwnerOnly(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET model = NULL WHERE id = 'achild'")
	key := f.createItsa(`{"title":"Owned","owner":"child","participants":["human"]}`)
	rec := f.sendH("POST", "/api/itsas/"+key+"/post", agentTok, nil, `{"body":"Question","to":["human"]}`)
	if rec.Code != 200 {
		t.Fatalf("post: %d %s", rec.Code, rec.Body.String())
	}
	sent := f.body(rec).Text("id")
	rec = f.post2("POST", "/api/mail", `{"from":"human","to":["child"],"subject":"Re: question","body":"Answer","reply_to":"`+sent+`"}`)
	if rec.Code != 200 {
		t.Fatalf("reply: %d %s", rec.Code, rec.Body.String())
	}
	reply := f.body(rec).Text("id")
	if n := f.count("SELECT COUNT(*) FROM mail_recipients WHERE mail_id = ? AND agent_id = 'achild'", reply); n != 1 {
		t.Errorf("the owner didn't get the reply (%d)", n)
	}
	if n := f.count("SELECT COUNT(*) FROM mail_recipients WHERE mail_id = ? AND agent_id = 'aboss'", reply); n != 0 {
		t.Errorf("the reply copied the parent (%d)", n)
	}
}

// S-4163: a relayed original (an ITSA post an agent on a peer relays here) follows the S-548 rule with the routing facts its
// sending daemon attached (relay_route): the ITSA's owner goes direct, an exempt sender goes direct as before, anyone else
// reroutes to the parent that daemon named, and without facts (an older peer) the relay keeps main's delivery. A peer agent is
// one with a peer record, not a row here; the seeded achild is a local agent with aboss as its parent.
func TestRelayedItsaPostToHuman(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	_, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle) VALUES ('rowner', 'rowner', 'far', '2026-10-26', 'active'), ('rother', 'rother', 'far', '2026-10-26', 'active'), ('rgone', 'rgone', 'far', '2026-10-26', 'archived')")
	key := f.createItsa(`{"title":"Remote owned","owner":"child","participants":["human"]}`)
	f.sql("UPDATE itsas SET owner = 'rowner', thread_id = 'th-relay' WHERE key = ?", key)
	id := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("id")
	const mgr = `,"relay_route":{"exempt":false,"parent":"aboss"}`
	relay := func(from, route string) *httptest.ResponseRecorder {
		return f.sendH("POST", "/api/mail", peerTok, peerLocal, `{"from":"`+from+`","to":["human"],"subject":"Relayed","body":"x","forwarded":{"from_name":"`+from+`"},"relay":true,"itsa_id":"`+id+`","thread_id":"th-relay","kind":"comment"`+route+`}`)
	}
	// direct is the mail went to the human and wasn't rerouted; rerouted is the parent it went to instead.
	direct := func(rec *httptest.ResponseRecorder) bool {
		return rec.Code == 200 && f.body(rec).Text("rerouted") == "" && f.count("SELECT COUNT(*) FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'", f.body(rec).Text("id")) == 1
	}
	rerouted := func(rec *httptest.ResponseRecorder, to string) bool {
		return rec.Code == 200 && f.body(rec).Text("rerouted") == to && f.count("SELECT COUNT(*) FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'", f.body(rec).Text("id")) == 0
	}

	if rec := relay("rowner", mgr); !direct(rec) {
		t.Errorf("the owner's relayed post goes to the human: %d %s", rec.Code, rec.Body.String())
	}
	if rec := relay("rother", mgr); !rerouted(rec, "boss") {
		t.Errorf("a non-owner's relayed post reroutes to its parent: %d %s", rec.Code, rec.Body.String())
	}
	if rec := relay("rother", `,"relay_route":{"exempt":true,"parent":"aboss"}`); !direct(rec) {
		t.Errorf("an exempt sender's relayed post goes direct, as on main: %d %s", rec.Code, rec.Body.String())
	}
	if rec := relay("rother", ""); !direct(rec) {
		t.Errorf("a relayed post without routing facts goes direct, as on main: %d %s", rec.Code, rec.Body.String())
	}
	if rec := relay("rother", `,"relay_route":{"exempt":false}`); rec.Code != 400 || !strings.Contains(errorOf(t, rec), "parent can't be reached") {
		t.Errorf("a non-owner whose parent can't be named is refused: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("UPDATE itsas SET owner = 'child' WHERE key = ?", key)
	if rec := relay("rowner", mgr); !rerouted(rec, "boss") {
		t.Errorf("a former owner's relayed post, reassigned, reroutes: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("UPDATE itsas SET owner = 'rgone' WHERE key = ?", key)
	if rec := relay("rgone", mgr); !rerouted(rec, "boss") {
		t.Errorf("an archived peer agent's relayed post reroutes: %d %s", rec.Code, rec.Body.String())
	}
	// A local agent that isn't the owner is routed as its own mail is: rerouted to its parent.
	f.sql("UPDATE itsas SET owner = 'rowner' WHERE key = ?", key)
	if rec := relay("achild", ""); !rerouted(rec, "coder") {
		t.Errorf("a local non-owner's relayed post reroutes as its own mail does: %d %s", rec.Code, rec.Body.String())
	}
}

// S-4163: a reply that names an ITSA is a comment on the ITSA the reply is in; another one named is refused, not dropped.
func TestReplyNamingItsaMustMatchThread(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET model = NULL WHERE id = 'achild'")
	a := f.createItsa(`{"title":"Alpha","owner":"child","participants":["human"]}`)
	b := f.createItsa(`{"title":"Beta","owner":"child","participants":["human"]}`)
	aID := f.body(f.post2("GET", "/api/itsas/"+a, "")).Text("id")
	base := f.body(f.sendH("POST", "/api/itsas/"+a+"/post", agentTok, nil, `{"body":"Base","to":["human"]}`)).Text("id")
	reply := func(itsa string) *httptest.ResponseRecorder {
		return f.post2("POST", "/api/mail", `{"from":"human","to":["child"],"subject":"Re: Alpha","body":"x","reply_to":"`+base+`","itsa":"`+itsa+`"}`)
	}
	if rec := reply(a); rec.Code != 200 || f.body(rec).Text("itsa_id") != aID {
		t.Errorf("a reply naming the ITSA it is in: %d %s", rec.Code, rec.Body.String())
	}
	if rec := reply(b); rec.Code != 400 || !strings.Contains(errorOf(t, rec), "another ITSA") {
		t.Errorf("a reply naming another ITSA: %d %s", rec.Code, rec.Body.String())
	}
}

// S-4163 review: an owner's ask with a refusing mail-to-human step is refused before the status changes. The pre-check predicts
// the ask's routing from the owner as the move leaves it (askDirect), so the owner's ask is direct and the step refuses it.
func TestOwnerAskRefusedBeforeMove(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET model = NULL WHERE id = 'achild'")
	key := f.createItsa(`{"title":"Owned ask","owner":"child","participants":["human"]}`)
	f.sql("CREATE TABLE decision_steps (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL, question TEXT NOT NULL, threshold REAL NOT NULL DEFAULT 0.5, action TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, builtin TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
	f.sql(`INSERT INTO decision_steps (id, name, trigger, question, action, enabled, created_at, updated_at) VALUES ('s1', 'n', '{"kind":"event","event":"mail-to-human"}', 'q', '{}', 1, 'x', 'x')`)
	rec := f.sendH("PATCH", "/api/itsas/"+key, agentTok, nil, `{"status":"needs_input"}`)
	if rec.Code != 501 {
		t.Errorf("the owner's move with a refusing step: %d %s", rec.Code, rec.Body.String())
	}
	if status := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("status"); status != "backlog" {
		t.Errorf("the status changed before the refusal: %s", status)
	}
}

// A non-owner's ask whose parent is gone has no reroute: its send goes to the human directly, so a refusing mail-to-human
// step refuses the move before the status is written (S-4163 review, humanReroute's parent part).
func TestAskWithNoParentRefusedBeforeMove(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET model = NULL WHERE id = 'achild'")
	f.sql("DELETE FROM agent_parents WHERE child_id = 'achild'")
	f.sql("UPDATE agents SET parent_id = 'nowhere-1' WHERE id = 'achild'")
	key := f.createItsa(`{"title":"Ask without parent","owner":"aboss","participants":["human","achild"]}`)
	f.sql("CREATE TABLE decision_steps (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL, question TEXT NOT NULL, threshold REAL NOT NULL DEFAULT 0.5, action TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, builtin TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
	f.sql(`INSERT INTO decision_steps (id, name, trigger, question, action, enabled, created_at, updated_at) VALUES ('s1', 'n', '{"kind":"event","event":"mail-to-human"}', 'q', '{}', 1, 'x', 'x')`)
	f.sendH("POST", "/api/itsas/"+key+"/post", agentTok, nil, `{"body":"Need your call."}`)
	rec := f.sendH("PATCH", "/api/itsas/"+key, agentTok, nil, `{"status":"needs_input"}`)
	if rec.Code != 501 {
		t.Errorf("a non-owner's move with no parent and a refusing step: %d %s", rec.Code, rec.Body.String())
	}
	if status := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("status"); status != "backlog" {
		t.Errorf("the status changed before the refusal: %s", status)
	}
}

// A non-owner with no parent and no chief of staff has nothing to reroute to, so its ask goes direct and a refusing step
// refuses the move before the status is written (S-4163 review).
func TestAskWithNoParentOrChiefRefusedBeforeMove(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET model = NULL WHERE id = 'achild'")
	f.sql("DELETE FROM agent_parents WHERE child_id = 'achild'")
	f.sql("UPDATE agents SET parent_id = NULL WHERE id = 'achild'")
	key := f.createItsa(`{"title":"Ask with no parent","owner":"aboss","participants":["human","achild"]}`)
	f.sql("CREATE TABLE decision_steps (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL, question TEXT NOT NULL, threshold REAL NOT NULL DEFAULT 0.5, action TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, builtin TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
	f.sql(`INSERT INTO decision_steps (id, name, trigger, question, action, enabled, created_at, updated_at) VALUES ('s1', 'n', '{"kind":"event","event":"mail-to-human"}', 'q', '{}', 1, 'x', 'x')`)
	f.sendH("POST", "/api/itsas/"+key+"/post", agentTok, nil, `{"body":"Need your call."}`)
	rec := f.sendH("PATCH", "/api/itsas/"+key, agentTok, nil, `{"status":"needs_input"}`)
	if rec.Code != 501 {
		t.Errorf("a non-owner's move with no parent and no chief of staff: %d %s", rec.Code, rec.Body.String())
	}
	if status := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("status"); status != "backlog" {
		t.Errorf("the status changed before the refusal: %s", status)
	}
}

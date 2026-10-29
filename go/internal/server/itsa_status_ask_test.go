package server

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

// S-4178: a remote agent's move (PATCH) to a human status asks the human as a relayed original is routed (S-548, S-4163): the
// peer's daemon attaches the sender's routing facts, and the home routes the ask by them, as TestRelayedItsaPostToHuman does for a
// post. The owner and an exempt sender go direct, anyone else reroutes to the parent the facts name, and a move with no facts (an
// older peer) keeps main's delivery. A non-owner whose parent can't be reached is refused before the move, and the status stays.
func TestRelayedMoveAskRoutesLikeRelayedPost(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	far, ps := farDaemon(t)
	// The peer knows the two agents that move: the home resolves them through it, as they are not on this daemon.
	far.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT 'rother', 'rother', role, machine, harness, cwd, 'active', activity, created_at, updated_at FROM agents WHERE id = 'achild'")
	far.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT 'rowner', 'rowner', role, machine, harness, cwd, 'active', activity, created_at, updated_at FROM agents WHERE id = 'achild'")
	f := relayFixture(t, ps.ts.URL, "", nil)
	// The parent the moves reroute to is on this daemon, so the reroute is stored here, in its inbox.
	f.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT 'aboss', 'boss', role, machine, harness, cwd, 'active', activity, created_at, updated_at FROM agents WHERE id = 'achild'")
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle) VALUES ('rowner', 'rowner', 'far', '2026-10-26', 'active'), ('rother', 'rother', 'far', '2026-10-26', 'active')")
	n := 0
	// move makes a new ITSA owned by owner, has the peer's agent actor comment in it (a move to a human status follows a comment),
	// then moves it to needs_input through the peer's daemon with the given relay_route body fragment.
	move := func(owner, actor, route string) (*httptest.ResponseRecorder, string) {
		t.Helper()
		n++
		thread := "th-move-" + string(rune('a'+n))
		key := f.createItsa(`{"title":"Remote move ` + string(rune('a'+n)) + `","owner":"child","participants":["human"]}`)
		f.sql("UPDATE itsas SET owner = ?, thread_id = ? WHERE key = ?", owner, thread, key)
		f.sql("INSERT INTO mail (id, from_id, subject, body, created_at, thread_id, kind) VALUES (?, ?, 'Done', 'did it', '2999-01-01T00:00:00.000Z', ?, 'comment')", "mc-move-"+thread, actor, thread)
		id := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("id")
		rec := f.sendH("PATCH", "/api/itsas/"+key, peerTok, peerLocal, `{"status":"needs_input","by":"`+actor+`"`+route+`}`)
		return rec, id
	}
	asked := func(id, who string) int {
		return f.count("SELECT COUNT(*) FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE m.kind = 'ask' AND m.thread_id = (SELECT thread_id FROM itsas WHERE id = ?) AND r.agent_id = ?", id, who)
	}
	const mgr = `,"relay_route":{"exempt":false,"parent":"aboss"}`

	if rec, id := move("rowner", "rother", mgr); rec.Code != 200 || asked(id, "aboss") != 1 || asked(id, "human") != 0 {
		t.Errorf("a non-owner's move asks the human through its parent: %d %s", rec.Code, rec.Body.String())
	}
	if rec, id := move("child", "rother", `,"relay_route":{"exempt":true,"parent":"aboss"}`); rec.Code != 200 || asked(id, "human") != 1 {
		t.Errorf("an exempt sender's move asks the human directly, as on main: %d %s", rec.Code, rec.Body.String())
	}
	if rec, id := move("rowner", "rowner", mgr); rec.Code != 200 || asked(id, "human") != 1 {
		t.Errorf("the owner's move asks the human directly: %d %s", rec.Code, rec.Body.String())
	}
	if rec, id := move("rowner", "rowner", ""); rec.Code != 200 || asked(id, "human") != 1 {
		t.Errorf("a move with no routing facts asks the human directly, as on main: %d %s", rec.Code, rec.Body.String())
	}

	rec, key := move("child", "rother", `,"relay_route":{"exempt":false}`)
	if rec.Code == 200 || !strings.Contains(errorOf(t, rec), "parent can't be reached") {
		t.Fatalf("a non-owner whose parent can't be named is refused before the move: %d %s", rec.Code, rec.Body.String())
	}
	if status := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("status"); status != "backlog" {
		t.Errorf("the status changed before the refusal: %s", status)
	}
}

// S-4178: an agent's forged routing facts on a move are dropped by its own daemon, which attaches the facts of its agent (achild,
// acodex as its parent) from its DB, as it does for a post (TestItsaPostFactsComeFromTheSender).
func TestItsaMoveFactsComeFromTheSender(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	far, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, `"itsa":{"home":"far"}`, nil)
	key := far.createItsa(`{"title":"Home owned for a move","owner":"aboss","participants":["human"]}`)
	f.sendH("PATCH", "/api/itsas/"+key, agentTok, nil, `{"status":"needs_input","relay_route":{"exempt":true,"parent":"aboss"}}`)
	got := ps.last(t).body
	if !strings.Contains(got, `"relay_route":{"exempt":false,"parent":"acodex"}`) {
		t.Errorf("the home didn't get this daemon's facts for the agent on the move: %s", got)
	}
	if strings.Contains(got, `"exempt":true`) {
		t.Errorf("a forged exempt flag reached the home on the move: %s", got)
	}
}

// relayedMoveOn makes an ITSA owned by owner in thread, has the peer's agent actor comment in it (a move to a human status follows
// a comment), and moves it to needs_input through the peer's daemon with the given relay_route fragment.
func relayedMoveOn(t *testing.T, f *fixture, title, owner, thread, actor, route string) (*httptest.ResponseRecorder, string, string) {
	t.Helper()
	key := f.createItsa(`{"title":"` + title + `","owner":"child","participants":["human"]}`)
	f.sql("UPDATE itsas SET owner = ?, thread_id = ? WHERE key = ?", owner, thread, key)
	f.sql("INSERT INTO mail (id, from_id, subject, body, created_at, thread_id, kind) VALUES (?, ?, 'Done', 'did it', '2999-01-01T00:00:00.000Z', ?, 'comment')", "mc-"+key, actor, thread)
	id := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("id")
	rec := f.sendH("PATCH", "/api/itsas/"+key, peerTok, peerLocal, `{"status":"needs_input","by":"`+actor+`"`+route+`}`)
	return rec, key, id
}

// S-4178 review: an ask whose thread holds an ITSA the sender doesn't own is routed as its send routes it, so a non-owner's ask
// whose parent can't be named is refused before the move, and the status stays.
func TestRelayedAskSharedThreadRefusedBeforeMove(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	far, ps := farDaemon(t)
	far.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT 'rother', 'rother', role, machine, harness, cwd, 'active', activity, created_at, updated_at FROM agents WHERE id = 'achild'")
	f := relayFixture(t, ps.ts.URL, "", nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle) VALUES ('rowner', 'rowner', 'far', '2026-10-26', 'active'), ('rother', 'rother', 'far', '2026-10-26', 'active')")
	rec, key, id := relayedMoveOn(t, f, "Shared thread", "rother", "th-shared-a", "rother", "")
	if rec.Code != 200 {
		t.Fatalf("the sender's move to set up the thread: %d %s", rec.Code, rec.Body.String())
	}
	// The sender owns the moved ITSA, but the other ITSA in the thread is owned by child, not rother: the send checks it too, so its
	// reroute can't be reached and the move is refused.
	other := f.createItsa(`{"title":"Shared thread other","owner":"child","participants":["human"]}`)
	f.sql("UPDATE itsas SET thread_id = 'th-shared-a' WHERE key = ?", other)
	f.sql("UPDATE itsas SET status = 'backlog' WHERE key = ?", key)
	rec = f.sendH("PATCH", "/api/itsas/"+key, peerTok, peerLocal, `{"status":"needs_input","by":"rother","relay_route":{"exempt":false}}`)
	if rec.Code == 200 || !strings.Contains(errorOf(t, rec), "parent can't be reached") {
		t.Errorf("a shared-thread ask with no parent is refused before the move: %d %s", rec.Code, rec.Body.String())
	}
	if status := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("status"); status != "backlog" {
		t.Errorf("the status changed before the refusal: %s (%s)", status, id)
	}
}

// S-4178 review: a sender that owns the moved ITSA but not another ITSA in its thread isn't the owner the ask goes direct for, so it
// reroutes to its parent: a reachable parent on the peer lets the move go ahead, and an unreachable one refuses it before the move.
func TestRelayedAskSharedThreadReroutesToReachableParent(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	far, ps := farDaemon(t)
	far.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT 'rother', 'rother', role, machine, harness, cwd, 'active', activity, created_at, updated_at FROM agents WHERE id = 'achild'")
	far.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT 'rparent', 'rparent', role, machine, harness, cwd, 'active', activity, created_at, updated_at FROM agents WHERE id = 'achild'")
	f := relayFixture(t, ps.ts.URL, "", nil)
	// rparent's remembered lifecycle is NULL, as an older peer row is: the route reads it as active, and so does the recheck.
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle) VALUES ('rowner', 'rowner', 'far', '2026-10-26', 'active'), ('rother', 'rother', 'far', '2026-10-26', 'active'), ('rparent', 'rparent', 'far', '2026-10-26', NULL)")
	// The other ITSA in the thread is owned by rowner, so rother owns the thread only partly.
	other := f.createItsa(`{"title":"Reachable thread other","owner":"child","participants":["human"]}`)
	f.sql("UPDATE itsas SET owner = 'rowner', thread_id = 'th-reach-a' WHERE key = ?", other)
	rec, key, _ := relayedMoveOn(t, f, "Reachable parent", "rother", "th-reach-a", "rother", `,"relay_route":{"exempt":false,"parent":"rparent"}`)
	if rec.Code != 200 {
		t.Errorf("a partly owned thread's ask reroutes to a reachable parent, and the move goes ahead: %d %s", rec.Code, rec.Body.String())
	}
	if status := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("status"); status != "needs_input" {
		t.Errorf("the reachable-parent move didn't change the status: %s", status)
	}
	// The ask goes to the parent on the peer, and to no human here: the outbox delivers it now, and far's record shows where it landed.
	<-f.srv.drainOutbox()
	if n := f.count("SELECT COUNT(*) FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE m.kind = 'ask' AND m.thread_id = 'th-reach-a' AND r.agent_id = 'human'"); n != 0 {
		t.Errorf("the reachable-parent ask reached the human directly here: %d", n)
	}
	if n := far.count("SELECT COUNT(*) FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE m.kind = 'ask' AND m.thread_id = 'th-reach-a' AND r.agent_id = 'rparent'"); n != 1 {
		t.Errorf("the reachable-parent ask isn't addressed to the parent on far: %d", n)
	}
	if n := far.count("SELECT COUNT(*) FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE m.kind = 'ask' AND m.thread_id = 'th-reach-a' AND r.agent_id = 'human'"); n != 0 {
		t.Errorf("the reachable-parent ask reached the human on far: %d", n)
	}
	rec, key, _ = relayedMoveOn(t, f, "Unreachable parent", "rother", "th-reach-a", "rother", `,"relay_route":{"exempt":false,"parent":"nobody-here"}`)
	if rec.Code == 200 || !strings.Contains(errorOf(t, rec), "parent can't be reached") {
		t.Errorf("a partly owned thread's ask with an unreachable parent is refused before the move: %d %s", rec.Code, rec.Body.String())
	}
	if status := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("status"); status != "backlog" {
		t.Errorf("the unreachable-parent move changed the status: %s", status)
	}
}

// S-4178 review: the parent's lifecycle is rechecked inside the move against the one the route read. A remembered NULL is unchanged
// (the route read it as active), and a parent archived since the route was read aborts the move with a 409.
func TestRelayedAskParentLifecycleRecheck(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := relayFixture(t, "", "", nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle) VALUES ('rparent', 'rparent', 'far', '2026-10-26', NULL)")
	relay := &relayRouteFacts{parent: "rparent", parentFound: true, parentLife: "active"}
	ctx := context.Background()
	if direct, err := f.srv.relayedAskDirect(ctx, "rother", "", "", "", relay); err != nil || direct {
		t.Errorf("a NULL remembered parent lifecycle is unchanged, and the ask reroutes: direct %v, %v", direct, err)
	}
	f.sql("UPDATE peer_agents SET lifecycle = 'archived' WHERE id = 'rparent'")
	if _, err := f.srv.relayedAskDirect(ctx, "rother", "", "", "", relay); err == nil || !strings.Contains(err.Error(), "the parent changed") {
		t.Errorf("a parent archived since the route was read aborts the move: %v", err)
	}
}

// S-4178 review: an exempt sender's or an owner's ask goes direct even when its parent id doesn't resolve: no refusal.
func TestRelayedAskAmbiguousParentGoesDirect(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	far, ps := farDaemon(t)
	far.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT 'rother', 'rother', role, machine, harness, cwd, 'active', activity, created_at, updated_at FROM agents WHERE id = 'achild'")
	far.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT 'rowner', 'rowner', role, machine, harness, cwd, 'active', activity, created_at, updated_at FROM agents WHERE id = 'achild'")
	f := relayFixture(t, ps.ts.URL, "", nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle) VALUES ('rowner', 'rowner', 'far', '2026-10-26', 'active'), ('rother', 'rother', 'far', '2026-10-26', 'active')")
	asked := func(id string) int {
		return f.count("SELECT COUNT(*) FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE m.kind = 'ask' AND m.thread_id = (SELECT thread_id FROM itsas WHERE id = ?) AND r.agent_id = 'human'", id)
	}
	if rec, _, id := relayedMoveOn(t, f, "Exempt ambiguous", "rother", "th-amb-1", "rother", `,"relay_route":{"exempt":true,"parent":"nobody-here"}`); rec.Code != 200 || asked(id) != 1 {
		t.Errorf("an exempt sender's ask with an unresolvable parent goes direct: %d %s", rec.Code, rec.Body.String())
	}
	if rec, _, id := relayedMoveOn(t, f, "Owner ambiguous", "rowner", "th-amb-2", "rowner", `,"relay_route":{"exempt":false,"parent":"nobody-here"}`); rec.Code != 200 || asked(id) != 1 {
		t.Errorf("an owner's ask with an unresolvable parent goes direct: %d %s", rec.Code, rec.Body.String())
	}
}

// S-4178 review: the home refuses a move whose body carries relay_route from an agent's own token: only a peer's daemon relays the
// routing facts, so an agent can't claim to be exempt on its own home.
func TestItsaMoveForgedOnTheHomeIsRefused(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	key := f.createItsa(`{"title":"Home move","owner":"aboss"}`)
	rec := f.sendH("PATCH", "/api/itsas/"+key, agentTok, nil, `{"status":"needs_input","relay_route":{"exempt":true,"parent":"forged"}}`)
	if rec.Code != 403 || !strings.Contains(errorOf(t, rec), "set only by stam") {
		t.Errorf("a forged relay_route on a move to the home: %d %s", rec.Code, rec.Body.String())
	}
	if status := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("status"); status != "backlog" {
		t.Errorf("the status changed on a forged move: %s", status)
	}
}

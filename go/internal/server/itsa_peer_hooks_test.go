package server

import (
	"path/filepath"
	"strings"
	"testing"
)

// peerHooksFixture is an ITSA home with two peers, east and west, holding the agents given (id to JSON).
func peerHooksFixture(t *testing.T, settings string, east, west map[string]string) (*fixture, *farPeer, *farPeer) {
	t.Helper()
	e, w := newFarPeer(t, east), newFarPeer(t, west)
	f := newFixture(t, nil)
	if settings != "" {
		settings += ","
	}
	writeFile(t, filepath.Join(f.home, "settings.json"), `{`+settings+`"peers":[{"name":"east","url":"`+e.URL+`","token":"test-peer-token"},{"name":"west","url":"`+w.URL+`","token":"test-peer-token"}]}`)
	return f, e, w
}

// peerCall is a peer's call to a hook on the home, as the agent via when it is set.
func (f *fixture) peerCall(path, via, body string) (int, string) {
	f.t.Helper()
	h := map[string]string{"X-Stam-Local": "1"}
	if via != "" {
		h["X-Stam-Agent"] = via
	}
	rec := f.sendH("POST", path, peerTok, h, body)
	return rec.Code, rec.Body.String()
}

// join, leave and may-participate act for a peer's spawn as the agent that asked for it, which may give the new agent
// only an ITSA it may change (src/itsa-owners.ts mayAssign); the peer's own call, with no agent, is the daemon's.
func TestPeerHookJoinLeave(t *testing.T) {
	f, _, _ := peerHooksFixture(t, "", map[string]string{"apeer": `{"id":"apeer","name":"peer","machine":"east","lifecycle":"active"}`}, nil)
	key := f.createItsa(`{"title":"boss work","owner":"boss"}`)
	members := func() string {
		return f.text("SELECT group_concat(agent_id) FROM (SELECT p.agent_id FROM itsa_participants p JOIN itsas x ON x.id = p.itsa_id WHERE x.key = ? AND p.left_at IS NULL ORDER BY p.agent_id)", key)
	}
	before := members()
	for _, path := range []string{"/api/itsas/join", "/api/itsas/leave", "/api/itsas/may-participate"} {
		if code, body := f.peerCall(path, "achild", `{"itsa":"`+key+`","agent":"apeer"}`); code != 403 {
			t.Errorf("%s as an agent that may not change it: %d %s", path, code, body)
		}
	}
	if got := members(); got != before {
		t.Fatalf("a refused join changed the members: %q", got)
	}
	if code, body := f.peerCall("/api/itsas/may-participate", "aboss", `{"itsa":"`+key+`"}`); code != 200 || !strings.Contains(body, `"ok":true`) {
		t.Errorf("may-participate as the owner: %d %s", code, body)
	}
	if code, body := f.peerCall("/api/itsas/may-participate", "aboss", `{"itsa":"S-999"}`); code != 404 {
		t.Errorf("may-participate on no ITSA: %d %s", code, body)
	}
	if code, body := f.peerCall("/api/itsas/join", "aboss", `{"itsa":"`+key+`","agent":"apeer","by":"aboss"}`); code != 200 {
		t.Fatalf("join as the owner: %d %s", code, body)
	}
	if got := members(); !strings.Contains(got, "apeer") {
		t.Errorf("joined: %q", got)
	}
	if code, body := f.peerCall("/api/itsas/leave", "", `{"itsa":"`+key+`","agent":"apeer"}`); code != 200 {
		t.Fatalf("leave as the peer's daemon: %d %s", code, body)
	}
	if got := members(); got != before {
		t.Errorf("after leave: %q, want %q", got, before)
	}
}

// join-parent joins a peer's new agent to its parent's open ITSA, under settings.itsa.required.
func TestPeerHookJoinParent(t *testing.T) {
	f, _, _ := peerHooksFixture(t, `"itsa":{"required":true}`, map[string]string{"anew": `{"id":"anew","name":"new","machine":"east","lifecycle":"active"}`}, nil)
	key := f.createItsa(`{"title":"boss work","owner":"boss","status":"in_progress"}`)
	code, body := f.peerCall("/api/itsas/join-parent", "", `{"agent":"anew","parent":"aboss","by":"aboss"}`)
	if code != 200 || !strings.Contains(body, `"key":"`+key+`"`) {
		t.Fatalf("join-parent: %d %s", code, body)
	}
	if n := f.count("SELECT count(*) FROM itsa_participants p JOIN itsas x ON x.id = p.itsa_id WHERE x.key = ? AND p.agent_id = 'anew'", key); n != 1 {
		t.Errorf("anew is in %d rows", n)
	}
	// A parent with no open ITSA: nothing joined.
	if code, body := f.peerCall("/api/itsas/join-parent", "", `{"agent":"anew","parent":"achild"}`); code != 200 || !strings.Contains(body, `"key":null`) {
		t.Errorf("join-parent with none: %d %s", code, body)
	}
}

// owner-stopped and unown-agent act only for an agent that a peer holds, with this exact id, in the state claimed: one
// of this machine's, one no peer holds, a name for an id, or one in another state is 403, final; a peer that may hold it
// and doesn't answer is 503, so the reporting peer tries again.
func TestPeerHookReports(t *testing.T) {
	f, east, _ := peerHooksFixture(t, "", map[string]string{
		"astop":   `{"id":"astop","name":"stopper","machine":"east","lifecycle":"shut_down"}`,
		"stopper": `{"id":"astop","name":"stopper","machine":"east","lifecycle":"shut_down"}`,
		"aarch":   `{"id":"aarch","name":"archived","machine":"east","lifecycle":"archived"}`,
		"alive":   `{"id":"alive","name":"alive","machine":"east","lifecycle":"active"}`,
		// An id east minted too: the home's own boss is still no peer's.
		"aboss": `{"id":"aboss","name":"boss","machine":"east","lifecycle":"archived"}`,
	}, nil)
	n := &notices{}
	f.srv.noticeHook = n.add
	parent := f.createItsa(`{"title":"parent","owner":"boss","status":"in_progress"}`)
	stopped := f.createItsa(`{"title":"stopped kid","parent":"` + parent + `","status":"in_progress"}`)
	f.sql("UPDATE itsas SET owner = 'astop' WHERE key = ?", stopped)
	gone := f.createItsa(`{"title":"archived kid","parent":"` + parent + `","status":"in_progress"}`)
	f.sql("UPDATE itsas SET owner = 'aarch' WHERE key = ?", gone)
	live := f.createItsa(`{"title":"live kid","parent":"` + parent + `","status":"in_progress"}`)
	f.sql("UPDATE itsas SET owner = 'alive' WHERE key = ?", live)
	until(t, "the creates' notices", func() bool { return true })
	start := len(n.all())

	for _, tc := range []struct{ path, body string }{
		{"/api/itsas/owner-stopped", `{"id":"aboss","name":"boss","what":"errored"}`},
		{"/api/itsas/owner-stopped", `{"id":"aghost","name":"ghost","what":"errored"}`},
		{"/api/itsas/owner-stopped", `{"id":"stopper","name":"stopper","what":"errored"}`},
		{"/api/itsas/unown-agent", `{"id":"alive","name":"alive","how":"archived"}`},
		{"/api/itsas/unown-agent", `{"id":"astop","name":"stopper","how":"archived"}`},
		{"/api/itsas/unown-agent", `{"id":"aboss","name":"boss","how":"forgotten"}`},
	} {
		if code, body := f.peerCall(tc.path, "", tc.body); code != 403 {
			t.Errorf("%s %s: %d %s", tc.path, tc.body, code, body)
		}
	}
	if got := f.text("SELECT group_concat(owner) FROM (SELECT owner FROM itsas WHERE key IN (?, ?, ?) ORDER BY key)", stopped, gone, live); got != "astop,aarch,alive" {
		t.Fatalf("a refused report changed owners: %s", got)
	}

	if code, body := f.peerCall("/api/itsas/owner-stopped", "", `{"id":"astop","name":"stopper","what":"was shut down"}`); code != 200 {
		t.Fatalf("owner-stopped: %d %s", code, body)
	}
	until(t, "the stop notice", func() bool { return len(n.all()) > start })
	if got := n.all()[start]; !strings.HasPrefix(got, "aboss: ") || !strings.Contains(got, "stopper was shut down") || !strings.Contains(got, stopped) {
		t.Errorf("notice %s", got)
	}

	if code, body := f.peerCall("/api/itsas/unown-agent", "", `{"id":"aarch","name":"archived","how":"archived","parent":null}`); code != 200 {
		t.Fatalf("unown-agent: %d %s", code, body)
	}
	if got := f.text("SELECT ifnull(owner, 'none') || ' ' || status FROM itsas WHERE key = ?", gone); got != "none ready" {
		t.Errorf("the archived agent's ITSA: %s", got)
	}
	// A forget: a shut-down agent counts.
	if code, body := f.peerCall("/api/itsas/unown-agent", "", `{"id":"astop","name":"stopper","how":"forgotten"}`); code != 200 {
		t.Fatalf("unown-agent forgotten: %d %s", code, body)
	}
	if got := f.text("SELECT ifnull(owner, 'none') FROM itsas WHERE key = ?", stopped); got != "none" {
		t.Errorf("the forgotten agent's ITSA: %s", got)
	}

	// The peer that may hold it is down: try again.
	east.Close()
	if code, body := f.peerCall("/api/itsas/unown-agent", "", `{"id":"alive","name":"alive","how":"archived"}`); code != 503 {
		t.Errorf("with the holder down: %d %s", code, body)
	}
	if code, body := f.peerCall("/api/itsas/owner-stopped", "", `{"id":"alive","name":"alive","what":"errored"}`); code != 503 {
		t.Errorf("owner-stopped with the holder down: %d %s", code, body)
	}
	if got := f.text("SELECT owner FROM itsas WHERE key = ?", live); got != "alive" {
		t.Errorf("live kid's owner %s", got)
	}
}

// switch-owner moves a switched agent's open ITSAs to its successor only on its holder's word: one peer holds both, and
// the predecessor's forwarded_to names the successor. A successor on another peer (three machines), one archived, a
// predecessor with no such forwarded_to, one of this machine's and a holder that is down move nothing.
func TestPeerHookSwitchOwner(t *testing.T) {
	f, east, _ := peerHooksFixture(t, "", map[string]string{
		"apred":  `{"id":"apred","name":"pred","machine":"east","lifecycle":"shut_down","forwarded_to":"asucc"}`,
		"asucc":  `{"id":"asucc","name":"succ","machine":"east","lifecycle":"active"}`,
		"across": `{"id":"across","name":"cross","machine":"east","lifecycle":"shut_down","forwarded_to":"awest"}`,
		"adead":  `{"id":"adead","name":"dead","machine":"east","lifecycle":"shut_down","forwarded_to":"aarch"}`,
		"aarch":  `{"id":"aarch","name":"arch","machine":"east","lifecycle":"archived"}`,
		"aplain": `{"id":"aplain","name":"plain","machine":"east","lifecycle":"active"}`,
		// An id east minted too: the home's own boss is still no peer's to switch.
		"aboss": `{"id":"aboss","name":"boss","machine":"east","lifecycle":"shut_down","forwarded_to":"asucc"}`,
	}, map[string]string{
		"awest": `{"id":"awest","name":"west","machine":"west","lifecycle":"active"}`,
	})
	open := f.createItsa(`{"title":"open","status":"in_progress"}`)
	closed := f.createItsa(`{"title":"closed","status":"done"}`)
	part := f.createItsa(`{"title":"joined","owner":"boss","participants":["achild"]}`)
	f.sql("UPDATE itsas SET owner = 'apred' WHERE key IN (?, ?)", open, closed)
	f.sql("INSERT INTO itsa_participants (itsa_id, agent_id) SELECT id, 'apred' FROM itsas WHERE key = ?", part)
	for _, tc := range []struct{ body, msg string }{
		{`{"from":"across","to":"awest"}`, "only a peer holding"},
		{`{"from":"adead","to":"aarch"}`, "is archived"},
		{`{"from":"aplain","to":"asucc"}`, "only a peer holding"},
		{`{"from":"apred","to":"aplain"}`, "only a peer holding"},
		{`{"from":"aboss","to":"asucc"}`, "only a peer holding"},
		{`{"from":"asucc","to":"asucc"}`, "only a peer holding"},
	} {
		if code, body := f.peerCall("/api/itsas/switch-owner", "", tc.body); code != 403 || !strings.Contains(body, tc.msg) {
			t.Errorf("%s: %d %s, want 403 %q", tc.body, code, body, tc.msg)
		}
	}
	if got := f.text("SELECT owner FROM itsas WHERE key = ?", open); got != "apred" {
		t.Fatalf("a refused switch moved %s to %s", open, got)
	}
	code, body := f.peerCall("/api/itsas/switch-owner", "", `{"from":"apred","to":"asucc"}`)
	if code != 200 || !strings.Contains(body, `"moved":["`+open+`"]`) {
		t.Fatalf("switch-owner: %d %s", code, body)
	}
	if got := f.text("SELECT group_concat(owner) FROM (SELECT owner FROM itsas WHERE key IN (?, ?) ORDER BY key)", open, closed); got != "asucc,apred" {
		t.Errorf("owners after the move: %s", got)
	}
	if n := f.count("SELECT count(*) FROM itsa_participants p JOIN itsas x ON x.id = p.itsa_id WHERE x.key = ? AND p.agent_id = 'asucc'", part); n != 1 {
		t.Errorf("the successor isn't in the ITSA its predecessor took part in")
	}
	// A repeat moves nothing twice.
	if code, body := f.peerCall("/api/itsas/switch-owner", "", `{"from":"apred","to":"asucc"}`); code != 200 || !strings.Contains(body, `"moved":[]`) {
		t.Errorf("the repeat: %d %s", code, body)
	}
	east.Close()
	if code, body := f.peerCall("/api/itsas/switch-owner", "", `{"from":"apred","to":"asucc"}`); code != 503 {
		t.Errorf("with the holder down: %d %s", code, body)
	}
}

// switch-owner never hands ITSAs to an agent of the home: a peer that switched to an id the home has too (here the home's
// archived boss, which the peer also answers for as its own active agent) moves nothing, since the home's row would win.
func TestPeerHookSwitchOwnerLocalSuccessor(t *testing.T) {
	f, _, _ := peerHooksFixture(t, "", map[string]string{
		"apred2": `{"id":"apred2","name":"pred2","machine":"east","lifecycle":"shut_down","forwarded_to":"aboss"}`,
		"aboss":  `{"id":"aboss","name":"boss","machine":"east","lifecycle":"active"}`,
	}, nil)
	f.sql("UPDATE agents SET lifecycle = 'archived' WHERE id = 'aboss'")
	open := f.createItsa(`{"title":"open","status":"in_progress"}`)
	part := f.createItsa(`{"title":"joined","owner":"child","participants":["achild"]}`)
	f.sql("UPDATE itsas SET owner = 'apred2' WHERE key = ?", open)
	f.sql("INSERT INTO itsa_participants (itsa_id, agent_id) SELECT id, 'apred2' FROM itsas WHERE key = ?", part)
	if code, body := f.peerCall("/api/itsas/switch-owner", "", `{"from":"apred2","to":"aboss"}`); code != 403 || !strings.Contains(body, "only a peer holding") {
		t.Errorf("a switch to the home's own agent: %d %s", code, body)
	}
	if got := f.text("SELECT owner FROM itsas WHERE key = ?", open); got != "apred2" {
		t.Errorf("%s moved to %s", open, got)
	}
	if n := f.count("SELECT count(*) FROM itsa_participants WHERE agent_id = 'aboss'"); n != 0 {
		t.Errorf("the home's boss joined %d ITSAs", n)
	}
}

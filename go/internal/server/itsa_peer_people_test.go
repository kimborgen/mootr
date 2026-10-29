package server

import (
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

// A peer's agent in an ITSA on the home (src/itsa.ts person over findAgentPeerFresh): an owner, a participant or the
// actor that is an agent of another machine resolves through the peers to its id, as mail resolves remote recipients.
// A lookup no peer answered with is asked once more of each peer that was up (S-2927): right after a restart the first
// ask can fail on a peer that knows the agent.
func TestItsaPeerAgentPeople(t *testing.T) {
	var lateAsks atomic.Int32
	far := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agents/remote-one", "/api/agents/apeer":
			writeJSON(w, 200, map[string]any{"id": "apeer", "name": "remote-one", "machine": "far", "lifecycle": "active"})
		case "/api/agents/late":
			// The first ask fails, as a busy peer's does after a restart; the second answers.
			if lateAsks.Add(1) == 1 {
				writeError(w, Errorf(http.StatusServiceUnavailable, "busy"))
				return
			}
			writeJSON(w, 200, map[string]any{"id": "alate", "name": "late", "machine": "far", "lifecycle": "active"})
		case "/api/agents/mirror":
			// A peer that relayed the lookup back: it answers with an agent of this machine, which is no peer's.
			writeJSON(w, 200, map[string]any{"id": "amirror", "name": "mirror", "machine": "here", "lifecycle": "active"})
		default:
			writeError(w, Errorf(http.StatusNotFound, "no agent"))
		}
	}))
	f := relayFixture(t, far.ts.URL, "", nil)

	rec := f.sendH("POST", "/api/itsas", sharedTok, human, `{"title":"remote-owned","owner":"remote-one","participants":["apeer","achild"]}`)
	if rec.Code != 200 {
		t.Fatalf("a peer's agent as owner: %d %s", rec.Code, rec.Body.String())
	}
	key := f.body(rec).Text("key")
	if got := f.text("SELECT owner FROM itsas WHERE key = ?", key); got != "apeer" {
		t.Errorf("owner %q", got)
	}
	if n := f.count("SELECT count(*) FROM itsa_participants p JOIN itsas x ON x.id = p.itsa_id WHERE x.key = ? AND p.agent_id IN ('apeer', 'achild')", key); n != 2 {
		t.Errorf("%d participants", n)
	}
	if n := f.count("SELECT count(*) FROM peer_agents WHERE id = 'apeer' AND machine = 'far'"); n != 1 {
		t.Error("the peer's agent isn't remembered")
	}

	// A peer's call acting for its own agent: the actor is that agent.
	local := map[string]string{"X-Stam-Local": "1"}
	if rec := f.sendH("PATCH", "/api/itsas/"+key, peerTok, local, `{"status":"in_progress","by":"remote-one"}`); rec.Code != 200 {
		t.Fatalf("a peer's agent's change: %d %s", rec.Code, rec.Body.String())
	}
	if got := f.text("SELECT actor FROM itsa_events e JOIN itsas x ON x.id = e.itsa_id WHERE x.key = ? AND e.type = 'status' ORDER BY e.id DESC LIMIT 1", key); got != "apeer" {
		t.Errorf("the change's actor %q", got)
	}

	// The retry: the first ask for late fails, the second finds it.
	if rec := f.sendH("PATCH", "/api/itsas/"+key, sharedTok, human, `{"owner":"late"}`); rec.Code != 200 {
		t.Fatalf("an owner found on the retry: %d %s", rec.Code, rec.Body.String())
	}
	if got := f.text("SELECT owner FROM itsas WHERE key = ?", key); got != "alate" || lateAsks.Load() != 2 {
		t.Errorf("owner %q after %d asks", got, lateAsks.Load())
	}

	// No peer has it: no agent, and nothing changes.
	if rec := f.sendH("PATCH", "/api/itsas/"+key, sharedTok, human, `{"owner":"ghost"}`); rec.Code != 400 || !strings.Contains(errorOf(t, rec), "no agent ghost") {
		t.Errorf("an agent no one has: %d %s", rec.Code, rec.Body.String())
	}
	// A peer answering with this machine's own agent (one no longer here) has none either.
	if rec := f.sendH("PATCH", "/api/itsas/"+key, sharedTok, human, `{"owner":"mirror"}`); rec.Code != 400 || !strings.Contains(errorOf(t, rec), "no agent mirror") {
		t.Errorf("our own agent through a peer: %d %s", rec.Code, rec.Body.String())
	}
}

// A post in an ITSA with participants on a peer (src/itsa.ts post): the home sends it on to the peer's live
// participants, with its ITSA, kind and the ones it interrupts; an archived one on the peer is skipped. The peer stores
// it under that ITSA, quiet for a recipient it doesn't interrupt.
func TestItsaPostToPeerParticipants(t *testing.T) {
	far := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agents/bfar":
			writeJSON(w, 200, map[string]any{"id": "bfar", "name": "farone", "machine": "far", "lifecycle": "active"})
		case "/api/agents/bgone":
			writeJSON(w, 200, map[string]any{"id": "bgone", "name": "gone", "machine": "far", "lifecycle": "archived"})
		case "/api/mail":
			writeJSON(w, 200, map[string]any{"id": "ok"})
		default:
			writeError(w, Errorf(http.StatusNotFound, "no agent"))
		}
	}))
	f := relayFixture(t, far.ts.URL, "", nil)
	rec := f.sendH("POST", "/api/itsas", sharedTok, human, `{"title":"shared","participants":["bfar","bgone","achild"]}`)
	if rec.Code != 200 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	key := f.body(rec).Text("key")
	// A participant's post interrupts only those it names: the peer's agent by its name.
	if rec := f.sendH("POST", "/api/itsas/"+key+"/post", agentTok, nil, `{"body":"hi @farone"}`); rec.Code != 200 {
		t.Fatalf("the child's post: %d %s", rec.Code, rec.Body.String())
	}
	posts := mailPosts(far)
	if len(posts) != 1 || !strings.Contains(posts[0], `"to":["bfar"]`) || !strings.Contains(posts[0], `"itsa_id":"`) ||
		!strings.Contains(posts[0], `"kind":"comment"`) || !strings.Contains(posts[0], `"interrupt":["bfar"]`) {
		t.Errorf("far got %q", posts)
	}
	// The human's post interrupts everyone, child here too, but far hears only of its own recipients.
	if rec := f.sendH("POST", "/api/itsas/"+key+"/post", sharedTok, human, `{"body":"hi all"}`); rec.Code != 200 {
		t.Fatalf("the human's post: %d %s", rec.Code, rec.Body.String())
	}
	if got := f.text("SELECT group_concat(agent_id || ':' || quiet) FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE m.itsa_id IS NOT NULL AND m.from_id = 'human' AND r.agent_id = 'achild'"); got != "achild:0" {
		t.Errorf("child here: %q", got)
	}
	if posts = mailPosts(far); len(posts) != 2 || !strings.Contains(posts[1], `"interrupt":["bfar"]`) {
		t.Errorf("far got %q", posts)
	}

	// The receiving side: a peer's forwarded post is stored under its ITSA, quiet for those it doesn't interrupt.
	g := newFixture(t, map[string]string{"STAM_MACHINE": "far"})
	in := `{"from":"aremote","to":["achild","aboss"],"subject":"S-9 x","body":"b","forwarded":{"from_name":"remote"},"mail_id":"m00f0001","thread_id":"m00f0002","itsa_id":"i-remote","kind":"update","health":"at_risk","interrupt":["aboss"]}`
	if rec := g.sendH("POST", "/api/mail", peerTok, map[string]string{"x-stam-local": "1"}, in); rec.Code != 200 {
		t.Fatalf("a forwarded post: %d %s", rec.Code, rec.Body.String())
	}
	if got := g.text("SELECT itsa_id || ' ' || kind || ' ' || health || ' ' || thread_id FROM mail WHERE id = 'm00f0001'"); got != "i-remote update at_risk m00f0002" {
		t.Errorf("the stored post: %q", got)
	}
	if got := g.text("SELECT group_concat(agent_id || ':' || quiet) FROM (SELECT * FROM mail_recipients WHERE mail_id = 'm00f0001' ORDER BY agent_id)"); got != "aboss:0,achild:1" {
		t.Errorf("recipients %q", got)
	}
}

// A forwarded mail's ITSA fields file it under an ITSA and choose whom it interrupts: they count only from a peer's
// daemon (the peer token with x-stam-local), whatever auth.humanStrict says, and only in the shape the home's post sends.
func TestForwardedItsaFieldsChecked(t *testing.T) {
	g := newFixture(t, map[string]string{"STAM_MACHINE": "far"})
	n := 0
	mail := func(extra string) string {
		n++
		return fmt.Sprintf(`{"from":"aremote","to":["achild","aboss"],"subject":"s","body":"b","forwarded":{"from_name":"remote"},"mail_id":"m00f1%03d","thread_id":"m00f2000"%s}`, n, extra)
	}
	local := map[string]string{"x-stam-local": "1"}
	itsaFields := `,"itsa_id":"i-remote","kind":"comment","interrupt":["aboss"]`
	for _, tc := range []struct {
		name, token string
		header      map[string]string
	}{
		{"the shared token", sharedTok, human},
		{"the shared token, no human", sharedTok, nil},
		{"the peer token without x-stam-local", peerTok, nil},
		{"an agent's token", agentTok, nil},
	} {
		for _, extra := range []string{itsaFields, `,"kind":"update","health":"on_track"`, `,"interrupt":["aboss"]`, `,"itsa_id":"i-remote"`} {
			rec := g.sendH("POST", "/api/mail", tc.token, tc.header, mail(extra))
			if rec.Code != 403 {
				t.Errorf("%s with %s: %d %s", tc.name, extra, rec.Code, rec.Body.String())
			}
		}
	}
	if got := g.count("SELECT count(*) FROM mail WHERE itsa_id IS NOT NULL"); got != 0 {
		t.Errorf("%d refused mails stored under an ITSA", got)
	}
	for _, tc := range []struct{ extra, msg string }{
		{`,"itsa_id":7`, "needs an itsa_id"},
		{`,"itsa_id":"../x"`, "needs an itsa_id"},
		{`,"interrupt":["aboss"]`, "needs an itsa_id"},
		{`,"itsa_id":"i-remote","kind":"ask!"`, "unknown kind"},
		{`,"itsa_id":"i-remote","kind":3`, "bad kind"},
		{`,"itsa_id":"i-remote","kind":"update"`, "needs a health"},
		{`,"itsa_id":"i-remote","kind":"update","health":"great"`, "needs a health"},
		{`,"itsa_id":"i-remote","kind":"comment","health":"on_track"`, "only an update"},
		{`,"itsa_id":"i-remote","health":["on_track"]`, "bad health"},
		{`,"itsa_id":"i-remote","interrupt":"aboss"`, "list of agent ids"},
		{`,"itsa_id":"i-remote","interrupt":[1]`, "list of agent ids"},
	} {
		rec := g.sendH("POST", "/api/mail", peerTok, local, mail(tc.extra))
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), tc.msg) {
			t.Errorf("%s: %d %s, want 400 %q", tc.extra, rec.Code, rec.Body.String(), tc.msg)
		}
	}
	// A peer's well-formed post: an interrupt id that is no recipient here (a TS home sends the whole list) changes nothing.
	if rec := g.sendH("POST", "/api/mail", peerTok, local, mail(`,"itsa_id":"i-remote","kind":"update","health":"at_risk","interrupt":["aboss","aelsewhere"]`)); rec.Code != 200 {
		t.Fatalf("a peer's post: %d %s", rec.Code, rec.Body.String())
	}
	id := fmt.Sprintf("m00f1%03d", n)
	if got := g.text("SELECT group_concat(agent_id || ':' || quiet) FROM (SELECT * FROM mail_recipients WHERE mail_id = ? ORDER BY agent_id)", id); got != "aboss:0,achild:1" {
		t.Errorf("recipients %q", got)
	}
	// A null field is no field, as TS forwards its input.
	if rec := g.sendH("POST", "/api/mail", peerTok, local, mail(`,"itsa_id":null,"kind":null,"health":null,"interrupt":null`)); rec.Code != 200 {
		t.Errorf("nulls from a peer: %d %s", rec.Code, rec.Body.String())
	}
}

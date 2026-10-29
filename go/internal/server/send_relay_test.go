package server

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

// A relayed send (src/mail.ts relay): a peer's forwarded mail this daemon sends on, as the ITSA home does for an agent on a
// peer. Its recipients are looked up on the peers too, and a send that went only to peers answers with the peer's stored
// mail; nothing is kept here. A forwarded mail without relay names only agents here.
func TestSendRelayed(t *testing.T) {
	far, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", nil)
	ctx := context.Background()
	before := f.count("SELECT count(*) FROM mail")

	in := `{"from":"aremote","to":["boss"],"subject":"relayed","body":"x","forwarded":{"from_name":"remo"}`
	if rec := f.sendH("POST", "/api/mail", peerTok, peerLocal, in+`}`); rec.Code != 400 || !strings.Contains(errorOf(t, rec), "no agent boss") {
		t.Errorf("a forwarded mail to a peer's agent: %d %s", rec.Code, rec.Body.String())
	}
	rec := f.sendH("POST", "/api/mail", peerTok, peerLocal, in+`,"relay":true}`)
	if rec.Code != 200 {
		t.Fatalf("a relayed send: %d %s", rec.Code, rec.Body.String())
	}
	sent := f.body(rec)
	theirs, ok, err := far.db.GetMail(ctx, sent.Text("id"))
	must(t, err)
	if !ok || theirs.Text("from_id") != "aremote" || theirs.Text("from_name") != "remo" || theirs.Text("thread_id") != sent.Text("thread_id") {
		t.Fatalf("far's copy: %v %s", ok, jsfmt.Compact(theirs))
	}
	if strings.Contains(ps.last(t).body, `"relay"`) {
		t.Errorf("the relay flag went on to far: %s", ps.last(t).body)
	}
	if n := f.count("SELECT count(*) FROM mail"); n != before {
		t.Errorf("a relayed send kept %d mails here", n-before)
	}
	// Mixed: the agent here gets it under the same id far stores.
	rec = f.sendH("POST", "/api/mail", peerTok, peerLocal, `{"from":"aremote","to":["achild","boss"],"subject":"both","body":"x","forwarded":{"from_name":"remo"},"relay":true}`)
	if rec.Code != 200 {
		t.Fatalf("a relayed send here and on far: %d %s", rec.Code, rec.Body.String())
	}
	id := f.body(rec).Text("id")
	if n := f.count("SELECT count(*) FROM mail_recipients WHERE mail_id = ? AND agent_id = 'achild'", id); n != 1 {
		t.Errorf("child got %d copies", n)
	}
	if _, ok, _ := far.db.GetMail(ctx, id); !ok {
		t.Errorf("far has no %s", id)
	}
}

// A peer's forwarded copy keeps an unsealed kind as given (src/mail.ts sendMail forwards the whole input), here and on the far
// daemon it is relayed to, and the relay carries the kind on.
func TestSendRelayedKind(t *testing.T) {
	far, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", nil)
	ctx := context.Background()
	rec := f.sendH("POST", "/api/mail", peerTok, peerLocal, `{"from":"aremote","to":["achild","boss"],"subject":"note","body":"x","forwarded":{"from_name":"remo"},"relay":true,"kind":"comment"}`)
	if rec.Code != 200 {
		t.Fatalf("a relayed comment: %d %s", rec.Code, rec.Body.String())
	}
	id := f.body(rec).Text("id")
	if got := f.count1("SELECT kind FROM mail WHERE id = '" + id + "'"); got != "comment" {
		t.Errorf("the kept copy's kind %q", got)
	}
	theirs, ok, err := far.db.GetMail(ctx, id)
	must(t, err)
	if !ok || theirs.Text("kind") != "comment" {
		t.Errorf("far's copy: %v %s", ok, jsfmt.Compact(theirs))
	}
	if !strings.Contains(ps.last(t).body, `"kind":"comment"`) {
		t.Errorf("the relay lost the kind: %s", ps.last(t).body)
	}
}

// A peer's forwarded copy of a sealed kind is stored with no kind, as the Go daemon stored it before the port (S-3928): the
// kind isn't carried here or on to far, so no reader here or there can take the sealed mail for an unsealed one. Both a
// plain copy and a relayed one.
func TestSendRelayedSealedKind(t *testing.T) {
	far, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", nil)
	ctx := context.Background()
	for _, extra := range []string{`,"relay":true`, ``} {
		to := `["achild"]`
		if extra != "" {
			to = `["achild","boss"]`
		}
		rec := f.sendH("POST", "/api/mail", peerTok, peerLocal, `{"from":"aremote","to":`+to+`,"subject":"[stam] Input for remo: typed","body":"Typed: x","forwarded":{"from_name":"remo"},"kind":"ask-note"`+extra+`}`)
		if rec.Code != 200 {
			t.Fatalf("a forwarded sealed note (%s): %d %s", extra, rec.Code, rec.Body.String())
		}
		id := f.body(rec).Text("id")
		if got := f.count1("SELECT coalesce(kind, 'none') FROM mail WHERE id = '" + id + "'"); got != "none" {
			t.Errorf("the kept copy's kind %q (%s)", got, extra)
		}
		theirs, ok, err := far.db.GetMail(ctx, id)
		must(t, err)
		if extra != "" && (!ok || theirs.Text("kind") != "") {
			t.Errorf("far's copy has kind %q", theirs.Text("kind"))
		}
		if strings.Contains(ps.last(t).body, `"kind"`) {
			t.Errorf("the sealed kind went on to far: %s", ps.last(t).body)
		}
	}
}

// A relayed send to the human is gated here, as the sender's own mail is: with the gate on and no override it answers 501
// (the gate is not ported). A peer's forwarded copy was gated where it was sent and is stored.
func TestSendRelayedGated(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "k")
	_, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", nil)
	// The relayed mail is an ITSA post by its owner (S-4163): only an owner's relayed post may reach the human.
	key := f.createItsa(`{"title":"Relayed","owner":"child","participants":["human"]}`)
	f.sql("UPDATE itsas SET owner = 'aremote', thread_id = 'th-gate' WHERE key = ?", key)
	id := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("id")
	in := `{"from":"aremote","to":["human"],"subject":"to you","body":"x","forwarded":{"from_name":"remo"},"itsa_id":"` + id + `","thread_id":"th-gate","kind":"comment"`
	if rec := f.sendH("POST", "/api/mail", peerTok, peerLocal, in+`,"relay":true}`); rec.Code != 501 || !strings.Contains(errorOf(t, rec), "mail check") {
		t.Errorf("an unchecked relayed send: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("POST", "/api/mail", peerTok, peerLocal, in+`,"relay":true,"override":"why"}`); rec.Code != 200 {
		t.Errorf("a relayed send with an override: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("POST", "/api/mail", peerTok, peerLocal, in+`}`); rec.Code != 200 {
		t.Errorf("a forwarded copy: %d %s", rec.Code, rec.Body.String())
	}
}

// A forwarded mail whose sender is an agent here (the home sending a relayed post back to its sender's machine) was
// checked where it was sent: it isn't rerouted to the sender's parent, nor refused for the sender's model (src/mail.ts).
func TestForwardedLocalSender(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	f.setProcessSettings(`{"humanMail":{"models":{"m1":false}}}`)
	f.sql("UPDATE agents SET model = 'm1' WHERE id = 'achild'")
	in := `{"from":"achild","to":["human"],"subject":"echo","body":"x","forwarded":{"from_name":"child"},"mail_id":"m00e0001","thread_id":"m00e0001"}`
	rec := f.sendH("POST", "/api/mail", peerTok, peerLocal, in)
	if rec.Code != 200 || f.body(rec).Text("rerouted") != "" {
		t.Fatalf("a forwarded mail from an agent here: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT count(*) FROM mail_recipients WHERE mail_id = 'm00e0001' AND agent_id = 'human'"); n != 1 {
		t.Errorf("the human got %d copies", n)
	}
	// The agent's own mail to the human still goes to its parent.
	if rec := f.post(agentTok, nil, `{"to":["human"],"subject":"own","body":"x","new_thread":true}`); rec.Code != 200 || f.body(rec).Text("rerouted") != "boss" {
		t.Errorf("the agent's own mail: %d %s", rec.Code, rec.Body.String())
	}
}

// Forwarded and relayed mail skip checks the sender's own daemon made, so they count only from a peer (the peer token with
// x-stam-local), whatever auth.humanStrict says: the shared token, with or without the human, a peer token without
// x-stam-local and an agent's token are refused, and nothing is stored. A forwarded mail from an agent here can't skip its
// reroute that way.
func TestForwardedOnlyFromAVerifiedPeer(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	for _, strict := range []bool{false, true} {
		f := newFixture(t, nil)
		f.setProcessSettings(`{"auth":{"humanStrict":` + map[bool]string{false: "false", true: "true"}[strict] + `}}`)
		before := f.count("SELECT count(*) FROM mail")
		for _, tc := range []struct {
			name, token string
			header      map[string]string
		}{
			{"the shared token as the human", sharedTok, human},
			{"the shared token", sharedTok, nil},
			{"a peer token without x-stam-local", peerTok, nil},
			{"an agent's token", agentTok, nil},
		} {
			for _, body := range []string{
				`{"from":"achild","to":["human"],"subject":"skip","body":"x","forwarded":{"from_name":"child"},"mail_id":"m00e0002","thread_id":"m00e0002"}`,
				`{"from":"aremote","to":["aboss"],"subject":"relay","body":"x","forwarded":{"from_name":"remo"},"relay":true}`,
				`{"from":"coder","to":["aboss"],"subject":"relay alone","body":"x","relay":true,"new_thread":true}`,
			} {
				if rec := f.sendH("POST", "/api/mail", tc.token, tc.header, body); rec.Code != 403 {
					t.Errorf("strict %v, %s: %d %s", strict, tc.name, rec.Code, rec.Body.String())
				}
			}
		}
		if n := f.count("SELECT count(*) FROM mail"); n != before {
			t.Errorf("strict %v: refused sends stored %d mails", strict, n-before)
		}
	}
}

// only_to (reachRefusal): the people the sender's daemon checked a post against. On the home a post that would reach
// someone outside it, such as a participant added after the check, is refused (409) before anything is stored or sent;
// one within it goes as before. A participant within it whose work moved to one outside it (cost_switch) forwards to one
// nobody checked, and is refused the same way. Each refusal is the ITSA's first post, so nothing stored also means the
// ITSA took no thread.
func TestItsaPostOnlyTo(t *testing.T) {
	f := newFixture(t, nil)
	post := `{"body":"x","only_to":["achild","aboss"]}`
	fresh := func() string {
		rec := f.sendH("POST", "/api/itsas", sharedTok, human, `{"title":"checked","participants":["achild","aboss"]}`)
		if rec.Code != 200 {
			t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
		}
		return f.body(rec).Text("key")
	}
	if rec := f.sendH("POST", "/api/itsas/"+fresh()+"/post", agentTok, nil, post); rec.Code != 200 {
		t.Fatalf("a post within only_to: %d %s", rec.Code, rec.Body.String())
	}
	for _, tc := range []struct{ name, seam, undo string }{
		{"a participant added after the check", "INSERT INTO itsa_participants (itsa_id, agent_id) SELECT id, 'acodex' FROM itsas WHERE key = ?", ""},
		{"a participant forwarding outside it", "UPDATE agents SET forwarded_to = 'acodex' WHERE id = 'aboss' AND ? != ''", "UPDATE agents SET forwarded_to = NULL WHERE id = 'aboss'"},
	} {
		key := fresh()
		f.sql(tc.seam, key)
		mails, unread := f.count("SELECT count(*) FROM mail"), f.count("SELECT count(*) FROM mail_recipients WHERE agent_id = 'acodex'")
		rec := f.sendH("POST", "/api/itsas/"+key+"/post", agentTok, nil, post)
		if rec.Code != 409 || !strings.Contains(errorOf(t, rec), "is new to it") {
			t.Errorf("%s: %d %s", tc.name, rec.Code, rec.Body.String())
		}
		if f.count("SELECT count(*) FROM mail") != mails || f.count("SELECT count(*) FROM mail_recipients WHERE agent_id = 'acodex'") != unread {
			t.Errorf("%s: the refused post was stored or delivered", tc.name)
		}
		if got := f.text("SELECT coalesce(thread_id, '') FROM itsas WHERE key = ?", key); got != "" {
			t.Errorf("%s: the refused post took a thread %q", tc.name, got)
		}
		if tc.undo != "" {
			f.sql(tc.undo)
		}
	}
}

// only_to holds after forwarding wherever the mail goes (S-4100 review): a peer's copy with only_to whose recipient here
// forwards outside it is refused, and the home's post carries only_to to the peers it sends on to, whose 409 stays a 409
// with nothing stored here.
func TestOnlyToAfterForwarding(t *testing.T) {
	f := newFixture(t, nil)
	in := `{"from":"aremote","to":["aboss"],"subject":"s","body":"x","forwarded":{"from_name":"remo"},"mail_id":"m00f0001","thread_id":"m00f0001","only_to":["aboss"]}`
	f.sql("UPDATE agents SET forwarded_to = 'acodex' WHERE id = 'aboss'")
	if rec := f.sendH("POST", "/api/mail", peerTok, peerLocal, in); rec.Code != 409 || !strings.Contains(errorOf(t, rec), "is new to it") {
		t.Errorf("a forwarded copy past only_to: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT count(*) FROM mail WHERE id = 'm00f0001'"); n != 0 {
		t.Errorf("a refused copy was stored")
	}
	f.sql("UPDATE agents SET forwarded_to = NULL WHERE id = 'aboss'")
	if rec := f.sendH("POST", "/api/mail", peerTok, peerLocal, in); rec.Code != 200 {
		t.Errorf("a forwarded copy within only_to: %d %s", rec.Code, rec.Body.String())
	}

	refuse := false
	far := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agents/apeer":
			writeJSON(w, 200, map[string]any{"id": "apeer", "name": "remote-one", "machine": "far", "lifecycle": "active"})
		case "/api/agents/bfar":
			writeJSON(w, 200, map[string]any{"id": "bfar", "name": "farone", "machine": "far", "lifecycle": "active"})
		case "/api/mail":
			if refuse {
				writeError(w, Errorf(http.StatusConflict, "the ITSA's people changed since the post was checked (bnext is new to it); try again"))
				return
			}
			writeJSON(w, 200, map[string]any{"id": "mfar0001"})
		default:
			writeError(w, Errorf(http.StatusNotFound, "no agent"))
		}
	}))
	g := relayFixture(t, far.ts.URL, "", nil)
	rec := g.sendH("POST", "/api/itsas", sharedTok, human, `{"title":"shared","participants":["achild","bfar"]}`)
	if rec.Code != 200 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	key := g.body(rec).Text("key")
	post := `{"by":"apeer","body":"from far","only_to":["apeer","achild","bfar"]}`
	if rec := g.sendH("POST", "/api/itsas/"+key+"/post", peerTok, peerLocal, post); rec.Code != 200 {
		t.Fatalf("a post within only_to: %d %s", rec.Code, rec.Body.String())
	}
	if posts := mailPosts(far); len(posts) != 1 || !strings.Contains(posts[0], `"only_to":["apeer","achild","bfar"]`) {
		t.Errorf("far got %q", posts)
	}
	refuse = true
	mails := g.count("SELECT count(*) FROM mail")
	rec = g.sendH("POST", "/api/itsas/"+key+"/post", peerTok, peerLocal, post)
	if rec.Code != 409 || !strings.Contains(errorOf(t, rec), "is new to it") {
		t.Errorf("a peer forwarding past only_to: %d %s", rec.Code, rec.Body.String())
	}
	if g.count("SELECT count(*) FROM mail") != mails {
		t.Errorf("a refused post was stored here")
	}
}

// The home's post for an agent on a peer (src/itsa.ts post remoteName) is relayed: sent from here as that agent, by the
// name its peer answers with, to the participants here and on the peers.
func TestItsaPostRelaysRemoteSender(t *testing.T) {
	far := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agents/apeer":
			writeJSON(w, 200, map[string]any{"id": "apeer", "name": "remote-one", "machine": "far", "lifecycle": "active"})
		case "/api/agents/bfar":
			writeJSON(w, 200, map[string]any{"id": "bfar", "name": "farone", "machine": "far", "lifecycle": "active"})
		case "/api/mail":
			writeJSON(w, 200, map[string]any{"id": "mfar0001"})
		default:
			writeError(w, Errorf(http.StatusNotFound, "no agent"))
		}
	}))
	f := relayFixture(t, far.ts.URL, "", nil)
	rec := f.sendH("POST", "/api/itsas", sharedTok, human, `{"title":"shared","participants":["achild","bfar"]}`)
	if rec.Code != 200 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	key := f.body(rec).Text("key")
	rec = f.sendH("POST", "/api/itsas/"+key+"/post", peerTok, peerLocal, `{"by":"apeer","body":"from far"}`)
	if rec.Code != 200 {
		t.Fatalf("a peer's agent's post: %d %s", rec.Code, rec.Body.String())
	}
	id := f.body(rec).Text("id")
	if got := f.text("SELECT from_id || ' ' || from_name || ' ' || kind FROM mail WHERE id = ?", id); got != "apeer remote-one comment" {
		t.Errorf("the stored post: %q", got)
	}
	if got := f.text("SELECT group_concat(agent_id) FROM mail_recipients WHERE mail_id = ?", id); got != "achild" {
		t.Errorf("recipients here: %q", got)
	}
	posts := mailPosts(far)
	if len(posts) != 1 || !strings.Contains(posts[0], `"from":"apeer"`) || !strings.Contains(posts[0], `"to":["bfar"]`) ||
		!strings.Contains(posts[0], `"forwarded":{"from_name":"remote-one"}`) || !strings.Contains(posts[0], `"mail_id":"`+id+`"`) {
		t.Errorf("far got %q", posts)
	}
	if n := f.count("SELECT count(*) FROM itsa_participants p JOIN itsas x ON x.id = p.itsa_id WHERE x.key = ? AND p.agent_id = 'apeer'", key); n != 1 {
		t.Errorf("the sender isn't a participant")
	}
}

// Off the ITSA home an answer in an ITSA's thread is posted on the home (src/itsa.ts postRouted), as the agent, which the
// home checks; the home's answer is the sender's, its refusal a 403 with its message.
func TestReplyOffHomePostsOnHome(t *testing.T) {
	h := newStubHome(t)
	f := newFixture(t, nil)
	f.setProcessSettings(offHomeSettings(h, ""))
	f.sql("INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id, itsa_id) VALUES ('m00a0001', 'aboss', 'boss', 'S-7 far work', 'x', '2026-10-25T00:00:00.000Z', 'm00a0001', 'ix7')")
	f.sql("INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('m00a0001', 'achild')")
	h.answer("POST /api/itsas/ix7/post", 200, `{"id":"m00a0002","thread_id":"m00a0001","itsa_id":"ix7"}`)
	reply := `{"to":["aboss"],"body":"answer","reply_to":"m00a0001"}`
	rec := f.post(agentTok, nil, reply)
	if rec.Code != 200 || f.body(rec).Text("id") != "m00a0002" {
		t.Fatalf("the reply: %d %s", rec.Code, rec.Body.String())
	}
	got := h.got("POST /api/itsas/ix7/post")
	if len(got) != 1 || !strings.Contains(got[0], "via=achild ") || !strings.Contains(got[0], `"by":"achild"`) || !strings.Contains(got[0], `"reply_to":"m00a0001"`) {
		t.Errorf("the home got %q", got)
	}
	h.answer("POST /api/itsas/ix7/post", 403, `{"error":"child may not post to S-7"}`)
	if rec := f.post(agentTok, nil, reply); rec.Code != 403 || errorOf(t, rec) != "child may not post to S-7" {
		t.Errorf("the home's refusal: %d %s", rec.Code, rec.Body.String())
	}
	// The home's error never carries its address.
	h.answer("POST /api/itsas/ix7/post", 500, `{"error":"broke at `+h.URL+`"}`)
	if rec := f.post(agentTok, nil, reply); rec.Code == 200 || strings.Contains(rec.Body.String(), strings.TrimPrefix(h.URL, "http://")) || !strings.Contains(rec.Body.String(), "homebox") {
		t.Errorf("the home's error: %d %s", rec.Code, rec.Body.String())
	}
	h.Close()
	if rec := f.post(agentTok, nil, reply); rec.Code != 503 || !strings.Contains(rec.Body.String(), "homebox (the ITSA home) is unreachable") {
		t.Errorf("the home down: %d %s", rec.Code, rec.Body.String())
	}
}

// An agent here whose parent limited whom it may reach (reach parent or tree) posts on an ITSA off the home only to those
// it may reach: the home can't know the limit, so the ITSA's participants are read from the home and checked here, with
// the recipients the post names in to. One outside the limit refuses the post (403) before the home hears of it; a home
// that doesn't answer is a 503. Its own ITSA, or one where only its parent takes part, goes through, and an agent with no
// limit isn't checked. TS doesn't check it at all.
func TestReachLimitedPostOffHome(t *testing.T) {
	h := newStubHome(t)
	f := newFixture(t, nil)
	f.setProcessSettings(offHomeSettings(h, ""))
	// gone is child's sibling: outside its parents, and outside its tree with siblings off.
	f.sql("INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id, itsa_id) VALUES ('m00a0001', 'aboss', 'boss', 'S-7 far work', 'x', '2026-10-25T00:00:00.000Z', 'm00a0001', 'ix7')")
	f.sql("INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('m00a0001', 'achild')")
	h.answer("POST /api/itsas/ix7/post", 200, `{"id":"m00a0002","thread_id":"m00a0001"}`)
	h.answer("POST /api/itsas/S-7/post", 200, `{"id":"m00a0003","thread_id":"m00a0001"}`)
	people := func(ids string) {
		for _, ref := range []string{"S-7", "ix7"} {
			h.answer("GET /api/itsas/"+ref, 200, `{"id":"ix7","key":"S-7","participants":[`+ids+`]}`)
		}
	}
	for _, tc := range []struct {
		name, reach, participants, to string
		code                          int
	}{
		{"its own ITSA", `"parent"`, `"achild"`, "", 200},
		{"only its parent takes part", `"parent"`, `"achild","aboss","human"`, "", 200},
		{"its tree takes part", `"tree","siblings":false`, `"achild","aboss"`, "", 200},
		{"a participant outside its parents", `"parent"`, `"achild","aboss","agone"`, "", 403},
		{"a participant outside its tree", `"tree","siblings":false`, `"achild","agone"`, "", 403},
		{"a recipient outside its tree, by name", `"tree","siblings":false`, `"achild"`, `"gone"`, 403},
		{"no limit", `"all"`, `"achild","agone"`, `"gone"`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f.sql("UPDATE agents SET visibility = ? WHERE id = 'achild'", `{"reach":`+tc.reach+`}`)
			people(tc.participants)
			to := ""
			if tc.to != "" {
				to = `,"to":[` + tc.to + `]`
			}
			posts, replies := len(h.got("POST /api/itsas/S-7/post")), len(h.got("POST /api/itsas/ix7/post"))
			rec := f.sendH("POST", "/api/itsas/S-7/post", agentTok, nil, `{"body":"hi"`+to+`}`)
			if rec.Code != tc.code {
				t.Errorf("a post: %d %s", rec.Code, rec.Body.String())
			}
			replyTo := `"aboss"`
			if tc.to != "" {
				replyTo += "," + tc.to
			}
			rec2 := f.post(agentTok, nil, `{"to":[`+replyTo+`],"body":"answer","reply_to":"m00a0001"}`)
			if rec2.Code != tc.code {
				t.Errorf("an answer in the thread: %d %s", rec2.Code, rec2.Body.String())
			}
			sent := 0
			if tc.code == 200 {
				sent = 1
			} else if !strings.Contains(errorOf(t, rec), "its parent limited it to") || !strings.Contains(errorOf(t, rec2), "would reach gone") {
				t.Errorf("the refusals: %s / %s", rec.Body.String(), rec2.Body.String())
			}
			if got := h.got("POST /api/itsas/ix7/post"); tc.reach == `"all"` && strings.Contains(got[len(got)-1], `"only_to"`) {
				t.Errorf("a post with no limit carries only_to: %s", got[len(got)-1])
			}
			if len(h.got("POST /api/itsas/S-7/post")) != posts+sent || len(h.got("POST /api/itsas/ix7/post")) != replies+sent {
				t.Errorf("the home heard %d posts and %d answers", len(h.got("POST /api/itsas/S-7/post"))-posts, len(h.got("POST /api/itsas/ix7/post"))-replies)
			}
		})
	}
	// The post carries the people it was checked against; a home that finds them changed (409) is a refusal here.
	f.sql("UPDATE agents SET visibility = '{\"reach\":\"parent\"}' WHERE id = 'achild'")
	people(`"achild","aboss"`)
	if rec := f.sendH("POST", "/api/itsas/S-7/post", agentTok, nil, `{"body":"hi"}`); rec.Code != 200 {
		t.Fatalf("a checked post: %d %s", rec.Code, rec.Body.String())
	}
	if got := h.got("POST /api/itsas/S-7/post"); !strings.Contains(got[len(got)-1], `"only_to":["achild","achild","aboss"]`) {
		t.Errorf("the checked post: %s", got[len(got)-1])
	}
	if rec := f.post(agentTok, nil, `{"to":["aboss"],"body":"answer","reply_to":"m00a0001"}`); rec.Code != 200 {
		t.Fatalf("a checked answer: %d %s", rec.Code, rec.Body.String())
	}
	if got := h.got("POST /api/itsas/ix7/post"); !strings.Contains(got[len(got)-1], `"only_to":["achild","achild","aboss","aboss"]`) {
		t.Errorf("the checked answer: %s", got[len(got)-1])
	}
	for _, ref := range []string{"S-7", "ix7"} {
		h.answer("POST /api/itsas/"+ref+"/post", 409, `{"error":"the ITSA's people changed since the post was checked (gone is new to it); try again"}`)
	}
	if rec := f.sendH("POST", "/api/itsas/S-7/post", agentTok, nil, `{"body":"hi"}`); rec.Code != 403 || !strings.Contains(rec.Body.String(), "changed since") {
		t.Errorf("the home's 409 on a post: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post(agentTok, nil, `{"to":["aboss"],"body":"answer","reply_to":"m00a0001"}`); rec.Code != 403 || !strings.Contains(rec.Body.String(), "changed since") {
		t.Errorf("the home's 409 on an answer: %d %s", rec.Code, rec.Body.String())
	}
	// The participants are read as the agent.
	if got := h.got("GET /api/itsas/S-7"); len(got) == 0 || !strings.Contains(got[0], "via=achild ") {
		t.Errorf("the participants' read: %q", got)
	}
	// A home that fails the participants' read: the limited agent's post isn't sent unchecked.
	f.sql("UPDATE agents SET visibility = '{\"reach\":\"parent\"}' WHERE id = 'achild'")
	for _, ref := range []string{"S-7", "ix7"} {
		h.answer("GET /api/itsas/"+ref, 500, `{"error":"busy"}`)
	}
	posts, replies := len(h.got("POST /api/itsas/S-7/post")), len(h.got("POST /api/itsas/ix7/post"))
	if rec := f.sendH("POST", "/api/itsas/S-7/post", agentTok, nil, `{"body":"hi"}`); rec.Code != 503 {
		t.Errorf("the participants unread, a post: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post(agentTok, nil, `{"to":["aboss"],"body":"answer","reply_to":"m00a0001"}`); rec.Code != 503 {
		t.Errorf("the participants unread, an answer: %d %s", rec.Code, rec.Body.String())
	}
	if len(h.got("POST /api/itsas/S-7/post")) != posts || len(h.got("POST /api/itsas/ix7/post")) != replies {
		t.Errorf("an unchecked post reached the home")
	}
	// A home that doesn't answer at all.
	h.Close()
	if rec := f.sendH("POST", "/api/itsas/S-7/post", agentTok, nil, `{"body":"hi"}`); rec.Code != 503 || strings.Contains(rec.Body.String(), "127.0.0.1") {
		t.Errorf("the home down, a post: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post(agentTok, nil, `{"to":["aboss"],"body":"answer","reply_to":"m00a0001"}`); rec.Code != 503 {
		t.Errorf("the home down, an answer: %d %s", rec.Code, rec.Body.String())
	}
}

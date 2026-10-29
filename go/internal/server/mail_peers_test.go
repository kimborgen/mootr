package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

// Mail to an agent on another machine (mail_peers.go, send.go): here has only achild, far (a Go daemon) has boss. The mail
// is stored on far under the id and thread given here, and here keeps the sender's copy, which records whom it went to.
func TestMailToAPeersAgent(t *testing.T) {
	far, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", nil)
	ctx := context.Background()

	rec := f.sendH("POST", "/api/mail", agentTok, nil, `{"to":["boss"],"subject":"hello far","body":"from here"}`)
	if rec.Code != 200 {
		t.Fatalf("mail to far's boss: %d %s", rec.Code, rec.Body.String())
	}
	sent := f.body(rec)
	id := sent.Text("id")
	got := ps.last(t)
	if got.path != "/api/mail" || got.header.Get("x-stam-local") != "1" || got.header.Get("x-stam-human") != "" || !strings.Contains(got.body, `"forwarded":{"from_name":"child"}`) {
		t.Errorf("what far got: %s %v", got.body, got.header)
	}
	theirs, ok, err := far.db.GetMail(ctx, id)
	must(t, err)
	if !ok || theirs.Text("from_id") != "achild" || theirs.Text("thread_id") != sent.Text("thread_id") || theirs.Text("from_name") != "child" {
		t.Fatalf("far's copy: %v %s", ok, jsfmt.Compact(theirs))
	}
	if n := far.count("SELECT count(*) FROM mail_recipients WHERE mail_id = ? AND agent_id = 'aboss'", id); n != 1 {
		t.Errorf("far's boss got %d copies", n)
	}
	// The sender's copy here: no recipients, and copy_to names boss.
	if n := f.count("SELECT count(*) FROM mail_recipients WHERE mail_id = ?", id); n != 0 {
		t.Errorf("the copy here has %d recipients", n)
	}
	if c := f.count1("SELECT copy_to FROM mail WHERE id = '" + id + "'"); c != `["aboss"]` {
		t.Errorf("copy_to %s", c)
	}

	// The human's reply to far's mail, which only far keeps, threads under it.
	far.sql("PRAGMA foreign_keys = OFF")
	far.sql("INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id) VALUES ('mfa00001', 'aboss', 'boss', 'far only', 'x', '2026-10-25T00:00:00.000Z', 'mfa00001')")
	rec = f.sendH("POST", "/api/mail", sharedTok, human, `{"from":"human","to":["boss"],"reply_to":"mfa00001","body":"answer"}`)
	if rec.Code != 200 || f.body(rec).Text("thread_id") != "mfa00001" || f.body(rec).Text("subject") != "Re: far only" {
		t.Errorf("a reply to far's mail: %d %s", rec.Code, rec.Body.String())
	}
}

// A peer's refusal is the sender's 400, naming the peer, and leaves no copy here. A peer that doesn't answer is a 503, not a
// silent drop, and nothing is stored.
func TestMailToAPeerRefused(t *testing.T) {
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST":
			writeError(w, Errorf(http.StatusForbidden, "child may not mail boss"))
		case r.URL.Path == "/api/agents/boss":
			writeJSON(w, 200, map[string]any{"id": "aboss", "name": "boss", "machine": "far", "lifecycle": "active"})
		default:
			writeJSON(w, 404, map[string]any{"error": "no agent"})
		}
	}))
	f := relayFixture(t, stub.ts.URL, "", nil)
	before := f.count("SELECT count(*) FROM mail")
	rec := f.sendH("POST", "/api/mail", agentTok, nil, `{"to":["boss"],"subject":"s","body":"b"}`)
	if rec.Code != 400 || errorOf(t, rec) != "far: child may not mail boss" {
		t.Errorf("far's refusal: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT count(*) FROM mail"); n != before {
		t.Errorf("a refused send left %d mails", n-before)
	}
	// boss is now remembered as far's; with far gone the mail waits in the outbox (S-235), and the sender's copy here
	// records whom it is for.
	stub.ts.Close()
	rec = f.sendH("POST", "/api/mail", agentTok, nil, `{"to":["aboss"],"subject":"s","body":"b"}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"queued":true`) || f.count("SELECT count(*) FROM peer_outbox WHERE peer = 'far'") != 1 {
		t.Errorf("far down: %d %s", rec.Code, rec.Body.String())
	}
	if id := f.body(rec).Text("id"); f.count1("SELECT copy_to FROM mail WHERE id = '"+id+"'") != `["aboss"]` {
		t.Errorf("the copy of the queued mail: %s", f.count1("SELECT copy_to FROM mail WHERE id = '"+id+"'"))
	}
}

// Forwarded mail is a peer's: under auth.humanStrict the shared token can't forge it, as the human or an agent.
func TestForwardedMailOnlyFromAPeer(t *testing.T) {
	_, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, `"auth":{"humanStrict":true}`, nil)
	for i, from := range []string{"human", "aboss"} {
		body := `{"from":"` + from + `","to":["achild"],"subject":"s","body":"b","forwarded":{"from_name":"x"},"mail_id":"m0000aa1","thread_id":"m0000aa1"}`
		if rec := f.sendH("POST", "/api/mail", sharedTok, nil, body); rec.Code != 403 {
			t.Errorf("the shared token forwarding as %s: %d %s", from, rec.Code, rec.Body.String())
		}
		rec := f.sendH("POST", "/api/mail", peerTok, map[string]string{"x-stam-local": "1"}, strings.Replace(body, "m0000aa1", "m0000ab"+strconv.Itoa(i), 2))
		if rec.Code != 200 {
			t.Errorf("a peer forwarding as %s: %d %s", from, rec.Code, rec.Body.String())
		}
	}
}

// The human's inbox joins the peers' (the human's mail lives where it was sent), newest first; a peer's own request reads
// this daemon's box only.
func TestHumanInboxMergesPeers(t *testing.T) {
	far, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", nil)
	far.sql("PRAGMA foreign_keys = OFF")
	far.sql("INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id) VALUES ('mfa00002', 'aboss', 'boss', 'from far', 'x', '2099-01-01T00:00:00.000Z', 'mfa00002')")
	far.sql("INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('mfa00002', 'human')")
	has := func(rec *httptest.ResponseRecorder) bool {
		t.Helper()
		if rec.Code != 200 {
			t.Fatalf("inbox: %d %s", rec.Code, rec.Body.String())
		}
		return strings.Contains(rec.Body.String(), `"id":"mfa00002"`)
	}
	rec := f.do(call{path: "/api/agents/human/inbox?unread=1&limit=100", token: sharedTok, header: human})
	if !has(rec) || !strings.HasPrefix(rec.Body.String(), `[{"id":"mfa00002"`) {
		t.Errorf("the human's inbox here doesn't start with far's newest mail: %s", rec.Body.String())
	}
	if has(f.do(call{path: "/api/agents/human/inbox?unread=1&limit=100", token: peerTok, header: map[string]string{"x-stam-local": "1"}})) {
		t.Error("a peer's read of the human's box got far's mail back")
	}
}

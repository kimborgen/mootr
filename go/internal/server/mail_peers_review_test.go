package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/config"
	"stam/internal/db"
)

// The #1279 review's cases (S-4100): reach on a remote `all`, a mail forwarded again, forwarded ids that aren't ids,
// `all` with a peer down, and a send that some peers take and one refuses.

// okPeer is a peer that takes every mail.
func okPeer(t *testing.T) *peerServer {
	return newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"id": "ok"})
	}))
}

// mailPosts is the bodies of the mail a peer server was sent.
func mailPosts(p *peerServer) []string {
	var out []string
	for _, r := range p.seen() {
		if r.method == "POST" && r.path == "/api/mail" {
			out = append(out, r.body)
		}
	}
	return out
}

// reopened is the fixture's daemon started again over the same files: the state that must survive a restart is what it
// reads.
func reopened(t *testing.T, f *fixture) *fixture {
	t.Helper()
	d, err := db.Open(context.Background(), f.cfg.DBPath(), db.Options{})
	must(t, err)
	t.Cleanup(func() { d.Close() })
	srv := New(f.cfg, config.NewSettingsFile(f.home, f.cfg.Machine), d, f.hub, nil)
	return &fixture{t: t, home: f.home, cfg: f.cfg, db: d, hub: f.hub, srv: srv}
}

// A sender whose reach is its parent mails `all`: a peer can't check that reach (the sender isn't an agent there), so
// the origin sends the peer only the agents it may reach, its parent there, by id. The human's `all` is still `all`.
func TestLimitedAllReachesOnlyItsPeerAgents(t *testing.T) {
	stub := okPeer(t)
	f := relayFixture(t, stub.ts.URL, "", nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('afarboss', 'farboss', 'far', '2026-01-01'), ('aother', 'other', 'far', '2026-01-01')")
	f.sql(`UPDATE agents SET parent_id = 'afarboss', visibility = '{"reach":"parent"}' WHERE id = 'achild'`)
	rec := f.sendH("POST", "/api/mail", agentTok, nil, `{"to":["all"],"subject":"to all","body":"b"}`)
	if rec.Code != 200 {
		t.Fatalf("a limited all: %d %s", rec.Code, rec.Body.String())
	}
	posts := mailPosts(stub)
	if len(posts) != 1 || !strings.Contains(posts[0], `"to":["afarboss"]`) || strings.Contains(posts[0], "aother") || strings.Contains(posts[0], `"all"`) {
		t.Errorf("far got %q", posts)
	}
	rec = f.sendH("POST", "/api/mail", sharedTok, human, `{"from":"human","to":["all"],"subject":"from you","body":"b"}`)
	if posts = mailPosts(stub); rec.Code != 200 || len(posts) != 2 || !strings.Contains(posts[1], `"to":["all"]`) {
		t.Errorf("the human's all: %d %q", rec.Code, posts)
	}
}

// The same forwarded mail arriving again (an outbox retry, or more recipients under its id) only adds the recipients it
// lacks, and only they hear of it; a daemon started again over the file does the same. An id that is another sender's
// mail here is refused.
func TestForwardedMailAgain(t *testing.T) {
	f := relayFixture(t, okPeer(t).ts.URL, "", nil)
	fwd := func(f *fixture, from, to string) *httptest.ResponseRecorder {
		return f.sendH("POST", "/api/mail", peerTok, map[string]string{"x-stam-local": "1"},
			`{"from":"`+from+`","to":`+to+`,"subject":"again","body":"b","forwarded":{"from_name":"remote"},"mail_id":"m00c0001","thread_id":"m00c0001"}`)
	}
	received := func(f *fixture) int {
		return f.count("SELECT count(*) FROM events WHERE agent_id = 'achild' AND type = 'mail:received' AND data LIKE '%m00c0001%'")
	}
	for i := 0; i < 2; i++ {
		if rec := fwd(f, "aremote", `["achild"]`); rec.Code != 200 {
			t.Fatalf("arrival %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if n := f.count("SELECT count(*) FROM mail_recipients WHERE mail_id = 'm00c0001'"); n != 1 || received(f) != 1 {
		t.Errorf("after two arrivals: %d recipients, child heard %d times", n, received(f))
	}
	g := reopened(t, f)
	if rec := fwd(g, "aremote", `["achild","human"]`); rec.Code != 200 {
		t.Fatalf("a new recipient after a restart: %d %s", rec.Code, rec.Body.String())
	}
	if n := g.count("SELECT count(*) FROM mail_recipients WHERE mail_id = 'm00c0001'"); n != 2 || received(g) != 1 {
		t.Errorf("after the restart: %d recipients, child heard %d times", n, received(g))
	}
	if rec := fwd(g, "asomeoneelse", `["achild"]`); rec.Code != 409 {
		t.Errorf("another sender's mail under the id: %d %s", rec.Code, rec.Body.String())
	}
}

// A forwarded mail_id names the mail's attachments folder, so one that isn't a mail id is refused before anything is
// written: no mail, and no file inside or outside the home. A thread_id that isn't one is refused too.
func TestForwardedIDsAreIDs(t *testing.T) {
	f := relayFixture(t, okPeer(t).ts.URL, "", nil)
	before := f.count("SELECT count(*) FROM mail")
	escaped := filepath.Join(filepath.Dir(f.home), "escape")
	for _, ids := range []string{`"mail_id":"../../escape"`, `"mail_id":"m00/../../../escape"`, `"mail_id":"m00c0002","thread_id":"../escape"`, `"mail_id":"M00"`} {
		rec := f.sendH("POST", "/api/mail", peerTok, map[string]string{"x-stam-local": "1"},
			`{"from":"aremote","to":["achild"],"subject":"s","body":"b","forwarded":{"from_name":"remote"},"attachments":[{"name":"a.txt","content":"x"}],`+ids+`}`)
		if rec.Code != 400 {
			t.Errorf("%s: %d %s", ids, rec.Code, rec.Body.String())
		}
	}
	if n := f.count("SELECT count(*) FROM mail"); n != before {
		t.Errorf("%d mails stored", n-before)
	}
	if _, err := os.Stat(escaped); !os.IsNotExist(err) {
		t.Errorf("a file outside the attachments: %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(f.home, "attachments")); len(entries) != 0 {
		t.Errorf("attachments written: %v", entries)
	}
}

// A broadcast skips a peer that doesn't answer, as before the peers got mail: the agents here get it, and the sender
// gets no error that a retry would turn into a second copy.
func TestAllWithAPeerDown(t *testing.T) {
	stub := okPeer(t)
	f := relayFixture(t, stub.ts.URL, "", nil)
	stub.ts.Close()
	rec := f.sendH("POST", "/api/mail", sharedTok, human, `{"from":"human","to":["all"],"subject":"far is down","body":"b"}`)
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "not_delivered") {
		t.Fatalf("all with far down: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT count(*) FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE m.subject = 'far is down' AND r.agent_id = 'achild'"); n != 1 {
		t.Errorf("child got %d copies", n)
	}
}

// A send that one peer takes and another refuses: the first refusal, with nothing delivered yet, is a clean failure
// that stores nothing. Once a peer has taken it, a later refusal makes the send a success that names where it wasn't
// delivered; the copy here records only the delivered recipients, and a client_id retry gets the same answer without
// sending again.
func TestPartialSendToPeers(t *testing.T) {
	far := okPeer(t)
	near := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, Errorf(http.StatusForbidden, "child may not mail bnear"))
	}))
	f := relayFixture(t, far.ts.URL, "", nil)
	peer := func(name, url string) string {
		return `{"name":"` + name + `","url":"` + url + `","token":"` + sharedTok + `","peerToken":"` + peerTok + `"}`
	}
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"peers":[`+peer("far", far.ts.URL)+`,`+peer("near", near.ts.URL)+`]}`), 0o600))
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('bfar', 'bfar', 'far', '2026-01-01'), ('bnear', 'bnear', 'near', '2026-01-01')")
	before := f.count("SELECT count(*) FROM mail")

	rec := f.sendH("POST", "/api/mail", sharedTok, human, `{"from":"human","to":["bnear","achild"],"subject":"refused first","body":"b","attachments":[{"name":"a.txt","content":"x"}]}`)
	if rec.Code != 400 || f.count("SELECT count(*) FROM mail") != before {
		t.Errorf("a refusal with nothing delivered: %d %s, %d mails stored", rec.Code, rec.Body.String(), f.count("SELECT count(*) FROM mail")-before)
	}
	if entries, _ := os.ReadDir(filepath.Join(f.home, "attachments")); len(entries) != 0 {
		t.Errorf("the refused mail's files are left: %v", entries)
	}

	body := `{"from":"human","to":["achild","bfar","bnear"],"subject":"partly","body":"b","client_id":"c-partial"}`
	rec = f.sendH("POST", "/api/mail", sharedTok, human, body)
	if rec.Code != 200 {
		t.Fatalf("a partial send: %d %s", rec.Code, rec.Body.String())
	}
	got := f.body(rec)
	miss, _ := got.Get("not_delivered")
	if len(miss.Items) != 1 || miss.Items[0].Text("peer") != "near" || !strings.Contains(miss.Items[0].Text("error"), "child may not mail bnear") {
		t.Errorf("not_delivered: %s", rec.Body.String())
	}
	id := got.Text("id")
	if f.count("SELECT count(*) FROM mail_recipients WHERE mail_id = ? AND agent_id = 'achild'", id) != 1 || f.count1("SELECT copy_to FROM mail WHERE id = '"+id+"'") != `["bfar"]` {
		t.Errorf("the stored mail: child %d, copy_to %s", f.count("SELECT count(*) FROM mail_recipients WHERE mail_id = ? AND agent_id = 'achild'", id), f.count1("SELECT copy_to FROM mail WHERE id = '"+id+"'"))
	}
	again := f.sendH("POST", "/api/mail", sharedTok, human, body)
	if again.Code != 200 || again.Body.String() != rec.Body.String() || len(mailPosts(far)) != 1 || f.count("SELECT count(*) FROM mail WHERE subject = 'partly'") != 1 {
		t.Errorf("the retry: %d %s; far got %d posts", again.Code, again.Body.String(), len(mailPosts(far)))
	}
}

// A limited sender's `all` is still a broadcast once it is expanded to the peer agents it may reach: a peer that is down
// is skipped, not a 503 (review round 2).
func TestLimitedAllWithAPeerDown(t *testing.T) {
	stub := okPeer(t)
	f := relayFixture(t, stub.ts.URL, "", nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('afarboss', 'farboss', 'far', '2026-01-01')")
	f.sql(`UPDATE agents SET parent_id = 'afarboss', visibility = '{"reach":"parent"}' WHERE id = 'achild'`)
	stub.ts.Close()
	rec := f.sendH("POST", "/api/mail", agentTok, nil, `{"to":["all"],"subject":"to all","body":"b"}`)
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "not_delivered") || f.body(rec).Text("id") == "" {
		t.Errorf("a limited all with far down: %d %s", rec.Code, rec.Body.String())
	}
}

// The files of a mail are written before any peer is called: when the write fails (here the attachments folder is a
// file), no peer got the mail, and a client_id retry doesn't send it either (review round 2).
func TestLocalWriteFailsBeforePeers(t *testing.T) {
	far := okPeer(t)
	f := relayFixture(t, far.ts.URL, "", nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('bfar', 'bfar', 'far', '2026-01-01')")
	must(t, os.WriteFile(filepath.Join(f.home, "attachments"), []byte("not a folder"), 0o600))
	body := `{"from":"human","to":["achild","bfar"],"subject":"with a file","body":"b","attachments":[{"name":"a.txt","content":"x"}],"client_id":"c-files"}`
	for i := 0; i < 2; i++ {
		if rec := f.sendH("POST", "/api/mail", sharedTok, human, body); rec.Code < 500 {
			t.Errorf("try %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if n := len(mailPosts(far)); n != 0 || f.count("SELECT count(*) FROM mail WHERE subject = 'with a file'") != 0 {
		t.Errorf("far got %d posts", n)
	}
}

// When the store here fails after a peer took the mail, the send answers what was delivered and that the recipients here
// didn't get it, and a client_id retry gets that answer without sending again (review round 2).
func TestStoreFailsAfterDelivery(t *testing.T) {
	far := okPeer(t)
	f := relayFixture(t, far.ts.URL, "", nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('bfar', 'bfar', 'far', '2026-01-01')")
	f.sql("CREATE TRIGGER boom BEFORE INSERT ON mail WHEN NEW.subject = 'boom' BEGIN SELECT RAISE(ABORT, 'disk full'); END")
	body := `{"from":"human","to":["achild","bfar"],"subject":"boom","body":"b","client_id":"c-boom"}`
	rec := f.sendH("POST", "/api/mail", sharedTok, human, body)
	if rec.Code != 200 {
		t.Fatalf("the send: %d %s", rec.Code, rec.Body.String())
	}
	miss, _ := f.body(rec).Get("not_delivered")
	if len(miss.Items) != 1 || miss.Items[0].Text("peer") != "here" || !strings.Contains(rec.Body.String(), `"to":["achild"]`) || !strings.Contains(miss.Items[0].Text("error"), "disk full") {
		t.Errorf("not_delivered: %s", rec.Body.String())
	}
	again := f.sendH("POST", "/api/mail", sharedTok, human, body)
	if again.Code != 200 || again.Body.String() != rec.Body.String() || len(mailPosts(far)) != 1 {
		t.Errorf("the retry: %d %s; far got %d posts", again.Code, again.Body.String(), len(mailPosts(far)))
	}
	// A mail only to the peer: the sender's copy can't be stored, and the send still answers what far took, once, with
	// not_delivered naming the sender's copy here.
	only := `{"from":"human","to":["bfar"],"subject":"boom","body":"b","client_id":"c-boom-peer"}`
	rec = f.sendH("POST", "/api/mail", sharedTok, human, only)
	again = f.sendH("POST", "/api/mail", sharedTok, human, only)
	if rec.Code != 200 || again.Code != 200 || again.Body.String() != rec.Body.String() || len(mailPosts(far)) != 2 {
		t.Errorf("peer only: %d %s, then %d %s; far got %d posts", rec.Code, rec.Body.String(), again.Code, again.Body.String(), len(mailPosts(far)))
	}
	miss, _ = f.body(rec).Get("not_delivered")
	if len(miss.Items) != 1 || miss.Items[0].Text("peer") != "here" || !strings.Contains(miss.Items[0].Text("error"), "disk full") {
		t.Fatalf("peer only, not_delivered: %s", rec.Body.String())
	}
	if to, _ := miss.Items[0].Get("to"); len(to.Items) != 1 || to.Items[0].Str != "human" {
		t.Errorf("peer only, not_delivered names %s", rec.Body.String())
	}
}

// A mail's files go in a folder the send makes for it: a folder already there under the id is never written into or
// removed (a forwarded mail keeps its id, so it is refused), and another mail's folder survives a refused send.
func TestMailFolderIsTheSendsOwn(t *testing.T) {
	near := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, Errorf(http.StatusForbidden, "no"))
	}))
	f := relayFixture(t, near.ts.URL, "", nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('bfar', 'bfar', 'far', '2026-01-01')")
	other := filepath.Join(f.home, "attachments", "m00d0001")
	must(t, os.MkdirAll(other, 0o755))
	must(t, os.WriteFile(filepath.Join(other, "kept.txt"), []byte("an older mail's"), 0o600))
	rec := f.sendH("POST", "/api/mail", peerTok, map[string]string{"x-stam-local": "1"},
		`{"from":"aremote","to":["achild"],"subject":"s","body":"b","forwarded":{"from_name":"remote"},"mail_id":"m00d0001","thread_id":"m00d0001","attachments":[{"name":"a.txt","content":"x"}]}`)
	if rec.Code != 409 {
		t.Errorf("a forwarded mail onto a folder already there: %d %s", rec.Code, rec.Body.String())
	}
	rec = f.sendH("POST", "/api/mail", sharedTok, human, `{"from":"human","to":["bfar"],"subject":"refused","body":"b","attachments":[{"name":"a.txt","content":"x"}]}`)
	if rec.Code != 400 {
		t.Errorf("the refused send: %d %s", rec.Code, rec.Body.String())
	}
	entries, _ := os.ReadDir(filepath.Join(f.home, "attachments"))
	if b, err := os.ReadFile(filepath.Join(other, "kept.txt")); err != nil || string(b) != "an older mail's" || len(entries) != 1 {
		t.Errorf("the older folder: %q %v; attachments holds %d", b, err, len(entries))
	}
}

// A file write that fails partway (a good attachment, then a path that isn't there) leaves no folder and reaches no peer.
func TestPartialFileWriteLeavesNothing(t *testing.T) {
	far := okPeer(t)
	f := relayFixture(t, far.ts.URL, "", nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('bfar', 'bfar', 'far', '2026-01-01')")
	missing := filepath.Join(f.home, "not-there.txt")
	rec := f.sendH("POST", "/api/mail", sharedTok, human, `{"from":"human","to":["achild","bfar"],"subject":"half","body":"b","attachments":[{"name":"a.txt","content":"x"},{"path":"`+missing+`"}]}`)
	if rec.Code < 400 {
		t.Errorf("the send: %d %s", rec.Code, rec.Body.String())
	}
	if entries, _ := os.ReadDir(filepath.Join(f.home, "attachments")); len(entries) != 0 || len(mailPosts(far)) != 0 {
		t.Errorf("left %v, far got %d posts", entries, len(mailPosts(far)))
	}
}

// A local id whose folder is there draws another, before any peer is called, and the stored mail's files stay after the
// send; an id that keeps colliding is refused (409) once the draws run out, with the older folder untouched.
func TestMailFolderRedraws(t *testing.T) {
	far := okPeer(t)
	f := relayFixture(t, far.ts.URL, "", nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('bfar', 'bfar', 'far', '2026-01-01')")
	other := filepath.Join(f.home, "attachments", "m00d0001")
	must(t, os.MkdirAll(other, 0o755))
	must(t, os.WriteFile(filepath.Join(other, "kept.txt"), []byte("an older mail's"), 0o600))
	ids := []string{"m00d0001", "m00d0002"}
	f.srv.mailIDHook = func() string {
		id := ids[0]
		if len(ids) > 1 {
			ids = ids[1:]
		}
		return id
	}
	rec := f.sendH("POST", "/api/mail", sharedTok, human, `{"from":"human","to":["achild","bfar"],"subject":"s","body":"b","attachments":[{"name":"a.txt","content":"x"}]}`)
	if rec.Code != 200 || f.body(rec).Text("id") != "m00d0002" || !strings.Contains(strings.Join(mailPosts(far), "\n"), `"mail_id":"m00d0002"`) {
		t.Fatalf("the redrawn send: %d %s", rec.Code, rec.Body.String())
	}
	if b, err := os.ReadFile(filepath.Join(f.home, "attachments", "m00d0002", "a.txt")); err != nil || string(b) != "x" {
		t.Errorf("the stored mail's file: %q %v", b, err)
	}

	ids = []string{"m00d0001"}
	rec = f.sendH("POST", "/api/mail", sharedTok, human, `{"from":"human","to":["achild","bfar"],"subject":"t","body":"b","attachments":[{"name":"a.txt","content":"x"}]}`)
	if rec.Code != 409 || len(mailPosts(far)) != 1 {
		t.Errorf("out of draws: %d %s; far got %d posts", rec.Code, rec.Body.String(), len(mailPosts(far)))
	}
	if b, err := os.ReadFile(filepath.Join(other, "kept.txt")); err != nil || string(b) != "an older mail's" {
		t.Errorf("the older folder: %q %v", b, err)
	}
}

// A forwarded mail that arrives again with its files keeps the first arrival's: nothing is written or removed.
func TestForwardedMailAgainKeepsItsFiles(t *testing.T) {
	f := relayFixture(t, okPeer(t).ts.URL, "", nil)
	fwd := func(to, content string) {
		t.Helper()
		rec := f.sendH("POST", "/api/mail", peerTok, map[string]string{"x-stam-local": "1"},
			`{"from":"aremote","to":`+to+`,"subject":"again","body":"b","forwarded":{"from_name":"remote"},"mail_id":"m00c0003","thread_id":"m00c0003","attachments":[{"name":"a.txt","content":"`+content+`"}]}`)
		if rec.Code != 200 {
			t.Fatalf("arrival to %s: %d %s", to, rec.Code, rec.Body.String())
		}
	}
	fwd(`["achild"]`, "x")
	fwd(`["achild","human"]`, "y")
	if b, err := os.ReadFile(filepath.Join(f.home, "attachments", "m00c0003", "a.txt")); err != nil || string(b) != "x" {
		t.Errorf("the file after a second arrival: %q %v", b, err)
	}
	if n := f.count("SELECT count(*) FROM mail_recipients WHERE mail_id = 'm00c0003'"); n != 2 {
		t.Errorf("%d recipients", n)
	}
}

// Two arrivals of one forwarded mail at once (the broadcast part and the queued named part of one send, S-4100 review):
// the second waits for the first from the check whether the mail is here to its store, then finds it and merges its
// recipient. Without that, both see no mail, the first claims the files' folder, and the second is a 409 that the
// sending outbox takes as a refusal and drops.
func TestForwardedArrivalsAtOnce(t *testing.T) {
	f := relayFixture(t, okPeer(t).ts.URL, "", nil)
	held, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	f.srv.forwardStoreHook = func(string) { once.Do(func() { close(held); <-release }) }
	fwd := func(to string) *httptest.ResponseRecorder {
		return f.sendH("POST", "/api/mail", peerTok, map[string]string{"x-stam-local": "1"},
			`{"from":"aremote","to":`+to+`,"subject":"split","body":"b","forwarded":{"from_name":"remote"},"mail_id":"m00e0001","thread_id":"m00e0001","attachments":[{"name":"a.txt","content":"x"}]}`)
	}
	var first, second *httptest.ResponseRecorder
	firstDone, secondDone := make(chan struct{}), make(chan struct{})
	go func() { first = fwd(`["achild"]`); close(firstDone) }()
	select {
	case <-held:
	case <-time.After(5 * time.Second):
		t.Fatal("the first arrival never reached its store")
	}
	go func() { second = fwd(`["human"]`); close(secondDone) }()
	// The second arrival either waits on the id's lock, or (without it) runs to its end.
wait:
	for deadline := time.Now().Add(5 * time.Second); f.srv.forwardedIDs.holders("m00e0001") < 2; {
		select {
		case <-secondDone:
			break wait
		case <-time.After(time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Fatal("the second arrival neither waited nor ended")
		}
	}
	close(release)
	<-firstDone
	<-secondDone
	if first.Code != 200 || second.Code != 200 {
		t.Errorf("first %d %s; second %d %s", first.Code, first.Body.String(), second.Code, second.Body.String())
	}
	if n := f.count("SELECT count(*) FROM mail_recipients WHERE mail_id = 'm00e0001'"); n != 2 {
		t.Errorf("%d recipients", n)
	}
	if n := f.count("SELECT count(*) FROM events WHERE agent_id = 'achild' AND type = 'mail:received' AND data LIKE '%m00e0001%'"); n != 1 {
		t.Errorf("the child heard %d times", n)
	}
	if b, err := os.ReadFile(filepath.Join(f.home, "attachments", "m00e0001", "a.txt")); err != nil || string(b) != "x" {
		t.Errorf("the file: %q %v", b, err)
	}
	if n := f.srv.forwardedIDs.holders("m00e0001"); n != 0 {
		t.Errorf("%d still hold the id", n)
	}
}

package server

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/config"
	"stam/internal/jsfmt"
)

// outboxPeer stands in for far: down drops every connection, as a stopped machine does; busy answers the mail
// "flaky" with a 503; the mail "bad" is refused (400). It records the subjects it took, in order. hold, when set,
// blocks each mail until a value arrives on it.
type outboxPeer struct {
	*peerServer
	down, busy atomic.Bool
	// odd, when set, is the status the mail "odd" gets (a 204, a 3xx): neither a delivery nor a refusal.
	odd  atomic.Int32
	hold chan struct{}
	mu   sync.Mutex
	took []string
}

func newOutboxPeer(t *testing.T) *outboxPeer {
	o := &outboxPeer{}
	o.peerServer = newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o.down.Load() {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close()
			}
			return
		}
		if r.URL.Path == "/api/agents/boss" || r.URL.Path == "/api/agents/aboss" {
			writeJSON(w, 200, map[string]any{"id": "aboss", "name": "boss", "machine": "far", "lifecycle": "active"})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/agents/") {
			writeError(w, Errorf(http.StatusNotFound, "no agent"))
			return
		}
		if r.Method != "POST" || r.URL.Path != "/api/mail" {
			writeJSON(w, 200, map[string]any{})
			return
		}
		if o.hold != nil {
			<-o.hold
		}
		b, _ := io.ReadAll(r.Body)
		v, _ := jsfmt.Parse(b)
		subject := v.Text("subject")
		switch {
		case subject == "bad":
			writeError(w, Errorf(http.StatusBadRequest, "nope"))
		case subject == "flaky" && o.busy.Load():
			writeError(w, Errorf(http.StatusServiceUnavailable, "busy"))
		case subject == "odd" && o.odd.Load() != 0:
			w.WriteHeader(int(o.odd.Load()))
		default:
			o.mu.Lock()
			o.took = append(o.took, subject)
			o.mu.Unlock()
			writeJSON(w, 200, map[string]any{"id": "ok"})
		}
	}))
	return o
}

func (o *outboxPeer) subjects() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return strings.Join(o.took, ",")
}

// outboxFixture is here with far's boss remembered, and the notices recorded.
func outboxFixture(t *testing.T) (*fixture, *outboxPeer, *[]string) {
	far := newOutboxPeer(t)
	f := relayFixture(t, far.ts.URL, "", nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('aboss', 'boss', 'far', '2026-01-01')")
	var notes []string
	f.srv.noticeHook = func(id, text string) { notes = append(notes, id+": "+text) }
	return f, far, &notes
}

func (f *fixture) queueMail(subject string) string {
	f.t.Helper()
	rec := f.sendH("POST", "/api/mail", agentTok, nil, `{"to":["boss"],"subject":"`+subject+`","body":"b"}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"queued":true`) {
		f.t.Fatalf("%s wasn't queued: %d %s", subject, rec.Code, rec.Body.String())
	}
	return f.body(rec).Text("id")
}

// Mail to an agent on a peer that is down waits in the outbox (src/mail.ts, S-235), and mail sent while some waits goes
// behind it. Once the peer is back, a pass delivers each once, oldest first: a refused one is dropped with mail:failed
// and a notice to the sender, and the mail behind it still goes. A 503 keeps the mail and holds that peer's queue, so a
// mail sent meanwhile waits behind it.
func TestOutboxDeliversInOrder(t *testing.T) {
	f, far, notes := outboxFixture(t)
	far.down.Store(true)
	one := f.queueMail("outbox one")
	f.queueMail("bad")
	f.queueMail("good")
	if rec := f.sendH("POST", "/api/mail", agentTok, nil, `{"to":["ghost"],"subject":"s","body":"b"}`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "no agent ghost") {
		t.Errorf("an agent no peer has: %d %s", rec.Code, rec.Body.String())
	}
	// An agent last seen archived isn't queued for: it fails as before the outbox.
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle) VALUES ('aold', 'old', 'far', '2026-01-01', 'archived')")
	if rec := f.sendH("POST", "/api/mail", agentTok, nil, `{"to":["aold"],"subject":"s","body":"b"}`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "is archived") {
		t.Errorf("an archived agent on a down peer: %d %s", rec.Code, rec.Body.String())
	}
	far.down.Store(false)
	<-f.srv.drainOutbox()
	if got := far.subjects(); got != "outbox one,good" {
		t.Errorf("far took %q", got)
	}
	if n := f.count("SELECT count(*) FROM peer_outbox"); n != 0 {
		t.Errorf("%d left queued", n)
	}
	if n := f.count("SELECT count(*) FROM events WHERE agent_id = 'achild' AND type = 'mail:delivered_late'"); n != 2 || !strings.Contains(f.lastEvent("achild", "mail:delivered_late"), "aboss") {
		t.Errorf("%d delivered_late events", n)
	}
	if ev := f.lastEvent("achild", "mail:failed"); !strings.Contains(ev, `"error":"nope"`) || !strings.Contains(ev, `"subject":"bad"`) {
		t.Errorf("mail:failed %s", ev)
	}
	if len(*notes) != 1 || !strings.Contains((*notes)[0], `The mail you queued failed`) || !strings.Contains((*notes)[0], `subject "bad": nope`) {
		t.Errorf("notices %q", *notes)
	}
	// The delivered mail is far's under the same id.
	if !strings.Contains(strings.Join(mailPosts(far.peerServer), "\n"), `"mail_id":"`+one+`"`) {
		t.Errorf("far never got %s", one)
	}

	far.busy.Store(true)
	far.down.Store(true)
	f.queueMail("flaky")
	f.queueMail("after")
	far.down.Store(false)
	<-f.srv.drainOutbox()
	if f.count("SELECT count(*) FROM peer_outbox WHERE attempts >= 1 AND last_error = 'busy'") != 1 {
		t.Errorf("a 503 didn't keep the mail: %s", f.text("SELECT group_concat(attempts || ' ' || ifnull(last_error, '')) FROM peer_outbox"))
	}
	if got := far.subjects(); strings.Contains(got, "after") {
		t.Errorf("after went out ahead of flaky: %q", got)
	}
	// far answers now, but mail still waits for it: a new mail goes behind, not ahead.
	f.queueMail("late")
	if got := far.subjects(); strings.Contains(got, "late") {
		t.Errorf("late went out ahead of flaky: %q", got)
	}
	far.busy.Store(false)
	<-f.srv.drainOutbox()
	if got := far.subjects(); got != "outbox one,good,flaky,after,late" {
		t.Errorf("far took %q", got)
	}
}

// Mail queued over seven days ago is dropped, and its sender hears mail:expired.
func TestOutboxExpires(t *testing.T) {
	f, far, _ := outboxFixture(t)
	f.sql(`INSERT INTO peer_outbox (mail_id, peer, body, created_at, attempts, last_error) VALUES ('m0e1', 'far', '{"from":"achild","to":["aboss"],"subject":"old"}', '2026-01-01T00:00:00.000Z', 3, 'fetch failed')`)
	<-f.srv.drainOutbox()
	if f.count("SELECT count(*) FROM peer_outbox") != 0 || far.subjects() != "" {
		t.Errorf("the expired mail: %d queued, far took %q", f.count("SELECT count(*) FROM peer_outbox"), far.subjects())
	}
	if ev := f.lastEvent("achild", "mail:expired"); !strings.Contains(ev, `"id":"m0e1"`) || !strings.Contains(ev, `"last_error":"fetch failed"`) {
		t.Errorf("mail:expired %s", ev)
	}
}

// One pass runs at a time: a pass asked for while one runs returns the running one and runs once more after it, so mail
// queued meanwhile isn't left for the next tick.
func TestOutboxOnePassAtATime(t *testing.T) {
	f, far, _ := outboxFixture(t)
	far.down.Store(true)
	f.queueMail("first")
	far.down.Store(false)
	far.hold = make(chan struct{})
	running := f.srv.drainOutbox()
	// The pass is now inside far's handler, waiting on hold: far has seen the mail.
	for len(mailPosts(far.peerServer)) == 0 {
		select {
		case <-running:
			t.Fatal("the pass ended before far answered")
		case <-time.After(time.Millisecond):
		}
	}
	f.sql(`INSERT INTO peer_outbox (mail_id, peer, body, created_at, attempts, last_error) VALUES ('m0e2', 'far', '{"from":"achild","to":["aboss"],"subject":"second"}', '2099-01-01T00:00:00.000Z', 0, NULL)`)
	if again := f.srv.drainOutbox(); again != running {
		t.Error("a second pass started beside the first")
	}
	for i := 0; i < 2; i++ {
		select {
		case far.hold <- struct{}{}:
		case <-time.After(5 * time.Second):
			t.Fatalf("pass %d never reached far", i+1)
		}
	}
	<-running
	if got := far.subjects(); got != "first,second" {
		t.Errorf("far took %q", got)
	}
}

// Who may start a stopped peer for queued mail (src/mail.ts startsPeer, mayStartPeer, S-1473): a peer with a start
// command, mail that isn't to `all`, a recipient last seen live; and a sender that is the human, the chief of staff, or
// an ancestor of a recipient, across machines.
func TestQueuedMailStartsThePeer(t *testing.T) {
	f, _, _ := outboxFixture(t)
	ctx := context.Background()
	f.sql(`INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle, parents) VALUES ('akid', 'kid', 'far', '2026-01-01', 'active', '["achild"]'), ('agone', 'gone', 'far', '2026-01-01', 'archived', '["achild"]')`)
	with, without := config.Peer{Name: "far", Start: "true"}, config.Peer{Name: "far"}
	for _, c := range []struct {
		p      config.Peer
		to     []string
		starts bool
	}{
		{with, []string{"akid"}, true},
		{without, []string{"akid"}, false},
		{with, []string{"agone"}, false},
		{with, []string{"all", "akid"}, false},
	} {
		named := []string{}
		for _, x := range c.to {
			if x != "all" {
				named = append(named, x)
			}
		}
		if got, err := f.srv.startsPeer(ctx, c.p, c.to, named); err != nil || (len(got) > 0) != c.starts {
			t.Errorf("startsPeer %s %v: %v %v", c.p.Start, c.to, got, err)
		}
	}
	for _, c := range []struct {
		sender string
		named  []string
		may    bool
	}{
		{"human", []string{"aboss"}, true},
		{"achild", []string{"akid"}, true},
		{"achild", []string{"aboss"}, false},
	} {
		if got, err := f.srv.mayStartPeer(ctx, c.sender, c.named); err != nil || got != c.may {
			t.Errorf("mayStartPeer %s %v: %v %v", c.sender, c.named, got, err)
		}
	}
	// The sender's authority counts over the live recipients only: a parent of a child that is shut down, mailing it and
	// an unrelated live agent, doesn't start the peer; mailing its own live child does.
	f.sql(`INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle, parents) VALUES ('aoff', 'off', 'far', '2026-01-01', 'shut_down', '["achild"]')`)
	for _, c := range []struct {
		named []string
		start bool
	}{
		{[]string{"aoff", "aboss"}, false},
		{[]string{"aoff", "akid"}, true},
	} {
		if start, asked, err := f.srv.queuedStart(ctx, with, "achild", c.named, c.named); err != nil || !asked || start != c.start {
			t.Errorf("queuedStart achild %v: start %v asked %v %v", c.named, start, asked, err)
		}
	}
}

// Only a 200 delivers a queued mail and only a 4xx refuses it: a 204 or a 3xx keeps the row, counts the try, and holds
// the peer's queue, as a 5xx does.
func TestOutboxOddAnswersKeepTheMail(t *testing.T) {
	f, far, notes := outboxFixture(t)
	far.down.Store(true)
	f.queueMail("odd")
	f.queueMail("after")
	// The tries so far: the send's own, and any pass the second send asked for while far was down.
	<-f.srv.drainOutbox()
	before := f.count("SELECT attempts FROM peer_outbox ORDER BY created_at LIMIT 1")
	far.down.Store(false)
	for i, status := range []int32{http.StatusNoContent, http.StatusFound} {
		far.odd.Store(status)
		<-f.srv.drainOutbox()
		if n := f.count("SELECT count(*) FROM peer_outbox"); n != 2 || far.subjects() != "" {
			t.Errorf("after a %d: %d queued, far took %q", status, n, far.subjects())
		}
		if got := f.text("SELECT attempts || ' ' || ifnull(last_error, '') FROM peer_outbox ORDER BY created_at LIMIT 1"); got != strconv.Itoa(before+i+1)+" "+strconv.Itoa(int(status)) {
			t.Errorf("after a %d: the row records %q", status, got)
		}
	}
	if len(*notes) != 0 || f.count("SELECT count(*) FROM events WHERE type IN ('mail:failed', 'mail:delivered_late')") != 0 {
		t.Errorf("an odd answer told the sender: %q", *notes)
	}
	far.odd.Store(0)
	<-f.srv.drainOutbox()
	if got := far.subjects(); got != "odd,after" {
		t.Errorf("far took %q", got)
	}
}

// Mail to a broadcast and a named agent on a peer that has mail waiting: the named part goes behind the waiting mail, and
// the broadcast part, which is never queued, goes now. The sender's copy names both.
func TestOutboxBroadcastBesideQueuedMail(t *testing.T) {
	f, far, _ := outboxFixture(t)
	far.down.Store(true)
	f.queueMail("flaky")
	far.down.Store(false)
	far.busy.Store(true)
	rec := f.sendH("POST", "/api/mail", sharedTok, human, `{"from":"human","to":["all","boss"],"subject":"both","body":"b"}`)
	if rec.Code != 200 {
		t.Fatalf("the send: %d %s", rec.Code, rec.Body.String())
	}
	id := f.body(rec).Text("id")
	if got := far.subjects(); got != "both" {
		t.Errorf("far took %q", got)
	}
	for _, p := range mailPosts(far.peerServer) {
		if strings.Contains(p, `"subject":"both"`) && !strings.Contains(p, `"to":["all"]`) {
			t.Errorf("the broadcast part: %s", p)
		}
	}
	if n := f.count("SELECT count(*) FROM peer_outbox WHERE mail_id = '" + id + "' AND body LIKE '%\"to\":[\"aboss\"]%'"); n != 1 {
		t.Errorf("the named part isn't queued: %d", n)
	}
	if c := f.count1("SELECT copy_to FROM mail WHERE id = '" + id + "'"); c != `["aboss","all"]` {
		t.Errorf("copy_to %s", c)
	}
	far.busy.Store(false)
	<-f.srv.drainOutbox()
	if got := far.subjects(); got != "both,flaky,both" {
		t.Errorf("far took %q", got)
	}
}

// Mail queued before a restart is delivered by the pass the daemon runs as it starts, not a tick later.
func TestOutboxDeliversAfterARestart(t *testing.T) {
	f, far, _ := outboxFixture(t)
	far.down.Store(true)
	f.queueMail("before the restart")
	<-f.srv.drainOutbox()
	far.down.Store(false)
	g := reopened(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	t.Setenv("STAM_OUTBOX_MS", "3600000")
	g.srv.StartOutbox(ctx)
	// No pass is asked for here: the one StartOutbox runs must deliver it.
	for deadline := time.Now().Add(5 * time.Second); g.count("SELECT count(*) FROM peer_outbox") != 0 && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
	if got := far.subjects(); got != "before the restart" || g.count("SELECT count(*) FROM peer_outbox") != 0 {
		t.Errorf("after the restart far took %q, %d still queued", got, g.count("SELECT count(*) FROM peer_outbox"))
	}
}

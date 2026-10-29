package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/jsfmt"
)

// notices records the notices queued for agents.
type notices struct {
	mu   sync.Mutex
	list []string
}

func (n *notices) add(id, text string) {
	n.mu.Lock()
	n.list = append(n.list, id+": "+text)
	n.mu.Unlock()
}
func (n *notices) all() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.list...)
}

// inform writes an in-force informing requirement over mail and ITSAs, and records the notices.
func (f *fixture) inform(settings string) *notices {
	f.t.Helper()
	writeFile(f.t, filepath.Join(f.home, "settings.json"), settings)
	f.reqCreate(`{"title":"Say it plainly","text":"Say it plainly","verification":["decision"],"mode":"inform","threshold":0.5,"owner":"child","status":"in_force"}`)
	n := &notices{}
	f.srv.noticeHook = n.add
	return n
}

func (f *fixture) mailAs(token, body string) string {
	f.t.Helper()
	rec := f.sendH("POST", "/api/mail", token, nil, body)
	if rec.Code != 200 {
		f.t.Fatalf("mail %s: %d %s", body, rec.Code, rec.Body.String())
	}
	return f.body(rec).Text("id")
}

func (f *fixture) verdictOf(subject string) string {
	return jsfmt.Compact(dumpTyped(f.t, f, "SELECT verdict, action FROM req_verdicts WHERE subject = '"+subject+"'"))
}

// A mail an agent sends is checked after it is stored: the verdict is recorded and a violation tells the sender, worded as an
// indication. The human's mail and stam's own are not checked. A check that fails or hangs never fails or delays the send.
func TestRequirementsMailObserver(t *testing.T) {
	dir := startDecideStub(t)
	f := newFixture(t, nil)
	n := f.inform(reqSettings)
	id := f.mailAs(agentTok, `{"to":["aboss"],"subject":"status","body":"REQ:R-1=violates all good"}`)
	until(t, "the verdict", func() bool { return f.verdictCount() == 1 })
	if got := f.verdictOf("mail:" + id); got != `[{"verdict":"violates","action":"notified"}]` {
		t.Errorf("verdict: %s", got)
	}
	until(t, "the notice", func() bool { return len(n.all()) == 1 })
	want := "achild: A model check of your mail:" + id + " found a likely problem. It is an indication, not proof.\n\nR-1 likely not met (p 0.90): Say it plainly. If this is wrong, say so to the requirement's owner (child)."
	if got := n.all()[0]; got != want {
		t.Errorf("notice:\n got %q\nwant %q", got, want)
	}

	// A conforming mail is recorded and tells nobody; the human's mail is not checked at all.
	id2 := f.mailAs(agentTok, `{"to":["aboss"],"subject":"status","body":"fine"}`)
	until(t, "the second verdict", func() bool { return f.verdictCount() == 2 })
	if got := f.verdictOf("mail:" + id2); got != `[{"verdict":"conforms","action":"none"}]` || len(n.all()) != 1 {
		t.Errorf("conforming: %s, %d notices", got, len(n.all()))
	}
	if rec := f.post2("POST", "/api/mail", `{"from":"human","to":["aboss"],"subject":"hi","body":"REQ:R-1=violates"}`); rec.Code != 200 {
		t.Fatalf("human mail: %d %s", rec.Code, rec.Body.String())
	}
	// A checked mail sent after it shows the human's was passed over: its observer would have recorded before this one.
	f.mailAs(agentTok, `{"to":["aboss"],"subject":"status","body":"marker one"}`)
	until(t, "the marker verdict", func() bool { return f.verdictCount() >= 3 })
	if f.verdictCount() != 3 {
		t.Errorf("verdicts after the human's mail and a marker: %d", f.verdictCount())
	}

	// A failing model, and one that hangs: the send answers at once and nothing is recorded.
	writeFile(t, filepath.Join(dir, "hang"), "1")
	t.Cleanup(func() { writeFile(t, filepath.Join(dir, "release"), "1") })
	start := time.Now()
	f.mailAs(agentTok, `{"to":["aboss"],"subject":"status","body":"STUB:FAIL"}`)
	f.mailAs(agentTok, `{"to":["aboss"],"subject":"status","body":"STUB:HANG"}`)
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("two sends took %v", d)
	}
	// The hung check holds the model gate: a mail sent behind it is checked once the model is released (it answers 500).
	f.mailAs(agentTok, `{"to":["aboss"],"subject":"status","body":"marker two"}`)
	writeFile(t, filepath.Join(dir, "release"), "1")
	until(t, "the marker verdict", func() bool { return f.verdictCount() >= 4 })
	if f.verdictCount() != 4 {
		t.Errorf("verdicts after a failing and a hung model: %d", f.verdictCount())
	}
}

// A mail longer than the body limit is checked on the stored (truncated) body, so a later manual check of mail:ID is the cached verdict.
func TestRequirementsLongMailChecksStoredBody(t *testing.T) {
	dir := startDecideStub(t)
	f := newFixture(t, nil)
	f.inform(reqSettings)
	long := strings.Repeat("word ", 40000)
	id := f.mailAs(agentTok, `{"to":["aboss"],"subject":"status","body":"`+long+`"}`)
	until(t, "the verdict", func() bool { return f.verdictCount() == 1 })
	b, _ := os.ReadFile(filepath.Join(dir, "state"))
	if !strings.Contains(string(b), "body truncated") || len(b) > len(long) {
		t.Errorf("the model read %d bytes, not the stored body", len(b))
	}
	rec := f.post2("POST", "/api/requirements/check", `{"subject":"mail:`+id+`"}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"cached":true`) {
		t.Errorf("manual check: %d %s", rec.Code, rec.Body.String())
	}
	if f.verdictCount() != 1 {
		t.Errorf("verdicts: %d", f.verdictCount())
	}
}

// Stam's own mail (the cap notice, any notice it sends) is not checked itself.
func TestRequirementsStamMailNotChecked(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	f.inform(reqSettings)
	if !f.srv.sendFromSystem(context.Background(), "requirements", []string{"aboss"}, "[stam] note", "REQ:R-1=violates") {
		t.Fatal("no stam mail sent")
	}
	f.mailAs(agentTok, `{"to":["aboss"],"subject":"status","body":"marker"}`)
	until(t, "the marker verdict", func() bool { return f.verdictCount() == 1 })
	if n := f.count("SELECT count(*) FROM req_verdicts WHERE subject LIKE 'mail:%'"); n != 1 {
		t.Errorf("verdicts: %d", n)
	}
}

// A mail to the human is the kind mail-to-human, which a scope naming `mail` also covers.
func TestRequirementsMailToHumanKind(t *testing.T) {
	dir := startDecideStub(t)
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"requirements":{"enabled":true},"humanMail":{"models":{"claude-haiku-5-5":true}},"itsa":{"ownerNotices":"off"}}`)
	f.reqCreate(`{"title":"Plain","verification":["decision"],"scope":{"subjects":["mail"]},"mode":"observe","status":"in_force"}`)
	f.reqCreate(`{"title":"Only to the human","verification":["decision"],"scope":{"subjects":["mail-to-human"]},"mode":"observe","status":"in_force"}`)
	f.mailAs(agentTok, `{"to":["aboss"],"subject":"s","body":"to the boss"}`)
	until(t, "one verdict", func() bool { return f.verdictCount() == 1 })
	if rec := f.post2("POST", "/api/mail", `{"from":"boss","to":["human"],"subject":"s","body":"to the human","override":"test"}`); rec.Code != 200 {
		t.Fatalf("mail to the human: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "three verdicts", func() bool { return f.verdictCount() == 3 })
	if b, _ := os.ReadFile(filepath.Join(dir, "state")); !strings.Contains(string(b), `"kind":"mail-to-human"`) {
		t.Errorf("last state: %s", b)
	}
}

// An ITSA that is created, changes status or has its text edited is checked after the write, with what the model reads.
func TestRequirementsItsaObserver(t *testing.T) {
	dir := startDecideStub(t)
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"requirements":{"enabled":true},"itsa":{"ownerNotices":"off"}}`)
	f.reqCreate(`{"title":"ITSAs","verification":["decision"],"scope":{"subjects":["itsa"]},"mode":"observe","status":"in_force"}`)
	state := func() string { b, _ := os.ReadFile(filepath.Join(dir, "state")); return string(b) }
	key := f.createItsa(`{"title":"Alpha","owner":"child"}`)
	until(t, "the create check", func() bool { return f.verdictCount() == 1 })
	for _, want := range []string{`"event":"created"`, `"key":"` + key + `"`, `"title":"Alpha"`, `"owner":"child"`, `"actor":{"name":"human"`} {
		if !strings.Contains(state(), want) {
			t.Errorf("created state lacks %s: %s", want, state())
		}
	}
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"in_progress"}`); rec.Code != 200 {
		t.Fatalf("status: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the status check", func() bool { return f.verdictCount() == 2 })
	for _, want := range []string{`"event":"status"`, `"from":"backlog"`, `"to":"in_progress"`} {
		if !strings.Contains(state(), want) {
			t.Errorf("status state lacks %s: %s", want, state())
		}
	}
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"title":"Alpha edited"}`); rec.Code != 200 {
		t.Fatalf("edit: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the edit check", func() bool { return f.verdictCount() == 3 })
	if !strings.Contains(state(), `"event":"edit"`) || !strings.Contains(state(), `"title":"Alpha edited"`) {
		t.Errorf("edit state: %s", state())
	}
	// A change of owner alone is not checked.
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"owner":"boss"}`); rec.Code != 200 {
		t.Fatalf("owner: %d %s", rec.Code, rec.Body.String())
	}
	// A later title edit is checked; the owner change before it left no verdict.
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"title":"Alpha again"}`); rec.Code != 200 {
		t.Fatalf("edit: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the second edit check", func() bool { return f.verdictCount() >= 4 })
	if f.verdictCount() != 4 {
		t.Errorf("an owner change was checked: %d", f.verdictCount())
	}
}

// A manual check of a mail or an ITSA by its ref; an unknown one is a 400 with TS's text.
func TestRequirementsManualSubjects(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	f.inform(reqSettings)
	id := f.mailAs(agentTok, `{"to":["aboss"],"subject":"s","body":"REQ:R-1=violates"}`)
	until(t, "the live check", func() bool { return f.verdictCount() == 1 })
	rec := f.post2("POST", "/api/requirements/check", `{"subject":"mail:`+id+`"}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"subject":"mail:`+id+`"`) || !strings.Contains(rec.Body.String(), `"cached":true`) {
		t.Errorf("a mail: %d %s", rec.Code, rec.Body.String())
	}
	key := f.createItsa(`{"title":"Alpha"}`)
	rec = f.post2("POST", "/api/requirements/check", `{"subject":"itsa:`+key+`"}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"subject":"itsa:`+key+`"`) {
		t.Errorf("an ITSA: %d %s", rec.Code, rec.Body.String())
	}
	for ref, msg := range map[string]string{"mail:nope": "no mail nope", "itsa:S-999": "no ITSA S-999"} {
		rec := f.post2("POST", "/api/requirements/check", `{"subject":"`+ref+`"}`)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), msg) {
			t.Errorf("%s: %d %s", ref, rec.Code, rec.Body.String())
		}
	}
}

// On a daemon that is not the home a mail is forwarded to the home; the home accepts only the mail kinds.
func TestRequirementsForwardedSubjects(t *testing.T) {
	startDecideStub(t)
	var mu sync.Mutex
	var bodies []string
	home := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if r.URL.Path == "/api/requirements/check-subject" {
			mu.Lock()
			bodies = append(bodies, string(b))
			mu.Unlock()
		}
		io.WriteString(w, `{"accepted":true}`)
	}))
	defer home.Close()
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"requirements":{"enabled":true},"home":"farhome","peers":[{"name":"farhome","url":"`+home.URL+`","token":"test-peer-token"}]}`)
	id := f.mailAs(agentTok, `{"to":["aboss"],"subject":"status","body":"hello"}`)
	until(t, "the forward", func() bool { mu.Lock(); defer mu.Unlock(); return len(bodies) == 1 })
	want := `{"subject":{"kind":"mail","ref":"mail:` + id + `","content":{"subject":"status","body":"hello","thread":"` + f.count1("SELECT thread_id FROM mail WHERE id = '"+id+"'") + `"},"actor":{"name":"child","role":"developer","parent":"boss"},"actorId":"achild"}}`
	mu.Lock()
	got := bodies[0]
	mu.Unlock()
	if got != want {
		t.Errorf("forward:\n got %s\nwant %s", got, want)
	}
	// An unreachable home is logged, never failing the send.
	home.Close()
	f.mailAs(agentTok, `{"to":["aboss"],"subject":"status","body":"again"}`)
	until(t, "the req:error", func() bool { return f.count("SELECT count(*) FROM events WHERE type = 'req:error'") > 0 })

	// The home's side.
	h := newFixture(t, nil)
	n := h.inform(reqSettings)
	post := func(body string) string {
		rec := h.do(call{method: "POST", path: "/api/requirements/check-subject", token: peerTok, header: peerLocal, body: body})
		return rec.Body.String()
	}
	subject := `{"kind":"mail","ref":"mail:mfwd1","content":{"subject":"s","body":"REQ:R-1=violates","thread":null},"actor":{"name":"far","role":null,"parent":null},"actorId":"farid"}`
	if got := post(`{"subject":` + subject + `}`); got != `{"accepted":true}` {
		t.Errorf("a mail: %s", got)
	}
	until(t, "the forwarded verdict", func() bool { return h.verdictCount() == 1 })
	_ = n
	for name, body := range map[string]string{
		"an itsa":     `{"subject":` + strings.Replace(subject, `"kind":"mail"`, `"kind":"itsa"`, 1) + `}`,
		"no actor":    `{"subject":{"kind":"mail","ref":"mail:x","content":{}}}`,
		"no ref":      `{"subject":{"kind":"mail","content":{},"actor":{"name":"a"}}}`,
		"no subject":  `{}`,
		"a bad actor": `{"subject":{"kind":"mail","ref":"mail:x","content":{},"actor":{"name":3}}}`,
	} {
		if got := post(body); got != `{"accepted":false}` {
			t.Errorf("%s: %s", name, got)
		}
	}
}

// The daily cap mails the chief of staff once, else the human when the human's mail settings allow it.
func TestRequirementsCapNotice(t *testing.T) {
	startDecideStub(t)
	subjects := func(f *fixture, to string) int {
		return f.count("SELECT count(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.subject = '[stam] Requirement checks reached the daily cap' AND r.agent_id = ?", to)
	}
	run := func(settings string) *fixture {
		f := newFixture(t, nil)
		f.enforceBash(settings)
		for _, c := range []string{"one", "two", "three"} {
			f.check(sharedTok, `{"agent":"aboss","tool":"Bash","args":{"c":"REQ:R-1=violates `+c+`"}}`)
		}
		until(t, "the checks", func() bool { return f.count("SELECT count(*) FROM events WHERE type = 'req:cap'") == 1 })
		return f
	}
	f := run(`{"requirements":{"enabled":true,"dailyCapUsd":0.01},"chiefOfStaff":"boss","itsa":{"ownerNotices":"off"}}`)
	until(t, "the mail to the chief of staff", func() bool { return subjects(f, "aboss") == 1 })
	if n := f.count("SELECT count(*) FROM events WHERE type = 'req:cap'"); n != 1 {
		t.Errorf("req:cap events: %d", n)
	}
	body := dumpTyped(t, f, "SELECT m.body, m.from_id FROM mail m WHERE m.subject = '[stam] Requirement checks reached the daily cap'")
	if !strings.Contains(jsfmt.Compact(body), "they spent $0.0200 of the $0.01 daily cap (settings.requirements.dailyCapUsd)") {
		t.Errorf("body: %s", jsfmt.Compact(body))
	}
	// With no chief of staff the human is told only at `important` or above.
	g := run(`{"requirements":{"enabled":true,"dailyCapUsd":0.01},"itsa":{"ownerNotices":"off"}}`)
	if subjects(g, "human") != 0 {
		t.Errorf("the human was mailed at `necessary`")
	}
	h := run(`{"requirements":{"enabled":true,"dailyCapUsd":0.01},"humanMail":{"when":"important"},"itsa":{"ownerNotices":"off"}}`)
	until(t, "the mail to the human", func() bool { return subjects(h, "human") == 1 })
}

var _ = context.Background

func (f *fixture) count1(query string) string {
	f.t.Helper()
	v := dumpTyped(f.t, f, query)
	if len(v.Items) == 0 || len(v.Items[0].Items) == 0 {
		f.t.Fatalf("no row for %s", query)
	}
	return v.Items[0].Text(v.Items[0].Keys[0])
}

// TestSendFromSystem: stam's own mail from a system sender is stored from system:NAME, named NAME, to its recipients;
// a bad name sends nothing.
func TestSendFromSystem(t *testing.T) {
	f := newFixture(t, nil)
	if !f.srv.sendFromSystem(context.Background(), "cost", []string{"human"}, "[stam] Daily spend passed $2", "b") {
		t.Fatal("not sent")
	}
	if got := f.count1("SELECT from_id || '|' || from_name || '|' || r.agent_id FROM mail JOIN mail_recipients r ON r.mail_id = mail.id WHERE subject = '[stam] Daily spend passed $2'"); got != "system:cost|cost|human" {
		t.Errorf("stored %s", got)
	}
	if f.srv.sendFromSystem(context.Background(), "Bad Name", []string{"human"}, "s", "b") {
		t.Error("a bad system name was sent")
	}
}

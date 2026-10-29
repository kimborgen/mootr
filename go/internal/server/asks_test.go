package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/jsfmt"
)

// TestAsksMatchTS builds a home holding asks of every kind through src/ (testdata/asksref.mjs) and compares src/asks.ts
// localAsks over it with GET /api/asks on a copy: every row, its fields and the list's order (S-3831). The home holds
// permission requests of each kind and outcome with a secret in their text, ITSAs open and settled as approved, withdrawn and
// answered, and decision mails open, held by a waiting ITSA, answered with and without a choice, withdrawn, superseded,
// deferred, settled elsewhere, and settled more than a day ago.
func TestAsksMatchTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/asks.ts")
	}
	home := filepath.Join(t.TempDir(), "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/asksref.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("asksref.mjs: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "expect.json"))
	must(t, err)
	want, err := jsfmt.Parse(raw)
	must(t, err)
	if len(want.Items) < 15 {
		t.Fatalf("the reference listed only %d asks", len(want.Items))
	}

	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.pre.db"))
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"itsa":{"ownerNotices":"off"}}`)
	rec := f.post2("GET", "/api/asks", "")
	if rec.Code != 200 {
		t.Fatalf("GET /api/asks: %d %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "STAM-SENTINEL-SECRET-7f3a") {
		t.Errorf("a secret reached the list")
	}
	got, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	if len(got.Items) != len(want.Items) {
		t.Fatalf("Go lists %d asks, TS %d:\n go %s\n ts %s", len(got.Items), len(want.Items), jsfmt.Compact(got), jsfmt.Compact(want))
	}
	for i := range want.Items {
		if g, w := jsfmt.Compact(got.Items[i]), jsfmt.Compact(want.Items[i]); g != w {
			t.Errorf("ask %d:\n go %s\n ts %s", i, g, w)
		}
	}
}

// The human's reply settles a decision with the option it chose, as GET /api/asks then lists it; a deferral records one
// deferred event however often the human defers, and keeps the decision open (src/mail.ts, src/db.ts setThreadDeferred).
func TestAsksDecisionSettles(t *testing.T) {
	f := newFixture(t, map[string]string{})
	f.sql("UPDATE agents SET type = 'manager', model = 'claude-opus-5-5' WHERE id = 'achild'")
	decision := func(subject string) string {
		t.Helper()
		rec := f.post(agentTok, nil, "{\"to\":[\"human\"],\"subject\":\""+subject+"\",\"body\":\"```pick\\nbilling\\nsearch\\n```\",\"new_thread\":true}")
		v, _ := jsfmt.Parse(rec.Body.Bytes())
		if rec.Code != 200 || f.count("SELECT COUNT(*) FROM decision_mails WHERE mail_id = ?", v.Text("id")) != 1 {
			t.Fatalf("the decision: %d %s", rec.Code, rec.Body)
		}
		return v.Text("id")
	}
	chose, deferred := decision("Pick one"), decision("Later")
	f.post(sharedTok, human, `{"from":"human","to":["achild"],"reply_to":"`+chose+`","body":"> Pick?\nChose **billing**.\n\nNote: soon"}`)
	for range 2 {
		f.post(sharedTok, human, `{"from":"human","to":["achild"],"reply_to":"`+deferred+`","body":"Deferring this one: still open, I'll decide later."}`)
	}
	events := f.text("SELECT group_concat(ref || ' ' || outcome || ' ' || COALESCE(label, '-'), ', ') FROM (SELECT * FROM comms_events WHERE kind = 'decision' ORDER BY id)")
	if want := chose + " answered billing, " + deferred + " deferred -"; events != want {
		t.Errorf("comms events:\n got %s\nwant %s", events, want)
	}
	rec := f.post2("GET", "/api/asks", "")
	list, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	var rows []string
	for _, a := range list.Items {
		if a.Text("kind") == "decision" {
			rows = append(rows, a.Text("key")+" "+a.Text("state")+" "+a.Text("outcome"))
		}
	}
	if got, want := strings.Join(rows, ", "), "decision:"+deferred+" open , decision:"+chose+" settled answered: billing"; got != want {
		t.Errorf("the list:\n got %s\nwant %s", got, want)
	}
}

// The list merges the peers' rows: a key two daemons hold is one row and the settled one wins, a decision about an ITSA waiting
// on a peer's home is off the list while it waits (a settled one stays, as history), and a peer's own request reads this
// daemon's rows only. An agent's token can't read it.
func TestAsksMergeThePeers(t *testing.T) {
	var calls atomic.Int32
	at := func(h float64) string { return time.Now().Add(-time.Duration(h * float64(time.Hour))).UTC().Format("2006-01-02T15:04:05.000Z") }
	peerAsks := `[` +
		`{"key":"decision:mBOTH","kind":"decision","state":"settled","outcome":"answered","what":"Both","agent_id":"aw","agent_name":"w","machine":"far","thread_id":"mBOTH","itsa_id":null,"since":"` + at(5) + `","settled_at":"` + at(1) + `"},` +
		`{"key":"decision:mSETTLED","kind":"decision","state":"open","outcome":null,"what":"Settled here","agent_id":"aw","agent_name":"w","machine":"far","thread_id":"mSETTLED","itsa_id":null,"since":"` + at(5) + `","settled_at":null},` +
		`{"key":"request:pFAR","kind":"request","state":"open","outcome":null,"what":"Permission request","agent_id":"afar","agent_name":"far-one","machine":"far","thread_id":null,"itsa_id":null,"since":"` + at(4) + `","settled_at":null}]`
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		switch r.URL.Path {
		case "/api/asks":
			io.WriteString(w, peerAsks)
		case "/api/itsas/attention":
			io.WriteString(w, `[{"id":"iFAR"}]`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(peer.Close)
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"peers":[{"name":"far","url":"`+peer.URL+`","token":"test-peer-token"}]}`)
	f.sql("DELETE FROM permission_requests")
	for _, m := range []struct{ id, about, created string }{{"mBOTH", "", at(5)}, {"mHELD", "iFAR", at(3)}, {"mSETTLED", "", at(5)}, {"mHISTORY", "iFAR", at(6)}} {
		var about any
		if m.about != "" {
			about = m.about
		}
		f.sql("INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id, about_itsa) VALUES (?, 'aboss', 'boss', ?, 'pick', ?, ?, ?)", m.id, m.id, m.created, m.id, about)
		if m.id == "mBOTH" || m.id == "mHELD" {
			f.sql("INSERT INTO decision_mails (mail_id, thread_id) VALUES (?, ?)", m.id, m.id)
		}
	}
	f.sql("INSERT INTO comms_events (kind, ref, outcome, label, duration_ms, created_at) VALUES ('decision', 'mSETTLED', 'answered', NULL, NULL, ?), ('decision', 'mHISTORY', 'withdrawn', NULL, NULL, ?)", at(2), at(0.5))

	rec := f.post2("GET", "/api/asks", "")
	if rec.Code != 200 {
		t.Fatalf("GET /api/asks: %d %s", rec.Code, rec.Body)
	}
	list, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	var rows []string
	for _, a := range list.Items {
		rows = append(rows, a.Text("key")+" "+a.Text("state")+" "+a.Text("machine"))
	}
	if got, want := strings.Join(rows, ", "), "request:pFAR open far, decision:mHISTORY settled test-machine, decision:mBOTH settled far, decision:mSETTLED settled test-machine"; got != want {
		t.Errorf("the merged list:\n got %s\nwant %s", got, want)
	}

	// A peer's own request reads this daemon's rows, and asks no peer.
	before := calls.Load()
	rec = f.sendH("GET", "/api/asks", peerTok, map[string]string{"X-Stam-Local": "1"}, "")
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "pFAR") || !strings.Contains(rec.Body.String(), "decision:mHELD") || calls.Load() != before {
		t.Errorf("a peer's request: %d %s (%d peer calls)", rec.Code, rec.Body, calls.Load()-before)
	}

	if rec := f.sendH("GET", "/api/asks", agentTok, nil, ""); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "an agent's token can't read the Needs you list") {
		t.Errorf("an agent's token: %d %s", rec.Code, rec.Body)
	}
}

// A peer's rows are projected onto the Ask fields, and a permission row's what is its kind label: a secret a peer puts in
// what or in any other field never reaches the list, also when its settled copy replaces this daemon's open row. A row of a
// kind the list doesn't know is dropped.
func TestAsksProjectPeerRows(t *testing.T) {
	const secret = "STAM-SENTINEL-SECRET-7f3a" // gitleaks:allow
	at := func(h float64) string { return time.Now().Add(-time.Duration(h * float64(time.Hour))).UTC().Format("2006-01-02T15:04:05.000Z") }
	row := func(key, kind, state string, settled any) string {
		s := `null`
		if settled != nil {
			s = `"` + settled.(string) + `"`
		}
		return `{"key":"` + key + `","kind":"` + kind + `","state":"` + state + `","outcome":` + map[bool]string{true: `"denied"`, false: `null`}[state == "settled"] +
			`,"what":"run ` + secret + `","agent_id":"afar","agent_name":"far-one","machine":"far","thread_id":null,"itsa_id":null,"since":"` + at(3) + `","settled_at":` + s +
			`,"action":"push ` + secret + `","details":"` + secret + `","payload":{"secret":"` + secret + `"},"text":"` + secret + `"}`
	}
	peerAsks := `[` + row("request:pLOCAL", "request", "settled", at(0.5)) + `,` + row("request:pF1", "request", "open", nil) + `,` +
		row("dialog:pF2", "dialog", "open", nil) + `,` + row("settings:pF3", "settings", "open", nil) + `,` + row("input:pF4", "input", "settled", at(1)) + `,` +
		row("weird:pF5", "weird", "open", nil) + `]`
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/asks" {
			io.WriteString(w, peerAsks)
			return
		}
		io.WriteString(w, `[]`)
	}))
	t.Cleanup(peer.Close)
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"peers":[{"name":"far","url":"`+peer.URL+`","token":"test-peer-token"}]}`)
	f.sql("DELETE FROM permission_requests")
	f.sql("INSERT INTO permission_requests (id, agent_id, action, reason, details, status, created_at, kind, dialog, audience) VALUES ('pLOCAL', 'achild', 'a', 'r', 'd', 'pending', ?, 'request', 0, 'human')", at(4))

	rec := f.post2("GET", "/api/asks", "")
	if rec.Code != 200 || strings.Contains(rec.Body.String(), secret) {
		t.Fatalf("the list carries a peer's secret: %d %s", rec.Code, rec.Body)
	}
	list, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	var rows []string
	for _, a := range list.Items {
		rows = append(rows, a.Text("key")+" "+a.Text("state")+" "+a.Text("what")+" "+strings.Join(a.Keys, ","))
	}
	fields := "key,kind,state,outcome,what,agent_id,agent_name,machine,thread_id,itsa_id,since,settled_at"
	want := []string{
		"request:pF1 open Permission request " + fields, "dialog:pF2 open Harness dialog " + fields, "settings:pF3 open Settings change " + fields,
		"request:pLOCAL settled Permission request " + fields, "input:pF4 settled Suggested input " + fields,
	}
	if got := strings.Join(rows, "\n"); got != strings.Join(want, "\n") {
		t.Errorf("the list:\n got %s\nwant %s", got, strings.Join(want, "\n"))
	}
}

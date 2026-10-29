package server

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsfmt"
)

// storeMail stores a mail directly, as a peer's delivery or an older daemon would have, without queueing it.
func (f *fixture) storeMail(id, from, to, subject, body string) {
	f.t.Helper()
	_, err := f.db.StoreMail(context.Background(), db.Stored{ID: id, ThreadID: id, From: from, FromName: from, Subject: subject, Body: body, To: []string{to}, ToHuman: to == humanBox})
	must(f.t, err)
}

// indexed waits, on the index's state, until no item of source lacks a current vector from the stub model.
func (f *fixture) indexed(source string) {
	f.t.Helper()
	pending := f.db.MailToEmbed
	if source == "itsa" {
		pending = f.db.ItsasToEmbed
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		left, err := pending(context.Background(), "stub-256", 10)
		must(f.t, err)
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("%s never indexed: %v left", source, left)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// startIndex runs the index's worker until the test ends, and returns a stop that waits for it.
func (f *fixture) startIndex() func() {
	ctx, cancel := context.WithCancel(context.Background())
	f.srv.StartSearchIndex(ctx)
	stop := func() {
		cancel()
		f.srv.WaitBackground()
	}
	f.t.Cleanup(stop)
	return stop
}

func (f *fixture) search(path, token string) jsfmt.Value {
	f.t.Helper()
	rec := f.do(call{path: path, token: token})
	if rec.Code != 200 {
		f.t.Fatalf("GET %s: %d %s", path, rec.Code, rec.Body.String())
	}
	return f.body(rec)
}

func threadIDs(hits jsfmt.Value) []string {
	var out []string
	for _, h := range hits.Items {
		out = append(out, h.Text("thread_id"))
	}
	return out
}

// Mail search by meaning reads only what the viewer may: its own mail and its ancestors' threads with the human. An agent
// can't search another agent's box, and /api/search shows an agent no thread of the human's.
func TestMailSearchScope(t *testing.T) {
	f := newFixture(t, nil)
	// The boss's thread with the human; another agent's; and one the boss sent another agent.
	f.storeMail("ms1", "aboss", humanBox, "Sign-in bounce", "users keep getting redirected back to the sign-in page after logout")
	f.storeMail("ms2", "agone", humanBox, "Invoice run", "invoice reconciliation for September")
	f.storeMail("ms3", "aboss", "agone", "Invoice cleanup", "invoice notes, private to gone")
	f.startIndex()
	// Stored before the worker ran: the start's backfill indexes them.
	f.indexed("mail")

	q := url.QueryEscape("keeps redirecting users")
	hits := f.search("/api/mail/search?q="+q, agentTok)
	if got := threadIDs(hits); len(got) != 1 || got[0] != "ms1" || hits.Items[0].Text("by") != "meaning" {
		t.Errorf("the child's search by meaning: %s", jsfmt.Compact(hits))
	}
	if got := f.search("/api/mail/search?q=invoice", agentTok); len(got.Items) != 0 {
		t.Errorf("the child found mail it may not read: %s", jsfmt.Compact(got))
	}
	// The boss reads its own mail to gone, and the human its own thread with gone, by keyword words too.
	if got := threadIDs(f.search("/api/mail/search?box=aboss&q=invoice", sharedTok)); len(got) != 1 || got[0] != "ms3" {
		t.Errorf("the boss's search for invoice: %v", got)
	}
	// An agent may not search a box it can't act as.
	if rec := f.do(call{path: "/api/mail/search?box=agone&q=invoice", token: agentTok}); rec.Code != 403 {
		t.Errorf("the child searched gone's box: %d %s", rec.Code, rec.Body.String())
	}
	// No box from the CLI is a 400, as TS.
	if rec := f.do(call{path: "/api/mail/search?q=invoice", token: sharedTok}); rec.Code != 400 || !strings.Contains(rec.Body.String(), "box is required") {
		t.Errorf("no box: %d %s", rec.Code, rec.Body.String())
	}
	// /api/search: the human's threads for the shared token, none for an agent's.
	kinds := func(v jsfmt.Value) map[string]bool {
		out := map[string]bool{}
		for _, r := range v.Items {
			out[r.Text("kind")] = true
		}
		return out
	}
	if k := kinds(f.search("/api/search?q="+q, sharedTok)); !k["thread"] {
		t.Errorf("the human's search has no thread")
	}
	if k := kinds(f.search("/api/search?q=invoice", agentTok)); k["thread"] {
		t.Errorf("an agent's search shows the human's threads")
	}
}

// The index survives a restart: the vectors are in the database, a new worker indexes what was stored while none ran,
// an edited ITSA is re-embedded, and stopping the worker ends it.
func TestSearchIndexRestart(t *testing.T) {
	f := newFixture(t, nil)
	f.storeMail("mr1", "aboss", humanBox, "Sign-in bounce", "users keep getting redirected back to the sign-in page after logout")
	stop := f.startIndex()
	f.indexed("mail")
	key := f.createItsa(`{"by":"human","title":"Login regression","body":"Users keep getting redirected back to the sign-in page."}`)
	f.indexed("itsa")
	stop()

	// While no worker runs: a mail stored, and the ITSA's text edited.
	f.storeMail("mr2", "aboss", humanBox, "Quarterly invoice", "invoice reconciliation for September")
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"by":"human","body":"Quarterly headcount forecast for each team."}`); rec.Code != 200 {
		t.Fatalf("edit: %d %s", rec.Code, rec.Body.String())
	}

	// A new server over the same database, as after a restart.
	f.srv = New(f.cfg, f.srv.settings, f.db, f.hub, nil)
	f.startIndex()
	f.indexed("mail")
	f.indexed("itsa")
	// Words that share stems with the new body but match no text by keyword: only the new vector finds it.
	hits := f.search("/api/itsas/search?q="+url.QueryEscape("forecasting headcounts"), sharedTok)
	if len(hits.Items) == 0 || hits.Items[0].Text("key") != key {
		t.Fatalf("the edited ITSA wasn't found by its new text: %s", jsfmt.Compact(hits))
	}
	if cos, _ := numOf(func() jsfmt.Value { c, _ := hits.Items[0].Get("cosine"); return c }()); cos < meaningFloor {
		t.Errorf("the edited ITSA's cosine %v is under the floor: it was found by keyword, not re-embedded", cos)
	}
	hits = f.search("/api/mail/search?box=aboss&q="+url.QueryEscape("keeps redirecting users"), sharedTok)
	if got := threadIDs(hits); len(got) == 0 || got[0] != "mr1" || hits.Items[0].Text("by") != "meaning" {
		t.Errorf("after the restart, the meaning search lost the first mail: %s", jsfmt.Compact(hits))
	}
}

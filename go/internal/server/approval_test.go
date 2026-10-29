package server

import (
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const approvalSettings = `{"requirements":{"enabled":true,"approval":"human"},"humanMail":{"models":{"claude-haiku-5-5":true}},"itsa":{"ownerNotices":"off"}}`

// draftBy creates a draft as the agent and returns its key and the ask's ITSA key.
func (f *fixture) draftBy(token, body string) (key, ask string) {
	f.t.Helper()
	rec := f.sendH("POST", "/api/requirements", token, nil, body)
	if rec.Code != 200 {
		f.t.Fatalf("draft %s: %d %s", body, rec.Code, rec.Body.String())
	}
	v := f.body(rec)
	a, _ := v.Get("approval")
	return v.Text("key"), a.Text("itsa")
}

// asHuman is the human's own request: the test key, which proves the owner, not a shared token with a header.
func (f *fixture) asHuman(method, path, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.do(call{method: method, path: path, header: map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1"}, body: body})
}

// approve is the human's Approve on an ask, naming the revision of its text as the web UI shows it (S-2998).
func (f *fixture) approve(ask string) *httptest.ResponseRecorder {
	f.t.Helper()
	rev := f.body(f.post2("GET", "/api/itsas/"+ask, "")).Text("rev")
	return f.post2("POST", "/api/itsas/"+ask+"/act", `{"action":"approve","if_rev":"`+rev+`"}`)
}

func (f *fixture) reqStatus(key string) string {
	f.t.Helper()
	return f.count1("SELECT status FROM requirements WHERE key = '" + key + "'")
}

func (f *fixture) itsaStatus(key string) string {
	f.t.Helper()
	return f.count1("SELECT status FROM itsas WHERE key = '" + key + "'")
}

// An agent's draft opens an ask ITSA owned by the author, linked to the requirement, waiting on the human with the statement
// as its comment; the human's Approve puts the requirement in force and closes the ITSA.
func TestRequirementApprovalHumanAsk(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, f.home+"/settings.json", approvalSettings)
	key, ask := f.draftBy(agentTok, `{"title":"Agent draft","text":"Be kind."}`)
	if ask == "" {
		t.Fatal("no ask")
	}
	if got := f.itsaStatus(ask); got != "needs_approval" {
		t.Errorf("ask status: %s", got)
	}
	if got := f.count1("SELECT kind FROM itsas WHERE key = '" + ask + "'"); got != "requirement-approval" {
		t.Errorf("kind: %s", got)
	}
	if got := f.count1("SELECT owner FROM itsas WHERE key = '" + ask + "'"); got != "achild" {
		t.Errorf("owner: %s", got)
	}
	if n := f.count("SELECT count(*) FROM itsa_links l JOIN itsas i ON i.id = l.itsa_id WHERE i.key = ? AND l.system = 'requirement' AND l.external_id = ?", ask, key); n != 1 {
		t.Errorf("link: %d", n)
	}
	if n := f.count("SELECT count(*) FROM req_approvals WHERE req_key = ? AND rev = 1 AND via = 'human'", key); n != 1 {
		t.Errorf("stamp: %d", n)
	}
	rec := f.approve(ask)
	if rec.Code != 200 {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the requirement in force", func() bool { return f.reqStatus(key) == "in_force" })
	until(t, "the ask closed", func() bool { return f.itsaStatus(ask) == "done" })
}

// An edit of the draft while the ask is open moves the same ITSA's text; an Approve after a change the ask did not show is
// not an approval: the requirement stays a draft and the ask is raised again.
func TestRequirementApprovalStaleRev(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, f.home+"/settings.json", approvalSettings)
	key, ask := f.draftBy(agentTok, `{"title":"Agent draft"}`)
	// The human edits the draft: only the stamp moves, so Approve still applies.
	if rec := f.post2("PATCH", "/api/requirements/"+key, `{"title":"Edited by the human"}`); rec.Code != 200 {
		t.Fatalf("edit: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT count(*) FROM req_approvals WHERE req_key = ? AND rev = 2", key); n != 1 {
		t.Errorf("stamp after the human's edit: %d", n)
	}
	// The author's edit refreshes the ask's body.
	if rec := f.sendH("PATCH", "/api/requirements/"+key, agentTok, nil, `{"text":"New text"}`); rec.Code != 200 {
		t.Fatalf("author edit: %d %s", rec.Code, rec.Body.String())
	}
	if body := f.count1("SELECT body FROM itsas WHERE key = '" + ask + "'"); !strings.Contains(body, "New text") {
		t.Errorf("ask body: %s", body)
	}
	// A change that slips in between the stamp and the Approve: the stamp is stale, so the requirement is not approved.
	f.sql("UPDATE req_approvals SET rev = 1 WHERE req_key = ?", key)
	if rec := f.approve(ask); rec.Code != 200 {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the ask raised again", func() bool { return f.itsaStatus(ask) == "needs_approval" && f.reqStatus(key) == "draft" })
}

// A requirement put in force by someone else closes its open ask.
func TestRequirementApprovedElsewhere(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, f.home+"/settings.json", approvalSettings)
	key, ask := f.draftBy(agentTok, `{"title":"Agent draft"}`)
	if rec := f.post2("PATCH", "/api/requirements/"+key, `{"status":"in_force"}`); rec.Code != 200 {
		t.Fatalf("in force: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the ask closed", func() bool { return f.itsaStatus(ask) == "done" })
	if n := f.count("SELECT count(*) FROM mail m JOIN itsas i ON i.thread_id = m.thread_id WHERE i.key = ? AND m.body LIKE ?", ask, key+" was put in force by%"); n != 1 {
		t.Errorf("closing comment: %d", n)
	}
}

// With approval `cos` the chief of staff owns the ask and it never moves to a human status; the chief of staff's own draft
// goes to the human.
func TestRequirementApprovalChiefOfStaff(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, f.home+"/settings.json", `{"requirements":{"enabled":true,"approval":"cos"},"chiefOfStaff":"boss","humanMail":{"models":{"claude-haiku-5-5":true}},"itsa":{"ownerNotices":"off"}}`)
	rec := f.sendH("POST", "/api/requirements", agentTok, nil, `{"title":"Agent draft"}`)
	if rec.Code != 200 {
		t.Fatalf("draft: %d %s", rec.Code, rec.Body.String())
	}
	a, _ := f.body(rec).Get("approval")
	if a.Text("to") != "chief of staff" {
		t.Fatalf("approval: %s", rec.Body.String())
	}
	ask := a.Text("itsa")
	if got := f.count1("SELECT owner FROM itsas WHERE key = '" + ask + "'"); got != "aboss" {
		t.Errorf("owner: %s", got)
	}
	if got := f.itsaStatus(ask); got != "waiting" {
		t.Errorf("status: %s", got)
	}
	// The chief of staff's own draft goes to the human.
	writeFile(t, f.home+"/settings.json", `{"requirements":{"enabled":true,"approval":"cos"},"chiefOfStaff":"child","humanMail":{"models":{"claude-haiku-5-5":true}},"itsa":{"ownerNotices":"off"}}`)
	rec = f.sendH("POST", "/api/requirements", agentTok, nil, `{"title":"Chief draft"}`)
	if rec.Code != 200 {
		t.Fatalf("chief draft: %d %s", rec.Code, rec.Body.String())
	}
	a, _ = f.body(rec).Get("approval")
	if a.Text("to") != "human" {
		t.Errorf("chief draft approval: %s", rec.Body.String())
	}
}

// A model that may not mail the human cannot raise the ask: the draft is made, the approval is the error, no ITSA is left open.
func TestRequirementApprovalNoHumanMail(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, f.home+"/settings.json", `{"requirements":{"enabled":true,"approval":"human"},"itsa":{"ownerNotices":"off"}}`)
	rec := f.sendH("POST", "/api/requirements", agentTok, nil, `{"title":"Agent draft"}`)
	if rec.Code != 200 {
		t.Fatalf("draft: %d %s", rec.Code, rec.Body.String())
	}
	a, _ := f.body(rec).Get("approval")
	if a.Text("error") == "" {
		t.Errorf("no error: %s", rec.Body.String())
	}
	if n := f.count("SELECT count(*) FROM itsas WHERE kind = 'requirement-approval' AND status NOT IN ('canceled', 'done')"); n != 0 {
		t.Errorf("open asks: %d", n)
	}
}

// A batch of drafts has one ask; Approve puts them all in force or none; a stale one asks again; a dropped one is left out.
func TestRequirementApprovalBatch(t *testing.T) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	writeFile(t, f.home+"/settings.json", approvalSettings)
	rec := f.sendH("POST", "/api/requirements/batch", agentTok, nil, `{"requirements":[{"title":"A"},{"title":"B"},{"title":"C"}]}`)
	if rec.Code != 200 {
		t.Fatalf("batch: %d %s", rec.Code, rec.Body.String())
	}
	a, _ := f.body(rec).Get("approval")
	ask := a.Text("itsa")
	if ask == "" || a.Text("to") != "human" {
		t.Fatalf("approval: %s", rec.Body.String())
	}
	if n := f.count("SELECT count(*) FROM req_batch_asks"); n != 3 {
		t.Fatalf("members: %d", n)
	}
	// Dropping needs the human's proof, with or without the shared token beside it; an agent is refused even with it,
	// and the shared token's x-stam-human proves nothing.
	key := map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1"}
	if rec := f.sendH("POST", "/api/requirements/asks/"+ask+"/drop", agentTok, nil, `{"key":"R-3","if_rev":1}`); rec.Code != 403 {
		t.Errorf("an agent's drop: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("POST", "/api/requirements/asks/"+ask+"/drop", agentTok, key, `{"key":"R-3","if_rev":1}`); rec.Code != 403 {
		t.Errorf("an agent's drop with the human's proof: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{method: "POST", path: "/api/requirements/asks/" + ask + "/drop", header: map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1", "X-Stam-Local": "1"}, body: `{"key":"R-3","if_rev":1}`}); rec.Code != 403 {
		t.Errorf("the human's proof with x-stam-local and no token: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("POST", "/api/requirements/asks/"+ask+"/drop", sharedTok, map[string]string{"X-Stam-Human": "1"}, `{"key":"R-3","if_rev":1}`); rec.Code != 403 {
		t.Errorf("the shared token's drop: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("POST", "/api/requirements/asks/"+ask+"/drop", sharedTok, key, `{"key":"R-3","if_rev":1}`); rec.Code != 200 {
		t.Fatalf("the human's drop with the shared token: %d %s", rec.Code, rec.Body.String())
	}
	// One draft changes after the batch was shown: Approve approves none and asks again.
	f.sql("UPDATE requirements SET rev = rev + 1 WHERE key = 'R-2'")
	if rec := f.approve(ask); rec.Code != 200 {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the ask raised again", func() bool { return f.itsaStatus(ask) == "needs_approval" })
	for _, k := range []string{"R-1", "R-2", "R-3"} {
		if got := f.reqStatus(k); got != "draft" {
			t.Errorf("%s after a stale batch: %s", k, got)
		}
	}
	// Restamped by the refresh, a second Approve takes the two left.
	if rec := f.approve(ask); rec.Code != 200 {
		t.Fatalf("approve again: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the batch closed", func() bool { return f.itsaStatus(ask) == "done" })
	for k, want := range map[string]string{"R-1": "in_force", "R-2": "in_force", "R-3": "draft"} {
		if got := f.reqStatus(k); got != want {
			t.Errorf("%s: %s, want %s", k, got, want)
		}
	}
}

// An Approve and a drop that race leave the batch consistent: a drop that answers 200 came first and its draft stays out; an
// Approve that came first leaves the drop refused. A dropped draft is never in force (TS has no such outcome).
func TestRequirementApprovalApproveDropRace(t *testing.T) {
	for i := 0; i < 12; i++ {
		f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
		writeFile(t, f.home+"/settings.json", approvalSettings)
		rec := f.sendH("POST", "/api/requirements/batch", agentTok, nil, `{"requirements":[{"title":"A"},{"title":"B"}]}`)
		a, _ := f.body(rec).Get("approval")
		ask := a.Text("itsa")
		start := make(chan struct{})
		var wg sync.WaitGroup
		var dropCode int
		wg.Add(2)
		rev := f.body(f.post2("GET", "/api/itsas/"+ask, "")).Text("rev")
		go func() {
			defer wg.Done()
			<-start
			f.post2("POST", "/api/itsas/"+ask+"/act", `{"action":"approve","if_rev":"`+rev+`"}`)
		}()
		go func() {
			defer wg.Done()
			<-start
			dropCode = f.asHuman("POST", "/api/requirements/asks/"+ask+"/drop", `{"key":"R-2","if_rev":1}`).Code
		}()
		close(start)
		wg.Wait()
		until(t, "the ask settled", func() bool { return f.itsaStatus(ask) == "done" || f.itsaStatus(ask) == "needs_approval" })
		r2 := f.reqStatus("R-2")
		dropped := f.count("SELECT count(*) FROM req_batch_asks WHERE req_key = 'R-2' AND dropped = 1")
		if dropCode == 200 && (r2 == "in_force" || dropped != 1) {
			t.Errorf("run %d: the drop answered 200 but R-2 is %s (dropped rows %d)", i, r2, dropped)
		}
		if r2 == "in_force" && dropCode == 200 {
			t.Errorf("run %d: R-2 in force after a drop answered 200", i)
		}
		if r2 == "draft" && dropCode != 200 {
			t.Errorf("run %d: R-2 stayed a draft but the drop answered %d", i, dropCode)
		}
	}
}

// A drop that lands after the Approve was pressed and before it acts takes its draft out: Approve puts the rest in force.
func TestRequirementApprovalDropBeforeApprove(t *testing.T) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	writeFile(t, f.home+"/settings.json", approvalSettings)
	rec := f.sendH("POST", "/api/requirements/batch", agentTok, nil, `{"requirements":[{"title":"A"},{"title":"B"}]}`)
	a, _ := f.body(rec).Get("approval")
	ask := a.Text("itsa")
	f.srv.beforeApprove = func() {
		if rec := f.asHuman("POST", "/api/requirements/asks/"+ask+"/drop", `{"key":"R-2","if_rev":1}`); rec.Code != 200 {
			t.Errorf("drop: %d %s", rec.Code, rec.Body.String())
		}
	}
	if rec := f.approve(ask); rec.Code != 200 {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the ask closed", func() bool { return f.itsaStatus(ask) == "done" })
	if f.reqStatus("R-1") != "in_force" || f.reqStatus("R-2") != "draft" {
		t.Errorf("R-1 %s, R-2 %s", f.reqStatus("R-1"), f.reqStatus("R-2"))
	}
}

// An Approve applies to the text the human saw: a draft the author edits after the action, before it acts, is not approved and
// the ask is raised again with the new text.
func TestRequirementApprovalEditAfterAct(t *testing.T) {
	for _, batch := range []bool{false, true} {
		f := newFixture(t, nil)
		writeFile(t, f.home+"/settings.json", approvalSettings)
		var ask string
		if batch {
			rec := f.sendH("POST", "/api/requirements/batch", agentTok, nil, `{"requirements":[{"title":"A"},{"title":"B"}]}`)
			a, _ := f.body(rec).Get("approval")
			ask = a.Text("itsa")
		} else {
			_, ask = f.draftBy(agentTok, `{"title":"Agent draft"}`)
		}
		f.srv.beforeApprove = func() {
			if rec := f.sendH("PATCH", "/api/requirements/R-1", agentTok, nil, `{"text":"Changed after the click"}`); rec.Code != 200 {
				t.Errorf("edit: %d %s", rec.Code, rec.Body.String())
			}
		}
		if rec := f.approve(ask); rec.Code != 200 {
			t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
		}
		until(t, "the ask raised again", func() bool {
			return f.itsaStatus(ask) == "needs_approval" && f.count("SELECT count(*) FROM mail m JOIN itsas i ON i.thread_id = m.thread_id WHERE i.key = ? AND m.body LIKE '%Changed after the click%'", ask) > 0
		})
		keys := []string{"R-1"}
		if batch {
			keys = append(keys, "R-2")
		}
		for _, k := range keys {
			if got := f.reqStatus(k); got == "in_force" {
				t.Errorf("batch %v: %s is in force", batch, k)
			}
		}
	}
}

// Only the Approve action approves: an Approve that comes back stale re-asks and approves nothing, and a plain move out of
// needs_approval after it puts nothing in force either (the stale Approve's action does not linger).
func TestRequirementApprovalOnlyTheAction(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, f.home+"/settings.json", approvalSettings)
	key, ask := f.draftBy(agentTok, `{"title":"Agent draft"}`)
	var acts int
	var mu sync.Mutex
	var wg sync.WaitGroup
	f.srv.startApprove = func() { wg.Add(1) }
	f.srv.afterApprove = wg.Done
	f.srv.beforeApprove = func() {
		mu.Lock()
		acts++
		first := acts == 1
		mu.Unlock()
		if first {
			if rec := f.sendH("PATCH", "/api/requirements/"+key, agentTok, nil, `{"text":"Changed after the click"}`); rec.Code != 200 {
				t.Errorf("edit: %d %s", rec.Code, rec.Body.String())
			}
		}
	}
	if rec := f.approve(ask); rec.Code != 200 {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the stale Approve re-asks", func() bool {
		return f.itsaStatus(ask) == "needs_approval" && f.count("SELECT count(*) FROM mail m JOIN itsas i ON i.thread_id = m.thread_id WHERE i.key = ? AND m.body LIKE '%Changed after the click%'", ask) > 0
	})
	if got := f.reqStatus(key); got != "draft" {
		t.Fatalf("after the stale Approve: %s", got)
	}
	for _, to := range []string{"in_progress", "needs_approval", "canceled"} {
		if rec := f.post2("PATCH", "/api/itsas/"+ask, `{"status":"`+to+`"}`); rec.Code != 200 {
			t.Fatalf("move to %s: %d %s", to, rec.Code, rec.Body.String())
		}
	}
	// Every handler a move started is counted when it starts (on the request) and ends in afterApprove: once they have all ended, only
	// the stale Approve's has acted.
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if acts != 1 {
		t.Errorf("%d approvals acted, want only the stale Approve", acts)
	}
	if got := f.reqStatus(key); got != "draft" {
		t.Errorf("a plain move approved: %s", got)
	}
}

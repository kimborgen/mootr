package server

import (
	"context"
	"errors"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// eventsFixture is a fixture with a token for aboss as well, a working aboss and an idle achild, and the fold window long
// enough that only Flush delivers.
func eventsFixture(t *testing.T) (*fixture, *[]string) {
	t.Helper()
	f := newFixture(t, map[string]string{"STAM_EVENT_FOLD_MS": "3600000"})
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'aboss'", auth.Hash(bossTok))
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'working' WHERE id = 'aboss'")
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'idle' WHERE id = 'achild'")
	var notices []string
	f.srv.noticeHook = func(id, text string) { notices = append(notices, id+"|"+text) }
	t.Cleanup(f.srv.events.Close)
	return f, &notices
}

func (f *fixture) subscribe(token, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	if token == "" {
		return f.post2("POST", "/api/subscriptions", body)
	}
	return f.sendH("POST", "/api/subscriptions", token, nil, body)
}

func TestEventsPostAndList(t *testing.T) {
	f, _ := eventsFixture(t)
	ev := `{"source":"github","type":"pull_request.opened","subjects":["github:o/r#1"],"subject":"github:o/r#1","actor":"octocat","url":"https://x/1","summary":" opened one ","dedupe_key":"d1","payload":{"at":"2026-10-14T16:44:00Z"}}`
	rec := f.post2("POST", "/api/events", ev)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	got := f.body(rec)
	e, _ := got.Get("event")
	if e.Text("summary") != "opened one" || e.Text("actor") != "octocat" {
		t.Errorf("%s", rec.Body.String())
	}
	if s, _ := e.Get("subjects"); len(s.Items) != 1 {
		t.Errorf("a subject named twice is stored once: %s", rec.Body.String())
	}
	// The key order TS's JSON.stringify gives the event.
	if !strings.Contains(rec.Body.String(), `{"stored":true,"event":{"id":1,"source":"github","type":"pull_request.opened","subjects":["github:o/r#1"],"actor":"octocat","url":"https://x/1","summary":"opened one","payload":{"at":"2026-10-14T16:44:00Z"},"dedupe_key":"d1","created_at":"`) {
		t.Errorf("shape: %s", rec.Body.String())
	}
	if rec := f.post2("POST", "/api/events", ev); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"stored":false,"matched":0}` {
		t.Errorf("a duplicate: %d %s", rec.Code, rec.Body.String())
	}
	for _, tc := range []struct{ body, want string }{
		{`{"type":"x","dedupe_key":"k"}`, "an event needs a source"},
		{`{"source":"github","dedupe_key":"k"}`, "an event needs a type"},
		{`{"source":"github","type":"x"}`, "an event needs a dedupe_key"},
		{`{"source":"github","type":"x","dedupe_key":"k","subjects":5}`, "not a list"},
	} {
		if rec := f.post2("POST", "/api/events", tc.body); rec.Code != 400 || !strings.Contains(errorOf(t, rec), tc.want) {
			t.Errorf("%s: %d %s", tc.body, rec.Code, rec.Body.String())
		}
	}
	// An agent's token posts no event and reads none: a forged event would have stam post into the ITSAs it subscribes.
	if rec := f.sendH("POST", "/api/events", agentTok, nil, ev); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "an agent's token can't post external events") {
		t.Errorf("an agent's post: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("GET", "/api/events", agentTok, nil, ""); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "an agent's token can't read the event log") {
		t.Errorf("an agent's read: %d %s", rec.Code, rec.Body.String())
	}
	f.post2("POST", "/api/events", `{"source":"github","type":"x","subjects":["github:o/r#2"],"dedupe_key":"d2"}`)
	list := f.body(f.post2("GET", "/api/events", ""))
	if len(list.Items) != 2 || list.Items[0].Text("dedupe_key") != "d2" {
		t.Errorf("the log lists newest first: %v", list.Items)
	}
	if p, _ := list.Items[0].Get("payload"); p.Kind != jsfmt.Null {
		t.Errorf("an event with no payload lists %v", p)
	}
	if got := f.body(f.post2("GET", "/api/events?subject=github:o/r%231", "")); len(got.Items) != 1 {
		t.Errorf("the subject filter: %d", len(got.Items))
	}
	for q, n := range map[string]int{"?limit=1": 1, "?limit=abc": 2, "?limit=0": 2, "?limit=-5": 1, "?limit=500000": 2} {
		if got := f.body(f.post2("GET", "/api/events"+q, "")); len(got.Items) != n {
			t.Errorf("%s: %d events, want %d", q, len(got.Items), n)
		}
	}
}

// Who may subscribe whom is the route's rule, whoever calls it: the MCP tool, the CLI, a peer or the web UI.
func TestSubscribeAuthorization(t *testing.T) {
	f, _ := eventsFixture(t)
	mine := f.createItsa(`{"title":"mine","owner":"child"}`)
	theirs := f.createItsa(`{"title":"theirs","owner":"boss"}`)
	sharedFilter := `"filter":{"source":"github"}`
	for _, tc := range []struct {
		name, token, body string
		status            int
		contains          string
	}{
		{"an agent subscribes itself", agentTok, `{"subscriber_kind":"agent","subscriber_id":"achild",` + sharedFilter + `}`, 200, `"created_by":"achild"`},
		{"by its name", agentTok, `{"subscriber_kind":"agent","subscriber_id":"child",` + sharedFilter + `}`, 200, `"subscriber_id":"achild"`},
		{"its parent", agentTok, `{"subscriber_kind":"agent","subscriber_id":"aboss",` + sharedFilter + `}`, 403, "child may not subscribe that agent"},
		{"an ITSA it owns", agentTok, `{"subscriber_kind":"itsa","subscriber_id":"` + mine + `",` + sharedFilter + `}`, 200, `"subscriber_kind":"itsa"`},
		{"an ITSA it has no part in", agentTok, `{"subscriber_kind":"itsa","subscriber_id":"` + theirs + `",` + sharedFilter + `}`, 403, "child may not subscribe that itsa"},
		{"the human", agentTok, `{"subscriber_kind":"human","subscriber_id":"human",` + sharedFilter + `}`, 403, "child may not subscribe that human"},
		{"claiming to be another agent", agentTok, `{"subscriber_kind":"agent","subscriber_id":"aboss","by":"aboss",` + sharedFilter + `}`, 403, "can't act as aboss"},
		{"claiming to be the human", agentTok, `{"subscriber_kind":"human","subscriber_id":"human","by":"human",` + sharedFilter + `}`, 403, "can't act as human"},
		{"a manager subscribes its child", bossTok, `{"subscriber_kind":"agent","subscriber_id":"achild",` + sharedFilter + `}`, 200, `"created_by":"aboss"`},
		{"a manager subscribes its archived child", bossTok, `{"subscriber_kind":"agent","subscriber_id":"agone",` + sharedFilter + `}`, 400, "no agent agone"},
		{"the human subscribes an archived agent", "", `{"subscriber_kind":"agent","subscriber_id":"agone",` + sharedFilter + `}`, 400, "no agent agone"},
		{"a manager subscribes the human", bossTok, `{"subscriber_kind":"human","subscriber_id":"human",` + sharedFilter + `}`, 403, "boss may not subscribe that human"},
		{"the human subscribes anything", "", `{"subscriber_kind":"agent","subscriber_id":"achild",` + sharedFilter + `}`, 200, `"created_by":"human"`},
		{"the human, by alias", "", `{"subscriber_kind":"human","subscriber_id":"The Human",` + sharedFilter + `}`, 200, `"subscriber_id":"human"`},
		{"an ITSA as the human", "", `{"subscriber_kind":"itsa","subscriber_id":"` + theirs + `",` + sharedFilter + `}`, 200, `"subscriber_kind":"itsa"`},
		{"a bad kind", "", `{"subscriber_kind":"process","subscriber_id":"x"}`, 400, "subscriber_kind must be one of agent, itsa, human"},
		{"no agent", "", `{"subscriber_kind":"agent","subscriber_id":"zzz"}`, 400, "no agent zzz"},
		{"no ITSA", "", `{"subscriber_kind":"itsa","subscriber_id":"S-99999"}`, 400, "no ITSA S-99999"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := f.subscribe(tc.token, tc.body)
			if rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.contains) {
				t.Errorf("%d %s", rec.Code, rec.Body.String())
			}
		})
	}
	// A subscription that was refused wrote nothing: only the ones answered 200 are stored.
	if n := f.count("SELECT COUNT(*) FROM event_subscriptions"); n != 7 {
		t.Errorf("%d subscriptions stored", n)
	}
}

func TestSubscribeFieldsAreSanitized(t *testing.T) {
	f, _ := eventsFixture(t)
	before := time.Now().UnixMilli()
	rec := f.subscribe("", `{"subscriber_kind":"agent","subscriber_id":"achild","note":"  PR watch ","expires_in_minutes":5,"filter":{"source":" github ","subjects":"github:o/*","types":["a","","b"],"junk":1,"since":" 2026-01-01T00:00:00Z "}}`)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	got := f.body(rec)
	if want := `{"source":"github","subjects":["github:o/*"],"types":["a","b"],"since":"2026-01-01T00:00:00Z"}`; !strings.Contains(rec.Body.String(), `"filter":`+want) {
		t.Errorf("filter: %s", rec.Body.String())
	}
	if got.Text("note") != "PR watch" || !strings.HasPrefix(got.Text("id"), "es-") || len(got.Text("id")) != 13 {
		t.Errorf("%s", rec.Body.String())
	}
	if n := f.count("SELECT COUNT(*) FROM event_subscriptions WHERE expires_at BETWEEN ? AND ?", before+5*60_000, time.Now().UnixMilli()+5*60_000); n != 1 {
		t.Errorf("expires_in_minutes was not turned into expires_at")
	}
	if rec := f.subscribe("", `{"subscriber_kind":"agent","subscriber_id":"achild","expires_at":1234}`); !strings.Contains(rec.Body.String(), `"expires_at":1234`) {
		t.Errorf("%s", rec.Body.String())
	}
}

func TestListAndRemoveSubscriptions(t *testing.T) {
	f, _ := eventsFixture(t)
	own := f.body(f.subscribe(agentTok, `{"subscriber_kind":"agent","subscriber_id":"achild","filter":{"source":"github"}}`)).Text("id")
	byBoss := f.body(f.subscribe(bossTok, `{"subscriber_kind":"agent","subscriber_id":"achild","filter":{"source":"linear"}}`)).Text("id")
	bossOwn := f.body(f.subscribe(bossTok, `{"subscriber_kind":"agent","subscriber_id":"aboss","filter":{"source":"slack"}}`)).Text("id")
	list := func(token, query string) []string {
		var rec *httptest.ResponseRecorder
		if token == "" {
			rec = f.post2("GET", "/api/subscriptions"+query, "")
		} else {
			rec = f.sendH("GET", "/api/subscriptions"+query, token, nil, "")
		}
		if rec.Code != 200 {
			t.Fatalf("list as %s: %d %s", token, rec.Code, rec.Body.String())
		}
		var ids []string
		for _, s := range f.body(rec).Items {
			ids = append(ids, s.Text("id"))
		}
		return ids
	}
	if got := list("", ""); len(got) != 3 {
		t.Errorf("the human sees all: %v", got)
	}
	// An agent sees what it made and what names it: achild's own and the one its manager made for it, not the manager's.
	if got := list(agentTok, ""); strings.Join(got, ",") != own+","+byBoss {
		t.Errorf("achild sees %v", got)
	}
	if got := list(bossTok, ""); strings.Join(got, ",") != byBoss+","+bossOwn {
		t.Errorf("aboss sees %v", got)
	}
	if rec := f.sendH("GET", "/api/subscriptions?by=aboss", agentTok, nil, ""); rec.Code != 403 {
		t.Errorf("an agent lists as another: %d %s", rec.Code, rec.Body.String())
	}
	// Removal: the creator, the subscriber, a manager of the subscriber's tree, and the human; not an unrelated agent.
	del := func(token, id, body string) *httptest.ResponseRecorder {
		if token == "" {
			return f.post2("DELETE", "/api/subscriptions/"+id, body)
		}
		return f.sendH("DELETE", "/api/subscriptions/"+id, token, nil, body)
	}
	if rec := del(agentTok, bossOwn, ""); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "child may not remove that subscription") {
		t.Errorf("an unrelated agent removes: %d %s", rec.Code, rec.Body.String())
	}
	if rec := del(agentTok, byBoss, ""); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"removed":"`+byBoss+`"}` {
		t.Errorf("the subscriber removes: %d %s", rec.Code, rec.Body.String())
	}
	if rec := del(bossTok, own, ""); rec.Code != 200 {
		t.Errorf("a manager removes its child's: %d %s", rec.Code, rec.Body.String())
	}
	if rec := del(bossTok, "es-nothing", ""); rec.Code != 404 || !strings.Contains(errorOf(t, rec), "no subscription es-nothing") {
		t.Errorf("unknown: %d %s", rec.Code, rec.Body.String())
	}
	if rec := del("", "bad.id", ""); rec.Code != 404 || !strings.Contains(errorOf(t, rec), "no route") {
		t.Errorf("a bad id: %d %s", rec.Code, rec.Body.String())
	}
	if rec := del("", bossOwn, ""); rec.Code != 200 {
		t.Errorf("the human removes: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT COUNT(*) FROM event_subscriptions"); n != 0 {
		t.Errorf("%d left", n)
	}
}

func TestRemovedSubscriptionLosesItsFoldedDelivery(t *testing.T) {
	f, notices := eventsFixture(t)
	id := f.body(f.subscribe("", `{"subscriber_kind":"agent","subscriber_id":"aboss","filter":{"source":"github"}}`)).Text("id")
	f.post2("POST", "/api/events", `{"source":"github","type":"x","dedupe_key":"d1","summary":"queued"}`)
	if f.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 1 {
		t.Fatal("the line is not queued")
	}
	if rec := f.post2("DELETE", "/api/subscriptions/"+id, ""); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	must(t, f.srv.events.Flush(context.Background()))
	if f.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evq:%'") != 0 || len(*notices) != 0 {
		t.Errorf("a removed subscription delivered: %v", *notices)
	}
}

// Delivery through the real send path: a notice for a working agent, mail for an idle one, one thread for the human, and a
// quiet post for an ITSA.
func TestEventDeliveryThroughTheServer(t *testing.T) {
	f, notices := eventsFixture(t)
	f.subscribe("", `{"subscriber_kind":"agent","subscriber_id":"aboss","filter":{"source":"github","subjects":["github:o/*"]}}`)
	f.subscribe("", `{"subscriber_kind":"agent","subscriber_id":"achild","filter":{"source":"github"},"note":"watching o"}`)
	f.subscribe("", `{"subscriber_kind":"human","subscriber_id":"human","filter":{"source":"github"}}`)
	key := f.createItsa(`{"title":"Watch the repo","owner":"boss"}`)
	f.subscribe("", `{"subscriber_kind":"itsa","subscriber_id":"`+key+`","filter":{"source":"github"}}`)
	for _, ev := range []string{
		`{"source":"github","type":"pull_request.opened","subjects":["github:o/r#1"],"actor":"octocat","url":"https://x/1","summary":"opened one","dedupe_key":"d1"}`,
		`{"source":"github","type":"pull_request.opened","subjects":["github:o/r#1"],"actor":"octocat","url":"https://x/1","summary":"opened one","dedupe_key":"d1"}`,
		`{"source":"github","type":"pull_request.synchronize","subjects":["github:o/r#1"],"actor":"octocat","url":"https://x/2","summary":"synced one","dedupe_key":"d2"}`,
		`{"source":"github","type":"push","subjects":["github:other/r"],"summary":"elsewhere","dedupe_key":"d3"}`,
	} {
		if rec := f.post2("POST", "/api/events", ev); rec.Code != 200 {
			t.Fatalf("%d %s", rec.Code, rec.Body.String())
		}
	}
	if len(*notices) != 0 || f.count("SELECT COUNT(*) FROM mail WHERE from_id = 'system:watch'") != 0 {
		t.Fatal("something was delivered before the fold window closed")
	}
	must(t, f.srv.events.Flush(context.Background()))
	// aboss works: one notice, with both of its events and not the one outside its subjects.
	if len(*notices) != 1 || !strings.HasPrefix((*notices)[0], "aboss|") {
		t.Fatalf("notices %v", *notices)
	}
	for _, want := range []string{"opened one", "synced one", "https://x/2", "by octocat", "unsubscribe es-"} {
		if !strings.Contains((*notices)[0], want) {
			t.Errorf("the notice lacks %q: %s", want, (*notices)[0])
		}
	}
	if strings.Contains((*notices)[0], "elsewhere") {
		t.Error("an event outside the filter was delivered")
	}
	// achild is idle: one folded mail from stam, its subject naming the note, all three events.
	if got := f.text("SELECT subject FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'achild' AND m.from_id = 'system:watch'"); got != "[stam] 3 watching o events" {
		t.Errorf("achild's mail subject: %q", got)
	}
	if got := f.text("SELECT body FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'achild' AND m.from_id = 'system:watch'"); !strings.Contains(got, "elsewhere") || !strings.Contains(got, "opened one") {
		t.Errorf("achild's mail: %s", got)
	}
	// The human: one mail; a later delivery replies into its thread.
	if f.count("SELECT COUNT(*) FROM mail_recipients WHERE agent_id = 'human'") != 1 {
		t.Fatal("the human got no single mail")
	}
	f.post2("POST", "/api/events", `{"source":"github","type":"x","summary":"later","dedupe_key":"d4"}`)
	must(t, f.srv.events.Flush(context.Background()))
	if got := f.count("SELECT COUNT(DISTINCT thread_id) FROM mail WHERE id IN (SELECT mail_id FROM mail_recipients WHERE agent_id = 'human')"); got != 1 {
		t.Errorf("the human's deliveries are in %d threads", got)
	}
	// The ITSA: posted into its thread as stam, to its agents only.
	if got := f.count("SELECT COUNT(*) FROM mail WHERE body LIKE '%synced one%' AND thread_id = (SELECT thread_id FROM itsas WHERE key = ?)", key); got != 1 {
		t.Errorf("the ITSA's thread holds %d event posts", got)
	}
	if got := f.count("SELECT COUNT(*) FROM mail_recipients WHERE agent_id = 'human' AND mail_id IN (SELECT id FROM mail WHERE thread_id = (SELECT thread_id FROM itsas WHERE key = ?))", key); got != 0 {
		t.Errorf("the human got the ITSA's event post")
	}
	if f.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evq:%'") != 0 {
		t.Error("delivered batches are still queued")
	}
}

func TestLinkSubscriptionsFollowTheItsa(t *testing.T) {
	f, _ := eventsFixture(t)
	subs := func() int {
		return f.count("SELECT COUNT(*) FROM event_subscriptions WHERE created_by = 'stam' AND subscriber_kind = 'itsa'")
	}
	body := f.body(f.post2("POST", "/api/itsas", `{"title":"PR 12","links":[{"url":"https://github.com/o/r/pull/12"}]}`))
	key := body.Text("key")
	if subs() != 1 || f.text("SELECT note FROM event_subscriptions WHERE created_by = 'stam'") != "linked github:o/r#12" {
		t.Fatalf("a link at create makes one subscription: %d", subs())
	}
	if got := f.text("SELECT filter FROM event_subscriptions WHERE created_by = 'stam'"); got != `{"subjects":["github:o/r#12"]}` {
		t.Errorf("filter %s", got)
	}
	// A second link to the same subject, and one to another: still one for each subject.
	f.post2("POST", "/api/itsas/"+key+"/links", `{"url":"https://github.com/o/r/pull/12/files"}`)
	f.post2("POST", "/api/itsas/"+key+"/links", `{"url":"https://linear.app/t/issue/TEAM-4/x"}`)
	if subs() != 2 {
		t.Errorf("%d subscriptions for two subjects", subs())
	}
	// A hand-made subscription on the subject is left alone, and so is the follow of it.
	hand := f.body(f.subscribe("", `{"subscriber_kind":"itsa","subscriber_id":"`+key+`","filter":{"subjects":["github:o/r#99"]}}`)).Text("id")
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"done"}`); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if subs() != 0 || f.count("SELECT COUNT(*) FROM event_subscriptions WHERE id = ?", hand) != 1 {
		t.Errorf("closing: %d stam subscriptions, the hand-made one kept: %d", subs(), f.count("SELECT COUNT(*) FROM event_subscriptions WHERE id = ?", hand))
	}
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"in_progress"}`); rec.Code != 200 || subs() != 2 {
		t.Errorf("reopening: %d %d", rec.Code, subs())
	}
	// Removing a link drops its subject's subscription, and only when no other link names it.
	f.post2("DELETE", "/api/itsas/"+key+"/links/2", "")
	if subs() != 2 {
		t.Errorf("removing one of two links to a subject dropped it: %d", subs())
	}
	f.post2("DELETE", "/api/itsas/"+key+"/links/1", "")
	if subs() != 1 {
		t.Errorf("removing the last link to a subject kept it: %d", subs())
	}
}

// A link that predates the service gets its subscription at start, and the pass is idempotent.
func TestStartEventsSyncsExistingLinks(t *testing.T) {
	f, _ := eventsFixture(t)
	key := f.createItsa(`{"title":"old"}`)
	f.sql("INSERT INTO itsa_links (itsa_id, n, system, external_id, url) SELECT id, 1, 'github', '5', 'https://github.com/o/r/pull/5' FROM itsas WHERE key = ?", key)
	for i := 0; i < 2; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		f.srv.StartEvents(ctx)
		cancel()
		f.srv.WaitBackground()
		f.srv.bgMu.Lock()
		f.srv.bgWaited = false
		f.srv.bgMu.Unlock()
		if n := f.count("SELECT COUNT(*) FROM event_subscriptions WHERE note = 'linked github:o/r#5'"); n != 1 {
			t.Fatalf("pass %d: %d subscriptions", i, n)
		}
		f.srv.events = f.srv.newEventsService()
	}
}

func TestEventWaitThroughTheRoutes(t *testing.T) {
	f, notices := eventsFixture(t)
	withLifeRoot(f, "../../..")
	declare := func(body string) *httptest.ResponseRecorder {
		return f.sendH("POST", "/api/agents/achild/waits/declared", agentTok, nil, body)
	}
	if rec := declare(`{"on":"event","filter":{}}`); rec.Code != 400 || !strings.Contains(errorOf(t, rec), "wait_for on 'event' needs a filter") {
		t.Errorf("an empty filter: %d %s", rec.Code, rec.Body.String())
	}
	if rec := declare(`{"on":"event","filter":{"exclude_actors":["bot"]}}`); rec.Code != 400 {
		t.Errorf("only an exclusion: %d %s", rec.Code, rec.Body.String())
	}
	rec := declare(`{"on":"event","filter":{"source":"github","subjects":["github:o/r#12"]},"note":"CI on PR 12","timeout_minutes":30}`)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	w := f.body(rec)
	if w.Text("kind") != "event" || w.Text("source") != "declared" || w.Text("detail") != "CI on PR 12" || !strings.HasPrefix(w.Text("id"), "w") || w.Text("until") == "" {
		t.Errorf("%s", rec.Body.String())
	}
	if rec2 := declare(`{"on":"event","filter":{"subjects":["github:o/r#12"],"source":"github"},"note":"CI on PR 12"}`); f.body(rec2).Text("id") != w.Text("id") || f.count("SELECT COUNT(*) FROM waits WHERE kind = 'event'") != 1 {
		t.Errorf("the same wait declared again piled up")
	}
	if got := f.text("SELECT activity FROM agents WHERE id = 'achild'"); got != "waiting" {
		t.Errorf("the agent is %s", got)
	}
	// rest is still refused, before any write.
	if rec := declare(`{"on":"event","rest":true,"filter":{"source":"github"}}`); rec.Code != 501 {
		t.Errorf("rest: %d %s", rec.Code, rec.Body.String())
	}
	f.post2("POST", "/api/events", `{"source":"github","type":"check_run","subjects":["github:o/r#13"],"summary":"another PR","dedupe_key":"n1"}`)
	if f.count("SELECT COUNT(*) FROM waits WHERE kind = 'event'") != 1 {
		t.Fatal("an event outside the filter cleared the wait")
	}
	f.post2("POST", "/api/events", `{"source":"github","type":"check_run.completed","subjects":["github:o/r#12"],"url":"https://gh/12","summary":"CI passed","dedupe_key":"m1"}`)
	if f.count("SELECT COUNT(*) FROM waits WHERE kind = 'event'") != 0 {
		t.Fatal("the matching event didn't clear the wait")
	}
	if len(*notices) != 1 || !strings.HasPrefix((*notices)[0], "achild|") || !strings.Contains((*notices)[0], "CI on PR 12") || !strings.Contains((*notices)[0], "CI passed") || !strings.Contains((*notices)[0], "https://gh/12") {
		t.Errorf("notices %v", *notices)
	}
	if got := f.text("SELECT activity FROM agents WHERE id = 'achild'"); got == "waiting" {
		t.Errorf("the agent is still waiting after its wait cleared")
	}
	// Nobody else may declare a wait for the agent, as before.
	if rec := f.sendH("POST", "/api/agents/aboss/waits/declared", agentTok, nil, `{"on":"event","filter":{"source":"github"}}`); rec.Code != 403 {
		t.Errorf("another agent's wait: %d %s", rec.Code, rec.Body.String())
	}
}

// ---- round 1 of the review of #1332 ----

// C: forgetting an agent through the route drops its subscriptions, queues and wait notices, as an archive does.
func TestForgetThroughTheRouteDropsEventState(t *testing.T) {
	f, _ := eventsFixture(t)
	withLifeRoot(f, "../../..")
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'acodex'")
	rec := f.subscribe("", `{"subscriber_kind":"agent","subscriber_id":"acodex","filter":{"source":"github"}}`)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	sub := f.body(rec).Text("id")
	f.post2("POST", "/api/events", `{"source":"github","type":"x","summary":"queued","dedupe_key":"c1"}`)
	f.sql(`INSERT INTO kv (key, value) VALUES ('evw:w-forgot', '{"agent":"acodex","text":"a notice"}')`)
	if f.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+sub) != 1 {
		t.Fatal("setup: the batch is queued")
	}
	rec = f.do(call{method: "POST", path: "/api/agents/acodex/forget", token: sharedTok})
	if rec.Code != 200 {
		t.Fatalf("forget: %d %s", rec.Code, rec.Body.String())
	}
	for _, q := range []string{
		"SELECT COUNT(*) FROM event_subscriptions WHERE subscriber_id = 'acodex'",
		"SELECT COUNT(*) FROM kv WHERE key = 'evq:" + sub + "'",
		"SELECT COUNT(*) FROM kv WHERE key = 'evw:w-forgot'",
	} {
		if f.count(q) != 0 {
			t.Errorf("after the forget: %s", q)
		}
	}
}

// A real delivery's mail and the removal of its lines are one transaction: a queue that is gone at the commit stores no
// mail.
func TestDeliveryMailRollsBackWhenItsQueueIsGoneAtTheCommit(t *testing.T) {
	f, _ := eventsFixture(t)
	rec := f.subscribe("", `{"subscriber_kind":"agent","subscriber_id":"achild","filter":{"source":"github"}}`)
	sub := f.body(rec).Text("id")
	f.post2("POST", "/api/events", `{"source":"github","type":"x","summary":"lost queue","dedupe_key":"r1"}`)
	before := f.count("SELECT COUNT(*) FROM mail")
	commit := db.MailCommit(sub, 1, "achild", new(int))
	f.sql("DELETE FROM kv WHERE key = ?", "evq:"+sub)
	_, err := f.srv.send(context.Background(), &sendIn{system: "watch", hasSystem: true, to: []string{"achild"}, subject: "s", body: "b", newThread: true, fromStam: true, inferred: map[string]bool{}, inTx: commit})
	if !errors.Is(err, db.ErrDeliveryStale) {
		t.Fatalf("err %v", err)
	}
	if got := f.count("SELECT COUNT(*) FROM mail"); got != before {
		t.Errorf("%d mails stored by a send whose commit failed", got-before)
	}
	// And one that can commit stores the mail and removes the lines together.
	f.post2("POST", "/api/events", `{"source":"github","type":"x","summary":"kept queue","dedupe_key":"r2"}`)
	var left int
	if _, err := f.srv.send(context.Background(), &sendIn{system: "watch", hasSystem: true, to: []string{"achild"}, subject: "s", body: "b", newThread: true, fromStam: true, inferred: map[string]bool{}, inTx: db.MailCommit(sub, 1, "achild", &left)}); err != nil {
		t.Fatal(err)
	}
	if f.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+sub) != 0 || f.count("SELECT COUNT(*) FROM mail") != before+1 {
		t.Error("the mail and its ack are not one commit")
	}
}

// F: a peer's agent is no local agent. TS's maySubscribe reads the local agents only (src/watch.ts), and a subscription
// for a peer's agent could never be delivered here, so a remembered peer agent is refused as a subscriber, as an actor,
// and as an ancestor that grants a tree. Nothing is stored for a refusal.
func TestSubscriptionsRefusePeerAgents(t *testing.T) {
	f, _ := eventsFixture(t)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle) VALUES ('apeer', 'peer-one', 'other', '2026-10-28T00:00:00.000Z', 'active')")
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle) VALUES ('apeer2', 'peer-two', 'other', '2026-10-28T00:00:00.000Z', 'active')")
	for _, tc := range []struct {
		what, token, body string
		status            int
	}{
		{"the human for a peer's agent", "", `{"subscriber_kind":"agent","subscriber_id":"apeer","filter":{"source":"github"}}`, 400},
		{"the human for a peer's agent by name", "", `{"subscriber_kind":"agent","subscriber_id":"peer-one","filter":{"source":"github"}}`, 400},
		{"a local agent for a peer's agent", bossTok, `{"subscriber_kind":"agent","subscriber_id":"apeer","by":"aboss","filter":{"source":"github"}}`, 400},
		{"a peer's agent for a local one", agentTok, `{"subscriber_kind":"agent","subscriber_id":"aboss","by":"apeer","filter":{"source":"github"}}`, 403},
		{"a peer's agent for itself (the token is a local agent's)", agentTok, `{"subscriber_kind":"agent","subscriber_id":"apeer","by":"apeer","filter":{"source":"github"}}`, 403},
		{"a peer's agent for the human", agentTok, `{"subscriber_kind":"human","subscriber_id":"human","by":"apeer","filter":{"source":"github"}}`, 403},
	} {
		rec := f.subscribe(tc.token, tc.body)
		if rec.Code != tc.status {
			t.Errorf("%s: %d %s, want %d", tc.what, rec.Code, rec.Body.String(), tc.status)
		}
	}
	if n := f.count("SELECT COUNT(*) FROM event_subscriptions"); n != 0 {
		t.Errorf("%d subscriptions stored by refusals", n)
	}
}

// pauseWithCompetitor makes db.TestHookSubCheck start `run` (a write of its own) and hold the transaction until `run` is
// in the writer's queue behind it (WaitingWrites counts a caller from the moment it is queued, and the lock goes to the
// queue in order, so nothing a split transaction does afterwards can pass it). It returns what to wait on after the
// request, and whether the competitor was ever seen queued.
func pauseWithCompetitor(t *testing.T, d *db.DB, run func()) (done chan struct{}, queued *bool) {
	t.Helper()
	done, queued = make(chan struct{}), new(bool)
	t.Cleanup(func() { db.TestHookSubCheck = nil })
	db.TestHookSubCheck = func() {
		base := d.WaitingWrites()
		go func() { defer close(done); run() }()
		for i := 0; i < 50_000_000 && d.WaitingWrites() <= base; i++ {
			runtime.Gosched()
		}
		*queued = d.WaitingWrites() > base
	}
	return done, queued
}

// The check and the row are one transaction: a write issued between them (a reparent, a participant removal, an archive)
// waits for the commit, so it finds the row and the check holds for it. Each case holds the transaction open right after
// the check until the competing write is queued behind it, then lets it go; the competitor records whether the
// subscription was there when it ran. Split the transaction and it is not (go/mutants/s4317-events.py, subsplit).
func TestSubscriptionCheckAndInsertAreOneTransaction(t *testing.T) {
	for _, tc := range []struct {
		name, token, sql string
		body             func(itsa string) string
		// gone: the write is one that ForgetAgentEvents must still clean up after
		gone bool
	}{
		{"a reparent", bossTok, "UPDATE agents SET parent_id = NULL WHERE id = 'achild'; DELETE FROM agent_parents WHERE child_id = 'achild'",
			func(string) string {
				return `{"subscriber_kind":"agent","subscriber_id":"achild","filter":{"source":"github"}}`
			}, false},
		{"a participant removal", agentTok, "UPDATE itsa_participants SET left_at = '2026-10-28T12:00:00.000Z' WHERE agent_id = 'achild'",
			func(itsa string) string {
				return `{"subscriber_kind":"itsa","subscriber_id":"` + itsa + `","filter":{"source":"github"}}`
			}, false},
		{"an archive", "", "UPDATE agents SET lifecycle = 'archived' WHERE id = 'achild'",
			func(string) string {
				return `{"subscriber_kind":"agent","subscriber_id":"achild","filter":{"source":"github"}}`
			}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, _ := eventsFixture(t)
			itsa := f.createItsa(`{"title":"theirs","owner":"boss"}`)
			f.sql("INSERT OR IGNORE INTO itsa_participants (itsa_id, agent_id) VALUES ((SELECT id FROM itsas WHERE key = ?), 'achild')", itsa)
			sawRow := -1
			done, queued := pauseWithCompetitor(t, f.srv.db, func() {
				_ = f.srv.db.Write(context.Background(), func(conn *sqlite.Conn) error {
					if err := sqlitex.ExecuteScript(conn, tc.sql, nil); err != nil {
						return err
					}
					return sqlitex.Execute(conn, "SELECT COUNT(*) FROM event_subscriptions", &sqlitex.ExecOptions{ResultFunc: func(s *sqlite.Stmt) error { sawRow = s.ColumnInt(0); return nil }})
				})
			})
			rec := f.subscribe(tc.token, tc.body(itsa))
			if rec.Code != 200 {
				t.Fatalf("%d %s", rec.Code, rec.Body.String())
			}
			<-done
			if !*queued {
				t.Fatal("the competing write never queued behind the transaction")
			}
			if sawRow != 1 {
				t.Fatalf("the write ran with %d subscriptions stored: it committed between the check and the insert", sawRow)
			}
			if tc.gone {
				// What the archive does next: its cleanup finds the row, because the row was there first.
				if _, err := f.srv.db.ForgetAgentEvents(context.Background(), "achild"); err != nil {
					t.Fatal(err)
				}
				if n := f.count("SELECT COUNT(*) FROM event_subscriptions"); n != 0 {
					t.Errorf("%d subscriptions outlive the archive", n)
				}
			}
		})
	}
}

// A removal is checked and deleted in one transaction too: a reparent or an archive queued behind it finds the
// subscription already gone, so the manager was still one when it was removed.
func TestSubscriptionRemovalCheckAndDeleteAreOneTransaction(t *testing.T) {
	for _, tc := range []struct{ name, sql string }{
		{"a reparent", "UPDATE agents SET parent_id = NULL WHERE id = 'achild'; DELETE FROM agent_parents WHERE child_id = 'achild'"},
		{"an archive", "UPDATE agents SET lifecycle = 'archived' WHERE id = 'aboss'"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, _ := eventsFixture(t)
			id := f.body(f.subscribe("", `{"subscriber_kind":"agent","subscriber_id":"achild","filter":{"source":"github"}}`)).Text("id")
			sawRow := -1
			done, queued := pauseWithCompetitor(t, f.srv.db, func() {
				_ = f.srv.db.Write(context.Background(), func(conn *sqlite.Conn) error {
					if err := sqlitex.ExecuteScript(conn, tc.sql, nil); err != nil {
						return err
					}
					return sqlitex.Execute(conn, "SELECT COUNT(*) FROM event_subscriptions", &sqlitex.ExecOptions{ResultFunc: func(s *sqlite.Stmt) error { sawRow = s.ColumnInt(0); return nil }})
				})
			})
			if rec := f.sendH("DELETE", "/api/subscriptions/"+id, bossTok, nil, ""); rec.Code != 200 {
				t.Fatalf("%d %s", rec.Code, rec.Body.String())
			}
			<-done
			if !*queued {
				t.Fatal("the competing write never queued behind the transaction")
			}
			if sawRow != 0 {
				t.Fatalf("the write ran with %d subscriptions stored: it committed between the check and the delete", sawRow)
			}
		})
	}
}

// An archived actor can't remove a subscription, its own included: the row and its folded delivery stay.
func TestArchivedActorCannotRemoveASubscription(t *testing.T) {
	f, _ := eventsFixture(t)
	itsa := f.createItsa(`{"title":"theirs","owner":"achild"}`)
	byHuman := f.body(f.subscribe("", `{"subscriber_kind":"agent","subscriber_id":"achild","filter":{"source":"github"}}`)).Text("id")
	onItsa := f.body(f.subscribe("", `{"subscriber_kind":"itsa","subscriber_id":"`+itsa+`","filter":{"source":"github"}}`)).Text("id")
	own := f.body(f.subscribe(agentTok, `{"subscriber_kind":"agent","subscriber_id":"achild","filter":{"source":"linear"}}`)).Text("id")
	for _, id := range []string{byHuman, onItsa, own} {
		f.sql("INSERT INTO kv (key, value) VALUES (?, '{}')", "evq:"+id)
	}
	f.sql("UPDATE agents SET lifecycle = 'archived' WHERE id = 'achild'")
	ctx := context.Background()
	for _, id := range []string{byHuman, onItsa, own} {
		removed, allowed, err := f.srv.db.RemoveSubscriptionBy(ctx, id, "achild", "")
		if err != nil || allowed || removed {
			t.Errorf("%s: removed %v, allowed %v, %v", id, removed, allowed, err)
		}
	}
	if n := f.count("SELECT COUNT(*) FROM event_subscriptions"); n != 3 {
		t.Errorf("%d subscriptions left, want 3", n)
	}
	if n := f.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evq:%'"); n != 3 {
		t.Errorf("%d queues left, want 3", n)
	}
}

// Once the write has committed, the same request is refused: the reparent, the participant removal and the archive
// each leave nothing stored.
func TestSubscriptionRefusedAfterTheChangeCommits(t *testing.T) {
	f, _ := eventsFixture(t)
	itsa := f.createItsa(`{"title":"theirs","owner":"boss"}`)
	f.sql("INSERT OR IGNORE INTO itsa_participants (itsa_id, agent_id) VALUES ((SELECT id FROM itsas WHERE key = ?), 'achild')", itsa)
	f.sql("UPDATE itsa_participants SET left_at = '2026-10-28T12:00:00.000Z' WHERE agent_id = 'achild'")
	if rec := f.subscribe(agentTok, `{"subscriber_kind":"itsa","subscriber_id":"`+itsa+`","filter":{"source":"github"}}`); rec.Code != 403 {
		t.Errorf("participant removed: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("UPDATE agents SET parent_id = NULL WHERE id = 'achild'")
	f.sql("DELETE FROM agent_parents WHERE child_id = 'achild'")
	if rec := f.subscribe(bossTok, `{"subscriber_kind":"agent","subscriber_id":"achild","filter":{"source":"github"}}`); rec.Code != 403 {
		t.Errorf("reparented: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("UPDATE agents SET lifecycle = 'archived' WHERE id = 'achild'")
	if rec := f.subscribe("", `{"subscriber_kind":"agent","subscriber_id":"achild","filter":{"source":"github"}}`); rec.Code != 400 {
		t.Errorf("archived target: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.subscribe(agentTok, `{"subscriber_kind":"agent","subscriber_id":"achild","filter":{"source":"github"}}`); rec.Code == 200 {
		t.Errorf("archived actor stored a subscription: %s", rec.Body.String())
	}
	if n := f.count("SELECT COUNT(*) FROM event_subscriptions"); n != 0 {
		t.Errorf("%d subscriptions stored", n)
	}
}

// The route resolves the target before the transaction; the transaction must refuse what has gone since, so these call it
// directly: an ITSA that is gone, an agent that is archived or gone, and an actor that is archived.
func TestInsertSubscriptionByRefusesWhatWentAfterTheRouteResolvedIt(t *testing.T) {
	f, _ := eventsFixture(t)
	itsa := f.createItsa(`{"title":"theirs","owner":"achild"}`)
	sub := func(kind, id string) db.Subscription {
		return db.Subscription{ID: "es-0000000001", SubscriberKind: kind, SubscriberID: id, Filter: `{"source":"github"}`, CreatedBy: "x", CreatedAt: "2026-10-28T12:00:00.000Z"}
	}
	ctx := context.Background()
	for _, tc := range []struct {
		name, by string
		sub      db.Subscription
		want     db.SubVerdict
	}{
		{"the human, an ITSA that is gone", "human", sub("itsa", "S-99999"), db.SubNoTarget},
		{"the human, an agent that is gone", "human", sub("agent", "zzz"), db.SubNoTarget},
		{"the human, an archived agent", "human", sub("agent", "agone"), db.SubNoTarget},
		{"a live actor, its own ITSA", "achild", sub("itsa", itsa), db.SubStored},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := f.srv.db.InsertSubscriptionBy(ctx, tc.sub, tc.by, "")
			if err != nil || got != tc.want {
				t.Errorf("verdict %d, %v; want %d", got, err, tc.want)
			}
		})
	}
	f.sql("DELETE FROM event_subscriptions")
	f.sql("UPDATE agents SET lifecycle = 'archived' WHERE id = 'achild'")
	if got, err := f.srv.db.InsertSubscriptionBy(ctx, sub("itsa", itsa), "achild", ""); err != nil || got != db.SubForbidden {
		t.Errorf("an archived actor: verdict %d, %v", got, err)
	}
	if n := f.count("SELECT COUNT(*) FROM event_subscriptions"); n != 0 {
		t.Errorf("%d subscriptions stored", n)
	}
}

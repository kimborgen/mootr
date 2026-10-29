package server

import (
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/auth"
	"stam/internal/jsfmt"
)

// Rings (src/ring.ts): the routes over agents that already exist, the turns queued as notices, and the mail when a ring ends.

func ringFixture(t *testing.T) *fixture {
	t.Helper()
	f := newFixture(t, nil)
	withLife(f)
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'acodex'", auth.Hash(codexTok))
	return f
}

const codexTok = "codex-token-value"

// ringTok is the agent's own token: the shared token can't act as an agent that has one.
func ringTok(id string) string {
	switch id {
	case "aboss":
		return bossTok
	case "achild":
		return agentTok
	case "acodex":
		return codexTok
	}
	return sharedTok
}

func (f *fixture) ringAs(by, path, body string) (int, jsfmt.Value) {
	f.t.Helper()
	rec := f.sendH("POST", path, ringTok(by), nil, body)
	v, _ := jsfmt.Parse(rec.Body.Bytes())
	return rec.Code, v
}

func (f *fixture) ringPost(path, body string) (int, jsfmt.Value) {
	f.t.Helper()
	rec := f.post2("POST", path, body)
	v, _ := jsfmt.Parse(rec.Body.Bytes())
	return rec.Code, v
}

func (f *fixture) newRing(body string) string {
	f.t.Helper()
	code, v := f.ringPost("/api/rings", body)
	if code != 200 {
		f.t.Fatalf("ring: %d %s", code, v.Text("error"))
	}
	return v.Text("id")
}

func (f *fixture) submit(ring, by, text string, extra ...string) (int, string) {
	f.t.Helper()
	body := `{"by":"` + by + `","text":"` + text + `"` + strings.Join(extra, "") + `}`
	code, v := f.ringAs(by, "/api/rings/"+ring+"/submit", body)
	return code, v.Text("result") + v.Text("error")
}

func (f *fixture) turnNotices(agent string) []string { return f.srv.life.Notices(agent) }

func (f *fixture) ringStatus(id string) string {
	return f.text("SELECT status || '|' || round || '|' || turn FROM rings WHERE id = ?", id)
}

func (f *fixture) endedMails() int {
	return f.count("SELECT COUNT(*) FROM mail WHERE subject LIKE 'Ring % ended'")
}

// A rounds ring: every member is prompted, all submit in parallel, the round completes, the next starts, and the last ends the ring
// with one mail to the creator and the members.
func TestRingRounds(t *testing.T) {
	f := ringFixture(t)
	id := f.newRing(`{"name":"r1","format":"rounds","topic":"Is it ok?","members":["aboss","achild"],"max_rounds":2}`)
	if got := f.ringStatus(id); got != "running|1|0" {
		t.Fatalf("status %q", got)
	}
	for _, a := range []string{"aboss", "achild"} {
		n := f.turnNotices(a)
		if len(n) != 1 || !strings.Contains(n[0], `[stam] Ring "r1" (rounds), round 1 of at most 2.`) || !strings.Contains(n[0], "Topic: Is it ok?") || !strings.Contains(n[0], "No submissions yet.") {
			t.Errorf("%s's first turn: %q", a, n)
		}
	}
	if n := f.count("SELECT COUNT(*) FROM events WHERE type = 'ring:joined'"); n != 2 {
		t.Errorf("%d ring:joined events", n)
	}
	if code, msg := f.submit("r1", "aboss", "first view"); code != 200 || msg != "Submitted. Waiting for the other members." {
		t.Errorf("first submit: %d %q", code, msg)
	}
	if code, msg := f.submit("r1", "achild", "second view", `,"agree":false`); code != 200 || msg != "Submitted. The round is complete." {
		t.Errorf("second submit: %d %q", code, msg)
	}
	if got := f.ringStatus(id); got != "running|2|0" {
		t.Errorf("after round 1: %q", got)
	}
	n := f.turnNotices("aboss")
	if len(n) != 2 || !strings.Contains(n[1], "round 2 of at most 2") || !strings.Contains(n[1], "### Round 1, boss\nfirst view") || !strings.Contains(n[1], "### Round 1, child\nsecond view") {
		t.Errorf("round 2 turn: %q", n)
	}
	f.submit("r1", "aboss", "r2 boss", `,"agree":true`)
	f.submit("r1", "achild", "r2 child", `,"agree":true`)
	if got := f.ringStatus(id); got != "done|2|0" {
		t.Errorf("after round 2: %q", got)
	}
	if f.endedMails() != 1 {
		t.Errorf("%d ending mails", f.endedMails())
	}
	body := f.text("SELECT body FROM mail WHERE subject = 'Ring r1 ended'")
	if from := f.text("SELECT from_id FROM mail WHERE subject = 'Ring r1 ended'"); from != "system:ring" {
		t.Errorf("from %s", from)
	}
	if !strings.Contains(body, "ended after round 2: all members agreed.") || !strings.Contains(body, "Final submissions:\n\n### boss\nr2 boss\n\n### child\nr2 child") {
		t.Errorf("the mail: %q", body)
	}
	if code, msg := f.submit("r1", "aboss", "late"); code != 409 || msg != "ring r1 is done" {
		t.Errorf("after the end: %d %q", code, msg)
	}
	// The status routes.
	rec := f.post2("GET", "/api/rings/r1", "")
	v, _ := jsfmt.Parse(rec.Body.Bytes())
	members, _ := v.Get("members")
	subs, _ := v.Get("submissions")
	if rec.Code != 200 || v.Text("status") != "done" || len(members.Items) != 2 || members.Items[0].Str != "boss" || len(subs.Items) != 4 {
		t.Errorf("status route: %d %s", rec.Code, rec.Body.String())
	}
	list, _ := jsfmt.Parse(f.post2("GET", "/api/rings", "").Body.Bytes())
	if len(list.Items) != 1 || list.Items[0].Text("name") != "r1" {
		t.Errorf("list: %v", list)
	}
	if rec := f.post2("GET", "/api/rings/nope", ""); rec.Code != 500 || !strings.Contains(rec.Body.String(), "no ring nope") {
		t.Errorf("a missing ring: %d %s", rec.Code, rec.Body.String())
	}
}

// Two members whose submissions complete a round at once: the check of the round and its move are one transaction, so exactly one of
// them moves it. The first submit is held after its write until the second has started, so the two always overlap: the first sees
// only its own text and waits, the second sees both and completes the round.
func TestRingRoundCompletesOnce(t *testing.T) {
	f := ringFixture(t)
	id := f.newRing(`{"name":"overlap","topic":"t","members":["aboss","achild"],"max_rounds":3}`)
	secondStarted := make(chan struct{})
	firstWrote := make(chan struct{})
	f.srv.ringHooks.entered = func(agent string) {
		if agent == "achild" {
			close(secondStarted)
		}
	}
	f.srv.ringHooks.wrote = func(agent string) {
		if agent != "aboss" {
			return
		}
		close(firstWrote)
		select {
		case <-secondStarted:
		case <-time.After(10 * time.Second):
			t.Error("the second submit never started")
		}
	}
	results := make([]string, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, results[0] = f.submit("overlap", "aboss", "view aboss")
	}()
	select {
	case <-firstWrote:
	case <-time.After(10 * time.Second):
		t.Fatal("the first submit never wrote")
	}
	go func() {
		defer wg.Done()
		_, results[1] = f.submit("overlap", "achild", "view achild")
	}()
	wg.Wait()
	if results[0] != "Submitted. Waiting for the other members." || results[1] != "Submitted. The round is complete." {
		t.Fatalf("results %q", results)
	}
	// One move to round 2: one prompt each, on top of the first.
	if got := f.ringStatus(id); got != "running|2|0" || len(f.turnNotices("aboss")) != 2 || len(f.turnNotices("achild")) != 2 {
		t.Fatalf("%q, %d and %d notices", got, len(f.turnNotices("aboss")), len(f.turnNotices("achild")))
	}
}

// What TS coerces with String() and Number() is coerced the same way: a missing name is "undefined", a round of true is 1, a blank
// round is 0, and a fractional max_rounds ends the ring in the round it would in TS.
func TestRingCoercions(t *testing.T) {
	f := ringFixture(t)
	id := f.newRing(`{"topic":"t","members":["aboss","achild"]}`)
	if got := f.text("SELECT name FROM rings WHERE id = ?", id); got != "undefined" {
		t.Errorf("a ring with no name: %q", got)
	}
	nid := f.newRing(`{"name":null,"topic":"t","members":["aboss","achild"],"max_rounds":2.5}`)
	if got := f.text("SELECT name FROM rings WHERE id = ?", nid); got != "null" {
		t.Errorf("a null name: %q", got)
	}
	if got := f.count("SELECT max_rounds FROM rings WHERE id = ?", nid); got != 3 {
		t.Errorf("max_rounds 2.5 is kept as %d", got)
	}
	// Number(true) is 1, the round the ring is on, so that submit lands; the others are other rounds.
	if code, res := f.submit(id, "aboss", "x", `,"round":true`); code != 200 || res != "Submitted. Waiting for the other members." {
		t.Errorf("round true: %d %q", code, res)
	}
	for _, c := range []struct{ round, want string }{{`" "`, "not 0"}, {`""`, "not 0"}, {`false`, "not 0"}, {`"2"`, "not 2"}} {
		if code, res := f.submit(id, "achild", "x", `,"round":`+c.round); code != 409 || !strings.Contains(res, "is on round 1, "+c.want) {
			t.Errorf("round %s: %d %q", c.round, code, res)
		}
	}
}

// A template that can't be rendered fails the step: no ring is stored with empty prompts.
func TestRingTemplateFailure(t *testing.T) {
	f := ringFixture(t)
	f.srv.tpl = nil
	code, v := f.ringPost("/api/rings", `{"name":"bare","topic":"t","members":["aboss","achild"]}`)
	if code < 400 {
		t.Errorf("a ring with no templates: %d %q", code, v.Text("error"))
	}
	if n := f.count("SELECT COUNT(*) FROM rings"); n != 0 {
		t.Errorf("%d rings stored", n)
	}
	if n := len(f.turnNotices("aboss")) + len(f.turnNotices("achild")); n != 0 {
		t.Errorf("%d notices queued", n)
	}
}

// A fire ring goes member by member, out of turn is refused, and a verdict ring ends on matching verdicts only.
func TestRingFireAndVerdicts(t *testing.T) {
	f := ringFixture(t)
	id := f.newRing(`{"name":"rev","format":"fire","topic":"Review PR 12","members":["aboss","achild"],"max_rounds":2}`)
	if n := f.turnNotices("achild"); len(n) != 0 {
		t.Errorf("a fire ring prompts only the first member: %q", n)
	}
	n := f.turnNotices("aboss")
	if len(n) != 1 || !strings.Contains(n[0], "This ring reviews PR 12. Members don't post the verdict.") || !strings.Contains(n[0], "Give your verdict on the PR in ring_submit's verdict") {
		t.Errorf("the PR ring's prompt: %q", n)
	}
	if code, msg := f.submit("rev", "achild", "too early"); code != 409 || msg != "it is boss's turn" {
		t.Errorf("out of turn: %d %q", code, msg)
	}
	if code, msg := f.submit("rev", "aboss", "found a bug", `,"verdict":"request_changes","agree":true`); code != 200 || msg != "Submitted. The next member has the turn." {
		t.Errorf("boss: %d %q", code, msg)
	}
	if code, msg := f.submit("rev", "achild", "fine", `,"verdict":"maybe"`); code != 409 || msg != "verdict must be approve or request_changes" {
		t.Errorf("a bad verdict: %d %q", code, msg)
	}
	f.submit("rev", "achild", "Verdict: approve", `,"agree":true`)
	// Round 1 split: the verdicts differ, so agreement does not end it, and round 2 shows the split.
	if got := f.ringStatus(id); got != "running|2|2" {
		t.Fatalf("after the split: %q", got)
	}
	n = f.turnNotices("aboss")
	if last := n[len(n)-1]; !strings.Contains(last, "agrees to end") || !strings.Contains(last, "### The verdicts don't all match in round 1\nboss: request_changes, child: approve.") {
		t.Errorf("round 2 prompt: %q", last)
	}
	f.submit("rev", "aboss", "ok now", `,"verdict":"approve","agree":true`)
	f.submit("rev", "achild", "yes", `,"verdict":"approve","agree":true`)
	if got := f.ringStatus(id); got != "done|2|4" {
		t.Fatalf("after round 2: %q", got)
	}
	body := f.text("SELECT body FROM mail WHERE subject = 'Ring rev ended'")
	if !strings.Contains(body, "all members agreed") || !strings.Contains(body, "### boss (approve)\nok now") || !strings.Contains(body, "Members don't post the verdict. When the ring ends on a verdict, its creator runs this") {
		t.Errorf("the mail: %q", body)
	}
}

// A moderator reads each completed round: continue with a note, or end it, with a decision when it decides.
func TestRingModerator(t *testing.T) {
	f := ringFixture(t)
	id := f.newRing(`{"name":"mod","topic":"t","members":["aboss","achild"],"moderator":"acodex","moderator_decides":true,"max_rounds":3}`)
	f.submit("mod", "aboss", "a")
	f.submit("mod", "achild", "b")
	if got := f.ringStatus(id); got != "moderating|1|0" {
		t.Fatalf("moderating: %q", got)
	}
	n := f.turnNotices("acodex")
	if len(n) != 1 || !strings.Contains(n[0], "Round 1 of at most 3 is complete.") || !strings.Contains(n[0], "Not all members agree yet.") || !strings.Contains(n[0], "continue with a note for the members, or end it with your decision.") {
		t.Errorf("the moderator's prompt: %q", n)
	}
	if code, msg := f.submit("mod", "aboss", "more"); code != 409 || msg != "ring mod is moderating" {
		t.Errorf("a submit while moderating: %d %q", code, msg)
	}
	decide := func(by, body string) (int, string) {
		code, v := f.ringAs(by, "/api/rings/mod/decide", `{"by":"`+by+`",`+body+`}`)
		return code, v.Text("result") + v.Text("error")
	}
	if code, msg := decide("aboss", `"continue":true,"text":"x"`); code != 409 || msg != "only the moderator decides" {
		t.Errorf("a member deciding: %d %q", code, msg)
	}
	if code, msg := decide("acodex", `"continue":true,"text":"look at the edge"`); code != 200 || msg != "The next round has started." {
		t.Errorf("continue: %d %q", code, msg)
	}
	if n := f.turnNotices("aboss"); !strings.Contains(n[len(n)-1], "### Moderator's note\nlook at the edge") {
		t.Errorf("the note: %q", n)
	}
	if code, msg := decide("acodex", `"continue":true,"text":"again"`); code != 409 || msg != "ring mod is running, not waiting for you" {
		t.Errorf("deciding while running: %d %q", code, msg)
	}
	f.submit("mod", "aboss", "a2")
	f.submit("mod", "achild", "b2")
	if code, msg := decide("acodex", `"continue":false,"text":"Ship it."`); code != 200 || msg != "The ring has ended." {
		t.Errorf("end: %d %q", code, msg)
	}
	body := f.text("SELECT body FROM mail WHERE subject = 'Ring mod ended'")
	if !strings.Contains(body, "the moderator ended it") || !strings.Contains(body, "Moderator's decision:\nShip it.") {
		t.Errorf("the mail: %q", body)
	}
}

// A seat held by a successor (cost_switch), the round a prompt showed, and a text that is empty.
func TestRingSeatsAndStaleRounds(t *testing.T) {
	f := ringFixture(t)
	f.newRing(`{"name":"seats","topic":"t","members":["aboss","acodex"],"max_rounds":2}`)
	// acodex was taken over by achild: the turn goes to the successor, and achild may submit for the seat.
	f.sql("UPDATE agents SET forwarded_to = 'achild' WHERE id = 'acodex'")
	if code, msg := f.submit("seats", "achild", "  "); code != 409 || msg != "text is required: your findings for the ring, as a non-empty string" {
		t.Errorf("empty text: %d %q", code, msg)
	}
	if code, msg := f.submit("seats", "agone", "who"); code != 409 || msg != "you are not a member of this ring" {
		t.Errorf("a stranger: %d %q", code, msg)
	}
	if code, msg := f.submit("seats", "achild", "for codex", `,"round":2`); code != 409 || !strings.Contains(msg, "ring seats is on round 1, not 2: your turn prompt is out of date") {
		t.Errorf("a stale round: %d %q", code, msg)
	}
	if code, msg := f.submit("seats", "achild", "for codex", `,"seat":"nobody"`); code != 409 || !strings.HasPrefix(msg, "you do not hold the seat nobody: your open seats in seats are ") {
		t.Errorf("a seat not held: %d %q", code, msg)
	}
	if code, msg := f.submit("seats", "achild", "for codex", `,"round":1`); code != 200 || msg != "Submitted. Waiting for the other members." {
		t.Errorf("the successor's: %d %q", code, msg)
	}
	if got := f.text("SELECT agent_id FROM ring_submissions WHERE ring_id = (SELECT id FROM rings WHERE name = 'seats')"); got != "acodex" {
		t.Errorf("the text is the member's: %q", got)
	}
	// With no free seat the submit goes to the agent's own seat and replaces its text (INSERT OR REPLACE, as in TS).
	if code, msg := f.submit("seats", "achild", "again"); code != 200 || msg != "Submitted. Waiting for the other members." {
		t.Errorf("a refill: %d %q", code, msg)
	}
	if got := f.text("SELECT text FROM ring_submissions WHERE ring_id = (SELECT id FROM rings WHERE name = 'seats')"); got != "again" {
		t.Errorf("the replaced text: %q", got)
	}
}

// The restart's re-prompt: each open seat is prompted again from the durable state.
func TestRingPromptOpenSeats(t *testing.T) {
	f := ringFixture(t)
	f.newRing(`{"name":"back","topic":"t","members":["aboss","achild"]}`)
	f.submit("back", "aboss", "a")
	n, err := f.srv.StartRings(t.Context())
	if err != nil || n != 1 {
		t.Fatalf("seats %d %v", n, err)
	}
	if got := f.turnNotices("achild"); len(got) != 2 {
		t.Errorf("achild: %d notices, want the first and the re-prompt", len(got))
	}
	if got := f.turnNotices("aboss"); len(got) != 1 {
		t.Errorf("aboss, who had submitted, was prompted again: %d", len(got))
	}
}

// What cannot be done here answers before anything is written: a ring with no creator, a bad ring. (Spawning members and a
// moderator: rings_spawn_test.go.)
func TestRingRefusals(t *testing.T) {
	f := ringFixture(t)
	for _, tc := range []struct {
		name, body string
		code       int
		msg        string
	}{
		{"one member", `{"name":"x","topic":"t","members":["aboss"]}`, 400, "a ring needs at least two members"},
		{"no such member", `{"name":"x","topic":"t","members":["aboss","nobody"]}`, 400, "no agent nobody"},
		{"a bad format", `{"name":"x","topic":"t","format":"round","members":["aboss","achild"]}`, 400, "format must be rounds, fire, or debate"},
		{"no such moderator", `{"name":"x","topic":"t","members":["aboss","achild"],"moderator":"nobody"}`, 400, "no agent nobody"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, v := f.ringPost("/api/rings", tc.body)
			if code != tc.code || !strings.Contains(v.Text("error"), tc.msg) {
				t.Errorf("%d %q", code, v.Text("error"))
			}
		})
	}
	if n := f.count("SELECT COUNT(*) FROM rings"); n != 0 {
		t.Errorf("%d rings made", n)
	}
	if n := len(f.turnNotices("aboss")) + len(f.turnNotices("achild")); n != 0 {
		t.Errorf("%d notices from refused rings", n)
	}
	// An agent creates a ring as itself; a daemon without the lifecycle refuses.
	if rec := f.sendH("POST", "/api/rings", agentTok, nil, `{"name":"mine","topic":"t","members":["aboss","achild"]}`); rec.Code != 200 {
		t.Errorf("an agent's ring: %d %s", rec.Code, rec.Body.String())
	}
	if got := f.text("SELECT created_by FROM rings WHERE name = 'mine'"); got != "achild" {
		t.Errorf("created by %q", got)
	}
	f.srv.life = nil
	if code, v := f.ringPost("/api/rings", `{"name":"y","topic":"t","members":["aboss","achild"]}`); code != 501 {
		t.Errorf("no lifecycle: %d %q", code, v.Text("error"))
	}
	if n := f.count("SELECT COUNT(*) FROM rings WHERE name = 'y'"); n != 0 {
		t.Errorf("a ring was made without a lifecycle")
	}
}

// ringTwoPRs is ring r8dc834's topic shape (S-4182, S-4199): the PR under review and its base PR. It is still a PR review, so its
// verdicts are kept and must match.
const ringTwoPRs = "Review PR #1300 (owner/repo), head 467ed631. Its base PR #1299 has merged, so diff against origin/main."

// Ring r8dc834: request_changes in prose plus approve, both agreeing, ended "all members agreed". It ends as split.
func TestRingSplitOnTopicWithBasePR(t *testing.T) {
	f := ringFixture(t)
	id := f.newRing(`{"name":"asks","format":"rounds","topic":"` + ringTwoPRs + `","members":["aboss","achild"],"max_rounds":1}`)
	if n := f.turnNotices("aboss"); len(n) != 1 || !strings.Contains(n[0], "Give your verdict on the PR") {
		t.Errorf("the turn asks for a verdict: %q", n)
	}
	f.submit("asks", "aboss", "Request changes at head 467ed631. P1: peer rows pass through unchanged.", `,"agree":true`)
	f.submit("asks", "achild", "No blocking findings.", `,"verdict":"approve","agree":true`)
	if got := f.ringStatus(id); got != "done|1|0" {
		t.Fatalf("status %q", got)
	}
	body := f.text("SELECT body FROM mail WHERE subject = 'Ring asks ended'")
	// Submissions in the same millisecond have no set order, so the split names each verdict in either order.
	if strings.Contains(body, "all members agreed") || !strings.Contains(body, "ended after round 1: split (") || !strings.Contains(body, "boss: request_changes") || !strings.Contains(body, "child: approve") {
		t.Errorf("the mail: %q", body)
	}
}

// Every verdict combination for a 2- and 3-member PR ring (test/ring-split.test.mjs): only identical recognised verdicts with every
// member agreeing end the ring early; a split, a missing or unreadable verdict, a member that never submitted or one that doesn't
// agree keeps it running.
func TestRingAgreementTable(t *testing.T) {
	type kind struct{ extra, is string }
	kinds := map[string]*kind{
		"approve":         {`,"verdict":"approve"`, "approve"},
		"request_changes": {`,"verdict":"request_changes"`, "request_changes"},
		"prose_changes":   {"", "request_changes"},
		"line_approve":    {"", "approve"},
		"prose_approve":   {"", ""},
		"none":            {"", ""},
		"skip":            nil,
	}
	texts := map[string]string{"approve": "Fine.", "request_changes": "Missing test.", "prose_changes": "Request changes at head abc: no test.",
		"line_approve": `Clean change.\nVerdict: approve`, "prose_approve": "Looks good, I approve.", "none": "Seems fine."}
	type seat struct {
		k     string
		agree bool
	}
	all := []string{"approve", "request_changes", "prose_changes", "line_approve", "prose_approve", "none", "skip"}
	seats := func(ks []string) (out []seat) {
		for _, k := range ks {
			out = append(out, seat{k, false})
			if kinds[k] != nil {
				out = append(out, seat{k, true})
			}
		}
		return out
	}
	var product func(opts []seat, n int) [][]seat
	product = func(opts []seat, n int) [][]seat {
		if n == 0 {
			return [][]seat{nil}
		}
		var out [][]seat
		for _, rest := range product(opts, n-1) {
			for _, o := range opts {
				out = append(out, append([]seat{o}, rest...))
			}
		}
		return out
	}
	members := []string{"aboss", "achild", "acodex"}
	for _, c := range []struct {
		size  int
		topic string
		kinds []string
	}{{2, "review PR 603", all}, {2, ringTwoPRs, all}, {3, ringTwoPRs, []string{"approve", "request_changes", "prose_changes", "none", "skip"}}} {
		f := ringFixture(t)
		combos := product(seats(c.kinds), c.size)
		for i, combo := range combos {
			name := "t" + strconv.Itoa(i)
			id := f.newRing(`{"name":"` + name + `","format":"rounds","topic":"` + c.topic + `","members":["` + strings.Join(members[:c.size], `","`) + `"],"max_rounds":2}`)
			complete, agreed := true, true
			for j, s := range combo {
				k := kinds[s.k]
				if k == nil {
					complete = false
					continue
				}
				f.submit(name, members[j], texts[s.k], k.extra+`,"agree":`+strconv.FormatBool(s.agree))
				agreed = agreed && s.agree && k.is != "" && kinds[combo[0].k] != nil && k.is == kinds[combo[0].k].is
			}
			want := "running|1|0"
			if complete && agreed {
				want = "done|1|0"
			} else if complete {
				want = "running|2|0"
			}
			if got := f.ringStatus(id); got != want {
				t.Errorf("%d members on %q, %v: %q, want %q", c.size, c.topic, combo, got, want)
			}
		}
		if min := map[int]int{2: 169, 3: 729}[c.size]; len(combos) < min {
			t.Errorf("%d combinations, want %d", len(combos), min)
		}
	}
}

package ghpoll

import (
	"context"
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// held is what the daemon stores between two polls: the snapshot and the ETags, through JSON as watch_state keeps them.
type held struct {
	state  *Snapshot
	etags  map[string]string
	result PollResult
}

func newTestPoller(f *fakeGithub) *Poller {
	return New(Options{Base: f.url})
}

func (h held) poll(t *testing.T, p *Poller, subject string) held {
	t.Helper()
	r, err := p.Poll(context.Background(), subject, h.state, h.etags, testToken)
	if err != nil {
		t.Fatalf("poll %s: %v", subject, err)
	}
	b, _ := json.Marshal(r.State)
	var s Snapshot
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	return held{state: &s, etags: r.Etags, result: r}
}

func (h held) types() []string {
	var out []string
	for _, e := range h.result.Events {
		out = append(out, e.Type)
	}
	return out
}

func eq(t *testing.T, got, want any, what string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s:\n got  %v\n want %v", what, got, want)
	}
}

func TestParseSubject(t *testing.T) {
	s, ok := ParseSubject("github:o/r")
	if !ok || !s.IsRepo || s.Owner != "o" || s.Repo != "r" || s.Key != "github:o/r" || s.RepoKey != "github:o/r" {
		t.Errorf("repo: %+v %v", s, ok)
	}
	if s, ok := ParseSubject("github:o/r#12"); !ok || s.Number != 12 || s.IsRepo || s.RepoKey != "github:o/r" {
		t.Errorf("pr: %+v", s)
	}
	for _, bad := range []string{"github:o/*", "linear:TEAM-1", "github:o/r#", "github:o/r#x", "github:o r", "github:o/r/x", ""} {
		if _, ok := ParseSubject(bad); ok {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestChecksState(t *testing.T) {
	if s, f := ChecksState(nil, nil); s != "none" || len(f) != 0 {
		t.Errorf("none: %s %v", s, f)
	}
	run := func(name, status, concl string) Run {
		r := Run{Name: name, Status: status}
		if concl != "" {
			r.Conclusion = &concl
		}
		return r
	}
	if s, _ := ChecksState([]Run{run("build", "in_progress", "")}, nil); s != "pending" {
		t.Errorf("pending: %s", s)
	}
	if s, _ := ChecksState([]Run{run("build", "completed", "success")}, []CommitStatus{{Context: "ci", State: "pending"}}); s != "pending" {
		t.Errorf("a pending status: %s", s)
	}
	if s, _ := ChecksState([]Run{run("build", "completed", "success"), run("l", "completed", "skipped"), run("m", "completed", "neutral")}, []CommitStatus{{Context: "ci", State: "success"}}); s != "success" {
		t.Errorf("success: %s", s)
	}
	s, f := ChecksState([]Run{run("build", "completed", "failure")}, []CommitStatus{{Context: "lint", State: "failure"}})
	sort.Strings(f)
	if s != "failure" || !reflect.DeepEqual(f, []string{"build", "lint"}) {
		t.Errorf("failure: %s %v", s, f)
	}
}

func TestReviewHelpers(t *testing.T) {
	eq(t, ReviewAgentOfComment("Review (rev-1): approve"), "rev-1", "agent")
	eq(t, ReviewAgentOfComment("  Review (a b): x"), "a b", "agent with a space")
	for _, bad := range []string{"", "review (a): x", "Review (): x", "Review (a) x", "Reviewed (a): x"} {
		eq(t, ReviewAgentOfComment(bad), "", bad)
	}
	at := func(s string) *string { return &s }
	sts := []CommitStatus{
		{Context: "stam/gates", State: "failure", UpdatedAt: at("2026-10-13T12:00:00Z")},
		{Context: ReviewContext, State: "failure", UpdatedAt: at("2026-10-13T10:00:00Z")},
		{Context: ReviewContext, State: "success", UpdatedAt: at("2026-10-13T11:00:00Z")},
	}
	eq(t, ReviewVerdict(sts), "approve", "newest review wins")
	eq(t, ReviewVerdict(sts[:2]), "changes", "failure")
	eq(t, ReviewVerdict([]CommitStatus{{Context: ReviewContext, State: "pending"}}), "", "pending")
	eq(t, ReviewVerdict(nil), "", "none")
}

func TestFirstPollIsSilentAndAnUnchangedPollTakesTheNotModifiedPath(t *testing.T) {
	f := newFake(t)
	f.seedOpenPR("sha1")
	p := newTestPoller(f)
	h := held{}.poll(t, p, "github:o/r#1")
	if len(h.result.Events) != 0 {
		t.Fatalf("the first poll emitted %v", h.types())
	}
	if h.state.Type != "pr" || *h.state.State != "open" || *h.state.Head != "sha1" || h.state.Checks != "pending" || *h.state.Base != "main" {
		t.Errorf("snapshot: %+v", h.state)
	}
	f.clearCalls()
	h2 := h.poll(t, p, "github:o/r#1")
	if len(h2.result.Events) != 0 {
		t.Errorf("unchanged poll emitted %v", h2.types())
	}
	eq(t, h2.state, h.state, "an unchanged poll keeps the snapshot")
	if len(h2.etags) == 0 || !reflect.DeepEqual(h2.etags, h.etags) {
		t.Errorf("etags %v vs %v", h2.etags, h.etags)
	}
	// Every call of the second poll sent its ETag back and was answered 304.
	if n := len(f.callList()); f.notModified != n || n == 0 {
		t.Errorf("%d calls, %d answered 304", n, f.notModified)
	}
}

func TestNewHeadSynchronizesAndChecksCompleteOncePerRun(t *testing.T) {
	f := newFake(t)
	f.seedOpenPR("sha1")
	p := newTestPoller(f)
	h := held{}.poll(t, p, "github:o/r#1")
	f.patch("pulls", "o/r#1", map[string]any{"head": map[string]any{"sha": "sha2", "ref": "feature"}})
	f.set("checkRuns", "o/r@sha2", []any{map[string]any{"name": "build", "status": "in_progress", "conclusion": nil}})
	h = h.poll(t, p, "github:o/r#1")
	eq(t, h.types(), []string{"pull_request.synchronize"}, "a new head")
	e := h.result.Events[0]
	if e.DedupeKey != "pull_request.synchronize:github:o/r#1:sha2" || e.Summary != "PR #1 new commits (sha2)" {
		t.Errorf("event: %+v", e)
	}
	eq(t, e.Subjects, []string{"github:o/r#1", "github:o/r"}, "subjects")
	f.set("checkRuns", "o/r@sha2", []any{map[string]any{"name": "build", "status": "completed", "conclusion": "failure", "completed_at": "2026-10-13T10:05:00Z"}})
	f.set("statuses", "o/r@sha2", map[string]any{"state": "success", "statuses": []any{}})
	h = h.poll(t, p, "github:o/r#1")
	eq(t, h.types(), []string{"checks.completed"}, "checks done")
	e = h.result.Events[0]
	if e.Summary != "PR #1 checks failed: build" || e.DedupeKey != "checks.completed:github:o/r#1:sha2:failure:2026-10-13T10:05:00Z" {
		t.Errorf("event: %+v", e)
	}
	// A re-run that fails again has a later completion: a second event with its own key.
	f.set("checkRuns", "o/r@sha2", []any{map[string]any{"name": "build", "status": "completed", "conclusion": "failure", "completed_at": "2026-10-13T10:09:00Z"}})
	h = h.poll(t, p, "github:o/r#1")
	eq(t, h.types(), []string{"checks.completed"}, "a re-run")
	if h.result.Events[0].DedupeKey == e.DedupeKey {
		t.Errorf("the re-run reuses the key")
	}
}

func TestReviewCommentAndMergeEmitOnceWithStableKeys(t *testing.T) {
	f := newFake(t)
	f.seedOpenPR("sha1")
	p := newTestPoller(f)
	h := held{}.poll(t, p, "github:o/r#1")
	f.set("reviews", "o/r#1", []any{map[string]any{"id": 77, "state": "APPROVED", "submitted_at": "2026-10-13T10:10:00Z", "user": map[string]any{"login": "rev"}}})
	f.set("comments", "o/r#1", []any{map[string]any{"id": 5, "body": "Review (rev-1): approve\nlooks good", "created_at": "2026-10-13T10:11:00Z", "updated_at": "2026-10-13T10:11:00Z", "user": map[string]any{"login": "bot"}}})
	h = h.poll(t, p, "github:o/r#1")
	eq(t, h.types(), []string{"review.submitted", "comment.created"}, "review and comment")
	rv, cm := h.result.Events[0], h.result.Events[1]
	if rv.DedupeKey != "review.submitted:github:o/r#1:77" || rv.Summary != "PR #1 reviewed (approved) by rev" || *rv.Actor != "rev" {
		t.Errorf("review: %+v", rv)
	}
	if cm.DedupeKey != "comment.created:github:o/r#1:5" || cm.Summary != "PR #1 comment by bot: Review (rev-1): approve" {
		t.Errorf("comment: %+v", cm)
	}
	if got := jsonOf(cm.Payload); got != `{"at":"2026-10-13T10:11:00Z","review_agent":"rev-1"}` {
		t.Errorf("comment payload %s", got)
	}
	if h.state.Review != "approved" || h.state.LastReview == nil || h.state.LastReview.State != "approved" {
		t.Errorf("review state: %+v", h.state)
	}
	h = h.poll(t, p, "github:o/r#1")
	eq(t, h.types(), []string(nil), "nothing twice")
	f.patch("issues", "o/r#1", map[string]any{"state": "closed", "updated_at": "2026-10-13T11:00:00Z"})
	f.patch("pulls", "o/r#1", map[string]any{"merged": true, "state": "closed"})
	h = h.poll(t, p, "github:o/r#1")
	eq(t, h.types(), []string{"pull_request.merged"}, "merge")
	if h.result.Events[0].DedupeKey != "pull_request.merged:github:o/r#1:2026-10-13T11:00:00Z" || jsonOf(h.result.Events[0].Payload) != `{"at":"2026-10-13T11:00:00Z"}` {
		t.Errorf("merge: %+v", h.result.Events[0])
	}
}

func TestIssueOpenedClosedReopenedAndAPRThatAppears(t *testing.T) {
	f := newFake(t)
	p := newTestPoller(f)
	// Absent first, then opened: a watched number that appears.
	h := held{}.poll(t, p, "github:o/r#9")
	if !h.state.Absent {
		t.Fatalf("not absent: %+v", h.state)
	}
	f.set("issues", "o/r#9", map[string]any{"number": 9, "title": "Bug", "state": "open", "html_url": "u", "user": map[string]any{"login": "a"}, "updated_at": "2026-10-13T10:00:00Z"})
	h = h.poll(t, p, "github:o/r#9")
	eq(t, h.types(), []string{"issue.opened"}, "an issue that appears after an absent poll")
	f.patch("issues", "o/r#9", map[string]any{"state": "closed", "updated_at": "2026-10-13T11:00:00Z"})
	h = h.poll(t, p, "github:o/r#9")
	eq(t, h.types(), []string{"issue.closed"}, "closed")
	f.patch("issues", "o/r#9", map[string]any{"state": "open", "updated_at": "2026-10-13T12:00:00Z"})
	h = h.poll(t, p, "github:o/r#9")
	eq(t, h.types(), []string{"issue.reopened"}, "reopened")
	f.patch("issues", "o/r#9", map[string]any{"state": "closed", "updated_at": "2026-10-13T13:00:00Z"})
	h = h.poll(t, p, "github:o/r#9")
	eq(t, h.types(), []string{"issue.closed"}, "closed again is a new event")

	// A PR that is absent on the first poll and opens after emits pull_request.opened.
	h = held{}.poll(t, p, "github:o/r#1")
	f.seedOpenPR("sha1")
	h = h.poll(t, p, "github:o/r#1")
	if got := h.types(); len(got) == 0 || got[0] != "pull_request.opened" {
		t.Errorf("types %v", got)
	}
}

func TestPRStateChangesAndDraft(t *testing.T) {
	f := newFake(t)
	f.seedOpenPR("sha1")
	p := newTestPoller(f)
	h := held{}.poll(t, p, "github:o/r#1")
	f.patch("pulls", "o/r#1", map[string]any{"draft": true})
	h = h.poll(t, p, "github:o/r#1")
	eq(t, h.types(), []string{"pull_request.converted_to_draft"}, "draft")
	f.patch("pulls", "o/r#1", map[string]any{"draft": false})
	h = h.poll(t, p, "github:o/r#1")
	eq(t, h.types(), []string{"pull_request.ready_for_review"}, "ready")
	f.patch("issues", "o/r#1", map[string]any{"state": "closed", "updated_at": "2026-10-13T11:00:00Z"})
	f.patch("pulls", "o/r#1", map[string]any{"state": "closed"})
	h = h.poll(t, p, "github:o/r#1")
	eq(t, h.types(), []string{"pull_request.closed"}, "closed")
	f.patch("issues", "o/r#1", map[string]any{"state": "open", "updated_at": "2026-10-13T12:00:00Z"})
	f.patch("pulls", "o/r#1", map[string]any{"state": "open"})
	h = h.poll(t, p, "github:o/r#1")
	eq(t, h.types(), []string{"pull_request.reopened"}, "reopened")
}

func TestRepositoryEventsMapToTypesAndAPushNamesItsBranch(t *testing.T) {
	f := newFake(t)
	p := newTestPoller(f)
	f.set("events", "o/r", []any{
		map[string]any{"id": "10", "type": "PushEvent", "actor": map[string]any{"login": "al"}, "payload": map[string]any{"ref": "refs/heads/main", "commits": []any{1, 2}}},
	})
	h := held{}.poll(t, p, "github:o/r")
	eq(t, h.types(), []string(nil), "first poll silent")
	if *h.state.LastEventID != 10 {
		t.Errorf("lastEventId %d", *h.state.LastEventID)
	}
	f.set("events", "o/r", []any{
		map[string]any{"id": "12", "type": "IssuesEvent", "actor": map[string]any{"login": "bo"}, "payload": map[string]any{"action": "opened", "issue": map[string]any{"number": 4, "title": " Broken  thing "}}},
		map[string]any{"id": "11", "type": "PushEvent", "actor": map[string]any{"login": "al"}, "payload": map[string]any{"ref": "refs/heads/main", "commits": []any{1, 2}}},
		map[string]any{"id": "10", "type": "PushEvent", "payload": map[string]any{}},
	})
	h = h.poll(t, p, "github:o/r")
	eq(t, h.types(), []string{"issues.opened", "push"}, "new events, newest first")
	is, push := h.result.Events[0], h.result.Events[1]
	if is.Summary != "issues.opened: #4 Broken thing by bo" || !reflect.DeepEqual(is.Subjects, []string{"github:o/r", "github:o/r#4"}) {
		t.Errorf("issues: %+v", is)
	}
	if push.Summary != "push: 2 commits to main" || push.DedupeKey != "push:github:o/r:11" {
		t.Errorf("push: %+v", push)
	}
	h = h.poll(t, p, "github:o/r")
	eq(t, h.types(), []string(nil), "an unchanged poll")
}

func TestABusyRepoReadsPage2OnlyWhileTheFirstIsAllNew(t *testing.T) {
	f := newFake(t)
	f.pageSize = 2
	p := newTestPoller(f)
	ev := func(id string) any {
		return map[string]any{"id": id, "type": "WatchEvent", "actor": map[string]any{"login": "s"}, "payload": map[string]any{}}
	}
	f.set("events", "o/r", []any{ev("5")})
	h := held{}.poll(t, p, "github:o/r")
	f.set("events", "o/r", []any{ev("9"), ev("8"), ev("7"), ev("6"), ev("5")})
	h = h.poll(t, p, "github:o/r")
	eq(t, h.types(), []string{"star", "star", "star", "star"}, "events 9..6 over two pages")
	f.clearCalls()
	h = h.poll(t, p, "github:o/r")
	if got := len(f.callList()); got != 1 {
		t.Errorf("a 304 on page 1 fetched %d pages", got)
	}
}

func TestStatusesAloneCompleteChecksAndA304KeepsThatSide(t *testing.T) {
	f := newFake(t)
	f.seedOpenPR("sha1")
	f.set("checkRuns", "o/r@sha1", []any{})
	f.set("statuses", "o/r@sha1", map[string]any{"state": "pending", "statuses": []any{map[string]any{"context": "stam/gates", "state": "pending", "updated_at": "2026-10-13T10:00:00Z"}}})
	p := newTestPoller(f)
	h := held{}.poll(t, p, "github:o/r#1")
	f.set("statuses", "o/r@sha1", map[string]any{"state": "failure", "statuses": []any{map[string]any{"context": "stam/gates", "state": "failure", "updated_at": "2026-10-13T10:30:00Z"}}})
	h = h.poll(t, p, "github:o/r#1")
	eq(t, h.types(), []string{"checks.completed"}, "gate failed")
	if h.result.Events[0].Summary != "PR #1 checks failed: stam/gates" {
		t.Errorf("%s", h.result.Events[0].Summary)
	}
	// Check runs change; statuses answer 304: the status side stays as the snapshot saw it, so no spurious pass.
	f.set("checkRuns", "o/r@sha1", []any{map[string]any{"name": "build", "status": "completed", "conclusion": "success", "completed_at": "2026-10-13T10:20:00Z"}})
	h = h.poll(t, p, "github:o/r#1")
	if len(h.state.HeadStatuses) != 1 || h.state.Checks != "failure" {
		t.Errorf("the 304 side was dropped: %+v", h.state)
	}
}

func TestANewHeadWhoseStatusFetchFailsKeepsNothingOfTheOldHeadAndIsNoPass(t *testing.T) {
	f := newFake(t)
	f.seedOpenPR("sha1")
	f.set("statuses", "o/r@sha1", map[string]any{"state": "success", "statuses": []any{map[string]any{"context": ReviewContext, "state": "success", "description": "Review (rev-1): approve", "updated_at": "2026-10-13T10:00:00Z"}}})
	f.set("checkRuns", "o/r@sha1", []any{})
	p := newTestPoller(f)
	h := held{}.poll(t, p, "github:o/r#1")
	// A new head whose statuses 404 but whose runs pass.
	f.patch("pulls", "o/r#1", map[string]any{"head": map[string]any{"sha": "sha2", "ref": "feature"}})
	f.set("checkRuns", "o/r@sha2", []any{map[string]any{"name": "build", "status": "completed", "conclusion": "success", "completed_at": "2026-10-13T10:05:00Z"}})
	f.failSha["o/r@sha2/status"] = true
	h = h.poll(t, p, "github:o/r#1")
	if h.state.Checks != "pending" || len(h.state.HeadStatuses) != 0 {
		t.Errorf("a pass on a head whose statuses are unknown: checks=%s statuses=%v", h.state.Checks, h.state.HeadStatuses)
	}
	if string(h.state.StatusesHead) != "null" {
		t.Errorf("statusesHead %s", h.state.StatusesHead)
	}
	eq(t, h.types(), []string{"pull_request.synchronize"}, "only the push")
	if ReviewVerdict(h.state.HeadStatuses) != "" {
		t.Errorf("a verdict was copied from the old head")
	}
}

func TestChecksCompletedNamesTheAgentOnlyForItsOwnReviewStatus(t *testing.T) {
	f := newFake(t)
	f.seedOpenPR("sha1")
	f.set("checkRuns", "o/r@sha1", []any{})
	f.set("statuses", "o/r@sha1", map[string]any{"state": "pending", "statuses": []any{map[string]any{"context": "stam/gates", "state": "pending", "updated_at": "2026-10-13T10:00:00Z"}}})
	p := newTestPoller(f)
	h := held{}.poll(t, p, "github:o/r#1")
	st := func(g, r string) any {
		return map[string]any{"state": "x", "statuses": []any{
			map[string]any{"context": "stam/gates", "state": g, "updated_at": "2026-10-13T10:00:00Z"},
			map[string]any{"context": ReviewContext, "state": r, "description": "Review (rev-1): approve", "updated_at": "2026-10-13T10:30:00Z"},
		}}
	}
	f.set("statuses", "o/r@sha1", st("success", "success"))
	h = h.poll(t, p, "github:o/r#1")
	if got := jsonOf(h.result.Events[0].Payload); got != `{"at":"2026-10-13T10:30:00Z","review_agent":"rev-1","head":"sha1","verdict":"approve"}` {
		t.Errorf("own review: %s", got)
	}
	// A gate failure anyone has to see is not the watcher's own review.
	f.set("statuses", "o/r@sha1", st("failure", "success"))
	h = h.poll(t, p, "github:o/r#1")
	if got := jsonOf(h.result.Events[0].Payload); !strings.Contains(got, `"review_agent":null`) {
		t.Errorf("gate failure: %s", got)
	}
}

func TestMirrorsHead(t *testing.T) {
	f := newFake(t)
	f.seedOpenPR("sha1")
	p := newTestPoller(f)
	first := held{}.poll(t, p, "github:o/r#1")
	if !MirrorsHead(nil, first.result) {
		t.Errorf("the first poll of an open PR mirrors")
	}
	same := first.poll(t, p, "github:o/r#1")
	if MirrorsHead(first.state, same.result) {
		t.Errorf("a poll with the same head mirrors")
	}
	f.patch("pulls", "o/r#1", map[string]any{"head": map[string]any{"sha": "sha2", "ref": "f"}})
	moved := first.poll(t, p, "github:o/r#1")
	if !MirrorsHead(first.state, moved.result) {
		t.Errorf("new commits mirror")
	}
	// A first poll of a closed PR or an issue does not.
	f.patch("issues", "o/r#1", map[string]any{"state": "closed"})
	f.patch("pulls", "o/r#1", map[string]any{"state": "closed"})
	if closed := (held{}).poll(t, p, "github:o/r#1"); MirrorsHead(nil, closed.result) {
		t.Errorf("a closed PR mirrors")
	}
	f.set("issues", "o/r#2", map[string]any{"number": 2, "title": "i", "state": "open"})
	if iss := (held{}).poll(t, p, "github:o/r#2"); MirrorsHead(nil, iss.result) {
		t.Errorf("an issue mirrors")
	}
}

// A snapshot a TS daemon wrote reads as it left it, and the Go write keeps the names TS reads (src/diff.ts: checksHead,
// headStatuses; the route: state, checks).
func TestSnapshotKeepsTSNames(t *testing.T) {
	ts := `{"type":"pr","absent":false,"title":"t","url":"u","state":"open","updatedAt":"x","actor":"a","draft":false,"head":"h","base":"main","headRuns":[{"name":"b","status":"completed","conclusion":"success","completed_at":"2026-10-13T10:00:00Z"}],"headStatuses":[{"context":"stam/review","state":"success","description":"Review (r): ok","updated_at":"2026-10-13T10:00:00Z","created_at":null}],"statusesHead":"h","checks":"success","failing":[],"checksHead":"h","checksAt":"2026-10-13T10:00:00Z","reviewCount":2,"review":"approved","lastReview":{"state":"approved","user":"r"},"commentsSince":"2026-10-13T10:00:00Z"}`
	var s Snapshot
	if err := json.Unmarshal([]byte(ts), &s); err != nil {
		t.Fatal(err)
	}
	if s.ChecksHead == nil || *s.ChecksHead != "h" || s.ReviewCount != 2 || s.HeadStatuses[0].Context != "stam/review" || string(s.StatusesHead) != `"h"` {
		t.Errorf("read: %+v", s)
	}
	out, _ := json.Marshal(s)
	var a, b map[string]any
	_ = json.Unmarshal(out, &a)
	_ = json.Unmarshal([]byte(ts), &b)
	// TS writes absent:false and an empty failing list; Go leaves both out, and readers take them as false and empty.
	delete(b, "absent")
	delete(b, "failing")
	if !reflect.DeepEqual(a, b) {
		t.Errorf("round trip:\n got  %s\n want %s", out, ts)
	}
}

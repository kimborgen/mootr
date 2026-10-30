package linearpoll

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/events"
	"stam/internal/jsjson"
)

// The unit tests of test/linear-poller.test.mjs against the Go poller, and the rules the Go poller adds: restart, ticks that
// do not overlap, shutdown, a watch removed during a poll, and no secret in a log, an error, an event or a row. A fake Linear
// MCP server stands in for Linear; nothing here reaches the network beyond it.

type env struct {
	t      *testing.T
	fake   *fakeLinear
	auth   *staticAuth
	client *Client
	store  *memStore
	sink   *sink
	p      *Poller
	now    time.Time
	mu     sync.Mutex
}

func (e *env) clock() time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.now.IsZero() {
		return time.Now()
	}
	return e.now
}

// later moves the poller's clock on.
func (e *env) later(d time.Duration) {
	now := e.clock().Add(d)
	e.mu.Lock()
	e.now = now
	e.mu.Unlock()
}

func newEnv(t *testing.T, watch ...string) *env {
	t.Helper()
	e := &env{t: t, fake: newFake(t), store: newMem(watch...), sink: &sink{}}
	e.store.sink, e.store.now = e.sink, e.clock
	e.auth = &staticAuth{url: e.fake.url(), token: goodToken}
	e.client = NewClient(e.auth, nil)
	e.p = e.newPoller(e.store)
	return e
}

func (e *env) newPoller(st Store) *Poller {
	return New(Options{Store: st, Client: e.client, Now: e.clock})
}

func (e *env) tick() int {
	e.t.Helper()
	n, err := e.p.Tick(context.Background())
	if err != nil {
		e.t.Fatalf("tick: %v", err)
	}
	return n
}

func (e *env) drain() {
	for i := 0; i < 30; i++ {
		e.tick()
	}
}

func issueMap(id string, over map[string]any) map[string]any {
	m := map[string]any{"id": id, "title": "Fix login", "url": "https://linear.app/acme/issue/" + id, "state": map[string]any{"name": "Todo"}, "assignee": nil, "priority": map[string]any{"name": "High", "value": 2}, "updatedAt": "2026-10-11T10:00:00Z"}
	for k, v := range over {
		m[k] = v
	}
	return m
}

// Changes of a team are dated after the test starts (t0, ten minutes out), so each lands after the cursor its first poll sets.
var t0 = time.Now().Add(10 * time.Minute)

func at(n int) string {
	return t0.Add(time.Duration(n) * time.Millisecond).UTC().Format("2006-01-02T15:04:05.000Z")
}

const old = "2026-10-11T10:00:00.000Z"

// teamIssue is an issue of team ENG, numbered n, changed at at(n) and created before any poll.
func teamIssue(n int, over map[string]any) map[string]any {
	id := fmt.Sprintf("ENG-%d", n)
	m := map[string]any{"title": fmt.Sprintf("Issue %d", n), "updatedAt": at(n), "createdAt": old}
	for k, v := range over {
		m[k] = v
	}
	return issueMap(id, m)
}

func (e *env) bulk(count int, over func(n int) map[string]any) {
	for i := 1; i <= count; i++ {
		var o map[string]any
		if over != nil {
			o = over(i)
		}
		e.fake.setIssue(fmt.Sprintf("ENG-%d", i), teamIssue(i, o))
	}
}

var (
	c1 = map[string]any{"id": "c1", "user": map[string]any{"name": "bob"}, "body": "hi"}
	c2 = map[string]any{"id": "c2", "user": map[string]any{"name": "octocat"}, "body": "thanks"}
)

func eq[T comparable](t *testing.T, what string, got, want T) {
	t.Helper()
	if got != want {
		t.Errorf("%s: got %v, want %v", what, got, want)
	}
}

func cursorOf(t *testing.T, st *memStore, subject string) string {
	t.Helper()
	r, ok, _ := st.Row(context.Background(), subject)
	if !ok {
		t.Fatalf("no row for %s", subject)
	}
	return parseTeamRow(r.State).Cursor
}

// ---- an issue ----

func TestIssueFirstPollRecordsSilentlyThenEachChangeEmitsOnce(t *testing.T) {
	e := newEnv(t, "linear:ENG-1")
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.fake.setComments("ENG-1", c1)
	eq(t, "first poll events", e.tick(), 0)
	row, _, _ := e.store.Row(context.Background(), "linear:ENG-1")
	s := ParseSnapshot(row.State)
	eq(t, "state", deref(s.State), "Todo")
	eq(t, "priority", deref(s.Priority), "High")
	eq(t, "comment ids", strings.Join(s.CommentIDs, ","), "c1")
	eq(t, "events", e.sink.count(), 0)

	e.fake.setIssue("ENG-1", issueMap("ENG-1", map[string]any{"state": map[string]any{"name": "Done"}, "updatedAt": "2026-10-11T12:00:00Z"}))
	e.fake.setComments("ENG-1", c1, c2)
	eq(t, "second poll events", e.tick(), 2)
	eq(t, "types", strings.Join(e.sink.types(), ","), "issue.state_changed,comment.created")
	ev := e.sink.byType("comment.created")[0]
	eq(t, "summary", deref(ev.Summary), "ENG-1 comment by octocat: thanks")
	eq(t, "source", ev.Source, "linear")
	eq(t, "subjects", strings.Join(ev.Subjects, ","), "linear:ENG-1")
	eq(t, "unchanged poll events", e.tick(), 0)
	eq(t, "events after an unchanged poll", e.sink.count(), 2)
}

func TestIssueARejectedBearerKeepsTheOldSnapshot(t *testing.T) {
	e := newEnv(t, "linear:ENG-1")
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.tick()
	before, _, _ := e.store.Row(context.Background(), "linear:ENG-1")
	e.auth.token = "bad"
	e.client.ResetSessions()
	e.fake.setIssue("ENG-1", issueMap("ENG-1", map[string]any{"state": map[string]any{"name": "Done"}, "updatedAt": "z"}))
	eq(t, "events", e.tick(), 0)
	after, _, _ := e.store.Row(context.Background(), "linear:ENG-1")
	eq(t, "snapshot", after, before)
	// The login comes back: the change lands once.
	e.auth.token = goodToken
	eq(t, "events after the login", e.tick(), 1)
	eq(t, "type", e.sink.types()[0], "issue.state_changed")
}

func TestIssueANotJSONAnswerRecordsAnEmptySnapshotLikeTS(t *testing.T) {
	// normalizeIssue(jsonOf(...)) of a text that is not JSON is an issue of nulls; TS stores it, and so does Go.
	e := newEnv(t, "linear:ENG-1")
	e.fake.setIssue("ENG-1", nil)
	e.tick()
	row, ok, _ := e.store.Row(context.Background(), "linear:ENG-1")
	if !ok || !strings.Contains(row.State, `"title":null`) {
		t.Errorf("%v %q", ok, row.State)
	}
}

func TestIgnoredSubjectsAreSkippedAndLoggedOnce(t *testing.T) {
	var buf bytes.Buffer
	defer swapLog(&buf)()
	e := newEnv(t, "linear:weird", "github:o/r", "linear:ENG-1")
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.tick()
	e.tick()
	eq(t, "log lines naming the subject", strings.Count(buf.String(), "ignoring subject linear:weird"), 1)
	if e.store.has("github:o/r") || e.store.has("linear:weird") {
		t.Error("a subject that is not polled got a row")
	}
	if !e.store.has("linear:ENG-1") {
		t.Error("the issue was not polled")
	}
}

func swapLog(w *bytes.Buffer) func() {
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&lockedWriter{w: w}, nil)))
	return func() { slog.SetDefault(prev) }
}

var logMu sync.Mutex

type lockedWriter struct{ w *bytes.Buffer }

func (l *lockedWriter) Write(p []byte) (int, error) {
	logMu.Lock()
	defer logMu.Unlock()
	return l.w.Write(p)
}

// ---- a team ----

const team = "linear:team:ENG"

func TestTeamFirstPollSetsCursorAndBaselineToNowAndListsNoHistory(t *testing.T) {
	e := newEnv(t, team)
	e.fake.setIssue("ENG-1", teamIssue(1, map[string]any{"updatedAt": old}))
	e.fake.setIssue("ENG-2", teamIssue(2, map[string]any{"updatedAt": old}))
	eq(t, "events", e.tick(), 0)
	eq(t, "issue rows", e.store.rowsUnder(team+"/"), 0)
	eq(t, "list calls", e.fake.callCount("list_issues"), 0)
	r, _, _ := e.store.Row(context.Background(), team)
	row := parseTeamRow(r.State)
	eq(t, "cursor is the baseline", row.Cursor, row.Baseline)
	if row.Cursor <= old {
		t.Errorf("the baseline %s is not now", row.Cursor)
	}
}

func TestTeamAChangeAfterTheFirstPollEmitsUpdatedThenStateAndComment(t *testing.T) {
	e := newEnv(t, team)
	e.fake.setIssue("ENG-1", teamIssue(1, map[string]any{"updatedAt": old}))
	e.fake.setComments("ENG-1", c1)
	e.tick()
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	eq(t, "events", e.tick(), 1)
	up := e.sink.byType("issue.updated")[0]
	eq(t, "subjects", strings.Join(up.Subjects, ","), team)
	eq(t, "payload text", payloadIssue(up), "linear:ENG-1")
	eq(t, "key", up.DedupeKey, "issue.updated:"+team+":linear:ENG-1:"+at(1))
	row, _, _ := e.store.Row(context.Background(), team+"/ENG-1")
	eq(t, "comments seen", strings.Join(ParseSnapshot(row.State).CommentIDs, ","), "c1")

	e.fake.setIssue("ENG-1", teamIssue(1, map[string]any{"state": map[string]any{"name": "Done"}, "updatedAt": at(2)}))
	e.fake.setComments("ENG-1", c1, c2)
	eq(t, "events", e.tick(), 2)
	st := e.sink.byType("issue.state_changed")[0]
	eq(t, "subjects", strings.Join(st.Subjects, ","), team)
	eq(t, "payload", payloadIssue(st), "linear:ENG-1")
	eq(t, "key", st.DedupeKey, "issue.state_changed:"+team+":linear:ENG-1:"+at(2))
	eq(t, "summary", deref(st.Summary), "ENG-1 state: Todo → Done")
	eq(t, "comments", len(e.sink.byType("comment.created")), 1)
	eq(t, "quiet tick", e.tick(), 0)
	eq(t, "comments after", len(e.sink.byType("comment.created")), 1)
}

func payloadIssue(in events.Input) string {
	if o, ok := in.Payload.(*jsjson.Object); ok {
		v, _ := o.Get("issue")
		return fmt.Sprint(v)
	}
	return ""
}

func TestTeamAnIssueCreatedAfterTheFirstPollEmitsCreatedNotUpdated(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.fake.setIssue("ENG-2", teamIssue(2, map[string]any{"createdAt": at(2), "updatedAt": at(2)}))
	eq(t, "events", e.tick(), 1)
	c := e.sink.byType("issue.created")
	eq(t, "created", len(c), 1)
	eq(t, "summary", deref(c[0].Summary), "ENG-2 created: Issue 2")
	eq(t, "key", c[0].DedupeKey, "issue.created:"+team+":linear:ENG-2")
	eq(t, "updated", len(e.sink.byType("issue.updated")), 0)
}

func TestTeamManyIssuesAtOneUpdatedAtCannotStallTheCursor(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.bulk(12, func(int) map[string]any { return map[string]any{"updatedAt": at(1)} })
	e.drain()
	eq(t, "snapshots", e.store.rowsUnder(team+"/"), 12)
	e.bulk(12, func(int) map[string]any {
		return map[string]any{"state": map[string]any{"name": "Done"}, "updatedAt": at(5)}
	})
	e.fake.setIssue("ENG-1", teamIssue(1, map[string]any{"title": "Renamed", "state": map[string]any{"name": "Done"}, "updatedAt": at(9)}))
	for i := 0; i < 6 && len(e.sink.byType("issue.title_changed")) == 0; i++ {
		e.tick()
	}
	eq(t, "renames", len(e.sink.byType("issue.title_changed")), 1)
	eq(t, "state changes", len(e.sink.byType("issue.state_changed")), 12)
}

func TestTeamChangesNeverSnapshottedEmitUpdatedPastTheCapOfTen(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.bulk(15, nil)
	e.drain()
	eq(t, "updated", len(e.sink.byType("issue.updated")), 15)
}

func TestTeamAtMostTenCommentCallsATick(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.bulk(15, nil)
	e.tick()
	eq(t, "comment calls in one tick", e.fake.callCount("list_comments"), teamCommentsPerTick)
	eq(t, "snapshots after one tick", e.store.rowsUnder(team+"/"), teamCommentsPerTick)
	e.tick()
	eq(t, "snapshots after two", e.store.rowsUnder(team+"/"), 15)
}

func TestTeamEveryPageIsReadWhicheverOrderLinearListsThemIn(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.fake.desc = true
	e.bulk(120, nil)
	e.drain()
	eq(t, "snapshots", e.store.rowsUnder(team+"/"), 120)
	e.fake.setIssue("ENG-1", teamIssue(1, map[string]any{"state": map[string]any{"name": "Done"}, "updatedAt": at(500)}))
	eq(t, "events", e.tick(), 1)
	eq(t, "state changes", len(e.sink.byType("issue.state_changed")), 1)
}

func TestTeamAndItsIssueEachKeepTheirOwnEvent(t *testing.T) {
	e := newEnv(t, team, "linear:ENG-1")
	e.tick()
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	e.tick()
	e.fake.setIssue("ENG-1", teamIssue(1, map[string]any{"state": map[string]any{"name": "Done"}, "updatedAt": at(2)}))
	e.tick()
	ch := e.sink.byType("issue.state_changed")
	eq(t, "state changes", len(ch), 2)
	var subs []string
	for _, c := range ch {
		subs = append(subs, strings.Join(c.Subjects, ","))
	}
	if !(contains(subs, "linear:ENG-1") && contains(subs, team)) {
		t.Errorf("subjects %v, want the issue's and the team's", subs)
	}
	eq(t, "issue-only events", len(e.sink.forSubject("linear:ENG-1", "issue.state_changed")), 1)
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func TestTeamARateLimitPausesThePollAndKeepsTheCursor(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	before := cursorOf(t, e.store, team)
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	e.fake.mu.Lock()
	e.fake.throttle = 1
	e.fake.mu.Unlock()
	eq(t, "429 events", e.tick(), 0)
	eq(t, "cursor", cursorOf(t, e.store, team), before)
	callsAfter429 := e.fake.callCount("list_issues")
	eq(t, "the pause holds", e.tick(), 0)
	eq(t, "no call during the pause", e.fake.callCount("list_issues"), callsAfter429)
	// Five minutes later the poll resumes and the change lands.
	e.mu.Lock()
	e.now = time.Now().Add(6 * time.Minute)
	e.mu.Unlock()
	eq(t, "events after the pause", e.tick(), 1)
	if strings.Contains(e.sink.all(), goodToken) {
		t.Error("the bearer is in an event")
	}
}

func TestTeamARateLimitedIssuePausesToo(t *testing.T) {
	e := newEnv(t, "linear:ENG-1")
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.tick()
	e.p.setBackoff()
	n := e.fake.callCount("get_issue")
	e.tick()
	eq(t, "calls during the pause", e.fake.callCount("get_issue"), n)
	if e.p.BackoffUntil().IsZero() {
		t.Error("no pause set")
	}
	e.p.ResetBackoff()
	e.tick()
	eq(t, "calls after the pause", e.fake.callCount("get_issue"), n+1)
}

func TestTeamLastSubscriptionGoneAWeekDropsItsCursorAndSnapshots(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	e.tick()
	if !e.store.has(team + "/ENG-1") {
		t.Fatal("no snapshot")
	}
	e.store.unwatch(team)
	e.later(8 * 24 * time.Hour)
	e.tick()
	if e.store.has(team) || e.store.has(team+"/ENG-1") {
		t.Error("the team's rows stay after its last watch went a week ago")
	}
}

func TestAQuietTeamKeepsItsCursorAfterItsWatchGoes(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	e.tick()
	// Five quiet days: each tick lists nothing new, and the cursor row is stored again.
	e.later(5 * 24 * time.Hour)
	eq(t, "events on a quiet tick", e.tick(), 0)
	e.later(3 * 24 * time.Hour)
	e.store.unwatch(team)
	e.tick()
	if !e.store.has(team) || !e.store.has(team+"/ENG-1") {
		t.Error("the cursor or a snapshot of a team watched until three days ago is gone")
	}
}

func TestAFailingIssueWhoseIdHas429DoesNotPauseThePoller(t *testing.T) {
	e := newEnv(t, "linear:ENG-429", "linear:ENG-5")
	e.fake.setIssue("ENG-5", issueMap("ENG-5", nil))
	e.tick()
	eq(t, "calls: the failing issue and the next one", e.fake.callCount("get_issue"), 2)
	if !e.p.BackoffUntil().IsZero() {
		t.Error("an issue id with 429 paused all polling")
	}
	if !e.store.has("linear:ENG-5") {
		t.Error("the issue after the failing one was not polled")
	}
}

func TestRateLimitedMatchesTheStatusAndTheMessageNotAnIssueId(t *testing.T) {
	for _, c := range []struct {
		err  error
		want bool
	}{
		{&StatusError{Server: "linear", Tool: "get_issue", Status: 429}, true},
		{fmt.Errorf("wrapped: %w", &StatusError{Status: 429}), true},
		{errors.New("linear get_issue: HTTP 429"), true},
		{errors.New("Rate limit exceeded"), true},
		{errors.New("no issue ENG-429"), false},
		{&StatusError{Status: 500}, false},
	} {
		if got := rateLimited(c.err); got != c.want {
			t.Errorf("rateLimited(%v) = %v, want %v", c.err, got, c.want)
		}
	}
}

func TestTeamAListThatIgnoresAfterFailsThePollAndMovesNoCursor(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.fake.ignoreAfter = true
	e.bulk(120, nil)
	before := cursorOf(t, e.store, team)
	eq(t, "events", e.tick(), 0)
	eq(t, "cursor", cursorOf(t, e.store, team), before)
	eq(t, "snapshots from a failed list", e.store.rowsUnder(team+"/"), 0)
	eq(t, "pages read: the repeat of a cursor stops the list", e.fake.callCount("list_issues"), 2)
}

func TestTeamAListThatNeverRunsOutFailsAtThePageCap(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.fake.endless = true
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	before := cursorOf(t, e.store, team)
	eq(t, "events", e.tick(), 0)
	eq(t, "cursor", cursorOf(t, e.store, team), before)
	eq(t, "pages read", e.fake.callCount("list_issues"), teamPagesMax)
}

func TestTeamAFailedCommentCallStoresTheProgressSoFarAndNothingPastIt(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	e.fake.setIssue("ENG-2", teamIssue(2, nil))
	// ENG-2's comment call fails: the cursor moves past ENG-1 only, and ENG-2 lands on the next tick.
	e.fake.mu.Lock()
	e.fake.fail = func(tool string, n int) bool { return tool == "list_comments" && n == 2 }
	e.fake.mu.Unlock()
	e.tick()
	eq(t, "cursor", cursorOf(t, e.store, team), at(1))
	if !e.store.has(team+"/ENG-1") || e.store.has(team+"/ENG-2") {
		t.Error("the snapshots are not ENG-1 alone")
	}
	e.tick()
	eq(t, "updated events", len(e.sink.byType("issue.updated")), 2)
}

// ---- restart ----

func TestRestartPollsOnFromTheStoredStateWithoutRepeatsOrGaps(t *testing.T) {
	st := newMem("linear:ENG-1", team)
	e := newEnv(t)
	st.sink, st.now = e.sink, e.clock
	e.store = st
	e.p = e.newPoller(st)
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.fake.setComments("ENG-1", c1)
	e.tick()
	// The daemon restarts: a new poller and a new client (no session) on the same database and the same event log.
	restart := func() *Poller {
		e.client = NewClient(e.auth, nil)
		return e.newPoller(st)
	}
	e.p = restart()
	eq(t, "unchanged events", e.tick(), 0)
	eq(t, "events", e.sink.count(), 0)

	e.p = restart()
	e.fake.setIssue("ENG-1", issueMap("ENG-1", map[string]any{"state": map[string]any{"name": "Done"}, "priority": map[string]any{"name": "Urgent"}, "updatedAt": "2026-10-11T12:00:00Z"}))
	e.fake.setComments("ENG-1", c1, c2)
	e.tick()
	eq(t, "types", strings.Join(e.sink.types(), ","), "issue.state_changed,issue.priority_changed,comment.created")
	// Another restart and the same state: nothing repeats.
	e.p = restart()
	eq(t, "events after another restart", e.tick(), 0)
	eq(t, "event count", e.sink.count(), 3)
}

func TestRestartAfterAPollThatStoredNothingLosesNoEventAndRepeatsNone(t *testing.T) {
	st := newMem("linear:ENG-1")
	e := newEnv(t)
	st.sink, st.now = e.sink, e.clock
	fs := &failingStore{memStore: st}
	e.p = e.newPoller(fs)
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.p.Tick(context.Background())
	e.fake.setIssue("ENG-1", issueMap("ENG-1", map[string]any{"state": map[string]any{"name": "Done"}, "updatedAt": "2026-10-11T12:00:00Z"}))
	// This poll stops before its transaction commits: neither the events nor the snapshot land.
	fs.fail = true
	e.p.Tick(context.Background())
	eq(t, "events in", e.sink.count(), 0)
	// After the restart the poll finds the change again, and the events and the snapshot land together.
	fs.fail = false
	e.p = e.newPoller(fs)
	eq(t, "events after the restart", e.tick(), 1)
	eq(t, "events stored", e.sink.count(), 1)
	row, _, _ := st.Row(context.Background(), "linear:ENG-1")
	eq(t, "snapshot state", deref(ParseSnapshot(row.State).State), "Done")
	eq(t, "quiet", e.tick(), 0)
}

type failingStore struct {
	*memStore
	fail bool
}

func (f *failingStore) Apply(ctx context.Context, w, s string, evs []events.Input, state string) (int, bool, error) {
	if f.fail {
		return 0, false, errors.New("crash")
	}
	return f.memStore.Apply(ctx, w, s, evs, state)
}

// ---- ticks ----

func TestATickNeverOverlapsThePreviousOne(t *testing.T) {
	e := newEnv(t, "linear:ENG-1")
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	inTick, release := make(chan struct{}), make(chan struct{})
	var first atomic.Bool
	e.p.hookAfterPoll = func(string) {
		if first.CompareAndSwap(false, true) {
			close(inTick)
			<-release
		}
	}
	done := make(chan struct{})
	go func() { e.p.Tick(context.Background()); close(done) }()
	<-inTick
	if _, err := e.p.Tick(context.Background()); !errors.Is(err, ErrBusy) {
		t.Errorf("a second tick during the first answered %v, want ErrBusy", err)
	}
	close(release)
	<-done
	if _, err := e.p.Tick(context.Background()); err != nil {
		t.Errorf("a tick after the first: %v", err)
	}
}

func TestCloseWaitsForTheTickInFlight(t *testing.T) {
	e := newEnv(t, "linear:ENG-1")
	e.p = New(Options{Store: e.store, Client: e.client, Interval: 10 * time.Millisecond})
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	inTick, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	e.p.hookAfterPoll = func(string) { once.Do(func() { close(inTick) }); <-release }
	e.p.Start(context.Background())
	<-inTick
	closed := make(chan struct{})
	go func() { e.p.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("Close returned while a tick was in flight")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not return after the tick ended")
	}
	// No tick starts after Close.
	n := e.fake.callCount("get_issue")
	time.Sleep(50 * time.Millisecond)
	eq(t, "calls after Close", e.fake.callCount("get_issue"), n)
	e.p.Start(context.Background())
	e.p.Close()
}

func TestStartDoesNothingForAnIntervalOfZero(t *testing.T) {
	e := newEnv(t, "linear:ENG-1")
	e.p.Start(context.Background())
	e.p.Close()
	eq(t, "calls", e.fake.callCount("get_issue"), 0)
}

// ---- a watch that goes during a poll ----

func TestIssueUnwatchedDuringAPollPostsAndStoresNothing(t *testing.T) {
	e := newEnv(t, "linear:ENG-1")
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.tick()
	e.fake.setIssue("ENG-1", issueMap("ENG-1", map[string]any{"state": map[string]any{"name": "Done"}, "updatedAt": "z"}))
	before, _, _ := e.store.Row(context.Background(), "linear:ENG-1")
	e.p.hookAfterPoll = func(string) { e.store.unwatch("linear:ENG-1") }
	eq(t, "events", e.tick(), 0)
	eq(t, "events posted", e.sink.count(), 0)
	after, _, _ := e.store.Row(context.Background(), "linear:ENG-1")
	eq(t, "row", after, before)
}

func TestTeamUnwatchedDuringAPollIsNotResurrectedAndIsDroppedAfterAWeek(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	e.fake.setIssue("ENG-2", teamIssue(2, nil))
	polled := 0
	e.p.hookAfterPoll = func(string) {
		polled++
		if polled == 1 {
			// The last watch goes while the first issue is polled.
			e.store.unwatch(team)
		}
	}
	eq(t, "events counted", e.tick(), 0)
	eq(t, "issue snapshots written for an unwatched team", e.store.rowsUnder(team+"/"), 0)
	eq(t, "events posted", e.sink.count(), 0)
	// Its cursor stays a week (a watch that comes back reuses it), and only that.
	if !e.store.has(team) {
		t.Error("the cursor of a team unwatched for a minute was dropped")
	}
	e.p.hookAfterPoll = nil
	dropped := false
	e.p.hookBeforeDrop = func() {
		dropped = true
		if e.p.running.Load() == false {
			t.Error("the drop ran outside a tick")
		}
	}
	e.later(8 * 24 * time.Hour)
	e.tick()
	if !dropped {
		t.Error("the team unwatched for eight days was not dropped")
	}
	eq(t, "rows left", e.store.rowsUnder("linear:team:ENG"), 0)
	// A later tick never brings them back.
	e.tick()
	eq(t, "rows after another tick", e.store.rowsUnder("linear:team:ENG"), 0)
}

func TestARowIsKeptForAWeekAfterTheLastWatchAndThenDropped(t *testing.T) {
	for _, subject := range []string{"linear:ENG-1", team} {
		e := newEnv(t, subject)
		e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
		e.tick()
		e.tick()
		e.store.unwatch(subject)
		e.later(6*24*time.Hour + 23*time.Hour)
		e.tick()
		if !e.store.has(subject) {
			t.Errorf("%s: the row of a watch gone for under a week was dropped", subject)
		}
		e.later(2 * time.Hour)
		e.tick()
		if e.store.has(subject) {
			t.Errorf("%s: the row of a watch gone for over a week stays", subject)
		}
	}
}

func TestAWatchThatComesBackWithinAWeekReusesItsSnapshot(t *testing.T) {
	e := newEnv(t, "linear:ENG-1")
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.tick()
	e.store.unwatch("linear:ENG-1")
	e.later(3 * 24 * time.Hour)
	e.tick()
	e.fake.setIssue("ENG-1", issueMap("ENG-1", map[string]any{"state": map[string]any{"name": "Done"}, "updatedAt": "2026-10-11T12:00:00Z"}))
	e.store.watch("linear:ENG-1")
	eq(t, "events", e.tick(), 1)
	eq(t, "type", e.sink.types()[0], "issue.state_changed")
}

func TestTeamUnwatchedDuringAPollPostsNothing(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	e.p.hookAfterPoll = func(string) { e.store.unwatch(team) }
	eq(t, "events", e.tick(), 0)
	eq(t, "events posted", e.sink.count(), 0)
}

func TestTeamWatchedAgainBeforeTheDropKeepsItsRows(t *testing.T) {
	e := newEnv(t, team)
	e.tick()
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	e.tick()
	e.store.unwatch(team)
	e.later(8 * 24 * time.Hour)
	e.p.hookBeforeDrop = func() { e.store.watch(team) }
	e.tick()
	if !e.store.has(team) || !e.store.has(team+"/ENG-1") {
		t.Error("a watch added after the list was read lost its rows")
	}
}

// ---- no secret anywhere ----

func TestNoSecretReachesALogAnErrorAnEventOrAStoredRow(t *testing.T) {
	var buf bytes.Buffer
	defer swapLog(&buf)()
	e := newEnv(t, "linear:ENG-1", "linear:ENG-404", team)
	e.fake.echo = true
	e.fake.setIssue("ENG-1", issueMap("ENG-1", map[string]any{"title": "x"}))
	e.fake.setComments("ENG-1", c1)
	e.tick()
	// An unknown issue: the tool's error repeats the bearer it was sent. A throttled list echoes it too.
	e.fake.setIssue("ENG-1", issueMap("ENG-1", map[string]any{"state": map[string]any{"name": "Done"}, "updatedAt": "z"}))
	e.fake.mu.Lock()
	e.fake.throttle = 1
	e.fake.mu.Unlock()
	e.fake.setIssue("ENG-2", teamIssue(2, nil))
	e.tick()
	e.p.ResetBackoff()
	e.tick()
	// A bad bearer: the 401's body repeats it.
	e.auth.token = "wrong-secret-token-abcdef"
	e.client.ResetSessions()
	e.p.ResetBackoff()
	e.tick()
	if !strings.Contains(buf.String(), "linear: ") {
		t.Fatal("no failure was logged, so the test checks nothing")
	}
	for _, secret := range []string{goodToken, "wrong-secret-token-abcdef"} {
		if strings.Contains(buf.String(), secret) {
			t.Errorf("the log carries %q:\n%s", secret, buf.String())
		}
		if strings.Contains(e.sink.all(), secret) {
			t.Errorf("an event carries %q", secret)
		}
		e.store.mu.Lock()
		for k, r := range e.store.rows {
			if strings.Contains(r.State, secret) || strings.Contains(k, secret) {
				t.Errorf("row %s carries %q", k, secret)
			}
		}
		e.store.mu.Unlock()
	}
}

// ---- the dashboard ----

func TestStateForShowsTheIssueAndAnUnpolledSubject(t *testing.T) {
	e := newEnv(t, "linear:ENG-1")
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.tick()
	out, err := StateFor(context.Background(), e.store, []string{"linear:ENG-1", "linear:ENG-9"})
	if err != nil {
		t.Fatal(err)
	}
	v := out["linear:ENG-1"].(StateView)
	eq(t, "state", deref(v.State), "Todo")
	eq(t, "title", deref(v.Title), "Fix login")
	eq(t, "priority", deref(v.Priority), "High")
	if v.UpdatedAt == "" {
		t.Error("no updated_at")
	}
	if _, ok := out["linear:ENG-9"].(NoState); !ok {
		t.Errorf("%T", out["linear:ENG-9"])
	}
}

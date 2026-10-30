package linearpoll

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/events"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The poller on the real database: the TS daemon's schema, the events service of the daemon, and the transactions the rules
// rest on (the commit's check of its watchers, the cleanup's delete), each proved with the competing writer observed in the
// writer's queue (DB.WaitingWrites).

var fixture string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "stam-linearpoll-fixture-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	code := func() int {
		defer os.RemoveAll(dir)
		home := filepath.Join(dir, "home")
		if err := os.Mkdir(home, 0o700); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		// The production writer: the TS daemon's own schema and agents (aboss, achild paused, agone archived).
		if out, err := exec.Command("node", "../db/testdata/make-fixture.mjs", home).CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "make-fixture.mjs: %v\n%s", err, out)
			return 1
		}
		fixture = filepath.Join(home, "stam.db")
		return m.Run()
	}()
	os.Exit(code)
}

type nopHost struct{}

func (nopHost) QueueNoticeRow(context.Context, string, string, int64) {}
func (nopHost) MailAgent(context.Context, string, string, string, events.Commit) error {
	return nil
}
func (nopHost) MailHuman(context.Context, string, string, string, events.Commit) (string, error) {
	return "m", nil
}
func (nopHost) PostItsa(context.Context, string, string) (bool, error) { return false, nil }
func (nopHost) Render(string, map[string]string) (string, error) {
	return "", errors.New("no template")
}
func (nopHost) WithFailureRetro(t string) string { return t }

type noTimers struct{}

func (noTimers) AfterFunc(time.Duration, func()) func() bool { return func() bool { return false } }

type safeBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *safeBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}
func (s *safeBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// denv is a poller's world on the real database and the real events service, with the fake Linear.
type denv struct {
	t    *testing.T
	path string
	db   *db.DB
	svc  *events.Service
	fake *fakeLinear
	auth *staticAuth
	logs *safeBuf
	// skew moves the clock of the poller, the store and the events service on, for the retention.
	skew time.Duration
}

func (e *denv) clock() time.Time { return time.Now().Add(e.skew) }

func newDenv(t *testing.T) *denv {
	t.Helper()
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "stam.db")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	e := &denv{t: t, path: path, fake: newFake(t), logs: &safeBuf{}}
	e.auth = &staticAuth{url: e.fake.url(), token: goodToken}
	e.boot()
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(e.logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return e
}

// boot opens the database and the service: the daemon starting. close shuts them: the daemon stopping.
func (e *denv) boot() {
	d, err := db.Open(context.Background(), e.path, db.Options{})
	if err != nil {
		e.t.Fatal(err)
	}
	e.db = d
	e.svc = events.New(events.Options{DB: d, Host: nopHost{}, Timers: noTimers{}, Now: e.clock, Fold: func() time.Duration { return 0 }})
}

func (e *denv) close() {
	e.svc.Close()
	e.db.Close()
}

// poller is a poller as a daemon start makes it: a new client, no session.
func (e *denv) poller() *Poller {
	return New(Options{Store: DBStore{DB: e.db, Svc: e.svc, Now: e.clock}, Client: NewClient(e.auth, nil), Now: e.clock})
}

var subSeq int

func (e *denv) watch(subject string) string {
	e.t.Helper()
	subSeq++
	id := fmt.Sprintf("es-l%d", subSeq)
	s := db.Subscription{ID: id, SubscriberKind: "agent", SubscriberID: "aboss", Filter: events.Filter{Source: "linear", Subjects: []string{subject}}.JSON(), CreatedBy: "aboss", CreatedAt: "2026-10-28T11:00:00.000Z"}
	if err := e.db.InsertSubscription(context.Background(), s); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func (e *denv) unwatch(id string) {
	e.t.Helper()
	if _, err := e.db.RemoveSubscription(context.Background(), id); err != nil {
		e.t.Fatal(err)
	}
}

func (e *denv) tick(p *Poller) int {
	e.t.Helper()
	n, err := p.Tick(context.Background())
	if err != nil {
		e.t.Fatalf("tick: %v", err)
	}
	return n
}

func (e *denv) stored() []db.ExtEvent {
	e.t.Helper()
	out, err := e.db.ListExtEvents(context.Background(), "", 500)
	if err != nil {
		e.t.Fatal(err)
	}
	return out
}

func (e *denv) types() string {
	var out []string
	l := e.stored()
	for i := len(l) - 1; i >= 0; i-- {
		out = append(out, l[i].Type)
	}
	return strings.Join(out, ",")
}

func (e *denv) row(subject string) (Row, bool) {
	e.t.Helper()
	r, ok, err := DBStore{DB: e.db}.Row(context.Background(), subject)
	if err != nil {
		e.t.Fatal(err)
	}
	return r, ok
}

func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting: %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func done(state string) map[string]any {
	return issueMap("ENG-1", map[string]any{"state": map[string]any{"name": state}, "updatedAt": "2026-10-11T12:00:00Z"})
}

// Poll, restart, poll unchanged: no event. A change between the restarts: exactly its events, once.
func TestRestartOnTheRealDatabaseRepeatsNoEventAndMissesNone(t *testing.T) {
	e := newDenv(t)
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.fake.setComments("ENG-1", c1)
	e.watch("linear:ENG-1")
	e.watch(team)
	e.tick(e.poller())
	if got := e.types(); got != "" {
		t.Fatalf("the first polls emitted %q", got)
	}
	e.close()
	e.boot()
	t.Cleanup(e.close)
	if n := e.tick(e.poller()); n != 0 || e.types() != "" {
		t.Fatalf("an unchanged poll after a restart emitted %d: %q", n, e.types())
	}
	// A change while the daemon is down, found by the first poll after the restart.
	e.fake.setIssue("ENG-1", done("Done"))
	e.fake.setComments("ENG-1", c1, c2)
	e.tick(e.poller())
	want := "issue.state_changed,comment.created"
	// The team lists ENG-1 too, changed after its baseline? It was changed at 2026-10-11, before: no team event.
	if got := e.types(); got != want {
		t.Fatalf("types %q, want %q", got, want)
	}
	// Another restart and nothing changed: nothing repeats.
	e.close()
	e.boot()
	if n := e.tick(e.poller()); n != 0 || e.types() != want {
		t.Fatalf("a poll after another restart emitted %d: %q", n, e.types())
	}
}

// The events and the snapshot are one transaction: a write that fails after the events went in (a trigger aborts the snapshot's
// insert) leaves neither, and the poll after the restart stores both once.
func TestAStopBetweenTheEventsAndTheSnapshotLeavesNeitherAndTheRestartStoresBothOnce(t *testing.T) {
	e := newDenv(t)
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.watch("linear:ENG-1")
	e.tick(e.poller())
	e.fake.setIssue("ENG-1", done("Done"))
	before, _ := e.row("linear:ENG-1")
	trigger := func(sql string) {
		t.Helper()
		if err := e.db.Write(context.Background(), func(conn *sqlite.Conn) error { return sqlitex.ExecuteScript(conn, sql, nil) }); err != nil {
			t.Fatal(err)
		}
	}
	trigger("CREATE TRIGGER stop_snapshot BEFORE UPDATE ON watch_state WHEN NEW.subject = 'linear:ENG-1' BEGIN SELECT RAISE(ABORT, 'stopped'); END;")
	if _, err := e.poller().Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.types() != "" {
		t.Fatalf("types %q: the events stayed although the snapshot did not land", e.types())
	}
	if r, _ := e.row("linear:ENG-1"); r != before {
		t.Fatalf("the snapshot changed: %+v", r)
	}
	e.close()
	e.boot()
	t.Cleanup(e.close)
	trigger("DROP TRIGGER stop_snapshot;")
	e.tick(e.poller())
	if e.types() != "issue.state_changed" {
		t.Errorf("types after the restart %q, want the one event", e.types())
	}
	if r, _ := e.row("linear:ENG-1"); !strings.Contains(r.State, `"state":"Done"`) {
		t.Errorf("the snapshot did not land after the restart: %s", r.State)
	}
	e.tick(e.poller())
	if e.types() != "issue.state_changed" {
		t.Errorf("a quiet poll repeated an event: %q", e.types())
	}
}

// The transaction's own check: the unwatch is queued in the writer and the poll's apply queued behind it (both observed), so a
// check made before the transaction would still see the watch. Neither the events nor the row may land.
func TestAnApplyQueuedBehindAnUnwatchStoresNothing(t *testing.T) {
	for _, tc := range []struct {
		name, subject, snap string
		setup, change       func(e *denv)
	}{
		{"an issue", "linear:ENG-1", "linear:ENG-1", func(e *denv) { e.fake.setIssue("ENG-1", issueMap("ENG-1", nil)) },
			func(e *denv) { e.fake.setIssue("ENG-1", done("Done")) }},
		{"a team's issue snapshot", team, team + "/ENG-1", func(e *denv) { e.fake.setIssue("ENG-1", teamIssue(1, nil)) },
			func(e *denv) {
				e.fake.setIssue("ENG-1", teamIssue(1, map[string]any{"updatedAt": at(2), "state": map[string]any{"name": "Done"}}))
			}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newDenv(t)
			t.Cleanup(e.close)
			tc.setup(e)
			id := e.watch(tc.subject)
			p := e.poller()
			e.tick(p)
			if tc.subject == team {
				e.tick(p)
			}
			tc.change(e)
			before, _ := e.row(tc.snap)
			setup := e.types()
			hold, free := make(chan struct{}), make(chan struct{})
			go func() {
				_ = e.db.Write(context.Background(), func(*sqlite.Conn) error {
					close(hold)
					<-free
					return nil
				})
			}()
			<-hold
			go e.unwatch(id)
			waitFor(t, func() bool { return e.db.WaitingWrites() == 1 }, "the unwatch is queued")
			finished := make(chan struct{})
			go func() { _, _ = p.Tick(context.Background()); close(finished) }()
			waitFor(t, func() bool { return e.db.WaitingWrites() == 2 }, "the apply is queued behind the unwatch")
			close(free)
			<-finished
			if r, ok := e.row(tc.snap); !ok || r != before {
				t.Errorf("the apply wrote after the unwatch: %+v, was %+v", r, before)
			}
			if got := e.types(); got != setup {
				t.Errorf("events %q, were %q", got, setup)
			}
		})
	}
}

// The check and the write of an apply are one transaction: a writer that runs between them (the unwatch, then the cleanup)
// would get its drop undone by a split apply's write. Hold the apply's transaction open until that writer is queued behind
// it; in one transaction the writer then finds the row and drops it.
func TestAnApplyAndItsCheckAreOneTransaction(t *testing.T) {
	e := newDenv(t)
	t.Cleanup(e.close)
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	id := e.watch(team)
	p := e.poller()
	e.tick(p)
	queued := false
	finished := make(chan struct{})
	var once sync.Once
	db.TestHookWatchCommit = func() {
		once.Do(func() {
			base := e.db.WaitingWrites()
			go func() {
				defer close(finished)
				// The unwatch and the cleanup that follows it, as one write: what a split commit would write over.
				_ = e.db.Write(context.Background(), func(conn *sqlite.Conn) error {
					return sqlitex.ExecuteScript(conn, "DELETE FROM event_subscriptions WHERE id = '"+id+"'; DELETE FROM watch_state WHERE subject = '"+team+"' OR substr(subject, 1, 16) = '"+team+"/';", nil)
				})
			}()
			waitFor(t, func() bool { return e.db.WaitingWrites() > base }, "the unwatch is queued behind the apply")
			queued = true
		})
	}
	t.Cleanup(func() { db.TestHookWatchCommit = nil })
	e.tick(p)
	<-finished
	if !queued {
		t.Fatal("the competing writer was never seen queued")
	}
	if _, ok := e.row(team); ok {
		t.Error("the team's cursor row is back after its drop")
	}
	if _, ok := e.row(team + "/ENG-1"); ok {
		t.Error("the team's snapshot is back after its drop")
	}
}

// The cleanup's delete reads the watchers in its own transaction: a watch added after the list was read keeps its rows.
func TestCleanupRechecksTheWatchersInsideItsDelete(t *testing.T) {
	e := newDenv(t)
	t.Cleanup(e.close)
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	id := e.watch(team)
	p := e.poller()
	e.tick(p)
	e.tick(p)
	if _, ok := e.row(team + "/ENG-1"); !ok {
		t.Fatal("no snapshot")
	}
	e.unwatch(id)
	e.skew = 8 * 24 * time.Hour
	p.hookBeforeDrop = func() { e.watch(team) }
	e.tick(p)
	if _, ok := e.row(team); !ok {
		t.Error("a watch added during the cleanup lost its cursor")
	}
	if _, ok := e.row(team + "/ENG-1"); !ok {
		t.Error("a watch added during the cleanup lost its snapshots")
	}
}

// A subject nobody has watched for a week loses its rows, a team its cursor and every snapshot under it, and nothing else: not
// a team whose name starts the same, not a subject unwatched for less.
func TestAnUnwatchedSubjectIsDroppedAfterAWeekWithItsSnapshotsAndNothingElse(t *testing.T) {
	e := newDenv(t)
	t.Cleanup(e.close)
	e.fake.setIssue("ENG-1", teamIssue(1, nil))
	id := e.watch(team)
	e.watch("linear:team:ENGX")
	issue := e.watch("linear:ENG-1")
	p := e.poller()
	e.tick(p)
	e.tick(p)
	e.unwatch(id)
	e.unwatch(issue)
	e.skew = 6*24*time.Hour + 23*time.Hour
	e.tick(p)
	for _, s := range []string{team, team + "/ENG-1", "linear:ENG-1"} {
		if _, ok := e.row(s); !ok {
			t.Errorf("%s was dropped after less than a week", s)
		}
	}
	e.skew = 8 * 24 * time.Hour
	e.tick(p)
	if _, ok := e.row(team); ok {
		t.Error("the team's cursor stays")
	}
	if _, ok := e.row(team + "/ENG-1"); ok {
		t.Error("the team's snapshot stays")
	}
	if _, ok := e.row("linear:ENG-1"); ok {
		t.Error("an issue's row stays after a week")
	}
	if _, ok := e.row("linear:team:ENGX"); !ok {
		t.Error("a team whose name starts the same lost its cursor")
	}
}

// Close waits for the tick in flight, so the database can close after it.
func TestCloseBeforeTheDatabaseWaitsForTheTickAndLeavesNoHalfWrite(t *testing.T) {
	e := newDenv(t)
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.watch("linear:ENG-1")
	p := New(Options{Store: DBStore{DB: e.db, Svc: e.svc}, Client: NewClient(e.auth, nil), Interval: 5 * time.Millisecond})
	in, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	p.hookAfterPoll = func(string) { once.Do(func() { close(in); <-release }) }
	p.Start(context.Background())
	<-in
	closed := make(chan struct{})
	go func() { p.Close(); e.svc.Close(); e.db.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("the database closed while a tick was in flight")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("shutdown hangs")
	}
}

// The login's bearer is in no log line, no stored event and no stored row of the real database.
func TestNoSecretInTheLogTheStoredEventsOrTheStoredRows(t *testing.T) {
	e := newDenv(t)
	t.Cleanup(e.close)
	e.fake.echo = true
	e.fake.setIssue("ENG-1", issueMap("ENG-1", nil))
	e.watch("linear:ENG-1")
	e.watch("linear:ENG-404")
	e.watch(team)
	p := e.poller()
	e.tick(p)
	e.fake.setIssue("ENG-1", done("Done"))
	e.fake.setIssue("ENG-2", teamIssue(2, nil))
	e.tick(p)
	e.auth.token = "wrong-secret-token-abcdef"
	p = e.poller()
	e.tick(p)
	if !strings.Contains(e.logs.String(), "linear: ") {
		t.Fatal("no failure was logged, so the test checks nothing")
	}
	var all strings.Builder
	all.WriteString(e.logs.String())
	for _, ev := range e.stored() {
		all.WriteString(fmt.Sprintf("%+v ", ev))
	}
	rows, _ := DBStore{DB: e.db}.StateSubjects(context.Background(), "linear:")
	for _, s := range rows {
		r, _ := e.row(s)
		all.WriteString(s + r.State)
	}
	for _, secret := range []string{goodToken, "wrong-secret-token-abcdef"} {
		if strings.Contains(all.String(), secret) {
			t.Errorf("the logs, events or rows carry %q", secret)
		}
	}
}

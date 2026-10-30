package ghpoll

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
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

var fixture string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "stam-ghpoll-fixture-")
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
		if out, err := execNode("../db/testdata/make-fixture.mjs", home); err != nil {
			fmt.Fprintf(os.Stderr, "make-fixture.mjs: %v\n%s", err, out)
			return 1
		}
		fixture = filepath.Join(home, "stam.db")
		return m.Run()
	}()
	os.Exit(code)
}

// nopHost is a Host whose deliveries go nowhere: the poller's tests look at what is stored, and the delivery is the events
// service's own.
type nopHost struct{}

func (nopHost) QueueNoticeRow(context.Context, string, string, int64)                {}
func (nopHost) MailAgent(ctx context.Context, _, _, _ string, _ events.Commit) error { return nil }
func (nopHost) MailHuman(context.Context, string, string, string, events.Commit) (string, error) {
	return "m", nil
}
func (nopHost) PostItsa(context.Context, string, string) (bool, error) { return false, nil }
func (nopHost) Render(name string, vars map[string]string) (string, error) {
	return "", errors.New("no template")
}
func (nopHost) WithFailureRetro(t string) string { return t }

type noTimers struct{}

func (noTimers) AfterFunc(time.Duration, func()) func() bool { return func() bool { return false } }

type env struct {
	t      *testing.T
	path   string
	db     *db.DB
	svc    *events.Service
	fake   *fakeGithub
	now    time.Time
	nowMu  sync.Mutex
	logs   *safeBuf
	token  string
	storeW func(Store) Store
}

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

func newEnv(t *testing.T) *env {
	t.Helper()
	return newEnvAt(t, time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC))
}

// newEnvAt is an env whose clock starts at now. Every timestamp the daemon writes comes from this clock, so a test
// doesn't depend on the calendar it runs on.
func newEnvAt(t *testing.T, now time.Time) *env {
	t.Helper()
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "stam.db")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, path: path, fake: newFake(t), now: now, logs: &safeBuf{}, token: testToken}
	e.db = e.open()
	e.svc = events.New(events.Options{DB: e.db, Host: nopHost{}, Timers: noTimers{}, Fold: func() time.Duration { return 0 }, Now: e.clock})
	// Everything logged is kept, to look for the token in.
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(e.logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(old); e.svc.Close() })
	return e
}

func (e *env) open() *db.DB {
	d, err := db.Open(context.Background(), e.path, db.Options{})
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { d.Close() })
	return d
}

func (e *env) clock() time.Time {
	e.nowMu.Lock()
	defer e.nowMu.Unlock()
	return e.now
}

// poller is a poller on this env's database and fake, as a daemon start makes it. Each call is a restart: nothing but the
// database carries over.
func (e *env) poller() *Poller {
	var st Store = DBStore{DB: e.db, Svc: e.svc, Now: e.clock}
	if e.storeW != nil {
		st = e.storeW(st)
	}
	return New(Options{Store: st, Token: func(context.Context) (string, error) { return e.token, nil }, Base: e.fake.url, Now: e.clock})
}

var subSeq int

func (e *env) watch(subject string) string {
	e.t.Helper()
	subSeq++
	id := fmt.Sprintf("es-t%d", subSeq)
	s := db.Subscription{ID: id, SubscriberKind: "agent", SubscriberID: "aboss", Filter: events.Filter{Source: "github", Subjects: []string{subject}}.JSON(), CreatedBy: "aboss", CreatedAt: "2026-10-28T11:00:00.000Z"}
	if err := e.db.InsertSubscription(context.Background(), s); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func (e *env) unwatch(id string) {
	e.t.Helper()
	if _, err := e.db.RemoveSubscription(context.Background(), id); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) tick(p *Poller) int {
	e.t.Helper()
	n, err := p.Tick(context.Background())
	if err != nil {
		e.t.Fatalf("tick: %v", err)
	}
	return n
}

func (e *env) stored() []db.ExtEvent {
	e.t.Helper()
	out, err := e.db.ListExtEvents(context.Background(), "", 500)
	if err != nil {
		e.t.Fatal(err)
	}
	return out
}

func (e *env) eventTypes() []string {
	var out []string
	l := e.stored()
	for i := len(l) - 1; i >= 0; i-- {
		out = append(out, l[i].Type)
	}
	return out
}

func (e *env) row(subject string) (db.WatchRow, bool) {
	e.t.Helper()
	r, ok, err := e.db.WatchRow(context.Background(), subject)
	if err != nil {
		e.t.Fatal(err)
	}
	return r, ok
}

func TestTickSurvivesARestartWithNoEventTwiceAndNoneMissed(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.watch("github:o/r#1")
	if n := e.tick(e.poller()); n != 0 {
		t.Fatalf("the first poll ingested %d", n)
	}
	r1, ok := e.row("github:o/r#1")
	if !ok || !strings.Contains(r1.State, `"checks":"pending"`) {
		t.Fatalf("no snapshot stored: %v %+v", ok, r1)
	}
	// A restart: a new poller on the same database, a poll that changes nothing. Nothing is emitted.
	if n := e.tick(e.poller()); n != 0 {
		t.Errorf("after a restart an unchanged poll ingested %d", n)
	}
	// A change between the restarts: exactly its events.
	e.fake.set("comments", "o/r#1", []any{map[string]any{"id": 5, "body": "hi", "created_at": "2026-10-13T10:11:00Z", "updated_at": "2026-10-13T10:11:00Z", "user": map[string]any{"login": "bot"}}})
	e.fake.patch("issues", "o/r#1", map[string]any{"state": "closed", "updated_at": "2026-10-13T11:00:00Z"})
	e.fake.patch("pulls", "o/r#1", map[string]any{"merged": true, "state": "closed"})
	if n := e.tick(e.poller()); n != 2 {
		t.Errorf("the change ingested %d", n)
	}
	if got, want := strings.Join(e.eventTypes(), ","), "comment.created,pull_request.merged"; got != want {
		t.Errorf("events %s, want %s", got, want)
	}
	// And a restart after that emits none of them again.
	if n := e.tick(e.poller()); n != 0 {
		t.Errorf("after the change and a restart: %d", n)
	}
	if n := len(e.stored()); n != 2 {
		t.Errorf("%d events stored", n)
	}
}

// A stop in the middle of the write leaves neither the events nor the snapshot (one transaction), so the next poll finds the
// change again and it is stored once.
func TestAFailedApplyStoresNeitherEventsNorSnapshotAndTheRetryStoresOnce(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.watch("github:o/r#1")
	e.tick(e.poller())
	before, _ := e.row("github:o/r#1")
	e.fake.patch("pulls", "o/r#1", map[string]any{"head": map[string]any{"sha": "sha2", "ref": "f"}})
	fail := true
	e.storeW = func(s Store) Store { return &failingApply{Store: s, fail: &fail} }
	e.tick(e.poller())
	after, _ := e.row("github:o/r#1")
	if len(e.stored()) != 0 || after != before {
		t.Fatalf("a failed write stored something: %v %+v", e.eventTypes(), after)
	}
	fail = false
	e.tick(e.poller())
	if got := strings.Join(e.eventTypes(), ","); got != "pull_request.synchronize" {
		t.Errorf("events after the retry: %s", got)
	}
	if r, _ := e.row("github:o/r#1"); !strings.Contains(r.State, `"head":"sha2"`) {
		t.Errorf("the snapshot never caught up: %s", r.State)
	}
}

type failingApply struct {
	Store
	fail *bool
}

func (f *failingApply) Apply(ctx context.Context, subject string, evs []events.Input, state, etags string) (int, bool, error) {
	if *f.fail {
		return 0, false, errors.New("the daemon stopped")
	}
	return f.Store.Apply(ctx, subject, evs, state, etags)
}

func TestAFailedPollKeepsTheStateAndNeverAdvancesSinceOrEtags(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.watch("github:o/r#1")
	e.fake.set("comments", "o/r#1", []any{map[string]any{"id": 1, "body": "a", "created_at": "2026-10-13T10:00:00Z", "updated_at": "2026-10-13T10:00:00Z", "user": map[string]any{"login": "x"}}})
	p := e.poller()
	e.tick(p)
	before, _ := e.row("github:o/r#1")
	if !strings.Contains(before.State, `"commentsSince":"2026-10-13T10:00:00Z"`) || !strings.Contains(before.Etags, "issues/1") {
		t.Fatalf("no since or etags: %+v", before)
	}
	// GitHub breaks: a 500 on every call.
	e.fake.mu.Lock()
	e.fake.force = 500
	e.fake.mu.Unlock()
	e.fake.set("comments", "o/r#1", []any{map[string]any{"id": 2, "body": "b", "created_at": "2026-10-13T11:00:00Z", "updated_at": "2026-10-13T11:00:00Z", "user": map[string]any{"login": "x"}}})
	if n := e.tick(p); n != 0 {
		t.Errorf("a broken poll ingested %d", n)
	}
	after, _ := e.row("github:o/r#1")
	if after != before {
		t.Errorf("a failed poll changed the row:\n %+v\n %+v", before, after)
	}
	// A subject never polled and a broken GitHub: no snapshot is stored, or the next poll would not be its first.
	e.watch("github:o/r#5")
	e.tick(p)
	if r, ok := e.row("github:o/r#5"); ok {
		t.Errorf("a failed first poll stored %+v", r)
	}
	// A failed subject waits on its own for a while; let it go on.
	p.mu.Lock()
	p.subjectUntil = map[string]time.Time{}
	p.mu.Unlock()
	// A rate limit: backs off, keeps the state.
	e.fake.mu.Lock()
	e.fake.force = 403
	e.fake.remaining = 0
	e.fake.mu.Unlock()
	if n := e.tick(p); n != 0 {
		t.Errorf("rate-limited poll ingested %d", n)
	}
	if !p.BackoffUntil().After(e.clock()) {
		t.Errorf("no backoff after a rate limit")
	}
	if after, _ = e.row("github:o/r#1"); after != before {
		t.Errorf("a rate-limited poll changed the row")
	}
	// Recovery: the comment missed meanwhile is still there to find, since never moved past it.
	e.fake.mu.Lock()
	e.fake.force = 0
	e.fake.remaining = 5000
	e.fake.mu.Unlock()
	p.ResetBackoff()
	p.mu.Lock()
	p.subjectUntil = map[string]time.Time{}
	p.mu.Unlock()
	if n := e.tick(p); n != 1 {
		t.Errorf("after recovery %d events, want the comment", n)
	}
}

// A failure in the middle of a poll (here the comments call) discards the whole poll, not only the failing part.
func TestAFailureMidPollDiscardsTheWholePoll(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.watch("github:o/r#1")
	p := e.poller()
	e.tick(p)
	before, _ := e.row("github:o/r#1")
	e.fake.patch("pulls", "o/r#1", map[string]any{"head": map[string]any{"sha": "sha2", "ref": "f"}})
	// The issue and pull calls would succeed; the reviews call is rate limited.
	e.fake.mu.Lock()
	e.fake.forceOn = "/reviews"
	e.fake.mu.Unlock()
	e.tick(p)
	after, _ := e.row("github:o/r#1")
	if after != before || len(e.stored()) != 0 {
		t.Errorf("a half poll was kept: %+v / %d events", after, len(e.stored()))
	}
}

func TestLowRateLimitBacksOffThenResumes(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.watch("github:o/r#1")
	p := e.poller()
	e.fake.mu.Lock()
	e.fake.remaining = 50
	e.fake.reset = e.now.Add(10 * time.Minute).Unix()
	e.fake.mu.Unlock()
	e.tick(p)
	if got := p.BackoffUntil(); !got.Equal(e.now.Add(10 * time.Minute)) {
		t.Errorf("backoff until %v", got)
	}
	e.fake.clearCalls()
	e.tick(p)
	if n := len(e.fake.callList()); n != 0 {
		t.Errorf("polled %d times while backing off", n)
	}
	e.nowMu.Lock()
	e.now = e.now.Add(11 * time.Minute)
	e.nowMu.Unlock()
	e.fake.mu.Lock()
	e.fake.remaining = 5000
	e.fake.mu.Unlock()
	e.tick(p)
	if n := len(e.fake.callList()); n == 0 {
		t.Errorf("did not resume after the reset")
	}
}

func TestTheTokenGoesOnlyInTheHeader(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.watch("github:o/r#1")
	p := e.poller()
	e.tick(p)
	// Every kind of failure, with a body that echoes the headers and the url, and a base url that holds the token.
	e.fake.mu.Lock()
	e.fake.force = 500
	e.fake.mu.Unlock()
	e.tick(p)
	e.fake.mu.Lock()
	e.fake.force = 0
	e.fake.mu.Unlock()
	e.fake.patch("pulls", "o/r#1", map[string]any{"head": map[string]any{"sha": "sha2", "ref": "f"}})
	e.fake.set("comments", "o/r#1", []any{map[string]any{"id": 2, "body": "b", "created_at": "2026-10-13T11:00:00Z", "updated_at": "2026-10-13T11:00:00Z", "user": map[string]any{"login": "x"}}})
	e.tick(p)
	bad := New(Options{Store: DBStore{DB: e.db, Svc: e.svc, Now: e.clock}, Token: func(context.Context) (string, error) { return e.token, nil }, Base: func() string { return "http://127.0.0.1:1/" + e.token }, Now: e.clock})
	_, err := bad.Poll(context.Background(), "github:o/r#1", nil, nil, e.token)
	if err == nil {
		t.Fatal("no transport error")
	}
	if strings.Contains(err.Error(), e.token) {
		t.Errorf("the error holds the token: %v", err)
	}
	e.tick(bad)
	// The header did carry it, so the fake saw it.
	seen := false
	for _, a := range e.fake.auths {
		seen = seen || a == "Bearer "+e.token
	}
	if !seen {
		t.Fatalf("the token was never sent")
	}
	if strings.Contains(e.logs.String(), e.token) {
		t.Errorf("a log line holds the token:\n%s", e.logs.String())
	}
	if !strings.Contains(e.logs.String(), "poll github:o/r#1 failed") {
		t.Errorf("the failures were not logged:\n%s", e.logs.String())
	}
	// Nothing on disk: the database and its write-ahead log, byte for byte.
	for _, name := range []string{e.path, e.path + "-wal"} {
		if b, err := os.ReadFile(name); err == nil && bytes.Contains(b, []byte(e.token)) {
			t.Errorf("%s holds the token", filepath.Base(name))
		}
	}
	for _, ev := range e.stored() {
		if strings.Contains(fmt.Sprint(ev), e.token) {
			t.Errorf("an event holds the token: %+v", ev)
		}
	}
	if r, _ := e.row("github:o/r#1"); strings.Contains(r.State+r.Etags, e.token) {
		t.Errorf("the poll state holds the token")
	}
}

func TestTicksNeverOverlapAndCloseWaitsForTheTickInFlight(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.watch("github:o/r#1")
	p := e.poller()
	in, release := make(chan struct{}), make(chan struct{})
	p.hookAfterPoll = func(string) {
		close(in)
		<-release
	}
	p.o.Interval = 5 * time.Millisecond
	p.Start(context.Background())
	<-in
	if _, err := p.Tick(context.Background()); !errors.Is(err, ErrBusy) {
		t.Errorf("an overlapping tick: %v", err)
	}
	closed := make(chan struct{})
	go func() {
		p.Close()
		close(closed)
	}()
	select {
	case <-closed:
		t.Fatal("Close returned while a tick was in flight")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Close never returned")
	}
}

// The watch is removed after the poll found changes and before they are stored: no event, and no row for it.
func TestAnUnwatchDuringAPollEmitsNothingAndLeavesNoRow(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	id := e.watch("github:o/r#1")
	p := e.poller()
	e.tick(p)
	e.fake.patch("pulls", "o/r#1", map[string]any{"head": map[string]any{"sha": "sha2", "ref": "f"}})
	p.hookAfterPoll = func(string) { e.unwatch(id) }
	if n := e.tick(p); n != 0 {
		t.Errorf("emitted %d for an unwatched subject", n)
	}
	if len(e.stored()) != 0 {
		t.Errorf("events for a removed subject: %v", e.eventTypes())
	}
}

// The poll's write reads whether the subject is watched when its transaction begins. The unwatch is queued on the writer
// lock (observed in its wait queue) before the poll's write, so the check can't have been made earlier: a check outside the
// transaction would still see the watch, and the events and the snapshot would be stored for a removed subject.
func TestAnApplyQueuedBehindAnUnwatchStoresNothing(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	id := e.watch("github:o/r#1")
	p := e.poller()
	e.tick(p)
	before, _ := e.row("github:o/r#1")
	e.fake.patch("pulls", "o/r#1", map[string]any{"head": map[string]any{"sha": "sha2", "ref": "f"}})
	hold, free := make(chan struct{}), make(chan struct{})
	go func() {
		_ = e.db.Write(context.Background(), func(*sqlite.Conn) error {
			close(hold)
			<-free
			return nil
		})
	}()
	<-hold
	p.hookBeforeApply = func(string) {
		go e.unwatch(id)
		waitFor(t, func() bool { return e.db.WaitingWrites() == 1 }, "the unwatch is queued")
	}
	done := make(chan struct{})
	go func() {
		_, _ = p.Tick(context.Background())
		close(done)
	}()
	waitFor(t, func() bool { return e.db.WaitingWrites() == 2 }, "the poll's write is queued behind the unwatch")
	close(free)
	<-done
	if after, _ := e.row("github:o/r#1"); after != before {
		t.Errorf("the snapshot was stored for an unwatched subject: %+v", after)
	}
	if len(e.stored()) != 0 {
		t.Errorf("events were stored for an unwatched subject: %v", e.eventTypes())
	}
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

// watch_pr's subscription ends on the merge, inside the ingest. The snapshot of that same transaction is still stored: the
// merged PR's last state is what the diff header reads, and the cleanup keeps it.
func TestAMergeThatEndsTheWatchStoresTheFinalSnapshot(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	sub := db.Subscription{ID: "es-end", SubscriberKind: "agent", SubscriberID: "aboss", CreatedBy: "aboss", CreatedAt: "2026-10-28T11:00:00.000Z",
		Filter: events.Filter{Source: "github", Subjects: []string{"github:o/r#1"}, Types: []string{"pull_request.merged", "pull_request.closed"}, EndsOn: []string{"pull_request.merged", "pull_request.closed"}}.JSON()}
	if err := e.db.InsertSubscription(context.Background(), sub); err != nil {
		t.Fatal(err)
	}
	p := e.poller()
	e.tick(p)
	e.fake.patch("issues", "o/r#1", map[string]any{"state": "closed", "updated_at": "2026-10-13T11:00:00Z"})
	e.fake.patch("pulls", "o/r#1", map[string]any{"merged": true, "state": "closed"})
	e.tick(p)
	if _, err := e.db.FindSubscription(context.Background(), "es-end"); err == nil {
		t.Fatalf("the merge didn't end the watch")
	}
	if got := strings.Join(e.eventTypes(), ","); got != "pull_request.merged" {
		t.Errorf("events: %s", got)
	}
	r, ok := e.row("github:o/r#1")
	if !ok || !strings.Contains(r.State, `"state":"merged"`) {
		t.Errorf("the merged snapshot was lost: %v %s", ok, r.State)
	}
	// Eight days on, the cleanup still keeps it.
	e.advance(8 * 24 * time.Hour)
	e.tick(p)
	if _, ok := e.row("github:o/r#1"); !ok {
		t.Errorf("the cleanup dropped a merged PR's snapshot")
	}
}

// An event that clears the only event wait ends that watch too; the snapshot of the poll is stored all the same.
func TestAnEventThatClearsTheOnlyWaitStoresTheSnapshot(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	data := `{"filter":{"source":"github","subjects":["github:o/r#1"],"types":["pull_request.synchronize"]}}`
	if err := e.db.InEventWaitTx(context.Background(), func(tx db.EventWaitTx) error {
		_, err := tx.Add(db.NewWait{AgentID: "aboss", Kind: "event", Source: "declared", Data: &data})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	p := e.poller()
	e.tick(p)
	e.fake.patch("pulls", "o/r#1", map[string]any{"head": map[string]any{"sha": "sha2", "ref": "f"}})
	e.tick(p)
	if got := strings.Join(e.eventTypes(), ","); got != "pull_request.synchronize" {
		t.Fatalf("events: %s", got)
	}
	if w, _ := (DBStore{DB: e.db, Svc: e.svc, Now: e.clock}).Watched(context.Background()); len(w) != 0 {
		t.Fatalf("the wait was not cleared: %v", w)
	}
	if r, _ := e.row("github:o/r#1"); !strings.Contains(r.State, `"head":"sha2"`) {
		t.Errorf("the snapshot of the poll that cleared the wait was lost: %s", r.State)
	}
}

func (e *env) advance(d time.Duration) {
	e.nowMu.Lock()
	e.now = e.now.Add(d)
	e.nowMu.Unlock()
}

// The cleanup drops a row only once it has been unwatched for a week (a watch that comes back reuses its baseline), never a
// PR's (open, merged or closed: the diff header reads its verdict), and treats a legacy `{}` row like any other (its type is NULL).
func TestCleanupKeepsFreshRowsDropsOldOnesAndKeepsMergedPRsAndWatchedRows(t *testing.T) {
	for _, start := range []time.Time{time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC), time.Date(2027, 3, 1, 12, 0, 0, 0, time.UTC)} {
		t.Run(start.Format("2006-01-02"), func(t *testing.T) { checkCleanupAWeekOn(t, start) })
	}
}

func checkCleanupAWeekOn(t *testing.T, start time.Time) {
	e := newEnvAt(t, start)
	e.fake.seedOpenPR("sha1")
	e.fake.set("issues", "o/r#2", map[string]any{"number": 2, "title": "i", "state": "open", "html_url": "u", "updated_at": "2026-10-13T10:00:00Z"})
	e.fake.set("issues", "o/r#3", map[string]any{"number": 3, "title": "pr3", "state": "closed", "html_url": "u", "pull_request": map[string]any{"url": "x"}, "updated_at": "2026-10-13T10:00:00Z"})
	e.fake.set("pulls", "o/r#3", map[string]any{"number": 3, "state": "closed", "merged": true, "head": map[string]any{"sha": "s3"}, "base": map[string]any{"ref": "main"}})
	w1, w2, w3 := e.watch("github:o/r#1"), e.watch("github:o/r#2"), e.watch("github:o/r#3")
	p := e.poller()
	e.tick(p)
	// Written an hour before the clock's start, so it is fresh on the first tick at either date.
	e.sql("INSERT INTO watch_state (subject, state, etags, updated_at) VALUES ('github:o/r#7', '{}', '{}', ?)", start.Add(-time.Hour).UTC().Format("2006-01-02T15:04:05.000Z"))
	e.unwatch(w1)
	e.unwatch(w2)
	e.unwatch(w3)
	e.tick(p)
	for _, s := range []string{"github:o/r#1", "github:o/r#2", "github:o/r#3", "github:o/r#7"} {
		if _, ok := e.row(s); !ok {
			t.Errorf("%s was dropped before the week was out", s)
		}
	}
	e.advance(8 * 24 * time.Hour)
	e.tick(p)
	for s, keep := range map[string]bool{"github:o/r#2": false, "github:o/r#7": false, "github:o/r#3": true, "github:o/r#1": true} {
		if _, ok := e.row(s); ok != keep {
			t.Errorf("%s after eight days: kept=%v, want %v", s, ok, keep)
		}
	}
	if r, ok := e.row("github:o/r#1"); !ok || r.State == "" {
		t.Errorf("an open PR's row was dropped")
	}
}

func (e *env) sql(query string, args ...any) {
	e.t.Helper()
	if err := e.db.Write(context.Background(), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args})
	}); err != nil {
		e.t.Fatal(err)
	}
}

// A watch that is added after the cleanup listed its candidates, and before its delete, keeps its row. The watch is queued on
// the writer lock (observed) before the delete, so a delete that read the watchers earlier would still drop the row.
func TestCleanupRechecksTheWatchersInsideItsDelete(t *testing.T) {
	e := newEnv(t)
	e.fake.set("issues", "o/r#2", map[string]any{"number": 2, "title": "i", "state": "open", "html_url": "u", "updated_at": "2026-10-13T10:00:00Z"})
	id := e.watch("github:o/r#2")
	p := e.poller()
	e.tick(p)
	e.unwatch(id)
	e.advance(8 * 24 * time.Hour)
	hold, free := make(chan struct{}), make(chan struct{})
	go func() {
		_ = e.db.Write(context.Background(), func(*sqlite.Conn) error {
			close(hold)
			<-free
			return nil
		})
	}()
	<-hold
	p.hookBeforeDrop = func() {
		go e.watch("github:o/r#2")
		waitFor(t, func() bool { return e.db.WaitingWrites() == 1 }, "the new watch is queued")
	}
	done := make(chan struct{})
	go func() {
		_, _ = p.Tick(context.Background())
		close(done)
	}()
	waitFor(t, func() bool { return e.db.WaitingWrites() == 2 }, "the delete is queued behind the new watch")
	close(free)
	<-done
	if _, ok := e.row("github:o/r#2"); !ok {
		t.Errorf("a watch added during the cleanup lost its row")
	}
}

// The cleanup is a step of the tick, so it can't meet a poll in flight: an unwatch during a poll leaves the row to a later tick.
func TestCleanupWaitsForTheInFlightPoll(t *testing.T) {
	e := newEnv(t)
	e.fake.set("issues", "o/r#2", map[string]any{"number": 2, "title": "i", "state": "open", "html_url": "u", "updated_at": "2026-10-13T10:00:00Z"})
	id := e.watch("github:o/r#2")
	p := e.poller()
	e.tick(p)
	e.advance(8 * 24 * time.Hour)
	var drops []string
	var mu sync.Mutex
	e.storeW = func(s Store) Store { return &dropSpy{Store: s, mu: &mu, drops: &drops} }
	p = e.poller()
	in, release := make(chan struct{}), make(chan struct{})
	p.hookAfterPoll = func(string) {
		close(in)
		<-release
	}
	done := make(chan struct{})
	go func() {
		_, _ = p.Tick(context.Background())
		close(done)
	}()
	<-in
	e.unwatch(id)
	if _, err := p.Tick(context.Background()); !errors.Is(err, ErrBusy) {
		t.Errorf("a second tick ran: %v", err)
	}
	mu.Lock()
	n := len(drops)
	mu.Unlock()
	if n != 0 {
		t.Errorf("the state was dropped while its poll was in flight")
	}
	close(release)
	<-done
}

type dropSpy struct {
	Store
	mu    *sync.Mutex
	drops *[]string
}

func (d *dropSpy) Drop(ctx context.Context, s []string, olderThan time.Time) ([]string, error) {
	d.mu.Lock()
	*d.drops = append(*d.drops, s...)
	d.mu.Unlock()
	return d.Store.Drop(ctx, s, olderThan)
}

// Any status but a 200 or 304 on a call of the poll fails the whole poll for that subject: nothing stored, no ETag, no since,
// and the changes the calls would have shown come in the poll after.
func TestAnyOtherStatusFailsTheWholePollForThatSubject(t *testing.T) {
	for _, tc := range []struct{ name, path string }{
		{"issue", "/issues/1"}, {"pull", "/pulls/1"}, {"reviews", "/pulls/1/reviews"}, {"comments", "/issues/1/comments"}, {"check runs", "/check-runs"}, {"statuses", "/status"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			e.fake.seedOpenPR("sha1")
			e.watch("github:o/r#1")
			p := e.poller()
			e.tick(p)
			before, _ := e.row("github:o/r#1")
			// The issue view says closed, and the review and comment are new; the failing call is the one that would have shown the rest.
			e.fake.patch("issues", "o/r#1", map[string]any{"state": "closed", "updated_at": "2026-10-13T11:00:00Z"})
			e.fake.patch("pulls", "o/r#1", map[string]any{"merged": true, "state": "closed", "head": map[string]any{"sha": "sha1", "ref": "f"}})
			e.fake.set("reviews", "o/r#1", []any{map[string]any{"id": 9, "state": "APPROVED", "submitted_at": "2026-10-13T11:00:00Z", "user": map[string]any{"login": "rev"}}})
			e.fake.set("comments", "o/r#1", []any{map[string]any{"id": 4, "body": "x", "created_at": "2026-10-13T11:01:00Z", "updated_at": "2026-10-13T11:01:00Z", "user": map[string]any{"login": "c"}}})
			e.fake.set("statuses", "o/r@sha1", map[string]any{"state": "success", "statuses": []any{map[string]any{"context": "ci", "state": "success", "updated_at": "2026-10-13T11:02:00Z"}}})
			e.fake.set("checkRuns", "o/r@sha1", []any{map[string]any{"name": "build", "status": "completed", "conclusion": "success", "completed_at": "2026-10-13T11:02:00Z"}})
			e.fake.mu.Lock()
			e.fake.forceOn, e.fake.forceOnStatus = tc.path, 500
			e.fake.mu.Unlock()
			if n := e.tick(p); n != 0 {
				t.Errorf("a failed poll stored %d events", n)
			}
			if after, _ := e.row("github:o/r#1"); after != before {
				t.Errorf("a failed poll changed the row:\n %+v\n %+v", before, after)
			}
			if len(e.stored()) != 0 {
				t.Errorf("events stored by a failed poll: %v", e.eventTypes())
			}
			e.fake.mu.Lock()
			e.fake.forceOn = ""
			e.fake.mu.Unlock()
			p.mu.Lock()
			p.subjectUntil = map[string]time.Time{}
			p.mu.Unlock()
			e.tick(p)
			got := strings.Join(e.eventTypes(), ",")
			for _, want := range []string{"pull_request.merged", "review.submitted", "comment.created", "checks.completed"} {
				if !strings.Contains(got, want) {
					t.Errorf("after recovery %q is missing from %s", want, got)
				}
			}
		})
	}
}

// A page of the repository events that fails loses the events on it, so the whole poll fails; a failed FIRST poll stores no
// lastEventId of 0 that would make the next one the first no more.
func TestARepositoryPollThatFailsOnAPageStoresNothing(t *testing.T) {
	e := newEnv(t)
	e.fake.pageSize = 2
	ev := func(id string) any {
		return map[string]any{"id": id, "type": "WatchEvent", "actor": map[string]any{"login": "s"}, "payload": map[string]any{}}
	}
	e.fake.set("events", "o/r", []any{ev("5")})
	e.watch("github:o/r")
	p := e.poller()
	e.fake.mu.Lock()
	e.fake.forceOn, e.fake.forceOnStatus = "/events", 500
	e.fake.mu.Unlock()
	e.tick(p)
	if r, ok := e.row("github:o/r"); ok {
		t.Fatalf("a failed first poll stored %+v", r)
	}
	e.fake.mu.Lock()
	e.fake.forceOn = ""
	e.fake.mu.Unlock()
	p.mu.Lock()
	p.subjectUntil = map[string]time.Time{}
	p.mu.Unlock()
	e.tick(p)
	e.fake.set("events", "o/r", []any{ev("9"), ev("8"), ev("7"), ev("6"), ev("5")})
	// Page 1 answers; page 2 (ids 7 and 6) answers 500: the events on it must not be skipped over.
	e.fake.mu.Lock()
	e.fake.failPage2 = true
	e.fake.mu.Unlock()
	before, _ := e.row("github:o/r")
	e.tick(p)
	if after, _ := e.row("github:o/r"); after != before || len(e.stored()) != 0 {
		t.Fatalf("a page that failed advanced the poll: %+v %v", after, e.eventTypes())
	}
	e.fake.mu.Lock()
	e.fake.failPage2 = false
	e.fake.mu.Unlock()
	p.mu.Lock()
	p.subjectUntil = map[string]time.Time{}
	p.mu.Unlock()
	e.tick(p)
	if n := len(e.stored()); n != 4 {
		t.Errorf("after recovery %d events stored, want the 4 new ones", n)
	}
}

// A 403 for permissions is that subject's own failure; only the rate limit (the budget spent, or retry-after) stops every subject.
func TestAPermissionForbiddenFailsOnlyThatSubjectAndTheRateLimitStopsAll(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.fake.set("issues", "o/r#2", map[string]any{"number": 2, "title": "i", "state": "open", "html_url": "u", "updated_at": "2026-10-13T10:00:00Z"})
	e.watch("github:o/r#1")
	e.watch("github:o/r#2")
	p := e.poller()
	e.fake.mu.Lock()
	e.fake.forceOn = "/issues/1"
	e.fake.mu.Unlock()
	e.tick(p)
	if !p.BackoffUntil().IsZero() {
		t.Errorf("a permission 403 backed every subject off")
	}
	if _, ok := e.row("github:o/r#2"); !ok {
		t.Errorf("the other subject was not polled")
	}
	if _, ok := e.row("github:o/r#1"); ok {
		t.Errorf("the forbidden subject stored a row")
	}
	// It waits on its own: the next tick doesn't call it.
	e.fake.clearCalls()
	e.tick(p)
	for _, c := range e.fake.callList() {
		if strings.Contains(c, "/issues/1") {
			t.Errorf("the forbidden subject was polled again at once: %s", c)
		}
	}
	// The budget spent (a 403 with remaining 0), or retry-after, is the rate limit: everyone waits.
	e.fake.mu.Lock()
	e.fake.forceOn, e.fake.remaining = "/issues/2", 0
	e.fake.mu.Unlock()
	e.advance(10 * time.Minute)
	e.tick(p)
	if !p.BackoffUntil().After(e.clock()) {
		t.Errorf("a rate limit didn't back off")
	}
	p.ResetBackoff()
	e.fake.mu.Lock()
	e.fake.remaining, e.fake.retryAfter = 5000, "120"
	e.fake.mu.Unlock()
	e.tick(p)
	if got := p.BackoffUntil().Sub(e.clock()); got < 100*time.Second || got > 130*time.Second {
		t.Errorf("retry-after 120 backed off %v", got)
	}
}

// An ETag that holds the token is neither stored nor sent back.
func TestAnETagWithTheTokenInItIsDropped(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.watch("github:o/r#1")
	e.fake.mu.Lock()
	e.fake.etagFixed = `W/"` + e.token + `"`
	e.fake.mu.Unlock()
	p := e.poller()
	e.tick(p)
	e.tick(p)
	if r, _ := e.row("github:o/r#1"); strings.Contains(r.Etags, e.token) {
		t.Errorf("an ETag with the token was stored: %s", r.Etags)
	}
	if b, err := os.ReadFile(e.path + "-wal"); err == nil && bytes.Contains(b, []byte(e.token)) {
		t.Errorf("the log holds the token")
	}
}

func TestEventWaitsAndExpiryDecideWhatIsWatched(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	data := `{"filter":{"source":"github","subjects":["github:o/r#1"],"types":["checks.completed"]}}`
	if err := e.db.InEventWaitTx(context.Background(), func(tx db.EventWaitTx) error {
		_, err := tx.Add(db.NewWait{AgentID: "aboss", Kind: "event", Source: "declared", Data: &data})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// An expired subscription names nothing.
	exp := int64(1)
	if err := e.db.InsertSubscription(context.Background(), db.Subscription{ID: "es-exp", SubscriberKind: "agent", SubscriberID: "aboss", Filter: events.Filter{Subjects: []string{"github:o/r#7", "github:o/*"}}.JSON(), CreatedBy: "aboss", ExpiresAt: &exp, CreatedAt: "2026-10-28T11:00:00.000Z"}); err != nil {
		t.Fatal(err)
	}
	got, err := DBStore{DB: e.db, Now: e.clock}.Watched(context.Background())
	if err != nil || strings.Join(got, ",") != "github:o/r#1" {
		t.Errorf("watched %v %v", got, err)
	}
	// A glob is watched for matching, not polled.
	e.watch("github:o/*")
	e.fake.clearCalls()
	e.tick(e.poller())
	for _, c := range e.fake.callList() {
		if !strings.Contains(c, "/repos/o/r/") {
			t.Errorf("polled %s", c)
		}
	}
	if _, ok := e.row("github:o/r#1"); !ok {
		t.Errorf("the wait's subject was not polled")
	}
}

func TestPollsStoreEventsThatMatchSubscriptionsAndMirrorsAreCalled(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.watch("github:o/r#1")
	var mirrored []string
	mains := 0
	p := e.poller()
	p.o.Mirror = func(s string) { mirrored = append(mirrored, s) }
	p.o.MirrorMain = func() { mains++ }
	e.tick(p)
	if strings.Join(mirrored, ",") != "github:o/r#1" || mains != 0 {
		t.Errorf("first poll mirrors %v %d", mirrored, mains)
	}
	e.fake.patch("issues", "o/r#1", map[string]any{"state": "closed", "updated_at": "2026-10-13T11:00:00Z"})
	e.fake.patch("pulls", "o/r#1", map[string]any{"merged": true, "state": "closed"})
	e.tick(p)
	if mains != 1 || len(mirrored) != 1 {
		t.Errorf("merge: mirrored %v mains %d", mirrored, mains)
	}
	l := e.stored()
	if len(l) != 1 || l[0].Type != "pull_request.merged" || l[0].Source != "github" {
		t.Fatalf("stored %+v", l)
	}
	if strings.Join(l[0].Subjects, ",") != "github:o/r#1,github:o/r" {
		t.Errorf("subjects %v", l[0].Subjects)
	}
}

func TestStateFor(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.fake.set("issues", "o/r#2", map[string]any{"number": 2, "title": "Bug", "state": "open", "html_url": "iu", "updated_at": "x"})
	e.watch("github:o/r#1")
	e.watch("github:o/r#2")
	e.tick(e.poller())
	out, err := StateFor(context.Background(), DBStore{DB: e.db}, []string{"github:o/r#1", "github:o/r#2", "github:o/r#9"})
	if err != nil {
		t.Fatal(err)
	}
	pr, ok := out["github:o/r#1"].(PRView)
	if !ok || *pr.State != "open" || pr.Draft || pr.Checks != "pending" || pr.Review != "none" || *pr.Head != "sha1" || *pr.Base != "main" || *pr.Title != "PR one" || pr.UpdatedAt == "" {
		t.Errorf("pr: %+v", out["github:o/r#1"])
	}
	if is, ok := out["github:o/r#2"].(IssueView); !ok || *is.Title != "Bug" || *is.URL != "iu" {
		t.Errorf("issue: %+v", out["github:o/r#2"])
	}
	if _, ok := out["github:o/r#9"].(NoState); !ok {
		t.Errorf("none: %+v", out["github:o/r#9"])
	}
	b := jsjsonStringify(nil)
	_ = b
}

func (e *env) clearInms() {
	e.fake.mu.Lock()
	e.fake.inms = nil
	e.fake.mu.Unlock()
}

// sentInms is how many requests since clearInms carried an If-None-Match, and how many were made.
func (e *env) sentInms() (with, all int) {
	e.fake.mu.Lock()
	defer e.fake.mu.Unlock()
	for _, v := range e.fake.inms {
		if v != "" {
			with++
		}
	}
	return with, len(e.fake.inms)
}

// ETags are tied to the token that got them: after a start, and after the token changes, each subject is polled once with none,
// then the ETags go again. The token's identity is a hash in memory only.
func TestStoredETagsAreNotSentWithAnotherToken(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.watch("github:o/r#1")
	p := e.poller()
	e.tick(p)
	e.clearInms()
	e.tick(p)
	if with, all := e.sentInms(); all == 0 || with == 0 {
		t.Fatalf("the same token sent %d of %d requests with an ETag", with, all)
	}
	// The token changes between two ticks: the next sends no If-None-Match.
	e.token = "ghp_secondtoken0000000000000000000000000"
	e.clearInms()
	e.tick(p)
	if with, all := e.sentInms(); all == 0 || with != 0 {
		t.Errorf("a changed token sent %d of %d requests with an ETag", with, all)
	}
	// Then the new token's ETags are used.
	e.clearInms()
	e.tick(p)
	if with, _ := e.sentInms(); with == 0 {
		t.Errorf("the new token's ETags were never used")
	}
	// A start is the same: the stored ETags came from a process that is gone.
	e.clearInms()
	e.tick(e.poller())
	if with, all := e.sentInms(); all == 0 || with != 0 {
		t.Errorf("the first poll after a start sent %d of %d requests with an ETag", with, all)
	}
	if r, _ := e.row("github:o/r#1"); strings.Contains(r.Etags, e.token) || strings.Contains(r.Etags, "token") {
		t.Errorf("the row holds the token or its identity: %s", r.Etags)
	}
}

// A 403 whose body names a rate limit, with budget left and no retry-after, is GitHub's secondary limit: every subject waits.
func TestASecondaryRateLimitBacksTheWholePollerOff(t *testing.T) {
	e := newEnv(t)
	e.fake.seedOpenPR("sha1")
	e.watch("github:o/r#1")
	p := e.poller()
	e.fake.mu.Lock()
	e.fake.forceOn, e.fake.forceMsg = "/issues/1", "You have exceeded a secondary rate limit. Please wait a few minutes."
	e.fake.mu.Unlock()
	e.tick(p)
	if got := p.BackoffUntil().Sub(e.clock()); got < 50*time.Second || got > 70*time.Second {
		t.Errorf("a secondary limit backed off %v, want about a minute", got)
	}
}

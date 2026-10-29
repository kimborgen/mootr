package events

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/db"
	"stam/internal/jsjson"
)

var fixture string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "stam-events-fixture-")
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

// fakeHost records what the service sends.
type fakeHost struct {
	mu      sync.Mutex
	notices []string
	mails   []string
	human   []string
	posts   []string
	humanN  int
	// failMail makes MailAgent fail; goneItsa makes PostItsa report no ITSA.
	failMail  bool
	goneItsa  bool
	replyTo   []string
	retroTail string
	// db is the database the mail's transaction runs in; noCommit makes the host skip the commit (the mail went
	// elsewhere); failAfterStore fails the call after the mail and its commit are stored, as a crash would.
	db             *db.DB
	mailN          int
	rows           []int64
	noCommit       bool
	failAfterStore bool
}

func (h *fakeHost) QueueNoticeRow(_ context.Context, agentID, text string, row int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.notices = append(h.notices, agentID+"|"+text)
	h.rows = append(h.rows, row)
}

// store is the mail's own transaction: commit runs in it with the mail's id, as the daemon's send runs it.
func (h *fakeHost) store(ctx context.Context, commit Commit) (string, error) {
	h.mailN++
	id := fmt.Sprintf("mail%d", h.mailN)
	if commit == nil || h.noCommit {
		return id, nil
	}
	return id, h.db.Write(ctx, func(conn *sqlite.Conn) error { return commit(conn, id) })
}

func (h *fakeHost) MailAgent(ctx context.Context, agentID, subject, body string, commit Commit) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.failMail {
		return errors.New("mail refused")
	}
	if _, err := h.store(ctx, commit); err != nil {
		return err
	}
	h.mails = append(h.mails, agentID+"|"+subject+"|"+body)
	if h.failAfterStore {
		return errors.New("the daemon stopped after the mail was stored")
	}
	return nil
}

func (h *fakeHost) MailHuman(ctx context.Context, subject, body, replyTo string, commit Commit) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	id, err := h.store(ctx, commit)
	if err != nil {
		return "", err
	}
	h.humanN++
	h.replyTo = append(h.replyTo, replyTo)
	h.human = append(h.human, subject+"|"+body)
	return id, nil
}

func (h *fakeHost) PostItsa(_ context.Context, itsaID, body string) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.goneItsa {
		return true, nil
	}
	h.posts = append(h.posts, itsaID+"|"+body)
	return false, nil
}

func (h *fakeHost) Render(name string, vars map[string]string) (string, error) {
	switch name {
	case "event-notice":
		return vars["intro"] + "\n\n" + vars["events"], nil
	case "wait-event":
		return "[stam] Your wait for " + vars["what"] + " cleared: an event you waited for arrived.\n\n" + vars["event"], nil
	}
	return "", errors.New("no template " + name)
}

func (h *fakeHost) WithFailureRetro(text string) string { return text + "\n\nRETRO" }

func (h *fakeHost) counts() (notices, mails, human, posts int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.notices), len(h.mails), len(h.human), len(h.posts)
}

// fakeTimers holds the timers until a test fires them, so nothing sleeps.
type fakeTimers struct {
	mu      sync.Mutex
	next    int
	pending map[int]func()
	delays  []time.Duration
}

func (f *fakeTimers) AfterFunc(d time.Duration, fn func()) func() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pending == nil {
		f.pending = map[int]func(){}
	}
	f.next++
	id := f.next
	f.pending[id] = fn
	f.delays = append(f.delays, d)
	return func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		_, ok := f.pending[id]
		delete(f.pending, id)
		return ok
	}
}

func (f *fakeTimers) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.pending)
}

// fire runs every pending timer on this goroutine, as the timers would on their own.
func (f *fakeTimers) fire() {
	f.mu.Lock()
	var fns []func()
	for id, fn := range f.pending {
		fns = append(fns, fn)
		delete(f.pending, id)
	}
	f.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
}

type env struct {
	t      *testing.T
	path   string
	db     *db.DB
	host   *fakeHost
	timers *fakeTimers
	svc    *Service
	now    time.Time
}

func newEnv(t *testing.T) *env {
	t.Helper()
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "stam.db")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, path: path, host: &fakeHost{}, timers: &fakeTimers{}, now: time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)}
	e.db = e.open()
	e.host.db = e.db
	e.svc = e.service()
	t.Cleanup(func() { e.svc.Close() })
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

func (e *env) service() *Service {
	return New(Options{DB: e.db, Host: e.host, Timers: e.timers, Now: func() time.Time { return e.now }, Fold: func() time.Duration { return 20 * time.Second }})
}

// restart is a daemon restart: the old service stops, a new one starts on the same database.
func (e *env) restart() {
	e.t.Helper()
	e.svc.Close()
	e.db.Close()
	e.db = e.open()
	e.host.db = e.db
	e.timers = &fakeTimers{}
	e.svc = e.service()
	if err := e.svc.Start(context.Background()); err != nil {
		e.t.Fatal(err)
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

func (e *env) count(query string, args ...any) int {
	e.t.Helper()
	n := -1
	if err := e.db.Read(context.Background(), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args, ResultFunc: func(s *sqlite.Stmt) error { n = s.ColumnInt(0); return nil }})
	}); err != nil {
		e.t.Fatal(err)
	}
	return n
}

var subSeq int

// subscribe stores a subscription as the route does and returns its id.
func (e *env) subscribe(kind, subscriber string, f Filter, note string) string {
	e.t.Helper()
	subSeq++
	s := db.Subscription{ID: fmt.Sprintf("es-%010d", subSeq), SubscriberKind: kind, SubscriberID: subscriber, Filter: f.JSON(), CreatedBy: subscriber, CreatedAt: fmt.Sprintf("2026-10-28T11:00:%02d.000Z", subSeq%60)}
	if note != "" {
		s.Note = &note
	}
	if err := e.db.InsertSubscription(context.Background(), s); err != nil {
		e.t.Fatal(err)
	}
	return s.ID
}

func (e *env) working(agent string) {
	e.sql("UPDATE agents SET lifecycle = 'active', activity = 'working' WHERE id = ?", agent)
}

func (e *env) idle(agent string) {
	e.sql("UPDATE agents SET lifecycle = 'active', activity = 'idle' WHERE id = ?", agent)
}

func (e *env) ingest(key, typ, summary string, subjects ...string) Result {
	e.t.Helper()
	s := summary
	r, err := e.svc.Ingest(context.Background(), Input{Source: "github", Type: typ, Subjects: subjects, Summary: &s, DedupeKey: key})
	if err != nil {
		e.t.Fatal(err)
	}
	return r
}

func TestIngestStoresOnceAndValidates(t *testing.T) {
	e := newEnv(t)
	first := e.ingest("k1", "x", "one", "github:o/r#1")
	if !first.Stored || first.Event.ID == 0 {
		t.Fatalf("%+v", first)
	}
	if again := e.ingest("k1", "x", "one", "github:o/r#1"); again.Stored || again.Matched != 0 {
		t.Errorf("a repeat of a dedupe_key: %+v", again)
	}
	evs, err := e.db.ListExtEvents(context.Background(), "", 50)
	if err != nil || len(evs) != 1 {
		t.Fatalf("%v %v", evs, err)
	}
	if got := string(evs[0].Payload); got != "null" {
		t.Errorf("a stored event with no payload lists %s", got)
	}
	for _, tc := range []struct {
		in   Input
		want string
	}{
		{Input{Type: "x", DedupeKey: "k"}, "an event needs a source"},
		{Input{Source: "github", DedupeKey: "k"}, "an event needs a type"},
		{Input{Source: "github", Type: "x"}, "an event needs a dedupe_key"},
	} {
		_, err := e.svc.Ingest(context.Background(), tc.in)
		var bad *ErrInvalid
		if !errors.As(err, &bad) || bad.Msg != tc.want {
			t.Errorf("%+v: %v", tc.in, err)
		}
	}
	// A payload given as null is stored as the text null, one not given as none.
	p, _ := jsjson.Parse([]byte(`{"at":"2026-01-01T00:00:00Z"}`))
	if _, err := e.svc.Ingest(context.Background(), Input{Source: "github", Type: "x", DedupeKey: "k2", Payload: p, HasPayload: true}); err != nil {
		t.Fatal(err)
	}
	if n := e.count("SELECT COUNT(*) FROM ext_events WHERE dedupe_key = 'k2' AND payload = '{\"at\":\"2026-01-01T00:00:00Z\"}'"); n != 1 {
		t.Errorf("the payload was not stored as given")
	}
	if n := e.count("SELECT COUNT(*) FROM ext_events WHERE dedupe_key = 'k1' AND payload IS NULL AND summary = 'one'"); n != 1 {
		t.Errorf("an event with no payload stores NULL")
	}
}

func TestEventsListSubjectFilterRunsBeforeLimit(t *testing.T) {
	e := newEnv(t)
	e.ingest("t1", "x", "target one", "github:o/r#12")
	e.ingest("t2", "x", "target two", "github:o/r#12")
	for i := 0; i < 58; i++ {
		e.ingest(fmt.Sprintf("n%d", i), "x", "noise", fmt.Sprintf("github:o/r#%d", 100+i))
	}
	if got, _ := e.db.ListExtEvents(context.Background(), "", 50); len(got) != 50 {
		t.Errorf("the plain listing returned %d", len(got))
	}
	got, _ := e.db.ListExtEvents(context.Background(), "github:o/r#12", 50)
	if len(got) != 2 || got[0].Summary != "target two" || got[1].Summary != "target one" {
		t.Errorf("the old matches were crowded out: %+v", got)
	}
}

func TestFoldBatchesBurstIntoOneNoticeForAWorkingAgent(t *testing.T) {
	e := newEnv(t)
	e.working("aboss")
	e.subscribe("agent", "aboss", Filter{Source: "github", Subjects: []string{"github:o/*"}, Types: []string{"pull_request.*"}}, "")
	e.ingest("e1", "pull_request.opened", "opened 1", "github:o/r#1")
	e.ingest("e2", "pull_request.synchronize", "synced 1", "github:o/r#1")
	e.ingest("e3", "push", "a push", "github:o/r")
	if e.timers.count() != 1 {
		t.Fatalf("%d timers, want the one the first event started", e.timers.count())
	}
	if n, m, _, _ := e.host.counts(); n+m != 0 {
		t.Fatal("something was delivered before the fold window closed")
	}
	e.timers.fire()
	n, m, _, _ := e.host.counts()
	if n != 1 || m != 0 {
		t.Fatalf("%d notices, %d mails", n, m)
	}
	got := e.host.notices[0]
	for _, want := range []string{"aboss|", "opened 1", "synced 1", "Manage it with `list_subscriptions` and `unsubscribe es-"} {
		if !strings.Contains(got, want) {
			t.Errorf("the notice lacks %q: %s", want, got)
		}
	}
	if strings.Contains(got, "a push") {
		t.Error("a type outside the filter was delivered")
	}
	if e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evq:%'") != 0 {
		t.Error("the delivered batch is still queued")
	}
}

func TestIdleAgentGetsMailWithTheNotesSubject(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "a thing happened", "github:o/r")
	e.timers.fire()
	if _, m, _, _ := e.host.counts(); m != 1 {
		t.Fatalf("%d mails", m)
	}
	if got := e.host.mails[0]; !strings.Contains(got, "|[stam] 1 github event|") || !strings.Contains(got, "a thing happened") {
		t.Errorf("%s", got)
	}
	// Two events and a note: the plural and the note name the subject.
	e.subscribe("agent", "aboss", Filter{Source: "linear"}, "PR #3 watch")
	for i := 0; i < 2; i++ {
		if _, err := e.svc.Ingest(context.Background(), Input{Source: "linear", Type: "x", DedupeKey: fmt.Sprintf("l%d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	e.timers.fire()
	if got := e.host.mails[len(e.host.mails)-1]; !strings.Contains(got, "|[stam] 2 PR #3 watch events|") {
		t.Errorf("%s", got)
	}
}

func TestPausedAndArchivedAgentsAreNotWorking(t *testing.T) {
	e := newEnv(t)
	// achild is paused: mail, as the TS delivery sends mail to any agent that is not active and working.
	e.sql("UPDATE agents SET activity = 'working' WHERE id = 'achild'")
	e.subscribe("agent", "achild", Filter{Types: []string{"x"}}, "")
	e.ingest("e1", "x", "while paused", "github:o/r")
	e.timers.fire()
	if n, m, _, _ := e.host.counts(); n != 0 || m != 1 {
		t.Errorf("a paused agent: %d notices, %d mails", n, m)
	}
	// agone is archived: nothing is sent, and the batch is dropped.
	e.subscribe("agent", "agone", Filter{Types: []string{"y"}}, "")
	e.ingest("e2", "y", "to the archived", "github:o/r")
	e.timers.fire()
	if n, m, _, _ := e.host.counts(); n != 0 || m != 1 {
		t.Errorf("an archived agent: %d notices, %d mails", n, m)
	}
	if e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evq:%'") != 0 {
		t.Error("the archived agent's batch stayed queued")
	}
}

func TestHumanDeliveriesReplyIntoOneThread(t *testing.T) {
	e := newEnv(t)
	e.subscribe("human", "human", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "first", "github:o/r")
	e.timers.fire()
	e.ingest("e2", "x", "second", "github:o/r")
	e.timers.fire()
	if _, _, h, _ := e.host.counts(); h != 2 {
		t.Fatalf("%d mails to the human", h)
	}
	if e.host.replyTo[0] != "" || e.host.replyTo[1] != "mail1" {
		t.Errorf("reply_to %q: the first starts the thread and the second replies into it", e.host.replyTo)
	}
}

func TestItsaDeliveryPostsAndAGoneItsaDropsTheBatch(t *testing.T) {
	e := newEnv(t)
	id := e.subscribe("itsa", "iabc", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "happened", "github:o/r")
	e.timers.fire()
	if _, _, _, p := e.host.counts(); p != 1 || !strings.HasPrefix(e.host.posts[0], "iabc|") {
		t.Fatalf("posts %v", e.host.posts)
	}
	e.host.goneItsa = true
	e.ingest("e2", "x", "later", "github:o/r")
	e.timers.fire()
	if e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 0 {
		t.Error("the batch of an ITSA that is gone stayed queued")
	}
}

func TestEndingEventDeletesTheSubscriptionAndKeepsItsDelivery(t *testing.T) {
	e := newEnv(t)
	e.working("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github", Subjects: []string{"github:o/r#1"}, Types: []string{"checks.completed", "pull_request.merged"}, EndsOn: []string{"pull_request.merged"}}, "PR #1 watch")
	e.ingest("c1", "checks.completed", "checks ok", "github:o/r#1")
	if _, err := e.db.FindSubscription(context.Background(), id); err != nil {
		t.Fatal("a checks event ended the watch")
	}
	e.ingest("m1", "pull_request.merged", "merged 1", "github:o/r#1")
	if _, err := e.db.FindSubscription(context.Background(), id); !errors.Is(err, db.ErrNoSubscription) {
		t.Fatalf("the merge didn't end it: %v", err)
	}
	if r := e.ingest("c2", "checks.completed", "later", "github:o/r#1"); r.Matched != 0 {
		t.Error("an event after the end matched")
	}
	e.timers.fire()
	if len(e.host.notices) != 1 {
		t.Fatalf("%d notices", len(e.host.notices))
	}
	got := e.host.notices[0]
	if !strings.Contains(got, "merged 1") || !strings.Contains(got, "checks ok") || strings.Contains(got, "later") {
		t.Errorf("%s", got)
	}
	if strings.Contains(got, "Manage it with") || !strings.Contains(got, "nothing to unsubscribe") {
		t.Errorf("the ended subscription's notice asks the agent to manage it: %s", got)
	}
}

func TestFailureEventAddsTheRetroReminderToAnAgentOnly(t *testing.T) {
	e := newEnv(t)
	e.working("aboss")
	e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.subscribe("itsa", "iabc", Filter{Source: "github"}, "")
	e.ingest("f1", "checks.completed", "2 checks failed", "github:o/r#1")
	e.timers.fire()
	if len(e.host.notices) != 1 || !strings.HasSuffix(e.host.notices[0], "RETRO") {
		t.Errorf("the agent's copy: %v", e.host.notices)
	}
	if len(e.host.posts) != 1 || strings.Contains(e.host.posts[0], "RETRO") {
		t.Errorf("the ITSA's copy: %v", e.host.posts)
	}
}

func TestExpiredSubscriptionIsDeletedAndNeverDelivers(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.sql("UPDATE event_subscriptions SET expires_at = ?", e.now.UnixMilli()-1000)
	r := e.ingest("e1", "x", "too late", "github:o/r")
	if r.Matched != 0 || e.timers.count() != 0 {
		t.Errorf("%+v, %d timers", r, e.timers.count())
	}
	if e.count("SELECT COUNT(*) FROM event_subscriptions") != 0 {
		t.Error("the expired subscription stayed")
	}
}

func TestProcessSubscriptionsCountAsMatchedAndQueueNothing(t *testing.T) {
	e := newEnv(t)
	e.subscribe("process", "flow:start", Filter{Source: "github"}, "")
	r := e.ingest("e1", "x", "a", "github:o/r")
	if r.Matched != 1 || e.timers.count() != 0 || e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evq:%'") != 0 {
		t.Errorf("%+v", r)
	}
}

// Restart: what was queued and not delivered is delivered once after the restart, never twice and never lost.
func TestRestartDeliversWhatWasQueuedOnce(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "before the restart", "github:o/r")
	if e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 1 {
		t.Fatal("the folded line is not stored")
	}
	e.restart()
	if e.timers.count() != 1 {
		t.Fatalf("a restart armed %d timers for the one queued batch", e.timers.count())
	}
	if _, m, _, _ := e.host.counts(); m != 0 {
		t.Fatal("delivered before the new fold window closed")
	}
	// A line that joins the batch after the restart goes out with it.
	e.ingest("e2", "x", "after the restart", "github:o/r")
	e.timers.fire()
	if _, m, _, _ := e.host.counts(); m != 1 {
		t.Fatalf("%d mails", m)
	}
	if got := e.host.mails[0]; !strings.Contains(got, "before the restart") || !strings.Contains(got, "after the restart") {
		t.Errorf("%s", got)
	}
	// Another restart finds nothing to deliver.
	e.restart()
	if e.timers.count() != 0 {
		t.Errorf("a delivered batch was queued again: %d timers", e.timers.count())
	}
	if _, m, _, _ := e.host.counts(); m != 1 {
		t.Errorf("%d mails after the second restart", m)
	}
}

// The delivery cursor of a human subscription (its thread) survives a restart too.
func TestRestartKeepsTheHumanThread(t *testing.T) {
	e := newEnv(t)
	e.subscribe("human", "human", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "first", "github:o/r")
	e.timers.fire()
	e.restart()
	e.ingest("e2", "x", "second", "github:o/r")
	e.timers.fire()
	if len(e.host.replyTo) != 2 || e.host.replyTo[1] != "mail1" {
		t.Errorf("the second delivery after the restart starts a thread of its own: %q", e.host.replyTo)
	}
}

// An event wait an event cleared stays cleared across a restart, and its notice reaches the agent once.
func TestEventWaitClearedStaysClearedAcrossARestart(t *testing.T) {
	e := newEnv(t)
	e.working("aboss")
	w, err := e.svc.DeclareWait(context.Background(), "aboss", Declare{Filter: Filter{Source: "github", Subjects: []string{"github:o/r#12"}}, Note: "CI on PR 12"})
	if err != nil {
		t.Fatal(err)
	}
	// The daemon stops after the clear is stored and before the notice is queued.
	e.svc.hookWaitNotice = func() bool { return false }
	s := "CI passed"
	if _, err := e.svc.Ingest(context.Background(), Input{Source: "github", Type: "check_run.completed", Subjects: []string{"github:o/r#12"}, Summary: &s, DedupeKey: "m1"}); err != nil {
		t.Fatal(err)
	}
	if e.count("SELECT COUNT(*) FROM waits WHERE id = ?", w.ID) != 0 {
		t.Fatal("the matching event didn't clear the wait")
	}
	if n, _, _, _ := e.host.counts(); n != 0 {
		t.Fatal("the notice was queued despite the simulated stop")
	}
	e.restart()
	if e.count("SELECT COUNT(*) FROM waits WHERE id = ?", w.ID) != 0 {
		t.Error("the cleared wait came back")
	}
	if n, _, _, _ := e.host.counts(); n != 1 || !strings.Contains(e.host.notices[0], "CI passed") || !strings.Contains(e.host.notices[0], "CI on PR 12") {
		t.Fatalf("the notice after the restart: %v", e.host.notices)
	}
	e.restart()
	if n, _, _, _ := e.host.counts(); n != 1 {
		t.Errorf("the notice reached the agent %d times", n)
	}
	if e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evw:%'") != 0 {
		t.Error("the delivered notice is still stored")
	}
}

func TestEventWaitClearsOnTheFirstMatchOnlyAndNotOnADuplicate(t *testing.T) {
	e := newEnv(t)
	w, _ := e.svc.DeclareWait(context.Background(), "aboss", Declare{Filter: Filter{Source: "github", Subjects: []string{"github:o/r#12"}}})
	e.ingest("x1", "check_run", "another PR", "github:o/r#13")
	if e.count("SELECT COUNT(*) FROM waits WHERE id = ?", w.ID) != 1 {
		t.Fatal("an event outside the filter cleared the wait")
	}
	e.ingest("x2", "check_run.completed", "CI passed", "github:o/r#12")
	if e.count("SELECT COUNT(*) FROM waits WHERE id = ?", w.ID) != 0 {
		t.Fatal("the matching event didn't clear it")
	}
	w2, _ := e.svc.DeclareWait(context.Background(), "aboss", Declare{Filter: Filter{Subjects: []string{"github:o/r#2"}}})
	e.ingest("x2", "x", "a duplicate", "github:o/r#2")
	if e.count("SELECT COUNT(*) FROM waits WHERE id = ?", w2.ID) != 1 {
		t.Error("a duplicate dedupe_key was not stored and must not clear a wait")
	}
	if got := e.count("SELECT COUNT(*) FROM events WHERE type = 'wait:declared'"); got != 2 {
		t.Errorf("%d wait:declared events", got)
	}
}

func TestDeclareWaitDedupesRefreshesAndRefusesNoSelector(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.svc.DeclareWait(ctx, "aboss", Declare{Filter: Filter{ExcludeActors: []string{"bot"}}}); err == nil || !strings.Contains(err.Error(), "needs a filter") {
		t.Errorf("a filter with no selector: %v", err)
	}
	ten, thirty := 10.0, 30.0
	a, err := e.svc.DeclareWait(ctx, "aboss", Declare{Filter: Filter{Subjects: []string{"b", "a"}, Since: "2026-01-01T00:00:00Z"}, Timeout: &ten})
	if err != nil {
		t.Fatal(err)
	}
	if a.Detail == nil || *a.Detail != "an external event (subjects b, a)" || a.Until == nil || *a.Until != "2026-10-28T12:10:00.000Z" {
		t.Errorf("%+v", a)
	}
	// The same wait again, its lists re-ordered, a later since and a new timeout: one wait, refreshed.
	b, err := e.svc.DeclareWait(ctx, "aboss", Declare{Filter: Filter{Subjects: []string{"a", "b"}, Since: "2026-02-01T00:00:00Z"}, Timeout: &thirty})
	if err != nil {
		t.Fatal(err)
	}
	if b.ID != a.ID || e.count("SELECT COUNT(*) FROM waits WHERE kind = 'event'") != 1 {
		t.Fatalf("a second declare made a second wait")
	}
	if b.Until == nil || *b.Until != "2026-10-28T12:30:00.000Z" || b.Data == nil || !strings.Contains(*b.Data, `"since":"2026-02-01T00:00:00Z"`) || !strings.Contains(*b.Data, `"timeout_minutes":30`) {
		t.Errorf("%+v / %v", b, b.Data)
	}
	// Without a timeout the old one stands.
	c, _ := e.svc.DeclareWait(ctx, "aboss", Declare{Filter: Filter{Subjects: []string{"a", "b"}}})
	if c.Until == nil || *c.Until != *b.Until {
		t.Errorf("a declare with no timeout moved until: %v", c.Until)
	}
	if got := e.count("SELECT COUNT(*) FROM events WHERE type = 'wait:declared'"); got != 1 {
		t.Errorf("%d wait:declared events for one wait", got)
	}
}

// Interleaving: the agent is archived between the delivery reading it and sending to it. The recheck under the delivery
// lock drops the delivery, and ForgetAgent waits for the step instead of racing it.
func TestDeliveryDropsWhenTheAgentIsArchivedMidDelivery(t *testing.T) {
	e := newEnv(t)
	e.working("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "to an agent about to go", "github:o/r")
	forgot := make(chan struct{})
	e.svc.hookBeforeSend = func(agent string) {
		// The archive: the row is written, then ForgetAgent runs on its own goroutine, bumps the generation and waits for
		// the delivery's lock.
		e.sql("UPDATE agents SET lifecycle = 'archived' WHERE id = ?", agent)
		go func() {
			e.svc.ForgetAgent(context.Background(), agent)
			close(forgot)
		}()
		before := e.svc.forgotCount(agent)
		for i := 0; i < 1_000_000 && e.svc.forgotCount(agent) == before; i++ {
			runtime.Gosched()
		}
		if e.svc.forgotCount(agent) == before {
			t.Error("ForgetAgent did not move the generation before it waited for the delivery")
		}
	}
	e.timers.fire()
	<-forgot
	if n, m, _, _ := e.host.counts(); n+m != 0 {
		t.Fatalf("an archived agent was sent %d notices and %d mails", n, m)
	}
	if e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 0 || e.count("SELECT COUNT(*) FROM event_subscriptions WHERE id = ?", id) != 0 {
		t.Error("the archived agent's subscription or batch stayed")
	}
}

// Interleaving: the archive has written the row and ForgetAgent has not run yet, so the generation has not moved: the
// recheck's own read of the row drops the delivery.
func TestDeliveryDropsOnAnArchivedRowBeforeForgetAgentRuns(t *testing.T) {
	e := newEnv(t)
	e.working("aboss")
	e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "to an agent archived a moment ago", "github:o/r")
	e.svc.hookBeforeSend = func(agent string) {
		e.sql("UPDATE agents SET lifecycle = 'archived' WHERE id = ?", agent)
	}
	e.timers.fire()
	if n, m, _, _ := e.host.counts(); n+m != 0 {
		t.Errorf("an archived agent was sent %d notices and %d mails", n, m)
	}
}

// Interleaving: the generation moves after the delivery's first read of the agent and the agent still reads active, so the
// generation alone, not only the row, drops the delivery.
func TestDeliveryDropsOnAMovedGenerationEvenIfTheRowStillReadsActive(t *testing.T) {
	e := newEnv(t)
	e.working("aboss")
	e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "stale", "github:o/r")
	e.svc.hookBeforeSend = func(agent string) {
		e.svc.mu.Lock()
		e.svc.forgot[agent]++
		e.svc.mu.Unlock()
	}
	id := e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evq:%'")
	e.timers.fire()
	if n, m, _, _ := e.host.counts(); n+m != 0 {
		t.Errorf("a delivery of a moved generation was sent: %d notices, %d mails", n, m)
	}
	// The agent is not archived (the archive may yet abort): the batch is held, not dropped, and looked at again.
	if e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evq:%'") != id || e.timers.count() != 1 {
		t.Errorf("the batch of a moved generation was dropped or has no timer: %d timers", e.timers.count())
	}
}

// Interleaving: the agent goes idle between the read and the send. The send rechecks, so it is mail, not a notice that
// would wait for a tool call that never comes.
func TestDeliveryRechecksWorkingBeforeSending(t *testing.T) {
	e := newEnv(t)
	e.working("aboss")
	e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "as the turn ends", "github:o/r")
	e.svc.hookBeforeSend = func(agent string) { e.idle(agent) }
	e.timers.fire()
	if n, m, _, _ := e.host.counts(); n != 0 || m != 1 {
		t.Errorf("%d notices, %d mails: the agent was idle at the send", n, m)
	}
}

// An event that arrives while a delivery is in flight stays queued with a timer of its own.
func TestEventDuringADeliveryStaysQueued(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "first", "github:o/r")
	e.svc.hookAfterRead = func(string) {
		// Ingest runs on another goroutine of the daemon while the delivery holds its lock.
		e.svc.hookAfterRead = nil
		e.ingest("e2", "x", "second", "github:o/r")
	}
	e.timers.fire()
	if _, m, _, _ := e.host.counts(); m != 1 || strings.Contains(e.host.mails[0], "second") {
		t.Fatalf("%v", e.host.mails)
	}
	q, ok, _ := e.db.ReadQueue(context.Background(), id)
	if !ok || len(q.Lines) != 1 || !strings.Contains(q.Lines[0].Text, "second") {
		t.Fatalf("the later event is not left queued: %+v", q)
	}
	if e.timers.count() != 1 {
		t.Fatalf("%d timers for the leftover", e.timers.count())
	}
	e.timers.fire()
	if _, m, _, _ := e.host.counts(); m != 2 || !strings.Contains(e.host.mails[1], "second") || strings.Contains(e.host.mails[1], "first") {
		t.Errorf("%v", e.host.mails)
	}
}

// A batch that keeps failing is kept: past MaxAttempts it is tried again after a longer wait each time, up to
// MaxBackoff, and goes out when the failure ends.
func TestFailedDeliveryIsKeptAndBacksOff(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.host.failMail = true
	e.ingest("e1", "x", "stuck", "github:o/r")
	for i := 1; i <= MaxAttempts+8; i++ {
		e.timers.fire()
		q, ok, _ := e.db.ReadQueue(context.Background(), id)
		if !ok || len(q.Lines) != 1 || q.Attempts != i || e.timers.count() != 1 {
			t.Fatalf("attempt %d: %+v ok=%v, %d timers: a failing batch is kept, with a timer", i, q, ok, e.timers.count())
		}
	}
	d := e.timers.delays
	if d[1] != time.Minute || d[2] != 2*time.Minute || d[3] != 4*time.Minute || d[len(d)-1] != MaxBackoff {
		t.Errorf("waits between tries %v: each doubles, up to %v", d, MaxBackoff)
	}
	// The failure ends: the batch is delivered, and the count starts again.
	e.host.mu.Lock()
	e.host.failMail = false
	e.host.mu.Unlock()
	e.timers.fire()
	if _, m, _, _ := e.host.counts(); m != 1 || !strings.Contains(e.host.mails[0], "stuck") {
		t.Errorf("%v", e.host.mails)
	}
	if e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 0 {
		t.Error("the delivered batch stayed")
	}
}

func TestForgetAgentDropsSubscriptionsBatchesAndWaitNotices(t *testing.T) {
	e := newEnv(t)
	e.working("aboss")
	mine := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	byBoss := e.subscribe("agent", "achild", Filter{Source: "github"}, "")
	other := e.subscribe("itsa", "iabc", Filter{Source: "github"}, "")
	e.svc.hookWaitNotice = func() bool { return false }
	if _, err := e.svc.DeclareWait(context.Background(), "aboss", Declare{Filter: Filter{Source: "github"}}); err != nil {
		t.Fatal(err)
	}
	e.ingest("e1", "x", "a", "github:o/r")
	if e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+mine) != 1 || e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evw:%'") != 1 {
		t.Fatal("setup: the batch and the wait notice are stored")
	}
	armed := e.timers.count()
	e.svc.ForgetAgent(context.Background(), "aboss")
	if e.timers.count() != armed-1 {
		t.Errorf("%d timers after the forget, %d before: the agent's fold timer stays", e.timers.count(), armed)
	}
	if e.count("SELECT COUNT(*) FROM event_subscriptions WHERE id = ?", mine) != 0 || e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+mine) != 0 {
		t.Error("the agent's subscription or batch stayed")
	}
	if e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evw:%'") != 0 {
		t.Error("the agent's wait notice stayed")
	}
	if e.count("SELECT COUNT(*) FROM event_subscriptions WHERE id IN (?, ?)", byBoss, other) != 2 || e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+other) != 1 {
		t.Error("another subscriber's subscription or batch was dropped")
	}
	e.timers.fire()
	for _, got := range append(append([]string(nil), e.host.notices...), e.host.mails...) {
		if strings.HasPrefix(got, "aboss|") {
			t.Errorf("a notice or mail for the forgotten agent: %s", got)
		}
	}
}

func TestWaitNoticeForAnArchivedAgentIsDroppedNotSent(t *testing.T) {
	e := newEnv(t)
	if _, err := e.svc.DeclareWait(context.Background(), "agone", Declare{Filter: Filter{Source: "github"}}); err != nil {
		t.Fatal(err)
	}
	e.ingest("e1", "x", "a", "github:o/r")
	if n, _, _, _ := e.host.counts(); n != 0 {
		t.Errorf("an archived agent got a wait notice")
	}
	if e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evw:%'") != 0 {
		t.Error("its notice stayed stored")
	}
}

func TestRemoveSubscriptionDropsItsBatchAndTimer(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "a", "github:o/r")
	if ok, err := e.svc.RemoveSubscription(context.Background(), id); !ok || err != nil {
		t.Fatalf("%v %v", ok, err)
	}
	if e.timers.count() != 0 || e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 0 {
		t.Error("the folded delivery of a removed subscription stayed")
	}
	e.timers.fire()
	if _, m, _, _ := e.host.counts(); m != 0 {
		t.Error("a removed subscription delivered")
	}
}

// Shutdown: the timers stop, nothing fires after, and a delivery in flight finishes before Close returns.
func TestCloseStopsTimersAndWaitsForADeliveryInFlight(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "a", "github:o/r")
	if e.timers.count() != 1 {
		t.Fatal("setup")
	}
	inFlight, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	e.svc.hookBeforeSend = func(string) {
		close(inFlight)
		<-release
	}
	go func() {
		e.timers.fire()
		close(done)
	}()
	<-inFlight
	closed := make(chan struct{})
	go func() {
		e.svc.Close()
		close(closed)
	}()
	select {
	case <-closed:
		t.Fatal("Close returned while a delivery was in flight")
	default:
	}
	close(release)
	<-closed
	<-done
	// After Close: an event arms no timer and a fired one does nothing.
	e.ingest("e2", "x", "b", "github:o/r")
	if e.timers.count() != 0 {
		t.Errorf("%d timers armed after Close", e.timers.count())
	}
}

func TestTimerFiredAfterCloseDoesNothing(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "a", "github:o/r")
	e.timers.mu.Lock()
	var fn func()
	for _, f := range e.timers.pending {
		fn = f
	}
	e.timers.mu.Unlock()
	e.svc.Close()
	fn()
	if _, m, _, _ := e.host.counts(); m != 0 {
		t.Error("a timer that fired after Close delivered")
	}
	if e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evq:%'") != 1 {
		t.Error("the batch is not left for the next start")
	}
}

func TestFoldZeroArmsAtOnce(t *testing.T) {
	e := newEnv(t)
	e.svc.o.Fold = func() time.Duration { return 0 }
	e.idle("aboss")
	e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "a", "github:o/r")
	if len(e.timers.delays) == 0 || e.timers.delays[len(e.timers.delays)-1] != 0 {
		t.Errorf("delays %v", e.timers.delays)
	}
}

// A delivery that hangs past closeWait is cancelled, and its batch stays queued for the next start: neither a retry
// count nor an ack is written for a stop.
func TestCloseCancelsAHungDeliveryAndLeavesItsBatch(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "a", "github:o/r")
	old := closeWait
	closeWait = time.Millisecond
	defer func() { closeWait = old }()
	inFlight := make(chan struct{})
	e.svc.hookBeforeSend = func(string) {
		close(inFlight)
		<-e.svc.base.Done()
	}
	done := make(chan struct{})
	go func() {
		e.timers.fire()
		close(done)
	}()
	<-inFlight
	e.svc.Close()
	<-done
	q, ok, _ := e.db.ReadQueue(context.Background(), id)
	if !ok || len(q.Lines) != 1 || q.Attempts != 0 {
		t.Errorf("the batch after a stop: %+v", q)
	}
	if _, m, _, _ := e.host.counts(); m != 0 {
		t.Errorf("%d mails after a stop", m)
	}
}

// ---- round 1 of the review of #1332 ----

// A: a notice for a working agent is stored as an answer notice in the delivery's own transaction, with its lines
// leaving the queue: a restart before the agent has it finds it stored (the lifecycle restores answer notices), and the
// queue no longer holds it, so it comes back once.
func TestWorkingAgentsNoticeIsStoredWithItsAckAndSurvivesARestart(t *testing.T) {
	e := newEnv(t)
	e.working("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "while it works", "github:o/r")
	e.timers.fire()
	if len(e.host.notices) != 1 || len(e.host.rows) != 1 || e.host.rows[0] == 0 {
		t.Fatalf("notices %v, rows %v", e.host.notices, e.host.rows)
	}
	if e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 0 {
		t.Error("the delivered lines stayed in the queue")
	}
	if e.count("SELECT COUNT(*) FROM answer_notices WHERE id = ? AND agent_id = 'aboss' AND text LIKE '%while it works%'", e.host.rows[0]) != 1 {
		t.Error("the notice is not stored for the agent")
	}
	// The daemon stops before the agent has the notice: the row is still there, and nothing is queued twice.
	e.restart()
	if e.count("SELECT COUNT(*) FROM answer_notices WHERE agent_id = 'aboss'") != 1 || e.timers.count() != 0 {
		t.Errorf("after the restart: %d notice rows, %d timers", e.count("SELECT COUNT(*) FROM answer_notices WHERE agent_id = 'aboss'"), e.timers.count())
	}
	if len(e.host.notices) != 1 {
		t.Errorf("the restart queued the notice again: %v", e.host.notices)
	}
}

// A, boundary: the delivery is not made when its transaction can't be: an agent that went idle between the read and the
// transaction gets mail, not a notice that waits for a tool call that never comes, and the lines stay until it does.
func TestNoticeTransactionRefusesAnAgentThatWentIdle(t *testing.T) {
	e := newEnv(t)
	e.working("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "as the turn ends", "github:o/r")
	e.svc.hookAfterRecheck = func(agent string) {
		e.svc.hookAfterRecheck = nil
		e.idle(agent)
	}
	e.timers.fire()
	if n, m, _, _ := e.host.counts(); n+m != 0 || e.count("SELECT COUNT(*) FROM answer_notices") != 0 {
		t.Fatalf("%d notices, %d mails, %d notice rows from the refused transaction", n, m, e.count("SELECT COUNT(*) FROM answer_notices"))
	}
	if e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 1 || e.timers.count() != 1 {
		t.Fatalf("the batch must stay with a timer: %d timers", e.timers.count())
	}
	e.timers.fire()
	if n, m, _, _ := e.host.counts(); n != 0 || m != 1 {
		t.Errorf("%d notices, %d mails: the agent is idle now", n, m)
	}
}

// A, wait notices: the cleared wait's notice is stored as an answer notice and its own row removed in one transaction. A
// restart between the clear and the delivery brings it once.
func TestWaitNoticeIsStoredAsAnswerNoticeWithItsRowRemoved(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	if _, err := e.svc.DeclareWait(context.Background(), "aboss", Declare{Filter: Filter{Source: "github"}}); err != nil {
		t.Fatal(err)
	}
	e.svc.hookWaitNotice = func() bool { return false }
	e.ingest("e1", "x", "the awaited one", "github:o/r")
	if e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evw:%'") != 1 || e.count("SELECT COUNT(*) FROM answer_notices") != 0 {
		t.Fatal("setup: the wait cleared and its notice is only stored")
	}
	e.restart()
	if len(e.host.notices) != 1 || !strings.Contains(e.host.notices[0], "the awaited one") || e.host.rows[0] == 0 {
		t.Fatalf("after the restart: %v rows %v", e.host.notices, e.host.rows)
	}
	if e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evw:%'") != 0 || e.count("SELECT COUNT(*) FROM answer_notices WHERE agent_id = 'aboss'") != 1 {
		t.Error("the stored copy and the answer notice are not one swap")
	}
	e.restart()
	if len(e.host.notices) != 1 {
		t.Errorf("the notice came again: %v", e.host.notices)
	}
}

// 4: the notice an ingest hands to delivery is the one it stored, text and all; a stored copy with no text is dropped,
// never delivered empty.
func TestWaitNoticeNeverDeliversEmptyText(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	if _, err := e.svc.DeclareWait(context.Background(), "aboss", Declare{Filter: Filter{Source: "github"}}); err != nil {
		t.Fatal(err)
	}
	e.ingest("e1", "x", "carried out of the transaction", "github:o/r")
	if len(e.host.notices) != 1 || !strings.Contains(e.host.notices[0], "carried out of the transaction") {
		t.Fatalf("%v", e.host.notices)
	}
	e.sql(`INSERT INTO kv (key, value) VALUES ('evw:w-broken', '{"agent":"aboss","text":""}')`)
	e.restart()
	if len(e.host.notices) != 1 || e.count("SELECT COUNT(*) FROM kv WHERE key LIKE 'evw:%'") != 0 {
		t.Errorf("an empty notice: %v", e.host.notices)
	}
}

// B: the mail, the removal of its lines and the human thread's pointer commit together. A host that stores the mail and
// then fails (a crash after the commit) leaves nothing to deliver again.
func TestMailAndAckCommitTogether(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "once", "github:o/r")
	e.host.failAfterStore = true
	e.timers.fire()
	if e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 0 {
		t.Fatal("the mail was stored and the lines stayed")
	}
	e.host.failAfterStore = false
	for e.timers.count() > 0 {
		e.timers.fire()
	}
	if _, m, _, _ := e.host.counts(); m != 1 {
		t.Errorf("%d mails: a delivery whose mail committed is not made again", m)
	}
}

func TestMailRollsBackWithAnAckThatCannotCommit(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "gone from under it", "github:o/r")
	e.svc.hookAfterRecheck = func(string) {
		e.svc.hookAfterRecheck = nil
		e.sql("DELETE FROM kv WHERE key = ?", "evq:"+id)
	}
	e.timers.fire()
	if _, m, _, _ := e.host.counts(); m != 0 {
		t.Errorf("%d mails stored for a queue that was gone at the commit", m)
	}
}

func TestHumanThreadPointerCommitsWithTheMail(t *testing.T) {
	e := newEnv(t)
	id := e.subscribe("human", "human", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "first", "github:o/r")
	e.timers.fire()
	sub, err := e.db.FindSubscription(context.Background(), id)
	if err != nil || sub.LastMailID == nil || *sub.LastMailID != "mail1" {
		t.Fatalf("%+v %v", sub, err)
	}
	if e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 0 {
		t.Error("the delivered lines stayed")
	}
}

// B, fallback: a host that stored the mail some other way (no commit ran) still has its lines removed, and the human's
// pointer recorded, by the service.
func TestDeliveryWhoseCommitDidNotRunIsAckedSeparately(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	e.host.noCommit = true
	a := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	h := e.subscribe("human", "human", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "somewhere else", "github:o/r")
	e.timers.fire()
	if e.count("SELECT COUNT(*) FROM kv WHERE key IN (?, ?)", "evq:"+a, "evq:"+h) != 0 {
		t.Error("the lines stayed")
	}
	sub, _ := e.db.FindSubscription(context.Background(), h)
	if sub.LastMailID == nil || *sub.LastMailID != "mail2" && *sub.LastMailID != "mail1" {
		t.Errorf("the human thread pointer: %v", sub.LastMailID)
	}
}

// G: the archive lands after the delivery's last read, before its transaction. The transaction reads the agent itself,
// so nothing is sent: not a notice to a working agent, not mail to an idle one.
func TestArchiveAfterTheFinalRecheckSendsNothing(t *testing.T) {
	for _, working := range []bool{true, false} {
		e := newEnv(t)
		if working {
			e.working("aboss")
		} else {
			e.idle("aboss")
		}
		id := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
		e.ingest("e1", "x", "to an agent archived at the last moment", "github:o/r")
		e.svc.hookAfterRecheck = func(agent string) {
			e.sql("UPDATE agents SET lifecycle = 'archived' WHERE id = ?", agent)
		}
		e.timers.fire()
		if n, m, _, _ := e.host.counts(); n+m != 0 || e.count("SELECT COUNT(*) FROM answer_notices") != 0 {
			t.Errorf("working=%v: %d notices, %d mails, %d notice rows for an archived agent", working, n, m, e.count("SELECT COUNT(*) FROM answer_notices"))
		}
		if e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 0 {
			t.Errorf("working=%v: the batch of an archived agent stayed", working)
		}
	}
}

// E: an ending event deletes the subscription and keeps its delivery; an archive finds that delivery through the
// subscriber the queue stored and removes it with its timer.
func TestArchiveRemovesTheQueueOfAnEndedSubscription(t *testing.T) {
	e := newEnv(t)
	e.working("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github", EndsOn: []string{"merged"}}, "")
	e.ingest("e1", "merged", "the end", "github:o/r")
	if e.count("SELECT COUNT(*) FROM event_subscriptions WHERE id = ?", id) != 0 || e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 1 || e.timers.count() != 1 {
		t.Fatal("setup: the subscription ended and its delivery is queued with a timer")
	}
	e.svc.ForgetAgent(context.Background(), "aboss")
	if e.count("SELECT COUNT(*) FROM kv WHERE key = ?", "evq:"+id) != 0 || e.timers.count() != 0 {
		t.Errorf("the ended subscription's queue stayed: %d timers", e.timers.count())
	}
	e.timers.fire()
	if n, m, _, _ := e.host.counts(); n+m != 0 {
		t.Errorf("%d notices, %d mails for a forgotten agent", n, m)
	}
}

// E: a subscription that expires with lines buffered still delivers them: the events were in time, and the delivery is
// the queue's, not the subscription's.
func TestExpiryWithABufferedQueueStillDeliversIt(t *testing.T) {
	e := newEnv(t)
	e.idle("aboss")
	id := e.subscribe("agent", "aboss", Filter{Source: "github"}, "")
	e.ingest("e1", "x", "in time", "github:o/r")
	e.sql("UPDATE event_subscriptions SET expires_at = ?", e.now.UnixMilli()-1000)
	e.ingest("e2", "x", "too late", "github:o/r")
	if e.count("SELECT COUNT(*) FROM event_subscriptions WHERE id = ?", id) != 0 {
		t.Fatal("the expired subscription stayed")
	}
	e.timers.fire()
	if _, m, _, _ := e.host.counts(); m != 1 || !strings.Contains(e.host.mails[0], "in time") || strings.Contains(e.host.mails[0], "too late") {
		t.Errorf("%v", e.host.mails)
	}
}

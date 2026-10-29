package lifecycle

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/push"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// shim is a fake `stam mcp` shim reading an agent's push stream.
type shim struct {
	prompts chan shimPrompt
	stop    func()
}

type shimPrompt struct {
	Content string            `json:"content"`
	Meta    map[string]string `json:"meta"`
}

// shim connects a fake shim to the agent's push stream on life, and returns once the stream can take pushes.
func (l *live) shim(life *Lifecycle, id string) *shim {
	l.t.Helper()
	before := life.streams.Has(id)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { life.ServeStream(w, r, id) }))
	ctx, cancel := context.WithCancel(l.ctx)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	if err != nil {
		l.t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		l.t.Fatal(err)
	}
	s := &shim{prompts: make(chan shimPrompt, 16)}
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer res.Body.Close()
		lines := bufio.NewReader(res.Body)
		for {
			line, err := lines.ReadString('\n')
			if err != nil {
				return
			}
			if data, ok := strings.CutPrefix(line, "data: "); ok {
				var p shimPrompt
				if json.Unmarshal([]byte(data), &p) == nil {
					s.prompts <- p
				}
			}
		}
	}()
	var once bool
	s.stop = func() {
		if once {
			return
		}
		once = true
		cancel()
		<-done
		srv.Close()
	}
	l.t.Cleanup(s.stop)
	if !before {
		l.until("the stream", func() bool { return life.streams.Has(id) })
	}
	l.settled(life, id)
	return s
}

// settled waits until the agent has no scheduled push waiting or running on life.
func (l *live) settled(life *Lifecycle, id string) {
	l.t.Helper()
	l.until("the scheduled pushes", func() bool {
		life.mu.Lock()
		defer life.mu.Unlock()
		return life.pushTimers[id] == nil && life.pushRuns[id] == 0
	})
}

// next is the shim's next prompt, failing the test when none comes.
func (s *shim) next(t *testing.T) shimPrompt {
	t.Helper()
	select {
	case p := <-s.prompts:
		return p
	case <-time.After(20 * time.Second):
		t.Fatal("no prompt reached the shim")
		return shimPrompt{}
	}
}

// none checks the shim got no prompt so far.
func (s *shim) none(t *testing.T, what string) {
	t.Helper()
	select {
	case p := <-s.prompts:
		t.Fatalf("%s: a prompt reached the shim: %q", what, p.Content)
	default:
	}
}

// mail stores a mail from the human to the agent, as a send does.
func (l *live) mail(id, mailID, subject string, quiet bool) {
	l.t.Helper()
	m := db.Stored{ID: mailID, ThreadID: mailID, From: "human", FromName: "human", Subject: subject, Body: "b", To: []string{id}}
	if quiet {
		m.Quiet = []string{id}
	}
	if _, err := l.db.StoreMail(l.ctx, m); err != nil {
		l.t.Fatal(err)
	}
}

func (l *live) unpushed(id string) []string {
	l.t.Helper()
	out, err := l.db.Unpushed(l.ctx, id)
	if err != nil {
		l.t.Fatal(err)
	}
	return out
}

func (l *live) render(name string, vars map[string]string) string {
	l.t.Helper()
	out, err := l.life.render(name, vars)
	if err != nil {
		l.t.Fatal(err)
	}
	return out
}

// TestPushIfIdle: an idle agent's unpushed mail and queued notices reach it as one prompt over its own shim's stream,
// once the shim connects; with no stream they stay queued and unpushed. Only after the prompt reached the stream is the
// mail marked pushed and are the notices dropped, and a later push names only mail that is new since.
func TestPushIfIdle(t *testing.T) {
	l := newLive(t)
	l.spawn("alpu1")
	l.idle("alpu1")
	l.mail("alpu1", "mlpu1", "first", false)
	l.life.QueueNotice(l.ctx, "alpu1", "[stam] a notice", false)
	// Nowhere to go: no stream.
	l.life.pushIfIdle(l.ctx, "alpu1")
	if got := l.unpushed("alpu1"); len(got) != 1 || len(l.life.Notices("alpu1")) != 1 || l.has("alpu1", "pushed") {
		t.Fatalf("with no stream: unpushed %v, notices %v", got, l.life.Notices("alpu1"))
	}
	// The notice's own scheduled push finds no stream either, so only the shim's connecting can push now.
	l.settled(l.life, "alpu1")

	// The shim connecting pushes them.
	sh := l.shim(l.life, "alpu1")
	p := sh.next(t)
	want := "[stam] a notice\n\n" + l.render("mail-prompt", map[string]string{"count": "1", "list": "- mlpu1 from human: first"})
	if p.Content != want || p.Meta["kind"] != "mail" || len(p.Meta) != 1 {
		t.Fatalf("prompt %q %v\nwant %q", p.Content, p.Meta, want)
	}
	l.until("the pushed event", func() bool { return l.has("alpu1", "pushed") })
	if e := lastEvent(t, l, "alpu1", "pushed"); e != `{"mail":true,"notices":1}` {
		t.Errorf("pushed: %s", e)
	}
	if got := l.unpushed("alpu1"); len(got) != 0 || len(l.life.Notices("alpu1")) != 0 {
		t.Errorf("after the push: unpushed %v, notices %v", got, l.life.Notices("alpu1"))
	}
	// Nothing new: no prompt.
	l.life.pushIfIdle(l.ctx, "alpu1")
	sh.none(t, "nothing new")

	// New mail: the prompt lists all unread mail, and only the new one was unpushed.
	l.mail("alpu1", "mlpu2", "second", false)
	l.life.SchedulePush("alpu1")
	p = sh.next(t)
	want = l.render("mail-prompt", map[string]string{"count": "2", "list": "- mlpu2 from human: second\n- mlpu1 from human: first"})
	if p.Content != want {
		t.Fatalf("second prompt %q\nwant %q", p.Content, want)
	}
	// The pushed event is written after the mail is marked, so wait for the event itself.
	l.until("the second push", func() bool { return lastEvent(t, l, "alpu1", "pushed") == `{"mail":true,"notices":0}` })
	if got := l.unpushed("alpu1"); len(got) != 0 {
		t.Errorf("after the second push: unpushed %v", got)
	}

	// A working agent isn't prompted, nor a stopped one.
	l.set("alpu1", db.Field{Col: "activity", Val: "working"})
	l.life.QueueNotice(l.ctx, "alpu1", "[stam] mid-turn", false)
	l.settled(l.life, "alpu1")
	l.life.pushIfIdle(l.ctx, "alpu1")
	sh.none(t, "a working agent")
	if len(l.life.Notices("alpu1")) != 1 {
		t.Fatal("a working agent's notice left the queue")
	}
	l.idle("alpu1")
	l.set("alpu1", db.Field{Col: "lifecycle", Val: "shut_down"})
	l.life.pushIfIdle(l.ctx, "alpu1")
	sh.none(t, "a stopped agent")
}

// TestPushNoticesOnly: notices alone are a reason to push; an agent of another harness is never pushed to.
func TestPushNoticesOnly(t *testing.T) {
	l := newLive(t)
	l.spawn("alpn1")
	l.idle("alpn1")
	sh := l.shim(l.life, "alpn1")
	l.life.QueueNotice(l.ctx, "alpn1", "[stam] one", false)
	l.life.QueueNotice(l.ctx, "alpn1", "[stam] two", true)
	if p := sh.next(t); p.Content != "[stam] one\n\n[stam] two" {
		t.Fatalf("prompt %q", p.Content)
	}
	l.until("the pushed event", func() bool { return l.has("alpn1", "pushed") })
	if e := lastEvent(t, l, "alpn1", "pushed"); e != `{"mail":false,"notices":2}` {
		t.Errorf("pushed: %s", e)
	}

	// A push drops only the notices it delivered: one queued while it was on its way stays.
	l.life.mu.Lock()
	l.life.notices["alpn1"] = []notice{{Text: "a", seq: 1001}, {Text: "b", seq: 1002}}
	l.life.mu.Unlock()
	l.life.dropNotices("alpn1", []notice{{Text: "a", seq: 1001}})
	if n := l.life.Notices("alpn1"); len(n) != 1 || n[0] != "b" {
		t.Fatalf("after a partial drop: %v", n)
	}
	l.life.dropNotices("alpn1", []notice{{Text: "b", seq: 1002}})

	execOn(t, l, "UPDATE agents SET harness = 'codex' WHERE id = 'alpn1'")
	l.life.QueueNotice(l.ctx, "alpn1", "[stam] three", false)
	l.life.pushIfIdle(l.ctx, "alpn1")
	sh.none(t, "a codex agent")
	if len(l.life.Notices("alpn1")) != 1 {
		t.Error("the codex agent's notice left the queue")
	}
}

// failingWriter is a push stream whose writes fail after the connected line: a shim that dropped mid-push.
type failingWriter struct {
	h      http.Header
	writes int
}

func (w *failingWriter) Header() http.Header { return w.h }
func (w *failingWriter) WriteHeader(int)     {}
func (w *failingWriter) Flush()              {}
func (w *failingWriter) Write(b []byte) (int, error) {
	if w.writes++; w.writes > 1 {
		return 0, errors.New("broken pipe")
	}
	return len(b), nil
}

// TestPushStreamDrops: a stream that fails to write the prompt, or never takes it, delivers nothing: the mail stays
// unpushed and the notices queued, and a shim that connects later gets them.
func TestPushStreamDrops(t *testing.T) {
	l := newLive(t)
	l.spawn("alpd1")
	l.idle("alpd1")
	ctx, cancel := context.WithCancel(l.ctx)
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/api/agents/alpd1/stream", nil).WithContext(ctx)
	served := make(chan struct{})
	go func() {
		defer close(served)
		l.life.streams.Serve(ctx, &failingWriter{h: http.Header{}}, req, "alpd1", nil)
	}()
	l.until("the failing stream", func() bool { return l.life.streams.Has("alpd1") })
	l.mail("alpd1", "mlpd1", "kept", false)
	l.life.QueueNotice(l.ctx, "alpd1", "[stam] kept", false)
	l.life.pushIfIdle(l.ctx, "alpd1")
	<-served
	if got := l.unpushed("alpd1"); len(got) != 1 || len(l.life.Notices("alpd1")) != 1 || l.has("alpd1", "pushed") || l.life.streams.Has("alpd1") {
		t.Fatalf("after the failed write: unpushed %v, notices %v", got, l.life.Notices("alpd1"))
	}
	if l.life.prompt(l.ctx, l.agent("alpd1"), "a prompt", "prompt") || l.has("alpd1", "prompt:sent") {
		t.Fatal("a prompt with no stream counted as sent")
	}
	sh := l.shim(l.life, "alpd1")
	if p := sh.next(t); !strings.HasPrefix(p.Content, "[stam] kept\n\n") || !strings.Contains(p.Content, "mlpd1") {
		t.Fatalf("prompt %q", p.Content)
	}
	l.until("the push", func() bool { return len(l.unpushed("alpd1")) == 0 })
}

// TestPushAdmission: an agent with a cost blocker, or taken over by a live successor, isn't pushed to; the refusal is a
// cost:refused event and the mail stays unpushed.
func TestPushAdmission(t *testing.T) {
	l := newLive(t)
	l.spawn("alpa1")
	l.idle("alpa1")
	sh := l.shim(l.life, "alpa1")
	execOn(t, l, "INSERT INTO blockers (agent_id, kind, account, reason, since) VALUES ('alpa1', 'window', 'claude-max', 'five_hour at 100%', '2026-10-21T00:00:00.000Z')")
	l.mail("alpa1", "mlpa1", "held", false)
	l.life.pushIfIdle(l.ctx, "alpa1")
	sh.none(t, "a blocked agent")
	if e := lastEvent(t, l, "alpa1", "cost:refused"); e != `{"kind":"mail","reason":"window on claude-max: five_hour at 100%"}` {
		t.Errorf("refused: %s", e)
	}
	if len(l.unpushed("alpa1")) != 1 {
		t.Fatal("the held mail was marked pushed")
	}
	execOn(t, l, "DELETE FROM blockers")
	l.spawn("alpa2")
	l.set("alpa1", db.Field{Col: "activity", Val: "idle"})
	execOn(t, l, "UPDATE agents SET forwarded_to = 'alpa2' WHERE id = 'alpa1'")
	l.life.pushIfIdle(l.ctx, "alpa1")
	sh.none(t, "a taken-over agent")
	if e := lastEvent(t, l, "alpa1", "cost:refused"); !strings.Contains(e, `taken over by`) {
		t.Errorf("refused: %s", e)
	}
	execOn(t, l, "UPDATE agents SET forwarded_to = NULL WHERE id = 'alpa1'")
	l.life.pushIfIdle(l.ctx, "alpa1")
	if p := sh.next(t); !strings.Contains(p.Content, "mlpa1") {
		t.Fatalf("prompt %q", p.Content)
	}
}

// TestPushHold: while stam types into the agent's input, its push waits, and runs once the typing is done.
func TestPushHold(t *testing.T) {
	l := newLive(t)
	l.spawn("alph1")
	l.idle("alph1")
	sh := l.shim(l.life, "alph1")
	l.mail("alph1", "mlph1", "held", false)
	err := l.life.HoldingPushes("alph1", func() error {
		l.life.pushIfIdle(l.ctx, "alph1")
		sh.none(t, "a held push")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(l.unpushed("alph1")) != 1 {
		t.Fatal("the held push marked the mail")
	}
	// The held push was rescheduled.
	if p := sh.next(t); !strings.Contains(p.Content, "mlph1") {
		t.Fatalf("prompt %q", p.Content)
	}
}

// TestPushHoldMidFlight: a push already past its hold check when the typing starts finishes first, as TS's push runs
// from the check to the prompt with no await: the typing waits for it, and a push that comes during the typing waits.
func TestPushHoldMidFlight(t *testing.T) {
	l := newLive(t)
	l.spawn("alpm1")
	l.idle("alpm1")
	sh := l.shim(l.life, "alpm1")
	l.mail("alpm1", "mlpm1", "first", false)
	inPush, release := make(chan struct{}), make(chan struct{})
	l.life.pushing = func(string) {
		close(inPush)
		<-release
	}
	pushed := make(chan struct{})
	go func() {
		defer close(pushed)
		l.life.pushIfIdle(l.ctx, "alpm1")
	}()
	<-inPush
	started := make(chan struct{})
	held := make(chan error, 1)
	go func() {
		held <- l.life.HoldingPushes("alpm1", func() error {
			close(started)
			// The push that was in flight is out before the typing starts.
			if p := sh.next(t); !strings.Contains(p.Content, "mlpm1") {
				t.Errorf("prompt %q", p.Content)
			}
			l.mail("alpm1", "mlpm2", "during the typing", false)
			l.life.pushIfIdle(l.ctx, "alpm1")
			sh.none(t, "a push during the typing")
			return nil
		})
	}()
	select {
	case <-started:
		t.Fatal("the typing started while a push was in flight")
	case <-time.After(200 * time.Millisecond):
	}
	l.life.pushing = nil
	close(release)
	<-pushed
	if err := <-held; err != nil {
		t.Fatal(err)
	}
	// The push held off by the typing was rescheduled.
	if p := sh.next(t); !strings.Contains(p.Content, "mlpm2") {
		t.Fatalf("prompt %q", p.Content)
	}
}

// TestPushAfterRestart: the notice queue is in memory, as in TS, but unread mail stays unpushed in the database: a new
// daemon pushes it once the agent's shim connects to it.
func TestPushAfterRestart(t *testing.T) {
	l := newLive(t)
	l.spawn("alpr1")
	l.idle("alpr1")
	l.mail("alpr1", "mlpr1", "before the restart", false)
	l.life.pushIfIdle(l.ctx, "alpr1")
	opts := l.opts
	opts.Streams = newStreams()
	life2 := New(l.ctx, opts)
	t.Cleanup(life2.Wait)
	sh := l.shim(life2, "alpr1")
	if p := sh.next(t); !strings.Contains(p.Content, "- mlpr1 from human: before the restart") {
		t.Fatalf("prompt %q", p.Content)
	}
	l.until("the push", func() bool { return len(l.unpushed("alpr1")) == 0 })
}

// TestPushAfterWait: once Wait began, a push timer that fires starts nothing, so no push runs while the database closes.
func TestPushAfterWait(t *testing.T) {
	l := newLive(t)
	l.spawn("alpw1")
	l.idle("alpw1")
	opts := l.opts
	opts.Streams = newStreams()
	life2 := New(l.ctx, opts)
	sh := l.shim(life2, "alpw1")
	life2.Wait()
	l.mail("alpw1", "mlpw1", "after the wait", false)
	life2.SchedulePush("alpw1")
	l.settled(life2, "alpw1")
	sh.none(t, "a push after Wait")
	if got := l.unpushed("alpw1"); len(got) != 1 {
		t.Errorf("unpushed %v", got)
	}
}

// TestInTurnNotice: after a tool call, a working agent's queued notices, all but the idle-only ones, and the note of its
// loud unread mail come back as the PostToolUse hook's additionalContext; quiet ITSA mail waits for the idle push.
func TestInTurnNotice(t *testing.T) {
	l := newLive(t)
	l.spawn("alpt1")
	l.set("alpt1", db.Field{Col: "activity", Val: "working"})
	post := func() *string {
		t.Helper()
		out, err := l.life.OnHook(l.ctx, "claude", l.agent("alpt1"), jsjson.NewObject("hook_event_name", "PostToolUse", "tool_name", "Bash"), new([]int64))
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	if out := post(); out != nil {
		t.Fatalf("nothing new: %q", *out)
	}
	l.mail("alpt1", "mlpt0", "quiet", true)
	if out := post(); out != nil {
		t.Fatalf("quiet mail only: %q", *out)
	}
	l.life.QueueNotice(l.ctx, "alpt1", "[stam] now", false)
	l.life.QueueNotice(l.ctx, "alpt1", "[stam] a new task", true)
	l.mail("alpt1", "mlpt1", "loud", false)
	out := post()
	want := "[stam] now\n\n" + l.render("mail-notice", map[string]string{"count": "1", "list": "- mlpt1 from human: loud"})
	var got struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if out == nil || json.Unmarshal([]byte(*out), &got) != nil || got.HookSpecificOutput.HookEventName != "PostToolUse" || got.HookSpecificOutput.AdditionalContext != want {
		t.Fatalf("answer %v\nwant %q", out, want)
	}
	if !l.has("alpt1", "mail:notice") {
		t.Error("no mail:notice event")
	}
	if n := l.life.Notices("alpt1"); len(n) != 1 || n[0] != "[stam] a new task" {
		t.Errorf("left queued: %v", n)
	}
	// The in-turn notice doesn't push the mail: the idle push still prompts about it.
	if len(l.unpushed("alpt1")) != 2 {
		t.Error("the in-turn notice marked mail pushed")
	}
}

// TestTurnEndPush: a turn end schedules the push, so mail that came in during the turn arrives once it ends.
func TestTurnEndPush(t *testing.T) {
	l := newLive(t)
	l.spawn("alpe1")
	l.set("alpe1", db.Field{Col: "activity", Val: "working"})
	sh := l.shim(l.life, "alpe1")
	l.mail("alpe1", "mlpe1", "during the turn", false)
	l.life.pushIfIdle(l.ctx, "alpe1")
	sh.none(t, "mid-turn")
	l.hook("alpe1", "Stop")
	if p := sh.next(t); !strings.Contains(p.Content, "mlpe1") {
		t.Fatalf("prompt %q", p.Content)
	}
}

// execOn runs a statement on the test database's writer.
func execOn(t *testing.T, l *live, q string) {
	t.Helper()
	if err := l.db.Write(l.ctx, func(conn *sqlite.Conn) error { return sqlitex.Execute(conn, q, nil) }); err != nil {
		t.Fatal(err)
	}
}

func newStreams() *push.Streams { return push.New() }

// TestStopPrompts: a shutdown's final-round ask and a working agent's wrap-up reach the agent over its own shim's
// stream, through the admission gate, and are recorded as prompt:sent; the action is pending either way.
func TestStopPrompts(t *testing.T) {
	l := newLive(t)
	l.spawn("alps1")
	l.idle("alps1")
	sh := l.shim(l.life, "alps1")
	if r, err := l.life.GracefulShutdown(l.ctx, l.agent("alps1")); err != nil || r != "waiting for n-alps1 to finish its step" {
		t.Fatalf("shutdown: %q %v", r, err)
	}
	want := l.render("shutdown-prepare", nil) + "\n\n" + l.render("shutdown-archive", nil)
	if p := sh.next(t); p.Content != want || p.Meta["kind"] != "mail" {
		t.Fatalf("final-round ask %q\nwant %q", p.Content, want)
	}
	if e := lastEvent(t, l, "alps1", "prompt:sent"); e != `{"kind":"prompt"}` {
		t.Errorf("prompt:sent: %s", e)
	}
	if p := pendingText(l.agent("alps1")); !strings.HasPrefix(p, `{"type":"shutdown","at":`) {
		t.Errorf("pending: %s", p)
	}

	l.spawn("alps2")
	l.set("alps2", db.Field{Col: "activity", Val: "working"})
	sh2 := l.shim(l.life, "alps2")
	if r, err := l.life.Restart(l.ctx, l.agent("alps2"), "new settings"); err != nil || r != "waiting for n-alps2 to finish its step" {
		t.Fatalf("restart: %q %v", r, err)
	}
	if p := sh2.next(t); p.Content != l.render("restart-prepare", map[string]string{"reason": "new settings"}) {
		t.Fatalf("wrap-up %q", p.Content)
	}
	if p := pendingText(l.agent("alps2")); p != `{"type":"restart","reason":"new settings"}` {
		t.Errorf("pending: %s", p)
	}
	sh.none(t, "the other agent")

	// A blocked agent isn't prompted, but the stop is pending all the same.
	l.spawn("alps3")
	l.set("alps3", db.Field{Col: "activity", Val: "working"})
	sh3 := l.shim(l.life, "alps3")
	execOn(t, l, "INSERT INTO blockers (agent_id, kind, account, reason, since) VALUES ('alps3', 'error', '', 'credits out', '2026-10-21T00:00:00.000Z')")
	if _, err := l.life.Restart(l.ctx, l.agent("alps3"), "r"); err != nil {
		t.Fatal(err)
	}
	sh3.none(t, "a blocked agent")
	if l.has("alps3", "prompt:sent") || pendingText(l.agent("alps3")) == "" {
		t.Errorf("blocked: prompt:sent %v, pending %q", l.has("alps3", "prompt:sent"), pendingText(l.agent("alps3")))
	}
}

// TestStartPush: a notice queued while the agent starts, whose push found it not yet idle, reaches it when its
// SessionStart turns it idle. A ring's round 1 queues while its fresh members start; with no push on SessionStart the
// one debounced try came and went, and a slow member never got its turn (S-4168).
func TestStartPush(t *testing.T) {
	l := newLive(t)
	l.spawn("alps1")
	l.set("alps1", db.Field{Col: "activity", Val: "starting"})
	sh := l.shim(l.life, "alps1")
	// The notice's debounced push runs, and ends, while the agent still starts.
	l.life.QueueRingNotice(l.ctx, "alps1", "Ring r1, round 1")
	l.settled(l.life, "alps1")
	sh.none(t, "a starting agent")
	l.hook("alps1", "SessionStart")
	if p := sh.next(t); !strings.Contains(p.Content, "Ring r1, round 1") {
		t.Fatalf("prompt %q", p.Content)
	}
}

// TestStartPushPaused: SessionStart doesn't push to an agent an owner paused while it started (its resume pushes); a
// rest still takes the push (S-4168 review). Mail to a paused agent still goes in, as TestBlockerHumanPause pins.
func TestStartPushPaused(t *testing.T) {
	for _, tc := range []struct {
		name, pausedBy string
		delivered      bool
	}{
		{"the human's pause", `["human"]`, false},
		{"an agent's pause", `["aboss"]`, false},
		{"the rest", `["standing-idle"]`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l := newLive(t)
			l.spawn("alpp1")
			l.set("alpp1", db.Field{Col: "activity", Val: "starting"})
			sh := l.shim(l.life, "alpp1")
			l.life.QueueRingNotice(l.ctx, "alpp1", "Ring r1, round 1")
			l.settled(l.life, "alpp1")
			l.set("alpp1", db.Field{Col: "lifecycle", Val: "paused"}, db.Field{Col: "paused_by", Val: tc.pausedBy})
			l.hook("alpp1", "SessionStart")
			if !tc.delivered {
				l.settled(l.life, "alpp1")
				sh.none(t, tc.name)
				if n := l.life.Notices("alpp1"); len(n) != 1 {
					t.Errorf("the notice left the queue: %v", n)
				}
				return
			}
			if p := sh.next(t); !strings.Contains(p.Content, "Ring r1, round 1") {
				t.Fatalf("prompt %q", p.Content)
			}
		})
	}
}

package lifecycle

import (
	"errors"
	"strings"
	"testing"
	"time"

	"stam/internal/cron"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// waiter makes an idle agent row with no harness, as the waits need no more.
func (l *live) waiter(id string) db.Agent {
	l.t.Helper()
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: id, Name: "n-" + id, Role: "developer", Machine: "test-machine", Harness: "claude", Cwd: l.work}); err != nil {
		l.t.Fatal(err)
	}
	l.set(id, db.Field{Col: "lifecycle", Val: "active"}, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: nil})
	return l.agent(id)
}

func (l *live) waits(id string) []db.Wait {
	l.t.Helper()
	ws, err := l.db.ListWaits(l.ctx, id)
	if err != nil {
		l.t.Fatal(err)
	}
	return ws
}

func (l *live) countEvents(id, typ string) int {
	l.t.Helper()
	evs, err := l.db.ListEvents(l.ctx, id, 100, typ)
	if err != nil {
		l.t.Fatal(err)
	}
	return len(evs)
}

func (l *live) send(from, to, id, thread string) {
	l.t.Helper()
	if thread == "" {
		thread = id
	}
	if _, err := l.db.StoreMail(l.ctx, db.Stored{ID: id, ThreadID: thread, From: from, FromName: "n-" + from, Subject: "s", Body: "b", To: []string{to}}); err != nil {
		l.t.Fatal(err)
	}
}

// TestDeclareWait: a wait_for on an agent turns the waiter waiting, records wait:declared, and nudges the awaited agent
// once per ask: once with no ask, once for each unanswered mail, never for an ask already answered.
func TestDeclareWait(t *testing.T) {
	l := newLive(t)
	waiter, target := l.waiter("alw1"), l.waiter("alw2")
	declare := func(thread string) db.Wait {
		t.Helper()
		timeout := 30.0
		w, err := l.life.DeclareWait(l.ctx, l.agent("alw1"), Declare{On: "agent", Target: target, Thread: thread, Timeout: &timeout})
		if err != nil {
			t.Fatal(err)
		}
		return w
	}
	notice := l.render("wait-for", map[string]string{"name": waiter.Name, "thread": ""})
	w := declare("")
	if a := l.agent("alw1"); a.Activity != "waiting" || detailOf(a) != "waiting for reply from n-alw2" {
		t.Errorf("waiter: %s %q", a.Activity, detailOf(a))
	}
	if w.Until == nil || deref(w.Data) != `{"on":"agent","target":"alw2","timeout_minutes":30}` {
		t.Errorf("wait: until %v data %s", w.Until, deref(w.Data))
	}
	if got := lastEvent(t, l, "alw1", "wait:declared"); got != `{"id":"`+w.ID+`","kind":"agent","target":"alw2","thread":null,"timeout_minutes":30}` {
		t.Errorf("declared: %s", got)
	}
	if got := lastEvent(t, l, "alw2", "wait:nudged"); got != `{"waiter":"alw1","thread":null,"mail":"declare:"}` {
		t.Errorf("nudged: %s", got)
	}
	if got := l.life.Notices("alw2"); len(got) != 1 || got[0] != notice {
		t.Fatalf("notices %q, want one %q", got, notice)
	}
	// The same ask again: no second nudge.
	declare("")
	if n := len(l.life.Notices("alw2")); n != 1 {
		t.Errorf("%d notices after a second wait on the same ask", n)
	}
	// A mail to the target is a new ask: one nudge for it, and only one.
	l.send("alw1", "alw2", "mlw1", "")
	declare("")
	declare("")
	if n := l.countEvents("alw2", "wait:nudged"); n != 2 {
		t.Errorf("%d nudges after an ask, want 2", n)
	}
	// Answered: no nudge, and the answer clears the waiter's agent waits.
	l.send("alw2", "alw1", "mlw2", "")
	if ws := l.waits("alw1"); len(ws) != 0 {
		t.Errorf("waits left after the answer: %+v", ws)
	}
	declare("")
	if n := l.countEvents("alw2", "wait:nudged"); n != 2 {
		t.Errorf("%d nudges after the answer, want 2", n)
	}
	// An ask answered before any wait on it: no nudge.
	l.send("alw1", "alw2", "mlw3", "")
	l.send("alw2", "alw1", "mlw4", "")
	declare("")
	if n := l.countEvents("alw2", "wait:nudged"); n != 2 {
		t.Errorf("%d nudges for an answered ask, want 2", n)
	}
	// In a thread the target never answered in, with no ask there: no nudge.
	declare("mlw9")
	if n := l.countEvents("alw2", "wait:nudged"); n != 2 {
		t.Errorf("%d nudges for a quiet thread, want 2", n)
	}
	if n := len(l.life.Notices("alw2")); n != 2 {
		t.Errorf("%d notices, want 2", n)
	}
}

// TestDeclareHumanWait: a wait on the human ties itself to the agent's request pending with them, and a note naming a
// settled request is refused, writing nothing.
func TestDeclareHumanWait(t *testing.T) {
	l := newLive(t)
	a := l.waiter("alh1")
	execOn(t, l, `INSERT INTO permission_requests (id, agent_id, action, reason, details, audience, status, created_at) VALUES
		('pa00001', 'alh1', 'x', 'r', '{}', 'human', 'pending', '2026-10-21T00:00:01.000Z'),
		('pa00002', 'alh1', 'x', 'r', '{}', 'human', 'pending', '2026-10-21T00:00:02.000Z'),
		('pa00003', 'alh1', 'x', 'r', '{}', 'human', 'approved', '2026-10-21T00:00:03.000Z'),
		('pa00004', 'alh1', 'x', 'r', '{}', 'delegate', 'pending', '2026-10-21T00:00:04.000Z')`)
	for note, want := range map[string]string{"": "pa00002", "about pa00001": "pa00001"} {
		w, err := l.life.DeclareWait(l.ctx, a, Declare{On: "human", Note: note})
		if err != nil {
			t.Fatal(err)
		}
		if deref(w.Target) != want {
			t.Errorf("note %q: target %s, want %s", note, deref(w.Target), want)
		}
	}
	before := len(l.waits("alh1"))
	_, err := l.life.DeclareWait(l.ctx, a, Declare{On: "human", Note: "pa00003"})
	var bad ErrWait
	if !errors.As(err, &bad) || !strings.HasPrefix(bad.Msg, "request pa00003 is already approved") {
		t.Fatalf("settled: %v", err)
	}
	if n := len(l.waits("alh1")); n != before {
		t.Errorf("a refused wait wrote: %d waits, had %d", n, before)
	}
	if w, err := l.life.DeclareWait(l.ctx, a, Declare{On: "human", Note: "pa00003", Thread: "mlh1"}); err != nil || w.Target != nil {
		t.Errorf("in a thread with no request: %v %v", deref(w.Target), err)
	}
}

// TestTickWaits: a declared wait's timeout tells its agent and clears it; a one-off timer sends its note and clears;
// every_minutes and cron timers send theirs and move on from now; nothing fires before it is due.
func TestTickWaits(t *testing.T) {
	l := newLive(t)
	a := l.waiter("alt1")
	timeout := 5.0
	declared, err := l.life.DeclareWait(l.ctx, a, Declare{On: "human", Note: "the go-ahead", Timeout: &timeout})
	if err != nil {
		t.Fatal(err)
	}
	wake := func(w Wake) db.Wait {
		t.Helper()
		out, err := l.life.WakeAt(l.ctx, "alt1", w)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	once := wake(Wake{Note: "once", Mode: "in_minutes", Minutes: 2})
	every := wake(Wake{Note: "every", Mode: "every_minutes", Minutes: 3})
	minutely := wake(Wake{Note: "minutely", Mode: "cron", Cron: "* * * * *"})
	if got := lastEvent(t, l, "alt1", "wait:wake"); !strings.Contains(got, `"mode":"cron"`) || !strings.Contains(got, `"note":"minutely"`) {
		t.Errorf("wake event: %s", got)
	}
	if _, err := l.life.WakeAt(l.ctx, "alt1", Wake{Note: "x", Mode: "cron", Cron: "61 * * * *"}); !errors.As(err, new(ErrWait)) {
		t.Errorf("a bad cron: %v", err)
	}

	now := time.Now()
	if n, err := l.life.TickWaits(l.ctx, now); err != nil || n != 0 {
		t.Fatalf("early tick: %d %v", n, err)
	}
	at := now.Add(6 * time.Minute)
	n, err := l.life.TickWaits(l.ctx, at)
	if err != nil {
		t.Fatal(err)
	}
	// In the order they came due.
	want := []string{"minutely", "once", "every", l.render("wait-timeout", map[string]string{"what": "the go-ahead", "minutes": "5"})}
	if got := l.life.Notices("alt1"); n != len(want) || strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("fired %d, notices %q, want %q", n, got, want)
	}
	left := map[string]db.Wait{}
	for _, w := range l.waits("alt1") {
		left[w.ID] = w
	}
	if _, ok := left[declared.ID]; ok {
		t.Error("the timed-out wait is still there")
	}
	if _, ok := left[once.ID]; ok {
		t.Error("the one-off timer is still there")
	}
	if got := deref(left[every.ID].Until); got != minutesFrom(at, 3) {
		t.Errorf("every_minutes until %s, want %s", got, minutesFrom(at, 3))
	}
	next, _ := cron.Next("* * * * *", at)
	if got := deref(left[minutely.ID].Until); got != iso(next) {
		t.Errorf("cron until %s, want %s", got, iso(next))
	}
	if got := lastEvent(t, l, "alt1", "wait:timeout"); got != `{"id":"`+declared.ID+`","kind":"human","target":null}` {
		t.Errorf("timeout event: %s", got)
	}
	if got := lastEvent(t, l, "alt1", "wait:woke"); !strings.Contains(got, `"until":`) {
		t.Errorf("woke event: %s", got)
	}
	// Ticking at the same time again fires nothing more.
	if n, err := l.life.TickWaits(l.ctx, at); err != nil || n != 0 {
		t.Errorf("second tick: %d %v", n, err)
	}
}

func (l *live) hookPayload(id, raw string) {
	l.t.Helper()
	v, err := jsjson.Parse([]byte(raw))
	if err != nil {
		l.t.Fatal(err)
	}
	if _, err := l.life.OnHook(l.ctx, "claude", l.agent(id), v.(*jsjson.Object), new([]int64)); err != nil {
		l.t.Fatal(err)
	}
}

// TestHookWaits: a Stop with a job still running leaves the agent waiting on it; the task notification that the job
// ended clears it and the turn runs; a one-shot timer's prompt clears that timer; SessionStart on startup clears the rest.
func TestHookWaits(t *testing.T) {
	l := newLive(t)
	l.waiter("alk1")
	l.set("alk1", db.Field{Col: "activity", Val: "working"})
	l.hookPayload("alk1", `{"hook_event_name":"Stop","background_tasks":[{"id":"b1","type":"shell","status":"running","description":"npm test"}],
		"session_crons":[{"id":"c1","schedule":"30 14 25 12 *","recurring":false,"prompt":"wake up"},{"id":"c2","schedule":"*/5 * * * *","recurring":true,"prompt":"tick"}]}`)
	a := l.agent("alk1")
	if a.Activity != "waiting" || !strings.HasPrefix(detailOf(a), "waiting for ") {
		t.Fatalf("after the Stop: %s %q", a.Activity, detailOf(a))
	}
	kinds := func() string {
		var out []string
		for _, w := range l.waits("alk1") {
			out = append(out, w.Kind+":"+deref(w.Target))
		}
		return strings.Join(out, ",")
	}
	if got := kinds(); got != "job:b1,timer:c1,timer:c2" {
		t.Fatalf("waits %s", got)
	}
	l.hookPayload("alk1", `{"hook_event_name":"UserPromptSubmit","prompt":"<task-notification><task-id>b1</task-id><status>completed</status></task-notification>"}`)
	if got := kinds(); got != "timer:c1,timer:c2" {
		t.Errorf("after the job ended: %s", got)
	}
	if a := l.agent("alk1"); a.Activity != "working" {
		t.Errorf("after the prompt: %s %q", a.Activity, detailOf(a))
	}
	l.hookPayload("alk1", `{"hook_event_name":"UserPromptSubmit","prompt":"wake up"}`)
	if got := kinds(); got != "timer:c2" {
		t.Errorf("after the one-shot fired: %s", got)
	}
	l.hookPayload("alk1", `{"hook_event_name":"SessionStart","source":"clear"}`)
	if got := kinds(); got != "timer:c2" {
		t.Errorf("after /clear: %s", got)
	}
	l.hookPayload("alk1", `{"hook_event_name":"SessionStart","source":"startup"}`)
	if got := kinds(); got != "" {
		t.Errorf("after startup: %s", got)
	}
}

// TestTickBadCron: a stored timer whose cron no longer parses fires its note once and clears, with the error, instead
// of failing every tick.
func TestTickBadCron(t *testing.T) {
	l := newLive(t)
	l.waiter("alc1")
	past, data := "2026-10-21T00:00:00.000Z", `{"cron":"*/0 * * * *"}`
	note := "broken"
	w, err := l.db.AddWait(l.ctx, db.NewWait{AgentID: "alc1", Kind: "timer", Source: "stam", Detail: &note, Until: &past, Data: &data})
	if err != nil {
		t.Fatal(err)
	}
	n, err := l.life.TickWaits(l.ctx, time.Now())
	if n != 1 || err == nil || !strings.Contains(err.Error(), "timer "+w.ID+" cleared") {
		t.Errorf("tick: %d %v", n, err)
	}
	if got := l.life.Notices("alc1"); len(got) != 1 || got[0] != "broken" {
		t.Errorf("notices %q", got)
	}
	if ws := l.waits("alc1"); len(ws) != 0 {
		t.Errorf("left %+v", ws)
	}
	if n, err := l.life.TickWaits(l.ctx, time.Now()); n != 0 || err != nil {
		t.Errorf("second tick: %d %v", n, err)
	}
}

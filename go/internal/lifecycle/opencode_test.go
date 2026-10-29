package lifecycle

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"stam/internal/adapters/opencode"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// ocLive is a live test home whose lifecycle runs OpenCode agents on the scripted fake server (test/fake-opencode),
// which answers each prompt with "Got it: TEXT" and no model. starts counts the fake's `serve` starts.
type ocLive struct {
	*live
	server func() *opencode.Server
	starts string
}

func newOpenCodeLive(t *testing.T) *ocLive {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	l := newLive(t)
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	starts := filepath.Join(l.base, "serve-starts")
	bin := filepath.Join(l.base, "bin", "opencode")
	fake := filepath.Join(root, "test", "fake-opencode", "opencode")
	script := fmt.Sprintf("#!/bin/sh\n[ \"$1\" = serve ] && echo \"$$\" >>%q\nexec %q \"$@\"\n", starts, fake)
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	userHome := filepath.Join(l.base, "user")
	o := &ocLive{live: l, starts: starts}
	// Each daemon start builds its own Server, as stamd does: only the port, home and session name carry over.
	o.server = func() *opencode.Server {
		return &opencode.Server{
			Config: func() opencode.Env {
				return opencode.Env{Home: l.home, UserHome: userHome, Root: root, Bin: filepath.Join(root, "bin", "stam"), Settings: l.opts.Settings.Get(),
					Registry: jsjson.NewObject(), Getenv: os.Getenv}
			},
			Tmux: l.tmux, Bin: bin, Port: port, URL: l.opts.URL,
		}
	}
	l.opts.OpenCode = o.server()
	l.opts.OpenCodeSettle = 10 * time.Millisecond
	l.life = New(l.ctx, l.opts)
	return o
}

// startedLife is a lifecycle under its own context, following the server's stream: stop ends it, as a daemon stop
// does, and leaves the server and the agents' sessions running.
func (o *ocLive) startedLife(server *opencode.Server) (life *Lifecycle, stop func()) {
	o.t.Helper()
	ctx, cancel := context.WithCancel(o.ctx)
	opts := o.opts
	opts.OpenCode = server
	life = New(ctx, opts)
	connected := make(chan struct{}, 8)
	life.openCodeConnected = func() { connected <- struct{}{} }
	life.StartOpenCode()
	select {
	case <-connected:
	case <-o.ctx.Done():
		o.t.Fatal("the daemon stopped before the stream connected")
	case <-time.After(30 * time.Second):
		o.t.Fatalf("the event stream never connected; logs:\n%s", o.logs)
	}
	return life, func() { cancel(); life.Wait() }
}

func (o *ocLive) serveStarts() int {
	o.t.Helper()
	b, err := os.ReadFile(o.starts)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		o.t.Fatal(err)
	}
	return strings.Count(string(b), "\n")
}

// ocAgent makes an OpenCode agent's row as spawn does (a UUID session, which its launch replaces).
func (o *ocLive) ocAgent(id string) db.Agent {
	o.t.Helper()
	session := "11111111-2222-4333-8444-" + strings.Repeat("6", 12)
	model := "openrouter/deepseek/deepseek-v4.1-flash"
	if _, err := o.db.CreateAgent(o.ctx, db.NewAgent{ID: id, Name: "n-" + id, Role: "developer", Machine: "test-machine", Harness: "opencode",
		Model: &model, Cwd: o.work, SessionID: &session}); err != nil {
		o.t.Fatal(err)
	}
	if err := o.db.UpdateAgent(o.ctx, id, db.Field{Col: "permission_mode", Val: "auto"}); err != nil {
		o.t.Fatal(err)
	}
	return o.agent(id)
}

// messages is the text of the session's messages on the server, oldest first.
func (o *ocLive) messages(s *opencode.Server, sid string) []string {
	o.t.Helper()
	v, err := s.Call(o.ctx, "GET", "/api/session/"+sid+"/message", nil)
	if err != nil {
		o.t.Fatal(err)
	}
	list, _ := v.([]jsjson.Value)
	var out []string
	for i := len(list) - 1; i >= 0; i-- {
		m, _ := list[i].(*jsjson.Object)
		if t, ok := m.Get("text"); ok {
			out = append(out, fmt.Sprint(t))
		}
		c, _ := m.Get("content")
		parts, _ := c.([]jsjson.Value)
		for _, p := range parts {
			po, _ := p.(*jsjson.Object)
			if t, ok := po.Get("text"); ok {
				out = append(out, fmt.Sprint(t))
			}
		}
	}
	return out
}

func has(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// A spawn: the agent's session made on the server, its TUI attached to it, the first prompt through the API, and the
// turn's events taking it to working and back to idle; then its mail goes in the same way.
func TestOpenCodeLaunchAndTurn(t *testing.T) {
	o := newOpenCodeLive(t)
	life, stop := o.startedLife(o.opts.OpenCode)
	defer stop()
	o.ocAgent("aloc1")
	if err := life.StartHarness(o.ctx, o.agent("aloc1"), "hello oc", false, "spawn"); err != nil {
		t.Fatal(err)
	}
	o.until("the first turn to end", func() bool {
		a := o.agent("aloc1")
		ok, _ := o.db.HasEvent(o.ctx, "aloc1", "first-prompt:delivered")
		return ok && a.Activity == "idle" && detailOf(a) == "turn finished"
	})
	a := o.agent("aloc1")
	sid := deref(a.SessionID)
	if !strings.HasPrefix(sid, "ses_fake") {
		t.Fatalf("session %q; want the server's", sid)
	}
	if got := o.messages(o.opts.OpenCode, sid); !has(got, "hello oc") || !has(got, "Got it: hello oc") {
		t.Errorf("messages %q", got)
	}
	for _, typ := range []string{"opencode:session.execution.started", "opencode:session.execution.succeeded"} {
		if ok, _ := o.db.HasEvent(o.ctx, "aloc1", typ); !ok {
			t.Errorf("no %s event", typ)
		}
	}
	// The TUI runs in the agent's own session, attached to the server and the session.
	r := o.tmux.Run(o.ctx, nil, "list-panes", "-t", "aloc1", "-F", "#{pane_start_command}")
	out := r.Stdout
	if r.Status != 0 || !strings.Contains(out, "--server "+o.opts.OpenCode.Base()) || !strings.Contains(out, "--session "+sid) {
		t.Errorf("TUI command %q, %+v", out, r)
	}
	if strings.Contains(out, "hello oc") {
		t.Errorf("the prompt is on the TUI's command line: %q", out)
	}

	life.QueueNotice(o.ctx, "aloc1", "a stam notice", false)
	life.SchedulePush("aloc1")
	o.until("the notice's turn", func() bool { return has(o.messages(o.opts.OpenCode, sid), "Got it: a stam notice") })
	o.until("the agent to be idle again", func() bool { return o.agent("aloc1").Activity == "idle" })
	if n := o.serveStarts(); n != 1 {
		t.Errorf("%d server starts; want 1", n)
	}
}

// A daemon restart finds the agent again: the same server (its process, port and one start), the same session and
// state, and the stream read again, so the next turn's events still land.
func TestOpenCodeRestartKeepsServerAndSession(t *testing.T) {
	o := newOpenCodeLive(t)
	first, stop := o.startedLife(o.opts.OpenCode)
	o.ocAgent("aloc1")
	if err := first.StartHarness(o.ctx, o.agent("aloc1"), "before", false, "spawn"); err != nil {
		t.Fatal(err)
	}
	o.until("the first turn to end", func() bool {
		ok, _ := o.db.HasEvent(o.ctx, "aloc1", "first-prompt:delivered")
		return ok && o.agent("aloc1").Activity == "idle"
	})
	before := o.agent("aloc1")
	pid, live, err := o.tmux.PanePID(o.ctx, opencode.SessionName)
	if err != nil || !live {
		t.Fatalf("server pane: %d %v %v", pid, live, err)
	}
	tui, _, _ := o.tmux.PanePID(o.ctx, "aloc1")
	stop()

	// The new daemon's own Server, on the same port and home.
	server := o.server()
	second, stop2 := o.startedLife(server)
	defer stop2()
	after := o.agent("aloc1")
	if deref(after.SessionID) != deref(before.SessionID) || after.Activity != before.Activity || detailOf(after) != detailOf(before) || after.Lifecycle != "active" {
		t.Errorf("after the restart: session %q %s/%s %s; before %q %s/%s", deref(after.SessionID), after.Activity, detailOf(after), after.Lifecycle,
			deref(before.SessionID), before.Activity, detailOf(before))
	}
	if p, live, err := o.tmux.PanePID(o.ctx, opencode.SessionName); err != nil || !live || p != pid {
		t.Errorf("server pane %d %v %v; want the same process %d", p, live, err, pid)
	}
	if p, _, _ := o.tmux.PanePID(o.ctx, "aloc1"); p != tui {
		t.Errorf("TUI pane %d; want the same process %d", p, tui)
	}
	if n := o.serveStarts(); n != 1 {
		t.Errorf("%d server starts; want 1, no second server", n)
	}
	// The stream is read again: a prompt's turn takes the agent through working and back.
	if err := o.db.UpdateAgent(o.ctx, "aloc1", db.Field{Col: "activity_detail", Val: "ready"}); err != nil {
		t.Fatal(err)
	}
	second.QueueNotice(o.ctx, "aloc1", "after", false)
	second.SchedulePush("aloc1")
	o.until("the turn after the restart", func() bool {
		a := o.agent("aloc1")
		return a.Activity == "idle" && detailOf(a) == "turn finished" && has(o.messages(server, deref(a.SessionID)), "Got it: after")
	})
}

// The events an agent's session sends set its state as TS's onEvent does; a failed turn's provider error is a cost
// signal; an event for no agent's session, or one stam doesn't map, changes nothing.
func TestOpenCodeEvents(t *testing.T) {
	// The stream's events come only from a server: the scripted one, so the row runs its session, as an execution's
	// end needs (owner.endExec).
	l, _ := newJobLive(t, "aloe1")
	// A key as a provider error could carry it, in the message and as the error's type, or as a permission's action.
	const leak = "sk-or-v1-0123456789abcdef"
	ev := func(text string) opencode.Event {
		t.Helper()
		v, err := jsjson.Parse([]byte(text))
		if err != nil {
			t.Fatal(err)
		}
		o := v.(*jsjson.Object)
		typ, _ := o.Get("type")
		d, _ := o.Get("data")
		do, _ := d.(*jsjson.Object)
		return opencode.Event{Type: typ.(string), Data: do, Raw: v}
	}
	for _, c := range []struct{ event, activity, detail string }{
		{`{"type":"session.execution.started","data":{"sessionID":"ses_aloe1"}}`, "working", ""},
		{`{"type":"session.tool.called","data":{"sessionID":"ses_aloe1"}}`, "working", "running a tool"},
		{`{"type":"permission.asked","data":{"sessionID":"ses_aloe1","action":"shell"}}`, "blocked", "permission shell"},
		{`{"type":"permission.asked","data":{"sessionID":"ses_aloe1","action":"question"}}`, "blocked", "question"},
		{`{"type":"permission.asked","data":{"sessionID":"ses_aloe1"}}`, "blocked", "permission"},
		{`{"type":"permission.asked","data":{"sessionID":"ses_aloe1","action":"external_directory"}}`, "blocked", "permission external_directory"},
		// An action stam doesn't know is no detail: the server's text stays out.
		{`{"type":"permission.asked","data":{"sessionID":"ses_aloe1","action":"` + leak + `"}}`, "blocked", "permission"},
		{`{"type":"form.created","data":{"sessionId":"ses_aloe1"}}`, "blocked", "question"},
		{`{"type":"session.compaction.started","data":{"sessionID":"ses_aloe1"}}`, "working", "compacting"},
		{`{"type":"session.execution.interrupted","data":{"sessionID":"ses_aloe1"}}`, "idle", "interrupted"},
		// Each execution its own start, then its end.
		{`{"type":"session.execution.started","data":{"sessionID":"ses_aloe1"}}`, "working", ""},
		{`{"type":"session.execution.succeeded","data":{"sessionID":"ses_aloe1"}}`, "idle", "turn finished"},
		{`{"type":"session.text.delta","data":{"sessionID":"ses_aloe1"}}`, "idle", "turn finished"},
		{`{"type":"session.execution.started","data":{"sessionID":"ses_other"}}`, "idle", "turn finished"},
		// Only a known error type or the API status is kept, never the server's message or a type stam doesn't know.
		{`{"type":"session.execution.failed","data":{"sessionID":"ses_aloe1","error":{"type":"provider.unknown"}}}`, "errored", "failed"},
		{`{"type":"session.execution.failed","data":{"sessionID":"ses_aloe1"}}`, "errored", "failed"},
		{`{"type":"session.execution.failed","data":{"sessionID":"ses_aloe1","error":{"type":"` + leak + `","message":"key ` + leak + ` rejected","status":503}}}`, "errored", "failed (503)"},
		{`{"type":"session.execution.failed","data":{"sessionID":"ses_aloe1","error":{"type":"provider.quota","message":"out of credits for ` + leak + `","status":402}}}`, "errored", "provider.quota"},
	} {
		l.life.onOpenCodeEvent(l.ctx, ev(c.event))
		a := l.agent("aloe1")
		if string(a.Activity) != c.activity || detailOf(a) != c.detail {
			t.Errorf("%s: %s/%q; want %s/%q", c.event, a.Activity, detailOf(a), c.activity, c.detail)
		}
	}
	events, err := l.db.ListEvents(l.ctx, "aloe1", 100, "cost:signal")
	if err != nil {
		t.Fatal(err)
	}
	var signals []string
	for _, e := range events {
		signals = append(signals, deref(e.Data))
	}
	for _, want := range []string{`{"source":"session.execution.failed","class":"transient","status":503}`,
		`{"source":"session.execution.failed","class":"credits","error":"provider.quota","status":402}`} {
		if !has(signals, want) {
			t.Errorf("cost signals %q; want %s", signals, want)
		}
	}
	if len(signals) != 2 {
		t.Errorf("cost signals %q; want 2", signals)
	}
	states, _ := l.db.ListEvents(l.ctx, "aloe1", 100, "opencode:*")
	if len(states) != 16 {
		t.Errorf("%d state events", len(states))
	}
	all, _ := l.db.ListEvents(l.ctx, "aloe1", 1000, "")
	for _, e := range all {
		if strings.Contains(deref(e.Data), "sk-or") || strings.Contains(e.Type, "sk-or") {
			t.Errorf("event %s holds the server's text: %s", e.Type, deref(e.Data))
		}
	}
	if a := l.agent("aloe1"); strings.Contains(detailOf(a), "sk-or") {
		t.Errorf("detail %q", detailOf(a))
	}
}

// Without the shared server the lifecycle refuses an OpenCode agent as before, and a Claude Code agent's launch is
// unchanged by the seam.
func TestOpenCodeNeedsTheServer(t *testing.T) {
	l := newLive(t)
	session := "ses_none"
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "alon1", Name: "n-alon1", Machine: "test-machine", Harness: "opencode", Cwd: l.work, SessionID: &session}); err != nil {
		t.Fatal(err)
	}
	if l.life.HasOpenCode() {
		t.Fatal("HasOpenCode without a server")
	}
	if err := l.life.StartHarness(l.ctx, l.agent("alon1"), "hi", false, "spawn"); err == nil || err.Error() != "n-alon1 runs opencode, which the Go daemon can't control yet" {
		t.Errorf("start: %v", err)
	}
	if l.tmux.HasSession(l.ctx, "alon1") {
		t.Error("a session started")
	}
	a := l.spawn("alc1")
	if a.Activity == "errored" || deref(a.SessionID) != "11111111-2222-4333-8444-555555555555" {
		t.Errorf("claude agent: %s %q", a.Activity, deref(a.SessionID))
	}
}

// A daemon restart whose agent lost its TUI resumes it on the session it had: the same session id, the TUI attached to
// it, and the turn before the restart still in the session the next turn runs in.
func TestOpenCodeRestartResumesTheSession(t *testing.T) {
	o := newOpenCodeLive(t)
	first, stop := o.startedLife(o.opts.OpenCode)
	o.ocAgent("aloc1")
	if err := first.StartHarness(o.ctx, o.agent("aloc1"), "before", false, "spawn"); err != nil {
		t.Fatal(err)
	}
	o.until("the first turn to end", func() bool {
		ok, _ := o.db.HasEvent(o.ctx, "aloc1", "first-prompt:delivered")
		return ok && o.agent("aloc1").Activity == "idle"
	})
	sid := deref(o.agent("aloc1").SessionID)
	stop()
	if err := o.tmux.KillSession(o.ctx, "aloc1"); err != nil {
		t.Fatal(err)
	}

	server := o.server()
	second, stop2 := o.startedLife(server)
	defer stop2()
	if err := second.StartHarness(o.ctx, o.agent("aloc1"), "after", true, "resume"); err != nil {
		t.Fatal(err)
	}
	o.until("the resumed turn", func() bool {
		a := o.agent("aloc1")
		return a.Activity == "idle" && detailOf(a) == "turn finished" && has(o.messages(server, sid), "Got it: after")
	})
	if got := deref(o.agent("aloc1").SessionID); got != sid {
		t.Errorf("session %q after the resume; want %q", got, sid)
	}
	if got := o.messages(server, sid); !has(got, "Got it: before") {
		t.Errorf("the session lost the turn before the restart: %q", got)
	}
	r := o.tmux.Run(o.ctx, nil, "list-panes", "-t", "aloc1", "-F", "#{pane_start_command}")
	if r.Status != 0 || !strings.Contains(r.Stdout, "--session "+sid) {
		t.Errorf("TUI command %q", r.Stdout)
	}
	if n := o.serveStarts(); n != 1 {
		t.Errorf("%d server starts; want 1", n)
	}
}

// A superseded launch never writes its session: the generation check and the write are one step, so a launch (or a
// stop) that takes the next generation while an older launch is between its check and its write waits until that
// write is done, and the later launch's own session lands last.
func TestOpenCodeSessionWriteIsCurrent(t *testing.T) {
	l := newLive(t)
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "alos1", Name: "n-alos1", Machine: "test-machine", Harness: "opencode", Cwd: l.work}); err != nil {
		t.Fatal(err)
	}
	sessionOf := func(s string) db.Field { return db.Field{Col: "session_id", Val: s} }
	gen1 := l.life.nextGen("alos1")
	taken, later := make(chan struct{}), make(chan bool, 1)
	takenFirst := false
	l.life.genChecked = func(id string) {
		l.life.genChecked = nil
		// The later launch, started between the older one's check and its write.
		go func() {
			gen2 := l.life.nextGen(id)
			close(taken)
			wrote, err := l.life.updateIfCurrent(l.ctx, id, gen2, nil, sessionOf("ses_later"))
			later <- wrote && err == nil
		}()
		// Without the one step, the later generation is taken here, before the older launch's write.
		select {
		case <-taken:
			takenFirst = true
		case <-time.After(300 * time.Millisecond):
		}
	}
	wrote, err := l.life.updateIfCurrent(l.ctx, "alos1", gen1, nil, sessionOf("ses_older"))
	if err != nil {
		t.Fatal(err)
	}
	if wrote && takenFirst {
		t.Error("the older launch wrote its session after a later generation was taken")
	}
	select {
	case ok := <-later:
		if !ok {
			t.Fatal("the later launch didn't write its session")
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the later launch never wrote")
	}
	if got := deref(l.agent("alos1").SessionID); got != "ses_later" {
		t.Errorf("session %q; want the later launch's", got)
	}
	// Once superseded, the older launch writes nothing.
	if wrote, err := l.life.updateIfCurrent(l.ctx, "alos1", gen1, nil, sessionOf("ses_older")); wrote || err != nil {
		t.Errorf("the superseded launch wrote: %v %v", wrote, err)
	}
}

// A launch without a prompt marks its agent ready only while it is still starting on that launch: a turn that began
// between the TUI's check and the write keeps its state, and a superseded launch writes nothing.
func TestOpenCodeReadyKeepsATurn(t *testing.T) {
	// On the scripted server, with the TUI up: the row runs its session, so a turn's start is the agent's
	// (owner.startExec).
	l, _ := newJobLive(t, "alor1")
	session := "ses_alor1"
	l.life.openCodeSettle = time.Millisecond
	starting := func() {
		t.Helper()
		if err := l.db.UpdateAgent(l.ctx, "alor1", db.Field{Col: "activity", Val: "starting"}, db.Field{Col: "activity_detail", Val: nil}); err != nil {
			t.Fatal(err)
		}
	}
	started := opencode.Event{Type: "session.execution.started", Data: jsjson.NewObject("sessionID", session)}
	gate := func() bool { return true }

	// With nothing in between, the agent is ready.
	starting()
	if err := l.life.openCodeAfterLaunch(l.ctx, l.agent("alor1"), "", l.life.nextGen("alor1"), gate); err != nil {
		t.Fatal(err)
	}
	if a := l.agent("alor1"); a.Activity != "idle" || detailOf(a) != "ready" {
		t.Errorf("no turn: %s/%q; want idle/ready", a.Activity, detailOf(a))
	}
	// A turn starts between the check and the write.
	starting()
	// The turn's state lands between the check and the write: the row is written working there, as its event's set
	// does, so the ready write's predicate must read it in its own transaction.
	l.life.genChecked = func(string) {
		l.life.genChecked = nil
		if err := l.db.UpdateAgent(l.ctx, "alor1", db.Field{Col: "activity", Val: "working"}); err != nil {
			t.Error(err)
		}
	}
	if err := l.life.openCodeAfterLaunch(l.ctx, l.agent("alor1"), "", l.life.nextGen("alor1"), gate); err != nil {
		t.Fatal(err)
	}
	if a := l.agent("alor1"); a.Activity != "working" {
		t.Errorf("a turn that began meanwhile: %s/%q; want working", a.Activity, detailOf(a))
	}
	// A turn starts between the row's check and the write. Its event waits for the write's transaction, so it lands
	// last; a check read apart from its write would let the event land first and the ready write wipe it.
	starting()
	landed := make(chan struct{})
	l.life.rowChecked = func(string) {
		l.life.rowChecked = nil
		go func() {
			defer close(landed)
			l.life.onOpenCodeEvent(l.ctx, started)
		}()
		select {
		case <-landed:
		case <-time.After(200 * time.Millisecond):
		}
	}
	if err := l.life.openCodeAfterLaunch(l.ctx, l.agent("alor1"), "", l.life.nextGen("alor1"), gate); err != nil {
		t.Fatal(err)
	}
	<-landed
	if a := l.agent("alor1"); a.Activity != "working" {
		t.Errorf("a turn that began during the write: %s/%q; want working", a.Activity, detailOf(a))
	}
	// A launch superseded before its write.
	starting()
	gen := l.life.nextGen("alor1")
	l.life.invalidate("alor1")
	if err := l.life.openCodeAfterLaunch(l.ctx, l.agent("alor1"), "", gen, gate); err != nil {
		t.Fatal(err)
	}
	if a := l.agent("alor1"); a.Activity != "starting" {
		t.Errorf("superseded: %s/%q; want starting", a.Activity, detailOf(a))
	}
}

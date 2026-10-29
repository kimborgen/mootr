package lifecycle

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"stam/internal/testenv"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/adapters/opencode"
	"stam/internal/db"
)

// stopLive is a live test home whose lifecycle has an OpenCode server that only answers a stop's calls: which sessions
// are active, whether an interrupt stops them (stubborn: it doesn't), whether the active list can be read (broken: a
// 500 whose body holds a key), and every call it got. While gate is set, the stop's waits between polls hold on it.
type stopLive struct {
	*live
	mu         sync.Mutex
	active     map[string]bool
	stubborn   bool
	broken     bool
	interrupts map[string]int
	paths      []string
	gate       chan struct{}
	// odd, when set, is the active list's whole answer; "EMPTY" is an empty body.
	odd string
	// held is the next call of a kind ("active", "interrupt") to hold until its channel closes (holdNext); in counts the
	// calls of each kind held now.
	held map[string]chan struct{}
	in   map[string]int
	// perms is each session's pending permissions (an unknown session's listing is a 404), replies the replies the
	// server got ("SESSION PERMISSION DECISION"); listFail makes the listing a 500. An interrupt rejects the session's
	// pending permissions, as OpenCode does, unless stubborn: the turn runs on, its permission still pending.
	perms    map[string][]string
	replies  []string
	listFail bool
	// shells is the answer to GET /api/shell (the running shells, raw JSON), kids each parent session's child sessions
	// (GET /api/session?parentID=, raw JSON), failJobs makes those two a 500 (jobs_test.go).
	shells   string
	kids     map[string]string
	failJobs bool
	// sessions is each session's usage (GET /api/session/SID, raw JSON of the answer's data; an unknown one is a 404),
	// messages its last assistant messages (the list, raw JSON), failTurn makes both a 500, compacts the sessions asked to
	// compact and connects the directories asked to reconnect their MCP client; failControl makes those two a 500
	// (turnend_test.go).
	sessions    map[string]string
	messages    map[string]string
	failTurn    bool
	compacts    []string
	connects    []string
	failControl bool
	// prompts is the prompts the server was given, "SESSION TEXT".
	prompts []string
}

// callKind is a held call's kind, "" for one that is never held.
func callKind(r *http.Request) string {
	switch {
	case r.URL.Path == "/api/session/active":
		return "active"
	case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/interrupt"):
		return "interrupt"
	case r.Method == "PATCH":
		return "patch"
	case r.URL.Path == "/api/shell":
		return "shell"
	case r.Method == "GET" && r.URL.Path == "/api/session" && r.URL.Query().Has("parentID"):
		return "children"
	case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/permission"):
		return "permission"
	case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/reply"):
		return "reply"
	case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/api/session/ses_") && !strings.Contains(strings.TrimPrefix(r.URL.Path, "/api/session/"), "/"):
		return "usage"
	case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/message"):
		return "message"
	case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/compact"):
		return "compact"
	case r.Method == "POST" && r.URL.Path == "/api/experimental/mcp/stam/connect":
		return "connect"
	}
	return ""
}

func newStopLive(t *testing.T) *stopLive {
	t.Helper()
	l := newLive(t)
	s := &stopLive{live: l, active: map[string]bool{}, interrupts: map[string]int{}, held: map[string]chan struct{}{}, in: map[string]int{},
		perms: map[string][]string{}, sessions: map[string]string{}, messages: map[string]string{}}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.paths = append(s.paths, r.Method+" "+r.URL.Path)
		if kind := callKind(r); s.held[kind] != nil {
			g := s.held[kind]
			delete(s.held, kind)
			s.in[kind]++
			s.mu.Unlock()
			<-g
			s.mu.Lock()
			defer func() { s.in[kind]-- }()
		}
		switch {
		// A launch's calls: the server's health, and a resume's rules applied again.
		case r.URL.Path == "/openapi.json":
			fmt.Fprint(w, `{}`)
		case r.Method == "PATCH" && strings.HasPrefix(r.URL.Path, "/api/session/ses_"):
			fmt.Fprint(w, `{"data":{}}`)
		case r.URL.Path == "/api/session/active" && s.broken:
			w.WriteHeader(500)
			fmt.Fprint(w, `{"name":"UnknownError","data":{"message":"sk-or-v1-leak"}}`)
		case r.URL.Path == "/api/session/active" && s.odd == "EMPTY":
		case r.URL.Path == "/api/session/active" && s.odd != "":
			fmt.Fprint(w, s.odd)
		case r.URL.Path == "/api/session/active":
			var keys []string
			for sid := range s.active {
				keys = append(keys, strconv.Quote(sid)+`:{"type":"busy"}`)
			}
			fmt.Fprint(w, `{"data":{`+strings.Join(keys, ",")+`}}`)
		case r.URL.Path == "/api/shell" && s.failJobs, r.URL.Path == "/api/session" && s.failJobs:
			w.WriteHeader(500)
		case r.URL.Path == "/api/shell":
			fmt.Fprint(w, `{"data":[`+s.shells+`]}`)
		case r.URL.Path == "/api/session" && r.URL.Query().Has("parentID"):
			fmt.Fprint(w, `{"data":[`+s.kids[r.URL.Query().Get("parentID")]+`]}`)
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/interrupt"):
			sid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/session/"), "/interrupt")
			s.interrupts[sid]++
			if !s.stubborn {
				delete(s.active, sid)
			}
			if s.perms[sid] != nil && !s.stubborn {
				s.perms[sid] = []string{}
			}
			fmt.Fprint(w, `{"data":{}}`)
		case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/permission"):
			sid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/session/"), "/permission")
			list, ok := s.perms[sid]
			switch {
			case s.listFail:
				w.WriteHeader(500)
				fmt.Fprint(w, `{"name":"UnknownError","data":{"message":"sk-or-v1-leak"}}`)
			case !ok:
				w.WriteHeader(404)
			default:
				items := []string{}
				for _, id := range list {
					items = append(items, testenv.PermissionItem(sid, id))
				}
				fmt.Fprint(w, `{"data":[`+strings.Join(items, ",")+`]}`)
			}
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/reply"):
			parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/session/"), "/")
			var body struct{ Decision string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			s.replies = append(s.replies, parts[0]+" "+parts[2]+" "+body.Decision)
			var kept []string
			for _, id := range s.perms[parts[0]] {
				if id != parts[2] {
					kept = append(kept, id)
				}
			}
			s.perms[parts[0]] = kept
			fmt.Fprint(w, `{"data":{}}`)
		case callKind(r) == "usage" && s.failTurn, callKind(r) == "message" && s.failTurn, callKind(r) == "compact" && s.failControl,
			callKind(r) == "connect" && s.failControl:
			w.WriteHeader(500)
			fmt.Fprint(w, `{"name":"UnknownError","data":{"message":"sk-or-v1-leak"}}`)
		case callKind(r) == "usage":
			sid := strings.TrimPrefix(r.URL.Path, "/api/session/")
			if text, ok := s.sessions[sid]; ok {
				fmt.Fprint(w, `{"data":`+text+`}`)
			} else {
				w.WriteHeader(404)
			}
		case callKind(r) == "message":
			sid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/session/"), "/message")
			s.paths[len(s.paths)-1] += "?" + r.URL.RawQuery
			fmt.Fprint(w, `{"data":`+s.messages[sid]+`}`)
		case callKind(r) == "compact":
			s.compacts = append(s.compacts, strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/session/"), "/compact"))
			fmt.Fprint(w, `{"data":{}}`)
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/prompt"):
			var body struct{ Text string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			s.prompts = append(s.prompts, strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/session/"), "/prompt")+" "+body.Text)
			fmt.Fprint(w, `{"data":{}}`)
		case callKind(r) == "connect":
			s.connects = append(s.connects, r.URL.Query().Get("location[directory]"))
			fmt.Fprint(w, `{"data":{}}`)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(ts.Close)
	_, port, _ := net.SplitHostPort(ts.Listener.Addr().String())
	n, _ := strconv.Atoi(port)
	// A launch's TUI: a process that runs until its pane is killed, and talks to no one.
	bin := filepath.Join(l.base, "bin", "opencode")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexec sleep 1000\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	srv := &opencode.Server{Config: func() opencode.Env { return opencode.Env{Home: l.home} }, Tmux: l.tmux, Port: n, Bin: bin,
		Sleep: func(ctx context.Context, d time.Duration) error {
			s.mu.Lock()
			g := s.gate
			s.mu.Unlock()
			if g != nil {
				select {
				case <-g:
				case <-ctx.Done():
				}
			}
			return ctx.Err()
		}}
	l.opts.OpenCode = srv
	l.opts.OpenCodeSettle = 10 * time.Millisecond
	l.life = New(l.ctx, l.opts)
	// The shared server's own session, which no stop may touch.
	if err := l.tmux.NewSession(l.ctx, opencode.SessionName, l.work, nil, []string{"sleep", "1000"}); err != nil {
		t.Fatal(err)
	}
	return s
}

func (s *stopLive) set(fn func(s *stopLive)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(s)
}

func (s *stopLive) interruptsOf(sid string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.interrupts[sid]
}

// hold makes the stop's waits hold until the returned release.
func (s *stopLive) hold() (release func()) {
	g := make(chan struct{})
	s.set(func(s *stopLive) { s.gate = g })
	var once sync.Once
	return func() {
		once.Do(func() {
			s.set(func(s *stopLive) { s.gate = nil })
			close(g)
		})
	}
}

// holdNext holds the server's next call of kind until the returned release.
func (s *stopLive) holdNext(kind string) (release func()) {
	g := make(chan struct{})
	s.set(func(s *stopLive) { s.held[kind] = g })
	var once sync.Once
	return func() {
		once.Do(func() {
			s.set(func(s *stopLive) { delete(s.held, kind) })
			close(g)
		})
	}
}

// inFlight is how many calls of kind the server holds now.
func (s *stopLive) inFlight(kind string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.in[kind]
}

// releaseNow is a launch's release under the agent's current generation, as a launch that just took it makes.
func releaseNow(life *Lifecycle, ctx context.Context, a db.Agent) error {
	_, err := life.releaseTurnStop(ctx, a, life.genOf(a.ID))
	return err
}

// ocRow is an OpenCode agent with the session ses_ID, active in the server, and a workspace; with tui, its TUI runs.
func (s *stopLive) ocRow(id string, lifecycle string, tui bool) db.Agent {
	s.t.Helper()
	sid := "ses_" + id
	if _, err := s.db.CreateAgent(s.ctx, db.NewAgent{ID: id, Name: "n-" + id, Role: "developer", Machine: "test-machine", Harness: "opencode",
		Cwd: s.work, SessionID: &sid}); err != nil {
		s.t.Fatal(err)
	}
	workspace := `{"spec":{"kind":"dir","path":"` + s.work + `"},"cwd":"` + s.work + `"}`
	s.live.set(id, db.Field{Col: "lifecycle", Val: lifecycle}, db.Field{Col: "activity", Val: "working"}, db.Field{Col: "workspace", Val: workspace})
	if tui {
		if err := s.tmux.NewSession(s.ctx, id, s.work, nil, []string{"sleep", "1000"}); err != nil {
			s.t.Fatal(err)
		}
	}
	s.set(func(s *stopLive) { s.active[sid] = true })
	return s.agent(id)
}

// sharedServerKept fails the test unless the shared server's session still runs and only a stop's calls, and a final
// round's prompt, reached it.
func (s *stopLive) sharedServerKept() {
	s.t.Helper()
	if !s.tmux.HasSession(s.ctx, opencode.SessionName) {
		s.t.Error("the shared server's session is gone")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.paths {
		if p != "GET /api/session/active" && !(strings.HasPrefix(p, "POST /api/session/ses_") && (strings.HasSuffix(p, "/interrupt") || strings.HasSuffix(p, "/prompt"))) {
			s.t.Errorf("the server got %s", p)
		}
	}
}

// A shutdown kills the TUI and stops the turn the shared server still runs, interrupting the agent's session alone;
// the server itself stays.
func TestTurnStopOnShutdown(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("ats1", "active", true)
	if err := s.life.Shutdown(s.ctx, a); err != nil {
		t.Fatal(err)
	}
	if s.tmux.HasSession(s.ctx, "ats1") {
		t.Error("the TUI still runs")
	}
	// The shutdown's own stop interrupts the session, before anyone awaits it.
	s.until("the shutdown's interrupt", func() bool { return s.interruptsOf("ses_ats1") == 1 })
	if err := s.life.awaitTurnStop(s.ctx, s.agent("ats1"), s.life.genOf("ats1")); err != nil {
		t.Fatal(err)
	}
	if n := s.interruptsOf("ses_ats1"); n != 1 {
		t.Errorf("%d interrupts", n)
	}
	if a := s.agent("ats1"); a.Lifecycle != "shut_down" {
		t.Errorf("lifecycle %s", a.Lifecycle)
	}
	s.sharedServerKept()
}

// A second stop while one is in flight joins it: one loop interrupts the session. A session that still runs after the
// last attempt is a stop-error naming the agent and session, and nothing the server answered.
func TestTurnStopJoinsAndFails(t *testing.T) {
	s := newStopLive(t)
	s.set(func(s *stopLive) { s.stubborn = true })
	a := s.ocRow("ats2", "active", true)
	release := s.hold()
	defer release()
	if err := s.life.Shutdown(s.ctx, a); err != nil {
		t.Fatal(err)
	}
	s.until("the first interrupt", func() bool { return s.interruptsOf("ses_ats2") == 1 })
	e := s.life.turnStopOf("ses_ats2")
	if e == nil {
		t.Fatal("no stop in flight")
	}
	s.life.stopTurn(s.agent("ats2"), s.life.genOf("ats2"))
	if s.life.turnStopOf("ses_ats2") != e {
		t.Error("the second stop didn't join the first")
	}
	release()
	err := s.life.awaitTurnStop(s.ctx, s.agent("ats2"), s.life.genOf("ats2"))
	if err == nil || err.Error() != "OpenCode still runs n-ats2's session ses_ats2" {
		t.Errorf("await: %v", err)
	}
	if n := s.interruptsOf("ses_ats2"); n != opencode.StopAttempts {
		t.Errorf("%d interrupts; want %d", n, opencode.StopAttempts)
	}
	s.until("the stop-error", func() bool { return s.countEvents("ats2", "stop-error") == 1 })
	if got := s.eventsOf("ats2", "stop-error"); len(got) != 1 || got[0] != `{"error":"OpenCode still runs n-ats2's session ses_ats2"}` {
		t.Errorf("stop-error %q", got)
	}
	// The row says so: the agent doesn't read as cleanly stopped.
	if a := s.agent("ats2"); a.Lifecycle != "shut_down" || detailOf(a) != "stop failed: OpenCode still runs n-ats2's session ses_ats2" {
		t.Errorf("row %s/%q", a.Lifecycle, detailOf(a))
	}
	// A later stop that confirms clears the note.
	s.set(func(s *stopLive) { s.stubborn = false })
	if err := s.life.awaitTurnStop(s.ctx, s.agent("ats2"), s.life.genOf("ats2")); err != nil {
		t.Fatal(err)
	}
	s.until("the note cleared", func() bool { return detailOf(s.agent("ats2")) == "shut down" })
	s.sharedServerKept()
}

// A launch first makes the stop in flight give up, and waits until it has: no interrupt follows, and the stop is not
// taken for confirmed.
func TestTurnStopReleasedByALaunch(t *testing.T) {
	s := newStopLive(t)
	s.set(func(s *stopLive) { s.stubborn = true })
	a := s.ocRow("ats3", "active", true)
	release := s.hold()
	defer release()
	if err := s.life.Shutdown(s.ctx, a); err != nil {
		t.Fatal(err)
	}
	s.until("the first interrupt", func() bool { return s.interruptsOf("ses_ats3") == 1 })
	e := s.life.turnStopOf("ses_ats3")
	released := make(chan error, 1)
	go func() { released <- releaseNow(s.life, s.ctx, s.agent("ats3")) }()
	s.until("the stop to be given up", func() bool { return e.cancelled.Load() })
	release()
	if err := <-released; err != nil {
		t.Fatal(err)
	}
	select {
	case <-e.done:
	default:
		t.Fatal("the release returned before the stop ended")
	}
	if e.err != nil {
		t.Errorf("a stop given up failed: %v", e.err)
	}
	if err := e.await(s.ctx); err != errStopGivenUp {
		t.Errorf("awaiting a stop given up: %v", err)
	}
	if n := s.interruptsOf("ses_ats3"); n != 1 {
		t.Errorf("%d interrupts after the release; want 1", n)
	}
	if s.life.turnStopOf("ses_ats3") != nil {
		t.Error("the stop is still listed")
	}
	if n := s.countEvents("ats3", "stop-error"); n != 0 {
		t.Errorf("%d stop-errors", n)
	}
}

// A daemon restart in the middle of a stop leaves no stop behind it: the new daemon's launch isn't held, and its
// archive stops the session again and archives the agent.
func TestTurnStopAcrossARestart(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("ats4", "active", true)
	ctx, cancel := context.WithCancel(s.ctx)
	old := New(ctx, s.opts)
	release := s.hold()
	defer release()
	if err := old.Shutdown(s.ctx, a); err != nil {
		t.Fatal(err)
	}
	s.until("the first interrupt", func() bool { return s.interruptsOf("ses_ats4") == 1 })
	// The interrupt didn't take yet: the session still runs when the daemon stops.
	s.set(func(s *stopLive) { s.active["ses_ats4"] = true })
	cancel()
	old.Wait()
	release()
	// The stop the daemon's end cut short is unconfirmed, and the row says so.
	if a := s.agent("ats4"); !strings.HasPrefix(detailOf(a), "stop failed: ") {
		t.Errorf("after the daemon stopped mid-stop: %s/%q", a.Lifecycle, detailOf(a))
	}
	life := New(s.ctx, s.opts)
	if e := life.turnStopOf("ses_ats4"); e != nil {
		t.Fatal("a stop outlived the restart")
	}
	if err := releaseNow(life, s.ctx, s.agent("ats4")); err != nil {
		t.Fatal(err)
	}
	if out, err := life.Archive(s.ctx, s.agent("ats4"), ArchiveOpts{}); err != nil || out != "done" {
		t.Fatalf("archive: %q %v", out, err)
	}
	if n := s.interruptsOf("ses_ats4"); n != 2 {
		t.Errorf("%d interrupts; want 2", n)
	}
	if a := s.agent("ats4"); a.Lifecycle != "archived" {
		t.Errorf("lifecycle %s", a.Lifecycle)
	}
	s.sharedServerKept()
}

// An archive goes on only once the session is confirmed stopped: one that still runs, or can't be asked about,
// refuses the archive and leaves the agent as it was.
func TestArchiveWaitsForTheTurnStop(t *testing.T) {
	s := newStopLive(t)
	s.set(func(s *stopLive) { s.stubborn = true })
	a := s.ocRow("ats5", "shut_down", false)
	_, err := s.life.Archive(s.ctx, a, ArchiveOpts{})
	if err == nil || err.Error() != "can't archive n-ats5: its session still runs (OpenCode still runs n-ats5's session ses_ats5); archive again once it stops" {
		t.Errorf("stubborn: %v", err)
	}
	if a := s.agent("ats5"); a.Lifecycle != "shut_down" {
		t.Errorf("stubborn: lifecycle %s", a.Lifecycle)
	}
	s.set(func(s *stopLive) { s.stubborn = false; s.broken = true })
	_, err = s.life.Archive(s.ctx, s.agent("ats5"), ArchiveOpts{})
	if err == nil || strings.Contains(err.Error(), "sk-or") || !strings.Contains(err.Error(), "its session still runs") {
		t.Errorf("unreadable: %v", err)
	}
	if a := s.agent("ats5"); a.Lifecycle != "shut_down" {
		t.Errorf("unreadable: lifecycle %s", a.Lifecycle)
	}
	s.set(func(s *stopLive) { s.broken = false })
	if out, err := s.life.Archive(s.ctx, s.agent("ats5"), ArchiveOpts{}); err != nil || out != "done" {
		t.Fatalf("archive: %q %v", out, err)
	}
	if a := s.agent("ats5"); a.Lifecycle != "archived" {
		t.Errorf("lifecycle %s", a.Lifecycle)
	}
	for _, e := range s.events("ats5", "") {
		if strings.Contains(e, "sk-or") {
			t.Errorf("an event holds the server's text: %s", e)
		}
	}
	s.sharedServerKept()
}

// With no TUI, an agent whose turn the server still runs, or can't tell, isn't taken for gone: its archive asks for the
// final round, and a pending unforced archive is deferred. One the server answers is idle archives at once.
func TestOpenCodeTurnWithNoPane(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("ats6", "active", false)
	s.live.set("ats6", db.Field{Col: "activity", Val: "idle"})
	if out, err := s.life.Archive(s.ctx, s.agent("ats6"), ArchiveOpts{}); err != nil || out == "done" {
		t.Fatalf("a turn still running: %q %v", out, err)
	}
	if pendingStop(s.agent("ats6")) == nil {
		t.Fatal("no pending archive")
	}
	for _, c := range []struct {
		broken bool
		reason string
	}{{false, "harness still runs a turn with no pane"}, {true, "harness turn state unknown"}} {
		s.set(func(s *stopLive) { s.broken = c.broken })
		if err := s.life.runPendingOnDead(s.ctx, s.agent("ats6")); err != nil {
			t.Fatal(err)
		}
		if got := s.eventsOf("ats6", "archive:deferred"); len(got) == 0 || got[len(got)-1] != `{"reason":"`+c.reason+`"}` {
			t.Errorf("deferred %q; want %s", got, c.reason)
		}
		if a := s.agent("ats6"); a.Lifecycle != "active" || pendingStop(a) == nil {
			t.Errorf("%s: lifecycle %s, pending %v", c.reason, a.Lifecycle, pendingStop(a))
		}
	}
	s.set(func(s *stopLive) { s.broken = false; delete(s.active, "ses_ats6") })
	if err := s.life.runPendingOnDead(s.ctx, s.agent("ats6")); err != nil {
		t.Fatal(err)
	}
	if a := s.agent("ats6"); a.Lifecycle != "archived" {
		t.Errorf("an idle session: lifecycle %s", a.Lifecycle)
	}
	_ = a
	// The same agent shape, idle in the server, archives at once.
	b := s.ocRow("ats7", "active", false)
	s.live.set("ats7", db.Field{Col: "activity", Val: "idle"})
	s.set(func(s *stopLive) { delete(s.active, "ses_ats7") })
	if out, err := s.life.Archive(s.ctx, b, ArchiveOpts{}); err != nil || out != "done" {
		t.Errorf("an idle session: %q %v", out, err)
	}
	s.sharedServerKept()
}

// A starting agent past its deadline with no pane is marked never started only once the server answers that no turn
// runs: a live turn, or a server that can't be asked, leaves it.
func TestOpenCodeStartingDeadAsksTheServer(t *testing.T) {
	s := newStopLive(t)
	s.ocRow("ats8", "active", false)
	s.live.set("ats8", db.Field{Col: "activity", Val: "starting"})
	s.exec("UPDATE agents SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = 'ats8'")
	for _, broken := range []bool{false, true} {
		s.set(func(s *stopLive) { s.broken = broken })
		s.life.markStartingDead(s.ctx, s.agent("ats8"))
		if a := s.agent("ats8"); a.Lifecycle != "active" {
			t.Errorf("broken %v: lifecycle %s", broken, a.Lifecycle)
		}
	}
	s.set(func(s *stopLive) { s.broken = false; delete(s.active, "ses_ats8") })
	s.life.markStartingDead(s.ctx, s.agent("ats8"))
	if a := s.agent("ats8"); a.Lifecycle != "shut_down" || detailOf(a) != "never started: no harness process" {
		t.Errorf("no turn: %s/%q", a.Lifecycle, detailOf(a))
	}
}

// The interrupt goes to the agent's session in the server and is confirmed only once the server no longer lists it.
func TestOpenCodeInterrupt(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("ats9", "active", true)
	if ok, err := s.life.interrupt(s.ctx, a); err != nil || !ok || s.interruptsOf("ses_ats9") != 1 {
		t.Errorf("interrupt: %v %v, %d interrupts", ok, err, s.interruptsOf("ses_ats9"))
	}
	s.set(func(s *stopLive) { s.stubborn = true; s.active["ses_ats9"] = true })
	if ok, _ := s.life.interrupt(s.ctx, a); ok {
		t.Error("stubborn: confirmed")
	}
	s.set(func(s *stopLive) { s.stubborn = false; s.broken = true })
	if ok, _ := s.life.interrupt(s.ctx, a); ok {
		t.Error("unreadable: confirmed")
	}
	if !s.tmux.HasSession(s.ctx, "ats9") {
		t.Error("the interrupt killed the TUI")
	}
	s.sharedServerKept()
}

// A launch goes on only once the stop in flight gave up: by the time it gets past the release, the stop has ended
// and sent no interrupt after the first.
func TestLaunchReleasesTheTurnStop(t *testing.T) {
	s := newStopLive(t)
	s.set(func(s *stopLive) { s.stubborn = true })
	a := s.ocRow("ats10", "active", true)
	release := s.hold()
	defer release()
	if err := s.life.Shutdown(s.ctx, a); err != nil {
		t.Fatal(err)
	}
	s.until("the first interrupt", func() bool { return s.interruptsOf("ses_ats10") == 1 })
	e := s.life.turnStopOf("ses_ats10")
	ended := make(chan bool, 1)
	s.life.SetFailLaunch([]string{"n-ats10"})
	s.life.SetOnFailLaunch(func() {
		select {
		case <-e.done:
			ended <- true
		default:
			ended <- false
		}
	})
	launched := make(chan error, 1)
	go func() { launched <- s.life.StartHarness(s.ctx, s.agent("ats10"), "", true, "resume") }()
	s.until("the stop to be given up", func() bool { return e.cancelled.Load() })
	release()
	if err := <-launched; err == nil || !strings.Contains(err.Error(), "test: launch of n-ats10 failed") {
		t.Fatalf("launch: %v", err)
	}
	if !<-ended {
		t.Error("the launch went on while the stop still ran")
	}
	if n := s.interruptsOf("ses_ats10"); n != 1 {
		t.Errorf("%d interrupts; want 1", n)
	}
}

// A cost switch's stop goes on only once the predecessor's session is confirmed stopped in the server.
func TestSwitchStopWaitsForTheTurnStop(t *testing.T) {
	s := newStopLive(t)
	s.set(func(s *stopLive) { s.stubborn = true })
	a := s.ocRow("ats11", "active", true)
	if _, err := s.life.stopForSwitch(s.ctx, a); err == nil || err.Error() != "OpenCode still runs n-ats11's session ses_ats11" {
		t.Errorf("stubborn: %v", err)
	}
	if n := s.countEvents("ats11", "cost:switch"); n != 0 {
		t.Errorf("%d cost:switch steps after an unconfirmed stop", n)
	}
	s.set(func(s *stopLive) { s.stubborn = false; s.active["ses_ats11"] = true })
	if _, err := s.life.stopForSwitch(s.ctx, s.agent("ats11")); err != nil {
		t.Fatal(err)
	}
	if got := s.eventsOf("ats11", "cost:switch"); len(got) != 1 || !strings.Contains(got[0], `"step":"stopped"`) {
		t.Errorf("cost:switch %q", got)
	}
	s.sharedServerKept()
}

// A stop await starts when none is in flight is listed like any other: a launch meanwhile makes it give up, so it never
// interrupts the new turn, and the await isn't taken for confirmed.
func TestAwaitedStopReleasedByALaunch(t *testing.T) {
	s := newStopLive(t)
	s.set(func(s *stopLive) { s.stubborn = true })
	a := s.ocRow("ats12", "shut_down", false)
	release := s.hold()
	defer release()
	awaited := make(chan error, 1)
	gen := s.life.nextGen("ats12")
	go func() { awaited <- s.life.awaitTurnStop(s.ctx, a, gen) }()
	s.until("the await's interrupt", func() bool { return s.interruptsOf("ses_ats12") == 1 })
	released := make(chan error, 1)
	go func() { released <- releaseNow(s.life, s.ctx, s.agent("ats12")) }()
	s.until("the await's stop to be given up", func() bool { e := s.life.turnStopOf("ses_ats12"); return e != nil && e.cancelled.Load() })
	release()
	if err := <-released; err != nil {
		t.Fatal(err)
	}
	if err := <-awaited; err != errStopGivenUp {
		t.Errorf("await: %v; want the stop given up", err)
	}
	if n := s.interruptsOf("ses_ats12"); n != 1 {
		t.Errorf("%d interrupts; want 1", n)
	}
}

// An archive refused because the session still runs leaves a paused agent paused, its TUI running: the turn is
// confirmed stopped before the harness goes.
func TestRefusedArchiveKeepsAPausedAgent(t *testing.T) {
	s := newStopLive(t)
	s.set(func(s *stopLive) { s.stubborn = true })
	s.ocRow("ats13", "paused", true)
	s.live.set("ats13", db.Field{Col: "paused_by", Val: `["human"]`}, db.Field{Col: "activity_detail", Val: "mid-edit"},
		db.Field{Col: "pending_action", Val: `{"type":"compact","reason":"test"}`})
	row := func(a db.Agent) string {
		return fmt.Sprintf("%s|%s|%s|%s|%s", a.Lifecycle, a.Activity, detailOf(a), deref(a.PausedBy), deref(a.PendingAction))
	}
	before := row(s.agent("ats13"))
	if _, err := s.life.Archive(s.ctx, s.agent("ats13"), ArchiveOpts{}); err == nil || !strings.Contains(err.Error(), "its session still runs") {
		t.Fatalf("archive: %v", err)
	}
	// The refused archive's stop runs on in the background; once it ends, the row is still as it was.
	s.until("the stop to end", func() bool { return s.life.turnStopOf("ses_ats13") == nil })
	if after := row(s.agent("ats13")); after != before {
		t.Errorf("after the refusal: %s; want %s", after, before)
	}
	if !s.tmux.HasSession(s.ctx, "ats13") {
		t.Error("the refused archive killed the TUI")
	}
	if n := s.countEvents("ats13", "shutdown"); n != 0 {
		t.Errorf("%d shutdown events", n)
	}
	// Once the session stops, the archive goes through.
	s.set(func(s *stopLive) { s.stubborn = false })
	if out, err := s.life.Archive(s.ctx, s.agent("ats13"), ArchiveOpts{}); err != nil || out != "done" {
		t.Fatalf("archive: %q %v", out, err)
	}
	if a := s.agent("ats13"); a.Lifecycle != "archived" {
		t.Errorf("lifecycle %s", a.Lifecycle)
	}
	s.sharedServerKept()
}

// An active list of another shape is no answer: the turn counts as running, never as gone.
func TestOddActiveListCountsAsRunning(t *testing.T) {
	s := newStopLive(t)
	s.ocRow("ats14", "active", false)
	s.live.set("ats14", db.Field{Col: "activity", Val: "idle"})
	for _, odd := range []string{"EMPTY", `{}`, `{"data":null}`, `{"data":[]}`, `{"data":{"ses_ats14":true}}`, `[]`, `{"data":{"msg_x":{"type":"busy"}}}`} {
		s.set(func(s *stopLive) { s.odd = odd })
		if alive, known := s.life.turnAlive(s.ctx, s.agent("ats14")); known {
			t.Errorf("%s: alive %v, known", odd, alive)
		}
		if err := s.life.awaitTurnStop(s.ctx, s.agent("ats14"), s.life.genOf("ats14")); err == nil {
			t.Errorf("%s: the stop was confirmed", odd)
		}
	}
	if out, err := s.life.Archive(s.ctx, s.agent("ats14"), ArchiveOpts{}); err != nil || out == "done" {
		t.Errorf("archive: %q %v; want the final round", out, err)
	}
}

// The archive confirms the stop again once the harness is gone: a turn a queued prompt began meanwhile refuses it.
func TestArchiveRechecksAfterTheHarness(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("ats15", "shut_down", false)
	s.life.archiveStopped = func(string) {
		s.set(func(s *stopLive) { s.stubborn = true; s.active["ses_ats15"] = true })
	}
	if _, err := s.life.Archive(s.ctx, a, ArchiveOpts{}); err == nil || !strings.Contains(err.Error(), "its session still runs") {
		t.Errorf("archive: %v", err)
	}
	if a := s.agent("ats15"); a.Lifecycle == "archived" {
		t.Error("archived while a turn ran")
	}
}

// A shutdown a resume overtakes, between its kill and its write, writes nothing and stops nothing: the resume took a
// later launch generation, so the resumed agent keeps its row, its TUI and its turn. A waiter racing it, under the
// shutdown's generation, hears the stop given up. The launch is a real one: the server's calls, the TUI's pane and the
// launch's own writes.
func TestShutdownStopNeverOutlivesALaterLaunch(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("ats16", "active", true)
	held, free := make(chan int, 1), make(chan struct{})
	s.life.quitKilled = func(id string) {
		s.life.quitKilled = nil
		held <- s.life.genOf(id)
		<-free
	}
	shut := make(chan error, 1)
	go func() { shut <- s.life.Shutdown(s.ctx, a) }()
	gen := <-held
	if s.tmux.HasSession(s.ctx, "ats16") {
		t.Fatal("the shutdown didn't kill the TUI")
	}
	if err := s.life.StartHarness(s.ctx, s.agent("ats16"), "", true, "resume"); err != nil {
		t.Fatal(err)
	}
	s.until("the resume to land", func() bool { a := s.agent("ats16"); return a.Activity == "idle" && detailOf(a) == "ready" })
	awaited := make(chan error, 1)
	go func() { awaited <- s.life.awaitTurnStop(s.ctx, a, gen) }()
	close(free)
	if err := <-shut; err != nil {
		t.Fatal(err)
	}
	if err := <-awaited; err != errStopGivenUp {
		t.Errorf("the racing await: %v; want the stop given up", err)
	}
	s.until("every stop to end", func() bool { return s.life.turnStopOf("ses_ats16") == nil })
	if n := s.interruptsOf("ses_ats16"); n != 0 {
		t.Errorf("%d interrupts reached the resumed turn", n)
	}
	if a := s.agent("ats16"); a.Lifecycle != "active" || a.Activity != "idle" || detailOf(a) != "ready" {
		t.Errorf("row %s/%s/%q", a.Lifecycle, a.Activity, detailOf(a))
	}
	if !s.tmux.HasSession(s.ctx, "ats16") {
		t.Error("the resumed TUI is gone")
	}
	for _, typ := range []string{"shutdown", "stop-error"} {
		if n := s.countEvents("ats16", typ); n != 0 {
			t.Errorf("%d %s events", n, typ)
		}
	}
	if n := s.countEvents("ats16", "resume"); n != 1 {
		t.Errorf("%d resume events", n)
	}
}

// A resume that passes its release after a shutdown's write but before its stop is listed never takes an interrupt:
// the stop is listed under the shutdown's own generation, which the resume moved past, not the one current then.
func TestShutdownStopListedAfterALaunchGivesUp(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("ats20", "active", true)
	held, free := make(chan int, 1), make(chan struct{})
	s.life.quitWrote = func(id string) {
		s.life.quitWrote = nil
		held <- s.life.genOf(id)
		<-free
	}
	shut := make(chan error, 1)
	go func() { shut <- s.life.Shutdown(s.ctx, a) }()
	gen := <-held
	// The resume passes its release (no stop is listed yet) and starts its TUI; its own write waits for the shutdown's
	// serial.
	launched := make(chan error, 1)
	go func() { launched <- s.life.StartHarness(s.ctx, s.agent("ats20"), "", true, "resume") }()
	s.until("the resumed TUI", func() bool { return s.tmux.HasSession(s.ctx, "ats20") })
	close(free)
	if err := <-shut; err != nil {
		t.Fatal(err)
	}
	if err := <-launched; err != nil {
		t.Fatal(err)
	}
	if err := s.life.awaitTurnStop(s.ctx, a, gen); err != errStopGivenUp {
		t.Errorf("await: %v; want the stop given up", err)
	}
	s.until("the resume to land", func() bool { a := s.agent("ats20"); return a.Activity == "idle" && detailOf(a) == "ready" })
	s.until("every stop to end", func() bool { return s.life.turnStopOf("ses_ats20") == nil })
	if n := s.interruptsOf("ses_ats20"); n != 0 {
		t.Errorf("%d interrupts reached the resumed turn", n)
	}
	if a := s.agent("ats20"); a.Lifecycle != "active" || !s.tmux.HasSession(s.ctx, "ats20") {
		t.Errorf("row %s, pane %v", a.Lifecycle, s.tmux.HasSession(s.ctx, "ats20"))
	}
	if n := s.countEvents("ats20", "stop-error"); n != 0 {
		t.Errorf("%d stop-errors", n)
	}
}

// A launch passes its release only once every earlier stop has ended, the call in flight of one a later shutdown
// replaced included: the replaced stop's interrupt is answered before the launch goes on, and no other follows.
func TestLaunchWaitsForEveryEarlierStop(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("ats17", "active", true)
	post := s.holdNext("interrupt")
	defer post()
	if err := s.life.Shutdown(s.ctx, a); err != nil {
		t.Fatal(err)
	}
	s.until("the first shutdown's interrupt to be held", func() bool { return s.inFlight("interrupt") == 1 })
	first := s.life.turnStopOf("ses_ats17")
	// A second shutdown takes another generation: its stop replaces the first, which gives up.
	if err := s.life.Shutdown(s.ctx, s.agent("ats17")); err != nil {
		t.Fatal(err)
	}
	second := s.life.turnStopOf("ses_ats17")
	if first == nil || second == nil || second == first || !first.cancelled.Load() {
		t.Fatalf("the second stop didn't replace the first: %p %p", first, second)
	}
	inPost := make(chan int, 1)
	s.life.SetFailLaunch([]string{"n-ats17"})
	s.life.SetOnFailLaunch(func() { inPost <- s.inFlight("interrupt") })
	launched := make(chan error, 1)
	go func() { launched <- s.life.StartHarness(s.ctx, s.agent("ats17"), "", true, "resume") }()
	s.until("the release to give the second stop up", func() bool { return second.cancelled.Load() })
	post()
	if err := <-launched; err == nil || !strings.Contains(err.Error(), "test: launch of n-ats17 failed") {
		t.Fatalf("launch: %v", err)
	}
	if n := <-inPost; n != 0 {
		t.Errorf("the launch passed its release with %d interrupts in flight", n)
	}
	if n := s.interruptsOf("ses_ats17"); n != 1 {
		t.Errorf("%d interrupts; want only the first shutdown's", n)
	}
	for _, e := range []*turnStop{first, second} {
		if err := e.await(s.ctx); err != errStopGivenUp {
			t.Errorf("a stop the launch released: %v", err)
		}
	}
}

// A stop whose generation a launch moved past confirms nothing, even when it finds the session idle: its waiter hears
// it given up, and an earlier stop's failure note stays on the row. So too when the launch comes while the stop's
// question to the server is in flight.
func TestStaleStopConfirmsNothing(t *testing.T) {
	s := newStopLive(t)
	noted := func(id string) db.Agent {
		s.ocRow(id, "shut_down", false)
		s.live.set(id, db.Field{Col: "activity_detail", Val: "stop failed: x"})
		s.set(func(s *stopLive) { delete(s.active, "ses_"+id) })
		return s.agent(id)
	}
	kept := func(id string) {
		t.Helper()
		// Every stop's outcome is published once its goroutine ends.
		s.life.bg.Wait()
		if d := detailOf(s.agent(id)); d != "stop failed: x" {
			t.Errorf("%s: the note became %q", id, d)
		}
		if n := s.interruptsOf("ses_" + id); n != 0 {
			t.Errorf("%s: %d interrupts", id, n)
		}
	}
	t.Run("stale", func(t *testing.T) {
		a := noted("ats18")
		gen := s.life.nextGen("ats18")
		s.life.nextLaunchGen("ats18")
		if err := s.life.awaitTurnStop(s.ctx, a, gen); err != errStopGivenUp {
			t.Errorf("await: %v; want the stop given up", err)
		}
		kept("ats18")
	})
	t.Run("moved", func(t *testing.T) {
		a := noted("ats19")
		release := s.holdNext("active")
		defer release()
		gen := s.life.genOf("ats19")
		awaited := make(chan error, 1)
		go func() { awaited <- s.life.awaitTurnStop(s.ctx, a, gen) }()
		s.until("the stop's question to be held", func() bool { return s.inFlight("active") == 1 })
		s.life.nextLaunchGen("ats19")
		release()
		if err := <-awaited; err != errStopGivenUp {
			t.Errorf("await: %v; want the stop given up", err)
		}
		kept("ats19")
	})
}

// The one-shot interrupt holds the session's slot as a stop does: a shutdown and a resume while its call is in flight
// wait for it, the resume passes its release only once that call has ended, and nothing else reaches the session.
func TestInterruptHeldAcrossAResume(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("ats21", "active", true)
	post := s.holdNext("interrupt")
	defer post()
	interrupted := make(chan bool, 1)
	go func() { ok, _ := s.life.interrupt(s.ctx, a); interrupted <- ok }()
	s.until("the interrupt's call to be held", func() bool { return s.inFlight("interrupt") == 1 })
	if err := s.life.Shutdown(s.ctx, s.agent("ats21")); err != nil {
		t.Fatal(err)
	}
	stop := s.life.turnStopOf("ses_ats21")
	if stop == nil {
		t.Fatal("the shutdown listed no stop")
	}
	inPost := make(chan int, 1)
	s.life.SetFailLaunch([]string{"n-ats21"})
	s.life.SetOnFailLaunch(func() { inPost <- s.inFlight("interrupt") })
	launched := make(chan error, 1)
	go func() { launched <- s.life.StartHarness(s.ctx, s.agent("ats21"), "", true, "resume") }()
	s.until("the release to give the shutdown's stop up", func() bool { return stop.cancelled.Load() })
	post()
	if err := <-launched; err == nil || !strings.Contains(err.Error(), "test: launch of n-ats21 failed") {
		t.Fatalf("launch: %v", err)
	}
	if n := <-inPost; n != 0 {
		t.Errorf("the launch passed its release with %d interrupts in flight", n)
	}
	if <-interrupted {
		t.Error("an interrupt the launch released was confirmed")
	}
	if n := s.interruptsOf("ses_ats21"); n != 1 {
		t.Errorf("%d interrupts; want only the held one", n)
	}
	if err := stop.await(s.ctx); err != errStopGivenUp {
		t.Errorf("the shutdown's stop: %v", err)
	}
}

// A launch that comes after a stop's last call but before it publishes makes it give up: its waiter hears so, and an
// earlier stop's failure note stays. So too when the launch has only taken its generation, its release still to come.
func TestStopPublishesUnderItsSlot(t *testing.T) {
	s := newStopLive(t)
	for _, c := range []struct {
		id      string
		release bool
	}{{"ats22", true}, {"ats25", false}} {
		a := s.ocRow(c.id, "shut_down", false)
		s.live.set(c.id, db.Field{Col: "activity_detail", Val: "stop failed: x"})
		s.set(func(s *stopLive) { delete(s.active, "ses_"+c.id) })
		held, free := make(chan struct{}), make(chan struct{})
		s.life.stopPublishing = func(string) {
			s.life.stopPublishing = nil
			close(held)
			<-free
		}
		gen := s.life.genOf(c.id)
		awaited := make(chan error, 1)
		go func() { awaited <- s.life.awaitTurnStop(s.ctx, a, gen) }()
		<-held
		e := s.life.turnStopOf("ses_" + c.id)
		launched := make(chan error, 1)
		if c.release {
			s.life.SetFailLaunch([]string{"n-" + c.id})
			go func() { launched <- s.life.StartHarness(s.ctx, s.agent(c.id), "", true, "resume") }()
			s.until("the launch's release to give the stop up", func() bool { return e.cancelled.Load() })
		} else {
			s.life.nextLaunchGen(c.id)
		}
		close(free)
		if err := <-awaited; err != errStopGivenUp {
			t.Errorf("%s: await: %v; want the stop given up", c.id, err)
		}
		if c.release {
			if err := <-launched; err == nil || !strings.Contains(err.Error(), "test: launch of n-"+c.id+" failed") {
				t.Fatalf("launch: %v", err)
			}
		}
		s.life.bg.Wait()
		if d := detailOf(s.agent(c.id)); d != "stop failed: x" {
			t.Errorf("%s: the note became %q", c.id, d)
		}
	}
}

// A stop that failed but hadn't yet published when a later stop replaced it writes nothing: the later stop runs only
// once it has, so a failure note never lands on the later stop's outcome.
func TestReplacedFailedStopWritesNoNote(t *testing.T) {
	s := newStopLive(t)
	s.set(func(s *stopLive) { s.stubborn = true })
	a := s.ocRow("ats23", "shut_down", false)
	held, free := make(chan struct{}), make(chan struct{})
	s.life.stopPublishing = func(string) {
		s.life.stopPublishing = nil
		close(held)
		<-free
	}
	first := s.life.startStop(a, "ses_ats23", s.life.nextGen("ats23"))
	<-held
	// The first stop failed (stubborn); the session stops now, and a second stop of a later generation replaces it.
	s.set(func(s *stopLive) { s.stubborn = false })
	later := s.life.nextGen("ats23")
	second := make(chan error, 1)
	go func() { second <- s.life.awaitTurnStop(s.ctx, s.agent("ats23"), later) }()
	s.until("the first stop to be replaced", func() bool { return first.cancelled.Load() })
	close(free)
	if err := <-second; err != nil {
		t.Errorf("the second stop: %v", err)
	}
	if err := first.await(s.ctx); err != errStopGivenUp {
		t.Errorf("the first stop: %v", err)
	}
	s.life.bg.Wait()
	if d := detailOf(s.agent("ats23")); strings.HasPrefix(d, "stop failed") {
		t.Errorf("the note %q", d)
	}
	if n := s.countEvents("ats23", "stop-error"); n != 0 {
		t.Errorf("%d stop-errors", n)
	}
}

// A quit that stalls before its kill while a resume lands never kills the resumed pane: its kill is checked against the
// launch generations in one step, and it writes and stops nothing either.
func TestQuitKillNeverReachesALaterPane(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("ats24", "active", true)
	held, free := make(chan struct{}), make(chan struct{})
	s.life.quitKilling = func(string) {
		s.life.quitKilling = nil
		close(held)
		<-free
	}
	shut := make(chan error, 1)
	go func() { shut <- s.life.Shutdown(s.ctx, a) }()
	<-held
	if err := s.life.StartHarness(s.ctx, s.agent("ats24"), "", true, "resume"); err != nil {
		t.Fatal(err)
	}
	s.until("the resume to land", func() bool { a := s.agent("ats24"); return a.Activity == "idle" && detailOf(a) == "ready" })
	close(free)
	if err := <-shut; err != nil {
		t.Fatal(err)
	}
	s.life.bg.Wait()
	if !s.tmux.HasSession(s.ctx, "ats24") {
		t.Error("the quit killed the resumed pane")
	}
	if a := s.agent("ats24"); a.Lifecycle != "active" || a.Activity != "idle" || detailOf(a) != "ready" {
		t.Errorf("row %s/%s/%q", a.Lifecycle, a.Activity, detailOf(a))
	}
	if n := s.interruptsOf("ses_ats24"); n != 0 {
		t.Errorf("%d interrupts", n)
	}
	if n := s.countEvents("ats24", "shutdown"); n != 0 {
		t.Errorf("%d shutdown events", n)
	}
}

// A replacement can't fall between a publishing stop's check and its writes: it waits for them (the owner's lock), so
// the stop it would replace has published as itself, unreplaced, and the replacement's own outcome comes after. The
// wait for an early replacement is bounded: only a replacement taken outside the owner's lock gets in at all.
func TestReplacementWaitsForThePublication(t *testing.T) {
	s := newStopLive(t)
	s.set(func(s *stopLive) { s.stubborn = true })
	a := s.ocRow("ats26", "shut_down", false)
	gen := s.life.nextGen("ats26")
	later := s.life.nextGen("ats26")
	var first *turnStop
	ready := make(chan struct{})
	second := make(chan *turnStop, 1)
	replacedEarly := false
	s.life.stopChecked = func(string) {
		s.life.stopChecked = nil
		<-ready
		s.set(func(s *stopLive) { s.stubborn = false })
		go func() { second <- s.life.startStop(a, "ses_ats26", later) }()
		// The hook runs under the owner's lock (publish), so it reads the listed stop directly.
		o := s.life.ownerOf("ats26")
		for end := time.Now().Add(200 * time.Millisecond); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
			if o.stops["ses_ats26"] != first {
				replacedEarly = true
				break
			}
		}
	}
	first = s.life.startStop(a, "ses_ats26", gen)
	close(ready)
	err := first.await(s.ctx)
	if err == nil || err.Error() != "OpenCode still runs n-ats26's session ses_ats26" {
		t.Errorf("the first stop: %v", err)
	}
	if err := (<-second).await(s.ctx); err != nil {
		t.Errorf("the replacement: %v", err)
	}
	if replacedEarly || first.cancelled.Load() {
		t.Error("the replacement fell between the first stop's check and its writes")
	}
	s.life.bg.Wait()
	if got := s.eventsOf("ats26", "stop-error"); len(got) != 1 {
		t.Errorf("stop-errors %q; want the first stop's alone", got)
	}
	if d := detailOf(s.agent("ats26")); d != "shut down" {
		t.Errorf("the note %q; want the replacement's", d)
	}
}

// A launch a repeated shutdown overtook before its release cancels nothing: the shutdown's newer stop runs on to its
// confirmation, the session is stopped, and the stale launch is abandoned before it makes its pane.
func TestStaleLaunchLeavesANewerStop(t *testing.T) {
	s := newStopLive(t)
	s.set(func(s *stopLive) { s.stubborn = true })
	s.ocRow("ats27", "active", true)
	held, free := make(chan struct{}), make(chan struct{})
	s.life.launchReleasing = func(string) {
		s.life.launchReleasing = nil
		close(held)
		<-free
	}
	launched := make(chan error, 1)
	go func() { launched <- s.life.StartHarness(s.ctx, s.agent("ats27"), "", true, "resume") }()
	<-held
	// The stop's polls hold, so it is in flight when the stale launch releases.
	gate := s.hold()
	defer gate()
	if err := s.life.Shutdown(s.ctx, s.agent("ats27")); err != nil {
		t.Fatal(err)
	}
	s.until("the shutdown's interrupt", func() bool { return s.interruptsOf("ses_ats27") == 1 })
	e := s.life.turnStopOf("ses_ats27")
	close(free)
	// A release that cancelled the stop would then wait for its slot, which the held poll keeps: either ends the wait.
	var err error
	ended := false
	s.until("the stale launch to end", func() bool {
		if !ended {
			select {
			case err = <-launched:
				ended = true
			default:
			}
		}
		return ended || e.cancelled.Load()
	})
	if e.cancelled.Load() {
		t.Fatal("the stale launch's release cancelled the newer stop")
	}
	if err != nil {
		t.Fatalf("the stale launch: %v", err)
	}
	// The session takes the next interrupt.
	s.set(func(s *stopLive) { s.stubborn = false })
	gate()
	if err := e.await(s.ctx); err != nil {
		t.Errorf("the shutdown's stop: %v", err)
	}
	s.mu.Lock()
	running := s.active["ses_ats27"]
	s.mu.Unlock()
	if running {
		t.Error("the session still runs")
	}
	if a := s.agent("ats27"); a.Lifecycle != "shut_down" || s.tmux.HasSession(s.ctx, "ats27") {
		t.Errorf("row %s, pane %v", a.Lifecycle, s.tmux.HasSession(s.ctx, "ats27"))
	}
	if n := s.countEvents("ats27", "resume"); n != 0 {
		t.Errorf("%d resume events", n)
	}
}

// A launch makes no pane while a kill of it is in flight (beginPane): it waits for the kill, then goes on under a
// generation still current, or gives up under one a newer quit took.
func TestLaunchWaitsForTheKill(t *testing.T) {
	s := newStopLive(t)
	held := func(id string) (inKill chan struct{}, free chan struct{}) {
		inKill, free = make(chan struct{}), make(chan struct{})
		s.life.paneKilling = func(string) {
			s.life.paneKilling = nil
			close(inKill)
			<-free
		}
		return inKill, free
	}
	waiting := func(id string) bool {
		o := s.life.ownerOf(id)
		o.mu.Lock()
		defer o.mu.Unlock()
		return o.paneWaits == 1
	}
	t.Run("goes on", func(t *testing.T) {
		// A shutdown's kill is held in flight; a resume, newer, waits for it, then makes its pane, which the kill
		// (the old pane's) never reaches.
		a := s.ocRow("ats28", "active", true)
		inKill, free := held("ats28")
		shut := make(chan error, 1)
		go func() { shut <- s.life.Shutdown(s.ctx, a) }()
		<-inKill
		launched := make(chan error, 1)
		go func() { launched <- s.life.StartHarness(s.ctx, s.agent("ats28"), "", true, "resume") }()
		s.until("the resume to wait for the kill, or make its pane", func() bool {
			return waiting("ats28") || s.countEvents("ats28", "resume") > 0
		})
		if !waiting("ats28") {
			t.Fatal("the resume made its pane while the kill was in flight")
		}
		close(free)
		if err := <-shut; err != nil {
			t.Fatal(err)
		}
		if err := <-launched; err != nil {
			t.Fatal(err)
		}
		s.until("the resume to land", func() bool { a := s.agent("ats28"); return a.Activity == "idle" && detailOf(a) == "ready" })
		if !s.tmux.HasSession(s.ctx, "ats28") {
			t.Error("the resumed pane is gone")
		}
		if a := s.agent("ats28"); a.Lifecycle != "active" {
			t.Errorf("lifecycle %s", a.Lifecycle)
		}
	})
	t.Run("gives up", func(t *testing.T) {
		// A resume passes its release and is held at its server call; a shutdown, newer, kills meanwhile, held in
		// flight. The resume gives up, at its generation check or after waiting for the kill (beginPane), and makes
		// no pane.
		a := s.ocRow("ats29", "shut_down", false)
		s.set(func(s *stopLive) { delete(s.active, "ses_ats29") })
		patch := s.holdNext("patch")
		defer patch()
		launched := make(chan error, 1)
		go func() { launched <- s.life.StartHarness(s.ctx, a, "", true, "resume") }()
		s.until("the resume's server call", func() bool { return s.inFlight("patch") == 1 })
		inKill, free := held("ats29")
		shut := make(chan error, 1)
		go func() { shut <- s.life.Shutdown(s.ctx, s.agent("ats29")) }()
		<-inKill
		patch()
		var err error
		done := false
		s.until("the resume to wait for the kill, or give up", func() bool {
			if !done {
				select {
				case err = <-launched:
					done = true
				default:
				}
			}
			return done || waiting("ats29")
		})
		close(free)
		if err := <-shut; err != nil {
			t.Fatal(err)
		}
		if !done {
			err = <-launched
		}
		if err != nil {
			t.Fatal(err)
		}
		if s.tmux.HasSession(s.ctx, "ats29") {
			t.Error("the superseded resume made its pane")
		}
		if a := s.agent("ats29"); a.Lifecycle != "shut_down" {
			t.Errorf("lifecycle %s", a.Lifecycle)
		}
	})
}

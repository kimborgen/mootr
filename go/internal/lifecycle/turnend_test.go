package lifecycle

import (
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/adapters/opencode"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// An OpenCode turn's end, compaction and MCP reconnect (S-4237, turnend.go). The scripted server of stopLive answers the
// session's usage and last message, a compaction and a connect, and holds any of them until the test lets it go.

// sessionOf is the server's answer for a session's usage: cost, then input, output, reasoning, cache read and write.
func sessionOf(cost, in, out, reasoning, cr, cw int) string {
	n := strconv.Itoa
	return `{"cost":` + n(cost) + `,"tokens":{"input":` + n(in) + `,"output":` + n(out) + `,"reasoning":` + n(reasoning) +
		`,"cache":{"read":` + n(cr) + `,"write":` + n(cw) + `}}}`
}

// messageOf is the server's list of the last assistant message, which has input and cache-read tokens.
func messageOf(in, cr int) string {
	return `[{"tokens":{"input":` + strconv.Itoa(in) + `,"cache":{"read":` + strconv.Itoa(cr) + `}}}]`
}

// reportsDone waits until the turn end's reads have ended.
func (s *stopLive) reportsDone() {
	s.t.Helper()
	s.until("the turn end's reads", func() bool { return s.life.bgRunning.Load() == 0 })
}

// usageOf is the agent's recorded usage: cost, input, output, cache read, cache write, summed over its rows.
func (s *stopLive) usageOf(id string) string {
	s.t.Helper()
	return s.query("SELECT sum(cost_usd), sum(tokens_in), sum(tokens_out), sum(tokens_cache_read), sum(tokens_cache_write) FROM usage WHERE agent_id = ?", id)
}

func (s *stopLive) usageEmpty() string { return "NULL|NULL|NULL|NULL|NULL" }

// A turn's end reports the session's cumulative usage (output with the reasoning tokens) and sets the context size from
// the last assistant message (input and cache read). A later end adds only the growth, a repeat adds nothing, and a
// reading below the baseline (a stale read) records nothing and keeps the higher one. An interrupt ends the same way.
func TestTurnEndUsageAndContext(t *testing.T) {
	s, _ := newJobLive(t, "ate1")
	sid := "ses_ate1"
	end := func(kind string) {
		t.Helper()
		// Each end is of its own execution, started first (owner.endExec).
		s.event(execution("started", sid))
		s.event(execution(kind, sid))
		s.reportsDone()
	}
	s.set(func(s *stopLive) {
		s.sessions[sid] = sessionOf(2, 100, 40, 10, 500, 60)
		s.messages[sid] = messageOf(120, 700)
	})
	end("succeeded")
	if got := s.usageOf("ate1"); got != "2.0|100|50|500|60" {
		t.Errorf("first end: %s", got)
	}
	if got := deref(s.agent("ate1").UsageLast); got != `{"v":2,"id":"`+sid+`","cost":2,"tin":100,"tout":50,"tcr":500,"tcw":60}` {
		t.Errorf("baseline: %s", got)
	}
	if a := s.agent("ate1"); a.ContextTokens == nil || *a.ContextTokens != 820 {
		t.Errorf("context tokens %v, want 820", a.ContextTokens)
	}
	if n := s.reads("GET /api/session/" + sid + "/message?limit=1&order=desc&type=assistant"); n != 1 {
		t.Errorf("%d message reads: %v", n, s.paths)
	}
	s.wantActivity("ate1", "idle")

	// A repeat of the same cumulative numbers adds nothing; growth adds its own.
	end("succeeded")
	if got := s.usageOf("ate1"); got != "2.0|100|50|500|60" {
		t.Errorf("repeat: %s", got)
	}
	s.set(func(s *stopLive) { s.sessions[sid] = sessionOf(3, 150, 60, 20, 900, 60) })
	end("interrupted")
	if got := s.usageOf("ate1"); got != "3.0|150|80|900|60" {
		t.Errorf("growth: %s", got)
	}
	// A stale read: every counter lower. Recorded nothing, and the baseline is kept.
	s.set(func(s *stopLive) { s.sessions[sid] = sessionOf(1, 10, 4, 1, 50, 6) })
	end("succeeded")
	if got := s.usageOf("ate1"); got != "3.0|150|80|900|60" {
		t.Errorf("stale read: %s", got)
	}
	if got := deref(s.agent("ate1").UsageLast); got != `{"v":2,"id":"`+sid+`","cost":3,"tin":150,"tout":80,"tcr":900,"tcw":60}` {
		t.Errorf("baseline after a stale read: %s", got)
	}
}

// A new session id starts every counter at zero, cost too (sessionCumulative): a session switch's own growth is recorded
// whole, though it is below the old session's total.
func TestTurnEndNewSessionRestartsCost(t *testing.T) {
	s, _ := newJobLive(t, "ate2")
	first := "ses_ate2"
	s.set(func(s *stopLive) { s.sessions[first] = sessionOf(1, 100, 10, 0, 0, 0) })
	s.event(execution("succeeded", first))
	s.reportsDone()
	second := "ses_ate2b"
	s.live.set("ate2", db.Field{Col: "session_id", Val: second}, db.Field{Col: "activity", Val: "working"})
	s.set(func(s *stopLive) { s.sessions[second] = sessionOf(3, 20, 5, 0, 0, 0) })
	s.event(execution("started", second))
	s.event(execution("succeeded", second))
	s.reportsDone()
	if got := s.usageOf("ate2"); got != "4.0|120|15|0|0" {
		t.Errorf("usage over two sessions: %s", got)
	}
	// A new session that has used nothing yet moves only the baseline: nothing is recorded, and the live stream hears nothing.
	rec := &liveRec{}
	s.life.live = rec
	third := "ses_ate2c"
	s.live.set("ate2", db.Field{Col: "session_id", Val: third}, db.Field{Col: "activity", Val: "working"})
	s.set(func(s *stopLive) { s.sessions[third] = sessionOf(0, 0, 0, 0, 0, 0) })
	s.event(execution("started", third))
	s.event(execution("succeeded", third))
	s.reportsDone()
	if got := rec.take(); got != "" {
		t.Errorf("a report with no growth told the live stream: %q", got)
	}
	if got := deref(s.agent("ate2").UsageLast); !strings.Contains(got, third) {
		t.Errorf("baseline %s", got)
	}
}

// A server that can't answer is skipped silently: the agent is idle and nothing is recorded or logged to its events.
func TestTurnEndReadsFailSilently(t *testing.T) {
	s, _ := newJobLive(t, "ate3")
	sid := "ses_ate3"
	s.set(func(s *stopLive) { s.failTurn = true })
	s.event(execution("succeeded", sid))
	s.reportsDone()
	s.wantActivity("ate3", "idle")
	if got := s.usageOf("ate3"); got != s.usageEmpty() {
		t.Errorf("usage after failed reads: %s", got)
	}
	if a := s.agent("ate3"); a.ContextTokens != nil || a.UsageLast != nil {
		t.Errorf("row written after failed reads: %v %v", a.ContextTokens, a.UsageLast)
	}
	// An answer with no tokens, and no assistant message, record nothing either.
	s.set(func(s *stopLive) {
		s.failTurn = false
		s.sessions[sid] = `{"cost":4}`
		s.messages[sid] = `[]`
	})
	s.event(execution("succeeded", sid))
	s.reportsDone()
	if a := s.agent("ate3"); a.ContextTokens != nil || a.UsageLast != nil {
		t.Errorf("row written for an answer without tokens: %v %v", a.ContextTokens, a.UsageLast)
	}
}

// A read the server holds delays nothing: the idle write is made, the next turn's events are handled, and the held read
// then reports for the agent as it runs now.
func TestTurnEndHeldReadDelaysNothing(t *testing.T) {
	s, _ := newJobLive(t, "ate4")
	sid := "ses_ate4"
	s.set(func(s *stopLive) {
		s.sessions[sid] = sessionOf(1, 10, 5, 0, 0, 0)
		s.messages[sid] = messageOf(10, 0)
	})
	release := s.holdNext("usage")
	defer release()
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.event(execution("succeeded", sid))
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the event waited for the server's read")
	}
	s.until("the held read", func() bool { return s.inFlight("usage") == 1 })
	s.wantActivity("ate4", "idle")
	s.event(execution("started", sid))
	s.wantActivity("ate4", "working")
	release()
	s.reportsDone()
	if got := s.usageOf("ate4"); got != "1.0|10|5|0|0" {
		t.Errorf("held read's report: %s", got)
	}
	s.wantActivity("ate4", "working")
}

// A usage or context read that returns after a stop, a launch, an archive or a session switch writes nothing to the row
// the newer owner has: checked in the write's own step (owner.writeIf), at each of the two reads.
func TestTurnEndReadAfterNewOwner(t *testing.T) {
	changes := map[string]func(s *stopLive, id string){
		"stop":    func(s *stopLive, id string) { s.life.invalidate(id) },
		"launch":  func(s *stopLive, id string) { s.life.nextLaunchGen(id) },
		"archive": func(s *stopLive, id string) { s.live.set(id, db.Field{Col: "lifecycle", Val: "archived"}) },
		"switch":  func(s *stopLive, id string) { s.live.set(id, db.Field{Col: "session_id", Val: "ses_elsewhere"}) },
	}
	for name, change := range changes {
		for _, read := range []string{"usage", "message"} {
			t.Run(name+"/"+read, func(t *testing.T) {
				id := "ate5"
				s, _ := newJobLive(t, id)
				sid := "ses_" + id
				s.set(func(s *stopLive) {
					s.sessions[sid] = sessionOf(1, 10, 5, 0, 0, 0)
					s.messages[sid] = messageOf(10, 0)
				})
				release := s.holdNext(read)
				defer release()
				s.event(execution("succeeded", sid))
				s.until("the held "+read, func() bool { return s.inFlight(read) == 1 })
				change(s, id)
				release()
				s.reportsDone()
				a := s.agent(id)
				if read == "usage" && (a.UsageLast != nil || s.usageOf(id) != s.usageEmpty()) {
					t.Errorf("usage written after %s: %v %s", name, a.UsageLast, s.usageOf(id))
				}
				if a.ContextTokens != nil {
					t.Errorf("context written after %s: %d", name, *a.ContextTokens)
				}
				if read == "usage" && s.reads("GET /api/session/"+sid+"/message?limit=1&order=desc&type=assistant") != 0 {
					t.Errorf("the context was read after the %s", name)
				}
				if read == "message" && a.UsageLast == nil {
					t.Errorf("usage read before the %s was refused too", name)
				}
			})
		}
	}
}

// Two ends close together, whose reads the server holds, count the session once, in either order of their reads
// returning: each report finds the baseline the other left, and a read older than the baseline records nothing.
func TestTurnEndTwoEnds(t *testing.T) {
	cases := []struct {
		name         string
		first, later int // what the server says when the first and the second read return
		want         string
	}{
		{"same numbers", 1, 1, "1.0|10|5|0|0"},
		{"older read last", 2, 1, "2.0|20|10|0|0"},
		{"newer read last", 1, 2, "2.0|20|10|0|0"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, _ := newJobLive(t, "ate6")
			sid := "ses_ate6"
			read := func(n int) { s.set(func(s *stopLive) { s.sessions[sid] = sessionOf(n, 10*n, 5*n, 0, 0, 0) }) }
			r1 := s.holdNext("usage")
			defer r1()
			s.event(execution("succeeded", sid))
			s.until("the first read", func() bool { return s.inFlight("usage") == 1 })
			r2 := s.holdNext("usage")
			defer r2()
			// The second end is of the next execution, started after the first ended.
			s.event(execution("started", sid))
			s.event(execution("succeeded", sid))
			s.until("the second read", func() bool { return s.inFlight("usage") == 2 })
			read(c.first)
			r1()
			s.until("the first report", func() bool { return s.agent("ate6").UsageLast != nil })
			read(c.later)
			r2()
			s.reportsDone()
			if got := s.usageOf("ate6"); got != c.want {
				t.Errorf("usage %s, want %s", got, c.want)
			}
		})
	}
}

// Two reports that have both read the agent's row before either writes (the race window itself) record the session's
// growth once: the baseline is read again inside the write, which the first has moved.
func TestTurnEndReportsRaceOnce(t *testing.T) {
	s, _ := newJobLive(t, "ate7")
	sid := "ses_ate7"
	s.set(func(s *stopLive) { s.sessions[sid] = sessionOf(3, 30, 15, 0, 0, 0) })
	var mu sync.Mutex
	arrived := 0
	gate := make(chan struct{})
	s.life.turnStep = func(id, step string) {
		if step != "usage-write" {
			return
		}
		mu.Lock()
		arrived++
		if arrived == 2 {
			close(gate)
		}
		mu.Unlock()
		<-gate
	}
	s.event(execution("succeeded", sid))
	s.event(execution("started", sid))
	s.event(execution("succeeded", sid))
	s.reportsDone()
	if got := s.usageOf("ate7"); got != "3.0|30|15|0|0" {
		t.Errorf("usage after two reports that read the row together: %s", got)
	}
}

// idleAgent is an OpenCode agent at rest in its session, for a compaction: the TUI up, idle.
func idleAgent(t *testing.T, id string) (*stopLive, db.Agent) {
	t.Helper()
	s, _ := newJobLive(t, id)
	s.live.idle(id)
	return s, s.agent(id)
}

// A compaction request for an idle OpenCode agent keeps its instructions for the server's compaction and asks the server
// to compact the session, with no relaunch: the harness stays up, the agent counts as compacting, and the server's
// events end it. The first size reported after it is its measured size.
func TestOpenCodeCompact(t *testing.T) {
	s, a := idleAgent(t, "atc1")
	sid := "ses_atc1"
	if _, err := s.life.requestCompaction(s.ctx, a, "keep the plan", "PROMPT", "test"); err != nil {
		t.Fatal(err)
	}
	if got := s.promptsOf(); len(got) != 1 || got[0] != sid+" PROMPT" {
		t.Errorf("prompts %v", got)
	}
	if got := strings.Join(s.compactsOf(), ","); got != sid {
		t.Errorf("compactions asked: %q", got)
	}
	if got := s.life.TakeCompactInstructions("atc1"); got != "keep the plan" {
		t.Errorf("instructions %q", got)
	}
	if got := s.life.TakeCompactInstructions("atc1"); got != "" {
		t.Errorf("instructions taken twice: %q", got)
	}
	if got := detailOf(s.agent("atc1")); got != "compacting: test" || s.agent("atc1").Activity != "working" {
		t.Errorf("state %s/%q", s.agent("atc1").Activity, got)
	}
	if !s.tmux.HasSession(s.ctx, "atc1") {
		t.Error("the compaction took the harness down")
	}
	for _, typ := range []string{"compact", "compact:done"} {
		if n := s.countEvents("atc1", typ); n != 1 {
			t.Errorf("%d %s events", n, typ)
		}
	}
	s.set(func(s *stopLive) { s.messages[sid] = messageOf(30, 0) })
	s.event(execution("succeeded", sid))
	s.reportsDone()
	s.wantActivity("atc1", "idle")
	if got := s.events("atc1", "compaction:measured"); len(got) != 1 {
		t.Errorf("measured events: %v", got)
	}
}

func (s *stopLive) compactsOf() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.compacts...)
}

func (s *stopLive) connectsOf() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.connects...)
}

// A compaction the server refuses ends as a failed one, with the agent idle again and the instructions dropped: it is
// never left "compacting" with nothing to end it. The error says the method, path and status, never the body.
func TestOpenCodeCompactFails(t *testing.T) {
	s, a := idleAgent(t, "atc2")
	s.set(func(s *stopLive) { s.failControl = true })
	_, err := s.life.RequestCompaction(s.ctx, a, "keep", "test")
	var ce *opencode.CallError
	if !errors.As(err, &ce) || ce.Status != 500 || strings.Contains(err.Error(), "sk-or") {
		t.Errorf("error %v", err)
	}
	s.wantActivity("atc2", "idle")
	if got := detailOf(s.agent("atc2")); got != "compaction not done" {
		t.Errorf("detail %q", got)
	}
	if n := s.countEvents("atc2", "compact:failed"); n != 1 {
		t.Errorf("%d compact:failed events", n)
	}
	if got := s.life.TakeCompactInstructions("atc2"); got != "" {
		t.Errorf("instructions kept after a failure: %q", got)
	}
}

// A daemon restart in the middle of a compaction leaves an OpenCode agent as it was: the harness is up and the server
// still compacts, so nothing is lost or resumed (the claude recovery is for a harness the compaction took down), and the
// agent is "compacting" until the server's events end it. The reconcile pass changes nothing.
func TestOpenCodeCompactRestartMidway(t *testing.T) {
	s, _ := idleAgent(t, "atc5")
	sid := "ses_atc5"
	// The compaction as the first daemon left it: claimed and asked, its end not yet recorded.
	s.live.set("atc5", db.Field{Col: "activity", Val: "working"}, db.Field{Col: "activity_detail", Val: "compacting: test"})
	s.life.event(s.ctx, "atc5", "compact", raw(jsjson.NewObject("reason", "test", "op", "op1")))
	s.life = New(s.ctx, s.opts)
	s.reconcile(s.life)
	got := s.agent("atc5")
	if got.Lifecycle != "active" || got.Activity != "working" || detailOf(got) != "compacting: test" || got.PendingAction != nil {
		t.Errorf("after the restart: %s/%s/%q pending %v", got.Lifecycle, got.Activity, detailOf(got), got.PendingAction)
	}
	if n := s.countEvents("atc5", "exit:compaction") + s.countEvents("atc5", "recover-error"); n != 0 {
		t.Errorf("the restart treated the compaction as an exit: %d events", n)
	}
	s.life.onOpenCodeEvent(s.ctx, mustEvent(t, execution("succeeded", sid)))
	s.reportsDone()
	s.wantActivity("atc5", "idle")
}

// A plain MCP reconnect of an OpenCode agent reloads the shared server's client for the directory of the row it was made
// from, with no restart; a row of another directory than the agent's is a stale request. One whenIdle (its pending, left
// for TS) isn't ported.
func TestOpenCodeReconnect(t *testing.T) {
	s, a := idleAgent(t, "atr1")
	stale := a
	stale.Cwd = "/elsewhere"
	if got, err := s.life.ReconnectMCP(s.ctx, stale, false); err != nil || got == "reconnected" {
		t.Fatalf("a request from another directory's row: %q, %v", got, err)
	}
	if c := s.connectsOf(); len(c) != 0 {
		t.Fatalf("connected for a stale directory: %v", c)
	}
	got, err := s.life.ReconnectMCP(s.ctx, a, false)
	if err != nil || got != "reconnected" {
		t.Fatalf("%q, %v", got, err)
	}
	if c := s.connectsOf(); len(c) != 1 || c[0] != s.work {
		t.Errorf("connected %v, want the row's directory %s", c, s.work)
	}
	if !s.tmux.HasSession(s.ctx, "atr1") {
		t.Error("the reconnect took the harness down")
	}
	var np ErrNotPorted
	if _, err := s.life.ReconnectMCP(s.ctx, a, true); !errors.As(err, &np) {
		t.Errorf("a whenIdle reconnect: %v", err)
	}
}

// A reconnect made from a row the agent has left (stopped and launched again into another session after the caller read
// it) reaches no MCP client: it is bound to the row's session, never to whichever one the agent runs when it gets there.
func TestOpenCodeReconnectStaleRow(t *testing.T) {
	s, a := idleAgent(t, "atr3")
	s.life.invalidate("atr3")
	s.life.nextLaunchGen("atr3")
	s.live.set("atr3", db.Field{Col: "session_id", Val: "ses_next"})
	if got, err := s.life.ReconnectMCP(s.ctx, a, false); err != nil || got == "reconnected" {
		t.Errorf("%q, %v", got, err)
	}
	if c := s.connectsOf(); len(c) != 0 {
		t.Errorf("the successor's client was reconnected: %v", c)
	}
	// An agent with no session at all: the empty session the row and the agent agree on never binds.
	s.live.set("atr3", db.Field{Col: "session_id", Val: nil})
	empty := s.agent("atr3")
	if got, err := s.life.ReconnectMCP(s.ctx, empty, false); err != nil || got == "reconnected" {
		t.Errorf("an agent without a session: %q, %v", got, err)
	}
	if c := s.connectsOf(); len(c) != 0 {
		t.Errorf("connected for an empty session: %v", c)
	}
}

// proceed false sends nothing; a stopped, archived or relaunched agent is left alone as no error; a failure says the
// method, path and status only.
func TestOpenCodeReconnectGuards(t *testing.T) {
	s, a := idleAgent(t, "atr2")
	if done, err := s.life.reconnectOpenCode(s.ctx, a, func() bool { return false }); done || err != nil {
		t.Errorf("proceed false: %v, %v", done, err)
	}
	if c := s.connectsOf(); len(c) != 0 {
		t.Errorf("connected after proceed false: %v", c)
	}
	for name, change := range map[string]func(){
		"stop":    func() { s.life.invalidate("atr2") },
		"launch":  func() { s.life.nextLaunchGen("atr2") },
		"archive": func() { s.live.set("atr2", db.Field{Col: "lifecycle", Val: "archived"}) },
	} {
		s.life.turnStep = func(id, step string) {
			if step == "reconnect" {
				s.life.turnStep = nil
				change()
			}
		}
		if done, err := s.life.reconnectOpenCode(s.ctx, a, nil); done || err != nil {
			t.Errorf("%s between the check and the call: %v, %v", name, done, err)
		}
		if c := s.connectsOf(); len(c) != 0 {
			t.Fatalf("connected after a %s: %v", name, c)
		}
		s.live.set("atr2", db.Field{Col: "lifecycle", Val: "active"})
	}
	s.life.turnStep = nil
	s.live.set("atr2", db.Field{Col: "lifecycle", Val: "shut_down"})
	if got, err := s.life.ReconnectMCP(s.ctx, a, false); err != nil || got == "reconnected" {
		t.Errorf("a stopped agent's reconnect: %q, %v", got, err)
	}
	if c := s.connectsOf(); len(c) != 0 {
		t.Errorf("connected for a stopped agent: %v", c)
	}
	s.live.set("atr2", db.Field{Col: "lifecycle", Val: "active"})
	// The launches the loop began are over: the agent runs again.
	s.life.ownerOf("atr2").settleLaunch(s.life.genOf("atr2"), true)
	s.set(func(s *stopLive) { s.failControl = true })
	_, err := s.life.ReconnectMCP(s.ctx, a, false)
	var ce *opencode.CallError
	if !errors.As(err, &ce) || ce.Status != 500 || strings.Contains(err.Error(), "sk-or") {
		t.Errorf("error %v", err)
	}
}

func (s *stopLive) promptsOf() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.prompts...)
}

// A usage report and a context size are written in a transaction that checks the row: a writer that moves the agent to
// another session after the owner's check and before the commit leaves both unwritten.
func TestTurnEndWriterBetweenCheckAndCommit(t *testing.T) {
	for _, step := range []string{"usage-commit", "update-commit"} {
		t.Run(step, func(t *testing.T) {
			s, _ := newJobLive(t, "ate8")
			sid := "ses_ate8"
			s.set(func(s *stopLive) {
				s.sessions[sid] = sessionOf(1, 10, 5, 0, 0, 0)
				s.messages[sid] = messageOf(10, 0)
			})
			s.life.turnStep = func(id, at string) {
				if at == step {
					s.live.set(id, db.Field{Col: "session_id", Val: "ses_elsewhere"})
				}
			}
			s.event(execution("succeeded", sid))
			s.reportsDone()
			a := s.agent("ate8")
			if step == "usage-commit" && (a.UsageLast != nil || s.usageOf("ate8") != s.usageEmpty()) {
				t.Errorf("usage written: %v %s", a.UsageLast, s.usageOf("ate8"))
			}
			if a.ContextTokens != nil {
				t.Errorf("context written: %d", *a.ContextTokens)
			}
		})
	}
}

// The effects of a context size follow only the report they were read for: an agent that is stopped or switched after the
// size was committed moves no level, measures nothing (and keeps the mark for its next report), and requests no compaction.
func TestTurnEndContextEffectsBound(t *testing.T) {
	for _, kind := range []string{"stop", "switch"} {
		t.Run(kind, func(t *testing.T) {
			s, _ := newJobLive(t, "ate9")
			sid := "ses_ate9"
			s.live.setSettings(`{"context":{"warnTokens":100,"instructTokens":200,"enforceTokens":300},"retro":{"reminders":{"enabled":false}}}`)
			s.set(func(s *stopLive) { s.messages[sid] = messageOf(1000, 0) })
			s.life.ownerOf("ate9").mark = &ocMark{sid: sid}
			s.life.turnStep = func(id, at string) {
				if at != "context-written" {
					return
				}
				if kind == "stop" {
					s.life.invalidate(id)
				} else {
					s.live.set(id, db.Field{Col: "session_id", Val: "ses_elsewhere"})
				}
			}
			s.event(execution("succeeded", sid))
			s.reportsDone()
			a := s.agent("ate9")
			if a.ContextLevel != 0 || a.TokensAfterCompaction != nil {
				t.Errorf("level %d, measured %v", a.ContextLevel, a.TokensAfterCompaction)
			}
			for _, typ := range []string{"compaction:measured", "context:threshold", "compact"} {
				if n := s.countEvents("ate9", typ); n != 0 {
					t.Errorf("%d %s events", n, typ)
				}
			}
			o := s.life.ownerOf("ate9")
			o.mu.Lock()
			kept := o.mark != nil
			o.mu.Unlock()
			if !kept {
				t.Error("the measurement mark was consumed by a report that was overtaken")
			}
		})
	}
}

// With nothing in the way the same size moves the level and measures: the control of the test above.
func TestTurnEndContextEffects(t *testing.T) {
	s, _ := newJobLive(t, "ate10")
	sid := "ses_ate10"
	s.live.setSettings(`{"context":{"warnTokens":100,"instructTokens":200,"enforceTokens":100000},"retro":{"reminders":{"enabled":false}}}`)
	s.set(func(s *stopLive) { s.messages[sid] = messageOf(1000, 0) })
	s.life.ownerOf("ate10").mark = &ocMark{sid: sid}
	s.event(execution("succeeded", sid))
	s.reportsDone()
	a := s.agent("ate10")
	if a.TokensAfterCompaction == nil || *a.TokensAfterCompaction != 1000 {
		t.Errorf("measured %v", a.TokensAfterCompaction)
	}
	if n := s.countEvents("ate10", "compaction:measured"); n != 1 {
		t.Errorf("%d measured events", n)
	}
}

// A daemon restart in the middle of a compaction with the TUI gone: the exit is read as the compaction's (the agent is
// lost with it) and resumed like any lost OpenCode agent, with no compaction of its own to run: the server's compaction
// belongs to its session, so the resume continues it. The agent is not left "compacting".
func TestOpenCodeCompactRestartTUIGone(t *testing.T) {
	s, _ := newJobLive(t, "atc8")
	s.live.set("atc8", db.Field{Col: "activity", Val: "working"}, db.Field{Col: "activity_detail", Val: "compacting: test"})
	s.life.event(s.ctx, "atc8", "compact", raw(jsjson.NewObject("reason", "test", "op", "op1")))
	if err := s.tmux.KillSession(s.ctx, "atc8"); err != nil {
		t.Fatal(err)
	}
	s.life = New(s.ctx, s.opts)
	s.reconcile(s.life)
	got := s.agent("atc8")
	if got.Lifecycle == "shut_down" && !strings.Contains(deref(got.PendingAction), `"type":"recover"`) {
		t.Fatalf("after the restart: %s/%s/%q pending %v", got.Lifecycle, got.Activity, detailOf(got), deref(got.PendingAction))
	}
	// The reconcile that read it lost starts its recovery, which resumes it.
	s.until("the resume", func() bool { a := s.agent("atc8"); return a.Lifecycle == "active" && a.PendingAction == nil })
	got = s.agent("atc8")
	if got.Lifecycle != "active" || got.PendingAction != nil || strings.Contains(detailOf(got), "compacting") {
		t.Errorf("after the recovery: %s/%s/%q pending %v", got.Lifecycle, got.Activity, detailOf(got), deref(got.PendingAction))
	}
	if n := s.countEvents("atc8", "compact:killed") + s.countEvents("atc8", "recover-error"); n != 0 {
		t.Errorf("%d compaction or recovery errors", n)
	}
	if got := s.compactsOf(); len(got) != 0 {
		t.Errorf("the recovery compacted again: %v", got)
	}
}

// A size committed, and the level written, for an agent that is stopped before the threshold's notice: the notice and a
// forced compaction are the report's, and follow only while its session and generation hold.
func TestTurnEndContextNoticeBound(t *testing.T) {
	s, _ := newJobLive(t, "ate11")
	sid := "ses_ate11"
	s.live.setSettings(`{"context":{"warnTokens":100,"instructTokens":200,"enforceTokens":300},"retro":{"reminders":{"enabled":false}}}`)
	s.set(func(s *stopLive) { s.messages[sid] = messageOf(1000, 0) })
	s.life.turnStep = func(id, at string) {
		if at == "context-level" {
			s.life.turnStep = nil
			s.life.invalidate(id)
		}
	}
	s.event(execution("succeeded", sid))
	s.reportsDone()
	for _, typ := range []string{"context:threshold", "compact"} {
		if n := s.countEvents("ate11", typ); n != 0 {
			t.Errorf("%d %s events after a stop", n, typ)
		}
	}
}

// forcedLive is an OpenCode agent at its turn's end whose context size is over the enforce threshold, so its report asks
// for a compaction by force.
func forcedLive(t *testing.T, id string) (*stopLive, string) {
	t.Helper()
	s, _ := newJobLive(t, id)
	sid := "ses_" + id
	s.live.setSettings(`{"context":{"warnTokens":100,"instructTokens":200,"enforceTokens":300},"retro":{"reminders":{"enabled":false}}}`)
	s.set(func(s *stopLive) { s.messages[sid] = messageOf(1000, 0) })
	return s, sid
}

// A report over the enforce threshold compacts the agent by force: the control of the tests below.
func TestTurnEndForcedCompaction(t *testing.T) {
	s, sid := forcedLive(t, "atf1")
	s.event(execution("succeeded", sid))
	s.reportsDone()
	s.until("the forced compaction", func() bool { return len(s.compactsOf()) == 1 })
	if got := s.compactsOf(); got[0] != sid {
		t.Errorf("compacted %v", got)
	}
}

// A new session whose first report has no cost still restarts cost: the cost it reports later is counted from zero, not
// dropped as a lower reading than the previous session's.
func TestTurnEndNewSessionWithoutCost(t *testing.T) {
	s, _ := newJobLive(t, "ate13")
	steps := []struct{ sid, body string }{
		{"ses_ate13a", sessionOf(10, 100, 10, 0, 0, 0)},
		{"ses_ate13b", `{"tokens":{"input":5,"output":1}}`},
		{"ses_ate13b", sessionOf(2, 5, 1, 0, 0, 0)},
		{"ses_ate13b", sessionOf(7, 5, 1, 0, 0, 0)},
	}
	for n, st := range steps {
		s.live.set("ate13", db.Field{Col: "session_id", Val: st.sid}, db.Field{Col: "activity", Val: "working"})
		s.set(func(s *stopLive) { s.sessions[st.sid] = st.body })
		s.event(execution("started", st.sid))
		s.event(execution("succeeded", st.sid))
		s.reportsDone()
		_ = n
	}
	if got := s.usageOf("ate13"); got != "17.0|105|11|0|0" {
		t.Errorf("usage over a session whose first report had no cost: %s", got)
	}
}

// An empty session never binds: an agent with no session, bound to "", writes nothing and is never still the agent's.
func TestTurnEndEmptySession(t *testing.T) {
	s, _ := newJobLive(t, "ate14")
	s.live.set("ate14", db.Field{Col: "session_id", Val: nil})
	b := s.life.turnBinding(s.ctx, "ate14", "", s.life.genOf("ate14"))
	if b.still() {
		t.Error("an empty session is still the agent's")
	}
	if wrote, _ := b.write(func() error { return nil }); wrote {
		t.Error("an empty session wrote")
	}
	if b.update(s.ctx, db.Field{Col: "context_tokens", Val: 5}) {
		t.Error("an empty session updated the row")
	}
	if a := s.agent("ate14"); a.ContextTokens != nil {
		t.Errorf("context %d written for an empty session", *a.ContextTokens)
	}
}

// A turn end that comes while a launch is in flight runs nothing of the pending compaction: the launch owns the agent,
// and writes the pending action back for its own turn end. After it lands the compaction is still pending.
func TestOpenCodeIdleDuringLaunch(t *testing.T) {
	s, _ := idleAgent(t, "atl1")
	s.live.set("atl1", db.Field{Col: "pending_action", Val: ocPendingText}, db.Field{Col: "activity", Val: "working"})
	gen := s.life.nextLaunchGen("atl1")
	s.event(execution("succeeded", "ses_atl1"))
	s.reportsDone()
	s.life.bg.Wait()
	if got := s.compactsOf(); len(got) != 0 {
		t.Errorf("compacted during a launch: %v", got)
	}
	if s.agent("atl1").PendingAction == nil {
		t.Error("the pending compaction was taken during a launch")
	}
	s.life.ownerOf("atl1").settleLaunch(gen, true)
}

// A turn end that happened while a launch was in flight stays refused after the launch settles: it was of the session the
// launch replaced, and the successor's pending compaction is not its to take. The launch lands (its start is written and
// it settles) before the signal's delayed callback runs, so a check made only where the binding is used would pass.
func TestOpenCodeIdleBeforeLaunchSettles(t *testing.T) {
	for _, step := range []string{"ended", "pending-gen"} {
		t.Run(step, func(t *testing.T) {
			id := "atl3"
			s, _ := idleAgent(t, id)
			s.live.set(id, db.Field{Col: "pending_action", Val: ocPendingText}, db.Field{Col: "activity", Val: "working"})
			s.set(func(s *stopLive) {
				s.sessions["ses_"+id] = sessionOf(2, 100, 40, 10, 500, 60)
				s.messages["ses_"+id] = messageOf(120, 700)
			})
			gen := s.life.nextLaunchGen(id)
			held, release := make(chan struct{}), make(chan struct{})
			hold := func(at string) {
				if at == step {
					close(held)
					<-release
				}
			}
			s.life.turnStep = func(got, at string) { hold(at) }
			// The event's end is bound at the event (owner.endExec), before its "ended" step: held there, the launch
			// lands before anything the end would start, its reads included, can run.
			s.life.jobStep = func(got, at string) { hold(at) }
			done := make(chan struct{})
			go func() {
				defer close(done)
				if step == "pending-gen" {
					_ = s.life.OnIdle(s.ctx, id)
				} else {
					// As s.event hands it on, off the test's goroutine: it holds at "ended".
					v, _ := jsjson.Parse([]byte(execution("succeeded", "ses_"+id)))
					data, _ := v.(*jsjson.Object).Get("data")
					s.life.onOpenCodeEvent(s.ctx, opencode.Event{Type: "session.execution.succeeded", Data: data.(*jsjson.Object), Raw: v})
				}
			}()
			<-held
			// The launch lands: its start is on the row and it has settled.
			s.live.set(id, db.Field{Col: "resumed_at", Val: ocStamp(9)}, db.Field{Col: "activity", Val: "idle"})
			s.life.ownerOf(id).settleLaunch(gen, true)
			close(release)
			<-done
			s.life.bg.Wait()
			s.reportsDone()
			if got := s.compactsOf(); len(got) != 0 {
				t.Errorf("a turn end of the replaced session compacted the successor: %v", got)
			}
			if s.agent(id).PendingAction == nil {
				t.Error("a turn end of the replaced session took the successor's pending compaction")
			}
			if got := s.usageOf(id); got != s.usageEmpty() {
				t.Errorf("a turn end of the replaced session reported usage: %s", got)
			}
		})
	}
}

// A pending compaction a runner could not run (the idle period moved on between its read and its claim) stays on the row
// as the runner read it, and is not written again: a concurrent writer's different pending action (a shutdown) that
// replaced it in between is not overwritten.
func TestOpenCodePendingReplacedWhileUnclaimed(t *testing.T) {
	id := "atl4"
	s, _ := idleAgent(t, id)
	s.live.set(id, db.Field{Col: "pending_action", Val: ocPendingText})
	const shutdown = `{"type":"shutdown","reason":"done"}`
	s.life.turnStep = func(got, at string) {
		if at == "compact-claim" {
			s.live.set(id, db.Field{Col: "idle_since", Val: ocStamp(7)}, db.Field{Col: "pending_action", Val: shutdown})
		}
	}
	if err := s.life.OnIdle(s.ctx, id); err != nil {
		t.Fatal(err)
	}
	if got := s.compactsOf(); len(got) != 0 {
		t.Errorf("compacted in a new idle period: %v", got)
	}
	if p := s.agent(id).PendingAction; p == nil || *p != shutdown {
		t.Errorf("the replacing pending action was overwritten: %v", p)
	}
}

// A compaction written between OnIdle's two reads of the row (a request made while the agent was working) is not taken
// by the generic pending take, which would clear it for a harness that can't run it: it stays pending for the owner-bound
// path, and runs at the next turn end.
func TestOpenCodeIdleWriterBetweenReads(t *testing.T) {
	s, a := idleAgent(t, "atl2")
	s.live.set("atl2", db.Field{Col: "activity", Val: "working"}, db.Field{Col: "activity_detail", Val: nil})
	working := s.agent("atl2")
	s.life.turnStep = func(id, step string) {
		if step != "pending-read" {
			return
		}
		s.life.turnStep = nil
		if _, err := s.life.RequestCompaction(s.ctx, working, "keep", "test"); err != nil {
			t.Error(err)
		}
	}
	if err := s.life.OnIdle(s.ctx, "atl2"); err != nil {
		t.Fatal(err)
	}
	if s.agent("atl2").PendingAction == nil {
		t.Fatal("the compaction written between the reads was cleared")
	}
	if len(s.compactsOf()) != 0 {
		t.Errorf("compacted by a take that read the row before it: %v", s.compactsOf())
	}
	// The agent's next turn end runs it.
	s.live.idle("atl2")
	if err := s.life.OnIdle(s.ctx, "atl2"); err != nil {
		t.Fatal(err)
	}
	if got := s.compactsOf(); len(got) != 1 || got[0] != "ses_atl2" {
		t.Errorf("compactions %v", got)
	}
	_ = a
}

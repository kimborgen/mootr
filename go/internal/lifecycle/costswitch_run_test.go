package lifecycle

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/tmux"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The tests of costswitch_run.go, the switch around the move. TestSwitchFlowMatchesTS runs whole switches through
// src/cost-switch.ts costSwitch (testdata/switchflow.mjs) and the Go one and compares what they leave; the rest show
// the restart and failure behaviour: a crash at each step and what the next start re-arms, the rollback of a successor
// that fails and the predecessor's switch back, no double launch, and the switch raced against resumes, starts and
// registry changes.

const switchRunSettings = `{"peers":[],"chiefOfStaff":"cos","humanMail":{"when":"important"},"cost":{"subscriptionWarnPercent":[]}}`

const switchRunRegistry = `{"presets":{"cheap":{"harness":"claude","model":"cheap-model","effort":"low"},"odd":{"harness":"fake9"},` +
	`"codexy":{"harness":"codex","model":"gpt-x"},"bare":{"harness":"claude"}}}`

// newSwitchLive is a cost live home with switchRunRegistry, successors with ids no real agent has (alsN1), the Claude
// interrupt's waits shortened, and the hook a fake Claude Code never sends played: a launch whose first prompt was
// typed goes off starting, as UserPromptSubmit would take it.
func newSwitchLive(t *testing.T) *live {
	l, _ := newCostLive(t, switchRunSettings)
	l.writeRegistry(switchRunRegistry)
	n := 0
	var mu sync.Mutex
	l.life.successorID = func() string {
		mu.Lock()
		defer mu.Unlock()
		n++
		return fmt.Sprintf("als%d1", n)
	}
	prev := interruptSteps
	interruptSteps.esc, interruptSteps.look = 50*time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() { interruptSteps = prev })
	l.playPromptHooks()
	return l
}

func (l *live) writeRegistry(text string) {
	l.t.Helper()
	if err := os.WriteFile(filepath.Join(l.home, "registry.json"), []byte(text), 0o600); err != nil {
		l.t.Fatal(err)
	}
}

// playPromptHooks moves each agent whose launch typed its prompt (first-prompt:awaiting-hook since its latest spawn or
// resume) off starting, until the test ends.
func (l *live) playPromptHooks() {
	ctx, cancel := context.WithCancel(l.ctx)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for ctx.Err() == nil {
			ids := l.queryCtx(ctx, `SELECT a.id FROM agents a WHERE a.activity = 'starting' AND EXISTS (SELECT 1 FROM events e WHERE e.agent_id = a.id
				AND e.type = 'first-prompt:awaiting-hook' AND e.id > (SELECT IFNULL(MAX(id), 0) FROM events WHERE agent_id = a.id AND type IN ('spawn', 'resume')))`)
			for _, id := range ids {
				_ = l.db.UpdateAgent(ctx, id, db.Field{Col: "activity", Val: "working"}, db.Field{Col: "activity_detail", Val: nil})
				// The first prompt's UserPromptSubmit (S-3454): a hook with no prompt counts, so the launch's wait ends.
				// Each launch waits on the lifecycle that made it, so every restarted one is marked too.
				for _, life := range l.lifecycles() {
					life.firstPromptHook(id, nil)
				}
			}
			select {
			case <-ctx.Done():
			case <-time.After(20 * time.Millisecond):
			}
		}
	}()
	l.t.Cleanup(func() {
		cancel()
		wg.Wait()
	})
}

// queryCtx is query's rows, read under ctx; nil on an error (the test is ending).
func (l *live) queryCtx(ctx context.Context, q string) []string {
	var out []string
	err := l.db.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, q, &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
			out = append(out, stmt.ColumnText(0))
			return nil
		}})
	})
	if err != nil {
		return nil
	}
	return out
}

// switchOrgSQL is cos above mgr above the predecessor (alwk1, worker, idle and active, no terminal), with a stranger.
func switchOrgSQL(worker map[string]string) []string {
	cols := map[string]string{"parent_id": "'almg1'", "harness": "'claude'", "session_id": "'sess-w'"}
	for k, v := range worker {
		cols[k] = v
	}
	return []string{
		agentSQL("alco1", "cos", map[string]string{"harness": "'claude'"}),
		agentSQL("almg1", "mgr", map[string]string{"parent_id": "'alco1'", "harness": "'claude'"}),
		agentSQL("alst1", "stranger", map[string]string{"harness": "'claude'"}),
		agentSQL("alwk1", "worker", cols),
	}
}

type flowCase struct {
	Name   string   `json:"name"`
	Agent  string   `json:"agent"`
	By     string   `json:"by"`
	Preset string   `json:"preset"`
	SQL    []string `json:"sql"`
	// Files are written under the case folder first: a path relative to it, and the text.
	Files map[string]string `json:"files,omitempty"`
	// Fails is the error the switch must give, "" for one that succeeds.
	Fails string `json:"-"`
}

type flowOut struct {
	Result   json.RawMessage `json:"result"`
	Error    *string         `json:"error"`
	Events   []string        `json:"events"`
	Blockers []string        `json:"blockers"`
	Agents   []string        `json:"agents"`
	Queued   []string        `json:"queued"`
	Notices  []string        `json:"notices"`
	Work     string          `json:"work"`
}

func flowCases() []flowCase {
	notice := "INSERT INTO cost_notices (id, key, kind, account, window, agent_id, managers, created_at) VALUES ('cn1', 'k1', 'blocker-set', 'max', '', 'alwk1', '[\"almg1\"]', '" + t0 + "')"
	other := "INSERT INTO cost_notices (id, key, kind, account, window, agent_id, managers, created_at) VALUES ('cn2', 'k2', 'blocker-set', 'max', '', 'almg1', '[\"alco1\"]', '" + t0 + "')"
	return []flowCase{
		// An idle agent switches at once; its open cost notice is acknowledged, another agent's isn't.
		{Name: "idle", Agent: "worker", By: "almg1", Preset: "cheap", SQL: append(switchOrgSQL(nil), notice, other)},
		// One with a HANDOVER.md, mail threads (read and unread), a spawned child, an adopted one and an open ITSA.
		{Name: "full", Agent: "worker", By: "almg1", Preset: "cheap", Files: map[string]string{"worker/HANDOVER.md": "# Handover\nship the widget\n"},
			SQL: append(switchOrgSQL(nil),
				agentSQL("alch1", "kid", map[string]string{"parent_id": "'alwk1'", "harness": "'claude'", "lifecycle": "'shut_down'"}),
				agentSQL("alad1", "foster", map[string]string{"parent_id": "'almg1'", "harness": "'claude'", "lifecycle": "'shut_down'"}),
				"INSERT INTO agent_parents (child_id, parent_id) VALUES ('alad1', 'alwk1')",
				mailSQL("mt1", "almg1", "mt1", "Plan", t0), recipSQL("mt1", "alwk1", t0),
				mailSQL("mt2", "alwk1", "mt1", "Re: Plan", "2026-01-01T00:01:00.000Z"), recipSQL("mt2", "almg1", ""),
				mailSQL("mt3", "almg1", "mt3", "Next", "2026-01-01T00:02:00.000Z"), recipSQL("mt3", "alwk1", ""),
				itsaSQL("I1", "S-1", "alwk1", ""))},
		// A shut-down agent still marked working isn't asked to wrap up: nothing runs.
		{Name: "shut-down-working", Agent: "worker", By: "almg1", Preset: "cheap", SQL: switchOrgSQL(map[string]string{"lifecycle": "'shut_down'", "activity": "'working'"})},
		// A working one is asked to wrap up, and interrupted at the deadline (never confirmed here), then stopped.
		{Name: "working", Agent: "worker", By: "almg1", Preset: "cheap", SQL: switchOrgSQL(map[string]string{"activity": "'working'"})},
		// One whose harness is still starting counts as busy: it is asked to wrap up too.
		{Name: "starting", Agent: "worker", By: "almg1", Preset: "cheap", SQL: switchOrgSQL(map[string]string{"activity": "'starting'"})},
		// A paused one that is mid-turn too, and the human asks.
		{Name: "paused", Agent: "worker", By: "human", Preset: "cheap", SQL: switchOrgSQL(map[string]string{"activity": "'working'", "lifecycle": "'paused'", "paused_by": `'["human"]'`})},
		// A shut-down one isn't running, so nothing is stopped; its successor still starts.
		{Name: "shut-down", Agent: "worker", By: "alco1", Preset: "cheap", SQL: switchOrgSQL(map[string]string{"lifecycle": "'shut_down'", "activity": "'unknown'"})},
		// The refusals, before anything changes.
		{Name: "forbidden", Agent: "worker", By: "alst1", Preset: "cheap", SQL: switchOrgSQL(nil), Fails: "may not manage cost"},
		{Name: "archived", Agent: "worker", By: "almg1", Preset: "cheap", SQL: switchOrgSQL(map[string]string{"lifecycle": "'archived'"}), Fails: "is archived"},
		{Name: "taken-over", Agent: "worker", By: "almg1", Preset: "cheap", SQL: append(switchOrgSQL(map[string]string{"forwarded_to": "'alnx1'"}),
			agentSQL("alnx1", "worker-t2", map[string]string{"harness": "'claude'", "parent_id": "'almg1'"})), Fails: "already taken over by worker-t2"},
		{Name: "no-preset", Agent: "worker", By: "almg1", Preset: "nope", SQL: switchOrgSQL(nil), Fails: "no preset nope"},
		{Name: "no-agent", Agent: "ghost", By: "human", Preset: "cheap", SQL: switchOrgSQL(nil), Fails: "no agent ghost"},
		{Name: "odd-harness", Agent: "worker", By: "almg1", Preset: "odd", SQL: switchOrgSQL(nil), Fails: "runs fake9, which stam can't control"},
	}
}

// TestSwitchFlowMatchesTS: whole switches, run through TS costSwitch with a fake Claude Code and through the Go one
// with the test's: the result or the error, every cost:switch step (the deadline compared as NOW) and ack, the
// blockers, each agent's lifecycle, forward and target, the predecessor's queued notices (the wrap-up request), and
// the cost notices' acks. The successor's id is compared as SUCC, the case folder as WORK.
func TestSwitchFlowMatchesTS(t *testing.T) {
	cases := flowCases()
	in, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd := exec.Command("node", "--no-warnings", "testdata/switchflow.mjs", string(in), switchRunSettings, switchRunRegistry)
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("switchflow.mjs: %v\n%s", err, stderr.String())
	}
	var want map[string]flowOut
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("switchflow.mjs output %q: %v", raw, err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			w := want[c.Name]
			if c.Fails == "" && w.Error != nil {
				t.Fatalf("TS switch failed: %s", *w.Error)
			}
			if c.Fails != "" && (w.Error == nil || !strings.Contains(*w.Error, c.Fails)) {
				t.Fatalf("TS switch didn't fail as the case asks: %v", orNil(w.Error))
			}
			g := runFlowCase(t, c)
			exp, got := normalizeFlow(w), normalizeFlow(g)
			if c.Fails == "" && !strings.Contains(strings.Join(exp.Events, "\n"), `step\":\"done`) {
				t.Fatalf("TS gave no done step: %v", exp.Events)
			}
			if (got.Error == nil) != (exp.Error == nil) || (got.Error != nil && *got.Error != *exp.Error) {
				t.Errorf("error:\nGo: %v\nTS: %v", orNil(got.Error), orNil(exp.Error))
			}
			if string(got.Result) != string(exp.Result) {
				t.Errorf("result:\nGo: %s\nTS: %s", got.Result, exp.Result)
			}
			for _, k := range []struct {
				name     string
				got, exp []string
			}{{"events", got.Events, exp.Events}, {"blockers", got.Blockers, exp.Blockers}, {"agents", got.Agents, exp.Agents},
				{"queued", got.Queued, exp.Queued}, {"notices", got.Notices, exp.Notices}} {
				if a, b := strings.Join(k.got, "\n"), strings.Join(k.exp, "\n"); a != b {
					t.Errorf("%s:\nGo:\n%s\nTS:\n%s", k.name, a, b)
				}
			}
		})
	}
}

func runFlowCase(t *testing.T, c flowCase) flowOut {
	l := newSwitchLive(t)
	work := l.freshSwitchHome(c.Name, c.SQL)
	for rel, text := range c.Files {
		path := filepath.Join(work, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	soft := 0.003
	o := SwitchOptions{Agent: c.Agent, Preset: c.Preset, By: c.By, SoftStopMinutes: &soft, Poll: 20 * time.Millisecond}
	out := flowOut{Work: work, Result: json.RawMessage("null")}
	plan, err := l.life.CheckSwitch(l.ctx, o, false)
	var res SwitchResult
	if err == nil {
		res, err = l.life.CostSwitch(l.ctx, o, plan)
	}
	if err != nil {
		msg := err.Error()
		out.Error = &msg
	} else {
		b, _ := json.Marshal(res)
		out.Result = b
	}
	out.Events = dumpRows(t, l, "SELECT agent_id, type, data FROM events WHERE type IN ('cost:switch', 'cost:ack', 'cost:interrupt-error', 'cost:switch-resume-error') ORDER BY id")
	out.Blockers = dumpRows(t, l, "SELECT agent_id, kind, account, reason FROM blockers ORDER BY agent_id, kind")
	out.Agents = dumpRows(t, l, "SELECT id, name, lifecycle, forwarded_to, harness, model, effort FROM agents ORDER BY name")
	if pred, err := l.db.GetAgent(l.ctx, c.Agent); err == nil {
		out.Queued = dumpRows(t, l, "SELECT data FROM events WHERE agent_id = '"+pred.ID+"' AND type = 'notice:queued' ORDER BY id")
	}
	out.Notices = dumpRows(t, l, "SELECT id, acked_by FROM cost_notices ORDER BY id")
	return out
}

// freshSwitchHome empties the tables a switch reads and writes, makes the case's folder, and runs its fixture there.
func (l *live) freshSwitchHome(name string, sql []string) string {
	l.t.Helper()
	l.costNoticesTable()
	for _, tb := range []string{"agents", "agent_parents", "mail", "mail_recipients", "mail_deliveries", "thread_archive", "thread_archive_mail", "itsas",
		"itsa_participants", "workspace_grants", "events", "blockers", "waits", "cost_notices"} {
		l.exec("DELETE FROM " + tb)
	}
	work := filepath.Join(l.base, "work", name)
	if err := os.MkdirAll(work, 0o700); err != nil {
		l.t.Fatal(err)
	}
	l.t.Setenv("GIT_CEILING_DIRECTORIES", filepath.Dir(work))
	for _, q := range sql {
		l.exec(strings.ReplaceAll(q, "{{work}}", work))
	}
	return work
}

// costNoticesTable makes the cost_notices table, as the first notice would.
func (l *live) costNoticesTable() {
	l.t.Helper()
	if _, err := l.db.OpenCostNotices(l.ctx); err != nil {
		l.t.Fatal(err)
	}
}

var flowSucc = regexp.MustCompile(`"(worker-t\d+)"`)

// normalizeFlow maps the successor's id (the agent named worker-tN that the fixture didn't make) to SUCC, the case
// folder to WORK, and every stamp but the fixture's to NOW.
func normalizeFlow(o flowOut) flowOut {
	succ := ""
	for _, r := range o.Agents {
		var cols []any
		if json.Unmarshal([]byte(r), &cols) == nil && len(cols) > 1 {
			if id, _ := cols[0].(string); id != "alnx1" && flowSucc.MatchString(`"`+fmt.Sprint(cols[1])+`"`) {
				succ = id
			}
		}
	}
	norm := func(s string) string {
		if succ != "" {
			s = strings.ReplaceAll(s, succ, "SUCC")
		}
		if o.Work != "" {
			s = strings.ReplaceAll(s, o.Work, "WORK")
		}
		return switchStamp.ReplaceAllStringFunc(s, func(t string) string {
			if strings.HasPrefix(t, "2026-01-0") {
				return t
			}
			return "NOW"
		})
	}
	each := func(rows []string) []string {
		out := make([]string, len(rows))
		for i, r := range rows {
			out[i] = norm(r)
		}
		return out
	}
	out := flowOut{Events: each(o.Events), Blockers: each(o.Blockers), Agents: each(o.Agents), Queued: each(o.Queued), Notices: each(o.Notices)}
	if o.Error != nil {
		e := norm(*o.Error)
		out.Error = &e
	}
	// The result in Go's key order: TS's is the same object, so a re-marshal of its decoded form compares them.
	var r any
	if len(o.Result) > 0 && json.Unmarshal(o.Result, &r) == nil {
		b, _ := json.Marshal(r)
		out.Result = json.RawMessage(norm(string(b)))
	}
	sort.Strings(out.Blockers)
	return out
}

// switchOpts is a fast switch of worker by mgr to cheap.
func switchOpts(soft float64) SwitchOptions {
	return SwitchOptions{Agent: "worker", Preset: "cheap", By: "almg1", SoftStopMinutes: &soft, Poll: 20 * time.Millisecond}
}

// steps is the cost:switch steps of the agent, in order.
func (l *live) steps(id string) []string {
	l.t.Helper()
	var out []string
	for _, d := range l.events(id, "cost:switch") {
		var e struct {
			Step string `json:"step"`
		}
		_ = json.Unmarshal([]byte(d), &e)
		out = append(out, e.Step)
	}
	return out
}

// runningWorker spawns the predecessor (alwk1, worker) under mgr with a live fake Claude Code.
func (l *live) runningWorker() db.Agent {
	l.t.Helper()
	l.costNoticesTable()
	for _, q := range switchOrgSQL(nil)[:3] {
		l.exec(strings.ReplaceAll(q, "{{work}}", l.work))
	}
	l.spawn("alwk1", "almg1")
	l.exec("UPDATE agents SET name = 'worker', activity = 'idle' WHERE id = 'alwk1'")
	return l.agent("alwk1")
}

// TestSwitchCrashAtEachStep: a daemon that dies at each step of a switch (the switch's goroutine ends there, as a crash
// leaves it: no rollback) and the next start's resumeSwitches. A switch cut in its soft stop (quiesce, interrupt) is
// re-armed and finishes with what is left of its deadline; one cut before it (start) never changed anything. One cut
// after the stop is left where it was, as TS leaves it (S-3690): the predecessor stays shut down, held by the
// taken-over blocker once that is set, and a successor already made isn't launched again.
func TestSwitchCrashAtEachStep(t *testing.T) {
	type expect struct {
		resumed bool
		// pred is the predecessor's lifecycle after the restart's resumeSwitches settled; succ whether a successor exists,
		// and live whether its terminal runs.
		pred       string
		succ, live bool
		blocker    string
	}
	for _, tc := range []struct {
		step    string
		working bool
		want    expect
	}{
		{"start", false, expect{pred: "active"}},
		{"quiesce", false, expect{resumed: true, pred: "shut_down", succ: true, live: true, blocker: "taken over by worker-t2 on preset cheap"}},
		{"interrupt", true, expect{resumed: true, pred: "shut_down", succ: true, live: true, blocker: "taken over by worker-t2 on preset cheap"}},
		{"stopped", false, expect{pred: "shut_down"}},
		{"blocked", false, expect{pred: "shut_down", blocker: "mgr is moving its work to preset cheap"}},
		{"moved", false, expect{pred: "shut_down", succ: true, blocker: "mgr is moving its work to preset cheap"}},
		{"launched", false, expect{pred: "shut_down", succ: true, live: true, blocker: "mgr is moving its work to preset cheap"}},
	} {
		t.Run(tc.step, func(t *testing.T) {
			l := newSwitchLive(t)
			l.runningWorker()
			if tc.working {
				l.set("alwk1", db.Field{Col: "activity", Val: "working"})
			}
			crashed := make(chan struct{})
			l.life.switchAt = func(id, step string) {
				if step == tc.step {
					close(crashed)
					runtime.Goexit()
				}
			}
			go func() { _, _ = l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003))) }()
			<-crashed
			// The restart: a new lifecycle over the same database and tmux server, with nothing of the old one in memory.
			life := l.restart()
			resumed := life.ResumeSwitches(l.ctx)
			if got := len(resumed) == 1; got != tc.want.resumed {
				t.Fatalf("resumed %v, want %v", resumed, tc.want.resumed)
			}
			if tc.want.resumed {
				l.until("the resumed switch to finish", func() bool { return contains(l.steps("alwk1"), "done") })
			} else {
				time.Sleep(200 * time.Millisecond)
				if again := life.ResumeSwitches(l.ctx); len(again) != 0 {
					t.Fatalf("a second start resumed %v", again)
				}
			}
			pred := l.agent("alwk1")
			if string(pred.Lifecycle) != tc.want.pred {
				t.Errorf("predecessor %s, want %s", pred.Lifecycle, tc.want.pred)
			}
			succ, err := l.db.GetAgent(l.ctx, "worker-t2")
			if (err == nil) != tc.want.succ {
				t.Fatalf("successor %v, want %v", err == nil, tc.want.succ)
			}
			if err == nil && l.tmux.HasSession(l.ctx, succ.ID) != tc.want.live {
				t.Errorf("successor's terminal %v, want %v", !tc.want.live, tc.want.live)
			}
			if err == nil && l.countEvents(succ.ID, "spawn") > 1 {
				t.Errorf("the successor launched %d times", l.countEvents(succ.ID, "spawn"))
			}
			reason := l.query("SELECT reason FROM blockers WHERE agent_id = 'alwk1' AND kind = 'taken-over'")
			if reason != tc.want.blocker {
				t.Errorf("blocker %q, want %q", reason, tc.want.blocker)
			}
			if tc.want.resumed && l.countEvents("alwk1", "spawn") != 1 {
				t.Errorf("the predecessor launched %d times", l.countEvents("alwk1", "spawn"))
			}
		})
	}
}

// plan is CheckSwitch's plan, or the test fails.
func (l *live) plan(o SwitchOptions) SwitchPlan {
	l.t.Helper()
	p, err := l.life.CheckSwitch(l.ctx, o, false)
	if err != nil {
		l.t.Fatal(err)
	}
	return p
}

// restart is a new lifecycle over the test's database and tmux server, as a daemon restart makes, with the test's
// successor ids and cost mail.
func (l *live) restart() *Lifecycle {
	l.t.Helper()
	life := New(l.ctx, l.opts)
	life.successorID = l.life.successorID
	life.SetCostMail(l.costs.send, l.costs.withdraw)
	l.t.Cleanup(life.Wait)
	l.restartedMu.Lock()
	l.restarted = append(l.restarted, life)
	l.restartedMu.Unlock()
	return life
}

// lifecycles is the test's first lifecycle and every one restart made after it, read under restartedMu.
func (l *live) lifecycles() []*Lifecycle {
	l.restartedMu.Lock()
	defer l.restartedMu.Unlock()
	return append([]*Lifecycle{l.life}, l.restarted...)
}

// TestSwitchResumesWithWhatIsLeft: a restart re-arms each switch cut in its soft stop with its own deadline, so the one
// whose deadline is later waits for it; one that finished or never quiesced is left alone. As test/cost-switch.test.mjs's
// restart tests.
func TestSwitchResumesWithWhatIsLeft(t *testing.T) {
	l := newSwitchLive(t)
	l.freshSwitchHome("left", append(switchOrgSQL(map[string]string{"activity": "'working'"}),
		agentSQL("alwl1", "later", map[string]string{"parent_id": "'almg1'", "harness": "'claude'", "activity": "'working'", "session_id": "'sess-l'"}),
		agentSQL("aldn1", "finished", map[string]string{"parent_id": "'almg1'", "harness": "'claude'"}),
		agentSQL("alnv1", "never", map[string]string{"parent_id": "'almg1'", "harness": "'claude'"})))
	at := func(d time.Duration) string { return iso(time.Now().Add(d)) }
	for _, e := range []struct {
		id, data string
	}{
		{"alwk1", `{"step":"start","by":"almg1","preset":"cheap"}`},
		{"alwk1", `{"step":"quiesce","minutes":10,"deadline":"` + at(150*time.Millisecond) + `","preset":"cheap","by":"almg1"}`},
		{"alwl1", `{"step":"start","by":"almg1","preset":"cheap"}`},
		{"alwl1", `{"step":"quiesce","minutes":10,"deadline":"` + at(2500*time.Millisecond) + `","preset":"cheap","by":"almg1"}`},
		{"aldn1", `{"step":"quiesce","minutes":10,"deadline":"` + at(-time.Second) + `","preset":"cheap","by":"almg1"}`},
		{"aldn1", `{"step":"done","to":"finished-t2"}`},
		{"alnv1", `{"step":"start","by":"almg1","preset":"cheap"}`},
	} {
		l.exec("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'cost:switch', ?)", e.id, iso(time.Now()), e.data)
	}
	resumed := l.life.ResumeSwitches(l.ctx)
	sort.Strings(resumed)
	if strings.Join(resumed, ",") != "later,worker" {
		t.Fatalf("resumed %v", resumed)
	}
	l.until("the first switch", func() bool { _, err := l.db.GetAgent(l.ctx, "worker-t2"); return err == nil })
	if _, err := l.db.GetAgent(l.ctx, "later-t2"); err == nil {
		t.Fatal("the second switch didn't wait for its own, later deadline")
	}
	l.until("the second switch", func() bool { _, err := l.db.GetAgent(l.ctx, "later-t2"); return err == nil })
	var quiesces []float64
	for _, d := range l.events("alwl1", "cost:switch") {
		var q struct {
			Step    string  `json:"step"`
			Minutes float64 `json:"minutes"`
		}
		if json.Unmarshal([]byte(d), &q) == nil && q.Step == "quiesce" {
			quiesces = append(quiesces, q.Minutes)
		}
	}
	if len(quiesces) != 2 || quiesces[1] <= 0 || quiesces[1] > 2500.0/60000 {
		t.Errorf("the re-armed quiesce has %v minutes left", quiesces)
	}
	for _, id := range []string{"aldn1", "alnv1"} {
		if a := l.agent(id); a.Lifecycle != "active" || a.ForwardedTo != nil {
			t.Errorf("%s was touched: %s", id, a.Lifecycle)
		}
	}
}

// TestSwitchRollbackResumesPredecessor: a successor whose harness exits during its startup fails the switch; the move
// is undone, the successor forgotten, the taken-over blocker gone, and the predecessor, which ran, is resumed once on
// its own session and told why (cost-switch-failed.md). Its lock is held through that resume: a resume asked meanwhile
// is refused.
func TestSwitchRollbackResumesPredecessor(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	l.exec("INSERT INTO mail (id, from_id, subject, body, created_at, thread_id) VALUES ('mun1', 'almg1', 'More', 'more', ?, 'mun1')", t0)
	l.exec("INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('mun1', 'alwk1')")
	if err := os.WriteFile(filepath.Join(l.base, "exit-als11"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var refused error
	l.life.switchAt = func(id, step string) {
		if step == "blocked" {
			// Queued while it is stopped, so it waits in its queue and moves with the switch.
			l.life.QueueRingNotice(l.ctx, "alwk1", "Ring turn: swarm the widget")
		}
		if step == "moved" {
			_, refused = l.life.Resume(l.ctx, l.agent("alwk1"), "")
		}
	}
	_, err := l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003)))
	if err == nil || !strings.HasPrefix(err.Error(), "switching worker to cheap failed, and worker was restored: ") {
		t.Fatalf("switch: %v", err)
	}
	if refused == nil || !strings.Contains(refused.Error(), "worker is being switched") {
		t.Errorf("a resume during the switch: %v", refused)
	}
	if _, err := l.db.GetAgent(l.ctx, "worker-t2"); err == nil {
		t.Error("the successor is still there")
	}
	pred := l.agent("alwk1")
	if pred.Lifecycle != "active" || pred.ForwardedTo != nil {
		t.Errorf("predecessor %s, forwarded %v", pred.Lifecycle, pred.ForwardedTo)
	}
	if rows := l.blockerRows("alwk1"); len(rows) != 0 {
		t.Errorf("blockers %+v", rows)
	}
	if l.query("SELECT agent_id FROM mail_recipients WHERE mail_id = 'mun1'") != "alwk1" {
		t.Error("the unread mail didn't come back")
	}
	if n := l.countEvents("alwk1", "resume"); n != 1 {
		t.Errorf("resumed %d times", n)
	}
	l.until("the predecessor's resume prompt", func() bool {
		b, _ := os.ReadFile(filepath.Join(l.base, "typed"))
		return strings.Contains(string(b), "the switch failed, so you continue yourself")
	})
	// The ring turn came back with it: queued, or typed by its resume.
	l.until("the ring turn back", func() bool {
		b, _ := os.ReadFile(filepath.Join(l.base, "typed"))
		return contains(l.life.Notices("alwk1"), "Ring turn: swarm the widget") || strings.Contains(string(b), "swarm the widget")
	})
	if st := l.steps("alwk1"); st[len(st)-1] != "rolled-back" {
		t.Errorf("steps %v", st)
	}
	// The name is free again, and the lock released.
	if p := l.plan(switchOpts(0.003)); p.Successor != "worker-t2" {
		t.Errorf("next successor %s", p.Successor)
	}
	release, err := l.life.acquire(l.agent("alwk1"), "resume")
	if err != nil {
		t.Fatalf("the lock: %v", err)
	}
	release()
}

// TestSwitchRollbackLeftShutDown: a predecessor that can't be resumed after a failed switch stays shut down, and the
// error says so with the resume's reason.
func TestSwitchRollbackLeftShutDown(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	if err := os.WriteFile(filepath.Join(l.base, "exit-als11"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	l.life.switchAt = func(id, step string) {
		if step == "moved" {
			l.set("alwk1", db.Field{Col: "session_id", Val: nil})
		}
	}
	_, err := l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003)))
	if err == nil || !strings.Contains(err.Error(), "and worker was left shut down (worker has no session to resume): ") {
		t.Fatalf("switch: %v", err)
	}
	if l.agent("alwk1").Lifecycle != "shut_down" || len(l.events("alwk1", "cost:switch-resume-error")) != 1 {
		t.Errorf("predecessor %s, resume errors %v", l.agent("alwk1").Lifecycle, l.events("alwk1", "cost:switch-resume-error"))
	}
}

// TestSwitchStartupTimeout: a successor that never takes its prompt within the startup time is rolled back.
func TestSwitchStartupTimeout(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	if err := os.WriteFile(filepath.Join(l.base, "hold-box"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(filepath.Join(l.base, "hold-box")) })
	o := switchOpts(0.003)
	o.Startup = 600 * time.Millisecond
	_, err := l.life.CostSwitch(l.ctx, o, l.plan(o))
	if err == nil || !strings.HasSuffix(err.Error(), "worker-t2 didn't start within 1 s") {
		t.Fatalf("switch: %v", err)
	}
	if _, err := l.db.GetAgent(l.ctx, "worker-t2"); err == nil {
		t.Error("the successor is still there")
	}
	if l.tmux.HasSession(l.ctx, "als11") {
		t.Error("the successor's terminal still runs")
	}
}

// TestSwitchNoDoubleLaunch: two switches of one agent asked at once make one successor: the lock is taken before
// either answers, so exactly one answers quiescing and the other is refused as already being switched, as TS's second
// caller is. A resumeSwitches while it runs skips it; and a restart's resumeSwitches run twice re-arms the switch once.
func TestSwitchNoDoubleLaunch(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	l.set("alwk1", db.Field{Col: "activity", Val: "working"})
	soft := 0.01
	o := switchOpts(soft)
	var wg sync.WaitGroup
	results := make([]any, 2)
	errs := make([]error, 2)
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = l.life.StartSwitch(l.ctx, o)
		}()
	}
	wg.Wait()
	refusals := 0
	for i, err := range errs {
		if err != nil {
			refusals++
			if err.Error() != "worker is already being switched" {
				t.Errorf("refusal %v", err)
			}
		} else if q, ok := results[i].(Quiescing); !ok || q.To != "worker-t2" {
			t.Errorf("answer %+v", results[i])
		}
	}
	if refusals != 1 {
		t.Fatalf("%d refused, want 1: %v", refusals, errs)
	}
	if again := l.life.ResumeSwitches(l.ctx); len(again) != 0 {
		t.Errorf("resumed a running switch: %v", again)
	}
	l.until("the switch", func() bool { return contains(l.steps("alwk1"), "done") })
	if n := l.query("SELECT COUNT(*) FROM agents WHERE name LIKE 'worker-t%'"); n != "1" {
		t.Errorf("%s successors", n)
	}
	if n := l.query("SELECT COUNT(*) FROM events WHERE type = 'spawn' AND agent_id IN (SELECT id FROM agents WHERE name LIKE 'worker-t%')"); n != "1" {
		t.Errorf("%s successor launches", n)
	}
	// The resumeSwitches beside it skipped it outright: its check never ran, so no resume-failed step.
	if contains(l.steps("alwk1"), "resume-failed") {
		t.Errorf("steps %v", l.steps("alwk1"))
	}

	// A switch cut in its soft stop, re-armed by a restart whose start runs resumeSwitches twice.
	l2 := newSwitchLive(t)
	l2.runningWorker()
	l2.set("alwk1", db.Field{Col: "activity", Val: "working"})
	crashed := make(chan struct{})
	l2.life.switchAt = func(id, step string) {
		if step == "quiesce" {
			close(crashed)
			runtime.Goexit()
		}
	}
	go func() { _, _ = l2.life.CostSwitch(l2.ctx, switchOpts(0.01), l2.plan(switchOpts(0.01))) }()
	<-crashed
	life := l2.restart()
	first, second := life.ResumeSwitches(l2.ctx), life.ResumeSwitches(l2.ctx)
	if len(first) != 1 || len(second) != 0 {
		t.Fatalf("resumed %v then %v", first, second)
	}
	l2.until("the re-armed switch", func() bool { return contains(l2.steps("alwk1"), "done") })
	if n := l2.query("SELECT COUNT(*) FROM agents WHERE name LIKE 'worker-t%'"); n != "1" {
		t.Errorf("%s successors", n)
	}
}

// TestSwitchStartedAgainDuringStop: an agent started again between the stop and the move fails the switch, nothing
// moves, and its rollback's resume finds it running, so it is left as it is and the error says so.
func TestSwitchStartedAgainDuringStop(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	started := make(chan struct{})
	l.life.switchAt = func(id, step string) {
		if step == "stopped" {
			// Outside the serial the stop holds, as a resume racing the switch's lock would.
			go func() {
				defer close(started)
				_ = l.life.StartHarness(l.ctx, l.agent("alwk1"), "", true, "resume")
			}()
			l.until("the predecessor to run again", func() bool { return l.tmux.HasSession(l.ctx, "alwk1") && l.agent("alwk1").Lifecycle == "active" })
		}
	}
	_, err := l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003)))
	<-started
	if err == nil || !strings.Contains(err.Error(), "worker was left shut down (worker is active): worker was started again during the stop") {
		t.Fatalf("switch: %v", err)
	}
	if _, err := l.db.GetAgent(l.ctx, "worker-t2"); err == nil {
		t.Error("a successor was made")
	}
	if len(l.blockerRows("alwk1")) != 0 {
		t.Error("the taken-over blocker stayed")
	}
}

// TestSwitchTargetChangedDuringQuiesce: a preset whose target changes while the agent finishes its step refuses the
// move, and the stopped predecessor is resumed.
func TestSwitchTargetChangedDuringQuiesce(t *testing.T) {
	cheap := func(fields string) string {
		return `{"presets":{"cheap":{"harness":"claude"` + fields + `}}}`
	}
	for _, tc := range []struct{ name, before, after string }{
		{"model", cheap(`,"model":"cheap-model"`), cheap(`,"model":"dearer-model"`)},
		// An empty string is a model, unlike none.
		{"model set empty", cheap(``), cheap(`,"model":""`)},
		{"effort", cheap(`,"model":"m","effort":"low"`), cheap(`,"model":"m","effort":"high"`)},
		{"effort set empty", cheap(`,"model":"m"`), cheap(`,"model":"m","effort":""`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l := newSwitchLive(t)
			l.writeRegistry(tc.before)
			l.runningWorker()
			l.set("alwk1", db.Field{Col: "activity", Val: "working"})
			l.life.switchAt = func(id, step string) {
				if step == "quiesce" {
					l.writeRegistry(tc.after)
				}
			}
			_, err := l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003)))
			if err == nil || !strings.Contains(err.Error(), "was restored: the target of cheap changed while worker finished its step") {
				t.Fatalf("switch: %v", err)
			}
			if l.agent("alwk1").Lifecycle != "active" {
				t.Errorf("predecessor %s", l.agent("alwk1").Lifecycle)
			}
		})
	}
}

// TestSwitchBlockerResumeRefused: a blocker clear's resume while the switch holds the agent is refused with the
// switch's name, so the predecessor never runs beside its successor.
func TestSwitchBlockerResumeRefused(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	var refused error
	l.life.switchAt = func(id, step string) {
		if step == "start" {
			l.set("alwk1", db.Field{Col: "lifecycle", Val: "paused"})
			_, refused = l.life.resumeNow(l.ctx, "alwk1", "go on")
			l.set("alwk1", db.Field{Col: "lifecycle", Val: "active"})
		}
	}
	if _, err := l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003))); err != nil {
		t.Fatal(err)
	}
	if refused == nil || refused.Error() != "worker is being switched; try again when it is done" {
		t.Errorf("resume: %v", refused)
	}
	if n := l.countEvents("alwk1", "spawn") + l.countEvents("alwk1", "resume"); n != 1 {
		t.Errorf("predecessor launched %d times", n)
	}
}

// TestSwitchHeldSuccessor: a successor in a tree paused for cost starts held: its takeover prompt waits as an idle
// notice, and the switch is done once it is up.
func TestSwitchHeldSuccessor(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	until := iso(time.Now().Add(time.Hour))
	l.pause(PauseOptions{Root: "almg1", By: humanID, Until: &until})
	// A held successor's launch has no prompt to type: its session start would make it idle.
	stop, polled := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(polled)
		for {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
			}
			if s, err := l.db.GetAgent(l.ctx, "worker-t2"); err == nil && s.Activity == "starting" && l.tmux.HasSession(l.ctx, s.ID) {
				_ = l.db.UpdateAgent(l.ctx, s.ID, db.Field{Col: "activity", Val: "idle"})
			}
		}
	}()
	defer func() {
		close(stop)
		<-polled
	}()
	if _, err := l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003))); err != nil {
		t.Fatal(err)
	}
	s := l.agent("worker-t2")
	if s.Lifecycle != "paused" {
		t.Errorf("successor %s", s.Lifecycle)
	}
	if n := l.life.Notices(s.ID); len(n) != 1 || !strings.Contains(n[0], "taking over the work of worker") {
		t.Errorf("notices %q", n)
	}
	// Its launch had no prompt to hold: the switch queued it.
	if n := l.countEvents(s.ID, "launch-held"); n != 0 {
		t.Errorf("%d held launches", n)
	}
}

// TestSwitchRingTurnsMove: a ring turn queued to the predecessor moves to the successor, once, and the predecessor's
// other notices stay (S-2490).
func TestSwitchRingTurnsMove(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	l.life.QueueRingNotice(l.ctx, "alwk1", "Ring turn: swarm the widget")
	l.life.QueueNotice(l.ctx, "alwk1", "a plain notice", false)
	if _, err := l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003))); err != nil {
		t.Fatal(err)
	}
	s := l.agent("worker-t2")
	ring := 0
	for _, n := range l.life.Notices(s.ID) {
		if n == "Ring turn: swarm the widget" {
			ring++
		}
	}
	if ring != 1 {
		t.Errorf("successor notices %q", l.life.Notices(s.ID))
	}
	if n := l.life.Notices("alwk1"); len(n) != 1 || n[0] != "a plain notice" {
		t.Errorf("predecessor notices %q", n)
	}
}

// TestSwitchHandOffAndLive: the ITSA home hand-off runs once with the predecessor and its successor, and the live stream
// hears of the new agent. The manager's mail goes out in the background (deliverCost's goBG), so the test holds it
// until CostSwitch returned, the order a loaded machine can give it (S-4044), and waits for that work to end.
func TestSwitchHandOffAndLive(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	l.life.SetCostMail(func(ctx context.Context, name string, to []string, subject, body string) (string, bool) {
		select {
		case <-release:
		case <-ctx.Done():
		}
		return l.costs.send(ctx, name, to, subject, body)
	}, l.costs.withdraw)
	var got []string
	l.life.SetSwitchedItsas(func(_ context.Context, from, to db.Agent) {
		got = append(got, from.Name+">"+to.Name+":"+deref(from.ForwardedTo))
	})
	rec := &liveRecorder{}
	l.life.live = rec
	if _, err := l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003))); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "worker>worker-t2:als11" {
		t.Errorf("hand-offs %v", got)
	}
	if e := rec.of("agent.spawned"); len(e) != 1 || e[0] != `{"id":"als11","name":"worker-t2","parent_id":"almg1"}` {
		t.Errorf("agent.spawned %v", e)
	}
	once.Do(func() { close(release) })
	l.until("the cost mail sent", func() bool { return l.life.bgRunning.Load() == 0 })
	told := 0
	for _, m := range l.costs.mails() {
		if strings.HasPrefix(m, "almg1|[stam] worker now continues as worker-t2 on cheap|") {
			told++
		}
	}
	if told != 1 {
		t.Errorf("cost mail %q", l.costs.mails())
	}
}

type liveRecorder struct {
	mu     sync.Mutex
	events []string
}

func (r *liveRecorder) Emit(event string, data any) error {
	b, _ := json.Marshal(data)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event+" "+string(b))
	return nil
}

func (r *liveRecorder) AgentChanged(string, *jsjson.Object) {}

func (r *liveRecorder) of(event string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, e := range r.events {
		if rest, ok := strings.CutPrefix(e, event+" "); ok {
			out = append(out, rest)
		}
	}
	return out
}

// TestSwitchCheckGoOnly: the refusals the TS comparison can't make: a preset on Codex (TS launches it; the Go daemon
// can't yet, S-3687) and a second switch of an agent being switched.
func TestSwitchCheckGoOnly(t *testing.T) {
	l := newSwitchLive(t)
	l.freshSwitchHome("check", switchOrgSQL(nil))
	_, err := l.life.CheckSwitch(l.ctx, SwitchOptions{Agent: "worker", Preset: "codexy", By: "almg1"}, false)
	if err == nil || err.Error() != "preset codexy runs codex, which the Go daemon can't launch yet; switch with the TypeScript daemon" {
		t.Errorf("codex: %v", err)
	}
	l.life.setSwitching("alwk1", true)
	if _, err := l.life.CheckSwitch(l.ctx, switchOpts(1), false); err == nil || err.Error() != "worker is already being switched" {
		t.Errorf("switching: %v", err)
	}
	if _, err := l.life.CheckSwitch(l.ctx, switchOpts(1), true); err != nil {
		t.Errorf("the re-check: %v", err)
	}
	if _, err := l.life.CheckSwitch(l.ctx, SwitchOptions{Agent: "worker", Preset: "cheap", By: "alst1"}, false); !IsForbidden(err) {
		t.Errorf("stranger: %v", err)
	}
}

// TestSwitchHandoverStatError (review of #1162): a HANDOVER.md that can't be stat'ed, here under a cwd that is a file,
// counts as none, as existsSync has it: the brief is generated.
func TestSwitchHandoverStatError(t *testing.T) {
	l := newSwitchLive(t)
	file := filepath.Join(l.base, "not-a-folder")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	l.freshSwitchHome("stat", switchOrgSQL(map[string]string{"cwd": "'" + file + "'"}))
	text, isFile, err := l.life.handoverOf(l.ctx, l.agent("alwk1"))
	if err != nil || isFile || !strings.HasPrefix(text, "Generated by stam: worker left no HANDOVER.md") {
		t.Fatalf("handover %q, %v, %v", text, isFile, err)
	}
}

// TestSwitchInterruptClaude: the Claude interrupt never touches an idle input, never types i, and ignores old
// scrollback; an Esc that brings a new "Interrupted" line confirms it. The pane echoes keys (cat -v), so stray ones show.
func TestSwitchInterruptClaude(t *testing.T) {
	l := newSwitchLive(t)
	l.freshSwitchHome("interrupt", switchOrgSQL(nil))
	screen := func(text string) {
		_ = l.tmux.KillSession(l.ctx, "alwk1")
		script := filepath.Join(l.base, "screen.sh")
		if err := os.WriteFile(script, []byte("printf '"+text+"'; stty -icanon -echo; exec cat -v\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := l.tmux.NewSession(l.ctx, "alwk1", l.work, tmux.Env{}, []string{"sh", script}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(300 * time.Millisecond)
	}
	pane := func() string { s, _ := l.tmux.CapturePane(l.ctx, "alwk1"); return s }
	interrupt := func() bool {
		ok, err := l.life.interrupt(l.ctx, l.agent("alwk1"))
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	screen(`⎿  Interrupted · What should Claude do instead?\n✶ Blanching… (13s · ↓ 4 tokens)\n-- INSERT --\n`)
	if interrupt() || strings.Contains(pane(), "^[") {
		t.Fatal("an idle agent got an Esc")
	}
	l.set("alwk1", db.Field{Col: "activity", Val: "working"})
	if interrupt() {
		t.Error("the old Interrupted line confirmed it")
	}
	typed := strings.Join(strings.Split(pane(), "\n")[3:], "")
	if strings.Count(typed, "^[") != 2 || strings.Contains(strings.ReplaceAll(typed, "^[", ""), "i") {
		t.Errorf("typed %q", typed)
	}
	screen(`-- INSERT --\n`)
	if interrupt() || strings.Contains(pane(), "^[") {
		t.Error("no spinner, but an Esc")
	}
	// Another harness has no interrupt here: no key goes in.
	screen(`✶ Blanching… (13s · ↓ 4 tokens)\n`)
	l.exec("UPDATE agents SET harness = 'codex' WHERE id = 'alwk1'")
	if interrupt() || strings.Contains(pane(), "^[") {
		t.Error("a codex agent got an Esc")
	}
	l.exec("UPDATE agents SET harness = 'claude' WHERE id = 'alwk1'")
	// Without vim's INSERT mode one Esc stops the turn: no second one.
	screen(`✶ Blanching… (13s · ↓ 4 tokens)\n`)
	if interrupt() {
		t.Error("nothing confirmed it")
	}
	if typed := strings.Join(strings.Split(pane(), "\n")[1:], ""); strings.Count(typed, "^[") != 1 {
		t.Errorf("typed %q", typed)
	}
	// A turn that takes the Esc: the pane reads one key, then shows Claude Code's line for it.
	_ = l.tmux.KillSession(l.ctx, "alwk1")
	script := filepath.Join(l.base, "takes.sh")
	if err := os.WriteFile(script, []byte("printf '✶ Working… (3s)\\n'; stty -icanon -echo; dd bs=1 count=1 >/dev/null 2>&1; printf '⎿  Interrupted · ok\\n'; exec cat -v\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := l.tmux.NewSession(l.ctx, "alwk1", l.work, tmux.Env{}, []string{"sh", script}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if !interrupt() {
		t.Error("a new Interrupted line didn't confirm it")
	}
	_ = l.tmux.KillSession(l.ctx, "alwk1")
}

// TestResumeSwitchesMatchesTS: which switches a daemon start re-arms, and the ones whose check now refuses (each a
// resume-failed step), compared with src/cost-switch.ts resumeSwitches (testdata/resumeref.mjs) over agents whose last
// cost:switch step is each one a switch writes: only the quiesce and the interrupt re-arm, and only for an agent that
// isn't archived or taken over, with a quiesce that names its preset, manager and deadline among its last 500 events.
func TestResumeSwitchesMatchesTS(t *testing.T) {
	ev := func(id, data string) string {
		return "INSERT INTO events (agent_id, ts, type, data) VALUES ('" + id + "', '" + t0 + "', 'cost:switch', '" + data + "')"
	}
	q := func(id, by, preset string) string {
		return ev(id, `{"step":"quiesce","minutes":10,"deadline":"2099-01-01T00:00:00.000Z","preset":"`+preset+`","by":"`+by+`"}`)
	}
	sql := []string{
		agentSQL("alco1", "cos", map[string]string{"harness": "'claude'"}),
		agentSQL("almg1", "mgr", map[string]string{"parent_id": "'alco1'", "harness": "'claude'"}),
		agentSQL("alst1", "stranger", map[string]string{"harness": "'claude'"}),
	}
	agent := func(id, name string, cols map[string]string, events ...string) {
		c := map[string]string{"parent_id": "'almg1'", "harness": "'claude'", "cwd": "'/nowhere/" + name + "'"}
		for k, v := range cols {
			c[k] = v
		}
		sql = append(sql, agentSQL(id, name, c))
		sql = append(sql, events...)
	}
	agent("alq1", "quiesced", nil, ev("alq1", `{"step":"start","by":"almg1","preset":"cheap"}`), q("alq1", "almg1", "cheap"))
	agent("ali1", "interrupted", nil, q("ali1", "almg1", "cheap"), ev("ali1", `{"step":"interrupt","confirmed":false}`))
	agent("als1", "stopped", nil, q("als1", "almg1", "cheap"), ev("als1", `{"step":"stopped","was":"active"}`))
	agent("ald1", "done", nil, q("ald1", "almg1", "cheap"), ev("ald1", `{"step":"done","to":"done-t2"}`))
	agent("alrb1", "rolled", nil, q("alrb1", "almg1", "cheap"), ev("alrb1", `{"step":"rolled-back","error":"x"}`))
	agent("alrf1", "refailed", nil, q("alrf1", "almg1", "cheap"), ev("alrf1", `{"step":"resume-failed","error":"x"}`))
	agent("aln1", "never", nil)
	agent("alar1", "archived", map[string]string{"lifecycle": "'archived'"}, q("alar1", "almg1", "cheap"))
	agent("alfw1", "forwarded", map[string]string{"forwarded_to": "'almg1'"}, q("alfw1", "almg1", "cheap"))
	agent("alnp1", "unnamed", nil, ev("alnp1", `{"step":"quiesce","minutes":10,"deadline":"2099-01-01T00:00:00.000Z","by":"almg1"}`))
	agent("albp1", "badpreset", nil, q("albp1", "almg1", "nope"))
	agent("alfb1", "forbidden", nil, q("alfb1", "alst1", "cheap"))
	agent("alod1", "old", nil, q("alod1", "almg1", "cheap"),
		"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) INSERT INTO events (agent_id, ts, type, data) SELECT 'alod1', '"+t0+"', 'hook:x', NULL FROM n")
	agent("alin1", "interrupt-only", nil, ev("alin1", `{"step":"interrupt","confirmed":true}`))
	// Two quiesces: the newer one names the switch under way, not the older one's preset.
	agent("altw1", "twice", nil, q("altw1", "almg1", "nope"), ev("altw1", `{"step":"rolled-back","error":"x"}`), q("altw1", "almg1", "cheap"))
	agent("alnd1", "nodeadline", nil, ev("alnd1", `{"step":"quiesce","minutes":10,"preset":"cheap","by":"almg1"}`))
	in, err := json.Marshal(sql)
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd := exec.Command("node", "--no-warnings", "testdata/resumeref.mjs", string(in), switchRunSettings, switchRunRegistry)
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("resumeref.mjs: %v\n%s", err, stderr.String())
	}
	var want struct {
		Resumed []string `json:"resumed"`
		Failed  []string `json:"failed"`
	}
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("resumeref.mjs output %q: %v", raw, err)
	}
	// The fixture's own resume-failed step, then the two refusals.
	if strings.Join(want.Resumed, ",") != "quiesced,interrupted,twice" || len(want.Failed) != 3 {
		t.Fatalf("TS resumed %v and failed %v: the fixture doesn't cover what it should", want.Resumed, want.Failed)
	}
	l := newSwitchLive(t)
	l.freshSwitchHome("resume", sql)
	// The re-armed switches stop at their start: only the choice is compared.
	l.life.switchAt = func(id, step string) {
		if step == "start" {
			runtime.Goexit()
		}
	}
	resumed := l.life.ResumeSwitches(l.ctx)
	failed := strings.Split(l.query("SELECT agent_id || '|' || data FROM events WHERE type = 'cost:switch' AND json_extract(data, '$.step') = 'resume-failed' ORDER BY id"), "\n")
	if a, b := strings.Join(resumed, ","), strings.Join(want.Resumed, ","); a != b {
		t.Errorf("resumed:\nGo: %s\nTS: %s", a, b)
	}
	if a, b := strings.Join(failed, "\n"), strings.Join(want.Failed, "\n"); a != b {
		t.Errorf("failed:\nGo:\n%s\nTS:\n%s", a, b)
	}
}

// TestSwitchTurnEndsInTime: a working agent that ends its turn within the soft stop isn't interrupted: the switch
// waited, no interrupt step is written, and the wrap-up request leaves its queue while its other notices stay.
func TestSwitchTurnEndsInTime(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	l.set("alwk1", db.Field{Col: "activity", Val: "working"})
	l.life.QueueNotice(l.ctx, "alwk1", "a plain notice", false)
	queued := make(chan []string, 1)
	l.life.switchAt = func(id, step string) {
		if step == "quiesce" {
			go func() {
				time.Sleep(150 * time.Millisecond)
				queued <- l.life.Notices("alwk1")
				_ = l.db.UpdateAgent(l.ctx, "alwk1", db.Field{Col: "activity", Val: "idle"})
			}()
		}
	}
	res, err := l.life.CostSwitch(l.ctx, switchOpts(0.05), l.plan(switchOpts(0.05)))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Waited || res.Interrupted || contains(l.steps("alwk1"), "interrupt") {
		t.Errorf("waited %v, interrupted %v, steps %v", res.Waited, res.Interrupted, l.steps("alwk1"))
	}
	if q := <-queued; len(q) != 2 || q[0] != "a plain notice" {
		t.Errorf("queued during the soft stop %q", q)
	}
	if n := l.life.Notices("alwk1"); len(n) != 1 || n[0] != "a plain notice" {
		t.Errorf("queued after %q", n)
	}
}

// TestSwitchInterruptsAtDeadline: a turn still running at the deadline is interrupted, and the interrupt step records
// that Claude Code confirmed it (a new "Interrupted" line after the Esc).
func TestSwitchInterruptsAtDeadline(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	l.set("alwk1", db.Field{Col: "activity", Val: "working"})
	script := filepath.Join(l.base, "takes.sh")
	if err := os.WriteFile(script, []byte("printf '✶ Working… (3s)\\n'; stty -icanon -echo; dd bs=1 count=1 >/dev/null 2>&1; printf '⎿  Interrupted · ok\\n'; exec cat -v\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	l.life.switchAt = func(id, step string) {
		if step == "quiesce" {
			_ = l.tmux.KillSession(l.ctx, "alwk1")
			if err := l.tmux.NewSession(l.ctx, "alwk1", l.work, tmux.Env{}, []string{"sh", script}); err != nil {
				t.Error(err)
			}
		}
	}
	res, err := l.life.CostSwitch(l.ctx, switchOpts(0.01), l.plan(switchOpts(0.01)))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Interrupted || !contains(l.events("alwk1", "cost:switch"), `{"step":"interrupt","confirmed":true}`) {
		t.Errorf("interrupted %v, steps %v", res.Interrupted, l.events("alwk1", "cost:switch"))
	}
}

// TestSwitchStopsLeftoverTerminal: an agent marked shut down whose terminal still runs, and still marked working, isn't
// waited for: StartSwitch switches it before it returns, and the stop closes the terminal.
func TestSwitchStopsLeftoverTerminal(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	l.exec("UPDATE agents SET lifecycle = 'shut_down', activity = 'working' WHERE id = 'alwk1'")
	out, err := l.life.StartSwitch(l.ctx, switchOpts(1))
	if err != nil {
		t.Fatal(err)
	}
	if r, ok := out.(SwitchResult); !ok || r.Waited || r.To != "worker-t2" {
		t.Fatalf("answer %+v", out)
	}
	if l.tmux.HasSession(l.ctx, "alwk1") {
		t.Error("the predecessor's terminal still runs")
	}
	if !contains(l.events("alwk1", "cost:switch"), `{"step":"stopped","was":"shut_down"}`) {
		t.Errorf("steps %v", l.events("alwk1", "cost:switch"))
	}
}

// TestSwitchSuccessorErrored: a successor that errors during its startup fails the switch with its detail, and the
// switch is rolled back.
func TestSwitchSuccessorErrored(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	// Its launch is done once its prompt was taken; the error comes after, before the switch saw it start.
	l.life.switchAt = func(id, step string) {
		if step == "launched" {
			_ = l.db.UpdateAgent(l.ctx, id, db.Field{Col: "activity", Val: "errored"}, db.Field{Col: "activity_detail", Val: "auth failed"})
		}
	}
	_, err := l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003)))
	if err == nil || !strings.HasSuffix(err.Error(), "worker was restored: worker-t2 failed to start: auth failed") {
		t.Fatalf("switch: %v", err)
	}
	if _, err := l.db.GetAgent(l.ctx, "worker-t2"); err == nil {
		t.Error("the successor is still there")
	}
}

// TestSwitchDaemonStopIsACrash: a daemon that stops mid-switch undoes nothing, as a crash wouldn't: no rollback step,
// the successor and the move stay, and the predecessor stays held for the repair S-3690 will bring.
func TestSwitchDaemonStopIsACrash(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	ctx, cancel := context.WithCancel(l.ctx)
	defer cancel()
	l.life.switchAt = func(id, step string) {
		if step == "moved" {
			cancel()
		}
	}
	_, err := l.life.CostSwitch(ctx, switchOpts(0.003), l.plan(switchOpts(0.003)))
	// The stop surfaces where it lands, the context's error or a query it interrupted, and never as a rollback's.
	if err == nil || ctx.Err() == nil || strings.Contains(err.Error(), "failed, and worker was") {
		t.Fatalf("switch: %v", err)
	}
	if contains(l.steps("alwk1"), "rolled-back") {
		t.Errorf("steps %v", l.steps("alwk1"))
	}
	if _, err := l.db.GetAgent(l.ctx, "worker-t2"); err != nil {
		t.Error("the successor was forgotten")
	}
	if a := l.agent("alwk1"); a.ForwardedTo == nil || l.query("SELECT reason FROM blockers WHERE agent_id = 'alwk1' AND kind = 'taken-over'") == "" {
		t.Errorf("predecessor forwarded %v, blockers %+v", a.ForwardedTo, l.blockerRows("alwk1"))
	}
}

// TestSwitchAcksNoticesRaisedMeanwhile: a cost notice raised for the agent during the switch is acknowledged at its
// end too, as the one open at its start; another agent's isn't.
func TestSwitchAcksNoticesRaisedMeanwhile(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	notice := func(id, agent string) {
		l.exec("INSERT INTO cost_notices (id, key, kind, account, window, agent_id, managers, created_at) VALUES (?, ?, 'blocker-set', 'max', '', ?, '[\"almg1\"]', ?)", id, "k-"+id, agent, t0)
	}
	notice("cn1", "alwk1")
	l.life.switchAt = func(id, step string) {
		if step == "moved" {
			notice("cn2", "alwk1")
			notice("cn3", "almg1")
		}
	}
	res, err := l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003)))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(res.Acked, ",") != "cn1,cn2" {
		t.Errorf("acked %v", res.Acked)
	}
	if l.query("SELECT IFNULL(acked_by, '') FROM cost_notices WHERE id = 'cn3'") != "" {
		t.Error("another agent's notice was acknowledged")
	}
}

// TestSwitchReconcileResumes: the daemon's first reconcile pass re-arms a switch a crash cut in its soft stop.
func TestSwitchReconcileResumes(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	l.set("alwk1", db.Field{Col: "activity", Val: "working"})
	crashed := make(chan struct{})
	l.life.switchAt = func(id, step string) {
		if step == "quiesce" {
			close(crashed)
			runtime.Goexit()
		}
	}
	go func() { _, _ = l.life.CostSwitch(l.ctx, switchOpts(0.02), l.plan(switchOpts(0.02))) }()
	<-crashed
	life := l.restart()
	life.Reconcile(l.ctx, l.tmux.Snapshot(l.ctx))
	l.until("the re-armed switch", func() bool { return contains(l.steps("alwk1"), "done") })
	// The re-armed quiesce keeps the first one's deadline: what is left of its 1.2 s.
	var deadlines []string
	for _, d := range l.events("alwk1", "cost:switch") {
		var q struct {
			Step     string `json:"step"`
			Deadline string `json:"deadline"`
		}
		if json.Unmarshal([]byte(d), &q) == nil && q.Step == "quiesce" {
			deadlines = append(deadlines, q.Deadline)
		}
	}
	if len(deadlines) != 2 {
		t.Fatalf("quiesce deadlines %v", deadlines)
	}
	first, _ := time.Parse(time.RFC3339Nano, deadlines[0])
	again, _ := time.Parse(time.RFC3339Nano, deadlines[1])
	if d := first.Sub(again).Abs(); d > 20*time.Millisecond {
		t.Errorf("quiesce deadlines %v", deadlines)
	}
}

// TestSwitchChildrenWaits: the successor waits on the busy children it took over, as their parent did.
func TestSwitchChildrenWaits(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	l.exec(strings.ReplaceAll(agentSQL("alch1", "kid", map[string]string{"parent_id": "'alwk1'", "harness": "'claude'", "activity": "'working'"}), "{{work}}", l.work))
	if _, err := l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003))); err != nil {
		t.Fatal(err)
	}
	ws, err := l.db.ListWaits(l.ctx, "als11")
	if err != nil {
		t.Fatal(err)
	}
	if len(ws) != 1 || ws[0].Kind != "children" || deref(ws[0].Detail) != "1 child" {
		t.Errorf("waits %+v", ws)
	}
}

// TestSwitchSoftStopSetting: with no soft stop given, settings.cost.softStopMinutes is the switch's.
func TestSwitchSoftStopSetting(t *testing.T) {
	l, _ := newCostLive(t, `{"peers":[],"cost":{"subscriptionWarnPercent":[],"softStopMinutes":0.5}}`)
	if m := l.life.softStop(SwitchOptions{}); m != 0.5 {
		t.Errorf("soft stop %v", m)
	}
}

// TestSwitchResumedSwitchFails: a re-armed switch that fails is rolled back and leaves a resume-failed step.
func TestSwitchResumedSwitchFails(t *testing.T) {
	l := newSwitchLive(t)
	l.runningWorker()
	crashed := make(chan struct{})
	l.life.switchAt = func(id, step string) {
		if step == "quiesce" {
			close(crashed)
			runtime.Goexit()
		}
	}
	go func() { _, _ = l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003))) }()
	<-crashed
	if err := os.WriteFile(filepath.Join(l.base, "exit-als11"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if resumed := l.restart().ResumeSwitches(l.ctx); len(resumed) != 1 {
		t.Fatalf("resumed %v", resumed)
	}
	l.until("the resume-failed step", func() bool { return contains(l.steps("alwk1"), "resume-failed") })
	if st := l.steps("alwk1"); st[len(st)-2] != "rolled-back" {
		t.Errorf("steps %v", st)
	}
}

// TestSwitchRollbackRunningOnly: a failed switch resumes a predecessor that was paused (it ran, held), and leaves one
// that was shut down as it was.
func TestSwitchRollbackRunningOnly(t *testing.T) {
	for _, tc := range []struct {
		name, sql string
		resumes   int
	}{
		{"paused", "UPDATE agents SET lifecycle = 'paused', paused_by = '[\"human\"]' WHERE id = 'alwk1'", 1},
		{"shut down", "UPDATE agents SET lifecycle = 'shut_down', activity = 'unknown' WHERE id = 'alwk1'", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l := newSwitchLive(t)
			l.runningWorker()
			l.exec(tc.sql)
			if tc.resumes == 0 {
				_ = l.tmux.KillSession(l.ctx, "alwk1")
			}
			if err := os.WriteFile(filepath.Join(l.base, "exit-als11"), nil, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := l.life.CostSwitch(l.ctx, switchOpts(0.003), l.plan(switchOpts(0.003)))
			if err == nil || !strings.Contains(err.Error(), "and worker was restored: ") {
				t.Fatalf("switch: %v", err)
			}
			if n := l.countEvents("alwk1", "resume"); n != tc.resumes {
				t.Errorf("resumed %d times", n)
			}
		})
	}
}

// TestSwitchLockBeforeAnswer: a switch holds the agent from the moment StartSwitch or a restart's ResumeSwitches
// answers, before its background work runs: a resume asked right then is refused with the switch's name, and no
// launch of the predecessor slips in beside it.
func TestSwitchLockBeforeAnswer(t *testing.T) {
	refusal := "worker is being switched; try again when it is done"
	t.Run("start", func(t *testing.T) {
		l := newSwitchLive(t)
		l.runningWorker()
		// Paused mid-turn: busy, so the switch goes on in the background, and resumable, so only the lock refuses it.
		l.exec("UPDATE agents SET lifecycle = 'paused', paused_by = '[\"human\"]', activity = 'working' WHERE id = 'alwk1'")
		out, err := l.life.StartSwitch(l.ctx, switchOpts(0.003))
		if _, ok := out.(Quiescing); err != nil || !ok {
			t.Fatalf("answer %+v, %v", out, err)
		}
		if _, err := l.life.resumeNow(l.ctx, "alwk1", "go on"); err == nil || err.Error() != refusal {
			t.Errorf("resume: %v", err)
		}
		l.until("the switch", func() bool { return contains(l.steps("alwk1"), "done") })
		if n := l.countEvents("alwk1", "resume"); n != 0 {
			t.Errorf("the predecessor resumed %d times", n)
		}
	})
	t.Run("restart", func(t *testing.T) {
		l := newSwitchLive(t)
		l.runningWorker()
		l.set("alwk1", db.Field{Col: "activity", Val: "working"})
		crashed := make(chan struct{})
		l.life.switchAt = func(id, step string) {
			if step == "quiesce" {
				close(crashed)
				runtime.Goexit()
			}
		}
		go func() { _, _ = l.life.CostSwitch(l.ctx, switchOpts(0.01), l.plan(switchOpts(0.01))) }()
		<-crashed
		l.exec("UPDATE agents SET lifecycle = 'paused', paused_by = '[\"human\"]' WHERE id = 'alwk1'")
		life := l.restart()
		if resumed := life.ResumeSwitches(l.ctx); len(resumed) != 1 {
			t.Fatalf("resumed %v", resumed)
		}
		if _, err := life.resumeNow(l.ctx, "alwk1", "go on"); err == nil || err.Error() != refusal {
			t.Errorf("resume: %v", err)
		}
		l.until("the re-armed switch", func() bool { return contains(l.steps("alwk1"), "done") })
	})
}

package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

var reStepID = regexp.MustCompile(`\bst[0-9a-f]{8}\b`)

func maskedSteps(s string) string {
	ids := map[string]string{}
	s = reStepID.ReplaceAllStringFunc(s, func(id string) string {
		if _, ok := ids[id]; !ok {
			ids[id] = "S" + strconv.Itoa(len(ids))
		}
		return ids[id]
	})
	return masked(s)
}

// startDecideStub runs test/decide-stub.mjs (the stub every test's model calls go to), points the daemon at it with a stub key,
// and returns its folder.
func startDecideStub(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run the decide stub")
	}
	dir := t.TempDir()
	cmd := exec.Command("node", "../../../test/decide-stub.mjs", dir)
	must(t, cmd.Start())
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	var addr string
	for i := 0; i < 400 && addr == ""; i++ {
		if b, err := os.ReadFile(filepath.Join(dir, "url")); err == nil {
			addr = strings.TrimSpace(string(b))
		}
		time.Sleep(25 * time.Millisecond)
	}
	if addr == "" {
		t.Fatal("the decide stub did not start")
	}
	t.Setenv("STAM_OPENROUTER_URL", addr)
	t.Setenv("OPENROUTER_API_KEY", "stub_key")
	t.Setenv("STAM_EMBEDDER", "stub")
	return dir
}

// TestStepsMatchTS runs the ops of testdata/steps-steps.json through src/steps.ts (routed as src/daemon.ts routes them) on one
// database and through /api/steps* on a copy of it, and compares every status and answer, and the tables left behind.
func TestStepsMatchTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/steps.ts")
	}
	startDecideStub(t)
	home := filepath.Join(t.TempDir(), "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/stepsref.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("stepsref.mjs: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "expect.json"))
	must(t, err)
	want, err := jsfmt.Parse(raw)
	must(t, err)
	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.pre.db"))

	opsRaw, err := os.ReadFile("testdata/steps-steps.json")
	must(t, err)
	var ops []struct {
		Op      string
		Ref     string
		Input   json.RawMessage
		Agent   string
		Tool    string
		Args    json.RawMessage
		N       json.RawMessage
		Limit   json.RawMessage
		Subject string
	}
	must(t, json.Unmarshal(opsRaw, &ops))
	var ids []string
	wantResults, _ := want.Get("results")
	for i, op := range ops {
		time.Sleep(3 * time.Millisecond)
		ref := op.Ref
		if strings.HasPrefix(ref, "#") {
			n, _ := strconv.Atoi(ref[1:])
			ref = ids[n]
		}
		input := string(op.Input)
		for n, id := range ids {
			input = strings.ReplaceAll(input, `"#`+strconv.Itoa(n)+`"`, `"`+id+`"`)
		}
		limit := ""
		if len(op.Limit) > 0 {
			limit = strings.Trim(string(op.Limit), `"`)
		}
		var rec *httptest.ResponseRecorder
		switch op.Op {
		case "list":
			rec = f.post2("GET", "/api/steps", "")
		case "create":
			rec = f.post2("POST", "/api/steps", input)
		case "get":
			rec = f.post2("GET", "/api/steps/"+ref, "")
		case "update":
			rec = f.post2("PATCH", "/api/steps/"+ref, input)
		case "remove":
			rec = f.post2("DELETE", "/api/steps/"+ref, "")
		case "preview":
			body := "{}"
			if len(op.N) > 0 {
				body = `{"n":` + string(op.N) + `}`
			}
			rec = f.post2("POST", "/api/steps/"+ref+"/preview", body)
		case "log":
			rec = f.post2("GET", "/api/steps/"+ref+"/log?limit="+limit, "")
		case "decisions":
			rec = f.post2("GET", "/api/steps/decisions?subject="+url.QueryEscape(op.Subject)+"&limit="+limit, "")
		case "check":
			body := jsfmt.Value{Kind: jsfmt.Object}
			body.Set("agent", jsfmt.StringValue(op.Agent))
			body.Set("tool", jsfmt.StringValue(op.Tool))
			if len(op.Args) > 0 {
				a, perr := jsfmt.Parse(op.Args)
				must(t, perr)
				body.Set("args", a)
			}
			// An agent with its own token checks as itself; the shared token names the rest.
			token := sharedTok
			if op.Agent == "achild" {
				token = agentTok
			}
			rec = f.sendH("POST", "/api/steps/check", token, nil, jsfmt.Compact(body))
		default:
			t.Fatalf("op %d: bad op %s", i, op.Op)
		}
		exp := wantResults.Items[i]
		if wc := int(mustInt(t, exp, "status")); rec.Code != wc {
			t.Errorf("op %d (%s %s %s): status %d, TS %d\n go: %s\n ts: %s", i, op.Op, op.Ref, input, rec.Code, wc, rec.Body.String(), jsfmt.Compact(exp))
			ids = append(ids, "")
			continue
		}
		got, perr := jsfmt.Parse(rec.Body.Bytes())
		must(t, perr)
		var wantBody jsfmt.Value
		if e, ok := exp.Get("error"); ok {
			wantBody = jsfmt.Value{Kind: jsfmt.Object}
			wantBody.Set("error", e)
		} else {
			wantBody, _ = exp.Get("result")
		}
		if g, w := maskedSteps(jsfmt.Compact(got)), maskedSteps(jsfmt.Compact(wantBody)); g != w {
			t.Errorf("op %d (%s %s %s):\n go: %s\n ts: %s", i, op.Op, op.Ref, input, g, w)
		}
		id := ""
		if rec.Code == 200 && op.Op == "create" {
			id = got.Text("id")
		}
		ids = append(ids, id)
	}
	wantTables, _ := want.Get("tables")
	for i, name := range wantTables.Keys {
		order := "1"
		if name == "decision_steps" {
			order = "created_at"
		}
		got := dumpTyped(t, f, "SELECT * FROM "+name+" ORDER BY "+order)
		// The history's own ids are the autoincrement of each run; the rows are compared in order.
		if a, b := maskedSteps(jsfmt.Compact(wantTables.Items[i])), maskedSteps(jsfmt.Compact(got)); a != b {
			t.Errorf("table %s differs\n ts: %s\n go: %s", name, a, b)
		}
	}
}

// dumpTyped is dump with REAL columns as numbers (thresholds and probabilities).
func dumpTyped(t *testing.T, f *fixture, query string) jsfmt.Value {
	t.Helper()
	out := []jsfmt.Value{}
	must(t, f.db.Read(context.Background(), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, query, &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
			row := jsfmt.Value{Kind: jsfmt.Object}
			for i := 0; i < stmt.ColumnCount(); i++ {
				v := jsfmt.StringValue(stmt.ColumnText(i))
				switch stmt.ColumnType(i) {
				case sqlite.TypeNull:
					v = jsfmt.NullValue()
				case sqlite.TypeInteger:
					v = jsfmt.IntValue(stmt.ColumnInt64(i))
				case sqlite.TypeFloat:
					v = jsfmt.Value{Kind: jsfmt.Number, Num: jsjson.Number(stmt.ColumnFloat(i))}
				}
				row.Set(stmt.ColumnName(i), v)
			}
			out = append(out, row)
			return nil
		}})
	}))
	return jsfmt.ArrayValue(out)
}

func (f *fixture) step(body string) string {
	f.t.Helper()
	rec := f.post2("POST", "/api/steps", body)
	if rec.Code != 200 {
		f.t.Fatalf("create step %s: %d %s", body, rec.Code, rec.Body.String())
	}
	v, err := jsfmt.Parse(rec.Body.Bytes())
	must(f.t, err)
	return v.Text("id")
}

func (f *fixture) check(agentTok, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.sendH("POST", "/api/steps/check", agentTok, nil, body)
}

const bashStep = `{"name":"Risky","trigger":{"kind":"tool","tool":"Bash"},"question":"Is this risky?","action":"deny-if-yes"}`

// A check names a registered agent and a tool; an agent's token checks only as itself, or as no one else.
func TestStepsCheckIdentity(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	for name, c := range map[string]struct {
		token, body string
		status      int
		msg         string
	}{
		"no tool":                 {sharedTok, `{"agent":"aboss"}`, 400, "a check needs agent and tool"},
		"no agent":                {sharedTok, `{"tool":"Bash"}`, 400, "a check needs agent and tool"},
		"a tool that is a number": {sharedTok, `{"agent":"aboss","tool":5}`, 400, "a check needs agent and tool"},
		"an unknown agent":        {sharedTok, `{"agent":"nobody","tool":"Bash"}`, 404, "no agent nobody"},
		"another agent":           {agentTok, `{"agent":"aboss","tool":"Bash"}`, 403, "can't act as"},
		"an agent as itself":      {agentTok, `{"tool":"Bash"}`, 200, ""},
		"an agent by its name":    {agentTok, `{"agent":"achild","tool":"Bash","args":[1]}`, 200, ""},
	} {
		rec := f.check(c.token, c.body)
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.msg) {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
}

// Every checked call is kept in the history, the last 50 per tool.
func TestStepsToolHistory(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	for i := 0; i < 53; i++ {
		if rec := f.check(sharedTok, `{"agent":"aboss","tool":"Edit","args":{"n":`+strconv.Itoa(i)+`}}`); rec.Code != 200 {
			t.Fatal(rec.Body.String())
		}
	}
	f.check(sharedTok, `{"agent":"aboss","tool":"Read"}`)
	rows := dumpTyped(t, f, "SELECT tool, count(*) AS n, min(id) AS first FROM tool_calls GROUP BY tool ORDER BY tool")
	if got := jsfmt.Compact(rows); got != `[{"tool":"Edit","n":50,"first":4},{"tool":"Read","n":1,"first":54}]` {
		t.Errorf("history: %s", got)
	}
}

// A model that never answers does not hold the tool past the 8 s the shim waits: two hanging steps are failed open inside
// the 7 s budget, the second with what is left of it.
func TestStepsCheckBudget(t *testing.T) {
	dir := startDecideStub(t)
	f := newFixture(t, nil)
	f.step(bashStep)
	f.step(`{"name":"Second","trigger":{"kind":"tool","tool":"Bash"},"question":"Is this the second?","action":"approve-if-yes"}`)
	writeFile(t, filepath.Join(dir, "hang"), "1")
	start := time.Now()
	rec := f.check(sharedTok, `{"agent":"aboss","tool":"Bash","args":{"command":"STUB:HANG"}}`)
	took := time.Since(start)
	if rec.Code != 200 || rec.Body.String() != `{"allow":true}` {
		t.Fatalf("hung model: %d %s", rec.Code, rec.Body.String())
	}
	if took >= 8*time.Second {
		t.Errorf("the check took %v, over the 8 s the shim waits", took)
	}
	rows := dumpTyped(t, f, "SELECT action, error FROM step_decisions ORDER BY id")
	if got := jsfmt.Compact(rows); got != `[{"action":"failed-open","error":"the decision model failed or timed out"},{"action":"failed-open","error":"the decision model failed or timed out"}]` {
		t.Errorf("decisions: %s", got)
	}
	writeFile(t, filepath.Join(dir, "release"), "1")
}

// With requirements on, a tool no enforced requirement scopes goes through; the home's own check is in requirements_check_test.go.
func TestStepsCheckRequirementsOn(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	body := `{"agent":"aboss","tool":"Bash"}`
	if rec := f.check(sharedTok, body); rec.Code != 200 {
		t.Fatalf("requirements off: %d %s", rec.Code, rec.Body.String())
	}
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"requirements":{"enabled":true}}`)
	if rec := f.check(sharedTok, body); rec.Code != 200 || rec.Body.String() != `{"allow":true}` {
		t.Errorf("requirements on, none scoped to Bash: %d %s", rec.Code, rec.Body.String())
	}
}

// A daemon that is not the ITSA home asks the home, as TS does, but only for a tool in the copy of the home's enforced-tools
// index it keeps: with no copy yet, or for a tool not in it, the call goes through. A home that cannot answer allows too.
func TestStepsCheckOnANonHomeDaemon(t *testing.T) {
	startDecideStub(t)
	var mu sync.Mutex
	var asked []string
	home := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asked = append(asked, r.Method+" "+r.URL.Path)
		mu.Unlock()
		switch r.URL.Path {
		case "/api/requirements/enforced-tools":
			io.WriteString(w, `{"tools":["Edit"]}`)
		case "/api/requirements/check-tool":
			b, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(b), `"tool":"Edit"`) || !strings.Contains(string(b), `"actor":{"name":"boss"`) || !strings.Contains(string(b), `"budgetMs":`) {
				t.Errorf("check-tool body: %s", b)
			}
			io.WriteString(w, `{"allow":false,"requirement":"R-1","p":0.9,"error":"Denied by requirement R-1 (likely not met, p 0.90): no edits."}`)
		default:
			w.WriteHeader(404)
		}
	}))
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"requirements":{"enabled":true},"home":"farhome","peers":[{"name":"farhome","url":"`+home.URL+`","token":"t"}]}`)
	edit := `{"agent":"aboss","tool":"Edit"}`
	// No copy of the index yet: the call goes through, and the copy is fetched.
	if rec := f.check(sharedTok, edit); rec.Code != 200 || rec.Body.String() != `{"allow":true}` {
		t.Fatalf("before the index: %d %s", rec.Code, rec.Body.String())
	}
	for i := 0; i < 200; i++ {
		f.srv.remoteIdx.mu.Lock()
		have := f.srv.remoteIdx.have
		f.srv.remoteIdx.mu.Unlock()
		if have {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	rec := f.check(sharedTok, edit)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"allow":false`) || !strings.Contains(rec.Body.String(), `"requirement":"R-1"`) {
		t.Errorf("a tool in the index: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.check(sharedTok, `{"agent":"aboss","tool":"Read"}`); rec.Code != 200 || rec.Body.String() != `{"allow":true}` {
		t.Errorf("a tool not in the index: %d %s", rec.Code, rec.Body.String())
	}
	mu.Lock()
	got := strings.Join(asked, ", ")
	mu.Unlock()
	if got != "GET /api/requirements/enforced-tools, POST /api/requirements/check-tool" {
		t.Errorf("the home was asked: %s", got)
	}
	// A home that is gone allows the call and logs why.
	home.Close()
	if rec := f.check(sharedTok, edit); rec.Code != 200 || rec.Body.String() != `{"allow":true}` {
		t.Errorf("a home that is gone: %d %s", rec.Code, rec.Body.String())
	}
	if n := dumpTyped(t, f, "SELECT count(*) AS n FROM events WHERE type = 'req:error'"); !strings.Contains(jsfmt.Compact(n), `"n":1`) && !strings.Contains(jsfmt.Compact(n), `"n":2`) {
		t.Errorf("req:error events: %s", jsfmt.Compact(n))
	}
	// A non-home daemon with no such peer allows too, and says so.
	f2 := newFixture(t, nil)
	writeFile(t, filepath.Join(f2.home, "settings.json"), `{"requirements":{"enabled":true},"home":"elsewhere"}`)
	if rec := f2.check(sharedTok, edit); rec.Code != 200 {
		t.Errorf("no such peer: %d %s", rec.Code, rec.Body.String())
	}
}

// A step that denies is the answer even with requirements on: the denial reaches the agent.
func TestStepsDenialBeforeRequirements(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	f.step(bashStep)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"requirements":{"enabled":true},"home":"elsewhere"}`)
	rec := f.check(sharedTok, `{"agent":"aboss","tool":"Bash","args":{"c":"P=0.9"}}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"allow":false`) {
		t.Errorf("%d %s", rec.Code, rec.Body.String())
	}
}

// An enabled step on agent-spawned would fire from the spawn hook, which is not ported: the spawn is refused before it writes.
// A preview of an event step is refused the same way.
func TestStepsEventsNotPorted(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	id := f.step(`{"name":"Watch spawns","trigger":{"kind":"event","event":"agent-spawned"},"question":"Is this spawn odd?","action":"flag"}`)
	before := dumpTyped(t, f, "SELECT count(*) AS n FROM agents")
	rec := f.post2("POST", "/api/agents", `{"name":"newbie","role":"developer","harness":"claude","model":"claude-opus-5-5"}`)
	if rec.Code != 501 || !strings.Contains(rec.Body.String(), "agent-spawned") {
		t.Errorf("spawn: %d %s", rec.Code, rec.Body.String())
	}
	if after := dumpTyped(t, f, "SELECT count(*) AS n FROM agents"); jsfmt.Compact(after) != jsfmt.Compact(before) {
		t.Errorf("the refused spawn wrote an agent: %s", jsfmt.Compact(after))
	}
	if rec := f.post2("POST", "/api/steps/"+id+"/preview", `{}`); rec.Code != 501 {
		t.Errorf("event preview: %d %s", rec.Code, rec.Body.String())
	}
	f.post2("PATCH", "/api/steps/"+id, `{"enabled":false}`)
	if rec := f.post2("POST", "/api/agents", `{"name":"newbie","role":"developer","harness":"claude","model":"claude-opus-5-5"}`); strings.Contains(rec.Body.String(), "agent-spawned") {
		t.Errorf("a step that is off still refuses the spawn: %d %s", rec.Code, rec.Body.String())
	}
}

// An update reads, validates and writes in one transaction: two updates that each need the other not to have happened first
// never leave a step whose action does not fit its trigger.
func TestStepsConcurrentUpdates(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	for round := 0; round < 25; round++ {
		id := f.step(bashStep)
		results := make(chan int, 2)
		go func() {
			results <- f.post2("PATCH", "/api/steps/"+id, `{"action":"annotate"}`).Code
		}()
		go func() {
			results <- f.post2("PATCH", "/api/steps/"+id, `{"trigger":{"kind":"event","event":"itsa-created"},"action":"flag"}`).Code
		}()
		a, b := <-results, <-results
		if a != 200 && a != 400 || b != 200 && b != 400 {
			t.Fatalf("round %d: %d %d", round, a, b)
		}
		rec := f.post2("GET", "/api/steps/"+id, "")
		v, err := jsfmt.Parse(rec.Body.Bytes())
		must(t, err)
		trig, _ := v.Get("trigger")
		kind, action := trig.Text("kind"), v.Text("action")
		if kind == "tool" && action == "annotate" || kind == "event" && action == "deny-if-yes" {
			t.Fatalf("round %d: a %s step with action %s", round, kind, action)
		}
	}
}

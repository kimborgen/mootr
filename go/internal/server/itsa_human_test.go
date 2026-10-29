package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
)

// TestItsaHumanMatchesTS runs the steps of testdata/human-steps.json through src/itsa.ts, src/itsa-human.ts and the reads
// of src/daemon.ts's thread routes on one database, and through the routes on a copy of it, and compares every answer,
// status and error, and the tables the steps leave behind.
func TestItsaHumanMatchesTS(t *testing.T) {
	humanParity(t, "humanref.mjs", "human-steps.json", `{"itsa":{"ownerNotices":"off","actions":{"needs_test":[{"id":"ok","label":"Looks good","to":"done","text":"none"},{"id":"bad","label":"Broken","to":"nonesuch","text":"optional"}]}}}`, map[string]string{
		"mail":         "SELECT id, from_id, subject, body, thread_id, itsa_id, kind, about_itsa FROM mail WHERE id NOT LIKE 'mx%' ORDER BY rowid",
		"recipients":   "SELECT mail_id, agent_id, quiet FROM mail_recipients WHERE mail_id NOT LIKE 'mx%' ORDER BY rowid",
		"itsas":        "SELECT id, key, title, owner, status, thread_id FROM itsas ORDER BY rowid",
		"participants": "SELECT itsa_id, agent_id FROM itsa_participants ORDER BY rowid",
		"itsaEvents":   "SELECT itsa_id, actor, type, data FROM itsa_events ORDER BY id",
	})
}

// humanParity runs a script of src/ (which writes expect.json for the steps file) and the routes over the same steps, and
// compares answers and tables.
func humanParity(t *testing.T, script, stepsFile, settings string, queries map[string]string) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/itsa.ts")
	}
	home := filepath.Join(t.TempDir(), "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/"+script, home).CombinedOutput(); err != nil {
		t.Fatalf("%s: %v\n%s", script, err, out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "expect.json"))
	must(t, err)
	want, err := jsfmt.Parse(raw)
	must(t, err)

	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.pre.db"))
	writeFile(t, filepath.Join(f.home, "settings.json"), settings)
	stepsRaw, err := os.ReadFile("testdata/" + stepsFile)
	must(t, err)
	var steps []struct {
		Op    string
		Input json.RawMessage
		Ref   string
		By    string
		SQL   string
	}
	must(t, json.Unmarshal(stepsRaw, &steps))
	var ids []string
	reHash := regexp.MustCompile(`"#(\d+)"`)
	reQuoted := regexp.MustCompile(`'#(\d+)'`)
	subJSON := func(raw json.RawMessage) string {
		return reHash.ReplaceAllStringFunc(string(raw), func(m string) string {
			n, _ := strconv.Atoi(m[2 : len(m)-1])
			if n < len(ids) && ids[n] != "" {
				return `"` + ids[n] + `"`
			}
			return m
		})
	}
	wantResults, _ := want.Get("results")
	wantStarts := stepStarts(want)
	var starts []string
	for i, st := range steps {
		// The reference waits between steps, so every change has a time of its own.
		time.Sleep(3 * time.Millisecond)
		starts = append(starts, time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
		ref := st.Ref
		if strings.HasPrefix(ref, "#") {
			n, _ := strconv.Atoi(ref[1:])
			ref = ids[n]
		}
		var rec *httptest.ResponseRecorder
		switch st.Op {
		case "sql":
			q := reQuoted.ReplaceAllStringFunc(st.SQL, func(m string) string {
				n, _ := strconv.Atoi(m[2 : len(m)-1])
				return "'" + ids[n] + "'"
			})
			must(t, f.db.Write(context.Background(), func(conn *sqlite.Conn) error { return sqlitex.ExecuteScript(conn, q, nil) }))
			ids = append(ids, "")
			continue
		case "create":
			rec = f.post2("POST", "/api/itsas", subJSON(st.Input))
		case "set":
			body, perr := jsfmt.Parse([]byte(subJSON(st.Input)))
			must(t, perr)
			switch {
			case strings.HasPrefix(st.By, "system:"):
				body.Set("as_system", jsfmt.StringValue(strings.TrimPrefix(st.By, "system:")))
			case st.By != "":
				body.Set("by", jsfmt.StringValue(st.By))
			}
			rec = f.post2("PATCH", "/api/itsas/"+ref, jsfmt.Compact(body))
		case "post":
			body, perr := jsfmt.Parse([]byte(subJSON(st.Input)))
			must(t, perr)
			switch {
			case strings.HasPrefix(st.By, "system:"):
				body.Set("as_system", jsfmt.StringValue(strings.TrimPrefix(st.By, "system:")))
			case st.By == "":
				body.Set("by", jsfmt.StringValue("human"))
			default:
				body.Set("by", jsfmt.StringValue(st.By))
			}
			rec = f.post2("POST", "/api/itsas/"+ref+"/post", jsfmt.Compact(body))
		case "act":
			rec = f.post2("POST", "/api/itsas/"+ref+"/act", subJSON(st.Input))
		case "attention":
			rec = f.post2("GET", "/api/itsas/attention", "")
		case "thread", "threads":
			rec = f.post2("GET", "/api/itsas/"+ref+"/"+st.Op, "")
		default:
			t.Fatalf("step %d: bad op %s", i, st.Op)
		}
		code, respBody := rec.Code, rec.Body.Bytes()
		exp := wantResults.Items[i]
		if wc := int(mustInt(t, exp, "status")); code != wc {
			t.Errorf("step %d (%s %s %s): status %d, TS %d\n go: %s\n ts: %s", i, st.Op, st.Ref, st.Input, code, wc, respBody, jsfmt.Compact(exp))
			ids = append(ids, "")
			continue
		}
		got, perr := jsfmt.Parse(respBody)
		must(t, perr)
		var wantBody jsfmt.Value
		if e, ok := exp.Get("error"); ok {
			wantBody = jsfmt.Value{Kind: jsfmt.Object}
			wantBody.Set("error", e)
		} else {
			wantBody, _ = exp.Get("result")
		}
		if st.Op == "thread" {
			var gerr, werr error
			if got, gerr = stepOrder(got, starts); gerr != nil {
				t.Errorf("step %d: go's thread is out of step order: %v", i, gerr)
			}
			if wantBody, werr = stepOrder(wantBody, wantStarts); werr != nil {
				t.Errorf("step %d: TS's thread is out of step order: %v", i, werr)
			}
		}
		if g, w := maskedPost(jsfmt.Compact(got)), maskedPost(jsfmt.Compact(wantBody)); g != w {
			t.Errorf("step %d (%s %s %s):\n go: %s\n ts: %s", i, st.Op, st.Ref, st.Input, g, w)
		}
		id := ""
		if code == 200 && st.Op == "create" {
			id = got.Text("id")
		}
		ids = append(ids, id)
	}

	wantTables, _ := want.Get("tables")
	for i, name := range wantTables.Keys {
		got := dump(t, f, queries[name])
		if a, b := maskedPost(jsfmt.Compact(wantTables.Items[i])), maskedPost(jsfmt.Compact(got)); a != b {
			t.Errorf("table %s differs\n ts: %s\n go: %s", name, a, b)
		}
	}
}

// Who reads an ITSA's threads and acts on it: an agent's token reads them only as one the ITSA belongs to, the OpenCode
// server names its agent with `as`, the human alone acts, and an agent may not read what waits on the human.
func TestItsaHumanRules(t *testing.T) {
	f := newFixture(t, nil)
	key := f.createItsa(`{"title":"Alpha","owner":"boss"}`)
	f.post2("POST", "/api/itsas/"+key+"/post", `{"body":"hello"}`)
	for _, p := range []string{"thread", "threads"} {
		url := "/api/itsas/" + key + "/" + p
		rec := f.sendH("GET", url, agentTok, nil, "")
		if rec.Code != 403 || !strings.Contains(errorOf(t, rec), "can't read the threads of "+key) {
			t.Errorf("%s as a stranger: %d %s", p, rec.Code, rec.Body.String())
		}
		if rec := f.sendH("GET", url, serverTok, nil, ""); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "the OpenCode server must name the agent that reads the threads") {
			t.Errorf("%s from the OpenCode server with no agent: %d %s", p, rec.Code, rec.Body.String())
		}
		if rec := f.sendH("GET", url+"?as=achild", serverTok, nil, ""); rec.Code != 403 {
			t.Errorf("%s from the OpenCode server as a stranger: %d %s", p, rec.Code, rec.Body.String())
		}
	}
	f.sql("INSERT INTO itsa_participants (itsa_id, agent_id) SELECT id, 'achild' FROM itsas WHERE key = ?", key)
	// The OpenCode server may name only an OpenCode agent (resolveActors, on the `as` query too).
	f.sql("UPDATE agents SET harness = 'opencode' WHERE id = 'achild'")
	for _, p := range []string{"thread", "threads"} {
		url := "/api/itsas/" + key + "/" + p
		if rec := f.sendH("GET", url, agentTok, nil, ""); rec.Code != 200 {
			t.Errorf("%s as a participant: %d %s", p, rec.Code, rec.Body.String())
		}
		if rec := f.sendH("GET", url+"?as=achild", serverTok, nil, ""); rec.Code != 200 {
			t.Errorf("%s from the OpenCode server as a participant: %d %s", p, rec.Code, rec.Body.String())
		}
	}
	if rec := f.sendH("GET", "/api/itsas/nosuch/thread", sharedTok, human, ""); rec.Code != 404 {
		t.Errorf("a missing ITSA: %d %s", rec.Code, rec.Body.String())
	}

	if rec := f.sendH("GET", "/api/itsas/attention", agentTok, nil, ""); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "read what waits on the human") {
		t.Errorf("attention from an agent: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.sendH("GET", "/api/itsas/attention", serverTok, nil, ""); rec.Code != 403 {
		t.Errorf("attention from the OpenCode server: %d %s", rec.Code, rec.Body.String())
	}
	f.post2("PATCH", "/api/itsas/"+key, `{"status":"needs_approval"}`)
	if rec := f.post2("GET", "/api/itsas/attention", ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"actions":[{"id":"approve"`) {
		t.Errorf("attention for the human: %d %s", rec.Code, rec.Body.String())
	}
	// The OpenCode server naming no agent is refused before the route, by resolveActors, as TS refuses it.
	for tok, want := range map[string]string{agentTok: "only the human acts on an ITSA that waits on them", serverTok: "the OpenCode server's request must name its agent"} {
		if rec := f.sendH("POST", "/api/itsas/"+key+"/act", tok, nil, `{"action":"approve"}`); rec.Code != 403 || !strings.Contains(errorOf(t, rec), want) {
			t.Errorf("act with %s: %d %s", tok, rec.Code, rec.Body.String())
		}
	}
	if rec := f.sendH("POST", "/api/itsas/"+key+"/act", sharedTok, nil, `{"action":"approve"}`); rec.Code != 403 {
		t.Errorf("act with the shared token and no human: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"approve"}`); rec.Code != 409 || !strings.Contains(errorOf(t, rec), "the text changed, review again") {
		t.Errorf("act as the human with no if_rev: %d %s", rec.Code, rec.Body.String())
	}
	rev := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("rev")
	if rec := f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"approve","if_rev":"`+rev+`"}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"to":"in_progress"`) {
		t.Errorf("act as the human: %d %s", rec.Code, rec.Body.String())
	}
}

// An Approve carries the revision of the text it showed (S-2998). The text changing between act's check and the status
// move is caught by the re-check in the move's transaction: 409, nothing moves, and the comment isn't posted twice.
func TestItsaApproveTextChangedBeforeTheMove(t *testing.T) {
	f := newFixture(t, nil)
	key := f.createItsa(`{"title":"Diff","body":"diff one","status":"needs_approval"}`)
	rev := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("rev")
	if rev == "" {
		t.Fatal("the ITSA view has no rev")
	}
	actBeforeSet = func() { f.sql("UPDATE itsas SET body = 'diff two' WHERE key = ?", key) }
	defer func() { actBeforeSet = nil }()
	rec := f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"approve","text":"","if_rev":"`+rev+`"}`)
	if rec.Code != 409 || errorOf(t, rec) != "the text changed, review again: "+key+" changed since it was shown" {
		t.Errorf("an Approve after the text changed: %d %s", rec.Code, rec.Body.String())
	}
	actBeforeSet = nil
	v := f.body(f.post2("GET", "/api/itsas/"+key, ""))
	if v.Text("status") != "needs_approval" {
		t.Errorf("the refused Approve moved it to %s", v.Text("status"))
	}
	// A stale revision is refused before the move too.
	if rec := f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"approve","text":"","if_rev":"`+rev+`"}`); rec.Code != 409 {
		t.Errorf("a stale if_rev: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"approve","text":"","if_rev":"`+v.Text("rev")+`"}`); rec.Code != 200 {
		t.Errorf("an Approve on the text shown now: %d %s", rec.Code, rec.Body.String())
	}
}

// revOf is src/itsa.ts revOf: fixed values, a null counts as empty, and text moved from one field into the next changes it.
func TestItsaRevOf(t *testing.T) {
	v := func(title string, summary, body any) jsfmt.Value {
		x := jsfmt.Value{Kind: jsfmt.Object}
		x.Set("title", jsfmt.StringValue(title))
		for k, f := range map[string]any{"summary": summary, "body": body} {
			if s, ok := f.(string); ok {
				x.Set(k, jsfmt.StringValue(s))
			} else {
				x.Set(k, jsfmt.NullValue())
			}
		}
		return x
	}
	if got := revOf(v("Gamma", nil, nil)); got != "f767a69f7540656b" {
		t.Errorf("revOf(Gamma) = %s, TS f767a69f7540656b", got)
	}
	if revOf(v("Gamma", nil, nil)) != revOf(v("Gamma", "", "")) {
		t.Error("a null and an empty field differ")
	}
	if revOf(v("ab", "c", nil)) == revOf(v("a", "bc", nil)) || revOf(v("a", nil, "b")) == revOf(v("a", "b", nil)) {
		t.Error("text moved between fields kept the rev")
	}
}

// Elsewhere than the ITSA home these go to the home (itsa_proxy_test.go), after an agent's token was refused; with no such peer, 503.
func TestItsaHumanNotHome(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, f.home+"/settings.json", `{"itsa":{"home":"elsewhere"}}`)
	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/itsas/S-1/thread"}, {"GET", "/api/itsas/S-1/threads"}, {"POST", "/api/itsas/S-1/act"}, {"GET", "/api/itsas/attention"},
	} {
		if rec := f.post2(tc.method, tc.path, `{}`); rec.Code != 503 || !strings.Contains(errorOf(t, rec), "ITSA home 'elsewhere' is not a configured peer") {
			t.Errorf("%s %s: %d %s", tc.method, tc.path, rec.Code, rec.Body.String())
		}
	}
	if rec := f.sendH("GET", "/api/itsas/attention", agentTok, nil, ""); rec.Code != 403 {
		t.Errorf("attention from an agent: %d %s", rec.Code, rec.Body.String())
	}
}

// An act with a text answers 501 before the comment is posted when the move would: a retry then posts nothing twice. A stale
// button still gets its 409 after the post, as in TS.
func TestItsaActRefusesBeforePosting(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("CREATE TABLE IF NOT EXISTS decision_steps (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL, question TEXT NOT NULL, threshold REAL NOT NULL DEFAULT 0.5, action TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, builtin TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
	mails := func() int { return f.count("SELECT COUNT(*) FROM mail") }
	act := func(key, action, text string) *httptest.ResponseRecorder {
		// Approve carries the revision of the text shown (S-2998).
		rev := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("rev")
		return f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"`+action+`","text":"`+text+`","if_rev":"`+rev+`"}`)
	}
	for _, tc := range []struct {
		name, status, action, contains string
		setup, teardown                string
	}{
		{"a step on the status change", "needs_input", "answer", "decision step",
			"INSERT INTO decision_steps (id, name, trigger, question, action, enabled, created_at, updated_at) VALUES ('s1', 'n', '{\"kind\":\"event\",\"event\":\"itsa-status\"}', 'q', '{}', 1, 'x', 'x')",
			"DELETE FROM decision_steps"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key := f.createItsa(`{"title":"` + tc.name + `"}`)
			if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"`+tc.status+`"}`); rec.Code != 200 {
				t.Fatalf("to %s: %d %s", tc.status, rec.Code, rec.Body.String())
			}
			f.sql(tc.setup)
			before := mails()
			rec := act(key, tc.action, "go ahead")
			if rec.Code != 501 || !strings.Contains(errorOf(t, rec), tc.contains) {
				t.Errorf("%d %s, want 501 naming %q", rec.Code, rec.Body.String(), tc.contains)
			}
			if n := mails() - before; n != 0 {
				t.Errorf("the refused act posted %d mails", n)
			}
			if n := f.count("SELECT COUNT(*) FROM itsas WHERE key = ? AND status = ?", key, tc.status); n != 1 {
				t.Error("the refused act moved the ITSA")
			}
			f.sql(tc.teardown)
		})
	}
	// An action the ITSA's status does not offer (the button was stale when the request was made) is refused before the
	// post, as in TS. The 409 of a move that races the request cannot be made over HTTP, so it is not tested here.
	key := f.createItsa(`{"title":"stale"}`)
	f.post2("PATCH", "/api/itsas/"+key, `{"status":"needs_approval"}`)
	before := mails()
	f.sql("UPDATE itsas SET status = 'needs_input' WHERE key = ?", key)
	if rec := act(key, "approve", "late"); rec.Code != 400 || !strings.Contains(errorOf(t, rec), "which has no action approve") {
		t.Errorf("an action of a status the ITSA left: %d %s", rec.Code, rec.Body.String())
	}
	if n := mails() - before; n != 0 {
		t.Errorf("an action that is not offered posted %d mails", n)
	}
}

// A mail thread's Approve names the newest mail it showed (S-2998): the ask records the revision it went out with, so a body
// swapped after the ask is refused, and so is a mail of another thread.
func TestItsaApproveFromTheThread(t *testing.T) {
	f := newFixture(t, nil)
	// A model that may mail the human, so the owner's move asks.
	f.sql("UPDATE agents SET model = 'claude-opus-5-5' WHERE name = 'boss'")
	key := f.createItsa(`{"title":"Thread","body":"diff one","owner":"boss","status":"in_progress"}`)
	f.post2("POST", "/api/itsas/"+key+"/post", `{"by":"boss","body":"Please approve diff one."}`)
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"needs_approval","by":"boss"}`); rec.Code != 200 {
		t.Fatalf("to needs_approval: %d %s", rec.Code, rec.Body.String())
	}
	var ask string
	for i := 0; i < 200 && ask == ""; i++ {
		must(t, f.db.Read(context.Background(), func(conn *sqlite.Conn) error {
			return sqlitex.Execute(conn, "SELECT m.id FROM mail m JOIN itsas x ON x.thread_id = m.thread_id WHERE x.key = ? AND m.kind = 'ask'", &sqlitex.ExecOptions{Args: []any{key}, ResultFunc: func(stmt *sqlite.Stmt) error { ask = stmt.ColumnText(0); return nil }})
		}))
		if ask == "" {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if ask == "" {
		t.Fatal("no ask was mailed")
	}
	act := func(mail string) *httptest.ResponseRecorder {
		return f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"approve","text":"","shown_mail":"`+mail+`"}`)
	}
	f.post2("PATCH", "/api/itsas/"+key, `{"body":"diff two","by":"boss"}`)
	var body string
	must(t, f.db.Read(context.Background(), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT body FROM mail WHERE id = ?", &sqlitex.ExecOptions{Args: []any{ask}, ResultFunc: func(stmt *sqlite.Stmt) error { body = stmt.ColumnText(0); return nil }})
	}))
	if !strings.HasPrefix(body, "<details><summary>What you approve: "+key+" Thread</summary>\n\ndiff one\n\n</details>\n\n") {
		t.Errorf("the ask doesn't show the text it asks about: %q", body)
	}
	if rec := act(ask); rec.Code != 409 || !strings.Contains(errorOf(t, rec), "the text changed, review again") {
		t.Errorf("Approve from a thread showing the ask, after the body changed: %d %s", rec.Code, rec.Body.String())
	}
	if rec := act("nosuchmail"); rec.Code != 409 {
		t.Errorf("Approve naming a mail of no thread: %d %s", rec.Code, rec.Body.String())
	}
	f.post2("PATCH", "/api/itsas/"+key, `{"body":"diff one","by":"boss"}`)
	if rec := act(ask); rec.Code != 200 {
		t.Errorf("Approve from a thread showing the ask, on the text it went out with: %d %s", rec.Code, rec.Body.String())
	}
}

// A refused Approve with a comment posts nothing and records no event (S-2998): its comment goes only after the move.
func TestItsaApproveCommentAfterTheMove(t *testing.T) {
	f := newFixture(t, nil)
	key := f.createItsa(`{"title":"Comment race","body":"diff one","status":"needs_approval"}`)
	rev := f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("rev")
	mails, events := f.count("SELECT COUNT(*) FROM mail"), f.count("SELECT COUNT(*) FROM itsa_events")
	actBeforeSet = func() { f.sql("UPDATE itsas SET body = 'diff two' WHERE key = ?", key) }
	defer func() { actBeforeSet = nil }()
	if rec := f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"approve","text":"Looks good","if_rev":"`+rev+`"}`); rec.Code != 409 {
		t.Fatalf("an Approve after the text changed: %d %s", rec.Code, rec.Body.String())
	}
	actBeforeSet = nil
	if m, e := f.count("SELECT COUNT(*) FROM mail"), f.count("SELECT COUNT(*) FROM itsa_events"); m != mails || e != events {
		t.Errorf("a refused Approve left %d mails and %d events behind", m-mails, e-events)
	}
	rev = f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("rev")
	if rec := f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"approve","text":"Looks good","if_rev":"`+rev+`"}`); rec.Code != 200 {
		t.Fatalf("an Approve on the text shown: %d %s", rec.Code, rec.Body.String())
	}
	if f.count("SELECT COUNT(*) FROM mail WHERE from_id = 'human' AND body = 'Looks good'") != 1 {
		t.Error("the Approve's comment wasn't posted after the move")
	}
}

// shownText is itsa-human.ts shownText: the snapshot with its revision, and a body too long to show cut with none.
func TestItsaShownText(t *testing.T) {
	x := jsfmt.Value{Kind: jsfmt.Object}
	x.Set("key", jsfmt.StringValue("S-1"))
	x.Set("title", jsfmt.StringValue("Show me"))
	x.Set("summary", jsfmt.StringValue("One line."))
	x.Set("body", jsfmt.StringValue("diff B"))
	text, rev := shownText(x)
	if text != "<details><summary>What you approve: S-1 Show me</summary>\n\nOne line.\n\ndiff B\n\n</details>" || rev != revOf(x) {
		t.Errorf("shownText = %q, %q", text, rev)
	}
	x.Set("body", jsfmt.StringValue(strings.Repeat("x", askTextMax+1)))
	if text, rev := shownText(x); rev != "" || !strings.HasSuffix(text, "… Cut here: open S-1 to review all of it.\n\n</details>") {
		t.Errorf("a long body: rev %q, text ends %q", rev, text[len(text)-80:])
	}
}

// shownText escapes the title and summary (S-2998), byte for byte as TS does, so markup in them can't hide the snapshot.
func TestItsaShownTextEscapes(t *testing.T) {
	for _, title := range []string{"<!-- hide", "<span hidden>x</span>", `<span style="display:none">x</span>`} {
		x := jsfmt.Value{Kind: jsfmt.Object}
		x.Set("key", jsfmt.StringValue("S-1"))
		x.Set("title", jsfmt.StringValue(title))
		x.Set("summary", jsfmt.StringValue(title+" & more"))
		x.Set("body", jsfmt.StringValue("diff"))
		text, _ := shownText(x)
		if strings.Contains(text, "<!--") || strings.Contains(text, "<span") || !strings.Contains(text, "&amp; more") || !strings.HasSuffix(text, "\n\ndiff\n\n</details>") {
			t.Errorf("shownText(%q) = %q", title, text)
		}
	}
	x := jsfmt.Value{Kind: jsfmt.Object}
	x.Set("key", jsfmt.StringValue("S-1"))
	x.Set("title", jsfmt.StringValue(`a "b"`))
	if text, _ := shownText(x); !strings.Contains(text, "a &quot;b&quot;") {
		t.Errorf("a quote: %q", text)
	}
}

// An ask whose snapshot the mail cap cut off records no revision (S-2998), so its thread's Approve fails closed.
func TestItsaAskCutOffRecordsNoRevision(t *testing.T) {
	t.Setenv("STAM_MAIL_BODY_CHARS", "300")
	f := newFixture(t, nil)
	// The table as recordShownRev makes it, so a count of none reads as none.
	f.sql("CREATE TABLE IF NOT EXISTS itsa_shown_revs (mail_id TEXT PRIMARY KEY, itsa_id TEXT NOT NULL, rev TEXT NOT NULL)")
	f.sql("UPDATE agents SET model = 'claude-opus-5-5' WHERE name = 'boss'")
	key := f.createItsa(`{"title":"Near the cap","body":"diff","owner":"boss","status":"in_progress"}`)
	f.post2("POST", "/api/itsas/"+key+"/post", `{"by":"boss","body":"`+strings.Repeat("y", 280)+`"}`)
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"needs_approval","by":"boss"}`); rec.Code != 200 {
		t.Fatalf("to needs_approval: %d %s", rec.Code, rec.Body.String())
	}
	var ask, body string
	for i := 0; i < 200 && ask == ""; i++ {
		must(t, f.db.Read(context.Background(), func(conn *sqlite.Conn) error {
			return sqlitex.Execute(conn, "SELECT m.id, m.body FROM mail m JOIN itsas x ON x.thread_id = m.thread_id WHERE x.key = ? AND m.kind = 'ask'", &sqlitex.ExecOptions{Args: []any{key}, ResultFunc: func(stmt *sqlite.Stmt) error { ask, body = stmt.ColumnText(0), stmt.ColumnText(1); return nil }})
		}))
		if ask == "" {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if ask == "" || !strings.Contains(body, "body truncated") {
		t.Fatalf("the ask wasn't cut: %q", body)
	}
	if n := f.count("SELECT COUNT(*) FROM itsa_shown_revs WHERE mail_id = ?", ask); n != 0 {
		t.Errorf("a cut ask recorded a revision")
	}
	if rec := f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"approve","text":"","shown_mail":"`+ask+`"}`); rec.Code != 409 {
		t.Errorf("Approve from the cut ask: %d %s", rec.Code, rec.Body.String())
	}
}

// A title or comment with markup can't hide the ask's snapshot (S-2998): the snapshot comes first and the title is escaped
// in the whole ask; and a cut mail records no revision, though a hidden copy of the snapshot survives in it.
func TestItsaAskHiddenCopyAndTitle(t *testing.T) {
	t.Setenv("STAM_MAIL_BODY_CHARS", "600")
	f := newFixture(t, nil)
	f.sql("CREATE TABLE IF NOT EXISTS itsa_shown_revs (mail_id TEXT PRIMARY KEY, itsa_id TEXT NOT NULL, rev TEXT NOT NULL)")
	f.sql("UPDATE agents SET model = 'claude-opus-5-5' WHERE name = 'boss'")
	key := f.createItsa(`{"title":"x <div hidden>","body":"real diff","owner":"boss","status":"in_progress"}`)
	x := f.body(f.post2("GET", "/api/itsas/"+key, ""))
	copyText, _ := shownText(x)
	comment, err := json.Marshal(map[string]string{"by": "boss", "body": "<style>details{display:none!important}</style>\n\n<div style=\"position:fixed;inset:0\">cover</div>\n\n<div hidden>\n\n" + copyText + "\n\n<!-- hide\n\n" + strings.Repeat("y", 600)})
	must(t, err)
	f.post2("POST", "/api/itsas/"+key+"/post", string(comment))
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"needs_approval","by":"boss"}`); rec.Code != 200 {
		t.Fatalf("to needs_approval: %d %s", rec.Code, rec.Body.String())
	}
	var ask, body string
	for i := 0; i < 200 && ask == ""; i++ {
		must(t, f.db.Read(context.Background(), func(conn *sqlite.Conn) error {
			return sqlitex.Execute(conn, "SELECT m.id, m.body FROM mail m JOIN itsas x ON x.thread_id = m.thread_id WHERE x.key = ? AND m.kind = 'ask'", &sqlitex.ExecOptions{Args: []any{key}, ResultFunc: func(stmt *sqlite.Stmt) error { ask, body = stmt.ColumnText(0), stmt.ColumnText(1); return nil }})
		}))
		if ask == "" {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if !strings.HasPrefix(body, copyText) || !strings.Contains(body, "x &lt;div hidden&gt;") || !strings.Contains(body, "body truncated") {
		t.Fatalf("the ask: %q", body)
	}
	if strings.Index(body, "<style>") < len(copyText) {
		t.Fatalf("the comment's CSS should follow the snapshot: %q", body)
	}
	if n := f.count("SELECT COUNT(*) FROM itsa_shown_revs WHERE mail_id = ?", ask); n != 0 {
		t.Error("a cut ask with a copy of its snapshot recorded a revision")
	}
}

// shownAt is where a body holds its snapshot, in UTF-16 units (S-2998): at its start or end only.
func TestItsaShownAt(t *testing.T) {
	for _, c := range []struct {
		body, text string
		at         int
		ok         bool
	}{
		{"SNAP rest", "SNAP", 0, true},
		{"før 💡 SNAP", "SNAP", 7, true},
		{"a SNAP b", "SNAP", 0, false},
		{"SNAP", "", 0, false},
	} {
		if at, ok := shownAt(c.body, c.text); at != c.at || ok != c.ok {
			t.Errorf("shownAt(%q, %q) = %d, %v; want %d, %v", c.body, c.text, at, ok, c.at, c.ok)
		}
	}
}

// A table made before at and len (S-2998): its old rows serve no range, and the next ask adds the columns and records one.
func TestItsaShownRangeOnAnOldTable(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("DROP TABLE IF EXISTS itsa_shown_revs")
	f.sql("CREATE TABLE itsa_shown_revs (mail_id TEXT PRIMARY KEY, itsa_id TEXT NOT NULL, rev TEXT NOT NULL)")
	f.sql("UPDATE agents SET model = 'claude-opus-5-5' WHERE name = 'boss'")
	key := f.createItsa(`{"title":"Old table","body":"diff","owner":"boss","status":"in_progress"}`)
	f.post2("POST", "/api/itsas/"+key+"/post", `{"by":"boss","body":"ready"}`)
	f.sql("INSERT INTO itsa_shown_revs (mail_id, itsa_id, rev) SELECT m.id, x.id, 'old' FROM mail m JOIN itsas x ON x.thread_id = m.thread_id WHERE x.key = ?", key)
	shown := func() []string {
		var out []string
		v := f.body(f.post2("GET", "/api/itsas/"+key+"/thread", ""))
		items, _ := v.Get("items")
		for _, it := range items.Items {
			m, _ := it.Get("mail")
			if s, ok := m.Get("shown"); ok {
				out = append(out, m.Text("kind")+":"+jsfmt.Compact(s))
			}
		}
		return out
	}
	if got := shown(); len(got) != 0 {
		t.Errorf("an old row served a range: %v", got)
	}
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"needs_approval","by":"boss"}`); rec.Code != 200 {
		t.Fatalf("to needs_approval: %d %s", rec.Code, rec.Body.String())
	}
	var got []string
	for i := 0; i < 200 && len(got) == 0; i++ {
		if got = shown(); len(got) == 0 {
			time.Sleep(10 * time.Millisecond)
		}
	}
	x := f.body(f.post2("GET", "/api/itsas/"+key, ""))
	text, _ := shownText(x)
	if want := fmt.Sprintf(`ask:{"at":0,"len":%d}`, utf16Len(text)); len(got) != 1 || got[0] != want {
		t.Errorf("the ask's range: %v, want %s", got, want)
	}
}

// stepStarts is the reference's start time of each step (expect.json's starts).
func stepStarts(want jsfmt.Value) []string {
	var out []string
	v, _ := want.Get("starts")
	for _, it := range v.Items {
		out = append(out, it.Str)
	}
	return out
}

// stepOrder puts a thread's items in an order that doesn't hang on the clock (S-4140), and tags each with the step that
// wrote it. The thread sorts by ts in milliseconds, mails first on a tie, so a status event and the ask mail its move sends
// come out either way, on either daemon, by whether they shared a millisecond: within a step, events go before mails.
// Across steps the served order must already hold (every step starts at least 3 ms after the last one ended), so a step
// that goes back is an error, not something to repair. The step stays in each item, so an item that lands in another
// step on one daemon compares unequal even where its position matches.
func stepOrder(v jsfmt.Value, starts []string) (jsfmt.Value, error) {
	items, ok := v.Get("items")
	if !ok || items.Kind != jsfmt.Array {
		return v, nil
	}
	type tagged struct {
		step int
		item jsfmt.Value
	}
	sorted := make([]tagged, len(items.Items))
	for i, it := range items.Items {
		n := sort.SearchStrings(starts, it.Text("ts")+"\uffff") - 1
		if i > 0 && n < sorted[i-1].step {
			return v, fmt.Errorf("item %d (ts %s) is of step %d, after an item of step %d", i, it.Text("ts"), n, sorted[i-1].step)
		}
		it.Keys, it.Items = append([]string(nil), it.Keys...), append([]jsfmt.Value(nil), it.Items...)
		it.Set("step", jsfmt.IntValue(int64(n)))
		sorted[i] = tagged{n, it}
	}
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].step == sorted[j].step && sorted[i].item.Text("type") == "event" && sorted[j].item.Text("type") != "event"
	})
	out := make([]jsfmt.Value, len(sorted))
	for i, x := range sorted {
		out[i] = x.item
	}
	v.Keys, v.Items = append([]string(nil), v.Keys...), append([]jsfmt.Value(nil), v.Items...)
	v.Set("items", jsfmt.ArrayValue(out))
	return v, nil
}

// A status event and a mail of the same millisecond come out mail first, as src/itsa.ts mergeThread's stable sort puts
// them; an earlier event still comes first (S-4140).
func TestItsaThreadTie(t *testing.T) {
	f := newFixture(t, nil)
	key := f.createItsa(`{"title":"Tie"}`)
	id := f.itsaID(key)
	f.sql("UPDATE itsas SET thread_id = 'th1' WHERE id = ?", id)
	f.sql("INSERT INTO mail (id, from_id, subject, body, created_at, thread_id, kind) VALUES ('mt1', 'achild', 's', 'the ask', '2026-10-01T00:00:00.005Z', 'th1', 'ask')")
	f.sql(`INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, '2026-10-01T00:00:00.005Z', 'achild', 'status', '{"from":"backlog","to":"needs_input"}')`, id)
	f.sql(`INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, '2026-10-01T00:00:00.004Z', 'achild', 'owner', '{"from":null,"to":"achild"}')`, id)
	got := f.body(f.post2("GET", "/api/itsas/"+key+"/thread", ""))
	items, _ := got.Get("items")
	var order []string
	for _, it := range items.Items {
		order = append(order, it.Text("type")+":"+it.Text("event"))
	}
	if strings.Join(order, " ") != "event:owner mail: event:status" {
		t.Errorf("order %q", order)
	}
}

// stepOrder gives one order for a thread whose items within a step came out either way, refuses one whose steps go back,
// and keeps each item's step, so an item in another step compares unequal.
func TestStepOrder(t *testing.T) {
	starts := []string{"2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.010Z", "2026-10-01T00:00:00.020Z"}
	order := func(items ...string) (string, error) {
		v, err := jsfmt.Parse([]byte(`{"itsa":{"key":"S-1"},"items":[` + strings.Join(items, ",") + `]}`))
		must(t, err)
		o, err := stepOrder(v, starts)
		return maskedPost(jsfmt.Compact(o)), err
	}
	mustOrder := func(items ...string) string {
		t.Helper()
		s, err := order(items...)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	post := `{"type":"mail","ts":"2026-10-01T00:00:00.001Z","mail":{"id":"m1"}}`
	// Step 1's move: the event and its ask in the same millisecond (mail first), or the ask a millisecond later.
	evSame := `{"type":"event","ts":"2026-10-01T00:00:00.012Z","id":7}`
	askSame := `{"type":"mail","ts":"2026-10-01T00:00:00.012Z","mail":{"id":"m2"}}`
	askLate := `{"type":"mail","ts":"2026-10-01T00:00:00.013Z","mail":{"id":"m2"}}`
	later := `{"type":"event","ts":"2026-10-01T00:00:00.021Z","id":8}`
	a, b := mustOrder(post, askSame, evSame, later), mustOrder(post, evSame, askLate, later)
	if a != b {
		t.Errorf("one step's two orders differ:\n %s\n %s", a, b)
	}
	if !strings.Contains(a, `"mail":{"id":"m1"},"step":0},{"type":"event"`) || !strings.Contains(a, `"id":7,"step":1},{"type":"mail"`) {
		t.Errorf("order: %s", a)
	}
	// Two steps served backwards are refused, not repaired: step 2's event before step 1's mail.
	if s, err := order(post, later, askSame); err == nil || !strings.Contains(err.Error(), "is of step 1, after an item of step 2") {
		t.Errorf("steps out of order: %v %s", err, s)
	}
	// The same item, at the same place, in another step (masking drops the ts): the step is part of what compares.
	movedPost := `{"type":"mail","ts":"2026-10-01T00:00:00.011Z","mail":{"id":"m1"}}`
	if x, y := mustOrder(post, later), mustOrder(movedPost, later); x == y || strings.ReplaceAll(x, `"step":0`, `"step":1`) != y {
		t.Errorf("an item in another step compared equal, or differed by more than its step:\n %s\n %s", x, y)
	}
}

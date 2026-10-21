package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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
	for i, st := range steps {
		// The reference waits between steps, so every change has a time of its own.
		time.Sleep(3 * time.Millisecond)
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
	for _, tok := range []string{agentTok, serverTok} {
		if rec := f.sendH("POST", "/api/itsas/"+key+"/act", tok, nil, `{"action":"approve"}`); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "only the human acts on an ITSA that waits on them") {
			t.Errorf("act with %s: %d %s", tok, rec.Code, rec.Body.String())
		}
	}
	if rec := f.sendH("POST", "/api/itsas/"+key+"/act", sharedTok, nil, `{"action":"approve"}`); rec.Code != 403 {
		t.Errorf("act with the shared token and no human: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"approve"}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"to":"in_progress"`) {
		t.Errorf("act as the human: %d %s", rec.Code, rec.Body.String())
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
	pr := "https://github.com/some-org/some-repo/pull/12"
	f.sql("CREATE TABLE IF NOT EXISTS decision_steps (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL, question TEXT NOT NULL, threshold REAL NOT NULL DEFAULT 0.5, action TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, builtin TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
	mails := func() int { return f.count("SELECT COUNT(*) FROM mail") }
	act := func(key, action, text string) *httptest.ResponseRecorder {
		return f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"`+action+`","text":"`+text+`"}`)
	}
	for _, tc := range []struct {
		name, status, action, contains string
		setup, teardown                string
	}{
		{"an approval that closes an ITSA with a followed pull request", "needs_test", "approve", "watch.syncItsa",
			"INSERT INTO itsa_links (itsa_id, n, system, external_id, url) SELECT id, 90, 'github', '12', '" + pr + "' FROM itsas WHERE status = 'needs_test'",
			"DELETE FROM itsa_links"},
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

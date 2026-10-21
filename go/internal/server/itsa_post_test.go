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
	"strconv"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
)

var reItsaIDWord = regexp.MustCompile(`\bi[a-km-np-z2-9]{4}\b`)

// maskedPost hides what differs between two runs: mail ids, ITSA ids (numbered in the order they appear) and the times.
func maskedPost(s string) string {
	ids := map[string]string{}
	s = reItsaIDWord.ReplaceAllStringFunc(s, func(id string) string {
		if _, ok := ids[id]; !ok {
			ids[id] = "I" + strconv.Itoa(len(ids))
		}
		return ids[id]
	})
	return masked(s)
}

// TestItsaPostMatchesTS runs the steps of testdata/post-steps.json through src/itsa.ts post and src/mail.ts sendMail on one
// database and through POST /api/itsas/:ref/post and POST /api/mail on a copy of it, and compares every answer, status and
// error, and the tables the steps leave behind.
func TestItsaPostMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/itsa.ts")
	}
	home := filepath.Join(t.TempDir(), "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/postref.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("postref.mjs: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "expect.json"))
	must(t, err)
	want, err := jsfmt.Parse(raw)
	must(t, err)

	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.pre.db"))
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"itsa":{"ownerNotices":"off"}}`)
	stepsRaw, err := os.ReadFile("testdata/post-steps.json")
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
		var code int
		var respBody []byte
		switch st.Op {
		case "sql":
			must(t, f.db.Write(context.Background(), func(conn *sqlite.Conn) error {
				return sqlitex.ExecuteScript(conn, st.SQL, nil)
			}))
			ids = append(ids, "")
			continue
		case "create":
			rec := f.post2("POST", "/api/itsas", subJSON(st.Input))
			code, respBody = rec.Code, rec.Body.Bytes()
		case "post":
			body, perr := jsfmt.Parse([]byte(subJSON(st.Input)))
			must(t, perr)
			by := st.By
			if by == "" {
				by = "human"
			}
			if strings.HasPrefix(by, "system:") {
				body.Set("as_system", jsfmt.StringValue(strings.TrimPrefix(by, "system:")))
			} else {
				body.Set("by", jsfmt.StringValue(by))
			}
			ref := st.Ref
			if strings.HasPrefix(ref, "#") {
				n, _ := strconv.Atoi(ref[1:])
				ref = ids[n]
			}
			rec := f.post2("POST", "/api/itsas/"+ref+"/post", jsfmt.Compact(body))
			code, respBody = rec.Code, rec.Body.Bytes()
		case "mail":
			rec := f.post2("POST", "/api/mail", subJSON(st.Input))
			code, respBody = rec.Code, rec.Body.Bytes()
		}
		exp := wantResults.Items[i]
		if wc := int(mustInt(t, exp, "status")); code != wc {
			t.Errorf("step %d (%s %s): status %d, TS %d\n go: %s\n ts: %s", i, st.Op, st.Input, code, wc, respBody, jsfmt.Compact(exp))
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
			t.Errorf("step %d (%s %s):\n go: %s\n ts: %s", i, st.Op, st.Input, g, w)
		}
		id := ""
		if code == 200 {
			id = got.Text("id")
		}
		ids = append(ids, id)
	}

	wantTables, _ := want.Get("tables")
	queries := map[string]string{
		"mail":         "SELECT id, from_id, from_name, subject, body, created_at, thread_id, reply_to, permission_id, auto_threaded, notice, itsa_id, kind, health, about_itsa, verdict, override, note FROM mail ORDER BY rowid",
		"recipients":   "SELECT mail_id, agent_id, read_at, quiet FROM mail_recipients ORDER BY rowid",
		"mailItsas":    "SELECT mail_id, itsa_id, source FROM mail_itsas ORDER BY rowid",
		"itsas":        "SELECT id, key, title, owner, thread_id FROM itsas ORDER BY rowid",
		"participants": "SELECT itsa_id, agent_id FROM itsa_participants ORDER BY rowid",
		"events":       "SELECT agent_id, type, data FROM events ORDER BY id",
		"decisions":    "SELECT mail_id, thread_id FROM decision_mails ORDER BY rowid",
		"deferred":     "SELECT thread_id, mail_id FROM thread_deferred ORDER BY rowid",
	}
	for i, name := range wantTables.Keys {
		got := dump(t, f, queries[name])
		expect := wantTables.Items[i]
		if name == "events" {
			var kept []jsfmt.Value
			for _, e := range expect.Items {
				if e.Text("type") != "notice:queued" {
					kept = append(kept, e)
				}
			}
			expect = jsfmt.ArrayValue(kept)
		}
		if a, b := maskedPost(jsfmt.Compact(expect)), maskedPost(jsfmt.Compact(got)); a != b {
			t.Errorf("table %s differs\n ts: %s\n go: %s", name, a, b)
		}
	}
}

// Who may post: an agent's token posts only to an ITSA it belongs to (or an open board), says how to join, and may not set
// the fields only stam sets; stam's own post, the ask mail and the shapes TS would coerce answer 501.
func TestItsaPostRules(t *testing.T) {
	f := newFixture(t, nil)
	if rec := f.sendH("POST", "/api/itsas", sharedTok, human, `{"title":"Alpha"}`); rec.Code != 200 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	post := func(token string, hdr map[string]string, body string) *httptest.ResponseRecorder {
		return f.sendH("POST", "/api/itsas/S-1/post", token, hdr, body)
	}
	rec := post(agentTok, nil, `{"body":"hello"}`)
	if rec.Code != 403 || !strings.Contains(errorOf(t, rec), "can't post to S-1") || !strings.Contains(errorOf(t, rec), "to add you with itsa_set participants") {
		t.Errorf("an agent outside the ITSA: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("UPDATE itsas SET kind = 'feedback-report' WHERE key = 'S-1'")
	if rec := post(agentTok, nil, `{"body":"hello"}`); rec.Code != 200 {
		t.Errorf("an agent on an open board: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("UPDATE itsas SET kind = 'issue' WHERE key = 'S-1'")
	if rec := post(agentTok, nil, `{"body":"hello again"}`); rec.Code != 200 {
		t.Errorf("a participant (the earlier post joined): %d %s", rec.Code, rec.Body.String())
	}
	for _, field := range []string{"itsa_id", "thread_id", "mail_id", "interrupt"} {
		if rec := post(agentTok, nil, `{"body":"x","`+field+`":"v"}`); rec.Code != 403 || !strings.Contains(errorOf(t, rec), field+" is set only by stam, not in an agent's post") {
			t.Errorf("%s from an agent: %d %s", field, rec.Code, rec.Body.String())
		}
	}
	if rec := post(agentTok, nil, `{"body":"x","kind":"update","health":"on_track"}`); rec.Code != 200 {
		t.Errorf("kind and health are a post's own: %d %s", rec.Code, rec.Body.String())
	}
	if rec := post(sharedTok, human, `{"body":"x","from_stam":true}`); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "from_stam is set only by stam") {
		t.Errorf("from_stam from the human: %d %s", rec.Code, rec.Body.String())
	}
	// Stam's own post and its ask mail are the daemon's: the route sets them only for the daemon itself, and they land as
	// notices from the stand-in agent without joining the ITSA (itsa_ask_test.go compares them with TS).
	// The stand-in sender is no one's reply: a wait declared on it survives stam's own post (TS clearDeclaredWaits skips it).
	standIn, _, err := f.db.FirstActiveAgentID(context.Background())
	must(t, err)
	f.sql("INSERT INTO waits (id, agent_id, kind, target, since, source) SELECT 'w-' || agent_id, agent_id, 'agent', ?, 's', 'declared' FROM itsa_participants", standIn)
	waits := f.count("SELECT COUNT(*) FROM waits WHERE source = 'declared' AND target = ?", standIn)
	if waits == 0 {
		t.Fatal("no declared waits on the stand-in to keep")
	}
	for _, ask := range []bool{false, true} {
		in, _ := jsfmt.Parse([]byte(`{"body":"x","by":"human","from_stam":true}`))
		if ask {
			in, _ = jsfmt.Parse([]byte(`{"body":"x","by":"human"}`))
		}
		if _, err := f.srv.post(context.Background(), "S-1", in, ask); err != nil {
			t.Errorf("stam's own post (ask %v): %v", ask, err)
		}
	}
	if n := f.count("SELECT COUNT(*) FROM waits WHERE source = 'declared' AND target = ?", standIn); n != waits {
		t.Errorf("stam's own post cleared declared waits on the stand-in: %d left of %d", n, waits)
	}
	for _, tc := range []struct{ body, what string }{
		{`{"body":"x","attachments":[{"name":"a","content":"b"}]}`, "attachments"},
		{`{"body":"x","to":"aw1"}`, "`to` that is not a list"},
		{`{"body":"x","to":[5]}`, "`to` with an entry"},
		{`{"body":"x","inferred":"a"}`, "`inferred` that is not a list"},
		{`{"body":"x","subject":5}`, "`subject` that is not a string"},
		{`{"body":"x","only":"a"}`, "`only` that is not a list"},
	} {
		if rec := post(sharedTok, human, tc.body); rec.Code != 501 || !strings.Contains(errorOf(t, rec), tc.what) {
			t.Errorf("%s: %d %s", tc.body, rec.Code, rec.Body.String())
		}
	}
	// Nothing was stored for the refused ones: three posts landed (the board post, the follow-up and the update), and
	// stam's two.
	if n := f.count("SELECT COUNT(*) FROM mail WHERE itsa_id IS NOT NULL"); n != 5 {
		t.Errorf("%d ITSA mails, want 5", n)
	}
	if rec := f.sendH("POST", "/api/itsas/S-1/post", sharedTok, human, `{"body":"x"}`); rec.Code != 200 {
		t.Errorf("the human: %d %s", rec.Code, rec.Body.String())
	}
}

// The observers of a stored mail that this daemon does not carry: while requirements are on, a mail from anyone but the human
// answers 501 and stores nothing; so does an agent's mail to the human while a decision step runs on mail-to-human.
func TestItsaPostObservers(t *testing.T) {
	f := newFixture(t, nil)
	if rec := f.sendH("POST", "/api/itsas", sharedTok, human, `{"title":"Alpha","owner":"child"}`); rec.Code != 200 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	post := func(body string) *httptest.ResponseRecorder {
		return f.sendH("POST", "/api/itsas/S-1/post", sharedTok, human, body)
	}
	writeFile(t, f.home+"/settings.json", `{"requirements":{"enabled":true}}`)
	if rec := f.sendH("POST", "/api/itsas/S-1/post", agentTok, nil, `{"body":"x"}`); rec.Code != 200 {
		t.Errorf("an agent's post with requirements on is checked after the write: %d %s", rec.Code, rec.Body.String())
	}
	if rec := post(`{"body":"x"}`); rec.Code != 200 {
		t.Errorf("the human's post with requirements on: %d %s", rec.Code, rec.Body.String())
	}
	writeFile(t, f.home+"/settings.json", `{"chiefOfStaff":"coder"}`)
	f.sql("CREATE TABLE decision_steps (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL, question TEXT NOT NULL, threshold REAL NOT NULL DEFAULT 0.5, action TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, builtin TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
	f.sql(`INSERT INTO decision_steps (id, name, trigger, question, action, enabled, created_at, updated_at) VALUES ('s1', 'n', '{"kind":"event","event":"mail-to-human"}', 'q', '{}', 1, 'x', 'x')`)
	n := f.count("SELECT COUNT(*) FROM mail")
	if rec := post(`{"body":"x","by":"coder","to":["human"]}`); rec.Code != 501 || !strings.Contains(errorOf(t, rec), "mail-to-human") {
		t.Errorf("a post to the human with a step on mail-to-human: %d %s", rec.Code, rec.Body.String())
	}
	if m := f.count("SELECT COUNT(*) FROM mail"); m != n {
		t.Errorf("a refused post stored %d mails", m-n)
	}
	if rec := post(`{"body":"x","by":"coder"}`); rec.Code != 200 {
		t.Errorf("a post that does not reach the human: %d %s", rec.Code, rec.Body.String())
	}
}

// A post that answers 501 writes nothing: the ITSA's thread is not started and the sender does not join (S-2849).
func TestItsaPost501WritesNothing(t *testing.T) {
	f := newFixture(t, nil)
	f.createItsa(`{"title":"Alpha","owner":"child"}`)
	f.createItsa(`{"title":"Beta","owner":"child"}`)
	f.createItsa(`{"title":"Gamma","owner":"child"}`)
	post := func(ref, body string) *httptest.ResponseRecorder {
		return f.sendH("POST", "/api/itsas/"+ref+"/post", sharedTok, human, body)
	}
	state := func(ref string) string {
		return fmt.Sprintf("thread %d; participants %v", f.count("SELECT COUNT(*) FROM itsas WHERE key = ? AND thread_id IS NOT NULL", ref),
			f.count("SELECT COUNT(*) FROM itsa_participants p JOIN itsas i ON i.id = p.itsa_id WHERE i.key = ?", ref))
	}
	same := func(what, ref string, rec *httptest.ResponseRecorder, before string) {
		t.Helper()
		if rec.Code != 501 {
			t.Fatalf("%s: %d %s", what, rec.Code, rec.Body.String())
		}
		if after := state(ref); after != before {
			t.Errorf("%s: the refused post wrote: %s, was %s", what, after, before)
		}
	}
	writeFile(t, f.home+"/settings.json", `{"chiefOfStaff":"coder"}`)
	before := state("S-1")
	same("an embedded file", "S-1", post("S-1", "{\"body\":\"look\\n```embed\\nhttps://example.com/x\\n```\",\"by\":\"coder\"}"), before)
	f.sql("CREATE TABLE decision_steps (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL, question TEXT NOT NULL, threshold REAL NOT NULL DEFAULT 0.5, action TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, builtin TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
	f.sql(`INSERT INTO decision_steps (id, name, trigger, question, action, enabled, created_at, updated_at) VALUES ('s1', 'n', '{"kind":"event","event":"mail-to-human"}', 'q', '{}', 1, 'x', 'x')`)
	same("a step on mail-to-human", "S-1", post("S-1", `{"body":"x","by":"coder","to":["human"]}`), before)

	// A plain mail that answers a mail of an ITSA's thread is a comment on it: the same refusal, the same silence.
	f.sql("DELETE FROM decision_steps")
	rec := post("S-2", `{"body":"first"}`)
	if rec.Code != 200 {
		t.Fatalf("the human's post: %d %s", rec.Code, rec.Body.String())
	}
	mailID := f.body(rec).Text("id")
	f.sql(`INSERT INTO decision_steps (id, name, trigger, question, action, enabled, created_at, updated_at) VALUES ('s1', 'n', '{"kind":"event","event":"mail-to-human"}', 'q', '{}', 1, 'x', 'x')`)
	before = state("S-2")
	same("a reply that is a comment", "S-2", f.post2("POST", "/api/mail", `{"from":"coder","to":["human"],"reply_to":"`+mailID+`","body":"x"}`), before)
}

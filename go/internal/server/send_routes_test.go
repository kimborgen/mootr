package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
)

var human = map[string]string{"X-Stam-Human": "1"}

func (f *fixture) post(token string, header map[string]string, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.sendH("POST", "/api/mail", token, header, body)
}

func errorOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var b map[string]any
	must(t, json.Unmarshal(rec.Body.Bytes(), &b))
	s, _ := b["error"].(string)
	return s
}

func (f *fixture) count(query string, args ...any) int {
	f.t.Helper()
	n := 0
	must(f.t, f.db.Read(context.Background(), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error { n = stmt.ColumnInt(0); return nil }})
	}))
	return n
}

// Who may send as whom, and what only stam sets.
func TestSendRefusals(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET harness = 'opencode' WHERE id = 'agone'")
	for _, tc := range []struct {
		name, token string
		header      map[string]string
		body        string
		status      int
		error       string
	}{
		{"an agent as itself", agentTok, nil, `{"to":["aboss"],"subject":"s","body":"b","new_thread":true}`, 200, ""},
		{"an agent naming itself", agentTok, nil, `{"from":"child","to":["aboss"],"subject":"s","body":"b","new_thread":true}`, 200, ""},
		{"an agent as another", agentTok, nil, `{"from":"aboss","to":["agone"],"subject":"s","body":"b","new_thread":true}`, 403, "agent child can't act as aboss"},
		{"an agent as the human", agentTok, nil, `{"from":"human","to":["aboss"],"subject":"s","body":"b","new_thread":true}`, 403, "agent child can't act as human"},
		{"an agent setting a stam field", agentTok, nil, `{"to":["aboss"],"subject":"s","body":"b","itsa_id":"x"}`, 403, "itsa_id is set only by stam, not in an agent's mail"},
		{"an agent setting two", agentTok, nil, `{"to":["aboss"],"subject":"s","body":"b","kind":"ask","thread_id":"m1"}`, 403, "thread_id, kind are set only by stam"},
		{"an agent as a system sender", agentTok, nil, `{"to":["aboss"],"subject":"s","body":"b","system":"deploy-watch"}`, 403, "system is set only by stam"},
		{"the OpenCode server naming no one", serverTok, nil, `{"to":["aboss"],"subject":"s","body":"b"}`, 403, "the OpenCode server's request must name its agent (by, from, or self)"},
		{"the OpenCode server naming a Claude agent", serverTok, nil, `{"from":"child","to":["aboss"],"subject":"s","body":"b"}`, 403, "the OpenCode server can't act as child"},
		{"the OpenCode server naming its agent", serverTok, nil, `{"from":"gone","to":["aboss"],"subject":"s","body":"b","new_thread":true}`, 200, ""},
		{"the OpenCode server naming its agent in by", serverTok, nil, `{"by":"gone","to":["aboss"],"subject":"s","body":"b","new_thread":true}`, 200, ""},
		{"the shared token as an agent with a token", sharedTok, human, `{"from":"child","to":["aboss"],"subject":"s","body":"b"}`, 403, "the shared token can't act as child: it has its own token"},
		{"the shared token as an agent with none", sharedTok, human, `{"from":"coder","to":["aboss"],"subject":"s","body":"b","new_thread":true}`, 200, ""},
		{"the shared token as the human, no proof", sharedTok, nil, `{"from":"human","to":["aboss"],"subject":"s","body":"b"}`, 403, "only the human mails as the human"},
		{"the shared token as the human", sharedTok, human, `{"from":"human","to":["aboss"],"subject":"s","body":"b","new_thread":true}`, 200, ""},
		{"a system sender from the shared token", sharedTok, nil, `{"system":"deploy-watch","to":["aboss"],"subject":"s","body":"b","new_thread":true}`, 200, ""},
		{"another system sender from the shared token", sharedTok, nil, `{"system":"somebody","to":["aboss"],"subject":"s","body":"b"}`, 403, "only the human mails as a system sender"},
		{"from_stam", sharedTok, human, `{"from":"aboss","to":["agone"],"subject":"s","body":"b","from_stam":true}`, 403, "from_stam is set only by stam"},
		{"forwarded mail", sharedTok, human, `{"from":"aboss","to":["agone"],"subject":"s","body":"b","forwarded":{"from_name":"x"}}`, 501, "forwarded mail is not ported"},
		{"a peer's mail", peerTok, map[string]string{"X-Stam-Local": "1"}, `{"from":"aboss","to":["agone"],"subject":"s","body":"b"}`, 501, "mail forwarded by a peer is not ported"},
		{"attachments", sharedTok, human, `{"from":"aboss","to":["agone"],"subject":"s","body":"b","attachments":[{"name":"a","content":"x"}]}`, 501, "attachments are not ported"},
		{"an ITSA", sharedTok, human, `{"from":"aboss","to":["agone"],"subject":"s","body":"b","itsa":"S-1"}`, 501, "itsa is not ported"},
		{"supersedes", agentTok, nil, `{"to":["aboss"],"subject":"s","body":"b","supersedes":"m1"}`, 501, "supersedes is not ported"},
		{"an embed block", sharedTok, human, "{\"from\":\"aboss\",\"to\":[\"agone\"],\"subject\":\"s\",\"body\":\"```image\\nx\\n```\"}", 501, "embedded files"},
		{"no text", agentTok, nil, `{"to":["aboss"],"subject":"s"}`, 400, "body is required: the mail's text"},
		{"blank text", agentTok, nil, `{"to":["aboss"],"subject":"s","body":"  ","message":"\n"}`, 400, "body is required"},
		{"text as message", agentTok, nil, `{"to":"aboss","subject":"s","message":"hi","new_thread":true}`, 200, ""},
		{"no recipient", agentTok, nil, `{"subject":"s","body":"b"}`, 400, "to must be"},
		{"an empty list", agentTok, nil, `{"to":[],"subject":"s","body":"b","new_thread":true}`, 400, "no recipients"},
		{"nobody", agentTok, nil, `{"to":["nobody"],"subject":"s","body":"b","new_thread":true}`, 400, "no agent nobody"},
		{"no subject", agentTok, nil, `{"to":["aboss"],"body":"b","new_thread":true}`, 500, "subject is required for a new thread"},
		{"an array body", agentTok, nil, `[1]`, 400, "the body must be a JSON object"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := f.post(tc.token, tc.header, tc.body)
			if rec.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", rec.Code, tc.status, rec.Body.String())
			}
			if tc.error != "" && !strings.Contains(errorOf(t, rec), tc.error) {
				t.Fatalf("error %q, want it to hold %q", errorOf(t, rec), tc.error)
			}
			for _, tok := range []string{sharedTok, agentTok, peerTok, serverTok} {
				if strings.Contains(rec.Body.String(), tok) {
					t.Fatalf("the answer holds a token")
				}
			}
		})
	}
	// Only the sends that answered 200 stored a mail (the seed holds three): 8 in the table, 1 more as the notice.
	if n := f.count("SELECT COUNT(*) FROM mail WHERE id NOT IN ('m1', 'm2', 'm3')"); n != 8 {
		t.Errorf("%d mails stored by the table's sends, want 8", n)
	}
}

// A retry with the same client_id gets the first answer and stores nothing again; another caller, or the same words after
// reading other mail, is another send.
func TestSendClientDedup(t *testing.T) {
	f := newFixture(t, nil)
	body := `{"to":["aboss"],"subject":"once","body":"b","new_thread":true,"client_id":"c1"}`
	first := f.post(agentTok, nil, body)
	if first.Code != 200 {
		t.Fatal(first.Body.String())
	}
	again := f.post(agentTok, nil, body)
	if again.Body.String() != first.Body.String() {
		t.Errorf("the retry got another answer\n 1: %s\n 2: %s", first.Body.String(), again.Body.String())
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE subject = 'once'"); n != 1 {
		t.Errorf("%d mails stored", n)
	}
	// Another credential's send with the same id is its own.
	other := f.post(sharedTok, map[string]string{"X-Stam-Human": "1"}, `{"from":"coder","to":["aboss"],"subject":"once","body":"b","new_thread":true,"client_id":"c1"}`)
	if other.Code != 200 || other.Body.String() == first.Body.String() {
		t.Errorf("another caller was handed the first answer: %d %s", other.Code, other.Body.String())
	}
	// A different client_id is a different send, and an id over 100 characters is no id.
	f.post(agentTok, nil, strings.Replace(body, `"c1"`, `"c2"`, 1))
	long := strings.Replace(body, `"c1"`, `"`+strings.Repeat("x", 101)+`"`, 1)
	f.post(agentTok, nil, long)
	f.post(agentTok, nil, long)
	if n := f.count("SELECT COUNT(*) FROM mail WHERE subject = 'once' AND from_id = 'achild'"); n != 4 {
		t.Errorf("%d mails from the agent, want 4 (c1, c2, and the long id twice)", n)
	}
	// A failed first send is forgotten, so the retry runs.
	bad := `{"to":["nobody"],"subject":"x","body":"b","new_thread":true,"client_id":"c3"}`
	if rec := f.post(agentTok, nil, bad); rec.Code != 400 {
		t.Fatal(rec.Body.String())
	}
	f.sql("UPDATE agents SET name = 'nobody' WHERE id = 'agone'")
	if rec := f.post(agentTok, nil, bad); rec.Code != 200 {
		t.Errorf("the retry after a failure: %d %s", rec.Code, rec.Body.String())
	}
	// The same words after reading other mail thread elsewhere: the key holds the agent's last read.
	scoped := `{"to":["aboss"],"subject":"scoped","body":"b","client_id":"c4"}`
	one := f.post(agentTok, nil, scoped)
	if _, _, _, err := f.db.ReadMail(context.Background(), "achild", []string{"m1"}, ""); err != nil {
		t.Fatal(err)
	}
	two := f.post(agentTok, nil, scoped)
	if one.Body.String() == two.Body.String() {
		t.Errorf("a send after a read was taken for the retry of the one before")
	}
}

// Many retries at once run once: the later ones wait for the first.
func TestSendClientDedupConcurrent(t *testing.T) {
	f := newFixture(t, nil)
	body := `{"to":["aboss"],"subject":"race","body":"b","new_thread":true,"client_id":"r1"}`
	var wg sync.WaitGroup
	answers := make([]string, 8)
	for i := range answers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i] = f.post(agentTok, nil, body).Body.String()
		}()
	}
	wg.Wait()
	for _, a := range answers {
		if a != answers[0] {
			t.Fatalf("answers differ: %s / %s", a, answers[0])
		}
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE subject = 'race'"); n != 1 {
		t.Errorf("%d mails stored, want 1", n)
	}
}

// A body past the limit is cut and kept whole as an attachment.
func TestSendLongBody(t *testing.T) {
	f := newFixture(t, map[string]string{})
	t.Setenv("STAM_MAIL_BODY_CHARS", "100")
	long := strings.Repeat("é", 150)
	rec := f.post(agentTok, nil, `{"to":["aboss"],"subject":"long","body":"`+long+`","new_thread":true}`)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	v, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	body := v.Text("body")
	if !strings.HasPrefix(body, strings.Repeat("é", 100)+"\n\n[stam: body truncated at about 5,000 tokens; the full text is in the attachment full-body.md]") {
		t.Errorf("body %q", body)
	}
	atts, _ := v.Get("attachments")
	if len(atts.Items) != 1 || atts.Items[0].Text("name") != "full-body.md" {
		t.Fatalf("attachments %s", jsfmt.Compact(atts))
	}
	got, err := os.ReadFile(atts.Items[0].Text("path"))
	must(t, err)
	if string(got) != long {
		t.Errorf("the attachment holds %q", got)
	}
	if !strings.HasPrefix(atts.Items[0].Text("path"), f.home) {
		t.Errorf("the attachment is outside the home: %s", atts.Items[0].Text("path"))
	}
}

// A thread the human starts waits in the archive; its follow-ups stay there; an answer to the human brings it back.
func TestSendHumanThreads(t *testing.T) {
	f := newFixture(t, nil)
	sent := f.post(sharedTok, human, `{"from":"human","to":["aboss"],"subject":"mine","body":"b","new_thread":true}`)
	v, _ := jsfmt.Parse(sent.Body.Bytes())
	tid, id := v.Text("thread_id"), v.Text("id")
	if f.count("SELECT COUNT(*) FROM thread_archive WHERE mailbox_id = 'human' AND thread_id = ?", tid) != 1 ||
		f.count("SELECT COUNT(*) FROM thread_archive_mail WHERE mailbox_id = 'human' AND thread_id = ? AND mail_id = ?", tid, id) != 1 {
		t.Fatal("the human's new thread is not archived")
	}
	more := f.post(sharedTok, human, `{"from":"human","to":["aboss"],"reply_to":"`+id+`","body":"more"}`)
	mv, _ := jsfmt.Parse(more.Body.Bytes())
	if f.count("SELECT COUNT(*) FROM thread_archive_mail WHERE mailbox_id = 'human' AND thread_id = ? AND mail_id = ?", tid, mv.Text("id")) != 1 {
		t.Error("the human's follow-up is not kept archived")
	}
	f.post(sharedTok, human, `{"from":"coder","to":["human"],"reply_to":"`+id+`","body":"answer"}`)
	if f.count("SELECT COUNT(*) FROM thread_archive_mail WHERE mailbox_id = 'human' AND thread_id = ?", tid) != 2 {
		t.Error("an answer to the human changed what the archive holds")
	}
	// A deferral ("Decide later") defers the thread; any other reply from the human answers it.
	f.post(sharedTok, human, `{"from":"human","to":["aboss"],"reply_to":"`+id+`","body":"Deferring this one: still open, I'll decide later."}`)
	if f.count("SELECT COUNT(*) FROM thread_deferred WHERE thread_id = ?", tid) != 1 {
		t.Error("the deferral did not defer the thread")
	}
	f.post(sharedTok, human, `{"from":"human","to":["aboss"],"reply_to":"`+id+`","body":"Yes."}`)
	if f.count("SELECT COUNT(*) FROM thread_deferred WHERE thread_id = ?", tid) != 0 {
		t.Error("a reply did not clear the deferral")
	}
}

// A decision block in an agent's mail to the human is recorded; an ask the human has deferred comes back with a new mail to them.
func TestSendDecisionMail(t *testing.T) {
	f := newFixture(t, map[string]string{})
	f.sql("UPDATE agents SET type = 'manager', model = 'claude-opus-5-5' WHERE id = 'achild'")
	rec := f.post(agentTok, nil, "{\"to\":[\"human\"],\"subject\":\"Pick\",\"body\":\"```yesno\\nOK?\\n```\",\"new_thread\":true}")
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	v, _ := jsfmt.Parse(rec.Body.Bytes())
	if f.count("SELECT COUNT(*) FROM decision_mails WHERE mail_id = ?", v.Text("id")) != 1 {
		t.Error("the decision mail was not recorded")
	}
	f.post(agentTok, nil, "{\"to\":[\"human\"],\"subject\":\"[stam] notice\",\"body\":\"```yesno\\nx\\n```\",\"new_thread\":true}")
	if n := f.count("SELECT COUNT(*) FROM decision_mails"); n != 1 {
		t.Errorf("%d decision mails, a [stam] subject is no decision", n)
	}
}

// The shared token may name only an agent without a token of its own: an agent remembered from a peer has one, and an
// empty token_hash is no token (src/daemon.ts actor).
func TestSharedTokenActsAs(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('apeer', 'remote-one', 'elsewhere', '2026-10-01T00:00:00.000Z')")
	if rec := f.post(sharedTok, human, `{"from":"remote-one","to":["aboss"],"subject":"s","body":"b"}`); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "it has its own token") {
		t.Errorf("a peer's agent by name: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post(sharedTok, human, `{"from":"apeer","to":["aboss"],"subject":"s","body":"b"}`); rec.Code != 403 {
		t.Errorf("a peer's agent by id: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("UPDATE agents SET token_hash = '' WHERE id = 'achild'")
	if rec := f.post(sharedTok, human, `{"from":"child","to":["aboss"],"subject":"Empty hash","body":"b","new_thread":true}`); rec.Code != 200 {
		t.Errorf("an agent whose token_hash is empty: %d %s", rec.Code, rec.Body.String())
	}
}

// The gate fails closed: wherever the key is (environment, secret store, opencode.env) the check would run, so the send
// is refused without an override; with no key it is delivered (src/secrets.ts keyFor).
func TestSendGateFailsClosed(t *testing.T) {
	const q = `{"to":["human"],"subject":"Q","body":"b","new_thread":true}`
	store := `{"secrets":{"zz":{"value":"v","provider":"openrouter","slot":"agent","env":"OPENROUTER_API_KEY","setAt":""},` +
		`"or":{"value":"v","provider":"openrouter","slot":"stam","env":"OPENROUTER_API_KEY","setAt":""}},"imported":[]}`
	for _, tc := range []struct {
		name, file, text string
		code             int
	}{
		{"no key", "", "", 200},
		{"a key in the store", "secrets.json", store, 501},
		{"a key in the store, agent slot only", "secrets.json", strings.Replace(store, `"slot":"stam"`, `"slot":"agent"`, 1), 200},
		{"a broken store", "secrets.json", "{", 200},
		{"a key in opencode.env", "opencode.env", "OPENROUTER_API_KEY='v'\n", 501},
		{"a key in opencode.env the store has imported", "secrets.json", `{"secrets":{},"imported":["opencode.env"]}`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OPENROUTER_API_KEY", "")
			f := newFixture(t, nil)
			f.sql("UPDATE agents SET type = 'manager', model = 'claude-opus-5-5' WHERE id = 'achild'")
			if tc.file != "" {
				writeFile(t, filepath.Join(f.home, tc.file), tc.text)
			}
			if tc.name == "a key in opencode.env the store has imported" {
				writeFile(t, filepath.Join(f.home, "opencode.env"), "OPENROUTER_API_KEY=v\n")
			}
			rec := f.post(agentTok, nil, q)
			if rec.Code != tc.code {
				t.Fatalf("%d %s", rec.Code, rec.Body.String())
			}
			delivered := f.count("SELECT COUNT(*) FROM mail WHERE subject = 'Q'")
			if (tc.code == 200) != (delivered == 1) {
				t.Errorf("%d mails stored", delivered)
			}
			if tc.code == 501 {
				if rec := f.post(agentTok, nil, strings.Replace(q, "}", `,"override":"why"}`, 1)); rec.Code != 200 {
					t.Errorf("override: %d %s", rec.Code, rec.Body.String())
				}
			}
		})
	}
}

// The ambiguous-read error names each subject between plain double quotes, as TS does: no escaping of quotes or backslashes.
func TestSendAmbiguousReadQuotesRaw(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	at := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	for i, subject := range []string{`Say "hi"`, `back\slash`} {
		id := "mq" + strconv.Itoa(i)
		f.sql("INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id) VALUES (?, 'aboss', 'boss', ?, 'b', ?, ?)", id, subject, at, id)
		f.sql("INSERT INTO mail_recipients (mail_id, agent_id, read_at) VALUES (?, 'achild', ?)", id, at)
	}
	rec := f.post(agentTok, nil, `{"to":["aboss"],"subject":"zzz","body":"b"}`)
	// A plain Error from sendMail is a 500 in the TS daemon too.
	if rec.Code != 500 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	for _, want := range []string{`"Say "hi"" (mq0)`, `"back\slash" (mq1)`} {
		if !strings.Contains(errorOf(t, rec), want) {
			t.Errorf("error %q lacks %s", errorOf(t, rec), want)
		}
	}
}

// An empty system name is no system sender: the mail is not a notice (Boolean(input.system)).
func TestSendEmptySystemIsNoNotice(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	rec := f.post(sharedTok, human, `{"from":"human","system":"","to":["aboss"],"subject":"Plain","body":"b","new_thread":true}`)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE subject = 'Plain' AND notice = 0"); n != 1 {
		t.Errorf("an empty system made %d plain mails", n)
	}
}

type cancelReader struct {
	*strings.Reader
	cancel func()
}

func (c *cancelReader) Read(p []byte) (int, error) {
	n, err := c.Reader.Read(p)
	c.cancel()
	return n, err
}

// A client that hangs up once the request is read does not stop the send: the mail is stored, and a retry with the same
// client_id gets its answer instead of a second mail.
func TestSendSurvivesDisconnect(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	const body = `{"to":["aboss"],"subject":"Gone","body":"b","new_thread":true,"client_id":"c1"}`
	// The client hangs up as the handler reads the body, after the caller is known and before anything is stored.
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("POST", "/api/mail", &cancelReader{strings.NewReader(body), cancel}).WithContext(ctx)
	r.Host = "127.0.0.1:7999"
	r.Header.Set("Authorization", "Bearer "+agentTok)
	f.srv.ServeHTTP(httptest.NewRecorder(), r)
	if n := f.count("SELECT COUNT(*) FROM mail WHERE subject = 'Gone'"); n != 1 {
		t.Fatalf("%d mails after a hung-up send", n)
	}
	if rec := f.post(agentTok, nil, body); rec.Code != 200 {
		t.Fatalf("retry: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE subject = 'Gone'"); n != 1 {
		t.Errorf("the retry stored a second mail (%d)", n)
	}
}

// The sender's own part: mail to the human from an agent that may not mail it is rerouted to its parent (S-548).
func TestSendRerouteAndGate(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	f := newFixture(t, nil)
	rec := f.post(agentTok, nil, `{"to":["human"],"subject":"Q","body":"b","new_thread":true}`)
	v, _ := jsfmt.Parse(rec.Body.Bytes())
	if v.Text("rerouted") != "boss" {
		t.Errorf("rerouted to %q: %s", v.Text("rerouted"), rec.Body.String())
	}
	if n := f.count("SELECT COUNT(*) FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'", v.Text("id")); n != 0 {
		t.Errorf("the human got the rerouted mail")
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE id = ? AND body LIKE 'Meant for your user.%'", v.Text("id")); n != 1 {
		t.Errorf("the rerouted body is not wrapped")
	}
	// With a key and the gate on, an unchecked send answers 501; an override sends it.
	t.Setenv("OPENROUTER_API_KEY", "k")
	f.sql("UPDATE agents SET type = 'manager', model = 'claude-opus-5-5' WHERE id = 'achild'")
	if rec := f.post(agentTok, nil, `{"to":["human"],"subject":"Q2","body":"b","new_thread":true}`); rec.Code != 501 || !strings.Contains(errorOf(t, rec), "mail check") {
		t.Errorf("gate: %d %s", rec.Code, rec.Body.String())
	}
	rec = f.post(agentTok, nil, `{"to":["human"],"subject":"Q3","body":"b","new_thread":true,"override":"  I know  "}`)
	ov, _ := jsfmt.Parse(rec.Body.Bytes())
	if rec.Code != 200 || ov.Text("override") != "I know" {
		t.Errorf("override: %d %s", rec.Code, rec.Body.String())
	}
	// Mail between agents is not gated.
	if rec := f.post(agentTok, nil, `{"to":["aboss"],"subject":"Q4","body":"b","new_thread":true}`); rec.Code != 200 {
		t.Errorf("agent mail: %d %s", rec.Code, rec.Body.String())
	}
}

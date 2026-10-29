package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/auth"
	"stam/internal/jsfmt"
)

// exec runs statements on the fixture's database.
func (f *fixture) exec(stmts ...string) {
	f.t.Helper()
	must(f.t, f.db.Write(context.Background(), func(conn *sqlite.Conn) error {
		for _, q := range stmts {
			if err := sqlitex.ExecuteTransient(conn, q, nil); err != nil {
				return err
			}
		}
		return nil
	}))
}

// mailTo stores a mail from `from` to the recipients, in its own thread.
func (f *fixture) mailTo(id, from string, to ...string) {
	f.t.Helper()
	stmts := []string{`INSERT INTO mail (id, from_id, subject, body, created_at, thread_id) VALUES ('` + id + `', '` + from + `', 'Pick', 'b', '2026-10-01T00:00:00.000Z', '` + id + `')`}
	for _, r := range to {
		stmts = append(stmts, `INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('`+id+`', '`+r+`')`)
	}
	f.exec(stmts...)
}

func (f *fixture) postAt(path, token string, header map[string]string, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.do(call{method: http.MethodPost, path: path, token: token, header: header, body: body})
}

// An agent withdraws its own decision mail from the human: the decision leaves the list, the human's copy is withdrawn
// with the agent's words, and the thread is archived. Only an agent may, only its own (or a child's), and only once.
func TestWithdrawAsk(t *testing.T) {
	f := newFixture(t, nil)
	f.mailTo("m100", "achild", "human")
	f.mailTo("m101", "aboss", "human")
	f.mailTo("m102", "achild", "aboss")
	f.exec(`INSERT INTO decision_mails (mail_id, thread_id) VALUES ('m100', 'm100'), ('m101', 'm101')`)

	if rec := f.postAt("/api/mail/m100/withdraw-ask", sharedTok, nil, `{"note":"x"}`); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "only an agent withdraws its ask") {
		t.Errorf("the shared token: %d %s", rec.Code, rec.Body)
	}
	if rec := f.postAt("/api/mail/m101/withdraw-ask", agentTok, nil, `{"note":"x"}`); rec.Code != 403 {
		t.Errorf("a parent's ask withdrawn by its child: %d %s", rec.Code, rec.Body)
	}
	// The OpenCode server acts only for an agent on the opencode harness.
	if rec := f.postAt("/api/mail/m101/withdraw-ask", serverTok, nil, `{"note":"x","by":"aboss"}`); rec.Code != 403 {
		t.Errorf("the OpenCode server as a Claude agent: %d %s", rec.Code, rec.Body)
	}
	if rec := f.postAt("/api/mail/m102/withdraw-ask", agentTok, nil, `{"note":"x"}`); rec.Code != 409 || !strings.Contains(errorOf(t, rec), "wasn't sent to the human") {
		t.Errorf("a mail not to the human: %d %s", rec.Code, rec.Body)
	}
	if rec := f.postAt("/api/mail/mnothere/withdraw-ask", agentTok, nil, `{"note":"x"}`); rec.Code != 404 {
		t.Errorf("an unknown mail: %d %s", rec.Code, rec.Body)
	}
	rec := f.postAt("/api/mail/m100/withdraw-ask", agentTok, nil, `{"note":"  answered in the terminal "}`)
	if rec.Code != 200 || rec.Body.String() != `{"withdrawn":[{"id":"m100","thread_id":"m100","ids":["m100"]}]}` {
		t.Fatalf("withdraw: %d %s", rec.Code, rec.Body)
	}
	if f.count("SELECT COUNT(*) FROM decision_mails WHERE mail_id = 'm100'") != 0 {
		t.Error("the decision is still listed")
	}
	if f.count("SELECT COUNT(*) FROM mail_recipients WHERE mail_id = 'm100' AND agent_id = 'human' AND withdrawn_by = 'achild' AND read_at IS NOT NULL AND withdrawn_note LIKE 'Withdrawn by @%: answered in the terminal'") != 1 {
		t.Error("the human's copy isn't withdrawn with the agent's words")
	}
	if f.count("SELECT COUNT(*) FROM thread_archive_mail WHERE mailbox_id = 'human' AND thread_id = 'm100' AND mail_id = 'm100'") != 1 {
		t.Error("the thread isn't archived")
	}
	if rec := f.postAt("/api/mail/m100/withdraw-ask", agentTok, nil, `{"note":"again"}`); rec.Code != 409 || !strings.Contains(errorOf(t, rec), "isn't waiting on the human") {
		t.Errorf("a second withdrawal: %d %s", rec.Code, rec.Body)
	}
	// Only a peer withdraws mail this way.
	if rec := f.postAt("/api/mail/withdraw", sharedTok, nil, `{"ids":["m101"],"by":"aboss"}`); rec.Code != 403 {
		t.Errorf("POST /api/mail/withdraw without a peer: %d %s", rec.Code, rec.Body)
	}
}

// A recipient attaches agents to a mail, silently; a stranger may not, and an attach naming nothing is refused.
func TestMailAttach(t *testing.T) {
	f := newFixture(t, nil)
	f.mailTo("m200", "aboss", "achild")
	f.mailTo("m201", "aboss", "human")
	f.mailTo("m202", "achild", "aboss")
	// The OpenCode server acts only for an agent on the opencode harness, even one the mail went to.
	if rec := f.postAt("/api/mail/m202/attach", serverTok, nil, `{"agents":["achild"],"by":"aboss"}`); rec.Code != 403 {
		t.Errorf("the OpenCode server as a Claude agent: %d %s", rec.Code, rec.Body)
	}
	rec := f.postAt("/api/mail/m200/attach", agentTok, nil, `{"agents":["aboss"]}`)
	if rec.Code != 200 || rec.Body.String() != `{"attached":{"itsas":[],"agents":["aboss"]}}` {
		t.Fatalf("attach: %d %s", rec.Code, rec.Body)
	}
	if rec := f.postAt("/api/mail/m200/attach", agentTok, nil, `{"agents":["aboss"]}`); rec.Body.String() != `{"attached":{"itsas":[],"agents":[]}}` {
		t.Errorf("attaching again: %d %s", rec.Code, rec.Body)
	}
	for _, c := range []struct {
		path, token, body string
		code              int
	}{
		{"/api/mail/m201/attach", agentTok, `{"agents":["aboss"]}`, 403},
		{"/api/mail/m200/attach", agentTok, `{}`, 400},
		{"/api/mail/m200/attach", agentTok, `{"agents":["nobody"]}`, 404},
		{"/api/mail/m200/attach", agentTok, `{"itsas":["S-999"]}`, 404},
		{"/api/mail/mnothere/attach", agentTok, `{"agents":["aboss"]}`, 404},
		{"/api/mail/m200/attach", sharedTok, `{"agents":["aboss"]}`, 403},
	} {
		if rec := f.postAt(c.path, c.token, nil, c.body); rec.Code != c.code {
			t.Errorf("%s %s: %d %s, want %d", c.path, c.body, rec.Code, rec.Body, c.code)
		}
	}
	if f.count("SELECT COUNT(*) FROM mail_recipients WHERE mail_id = 'm200'") != 1 {
		t.Error("attaching added a recipient")
	}
}

// A mail read for a box the agent acts for is checked as the agent asking (src/daemon.ts readerOf, S-480): the parent
// owns the ITSA, so it sees the ITSA's mail with ?box= its child, whom the ITSA doesn't include.
func TestMailReadAsTheAsker(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET token_hash = NULL WHERE id = 'achild'")
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'aboss'", auth.Hash(agentTok))
	if rec := f.postAt("/api/itsas", sharedTok, human, `{"title":"Alpha"}`); rec.Code != 200 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	f.sql("UPDATE itsas SET owner = 'aboss' WHERE key = 'S-1'")
	f.mailTo("m400", "agone", "acodex")
	f.sql("UPDATE mail SET itsa_id = (SELECT id FROM itsas WHERE key = 'S-1') WHERE id = 'm400'")
	if rec := f.do(call{path: "/api/mail/m400/thread?box=achild", token: agentTok}); rec.Body.String() != `[{"thread_id":"m400","subject":"Pick"}]` {
		t.Errorf("the owner reading as its child: %d %s", rec.Code, rec.Body)
	}
}

// A media player can't send a header: an attachment's download takes the shared token in its URL, and nothing else does.
func TestAttachmentMediaToken(t *testing.T) {
	f := newFixture(t, nil)
	rec := f.postAt("/api/mail", sharedTok, human, `{"from":"aboss","to":["achild"],"subject":"s","body":"b","new_thread":true,"attachments":[{"name":"a.txt","content":"hello"}]}`)
	v, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	at := "/api/mail/" + v.Text("id") + "/attachments/a.txt"
	if rec := f.do(call{path: at + "?token=" + sharedTok}); rec.Code != 200 || rec.Body.String() != "hello" {
		t.Errorf("the shared token in the URL: %d %s", rec.Code, rec.Body)
	}
	for _, path := range []string{at, at + "?token=nope", at + "?token=" + agentTok, "/api/agents?token=" + sharedTok} {
		if rec := f.do(call{path: path}); rec.Code != 401 {
			t.Errorf("%s: %d %s", strings.Replace(path, sharedTok, "SHARED", 1), rec.Code, rec.Body)
		}
	}
}

// Who archives and defers which mailbox's threads, and what each verb records.
func TestThreadState(t *testing.T) {
	f := newFixture(t, nil)
	f.mailTo("m300", "aboss", "human", "achild")
	if rec := f.postAt("/api/agents/human/threads/m300/archive", agentTok, nil, `{}`); rec.Code != 403 {
		t.Errorf("an agent archiving the human's thread: %d %s", rec.Code, rec.Body)
	}
	if rec := f.postAt("/api/agents/human/threads/m300/archive", sharedTok, human, `{}`); rec.Body.String() != `{"archived":true}` {
		t.Errorf("the human's archive: %d %s", rec.Code, rec.Body)
	}
	if rec := f.postAt("/api/agents/achild/threads/m300/defer", agentTok, nil, `{"by":"achild"}`); rec.Body.String() != `{"deferred":true}` {
		t.Errorf("an agent deferring its own thread: %d %s", rec.Code, rec.Body)
	}
	if f.count("SELECT COUNT(*) FROM thread_defer_mail WHERE mailbox_id = 'achild' AND thread_id = 'm300' AND mail_id = 'm300'") != 1 {
		t.Error("the deferral didn't record the thread's mail")
	}
	// An agent's token is that agent: naming no one, or naming the mailbox's owner, is still the child.
	for _, body := range []string{`{"by":"achild"}`, `{}`, `{"by":"aboss"}`} {
		if rec := f.postAt("/api/agents/aboss/threads/m300/archive", agentTok, nil, body); rec.Code != 403 {
			t.Errorf("a child archiving its parent's mailbox with %s: %d %s", body, rec.Code, rec.Body)
		}
	}
	// The human's unarchive keeps the thread open against auto-archive.
	if rec := f.postAt("/api/agents/human/threads/m300/unarchive", sharedTok, human, `{}`); rec.Body.String() != `{"archived":false}` {
		t.Errorf("the human's unarchive: %d %s", rec.Code, rec.Body)
	}
	if f.count("SELECT COUNT(*) FROM thread_archive WHERE mailbox_id = 'human'") != 0 || f.count("SELECT COUNT(*) FROM thread_kept_open WHERE mailbox_id = 'human' AND thread_id = 'm300'") != 1 {
		t.Error("unarchive didn't unarchive and keep the thread open")
	}
	// The human marks its read copy unread again; only the human may.
	f.exec(`UPDATE mail_recipients SET read_at = '2026-10-01T01:00:00.000Z' WHERE mail_id = 'm300'`)
	if rec := f.postAt("/api/agents/human/threads/m300/unread", sharedTok, nil, `{"ids":["m300"]}`); rec.Code != 403 {
		t.Errorf("unread without the human: %d %s", rec.Code, rec.Body)
	}
	if rec := f.postAt("/api/agents/human/threads/m300/unread", sharedTok, human, `{"ids":["m300","mnothere"]}`); rec.Body.String() != `{"marked":["m300"]}` {
		t.Errorf("unread: %d %s", rec.Code, rec.Body)
	}
	if f.count("SELECT COUNT(*) FROM mail_recipients WHERE mail_id = 'm300' AND read_at IS NULL") != 1 {
		t.Error("unread touched another recipient's copy, or none")
	}
	// The thread list shows the thread to the human, and the decision list is empty.
	rec := f.do(call{path: "/api/agents/human/threads?limit=5", token: sharedTok, header: human})
	v, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	if rec.Code != 200 || len(v.Items) != 1 || v.Items[0].Text("thread_id") != "m300" {
		t.Errorf("thread list: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/mail/decisions", token: sharedTok}); rec.Body.String() != `[]` {
		t.Errorf("decisions: %s", rec.Body)
	}
	if rec := f.do(call{path: "/api/mail/m300/thread", token: sharedTok}); rec.Body.String() != `[{"thread_id":"m300","subject":"Pick"}]` {
		t.Errorf("the thread of a mail: %s", rec.Body)
	}
}

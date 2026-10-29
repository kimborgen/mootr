package server

import (
	"strings"
	"testing"
)

// TestItsaAskMatchesTS runs the steps of testdata/ask-steps.json through src/itsa.ts with the human's ask registered
// (agents' moves into and out of human statuses, a script's, a comment that the ask repeats, a move between human statuses)
// and through the routes on a copy, and compares every answer, and the tables the steps leave behind: the ask mail and its
// recipients (a non-manager's ask goes to its parent), the withdrawal, the archived thread, the participants.
func TestItsaAskMatchesTS(t *testing.T) {
	humanParity(t, "askref.mjs", "ask-steps.json", `{"itsa":{"ownerNotices":"off"}}`, map[string]string{
		"mail":         "SELECT id, from_id, from_name, subject, body, thread_id, reply_to, itsa_id, kind, about_itsa, notice FROM mail ORDER BY rowid",
		"recipients":   "SELECT mail_id, agent_id, quiet, read_at IS NOT NULL AS read, withdrawn_at IS NOT NULL AS withdrawn, withdrawn_by, withdrawn_note FROM mail_recipients ORDER BY rowid",
		"itsas":        "SELECT id, key, title, owner, status, thread_id FROM itsas ORDER BY rowid",
		"participants": "SELECT itsa_id, agent_id FROM itsa_participants ORDER BY rowid",
		"itsaEvents":   "SELECT itsa_id, actor, type, data FROM itsa_events ORDER BY id",
		"archive":      "SELECT mailbox_id, thread_id FROM thread_archive ORDER BY rowid",
		"archived":     "SELECT mailbox_id, thread_id, mail_id FROM thread_archive_mail ORDER BY rowid",
		// The revision each ask went out with (S-2998).
		"shownRevs": "SELECT m.subject, s.itsa_id, s.rev, s.at, s.len FROM itsa_shown_revs s JOIN mail m ON m.id = s.mail_id ORDER BY m.rowid",
	})
}

// What the ask's send does not carry is answered 501 before the move is written: a requirement check of the ask mail, a step on
// mail-to-human (for an ask an agent sends, not one stam does), an embedded file in the comment the ask repeats.
func TestItsaAskRefusals(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET model = 'claude-opus-5-5' WHERE id = 'achild'")
	f.sql("UPDATE agents SET type = 'manager' WHERE id = 'achild'")
	key := f.createItsa(`{"title":"Alpha","owner":"child"}`)
	f.sql("UPDATE itsas SET thread_id = 'th1' WHERE key = ?", key)
	asks := func() int { return f.count("SELECT COUNT(*) FROM mail WHERE kind = 'ask'") }
	move := func(status string) int {
		return f.sendH("PATCH", "/api/itsas/"+key, agentTok, nil, `{"status":"`+status+`"}`).Code
	}
	status := func() string {
		return f.body(f.post2("GET", "/api/itsas/"+key, "")).Text("status")
	}

	f.sql("INSERT INTO mail (id, from_id, subject, body, created_at, thread_id, kind) VALUES ('mc1', 'achild', 's', 'look\n```embed\nhttps://example.com/x\n```', '2999-01-01T00:00:00.000Z', 'th1', 'comment')")
	if code := move("needs_input"); code != 501 || status() != "backlog" || asks() != 0 {
		t.Errorf("a comment with an embedded file: %d, status %s, %d asks", code, status(), asks())
	}
	f.sql("UPDATE mail SET body = 'did x' WHERE id = 'mc1'")

	f.sql("CREATE TABLE decision_steps (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL, question TEXT NOT NULL, threshold REAL NOT NULL DEFAULT 0.5, action TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, builtin TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
	f.sql(`INSERT INTO decision_steps (id, name, trigger, question, action, enabled, created_at, updated_at) VALUES ('s1', 'n', '{"kind":"event","event":"mail-to-human"}', 'q', '{}', 1, 'x', 'x')`)
	if code := move("needs_input"); code != 501 || status() != "backlog" || asks() != 0 {
		t.Errorf("a step on mail-to-human: %d, status %s, %d asks", code, status(), asks())
	}
	f.sql("DELETE FROM decision_steps")

	if code := move("needs_input"); code != 200 || asks() != 1 {
		t.Fatalf("the move with nothing in the way: %d, %d asks", code, asks())
	}
	if n := f.count("SELECT COUNT(*) FROM itsa_participants p JOIN itsas i ON i.id = p.itsa_id WHERE i.key = ? AND p.agent_id = 'human'", key); n != 1 {
		t.Error("the human did not become a participant")
	}
	// Moving it on settles the ask and archives its thread; a move between human statuses keeps the thread open.
	if code := move("in_progress"); code != 200 || f.count("SELECT COUNT(*) FROM mail_recipients WHERE agent_id = 'human' AND withdrawn_at IS NOT NULL AND withdrawn_by = 'achild' AND withdrawn_note LIKE '@child moved "+key+" to in_progress'") != 1 {
		t.Errorf("the move out of a human status did not withdraw the ask: %d", code)
	}
	if n := f.count("SELECT COUNT(*) FROM thread_archive WHERE mailbox_id = 'human'"); n != 1 {
		t.Errorf("%d archived threads", n)
	}
	if code := move("needs_input"); code != 200 || asks() != 2 {
		t.Fatalf("a second ask: %d, %d asks", code, asks())
	}
	if code := move("needs_approval"); code != 200 || asks() != 3 {
		t.Fatalf("a move between human statuses: %d, %d asks", code, asks())
	}
	// The earlier archive stays on record (a new mail in the thread lists it again); the move between human statuses adds none.
	if n := f.count("SELECT COUNT(*) FROM thread_archive WHERE mailbox_id = 'human'"); n != 1 {
		t.Errorf("%d archived threads after a move between human statuses, want the one from before", n)
	}
	if n := f.count("SELECT COUNT(*) FROM mail_recipients WHERE agent_id = 'human' AND withdrawn_at IS NOT NULL"); n != 2 {
		t.Errorf("%d withdrawn asks, want 2 (the first, and the second when it moved on)", n)
	}
	// The human's own move asks nothing and settles nothing.
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"in_progress"}`); rec.Code != 200 || asks() != 3 {
		t.Errorf("the human's move: %d, %d asks", rec.Code, asks())
	}
	// A server with no templates cannot write the ask.
	f.srv.tpl = nil
	if code := move("needs_input"); code != 501 || !strings.Contains(status(), "in_progress") {
		t.Errorf("no templates: %d, status %s", code, status())
	}
}

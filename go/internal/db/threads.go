package db

import (
	"context"
	"encoding/json"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
)

// The mailbox thread lists and their archive and defer state (src/db.ts threads, archiveThread, deferThread, keepOpen,
// splitArchived, splitDeferred, markUnread; S-3734). The state lives on the daemon that serves the list, not on the peers
// that hold parts of a thread.

// Threads is the threads a mailbox takes part in, sending or receiving, newest activity first, each with every message
// stored here (src/db.ts threads). `with` keeps only the threads where that agent sent or received a message (S-1121).
func (d *DB) Threads(ctx context.Context, box string, limit int, with string) ([]ThreadGroup, error) {
	var w any
	if with != "" {
		w = with
	}
	var ids []string
	err := d.read(ctx, `SELECT m.thread_id AS t, MAX(m.created_at) AS last FROM mail m
       WHERE (m.from_id = ? OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?))
         AND (? IS NULL OR EXISTS (SELECT 1 FROM mail w WHERE w.thread_id = m.thread_id AND (w.from_id = ?
              OR EXISTS (SELECT 1 FROM mail_recipients wr WHERE wr.mail_id = w.id AND wr.agent_id = ?))))
       GROUP BY m.thread_id ORDER BY last DESC LIMIT ?`,
		func(c *cols) {
			if t := c.nullText(); t != nil {
				ids = append(ids, *t)
			}
		}, box, box, w, w, w, limit)
	if err != nil {
		return nil, wrap("threads", err)
	}
	out := make([]ThreadGroup, 0, len(ids))
	for _, t := range ids {
		mails, err := d.ThreadMail(ctx, t, "")
		if err != nil {
			return nil, err
		}
		out = append(out, ThreadGroup{ThreadID: t, Mails: mails})
	}
	return out, nil
}

func (d *DB) countOf(ctx context.Context, what, query string, args ...any) (int, error) {
	n := 0
	err := d.read(ctx, query, func(c *cols) { n = c.int() }, args...)
	return n, wrap(what, err)
}

// ArchivedCount is how many threads the mailbox archived, so a list can fetch enough to fill a page after filtering.
func (d *DB) ArchivedCount(ctx context.Context, box string) (int, error) {
	return d.countOf(ctx, "archived count", "SELECT COUNT(*) AS n FROM thread_archive WHERE mailbox_id = ?", box)
}

// DeferredCount is how many threads the mailbox deferred (S-976).
func (d *DB) DeferredCount(ctx context.Context, box string) (int, error) {
	return d.countOf(ctx, "deferred count", "SELECT COUNT(*) AS n FROM thread_defer WHERE mailbox_id = ?", box)
}

// UnarchiveThread brings an archived thread back to the mailbox's list.
func (d *DB) UnarchiveThread(ctx context.Context, box, threadID string) error {
	return wrap("unarchive thread", d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, "DELETE FROM thread_archive WHERE mailbox_id = ? AND thread_id = ?", box, threadID); err != nil {
			return err
		}
		return runSQL(conn, "DELETE FROM thread_archive_mail WHERE mailbox_id = ? AND thread_id = ?", box, threadID)
	}))
}

// DeferThread sets a thread aside for later (S-976), recording its message ids now, as archive does; deferring an
// archived thread takes it out of the archive.
func (d *DB) DeferThread(ctx context.Context, box, threadID string, mailIDs []string) error {
	return wrap("defer thread", d.Write(ctx, func(conn *sqlite.Conn) error {
		for _, q := range []string{
			"DELETE FROM thread_archive WHERE mailbox_id = ? AND thread_id = ?",
			"DELETE FROM thread_archive_mail WHERE mailbox_id = ? AND thread_id = ?",
			"INSERT OR REPLACE INTO thread_defer (mailbox_id, thread_id) VALUES (?, ?)",
			"DELETE FROM thread_defer_mail WHERE mailbox_id = ? AND thread_id = ?",
		} {
			if err := runSQL(conn, q, box, threadID); err != nil {
				return err
			}
		}
		for _, id := range mailIDs {
			if err := runSQL(conn, "INSERT OR IGNORE INTO thread_defer_mail (mailbox_id, thread_id, mail_id) VALUES (?, ?, ?)", box, threadID, id); err != nil {
				return err
			}
		}
		return nil
	}))
}

// UndeferThread brings a deferred thread back.
func (d *DB) UndeferThread(ctx context.Context, box, threadID string) error {
	return wrap("undefer thread", d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, "DELETE FROM thread_defer WHERE mailbox_id = ? AND thread_id = ?", box, threadID); err != nil {
			return err
		}
		return runSQL(conn, "DELETE FROM thread_defer_mail WHERE mailbox_id = ? AND thread_id = ?", box, threadID)
	}))
}

// KeepOpen records that the human unarchived the thread (S-637): auto-archive leaves it alone until it has new mail
// for them.
func (d *DB) KeepOpen(ctx context.Context, box, threadID string, mailIDs []string) error {
	uniq := []string{}
	for _, id := range mailIDs {
		if !contains(uniq, id) {
			uniq = append(uniq, id)
		}
	}
	b, err := json.Marshal(uniq)
	if err != nil {
		return err
	}
	return wrap("keep open", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "INSERT OR REPLACE INTO thread_kept_open (mailbox_id, thread_id, mail_ids) VALUES (?, ?, ?)", box, threadID, string(b))
	}))
}

// KeptOpen is whether auto-archive must leave the thread alone: the human unarchived it, and every mail to them from
// others in it (`ids`) is one it had then.
func (d *DB) KeptOpen(ctx context.Context, box, threadID string, ids []string) (bool, error) {
	var raw *string
	err := d.read(ctx, "SELECT mail_ids FROM thread_kept_open WHERE mailbox_id = ? AND thread_id = ?", func(c *cols) { raw = c.nullText() }, box, threadID)
	if err != nil || raw == nil {
		return false, wrap("kept open", err)
	}
	var kept []string
	if err := json.Unmarshal([]byte(*raw), &kept); err != nil {
		return false, wrap("kept open", err)
	}
	for _, id := range ids {
		if !contains(kept, id) {
			return false, nil
		}
	}
	return true, nil
}

// MarkAutoArchived records that auto-archive, not the human, archived the thread (S-637).
func (d *DB) MarkAutoArchived(ctx context.Context, box, threadID string) error {
	return wrap("mark auto-archived", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "INSERT OR IGNORE INTO thread_auto_archived (mailbox_id, thread_id) VALUES (?, ?)", box, threadID)
	}))
}

// AutoArchivedThreads is the threads auto-archive archived for the mailbox.
func (d *DB) AutoArchivedThreads(ctx context.Context, box string) ([]string, error) {
	var out []string
	err := d.read(ctx, "SELECT thread_id FROM thread_auto_archived WHERE mailbox_id = ?", func(c *cols) { out = append(out, c.text()) }, box)
	return out, wrap("auto-archived threads", err)
}

// ForgetAutoArchived drops auto-archive's mark on the thread.
func (d *DB) ForgetAutoArchived(ctx context.Context, box, threadID string) error {
	return wrap("forget auto-archived", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "DELETE FROM thread_auto_archived WHERE mailbox_id = ? AND thread_id = ?", box, threadID)
	}))
}

// MarkUnread is the inverse of a read (S-2246): the mailbox's copies of these mails go unread again. It returns the
// ids that were read.
func (d *DB) MarkUnread(ctx context.Context, box string, ids []string) ([]string, error) {
	marked := []string{}
	if len(ids) == 0 {
		return marked, nil
	}
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		for _, id := range ids {
			if err := runSQL(conn, "UPDATE mail_recipients SET read_at = NULL WHERE mail_id = ? AND agent_id = ? AND read_at IS NOT NULL", id, box); err != nil {
				return err
			}
			if conn.Changes() > 0 {
				marked = append(marked, id)
			}
		}
		return nil
	})
	return marked, wrap("mark unread", err)
}

// recorded is the message ids each of the mailbox's archived (or deferred) threads recorded, by thread.
func (d *DB) recorded(ctx context.Context, table, box string) (map[string]map[string]bool, error) {
	out := map[string]map[string]bool{}
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		if err := sqlitex.Execute(conn, "SELECT thread_id FROM "+table+" WHERE mailbox_id = ?", &sqlitex.ExecOptions{Args: []any{box},
			ResultFunc: func(stmt *sqlite.Stmt) error { out[stmt.ColumnText(0)] = map[string]bool{}; return nil }}); err != nil {
			return err
		}
		return sqlitex.Execute(conn, "SELECT thread_id, mail_id FROM "+table+"_mail WHERE mailbox_id = ?", &sqlitex.ExecOptions{Args: []any{box},
			ResultFunc: func(stmt *sqlite.Stmt) error {
				if ids, ok := out[stmt.ColumnText(0)]; ok {
					ids[stmt.ColumnText(1)] = true
				}
				return nil
			}})
	})
	return out, wrap(strings.ReplaceAll(table, "_", " "), err)
}

// sentTo is whether the mailbox is among a mail's recipients; a mail whose recipients aren't known counts as sent to it.
func sentTo(m jsfmt.Value, box string) bool {
	rs, ok := m.Get("recipients")
	if !ok || rs.Kind != jsfmt.Array {
		return true
	}
	for _, r := range rs.Items {
		if r.Text("id") == box {
			return true
		}
	}
	return false
}

// pendingPermission is whether the mail carries a permission request still pending.
func pendingPermission(m jsfmt.Value) bool {
	p, ok := m.Get("permission")
	return ok && p.Kind == jsfmt.Object && p.Text("status") == "pending"
}

// IsSystemNotice is src/mail-notice.ts isSystemNotice: mail stam or a local script sent on its own behalf, or from a
// `system:NAME` sender (S-1971).
func IsSystemNotice(m jsfmt.Value) bool {
	if n, ok := m.Get("notice"); ok && n.Truthy() {
		return true
	}
	return strings.HasPrefix(m.Text("from_id"), "system:")
}

// SplitArchived is src/db.ts splitArchived: a mailbox's threads, as a list merged them, split into the ones archive hides
// and the rest. A thread is hidden only while every message sent to the mailbox is one archive recorded; a pending
// permission request, or a thread in `keep`, keeps it in the list.
func (d *DB) SplitArchived(ctx context.Context, box string, threads []ThreadGroup, keep map[string]bool) (active, archived []ThreadGroup, err error) {
	rec, err := d.recorded(ctx, "thread_archive", box)
	if err != nil {
		return nil, nil, err
	}
	for _, t := range threads {
		if isHidden(t, box, rec, keep, false) {
			archived = append(archived, t)
		} else {
			active = append(active, t)
		}
	}
	return active, archived, nil
}

// SplitDeferred is src/db.ts splitDeferred over src/defer-split.ts: the threads the mailbox deferred, and the rest. A
// system notice doesn't bring a deferred thread back (S-1971); a pending permission request can be deferred too (S-1068).
func (d *DB) SplitDeferred(ctx context.Context, box string, threads []ThreadGroup) (rest, deferred []ThreadGroup, err error) {
	rec, err := d.recorded(ctx, "thread_defer", box)
	if err != nil {
		return nil, nil, err
	}
	for _, t := range threads {
		if isHidden(t, box, rec, nil, true) {
			deferred = append(deferred, t)
		} else {
			rest = append(rest, t)
		}
	}
	return rest, deferred, nil
}

func isHidden(t ThreadGroup, box string, rec map[string]map[string]bool, keep map[string]bool, deferral bool) bool {
	known, ok := rec[t.ThreadID]
	if !ok || keep[t.ThreadID] {
		return false
	}
	for _, m := range t.Mails {
		if !deferral && pendingPermission(m) {
			return false
		}
	}
	for _, m := range t.Mails {
		if known[m.Text("id")] || (deferral && IsSystemNotice(m)) || !sentTo(m, box) {
			continue
		}
		return false
	}
	return true
}

// DecisionMails is src/db.ts decisionMails: the unanswered decision mails stored here, oldest first. A decision mail
// that names its sender's request still pending with the human is left out until the request settles.
func (d *DB) DecisionMails(ctx context.Context) ([]jsfmt.Value, error) {
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = rows(conn, `SELECT m.id AS mail_id, d.thread_id, m.from_id, m.from_name, m.subject, m.created_at, m.about_itsa,
    EXISTS (SELECT 1 FROM thread_deferred f WHERE f.thread_id = d.thread_id) AS deferred
    FROM decision_mails d JOIN mail m ON m.id = d.mail_id
    WHERE NOT EXISTS (SELECT 1 FROM permission_requests p WHERE p.agent_id = m.from_id AND p.status = 'pending' AND p.audience = 'human' AND (instr(m.subject, p.id) > 0 OR instr(m.body, p.id) > 0))
    ORDER BY m.created_at, m.rowid`)
		return err
	})
	for i := range out {
		v, _ := out[i].Get("deferred")
		out[i].Set("deferred", jsfmt.Value{Kind: jsfmt.Bool, Bool: v.Kind == jsfmt.Number && v.Num == "1"})
	}
	return out, wrap("decision mails", err)
}

// DecisionMailOpen is whether the mail is a decision mail still waiting on the human.
func (d *DB) DecisionMailOpen(ctx context.Context, id string) (bool, error) {
	n, err := d.countOf(ctx, "decision mail open", "SELECT COUNT(*) FROM decision_mails WHERE mail_id = ?", id)
	return n > 0, err
}

// RemoveDecisionMail is src/db.ts removeDecisionMail: the mail no longer waits on the human, with the outcome (withdrawn, or
// superseded) recorded.
func (d *DB) RemoveDecisionMail(ctx context.Context, id, outcome string) error {
	return wrap("remove decision mail", d.Write(ctx, func(conn *sqlite.Conn) error {
		return deleteDecisions(conn, outcome, nil, "DELETE FROM decision_mails WHERE mail_id = ?", id)
	}))
}

// IsThreadDeferred is whether the human chose Decide later on the thread (S-353).
func (d *DB) IsThreadDeferred(ctx context.Context, threadID string) (bool, error) {
	n, err := d.countOf(ctx, "thread deferred", "SELECT COUNT(*) FROM thread_deferred WHERE thread_id = ?", threadID)
	return n > 0, err
}

// SentToHuman is whether the human is a recipient of the mail.
func (d *DB) SentToHuman(ctx context.Context, id string) (bool, error) {
	n, err := d.countOf(ctx, "sent to human", "SELECT COUNT(*) FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'", id)
	return n > 0, err
}

// MailRecipientIDs is the recipients of a mail stored here.
func (d *DB) MailRecipientIDs(ctx context.Context, id string) ([]string, error) {
	var out []string
	err := d.read(ctx, "SELECT agent_id FROM mail_recipients WHERE mail_id = ?", func(c *cols) { out = append(out, c.text()) }, id)
	return out, wrap("mail recipients", err)
}

// AttachToMail links ITSAs to a mail as attached and attaches agents (S-1305), making no mail, recipient or unread
// state. It returns the agent ids newly attached.
func (d *DB) AttachToMail(ctx context.Context, id string, itsaIDs, agentIDs []string, by string) ([]string, error) {
	added := []string{}
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		for _, x := range itsaIDs {
			if err := runSQL(conn, "INSERT OR IGNORE INTO mail_itsas (mail_id, itsa_id, source) VALUES (?, ?, 'attached')", id, x); err != nil {
				return err
			}
		}
		for _, a := range agentIDs {
			if err := runSQL(conn, "INSERT OR IGNORE INTO mail_agents (mail_id, agent_id, added_by) VALUES (?, ?, ?)", id, a, by); err != nil {
				return err
			}
			if conn.Changes() > 0 {
				added = append(added, a)
			}
		}
		return nil
	})
	return added, wrap("attach to mail", err)
}

// Attachment is a mail's attachment by name: its stored path, ok false when none.
func (d *DB) Attachment(ctx context.Context, mailID, name string) (path string, ok bool, err error) {
	err = d.read(ctx, "SELECT path FROM attachments WHERE mail_id = ? AND name = ?", func(c *cols) { path, ok = c.text(), true }, mailID, name)
	return path, ok, wrap("attachment", err)
}

// HumanWait is an open wait on the human (src/waits.ts openHumanWaits): the thread it names, or the request or mail it
// is tied to, and the agent that declared it.
type HumanWait struct {
	Thread *string `json:"thread"`
	Target *string `json:"target"`
	Agent  *string `json:"agent"`
}

// OpenHumanWaits is src/waits.ts openHumanWaits: the waits on the human this daemon holds, each with the thread of the
// mail its data names.
func (d *DB) OpenHumanWaits(ctx context.Context) ([]HumanWait, error) {
	type row struct {
		agent        string
		target, data *string
	}
	var rs []row
	err := d.read(ctx, "SELECT agent_id, target, data FROM waits WHERE kind = 'human'", func(c *cols) {
		rs = append(rs, row{agent: c.text(), target: c.nullText(), data: c.nullText()})
	})
	if err != nil {
		return nil, wrap("human waits", err)
	}
	out := []HumanWait{}
	for _, r := range rs {
		agent := r.agent
		w := HumanWait{Target: r.target, Agent: &agent}
		if r.data != nil {
			if v, err := jsfmt.Parse([]byte(*r.data)); err == nil && v.Kind == jsfmt.Object {
				if ref, ok := v.Get("thread"); ok && ref.Truthy() {
					s := JSStr(ref)
					t, err := d.MailThreadOf(ctx, s)
					if err != nil {
						return nil, err
					}
					if t != "" {
						s = t
					}
					w.Thread = &s
				}
			}
		}
		out = append(out, w)
	}
	return out, nil
}

// KV is a kv row's value, ok false when none.
func (d *DB) KV(ctx context.Context, key string) (value string, ok bool, err error) {
	err = d.read(ctx, "SELECT value FROM kv WHERE key = ?", func(c *cols) { value, ok = c.text(), true }, key)
	return value, ok, wrap("kv", err)
}

// KVSetOnce writes a kv row unless it is there already.
func (d *DB) KVSetOnce(ctx context.Context, key, value string) error {
	return wrap("kv", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", key, value)
	}))
}

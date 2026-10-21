package db

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
)

// The mail reads and read marks of src/db.ts (S-2824): inbox, readMail, defaultRead, ackDelivered, threadMail. A mail
// is a jsfmt.Value object, because the TS daemon answers a mail row with every column of the table in column order and
// the extras after it, and a reply here must keep that order.

// rows runs a query and returns each row as an object of its columns, in column order.
func rows(conn *sqlite.Conn, query string, args ...any) ([]jsfmt.Value, error) {
	var out []jsfmt.Value
	err := sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
		row := jsfmt.Value{Kind: jsfmt.Object}
		for i := 0; i < stmt.ColumnCount(); i++ {
			var v jsfmt.Value
			switch stmt.ColumnType(i) {
			case sqlite.TypeNull:
				v = jsfmt.NullValue()
			case sqlite.TypeInteger:
				v = jsfmt.IntValue(stmt.ColumnInt64(i))
			case sqlite.TypeFloat:
				v = jsfmt.Value{Kind: jsfmt.Number, Num: fmt.Sprint(stmt.ColumnFloat(i))}
			default:
				v = jsfmt.StringValue(stmt.ColumnText(i))
			}
			row.Keys, row.Items = append(row.Keys, stmt.ColumnName(i)), append(row.Items, v)
		}
		out = append(out, row)
		return nil
	}})
	return out, err
}

// notDeferredOf is the unread test that leaves out mail the recipient set aside with a deferred thread (S-976).
func notDeferredOf(t string) string {
	return "NOT EXISTS (SELECT 1 FROM thread_defer_mail dm WHERE dm.mailbox_id = " + t + ".agent_id AND dm.mail_id = " + t + ".mail_id)"
}

// agentName is the name a mail shows for a sender: the human is "human", an agent its name, else the id.
func agentName(conn *sqlite.Conn, id string) string {
	if id == "human" {
		return "human"
	}
	name := id
	_ = sqlitex.Execute(conn, "SELECT name FROM agents WHERE id = ? OR name = ? ORDER BY id = ? DESC LIMIT 1", &sqlitex.ExecOptions{
		Args: []any{id, id, id}, ResultFunc: func(stmt *sqlite.Stmt) error { name = stmt.ColumnText(0); return nil }})
	return name
}

// withItsas is {itsas?, agents?} of a mail: the ITSAs it is linked to and the agents attached (src/db.ts withItsas).
func withItsas(conn *sqlite.Conn, row *jsfmt.Value, id string) error {
	links, err := rows(conn, `SELECT i.id, i.key, i.title, i.status, l.source FROM mail_itsas l JOIN itsas i ON i.id = l.itsa_id WHERE l.mail_id = ?
		ORDER BY CASE l.source WHEN 'itsa' THEN 0 WHEN 'named' THEN 1 WHEN 'attached' THEN 2 ELSE 3 END, i.created_at`, id)
	if err != nil {
		return err
	}
	if len(links) > 0 {
		row.Set("itsas", jsfmt.ArrayValue(links))
	}
	agents, err := rows(conn, "SELECT agent_id FROM mail_agents WHERE mail_id = ? ORDER BY rowid", id)
	if err != nil {
		return err
	}
	if len(agents) > 0 {
		var ids []jsfmt.Value
		for _, a := range agents {
			ids = append(ids, a.Items[0])
		}
		row.Set("agents", jsfmt.ArrayValue(ids))
	}
	return nil
}

// Inbox is the agent's mail, newest first, without bodies (src/db.ts inbox).
func (d *DB) Inbox(ctx context.Context, agentID string, unreadOnly bool, limit int) ([]jsfmt.Value, error) {
	q := `SELECT m.id, m.from_id, m.from_name, m.subject, m.title, m.summary, m.created_at, m.thread_id, m.reply_to, m.itsa_id, m.about_itsa, m.kind, m.health, r.read_at FROM mail m
		JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = ?`
	if unreadOnly {
		q += " AND r.read_at IS NULL AND " + notDeferredOf("r")
	}
	q += " ORDER BY m.created_at DESC LIMIT ?"
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		if out, err = rows(conn, q, agentID, limit); err != nil {
			return err
		}
		for i := range out {
			if err := withItsas(conn, &out[i], out[i].Text("id")); err != nil {
				return err
			}
		}
		return nil
	})
	return out, wrap("inbox", err)
}

// ReadMail returns the agent's full mails of ids, marking them read (src/db.ts readMail). With a batch they are also
// recorded as handed out in it, owed until a batch holding them is acknowledged (S-357). Fresh are the ids that were
// unread, for the caller's mail.read events.
func (d *DB) ReadMail(ctx context.Context, agentID string, ids []string, batch string) (mails []jsfmt.Value, fresh []string, readAt string, err error) {
	readAt = now()
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		for _, id := range ids {
			found, err := rows(conn, "SELECT m.*, r.read_at FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.id = ? AND r.agent_id = ?", id, agentID)
			if err != nil {
				return err
			}
			if len(found) == 0 {
				continue
			}
			m := found[0]
			if f, _ := m.Get("from_name"); f.Kind == jsfmt.Null {
				m.Set("from_name", jsfmt.StringValue(agentName(conn, m.Text("from_id"))))
			}
			m.Set("verdict", parseVerdict(m))
			atts, err := rows(conn, "SELECT name, path, size FROM attachments WHERE mail_id = ?", id)
			if err != nil {
				return err
			}
			m.Set("attachments", jsfmt.ArrayValue(atts))
			if ra, _ := m.Get("read_at"); ra.Kind == jsfmt.Null {
				fresh = append(fresh, id)
			}
			if err := runSQL(conn, "UPDATE mail_recipients SET read_at = COALESCE(read_at, ?) WHERE mail_id = ? AND agent_id = ?", readAt, id, agentID); err != nil {
				return err
			}
			if batch != "" {
				if err := runSQL(conn, "INSERT OR IGNORE INTO mail_deliveries (agent_id, mail_id, batch) VALUES (?, ?, ?)", agentID, id, batch); err != nil {
					return err
				}
			}
			mails = append(mails, m)
		}
		return nil
	})
	return mails, fresh, readAt, wrap("read mail", err)
}

func runSQL(conn *sqlite.Conn, query string, args ...any) error {
	return sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args})
}

// parseVerdict is src/db.ts parseVerdict: the stored verdict JSON when it is an object with a boolean `follows`, else null.
func parseVerdict(m jsfmt.Value) jsfmt.Value {
	raw, ok := m.Get("verdict")
	if !ok || raw.Kind != jsfmt.String || raw.Str == "" {
		return jsfmt.NullValue()
	}
	v, err := jsfmt.Parse([]byte(raw.Str))
	if err != nil || v.Kind != jsfmt.Object {
		return jsfmt.NullValue()
	}
	if f, ok := v.Get("follows"); !ok || f.Kind != jsfmt.Bool {
		return jsfmt.NullValue()
	}
	return v
}

// AckDelivered retires every mail of batch: the client got its reply (src/db.ts ackDelivered).
func (d *DB) AckDelivered(ctx context.Context, agentID, batch string) error {
	return wrap("ack delivered", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "DELETE FROM mail_deliveries WHERE agent_id = ? AND mail_id IN (SELECT mail_id FROM mail_deliveries WHERE agent_id = ? AND batch = ?)", agentID, agentID, batch)
	}))
}

const owedMaxAge = 6 * time.Hour

var noActionEnd = regexp.MustCompile(`(?i)\bno action needed\W*$`)

// endsNoAction is whether the body's last line ends "No action needed" (src/db.ts endsNoAction).
func endsNoAction(body string) bool {
	lines := strings.Split(strings.TrimSpace(body), "\n")
	return noActionEnd.MatchString(strings.TrimSpace(lines[len(lines)-1]))
}

// DefaultRead is what a read without ids hands out, at most limit: the mail owed first (oldest first), then unread mail,
// oldest first (src/db.ts defaultRead). Owed mail that is FYI or first read over six hours ago is dropped from the owed
// set (S-1091).
func (d *DB) DefaultRead(ctx context.Context, agentID string, limit int) ([]string, error) {
	var out []string
	cutoff := time.Now().Add(-owedMaxAge).UTC().Format("2006-01-02T15:04:05.000Z")
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		cands, err := rows(conn, `SELECT m.id, m.from_id, m.body, r.read_at FROM mail m JOIN mail_recipients r ON r.mail_id = m.id AND r.agent_id = ?
			WHERE m.id IN (SELECT mail_id FROM mail_deliveries WHERE agent_id = ?) ORDER BY m.created_at, m.rowid`, agentID, agentID)
		if err != nil {
			return err
		}
		var owed []string
		for _, c := range cands {
			readAt := c.Text("read_at")
			if strings.HasPrefix(c.Text("from_id"), "system:") || endsNoAction(c.Text("body")) || readAt < cutoff {
				if err := runSQL(conn, "DELETE FROM mail_deliveries WHERE agent_id = ? AND mail_id = ?", agentID, c.Text("id")); err != nil {
					return err
				}
				continue
			}
			owed = append(owed, c.Text("id"))
		}
		if len(owed) > limit {
			owed = owed[:limit]
		}
		unread, err := rows(conn, `SELECT m.id FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
			WHERE r.agent_id = ? AND r.read_at IS NULL AND `+notDeferredOf("r")+` AND m.id NOT IN (SELECT mail_id FROM mail_deliveries WHERE agent_id = ?)
			ORDER BY m.created_at, m.rowid LIMIT ?`, agentID, agentID, limit-len(owed))
		if err != nil {
			return err
		}
		out = owed
		for _, u := range unread {
			out = append(out, u.Text("id"))
		}
		return nil
	})
	return out, wrap("default read", err)
}

// ThreadMail is every message of a thread stored here, oldest first; with box, only what that box sent or received
// (src/db.ts threadMail). Reading marks nothing.
func (d *DB) ThreadMail(ctx context.Context, threadID, box string) ([]jsfmt.Value, error) {
	q := "SELECT * FROM mail m WHERE thread_id = ?"
	args := []any{threadID}
	if box != "" {
		q += " AND (m.from_id = ? OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?))"
		args = append(args, box, box)
	}
	q += " ORDER BY created_at"
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		if out, err = rows(conn, q, args...); err != nil {
			return err
		}
		for i := range out {
			m := &out[i]
			id := m.Text("id")
			m.Set("verdict", parseVerdict(*m))
			if f, _ := m.Get("from_name"); f.Kind == jsfmt.Null {
				m.Set("from_name", jsfmt.StringValue(agentName(conn, m.Text("from_id"))))
			}
			recips, err := rows(conn, "SELECT agent_id AS id, read_at, withdrawn_at, withdrawn_by, withdrawn_note FROM mail_recipients WHERE mail_id = ?", id)
			if err != nil {
				return err
			}
			m.Set("recipients", jsfmt.ArrayValue(recips))
			atts, err := rows(conn, "SELECT name, path, size FROM attachments WHERE mail_id = ?", id)
			if err != nil {
				return err
			}
			m.Set("attachments", jsfmt.ArrayValue(atts))
			if err := withItsas(conn, m, id); err != nil {
				return err
			}
		}
		return nil
	})
	return out, wrap("thread mail", err)
}

// MailThreadOf is the thread a mail is in, or its own id when it has none; "" when no such mail.
func (d *DB) MailThreadOf(ctx context.Context, id string) (string, error) {
	t := ""
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT COALESCE(thread_id, id) FROM mail WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error { t = stmt.ColumnText(0); return nil }})
	})
	return t, wrap("mail thread", err)
}

// ThreadIDsOf is the threads a mailbox sent or received mail in (src/db.ts threadIdsOf).
func (d *DB) ThreadIDsOf(ctx context.Context, box string) ([]string, error) {
	var out []string
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT DISTINCT m.thread_id FROM mail m WHERE m.from_id = ? OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?)",
			&sqlitex.ExecOptions{Args: []any{box, box}, ResultFunc: func(stmt *sqlite.Stmt) error {
				if !stmt.ColumnIsNull(0) {
					out = append(out, stmt.ColumnText(0))
				}
				return nil
			}})
	})
	return out, wrap("thread ids", err)
}

// ItsaThreadIDs is every thread that belongs to an ITSA: those an ITSA names and those whose mail carries an itsa_id.
func (d *DB) ItsaThreadIDs(ctx context.Context) (map[string]bool, error) {
	out := map[string]bool{}
	err := d.read(ctx, "SELECT thread_id FROM itsas WHERE thread_id IS NOT NULL UNION SELECT thread_id FROM mail WHERE itsa_id IS NOT NULL AND thread_id IS NOT NULL",
		func(c *cols) { out[c.text()] = true })
	return out, wrap("itsa threads", err)
}

// ThreadItsaIDs is the ITSAs a thread belongs to (src/db.ts threadItsaIds).
func (d *DB) ThreadItsaIDs(ctx context.Context, threadID string) ([]string, error) {
	var out []string
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT id FROM itsas WHERE thread_id = ? UNION SELECT itsa_id FROM mail WHERE thread_id = ? AND itsa_id IS NOT NULL",
			&sqlitex.ExecOptions{Args: []any{threadID, threadID}, ResultFunc: func(stmt *sqlite.Stmt) error { out = append(out, stmt.ColumnText(0)); return nil }})
	})
	return out, wrap("thread itsas", err)
}

// ThreadGranted is whether a spawner opened the whole thread to the agent (S-1107).
func (d *DB) ThreadGranted(ctx context.Context, threadID, agentID string) (bool, error) {
	ok := false
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT 1 FROM thread_readers WHERE thread_id = ? AND agent_id = ?",
			&sqlitex.ExecOptions{Args: []any{threadID, agentID}, ResultFunc: func(*sqlite.Stmt) error { ok = true; return nil }})
	})
	return ok, wrap("thread granted", err)
}

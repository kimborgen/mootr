package db

import (
	"context"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The mail push's reads and writes (src/db.ts unpushedCount, markPushed, inbox and unreadCount, S-2848 B1).

// NoticeMail is one unread mail as the push's prompt and the in-turn notice list it.
type NoticeMail struct {
	ID, FromID, Subject string
	FromName            *string
}

// MailNotice is the agent's unread mail, not counting mail it deferred: how many, and the newest limit of them (src/mail.ts
// noticeList). loudOnly leaves out quiet ITSA mail, which waits for the agent to be idle.
func (d *DB) MailNotice(ctx context.Context, id string, loudOnly bool, limit int) (count int, list []NoticeMail, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) error {
		count, list, err = mailNotice(conn, id, loudOnly, limit)
		return err
	})
	return count, list, wrap("mail notice", err)
}

// Unpushed is the agent's unread mail it hasn't been prompted about, not counting mail it deferred (src/db.ts
// unpushedCount): the ids, so MarkPushed marks only the mail a push named.
func (d *DB) Unpushed(ctx context.Context, id string) (out []string, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) error {
		out, err = unpushed(conn, id)
		return err
	})
	return out, wrap("unpushed", err)
}

// PushMail is what an idle agent's push prompts about, read in one snapshot: its unpushed mail (Unpushed), and its
// unread mail as the prompt counts and lists it (MailNotice, all mail). Every unpushed mail is then one the prompt
// counts, so marking them pushed neither names a mail twice nor marks one the prompt never counted.
func (d *DB) PushMail(ctx context.Context, id string, limit int) (ids []string, count int, list []NoticeMail, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		// A read transaction: both queries see the database as of the first.
		defer sqlitex.Save(conn)(&err)
		if ids, err = unpushed(conn, id); err != nil || len(ids) == 0 {
			return err
		}
		if pushMailBetween != nil {
			pushMailBetween()
		}
		count, list, err = mailNotice(conn, id, false, limit)
		return err
	})
	return ids, count, list, wrap("push mail", err)
}

// pushMailBetween, when a test sets it, runs inside PushMail between its two queries.
var pushMailBetween func()

func mailNotice(conn *sqlite.Conn, id string, loudOnly bool, limit int) (count int, list []NoticeMail, err error) {
	loud := ""
	if loudOnly {
		loud = " AND r.quiet = 0"
	}
	err = sqlitex.Execute(conn, "SELECT COUNT(*) FROM mail_recipients r WHERE r.agent_id = ? AND r.read_at IS NULL AND "+notDeferredOf("r")+loud,
		&sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error {
			count = stmt.ColumnInt(0)
			return nil
		}})
	if err != nil {
		return 0, nil, err
	}
	err = sqlitex.Execute(conn, `SELECT m.id, m.from_id, m.from_name, m.subject FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
		WHERE r.agent_id = ? AND r.read_at IS NULL AND `+notDeferredOf("r")+loud+` ORDER BY m.created_at DESC LIMIT ?`,
		&sqlitex.ExecOptions{Args: []any{id, limit}, ResultFunc: func(stmt *sqlite.Stmt) error {
			c := &cols{stmt: stmt}
			list = append(list, NoticeMail{ID: c.text(), FromID: c.text(), FromName: c.nullText(), Subject: c.text()})
			return nil
		}})
	return count, list, err
}

func unpushed(conn *sqlite.Conn, id string) (out []string, err error) {
	err = sqlitex.Execute(conn, "SELECT mail_id FROM mail_recipients WHERE agent_id = ? AND read_at IS NULL AND pushed_at IS NULL AND "+notDeferredOf("mail_recipients")+" ORDER BY rowid",
		&sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error {
			out = append(out, stmt.ColumnText(0))
			return nil
		}})
	return out, err
}

// MarkPushed records that the agent was prompted about these mails (src/db.ts markPushed). Unlike TS, which marks every
// unpushed mail when the push lands, mail that arrived while the prompt was on its way stays unpushed, so the next push
// names it.
func (d *DB) MarkPushed(ctx context.Context, id string, mailIDs []string) error {
	if len(mailIDs) == 0 {
		return nil
	}
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		args := []any{now(), id}
		for _, m := range mailIDs {
			args = append(args, m)
		}
		return runSQL(conn, "UPDATE mail_recipients SET pushed_at = ? WHERE agent_id = ? AND pushed_at IS NULL AND mail_id IN (?"+strings.Repeat(", ?", len(mailIDs)-1)+")", args...)
	})
	return wrap("mark pushed", err)
}

// Blockers is the agent's cost blockers, each as src/admission.ts blockedBy words it: "kind on account: reason".
func (d *DB) Blockers(ctx context.Context, id string) ([]string, error) {
	var out []string
	err := d.read(ctx, "SELECT kind, account, reason FROM blockers WHERE agent_id = ? ORDER BY since, rowid", func(c *cols) {
		kind, account, reason := c.text(), c.text(), c.text()
		if account != "" {
			kind += " on " + account
		}
		out = append(out, kind+": "+reason)
	}, id)
	return out, wrap("blockers", err)
}

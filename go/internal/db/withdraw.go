package db

import (
	"context"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// What the human's ask on an ITSA reads and writes (src/db.ts, src/itsa-human.ts, src/withdraw.ts; S-2849).

// FirstActiveAgentID is the agent that stands in as sender for stam's own mail (src/db.ts firstActiveAgent): the oldest
// active one, ok false when none is.
func (d *DB) FirstActiveAgentID(ctx context.Context) (id string, ok bool, err error) {
	err = d.read(ctx, "SELECT id FROM agents WHERE lifecycle = 'active' ORDER BY created_at LIMIT 1", func(c *cols) { id, ok = c.text(), true })
	return id, ok, wrap("first active agent", err)
}

// FirstAgentID is the oldest agent of any lifecycle (src/db.ts firstAgent), the stand-in sender when none is active.
func (d *DB) FirstAgentID(ctx context.Context) (id string, ok bool, err error) {
	err = d.read(ctx, "SELECT id FROM agents ORDER BY created_at LIMIT 1", func(c *cols) { id, ok = c.text(), true })
	return id, ok, wrap("first agent", err)
}

// CountEvents is how many events of the type were logged at or after ts.
func (d *DB) CountEvents(ctx context.Context, typ, since string) (n int, err error) {
	err = d.read(ctx, "SELECT count(*) FROM events WHERE type = ? AND ts >= ?", func(c *cols) { n = c.int() }, typ, since)
	return n, wrap("count events", err)
}

// LastAsk is the latest ask mail to the human about the ITSA, whenever it was sent and not yet withdrawn: the one an
// agent's move out of a human status settles (src/itsa-human.ts lastAsk).
func (d *DB) LastAsk(ctx context.Context, itsaID string) (id string, ok bool, err error) {
	err = d.read(ctx, `SELECT m.id FROM mail m JOIN mail_recipients r ON r.mail_id = m.id AND r.agent_id = 'human' AND r.withdrawn_at IS NULL
		WHERE m.about_itsa = ? AND m.kind = 'ask' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
		func(c *cols) { id, ok = c.text(), true }, itsaID)
	return id, ok, wrap("last ask", err)
}

// Withdrawn is a mail the human's copy of which was just withdrawn, with its thread.
type Withdrawn struct {
	ID, ThreadID string
	// IDs are the mails of the thread the withdrawal saw, for the archive to record by identity.
	IDs []string
}

// WithdrawFromHuman settles the human's copy of each mail (src/db.ts withdrawFromHuman): read, and marked withdrawn by
// `by` with the note. held are the ids the human has a copy of here; fresh the ones that were not withdrawn already, with
// their threads and the thread's mails at that moment. at is the time of the withdrawal.
func (d *DB) WithdrawFromHuman(ctx context.Context, ids []string, by, note string) (held []string, fresh []Withdrawn, at string, err error) {
	at = now()
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		held, fresh = nil, nil
		for _, id := range ids {
			found, withdrawn := false, false
			if err := sqlitex.Execute(conn, "SELECT withdrawn_at FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'",
				&sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error {
					found, withdrawn = true, !stmt.ColumnIsNull(0) && stmt.ColumnText(0) != ""
					return nil
				}}); err != nil {
				return err
			}
			if !found {
				continue
			}
			held = append(held, id)
			if withdrawn {
				continue
			}
			if err := runSQL(conn, "UPDATE mail_recipients SET read_at = COALESCE(read_at, ?), withdrawn_at = ?, withdrawn_by = ?, withdrawn_note = ? WHERE mail_id = ? AND agent_id = 'human'",
				at, at, by, note, id); err != nil {
				return err
			}
			w := Withdrawn{ID: id, ThreadID: id}
			if err := sqlitex.Execute(conn, "SELECT thread_id FROM mail WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error {
				if !stmt.ColumnIsNull(0) {
					w.ThreadID = stmt.ColumnText(0)
				}
				return nil
			}}); err != nil {
				return err
			}
			if err := sqlitex.Execute(conn, "SELECT id FROM mail WHERE thread_id = ? ORDER BY created_at", &sqlitex.ExecOptions{Args: []any{w.ThreadID}, ResultFunc: func(stmt *sqlite.Stmt) error {
				w.IDs = append(w.IDs, stmt.ColumnText(0))
				return nil
			}}); err != nil {
				return err
			}
			fresh = append(fresh, w)
		}
		return nil
	})
	return held, fresh, at, wrap("withdraw from human", err)
}

// ArchiveThread hides the thread from the mailbox's list (src/db.ts archiveThread): it records the ids of the thread's
// mail now, and the thread stays hidden only while it has no mail beyond them. Archiving undefers it.
func (d *DB) ArchiveThread(ctx context.Context, mailbox, threadID string, mailIDs []string) error {
	return wrap("archive thread", d.Write(ctx, func(conn *sqlite.Conn) error {
		for _, q := range []string{
			"DELETE FROM thread_defer WHERE mailbox_id = ? AND thread_id = ?",
			"DELETE FROM thread_defer_mail WHERE mailbox_id = ? AND thread_id = ?",
			"INSERT OR REPLACE INTO thread_archive (mailbox_id, thread_id) VALUES (?, ?)",
			"DELETE FROM thread_archive_mail WHERE mailbox_id = ? AND thread_id = ?",
		} {
			if err := runSQL(conn, q, mailbox, threadID); err != nil {
				return err
			}
		}
		for _, id := range mailIDs {
			if err := runSQL(conn, "INSERT OR IGNORE INTO thread_archive_mail (mailbox_id, thread_id, mail_id) VALUES (?, ?, ?)", mailbox, threadID, id); err != nil {
				return err
			}
		}
		return nil
	}))
}

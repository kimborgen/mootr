package db

import (
	"context"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The peer outbox of src/db.ts (S-235): mail for a peer that didn't answer, the exact body its POST /api/mail takes,
// redelivered by the daemon (server.deliverOutbox). mail_id is the id the peer stores it under.

// OutboxRow is a peer_outbox row.
type OutboxRow struct {
	MailID    string
	Peer      string
	Body      string
	CreatedAt string
	Attempts  int64
	LastError *string
}

// QueueOutbox is src/db.ts queueOutbox: the mail waits for the peer. A mail already queued for that peer stays as it is.
func (d *DB) QueueOutbox(ctx context.Context, mailID, peer, body string) error {
	return d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "INSERT OR IGNORE INTO peer_outbox (mail_id, peer, body, created_at, attempts, last_error) VALUES (?, ?, ?, ?, 0, NULL)", mailID, peer, body, now())
	})
}

// OutboxHasPeer says whether any mail waits for the peer.
func (d *DB) OutboxHasPeer(ctx context.Context, peer string) (bool, error) {
	has := false
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT 1 FROM peer_outbox WHERE peer = ? LIMIT 1", &sqlitex.ExecOptions{Args: []any{peer}, ResultFunc: func(*sqlite.Stmt) error {
			has = true
			return nil
		}})
	})
	return has, wrap("outbox", err)
}

// OutboxRows is every queued mail, oldest first.
func (d *DB) OutboxRows(ctx context.Context) ([]OutboxRow, error) {
	var out []OutboxRow
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = outboxRows(conn, "SELECT * FROM peer_outbox ORDER BY created_at, rowid")
		return err
	})
	return out, wrap("outbox", err)
}

// OutboxDelete takes the mail off the peer's queue.
func (d *DB) OutboxDelete(ctx context.Context, mailID, peer string) error {
	return d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "DELETE FROM peer_outbox WHERE mail_id = ? AND peer = ?", mailID, peer)
	})
}

// OutboxFailed counts a failed attempt and keeps its reason; the mail stays queued.
func (d *DB) OutboxFailed(ctx context.Context, mailID, peer, reason string) error {
	return d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "UPDATE peer_outbox SET attempts = attempts + 1, last_error = ? WHERE mail_id = ? AND peer = ?", reason, mailID, peer)
	})
}

// OutboxExpire drops the mail queued before `before` (an ISO time) and returns it.
func (d *DB) OutboxExpire(ctx context.Context, before string) ([]OutboxRow, error) {
	var old []OutboxRow
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		var err error
		if old, err = outboxRows(conn, "SELECT * FROM peer_outbox WHERE created_at < ?", before); err != nil {
			return err
		}
		return runSQL(conn, "DELETE FROM peer_outbox WHERE created_at < ?", before)
	})
	return old, err
}

func outboxRows(conn *sqlite.Conn, query string, args ...any) ([]OutboxRow, error) {
	var out []OutboxRow
	err := sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
		r := OutboxRow{
			MailID:    stmt.GetText("mail_id"),
			Peer:      stmt.GetText("peer"),
			Body:      stmt.GetText("body"),
			CreatedAt: stmt.GetText("created_at"),
			Attempts:  stmt.GetInt64("attempts"),
		}
		if i := stmt.ColumnIndex("last_error"); i >= 0 && stmt.ColumnType(i) != sqlite.TypeNull {
			e := stmt.ColumnText(i)
			r.LastError = &e
		}
		out = append(out, r)
		return nil
	}})
	return out, err
}

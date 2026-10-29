package db

import (
	"context"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// PeerTitleConfig is src/db.ts PEER_TITLE_CONFIG: the config a peer's title carries. This daemon never asks for it, so a
// peer copy is never regenerated here (S-1843).
const PeerTitleConfig = "peer"

// MailTitleRow is what src/mail-title.ts mailTitlesShown reads of a mail: its subject and body (empty for NULL), the hash
// its title was asked with (nil for a title from before the column, or none), and whether the human is a recipient.
type MailTitleRow struct {
	Subject, Body string
	ConfigHash    *string
	ToHuman       bool
}

// MailTitleRow is src/db.ts mailTitleRow, getMail and mailRecipientIds for one mail; ErrNotFound for no such mail.
func (d *DB) MailTitleRow(ctx context.Context, id string) (MailTitleRow, error) {
	var row MailTitleRow
	found := false
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT subject, body, title_config, EXISTS (SELECT 1 FROM mail_recipients WHERE mail_id = mail.id AND agent_id = 'human') FROM mail WHERE id = ?",
			&sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error {
				c := cols{stmt: stmt}
				row.Subject, row.Body, row.ConfigHash, row.ToHuman, found = c.text(), c.text(), c.nullText(), c.int() != 0, true
				return nil
			}})
	})
	if err == nil && !found {
		err = ErrNotFound
	}
	return row, wrap("mail title row", err)
}

// SetMailTitle is src/db.ts setMailTitle: the title with the hash of the model and prompt it was asked with.
func (d *DB) SetMailTitle(ctx context.Context, id, title, configHash string) error {
	return wrap("set mail title", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "UPDATE mail SET title = ?, title_config = ? WHERE id = ?", title, configHash, id)
	}))
}

// SetMailTitleConfig is src/db.ts setMailTitleConfig: the hash a title call was asked with, for a call that gave only a
// summary.
func (d *DB) SetMailTitleConfig(ctx context.Context, id, configHash string) error {
	return wrap("set mail title config", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "UPDATE mail SET title_config = ? WHERE id = ?", configHash, id)
	}))
}

// SetMailSummary is src/db.ts setMailSummary.
func (d *DB) SetMailSummary(ctx context.Context, id, summary string) error {
	return wrap("set mail summary", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "UPDATE mail SET summary = ? WHERE id = ?", summary, id)
	}))
}

package db

import (
	"context"
	"slices"
	"strconv"
)

// The mail stam's own agent view shows among the agent's conversation (src/db.ts mailTo, mailReadIn, mailBy;
// src/agent-view.ts withMail).

// ViewMail is a mail row as the view reads it; ReadAt is the reader's own read state, nil when unread or for a mail the
// agent sent.
type ViewMail struct {
	ID, FromID, Subject, Body, CreatedAt string
	FromName, ThreadID, ReadAt          *string
	// To is a sent mail's recipients with each one's read state, in the order they were added.
	To []ViewRecipient
}

// ViewRecipient is one recipient of a mail the agent sent.
type ViewRecipient struct {
	ID     string
	ReadAt *string
}

const viewMailCols = "m.id, m.from_id, m.from_name, m.subject, m.body, m.created_at, m.thread_id"

func scanViewMail(c *cols, withRead bool) ViewMail {
	m := ViewMail{ID: c.text(), FromID: c.text(), FromName: c.nullText(), Subject: c.text(), Body: c.text(), CreatedAt: c.text(), ThreadID: c.nullText()}
	if withRead {
		m.ReadAt = c.nullText()
	}
	return m
}

// MailTo is src/db.ts mailTo: mail to the agent from others, created in [since, before), the newest limit of them,
// oldest first, with its read state.
func (d *DB) MailTo(ctx context.Context, agentID, since, before string, limit int) ([]ViewMail, error) {
	var out []ViewMail
	err := d.read(ctx, `SELECT `+viewMailCols+`, r.read_at FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
		WHERE r.agent_id = ? AND m.from_id != ? AND m.created_at >= ? AND m.created_at < ?
		ORDER BY m.created_at DESC LIMIT ?`, func(c *cols) { out = append(out, scanViewMail(c, true)) }, agentID, agentID, since, before, limit)
	slices.Reverse(out)
	return out, wrap("mail to", err)
}

// MailReadIn is src/db.ts mailReadIn: mail to the agent from others, read in [since, before) whenever it was created,
// the newest limit of those reads, oldest first.
func (d *DB) MailReadIn(ctx context.Context, agentID, since, before string, limit int) ([]ViewMail, error) {
	var out []ViewMail
	err := d.read(ctx, `SELECT `+viewMailCols+`, r.read_at FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
		WHERE r.agent_id = ? AND r.read_at IS NOT NULL AND m.from_id != ? AND r.read_at >= ? AND r.read_at < ?
		ORDER BY r.read_at DESC LIMIT ?`, func(c *cols) { out = append(out, scanViewMail(c, true)) }, agentID, agentID, since, before, limit)
	slices.Reverse(out)
	return out, wrap("mail read in", err)
}

// MailBy is src/db.ts mailBy: mail the agent sent, created in [since, before), the newest limit of them, oldest first,
// each with its recipients.
func (d *DB) MailBy(ctx context.Context, agentID, since, before string, limit int) ([]ViewMail, error) {
	var out []ViewMail
	err := d.read(ctx, `SELECT `+viewMailCols+` FROM mail m WHERE m.from_id = ? AND m.created_at >= ? AND m.created_at < ?
		ORDER BY m.created_at DESC LIMIT ?`, func(c *cols) { out = append(out, scanViewMail(c, false)) }, agentID, since, before, limit)
	if err != nil {
		return nil, wrap("mail by", err)
	}
	slices.Reverse(out)
	for i := range out {
		out[i].To = []ViewRecipient{}
		err := d.read(ctx, "SELECT agent_id, read_at FROM mail_recipients WHERE mail_id = ? ORDER BY rowid", func(c *cols) {
			out[i].To = append(out[i].To, ViewRecipient{ID: c.text(), ReadAt: c.nullText()})
		}, out[i].ID)
		if err != nil {
			return nil, wrap("mail by", err)
		}
	}
	return out, nil
}

// MailMark is a short summary of the agent's mail that changes when it gets, sends or reads a mail, or a mail it sent is
// read: the open view polls it in place of TS's mail observers (db.onAgentMail), which see every write.
func (d *DB) MailMark(ctx context.Context, agentID string) (string, error) {
	mark := ""
	err := d.read(ctx, `SELECT
		(SELECT COUNT(*) FROM mail_recipients WHERE agent_id = ?1 AND read_at IS NULL),
		(SELECT COUNT(*) || '/' || IFNULL(MAX(read_at), '') FROM mail_recipients WHERE agent_id = ?1 AND read_at IS NOT NULL),
		(SELECT COUNT(*) || '/' || COUNT(r.read_at) || '/' || IFNULL(MAX(r.read_at), '') FROM mail m
			JOIN mail_recipients r ON r.mail_id = m.id WHERE m.from_id = ?1)`, func(c *cols) {
		mark = strconv.Itoa(c.int()) + " " + c.text() + " " + c.text()
	}, agentID)
	return mark, wrap("mail mark", err)
}

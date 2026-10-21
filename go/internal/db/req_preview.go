package db

import (
	"context"

	"zombiezen.com/go/sqlite"

	"stam/internal/jsfmt"
)

// The recent real subjects a requirement preview runs on (src/req-check.ts candidates, src/steps.ts examples), newest first.

func (d *DB) previewRows(ctx context.Context, what, query string, args ...any) ([]jsfmt.Value, error) {
	var found []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		found, err = rows(conn, query, args...)
		return err
	})
	return found, wrap(what, err)
}

// PreviewMail is the last n mails not from the human, not a permission ask and not stam's own.
func (d *DB) PreviewMail(ctx context.Context, n int) ([]jsfmt.Value, error) {
	return d.previewRows(ctx, "preview mail", "SELECT id, from_id, subject, body, thread_id FROM mail WHERE from_id != 'human' AND permission_id IS NULL AND subject NOT LIKE '[stam]%' ORDER BY created_at DESC, rowid DESC LIMIT ?", n)
}

// PreviewMailToHuman is the last n mails to the human, on the same terms.
func (d *DB) PreviewMailToHuman(ctx context.Context, n int) ([]jsfmt.Value, error) {
	return d.previewRows(ctx, "preview mail to human", `SELECT m.id, m.from_id, m.subject, m.body, m.thread_id FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
		WHERE r.agent_id = 'human' AND m.from_id != 'human' AND m.permission_id IS NULL AND m.subject NOT LIKE '[stam]%'
		ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`, n)
}

// PreviewItsaCreated is the last n ITSAs by creation.
func (d *DB) PreviewItsaCreated(ctx context.Context, n int) ([]jsfmt.Value, error) {
	return d.previewRows(ctx, "preview created ITSAs", "SELECT * FROM itsas ORDER BY created_at DESC, rowid DESC LIMIT ?", n)
}

// PreviewItsaStatus is the last n status changes, each with its ITSA's columns (the event's actor and data come first).
func (d *DB) PreviewItsaStatus(ctx context.Context, n int) ([]jsfmt.Value, error) {
	return d.previewRows(ctx, "preview ITSA status changes", "SELECT e.actor, e.data, i.* FROM itsa_events e JOIN itsas i ON i.id = e.itsa_id WHERE e.type = 'status' ORDER BY e.id DESC LIMIT ?", n)
}

// PreviewBranchLinks is the last n branch links by their ITSA's update time: the ITSA id, the branch and the link's meta.
func (d *DB) PreviewBranchLinks(ctx context.Context, n int) ([]jsfmt.Value, error) {
	return d.previewRows(ctx, "preview branch links", "SELECT i.id, l.external_id AS branch, l.meta FROM itsa_links l JOIN itsas i ON i.id = l.itsa_id WHERE l.system = 'branch' AND l.external_id IS NOT NULL ORDER BY i.updated_at DESC LIMIT ?", n)
}

// RequirementAskItsa is the id of the newest ITSA linked to a requirement (system `requirement`, its key), "" for none.
func (d *DB) RequirementAskItsa(ctx context.Context, key string) (string, error) {
	found, err := d.previewRows(ctx, "requirement ask", "SELECT i.id FROM itsa_links l JOIN itsas i ON i.id = l.itsa_id WHERE l.system = 'requirement' AND l.external_id = ? ORDER BY i.created_at DESC LIMIT 1", key)
	if err != nil || len(found) == 0 {
		return "", err
	}
	return found[0].Text("id"), nil
}

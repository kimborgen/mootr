package db

import (
	"context"
	"strings"

	"zombiezen.com/go/sqlite"

	"stam/internal/jsfmt"
)

// What an ITSA's thread view and the human's attention list read (src/db.ts, src/itsa.ts, src/itsa-human.ts; S-2849).

// ThreadGroup is one mail thread with every message stored here, as src/db.ts aboutItsaThreads gives it.
type ThreadGroup struct {
	ThreadID string
	Mails    []jsfmt.Value
}

// AboutItsaThreads is the threads holding mail about an ITSA (its about_itsa), newest activity first. The ITSA's own
// thread is left to the caller.
func (d *DB) AboutItsaThreads(ctx context.Context, itsaID string) ([]ThreadGroup, error) {
	var ids []string
	err := d.read(ctx, "SELECT thread_id AS t, MAX(created_at) AS last FROM mail WHERE about_itsa = ? GROUP BY thread_id ORDER BY last DESC",
		func(c *cols) {
			// A mail with no thread matches no thread (WHERE thread_id = NULL), so its group has no mails.
			if t := c.nullText(); t != nil {
				ids = append(ids, *t)
			}
		}, itsaID)
	if err != nil {
		return nil, wrap("about threads", err)
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

// DeferredThreadIDs is the threads the human set aside (src/db.ts deferredThreadIds).
func (d *DB) DeferredThreadIDs(ctx context.Context) (map[string]bool, error) {
	out := map[string]bool{}
	err := d.read(ctx, "SELECT thread_id FROM thread_deferred", func(c *cols) { out[c.text()] = true })
	return out, wrap("deferred threads", err)
}

// ItsaStatusSince is src/itsa.ts statusSince: the time of the ITSA's latest status event, else created; skip counts back
// past that many status events (1: the change before the latest).
func (d *DB) ItsaStatusSince(ctx context.Context, id, created string, skip int) (string, error) {
	since := created
	err := d.read(ctx, "SELECT ts FROM itsa_events WHERE itsa_id = ? AND type = 'status' ORDER BY id DESC LIMIT 1 OFFSET ?",
		func(c *cols) { since = c.text() }, id, skip)
	return since, wrap("status since", err)
}

// ItsasInStatuses is the rows of the ITSAs in any of the statuses, in table order (src/itsa-human.ts waiting).
func (d *DB) ItsasInStatuses(ctx context.Context, names []string) ([]jsfmt.Value, error) {
	if len(names) == 0 {
		return nil, nil
	}
	args := make([]any, len(names))
	for i, n := range names {
		args[i] = n
	}
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = rows(conn, "SELECT * FROM itsas WHERE status IN ("+strings.TrimSuffix(strings.Repeat("?, ", len(names)), ", ")+")", args...)
		return err
	})
	return out, wrap("ITSAs in statuses", err)
}

// LatestAsk is the latest ask mail to the human about the ITSA since the time (src/itsa-human.ts latestAsk): its id and
// thread, ok false when none.
func (d *DB) LatestAsk(ctx context.Context, itsaID, since string) (id, thread string, ok bool, err error) {
	err = d.read(ctx, `SELECT m.id, m.thread_id FROM mail m JOIN mail_recipients r ON r.mail_id = m.id AND r.agent_id = 'human'
		WHERE m.about_itsa = ? AND m.kind = 'ask' AND m.created_at >= ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
		func(c *cols) { id, thread, ok = c.text(), c.text(), true }, itsaID, since)
	return id, thread, ok, wrap("latest ask", err)
}

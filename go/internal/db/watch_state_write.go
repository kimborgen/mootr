package db

import (
	"context"

	"zombiezen.com/go/sqlite"
)

// PollApplyUnder is PollApply for a row under a watched subject (a Linear team's issue, `linear:team:ENG/ENG-1`, or the team's
// own cursor row): the events and the row are stored in ONE write transaction, and only if `watched` is watched when it begins.
// subject is `watched` itself, or a row under it. evs may be empty (a cursor). written is false when nothing was stored.
func (d *DB) PollApplyUnder(ctx context.Context, watched, subject string, evs []PollEvent, state, etags, now string, nowMs int64, of SubjectsOf) (outs []IngestOut, written bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		outs, written = nil, false
		w, err := watchedConn(conn, nowMs, of)
		if err != nil || !w[watched] {
			return err
		}
		if TestHookWatchCommit != nil {
			TestHookWatchCommit()
		}
		for _, e := range evs {
			out, err := d.ingestConn(conn, e.In, e.Hooks)
			if err != nil {
				return err
			}
			outs = append(outs, out)
		}
		written = true
		return runSQL(conn, "INSERT INTO watch_state (subject, state, etags, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET state = excluded.state, etags = excluded.etags, updated_at = excluded.updated_at", subject, state, etags, now)
	})
	return outs, written, wrap("apply poll", err)
}

// TestHookWatchCommit is for tests only: it runs inside PollApplyUnder's transaction right after the check of the watchers and
// before the write.
var TestHookWatchCommit func()

// DropUnwatchedTree deletes each given subject's row and the rows under it (`subject/...`, src/db.ts deleteWatchStateTree)
// when nobody watches the subject and the subject's own row was last written before olderThan (an ISO time; a subject with no
// row of its own counts as old), in one transaction that reads the watchers itself: a row unwatched for a shorter time is the
// baseline of a watch that comes back. Returns the subjects it deleted rows for.
func (d *DB) DropUnwatchedTree(ctx context.Context, subjects []string, nowMs int64, olderThan string, of SubjectsOf) (dropped []string, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		dropped = nil
		w, err := watchedConn(conn, nowMs, of)
		if err != nil {
			return err
		}
		for _, s := range subjects {
			if w[s] {
				continue
			}
			if err := runSQL(conn, "DELETE FROM watch_state WHERE (subject = ? OR substr(subject, 1, ?) = ?) AND COALESCE((SELECT updated_at FROM watch_state WHERE subject = ?), '') < ?", s, len(s)+1, s+"/", s, olderThan); err != nil {
				return err
			}
			if conn.Changes() > 0 {
				dropped = append(dropped, s)
			}
		}
		return nil
	})
	return dropped, wrap("drop watch state tree", err)
}

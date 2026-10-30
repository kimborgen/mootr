package db

import (
	"context"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// WatchState is src/db.ts getWatchState's state: the poller's snapshot of a watched subject, as JSON text; ok is false
// when the subject has none.
func (d *DB) WatchState(ctx context.Context, subject string) (state string, ok bool, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT state FROM watch_state WHERE subject = ?", &sqlitex.ExecOptions{Args: []any{subject}, ResultFunc: func(stmt *sqlite.Stmt) error {
			state, ok = stmt.ColumnText(0), true
			return nil
		}})
	})
	return state, ok, err
}

// WatchRow is a poller's whole row for a subject: its snapshot and request ETags as JSON text.
type WatchRow struct{ State, Etags, UpdatedAt string }

// WatchRow is src/db.ts getWatchState; ok is false when the subject has no row.
func (d *DB) WatchRow(ctx context.Context, subject string) (row WatchRow, ok bool, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT state, etags, updated_at FROM watch_state WHERE subject = ?", &sqlitex.ExecOptions{Args: []any{subject}, ResultFunc: func(stmt *sqlite.Stmt) error {
			row, ok = WatchRow{stmt.ColumnText(0), stmt.ColumnText(1), stmt.ColumnText(2)}, true
			return nil
		}})
	})
	return row, ok, wrap("watch state", err)
}

// WatchStateSubjects is the subjects with a row that start with prefix (src/db.ts watchStateSubjects).
func (d *DB) WatchStateSubjects(ctx context.Context, prefix string) (out []string, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT subject FROM watch_state WHERE substr(subject, 1, ?) = ? ORDER BY subject", &sqlitex.ExecOptions{Args: []any{len(prefix), prefix}, ResultFunc: func(stmt *sqlite.Stmt) error {
			out = append(out, stmt.ColumnText(0))
			return nil
		}})
	})
	return out, wrap("watch state subjects", err)
}

// SubjectsOf names the subjects a stored filter (a subscription's) or an event wait's data lists.
type SubjectsOf struct {
	Filter func(filter string) []string
	Wait   func(data *string) []string
}

// watchedConn is the set of subjects a live subscription or an open event wait names, read in conn's transaction. An
// expired subscription and a process start row name none (src/watch.ts watchedSubjects).
func watchedConn(conn *sqlite.Conn, nowMs int64, of SubjectsOf) (map[string]bool, error) {
	out := map[string]bool{}
	err := sqlitex.Execute(conn, "SELECT filter FROM event_subscriptions WHERE subscriber_kind != 'process' AND (expires_at IS NULL OR expires_at > ?)", &sqlitex.ExecOptions{Args: []any{nowMs}, ResultFunc: func(stmt *sqlite.Stmt) error {
		for _, s := range of.Filter(stmt.ColumnText(0)) {
			out[s] = true
		}
		return nil
	}})
	if err != nil {
		return nil, err
	}
	err = sqlitex.Execute(conn, "SELECT data FROM waits WHERE kind = 'event' AND agent_id IN (SELECT id FROM agents)", &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
		var data *string
		if stmt.ColumnType(0) != sqlite.TypeNull {
			t := stmt.ColumnText(0)
			data = &t
		}
		for _, s := range of.Wait(data) {
			out[s] = true
		}
		return nil
	}})
	return out, err
}

// WatchedSubjects is every subject a live subscription or open event wait names.
func (d *DB) WatchedSubjects(ctx context.Context, nowMs int64, of SubjectsOf) (out map[string]bool, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		out, err = watchedConn(conn, nowMs, of)
		return err
	})
	return out, wrap("watched subjects", err)
}

// PollEvent is one event a poll found, with the hooks that match it.
type PollEvent struct {
	In    IngestIn
	Hooks IngestHooks
}

// PollApply stores a poll's events and its snapshot in ONE write transaction. The predicate is whether the subject was
// watched when the transaction began, read before the first event: an unwatched subject stores nothing, and a watch the
// last event ends (a merge, an event wait it clears) still has its snapshot stored, so the final state of a merged or closed
// pull request is never lost to the event that ended its watch. A stop leaves both or neither, so a restart finds neither
// an event twice nor one lost. written is false when nothing was stored.
func (d *DB) PollApply(ctx context.Context, subject string, evs []PollEvent, state, etags, now string, nowMs int64, of SubjectsOf) (outs []IngestOut, written bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		outs, written = nil, false
		w, err := watchedConn(conn, nowMs, of)
		if err != nil || !w[subject] {
			return err
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

// DropUnwatchedState deletes the rows of the given subjects that nobody watches and that were last written before olderThan
// (an ISO time), in one transaction that reads the watchers itself: a row unwatched for a shorter time is the baseline of a
// watch that comes back. Every pull request's row stays, open, merged or closed: the diff header and diffReview read its review verdict
// after the watch ended. Only issue, repo and typeless (legacy `{}`) rows go. Returns the subjects it deleted.
func (d *DB) DropUnwatchedState(ctx context.Context, subjects []string, nowMs int64, olderThan string, of SubjectsOf) (dropped []string, err error) {
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
			if err := runSQL(conn, "DELETE FROM watch_state WHERE subject = ? AND updated_at < ? AND NOT COALESCE(json_extract(state, '$.type') = 'pr', 0)", s, olderThan); err != nil {
				return err
			}
			if conn.Changes() > 0 {
				dropped = append(dropped, s)
			}
		}
		return nil
	})
	return dropped, wrap("drop watch state", err)
}

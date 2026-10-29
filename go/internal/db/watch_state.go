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

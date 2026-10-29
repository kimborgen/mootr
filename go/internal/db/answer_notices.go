package db

import (
	"context"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The answer notices (S-3923): the rendered notice of a permission or input answer, kept from the moment the answer is
// recorded until its agent is handed the text, so a restart before then delivers it once. src/db.ts's schema makes the
// table in TS; EnsureAnswerNotices makes it here the same way EnsureCostTables does.

// AnswerNotice is an answer_notices row.
type AnswerNotice struct {
	ID      int64
	AgentID string
	Text    string
}

// EnsureAnswerNotices makes answer_notices on a database that lacks it.
func EnsureAnswerNotices(conn *sqlite.Conn) error {
	if err := sqlitex.ExecuteTransient(conn, `CREATE TABLE IF NOT EXISTS answer_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`, nil); err != nil {
		return err
	}
	return sqlitex.ExecuteTransient(conn, "CREATE INDEX IF NOT EXISTS answer_notices_agent ON answer_notices(agent_id, id)", nil)
}

// answerWrite runs fn in a write transaction with the answer_notices table made.
func (d *DB) answerWrite(ctx context.Context, what string, fn func(conn *sqlite.Conn) error) error {
	return wrap(what, d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := EnsureAnswerNotices(conn); err != nil {
			return err
		}
		return fn(conn)
	}))
}

// NewAnswerNotice is the notice an answer writes with its decision (S-3923): the agent and the rendered text.
type NewAnswerNotice struct {
	AgentID, Text string
}

// insertAnswerNotice writes a row for an agent that exists and isn't archived (src/db.ts addAnswerNotice): 0 comes back
// for an agent gone by then, and no row is written.
func insertAnswerNotice(conn *sqlite.Conn, agentID, text string) (int64, error) {
	if err := sqlitex.Execute(conn, "INSERT INTO answer_notices (agent_id, text, created_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM agents WHERE id = ? AND lifecycle != 'archived')", &sqlitex.ExecOptions{Args: []any{agentID, text, now(), agentID}}); err != nil {
		return 0, err
	}
	if conn.Changes() == 0 {
		return 0, nil
	}
	return conn.LastInsertRowID(), nil
}

// AddAnswerNotice stores a notice's text for the agent and returns the row's id, 0 for none.
func (d *DB) AddAnswerNotice(ctx context.Context, agentID, text string) (int64, error) {
	var id int64
	err := d.answerWrite(ctx, "add answer notice", func(conn *sqlite.Conn) error {
		var err error
		id, err = insertAnswerNotice(conn, agentID, text)
		return err
	})
	return id, err
}

// DeleteAnswerNoticesOf drops an archived or forgotten agent's rows (S-3923).
func (d *DB) DeleteAnswerNoticesOf(ctx context.Context, agentID string) error {
	return d.answerWrite(ctx, "delete answer notices of an agent", func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "DELETE FROM answer_notices WHERE agent_id = ?", &sqlitex.ExecOptions{Args: []any{agentID}})
	})
}

// DeleteAnswerNotice drops a row once its agent has been handed the text.
func (d *DB) DeleteAnswerNotice(ctx context.Context, id int64) error {
	return d.answerWrite(ctx, "delete answer notice", func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "DELETE FROM answer_notices WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id}})
	})
}

// AnswerNotices lists every row, oldest first.
func (d *DB) AnswerNotices(ctx context.Context) ([]AnswerNotice, error) {
	var out []AnswerNotice
	err := d.answerWrite(ctx, "list answer notices", func(conn *sqlite.Conn) error {
		out = nil
		return sqlitex.Execute(conn, "SELECT id, agent_id, text FROM answer_notices ORDER BY id", &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
			out = append(out, AnswerNotice{ID: stmt.ColumnInt64(0), AgentID: stmt.ColumnText(1), Text: stmt.ColumnText(2)})
			return nil
		}})
	})
	return out, err
}

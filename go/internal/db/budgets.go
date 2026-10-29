package db

import (
	"context"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The human's budget mails (src/budgets.ts mailed): one per scope, period and budget amount, kept in a table of its own
// that TS makes on first use, as this does.

const budgetMailsTable = "CREATE TABLE IF NOT EXISTS budget_mails (key TEXT PRIMARY KEY, created_at TEXT NOT NULL)"

// BudgetMailed is whether the budget mail with this key was sent.
func (d *DB) BudgetMailed(ctx context.Context, key string) (bool, error) {
	found := false
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, budgetMailsTable); err != nil {
			return err
		}
		return sqlitex.Execute(conn, "SELECT 1 FROM budget_mails WHERE key = ?", &sqlitex.ExecOptions{Args: []any{key},
			ResultFunc: func(*sqlite.Stmt) error { found = true; return nil }})
	})
	return found, wrap("budget mailed", err)
}

// RecordBudgetMail records the budget mail with this key as sent at (an ISO time); a second record keeps the first.
func (d *DB) RecordBudgetMail(ctx context.Context, key, at string) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, budgetMailsTable); err != nil {
			return err
		}
		return runSQL(conn, "INSERT OR IGNORE INTO budget_mails (key, created_at) VALUES (?, ?)", key, at)
	})
	return wrap("record budget mail", err)
}

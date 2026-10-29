package db

import (
	"context"

	"zombiezen.com/go/sqlite"
)

// The tables the cost rules read and write besides the blockers (src/rules.ts, S-2848 B4b): every harness's latest
// subscription reading, the windows a clear lifted (window_clears), the newest peer reading below 100% per window
// (window_resets), and the holds a limit error leaves on an account (account_holds).

// SubscriptionRow is one subscriptions row: a harness's (or 'codex:ID', 'openrouter') latest reading.
type SubscriptionRow struct {
	Name, Data, UpdatedAt string
}

// Subscriptions is every subscriptions row, in the table's order.
func (d *DB) Subscriptions(ctx context.Context) ([]SubscriptionRow, error) {
	var out []SubscriptionRow
	err := d.read(ctx, "SELECT name, data, updated_at FROM subscriptions", func(c *cols) {
		out = append(out, SubscriptionRow{Name: c.text(), Data: c.text(), UpdatedAt: c.text()})
	})
	return out, wrap("subscriptions", err)
}

// BlockersFor is src/blockers.ts blockersFor: every blocker on the account, oldest first.
func (d *DB) BlockersFor(ctx context.Context, account string) ([]Blocker, error) {
	var out []Blocker
	err := d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		out, err = blockersOn(conn, "WHERE account = ?", account)
		return err
	})
	return out, wrap("blockers for", err)
}

// WindowClearAt is src/db.ts windowClearAt: when the account's window last cleared, in ms; ok is false when never.
func (d *DB) WindowClearAt(ctx context.Context, account, window string) (at float64, ok bool, err error) {
	err = d.read(ctx, "SELECT at FROM window_clears WHERE account = ? AND window = ?", func(c *cols) {
		at, ok = c.stmt.ColumnFloat(c.next()), true
	}, account, window)
	return at, ok, wrap("window clear", err)
}

// NoteWindowReset keeps the newest time a peer read the account's window below 100% (src/rules.ts acrossMachines).
func (d *DB) NoteWindowReset(ctx context.Context, account, window string, at float64) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "INSERT INTO window_resets (account, window, at) VALUES (?, ?, ?) ON CONFLICT (account, window) DO UPDATE SET at = MAX(at, excluded.at)",
			account, window, at)
	})
	return wrap("note window reset", err)
}

// WindowResetAt is the newest time a peer read the account's window below 100%, in ms; ok is false when none did.
func (d *DB) WindowResetAt(ctx context.Context, account, window string) (at float64, ok bool, err error) {
	err = d.read(ctx, "SELECT at FROM window_resets WHERE account = ? AND window = ?", func(c *cols) {
		at, ok = c.stmt.ColumnFloat(c.next()), true
	}, account, window)
	return at, ok, wrap("window reset", err)
}

// AccountHold is an account_holds row: a limit error that named no window holds the account until ResetsAt (ms).
type AccountHold struct {
	ResetsAt      float64
	Source, Since string
}

// HoldOf is the account's hold; ok is false when it has none.
func (d *DB) HoldOf(ctx context.Context, account string) (h AccountHold, ok bool, err error) {
	err = d.read(ctx, "SELECT resets_at, source, since FROM account_holds WHERE account = ?", func(c *cols) {
		h, ok = AccountHold{ResetsAt: c.stmt.ColumnFloat(c.next()), Source: c.text(), Since: c.text()}, true
	}, account)
	return h, ok, wrap("account hold", err)
}

// HoldAccount sets the account's hold, replacing any earlier one.
func (d *DB) HoldAccount(ctx context.Context, account string, h AccountHold) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "INSERT OR REPLACE INTO account_holds (account, resets_at, source, since) VALUES (?, ?, ?, ?)", account, h.ResetsAt, h.Source, h.Since)
	})
	return wrap("hold account", err)
}

// DropHold deletes the account's hold.
func (d *DB) DropHold(ctx context.Context, account string) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "DELETE FROM account_holds WHERE account = ?", account)
	})
	return wrap("drop hold", err)
}

package db

import (
	"context"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The trees' allocations (src/allocations.ts, S-2848 B5d). The table lives in its TS module rather than in src/db.ts's
// schema, made on first use; allocWrite makes it here the same way, so either daemon reads what the other wrote.

// Allocation is an allocations row: how much of an account's window (kind window, Percent) or how many paid dollars a
// period (kind usd, Amount) the tree rooted at RootID may use. Window is "" for usd, and Period "" for window.
type Allocation struct {
	ID, RootID, Account, Kind, Window string
	Percent, Amount                   *float64
	Period, SetBy, SetAt              string
	Note                              *string
}

const allocationCols = "id, root_id, account, kind, window, percent, amount, period, set_by, set_at, note"

// EnsureAllocations makes the allocations table and its one-per-scope index on a database that lacks them, as
// src/allocations.ts table() does.
func EnsureAllocations(conn *sqlite.Conn) error {
	if err := sqlitex.ExecuteTransient(conn, `CREATE TABLE IF NOT EXISTS allocations (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    account TEXT NOT NULL,
    kind TEXT NOT NULL,
    window TEXT NOT NULL DEFAULT '',
    percent REAL,
    amount REAL,
    period TEXT NOT NULL DEFAULT '',
    set_by TEXT NOT NULL,
    set_at TEXT NOT NULL,
    note TEXT
  )`, nil); err != nil {
		return err
	}
	return sqlitex.ExecuteTransient(conn, "CREATE UNIQUE INDEX IF NOT EXISTS allocations_key ON allocations(root_id, account, kind, window, period)", nil)
}

// allocWrite runs fn in a write transaction with the table made. Reads go through it too: TS makes the table before its
// first read as well.
func (d *DB) allocWrite(ctx context.Context, what string, fn func(conn *sqlite.Conn) error) error {
	return wrap(what, d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := EnsureAllocations(conn); err != nil {
			return err
		}
		return fn(conn)
	}))
}

func nullFloat(stmt *sqlite.Stmt, i int) *float64 {
	if stmt.ColumnIsNull(i) {
		return nil
	}
	v := stmt.ColumnFloat(i)
	return &v
}

func allocationsWhere(conn *sqlite.Conn, where string, args ...any) ([]Allocation, error) {
	var out []Allocation
	err := sqlitex.Execute(conn, "SELECT "+allocationCols+" FROM allocations "+where, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
		c := &cols{stmt: stmt}
		a := Allocation{ID: c.text(), RootID: c.text(), Account: c.text(), Kind: c.text(), Window: c.text()}
		a.Percent, a.Amount = nullFloat(stmt, 5), nullFloat(stmt, 6)
		c.i = 7
		a.Period, a.SetBy, a.SetAt, a.Note = c.text(), c.text(), c.text(), c.nullText()
		out = append(out, a)
		return nil
	}})
	return out, err
}

func floatArg(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

// Allocations is every allocation, oldest first, or the tree rooted at rootID's ("" for all) (allocations.ts list).
func (d *DB) Allocations(ctx context.Context, rootID string) ([]Allocation, error) {
	var out []Allocation
	err := d.allocWrite(ctx, "allocations", func(conn *sqlite.Conn) (err error) {
		if rootID != "" {
			out, err = allocationsWhere(conn, "WHERE root_id = ? ORDER BY set_at", rootID)
		} else {
			out, err = allocationsWhere(conn, "ORDER BY set_at")
		}
		return err
	})
	return out, err
}

// AllocationsOn is the allocations of one kind on an account, and for kind window on one window (allocations.ts
// checkWindow and checkUsd).
func (d *DB) AllocationsOn(ctx context.Context, kind, account, window string) ([]Allocation, error) {
	var out []Allocation
	err := d.allocWrite(ctx, "allocations on", func(conn *sqlite.Conn) (err error) {
		if kind == "window" {
			out, err = allocationsWhere(conn, "WHERE kind = 'window' AND account = ? AND window = ?", account, window)
		} else {
			out, err = allocationsWhere(conn, "WHERE kind = ? AND account = ?", kind, account)
		}
		return err
	})
	return out, err
}

// FindAllocation is the allocation with this id.
func (d *DB) FindAllocation(ctx context.Context, id string) (Allocation, bool, error) {
	var out []Allocation
	err := d.allocWrite(ctx, "find allocation", func(conn *sqlite.Conn) (err error) {
		out, err = allocationsWhere(conn, "WHERE id = ?", id)
		return err
	})
	if err != nil || len(out) == 0 {
		return Allocation{}, false, err
	}
	return out[0], true, nil
}

// SetAllocation stores a, or replaces the one with its tree, account, kind and scope (keeping that one's id, which
// a.ID names when the caller found it), and returns the stored row (allocations.ts set's upsert).
func (d *DB) SetAllocation(ctx context.Context, a Allocation) (Allocation, error) {
	var out []Allocation
	err := d.allocWrite(ctx, "set allocation", func(conn *sqlite.Conn) error {
		existing, err := allocationsWhere(conn, "WHERE root_id = ? AND account = ? AND kind = ? AND window = ? AND period = ?", a.RootID, a.Account, a.Kind, a.Window, a.Period)
		if err != nil {
			return err
		}
		if len(existing) > 0 {
			a.ID = existing[0].ID
		}
		if err := runSQL(conn, `INSERT INTO allocations (id, root_id, account, kind, window, percent, amount, period, set_by, set_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (root_id, account, kind, window, period) DO UPDATE SET percent = excluded.percent, amount = excluded.amount, set_by = excluded.set_by, set_at = excluded.set_at, note = excluded.note`,
			a.ID, a.RootID, a.Account, a.Kind, a.Window, floatArg(a.Percent), floatArg(a.Amount), a.Period, a.SetBy, a.SetAt, ptrArg(a.Note)); err != nil {
			return err
		}
		out, err = allocationsWhere(conn, "WHERE id = ?", a.ID)
		return err
	})
	if err != nil || len(out) == 0 {
		return Allocation{}, err
	}
	return out[0], nil
}

// AllocationAt is the allocation of one tree, account, kind and scope (allocations.ts overlapWarning's parent).
func (d *DB) AllocationAt(ctx context.Context, rootID, account, kind, window, period string) (Allocation, bool, error) {
	var out []Allocation
	err := d.allocWrite(ctx, "allocation at", func(conn *sqlite.Conn) (err error) {
		out, err = allocationsWhere(conn, "WHERE root_id = ? AND account = ? AND kind = ? AND window = ? AND period = ?", rootID, account, kind, window, period)
		return err
	})
	if err != nil || len(out) == 0 {
		return Allocation{}, false, err
	}
	return out[0], true, nil
}

// AllocationsOf is the allocations of these trees with one account, kind and scope (allocations.ts childrenTotal).
func (d *DB) AllocationsOf(ctx context.Context, roots []string, account, kind, window, period string) ([]Allocation, error) {
	if len(roots) == 0 {
		return nil, nil
	}
	args := make([]any, 0, len(roots)+4)
	for _, r := range roots {
		args = append(args, r)
	}
	args = append(args, account, kind, window, period)
	marks := strings.TrimSuffix(strings.Repeat("?, ", len(roots)), ", ")
	var out []Allocation
	err := d.allocWrite(ctx, "allocations of", func(conn *sqlite.Conn) (err error) {
		out, err = allocationsWhere(conn, "WHERE root_id IN ("+marks+") AND account = ? AND kind = ? AND window = ? AND period = ?", args...)
		return err
	})
	return out, err
}

// DeleteAllocation removes the allocation with this id; it returns how many rows went.
func (d *DB) DeleteAllocation(ctx context.Context, id string) (int, error) {
	n := 0
	err := d.allocWrite(ctx, "delete allocation", func(conn *sqlite.Conn) error {
		if err := runSQL(conn, "DELETE FROM allocations WHERE id = ?", id); err != nil {
			return err
		}
		n = conn.Changes()
		return nil
	})
	return n, err
}

// DeleteAllocationAt removes the allocations of one tree, account, kind and scope; it returns how many rows went.
func (d *DB) DeleteAllocationAt(ctx context.Context, rootID, account, kind, window, period string) (int, error) {
	n := 0
	err := d.allocWrite(ctx, "delete allocation", func(conn *sqlite.Conn) error {
		if err := runSQL(conn, "DELETE FROM allocations WHERE root_id = ? AND account = ? AND kind = ? AND window = ? AND period = ?", rootID, account, kind, window, period); err != nil {
			return err
		}
		n = conn.Changes()
		return nil
	})
	return n, err
}

// TreePaidSpend is the sum of column (cost_usd or paid_estimate_usd) over these agents' usage rows on an account from day
// since on (allocations.ts paidSpend's query).
func (d *DB) TreePaidSpend(ctx context.Context, members []string, account, since, column string) (float64, error) {
	if len(members) == 0 {
		return 0, nil
	}
	if column != "cost_usd" {
		column = "paid_estimate_usd"
	}
	args := []any{account, since}
	for _, m := range members {
		args = append(args, m)
	}
	marks := strings.TrimSuffix(strings.Repeat("?, ", len(members)), ", ")
	sum := 0.0
	err := d.read(ctx, "SELECT SUM("+column+") AS s FROM usage WHERE account = ? AND day >= ? AND agent_id IN ("+marks+")", func(c *cols) {
		sum = c.stmt.ColumnFloat(0)
	}, args...)
	return sum, wrap("tree paid spend", err)
}

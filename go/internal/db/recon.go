package db

import (
	"context"
	"math"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The OpenRouter ledger's reconciliation with the bill (src/reconcile.ts, S-2848 B5b): the pending reported cost, the
// decision model's exact pending cost, and the scaling, in ledger_recon's one row and the usage rows'
// unreconciled_usd. The arithmetic is TS's, step for step; lifecycle/ledgerrecon.go says what it means.

const ensureRecon = "INSERT OR IGNORE INTO ledger_recon (id) VALUES (1)"

// ReconRow is one usage row's pending reported cost (reconcile.ts Snapshot rows).
type ReconRow struct {
	AgentID, Day, Account string
	U                     float64
}

// AddExactPending is reconcile.ts addExactPending: billed money (a decision model call's cost) to take out of the next
// bill. Anything that isn't a positive amount adds nothing.
func (d *DB) AddExactPending(ctx context.Context, usd float64) error {
	if !(usd > 0) {
		return nil
	}
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, ensureRecon); err != nil {
			return err
		}
		return runSQL(conn, "UPDATE ledger_recon SET exact_pending = exact_pending + ? WHERE id = 1", usd)
	})
	return wrap("add exact pending", err)
}

// ReconSnapshot is reconcile.ts snapshot: the usage rows of these (OpenRouter) accounts with reported cost still
// pending, taken before /credits is read.
func (d *DB) ReconSnapshot(ctx context.Context, accounts []string) ([]ReconRow, error) {
	if err := d.Write(ctx, func(conn *sqlite.Conn) error { return runSQL(conn, ensureRecon) }); err != nil {
		return nil, wrap("recon snapshot", err)
	}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(accounts)), ",")
	args := make([]any, len(accounts))
	for i, a := range accounts {
		args[i] = a
	}
	var out []ReconRow
	err := d.read(ctx, "SELECT agent_id, day, account, unreconciled_usd AS u FROM usage WHERE unreconciled_usd > 0 AND account IN ("+marks+")", func(c *cols) {
		out = append(out, ReconRow{AgentID: c.stmt.ColumnText(0), Day: c.stmt.ColumnText(1), Account: c.stmt.ColumnText(2), U: c.stmt.ColumnFloat(3)})
	}, args...)
	return out, wrap("recon snapshot", err)
}

// Reconcile is reconcile.ts reconcile's transaction: the snapshot's rows scaled to the bill since the last poll
// (totalUsage, OpenRouter's total_usage), the pending amounts cleared, and the baseline moved, together or not at all.
func (d *DB) Reconcile(ctx context.Context, snap []ReconRow, totalUsage float64) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, ensureRecon); err != nil {
			return err
		}
		var billed *float64
		var carry, exact float64
		if err := sqlitex.Execute(conn, "SELECT billed_used, carry, exact_pending FROM ledger_recon WHERE id = 1", &sqlitex.ExecOptions{
			ResultFunc: func(stmt *sqlite.Stmt) error {
				if stmt.ColumnType(0) != sqlite.TypeNull {
					v := stmt.ColumnFloat(0)
					billed = &v
				}
				carry, exact = stmt.ColumnFloat(1), stmt.ColumnFloat(2)
				return nil
			}}); err != nil {
			return err
		}
		clear := func(r ReconRow) error {
			return runSQL(conn, "UPDATE usage SET unreconciled_usd = MAX(0, unreconciled_usd - ?) WHERE agent_id = ? AND day = ? AND account = ?", r.U, r.AgentID, r.Day, r.Account)
		}
		P := 0.0
		for _, r := range snap {
			P += r.U
		}
		// First poll, or a total that went down: nothing billed to compare, so only move the baseline.
		if billed == nil || totalUsage < *billed {
			for _, r := range snap {
				if err := clear(r); err != nil {
					return err
				}
			}
			return runSQL(conn, "UPDATE ledger_recon SET billed_used = ?, carry = 0, exact_pending = 0 WHERE id = 1", totalUsage)
		}
		delta := totalUsage - *billed
		avail := delta + carry
		matched := math.Min(exact, avail) // read now, after /credits: a decision's cost is billed when it returns
		B := avail - matched
		leftover := 0.0
		if P > 0 && B > 0 {
			f := math.Min(1, B/P)
			for _, r := range snap {
				if err := runSQL(conn, "UPDATE usage SET cost_usd = MAX(0, cost_usd - ? * ?) WHERE agent_id = ? AND day = ? AND account = ?", r.U, 1-f, r.AgentID, r.Day, r.Account); err != nil {
					return err
				}
				if err := clear(r); err != nil {
					return err
				}
			}
			leftover = B - P*f
		} else if P == 0 {
			leftover = math.Max(0, B)
		}
		next := math.Min(leftover, math.Max(0, delta-matched))
		return runSQL(conn, "UPDATE ledger_recon SET billed_used = ?, carry = ?, exact_pending = MAX(0, exact_pending - ?) WHERE id = 1", totalUsage, next, matched)
	})
	return wrap("reconcile", err)
}

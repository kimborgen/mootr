package db

import (
	"context"
	"strings"

	"zombiezen.com/go/sqlite"
)

// Paid spend read from the usage ledger (src/readings.ts, S-2848 B5a): the sums the budgets measure against.

// sumOrZero is `row.s ?? 0` for a SUM in column i: NULL, from no rows, is 0.
func sumOrZero(stmt *sqlite.Stmt, i int) float64 {
	if stmt.ColumnType(i) == sqlite.TypeNull {
		return 0
	}
	return stmt.ColumnFloat(i)
}

// Ledger is src/readings.ts ledger: the account's total in one of the two paid columns (cost_usd or paid_estimate_usd),
// from the first day since (YYYY-MM-DD), or over all time when since is nil.
func (d *DB) Ledger(ctx context.Context, account, column string, since *string) (float64, error) {
	if column != "cost_usd" && column != "paid_estimate_usd" {
		return 0, wrap("ledger", errBadColumn(column))
	}
	q, args := "SELECT SUM("+column+") FROM usage WHERE account = ?", []any{account}
	if since != nil {
		q, args = q+" AND day >= ?", append(args, *since)
	}
	var out float64
	err := d.read(ctx, q, func(c *cols) { out = sumOrZero(c.stmt, 0) }, args...)
	return out, wrap("ledger", err)
}

type errBadColumn string

func (e errBadColumn) Error() string { return "no paid column " + string(e) }

// ModelSpend is one model's sums on an account (src/readings.ts pricedSpend's rows): the four token counts and the cost
// the harness reported. Model is nil for rows with none.
type ModelSpend struct {
	Model                                *string
	In, Out, CacheRead, CacheWrite, Cost float64
}

// SpendByModel is pricedSpend's query: the account's sums per model from the first day since, or over all time when
// since is nil, in SQLite's GROUP BY order.
func (d *DB) SpendByModel(ctx context.Context, account string, since *string) ([]ModelSpend, error) {
	q := `SELECT model, SUM(tokens_in), SUM(tokens_out), SUM(tokens_cache_read), SUM(tokens_cache_write), SUM(cost_usd)
		FROM usage WHERE account = ?`
	args := []any{account}
	if since != nil {
		q, args = q+" AND day >= ?", append(args, *since)
	}
	var out []ModelSpend
	err := d.read(ctx, q+" GROUP BY model", func(c *cols) {
		m := ModelSpend{Model: c.nullText()}
		m.In, m.Out, m.CacheRead, m.CacheWrite, m.Cost = sumOrZero(c.stmt, 1), sumOrZero(c.stmt, 2), sumOrZero(c.stmt, 3), sumOrZero(c.stmt, 4), sumOrZero(c.stmt, 5)
		out = append(out, m)
	}, args...)
	return out, wrap("spend by model", err)
}

// PaidSpentAll is src/readings.ts paidSpentAll's query: the whole ledger from the first day since (or all time), a row
// counted by cost_usd when its account is one of billed or it was written by OpenCode on an openrouter/ model, else by
// its paid estimate; the accounts in skip are left out (the caller prices them).
func (d *DB) PaidSpentAll(ctx context.Context, billed, skip []string, since *string) (float64, error) {
	marks := func(n int) string { return strings.TrimSuffix(strings.Repeat("?,", n), ",") }
	sum := "SUM(CASE WHEN account IN (" + marks(len(billed)) + ") OR (harness = 'opencode' AND model LIKE 'openrouter/%') THEN cost_usd ELSE paid_estimate_usd END)"
	var args []any
	for _, b := range billed {
		args = append(args, b)
	}
	q := "SELECT " + sum + " FROM usage WHERE 1"
	if since != nil {
		q = "SELECT " + sum + " FROM usage WHERE day >= ?"
		args = append(args, *since)
	}
	if len(skip) > 0 {
		q += " AND account NOT IN (" + marks(len(skip)) + ")"
		for _, s := range skip {
			args = append(args, s)
		}
	}
	var out float64
	err := d.read(ctx, q, func(c *cols) { out = sumOrZero(c.stmt, 0) }, args...)
	return out, wrap("paid spent all", err)
}

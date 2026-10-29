package db

import (
	"context"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The usage tables (src/usage.ts, S-2848 A3): per-agent spend and tokens by day and by 5-minute bucket, and the
// subscription windows each harness reports, kept as the latest reading and as a row per change.

// Usage is one report's growth for an agent: the daily row's key (Day, Account), its 5-minute Bucket, and the deltas
// both rows add.
type Usage struct {
	AgentID, Day, Bucket, Harness, Account string
	// Model is the agent's model; the daily row stores NULL for none, the sample ''.
	Model                                *string
	Cost, In, Out, CacheRead, CacheWrite float64
	PaidEstimate, Unreconciled           float64
	// Baseline is the agent's new usage_last, stored with the growth so a failed write neither drops it nor counts it
	// twice.
	Baseline string
}

// RecordUsage adds u to the agent's daily row and its sample bucket and stores its baseline (src/usage.ts report and
// recordSample), in one transaction.
func (d *DB) RecordUsage(ctx context.Context, u Usage) error {
	return wrap("record usage", d.Write(ctx, func(conn *sqlite.Conn) error { return recordUsage(conn, u) }))
}

// UsageChange is what a report does to an agent, decided on its row as the write reads it: the growth recorded with
// its baseline (Record), or the baseline alone (Baseline), or nothing when both are nil.
type UsageChange struct {
	Record   *Usage
	Baseline *string
}

// RecordUsageWhile reads the agent's row in a transaction and, only while ok holds for it, makes the change plan decides
// from that row, in the same transaction: so the baseline a report grows from is the one it replaces, and no write to the
// row lands between the check and the commit. It reports whether ok held.
func (d *DB) RecordUsageWhile(ctx context.Context, agentID string, ok func(Agent) bool, plan func(Agent) UsageChange) (held bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		a, err := agentOn(conn, agentID)
		if err != nil || !ok(a) {
			return err
		}
		held = true
		c := plan(a)
		switch {
		case c.Record != nil:
			return recordUsage(conn, *c.Record)
		case c.Baseline != nil:
			return runSQL(conn, "UPDATE agents SET usage_last = ?, updated_at = ? WHERE id = ?", *c.Baseline, now(), agentID)
		}
		return nil
	})
	return held, wrap("record usage", err)
}

// recordUsage is RecordUsage's work inside a write.
func recordUsage(conn *sqlite.Conn, u Usage) error {
	model := ""
	if u.Model != nil {
		model = *u.Model
	}
	if err := runSQL(conn, "UPDATE agents SET usage_last = ?, updated_at = ? WHERE id = ?", u.Baseline, now(), u.AgentID); err != nil {
		return err
	}
	err := runSQL(conn, `INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, paid_estimate_usd, unreconciled_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd,
			tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out,
			tokens_cache_read = tokens_cache_read + excluded.tokens_cache_read, tokens_cache_write = tokens_cache_write + excluded.tokens_cache_write,
			paid_estimate_usd = paid_estimate_usd + excluded.paid_estimate_usd,
			unreconciled_usd = unreconciled_usd + excluded.unreconciled_usd, model = excluded.model`,
		u.AgentID, u.Day, u.Harness, sqlValue(u.Model), u.Account, u.Cost, u.In, u.Out, u.CacheRead, u.CacheWrite, u.PaidEstimate, u.Unreconciled)
	if err != nil {
		return err
	}
	return runSQL(conn, `INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (agent_id, bucket, account, model) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd,
			tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out,
			tokens_cache_read = tokens_cache_read + excluded.tokens_cache_read, tokens_cache_write = tokens_cache_write + excluded.tokens_cache_write,
			harness = excluded.harness`,
		u.AgentID, u.Account, u.Harness, model, u.Bucket, u.Cost, u.In, u.Out, u.CacheRead, u.CacheWrite)
}

// PruneUsage drops the samples and window readings from before since (src/usage.ts pruneSamples).
func (d *DB) PruneUsage(ctx context.Context, since string) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, "DELETE FROM usage_samples WHERE bucket < ?", since); err != nil {
			return err
		}
		return runSQL(conn, "DELETE FROM window_readings WHERE at < ?", since)
	})
	return wrap("prune usage", err)
}

// Subscription is a harness's latest subscription reading and when it was stored; ok is false when it has none.
func (d *DB) Subscription(ctx context.Context, name string) (data, updatedAt string, ok bool, err error) {
	err = d.read(ctx, "SELECT data, updated_at FROM subscriptions WHERE name = ?", func(c *cols) {
		data, updatedAt, ok = c.text(), c.text(), true
	}, name)
	return data, updatedAt, ok, wrap("subscription", err)
}

// SaveSubscription stores a harness's latest subscription reading.
func (d *DB) SaveSubscription(ctx context.Context, name, data, at string) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
			name, data, at)
	})
	return wrap("save subscription", err)
}

// RecordWindowReading adds a window_readings row when the window's percentage or reset time differs from its last row
// (src/usage.ts recordWindowReading); resets is nil when the reading has none. It reports whether it added one.
func (d *DB) RecordWindowReading(ctx context.Context, name, window string, used float64, resets *float64, at string) (bool, error) {
	added := false
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		same := false
		err := sqlitex.Execute(conn, "SELECT used_percentage, resets_at FROM window_readings WHERE name = ? AND window = ? ORDER BY at DESC LIMIT 1",
			&sqlitex.ExecOptions{Args: []any{name, window}, ResultFunc: func(stmt *sqlite.Stmt) error {
				lastUsed := stmt.ColumnType(0) != sqlite.TypeNull && stmt.ColumnFloat(0) == used
				lastResets := stmt.ColumnType(1) == sqlite.TypeNull
				if resets != nil {
					lastResets = !lastResets && stmt.ColumnFloat(1) == *resets
				}
				same = lastUsed && lastResets
				return nil
			}})
		if err != nil || same {
			return err
		}
		var r any
		if resets != nil {
			r = *resets
		}
		added = true
		return runSQL(conn, "INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)", name, window, at, used, r)
	})
	if err != nil {
		return false, wrap("record window reading", err)
	}
	return added, nil
}

// AgentCost is the agent's total spend in the usage ledger, 0 for none (src/db.ts agentCost).
func (d *DB) AgentCost(ctx context.Context, id string) (float64, error) {
	var out float64
	err := d.read(ctx, "SELECT COALESCE(SUM(cost_usd), 0) FROM usage WHERE agent_id = ?", func(c *cols) { out = c.stmt.ColumnFloat(c.next()) }, id)
	return out, wrap("agent cost", err)
}

// UnreadCount is the agent's unread mail, not counting mail it deferred (src/db.ts unreadCount).
func (d *DB) UnreadCount(ctx context.Context, id string) (int, error) {
	var out int
	err := d.read(ctx, `SELECT COUNT(*) FROM mail_recipients WHERE agent_id = ? AND read_at IS NULL AND NOT EXISTS
		(SELECT 1 FROM thread_defer_mail dm WHERE dm.mailbox_id = mail_recipients.agent_id AND dm.mail_id = mail_recipients.mail_id)`,
		func(c *cols) { out = c.int() }, id)
	return out, wrap("unread count", err)
}

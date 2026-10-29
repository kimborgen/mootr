package db

import (
	"context"
	"encoding/json"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The cost notices and their fallbacks (src/cost-notices.ts, src/cost-fallback.ts, S-2848 B4c). Both tables live in
// their TS modules rather than in src/db.ts's schema, made on first use; EnsureCostTables makes them here the same way,
// with the columns later TS releases added, so either daemon reads what the other wrote.

// CostNotice is a cost_notices row: one cost event, deduplicated by Key, and the managers (or the human) it went to.
type CostNotice struct {
	ID, Key, Kind, Account, Window string
	ResetsAt                       *int
	AgentID                        *string
	Managers                       []string
	CreatedAt                      string
	AckedAt, AckedBy, HumanMailID  *string
}

// CostFallback is a cost_fallbacks row: the fallback a blocker-set notice armed, for the blocker's generation
// (BlockerSince), due at DueAt (ms), moving pending -> claimed -> running -> done.
type CostFallback struct {
	NoticeID, AgentID, Kind, Account, BlockerSince string
	DueAt                                          int64
	State                                          string
	Attempts                                       int
	Cancel, Prior, RanAt, Result                   *string
}

// EnsureCostTables makes cost_notices and cost_fallbacks on a database that lacks them, and adds the columns added
// after them (human_mail_id, cancel), as src/cost-notices.ts and src/cost-fallback.ts table() do.
func EnsureCostTables(conn *sqlite.Conn) error {
	if err := sqlitex.ExecuteTransient(conn, `CREATE TABLE IF NOT EXISTS cost_notices (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    window TEXT NOT NULL DEFAULT '',
    resets_at INTEGER,
    agent_id TEXT,
    managers TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acked_at TEXT,
    acked_by TEXT
  )`, nil); err != nil {
		return err
	}
	if err := addColumn(conn, "cost_notices", "human_mail_id", "TEXT"); err != nil {
		return err
	}
	if err := sqlitex.ExecuteTransient(conn, `CREATE TABLE IF NOT EXISTS cost_fallbacks (
    notice_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    blocker_since TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    prior TEXT,
    ran_at TEXT,
    result TEXT
  )`, nil); err != nil {
		return err
	}
	return addColumn(conn, "cost_fallbacks", "cancel", "TEXT")
}

func addColumn(conn *sqlite.Conn, table, col, typ string) error {
	has := false
	if err := sqlitex.Execute(conn, "SELECT 1 FROM pragma_table_info('"+table+"') WHERE name = ?", &sqlitex.ExecOptions{Args: []any{col}, ResultFunc: func(*sqlite.Stmt) error { has = true; return nil }}); err != nil {
		return err
	}
	if has {
		return nil
	}
	return sqlitex.ExecuteTransient(conn, "ALTER TABLE "+table+" ADD COLUMN "+col+" "+typ, nil)
}

// costWrite runs fn in a write transaction with the cost tables made. Reads go through it too: on a database where they
// don't exist yet, TS makes them before its first read as well.
func (d *DB) costWrite(ctx context.Context, what string, fn func(conn *sqlite.Conn) error) error {
	return wrap(what, d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := EnsureCostTables(conn); err != nil {
			return err
		}
		return fn(conn)
	}))
}

const noticeCols = "id, key, kind, account, window, resets_at, agent_id, managers, created_at, acked_at, acked_by, human_mail_id"

func scanNotice(stmt *sqlite.Stmt) (CostNotice, error) {
	c := &cols{stmt: stmt}
	n := CostNotice{ID: c.text(), Key: c.text(), Kind: c.text(), Account: c.text(), Window: c.text(), ResetsAt: c.nullInt(), AgentID: c.nullText()}
	managers := c.text()
	n.CreatedAt, n.AckedAt, n.AckedBy, n.HumanMailID = c.text(), c.nullText(), c.nullText(), c.nullText()
	return n, json.Unmarshal([]byte(managers), &n.Managers)
}

func noticesWhere(conn *sqlite.Conn, where string, args ...any) ([]CostNotice, error) {
	var out []CostNotice
	err := sqlitex.Execute(conn, "SELECT "+noticeCols+" FROM cost_notices "+where, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
		n, err := scanNotice(stmt)
		out = append(out, n)
		return err
	}})
	return out, err
}

func intArg(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

// AddCostNotice stores the notice unless one with its key exists; added is false for a duplicate.
func (d *DB) AddCostNotice(ctx context.Context, n CostNotice) (added bool, err error) {
	managers, err := json.Marshal(n.Managers)
	if err != nil {
		return false, err
	}
	err = d.costWrite(ctx, "add cost notice", func(conn *sqlite.Conn) error {
		dup, err := noticesWhere(conn, "WHERE key = ?", n.Key)
		if err != nil || len(dup) > 0 {
			return err
		}
		added = true
		return runSQL(conn, "INSERT INTO cost_notices (id, key, kind, account, window, resets_at, agent_id, managers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			n.ID, n.Key, n.Kind, n.Account, n.Window, intArg(n.ResetsAt), ptrArg(n.AgentID), string(managers), n.CreatedAt)
	})
	return added, err
}

// CostNoticeByID is one stored notice; ok is false when there is none.
func (d *DB) CostNoticeByID(ctx context.Context, id string) (n CostNotice, ok bool, err error) {
	err = d.costWrite(ctx, "cost notice", func(conn *sqlite.Conn) error {
		rows, err := noticesWhere(conn, "WHERE id = ?", id)
		if len(rows) > 0 {
			n, ok = rows[0], true
		}
		return err
	})
	return n, ok, err
}

// AckCostNotice records that by handled the notice, at at, in one step with the check that it is unacknowledged. It
// returns the notice as it was before; ok is false when there is none, and an acknowledged one is returned unchanged.
func (d *DB) AckCostNotice(ctx context.Context, id, by, at string) (before CostNotice, ok bool, err error) {
	err = d.costWrite(ctx, "ack cost notice", func(conn *sqlite.Conn) error {
		rows, err := noticesWhere(conn, "WHERE id = ?", id)
		if err != nil || len(rows) == 0 {
			return err
		}
		before, ok = rows[0], true
		if before.AckedAt != nil {
			return nil
		}
		return runSQL(conn, "UPDATE cost_notices SET acked_at = ?, acked_by = ? WHERE id = ?", at, by, id)
	})
	return before, ok, err
}

// OpenCostNotices is every notice no one acknowledged, oldest first (src/cost-notices.ts openNotices before its filter).
func (d *DB) OpenCostNotices(ctx context.Context) ([]CostNotice, error) {
	var out []CostNotice
	err := d.costWrite(ctx, "open cost notices", func(conn *sqlite.Conn) (err error) {
		out, err = noticesWhere(conn, "WHERE acked_at IS NULL ORDER BY created_at")
		return err
	})
	return out, err
}

// SetNoticeHumanMail records the human's mail that carried the notice, and returns the notice after it.
func (d *DB) SetNoticeHumanMail(ctx context.Context, id, mailID string) (n CostNotice, err error) {
	err = d.costWrite(ctx, "notice human mail", func(conn *sqlite.Conn) error {
		if err := runSQL(conn, "UPDATE cost_notices SET human_mail_id = ? WHERE id = ?", mailID, id); err != nil {
			return err
		}
		rows, err := noticesWhere(conn, "WHERE id = ?", id)
		if len(rows) > 0 {
			n = rows[0]
		}
		return err
	})
	return n, err
}

// WindowNames is the distinct windows window_readings holds for the subscriptions name, in the table's order.
func (d *DB) WindowNames(ctx context.Context, name string) ([]string, error) {
	var out []string
	err := d.read(ctx, "SELECT DISTINCT window FROM window_readings WHERE name = ?", func(c *cols) { out = append(out, c.text()) }, name)
	return out, wrap("window names", err)
}

const fallbackCols = "notice_id, agent_id, kind, account, blocker_since, due_at, state, attempts, cancel, prior, ran_at, result"

func fallbacksWhere(conn *sqlite.Conn, where string, args ...any) ([]CostFallback, error) {
	var out []CostFallback
	err := sqlitex.Execute(conn, "SELECT "+fallbackCols+" FROM cost_fallbacks "+where, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
		c := &cols{stmt: stmt}
		out = append(out, CostFallback{NoticeID: c.text(), AgentID: c.text(), Kind: c.text(), Account: c.text(), BlockerSince: c.text(), DueAt: c.int64(),
			State: c.text(), Attempts: c.int(), Cancel: c.nullText(), Prior: c.nullText(), RanAt: c.nullText(), Result: c.nullText()})
		return nil
	}})
	return out, err
}

// ArmFallback stores a pending fallback, unless its notice has one already.
func (d *DB) ArmFallback(ctx context.Context, f CostFallback) error {
	return d.costWrite(ctx, "arm fallback", func(conn *sqlite.Conn) error {
		return runSQL(conn, "INSERT OR IGNORE INTO cost_fallbacks (notice_id, agent_id, kind, account, blocker_since, due_at) VALUES (?, ?, ?, ?, ?, ?)",
			f.NoticeID, f.AgentID, f.Kind, f.Account, f.BlockerSince, f.DueAt)
	})
}

// RetireFallbacks ends the agent's pending fallbacks for this blocker: it cleared.
func (d *DB) RetireFallbacks(ctx context.Context, agentID, kind, account string) error {
	return d.costWrite(ctx, "retire fallbacks", func(conn *sqlite.Conn) error {
		return runSQL(conn, "UPDATE cost_fallbacks SET state = 'done', result = 'skipped: the blocker cleared' WHERE agent_id = ? AND kind = ? AND account = ? AND state = 'pending'",
			agentID, kind, account)
	})
}

// CancelFallbacks is src/cost-fallback.ts cancelPending: an explicit shut-down ends the agent's fallbacks. A pending row
// is done now; a claimed or running one gets why, which its run reads before it acts.
func (d *DB) CancelFallbacks(ctx context.Context, agentID, why string) error {
	return d.costWrite(ctx, "cancel fallbacks", func(conn *sqlite.Conn) error {
		if err := runSQL(conn, "UPDATE cost_fallbacks SET state = 'done', result = ? WHERE agent_id = ? AND state = 'pending'", "skipped: "+why, agentID); err != nil {
			return err
		}
		return runSQL(conn, "UPDATE cost_fallbacks SET cancel = ? WHERE agent_id = ? AND state IN ('claimed', 'running')", why, agentID)
	})
}

// Fallback is one fallback row; ok is false when there is none.
func (d *DB) Fallback(ctx context.Context, noticeID string) (f CostFallback, ok bool, err error) {
	err = d.costWrite(ctx, "fallback", func(conn *sqlite.Conn) error {
		rows, err := fallbacksWhere(conn, "WHERE notice_id = ?", noticeID)
		if len(rows) > 0 {
			f, ok = rows[0], true
		}
		return err
	})
	return f, ok, err
}

// DueFallbacks is every pending fallback due by now (ms), soonest first.
func (d *DB) DueFallbacks(ctx context.Context, now int64) ([]CostFallback, error) {
	var out []CostFallback
	err := d.costWrite(ctx, "due fallbacks", func(conn *sqlite.Conn) (err error) {
		out, err = fallbacksWhere(conn, "WHERE state = 'pending' AND due_at <= ? ORDER BY due_at", now)
		return err
	})
	return out, err
}

// NextFallbackDue is when the soonest pending fallback is due (ms); ok is false when none is pending.
func (d *DB) NextFallbackDue(ctx context.Context) (due int64, ok bool, err error) {
	err = d.costWrite(ctx, "next fallback", func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT MIN(due_at) FROM cost_fallbacks WHERE state = 'pending'", &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
			if !stmt.ColumnIsNull(0) {
				due, ok = stmt.ColumnInt64(0), true
			}
			return nil
		}})
	})
	return due, ok, err
}

// ClaimFallback is src/cost-fallback.ts run's claim: a pending row becomes claimed, unless its agent is archived or has
// an archive or shut-down pending, checked in the same statement. A pending row the claim refused is done here; one
// another run claimed is left as it is. claimed says whether this call has it.
func (d *DB) ClaimFallback(ctx context.Context, noticeID, ranAt string) (claimed bool, err error) {
	err = d.costWrite(ctx, "claim fallback", func(conn *sqlite.Conn) error {
		if err := runSQL(conn, `UPDATE cost_fallbacks SET state = 'claimed', ran_at = ? WHERE notice_id = ? AND state = 'pending'
    AND agent_id NOT IN (SELECT id FROM agents WHERE lifecycle = 'archived' OR json_extract(pending_action, '$.type') IN ('archive', 'shutdown'))`, ranAt, noticeID); err != nil {
			return err
		}
		if conn.Changes() == 1 {
			claimed = true
			return nil
		}
		return runSQL(conn, "UPDATE cost_fallbacks SET state = 'done', result = ? WHERE notice_id = ? AND state = 'pending'",
			"skipped: the agent is archived, or its archive or shut-down is pending", noticeID)
	})
	return claimed, err
}

// RunFallback marks a claimed row running, with what its cancel and recovery compare against (prior). ok is false when
// the row is no longer claimed (a recovery put it back to pending), so the caller must not act on it.
func (d *DB) RunFallback(ctx context.Context, noticeID, prior string) (ok bool, err error) {
	err = d.costWrite(ctx, "run fallback", func(conn *sqlite.Conn) error {
		if err := runSQL(conn, "UPDATE cost_fallbacks SET state = 'running', prior = ? WHERE notice_id = ? AND state = 'claimed'", prior, noticeID); err != nil {
			return err
		}
		ok = conn.Changes() == 1
		return nil
	})
	return ok, err
}

// FinishFallback marks the row done with its result.
func (d *DB) FinishFallback(ctx context.Context, noticeID, result string) error {
	return d.costWrite(ctx, "finish fallback", func(conn *sqlite.Conn) error {
		return runSQL(conn, "UPDATE cost_fallbacks SET state = 'done', result = ? WHERE notice_id = ?", result, noticeID)
	})
}

// RecoverFallbacks is the first step of src/cost-fallback.ts recover: a claimed row did nothing yet, so it is pending
// again. It returns the running rows, which the caller reconciles.
func (d *DB) RecoverFallbacks(ctx context.Context) ([]CostFallback, error) {
	var out []CostFallback
	err := d.costWrite(ctx, "recover fallbacks", func(conn *sqlite.Conn) (err error) {
		if err := runSQL(conn, "UPDATE cost_fallbacks SET state = 'pending', ran_at = NULL WHERE state = 'claimed'"); err != nil {
			return err
		}
		out, err = fallbacksWhere(conn, "WHERE state = 'running'")
		return err
	})
	return out, err
}

// RetryFallback puts an interrupted running row back to pending, counting the attempt.
func (d *DB) RetryFallback(ctx context.Context, noticeID string) error {
	return d.costWrite(ctx, "retry fallback", func(conn *sqlite.Conn) error {
		return runSQL(conn, "UPDATE cost_fallbacks SET state = 'pending', attempts = attempts + 1, prior = NULL, ran_at = NULL WHERE notice_id = ?", noticeID)
	})
}

// DropTakenOver deletes the agent's taken-over blocker, as recover undoes an interrupted take-over.
func (d *DB) DropTakenOver(ctx context.Context, agentID string) error {
	return wrap("drop taken-over", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "DELETE FROM blockers WHERE agent_id = ? AND kind = 'taken-over'", agentID)
	}))
}

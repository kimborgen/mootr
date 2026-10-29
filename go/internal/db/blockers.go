package db

import (
	"context"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// Blocker is one row of the blockers table (src/blockers.ts Blocker): why stam keeps an agent paused, with what clears
// it. Clear is the stored JSON text, nil when none.
type Blocker struct {
	AgentID string
	Kind    string
	Account string
	Reason  string
	Since   string
	Clear   *string
}

// WindowClears is the windows a blocker change cleared, recorded in window_clears in the same transaction (src/db.ts
// recordWindowClears): at is in ms.
type WindowClears struct {
	Names []string
	At    int64
}

const blockerCols = "agent_id, kind, account, reason, since, clear"

func scanBlocker(c *cols) Blocker {
	return Blocker{AgentID: c.text(), Kind: c.text(), Account: c.text(), Reason: c.text(), Since: c.text(), Clear: c.nullText()}
}

func blockersOn(conn *sqlite.Conn, where string, args ...any) ([]Blocker, error) {
	var out []Blocker
	err := sqlitex.Execute(conn, "SELECT "+blockerCols+" FROM blockers "+where+" ORDER BY since, rowid", &sqlitex.ExecOptions{Args: args,
		ResultFunc: func(stmt *sqlite.Stmt) error {
			out = append(out, scanBlocker(&cols{stmt: stmt}))
			return nil
		}})
	return out, err
}

// BlockerRows is src/db.ts blockerRows: the agent's blockers, oldest first.
func (d *DB) BlockerRows(ctx context.Context, id string) ([]Blocker, error) {
	var out []Blocker
	err := d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		out, err = blockersOn(conn, "WHERE agent_id = ?", id)
		return err
	})
	return out, wrap("blocker rows", err)
}

// BlockersByAgent is src/blockers.ts blockersByAgent: every agent's blockers, as BlockerRows gives them, in one query.
func (d *DB) BlockersByAgent(ctx context.Context) (map[string][]Blocker, error) {
	out := map[string][]Blocker{}
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		all, err := blockersOn(conn, "")
		for _, b := range all {
			out[b.AgentID] = append(out[b.AgentID], b)
		}
		return err
	})
	return out, wrap("blockers by agent", err)
}

func recordWindowClears(conn *sqlite.Conn, account string, c *WindowClears) error {
	if c == nil {
		return nil
	}
	for _, name := range c.Names {
		if err := runSQL(conn, "INSERT OR REPLACE INTO window_clears (account, window, at) VALUES (?, ?, ?)", account, name, c.At); err != nil {
			return err
		}
	}
	return nil
}

// PutBlocker is the write of src/blockers.ts addBlocker: it adds the blocker, or refreshes the reason and clear
// condition of the agent's blocker of that kind and account while keeping its since, and records the windows it
// cleared, in one transaction. It returns the row as stored and whether it existed before.
func (d *DB) PutBlocker(ctx context.Context, b Blocker, clears *WindowClears) (out Blocker, existed bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		before, err := blockersOn(conn, "WHERE agent_id = ? AND kind = ? AND account = ?", b.AgentID, b.Kind, b.Account)
		if err != nil {
			return err
		}
		existed = len(before) > 0
		if err := runSQL(conn, `INSERT INTO blockers (agent_id, kind, account, reason, since, clear) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (agent_id, kind, account) DO UPDATE SET reason = excluded.reason, clear = excluded.clear`,
			b.AgentID, b.Kind, b.Account, b.Reason, now(), ptrArg(b.Clear)); err != nil {
			return err
		}
		if err := recordWindowClears(conn, b.Account, clears); err != nil {
			return err
		}
		after, err := blockersOn(conn, "WHERE agent_id = ? AND kind = ? AND account = ?", b.AgentID, b.Kind, b.Account)
		if err == nil && len(after) == 1 {
			out = after[0]
		}
		return err
	})
	return out, existed, wrap("put blocker", err)
}

// DropBlocker is the write of src/blockers.ts clearBlocker: it deletes the agent's blocker of that kind and account
// and records the windows it cleared, in one transaction. gone is the deleted row, nil when there was none (and then
// nothing is written); left is how many blockers the agent still has.
func (d *DB) DropBlocker(ctx context.Context, id, kind, account string, clears *WindowClears) (gone *Blocker, left int, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		rows, err := blockersOn(conn, "WHERE agent_id = ? AND kind = ? AND account = ?", id, kind, account)
		if err != nil || len(rows) == 0 {
			return err
		}
		gone = &rows[0]
		if err := runSQL(conn, "DELETE FROM blockers WHERE agent_id = ? AND kind = ? AND account = ?", id, kind, account); err != nil {
			return err
		}
		if err := recordWindowClears(conn, account, clears); err != nil {
			return err
		}
		rest, err := blockersOn(conn, "WHERE agent_id = ?", id)
		left = len(rest)
		return err
	})
	if err != nil {
		gone = nil
	}
	return gone, left, wrap("drop blocker", err)
}

// BlockerAccounts is the accounts any blocker of the kind is on (`SELECT DISTINCT account FROM blockers WHERE kind = ?`).
func (d *DB) BlockerAccounts(ctx context.Context, kind string) ([]string, error) {
	var out []string
	err := d.read(ctx, "SELECT DISTINCT account FROM blockers WHERE kind = ?", func(c *cols) { out = append(out, c.text()) }, kind)
	return out, wrap("blocker accounts", err)
}

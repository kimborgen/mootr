package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The waits table's reads and writes (src/db.ts addWait, clearWait, clearWaits, dueWaits, setWaitUntil,
// src/adapters/hook-waits.ts, S-2848 B2a). Every write that adds, removes or changes a
// wait syncs the agent's activity with its waits in the same transaction (syncWaits).

// Wait is one row of the waits table, in its column order, as the routes send it.
type Wait struct {
	ID      string  `json:"id"`
	AgentID string  `json:"agent_id"`
	Kind    string  `json:"kind"`
	Target  *string `json:"target"`
	Detail  *string `json:"detail"`
	Since   string  `json:"since"`
	Until   *string `json:"until"`
	// Source is 'stam' (stam saw it), 'hook' (a harness reported it) or 'declared' (the agent said so).
	Source string  `json:"source"`
	Data   *string `json:"data"`
}

// NewWait is a wait to add; the id and since are the database's.
type NewWait struct {
	AgentID, Kind, Source       string
	Target, Detail, Until, Data *string
}

// HookWait is one wait a harness reports itself (src/adapters/hook-waits.ts HookWait): background work or a timer still
// open when its turn ends, keyed by target. Data is its JSON text, nil for none.
type HookWait struct {
	Target, Detail string
	Until, Data    *string
}

const waitColumns = "id, agent_id, kind, target, detail, since, until, source, data"

func scanWait(stmt *sqlite.Stmt) Wait {
	c := &cols{stmt: stmt}
	return Wait{ID: c.text(), AgentID: c.text(), Kind: c.text(), Target: c.nullText(), Detail: c.nullText(), Since: c.text(),
		Until: c.nullText(), Source: c.text(), Data: c.nullText()}
}

func queryWaits(conn *sqlite.Conn, where string, args ...any) ([]Wait, error) {
	var out []Wait
	err := sqlitex.Execute(conn, "SELECT "+waitColumns+" FROM waits "+where, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
		out = append(out, scanWait(stmt))
		return nil
	}})
	return out, err
}

// byRank sorts waits as src/db.ts listWaits does: by kind's rank, keeping since order within one.
func byRank(ws []Wait) {
	sort.SliceStable(ws, func(i, j int) bool { return rankOf(ws[i].Kind) < rankOf(ws[j].Kind) })
}

// ListWaits is the agent's waits, ranked (src/db.ts listWaits).
func (d *DB) ListWaits(ctx context.Context, agentID string) (out []Wait, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) error {
		out, err = queryWaits(conn, "WHERE agent_id = ? ORDER BY since, rowid", agentID)
		return err
	})
	byRank(out)
	return out, wrap("list waits", err)
}

// WaitsByAgent is every agent's waits, each ranked, in one query (src/db.ts listWaitsByAgent).
func (d *DB) WaitsByAgent(ctx context.Context) (map[string][]Wait, error) {
	var all []Wait
	err := d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		all, err = queryWaits(conn, "ORDER BY since, rowid")
		return err
	})
	out := map[string][]Wait{}
	for _, w := range all {
		out[w.AgentID] = append(out[w.AgentID], w)
	}
	for _, ws := range out {
		byRank(ws)
	}
	return out, wrap("waits by agent", err)
}

// GetWait is one wait by id, or ErrNotFound.
func (d *DB) GetWait(ctx context.Context, id string) (Wait, error) {
	var ws []Wait
	err := d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		ws, err = queryWaits(conn, "WHERE id = ?", id)
		return err
	})
	if err == nil && len(ws) == 0 {
		err = ErrNotFound
	}
	if err != nil {
		return Wait{}, wrap("get wait", err)
	}
	return ws[0], nil
}

// DueWaits is the waits whose until has passed that stam fires: a declared wait's timeout and stam's own timers. Hook
// waits are the harness's own; stam tracks them but never fires them (src/db.ts dueWaits).
func (d *DB) DueWaits(ctx context.Context, nowISO string) (out []Wait, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) error {
		out, err = queryWaits(conn, "WHERE until IS NOT NULL AND until <= ? AND (source = 'declared' OR (source = 'stam' AND kind = 'timer')) ORDER BY until, rowid", nowISO)
		return err
	})
	return out, wrap("due waits", err)
}

func newWaitID() string {
	b := make([]byte, 5)
	rand.Read(b)
	return "w" + hex.EncodeToString(b)
}

func (d *DB) addWait(conn *sqlite.Conn, w NewWait) (Wait, error) {
	id := newWaitID()
	if err := runSQL(conn, "INSERT INTO waits ("+waitColumns+") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id, w.AgentID, w.Kind, sqlValue(w.Target), sqlValue(w.Detail), now(), sqlValue(w.Until), w.Source, sqlValue(w.Data)); err != nil {
		return Wait{}, err
	}
	if err := d.syncWaits(conn, w.AgentID); err != nil {
		return Wait{}, err
	}
	ws, err := queryWaits(conn, "WHERE id = ?", id)
	if err != nil || len(ws) == 0 {
		return Wait{}, fmt.Errorf("the new wait %s is gone: %w", id, err)
	}
	return ws[0], nil
}

// AddWait adds a wait and syncs the agent's activity with it (src/db.ts addWait).
func (d *DB) AddWait(ctx context.Context, w NewWait) (out Wait, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) (err error) {
		out, err = d.addWait(conn, w)
		return err
	})
	return out, wrap("add wait", err)
}

// AddWaitWith adds a wait as AddWait does, after more writes in the same transaction: fn runs first, and an error from
// it writes nothing (an event recorded with the wait, a nudge claimed with it).
func (d *DB) AddWaitWith(ctx context.Context, w NewWait, fn func(tx WaitTx, added Wait) error) (out Wait, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) (err error) {
		if out, err = d.addWait(conn, w); err != nil {
			return err
		}
		return fn(WaitTx{conn: conn}, out)
	})
	return out, wrap("add wait", err)
}

// WaitTx is the writes that go with a wait's in its transaction.
type WaitTx struct{ conn *sqlite.Conn }

// AddEvent records an event (as DB.AddEvent) in the wait's transaction.
func (tx WaitTx) AddEvent(agentID, typ string, data any) error {
	return insertEvent(tx.conn, agentID, typ, data)
}

// ClaimNudge claims the nudge for a key (src/db.ts claimNudge): true when this is the first claim, false when it was
// already sent. The primary key is the check.
func (tx WaitTx) ClaimNudge(target, waiter, thread, mail string) (bool, error) {
	if err := runSQL(tx.conn, "INSERT OR IGNORE INTO wait_nudges (target_id, waiter_id, thread_id, mail_id) VALUES (?, ?, ?, ?)", target, waiter, thread, mail); err != nil {
		return false, err
	}
	return tx.conn.Changes() == 1, nil
}

func (d *DB) clearWait(conn *sqlite.Conn, id string) (bool, error) {
	ws, err := queryWaits(conn, "WHERE id = ?", id)
	if err != nil || len(ws) == 0 {
		return false, err
	}
	if err := runSQL(conn, "DELETE FROM waits WHERE id = ?", id); err != nil {
		return false, err
	}
	return true, d.syncWaits(conn, ws[0].AgentID)
}

// ClearWait clears one wait by id and syncs its agent; false when there was none (src/db.ts clearWait).
func (d *DB) ClearWait(ctx context.Context, id string) (cleared bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) (err error) {
		cleared, err = d.clearWait(conn, id)
		return err
	})
	return cleared, wrap("clear wait", err)
}

// ClearAgentWait clears the agent's wait with this id, and only when its source is one of sources (any when none are
// given); false when the agent has no such wait. Read and cleared in one transaction, so the check holds for the clear.
func (d *DB) ClearAgentWait(ctx context.Context, agentID, id string, sources ...string) (cleared bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		ws, err := queryWaits(conn, "WHERE id = ? AND agent_id = ?", id, agentID)
		if err != nil || len(ws) == 0 {
			return err
		}
		ok := len(sources) == 0
		for _, s := range sources {
			ok = ok || ws[0].Source == s
		}
		if !ok {
			return nil
		}
		cleared, err = d.clearWait(conn, id)
		return err
	})
	return cleared, wrap("clear wait", err)
}

// ClearWaits clears the agent's waits of one kind on one target (nil matches waits with none) and returns how many
// (src/db.ts clearWaits).
func (d *DB) ClearWaits(ctx context.Context, agentID, kind string, target *string) (n int, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, "DELETE FROM waits WHERE agent_id = ? AND kind = ? AND target IS ?", agentID, kind, sqlValue(target)); err != nil {
			return err
		}
		if n = conn.Changes(); n > 0 {
			return d.syncWaits(conn, agentID)
		}
		return nil
	})
	return n, wrap("clear waits", err)
}

// FireWait is the scheduler's write for a due wait, in one transaction with its event: a wait with a next fire time
// moves to it, one without is cleared. A wait gone or no longer due by then (cleared, or moved, since it was read) is
// left alone: fired is false, and the caller sends nothing.
func (d *DB) FireWait(ctx context.Context, w Wait, next *string, event string, data any) (fired bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		ws, err := queryWaits(conn, "WHERE id = ? AND until IS ?", w.ID, sqlValue(w.Until))
		if err != nil || len(ws) == 0 {
			return err
		}
		if next != nil {
			err = runSQL(conn, "UPDATE waits SET until = ? WHERE id = ?", *next, w.ID)
		} else {
			_, err = d.clearWait(conn, w.ID)
		}
		if err != nil {
			return err
		}
		fired = true
		return insertEvent(conn, w.AgentID, event, data)
	})
	return fired, wrap("fire wait", err)
}

// ReplaceHookWaits makes the agent's hook waits of one kind exactly want, keyed by target: a kept wait keeps its since
// (src/adapters/hook-waits.ts replaceHookWaits), in one transaction.
func (d *DB) ReplaceHookWaits(ctx context.Context, agentID, kind string, want []HookWait) error {
	return wrap("replace hook waits", d.Write(ctx, func(conn *sqlite.Conn) error {
		have, err := queryWaits(conn, "WHERE agent_id = ? AND source = 'hook' AND kind = ? ORDER BY since, rowid", agentID, kind)
		if err != nil {
			return err
		}
		wanted, had := map[string]bool{}, map[string]bool{}
		for _, x := range want {
			wanted[x.Target] = true
		}
		for _, w := range have {
			had[deref(w.Target)] = true
			if w.Target == nil || !wanted[*w.Target] {
				if _, err := d.clearWait(conn, w.ID); err != nil {
					return err
				}
			}
		}
		for _, x := range want {
			// Only the waits it had are kept: two of want with one target are both added, as in TS.
			if had[x.Target] {
				continue
			}
			target, detail := x.Target, x.Detail
			if _, err := d.addWait(conn, NewWait{AgentID: agentID, Kind: kind, Source: "hook", Target: &target, Detail: &detail, Until: x.Until, Data: x.Data}); err != nil {
				return err
			}
		}
		return nil
	}))
}

// ClearHookWaits clears every hook wait of the agent (src/adapters/hook-waits.ts clearHookWaits).
func (d *DB) ClearHookWaits(ctx context.Context, agentID string) error {
	return wrap("clear hook waits", d.Write(ctx, func(conn *sqlite.Conn) error {
		ws, err := queryWaits(conn, "WHERE agent_id = ? AND source = 'hook'", agentID)
		if err != nil {
			return err
		}
		for _, w := range ws {
			if _, err := d.clearWait(conn, w.ID); err != nil {
				return err
			}
		}
		return nil
	}))
}

// MailThreadIDs is the thread of each mail id given that has one (src/db.ts mailThreadIds).
func (d *DB) MailThreadIDs(ctx context.Context, ids []string) (map[string]string, error) {
	out := map[string]string{}
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		for _, id := range ids {
			if err := sqlitex.Execute(conn, "SELECT thread_id FROM mail WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error {
				if t := stmt.ColumnText(0); t != "" {
					out[id] = t
				}
				return nil
			}}); err != nil {
				return err
			}
		}
		return nil
	})
	return out, wrap("mail threads", err)
}

// MailBetween is a mail's id and row order, as src/db.ts latestMailBetween returns them.
type MailBetween struct {
	ID  string
	Seq int64
}

// LatestMailBetween is the newest mail from sent to to, in thread when not "", else in any thread (src/db.ts
// latestMailBetween): a mail counts with a recipient row for to; with copies, a sender's copy listing to (or 'all') in
// copy_to counts too, and one from before copy_to with no recipient rows counts for anyone. nil for none.
func (d *DB) LatestMailBetween(ctx context.Context, from, to, thread string, copies bool) (*MailBetween, error) {
	var out *MailBetween
	var th any
	if thread != "" {
		th = thread
	}
	c := 0
	if copies {
		c = 1
	}
	err := d.read(ctx, `SELECT m.id, m.rowid AS seq FROM mail m
    WHERE m.from_id = ? AND (? IS NULL OR m.thread_id = ?)
      AND (EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?)
        OR (? = 1 AND (
          (m.copy_to IS NULL AND NOT EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id))
          OR EXISTS (SELECT 1 FROM json_each(m.copy_to) WHERE value IN (?, 'all')))))
    ORDER BY m.rowid DESC LIMIT 1`, func(c *cols) { out = &MailBetween{ID: c.text(), Seq: c.int64()} }, from, th, th, to, c, to)
	return out, wrap("latest mail between", err)
}

// RequestState is a permission request as a wait on the human reads it (src/db.ts RequestState).
type RequestState struct {
	ID, Status, Audience, CreatedAt string
	DecidedAt                       *string
}

// AgentRequests is the agent's permission requests, newest first (src/db.ts agentRequests).
func (d *DB) AgentRequests(ctx context.Context, agentID string) ([]RequestState, error) {
	var out []RequestState
	err := d.read(ctx, "SELECT id, status, audience, created_at, decided_at FROM permission_requests WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC",
		func(c *cols) {
			out = append(out, RequestState{ID: c.text(), Status: c.text(), Audience: c.text(), CreatedAt: c.text(), DecidedAt: c.nullText()})
		}, agentID)
	return out, wrap("agent requests", err)
}

// RequestOfThread is the permission request a thread's oldest request mail carries, "" for none (src/db.ts
// requestOfThread).
func (d *DB) RequestOfThread(ctx context.Context, threadID string) (string, error) {
	out := ""
	err := d.read(ctx, "SELECT permission_id FROM mail WHERE (id = ? OR thread_id = ?) AND permission_id IS NOT NULL ORDER BY created_at LIMIT 1",
		func(c *cols) { out = c.text() }, threadID, threadID)
	return out, wrap("request of thread", err)
}

// insertEvent is AddEvent inside a write.
func insertEvent(conn *sqlite.Conn, agentID, typ string, data any) error {
	var arg any
	if data != nil {
		s, err := stringify(data)
		if err != nil {
			return fmt.Errorf("event %s data: %w", typ, err)
		}
		arg = s
	}
	return runSQL(conn, "INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, ?)", agentID, now(), typ, arg)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

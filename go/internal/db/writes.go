package db

import (
	"context"
	"crypto/rand"
	"fmt"
	"sort"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The agent writes spawn, the hooks and the lifecycle make (S-2820), as src/db.ts makes them. Of the observers TS runs
// on an activity or lifecycle change, only the live stream's is ported (ObserveAgents); parents' waits and tree-idle
// notices aren't yet.

// SessionEnded is the activity detail of an agent whose harness ended its session (src/db.ts SESSION_ENDED).
const SessionEnded = "session ended"

// Field is one column an update sets; a nil Val stores NULL, as TS's null and undefined do.
type Field struct {
	Col string
	Val any
}

// updatable is the columns UpdateAgent may set: the names go into the statement, so only these pass.
var updatable = map[string]bool{
	"lifecycle": true, "activity": true, "activity_detail": true, "session_id": true, "transcript_path": true,
	"last_message": true, "context_tokens": true, "context_window": true, "workspace": true, "personal_workspace": true,
	"standing": true, "capabilities": true, "permission_mode": true, "permission_source": true, "visibility": true,
	"child_notices": true, "kind": true, "type": true, "first_prompt": true, "pending_action": true, "paused_by": true,
	"idle_since": true, "idle_notified": true, "context_level": true, "tokens_after_compaction": true, "usage_last": true,
}

// UpdateAgent sets fields on the agent and its updated_at, in one transaction (src/db.ts updateAgent). As in TS, an
// activity of idle becomes waiting when the agent has open waits, with the first wait as its detail, and an activity
// change sets idle_since (when it goes idle or waiting and has none) or clears it (any other activity), unless the
// update sets idle_since itself.
func (d *DB) UpdateAgent(ctx context.Context, id string, fields ...Field) error {
	for _, f := range fields {
		if !updatable[f.Col] {
			return fmt.Errorf("db: update agent: column %q isn't updatable", f.Col)
		}
	}
	err := d.Write(ctx, func(conn *sqlite.Conn) error { return d.updateAgent(conn, id, fields) })
	if err != nil {
		return fmt.Errorf("db: update agent %s: %w", id, err)
	}
	return nil
}

// updateAgent is UpdateAgent's work inside a write.
func (d *DB) updateAgent(conn *sqlite.Conn, id string, fields []Field) error {
	fs := append([]Field(nil), fields...)
	// The values before, read as TS reads them: only for a lifecycle or activity the update sets (truthy).
	lifecycle, _ := fieldValue(fs, "lifecycle")
	requested, _ := fieldValue(fs, "activity")
	var beforeLife, beforeActivity *string
	for _, b := range []struct {
		set  any
		col  string
		into **string
	}{{lifecycle, "lifecycle", &beforeLife}, {requested, "activity", &beforeActivity}} {
		if s, _ := b.set.(string); s != "" {
			r, err := rows(conn, "SELECT "+b.col+" FROM agents WHERE id = ?", id)
			if err != nil {
				return err
			}
			if len(r) > 0 {
				v := r[0].Text(b.col)
				*b.into = &v
			}
		}
	}
	activity, hasActivity := fieldValue(fs, "activity")
	if hasActivity && activity == "idle" {
		waits, err := rows(conn, "SELECT * FROM waits WHERE agent_id = ? ORDER BY since, rowid", id)
		if err != nil {
			return err
		}
		if len(waits) > 0 {
			sort.SliceStable(waits, func(i, j int) bool { return rankOf(waits[i].Text("kind")) < rankOf(waits[j].Text("kind")) })
			summary := waitSummary(conn, waits)
			fs = setField(setField(fs, "activity", "waiting"), "activity_detail", summary)
			activity = "waiting"
		}
	}
	if _, ok := fieldValue(fs, "idle_since"); hasActivity && activity != nil && !ok {
		if activity == "idle" || activity == "waiting" {
			var cur *string
			err := sqlitex.Execute(conn, "SELECT idle_since FROM agents WHERE id = ?", &sqlitex.ExecOptions{
				Args:       []any{id},
				ResultFunc: func(stmt *sqlite.Stmt) error { cur = (&cols{stmt: stmt}).nullText(); return nil },
			})
			if err != nil {
				return err
			}
			if cur == nil || *cur == "" {
				fs = append(fs, Field{"idle_since", now()})
			}
		} else {
			fs = append(fs, Field{"idle_since", nil})
		}
	}
	if len(fs) == 0 {
		return nil
	}
	sets := make([]string, len(fs))
	args := make([]any, 0, len(fs)+2)
	for i, f := range fs {
		sets[i] = f.Col + " = ?"
		args = append(args, sqlValue(f.Val))
	}
	args = append(args, now(), id)
	if err := sqlitex.Execute(conn, "UPDATE agents SET "+strings.Join(sets, ", ")+", updated_at = ? WHERE id = ?", &sqlitex.ExecOptions{Args: args}); err != nil {
		return err
	}
	lifeChanged := beforeLife != nil && any(*beforeLife) != lifecycle
	activityChanged := beforeActivity != nil && any(*beforeActivity) != activity
	if lifeChanged || activityChanged {
		d.noteChanged(id, lifeChanged && lifecycle == "archived")
	}
	if lifeChanged {
		c := ActivityChange{Kind: "lifecycle", ID: id, Before: *beforeLife}
		c.After, _ = lifecycle.(string)
		if err := d.noteActivityRow(conn, c); err != nil {
			return err
		}
	}
	if activityChanged {
		c := ActivityChange{Kind: "activity", ID: id, Before: *beforeActivity}
		c.After, _ = activity.(string)
		c.Requested, _ = requested.(string)
		if v, ok := fieldValue(fields, "activity_detail"); ok {
			if s, isStr := v.(string); isStr {
				c.RequestedDetail = &s
			}
		}
		return d.noteActivityRow(conn, c)
	}
	return nil
}

// sqlValue turns typed nil pointers into NULL and dereferences the rest, so a *string field stores its value.
func sqlValue(v any) any {
	switch x := v.(type) {
	case *string:
		if x == nil {
			return nil
		}
		return *x
	case *int:
		if x == nil {
			return nil
		}
		return *x
	}
	return v
}

func fieldValue(fs []Field, col string) (any, bool) {
	for _, f := range fs {
		if f.Col == col {
			return sqlValue(f.Val), true
		}
	}
	return nil, false
}

// setField replaces col's value where the update has it, keeping its place, else appends it (an object spread).
func setField(fs []Field, col string, v any) []Field {
	for i := range fs {
		if fs[i].Col == col {
			fs[i].Val = v
			return fs
		}
	}
	return append(fs, Field{col, v})
}

// TakePendingAction clears the agent's pending_action if it still is want, and reports whether it did: a compare and
// clear, so of two callers that read the same pending action only one runs it.
func (d *DB) TakePendingAction(ctx context.Context, id, want string) (bool, error) {
	taken := false
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		err := sqlitex.Execute(conn, "UPDATE agents SET pending_action = NULL, updated_at = ? WHERE id = ? AND pending_action = ?",
			&sqlitex.ExecOptions{Args: []any{now(), id, want}})
		taken = conn.Changes() > 0
		return err
	})
	if err != nil {
		return false, fmt.Errorf("db: take pending action of %s: %w", id, err)
	}
	return taken, nil
}

// ClaimIdle sets the agent working with detail, and clears its idle_since, only if it is still idle, waiting or
// errored in the idle period idleSince names (nil for none), and reports whether it did: a compare and set, so a turn
// that started since the caller read the row is never taken over.
func (d *DB) ClaimIdle(ctx context.Context, id string, idleSince *string, detail string) (bool, error) {
	claimed := false
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		before, err := rows(conn, "SELECT activity FROM agents WHERE id = ?", id)
		if err != nil || len(before) == 0 {
			return err
		}
		err = sqlitex.Execute(conn, `UPDATE agents SET activity = 'working', activity_detail = ?, idle_since = NULL, updated_at = ?
			WHERE id = ? AND activity IN ('idle', 'waiting', 'errored') AND idle_since IS ?`,
			&sqlitex.ExecOptions{Args: []any{detail, now(), id, sqlValue(idleSince)}})
		claimed = conn.Changes() > 0
		if claimed {
			d.noteChanged(id, false)
			if err != nil {
				return err
			}
			return d.noteActivityRow(conn, ActivityChange{Kind: "activity", ID: id, Before: before[0].Text("activity"), After: "working", Requested: "working", RequestedDetail: &detail})
		}
		return err
	})
	if err != nil {
		return false, fmt.Errorf("db: claim idle %s: %w", id, err)
	}
	return claimed, nil
}

// NewAgentID is src/db.ts newAgentId: "a" and four characters of an alphabet without look-alikes, unused here and by
// any agent remembered from a peer.
func (d *DB) NewAgentID(ctx context.Context) (string, error) {
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"
	for {
		b := make([]byte, 4)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		id := []byte{'a'}
		for _, x := range b {
			id = append(id, alphabet[int(x)%len(alphabet)])
		}
		taken := false
		err := d.Read(ctx, func(conn *sqlite.Conn) error {
			return sqlitex.Execute(conn, "SELECT 1 FROM agents WHERE id = ?1 UNION ALL SELECT 1 FROM peer_agents WHERE id = ?1", &sqlitex.ExecOptions{
				Args:       []any{string(id)},
				ResultFunc: func(*sqlite.Stmt) error { taken = true; return nil },
			})
		})
		if err != nil {
			return "", fmt.Errorf("db: new agent id: %w", err)
		}
		if !taken {
			return string(id), nil
		}
	}
}

// SetTokenHash stores the sha256 of the agent's new launch token (src/db.ts setTokenHash).
func (d *DB) SetTokenHash(ctx context.Context, id, hash string) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "UPDATE agents SET token_hash = ? WHERE id = ?", &sqlitex.ExecOptions{Args: []any{hash, id}})
	})
	if err != nil {
		return fmt.Errorf("db: token hash of %s: %w", id, err)
	}
	return nil
}

// HasPendingDialog is whether a harness dialog stam saw on the agent's screen waits for an answer (src/db.ts
// pendingDialog).
func (d *DB) HasPendingDialog(ctx context.Context, id string) (bool, error) {
	found := false
	err := d.read(ctx, "SELECT 1 FROM permission_requests WHERE agent_id = ? AND status = 'pending' AND dialog = 1 LIMIT 1", func(*cols) { found = true }, id)
	return found, wrap("pending dialog", err)
}

// ForgetAgent removes the agent and what is its alone (src/db.ts forgetAgent): its events, mailbox rows, blockers,
// waits, view, workspace grants and the agent row; its pending permission requests are withdrawn.
func (d *DB) ForgetAgent(ctx context.Context, id string) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		for _, q := range []string{
			"DELETE FROM events WHERE agent_id = ?",
			"DELETE FROM mail_recipients WHERE agent_id = ?",
			"DELETE FROM mail_deliveries WHERE agent_id = ?",
			"DELETE FROM blockers WHERE agent_id = ?",
			"DELETE FROM waits WHERE agent_id = ?",
			"DELETE FROM agent_views WHERE agent_id = ?",
			"DELETE FROM workspace_grants WHERE grantee_id = ?",
		} {
			if err := sqlitex.Execute(conn, q, &sqlitex.ExecOptions{Args: []any{id}}); err != nil {
				return err
			}
		}
		if err := sqlitex.Execute(conn, "UPDATE permission_requests SET status = 'withdrawn', decided_at = ? WHERE agent_id = ? AND status = 'pending'",
			&sqlitex.ExecOptions{Args: []any{now(), id}}); err != nil {
			return err
		}
		return sqlitex.Execute(conn, "DELETE FROM agents WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id}})
	})
	if err != nil {
		return fmt.Errorf("db: forget %s: %w", id, err)
	}
	return nil
}

// ItsaTies is what ties the agent to ITSAs on this daemon: an unown still waiting for the ITSA home
// (itsa_pending_unown), and whether it owns or takes part in an ITSA here (src/itsa-owners.ts ownedBy, participatedBy).
func (d *DB) ItsaTies(ctx context.Context, id string) (pendingUnown, tied bool, err error) {
	err = d.read(ctx, "SELECT 1 FROM itsa_pending_unown WHERE agent_id = ? LIMIT 1", func(*cols) { pendingUnown = true }, id)
	if err == nil {
		err = d.read(ctx, "SELECT 1 FROM itsas WHERE owner = ?1 UNION ALL SELECT 1 FROM itsa_participants WHERE agent_id = ?1 AND left_at IS NULL LIMIT 1", func(*cols) { tied = true }, id)
	}
	return pendingUnown, tied, wrap("itsa ties", err)
}

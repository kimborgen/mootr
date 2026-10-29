package db

import (
	"context"

	"zombiezen.com/go/sqlite"
)

// The rows of the Needs you list (src/asks.ts, S-3831), verbatim from TS: each read gives the rows as objects of their columns.

// PermissionAsks is src/asks.ts permissionAsks' read: the human's permission requests (a delegate's ask is the human's once
// escalated), open while pending or held, settled when decided (or, with no decision time, created) at or after since. An
// empty since reads the open ones only (src/asks.ts openAsks).
func (d *DB) PermissionAsks(ctx context.Context, since string) ([]Row, error) {
	if since == "" {
		return d.askRows(ctx, "permission asks", `SELECT p.id, p.kind, p.status, p.agent_id, p.home_thread, p.home_itsa, p.created_at, p.decided_at
    FROM permission_requests p
    WHERE p.audience = 'human' AND p.status IN ('pending', 'held')`)
	}
	return d.askRows(ctx, "permission asks", `SELECT p.id, p.kind, p.status, p.agent_id, p.home_thread, p.home_itsa, p.created_at, p.decided_at
    FROM permission_requests p
    WHERE p.audience = 'human' AND (p.status IN ('pending', 'held') OR COALESCE(p.decided_at, p.created_at) >= ?)`, since)
}

// HumanWaitTargets is src/asks.ts openAskLinks' read of the waits on the human that name an ITSA or other target, oldest first.
func (d *DB) HumanWaitTargets(ctx context.Context) ([]Row, error) {
	return d.askRows(ctx, "human waits", "SELECT agent_id, target FROM waits WHERE kind = 'human' AND target IS NOT NULL ORDER BY since, rowid")
}

// ItsaStatusMoves is src/asks.ts itsaAsks' read of the status changes at or after since, with their ITSA's title and owner.
func (d *DB) ItsaStatusMoves(ctx context.Context, since string) ([]Row, error) {
	return d.askRows(ctx, "ITSA status moves", `SELECT e.id, e.ts, e.data, e.itsa_id, i.title, i.owner
    FROM itsa_events e JOIN itsas i ON i.id = e.itsa_id
    WHERE e.type = 'status' AND e.ts >= ? ORDER BY e.id`, since)
}

// NextItsaAct is the ITSA's first action or status event after the event id: what decides how a move out of a human status
// settled. Nil when there is none.
func (d *DB) NextItsaAct(ctx context.Context, itsaID string, after int64) (Row, error) {
	found, err := d.askRows(ctx, "next ITSA event", "SELECT type, data FROM itsa_events WHERE itsa_id = ? AND id > ? AND type IN ('action', 'status') ORDER BY id LIMIT 1", itsaID, after)
	if err != nil || len(found) == 0 {
		return nil, err
	}
	return found[0], nil
}

// SettledDecisions is src/asks.ts decisionAsks' read of the decision mails answered, superseded or withdrawn at or after since,
// with the mail they were (a copy of a settlement can outlive its mail, so the mail's columns may be null).
func (d *DB) SettledDecisions(ctx context.Context, since string) ([]Row, error) {
	return d.askRows(ctx, "settled decisions", `SELECT c.id, c.ref, c.outcome, c.label, c.created_at, m.subject, m.from_id, m.from_name, m.thread_id, m.about_itsa, m.created_at AS asked_at
    FROM comms_events c LEFT JOIN mail m ON m.id = c.ref
    WHERE c.kind = 'decision' AND c.outcome IN ('answered', 'superseded', 'withdrawn') AND c.created_at >= ? ORDER BY c.id`, since)
}

// Row is one row by column name: a string, an int64, or nil for NULL.
type Row map[string]any

// Text is the column as text, "" for NULL.
func (r Row) Text(col string) string {
	s, _ := r[col].(string)
	return s
}

// Nullable is the column as a string, or nil for NULL.
func (r Row) Nullable(col string) any {
	if s, ok := r[col].(string); ok {
		return s
	}
	return nil
}

func (d *DB) askRows(ctx context.Context, what, query string, args ...any) ([]Row, error) {
	var out []Row
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return runSQLRows(conn, query, func(stmt *sqlite.Stmt) {
			row := Row{}
			for i := 0; i < stmt.ColumnCount(); i++ {
				switch stmt.ColumnType(i) {
				case sqlite.TypeNull:
					row[stmt.ColumnName(i)] = nil
				case sqlite.TypeInteger:
					row[stmt.ColumnName(i)] = stmt.ColumnInt64(i)
				default:
					row[stmt.ColumnName(i)] = stmt.ColumnText(i)
				}
			}
			out = append(out, row)
		}, args...)
	})
	return out, wrap(what, err)
}

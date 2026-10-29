package db

import (
	"context"

	"zombiezen.com/go/sqlite"
)

// PendingUnown is a row of itsa_pending_unown: an unown of an archived or forgotten agent's ITSAs that the ITSA home has
// not yet acknowledged (src/itsa-owners.ts queueUnown). CreatedAt identifies the request.
type PendingUnown struct {
	AgentID, Name, How string
	Type               *string
	CreatedAt          string
}

// QueueUnown is src/itsa-owners.ts queueUnown: records, before anything is sent, that the home must unown this agent's
// ITSAs. A row that already exists stays, so its created_at keeps identifying the request.
func (d *DB) QueueUnown(ctx context.Context, agentID, name, how string, typ *string) error {
	var t any
	if typ != nil {
		t = *typ
	}
	return wrap("queue unown", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "INSERT OR IGNORE INTO itsa_pending_unown (agent_id, name, how, type, created_at) VALUES (?, ?, ?, ?, ?)", agentID, name, how, t, now())
	}))
}

// PendingUnowns lists the pending unowns, one agent's when agentID is set.
func (d *DB) PendingUnowns(ctx context.Context, agentID string) ([]PendingUnown, error) {
	query, args := "SELECT agent_id, name, how, type, created_at FROM itsa_pending_unown ORDER BY created_at, agent_id", []any{}
	if agentID != "" {
		query, args = "SELECT agent_id, name, how, type, created_at FROM itsa_pending_unown WHERE agent_id = ?", []any{agentID}
	}
	var out []PendingUnown
	err := d.read(ctx, query, func(c *cols) {
		out = append(out, PendingUnown{AgentID: c.text(), Name: c.text(), How: c.text(), Type: c.nullText(), CreatedAt: c.text()})
	}, args...)
	return out, wrap("pending unowns", err)
}

// DonePendingUnown deletes the row a send read, by its created_at, so a retry and a new request can't remove each other's.
func (d *DB) DonePendingUnown(ctx context.Context, agentID, createdAt string) error {
	return wrap("done pending unown", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "DELETE FROM itsa_pending_unown WHERE agent_id = ? AND created_at = ?", agentID, createdAt)
	}))
}

// DropPendingUnown is src/itsa-owners.ts dropPendingUnown: the agent is running again, or a forget was refused and left
// it here, so there is nothing to unown.
func (d *DB) DropPendingUnown(ctx context.Context, agentID string) error {
	return wrap("drop pending unown", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "DELETE FROM itsa_pending_unown WHERE agent_id = ?", agentID)
	}))
}

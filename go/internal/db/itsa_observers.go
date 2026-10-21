package db

import (
	"context"
	"encoding/json"

	"zombiezen.com/go/sqlite"
)

// What the observers of an ITSA change in src/ read (S-2849): the daemon checks them before a write it cannot finish, and
// answers 501 for the ones it does not carry.

// Inspect runs fn with the reads of an ITSA change, on a read connection.
func (d *DB) Inspect(ctx context.Context, fn func(ItsaTx) error) error {
	var refused error
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		refused = fn(ItsaTx{conn})
		return nil
	})
	if refused != nil {
		return refused
	}
	return wrap("inspect ITSA", err)
}

// StepOn is whether an enabled decision step has the event trigger (src/steps.ts emit): `itsa-created` or `itsa-status`.
func (t ItsaTx) StepOn(event string) (bool, error) {
	has, err := rows(t.conn, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decision_steps'")
	if err != nil || len(has) == 0 {
		return false, err
	}
	triggers, err := column(t.conn, "SELECT trigger FROM decision_steps WHERE enabled = 1")
	if err != nil {
		return false, err
	}
	for _, raw := range triggers {
		var tr struct{ Kind, Event string }
		if json.Unmarshal([]byte(raw), &tr) == nil && tr.Kind == "event" && tr.Event == event {
			return true, nil
		}
	}
	return false, nil
}

// AgentState is the lifecycle and pause owners of the agent a ref (id or name) names here.
func (t ItsaTx) AgentState(ref string) (lifecycle, pausedBy string, found bool, err error) {
	found2, err := rows(t.conn, "SELECT lifecycle, paused_by FROM agents WHERE id = ? OR name = ?", ref, ref)
	if err != nil || len(found2) == 0 {
		return "", "", false, err
	}
	return found2[0].Text("lifecycle"), found2[0].Text("paused_by"), true, nil
}

// PeerAgentKnown is whether an agent remembered from a peer has this id or name.
func (t ItsaTx) PeerAgentKnown(ref string) (bool, error) {
	found, err := rows(t.conn, "SELECT 1 FROM peer_agents WHERE id = ? OR name = ?", ref, ref)
	return len(found) > 0, err
}

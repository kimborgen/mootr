package db

import "context"

// The reads behind src/retro-digest.ts gather (S-161): the final rounds, the archives and their skipped rounds, and the
// agents active in a period.

// AgentEvent is one event's agent and data (nil when NULL).
type AgentEvent struct {
	AgentID string
	Data    *string
}

// EventsSince is every event of one type at or after since (an ISO time), in the order they were added.
func (d *DB) EventsSince(ctx context.Context, typ, since string) ([]AgentEvent, error) {
	var out []AgentEvent
	err := d.read(ctx, "SELECT agent_id, data FROM events WHERE type = ? AND ts >= ? ORDER BY id", func(c *cols) {
		out = append(out, AgentEvent{AgentID: c.text(), Data: c.nullText()})
	}, typ, since)
	return out, wrap("events since", err)
}

// FirstEventTime is the time of the earliest event of one type; nil when there is none.
func (d *DB) FirstEventTime(ctx context.Context, typ string) (*string, error) {
	return d.readText(ctx, "SELECT ts FROM events WHERE type = ? ORDER BY ts LIMIT 1", typ)
}

// EventAgents is the agents with an event of one type, at or after since when it is given (nil: ever).
func (d *DB) EventAgents(ctx context.Context, typ string, since *string) ([]string, error) {
	q, args := "SELECT DISTINCT agent_id FROM events WHERE type = ?", []any{typ}
	if since != nil {
		q, args = q+" AND ts >= ?", append(args, *since)
	}
	var out []string
	err := d.read(ctx, q, func(c *cols) { out = append(out, c.text()) }, args...)
	return out, wrap("event agents", err)
}

// LastEventData is the data of the agent's latest event of one type; false when it has none.
func (d *DB) LastEventData(ctx context.Context, agentID, typ string) (*string, bool, error) {
	var out *string
	found := false
	err := d.read(ctx, "SELECT data FROM events WHERE agent_id = ? AND type = ? ORDER BY id DESC LIMIT 1", func(c *cols) {
		out, found = c.nullText(), true
	}, agentID, typ)
	return out, found, wrap("last event", err)
}

// ActivityAgentsSince is the agents with an activity item that ended after since.
func (d *DB) ActivityAgentsSince(ctx context.Context, since string) ([]string, error) {
	var out []string
	err := d.read(ctx, `SELECT DISTINCT agent_id FROM activity_items WHERE "end" > ?`, func(c *cols) { out = append(out, c.text()) }, since)
	return out, wrap("activity agents", err)
}

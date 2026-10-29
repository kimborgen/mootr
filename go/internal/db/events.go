package db

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// Event is one events row: what happened to an agent, with its data as the JSON text the TS daemon stores and sends
// (GET /api/agents/:id/events), or nil. Decode reads the data into a struct of the event type's shape.
type Event struct {
	ID      int64   `json:"id"`
	AgentID string  `json:"-"`
	TS      string  `json:"ts"`
	Type    string  `json:"type"`
	Data    *string `json:"data"`
}

var eventColumns = []string{"id", "agent_id", "ts", "type", "data"}

// Decode unmarshals the event's data into v; a nil Data leaves v as it is.
func (e Event) Decode(v any) error {
	if e.Data == nil {
		return nil
	}
	if err := json.Unmarshal([]byte(*e.Data), v); err != nil {
		return fmt.Errorf("db: event %d data: %w", e.ID, err)
	}
	return nil
}

// AddEvent records an event for the agent (src/db.ts addEvent). data is stored as JSON. A nil data stores NULL, as
// TS's undefined does; to store the JSON text "null", as TS does for null, pass json.RawMessage("null").
func (d *DB) AddEvent(ctx context.Context, agentID, typ string, data any) error {
	var arg any
	if data != nil {
		s, err := stringify(data)
		if err != nil {
			return fmt.Errorf("db: event %s data: %w", typ, err)
		}
		arg = s
	}
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, ?)", &sqlitex.ExecOptions{
			Args: []any{agentID, now(), typ, arg},
		})
	})
	if err != nil {
		return fmt.Errorf("db: add event %s: %w", typ, err)
	}
	return nil
}

// AddEventWhile is AddEvent only while ok holds for the agent's row, read in the same transaction; it reports whether it
// recorded.
func (d *DB) AddEventWhile(ctx context.Context, agentID, typ string, data any, ok func(Agent) bool) (bool, error) {
	var arg any
	if data != nil {
		s, err := stringify(data)
		if err != nil {
			return false, fmt.Errorf("db: event %s data: %w", typ, err)
		}
		arg = s
	}
	done := false
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		a, err := agentOn(conn, agentID)
		if err != nil || !ok(a) {
			return err
		}
		done = true
		return sqlitex.Execute(conn, "INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, ?)", &sqlitex.ExecOptions{
			Args: []any{agentID, now(), typ, arg},
		})
	})
	if err != nil {
		return false, fmt.Errorf("db: add event %s: %w", typ, err)
	}
	return done, nil
}

// stringify writes JSON as JSON.stringify does: no HTML escaping of <, > and &, and no trailing newline.
func stringify(v any) (string, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimSuffix(b.String(), "\n"), nil
}

// DefaultEventLimit is ListEvents' limit when the caller gives none, as in src/db.ts listEvents.
const DefaultEventLimit = 50

// ListEvents is the agent's latest limit events (DefaultEventLimit when limit <= 0), oldest first (src/db.ts
// listEvents). A non-empty typeGlob (such as "input:*") keeps only events of matching types, however old.
func (d *DB) ListEvents(ctx context.Context, agentID string, limit int, typeGlob string) ([]Event, error) {
	if limit <= 0 {
		limit = DefaultEventLimit
	}
	q := "SELECT " + strings.Join(eventColumns, ", ") + " FROM events WHERE agent_id = ?"
	args := []any{agentID}
	if typeGlob != "" {
		q += " AND type GLOB ?"
		args = append(args, typeGlob)
	}
	q += " ORDER BY id DESC LIMIT ?"
	args = append(args, limit)
	var out []Event
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, q, &sqlitex.ExecOptions{
			Args: args,
			ResultFunc: func(stmt *sqlite.Stmt) error {
				c := cols{stmt: stmt}
				out = append(out, Event{ID: c.int64(), AgentID: c.text(), TS: c.text(), Type: c.text(), Data: c.nullText()})
				return nil
			},
		})
	})
	if err != nil {
		return nil, fmt.Errorf("db: events: %w", err)
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

// readText runs a query that returns at most one text value: the value, or nil when no row matched.
func (d *DB) readText(ctx context.Context, q string, args ...any) (*string, error) {
	var out *string
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, q, &sqlitex.ExecOptions{
			Args: args,
			ResultFunc: func(stmt *sqlite.Stmt) error {
				s := stmt.ColumnText(0)
				out = &s
				return nil
			},
		})
	})
	if err != nil {
		return nil, fmt.Errorf("db: events: %w", err)
	}
	return out, nil
}

// LastHookAt is when the agent's harness last reported through a hook, or nil.
func (d *DB) LastHookAt(ctx context.Context, agentID string) (*string, error) {
	return d.readText(ctx, "SELECT ts FROM events WHERE agent_id = ? AND type LIKE 'hook:%' ORDER BY id DESC LIMIT 1", agentID)
}

// LastEventAt is when the agent's latest event of any of types was recorded, or nil.
func (d *DB) LastEventAt(ctx context.Context, agentID string, types []string) (*string, error) {
	if len(types) == 0 {
		return nil, nil
	}
	args := []any{agentID}
	for _, t := range types {
		args = append(args, t)
	}
	marks := strings.TrimSuffix(strings.Repeat("?, ", len(types)), ", ")
	return d.readText(ctx, "SELECT ts FROM events WHERE agent_id = ? AND type IN ("+marks+") ORDER BY id DESC LIMIT 1", args...)
}

// LatestEvent is the agent's latest event of any of types, or nil.
func (d *DB) LatestEvent(ctx context.Context, agentID string, types []string) (*Event, error) {
	if len(types) == 0 {
		return nil, nil
	}
	args := []any{agentID}
	for _, t := range types {
		args = append(args, t)
	}
	marks := strings.TrimSuffix(strings.Repeat("?, ", len(types)), ", ")
	var out *Event
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT "+strings.Join(eventColumns, ", ")+" FROM events WHERE agent_id = ? AND type IN ("+marks+") ORDER BY id DESC LIMIT 1", &sqlitex.ExecOptions{
			Args: args,
			ResultFunc: func(stmt *sqlite.Stmt) error {
				c := cols{stmt: stmt}
				out = &Event{ID: c.int64(), AgentID: c.text(), TS: c.text(), Type: c.text(), Data: c.nullText()}
				return nil
			},
		})
	})
	if err != nil {
		return nil, fmt.Errorf("db: events: %w", err)
	}
	return out, nil
}

// AvgMeasuredTokens is the average post-compaction size measured (compaction:measured, over 0) since since, an ISO
// time; nil when none was (src/context.ts avgAfterCompaction).
func (d *DB) AvgMeasuredTokens(ctx context.Context, since string) (*float64, error) {
	var out *float64
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, `SELECT AVG(json_extract(data, '$.tokens')) FROM events WHERE type = 'compaction:measured'
			AND json_extract(data, '$.tokens') > 0 AND ts > ?`, &sqlitex.ExecOptions{
			Args: []any{since},
			ResultFunc: func(stmt *sqlite.Stmt) error {
				if stmt.ColumnType(0) != sqlite.TypeNull {
					v := stmt.ColumnFloat(0)
					out = &v
				}
				return nil
			},
		})
	})
	if err != nil {
		return nil, fmt.Errorf("db: measured tokens: %w", err)
	}
	return out, nil
}

// HasEvent reports whether the agent has an event of this type.
func (d *DB) HasEvent(ctx context.Context, agentID, typ string) (bool, error) {
	s, err := d.readText(ctx, "SELECT 1 FROM events WHERE agent_id = ? AND type = ? LIMIT 1", agentID, typ)
	return s != nil, err
}

// HasEventSinceStart reports whether the event was recorded since the harness last started (a spawn or resume event).
func (d *DB) HasEventSinceStart(ctx context.Context, agentID, typ string) (bool, error) {
	s, err := d.readText(ctx, `SELECT 1 FROM events WHERE agent_id = ? AND type = ?
		AND id > COALESCE((SELECT MAX(id) FROM events WHERE agent_id = ? AND type IN ('spawn', 'resume')), 0) LIMIT 1`, agentID, typ, agentID)
	return s != nil, err
}

// EventTimes is the times of the agent's events of one type since since (an ISO time), oldest first.
func (d *DB) EventTimes(ctx context.Context, agentID, typ, since string) ([]string, error) {
	var out []string
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT ts FROM events WHERE agent_id = ? AND type = ? AND ts >= ? ORDER BY id", &sqlitex.ExecOptions{
			Args: []any{agentID, typ, since},
			ResultFunc: func(stmt *sqlite.Stmt) error {
				out = append(out, stmt.ColumnText(0))
				return nil
			},
		})
	})
	if err != nil {
		return nil, fmt.Errorf("db: event times: %w", err)
	}
	return out, nil
}

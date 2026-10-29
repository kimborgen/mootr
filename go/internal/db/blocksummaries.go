package db

import (
	"context"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// BlockSummary is src/db.ts getBlockSummary: the stored summary of a block's text by its sha256 hex, and the hash of
// the model and prompt it was asked with (nil for a row from before that column). ErrNotFound when there is none.
func (d *DB) BlockSummary(ctx context.Context, hash string) (summary string, configHash *string, err error) {
	found := false
	err = d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT summary, config_hash FROM block_summaries WHERE hash = ?", &sqlitex.ExecOptions{Args: []any{hash},
			ResultFunc: func(stmt *sqlite.Stmt) error {
				c := cols{stmt: stmt}
				summary, configHash, found = c.text(), c.nullText(), true
				return nil
			}})
	})
	if err == nil && !found {
		err = ErrNotFound
	}
	return summary, configHash, wrap("block summary", err)
}

// SetBlockSummary is src/db.ts setBlockSummary: a block's summary, the model that wrote it, and the hash of the model and
// prompt it was asked with, replacing any stored one.
func (d *DB) SetBlockSummary(ctx context.Context, hash, summary, model, configHash string) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "INSERT OR REPLACE INTO block_summaries (hash, summary, model, created_at, config_hash) VALUES (?, ?, ?, ?, ?)",
			&sqlitex.ExecOptions{Args: []any{hash, summary, model, now(), configHash}})
	})
	return wrap("set block summary", err)
}

// ToolSummary is a tool call's stored summary (src/tool-summaries.ts): the tool in plain English and what the agent is
// doing, and the hash of the model and prompt it was asked with (nil for a row from before that column).
type ToolSummary struct {
	Tool, Doing string
	ConfigHash  *string
}

// ToolSummary is src/db.ts getToolSummary: the summary stored for this call's name and input (hash). ErrNotFound when
// there is none.
func (d *DB) ToolSummary(ctx context.Context, agentID, callID, hash string) (ToolSummary, error) {
	var s ToolSummary
	found := false
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT tool, doing, config_hash FROM tool_summaries WHERE agent_id = ? AND call_id = ? AND input_hash = ?",
			&sqlitex.ExecOptions{Args: []any{agentID, callID, hash}, ResultFunc: func(stmt *sqlite.Stmt) error {
				c := cols{stmt: stmt}
				s, found = ToolSummary{Tool: c.text(), Doing: c.text(), ConfigHash: c.nullText()}, true
				return nil
			}})
	})
	if err == nil && !found {
		err = ErrNotFound
	}
	return s, wrap("tool summary", err)
}

// SetToolSummary is src/db.ts setToolSummary: a call's summary, replacing a stored one asked with another model or prompt.
func (d *DB) SetToolSummary(ctx context.Context, agentID, callID, hash, tool, doing, model, configHash string) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, `INSERT INTO tool_summaries (agent_id, call_id, input_hash, tool, doing, model, created_at, config_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?) `+
			`ON CONFLICT (agent_id, call_id, input_hash) DO UPDATE SET tool = excluded.tool, doing = excluded.doing, model = excluded.model, created_at = excluded.created_at, config_hash = excluded.config_hash `+
			`WHERE tool_summaries.config_hash IS NOT excluded.config_hash`,
			&sqlitex.ExecOptions{Args: []any{agentID, callID, hash, tool, doing, model, now(), configHash}})
	})
	return wrap("set tool summary", err)
}

// ToolName is src/db.ts getToolName: a tool's stored label for the harness, "" when none is stored.
func (d *DB) ToolName(ctx context.Context, harness, name string) (string, error) {
	var label string
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT label FROM tool_names WHERE harness = ? AND name = ?", &sqlitex.ExecOptions{Args: []any{harness, name},
			ResultFunc: func(stmt *sqlite.Stmt) error {
				label = stmt.ColumnText(0)
				return nil
			}})
	})
	return label, wrap("tool name", err)
}

// SetToolName is src/db.ts setToolName: a tool's label, stored once; a label already stored stays as it is.
func (d *DB) SetToolName(ctx context.Context, harness, name, label, model string) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "INSERT OR IGNORE INTO tool_names (harness, name, label, model, created_at) VALUES (?, ?, ?, ?, ?)",
			&sqlitex.ExecOptions{Args: []any{harness, name, label, model, now()}})
	})
	return wrap("set tool name", err)
}

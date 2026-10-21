package db

import (
	"context"
	"fmt"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The grouped reads GET /api/agents makes once per list (src/db.ts), each one query for every agent.

// SearchAgents is the agents whose id is q, or whose name or role contains it, oldest first (src/db.ts searchAgents).
func (d *DB) SearchAgents(ctx context.Context, q string) ([]Agent, error) {
	like := "%" + q + "%"
	return d.queryAgents(ctx, "WHERE id = ? OR name LIKE ? OR role LIKE ? ORDER BY created_at", q, like, like)
}

// ExtraParents is each child's parents from agent_parents, by child id, in parent id order (src/db.ts parentsByChild
// adds parent_id first).
func (d *DB) ExtraParents(ctx context.Context) (map[string][]string, error) {
	out := map[string][]string{}
	err := d.read(ctx, "SELECT child_id, parent_id FROM agent_parents ORDER BY child_id, parent_id", func(c *cols) {
		child := c.text()
		out[child] = append(out[child], c.text())
	})
	return out, wrap("agent parents", err)
}

// UnreadCounts is each mailbox's unread mail, not counting mail it deferred (src/db.ts unreadCounts).
func (d *DB) UnreadCounts(ctx context.Context) (map[string]int, error) {
	out := map[string]int{}
	err := d.read(ctx, `SELECT agent_id, COUNT(*) FROM mail_recipients WHERE read_at IS NULL AND NOT EXISTS
		(SELECT 1 FROM thread_defer_mail dm WHERE dm.mailbox_id = mail_recipients.agent_id AND dm.mail_id = mail_recipients.mail_id)
		GROUP BY agent_id`, func(c *cols) { out[c.text()] = c.int() })
	return out, wrap("unread counts", err)
}

// CostByAgent is each agent's total spend in the usage ledger (src/db.ts costByAgent).
func (d *DB) CostByAgent(ctx context.Context) (map[string]float64, error) {
	out := map[string]float64{}
	err := d.read(ctx, "SELECT agent_id, SUM(cost_usd) FROM usage GROUP BY agent_id", func(c *cols) {
		id := c.text()
		out[id] = c.stmt.ColumnFloat(c.next())
	})
	return out, wrap("cost by agent", err)
}

// PendingHumanRequests is each agent's pending permission requests that wait on the human (src/db.ts
// pendingRequestCounts).
func (d *DB) PendingHumanRequests(ctx context.Context) (map[string]int, error) {
	out := map[string]int{}
	err := d.read(ctx, "SELECT agent_id, COUNT(*) FROM permission_requests WHERE status = 'pending' AND audience = 'human' GROUP BY agent_id",
		func(c *cols) { out[c.text()] = c.int() })
	return out, wrap("pending requests", err)
}

// AgentViews is the human's default view of each agent that has one (src/db.ts agentViews).
func (d *DB) AgentViews(ctx context.Context) (map[string]string, error) {
	out := map[string]string{}
	err := d.read(ctx, "SELECT agent_id, view FROM agent_views", func(c *cols) { out[c.text()] = c.text() })
	return out, wrap("agent views", err)
}

// read runs a query with args on a reader and hands each row to row.
func (d *DB) read(ctx context.Context, query string, row func(c *cols), args ...any) error {
	return d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
			row(&cols{stmt: stmt})
			return nil
		}})
	})
}

func wrap(what string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("db: %s: %w", what, err)
}

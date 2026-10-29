package db

import (
	"context"

	"zombiezen.com/go/sqlite"
)

// WorkspaceGrant is one workspace_grants row (src/workspace-share.ts, S-896): a folder shared with an agent.
type WorkspaceGrant struct {
	Workspace, GranteeID, Access, GrantedBy string
}

// GrantsTo is the folders shared with an agent, by path (src/workspace-share.ts grantsFor's query).
func (d *DB) GrantsTo(ctx context.Context, granteeID string) ([]WorkspaceGrant, error) {
	var out []WorkspaceGrant
	err := d.read(ctx, "SELECT workspace, access, granted_by FROM workspace_grants WHERE grantee_id = ? ORDER BY workspace", func(c *cols) {
		out = append(out, WorkspaceGrant{Workspace: c.text(), GranteeID: granteeID, Access: c.text(), GrantedBy: c.text()})
	}, granteeID)
	return out, wrap("workspace grants", err)
}

// GrantsOf is who a folder is shared with, by grantee id (src/workspace-share.ts sharesOf's query).
func (d *DB) GrantsOf(ctx context.Context, workspace string) ([]WorkspaceGrant, error) {
	var out []WorkspaceGrant
	err := d.read(ctx, "SELECT grantee_id, access FROM workspace_grants WHERE workspace = ? ORDER BY grantee_id", func(c *cols) {
		out = append(out, WorkspaceGrant{Workspace: workspace, GranteeID: c.text(), Access: c.text()})
	}, workspace)
	return out, wrap("workspace shares", err)
}

// ShareOutcome is what ShareWorkspace committed: the live grantee it acted on, or the refusal that stopped it with
// nothing written.
type ShareOutcome struct {
	Grantee Agent
	// Refusal is "machine" (the grantee runs on another machine), "self" (the owner), "archived", or "" when it acted.
	Refusal string
	// Prev is a grant's access held before ("" for none).
	Prev string
	// Removed is how many grants a revoke deleted, and Held the access the grantee itself held before ("write", else
	// "read").
	Removed int
	Held    string
}

// ShareWorkspace is src/workspace-share.ts share after its owner and grantee lookups, in one write: the agent foundID
// forwards to (its live cost-switch successor) is resolved, checked (same machine as the owner, not the owner, not
// archived), and given access to path ("read", "write"), or with "none" has it removed from it and every predecessor
// forwarding to it, directly or through others. A cost switch copies grants in one write too, so it lands wholly before
// (its successor is the grantee, its predecessors in the chain) or after (copying what this committed).
func (d *DB) ShareWorkspace(ctx context.Context, path string, owner Agent, foundID, access string) (ShareOutcome, error) {
	var out ShareOutcome
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		out = ShareOutcome{}
		forwards := map[string]string{}
		lifecycle := map[string]string{}
		if err := runSQLRows(conn, "SELECT id, forwarded_to, lifecycle FROM agents", func(stmt *sqlite.Stmt) {
			if stmt.ColumnType(1) != sqlite.TypeNull {
				forwards[stmt.ColumnText(0)] = stmt.ColumnText(1)
			}
			lifecycle[stmt.ColumnText(0)] = stmt.ColumnText(2)
		}); err != nil {
			return err
		}
		// ForwardTarget: the last successor that exists and isn't archived.
		target := foundID
		for seen := map[string]bool{}; !seen[target]; {
			seen[target] = true
			next, ok := forwards[target]
			if lc, exists := lifecycle[next]; !ok || !exists || lc == "archived" {
				break
			}
			target = next
		}
		g, err := agentOn(conn, target)
		if err != nil {
			return err
		}
		out.Grantee = g
		switch {
		case g.Machine != owner.Machine:
			out.Refusal = "machine"
		case g.ID == owner.ID:
			out.Refusal = "self"
		case g.Lifecycle == "archived":
			out.Refusal = "archived"
		}
		if out.Refusal != "" {
			return nil
		}
		held, err := textColumn(conn, "SELECT access FROM workspace_grants WHERE workspace = ? AND grantee_id = ?", path, g.ID)
		if err != nil {
			return err
		}
		if access != "none" {
			if len(held) > 0 {
				out.Prev = held[0]
			}
			return runSQL(conn, "INSERT INTO workspace_grants (workspace, grantee_id, access, granted_by, granted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace, grantee_id) DO UPDATE SET access = excluded.access, granted_by = excluded.granted_by, granted_at = excluded.granted_at",
				path, g.ID, access, owner.ID, now())
		}
		out.Held = "read"
		if len(held) > 0 && held[0] == "write" {
			out.Held = "write"
		}
		chain := []string{g.ID}
		in := map[string]bool{g.ID: true}
		for grew := true; grew; {
			grew = false
			for id, to := range forwards {
				if in[to] && !in[id] {
					chain, in[id], grew = append(chain, id), true, true
				}
			}
		}
		for _, id := range chain {
			if err := runSQL(conn, "DELETE FROM workspace_grants WHERE workspace = ? AND grantee_id = ?", path, id); err != nil {
				return err
			}
			out.Removed += conn.Changes()
		}
		return nil
	})
	return out, wrap("share workspace", err)
}

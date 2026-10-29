package db

import (
	"context"
	"encoding/json"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsjson"
)

// The reads of the usage summary (src/usage.ts summary, src/attribution.ts treeTotals, S-3807): its queries return rows
// whose columns the answer spreads as they are, so they come back as objects in column order, as node:sqlite gives
// them: a number (integer or real) as a float64, text as a string, NULL as nil.

// Objects runs a read query and returns each row as an object of its columns, in column order.
func (d *DB) Objects(ctx context.Context, query string, args ...any) ([]*jsjson.Object, error) {
	var out []*jsjson.Object
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
			row := jsjson.NewObject()
			for i := 0; i < stmt.ColumnCount(); i++ {
				var v jsjson.Value
				switch stmt.ColumnType(i) {
				case sqlite.TypeNull:
				case sqlite.TypeInteger:
					v = float64(stmt.ColumnInt64(i))
				case sqlite.TypeFloat:
					v = stmt.ColumnFloat(i)
				default:
					v = stmt.ColumnText(i)
				}
				row.Set(stmt.ColumnName(i), v)
			}
			out = append(out, row)
			return nil
		}})
	})
	return out, wrap("objects", err)
}

// TreeEdges is src/tree.ts edges over every agent: each parent link as [child, parent], each once, in TS's order: the
// spawning parents (agents by created_at), the adopting parents (agent_parents by child and parent), then the parents
// remembered for peer agents.
func (d *DB) TreeEdges(ctx context.Context) ([][2]string, error) {
	seen := map[[2]string]bool{}
	var out [][2]string
	add := func(child, parent string) {
		e := [2]string{child, parent}
		if !seen[e] {
			seen[e] = true
			out = append(out, e)
		}
	}
	err := d.read(ctx, "SELECT id, parent_id FROM agents WHERE parent_id IS NOT NULL AND parent_id <> '' ORDER BY created_at", func(c *cols) {
		id := c.text()
		add(id, c.text())
	})
	if err == nil {
		err = d.read(ctx, "SELECT child_id, parent_id FROM agent_parents ORDER BY child_id, parent_id", func(c *cols) {
			id := c.text()
			add(id, c.text())
		})
	}
	if err == nil {
		err = d.read(ctx, "SELECT id, parents FROM peer_agents WHERE parents IS NOT NULL", func(c *cols) {
			id := c.text()
			var parents []string
			if json.Unmarshal([]byte(c.text()), &parents) != nil {
				return
			}
			for _, p := range parents {
				add(id, p)
			}
		})
	}
	return out, wrap("tree edges", err)
}

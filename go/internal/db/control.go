package db

import (
	"context"
	"errors"
	"fmt"

	"zombiezen.com/go/sqlite"
)

// The writes of the agent-control routes (src/daemon.ts control, S-3746): rename, the parents, the human's default
// view, and the archive's own transaction. Each decides and writes in one transaction, so a concurrent change can't
// slip between its check and its write.

// ErrNameTaken is RenameAgent's refusal: another agent has the name, or an id equal to it.
var ErrNameTaken = errors.New("name taken")

// RenameAgent gives the agent a new name, refused with ErrNameTaken when an agent (by id or name, as src/db.ts
// getAgent finds one) already has it; it records the renamed event. It returns the agent's name before.
func (d *DB) RenameAgent(ctx context.Context, id, name string) (string, error) {
	var from string
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		taken, err := rows(conn, "SELECT id FROM agents WHERE id = ?1 OR name = ?1 LIMIT 1", name)
		if err != nil {
			return err
		}
		if len(taken) > 0 {
			return ErrNameTaken
		}
		cur, err := rows(conn, "SELECT name FROM agents WHERE id = ?", id)
		if err != nil {
			return err
		}
		if len(cur) == 0 {
			return ErrNotFound
		}
		from = cur[0].Text("name")
		if err := runSQL(conn, "UPDATE agents SET name = ?, updated_at = ? WHERE id = ?", name, now(), id); err != nil {
			return err
		}
		d.noteChanged(id, false)
		return insertEvent(conn, id, "renamed", renamedEvent{From: from, To: name})
	})
	if errors.Is(err, ErrNameTaken) || errors.Is(err, ErrNotFound) {
		return "", err
	}
	if err != nil {
		return "", fmt.Errorf("db: rename %s: %w", id, err)
	}
	return from, nil
}

type renamedEvent struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// AddParent adds an adopting parent (src/db.ts addParent): a parent the agent has already is left as it is.
func (d *DB) AddParent(ctx context.Context, child, parent string) error {
	return wrap("add parent", d.Write(ctx, func(conn *sqlite.Conn) error {
		d.noteChanged(child, false)
		return runSQL(conn, "INSERT OR IGNORE INTO agent_parents (child_id, parent_id) VALUES (?, ?)", child, parent)
	}))
}

// SetParents replaces every parent (src/db.ts setParents): the first is parent_id, the rest adopting parents; none makes
// the agent top-level. data, when not nil, is recorded as the agent's parents event in the same transaction.
func (d *DB) SetParents(ctx context.Context, child string, parents []string, data any) error {
	return wrap("set parents", d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, "DELETE FROM agent_parents WHERE child_id = ?", child); err != nil {
			return err
		}
		var first any
		if len(parents) > 0 {
			first = parents[0]
		}
		if err := runSQL(conn, "UPDATE agents SET parent_id = ?, updated_at = ? WHERE id = ?", first, now(), child); err != nil {
			return err
		}
		for _, p := range parents[min(1, len(parents)):] {
			if err := runSQL(conn, "INSERT OR IGNORE INTO agent_parents (child_id, parent_id) VALUES (?, ?)", child, p); err != nil {
				return err
			}
		}
		d.noteChanged(child, false)
		if data == nil {
			return nil
		}
		return insertEvent(conn, child, "parents", data)
	}))
}

// SetAgentView is src/db.ts setAgentView: the human's default view of an agent, or nil to follow the settings.
func (d *DB) SetAgentView(ctx context.Context, id string, view *string) error {
	return wrap("set agent view", d.Write(ctx, func(conn *sqlite.Conn) error {
		if view == nil {
			return runSQL(conn, "DELETE FROM agent_views WHERE agent_id = ?", id)
		}
		return runSQL(conn, "INSERT INTO agent_views (agent_id, view, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET view = excluded.view, updated_at = excluded.updated_at", id, *view, now())
	}))
}

// Archived is what MarkArchived writes besides the lifecycle: the cleanup's result, the paused_by left once the rest is
// gone, and, off the ITSA home, the unown to queue for it.
type Archived struct {
	Result   string
	PausedBy any
	// QueueUnown is set off the ITSA home: the pending unown is written with the lifecycle change, so a crash before it
	// is sent can't lose it (src/itsa-owners.ts queueUnown).
	QueueUnown bool
}

type archiveEvent struct {
	Result string `json:"result"`
}

type releasedEvent struct {
	Step      string `json:"step"`
	Successor string `json:"successor"`
}

// MarkArchived is the transaction at the end of src/lifecycle.ts archiveLocked: the agent is archived; it loses the
// workspaces shared with it; an agent it took over from gets its own mail again; its blockers go; the archive event is
// recorded; and off the home the unown is queued.
func (d *DB) MarkArchived(ctx context.Context, a Agent, o Archived) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := d.updateAgent(conn, a.ID, []Field{{"lifecycle", "archived"}, {"activity", "unknown"}, {"activity_detail", o.Result},
			{"pending_action", nil}, {"paused_by", o.PausedBy}}); err != nil {
			return err
		}
		if err := runSQL(conn, "DELETE FROM workspace_grants WHERE grantee_id = ?", a.ID); err != nil {
			return err
		}
		preds, err := rows(conn, "SELECT id FROM agents WHERE forwarded_to = ?", a.ID)
		if err != nil {
			return err
		}
		for _, p := range preds {
			pid := p.Text("id")
			if err := runSQL(conn, "UPDATE agents SET forwarded_to = NULL, updated_at = ? WHERE id = ?", now(), pid); err != nil {
				return err
			}
			if err := runSQL(conn, "DELETE FROM blockers WHERE agent_id = ? AND kind = 'taken-over'", pid); err != nil {
				return err
			}
			if err := insertEvent(conn, pid, "cost:switch", releasedEvent{Step: "released", Successor: a.Name}); err != nil {
				return err
			}
			d.noteChanged(pid, false)
		}
		if err := runSQL(conn, "DELETE FROM blockers WHERE agent_id = ?", a.ID); err != nil {
			return err
		}
		if err := insertEvent(conn, a.ID, "archive", archiveEvent{Result: o.Result}); err != nil {
			return err
		}
		if !o.QueueUnown {
			return nil
		}
		var typ any
		if a.Type != nil {
			typ = *a.Type
		}
		return runSQL(conn, "INSERT OR IGNORE INTO itsa_pending_unown (agent_id, name, how, type, created_at) VALUES (?, ?, 'archived', ?, ?)", a.ID, a.Name, typ, now())
	})
	return wrap("archive "+a.ID, err)
}

// DeleteBlockers is src/db.ts deleteBlockers: every blocker of the agent goes (a human's forced unpause).
func (d *DB) DeleteBlockers(ctx context.Context, id string) error {
	return wrap("delete blockers", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "DELETE FROM blockers WHERE agent_id = ?", id)
	}))
}

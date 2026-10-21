package db

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// HasPeerAgent is whether src/db.ts findPeerAgent finds an agent remembered from a peer under this id or name.
func (d *DB) HasPeerAgent(ctx context.Context, ref string) (bool, error) {
	n := 0
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT COUNT(*) FROM peer_agents WHERE id = ? OR name = ?", &sqlitex.ExecOptions{Args: []any{ref, ref},
			ResultFunc: func(stmt *sqlite.Stmt) error { n = stmt.ColumnInt(0); return nil }})
	})
	return n > 0, wrap("peer agent", err)
}

// PeerAgentRef is a remembered agent of another machine.
type PeerAgentRef struct{ ID, Name, Machine string }

// PeerAgentByID is src/db.ts peerAgentById: the remembered peer agent with this exact id (S-577), if any. Only the id
// column: a peer agent whose name happens to equal an id is not the same agent.
func (d *DB) PeerAgentByID(ctx context.Context, id string) (PeerAgentRef, bool, error) {
	var out PeerAgentRef
	found := false
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT id, name, machine FROM peer_agents WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id},
			ResultFunc: func(stmt *sqlite.Stmt) error {
				out, found = PeerAgentRef{stmt.ColumnText(0), stmt.ColumnText(1), stmt.ColumnText(2)}, true
				return nil
			}})
	})
	return out, found, wrap("peer agent", err)
}

// PeerAgentSeen is what a peer's listing or spawn reply says of an agent (src/db.ts rememberPeerAgent's argument).
type PeerAgentSeen struct {
	ID, Name, Machine string
	// Lifecycle is empty when the reply carries none.
	Lifecycle string
	// Parents is the listing's parent list; ParentID a spawn reply's single parent. Neither: the parents stay as they were.
	Parents  []string
	ParentID string
	// Activity is empty when the reply carries none: the busy flag stays as it was.
	Activity        string
	PendingRequests int
	// PausedBy and Waits decide whether an agent resting between standing turns counts as busy (restingWithWaits).
	PausedBy string
	Waits    int
}

const (
	// peerBusyRefresh is how often a busy peer agent is written again, which keeps its busy_at fresh.
	peerBusyRefresh = 5 * time.Minute
	restOwnerJSON   = `"standing-idle"`
)

var busyActivities = map[string]bool{"starting": true, "working": true, "waiting": true, "blocked": true}

// RememberPeerAgent is src/db.ts rememberPeerAgent: the directory of agents on other machines (peer_agents). An unchanged
// agent is not written again. A busy flag that flips is a "peer-busy" change for the org observer, which re-syncs the
// parents' waits and tree-idle notices.
func (d *DB) RememberPeerAgent(ctx context.Context, a PeerAgentSeen) error {
	parents := a.Parents
	if parents == nil && a.ParentID != "" {
		parents = []string{a.ParentID}
	}
	var parentsJSON any
	if parents != nil {
		b, _ := json.Marshal(parents)
		parentsJSON = string(b)
	}
	var busy any
	if a.Activity != "" {
		rest := a.Lifecycle == "paused" && strings.Contains(a.PausedBy, restOwnerJSON) && a.Waits > 0
		if a.Lifecycle != "archived" && (busyActivities[a.Activity] || a.PendingRequests > 0 || rest) {
			busy = 1
		} else {
			busy = 0
		}
	}
	key := a.Name + "|" + a.Machine + "|" + a.Lifecycle + "|"
	if parentsJSON != nil {
		key += parentsJSON.(string)
	}
	key += "|"
	if busy != nil {
		key += strconv.Itoa(busy.(int))
		if busy == 1 {
			key += "|" + strconv.FormatInt(time.Now().UnixMilli()/peerBusyRefresh.Milliseconds(), 10)
		}
	}
	// One writer at a time, from the comparison to the stored key: two writes of one id cannot leave the older key standing.
	d.peersMu.Lock()
	defer d.peersMu.Unlock()
	if d.peersSeen == nil {
		d.peersSeen = map[string]string{}
	}
	if d.peersSeen[a.ID] == key {
		return nil
	}
	var lifecycle, busyAt any
	if a.Lifecycle != "" {
		lifecycle = a.Lifecycle
	}
	stamp := now()
	if busy == 1 {
		busyAt = stamp
	}
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		before, err := peerBusy(conn, a.ID)
		if err != nil {
			return err
		}
		defer func() {
			if after, berr := peerBusy(conn, a.ID); berr == nil && after != before {
				d.noteActivity(ActivityChange{Kind: "peer-busy", ID: a.ID})
			}
		}()
		return sqlitex.Execute(conn, "INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle, parents, busy, busy_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, machine = excluded.machine, updated_at = excluded.updated_at, lifecycle = COALESCE(excluded.lifecycle, peer_agents.lifecycle), parents = COALESCE(excluded.parents, peer_agents.parents), busy = COALESCE(excluded.busy, peer_agents.busy), busy_at = CASE WHEN excluded.busy IS NULL THEN peer_agents.busy_at ELSE excluded.busy_at END",
			&sqlitex.ExecOptions{Args: []any{a.ID, a.Name, a.Machine, stamp, lifecycle, parentsJSON, busy, busyAt}})
	})
	if err != nil {
		return wrap("remember peer agent", err)
	}
	d.peersSeen[a.ID] = key
	return nil
}

// ClearAgentView is src/db.ts setAgentView(id, null): the human's default view of an agent is forgotten. A peer's agent
// forgotten through this daemon takes this daemon's preference with it.
func (d *DB) ClearAgentView(ctx context.Context, id string) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "DELETE FROM agent_views WHERE agent_id = ?", &sqlitex.ExecOptions{Args: []any{id}})
	})
	return wrap("clear agent view", err)
}

// ForgetPeerAgent is src/db.ts forgetPeerAgent: the remembered peer agent with this id or name is dropped, and with it what
// was remembered of every one, so the next listing writes them again.
func (d *DB) ForgetPeerAgent(ctx context.Context, ref string) error {
	d.peersMu.Lock()
	defer d.peersMu.Unlock()
	d.peersSeen = nil
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "DELETE FROM peer_agents WHERE id = ? OR name = ?", &sqlitex.ExecOptions{Args: []any{ref, ref}})
	})
	return wrap("forget peer agent", err)
}

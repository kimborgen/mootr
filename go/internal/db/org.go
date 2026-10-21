package db

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// What src/org.ts reads and writes of the agent tree (S-2848 B2b): the changes its observers hear, the busy agents and
// parent links its children waits count, and the requests and decision mails its startup rebuild settles.

// ActivityChange is one change src/org.ts or src/itsa-owners.ts observes: an agent's activity moving (src/db.ts
// onActivityChange) or its lifecycle (onLifecycleChange), the waits of a resting agent changing (onRestingWaitsChange),
// or a peer agent's busy flag flipping (onPeerBusyChange).
type ActivityChange struct {
	// Kind is "activity", "lifecycle", "resting-waits" or "peer-busy" (and "resync", which the lifecycle queues itself).
	Kind string
	ID   string
	// Before is the activity before; After the activity written, after open waits turned an idle into waiting. For a
	// "lifecycle" change, the lifecycle before and after.
	Before, After string
	// Requested is the activity the caller asked for, and RequestedDetail its activity_detail (nil when it set none).
	Requested       string
	RequestedDetail *string
	// Name, Activity, Detail, LastMessage and PendingAction are the agent's row as the write left it, for an "activity"
	// or "lifecycle" change.
	Name, Activity                     string
	Detail, LastMessage, PendingAction *string
}

// ActivityObserver hears each change once its write commits, with the write's context, on the writer's goroutine and
// before the writer connection goes back, so changes reach it in commit order. It must only queue the change: a write
// or a wait there would hold every other write.
type ActivityObserver func(ctx context.Context, c ActivityChange)

// ObserveActivity sets the org observer; nil removes it.
func (d *DB) ObserveActivity(fn ActivityObserver) {
	if fn == nil {
		d.activity.Store(nil)
		return
	}
	d.activity.Store(&fn)
}

func (d *DB) noteActivity(c ActivityChange) {
	d.activityChanges = append(d.activityChanges, c)
}

// noteActivityRow is noteActivity for an "activity" or "lifecycle" change, with the agent's row as the write left it.
func (d *DB) noteActivityRow(conn *sqlite.Conn, c ActivityChange) error {
	err := sqlitex.Execute(conn, "SELECT name, activity, activity_detail, last_message, pending_action FROM agents WHERE id = ?", &sqlitex.ExecOptions{Args: []any{c.ID},
		ResultFunc: func(stmt *sqlite.Stmt) error {
			col := &cols{stmt: stmt}
			c.Name, c.Activity, c.Detail, c.LastMessage, c.PendingAction = col.text(), col.text(), col.nullText(), col.nullText(), col.nullText()
			return nil
		}})
	if err != nil {
		return err
	}
	d.noteActivity(c)
	return nil
}

// restOwnedRow is src/db.ts restOwned on a row's lifecycle and paused_by.
func restOwnedRow(lifecycle, pausedBy string) bool {
	return lifecycle == "paused" && strings.Contains(pausedBy, restOwnerJSON)
}

// peerBusyFresh is src/db.ts PEER_BUSY_FRESH_MS: a peer agent's busy flag counts only while it is this fresh.
const peerBusyFresh = 15 * time.Minute

func peerFresh() string {
	return time.Now().Add(-peerBusyFresh).UTC().Format("2006-01-02T15:04:05.000Z")
}

// peerBusy is src/db.ts peerAgentBusy: the remembered peer agent's busy flag is set and fresh.
func peerBusy(conn *sqlite.Conn, id string) (bool, error) {
	r, err := rows(conn, "SELECT 1 FROM peer_agents WHERE id = ? AND busy = 1 AND busy_at > ?", id, peerFresh())
	return len(r) > 0, err
}

const restingWaiting = `(a.lifecycle = 'paused' AND instr(a.paused_by, '"standing-idle"') > 0 AND EXISTS (SELECT 1 FROM waits w WHERE w.agent_id = a.id))`

// BusyIDs is src/db.ts busyIds: every agent a parent's subtree counts as busy, here and on peers. A local one working,
// blocked, waiting, starting, with a pending permission request, or resting with a wait; a peer one with a fresh flag.
func (d *DB) BusyIDs(ctx context.Context) ([]string, error) {
	var out []string
	err := d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		out, err = column(conn, `SELECT a.id FROM agents a WHERE a.activity IN ('working', 'blocked', 'waiting', 'starting')
          OR EXISTS (SELECT 1 FROM permission_requests r WHERE r.agent_id = a.id AND r.status = 'pending') OR `+restingWaiting+`
       UNION SELECT pa.id FROM peer_agents pa WHERE pa.busy = 1 AND pa.busy_at > ?
          AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = pa.id)`, peerFresh())
		return err
	})
	return out, wrap("busy ids", err)
}

// ParentMap is src/tree.ts parentMap: every agent's parents, child to parents, from its spawning parent, its adopting
// parents and the parents remembered for peer agents, each link once, in that order.
func (d *DB) ParentMap(ctx context.Context) (map[string][]string, error) {
	out := map[string][]string{}
	seen := map[[2]string]bool{}
	add := func(child, parent string) {
		if seen[[2]string{child, parent}] {
			return
		}
		seen[[2]string{child, parent}] = true
		out[child] = append(out[child], parent)
	}
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		for _, q := range []string{
			"SELECT id, parent_id FROM agents WHERE parent_id IS NOT NULL AND parent_id != '' ORDER BY created_at, rowid",
			"SELECT child_id, parent_id FROM agent_parents ORDER BY rowid",
		} {
			if err := sqlitex.Execute(conn, q, &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
				add(stmt.ColumnText(0), stmt.ColumnText(1))
				return nil
			}}); err != nil {
				return err
			}
		}
		return sqlitex.Execute(conn, "SELECT id, parents FROM peer_agents WHERE parents IS NOT NULL ORDER BY rowid", &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
			var ps []string
			if json.Unmarshal([]byte(stmt.ColumnText(1)), &ps) == nil {
				for _, p := range ps {
					add(stmt.ColumnText(0), p)
				}
			}
			return nil
		}})
	})
	return out, wrap("parent map", err)
}

// HasPendingPermission is src/db.ts hasPendingPermission: the agent has an unresolved permission request.
func (d *DB) HasPendingPermission(ctx context.Context, id string) (bool, error) {
	found := false
	err := d.read(ctx, "SELECT 1 FROM permission_requests WHERE agent_id = ? AND status = 'pending' LIMIT 1", func(*cols) { found = true }, id)
	return found, wrap("pending permission", err)
}

// IsBusy is src/db.ts isBusy: a busy activity, a pending permission request, or resting with a wait.
func (d *DB) IsBusy(ctx context.Context, a Agent) (bool, error) {
	if busyActivities[string(a.Activity)] {
		return true, nil
	}
	if p, err := d.HasPendingPermission(ctx, a.ID); err != nil || p {
		return p, err
	}
	if !RestOwned(a) {
		return false, nil
	}
	ws, err := d.ListWaits(ctx, a.ID)
	return len(ws) > 0, err
}

// RestOwned is src/db.ts restOwned: paused with the rest among its pause owners.
func RestOwned(a Agent) bool {
	return restOwnedRow(string(a.Lifecycle), deref(a.PausedBy))
}

// UpdateWaitDetail is src/db.ts updateWaitDetail: one wait's detail, and its agent's summary following it.
func (d *DB) UpdateWaitDetail(ctx context.Context, id string, detail *string) error {
	return wrap("update wait detail", d.Write(ctx, func(conn *sqlite.Conn) error {
		ws, err := queryWaits(conn, "WHERE id = ?", id)
		if err != nil || len(ws) == 0 {
			return err
		}
		if err := runSQL(conn, "UPDATE waits SET detail = ? WHERE id = ?", sqlValue(detail), id); err != nil {
			return err
		}
		return d.syncWaits(conn, ws[0].AgentID)
	}))
}

// SetWaitTarget is src/db.ts setWaitTarget: ties a wait to what it waits on.
func (d *DB) SetWaitTarget(ctx context.Context, id, target string) error {
	return wrap("set wait target", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "UPDATE waits SET target = ? WHERE id = ?", target, id)
	}))
}

// PendingRequest is a pending permission request as the startup rebuild reads it.
type PendingRequest struct{ ID, AgentID, Audience string }

// PendingRequests is src/db.ts listPermissionRequests('pending'), newest first.
func (d *DB) PendingRequests(ctx context.Context) ([]PendingRequest, error) {
	var out []PendingRequest
	err := d.read(ctx, "SELECT id, agent_id, audience FROM permission_requests WHERE status = 'pending' ORDER BY created_at DESC",
		func(c *cols) { out = append(out, PendingRequest{ID: c.text(), AgentID: c.text(), Audience: c.text()}) })
	return out, wrap("pending requests", err)
}

// GetRequest is one permission request as a wait reads it; false for none.
func (d *DB) GetRequest(ctx context.Context, id string) (RequestState, bool, error) {
	var out RequestState
	found := false
	err := d.read(ctx, "SELECT id, status, audience, created_at, decided_at FROM permission_requests WHERE id = ?", func(c *cols) {
		out, found = RequestState{ID: c.text(), Status: c.text(), Audience: c.text(), CreatedAt: c.text(), DecidedAt: c.nullText()}, true
	}, id)
	return out, found, wrap("get request", err)
}

// OldestDecisionMails is, per sender, the created_at of its oldest decision mail still open (src/db.ts decisionMails,
// as src/org.ts settleRequestAsks reads it), in mail order.
func (d *DB) OldestDecisionMails(ctx context.Context) ([][2]string, error) {
	var out [][2]string
	seen := map[string]bool{}
	err := d.read(ctx, `SELECT m.from_id, m.created_at FROM decision_mails d JOIN mail m ON m.id = d.mail_id
    WHERE NOT EXISTS (SELECT 1 FROM permission_requests p WHERE p.agent_id = m.from_id AND p.status = 'pending' AND p.audience = 'human' AND (instr(m.subject, p.id) > 0 OR instr(m.body, p.id) > 0))
    ORDER BY m.created_at, m.rowid`, func(c *cols) {
		from, at := c.text(), c.text()
		if !seen[from] {
			seen[from] = true
			out = append(out, [2]string{from, at})
		}
	})
	return out, wrap("decision mails", err)
}

// ClearRequestDecisionMails is src/db.ts clearRequestDecisionMails: the agent's decision mails about a request, from
// before `before`, are no longer waiting on the human.
func (d *DB) ClearRequestDecisionMails(ctx context.Context, agentID, requestID, before string) error {
	return wrap("clear decision mails", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, `DELETE FROM decision_mails WHERE mail_id IN (SELECT m.id FROM decision_mails d JOIN mail m ON m.id = d.mail_id WHERE m.from_id = ? AND m.created_at <= ?
      AND (instr(m.subject, ?) > 0 OR instr(m.body, ?) > 0 OR d.thread_id IN (SELECT COALESCE(thread_id, id) FROM mail WHERE permission_id = ?)))`,
			agentID, before, requestID, requestID, requestID)
	}))
}

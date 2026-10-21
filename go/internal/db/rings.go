package db

import (
	"context"
	"strings"

	"zombiezen.com/go/sqlite"

	"stam/internal/jsfmt"
)

// The rows of src/ring.ts (rings and ring_submissions), read and written inside one transaction so a round's check and its move
// are one step: RingTx is what a ring's submit, decide and create do their work through.

// RingTx is a write transaction over the ring tables and what a ring reads of agents.
type RingTx struct{ conn *sqlite.Conn }

// InRing runs fn in one write transaction.
func (d *DB) InRing(ctx context.Context, fn func(tx RingTx) error) error {
	return wrap("ring", d.Write(ctx, func(conn *sqlite.Conn) error { return fn(RingTx{conn}) }))
}

// Ring is rings WHERE id = ? OR name = ?: the row as stored.
func (t RingTx) Ring(ref string) (jsfmt.Value, bool, error) {
	found, err := rows(t.conn, "SELECT * FROM rings WHERE id = ? OR name = ?", ref, ref)
	if err != nil || len(found) == 0 {
		return jsfmt.Value{}, false, err
	}
	return found[0], true, nil
}

// Subs is the ring's submissions of a round (every round for 0), in the order the ring reads them.
func (t RingTx) Subs(ringID string, round int) ([]jsfmt.Value, error) {
	q := "SELECT round, agent_id, text, agree, verdict FROM ring_submissions WHERE ring_id = ? "
	args := []any{ringID}
	if round != 0 {
		q += "AND round = ? "
		args = append(args, round)
	}
	return rows(t.conn, q+"ORDER BY round, created_at", args...)
}

// PutSub is INSERT OR REPLACE of a member's submission; verdict "" is null.
func (t RingTx) PutSub(ringID string, round int, agent, text string, agree bool, verdict string) error {
	var v any
	if verdict != "" {
		v = verdict
	}
	a := 0
	if agree {
		a = 1
	}
	return runSQL(t.conn, "INSERT OR REPLACE INTO ring_submissions (ring_id, round, agent_id, text, agree, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", ringID, round, agent, text, a, v, now())
}

// RingField is one column UPDATE sets; a nil value is null.
type RingField struct {
	Name  string
	Value any
}

// Update sets columns of the ring (the names are the code's own).
func (t RingTx) Update(ringID string, fields ...RingField) error {
	sets := make([]string, len(fields))
	args := make([]any, 0, len(fields)+1)
	for i, f := range fields {
		sets[i] = f.Name + " = ?"
		args = append(args, f.Value)
	}
	return runSQL(t.conn, "UPDATE rings SET "+strings.Join(sets, ", ")+" WHERE id = ?", append(args, ringID)...)
}

// NewRing is the INSERT of createRing.
type NewRing struct {
	ID, Name, Format, Topic, Members, CreatedBy string
	Moderator                                   string
	ModeratorDecides                            bool
	MaxRounds                                   int
}

// Insert adds the ring.
func (t RingTx) Insert(r NewRing) error {
	var mod any
	if r.Moderator != "" {
		mod = r.Moderator
	}
	d := 0
	if r.ModeratorDecides {
		d = 1
	}
	return runSQL(t.conn, "INSERT INTO rings (id, name, format, topic, members, moderator_id, moderator_decides, created_by, max_rounds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		r.ID, r.Name, r.Format, r.Topic, r.Members, mod, d, r.CreatedBy, r.MaxRounds, now())
}

// AgentEvent is db.addEvent(agent, type, data) inside the transaction.
func (t RingTx) AgentEvent(agentID, typ string, data jsfmt.Value) error {
	return addEvent(t.conn, agentID, typ, &data)
}

// Agent is the agent a ref names (id or name): its id, name and forwarding, ok false when there is none.
func (t RingTx) Agent(ref string) (id, name, forwardedTo, lifecycle string, ok bool, err error) {
	found, err := rows(t.conn, "SELECT id, name, forwarded_to, lifecycle FROM agents WHERE id = ? OR name = ?", ref, ref)
	if err != nil || len(found) == 0 {
		return "", "", "", "", false, err
	}
	a := found[0]
	return a.Text("id"), a.Text("name"), a.Text("forwarded_to"), a.Text("lifecycle"), true, nil
}

// ForwardTarget is db.forwardTarget: itself, or the last successor in the cost_switch chain; an archived successor gave the work
// back, so the chain stops before it.
func (t RingTx) ForwardTarget(id string) (string, error) {
	seen := map[string]bool{}
	cur, _, fwd, _, ok, err := t.Agent(id)
	if err != nil || !ok {
		return id, err
	}
	for fwd != "" && !seen[cur] {
		seen[cur] = true
		nid, _, nfwd, life, ok, err := t.Agent(fwd)
		if err != nil {
			return "", err
		}
		if !ok || life == "archived" {
			break
		}
		cur, fwd = nid, nfwd
	}
	return cur, nil
}

// RingsStatus is the list answer of ring.status(): the 50 latest rings.
func (d *DB) RingsStatus(ctx context.Context) ([]jsfmt.Value, error) {
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = rows(conn, "SELECT id, name, format, status, round, max_rounds, members FROM rings ORDER BY created_at DESC LIMIT 50")
		return err
	})
	return out, wrap("rings", err)
}

// OpenRings are the rings still running or moderating.
func (t RingTx) OpenRings() ([]jsfmt.Value, error) {
	return rows(t.conn, "SELECT * FROM rings WHERE status IN ('running', 'moderating')")
}

// RingView is ring.status(ref): the ring's row and its submissions, ok false when there is no such ring.
func (d *DB) RingView(ctx context.Context, ref string) (ring jsfmt.Value, subs []jsfmt.Value, ok bool, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) error {
		found, err := rows(conn, "SELECT * FROM rings WHERE id = ? OR name = ?", ref, ref)
		if err != nil || len(found) == 0 {
			return err
		}
		ring, ok = found[0], true
		subs, err = rows(conn, "SELECT round, agent_id, text, agree, verdict FROM ring_submissions WHERE ring_id = ? ORDER BY round, created_at", ring.Text("id"))
		return err
	})
	return ring, subs, ok, wrap("ring", err)
}

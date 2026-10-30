package db

import (
	"context"

	"zombiezen.com/go/sqlite"
)

// Input suggestions (src/db.ts, src/permissions.ts suggestInput; S-2848 B3b): text an agent asks the human to approve,
// which stam then types into the agent's own input box. A suggestion moves pending → held (approved, waiting for an
// idle, empty box) → approved (typed), or to denied, withdrawn, expired or failed. Each move is one conditional
// update, so two answers, or an answer and the expiry sweep, never both win.

// Replaced is a suggestion a newer one replaced, with the status it had.
type Replaced struct{ ID, Was string }

// NewInput is a suggestion to create. ExpiresAt is empty: a suggestion has no TTL (S-3830).
type NewInput struct {
	AgentID, Reason, Text, SHA256, ExpiresAt string
}

// CreateInputRequest is src/permissions.ts suggestInput's writes, in one transaction: the agent's pending suggestions are
// withdrawn with their waits ("a newer suggestion replaced it"), and the new one is created with a human wait on it. An
// approved (held) suggestion is never withdrawn by a newer one: it waits to be typed (S-3830). It returns the new request
// and the ones it replaced.
func (d *DB) CreateInputRequest(ctx context.Context, n NewInput) (PermissionRequest, []Replaced, error) {
	id := newRequestID()
	var out PermissionRequest
	var replaced []Replaced
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		replaced = nil
		olds, err := queryRequests(conn, "WHERE kind = 'input' AND status = ? AND agent_id = ? ORDER BY created_at", "pending", n.AgentID)
		if err != nil {
			return err
		}
		for _, old := range olds {
			moved, err := moveInput(conn, old.ID, old.Status, "withdrawn", MoveInput{Note: strPtr("a newer suggestion replaced it")})
			if err != nil {
				return err
			}
			if !moved {
				continue
			}
			if err := d.clearRequestWaits(conn, n.AgentID, old.ID); err != nil {
				return err
			}
			replaced = append(replaced, Replaced{ID: old.ID, Was: old.Status})
		}
		var expires any
		if n.ExpiresAt != "" {
			expires = n.ExpiresAt
		}
		if err := runSQL(conn, `INSERT INTO permission_requests (id, agent_id, action, reason, details, dialog, payload, audience, kind, text, sha256, expires_at, created_at)
      VALUES (?, ?, 'Type suggested input', ?, '', 0, NULL, 'human', 'input', ?, ?, ?, ?)`, id, n.AgentID, n.Reason, n.Text, n.SHA256, expires, now()); err != nil {
			return err
		}
		if _, err := d.addWait(conn, NewWait{AgentID: n.AgentID, Kind: "human", Source: "stam", Target: &id, Detail: strPtr("your approval")}); err != nil {
			return err
		}
		r, ok, err := first(queryRequests(conn, "WHERE id = ?", id))
		if err == nil && !ok {
			err = ErrNotFound
		}
		out = r
		return err
	})
	return out, replaced, wrap("create input request", err)
}

// MoveInput is what a move sets besides the status (src/db.ts moveInputRequest's fields): each nil keeps the column.
// Unexpired also requires expires_at to be in the future; SameSession requires the agent's session to still be the
// request's, in the same statement, so a hook that changes the session can't slip in between a check and the move;
// Settle clears the request's waits and decision mails in the same transaction when it moves; Expires sets expires_at
// (an approval's TTL, S-3830).
type MoveInput struct {
	By, Note, Session, Expires     *string
	Unexpired, SameSession, Settle bool
}

func moveInput(conn *sqlite.Conn, id, from, to string, f MoveInput) (bool, error) {
	q := `UPDATE permission_requests SET status = ?, decided_by = COALESCE(?, decided_by), note = COALESCE(?, note), session_id = COALESCE(?, session_id), expires_at = COALESCE(?, expires_at), decided_at = COALESCE(decided_at, ?) WHERE id = ? AND kind = 'input' AND status = ?`
	at := now()
	args := []any{to, ptrArg(f.By), ptrArg(f.Note), ptrArg(f.Session), ptrArg(f.Expires), at, id, from}
	if f.Unexpired {
		q += " AND expires_at > ?"
		args = append(args, at)
	}
	if f.SameSession {
		q += " AND COALESCE(session_id, '') = (SELECT COALESCE(session_id, '') FROM agents WHERE agents.id = permission_requests.agent_id)"
	}
	if err := runSQL(conn, q, args...); err != nil {
		return false, err
	}
	return conn.Changes() == 1, nil
}

// ptrArg is a nil string pointer as SQL NULL, else its string.
func ptrArg(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// MoveInputRequest is src/db.ts moveInputRequest: the suggestion moves from one status to another only if it is still
// in from. True when this call moved it.
func (d *DB) MoveInputRequest(ctx context.Context, id, from, to string, f MoveInput) (moved bool, err error) {
	moved, _, err = d.MoveInputRequestNoticed(ctx, id, from, to, f, nil)
	return moved, err
}

// MoveInputRequestNoticed is MoveInputRequest with the move's answer notice (S-3923) written in the same transaction:
// the move and its answer_notices row commit together, or neither does, and the row n replaces goes with them (S-4155).
// row is 0 when none was written.
func (d *DB) MoveInputRequestNoticed(ctx context.Context, id, from, to string, f MoveInput, n *NewAnswerNotice) (moved bool, row int64, err error) {
	err = d.answerWrite(ctx, "move input request", func(conn *sqlite.Conn) error {
		moved = false
		ok, err := moveInput(conn, id, from, to, f)
		if err != nil || !ok {
			return err
		}
		moved = true
		if f.Settle {
			r, _, err := first(queryRequests(conn, "WHERE id = ?", id))
			if err != nil {
				return err
			}
			if err := d.clearRequestWaits(conn, r.AgentID, id); err != nil {
				return err
			}
		}
		if n == nil {
			return nil
		}
		row, err = insertNewAnswerNotice(conn, *n)
		return err
	})
	if err != nil {
		moved, row = false, 0
	}
	return moved, row, wrap("move input request", err)
}

// SetHeldBox is src/db.ts setHeldBox: the text in the agent's input box that holds an approval (S-534), for the card;
// nil for none. Only a held request's note is set.
func (d *DB) SetHeldBox(ctx context.Context, id string, box *string) error {
	var note any
	if box != nil {
		note = "box:" + *box
	}
	return wrap("set held box", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "UPDATE permission_requests SET note = ? WHERE id = ? AND kind = 'input' AND status = 'held'", note, id)
	}))
}

// PermissionMail is src/db.ts permissionMail: the first mail that carried the request, to reply in its thread; ok false
// for none.
func (d *DB) PermissionMail(ctx context.Context, id string) (mailID string, ok bool, err error) {
	err = d.read(ctx, "SELECT id FROM mail WHERE permission_id = ? ORDER BY created_at LIMIT 1", func(c *cols) { mailID, ok = c.text(), true }, id)
	return mailID, ok, wrap("permission mail", err)
}

// PermissionMailPlaced is PermissionMail with whether that mail is a placed ask: one placed in a thread it didn't start
// (src/db.ts PLACED_ASK, S-3827). A placed ask's thread is shared, so a note in it must be sealed (S-3830).
func (d *DB) PermissionMailPlaced(ctx context.Context, id string) (mailID string, placed bool, ok bool, err error) {
	err = d.read(ctx, "SELECT m.id, "+placedAsk+" FROM mail m WHERE m.permission_id = ? ORDER BY m.created_at LIMIT 1", func(c *cols) {
		mailID, placed, ok = c.text(), c.int() == 1, true
	}, id)
	return mailID, placed, ok, wrap("permission mail placed", err)
}

// InputRequests is src/db.ts inputRequests: the suggestions in a status, oldest first, for the agent or, with "", every
// agent's.
func (d *DB) InputRequests(ctx context.Context, status, agentID string) ([]PermissionRequest, error) {
	if agentID == "" {
		return d.requests(ctx, "input requests", "WHERE kind = 'input' AND status = ? ORDER BY created_at", status)
	}
	return d.requests(ctx, "input requests", "WHERE kind = 'input' AND status = ? AND agent_id = ? ORDER BY created_at", status, agentID)
}

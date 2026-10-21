package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"

	"stam/internal/jsfmt"

	"zombiezen.com/go/sqlite"
)

// Permission requests (src/db.ts, src/permissions.ts; S-2848 B3a): an agent's ask through stam, and the harness dialogs
// stam turns into asks. Each write that settles or moves a request is conditional on its state and carries the request's
// waits in the same transaction, so two answers, an answer and an escalation, or an answer and the dialog timeout never
// both win.

// PermissionRequest is one row of permission_requests. Row is the whole row in column order, as TS answers it.
type PermissionRequest struct {
	ID, AgentID, Action, Reason, Details string
	// Status is pending, approved, denied or withdrawn (an input suggestion has more: held, expired, failed).
	Status string
	// Kind is request, dialog, settings or input.
	Kind string
	// Dialog is a harness dialog stam saw on the agent's screen.
	Dialog bool
	// Audience is human (only the human approves) or delegate (the parent or chief of staff decides, or escalates it).
	Audience  string
	Payload   *string
	CreatedAt string
	Row       jsfmt.Value
}

func requestOf(v jsfmt.Value) PermissionRequest {
	r := PermissionRequest{ID: v.Text("id"), AgentID: v.Text("agent_id"), Action: v.Text("action"), Reason: v.Text("reason"),
		Details: v.Text("details"), Status: v.Text("status"), Kind: v.Text("kind"), Audience: v.Text("audience"),
		CreatedAt: v.Text("created_at"), Row: v}
	if d, ok := v.Get("dialog"); ok && d.Kind == jsfmt.Number && d.Num != "0" {
		r.Dialog = true
	}
	if p, ok := v.Get("payload"); ok && p.Kind == jsfmt.String {
		s := p.Str
		r.Payload = &s
	}
	return r
}

func queryRequests(conn *sqlite.Conn, where string, args ...any) ([]PermissionRequest, error) {
	rs, err := rows(conn, "SELECT * FROM permission_requests "+where, args...)
	out := make([]PermissionRequest, 0, len(rs))
	for _, v := range rs {
		out = append(out, requestOf(v))
	}
	return out, err
}

func (d *DB) requests(ctx context.Context, what, where string, args ...any) (out []PermissionRequest, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		out, err = queryRequests(conn, where, args...)
		return err
	})
	return out, wrap(what, err)
}

func first(rs []PermissionRequest, err error) (PermissionRequest, bool, error) {
	if err != nil || len(rs) == 0 {
		return PermissionRequest{}, false, err
	}
	return rs[0], true, nil
}

// PermissionRequestByID is src/db.ts getPermissionRequest; false for none.
func (d *DB) PermissionRequestByID(ctx context.Context, id string) (PermissionRequest, bool, error) {
	return first(d.requests(ctx, "get permission request", "WHERE id = ?", id))
}

// PendingDialog is src/db.ts pendingDialog: the agent's pending request for a harness dialog, if one is open.
func (d *DB) PendingDialog(ctx context.Context, agentID string) (PermissionRequest, bool, error) {
	return first(d.requests(ctx, "pending dialog", "WHERE agent_id = ? AND status = 'pending' AND dialog = 1", agentID))
}

// PendingDialogs is src/db.ts pendingDialogs: every agent's pending harness-dialog request, oldest first.
func (d *DB) PendingDialogs(ctx context.Context) ([]PermissionRequest, error) {
	return d.requests(ctx, "pending dialogs", "WHERE status = 'pending' AND dialog = 1 ORDER BY created_at")
}

// StalePendingPermissions is src/db.ts stalePendingPermissions: the agent's requests pending since before or earlier.
func (d *DB) StalePendingPermissions(ctx context.Context, agentID, before string) ([]PermissionRequest, error) {
	return d.requests(ctx, "stale permissions", "WHERE agent_id = ? AND status = 'pending' AND created_at <= ?", agentID, before)
}

// ListPermissionRequests is src/db.ts listPermissionRequests without publicRequest: those with the status, newest
// first, or the newest 100 for "".
func (d *DB) ListPermissionRequests(ctx context.Context, status string) ([]PermissionRequest, error) {
	if status == "" {
		return d.requests(ctx, "list permission requests", "ORDER BY created_at DESC LIMIT 100")
	}
	return d.requests(ctx, "list permission requests", "WHERE status = ? ORDER BY created_at DESC", status)
}

func newRequestID() string {
	b := make([]byte, 4)
	rand.Read(b)
	return "p" + hex.EncodeToString(b)[:6]
}

// DelegateWait is the detail of the wait a delegate ask puts on its agent (src/permissions.ts DELEGATE_WAIT).
const DelegateWait = "your parent or the chief of staff"

// NewRequest is a request to create (src/db.ts createPermissionRequest's arguments, for a request or a dialog).
type NewRequest struct {
	AgentID, Action, Reason, Details string
	Dialog                           bool
	// Reviewer is the live reviewer a delegate ask waits on; "" for an ask that is the human's.
	Reviewer string
}

// CreatePermissionRequest is src/db.ts createPermissionRequest with the wait src/permissions.ts requestPermission adds,
// in one transaction: a delegate ask waits on its first reviewer, keyed by the request, and the human's ask is a human
// wait on the request.
func (d *DB) CreatePermissionRequest(ctx context.Context, n NewRequest) (PermissionRequest, error) {
	id := newRequestID()
	kind, audience := "request", "human"
	if n.Dialog {
		kind = "dialog"
	}
	if n.Reviewer != "" {
		audience = "delegate"
	}
	var out PermissionRequest
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, `INSERT INTO permission_requests (id, agent_id, action, reason, details, dialog, payload, audience, kind, text, sha256, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?)`, id, n.AgentID, n.Action, n.Reason, n.Details, b2i(n.Dialog), audience, kind, now()); err != nil {
			return err
		}
		w := NewWait{AgentID: n.AgentID, Kind: "human", Source: "stam", Target: &id, Detail: strPtr("your approval")}
		if n.Reviewer != "" {
			w = NewWait{AgentID: n.AgentID, Kind: "agent", Source: "stam", Target: strPtr(n.Reviewer), Detail: strPtr(DelegateWait), Data: &id}
		}
		if _, err := d.addWait(conn, w); err != nil {
			return err
		}
		r, ok, err := first(queryRequests(conn, "WHERE id = ?", id))
		if err == nil && !ok {
			err = ErrNotFound
		}
		out = r
		return err
	})
	return out, wrap("create permission request", err)
}

// clearRequestWaits is src/db.ts clearRequestWaits in the caller's transaction: the agent's stam wait for the request,
// whichever audience it waited on, its own wait_for human tied to it, and its decision mails about it.
func (d *DB) clearRequestWaits(conn *sqlite.Conn, agentID, requestID string) error {
	if err := runSQL(conn, "DELETE FROM waits WHERE agent_id = ? AND ((source = 'stam' AND (target = ? OR data = ?)) OR (kind = 'human' AND target = ?))",
		agentID, requestID, requestID, requestID); err != nil {
		return err
	}
	if conn.Changes() > 0 {
		if err := d.syncWaits(conn, agentID); err != nil {
			return err
		}
	}
	return runSQL(conn, `DELETE FROM decision_mails WHERE mail_id IN (SELECT m.id FROM decision_mails d JOIN mail m ON m.id = d.mail_id WHERE m.from_id = ? AND m.created_at <= '9999'
      AND (instr(m.subject, ?) > 0 OR instr(m.body, ?) > 0 OR d.thread_id IN (SELECT COALESCE(thread_id, id) FROM mail WHERE permission_id = ?)))`,
		agentID, requestID, requestID, requestID)
}

// EscalatePermissionRequest is src/db.ts escalatePermissionRequest with the waits src/permissions.ts handToHuman moves:
// a pending delegate ask becomes the human's, and its agent waits on the human for it. False when this call didn't
// move it (answered, withdrawn, or already the human's), and then nothing is written.
func (d *DB) EscalatePermissionRequest(ctx context.Context, id string) (moved bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		r, ok, err := first(queryRequests(conn, "WHERE id = ? AND status = 'pending' AND audience = 'delegate'", id))
		if err != nil || !ok {
			return err
		}
		if err := runSQL(conn, "UPDATE permission_requests SET audience = 'human' WHERE id = ?", id); err != nil {
			return err
		}
		if err := d.clearRequestWaits(conn, r.AgentID, id); err != nil {
			return err
		}
		_, err = d.addWait(conn, NewWait{AgentID: r.AgentID, Kind: "human", Source: "stam", Target: &id, Detail: strPtr("your approval")})
		moved = err == nil
		return err
	})
	return moved, wrap("escalate permission request", err)
}

// DecidePermissionRequest is src/db.ts decidePermissionRequest and the clearRequestWaits after it, in one transaction:
// a pending request becomes approved or denied by `by`, with the note. Check is run on the request inside the
// transaction, before the write: an error from it writes nothing, and is returned as is. False when the request was
// no longer pending, and then nothing is written.
func (d *DB) DecidePermissionRequest(ctx context.Context, id string, approve bool, by, note string, check func(PermissionRequest) error) (decided bool, err error) {
	status := "denied"
	if approve {
		status = "approved"
	}
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		r, ok, err := first(queryRequests(conn, "WHERE id = ? AND status = 'pending'", id))
		if err != nil || !ok {
			return err
		}
		if check != nil {
			if err := check(r); err != nil {
				return err
			}
		}
		if err := runSQL(conn, "UPDATE permission_requests SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ?", status, by, note, now(), id); err != nil {
			return err
		}
		decided = true
		return d.clearRequestWaits(conn, r.AgentID, id)
	})
	if err != nil {
		decided = false
	}
	return decided, wrap("decide permission request", err)
}

// WithdrawPermissionRequest is src/db.ts withdrawPermissionRequest and the clearRequestWaits after it, in one
// transaction: a pending request nobody answered through stam closes. False when it was no longer pending.
func (d *DB) WithdrawPermissionRequest(ctx context.Context, id, note string) (withdrawn bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		r, ok, err := first(queryRequests(conn, "WHERE id = ? AND status = 'pending'", id))
		if err != nil || !ok {
			return err
		}
		if err := runSQL(conn, "UPDATE permission_requests SET status = 'withdrawn', note = ?, decided_at = ? WHERE id = ?", note, now(), id); err != nil {
			return err
		}
		withdrawn = true
		return d.clearRequestWaits(conn, r.AgentID, id)
	})
	if err != nil {
		withdrawn = false
	}
	return withdrawn, wrap("withdraw permission request", err)
}

// PermissionMailIDs is src/db.ts permissionMailIds: the mails that carry the request.
func (d *DB) PermissionMailIDs(ctx context.Context, requestID string) ([]string, error) {
	var out []string
	err := d.read(ctx, "SELECT id FROM mail WHERE permission_id = ?", func(c *cols) { out = append(out, c.text()) }, requestID)
	return out, wrap("permission mails", err)
}

// PermissionMailRecipients is src/db.ts permissionMailRecipients: who the request's first mail went to besides the
// human, in the order it named them.
func (d *DB) PermissionMailRecipients(ctx context.Context, requestID string) ([]string, error) {
	var out []string
	err := d.read(ctx, "SELECT r.agent_id FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE m.id = (SELECT id FROM mail WHERE permission_id = ? ORDER BY created_at LIMIT 1) AND r.agent_id != 'human' ORDER BY r.rowid",
		func(c *cols) { out = append(out, c.text()) }, requestID)
	return out, wrap("permission mail recipients", err)
}

// PeerAgentLifecycle is src/db.ts peerAgentLifecycle: the lifecycle a remembered peer agent was last seen with; false
// when unknown.
func (d *DB) PeerAgentLifecycle(ctx context.Context, id string) (string, bool, error) {
	out, found := "", false
	err := d.read(ctx, "SELECT lifecycle FROM peer_agents WHERE id = ? AND lifecycle IS NOT NULL", func(c *cols) { out, found = c.text(), true }, id)
	return out, found, wrap("peer agent lifecycle", err)
}

// PeerAgentName is the name of the agent src/db.ts findPeerAgent finds by id or name; "" for none.
func (d *DB) PeerAgentName(ctx context.Context, ref string) (string, error) {
	out := ""
	err := d.read(ctx, "SELECT name FROM peer_agents WHERE id = ? OR name = ? ORDER BY id = ? DESC LIMIT 1", func(c *cols) { out = c.text() }, ref, ref, ref)
	return out, wrap("peer agent name", err)
}

// PublicRequest is src/db.ts publicRequest: the request as agents and the web UI see it, without its payload, with
// its agent's name and machine (machine for an agent this daemon no longer has). A pending delegate ask also names the
// reviewers its mail went to (`with`) and that mail's subject.
func (d *DB) PublicRequest(ctx context.Context, r PermissionRequest, machine string) (jsfmt.Value, error) {
	out := jsfmt.Value{Kind: jsfmt.Object}
	for i, k := range r.Row.Keys {
		if k != "payload" {
			out.Set(k, r.Row.Items[i])
		}
	}
	a, err := d.GetAgent(ctx, r.AgentID)
	switch {
	case err == nil:
		out.Set("agent_name", jsfmt.StringValue(a.Name))
		if a.Machine != "" {
			machine = a.Machine
		}
	case errors.Is(err, ErrNotFound):
		out.Set("agent_name", jsfmt.NullValue())
	default:
		return jsfmt.Value{}, err
	}
	out.Set("machine", jsfmt.StringValue(machine))
	if r.Audience != "delegate" || r.Status != "pending" {
		return out, nil
	}
	ids, err := d.PermissionMailRecipients(ctx, r.ID)
	if err != nil {
		return jsfmt.Value{}, err
	}
	with := []jsfmt.Value{}
	for _, id := range ids {
		name := id
		if x, err := d.GetAgent(ctx, id); err == nil {
			name = x.Name
		} else if n, err := d.PeerAgentName(ctx, id); err == nil && n != "" {
			name = n
		}
		with = append(with, jsfmt.StringValue(name))
	}
	out.Set("with", jsfmt.ArrayValue(with))
	subject, found := "", false
	if err := d.read(ctx, "SELECT subject FROM mail WHERE permission_id = ? ORDER BY created_at LIMIT 1", func(c *cols) { subject, found = c.text(), true }, r.ID); err != nil {
		return jsfmt.Value{}, err
	}
	if found && subject != "" {
		out.Set("subject", jsfmt.StringValue(subject))
	}
	return out, nil
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func strPtr(s string) *string { return &s }

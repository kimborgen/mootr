package db

import (
	"context"
	"fmt"
	"regexp"
	"strconv"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The cost switch's writes (src/cost-switch.ts move and unmove, S-2848 B5e): a successor takes the predecessor's place
// in the org in one transaction, and a failed switch puts it all back in another.

var successorSuffix = regexp.MustCompile(`-t\d+$`)

// SuccessorName is src/cost-switch.ts successorName: NAME-t2, NAME-t3, ..., the first free one, counting every agent ever
// stored, archived too. A successor's successor counts on from the original name (x-t2 becomes x-t3).
func (d *DB) SuccessorName(ctx context.Context, name string) (string, error) {
	var out string
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = successorName(conn, name)
		return err
	})
	return out, wrap("successor name", err)
}

func successorName(conn *sqlite.Conn, name string) (string, error) {
	base := successorSuffix.ReplaceAllString(name, "")
	for n := 2; ; n++ {
		try := base + "-t" + strconv.Itoa(n)
		taken := false
		if err := runSQLRows(conn, "SELECT 1 FROM agents WHERE id = ?1 OR name = ?1", func(*sqlite.Stmt) { taken = true }, try); err != nil {
			return "", err
		}
		if !taken {
			return try, nil
		}
	}
}

func runSQLRows(conn *sqlite.Conn, query string, row func(stmt *sqlite.Stmt), args ...any) error {
	return sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error { row(stmt); return nil }})
}

func textColumn(conn *sqlite.Conn, query string, args ...any) ([]string, error) {
	var out []string
	err := runSQLRows(conn, query, func(stmt *sqlite.Stmt) { out = append(out, stmt.ColumnText(0)) }, args...)
	return out, err
}

// ThreadRef is one of an agent's open threads, for the successor's read copies and its takeover prompt. ThreadID is nil
// for the group of mail with no thread, which TS lists as "null" and which has no mail to copy.
type ThreadRef struct {
	ThreadID *string
	Subject  string
}

// OpenThreads is src/cost-switch.ts openThreads: the latest `limit` threads the box sent or received mail in (src/db.ts
// threads), less the ones it archived (splitArchived), newest activity first, each with its first mail's subject.
func (d *DB) OpenThreads(ctx context.Context, box string, limit int) ([]ThreadRef, error) {
	var out []ThreadRef
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var ids []*string
		err := runSQLRows(conn, `SELECT m.thread_id AS t, MAX(m.created_at) AS last FROM mail m
			WHERE (m.from_id = ? OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?))
			GROUP BY m.thread_id ORDER BY last DESC LIMIT ?`, func(stmt *sqlite.Stmt) {
			ids = append(ids, (&cols{stmt: stmt}).nullText())
		}, box, box, limit)
		if err != nil {
			return err
		}
		taken := map[string]bool{}
		if err := runSQLRows(conn, "SELECT thread_id FROM thread_archive WHERE mailbox_id = ?", func(stmt *sqlite.Stmt) { taken[stmt.ColumnText(0)] = true }, box); err != nil {
			return err
		}
		for _, t := range ids {
			ref := ThreadRef{ThreadID: t}
			if t == nil {
				out = append(out, ref)
				continue
			}
			type mail struct {
				id      string
				pending bool
				toBox   bool
			}
			var mails []mail
			err := runSQLRows(conn, `SELECT m.id, m.subject, COALESCE((SELECT p.status FROM permission_requests p WHERE p.id = m.permission_id), ''),
				EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?)
				FROM mail m WHERE m.thread_id = ? ORDER BY m.created_at`, func(stmt *sqlite.Stmt) {
				if len(mails) == 0 {
					ref.Subject = stmt.ColumnText(1)
				}
				mails = append(mails, mail{id: stmt.ColumnText(0), pending: stmt.ColumnText(2) == "pending", toBox: stmt.ColumnInt(3) == 1})
			}, box, *t)
			if err != nil {
				return err
			}
			archived := taken[*t]
			if archived {
				known := map[string]bool{}
				if err := runSQLRows(conn, "SELECT mail_id FROM thread_archive_mail WHERE mailbox_id = ? AND thread_id = ?", func(stmt *sqlite.Stmt) { known[stmt.ColumnText(0)] = true }, box, *t); err != nil {
					return err
				}
				for _, m := range mails {
					// A pending permission request keeps its thread in the inbox; a message the archive didn't record,
					// sent to the box, makes it active again.
					if m.pending || (!known[m.id] && m.toBox) {
						archived = false
						break
					}
				}
			}
			if !archived {
				out = append(out, ref)
			}
		}
		return nil
	})
	return out, wrap("open threads", err)
}

// Moved is src/cost-switch.ts Moved: what the move moved, so a failed launch can put it back.
type Moved struct {
	// Children whose spawning parent (agents.parent_id) was the predecessor.
	Spawned []string
	// Children that had the predecessor as an adopting parent (agent_parents).
	Adopted []string
	Unread  []string
	// Mail still owed to the predecessor by a read batch (S-357), with its read state, which moves to the successor as
	// unread; the rollback puts the read state back.
	Owed []OwedMail
	// Read mail of open threads that the successor got a read copy of.
	Copies     []string
	ItsaOwned  []string
	ItsaJoined []string
}

// OwedMail is one mail a read batch still owes, with the read state it had.
type OwedMail struct {
	MailID string
	ReadAt *string
}

// SuccessorSpec is the successor's row: NewAgent's columns (its Name is chosen inside the move) and the columns set
// after, in src/cost-switch.ts move's order.
type SuccessorSpec struct {
	Agent  NewAgent
	Fields []Field
}

type switchMovedEvent struct {
	Step     string `json:"step"`
	To       string `json:"to"`
	Preset   string `json:"preset"`
	Children int    `json:"children"`
	Unread   int    `json:"unread"`
	Threads  int    `json:"threads"`
}

type switchCreatedEvent struct {
	Step   string `json:"step"`
	From   string `json:"from"`
	Preset string `json:"preset"`
}

// MoveToSuccessor is src/cost-switch.ts move: in one transaction it creates the successor (its name the first free
// NAME-tN of the predecessor's, its parents the predecessor's), moves the predecessor's children, unread and owed mail
// with their batches, open ITSAs and workspace grants to it, gives it read copies of the open threads' read mail, and
// forwards the predecessor's mail to it. On any error nothing is written.
func (d *DB) MoveToSuccessor(ctx context.Context, pred Agent, spec SuccessorSpec, threads []ThreadRef, preset string) (Agent, Moved, error) {
	var moved Moved
	s := spec.Agent
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		a, err := agentOn(conn, pred.ID)
		if err != nil {
			return err
		}
		if s.Name, err = successorName(conn, a.Name); err != nil {
			return err
		}
		t := now()
		if err := runSQL(conn, `INSERT INTO agents (id, name, role, machine, harness, model, effort, cwd, parent_id, session_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, s.ID, s.Name, s.Role, s.Machine, s.Harness, orNull(s.Model), orNull(s.Effort), s.Cwd, orNull(s.ParentID), orNull(s.SessionID), t, t); err != nil {
			return err
		}
		parents, err := parentsOn(conn, a)
		if err != nil {
			return err
		}
		for _, p := range parents {
			if a.ParentID == nil || p != *a.ParentID {
				if err := runSQL(conn, "INSERT OR IGNORE INTO agent_parents (child_id, parent_id) VALUES (?, ?)", s.ID, p); err != nil {
					return err
				}
			}
		}
		if err := d.updateAgent(conn, s.ID, spec.Fields); err != nil {
			return err
		}

		if moved.Spawned, err = textColumn(conn, "SELECT id FROM agents WHERE parent_id = ? AND id != ?", a.ID, s.ID); err != nil {
			return err
		}
		if err := runSQL(conn, "UPDATE agents SET parent_id = ? WHERE parent_id = ? AND id != ?", s.ID, a.ID, s.ID); err != nil {
			return err
		}
		if moved.Adopted, err = textColumn(conn, "SELECT child_id FROM agent_parents WHERE parent_id = ?", a.ID); err != nil {
			return err
		}
		for _, c := range moved.Adopted {
			if err := runSQL(conn, "DELETE FROM agent_parents WHERE child_id = ? AND parent_id = ?", c, a.ID); err != nil {
				return err
			}
			if err := runSQL(conn, "INSERT OR IGNORE INTO agent_parents (child_id, parent_id) VALUES (?, ?)", c, s.ID); err != nil {
				return err
			}
		}

		// Owed mail is moved as unread, so the successor sees it, with its batches (mail_deliveries).
		const owedIn = "(SELECT mail_id FROM mail_deliveries WHERE agent_id = ?)"
		err = runSQLRows(conn, "SELECT mail_id, read_at FROM mail_recipients WHERE agent_id = ? AND read_at IS NOT NULL AND mail_id IN "+owedIn, func(stmt *sqlite.Stmt) {
			c := cols{stmt: stmt}
			moved.Owed = append(moved.Owed, OwedMail{MailID: c.text(), ReadAt: c.nullText()})
		}, a.ID, a.ID)
		if err != nil {
			return err
		}
		if moved.Unread, err = textColumn(conn, "SELECT mail_id FROM mail_recipients WHERE agent_id = ? AND (read_at IS NULL OR mail_id IN "+owedIn+")", a.ID, a.ID); err != nil {
			return err
		}
		for _, q := range []struct {
			sql  string
			args []any
		}{
			{"UPDATE mail_recipients SET read_at = NULL WHERE agent_id = ? AND mail_id IN " + owedIn, []any{a.ID, a.ID}},
			{"UPDATE mail_recipients SET agent_id = ? WHERE agent_id = ? AND read_at IS NULL", []any{s.ID, a.ID}},
			{"UPDATE mail_deliveries SET agent_id = ? WHERE agent_id = ?", []any{s.ID, a.ID}},
		} {
			if err := runSQL(conn, q.sql, q.args...); err != nil {
				return err
			}
		}
		// The read mail of open threads stays the predecessor's too; the successor gets a read copy, so the threads
		// list, read_thread and reply guessing work for it.
		at := now()
		for _, th := range threads {
			if th.ThreadID == nil {
				continue
			}
			ids, err := textColumn(conn, "SELECT r.mail_id FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE m.thread_id = ? AND r.agent_id = ?", *th.ThreadID, a.ID)
			if err != nil {
				return err
			}
			for _, id := range ids {
				if err := runSQL(conn, "INSERT OR IGNORE INTO mail_recipients (mail_id, agent_id, read_at, pushed_at) VALUES (?, ?, ?, ?)", id, s.ID, at, at); err != nil {
					return err
				}
				if conn.Changes() > 0 {
					moved.Copies = append(moved.Copies, id)
				}
			}
		}

		if moved.ItsaOwned, err = textColumn(conn, "SELECT id FROM itsas WHERE owner = ? AND closed_at IS NULL", a.ID); err != nil {
			return err
		}
		if err := runSQL(conn, "UPDATE itsas SET owner = ?, updated_at = ? WHERE owner = ? AND closed_at IS NULL", s.ID, now(), a.ID); err != nil {
			return err
		}
		joined, err := textColumn(conn, "SELECT p.itsa_id FROM itsa_participants p JOIN itsas i ON i.id = p.itsa_id WHERE p.agent_id = ? AND p.left_at IS NULL AND i.closed_at IS NULL", a.ID)
		if err != nil {
			return err
		}
		for _, id := range joined {
			if err := runSQL(conn, "INSERT OR IGNORE INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)", id, s.ID); err != nil {
				return err
			}
			if conn.Changes() > 0 {
				moved.ItsaJoined = append(moved.ItsaJoined, id)
			}
		}

		// The workspaces shared with the predecessor are shared with the successor too (S-896, src/workspace-share.ts
		// copyGrants); forgetting the successor drops them again if the switch is undone.
		if err := runSQL(conn, "INSERT OR IGNORE INTO workspace_grants (workspace, grantee_id, access, granted_by, granted_at) SELECT workspace, ?, access, granted_by, granted_at FROM workspace_grants WHERE grantee_id = ?", s.ID, a.ID); err != nil {
			return err
		}

		if err := d.updateAgent(conn, a.ID, []Field{{"forwarded_to", s.ID}}); err != nil {
			return err
		}
		if err := eventOn(conn, a.ID, "cost:switch", switchMovedEvent{Step: "moved", To: s.Name, Preset: preset, Children: len(moved.Spawned) + len(moved.Adopted), Unread: len(moved.Unread), Threads: len(threads)}); err != nil {
			return err
		}
		return eventOn(conn, s.ID, "cost:switch", switchCreatedEvent{Step: "created", From: a.Name, Preset: preset})
	})
	if err != nil {
		return Agent{}, Moved{}, fmt.Errorf("db: move %s to a successor: %w", pred.Name, err)
	}
	out, err := d.GetAgent(ctx, s.ID)
	return out, moved, err
}

// Unmove is src/cost-switch.ts unmove: it puts back what MoveToSuccessor moved and forgets the successor, in one
// transaction.
func (d *DB) Unmove(ctx context.Context, predID, succID string, moved Moved) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		for _, c := range moved.Spawned {
			if err := runSQL(conn, "UPDATE agents SET parent_id = ? WHERE id = ? AND parent_id = ?", predID, c, succID); err != nil {
				return err
			}
		}
		for _, c := range moved.Adopted {
			if err := runSQL(conn, "DELETE FROM agent_parents WHERE child_id = ? AND parent_id = ?", c, succID); err != nil {
				return err
			}
			if err := runSQL(conn, "INSERT OR IGNORE INTO agent_parents (child_id, parent_id) VALUES (?, ?)", c, predID); err != nil {
				return err
			}
		}
		// Every delivery the successor got goes back, the moved unread mail and anything sent to it since; only the
		// read copies made for it are dropped. Where the predecessor has its own copy, the two merge, unread if either
		// was.
		copies := map[string]bool{}
		for _, id := range moved.Copies {
			copies[id] = true
		}
		type delivery struct {
			mailID           string
			readAt, pushedAt *string
			quiet            int
		}
		var got []delivery
		err := runSQLRows(conn, "SELECT mail_id, read_at, pushed_at, quiet FROM mail_recipients WHERE agent_id = ?", func(stmt *sqlite.Stmt) {
			c := cols{stmt: stmt}
			got = append(got, delivery{mailID: c.text(), readAt: c.nullText(), pushedAt: c.nullText(), quiet: c.int()})
		}, succID)
		if err != nil {
			return err
		}
		for _, r := range got {
			if copies[r.mailID] {
				continue
			}
			mine, found := (*string)(nil), false
			if err := runSQLRows(conn, "SELECT read_at FROM mail_recipients WHERE agent_id = ? AND mail_id = ?", func(stmt *sqlite.Stmt) {
				found, mine = true, (&cols{stmt: stmt}).nullText()
			}, predID, r.mailID); err != nil {
				return err
			}
			switch {
			case found:
				if mine != nil && r.readAt == nil {
					if err := runSQL(conn, "UPDATE mail_recipients SET read_at = NULL, pushed_at = NULL WHERE agent_id = ? AND mail_id = ?", predID, r.mailID); err != nil {
						return err
					}
				}
			default:
				if err := runSQL(conn, "INSERT INTO mail_recipients (mail_id, agent_id, read_at, pushed_at, quiet) VALUES (?, ?, ?, ?, ?)", r.mailID, predID, orNull(r.readAt), orNull(r.pushedAt), r.quiet); err != nil {
					return err
				}
			}
		}
		// The owed mail and its batches go back, with the read state the predecessor had.
		if err := runSQL(conn, "UPDATE mail_deliveries SET agent_id = ? WHERE agent_id = ?", predID, succID); err != nil {
			return err
		}
		for _, o := range moved.Owed {
			if err := runSQL(conn, "UPDATE mail_recipients SET read_at = ? WHERE agent_id = ? AND mail_id = ? AND read_at IS NULL", orNull(o.ReadAt), predID, o.MailID); err != nil {
				return err
			}
		}
		for _, id := range moved.ItsaOwned {
			if err := runSQL(conn, "UPDATE itsas SET owner = ?, updated_at = ? WHERE id = ? AND owner = ?", predID, now(), id, succID); err != nil {
				return err
			}
		}
		for _, q := range []struct {
			sql  string
			args []any
		}{
			{"DELETE FROM itsa_participants WHERE agent_id = ?", []any{succID}},
			{"DELETE FROM agent_parents WHERE child_id = ? OR parent_id = ?", []any{succID, succID}},
		} {
			if err := runSQL(conn, q.sql, q.args...); err != nil {
				return err
			}
		}
		if err := d.updateAgent(conn, predID, []Field{{"forwarded_to", nil}}); err != nil {
			return err
		}
		// Also drops the successor's own rows, the read copies among them.
		return forgetAgentOn(conn, succID)
	})
	return wrap("unmove", err)
}

// agentOn is GetAgent inside a write.
func agentOn(conn *sqlite.Conn, id string) (Agent, error) {
	var a Agent
	found := false
	err := runSQLRows(conn, selectAgents+" WHERE id = ?", func(stmt *sqlite.Stmt) { a, found = scanAgent(stmt), true }, id)
	if err == nil && !found {
		err = ErrNotFound
	}
	return a, err
}

// parentsOn is ParentsOf inside a write.
func parentsOn(conn *sqlite.Conn, a Agent) ([]string, error) {
	var out []string
	if a.ParentID != nil {
		out = append(out, *a.ParentID)
	}
	adopted, err := textColumn(conn, "SELECT parent_id FROM agent_parents WHERE child_id = ?", a.ID)
	for _, p := range adopted {
		if !contains(out, p) {
			out = append(out, p)
		}
	}
	return out, err
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// eventOn is AddEvent inside a write.
func eventOn(conn *sqlite.Conn, agentID, typ string, data any) error {
	s, err := stringify(data)
	if err != nil {
		return err
	}
	return runSQL(conn, "INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, ?)", agentID, now(), typ, s)
}

// OpenItsaKeysOwnedBy is the keys of the open ITSAs the agent owns, as src/cost-switch.ts handoverOf lists them.
func (d *DB) OpenItsaKeysOwnedBy(ctx context.Context, id string) ([]string, error) {
	var out []string
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = textColumn(conn, "SELECT key FROM itsas WHERE owner = ? AND closed_at IS NULL", id)
		return err
	})
	return out, wrap("owned itsas", err)
}

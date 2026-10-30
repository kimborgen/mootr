package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"sort"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
)

// The mail writes of src/db.ts and src/mail.ts storeMail (S-2824, slice B): a stored mail with its recipients, the
// deferral and decision bookkeeping around it, the mail:received events, and the declared waits it answers.

// NewMailID is src/db.ts newMailId: `m` and seven hex digits.
func NewMailID() string {
	var b [5]byte
	_, _ = rand.Read(b[:])
	return "m" + hex.EncodeToString(b[:])[:7]
}

// MailFile is an attachment already written under the home.
type MailFile struct {
	Name, Path string
	Size       int64
}

// Stored is the mail to store: the mail row, the recipients (quiet ones do not interrupt a working agent) and what the
// human's side of the thread does with it.
type Stored struct {
	ID, ThreadID, From, FromName, Subject, Body string
	ReplyTo                                     string
	// PermissionID is the permission request the mail carries (src/permissions.ts requestPermission); "" for none.
	PermissionID                   string
	AutoThreaded, Notice, FromStam bool
	Note, Override                 string
	To, Quiet                      []string
	Files                          []MailFile
	// An ITSA's mail (itsa.post): the ITSA it comments on, its kind (comment, update or ask) and an update's health;
	// AboutItsa is the ITSA the sender named. LinkText is the subject and the whole body, which name the ITSAs it links to.
	ItsaID, AboutItsa, Kind, Health, LinkText string
	// What the daemon decided about the human's copy of the thread (src/mail.ts storeMail): the human's reply defers it
	// (DeferThread) or answers its decisions; a mail to the human brings a deferred ask back (ToHuman) and is itself a
	// decision (DecisionMail).
	FromHuman, DeferThread, ToHuman, DecisionMail bool
	// ForeignSender marks a forwarded mail whose sender the peer that sent it can't be shown to hold (S-4332): it clears
	// no wait_for on that agent.
	ForeignSender bool
	// CopyTo is the sender's copy of a mail that went to a peer (S-241, S-2663): the agents it was sent to there. nil for none.
	CopyTo []string
	// InTx, when set, runs first in the transaction that stores a new mail, with the mail's id; an error rolls the mail
	// back. A caller whose mail must commit with another write (a delivery and its removal from a queue) makes it here.
	InTx func(conn *sqlite.Conn, mailID string) error
}

// StoreMail writes a mail as src/mail.ts storeMail does for a mail not stored before, and returns it as the send's
// answer: the mail row the sender gets back. Everything is one transaction.
func (d *DB) StoreMail(ctx context.Context, m Stored) (jsfmt.Value, error) {
	v, _, _, err := d.storeMail(ctx, m, false)
	return v, err
}

// ErrMailIDTaken is a forwarded mail whose id this daemon keeps for a mail from someone else.
var ErrMailIDTaken = errors.New("the mail id is taken by another sender's mail")

// StoreForwarded is src/mail.ts storeMail for a peer's forwarded mail: the same mail arriving again (an outbox retry, or
// more recipients under its original id) only adds the recipients it doesn't have yet, in the same write as the check,
// and only they are notified. It returns the mail, the recipients this arrival added, and whether the mail was here
// already. An id that names another sender's mail is ErrMailIDTaken.
func (d *DB) StoreForwarded(ctx context.Context, m Stored) (jsfmt.Value, []string, bool, error) {
	return d.storeMail(ctx, m, true)
}

func (d *DB) storeMail(ctx context.Context, m Stored, merge bool) (jsfmt.Value, []string, bool, error) {
	created := now()
	var added []string
	merged := false
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		if merge {
			have, err := rows(conn, "SELECT from_id FROM mail WHERE id = ?", m.ID)
			if err != nil {
				return err
			}
			if len(have) > 0 {
				merged = true
				if have[0].Text("from_id") != m.From {
					return ErrMailIDTaken
				}
				quiet := map[string]bool{}
				for _, q := range m.Quiet {
					quiet[q] = true
				}
				for _, a := range m.To {
					q := 0
					if quiet[a] {
						q = 1
					}
					if err := runSQL(conn, "INSERT OR IGNORE INTO mail_recipients (mail_id, agent_id, quiet) VALUES (?, ?, ?)", m.ID, a, q); err != nil {
						return err
					}
					if conn.Changes() > 0 {
						added = append(added, a)
					}
				}
				m.To = added
				if err := deferArrivals(conn, m); err != nil {
					return err
				}
				return d.notifyArrivals(conn, m)
			}
		}
		if m.InTx != nil {
			if err := m.InTx(conn, m.ID); err != nil {
				return err
			}
		}
		nul := func(s string) any {
			if s == "" {
				return nil
			}
			return s
		}
		b2i := func(b bool) int {
			if b {
				return 1
			}
			return 0
		}
		var copyTo any
		if m.CopyTo != nil {
			b, err := json.Marshal(m.CopyTo)
			if err != nil {
				return err
			}
			copyTo = string(b)
		}
		if err := runSQL(conn, `INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id, reply_to, permission_id, auto_threaded, notice, itsa_id, kind, health, about_itsa, verdict, override, note, copy_to)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
			m.ID, m.From, m.FromName, m.Subject, m.Body, created, m.ThreadID, nul(m.ReplyTo), nul(m.PermissionID), b2i(m.AutoThreaded), b2i(m.Notice || m.FromStam),
			nul(m.ItsaID), nul(m.Kind), nul(m.Health), nul(aboutOf(m)), nul(m.Override), nul(m.Note), copyTo); err != nil {
			return err
		}
		quiet := map[string]bool{}
		for _, q := range m.Quiet {
			quiet[q] = true
		}
		for _, a := range m.To {
			if err := runSQL(conn, "INSERT OR IGNORE INTO mail_recipients (mail_id, agent_id, quiet) VALUES (?, ?, ?)", m.ID, a, b2i(quiet[a])); err != nil {
				return err
			}
		}
		if err := deferArrivals(conn, m); err != nil {
			return err
		}
		if err := linkMail(conn, m.ID, m.ThreadID, m.LinkText, m.ItsaID, m.AboutItsa); err != nil {
			return err
		}
		for _, f := range m.Files {
			if err := runSQL(conn, "INSERT INTO attachments (mail_id, name, path, size) VALUES (?, ?, ?, ?)", m.ID, f.Name, f.Path, f.Size); err != nil {
				return err
			}
		}
		// A decision mail waits on the human until they reply in its thread (src/decision-mail.ts).
		switch {
		case m.FromHuman && m.DeferThread:
			// One deferred event per decision a deferral leaves open; a thread already deferred records none (src/db.ts setThreadDeferred).
			deferred, err := textColumn(conn, "SELECT 1 FROM thread_deferred WHERE thread_id = ?", m.ThreadID)
			if err != nil {
				return err
			}
			if len(deferred) == 0 {
				open, err := textColumn(conn, "SELECT mail_id FROM decision_mails WHERE thread_id = ?", m.ThreadID)
				if err != nil {
					return err
				}
				settledDecisions(conn, open, "deferred", nil)
			}
			if err := runSQL(conn, "INSERT OR REPLACE INTO thread_deferred (thread_id, mail_id) VALUES (?, ?)", m.ThreadID, m.ID); err != nil {
				return err
			}
		case m.FromHuman:
			if err := runSQL(conn, "DELETE FROM thread_deferred WHERE thread_id = ?", m.ThreadID); err != nil {
				return err
			}
			if err := deleteDecisions(conn, "answered", ChosenOption(m.Body), "DELETE FROM decision_mails WHERE thread_id = ?", m.ThreadID); err != nil {
				return err
			}
		default:
			if m.ToHuman {
				if err := runSQL(conn, "DELETE FROM thread_deferred WHERE thread_id = ?", m.ThreadID); err != nil {
					return err
				}
			}
			if m.DecisionMail {
				if err := runSQL(conn, "INSERT OR IGNORE INTO decision_mails (mail_id, thread_id) VALUES (?, ?)", m.ID, m.ThreadID); err != nil {
					return err
				}
			}
		}
		return d.notifyArrivals(conn, m)
	})
	if errors.Is(err, ErrMailIDTaken) {
		return jsfmt.Value{}, nil, true, err
	}
	if err != nil {
		return jsfmt.Value{}, nil, false, wrap("store mail", err)
	}
	if merged {
		v, _, err := d.GetMail(ctx, m.ID)
		return v, added, true, err
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("id", jsfmt.StringValue(m.ID))
	out.Set("from_id", jsfmt.StringValue(m.From))
	out.Set("subject", jsfmt.StringValue(m.Subject))
	out.Set("body", jsfmt.StringValue(m.Body))
	out.Set("created_at", jsfmt.StringValue(created))
	files := []jsfmt.Value{}
	for _, f := range m.Files {
		fv := jsfmt.Value{Kind: jsfmt.Object}
		fv.Set("name", jsfmt.StringValue(f.Name))
		fv.Set("path", jsfmt.StringValue(f.Path))
		fv.Set("size", jsfmt.IntValue(f.Size))
		files = append(files, fv)
	}
	out.Set("attachments", jsfmt.ArrayValue(files))
	out.Set("thread_id", jsfmt.StringValue(m.ThreadID))
	if m.ReplyTo == "" {
		out.Set("reply_to", jsfmt.NullValue())
	} else {
		out.Set("reply_to", jsfmt.StringValue(m.ReplyTo))
	}
	if m.PermissionID == "" {
		out.Set("permission_id", jsfmt.NullValue())
	} else {
		out.Set("permission_id", jsfmt.StringValue(m.PermissionID))
	}
	auto := int64(0)
	if m.AutoThreaded {
		auto = 1
	}
	out.Set("auto_threaded", jsfmt.IntValue(auto))
	orNull := func(v string) jsfmt.Value {
		if v == "" {
			return jsfmt.NullValue()
		}
		return jsfmt.StringValue(v)
	}
	out.Set("itsa_id", orNull(m.ItsaID))
	out.Set("about_itsa", orNull(aboutOf(m)))
	out.Set("kind", orNull(m.Kind))
	out.Set("health", orNull(m.Health))
	out.Set("verdict", jsfmt.NullValue())
	if m.Override == "" {
		out.Set("override", jsfmt.NullValue())
	} else {
		out.Set("override", jsfmt.StringValue(m.Override))
	}
	return out, m.To, false, nil
}

// aboutOf is m.about_itsa ?? m.itsa_id (src/db.ts createMail): an ITSA's comment is about its ITSA.
func aboutOf(m Stored) string {
	if m.AboutItsa != "" {
		return m.AboutItsa
	}
	return m.ItsaID
}

// addEvent is src/db.ts addEvent; data is stringified as JSON.stringify does.
func addEvent(conn *sqlite.Conn, agentID, typ string, data *jsfmt.Value) error {
	var payload any
	if data != nil {
		payload = jsfmt.Compact(*data)
	}
	return runSQL(conn, "INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, ?)", agentID, now(), typ, payload)
}

var waitRank = []string{"human", "agent", "children", "job", "timer", "event"}

func rankOf(kind string) int {
	for i, k := range waitRank {
		if k == kind {
			return i
		}
	}
	return len(waitRank) // indexOf -1 -> (-1 + n + 1) % (n + 1) == n
}

// clearDeclaredWaits is src/mail.ts clearDeclaredWaits: a wait declared with wait_for clears itself when the awaited mail
// arrives: for an agent wait, mail from that agent to this one; for a human wait, mail from the user. A wait that names a
// thread clears only for mail in that thread. Then the agent's waiting state follows its waits (src/db.ts syncWaits,
// with only its live-stream observer).
// deferArrivals is new mail in a thread an agent deferred: it brings the whole thread back, and a system notice joins it
// deferred.
func deferArrivals(conn *sqlite.Conn, m Stored) error {
	notice := m.Notice || m.FromStam || strings.HasPrefix(m.From, "system:")
	for _, a := range m.To {
		if a == "human" || a == m.From {
			continue
		}
		if notice {
			err := runSQL(conn, "INSERT OR IGNORE INTO thread_defer_mail (mailbox_id, thread_id, mail_id) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM thread_defer WHERE mailbox_id = ? AND thread_id = ?)", a, m.ThreadID, m.ID, a, m.ThreadID)
			if err != nil {
				return err
			}
		} else {
			if err := runSQL(conn, "DELETE FROM thread_defer WHERE mailbox_id = ? AND thread_id = ?", a, m.ThreadID); err != nil {
				return err
			}
			if err := runSQL(conn, "DELETE FROM thread_defer_mail WHERE mailbox_id = ? AND thread_id = ?", a, m.ThreadID); err != nil {
				return err
			}
		}
	}
	return nil
}

// notifyArrivals is src/mail.ts notify: the agents that got the mail log it, and a declared wait it answers clears.
func (d *DB) notifyArrivals(conn *sqlite.Conn, m Stored) error {
	for _, r := range m.To {
		if r == "human" {
			continue
		}
		ev := jsfmt.Value{Kind: jsfmt.Object}
		ev.Set("id", jsfmt.StringValue(m.ID))
		ev.Set("from", jsfmt.StringValue(m.From))
		ev.Set("subject", jsfmt.StringValue(m.Subject))
		if err := addEvent(conn, r, "mail:received", &ev); err != nil {
			return err
		}
	}
	if !m.FromStam {
		return d.clearDeclaredWaits(conn, m)
	}
	return nil
}

func (d *DB) clearDeclaredWaits(conn *sqlite.Conn, m Stored) error {
	for _, r := range m.To {
		if r == "human" {
			continue
		}
		waits, err := rows(conn, "SELECT * FROM waits WHERE agent_id = ? AND source = 'declared' ORDER BY since, rowid", r)
		if err != nil {
			return err
		}
		cleared := false
		for _, w := range waits {
			kind, target := w.Text("kind"), w.Text("target")
			if !(kind == "agent" && target == m.From && !m.ForeignSender) && !(kind == "human" && m.From == "human") {
				continue
			}
			if raw := w.Text("data"); raw != "" {
				if data, err := jsfmt.Parse([]byte(raw)); err == nil && data.Kind == jsfmt.Object {
					if th, ok := data.Get("thread"); ok && th.Truthy() {
						name := th.Str
						if th.Kind != jsfmt.String {
							name = jsfmt.Compact(th)
						}
						want := name
						found, err := rows(conn, "SELECT thread_id FROM mail WHERE id = ?", name)
						if err != nil {
							return err
						}
						if len(found) > 0 {
							if t := found[0].Text("thread_id"); t != "" {
								want = t
							}
						}
						if m.ID != name && m.ThreadID != want {
							continue
						}
					}
				}
			}
			if err := runSQL(conn, "DELETE FROM waits WHERE id = ?", w.Text("id")); err != nil {
				return err
			}
			cleared = true
		}
		if cleared {
			if err := d.syncWaits(conn, r); err != nil {
				return err
			}
		}
	}
	return nil
}

// syncWaits is src/db.ts syncWaits: the agent's activity follows its waits. An idle agent with waits turns waiting, a
// waiting one with none turns idle, and a waiting one shows what it waits for; any other activity keeps its own, and its
// waits count once it goes idle. Not ported: the resting agent's observer (B2b).
func (d *DB) syncWaits(conn *sqlite.Conn, agentID string) error {
	a, err := rows(conn, "SELECT activity, activity_detail, lifecycle, paused_by FROM agents WHERE id = ?", agentID)
	if err != nil || len(a) == 0 {
		return err
	}
	waits, err := rows(conn, "SELECT * FROM waits WHERE agent_id = ? ORDER BY since, rowid", agentID)
	if err != nil {
		return err
	}
	// A resting agent's activity doesn't follow its waits, yet whether it has any decides whether it counts as busy:
	// the org observer recounts the children waits above it, as for an activity change.
	if restOwnedRow(a[0].Text("lifecycle"), a[0].Text("paused_by")) {
		d.noteActivity(ActivityChange{Kind: "resting-waits", ID: agentID})
	}
	activity := a[0].Text("activity")
	var detail *string
	if v, _ := a[0].Get("activity_detail"); v.Kind == jsfmt.String {
		detail = &v.Str
	}
	switch {
	case activity == "waiting" && len(waits) == 0:
		return d.updateAgent(conn, agentID, []Field{{"activity", "idle"}, {"activity_detail", "waits cleared"}})
	case activity == "idle" && len(waits) > 0:
		// updateAgent turns an idle agent with waits waiting, with the summary as its detail.
		return d.updateAgent(conn, agentID, []Field{{"activity", "idle"}, {"activity_detail", detail}})
	case activity == "waiting":
		sort.SliceStable(waits, func(i, j int) bool { return rankOf(waits[i].Text("kind")) < rankOf(waits[j].Text("kind")) })
		if summary := waitSummary(conn, waits); detail == nil || *detail != summary {
			return d.updateAgent(conn, agentID, []Field{{"activity_detail", summary}})
		}
	}
	return nil
}

// waitSummary is src/db.ts waitSummary: the activity_detail of a waiting agent.
func waitSummary(conn *sqlite.Conn, waits []jsfmt.Value) string {
	w := waits[0]
	what := w.Text("detail")
	if d, _ := w.Get("detail"); d.Kind == jsfmt.Null {
		switch {
		case w.Text("kind") == "agent" && w.Text("target") != "":
			what = agentName(conn, w.Text("target")) + "'s reply"
		case w.Text("target") != "":
			what = w.Text("kind") + " " + w.Text("target")
		default:
			what = w.Text("kind")
		}
	}
	more := ""
	if len(waits) > 1 {
		more = " (+" + itoa(len(waits)-1) + " more)"
	}
	return "waiting for " + what + more
}

func itoa(n int) string { return jsfmt.Compact(jsfmt.IntValue(int64(n))) }

// GetMail is the mail row of an id (src/db.ts getMail): every column of the table, false for no such mail.
func (d *DB) GetMail(ctx context.Context, id string) (jsfmt.Value, bool, error) {
	var found []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		found, err = rows(conn, "SELECT * FROM mail WHERE id = ?", id)
		return err
	})
	if len(found) == 0 {
		return jsfmt.Value{}, false, wrap("get mail", err)
	}
	return found[0], true, wrap("get mail", err)
}

// LastReadSince is the latest read_at of any mail to the agent after since, "" when none.
func (d *DB) LastReadSince(ctx context.Context, agentID, since string) (string, error) {
	at := ""
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT MAX(read_at) FROM mail_recipients WHERE agent_id = ? AND read_at > ?",
			&sqlitex.ExecOptions{Args: []any{agentID, since}, ResultFunc: func(stmt *sqlite.Stmt) error { at = stmt.ColumnText(0); return nil }})
	})
	return at, wrap("last read", err)
}

// MailFrom is the mail an agent received from any of from since a time, newest read first, each with `answered` (the
// agent wrote in that thread after it) and the thread's first subject (src/db.ts mailFrom).
func (d *DB) MailFrom(ctx context.Context, agentID string, from []string, since string) ([]jsfmt.Value, error) {
	if len(from) == 0 {
		return nil, nil
	}
	marks := strings.TrimSuffix(strings.Repeat("?, ", len(from)), ", ")
	args := []any{agentID, agentID, since}
	for _, f := range from {
		args = append(args, f)
	}
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = rows(conn, `SELECT m.*, r.read_at,
			EXISTS (SELECT 1 FROM mail x WHERE x.thread_id = m.thread_id AND x.from_id = ? AND x.created_at > m.created_at) AS answered,
			(SELECT y.subject FROM mail y WHERE y.thread_id = m.thread_id ORDER BY y.created_at LIMIT 1) AS root_subject
			FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
			WHERE r.agent_id = ? AND m.created_at > ? AND m.from_id IN (`+marks+`)
			ORDER BY COALESCE(r.read_at, m.created_at) DESC`, args...)
		return err
	})
	return out, wrap("mail from", err)
}

// LastSenderName is the name an agent last sent mail under, "" when it never did.
func (d *DB) LastSenderName(ctx context.Context, id string) (string, error) {
	name := ""
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT from_name FROM mail WHERE from_id = ? AND from_name IS NOT NULL ORDER BY created_at DESC LIMIT 1",
			&sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error { name = stmt.ColumnText(0); return nil }})
	})
	return name, wrap("last sender", err)
}

// ParentsOf is every parent of an agent: the one that spawned it plus any that adopted it (src/db.ts parentsOf).
func (d *DB) ParentsOf(ctx context.Context, a Agent) ([]string, error) {
	var out []string
	if a.ParentID != nil {
		out = append(out, *a.ParentID)
	}
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT parent_id FROM agent_parents WHERE child_id = ?", &sqlitex.ExecOptions{Args: []any{a.ID}, ResultFunc: func(stmt *sqlite.Stmt) error {
			p := stmt.ColumnText(0)
			for _, have := range out {
				if have == p {
					return nil
				}
			}
			out = append(out, p)
			return nil
		}})
	})
	return out, wrap("parents", err)
}

// ForwardTarget is where mail to the agent goes: itself, or the last successor in its cost_switch chain.
func (d *DB) ForwardTarget(ctx context.Context, id string) (string, error) {
	seen := map[string]bool{}
	cur, err := d.GetAgent(ctx, id)
	if err != nil {
		if err == ErrNotFound {
			return id, nil
		}
		return "", err
	}
	for cur.ForwardedTo != nil && !seen[cur.ID] {
		seen[cur.ID] = true
		next, err := d.GetAgent(ctx, *cur.ForwardedTo)
		if err != nil || next.Lifecycle == "archived" {
			break
		}
		cur = next
	}
	return cur.ID, nil
}

// ArchiveHumanThread and the two below are the daemon's handling of a thread the human writes in (src/daemon.ts, POST
// /api/mail): a thread the human starts waits in the archive until an answer comes; the human's follow-ups stay archived.
func (d *DB) ArchiveHumanThread(ctx context.Context, threadID, mailID string) error {
	return wrap("archive thread", d.Write(ctx, func(conn *sqlite.Conn) error {
		for _, q := range []string{
			"DELETE FROM thread_defer WHERE mailbox_id = 'human' AND thread_id = ?",
			"DELETE FROM thread_defer_mail WHERE mailbox_id = 'human' AND thread_id = ?",
			"INSERT OR REPLACE INTO thread_archive (mailbox_id, thread_id) VALUES ('human', ?)",
			"DELETE FROM thread_archive_mail WHERE mailbox_id = 'human' AND thread_id = ?",
		} {
			if err := runSQL(conn, q, threadID); err != nil {
				return err
			}
		}
		return runSQL(conn, "INSERT OR IGNORE INTO thread_archive_mail (mailbox_id, thread_id, mail_id) VALUES ('human', ?, ?)", threadID, mailID)
	}))
}

// KeepHumanThread keeps the human's own mail in a thread it archived or deferred out of sight (keepArchived, keepDeferred).
func (d *DB) KeepHumanThread(ctx context.Context, threadID, mailID string) error {
	return wrap("keep thread", d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, "INSERT OR IGNORE INTO thread_archive_mail (mailbox_id, thread_id, mail_id) SELECT 'human', ?, ? WHERE EXISTS (SELECT 1 FROM thread_archive WHERE mailbox_id = 'human' AND thread_id = ?)", threadID, mailID, threadID); err != nil {
			return err
		}
		return runSQL(conn, "INSERT OR IGNORE INTO thread_defer_mail (mailbox_id, thread_id, mail_id) SELECT 'human', ?, ? WHERE EXISTS (SELECT 1 FROM thread_defer WHERE mailbox_id = 'human' AND thread_id = ?)", threadID, mailID, threadID)
	}))
}

// ChildrenOf is the agents whose parent is id: spawned by it or adopted (src/db.ts childrenOf).
func (d *DB) ChildrenOf(ctx context.Context, id string) ([]string, error) {
	var out []string
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT id FROM agents WHERE parent_id = ? UNION SELECT child_id AS id FROM agent_parents WHERE parent_id = ?",
			&sqlitex.ExecOptions{Args: []any{id, id}, ResultFunc: func(stmt *sqlite.Stmt) error { out = append(out, stmt.ColumnText(0)); return nil }})
	})
	return out, wrap("children", err)
}

// AddCopyRecipients is src/db.ts addCopyRecipients: the agents a sender's copy was sent to on a peer, added to any already
// recorded (S-2663), each once.
func (d *DB) AddCopyRecipients(ctx context.Context, id string, to []string) error {
	return d.Write(ctx, func(conn *sqlite.Conn) error {
		var have []string
		rows, err := rows(conn, "SELECT copy_to FROM mail WHERE id = ?", id)
		if err != nil {
			return err
		}
		if len(rows) > 0 {
			if v, _ := rows[0].Get("copy_to"); v.Kind == jsfmt.String {
				if err := json.Unmarshal([]byte(v.Str), &have); err != nil {
					return err
				}
			}
		}
		for _, x := range to {
			if !slices.Contains(have, x) {
				have = append(have, x)
			}
		}
		b, err := json.Marshal(have)
		if err != nil {
			return err
		}
		return runSQL(conn, "UPDATE mail SET copy_to = ? WHERE id = ?", string(b), id)
	})
}

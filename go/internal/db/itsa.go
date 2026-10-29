package db

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
)

// The ITSA queries and writes of src/itsa.ts (S-2849, PR 1): the row, its participants, links, events and field values,
// the filtered list, and the create and update transactions. An ITSA is a jsfmt.Value object, because the TS daemon
// answers an ITSA row with every column of the table in column order and the extras after it.

// FindItsa is itsa.find: the ITSA a id or key names.
func (d *DB) FindItsa(ctx context.Context, ref string) (jsfmt.Value, bool, error) {
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = rows(conn, "SELECT * FROM itsas WHERE id = ? OR key = ?", ref, ref)
		return err
	})
	if len(out) == 0 {
		return jsfmt.Value{}, false, wrap("find ITSA", err)
	}
	return out[0], true, wrap("find ITSA", err)
}

func column(conn *sqlite.Conn, query string, args ...any) ([]string, error) {
	var out []string
	err := sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
		out = append(out, stmt.ColumnText(0))
		return nil
	}})
	return out, err
}

// ItsaParticipants is itsa.participants for an id: the agent ids, sorted. A row that left (left_at, S-3015) is not one of them.
func (d *DB) ItsaParticipants(ctx context.Context, id string) ([]string, error) {
	var out []string
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = column(conn, "SELECT agent_id FROM itsa_participants WHERE itsa_id = ? AND left_at IS NULL ORDER BY agent_id", id)
		return err
	})
	return out, wrap("ITSA participants", err)
}

// linkOut is itsa.ts linkOut: a link row with its meta parsed, or null when it is empty, unparsable or not an object.
func linkOut(r jsfmt.Value) jsfmt.Value {
	out := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range []string{"n", "system", "external_id", "url"} {
		v, _ := r.Get(k)
		out.Set(k, v)
	}
	meta := jsfmt.NullValue()
	if raw := r.Text("meta"); raw != "" {
		if v, err := jsfmt.Parse([]byte(raw)); err == nil && v.Truthy() && v.Kind == jsfmt.Object {
			meta = v
		}
	}
	out.Set("meta", meta)
	return out
}

// JoinedNotOwned is the ITSAs the agent takes part in and doesn't own (src/itsa-owners.ts releaseReviewer's rows).
func (d *DB) JoinedNotOwned(ctx context.Context, agentID string) ([]string, error) {
	var out []string
	err := d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		out, err = column(conn, "SELECT p.itsa_id FROM itsa_participants p JOIN itsas i ON i.id = p.itsa_id WHERE p.agent_id = ? AND p.left_at IS NULL AND (i.owner IS NULL OR i.owner <> ?)", agentID, agentID)
		return err
	})
	return out, wrap("joined ITSAs", err)
}

// ItsaLinks is itsa.links for an id, in order of n.
func (d *DB) ItsaLinks(ctx context.Context, id string) ([]jsfmt.Value, error) {
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		found, err := rows(conn, "SELECT n, system, external_id, url, meta FROM itsa_links WHERE itsa_id = ? ORDER BY n", id)
		for _, r := range found {
			out = append(out, linkOut(r))
		}
		return err
	})
	return out, wrap("ITSA links", err)
}

// ItsaEvents is itsa.events for an id: the latest limit events, oldest first.
func (d *DB) ItsaEvents(ctx context.Context, id string, limit int) ([]jsfmt.Value, error) {
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = rows(conn, "SELECT id, ts, actor, type, data FROM itsa_events WHERE itsa_id = ? ORDER BY id DESC LIMIT ?", id, limit)
		return err
	})
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, wrap("ITSA events", err)
}

// ItsaChildren is the rows of an ITSA's direct children, oldest first.
func (d *DB) ItsaChildren(ctx context.Context, id string) ([]jsfmt.Value, error) {
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = rows(conn, "SELECT * FROM itsas WHERE parent_id = ? ORDER BY created_at, rowid", id)
		return err
	})
	return out, wrap("ITSA children", err)
}

// ItsaStatusCounts is the number of an ITSA's direct children in each status (rollupOf groups them by category).
func (d *DB) ItsaStatusCounts(ctx context.Context, id string) (map[string]int, error) {
	out := map[string]int{}
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT status, COUNT(*) FROM itsas WHERE parent_id = ? GROUP BY status", &sqlitex.ExecOptions{Args: []any{id},
			ResultFunc: func(stmt *sqlite.Stmt) error { out[stmt.ColumnText(0)] = stmt.ColumnInt(1); return nil }})
	})
	return out, wrap("ITSA roll-up", err)
}

// ItsaFieldValues is fieldValuesByItsa: the values of one ITSA (id set) or of all, by ITSA id and then field key in
// the fields' order. A value is the JSON it was stored as.
func (d *DB) ItsaFieldValues(ctx context.Context, id string) (map[string]jsfmt.Value, error) {
	var out map[string]jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = fieldValues(conn, id)
		return err
	})
	return out, wrap("ITSA field values", err)
}

// ItsaFilter is itsa.ListFilters with its references resolved to ids.
type ItsaFilter struct {
	// Root lists the roots; Parent lists one ITSA's children (an id).
	Root          bool
	Parent        string
	Subtree       string
	Status        *string
	Statuses      []string
	StatusesGiven bool
	Owner         string
	Participant   string
	Kind          *string
	Text          string
	// Since is a created_at lower bound in created_at's form (server sinceTime).
	Since *string
}

// Both lists order by creation time, then by rowid: two ITSAs made in the same millisecond keep the order they were made in.

// ListItsas is itsa.list: the rows that pass the filter, oldest first, each with its links, the health of the owner's
// latest update, its participants and its field values.
func (d *DB) ListItsas(ctx context.Context, f ItsaFilter) ([]jsfmt.Value, error) {
	var where []string
	var args []any
	if f.Root {
		where = append(where, "parent_id IS NULL")
	}
	if f.Parent != "" {
		where, args = append(where, "parent_id = ?"), append(args, f.Parent)
	}
	if f.Subtree != "" {
		where = append(where, "id IN (WITH RECURSIVE d(id) AS (SELECT id FROM itsas WHERE id = ? UNION ALL SELECT i.id FROM itsas i JOIN d ON i.parent_id = d.id) SELECT id FROM d)")
		args = append(args, f.Subtree)
	}
	if f.Status != nil {
		where, args = append(where, "status = ?"), append(args, *f.Status)
	}
	if f.StatusesGiven {
		where = append(where, "status IN ("+strings.TrimSuffix(strings.Repeat("?, ", len(f.Statuses)), ", ")+")")
		for _, s := range f.Statuses {
			args = append(args, s)
		}
	}
	if f.Owner != "" {
		where, args = append(where, "owner = ?"), append(args, f.Owner)
	}
	if f.Participant != "" {
		where, args = append(where, "id IN (SELECT itsa_id FROM itsa_participants WHERE agent_id = ? AND left_at IS NULL)"), append(args, f.Participant)
	}
	if f.Kind != nil {
		where, args = append(where, "kind = ?"), append(args, *f.Kind)
	}
	if f.Text != "" {
		like := "%" + f.Text + "%"
		where = append(where, "(key LIKE ? OR title LIKE ? OR summary LIKE ? OR body LIKE ?)")
		args = append(args, like, like, like, like)
	}
	if f.Since != nil {
		where, args = append(where, "created_at >= ?"), append(args, *f.Since)
	}
	query := "SELECT * FROM itsas"
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		if out, err = rows(conn, query+" ORDER BY created_at, rowid", args...); err != nil || len(out) == 0 {
			return err
		}
		links := map[string][]jsfmt.Value{}
		found, err := rows(conn, "SELECT itsa_id, n, system, external_id, url, meta FROM itsa_links ORDER BY itsa_id, n")
		if err != nil {
			return err
		}
		for _, l := range found {
			links[l.Text("itsa_id")] = append(links[l.Text("itsa_id")], linkOut(l))
		}
		health := map[string]string{}
		found, err = rows(conn, "SELECT itsa_id, health FROM mail WHERE kind = 'update' AND itsa_id IS NOT NULL AND health IS NOT NULL ORDER BY created_at")
		if err != nil {
			return err
		}
		for _, m := range found {
			health[m.Text("itsa_id")] = m.Text("health")
		}
		people := map[string][]jsfmt.Value{}
		found, err = rows(conn, "SELECT itsa_id, agent_id FROM itsa_participants WHERE left_at IS NULL ORDER BY itsa_id, agent_id")
		if err != nil {
			return err
		}
		for _, p := range found {
			people[p.Text("itsa_id")] = append(people[p.Text("itsa_id")], jsfmt.StringValue(p.Text("agent_id")))
		}
		values, err := fieldValues(conn, "")
		if err != nil {
			return err
		}
		for i := range out {
			id := out[i].Text("id")
			out[i].Set("links", jsfmt.ArrayValue(nonNil(links[id])))
			if h, ok := health[id]; ok {
				out[i].Set("health", jsfmt.StringValue(h))
			} else {
				out[i].Set("health", jsfmt.NullValue())
			}
			out[i].Set("participants", jsfmt.ArrayValue(nonNil(people[id])))
			v, ok := values[id]
			if !ok {
				v = jsfmt.Value{Kind: jsfmt.Object}
			}
			out[i].Set("fields", v)
		}
		return nil
	})
	return out, wrap("list ITSAs", err)
}

func nonNil(v []jsfmt.Value) []jsfmt.Value {
	if v == nil {
		return []jsfmt.Value{}
	}
	return v
}

// fieldValues is ItsaFieldValues on a connection already open.
func fieldValues(conn *sqlite.Conn, id string) (map[string]jsfmt.Value, error) {
	// A value whose field doesn't apply to the ITSA's kind is kept in the database but not read (S-3180).
	query, args := "SELECT v.itsa_id, f.key, f.kinds, i.kind, v.value FROM itsa_field_values v JOIN itsa_fields f ON f.id = v.field_id JOIN itsas i ON i.id = v.itsa_id ORDER BY f.position", []any(nil)
	if id != "" {
		query, args = "SELECT v.itsa_id, f.key, f.kinds, i.kind, v.value FROM itsa_field_values v JOIN itsa_fields f ON f.id = v.field_id JOIN itsas i ON i.id = v.itsa_id WHERE v.itsa_id = ? ORDER BY f.position", []any{id}
	}
	found, err := rows(conn, query, args...)
	if err != nil {
		return nil, err
	}
	out := map[string]jsfmt.Value{}
	for _, r := range found {
		kinds, kerr := parseKinds(r.Text("kinds"))
		if kerr != nil {
			return nil, fmt.Errorf("the kinds of field %s are not JSON", r.Text("key"))
		}
		applies, aerr := FieldApplies(kinds, r.Text("kind"))
		if aerr != nil {
			return nil, fmt.Errorf("the kinds of field %s: %w", r.Text("key"), aerr)
		}
		if !applies {
			continue
		}
		v, perr := jsfmt.Parse([]byte(r.Text("value")))
		if perr != nil {
			return nil, fmt.Errorf("a field value of %s is not JSON", r.Text("itsa_id"))
		}
		obj, ok := out[r.Text("itsa_id")]
		if !ok {
			obj = jsfmt.Value{Kind: jsfmt.Object}
		}
		obj.Set(r.Text("key"), v)
		out[r.Text("itsa_id")] = obj
	}
	return out, nil
}

// ItsaFieldKinds is the kinds of the field with this key or id, and whether there is one (the stage field that closing sets,
// which this daemon cannot itself write: only the TS daemon's closing does, through this check and the process).
func (d *DB) ItsaFieldKinds(ctx context.Context, key string) (jsfmt.Value, bool, error) {
	var kinds jsfmt.Value
	found := false
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		fields, err := rows(conn, "SELECT kinds FROM itsa_fields WHERE id = ? OR key = ? ORDER BY id = ? DESC", key, key, key)
		if err != nil || len(fields) == 0 {
			return err
		}
		found = true
		kinds, err = parseKinds(fields[0].Text("kinds"))
		return err
	})
	return kinds, found, wrap("ITSA field", err)
}

// --- writes ---

// Now is the time in the form the tables store: an ISO string with milliseconds.
func Now() string { return now() }

const idAlphabet = "abcdefghijkmnpqrstuvwxyz23456789"

// newItsaID is itsa.ts newId: `i` and four letters or digits.
func newItsaID() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	id := []byte{'i'}
	for _, x := range b {
		id = append(id, idAlphabet[int(x)%len(idAlphabet)])
	}
	return string(id)
}

// idTries bounds freshItsaID's draws, as short-id.ts ID_TRIES does.
const idTries = 20

// drawItsaID is the draw freshItsaID makes; a test swaps it to force a collision.
var drawItsaID = newItsaID

// freshItsaID is itsa.ts newId: a draw no row of table holds, picked inside the write
// transaction. After idTries draws it fails with a clear error, never a UNIQUE one.
func freshItsaID(conn *sqlite.Conn, prefix, table, what string) (string, error) {
	for i := 0; i < idTries; i++ {
		id := prefix + drawItsaID()[1:]
		taken, err := rows(conn, "SELECT 1 FROM "+table+" WHERE id = ?", id)
		if err != nil {
			return "", err
		}
		if len(taken) == 0 {
			return id, nil
		}
	}
	return "", fmt.Errorf("could not pick a free %s id in %d tries; the id space (%s + 4 characters) is nearly full", what, idTries, prefix)
}

var keySuffix = regexp.MustCompile(`-(\d+)$`)

// nextItsaKey is itsa.ts nextKey: one durable counter, seeded on first use from the keys' numeric suffixes.
func nextItsaKey(conn *sqlite.Conn, prefix string) (string, error) {
	found, err := rows(conn, "SELECT value FROM itsa_counter WHERE name = 'key'")
	if err != nil {
		return "", err
	}
	var cur int64
	if len(found) == 0 {
		keys, err := column(conn, "SELECT key FROM itsas")
		if err != nil {
			return "", err
		}
		for _, k := range keys {
			if m := keySuffix.FindStringSubmatch(k); m != nil {
				if n, _ := strconv.ParseInt(m[1], 10, 64); n > cur {
					cur = n
				}
			}
		}
		if err := runSQL(conn, "INSERT OR REPLACE INTO itsa_counter (name, value) VALUES ('key', ?)", cur); err != nil {
			return "", err
		}
	} else {
		v, _ := found[0].Get("value")
		cur, _ = strconv.ParseInt(v.Num, 10, 64)
	}
	cur++
	if err := runSQL(conn, "UPDATE itsa_counter SET value = ? WHERE name = 'key'", cur); err != nil {
		return "", err
	}
	return prefix + "-" + strconv.FormatInt(cur, 10), nil
}

func addItsaEvent(conn *sqlite.Conn, itsaID, actor, typ string, data *jsfmt.Value) error {
	var d any
	if data != nil {
		d = jsfmt.Compact(*data)
	}
	return runSQL(conn, "INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)", itsaID, now(), actor, typ, d)
}

// setItsaParticipants is itsa.setParticipants: it replaces the members only (a row that left stays as it is, unless the new list
// names it again).
func setItsaParticipants(conn *sqlite.Conn, itsaID string, ids []string) error {
	if err := runSQL(conn, "DELETE FROM itsa_participants WHERE itsa_id = ? AND left_at IS NULL", itsaID); err != nil {
		return err
	}
	for _, a := range ids {
		if err := rejoinItsa(conn, itsaID, a); err != nil {
			return err
		}
	}
	return nil
}

// rejoinItsa is itsa.rejoin: an explicit join (a participants list, an owner taking the ITSA) makes a member again, clearing a soft
// leave. A post does not (EnsureItsaParticipant leaves a row that left alone).
func rejoinItsa(conn *sqlite.Conn, itsaID, who string) error {
	return runSQL(conn, "INSERT INTO itsa_participants (itsa_id, agent_id, left_at) VALUES (?, ?, NULL) ON CONFLICT(itsa_id, agent_id) DO UPDATE SET left_at = NULL", itsaID, who)
}

// NewItsa is a create, resolved: every reference is an id, the status exists, and the checks have passed.
type NewItsa struct {
	KeyPrefix, Title, Status string
	Kind, Summary, Body      *string
	Closed                   bool
	Owner, Parent, ThreadID  string
	By                       string
	Participants             []string
	Links                    []NewLink
	// Fields are the field values by key, validated as a set does; nil when the request carries none.
	Fields *jsfmt.Value
}

// CreateItsa is itsa.create's transaction: the row, its participants and its `created` event, with the next key.
func (d *DB) CreateItsa(ctx context.Context, n NewItsa) (jsfmt.Value, error) {
	var created jsfmt.Value
	t := now()
	// A refused field value is the caller's to read as it is, not a database failure to wrap.
	var refused error
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		id, err := freshItsaID(conn, "i", "itsas", "ITSA")
		if err != nil {
			return err
		}
		key, err := nextItsaKey(conn, n.KeyPrefix)
		if err != nil {
			return err
		}
		opt := func(s *string) any {
			if s == nil {
				return nil
			}
			return *s
		}
		nul := func(s string) any {
			if s == "" {
				return nil
			}
			return s
		}
		var closedAt any
		if n.Closed {
			closedAt = t
		}
		if err := runSQL(conn, `INSERT INTO itsas (id, key, parent_id, kind, title, summary, body, status, owner, thread_id, created_by, created_at, updated_at, closed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, key, nul(n.Parent), opt(n.Kind), n.Title, opt(n.Summary), opt(n.Body), n.Status, nul(n.Owner), nul(n.ThreadID), n.By, t, t, closedAt); err != nil {
			return err
		}
		if err := setItsaParticipants(conn, id, n.Participants); err != nil {
			return err
		}
		for _, l := range n.Links {
			if _, err := insertLink(conn, id, l); err != nil {
				return err
			}
		}
		ev := jsfmt.Value{Kind: jsfmt.Object}
		ev.Set("key", jsfmt.StringValue(key))
		ev.Set("title", jsfmt.StringValue(n.Title))
		ev.Set("status", jsfmt.StringValue(n.Status))
		if err := addItsaEvent(conn, id, n.By, "created", &ev); err != nil {
			return err
		}
		if n.Fields != nil {
			kind := ""
			if n.Kind != nil {
				kind = *n.Kind
			}
			ch, changed, err := applyFieldValues(conn, id, *n.Fields, n.By, kind)
			if err != nil {
				refused = err
				return err
			}
			if changed {
				fe := jsfmt.Value{Kind: jsfmt.Object}
				fe.Set("from", ch.From)
				fe.Set("to", ch.To)
				if err := addItsaEvent(conn, id, n.By, "fields", &fe); err != nil {
					return err
				}
			}
		}
		found, err := rows(conn, "SELECT * FROM itsas WHERE id = ?", id)
		if err != nil || len(found) == 0 {
			return err
		}
		created = found[0]
		return nil
	})
	if refused != nil {
		return jsfmt.Value{}, refused
	}
	return created, wrap("create ITSA", err)
}

// ItsaTx is what an update's plan reads, inside the transaction that writes.
type ItsaTx struct{ conn *sqlite.Conn }

// Find is itsa.find.
func (t ItsaTx) Find(ref string) (jsfmt.Value, bool, error) {
	found, err := rows(t.conn, "SELECT * FROM itsas WHERE id = ? OR key = ?", ref, ref)
	if err != nil || len(found) == 0 {
		return jsfmt.Value{}, false, err
	}
	return found[0], true, nil
}

// Events is itsa.events for an id inside the transaction: the latest limit events, oldest first.
func (t ItsaTx) Events(id string, limit int) ([]jsfmt.Value, error) {
	out, err := rows(t.conn, "SELECT id, ts, actor, type, data FROM itsa_events WHERE itsa_id = ? ORDER BY id DESC LIMIT ?", id, limit)
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, err
}

// Participants is itsa.participants for an id.
func (t ItsaTx) Participants(id string) ([]string, error) {
	return column(t.conn, "SELECT agent_id FROM itsa_participants WHERE itsa_id = ? AND left_at IS NULL ORDER BY agent_id", id)
}

// CommentedSince is itsa.commentedSince: whether `by` left a comment or update in the ITSA's thread since its last status
// change.
func (t ItsaTx) CommentedSince(cur jsfmt.Value, by string) (bool, error) {
	thread := cur.Text("thread_id")
	if thread == "" {
		return false, nil
	}
	since := cur.Text("created_at")
	found, err := column(t.conn, "SELECT ts FROM itsa_events WHERE itsa_id = ? AND type = 'status' ORDER BY id DESC LIMIT 1 OFFSET 0", cur.Text("id"))
	if err != nil {
		return false, err
	}
	if len(found) > 0 {
		since = found[0]
	}
	n, err := rows(t.conn, "SELECT 1 FROM mail WHERE thread_id = ? AND from_id = ? AND kind IN ('comment', 'update') AND created_at >= ? LIMIT 1", thread, by, since)
	return len(n) > 0, err
}

// ItsaCol is one column an update sets.
type ItsaCol struct {
	Name  string
	Value any
}

// ItsaChange is one recorded change: the field, and what it was and became.
type ItsaChange struct {
	Field    string
	From, To jsfmt.Value
}

// ItsaUpdate is what an update's plan decides.
type ItsaUpdate struct {
	Cols []ItsaCol
	// Participants replaces the ITSA's participants when SetParticipants; EnsureParticipant (an owner taking the ITSA) joins one otherwise, clearing a soft leave.
	Participants      []string
	SetParticipants   bool
	EnsureParticipant string
	// LeaveParticipant ends one member's part without removing its row (itsa.leaveParticipant, S-3015).
	LeaveParticipant string
	// Changes are written as events in order, except rank (a board reorder is no activity); Action is the human action that
	// made a status change.
	Changes []ItsaChange
	Action  string
}

// UpdateItsa is itsa.set's transaction: it finds the ITSA, lets plan decide from the row as it is, then writes the
// columns, the participants and an event per change, all or nothing. It returns the row after and the changes.
func (d *DB) UpdateItsa(ctx context.Context, ref, actor string, plan func(tx ItsaTx, cur jsfmt.Value) (ItsaUpdate, error)) (jsfmt.Value, []ItsaChange, error) {
	var after jsfmt.Value
	var changes []ItsaChange
	// An error the plan (or a missing ITSA) answers is the caller's to read as it is, not a database failure to wrap.
	var refused error
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		tx := ItsaTx{conn}
		cur, ok, err := tx.Find(ref)
		if err != nil {
			return err
		}
		if !ok {
			refused = fmt.Errorf("no ITSA %s", ref)
			return refused
		}
		u, err := plan(tx, cur)
		if err != nil {
			refused = err
			return err
		}
		id := cur.Text("id")
		if len(u.Cols) > 0 {
			sets := make([]string, 0, len(u.Cols)+1)
			args := make([]any, 0, len(u.Cols)+2)
			for _, c := range u.Cols {
				sets, args = append(sets, c.Name+" = ?"), append(args, c.Value)
			}
			sets, args = append(sets, "updated_at = ?"), append(args, now(), id)
			if err := runSQL(conn, "UPDATE itsas SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
				return err
			}
		}
		if u.SetParticipants {
			if err := setItsaParticipants(conn, id, u.Participants); err != nil {
				return err
			}
		} else if u.EnsureParticipant != "" {
			if err := rejoinItsa(conn, id, u.EnsureParticipant); err != nil {
				return err
			}
		}
		if u.LeaveParticipant != "" {
			if err := runSQL(conn, "UPDATE itsa_participants SET left_at = ? WHERE itsa_id = ? AND agent_id = ?", now(), id, u.LeaveParticipant); err != nil {
				return err
			}
		}
		for _, c := range u.Changes {
			if c.Field == "rank" {
				continue
			}
			ev := jsfmt.Value{Kind: jsfmt.Object}
			ev.Set("from", c.From)
			ev.Set("to", c.To)
			if err := addItsaEvent(conn, id, actor, c.Field, &ev); err != nil {
				return err
			}
		}
		if u.Action != "" {
			for _, c := range u.Changes {
				if c.Field == "status" {
					ev := jsfmt.Value{Kind: jsfmt.Object}
					ev.Set("id", jsfmt.StringValue(u.Action))
					ev.Set("from", c.From)
					if err := addItsaEvent(conn, id, actor, "action", &ev); err != nil {
						return err
					}
				}
			}
		}
		found, err := rows(conn, "SELECT * FROM itsas WHERE id = ?", id)
		if err != nil || len(found) == 0 {
			return err
		}
		after, changes = found[0], u.Changes
		return nil
	})
	if refused != nil {
		return jsfmt.Value{}, nil, refused
	}
	return after, changes, wrap("update ITSA", err)
}

// PlanItsa runs an update's plan as UpdateItsa does and rolls everything back: it returns the refusals the update would
// make, and writes nothing.
func (d *DB) PlanItsa(ctx context.Context, ref, actor string, plan func(tx ItsaTx, cur jsfmt.Value) (ItsaUpdate, error)) error {
	errDry := errors.New("dry run")
	var refused error
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		tx := ItsaTx{conn}
		cur, ok, err := tx.Find(ref)
		if err != nil {
			return err
		}
		if !ok {
			refused = fmt.Errorf("no ITSA %s", ref)
			return refused
		}
		if _, err := plan(tx, cur); err != nil {
			refused = err
			return err
		}
		return errDry
	})
	if refused != nil {
		return refused
	}
	if errors.Is(err, errDry) {
		return nil
	}
	return wrap("plan ITSA update", err)
}

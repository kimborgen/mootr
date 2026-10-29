package db

import (
	"context"
	"strconv"
	"time"

	"zombiezen.com/go/sqlite"

	"stam/internal/jsfmt"
)

// NoteItsa is itsa.addEvent(id, null, type, data): a line on the ITSA's history that no actor made (the process runner's
// record). A missing ITSA is an error.
func (d *DB) NoteItsa(ctx context.Context, ref, typ string, data jsfmt.Value) error {
	_, err := d.inItsa(ctx, ref, func(conn *sqlite.Conn, x jsfmt.Value) (jsfmt.Value, error) {
		return jsfmt.Value{}, runSQL(conn, "INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, NULL, ?, ?)", x.Text("id"), now(), typ, jsfmt.Compact(data))
	})
	return err
}

// AddItsaEvent is itsa.addEvent(id, actor, type, data): a line on the ITSA's history that actor made. A missing ITSA is
// an error.
func (d *DB) AddItsaEvent(ctx context.Context, ref, actor, typ string, data jsfmt.Value) error {
	_, err := d.inItsa(ctx, ref, func(conn *sqlite.Conn, x jsfmt.Value) (jsfmt.Value, error) {
		return jsfmt.Value{}, runSQL(conn, "INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)", x.Text("id"), now(), actor, typ, jsfmt.Compact(data))
	})
	return err
}

// stageOf is the ITSA's `stage` field value, "" when it is unset or not a string.
func stageOf(conn *sqlite.Conn, id string) (string, error) {
	vals, err := fieldValues(conn, id)
	if err != nil {
		return "", err
	}
	if obj, ok := vals[id]; ok {
		if v, ok := obj.Get("stage"); ok && v.Kind == jsfmt.String {
			return v.Str, nil
		}
	}
	return "", nil
}

// Stage is the ITSA's `stage` field value, "" when it is unset or not a string.
func (t ItsaTx) Stage(id string) (string, error) { return stageOf(t.conn, id) }

// ItsaStage is Stage outside a transaction.
func (d *DB) ItsaStage(ctx context.Context, id string) (string, error) {
	var out string
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = stageOf(conn, id)
		return err
	})
	return out, wrap("ITSA stage", err)
}

// closedStageDone is the name the one-off closed-stage backfill is recorded under in `migrations`.
const closedStageDone = "closed-stage-done"

// BackfillClosedStage is src/itsa.ts backfillClosedStage (S-1398): every closed ITSA whose stage is set and isn't its process's
// end node gets the end node. It writes directly: no guard, no listener, no event, no mail. It runs once (recorded in
// `migrations`) and returns the count, or ok false when it already ran. With no `stage` field it does nothing and is not
// recorded, so a later start can run it. (TS's comment says the same of "no end node known", but its code records the run.)
func (d *DB) BackfillClosedStage(ctx context.Context, endNodeOf func(kind string) string, kinds []string, isClosed func(status string) bool) (n int, ok bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		// A database made by TS always has the table; one made here for a test may not.
		have, err := rows(conn, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
		if err != nil || len(have) == 0 {
			return err
		}
		done, err := rows(conn, "SELECT 1 AS x FROM migrations WHERE name = ?", closedStageDone)
		if err != nil || len(done) > 0 {
			return err
		}
		fields, err := rows(conn, "SELECT id, kinds FROM itsa_fields WHERE id = ? OR key = ?", "stage", "stage")
		if err != nil || len(fields) == 0 {
			return err
		}
		fieldID := fields[0].Text("id")
		stageKinds, err := parseKinds(fields[0].Text("kinds"))
		if err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, kind := range kinds {
			if seen[kind] {
				continue
			}
			seen[kind] = true
			end := endNodeOf(kind)
			if end == "" {
				continue
			}
			applies, err := FieldApplies(stageKinds, kind)
			if err != nil {
				return err
			}
			if !applies {
				continue
			}
			// `kind = ?` as TS's `kind IS ?` with a string: a kind the process lists matches exactly, and an ITSA with no kind (NULL) is
			// never matched, whatever the list holds.
			found, err := rows(conn, "SELECT i.id, i.status, v.value FROM itsas i JOIN itsa_field_values v ON v.itsa_id = i.id AND v.field_id = ? WHERE i.kind = ?", fieldID, kind)
			if err != nil {
				return err
			}
			for _, r := range found {
				if !isClosed(r.Text("status")) {
					continue
				}
				if cur, perr := jsfmt.Parse([]byte(r.Text("value"))); perr == nil && cur.Kind == jsfmt.String && cur.Str == end {
					continue
				}
				t := now()
				if err := runSQL(conn, "UPDATE itsa_field_values SET value = ?, updated_by = ?, updated_at = ? WHERE itsa_id = ? AND field_id = ?", jsfmt.Compact(jsfmt.StringValue(end)), "system:migration", t, r.Text("id"), fieldID); err != nil {
					return err
				}
				if err := runSQL(conn, "UPDATE itsas SET updated_at = ? WHERE id = ?", t, r.Text("id")); err != nil {
					return err
				}
				n++
			}
		}
		ok = true
		return runSQL(conn, "INSERT INTO migrations (name, done_at) VALUES (?, ?)", closedStageDone, now())
	})
	return n, ok, wrap("closed stage backfill", err)
}

// ProcessEntry is src/daemon.ts entryOf: the id of the ITSA's latest `fields` event, "0" for none. A stage change writes it, so it
// names the entry the runner is acting on (until the next change).
func (d *DB) ProcessEntry(ctx context.Context, itsaID string) (string, error) {
	var out string
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		r, err := rows(conn, "SELECT MAX(id) AS n FROM itsa_events WHERE itsa_id = ? AND type = 'fields'", itsaID)
		if err != nil {
			return err
		}
		out = "0"
		if len(r) > 0 {
			if v, ok := r[0].Get("n"); ok && v.Kind == jsfmt.Number {
				out = v.Num
			}
		}
		return nil
	})
	return out, wrap("process entry", err)
}

// Claim is the outcome of ClaimProcessAgent.
type Claim int

const (
	// Claimed: the claim is written.
	Claimed Claim = iota
	// AlreadyClaimed: the entry has a claim for the node.
	AlreadyClaimed
	// OverCap: a spawn, and the process spawns of the last hour are at the cap.
	OverCap
	// Busy: a spawn that passed both, and the caller's busy check refused it.
	Busy
)

// ClaimProcessAgent is the agent runner's check and claim (src/daemon.ts claimed, spawnsLastHour and claim) in one transaction, so
// two entries can't both pass the same check: a claim for the entry and node already there refuses it; a spawn over the cap of
// process spawns in the last hour (a mail is not counted) refuses it; else the `process-spawn` or `process-mail` event is written,
// with no actor. A spawn's claim counts toward the cap from here on. busy, when given, is asked of a spawn after those two checks and
// before the claim, in the same transaction: true refuses it. It is given how many agents of `machine` are working, counted on the
// transaction's own connection, so the count and the claim can't be split by another entry.
func (d *DB) ClaimProcessAgent(ctx context.Context, itsaID, kind, node, entry, text string, cap int, machine string, busy func(working int) bool) (Claim, error) {
	out := Claimed
	typ := "process-mail"
	if kind == "spawn" {
		typ = "process-spawn"
	}
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		taken, err := rows(conn, "SELECT 1 AS x FROM itsa_events WHERE itsa_id = ? AND type IN ('process-spawn', 'process-mail') AND json_extract(data, '$.node') = ? AND json_extract(data, '$.entry') = ?", itsaID, node, entry)
		if err != nil {
			return err
		}
		if len(taken) > 0 {
			out = AlreadyClaimed
			return nil
		}
		if kind == "spawn" {
			since := time.Now().Add(-time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
			n, err := rows(conn, "SELECT COUNT(*) AS n FROM itsa_events WHERE type = 'process-spawn' AND ts > ?", since)
			if err != nil {
				return err
			}
			if c, _ := n[0].Get("n"); c.Kind == jsfmt.Number && atoiNum(c.Num) >= cap {
				out = OverCap
				return nil
			}
		}
		if kind == "spawn" && busy != nil {
			w, err := rows(conn, "SELECT COUNT(*) AS n FROM agents WHERE machine = ? AND lifecycle = 'active' AND activity = 'working'", machine)
			if err != nil {
				return err
			}
			c, _ := w[0].Get("n")
			if busy(atoiNum(c.Num)) {
				out = Busy
				return nil
			}
		}
		data := jsfmt.Value{Kind: jsfmt.Object}
		data.Set("node", jsfmt.StringValue(node))
		data.Set("entry", jsfmt.StringValue(entry))
		data.Set("text", jsfmt.StringValue(text))
		return runSQL(conn, "INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, NULL, ?, ?)", itsaID, now(), typ, jsfmt.Compact(data))
	})
	return out, wrap("claim process agent", err)
}

func atoiNum(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

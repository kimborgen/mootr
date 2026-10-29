package db

import (
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"zombiezen.com/go/sqlite"
)

// The comms events of src/db.ts (S-3828): one row per decision mail that stopped waiting on the human, with its outcome, which
// the Needs you list reads for the decisions settled in the last day (src/asks.ts). The waits and escalations TS records here
// too are not yet (the usage module, with GET /api/stats/comms).

// recordComms is src/db.ts recordCommsEvent in the caller's transaction. Never fails: recording must not change what it records.
// duration_ms is the time since startedAt, null when that is unknown or later than now.
func recordComms(conn *sqlite.Conn, kind, ref, outcome, startedAt string, label any) {
	at := now()
	var ms any
	if t0, err := time.Parse(time.RFC3339Nano, startedAt); err == nil {
		if t1, err := time.Parse(time.RFC3339Nano, at); err == nil && !t1.Before(t0) {
			ms = t1.Sub(t0).Milliseconds()
		}
	}
	_ = runSQL(conn, "INSERT INTO comms_events (kind, ref, outcome, label, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)", kind, ref, outcome, label, ms, at)
}

// settledDecisions is src/db.ts settledDecisions: a decision event for each mail id, timed from the mail's own created_at.
func settledDecisions(conn *sqlite.Conn, ids []string, outcome string, label any) {
	for _, id := range ids {
		started, _ := textColumn(conn, "SELECT created_at FROM mail WHERE id = ?", id)
		at := ""
		if len(started) > 0 {
			at = started[0]
		}
		recordComms(conn, "decision", id, outcome, at, label)
	}
}

// deleteDecisions runs a DELETE FROM decision_mails ... RETURNING mail_id and records each mail it removed with the outcome.
func deleteDecisions(conn *sqlite.Conn, outcome string, label any, query string, args ...any) error {
	ids, err := textColumn(conn, query+" RETURNING mail_id", args...)
	if err != nil {
		return err
	}
	settledDecisions(conn, ids, outcome, label)
	return nil
}

// chose is src/mail.ts CHOSE on one line: the standard form a decision reply names its option in.
var chose = regexp.MustCompile(`^Chose \*\*([^*]+)\*\*\.$`)

// ChosenOption is src/mail.ts chosenOption: the option a decision reply names in `Chose **X**.` (1 to 80 UTF-16 units), else
// nil. Any other reply, several choices, or more than one such line records no label. Each line is matched alone, split where
// JS's multiline ^ and $ break (\n, \r, U+2028, U+2029), so a CRLF reply matches as in TS; an option holding a lone \r, which
// JS's [^*\n] would take, doesn't.
func ChosenOption(body string) any {
	var found []string
	for _, line := range strings.FieldsFunc(body, func(r rune) bool { return r == '\n' || r == '\r' || r == 0x2028 || r == 0x2029 }) {
		if m := chose.FindStringSubmatch(line); m != nil {
			if n := len(utf16.Encode([]rune(m[1]))); n <= 80 {
				found = append(found, m[1])
			}
		}
	}
	if len(found) != 1 {
		return nil
	}
	return found[0]
}

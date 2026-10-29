package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	"stam/internal/db"
	"stam/internal/jsfmt"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// textChanged is src/itsa.ts TEXT_CHANGED: an Approve whose text changed since it was shown (S-2998).
const textChanged = "the text changed, review again"

// revOf is src/itsa.ts revOf: the revision of an ITSA's text as the human is shown it, a sha256 over its title, summary
// and body, each prefixed with its length in UTF-8 bytes (a null counts as empty), cut to 16 hex digits. Approve
// carries it back as if_rev, and a change since refuses it.
func revOf(x jsfmt.Value) string {
	parts := make([]string, 0, 3)
	for _, k := range []string{"title", "summary", "body"} {
		f := x.Text(k)
		parts = append(parts, strconv.Itoa(len(f))+":"+f)
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])[:16]
}

// actBeforeSet runs in act between its revision check and the status move; tests set it to change the text there.
var actBeforeSet func()

// recordShownRev is the record src/itsa.ts post keeps for an ask: the revision of the ITSA's text the mail went out with,
// and where the body holds that text (shownAt).
func (s *Server) recordShownRev(ctx context.Context, mailID, itsaID, rev, body, text string) error {
	return s.db.Write(ctx, func(conn *sqlite.Conn) error {
		if err := db.EnsureShownRevs(conn); err != nil {
			return err
		}
		var at, n any
		if a, ok := shownAt(body, text); ok {
			at, n = a, utf16Len(text)
		}
		return sqlitex.Execute(conn, "INSERT OR REPLACE INTO itsa_shown_revs (mail_id, itsa_id, rev, at, len) VALUES (?, ?, ?, ?, ?)", &sqlitex.ExecOptions{Args: []any{mailID, itsaID, rev, at, n}})
	})
}

// shownAt is src/itsa.ts shownAt: where the body holds the snapshot, in UTF-16 units as the web cuts it, when it leads
// the body (an ask) or ends it (a re-show).
func shownAt(body, text string) (int, bool) {
	switch {
	case text == "":
		return 0, false
	case strings.HasPrefix(body, text):
		return 0, true
	case strings.HasSuffix(body, text):
		return utf16Len(body) - utf16Len(text), true
	}
	return 0, false
}

// shownRev is src/itsa.ts shownRev: the revision recorded on the newest mail of the ITSA's thread at or before mailID, or
// "" (a mail not in its thread, or one sent before any was recorded).
func (s *Server) shownRev(ctx context.Context, itsaID, mailID string) (string, error) {
	rev := ""
	err := s.db.Read(ctx, func(conn *sqlite.Conn) error {
		exists := false
		if err := sqlitex.Execute(conn, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'itsa_shown_revs'", &sqlitex.ExecOptions{ResultFunc: func(*sqlite.Stmt) error { exists = true; return nil }}); err != nil || !exists {
			return err
		}
		return sqlitex.Execute(conn, `SELECT s.rev FROM itsa_shown_revs s JOIN mail m ON m.id = s.mail_id
    JOIN mail seen ON seen.id = ? JOIN itsas x ON x.id = s.itsa_id AND seen.thread_id = x.thread_id
    WHERE s.itsa_id = ? AND (m.created_at < seen.created_at OR (m.created_at = seen.created_at AND m.rowid <= seen.rowid))
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`, &sqlitex.ExecOptions{Args: []any{mailID, itsaID}, ResultFunc: func(stmt *sqlite.Stmt) error {
			rev = stmt.ColumnText(0)
			return nil
		}})
	})
	return rev, err
}

// escHTML is itsa-human.ts escHtml: the title and summary, plain text in the ITSA view, escaped so markup in them can't
// hide the rest of the snapshot.
var escHTML = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace

// askTextMax is itsa-human.ts ASK_TEXT_MAX: the longest body, in UTF-16 units, a mail shows whole.
const askTextMax = 4000

// shownText is itsa-human.ts shownText: the ITSA's text as a mail shows it (title, summary and body in a <details> block;
// the title and summary escaped),
// and the revision of exactly that snapshot. A body longer than askTextMax is cut, with a line to open the ITSA, and has
// no revision ("").
func shownText(x jsfmt.Value) (text, rev string) {
	body := x.Text("body")
	cut := utf16Len(body) > askTextMax
	if cut {
		body = sliceUnits(body, askTextMax) + "\n\n… Cut here: open " + x.Text("key") + " to review all of it."
	}
	lines := []string{"<details><summary>What you approve: " + x.Text("key") + " " + escHTML(x.Text("title")) + "</summary>", ""}
	n := 0
	for _, s := range []string{escHTML(x.Text("summary")), body} {
		if db.JSTrim(s) != "" {
			lines = append(lines, s, "")
			n++
		}
	}
	if n == 0 {
		lines = append(lines, "(no summary or body)", "")
	}
	text = strings.Join(append(lines, "</details>"), "\n")
	if cut {
		return text, ""
	}
	return text, revOf(x)
}

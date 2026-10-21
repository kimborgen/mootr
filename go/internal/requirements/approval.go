package requirements

// The store side of the approval asks (src/req-approval.ts): the tables that stamp an ask with the revision it showed, the
// all-or-nothing approval of a batch, a drop from a batch, and the texts of an ask. The ITSA each ask lives in is made and
// moved by the daemon (go/internal/server/approval.go).

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// ApprovalKind is the kind of the ITSA an ask lives in.
const ApprovalKind = "requirement-approval"

// approvalTables makes req_approvals and req_batch_asks (the late columns by ALTER, as TS does), once; a failed attempt is
// tried again by the next call.
func (s *Store) approvalTables(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.apprMade {
		return nil
	}
	err := s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		for _, q := range []string{
			"CREATE TABLE IF NOT EXISTS req_approvals (itsa_id TEXT PRIMARY KEY, req_key TEXT NOT NULL, updated_at TEXT NOT NULL)",
			"CREATE TABLE IF NOT EXISTS req_batch_asks (itsa_id TEXT NOT NULL, req_key TEXT NOT NULL, rev INTEGER NOT NULL, via TEXT NOT NULL, PRIMARY KEY (itsa_id, req_key))",
		} {
			if err := sqlitex.ExecuteTransient(conn, q, nil); err != nil {
				return err
			}
		}
		for _, add := range []struct{ table, col, ddl string }{
			{"req_approvals", "rev", "ALTER TABLE req_approvals ADD COLUMN rev INTEGER"},
			{"req_approvals", "via", "ALTER TABLE req_approvals ADD COLUMN via TEXT NOT NULL DEFAULT 'human'"},
			{"req_batch_asks", "dropped", "ALTER TABLE req_batch_asks ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0"},
		} {
			have := false
			if err := sqlitex.ExecuteTransient(conn, "PRAGMA table_info("+add.table+")", &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
				have = have || stmt.ColumnText(1) == add.col
				return nil
			}}); err != nil {
				return err
			}
			if !have {
				if err := sqlitex.ExecuteTransient(conn, add.ddl, nil); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err == nil {
		s.apprMade = true
	}
	return err
}

// Stamp is what an ask showed: the requirement, the revision, and who is asked (`human` or `cos`).
type Stamp struct {
	ReqKey string
	// Rev is nil for an ask from before the revision was recorded: it counts as changed.
	Rev *int64
	Via string
}

// StampOf is the single-draft ask's stamp, nil when the ITSA has none.
func (s *Store) StampOf(ctx context.Context, itsaID string) (*Stamp, error) {
	if err := s.approvalTables(ctx); err != nil {
		return nil, err
	}
	var out *Stamp
	err := s.DB.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT req_key, rev, via FROM req_approvals WHERE itsa_id = ?", &sqlitex.ExecOptions{Args: []any{itsaID}, ResultFunc: func(stmt *sqlite.Stmt) error {
			out = &Stamp{ReqKey: stmt.ColumnText(0), Via: stmt.ColumnText(2)}
			if !stmt.ColumnIsNull(1) {
				r := stmt.ColumnInt64(1)
				out.Rev = &r
			}
			return nil
		}})
	})
	return out, err
}

// SetStamp records the ask's requirement at its revision and updated_at (INSERT OR REPLACE).
func (s *Store) SetStamp(ctx context.Context, itsaID string, r Req, via string) error {
	if err := s.approvalTables(ctx); err != nil {
		return err
	}
	return s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "INSERT OR REPLACE INTO req_approvals (itsa_id, req_key, updated_at, rev, via) VALUES (?, ?, ?, ?, ?)",
			&sqlitex.ExecOptions{Args: []any{itsaID, r.Key(), r.Text("updated_at"), r.Rev(), via}})
	})
}

// Member is a draft in a batch ask.
type Member struct {
	ReqKey  string
	Rev     int64
	Via     string
	Dropped bool
}

// Members are the drafts of a batch ask, in the order they were stamped.
func (s *Store) Members(ctx context.Context, itsaID string) ([]Member, error) {
	if err := s.approvalTables(ctx); err != nil {
		return nil, err
	}
	var out []Member
	err := s.DB.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT req_key, rev, via, dropped FROM req_batch_asks WHERE itsa_id = ? ORDER BY rowid", &sqlitex.ExecOptions{Args: []any{itsaID}, ResultFunc: func(stmt *sqlite.Stmt) error {
			out = append(out, Member{ReqKey: stmt.ColumnText(0), Rev: stmt.ColumnInt64(1), Via: stmt.ColumnText(2), Dropped: stmt.ColumnInt(3) != 0})
			return nil
		}})
	})
	return out, err
}

// StampBatch stamps each draft at its revision. A re-stamp keeps `dropped`: a draft changed in the batch doesn't come back.
func (s *Store) StampBatch(ctx context.Context, itsaID string, rs []Req, via string) error {
	if err := s.approvalTables(ctx); err != nil {
		return err
	}
	return s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		for _, r := range rs {
			if err := sqlitex.Execute(conn, "INSERT INTO req_batch_asks (itsa_id, req_key, rev, via) VALUES (?, ?, ?, ?) ON CONFLICT (itsa_id, req_key) DO UPDATE SET rev = excluded.rev, via = excluded.via",
				&sqlitex.ExecOptions{Args: []any{itsaID, r.Key(), r.Rev(), via}}); err != nil {
				return err
			}
		}
		return nil
	})
}

// AskItsas are the ITSAs that hold an ask for the key, newest first: the single-draft asks, then the batch asks.
func (s *Store) AskItsas(ctx context.Context, key string) (single, batch []string, err error) {
	if err := s.approvalTables(ctx); err != nil {
		return nil, nil, err
	}
	err = s.DB.Read(ctx, func(conn *sqlite.Conn) error {
		for _, t := range []struct {
			table string
			out   *[]string
		}{{"req_approvals", &single}, {"req_batch_asks", &batch}} {
			if err := sqlitex.Execute(conn, "SELECT itsa_id FROM "+t.table+" WHERE req_key = ? ORDER BY rowid DESC", &sqlitex.ExecOptions{Args: []any{key}, ResultFunc: func(stmt *sqlite.Stmt) error {
				*t.out = append(*t.out, stmt.ColumnText(0))
				return nil
			}}); err != nil {
				return err
			}
		}
		return nil
	})
	return single, batch, err
}

// ApproveBatch puts a batch ask's drafts in force: the members that are still drafts and not dropped, each only if it is still
// at the revision the human was shown (shown, by key), or else none, so the answer is the stale keys. Reading the members and
// writing the drafts are one transaction, so a drop or an edit cannot land between them: a drop that answers 200 came first
// and its draft is left out, an Approve that came first leaves the drop to be refused (the draft is no longer one).
func (s *Store) ApproveBatch(ctx context.Context, itsaID string, shown map[string]int64) (approved, stale []string, err error) {
	if err := s.ready(ctx); err != nil {
		return nil, nil, err
	}
	if err := s.approvalTables(ctx); err != nil {
		return nil, nil, err
	}
	err = s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		approved, stale = nil, nil
		var keys []string
		if err := sqlitex.Execute(conn, "SELECT req_key FROM req_batch_asks WHERE itsa_id = ? AND dropped = 0 ORDER BY rowid", &sqlitex.ExecOptions{Args: []any{itsaID}, ResultFunc: func(stmt *sqlite.Stmt) error {
			keys = append(keys, stmt.ColumnText(0))
			return nil
		}}); err != nil {
			return err
		}
		var ids []string
		for _, k := range keys {
			var id, status string
			var rev int64
			found := false
			if err := sqlitex.Execute(conn, "SELECT id, status, rev FROM requirements WHERE key = ?", &sqlitex.ExecOptions{Args: []any{k}, ResultFunc: func(stmt *sqlite.Stmt) error {
				id, status, rev, found = stmt.ColumnText(0), stmt.ColumnText(1), stmt.ColumnInt64(2), true
				return nil
			}}); err != nil {
				return err
			}
			// A member that left draft another way is not a draft of the batch any more.
			if !found || status != "draft" {
				continue
			}
			if at, ok := shown[k]; !ok || at != rev {
				stale = append(stale, k)
				continue
			}
			ids = append(ids, id)
			approved = append(approved, k)
		}
		if len(stale) > 0 {
			approved = nil
			return nil
		}
		t := now()
		for _, id := range ids {
			if err := sqlitex.Execute(conn, "UPDATE requirements SET status = 'in_force', rev = rev + 1, updated_at = ? WHERE id = ?", &sqlitex.ExecOptions{Args: []any{t, id}}); err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil && len(approved) > 0 {
		s.DropIndex()
	}
	return approved, stale, err
}

// DropMember takes one draft out of an open batch ask: it stays a draft, or becomes obsolete, and Approve leaves it out. Every
// check and write is one transaction (ref is the ITSA's id or key; closed says whether a status is in the closed category).
// posted is false when the draft was already dropped. ifRev is the revision the human was shown.
func (s *Store) DropMember(ctx context.Context, ref, key string, obsolete bool, ifRev int64, closed func(status string) bool) (itsaID string, posted bool, err error) {
	if err := s.ready(ctx); err != nil {
		return "", false, err
	}
	if err := s.approvalTables(ctx); err != nil {
		return "", false, err
	}
	err = s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		var id, ikey, kind, status string
		found := false
		if err := sqlitex.Execute(conn, "SELECT id, key, kind, status FROM itsas WHERE id = ? OR key = ?", &sqlitex.ExecOptions{Args: []any{ref, ref}, ResultFunc: func(stmt *sqlite.Stmt) error {
			if !found {
				id, ikey, kind, status, found = stmt.ColumnText(0), stmt.ColumnText(1), stmt.ColumnText(2), stmt.ColumnText(3), true
			}
			return nil
		}}); err != nil {
			return err
		}
		members := 0
		if found && kind == ApprovalKind {
			if err := sqlitex.Execute(conn, "SELECT count(*) FROM req_batch_asks WHERE itsa_id = ?", &sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error { members = stmt.ColumnInt(0); return nil }}); err != nil {
				return err
			}
		}
		if members == 0 {
			return fmt.Errorf("no requirement approval %s", ref)
		}
		if closed(status) {
			return fmt.Errorf("%s is closed", ikey)
		}
		var dropped, inBatch bool
		if err := sqlitex.Execute(conn, "SELECT dropped FROM req_batch_asks WHERE itsa_id = ? AND req_key = ?", &sqlitex.ExecOptions{Args: []any{id, key}, ResultFunc: func(stmt *sqlite.Stmt) error {
			inBatch, dropped = true, stmt.ColumnInt(0) != 0
			return nil
		}}); err != nil {
			return err
		}
		if !inBatch {
			return fmt.Errorf("%s is not in %s", key, ikey)
		}
		if dropped {
			return nil
		}
		var reqID, reqStatus string
		var rev int64
		have := false
		if err := sqlitex.Execute(conn, "SELECT id, status, rev FROM requirements WHERE key = ?", &sqlitex.ExecOptions{Args: []any{key}, ResultFunc: func(stmt *sqlite.Stmt) error {
			reqID, reqStatus, rev, have = stmt.ColumnText(0), stmt.ColumnText(1), stmt.ColumnInt64(2), true
			return nil
		}}); err != nil {
			return err
		}
		if !have {
			return fmt.Errorf("no requirement %s", key)
		}
		if reqStatus != "draft" {
			return fmt.Errorf("%s is %s, no longer a draft", key, reqStatus)
		}
		if rev != ifRev {
			return fmt.Errorf("%s changed since it was shown (rev %d, shown at rev %d)", key, rev, ifRev)
		}
		if obsolete {
			if err := sqlitex.Execute(conn, "UPDATE requirements SET status = 'obsolete', rev = rev + 1, updated_at = ? WHERE id = ?", &sqlitex.ExecOptions{Args: []any{now(), reqID}}); err != nil {
				return err
			}
		}
		if err := sqlitex.Execute(conn, "UPDATE req_batch_asks SET dropped = 1 WHERE itsa_id = ? AND req_key = ?", &sqlitex.ExecOptions{Args: []any{id, key}}); err != nil {
			return err
		}
		itsaID, posted = id, true
		return nil
	})
	if err == nil && posted && obsolete {
		s.DropIndex()
	}
	return itsaID, posted, err
}

// --- the texts of an ask ---

func jsList(r Req, key string) []jsfmt.Value {
	v, _ := r.Get(key)
	if v.Kind != jsfmt.Array {
		return nil
	}
	return v.Items
}

func nonEmpty(r Req, key string) string {
	v, ok := r.Get(key)
	if !ok || v.Kind != jsfmt.String {
		return ""
	}
	return v.Str
}

// Statement is the ask's text for one draft (src/req-approval.ts statement); via is `human` or `cos`.
func Statement(r Req, via string) string {
	text := "(no text yet)"
	if v, ok := r.Get("text"); ok && v.Kind == jsfmt.String {
		text = v.Str
	}
	lines := []string{"**" + r.Key() + ": " + r.Text("title") + "**", "", text}
	if why := nonEmpty(r, "rationale"); why != "" {
		lines = append(lines, "", "Why: "+why)
	}
	if src := nonEmpty(r, "source"); src != "" {
		lines = append(lines, "Source: "+src)
	}
	if ver := jsList(r, "verification"); len(ver) > 0 {
		parts := make([]string, len(ver))
		for i, v := range ver {
			if d := v.Text("detail"); d != "" {
				parts[i] = v.Text("method") + " (" + d + ")"
			} else {
				parts[i] = v.Text("method")
			}
		}
		lines = append(lines, "Verification: "+strings.Join(parts, ", "))
	}
	if sc, ok := r.Get("scope"); ok && (sc.Kind == jsfmt.Object || sc.Kind == jsfmt.Array) {
		lines = append(lines, "Scope: "+jsfmt.Compact(sc))
	}
	lines = append(lines, fmt.Sprintf("Severity %s, mode %s. Rev %d.", r.Text("severity"), r.Text("mode"), r.Rev()), "")
	if via == "cos" {
		lines = append(lines, fmt.Sprintf("To put it in force: req_set key=%s status=in_force if_rev=%d. To send it back, comment on this ITSA.", r.Key(), r.Rev()))
	} else {
		lines = append(lines, "Approve to put it in force; Request changes to send it back to its author.")
	}
	return strings.Join(lines, "\n")
}

var reSentenceEnd = regexp.MustCompile(`[.!?]$`)

func sentence(s string) string {
	t := jsjson.Trim(s)
	if reSentenceEnd.MatchString(t) {
		return t
	}
	return t + "."
}

// natLess orders keys as localeCompare(…, {numeric: true}) does for keys like R-2 and R-10: digit runs by value, the rest
// without regard to case.
func natLess(a, b string) bool {
	tok := func(s string) []string { return regexp.MustCompile(`\d+|\D+`).FindAllString(s, -1) }
	ta, tb := tok(a), tok(b)
	for i := 0; i < len(ta) && i < len(tb); i++ {
		x, y := ta[i], tb[i]
		if x[0] >= '0' && x[0] <= '9' && y[0] >= '0' && y[0] <= '9' {
			x, y = strings.TrimLeft(x, "0"), strings.TrimLeft(y, "0")
			if len(x) != len(y) {
				return len(x) < len(y)
			}
		}
		if lx, ly := strings.ToLower(x), strings.ToLower(y); lx != ly {
			return lx < ly
		}
	}
	return len(ta) < len(tb)
}

func sortedByKey(rs []Req) []Req {
	out := append([]Req(nil), rs...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && natLess(out[j].Key(), out[j-1].Key()); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// BatchStatement is the ask's text for a batch of drafts: one line per draft, with its text and why, children under their
// parent. parentKey names the key of a parent outside the batch (src/req-approval.ts batchStatement).
func BatchStatement(rs []Req, via string, parentKey func(id string) string) string {
	ids := map[string]bool{}
	for _, r := range rs {
		ids[r.ID()] = true
	}
	lines := []string{fmt.Sprintf("**%d requirement drafts** for approval as one batch. Each starts in the mode shown; observe records verdicts and tells nobody.", len(rs)), ""}
	var line func(r Req, depth int)
	line = func(r Req, depth int) {
		parent := ""
		if pid := r.ParentID(); pid != "" && !ids[pid] {
			k := parentKey(pid)
			if k == "" {
				k = pid
			}
			parent = " (under " + k + ")"
		}
		var meta []string
		if src := nonEmpty(r, "source"); src != "" {
			meta = append(meta, "source "+src)
		}
		if ver := jsList(r, "verification"); len(ver) > 0 {
			ms := make([]string, len(ver))
			for i, v := range ver {
				ms[i] = v.Text("method")
			}
			meta = append(meta, "verify "+strings.Join(ms, "+"))
		}
		meta = append(meta, r.Text("severity"), r.Text("mode"), fmt.Sprintf("rev %d", r.Rev()))
		text, why := "", ""
		if t := nonEmpty(r, "text"); t != "" {
			text = ": " + sentence(t)
		}
		if w := nonEmpty(r, "rationale"); w != "" {
			why = " Why: " + sentence(w)
		}
		lines = append(lines, fmt.Sprintf("%s- **%s: %s**%s%s%s _(%s)_", strings.Repeat("  ", depth), r.Key(), r.Text("title"), parent, text, why, strings.Join(meta, ", ")))
		var kids []Req
		for _, x := range rs {
			if x.ParentID() == r.ID() {
				kids = append(kids, x)
			}
		}
		for _, c := range sortedByKey(kids) {
			line(c, depth+1)
		}
	}
	var roots []Req
	for _, x := range rs {
		if pid := x.ParentID(); pid == "" || !ids[pid] {
			roots = append(roots, x)
		}
	}
	for _, r := range sortedByKey(roots) {
		line(r, 0)
	}
	lines = append(lines, "")
	if via == "cos" {
		lines = append(lines, "To put one in force: req_set key=KEY status=in_force if_rev=REV, with the rev listed. To send the batch back, comment on this ITSA.")
	} else {
		lines = append(lines, "Approve puts every draft listed in force; Request changes sends the batch back to its author.")
	}
	return strings.Join(lines, "\n")
}

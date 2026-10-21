package requirements

import (
	"context"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// Verdict is a stored conformity verdict: one per (requirement version, subject content, model).
type Verdict struct {
	ID                        int64
	Verdict                   string
	PConforms, PViolates, PNa *float64
	Action                    string
}

func optFloat(stmt *sqlite.Stmt, i int) *float64 {
	if stmt.ColumnIsNull(i) {
		return nil
	}
	f := stmt.ColumnFloat(i)
	return &f
}

// CachedVerdict is the stored verdict for this exact requirement version, subject content and model, if any.
func (s *Store) CachedVerdict(ctx context.Context, reqID string, version int64, hash, model string) (*Verdict, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	var out *Verdict
	err := s.DB.Read(ctx, func(conn *sqlite.Conn) (err error) { out, err = cachedConn(conn, reqID, version, hash, model); return })
	return out, err
}

func cachedConn(conn *sqlite.Conn, reqID string, version int64, hash, model string) (*Verdict, error) {
	var out *Verdict
	err := sqlitex.Execute(conn, "SELECT id, verdict, p_conforms, p_violates, p_na, action FROM req_verdicts WHERE req_id = ? AND req_version = ? AND subject_hash = ? AND model = ?", &sqlitex.ExecOptions{
		Args: []any{reqID, version, hash, model}, ResultFunc: func(stmt *sqlite.Stmt) error {
			if out == nil {
				out = &Verdict{ID: stmt.ColumnInt64(0), Verdict: stmt.ColumnText(1), PConforms: optFloat(stmt, 2), PViolates: optFloat(stmt, 3), PNa: optFloat(stmt, 4), Action: stmt.ColumnText(5)}
			}
			return nil
		}})
	return out, err
}

// NewVerdict is a verdict to store. SubjectLabel is a pasted text's start, since its subject is only a hash.
type NewVerdict struct {
	ReqID        string
	ReqVersion   int64
	Subject      string
	SubjectHash  string
	SubjectLabel string
	Model        string
	Verdict      string
	PConforms    float64
	PViolates    float64
	PNa          float64
	Action       string
	Cost         float64
}

// RecordVerdict stores a verdict; a concurrent duplicate of the same cache key is ignored and the stored one's id returned.
func (s *Store) RecordVerdict(ctx context.Context, v NewVerdict) (int64, error) {
	if err := s.ready(ctx); err != nil {
		return 0, err
	}
	var id int64
	err := s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		var label any
		if v.SubjectLabel != "" {
			label = v.SubjectLabel
		}
		if err := sqlitex.Execute(conn, `INSERT OR IGNORE INTO req_verdicts (req_id, req_version, subject, subject_hash, subject_label, model, verdict, p_conforms, p_violates, p_na, action, cost, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, &sqlitex.ExecOptions{Args: []any{v.ReqID, v.ReqVersion, v.Subject, v.SubjectHash, label, v.Model, v.Verdict, v.PConforms, v.PViolates, v.PNa, v.Action, v.Cost, now()}}); err != nil {
			return err
		}
		if conn.Changes() > 0 {
			id = conn.LastInsertRowID()
			return nil
		}
		c, err := cachedConn(conn, v.ReqID, v.ReqVersion, v.SubjectHash, v.Model)
		if c != nil {
			id = c.ID
		}
		return err
	})
	return id, err
}

// WaiverKind is the kind of the latest waiver on a verdict, or "".
func (s *Store) WaiverKind(ctx context.Context, verdictID int64) (string, error) {
	if err := s.ready(ctx); err != nil {
		return "", err
	}
	kind := ""
	err := s.DB.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT kind FROM req_waivers WHERE verdict_id = ? ORDER BY id DESC LIMIT 1", &sqlitex.ExecOptions{Args: []any{verdictID}, ResultFunc: func(stmt *sqlite.Stmt) error {
			kind = stmt.ColumnText(0)
			return nil
		}})
	})
	return kind, err
}

// WaivedOn is whether a verdict of this requirement on this subject was waived (any version): the actor is not told again.
func (s *Store) WaivedOn(ctx context.Context, reqID, subject string) (bool, error) {
	if err := s.ready(ctx); err != nil {
		return false, err
	}
	waived := false
	err := s.DB.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT 1 FROM req_verdicts v JOIN req_waivers w ON w.verdict_id = v.id WHERE v.req_id = ? AND v.subject = ? LIMIT 1", &sqlitex.ExecOptions{Args: []any{reqID, subject}, ResultFunc: func(*sqlite.Stmt) error { waived = true; return nil }})
	})
	return waived, err
}

// --- the enforced-tools index ---

// EnforcedTools is the tools an in-force `enforce` requirement with a `decision` method names in its scope, kept in memory so
// a tool call that no requirement names does no database work. It is built on first use and rebuilt after every requirement
// change (DropIndex); while a rebuild runs, the index of before the change is still served, so a tool the index named is
// never let through unchecked because of a rebuild. Only an index never built is cold.
func (s *Store) EnforcedTools(ctx context.Context) (map[string]bool, error) {
	s.idxMu.Lock()
	if s.index != nil {
		defer s.idxMu.Unlock()
		return s.index, nil
	}
	s.idxMu.Unlock()
	return s.buildIndex(ctx)
}

// buildIndex reads the requirements and swaps the result in, unless a change came in while it read (that change's own rebuild
// supplies the newer one).
func (s *Store) buildIndex(ctx context.Context) (map[string]bool, error) {
	s.idxMu.Lock()
	gen := s.indexGen
	hook := s.OnIndexBuild
	s.idxMu.Unlock()
	if hook != nil {
		hook()
	}
	list, err := s.List(ctx, ListFilters{Status: ptrTo("in_force")})
	if err != nil {
		return nil, err
	}
	tools := map[string]bool{}
	for _, r := range list.Items {
		if r.Text("mode") != "enforce" || !hasDecision(r) {
			continue
		}
		if scope, ok := r.Get("scope"); ok {
			if list, ok := scope.Get("tools"); ok {
				for _, t := range list.Items {
					if t.Kind == jsfmt.String {
						tools[t.Str] = true
					}
				}
			}
		}
	}
	s.idxMu.Lock()
	defer s.idxMu.Unlock()
	if s.indexGen == gen {
		s.index = tools
	}
	return tools, nil
}

func ptrTo(s string) *string { return &s }

func hasDecision(r jsfmt.Value) bool {
	v, _ := r.Get("verification")
	for _, m := range v.Items {
		if m.Text("method") == "decision" {
			return true
		}
	}
	return false
}

// IndexReady is whether the index is built: a tool call that finds it cold goes through (src/req-check.ts checkTool).
func (s *Store) IndexReady() bool {
	s.idxMu.Lock()
	defer s.idxMu.Unlock()
	return s.index != nil
}

// DropIndex is src/requirements.ts rebuildEnforcedTools: a requirement changed, so the index is built again and then the
// home's listeners (the push to its peers) run. The old index serves until the new one is swapped in.
func (s *Store) DropIndex() {
	s.idxMu.Lock()
	s.indexGen++
	fns := append([]func(){}, s.indexListeners...)
	s.idxMu.Unlock()
	_, _ = s.buildIndex(context.Background())
	for _, fn := range fns {
		fn()
	}
}

// OnIndexChange runs fn after every requirement change that drops the index.
func (s *Store) OnIndexChange(fn func()) {
	s.idxMu.Lock()
	s.indexListeners = append(s.indexListeners, fn)
	s.idxMu.Unlock()
}

// ToolsSorted is the index as a sorted list (GET /api/requirements/enforced-tools).
func ToolsSorted(tools map[string]bool) []string {
	out := make([]string, 0, len(tools))
	for t := range tools {
		out = append(out, t)
	}
	// JavaScript's default sort compares UTF-16 units; byte order is the same for the BMP.
	sortStrings(out)
	return out
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && strings.Compare(s[j-1], s[j]) > 0; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}

var _ = jsjson.Trim

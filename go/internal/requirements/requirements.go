// Package requirements is src/requirements.ts: an optional tree of requirements (S-461), each a statement with a
// rationale, verification methods, a scope, a severity and a mode (observe, inform, enforce). Off unless
// settings.requirements.enabled. The tables are created lazily, so nothing exists while it is off.
//
// Ported: the tree (list, get, create, batch, set), links, verdict reads, waivers and the demotion a waiver can cause with its
// owner's notice; the check engine and its verdict cache (check.go, verdicts.go); the approval ask an agent's draft opens
// (approval.go).
package requirements

import (
	"context"
	crand "crypto/rand"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/decide"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/steps"
)

var (
	Statuses            = []string{"draft", "in_force", "suspended", "obsolete"}
	Severities          = []string{"info", "minor", "major", "critical"}
	Modes               = []string{"observe", "inform", "enforce"}
	VerificationMethods = []string{"decision", "test", "pattern", "review", "human"}
	TargetKinds         = []string{"itsa", "file", "test", "mail", "url", "requirement"}
	LinkRoles           = []string{"implements", "verifies", "allocated_to", "refines", "conflicts_with"}
	WaiverKinds         = []string{"false_positive", "accepted_deviation"}
	scopeKeys           = []string{"subjects", "paths", "repos", "roles", "agents", "itsa", "tools", "sources", "types"}
)

// Human is mail.HUMAN.
const Human = "human"

// OffMessage is requirements.OFF_MESSAGE.
const OffMessage = "requirements are off (settings.requirements.enabled)"

const (
	// BatchMax is the most requirements one batch holds.
	BatchMax = 200
	// PrecisionWindow and PrecisionMaxRate: over the last PrecisionWindow `violates` verdicts at a version, above
	// PrecisionMaxRate waived as false positives demotes the requirement to observe.
	PrecisionWindow  = 20
	PrecisionMaxRate = 0.3
)

// Forbidden is a refusal for who the caller is, not what it sent: the route answers 403.
type Forbidden string

func (e Forbidden) Error() string { return string(e) }

// Off is the error of every entry point while requirements are off: the route answers 404.
type Off struct{}

func (Off) Error() string { return OffMessage }

// NotPorted is a step the Go daemon cannot take yet: the route answers 501, and nothing was written.
type NotPorted string

func (e NotPorted) Error() string { return string(e) }

// Store is the requirements of one daemon.
type Store struct {
	DB       *db.DB
	Settings func() config.Settings
	// Person resolves an agent id or name (or `human`) to an id, "" for none, as src/itsa.ts person does.
	Person func(ctx context.Context, v jsjson.Value) (string, error)

	// mu guards made: the tables are made once, but a failed attempt (a busy database) is tried again by the next call.
	mu   sync.Mutex
	made bool
	// apprMade is the same for the approval tables (approval.go).
	apprMade bool
	// makeTables creates the tables; nil is the DDL. A test replaces it.
	makeTables func(ctx context.Context) error

	// Ask is the decision model the check engine asks (check.go); nil asks nothing.
	Ask Asker
	// IsHome is whether this daemon is the ITSA home, where checks run; nil is true.
	IsHome func() bool
	// Actors names an agent for a subject and a denial.
	Actors interface {
		ActorOf(ctx context.Context, ref string) steps.Actor
	}
	// Notify tells the actor about violations of a non-silent subject (PR 3b); CapNotice is the daily notice when the cost cap
	// stops checks (PR 3b). Nil does nothing.
	Notify    func(ctx context.Context, sub Subject, hits []Hit)
	CapNotice func(ctx context.Context, spent, cap float64)
	// Demoted tells a requirement's owner that a waiver dropped it to observe (src/requirements.ts demoteIfImprecise): the owner
	// ("human" for the human), the requirement's key and the text.
	Demoted func(ctx context.Context, owner, key, text string) error
	// gate serializes the model calls (check.go serialized).
	gate sync.Mutex

	// idxMu guards the enforced-tools index (verdicts.go).
	idxMu    sync.Mutex
	index    map[string]bool
	indexGen int
	// OnIndexBuild runs as an index build starts, after it read the generation; a test holds a rebuild here.
	OnIndexBuild   func()
	indexListeners []func()
}

// Asker is the decision model: *decide.Client.
type Asker interface {
	Decide(ctx context.Context, state jsjson.Value, questions []decide.Named, purpose string, timeout time.Duration) (*decide.Result, *decide.Failure)
}

// Enabled is settings.requirements.enabled.
func (s *Store) Enabled() bool { return s.Settings().RequirementsEnabled }

func (s *Store) ready(ctx context.Context) error {
	if !s.Enabled() {
		return Off{}
	}
	return s.table(ctx)
}

func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

const ddl = `
    CREATE TABLE IF NOT EXISTS requirements (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      parent_id TEXT,
      level TEXT,
      title TEXT NOT NULL,
      text TEXT,
      rationale TEXT,
      source TEXT,
      verification TEXT,
      scope TEXT,
      severity TEXT NOT NULL DEFAULT 'minor',
      mode TEXT NOT NULL DEFAULT 'observe',
      threshold REAL NOT NULL DEFAULT 0.8,
      status TEXT NOT NULL DEFAULT 'draft',
      owner TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      rev INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      text_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requirements_parent ON requirements (parent_id, key);
    CREATE TABLE IF NOT EXISTS req_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS req_links_req ON req_links (req_id, id);
    CREATE TABLE IF NOT EXISTS req_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_id TEXT NOT NULL,
      req_version INTEGER NOT NULL,
      subject TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      subject_label TEXT,
      model TEXT NOT NULL,
      verdict TEXT NOT NULL,
      p_conforms REAL,
      p_violates REAL,
      p_na REAL,
      action TEXT,
      cost REAL,
      ts TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS req_verdicts_cache ON req_verdicts (req_id, req_version, subject_hash, model);
    CREATE INDEX IF NOT EXISTS req_verdicts_req ON req_verdicts (req_id, id);
    CREATE TABLE IF NOT EXISTS req_waivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      verdict_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT,
      by TEXT,
      ts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS req_counter (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS req_waivers_verdict ON req_waivers (verdict_id, id);
`

// table creates the tables and adds the columns a table made before them lacks (src/requirements.ts table()).
func (s *Store) table(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.made {
		return nil
	}
	make := s.makeTables
	if make == nil {
		make = s.createTables
	}
	err := make(context.WithoutCancel(ctx))
	if err == nil {
		s.made = true
	}
	return err
}

func (s *Store) createTables(ctx context.Context) error {
	{
		return s.DB.Write(context.WithoutCancel(ctx), func(conn *sqlite.Conn) error {
			if err := sqlitex.ExecuteScript(conn, ddl, nil); err != nil {
				return err
			}
			add := func(table, col, def string) error {
				have := false
				if err := sqlitex.Execute(conn, "PRAGMA table_info("+table+")", &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
					have = have || stmt.ColumnText(1) == col
					return nil
				}}); err != nil || have {
					return err
				}
				return sqlitex.ExecuteTransient(conn, "ALTER TABLE "+table+" ADD COLUMN "+col+" "+def, nil)
			}
			if err := add("requirements", "rev", "INTEGER NOT NULL DEFAULT 1"); err != nil {
				return err
			}
			if err := add("requirements", "text_by", "TEXT"); err != nil {
				return err
			}
			return add("req_verdicts", "subject_label", "TEXT")
		})
	}
}

// --- values ---

func str(s string) jsfmt.Value { return jsfmt.StringValue(s) }
func num(f float64) jsfmt.Value {
	return jsfmt.Value{Kind: jsfmt.Number, Num: jsjson.Number(f)}
}
func boolean(b bool) jsfmt.Value { return jsfmt.Value{Kind: jsfmt.Bool, Bool: b} }
func obj(pairs ...any) jsfmt.Value {
	v := jsfmt.Value{Kind: jsfmt.Object}
	for i := 0; i+1 < len(pairs); i += 2 {
		v.Keys = append(v.Keys, pairs[i].(string))
		v.Items = append(v.Items, pairs[i+1].(jsfmt.Value))
	}
	return v
}
func optStr(p *string) jsfmt.Value {
	if p == nil {
		return jsfmt.NullValue()
	}
	return str(*p)
}

// rowValue is a row as an ordered object with every column, REAL columns as numbers.
func rowValue(stmt *sqlite.Stmt) jsfmt.Value {
	row := jsfmt.Value{Kind: jsfmt.Object}
	for i := 0; i < stmt.ColumnCount(); i++ {
		var v jsfmt.Value
		switch stmt.ColumnType(i) {
		case sqlite.TypeNull:
			v = jsfmt.NullValue()
		case sqlite.TypeInteger:
			v = jsfmt.IntValue(stmt.ColumnInt64(i))
		case sqlite.TypeFloat:
			v = num(stmt.ColumnFloat(i))
		default:
			v = str(stmt.ColumnText(i))
		}
		row.Keys, row.Items = append(row.Keys, stmt.ColumnName(i)), append(row.Items, v)
	}
	return row
}

// Req is a requirement row, as the API shows it: verification and scope parsed (null when unreadable).
type Req struct {
	jsfmt.Value
}

func parseJSON(v jsfmt.Value) jsfmt.Value {
	if v.Kind != jsfmt.String {
		return jsfmt.NullValue()
	}
	p, err := jsfmt.Parse([]byte(v.Str))
	if err != nil {
		return jsfmt.NullValue()
	}
	return p
}

func parseRow(row jsfmt.Value) Req {
	for _, k := range []string{"verification", "scope"} {
		for i, key := range row.Keys {
			if key == k {
				row.Items[i] = parseJSON(row.Items[i])
			}
		}
	}
	return Req{row}
}

func (r Req) ID() string        { return r.Text("id") }
func (r Req) Key() string       { return r.Text("key") }
func (r Req) Status() string    { return r.Text("status") }
func (r Req) Owner() string     { return r.Text("owner") }
func (r Req) CreatedBy() string { return r.Text("created_by") }
func (r Req) TextBy() string    { return r.Text("text_by") }
func (r Req) ParentID() string  { return r.Text("parent_id") }
func (r Req) int(k string) int64 {
	v, _ := r.Get(k)
	n, _ := strconv.ParseInt(v.Num, 10, 64)
	return n
}
func (r Req) float(k string) float64 {
	v, _ := r.Get(k)
	f, _ := strconv.ParseFloat(v.Num, 64)
	return f
}

// Version and Rev count edits of the statement and of anything.
func (r Req) Version() int64 { return r.int("version") }
func (r Req) Rev() int64     { return r.int("rev") }

func findConn(conn *sqlite.Conn, ref string) (*Req, error) {
	var out *Req
	err := sqlitex.Execute(conn, "SELECT * FROM requirements WHERE id = ? OR key = ?", &sqlitex.ExecOptions{Args: []any{ref, ref}, ResultFunc: func(stmt *sqlite.Stmt) error {
		if out == nil {
			r := parseRow(rowValue(stmt))
			out = &r
		}
		return nil
	}})
	return out, err
}

func mustConn(conn *sqlite.Conn, ref string) (Req, error) {
	r, err := findConn(conn, ref)
	if err != nil {
		return Req{}, err
	}
	if r == nil {
		return Req{}, fmt.Errorf("no requirement %s", ref)
	}
	return *r, nil
}

// --- coercions, as src/requirements.ts's ---

func oneOf(list []string, v jsjson.Value, what string) (string, error) {
	if s, ok := v.(string); ok && slices.Contains(list, s) {
		return s, nil
	}
	return "", fmt.Errorf("%s must be one of: %s", what, strings.Join(list, ", "))
}

// textOrNull is `v == null ? null : String(v) || null`.
func textOrNull(v jsjson.Value) *string {
	if v == nil {
		return nil
	}
	s := jsjson.ToString(v)
	if s == "" {
		return nil
	}
	return &s
}

func trimmedOrNull(v jsjson.Value) *string {
	s := textOrNull(v)
	if s == nil {
		return nil
	}
	t := jsjson.Trim(*s)
	if t == "" {
		return nil
	}
	return &t
}

func isBlank(v jsjson.Value, set bool) bool {
	if !set || v == nil {
		return true
	}
	s, ok := v.(string)
	return ok && s == ""
}

// Input is a request's fields: Get returns a field and whether the body had it (undefined is not null).
type Input func(key string) (jsjson.Value, bool)

func (in Input) val(k string) jsjson.Value { v, _ := in(k); return v }

func normalizeVerification(raw jsjson.Value, set bool) (*jsfmt.Value, error) {
	if !set || raw == nil {
		return nil, nil
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, errors.New("verification is a list of methods (decision, test, pattern, review, human)")
	}
	out := jsfmt.Value{Kind: jsfmt.Array}
	for _, item := range list {
		var method jsjson.Value
		var detail jsjson.Value
		hasDetail := false
		switch x := item.(type) {
		case string:
			method = x
		default:
			// String((item as any)?.method ?? (item as any)?.kind ?? '')
			method = ""
			if o, ok := item.(*jsjson.Object); ok {
				if m, _ := o.Get("method"); m != nil {
					method = jsjson.ToString(m)
				} else if k, _ := o.Get("kind"); k != nil {
					method = jsjson.ToString(k)
				}
				if d, _ := o.Get("detail"); d != nil {
					detail, hasDetail = jsjson.ToString(d), true
				}
			}
		}
		m, err := oneOf(VerificationMethods, method, "a verification method")
		if err != nil {
			return nil, err
		}
		// `detail ? {method, detail} : {method}`: an empty detail is none.
		if hasDetail && detail.(string) != "" {
			out.Items = append(out.Items, obj("method", str(m), "detail", str(detail.(string))))
		} else {
			out.Items = append(out.Items, obj("method", str(m)))
		}
	}
	return &out, nil
}

func normalizeScope(raw jsjson.Value, set bool) (*jsfmt.Value, error) {
	if !set || raw == nil {
		return nil, nil
	}
	o, ok := raw.(*jsjson.Object)
	if !ok {
		return nil, errors.New("scope is an object of lists (subjects, paths, repos, roles, agents, itsa, tools, sources, types)")
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range o.Keys() {
		if !slices.Contains(scopeKeys, k) {
			return nil, fmt.Errorf("unknown scope field %s; scope fields: %s", k, strings.Join(scopeKeys, ", "))
		}
		v, _ := o.Get(k)
		list, ok := v.([]any)
		bad := !ok
		items := make([]jsfmt.Value, 0, len(list))
		for _, e := range list {
			if s, isStr := e.(string); isStr && s != "" {
				items = append(items, str(s))
			} else {
				bad = true
			}
		}
		if bad {
			return nil, fmt.Errorf("scope.%s is a list of non-empty strings", k)
		}
		out.Set(k, jsfmt.ArrayValue(items))
	}
	return &out, nil
}

func severityOf(v jsjson.Value, set bool, fallback string) (string, error) {
	if isBlank(v, set) {
		return fallback, nil
	}
	return oneOf(Severities, v, "severity")
}

func jsonText(v *jsfmt.Value) any {
	if v == nil {
		return nil
	}
	return jsfmt.Compact(*v)
}

// --- keys ---

const idAlphabet = "abcdefghijkmnpqrstuvwxyz23456789"

func newID() (string, error) {
	var b [4]byte
	if _, err := crand.Read(b[:]); err != nil {
		return "", err
	}
	out := []byte{'r'}
	for _, x := range b {
		out = append(out, idAlphabet[int(x)%len(idAlphabet)])
	}
	return string(out), nil
}

var reKeyNumber = regexp.MustCompile(`-(\d+)$`)

// nextKey is `R-42`: one durable counter, independent of the display prefix; it seeds from the existing keys.
func (s *Store) nextKey(conn *sqlite.Conn) (string, error) {
	value, found := int64(0), false
	if err := sqlitex.Execute(conn, "SELECT value FROM req_counter WHERE name = 'key'", &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
		value, found = stmt.ColumnInt64(0), true
		return nil
	}}); err != nil {
		return "", err
	}
	if !found {
		if err := sqlitex.Execute(conn, "SELECT key FROM requirements", &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
			if m := reKeyNumber.FindStringSubmatch(stmt.ColumnText(0)); m != nil {
				n, _ := strconv.ParseInt(m[1], 10, 64)
				value = max(value, n)
			}
			return nil
		}}); err != nil {
			return "", err
		}
		if err := sqlitex.Execute(conn, "INSERT OR REPLACE INTO req_counter (name, value) VALUES ('key', ?)", &sqlitex.ExecOptions{Args: []any{value}}); err != nil {
			return "", err
		}
	}
	n := value + 1
	if err := sqlitex.Execute(conn, "UPDATE req_counter SET value = ? WHERE name = 'key'", &sqlitex.ExecOptions{Args: []any{n}}); err != nil {
		return "", err
	}
	return s.Settings().Requirements.KeyPrefix + "-" + strconv.FormatInt(n, 10), nil
}

// --- reads ---

// ListFilters are the filters of List; a nil pointer is "not given".
type ListFilters struct {
	// Parent is a key or id, or "root", "none" or "" for the roots.
	Parent *string
	Status *string
	Text   *string
	// Latest adds each requirement's latest verdict per subject at its current version.
	Latest bool
}

func linkValue(stmt *sqlite.Stmt, at int) jsfmt.Value {
	return obj("id", jsfmt.IntValue(stmt.ColumnInt64(at)), "target_kind", str(stmt.ColumnText(at+1)), "target", str(stmt.ColumnText(at+2)), "role", str(stmt.ColumnText(at+3)))
}

// List is the requirements with their links (and latest verdicts), oldest first.
func (s *Store) List(ctx context.Context, f ListFilters) (jsfmt.Value, error) {
	if err := s.ready(ctx); err != nil {
		return jsfmt.Value{}, err
	}
	out := jsfmt.Value{Kind: jsfmt.Array}
	err := s.DB.Read(ctx, func(conn *sqlite.Conn) error {
		var where []string
		var args []any
		if f.Parent != nil {
			if p := *f.Parent; p == "root" || p == "none" || p == "" {
				where = append(where, "parent_id IS NULL")
			} else {
				x, err := mustConn(conn, p)
				if err != nil {
					return err
				}
				where = append(where, "parent_id = ?")
				args = append(args, x.ID())
			}
		}
		if f.Status != nil && *f.Status != "" {
			where = append(where, "status = ?")
			args = append(args, *f.Status)
		}
		if f.Text != nil && jsjson.Trim(*f.Text) != "" {
			like := "%" + jsjson.Trim(*f.Text) + "%"
			where = append(where, "(key LIKE ? OR title LIKE ? OR text LIKE ? OR rationale LIKE ? OR source LIKE ?)")
			args = append(args, like, like, like, like, like)
		}
		clause := ""
		if len(where) > 0 {
			clause = "WHERE " + strings.Join(where, " AND ")
		}
		var rows []Req
		if err := sqlitex.Execute(conn, "SELECT * FROM requirements "+clause+" ORDER BY created_at, key", &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
			rows = append(rows, parseRow(rowValue(stmt)))
			return nil
		}}); err != nil {
			return err
		}
		links := map[string][]jsfmt.Value{}
		if err := sqlitex.Execute(conn, "SELECT req_id, id, target_kind, target, role FROM req_links ORDER BY req_id, id", &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
			id := stmt.ColumnText(0)
			links[id] = append(links[id], linkValue(stmt, 1))
			return nil
		}}); err != nil {
			return err
		}
		var latest map[string][]jsfmt.Value
		if f.Latest {
			var err error
			if latest, err = latestVerdicts(conn); err != nil {
				return err
			}
		}
		for _, r := range rows {
			v := r.Value
			v.Set("links", jsfmt.ArrayValue(append([]jsfmt.Value{}, links[r.ID()]...)))
			if f.Latest {
				v.Set("latest", jsfmt.ArrayValue(append([]jsfmt.Value{}, latest[r.ID()]...)))
			}
			out.Items = append(out.Items, v)
		}
		return nil
	})
	return out, err
}

// latestVerdicts is, per requirement, the newest verdict on each subject at the requirement's current version, with the
// kind of its latest waiver.
func latestVerdicts(conn *sqlite.Conn) (map[string][]jsfmt.Value, error) {
	out := map[string][]jsfmt.Value{}
	err := sqlitex.Execute(conn, `SELECT v.req_id, v.id, v.subject, v.verdict, v.p_violates, v.ts,
         (SELECT kind FROM req_waivers w WHERE w.verdict_id = v.id ORDER BY w.id DESC LIMIT 1) AS waived
       FROM req_verdicts v JOIN requirements r ON r.id = v.req_id AND v.req_version = r.version
       WHERE v.id = (SELECT MAX(id) FROM req_verdicts x WHERE x.req_id = v.req_id AND x.req_version = v.req_version AND x.subject = v.subject)
       ORDER BY v.id DESC`, &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
		pv, waived := jsfmt.NullValue(), jsfmt.NullValue()
		if !stmt.ColumnIsNull(4) {
			pv = num(stmt.ColumnFloat(4))
		}
		if !stmt.ColumnIsNull(6) {
			waived = str(stmt.ColumnText(6))
		}
		id := stmt.ColumnText(0)
		out[id] = append(out[id], obj("id", jsfmt.IntValue(stmt.ColumnInt64(1)), "subject", str(stmt.ColumnText(2)), "verdict", str(stmt.ColumnText(3)), "p_violates", pv, "waived", waived, "ts", str(stmt.ColumnText(5))))
		return nil
	}})
	return out, err
}

// Find is the requirement a id or key names, or nil.
func (s *Store) Find(ctx context.Context, ref string) (*Req, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	var out *Req
	err := s.DB.Read(ctx, func(conn *sqlite.Conn) (err error) { out, err = findConn(conn, ref); return })
	return out, err
}

// Get is a requirement with its ancestors (root first), children, links, last verdicts and precision. verdict keeps that
// verdict in the list however old.
func (s *Store) Get(ctx context.Context, ref string, verdict *int64) (jsfmt.Value, error) {
	if err := s.ready(ctx); err != nil {
		return jsfmt.Value{}, err
	}
	var out jsfmt.Value
	err := s.DB.Read(ctx, func(conn *sqlite.Conn) error {
		x, err := mustConn(conn, ref)
		if err != nil {
			return err
		}
		chain := jsfmt.Value{Kind: jsfmt.Array}
		seen := map[string]bool{x.ID(): true}
		for pid := x.ParentID(); pid != ""; {
			p, err := findConn(conn, pid)
			if err != nil {
				return err
			}
			if p == nil || seen[p.ID()] {
				break
			}
			seen[p.ID()] = true
			chain.Items = append([]jsfmt.Value{obj("id", str(p.ID()), "key", str(p.Key()), "title", str(p.Text("title")), "status", str(p.Status()))}, chain.Items...)
			pid = p.ParentID()
		}
		children := jsfmt.Value{Kind: jsfmt.Array}
		if err := sqlitex.Execute(conn, "SELECT * FROM requirements WHERE parent_id = ? ORDER BY created_at, key", &sqlitex.ExecOptions{Args: []any{x.ID()}, ResultFunc: func(stmt *sqlite.Stmt) error {
			children.Items = append(children.Items, parseRow(rowValue(stmt)).Value)
			return nil
		}}); err != nil {
			return err
		}
		links, err := linksConn(conn, x.ID())
		if err != nil {
			return err
		}
		verdicts, err := s.verdictsConn(ctx, conn, x.ID(), 20, verdict)
		if err != nil {
			return err
		}
		prec, err := precisionConn(conn, x)
		if err != nil {
			return err
		}
		out = x.Value
		out.Set("parent_chain", chain)
		out.Set("children", children)
		out.Set("links", links)
		out.Set("verdicts", verdicts)
		out.Set("precision", prec.value())
		return nil
	})
	return out, err
}

func linksConn(conn *sqlite.Conn, reqID string) (jsfmt.Value, error) {
	out := jsfmt.Value{Kind: jsfmt.Array}
	err := sqlitex.Execute(conn, "SELECT id, target_kind, target, role FROM req_links WHERE req_id = ? ORDER BY id", &sqlitex.ExecOptions{Args: []any{reqID}, ResultFunc: func(stmt *sqlite.Stmt) error {
		out.Items = append(out.Items, linkValue(stmt, 0))
		return nil
	}})
	return out, err
}

var verdictCols = []string{"id", "req_version", "subject", "subject_hash", "model", "verdict", "p_conforms", "p_violates", "p_na", "action", "cost", "ts"}

// verdictsConn is the last n verdicts on a requirement, newest first, each with its subject said readably and its latest
// waiver. include adds an older verdict of this requirement.
func (s *Store) verdictsConn(ctx context.Context, conn *sqlite.Conn, reqID string, n int, include *int64) (jsfmt.Value, error) {
	type vrow struct {
		v     jsfmt.Value
		label *string
	}
	var rows []vrow
	collect := func(stmt *sqlite.Stmt) error {
		full := rowValue(stmt)
		v := jsfmt.Value{Kind: jsfmt.Object}
		for _, c := range verdictCols {
			x, _ := full.Get(c)
			v.Set(c, x)
		}
		var label *string
		if l, _ := full.Get("subject_label"); l.Kind == jsfmt.String {
			label = &l.Str
		}
		rows = append(rows, vrow{v, label})
		return nil
	}
	if err := sqlitex.Execute(conn, "SELECT * FROM req_verdicts WHERE req_id = ? ORDER BY id DESC LIMIT ?", &sqlitex.ExecOptions{Args: []any{reqID, n}, ResultFunc: collect}); err != nil {
		return jsfmt.Value{}, err
	}
	if include != nil {
		found := false
		for _, r := range rows {
			id, _ := r.v.Get("id")
			found = found || id.Num == strconv.FormatInt(*include, 10)
		}
		if !found {
			if err := sqlitex.Execute(conn, "SELECT * FROM req_verdicts WHERE req_id = ? AND id = ?", &sqlitex.ExecOptions{Args: []any{reqID, *include}, ResultFunc: collect}); err != nil {
				return jsfmt.Value{}, err
			}
		}
	}
	out := jsfmt.Value{Kind: jsfmt.Array}
	if len(rows) == 0 {
		return out, nil
	}
	said := map[string]info{}
	ids := make([]any, len(rows))
	marks := make([]string, len(rows))
	for i, r := range rows {
		label := ""
		if r.label != nil {
			label = *r.label
		}
		subject := r.v.Text("subject")
		k := subject + "\x00" + label
		if _, ok := said[k]; !ok {
			said[k] = s.describe(ctx, conn, subject, r.label)
		}
		in := said[k]
		r.v.Set("label", str(in.label))
		if in.openKind != "" {
			r.v.Set("open", obj("kind", str(in.openKind), "id", str(in.openID)))
		}
		rows[i] = r
		id, _ := r.v.Get("id")
		n, _ := strconv.ParseInt(id.Num, 10, 64)
		ids[i], marks[i] = n, "?"
	}
	waivers := map[string]jsfmt.Value{}
	if err := sqlitex.Execute(conn, "SELECT verdict_id, kind, reason, by, ts FROM req_waivers WHERE verdict_id IN ("+strings.Join(marks, ",")+") ORDER BY id", &sqlitex.ExecOptions{Args: ids, ResultFunc: func(stmt *sqlite.Stmt) error {
		opt := func(i int) jsfmt.Value {
			if stmt.ColumnIsNull(i) {
				return jsfmt.NullValue()
			}
			return str(stmt.ColumnText(i))
		}
		waivers[stmt.ColumnText(0)] = obj("kind", str(stmt.ColumnText(1)), "reason", opt(2), "by", opt(3), "ts", str(stmt.ColumnText(4)))
		return nil
	}}); err != nil {
		return jsfmt.Value{}, err
	}
	for _, r := range rows {
		id, _ := r.v.Get("id")
		w, ok := waivers[id.Num]
		if !ok {
			w = jsfmt.NullValue()
		}
		r.v.Set("waiver", w)
		out.Items = append(out.Items, r.v)
	}
	return out, nil
}

type info struct {
	label            string
	openKind, openID string
}

var reBranch = regexp.MustCompile(`^(?:[^/]+/)?(.+?)(?:@[0-9a-f]{7,})?$`)

// describe is describeSubject: a subject as a person reads it. `stored` is the label kept with the verdict (a pasted
// text's start). A mail or ITSA this daemon does not hold is said by its id.
func (s *Store) describe(ctx context.Context, conn *sqlite.Conn, subject string, stored *string) info {
	kind, rest := "", subject
	if i := strings.Index(subject, ":"); i >= 0 {
		kind, rest = subject[:i], subject[i+1:]
	}
	one := func(query string, args ...any) (row jsfmt.Value, ok bool, err error) {
		err = sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
			if !ok {
				row, ok = rowValue(stmt), true
			}
			return nil
		}})
		return
	}
	switch kind {
	case "mail":
		if m, ok, _ := one("SELECT id, subject, thread_id FROM mail WHERE id = ?", rest); ok {
			label := jsjson.Trim(m.Text("subject"))
			if label == "" {
				label = "mail " + rest
			}
			open := m.Text("thread_id")
			if open == "" {
				open = m.Text("id")
			}
			return info{label, "thread", open}
		}
		return info{label: "mail " + rest}
	case "itsa":
		if it, ok, _ := one("SELECT id, key, title FROM itsas WHERE id = ? OR key = ?", rest, rest); ok {
			return info{it.Text("key") + " " + it.Text("title"), "itsa", it.Text("id")}
		}
		return info{label: rest}
	case "branch":
		if m := reBranch.FindStringSubmatch(rest); m != nil {
			return info{label: m[1]}
		}
		return info{label: rest}
	case "tool":
		return info{label: "tool " + rest}
	case "event":
		n, _ := strconv.ParseFloat(rest, 64)
		e, ok, err := one("SELECT source, summary FROM ext_events WHERE id = ?", n)
		if err != nil {
			// A missing table (no events yet) says the subject by its kind and id.
			return info{label: subject}
		}
		if ok {
			if sum := jsjson.Trim(e.Text("summary")); sum != "" {
				return info{label: Clip(e.Text("summary"), 60)}
			}
		}
		return info{label: jsjson.Trim(e.Text("source") + " event " + rest)}
	case "text":
		if stored != nil && jsjson.Trim(*stored) != "" {
			return info{label: jsjson.Trim(*stored)}
		}
		return info{label: "pasted text"}
	}
	return info{label: subject}
}

var reSpaces = regexp.MustCompile(`[\s\p{Z}\x{feff}]+`)

// Clip is a text's first n characters (UTF-16 units, as JavaScript counts them) on one line, with an ellipsis when it goes on.
func Clip(text string, n int) string {
	one := jsjson.Trim(reSpaces.ReplaceAllString(text, " "))
	u := utf16.Encode([]rune(one))
	if len(u) <= n {
		return one
	}
	return jsjson.TrimEnd(string(utf16.Decode(u[:n-1]))) + "…"
}

// Precision is how well a requirement's flags hold up over its last `violates` verdicts at the current version.
type Precision struct {
	Violates, FalsePositives, AcceptedDeviations int
}

func (p Precision) rate() (float64, bool) {
	if p.Violates == 0 {
		return 0, false
	}
	return float64(p.FalsePositives) / float64(p.Violates), true
}

func (p Precision) value() jsfmt.Value {
	rate := jsfmt.NullValue()
	if r, ok := p.rate(); ok {
		rate = num(r)
	}
	return obj("window", num(PrecisionWindow), "violates", num(float64(p.Violates)), "false_positives", num(float64(p.FalsePositives)),
		"accepted_deviations", num(float64(p.AcceptedDeviations)), "rate", rate, "max_rate", num(PrecisionMaxRate))
}

func precisionConn(conn *sqlite.Conn, x Req) (Precision, error) {
	var p Precision
	err := sqlitex.Execute(conn, `SELECT (SELECT kind FROM req_waivers w WHERE w.verdict_id = v.id ORDER BY w.id DESC LIMIT 1) AS kind
       FROM req_verdicts v WHERE v.req_id = ? AND v.req_version = ? AND v.verdict = 'violates' ORDER BY v.id DESC LIMIT ?`,
		&sqlitex.ExecOptions{Args: []any{x.ID(), x.Version(), PrecisionWindow}, ResultFunc: func(stmt *sqlite.Stmt) error {
			p.Violates++
			if !stmt.ColumnIsNull(0) {
				switch stmt.ColumnText(0) {
				case "false_positive":
					p.FalsePositives++
				case "accepted_deviation":
					p.AcceptedDeviations++
				}
			}
			return nil
		}})
	return p, err
}

// --- writes ---

// assertMayApprove is whether actor may move a requirement from draft to in_force. The human always may; an agent never
// approves its own draft unless approval is `any`; `cos` also allows the chief of staff, `any` anyone.
func (s *Store) assertMayApprove(ctx context.Context, createdBy, actor, textBy string) error {
	if actor == Human {
		return nil
	}
	approval := s.Settings().Requirements.Approval
	if actor == createdBy || (textBy != "" && actor == textBy) {
		if approval == "any" {
			return nil
		}
		if actor == createdBy {
			return Forbidden(fmt.Sprintf("an agent may not approve its own draft (settings.requirements.approval is %s)", approval))
		}
		return Forbidden(fmt.Sprintf("an agent may not approve text it last changed (settings.requirements.approval is %s)", approval))
	}
	if approval == "any" {
		return nil
	}
	if approval == "cos" {
		if cos := s.cosName(); cos != "" {
			id, err := s.Person(ctx, cos)
			if err != nil {
				id = ""
			}
			if actor == id || actor == cos {
				return nil
			}
		}
		return Forbidden("only the chief of staff or the human approves a draft into in_force (settings.requirements.approval is cos)")
	}
	return Forbidden("only the human approves a draft into in_force (settings.requirements.approval is human)")
}

func (s *Store) cosName() string { return s.Settings().ChiefOfStaff }

func validateParent(conn *sqlite.Conn, cur *Req, ref jsjson.Value) (*string, error) {
	raw := ""
	if ref != nil {
		raw = jsjson.ToString(ref)
	}
	if raw == "" || raw == "none" || raw == "root" {
		return nil, nil
	}
	p, err := mustConn(conn, raw)
	if err != nil {
		return nil, err
	}
	if cur != nil {
		if p.ID() == cur.ID() {
			return nil, errors.New("a requirement cannot be its own parent")
		}
		guard := map[string]bool{}
		for n := &p; n != nil && !guard[n.ID()]; {
			if n.ID() == cur.ID() {
				return nil, errors.New("reparenting would create a cycle")
			}
			guard[n.ID()] = true
			if n.ParentID() == "" {
				break
			}
			next, err := findConn(conn, n.ParentID())
			if err != nil {
				return nil, err
			}
			n = next
		}
	}
	id := p.ID()
	return &id, nil
}

func (s *Store) owner(ctx context.Context, in Input) (*string, error) {
	v, set := in("owner")
	if !set {
		return nil, nil
	}
	id, err := s.Person(ctx, v)
	if err != nil || id == "" {
		return nil, err
	}
	return &id, nil
}

func (s *Store) by(ctx context.Context, by string) (string, error) {
	if by == "" {
		return Human, nil
	}
	id, err := s.Person(ctx, by)
	if err != nil {
		return "", err
	}
	if id == "" {
		return Human, nil
	}
	return id, nil
}

func finiteUnit(v jsjson.Value) (float64, bool) {
	t := jsjson.ToNumber(v)
	return t, !math.IsNaN(t) && !math.IsInf(t, 0) && t >= 0 && t <= 1
}

// Validate checks a create input's fields without writing anything or needing requirements on (a batch checks every entry
// before it creates the first). The parent and owner are resolved at create time.
func Validate(in Input) error {
	title, _ := in("title")
	if title == nil || jsjson.Trim(jsjson.ToString(title)) == "" {
		return errors.New("a requirement needs a title")
	}
	if v, set := in("status"); !isBlank(v, set) {
		if _, err := oneOf(Statuses, v, "status"); err != nil {
			return err
		}
	}
	if v, set := in("mode"); !isBlank(v, set) {
		if _, err := oneOf(Modes, v, "mode"); err != nil {
			return err
		}
	}
	if v, set := in("threshold"); set && v != nil {
		if _, ok := finiteUnit(v); !ok {
			return errors.New("the threshold is a number from 0 to 1")
		}
	}
	if v, set := in("severity"); true {
		if _, err := severityOf(v, set, "minor"); err != nil {
			return err
		}
	}
	if v, set := in("verification"); true {
		if _, err := normalizeVerification(v, set); err != nil {
			return err
		}
	}
	v, set := in("scope")
	_, err := normalizeScope(v, set)
	return err
}

// Create adds a requirement. by is the actor's name or id ("" for the human).
func (s *Store) Create(ctx context.Context, in Input, by string) (Req, error) {
	if err := s.ready(ctx); err != nil {
		return Req{}, err
	}
	titleV, _ := in("title")
	title := ""
	if titleV != nil {
		title = jsjson.Trim(jsjson.ToString(titleV))
	}
	if title == "" {
		return Req{}, errors.New("a requirement needs a title")
	}
	set := s.Settings().Requirements
	status := "draft"
	if v, ok := in("status"); !isBlank(v, ok) {
		var err error
		if status, err = oneOf(Statuses, v, "status"); err != nil {
			return Req{}, err
		}
	}
	mode := set.DefaultMode
	if v, ok := in("mode"); !isBlank(v, ok) {
		var err error
		if mode, err = oneOf(Modes, v, "mode"); err != nil {
			return Req{}, err
		}
	}
	threshold := set.DefaultThreshold
	if v, ok := in("threshold"); ok && v != nil {
		t, fine := finiteUnit(v)
		if !fine {
			return Req{}, errors.New("the threshold is a number from 0 to 1")
		}
		threshold = t
	}
	sv, sset := in("severity")
	severity, err := severityOf(sv, sset, "minor")
	if err != nil {
		return Req{}, err
	}
	vv, vset := in("verification")
	verification, err := normalizeVerification(vv, vset)
	if err != nil {
		return Req{}, err
	}
	cv, cset := in("scope")
	scope, err := normalizeScope(cv, cset)
	if err != nil {
		return Req{}, err
	}
	owner, err := s.owner(ctx, in)
	if err != nil {
		return Req{}, err
	}
	actor, err := s.by(ctx, by)
	if err != nil {
		return Req{}, err
	}
	if actor != Human && (status == "in_force" || status == "suspended") && set.Approval != "any" {
		return Req{}, Forbidden(fmt.Sprintf("an agent can't create a requirement as %s (settings.requirements.approval is %s): create a draft and get it approved", status, set.Approval))
	}
	if status == "in_force" {
		if err := s.assertMayApprove(ctx, "", actor, ""); err != nil {
			return Req{}, err
		}
	}
	id, err := newID()
	if err != nil {
		return Req{}, err
	}
	var created Req
	err = s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		var parent *string
		if pv, pset := in("parent"); !isBlank(pv, pset) {
			var err error
			if parent, err = validateParent(conn, nil, pv); err != nil {
				return err
			}
		}
		key, err := s.nextKey(conn)
		if err != nil {
			return err
		}
		t := now()
		level, _ := in("level")
		text, _ := in("text")
		rationale, _ := in("rationale")
		source, _ := in("source")
		if err := sqlitex.Execute(conn, `INSERT INTO requirements (id, key, parent_id, level, title, text, rationale, source, verification, scope, severity, mode, threshold, status, owner, version, created_by, text_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`, &sqlitex.ExecOptions{Args: []any{
			id, key, ptr(parent), ptr(trimmedOrNull(level)), title, ptr(textOrNull(text)), ptr(textOrNull(rationale)), ptr(textOrNull(source)),
			jsonText(verification), jsonText(scope), severity, mode, threshold, status, ptr(owner), actor, actor, t, t}}); err != nil {
			return err
		}
		c, err := mustConn(conn, id)
		created = c
		return err
	})
	if err == nil {
		s.DropIndex()
	}
	return created, err
}

func ptr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// Batch creates drafts, parents first. Every entry is checked before the first is created, so a bad file creates nothing.
func (s *Store) Batch(ctx context.Context, entries jsjson.Value, by string) ([]Req, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	list, ok := entries.([]any)
	if !ok || len(list) == 0 {
		return nil, errors.New("a batch is a non-empty list of requirements")
	}
	if len(list) > BatchMax {
		return nil, fmt.Errorf("a batch holds at most %d requirements", BatchMax)
	}
	objs := make([]*jsjson.Object, len(list))
	refs := map[string]int{}
	// raw is a template literal's `${x}`: undefined for an absent field.
	raw := func(o *jsjson.Object, k string) string {
		v, ok := o.Get(k)
		if !ok {
			return "undefined"
		}
		return jsjson.ToString(v)
	}
	for i, e := range list {
		o, ok := e.(*jsjson.Object)
		if !ok {
			return nil, fmt.Errorf("entry %d is not an object", i+1)
		}
		objs[i] = o
		if err := Validate(Input(o.Get)); err != nil {
			name := ""
			if t, _ := o.Get("title"); t != nil {
				name = jsjson.Trim(jsjson.ToString(t))
			}
			if name == "" {
				name = "no title"
			}
			return nil, fmt.Errorf("entry %d (%s): %s", i+1, name, err.Error())
		}
		if st, set := o.Get("status"); !(!set || st == nil || st == "" || st == "draft") {
			return nil, fmt.Errorf("entry %d (%s): a batch creates drafts only", i+1, raw(o, "title"))
		}
		if rv, set := o.Get("ref"); set {
			r := jsjson.ToString(rv)
			if _, dup := refs[r]; r == "" || dup {
				why := "empty"
				if r != "" {
					why = "used twice"
				}
				shown := r
				if r == "" {
					shown = "(empty)"
				}
				return nil, fmt.Errorf("entry %d (%s): ref %s is %s", i+1, raw(o, "title"), shown, why)
			}
			refs[r] = i
		}
	}
	for i, o := range objs {
		pv, _ := o.Get("parent")
		if pv == nil || pv == "" {
			continue
		}
		p := jsjson.ToString(pv)
		if _, local := refs[p]; local {
			continue
		}
		found, err := s.Find(ctx, p)
		if err != nil {
			return nil, err
		}
		if found == nil {
			return nil, fmt.Errorf("entry %d (%s): no parent %s in the batch or the tree", i+1, raw(o, "title"), p)
		}
	}
	var order []int
	state := map[int]string{}
	var visit func(i int) error
	visit = func(i int) error {
		switch state[i] {
		case "done":
			return nil
		case "walking":
			return fmt.Errorf("entry %d (%s): the parent refs form a cycle", i+1, raw(objs[i], "title"))
		}
		state[i] = "walking"
		if pv, _ := objs[i].Get("parent"); pv != nil {
			if p, ok := refs[jsjson.ToString(pv)]; ok {
				if err := visit(p); err != nil {
					return err
				}
			}
		}
		state[i] = "done"
		order = append(order, i)
		return nil
	}
	for i := range objs {
		if err := visit(i); err != nil {
			return nil, err
		}
	}
	keyOf := map[string]string{}
	var made []Req
	for _, i := range order {
		o := objs[i]
		parent := jsjson.Value(nil)
		if pv, _ := o.Get("parent"); pv != nil && pv != "" {
			p := jsjson.ToString(pv)
			if k, ok := keyOf[p]; ok {
				parent = k
			} else {
				parent = p
			}
		}
		in := Input(func(k string) (jsjson.Value, bool) {
			switch k {
			case "parent":
				return parent, true
			case "status":
				return "draft", true
			case "ref":
				return nil, false
			}
			return o.Get(k)
		})
		r, err := s.Create(ctx, in, by)
		if err != nil {
			return nil, err
		}
		if rv, set := o.Get("ref"); set {
			keyOf[jsjson.ToString(rv)] = r.Key()
		}
		made = append(made, r)
	}
	return made, nil
}

// Editable are the fields Set edits besides status and the revision guard.
var editable = []string{"title", "text", "rationale", "source", "parent", "level", "severity", "mode", "threshold", "verification", "scope", "owner"}

// SetResult is a requirement after Set and what changed.
type SetResult struct {
	Requirement Req
	Changes     jsfmt.Value
}

// Set changes a requirement: the fields the input has, the rest as they were. The read, the checks and the write are one
// transaction, so an edit that lands between them is seen (ifRev) rather than overwritten.
func (s *Store) Set(ctx context.Context, ref string, in Input, by string) (SetResult, error) {
	if err := s.ready(ctx); err != nil {
		return SetResult{}, err
	}
	actor, err := s.by(ctx, by)
	if err != nil {
		return SetResult{}, err
	}
	var res SetResult
	ifRev, hasIfRev := in("ifRev")
	err = s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		cur, err := mustConn(conn, ref)
		if err != nil {
			return err
		}
		set := s.Settings().Requirements
		changes := jsfmt.Value{Kind: jsfmt.Object}
		type col struct {
			name string
			val  any
		}
		var upd []col
		change := func(name string, from, to jsfmt.Value) { changes.Set(name, obj("from", from, "to", to)) }
		curField := func(k string) jsfmt.Value { v, _ := cur.Get(k); return v }
		stringField := func(name string, v jsjson.Value, present bool, transform func(jsjson.Value) *string) {
			if !present {
				return
			}
			next := transform(v)
			cv := curField(name)
			same := (next == nil && cv.Kind == jsfmt.Null) || (next != nil && cv.Kind == jsfmt.String && cv.Str == *next)
			if !same {
				upd = append(upd, col{name, ptr(next)})
				change(name, cv, optStr(next))
			}
		}
		get := func(k string) (jsjson.Value, bool) { return in(k) }

		if v, ok := get("title"); ok {
			title := ""
			if v != nil {
				title = jsjson.Trim(jsjson.ToString(v))
			}
			if title == "" {
				return errors.New("a requirement needs a title")
			}
			if title != cur.Text("title") {
				upd = append(upd, col{"title", title})
				change("title", curField("title"), str(title))
			}
		}
		lv, lok := get("level")
		stringField("level", lv, lok, trimmedOrNull)
		tv, tok := get("text")
		stringField("text", tv, tok, textOrNull)
		rv, rok := get("rationale")
		stringField("rationale", rv, rok, textOrNull)
		sv, sok := get("source")
		stringField("source", sv, sok, textOrNull)
		if v, ok := get("severity"); ok {
			severity, err := severityOf(v, true, "minor")
			if err != nil {
				return err
			}
			if severity != cur.Text("severity") {
				upd = append(upd, col{"severity", severity})
				change("severity", curField("severity"), str(severity))
			}
		}
		if v, ok := get("mode"); ok {
			mode, err := oneOf(Modes, v, "mode")
			if err != nil {
				return err
			}
			if mode != cur.Text("mode") {
				upd = append(upd, col{"mode", mode})
				change("mode", curField("mode"), str(mode))
			}
		}
		if v, ok := get("threshold"); ok {
			t, fine := finiteUnit(v)
			if !fine {
				return errors.New("the threshold is a number from 0 to 1")
			}
			if t != cur.float("threshold") {
				upd = append(upd, col{"threshold", t})
				change("threshold", curField("threshold"), num(t))
			}
		}
		agent := actor != Human
		if v, ok := get("status"); ok {
			status, err := oneOf(Statuses, v, "status")
			if err != nil {
				return err
			}
			if status != cur.Status() {
				if status == "in_force" {
					if err := s.assertMayApprove(ctx, cur.CreatedBy(), actor, cur.TextBy()); err != nil {
						return err
					}
					if agent {
						if !hasIfRev {
							return Forbidden(fmt.Sprintf("an agent moves a requirement to in_force only by naming the revision it approves (if_rev, the rev shown in req_get and in the ask; %s is at rev %d)", cur.Key(), cur.Rev()))
						}
						for _, k := range editable {
							if _, present := get(k); present {
								return Forbidden("an agent can not edit a requirement and approve it in one call: set status=in_force on its own, naming the rev")
							}
						}
					}
				}
				upd = append(upd, col{"status", status})
				change("status", curField("status"), str(status))
			}
		}
		if _, ok := get("owner"); ok {
			owner, err := s.owner(ctx, in)
			if err != nil {
				return err
			}
			if (owner == nil) != (curField("owner").Kind == jsfmt.Null) || (owner != nil && *owner != cur.Owner()) {
				upd = append(upd, col{"owner", ptr(owner)})
				change("owner", curField("owner"), optStr(owner))
			}
		}
		if pv, ok := get("parent"); ok {
			parentID, err := validateParent(conn, &cur, pv)
			if err != nil {
				return err
			}
			if (parentID == nil) != (curField("parent_id").Kind == jsfmt.Null) || (parentID != nil && *parentID != cur.ParentID()) {
				upd = append(upd, col{"parent_id", ptr(parentID)})
				change("parent", curField("parent_id"), optStr(parentID))
			}
		}
		if vv, ok := get("verification"); ok {
			verification, err := normalizeVerification(vv, true)
			if err != nil {
				return err
			}
			if compactOrNull(verification) != jsfmt.Compact(curField("verification")) {
				upd = append(upd, col{"verification", jsonText(verification)})
				change("verification", curField("verification"), valueOrNull(verification))
			}
		}
		if cv, ok := get("scope"); ok {
			scope, err := normalizeScope(cv, true)
			if err != nil {
				return err
			}
			if compactOrNull(scope) != jsfmt.Compact(curField("scope")) {
				upd = append(upd, col{"scope", jsonText(scope)})
				change("scope", curField("scope"), valueOrNull(scope))
			}
		}
		_, textChanged := changes.Get("text")
		_, scopeChanged := changes.Get("scope")
		live := cur.Status() == "in_force" || cur.Status() == "suspended"
		if (textChanged || scopeChanged) && agent && set.Approval != "any" && live {
			what := "scope"
			if textChanged {
				what = "text"
			}
			owner := cur.Owner()
			if owner == "" {
				owner = "your user"
			}
			return Forbidden(fmt.Sprintf("an agent can't change the %s of %s while it is %s (settings.requirements.approval is %s). Create a new draft with req_create, link it to %s with role refines, and mail the owner (%s).", what, cur.Key(), cur.Status(), set.Approval, cur.Key(), owner))
		}
		_, modeChanged := changes.Get("mode")
		_, thresholdChanged := changes.Get("threshold")
		_, severityChanged := changes.Get("severity")
		if (modeChanged || thresholdChanged || severityChanged) && agent && set.Approval != "any" && live {
			what := "severity"
			if modeChanged {
				what = "mode"
			} else if thresholdChanged {
				what = "threshold"
			}
			owner := cur.Owner()
			if owner == "" {
				owner = "your user"
			}
			return Forbidden(fmt.Sprintf("an agent can't change the %s of %s while it is %s (settings.requirements.approval is %s). Ask the owner (%s).", what, cur.Key(), cur.Status(), set.Approval, owner))
		}
		if textChanged || scopeChanged {
			upd = append(upd, col{"text_by", actor}, col{"version", cur.Version() + 1})
			change("version", jsfmt.IntValue(cur.Version()), jsfmt.IntValue(cur.Version()+1))
		}
		if n, isNum := ifRev.(float64); hasIfRev && (!isNum || n != float64(cur.Rev())) {
			return fmt.Errorf("%s changed since it was shown (rev %d, not %s)", cur.Key(), cur.Rev(), jsjson.ToString(ifRev))
		}
		if len(upd) > 0 {
			sets := make([]string, len(upd))
			args := make([]any, 0, len(upd)+2)
			for i, c := range upd {
				sets[i] = c.name + " = ?"
				args = append(args, c.val)
			}
			args = append(args, now(), cur.ID())
			if err := sqlitex.Execute(conn, "UPDATE requirements SET "+strings.Join(sets, ", ")+", rev = rev + 1, updated_at = ? WHERE id = ?", &sqlitex.ExecOptions{Args: args}); err != nil {
				return err
			}
		}
		after, err := mustConn(conn, cur.ID())
		res = SetResult{after, changes}
		return err
	})
	if err == nil {
		s.DropIndex()
	}
	return res, err
}

func compactOrNull(v *jsfmt.Value) string {
	if v == nil {
		return "null"
	}
	return jsfmt.Compact(*v)
}

func valueOrNull(v *jsfmt.Value) jsfmt.Value {
	if v == nil {
		return jsfmt.NullValue()
	}
	return *v
}

// --- links ---

func normalizeLink(in Input) (kind, target, role string, err error) {
	kv, kset := in("target_kind")
	kind = "url"
	if !isBlank(kv, kset) {
		if kind, err = oneOf(TargetKinds, kv, "target kind"); err != nil {
			return
		}
	}
	tv, _ := in("target")
	if tv != nil {
		target = jsjson.Trim(jsjson.ToString(tv))
	}
	if target == "" {
		err = errors.New("a link needs a target")
		return
	}
	rv, rset := in("role")
	role = "implements"
	if !isBlank(rv, rset) {
		role, err = oneOf(LinkRoles, rv, "link role")
	}
	return
}

// AddLink links a requirement to something.
func (s *Store) AddLink(ctx context.Context, ref string, in Input) (jsfmt.Value, error) {
	if err := s.ready(ctx); err != nil {
		return jsfmt.Value{}, err
	}
	var out jsfmt.Value
	err := s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		x, err := mustConn(conn, ref)
		if err != nil {
			return err
		}
		kind, target, role, err := normalizeLink(in)
		if err != nil {
			return err
		}
		if err := sqlitex.Execute(conn, "INSERT INTO req_links (req_id, target_kind, target, role, created_at) VALUES (?, ?, ?, ?, ?)", &sqlitex.ExecOptions{Args: []any{x.ID(), kind, target, role, now()}}); err != nil {
			return err
		}
		out = obj("id", jsfmt.IntValue(conn.LastInsertRowID()), "target_kind", str(kind), "target", str(target), "role", str(role))
		return nil
	})
	return out, err
}

// RemoveLink deletes a link of a requirement.
func (s *Store) RemoveLink(ctx context.Context, ref string, id int64) error {
	if err := s.ready(ctx); err != nil {
		return err
	}
	return s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		x, err := mustConn(conn, ref)
		if err != nil {
			return err
		}
		if err := sqlitex.Execute(conn, "DELETE FROM req_links WHERE req_id = ? AND id = ?", &sqlitex.ExecOptions{Args: []any{x.ID(), id}}); err != nil {
			return err
		}
		if conn.Changes() == 0 {
			return fmt.Errorf("no link %d on %s", id, x.Key())
		}
		return nil
	})
}

// --- waivers ---

// Waive marks a verdict a false positive or an accepted deviation, with a reason. When the waiver tips the requirement's
// precision over the limit it drops to observe (a `req:demoted` event) and its owner hears of it (Store.Demoted), once.
func (s *Store) Waive(ctx context.Context, in Input, by string) (jsfmt.Value, error) {
	if err := s.ready(ctx); err != nil {
		return jsfmt.Value{}, err
	}
	idV, idSet := in("verdict_id")
	idN := math.NaN()
	if idSet {
		idN = jsjson.ToNumber(idV)
	}
	if math.IsNaN(idN) || math.IsInf(idN, 0) || idN != math.Trunc(idN) {
		return jsfmt.Value{}, errors.New("verdict_id is the number of a verdict (see req_get)")
	}
	id := int64(idN)
	kv, _ := in("kind")
	kind, err := oneOf(WaiverKinds, kv, "kind")
	if err != nil {
		return jsfmt.Value{}, err
	}
	rv, _ := in("reason")
	reason := trimmedOrNull(rv)
	if reason == nil {
		return jsfmt.Value{}, errors.New("a waiver needs a reason")
	}
	var out jsfmt.Value
	var demoted *Demotion
	err = s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		reqID, found := "", false
		if err := sqlitex.Execute(conn, "SELECT req_id FROM req_verdicts WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error {
			reqID, found = stmt.ColumnText(0), true
			return nil
		}}); err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("no verdict %d", id)
		}
		actor, err := s.by(ctx, by)
		if err != nil {
			return err
		}
		t := now()
		if err := sqlitex.Execute(conn, "INSERT INTO req_waivers (verdict_id, kind, reason, by, ts) VALUES (?, ?, ?, ?, ?)", &sqlitex.ExecOptions{Args: []any{id, kind, *reason, actor, t}}); err != nil {
			return err
		}
		out = obj("id", jsfmt.IntValue(conn.LastInsertRowID()), "verdict_id", jsfmt.IntValue(id), "kind", str(kind), "reason", str(*reason), "by", str(actor), "ts", str(t))
		var derr error
		demoted, derr = s.demoteIfImprecise(conn, reqID)
		return derr
	})
	if err == nil && demoted != nil {
		s.DropIndex()
		if demoted.Owner != "" && s.Demoted != nil {
			if derr := s.Demoted(ctx, demoted.Owner, demoted.Key, demoted.Text); derr != nil {
				s.logError(ctx, "requirement", demoted.ID, "error", "precision: "+derr.Error())
			}
		}
	}
	return out, err
}

// Demotion is a requirement a waiver dropped to observe: who hears of it and what they are told.
type Demotion struct{ ID, Owner, Key, Text string }

// demoteIfImprecise: when more than PrecisionMaxRate of a requirement's last PrecisionWindow flags were waived as false
// positives (once it has settings.requirements.demoteMinFlags flags), it drops to observe, once. Only an in-force
// requirement that is not observing already is demoted.
func (s *Store) demoteIfImprecise(conn *sqlite.Conn, reqID string) (*Demotion, error) {
	x, err := findConn(conn, reqID)
	if err != nil || x == nil || x.Status() != "in_force" || x.Text("mode") == "observe" {
		return nil, err
	}
	p, err := precisionConn(conn, *x)
	if err != nil {
		return nil, err
	}
	rate, ok := p.rate()
	if !ok || p.Violates < s.Settings().Requirements.DemoteMinFlags || rate <= PrecisionMaxRate {
		return nil, nil
	}
	if err := sqlitex.Execute(conn, "UPDATE requirements SET mode = 'observe', rev = rev + 1, updated_at = ? WHERE id = ? AND mode != 'observe' AND version = ? AND status = 'in_force'", &sqlitex.ExecOptions{Args: []any{now(), x.ID(), x.Version()}}); err != nil {
		return nil, err
	}
	if conn.Changes() == 0 {
		return nil, nil
	}
	data := obj("requirement", str(x.Key()), "from", str(x.Text("mode")), "rate", num(rate), "false_positives", num(float64(p.FalsePositives)), "violates", num(float64(p.Violates)), "window", num(PrecisionWindow))
	if err := sqlitex.Execute(conn, "INSERT INTO events (agent_id, ts, type, data) VALUES ('stam', ?, 'req:demoted', ?)", &sqlitex.ExecOptions{Args: []any{now(), jsfmt.Compact(data)}}); err != nil {
		return nil, err
	}
	round := func(f float64) int { return int(math.Floor(f + 0.5)) }
	text := fmt.Sprintf("%s dropped to observe: %d of its last %d flags were waived as false positives (%d%%, limit %d%%). To reword it so the model flags only real violations, write a new draft with req_create and link it to this one with the role refines, or ask the human; a new text starts a new count.",
		x.Key(), p.FalsePositives, p.Violates, round(rate*100), round(PrecisionMaxRate*100))
	return &Demotion{ID: x.ID(), Owner: x.Owner(), Key: x.Key(), Text: text}, nil
}

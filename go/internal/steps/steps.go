// Package steps is src/steps.ts: decision steps, custom yes/no checks the human writes in their own words. A step has a trigger
// (a tool call or a stam event), a question asked of the decision model (go/internal/decide) as a noul question, a threshold
// and an action; "yes" means P(yes) >= threshold. Tool steps are checked by CheckTool before a tool runs and fail open: a
// model error allows the call. Every run is a row of step_decisions; the cost goes to usage as `decide:step:<id>`.
//
// Ported: the steps and their log, the tool check with the tool-call history, and the preview. Not ported: the event
// triggers (mail-to-human, itsa-created, itsa-status, agent-spawned) never fire here, because the hooks they hang on are not
// ported; the daemon refuses the writes that would have fired one while an enabled event step exists (server/steps.go
// spawnStepRefusal and server/itsa_observers.go), so no event is silently missed.
package steps

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/db"
	"stam/internal/decide"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// Events are the stam events a step may trigger on.
var Events = []string{"mail-to-human", "itsa-created", "itsa-status", "agent-spawned"}

var (
	toolActions  = []string{"approve-if-yes", "deny-if-yes"}
	eventActions = []string{"flag", "notify", "annotate"}
	toolName     = regexp.MustCompile(`^[\w.:\-]{1,128}$`)
)

const (
	defaultThreshold = 0.5
	previewMax       = 20
	// toolTimeout is a tool check's model call: short, since the caller waits for it before the tool runs.
	toolTimeout = 5 * time.Second
	// ToolBudget is the whole check, under mcp's 8 s: a step not reached in time is failed open, so a denial is never logged
	// after the caller has already run the tool.
	ToolBudget  = 7 * time.Second
	toolHistory = 50
	toolArgsMax = 4096
	truncated   = "…[truncated]"
	human       = "human"
)

var argStringCaps = []int{1024, 512, 256, 128, 64, 16, 0}

// Asker is the decision model: *decide.Client.
type Asker interface {
	Decide(ctx context.Context, state jsjson.Value, questions []decide.Named, purpose string, timeout time.Duration) (*decide.Result, *decide.Failure)
}

// Store is the steps of one daemon.
type Store struct {
	DB  *db.DB
	Ask Asker

	// mu guards made: the tables are made once, but a failed attempt (a busy database) is tried again by the next call.
	mu   sync.Mutex
	made bool
	// makeTables creates the tables; nil is the DDL. A test replaces it.
	makeTables func(ctx context.Context) error
}

// ErrNoStep is a step that is not there: its text is `no step ID`, which the routes answer 404.
type ErrNoStep string

func (e ErrNoStep) Error() string { return "no step " + string(e) }

// The tables live here rather than in the schema, as in TS, and are made on first use.
const ddl = `
    CREATE TABLE IF NOT EXISTS decision_steps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trigger TEXT NOT NULL,
      question TEXT NOT NULL,
      threshold REAL NOT NULL DEFAULT 0.5,
      action TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      builtin TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS step_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      step_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      subject TEXT NOT NULL,
      p REAL,
      answer INTEGER,
      action TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS step_decisions_step ON step_decisions (step_id, id);
    CREATE INDEX IF NOT EXISTS step_decisions_subject ON step_decisions (subject, id);
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      agent TEXT NOT NULL,
      tool TEXT NOT NULL,
      args TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tool_calls_tool ON tool_calls (tool, id);
  `

func (s *Store) table(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.made {
		return nil
	}
	make := s.makeTables
	if make == nil {
		make = func(ctx context.Context) error {
			return s.DB.Write(ctx, func(conn *sqlite.Conn) error { return sqlitex.ExecuteScript(conn, ddl, nil) })
		}
	}
	if err := make(context.WithoutCancel(ctx)); err != nil {
		return err
	}
	s.made = true
	return nil
}

func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// Step is one decision step.
type Step struct {
	ID, Name    string
	Kind        string // "tool" or "event"
	Tool, Event string
	Question    string
	Threshold   float64
	Action      string
	Enabled     bool
	Builtin     *string
	CreatedAt   string
	UpdatedAt   string
}

func str(s string) jsfmt.Value { return jsfmt.StringValue(s) }
func num(f float64) jsfmt.Value {
	return jsfmt.Value{Kind: jsfmt.Number, Num: jsjson.Number(f)}
}
func obj(pairs ...any) jsfmt.Value {
	v := jsfmt.Value{Kind: jsfmt.Object}
	for i := 0; i+1 < len(pairs); i += 2 {
		v.Keys = append(v.Keys, pairs[i].(string))
		v.Items = append(v.Items, pairs[i+1].(jsfmt.Value))
	}
	return v
}
func boolean(b bool) jsfmt.Value { return jsfmt.Value{Kind: jsfmt.Bool, Bool: b} }

// Value is the step as the API shows it: the columns in order, the trigger as an object and enabled as a boolean.
func (st Step) Value() jsfmt.Value {
	var trigger jsfmt.Value
	if st.Kind == "tool" {
		trigger = obj("kind", str("tool"), "tool", str(st.Tool))
	} else {
		trigger = obj("kind", str("event"), "event", str(st.Event))
	}
	builtin := jsfmt.NullValue()
	if st.Builtin != nil {
		builtin = str(*st.Builtin)
	}
	return obj("id", str(st.ID), "name", str(st.Name), "trigger", trigger, "question", str(st.Question), "threshold", num(st.Threshold), "action", str(st.Action),
		"enabled", boolean(st.Enabled), "builtin", builtin, "created_at", str(st.CreatedAt), "updated_at", str(st.UpdatedAt))
}

const stepCols = "id, name, trigger, question, threshold, action, enabled, builtin, created_at, updated_at"

func scanStep(stmt *sqlite.Stmt) (Step, error) {
	st := Step{ID: stmt.ColumnText(0), Name: stmt.ColumnText(1), Question: stmt.ColumnText(3), Threshold: stmt.ColumnFloat(4), Action: stmt.ColumnText(5),
		Enabled: stmt.ColumnInt(6) != 0, CreatedAt: stmt.ColumnText(8), UpdatedAt: stmt.ColumnText(9)}
	if !stmt.ColumnIsNull(7) {
		b := stmt.ColumnText(7)
		st.Builtin = &b
	}
	t, err := jsfmt.Parse([]byte(stmt.ColumnText(2)))
	if err != nil {
		return st, fmt.Errorf("step %s: its trigger is not JSON", st.ID)
	}
	st.Kind = t.Text("kind")
	st.Tool, st.Event = t.Text("tool"), t.Text("event")
	return st, nil
}

// List is the steps by creation.
func (s *Store) List(ctx context.Context) ([]Step, error) {
	if err := s.table(ctx); err != nil {
		return nil, err
	}
	var out []Step
	err := s.DB.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT "+stepCols+" FROM decision_steps ORDER BY created_at, id", &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
			st, err := scanStep(stmt)
			out = append(out, st)
			return err
		}})
	})
	return out, err
}

// Get is the step with the id, or nil.
func (s *Store) Get(ctx context.Context, id string) (*Step, error) {
	if err := s.table(ctx); err != nil {
		return nil, err
	}
	var out *Step
	err := s.DB.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT "+stepCols+" FROM decision_steps WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error {
			st, err := scanStep(stmt)
			out = &st
			return err
		}})
	})
	return out, err
}

// Must is the step, else ErrNoStep.
func (s *Store) Must(ctx context.Context, id string) (Step, error) {
	st, err := s.Get(ctx, id)
	if err != nil {
		return Step{}, err
	}
	if st == nil {
		return Step{}, ErrNoStep(id)
	}
	return *st, nil
}

// Input is a step's fields as a request gave them: Get returns a field and whether the body had it, so a null and a missing
// field can be told apart where TS does.
type Input func(key string) (jsjson.Value, bool)

// Invalid is a step input that fails validation: its text is the route's 400.
type Invalid string

func (e Invalid) Error() string { return string(e) }

func nullish(v jsjson.Value, set bool) bool { return !set || v == nil }

// jsString is String(v).
func jsString(v jsjson.Value) string { return jsjson.ToString(v) }

// JSNumber is Number(v) for a request value (a string, number, boolean, null or array).
func JSNumber(v jsjson.Value) float64 { return jsjson.ToNumber(v) }

func jsNumber(v jsjson.Value) float64 { return jsjson.ToNumber(v) }

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// validate checks a whole step, filled in from cur where the input leaves a field out. Tool names are checked loosely (an
// MCP-style name), since the catalogue is another change's.
func validate(in Input, cur *Step) (Step, error) {
	get := func(k string) (jsjson.Value, bool) { return in(k) }
	name := ""
	if v, set := get("name"); !nullish(v, set) {
		name = jsString(v)
	} else if cur != nil {
		name = cur.Name
	}
	name = jsjson.Trim(name)
	if name == "" {
		return Step{}, Invalid("a step needs a name")
	}
	question := ""
	if v, set := get("question"); !nullish(v, set) {
		question = jsString(v)
	} else if cur != nil {
		question = cur.Question
	}
	question = jsjson.Trim(question)
	if question == "" {
		return Step{}, Invalid("a step needs a question")
	}
	out := Step{Name: name, Question: question}
	tv, tset := get("trigger")
	var kind, tool, event jsjson.Value
	if !nullish(tv, tset) {
		if o, ok := tv.(*jsjson.Object); ok {
			kind, _ = o.Get("kind")
			tool, _ = o.Get("tool")
			event, _ = o.Get("event")
		}
	} else if cur != nil {
		kind, tool, event = cur.Kind, cur.Tool, cur.Event
	}
	toolStr, toolIsStr := tool.(string)
	eventStr, eventIsStr := event.(string)
	switch {
	case kind == "tool" && toolIsStr && toolName.MatchString(toolStr):
		out.Kind, out.Tool = "tool", toolStr
	case kind == "event" && eventIsStr && contains(Events, eventStr):
		out.Kind, out.Event = "event", eventStr
	default:
		return Step{}, Invalid("a trigger is {kind: 'tool', tool: NAME} or {kind: 'event', event: E}, E one of " + strings.Join(Events, ", "))
	}
	out.Threshold = defaultThreshold
	if v, set := get("threshold"); nullish(v, set) {
		if cur != nil {
			out.Threshold = cur.Threshold
		}
	} else {
		out.Threshold = jsNumber(v)
	}
	if math.IsNaN(out.Threshold) || math.IsInf(out.Threshold, 0) || out.Threshold < 0 || out.Threshold > 1 {
		return Step{}, Invalid("the threshold is a number from 0 to 1")
	}
	allowed := toolActions
	if out.Kind == "event" {
		allowed = eventActions
	}
	action := allowed[0]
	if v, set := get("action"); !nullish(v, set) {
		action = jsString(v)
	} else if cur != nil && contains(allowed, cur.Action) {
		action = cur.Action
	}
	if !contains(allowed, action) {
		return Step{}, Invalid(fmt.Sprintf("a %s step's action is one of %s", out.Kind, strings.Join(allowed, ", ")))
	}
	out.Action = action
	out.Enabled = true
	if v, set := get("enabled"); !set {
		if cur != nil {
			out.Enabled = cur.Enabled
		}
	} else {
		out.Enabled = jsjson.Truthy(v)
	}
	return out, nil
}

func triggerJSON(st Step) string {
	if st.Kind == "tool" {
		return jsfmt.Compact(obj("kind", str("tool"), "tool", str(st.Tool)))
	}
	return jsfmt.Compact(obj("kind", str("event"), "event", str(st.Event)))
}

// Create adds a step; builtin names a built-in one.
func (s *Store) Create(ctx context.Context, in Input, builtin *string) (Step, error) {
	if err := s.table(ctx); err != nil {
		return Step{}, err
	}
	v, err := validate(in, nil)
	if err != nil {
		return Step{}, err
	}
	var rnd [4]byte
	if _, err := crand.Read(rnd[:]); err != nil {
		return Step{}, err
	}
	v.ID = "st" + hex.EncodeToString(rnd[:])
	t := now()
	var b any
	if builtin != nil {
		b = *builtin
	}
	err = s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "INSERT INTO decision_steps (id, name, trigger, question, threshold, action, enabled, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			&sqlitex.ExecOptions{Args: []any{v.ID, v.Name, triggerJSON(v), v.Question, v.Threshold, v.Action, boolInt(v.Enabled), b, t, t}})
	})
	if err != nil {
		return Step{}, err
	}
	return s.Must(ctx, v.ID)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Update changes a step: the fields the input has, the rest as they were. Read, validate and write are one transaction
// (the compare-and-set a concurrent update needs): the validation sees the row it replaces.
func (s *Store) Update(ctx context.Context, id string, in Input) (Step, error) {
	if err := s.table(ctx); err != nil {
		return Step{}, err
	}
	err := s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		var cur *Step
		if err := sqlitex.Execute(conn, "SELECT "+stepCols+" FROM decision_steps WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error {
			st, err := scanStep(stmt)
			cur = &st
			return err
		}}); err != nil {
			return err
		}
		if cur == nil {
			return ErrNoStep(id)
		}
		v, err := validate(in, cur)
		if err != nil {
			return err
		}
		return sqlitex.Execute(conn, "UPDATE decision_steps SET name = ?, trigger = ?, question = ?, threshold = ?, action = ?, enabled = ?, updated_at = ? WHERE id = ?",
			&sqlitex.ExecOptions{Args: []any{v.Name, triggerJSON(v), v.Question, v.Threshold, v.Action, boolInt(v.Enabled), now(), id}})
	})
	if err != nil {
		return Step{}, err
	}
	return s.Must(ctx, id)
}

// Remove deletes a step; a built-in one can only be turned off.
func (s *Store) Remove(ctx context.Context, id string) error {
	if err := s.table(ctx); err != nil {
		return err
	}
	return s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		var cur *Step
		if err := sqlitex.Execute(conn, "SELECT "+stepCols+" FROM decision_steps WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error {
			st, err := scanStep(stmt)
			cur = &st
			return err
		}}); err != nil {
			return err
		}
		if cur == nil {
			return ErrNoStep(id)
		}
		if cur.Builtin != nil {
			return Invalid(fmt.Sprintf("step %s is built in; turn it off instead", cur.Name))
		}
		return sqlitex.Execute(conn, "DELETE FROM decision_steps WHERE id = ?", &sqlitex.ExecOptions{Args: []any{id}})
	})
}

// --- The log ---

// Log is a step's decisions, newest first; DecisionsOn a subject's, every step's.
func (s *Store) Log(ctx context.Context, stepID string, limit int64) (jsfmt.Value, error) {
	return s.decisions(ctx, "step_id", stepID, limit)
}

func (s *Store) DecisionsOn(ctx context.Context, subject string, limit int64) (jsfmt.Value, error) {
	return s.decisions(ctx, "subject", subject, limit)
}

func (s *Store) decisions(ctx context.Context, col, val string, limit int64) (jsfmt.Value, error) {
	if err := s.table(ctx); err != nil {
		return jsfmt.Value{}, err
	}
	out := jsfmt.Value{Kind: jsfmt.Array}
	err := s.DB.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT id, step_id, ts, subject, p, answer, action, error FROM step_decisions WHERE "+col+" = ? ORDER BY id DESC LIMIT ?", &sqlitex.ExecOptions{
			Args: []any{val, limit}, ResultFunc: func(stmt *sqlite.Stmt) error {
				p, answer, errv := jsfmt.NullValue(), jsfmt.NullValue(), jsfmt.NullValue()
				if !stmt.ColumnIsNull(4) {
					p = num(stmt.ColumnFloat(4))
				}
				if !stmt.ColumnIsNull(5) {
					answer = boolean(stmt.ColumnInt(5) != 0)
				}
				if !stmt.ColumnIsNull(7) {
					errv = str(stmt.ColumnText(7))
				}
				out.Items = append(out.Items, obj("id", num(float64(stmt.ColumnInt64(0))), "step_id", str(stmt.ColumnText(1)), "ts", str(stmt.ColumnText(2)), "subject", str(stmt.ColumnText(3)),
					"p", p, "answer", answer, "action", str(stmt.ColumnText(6)), "error", errv))
				return nil
			}})
	})
	return out, err
}

func (s *Store) record(ctx context.Context, stepID, subject string, p *float64, answer *bool, action string, errText *string) {
	var pa, aa, ea any
	if p != nil {
		pa = *p
	}
	if answer != nil {
		aa = boolInt(*answer)
	}
	if errText != nil {
		ea = *errText
	}
	_ = s.DB.Write(context.WithoutCancel(ctx), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "INSERT INTO step_decisions (step_id, ts, subject, p, answer, action, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
			&sqlitex.ExecOptions{Args: []any{stepID, now(), subject, pa, aa, action, ea}})
	})
}

// --- Asking ---

// Actor is who did it, as given to the model.
type Actor struct {
	Name         string
	Role, Parent *string
}

func (a Actor) Value() jsjson.Value {
	opt := func(p *string) jsjson.Value {
		if p == nil {
			return nil
		}
		return *p
	}
	return jsjson.NewObject("name", a.Name, "role", opt(a.Role), "parent", opt(a.Parent))
}

// ActorOf is who an agent id (or the human) is, for the model.
func (s *Store) ActorOf(ctx context.Context, ref string) Actor {
	if ref == "" || ref == human {
		return Actor{Name: human}
	}
	a, err := s.DB.GetAgent(ctx, ref)
	if err != nil {
		return Actor{Name: ref}
	}
	out := Actor{Name: a.Name}
	if a.Role != "" {
		role := a.Role
		out.Role = &role
	}
	if parents, err := s.DB.ParentsOf(ctx, a); err == nil && len(parents) > 0 {
		parent := parents[0]
		if p, err := s.DB.GetAgent(ctx, parent); err == nil {
			parent = p.Name
		}
		out.Parent = &parent
	}
	return out
}

// ask is one question to the model: P(yes), or an error string on any failure.
func (s *Store) ask(ctx context.Context, st Step, state jsjson.Value, purpose string, timeout time.Duration) (float64, string) {
	res, fail := s.Ask.Decide(ctx, state, []decide.Named{{Name: "answer", Question: decide.Noul(st.Question)}}, purpose, timeout)
	if fail != nil || res == nil {
		return 0, "the decision model failed or timed out"
	}
	p, ok := res.Noul("answer")
	if !ok {
		return 0, "no answer from the decision model"
	}
	return p, ""
}

// subject is what a step decides about: its reference for the log, its payload, and who did it.
type subject struct {
	ref     string
	payload jsjson.Value
	actor   Actor
}

func stateFor(st Step, sub subject) jsjson.Value {
	if st.Kind == "tool" {
		return jsjson.NewObject("tool", st.Tool, "arguments", sub.payload, "by", sub.actor.Value())
	}
	return jsjson.NewObject("event", st.Event, "payload", sub.payload, "by", sub.actor.Value())
}

// ToolCheck is a tool check's verdict.
type ToolCheck struct {
	Allow    bool
	StepID   string
	StepName string
	Question string
	P        float64
	Error    string
}

// Value is the check as the route answers: allow first, then what a denial adds.
func (c ToolCheck) Value() jsfmt.Value {
	if c.Allow {
		return obj("allow", boolean(true))
	}
	return obj("allow", boolean(false), "step", obj("id", str(c.StepID), "name", str(c.StepName)), "question", str(c.Question), "p", num(c.P), "error", str(c.Error))
}

// CheckTool asks every enabled step on tool, in order, until one denies. approve-if-yes denies on "no"; deny-if-yes denies on
// "yes". A model failure allows (fail open), logged. A tool with no enabled step is allowed without a model call. The caller
// then checks the requirements scoped to the tool (not ported).
func (s *Store) CheckTool(ctx context.Context, agentID, tool string, args jsfmt.Value) (ToolCheck, error) {
	if err := s.recordCall(ctx, agentID, tool, args); err != nil {
		return ToolCheck{}, err
	}
	all, err := s.List(ctx)
	if err != nil {
		return ToolCheck{}, err
	}
	payload, perr := jsjson.Parse([]byte(jsfmt.Compact(args)))
	if perr != nil {
		payload = jsjson.NewObject()
	}
	sub := subject{ref: "tool:" + tool, payload: payload, actor: s.ActorOf(ctx, agentID)}
	started := time.Now()
	for _, st := range all {
		if !st.Enabled || st.Kind != "tool" || st.Tool != tool {
			continue
		}
		left := ToolBudget - time.Since(started)
		if left <= 0 {
			e := "budget"
			s.record(ctx, st.ID, sub.ref, nil, nil, "failed-open", &e)
			continue
		}
		p, e := s.ask(ctx, st, stateFor(st, sub), "decide:step:"+st.ID, min(toolTimeout, left))
		if e != "" {
			s.record(ctx, st.ID, sub.ref, nil, nil, "failed-open", &e)
			continue
		}
		yes := p >= st.Threshold
		deny := !yes
		if st.Action == "deny-if-yes" {
			deny = yes
		}
		action := "allowed"
		if deny {
			action = "denied"
		}
		s.record(ctx, st.ID, sub.ref, &p, &yes, action, nil)
		if deny {
			answer := "no"
			if yes {
				answer = "yes"
			}
			return ToolCheck{StepID: st.ID, StepName: st.Name, Question: st.Question, P: p,
				Error: fmt.Sprintf("Denied by step \"%s\": asked \"%s\", the answer was %s (p %s, threshold %s).", st.Name, st.Question, answer, ToFixed2(p), jsjson.Number(st.Threshold))}, nil
		}
	}
	return ToolCheck{Allow: true}, nil
}

// ToFixed2 is p.toFixed(2) for a probability.
func ToFixed2(p float64) string { return ToFixed(p, 2) }

// ToFixed is p.toFixed(digits) for a non-negative number below 1e21: the exact decimal expansion of the double, rounded half
// up (strconv rounds an exact tie to even, JavaScript up).
func ToFixed(p float64, digits int) string {
	text := new(big.Float).SetFloat64(p).Text('f', 120)
	whole, frac, _ := strings.Cut(text, ".")
	frac = (frac + strings.Repeat("0", digits+1))[:max(len(frac), digits+1)]
	n, _ := new(big.Int).SetString(whole+frac[:digits], 10)
	if frac[digits] >= '5' {
		n.Add(n, big.NewInt(1))
	}
	d := n.String()
	for len(d) < digits+1 {
		d = "0" + d
	}
	return d[:len(d)-digits] + "." + d[len(d)-digits:]
}

// --- The tool-call history ---

// fit is the longest prefix of s, in whole characters, that fits in max UTF-8 bytes.
func fit(s string, max int) string {
	used := 0
	for i, r := range s {
		b := utf8.RuneLen(r)
		if r == utf8.RuneError {
			b = 3
		}
		if used+b > max {
			return s[:i]
		}
		used += b
	}
	return s
}

// clipArgs cuts each string value longer than cap bytes to fit, with a marker; the shape stays.
func clipArgs(v jsfmt.Value, cap int) jsfmt.Value {
	switch v.Kind {
	case jsfmt.String:
		if len(v.Str) <= cap {
			return v
		}
		return str(fit(v.Str, max(0, cap-len(truncated))) + truncated)
	case jsfmt.Array, jsfmt.Object:
		out := v
		out.Items = make([]jsfmt.Value, len(v.Items))
		for i, x := range v.Items {
			out.Items[i] = clipArgs(x, cap)
		}
		return out
	}
	return v
}

// StoredArgs is the arguments as stored: valid JSON of at most 4096 bytes, keeping the arguments' shape (long strings are
// shortened, so a preview still sees e.g. `body`). Only arguments with too many keys to keep whole fall back to their raw
// text under one key.
func StoredArgs(args jsfmt.Value) string {
	for _, cap := range argStringCaps {
		if text := jsfmt.Compact(clipArgs(args, cap)); len(text) <= toolArgsMax {
			return text
		}
	}
	raw := []rune(jsfmt.Compact(args))
	lo, hi := 0, min(len(raw), toolArgsMax)
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if len(jsfmt.Compact(obj("_truncated", str(string(raw[:mid]))))) <= toolArgsMax {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return jsfmt.Compact(obj("_truncated", str(string(raw[:lo]))))
}

// recordCall keeps one checked tool call in the history, and only the last 50 per tool.
func (s *Store) recordCall(ctx context.Context, agentID, tool string, args jsfmt.Value) error {
	if err := s.table(ctx); err != nil {
		return err
	}
	return s.DB.Write(ctx, func(conn *sqlite.Conn) error {
		if err := sqlitex.Execute(conn, "INSERT INTO tool_calls (ts, agent, tool, args) VALUES (?, ?, ?, ?)", &sqlitex.ExecOptions{Args: []any{now(), agentID, tool, StoredArgs(args)}}); err != nil {
			return err
		}
		return sqlitex.Execute(conn, "DELETE FROM tool_calls WHERE tool = ? AND id NOT IN (SELECT id FROM tool_calls WHERE tool = ? ORDER BY id DESC LIMIT ?)", &sqlitex.ExecOptions{Args: []any{tool, tool, toolHistory}})
	})
}

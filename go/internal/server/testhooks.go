package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// The /api/test/* routes (src/daemon.ts, src/test-hooks.ts): a test shapes or reads state the API doesn't, so no e2e
// script opens stam.db. They are registered only on a daemon whose config allows the test hooks (config.TestHooks: test/lib.sh's
// STAM_TEST_COST_HOOKS=1, a test home, a stam-test- tmux socket), and ServeHTTP's gate refuses every /api/test/ path
// otherwise, and an agent's token always, before any route runs.
//
// Not ported: the stall watch, so POST /api/test/stall only holds its own request (the Go daemon has no event loop to
// block). GET /api/test/settings is TS's settings() only approximately (config.SettingsFile.View).

// testHooks is the test routes' in-memory state, under mu.
type testHooks struct {
	mu sync.Mutex
	// readHolds holds an agent's read route until released (POST /api/test/read-hold), by mailbox.
	readHolds map[string]chan struct{}
	// readsHeld counts the reads parked at a hold.
	readsHeld int
	// stopCount ends a statement count (POST /api/test/statements); nil when none runs.
	stopCount func() int
	// gate holds a spawn's ITSA lookup while closed (POST /api/test/itsa-gate, src/test-hooks.ts itsaGate); waiting
	// counts the spawns parked at it.
	gate    chan struct{}
	waiting int
}

func (s *Server) testRoutes() {
	if !s.cfg.TestHooks {
		return
	}
	s.handle("POST /api/test/cost", s.testCost)
	s.handle("POST /api/test/read-hold", s.testReadHold)
	s.handle("POST /api/test/statements", s.testStatements)
	s.handle("POST /api/test/stall", s.testStall)
	s.handle("POST /api/test/launch-fail", s.testLaunchFail)
	s.handle("POST /api/test/itsa-gate", s.testItsaGate)
	s.handle("POST /api/test/agent", s.testAgent)
	s.handle("GET /api/test/switch-retries", s.testSwitchRetries)
	s.handle("GET /api/test/events", s.testEvents)
	s.handle("GET /api/test/pending-unown", s.testPendingUnown)
	s.handle("POST /api/test/permission", s.testPermission)
	s.handle("POST /api/test/wait", s.testWait)
	s.handle("POST /api/test/usage", s.testUsage)
	for _, read := range s.testReads() {
		s.handle("GET /api/test/"+read.name, read.read)
	}
	s.handle("GET /api/test/settings", s.testSettings)
	s.handle("POST /api/test/set-setting", s.testSetSetting)
	s.handle("GET /api/test/token-at-rest", s.testTokenAtRest)
	s.handle("POST /api/test/seed-agents", s.testSeedAgents)
	s.handle("POST /api/test/mail", s.testMail)
	s.handle("POST /api/test/delivery-fail", s.testDeliveryFail)
	s.handle("GET /api/test/kv", s.testKVGet)
	s.handle("POST /api/test/kv", s.testKVSet)
	s.handle("POST /api/test/await", s.testAwait)
}

// okReply is the test routes' {ok: true}.
var okReply = map[string]bool{"ok": true}

// testCost runs the cost work a test can't wait for (src/daemon.ts POST /api/test/cost): store a subscription reading
// (`reading`), or one taken at `at` and not evaluated (`stale-reading`, S-905); poll the OpenRouter credits now; run the
// fallbacks due by `now` (ms); record a provider error signal on an agent (`error`); run an account's error probe now
// (`probe-due`); report an agent's cumulative cost (`spend`); drop the remembered window clears (`forget-clears`).
func (s *Server) testCost(r *http.Request, _ auth.Resolved) (any, error) {
	ctx := r.Context()
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	action := body.Text("action")
	if s.life == nil && action != "stale-reading" && action != "forget-clears" {
		return nil, Errorf(http.StatusNotImplemented, "the cost routes aren't available on this daemon")
	}
	switch action {
	case "reading":
		windows, err := windowsOf(body)
		if err != nil {
			return nil, err
		}
		err = s.life.TestReading(ctx, orString(body, "name", "undefined"), windows)
		if err != nil {
			return nil, err
		}
	case "stale-reading":
		windows := "{}"
		if v, ok := body.Get("windows"); ok && v.Kind != jsfmt.Null {
			windows = jsfmt.Compact(v)
		}
		if err := s.db.SaveSubscription(ctx, orString(body, "name", "undefined"), windows, orString(body, "at", "undefined")); err != nil {
			return nil, err
		}
	case "poll-credits":
		s.life.PollCredits(ctx)
	case "fallback-due":
		v, _ := body.Get("now")
		n, _ := jsNumber(v)
		s.life.TestFallbacksDue(ctx, time.UnixMilli(int64(n)))
	case "error":
		a, err := s.mustAgent(ctx, orString(body, "agent", "undefined"))
		if err != nil {
			return nil, err
		}
		s.life.TestSignal(ctx, a, orString(body, "source", "test"), orString(body, "class", "undefined"))
	case "probe-due":
		if err := s.life.TestProbe(ctx, orString(body, "account", "undefined")); err != nil {
			return nil, err
		}
	case "spend":
		a, err := s.mustAgent(ctx, orString(body, "agent", "undefined"))
		if err != nil {
			return nil, err
		}
		v, _ := body.Get("cost")
		cost, _ := jsNumber(v)
		if err := s.life.TestSpend(ctx, a, cost); err != nil {
			return nil, err
		}
	case "forget-clears":
		if _, err := s.db.TestExec(ctx, "DELETE FROM window_clears"); err != nil {
			return nil, err
		}
	default:
		return nil, Errorf(http.StatusBadRequest, "action must be reading, poll-credits, fallback-due, error, probe-due, spend or forget-clears")
	}
	return okReply, nil
}

// windowsOf is a reading's `windows ?? {}` as the usage code takes it.
func windowsOf(body jsfmt.Value) (*jsjson.Object, error) {
	v, ok := body.Get("windows")
	if !ok || v.Kind == jsfmt.Null {
		return jsjson.NewObject(), nil
	}
	parsed, err := jsjson.Parse([]byte(jsfmt.Compact(v)))
	if err != nil {
		return nil, err
	}
	o, isObject := parsed.(*jsjson.Object)
	if !isObject {
		return nil, Errorf(http.StatusBadRequest, "windows must be an object")
	}
	return o, nil
}

// testReadHold holds an agent's read route until `release`, so its client times out first (S-357).
func (s *Server) testReadHold(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	a, err := s.mustAgent(r.Context(), orString(body, "agent", "undefined"))
	if err != nil {
		return nil, err
	}
	h := &s.tests
	h.mu.Lock()
	defer h.mu.Unlock()
	switch body.Text("action") {
	case "hold":
		if h.readHolds == nil {
			h.readHolds = map[string]chan struct{}{}
		}
		if h.readHolds[a.ID] == nil {
			h.readHolds[a.ID] = make(chan struct{})
		}
	case "release":
		if c := h.readHolds[a.ID]; c != nil {
			close(c)
			delete(h.readHolds, a.ID)
		}
	default:
		return nil, Errorf(http.StatusBadRequest, "action must be hold or release")
	}
	return okReply, nil
}

// readHeld waits while a test holds the mailbox's read (readMail), and says whether it was held. As in TS, the read
// still runs once released, even when its client gave up first, so the caller goes on without the request's cancel.
func (s *Server) readHeld(box string) bool {
	s.tests.mu.Lock()
	c := s.tests.readHolds[box]
	if c == nil {
		s.tests.mu.Unlock()
		return false
	}
	s.tests.readsHeld++
	s.tests.mu.Unlock()
	<-c
	s.tests.mu.Lock()
	s.tests.readsHeld--
	s.tests.mu.Unlock()
	return true
}

// testStatements starts counting the database's work, or stops and answers the count, so a test can bound what one
// request does (test/e2e-agents-route.sh). See db.CountCalls for what counts.
func (s *Server) testStatements(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	h := &s.tests
	h.mu.Lock()
	defer h.mu.Unlock()
	action := body.Text("action")
	if action == "start" {
		if h.stopCount == nil {
			h.stopCount = s.db.CountCalls()
		}
		return okReply, nil
	}
	if action != "stop" || h.stopCount == nil {
		return nil, Errorf(http.StatusBadRequest, "action must be start, then stop")
	}
	n := h.stopCount()
	h.stopCount = nil
	return map[string]any{"ok": true, "statements": n}, nil
}

// testStall holds the request for `ms` (TS blocks its event loop for that long, for the stall watch to see).
func (s *Server) testStall(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	v, _ := body.Get("ms")
	n, _ := jsNumber(v)
	select {
	case <-time.After(time.Duration(n * float64(time.Millisecond))):
	case <-r.Context().Done():
		return nil, r.Context().Err()
	}
	return okReply, nil
}

// testLaunchFail makes the named agents' launches fail after their row exists.
func (s *Server) testLaunchFail(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "launches aren't available on this daemon")
	}
	var names []string
	if v, ok := body.Get("names"); ok && v.Kind == jsfmt.Array {
		for _, n := range v.Items {
			names = append(names, db.JSStr(n))
		}
	}
	s.life.SetFailLaunch(names)
	return okReply, nil
}

// testItsaGate holds or releases a spawn's ITSA lookup and answers how many spawns wait at it.
func (s *Server) testItsaGate(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	h := &s.tests
	h.mu.Lock()
	defer h.mu.Unlock()
	switch body.Text("action") {
	case "hold":
		if h.gate == nil {
			h.gate = make(chan struct{})
		}
	case "release":
		if h.gate != nil {
			close(h.gate)
			h.gate = nil
		}
	}
	return map[string]int{"waiting": h.waiting}, nil
}

// itsaGatePass waits while a test holds the ITSA gate (src/test-hooks.ts itsaGate.pass): a spawn's `itsa` and
// `participate` lookups pass it.
func (s *Server) itsaGatePass(ctx context.Context) error {
	h := &s.tests
	h.mu.Lock()
	gate := h.gate
	if gate == nil {
		h.mu.Unlock()
		return nil
	}
	h.waiting++
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.waiting--
		h.mu.Unlock()
	}()
	select {
	case <-gate:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// testAgent sets the agent fields a test can't reach through a route (S-2387; applyTestAgent).
func (s *Server) testAgent(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	ctx := r.Context()
	ref := func(x string) (string, error) {
		a, err := s.mustAgent(ctx, x)
		return a.ID, err
	}
	if err := s.db.TestTx(ctx, func(exec execFn) error {
		_, err := s.applyTestAgent(exec, body, ref)
		return err
	}); err != nil {
		return nil, err
	}
	return okReply, nil
}

type execFn = func(query string, args ...any) (int, error)

// testAgentText is applyTestAgent's columns written as text.
var testAgentText = []string{"type", "lifecycle", "activity", "activity_detail", "harness", "first_prompt", "created_at", "updated_at", "kind", "idle_since"}

// applyTestAgent is src/test-hooks.ts applyTestAgent: `agent` names it (an id, or the id to create with `create`), and
// each field is optional and written raw, so no lifecycle or activity observer runs. `parent` and `forwarded_to` are
// agent refs; `workspace` and `pending_action` take an object (stored as JSON text) or text; `token` is stored hashed.
func (s *Server) applyTestAgent(exec execFn, body jsfmt.Value, ref func(string) (string, error)) (string, error) {
	id := orString(body, "agent", "undefined")
	if c, ok := body.Get("create"); ok && c.Kind == jsfmt.Object {
		str := func(k, def string) any {
			v, ok := c.Get(k)
			if !ok {
				return def
			}
			return sqlText(v)
		}
		orNil := func(k string) any {
			v, ok := c.Get(k)
			if !ok {
				return nil
			}
			return sqlText(v)
		}
		at := time.Now().UTC().Format(jsISO)
		if _, err := exec(`INSERT INTO agents (id, name, role, machine, harness, model, effort, cwd, parent_id, session_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
			id, str("name", id), str("role", "dev"), str("machine", envMachine()), str("harness", "claude"), orNil("model"), str("cwd", "/tmp"), orNil("session_id"), at, at); err != nil {
			return "", err
		}
	} else {
		var err error
		if id, err = ref(id); err != nil {
			return "", err
		}
	}
	var cols []string
	var args []any
	set := func(col string, v any) { cols, args = append(cols, col+" = ?"), append(args, v) }
	for _, k := range testAgentText {
		if v, ok := body.Get(k); ok {
			set(k, sqlText(v))
		}
	}
	for _, k := range [][2]string{{"forwarded_to", "forwarded_to"}, {"parent", "parent_id"}} {
		if v, ok := body.Get(k[0]); ok {
			to, err := ref(db.JSStr(v))
			if err != nil {
				return "", err
			}
			set(k[1], to)
		}
	}
	for _, k := range []string{"workspace", "pending_action"} {
		if v, ok := body.Get(k); ok {
			set(k, jsonText(v))
		}
	}
	if v, ok := body.Get("token"); ok {
		if v.Kind == jsfmt.Null {
			set("token_hash", nil)
		} else {
			set("token_hash", auth.Hash(db.JSStr(v)))
		}
	}
	// idle_since marks when an agent stopped working, as db.UpdateAgent keeps it, unless the write names it.
	if v, ok := body.Get("activity"); ok && v.Kind != jsfmt.Null && db.JSStr(v) != "" {
		if _, named := body.Get("idle_since"); !named {
			if a := db.JSStr(v); a == "idle" || a == "waiting" {
				set("idle_since", time.Now().UTC().Format(jsISO))
			} else {
				set("idle_since", nil)
			}
		}
	}
	if len(cols) == 0 {
		return id, nil
	}
	_, err := exec("UPDATE agents SET "+strings.Join(cols, ", ")+" WHERE id = ?", append(args, id)...)
	return id, err
}

// envMachine is src/env.ts envVar('MACHINE') ?? 'test': the machine a test row names.
func envMachine() string {
	if m, ok := os.LookupEnv("MOOTR_MACHINE"); ok {
		return m
	}
	if m, ok := os.LookupEnv("STAM_MACHINE"); ok {
		return m
	}
	return "test"
}

// sqlText is String(v) for a column, NULL for null.
func sqlText(v jsfmt.Value) any {
	if v.Kind == jsfmt.Null {
		return nil
	}
	return db.JSStr(v)
}

// jsonText is a JSON column's value as TS writes it: null stays NULL, text as given, anything else as its JSON.
func jsonText(v jsfmt.Value) any {
	switch v.Kind {
	case jsfmt.Null:
		return nil
	case jsfmt.String:
		return v.Str
	}
	return jsfmt.Compact(v)
}

// sqlArg is a JSON value bound as better-sqlite3 binds it: a number as a number, text as text, null as NULL.
func sqlArg(v jsfmt.Value) any {
	switch v.Kind {
	case jsfmt.Null:
		return nil
	case jsfmt.Number:
		if n, err := strconv.ParseInt(v.Num, 10, 64); err == nil {
			return n
		}
		f, _ := strconv.ParseFloat(v.Num, 64)
		return f
	case jsfmt.String:
		return v.Str
	case jsfmt.Bool:
		if v.Bool {
			return int64(1)
		}
		return int64(0)
	}
	return jsfmt.Compact(v)
}

func (s *Server) testSwitchRetries(*http.Request, auth.Resolved) (any, error) {
	s.switched.mu.Lock()
	defer s.switched.mu.Unlock()
	return map[string]int{"passes": s.switched.passes}, nil
}

// testEvents is the daemon's event rows (S-2523): ?agent= and ?type= (a SQL LIKE pattern), both optional, oldest first.
func (s *Server) testEvents(r *http.Request, _ auth.Resolved) (any, error) {
	q := r.URL.Query()
	return s.db.TestRows(r.Context(), "SELECT agent_id, type, data FROM events WHERE (?1 IS NULL OR agent_id = ?1) AND (?2 IS NULL OR type LIKE ?2) ORDER BY id",
		queryArg(q.Has("agent"), q.Get("agent")), queryArg(q.Has("type"), q.Get("type")))
}

// queryArg is URLSearchParams.get: the value, or NULL when the query lacks it.
func queryArg(has bool, v string) any {
	if !has {
		return nil
	}
	return v
}

func (s *Server) testPendingUnown(r *http.Request, _ auth.Resolved) (any, error) {
	rows, err := s.db.TestRows(r.Context(), "SELECT COUNT(*) AS n FROM itsa_pending_unown")
	if err != nil {
		return nil, err
	}
	return map[string]any{"count": firstN(rows)}, nil
}

// firstN is the n column of a count's one row, 0 when the table doesn't exist.
func firstN(rows []jsfmt.Value) jsfmt.Value {
	if len(rows) == 0 {
		return jsfmt.IntValue(0)
	}
	v, _ := rows[0].Get("n")
	return v
}

// testPermission ages or settles a permission request (S-2542): `id` names it; any error is a 404.
func (s *Server) testPermission(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	if err := s.db.TestTx(r.Context(), func(exec execFn) error { return applyTestPermission(exec, body) }); err != nil {
		return nil, Errorf(http.StatusNotFound, "%s", err.Error())
	}
	return okReply, nil
}

// applyTestPermission is src/test-hooks.ts applyTestPermission.
func applyTestPermission(exec execFn, body jsfmt.Value) error {
	var cols []string
	var args []any
	for _, k := range []string{"created_at", "status", "decided_by", "decided_at", "expires_at"} {
		if v, ok := body.Get(k); ok {
			cols, args = append(cols, k+" = ?"), append(args, sqlText(v))
		}
	}
	if len(cols) == 0 {
		return nil
	}
	id := orString(body, "id", "undefined")
	n, err := exec("UPDATE permission_requests SET "+strings.Join(cols, ", ")+" WHERE id = ?", append(args, id)...)
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("no permission request %s", id)
	}
	return nil
}

// testWait inserts a wait row as given (S-2542).
func (s *Server) testWait(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	ctx := r.Context()
	agent, err := s.mustAgent(ctx, orString(body, "agent", "undefined"))
	if err != nil {
		return nil, err
	}
	if err := s.db.TestTx(ctx, func(exec execFn) error { return applyTestWait(exec, body, agent.ID) }); err != nil {
		return nil, err
	}
	return okReply, nil
}

// applyTestWait is src/test-hooks.ts applyTestWait for the agent of id: `kind`, and optional `id`, `target`, `detail`,
// `since`, `until`, `source`, `data` (an object, or JSON text), written as given.
func applyTestWait(exec execFn, body jsfmt.Value, agent string) error {
	id := ""
	if v, ok := body.Get("id"); ok && v.Kind == jsfmt.String {
		id = v.Str
	} else {
		b := make([]byte, 4)
		_, _ = rand.Read(b)
		id = "wtest" + hex.EncodeToString(b)
	}
	opt := func(k string) any {
		v, ok := body.Get(k)
		if !ok {
			return nil
		}
		return jsonText(v)
	}
	_, err := exec("INSERT INTO waits (id, agent_id, kind, target, detail, since, until, source, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id, agent, orString(body, "kind", "undefined"), opt("target"), opt("detail"), orString(body, "since", time.Now().UTC().Format(jsISO)),
		opt("until"), orString(body, "source", "stam"), opt("data"))
	return err
}

// testUsage inserts usage rows (S-2542): any error is a 400.
func (s *Server) testUsage(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	ctx := r.Context()
	if err := s.db.TestTx(ctx, func(exec execFn) error { return applyTestUsage(exec, body, s.refIn(ctx, true)) }); err != nil {
		return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
	}
	return okReply, nil
}

// refIn is an agent ref's id: must refuses an unknown one (mustAgent), else it stays as given (applyTestSeed's ref).
func (s *Server) refIn(ctx context.Context, must bool) func(string) (string, error) {
	return func(x string) (string, error) {
		a, err := s.mustAgent(ctx, x)
		if err != nil && !must && errors.As(err, new(*Error)) {
			return x, nil
		}
		return a.ID, err
	}
}

// usageColumns are applyTestUsage's tables and their columns by API name.
var usageColumns = map[string][]string{
	"usage":         {"day", "harness", "model", "account", "cost_usd", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write"},
	"usage_samples": {"account", "harness", "model", "bucket", "cost_usd", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write"},
}

// applyTestUsage is src/test-hooks.ts applyTestUsage: `table` is usage or usage_samples, `rows` each name `agent` and the
// table's other columns.
func applyTestUsage(exec execFn, body jsfmt.Value, ref func(string) (string, error)) error {
	table := orString(body, "table", "undefined")
	cols, known := usageColumns[table]
	if !known {
		return errors.New("table must be usage or usage_samples")
	}
	list, _ := body.Get("rows")
	for _, row := range list.Items {
		agent, err := ref(orString(row, "agent", "undefined"))
		if err != nil {
			return err
		}
		names, args := []string{"agent_id"}, []any{agent}
		for _, c := range cols {
			if v, ok := row.Get(c); ok {
				names, args = append(names, c), append(args, sqlArg(v))
			}
		}
		if _, err := exec("INSERT INTO "+table+" ("+strings.Join(names, ", ")+") VALUES (?"+strings.Repeat(", ?", len(names)-1)+")", args...); err != nil {
			return err
		}
	}
	return nil
}

// testRead is one purpose-named read of what the API doesn't show (src/test-hooks.ts testReads, S-2544).
type testRead struct {
	name string
	read handler
}

func (s *Server) testReads() []testRead {
	// rowsFor is a read filtered by ?agent= (an agent ref), or every agent's rows without it.
	rowsFor := func(query string) handler {
		return func(r *http.Request, _ auth.Resolved) (any, error) {
			agent, err := s.testAgentID(r)
			if err != nil {
				return nil, err
			}
			return s.db.TestRows(r.Context(), query, agent)
		}
	}
	return []testRead{
		{"blockers", rowsFor("SELECT agent_id AS agent, kind, account, reason FROM blockers WHERE (?1 IS NULL OR agent_id = ?1)")},
		{"cost-notices", rowsFor("SELECT agent_id AS agent, kind, acked_by FROM cost_notices WHERE (?1 IS NULL OR agent_id = ?1)")},
		{"cost-fallbacks", rowsFor("SELECT f.agent_id AS agent, f.kind AS kind, n.kind AS notice_kind, f.state AS state, f.result AS result FROM cost_fallbacks f JOIN cost_notices n ON n.id = f.notice_id WHERE (?1 IS NULL OR f.agent_id = ?1)")},
		{"mail-pushed", func(r *http.Request, _ auth.Resolved) (any, error) {
			agent, err := s.testAgentID(r)
			if err != nil {
				return nil, err
			}
			if agent == nil {
				agent = ""
			}
			rows, err := s.db.TestRows(r.Context(), "SELECT m.subject AS subject, r.pushed_at IS NOT NULL AS pushed FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE r.agent_id = ? AND m.subject = ?",
				agent, r.URL.Query().Get("subject"))
			for i, row := range rows {
				for j, k := range row.Keys {
					if k == "pushed" {
						rows[i].Items[j] = jsfmt.Value{Kind: jsfmt.Bool, Bool: row.Items[j].Truthy()}
					}
				}
			}
			return rows, err
		}},
		{"usage-total", func(r *http.Request, _ auth.Resolved) (any, error) {
			rows, err := s.db.TestRows(r.Context(), "SELECT COALESCE(SUM(cost_usd), 0) AS n FROM usage WHERE account = ?", r.URL.Query().Get("account"))
			if err != nil {
				return nil, err
			}
			return map[string]jsfmt.Value{"cost_usd": firstN(rows)}, nil
		}},
		{"peer-agents", s.rowsRead("SELECT name, machine FROM peer_agents ORDER BY name")},
		{"req-waivers", s.rowsRead("SELECT kind, reason FROM req_waivers")},
		{"counts", s.testCounts},
		{"stam-bin", func(*http.Request, auth.Resolved) (any, error) {
			if s.life == nil {
				return nil, Errorf(http.StatusNotImplemented, "stam's command isn't known to this daemon")
			}
			return map[string]string{"bin": s.life.StamBin()}, nil
		}},
	}
}

func (s *Server) rowsRead(query string) handler {
	return func(r *http.Request, _ auth.Resolved) (any, error) { return s.db.TestRows(r.Context(), query) }
}

// testAgentID is src/daemon.ts testAgentId: the ?agent= ref's id (an unknown one is a 404), or nil without one.
func (s *Server) testAgentID(r *http.Request) (any, error) {
	q := r.URL.Query()
	if !q.Has("agent") {
		return nil, nil
	}
	a, err := s.mustAgent(r.Context(), q.Get("agent"))
	if err != nil {
		return nil, err
	}
	return a.ID, nil
}

// testCounts is the row counts of what a boot writes; the agents' own hook events (hook:*) are left out of events.
func (s *Server) testCounts(r *http.Request, _ auth.Resolved) (any, error) {
	out := jsfmt.Value{Kind: jsfmt.Object}
	for _, c := range [][2]string{
		{"agents", "SELECT COUNT(*) AS n FROM agents"},
		{"events", "SELECT COUNT(*) AS n FROM events WHERE type NOT LIKE 'hook:%'"},
		{"mail", "SELECT COUNT(*) AS n FROM mail"},
		{"itsas", "SELECT COUNT(*) AS n FROM itsas"},
	} {
		rows, err := s.db.TestRows(r.Context(), c[1])
		if err != nil {
			return nil, err
		}
		out.Keys, out.Items = append(out.Keys, c[0]), append(out.Items, firstN(rows))
	}
	return out, nil
}

func (s *Server) testSettings(*http.Request, auth.Resolved) (any, error) {
	return json.RawMessage(jsjson.Stringify(s.settings.View(), "")), nil
}

// testSetSetting is POST /api/test/set-setting (S-2592): setSetting(key, value) as the daemon's own code calls it, which
// a non-home daemon limits to its local part. With merge, an object value is spread over the current one first (as a
// bookkeeping caller does). It answers the warnings it logged.
func (s *Server) testSetSetting(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	key := jsjson.ToString(getValue(w.body, "key"))
	value := getValue(w.body, "value")
	if jsjson.Truthy(getValue(w.body, "merge")) {
		cur, _ := s.settings.View().Get(key)
		merged := jsjson.NewObject()
		for _, src := range []jsjson.Value{cur, value} {
			if o, ok := src.(*jsjson.Object); ok {
				for _, k := range o.Keys() {
					v, _ := o.Get(k)
					merged.Set(k, v)
				}
			}
		}
		value = merged
	}
	warning, err := s.settings.SetSetting(key, value)
	if err != nil {
		return nil, err
	}
	warnings := []string{}
	if warning != "" {
		slog.Warn(warning)
		warnings = append(warnings, warning)
	}
	return map[string]any{"ok": true, "warnings": warnings}, nil
}

// dbFile is a file of the home's database: the db, its -wal and -shm.
var dbFile = regexp.MustCompile(`\.db`)

// testTokenAtRest is how an agent token is stored (S-2523): plain is whether any *.db* file of the home holds the
// token's bytes (any column, a WAL frame or a free page), hashed whether some agent row holds its hash.
func (s *Server) testTokenAtRest(r *http.Request, _ auth.Resolved) (any, error) {
	token := r.URL.Query().Get("token")
	rows, err := s.db.TestRows(r.Context(), "SELECT 1 FROM agents WHERE token_hash = ?", auth.Hash(token))
	if err != nil {
		return nil, err
	}
	plain := false
	if token != "" {
		entries, err := os.ReadDir(s.cfg.Home)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if !dbFile.MatchString(e.Name()) {
				continue
			}
			b, err := os.ReadFile(filepath.Join(s.cfg.Home, e.Name()))
			if err != nil {
				return nil, err
			}
			if bytes.Contains(b, []byte(token)) {
				plain = true
				break
			}
		}
	}
	return map[string]bool{"plain": plain, "hashed": len(rows) > 0}, nil
}

// testSeedAgents seeds `count` agents (300 by default) in chains of four with unread and read mail, waits that point at
// mail threads, blockers and extra parent links, so one GET /api/agents has every per-agent read to do (S-344). The
// agents are id-N, named ag-N.
func (s *Server) testSeedAgents(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	ctx := r.Context()
	n := 300.0
	if v, ok := body.Get("count"); ok && v.Kind != jsfmt.Null {
		n, _ = jsNumber(v)
	}
	count := 0
	if !math.IsNaN(n) && n > 0 {
		count = int(math.Ceil(n))
	}
	machine := envMachine()
	err = s.db.TestTx(ctx, func(exec execFn) error {
		at := time.Now().UTC().Format(jsISO)
		for i := 0; i < count; i++ {
			var parent any
			if i%4 != 0 {
				parent = fmt.Sprintf("id-%d", i-1)
			}
			if _, err := exec(`INSERT INTO agents (id, name, role, machine, harness, model, effort, cwd, parent_id, session_id, created_at, updated_at)
				VALUES (?, ?, '', ?, 'claude', NULL, NULL, '', ?, NULL, ?, ?)`, fmt.Sprintf("id-%d", i), fmt.Sprintf("ag-%d", i), machine, parent, at, at); err != nil {
				return err
			}
		}
		for i := 8; i < count; i += 8 {
			if _, err := exec("INSERT OR IGNORE INTO agent_parents (child_id, parent_id) VALUES (?, ?)", fmt.Sprintf("id-%d", i), fmt.Sprintf("id-%d", i-2)); err != nil {
				return err
			}
		}
		for i := 0; i < count; i++ {
			for m := 0; m < i%4; m++ {
				id := fmt.Sprintf("mail-%d-%d", i, m)
				if _, err := exec(`INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id, reply_to, permission_id, auto_threaded, notice, itsa_id, kind, health, about_itsa, verdict, override, note, copy_to)
					VALUES (?, 'id-0', 'ag-0', ?, 'b', ?, ?, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`, id, fmt.Sprintf("s %d %d", i, m), at, fmt.Sprintf("thread-%d-%d", i, m)); err != nil {
					return err
				}
				if _, err := exec("INSERT OR IGNORE INTO mail_recipients (mail_id, agent_id, quiet) VALUES (?, ?, 0)", id, fmt.Sprintf("id-%d", i)); err != nil {
					return err
				}
			}
			if i%7 == 0 {
				if _, err := exec("INSERT INTO blockers (agent_id, kind, account, reason, since, clear) VALUES (?, 'usage', 'claude', 'test', ?, NULL)", fmt.Sprintf("id-%d", i), at); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// The waits go through AddWait, as TS's db.addWait, so each agent's activity follows them.
	for i := 0; i < count; i++ {
		id := fmt.Sprintf("id-%d", i)
		if i%3 == 0 {
			detail, data := "a thread", fmt.Sprintf(`{"thread":"mail-%d-0"}`, i)
			if _, err := s.db.AddWait(ctx, db.NewWait{AgentID: id, Kind: "event", Source: "stam", Detail: &detail, Data: &data}); err != nil {
				return nil, err
			}
		}
		if i%5 == 0 {
			detail := "a timer"
			if _, err := s.db.AddWait(ctx, db.NewWait{AgentID: id, Kind: "timer", Source: "stam", Detail: &detail}); err != nil {
				return nil, err
			}
		}
	}
	return map[string]any{"ok": true, "seeded": jsfmt.Value{Kind: jsfmt.Number, Num: jsNumText(n)}}, nil
}

// jsNumText is a number as JSON.stringify writes it.
func jsNumText(n float64) string {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return "null"
	}
	return jsjson.Number(n)
}

// testMail shapes the mail the API can't (S-2523): `agent` ({id, name}: a shut-down agent row, a mailbox with no running
// harness), `set-time` ({mail, at}: a message's created_at), `archive` ({mailbox, thread}: a forced archive, over a
// pending request too) or `read-all` (every mail read).
func (s *Server) testMail(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	ctx := r.Context()
	switch body.Text("action") {
	case "agent":
		id := orString(body, "id", "undefined")
		err = s.db.TestTx(ctx, func(exec execFn) error {
			at := time.Now().UTC().Format(jsISO)
			if _, err := exec(`INSERT INTO agents (id, name, role, machine, harness, model, effort, cwd, parent_id, session_id, created_at, updated_at)
				VALUES (?, ?, 'mail-archive test helper', 'test', 'claude', NULL, NULL, '/tmp', NULL, NULL, ?, ?)`, id, orString(body, "name", "undefined"), at, at); err != nil {
				return err
			}
			// Written raw, as the row a daemon left behind: no lifecycle observer runs.
			_, err := exec("UPDATE agents SET lifecycle = 'shut_down' WHERE id = ?", id)
			return err
		})
	case "set-time":
		_, err = s.db.TestExec(ctx, "UPDATE mail SET created_at = ? WHERE id = ?", orString(body, "at", "undefined"), orString(body, "mail", "undefined"))
	case "archive":
		thread := orString(body, "thread", "undefined")
		var rows []jsfmt.Value
		if rows, err = s.db.TestRows(ctx, "SELECT id FROM mail WHERE thread_id = ?", thread); err == nil {
			ids := make([]string, len(rows))
			for i, row := range rows {
				ids[i] = row.Text("id")
			}
			// ArchiveThread hides a thread by the ids it held at that moment.
			err = s.db.ArchiveThread(ctx, orString(body, "mailbox", "undefined"), thread, ids)
		}
	case "read-all":
		_, err = s.db.TestExec(ctx, "UPDATE mail_recipients SET read_at = datetime('now') WHERE read_at IS NULL")
	default:
		return nil, Errorf(http.StatusBadRequest, "action must be agent, set-time, archive or read-all")
	}
	if err != nil {
		return nil, err
	}
	return okReply, nil
}

// testDeliveryFail makes every mail delivery insert fail (`fail: true`) or work again, so a read fails part-way
// through, after its read state was written.
func (s *Server) testDeliveryFail(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	script := "DROP TRIGGER IF EXISTS fail_delivery;"
	if v, ok := body.Get("fail"); ok && v.Truthy() {
		script += "CREATE TRIGGER fail_delivery BEFORE INSERT ON mail_deliveries BEGIN SELECT RAISE(ABORT, 'injected'); END;"
	}
	if err := s.db.TestScript(r.Context(), script); err != nil {
		return nil, err
	}
	return okReply, nil
}

// testKVGet reads a kv row: {value}, null when absent.
func (s *Server) testKVGet(r *http.Request, _ auth.Resolved) (any, error) {
	rows, err := s.db.TestRows(r.Context(), "SELECT value FROM kv WHERE key = ?", r.URL.Query().Get("key"))
	if err != nil {
		return nil, err
	}
	value := jsfmt.NullValue()
	if len(rows) > 0 {
		value, _ = rows[0].Get("value")
	}
	return map[string]jsfmt.Value{"value": value}, nil
}

// testKVSet sets a kv row; a null value deletes it.
func (s *Server) testKVSet(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	key := orString(body, "key", "undefined")
	if v, ok := body.Get("value"); !ok || v.Kind == jsfmt.Null {
		_, err = s.db.TestExec(r.Context(), "DELETE FROM kv WHERE key = ?", key)
	} else {
		_, err = s.db.TestExec(r.Context(), "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, db.JSStr(v))
	}
	if err != nil {
		return nil, err
	}
	return okReply, nil
}

// testAwait is a request that waits (test/e2e-stall.sh): it writes stall-awaiting in the home, then holds until
// stall-release exists.
func (s *Server) testAwait(r *http.Request, _ auth.Resolved) (any, error) {
	if err := os.WriteFile(filepath.Join(s.cfg.Home, "stall-awaiting"), nil, 0o600); err != nil {
		return nil, err
	}
	release := filepath.Join(s.cfg.Home, "stall-release")
	for {
		if _, err := os.Stat(release); err == nil {
			return okReply, nil
		}
		select {
		case <-time.After(50 * time.Millisecond):
		case <-r.Context().Done():
			return nil, r.Context().Err()
		}
	}
}

// ApplyTestSeed is src/test-hooks.ts applyTestSeed: a test daemon's STAM_HOME/test-seed.json, applied once before the
// first reconcile, so a test sees how startup treats a state it could not make through the API. Keys: agents
// [applyTestAgent bodies], events [{agent, type}], permissions, waits, mail [{mail, at}], usage, itsas, activity and
// windows. The whole seed is one transaction; the file is then renamed to test-seed.json.done, so a restart doesn't
// seed twice. Any other daemon does nothing.
func (s *Server) ApplyTestSeed(ctx context.Context) error {
	if !s.cfg.TestHooks {
		return nil
	}
	file := filepath.Join(s.cfg.Home, "test-seed.json")
	b, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	seed, err := jsfmt.Parse(b)
	if err != nil {
		return fmt.Errorf("test seed: %w", err)
	}
	list := func(k string) []jsfmt.Value {
		v, _ := seed.Get(k)
		return v.Items
	}
	err = s.db.TestSeedTx(ctx, func(exec execFn, agentID func(string) (string, bool, error)) error {
		// An agent ref's id, read in this transaction so an agent the seed itself creates is found; an unknown one stays as given.
		ref := func(x string) (string, error) {
			id, ok, err := agentID(x)
			if !ok {
				return x, err
			}
			return id, nil
		}
		for _, a := range list("agents") {
			if _, err := s.applyTestAgent(exec, a, ref); err != nil {
				return err
			}
		}
		for _, e := range list("events") {
			if _, err := exec("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, NULL)", orString(e, "agent", "undefined"), time.Now().UTC().Format(jsISO), orString(e, "type", "undefined")); err != nil {
				return err
			}
		}
		for _, p := range list("permissions") {
			if err := applyTestPermission(exec, p); err != nil {
				return err
			}
		}
		for _, w := range list("waits") {
			agent, err := ref(orString(w, "agent", "undefined"))
			if err != nil {
				return err
			}
			if err := applyTestWait(exec, w, agent); err != nil {
				return err
			}
		}
		for _, m := range list("mail") {
			if _, err := exec("UPDATE mail SET created_at = ? WHERE id = ?", orString(m, "at", "undefined"), orString(m, "mail", "undefined")); err != nil {
				return err
			}
		}
		for _, u := range list("usage") {
			if err := applyTestUsage(exec, u, ref); err != nil {
				return err
			}
		}
		for _, x := range list("itsas") {
			if err := applyTestItsa(exec, x); err != nil {
				return err
			}
		}
		for _, x := range list("activity") {
			if err := applyTestActivity(exec, x); err != nil {
				return err
			}
		}
		windows, _ := seed.Get("windows")
		return applyTestWindows(exec, windows)
	})
	if err != nil {
		return fmt.Errorf("test seed: %w", err)
	}
	return os.Rename(file, file+".done")
}

// member is body[k] bound as given, NULL when absent.
func member(body jsfmt.Value, k string) any {
	v, ok := body.Get(k)
	if !ok {
		return nil
	}
	return sqlArg(v)
}

// num is Number(body[k] ?? def) bound as a number.
func num(body jsfmt.Value, k string, def float64) any {
	v, ok := body.Get(k)
	if !ok || v.Kind == jsfmt.Null {
		return def
	}
	n, _ := jsNumber(v)
	return n
}

// applyTestItsa is src/test-hooks.ts applyTestItsa: an ITSA as the API shows it, with its participants (agent ids) and
// events ({ts, actor, type, data}), written as given.
func applyTestItsa(exec execFn, b jsfmt.Value) error {
	cols := []string{"id", "key", "parent_id", "kind", "title", "status", "owner", "created_by", "created_at", "updated_at", "closed_at"}
	args := make([]any, len(cols))
	for i, c := range cols {
		args[i] = member(b, c)
	}
	if _, err := exec("INSERT INTO itsas ("+strings.Join(cols, ", ")+") VALUES (?"+strings.Repeat(", ?", len(cols)-1)+")", args...); err != nil {
		return err
	}
	id := orString(b, "id", "undefined")
	events, _ := b.Get("events")
	for _, e := range events.Items {
		var data any
		if v, ok := e.Get("data"); ok {
			data = jsfmt.Compact(v)
		}
		if _, err := exec("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)", id, orString(e, "ts", "undefined"), orString(e, "actor", "undefined"), orString(e, "type", "undefined"), data); err != nil {
			return err
		}
	}
	participants, _ := b.Get("participants")
	for _, p := range participants.Items {
		if _, err := exec("INSERT OR IGNORE INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)", id, db.JSStr(p)); err != nil {
			return err
		}
	}
	return nil
}

// applyTestActivity is one activity item (src/test-hooks.ts applyTestActivity).
func applyTestActivity(exec execFn, x jsfmt.Value) error {
	_, err := exec(`INSERT INTO activity_items (agent_id, seq, turn, kind, name, start, "end", summary, wait_kind, raw_cost_usd, est_cost_usd, tokens_in, tokens_out, category, category_source, confidence)
		VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, 0, 0, ?, ?, 1)`,
		orString(x, "agent", "undefined"), num(x, "seq", math.NaN()), num(x, "turn", math.NaN()), orString(x, "kind", "undefined"), orString(x, "start", "undefined"),
		orString(x, "end", "undefined"), member(x, "wait_kind"), num(x, "raw_cost_usd", 0), num(x, "est_cost_usd", 0), member(x, "category"), member(x, "category_source"))
	return err
}

// applyTestWindows is src/test-hooks.ts applyTestWindows: window readings and the subscription row the usage snapshot
// calibrates from.
func applyTestWindows(exec execFn, w jsfmt.Value) error {
	readings, _ := w.Get("readings")
	for _, x := range readings.Items {
		if _, err := exec("INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)",
			orString(x, "name", "undefined"), orString(x, "window", "undefined"), orString(x, "at", "undefined"), num(x, "used_percentage", math.NaN()), num(x, "resets_at", math.NaN())); err != nil {
			return err
		}
	}
	sub, ok := w.Get("subscription")
	if !ok || sub.Kind != jsfmt.Object {
		return nil
	}
	data, _ := sub.Get("data")
	_, err := exec("INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?)", orString(sub, "name", "undefined"), jsfmt.Compact(data), orString(sub, "updated_at", "undefined"))
	return err
}

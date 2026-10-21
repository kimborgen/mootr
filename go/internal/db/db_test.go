package db

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// fixture is a stam.db built by the TS daemon's own src/db.ts (testdata/make-fixture.mjs), once per test run. Each
// test opens a copy of it, never the live home.
var fixture string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "stam-db-fixture-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	code := func() int {
		defer os.RemoveAll(dir)
		home := filepath.Join(dir, "home")
		if err := os.Mkdir(home, 0o700); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if out, err := exec.Command("node", "testdata/make-fixture.mjs", home).CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "make-fixture.mjs: %v\n%s", err, out)
			return 1
		}
		fixture = filepath.Join(home, "stam.db")
		return m.Run()
	}()
	os.Exit(code)
}

// testDB copies the fixture into a test folder and returns its path.
func testDB(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "stam.db")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func openTest(t *testing.T, path string) *DB {
	t.Helper()
	d, err := Open(context.Background(), path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

// rawConn opens a connection of its own, standing in for the TS daemon.
func rawConn(t *testing.T, path string) *sqlite.Conn {
	t.Helper()
	conn, err := sqlite.OpenConn(path, sqlite.OpenReadWrite)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// schema is everything that would change if Open altered the schema: sqlite_master and user_version.
func schema(t *testing.T, path string) string {
	t.Helper()
	conn := rawConn(t, path)
	var b strings.Builder
	err := sqlitex.Execute(conn, "SELECT type, name, tbl_name, IFNULL(sql, '') FROM sqlite_master ORDER BY type, name", &sqlitex.ExecOptions{
		ResultFunc: func(stmt *sqlite.Stmt) error {
			fmt.Fprintf(&b, "%s %s %s %s\n", stmt.ColumnText(0), stmt.ColumnText(1), stmt.ColumnText(2), stmt.ColumnText(3))
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	v, err := intPragma(conn, "user_version")
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(&b, "user_version %d\n", v)
	conn.Close()
	return b.String()
}

func TestReadsAgentsTheTSDaemonWrote(t *testing.T) {
	ctx := context.Background()
	d := openTest(t, testDB(t))

	all, err := d.ListAgents(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, a := range all {
		ids = append(ids, a.ID)
	}
	if want := []string{"aboss", "achild", "agone"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("ListAgents ids = %v, want %v", ids, want)
	}

	a, err := d.GetAgent(ctx, "child")
	if err != nil {
		t.Fatal(err)
	}
	if a.ID != "achild" || a.Role != "developer" || a.Lifecycle != "paused" || a.Activity != "starting" || a.PermissionMode != "auto" {
		t.Fatalf("GetAgent(child) = %+v", a)
	}
	if a.ParentID == nil || *a.ParentID != "aboss" || a.ContextTokens == nil || *a.ContextTokens != 4200 || a.Standing != 1 {
		t.Fatalf("child columns: parent %v, context_tokens %v, standing %v", a.ParentID, a.ContextTokens, a.Standing)
	}
	if a.Effort != nil || a.ChildNotices != nil || a.PermissionSource != nil || a.ContextWindow != nil {
		t.Fatalf("NULL columns read as set: %v %v %v %v", a.Effort, a.ChildNotices, a.PermissionSource, a.ContextWindow)
	}
	if a.TokenHash == nil || a.TokenHash.Reveal() != strings.Repeat("f", 64) {
		t.Fatal("token_hash not read")
	}
	if _, err := d.GetAgent(ctx, "nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetAgent(nobody) err = %v, want ErrNotFound", err)
	}
	if got, err := d.AgentByTokenHash(ctx, strings.Repeat("f", 64)); err != nil || got.ID != "achild" {
		t.Fatalf("AgentByTokenHash = %v, %v", got, err)
	}

	live, err := d.ListLiveAgents(ctx)
	if err != nil || len(live) != 2 {
		t.Fatalf("ListLiveAgents = %d agents, %v; want 2 (agone is archived)", len(live), err)
	}
	pending, err := d.ListPendingAgents(ctx)
	if err != nil || len(pending) != 1 || pending[0].ID != "achild" {
		t.Fatalf("ListPendingAgents = %v, %v", pending, err)
	}
	links, err := d.AgentLinks(ctx)
	if err != nil || len(links) != 3 {
		t.Fatalf("AgentLinks = %v, %v", links, err)
	}
}

func TestDecodesJSONColumns(t *testing.T) {
	ctx := context.Background()
	d := openTest(t, testDB(t))
	a, err := d.GetAgent(ctx, "achild")
	if err != nil {
		t.Fatal(err)
	}
	if v := a.VisibilityOf(); v != (Visibility{Reach: "tree", Siblings: false, Registry: true}) {
		t.Fatalf("VisibilityOf = %+v", v)
	}
	ws, err := a.WorkspaceOf()
	if err != nil {
		t.Fatal(err)
	}
	if ws.Spec.Kind != "worktree" || ws.Spec.Base != "origin/main" || ws.Worktree == nil || ws.Worktree.Path != "/repo-wt" || ws.BaseUsed == nil || ws.BaseUsed.Fetch != "ok" {
		t.Fatalf("WorkspaceOf = %+v", ws)
	}
	p, err := a.PendingActionOf()
	if err != nil {
		t.Fatal(err)
	}
	if p.Type != "compact" || p.Reason != "context" || p.Instructions != "keep it short" || len(p.Raw) == 0 {
		t.Fatalf("PendingActionOf = %+v", p)
	}
	by, err := a.PausedByOf()
	if err != nil || !reflect.DeepEqual(by, []string{"human", "aboss"}) {
		t.Fatalf("PausedByOf = %v, %v", by, err)
	}
	caps, err := a.CapabilitiesOf()
	if err != nil || caps["mcp"] != true {
		t.Fatalf("CapabilitiesOf = %v, %v", caps, err)
	}

	boss, err := d.GetAgent(ctx, "aboss")
	if err != nil {
		t.Fatal(err)
	}
	if v := boss.VisibilityOf(); v != (Visibility{Reach: "all", Siblings: true, Registry: true}) {
		t.Fatalf("NULL visibility = %+v, want the open default", v)
	}
	if ws, err := boss.WorkspaceOf(); ws != nil || err != nil {
		t.Fatalf("NULL workspace = %v, %v", ws, err)
	}
	if by, err := boss.PausedByOf(); by != nil || err != nil {
		t.Fatalf("NULL paused_by = %v, %v", by, err)
	}
}

func TestEvents(t *testing.T) {
	ctx := context.Background()
	d := openTest(t, testDB(t))

	evs, err := d.ListEvents(ctx, "achild", 50, "")
	if err != nil {
		t.Fatal(err)
	}
	var types []string
	for _, e := range evs {
		types = append(types, e.Type)
	}
	if want := []string{"spawn", "hook:Stop", "input:screen"}; !reflect.DeepEqual(types, want) {
		t.Fatalf("ListEvents types = %v, want %v (oldest first)", types, want)
	}
	var spawn struct{ Prompt string }
	if err := evs[0].Decode(&spawn); err != nil || spawn.Prompt != "hello" {
		t.Fatalf("spawn data = %+v, %v", spawn, err)
	}
	if evs[1].Data != nil {
		t.Fatalf("hook:Stop data = %q, want NULL", *evs[1].Data)
	}
	if all, err := d.ListEvents(ctx, "achild", 0, ""); err != nil || len(all) != len(evs) {
		t.Fatalf("ListEvents limit 0 = %d events, %v; want the default limit's %d", len(all), err, len(evs))
	}
	if last, err := d.ListEvents(ctx, "achild", 1, ""); err != nil || len(last) != 1 || last[0].Type != "input:screen" {
		t.Fatalf("ListEvents limit 1 = %v, %v", last, err)
	}
	if in, err := d.ListEvents(ctx, "achild", 50, "input:*"); err != nil || len(in) != 1 {
		t.Fatalf("ListEvents input:* = %v, %v", in, err)
	}
	if ts, err := d.LastHookAt(ctx, "achild"); err != nil || ts == nil || *ts != evs[1].TS {
		t.Fatalf("LastHookAt = %v, %v", ts, err)
	}
	if ts, err := d.LastHookAt(ctx, "aboss"); err != nil || ts != nil {
		t.Fatalf("LastHookAt(aboss) = %v, %v, want nil", ts, err)
	}
	if ts, err := d.LastEventAt(ctx, "achild", []string{"spawn", "resume"}); err != nil || ts == nil || *ts != evs[0].TS {
		t.Fatalf("LastEventAt = %v, %v", ts, err)
	}
	if ok, err := d.HasEvent(ctx, "achild", "hook:Stop"); err != nil || !ok {
		t.Fatalf("HasEvent = %v, %v", ok, err)
	}
	if ok, err := d.HasEventSinceStart(ctx, "achild", "hook:Stop"); err != nil || !ok {
		t.Fatalf("HasEventSinceStart before a resume = %v, %v", ok, err)
	}
	if err := d.AddEvent(ctx, "achild", "resume", nil); err != nil {
		t.Fatal(err)
	}
	if ok, err := d.HasEventSinceStart(ctx, "achild", "hook:Stop"); err != nil || ok {
		t.Fatalf("HasEventSinceStart after a resume = %v, %v", ok, err)
	}
	if times, err := d.EventTimes(ctx, "achild", "spawn", ""); err != nil || len(times) != 1 {
		t.Fatalf("EventTimes = %v, %v", times, err)
	}

	// Data is stored as JSON.stringify would: no HTML escaping.
	if err := d.AddEvent(ctx, "achild", "note", map[string]string{"text": "<a & b>"}); err != nil {
		t.Fatal(err)
	}
	last, err := d.ListEvents(ctx, "achild", 1, "note")
	if err != nil || len(last) != 1 || last[0].Data == nil || *last[0].Data != `{"text":"<a & b>"}` {
		t.Fatalf("note event = %+v, %v", last, err)
	}
	if !strings.HasSuffix(last[0].TS, "Z") || len(last[0].TS) != len("2026-01-02T03:04:05.000Z") {
		t.Fatalf("ts %q is not toISOString's format", last[0].TS)
	}
}

// Open runs no schema change, and the TS daemon reads what the Go side wrote: a rollback finds its database.
func TestLeavesSchemaForTheTSDaemon(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	before := schema(t, path)

	d, err := Open(ctx, path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	boss := "aboss"
	if _, err := d.CreateAgent(ctx, NewAgent{ID: "agonew", Name: "gonew", Role: "developer", Machine: "test-machine", Harness: "claude", Cwd: "/w", ParentID: &boss}); err != nil {
		t.Fatal(err)
	}
	if err := d.AddEvent(ctx, "agonew", "spawn", map[string]any{"by": "go"}); err != nil {
		t.Fatal(err)
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	if after := schema(t, path); after != before {
		t.Fatalf("schema changed:\nbefore:\n%s\nafter:\n%s", before, after)
	}

	out, err := exec.Command("node", "testdata/ts-read.mjs", filepath.Dir(path), "gonew").Output()
	if err != nil {
		var stderr []byte
		if ee, ok := err.(*exec.ExitError); ok {
			stderr = ee.Stderr
		}
		t.Fatalf("ts-read.mjs: %v\n%s%s", err, out, stderr)
	}
	var got struct {
		Agent struct {
			ID       string
			ParentID string `json:"parent_id"`
		}
		Events []struct{ Type, Data string }
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("ts-read.mjs output %q: %v", out, err)
	}
	if got.Agent.ID != "agonew" || got.Agent.ParentID != "aboss" || len(got.Events) != 1 || got.Events[0].Data != `{"by":"go"}` {
		t.Fatalf("the TS daemon read %+v", got)
	}
	if after := schema(t, path); after != before {
		t.Fatalf("schema changed after the TS daemon reopened it:\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

func TestRefusesANewerSchema(t *testing.T) {
	path := testDB(t)
	conn := rawConn(t, path)
	if err := sqlitex.ExecuteTransient(conn, "PRAGMA user_version = 2", nil); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	_, err := Open(context.Background(), path, Options{})
	if !errors.Is(err, ErrNewerSchema) || !strings.Contains(err.Error(), "user_version 2") {
		t.Fatalf("Open err = %v, want ErrNewerSchema naming user_version 2", err)
	}
	if !strings.Contains(schema(t, path), "user_version 2\n") {
		t.Fatal("refusing changed user_version")
	}
}

func TestRefusesAMissingOrForeignFile(t *testing.T) {
	ctx := context.Background()
	missing := filepath.Join(t.TempDir(), "stam.db")
	if _, err := Open(ctx, missing, Options{}); err == nil {
		t.Fatal("Open of a missing file succeeded")
	}
	if _, err := os.Stat(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Open created %s", missing)
	}

	foreign := filepath.Join(t.TempDir(), "other.db")
	conn, err := sqlite.OpenConn(foreign, sqlite.OpenReadWrite|sqlite.OpenCreate)
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlitex.ExecuteTransient(conn, "CREATE TABLE agents (id TEXT)", nil); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if _, err := Open(ctx, foreign, Options{}); err == nil || !strings.Contains(err.Error(), "TS daemon") {
		t.Fatalf("Open of a foreign db err = %v, want a refusal naming the TS daemon", err)
	}
}

func TestEveryConnectionHasThePragmas(t *testing.T) {
	ctx := context.Background()
	d, err := Open(ctx, testDB(t), Options{Readers: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	want := map[string]int{"busy_timeout": 5000, "synchronous": 1, "cache_size": -65536}
	checkConn := func(name string, conn *sqlite.Conn) {
		for p, w := range want {
			if got, err := intPragma(conn, p); err != nil || got != w {
				t.Errorf("%s: %s = %d, %v; want %d", name, p, got, err, w)
			}
		}
		mode, err := sqlitex.ResultText(conn.Prep("PRAGMA journal_mode"))
		if err != nil || mode != "wal" {
			t.Errorf("%s: journal_mode = %q, %v", name, mode, err)
		}
	}
	// Take both readers at once, so each pooled connection is checked, not one of them twice.
	r1, err := d.readers.Take(ctx)
	if err != nil {
		t.Fatal(err)
	}
	r2, err := d.readers.Take(ctx)
	if err != nil {
		t.Fatal(err)
	}
	checkConn("reader 1", r1)
	checkConn("reader 2", r2)
	if err := sqlitex.ExecuteTransient(r1, "DELETE FROM events", nil); err == nil {
		t.Error("a reader connection wrote")
	}
	d.readers.Put(r1)
	d.readers.Put(r2)
	w, err := d.writer.Take(ctx)
	if err != nil {
		t.Fatal(err)
	}
	checkConn("writer", w)
	d.writer.Put(w)
}

// Another process (the TS daemon) holding the write lock makes the Go writer wait, not fail, and Go readers go on.
func TestWaitsForAnotherWriter(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	ts := rawConn(t, path)
	if err := sqlitex.ExecuteTransient(ts, "BEGIN IMMEDIATE", nil); err != nil {
		t.Fatal(err)
	}
	if err := sqlitex.ExecuteTransient(ts, "INSERT INTO events (agent_id, ts, type) VALUES ('aboss', '2026-01-01T00:00:00.000Z', 'ts:write')", nil); err != nil {
		t.Fatal(err)
	}

	if _, err := d.ListAgents(ctx); err != nil {
		t.Fatalf("read while another connection holds the write lock: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- d.AddEvent(ctx, "aboss", "go:write", nil) }()
	select {
	case err := <-done:
		t.Fatalf("Go write finished while the lock was held: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	if err := sqlitex.ExecuteTransient(ts, "COMMIT", nil); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Go write after the lock cleared: %v", err)
		}
	case <-time.After(BusyTimeout):
		t.Fatal("Go write still waiting after the lock cleared")
	}
	evs, err := d.ListEvents(ctx, "aboss", 2, "")
	if err != nil || len(evs) != 2 || evs[0].Type != "ts:write" || evs[1].Type != "go:write" {
		t.Fatalf("events = %+v, %v", evs, err)
	}
}

func TestCloseLeavesNoWALOrSHM(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d, err := Open(ctx, path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.AddEvent(ctx, "aboss", "x", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ListAgents(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + "-wal"); err != nil {
		t.Fatalf("no -wal while open: %v", err)
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(path + suffix); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s left after Close: %v", suffix, err)
		}
	}
	// A restart opens the same file again.
	d2, err := Open(ctx, path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := d2.HasEvent(ctx, "aboss", "x"); err != nil || !ok {
		t.Fatalf("event lost across a restart: %v, %v", ok, err)
	}
	d2.Close()
}

func TestTokenHashNeverRenders(t *testing.T) {
	d := openTest(t, testDB(t))
	a, err := d.GetAgent(context.Background(), "achild")
	if err != nil {
		t.Fatal(err)
	}
	hash := a.TokenHash.Reveal()
	j, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&logs, nil))
	log.Info("agent", "agent", a, "hash", *a.TokenHash)
	wrapped := struct{ A Agent }{a}
	outputs := map[string]string{
		"json":        string(j),
		"%v":          fmt.Sprintf("%v", a),
		"%+v":         fmt.Sprintf("%+v", a),
		"%#v":         fmt.Sprintf("%#v", a),
		"wrapped %+v": fmt.Sprintf("%+v", wrapped),
		"secret %+v":  fmt.Sprintf("%+v %#v %s", a.TokenHash, *a.TokenHash, *a.TokenHash),
		"slog":        logs.String(),
	}
	for name, out := range outputs {
		if strings.Contains(out, hash) {
			t.Errorf("%s shows the token hash: %s", name, out)
		}
	}
	if strings.Contains(string(j), "token_hash") {
		t.Errorf("json has a token_hash key: %s", j)
	}
}

// Close waits for a connection in use, then Read and Write fail with ErrClosed rather than panic.
func TestCloseWaitsThenRefuses(t *testing.T) {
	ctx := context.Background()
	d, err := Open(ctx, testDB(t), Options{})
	if err != nil {
		t.Fatal(err)
	}
	inUse, release := make(chan struct{}), make(chan struct{})
	go d.Read(ctx, func(*sqlite.Conn) error {
		close(inUse)
		<-release
		return nil
	})
	<-inUse
	closed := make(chan error, 1)
	go func() { closed <- d.Close() }()
	select {
	case err := <-closed:
		t.Fatalf("Close returned while a reader was in use: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	close(release)
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	if _, err := d.ListAgents(ctx); !errors.Is(err, ErrClosed) {
		t.Fatalf("read after Close err = %v, want ErrClosed", err)
	}
	if err := d.AddEvent(ctx, "aboss", "x", nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("write after Close err = %v, want ErrClosed", err)
	}
	if err := d.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

package server

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/process"
)

// The process runner (src/process-run.ts, S-946) and the stage guard (src/process.ts stageGuard, S-924), over a process of the
// tests' own (../process/testdata/flow.yaml).
// flowYAML is the process the tests of both packages run: kind `work`, a start, an agent node, three human nodes, a script node and an end.
var flowYAML = func() string {
	b, err := os.ReadFile("../process/testdata/flow.yaml")
	if err != nil {
		panic(err)
	}
	return string(b)
}()

const stageFieldSQL = "INSERT INTO itsa_fields (id, key, label, type, width, align, card, position, created_by, created_at, updated_at) VALUES ('fstage', 'stage', 'Stage', 'text', 'm', 'start', 'chip', 0, 'human', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')"

// flowFixture is a fixture whose checkout holds only the flow process, with the stage field defined.
func flowFixture(t *testing.T, settings string) *fixture { return flowFixtureOf(t, settings, flowYAML) }

// flowFixtureOf is flowFixture over another process text. The live actions end before the database closes.
func flowFixtureOf(t *testing.T, settings, yaml string) *fixture {
	t.Helper()
	f := newFixture(t, nil)
	t.Cleanup(f.srv.WaitProcessRuns)
	real, err := filepath.Abs("../../..")
	must(t, err)
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "processes"), 0o755))
	must(t, os.MkdirAll(filepath.Join(root, "registry"), 0o755))
	defaults, err := os.ReadFile(filepath.Join(real, "registry", "defaults.json"))
	must(t, err)
	must(t, os.WriteFile(filepath.Join(root, "registry", "defaults.json"), defaults, 0o644))
	must(t, os.CopyFS(filepath.Join(root, "templates"), os.DirFS(filepath.Join(real, "templates"))))
	must(t, os.WriteFile(filepath.Join(root, "processes", "flow.yaml"), []byte(yaml), 0o644))
	f.srv.tpl.Root = root
	f.setProcessSettings(settings)
	f.sql(stageFieldSQL)
	loaded, err := f.srv.processesHere()
	must(t, err)
	if len(loaded.Errors) > 0 || len(loaded.Processes) != 1 {
		t.Fatalf("the flow process: %v", loaded.Errors)
	}
	return f
}

func (f *fixture) setProcessSettings(settings string) {
	f.t.Helper()
	writeFile(f.t, f.home+"/settings.json", settings)
}

// itsaID is the id of the ITSA with a key.
func (f *fixture) itsaID(key string) string {
	f.t.Helper()
	return f.text("SELECT id FROM itsas WHERE key = ?", key)
}

// text is the first column of the first row, "" for none.
func (f *fixture) text(query string, args ...any) string {
	f.t.Helper()
	if rows := f.texts(query, args...); len(rows) > 0 {
		return rows[0]
	}
	return ""
}

func (f *fixture) texts(query string, args ...any) []string {
	f.t.Helper()
	var out []string
	must(f.t, f.db.Read(context.Background(), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
			out = append(out, stmt.ColumnText(0))
			return nil
		}})
	}))
	return out
}

// runLines are the runner's records on an ITSA, oldest first.
func (f *fixture) runLines(key string) []string {
	f.t.Helper()
	return f.texts("SELECT json_extract(data, '$.text') FROM itsa_events WHERE itsa_id = ? AND type = 'process-run' ORDER BY id", f.itsaID(key))
}

func (f *fixture) stageOf(key string) string {
	f.t.Helper()
	return f.text("SELECT json_extract(v.value, '$') FROM itsa_field_values v WHERE v.itsa_id = ? AND v.field_id = 'fstage'", f.itsaID(key))
}

func (f *fixture) setStage(key, stage string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.post2("PATCH", "/api/itsas/"+key, `{"fields":{"stage":`+stage+`}}`)
}

func sameLines(t *testing.T, what string, got, want []string) {
	t.Helper()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("%s:\n got %q\nwant %q", what, got, want)
	}
}

// A stage move follows the process's edges (the guard), and each entry of a node the runner acts on is recorded once, under
// dry-run, as TS records it.
func TestStageGuardAndEntryRecords(t *testing.T) {
	f := flowFixture(t, `{}`)
	key := f.createItsa(`{"title":"a change","kind":"work"}`)
	other := f.createItsa(`{"title":"not a work item"}`)

	if rec := f.setStage(key, `"draft"`); rec.Code != 200 {
		t.Fatalf("a first stage: %d %s", rec.Code, rec.Body.String())
	}
	// draft -> merge skips review: refused with the process's message, and nothing is written.
	before := f.count("SELECT COUNT(*) FROM itsa_events")
	rec := f.setStage(key, `"merge"`)
	if rec.Code != 400 || errorOf(t, rec) != "flow does not allow stage draft -> merge (from draft: review)" {
		t.Errorf("a stage that skips a node: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT COUNT(*) FROM itsa_events"); n != before || f.stageOf(key) != "draft" {
		t.Errorf("the refused move wrote: %d events more, stage %q", n-before, f.stageOf(key))
	}
	for _, step := range []string{`"review"`, `"hold"`, `"zzz"`, `"draft"`, `null`, `"draft"`} {
		if rec := f.setStage(key, step); rec.Code != 200 {
			t.Fatalf("stage %s: %d %s", step, rec.Code, rec.Body.String())
		}
	}
	// A stage the process has no node for passes, as does any stage for an ITSA the process does not apply to.
	if rec := f.setStage(other, `"merge"`); rec.Code != 200 {
		t.Errorf("an ITSA of another kind: %d %s", rec.Code, rec.Body.String())
	}
	sameLines(t, "records", f.runLines(key), []string{
		"process flow: entering `draft` (by human) would open the ask (answer) as `needs_input`",
		"process flow: entering `review` (by human) would open the ask (approve) as `needs_approval`",
		"process flow: entering `hold` (by human) would open the ask (decide) as `needs_input` (under on: not opened: its way out belongs to something else (the deploy watcher), so it stays dry-run)",
		"process flow: entering `draft` (by human) would open the ask (answer) as `needs_input`",
		"process flow: entering `draft` (by human) would open the ask (answer) as `needs_input`",
	})
	if len(f.runLines(other)) != 0 {
		t.Errorf("an ITSA of another kind was recorded: %q", f.runLines(other))
	}
	// An event is no one's mail, and writes no actor.
	if n := f.count("SELECT COUNT(*) FROM itsa_events WHERE type = 'process-run' AND actor IS NOT NULL"); n != 0 {
		t.Errorf("%d records name an actor", n)
	}
}

// off records nothing; on refuses before any write what it would run for real.
func TestProcessRunModes(t *testing.T) {
	f := flowFixture(t, `{"process":{"run":"off"},"itsa":{"prOpen":{"github":"acme/app"}}}`)
	key := f.createItsa(`{"title":"off","kind":"work"}`)
	for _, stage := range []string{`"think"`, `"draft"`} {
		if rec := f.setStage(key, stage); rec.Code != 200 {
			t.Fatalf("off, stage %s: %d %s", stage, rec.Code, rec.Body.String())
		}
	}
	if n := len(f.runLines(key)); n != 0 {
		t.Errorf("off recorded %d lines", n)
	}

	// Under dry-run an agent node is recorded with what it would do: the ITSA has no live owner, so a developer lane would spawn.
	f.setProcessSettings(`{"itsa":{"prOpen":{"github":"acme/app"}}}`)
	if rec := f.setStage(key, `"think"`); rec.Code != 200 {
		t.Fatalf("an agent node in dry-run: %d %s", rec.Code, rec.Body.String())
	}
	lines := f.runLines(key)
	if want := "process flow: entering `think` (by human) would spawn a `developer` for S-1 under nobody (prompt: 0 chars) (under on: not done, entered by human, not the runner)"; lines[len(lines)-1] != want {
		t.Errorf("an agent node: %q", lines[len(lines)-1])
	}
	if rec := f.setStage(key, `"draft"`); rec.Code != 200 {
		t.Fatalf("back to draft: %d %s", rec.Code, rec.Body.String())
	}

	// A script node names the PR of the ITSA's link from the configured repo.
	f.sql("INSERT INTO itsa_links (itsa_id, n, system, external_id, url) VALUES (?, 1, 'github', '7', 'https://github.com/acme/app/pull/7')", f.itsaID(key))
	for _, stage := range []string{`"review"`, `"merge"`} {
		if rec := f.setStage(key, stage); rec.Code != 200 {
			t.Fatalf("dry-run, stage %s: %d %s", stage, rec.Code, rec.Body.String())
		}
	}
	lines = f.runLines(key)
	if want := "process flow: entering `merge` (by human) would run `scripts/ship.mjs 7` (under on: not run, entered by human, not the runner)"; lines[len(lines)-1] != want {
		t.Errorf("a script node: %q", lines[len(lines)-1])
	}
	f.setProcessSettings(`{}`)
	f2 := f.createItsa(`{"title":"no repo","kind":"work"}`)
	f.setStage(f2, `"review"`)
	if rec := f.setStage(f2, `"merge"`); rec.Code != 501 || !strings.Contains(errorOf(t, rec), "itsa.prOpen.github") {
		t.Errorf("a script node with no repo: %d %s", rec.Code, rec.Body.String())
	}

	// Under on, a human node whose answer leaves it opens the ask for real (process_live_test.go); one nothing leaves stays a record.
	f.setProcessSettings(`{"process":{"run":"on"},"itsa":{"prOpen":{"github":"acme/app"}}}`)
	third := f.createItsa(`{"title":"on","kind":"work"}`)
	if rec := f.setStage(third, `"hold"`); rec.Code != 200 {
		t.Fatalf("on, a human node nothing leaves: %d %s", rec.Code, rec.Body.String())
	}
	f.srv.WaitProcessRuns()
	if got := f.runLines(third); len(got) != 1 || !strings.Contains(got[0], "(not opened: its way out belongs to something else") {
		t.Errorf("on, a human node nothing leaves: %q", got)
	}
	if f.text("SELECT status FROM itsas WHERE key = ?", third) != "backlog" {
		t.Errorf("on, a human node nothing leaves moved the status")
	}
	// An agent node: a person's entry only records; the runner's would spawn, which is refused before the write (an ITSA with a live
	// owner would skip, a standing lane would mail: process_agent_test.go).
	if err := f.srv.stageEntryRefusal(context.Background(), f.itsaID(third), "work", "think", "human"); err != nil {
		t.Errorf("on, a person into an agent node: %v", err)
	}
	if err := f.srv.stageEntryRefusal(context.Background(), f.itsaID(third), "work", "think", process.RunnerActor); err == nil || !strings.Contains(err.Error(), "spawns a developer") {
		t.Errorf("on, the runner into an agent node: %v", err)
	}
	for _, actor := range []string{process.RunnerActor, "human"} {
		if err := f.srv.stageEntryRefusal(context.Background(), "", "work", "merge", actor); err != nil {
			t.Errorf("on, %s into a script node: %v", actor, err)
		}
	}
	if err := f.srv.stageEntryRefusal(context.Background(), "", "issue", "merge", process.RunnerActor); err != nil {
		t.Errorf("a kind no process applies to: %v", err)
	}
}

// Closing sets the stage to the process's end node in the same change (S-1398), whatever node it was at.
func TestCloseSetsTheStage(t *testing.T) {
	f := flowFixture(t, `{}`)
	key := f.createItsa(`{"title":"to close","kind":"work"}`)
	f.setStage(key, `"draft"`)
	rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"done"}`)
	if rec.Code != 200 {
		t.Fatalf("close: %d %s", rec.Code, rec.Body.String())
	}
	if got := f.stageOf(key); got != "done" {
		t.Errorf("the stage after a close: %q", got)
	}
	if !strings.Contains(rec.Body.String(), `"fields":{"from":{"stage":"draft"},"to":{"stage":"done"}}`) {
		t.Errorf("the change does not carry the stage: %s", rec.Body.String())
	}
	lines := f.runLines(key)
	if want := "process flow: entering `done` (by human) would close the ITSA as `done`"; len(lines) != 2 || lines[1] != want {
		t.Errorf("records: %q", lines)
	}
	// A kind no process applies to keeps its (absent) stage.
	plain := f.createItsa(`{"title":"plain"}`)
	if rec := f.post2("PATCH", "/api/itsas/"+plain, `{"status":"done"}`); rec.Code != 200 || f.stageOf(plain) != "" {
		t.Errorf("close of another kind: %d %s (stage %q)", rec.Code, rec.Body.String(), f.stageOf(plain))
	}
	// A close that names its own stage is guarded: only the end node is allowed from anywhere.
	named := f.createItsa(`{"title":"named","kind":"work"}`)
	f.setStage(named, `"draft"`)
	if rec := f.post2("PATCH", "/api/itsas/"+named, `{"status":"done","fields":{"stage":"hold"}}`); rec.Code != 400 {
		t.Errorf("a close at another stage: %d %s", rec.Code, rec.Body.String())
	}
	if f.stageOf(named) != "draft" || f.text("SELECT status FROM itsas WHERE key = ?", named) == "done" {
		t.Errorf("the refused close wrote: stage %q", f.stageOf(named))
	}
}

// The ITSAs closed before closing set the stage are fixed once, on the ITSA home.
func TestBackfillClosedStage(t *testing.T) {
	f := flowFixture(t, `{}`)
	closed := f.createItsa(`{"title":"closed","kind":"work"}`)
	open := f.createItsa(`{"title":"open","kind":"work"}`)
	f.setStage(closed, `"draft"`)
	f.setStage(open, `"draft"`)
	f.sql("UPDATE itsas SET status = 'done' WHERE key = ?", closed)
	f.srv.StartProcessRun(context.Background())
	if f.stageOf(closed) != "done" || f.stageOf(open) != "draft" {
		t.Errorf("after the backfill: closed at %q, open at %q", f.stageOf(closed), f.stageOf(open))
	}
	if n := f.count("SELECT COUNT(*) FROM migrations WHERE name = 'closed-stage-done'"); n != 1 {
		t.Errorf("the migration is recorded %d times", n)
	}
	// It runs once.
	f.sql("UPDATE itsa_field_values SET value = '\"draft\"' WHERE itsa_id = ?", f.itsaID(closed))
	f.srv.StartProcessRun(context.Background())
	if f.stageOf(closed) != "draft" {
		t.Errorf("the backfill ran twice")
	}
	// A daemon that is not the home leaves the ITSAs alone.
	g := flowFixture(t, `{"itsa":{"home":"elsewhere"}}`)
	g.sql("INSERT INTO itsas (id, key, title, status, kind, created_by, created_at, updated_at) VALUES ('iaaaa', 'S-9', 't', 'done', 'work', 'human', 'x', 'x')")
	g.sql("INSERT INTO itsa_field_values (itsa_id, field_id, value, updated_at) VALUES ('iaaaa', 'fstage', '\"draft\"', 'x')")
	g.srv.StartProcessRun(context.Background())
	if g.stageOf("S-9") != "draft" || g.count("SELECT COUNT(*) FROM migrations WHERE name = 'closed-stage-done'") != 0 {
		t.Errorf("a daemon that is not the home ran the backfill")
	}
}

// The human's answer moves the ITSA out of a human status; at a human node with an `answered` edge the runner records the move it
// would make, and under on it makes it (process_live_test.go).
func TestHumanAnswerIsRecorded(t *testing.T) {
	f := flowFixture(t, `{}`)
	key := f.createItsa(`{"title":"asked","kind":"work"}`)
	f.setStage(key, `"draft"`)
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"needs_input"}`); rec.Code != 200 {
		t.Fatalf("to needs_input: %d %s", rec.Code, rec.Body.String())
	}
	if n := len(f.runLines(key)); n != 1 {
		t.Fatalf("a move into a human status was recorded: %q", f.runLines(key))
	}
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"in_progress"}`); rec.Code != 200 {
		t.Fatalf("the answer: %d %s", rec.Code, rec.Body.String())
	}
	lines := f.runLines(key)
	if want := "process flow: the human answered (needs_input -> in_progress), so stage draft would move to review"; len(lines) != 2 || lines[1] != want {
		t.Errorf("records: %q", lines)
	}
	if f.stageOf(key) != "draft" {
		t.Errorf("dry-run moved the stage to %q", f.stageOf(key))
	}
	// The same answer by an agent settles the ask without the human: it is not the answer the runner follows.
	if p, to := f.srv.answerTarget(answerEntry{id: "x", kind: "work", stage: "draft", actor: "achild", from: "needs_input", to: "in_progress"}); p != nil || to != "" {
		t.Errorf("an agent's answer moves the stage to %q", to)
	}
	if p, to := f.srv.answerTarget(answerEntry{id: "x", kind: "work", stage: "draft", actor: "human", from: "needs_input", to: "in_progress"}); p == nil || to != "review" {
		t.Errorf("the human's answer moves the stage to %q", to)
	}
}

// Created at a stage, an ITSA enters that node.
func TestCreateAtAStage(t *testing.T) {
	f := flowFixture(t, `{}`)
	rec := f.post2("POST", "/api/itsas", `{"title":"born at a node","kind":"work","fields":{"stage":"draft"}}`)
	if rec.Code != 200 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	key := f.body(rec).Text("key")
	sameLines(t, "records", f.runLines(key), []string{"process flow: entering `draft` (by human) would open the ask (answer) as `needs_input`"})
	// Under on the ask opens: the ITSA waits on the human.
	f.setProcessSettings(`{"process":{"run":"on"}}`)
	rec = f.post2("POST", "/api/itsas", `{"title":"asked at birth","kind":"work","fields":{"stage":"draft"}}`)
	if rec.Code != 200 {
		t.Fatalf("under on: %d %s", rec.Code, rec.Body.String())
	}
	f.srv.WaitProcessRuns()
	if got := f.text("SELECT status FROM itsas WHERE key = ?", f.body(rec).Text("key")); got != "needs_input" {
		t.Errorf("the ask was not opened: status %q", got)
	}
}

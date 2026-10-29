package server

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/jsfmt"
	"stam/internal/process"
)

// The runner's live actions (process.run on): the script runner, the human asker and the answer move.

// spawnLog stands in for node: it records each run and answers with the next result.
type spawnLog struct {
	mu      sync.Mutex
	calls   [][]string
	results []process.ScriptResult
	err     error
	// hold, when set, blocks each run until it is closed.
	hold chan struct{}
}

func (l *spawnLog) spawn(script string, args []string, checkout string) (process.ScriptResult, error) {
	l.mu.Lock()
	l.calls = append(l.calls, append([]string{script, checkout}, args...))
	var r process.ScriptResult
	if len(l.results) > 0 {
		r, l.results = l.results[0], l.results[1:]
	}
	hold, err := l.hold, l.err
	l.mu.Unlock()
	if hold != nil {
		<-hold
	}
	return r, err
}

func (l *spawnLog) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.calls)
}

// scriptFixture is an `on` fixture whose checkout has scripts/ship.mjs and whose runs go to the returned log. The process has a
// `code` node a refusal returns to.
func scriptFixture(t *testing.T, settings string) (*fixture, *spawnLog, string) {
	t.Helper()
	withCode := strings.Replace(flowYAML, "  merge:", "  code: { kind: human, lane: human, ask: decide }\n  merge:", 1)
	withCode = strings.Replace(withCode, "  - [merge, done]", "  - [merge, done]\n  - [merge, code]", 1)
	return scriptFixtureOf(t, settings, withCode)
}

func scriptFixtureOf(t *testing.T, settings, yaml string) (*fixture, *spawnLog, string) {
	t.Helper()
	f := flowFixtureOf(t, settings, yaml)
	checkout := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(checkout, "scripts"), 0o755))
	must(t, os.WriteFile(filepath.Join(checkout, "scripts", "ship.mjs"), []byte("// stands in for the merge script\n"), 0o644))
	f.srv.cfg.DeployRepo = checkout
	log := &spawnLog{}
	f.srv.runner.spawn = log.spawn
	real, err := filepath.EvalSymlinks(checkout)
	must(t, err)
	return f, log, real
}

func (f *fixture) setAs(key string, fields, status string, by string) error {
	f.t.Helper()
	v := jsfmt.Value{Kind: jsfmt.Object}
	if fields != "" {
		fv, err := jsfmt.Parse([]byte(fields))
		must(f.t, err)
		v.Set("fields", fv)
	}
	if status != "" {
		v.Set("status", jsfmt.StringValue(status))
	}
	_, err := f.srv.setItsa(context.Background(), key, v, by)
	return err
}

// The runner entering a script node runs `node SCRIPT PR` in the checkout. Exit 0 does nothing more; a refusal sends the stage back
// to code and tells the owner, with the output; any other end leaves the stage and tells the owner it had no verdict.
func TestScriptRunnerLive(t *testing.T) {
	f, log, checkout := scriptFixture(t, `{"process":{"run":"on"},"itsa":{"prOpen":{"github":"acme/app"}}}`)
	ownerMails := func(owner string) []string {
		return f.texts("SELECT subject || char(10) || body FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = ? ORDER BY m.created_at, m.rowid", owner)
	}
	// An ITSA at review (entered with the runner off, so no ask opens), owned by aboss, with a pull request.
	enter := func(title string) string {
		f.setProcessSettings(`{"itsa":{"prOpen":{"github":"acme/app"}}}`)
		key := f.createItsa(`{"title":"` + title + `","kind":"work","owner":"aboss"}`)
		f.sql("INSERT INTO itsa_links (itsa_id, n, system, external_id, url) VALUES (?, 1, 'github', '7', 'https://github.com/acme/app/pull/7')", f.itsaID(key))
		if rec := f.setStage(key, `"review"`); rec.Code != 200 {
			t.Fatalf("review: %d %s", rec.Code, rec.Body.String())
		}
		f.setProcessSettings(`{"process":{"run":"on"},"itsa":{"prOpen":{"github":"acme/app"}}}`)
		return key
	}
	merge := func(key string) {
		t.Helper()
		must(t, f.setAs(key, `{"stage":"merge"}`, "", process.RunnerActor))
		f.srv.WaitProcessRuns()
	}
	script := filepath.Join(checkout, "scripts", "ship.mjs")

	// A person moving the stage into the script node runs nothing.
	key := enter("by a person")
	if rec := f.setStage(key, `"merge"`); rec.Code != 200 {
		t.Fatalf("a person into merge: %d %s", rec.Code, rec.Body.String())
	}
	f.srv.WaitProcessRuns()
	if log.count() != 0 {
		t.Errorf("a script ran for a person's entry")
	}

	// Exit 0: nothing more.
	key = enter("finishes")
	log.results = []process.ScriptResult{{Code: 0, Output: "merged"}}
	merge(key)
	if want := []string{script, checkout, "7"}; log.count() != 1 || strings.Join(log.calls[0], "|") != strings.Join(want, "|") {
		t.Errorf("the run: %q", log.calls)
	}
	if f.stageOf(key) != "merge" || len(ownerMails("aboss")) != 0 {
		t.Errorf("exit 0 changed something: stage %q, mails %q", f.stageOf(key), ownerMails("aboss"))
	}

	// A refusal: the stage goes back to code, the owner is mailed from stam with the last 20 lines.
	key = enter("refused")
	var out []string
	for i := 1; i <= 25; i++ {
		out = append(out, "line "+string(rune('a'+i%26)))
	}
	out[24] = "gates failed"
	log.results = []process.ScriptResult{{Code: 3, Output: strings.Join(out, "\n") + "\n"}}
	merge(key)
	if f.stageOf(key) != "code" {
		t.Errorf("after a refusal the stage is %q", f.stageOf(key))
	}
	mails := ownerMails("aboss")
	if len(mails) != 1 || !strings.HasPrefix(mails[0], "scripts/ship.mjs refused PR 7: stage is back to code\n") {
		t.Fatalf("the refusal mail: %q", mails)
	}
	for _, want := range []string{"The process flow ran `scripts/ship.mjs 7` and it exited 3. The stage is back to `code`.", "```\n" + strings.Join(out[5:], "\n") + "\n```"} {
		if !strings.Contains(mails[0], want) {
			t.Errorf("the refusal mail lacks %q:\n%s", want, mails[0])
		}
	}
	if strings.Contains(mails[0], out[4]+"\n") {
		t.Errorf("the refusal mail carries more than 20 lines")
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE subject LIKE 'scripts/ship.mjs refused%' AND notice = 1"); n != 1 {
		t.Errorf("stam's mail is not a notice (%d)", n)
	}

	// Any other end is no verdict: the stage stays and the owner is told.
	for _, tc := range []struct {
		res  process.ScriptResult
		end  string
		name string
	}{
		{process.ScriptResult{Code: 1, Output: "gh failed"}, "exit 1", "exit 1"},
		{process.ScriptResult{Code: -1, Signal: "SIGKILL", Output: "cut off"}, "exit null, SIGKILL", "a signal"},
		{process.ScriptResult{Code: 3, Signal: "SIGTERM", Output: "cut off"}, "exit null, SIGTERM", "exit 3 and a signal"},
	} {
		key = enter(tc.name)
		before := len(ownerMails("aboss"))
		log.results = []process.ScriptResult{tc.res}
		merge(key)
		if f.stageOf(key) != "merge" {
			t.Errorf("%s: the stage is %q", tc.name, f.stageOf(key))
		}
		mails = ownerMails("aboss")
		if len(mails) != before+1 || !strings.HasPrefix(mails[before], "merge run ended without a verdict: scripts/ship.mjs 7\n") ||
			!strings.Contains(mails[before], "The process flow ran `scripts/ship.mjs 7` and it ended ("+tc.end+") without a verdict. The stage is unchanged.\n\n```\n"+tc.res.Output+"\n```") {
			t.Errorf("%s: %q", tc.name, mails)
		}
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE subject LIKE 'merge run ended%' AND from_id != 'system:process'"); n != 0 {
		t.Errorf("%d owner mails not from system:process", n)
	}

	// A run that never starts is logged, not mailed.
	key = enter("fails to start")
	before := len(ownerMails("aboss"))
	log.err = os.ErrNotExist
	merge(key)
	log.err = nil
	if len(ownerMails("aboss")) != before || f.stageOf(key) != "merge" {
		t.Errorf("a run that never started changed something")
	}

	// A refusal of an ITSA with no owner moves the stage and mails nobody.
	key = enter("no owner")
	f.sql("UPDATE itsas SET owner = NULL WHERE key = ?", key)
	before = f.count("SELECT COUNT(*) FROM mail")
	log.results = []process.ScriptResult{{Code: 3, Output: "no"}}
	merge(key)
	if f.stageOf(key) != "code" || f.count("SELECT COUNT(*) FROM mail") != before {
		t.Errorf("an ownerless refusal: stage %q, %d mails", f.stageOf(key), f.count("SELECT COUNT(*) FROM mail")-before)
	}
}

// A run is refused unless the script lies under the checkout's scripts/, this daemon is the ITSA home and the ITSA has a pull
// request; a second entry while the first runs is ignored.
func TestScriptRunnerGuards(t *testing.T) {
	f, log, _ := scriptFixture(t, `{"process":{"run":"on"}}`)
	key := f.createItsa(`{"title":"guards","kind":"work"}`)
	id := f.itsaID(key)
	p := f.srv.processOf("work")
	run := func(script string, args ...string) {
		t.Helper()
		f.srv.runScript(context.Background(), id, p, process.EntryAction{Do: "run", Script: script, Args: args})
		f.srv.WaitProcessRuns()
	}
	run("scripts/ship.mjs") // no pull request
	run("../outside.mjs", "7")
	run("scripts/missing.mjs", "7")
	run("/etc/passwd", "7")
	if log.count() != 0 {
		t.Errorf("a refused run started: %q", log.calls)
	}
	f.setProcessSettings(`{"process":{"run":"on"},"itsa":{"home":"elsewhere"}}`)
	run("scripts/ship.mjs", "7")
	if log.count() != 0 {
		t.Errorf("a daemon that is not the home ran a script")
	}
	f.setProcessSettings(`{"process":{"run":"on"}}`)

	log.hold = make(chan struct{})
	f.srv.runScript(context.Background(), id, p, process.EntryAction{Do: "run", Script: "scripts/ship.mjs", Args: []string{"7"}})
	waitFor(t, func() bool { return log.count() >= 1 }, "the first run to start")
	f.srv.runScript(context.Background(), id, p, process.EntryAction{Do: "run", Script: "scripts/ship.mjs", Args: []string{"7"}})
	other := f.createItsa(`{"title":"other","kind":"work"}`)
	f.srv.runScript(context.Background(), f.itsaID(other), p, process.EntryAction{Do: "run", Script: "scripts/ship.mjs", Args: []string{"8"}})
	waitFor(t, func() bool { return log.count() >= 2 }, "the other ITSA's run to start")
	close(log.hold)
	f.srv.WaitProcessRuns()
	if log.count() != 2 {
		t.Errorf("runs: %d, want one per ITSA", log.count())
	}
	// Once it has ended, a new entry runs again.
	run("scripts/ship.mjs", "7")
	if log.count() != 3 {
		t.Errorf("after the run ended: %d runs", log.count())
	}
}

// A second entry while the first run is held is ignored even when its goroutine would start only after that run ended:
// the guard is checked at entry, not in the goroutine (S-4143). The goroutine-start seam forces that late start.
func TestScriptRunnerLateDuplicate(t *testing.T) {
	f, log, _ := scriptFixture(t, `{"process":{"run":"on"}}`)
	key := f.createItsa(`{"title":"late","kind":"work"}`)
	id := f.itsaID(key)
	p := f.srv.processOf("work")
	entry := process.EntryAction{Do: "run", Script: "scripts/ship.mjs", Args: []string{"7"}}
	var starts atomic.Int32
	late := make(chan struct{})
	f.srv.runner.scriptStart = func() {
		if starts.Add(1) == 2 {
			<-late
		}
	}
	log.hold = make(chan struct{})
	f.srv.runScript(context.Background(), id, p, entry)
	waitFor(t, func() bool { return log.count() == 1 }, "the first run to start")
	f.srv.runScript(context.Background(), id, p, entry)
	close(log.hold)
	waitFor(t, func() bool {
		f.srv.runner.mu.Lock()
		defer f.srv.runner.mu.Unlock()
		return !f.srv.runner.running[id+"#scripts/ship.mjs"]
	}, "the first run to end")
	close(late)
	f.srv.WaitProcessRuns()
	if n := log.count(); n != 1 {
		t.Errorf("runs: %d, want 1: the entry made while the first ran started late and ran", n)
	}
}

// The checks before a run read files (the checkout, its scripts/, the settings), so they run in the worker: an entry
// returns while they are held, and a second entry meanwhile is already ignored (S-4143 review).
func TestScriptRunnerEntryReturns(t *testing.T) {
	f, log, _ := scriptFixture(t, `{"process":{"run":"on"}}`)
	key := f.createItsa(`{"title":"slow checks","kind":"work"}`)
	id := f.itsaID(key)
	p := f.srv.processOf("work")
	entry := process.EntryAction{Do: "run", Script: "scripts/ship.mjs", Args: []string{"7"}}
	held, release := make(chan struct{}), make(chan struct{})
	f.srv.runner.scriptStart = func() {
		close(held)
		<-release
	}
	returned := make(chan struct{})
	go func() {
		f.srv.runScript(context.Background(), id, p, entry)
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(10 * time.Second):
		close(release)
		t.Fatal("the entry waited for the held checks")
	}
	<-held
	f.srv.runner.scriptStart = nil
	f.srv.runScript(context.Background(), id, p, entry)
	close(release)
	f.srv.WaitProcessRuns()
	if n := log.count(); n != 1 {
		t.Errorf("runs: %d, want 1", n)
	}
}

// Entering a human node under on opens the ask: a comment by the runner, then the move to the status for `ask`, which mails the
// human once. The human's answer moves the stage along the `answered` edge, and the node entered opens its own ask.
func TestHumanAskLive(t *testing.T) {
	f := flowFixture(t, `{"process":{"run":"on"}}`)
	key := f.createItsa(`{"title":"asks","kind":"work","owner":"aboss"}`)
	f.post2("POST", "/api/itsas/"+key+"/post", `{"by":"aboss","body":"Which database do we use?"}`)
	if rec := f.setStage(key, `"draft"`); rec.Code != 200 {
		t.Fatalf("draft: %d %s", rec.Code, rec.Body.String())
	}
	f.srv.WaitProcessRuns()
	if got := f.text("SELECT status FROM itsas WHERE key = ?", key); got != "needs_input" {
		t.Fatalf("the status after the ask: %q", got)
	}
	// The comment names the node and quotes the latest comment by someone but a system sender; it is by the runner.
	comments := f.texts("SELECT body FROM mail WHERE from_id = 'system:process' AND kind = 'comment'")
	if len(comments) != 1 || comments[0] != "Process flow: draft. It waits on you (answer); answer, approve or request changes on this ITSA.\n\nThe latest comment:\n\n> Which database do we use?" {
		t.Errorf("the ask comment: %q", comments)
	}
	if n := f.count("SELECT COUNT(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'human' AND m.kind = 'ask'"); n != 1 {
		t.Errorf("the human got %d asks", n)
	}
	if n := f.count("SELECT COUNT(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'human' AND m.kind = 'comment'"); n != 0 {
		t.Errorf("the comment mailed the human")
	}

	// The human's answer moves the stage to review, as the runner, and review opens its own ask.
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"in_progress"}`); rec.Code != 200 {
		t.Fatalf("the answer: %d %s", rec.Code, rec.Body.String())
	}
	f.srv.WaitProcessRuns()
	if f.stageOf(key) != "review" {
		t.Errorf("after the answer the stage is %q", f.stageOf(key))
	}
	if got := f.text("SELECT status FROM itsas WHERE key = ?", key); got != "needs_approval" {
		t.Errorf("the ask of review: status %q", got)
	}
	lines := f.runLines(key)
	want := []string{
		"process flow: entering `draft` (by human) open the ask (answer) as `needs_input`",
		"process flow: the human answered (needs_input -> in_progress), so stage draft moves to review",
		"process flow: entering `review` (by system:process) open the ask (approve) as `needs_approval`",
	}
	sameLines(t, "records", lines, want)
	if n := f.count("SELECT COUNT(*) FROM itsa_events WHERE itsa_id = ? AND type = 'fields' AND actor = 'system:process'", f.itsaID(key)); n != 1 {
		t.Errorf("the runner moved the stage %d times", n)
	}

	// An ITSA already waiting on the human is left alone.
	other := f.createItsa(`{"title":"waits","kind":"work"}`)
	f.post2("PATCH", "/api/itsas/"+other, `{"status":"needs_test"}`)
	f.setStage(other, `"draft"`)
	f.srv.WaitProcessRuns()
	if got := f.text("SELECT status FROM itsas WHERE key = ?", other); got != "needs_test" {
		t.Errorf("an ITSA that waits was moved to %q", got)
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE from_id = 'system:process' AND about_itsa = ?", f.itsaID(other)); n != 0 {
		t.Errorf("an ITSA that waits was commented on")
	}
}

// An agent whose model may not mail the human cannot have a node entered by it ask the human; one that may, can.
func TestHumanAskNeedsMayAsk(t *testing.T) {
	f := flowFixture(t, `{"process":{"run":"on"}}`)
	ctx := context.Background()
	for actor, want := range map[string]bool{"": true, "system:process": true, "system:anything": true, "human": true, "achild": false} {
		if got, err := f.srv.mayAsk(ctx, actor); err != nil || got != want {
			t.Errorf("mayAsk(%q) = %v, %v", actor, got, err)
		}
	}
	key := f.createItsa(`{"title":"by a small model","kind":"work"}`)
	must(t, f.setAs(key, `{"stage":"draft"}`, "", "achild"))
	f.srv.WaitProcessRuns()
	if got := f.text("SELECT status FROM itsas WHERE key = ?", key); got != "backlog" {
		t.Errorf("a model that may not mail the human opened the ask: %q", got)
	}
	f.setProcessSettings(`{"process":{"run":"on"},"humanMail":{"models":{"claude-haiku-5-5":true}}}`)
	if got, err := f.srv.mayAsk(ctx, "achild"); err != nil || !got {
		t.Errorf("mayAsk once allowed: %v, %v", got, err)
	}
	other := f.createItsa(`{"title":"by an allowed model","kind":"work"}`)
	must(t, f.setAs(other, `{"stage":"draft"}`, "", "achild"))
	f.srv.WaitProcessRuns()
	if got := f.text("SELECT status FROM itsas WHERE key = ?", other); got != "needs_input" {
		t.Errorf("a model that may mail the human did not open the ask: %q", got)
	}
}

// A human's answer that would move the stage into a node the runner cannot enter yet answers 501 before the comment is posted, on
// the status route and on the act route alike; nothing is written.
func TestAnswerRefusedBeforeWriting(t *testing.T) {
	toAgent := strings.Replace(flowYAML, "- [draft, review, { when: answered }]", "- [draft, think, { when: answered }]\n  - [draft, review]", 1)
	f := flowFixtureOf(t, `{"process":{"run":"on"}}`, toAgent)
	key := f.createItsa(`{"title":"answers into an agent","kind":"work"}`)
	f.setProcessSettings(`{}`)
	f.setStage(key, `"draft"`)
	f.post2("PATCH", "/api/itsas/"+key, `{"status":"needs_input"}`)
	f.setProcessSettings(`{"process":{"run":"on"}}`)
	mails := func() int { return f.count("SELECT COUNT(*) FROM mail") }
	before := mails()
	rec := f.post2("POST", "/api/itsas/"+key+"/act", `{"action":"answer","text":"go ahead"}`)
	if rec.Code != 501 || !strings.Contains(errorOf(t, rec), "agent node think") {
		t.Errorf("the act route: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"in_progress"}`); rec.Code != 501 {
		t.Errorf("the status route: %d %s", rec.Code, rec.Body.String())
	}
	if n := mails() - before; n != 0 {
		t.Errorf("the refused answer posted %d mails", n)
	}
	if got := f.text("SELECT status FROM itsas WHERE key = ?", key); got != "needs_input" || f.stageOf(key) != "draft" {
		t.Errorf("the refused answer wrote: status %q, stage %q", got, f.stageOf(key))
	}
	// Under dry-run the same answer is only recorded.
	f.setProcessSettings(`{}`)
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"in_progress"}`); rec.Code != 200 {
		t.Errorf("dry-run: %d %s", rec.Code, rec.Body.String())
	}
}

// Two stage writes in flight reach the runner in commit order: while the first one's listener runs, the second does not commit.
func TestStageEntriesFollowCommitOrder(t *testing.T) {
	f := flowFixture(t, `{}`)
	key := f.createItsa(`{"title":"races","kind":"work"}`)
	f.setStage(key, `"draft"`)
	reached, release := make(chan struct{}), make(chan struct{})
	f.srv.stages.beforeEntry = func(to string) {
		if to == "review" {
			close(reached)
			<-release
		}
	}
	first := make(chan int)
	go func() { first <- f.setStage(key, `"review"`).Code }()
	<-reached
	second := make(chan int)
	go func() { second <- f.setStage(key, `"draft"`).Code }()
	// The second write waits for the first one's listener: the stage is still review and the memo says so.
	deadline := time.Now().Add(10 * time.Second)
	for f.srv.stages.waiting() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the second write never queued behind the first")
		}
		runtime.Gosched()
	}
	if got := f.stageOf(key); got != "review" {
		t.Errorf("the second write committed before the first one's listener ended: %q", got)
	}
	close(release)
	if c := <-first; c != 200 {
		t.Errorf("first: %d", c)
	}
	if c := <-second; c != 400 && c != 200 {
		t.Errorf("second: %d", c)
	}
	f.srv.stages.beforeEntry = nil
	f.srv.stages.mu.Lock()
	at := f.srv.stages.at[f.itsaID(key)]
	f.srv.stages.mu.Unlock()
	if at != f.stageOf(key) {
		t.Errorf("the memo %q does not match the stage %q: the entries were reordered", at, f.stageOf(key))
	}
}

// Shutdown waits for the goroutines that use the database: StartRequirements ends with its context and WaitBackground returns only
// then.
func TestBackgroundWorkEndsBeforeShutdown(t *testing.T) {
	f := newFixture(t, nil)
	ctx, end := context.WithCancel(context.Background())
	f.srv.StartRequirements(ctx)
	done := make(chan struct{})
	go func() { f.srv.WaitBackground(); close(done) }()
	// A time-based negative check: nothing signals "still waiting", so it gives the wait 100 ms to wrongly return. The positive
	// check below is what proves the wait ends with the context.
	select {
	case <-done:
		t.Fatal("WaitBackground returned while the requirements loop ran")
	case <-time.After(100 * time.Millisecond):
	}
	end()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("WaitBackground did not return after the context ended")
	}
	// Once shutdown has waited, nothing more starts: a late action cannot add to a wait group that is being waited on.
	if f.srv.goBg(func() { t.Error("a goroutine started after the wait") }) {
		t.Error("goBg started a goroutine after WaitBackground")
	}
}

func waitFor(t *testing.T, ok func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		runtime.Gosched()
	}
}

// A refusal whose stage move fails (the process has no code node) says so in the mail instead of claiming the stage went back.
func TestScriptRefusalNotMoved(t *testing.T) {
	f, log, _ := scriptFixtureOf(t, `{"process":{"run":"on"},"itsa":{"prOpen":{"github":"acme/app"}}}`, flowYAML)
	f.setProcessSettings(`{"itsa":{"prOpen":{"github":"acme/app"}}}`)
	key := f.createItsa(`{"title":"stuck","kind":"work","owner":"aboss"}`)
	f.sql("INSERT INTO itsa_links (itsa_id, n, system, external_id, url) VALUES (?, 1, 'github', '7', 'https://github.com/acme/app/pull/7')", f.itsaID(key))
	f.setStage(key, `"review"`)
	f.setProcessSettings(`{"process":{"run":"on"},"itsa":{"prOpen":{"github":"acme/app"}}}`)
	log.results = []process.ScriptResult{{Code: 3, Output: "gates failed"}}
	must(t, f.setAs(key, `{"stage":"merge"}`, "", process.RunnerActor))
	f.srv.WaitProcessRuns()
	if f.stageOf(key) != "merge" {
		t.Errorf("the stage is %q", f.stageOf(key))
	}
	mails := f.texts("SELECT subject || char(10) || body FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'aboss'")
	if len(mails) != 1 || !strings.HasPrefix(mails[0], "scripts/ship.mjs refused PR 7: stage not moved\n") ||
		!strings.Contains(mails[0], "The stage could not be moved back to `code` (the process has no code node); it is unchanged.") {
		t.Errorf("the mail: %q", mails)
	}
}

// One write that leaves a human status and enters a human node: the observers of the status change settle the old ask first, and
// only then does the entry open the new one. Started before the observers, the new ask would be the live one they withdraw.
func TestAskOpensAfterTheObserversOfTheSameWrite(t *testing.T) {
	f := flowFixture(t, `{"process":{"run":"on"},"humanMail":{"models":{"claude-haiku-5-5":true}}}`)
	key := f.createItsa(`{"title":"moves on","kind":"work","owner":"aboss"}`)
	note := jsfmt.Value{Kind: jsfmt.Object}
	note.Set("by", jsfmt.StringValue(process.RunnerActor))
	note.Set("body", jsfmt.StringValue("Which one?"))
	note.Set("agents_only", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	_, err := f.srv.post(context.Background(), key, note, false)
	must(t, err)
	must(t, f.setAs(key, "", "needs_input", process.RunnerActor))
	var waitOpen func()
	liveAsks := func() int {
		return f.count("SELECT COUNT(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'human' AND m.kind = 'ask' AND r.withdrawn_at IS NULL")
	}
	if liveAsks() != 1 {
		t.Fatalf("the first ask: %d live", liveAsks())
	}
	// Pull the entry's ask forward if it started too early: wait (briefly) for it to take effect before the observers run. Nothing
	// signals "not started", so the wait is time-bounded; it ends at once when the bug is present.
	var opened bool
	var first atomic.Bool
	f.srv.stages.beforeObservers = func() {
		if first.CompareAndSwap(false, true) {
			waitOpen()
		}
	}
	waitOpen = func() {
		deadline := time.Now().Add(300 * time.Millisecond)
		for time.Now().Before(deadline) {
			if f.count("SELECT COUNT(*) FROM mail WHERE kind = 'ask'") == 2 {
				opened = true
				return
			}
			runtime.Gosched()
		}
	}
	must(t, f.setAs(key, `{"stage":"draft"}`, "in_progress", "achild"))
	f.srv.WaitProcessRuns()
	if opened {
		t.Error("the ask opened before the observers of the write that entered the node")
	}
	if got := f.text("SELECT status FROM itsas WHERE key = ?", key); got != "needs_input" {
		t.Errorf("status %q: the ask was not opened", got)
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE kind = 'ask'"); n != 2 {
		t.Errorf("%d asks in all", n)
	}
	if liveAsks() != 1 {
		t.Errorf("%d live asks: the new ask was withdrawn by the write that opened it", liveAsks())
	}
}

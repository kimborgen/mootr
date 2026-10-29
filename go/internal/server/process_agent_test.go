package server

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"stam/internal/config"
	"stam/internal/jsfmt"
	"stam/internal/process"
)

// The agent runner: mail to the standing lane, the spawn decisions (claim, hourly cap, working limit) and the agent context.

const crewYAML = `process: flow
title: Flow
applies_to: { kind: [work] }
lanes:
  human: { type: human }
  boss: { type: cos }
  dev: { type: developer }
  rev: { type: reviewer }
nodes:
  begin: { kind: start, lane: human, triggers: [{ source: manual }] }
  plan: { kind: agent, lane: boss }
  code: { kind: agent, lane: dev, brief: "Report to {{parent}}." }
  look: { kind: agent, lane: rev }
  done: { kind: end, lane: human, status: done }
edges:
  - [begin, plan]
  - [plan, code]
  - [code, look]
  - [look, done]
`

const onSettings = `{"process":{"run":"on","maxSpawnsPerHour":3},"chiefOfStaff":"boss"}`

// spawnHook records the spawns and answers with the next error (nil: a name).
type spawnHook struct {
	mu    sync.Mutex
	calls []spawnInput
	err   error
	hold  chan struct{}
}

func (h *spawnHook) spawn(_ context.Context, in spawnInput) (string, error) {
	h.mu.Lock()
	h.calls = append(h.calls, in)
	err, hold := h.err, h.hold
	h.mu.Unlock()
	if hold != nil {
		<-hold
	}
	return "newdev", err
}

func (h *spawnHook) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.calls)
}

func crewFixture(t *testing.T, settings string) (*fixture, *spawnHook) {
	t.Helper()
	f := flowFixtureOf(t, settings, crewYAML)
	h := &spawnHook{}
	f.srv.runner.spawnAgent = h.spawn
	return f, h
}

// stagedItsa is an ITSA entered into a stage while the runner is in dry-run, so it has the stage-change event an entry names.
func (f *fixture) stagedItsa(title, stage string) string {
	f.t.Helper()
	live := string(f.settingsText())
	f.setProcessSettings(`{"chiefOfStaff":"boss"}`)
	key := f.createItsa(`{"title":"` + title + `","kind":"work"}`)
	if rec := f.setStage(key, `"`+stage+`"`); rec.Code != 200 {
		f.t.Fatalf("stage %s: %d %s", stage, rec.Code, rec.Body.String())
	}
	f.setProcessSettings(live)
	return key
}

func (f *fixture) settingsText() []byte {
	f.t.Helper()
	b, err := os.ReadFile(f.home + "/settings.json")
	must(f.t, err)
	return b
}

func (f *fixture) notes(key string) []string {
	return f.texts("SELECT json_extract(data, '$.text') FROM itsa_events WHERE itsa_id = ? AND type = 'process-run' ORDER BY id", f.itsaID(key))
}

func (f *fixture) spawnAction(key, node string) process.EntryAction {
	return process.EntryAction{Do: "spawn", Type: "developer", Itsa: key, Node: node, Prompt: "Report to {{parent}}.", Parent: "aboss"}
}

// The runner entering a standing lane's node mails the chief of staff from stam, once per entry; a person's entry only records.
func TestAgentNodeMailsTheStandingLane(t *testing.T) {
	f, _ := crewFixture(t, onSettings)
	key := f.createItsa(`{"title":"plans","kind":"work"}`)
	if rec := f.setStage(key, `"plan"`); rec.Code != 200 {
		t.Fatalf("a person into plan: %d %s", rec.Code, rec.Body.String())
	}
	f.srv.WaitProcessRuns()
	if n := f.count("SELECT COUNT(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'aboss'"); n != 0 {
		t.Errorf("a person's entry mailed %d", n)
	}
	if got := f.notes(key); len(got) != 1 || got[0] != "process flow: entering `plan` (by human) would mail aboss about S-1 at `plan` (not done: entered by human, not the runner)" {
		t.Errorf("the record: %q", got)
	}

	other := f.createItsa(`{"title":"plans for real","kind":"work"}`)
	must(t, f.setAs(other, `{"stage":"plan"}`, "", process.RunnerActor))
	f.srv.WaitProcessRuns()
	mails := f.texts("SELECT m.subject || char(10) || m.body FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'aboss' AND m.notice = 1")
	if len(mails) != 1 || mails[0] != "S-2 entered plan\nThe process flow moved S-2 to `plan`. It is yours: take the next step." {
		t.Errorf("the mail: %q", mails)
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE from_id = 'system:process' AND subject = 'S-2 entered plan'"); n != 1 {
		t.Errorf("from system:process: %d", n)
	}
	if n := f.count("SELECT COUNT(*) FROM itsa_events WHERE itsa_id = ? AND type = 'process-mail' AND json_extract(data, '$.node') = 'plan'", f.itsaID(other)); n != 1 {
		t.Errorf("claims: %d", n)
	}
	// The same entry again is ignored: one claim, one mail.
	p := f.srv.processOf("work")
	f.srv.agentRun(context.Background(), f.itsaID(other), p, process.EntryAction{Do: "mail", To: "aboss", Itsa: "S-2", Node: "plan"})
	f.srv.WaitProcessRuns()
	if n := len(f.texts("SELECT 1 FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'aboss' AND m.notice = 1")); n != 1 {
		t.Errorf("a repeated entry mailed again: %d mails", n)
	}
	if got := f.notes(other); !strings.HasSuffix(got[len(got)-1], "process flow: plan: this entry was already acted on; ignored") {
		t.Errorf("the repeat: %q", got)
	}

	// With no chief of staff there is nobody to mail: the record says so and nothing is sent.
	f.setProcessSettings(`{"process":{"run":"on"}}`)
	third := f.createItsa(`{"title":"alone","kind":"work"}`)
	must(t, f.setAs(third, `{"stage":"plan"}`, "", process.RunnerActor))
	f.srv.WaitProcessRuns()
	if got := f.notes(third); len(got) != 1 || got[0] != "process flow: entering `plan` (by system:process) would skip: no cos to mail" {
		t.Errorf("no cos: %q", got)
	}
}

// A spawn passes the claim, the hourly cap and the working limit, in that order, and a refusal notes the ITSA and starts nothing.
func TestAgentSpawnDecisions(t *testing.T) {
	f, h := crewFixture(t, onSettings)
	p := f.srv.processOf("work")
	ctx := context.Background()
	run := func(key string) {
		t.Helper()
		f.srv.agentRun(ctx, f.itsaID(key), p, f.spawnAction(key, "code"))
		f.srv.WaitProcessRuns()
	}
	a := f.stagedItsa("first", "code")
	run(a)
	if h.count() != 1 || h.calls[0].Prompt != "Report to boss." || h.calls[0].Type != "developer" || h.calls[0].Parent != "aboss" || h.calls[0].Itsa != "S-1" {
		t.Errorf("the spawn: %+v", h.calls)
	}
	if got := f.notes(a); got[len(got)-1] != "process flow: spawned newdev (developer) for S-1" {
		t.Errorf("the outcome: %q", got)
	}
	if n := f.count("SELECT COUNT(*) FROM itsa_events WHERE itsa_id = ? AND type = 'process-spawn'", f.itsaID(a)); n != 1 {
		t.Errorf("claims: %d", n)
	}
	// The same entry again: ignored.
	run(a)
	if h.count() != 1 {
		t.Errorf("a repeated entry spawned again")
	}
	if got := f.notes(a); got[len(got)-1] != "process flow: code: this entry was already acted on; ignored" {
		t.Errorf("the repeat: %q", got)
	}

	// The hourly cap counts claims: two more pass (3), the next is refused.
	for _, title := range []string{"second", "third"} {
		run(f.stagedItsa(title, "code"))
	}
	if h.count() != 3 {
		t.Fatalf("spawns: %d", h.count())
	}
	capped := f.stagedItsa("capped", "code")
	run(capped)
	if h.count() != 3 {
		t.Errorf("a spawn over the cap started")
	}
	if got := f.notes(capped); got[len(got)-1] != "process flow: not spawning a developer: 3 process spawns in the last hour" {
		t.Errorf("the cap: %q", got)
	}
	if n := f.count("SELECT COUNT(*) FROM itsa_events WHERE itsa_id = ? AND type = 'process-spawn'", f.itsaID(capped)); n != 0 {
		t.Errorf("a refused spawn wrote a claim")
	}

	// The working limit: spawns in flight count, and so do the machine's working agents.
	f.setProcessSettings(`{"process":{"run":"on","maxSpawnsPerHour":100}}`)
	busy := f.stagedItsa("busy", "code")
	f.srv.runner.inFlight = map[string]int{"": 8}
	run(busy)
	f.srv.runner.inFlight = nil
	if got := f.notes(busy); got[len(got)-1] != "process flow: not spawning a developer: 8 agents already working on this machine" || h.count() != 3 {
		t.Errorf("the working limit: %q (%d spawns)", got, h.count())
	}
	f.sql("UPDATE agents SET activity = 'working' WHERE machine = 'test-machine'")
	working := f.count("SELECT COUNT(*) FROM agents WHERE machine = 'test-machine' AND lifecycle = 'active' AND activity = 'working'")
	f.srv.runner.inFlight = map[string]int{"": 8 - working}
	run(busy)
	f.srv.runner.inFlight = nil
	if got := f.notes(busy); !strings.Contains(got[len(got)-1], "agents already working on this machine") || h.count() != 3 {
		t.Errorf("the machine's working agents: %q", got)
	}

	// Another machine's work cannot be read here: refused with the reason.
	far := f.stagedItsa("far", "code")
	act := f.spawnAction(far, "code")
	act.Machine = "box-2"
	f.srv.agentRun(ctx, f.itsaID(far), p, act)
	f.srv.WaitProcessRuns()
	if got := f.notes(far); got[len(got)-1] != "process flow: not spawning a developer on box-2: can't read how many agents work there (no peer machine box-2)" {
		t.Errorf("a peer machine: %q", got)
	}
}

// A failed spawn mails the parent once and is not retried.
func TestAgentSpawnFailure(t *testing.T) {
	f, h := crewFixture(t, onSettings)
	h.err = errors.New("no room")
	p := f.srv.processOf("work")
	key := f.stagedItsa("fails", "code")
	for range 2 {
		f.srv.agentRun(context.Background(), f.itsaID(key), p, f.spawnAction(key, "code"))
		f.srv.WaitProcessRuns()
	}
	if h.count() != 1 {
		t.Errorf("a failed spawn was retried: %d", h.count())
	}
	notes := f.notes(key)
	if !strings.Contains(strings.Join(notes, "\n"), "process flow: spawning a developer for S-1 failed: no room") {
		t.Errorf("the notes: %q", notes)
	}
	mails := f.texts("SELECT m.subject || char(10) || m.body FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'aboss' AND m.notice = 1")
	if n := f.count("SELECT COUNT(*) FROM mail WHERE from_id = 'system:process' AND subject = 'Process spawn for S-1 failed'"); n != 1 {
		t.Errorf("from system:process: %d", n)
	}
	if len(mails) != 1 || mails[0] != "Process spawn for S-1 failed\nThe process flow could not spawn a developer for S-1: no room\n\nIt will not retry; the ITSA is unchanged." {
		t.Errorf("the parent's mail: %q", mails)
	}
	// The default start is not ported: it fails the same way, and the daemon does not crash.
	g, _ := crewFixture(t, onSettings)
	g.srv.runner.spawnAgent = nil
	k := g.stagedItsa("default", "code")
	g.srv.agentRun(context.Background(), g.itsaID(k), g.srv.processOf("work"), g.spawnAction(k, "code"))
	g.srv.WaitProcessRuns()
	if got := strings.Join(g.notes(k), "\n"); !strings.Contains(got, "is not ported to the Go daemon yet") {
		t.Errorf("the default spawn: %q", got)
	}
}

// Two entries racing for the same claim, or for the last place under the cap, are decided in one transaction: exactly one spawns. The
// first entry is held inside its transaction, after the checks and before the claim is written; the others then run up to their claim
// and are let go once it is released, so they can only see its claim if the check and the claim are one step.
func TestAgentSpawnRace(t *testing.T) {
	f, h := crewFixture(t, `{"process":{"run":"on","maxSpawnsPerHour":1},"chiefOfStaff":"boss"}`)
	p := f.srv.processOf("work")
	ctx := context.Background()
	a, b := f.stagedItsa("a", "code"), f.stagedItsa("b", "code")

	inside, release := make(chan struct{}), make(chan struct{})
	var held atomic.Bool
	arrived := make(chan string, 4)
	f.srv.runner.claimStep = func(id, step string) {
		if step == "before" {
			arrived <- id
			return
		}
		if held.CompareAndSwap(false, true) {
			close(inside)
			<-release
		}
	}
	f.srv.agentRun(ctx, f.itsaID(a), p, f.spawnAction(a, "code"))
	<-inside
	<-arrived // the first entry's own
	// The same entry again, and a different ITSA under the cap of 1: both reach their claim while the first holds its transaction.
	f.srv.agentRun(ctx, f.itsaID(a), p, f.spawnAction(a, "code"))
	f.srv.agentRun(ctx, f.itsaID(b), p, f.spawnAction(b, "code"))
	<-arrived
	<-arrived
	if n := f.count("SELECT COUNT(*) FROM itsa_events WHERE type = 'process-spawn'"); n != 0 {
		t.Fatalf("a claim was written while the first entry still held its transaction: %d", n)
	}
	close(release)
	f.srv.WaitProcessRuns()
	if h.count() != 1 {
		t.Errorf("%d spawns, want exactly one", h.count())
	}
	if n := f.count("SELECT COUNT(*) FROM itsa_events WHERE type = 'process-spawn'"); n != 1 {
		t.Errorf("%d claims, want exactly one", n)
	}
	if got := strings.Join(f.notes(a), "\n"); !strings.Contains(got, "already acted on") {
		t.Errorf("the repeat: %q", got)
	}
	if got := strings.Join(f.notes(b), "\n"); !strings.Contains(got, "1 process spawns in the last hour") {
		t.Errorf("the cap: %q", got)
	}
	if f.srv.runner.inFlight[""] != 0 {
		t.Errorf("a finished spawn is still counted in flight: %v", f.srv.runner.inFlight)
	}
}

// setBody is setItsa with a whole request body.
func (f *fixture) setBody(key, body, by string) error {
	f.t.Helper()
	v, err := jsfmt.Parse([]byte(body))
	must(f.t, err)
	_, err = f.srv.setItsa(context.Background(), key, v, by)
	return err
}

// The working limit is counted inside the claim's transaction. Entry b waits before its claim while entry a takes the one free place,
// its spawn ends and the new agent turns up working: a count taken before b's lock would still read the place as free.
func TestAgentSpawnLimitRace(t *testing.T) {
	f, h := crewFixture(t, `{"process":{"run":"on","maxSpawnsPerHour":100},"chiefOfStaff":"boss"}`)
	p := f.srv.processOf("work")
	ctx := context.Background()
	a, b := f.stagedItsa("a", "code"), f.stagedItsa("b", "code")
	addWorking := func(n int) {
		f.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT ?, ?, role, machine, harness, cwd, 'active', 'working', created_at, updated_at FROM agents WHERE id = 'achild'", "aw"+strconv.Itoa(n), "w"+strconv.Itoa(n))
	}
	working := f.count("SELECT COUNT(*) FROM agents WHERE machine = 'test-machine' AND lifecycle = 'active' AND activity = 'working'")
	// One place left: 7 of the 8 are taken, counting what the fixture already has working.
	for i := working; i < maxWorkingAgents-1; i++ {
		addWorking(i)
	}
	bId := f.itsaID(b)
	waiting, release := make(chan struct{}), make(chan struct{})
	f.srv.runner.claimStep = func(id, step string) {
		if id == bId && step == "before" {
			close(waiting)
			<-release
		}
	}
	f.srv.agentRun(ctx, bId, p, f.spawnAction(b, "code"))
	<-waiting
	f.srv.agentRun(ctx, f.itsaID(a), p, f.spawnAction(a, "code"))
	inFlight := func() int {
		f.srv.runner.mu.Lock()
		defer f.srv.runner.mu.Unlock()
		return f.srv.runner.inFlight[""]
	}
	waitFor(t, func() bool { return h.count() == 1 && inFlight() == 0 }, "a's spawn to end")
	addWorking(maxWorkingAgents)
	close(release)
	f.srv.WaitProcessRuns()
	if h.count() != 1 {
		t.Errorf("%d spawns for one free place", h.count())
	}
	if got := f.notes(b); !strings.Contains(strings.Join(got, "\n"), "8 agents already working on this machine") {
		t.Errorf("b's refusal: %q", got)
	}
}

// A claim is in the database, so a restart between two entries doesn't forget it: the second entry is ignored.
func TestAgentClaimSurvivesRestart(t *testing.T) {
	f, h := crewFixture(t, onSettings)
	key := f.stagedItsa("restart", "code")
	f.srv.agentRun(context.Background(), f.itsaID(key), f.srv.processOf("work"), f.spawnAction(key, "code"))
	f.srv.WaitProcessRuns()
	if h.count() != 1 {
		t.Fatalf("the first entry: %d spawns", h.count())
	}
	srv2 := New(f.cfg, config.NewSettingsFile(f.home, f.cfg.Machine), f.db, f.hub, nil)
	srv2.UseTemplates(f.srv.tpl)
	srv2.runner.spawnAgent = h.spawn
	t.Cleanup(srv2.WaitProcessRuns)
	srv2.agentRun(context.Background(), f.itsaID(key), srv2.processOf("work"), f.spawnAction(key, "code"))
	srv2.WaitProcessRuns()
	if h.count() != 1 {
		t.Errorf("the restarted daemon spawned again: %d", h.count())
	}
	if got := f.notes(key); got[len(got)-1] != "process flow: code: this entry was already acted on; ignored" {
		t.Errorf("the repeat: %q", got)
	}
}

// A runner-actor change that would spawn is refused before anything is written, also when the same change gives the ITSA its owner
// or the ITSA is made at that stage: neither the stage, the owner nor a claim is left behind.
func TestAgentRefusalSeesTheWholeChange(t *testing.T) {
	f, _ := crewFixture(t, onSettings)
	// Entering the developer lane with a live owner is a skip (the owner is alive): the refusal reads the owner the change sets.
	key := f.createItsa(`{"title":"owned","kind":"work"}`)
	f.sql("UPDATE itsas SET owner = 'achild' WHERE id = ?", f.itsaID(key))
	// The change clears the owner and enters the stage: that spawns, so it is refused.
	if err := f.setBody(key, `{"owner":null,"fields":{"stage":"code"}}`, process.RunnerActor); err == nil || !strings.Contains(err.Error(), "spawns a developer") {
		t.Errorf("an owner cleared with the stage: %v", err)
	}
	if got := f.stageOf(key); got != "" {
		t.Errorf("the refused change left the stage %q", got)
	}
	// An ITSA with no owner gets one in the same change: a skip, not a spawn, so it goes through.
	bare := f.createItsa(`{"title":"bare","kind":"work"}`)
	if err := f.setBody(bare, `{"owner":"achild","fields":{"stage":"code"}}`, process.RunnerActor); err != nil {
		t.Errorf("an owner set with the stage: %v", err)
	}
	// Made at the stage by the runner (no request reaches it today, but the check must not depend on that): refused outright.
	if err := f.srv.stageEntryRefusal(context.Background(), "", "work", "code", process.RunnerActor); err == nil || !strings.Contains(err.Error(), "agent node code") {
		t.Errorf("a runner create at an agent node: %v", err)
	}
	if err := f.srv.stageEntryRefusal(context.Background(), "", "work", "code", "human"); err != nil {
		t.Errorf("a person's create: %v", err)
	}
	if n := f.count("SELECT COUNT(*) FROM itsa_events WHERE type IN ('process-spawn', 'process-mail')"); n != 0 {
		t.Errorf("a claim was written: %d", n)
	}
}

// What an agent node needs about the ITSA is read live: the owner's life, the parent's owner, the chief of staff, a reviewer who takes
// part, and the registry's types.
func TestAgentContext(t *testing.T) {
	f, _ := crewFixture(t, onSettings)
	ctx := context.Background()
	key := f.createItsa(`{"title":"ctx","kind":"work"}`)
	id := f.itsaID(key)
	x := f.srv.agentContext(ctx, id)
	if x == nil || x.Key != key || x.OwnerLive || x.ReviewerLive || x.ParentOwner != "" || x.Cos != "aboss" {
		t.Fatalf("a fresh ITSA: %+v", x)
	}
	if !x.TypeKnown("developer") || x.TypeKnown("ghost") || !x.IsReviewerType("reviewer") || x.IsReviewerType("developer") {
		t.Errorf("the registry's types")
	}
	if f.srv.agentContext(ctx, "inope") != nil {
		t.Errorf("a missing ITSA has a context")
	}
	// A live owner; a dead one is not.
	f.sql("UPDATE itsas SET owner = 'achild' WHERE id = ?", id)
	if !f.srv.agentContext(ctx, id).OwnerLive {
		t.Errorf("a live owner reads as gone")
	}
	f.sql("UPDATE itsas SET owner = 'agone' WHERE id = ?", id)
	if f.srv.agentContext(ctx, id).OwnerLive {
		t.Errorf("an archived owner reads as live")
	}
	// A reviewer on the ITSA, or on its parent ITSA (the legacy role counts when the agent has no type).
	parent := f.createItsa(`{"title":"parent","kind":"work"}`)
	f.sql("UPDATE itsas SET parent_id = ? WHERE id = ?", f.itsaID(parent), id)
	f.sql("UPDATE itsas SET owner = 'aboss' WHERE id = ?", f.itsaID(parent))
	f.sql("INSERT INTO itsa_participants (itsa_id, agent_id) VALUES (?, 'acodex')", f.itsaID(parent))
	x = f.srv.agentContext(ctx, id)
	if !x.ReviewerLive || x.ParentOwner != "aboss" {
		t.Errorf("a reviewer of the parent: %+v", x)
	}
	// A reviewer that left (itsa_participants.left_at, S-3015) no longer takes part.
	f.sql("UPDATE itsa_participants SET left_at = '2026-01-01T00:00:00.000Z' WHERE agent_id = 'acodex'")
	if f.srv.agentContext(ctx, id).ReviewerLive {
		t.Errorf("a reviewer that left reads as live")
	}
	f.sql("DELETE FROM itsa_participants")
	f.sql("INSERT INTO itsa_participants (itsa_id, agent_id) VALUES (?, 'achild')", id)
	if f.srv.agentContext(ctx, id).ReviewerLive {
		t.Errorf("a developer reads as a reviewer")
	}

	// Entering a developer lane: a spawn, or a skip when the ITSA already has a live owner; the runner's spawn is refused before the
	// write, its skip and a person's entry are not.
	p := f.srv.processOf("work")
	f.sql("UPDATE itsas SET owner = NULL WHERE id = ?", id)
	if err := f.srv.stageEntryRefusal(ctx, id, "work", "code", process.RunnerActor); err == nil || !strings.Contains(err.Error(), "spawns a developer") {
		t.Errorf("the runner's spawn: %v", err)
	}
	if err := f.srv.stageEntryRefusal(ctx, id, "work", "code", "human"); err != nil {
		t.Errorf("a person's entry: %v", err)
	}
	if err := f.srv.stageEntryRefusal(ctx, id, "work", "plan", process.RunnerActor); err != nil {
		t.Errorf("the runner's mail: %v", err)
	}
	f.sql("UPDATE itsas SET owner = 'achild' WHERE id = ?", id)
	if err := f.srv.stageEntryRefusal(ctx, id, "work", "code", process.RunnerActor); err != nil {
		t.Errorf("the runner's skip (a live owner): %v", err)
	}
	if acts := process.EntryActions(p, "code", nil, "", f.srv.agentContext(ctx, id)); len(acts) != 1 || acts[0].Do != "skip" || acts[0].Why != key+" already has a live owner" {
		t.Errorf("actions: %+v", acts)
	}
}

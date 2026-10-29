package server

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// typeSpawnFixture is a spawnFixture whose registry is the checkout's, with the tester type of e2e-agent-types.sh. Its
// spawns start in the fixture's home, which counts as outside any git repo even when TMPDIR is under a worktree
// (scripts/test-slot.sh, S-2586): git stops looking at the home's parent, so a reviewer type gets its plain directory.
func typeSpawnFixture(t *testing.T) *fixture { return typeSpawnFixtureTmux(t, sessionTmux(t)) }

// typeSpawnFixtureTmux is typeSpawnFixture with its own tmux binary.
func typeSpawnFixtureTmux(t *testing.T, bin string) *fixture {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	t.Setenv("GIT_CEILING_DIRECTORIES", filepath.Dir(f.home))
	withLifeRootTmux(f, "../../..", bin)
	f.srv.tpl.Root = "../../.."
	f.srv.tpl.Machine = f.cfg.Machine
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE lifecycle = 'active'")
	if rec := f.human("POST", "/api/types/tester", `{"description":"Writes tests.","harness":"claude","model":"claude-haiku-5-5","effort":"low","child_notices":"none","visibility":{"reach":"tree"},"standing":true,"brief":"Do: {{task}} | parent={{parent}} | ticket={{ticket}} | type={{type}}"}`); rec.Code != 200 {
		t.Fatalf("the tester type: %d %s", rec.Code, rec.Body)
	}
	return f
}

type spawnedAgent struct {
	Type, Harness, Role, Visibility string
	Model, Effort                   *string
	FirstPrompt                     *string `json:"first_prompt"`
	Notices                         *string `json:"child_notices"`
	Standing                        int
}

func (f *fixture) spawnAs(fields string) (spawnedAgent, int, string) {
	f.t.Helper()
	rec := f.spawn(sharedTok, fields)
	var a spawnedAgent
	_ = json.Unmarshal(rec.Body.Bytes(), &a)
	return a, rec.Code, rec.Body.String()
}

func str0(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// TestSpawnByType: a type sets the preset, role, visibility, child notices and brief; explicit fields win; another
// harness drops the type's model and effort; a preset sets harness, model and effort; an unknown type is a 400, as is a
// developer outside a git repo (its worktree has no repo), a ring type is a 501, and cos is the human's, all before any
// row.
func TestSpawnByType(t *testing.T) {
	f := typeSpawnFixture(t)
	a, code, body := f.spawnAs(`"name":"mgr","type":"manager"`)
	if code != 200 || a.Type != "manager" || a.Harness != "claude" || str0(a.Model) != "claude-opus-5-5" || str0(a.Effort) != "medium" || a.Role != "manager" || a.FirstPrompt != nil {
		t.Fatalf("manager: %d %s", code, body)
	}
	a, code, body = f.spawnAs(`"name":"t1","type":"tester","parent":"mgr","prompt":"write tests","brief_vars":{"ticket":"T-7","task":"not this"}`)
	if code != 200 || str0(a.FirstPrompt) != "Do: write tests | parent=mgr | ticket=T-7 | type=tester" || str0(a.Notices) != "none" || a.Visibility != `{"reach":"tree"}` || str0(a.Model) != "claude-haiku-5-5" || a.Standing != 0 {
		t.Errorf("tester: %d %s", code, body)
	}
	a, code, body = f.spawnAs(`"name":"t2","type":"tester","model":"claude-sonnet-5-5","effort":"high","role":"Special.","child_notices":"turn"`)
	if code != 200 || str0(a.Model) != "claude-sonnet-5-5" || str0(a.Effort) != "high" || a.Role != "Special." || str0(a.Notices) != "turn" || a.FirstPrompt != nil {
		t.Errorf("explicit fields: %d %s", code, body)
	}
	// The reviewer type outside a git repo runs in a plain directory; on claude it drops codex's model and effort.
	a, code, body = f.spawnAs(`"name":"t3","type":"reviewer","harness":"claude"`)
	if code != 200 || a.Harness != "claude" || a.Model != nil || a.Effort != nil || a.Type != "reviewer" {
		t.Errorf("reviewer on claude: %d %s", code, body)
	}
	a, code, body = f.spawnAs(`"name":"t4","preset":"fast"`)
	if code != 200 || str0(a.Model) != "claude-haiku-5-5" || str0(a.Effort) != "low" || a.Type != "" {
		t.Errorf("preset: %d %s", code, body)
	}
	for _, tc := range []struct {
		fields string
		code   int
		want   string
	}{
		{`"name":"x1","type":"nope"`, 400, "no agent type nope; see stam registry"},
		{`"name":"x1","preset":"nope"`, 400, "nope"},
		{`"name":"x1","type":"developer"`, 400, "workspace: " + f.home + " is not in a git repo"},
		{`"name":"x1","type":"cos"`, 403, "only the human and the assistant spawn a chief of staff"},
		{`"name":"x1","type":"review-ring"`, 403, "a ring needs a creator"},
		{`"name":"x1","type":"review-ring","harness":"claude"`, 400, "a ring reviewer type takes no harness"},
	} {
		if _, code, body := f.spawnAs(tc.fields); code != tc.code || !strings.Contains(body, tc.want) {
			t.Errorf("%s: %d %s, want %d %q", tc.fields, code, body, tc.code, tc.want)
		}
	}
	// The human's spawn may make the assistant; anyone else's `kind` is ignored.
	if rec := f.human("POST", "/api/agents", `{"name":"ea","harness":"claude","kind":"assistant","cwd":"`+f.home+`"}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"kind":"assistant"`) {
		t.Errorf("the human's assistant: %d %s", rec.Code, rec.Body)
	}
	if _, code, body := f.spawnAs(`"name":"ea2","harness":"claude","kind":"assistant"`); code != 200 || strings.Contains(body, `"kind":"assistant"`) {
		t.Errorf("an assistant without the human: %d %s", code, body)
	}
	if n := f.count("SELECT count(*) FROM agents WHERE name = 'x1'"); n != 0 {
		t.Errorf("a refused spawn made a row")
	}
}

// TestSpawnReviewerJoinsItsa: a reviewer type spawned with `itsa` joins it as a participant and the owner stays (S-501,
// src/itsa-owners.ts attachSpawned); its first prompt carries the participant's block. Another type takes ownership.
func TestSpawnReviewerJoinsItsa(t *testing.T) {
	f := typeSpawnFixture(t)
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id = 'aboss'")
	key := f.createItsa(`{"title":"Review me","owner":"aboss"}`)
	a, code, body := f.spawnAs(`"name":"rev","type":"reviewer","harness":"claude","itsa":"` + key + `","prompt":"review it"`)
	if code != 200 || a.Type != "reviewer" {
		t.Fatalf("reviewer spawn: %d %s", code, body)
	}
	id := f.text("SELECT id FROM agents WHERE name = 'rev'")
	if owner := f.text("SELECT coalesce(owner, '') FROM itsas WHERE key = ?", key); owner != "aboss" {
		t.Errorf("the reviewer took the ITSA: owner %q", owner)
	}
	if n := f.count("SELECT count(*) FROM itsa_participants p JOIN itsas i ON i.id = p.itsa_id WHERE i.key = ? AND p.agent_id = ?", key, id); n != 1 {
		t.Errorf("the reviewer isn't a participant (%d rows)", n)
	}
	if !strings.Contains(str0(a.FirstPrompt), key) || strings.Contains(str0(a.FirstPrompt), "You own") {
		t.Errorf("the reviewer's prompt: %q", str0(a.FirstPrompt))
	}
	if _, code, body := f.spawnAs(`"name":"t5","type":"tester","itsa":"` + key + `","prompt":"test it"`); code != 200 {
		t.Fatalf("tester spawn: %d %s", code, body)
	}
	if owner := f.text("SELECT coalesce(owner, '') FROM itsas WHERE key = ?", key); owner != f.text("SELECT id FROM agents WHERE name = 't5'") {
		t.Errorf("the tester didn't take the ITSA: owner %q", owner)
	}
}

// TestTypeSpawnFixtureArchives: the fixture's tmux keeps the session a spawn starts, through tmux.Client.NewSession's
// source-file, drops it when a shutdown kills it, and the stopped agent then archives. With /bin/true every session stays
// alive and the archive fails "started again while archiving" (S-4167).
func TestTypeSpawnFixtureArchives(t *testing.T) {
	f := typeSpawnFixture(t)
	if _, code, body := f.spawnAs(`"name":"t1","type":"tester"`); code != 200 {
		t.Fatalf("spawn: %d %s", code, body)
	}
	ctx, id := context.Background(), f.agentField("t1", "id")
	if !f.srv.life.HasSession(ctx, id) {
		t.Fatal("t1's session doesn't run after the spawn")
	}
	if rec := f.human("POST", "/api/agents/t1/shutdown", `{"now":true}`); rec.Code != 200 {
		t.Fatalf("shutdown: %d %s", rec.Code, rec.Body)
	}
	if f.srv.life.HasSession(ctx, id) {
		t.Fatal("t1's session still runs after the shutdown")
	}
	if rec := f.human("POST", "/api/agents/t1/archive", `{}`); rec.Code != 200 {
		t.Fatalf("archive: %d %s", rec.Code, rec.Body)
	}
	if got := f.agentField("t1", "lifecycle"); got != "archived" {
		t.Errorf("t1 is %q, not archived: %s", got, f.agentField("t1", "activity_detail"))
	}
}

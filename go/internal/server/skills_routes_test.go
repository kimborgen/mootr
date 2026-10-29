package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/tiny"
)

// TestSkillsRoutes: src/daemon.ts's skills routes. The list names the types a skill is attached to and its body's
// stored summary, or off or pending; only the human checks for updates and imports, a refused import is a 400, and an
// import links the new skill into every harness's folder.
func TestSkillsRoutes(t *testing.T) {
	user := t.TempDir()
	agents := filepath.Join(t.TempDir(), "agents")
	t.Setenv("HOME", user)
	t.Setenv("STAM_AGENTS_SKILLS", agents)
	t.Setenv("STAM_TEST_ALLOW_FILE_SKILLS", "1")
	f := controlFixture(t)
	body := "Keep it tidy.\n"
	must(t, os.MkdirAll(filepath.Join(f.home, "skills", "own"), 0o755))
	must(t, os.WriteFile(filepath.Join(f.home, "skills", "own", "SKILL.md"), []byte("---\ndescription: Own.\n---\n"+body), 0o644))
	must(t, os.MkdirAll(filepath.Join(user, ".claude", "skills", "plain"), 0o755))
	must(t, os.WriteFile(filepath.Join(user, ".claude", "skills", "plain", "SKILL.md"), []byte("plain"), 0o644))
	must(t, os.WriteFile(filepath.Join(f.home, "registry.json"), []byte(`{"types":{"tester":{"harness":"claude","skills":["own"]},"other":{"harness":"claude","skills":"own"}}}`), 0o600))
	f.sql("INSERT INTO block_summaries (hash, summary, model, created_at, config_hash) VALUES (?, 'Tidies.', 'm', '2026-01-01T00:00:00.000Z', ?)",
		tiny.TextHash(body), tiny.ConfigHash("m", "Mine."))
	list := func() string { return f.do(call{path: "/api/skills", token: agentTok}).Body.String() }
	// With the model off, a stored summary shows and a missing one is off.
	got := list()
	if !strings.Contains(got, `{"name":"plain","path":"`+filepath.Join(user, ".claude", "skills", "plain")+`","source":"user","description":"","tokens":2,"extraTokens":0,"reaches":{"claude":"native","opencode":"unreachable","codex":"unreachable"},"attachedTo":[],"bodySummary":{"state":"off"}}`) ||
		!strings.Contains(got, `"name":"own"`) || !strings.Contains(got, `"attachedTo":["tester"],"bodySummary":{"summary":"Tidies.","state":"auto"}}`) {
		t.Errorf("the skills, model off: %s", got)
	}
	// With a model, the summary shows when it was asked with that model and prompt; else it is pending.
	writeSettings(t, f, `{"instructions":{"summaries":{"model":"m"}},"tiny":{"blockSummaries":{"instructions":"Mine."}}}`)
	if got := list(); !strings.Contains(got, `"bodySummary":{"summary":"Tidies.","state":"auto"}`) || !strings.Contains(got, `"bodySummary":{"state":"pending"}`) {
		t.Errorf("the skills, model on: %s", got)
	}
	writeSettings(t, f, `{"instructions":{"summaries":{"model":"other"}}}`)
	if got := list(); strings.Contains(got, `"state":"auto"`) {
		t.Errorf("a summary asked with another model shows: %s", got)
	}
	for _, c := range []call{{path: "/api/skills/updates", token: agentTok}, {path: "/api/skills/updates", token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}},
		{method: "POST", path: "/api/skills/import", token: agentTok, body: `{"source":"a/b"}`}, {method: "POST", path: "/api/skills/update", token: sharedTok, body: `{"name":"own"}`}} {
		if rec := f.do(c); rec.Code != 403 || !strings.Contains(rec.Body.String(), "only the human can") {
			t.Errorf("%s %s without the human's proof: %d %s", c.method, c.path, rec.Code, rec.Body)
		}
	}
	if rec := f.do(call{path: "/api/skills/updates", header: humanHeader()}); rec.Code != 200 || rec.Body.String() != "{}" {
		t.Errorf("updates with nothing imported: %d %s", rec.Code, rec.Body)
	}
	for body, want := range map[string]string{`{"source":"gitlab.com/a/b"}`: "only github.com sources can be imported", `{}`: "give a GitHub URL"} {
		if rec := f.do(call{method: "POST", path: "/api/skills/import", header: humanHeader(), body: body}); rec.Code != 400 || !strings.Contains(rec.Body.String(), want) {
			t.Errorf("import %s: %d %s", body, rec.Code, rec.Body)
		}
	}
	if rec := f.do(call{method: "POST", path: "/api/skills/update", header: humanHeader(), body: `{"name":"own"}`}); rec.Code != 400 || !strings.Contains(rec.Body.String(), `\"own\" was not imported`) {
		t.Errorf("update a skill that wasn't imported: %d %s", rec.Code, rec.Body)
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	repo := filepath.Join(t.TempDir(), "repo")
	must(t, os.MkdirAll(filepath.Join(repo, "skills", "tidy"), 0o755))
	must(t, os.WriteFile(filepath.Join(repo, "skills", "tidy", "SKILL.md"), []byte("---\nname: tidy\ndescription: Tidy up.\n---\nbody\n"), 0o644))
	for _, args := range [][]string{{"init", "-q"}, {"add", "-A"}, {"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	rec := f.do(call{method: "POST", path: "/api/skills/import", header: humanHeader(), body: `{"source":"file://` + repo + `#skills/tidy"}`})
	target := filepath.Join(f.home, "skills", "tidy")
	if rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), `{"name":"tidy","path":"`+target+`","commit":"`) || !strings.HasSuffix(rec.Body.String(), `"updated":false}`) {
		t.Fatalf("an import: %d %s", rec.Code, rec.Body)
	}
	for _, l := range []string{filepath.Join(agents, "tidy"), filepath.Join(f.home, "opencode", "skills", "tidy"), filepath.Join(f.home, "claude-plugin", "skills", "tidy")} {
		if to, err := os.Readlink(l); err != nil || to != target {
			t.Errorf("%s links to %q (%v), not the new skill", l, to, err)
		}
	}
	if got := list(); !strings.Contains(got, `"name":"tidy","path":"`+target+`","source":"imported","origin":{"url":"file://`) || !strings.Contains(got, `"reaches":{"claude":"native","opencode":"native","codex":"native"}`) {
		t.Errorf("the imported skill: %s", got)
	}
	if rec := f.do(call{path: "/api/skills/updates", header: humanHeader()}); rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), `{"tidy":{"moved":false,"commit":"`) {
		t.Errorf("updates: %d %s", rec.Code, rec.Body)
	}
}

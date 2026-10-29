package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSpawnPersonalWorkspace: `workspace` gives an agent a 0700 folder at STAM_HOME/workspaces/NAME, its own name for
// true. One live agent holds a folder; an archived one's is adopted by a respawn, as it is. A name that isn't lowercase
// letters, digits and dashes is a 400 before any worktree or folder exists.
func TestSpawnPersonalWorkspace(t *testing.T) {
	f, repo := worktreeFixture(t)
	dir := filepath.Join(f.srv.cfg.Home, "workspaces")
	rec := f.spawnIn(repo, `"name":"p1","harness":"claude","workspace":true`)
	if rec.Code != 200 {
		t.Fatalf("workspace true: %d %s", rec.Code, rec.Body)
	}
	var a struct {
		PersonalWorkspace *string `json:"personal_workspace"`
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &a))
	path := filepath.Join(dir, "p1")
	if str0(a.PersonalWorkspace) != path {
		t.Errorf("personal_workspace = %q, want %s", str0(a.PersonalWorkspace), path)
	}
	if st, err := os.Stat(path); err != nil || st.Mode().Perm() != 0o700 {
		t.Errorf("the folder: %v %v", st, err)
	}
	must(t, os.WriteFile(filepath.Join(path, "notes"), []byte("kept"), 0o600))
	if rec := f.spawnIn(repo, `"name":"p2","harness":"claude","workspace":"p1"`); rec.Code != 409 || !strings.Contains(rec.Body.String(), "workspace p1 is held by p1") {
		t.Errorf("a held workspace: %d %s", rec.Code, rec.Body)
	}
	if rec := f.spawnIn(repo, `"name":"p3","harness":"claude","workspace":false`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"personal_workspace":null`) {
		t.Errorf("workspace false: %d %s", rec.Code, rec.Body)
	}
	// A respawned specialist adopts the archived one's folder, notes and all.
	f.sql("UPDATE agents SET lifecycle = 'archived' WHERE name = 'p1'")
	if rec := f.spawnIn(repo, `"name":"p4","harness":"claude","workspace":"p1"`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"personal_workspace":"`+path+`"`) {
		t.Errorf("adopting an archived one's: %d %s", rec.Code, rec.Body)
	}
	if b, err := os.ReadFile(filepath.Join(path, "notes")); err != nil || string(b) != "kept" {
		t.Errorf("the adopted folder's notes: %q %v", b, err)
	}
	// A developer would get a worktree: a bad name refuses before it.
	for _, bad := range []string{`"../x"`, `"-x"`, `"A"`, `"x y"`, `""`, `"x/y"`, `"x\n"`, `".."`, `"` + strings.Repeat("a", 42) + `"`, `"$(id)"`} {
		rec := f.spawnIn(repo, `"name":"h1","type":"developer","workspace":`+bad)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), "must be lowercase letters, digits, and dashes") {
			t.Errorf("workspace %s: %d %s", bad, rec.Code, rec.Body)
		}
	}
	if _, err := os.Stat(filepath.Join(f.home, "worktrees", "repo-h1")); err == nil {
		t.Error("a refused workspace name made a worktree")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Errorf("the workspaces folder holds %d entries, want only p1's", len(entries))
	}
	if _, err := os.Stat(filepath.Join(f.srv.cfg.Home, "x")); err == nil {
		t.Error("a ../ name made a folder outside the workspaces folder")
	}
}

// TestSpawnPersonalWorkspaceFails: a folder that can't be made undoes the spawn's worktree, and one that can't be
// inspected (EACCES) is an error, not taken for missing.
func TestSpawnPersonalWorkspaceFails(t *testing.T) {
	f, repo := worktreeFixture(t)
	dir := filepath.Join(f.srv.cfg.Home, "workspaces")
	must(t, os.WriteFile(dir, nil, 0o600))
	rec := f.spawnIn(repo, `"name":"w1","type":"developer","workspace":true`)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "workspace: ") {
		t.Errorf("a workspaces file: %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Lstat(filepath.Join(f.home, "worktrees", "repo-w1")); err == nil {
		t.Error("the failed spawn's worktree is still there")
	}
	if out := gitIn(t, repo, "branch", "--list", "stam/w1"); out != "" {
		t.Errorf("the failed spawn's branch is still there: %s", out)
	}
	must(t, os.Remove(dir))
	must(t, os.MkdirAll(filepath.Join(dir, "w2"), 0o700))
	must(t, os.Chmod(dir, 0))
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	if rec := f.spawnIn(repo, `"name":"w2","harness":"claude","workspace":true`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "permission denied") {
		t.Errorf("an uninspectable folder: %d %s", rec.Code, rec.Body)
	}
	if n := f.count("SELECT count(*) FROM agents WHERE name IN ('w1', 'w2')"); n != 0 {
		t.Errorf("failed spawns made %d rows", n)
	}
}

// TestSpawnWorkspaceScript: a workspace script runs in the cwd and prints the directory to work in; the agent's name
// reaches it only in its environment, and the daemon's own token doesn't. A script that fails, prints no existing
// directory, or overruns its bound is a 400; one that prints the live checkout is refused for a developer.
func TestSpawnWorkspaceScript(t *testing.T) {
	f, repo := worktreeFixture(t)
	t.Setenv("STAM_TOKEN", "daemon-secret")
	plain := filepath.Join(f.srv.cfg.Home, "plain")
	must(t, os.MkdirAll(plain, 0o755))
	script := `mkdir -p \"d-$STAM_AGENT_NAME\" && printf %s \"$MOOTR_AGENT_NAME ${STAM_TOKEN:-none}\" > \"d-$STAM_AGENT_NAME/who\" && echo noise && echo \"d-$STAM_AGENT_NAME\"`
	rec := f.spawnIn(plain, `"name":"s1","harness":"claude","workspace_script":"`+script+`"`)
	if rec.Code != 200 {
		t.Fatalf("a script spawn: %d %s", rec.Code, rec.Body)
	}
	var a struct {
		Cwd       string `json:"cwd"`
		Workspace string `json:"workspace"`
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &a))
	want := filepath.Join(plain, "d-s1")
	if a.Cwd != want {
		t.Errorf("cwd %s, want %s", a.Cwd, want)
	}
	if b, err := os.ReadFile(filepath.Join(want, "who")); err != nil || string(b) != "s1 none" {
		t.Errorf("what the script saw: %q %v", b, err)
	}
	var ws struct {
		Spec struct{ Kind, Command, Cwd string }
		Cwd  string
	}
	must(t, json.Unmarshal([]byte(a.Workspace), &ws))
	if ws.Spec.Kind != "script" || ws.Spec.Cwd != plain || ws.Cwd != want || !strings.HasPrefix(ws.Spec.Command, "mkdir -p ") {
		t.Errorf("workspace %s", a.Workspace)
	}
	f.srv.cfg.DeployRepo = repo
	t.Setenv("STAM_WORKSPACE_SCRIPT_TIMEOUT_MS", "300")
	for _, tc := range []struct{ fields, want string }{
		{`"workspace_script":"echo nope"`, "workspace: workspace script printed no existing directory: nope"},
		{`"workspace_script":"touch f; echo f"`, "workspace: workspace script printed no existing directory: f"},
		{`"workspace_script":"true"`, "workspace: workspace script printed no existing directory: "},
		{`"workspace_script":"echo oops >&2; exit 3"`, `workspace: Command failed: sh -c echo oops >&2; exit 3\noops`},
		{`"workspace_script":"sleep 30"`, "workspace: workspace script timed out after 0.3s"},
		{`"workspace_script":"echo .","base":"origin/main"`, "base needs a worktree spawn"},
		// A developer's script started somewhere safe that prints the live checkout.
		{`"type":"developer","workspace_script":"echo ` + repo + `"`, repo + " is in the live deploy checkout " + repo},
	} {
		fields := `"name":"s2","harness":"claude",` + tc.fields
		if strings.Contains(tc.fields, `"type"`) {
			fields = `"name":"s2",` + tc.fields
		}
		if rec := f.spawnIn(plain, fields); rec.Code != 400 || !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("%s: %d %s, want 400 %q", tc.fields, rec.Code, rec.Body, tc.want)
		}
	}
	if n := f.count("SELECT count(*) FROM agents WHERE name = 's2'"); n != 0 {
		t.Error("a refused script spawn made a row")
	}
}

// TestSpawnWorkspaceInstructions: instructions leave the agent in the cwd and come first in its prompt, before an owned
// ITSA's block and the brief; they keep a developer type from its worktree default.
func TestSpawnWorkspaceInstructions(t *testing.T) {
	f, _ := worktreeFixture(t)
	plain := filepath.Join(f.srv.cfg.Home, "plain")
	must(t, os.MkdirAll(plain, 0o755))
	rec := f.spawnIn(plain, `"name":"i1","type":"developer","workspace_instructions":"clone it into ~/x","prompt":"fix it"`)
	if rec.Code != 200 {
		t.Fatalf("an instructions spawn: %d %s", rec.Code, rec.Body)
	}
	var a struct {
		Cwd         string  `json:"cwd"`
		Workspace   string  `json:"workspace"`
		FirstPrompt *string `json:"first_prompt"`
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &a))
	if a.Cwd != plain || a.Workspace != `{"spec":{"kind":"instructions","text":"clone it into ~/x","cwd":"`+plain+`"},"cwd":"`+plain+`"}` {
		t.Errorf("cwd %s workspace %s", a.Cwd, a.Workspace)
	}
	if p := str0(a.FirstPrompt); !strings.HasPrefix(p, "[stam] Before anything else, create your own workspace as follows, then work inside it: clone it into ~/x\n\n") || !strings.Contains(p, "fix it") {
		t.Errorf("the prompt: %q", p)
	}
}

// TestSpawnPersonalWorkspaceInFlight: a second spawn naming a workspace that a spawn in flight holds is a 409, though
// neither row exists yet, so two agents never take one folder.
func TestSpawnPersonalWorkspaceInFlight(t *testing.T) {
	f, repo := worktreeFixture(t)
	held, release := make(chan struct{}), make(chan struct{})
	f.srv.devSlots.afterTree = func(name string) {
		if name == "q1" {
			close(held)
			<-release
		}
	}
	first := make(chan int)
	go func() { first <- f.spawnIn(repo, `"name":"q1","type":"developer","workspace":"shared"`).Code }()
	<-held
	rec := f.spawnIn(repo, `"name":"q2","type":"developer","workspace":"shared"`)
	close(release)
	if rec.Code != 409 || !strings.Contains(rec.Body.String(), "workspace shared is held by a spawn in progress") {
		t.Errorf("the second spawn: %d %s", rec.Code, rec.Body)
	}
	if code := <-first; code != 200 {
		t.Errorf("the first spawn: %d", code)
	}
	if rec := f.spawnIn(repo, `"name":"q3","harness":"claude","workspace":"shared"`); rec.Code != 409 || !strings.Contains(rec.Body.String(), "workspace shared is held by q1") {
		t.Errorf("after the first's row: %d %s", rec.Code, rec.Body)
	}
}

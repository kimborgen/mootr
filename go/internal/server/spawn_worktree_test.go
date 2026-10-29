package server

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// worktreeFixture is a typeSpawnFixture with a checkout (an origin holding main) inside its home; it returns the
// checkout's path.
func worktreeFixture(t *testing.T) (*fixture, string) {
	f := typeSpawnFixture(t)
	home, err := filepath.EvalSymlinks(f.home)
	must(t, err)
	repo, origin := filepath.Join(home, "repo"), filepath.Join(home, "origin.git")
	gitIn(t, home, "init", "-q", "--bare", "-b", "main", origin)
	gitIn(t, home, "init", "-q", "-b", "main", repo)
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "base")
	gitIn(t, repo, "remote", "add", "origin", origin)
	gitIn(t, repo, "push", "-q", "origin", "main")
	return f, repo
}

func (f *fixture) spawnIn(cwd, fields string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.do(call{method: "POST", path: "/api/agents", token: sharedTok, body: `{"cwd":"` + cwd + `",` + fields + `}`})
}

// TestSpawnWorktree: a developer type gets its own worktree on stam/NAME, cut from the fetched origin/main: the row's cwd
// and workspace hold it (what a restart and the archive read), the workspace:base event says where it was cut from, and
// the brief's {{branch}} names it. An explicit worktree, branch and base are taken as given.
func TestSpawnWorktree(t *testing.T) {
	f, repo := worktreeFixture(t)
	rec := f.spawnIn(repo, `"name":"dev1","type":"developer","prompt":"fix it"`)
	if rec.Code != 200 {
		t.Fatalf("developer spawn: %d %s", rec.Code, rec.Body)
	}
	var a struct {
		Cwd         string  `json:"cwd"`
		Workspace   string  `json:"workspace"`
		FirstPrompt *string `json:"first_prompt"`
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &a))
	path := filepath.Join(f.home, "worktrees", "repo-dev1")
	main := gitIn(t, repo, "rev-parse", "main")
	want := `{"spec":{"kind":"worktree","repo":"` + repo + `"},"cwd":"` + path + `","worktree":{"repo":"` + repo + `","path":"` + path + `","branch":"stam/dev1"},"deps":[],"baseUsed":{"ref":"origin/main","sha":"` + main + `","fetch":"ok","defaulted":true}}`
	if a.Cwd != path || a.Workspace != want {
		t.Errorf("the row: cwd %s\nworkspace %s\nwant      %s", a.Cwd, a.Workspace, want)
	}
	if head := gitIn(t, path, "rev-parse", "--abbrev-ref", "HEAD"); head != "stam/dev1" {
		t.Errorf("the worktree is on %s", head)
	}
	id := f.text("SELECT id FROM agents WHERE name = 'dev1'")
	if ev := f.text("SELECT data FROM events WHERE agent_id = ? AND type = 'workspace:base'", id); ev != `{"ref":"origin/main","sha":"`+main+`","fetch":"ok","defaulted":true}` {
		t.Errorf("workspace:base = %s", ev)
	}
	if !strings.Contains(str0(a.FirstPrompt), "fix it") {
		t.Errorf("the brief: %q", str0(a.FirstPrompt))
	}
	// A plain spawn asking for a worktree, an explicit branch and a base; the base stacks the PR, said in the prompt.
	gitIn(t, repo, "push", "-q", "origin", "main:feature")
	rec = f.spawnIn(repo, `"name":"dev2","harness":"claude","worktree":true,"branch":"topic/x","base":"origin/feature","prompt":"go"`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `\"branch\":\"topic/x\",\"base\":\"origin/feature\"`) || !strings.Contains(rec.Body.String(), "Your branch is cut from origin/feature, so your PR stacks on it.") {
		t.Errorf("worktree, branch and base: %d %s", rec.Code, rec.Body)
	}
}

// TestSpawnWorktreeRefusals: a base without a worktree, a hostile branch or base, and a base that doesn't resolve are
// 400s; a developer without a worktree in the live deploy checkout is refused, before any row or worktree.
func TestSpawnWorktreeRefusals(t *testing.T) {
	f, repo := worktreeFixture(t)
	f.srv.cfg.DeployRepo = repo
	for _, tc := range []struct{ fields, want string }{
		{`"name":"x1","harness":"claude","base":"origin/main"`, "base needs a worktree spawn"},
		{`"name":"x1","harness":"claude","worktree":true,"branch":"--upload-pack=touch /tmp/x"`, `workspace: branch \"--upload-pack=touch /tmp/x\" starts with -`},
		{`"name":"x1","harness":"claude","worktree":true,"branch":"a..b"`, `workspace: branch \"a..b\" is not a valid ref name`},
		{`"name":"x1","harness":"claude","worktree":true,"base":"-q"`, `workspace: base \"-q\" starts with -`},
		{`"name":"x1","harness":"claude","worktree":true,"base":"main; id"`, `workspace: base \"main; id\" is not a valid ref name`},
		// A valid ref name that a shell would expand is only a name here: it doesn't resolve.
		{`"name":"x1","harness":"claude","worktree":true,"base":"$(id)"`, "workspace: base $(id) does not resolve to a commit"},
		{`"name":"x1","harness":"claude","worktree":true,"base":"origin/nope"`, "workspace: base origin/nope does not resolve to a commit in " + repo + " (after fetching origin)"},
		{`"name":"x1","type":"developer","worktree":false`, repo + " is in the live deploy checkout " + repo + ", the repo the deploy watcher deploys from"},
	} {
		rec := f.spawnIn(repo, tc.fields)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("%s: %d %s, want 400 %q", tc.fields, rec.Code, rec.Body, tc.want)
		}
	}
	if n := f.count("SELECT count(*) FROM agents WHERE name = 'x1'"); n != 0 {
		t.Error("a refused spawn made a row")
	}
	if _, err := os.Stat(filepath.Join(f.home, "worktrees", "repo-x1")); err == nil {
		t.Error("a refused spawn made a worktree")
	}
	// Another type is left alone in the checkout: a manager works where its parent does.
	if rec := f.spawnIn(repo, `"name":"m1","type":"manager"`); rec.Code != 200 {
		t.Errorf("a manager in the checkout: %d %s", rec.Code, rec.Body)
	}
}

// TestSpawnDeveloperCap: a developer spawn at the cap is queued, its reply naming the holders, before any worktree; the
// human's passes; reviewers and plain spawns are never counted.
func TestSpawnDeveloperCap(t *testing.T) {
	f, repo := worktreeFixture(t)
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"developerCap":1}`), 0o600))
	if rec := f.spawnIn(repo, `"name":"d1","type":"developer"`); rec.Code != 200 {
		t.Fatalf("the first developer: %d %s", rec.Code, rec.Body)
	}
	rec := f.spawnIn(repo, `"name":"d2","type":"developer"`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"queued":true,"name":"d2","place":1,"queue_length":1,"urgent":null,"reason":null,"holders":["d1"],"holder_info":[{"name":"d1","age_ms":`) {
		t.Errorf("at the cap: %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(filepath.Join(f.home, "worktrees", "repo-d2")); err == nil {
		t.Error("a queued developer made a worktree")
	}
	if n := f.count("SELECT count(*) FROM agents WHERE name = 'd2'"); n != 0 {
		t.Error("a queued developer made a row")
	}
	if rec := f.spawnIn(repo, `"name":"p1","harness":"claude"`); rec.Code != 200 {
		t.Errorf("a plain spawn at the cap: %d %s", rec.Code, rec.Body)
	}
	if rec := f.human("POST", "/api/agents", `{"cwd":"`+repo+`","name":"d3","type":"developer"}`); rec.Code != 200 {
		t.Errorf("the human's developer at the cap: %d %s", rec.Code, rec.Body)
	}
}

// TestSpawnDeveloperCapInterleaved: two developer spawns at the cap's last slot can't both pass. The first holds its slot
// from the count until its row exists; the second, which counts while the first is held there, is queued behind it.
func TestSpawnDeveloperCapInterleaved(t *testing.T) {
	f, repo := worktreeFixture(t)
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"developerCap":1}`), 0o600))
	held, release := make(chan struct{}), make(chan struct{})
	f.srv.devSlots.afterReserve = func(name string) {
		if name == "r1" {
			close(held)
			<-release
		}
	}
	first := make(chan *httptest.ResponseRecorder)
	go func() { first <- f.spawnIn(repo, `"name":"r1","type":"developer"`) }()
	<-held
	rec := f.spawnIn(repo, `"name":"r2","type":"developer"`)
	close(release)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"queued":true`) || !strings.Contains(rec.Body.String(), `"holders":["r1 (starting)"]`) {
		t.Errorf("the second spawn while the first holds the slot: %d %s", rec.Code, rec.Body)
	}
	if rec := <-first; rec.Code != 200 {
		t.Errorf("the first spawn: %d %s", rec.Code, rec.Body)
	}
	if n := f.count("SELECT count(*) FROM agents WHERE name = 'r2'"); n != 0 {
		t.Error("the refused spawn made a row")
	}
}

// TestSpawnDeveloperSameName: a second spawn of a name whose spawn holds a slot is refused, so when it fails it can't
// release the first one's slot, and the cap holds. Without the refusal the duplicate's failure (a base that doesn't
// resolve) dropped x's reservation, and both y and z passed beside x.
func TestSpawnDeveloperSameName(t *testing.T) {
	f, repo := worktreeFixture(t)
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"developerCap":2}`), 0o600))
	held, release := make(chan struct{}), make(chan struct{})
	f.srv.devSlots.afterReserve = func(name string) {
		if name == "x" {
			select {
			case <-held:
			default:
				close(held)
				<-release
			}
		}
	}
	first := make(chan *httptest.ResponseRecorder)
	go func() { first <- f.spawnIn(repo, `"name":"x","type":"developer"`) }()
	<-held
	if rec := f.spawnIn(repo, `"name":"x","type":"developer","base":"origin/nope"`); rec.Code != 409 || !strings.Contains(rec.Body.String(), "name x is taken") {
		t.Errorf("the duplicate x: %d %s", rec.Code, rec.Body)
	}
	if rec := f.spawnIn(repo, `"name":"y","type":"developer"`); rec.Code != 200 {
		t.Errorf("y beside the held x: %d %s", rec.Code, rec.Body)
	}
	if rec := f.spawnIn(repo, `"name":"z","type":"developer"`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"queued":true`) || !strings.Contains(rec.Body.String(), `"cap":2`) {
		t.Errorf("z at the cap: %d %s", rec.Code, rec.Body)
	}
	close(release)
	if rec := <-first; rec.Code != 200 {
		t.Errorf("x: %d %s", rec.Code, rec.Body)
	}
	if n := f.count("SELECT count(*) FROM agents WHERE name IN ('x', 'y', 'z')"); n != 2 {
		t.Errorf("%d developers for a cap of 2", n)
	}
}

// TestSpawnWorktreeCleanup: a spawn that fails after its worktree exists but before its row holds it removes the
// worktree and its branch, both after the row exists (beforeStore) and when making it the chief of staff fails.
func TestSpawnWorktreeCleanup(t *testing.T) {
	f, repo := worktreeFixture(t)
	gone := func(name string) {
		t.Helper()
		if _, err := os.Lstat(filepath.Join(f.home, "worktrees", "repo-"+name)); err == nil {
			t.Errorf("%s's worktree is still there", name)
		}
		if out := gitIn(t, repo, "branch", "--list", "stam/"+name); out != "" {
			t.Errorf("%s's branch is still there: %s", name, out)
		}
	}
	f.srv.devSlots.beforeStore = func(name string) error {
		if name == "s1" {
			return errors.New("injected")
		}
		return nil
	}
	if rec := f.spawnIn(repo, `"name":"s1","type":"developer"`); rec.Code == 200 || !strings.Contains(rec.Body.String(), "injected") {
		t.Errorf("the failing spawn: %d %s", rec.Code, rec.Body)
	}
	gone("s1")
	// settings.json as a folder fails the chief-of-staff write, after the row exists.
	must(t, os.RemoveAll(filepath.Join(f.home, "settings.json")))
	must(t, os.Mkdir(filepath.Join(f.home, "settings.json"), 0o700))
	if rec := f.human("POST", "/api/agents", `{"cwd":"`+repo+`","name":"c1","worktree":true,"chief_of_staff":true}`); rec.Code == 200 {
		t.Errorf("the chief of staff whose write failed: %d %s", rec.Code, rec.Body)
	}
	gone("c1")
}

// TestSpawnSameNameReviewer: a second spawn of a name whose spawn is in flight is a 409 before any git run, for every
// type (a reviewer takes no developer slot): the first one's worktree and branch, held at afterTree, survive it.
func TestSpawnSameNameReviewer(t *testing.T) {
	f, repo := worktreeFixture(t)
	held, release := make(chan struct{}), make(chan struct{})
	f.srv.devSlots.afterTree = func(name string) {
		if name == "rv" {
			select {
			case <-held:
			default:
				close(held)
				<-release
			}
		}
	}
	first := make(chan *httptest.ResponseRecorder)
	go func() { first <- f.spawnIn(repo, `"name":"rv","type":"reviewer","harness":"claude"`) }()
	<-held
	tree := filepath.Join(f.home, "worktrees", "repo-rv")
	if rec := f.spawnIn(repo, `"name":"rv","type":"reviewer","harness":"claude"`); rec.Code != 409 || !strings.Contains(rec.Body.String(), "name rv is taken") {
		t.Errorf("the second rv: %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(filepath.Join(tree, ".git")); err != nil {
		t.Errorf("the first rv's worktree: %v", err)
	}
	close(release)
	if rec := <-first; rec.Code != 200 {
		t.Errorf("the first rv: %d %s", rec.Code, rec.Body)
	}
	if out := gitIn(t, repo, "branch", "--list", "stam/rv"); out == "" {
		t.Error("the first rv's branch is gone")
	}
}

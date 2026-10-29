package lifecycle

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// spawnRepo is a checkout with an origin (a bare repo) holding main, and a home for the worktrees. Git looks no higher
// than the test's folder.
type spawnRepo struct {
	t                  *testing.T
	base, origin, repo string
	env                WorktreeEnv
}

func newSpawnRepo(t *testing.T) *spawnRepo {
	base := t.TempDir()
	t.Setenv("GIT_CEILING_DIRECTORIES", base)
	r := &spawnRepo{t: t, base: base, origin: filepath.Join(base, "origin.git"), repo: filepath.Join(base, "repo"),
		env: WorktreeEnv{Home: filepath.Join(base, "home")}}
	gitRun(t, base, "init", "-q", "--bare", "-b", "main", r.origin)
	gitRun(t, base, "init", "-q", "-b", "main", r.repo)
	gitRun(t, r.repo, "commit", "-q", "--allow-empty", "-m", "base")
	gitRun(t, r.repo, "remote", "add", "origin", r.origin)
	gitRun(t, r.repo, "push", "-q", "origin", "main")
	gitRun(t, r.repo, "fetch", "-q", "origin")
	return r
}

// pushFromElsewhere makes a commit on branch in another clone and pushes it to origin, so the checkout's tracking ref
// is behind; it returns the commit.
func (r *spawnRepo) pushFromElsewhere(branch, from string) string {
	other := filepath.Join(r.base, "other-"+strings.ReplaceAll(branch, "/", "-"))
	if _, err := os.Stat(other); err != nil {
		gitRun(r.t, r.base, "clone", "-q", r.origin, other)
	}
	gitRun(r.t, other, "fetch", "-q", "origin")
	gitRun(r.t, other, "checkout", "-q", "-B", branch, "origin/"+from)
	gitRun(r.t, other, "commit", "-q", "--allow-empty", "-m", "on "+branch)
	gitRun(r.t, other, "push", "-q", "origin", branch)
	return gitRun(r.t, other, "rev-parse", "HEAD")
}

func (r *spawnRepo) create(spec WorktreeSpec, name string) (*CreatedWorktree, error) {
	if spec.Repo == "" {
		spec.Repo = r.repo
	}
	return CreateWorktree(context.Background(), r.env, spec, name)
}

// TestCreateWorktreeDefault: a spawn with no branch and no base gets stam/NAME, cut from a freshly fetched origin/main,
// under STAM_HOME/worktrees; a second agent of a name whose branch exists here or on origin gets a free suffix.
func TestCreateWorktreeDefault(t *testing.T) {
	r := newSpawnRepo(t)
	fresh := r.pushFromElsewhere("main", "main")
	c, err := r.create(WorktreeSpec{}, "dev")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(r.env.Home, "worktrees", "repo-dev")
	if c.Cwd != path || c.Worktree.Path != path || c.Worktree.Branch != "stam/dev" || c.Worktree.Suffixed || c.Worktree.Repo != r.repo {
		t.Errorf("created %+v", c)
	}
	if b := c.BaseUsed; b == nil || b.Ref != "origin/main" || b.SHA != fresh || b.Fetch != "ok" || !b.Defaulted || b.Error != "" {
		t.Errorf("base used %+v, want origin/main at %s", c.BaseUsed, fresh)
	}
	if head := gitRun(t, path, "rev-parse", "HEAD"); head != fresh {
		t.Errorf("the worktree is at %s, not the fetched origin/main %s", head, fresh)
	}
	// stam/dev is taken here now; stam/dev-2 only on origin, which ls-remote sees though no tracking ref holds it.
	r.pushFromElsewhere("stam/dev-2", "main")
	gitRun(t, r.repo, "worktree", "remove", "--force", path)
	c, err = r.create(WorktreeSpec{Branch: "new"}, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if c.Worktree.Branch != "stam/dev-3" || !c.Worktree.Suffixed {
		t.Errorf("the suffixed branch: %+v", c.Worktree)
	}
	// An explicit branch is used as given, not suffixed.
	c, err = r.create(WorktreeSpec{Branch: "feature/x"}, "dev2")
	if err != nil || c.Worktree.Branch != "feature/x" || c.Worktree.Suffixed {
		t.Errorf("an explicit branch: %+v %v", c, err)
	}
}

// TestCreateWorktreeHostileNames: a branch or base that git would read as an option, or that isn't a ref name, is
// refused before git sees it, and nothing is made; names reach git as arguments, never through a shell.
func TestCreateWorktreeHostileNames(t *testing.T) {
	r := newSpawnRepo(t)
	marker := filepath.Join(r.base, "pwned")
	for _, spec := range []WorktreeSpec{
		{Branch: "-b"},
		{Branch: "--upload-pack=touch " + marker},
		{Branch: "x; touch " + marker},
		{Branch: "$(touch " + marker + ")"},
		{Branch: "`touch " + marker + "`"},
		{Branch: "a..b"},
		{Branch: "a b"},
		{Branch: "x.lock"},
		{Branch: "x\nb"},
		{Base: "-q"},
		{Base: "--output=" + marker},
		{Base: "origin/main;touch " + marker},
		{Base: "$(touch " + marker + ")"},
	} {
		c, err := r.create(spec, "evil")
		if err == nil || !(strings.Contains(err.Error(), "starts with -") || strings.Contains(err.Error(), "is not a valid ref name")) {
			t.Errorf("%q: %+v %v", spec, c, err)
		}
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("a hostile name ran a command")
	}
	if _, err := os.Stat(filepath.Join(r.env.Home, "worktrees", "repo-evil")); err == nil {
		t.Error("a refused spawn made a worktree")
	}
	if out := gitRun(t, r.repo, "branch", "--list"); strings.Contains(out, "evil") || strings.Contains(out, "touch") {
		t.Errorf("a refused spawn made a branch: %s", out)
	}
}

// TestCreateWorktreeFetchFails: when origin can't be fetched the worktree is cut from the local origin/main (stale), or
// from HEAD when there is none, and BaseUsed says the fetch failed and why; credentials in the URL never reach it.
func TestCreateWorktreeFetchFails(t *testing.T) {
	r := newSpawnRepo(t)
	local := gitRun(t, r.repo, "rev-parse", "origin/main")
	gitRun(t, r.repo, "remote", "set-url", "origin", "https://user:s3cr3t-t0ken@127.0.0.1:1/none.git")
	c, err := r.create(WorktreeSpec{}, "stale")
	if err != nil {
		t.Fatal(err)
	}
	b := c.BaseUsed
	if b == nil || b.Ref != "origin/main" || b.SHA != local || b.Fetch != "failed" || b.Error == "" || !b.Defaulted {
		t.Fatalf("base used %+v", b)
	}
	if strings.Contains(b.Error, "s3cr3t") {
		t.Errorf("the fetch error carries the token: %s", b.Error)
	}
	gitRun(t, r.repo, "update-ref", "-d", "refs/remotes/origin/main")
	gitRun(t, r.repo, "commit", "-q", "--allow-empty", "-m", "local only")
	head := gitRun(t, r.repo, "rev-parse", "HEAD")
	c, err = r.create(WorktreeSpec{}, "stale2")
	if err != nil {
		t.Fatal(err)
	}
	if b := c.BaseUsed; b == nil || b.Ref != "HEAD" || b.SHA != head || b.Fetch != "failed" || !b.Defaulted || strings.Contains(b.Error, "s3cr3t") {
		t.Errorf("the HEAD fallback: %+v", b)
	}
	if got := redactURLs("fatal: unable to access 'https://x-access-token:ghp_abc@github.com/o/r.git/'"); strings.Contains(got, "ghp_abc") || !strings.Contains(got, "https://***@github.com") {
		t.Errorf("redact: %s", got)
	}
}

// TestCreateWorktreeFetchTimeout: a fetch that hangs is killed, process group and all, at STAM_FETCH_TIMEOUT_MS, and
// the spawn goes on from the local ref.
func TestCreateWorktreeFetchTimeout(t *testing.T) {
	r := newSpawnRepo(t)
	t.Setenv("STAM_FETCH_TIMEOUT_MS", "300")
	// git appends the host and command to it; the `:` takes them.
	t.Setenv("GIT_SSH_COMMAND", "sleep 30; :")
	gitRun(t, r.repo, "remote", "set-url", "origin", "ssh://nowhere.invalid/x.git")
	began := time.Now()
	c, err := r.create(WorktreeSpec{}, "slow")
	if err != nil {
		t.Fatal(err)
	}
	if took := time.Since(began); took > 10*time.Second {
		t.Errorf("the spawn took %s", took)
	}
	if b := c.BaseUsed; b == nil || b.Fetch != "failed" || b.Error != "timed out after 0.3s" {
		t.Errorf("base used %+v", b)
	}
}

// TestCreateWorktreeSharedFetch: spawns at the same moment share one fetch per repo and ref.
func TestCreateWorktreeSharedFetch(t *testing.T) {
	r := newSpawnRepo(t)
	var wg sync.WaitGroup
	got := make([]*baseFetch, 3)
	for i := range got {
		wg.Add(1)
		go func() { defer wg.Done(); got[i] = prefetchBase(context.Background(), r.repo, "") }()
	}
	wg.Wait()
	for i, f := range got {
		if f == nil || !f.ok || f.ref != "origin/main" || !f.defaulted {
			t.Errorf("fetch %d: %+v", i, f)
		}
	}
}

// TestCreateWorktreeBase: a base is fetched and cut from, and one that doesn't resolve is refused with nothing made.
func TestCreateWorktreeBase(t *testing.T) {
	r := newSpawnRepo(t)
	tip := r.pushFromElsewhere("feature", "main")
	c, err := r.create(WorktreeSpec{Base: "origin/feature"}, "stack")
	if err != nil {
		t.Fatal(err)
	}
	if c.Worktree.Branch != "stam/stack" || c.Worktree.Base != "origin/feature" || c.Worktree.Continues || c.BaseUsed.SHA != tip || c.BaseUsed.Fetch != "ok" || c.BaseUsed.Defaulted {
		t.Errorf("created %+v %+v", c.Worktree, c.BaseUsed)
	}
	_, err = r.create(WorktreeSpec{Base: "origin/nope"}, "nope")
	if err == nil || err.Error() != "base origin/nope does not resolve to a commit in "+r.repo+" (after fetching origin)" {
		t.Errorf("an unknown base: %v", err)
	}
	if _, err := os.Stat(filepath.Join(r.env.Home, "worktrees", "repo-nope")); err == nil {
		t.Error("a refused base made a worktree")
	}
}

// TestCreateWorktreeContinues: a base of origin/stam/X puts the worktree on stam/X itself at the base's commit; it is
// refused while another worktree holds stam/X or a local stam/X has commits the base lacks; branch "new" stacks instead.
func TestCreateWorktreeContinues(t *testing.T) {
	r := newSpawnRepo(t)
	tip := r.pushFromElsewhere("stam/pr", "main")
	c, err := r.create(WorktreeSpec{Base: "origin/stam/pr"}, "fixer")
	if err != nil {
		t.Fatal(err)
	}
	if c.Worktree.Branch != "stam/pr" || !c.Worktree.Continues || c.BaseUsed.Continued != "stam/pr" || c.BaseUsed.SHA != tip {
		t.Errorf("continued %+v %+v", c.Worktree, c.BaseUsed)
	}
	if head := gitRun(t, c.Cwd, "rev-parse", "HEAD"); head != tip {
		t.Errorf("the worktree is at %s, not %s", head, tip)
	}
	_, err = r.create(WorktreeSpec{Base: "origin/stam/pr"}, "fixer2")
	if err == nil || !strings.HasPrefix(err.Error(), "stam/pr is checked out in "+c.Cwd+": archive its agent") {
		t.Errorf("a held branch: %v", err)
	}
	// Freed, but the local branch has a commit of its own: resetting it would lose it.
	gitRun(t, c.Cwd, "commit", "-q", "--allow-empty", "-m", "local only")
	gitRun(t, r.repo, "worktree", "remove", "--force", c.Cwd)
	_, err = r.create(WorktreeSpec{Base: "origin/stam/pr"}, "fixer3")
	if err == nil || !strings.HasPrefix(err.Error(), "local stam/pr (") || !strings.Contains(err.Error(), "has commits that are not in "+tip[:8]) {
		t.Errorf("local commits: %v", err)
	}
	// A local stam/pr behind the base fast-forwards to it.
	gitRun(t, r.repo, "branch", "-f", "stam/pr", "main")
	newer := r.pushFromElsewhere("stam/pr", "stam/pr")
	c, err = r.create(WorktreeSpec{Base: "origin/stam/pr"}, "fixer4")
	if err != nil || gitRun(t, c.Cwd, "rev-parse", "HEAD") != newer {
		t.Fatalf("the fast-forward: %+v %v", c, err)
	}
	gitRun(t, r.repo, "worktree", "remove", "--force", c.Cwd)
	c, err = r.create(WorktreeSpec{Base: "origin/stam/pr", Branch: "new"}, "stacker")
	if err != nil || c.Worktree.Branch != "stam/stacker" || c.Worktree.Continues {
		t.Errorf("branch new: %+v %v", c, err)
	}
}

// TestLiveCheckoutRefusal: a dir in the live deploy checkout is refused; a linked worktree of it isn't, unless
// STAM_DEPLOY_REPO names the checkout; a dir outside any repo isn't.
func TestLiveCheckoutRefusal(t *testing.T) {
	r := newSpawnRepo(t)
	ctx := context.Background()
	sub := filepath.Join(r.repo, "src")
	must(t, os.MkdirAll(sub, 0o755))
	if why := LiveCheckoutRefusal(ctx, sub, r.repo, false); !strings.HasPrefix(why, sub+" is in the live deploy checkout "+r.repo+",") {
		t.Errorf("in the checkout: %q", why)
	}
	linked := filepath.Join(r.base, "linked")
	gitRun(t, r.repo, "worktree", "add", "-q", "-b", "side", linked)
	if why := LiveCheckoutRefusal(ctx, linked, linked, false); why != "" {
		t.Errorf("a linked worktree: %q", why)
	}
	if why := LiveCheckoutRefusal(ctx, linked, linked, true); why == "" {
		t.Error("a linked worktree STAM_DEPLOY_REPO names wasn't refused")
	}
	if why := LiveCheckoutRefusal(ctx, linked, r.repo, false); why != "" {
		t.Errorf("a worktree of the checkout: %q", why)
	}
	if why := LiveCheckoutRefusal(ctx, r.base, r.repo, false); why != "" {
		t.Errorf("outside any repo: %q", why)
	}
}

// TestCreateWorktreeRollback: a spawn canceled once its worktree is added (a client that went away) removes that
// worktree on a context of its own, so the continued branch is free for the next spawn. A failed add removes nothing:
// not a competing add's worktree that took its path and branch in between, not a folder git left after a failing
// post-checkout hook (reported instead), and not a folder that was there before.
func TestCreateWorktreeRollback(t *testing.T) {
	r := newSpawnRepo(t)
	t.Cleanup(func() { addHook = nil })
	gitRun(t, r.repo, "branch", "stam/pr", "main")
	tip := r.pushFromElsewhere("stam/pr", "main")
	ctx, cancel := context.WithCancel(context.Background())
	addHook = func(stage, _ string) {
		if stage == "after" {
			cancel()
		}
	}
	path := filepath.Join(r.env.Home, "worktrees", "repo-fixer")
	if _, err := CreateWorktree(ctx, r.env, WorktreeSpec{Repo: r.repo, Base: "origin/stam/pr"}, "fixer"); err == nil || strings.Contains(err.Error(), "removing") {
		t.Fatalf("the canceled spawn: %v", err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("the canceled spawn's worktree is still there: %v", err)
	}
	if list := gitRun(t, r.repo, "worktree", "list", "--porcelain"); strings.Contains(list, "refs/heads/stam/pr") {
		t.Errorf("stam/pr is still checked out:\n%s", list)
	}
	if gitRun(t, r.repo, "branch", "--list", "stam/pr") == "" {
		t.Error("the rollback deleted stam/pr, which existed before the spawn")
	}
	addHook = nil
	if c, err := r.create(WorktreeSpec{Base: "origin/stam/pr"}, "fixer2"); err != nil || gitRun(t, c.Cwd, "rev-parse", "HEAD") != tip {
		t.Fatalf("the next continuation: %+v %v", c, err)
	}

	// A competing spawn of the same name adds its worktree between this one's checks and its add.
	var rival *CreatedWorktree
	addHook = func(stage, _ string) {
		if stage == "before" && rival == nil {
			addHook = nil
			var err error
			if rival, err = r.create(WorktreeSpec{}, "dup"); err != nil {
				t.Fatalf("the rival: %v", err)
			}
		}
	}
	if _, err := r.create(WorktreeSpec{}, "dup"); err == nil {
		t.Fatal("the second add over the rival's worktree passed")
	}
	if _, err := os.Stat(filepath.Join(rival.Cwd, ".git")); err != nil {
		t.Errorf("the failed add removed the rival's worktree: %v", err)
	}
	if b := gitRun(t, r.repo, "branch", "--list", rival.Worktree.Branch); b == "" {
		t.Errorf("the failed add deleted the rival's branch %s", rival.Worktree.Branch)
	}

	hooks := filepath.Join(r.base, "hooks")
	must(t, os.MkdirAll(hooks, 0o755))
	must(t, os.WriteFile(filepath.Join(hooks, "post-checkout"), []byte("#!/bin/sh\nexit 1\n"), 0o755))
	gitRun(t, r.repo, "config", "core.hooksPath", hooks)
	hooked := filepath.Join(r.env.Home, "worktrees", "repo-hooked")
	_, err := r.create(WorktreeSpec{}, "hooked")
	if err == nil || !strings.HasPrefix(err.Error(), "couldn't add the worktree") || !strings.Contains(err.Error(), hooked+" was left behind, not removed") {
		t.Fatalf("the failing add: %v", err)
	}
	if _, err := os.Lstat(hooked); err != nil {
		t.Errorf("the failed add removed the folder git left: %v", err)
	}
	gitRun(t, r.repo, "config", "--unset", "core.hooksPath")
	// A folder that was there before the add is not the add's to remove, nor reported as left by it.
	before := filepath.Join(r.env.Home, "worktrees", "repo-squatter")
	must(t, os.MkdirAll(before, 0o755))
	must(t, os.WriteFile(filepath.Join(before, "keep"), nil, 0o644))
	// The error names git's reason, not its "Preparing worktree" progress line.
	if _, err := r.create(WorktreeSpec{}, "squatter"); err == nil || strings.Contains(err.Error(), "left behind") || !strings.Contains(err.Error(), "fatal: ") {
		t.Fatalf("an add over an existing folder: %v", err)
	}
	if _, err := os.Stat(filepath.Join(before, "keep")); err != nil {
		t.Errorf("the failed add removed a folder it didn't make: %v", err)
	}
}

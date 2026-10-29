package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"stam/internal/db"
)

// The archive's worktree cleanup (src/workspace.ts S-2201, S-994, and src/lifecycle.ts worktreeUsers): the unpushed
// guard, the worktree's removal, and the drop of a branch that holds nothing of its own.

// workspace is the part of src/workspace.ts Workspace the archive reads.
type workspace struct {
	Cwd      string     `json:"cwd"`
	Worktree *ownedTree `json:"worktree"`
	BaseUsed *struct {
		SHA string `json:"sha"`
	} `json:"baseUsed"`
}

// ownedTree is src/workspace.ts Workspace.worktree.
type ownedTree struct {
	Repo      string `json:"repo"`
	Path      string `json:"path"`
	Branch    string `json:"branch"`
	Base      string `json:"base"`
	Continues bool   `json:"continues"`
}

// workspaceOf is the agent's workspace, nil for none or one that doesn't parse.
func workspaceOf(raw *string) *workspace {
	if raw == nil || *raw == "" {
		return nil
	}
	var w workspace
	if json.Unmarshal([]byte(*raw), &w) != nil {
		return nil
	}
	return &w
}

const gitTimeout = 15 * time.Second

// gitErr is a failed git run: its exit code (-1 when it didn't run to an exit) and stderr.
type gitErr struct {
	code   int
	stderr string
	err    error
}

func (e *gitErr) Error() string {
	if e.stderr != "" {
		return e.err.Error() + ": " + e.stderr
	}
	return e.err.Error()
}

// git runs git with args and returns its trimmed stdout.
func git(ctx context.Context, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		code := -1
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		}
		return "", &gitErr{code: code, stderr: strings.TrimSpace(stderr.String()), err: err}
	}
	return strings.TrimSpace(string(out)), nil
}

// unpushedRefusal is src/workspace.ts unpushedRefusal: why the branch can't be left behind (commits no remote-tracking
// ref reaches), or "" when it can. Any git failure is an error: a check that can't be made refuses, never passes.
func unpushedRefusal(ctx context.Context, gitArgs []string, branch string) (string, error) {
	run := func(args ...string) (string, error) {
		return git(ctx, append(append([]string{}, gitArgs...), args...)...)
	}
	couldnt := func(err error) error { return fmt.Errorf("couldn't check whether %s is pushed: %w", branch, err) }
	remotes, err := run("remote")
	if err != nil {
		return "", couldnt(err)
	}
	if remotes == "" {
		return "", nil
	}
	if _, err := run("rev-parse", "--verify", "--quiet", "refs/heads/"+branch); err != nil {
		var g *gitErr
		if errors.As(err, &g) && g.code == 1 {
			return "", nil
		}
		return "", couldnt(err)
	}
	out, err := run("rev-list", "refs/heads/"+branch, "--not", "--remotes")
	if err != nil {
		return "", couldnt(err)
	}
	if out == "" {
		return "", nil
	}
	commits := strings.Split(out, "\n")
	plural := "s"
	if len(commits) == 1 {
		plural = ""
	}
	return fmt.Sprintf("branch %s has %d commit%s not on any remote (head %s): push it or open its PR (pr_open) first, or archive with force_unpushed to leave it only local", branch, len(commits), plural, commits[0]), nil
}

// repoGitArgs is src/workspace.ts repoGitArgs: the git arguments that reach the repo the worktree was made from, or its
// shared git dir when that repo (another agent's worktree, archived since) is gone.
func repoGitArgs(ctx context.Context, w *workspace) ([]string, error) {
	if _, err := os.Stat(w.Worktree.Repo); err == nil {
		return []string{"-C", w.Worktree.Repo}, nil
	}
	dir, err := git(ctx, "-C", w.Worktree.Path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return nil, fmt.Errorf("couldn't find the git dir of %s (its repo %s is gone): %w", w.Worktree.Path, w.Worktree.Repo, err)
	}
	return []string{"--git-dir", dir}, nil
}

// workspaceUnpushedRefusal is src/workspace.ts workspaceUnpushedRefusal: "" when it has no worktree or its folder is
// gone.
func workspaceUnpushedRefusal(ctx context.Context, w *workspace) (string, error) {
	if w == nil || w.Worktree == nil {
		return "", nil
	}
	if gone, err := worktreeGone(w.Worktree.Path); err != nil || gone {
		return "", err
	}
	args, err := repoGitArgs(ctx, w)
	if err != nil {
		return "", err
	}
	return unpushedRefusal(ctx, args, w.Worktree.Branch)
}

// dropEmptyBranch is src/workspace.ts dropEmptyBranch: deletes the worktree's branch only when it holds nothing of its
// own; it returns why it was kept, or "" when it was deleted or is gone.
func dropEmptyBranch(ctx context.Context, gitArgs []string, branch, start string, baseInUse, continues bool) string {
	run := func(args ...string) (string, error) {
		return git(ctx, append(append([]string{}, gitArgs...), args...)...)
	}
	tip, err := run("rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	if err != nil {
		return ""
	}
	if continues {
		return "it is the branch of the PR this agent continued"
	}
	if baseInUse {
		return "another agent's worktree was cut from it"
	}
	if _, err := run("merge-base", "--is-ancestor", tip, "refs/remotes/origin/main"); tip != start && err != nil {
		return "it has commits of its own"
	}
	list, err := run("worktree", "list", "--porcelain")
	if err != nil {
		return "couldn't check: " + firstLine(err.Error())
	}
	for _, l := range strings.Split(list, "\n") {
		if l == "branch refs/heads/"+branch {
			return "it is checked out in another worktree"
		}
	}
	if _, err := run("branch", "-d", branch); err != nil {
		why := err.Error()
		var g *gitErr
		if errors.As(err, &g) && g.stderr != "" {
			why = g.stderr
		}
		return "git branch -d refused: " + firstLine(why)
	}
	return ""
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// branchIsBase is src/workspace.ts branchIsBase: another live agent's worktree was cut from this one or its branch.
func branchIsBase(w *workspace, others []db.Agent) bool {
	if w == nil || w.Worktree == nil {
		return false
	}
	for _, b := range others {
		o := workspaceOf(b.Workspace)
		if o == nil || o.Worktree == nil {
			continue
		}
		if o.Worktree.Repo == w.Worktree.Path || o.Worktree.Base == w.Worktree.Branch || o.Worktree.Base == "refs/heads/"+w.Worktree.Branch {
			return true
		}
	}
	return false
}

// worktreeGone is whether the worktree's folder no longer exists. Only "not found" is gone: any other error inspecting
// it (a permission, an I/O error) is returned, so the archive keeps the worktree and refuses rather than skip its checks.
func worktreeGone(path string) (bool, error) {
	_, err := os.Lstat(path)
	if err == nil {
		return false, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return true, nil
	}
	return false, fmt.Errorf("couldn't inspect the worktree %s: %w", path, err)
}

// RemoveCreated removes a worktree a spawn just made, before its agent's row held it: forced, and its branch dropped
// when it holds nothing of its own.
func RemoveCreated(ctx context.Context, c *CreatedWorktree) error {
	start := ""
	if c.BaseUsed != nil {
		start = c.BaseUsed.SHA
	}
	t := c.Worktree
	w := &workspace{Cwd: c.Cwd, Worktree: &ownedTree{Repo: t.Repo, Path: t.Path, Branch: t.Branch, Base: t.Base, Continues: t.Continues}}
	w.BaseUsed = &struct {
		SHA string `json:"sha"`
	}{start}
	_, err := cleanupWorkspace(ctx, w, true, true, false)
	return err
}

// cleanupWorkspace is src/workspace.ts cleanupWorkspace: the worktree is removed (refused with uncommitted changes
// unless force, or unpushed commits unless allowUnpushed) and its branch deleted when empty.
func cleanupWorkspace(ctx context.Context, w *workspace, force, allowUnpushed, baseInUse bool) (string, error) {
	if w == nil || w.Worktree == nil {
		return "nothing to clean up", nil
	}
	path := w.Worktree.Path
	if gone, err := worktreeGone(path); err != nil {
		return "", err
	} else if gone {
		return "worktree already gone", nil
	}
	args, err := repoGitArgs(ctx, w)
	if err != nil {
		return "", err
	}
	if !allowUnpushed {
		why, err := unpushedRefusal(ctx, args, w.Worktree.Branch)
		if err != nil {
			return "", err
		}
		if why != "" {
			return "", errors.New(why)
		}
	}
	remove := append(append([]string{}, args...), "worktree", "remove")
	if force {
		remove = append(remove, "--force")
	}
	// No timeout of its own in TS: a large worktree may take a while to delete.
	cmd := exec.CommandContext(ctx, "git", append(remove, path)...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return "", fmt.Errorf("Command failed: git %s\n%s", strings.Join(append(remove, path), " "), msg)
		}
		return "", err
	}
	start := ""
	if w.BaseUsed != nil {
		start = w.BaseUsed.SHA
	}
	if kept := dropEmptyBranch(ctx, args, w.Worktree.Branch, start, baseInUse, w.Worktree.Continues); kept != "" {
		return fmt.Sprintf("removed worktree %s; branch %s kept: %s", path, w.Worktree.Branch, kept), nil
	}
	return fmt.Sprintf("removed worktree %s; branch %s deleted (empty)", path, w.Worktree.Branch), nil
}

// worktreeUsers is src/lifecycle.ts worktreeUsers: the live agents other than except whose cwd, workspace cwd or
// worktree is the worktree at path or inside it, compared as canonical paths.
func worktreeUsers(path, except string, agents []db.Agent) []db.Agent {
	real := func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return r
		}
		if abs, err := filepath.Abs(p); err == nil {
			return abs
		}
		return p
	}
	root := real(path)
	inside := func(p string) bool {
		if p == "" {
			return false
		}
		r := real(p)
		return r == root || strings.HasPrefix(r, root+string(filepath.Separator))
	}
	var out []db.Agent
	for _, b := range agents {
		if b.ID == except || b.Lifecycle == "archived" {
			continue
		}
		w := workspaceOf(b.Workspace)
		in := inside(b.Cwd)
		if w != nil {
			in = in || inside(w.Cwd) || (w.Worktree != nil && inside(w.Worktree.Path))
		}
		if in {
			out = append(out, b)
		}
	}
	return out
}

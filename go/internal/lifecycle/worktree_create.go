package lifecycle

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

// The spawn's worktree (src/workspace.ts createWorkspaceFetched, createWorkspace, S-627, S-964, S-1666, S-3113, S-3486): a
// branch of its own, cut from a freshly fetched origin/main or a given base, or the PR branch a base of origin/stam/X
// continues. TS checks no ref names; here a branch or base is refused when it starts with "-" or isn't a valid ref name,
// and every name reaches git as an argument after its options, never through a shell.

// WorktreeSpec is src/workspace.ts WorkspaceSpec of kind worktree: the repo (any dir inside it), the branch ("" for the
// default stam/NAME, "new" for it too even on a PR branch's base), and the base ("" for origin's default branch).
type WorktreeSpec struct {
	Repo, Branch, Base string
}

// Worktree is src/workspace.ts Workspace.worktree.
type Worktree struct {
	Repo, Path, Branch, Base string
	Continues, Suffixed      bool
}

// BaseUsed is src/workspace.ts BaseUsed: where the branch was cut from and how the fetch went. Fetch is ok, failed or
// none.
type BaseUsed struct {
	Ref, SHA, Fetch, Error string
	Defaulted              bool
	Continued              string
}

// CreatedWorktree is what CreateWorktree made: the agent's cwd, its worktree, and its base (nil when there was no fetch
// and no base, as for a repo with no origin).
type CreatedWorktree struct {
	Cwd      string
	Worktree Worktree
	BaseUsed *BaseUsed
}

// WorktreeEnv is what CreateWorktree reads of the daemon: STAM_HOME, and the storage remote among a checkout's remotes
// (src/settings.ts storageRemoteFallback).
type WorktreeEnv struct {
	Home    string
	Storage func(remotes []string) string
}

// StorageRemote is src/settings.ts storageRemoteFallback: the named remote when set, else the first remote (sorted, not
// origin) named like a peer, else "".
func StorageRemote(named string, peers []string, remotes []string) string {
	if named != "" {
		return named
	}
	var out []string
	for _, r := range remotes {
		if r != "" && r != "origin" && slices.Contains(peers, r) {
			out = append(out, r)
		}
	}
	slices.Sort(out)
	if len(out) == 0 {
		return ""
	}
	return out[0]
}

// fetchTimeout is src/workspace.ts fetchTimeoutMs: a fetch that hangs (a stopped storage remote) must not hold a spawn.
func fetchTimeout() time.Duration { return envMs("FETCH_TIMEOUT_MS", 15*time.Second) }

// addTimeout bounds a `git worktree add`, which checks out the whole tree; TS gives it none.
const addTimeout = 5 * time.Minute

// gitWithin is git with its own timeout.
func gitWithin(ctx context.Context, d time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, d)
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

// gitBounded runs a network git command (fetch, ls-remote) in its own process group, killed whole at the deadline, so a
// hung ssh child that holds the pipes open can't outlive it. No prompt for credentials. Its stdout, or an error text.
func gitBounded(ctx context.Context, args ...string) (string, string) {
	d := fetchTimeout()
	ctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return "", fmt.Sprintf("timed out after %gs", d.Seconds())
	}
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				msg = fmt.Sprintf("git %s exited %d", args[2], exit.ExitCode())
			} else {
				msg = err.Error()
			}
		}
		return "", truncate(redactURLs(msg), 300)
	}
	return stdout.String(), ""
}

// urlCreds is the user and password of a URL, which a git error can echo when a remote's URL carries a token.
var urlCreds = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@`)

// redactURLs takes the credentials out of any URL in s, so no token reaches an event, a prompt or a log.
func redactURLs(s string) string { return urlCreds.ReplaceAllString(s, "${1}***@") }

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// hexOID is an object name, whole or abbreviated, which check-ref-format can't judge.
var hexOID = regexp.MustCompile(`^[0-9a-f]{4,64}$`)

// RefRefusal is why name can't be a branch or base, or "": a leading "-" (git would read an option) or a name git's
// check-ref-format refuses. base allows what a revision allows on top (a sha, HEAD).
func RefRefusal(ctx context.Context, what, name string) string {
	if name == "" {
		return what + " is empty"
	}
	if strings.HasPrefix(name, "-") {
		return fmt.Sprintf("%s %q starts with -", what, name)
	}
	if what == "base" && (name == "HEAD" || hexOID.MatchString(name)) {
		return ""
	}
	full := "refs/heads/" + name
	if strings.HasPrefix(name, "refs/") {
		full = name
	}
	if _, err := gitWithin(ctx, gitTimeout, "check-ref-format", full); err != nil {
		return fmt.Sprintf("%s %q is not a valid ref name", what, name)
	}
	return ""
}

// baseFetch is src/workspace.ts BaseFetch: the ref a spawn's base fetched, and how.
type baseFetch struct {
	ref       string
	defaulted bool
	ok        bool
	error     string
}

// fetches are the fetches in flight, so spawns at the same moment share one fetch per repo and ref (S-1351, S-1424).
var fetches = struct {
	sync.Mutex
	m map[string]*fetchCall
}{m: map[string]*fetchCall{}}

type fetchCall struct {
	done chan struct{}
	res  *baseFetch
}

// remotesOf is the remote names of repo, from its config alone; nil when git can't tell.
func remotesOf(ctx context.Context, repo string) []string {
	out, err := git(ctx, "-C", repo, "remote")
	if err != nil {
		return nil
	}
	var rs []string
	for _, r := range strings.Split(out, "\n") {
		if r != "" {
			rs = append(rs, r)
		}
	}
	return rs
}

// remoteOf is the remote of repo that ref is under (origin/stam/x: origin), or "".
func remoteOf(remotes []string, ref string) string {
	for _, r := range remotes {
		if strings.HasPrefix(ref, r+"/") {
			return r
		}
	}
	return ""
}

// defaultRef is src/workspace.ts defaultRef: origin's HEAD when the checkout knows it, else origin/main.
func defaultRef(ctx context.Context, repo string) string {
	if ref, err := git(ctx, "-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); err == nil && ref != "" {
		return ref
	}
	return "origin/main"
}

// prefetchBase is src/workspace.ts prefetchBase: fetches the remote ref a spawn cuts from, bounded by the fetch timeout. A
// base under a remote is fetched; with none, origin's default branch is, when the repo has an origin. nil when there is
// nothing to fetch. A failure is in the result, never an error.
func prefetchBase(ctx context.Context, repo, base string) *baseFetch {
	remotes := remotesOf(ctx, repo)
	ref := base
	if ref == "" {
		if !slices.Contains(remotes, "origin") {
			return nil
		}
		ref = defaultRef(ctx, repo)
	}
	remote := remoteOf(remotes, ref)
	if remote == "" {
		return nil
	}
	key := repo + "\x00" + ref
	fetches.Lock()
	if c, ok := fetches.m[key]; ok {
		fetches.Unlock()
		<-c.done
		r := *c.res
		r.defaulted = base == ""
		return &r
	}
	c := &fetchCall{done: make(chan struct{})}
	fetches.m[key] = c
	fetches.Unlock()
	_, msg := gitBounded(ctx, "-C", repo, "fetch", "-q", "--", remote, "+refs/heads/"+ref[len(remote)+1:]+":refs/remotes/"+ref)
	c.res = &baseFetch{ref: ref, defaulted: base == "", ok: msg == "", error: msg}
	fetches.Lock()
	delete(fetches.m, key)
	fetches.Unlock()
	close(c.done)
	r := *c.res
	return &r
}

// resolveBase is src/workspace.ts resolveBase: ref as a commit of repo, fetched first when it is under a remote and
// prefetchBase didn't run.
func resolveBase(ctx context.Context, repo string, remotes []string, ref string, fetched *baseFetch) (string, error) {
	remote := remoteOf(remotes, ref)
	if remote != "" && fetched == nil {
		gitBounded(ctx, "-C", repo, "fetch", "-q", "--", remote, "+refs/heads/"+ref[len(remote)+1:]+":refs/remotes/"+ref)
	}
	sha, err := git(ctx, "-C", repo, "rev-parse", "--verify", "-q", "--end-of-options", ref+"^{commit}")
	if err != nil || sha == "" {
		after := ""
		if remote != "" {
			after = " (after fetching " + remote + ")"
		}
		return "", fmt.Errorf("base %s does not resolve to a commit in %s%s", ref, repo, after)
	}
	return sha, nil
}

// remoteBranchNames is src/workspace.ts remoteBranchNames: the branches branch and branch-* on origin, by a bounded
// ls-remote. Best effort: a failure gives none. Only branch names are read, never the URL.
func remoteBranchNames(ctx context.Context, repo, branch string) []string {
	out, msg := gitBounded(ctx, "-C", repo, "ls-remote", "--heads", "--", "origin", "refs/heads/"+branch, "refs/heads/"+branch+"-*")
	if msg != "" {
		return nil
	}
	var names []string
	for _, l := range strings.Split(out, "\n") {
		if _, ref, ok := strings.Cut(l, "\t"); ok && ref != "" {
			names = append(names, strings.TrimPrefix(ref, "refs/heads/"))
		}
	}
	return names
}

// branchTaken is src/workspace.ts reusedBranchRefusal != null: the checkout has branch as a local branch or a
// remote-tracking ref of one of remotes. Local refs only, no network.
func branchTaken(ctx context.Context, repo, branch string, remotes []string) (bool, error) {
	args := []string{"-C", repo, "for-each-ref", "--format=%(refname)", "--", "refs/heads/" + branch}
	for _, r := range remotes {
		args = append(args, "refs/remotes/"+r+"/"+branch)
	}
	out, err := git(ctx, args...)
	if err != nil {
		return false, err
	}
	return out != "", nil
}

// freeBranch is src/workspace.ts freeBranch: branch, else branch-2 ... branch-50, the first one taken neither here nor in
// onRemote.
func freeBranch(ctx context.Context, repo, branch string, remotes, onRemote []string) (string, error) {
	for n := 1; n <= 50; n++ {
		candidate := branch
		if n > 1 {
			candidate = fmt.Sprintf("%s-%d", branch, n)
		}
		if slices.Contains(onRemote, candidate) {
			continue
		}
		taken, err := branchTaken(ctx, repo, candidate, remotes)
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%s and its -2 to -50 suffixes are all taken: pass an explicit branch", branch)
}

// continuedBranch is src/workspace.ts continuedBranch: the PR branch a base of REMOTE/stam/X continues, or "".
func continuedBranch(base string, remotes []string) string {
	for _, r := range remotes {
		if r != "" && strings.HasPrefix(base, r+"/stam/") && len(base) > len(r)+6 {
			return base[len(r)+1:]
		}
	}
	return ""
}

const zeroOID = "0000000000000000000000000000000000000000"

// continuedBranchRefusal is src/workspace.ts continuedBranchRefusal: why branch can't be reset to start, or the tip it
// inspected (zeroOID when there is no local branch). Fails closed: a holder, a tip that isn't an ancestor of start, and
// any git error other than "no such branch" refuse.
func continuedBranchRefusal(ctx context.Context, repo, branch, start string) (tip, why string) {
	fix := fmt.Sprintf(`pass branch (a new name, or "new" for stam/AGENT) to stack a new branch on %s`, branch)
	list, err := git(ctx, "-C", repo, "worktree", "list", "--porcelain")
	if err != nil {
		return "", fmt.Sprintf("couldn't list worktrees to check whether %s is free: %s; %s", branch, firstLine(err.Error()), fix)
	}
	lines := strings.Split(list, "\n")
	if at := slices.Index(lines, "branch refs/heads/"+branch); at >= 0 {
		where := "another worktree"
		for i := at - 1; i >= 0; i-- {
			if p, ok := strings.CutPrefix(lines[i], "worktree "); ok {
				where = p
				break
			}
		}
		return "", fmt.Sprintf("%s is checked out in %s: archive its agent (or free that worktree), or %s", branch, where, fix)
	}
	tip, err = git(ctx, "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	if err != nil {
		var g *gitErr
		if errors.As(err, &g) && g.code == 1 {
			return zeroOID, ""
		}
		return "", fmt.Sprintf("couldn't check local %s: %s; %s", branch, firstLine(err.Error()), fix)
	}
	if _, err := git(ctx, "-C", repo, "merge-base", "--is-ancestor", tip, start); err != nil {
		var g *gitErr
		if errors.As(err, &g) && g.code == 1 {
			return "", fmt.Sprintf("local %s (%s) has commits that are not in %s, so resetting it would lose them: push or merge them first, or %s", branch, tip[:8], start[:8], fix)
		}
		return "", fmt.Sprintf("couldn't check local %s: %s; %s", branch, firstLine(err.Error()), fix)
	}
	return tip, ""
}

// gitFail is the first fatal: or error: line of a failed git run's stderr (git prints progress such as "Preparing
// worktree" before it), else its first line, else the error's.
func gitFail(err error) string {
	var g *gitErr
	if errors.As(err, &g) && g.stderr != "" {
		for _, l := range strings.Split(g.stderr, "\n") {
			if strings.HasPrefix(l, "fatal: ") || strings.HasPrefix(l, "error: ") {
				return l
			}
		}
		return firstLine(g.stderr)
	}
	return firstLine(err.Error())
}

// addHook, when set, runs just before ("before") and just after ("after") a spawn's successful worktree add: a test
// races a competing add in before, or cancels the spawn after.
var addHook func(stage, path string)

func hook(stage, path string) {
	if addHook != nil {
		addHook(stage, path)
	}
}

// removeAdded removes the worktree this spawn's add made, after a later step failed: forced, since nothing else can hold
// a worktree that was just added at this spawn's own path. It runs on its own bounded context, as a canceled spawn's
// context may be why that step failed. It returns what it couldn't undo, as a note for the error, or "".
func removeAdded(ctx context.Context, repo, path string) string {
	ctx = context.WithoutCancel(ctx)
	if _, err := gitWithin(ctx, gitTimeout, "-C", repo, "worktree", "remove", "--force", "--", path); err != nil {
		return fmt.Sprintf(" (and removing %s failed: %s)", path, gitFail(err))
	}
	return ""
}

// afterFailedAdd is what a failed or timed-out add may do: prune git's entries of folders that are gone, which is safe.
// It removes nothing, as a competing add may own what is there: a folder git left at path is reported instead.
func afterFailedAdd(ctx context.Context, repo, path string, existed bool) string {
	ctx = context.WithoutCancel(ctx)
	gitWithin(ctx, gitTimeout, "-C", repo, "worktree", "prune")
	if existed {
		return ""
	}
	if _, err := os.Lstat(path); err == nil {
		return fmt.Sprintf(" (%s was left behind, not removed: check it and remove it with git worktree remove)", path)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Sprintf(" (couldn't inspect %s: %v)", path, err)
	}
	return ""
}

// CreateWorktree is src/workspace.ts createWorkspaceFetched for a worktree spec: the agent name's worktree under
// STAM_HOME/worktrees, on its own branch. Any error is the spawn's 400 (`workspace: …`), and leaves no worktree behind.
func CreateWorktree(ctx context.Context, env WorktreeEnv, spec WorktreeSpec, name string) (*CreatedWorktree, error) {
	if spec.Branch != "" && spec.Branch != "new" {
		if why := RefRefusal(ctx, "branch", spec.Branch); why != "" {
			return nil, errors.New(why)
		}
	}
	if spec.Base != "" {
		if why := RefRefusal(ctx, "base", spec.Base); why != "" {
			return nil, errors.New(why)
		}
	}
	repo, err := git(ctx, "-C", spec.Repo, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, fmt.Errorf("%s is not in a git repo: %s", spec.Repo, gitFail(err))
	}
	// "new" asks for the default stam/NAME too (S-964), so its name is checked on origin like an unset branch, beside the
	// base fetch.
	wanted := "stam/" + name
	var fetched *baseFetch
	var onRemote []string
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); fetched = prefetchBase(ctx, repo, spec.Base) }()
	if spec.Branch == "" || spec.Branch == "new" {
		wg.Add(1)
		go func() { defer wg.Done(); onRemote = remoteBranchNames(ctx, repo, wanted) }()
	}
	wg.Wait()
	path := filepath.Join(env.Home, "worktrees", filepath.Base(repo)+"-"+name)
	local := remotesOf(ctx, repo)
	remotes := []string{"origin"}
	if env.Storage != nil {
		if r := env.Storage(local); r != "" {
			remotes = append(remotes, r)
		}
	}
	asked := spec.Branch
	if asked == "new" {
		asked = ""
	}
	continues := ""
	if spec.Branch == "" {
		continues = continuedBranch(spec.Base, remotes)
	}
	branch := continues
	if branch == "" {
		branch = asked
	}
	if branch == "" {
		if branch, err = freeBranch(ctx, repo, wanted, remotes, onRemote); err != nil {
			return nil, err
		}
	}
	suffixed := asked == "" && continues == "" && branch != wanted
	// A base that doesn't resolve fails here, before any worktree exists.
	start := ""
	var used *BaseUsed
	switch {
	case spec.Base != "":
		if start, err = resolveBase(ctx, repo, local, spec.Base, fetched); err != nil {
			return nil, err
		}
		used = &BaseUsed{Ref: spec.Base, SHA: start, Fetch: "none"}
		if fetched != nil {
			used.Fetch, used.Error = "ok", fetched.error
			if !fetched.ok {
				used.Fetch = "failed"
			}
		}
	case fetched != nil:
		// The freshly fetched origin/main; when the fetch failed, the local tracking ref (possibly stale), else the
		// checkout's HEAD.
		if start, err = resolveBase(ctx, repo, local, fetched.ref, fetched); err == nil {
			used = &BaseUsed{Ref: fetched.ref, SHA: start, Fetch: "ok", Error: fetched.error, Defaulted: true}
			if !fetched.ok {
				used.Fetch = "failed"
			}
		} else {
			start = ""
			head, herr := git(ctx, "-C", repo, "rev-parse", "HEAD")
			if herr != nil {
				return nil, fmt.Errorf("couldn't read HEAD of %s: %s", repo, gitFail(herr))
			}
			why := fetched.error
			if why == "" {
				why = err.Error()
			}
			used = &BaseUsed{Ref: "HEAD", SHA: head, Fetch: "failed", Error: why, Defaulted: true}
		}
	}
	if err := os.MkdirAll(filepath.Join(env.Home, "worktrees"), 0o755); err != nil {
		return nil, err
	}
	// Whether a folder was at path before the add, for the report of a failed one.
	_, statErr := os.Lstat(path)
	existed := !errors.Is(statErr, fs.ErrNotExist)
	if continues != "" {
		tip, why := continuedBranchRefusal(ctx, repo, continues, start)
		if why != "" {
			return nil, errors.New(why)
		}
		// Take the branch first, then move it: git refuses a branch another worktree holds at the moment of taking it. An
		// absent branch is made at start; an existing one (an ancestor of start, checked above) is checked out and
		// fast-forwarded to start, which refuses if it moved somewhere start doesn't descend from.
		fix := `pass branch (a new name, or "new") to stack a new branch on it`
		add := []string{"-C", repo, "worktree", "add", "-b", continues, "--", path, start}
		if tip != zeroOID {
			add = []string{"-C", repo, "worktree", "add", "--", path, continues}
		}
		hook("before", path)
		if _, err := gitWithin(ctx, addTimeout, add...); err != nil {
			return nil, fmt.Errorf("couldn't put the worktree on %s: %s%s; %s", continues, gitFail(err), afterFailedAdd(ctx, repo, path, existed), fix)
		}
		hook("after", path)
		if tip != zeroOID {
			moved := func() error {
				if _, err := git(ctx, "-C", path, "merge", "--ff-only", "-q", start); err != nil {
					return err
				}
				// "Already up to date" when the branch moved ahead of start: the worktree must be exactly at start.
				head, err := git(ctx, "-C", path, "rev-parse", "HEAD")
				if err != nil {
					return err
				}
				if head != start {
					return fmt.Errorf("it is at %s, not %s", head[:8], start[:8])
				}
				return nil
			}()
			if moved != nil {
				// Only our own, just-made worktree is removed; the branch existed, and stays where it moved.
				return nil, fmt.Errorf("%s moved while the spawn was starting and is not at %s, so it was not reset: %s%s; retry, or %s", continues, start[:8], gitFail(moved), removeAdded(ctx, repo, path), fix)
			}
		}
		used.Continued = continues
	} else {
		add := []string{"-C", repo, "worktree", "add", "-b", branch, "--", path}
		if start != "" {
			add = append(add, start)
		}
		hook("before", path)
		if _, err := gitWithin(ctx, addTimeout, add...); err != nil {
			return nil, fmt.Errorf("couldn't add the worktree %s on %s: %s%s", path, branch, gitFail(err), afterFailedAdd(ctx, repo, path, existed))
		}
		hook("after", path)
	}
	return &CreatedWorktree{Cwd: path, BaseUsed: used,
		Worktree: Worktree{Repo: repo, Path: path, Branch: branch, Base: spec.Base, Continues: continues != "", Suffixed: suffixed}}, nil
}

// LiveCheckoutRefusal is src/workspace.ts liveCheckoutRefusal: why an agent without a worktree can't work in dir, or ""
// when it can. Refused when dir's working tree is the live deploy checkout; a linked worktree inside it is its own tree,
// unless deployRepoSet (STAM_DEPLOY_REPO names the checkout).
func LiveCheckoutRefusal(ctx context.Context, dir, checkout string, deployRepoSet bool) string {
	real, err := filepath.EvalSymlinks(checkout)
	if err != nil {
		return ""
	}
	top, err := git(ctx, "-C", dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return ""
	}
	if top, err = filepath.EvalSymlinks(top); err != nil || top != real {
		return ""
	}
	if !deployRepoSet {
		if st, err := os.Stat(filepath.Join(top, ".git")); err == nil && st.Mode().IsRegular() {
			return ""
		}
	}
	return fmt.Sprintf("%s is in the live deploy checkout %s, the repo the deploy watcher deploys from, so an agent that works there without its own worktree would block every deploy. Pass worktree: true, or a cwd outside it.", dir, top)
}

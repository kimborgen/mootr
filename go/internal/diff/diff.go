package diff

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"net/http"
	neturl "net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"

	"stam/internal/config"
	"stam/internal/files"
)

// BinaryCap is the largest file served; text over files.TextCap is cut unless `all` is asked for.
const BinaryCap = 50 * 1024 * 1024

const maxLists = 100

// Service is the diff cache of one daemon: the bare cache repos under STAM_HOME and what is kept in memory of them.
type Service struct {
	// Home is STAM_HOME, which holds the cache repos.
	Home     string
	Settings func() config.Settings
	// Repos are settings.itsa.repos: a repo's name to its checkout.
	Repos func() map[string]string
	Paths files.Paths

	// Each map is keyed by the repo's identity (cacheKey), so two repos never share an entry.
	mu      sync.Mutex
	locks   map[string]*sync.Mutex
	fetched map[string]time.Time // `key#pr` -> when it was last fetched
	used    map[string]int       // `key#pr` -> a counter of its last use, to drop the longest unused ref first
	tick    int
	pins    map[string]*pinSet // `key#pr` -> the ranges this daemon listed for the PR, for a viewer pinned to one
	lists   map[string][]RawFile       // `key:head:mergeBase` -> the file list
	order   []string             // the lists' keys, oldest first
}

// cacheKey is a repo's identity: its name and its checkout. The cache folder, the lock and the fetch times all key by
// it, so two names that read alike on disk (team/app and team_app) never share a cache.
func cacheKey(repo, checkout string) string { return repo + "\x00" + checkout }

// lock holds one fetch or diff at a time per repo (its cacheKey), so two requests don't write the same refs.
func (s *Service) lock(key string) func() {
	s.mu.Lock()
	if s.locks == nil {
		s.locks = map[string]*sync.Mutex{}
	}
	l := s.locks[key]
	if l == nil {
		l = &sync.Mutex{}
		s.locks[key] = l
	}
	s.mu.Unlock()
	l.Lock()
	return l.Unlock
}

// gitError is a failed git run, with its stderr.
type gitError struct {
	err    error
	stderr string
	killed bool
}

func (e *gitError) Error() string { return e.err.Error() }

// firstLine is src/diff.ts `String(e.stderr ?? e.message).split('\n')[0]`, with any credentials in a URL taken out.
func firstLine(err error) string {
	var g *gitError
	if errors.As(err, &g) {
		return redact(strings.SplitN(g.stderr, "\n", 2)[0])
	}
	return redact(strings.SplitN(err.Error(), "\n", 2)[0])
}

var userinfoRe = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://)[^/?#\s@]*@`)

// redact takes the userinfo (`user:token@`) out of every URL in s, so an error never carries a credential.
func redact(s string) string { return userinfoRe.ReplaceAllString(s, "$1") }

var schemeRe = regexp.MustCompile(`(?i)^([a-z][a-z0-9+.-]*)://([^/?#]*)`)

// credentialed is whether an origin URL carries a secret: a password in its userinfo, or any userinfo on http(s), where
// a token goes as the user name. ssh's `git@host` names a user, not a secret.
func credentialed(url string) bool {
	// git's `<transport>::<address>` runs a remote helper on the address, which is judged on its own.
	if m := helperRe.FindStringSubmatch(url); m != nil {
		return credentialed(m[1])
	}
	m := schemeRe.FindStringSubmatch(url)
	if m == nil {
		// scp-like `user@host:path`: a colon before the @ is a password.
		at := strings.IndexByte(url, '@')
		return at >= 0 && strings.IndexByte(url[:at], '/') < 0 && hasPassword(url[:at])
	}
	at := strings.LastIndexByte(m[2], '@')
	if at < 0 {
		return false
	}
	scheme := strings.ToLower(m[1])
	return hasPassword(m[2][:at]) || scheme == "http" || scheme == "https" || scheme == "ftp" || scheme == "ftps"
}

var helperRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9+.-]*::(.*)$`)

// hasPassword is whether a userinfo holds a colon, percent-encoded or not; one that can't be decoded counts as holding
// one.
func hasPassword(userinfo string) bool {
	plain, err := neturl.PathUnescape(userinfo)
	return err != nil || strings.IndexByte(plain, ':') >= 0
}

// seconds is a settings time in seconds as a Duration: 0 unless above 0, and a huge one clamped to the longest, so it
// can't overflow into a negative.
func seconds(f float64) time.Duration {
	if !(f > 0) {
		return 0
	}
	if f >= float64(math.MaxInt64/int64(time.Second)) {
		return math.MaxInt64
	}
	return time.Duration(f * float64(time.Second))
}

// bound puts cmd in its own process group, killed whole when ctx ends, and stops waiting for its pipes a second after:
// a hung remote helper or ssh child that holds them open can't outlive the run or hold the repo's lock.
func bound(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
}

// ceiling stops git's search for a repo at a cache folder (a dir ending in .git): a broken cache is then no repo, rather
// than git finding one in a folder above STAM_HOME's cache and reading or fetching there. A checkout at a .git path is
// still found, at dir itself.
func ceiling(dir string) []string {
	if !strings.HasSuffix(dir, ".git") {
		return nil
	}
	return []string{"GIT_CEILING_DIRECTORIES=" + filepath.Dir(dir)}
}

// git runs git in dir, as src/diff.ts run: no prompt for a password, ssh in batch mode, the C locale; a timeout kills it
// and every process it started.
func git(ctx context.Context, dir string, timeout time.Duration, args ...string) (string, error) {
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND=ssh -o BatchMode=yes", "LC_ALL=C")
	cmd.Env = append(cmd.Env, ceiling(dir)...)
	bound(cmd)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Start(); err != nil {
		return "", &gitError{err: err, killed: ctx.Err() != nil}
	}
	if err := reap(cmd); err != nil {
		return out.String(), &gitError{err: err, stderr: errb.String(), killed: ctx.Err() != nil}
	}
	return out.String(), nil
}

// reap waits for a started cmd of bound's, and kills its process group once git has exited, before git is reaped: a
// child it left behind holding the pipes dies with it. While git is a zombie its pid is still taken, so the group can't
// be another's yet.
func reap(cmd *exec.Cmd) error {
	var info unix.Siginfo
	for {
		err := unix.Waitid(unix.P_PID, cmd.Process.Pid, &info, unix.WEXITED|unix.WNOWAIT, nil)
		if err != unix.EINTR {
			break
		}
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	return cmd.Wait()
}

var unsafeName = regexp.MustCompile(`[^\w.-]`)

// CacheDir is src/diff.ts cacheDir: the bare cache repo of a repo and its checkout. Its name ends in a short hash of
// the two, so names that read alike on disk get folders of their own.
func (s *Service) CacheDir(repo, checkout string) string {
	sum := sha256.Sum256([]byte(cacheKey(repo, checkout)))
	return filepath.Join(s.Home, "cache", "diff", unsafeName.ReplaceAllString(repo, "_")+"-"+hex.EncodeToString(sum[:])[:12]+".git")
}

// Checkout is src/diff.ts checkoutOf: the checkout of a repo named in settings.itsa.repos.
func (s *Service) Checkout(repo string) (string, error) {
	path, ok := s.Repos()[repo]
	if !ok || path == "" {
		return "", refuse(404, "unknown repo %s: it is not in settings.itsa.repos", repo)
	}
	return path, nil
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// ensureCache is the repo's cache, under its lock: kept when git reads it as a repo, else built afresh. It is built in a
// temporary folder and renamed into place, so a crash leaves no half-made cache under the real name; the ref locks a
// killed fetch left are cleared, since no other git runs in it while the lock is held.
func (s *Service) ensureCache(ctx context.Context, repo, checkout string) (string, error) {
	dir := s.CacheDir(repo, checkout)
	fail := func(err error) (string, error) {
		return "", refuse(500, "can't prepare the diff cache for %s: %s", repo, firstLine(err))
	}
	if exists(dir) {
		if checking != nil {
			checking()
		}
		_, err := git(ctx, "", 0, "--git-dir="+dir, "rev-parse", "--git-dir")
		if err == nil {
			clearLocks(dir)
			return dir, nil
		}
		// Only git's own word that it isn't a repo rebuilds it: a run cut short (a request gone, git missing) never wipes
		// a cache.
		var g *gitError
		if ctx.Err() != nil || !errors.As(err, &g) || !strings.Contains(g.stderr, "not a git repository") {
			return fail(err)
		}
	}
	parent := filepath.Dir(dir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fail(err)
	}
	if err := os.RemoveAll(dir); err != nil {
		return fail(err)
	}
	if old, _ := filepath.Glob(filepath.Join(parent, filepath.Base(dir)+".tmp-*")); len(old) > 0 {
		for _, o := range old {
			os.RemoveAll(o)
		}
	}
	// The checkout's objects are borrowed (as `clone --reference` does), so a fetch only brings what the checkout lacks.
	objects, err := git(ctx, checkout, 0, "rev-parse", "--path-format=absolute", "--git-path", "objects")
	if err != nil {
		return fail(err)
	}
	tmp, err := os.MkdirTemp(parent, filepath.Base(dir)+".tmp-")
	if err != nil {
		return fail(err)
	}
	built := false
	defer func() {
		if !built {
			os.RemoveAll(tmp)
		}
	}()
	if _, err := git(ctx, "", 0, "init", "--bare", "--quiet", tmp); err != nil {
		return fail(err)
	}
	if err := os.MkdirAll(filepath.Join(tmp, "objects", "info"), 0o755); err != nil {
		return fail(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, "objects", "info", "alternates"), []byte(strings.TrimSpace(objects)+"\n"), 0o644); err != nil {
		return fail(err)
	}
	if err := os.Rename(tmp, dir); err != nil {
		return fail(err)
	}
	built = true
	return dir, nil
}

// checking is a test's seam, run in ensureCache just before git is asked whether the cache is a repo.
var checking func()

// inFetch is a test's seam, run in ensure just before the fetch, with the cache's locks held.
var inFetch func(dir string)

// fileLock takes an exclusive flock on path, made if missing, until the returned func; a lock another process holds is
// waited for, polling, until ctx ends.
func fileLock(ctx context.Context, path string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	for {
		err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return func() { f.Close() }, nil
		}
		if err != unix.EWOULDBLOCK && err != unix.EINTR {
			f.Close()
			return nil, err
		}
		select {
		case <-ctx.Done():
			f.Close()
			return nil, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// clearLocks removes the lock files a killed git run left in a cache: a ref's, packed-refs' and the like.
func clearLocks(dir string) {
	for _, name := range []string{"packed-refs.lock", "HEAD.lock", "config.lock", "shallow.lock", "FETCH_HEAD.lock"} {
		os.Remove(filepath.Join(dir, name))
	}
	_ = filepath.WalkDir(filepath.Join(dir, "refs"), func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".lock") {
			os.Remove(p)
		}
		return nil
	})
}

var shaRe = regexp.MustCompile(`^[0-9a-f]{40,64}$`)

// IsSha is whether s is a full commit or object id.
func IsSha(s string) bool { return shaRe.MatchString(s) }

type ensured struct{ dir, checkout, head, main string }

// ensure makes sure the cache has the PR's head and main, fetching when the last fetch is older than refreshSeconds.
func (s *Service) ensure(ctx context.Context, repo string, pr int) (ensured, error) {
	checkout, err := s.Checkout(repo)
	if err != nil {
		return ensured{}, err
	}
	id := cacheKey(repo, checkout)
	defer s.lock(id)()
	// Another daemon on this STAM_HOME may work on the same cache: the folder's lock file, beside it so a rebuild keeps
	// it, is held across its recovery, build, fetch and pruning.
	unlock, err := fileLock(ctx, s.CacheDir(repo, checkout)+".lock")
	if err != nil {
		return ensured{}, refuse(500, "can't lock the diff cache for %s: %s", repo, err.Error())
	}
	defer unlock()
	dir, err := s.ensureCache(ctx, repo, checkout)
	if err != nil {
		return ensured{}, err
	}
	set := s.Settings()
	prRef := "refs/stam-diff/pr/" + strconv.Itoa(pr)
	mainRef := "refs/stam-diff/main"
	key := id + "#" + strconv.Itoa(pr)
	s.mu.Lock()
	if s.used == nil {
		s.used, s.fetched = map[string]int{}, map[string]time.Time{}
	}
	s.tick++
	s.used[key] = s.tick
	fresh := time.Since(s.fetched[key]) < seconds(set.Diff.RefreshSeconds)
	s.mu.Unlock()
	resolve := func() (string, string, bool) {
		head, err1 := git(ctx, dir, 0, "rev-parse", "--verify", prRef+"^{commit}")
		main, err2 := git(ctx, dir, 0, "rev-parse", "--verify", mainRef+"^{commit}")
		if err1 != nil || err2 != nil {
			return "", "", false
		}
		return strings.TrimSpace(head), strings.TrimSpace(main), true
	}
	if fresh {
		if head, main, ok := resolve(); ok {
			return ensured{dir, checkout, head, main}, nil
		}
	}
	url, _ := git(ctx, checkout, 0, "config", "--get", "remote.origin.url")
	url = strings.TrimSpace(url)
	if url == "" {
		return ensured{}, refuse(500, "the checkout of %s has no remote.origin.url", repo)
	}
	// A credential in the URL would go on git's command line, where any process can read it, and into its errors.
	if credentialed(url) {
		return ensured{}, refuse(500, "the origin URL of %s carries credentials; stam fetches only from a URL without them (use a credential helper or ssh)", repo)
	}
	fetchFor := seconds(set.Diff.FetchSeconds)
	if inFetch != nil {
		inFetch(dir)
	}
	if _, err := git(ctx, dir, fetchFor, "fetch", "--quiet", "--no-tags", url, "+refs/pull/"+strconv.Itoa(pr)+"/head:"+prRef, "+refs/heads/"+set.Itsa.MainBranch+":"+mainRef); err != nil {
		var g *gitError
		errors.As(err, &g)
		if g != nil && g.killed {
			return ensured{}, refuse(504, "fetching PR %d of %s timed out after %ss", pr, repo, strconv.FormatFloat(set.Diff.FetchSeconds, 'f', -1, 64))
		}
		text := stderrOf(g, err)
		if strings.Contains(text, "couldn't find remote ref refs/pull/") {
			return ensured{}, refuse(404, "no PR %d in %s", pr, repo)
		}
		lines := strings.Split(strings.TrimSpace(text), "\n")
		return ensured{}, refuse(502, "fetching PR %d of %s failed: %s", pr, repo, redact(lines[len(lines)-1]))
	}
	s.mu.Lock()
	s.fetched[key] = time.Now()
	s.mu.Unlock()
	s.ownObjects(ctx, dir)
	_ = s.pruneRefs(ctx, dir, id, pr, set.Diff.MaxPrRefs)
	head, main, ok := resolve()
	if !ok {
		return ensured{}, refuse(502, "fetching PR %d of %s left no head", pr, repo)
	}
	return ensured{dir, checkout, head, main}, nil
}

// stderrOf is the whole stderr of a failed git run (TS's `String(e.stderr ?? e.message)`), else the error's text.
func stderrOf(g *gitError, err error) string {
	if g != nil {
		return g.stderr
	}
	return err.Error()
}

// ownObjects: after the first fetch the cache takes its own copy of the borrowed objects and drops the link, as
// `clone --dissociate` does, so a `git gc` in the checkout can't take objects the cache refs need.
func (s *Service) ownObjects(ctx context.Context, dir string) {
	alt := filepath.Join(dir, "objects", "info", "alternates")
	if !exists(alt) {
		return
	}
	if _, err := git(ctx, dir, 0, "repack", "-a", "-d", "-q"); err == nil {
		os.Remove(alt)
	}
}

// pruneRefs keeps the keep most recently used PR refs, never the one being asked for; a dropped one is fetched again
// when asked for.
func (s *Service) pruneRefs(ctx context.Context, dir, id string, current, keep int) error {
	out, err := git(ctx, dir, 0, "for-each-ref", "--format=%(refname)", "refs/stam-diff/pr/")
	if err != nil {
		return err
	}
	num := func(r string) int { n, _ := strconv.Atoi(r[strings.LastIndex(r, "/")+1:]); return n }
	var old []string
	for _, r := range strings.Split(out, "\n") {
		if r != "" && num(r) != current {
			old = append(old, r)
		}
	}
	s.mu.Lock()
	used := func(r string) int { return s.used[id+"#"+strconv.Itoa(num(r))] }
	sort.SliceStable(old, func(i, j int) bool { return used(old[i]) > used(old[j]) })
	s.mu.Unlock()
	if keep-1 < len(old) {
		for _, r := range old[max(0, keep-1):] {
			if _, err := git(ctx, dir, 0, "update-ref", "-d", r); err != nil {
				return err
			}
			k := id + "#" + strconv.Itoa(num(r))
			s.mu.Lock()
			delete(s.fetched, k)
			delete(s.used, k)
			delete(s.pins, k)
			s.mu.Unlock()
		}
	}
	return nil
}

// mergeBaseOf is where the diff starts: the merge base of main and the head. A merged PR has none of its own (the head
// is in main), so it starts from the first parent of the merge commit that brought the head in.
func mergeBaseOf(ctx context.Context, dir, main, head string) (string, error) {
	out, err := git(ctx, dir, 0, "merge-base", main, head)
	if err != nil {
		return "", err
	}
	mb := strings.TrimSpace(out)
	if mb != head || head == main {
		return mb, nil
	}
	path, err := git(ctx, dir, 0, "rev-list", "--first-parent", "--ancestry-path", head+".."+main)
	if err != nil {
		return "", err
	}
	var commits []string
	for _, c := range strings.Split(path, "\n") {
		if c != "" {
			commits = append(commits, c)
		}
	}
	if len(commits) == 0 {
		return mb, nil
	}
	parent, err := git(ctx, dir, 0, "rev-parse", "--verify", commits[len(commits)-1]+"^1")
	if err != nil {
		return mb, nil
	}
	base, err := git(ctx, dir, 0, "merge-base", strings.TrimSpace(parent), head)
	if err != nil {
		return mb, nil
	}
	return strings.TrimSpace(base), nil
}

// File is src/diff.ts DiffFile: a RawFile with its class. A path on the files deny list is listed without counts and
// with `denied: true`; its content is never served.
type File struct {
	RawFile
	Class  *string `json:"class"`
	Denied bool    `json:"denied,omitempty"`
}

// List is src/diff.ts list's answer.
type List struct {
	Repo      string `json:"repo"`
	PR        int    `json:"pr"`
	Head      string `json:"head"`
	Base      string `json:"base"`
	MergeBase string `json:"mergeBase"`
	Files     []File `json:"files"`
}

// List is src/diff.ts list: the files a PR touches, from its merge base with main to its head.
func (s *Service) List(ctx context.Context, repo string, pr int) (List, error) {
	e, err := s.ensure(ctx, repo, pr)
	if err != nil {
		return List{}, err
	}
	set := s.Settings()
	r, err := s.pin(ctx, repo, e.checkout, e.dir, pr, e.head, e.main)
	if err != nil {
		return List{}, err
	}
	out := List{Repo: repo, PR: pr, Head: e.head, Base: e.main, MergeBase: r.mergeBase, Files: []File{}}
	for _, f := range r.files {
		if s.denied(e.checkout, f) {
			out.Files = append(out.Files, File{RawFile: RawFile{Path: f.Path, OldPath: f.OldPath, Status: f.Status}, Denied: true})
			continue
		}
		file := File{RawFile: f}
		if c := Classify(f.Path, set.Diff.Classes); c != "" {
			file.Class = &c
		}
		out.Files = append(out.Files, file)
	}
	return out, nil
}

// maxPins is how many listed ranges a PR keeps for viewers pinned to one; the oldest goes first.
const maxPins = 16

// pinned is a range this daemon listed for a PR: the merge base it computed from the head and main, and the files of
// that list with whether each may be served (no denied path, by either of a rename's paths).
type pinned struct {
	mergeBase string
	files     []RawFile
	served    map[string]bool
}

// pinSet is a PR's listed ranges by `head base`, oldest first.
type pinSet struct {
	ranges map[string]*pinned
	order  []string
}

// pin is the range from main to head as this daemon lists it, kept so a viewer may pin to it later.
func (s *Service) pin(ctx context.Context, repo, checkout, dir string, pr int, head, main string) (*pinned, error) {
	id := cacheKey(repo, checkout)
	mergeBase, err := mergeBaseOf(ctx, dir, main, head)
	if err != nil {
		return nil, refuse(422, "PR %d of %s has no merge base with %s", pr, repo, s.Settings().Itsa.MainBranch)
	}
	list, err := s.rawList(ctx, id, dir, head, mergeBase)
	if err != nil {
		return nil, err
	}
	r := &pinned{mergeBase: mergeBase, files: list, served: map[string]bool{}}
	// A path some entry denies stays denied, whatever another entry with it says.
	for _, f := range list {
		ok := !s.denied(checkout, f)
		for _, p := range []string{f.Path, f.OldPath} {
			if p == "" {
				continue
			}
			if was, seen := r.served[p]; seen {
				ok = ok && was
			}
			r.served[p] = ok
		}
	}
	key, pair := id+"#"+strconv.Itoa(pr), head+" "+main
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pins == nil {
		s.pins = map[string]*pinSet{}
	}
	ps := s.pins[key]
	if ps == nil {
		ps = &pinSet{ranges: map[string]*pinned{}}
		s.pins[key] = ps
	}
	if _, there := ps.ranges[pair]; !there {
		ps.order = append(ps.order, pair)
	}
	ps.ranges[pair] = r
	for len(ps.order) > maxPins {
		delete(ps.ranges, ps.order[0])
		ps.order = ps.order[1:]
	}
	return r, nil
}

// pinnedRange is the range of head and main this daemon listed for the PR, or nil: a viewer pins only to an exact
// pair the server computed, never to commits it picks, so it can't move the merge base under a denied file.
func (s *Service) pinnedRange(id string, pr int, head, main string) *pinned {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ps := s.pins[id+"#"+strconv.Itoa(pr)]; ps != nil {
		return ps.ranges[head+" "+main]
	}
	return nil
}

// denied is whether a listed file is on the deny list, by its path or, for a rename, its old one, judged as each would sit
// in the checkout.
func (s *Service) denied(checkout string, f RawFile) bool {
	return s.Paths.Denied(filepath.Join(checkout, f.Path)) || (f.OldPath != "" && s.Paths.Denied(filepath.Join(checkout, f.OldPath)))
}

// rawList is the files changed from mergeBase to head, kept for the next ask (the newest maxLists lists).
func (s *Service) rawList(ctx context.Context, id, dir, head, mergeBase string) ([]RawFile, error) {
	key := id + ":" + head + ":" + mergeBase
	s.mu.Lock()
	hit, ok := s.lists[key]
	s.mu.Unlock()
	if ok {
		return hit, nil
	}
	args := []string{"diff", "-z", "-M", "--no-ext-diff", "--no-textconv", "--no-color"}
	var outs [3]string
	var errs [3]error
	var wg sync.WaitGroup
	for i, kind := range [][]string{{"--name-status"}, {"--numstat"}, {"--raw", "--no-abbrev"}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			outs[i], errs[i] = git(ctx, dir, 0, append(append(append([]string{}, args...), kind...), mergeBase, head)...)
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, refuse(500, "git diff failed: %s", firstLine(err))
		}
	}
	hit = ParseDiff(outs[0], outs[1], outs[2])
	s.mu.Lock()
	if s.lists == nil {
		s.lists = map[string][]RawFile{}
	}
	if _, there := s.lists[key]; !there {
		s.order = append(s.order, key)
	}
	s.lists[key] = hit
	for len(s.order) > maxLists {
		delete(s.lists, s.order[0])
		s.order = s.order[1:]
	}
	s.mu.Unlock()
	return hit, nil
}

// readBlob reads at most limit bytes of a blob.
func readBlob(ctx context.Context, dir, blob string, limit int64) ([]byte, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "cat-file", "blob", blob)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), ceiling(dir)...)
	bound(cmd)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	b, err := io.ReadAll(io.LimitReader(out, limit))
	// Enough read: the rest isn't wanted, so git is stopped rather than waited out.
	cancel()
	reap(cmd)
	return b, err
}

// isText is src/diff.ts isText: no NUL in the first 4096 bytes, which are UTF-8 but for a character cut at the end.
func isText(b []byte) bool {
	s := b[:min(len(b), 4096)]
	if bytes.IndexByte(s, 0) >= 0 {
		return false
	}
	for cut := 0; cut <= 3 && cut < len(s); cut++ {
		if utf8.Valid(s[:len(s)-cut]) {
			return true
		}
	}
	return len(s) == 0
}

// cleanPath is a path in the repo, validated: relative, no `..`, no empty parts, no NUL.
func cleanPath(p string) (string, error) {
	if p == "" {
		return "", refuse(400, "path is required")
	}
	if strings.ContainsRune(p, 0) || strings.HasPrefix(p, "/") {
		return "", refuse(400, "path must be a plain path inside the repo")
	}
	for _, part := range strings.Split(p, "/") {
		if part == "" || part == ".." || part == "." {
			return "", refuse(400, "path must be a plain path inside the repo")
		}
	}
	return p, nil
}

var treeRe = regexp.MustCompile(`(?s)^(\d+) (\w+) ([0-9a-f]+)\t(.*)$`)

// ServeFile is src/diff.ts serveFile: the whole file at one side of the diff, the head of the PR or the merge base it
// is compared with. With want's head and base, exactly those commits are served, so a PR pushed to since the list was
// drawn doesn't change the sides under the viewer; without them the current ones are, and x-stam-head and x-stam-base
// say which. An error is returned before anything is written.
func (s *Service) ServeFile(ctx context.Context, w http.ResponseWriter, repo string, pr int, path, side string, all bool, wantHead, wantBase string) error {
	rel, err := cleanPath(path)
	if err != nil {
		return err
	}
	checkout, err := s.Checkout(repo)
	if err != nil {
		return err
	}
	// The deny list is judged on the path as it would sit in the checkout, so `.env` and `*.pem` stay closed.
	if s.Paths.Denied(filepath.Join(checkout, rel)) {
		return refuse(403, "not available")
	}
	id := cacheKey(repo, checkout)
	dir, head, main := s.CacheDir(repo, checkout), wantHead, wantBase
	r := s.pinnedRange(id, pr, head, main)
	if r == nil || !exists(filepath.Join(dir, "HEAD")) {
		cur, err := s.ensure(ctx, repo, pr)
		if err != nil {
			return err
		}
		dir = cur.dir
		if head == "" {
			head = cur.head
		}
		if main == "" {
			main = cur.main
		}
		if head == cur.head && main == cur.main {
			if r, err = s.pin(ctx, repo, checkout, dir, pr, head, main); err != nil {
				return err
			}
		} else if r = s.pinnedRange(id, pr, head, main); r == nil {
			return refuse(404, "the head or base asked for is not in the cache for PR %d of %s; reload the diff", pr, repo)
		}
	}
	mergeBase := r.mergeBase
	// Only a file in the PR's list is served, and none the list shows as denied, at either side and by either of a
	// rename's paths: `cert.txt` renamed from `secret.pem` is the secret's content under a harmless name. The range is
	// one this daemon listed for the PR, so no head and base a client picks can move the list. TS serves any path in
	// the tree.
	ok, listed := r.served[rel]
	if listed && !ok {
		return refuse(403, "not available")
	}
	if !listed {
		return refuse(404, "%s is not among the files of PR %d", rel, pr)
	}
	rev := head
	if side == "base" {
		rev = mergeBase
	}
	tree, _ := git(ctx, dir, 0, "ls-tree", "-z", rev, "--", rel)
	m := treeRe.FindStringSubmatch(strings.SplitN(tree, "\x00", 2)[0])
	if m == nil || m[4] != rel {
		return refuse(404, "no %s at the %s of PR %d", rel, side, pr)
	}
	if m[2] != "blob" {
		return refuse(400, "%s is not a file at the %s of PR %d", rel, side, pr)
	}
	blob := m[3]
	if !IsSha(blob) {
		return refuse(500, "unexpected object id")
	}
	sizeText, err := git(ctx, dir, 0, "cat-file", "-s", blob)
	if err != nil {
		return err
	}
	size, _ := strconv.ParseInt(strings.TrimSpace(sizeText), 10, 64)
	if size > BinaryCap {
		return refuse(413, "%s is %d bytes, over the %d byte limit", rel, size, BinaryCap)
	}
	body, err := readBlob(ctx, dir, blob, min(size, files.TextCap))
	if err != nil {
		return err
	}
	typ := files.TypeByExt(rel)
	text := isText(body)
	if strings.HasPrefix(typ, "text/") && !text {
		typ = "application/octet-stream"
	} else if typ == "application/octet-stream" && text {
		typ = "text/plain; charset=utf-8"
	}
	textual := strings.HasPrefix(typ, "text/")
	truncated := false
	if size > int64(len(body)) {
		if textual && !all {
			truncated = true
		} else if body, err = readBlob(ctx, dir, blob, size); err != nil {
			return err
		}
	}
	h := w.Header()
	files.SetSafe(h)
	h.Del("Accept-Ranges")
	h.Set("Content-Type", typ)
	h.Set("Content-Length", strconv.Itoa(len(body)))
	h.Set("X-Stam-Size", strconv.FormatInt(size, 10))
	h.Set("X-Stam-Sha", blob)
	h.Set("X-Stam-Head", head)
	h.Set("X-Stam-Base", main)
	if truncated {
		h.Set("X-Stam-Truncated", "1")
	}
	media := strings.HasPrefix(typ, "image/") || strings.HasPrefix(typ, "video/") || strings.HasPrefix(typ, "audio/")
	if !textual && !media && typ != "application/pdf" {
		h.Set("Content-Disposition", `attachment; filename="`+files.SafeName(filepath.Base(rel))+`"`)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
	return nil
}

// AsError is err as a refusal, when it is one.
func AsError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}

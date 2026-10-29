package skills

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf16"

	"stam/internal/jsjson"
)

// The import of a public skill folder from GitHub (src/skill-import.ts, S-890): it is added to STAM_HOME/skills with
// where it came from (origin.json), and an update check tells when the origin moved, so Settings › Skills can offer
// Update.
//
// What is fetched is untrusted. Nothing in it runs: git is called with a fixed argument list built here (the source
// only picks validated URL and path parts), hooks, filters, global config and credential prompts are off, submodules
// are not followed, and the folder is checked (names, size, symlinks, SKILL.md frontmatter) in a temp folder before it
// replaces anything.

// ImportError is a refused import or update: its message is for the human (a 400).
type ImportError struct{ msg string }

func (e *ImportError) Error() string { return e.msg }

func refuse(format string, args ...any) error { return &ImportError{fmt.Sprintf(format, args...)} }

const (
	// MaxBytes and MaxFiles bound a skill folder.
	MaxBytes      = 5 * 1024 * 1024
	MaxFiles      = 300
	gitTimeout    = 120 * time.Second
	checkTTL      = 10 * time.Minute
	checkParallel = 2
)

var (
	segment   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	skillName = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	githubURL = regexp.MustCompile(`(?i)^(?:https://)?(?:www\.)?github\.com/(.*)$`)
	scheme    = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*:`)
	hostLike  = regexp.MustCompile(`^[^/]*\.[^/]*/`)
	lsTreeLen = regexp.MustCompile(`^\S+\s+\S+\s+\S+\s+(\d+|-)\t`)
)

// Source is where an import points: URL is what git clones and origin.json records.
type Source struct {
	URL, Path, Ref string
}

// units is s.length: its UTF-16 units.
func units(s string) int { return len(utf16.Encode([]rune(s))) }

// ParseSource is parseSource: a GitHub URL, OWNER/REPO, or OWNER/REPO/path; github.com over https only. A
// /tree/REF/path or /blob/REF/path/SKILL.md URL names a ref (one path segment) and a folder. file:///REPO.git#PATH[@REF]
// is allowed with allowFile, for tests only.
func ParseSource(input string, allowFile bool) (Source, error) {
	s := jsjson.Trim(input)
	if s == "" || units(s) > 300 || strings.ContainsFunc(s, func(r rune) bool { return jsjson.IsSpace(r) || r == 0 || r == '\\' || r == '?' }) {
		return Source{}, refuse("give a GitHub URL, OWNER/REPO, or OWNER/REPO/path")
	}
	if strings.HasPrefix(s, "file://") {
		if !allowFile {
			return Source{}, refuse("only github.com sources can be imported")
		}
		parts := strings.Split(s, "#")
		rest := ""
		if len(parts) > 1 {
			rest = parts[1]
		}
		path, ref := rest, ""
		if at := strings.LastIndex(rest, "@"); at >= 0 {
			path, ref = rest[:at], rest[at+1:]
		}
		clean, err := cleanPath(path)
		return Source{URL: parts[0], Path: clean, Ref: ref}, err
	}
	rest := s
	m := githubURL.FindStringSubmatch(s)
	if m != nil {
		rest = m[1]
	} else if scheme.MatchString(s) || hostLike.MatchString(s) {
		return Source{}, refuse("only github.com sources can be imported")
	}
	parts := strings.Split(strings.TrimRight(rest, "/"), "/")
	owner, repo := parts[0], ""
	if len(parts) > 1 {
		repo = strings.TrimSuffix(parts[1], ".git")
	}
	var tail []string
	if len(parts) > 2 {
		tail = parts[2:]
	}
	if owner == "" || repo == "" || !segment.MatchString(owner) || !segment.MatchString(repo) {
		return Source{}, refuse("give a GitHub URL, OWNER/REPO, or OWNER/REPO/path")
	}
	ref := ""
	path := tail
	if m != nil && len(tail) > 0 && (tail[0] == "tree" || tail[0] == "blob") {
		if len(tail) > 1 {
			ref = tail[1]
		}
		path = nil
		if len(tail) > 2 {
			path = tail[2:]
		}
		if ref == "" || !segment.MatchString(ref) {
			return Source{}, refuse("the branch or tag in the URL is not a plain name")
		}
		if tail[0] == "blob" {
			if len(path) == 0 || path[len(path)-1] != "SKILL.md" {
				return Source{}, refuse("give the folder that holds SKILL.md")
			}
			path = path[:len(path)-1]
		}
	}
	clean, err := cleanPath(strings.Join(path, "/"))
	return Source{URL: "https://github.com/" + owner + "/" + repo, Path: clean, Ref: ref}, err
}

func cleanPath(p string) (string, error) {
	var parts []string
	for _, seg := range strings.Split(p, "/") {
		if seg == "" {
			continue
		}
		if !segment.MatchString(seg) {
			return "", refuse("the path %q holds a name that is not allowed", p)
		}
		parts = append(parts, seg)
	}
	return strings.Join(parts, "/"), nil
}

// dirBytes is the bytes under a folder, links not followed; it stops counting once past limit.
func dirBytes(dir string, limit int64) int64 {
	var n int64
	var walk func(string)
	walk = func(d string) {
		entries, _ := os.ReadDir(d)
		for _, e := range entries {
			if n > limit {
				return
			}
			p := filepath.Join(d, e.Name())
			st, err := os.Lstat(p)
			if err != nil {
				continue
			}
			if st.IsDir() {
				walk(p)
			} else {
				n += st.Size()
			}
		}
	}
	walk(dir)
	return n
}

// Importer imports, updates and checks skills; one import or update runs at a time, as they share STAM_HOME/skills.
type Importer struct {
	Paths Paths
	// AllowFile allows file:// sources: a test daemon only (STAM_TEST_ALLOW_FILE_SKILLS in a test home).
	AllowFile bool
	// GitHubAPI is the trees API's base, https://api.github.com.
	GitHubAPI string
	Client    *http.Client
	// CloneBytes stops a trees-only clone whose folder grows past it (a huge history can fill the disk within the
	// timeout), checked every Poll.
	CloneBytes int64
	Poll       time.Duration
	Now        func() time.Time
	// Clones counts trees-only clones, for tests.
	Clones atomic.Int32

	serial sync.Mutex
	// onCheck runs as a check starts, holding its slot, and beforeSeen between a check's compare of origin.json and
	// its write; both for tests.
	onCheck    func(name string)
	beforeSeen func()
	mu         sync.Mutex
	checks map[string]*check
	slots  chan struct{}
	// queued counts checks waiting for a slot, for tests.
	queued atomic.Int32
}

type check struct {
	at   time.Time
	key  string
	done chan struct{}
	res  *jsjson.Object
}

// NewImporter is the importer over p.
func NewImporter(p Paths, allowFile bool) *Importer {
	return &Importer{Paths: p, AllowFile: allowFile, GitHubAPI: "https://api.github.com", Client: &http.Client{}, CloneBytes: 200 * 1024 * 1024,
		Poll: 250 * time.Millisecond, Now: time.Now, checks: map[string]*check{}, slots: make(chan struct{}, checkParallel)}
}

func (im *Importer) tooBig() error {
	return refuse("the repository is too large to fetch (over %d MB of history)", im.CloneBytes/1024/1024)
}

// git runs git with stam's fixed flags and a bare environment. With watch, the run is stopped once that folder grows
// past CloneBytes. The server runs in its own process group, killed whole, so git's helpers go too.
func (im *Importer) git(ctx context.Context, args []string, cwd, watch string) (string, error) {
	allow := "never"
	protocols := "https"
	if im.AllowFile {
		allow, protocols = "always", "https:file"
	}
	flags := []string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
		"-c", "protocol.file.allow=" + allow, "-c", "submodule.recurse=false", "-c", "core.symlinks=true"}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append(flags, args...)...)
	cmd.Dir = cwd
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "LANG=C", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=/bin/false", "GIT_ALLOW_PROTOCOL=" + protocols}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	if err := cmd.Start(); err != nil {
		return "", refuse("git %s failed: %s", verb(args), firstLine(err.Error()))
	}
	var big atomic.Bool
	stop := make(chan struct{})
	if watch != "" {
		go func() {
			t := time.NewTicker(im.Poll)
			defer t.Stop()
			for {
				select {
				case <-stop:
					return
				case <-t.C:
					if dirBytes(watch, im.CloneBytes) > im.CloneBytes {
						big.Store(true)
						_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
						return
					}
				}
			}
		}()
	}
	err := cmd.Wait()
	close(stop)
	if big.Load() {
		return "", im.tooBig()
	}
	if err != nil {
		why := jsjson.Trim(stderr.String())
		if why == "" {
			why = err.Error()
		}
		return "", refuse("git %s failed: %s", verb(args), firstLine(why))
	}
	return stdout.String(), nil
}

// verb is the first argument that isn't a flag: the git command run.
func verb(args []string) string {
	for _, a := range args {
		if !strings.HasPrefix(a, "-") {
			return a
		}
	}
	return ""
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(jsjson.Trim(s), "\n")
	return line
}

// frontmatter is SKILL.md's name and description, each trimmed.
func frontmatter(text string) (name, description string, err error) {
	fm, _, ok := splitFrontmatter(text, false)
	if !ok {
		return "", "", refuse("SKILL.md has no frontmatter")
	}
	return jsjson.Trim(fieldValue(fm, "name")), jsjson.Trim(fieldValue(fm, "description")), nil
}

// inspect walks the fetched folder without following links: it counts files and bytes, and refuses anything that isn't
// a plain file, a folder, or a symlink that stays inside the folder. topGit skips the clone's own .git beside a skill at
// the repository's root.
func inspect(root string, topGit bool) error {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	sep := string(filepath.Separator)
	inside := func(x string) bool {
		return x == realRoot || strings.HasPrefix(x, realRoot+sep) || x == root || strings.HasPrefix(x, root+sep)
	}
	rel := func(p string) string {
		r, _ := filepath.Rel(root, p)
		return r
	}
	files, total := 0, int64(0)
	var walk func(string) error
	walk = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			p := filepath.Join(dir, e.Name())
			if topGit && dir == root && e.Name() == ".git" {
				continue
			}
			if strings.ToLower(e.Name()) == ".git" || e.Name() == ".." {
				return refuse("the folder holds a %s entry", e.Name())
			}
			st, err := os.Lstat(p)
			if err != nil {
				return err
			}
			switch {
			case st.Mode()&fs.ModeSymlink != 0:
				target, err := os.Readlink(p)
				if err != nil {
					return err
				}
				if filepath.IsAbs(target) || !inside(filepath.Join(filepath.Dir(p), target)) {
					return refuse("%s is a symlink that points outside the skill folder", rel(p))
				}
				if resolved, err := filepath.EvalSymlinks(p); err == nil && !inside(resolved) {
					return refuse("%s is a symlink that points outside the skill folder", rel(p))
				}
				files++
			case st.IsDir():
				if err := walk(p); err != nil {
					return err
				}
			case st.Mode().IsRegular():
				files++
				total += st.Size()
			default:
				return refuse("%s is not a plain file", rel(p))
			}
			if files > MaxFiles {
				return refuse("the folder holds more than %d files", MaxFiles)
			}
			if total > MaxBytes {
				return refuse("the folder is larger than %d MB", MaxBytes/1024/1024)
			}
		}
		return nil
	}
	return walk(root)
}

func checkStats(files int, total int64) error {
	if files > MaxFiles {
		return refuse("the folder holds more than %d files", MaxFiles)
	}
	if total > MaxBytes {
		return refuse("the folder is larger than %d MB", MaxBytes/1024/1024)
	}
	return nil
}

// StatsFromAPI is statsFromApi: the file count and bytes from GitHub's trees API answer, which gives every blob's size
// without a download.
func StatsFromAPI(answer jsjson.Value) error {
	o, _ := answer.(*jsjson.Object)
	truncated, _ := o.Get("truncated")
	treeV, _ := o.Get("tree")
	tree, isList := treeV.([]jsjson.Value)
	if jsjson.Truthy(truncated) || !isList {
		return refuse("the folder is too large to list")
	}
	files, total := 0, int64(0)
	for _, e := range tree {
		eo, _ := e.(*jsjson.Object)
		typ, _ := eo.Get("type")
		if typ == "commit" {
			return refuse("the folder holds a submodule")
		}
		if typ != "blob" {
			continue
		}
		files++
		size, _ := eo.Get("size")
		if n := jsjson.ToNumber(size); n == n {
			total += int64(n)
		}
	}
	return checkStats(files, total)
}

var githubRepo = regexp.MustCompile(`^https://github\.com/([^/]+)/([^/]+)$`)

// treeSizes is how big the folder is before any of its files is downloaded: a GitHub source asks the trees API for the
// folder's tree; a local test repository, where nothing is downloaded, lists it with git.
func (im *Importer) treeSizes(ctx context.Context, src Source, repo, treeSha string) error {
	gh := githubRepo.FindStringSubmatch(src.URL)
	if gh == nil {
		if !im.AllowFile {
			return refuse("only github.com sources can be imported")
		}
		out, err := im.git(ctx, []string{"ls-tree", "-r", "-l", "-z", treeSha}, repo, "")
		if err != nil {
			return err
		}
		files, total := 0, int64(0)
		for _, rec := range strings.Split(out, "\x00") {
			if rec == "" {
				continue
			}
			if strings.HasPrefix(rec, "160000") {
				return refuse("the folder holds a submodule")
			}
			files++
			if m := lsTreeLen.FindStringSubmatch(rec); m != nil {
				n, _ := strconv.ParseInt(m[1], 10, 64)
				total += n
			}
		}
		return checkStats(files, total)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", im.GitHubAPI+"/repos/"+gh[1]+"/"+gh[2]+"/git/trees/"+treeSha+"?recursive=1", nil)
	if err != nil {
		return refuse("could not size the folder at GitHub: fetch failed")
	}
	req.Header.Set("accept", "application/vnd.github+json")
	req.Header.Set("user-agent", "stam")
	res, err := im.Client.Do(req)
	if err != nil {
		why := "fetch failed"
		if errors.Is(err, context.DeadlineExceeded) {
			why = "The operation was aborted due to timeout"
		}
		return refuse("could not size the folder at GitHub: %s", why)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		if res.StatusCode == 403 || res.StatusCode == 429 {
			return refuse("GitHub refused to size the folder (rate limit); try again later")
		}
		return refuse("could not size the folder at GitHub (%d)", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return err
	}
	answer, err := jsjson.Parse(body)
	if err != nil {
		return errors.New("GitHub's tree answer is not JSON")
	}
	return StatsFromAPI(answer)
}

// cloneTrees is a shallow, blobless clone with nothing checked out (trees only, no file contents): the head commit and
// the folder's tree.
func (im *Importer) cloneTrees(ctx context.Context, src Source, repo, work string) (commit, tree string, err error) {
	im.Clones.Add(1)
	args := []string{"clone", "--depth", "1", "--filter=blob:none", "--no-checkout", "--no-tags"}
	if src.Ref != "" {
		args = append(args, "--branch", src.Ref)
	}
	if _, err := im.git(ctx, append(args, "--", src.URL, repo), work, work); err != nil {
		return "", "", err
	}
	if dirBytes(repo, im.CloneBytes) > im.CloneBytes {
		return "", "", im.tooBig()
	}
	treeish := "HEAD^{tree}"
	if src.Path != "" {
		treeish = "HEAD:" + src.Path
	}
	out, _ := im.git(ctx, []string{"rev-parse", treeish}, repo, "")
	if tree = jsjson.Trim(out); tree == "" {
		return "", "", refuse("no folder %q in the repository", src.Path)
	}
	out, err = im.git(ctx, []string{"rev-parse", "HEAD"}, repo, "")
	return jsjson.Trim(out), tree, err
}

// fetchFolder clones the trees, sizes the folder, and only then downloads and checks out its files.
func (im *Importer) fetchFolder(ctx context.Context, src Source, work string) (dir, commit, tree string, err error) {
	repo := filepath.Join(work, "clone")
	if commit, tree, err = im.cloneTrees(ctx, src, repo, work); err != nil {
		return "", "", "", err
	}
	if err := im.treeSizes(ctx, src, repo, tree); err != nil {
		return "", "", "", err
	}
	spec := "."
	if src.Path != "" {
		spec = ":(literal)" + src.Path
	}
	if _, err := im.git(ctx, []string{"checkout", "--force", "HEAD", "--", spec}, repo, ""); err != nil {
		return "", "", "", err
	}
	dir = repo
	if src.Path != "" {
		dir = filepath.Join(repo, src.Path)
	}
	return dir, commit, tree, nil
}

// readOrigin is a folder's origin.json, when it is an object with a url and a path as text.
func readOrigin(dir string) *jsjson.Object {
	b, err := os.ReadFile(filepath.Join(dir, "origin.json"))
	if err != nil {
		return nil
	}
	v, err := jsjson.Parse(b)
	o, ok := v.(*jsjson.Object)
	if err != nil || !ok {
		return nil
	}
	if _, ok := field(o, "url"); !ok {
		return nil
	}
	if _, ok := field(o, "path"); !ok {
		return nil
	}
	return o
}

// field is o[key] when it is text.
func field(o *jsjson.Object, key string) (string, bool) {
	v, _ := o.Get(key)
	s, ok := v.(string)
	return s, ok
}

// OriginOf is originOf: the origin of an imported skill of stam's, or nil.
func (im *Importer) OriginOf(name string) *jsjson.Object {
	return readOrigin(filepath.Join(im.Paths.Dir(), name))
}

func sameOrigin(o *jsjson.Object, s Source) bool {
	url, _ := field(o, "url")
	path, _ := field(o, "path")
	ref, _ := field(o, "ref")
	return url == s.URL && path == s.Path && ref == s.Ref
}

// copyTree is cpSync(src, dst, {recursive, verbatimSymlinks}) without .git entries: folders, files with their modes,
// and symlinks as they are.
func copyTree(src, dst string) error {
	st, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dst, st.Mode().Perm()); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Name() == ".git" {
			continue
		}
		from, to := filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())
		st, err := os.Lstat(from)
		if err != nil {
			return err
		}
		switch {
		case st.Mode()&fs.ModeSymlink != 0:
			target, err := os.Readlink(from)
			if err != nil {
				return err
			}
			if err := os.Symlink(target, to); err != nil {
				return err
			}
		case st.IsDir():
			if err := copyTree(from, to); err != nil {
				return err
			}
		default:
			b, err := os.ReadFile(from)
			if err != nil {
				return err
			}
			if err := os.WriteFile(to, b, st.Mode().Perm()); err != nil {
				return err
			}
		}
	}
	return nil
}

// Imported is an import's or update's result.
type Imported struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Commit  string `json:"commit"`
	Updated bool   `json:"updated"`
}

func (im *Importer) run(ctx context.Context, src Source, expect string) (Imported, error) {
	home := im.Paths.Home
	if err := os.MkdirAll(home, 0o777); err != nil {
		return Imported{}, err
	}
	work, err := os.MkdirTemp(home, ".skill-import-")
	if err != nil {
		return Imported{}, err
	}
	defer os.RemoveAll(work)
	dir, commit, tree, err := im.fetchFolder(ctx, src, work)
	if err != nil {
		return Imported{}, err
	}
	if !exists(filepath.Join(dir, "SKILL.md")) {
		return Imported{}, refuse("no SKILL.md in that folder")
	}
	if err := inspect(dir, src.Path == ""); err != nil {
		return Imported{}, err
	}
	text, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
	if err != nil {
		return Imported{}, err
	}
	name, description, err := frontmatter(string(text))
	if err != nil {
		return Imported{}, err
	}
	folder := filepath.Base(src.Path)
	if src.Path == "" {
		folder = strings.TrimSuffix(filepath.Base(src.URL), ".git")
	}
	if name == "" || !skillName.MatchString(name) || len(name) > 64 {
		return Imported{}, refuse("the name in SKILL.md must be lowercase letters, digits and hyphens, at most 64 characters")
	}
	if name != folder {
		return Imported{}, refuse("the name %q in SKILL.md must match its folder %q", name, folder)
	}
	if description == "" || units(description) > 1024 {
		return Imported{}, refuse("SKILL.md needs a description of at most 1024 characters")
	}
	if expect != "" && name != expect {
		return Imported{}, refuse("the origin's skill is now called %q, not %q", name, expect)
	}
	target := filepath.Join(im.Paths.Dir(), name)
	if exists(filepath.Join(im.Paths.userDir(), name)) {
		return Imported{}, refuse("you already have a skill called %q in ~/.claude/skills", name)
	}
	// A real folder, or a link that isn't stam's own, in the shared agents folder would hide or be hidden by this one.
	agents := filepath.Join(im.Paths.Agents, name)
	if st, err := os.Lstat(agents); err == nil {
		if to, err := os.Readlink(agents); st.Mode()&fs.ModeSymlink == 0 || (err == nil && to != target) {
			return Imported{}, refuse("you already have a skill called %q in ~/.agents/skills", name)
		}
	}
	var existing *jsjson.Object
	had := exists(target)
	if had {
		existing = readOrigin(target)
	}
	if had && !(existing != nil && sameOrigin(existing, src)) {
		return Imported{}, refuse("a skill called %q already exists", name)
	}
	stage := filepath.Join(work, "stage")
	if err := copyTree(dir, stage); err != nil {
		return Imported{}, err
	}
	o := jsjson.NewObject("url", src.URL, "path", src.Path)
	if src.Ref != "" {
		o.Set("ref", src.Ref)
	}
	o.Set("commit", commit)
	o.Set("tree", tree)
	o.Set("date", im.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	// The fetched folder may ship its own origin.json, or a link at that name aimed at SKILL.md: remove whatever is
	// there (not following it) so the write below creates a plain file.
	if err := os.RemoveAll(filepath.Join(stage, "origin.json")); err != nil {
		return Imported{}, err
	}
	if err := os.WriteFile(filepath.Join(stage, "origin.json"), []byte(jsjson.Stringify(o, "  ")+"\n"), 0o666); err != nil {
		return Imported{}, err
	}
	if err := os.MkdirAll(im.Paths.Dir(), 0o777); err != nil {
		return Imported{}, err
	}
	// Swap in the new folder; put the old one back if the move fails.
	old := filepath.Join(work, "old-"+name)
	if exists(target) {
		if err := os.Rename(target, old); err != nil {
			return Imported{}, err
		}
	}
	if err := os.Rename(stage, target); err != nil {
		if exists(old) {
			_ = os.Rename(old, target)
		}
		return Imported{}, err
	}
	im.forget(name)
	return Imported{Name: name, Path: target, Commit: commit, Updated: existing != nil}, nil
}

// Import is importSkill: the skill at source added to STAM_HOME/skills.
func (im *Importer) Import(ctx context.Context, source string) (Imported, error) {
	src, err := ParseSource(source, im.AllowFile)
	if err != nil {
		return Imported{}, err
	}
	im.serial.Lock()
	defer im.serial.Unlock()
	return im.run(ctx, src, "")
}

// Update is updateSkill: an imported skill fetched again from the origin its origin.json records.
func (im *Importer) Update(ctx context.Context, name string) (Imported, error) {
	if !skillName.MatchString(name) {
		return Imported{}, refuse("not a skill name")
	}
	o := im.OriginOf(name)
	if o == nil {
		return Imported{}, refuse("%q was not imported, so it has no origin to update from", name)
	}
	im.serial.Lock()
	defer im.serial.Unlock()
	return im.run(ctx, originSource(o), name)
}

func originSource(o *jsjson.Object) Source {
	url, _ := field(o, "url")
	path, _ := field(o, "path")
	ref, _ := field(o, "ref")
	return Source{URL: url, Path: path, Ref: ref}
}

// Recover is recoverImports: a skill folder an interrupted update moved aside is put back, and leftover work folders
// are removed. Run at daemon start, when no import is under way.
func (p Paths) Recover() {
	entries, _ := os.ReadDir(p.Home)
	for _, e := range entries {
		n := e.Name()
		if !strings.HasPrefix(n, ".skill-import-") && !strings.HasPrefix(n, ".skill-check-") {
			continue
		}
		w := filepath.Join(p.Home, n)
		inner, _ := os.ReadDir(w)
		for _, x := range inner {
			name, ok := strings.CutPrefix(x.Name(), "old-")
			if !ok {
				continue
			}
			if target := filepath.Join(p.Dir(), name); !exists(target) {
				if os.MkdirAll(p.Dir(), 0o777) != nil || os.Rename(filepath.Join(w, x.Name()), target) != nil {
					break
				}
			}
		}
		_ = os.RemoveAll(w)
	}
}

func (im *Importer) forget(name string) {
	im.mu.Lock()
	delete(im.checks, name)
	im.mu.Unlock()
}

// remoteHead is the origin's current head: the repository's HEAD, or the pinned branch or tag (peeled).
func (im *Importer) remoteHead(ctx context.Context, src Source) (string, error) {
	pats := []string{"HEAD"}
	if src.Ref != "" {
		pats = []string{"refs/heads/" + src.Ref, "refs/tags/" + src.Ref, "refs/tags/" + src.Ref + "^{}"}
	}
	out, err := im.git(ctx, append([]string{"ls-remote", "--", src.URL}, pats...), "", "")
	if err != nil {
		return "", err
	}
	var lines []string
	for _, l := range strings.Split(out, "\n") {
		if l != "" {
			lines = append(lines, l)
		}
	}
	pick := ""
	if len(lines) > 0 {
		pick = lines[0]
	}
	for _, l := range lines {
		if strings.HasSuffix(l, "^{}") {
			pick = l
			break
		}
	}
	// .split(/\s/)[0]: the text before the first space.
	if i := strings.IndexFunc(pick, jsjson.IsSpace); i >= 0 {
		pick = pick[:i]
	}
	return pick, nil
}

func (im *Importer) writeOrigin(name string, o *jsjson.Object) error {
	file := filepath.Join(im.Paths.Dir(), name, "origin.json")
	if err := os.RemoveAll(file + ".tmp"); err != nil {
		return err
	}
	if err := os.WriteFile(file+".tmp", []byte(jsjson.Stringify(o, "  ")+"\n"), 0o666); err != nil {
		return err
	}
	return os.Rename(file+".tmp", file)
}

func state(moved bool, commit, failure string) *jsjson.Object {
	o := jsjson.NewObject("moved", moved)
	if commit != "" {
		o.Set("commit", commit)
	}
	if failure != "" {
		o.Set("error", failure)
	}
	return o
}

func (im *Importer) checkNow(ctx context.Context, name string, o *jsjson.Object) *jsjson.Object {
	if im.onCheck != nil {
		im.onCheck(name)
	}
	src := originSource(o)
	commit, _ := field(o, "commit")
	seen, _ := field(o, "seen")
	tree, _ := field(o, "tree")
	head, err := im.remoteHead(ctx, src)
	if err != nil {
		return state(false, "", err.Error())
	}
	if head == "" {
		return state(false, "", "the origin has no such head")
	}
	if head == commit || head == seen {
		return state(false, head, "")
	}
	work, err := os.MkdirTemp(im.Paths.Home, ".skill-check-")
	if err != nil {
		return state(false, "", err.Error())
	}
	defer os.RemoveAll(work)
	now, nowTree, err := im.cloneTrees(ctx, src, filepath.Join(work, "clone"), work)
	if err != nil {
		return state(false, "", err.Error())
	}
	if tree != "" && nowTree == tree {
		// Only other files changed: remember this head, so it isn't cloned again until the origin moves. The folder may
		// have been updated while this check ran: write only over the origin it started from. The compare and the write
		// hold the import lock, so an import can't land between them (TS's synchronous reads and writes can't interleave).
		im.serial.Lock()
		if cur := im.OriginOf(name); cur != nil {
			c, _ := field(cur, "commit")
			t, _ := field(cur, "tree")
			s, _ := field(cur, "seen")
			if c == commit && t == tree && s == seen {
				if im.beforeSeen != nil {
					im.beforeSeen()
				}
				o.Set("seen", now)
				_ = im.writeOrigin(name, o)
			}
		}
		im.serial.Unlock()
		return state(false, now, "")
	}
	return state(true, now, "")
}

// CheckUpdate is checkUpdate: whether the origin changed under the skill's path. The head is compared first, and only
// a moved head is cloned (trees only) to compare the folder. Answers are kept for ten minutes, never an error, and at
// most two checks run at once; a caller that goes away leaves the check running for the others.
func (im *Importer) CheckUpdate(ctx context.Context, name string) *jsjson.Object {
	o := im.OriginOf(name)
	if o == nil {
		return state(false, "", "no origin")
	}
	commit, _ := field(o, "commit")
	seen, _ := field(o, "seen")
	tree, _ := field(o, "tree")
	key := commit + "|" + seen + "|" + tree
	im.mu.Lock()
	c := im.checks[name]
	if c == nil || c.key != key || im.Now().Sub(c.at) >= checkTTL {
		c = &check{at: im.Now(), key: key, done: make(chan struct{})}
		im.checks[name] = c
		go func() {
			select {
			case im.slots <- struct{}{}:
			default:
				im.queued.Add(1)
				im.slots <- struct{}{}
				im.queued.Add(-1)
			}
			res := im.checkNow(context.Background(), name, o)
			<-im.slots
			im.mu.Lock()
			c.res = res
			if _, failed := res.Get("error"); failed && im.checks[name] == c {
				delete(im.checks, name)
			}
			im.mu.Unlock()
			close(c.done)
		}()
	}
	im.mu.Unlock()
	select {
	case <-c.done:
	case <-ctx.Done():
		return state(false, "", ctx.Err().Error())
	}
	im.mu.Lock()
	defer im.mu.Unlock()
	return c.res
}

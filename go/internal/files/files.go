// Package files is src/files.ts, the Files API's local half (S-1525): what a path may name, listing a folder, and
// serving a file. Only the human reaches it (the server checks), over the roots in `files.roots`; a fixed deny list
// holds even inside a root, and every path is resolved to its real path, so `..` and symlinks can't escape.
package files

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"stam/internal/config"
)

// Error is src/files.ts FilesError: a refusal with its HTTP status.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

func refuse(status int, msg string) error { return &Error{Status: status, Message: msg} }

// TextCap is how much of a text file is served without `all` (src/files.ts TEXT_CAP).
const TextCap = 5 * 1024 * 1024

// Paths is where the deny list and the default roots look: the user's home folder and stam's own home, as given (they
// are resolved to real paths where they are compared).
type Paths struct {
	Home     string
	StamHome string
}

// DefaultRoots is src/files.ts defaultRoots: the folder holding the checkout stam runs from (root, the daemon's code
// folder), else ~/projects; the mail attachments (S-2083); and the agents' worktrees (S-2101).
func (p Paths) DefaultRoots(root string) []string {
	first := filepath.Join(p.Home, "projects")
	if repo := config.DerivedRepoPath(root); repo != "" {
		first = filepath.Dir(repo)
	}
	return []string{first, filepath.Join(p.StamHome, "attachments"), filepath.Join(p.StamHome, "worktrees")}
}

func (p Paths) expand(path string) string {
	if path == "~" {
		return p.Home
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(p.Home, path[2:])
	}
	return path
}

// resolve is Node's path.resolve of one path: absolute against the working directory, cleaned.
func resolve(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return abs
}

// RealRoots is src/files.ts realRoots: the configured roots (nil or empty means the defaults) that exist, as real
// paths, in order and once each. A root that is the home folder or holds it is dropped: it would open every credential
// file in it to the walk.
func (p Paths) RealRoots(configured []string, root string) []string {
	if len(configured) == 0 {
		configured = p.DefaultRoots(root)
	}
	home := resolveSafe(p.Home)
	seen := map[string]bool{}
	out := []string{}
	for _, r := range configured {
		real, err := filepath.EvalSymlinks(resolve(p.expand(r)))
		if err != nil || inside(home, real) || seen[real] {
			continue
		}
		seen[real] = true
		out = append(out, real)
	}
	return out
}

func inside(child, root string) bool {
	if child == root {
		return true
	}
	if !strings.HasSuffix(root, "/") {
		root += "/"
	}
	return strings.HasPrefix(child, root)
}

func resolveSafe(p string) string {
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	return resolve(p)
}

// homeDenied are the folders and files under the home folder that hold credentials, matched case-insensitively.
var homeDenied = []string{".claude", ".codex", ".config/gh", ".config/upctl.yaml", ".local/share/opencode/auth.json", ".aws", ".docker/config.json", ".npmrc", ".gnupg"}

// Denied is src/files.ts denied: whether a path is on the fixed deny list of credentials, keys, shell history, and
// stam's own tokens. It is not a setting.
func (p Paths) Denied(abs string) bool {
	low := strings.ToLower(abs)
	parts := nonEmpty(strings.Split(low, "/"))
	name := ""
	if len(parts) > 0 {
		name = parts[len(parts)-1]
	}
	for _, part := range parts {
		if part == ".ssh" {
			return true
		}
	}
	if strings.HasPrefix(name, ".env") || strings.HasSuffix(name, ".pem") || strings.HasSuffix(name, ".key") || name == ".netrc" || name == ".git-credentials" {
		return true
	}
	if (strings.HasPrefix(name, "id_") && !strings.HasSuffix(name, ".pub")) || name == ".history" || strings.HasSuffix(name, "_history") {
		return true
	}
	home := strings.ToLower(resolveSafe(p.Home))
	if inside(low, home) {
		rel := nonEmpty(strings.Split(low[len(home):], "/"))
		relPath := strings.Join(rel, "/")
		for _, d := range homeDenied {
			// `.claude*` also covers .claude-work and the like.
			if d == ".claude" {
				if len(rel) > 0 && strings.HasPrefix(rel[0], ".claude") {
					return true
				}
			} else if relPath == d || strings.HasPrefix(relPath, d+"/") {
				return true
			}
		}
	}
	// stam's own home holds the tokens (and every agent's): only the mail attachments and the agents' worktrees in it are
	// open. The credential patterns above still hold inside a worktree.
	stam := strings.ToLower(resolveSafe(p.StamHome))
	return inside(low, stam) && !inside(low, filepath.Join(stam, "attachments")) && !inside(low, filepath.Join(stam, "worktrees"))
}

func nonEmpty(parts []string) []string {
	out := parts[:0:0]
	for _, s := range parts {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// ResolveIn is src/files.ts resolveIn: a requested path as a real path inside a root, or a refusal. Both the path as
// given and its real target are checked against the deny list, so a harmless-looking link to a secret is refused.
func (p Paths) ResolveIn(requested string, roots []string) (string, error) {
	asked := resolve(p.expand(requested))
	if !strings.HasPrefix(requested, "/") && !strings.HasPrefix(requested, "~") {
		return "", refuse(400, "path must be absolute")
	}
	real, err := filepath.EvalSymlinks(asked)
	if err != nil {
		return "", refuse(404, "no such file")
	}
	if !inRoots(real, roots) {
		return "", refuse(403, "outside the allowed folders")
	}
	if p.Denied(asked) || p.Denied(real) {
		return "", refuse(403, "not available")
	}
	return real, nil
}

func inRoots(real string, roots []string) bool {
	for _, r := range roots {
		if inside(real, r) {
			return true
		}
	}
	return false
}

// Root is one root as GET /api/files/list with no path names it.
type Root struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

// ListRoots is src/files.ts listRoots.
func ListRoots(roots []string) []Root {
	out := make([]Root, 0, len(roots))
	for _, r := range roots {
		out = append(out, Root{Path: r, Name: filepath.Base(r)})
	}
	return out
}

// Entry is one entry of a folder listing.
type Entry struct {
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

// beforeListOpen and afterListCheck are a test's seams in ListDir, between ResolveIn and the open, and between the
// re-check and the reads: nil in the daemon.
var beforeListOpen, afterListCheck func(real string)

// ListDir is src/files.ts listDir: the folder's entries but the denied ones, in localeCompare order. A symlink is
// listed as one, with its target's size and mtime when it has one. The folder is opened once, non-blocking and only as a
// folder (a FIFO is no folder, and can't hang the daemon), and its real path is checked against the roots and the deny
// list again, so a folder on the way swapped for a link after ResolveIn can't list another; its entries are read
// through that handle.
func (p Paths) ListDir(real string, roots []string) ([]Entry, error) {
	if beforeListOpen != nil {
		beforeListOpen(real)
	}
	fd, err := unix.Open(real, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, refuse(400, "not a folder")
	}
	f := os.NewFile(uintptr(fd), real)
	defer f.Close()
	// No /proc (not Linux): the check made before the open stands.
	if now, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(fd)); err == nil {
		if !inRoots(now, roots) || p.Denied(now) {
			return nil, refuse(403, "the folder moved")
		}
	}
	if afterListCheck != nil {
		afterListCheck(real)
	}
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, refuse(400, "not a folder")
	}
	out := []Entry{}
	for _, name := range names {
		if p.Denied(filepath.Join(real, name)) {
			continue
		}
		var l unix.Stat_t
		if unix.Fstatat(fd, name, &l, unix.AT_SYMLINK_NOFOLLOW) != nil {
			continue
		}
		st := l
		link := l.Mode&unix.S_IFMT == unix.S_IFLNK
		if link {
			var t unix.Stat_t
			if unix.Fstatat(fd, name, &t, 0) == nil {
				st = t
			}
		}
		kind := "file"
		if link {
			kind = "symlink"
		} else if l.Mode&unix.S_IFMT == unix.S_IFDIR {
			kind = "dir"
		}
		size := st.Size
		if st.Mode&unix.S_IFMT == unix.S_IFDIR {
			size = 0
		}
		out = append(out, Entry{Name: name, Kind: kind, Size: size, Mtime: mtimeMs(time.Unix(st.Mtim.Unix()))})
	}
	sortNames(out)
	return out, nil
}

// mtimeMs is Math.floor of Node's stat mtimeMs, which is seconds*1e3 + nanoseconds/1e6 as a double: near the end of a
// millisecond the double rounds up to the next one, so plain truncation would differ.
func mtimeMs(t time.Time) int64 {
	return int64(math.Floor(float64(t.Unix())*1e3 + float64(t.Nanosecond())/1e6))
}

// sortNames orders a listing as JS's localeCompare does, by Node's ICU root collation; x/text's root collation is the
// same CLDR table.
func sortNames(entries []Entry) {
	c := collate.New(language.Und)
	sort.SliceStable(entries, func(i, j int) bool { return c.CompareString(entries[i].Name, entries[j].Name) < 0 })
}

// SafeName is a file name for content-disposition: every UTF-16 unit that isn't [\w. -] becomes `_`, as TS's replace,
// so a character past the BMP becomes two.
func SafeName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r == '.' || r == ' ' || r == '-' || r == '_' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
			b.WriteRune(r)
		case r > 0xFFFF:
			b.WriteString("__")
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

// AsError is err as a refusal, when it is one.
func AsError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}

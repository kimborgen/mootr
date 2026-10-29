package instructions

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// The "Your workspace" slot (src/workspace-prompt.ts, S-895, S-896): the agent's personal workspace folder with an index
// of it, and the folders other agents shared with it (src/workspace-share.ts).

// WorkspaceIndexMaxChars is src/workspace-prompt.ts WORKSPACE_INDEX_MAX_CHARS, about 300 tokens, in UTF-16 code units.
const WorkspaceIndexMaxChars = 1200

const (
	indexMaxEntries = 500
	indexMaxDepth   = 4
	indexLineMax    = 160
)

func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

// jsPrefix is s.slice(0, n) in UTF-16 code units. A cut inside a surrogate pair leaves U+FFFD where JavaScript keeps a
// lone surrogate (Go strings can't hold one). Where TS writes the text as UTF-8, as in the system-prompt file, that lone
// surrogate becomes U+FFFD too and the bytes agree. In JSON, TS's JSON.stringify keeps it as \ud83d while Go writes
// U+FFFD. Two cuts can carry one into a route's JSON (the prompt the instructions route returns), and the two differ
// there: a workspace file's first line (firstLine, at indexLineMax) and a lesson line or detail. The task text only feeds
// the embedder. lessons_test.go's longtask cuts the task inside one.
func jsPrefix(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

var binaryText = regexp.MustCompile("[\x00-\x08\x0e-\x1f\x7f]")

// firstLine is a file's first non-blank line, trimmed and capped; "" for a binary or non-UTF-8 file, or one that can't
// be read. Only its first 512 bytes are read.
func firstLine(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, 512)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return ""
	}
	text := strings.ToValidUTF8(string(buf[:n]), "�")
	if binaryText.MatchString(text) {
		return ""
	}
	if n == len(buf) {
		// A character cut at the buffer's end.
		text = strings.TrimSuffix(text, "�")
	}
	line := ""
	for _, l := range strings.Split(text, "\n") {
		if jsjson.Trim(l) != "" {
			line = l
			break
		}
	}
	if strings.Contains(line, "�") {
		return ""
	}
	return jsPrefix(jsjson.Trim(line), indexLineMax)
}

// walkBatch is how many entries walk reads from a directory at a time.
const walkBatch = 64

// dirReader is the part of *os.File walk reads a directory through.
type dirReader interface {
	ReadDir(n int) ([]os.DirEntry, error)
	Close() error
}

// openDir opens a directory for walk; a test swaps it to watch the reads.
var openDir = func(path string) (dirReader, error) { return os.Open(path) }

// walk lists the files under root/dir in directory order, up to the entry cap and the depth. Each entry is checked with
// lstat, so a symlink inside the folder is never followed; root itself is opened as given. Like TS's entry-by-entry
// read, it reads a directory in batches and stops once the cap is met, so a huge directory isn't listed whole.
func walk(root, dir string, depth int, out *[]string) {
	if len(*out) >= indexMaxEntries {
		return
	}
	d, err := openDir(filepath.Join(root, dir))
	if err != nil {
		return
	}
	var subdirs []string
	for len(*out) < indexMaxEntries {
		entries, err := d.ReadDir(walkBatch)
		for _, e := range entries {
			if len(*out) >= indexMaxEntries {
				break
			}
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			rel := e.Name()
			if dir != "" {
				rel = dir + "/" + e.Name()
			}
			st, err := os.Lstat(filepath.Join(root, rel))
			if err != nil {
				continue
			}
			switch {
			case st.IsDir():
				subdirs = append(subdirs, rel)
			case st.Mode().IsRegular():
				*out = append(*out, rel)
			}
		}
		if err != nil || len(entries) == 0 {
			break
		}
	}
	d.Close()
	if depth >= indexMaxDepth {
		return
	}
	sortJS(subdirs)
	for _, sub := range subdirs {
		walk(root, sub, depth+1, out)
	}
}

// sortJS is Array.prototype.sort with no comparator: by UTF-16 code units.
func sortJS(s []string) {
	sort.SliceStable(s, func(i, j int) bool {
		a, b := utf16.Encode([]rune(s[i])), utf16.Encode([]rune(s[j]))
		for k := 0; k < len(a) && k < len(b); k++ {
			if a[k] != b[k] {
				return a[k] < b[k]
			}
		}
		return len(a) < len(b)
	})
}

// WorkspaceIndex is src/workspace-prompt.ts workspaceIndex: each file's relative path and first line, sorted, within max
// characters, with a "+N more files" tail.
func WorkspaceIndex(path string, max int) string {
	var files []string
	walk(path, "", 0, &files)
	sortJS(files)
	if len(files) == 0 {
		return "(empty)"
	}
	var lines []string
	used := 0
	for i, f := range files {
		line := "- `" + f + "`"
		if fl := firstLine(filepath.Join(path, f)); fl != "" {
			line += ": " + fl
		}
		tail := fmt.Sprintf("+%d more files", len(files)-i)
		n := jsLen(line)
		if (i > 0 && used+n+1+jsLen(tail) > max) || (i == 0 && used+n+1 > max) {
			lines = append(lines, tail)
			return strings.Join(lines, "\n")
		}
		lines = append(lines, line)
		used += n + 1
	}
	return strings.Join(lines, "\n")
}

// Grant is one folder shared with an agent (src/workspace-share.ts Grant).
type Grant struct {
	Owner, Path, Access string
}

// GrantsFor is src/workspace-share.ts grantsFor: the folders shared with an agent, by path, each with its holder's name
// (the live agent whose personal workspace it is), else the granter's name or id.
func (p *Prompts) GrantsFor(ctx context.Context, agentID string) ([]Grant, error) {
	rows, err := p.DB.GrantsTo(ctx, agentID)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	agents, err := p.DB.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Grant, len(rows))
	for i, r := range rows {
		owner := ""
		for _, a := range agents {
			if a.PersonalWorkspace != nil && *a.PersonalWorkspace == r.Workspace && a.Lifecycle != "archived" {
				owner = a.Name
			}
		}
		if owner == "" {
			owner = r.GrantedBy
			if a, err := p.DB.GetAgent(ctx, r.GrantedBy); err == nil {
				owner = a.Name
			}
		}
		out[i] = Grant{owner, r.Workspace, r.Access}
	}
	return out, nil
}

// GrantedPaths is src/workspace-share.ts grantedPaths: the paths of the folders shared with an agent.
func (p *Prompts) GrantedPaths(ctx context.Context, agentID string) ([]string, error) {
	grants, err := p.GrantsFor(ctx, agentID)
	out := make([]string, len(grants))
	for i, g := range grants {
		out[i] = g.Path
	}
	return out, err
}

type share struct{ name, access string }

// sharesOf is src/workspace-share.ts sharesOf: who a folder is shared with, live and not forwarded, by grantee id.
func (p *Prompts) sharesOf(ctx context.Context, path string) ([]share, error) {
	rows, err := p.DB.GrantsOf(ctx, path)
	if err != nil {
		return nil, err
	}
	var out []share
	for _, r := range rows {
		a, err := p.DB.GetAgent(ctx, r.GranteeID)
		if err == nil && a.Lifecycle != "archived" && (a.ForwardedTo == nil || *a.ForwardedTo == "") {
			out = append(out, share{a.Name, r.Access})
		}
	}
	return out, nil
}

// WorkspacePrompt is src/workspace-prompt.ts workspacePrompt: the agent's own folder and its index, then the folders
// shared with it; "" when it has neither.
func (p *Prompts) WorkspacePrompt(ctx context.Context, a db.Agent) (string, error) {
	own := ""
	if pw := deref(a.PersonalWorkspace); pw != "" {
		var err error
		if own, err = p.Templates.Render("workspace", map[string]string{"path": pw, "index": WorkspaceIndex(pw, WorkspaceIndexMaxChars)}, ""); err != nil {
			return "", err
		}
		shares, err := p.sharesOf(ctx, pw)
		if err != nil {
			return "", err
		}
		if len(shares) > 0 {
			list := make([]string, len(shares))
			for i, s := range shares {
				list[i] = fmt.Sprintf("%s (%s)", s.name, s.access)
			}
			own += "\n\nYou share this folder with: " + strings.Join(list, ", ") + "."
		}
	}
	var grants []Grant
	if a.ID != "" {
		var err error
		if grants, err = p.GrantsFor(ctx, a.ID); err != nil {
			return "", err
		}
	}
	if len(grants) == 0 {
		return own, nil
	}
	list := make([]string, len(grants))
	for i, g := range grants {
		list[i] = fmt.Sprintf("- %s: `%s` (%s)", g.Owner, g.Path, g.Access)
	}
	intro := "# Your workspace\n\nYou have no folder of your own.\n\n"
	if own != "" {
		intro = own + "\n\n"
	}
	return p.Templates.Render("workspace-shared", map[string]string{"intro": intro, "list": strings.Join(list, "\n")}, "")
}

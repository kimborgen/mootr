// Package skills is the skill folders stam deploys (src/instructions.ts): the user's Claude Code skills and stam's own,
// what Settings › Skills shows of each, the links that put them in each harness's skills folder, and the import of a
// public skill from GitHub (src/skill-import.ts).
package skills

import (
	"errors"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"stam/internal/jsjson"
)

// Paths are where skills live: Home is STAM_HOME, UserHome the user's home, and Agents the folder Codex, OpenCode,
// Gemini CLI and others read user skills from (src/instructions.ts agentsSkillsDir: STAM_AGENTS_SKILLS, which test
// daemons set so they never write into the real one, or ~/.agents/skills).
type Paths struct {
	Home, UserHome, Agents string
}

// Dir is stam's own skills folder, STAM_HOME/skills (SKILLS_DIR).
func (p Paths) Dir() string { return filepath.Join(p.Home, "skills") }

func (p Paths) userDir() string     { return filepath.Join(p.UserHome, ".claude", "skills") }
func (p Paths) opencodeDir() string { return filepath.Join(p.Home, "opencode", "skills") }

// sources is sourceDirs: the folders skills are linked from.
func (p Paths) sources() []string { return []string{p.userDir(), p.Dir()} }

// Folder is one skill folder: Source is "claude" for ~/.claude/skills, "stam" for stam's own.
type Folder struct {
	Name, Path, Source string
}

// Folders is skillFolders: every folder holding a SKILL.md in ~/.claude/skills, then in STAM_HOME/skills, where a
// stam skill replaces a user skill of the same name in its place (as the TS Map does).
func (p Paths) Folders() []Folder {
	var out []Folder
	at := map[string]int{}
	for _, src := range []struct{ source, dir string }{{"claude", p.userDir()}, {"stam", p.Dir()}} {
		entries, err := os.ReadDir(src.dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			n := e.Name()
			if !exists(filepath.Join(src.dir, n, "SKILL.md")) {
				continue
			}
			f := Folder{n, filepath.Join(src.dir, n), src.source}
			if i, ok := at[n]; ok {
				out[i] = f
				continue
			}
			at[n] = len(out)
			out = append(out, f)
		}
	}
	return out
}

// lines is text.split(/\r?\n/).
func lines(text string) []string {
	out := strings.Split(text, "\n")
	for i, l := range out {
		out[i] = strings.TrimSuffix(l, "\r")
	}
	return out
}

// keyValue is a frontmatter line's value after `KEY:` (/^KEY\s*:\s*/), and whether the line is that key's.
func keyValue(line, key string) (string, bool) {
	rest, ok := strings.CutPrefix(line, key)
	if !ok {
		return "", false
	}
	rest = strings.TrimLeftFunc(rest, jsjson.IsSpace)
	rest, ok = strings.CutPrefix(rest, ":")
	if !ok {
		return "", false
	}
	return strings.TrimLeftFunc(rest, jsjson.IsSpace), true
}

// fieldValue is the value of key in frontmatter lines: on its line, or folded (`>`, `|`) over the indented lines after
// it, joined with spaces and with one pair of surrounding quotes dropped; "" when the key is missing.
func fieldValue(fm []string, key string) string {
	for i, l := range fm {
		first, ok := keyValue(l, key)
		if !ok {
			continue
		}
		var rest []string
		for _, l := range fm[i+1:] {
			if r, _ := utf8.DecodeRuneInString(l); l != "" && !jsjson.IsSpace(r) {
				break
			}
			rest = append(rest, jsjson.Trim(l))
		}
		parts := append([]string{first}, rest...)
		if folded(first) {
			parts = rest
		}
		var kept []string
		for _, p := range parts {
			if p != "" {
				kept = append(kept, p)
			}
		}
		return unquote(strings.Join(kept, " "))
	}
	return ""
}

// folded is /^[>|][+-]?$/.
func folded(s string) bool {
	if s == "" || (s[0] != '>' && s[0] != '|') {
		return false
	}
	return len(s) == 1 || (len(s) == 2 && (s[1] == '+' || s[1] == '-'))
}

// unquote is .replace(/^(["'])([\s\S]*)\1$/, '$2').
func unquote(s string) string {
	if len(s) >= 2 && (s[0] == '"' || s[0] == '\'') && s[len(s)-1] == s[0] {
		return s[1 : len(s)-1]
	}
	return s
}

// splitFrontmatter is the frontmatter's lines and the text after it (/^---\r?\n([\s\S]*?)\r?\n---(\r?\n?)/, with the
// newline after the closing --- part of the match when withNewline); ok is false when there is none.
func splitFrontmatter(text string, withNewline bool) (fm []string, rest string, ok bool) {
	var body string
	switch {
	case strings.HasPrefix(text, "---\n"):
		body = text[4:]
	case strings.HasPrefix(text, "---\r\n"):
		body = text[5:]
	default:
		return nil, text, false
	}
	// The lazy group ends at the first "\n---"; a \r before that newline is the closing \r?\n's.
	j := strings.Index(body, "\n---")
	if j < 0 {
		return nil, text, false
	}
	group := strings.TrimSuffix(body[:j], "\r")
	end := j + 4
	if withNewline {
		if strings.HasPrefix(body[end:], "\r\n") {
			end += 2
		} else if strings.HasPrefix(body[end:], "\n") || strings.HasPrefix(body[end:], "\r") {
			end++
		}
	}
	return lines(group), body[end:], true
}

// Parse is parseSkill: what a SKILL.md says in its frontmatter, its description, and the body after it.
func Parse(text string) (description, body string) {
	fm, rest, ok := splitFrontmatter(text, true)
	if !ok {
		return "", text
	}
	return fieldValue(fm, "description"), rest
}

// Info is SkillInfo: one skill as Settings › Skills shows it.
type Info struct {
	Name, Path string
	// Source is user (~/.claude/skills), stam (STAM_HOME/skills) or imported (a stam skill with an origin.json).
	Source      string
	Origin      *jsjson.Object
	Description string
	Body        string
	// Tokens is SKILL.md's bytes / 4, rounded up; ExtraTokens the same for its other files.
	Tokens, ExtraTokens int
	// Reaches is each harness's reach: native when its skills folder holds this skill, else unreachable.
	Reaches *jsjson.Object
}

// JSON is the skill as GET /api/skills lists it, without its body; extra fields follow its own.
func (i Info) JSON(extra ...any) *jsjson.Object {
	o := jsjson.NewObject("name", i.Name, "path", i.Path, "source", i.Source)
	if i.Origin != nil {
		o.Set("origin", i.Origin)
	}
	o.Set("description", i.Description)
	o.Set("tokens", i.Tokens)
	o.Set("extraTokens", i.ExtraTokens)
	o.Set("reaches", i.Reaches)
	for k := 0; k+1 < len(extra); k += 2 {
		o.Set(extra[k].(string), extra[k+1])
	}
	return o
}

// real is realpathSync, else resolve.
func real(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		if a, err := filepath.Abs(r); err == nil {
			return a
		}
		return r
	}
	a, _ := filepath.Abs(p)
	return a
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// folderBytes is the bytes of the files under dir, skip left out and symlinks followed for a file's size. A file whose
// size can't be read counts nothing; a folder that can't be listed fails the whole count, as in TS.
func folderBytes(dir, skip string) (int64, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	var n int64
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		if p == skip {
			continue
		}
		if e.IsDir() {
			m, err := folderBytes(p, skip)
			if err != nil {
				return 0, err
			}
			n += m
			continue
		}
		if st, err := os.Stat(p); err == nil {
			n += st.Size()
		}
	}
	return n, nil
}

// origin is an imported skill's origin.json as Settings › Skills shows it, each field as text; nil when it doesn't
// read as an object.
func origin(dir string) *jsjson.Object {
	b, err := os.ReadFile(filepath.Join(dir, "origin.json"))
	if err != nil {
		return nil
	}
	v, err := jsjson.Parse(b)
	o, ok := v.(*jsjson.Object)
	if err != nil || !ok {
		return nil
	}
	field := func(key string, orEmpty bool) string {
		x, _ := o.Get(key)
		if orEmpty && x == nil {
			return ""
		}
		return jsjson.ToString(x)
	}
	return jsjson.NewObject("url", field("url", false), "path", field("path", true), "commit", field("commit", true), "date", field("date", true))
}

// Infos is skillInfos: every skill with what Settings › Skills shows. A harness reaches a skill natively when its
// skills folder holds it: Claude Code reads the user folder and stam's plugin, OpenCode and Codex the folders Link
// fills (STAM_HOME/opencode/skills and the agents folder), which are checked on disk.
func (p Paths) Infos() []Info {
	var out []Info
	for _, s := range p.Folders() {
		has := func(dir string) string {
			if exists(filepath.Join(dir, s.Name, "SKILL.md")) && real(filepath.Join(dir, s.Name)) == real(s.Path) {
				return "native"
			}
			return "unreachable"
		}
		file := filepath.Join(s.Path, "SKILL.md")
		text := ""
		if b, err := os.ReadFile(file); err == nil {
			text = string(b)
		}
		extra, err := folderBytes(s.Path, file)
		if err != nil {
			extra = 0
		}
		description, body := Parse(text)
		info := Info{Name: s.Name, Path: s.Path, Source: "stam", Description: description, Body: body,
			Tokens: int(math.Ceil(float64(len(text)) / 4)), ExtraTokens: int(math.Ceil(float64(extra) / 4)),
			Reaches: jsjson.NewObject("claude", "native", "opencode", has(p.opencodeDir()), "codex", has(p.Agents))}
		switch {
		case s.Source == "claude":
			info.Source = "user"
		case exists(filepath.Join(s.Path, "origin.json")):
			info.Source = "imported"
			info.Origin = origin(s.Path)
		}
		out = append(out, info)
	}
	return out
}

// isOurLink is a symlink stam made: it points straight at SOURCE/NAME, the name it has itself.
func (p Paths) isOurLink(path string) bool {
	st, err := os.Lstat(path)
	if err != nil || st.Mode()&fs.ModeSymlink == 0 {
		return false
	}
	to, err := os.Readlink(path)
	if err != nil {
		return false
	}
	for _, d := range p.sources() {
		if to == filepath.Join(d, filepath.Base(path)) {
			return true
		}
	}
	return false
}

func isLink(path string) bool {
	st, err := os.Lstat(path)
	return err == nil && st.Mode()&fs.ModeSymlink != 0
}

// Link is linkSkills: every skill linked into a harness's skills folder, replacing links stam made before. Only links
// into stam's skill folders are removed or replaced; a real file or someone else's link stays, and a skill of the same
// name is then left unlinked. A target that is, or sits inside, a source folder is left alone.
func (p Paths) Link(target string) error {
	if err := os.MkdirAll(target, 0o777); err != nil {
		return err
	}
	t := real(target)
	for _, d := range p.sources() {
		if rd := real(d); t == rd || strings.HasPrefix(t, rd+string(filepath.Separator)) {
			return nil
		}
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if path := filepath.Join(target, e.Name()); p.isOurLink(path) {
			if err := os.Remove(path); err != nil {
				return err
			}
		}
	}
	for _, s := range p.Folders() {
		path := filepath.Join(target, s.Name)
		if exists(path) || isLink(path) {
			continue
		}
		if err := os.Symlink(s.Path, path); err != nil {
			return err
		}
	}
	return nil
}

// Relink is relinkSkills without the Claude Code plugin: every harness's skills folder linked again after a skill was
// added or replaced (S-890). Errors are joined; each folder is tried.
func (p Paths) Relink() error {
	var errs []error
	for _, dir := range []string{p.opencodeDir(), p.Agents} {
		errs = append(errs, p.Link(dir))
	}
	return errors.Join(errs...)
}

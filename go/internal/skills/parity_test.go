package skills

import (
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// runTS runs testdata/skillref.mjs on input over p and returns what it prints.
func runTS(t *testing.T, p Paths, input map[string]any) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	input["home"], input["userHome"], input["agents"] = p.Home, p.UserHome, p.Agents
	in, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", "--no-warnings", "testdata/skillref.mjs")
	cmd.Stdin = bytes.NewReader(in)
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("skillref.mjs: %v", err)
	}
	return string(out)
}

// same fails with each Go and TS result side by side when the lists differ.
func same(t *testing.T, labels []string, goOut []jsjson.Value, tsOut string) {
	t.Helper()
	got := jsjson.Stringify(goOut, "")
	if got == tsOut {
		return
	}
	var w []json.RawMessage
	if err := json.Unmarshal([]byte(tsOut), &w); err != nil || len(w) != len(goOut) {
		t.Fatalf("Go and TS differ:\n go %s\n ts %s", got, tsOut)
	}
	for i, g := range goOut {
		if gs := jsjson.Stringify(g, ""); gs != string(w[i]) {
			t.Errorf("%s:\n go %s\n ts %s", labels[i], gs, w[i])
		}
	}
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func link(t *testing.T, target, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
}

func fail(err error) jsjson.Value {
	_, refused := err.(*ImportError)
	return jsjson.NewObject("error", err.Error(), "refused", refused)
}

// TestParseSourceMatchesTS: src/skill-import.ts parseSource over GitHub URLs, OWNER/REPO forms, file sources with and
// without allowFile, and the inputs it refuses.
func TestParseSourceMatchesTS(t *testing.T) {
	inputs := []string{"anthropics/skills", "anthropics/skills/document-skills/pdf", "https://github.com/anthropics/skills", "github.com/a/b.git/",
		"https://www.GitHub.com/a/b/tree/main/skills/x", "https://github.com/a/b/blob/v1.2/skills/x/SKILL.md", "https://github.com/a/b/blob/main/skills/x/README.md",
		"https://github.com/a/b/tree/feat%2Fx/s", "https://github.com/a/b/tree", "a/b/tree/main/x", "", "  a/b  ", "a b/c", "a/b?x=1", `a\b`,
		"http://github.com/a/b", "gitlab.com/a/b", "ssh:a/b", "a", "a/", "-a/b", "a/b/../c", "a/b//c/", "a/.hidden", strings.Repeat("a", 299) + "/b",
		"file:///r/x.git#skills/a@v1", "file:///r/x.git", "file:///r/x.git#a/../b", "file:///r/x.git#s@x#y"}
	var cases []map[string]any
	var labels []string
	var out []jsjson.Value
	for _, in := range inputs {
		for _, allow := range []bool{false, true} {
			if !allow && !strings.HasPrefix(in, "file://") && in != "a/b/tree/main/x" {
				continue
			}
			cases = append(cases, map[string]any{"input": in, "allowFile": allow})
		}
		if !strings.HasPrefix(in, "file://") && in != "a/b/tree/main/x" {
			cases = append(cases, map[string]any{"input": in, "allowFile": false})
		}
	}
	for _, c := range cases {
		labels = append(labels, jsjson.Stringify(c["input"], "")+" "+jsjson.Stringify(c["allowFile"], ""))
		s, err := ParseSource(c["input"].(string), c["allowFile"].(bool))
		if err != nil {
			out = append(out, fail(err))
			continue
		}
		o := jsjson.NewObject("url", s.URL, "path", s.Path)
		if s.Ref != "" {
			o.Set("ref", s.Ref)
		}
		out = append(out, o)
	}
	same(t, labels, out, runTS(t, Paths{Home: t.TempDir(), UserHome: t.TempDir(), Agents: t.TempDir()}, map[string]any{"op": "source", "cases": cases}))
}

// TestParseMatchesTS: src/instructions.ts parseSkill over plain, quoted, folded and missing descriptions, CRLF, and
// texts with no or an unclosed frontmatter.
func TestParseMatchesTS(t *testing.T) {
	texts := []string{"---\nname: a\ndescription: Does a.\n---\nBody\n", "---\r\ndescription: \"Quoted\"\r\n---\r\nB", "---\ndescription: >\n  folded\n  over lines\nname: x\n---\n",
		"---\ndescription: |-\n   kept\n\n   apart\n---", "---\ndescription:'single'\n---\n\nrest", "---\nname: n\n---\nno description", "no frontmatter",
		"---\ndescription: unclosed\n", "---\n\n---\nempty", "---\ndescription  :  spaced  \n  more\n---\n", "---\ndescription: \"\n---\n", "---\ndescription: x\n---\r"}
	var out []jsjson.Value
	for _, text := range texts {
		d, b := Parse(text)
		out = append(out, jsjson.NewObject("description", d, "body", b))
	}
	same(t, texts, out, runTS(t, Paths{Home: t.TempDir(), UserHome: t.TempDir(), Agents: t.TempDir()}, map[string]any{"op": "parse", "texts": texts}))
}

// TestStatsMatchesTS: src/skill-import.ts statsFromApi over trees within and past the caps, truncated, with a
// submodule, and answers that aren't trees.
func TestStatsMatchesTS(t *testing.T) {
	answers := []string{`{"tree":[{"type":"blob","size":10},{"type":"tree"}]}`, `{"tree":[],"truncated":true}`, `{"tree":[{"type":"commit"}]}`, `{}`, `{"tree":{}}`,
		`{"tree":[{"type":"blob","size":"5242881"}]}`, `{"tree":[{"type":"blob"},{"type":"blob","size":null}]}`, `{"tree":[` + strings.Repeat(`{"type":"blob","size":1},`, 300) + `{"type":"blob"}]}`}
	var parsed []jsjson.Value
	var out []jsjson.Value
	for _, a := range answers {
		v, err := jsjson.Parse([]byte(a))
		if err != nil {
			t.Fatal(err)
		}
		parsed = append(parsed, v)
		if err := StatsFromAPI(v); err != nil {
			out = append(out, fail(err))
		} else {
			out = append(out, nil)
		}
	}
	ts := runTS(t, Paths{Home: t.TempDir(), UserHome: t.TempDir(), Agents: t.TempDir()}, map[string]any{"op": "stats", "answers": json.RawMessage(jsjson.Stringify(parsed, ""))})
	// TS returns {files, bytes}; Go only whether the folder passes.
	ts = regexp.MustCompile(`\{"files":\d+,"bytes":\d+\}`).ReplaceAllString(ts, "null")
	same(t, answers, out, ts)
}

// git runs git in dir with a fixed identity and no global config.
func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func skillMD(name, description string) string {
	return "---\nname: " + name + "\ndescription: " + description + "\n---\nDo " + name + ".\n"
}

// repos makes the test's source repositories under dir: good (tidy, with a link inside it, and clash), bad (folders
// each import refuses) and rootskill (a skill at the root).
func repos(t *testing.T, dir string) {
	t.Helper()
	good := filepath.Join(dir, "good")
	write(t, filepath.Join(good, "README.md"), "good\n")
	write(t, filepath.Join(good, "skills", "tidy", "SKILL.md"), skillMD("tidy", "Tidy up scratch files."))
	write(t, filepath.Join(good, "skills", "tidy", "notes.md"), "notes\n")
	link(t, "notes.md", filepath.Join(good, "skills", "tidy", "alias.md"))
	write(t, filepath.Join(good, "skills", "clash", "SKILL.md"), skillMD("clash", "Clashes with a user skill."))
	bad := filepath.Join(dir, "bad")
	write(t, filepath.Join(bad, "README.md"), "bad\n")
	write(t, filepath.Join(bad, "skills", "escape", "SKILL.md"), skillMD("escape", "Escapes."))
	link(t, "../../README.md", filepath.Join(bad, "skills", "escape", "out.md"))
	write(t, filepath.Join(bad, "skills", "noname", "SKILL.md"), "no frontmatter\n")
	write(t, filepath.Join(bad, "skills", "mismatch", "SKILL.md"), skillMD("other", "Wrong name."))
	write(t, filepath.Join(bad, "skills", "nodesc", "SKILL.md"), "---\nname: nodesc\n---\n")
	write(t, filepath.Join(bad, "skills", "Upper", "SKILL.md"), skillMD("Upper", "Not lowercase."))
	root := filepath.Join(dir, "rootskill")
	write(t, filepath.Join(root, "SKILL.md"), skillMD("rootskill", "\"A skill at the root.\""))
	for _, r := range []string{good, bad, root} {
		git(t, r, "init", "-q")
		git(t, r, "add", "-A")
		git(t, r, "commit", "-qm", "first")
	}
}

// home makes a skills home under base: a user skill, a user skill tidy's clash collides with, and one of stam's own.
func home(t *testing.T, base string) Paths {
	t.Helper()
	p := Paths{Home: filepath.Join(base, "home"), UserHome: filepath.Join(base, "user"), Agents: filepath.Join(base, "agents")}
	write(t, filepath.Join(p.UserHome, ".claude", "skills", "style", "SKILL.md"), skillMD("style", "Write short."))
	write(t, filepath.Join(p.UserHome, ".claude", "skills", "clash", "SKILL.md"), skillMD("clash", "The user's own."))
	write(t, filepath.Join(p.Home, "skills", "own", "SKILL.md"), "---\ndescription: >\n  stam's own\n  skill\n---\nbody\n")
	write(t, filepath.Join(p.Home, "skills", "own", "ref", "more.md"), "12345678")
	// An update cut short: its old folder waits in a work folder, and a check left an empty one.
	write(t, filepath.Join(p.Home, ".skill-import-abc", "old-lost", "SKILL.md"), skillMD("lost", "Put back."))
	if err := os.MkdirAll(filepath.Join(p.Home, ".skill-check-xyz"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Someone else's link in the agents folder stays; a stale link of stam's is replaced.
	link(t, "/nowhere/else", filepath.Join(p.Agents, "theirs"))
	link(t, filepath.Join(p.Home, "skills", "gone"), filepath.Join(p.Agents, "gone"))
	return p
}

var isoDate = regexp.MustCompile(`"date":\s*"[^"]*"`)

// snapshot is every file, folder and link under the skill folders of p, with base written as BASE and dates masked.
func snapshot(t *testing.T, p Paths, base string) string {
	t.Helper()
	var b strings.Builder
	for _, dir := range []string{p.Dir(), p.opencodeDir(), p.Agents, p.Home} {
		_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(base, path)
			if dir == p.Home {
				// Only the home's top level: the work folders an import leaves or recovers.
				if path != dir && d.IsDir() && filepath.Dir(path) == dir && strings.HasPrefix(d.Name(), ".skill-") {
					b.WriteString(rel + "/\n")
				}
				if path != dir && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			switch {
			case d.Type()&fs.ModeSymlink != 0:
				to, _ := os.Readlink(path)
				b.WriteString(rel + " -> " + strings.ReplaceAll(to, base, "BASE") + "\n")
			case d.IsDir():
				b.WriteString(rel + "/\n")
			default:
				data, _ := os.ReadFile(path)
				b.WriteString(rel + ": " + isoDate.ReplaceAllString(string(data), `"date":"D"`) + "\n")
			}
			return nil
		})
	}
	return b.String()
}

// goSteps is skillref.mjs's steps op on Go's side, with a fresh importer as a fresh process has.
func goSteps(p Paths, steps []map[string]string) []jsjson.Value {
	im := NewImporter(p, true)
	var out []jsjson.Value
	for _, s := range steps {
		switch s["fn"] {
		case "import", "update":
			var r Imported
			var err error
			if s["fn"] == "import" {
				r, err = im.Import(context.Background(), s["source"])
			} else {
				r, err = im.Update(context.Background(), s["name"])
			}
			if err != nil {
				out = append(out, fail(err))
			} else {
				out = append(out, jsjson.NewObject("name", r.Name, "path", r.Path, "commit", r.Commit, "updated", r.Updated))
			}
		case "check":
			out = append(out, im.CheckUpdate(context.Background(), s["name"]))
		case "recover":
			p.Recover()
			out = append(out, nil)
		case "relink":
			_ = p.Relink()
			out = append(out, nil)
		case "infos":
			list := []jsjson.Value{}
			for _, i := range p.Infos() {
				list = append(list, i.JSON("body", i.Body))
			}
			out = append(out, list)
		}
	}
	return out
}

// TestImportMatchesTS: src/skill-import.ts and src/instructions.ts over one script of imports, updates, update checks,
// the recovery of a cut-short update, relinking and the skill list, against local repositories that move between
// phases: Go's results and the skill folders it leaves match TS's, step by step.
func TestImportMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	base := t.TempDir()
	repoDir := filepath.Join(base, "repos")
	repos(t, repoDir)
	src := func(repo, path string) string { return "file://" + filepath.Join(repoDir, repo) + "#" + path }
	tsBase, goBase := filepath.Join(base, "ts"), filepath.Join(base, "go")
	tsHome, goHome := home(t, tsBase), home(t, goBase)
	phases := [][]map[string]string{{
		{"fn": "recover"},
		{"fn": "import", "source": src("good", "skills/tidy")},
		{"fn": "import", "source": src("good", "skills/tidy")},
		{"fn": "import", "source": src("good", "skills/missing")},
		{"fn": "import", "source": src("bad", "skills/escape")},
		{"fn": "import", "source": src("bad", "skills/noname")},
		{"fn": "import", "source": src("bad", "skills/mismatch")},
		{"fn": "import", "source": src("bad", "skills/nodesc")},
		{"fn": "import", "source": src("bad", "skills/Upper")},
		{"fn": "import", "source": "file://" + filepath.Join(repoDir, "rootskill")},
		{"fn": "import", "source": src("good", "skills/clash")},
		{"fn": "import", "source": "https://gitlab.com/a/b"},
		{"fn": "check", "name": "tidy"},
		{"fn": "check", "name": "nothere"},
		{"fn": "update", "name": "tidy"},
		{"fn": "update", "name": "Bad Name"},
		{"fn": "update", "name": "own"},
		{"fn": "relink"},
		{"fn": "infos"},
	}, {
		{"fn": "check", "name": "tidy"},
		{"fn": "check", "name": "tidy"},
	}, {
		{"fn": "check", "name": "tidy"},
		{"fn": "update", "name": "tidy"},
		{"fn": "infos"},
	}}
	moves := []func(){
		// Only a file outside tidy changes: the check remembers the head as seen.
		func() {
			write(t, filepath.Join(repoDir, "good", "README.md"), "moved\n")
			git(t, filepath.Join(repoDir, "good"), "commit", "-qam", "readme")
		},
		// tidy itself changes: the check says it moved.
		func() {
			write(t, filepath.Join(repoDir, "good", "skills", "tidy", "notes.md"), "new notes\n")
			git(t, filepath.Join(repoDir, "good"), "commit", "-qam", "tidy")
		},
	}
	// What each phase's TS output must hold, so a case that stopped reaching its path doesn't pass by matching.
	wants := [][]string{{`"updated":false`, `"updated":true`, `no folder \"skills/missing\" in the repository`, "points outside the skill folder",
		"SKILL.md has no frontmatter", `must match its folder`, "needs a description", "must be lowercase letters", `"name":"rootskill"`,
		`already have a skill called \"clash\" in ~/.claude/skills`, "only github.com sources", `{"moved":false,"commit":"`, `"error":"no origin"`,
		"not a skill name", "was not imported", `"source":"imported","origin":{"url":"file://`, `"name":"lost"`},
		{`{"moved":false,"commit":"`}, {`{"moved":true,"commit":"`, `"updated":true`}}
	for i, steps := range phases {
		if i > 0 {
			moves[i-1]()
		}
		ts := runTS(t, tsHome, map[string]any{"op": "steps", "steps": steps})
		for _, w := range wants[i] {
			if !strings.Contains(ts, w) {
				t.Errorf("phase %d: TS's output lacks %s: %s", i, w, ts)
			}
		}
		ts = isoDate.ReplaceAllString(strings.ReplaceAll(ts, tsBase, "BASE"), `"date":"D"`)
		goOut := isoDate.ReplaceAllString(strings.ReplaceAll(jsjson.Stringify(goSteps(goHome, steps), ""), goBase, "BASE"), `"date":"D"`)
		var labels []string
		for _, s := range steps {
			labels = append(labels, jsjson.Stringify(jsjson.NewObject("phase", i, "fn", s["fn"], "arg", s["source"]+s["name"]), ""))
		}
		v, _ := jsjson.Parse([]byte(goOut))
		list, _ := v.([]jsjson.Value)
		same(t, labels, list, ts)
		a, b := snapshot(t, tsHome, tsBase), snapshot(t, goHome, goBase)
		if a != b {
			t.Errorf("phase %d's folders:\n go:\n%s\n ts:\n%s", i, b, a)
		}
		if i == 1 && !strings.Contains(a, `"seen": "`) {
			t.Errorf("the check didn't remember the head it saw:\n%s", a)
		}
	}
}

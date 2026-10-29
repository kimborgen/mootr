package instructions

import (
	"io"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"stam/internal/config"
	"stam/internal/search"
)

// The Instructions view's parts against src/agent-instructions.ts (testdata/partsref.mjs on the same home), in two
// homes:
//   - "full": a chief of staff with a skilled type, an assistant on Codex, and a developer on OpenCode whose lessons
//     are warmed and who owns an ITSA. It has instruction files the harnesses load and skip, user-global ones, a
//     native file that isn't valid UTF-8 and one past the 50,000-unit cap, the instructions for all agents, skill
//     folders in both homes, a restricted model, and MCP servers with disabled, null, index-like and "stam" entries.
//   - "override": a system-prompt template that reorders, repeats and leaves out placeholders, MCP servers as an
//     array, and no skills.

var partsAgents = []string{"chief", "asst", "dev", "mgr"}

func TestInstructionPartsMatchTS(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	t.Run("full", func(t *testing.T) {
		runParts(t, "full", `{"chiefOfStaff":"chief","humanMail":{"models":{"cheap-model":false}},`+
			`"mcpServers":{"zeta":{"command":"z"},"2":{"command":"two"},"off":{"command":"o","enabled":false},"nul":null,"stam":{"command":"s"},"alpha":{"url":"http://a"}}}`)
	})
	t.Run("override", func(t *testing.T) {
		runParts(t, "override", `{"mcpServers":[{"command":"x"},null,{"command":"y","enabled":false}]}`)
	})
}

// partsHome is the home of a parts case ("full" or "override"; see TestInstructionPartsMatchTS) with its agents, and
// dev's lessons warmed. registry is the types JSON of registry.json, after the skilled type.
func partsHome(t *testing.T, name, settings, registry string) *testHome {
	h := newTestHome(t, settings)
	h.p.Index = search.New(h.db, func() search.Provider { return search.Stub })
	seedLesson(h)
	write(t, filepath.Join(h.home, "registry.json"), `{"types":{"skilled":{"description":"d","harness":"claude","skills":["s-one","s-gone"]}`+registry+`}}`)

	// A repo under the user home: proj is its root, the agents work in proj/sub.
	proj := filepath.Join(h.userHome, "proj")
	sub := filepath.Join(proj, "sub")
	write(t, filepath.Join(sub, "child", "CLAUDE.md"), "child\n")
	if out, err := exec.Command("git", "init", "-q", proj).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	if name == "full" {
		write(t, filepath.Join(h.home, "instructions.md"), "  All agents: be kind.\n\n")
		// Ill-formed UTF-8: a cut 3-byte and 4-byte sequence, a stray byte, a surrogate's encoding and an overlong one.
		write(t, filepath.Join(proj, "CLAUDE.md"), "# Repo\nok \xe2\x82 x \xf0\x9f\x98 y \xff \xed\xa0\x80 z \xc0\xaf end \xf4\x90\x80\x80\n")
		write(t, filepath.Join(proj, "AGENTS.md"), "agents at the root\n")
		write(t, filepath.Join(sub, "CLAUDE.local.md"), strings.Repeat("a", 49_998)+"é"+"\U0001F600 past the cap\n")
		write(t, filepath.Join(sub, "AGENTS.md"), "agents here\n")
		write(t, filepath.Join(h.userHome, ".claude", "CLAUDE.md"), "user global claude\n")
		write(t, filepath.Join(h.userHome, ".codex", "AGENTS.md"), "user global codex\n")
		write(t, filepath.Join(h.home, "skills", "s-one", "SKILL.md"), "---\ndescription: One skill\n---\n")
		write(t, filepath.Join(h.home, "skills", "no-skill-md", "README.md"), "not a skill\n")
		write(t, filepath.Join(h.userHome, ".claude", "skills", "s-one", "SKILL.md"), "---\ndescription: the user's own\n---\n")
		write(t, filepath.Join(h.userHome, ".claude", "skills", "Zed", "SKILL.md"), "---\ndescription: z\n---\n")
		write(t, filepath.Join(h.userHome, ".claude", "skills", "\u00e9t\u00e9", "SKILL.md"), "---\ndescription: e\n---\n")
		write(t, filepath.Join(h.userHome, ".claude", "skills", "\U0001F600", "SKILL.md"), "---\ndescription: smile\n---\n")
		write(t, filepath.Join(h.userHome, ".claude", "skills", "\uFF5E", "SKILL.md"), "---\ndescription: tilde\n---\n")
	} else {
		write(t, filepath.Join(h.home, "templates", "system-prompt.md"), "Head for {{name}} on {{machine}}.\n\n{{role}}\n\n  \n{{instructions}}{{human_mail}}\nMiddle text.\n{{role}}{{unknown}}\n\nTail.\n")
		write(t, filepath.Join(sub, "AGENTS.md"), "agents here\n")
	}

	h.agent("chief", map[string]any{"lifecycle": "active", "type": "skilled", "cwd": sub, "model": "cheap-model", "first_prompt": "Run the team."})
	h.agent("asst", map[string]any{"lifecycle": "active", "kind": "assistant", "harness": "codex", "cwd": sub, "role": ""})
	h.agent("dev", map[string]any{"lifecycle": "active", "type": "developer", "harness": "opencode", "role": "go parity", "parent_id": "chief", "model": "claude-opus-5-5"})
	h.agent("mgr", map[string]any{"lifecycle": "active", "type": "manager", "cwd": proj, "parent_id": "chief"})
	at := "2026-01-02T00:00:00Z"
	h.sql("INSERT INTO itsas (id, key, kind, title, status, owner, created_by, created_at, updated_at) VALUES ('i1', 'S-9', 'issue', 'Parts', 'in_progress', 'dev', 'human', ?, ?)", at, at)

	dev, err := h.db.GetAgent(h.ctx, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if text := h.p.WarmLessons(h.ctx, dev); !strings.Contains(text, "S-2") {
		t.Fatalf("dev's warmed lessons: %q", text)
	}
	return h
}

func runParts(t *testing.T, name, settings string) {
	h := partsHome(t, name, settings, "")
	var want struct {
		Agents map[string][]Part `json:"agents"`
	}
	h.ts("testdata/partsref.mjs", map[string]any{"agents": partsAgents, "warm": []string{"dev"}}, &want)
	for _, id := range partsAgents {
		a, err := h.db.GetAgent(h.ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		got, err := h.p.AgentInstructionParts(h.ctx, a)
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		if !reflect.DeepEqual(got, want.Agents[id]) {
			t.Errorf("%s: parts differ from TS", id)
			for i := 0; i < max(len(got), len(want.Agents[id])); i++ {
				var g, w Part
				if i < len(got) {
					g = got[i]
				}
				if i < len(want.Agents[id]) {
					w = want.Agents[id][i]
				}
				if g != w {
					t.Errorf("  part %d:\n    go: %+.300v\n    ts: %+.300v", i, g, w)
				}
			}
		}
	}

	// The cases reach what they are meant to.
	labels := func(id string) map[string]Part {
		m := map[string]Part{}
		for _, p := range want.Agents[id] {
			m[p.Label] = p
		}
		return m
	}
	dl, cl := labels("dev"), labels("chief")
	if name == "full" {
		if !strings.Contains(dl["Lessons from similar work"].Text, "S-2") || !strings.Contains(dl["ITSAs"].Text, "S-9") {
			t.Errorf("dev's lessons or ITSA part is missing: %q, %q", dl["Lessons from similar work"].Text, dl["ITSAs"].Text)
		}
		if cl["Org"].Origin != "chief-of-staff" || labels("asst")["Org"].Origin != "assistant" || cl["Mail to your user"].Origin != "mail-to-human-restricted" {
			t.Errorf("origins: chief org %q, assistant org %q, chief mail %q", cl["Org"].Origin, labels("asst")["Org"].Origin, cl["Mail to your user"].Origin)
		}
		if _, ok := cl["Skills available"]; !ok {
			t.Error("chief has no Skills available part")
		}
		if cl["MCP servers"].Text != "- 2\n- zeta\n- stam\n- alpha" {
			t.Errorf("MCP servers: %q", cl["MCP servers"].Text)
		}
		if p := cl["CLAUDE.local.md"]; utf16Len(p.Text) != partFileLimit {
			t.Errorf("CLAUDE.local.md is %d units, want the %d cap", utf16Len(p.Text), partFileLimit)
		}
		if !strings.Contains(cl["CLAUDE.md"].Text, "\uFFFD") {
			t.Error("the ill-formed CLAUDE.md has no replacement character")
		}
	} else if want.Agents["chief"][0].Text != "Head for chief-name on test-machine." {
		t.Errorf("override's first part: %+v", want.Agents["chief"][0])
	}
}

// decodePrefix replaces each maximal subpart of an ill-formed sequence with one U+FFFD, as Node's decoder does, and
// cuts at the limit as String.slice does.
func TestDecodePrefix(t *testing.T) {
	decode := func(in string, limit int) string {
		t.Helper()
		got, err := decodePrefix(strings.NewReader(in), limit)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	for in, want := range map[string]string{
		"ok":                     "ok",
		"a\xe2\x82b":             "a\uFFFDb",
		"a\xf0\x9f\x98":          "a\uFFFD",
		"\xff\xfe":               "\uFFFD\uFFFD",
		"\xed\xa0\x80":           "\uFFFD\uFFFD\uFFFD",
		"\xc0\xaf":               "\uFFFD\uFFFD",
		"\xe0\x80\x80":           "\uFFFD\uFFFD\uFFFD",
		"\xf4\x90\x80\x80":       "\uFFFD\uFFFD\uFFFD\uFFFD",
		"\xe2\x82\xac\xe2\x82":   "\u20AC\uFFFD",
		"\xf0\x9f\x98\x80\x80x":  "\U0001F600\uFFFDx",
		"\xef\xbb\xbfBOM kept\n": "\uFEFFBOM kept\n",
	} {
		if got := decode(in, 1<<20); got != want {
			t.Errorf("decodePrefix(%q) = %q, want %q", in, got, want)
		}
	}
	// At the limit: a cut between a surrogate pair's halves, an ill-formed subpart as the last unit, and a limit past
	// the text.
	for _, c := range []struct {
		in    string
		limit int
		want  string
	}{
		{"ab\U0001F600c", 3, "ab�"},
		{"ab\U0001F600c", 4, "ab\U0001F600"},
		{"a\xe2\x82b", 2, "a�"},
		{"abc", 10, "abc"},
		{"", 5, ""},
	} {
		if got := decode(c.in, c.limit); got != c.want {
			t.Errorf("decodePrefix(%q, %d) = %q, want %q", c.in, c.limit, got, c.want)
		}
	}
	// Across a refill of bufio's 4096-byte buffer: an ill-formed sequence that starts in the last byte, and the cap on
	// its replacement unit.
	ascii := strings.Repeat("a", 4095)
	if got := decode(ascii+"\xe2\x82b", 1<<20); got != ascii+"�b" {
		t.Errorf("an ill-formed sequence across a refill: ...%q", got[len(got)-min(len(got), 8):])
	}
	if got := decode(ascii+"\xe2\x82b", 4096); got != ascii+"�" {
		t.Errorf("the cap on a replacement across a refill: ...%q", got[len(got)-min(len(got), 8):])
	}
	// A reader that hands out 1 to 3 bytes at a time splits every sequence; the output is the same.
	in := "xé\U0001F600\xe2\x82b\xf0\x9f\x98 \xed\xa0\x80€" + strings.Repeat("\U0001F600é", 50)
	want := decode(in, 1<<20)
	if !strings.HasPrefix(want, "xé\U0001F600�b� ���€") {
		t.Fatalf("the whole reader gives %q", want)
	}
	got, err := decodePrefix(&chunkReader{s: in}, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("1-3 byte reads give %q, want %q", got, want)
	}
}

// chunkReader hands out 1, 2, 3, 1, 2, 3, ... bytes per Read.
type chunkReader struct {
	s string
	i int
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if c.s == "" {
		return 0, io.EOF
	}
	c.i++
	n := min(c.i%3+1, len(c.s), len(p))
	copy(p, c.s[:n])
	c.s = c.s[n:]
	return n, nil
}

// countingReader counts the bytes read through it.
type countingReader struct {
	io.ReadCloser
	n *int
}

func (c countingReader) Read(p []byte) (int, error) {
	n, err := c.ReadCloser.Read(p)
	*c.n += n
	return n, err
}

// readText stops reading at the cap: a 4 MB file costs about the cap's bytes, not the file's.
func TestReadTextStopsAtCap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "CLAUDE.md")
	write(t, path, strings.Repeat("a", 4<<20))
	read := 0
	orig := openText
	openText = func(p string) (io.ReadCloser, error) {
		f, err := orig(p)
		return countingReader{f, &read}, err
	}
	t.Cleanup(func() { openText = orig })
	if got := readText(path); len(got) != partFileLimit {
		t.Errorf("readText gave %d characters, want %d", len(got), partFileLimit)
	}
	// bufio reads ahead by at most its 4096-byte buffer.
	if read > partFileLimit+4096 {
		t.Errorf("readText read %d bytes of a 4 MB file for a %d-unit cap", read, partFileLimit)
	}
}

// Deliberate difference (S-3868): an MCP server named __proto__ is listed. TS loses it to prototype pollution when
// settings are merged; Go keeps it.
func TestExtraMcpServersKeepsProto(t *testing.T) {
	s, err := config.ParseSettings([]byte(`{"mcpServers":{"__proto__":{"command":"p"},"a":{"command":"a"}}}`), "test-machine")
	if err != nil {
		t.Fatal(err)
	}
	p := &Prompts{Settings: func() config.Settings { return s }}
	if got := p.extraMcpServers(); !reflect.DeepEqual(got, []string{"__proto__", "a"}) {
		t.Errorf("extraMcpServers = %q", got)
	}
}

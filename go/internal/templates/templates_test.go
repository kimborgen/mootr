package templates

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// repoRoot is the checkout this test runs in: its templates/, blocks/ and registry/ are what both sides render.
func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

// fixture is a test home with a template override, registry types that compose blocks, settings and instructions.md,
// and a fake user home holding the harnesses' global files and a git repo with instruction files at several depths.
type fixture struct {
	home, userHome, repo string
	set                  *Set
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	base := t.TempDir()
	f := fixture{home: filepath.Join(base, "home"), userHome: filepath.Join(base, "user")}
	f.repo = filepath.Join(f.userHome, "proj")
	write(t, filepath.Join(f.home, "settings.json"), `{"humanMail": {"when": "important", "models": {"m-restricted": false, "m-ok": true, "bad": "x"}}}`)
	write(t, filepath.Join(f.home, "templates", "retro-reminder.md"), "  {{x}} override {{y}} {{x}} {{ x }}\n\n")
	write(t, filepath.Join(f.home, "instructions.md"), "\n  Be kind to the tests.\n\n")
	write(t, filepath.Join(f.home, "registry.json"), `{"types": {
		"developer": {"blocks": {"off": ["stam-mcp-and-trust", 3], "order": ["mail-conventions", "prompt-intro", "mail-conventions"],
			"replace": {"ask-permission": "blocks/system-prompt/50-waiting.md", "waiting-and-subscribing": "/etc/passwd", "shared-machine": ""}}},
		"emptyblocks": {"blocks": {}},
		"badblocks": {"blocks": {"off": "x", "replace": [], "order": 5}},
		"mytype": {},
		"manager": null
	}}`)
	write(t, filepath.Join(f.userHome, ".claude", "CLAUDE.md"), "claude global\n")
	write(t, filepath.Join(f.userHome, ".codex", "AGENTS.md"), "codex global\n")
	for _, p := range []string{"CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", "sub/AGENTS.md", "sub/deep/CLAUDE.local.md", "sub/deep/deeper/AGENTS.md",
		"node_modules/x/AGENTS.md", ".hidden/AGENTS.md", "other/CLAUDE.md"} {
		write(t, filepath.Join(f.repo, p), "x\n")
	}
	write(t, filepath.Join(f.userHome, "plain", "dir", "AGENTS.md"), "x\n")
	write(t, filepath.Join(f.userHome, "plain", "CLAUDE.md"), "x\n")
	// The test folder may sit inside a checkout: git must not find it above the fixture.
	t.Setenv("GIT_CEILING_DIRECTORIES", base)
	if out, err := exec.Command("git", "init", "-q", f.repo).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	f.set = &Set{Root: repoRoot(t), Home: f.home, UserHome: f.userHome, Settings: func() config.Settings {
		b, _ := os.ReadFile(filepath.Join(f.home, "settings.json"))
		s, err := config.ParseSettings(b, "test-machine")
		if err != nil {
			t.Fatal(err)
		}
		return s
	}}
	return f
}

type request struct {
	Fn      string            `json:"fn"`
	Name    string            `json:"name,omitempty"`
	Vars    map[string]string `json:"vars,omitempty"`
	Type    string            `json:"type,omitempty"`
	Model   *string           `json:"model"`
	Harness string            `json:"harness,omitempty"`
	Cwd     string            `json:"cwd,omitempty"`
}

type result struct {
	Text  *string `json:"text"`
	Error *string `json:"error"`
}

// tsRender runs the requests through the TS daemon's code (testdata/ts-render.mjs).
func tsRender(t *testing.T, f fixture, reqs []request) []result {
	t.Helper()
	in, _ := json.Marshal(reqs)
	cmd := exec.Command("node", "testdata/ts-render.mjs", f.home, f.userHome)
	cmd.Stdin = strings.NewReader(string(in))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ts-render.mjs: %v\n%s", err, stderr.String())
	}
	var res []result
	if err := json.Unmarshal(out, &res); err != nil {
		t.Fatalf("ts-render.mjs output: %v", err)
	}
	if len(res) != len(reqs) {
		t.Fatalf("ts-render.mjs: %d results for %d requests", len(res), len(reqs))
	}
	return res
}

func (f fixture) goRender(r request) (string, error) {
	switch r.Fn {
	case "render":
		return f.set.Render(r.Name, r.Vars, r.Type)
	case "humanMail":
		return f.set.HumanMailPrompt(r.Model, r.Type)
	case "instructions":
		return f.set.InstructionsPrompt(context.Background(), r.Harness, r.Cwd)
	}
	panic(r.Fn)
}

// TestRenderMatchesTS renders every shipped template, for several agent types and with the system prompt's slots
// filled, plus the human-mail rules and the instructions section, on both sides, and wants the same bytes or both an
// error.
func TestRenderMatchesTS(t *testing.T) {
	f := newFixture(t)
	root := repoRoot(t)
	var names []string
	files, _ := os.ReadDir(filepath.Join(root, "templates"))
	for _, e := range files {
		if n, ok := strings.CutSuffix(e.Name(), ".md"); ok {
			names = append(names, n)
		}
	}
	dirs, _ := os.ReadDir(filepath.Join(root, "blocks"))
	for _, e := range dirs {
		names = append(names, e.Name())
	}
	names = append(names, "type-mytype", "type-emptyblocks", "type-nosuch", "nosuch", "_replace", "../templates/workspace")
	vars := map[string]string{"id": "a1", "name": "dev-1", "machine": "test-machine", "role": "developer", "org": "ORG $1 $& {{id}}",
		"instructions": "INSTR", "cost": "", "retro": "RETRO", "lessons": "LESSONS", "workspace": "WS", "itsa": "ITSA",
		"requirements": "REQ", "human_mail": "HM", "x": "X", "y": "\u00a0Y\ufeff"}
	types := []string{"", "developer", "emptyblocks", "badblocks", "mytype", "manager", "reviewer", "nosuchtype"}
	var reqs []request
	for _, n := range names {
		for _, ty := range types {
			reqs = append(reqs, request{Fn: "render", Name: n, Vars: vars, Type: ty})
		}
	}
	model := func(s string) *string { return &s }
	for _, m := range []*string{nil, model(""), model("m-restricted"), model("m-ok"), model("claude-haiku-5-5"), model("bad"), model("other")} {
		for _, ty := range []string{"", "developer"} {
			reqs = append(reqs, request{Fn: "humanMail", Model: m, Type: ty})
		}
	}
	for _, h := range []string{"claude", "codex", "opencode", "other"} {
		for _, cwd := range []string{f.repo, filepath.Join(f.repo, "sub"), filepath.Join(f.repo, "sub", "deep"), filepath.Join(f.userHome, "plain", "dir"), filepath.Join(f.userHome, "missing")} {
			reqs = append(reqs, request{Fn: "instructions", Harness: h, Cwd: cwd})
		}
	}
	want := tsRender(t, f, reqs)
	ok := 0
	for i, r := range reqs {
		got, err := f.goRender(r)
		w := want[i]
		switch {
		case w.Error != nil && err == nil:
			t.Errorf("%+v: TS failed (%s), Go rendered %q", r, *w.Error, got)
		case w.Error == nil && err != nil:
			t.Errorf("%+v: Go failed (%v), TS rendered %q", r, err, *w.Text)
		case w.Error != nil && err.Error() != *w.Error:
			t.Errorf("%+v: errors differ:\n  go %v\n  ts %s", r, err, *w.Error)
		case w.Error == nil && got != *w.Text:
			t.Errorf("%+v: differs:\n--- go\n%s\n--- ts\n%s", r, got, *w.Text)
		case w.Error == nil:
			ok++
		}
	}
	// Guard against a fixture that renders nothing: most requests must produce text.
	if ok < len(reqs)/2 {
		t.Fatalf("only %d of %d requests rendered text", ok, len(reqs))
	}
}

// TestMemoryBlockJoin covers what no shipped block exercises yet (S-888): a memory block starts a paragraph of its own
// in BlocksText, and a type's composition joins bodies verbatim.
func TestMemoryBlockJoin(t *testing.T) {
	root := t.TempDir()
	block := func(id, kind, body string) string {
		return "---\nid: " + id + "\ntitle: T\nsummary: |\n  one\n  two\nscope: global\nkind: " + kind + "\nsummary_of: x\n---\n" + body
	}
	write(t, filepath.Join(root, "blocks", "type-x", "10-a.md"), block("a", "rule", "first\n"))
	write(t, filepath.Join(root, "blocks", "type-x", "20-b.md"), block("b", "rule", "second"))
	write(t, filepath.Join(root, "blocks", "type-x", "99-memory.md"), block("m", "memory", "remember\n"))
	write(t, filepath.Join(root, "blocks", "type-x", "notes.txt"), "ignored")
	s := &Set{Root: root}
	got, err := s.BlocksText("type-x")
	if err != nil || got != "first\nsecond\n\nremember\n" {
		t.Fatalf("BlocksText = %q, %v", got, err)
	}
	b, _ := s.BlocksOf("type-x")
	if b[0].Summary != "one\ntwo" || b[2].Kind != "memory" {
		t.Fatalf("blocks %+v", b)
	}
	got, err = s.ComposedText("type-x", mustParse(t, `{"order": ["m"]}`))
	if err != nil || got != "remember\nfirst\nsecond" {
		t.Fatalf("ComposedText = %q, %v", got, err)
	}
	write(t, filepath.Join(root, "blocks", "bad", "10.md"), "---\nid: x\n---\nbody")
	if _, err := s.BlocksText("bad"); err == nil || !strings.Contains(err.Error(), "no title") {
		t.Fatalf("a block without a title: %v", err)
	}
}

func mustParse(t *testing.T, doc string) jsjson.Value {
	t.Helper()
	v, err := jsjson.Parse([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

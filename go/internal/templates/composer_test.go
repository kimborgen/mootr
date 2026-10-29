package templates

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// TestComposerMatchesTS: src/inventory.ts composerCatalog over the shipped blocks, with a whole-file override that
// stops a template rendering from its blocks, and types whose model may or may not mail the human, on its own harness
// and on another.
func TestComposerMatchesTS(t *testing.T) {
	f := newFixture(t)
	write(t, filepath.Join(f.home, "templates", "retro.md"), "whole retro\n")
	write(t, filepath.Join(f.home, "registry.json"), `{"types": {
		"quiet": {"harness": "claude", "model": "m-restricted"},
		"loud": {"harness": "codex", "model": "m-ok"},
		"plain": {"harness": "claude"}
	}}`)
	cases := []request{{Fn: "composer"}, {Fn: "composer", Type: "quiet"}, {Fn: "composer", Type: "quiet", Harness: "claude"}, {Fn: "composer", Type: "quiet", Harness: "codex"},
		{Fn: "composer", Type: "loud"}, {Fn: "composer", Type: "plain", Harness: "opencode"}}
	ts := tsRender(t, f, cases)
	settings := f.set.Settings()
	mayMail := func(model jsjson.Value) bool {
		if !jsjson.Truthy(model) {
			return true
		}
		ok, set := settings.HumanMail.Models[jsjson.ToString(model)]
		return !set || ok
	}
	types, _ := f.set.Registry().Get("types")
	for i, c := range cases {
		var typ *jsjson.Object
		if c.Type != "" {
			v, _ := types.(*jsjson.Object).Get(c.Type)
			typ = v.(*jsjson.Object)
		}
		out, err := f.set.ComposerCatalog(typ, c.Harness, mayMail)
		if err != nil {
			t.Fatal(err)
		}
		got := jsjson.Stringify(out, "")
		if ts[i].Text == nil || got != *ts[i].Text {
			t.Errorf("%+v:\n go %s\n ts %v", c, got, ts[i].Text)
		}
		if i == 1 && (!strings.Contains(got, `"template":"retro","rendered":false`) || !strings.Contains(got, `"template":"mail-to-human","rendered":true,"applies":false`)) {
			t.Errorf("the restricted type: %s", got)
		}
	}
}

// TestComposerReplacements: the replacement files are the usable block files under blocks/_replace, by name; a file
// that isn't a block, or a symlink out of blocks/, is left out.
func TestComposerReplacements(t *testing.T) {
	root := t.TempDir()
	block := func(id string) string {
		return "---\nid: " + id + "\ntitle: T " + id + "\nsummary: |\n  two\n  lines\nscope: all\nkind: rule\nsummary_of: x\n---\nbody " + id + "\n\n\n"
	}
	write(t, filepath.Join(root, "blocks", "_replace", "b.md"), block("rb"))
	write(t, filepath.Join(root, "blocks", "_replace", "a.md"), block("ra"))
	write(t, filepath.Join(root, "blocks", "_replace", "notes.txt"), block("rx"))
	write(t, filepath.Join(root, "blocks", "_replace", "bad.md"), "no frontmatter\n")
	write(t, filepath.Join(root, "outside.md"), block("ro"))
	if err := os.Symlink(filepath.Join(root, "outside.md"), filepath.Join(root, "blocks", "_replace", "c.md")); err != nil {
		t.Fatal(err)
	}
	s := &Set{Root: root, Home: t.TempDir()}
	out, err := s.ComposerCatalog(nil, "", func(jsjson.Value) bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	want := `{"blocks":[],"replacements":[{"path":"blocks/_replace/a.md","id":"ra","title":"T ra","summary":"two lines","tokens":2},{"path":"blocks/_replace/b.md","id":"rb","title":"T rb","summary":"two lines","tokens":2}]}`
	if got := jsjson.Stringify(out, ""); got != want {
		t.Errorf("got %s\nwant %s", got, want)
	}
}

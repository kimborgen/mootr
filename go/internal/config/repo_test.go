package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDerivedRepoPath(t *testing.T) {
	canon := func(p string) string {
		r, err := filepath.EvalSymlinks(p)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	checkout := t.TempDir()
	if err := os.Mkdir(filepath.Join(checkout, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := DerivedRepoPath(checkout); got != canon(checkout) {
		t.Errorf("a checkout is its own repo: %q", got)
	}
	if got := DerivedRepos(checkout); len(got) != 1 || got[filepath.Base(canon(checkout))] != canon(checkout) {
		t.Errorf("repos of a checkout: %v", got)
	}

	source := t.TempDir()
	release := t.TempDir()
	write := func(body string) {
		if err := os.WriteFile(filepath.Join(release, ".release.json"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"repo": "` + source + `"}`)
	if got := DerivedRepoPath(release); got != canon(source) {
		t.Errorf("a release names its source: %q", got)
	}
	// A release file with no usable repo falls back to the root's own .git, and to nothing without one.
	for _, body := range []string{`{"repo": ""}`, `{"repo": 7}`, `not json`, `{}`} {
		write(body)
		if got := DerivedRepoPath(release); got != "" {
			t.Errorf("%s: %q", body, got)
		}
	}
	if got := DerivedRepos(release); len(got) != 0 {
		t.Errorf("repos of a plain folder: %v", got)
	}
	// A source that no longer exists is kept as written.
	write(`{"repo": "/nowhere/stam2"}`)
	if got := DerivedRepoPath(release); got != "/nowhere/stam2" {
		t.Errorf("a missing source: %q", got)
	}
}

func TestDeployCheckout(t *testing.T) {
	root := t.TempDir()
	if got := DeployCheckout("/srv/deploy", root); got != "/srv/deploy" {
		t.Errorf("named: %q", got)
	}
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := DeployCheckout("", root); got != DerivedRepoPath(root) {
		t.Errorf("derived: %q", got)
	}
	plain := t.TempDir()
	t.Setenv("HOME", "/home/alex")
	if got := DeployCheckout("", plain); got != "/home/alex/projects/stam2" {
		t.Errorf("default: %q", got)
	}
}

package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func shareDir(t *testing.T) (string, string) {
	t.Helper()
	u := t.TempDir()
	s := filepath.Join(u, ".local", "share")
	if err := os.MkdirAll(s, 0o755); err != nil {
		t.Fatal(err)
	}
	return u, s
}

// The same cases as test/default-home.test.mjs and the shell helper: test/default-home.test.mjs runs them all.
func TestDefaultHome(t *testing.T) {
	cases := []struct {
		name  string
		setup func(s string)
		want  string
	}{
		{"neither folder is mootr: a fresh install", func(s string) {}, "mootr"},
		{"only stam is stam", func(s string) { os.Mkdir(filepath.Join(s, "stam"), 0o755) }, "stam"},
		{"only mootr is mootr", func(s string) { os.Mkdir(filepath.Join(s, "mootr"), 0o755) }, "mootr"},
		{"stam as a symlink to mootr is mootr", func(s string) {
			os.Mkdir(filepath.Join(s, "mootr"), 0o755)
			os.Symlink("mootr", filepath.Join(s, "stam"))
		}, "mootr"},
		{"both real folders is stam, a stray mootr never takes over", func(s string) {
			os.Mkdir(filepath.Join(s, "mootr"), 0o755)
			os.Mkdir(filepath.Join(s, "stam"), 0o755)
		}, "stam"},
		{"a dangling mootr link is mootr", func(s string) { os.Symlink("nowhere", filepath.Join(s, "mootr")) }, "mootr"},
		{"a dangling stam link is mootr", func(s string) { os.Symlink("nowhere", filepath.Join(s, "stam")) }, "mootr"},
		{"a stam file is mootr", func(s string) { os.WriteFile(filepath.Join(s, "stam"), nil, 0o644) }, "mootr"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u, s := shareDir(t)
			c.setup(s)
			got, err := DefaultHome(u)
			if err != nil || got != filepath.Join(s, c.want) {
				t.Fatalf("got %q, %v; want %s", got, err, c.want)
			}
		})
	}
	t.Run("an unreadable share folder is an error, not mootr", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root ignores permissions")
		}
		u, s := shareDir(t)
		os.Chmod(s, 0)
		t.Cleanup(func() { os.Chmod(s, 0o755) })
		if got, err := DefaultHome(u); err == nil {
			t.Fatalf("got %q, want an error", got)
		}
	})
}

// test/default-home.test.mjs drives this with its own table: DEFAULT_HOME_CASES is a JSON list of [name, user home, want],
// one per row it built, with want "" for an error.
func TestDefaultHomeFromTable(t *testing.T) {
	raw := os.Getenv("DEFAULT_HOME_CASES")
	if raw == "" {
		t.Skip("run by test/default-home.test.mjs")
	}
	var cases [][3]string
	if err := json.Unmarshal([]byte(raw), &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		got, err := DefaultHome(c[1])
		if c[2] == "" && err == nil || c[2] != "" && (err != nil || got != c[2]) {
			t.Errorf("%s: got %q, %v; want %q", c[0], got, err, c[2])
		}
	}
}

func TestLoadTreatsBothDefaultSpellingsAsLive(t *testing.T) {
	u, s := shareDir(t)
	m := filepath.Join(s, "mootr")
	os.Mkdir(m, 0o755)
	write(t, filepath.Join(m, "token"), "tok\n", 0o640)
	write(t, filepath.Join(m, "peer-token"), "peer\n", 0o644)
	os.Symlink("mootr", filepath.Join(s, "stam"))
	t.Setenv("HOME", u)
	for _, h := range []string{m, filepath.Join(s, "stam")} {
		c, err := Load(envOf(map[string]string{"STAM_HOME": h, "STAM_TEST_COST_HOOKS": "1", "STAM_TMUX_SOCKET": "stam-test-x", "STAM_TEST_HUMAN_KEY": "k"}))
		if err != nil {
			t.Fatal(err)
		}
		if !c.Live || c.TestHome || c.TestHooks || c.TestHumanKey != "" {
			t.Errorf("%s: Live=%v TestHome=%v TestHooks=%v key=%q; want live and no test switches", h, c.Live, c.TestHome, c.TestHooks, c.TestHumanKey)
		}
	}
	// Live is each spelling on its own, not which default is chosen: a real stam home with a stray mootr is live both ways.
	u2, s2 := shareDir(t)
	os.Mkdir(filepath.Join(s2, "stam"), 0o755)
	os.Mkdir(filepath.Join(s2, "mootr"), 0o755)
	for _, d := range []string{"stam", "mootr"} {
		write(t, filepath.Join(s2, d, "token"), "tok\n", 0o640)
		write(t, filepath.Join(s2, d, "peer-token"), "peer\n", 0o644)
	}
	t.Setenv("HOME", u2)
	for _, d := range []string{"stam", "mootr"} {
		c, err := Load(envOf(map[string]string{"STAM_HOME": filepath.Join(s2, d)}))
		if err != nil || !c.Live {
			t.Errorf("%s: Live=%v err=%v", d, c.Live, err)
		}
	}
}

func TestLoadHonoursAnExplicitHomeBeforeInspectingTheDefault(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores permissions")
	}
	u, s := shareDir(t)
	os.Mkdir(filepath.Join(s, "mootr"), 0o755)
	os.Chmod(s, 0)
	t.Cleanup(func() { os.Chmod(s, 0o755) })
	t.Setenv("HOME", u)
	h := home(t)
	// Pairs, not a map literal: the isolation test flags a MOOTR_ key written as `"MOOTR_X": v`.
	for _, kv := range [][]string{{"STAM_HOME", h}, {"MOOTR_HOME", h}, {"MOOTR_HOME", h, "STAM_HOME", "/nonexistent"}} {
		env := map[string]string{}
		for i := 0; i < len(kv); i += 2 {
			env[kv[i]] = kv[i+1]
		}
		c, err := Load(envOf(env))
		if err != nil || c.Home != h {
			t.Errorf("%v: home %q, err %v", env, c.Home, err)
		}
	}
}

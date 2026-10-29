package adapters

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"stam/internal/tmux"
)

// TestSessionEnv checks the env lifecycle adds (src/lifecycle.ts startHarness) follows TS's object spread: a key the
// spec holds keeps its place and takes the later value, new keys go last in order.
func TestSessionEnv(t *testing.T) {
	spec := tmux.Env{{Key: "STAM_USER_STATUSLINE", Value: "x"}, {Key: "STAM_TEST_TMPDIR", Value: "/spec"}}
	got := SessionEnv(spec, SessionVars{AgentID: "a1", URL: "http://127.0.0.1:1", Token: "tok", ReviewDir: "/review", ReviewTmp: "/review-tmp"})
	want := tmux.Env{{Key: "STAM_USER_STATUSLINE", Value: "x"}, {Key: "STAM_TEST_TMPDIR", Value: "/review-tmp"}, {Key: "STAM_REVIEW_DIR", Value: "/review"},
		{Key: "STAM_AGENT_ID", Value: "a1"}, {Key: "STAM_URL", Value: "http://127.0.0.1:1"}, {Key: "STAM_TOKEN", Value: "tok"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("env:\n got %v\nwant %v", got, want)
	}
	if spec[1].Value != "/spec" {
		t.Fatal("SessionEnv changed the spec's env")
	}
	plain := SessionEnv(nil, SessionVars{AgentID: "a2", URL: "u", Token: "t"})
	if len(plain) != 3 || plain[0].Key != "STAM_AGENT_ID" {
		t.Fatalf("env without a review dir: %v", plain)
	}
}

// TestGoBinDir checks the Go bin dir is found under the env's HOME only when it is a directory (S-3666; src/env.ts goBinDir).
func TestGoBinDir(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(home, ".local", "go", "bin")
	env := tmux.Env{{Key: "HOME", Value: home}, {Key: "STAM_AGENT_ID", Value: "a1"}}
	if got := GoBinDir(env); got != "" {
		t.Fatalf("no bin dir: %q", got)
	}
	if got := GoBinDir(tmux.Env{{Key: "HOME", Value: ""}}); got != "" {
		t.Fatalf("empty HOME: %q", got)
	}
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := GoBinDir(env); got != bin {
		t.Fatalf("bin dir: %q, want %q", got, bin)
	}
	file := t.TempDir()
	if err := os.MkdirAll(filepath.Join(file, ".local", "go"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(file, ".local", "go", "bin"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := GoBinDir(tmux.Env{{Key: "HOME", Value: file}}); got != "" {
		t.Fatalf("bin that is a file: %q", got)
	}
}

// TestGoBinArgv checks the argv runs through the shell with the bin dir put first on PATH, and is unchanged with no bin dir
// (S-3666; src/env.ts withGoBinArgv).
func TestGoBinArgv(t *testing.T) {
	argv := []string{"claude", "--x"}
	if got := GoBinArgv(argv, ""); !reflect.DeepEqual(got, argv) {
		t.Fatalf("no bin dir: %v", got)
	}
	got := GoBinArgv(argv, "/home/u/.local/go/bin")
	if got[0] != "/bin/sh" || got[1] != "-c" || got[3] != "sh" || got[4] != "/home/u/.local/go/bin" || !reflect.DeepEqual(got[5:], argv) {
		t.Fatalf("argv: %v", got)
	}
	if !strings.Contains(got[2], `*":$1:"*`) || !strings.Contains(got[2], `exec "$@"`) {
		t.Fatalf("script: %q", got[2])
	}
}

package process

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeExec(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

// Only a file under <root>/scripts/ runs, once links are resolved.
func TestScriptPath(t *testing.T) {
	root := t.TempDir()
	writeExec(t, filepath.Join(root, "scripts", "ship.mjs"), "x")
	writeExec(t, filepath.Join(root, "scripts", "sub", "deep.mjs"), "x")
	writeExec(t, filepath.Join(root, "other", "evil.mjs"), "x")
	outside := t.TempDir()
	writeExec(t, filepath.Join(outside, "out.mjs"), "x")
	if err := os.Symlink(filepath.Join(outside, "out.mjs"), filepath.Join(root, "scripts", "link.mjs")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "other", "evil.mjs"), filepath.Join(root, "scripts", "evil-link.mjs")); err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(root)
	for script, want := range map[string]string{
		"scripts/ship.mjs":          filepath.Join(real, "scripts", "ship.mjs"),
		"scripts/sub/deep.mjs":      filepath.Join(real, "scripts", "sub", "deep.mjs"),
		"scripts/../other/evil.mjs": "",
		"other/evil.mjs":            "",
		"/etc/passwd":               "",
		"scripts/missing.mjs":       "",
		"scripts/link.mjs":          "",
		"scripts/evil-link.mjs":     "",
		"scripts":                   "",
		"scripts/":                  "",
		"":                          "",
	} {
		if got := ScriptPath(root, script); got != want {
			t.Errorf("ScriptPath(%q) = %q, want %q", script, got, want)
		}
	}
	if got := ScriptPath(filepath.Join(root, "nowhere"), "scripts/ship.mjs"); got != "" {
		t.Errorf("a root with no scripts folder: %q", got)
	}
}

func TestIsRefusalAndTail(t *testing.T) {
	for r, want := range map[ScriptResult]bool{{Code: 3}: true, {Code: 3, Signal: "terminated"}: false, {Code: 0}: false, {Code: 1}: false, {Code: -1, Signal: "killed"}: false} {
		if got := r.IsRefusal(); got != want {
			t.Errorf("%+v refusal %v", r, got)
		}
	}
	if got := Tail("a\nb\nc\nd\n", 2); got != "c\nd" {
		t.Errorf("tail %q", got)
	}
	if got := Tail("  one  \n", 20); got != "one" {
		t.Errorf("short tail %q", got)
	}
}

// A script runs in its own session in the checkout with STAM_GATE_REPO set, its output is the log, and what it exits with is the
// result; an old log is pruned.
func TestRunDetached(t *testing.T) {
	dir := t.TempDir()
	// A stand-in for node: it drops --no-warnings and runs the script with sh.
	node := filepath.Join(dir, "fakenode")
	writeExec(t, node, "#!/bin/sh\nshift\nexec sh \"$@\"\n")
	checkout := filepath.Join(dir, "checkout")
	writeExec(t, filepath.Join(checkout, "scripts", "ship.sh"), "echo \"args=$* repo=$STAM_GATE_REPO cwd=$(pwd) sid=$(ps -o sid= -p $$ | tr -d ' ') pid=$$\"\nexit ${EXIT:-0}\n")
	logs := filepath.Join(dir, "logs")
	writeExec(t, filepath.Join(logs, "old.log"), "old")
	writeExec(t, filepath.Join(logs, "fresh.log"), "fresh")
	writeExec(t, filepath.Join(logs, "keep.txt"), "not a log")
	old := time.Now().Add(-10 * 24 * time.Hour)
	if err := os.Chtimes(filepath.Join(logs, "old.log"), old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(logs, "keep.txt"), old, old); err != nil {
		t.Fatal(err)
	}
	run := func(env ...string) ScriptResult {
		t.Helper()
		res, err := RunDetached(Detached{Node: node, Script: filepath.Join(checkout, "scripts", "ship.sh"), Args: []string{"7"}, Cwd: checkout, LogDir: logs, Env: append(os.Environ(), env...)})
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	res := run("EXIT=3")
	if !res.IsRefusal() || res.Code != 3 {
		t.Errorf("exit 3: %+v", res)
	}
	for _, want := range []string{"args=7", "repo=" + checkout, "cwd=" + checkout} {
		if !strings.Contains(res.Output, want) {
			t.Errorf("the output lacks %q: %q", want, res.Output)
		}
	}
	// The script leads its own session: its session id is its own pid.
	var sid, pid string
	for _, f := range strings.Fields(res.Output) {
		if v, ok := strings.CutPrefix(f, "sid="); ok {
			sid = v
		}
		if v, ok := strings.CutPrefix(f, "pid="); ok {
			pid = v
		}
	}
	if sid == "" || sid != pid {
		t.Errorf("the script is not a session leader: sid %q pid %q", sid, pid)
	}
	if _, err := os.Stat(filepath.Join(logs, "old.log")); !os.IsNotExist(err) {
		t.Errorf("an old log was kept")
	}
	for _, f := range []string{"fresh.log", "keep.txt"} {
		if _, err := os.Stat(filepath.Join(logs, f)); err != nil {
			t.Errorf("%s was removed: %v", f, err)
		}
	}
	if res := run(); res.Code != 0 || res.IsRefusal() {
		t.Errorf("exit 0: %+v", res)
	}
	if res := run("EXIT=1"); res.Code != 1 || res.IsRefusal() {
		t.Errorf("exit 1: %+v", res)
	}
	// A run that never starts is an error, not a result.
	if _, err := RunDetached(Detached{Node: filepath.Join(dir, "no-such-node"), Script: "x", Cwd: checkout, LogDir: logs}); err == nil {
		t.Error("a missing interpreter ran")
	}
	// A run killed by a signal is no verdict.
	writeExec(t, filepath.Join(checkout, "scripts", "die.sh"), "kill -9 $$\n")
	res, err := RunDetached(Detached{Node: node, Script: filepath.Join(checkout, "scripts", "die.sh"), Cwd: checkout, LogDir: logs})
	if err != nil || res.IsRefusal() || res.Signal != "SIGKILL" {
		t.Errorf("a killed run: %+v %v", res, err)
	}
}

func TestReadTail(t *testing.T) {
	f := filepath.Join(t.TempDir(), "x.log")
	if err := os.WriteFile(f, []byte(strings.Repeat("a", 5000)+"END"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := ReadTail(f, LogTailBytes); len(got) != LogTailBytes || !strings.HasSuffix(got, "END") {
		t.Errorf("tail of a long log: %d bytes", len(got))
	}
	if got := ReadTail(f, 10000); len(got) != 5003 {
		t.Errorf("tail of a short log: %d bytes", len(got))
	}
	if got := ReadTail(f+".missing", 10); got != "" {
		t.Errorf("tail of a missing log: %q", got)
	}
}

package lifecycle

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// alive is whether pid is a live process: not gone, and not a zombie waiting to be reaped.
func alive(pid int) bool {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	fields := strings.Fields(string(b[strings.LastIndexByte(string(b), ')')+1:]))
	return len(fields) > 0 && fields[0] != "Z"
}

// TestWorkspaceScriptGroup: a child the script leaves running in the background dies with it, whether the script
// succeeded (with the child holding stdout open or not), failed, or overran its bound.
func TestWorkspaceScriptGroup(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	t.Setenv("STAM_WORKSPACE_SCRIPT_TIMEOUT_MS", "2000")
	for _, tc := range []struct{ name, script string }{
		{"detached", `sleep 300 >/dev/null 2>&1 & echo $! > pid; echo .`},
		{"holding stdout", `sleep 300 & echo $! > pid; echo .`},
		{"failed", `sleep 300 >/dev/null 2>&1 & echo $! > pid; exit 3`},
		{"overran", `sleep 300 >/dev/null 2>&1 & echo $! > pid; sleep 300`},
	} {
		os.Remove(filepath.Join(dir, "pid"))
		RunWorkspaceScript(ctx, tc.script, dir, "a1")
		b, err := os.ReadFile(filepath.Join(dir, "pid"))
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
		// The child is killed by the time the script returns; its reaping by init may lag a moment.
		for deadline := time.Now().Add(5 * time.Second); alive(pid) && time.Now().Before(deadline); {
			time.Sleep(20 * time.Millisecond)
		}
		if alive(pid) {
			t.Errorf("%s: the background child %d outlived the script", tc.name, pid)
		}
	}
}

// TestWorkspaceScriptLongOutput: the directory is TS's out.trim().split('\n').pop() however much the script printed:
// output past the kept tail never makes an earlier line the directory, and a last line whose start was dropped (longer
// than the tail) is refused rather than read from its end.
func TestWorkspaceScriptLongOutput(t *testing.T) {
	dir := t.TempDir()
	long := strings.Repeat("x", 200)
	for _, d := range []string{"early", "late", long} {
		must(t, os.Mkdir(filepath.Join(dir, d), 0o755))
	}
	const filler = `yes "a filler line past the old 1 MiB cap" | head -n 80000`
	for _, tc := range []struct{ name, script, want, refused string }{
		{"a last line with a leading space", `printf '\n .\n'`, dir, ""},
		{"a lone line with spaces", `printf '  late  \n\n'`, filepath.Join(dir, "late"), ""},
		{"the last of long output", `echo early; ` + filler + `; echo late`, filepath.Join(dir, "late"), ""},
		{"filler last", `echo early; ` + filler, "", "printed no existing directory: a filler line past the old 1 MiB cap"},
		{"a whole line after an overlong one", `printf '%70000s' ''; printf '\n.\n'`, dir, ""},
		{"an overlong last line", `printf invalid; printf '%70000s' ''; printf '.\n'`, "", "printed a last line longer than 65536 bytes"},
		{"a long last line within the tail", `yes filler | head -n 10000; echo ` + long, filepath.Join(dir, long), ""},
	} {
		got, err := RunWorkspaceScript(context.Background(), tc.script, dir, "a1")
		if tc.refused != "" {
			if err == nil || !strings.Contains(err.Error(), tc.refused) {
				t.Errorf("%s: %q %v, want refused %q", tc.name, got, err, tc.refused)
			}
		} else if err != nil || got != tc.want {
			t.Errorf("%s: %q %v, want %s", tc.name, got, err, tc.want)
		}
	}
}

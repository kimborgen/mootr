package process

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// ScriptPath is src/process-run.ts scriptPath: the script's real path when it lies under `<root>/scripts/` once symlinks are
// resolved, or "" for anything else (an absolute path, `..`, another folder, a link out, a missing file).
func ScriptPath(root, script string) string {
	dir, err := filepath.EvalSymlinks(filepath.Join(root, "scripts"))
	if err != nil {
		return ""
	}
	full, err := filepath.EvalSymlinks(filepath.Join(root, script))
	if err != nil {
		return ""
	}
	rel, err := filepath.Rel(dir, full)
	if err != nil || rel == "" || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return ""
	}
	return full
}

// Detached is what RunDetached needs.
type Detached struct {
	// Node is the interpreter, Script the script's real path and Args its arguments.
	Node, Script string
	Args         []string
	// Cwd is the git checkout the script runs in; STAM_GATE_REPO names it for merge-pr.mjs and gate.mjs, since a release directory has
	// no .git.
	Cwd string
	// LogDir holds the run's log file. Log files older than KeepDays (default 7) are removed first.
	LogDir   string
	KeepDays int
	// Now is the clock, time.Now when nil.
	Now func() time.Time
	// Env is the environment the script starts with, os.Environ when nil.
	Env []string
}

// LogTailBytes is how much of a run's log the result carries.
const LogTailBytes = 4096

// RunDetached is src/process-run.ts runDetached: it starts `node --no-warnings SCRIPT ARGS` in its own session, with its output in
// a log file, so a daemon restart doesn't kill the run, and waits for it to end. The result carries the last 4 KB of the log. Old
// logs are pruned first.
func RunDetached(d Detached) (ScriptResult, error) {
	now := time.Now
	if d.Now != nil {
		now = d.Now
	}
	if err := os.MkdirAll(d.LogDir, 0o755); err != nil {
		return ScriptResult{Code: -1}, err
	}
	keep := d.KeepDays
	if keep == 0 {
		keep = 7
	}
	cutoff := now().Add(-time.Duration(keep) * 24 * time.Hour)
	if entries, err := os.ReadDir(d.LogDir); err == nil {
		for _, e := range entries {
			if !strings.HasSuffix(e.Name(), ".log") {
				continue
			}
			if st, err := e.Info(); err == nil && st.ModTime().Before(cutoff) {
				_ = os.Remove(filepath.Join(d.LogDir, e.Name()))
			}
		}
	}
	name := fmt.Sprintf("%s-%s-%d.log", filepath.Base(d.Script), strings.Join(d.Args, "-"), now().UnixMilli())
	logFile := filepath.Join(d.LogDir, name)
	log, err := os.OpenFile(logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return ScriptResult{Code: -1}, err
	}
	defer log.Close()
	env := d.Env
	if env == nil {
		env = os.Environ()
	}
	cmd := exec.Command(d.Node, append([]string{"--no-warnings", d.Script}, d.Args...)...)
	cmd.Dir = d.Cwd
	cmd.Env = append(env, "STAM_GATE_REPO="+d.Cwd)
	cmd.Stdin = nil
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return ScriptResult{Code: -1}, err
	}
	waitErr := cmd.Wait()
	res := ScriptResult{Output: ReadTail(logFile, LogTailBytes)}
	var exit *exec.ExitError
	switch {
	case waitErr == nil:
	case errors.As(waitErr, &exit):
		res.Code = exit.ExitCode()
		if ws, ok := exit.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			res.Code, res.Signal = -1, unix.SignalName(ws.Signal())
		}
	default:
		return ScriptResult{Code: -1, Output: res.Output}, waitErr
	}
	return res, nil
}

// ReadTail is the last `bytes` of a file, or "" when it can't be read.
func ReadTail(file string, bytes int) string {
	f, err := os.Open(file)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	start := st.Size() - int64(bytes)
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return ""
	}
	b, err := io.ReadAll(f)
	if err != nil {
		return ""
	}
	return string(b)
}

// Tail is the last `lines` lines of the trimmed text (src/process-run.ts tail).
func Tail(text string, lines int) string {
	all := strings.Split(strings.TrimSpace(text), "\n")
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	return strings.Join(all, "\n")
}

package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"time"
	"unicode"

	"stam/internal/agentenv"
	"stam/internal/jsjson"
)

// A spawn's other workspaces (src/workspace.ts createWorkspace, personalWorkspaceName, createPersonalWorkspace, S-894):
// a directory a workspace script prints, and the personal workspace folder an agent keeps across archive.

// workspaceScriptTimeout bounds a workspace script; TS runs it with no bound, blocking its daemon until it ends.
func workspaceScriptTimeout() time.Duration {
	return envMs("WORKSPACE_SCRIPT_TIMEOUT_MS", 5*time.Minute)
}

// scriptOutputTail is how much of the end of a workspace script's stdout is kept: the directory is its last line.
const scriptOutputTail = 64 << 10

// tailBuffer keeps the last n bytes written to it, so a chatty script can't fill memory and its last line is never cut
// off by a cap. dropped says bytes before the kept ones were dropped, so the first kept line may be partial.
type tailBuffer struct {
	buf     []byte
	n       int
	dropped bool
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.buf = append(b.buf, p...)
	if len(b.buf) > b.n {
		b.buf = append(b.buf[:0], b.buf[len(b.buf)-b.n:]...)
		b.dropped = true
	}
	return len(p), nil
}

func (b *tailBuffer) String() string { return string(b.buf) }

// RunWorkspaceScript is src/workspace.ts createWorkspace for a script spec: `sh -c command` in cwd, the caller's own
// shell command by design. Anything it leaves running in its process group is killed once it exits. The agent's name reaches it only as STAM_AGENT_NAME and MOOTR_AGENT_NAME in its environment,
// never in the command, and the daemon's own agent identity is dropped from that environment. The script prints the
// directory to work in on its last line; a relative one is taken from cwd. It runs in its own process group, killed
// whole at the deadline. Unlike TS, the directory must exist as a directory where it resolves (TS checks a relative
// one against the daemon's cwd, and takes a file).
func RunWorkspaceScript(ctx context.Context, command, cwd, name string) (string, error) {
	d := workspaceScriptTimeout()
	ctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Dir = cwd
	drop := agentenv.Names()
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); !slices.Contains(drop, k) {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	cmd.Env = append(cmd.Env, "STAM_AGENT_NAME="+name, "MOOTR_AGENT_NAME="+name)
	stdout, stderr := &tailBuffer{n: scriptOutputTail}, &tailBuffer{n: 4096}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	// Whatever the script started and left behind dies with it, on every path: a child it put in the background
	// (`sleep 30 & echo .`) keeps the group alive after sh exits, where cmd.Cancel no longer fires.
	if cmd.Process != nil {
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	if ctx.Err() == context.DeadlineExceeded {
		return "", fmt.Errorf("workspace script timed out after %gs", d.Seconds())
	}
	// ErrWaitDelay: sh exited 0, but a child it left still held stdout open; its output so far stands.
	if err != nil && !errors.Is(err, exec.ErrWaitDelay) {
		// execFileSync's message: the command line, then the script's stderr.
		msg := "Command failed: sh -c " + command
		if e := strings.TrimSpace(stderr.String()); e != "" {
			msg += "\n" + e
		}
		return "", errors.New(msg)
	}
	// A last line with no newline before it in the kept tail, after bytes were dropped, is partial: its start is gone,
	// so it can't be read as the directory. Only this check reads the raw bytes.
	if stdout.dropped && !strings.Contains(strings.TrimRightFunc(stdout.String(), unicode.IsSpace), "\n") {
		return "", fmt.Errorf("workspace script printed a last line longer than %d bytes", scriptOutputTail)
	}
	// TS's out.trim().split('\n').pop().
	out := strings.TrimSpace(stdout.String())
	start := strings.LastIndexByte(out, '\n') + 1
	dir := out[start:]
	if dir != "" && !filepath.IsAbs(dir) {
		dir = filepath.Join(cwd, dir)
	}
	if st, err := os.Stat(dir); dir == "" || err != nil || !st.IsDir() {
		return "", fmt.Errorf("workspace script printed no existing directory: %s", out[start:])
	}
	return filepath.Clean(dir), nil
}

// workspaceName is src/workspace.ts WORKSPACE_NAME: the shape of an agent name.
var workspaceName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,40}$`)

// PersonalWorkspaceName is src/workspace.ts personalWorkspaceName's check: the folder name a spawn's `workspace` names
// (the agent's own name for true, else String(value)). A name that isn't lowercase letters, digits and dashes is refused
// before anything exists, so it can't climb out of the workspaces folder or pass as an option.
func PersonalWorkspaceName(name string) error {
	if !workspaceName.MatchString(name) {
		return fmt.Errorf("workspace name %s must be lowercase letters, digits, and dashes", jsjson.Stringify(name, ""))
	}
	return nil
}

// PersonalWorkspacePath is src/workspace.ts personalWorkspacePath: STAM_HOME/workspaces/NAME, made or not.
func PersonalWorkspacePath(home, name string) string { return filepath.Join(home, "workspaces", name) }

// CreatePersonalWorkspace is src/workspace.ts createPersonalWorkspace: the folder made 0700 when missing, an existing
// one (an archived specialist's) reused as it is. A path that can't be inspected is an error, not taken for missing.
func CreatePersonalWorkspace(home, name string) (string, error) {
	path := PersonalWorkspacePath(home, name)
	_, err := os.Stat(path)
	existed := err == nil
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return "", err
	}
	// MkdirAll's mode is masked by the umask, so set it plainly the first time.
	if !existed {
		if err := os.Chmod(path, 0o700); err != nil {
			return "", err
		}
	}
	return path, nil
}

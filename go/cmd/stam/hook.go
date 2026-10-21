package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"stam/internal/client"
	"stam/internal/jsfmt"
)

// The budgets and retry of bin/stam-fast, which the harnesses' hooks call on every tool call (S-188, S-274): a hook may
// wait 3 s for the daemon and retries only a refused connection; the status line waits 1 s; the user's own status line
// runs under 5 s. None of them fails the agent: a failure exits 0 with no output.
const (
	hookBudget       = 3 * time.Second
	hookRetryEvery   = 500 * time.Millisecond
	hookRetries      = 60
	statuslineBudget = time.Second
	userStatusline   = 5 * time.Second
	statuslineTTL    = 30
)

// hook is `stam hook HARNESS`: POST the harness's stdin to the daemon and print the reply's `stdout` byte for byte.
// While the daemon is down (a deploy restarts it) the POST retries for up to 30 s; a timeout is not retried, because the
// daemon may have taken the event.
func hook(ctx context.Context, args []string, e env) int {
	payload, _ := io.ReadAll(e.stdin)
	id := e.getenv("STAM_AGENT_ID")
	if len(args) == 0 || args[0] == "" || id == "" {
		return 0
	}
	c := client.New(e.getenv)
	path := "/api/hook/" + args[0] + "/" + id
	for tries := 0; ; tries++ {
		_, reply, err := c.Raw(ctx, "POST", path, payload, false, hookBudget)
		if err == nil {
			if out, ok := replyStdout(reply); ok {
				e.stdout.Write(out)
			}
			return 0
		}
		if !client.ConnRefused(err) || tries >= hookRetries {
			return 0
		}
		select {
		case <-ctx.Done():
			return 0
		case <-time.After(hookRetryEvery):
		}
	}
}

// replyStdout is the reply's `stdout` string, when it is a non-empty one (jq's `.stdout // empty`).
func replyStdout(reply []byte) ([]byte, bool) {
	v, err := jsfmt.Parse(reply)
	if err != nil {
		return nil, false
	}
	s, ok := v.Get("stdout")
	if !ok || s.Kind != jsfmt.String || s.Str == "" {
		return nil, false
	}
	return []byte(s.Str), true
}

// statusline is `stam statusline HARNESS`: tell the daemon the context size (1 s), then print `[stam ID] ` and the
// user's own status line (STAM_USER_STATUSLINE), which runs at most once per 30 s per agent, and never again while nobody
// views the agent (S-171, S-274, S-1055). The cache is STAM_HOME/statusline-ID.out: the time on its first line, the
// output after it.
func statusline(ctx context.Context, args []string, e env) int {
	payload, _ := io.ReadAll(e.stdin)
	if len(args) == 0 || args[0] == "" {
		return 0
	}
	id := e.getenv("STAM_AGENT_ID")
	unviewed := false
	if id != "" {
		if _, reply, err := client.New(e.getenv).Raw(ctx, "POST", "/api/statusline/"+args[0]+"/"+id, payload, false, statuslineBudget); err == nil {
			unviewed = bytes.Contains(reply, []byte(`"viewed":false`))
		}
	}
	label := id
	if label == "" {
		label = "?"
	}
	e.stdout.Write([]byte("[stam " + label + "] "))
	user := e.getenv("STAM_USER_STATUSLINE")
	if user == "" {
		return 0
	}
	cache := filepath.Join(client.Home(e.getenv), "statusline-"+id+".out")
	now := time.Now().Unix()
	if id != "" {
		if at, rest, ok := readCache(cache); ok && now-at >= 0 && (unviewed || now-at < statuslineTTL) {
			e.stdout.Write(rest)
			return 0
		}
	}
	out := runUser(ctx, user, payload)
	if id != "" {
		writeCache(cache, now, out)
	}
	e.stdout.Write(out)
	return 0
}

// readCache splits the cache file into the time on its first line and the bytes after it (`tail -n +2`).
func readCache(path string) (int64, []byte, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, nil, false
	}
	line, rest, _ := bytes.Cut(b, []byte("\n"))
	if len(line) == 0 || strings.Trim(string(line), "0123456789") != "" {
		return 0, nil, false
	}
	at, err := strconv.ParseInt(string(line), 10, 64)
	if err != nil {
		return 0, nil, false
	}
	return at, rest, true
}

// writeCache saves the time and the output, through a temporary file so a reader never sees half of it.
func writeCache(path string, now int64, out []byte) {
	if os.MkdirAll(filepath.Dir(path), 0o700) != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, append([]byte(strconv.FormatInt(now, 10)+"\n"), out...), 0o600) != nil {
		return
	}
	if os.Rename(tmp, path) != nil {
		os.Remove(tmp)
	}
}

// runUser runs the user's status line under a 5 s limit with the hook payload on stdin, and returns its stdout only.
// A failure or a timeout gives what it printed before.
func runUser(ctx context.Context, command string, payload []byte) []byte {
	ctx, cancel := context.WithTimeout(ctx, userStatusline)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Stdin = bytes.NewReader(payload)
	var out bytes.Buffer
	cmd.Stdout = &out
	// Its own process group, ended whole at the limit: a child it started must not hold the pipe open past 5 s.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	_ = cmd.Run()
	return out.Bytes()
}

package peers

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"stam/internal/config"
)

// run is a start or a deploy that concurrent callers share.
type run struct {
	done chan struct{}
	err  error
}

// shared runs fn once for the callers that arrive while it runs, and gives them all its error.
func (c *Client) shared(m map[string]*run, name string, fn func() error) error {
	c.mu.Lock()
	r, ok := m[name]
	if !ok {
		r = &run{done: make(chan struct{})}
		m[name] = r
		go func() {
			r.err = fn()
			c.mu.Lock()
			delete(m, name)
			c.mu.Unlock()
			close(r.done)
		}()
	}
	c.mu.Unlock()
	<-r.done
	return r.err
}

// health is the release a peer's daemon reports (nil for a checkout), and whether it answered at all. Any answer that is
// JSON counts as up; only a connection error or a body that is not JSON counts as down.
func (c *Client) health(p config.Peer) (release *string, answered bool) {
	ctx, cancel := context.WithTimeout(context.Background(), healthTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url(p, "/api/health"), nil)
	if err != nil {
		return nil, false
	}
	req.Header.Set("authorization", "Bearer "+p.Bearer())
	req.Header.Set("x-stam-local", "1")
	res, err := c.http.Do(req)
	if err != nil {
		return nil, false
	}
	defer res.Body.Close()
	var body struct {
		Release *string `json:"release"`
	}
	if json.NewDecoder(res.Body).Decode(&body) != nil {
		return nil, false
	}
	return body.Release, true
}

// EnsureUp is ensureUp: a spawn on a peer that does not answer runs its `start` command once (concurrent callers share the
// run), then polls its /api/health until it answers or the deadline (STAM_PEER_START_TIMEOUT_MS, 5 minutes by default) passes.
func (c *Client) EnsureUp(p config.Peer) error {
	if _, ok := c.health(p); ok {
		return nil
	}
	return c.shared(c.starting, p.Name, func() error { return c.startPeer(p) })
}

func (c *Client) startPeer(p config.Peer) error {
	deadline := time.Now().Add(c.timeoutEnv("STAM_PEER_START_TIMEOUT_MS", 300*time.Second))
	fail := func(why string, tail []string) error {
		msg := fmt.Sprintf("%s is unreachable and didn't start: %s", p.Name, why)
		if len(tail) > 0 {
			msg += "\n" + strings.Join(tail, "\n")
		}
		return errors.New(msg)
	}
	if p.Start == "" {
		return fail("no start command in settings.json (peers[].start)", nil)
	}
	slog.Info(fmt.Sprintf("peer:start %s: running %s", p.Name, p.Start))
	code, tail := runCommand(p.Start, os.Environ(), deadline)
	if code == lateCode {
		return fail("its start command ran past the deadline", tail)
	}
	if code != 0 {
		slog.Info(fmt.Sprintf("peer:start %s: start command exited %d", p.Name, code))
		return fail(fmt.Sprintf("its start command exited with %d", code), tail)
	}
	if !until(func() bool { _, ok := c.health(p); return ok }, deadline) {
		slog.Info(fmt.Sprintf("peer:start %s: no answer before the deadline", p.Name))
		return fail("it didn't answer /api/health before the deadline", tail)
	}
	c.markUp(p.Name)
	slog.Info(fmt.Sprintf("peer:start %s: up", p.Name))
	return nil
}

// EnsureCurrent is ensureCurrent: a peer whose release differs from this daemon's runs its `deploy` command once
// (concurrent callers share the run) with STAM_RELEASE and STAM_PEER set, then polls its /api/health until it reports this
// release or the deadline (STAM_PEER_DEPLOY_TIMEOUT_MS, 10 minutes by default) passes. It returns a warning when the peer
// could not be brought to this release (the spawn still goes on), and "" when it is on this release or cannot be deployed to.
func (c *Client) EnsureCurrent(p config.Peer) string {
	mine := c.release
	if r, _ := c.health(p); r != nil && *r == mine {
		return ""
	}
	if mine == "" {
		return ""
	}
	// A staged merge (S-470) is live on alpha only until its hold is removed. Deploying it to a peer now would send it
	// there early, racing the deploy watcher, so the spawn goes on on the peer's release with a warning.
	if exists(filepath.Join(c.home, "deploy-staged.json")) {
		slog.Info(fmt.Sprintf("peer:deploy %s: not deployed, a staged merge waits for its hold", p.Name))
		return fmt.Sprintf("%s isn't on %s: a staged merge waits for its hold, so %s keeps its release", p.Name, mine, p.Name)
	}
	// The deploy watcher owns the moves storage makes (S-525): while its hold is in place, or once it has put storage on
	// another release, a spawn does not move the peer past what the watcher deployed.
	if c.deployHeld() {
		slog.Info(fmt.Sprintf("peer:deploy %s: not deployed, a deploy hold is in place", p.Name))
		return fmt.Sprintf("%s isn't on %s: a deploy hold is in place, so %s keeps its release", p.Name, mine, p.Name)
	}
	// The marker holds a full sha and the release is its 10-char prefix, so compare by prefix.
	if b, err := os.ReadFile(filepath.Join(c.home, "deploy-storage-sha")); err == nil && !strings.HasPrefix(strings.TrimSpace(string(b)), mine) {
		slog.Info(fmt.Sprintf("peer:deploy %s: not deployed, the deploy watcher owns its release", p.Name))
		return fmt.Sprintf("%s isn't on %s: the deploy watcher owns %s's release, so %s keeps its release", p.Name, mine, p.Name, p.Name)
	}
	if p.Deploy == "" {
		slog.Info(fmt.Sprintf("peer:deploy %s: on another release and has no deploy command", p.Name))
		return ""
	}
	if err := c.shared(c.deploys, p.Name, func() error { return c.deployPeer(p, mine) }); err != nil {
		return err.Error()
	}
	return ""
}

func (c *Client) deployPeer(p config.Peer, release string) error {
	deadline := time.Now().Add(c.timeoutEnv("STAM_PEER_DEPLOY_TIMEOUT_MS", 600*time.Second))
	fail := func(why string, tail []string) error {
		msg := fmt.Sprintf("%s didn't deploy %s: %s", p.Name, release, why)
		if len(tail) > 0 {
			msg += "\n" + strings.Join(tail, "\n")
		}
		return errors.New(msg)
	}
	slog.Info(fmt.Sprintf("peer:deploy %s: running %s for %s", p.Name, p.Deploy, release))
	code, tail := runCommand(p.Deploy, append(os.Environ(), "STAM_RELEASE="+release, "STAM_PEER="+p.Name), deadline)
	if code == lateCode {
		return fail("its deploy command ran past the deadline", tail)
	}
	if code != 0 {
		slog.Info(fmt.Sprintf("peer:deploy %s: deploy command exited %d", p.Name, code))
		return fail(fmt.Sprintf("its deploy command exited with %d", code), tail)
	}
	if !until(func() bool { r, _ := c.health(p); return r != nil && *r == release }, deadline) {
		slog.Info(fmt.Sprintf("peer:deploy %s: no %s before the deadline", p.Name, release))
		return fail(fmt.Sprintf("it doesn't report %s on /api/health before the deadline", release), tail)
	}
	slog.Info(fmt.Sprintf("peer:deploy %s: now on %s", p.Name, release))
	return nil
}

// timeoutEnv is `Number(process.env.NAME ?? fallback)`.
func (c *Client) timeoutEnv(name string, fallback time.Duration) time.Duration {
	if v := c.getenv(name); v != "" {
		if n, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
			return time.Duration(n * float64(time.Millisecond))
		}
	}
	return fallback
}

// deployHeld is true while the deploy watcher holds: its hold, or a hold a lift set aside (deploy-hold.lifting-PID, S-1770)
// while it compares or after a put-back that failed. A STAM_HOME that cannot be listed counts as held.
func (c *Client) deployHeld() bool {
	if exists(filepath.Join(c.home, "deploy-hold")) {
		return true
	}
	entries, err := os.ReadDir(c.home)
	if err != nil {
		return true
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "deploy-hold.lifting-") {
			return true
		}
	}
	return false
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// lateCode is runCommand's code for a command killed at the deadline.
const lateCode = -1000

// termGrace is how long a command killed at the deadline has to end after SIGTERM before its group gets SIGKILL, and
// pipeGrace how long Wait waits, after the shell has exited, for the pipes that something it started in the background
// still holds (`sleep 30 &`). Variables, for the tests.
var (
	termGrace = 5 * time.Second
	pipeGrace = 2 * time.Second
)

// runCommand runs a peer's shell command until it exits or the deadline passes. The code is its exit code, or lateCode
// when it was killed at the deadline; tail holds its last output lines. It has its own process group, so the deadline kills
// what the command started (a `box up` ssh) and not just the shell (S-1473): SIGTERM first, then SIGKILL on the group after
// termGrace, so a command that ignores SIGTERM cannot hold the caller. runCommand returns once the shell has exited and
// pipeGrace has passed for the pipes of what it left running.
func runCommand(cmd string, env []string, deadline time.Time) (int, []string) {
	c := exec.Command("sh", "-c", cmd)
	c.Env = env
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	c.WaitDelay = pipeGrace
	pr, pw := io.Pipe()
	c.Stdout, c.Stderr = pw, pw
	var mu sync.Mutex
	var tail []string
	scanned := make(chan struct{})
	go func() {
		defer close(scanned)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		for sc.Scan() {
			if line := sc.Text(); line != "" {
				mu.Lock()
				tail = append(tail, line)
				if len(tail) > 10 {
					tail = tail[len(tail)-10:]
				}
				mu.Unlock()
			}
		}
		// A line longer than the buffer ends the scan: keep draining, so the command is never blocked on its output.
		io.Copy(io.Discard, pr)
	}()
	if err := c.Start(); err != nil {
		pw.Close()
		<-scanned
		return 127, []string{err.Error()}
	}
	exited := make(chan error, 1)
	go func() { exited <- c.Wait(); pw.Close() }()
	var werr error
	code := 0
	select {
	case werr = <-exited:
	case <-time.After(time.Until(deadline)):
		code = lateCode
		pgid := c.Process.Pid
		if syscall.Kill(-pgid, syscall.SIGTERM) != nil {
			c.Process.Kill()
		}
		select {
		case werr = <-exited:
		case <-time.After(termGrace):
			syscall.Kill(-pgid, syscall.SIGKILL)
			werr = <-exited
		}
	}
	<-scanned
	if code == 0 {
		var ee *exec.ExitError
		if errors.As(werr, &ee) {
			code = ee.ExitCode()
		} else if werr != nil && !errors.Is(werr, exec.ErrWaitDelay) {
			code = 1
		}
	}
	mu.Lock()
	defer mu.Unlock()
	return code, append([]string(nil), tail...)
}

// until polls check every 2 s until it holds (true) or the deadline passes (false).
func until(check func() bool, deadline time.Time) bool {
	for !check() {
		if !time.Now().Before(deadline) {
			return false
		}
		wait := pollEvery
		if left := time.Until(deadline); left < wait {
			wait = left
		}
		time.Sleep(wait)
	}
	return true
}

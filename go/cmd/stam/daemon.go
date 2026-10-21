package main

import (
	"context"
	"errors"
	"fmt"
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

const (
	startPolls   = 50
	startPoll    = 100 * time.Millisecond
	stopWait     = 15 * time.Second
	healthBudget = 500 * time.Millisecond
)

// stamdPath is the daemon binary: STAM_STAMD_BIN, else stamd beside this one (go/bin).
func stamdPath(e env) (string, error) {
	if p := e.getenv("STAM_STAMD_BIN"); p != "" {
		return p, nil
	}
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(self), "stamd"), nil
}

func daemon(ctx context.Context, args []string, e env) error {
	sub := "run"
	if len(args) > 0 {
		sub = args[0]
	}
	switch sub {
	case "run":
		return daemonRun(e)
	case "start":
		return daemonStart(ctx, e)
	case "stop":
		return daemonStop(ctx, e)
	case "status":
		return daemonStatus(ctx, e)
	}
	return fmt.Errorf("unknown daemon command %s", sub)
}

// daemonRun replaces this process with stamd, so a service manager supervises the daemon itself.
func daemonRun(e env) error {
	bin, err := stamdPath(e)
	if err != nil {
		return err
	}
	return syscall.Exec(bin, []string{"stamd"}, e.environ())
}

// childEnv is the environment the daemon starts with. An agent's identity and token stay out of it: a daemon an agent
// starts is no agent's, and without the identity an archive's sweep never takes its tmux server for the agent's own, nor
// the token for the shared one (S-240).
func childEnv(environ []string) []string {
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		k, _, _ := strings.Cut(kv, "=")
		if k == "STAM_AGENT_ID" || k == "STAM_AGENT_NAME" || k == "STAM_TOKEN" {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// daemonStart launches stamd detached, in a session of its own so it outlives this process, with its output in
// STAM_HOME/daemon.log, and waits for /api/health. The pid file is what `daemon stop` reads.
func daemonStart(ctx context.Context, e env) error {
	if e.getenv("STAM_HOME") == "" {
		return errors.New("STAM_HOME is not set; the Go daemon serves no default home yet")
	}
	home := client.Home(e.getenv)
	c := client.New(e.getenv)
	if _, err := c.Do(ctx, "GET", "/api/health", nil, healthBudget); err == nil {
		fmt.Fprintln(e.stdout, "stamd already running")
		return nil
	}
	bin, err := stamdPath(e)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	logPath := filepath.Join(home, "daemon.log")
	log, err := os.OpenFile(logPath, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd := exec.Command(bin)
	cmd.Env = childEnv(e.environ())
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", filepath.Base(bin), err)
	}
	pid := cmd.Process.Pid
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	if err := os.WriteFile(filepath.Join(home, "daemon.pid"), []byte(strconv.Itoa(pid)), 0o600); err != nil {
		return err
	}
	for i := 0; i < startPolls; i++ {
		select {
		case <-exited:
			return fmt.Errorf("stamd exited; see %s", logPath)
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(startPoll):
		}
		if _, err := c.Do(ctx, "GET", "/api/health", nil, healthBudget); err == nil {
			fmt.Fprintf(e.stdout, "stamd started, pid %d\n", pid)
			return nil
		}
	}
	return fmt.Errorf("stamd didn't answer; see %s", logPath)
}

// daemonStop ends the daemon of this STAM_HOME: the pid in its pid file, and only if that process is a stamd running
// with this STAM_HOME. The pid file goes only when its pid is dead; while the process lives, the file stays, so a pid held
// by another program, or a stamd of another home, is never signalled and its file never lost. Nothing is found by a
// pattern.
func daemonStop(ctx context.Context, e env) error {
	if e.getenv("STAM_HOME") == "" {
		return errors.New("STAM_HOME is not set; the Go daemon serves no default home yet")
	}
	home := client.Home(e.getenv)
	pidFile := filepath.Join(home, "daemon.pid")
	b, err := os.ReadFile(pidFile)
	if err != nil {
		fmt.Fprintln(e.stdout, "stamd not running")
		return nil
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 1 || !running(pid) {
		os.Remove(pidFile)
		fmt.Fprintln(e.stdout, "stamd not running")
		return nil
	}
	if !isStamd(pid, home) {
		fmt.Fprintln(e.stdout, "stamd not running")
		return nil
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		os.Remove(pidFile)
		fmt.Fprintln(e.stdout, "stamd not running")
		return nil
	}
	// stamd ends its streams, drains requests and closes the database on SIGTERM: wait for it, so a restart finds no
	// stale -wal file and doesn't race the port.
	deadline := time.Now().Add(stopWait)
	for running(pid) {
		if time.Now().After(deadline) {
			return fmt.Errorf("stamd (pid %d) didn't stop within %s", pid, stopWait)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	os.Remove(pidFile)
	fmt.Fprintln(e.stdout, "stamd stopped")
	return nil
}

// running is whether pid is a live process: not gone, and not a zombie waiting to be reaped.
func running(pid int) bool {
	st, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	return err == nil && !zombie(st)
}

// isStamd is whether pid is a live stamd process whose environment names home as its STAM_HOME. Where the environment
// can't be read, the executable alone decides.
func isStamd(pid int, home string) bool {
	proc := "/proc/" + strconv.Itoa(pid)
	if !running(pid) {
		return false
	}
	exe, err := os.Readlink(proc + "/exe")
	if err != nil || filepath.Base(strings.TrimSuffix(exe, " (deleted)")) != "stamd" {
		return false
	}
	environ, err := os.ReadFile(proc + "/environ")
	if err != nil {
		return true
	}
	for _, kv := range strings.Split(string(environ), "\x00") {
		if v, ok := strings.CutPrefix(kv, "STAM_HOME="); ok {
			return sameDir(v, home)
		}
	}
	return false
}

// zombie is whether a /proc/PID/stat line says the process has exited and only waits to be reaped.
func zombie(stat []byte) bool {
	s := string(stat)
	i := strings.LastIndex(s, ")")
	return i >= 0 && len(s) > i+2 && s[i+2] == 'Z'
}

func sameDir(a, b string) bool {
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	if errA != nil || errB != nil {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	return ra == rb
}

// daemonStatus prints the daemon's health the way console.log shows an object, which test/lib.sh greps for
// `machine: 'NAME'`; with no answer it prints `stamd not running` and exits 1.
func daemonStatus(ctx context.Context, e env) error {
	raw, err := client.New(e.getenv).Do(ctx, "GET", "/api/health", nil, time.Second)
	var h jsfmt.Value
	if err == nil {
		h, err = jsfmt.Parse(raw)
	}
	if err != nil {
		fmt.Fprintln(e.stdout, "stamd not running")
		return &exitError{code: 1}
	}
	fmt.Fprintln(e.stdout, displayValue(h))
	return nil
}

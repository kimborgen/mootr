package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// goBin is go, from PATH or where the checks install it.
func goBin(t *testing.T) string {
	t.Helper()
	if p, err := exec.LookPath("go"); err == nil {
		return p
	}
	p := filepath.Join(os.Getenv("HOME"), ".local", "go", "bin", "go")
	if _, err := os.Stat(p); err != nil {
		t.Skip("no go to build stamd with")
	}
	return p
}

// seededHome is a test home the way test/lib.sh and the TS daemon leave it: stam.db, token, peer-token.
func seededHome(t *testing.T) string {
	t.Helper()
	home := filepath.Join(t.TempDir(), "home")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("node", "../../internal/server/testdata/seed.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("seed.mjs: %v\n%s", err, out)
	}
	for name, v := range map[string]string{"token": token, "peer-token": "peer-tok"} {
		if err := os.WriteFile(filepath.Join(home, name), []byte(v), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

// testSocket is a tmux socket name of the test's own; its server, if anything started one, and its socket file go at
// the end.
func testSocket(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	name := "stam-test-cli-" + hex.EncodeToString(b)
	t.Cleanup(func() {
		exec.Command("tmux", "-L", name, "kill-server").Run()
		dir := os.Getenv("TMUX_TMPDIR")
		if dir == "" {
			dir = "/tmp"
		}
		os.Remove(filepath.Join(dir, "tmux-"+strconv.Itoa(os.Getuid()), name))
	})
	return name
}

func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
}

// TestDaemonLifecycle: `daemon start` launches the real stamd detached and waits for health, `daemon status` prints the
// machine as lib.sh greps it, a refused command fails with the envelope's text, and `daemon stop`
// ends only this home's daemon.
func TestDaemonLifecycle(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "stamd")
	if out, err := exec.Command(goBin(t), "build", "-o", bin, "../stamd").CombinedOutput(); err != nil {
		t.Fatalf("build stamd: %v\n%s", err, out)
	}
	home := seededHome(t)
	port := freePort(t)
	vars := map[string]string{
		"STAM_HOME": home, "STAM_PORT": port, "STAM_MACHINE": "life-machine", "STAM_STAMD_BIN": bin,
		"STAM_BIND": "127.0.0.1", "STAM_TOKEN": token, "STAM_AGENT_ID": "someagent", "STAM_AGENT_NAME": "x",
		// A socket of the test's own: stamd's reconcile and kill call tmux, and the default socket is the live one.
		"STAM_TMUX_SOCKET": testSocket(t),
	}
	// An agent's own identity and token must not reach the daemon it starts; the client still uses STAM_TOKEN here.
	stdout := &strings.Builder{}
	e := env2(vars, stdout, os.Stderr, "")
	if code := run(context.Background(), []string{"daemon", "start"}, e); code != 0 {
		t.Fatalf("daemon start exited %d", code)
	}
	b, err := os.ReadFile(filepath.Join(home, "daemon.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(string(b))
	t.Cleanup(func() {
		if pid > 0 && running(pid) && isStamd(pid, home) {
			syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	if stdout.String() != "stamd started, pid "+strconv.Itoa(pid)+"\n" {
		t.Errorf("start printed %q", stdout.String())
	}

	// Detached: its own session, the log in the home, and neither the token nor an agent's identity in argv or environment.
	stat, _ := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	fields := strings.Fields(string(stat[strings.LastIndex(string(stat), ")")+2:]))
	if sid := fields[3]; sid != strconv.Itoa(pid) {
		t.Errorf("stamd is in session %s, not its own (%d)", sid, pid)
	}
	cmdline, _ := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	environ, _ := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ")
	if strings.Contains(string(cmdline), token) || strings.Contains(string(environ), token) || strings.Contains(string(environ), "STAM_AGENT_ID") {
		t.Error("the token or the agent's identity reached stamd")
	}
	if _, err := os.Stat(filepath.Join(home, "daemon.log")); err != nil {
		t.Error(err)
	}

	// A second start finds it running and starts nothing.
	stdout.Reset()
	if code := run(context.Background(), []string{"daemon", "start"}, e); code != 0 || stdout.String() != "stamd already running\n" {
		t.Errorf("second start = %d %q", code, stdout.String())
	}

	stdout.Reset()
	if code := run(context.Background(), []string{"daemon", "status"}, e); code != 0 || !strings.Contains(stdout.String(), "machine: 'life-machine'") {
		t.Errorf("status = %d %q", code, stdout.String())
	}

	// A refused request is an error with the envelope's text, exit 1: boss still runs, so it can't be forgotten.
	var o, er strings.Builder
	e2 := env2(vars, &o, &er, "")
	if code := run(context.Background(), []string{"forget", "boss"}, e2); code != 1 || er.String() != "stam: boss is running; shut it down first\n" || o.Len() != 0 {
		t.Errorf("forget on stamd = %d %q %q", code, o.String(), er.String())
	}

	stdout.Reset()
	if code := run(context.Background(), []string{"daemon", "stop"}, e); code != 0 || stdout.String() != "stamd stopped\n" {
		t.Errorf("stop = %d %q", code, stdout.String())
	}
	if running(pid) {
		t.Error("stamd still runs after stop")
	}
	if _, err := os.Stat(filepath.Join(home, "daemon.pid")); err == nil {
		t.Error("the pid file is left")
	}
	if _, err := os.Stat(filepath.Join(home, "stam.db-wal")); err == nil {
		t.Error("stam.db-wal is left: stop didn't wait for the clean shutdown")
	}
	stdout.Reset()
	if code := run(context.Background(), []string{"daemon", "stop"}, e); code != 0 || stdout.String() != "stamd not running\n" {
		t.Errorf("stop again = %d %q", code, stdout.String())
	}
}

// TestStopLeavesOtherProcesses: a pid file naming a live process that isn't a stamd of this home (another program, this
// test, a stamd of another home) is left as it is, and the process is not signalled. A pid file whose process is gone is
// removed.
func TestStopLeavesOtherProcesses(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "stamd")
	if out, err := exec.Command(goBin(t), "build", "-o", bin, "../stamd").CombinedOutput(); err != nil {
		t.Fatalf("build stamd: %v\n%s", err, out)
	}
	// A real stamd serving another home.
	homeA := seededHome(t)
	var o, er strings.Builder
	a := env2(map[string]string{"STAM_HOME": homeA, "STAM_PORT": freePort(t), "STAM_STAMD_BIN": bin, "STAM_MACHINE": "a-machine", "STAM_TMUX_SOCKET": testSocket(t)}, &o, &er, "")
	if code := run(context.Background(), []string{"daemon", "start"}, a); code != 0 {
		t.Fatalf("start A: %d %s", code, er.String())
	}
	pidA := readPid(t, homeA)
	t.Cleanup(func() {
		if running(pidA) && isStamd(pidA, homeA) {
			syscall.Kill(pidA, syscall.SIGKILL)
		}
	})

	other := exec.Command("sleep", "30")
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { other.Process.Kill(); other.Wait() })

	homeB := t.TempDir()
	for name, pid := range map[string]int{"another program": other.Process.Pid, "this test": os.Getpid(), "a stamd of another home": pidA} {
		os.WriteFile(filepath.Join(homeB, "daemon.pid"), []byte(strconv.Itoa(pid)), 0o600)
		var out strings.Builder
		e := env2(map[string]string{"STAM_HOME": homeB}, &out, os.Stderr, "")
		if code := run(context.Background(), []string{"daemon", "stop"}, e); code != 0 || out.String() != "stamd not running\n" {
			t.Errorf("stop with %s = %d %q", name, code, out.String())
		}
		if b, err := os.ReadFile(filepath.Join(homeB, "daemon.pid")); err != nil || string(b) != strconv.Itoa(pid) {
			t.Errorf("stop with %s: the pid file of a live process was changed (%q, %v)", name, b, err)
		}
	}
	time.Sleep(100 * time.Millisecond)
	if !running(other.Process.Pid) || !running(pidA) {
		t.Fatal("stop signalled a process that isn't this home's stamd")
	}
	// The other home's stamd still answers.
	var out strings.Builder
	if code := run(context.Background(), []string{"daemon", "status"}, env2(map[string]string{"STAM_HOME": homeA, "STAM_PORT": a.getenv("STAM_PORT"), "STAM_TOKEN": token}, &out, os.Stderr, "")); code != 0 || !strings.Contains(out.String(), "a-machine") {
		t.Errorf("A's stamd after B's stops: %d %q", code, out.String())
	}

	// A dead pid: the stale file goes.
	dead := exec.Command("true")
	dead.Run()
	os.WriteFile(filepath.Join(homeB, "daemon.pid"), []byte(strconv.Itoa(dead.Process.Pid)), 0o600)
	out.Reset()
	if code := run(context.Background(), []string{"daemon", "stop"}, env2(map[string]string{"STAM_HOME": homeB}, &out, os.Stderr, "")); code != 0 || out.String() != "stamd not running\n" {
		t.Errorf("stop with a dead pid = %d %q", code, out.String())
	}
	if _, err := os.Stat(filepath.Join(homeB, "daemon.pid")); err == nil {
		t.Error("a stale pid file is left")
	}
	out.Reset()
	run(context.Background(), []string{"daemon", "stop"}, a)
}

func readPid(t *testing.T, home string) int {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(home, "daemon.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	return pid
}

func TestStartAndStopNeedAHome(t *testing.T) {
	for _, sub := range []string{"start", "stop"} {
		var o, er strings.Builder
		e := env2(map[string]string{}, &o, &er, "")
		if code := run(context.Background(), []string{"daemon", sub}, e); code != 1 || !strings.Contains(er.String(), "STAM_HOME is not set") {
			t.Errorf("%s = %d %q", sub, code, er.String())
		}
	}
}

// A stamd that exits at once (here: no token files) fails the start with the log's name, without waiting 5 s.
func TestStartReportsAnEarlyExit(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "stamd")
	if out, err := exec.Command(goBin(t), "build", "-o", bin, "../stamd").CombinedOutput(); err != nil {
		t.Fatalf("build stamd: %v\n%s", err, out)
	}
	home := t.TempDir()
	var o, er strings.Builder
	e := env2(map[string]string{"STAM_HOME": home, "STAM_PORT": freePort(t), "STAM_STAMD_BIN": bin, "STAM_TMUX_SOCKET": testSocket(t)}, &o, &er, "")
	start := time.Now()
	code := run(context.Background(), []string{"daemon", "start"}, e)
	if code != 1 || !strings.Contains(er.String(), "stamd exited; see "+filepath.Join(home, "daemon.log")) || time.Since(start) > 4*time.Second {
		t.Errorf("start = %d %q after %s", code, er.String(), time.Since(start))
	}
}

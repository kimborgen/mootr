package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The test binary runs as stamd when this is set, so the test drives the real main in a process of its own.
func TestMain(m *testing.M) {
	if os.Getenv("STAMD_TEST_RUN_MAIN") == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// testSocket is a tmux socket name of the test's own; its server, if anything started one, and its socket file go at
// the end.
func testSocket(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	name := "stam-test-stamd-" + hex.EncodeToString(b)
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

// seededHome is a test home with the seeded stam.db and its token files.
func seededHome(t *testing.T) string {
	t.Helper()
	home := filepath.Join(t.TempDir(), "home")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("node", "../../internal/server/testdata/seed.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("seed.mjs: %v\n%s", err, out)
	}
	for name, v := range map[string]string{"token": "shared-tok", "peer-token": "peer-tok"} {
		if err := os.WriteFile(filepath.Join(home, name), []byte(v), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

// environ is this process's environment without STAM_TMUX_SOCKET, so a test sets the socket itself or leaves it unset.
func environ() []string {
	var out []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "STAM_TMUX_SOCKET=") {
			out = append(out, kv)
		}
	}
	return out
}

// TestRefusesTheLiveSocket: a home that isn't the live one, with no STAM_TMUX_SOCKET, would run its reconcile and kills
// on the live home's socket; stamd refuses to start instead, before it opens the database.
func TestRefusesTheLiveSocket(t *testing.T) {
	home := seededHome(t)
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(environ(), "STAMD_TEST_RUN_MAIN=1", "STAM_HOME="+home, "STAM_PORT="+strconv.Itoa(freePort(t)), "STAM_MACHINE=test-machine", "STAM_BIND=127.0.0.1")
	done := make(chan struct{})
	var out []byte
	var err error
	go func() { out, err = cmd.CombinedOutput(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		<-done
		t.Fatal("stamd started on the live socket")
	}
	if err == nil || !strings.Contains(string(out), "needs a tmux socket of its own: set STAM_TMUX_SOCKET") {
		t.Fatalf("stamd = %v\n%s", err, out)
	}
	if _, err := os.Stat(filepath.Join(home, "stam.db-wal")); err == nil {
		t.Error("stamd opened the database before refusing")
	}
}

// TestSIGTERM: stamd serves a test home, and on SIGTERM ends its event streams, exits 0, and closes the database, so
// no -wal file is left.
func TestSIGTERM(t *testing.T) {
	home := seededHome(t)
	port := freePort(t)
	url := "http://127.0.0.1:" + strconv.Itoa(port)
	var log strings.Builder
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	// A socket of the test's own: stamd's reconcile calls tmux.
	cmd.Env = append(environ(), "STAMD_TEST_RUN_MAIN=1", "STAM_HOME="+home, "STAM_PORT="+strconv.Itoa(port), "STAM_MACHINE=test-machine", "STAM_BIND=127.0.0.1",
		"STAM_TMUX_SOCKET="+testSocket(t))
	cmd.Stdout, cmd.Stderr = &log, &log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	t.Cleanup(func() {
		// By PID only, and only if the test didn't already stop it.
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			<-exited
		}
	})

	get := func(path string) (*http.Response, error) {
		req, _ := http.NewRequest(http.MethodGet, url+path, nil)
		req.Header.Set("Authorization", "Bearer shared-tok")
		return http.DefaultClient.Do(req)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		res, err := get("/api/health")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("stamd didn't answer: %v\n%s", err, log.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(home, "stam.db-wal")); err != nil {
		t.Fatalf("no -wal while stamd runs (%v): the check below would prove nothing", err)
	}
	res, err := get("/api/live")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	r := bufio.NewReader(res.Body)
	if line, _ := r.ReadString('\n'); line != ": connected\n" {
		t.Fatalf("stream starts %q", line)
	}

	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	ended := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, r)
		ended <- err
	}()
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the event stream didn't end on SIGTERM")
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("stamd exited with %v\n%s", err, log.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("stamd didn't exit on SIGTERM\n%s", log.String())
	}
	if _, err := os.Stat(filepath.Join(home, "stam.db-wal")); err == nil {
		t.Fatal("stam.db-wal is left: the database wasn't closed")
	}
}

package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/adapters/opencode"
	"stam/internal/config"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
	"stam/internal/push"
	"stam/internal/templates"
	"stam/internal/tmux"
)

// TestSpawnOpenCodeNeedsTheServer: a daemon whose lifecycle has no shared OpenCode server refuses an OpenCode spawn as
// before (S-4237), before any row; codex stays refused.
func TestSpawnOpenCodeNeedsTheServer(t *testing.T) {
	f := typeSpawnFixture(t)
	if f.srv.life.HasOpenCode() {
		t.Fatal("the fixture's lifecycle has an OpenCode server")
	}
	for _, h := range []string{"opencode", "codex"} {
		rec := f.spawnIn(f.home, `"name":"oc-`+h+`","harness":"`+h+`","prompt":"hi"`)
		if rec.Code != 501 || !strings.Contains(rec.Body.String(), "spawn: "+h+" is not ported to the Go daemon yet") {
			t.Errorf("%s: %d %s", h, rec.Code, rec.Body)
		}
		if n := f.text("SELECT COUNT(*) FROM agents WHERE name = ?", "oc-"+h); n != "0" {
			t.Errorf("%s: %s rows", h, n)
		}
	}
}

// withOpenCode gives the server a lifecycle with the shared OpenCode server, on a tmux server of the test's own, running
// bin as OpenCode; its health polls don't wait. It returns the tmux client and the server.
func withOpenCode(f *fixture, bin string) (*tmux.Client, *opencode.Server) {
	f.t.Helper()
	for _, b := range []string{"tmux", "node"} {
		if _, err := exec.LookPath(b); err != nil {
			f.t.Skip("no " + b)
		}
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	socket := "stam-test-oc-" + hex.EncodeToString(b)
	dir := f.t.TempDir()
	tc := &tmux.Client{Socket: socket, TempDir: dir}
	f.t.Cleanup(func() {
		_ = tc.KillSession(context.Background(), opencode.SessionName)
		tc.Run(context.Background(), nil, "kill-server")
		tmp := os.Getenv("TMUX_TMPDIR")
		if tmp == "" {
			tmp = "/tmp"
		}
		os.Remove(filepath.Join(tmp, "tmux-"+strconv.Itoa(os.Getuid()), socket))
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	must(f.t, err)
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	root, err := filepath.Abs("../../..")
	must(f.t, err)
	settings := config.NewSettingsFile(f.home, f.cfg.Machine)
	userHome := f.t.TempDir()
	oc := &opencode.Server{
		Config: func() opencode.Env {
			return opencode.Env{Home: f.home, UserHome: userHome, Root: root, Bin: filepath.Join(root, "bin", "stam"), Settings: settings.Get(),
				Registry: jsjson.NewObject(), Getenv: os.Getenv}
		},
		Tmux: tc, Bin: bin, Port: port, URL: "http://127.0.0.1:1",
		Sleep: func(ctx context.Context, d time.Duration) error { return ctx.Err() },
	}
	ctx, cancel := context.WithCancel(context.Background())
	// The spawn reads the registry and the templates the Claude env holds.
	tpl := &templates.Set{Root: root, Home: f.home, UserHome: userHome, Settings: settings.Get, Machine: f.cfg.Machine}
	life := lifecycle.New(ctx, lifecycle.Options{DB: f.db, Tmux: tc, Settings: settings, Machine: f.cfg.Machine, OpenCode: oc,
		Claude:         claude.Env{Templates: tpl, ClaudeBin: "/bin/false", Home: f.home, UserHome: userHome},
		OpenCodeSettle: 10 * time.Millisecond, NetworkProbes: []string{"http://127.0.0.1:1/"}, Streams: push.New(), PushDebounce: 20 * time.Millisecond})
	f.t.Cleanup(func() { cancel(); life.Wait() })
	f.srv.life = life
	return tc, oc
}

// TestSpawnOpenCode: with the shared server, an OpenCode spawn starts the server once and the agent's TUI on a session
// the server made, and its first prompt runs there.
func TestSpawnOpenCode(t *testing.T) {
	f := typeSpawnFixture(t)
	root, err := filepath.Abs("../../..")
	must(t, err)
	tc, oc := withOpenCode(f, filepath.Join(root, "test", "fake-opencode", "opencode"))
	// The fake answers once it listens: poll it for real.
	oc.Sleep = nil
	rec := f.spawnIn(f.home, `"name":"oc-dev","harness":"opencode","model":"openrouter/stub/model","prompt":"hello oc"`)
	if rec.Code != 200 {
		t.Fatalf("spawn: %d %s", rec.Code, rec.Body)
	}
	id := f.text("SELECT id FROM agents WHERE name = 'oc-dev'")
	if !tc.HasSession(context.Background(), opencode.SessionName) || !tc.HasSession(context.Background(), id) {
		t.Fatalf("server session %v, TUI session %v", tc.HasSession(context.Background(), opencode.SessionName), tc.HasSession(context.Background(), id))
	}
	for end := time.Now().Add(30 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if f.text("SELECT COUNT(*) FROM events WHERE agent_id = ? AND type = 'first-prompt:delivered'", id) == "1" {
			break
		}
		if time.Now().After(end) {
			t.Fatalf("the first prompt never went in: %s", f.text("SELECT group_concat(type) FROM events WHERE agent_id = ?", id))
		}
	}
	if sid := f.text("SELECT session_id FROM agents WHERE id = ?", id); !strings.HasPrefix(sid, "ses_fake") {
		t.Errorf("session %q; want the server's", sid)
	}
}

// TestSpawnOpenCodeServerFails: a spawn whose server doesn't come up fails, and leaves no `_opencode` session and no
// server process behind.
func TestSpawnOpenCodeServerFails(t *testing.T) {
	f := typeSpawnFixture(t)
	pids := filepath.Join(f.t.TempDir(), "pids")
	deaf := filepath.Join(f.t.TempDir(), "opencode")
	writeFile(t, deaf, fmt.Sprintf("#!/bin/sh\necho \"$$\" >>%q\nexec sleep 1000\n", pids))
	must(t, os.Chmod(deaf, 0o755))
	tc, oc := withOpenCode(f, deaf)
	// Each health poll waits for the pane's pid first, so the failure is the health wait's, not a race with the shell.
	oc.Sleep = func(ctx context.Context, d time.Duration) error {
		for end := time.Now().Add(10 * time.Second); time.Now().Before(end); time.Sleep(10 * time.Millisecond) {
			if b, _ := os.ReadFile(pids); len(b) > 0 {
				break
			}
		}
		return ctx.Err()
	}
	rec := f.spawnIn(f.home, `"name":"oc-dev","harness":"opencode","prompt":"hi"`)
	if rec.Code != 500 || !strings.Contains(rec.Body.String(), "OpenCode server did not start") {
		t.Errorf("spawn: %d %s", rec.Code, rec.Body)
	}
	if st := f.text("SELECT activity || '/' || lifecycle FROM agents WHERE name = 'oc-dev'"); st != "errored/shut_down" {
		t.Errorf("the row: %s; want errored/shut_down", st)
	}
	if tc.HasSession(context.Background(), opencode.SessionName) {
		t.Error("the _opencode session stayed")
	}
	b, _ := os.ReadFile(pids)
	if len(strings.Fields(string(b))) != 1 {
		t.Fatalf("server starts %q; want 1", b)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if err := exec.Command("kill", "-0", strconv.Itoa(pid)).Run(); err == nil {
		t.Errorf("the server's process %d still runs", pid)
	}
}

package lifecycle

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/push"
	"stam/internal/templates"
	"stam/internal/tmux"
)

// live is a test home with a stam.db the TS daemon made, a tmux server on a socket of the test's own, and a fake
// Claude Code that draws its ready prompt and waits. Agent ids here hold an l and a 1, which a stam agent id never
// does, so the process sweep of a kill can't reach a real agent's processes.
type live struct {
	t    *testing.T
	ctx  context.Context
	db   *db.DB
	tmux *tmux.Client
	life *Lifecycle
	opts Options
	work string
	// base is the test's folder: the fake's compaction log (compacts) and its hold and fail flags live there.
	base, home string
	logs       *bytes.Buffer
	// stop ends the daemon context every lifecycle here runs under.
	stop context.CancelFunc
	// netGate, while set, holds every network probe until it is closed (holdNetwork).
	netMu   sync.Mutex
	netGate chan struct{}
}

// fakeClaude is a Claude Code that draws its ready screen and an empty input box and waits; run headless (-p), as a
// compaction runs it, it logs STAM_COMPACTOR, STAM_AGENT_ID and its stdin to BASE/compacts, waits while BASE/hold
// exists, and fails when BASE/fail does.
const fakeClaude = `#!/bin/sh
dir=BASE
for a in "$@"; do [ "$a" = -p ] && headless=1; done
if [ -n "$headless" ]; then
  input=$(cat)
  printf '%s|%s|%s\n' "$STAM_COMPACTOR" "$STAM_AGENT_ID" "$input" >>"$dir/compacts"
  while [ -e "$dir/hold" ]; do sleep 0.05; done
  if [ -e "$dir/fail" ]; then echo "fake compaction failed" >&2; exit 1; fi
  echo '{"type":"result"}'
  exit 0
fi
printf '? for shortcuts\n\342\235\257 \n'
exec sleep 600
`

func newLive(t *testing.T) *live {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	base := t.TempDir()
	home, userHome, work := filepath.Join(base, "home"), filepath.Join(base, "user"), filepath.Join(base, "work")
	for _, d := range []string{home, userHome, work, filepath.Join(base, "bin")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if out, err := exec.Command("node", "../db/testdata/make-fixture.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("make-fixture.mjs: %v\n%s", err, out)
	}
	fake := filepath.Join(base, "bin", "fake-claude")
	if err := os.WriteFile(fake, []byte(strings.Replace(fakeClaude, "BASE", base, 1)), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	d, err := db.Open(ctx, filepath.Join(home, "stam.db"), db.Options{})
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	socket := "stam-test-life-" + hex.EncodeToString(b)
	tc := &tmux.Client{Socket: socket, TempDir: base}
	t.Cleanup(func() {
		tc.Run(context.Background(), nil, "kill-server")
		dir := os.Getenv("TMUX_TMPDIR")
		if dir == "" {
			dir = "/tmp"
		}
		os.Remove(filepath.Join(dir, "tmux-"+strconv.Itoa(os.Getuid()), socket))
	})
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	l := &live{t: t, ctx: ctx, stop: cancel, db: d, tmux: tc, work: work, base: base, home: home}
	// The network the recovery of lost agents waits for: a local server, which a test can hold.
	probe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		l.netMu.Lock()
		gate := l.netGate
		l.netMu.Unlock()
		if gate != nil {
			<-gate
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(probe.Close)
	settings := config.NewSettingsFile(home, "test-machine")
	opts := Options{DB: d, Tmux: tc, Settings: settings, URL: "http://127.0.0.1:1", Machine: "test-machine",
		NetworkProbes: []string{probe.URL}, RecoverStagger: 10 * time.Millisecond, Streams: push.New(), PushDebounce: 20 * time.Millisecond,
		Claude: claude.Env{Home: home, UserHome: userHome, Bin: filepath.Join(root, "bin", "stam"), ClaudeBin: fake, UID: os.Getuid(),
			TestTmpBase: claude.TestTmpBase(func(string) string { return "" }, userHome),
			Templates:   &templates.Set{Root: root, Home: home, UserHome: userHome, Settings: settings.Get}}}
	logs := &bytes.Buffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	l.opts, l.logs = opts, logs
	l.life = New(ctx, opts)
	t.Cleanup(func() {
		l.releaseNetwork()
		cancel()
		l.life.Wait()
		d.Close()
		slog.SetDefault(prev)
	})
	return l
}

// holdNetwork holds the network probes until releaseNetwork, so a recovery waits where the test can look.
func (l *live) holdNetwork() {
	l.netMu.Lock()
	defer l.netMu.Unlock()
	if l.netGate == nil {
		l.netGate = make(chan struct{})
	}
}

func (l *live) releaseNetwork() {
	l.netMu.Lock()
	defer l.netMu.Unlock()
	if l.netGate != nil {
		close(l.netGate)
		l.netGate = nil
	}
}

// setSettings writes the home's settings.json.
func (l *live) setSettings(text string) {
	l.t.Helper()
	if err := os.WriteFile(filepath.Join(l.home, "settings.json"), []byte(text), 0o600); err != nil {
		l.t.Fatal(err)
	}
}

// prime takes the tmux server running now as the one life last saw, as StartReconcile does, without its loop.
func (l *live) prime(life *Lifecycle) {
	life.reconcile.server, _ = l.tmux.ServerID(l.ctx)
	life.reconcile.startedAt = time.Now()
}

// spawn makes an agent row as spawn does, under the parent if one is given, and starts its harness.
func (l *live) spawn(id string, parent ...string) db.Agent {
	l.t.Helper()
	session := "11111111-2222-4333-8444-" + strings.Repeat("5", 12)
	var parentID *string
	if len(parent) > 0 {
		parentID = &parent[0]
	}
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: id, Name: "n-" + id, Role: "developer", Machine: "test-machine", Harness: "claude",
		Cwd: l.work, SessionID: &session, ParentID: parentID}); err != nil {
		l.t.Fatal(err)
	}
	workspace := `{"spec":{"kind":"dir","path":"` + l.work + `"},"cwd":"` + l.work + `"}`
	if err := l.db.UpdateAgent(l.ctx, id, db.Field{Col: "workspace", Val: workspace}, db.Field{Col: "permission_mode", Val: "auto"}); err != nil {
		l.t.Fatal(err)
	}
	if err := l.life.StartHarness(l.ctx, l.agent(id), "", false, "spawn"); err != nil {
		l.t.Fatal(err)
	}
	l.until("the launch to settle", func() bool { ok, _ := l.db.HasEvent(l.ctx, id, "first-prompt:delivered"); return ok })
	return l.agent(id)
}

func (l *live) agent(id string) db.Agent {
	l.t.Helper()
	a, err := l.db.GetAgent(l.ctx, id)
	if err != nil {
		l.t.Fatal(err)
	}
	return a
}

func (l *live) until(what string, ok func() bool) {
	l.t.Helper()
	end := time.Now().Add(20 * time.Second)
	for !ok() {
		if time.Now().After(end) {
			l.t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// reconcile runs one pass over a fresh snapshot, after any row written so far is older than the snapshot's start.
func (l *live) reconcile(life *Lifecycle) {
	time.Sleep(5 * time.Millisecond)
	life.Reconcile(l.ctx, l.tmux.Snapshot(l.ctx))
}

func detailOf(a db.Agent) string {
	if a.ActivityDetail == nil {
		return ""
	}
	return *a.ActivityDetail
}

// TestLiveLifecycle starts two agents on a tmux server of the test's own and checks: the session's token is the
// agent's own and shows nowhere else; a daemon restart under the live server leaves the agents alone; a kill ends
// only that agent's session; a harness that exits is shut down; and a lost server marks the rest lost, to resume.
func TestLiveLifecycle(t *testing.T) {
	l := newLive(t)
	a := l.spawn("alfe1")
	b := l.spawn("alfe2")
	if a.Lifecycle != "active" || a.Activity != "starting" || a.TokenHash == nil || a.TokenHash.Reveal() == "" {
		t.Fatalf("after the launch: %s %s token %v", a.Lifecycle, a.Activity, a.TokenHash != nil)
	}

	// The token: in the session's env, matching the stored hash, and in no event, log line or tmux argv.
	r := l.tmux.Run(l.ctx, nil, "show-environment", "-t", "=alfe1", "STAM_TOKEN")
	token := strings.TrimPrefix(strings.TrimSpace(r.Stdout), "STAM_TOKEN=")
	if r.Status != 0 || token == "" || auth.Hash(token) != a.TokenHash.Reveal() {
		t.Fatalf("session token: %d %q", r.Status, r.Stdout)
	}
	evs, err := l.db.ListEvents(l.ctx, "alfe1", 1000, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range evs {
		if e.Data != nil && strings.Contains(*e.Data, token) {
			t.Errorf("event %s holds the token", e.Type)
		}
	}
	if strings.Contains(l.logs.String(), token) {
		t.Error("the logs hold the token")
	}
	if pid, ok := l.tmux.ServerID(l.ctx); ok {
		cmdline, _ := os.ReadFile("/proc/" + strings.Fields(pid)[0] + "/cmdline")
		if bytes.Contains(cmdline, []byte(token)) {
			t.Error("the tmux server's argv holds the token")
		}
	}

	// alfe6's harness ends while the daemon is down: its session is gone at the restart.
	l.spawn("alfe6")
	if err := l.tmux.KillSession(l.ctx, "alfe6"); err != nil {
		t.Fatal(err)
	}

	// A hook moves the agent off starting, as the harness's first turn would.
	for _, id := range []string{"alfe1", "alfe2", "alfe6"} {
		if err := l.db.UpdateAgent(l.ctx, id, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "turn finished"}); err != nil {
			t.Fatal(err)
		}
	}

	// A restart: a new lifecycle on the live server takes its id at start, and its first pass loses no one. The agent
	// whose session went meanwhile exited: the server didn't go, so it isn't lost.
	restarted := New(l.ctx, l.opts)
	restarted.StartReconcile()
	t.Cleanup(func() { l.stop(); restarted.Wait() })
	l.reconcile(restarted)
	for _, id := range []string{"alfe1", "alfe2"} {
		if got := l.agent(id); got.Lifecycle != "active" || got.Activity != "idle" {
			t.Errorf("%s after the restart's first pass: %s %s %q", id, got.Lifecycle, got.Activity, detailOf(got))
		}
	}
	if got := l.agent("alfe6"); got.Lifecycle != "shut_down" || detailOf(got) != "harness exited" || got.PendingAction != nil {
		t.Errorf("alfe6 after the restart's first pass: %s %q pending %v", got.Lifecycle, detailOf(got), got.PendingAction)
	}

	// A kill ends that agent's session only.
	if err := restarted.Shutdown(l.ctx, a); err != nil {
		t.Fatal(err)
	}
	if l.tmux.HasSession(l.ctx, "alfe1") || !l.tmux.HasSession(l.ctx, "alfe2") {
		t.Fatalf("after killing alfe1: alfe1 %v, alfe2 %v", l.tmux.HasSession(l.ctx, "alfe1"), l.tmux.HasSession(l.ctx, "alfe2"))
	}
	if got := l.agent("alfe1"); got.Lifecycle != "shut_down" || detailOf(got) != "shut down" {
		t.Errorf("killed agent: %s %q", got.Lifecycle, detailOf(got))
	}
	if ok, _ := l.db.HasEvent(l.ctx, "alfe1", "shutdown"); !ok {
		t.Error("no shutdown event")
	}

	// A harness that exits leaves a dead pane (remain-on-exit): the next pass shuts the agent down.
	c := l.spawn("alfe3")
	if err := l.db.UpdateAgent(l.ctx, "alfe3", db.Field{Col: "activity", Val: "idle"}); err != nil {
		t.Fatal(err)
	}
	r = l.tmux.Run(l.ctx, nil, "list-panes", "-t", "=alfe3:", "-F", "#{pane_pid}")
	pid, err := strconv.Atoi(strings.TrimSpace(r.Stdout))
	if err != nil || pid <= 1 {
		t.Fatalf("pane pid %q", r.Stdout)
	}
	p, _ := os.FindProcess(pid)
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	l.until("the pane to die", func() bool { return l.tmux.IsDead(l.ctx, "alfe3") })
	l.reconcile(restarted)
	if got := l.agent("alfe3"); got.Lifecycle != "shut_down" || detailOf(got) != "harness exited" {
		t.Errorf("exited agent: %s %q", got.Lifecycle, detailOf(got))
	}
	if ok, _ := l.db.HasEvent(l.ctx, "alfe3", "exited"); !ok {
		t.Error("no exited event")
	}
	if got := l.agent("alfe2"); got.Lifecycle != "active" {
		t.Errorf("alfe2 went with alfe3: %s %q", got.Lifecycle, detailOf(got))
	}
	_ = c

	// The whole server goes: the agent with a session to resume is marked lost, with a pending recover, and resumed once
	// the network answers.
	l.holdNetwork()
	l.tmux.Run(l.ctx, nil, "kill-server")
	l.reconcile(restarted)
	got := l.agent("alfe2")
	if got.Lifecycle != "shut_down" || detailOf(got) != "stam's tmux server stopped; resuming" || got.PendingAction == nil ||
		*got.PendingAction != `{"type":"recover","reason":"stam's tmux server stopped"}` {
		t.Errorf("lost agent: %s %q pending %v", got.Lifecycle, detailOf(got), got.PendingAction)
	}
	if ok, _ := l.db.HasEvent(l.ctx, "alfe2", "tmux-lost"); !ok {
		t.Error("no tmux-lost event")
	}
	l.releaseNetwork()
	l.until("alfe2's recovery", func() bool { ok, _ := l.db.HasEvent(l.ctx, "alfe2", "recover"); return ok })
	if e := lastEvent(t, l, "alfe2", "recover"); e != `{"reason":"stam's tmux server stopped"}` {
		t.Errorf("recover event: %s", e)
	}
	if got := l.agent("alfe2"); got.Lifecycle != "active" || got.PendingAction != nil || !l.tmux.HasSession(l.ctx, "alfe2") {
		t.Errorf("recovered agent: %s %q pending %v", got.Lifecycle, detailOf(got), got.PendingAction)
	}
	// The agents that stopped before the server went stay stopped.
	for _, id := range []string{"alfe1", "alfe3", "alfe6"} {
		if l.tmux.HasSession(l.ctx, id) {
			t.Errorf("%s came back with the recovery", id)
		}
	}
	_ = b
}

// lastEvent is the data of the agent's latest event of typ, "" when there is none.
func lastEvent(t *testing.T, l *live, id, typ string) string {
	t.Helper()
	evs, err := l.db.ListEvents(l.ctx, id, 1, typ)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) == 0 || evs[0].Data == nil {
		return ""
	}
	return *evs[0].Data
}

// TestReconcileSkipsAFailedSnapshot: a tmux call that failed without saying the server is gone changes nothing.
func TestReconcileSkipsAFailedSnapshot(t *testing.T) {
	l := newLive(t)
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "alfe4", Name: "n-alfe4", Machine: "test-machine", Harness: "claude", Cwd: l.work}); err != nil {
		t.Fatal(err)
	}
	if err := l.db.UpdateAgent(l.ctx, "alfe4", db.Field{Col: "workspace", Val: "{}"}, db.Field{Col: "activity", Val: "idle"}); err != nil {
		t.Fatal(err)
	}
	l.life.Reconcile(l.ctx, nil)
	if got := l.agent("alfe4"); got.Lifecycle != "active" {
		t.Errorf("a nil snapshot shut the agent down: %s %q", got.Lifecycle, detailOf(got))
	}
}

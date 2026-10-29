package proctree

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// start runs script in sh with STAM_AGENT_ID=id (none when id is "") plus extra env, in dir, as an orphan: the shell
// that starts it exits at once, so its parent is no longer this test, which as an agent's own process (it runs with
// its agent's STAM_AGENT_ID) would protect everything below it. Args follow the script as $0, $1, …. It returns the
// orphan's pid, and kills its process group when the test ends.
func start(t *testing.T, id, dir string, extra []string, script string, args ...string) int {
	t.Helper()
	argv := append([]string{"-c", `sh -c "$0" "$@" </dev/null >/dev/null 2>&1 & echo $!`, script}, args...)
	cmd := exec.Command("sh", argv...)
	cmd.Dir = dir
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH")}, extra...)
	if id != "" {
		cmd.Env = append(cmd.Env, "STAM_AGENT_ID="+id)
	}
	// A group of its own, which the orphan keeps, so the cleanup takes its children too.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		t.Fatal(err)
	}
	pgid := cmd.Process.Pid
	t.Cleanup(func() { _ = syscall.Kill(-pgid, syscall.SIGKILL) })
	return pid
}

// tempDir is t.TempDir() resolved: /proc gives a process's cwd resolved, and a TMPDIR may not be.
func tempDir(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// gone waits until pid has exited (or is a zombie).
func gone(t *testing.T, pid int) bool {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		if s, ok := readStat(pid); !ok || s.state == "Z" {
			return true
		}
	}
	return false
}

// children waits until pid has n children and returns them.
func children(t *testing.T, pid, n int) []int {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		var out []int
		for _, p := range pids() {
			if s, ok := readStat(p); ok && s.ppid == pid {
				out = append(out, p)
			}
		}
		if len(out) >= n {
			return out
		}
	}
	t.Fatalf("pid %d never had %d children", pid, n)
	return nil
}

func TestAgentProcesses(t *testing.T) {
	id := "agent-pt-" + strconv.Itoa(os.Getpid())
	dir := tempDir(t)
	mine := start(t, id, dir, nil, "sleep 300 & sleep 300 & wait")
	kids := children(t, mine, 2)
	other := start(t, "someone-else", dir, nil, "sleep 300 & wait")
	// A process of another agent's that carries this agent's id below it is that agent's, not this one's.
	underOther := start(t, "someone-else", dir, nil, "STAM_AGENT_ID="+id+" sleep 300 & wait")
	otherKids := children(t, underOther, 1)

	got := AgentProcesses(id, 0, nil)
	for _, p := range append([]int{mine}, kids...) {
		if _, ok := got[p]; !ok {
			t.Errorf("pid %d carries the id but wasn't found: %v", p, got)
		}
	}
	for _, p := range append([]int{other, os.Getpid()}, otherKids...) {
		if _, ok := got[p]; ok {
			t.Errorf("pid %d isn't the agent's, yet was found", p)
		}
	}
	// By the pane: the tree under it counts whatever its env, spare pids don't.
	tree := start(t, "", dir, nil, "sleep 300 & wait")
	treeKids := children(t, tree, 1)
	byPane := AgentProcesses("no-such-agent", tree, []int{treeKids[0]})
	if _, ok := byPane[tree]; !ok || len(byPane) != 1 {
		t.Errorf("by pane %d sparing %d: %v", tree, treeKids[0], byPane)
	}
	if got[mine] != ProcStart(mine) || got[mine] == "" {
		t.Error("the start time doesn't match the process's")
	}

	if err := StopAndConfirm(context.Background(), got, time.Second); err != nil {
		t.Fatal(err)
	}
	for _, p := range append([]int{mine}, kids...) {
		if !gone(t, p) {
			t.Errorf("pid %d still runs", p)
		}
	}
	if ProcStart(other) == "" {
		t.Error("another agent's process was stopped")
	}
	// A pid paired with a start time that isn't its own is never signalled.
	if n := SignalProcesses(Procs{other: "1"}, syscall.SIGTERM); n != 0 {
		t.Errorf("signalled %d processes with a stale start time", n)
	}
}

func TestDirAndCompactorProcesses(t *testing.T) {
	id := "agent-dir-" + strconv.Itoa(os.Getpid())
	dir := tempDir(t)
	inDir := start(t, id, dir, nil, "sleep 300; :")
	elsewhere := start(t, id, tempDir(t), nil, "sleep 300; :")
	notMine := start(t, "other-agent", dir, nil, "sleep 300; :")
	byArg := start(t, id, tempDir(t), nil, "sleep 300; :", "x", dir+"/file")
	got := DirProcesses(dir, id)
	for _, c := range []struct {
		pid  int
		want bool
	}{{inDir, true}, {byArg, true}, {elsewhere, false}, {notMine, false}} {
		if _, ok := got[c.pid]; ok != c.want {
			t.Errorf("DirProcesses: pid %d found %v, want %v", c.pid, ok, c.want)
		}
	}

	comp := start(t, "", tempDir(t), []string{"STAM_COMPACTOR=" + id + ":1"}, "sleep 300; :", "x", "-p", "--resume", "sess-1")
	old := start(t, "", dir, nil, "sleep 300; :", "x", "-p", "--resume", "sess-1")
	otherSession := start(t, "", dir, []string{"STAM_COMPACTOR=" + id + ":1"}, "sleep 300; :", "x", "-p", "--resume", "sess-2")
	cp := CompactorProcesses(id, "sess-1", dir)
	for _, c := range []struct {
		pid  int
		want bool
	}{{comp, true}, {old, true}, {otherSession, false}} {
		if _, ok := cp[c.pid]; ok != c.want {
			t.Errorf("CompactorProcesses: pid %d found %v, want %v", c.pid, ok, c.want)
		}
	}
}

func TestFakeProc(t *testing.T) {
	root := tempDir(t)
	write := func(pid, file, text string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(root, pid), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, pid, file), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// comm with spaces and parens: fields resume after the last ')'.
	write("42", "stat", "42 (we) ird (x)) S 7 42 42 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 98765 1000 100\n")
	write("43", "cmdline", "node\x00/x/src/cli.ts\x00daemon\x00run\x00")
	write("44", "cmdline", "/r/bin/stam\x00daemon\x00run\x00")
	write("45", "cmdline", "/r/bin/stamx\x00daemon\x00run\x00")
	write("46", "cmdline", "daemon\x00run\x00")
	old := procDir
	procDir = root
	defer func() { procDir = old }()
	s, ok := readStat(42)
	if !ok || s.ppid != 7 || s.start != "98765" || s.state != "S" {
		t.Fatalf("stat %+v %v", s, ok)
	}
	for pid, want := range map[int]bool{43: true, 44: true, 45: false, 46: false, 47: false} {
		if IsStamDaemon(pid) != want {
			t.Errorf("IsStamDaemon(%d) = %v", pid, !want)
		}
	}
}

func TestClaudeSlugMatchesTS(t *testing.T) {
	cwds := []string{"/home/u/projects/stam2", "/a b/c.d_e-f", "/ünï/😀/x", ""}
	in, _ := json.Marshal(cwds)
	ts, _ := filepath.Abs("../../../src/proctree.ts")
	out, err := exec.Command("node", "--input-type=module", "-e",
		`const { claudeSlug } = await import(process.argv[1]); process.stdout.write(JSON.stringify(JSON.parse(process.argv[2]).map(claudeSlug)));`,
		ts, string(in)).Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	var want []string
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	for i, c := range cwds {
		if got := ClaudeSlug(c); got != want[i] {
			t.Errorf("ClaudeSlug(%q) = %q, TS %q", c, got, want[i])
		}
	}
}

func TestDirInUse(t *testing.T) {
	dir := tempDir(t)
	if DirInUse(dir) {
		t.Fatal("an unused dir is in use")
	}
	start(t, "", dir, nil, "sleep 300; :")
	for end := time.Now().Add(5 * time.Second); !DirInUse(dir); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatal("a process's cwd doesn't count")
		}
	}
}

// Shared infrastructure is a root: a stam daemon or a tmux server that carries the agent's id protects itself and
// everything under it, as a daemon the agent started by hand passes the id on.
func TestInfrastructureIsRoot(t *testing.T) {
	id := "agent-infra-" + strconv.Itoa(os.Getpid())
	dir := tempDir(t)
	bin := filepath.Join(dir, "stam")
	if err := os.WriteFile(bin, []byte("sleep 300 & sleep 300 & wait\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	daemon := start(t, id, dir, nil, `exec sh "$0" daemon run`, bin)
	daemonKids := children(t, daemon, 2)
	// A process may rename itself: the shell's builtin printf writes its own comm, and its children's exec resets theirs.
	server := start(t, id, dir, nil, `printf 'tmux: server' >/proc/self/comm; sleep 300 & wait`)
	serverKids := children(t, server, 1)
	plain := start(t, id, dir, nil, "sleep 300; :")
	if c, _ := comm(server); c != "tmux: server" {
		t.Fatalf("comm %q", c)
	}
	if !IsStamDaemon(daemon) {
		t.Fatal("the fake daemon isn't one")
	}
	got := AgentProcesses(id, 0, nil)
	for _, p := range append(append([]int{daemon, server}, daemonKids...), serverKids...) {
		if _, ok := got[p]; ok {
			t.Errorf("pid %d lies under infrastructure, yet was found: %v", p, got)
		}
	}
	if _, ok := got[plain]; !ok {
		t.Errorf("pid %d carries the id but wasn't found: %v", plain, got)
	}
}

// The walk down from the pane stops at another agent's process: that one and its subtree are that agent's.
func TestPaneWalkStopsAtOtherAgent(t *testing.T) {
	dir := tempDir(t)
	pane := start(t, "", dir, nil, `sleep 300 & STAM_AGENT_ID=someone-else sh -c 'sleep 300 & wait' & wait`)
	// A child shows the shell's environment until its exec sets STAM_AGENT_ID, so wait for the other agent's marker.
	var kids []int
	var other, own int
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end) && (other == 0 || own == 0); time.Sleep(20 * time.Millisecond) {
		kids, other, own = children(t, pane, 2), 0, 0
		for _, k := range kids {
			if v, _ := envValue(k, "STAM_AGENT_ID"); v == "someone-else" {
				other = k
			} else {
				own = k
			}
		}
	}
	if other == 0 || own == 0 {
		t.Fatalf("children %v", kids)
	}
	otherKids := children(t, other, 1)
	got := AgentProcesses("no-such-agent", pane, nil)
	for _, p := range []int{pane, own} {
		if _, ok := got[p]; !ok {
			t.Errorf("pid %d is in the pane's tree but wasn't found: %v", p, got)
		}
	}
	for _, p := range append([]int{other}, otherKids...) {
		if _, ok := got[p]; ok {
			t.Errorf("pid %d is another agent's, yet was found: %v", p, got)
		}
	}
}

// Exited: gone, reused or a zombie is an exit; a stat that can't be read or parsed is an error, never an exit.
func TestExited(t *testing.T) {
	root := tempDir(t)
	write := func(pid, text string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(root, pid), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, pid, "stat"), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("50", "50 (opencode) S 7 50 50 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 1000 1000 100\n")
	write("51", "51 (opencode) Z 7 51 51 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 1000 1000 100\n")
	write("52", "garbage\n")
	// A stat that is a folder can't be read: an error other than not-found.
	if err := os.MkdirAll(filepath.Join(root, "53", "stat"), 0o700); err != nil {
		t.Fatal(err)
	}
	old := procDir
	procDir = root
	defer func() { procDir = old }()
	for _, c := range []struct {
		pid     int
		start   string
		exited  bool
		failing bool
	}{
		{50, "1000", false, false},
		{50, "999", true, false},
		{51, "1000", true, false},
		{49, "1000", true, false},
		{52, "1000", false, true},
		{53, "1000", false, true},
	} {
		got, err := Exited(c.pid, c.start)
		if got != c.exited || (err != nil) != c.failing {
			t.Errorf("Exited(%d, %s) = %v, %v; want %v, error %v", c.pid, c.start, got, err, c.exited, c.failing)
		}
	}
	for _, c := range []struct {
		pid           int
		start         string
		gone, failing bool
	}{{50, "1000", false, false}, {51, "", true, false}, {49, "", true, false}, {52, "", false, true}, {53, "", false, true}} {
		start, gone, err := StartOf(c.pid)
		if start != c.start || gone != c.gone || (err != nil) != c.failing {
			t.Errorf("StartOf(%d) = %q, %v, %v; want %q, %v, error %v", c.pid, start, gone, err, c.start, c.gone, c.failing)
		}
	}
}

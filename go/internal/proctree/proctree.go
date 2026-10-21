// Package proctree finds the processes an agent started, so archive and shutdown can stop them: a port of the /proc
// walk in src/proctree.ts (S-323, S-428, S-358; Go port S-2804). It finds the tree under an agent's pane and every
// process that carries its STAM_AGENT_ID: a sandbox's children (Codex runs commands under bwrap --new-session) leave
// the pane's process group, and a process whose parent died is reparented out of the tree, but the env goes with both.
// Shared infrastructure an agent may have started (a stam daemon, a tmux server) and another agent's processes are
// never its own, and neither is anything under them.
//
// Every signal goes to a pid paired with its start time, read again right before the signal, so a pid reused since the
// walk is spared; one reused between that read and the kill can still be hit (accepted in S-323's review). Linux only.
//
// Not yet ported (archive's janitor, a later PR): removeClaudeScratch, removeAgentScratchDirs, the review-dir helpers.
package proctree

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// procDir is /proc; tests point it at a fake tree.
var procDir = "/proc"

// Procs maps a pid to its start time (field 22 of /proc/PID/stat).
type Procs map[int]string

type stat struct {
	ppid  int
	start string
	state string
}

func readStat(pid int) (stat, bool) {
	b, err := os.ReadFile(filepath.Join(procDir, strconv.Itoa(pid), "stat"))
	if err != nil {
		return stat{}, false
	}
	s := string(b)
	// comm may hold spaces and parens; fields resume after the last ')'.
	i := strings.LastIndex(s, ")")
	if i < 0 || i+2 > len(s) {
		return stat{}, false
	}
	rest := strings.Split(s[i+2:], " ")
	if len(rest) < 20 {
		return stat{}, false
	}
	ppid, _ := strconv.Atoi(rest[1])
	return stat{ppid: ppid, start: rest[19], state: rest[0]}, true
}

// ProcStart is a process's start time, to pair with its pid for SignalProcesses; "" when it is gone.
func ProcStart(pid int) string {
	s, _ := readStat(pid)
	return s.start
}

func pids() []int {
	entries, err := os.ReadDir(procDir)
	if err != nil {
		return nil
	}
	var out []int
	for _, e := range entries {
		if n, err := strconv.Atoi(e.Name()); err == nil && n > 0 && strconv.Itoa(n) == e.Name() {
			out = append(out, n)
		}
	}
	return out
}

func readNul(pid int, file string) ([]string, error) {
	b, err := os.ReadFile(filepath.Join(procDir, strconv.Itoa(pid), file))
	if err != nil {
		return nil, err
	}
	return strings.Split(string(b), "\x00"), nil
}

// envValue is the value of key in pid's environment, and whether it is set.
func envValue(pid int, key string) (string, bool) {
	env, err := readNul(pid, "environ")
	if err != nil {
		return "", false
	}
	for _, e := range env {
		if v, ok := strings.CutPrefix(e, key+"="); ok {
			return v, true
		}
	}
	return "", false
}

var stamBin = regexp.MustCompile(`(^|/)(stam|cli\.ts)$`)

// IsStamDaemon is whether pid is a stam daemon (`… stam|cli.ts daemon run`), by its command line.
func IsStamDaemon(pid int) bool {
	argv, err := readNul(pid, "cmdline")
	if err != nil {
		return false
	}
	for i, a := range argv {
		if a == "daemon" {
			return i > 0 && i+1 < len(argv) && argv[i+1] == "run" && stamBin.MatchString(argv[i-1])
		}
	}
	return false
}

func comm(pid int) (string, error) {
	b, err := os.ReadFile(filepath.Join(procDir, strconv.Itoa(pid), "comm"))
	return strings.TrimSpace(string(b)), err
}

// infrastructure is a stam daemon or a tmux server, which agents share.
func infrastructure(pid int) bool {
	c, err := comm(pid)
	if err != nil {
		return false
	}
	return c == "tmux: server" || IsStamDaemon(pid)
}

// ancestors is this process and its ancestors, which no sweep may take.
func ancestors(ppid func(int) int) map[int]bool {
	keep := map[int]bool{}
	for p, i := os.Getpid(), 0; p > 1 && i < 1000; p, i = ppid(p), i+1 {
		keep[p] = true
	}
	return keep
}

// AgentProcesses is the pids to stop for agent id, each with its start time: panePid and its descendants when panePid
// is above 0, and every process whose env names id. Protected are shared infrastructure and another agent's processes,
// and everything under them, in both: a daemon the agent ran by hand passes its id on to its children, which are the
// daemon's. Never this process, its ancestors, or the pids in spare.
func AgentProcesses(id string, panePid int, spare []int) Procs {
	all := map[int]stat{}
	for _, pid := range pids() {
		if s, ok := readStat(pid); ok {
			all[pid] = s
		}
	}
	keep := ancestors(func(p int) int { return all[p].ppid })
	for _, p := range spare {
		keep[p] = true
	}
	type owner struct {
		id string
		ok bool
	}
	ids := map[int]owner{}
	idOf := func(pid int) (string, bool) {
		o, seen := ids[pid]
		if !seen {
			o.id, o.ok = envValue(pid, "STAM_AGENT_ID")
			ids[pid] = o
		}
		return o.id, o.ok
	}
	root := func(pid int) bool {
		o, _ := idOf(pid)
		return (o != "" && o != id) || infrastructure(pid)
	}
	// Whether pid is protected: a root, or below one before the pane (the agent's own tree).
	below := map[int]bool{}
	isProtected := func(pid int) bool {
		var path []int
		found := false
		for p := pid; p > 1 && p != panePid && len(path) < 1000; p = all[p].ppid {
			if known, ok := below[p]; ok {
				found = known
				break
			}
			path = append(path, p)
			if root(p) {
				found = true
				break
			}
		}
		// Each process on the path lies above the root found, or none was found: one answer for all.
		for _, q := range path {
			below[q] = found
		}
		return found
	}
	out := Procs{}
	add := func(pid int) {
		if s, ok := all[pid]; ok && pid > 1 && !keep[pid] {
			out[pid] = s.start
		}
	}
	if _, ok := all[panePid]; panePid > 0 && ok {
		children := map[int][]int{}
		for pid, s := range all {
			children[s.ppid] = append(children[s.ppid], pid)
		}
		todo := []int{panePid}
		for len(todo) > 0 {
			pid := todo[len(todo)-1]
			todo = todo[:len(todo)-1]
			if pid != panePid && root(pid) {
				continue
			}
			add(pid)
			todo = append(todo, children[pid]...)
		}
	}
	for pid := range all {
		if _, done := out[pid]; done {
			continue
		}
		if o, ok := idOf(pid); ok && o == id && !isProtected(pid) {
			add(pid)
		}
	}
	return out
}

var testHomeRe = regexp.MustCompile(`(^|/)stam-[^/]*`)

// DirProcesses is the processes of agent id that lie in dir when it is archived (S-428): a cwd inside it, or a path
// inside it in the command line. Only the agent's own are taken: a process that carries its STAM_AGENT_ID, or a
// test's (STAM_HOME in a stam-test.* or stam-* test folder, which lib.sh and tempHome give a daemon without the agent's
// id). A person's shell or editor in the folder, another agent's process, this process and its ancestors, and a tmux
// server that isn't a test's own (socket stam-test-*) are spared.
func DirProcesses(dir, id string) Procs {
	out := Procs{}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return out
	}
	if root, err = filepath.Abs(root); err != nil {
		return out
	}
	inside := func(p string) bool { return p == root || strings.HasPrefix(p, root+"/") }
	keep := ancestors(func(p int) int { s, _ := readStat(p); return s.ppid })
	for _, pid := range pids() {
		if pid <= 1 || keep[pid] {
			continue
		}
		argv, err := readNul(pid, "cmdline")
		if err != nil {
			continue
		}
		hit := false
		if cwd, err := filepath.EvalSymlinks(filepath.Join(procDir, strconv.Itoa(pid), "cwd")); err == nil {
			hit = inside(cwd)
		}
		for _, a := range argv {
			if hit {
				break
			}
			hit = inside(a) || strings.Contains(a, "="+root+"/") || strings.Contains(a, " "+root+"/") || strings.Contains(a, "'"+root+"/")
		}
		if !hit {
			continue
		}
		env, err := readNul(pid, "environ")
		if err != nil {
			continue
		}
		// The first of each, as TS's find takes.
		var agent, home string
		var hasAgent, hasHome bool
		for _, e := range env {
			if v, ok := strings.CutPrefix(e, "STAM_AGENT_ID="); ok && !hasAgent {
				agent, hasAgent = v, true
			}
			if v, ok := strings.CutPrefix(e, "STAM_HOME="); ok && !hasHome {
				home, hasHome = v, true
			}
		}
		if agent != "" {
			if agent != id {
				continue
			}
		} else if !testHomeRe.MatchString(home) {
			continue
		}
		c, err := comm(pid)
		if err != nil {
			continue
		}
		if c == "tmux: server" && !anyPrefix(argv, "stam-test-") {
			continue
		}
		if s, ok := readStat(pid); ok {
			out[pid] = s.start
		}
	}
	return out
}

func anyPrefix(argv []string, prefix string) bool {
	for _, a := range argv {
		if strings.HasPrefix(a, prefix) {
			return true
		}
	}
	return false
}

// CompactorProcesses is the headless compactors running on agent id's session (S-358): a daemon restart cuts them off
// from the daemon that started them. One is a process whose command line resumes session in print mode
// (`-p … --resume SESSION`), and that carries STAM_COMPACTOR=ID:… or, started before that marker existed, runs in the
// agent's workspace cwd.
func CompactorProcesses(id, session, cwd string) Procs {
	out := Procs{}
	self := os.Getpid()
	for _, pid := range pids() {
		if pid == self {
			continue
		}
		argv, err := readNul(pid, "cmdline")
		if err != nil {
			continue
		}
		r := index(argv, "--resume")
		if r < 0 || r+1 >= len(argv) || argv[r+1] != session || index(argv, "-p") < 0 {
			continue
		}
		// TS reads the environ before either test, and an unreadable one throws, which skips the process.
		if _, err := readNul(pid, "environ"); err != nil {
			continue
		}
		var mine bool
		if marker, ok := envValue(pid, "STAM_COMPACTOR"); ok {
			owner, _, _ := strings.Cut(marker, ":")
			mine = owner == id
		} else {
			// realpathSync throws on either path in TS, which skips the process.
			pc, err1 := filepath.EvalSymlinks(filepath.Join(procDir, strconv.Itoa(pid), "cwd"))
			wc, err2 := filepath.EvalSymlinks(cwd)
			mine = err1 == nil && err2 == nil && pc == wc
		}
		if !mine {
			continue
		}
		if s, ok := readStat(pid); ok {
			out[pid] = s.start
		}
	}
	return out
}

func index(a []string, s string) int {
	for i, x := range a {
		if x == s {
			return i
		}
	}
	return -1
}

// SignalProcesses sends sig to each pid whose start time, read right before the signal, still matches, and returns how
// many it signalled.
func SignalProcesses(procs Procs, sig syscall.Signal) int {
	sent := 0
	for pid, start := range procs {
		if s, ok := readStat(pid); !ok || s.start != start {
			continue
		}
		if syscall.Kill(pid, sig) == nil {
			sent++
		}
	}
	return sent
}

// StopProcesses sends a SIGTERM now, and a SIGKILL grace later to those still running (by start time). It doesn't
// wait: the SIGKILL comes from a timer.
func StopProcesses(procs Procs, grace time.Duration) {
	if len(procs) == 0 || SignalProcesses(procs, syscall.SIGTERM) == 0 {
		return
	}
	time.AfterFunc(grace, func() { SignalProcesses(procs, syscall.SIGKILL) })
}

// StopAndConfirm stops procs and returns once each has exited: SIGTERM, then SIGKILL after grace. It returns an error
// when one still runs 2 s after the SIGKILL, or when ctx ends first.
func StopAndConfirm(ctx context.Context, procs Procs, grace time.Duration) error {
	// A zombie has exited; only its parent's wait is left.
	alive := func() []int {
		var out []int
		for pid, start := range procs {
			if s, ok := readStat(pid); ok && s.start == start && s.state != "Z" {
				out = append(out, pid)
			}
		}
		return out
	}
	gone := func(d time.Duration) (bool, error) {
		end := time.Now().Add(d)
		for len(alive()) > 0 && time.Now().Before(end) {
			select {
			case <-ctx.Done():
				return false, ctx.Err()
			case <-time.After(50 * time.Millisecond):
			}
		}
		return len(alive()) == 0, nil
	}
	SignalProcesses(procs, syscall.SIGTERM)
	if ok, err := gone(grace); ok || err != nil {
		return err
	}
	SignalProcesses(procs, syscall.SIGKILL)
	if ok, err := gone(2 * time.Second); ok || err != nil {
		return err
	}
	left := alive()
	parts := make([]string, len(left))
	for i, p := range left {
		parts[i] = strconv.Itoa(p)
	}
	return fmt.Errorf("process %s still runs after SIGKILL", strings.Join(parts, ", "))
}

// ClaudeSlug is the name Claude Code gives a cwd's scratch dir under /tmp/claude-UID/ (S-604): every character that
// isn't an ASCII letter or digit turned into '-'. JavaScript's regex works on UTF-16 code units, so a character outside
// the BMP becomes two dashes there; this matches it.
func ClaudeSlug(cwd string) string {
	var b strings.Builder
	for _, r := range cwd {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r > 0xFFFF:
			b.WriteString("--")
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

// DirInUse is whether a process has its cwd or an open file inside dir (a /proc scan).
func DirInUse(dir string) bool {
	inside := func(p string) bool { return p == dir || strings.HasPrefix(p, dir+"/") }
	for _, pid := range pids() {
		base := filepath.Join(procDir, strconv.Itoa(pid))
		if l, err := os.Readlink(filepath.Join(base, "cwd")); err == nil && inside(l) {
			return true
		}
		fds, err := os.ReadDir(filepath.Join(base, "fd"))
		if err != nil {
			continue
		}
		for _, fd := range fds {
			if l, err := os.Readlink(filepath.Join(base, "fd", fd.Name())); err == nil && inside(l) {
				return true
			}
		}
	}
	return false
}

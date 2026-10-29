package tmux

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"stam/internal/agentenv"
	"stam/internal/proctree"
)

// recorded is what fake-tmux logged: one argv per call, the new-session.conf files it was asked to source with their
// modes and their folder's, and what reached load-buffer's stdin.
type recorded struct {
	calls  [][]string
	confs  map[int]string
	modes  map[int]string
	stdins map[int]string
}

var bufName = regexp.MustCompile(`^stam-[0-9a-z]{6}$`)
var confPath = regexp.MustCompile(`/stam-session-[^/]+/new-session\.conf$`)

func readLog(t *testing.T, log string) recorded {
	t.Helper()
	b, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	r := recorded{confs: map[int]string{}, modes: map[int]string{}, stdins: map[int]string{}}
	for i, line := range strings.Split(strings.TrimSuffix(string(b), "\n"), "\n") {
		args := strings.Split(strings.TrimSuffix(line, "\x00"), "\x00")
		// The random parts differ run to run: the paste buffer's name and the conf file's folder.
		for j, a := range args {
			if bufName.MatchString(a) {
				args[j] = "stam-XXXXXX"
			}
			if confPath.MatchString(a) {
				args[j] = "TMP/new-session.conf"
			}
		}
		r.calls = append(r.calls, args)
		n := i + 1
		if c, err := os.ReadFile(fmt.Sprintf("%s.conf.%d", log, n)); err == nil {
			r.confs[n] = string(c)
			m, _ := os.ReadFile(fmt.Sprintf("%s.mode.%d", log, n))
			d, _ := os.ReadFile(fmt.Sprintf("%s.dirmode.%d", log, n))
			r.modes[n] = strings.TrimSpace(string(m)) + " " + strings.TrimSpace(string(d))
		}
		if s, err := os.ReadFile(fmt.Sprintf("%s.stdin.%d", log, n)); err == nil {
			r.stdins[n] = string(s)
		}
	}
	return r
}

// TestCommandsMatchTS runs the same calls through src/tmux.ts and through Client, each against fake-tmux, and wants
// the same tmux argv in the same order, the same new-session.conf bytes and modes, and the same pasted stdin.
func TestCommandsMatchTS(t *testing.T) {
	base := t.TempDir()
	bin := filepath.Join(base, "bin")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	fake, _ := filepath.Abs("testdata/fake-tmux")
	if err := os.Symlink(fake, filepath.Join(bin, "tmux")); err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(base, "tmp")
	if err := os.MkdirAll(tmp, 0o700); err != nil {
		t.Fatal(err)
	}
	const socket = "stam-test-golden"
	env := []envKV{{"STAM_USER_STATUSLINE", "printf '%s' \"$x\""}, {"STAM_AGENT_ID", "a1"}, {"MOOTR_AGENT_ID", "a1"}, {"STAM_TOKEN", "tok'en $HOME ; {x}"}}
	// Every STAM_ name here has its MOOTR_ twin, so nothing is scrubbed and the command has no env prefix.
	twinned := []envKV{{"STAM_AGENT_ID", "a2"}, {"MOOTR_AGENT_ID", "a2"}}
	argv := []string{"/usr/bin/claude", "--session-id", "s 1", "--settings", "/h/agents/a1/claude-settings.json", "it's", "$HOME", "~", "a;b", "", "plain-word_1.2:/x=y@%+,"}
	type call struct {
		fn   string
		args []any
	}
	calls := []call{
		{"newSession", []any{"a1", "/work dir/x", env, argv}},
		{"newSession", []any{"a2", "/work dir/x", twinned, argv}},
		{"sendKeys", []any{"a1", "Escape", "-l", "hello world"}},
		{"sendKeysToPane", []any{"%3", "Enter"}},
		{"paste", []any{"a1", "line one\nline 'two' $x\n"}},
		{"pasteText", []any{"a1", "short"}},
		{"capturePane", []any{"a1"}},
		{"capturePaneAsync", []any{"%7"}},
		{"setWindowSize", []any{"a1", "manual"}},
		{"setWindowSize", []any{"a1", "latest"}},
		{"resizeWindow", []any{"a1", 120, 40}},
		{"hasSession", []any{"a1"}},
		{"hasClients", []any{"a1"}},
		{"isDead", []any{"a1"}},
		{"paneWidth", []any{"a1"}},
		{"serverId", nil},
		{"paneOwner", []any{"%3"}},
	}
	var tsCalls []any
	for _, c := range calls {
		args := []any{c.fn}
		for _, a := range c.args {
			if e, ok := a.([]envKV); ok {
				// JSON keeps object key order on the way into node; marshal by hand to keep env's.
				a = orderedEnv(e)
			}
			args = append(args, a)
		}
		tsCalls = append(tsCalls, args)
	}
	in, err := json.Marshal(tsCalls)
	if err != nil {
		t.Fatal(err)
	}
	tsLog := filepath.Join(base, "ts.log")
	cmd := exec.Command("node", "testdata/ts-tmux.mjs")
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "FAKE_TMUX_LOG="+tsLog, "STAM_TMUX_SOCKET="+socket, "TMPDIR="+tmp,
		"STAM_HOME="+filepath.Join(base, "home"), "STAM_MACHINE=test-machine")
	cmd.Stdin = strings.NewReader(string(in))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("ts-tmux.mjs: %v\n%s", err, out)
	}

	goLog := filepath.Join(base, "go.log")
	t.Setenv("FAKE_TMUX_LOG", goLog)
	c := &Client{Socket: socket, Bin: filepath.Join(bin, "tmux"), TempDir: tmp}
	ctx := context.Background()
	for _, k := range calls {
		var err error
		a := k.args
		switch k.fn {
		case "newSession":
			var e Env
			for _, kv := range a[2].([]envKV) {
				e = e.Set(kv.k, kv.v)
			}
			err = c.NewSession(ctx, a[0].(string), a[1].(string), e, a[3].([]string))
		case "sendKeys":
			err = c.SendKeys(ctx, a[0].(string), strs(a[1:])...)
		case "sendKeysToPane":
			err = c.SendKeysToPane(ctx, a[0].(string), strs(a[1:])...)
		case "paste":
			err = c.Paste(ctx, a[0].(string), a[1].(string))
		case "pasteText":
			err = c.PasteText(ctx, a[0].(string), a[1].(string))
		case "capturePane":
			_, err = c.CapturePane(ctx, a[0].(string))
		case "capturePaneAsync":
			_, err = c.CapturePaneByID(ctx, a[0].(string))
		case "setWindowSize":
			c.SetWindowSize(ctx, a[0].(string), a[1].(string))
		case "resizeWindow":
			c.ResizeWindow(ctx, a[0].(string), a[1].(int), a[2].(int))
		case "hasSession":
			c.HasSession(ctx, a[0].(string))
		case "hasClients":
			c.HasClients(ctx, a[0].(string))
		case "isDead":
			c.IsDead(ctx, a[0].(string))
		case "paneWidth":
			_, err = c.PaneWidth(ctx, a[0].(string))
		case "serverId":
			c.ServerID(ctx)
		case "paneOwner":
			c.PaneOwner(ctx, a[0].(string))
		default:
			t.Fatalf("no Go call for %s", k.fn)
		}
		if err != nil {
			t.Fatalf("%s: %v", k.fn, err)
		}
	}
	ts, gor := readLog(t, tsLog), readLog(t, goLog)
	if !reflect.DeepEqual(gor.calls, ts.calls) {
		t.Errorf("tmux calls differ:\n go %q\n ts %q", gor.calls, ts.calls)
	}
	if !reflect.DeepEqual(gor.confs, ts.confs) || len(ts.confs) != 2 {
		t.Errorf("new-session.conf differs:\n go %#v\n ts %#v", gor.confs, ts.confs)
	}
	if !reflect.DeepEqual(gor.modes, ts.modes) {
		t.Errorf("new-session.conf and folder modes: go %v, ts %v", gor.modes, ts.modes)
	}
	for _, m := range gor.modes {
		if m != "600 700" {
			t.Errorf("new-session.conf mode and folder mode %q, want 600 700", m)
		}
	}
	if !reflect.DeepEqual(gor.stdins, ts.stdins) || len(ts.stdins) != 2 {
		t.Errorf("paste stdin differs: go %#v, ts %#v", gor.stdins, ts.stdins)
	}
	// The token reached tmux only in the 0600 file, never in an argv.
	for _, a := range gor.calls {
		if strings.Contains(strings.Join(a, " "), "tok'en") {
			t.Errorf("token in argv %q", a)
		}
	}
	if left, _ := os.ReadDir(tmp); len(left) != 0 {
		t.Errorf("NewSession left %d entries in its temp folder", len(left))
	}
}

type envKV struct{ k, v string }

// orderedEnv marshals as a JSON object in the slice's order.
type orderedEnv []envKV

func (e orderedEnv) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	for i, kv := range e {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(kv.k)
		v, _ := json.Marshal(kv.v)
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

func strs(a []any) []string {
	out := make([]string, len(a))
	for i, x := range a {
		out[i] = x.(string)
	}
	return out
}

func TestShellQuoteMatchesTS(t *testing.T) {
	words := []string{"plain", "a b", "it's", "", "$HOME", "~", "a;b", "x=y", "é", "-n", "a\nb", "@%+=:,./-_"}
	in, _ := json.Marshal(words)
	out, err := exec.Command("node", "--input-type=module", "-e",
		`const { shellQuote } = await import(process.argv[1]); process.stdout.write(JSON.stringify(JSON.parse(process.argv[2]).map(shellQuote)));`,
		mustAbs(t, "../../../src/tmux.ts"), string(in)).Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	var want []string
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	for i, w := range words {
		if got := ShellQuote(w); got != want[i] {
			t.Errorf("ShellQuote(%q) = %q, TS %q", w, got, want[i])
		}
	}
}

func mustAbs(t *testing.T, p string) string {
	t.Helper()
	a, err := filepath.Abs(p)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestParseSnapshot(t *testing.T) {
	line := func(server, session, active, dead, act, paneActive, id string) string {
		return strings.Join([]string{server, session, active, dead, act, paneActive, id}, "\t")
	}
	out := strings.Join([]string{
		line("10 99", "a", "1", "0", "100", "1", "%1"),
		line("10 99", "a", "1", "1", "100", "0", "%2"),
		line("10 99", "b", "1", "1", "200", "1", "%3"),
		line("10 99", "c", "0", "0", "300", "1", "%4"),
	}, "\n") + "\n"
	s, ask := parseSnapshot(Result{Stdout: out})
	if ask || s == nil || s.Server != "10 99" {
		t.Fatalf("snapshot %+v ask %v", s, ask)
	}
	if !reflect.DeepEqual(s.Dead, map[string]bool{"a": false, "b": true}) || s.Activity["b"] != 200 || s.Pane["a"] != "%1" || s.Pane["b"] != "%3" {
		t.Fatalf("snapshot %+v", s)
	}
	if _, ok := s.Dead["c"]; ok {
		t.Fatal("an inactive window counted")
	}
	if s, _ := parseSnapshot(Result{Status: 1, Stderr: "no server running on /tmp/tmux-1/x\n"}); s == nil || s.Server != "" {
		t.Fatalf("no server: %+v", s)
	}
	if s, _ := parseSnapshot(Result{Status: 1, Stderr: "error connecting to /tmp/x (Connection refused)\n"}); s == nil || s.Server != "" {
		t.Fatalf("refused: %+v", s)
	}
	if s, ask := parseSnapshot(Result{Status: -1, Stderr: "signal: killed"}); s != nil || ask {
		t.Fatal("a timeout must know nothing")
	}
	if s, _ := parseSnapshot(Result{Stdout: "a\tb\n"}); s != nil {
		t.Fatal("a short line must know nothing")
	}
	if _, ask := parseSnapshot(Result{Status: 1, Stderr: "no current target\n"}); !ask {
		t.Fatal("no current target must ask the session count")
	}
	if _, ask := parseSnapshot(Result{}); !ask {
		t.Fatal("no panes must ask the session count")
	}
	if s := parseEmpty(Result{Stdout: "10 99\t0\n"}); s == nil || s.Server != "10 99" {
		t.Fatalf("empty server: %+v", s)
	}
	if s := parseEmpty(Result{Stdout: "10 99\t2\n"}); s != nil {
		t.Fatal("no panes with sessions must know nothing")
	}
	if s := parseEmpty(Result{Status: 1, Stderr: "no server running on x"}); s == nil || s.Server != "" {
		t.Fatal("no server from display-message")
	}
}

// liveClient is a client on a tmux server of the test's own, killed when the test ends; it never touches a socket a
// daemon uses.
func liveClient(t *testing.T) *Client {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	c := &Client{Socket: fmt.Sprintf("stam-test-go-%d-%d", os.Getpid(), time.Now().UnixNano()), TempDir: t.TempDir()}
	t.Cleanup(func() {
		// kill-server leaves the socket file behind; remove it by its exact path.
		path, _ := exec.Command("tmux", "-L", c.Socket, "display-message", "-p", "#{socket_path}").Output()
		_ = exec.Command("tmux", "-L", c.Socket, "kill-server").Run()
		if p := strings.TrimSpace(string(path)); strings.HasSuffix(p, "/"+c.Socket) {
			_ = os.Remove(p)
		}
	})
	return c
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(10 * time.Second); time.Now().Before(end); time.Sleep(50 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

// TestLiveSession runs a real session on the test's own socket: the env reaches the pane but no argv, keys and pastes
// arrive, the snapshot sees it, and KillSession ends exactly that session and the processes carrying its agent id.
func TestLiveSession(t *testing.T) {
	c := liveClient(t)
	ctx := context.Background()
	const secret = "s3cret-token-value"
	env := Env{{"STAM_AGENT_ID", "agent-x"}, {"STAM_TOKEN", secret}}
	script := `printf 'token=%s\n' "$STAM_TOKEN"; sleep 300 & echo "bg=$!"; exec cat`
	if err := c.NewSession(ctx, "agent-x", t.TempDir(), env, []string{"sh", "-c", script}); err != nil {
		t.Fatal(err)
	}
	if err := c.NewSession(ctx, "agent-xy", t.TempDir(), Env{{"STAM_AGENT_ID", "agent-xy"}}, []string{"sh", "-c", "exec sleep 300"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the token in the pane", func() bool {
		s, _ := c.CapturePane(ctx, "agent-x")
		return strings.Contains(s, "token="+secret) && strings.Contains(s, "bg=")
	})
	if left, _ := os.ReadDir(c.TempDir); len(left) != 0 {
		t.Errorf("new-session.conf's folder left behind: %d entries", len(left))
	}
	server, ok := c.ServerID(ctx)
	if !ok {
		t.Fatal("no server id")
	}
	spid, _ := strconv.Atoi(strings.Fields(server)[0])
	for _, pid := range append([]int{spid}, panePids(t, c)...) {
		if b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid)); err == nil && strings.Contains(string(b), secret) {
			t.Errorf("the token is in pid %d's argv", pid)
		}
	}
	if !c.HasSession(ctx, "agent-x") || c.HasSession(ctx, "agent") || c.IsDead(ctx, "agent-x") {
		t.Fatal("HasSession or IsDead is wrong")
	}
	if w, err := c.PaneWidth(ctx, "agent-x"); err != nil || w != 200 {
		t.Fatalf("pane width %d, %v", w, err)
	}
	if err := c.Paste(ctx, "agent-x", "pasted-line"); err != nil {
		t.Fatal(err)
	}
	if err := c.SendKeys(ctx, "agent-x", "Enter"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the paste", func() bool {
		s, _ := c.CapturePaneAnsi(ctx, "agent-x", 40)
		return strings.Count(s, "pasted-line") >= 2
	})
	snap := c.Snapshot(ctx)
	if snap == nil || snap.Server != server || snap.Dead["agent-x"] || !strings.HasPrefix(snap.Pane["agent-x"], "%") {
		t.Fatalf("snapshot %+v", snap)
	}
	if owner, ok := c.PaneOwner(ctx, snap.Pane["agent-x"]); !ok || owner != server+"\tagent-x" {
		t.Fatalf("pane owner %q", owner)
	}
	if s1, s2 := c.SharedSnapshot(ctx), c.SharedSnapshot(ctx); s1 == nil || s1 != s2 {
		t.Fatal("SharedSnapshot didn't reuse its answer")
	}
	if x, y, ok, err := c.Cursor(ctx, "agent-x"); err != nil || !ok || x < 0 || y < 0 {
		t.Fatalf("cursor %d %d %v %v", x, y, ok, err)
	}

	// What KillSession finds: the pane's tree (cat and its background sleep), not the server above it.
	r := c.Run(ctx, nil, "list-panes", "-t", "=agent-x:", "-F", "#{pane_pid}")
	pane, _ := strconv.Atoi(strings.TrimSpace(r.Stdout))
	procs := proctree.AgentProcesses("agent-x", pane, []int{spid})
	if len(procs) < 2 {
		t.Fatalf("agent-x's processes: %v", procs)
	}
	if err := c.KillSession(ctx, "agent-x"); err != nil {
		t.Fatal(err)
	}
	if c.HasSession(ctx, "agent-x") || !c.HasSession(ctx, "agent-xy") {
		t.Fatal("KillSession must end exactly agent-x")
	}
	waitFor(t, "agent-x's processes to stop", func() bool {
		for pid, start := range procs {
			if proctree.ProcStart(pid) == start && !zombie(pid) {
				return false
			}
		}
		return true
	})
	// The server lives on with its other session.
	if again, ok := c.ServerID(ctx); !ok || again != server {
		t.Fatalf("the server changed: %q", again)
	}
}

func zombie(pid int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return true
	}
	s := string(b)
	return strings.HasPrefix(s[strings.LastIndex(s, ")")+2:], "Z")
}

func panePids(t *testing.T, c *Client) []int {
	r := c.Run(context.Background(), nil, "list-panes", "-a", "-F", "#{pane_pid}")
	var out []int
	for _, f := range strings.Fields(r.Stdout) {
		if n, err := strconv.Atoi(f); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func TestRunHasDeadline(t *testing.T) {
	base := t.TempDir()
	slow := filepath.Join(base, "slow-tmux")
	if err := os.WriteFile(slow, []byte("#!/bin/sh\nexec sleep 30\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	c := &Client{Socket: "stam-test-slow", Bin: slow}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	r := c.Run(ctx, nil, "list-panes")
	if r.Status != -1 || time.Since(start) > 3*time.Second {
		t.Fatalf("a hung tmux must end at the deadline: %+v after %v", r, time.Since(start))
	}
}

// S-3345: WithTwins adds each MOOTR_ twin with its STAM_ value, keeps an explicit twin, and a twin survives the scrub.
func TestWithTwins(t *testing.T) {
	env := Env{{"STAM_AGENT_ID", "a1"}, {"PATH", "/bin"}, {"STAM_HOME", "/h"}, {"MOOTR_HOME", "/m"}}
	got := env.WithTwins()
	want := Env{{"STAM_AGENT_ID", "a1"}, {"PATH", "/bin"}, {"STAM_HOME", "/h"}, {"MOOTR_HOME", "/m"}, {"MOOTR_AGENT_ID", "a1"}}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	if len(env) != 4 {
		t.Fatalf("WithTwins changed its receiver: %v", env)
	}
	if conf := SessionConf("a1", "/w", Env{{"STAM_URL", "http://x"}}, []string{"claude"}); strings.Contains(conf, "-u MOOTR_URL") || !strings.Contains(conf, "'MOOTR_URL=http://x'") {
		t.Fatalf("twin missing or scrubbed: %s", conf)
	}
	// S-3329: a session that sets no identity drops both names of it, and one that sets it keeps both (TS sessionCommand).
	if conf := SessionConf("ox", "/w", Env{{"STAM_URL", "http://x"}}, []string{"opencode"}); !strings.Contains(conf, "-u MOOTR_AGENT_ID") || !strings.Contains(conf, "-u STAM_AGENT_ID") {
		t.Fatalf("an unset identity kept: %s", conf)
	}
	if conf := SessionConf("a1", "/w", Env{{"STAM_AGENT_ID", "a1"}}, []string{"claude"}); strings.Contains(conf, "-u MOOTR_AGENT_ID") || !strings.Contains(conf, "MOOTR_AGENT_ID=a1") {
		t.Fatalf("the agent's own identity scrubbed: %s", conf)
	}
}

// S-3406: NewShell gives the human's shell none of an agent's identity, under either spelling, the token included. A fake
// tmux records the env new-session is given, so the test reads what NewShell passes and starts no server.
func TestNewShellDropsIdentity(t *testing.T) {
	base := t.TempDir()
	out := filepath.Join(base, "env")
	fake := filepath.Join(base, "tmux")
	script := fmt.Sprintf("#!/bin/sh\ncase \"$*\" in *new-session*) /usr/bin/env > '%s';; esac\n", out)
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range agentenv.Names() {
		t.Setenv(name, name+"-secret")
	}
	t.Setenv("MOOTR_AGENTS_SKILLS", "skills-secret")
	t.Setenv("KEEP_SHELL", "kept")
	c := &Client{Socket: "stam-test-shell", Bin: fake, TempDir: base}
	if _, err := c.NewShell(context.Background(), base, "m"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	shellEnv := string(b)
	for _, name := range agentenv.Names() {
		if strings.Contains(shellEnv, "\n"+name+"=") || strings.HasPrefix(shellEnv, name+"=") {
			t.Errorf("%s reached the shell", name)
		}
	}
	if !strings.Contains(shellEnv, "KEEP_SHELL=kept") {
		t.Error("a name stam does not scrub is kept")
	}
	if strings.Contains(shellEnv, "-secret") {
		t.Error("an identity value reached the shell")
	}
}

// TestNewSessionAfterLastKill: a session started right after the last one on the socket was killed starts a fresh
// server, though the old server may still be exiting when the start connects to it (S-3618).
func TestNewSessionAfterLastKill(t *testing.T) {
	c := liveClient(t)
	ctx := context.Background()
	for i := range 20 {
		name := fmt.Sprintf("last-%d", i)
		if err := c.NewSession(ctx, name, t.TempDir(), Env{{"STAM_AGENT_ID", name}}, []string{"sh", "-c", "exec sleep 300"}); err != nil {
			t.Fatalf("session %d: %v", i, err)
		}
		if !c.HasSession(ctx, name) {
			t.Fatalf("session %d not running", i)
		}
		c.Run(ctx, nil, "kill-session", "-t", "="+name)
	}
}

// TestNewShellAfterLastKill: a human's terminal started right after the last session on the socket was killed starts
// a fresh server, though the old one may still be exiting (S-3618).
func TestNewShellAfterLastKill(t *testing.T) {
	c := liveClient(t)
	ctx := context.Background()
	for i := range 20 {
		sh, err := c.NewShell(ctx, t.TempDir(), "test-machine")
		if err != nil {
			t.Fatalf("shell %d: %v", i, err)
		}
		if !c.HasSession(ctx, sh.ID) {
			t.Fatalf("shell %d not running", i)
		}
		c.Run(ctx, nil, "kill-session", "-t", "="+sh.ID)
	}
}

// TestRetryExiting: only the exiting server's error is retried, and retries stop at the deadline.
func TestRetryExiting(t *testing.T) {
	ctx := context.Background()
	t.Run("succeeds after the exit", func(t *testing.T) {
		tries := 0
		err := retryExiting(ctx, func() (string, error) {
			tries++
			if tries < 3 {
				return exitingServer, errors.New("exiting")
			}
			return "", nil
		})
		if err != nil || tries != 3 {
			t.Fatalf("err %v after %d tries", err, tries)
		}
	})
	t.Run("another error is not retried", func(t *testing.T) {
		tries := 0
		err := retryExiting(ctx, func() (string, error) {
			tries++
			return "no space left", errors.New("failed")
		})
		if err == nil || tries != 1 {
			t.Fatalf("err %v after %d tries", err, tries)
		}
	})
	t.Run("the deadline ends the retries", func(t *testing.T) {
		tries := 0
		start := time.Now()
		err := retryExiting(ctx, func() (string, error) {
			tries++
			return exitingServer, errors.New("exiting")
		})
		if err == nil || time.Since(start) < startDeadline || tries < 2 {
			t.Fatalf("err %v after %d tries in %v", err, tries, time.Since(start))
		}
	})
}

// PanePID: only tmux's own "not there" is gone; a hung or failing tmux is an error, never gone (S-4237).
func TestPanePIDUncertainty(t *testing.T) {
	base := t.TempDir()
	for _, c := range []struct {
		name, script string
		pid          int
		live, failed bool
	}{
		{"no session", "echo \"can't find session: _opencode\" >&2; exit 1", 0, false, false},
		{"no server", "echo 'error connecting to /tmp/tmux-1000/x (No such file or directory)' >&2; exit 1", 0, false, false},
		{"no server, older tmux", "echo 'no server running on /tmp/tmux-1000/x' >&2; exit 1", 0, false, false},
		{"refused", "echo 'error connecting to /tmp/tmux-1000/x (Connection refused)' >&2; exit 1", 0, false, true},
		{"killed", "kill -9 $$", 0, false, true},
		{"other failure", "echo 'lost server' >&2; exit 1", 0, false, true},
		{"live", "echo '4242 0'", 4242, true, false},
		{"dead pane", "echo '4242 1'", 4242, false, false},
		{"garbage", "echo 'x'", 0, false, true},
	} {
		bin := filepath.Join(base, strings.ReplaceAll(c.name, " ", "-"))
		if err := os.WriteFile(bin, []byte("#!/bin/sh\n"+c.script+"\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		pid, live, err := (&Client{Socket: "stam-test-pane", Bin: bin}).PanePID(context.Background(), "_opencode")
		if pid != c.pid || live != c.live || (err != nil) != c.failed {
			t.Errorf("%s: %d %v %v; want %d %v, error %v", c.name, pid, live, err, c.pid, c.live, c.failed)
		}
	}
	// A tmux that hangs past the deadline (status -1) is an error too.
	slow := filepath.Join(base, "slow")
	if err := os.WriteFile(slow, []byte("#!/bin/sh\nexec sleep 30\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if _, live, err := (&Client{Socket: "stam-test-pane", Bin: slow}).PanePID(ctx, "_opencode"); live || err == nil {
		t.Errorf("a hung tmux: live %v, err %v; want an error", live, err)
	}
}

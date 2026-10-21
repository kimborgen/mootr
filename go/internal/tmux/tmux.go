// Package tmux runs agents' terminals in a tmux server of the home's own (`tmux -L SOCKET`): a port of src/tmux.ts
// (S-2804). One session per agent, named by agent id, so a human attaches with `stam attach`.
//
// Unlike TS, every call runs through exec.CommandContext with a deadline (5 s unless the caller's context ends
// sooner), so no tmux call can hold a goroutine forever (S-2122). Sessions are never killed by pattern, only by the
// exact name stam gave them (`=NAME`), and the server outlives the daemon: nothing here stops it, and a daemon started
// with KillMode=process leaves it running across a restart.
package tmux

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"stam/internal/jsjson"
	"stam/internal/proctree"
)

// Timeout bounds every tmux call whose context has no sooner deadline.
const Timeout = 5 * time.Second

// Client is one tmux server, by its socket name.
type Client struct {
	// Socket is the `tmux -L` name (STAM_TMUX_SOCKET, default stam): a short word, not a path.
	Socket string
	// Bin is the tmux binary, "tmux" when empty; tests point it at a recorder.
	Bin string
	// TempDir holds new-session.conf while tmux reads it; os.TempDir() when empty (src/tmux.ts uses os.tmpdir()).
	TempDir string

	shared sharedSnapshot
}

// Result is one finished tmux call: its exit status (-1 when it didn't exit normally: a timeout, a signal, no binary),
// stdout and stderr.
type Result struct {
	Status int
	Stdout string
	Stderr string
}

func (c *Client) bin() string {
	if c.Bin != "" {
		return c.Bin
	}
	return "tmux"
}

// Run runs tmux -L SOCKET args with stdin, and returns its result; it never fails on its own, only Status says.
func (c *Client) Run(ctx context.Context, stdin []byte, args ...string) Result {
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.bin(), append([]string{"-L", c.Socket}, args...)...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	r := Result{Stdout: out.String(), Stderr: errb.String()}
	var exit *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exit) && exit.Exited():
		r.Status = exit.ExitCode()
	default:
		r.Status = -1
		if r.Stderr == "" {
			r.Stderr = err.Error()
		}
	}
	return r
}

// call is Run that fails on a non-zero status, as TS's execFileSync does, and returns stdout.
func (c *Client) call(ctx context.Context, stdin []byte, args ...string) (string, error) {
	r := c.Run(ctx, stdin, args...)
	if r.Status != 0 {
		return r.Stdout, fmt.Errorf("tmux %s failed (status %d): %s", args[0], r.Status, strings.TrimSpace(r.Stderr))
	}
	return r.Stdout, nil
}

var plainWord = regexp.MustCompile(`^[\w@%+=:,./-]+$`)

// ShellQuote quotes s for sh: plain words as they are, anything else in single quotes.
func ShellQuote(s string) string {
	if plainWord.MatchString(s) {
		return s
	}
	return tmuxQuote(s)
}

// tmuxQuote is a word in a tmux command file: single quotes keep `$`, `~`, `;` and braces literal.
func tmuxQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Env is an ordered environment: the order the variables appear in new-session.conf, as TS's Object.entries gives it.
type Env []EnvVar

// EnvVar is one variable.
type EnvVar struct{ Key, Value string }

// Set sets key: a new key goes last, an existing one keeps its place (object spread in TS).
func (e Env) Set(key, value string) Env {
	for i := range e {
		if e[i].Key == key {
			e[i].Value = value
			return e
		}
	}
	return append(e, EnvVar{key, value})
}

// Get returns key's value and whether it is set.
func (e Env) Get(key string) (string, bool) {
	for _, v := range e {
		if v.Key == key {
			return v.Value, true
		}
	}
	return "", false
}

// SessionConf is the new-session.conf line NewSession has tmux source: the command with every word quoted.
func SessionConf(name, cwd string, env Env, argv []string) string {
	cmd := []string{"new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", cwd}
	for _, v := range env {
		cmd = append(cmd, "-e", v.Key+"="+v.Value)
	}
	words := make([]string, len(argv))
	for i, a := range argv {
		words[i] = ShellQuote(a)
	}
	cmd = append(cmd, strings.Join(words, " "))
	for i, w := range cmd {
		cmd[i] = tmuxQuote(w)
	}
	return strings.Join(cmd, " ") + "\n"
}

// NewSession starts argv in a new detached session name, in cwd, with env. The env holds the agent's token, so it never
// goes on a command line (S-477): a tmux server keeps the argv of the client that started it, for anyone to read in
// `ps`. The new-session command goes in a 0600 file in a 0700 folder only this user can read, which tmux sources and
// which is removed before NewSession returns.
func (c *Client) NewSession(ctx context.Context, name, cwd string, env Env, argv []string) error {
	dir, err := os.MkdirTemp(c.TempDir, "stam-session-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	file := filepath.Join(dir, "new-session.conf")
	if err := os.WriteFile(file, []byte(SessionConf(name, cwd, env, argv)), 0o600); err != nil {
		return err
	}
	// source-file alone doesn't start a server.
	if _, err := c.call(ctx, nil, "start-server", ";", "source-file", file); err != nil {
		return err
	}
	// Keep the pane after the harness exits, so its last output stays visible.
	if _, err := c.call(ctx, nil, "set-option", "-t", name, "remain-on-exit", "on"); err != nil {
		return err
	}
	// The web UI names the agent; tmux's status bar would only take a row, and it's the widest line on the screen.
	_, err = c.call(ctx, nil, "set-option", "-t", name, "status", "off")
	return err
}

// HasSession is whether a session named exactly name runs.
func (c *Client) HasSession(ctx context.Context, name string) bool {
	return c.Run(ctx, nil, "has-session", "-t", "="+name).Status == 0
}

// HasClients is whether a `stam attach` or other tmux client has the agent's session open.
func (c *Client) HasClients(ctx context.Context, name string) bool {
	r := c.Run(ctx, nil, "list-clients", "-t", "="+name)
	return r.Status == 0 && strings.TrimSpace(r.Stdout) != ""
}

// Grace is how long KillSession's sweep waits between SIGTERM and SIGKILL (src/proctree.ts stopProcesses).
const Grace = 5 * time.Second

// KillSession ends the session named exactly name and stops what its agent started (S-323): the pane's tree,
// sandboxed children in sessions of their own, and orphans that carry the agent's id. The tmux server itself is
// spared: an agent that ran tmux on the socket first would have started it with its own env.
func (c *Client) KillSession(ctx context.Context, name string) error {
	if !c.HasSession(ctx, name) {
		proctree.StopProcesses(proctree.AgentProcesses(name, 0, c.serverPids(ctx)), Grace)
		return nil
	}
	// A dead pane's pid may belong to another process by now, so only a live pane counts.
	r := c.Run(ctx, nil, "list-panes", "-t", "="+name+":", "-F", "#{pane_pid} #{pane_dead}")
	first, _, _ := strings.Cut(strings.TrimSpace(r.Stdout), "\n")
	f := strings.Split(first, " ")
	pid, _ := strconv.Atoi(f[0])
	dead := false
	if len(f) > 1 {
		n, err := strconv.Atoi(f[1])
		dead = err == nil && n != 0
	}
	live := pid > 1 && !dead
	panePid := 0
	if live {
		panePid = pid
	}
	// Found before the session goes: once the pane dies, its children leave its tree.
	procs := proctree.AgentProcesses(name, panePid, c.serverPids(ctx))
	if _, err := c.call(ctx, nil, "kill-session", "-t", "="+name); err != nil {
		return err
	}
	// The Codex TUI outlives the hangup that closing the pane sends, and keeps its app-server running, so the pane's
	// whole process group gets a SIGTERM too.
	if live {
		_ = syscall.Kill(-pid, syscall.SIGTERM)
	}
	proctree.StopProcesses(procs, Grace)
	return nil
}

func (c *Client) serverPids(ctx context.Context) []int {
	id, ok := c.ServerID(ctx)
	if !ok {
		return nil
	}
	first, _, _ := strings.Cut(id, " ")
	if pid, _ := strconv.Atoi(first); pid > 1 {
		return []int{pid}
	}
	return nil
}

// ServerID is the running tmux server as `PID START_TIME`, and false when none runs on the socket. A changed value
// means the server stopped and another took its place.
func (c *Client) ServerID(ctx context.Context) (string, bool) {
	r := c.Run(ctx, nil, "display-message", "-p", "#{pid} #{start_time}")
	if r.Status != 0 {
		return "", false
	}
	return strings.TrimSpace(r.Stdout), true
}

// IsDead is whether the session's pane is dead, or the session is gone.
func (c *Client) IsDead(ctx context.Context, name string) bool {
	r := c.Run(ctx, nil, "list-panes", "-t", "="+name+":", "-F", "#{pane_dead}")
	return r.Status != 0 || strings.TrimSpace(r.Stdout) == "1"
}

// CapturePane is the session's screen as text.
func (c *Client) CapturePane(ctx context.Context, name string) (string, error) {
	return c.call(ctx, nil, "capture-pane", "-p", "-t", "="+name+":")
}

// CapturePaneByID is one pane's screen, by its %N id (S-349).
func (c *Client) CapturePaneByID(ctx context.Context, pane string) (string, error) {
	return c.call(ctx, nil, "capture-pane", "-p", "-t", pane)
}

// PaneOwner is the server and session a pane (by its %N id) is in now, as `SERVER\tSESSION`, and false when it's gone.
// A pane id is unique only within one server, so a caller compares both.
func (c *Client) PaneOwner(ctx context.Context, pane string) (string, bool) {
	r := c.Run(ctx, nil, "display-message", "-p", "-t", pane, "#{pid} #{start_time}\t#{session_name}")
	if r.Status != 0 {
		return "", false
	}
	server, session, _ := strings.Cut(strings.TrimSpace(r.Stdout), "\t")
	if server == "" || session == "" {
		return "", false
	}
	session, _, _ = strings.Cut(session, "\t")
	return server + "\t" + session, true
}

// Pane is the session's pane: its %N id and its owner as PaneOwner reads it, so a caller can capture and send by the id
// and check, right before it sends, that the pane is still this session's. False with no error when tmux says there is
// no such session or server (exit status 1); an error when the call failed otherwise (a timeout, a signal, an answer
// it can't read), so the caller can't tell whether the session is there.
func (c *Client) Pane(ctx context.Context, name string) (id, owner string, ok bool, err error) {
	r := c.Run(ctx, nil, "display-message", "-p", "-t", "="+name+":", "#{pane_id}\t#{pid} #{start_time}\t#{session_name}")
	if r.Status == 1 {
		return "", "", false, nil
	}
	if r.Status != 0 {
		return "", "", false, fmt.Errorf("tmux display-message failed (status %d): %s", r.Status, strings.TrimSpace(r.Stderr))
	}
	parts := strings.SplitN(strings.TrimSpace(r.Stdout), "\t", 3)
	if len(parts) != 3 || !strings.HasPrefix(parts[0], "%") || parts[1] == "" || parts[2] != name {
		return "", "", false, fmt.Errorf("tmux display-message answered %q", r.Stdout)
	}
	return parts[0], parts[1] + "\t" + parts[2], true, nil
}

// SendKeysToPane sends keys to one pane by its %N id, for a caller that has checked whose pane it is (PaneOwner).
func (c *Client) SendKeysToPane(ctx context.Context, pane string, keys ...string) error {
	_, err := c.call(ctx, nil, append([]string{"send-keys", "-t", pane}, keys...)...)
	return err
}

// SendKeys sends keys to the agent's session.
func (c *Client) SendKeys(ctx context.Context, name string, keys ...string) error {
	_, err := c.call(ctx, nil, append([]string{"send-keys", "-t", "=" + name + ":"}, keys...)...)
	return err
}

// CapturePaneAnsi is the pane's screen with its colours (ANSI), trailing blank lines dropped, at most lines lines.
func (c *Client) CapturePaneAnsi(ctx context.Context, name string, lines int) (string, error) {
	out, err := c.call(ctx, nil, "capture-pane", "-p", "-e", "-t", "="+name+":")
	if err != nil {
		return "", err
	}
	rows := strings.Split(jsjson.TrimEnd(out), "\n")
	if len(rows) > lines {
		rows = rows[len(rows)-lines:]
	}
	return strings.Join(rows, "\n"), nil
}

// PaneWidth is the width of the agent's pane in columns, 0 when tmux doesn't say.
func (c *Client) PaneWidth(ctx context.Context, name string) (int, error) {
	out, err := c.call(ctx, nil, "display-message", "-p", "-t", "="+name+":", "#{pane_width}")
	n, _ := strconv.Atoi(strings.TrimSpace(out))
	return n, err
}

// Cursor is the cursor's column and row in the agent's pane (0-based), and false when tmux doesn't say.
func (c *Client) Cursor(ctx context.Context, name string) (x, y int, ok bool, err error) {
	out, err := c.call(ctx, nil, "display-message", "-p", "-t", "="+name+":", "#{cursor_x} #{cursor_y}")
	if err != nil {
		return 0, 0, false, err
	}
	xs, ys, _ := strings.Cut(strings.TrimSpace(out), " ")
	x, errX := strconv.Atoi(xs)
	y, errY := strconv.Atoi(ys)
	return x, y, errX == nil && errY == nil, nil
}

// PasteDelay is how long PasteText waits between the paste and Enter: harnesses ignore an Enter that arrives inside
// the paste's burst of input.
const PasteDelay = 400 * time.Millisecond

// PasteText pastes text into a session as one bracketed paste, as if the human pasted it, then presses Enter. A
// harness takes a multi-line paste as one message.
func (c *Client) PasteText(ctx context.Context, name, text string) error {
	if err := c.Paste(ctx, name, text); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(PasteDelay):
	}
	return c.SendKeys(ctx, name, "Enter")
}

// Paste is one bracketed paste, without Enter. The text reaches tmux on stdin, so it never shows on a command line.
func (c *Client) Paste(ctx context.Context, name, text string) error {
	buf := "stam-" + randomBase36(6)
	if _, err := c.call(ctx, []byte(text), "load-buffer", "-b", buf, "-"); err != nil {
		return err
	}
	_, err := c.call(ctx, nil, "paste-buffer", "-p", "-d", "-b", buf, "-t", "="+name+":")
	return err
}

// SetWindowSize sets how the session's windows size: `manual` while a web viewer is attached (it sizes the window
// itself), `latest` otherwise, when the window fits the terminal of the client that last acted. tmux has no
// session-level window option, so this sets every window of the session, and a hook gives each window made later the
// same mode until it's set back to `latest`. Failures are ignored: the session may have just ended.
func (c *Client) SetWindowSize(ctx context.Context, name, mode string) {
	w := c.Run(ctx, nil, "list-windows", "-t", "="+name, "-F", "#{window_index}")
	if w.Status == 0 {
		for _, idx := range strings.Split(strings.TrimSpace(w.Stdout), "\n") {
			c.Run(ctx, nil, "set-option", "-w", "-t", "="+name+":"+idx, "window-size", mode)
		}
	}
	if mode == "manual" {
		c.Run(ctx, nil, "set-hook", "-t", name, "after-new-window", "set-option -w window-size manual")
	} else {
		c.Run(ctx, nil, "set-hook", "-u", "-t", name, "after-new-window")
	}
}

// ResetWindowSizes sets every session back to `latest` at the daemon's start: a crash leaves windows `manual` with no
// viewer left to reset them.
func (c *Client) ResetWindowSizes(ctx context.Context) {
	r := c.Run(ctx, nil, "list-sessions", "-F", "#{session_name}")
	if r.Status != 0 {
		return
	}
	for _, name := range strings.Split(strings.TrimSpace(r.Stdout), "\n") {
		if name != "" {
			c.SetWindowSize(ctx, name, "latest")
		}
	}
}

// ResizeWindow sets the session's window size; failures are ignored.
func (c *Client) ResizeWindow(ctx context.Context, name string, cols, rows int) {
	c.Run(ctx, nil, "resize-window", "-t", "="+name+":", "-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows))
}

// AttachArgs is the tmux argv (after the binary) that attaches to the agent's session.
func (c *Client) AttachArgs(name string) []string {
	return []string{"-L", c.Socket, "attach-session", "-t", "=" + name}
}

// Shell is one of the human's own terminals.
type Shell struct {
	ID      string `json:"id"`
	Cwd     string `json:"cwd"`
	Machine string `json:"machine"`
}

// NewShell starts the human's own terminal: a login shell in tmux, named sh-XXXXX, kept until it exits. It gets this
// process's env without the STAM_AGENT* variables, with TERM=xterm-256color.
func (c *Client) NewShell(ctx context.Context, cwd, machine string) (Shell, error) {
	id := "sh-" + randomBase36(5)
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "bash"
	}
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "STAM_AGENT") && !strings.HasPrefix(kv, "TERM=") {
			env = append(env, kv)
		}
	}
	tctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	cmd := exec.CommandContext(tctx, c.bin(), "-L", c.Socket, "new-session", "-d", "-s", id, "-x", "120", "-y", "40", "-c", cwd, shell, "-l")
	cmd.Env = append(env, "TERM=xterm-256color")
	cmd.WaitDelay = time.Second
	if out, err := cmd.CombinedOutput(); err != nil {
		return Shell{}, fmt.Errorf("tmux new-session: %v: %s", err, strings.TrimSpace(string(out)))
	}
	if _, err := c.call(ctx, nil, "set-option", "-t", id, "status", "off"); err != nil {
		return Shell{}, err
	}
	return Shell{ID: id, Cwd: cwd, Machine: machine}, nil
}

// ListShells is the human's terminals on the server.
func (c *Client) ListShells(ctx context.Context, machine string) []Shell {
	r := c.Run(ctx, nil, "list-sessions", "-F", "#{session_name}\t#{pane_current_path}")
	if r.Status != 0 {
		return []Shell{}
	}
	out := []Shell{}
	for _, l := range strings.Split(strings.TrimSpace(r.Stdout), "\n") {
		if strings.HasPrefix(l, "sh-") {
			id, cwd, _ := strings.Cut(l, "\t")
			cwd, _, _ = strings.Cut(cwd, "\t")
			out = append(out, Shell{ID: id, Cwd: cwd, Machine: machine})
		}
	}
	return out
}

// randomBase36 is n random characters of [0-9a-z], like Math.random().toString(36).slice(2, 2+n) in TS.
func randomBase36(n int) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, n)
	for i := range b {
		k, _ := rand.Int(rand.Reader, big.NewInt(36))
		b[i] = digits[k.Int64()]
	}
	return string(b)
}

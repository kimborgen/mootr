// Command stam is the Go CLI (S-2194, S-2803). It speaks to the daemon over HTTP like src/cli.ts: `daemon`, `spawn`,
// `wait`, `ls`, `show`, `attach`, `web`, `events`, the agent-control commands (control.go), `kill`, `forget`, `cos`, `retro`, `mcp` (the MCP
// server, go/internal/mcp, and the shared logins), `mcp-proxy`, and the two commands harnesses call, `hook` and
// `statusline` (bin/stam-fast), and `req`, `ring`, `permissions`, `authorize` and `deny` (req.go). The other subcommands are
// not ported yet.
//
// What tests and lib.sh parse is the TS CLI's, byte for byte: `daemon status` (`machine: 'NAME'`), `show`'s JSON,
// `events` lines, and the hook's stdout. An error prints `stam: MESSAGE` to stderr and exits 1; a `wait` that times out
// prints `timed out waiting for STATES` and exits 2.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

const usage = `usage: stam <command>

  stam mcp [status|login NAME|logout NAME|lease-rotate]
  stam mcp-proxy NAME
  stam daemon [run|start|stop|status]
  stam spawn NAME [options] [PROMPT]
  stam wait AGENT [--until STATE[,STATE]...] [--timeout SECONDS]
  stam ls [--all]
  stam show AGENT
  stam attach AGENT
  stam web [serve]
  stam pause|unpause|shutdown|archive|resume|restart|reconnect-mcp|compact AGENT [--now] [--force] [--discard] [--force-unpushed] [TEXT]
  stam rename AGENT NAME
  stam reparent AGENT [PARENT...]
  stam child-notices AGENT turn|tree-idle|none
  stam events AGENT [--type GLOB] [--limit N]
  stam kill AGENT
  stam forget AGENT
  stam cos [AGENT]
  stam retro --search WORDS | --plus-one S-N --details T | --kind K --title T --summary T --details T | --final --effort reading=50,... | --digest
  stam embedder [status]
  stam registry
  stam settings migrate [--apply] [--json]
  stam req ls|show|new|set|link|check|seed
  stam ring [NAME [TOPIC...] [--format F] [--members A,B] [--spawn P,M] [--moderator A] [--decide] [--rounds N] [--cwd DIR]]
  stam permissions
  stam authorize|deny ID [NOTE]

The Go CLI is a skeleton: the other commands are in the TypeScript CLI.
`

// env is what a command reads from outside: the environment, the standard streams, and the working directory.
type env struct {
	getenv func(string) string
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
	cwd    func() (string, error)
	// environ is the whole environment, for a child process.
	environ func() []string
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	e := env{getenv: os.Getenv, stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr, cwd: os.Getwd, environ: os.Environ}
	code := run(ctx, os.Args[1:], e)
	stop()
	os.Exit(code)
}

// exitError is a failure with its own exit code.
type exitError struct {
	code int
	msg  string
}

func (e *exitError) Error() string { return e.msg }

// run is the CLI: it returns the exit code.
func run(ctx context.Context, args []string, e env) int {
	var err error
	if len(args) == 0 {
		fmt.Fprint(e.stdout, usage)
		return 0
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "hook":
		return hook(ctx, rest, e)
	case "statusline":
		return statusline(ctx, rest, e)
	case "mcp":
		err = mcpCmd(ctx, rest, e)
	case "mcp-proxy":
		err = mcpProxy(ctx, rest, e)
	case "daemon":
		err = daemon(ctx, rest, e)
	case "spawn":
		err = spawn(ctx, rest, e)
	case "mail":
		err = mail(ctx, rest, e)
	case "itsa":
		err = itsaCmd(ctx, rest, e)
	case "ls":
		err = ls(ctx, rest, e)
	case "pause", "unpause", "shutdown", "archive", "resume", "restart", "reconnect-mcp", "compact":
		err = control(ctx, cmd, rest, e)
	case "rename", "reparent":
		err = renameOrReparent(ctx, cmd, rest, e)
	case "child-notices":
		err = childNotices(ctx, rest, e)
	case "show":
		err = show(ctx, rest, e)
	case "attach":
		err = attach(ctx, rest, e)
	case "web":
		err = web(ctx, rest, e)
	case "events":
		err = events(ctx, rest, e)
	case "wait":
		err = wait(ctx, rest, e)
	case "kill":
		err = kill(ctx, rest, e)
	case "forget":
		err = forget(ctx, rest, e)
	case "cos":
		err = cos(ctx, rest, e)
	case "retro":
		err = retro(ctx, rest, e)
	case "embedder":
		err = embedder(ctx, rest, e)
	case "registry":
		err = registry(ctx, rest, e)
	case "settings":
		err = settingsCmd(rest, e)
	case "req":
		err = reqCmd(ctx, rest, e)
	case "ring":
		err = ringCmd(ctx, rest, e)
	case "permissions":
		err = permissions(ctx, e)
	case "authorize", "deny":
		err = answer(ctx, cmd, rest, e)
	case "help", "--help", "-h":
		fmt.Fprint(e.stdout, usage)
		return 0
	default:
		err = fmt.Errorf("%s is not ported to the Go CLI yet", cmd)
	}
	if err == nil {
		return 0
	}
	var ee *exitError
	if errors.As(err, &ee) {
		if ee.msg != "" {
			fmt.Fprintln(e.stderr, ee.msg)
		}
		return ee.code
	}
	fmt.Fprintf(e.stderr, "stam: %v\n", err)
	return 1
}

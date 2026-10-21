// Command stam is the Go CLI (S-2194, S-2803). It speaks to the daemon over HTTP like src/cli.ts: `daemon`, `spawn`,
// `wait`, `show`, `events`, `kill`, `forget`, `mcp` (the MCP server, go/internal/mcp), and the two commands harnesses
// call, `hook` and `statusline` (bin/stam-fast). The other subcommands are not ported yet.
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

  stam mcp
  stam daemon [run|start|stop|status]
  stam spawn NAME [options] [PROMPT]
  stam wait AGENT [--until STATE[,STATE]...] [--timeout SECONDS]
  stam show AGENT
  stam events AGENT [--type GLOB] [--limit N]
  stam kill AGENT
  stam forget AGENT

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
	case "daemon":
		err = daemon(ctx, rest, e)
	case "spawn":
		err = spawn(ctx, rest, e)
	case "mail":
		err = mail(ctx, rest, e)
	case "itsa":
		err = itsaCmd(ctx, rest, e)
	case "show":
		err = show(ctx, rest, e)
	case "events":
		err = events(ctx, rest, e)
	case "wait":
		err = wait(ctx, rest, e)
	case "kill":
		err = kill(ctx, rest, e)
	case "forget":
		err = forget(ctx, rest, e)
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

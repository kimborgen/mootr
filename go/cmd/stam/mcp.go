package main

import (
	"context"
	"fmt"
	"os"

	"stam/internal/mcp"
)

// mcpCmd is `stam mcp`: the stdio server a harness spawns. Its subcommands (status, login, logout) manage a remote
// server's shared login and are not ported.
func mcpCmd(ctx context.Context, args []string, e env) error {
	if len(args) > 0 {
		return fmt.Errorf("mcp %s is not ported to the Go CLI yet", args[0])
	}
	exe, _ := os.Executable()
	return mcp.New(mcp.Options{In: e.stdin, Out: e.stdout, Err: e.stderr, Getenv: e.getenv, Cwd: e.cwd, Exe: exe}).Run(ctx)
}

package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"stam/internal/client"
	"stam/internal/jsfmt"
	"stam/internal/mcp"
	"stam/internal/mcpauth"
)

// leaseRotate is `stam mcp lease-rotate` (S-3176): a new lease token for peers' MCP leases, written to the file only. The
// old one is refused at once, and the peer token is unchanged.
func leaseRotate(e env) error {
	home := e.getenv("MOOTR_HOME")
	if home == "" {
		home = e.getenv("STAM_HOME")
	}
	if home == "" {
		return fmt.Errorf("STAM_HOME is not set")
	}
	if err := mcpauth.RotateLeaseToken(home); err != nil {
		return err
	}
	fmt.Fprintln(e.stdout, "rotated the MCP lease token (STAM_HOME/mcp-lease-token). Peers that lease from this home need the new value in settings.peers[].leaseToken.")
	return nil
}

// mcpCmd is `stam mcp` (src/cli.ts): alone, the stdio server a harness spawns; its subcommands manage a remote server's
// shared login (S-50).
func mcpCmd(ctx context.Context, args []string, e env) error {
	sub, name := "", ""
	if len(args) > 0 {
		sub = args[0]
	}
	if len(args) > 1 {
		name = args[1]
	}
	switch sub {
	case "status":
		return mcpStatus(ctx, e)
	case "login":
		if name == "" {
			return fmt.Errorf("usage: stam mcp login NAME")
		}
		// The login route accepts only the human through `tailscale serve`, which the CLI is not; the web UI has the button.
		r, err := getJSON(ctx, client.New(e.getenv), "POST", "/api/mcp/"+name+"/login", nil, 0)
		if u, ok := r.Get("url"); err == nil && ok {
			fmt.Fprintln(e.stdout, jsString(u))
			return nil
		}
		fmt.Fprintf(e.stdout, "Log in to %s from the web UI's Settings.\n", name)
		return nil
	case "lease-rotate":
		return leaseRotate(e)
	case "logout":
		if name == "" {
			return fmt.Errorf("usage: stam mcp logout NAME")
		}
		// The daemon's answer is the reason: a refusal, such as a peer's logout, prints as the daemon wrote it (S-3178).
		if _, err := client.New(e.getenv).Do(ctx, "POST", "/api/mcp/"+name+"/logout", nil, 0); err != nil {
			return err
		}
		fmt.Fprintf(e.stdout, "logged out of %s\n", name)
		return nil
	}
	exe, _ := os.Executable()
	return mcp.New(mcp.Options{In: e.stdin, Out: e.stdout, Err: e.stderr, Getenv: e.getenv, Cwd: e.cwd, Exe: exe}).Run(ctx)
}

// mcpStatus is `stam mcp status`: one line per server with an auth, and on a peer a line when the home is unreachable
// (S-3178). No line holds a token.
func mcpStatus(ctx context.Context, e env) error {
	page, err := getJSON(ctx, client.New(e.getenv), "GET", "/api/mcp/status", nil, 0)
	if err != nil {
		return err
	}
	servers, _ := page.Get("servers")
	for _, s := range servers.Items {
		state := "not logged in"
		if g, _ := s.Get("local_grant"); g.Truthy() {
			// A peer's old grant from before the lease is a local login on this machine, not a logout (S-3177).
			state = "local login on this machine"
		} else if l, _ := s.Get("logged_in"); l.Truthy() {
			state = "logged in"
		}
		line := padEnd(jsString(get(s, "name")), 16) + " " + padEnd(jsString(get(s, "type")), 6) + " " + state
		if x, _ := s.Get("expires_at"); x.Truthy() {
			line += " (expires " + isoFromMs(x.Num) + ")"
		}
		fmt.Fprintln(e.stdout, line)
	}
	if h, _ := page.Get("home"); h.Truthy() {
		if r, _ := h.Get("reachable"); !r.Truthy() {
			why := ""
			if x, ok := h.Get("error"); ok && x.Kind != jsfmt.Null {
				why = jsString(x)
			}
			fmt.Fprintln(e.stdout, strings.TrimRight(jsString(get(h, "name"))+" is unreachable: its MCP logins are not listed. "+why, " \t\n"))
		}
	}
	return nil
}

// get is v[k], the zero value (undefined) when absent.
func get(v jsfmt.Value, k string) jsfmt.Value {
	x, _ := v.Get(k)
	return x
}

// isoFromMs is new Date(ms).toISOString() of a number's literal.
func isoFromMs(num string) string {
	ms, _ := strconv.ParseFloat(num, 64)
	return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02T15:04:05.000Z")
}

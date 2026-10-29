package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"stam/internal/config"
)

// web is src/cli.ts `stam web [serve]`: the addresses the web UI answers on. With local login on (S-2121), the
// token-less page on this machine logs in as the human, so it comes first, and a token link says it isn't the human.
// `serve` first serves the daemon over HTTPS on the tailnet with `tailscale serve`; its hosts aren't listed.
func web(ctx context.Context, args []string, e env) error {
	_, lookErr := exec.LookPath("tailscale")
	tailscale := lookErr == nil
	if len(args) > 0 && args[0] == "serve" && !tailscale {
		return &exitError{code: 1, msg: "stam web serve needs tailscale on PATH (https://tailscale.com/download); without it, use the addresses `stam web` prints"}
	}
	cfg, err := config.Load(e.getenv)
	if err != nil {
		return err
	}
	port := strconv.Itoa(cfg.Port)
	if len(args) > 0 && args[0] == "serve" {
		// HTTPS on the tailnet through `tailscale serve`; the owner's devices need no token.
		serve := []string{"serve", "--bg", "--https=443", "http://127.0.0.1:" + port}
		if runInherit(ctx, e, "tailscale", serve...) != nil {
			_ = runInherit(ctx, e, "sudo", append([]string{"tailscale"}, serve...)...)
		}
	}
	local := config.NewSettingsFile(cfg.Home, cfg.Machine).Get().Auth.LocalHuman && runtime.GOOS == "linux"
	if local {
		fmt.Fprintf(e.stdout, "http://127.0.0.1:%s/   (this machine: log in as the human with a one-time command)\n", port)
	}
	// TS also lists the tailscale serve hosts as needing no token; the Go daemon can't prove the human through serve yet
	// (no whois), so it lists none.
	mark := ""
	if local {
		mark = "   (token link: not the human, so approvals and settings are refused)"
	}
	for _, addr := range webBindAddresses(ctx, e, tailscale) {
		fmt.Fprintf(e.stdout, "http://%s:%s/#token=%s%s\n", addr, port, cfg.Token.Reveal(), mark)
	}
	return nil
}

// webBindAddresses is src/daemon.ts bindAddresses: STAM_BIND as given, else 127.0.0.1 and this machine's tailnet
// address when tailscale is installed.
func webBindAddresses(ctx context.Context, e env, tailscale bool) []string {
	bind := e.getenv("MOOTR_BIND")
	if bind == "" {
		bind = e.getenv("STAM_BIND")
	}
	if bind != "" {
		return strings.Split(bind, ",")
	}
	addrs := []string{"127.0.0.1"}
	if !tailscale {
		return addrs
	}
	tctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(tctx, "tailscale", "ip", "-4").Output(); err == nil {
		if ip, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n"); ip != "" {
			addrs = append(addrs, ip)
		}
	}
	return addrs
}

// runInherit runs name with the CLI's own streams.
func runInherit(ctx context.Context, e env, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, e.stdout, e.stderr
	return cmd.Run()
}

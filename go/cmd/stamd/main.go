// Command stamd is the Go daemon (S-2194). It serves the routes in go/internal/server on STAM_BIND:STAM_PORT from the
// home's stam.db, which the TS daemon (or a test) must have made: stamd creates neither the database nor the tokens.
//
// Environment (go/internal/config): STAM_HOME (required: unset is refused until the switch), STAM_PORT (7878),
// STAM_BIND (comma-separated, default 127.0.0.1), STAM_MACHINE (default the hostname), STAM_RELEASE_ID, STAM_TMUX_SOCKET,
// STAM_URL (what agents call back on), STAM_CLAUDE_BIN, and STAM_ROOT (the checkout, by default go/bin/stamd's
// grandparent).
//
// It runs Claude Code agents in tmux sessions on STAM_TMUX_SOCKET (go/internal/lifecycle). Stopping it leaves the tmux
// server and the agents running, and the next start keeps them. A home other than the live one must name a socket of its
// own: the default (stam) is refused there.
//
// On SIGTERM or SIGINT it ends the event streams, stops the listeners, waits for requests in flight, and closes the
// database, so the WAL is checkpointed and a restart finds no stale -wal or -shm files.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/adapters/opencode"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/lifecycle"
	"stam/internal/mcpauth"
	"stam/internal/push"
	"stam/internal/server"
	"stam/internal/sse"
	"stam/internal/templates"
	"stam/internal/tmux"
)

const stopWait = 5 * time.Second

// drainWait is how long the stop waits for the terminal sockets after Shutdown (server.WaitTerminals): with stopWait,
// within the 15 s `stam daemon stop` waits.
const drainWait = 5 * time.Second

// newLifecycle builds the lifecycle from the daemon's environment: the checkout it runs from (go/bin/stamd's
// grandparent, src/config.ts ROOT), stam's own command there (STAM_BIN; a release's is RELEASES/current/bin/stam),
// Claude Code's binary (STAM_CLAUDE_BIN, else claude), the home's tmux socket, and the shared OpenCode server
// (STAM_OPENCODE_BIN and STAM_OPENCODE_PORT, src/adapters/opencode.ts).
func newLifecycle(ctx context.Context, cfg config.Config, d *db.DB, settings *config.SettingsFile, hub *sse.Hub) (*lifecycle.Lifecycle, *templates.Set, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, nil, err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return nil, nil, err
	}
	root := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
	if r := os.Getenv("STAM_ROOT"); r != "" {
		root = r
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return nil, nil, err
	}
	bin := filepath.Join(root, "bin", "stam")
	if cfg.Release != "" {
		bin = filepath.Join(cfg.Home, "releases", "current", "bin", "stam")
	}
	claudeBin := os.Getenv("STAM_CLAUDE_BIN")
	if claudeBin == "" {
		claudeBin = "claude"
	}
	url := os.Getenv("STAM_URL")
	if url == "" {
		url = "http://127.0.0.1:" + strconv.Itoa(cfg.Port)
	}
	tpl := &templates.Set{Root: root, Home: cfg.Home, UserHome: userHome, Settings: settings.Get, Machine: cfg.Machine}
	tc := &tmux.Client{Socket: cfg.TmuxSocket}
	port, err := opencode.PortOf(os.Getenv)
	if err != nil {
		return nil, nil, err
	}
	oc := &opencode.Server{
		Config: func() opencode.Env {
			return opencode.Env{Home: cfg.Home, UserHome: userHome, Root: root, Bin: bin, Settings: settings.Get(),
				Registry: config.Registry(root, cfg.Home, cfg.Machine), Getenv: os.Getenv}
		},
		Tmux: tc, Bin: opencode.BinPath(os.Getenv, userHome), Port: port, URL: url, Live: cfg.Live,
	}
	return lifecycle.New(ctx, lifecycle.Options{
		DB:       d,
		Tmux:     tc,
		Settings: settings,
		Claude: claude.Env{Home: cfg.Home, UserHome: userHome, ConfigDir: os.Getenv("CLAUDE_CONFIG_DIR"), Bin: bin, ClaudeBin: claudeBin,
			TestTmpBase: claude.TestTmpBase(os.Getenv, userHome), UID: os.Getuid(), Templates: tpl},
		OpenCode: oc,
		URL:      url,
		Machine:  cfg.Machine,
		Live:     hub,
		Streams:  push.New(),
	}), tpl, nil
}

// checkSocket refuses the live home's tmux socket for any other home: the reconcile loop and kills of a test or second
// home would reach the live agents' sessions. TS shares the socket then; the Go daemon doesn't.
func checkSocket(cfg config.Config) error {
	if !cfg.Live && cfg.TmuxSocket == config.DefaultTmuxSocket {
		return fmt.Errorf("STAM_HOME %s isn't the live home, so it needs a tmux socket of its own: set STAM_TMUX_SOCKET (the default %q is the live home's)",
			cfg.Home, config.DefaultTmuxSocket)
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		slog.Error("stamd stopped", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	if err := checkSocket(cfg); err != nil {
		return err
	}
	// The lease token peers send for an MCP lease (S-3176), created once and kept across restarts.
	if err := mcpauth.EnsureLeaseToken(cfg.Home); err != nil {
		return err
	}
	d, err := db.Open(ctx, cfg.DBPath(), db.Options{})
	if err != nil {
		return err
	}
	defer func() {
		if err := d.Close(); err != nil {
			slog.Error("db close failed", "err", err)
		}
	}()
	hub := sse.New(sse.Keepalive)
	settings := config.NewSettingsFile(cfg.Home, cfg.Machine)
	// The defaults written on a first start, and keys added since (src/settings.ts ensureSettings, S-2121).
	if err := settings.Ensure(); err != nil {
		return err
	}
	// The lifecycle's background work (first prompts, the reconcile loop) ends with lifeCtx, before the database
	// closes; the tmux sessions stay up.
	lifeCtx, endLife := context.WithCancel(ctx)
	life, tpl, err := newLifecycle(lifeCtx, cfg, d, settings, hub)
	if err != nil {
		endLife()
		return err
	}
	defer life.Wait()
	defer endLife()
	handler := server.New(cfg, settings, d, hub, life)
	handler.UseTemplates(tpl)
	// The secret store read, opencode.env imported once, and the MCP client secrets moved into it (S-2114, S-2736).
	handler.StartSecrets()
	// The handler's background work ends with lifeCtx too, and shutdown waits for it before the database closes.
	defer func() {
		endLife()
		handler.WaitBackground()
	}()
	handler.StartProcessRun(ctx)
	// A test daemon's startup seed lands before the waits are rebuilt and the first reconcile reads the agents, as in
	// src/daemon.ts.
	if err := handler.ApplyTestSeed(ctx); err != nil {
		return err
	}
	handler.RecoverSkillImports()
	// S-3923: the answer notices a restart found unread go back in their agents' queues before any push.
	if err := life.RestoreAnswerNotices(lifeCtx); err != nil {
		return err
	}
	life.StartOrg()
	life.StartReconcile()
	// The shared OpenCode server, kept when a healthy one runs, and its event stream (S-4237).
	life.StartOpenCode()
	life.StartBanners()
	life.StartWaits()
	life.StartRules()
	handler.StartRequirements(lifeCtx)
	handler.StartPermissions(lifeCtx)
	handler.StartSwitchedItsas(lifeCtx)
	handler.StartPendingUnowns(lifeCtx)
	handler.StartAutoArchive(lifeCtx)
	handler.StartSearchIndex(lifeCtx)
	handler.StartSettingsSync(lifeCtx)
	handler.StartWebOrigin(lifeCtx)
	handler.StartLayout(lifeCtx)
	handler.StartViews(lifeCtx)
	// A crash leaves windows `manual` with no web viewer left to reset them; the terminal sockets end with the daemon.
	handler.StartTerminals(lifeCtx)
	handler.StartMachines(lifeCtx)
	// After the sampler's first tick, so the queue's load guard reads it (S-2120).
	handler.StartSlotQueue(lifeCtx)
	handler.StartOutbox(lifeCtx)
	handler.StartEvents(lifeCtx)

	port := strconv.Itoa(cfg.Port)
	servers := make([]*http.Server, 0, len(cfg.Binds))
	for _, bind := range cfg.Binds {
		srv := &http.Server{
			Addr:              net.JoinHostPort(bind, port),
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
		}
		servers = append(servers, srv)
		slog.Info("listening", "addr", srv.Addr, "machine", cfg.Machine)
	}
	return serve(ctx, endLife, hub, servers, (*http.Server).ListenAndServe, handler.WaitTerminals)
}

// serve runs each server with listen until ctx ends or one stops, then shuts them all down. The lifecycle ends first
// (endLife), whichever way serving stopped: its agents' push streams run until it does, and Shutdown waits for them.
// Shutdown doesn't wait for a hijacked connection, so drain waits for the terminal sockets, each PTY hung up and reaped,
// before serve returns and the database closes.
func serve(ctx context.Context, endLife context.CancelFunc, hub *sse.Hub, servers []*http.Server, listen func(*http.Server) error, drain func(context.Context) error) error {
	errs := make(chan error, len(servers))
	for _, srv := range servers {
		go func() { errs <- listen(srv) }()
	}

	var served error
	select {
	case served = <-errs:
	case <-ctx.Done():
		slog.Info("stopping")
	}
	endLife()

	shutdown, cancel := context.WithTimeout(context.Background(), stopWait)
	defer cancel()
	// Streams first: http.Server.Shutdown waits for every handler but a hijacked one (drain, below), and a stream's runs
	// until its client goes.
	if err := hub.Close(shutdown); err != nil {
		slog.Warn("event streams didn't end in time", "err", err)
	}
	for _, srv := range servers {
		if err := srv.Shutdown(shutdown); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Warn("shutdown", "addr", srv.Addr, "err", err)
		}
	}
	// The drain has a budget of its own, so a Shutdown that took all of stopWait doesn't hand it an expired one: enough
	// for a hung-up attach to be continued, terminated and killed.
	drainCtx, endDrain := context.WithTimeout(context.Background(), drainWait)
	defer endDrain()
	if err := drain(drainCtx); err != nil {
		slog.Warn("terminal sockets didn't end in time", "err", err)
	}
	if served != nil && !errors.Is(served, http.ErrServerClosed) {
		return served
	}
	return nil
}

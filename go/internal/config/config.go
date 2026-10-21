// Package config reads the daemon's environment and its home's files the way src/config.ts and src/test-env.ts do
// (S-2614): STAM_HOME, STAM_PORT, STAM_BIND, STAM_MACHINE, STAM_TMUX_SOCKET, the token and peer-token files, and
// whether the home is a test home. Unlike TS, STAM_HOME has no default until the switch.
//
// The token files are read, never written or chmod-changed: a home whose files are missing is refused, and the TS
// daemon (or test/lib.sh) is what creates them.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	defaultPort = 7878
	defaultBind = "127.0.0.1"
	// DefaultTmuxSocket is the tmux socket a daemon uses when STAM_TMUX_SOCKET is unset: the live home's.
	DefaultTmuxSocket = "stam"
	// TestHomeMarker is the file test/lib.sh's daemon_home writes into a test home (src/test-env.ts).
	TestHomeMarker = ".stam-test-home"
)

// Config is what the daemon knows about itself at start.
type Config struct {
	// Home is STAM_HOME, which must be set: an unset one is refused, never the live home by default.
	Home string
	// Live is whether Home is the live home (src/config.ts LIVE_HOME).
	Live bool
	Port int
	// Binds are the addresses the daemon listens on (STAM_BIND, comma-separated, default 127.0.0.1). Not yet ported:
	// the Tailscale bind (src/daemon.ts bindAddresses adds `tailscale ip -4`); the switch phase ports it.
	Binds   []string
	Machine string
	// Release is STAM_RELEASE_ID, empty when the daemon runs from a checkout.
	Release    string
	TmuxSocket string
	// DeployRepo is STAM_DEPLOY_REPO: the checkout the deploy watcher deploys from, empty when unset.
	DeployRepo string
	// Token is the shared token (STAM_HOME/token), PeerToken the one other daemons send (STAM_HOME/peer-token).
	Token     Secret
	PeerToken Secret
	// TestHome is whether Home holds the test-home marker with test/lib.sh's owner file beside it (src/test-env.ts).
	TestHome bool
	// TestHooks is whether the /api/test/* routes may answer: src/test-hooks.ts testHooksAllowed and TestHome.
	TestHooks bool
	// TestHumanKey stands in for the human in a test home only (STAM_TEST_HUMAN_KEY, S-634); empty elsewhere.
	TestHumanKey Secret
}

// Load reads the config from env (os.Getenv in the daemon) and the home's token files.
func Load(env func(string) string) (Config, error) {
	userHome, err := os.UserHomeDir()
	if err != nil {
		return Config{}, fmt.Errorf("config: %w", err)
	}
	liveHome := filepath.Join(userHome, ".local", "share", "stam")
	// Until the switch, an unset STAM_HOME is an error rather than the live home, so stamd never serves it by accident.
	if env("STAM_HOME") == "" {
		return Config{}, errors.New("config: STAM_HOME is not set; the Go daemon serves no default home yet")
	}
	c := Config{
		Home:       env("STAM_HOME"),
		Release:    env("STAM_RELEASE_ID"),
		DeployRepo: env("STAM_DEPLOY_REPO"),
		TmuxSocket: or(env("STAM_TMUX_SOCKET"), DefaultTmuxSocket),
	}
	c.Live = sameFile(c.Home, liveHome)
	c.Port = defaultPort
	if p := env("STAM_PORT"); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n <= 0 || n > 65535 {
			return Config{}, fmt.Errorf("config: STAM_PORT %q is not a port", p)
		}
		c.Port = n
	}
	for _, b := range strings.Split(or(env("STAM_BIND"), defaultBind), ",") {
		if b = strings.TrimSpace(b); b != "" {
			c.Binds = append(c.Binds, b)
		}
	}
	if len(c.Binds) == 0 {
		c.Binds = []string{defaultBind}
	}
	c.Machine = env("STAM_MACHINE")
	if c.Machine == "" {
		if c.Machine, err = os.Hostname(); err != nil {
			return Config{}, fmt.Errorf("config: %w", err)
		}
	}
	if c.Token, err = readSecret(filepath.Join(c.Home, "token")); err != nil {
		return Config{}, err
	}
	if c.PeerToken, err = readSecret(filepath.Join(c.Home, "peer-token")); err != nil {
		return Config{}, err
	}
	c.TestHome = !c.Live && IsTestHome(c.Home)
	// src/test-hooks.ts compares the home with the default path as written, not resolved; Live covers a symlink too.
	c.TestHooks = env("STAM_TEST_COST_HOOKS") == "1" && c.Home != liveHome &&
		strings.HasPrefix(c.TmuxSocket, "stam-test-") && c.TestHome
	if key := env("STAM_TEST_HUMAN_KEY"); key != "" {
		if c.TestHome {
			c.TestHumanKey = Secret(key)
		} else {
			slog.Warn("STAM_TEST_HUMAN_KEY is set but ignored: not a test home")
		}
	}
	return c, nil
}

// IsTestHome is src/test-env.ts testHome: home holds the marker, and its parent folder test/lib.sh's owner file.
func IsTestHome(home string) bool {
	h, err := filepath.EvalSymlinks(home)
	if err != nil {
		return false
	}
	return exists(filepath.Join(h, TestHomeMarker)) && exists(filepath.Join(filepath.Dir(h), "owner"))
}

// DBPath is the home's stam.db.
func (c Config) DBPath() string { return filepath.Join(c.Home, "stam.db") }

// readSecret reads a token file, trimmed as src/config.ts does. A missing or empty file is an error: an empty token
// would match a bare "Bearer " header.
func readSecret(path string) (Secret, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("config: %s is missing: the Go daemon reads token files and never creates them", path)
	}
	if err != nil {
		return "", fmt.Errorf("config: read %s: %w", path, err)
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return "", fmt.Errorf("config: %s is empty", path)
	}
	return Secret(s), nil
}

func sameFile(a, b string) bool {
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	if errA != nil || errB != nil {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	return ra == rb
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func or(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}

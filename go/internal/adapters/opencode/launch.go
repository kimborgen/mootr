package opencode

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"stam/internal/adapters"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/tmux"
)

// TestHomeMarker is the file a test home holds (src/test-env.ts TEST_HOME_MARKER, config.TestHomeMarker).
const TestHomeMarker = ".stam-test-home"

// BinFor is src/test-env.ts opencodeBinFor: the OpenCode binary a daemon on home runs, or why it may run none (S-4237,
// S-107), the one boundary every launcher meets. Outside a test home, and in a smoke test (STAM_TEST_SMOKE), it is bin
// as given. A home holding the test-home marker never runs the real OpenCode: the marker alone decides. There bin is
// resolved once, to an absolute path with every link followed, and that path is both what is judged and what runs, so
// a PATH or a cwd that differs at launch (the server's session, a TUI's shell) can't run another binary. A bare name is
// looked up on PATH; a relative path, a bare name not on PATH, or a path that isn't there is refused. The path is
// refused when it is one of the real ones, resolved the same way: ~/.opencode/bin/opencode (STAM_TEST_REAL_OPENCODE in
// the guard's own test) and `opencode` on PATH.
func BinFor(bin, home string, live bool, getenv func(string) string) (string, error) {
	if live || home == "" || envVar(getenv, "TEST_SMOKE") != "" {
		return bin, nil
	}
	// The home and its marker are read failing closed: only a home or marker that isn't there leaves bin as given.
	h, err := filepath.EvalSymlinks(home)
	if err == nil {
		_, err = os.Stat(filepath.Join(h, TestHomeMarker))
	}
	if notFound(err) {
		return bin, nil
	}
	if err != nil {
		return "", fmt.Errorf("can't tell whether %s is a test home, so its OpenCode binary isn't run: %w", home, err)
	}
	// A PATH entry that can't be read refuses, where one that isn't there is skipped.
	onPath := func(name string) (string, error) {
		for _, dir := range filepath.SplitList(getenv("PATH")) {
			if dir == "" || !filepath.IsAbs(dir) {
				continue
			}
			p := filepath.Join(dir, name)
			fi, err := os.Stat(p)
			if notFound(err) {
				continue
			}
			if err != nil {
				return "", fmt.Errorf("can't read %s on PATH, so this test home can't tell which opencode runs: %w", p, err)
			}
			if fi.Mode().IsRegular() && fi.Mode()&0o111 != 0 {
				return p, nil
			}
		}
		return "", nil
	}
	if strings.Contains(bin, "/") && !filepath.IsAbs(bin) {
		return "", fmt.Errorf("OpenCode binary %q is a relative path, which this test home refuses: it could run another binary from the cwd it launches in", bin)
	}
	path := bin
	if !strings.Contains(bin, "/") {
		if path, err = onPath(bin); err != nil {
			return "", err
		}
	}
	if bin == "" || path == "" {
		return "", fmt.Errorf("OpenCode binary %q isn't a path and isn't on PATH, so this test home can't tell it from the real opencode", bin)
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("OpenCode binary %q isn't there or doesn't resolve, so this test home can't tell it from the real opencode", bin)
	}
	real, _ = filepath.Abs(real)
	def := envVar(getenv, "TEST_REAL_OPENCODE")
	if def == "" {
		userHome := getenv("HOME")
		if userHome == "" {
			userHome, _ = os.UserHomeDir()
		}
		def = filepath.Join(userHome, ".opencode", "bin", "opencode")
	}
	pathReal, err := onPath("opencode")
	if err != nil {
		return "", err
	}
	for _, r := range []string{def, pathReal} {
		if r == "" {
			continue
		}
		// A real one that isn't there is compared as named; one that can't be read refuses.
		c, err := filepath.EvalSymlinks(r)
		switch {
		case notFound(err):
			c = r
		case err != nil:
			return "", fmt.Errorf("can't read the real opencode's path %s, so this test home can't tell it from %q: %w", r, bin, err)
		default:
			c, _ = filepath.Abs(c)
		}
		if c == real {
			return "", fmt.Errorf("refusing the real opencode (%s) in a test home; only a smoke test (STAM_TEST_SMOKE) may run it", real)
		}
	}
	return real, nil
}

// notFound is whether err says a path isn't there: missing, or under a file that isn't a folder.
func notFound(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR)
}

// bin is the binary the server and the TUIs run: Bin through BinFor.
func (s *Server) bin() (string, error) {
	e := s.Config()
	getenv := e.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	return BinFor(s.Bin, e.Home, s.Live, getenv)
}

// Launch is src/adapters/opencode.ts launch: the server ensured, then the agent's session made (POST /api/session with
// its title, folder, model, permission rules and stam id), or on a resume its rules applied again (PATCH), since a
// session keeps the rules it was made with (S-1891). The TUI attaches to the server and the session: its command names
// neither the prompt nor a key, and it reads the server's password from its file (tuiArgv). sessionID is the new session's id, ""
// on a resume.
func (s *Server) Launch(ctx context.Context, a db.Agent, resume bool) (spec adapters.LaunchSpec, sessionID string, err error) {
	if err := s.Ensure(ctx); err != nil {
		return spec, "", err
	}
	bin, err := s.bin()
	if err != nil {
		return spec, "", err
	}
	e := s.Config()
	// Made here if it isn't yet; the TUI reads it from its file (tuiArgv).
	if err := tuiPassword(e.Home); err != nil {
		return spec, "", err
	}
	perms := PermissionsJSON(SessionPermissions(string(a.PermissionMode), a.Cwd, e.Home, e.UserHome))
	env := tmux.Env{}
	if resume && a.SessionID != nil && *a.SessionID != "" {
		sid := *a.SessionID
		if _, err := s.Call(ctx, "PATCH", "/api/session/"+sid, jsjson.NewObject("permissions", perms)); err != nil {
			return spec, "", err
		}
		return adapters.LaunchSpec{Argv: tuiArgv(e.Home, bin, s.Base(), sid), Env: env}, "", nil
	}
	var model jsjson.Value
	if a.Model != nil && *a.Model != "" {
		provider, id, _ := strings.Cut(*a.Model, "/")
		model = jsjson.NewObject("providerID", provider, "id", id)
	}
	res, err := s.Call(ctx, "POST", "/api/session", jsjson.NewObject("title", a.Name, "location", jsjson.NewObject("directory", a.Cwd),
		"model", model, "permissions", perms, "metadata", jsjson.NewObject("stam_agent", a.ID)))
	if err != nil {
		return spec, "", err
	}
	o, _ := res.(*jsjson.Object)
	id, _ := o.Get("id")
	sid, _ := id.(string)
	if sid == "" {
		return spec, "", errors.New("OpenCode made no session")
	}
	return adapters.LaunchSpec{Argv: tuiArgv(e.Home, bin, s.Base(), sid), Env: env}, sid, nil
}

// passwordScript sets OPENCODE_SERVER_PASSWORD from the first line of the file in $1, by the shell's own read (which
// drops the line's leading and trailing spaces and tabs), then runs the rest of its arguments. A password inherited from
// the daemon is dropped first, and an empty one runs nothing, so a password that can't be read fails the start.
const passwordScript = `unset OPENCODE_SERVER_PASSWORD; read -r OPENCODE_SERVER_PASSWORD <"$1"; [ -n "$OPENCODE_SERVER_PASSWORD" ] || exit 1; export OPENCODE_SERVER_PASSWORD; shift; exec "$@"`

// tuiPassword makes the server's password if there is none yet, and refuses a password file the TUI's read
// (passwordScript) would take differently from the server's (Password): an empty one, or one whose first line, spaces
// and tabs dropped, isn't the whole password. Neither error quotes the file.
func tuiPassword(home string) error {
	text, err := passwordText(home)
	if err != nil {
		return err
	}
	pw := jsjson.Trim(text)
	line, _, _ := strings.Cut(text, "\n")
	if pw == "" || strings.Trim(line, " \t") != pw {
		return fmt.Errorf("%s doesn't hold the OpenCode password on one line of its own", PasswordFile(home))
	}
	return nil
}

// tuiArgv is the TUI's command: BIN --server URL --session SID, with the server's password read from its 0600 file
// (PasswordFile) as the TUI starts, so the password is in no command line, no env tmux is given and no file of tmux's
// (new-session.conf): only the TUI's own env. bin is the path BinFor checked, run as it is.
func tuiArgv(home, bin, base, sid string) []string {
	return []string{"/bin/sh", "-c", passwordScript, "sh", PasswordFile(home), bin, "--server", base, "--session", sid}
}

// Prompt is src/adapters/opencode.ts pushPrompt and afterLaunch's first prompt: text queued in the session through the
// server's API (delivery queue), never typed into the TUI or put on a command line.
func (s *Server) Prompt(ctx context.Context, sessionID, text string) error {
	_, err := s.Call(ctx, "POST", "/api/session/"+sessionID+"/prompt", jsjson.NewObject("text", text, "delivery", "queue"))
	return err
}

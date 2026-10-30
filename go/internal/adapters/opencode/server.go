package opencode

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"stam/internal/adapters"
	"stam/internal/auth"
	"stam/internal/jsjson"
	"stam/internal/proctree"
	"stam/internal/secrets"
	"stam/internal/tmux"
)

// SessionName is the tmux session the shared server runs in (src/adapters/opencode.ts SERVER_SESSION). It is killed
// only by this exact name, never by a pattern.
const SessionName = "_opencode"

// DefaultPort is the server's port when STAM_OPENCODE_PORT is unset.
const DefaultPort = 4790

const (
	// callTimeout bounds every API call but the event stream (TS's AbortSignal.timeout).
	callTimeout = 10 * time.Second
	// startPolls health checks, pollEvery apart, wait for a new server (TS: 40 of 500 ms).
	startPolls = 40
	pollEvery  = 500 * time.Millisecond
	// reconnectAfter is the event stream's pause before it asks for the server again.
	reconnectAfter = 2 * time.Second
	// exitWait bounds the wait for an old server's process to exit after its session is killed: the kill's SIGKILL comes
	// tmux.Grace after its SIGTERM.
	exitWait = tmux.Grace + 5*time.Second
)

// Server is stam's own OpenCode server, one for every OpenCode agent (src/adapters/opencode.ts). It runs in the tmux
// session SessionName on 127.0.0.1:Port with a password only stam and the agents' TUIs know, so it needs no access to
// the user's own OpenCode service. A daemon restart finds a healthy server there and keeps it, so the agents keep their
// sessions; a server that isn't healthy is stopped, by its session's name, and its process waited for before another
// starts, so two never run.
type Server struct {
	// Config is the config the server reads, asked for on each start (WriteConfig): the settings change.
	Config func() Env
	Tmux   *tmux.Client
	// Bin is OpenCode's binary (BinPath). In a test home it runs as BinFor resolved it, or not at all.
	Bin  string
	Port int
	// Live is whether the home is the live one (config.Config.Live), where BinFor leaves Bin as it is.
	Live bool
	// URL is the daemon's STAM_URL, which the plugin calls back on.
	URL string
	// HTTP is the client for the server's API; http.DefaultClient's transport when nil.
	HTTP *http.Client
	// CallTimeout bounds every API call but the event stream; callTimeout when 0 (tests make it short).
	CallTimeout time.Duration
	// Sleep waits d, or until ctx ends; tests make it return at once.
	Sleep func(ctx context.Context, d time.Duration) error

	// mu guards the server's one lifecycle slot: cur runs, next is the restart that runs after it.
	mu        sync.Mutex
	cur, next *slotOp
	// configMu is held while the config is written (Refresh) and across a start, from its config to its new server's
	// health, so the server never reads a config half written.
	configMu sync.Mutex
	// joined and queued, nil outside tests, run when an Ensure or Restart waits on an op already running or queued, and
	// when a Restart is queued behind the running op.
	joined, queued func()
	// startOf reads a process's start time (proctree.StartOf); tests make it fail.
	startOf func(pid int) (string, bool, error)
}

// slotOp is one Ensure or Restart in the lifecycle slot, with the outcome every caller waiting on it gets.
type slotOp struct {
	restart bool
	done    chan struct{}
	err     error
}

// BinPath is src/adapters/opencode.ts BIN: STAM_OPENCODE_BIN (MOOTR_ first), else ~/.opencode/bin/opencode when it
// is there, else opencode on PATH.
func BinPath(getenv func(string) string, userHome string) string {
	if b := envVar(getenv, "OPENCODE_BIN"); b != "" {
		return b
	}
	if p := filepath.Join(userHome, ".opencode", "bin", "opencode"); exists(p) {
		return p
	}
	return "opencode"
}

// PortOf is src/adapters/opencode.ts PORT: STAM_OPENCODE_PORT (MOOTR_ first), else DefaultPort. A value that isn't a
// port is an error, where TS would listen on NaN.
func PortOf(getenv func(string) string) (int, error) {
	v := envVar(getenv, "OPENCODE_PORT")
	if v == "" {
		return DefaultPort, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 || n > 65535 {
		return 0, fmt.Errorf("STAM_OPENCODE_PORT %q is not a port", v)
	}
	return n, nil
}

// envVar is src/env.ts envVar: MOOTR_NAME, else STAM_NAME.
func envVar(getenv func(string) string, name string) string {
	if v := getenv("MOOTR_" + name); v != "" {
		return v
	}
	return getenv("STAM_" + name)
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// Base is the server's URL.
func (s *Server) Base() string { return "http://127.0.0.1:" + strconv.Itoa(s.Port) }

// PasswordFile is STAM_HOME/opencode-password, mode 0600.
func PasswordFile(home string) string { return filepath.Join(home, "opencode-password") }

// Password is src/adapters/opencode.ts password: the server's password, made on first need (0600). A new one is written
// in full before it is linked into place, so two starts at once never make two and a reader never sees half of one. It
// is never logged, and no error quotes it.
func Password(home string) (string, error) {
	text, err := passwordText(home)
	return jsjson.Trim(text), err
}

// passwordText is the password file's text as it is, made first if there is none (Password).
func passwordText(home string) (string, error) {
	p := PasswordFile(home)
	text, err := readPassword(p)
	if errors.Is(err, fs.ErrNotExist) {
		if err = createPassword(p); err == nil {
			text, err = readPassword(p)
		}
	}
	return text, err
}

// readPassword reads the password file through one descriptor, opened without following a link (a dangling one
// included) and without blocking on a FIFO. It must be a regular file the daemon's user owns; a mode other than 0600 is
// repaired on that descriptor before it is read.
func readPassword(p string) (string, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if errors.Is(err, syscall.ELOOP) {
		return "", fmt.Errorf("%s is a symlink; the OpenCode password is read only from a file of its own", p)
	}
	if err != nil {
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	switch {
	case !st.Mode().IsRegular():
		return "", fmt.Errorf("%s is not a regular file", p)
	case !ok || int(sys.Uid) != os.Getuid():
		return "", fmt.Errorf("%s is not owned by this user", p)
	case st.Mode().Perm() != 0o600:
		if err := f.Chmod(0o600); err != nil {
			return "", fmt.Errorf("%s has mode %o and can't be made 0600: %w", p, st.Mode().Perm(), err)
		}
	}
	text, err := io.ReadAll(f)
	if err != nil {
		return "", err
	}
	return string(text), nil
}

// createPassword writes a new password aside and links it into place: link(2) fails with EEXIST when another start
// made one first, and that one is kept.
func createPassword(p string) error {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".opencode-password-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	_, werr := tmp.WriteString(base64.RawURLEncoding.EncodeToString(b))
	if cerr := tmp.Close(); werr != nil || cerr != nil {
		return errors.Join(werr, cerr)
	}
	if err := os.Link(tmp.Name(), p); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	return nil
}

func (s *Server) home() string { return s.Config().Home }

func (s *Server) client() *http.Client {
	if s.HTTP != nil {
		return s.HTTP
	}
	return &http.Client{}
}

func (s *Server) sleep(ctx context.Context, d time.Duration) error {
	if s.Sleep != nil {
		return s.Sleep(ctx, d)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

func (s *Server) request(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	pw, err := Password(s.home())
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, s.Base()+path, body)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth("opencode", pw)
	return req, nil
}

// Call is src/adapters/opencode.ts oc: one API call with a JSON body (none when body is nil), within callTimeout. A
// v2 answer wrapped as `{data}` is unwrapped. A status other than 2xx is a *CallError, which unlike TS's never quotes the
// answer.
func (s *Server) Call(ctx context.Context, method, path string, body jsjson.Value) (jsjson.Value, error) {
	text, err := s.callText(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(text)) == 0 {
		return jsjson.NewObject(), nil
	}
	v, err := jsjson.Parse(text)
	if err != nil {
		return nil, fmt.Errorf("OpenCode %s %s: %w", method, path, err)
	}
	if o, ok := v.(*jsjson.Object); ok {
		if data, ok := o.Get("data"); ok {
			return data, nil
		}
	}
	return v, nil
}

// callText is Call's request: the answer's text as the server sent it, for a 2xx status.
func (s *Server) callText(ctx context.Context, method, path string, body jsjson.Value) ([]byte, error) {
	limit := callTimeout
	if s.CallTimeout > 0 {
		limit = s.CallTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	var r io.Reader
	if body != nil {
		r = strings.NewReader(jsjson.Stringify(body, ""))
	}
	req, err := s.request(ctx, method, path, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	res, err := s.client().Do(req)
	if err != nil {
		return nil, fmt.Errorf("OpenCode %s %s: %w", method, path, err)
	}
	defer res.Body.Close()
	text, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("OpenCode %s %s: %w", method, path, err)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, &CallError{Method: method, Path: path, Status: res.StatusCode}
	}
	return text, nil
}

// CallError is a failed call's status. Nothing the server answered reaches it, not even an error name, since any string
// in the answer can hold a key in some spelling (escaped, short, percent-encoded, an echo of the request's auth, a key
// shaped like a name): only the method, path and status. No caller reads more; ClassifyError reads the event stream.
type CallError struct {
	Method, Path string
	Status       int
}

func (e *CallError) Error() string {
	return fmt.Sprintf("OpenCode %s %s: %d %s", e.Method, e.Path, e.Status, http.StatusText(e.Status))
}

// Healthy is whether the server answers its API (GET /openapi.json).
func (s *Server) Healthy(ctx context.Context) bool {
	_, err := s.Call(ctx, "GET", "/openapi.json", nil)
	return err == nil
}

// Ensure is src/adapters/opencode.ts ensureServer: the server is up when it returns nil, the running one if it is
// healthy, else a new one. Ensure and Restart share one lifecycle slot: an Ensure that comes while one runs waits for it
// and shares its outcome (the daemon's start, the event stream's reconnect and agents' launches at boot all ask at once).
func (s *Server) Ensure(ctx context.Context) error { return s.submit(ctx, false) }

// Restart is src/adapters/opencode.ts afterUpgrade: the server stopped (its process waited for), the config written
// again, and a new server, all in the lifecycle slot. An op already running never stands for it, a restart that began
// before it included: a Restart that comes while another op runs is queued behind it, and one already queued is shared.
func (s *Server) Restart(ctx context.Context) error { return s.submit(ctx, true) }

func (s *Server) submit(ctx context.Context, restart bool) error {
	s.mu.Lock()
	var c *slotOp
	switch {
	case s.next != nil:
		// A queued restart covers an Ensure too: either way the server is up, and new, once it ran.
		c = s.next
		s.hook(s.joined)
	case s.cur != nil && !restart:
		c = s.cur
		s.hook(s.joined)
	case s.cur != nil:
		c = &slotOp{restart: true, done: make(chan struct{})}
		s.next = c
		s.hook(s.queued)
	default:
		c = &slotOp{restart: restart, done: make(chan struct{})}
		s.cur = c
		go s.run(context.WithoutCancel(ctx), c)
	}
	s.mu.Unlock()
	select {
	case <-c.done:
		return c.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) hook(f func()) {
	if f != nil {
		f()
	}
}

// run runs c, then the restart queued behind it, until the slot is empty. No caller's end stops it.
func (s *Server) run(ctx context.Context, c *slotOp) {
	for c != nil {
		if c.restart {
			if c.err = s.stopOld(ctx); c.err == nil {
				c.err = s.start(ctx)
			}
		} else {
			c.err = s.start(ctx)
		}
		s.mu.Lock()
		close(c.done)
		c, s.next = s.next, nil
		s.cur = c
		s.mu.Unlock()
	}
}

// start is src/adapters/opencode.ts startServer.
func (s *Server) start(ctx context.Context) error {
	// Before the healthy shortcut, as TS's bin() is: a refused binary leaves the server start failing.
	bin, err := s.bin()
	if err != nil {
		return err
	}
	if s.Tmux.HasSession(ctx, SessionName) && !s.Tmux.IsDead(ctx, SessionName) && s.Healthy(ctx) {
		return nil
	}
	// The config stays as written until the new server is up or gone: a Refresh waits (configMu).
	s.configMu.Lock()
	defer s.configMu.Unlock()
	e := s.Config()
	if err := WriteConfig(e); err != nil {
		return err
	}
	if err := s.stopOld(ctx); err != nil {
		return err
	}
	token, err := MintServerToken(e.Home)
	if err != nil {
		return err
	}
	env, err := s.serverEnv(e, token)
	if err != nil {
		return err
	}
	// The Go bin dir goes first on the server's PATH too (S-3666): the agents' bash runs in this server.
	argv := adapters.GoBinArgv([]string{bin, "serve", "--hostname", "127.0.0.1", "--port", strconv.Itoa(s.Port)}, adapters.GoBinDir(nil))
	err = s.Tmux.NewSession(ctx, SessionName, e.Home, env, argv)
	if err == nil {
		err = s.awaitHealthy(ctx)
	}
	if err != nil {
		// A server that didn't come up isn't left running: its session is stopped and its process waited for, even
		// when ctx ended.
		if serr := s.stopOld(context.WithoutCancel(ctx)); serr != nil {
			return errors.Join(err, serr)
		}
	}
	return err
}

// awaitHealthy polls a new server's health, startPolls times.
func (s *Server) awaitHealthy(ctx context.Context) error {
	for i := 0; i < startPolls; i++ {
		if err := s.sleep(ctx, pollEvery); err != nil {
			return err
		}
		if s.Healthy(ctx) {
			return nil
		}
	}
	return errors.New("OpenCode server did not start")
}

// Refresh writes the server's config again (WriteConfig), for a server already running, never while a start writes it
// and its new server reads it.
func (s *Server) Refresh() error {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	return WriteConfig(s.Config())
}

// stopOld kills the server's session by its exact name, then waits until the process its pane ran has exited, so a new
// server never starts beside it. A status that can't be read counts as still running: the wait goes on, and past
// exitWait it is an error and no server starts.
func (s *Server) stopOld(ctx context.Context) error {
	pid, live, err := s.Tmux.PanePID(ctx, SessionName)
	if err != nil {
		return err
	}
	start := ""
	if live {
		startOf := s.startOf
		if startOf == nil {
			startOf = proctree.StartOf
		}
		var gone bool
		if start, gone, err = startOf(pid); err != nil {
			// Not known to be gone: it counts as running, and nothing is stopped or started.
			return fmt.Errorf("the OpenCode server's process (pid %d) can't be read, so stam won't replace it: %w", pid, err)
		}
		live = !gone
	}
	if err := s.Tmux.KillSession(ctx, SessionName); err != nil {
		return err
	}
	if !live {
		return nil
	}
	end := time.Now().Add(exitWait)
	for {
		exited, err := proctree.Exited(pid, start)
		if exited {
			return nil
		}
		if time.Now().After(end) {
			if err != nil {
				return fmt.Errorf("the old OpenCode server (pid %d) may still run: %w", pid, err)
			}
			return fmt.Errorf("the old OpenCode server (pid %d) still runs %s after its session was killed", pid, exitWait)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// serverEnv is the server's own environment, in TS's order: the provider keys from the secret store's agent slot and
// opencode.env (secrets.AgentEnv, S-2114), the provider blocks' keys (S-2118), then the password, the config folder,
// and the daemon's URL and the server's own token (S-240), not the shared one, so an OpenCode agent acts only as itself.
// The keys reach the server alone: the plugin drops them from every tool shell's env, and the TUIs never get them.
func (s *Server) serverEnv(e Env, token string) (tmux.Env, error) {
	var env tmux.Env
	agent := secrets.AgentEnv(e.Home, e.Getenv)
	keys := make([]string, 0, len(agent))
	for k := range agent {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		env = env.Set(k, agent[k])
	}
	p := Providers(e)
	if len(p.Collisions) > 0 {
		slog.Error("opencode: providers share a key variable; none of them is configured", "providers", strings.Join(p.Collisions, ", "))
	}
	for _, v := range p.Env {
		env = env.Set(v.Key, v.Value)
	}
	pw, err := Password(e.Home)
	if err != nil {
		return nil, err
	}
	env = env.Set("OPENCODE_SERVER_PASSWORD", pw)
	env = env.Set("OPENCODE_CONFIG_DIR", ConfigDir(e.Home))
	env = env.Set("STAM_URL", s.URL)
	return env.Set("STAM_TOKEN", token), nil
}

// ServerTokenFile is STAM_HOME/opencode-token: the hash of the server's own token, which auth reads.
func ServerTokenFile(home string) string { return filepath.Join(home, "opencode-token") }

// MintServerToken is src/agent-token.ts mintServerToken: a new token for each server start, of which only the hash is
// stored (0600), written aside and renamed into place. The token itself goes only into the server's session env.
func MintServerToken(home string) (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	tmp, err := os.CreateTemp(home, ".opencode-token-")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return "", err
	}
	_, werr := tmp.WriteString(auth.Hash(token))
	if cerr := tmp.Close(); werr != nil || cerr != nil {
		return "", errors.Join(werr, cerr)
	}
	if err := os.Rename(tmp.Name(), ServerTokenFile(home)); err != nil {
		return "", err
	}
	return token, nil
}

// Event is one event from the server's stream: its type and data.
type Event struct {
	Type string
	Data *jsjson.Object
	// Raw is the whole event, as OpenCode sent it.
	Raw jsjson.Value
}

// Follow is src/adapters/opencode.ts followEvents: it reads the server's event stream (GET /api/event) and hands each
// event to on, in order, until ctx ends. connected runs on each (re)connect, before the first event. A stream that
// fails or ends, or holds an event that isn't JSON, is read again after reconnectAfter, once the server is ensured.
func (s *Server) Follow(ctx context.Context, connected func(), on func(Event)) {
	for ctx.Err() == nil {
		if err := s.follow(ctx, connected, on); err != nil && ctx.Err() == nil {
			slog.Debug("opencode: event stream ended", "err", err)
		}
		if s.sleep(ctx, reconnectAfter) != nil {
			return
		}
		if err := s.Ensure(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("opencode: server not up", "err", err)
		}
	}
}

func (s *Server) follow(ctx context.Context, connected func(), on func(Event)) error {
	req, err := s.request(ctx, "GET", "/api/event", nil)
	if err != nil {
		return err
	}
	res, err := s.client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	if connected != nil {
		connected()
	}
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 64*1024), 64<<20)
	sc.Split(splitBlocks)
	for sc.Scan() {
		var data strings.Builder
		for _, l := range strings.Split(sc.Text(), "\n") {
			if rest, ok := strings.CutPrefix(l, "data:"); ok {
				data.WriteString(jsjson.Trim(rest))
			}
		}
		if data.Len() == 0 {
			continue
		}
		v, err := jsjson.Parse([]byte(data.String()))
		if err != nil {
			return err
		}
		o, _ := v.(*jsjson.Object)
		t, _ := o.Get("type")
		d, _ := o.Get("data")
		ts, _ := t.(string)
		do, _ := d.(*jsjson.Object)
		on(Event{Type: ts, Data: do, Raw: v})
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return io.EOF
}

// splitBlocks splits a stream at each blank line (`\n\n`), as TS's reader does.
func splitBlocks(data []byte, atEOF bool) (int, []byte, error) {
	if i := bytes.Index(data, []byte("\n\n")); i >= 0 {
		return i + 2, data[:i], nil
	}
	if atEOF {
		// TS keeps an unfinished block in its buffer and drops it when the stream ends.
		return len(data), nil, nil
	}
	return 0, nil, nil
}

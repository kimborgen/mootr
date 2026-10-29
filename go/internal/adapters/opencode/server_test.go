package opencode

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/jsjson"
	"stam/internal/proctree"
	"stam/internal/tmux"
)

func TestPassword(t *testing.T) {
	home := t.TempDir()
	var wg sync.WaitGroup
	got := make([]string, 16)
	errs := make([]error, 16)
	for i := range got {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			got[i], errs[i] = Password(home)
		}(i)
	}
	wg.Wait()
	for i := range got {
		if errs[i] != nil || got[i] != got[0] || len(got[0]) != 24 {
			t.Fatalf("Password %d = %q, %v; want one 24-character password for all", i, got[i], errs[i])
		}
	}
	st, err := os.Stat(PasswordFile(home))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("password file: %v %v", st, err)
	}
	entries, _ := os.ReadDir(home)
	if len(entries) != 1 {
		t.Errorf("only the password file is left: %v", entries)
	}
	if err := os.WriteFile(PasswordFile(home), []byte("  kept\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if p, err := Password(home); p != "kept" || err != nil {
		t.Errorf("an existing password is read and trimmed: %q %v", p, err)
	}
}

func testServer(t *testing.T, h http.Handler) *Server {
	t.Helper()
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	_, port, _ := net.SplitHostPort(ts.Listener.Addr().String())
	n, _ := strconv.Atoi(port)
	home := t.TempDir()
	return &Server{Config: func() Env { return Env{Home: home} }, Port: n,
		Sleep: func(ctx context.Context, d time.Duration) error { return ctx.Err() }}
}

func TestCall(t *testing.T) {
	var s *Server
	s = testServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pw, ok := r.BasicAuth()
		want, _ := Password(s.home())
		if !ok || user != "opencode" || pw != want {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/wrapped":
			fmt.Fprint(w, `{"data": {"id": "ses_1"}}`)
		case "/plain":
			fmt.Fprint(w, `[1, 2]`)
		case "/empty":
		case "/echo":
			b := new(bytes.Buffer)
			b.ReadFrom(r.Body)
			fmt.Fprintf(w, `{"data": %s}`, b.String())
		default:
			w.WriteHeader(500)
			fmt.Fprint(w, strings.Repeat("é", 300))
		}
	}))
	ctx := context.Background()
	if v, err := s.Call(ctx, "GET", "/wrapped", nil); err != nil || jsjson.Stringify(v, "") != `{"id":"ses_1"}` {
		t.Errorf("wrapped: %v %v", v, err)
	}
	if v, err := s.Call(ctx, "GET", "/plain", nil); err != nil || jsjson.Stringify(v, "") != `[1,2]` {
		t.Errorf("plain: %v %v", v, err)
	}
	if v, err := s.Call(ctx, "POST", "/empty", jsjson.NewObject()); err != nil || jsjson.Stringify(v, "") != `{}` {
		t.Errorf("empty: %v %v", v, err)
	}
	if v, err := s.Call(ctx, "POST", "/echo", jsjson.NewObject("text", "hi")); err != nil || jsjson.Stringify(v, "") != `{"text":"hi"}` {
		t.Errorf("echo: %v %v", v, err)
	}
	_, err := s.Call(ctx, "GET", "/fails", nil)
	if want := "OpenCode GET /fails: 500 Internal Server Error"; err == nil || err.Error() != want {
		t.Errorf("error: %v", err)
	}
}

// The event stream: blocks split across writes, comments and multi-line data, a reconnect after an event that isn't
// JSON and after the stream ends, with connected run on each connect.
func TestFollow(t *testing.T) {
	var mu sync.Mutex
	conns := 0
	var s *Server
	s = testServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/openapi.json" {
			fmt.Fprint(w, `{}`)
			return
		}
		if _, pw, _ := r.BasicAuth(); r.URL.Path != "/api/event" || pw == "" {
			w.WriteHeader(404)
			return
		}
		mu.Lock()
		conns++
		n := conns
		mu.Unlock()
		f := w.(http.Flusher)
		w.Header().Set("content-type", "text/event-stream")
		switch n {
		case 1:
			fmt.Fprint(w, ": hello\n\ndata: {\"type\": \"a\", \"data\": {\"sessionID\": \"s1\"}}\n\ndata: {\"type\":")
			f.Flush()
			fmt.Fprint(w, " \"b\"}\n\ndata: {\"ty\ndata: pe\": \"c\"}\n\ndata: not json\n\ndata: {\"type\": \"lost\"}\n\n")
		case 2:
			fmt.Fprint(w, "data: {\"type\": \"d\"}\n\ndata: {\"type\": \"unfinished\"}")
		}
	}))
	s.Tmux = startedTmux(t, func(tc *tmux.Client) {
		// The server's session is up and the fake answers its health check, so the reconnect's Ensure starts nothing.
		if err := tc.NewSession(context.Background(), SessionName, t.TempDir(), nil, []string{"sleep", "infinity"}); err != nil {
			t.Fatal(err)
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	var got []string
	connected := 0
	s.Follow(ctx, func() { connected++ }, func(e Event) {
		sid, _ := e.Data.Get("sessionID")
		got = append(got, fmt.Sprintf("%s:%v", e.Type, sid))
		if e.Type == "d" {
			cancel()
		}
	})
	if want := "a:s1 b:<nil> c:<nil> d:<nil>"; strings.Join(got, " ") != want || connected != 2 {
		t.Errorf("events %q, %d connects; want %q, 2", strings.Join(got, " "), connected, want)
	}
}

// startedTmux is a tmux server of the test's own, killed when it ends; setup runs on it first.
func startedTmux(t *testing.T, setup func(*tmux.Client)) *tmux.Client {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is not installed")
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	socket := "stam-test-oc-" + hex.EncodeToString(b)
	tc := &tmux.Client{Socket: socket, TempDir: t.TempDir()}
	t.Cleanup(func() {
		tc.Run(context.Background(), nil, "kill-server")
		dir := os.Getenv("TMUX_TMPDIR")
		if dir == "" {
			dir = "/tmp"
		}
		os.Remove(filepath.Join(dir, "tmux-"+strconv.Itoa(os.Getuid()), socket))
	})
	if setup != nil {
		setup(tc)
	}
	return tc
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// fakeBin is an `opencode` that counts its `serve` starts in COUNT and runs the scripted fake (test/fake-opencode).
func fakeBin(t *testing.T, dir string) (bin, count string) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	count = filepath.Join(dir, "serve-starts")
	bin = filepath.Join(dir, "opencode")
	fake := filepath.Join(repoRoot(t), "test", "fake-opencode", "opencode")
	script := fmt.Sprintf("#!/bin/sh\n[ \"$1\" = serve ] && echo \"$$\" >>%q\nexec %q \"$@\"\n", count, fake)
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, count
}

func starts(t *testing.T, count string) int {
	t.Helper()
	b, err := os.ReadFile(count)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(b), "\n")
}

// paneEnv is the environment of the process in the server's pane.
func paneEnv(t *testing.T, tc *tmux.Client) (int, map[string]string) {
	t.Helper()
	pid, live, err := tc.PanePID(context.Background(), SessionName)
	if err != nil || !live {
		t.Fatalf("server pane: %d %v %v", pid, live, err)
	}
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "environ"))
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{}
	for _, kv := range strings.Split(string(b), "\x00") {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	return pid, env
}

type ensureFixture struct {
	home, base, count string
	tc                *tmux.Client
	logs              *bytes.Buffer
	newServer         func() *Server
}

func newEnsureFixture(t *testing.T) *ensureFixture {
	t.Helper()
	f := &ensureFixture{base: t.TempDir()}
	f.home = filepath.Join(f.base, "home")
	userHome := filepath.Join(f.base, "user")
	write(t, filepath.Join(f.home, "secrets.json"), `{"secrets": {"or": {"value": "or-agent-key-value", "slot": "agent", "env": "OPENROUTER_API_KEY"}}, "imported": []}`)
	t.Setenv("TEST_OC_ZETA_KEY", "zeta-env-value")
	s, err := config.ParseSettings([]byte(`{"providers": {"zeta": {"kind": "openai-compatible", "baseUrl": "https://z.example.com", "apiKey": {"env": "TEST_OC_ZETA_KEY"}}}}`), "test-machine")
	if err != nil {
		t.Fatal(err)
	}
	bin, count := fakeBin(t, f.base)
	f.count = count
	f.tc = startedTmux(t, nil)
	port := freePort(t)
	f.newServer = func() *Server {
		return &Server{
			Config: func() Env {
				return Env{Home: f.home, UserHome: userHome, Root: repoRoot(t), Bin: "/bin/stam", Settings: s, Registry: jsjson.NewObject(), Getenv: os.Getenv}
			},
			Tmux: f.tc, Bin: bin, Port: port, URL: "http://127.0.0.1:1",
		}
	}
	f.logs = new(bytes.Buffer)
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(f.logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return f
}

// A start: one server in its session, with the keys and its own token in its env alone, none of them logged.
func TestEnsureStartsOneServer(t *testing.T) {
	f := newEnsureFixture(t)
	ctx := context.Background()
	s := f.newServer()
	if err := s.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	if !s.Healthy(ctx) || starts(t, f.count) != 1 {
		t.Fatalf("healthy %v, %d starts", s.Healthy(ctx), starts(t, f.count))
	}
	pid, env := paneEnv(t, f.tc)
	pw, _ := Password(f.home)
	for k, v := range map[string]string{"OPENROUTER_API_KEY": "or-agent-key-value", "STAM_PROVIDER_ZETA_KEY": "zeta-env-value",
		"OPENCODE_SERVER_PASSWORD": pw, "OPENCODE_CONFIG_DIR": ConfigDir(f.home), "STAM_URL": "http://127.0.0.1:1"} {
		if env[k] != v {
			t.Errorf("server env %s = %q, want %q", k, env[k], v)
		}
	}
	hash, _ := os.ReadFile(ServerTokenFile(f.home))
	if env["STAM_TOKEN"] == "" || auth.Hash(env["STAM_TOKEN"]) != string(hash) {
		t.Errorf("the server's token %q doesn't match the stored hash %q", env["STAM_TOKEN"], hash)
	}
	if st, err := os.Stat(ServerTokenFile(f.home)); err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("token file: %v %v", st, err)
	}
	cfg, _ := os.ReadFile(filepath.Join(ConfigDir(f.home), "opencode.json"))
	for _, secret := range []string{"or-agent-key-value", "zeta-env-value", pw, env["STAM_TOKEN"]} {
		if strings.Contains(f.logs.String(), secret) || strings.Contains(string(cfg), secret) {
			t.Errorf("a secret is in the logs or opencode.json: %q", secret)
		}
	}

	// A daemon restart: a new Server finds the healthy one and keeps it.
	if err := f.newServer().Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	if again, _ := paneEnv(t, f.tc); again != pid || starts(t, f.count) != 1 {
		t.Errorf("a restart started another server: pane %d (was %d), %d starts", again, pid, starts(t, f.count))
	}
}

// Two Ensures at once start one server: the second waits for the first's start and shares it.
func TestEnsureInterleaved(t *testing.T) {
	f := newEnsureFixture(t)
	ctx := context.Background()
	s := f.newServer()
	polled := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	s.Sleep = func(ctx context.Context, d time.Duration) error {
		once.Do(func() {
			close(polled)
			<-release
		})
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
			return nil
		}
	}
	first := make(chan error, 1)
	go func() { first <- s.Ensure(ctx) }()
	<-polled // the first is past NewSession, in its health wait
	joined := make(chan struct{})
	s.joined = func() { close(joined) }
	second := make(chan error, 1)
	go func() { second <- s.Ensure(ctx) }()
	var releaseOnce sync.Once
	free := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(free)
	select {
	case <-joined:
	case err := <-second:
		t.Fatalf("the second Ensure ran a start of its own (%v) while the first still started", err)
	case <-time.After(30 * time.Second):
		t.Fatal("the second Ensure neither joined nor returned")
	}
	free()
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if n := starts(t, f.count); n != 1 {
		t.Errorf("%d server starts, want 1", n)
	}
}

// A session that holds no healthy server is killed by name, and its process has exited before the new server starts:
// here one that ignores the hangup and the SIGTERM, so only the kill's SIGKILL, tmux.Grace later, ends it.
func TestEnsureReplacesUnhealthy(t *testing.T) {
	f := newEnsureFixture(t)
	ctx := context.Background()
	stubborn := []string{"/bin/sh", "-c", "trap '' HUP TERM; while :; do sleep 0.1; done"}
	if err := f.tc.NewSession(ctx, SessionName, f.base, nil, stubborn); err != nil {
		t.Fatal(err)
	}
	old, live, err := f.tc.PanePID(ctx, SessionName)
	if err != nil || !live {
		t.Fatal(old, live, err)
	}
	start := proctree.ProcStart(old)
	// It outlives the tmux server's kill, so a failed run still ends it.
	t.Cleanup(func() { proctree.SignalProcesses(proctree.Procs{old: start}, syscall.SIGKILL) })
	if err := f.newServer().Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	if exited, err := proctree.Exited(old, start); !exited || err != nil {
		t.Errorf("the old server (pid %d) still runs: %v", old, err)
	}
	if pid, _ := paneEnv(t, f.tc); pid == old || starts(t, f.count) != 1 {
		t.Errorf("pane %d (old %d), %d starts", pid, old, starts(t, f.count))
	}
}

// The password is read only from a regular file of its own: a symlink (a dangling one too) or a FIFO is refused, and
// a wider mode is repaired to 0600 on the descriptor it is read from.
func TestPasswordFileChecks(t *testing.T) {
	home := t.TempDir()
	p := PasswordFile(home)
	other := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.WriteFile(other, []byte("not-yours"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name string
		make func() error
	}{
		{"symlink", func() error { return os.Symlink(other, p) }},
		{"dangling symlink", func() error { return os.Symlink(filepath.Join(home, "nothing"), p) }},
		{"fifo", func() error { return syscall.Mkfifo(p, 0o600) }},
		{"folder", func() error { return os.Mkdir(p, 0o700) }},
	} {
		if err := c.make(); err != nil {
			t.Fatal(err)
		}
		if pw, err := Password(home); err == nil {
			t.Errorf("%s: read %q, want a refusal", c.name, pw)
		}
		if _, err := os.Stat(filepath.Join(home, "nothing")); err == nil {
			t.Errorf("%s: a password was written through the link", c.name)
		}
		if err := os.RemoveAll(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(p, []byte("wide\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, 0o644); err != nil {
		t.Fatal(err)
	}
	if pw, err := Password(home); pw != "wide" || err != nil {
		t.Errorf("0644: %q %v", pw, err)
	}
	if st, err := os.Stat(p); err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("0644 isn't repaired to 0600: %v %v", st, err)
	}
}

// A failed call's error never quotes the server's answer, however a key is spelled in it: escaped, short, percent-encoded,
// the request's own Basic auth echoed, or a key shaped like an error name. Not even a name is read from it. The error is
// checked as it is, and wrapped with %v and %w as a caller would.
func TestCallErrorsQuoteNothing(t *testing.T) {
	var s *Server
	s = testServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pw, _ := r.BasicAuth()
		switch r.URL.Path {
		case "/short":
			w.WriteHeader(500)
			fmt.Fprint(w, `{"key":"ag-key"}`)
		case "/escaped":
			w.WriteHeader(500)
			fmt.Fprint(w, `{"short":"\u0061g-key","long":"zeta\u002dkey\u002dvalue\u002d1234"}`)
		case "/encoded":
			w.WriteHeader(400)
			fmt.Fprint(w, "bad key zeta%2Dkey%2Dvalue%2D1234")
		case "/echo":
			w.WriteHeader(401)
			fmt.Fprintf(w, `{"auth":%q,"password":%q}`, r.Header.Get("authorization"), pw)
		case "/named":
			w.WriteHeader(500)
			fmt.Fprint(w, `{"name":"ProviderAuthError","data":{"message":"ag-key rejected"}}`)
		case "/nested":
			w.WriteHeader(404)
			fmt.Fprint(w, `{"error":{"name":"NotFoundError","message":"no session ag-key"}}`)
		case "/not-a-class":
			w.WriteHeader(500)
			fmt.Fprint(w, `{"name":"ag-key"}`)
		case "/key-named":
			w.WriteHeader(500)
			fmt.Fprint(w, `{"name":"ZetaKeyValueError","error":{"name":"Zeta\u004beyValueError"}}`)
		}
	}))
	home := s.home()
	write(t, filepath.Join(home, "secrets.json"), `{"secrets": {"or": {"value": "ag-key", "slot": "agent", "env": "OPENROUTER_API_KEY"}, "zv": {"value": "ZetaKeyValue", "slot": "agent", "env": "ZETA_NAMED_KEY"}}, "imported": []}`)
	t.Setenv("TEST_OC_ZETA_KEY", "zeta-key-value-1234")
	st, err := config.ParseSettings([]byte(`{"providers": {"zeta": {"kind": "openai-compatible", "baseUrl": "https://z.example.com", "apiKey": {"env": "TEST_OC_ZETA_KEY"}}}}`), "test-machine")
	if err != nil {
		t.Fatal(err)
	}
	s.Config = func() Env { return Env{Home: home, Settings: st, Registry: jsjson.NewObject(), Getenv: os.Getenv} }
	pw, _ := Password(home)
	for path, want := range map[string]string{
		"/short":       "OpenCode GET /short: 500 Internal Server Error",
		"/escaped":     "OpenCode GET /escaped: 500 Internal Server Error",
		"/encoded":     "OpenCode GET /encoded: 400 Bad Request",
		"/echo":        "OpenCode GET /echo: 401 Unauthorized",
		"/named":       "OpenCode GET /named: 500 Internal Server Error",
		"/nested":      "OpenCode GET /nested: 404 Not Found",
		"/not-a-class": "OpenCode GET /not-a-class: 500 Internal Server Error",
		"/key-named":   "OpenCode GET /key-named: 500 Internal Server Error",
	} {
		_, err := s.Call(context.Background(), "GET", path, nil)
		var ce *CallError
		if !errors.As(err, &ce) || err.Error() != want {
			t.Errorf("%s: %v, want %q", path, err, want)
		}
		for _, shown := range []string{fmt.Sprint(err), fmt.Errorf("launch: %v", err).Error(), fmt.Errorf("launch: %w", err).Error()} {
			for _, secret := range []string{pw, "ag-key", "zeta-key-value-1234", "ZetaKeyValue", "rejected", "session", "ProviderAuth", "NotFound"} {
				if strings.Contains(shown, secret) {
					t.Errorf("%s: the error quotes %q: %s", path, secret, shown)
				}
			}
		}
	}
}

// A server process whose start can't be read isn't known to be gone: Ensure stops nothing and starts nothing.
func TestEnsureKeepsAnUnreadableServer(t *testing.T) {
	f := newEnsureFixture(t)
	ctx := context.Background()
	if err := f.tc.NewSession(ctx, SessionName, f.base, nil, []string{"sleep", "infinity"}); err != nil {
		t.Fatal(err)
	}
	s := f.newServer()
	s.startOf = func(int) (string, bool, error) { return "", false, fmt.Errorf("stat: permission denied") }
	if err := s.Ensure(ctx); err == nil || !strings.Contains(err.Error(), "can't be read") {
		t.Errorf("Ensure: %v, want a refusal", err)
	}
	if !f.tc.HasSession(ctx, SessionName) || f.tc.IsDead(ctx, SessionName) {
		t.Error("the server whose state is unknown was stopped")
	}
	if n := starts(t, f.count); n != 0 {
		t.Errorf("%d servers started beside it", n)
	}
}

// gate holds requests for /openapi.json while armed, so a test can stop an Ensure inside its health check.
type gate struct {
	mu      sync.Mutex
	armed   bool
	entered chan struct{}
	release chan struct{}
}

func (g *gate) RoundTrip(r *http.Request) (*http.Response, error) {
	g.mu.Lock()
	hold := g.armed && r.URL.Path == "/openapi.json"
	if hold {
		g.armed = false
	}
	g.mu.Unlock()
	if hold {
		close(g.entered)
		<-g.release
	}
	return http.DefaultTransport.RoundTrip(r)
}

// alive is how many of the servers the fake started still run.
func alive(t *testing.T, count string) int {
	t.Helper()
	b, _ := os.ReadFile(count)
	n := 0
	for _, l := range strings.Fields(string(b)) {
		pid, _ := strconv.Atoi(l)
		if _, gone, err := proctree.StartOf(pid); err != nil || !gone {
			n++
		}
	}
	return n
}

// waitFor fails the test unless ch closes within a generous bound: a wait on state, which fails rather than hangs.
func waitFor(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(30 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// A Restart that comes while an Ensure checks the old healthy server isn't satisfied by that check: it runs after it,
// and ends with one new server.
func TestRestartDuringHealthCheck(t *testing.T) {
	f := newEnsureFixture(t)
	ctx := context.Background()
	g := &gate{entered: make(chan struct{}), release: make(chan struct{})}
	s := f.newServer()
	s.HTTP = &http.Client{Transport: g}
	if err := s.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	old, _ := paneEnv(t, f.tc)
	g.mu.Lock()
	g.armed = true
	g.mu.Unlock()
	ensured := make(chan error, 1)
	go func() { ensured <- s.Ensure(ctx) }()
	waitFor(t, g.entered, "the Ensure's health check")
	queued, joined := make(chan struct{}), make(chan struct{})
	s.queued = func() { close(queued) }
	s.joined = func() { close(joined) }
	restarted := make(chan error, 1)
	go func() { restarted <- s.Restart(ctx) }()
	select {
	case <-queued:
	case <-joined:
		t.Fatal("the Restart joined the op already running instead of queuing a restart of its own")
	case err := <-restarted:
		t.Fatalf("the Restart returned (%v) on the op already running, without a restart of its own", err)
	case <-time.After(30 * time.Second):
		t.Fatal("timed out waiting for the Restart to queue")
	}
	// An Ensure that comes now joins the queued Restart, so it returns only once the new server is up.
	joinedNext := make(chan struct{})
	s.joined = func() { close(joinedNext) }
	late := make(chan error, 1)
	go func() {
		err := s.Ensure(ctx)
		if err == nil {
			if pane, _ := paneEnv(t, f.tc); pane == old {
				err = fmt.Errorf("returned on the old server (pane %d)", pane)
			}
		}
		late <- err
	}()
	waitFor(t, joinedNext, "the late Ensure to join")
	close(g.release)
	if err := <-ensured; err != nil {
		t.Fatal(err)
	}
	if err := <-restarted; err != nil {
		t.Fatal(err)
	}
	if err := <-late; err != nil {
		t.Errorf("the Ensure that joined the queued Restart: %v", err)
	}
	now, _ := paneEnv(t, f.tc)
	if now == old || starts(t, f.count) != 2 || alive(t, f.count) != 1 || !s.Healthy(ctx) {
		t.Errorf("pane %d (old %d), %d starts, %d alive, healthy %v; want a new pane, 2 starts, 1 alive", now, old,
			starts(t, f.count), alive(t, f.count), s.Healthy(ctx))
	}
}

// A Restart that comes while an Ensure starts a server runs once that start is done, and ends with one server: the
// one it started.
func TestRestartDuringStart(t *testing.T) {
	f := newEnsureFixture(t)
	ctx := context.Background()
	s := f.newServer()
	polled := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	s.Sleep = func(ctx context.Context, d time.Duration) error {
		once.Do(func() {
			close(polled)
			<-release
		})
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
			return nil
		}
	}
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	ensured := make(chan error, 1)
	go func() { ensured <- s.Ensure(ctx) }()
	waitFor(t, polled, "the Ensure's start")
	first, _ := paneEnv(t, f.tc)
	queued, joined := make(chan struct{}), make(chan struct{})
	s.queued = func() { close(queued) }
	s.joined = func() { close(joined) }
	restarted := make(chan error, 1)
	go func() { restarted <- s.Restart(ctx) }()
	select {
	case <-queued:
	case <-joined:
		t.Fatal("the Restart joined the op already running instead of queuing a restart of its own")
	case err := <-restarted:
		t.Fatalf("the Restart returned (%v) on the op already running, without a restart of its own", err)
	case <-time.After(30 * time.Second):
		t.Fatal("timed out waiting for the Restart to queue")
	}
	close(release)
	if err := <-ensured; err != nil {
		t.Fatal(err)
	}
	if err := <-restarted; err != nil {
		t.Fatal(err)
	}
	now, _ := paneEnv(t, f.tc)
	if now == first || starts(t, f.count) != 2 || alive(t, f.count) != 1 || !s.Healthy(ctx) {
		t.Errorf("pane %d (first %d), %d starts, %d alive, healthy %v; want a new pane, 2 starts, 1 alive", now, first,
			starts(t, f.count), alive(t, f.count), s.Healthy(ctx))
	}
}

// A start whose server doesn't come up leaves none running: when its health wait runs out, and when its context ends
// in that wait, the session is stopped and its process has exited by the time Ensure returns.
func TestFailedStartLeavesNoServer(t *testing.T) {
	for _, c := range []struct {
		why, want string
		// end, when set, ends the caller's context at the first poll. Ensure returns at once, and the start it leaves
		// behind (which no caller's end stops) still cleans up when its health wait runs out.
		end bool
	}{
		{"the health wait runs out", "did not start", false},
		{"its context ends", "context canceled", true},
	} {
		t.Run(c.why, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f := newEnsureFixture(t)
			s := f.newServer()
			// A server that never answers: it only records its pid and waits.
			s.Bin = filepath.Join(f.base, "deaf-opencode")
			write(t, s.Bin, fmt.Sprintf("#!/bin/sh\necho \"$$\" >>%q\nexec sleep 1000\n", f.count))
			if err := os.Chmod(s.Bin, 0o755); err != nil {
				t.Fatal(err)
			}
			polls := 0
			s.Sleep = func(ctx context.Context, d time.Duration) error {
				if polls++; polls == 1 && starts(t, f.count) == 0 {
					// The pane's shell may not have run yet; wait for the pid before the first poll's outcome.
					for i := 0; i < 200 && starts(t, f.count) == 0; i++ {
						time.Sleep(10 * time.Millisecond)
					}
				}
				if c.end && polls == 1 {
					cancel()
				}
				return nil
			}
			err := s.Ensure(ctx)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("Ensure: %v; want %q", err, c.want)
			}
			for end := time.Now().Add(10 * time.Second); c.end && time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
				if !f.tc.HasSession(context.Background(), SessionName) && alive(t, f.count) == 0 {
					break
				}
			}
			if starts(t, f.count) != 1 {
				t.Fatalf("%d starts", starts(t, f.count))
			}
			if f.tc.HasSession(context.Background(), SessionName) || alive(t, f.count) != 0 {
				t.Errorf("session %v, %d alive; want neither", f.tc.HasSession(context.Background(), SessionName), alive(t, f.count))
			}
		})
	}
}

// A Refresh never writes the config while a start's new server may read it: one asked for in the start's health wait
// waits until the start is done, then writes.
func TestRefreshWaitsForAStart(t *testing.T) {
	f := newEnsureFixture(t)
	ctx := context.Background()
	s := f.newServer()
	polled := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	s.Sleep = func(ctx context.Context, d time.Duration) error {
		once.Do(func() {
			close(polled)
			<-release
		})
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
			return nil
		}
	}
	var releaseOnce sync.Once
	free := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(free)
	ensured := make(chan error, 1)
	go func() { ensured <- s.Ensure(ctx) }()
	waitFor(t, polled, "the start's health wait")
	refreshed := make(chan error, 1)
	go func() { refreshed <- s.Refresh() }()
	select {
	case err := <-refreshed:
		t.Fatalf("Refresh wrote (%v) while the start's server could still read the config", err)
	case <-time.After(300 * time.Millisecond):
	}
	free()
	if err := <-ensured; err != nil {
		t.Fatal(err)
	}
	if err := <-refreshed; err != nil {
		t.Fatal(err)
	}
	// A server already up still gets its config refreshed.
	cfg := filepath.Join(ConfigDir(f.home), "opencode.json")
	if err := os.Remove(cfg); err != nil {
		t.Fatal(err)
	}
	if err := s.Refresh(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cfg); err != nil {
		t.Errorf("the config wasn't written again: %v", err)
	}
}

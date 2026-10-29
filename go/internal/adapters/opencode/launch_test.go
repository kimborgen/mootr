package opencode

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"stam/internal/api"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/tmux"
)

// sentinel is a stand-in for the real OpenCode: a script that leaves a mark if anything runs it.
func sentinel(t *testing.T, dir string) (bin, mark string) {
	t.Helper()
	mark = filepath.Join(dir, "sentinel-ran")
	bin = filepath.Join(dir, "real", "opencode")
	write(t, bin, "#!/bin/sh\ntouch '"+mark+"'\n")
	if err := os.Chmod(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, mark
}

func envOf(kv map[string]string) func(string) string { return func(k string) string { return kv[k] } }

// BinFor in a marked test home: every spelling of the real binary is refused, a value it can't judge is too, and what
// passes is the absolute path it judged. Elsewhere it leaves bin alone.
func TestBinFor(t *testing.T) {
	base := t.TempDir()
	real, mark := sentinel(t, base)
	marked := filepath.Join(base, "marked")
	write(t, filepath.Join(marked, TestHomeMarker), "")
	plain := filepath.Join(base, "plain")
	if err := os.MkdirAll(plain, 0o700); err != nil {
		t.Fatal(err)
	}
	aliases := filepath.Join(base, "aliases")
	other := filepath.Join(base, "other")
	for _, d := range []string{aliases, other} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	link := func(target, name string) {
		if err := os.Symlink(target, name); err != nil {
			t.Fatal(err)
		}
	}
	link(real, filepath.Join(aliases, "oc"))
	link(filepath.Join(aliases, "oc"), filepath.Join(base, "link-to-link"))
	link(filepath.Join(base, "missing", "opencode"), filepath.Join(base, "dangling"))
	link("/bin/false", filepath.Join(other, "harmless"))
	elsewhere := filepath.Join(base, "elsewhere")
	write(t, filepath.Join(elsewhere, "opencode"), "#!/bin/sh\ntouch '"+mark+"'\n")
	if err := os.Chmod(filepath.Join(elsewhere, "opencode"), 0o755); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(repoRoot(t), "test", "fake-opencode", "opencode")
	sys := "/usr/bin:/bin"
	env := map[string]string{"HOME": base, "PATH": sys, "STAM_TEST_REAL_OPENCODE": real}
	with := func(extra map[string]string) func(string) string {
		e := map[string]string{}
		for k, v := range env {
			e[k] = v
		}
		for k, v := range extra {
			e[k] = v
		}
		return envOf(e)
	}
	for _, c := range []struct {
		why, bin, want string
		extra          map[string]string
	}{
		{"exact path", real, "real opencode", nil},
		{"symlink", filepath.Join(aliases, "oc"), "real opencode", nil},
		{"symlink to a symlink", filepath.Join(base, "link-to-link"), "real opencode", nil},
		{"path with ..", filepath.Join(base, "real", "..", "real", "opencode"), "real opencode", nil},
		{"PATH alias", "oc", "real opencode", map[string]string{"PATH": aliases + ":" + sys}},
		{"the PATH opencode", filepath.Join(elsewhere, "opencode"), "real opencode", map[string]string{"PATH": elsewhere + ":" + sys}},
		{"a bare name not on PATH", "nosuch-opencode", "isn't on PATH", nil},
		{"empty", "", "isn't on PATH", nil},
		{"relative", "./oc", "relative path", nil},
		{"relative without ./", "aliases/oc", "relative path", nil},
		{"missing", filepath.Join(base, "missing", "opencode"), "isn't there", nil},
		{"dangling", filepath.Join(base, "dangling"), "isn't there", nil},
		{"a relative PATH dir is skipped", "oc", "isn't on PATH", map[string]string{"PATH": "aliases:" + sys}},
	} {
		got, err := BinFor(c.bin, marked, false, with(c.extra))
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %q, %v; want an error naming %q", c.why, got, err, c.want)
		}
	}
	// Without STAM_TEST_REAL_OPENCODE, ~/.opencode/bin/opencode is the real one.
	def := filepath.Join(base, ".opencode", "bin", "opencode")
	write(t, def, "#!/bin/sh\ntouch '"+mark+"'\n")
	if err := os.Chmod(def, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := BinFor(def, marked, false, envOf(map[string]string{"HOME": base, "PATH": sys})); err == nil || !strings.Contains(err.Error(), "real opencode") {
		t.Errorf("the default location: %v", err)
	}

	canon := func(p string) string {
		r, err := filepath.EvalSymlinks(p)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	for _, c := range []struct {
		why, bin, home string
		live           bool
		extra          map[string]string
		want           string
	}{
		{"the fake", fake, marked, false, nil, canon(fake)},
		{"/bin/false", "/bin/false", marked, false, nil, canon("/bin/false")},
		{"a bare name", "harmless", marked, false, map[string]string{"PATH": other + ":" + sys}, canon("/bin/false")},
		{"smoke", real, marked, false, map[string]string{"STAM_TEST_SMOKE": "1"}, real},
		{"smoke, MOOTR_", real, marked, false, map[string]string{"MOOTR_TEST_SMOKE": "1"}, real},
		{"no marker", real, plain, false, nil, real},
		{"the live home", "./oc", marked, true, nil, "./oc"},
	} {
		got, err := BinFor(c.bin, c.home, c.live, with(c.extra))
		if err != nil || got != c.want {
			t.Errorf("%s: %q, %v; want %q", c.why, got, err, c.want)
		}
	}
	if _, err := os.Stat(mark); err == nil {
		t.Error("the sentinel ran")
	}
}

// BinFor fails closed: an error other than not-found, reading the home, its marker, a PATH entry or a real binary's
// path, refuses, where a home or marker that isn't there leaves bin as given and a PATH entry that isn't there is skipped.
func TestBinForFailsClosed(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a folder of mode 0")
	}
	base := t.TempDir()
	real, mark := sentinel(t, base)
	fake := filepath.Join(repoRoot(t), "test", "fake-opencode", "opencode")
	sys := "/usr/bin:/bin"
	mkdir := func(p string, mode os.FileMode) string {
		if err := os.MkdirAll(p, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, mode); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(p, 0o700) })
		return p
	}
	loop := func(p string) string {
		if err := os.Symlink(filepath.Base(p), p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	marked := filepath.Join(base, "marked")
	write(t, filepath.Join(marked, TestHomeMarker), "")
	// A home in a folder of mode 0 (EACCES), a home that is a link loop (ELOOP), a home whose own mode lets nothing be
	// looked up in it (EACCES on the marker), and a marker that is a link loop.
	locked := mkdir(filepath.Join(base, "locked"), 0o700)
	write(t, filepath.Join(locked, "home", TestHomeMarker), "")
	os.Chmod(locked, 0)
	noSearch := filepath.Join(base, "nosearch")
	write(t, filepath.Join(noSearch, TestHomeMarker), "")
	mkdir(noSearch, 0o600)
	loopMarker := mkdir(filepath.Join(base, "loopmarker"), 0o700)
	loop(filepath.Join(loopMarker, TestHomeMarker))
	// PATH entries: a folder of mode 0, and one whose `oc` and `opencode` are link loops.
	lockedPath := mkdir(filepath.Join(base, "lockedpath"), 0)
	loopPath := mkdir(filepath.Join(base, "looppath"), 0o700)
	loop(filepath.Join(loopPath, "oc"))
	loop(filepath.Join(loopPath, "opencode"))
	// The real binary's path: under a folder of mode 0, or a link loop. (EvalSymlinks counts a loop itself: "too many
	// links"; a Stat gets ELOOP.)
	lockedReal := filepath.Join(mkdir(filepath.Join(base, "lockedreal"), 0), "opencode")
	loopReal := loop(filepath.Join(base, "loopreal"))
	env := func(kv ...string) func(string) string {
		e := map[string]string{"HOME": base, "PATH": sys, "STAM_TEST_REAL_OPENCODE": real}
		for i := 0; i+1 < len(kv); i += 2 {
			e[kv[i]] = kv[i+1]
		}
		return envOf(e)
	}
	for _, c := range []struct {
		why, bin, home, want string
		getenv               func(string) string
	}{
		{"the home in a folder of mode 0", real, filepath.Join(locked, "home"), "permission denied", env()},
		{"the home a link loop", real, loop(filepath.Join(base, "loophome")), "too many links", env()},
		{"the marker can't be looked up", real, noSearch, "permission denied", env()},
		{"the marker a link loop", real, loopMarker, "too many levels", env()},
		{"bin's PATH entry of mode 0", "oc", marked, "permission denied", env("PATH", lockedPath+":"+sys)},
		{"bin's PATH entry a link loop", "oc", marked, "too many levels", env("PATH", loopPath+":"+sys)},
		{"the PATH opencode's entry of mode 0", fake, marked, "permission denied", env("PATH", lockedPath+":"+sys)},
		{"the PATH opencode a link loop", fake, marked, "too many levels", env("PATH", loopPath+":"+sys)},
		{"the real binary under a folder of mode 0", fake, marked, "permission denied", env("STAM_TEST_REAL_OPENCODE", lockedReal)},
		{"the real binary a link loop", fake, marked, "too many links", env("STAM_TEST_REAL_OPENCODE", loopReal)},
	} {
		got, err := BinFor(c.bin, c.home, false, c.getenv)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %q, %v; want a refusal naming %q", c.why, got, err, c.want)
		}
	}
	// Not there is no test home, and a real binary that isn't there is no match.
	if got, err := BinFor(real, filepath.Join(base, "no-such-home"), false, env()); err != nil || got != real {
		t.Errorf("no home: %q, %v", got, err)
	}
	if got, err := BinFor(fake, marked, false, env("STAM_TEST_REAL_OPENCODE", filepath.Join(base, "none", "opencode"))); err != nil || got == "" {
		t.Errorf("no real binary: %q, %v", got, err)
	}
	if _, err := os.Stat(mark); err == nil {
		t.Error("the sentinel ran")
	}
}

// launchCall is one call the launch stand-in got: its method, path and body.
type launchCall struct {
	method, path string
	body         *jsjson.Object
}

// launchServer is a stand-in for the server's API behind a live server session, so Ensure keeps it: it answers the
// health check, makes sessions (ses_1, ses_2, ...), and records every other call; fail makes the session calls 500.
func launchServer(t *testing.T, home string) (*Server, func() []launchCall, *bool) {
	t.Helper()
	var mu sync.Mutex
	var calls []launchCall
	fail := false
	n := 0
	var s *Server
	s = testServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if want, _ := Password(s.home()); func() bool { _, pw, ok := r.BasicAuth(); return !ok || pw != want }() {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/openapi.json" {
			fmt.Fprint(w, `{}`)
			return
		}
		b, _ := io.ReadAll(r.Body)
		v, _ := jsjson.Parse(b)
		o, _ := v.(*jsjson.Object)
		mu.Lock()
		calls = append(calls, launchCall{r.Method, r.URL.Path, o})
		n++
		id := n
		mu.Unlock()
		if fail {
			w.WriteHeader(500)
			fmt.Fprint(w, `{"name":"UnknownError","data":{"message":"boom"}}`)
			return
		}
		if r.Method == "POST" && r.URL.Path == "/api/session" {
			fmt.Fprintf(w, `{"data": {"id": "ses_%d"}}`, id)
			return
		}
		fmt.Fprint(w, `{"data": {}}`)
	}))
	userHome := filepath.Join(home, "user")
	s.Config = func() Env { return Env{Home: home, UserHome: userHome, Getenv: os.Getenv} }
	s.Bin = filepath.Join(repoRoot(t), "test", "fake-opencode", "opencode")
	s.Tmux = startedTmux(t, func(tc *tmux.Client) {
		if err := tc.NewSession(context.Background(), SessionName, t.TempDir(), nil, []string{"sleep", "infinity"}); err != nil {
			t.Fatal(err)
		}
	})
	return s, func() []launchCall { mu.Lock(); defer mu.Unlock(); return append([]launchCall(nil), calls...) }, &fail
}

func strp(s string) *string { return &s }

// A launch makes the agent's session with its title, folder, model, rules and stam id, and its TUI attaches to the
// server and that session, with only the password in its env; a resume applies the rules to the session it has.
func TestLaunch(t *testing.T) {
	home := t.TempDir()
	s, calls, _ := launchServer(t, home)
	ctx := context.Background()
	pw, err := Password(home)
	if err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()
	a := db.Agent{ID: "aloc1", Name: "oc-dev", Cwd: cwd, Model: strp("openrouter/deepseek/deepseek-v4.1-flash"), PermissionMode: api.AgentPermissionMode("default"),
		SessionID: strp("11111111-2222-4333-8444-555555555555")}
	spec, sid, err := s.Launch(ctx, a, false)
	if err != nil {
		t.Fatal(err)
	}
	if sid != "ses_1" {
		t.Errorf("session %q", sid)
	}
	want := []string{"/bin/sh", "-c", passwordScript, "sh", PasswordFile(home), s.Bin, "--server", s.Base(), "--session", "ses_1"}
	if fmt.Sprintf("%q", spec.Argv) != fmt.Sprintf("%q", want) {
		t.Errorf("argv %q; want %q", spec.Argv, want)
	}
	// The password is in neither the env tmux gets nor the new-session.conf tmux reads: the TUI reads it from its file.
	if len(spec.Env) != 0 {
		t.Errorf("env %v; want none", spec.Env)
	}
	if conf := tmux.SessionConf("aloc1", cwd, spec.Env, spec.Argv); strings.Contains(conf, pw) {
		t.Errorf("new-session.conf holds the password: %s", conf)
	}
	got := calls()
	if len(got) != 1 || got[0].method != "POST" || got[0].path != "/api/session" {
		t.Fatalf("calls %+v", got)
	}
	perms := jsjson.Stringify(jsjson.Value(PermissionsJSON(SessionPermissions("default", cwd, home, filepath.Join(home, "user")))), "")
	body := `{"title":"oc-dev","location":{"directory":"` + cwd + `"},"model":{"providerID":"openrouter","id":"deepseek/deepseek-v4.1-flash"},"permissions":` + perms + `,"metadata":{"stam_agent":"aloc1"}}`
	if b := jsjson.Stringify(got[0].body, ""); b != body {
		t.Errorf("body\n%s\nwant\n%s", b, body)
	}

	// No model is null, as TS sends it.
	a2 := a
	a2.Model = nil
	if _, _, err := s.Launch(ctx, a2, false); err != nil {
		t.Fatal(err)
	}
	if m, _ := calls()[1].body.Get("model"); m != nil {
		t.Errorf("model %v; want null", m)
	}

	// A resume: the rules again, on the session the agent has.
	a.SessionID = strp("ses_kept")
	a.PermissionMode = api.AgentPermissionMode("bypass")
	spec, sid, err = s.Launch(ctx, a, true)
	if err != nil {
		t.Fatal(err)
	}
	c := calls()[2]
	resumed := jsjson.Stringify(jsjson.Value(PermissionsJSON(SessionPermissions("bypass", cwd, home, filepath.Join(home, "user")))), "")
	if sid != "" || c.method != "PATCH" || c.path != "/api/session/ses_kept" || jsjson.Stringify(c.body, "") != `{"permissions":`+resumed+`}` {
		t.Errorf("resume: %q %s %s %s", sid, c.method, c.path, jsjson.Stringify(c.body, ""))
	}
	if spec.Argv[len(spec.Argv)-1] != "ses_kept" {
		t.Errorf("resume argv %q", spec.Argv)
	}
	// A resume of an agent with no session makes one.
	a.SessionID = nil
	if _, sid, err = s.Launch(ctx, a, true); err != nil || sid != "ses_4" || calls()[3].method != "POST" {
		t.Errorf("resume without a session: %q %v %+v", sid, err, calls()[3])
	}
}

// The TUI's command runs bin with the password from its file in its env, and the rest of its words as given; with no
// password file it runs nothing, even when the daemon's env has a password.
func TestTUIArgvReadsThePassword(t *testing.T) {
	home := t.TempDir()
	pw, err := Password(home)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	out := filepath.Join(dir, "out")
	bin := filepath.Join(dir, "tui with space")
	write(t, bin, "#!/bin/sh\nprintf '%s|%s' \"$OPENCODE_SERVER_PASSWORD\" \"$*\" >'"+out+"'\n")
	if err := os.Chmod(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(home string) error {
		argv := tuiArgv(home, bin, "http://127.0.0.1:1", "ses_$1")
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Env = append(os.Environ(), "OPENCODE_SERVER_PASSWORD=from-the-daemon")
		return cmd.Run()
	}
	if err := run(home); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(out); string(b) != pw+"|--server http://127.0.0.1:1 --session ses_$1" {
		t.Errorf("the TUI got %q", b)
	}
	os.Remove(out)
	if err := run(t.TempDir()); err == nil {
		t.Error("no password file: the TUI ran")
	}
	if _, err := os.Stat(out); err == nil {
		t.Error("no password file: bin ran")
	}
	// An empty password runs nothing either: an empty file, or one whose first line is blank.
	for _, text := range []string{"", "\n", " \t\n" + pw + "\n"} {
		h := t.TempDir()
		write(t, PasswordFile(h), text)
		if err := run(h); err == nil {
			t.Errorf("password file %q: the TUI ran", text)
		}
		if _, err := os.Stat(out); err == nil {
			t.Errorf("password file %q: bin ran", text)
			os.Remove(out)
		}
	}
	// Spaces and tabs around the password are dropped, as Password drops them.
	h := t.TempDir()
	write(t, PasswordFile(h), " \t"+pw+"\t \n")
	if err := run(h); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(out); string(b) != pw+"|--server http://127.0.0.1:1 --session ses_$1" {
		t.Errorf("padded password: the TUI got %q", b)
	}
}

// A launch refuses a password file the TUI would read differently from the server, without quoting it, and makes the
// password when there is none.
func TestTUIPassword(t *testing.T) {
	for text, ok := range map[string]bool{
		"abc":         true,
		"abc\n":       true,
		" \tabc \n\n": true,
		"":            false,
		"\n":          false,
		"\nabc":       false,
		"abc\ndef":    false,
		"abc\r\n":     false,
		"a bc":        true,
		"\u00a0abc":   false,
		"abc\u2003\n": false,
	} {
		h := t.TempDir()
		write(t, PasswordFile(h), text)
		err := tuiPassword(h)
		if (err == nil) != ok {
			t.Errorf("%q: %v", text, err)
		}
		if err != nil && strings.Contains(err.Error(), "abc") {
			t.Errorf("%q: the error quotes the file: %v", text, err)
		}
	}
	h := t.TempDir()
	if err := tuiPassword(h); err != nil {
		t.Fatal(err)
	}
	if pw, err := Password(h); err != nil || pw == "" {
		t.Errorf("no password made: %q %v", pw, err)
	}
}

// A failed session call fails the launch with its status alone, and a prompt goes in through the session's queue.
func TestLaunchFailsAndPrompt(t *testing.T) {
	home := t.TempDir()
	s, calls, fail := launchServer(t, home)
	ctx := context.Background()
	a := db.Agent{ID: "aloc1", Name: "oc-dev", Cwd: t.TempDir()}
	*fail = true
	if _, _, err := s.Launch(ctx, a, false); err == nil || err.Error() != "OpenCode POST /api/session: 500 Internal Server Error" {
		t.Errorf("launch: %v", err)
	}
	*fail = false
	if err := s.Prompt(ctx, "ses_9", "hello there"); err != nil {
		t.Fatal(err)
	}
	c := calls()[1]
	if c.method != "POST" || c.path != "/api/session/ses_9/prompt" || jsjson.Stringify(c.body, "") != `{"text":"hello there","delivery":"queue"}` {
		t.Errorf("prompt %+v %s", c, jsjson.Stringify(c.body, ""))
	}
	var ce *CallError
	*fail = true
	if err := s.Prompt(ctx, "ses_9", "x"); !errors.As(err, &ce) || ce.Status != 500 {
		t.Errorf("failed prompt: %v", err)
	}
}

// In a marked test home the real binary is refused before anything is called or started, even with a healthy server
// running: the launch, and the server's start.
func TestLaunchRefusesTheRealBinaryInATestHome(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, TestHomeMarker), "")
	s, calls, _ := launchServer(t, home)
	real, mark := sentinel(t, t.TempDir())
	s.Bin = real
	s.Config = func() Env {
		return Env{Home: home, Getenv: envOf(map[string]string{"PATH": "/usr/bin:/bin", "HOME": home, "STAM_TEST_REAL_OPENCODE": real})}
	}
	ctx := context.Background()
	if _, _, err := s.Launch(ctx, db.Agent{ID: "aloc1", Name: "oc-dev", Cwd: t.TempDir()}, false); err == nil || !strings.Contains(err.Error(), "refusing the real opencode") {
		t.Errorf("launch: %v", err)
	}
	if err := s.Ensure(ctx); err == nil || !strings.Contains(err.Error(), "refusing the real opencode") {
		t.Errorf("ensure: %v", err)
	}
	if len(calls()) != 0 {
		t.Errorf("calls %+v", calls())
	}
	if _, err := os.Stat(mark); err == nil {
		t.Error("the sentinel ran")
	}
}

// In a marked test home the server runs the path BinFor judged, not the name: a bare name the daemon's PATH finds (the
// Getenv PATH) and the session's own PATH doesn't still starts the server.
func TestEnsureRunsTheCheckedPath(t *testing.T) {
	f := newEnsureFixture(t)
	write(t, filepath.Join(f.home, TestHomeMarker), "")
	s := f.newServer()
	bin := s.Bin
	dir := filepath.Join(f.base, "path-only")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(bin, filepath.Join(dir, "oc-name")); err != nil {
		t.Fatal(err)
	}
	cfg := s.Config
	s.Config = func() Env {
		e := cfg()
		e.Getenv = func(k string) string {
			if k == "PATH" {
				return dir + ":" + os.Getenv("PATH")
			}
			return os.Getenv(k)
		}
		return e
	}
	s.Bin = "oc-name"
	if err := s.Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
	if starts(t, f.count) != 1 {
		t.Fatalf("%d starts", starts(t, f.count))
	}
}

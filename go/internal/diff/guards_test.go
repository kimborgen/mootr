package diff

import (
	"context"
	"math"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"stam/internal/config"
	"stam/internal/files"
)

// smallRepo is a checkout at base/name whose origin has PR 7, which writes text to a.txt.
func smallRepo(t *testing.T, base, name, text string) string {
	t.Helper()
	origin, work, checkout := filepath.Join(base, name+"-origin.git"), filepath.Join(base, name+"-work"), filepath.Join(base, name)
	must(t, os.MkdirAll(work, 0o755))
	gitIn(t, base, "init", "-q", "--bare", "-b", "main", origin)
	gitIn(t, work, "init", "-q", "-b", "main")
	write(t, filepath.Join(work, "a.txt"), "base\n")
	write(t, filepath.Join(work, ".env"), "S=1\n")
	gitIn(t, work, "add", "-A")
	gitIn(t, work, "commit", "-q", "-m", "base")
	gitIn(t, work, "remote", "add", "origin", origin)
	gitIn(t, work, "push", "-q", "origin", "main")
	gitIn(t, work, "checkout", "-q", "-b", "pr")
	write(t, filepath.Join(work, "a.txt"), text)
	gitIn(t, work, "commit", "-q", "-am", "pr")
	gitIn(t, work, "push", "-q", "origin", "pr:refs/pull/7/head")
	gitIn(t, base, "clone", "-q", origin, checkout)
	return checkout
}

func service(t *testing.T, settings string, repos map[string]string) *Service {
	t.Helper()
	set, err := config.ParseSettings([]byte(settings), "m")
	must(t, err)
	home := t.TempDir()
	return &Service{Home: home, Settings: func() config.Settings { return set }, Repos: func() map[string]string { return repos },
		Paths: files.Paths{Home: t.TempDir(), StamHome: home}}
}

func headFile(t *testing.T, s *Service, repo string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	if err := s.ServeFile(context.Background(), rec, repo, 7, "a.txt", "head", false, "", ""); err != nil {
		e, _ := AsError(err)
		return e.Status, e.Message
	}
	return rec.Code, rec.Body.String()
}

func alive(pid int) bool {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	// A zombie has exited; only its parent's reaping is left.
	return err == nil && !strings.Contains(string(b), ") Z ")
}

// A fetch whose remote helper hangs, with a child of its own that holds git's pipes, is killed whole at fetchSeconds:
// the request is a 504 at once, the repo's lock is free for the next one, and no process of it is left.
func TestFetchKilledWhole(t *testing.T) {
	base := t.TempDir()
	checkout := smallRepo(t, base, "app", "pr\n")
	bin := filepath.Join(base, "bin")
	pids := filepath.Join(base, "pids")
	write(t, filepath.Join(bin, "git-remote-hang"), "#!/bin/sh\nsleep 60 &\necho $! >>"+pids+"\necho $$ >>"+pids+"\nsleep 60\n")
	must(t, os.Chmod(filepath.Join(bin, "git-remote-hang"), 0o755))
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	gitIn(t, checkout, "remote", "set-url", "origin", "hang::somewhere")
	s := service(t, `{"diff":{"fetchSeconds":1}}`, map[string]string{"app": checkout})

	for round := range 2 {
		done := make(chan error, 1)
		go func() { _, err := s.List(context.Background(), "app", 7); done <- err }()
		var err error
		select {
		case err = <-done:
		case <-time.After(15 * time.Second):
			t.Fatalf("round %d: the fetch still runs, holding the repo's lock", round)
		}
		if e, ok := AsError(err); !ok || e.Status != 504 || e.Message != "fetching PR 7 of app timed out after 1s" {
			t.Fatalf("round %d: %v", round, err)
		}
	}
	b, err := os.ReadFile(pids)
	must(t, err)
	for _, line := range strings.Fields(string(b)) {
		pid, _ := strconv.Atoi(line)
		deadline := time.Now().Add(5 * time.Second)
		for alive(pid) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if alive(pid) {
			syscall.Kill(pid, syscall.SIGKILL)
			t.Errorf("process %d of the fetch is left", pid)
		}
	}
}

// An origin URL with a credential in it is refused before git starts: the token is never on git's command line or in
// the answer.
func TestOriginCredentialsRefused(t *testing.T) {
	base := t.TempDir()
	checkout := smallRepo(t, base, "app", "pr\n")
	real, err := exec.LookPath("git")
	must(t, err)
	bin, argv := filepath.Join(base, "bin"), filepath.Join(base, "argv")
	write(t, filepath.Join(bin, "git"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >>"+argv+"\nexec "+real+" \"$@\"\n")
	must(t, os.Chmod(filepath.Join(bin, "git"), 0o755))
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	s := service(t, `{}`, map[string]string{"app": checkout})
	for _, url := range []string{"https://u:TOKEN@127.0.0.1:1/x", "https://TOKEN@127.0.0.1:1/x", "ssh://u:TOKEN@127.0.0.1:1/x", "u:TOKEN@127.0.0.1:x",
		"https::https://TOKEN@127.0.0.1:1/r", "https::https://u:TOKEN@127.0.0.1:1/r", "ssh://u%3ATOKEN@127.0.0.1:1/x", "u%3aTOKEN@127.0.0.1:x"} {
		gitIn(t, checkout, "remote", "set-url", "origin", url)
		os.Remove(argv)
		_, err := s.List(context.Background(), "app", 7)
		e, ok := AsError(err)
		if !ok || e.Status != 500 || strings.Contains(e.Message, "TOKEN") || !strings.Contains(e.Message, "carries credentials") {
			t.Errorf("%s: %v", url, err)
		}
		if code, body := headFile(t, s, "app"); code != 500 || strings.Contains(body, "TOKEN") {
			t.Errorf("%s: a file: %d %s", url, code, body)
		}
		b, _ := os.ReadFile(argv)
		if strings.Contains(string(b), "TOKEN") {
			t.Errorf("%s: git was run with the token:\n%s", url, b)
		}
	}
	// A user name alone on ssh is no secret: git is asked (and fails to connect).
	gitIn(t, checkout, "remote", "set-url", "origin", "git@127.0.0.1:x")
	if _, err := s.List(context.Background(), "app", 7); err == nil || strings.Contains(err.Error(), "carries credentials") {
		t.Errorf("ssh user: %v", err)
	}
}

func TestRedact(t *testing.T) {
	for in, want := range map[string]string{
		"fatal: unable to access 'https://u:TOKEN@host/x/': refused": "fatal: unable to access 'https://host/x/': refused",
		"from HTTPS://TOKEN@h/x and ssh://git@h/y":                   "from HTTPS://h/x and ssh://h/y",
		"no url here, a@b": "no url here, a@b",
	} {
		if got := redact(in); got != want {
			t.Errorf("redact(%q) = %q", in, got)
		}
	}
	for url, want := range map[string]bool{
		"https://github.com/o/r": false, "git@github.com:o/r.git": false, "ssh://git@github.com/o/r": false, "/srv/r.git": false,
		"https://x-access-token:T@github.com/o/r": true, "http://T@h/r": true, "git://u:p@h/r": true, "u:p@h:r": true,
		"https::https://T@h/r": true, "ext::ssh://u:p@h/r": true, "hang::somewhere": false, "ssh://u%3AT@h/r": true, "ssh://u%zz@h/r": true,
	} {
		if credentialed(url) != want {
			t.Errorf("credentialed(%q) is %v", url, !want)
		}
	}
}

// Two repos whose names read alike on disk (team/app and team_app) keep caches, locks and fetch times of their own: each
// is served its own PR, also when the other's was fetched in between.
func TestCacheNamesCollide(t *testing.T) {
	base := t.TempDir()
	a, b := smallRepo(t, base, "a", "from a\n"), smallRepo(t, base, "b", "from b\n")
	s := service(t, `{}`, map[string]string{"team/app": a, "team_app": b})
	for _, c := range []struct{ repo, want string }{{"team/app", "from a\n"}, {"team_app", "from b\n"}, {"team/app", "from a\n"}, {"team_app", "from b\n"}} {
		if code, body := headFile(t, s, c.repo); code != 200 || body != c.want {
			t.Errorf("%s: %d %q", c.repo, code, body)
		}
	}
	if s.CacheDir("team/app", a) == s.CacheDir("team_app", b) {
		t.Error("one cache folder for both")
	}
}

// A cache a crash left half made, a temporary build folder, and a ref lock a killed fetch left all heal on the next
// request.
func TestCacheRecovers(t *testing.T) {
	base := t.TempDir()
	checkout := smallRepo(t, base, "app", "pr\n")
	s := service(t, `{"diff":{"refreshSeconds":0}}`, map[string]string{"app": checkout})
	dir := s.CacheDir("app", checkout)
	write(t, filepath.Join(dir, "HEAD"), "junk\n")
	leftover := dir + ".tmp-123"
	write(t, filepath.Join(leftover, "HEAD"), "ref: refs/heads/main\n")
	if code, body := headFile(t, s, "app"); code != 200 || body != "pr\n" {
		t.Fatalf("over a half-made cache: %d %q", code, body)
	}
	if exists(leftover) {
		t.Error("the old build folder is left")
	}
	// The PR moves on, so the next fetch must write its ref.
	work := filepath.Join(base, "app-work")
	write(t, filepath.Join(work, "a.txt"), "pr 2\n")
	gitIn(t, work, "commit", "-q", "-am", "pr 2")
	gitIn(t, work, "push", "-q", "-f", "origin", "pr:refs/pull/7/head")
	write(t, filepath.Join(dir, "refs", "stam-diff", "pr", "7.lock"), "")
	write(t, filepath.Join(dir, "packed-refs.lock"), "")
	if code, body := headFile(t, s, "app"); code != 200 || body != "pr 2\n" {
		t.Fatalf("over a killed fetch's locks: %d %q", code, body)
	}
}

// A denied file the PR doesn't touch is refused by its path alone: it isn't in the list.
func TestDeniedUnchanged(t *testing.T) {
	base := t.TempDir()
	s := service(t, `{}`, map[string]string{"app": smallRepo(t, base, "app", "pr\n")})
	for _, side := range []string{"head", "base"} {
		rec := httptest.NewRecorder()
		err := s.ServeFile(context.Background(), rec, "app", 7, ".env", side, false, "", "")
		if e, ok := AsError(err); !ok || e.Status != 403 || strings.Contains(rec.Body.String(), "S=") {
			t.Errorf("%s: %v %q", side, err, rec.Body)
		}
	}
}

// A huge fetchSeconds or refreshSeconds is clamped, not overflowed into a negative.
func TestSecondsClamped(t *testing.T) {
	for in, want := range map[float64]time.Duration{0: 0, -1: 0, math.NaN(): 0, 1.5: 1500 * time.Millisecond, 1e300: math.MaxInt64, math.Inf(1): math.MaxInt64, 9.3e9: math.MaxInt64} {
		if got := seconds(in); got != want {
			t.Errorf("seconds(%v) = %v", in, got)
		}
	}
	base := t.TempDir()
	checkout := smallRepo(t, base, "app", "pr\n")
	s := service(t, `{"diff":{"fetchSeconds":1e300,"refreshSeconds":1e300}}`, map[string]string{"app": checkout})
	for range 2 {
		if code, body := headFile(t, s, "app"); code != 200 || body != "pr\n" {
			t.Fatalf("%d %q", code, body)
		}
	}
}

// pinnedServe is ServeFile with the head and base the web view pins.
func pinnedServe(t *testing.T, s *Service, pr int, path, side, head, base string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	if err := s.ServeFile(context.Background(), rec, "app", pr, path, side, false, head, base); err != nil {
		e, ok := AsError(err)
		if !ok {
			t.Fatalf("not a refusal: %v", err)
		}
		return e.Status, e.Message
	}
	return rec.Code, rec.Body.String()
}

// The deny check is judged over the PR's own range, never one the client picks: with head = base, or a merged PR's head
// pinned, a renamed credential stays closed. A head the PR was fetched at before a force push is still served; another
// PR's head is not this PR's.
func TestPinnedRange(t *testing.T) {
	base := t.TempDir()
	origin, work, checkout := filepath.Join(base, "origin.git"), filepath.Join(base, "work"), filepath.Join(base, "checkout")
	must(t, os.MkdirAll(work, 0o755))
	gitIn(t, base, "init", "-q", "--bare", "-b", "main", origin)
	gitIn(t, work, "init", "-q", "-b", "main")
	write(t, filepath.Join(work, "a.txt"), "base\n")
	write(t, filepath.Join(work, "secret.pem"), strings.Repeat("-----KEY-----\n", 10))
	gitIn(t, work, "add", "-A")
	gitIn(t, work, "commit", "-q", "-m", "base")
	gitIn(t, work, "remote", "add", "origin", origin)
	gitIn(t, work, "push", "-q", "origin", "main")
	gitIn(t, work, "checkout", "-q", "-b", "pr")
	gitIn(t, work, "mv", "secret.pem", "cert.txt")
	write(t, filepath.Join(work, "a.txt"), "pr\n")
	gitIn(t, work, "commit", "-q", "-am", "pr")
	gitIn(t, work, "push", "-q", "origin", "pr:refs/pull/7/head")
	gitIn(t, work, "checkout", "-q", "main")
	gitIn(t, work, "merge", "-q", "--no-ff", "-m", "merge", "pr")
	gitIn(t, work, "push", "-q", "origin", "main")
	gitIn(t, work, "checkout", "-q", "-b", "other", "main~1")
	write(t, filepath.Join(work, "b.txt"), "other\n")
	gitIn(t, work, "add", "-A")
	gitIn(t, work, "commit", "-q", "-m", "other")
	gitIn(t, work, "push", "-q", "origin", "other:refs/pull/9/head")
	gitIn(t, base, "clone", "-q", origin, checkout)
	s := service(t, `{"diff":{"refreshSeconds":0}}`, map[string]string{"app": checkout})
	ctx := context.Background()
	l7, err := s.List(ctx, "app", 7)
	must(t, err)
	l9, err := s.List(ctx, "app", 9)
	must(t, err)
	pr7, main := l7.Head, l7.Base
	for _, c := range []struct{ head, base string }{{"", ""}, {pr7, main}, {pr7, pr7}, {main, main}} {
		if code, body := pinnedServe(t, s, 7, "cert.txt", "head", c.head, c.base); code == 200 || strings.Contains(body, "KEY") {
			t.Errorf("cert.txt at head %.7s, base %.7s: %d %.60q", c.head, c.base, code, body)
		}
	}
	if code, body := pinnedServe(t, s, 7, "cert.txt", "head", pr7, main); code != 403 {
		t.Errorf("cert.txt pinned to the PR: %d %s", code, body)
	}
	if code, body := pinnedServe(t, s, 7, "a.txt", "head", pr7, main); code != 200 || body != "pr\n" {
		t.Errorf("a.txt pinned to the PR: %d %q", code, body)
	}
	// Another PR's head isn't PR 7's.
	if code, body := pinnedServe(t, s, 7, "b.txt", "head", l9.Head, main); code != 404 {
		t.Errorf("PR 9's head under PR 7: %d %q", code, body)
	}
	// A force push: the head the viewer pinned is gone from the PR, and still served.
	gitIn(t, work, "checkout", "-q", "other")
	write(t, filepath.Join(work, "b.txt"), "pushed again\n")
	gitIn(t, work, "commit", "-q", "--amend", "-am", "other 2")
	gitIn(t, work, "push", "-q", "-f", "origin", "other:refs/pull/9/head")
	if code, body := pinnedServe(t, s, 9, "b.txt", "head", "", ""); code != 200 || body != "pushed again\n" {
		t.Fatalf("the new head: %d %q", code, body)
	}
	if code, body := pinnedServe(t, s, 9, "b.txt", "head", l9.Head, l9.Base); code != 200 || body != "other\n" {
		t.Errorf("the old head pinned: %d %q", code, body)
	}
}

// A client picks no range of its own: the head and base it pins must be a pair this daemon listed for the PR. Two
// histories where independent ancestry checks let a chosen base move the merge base so that the secret, renamed
// cert.txt, lists as a plain change with no old path.
func TestPinnedRangeChosen(t *testing.T) {
	setup := func(t *testing.T) (origin, work, checkout string) {
		base := t.TempDir()
		origin, work, checkout = filepath.Join(base, "origin.git"), filepath.Join(base, "work"), filepath.Join(base, "checkout")
		must(t, os.MkdirAll(work, 0o755))
		gitIn(t, base, "init", "-q", "--bare", "-b", "main", origin)
		gitIn(t, work, "init", "-q", "-b", "main")
		gitIn(t, work, "remote", "add", "origin", origin)
		write(t, filepath.Join(work, "a.txt"), "base\n")
		gitIn(t, work, "add", "-A")
		gitIn(t, work, "commit", "-q", "-m", "m0")
		return origin, work, checkout
	}
	secret := strings.Repeat("-----KEY-----\n", 10)
	check := func(t *testing.T, s *Service, head, base string) {
		t.Helper()
		l, err := s.List(context.Background(), "app", 7)
		must(t, err)
		for _, side := range []string{"head", "base"} {
			if code, body := pinnedServe(t, s, 7, "cert.txt", side, head, base); code == 200 || strings.Contains(body, "KEY") {
				t.Errorf("cert.txt at the %s, head %.7s base %.7s: %d %.60q", side, head, base, code, body)
			}
		}
		// The pair the list gave is still served, for a file the PR may show.
		if code, body := pinnedServe(t, s, 7, "a.txt", "head", l.Head, l.Base); code != 200 || body != "pr\n" {
			t.Errorf("a.txt pinned to the listed pair: %d %q", code, body)
		}
	}
	t.Run("after a merged rename", func(t *testing.T) {
		origin, work, checkout := setup(t)
		write(t, filepath.Join(work, "secret.pem"), secret)
		gitIn(t, work, "add", "-A")
		gitIn(t, work, "commit", "-q", "-m", "a")
		gitIn(t, work, "checkout", "-q", "-b", "pr")
		gitIn(t, work, "mv", "secret.pem", "cert.txt")
		gitIn(t, work, "commit", "-q", "-m", "r")
		r := gitIn(t, work, "rev-parse", "HEAD")
		write(t, filepath.Join(work, "cert.txt"), secret+"edited\n")
		write(t, filepath.Join(work, "a.txt"), "pr\n")
		gitIn(t, work, "commit", "-q", "-am", "h")
		h := gitIn(t, work, "rev-parse", "HEAD")
		gitIn(t, work, "push", "-q", "origin", "pr:refs/pull/7/head")
		gitIn(t, work, "checkout", "-q", "main")
		gitIn(t, work, "merge", "-q", "--no-ff", "-m", "merge", "pr")
		write(t, filepath.Join(work, "b.txt"), "later\n")
		gitIn(t, work, "add", "-A")
		gitIn(t, work, "commit", "-q", "-m", "m")
		gitIn(t, work, "push", "-q", "origin", "main")
		gitIn(t, filepath.Dir(origin), "clone", "-q", origin, checkout)
		check(t, service(t, `{"diff":{"refreshSeconds":0}}`, map[string]string{"app": checkout}), h, r)
	})
	t.Run("before the secret existed", func(t *testing.T) {
		origin, work, checkout := setup(t)
		m0 := gitIn(t, work, "rev-parse", "HEAD")
		write(t, filepath.Join(work, "secret.pem"), secret)
		gitIn(t, work, "add", "-A")
		gitIn(t, work, "commit", "-q", "-m", "m1")
		gitIn(t, work, "push", "-q", "origin", "main")
		gitIn(t, work, "checkout", "-q", "-b", "pr")
		gitIn(t, work, "mv", "secret.pem", "cert.txt")
		write(t, filepath.Join(work, "a.txt"), "pr\n")
		gitIn(t, work, "commit", "-q", "-am", "h")
		h := gitIn(t, work, "rev-parse", "HEAD")
		gitIn(t, work, "push", "-q", "origin", "pr:refs/pull/7/head")
		gitIn(t, filepath.Dir(origin), "clone", "-q", origin, checkout)
		check(t, service(t, `{"diff":{"refreshSeconds":0}}`, map[string]string{"app": checkout}), h, m0)
	})
}

// A validation cut short, by a request that went or a git that can't run, never wipes a healthy cache.
func TestCacheKeptOnCancel(t *testing.T) {
	base := t.TempDir()
	checkout := smallRepo(t, base, "app", "pr\n")
	s := service(t, `{"diff":{"refreshSeconds":0}}`, map[string]string{"app": checkout})
	if code, body := headFile(t, s, "app"); code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	dir := s.CacheDir("app", checkout)
	ctx, cancel := context.WithCancel(context.Background())
	checking = cancel
	defer func() { checking = nil }()
	if _, err := s.List(ctx, "app", 7); err == nil {
		t.Fatal("a cancelled list answered")
	}
	checking = nil
	if !exists(filepath.Join(dir, "HEAD")) {
		t.Fatal("the cache was wiped")
	}
	t.Setenv("PATH", t.TempDir())
	if _, err := s.List(context.Background(), "app", 7); err == nil {
		t.Fatal("a list with no git answered")
	}
	t.Setenv("PATH", os.Getenv("PATH"))
	if !exists(filepath.Join(dir, "HEAD")) {
		t.Fatal("the cache was wiped without git")
	}
}

// Two daemons on one STAM_HOME share the cache: one's recovery and fetch hold the cache's lock file, so the other's
// cleanup can't run under them.
func TestCacheSharedByDaemons(t *testing.T) {
	base := t.TempDir()
	checkout := smallRepo(t, base, "app", "pr\n")
	a := service(t, `{"diff":{"refreshSeconds":0}}`, map[string]string{"app": checkout})
	b := &Service{Home: a.Home, Settings: a.Settings, Repos: a.Repos, Paths: a.Paths}
	lockFile := a.CacheDir("app", checkout) + ".lock"
	var other chan error
	inFetch = func(string) {
		if other != nil {
			return
		}
		other = make(chan error, 1)
		if f, err := os.Open(lockFile); err != nil {
			t.Errorf("no lock file: %v", err)
		} else {
			defer f.Close()
			if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err == nil {
				t.Error("the cache's lock isn't held during a fetch")
				unix.Flock(int(f.Fd()), unix.LOCK_UN)
			}
		}
		go func() { _, err := b.List(context.Background(), "app", 7); other <- err }()
	}
	defer func() { inFetch = nil }()
	if _, err := a.List(context.Background(), "app", 7); err != nil {
		t.Fatal(err)
	}
	if other == nil {
		t.Fatal("the fetch seam never ran")
	}
	if err := <-other; err != nil {
		t.Fatalf("the other daemon: %v", err)
	}
}

// A git that exits on its own, leaving a child that holds its pipes, doesn't leave the child behind.
func TestGitChildReaped(t *testing.T) {
	base := t.TempDir()
	checkout := smallRepo(t, base, "app", "pr\n")
	bin, pids := filepath.Join(base, "bin"), filepath.Join(base, "pids")
	write(t, filepath.Join(bin, "git-remote-quit"), "#!/bin/sh\nsleep 60 </dev/null >/dev/null &\necho $! >>"+pids+"\nexit 1\n")
	must(t, os.Chmod(filepath.Join(bin, "git-remote-quit"), 0o755))
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	gitIn(t, checkout, "remote", "set-url", "origin", "quit::somewhere")
	s := service(t, `{}`, map[string]string{"app": checkout})
	if _, err := s.List(context.Background(), "app", 7); err == nil {
		t.Fatal("the fetch passed")
	}
	b, err := os.ReadFile(pids)
	must(t, err)
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	deadline := time.Now().Add(5 * time.Second)
	for alive(pid) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if alive(pid) {
		syscall.Kill(pid, syscall.SIGKILL)
		t.Errorf("git's child %d is left", pid)
	}
}

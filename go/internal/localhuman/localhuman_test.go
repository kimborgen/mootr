package localhuman

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"stam/internal/config"
)

const secret = "AAAAAAAAAAAAAAAAAAAAAA"

// TestNameOf: the name is what the page and the e2e tests compute (base32 of SHA-256's first 128 bits, lower case, no
// padding).
func TestNameOf(t *testing.T) {
	if got := NameOf(secret); got != "rjn5wtgbkfsbe3do6jti32o5eq" {
		t.Fatalf("NameOf = %q", got)
	}
}

// codes is a login whose code folder is a test's, with this user standing in for root (as e2e-local-human.sh does).
func codes(t *testing.T, started time.Time) (*Login, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "codes")
	l := New(config.Config{TestHumanCodeDir: dir, TestHumanCodeRootUID: strconv.Itoa(os.Getuid())}, started)
	return l, dir
}

// mint is the page's command: the folders 755 and an empty file 644, named for the secret.
func mint(t *testing.T, l *Login, s string) string {
	t.Helper()
	if err := os.MkdirAll(l.UserDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{filepath.Dir(l.UserDir()), l.UserDir()} {
		if err := os.Chmod(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	p := filepath.Join(l.UserDir(), NameOf(s))
	if err := os.WriteFile(p, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestRedeem: a code is good once, made by root in root's folders since the daemon started and in the last 5 minutes;
// anything else is refused with TS's reason.
func TestRedeem(t *testing.T) {
	start := time.Now().Add(-time.Minute)
	none := "no such code yet: run the command above first"
	t.Run("not a secret", func(t *testing.T) {
		l, _ := codes(t, start)
		for _, s := range []any{nil, 42, "short", secret + "A", "AAAAAAAAAAAAAAAAAAAAA="} {
			if got := l.Redeem(s, time.Now()); got != "not a login secret" {
				t.Errorf("%v: %q", s, got)
			}
		}
	})
	t.Run("no folder, no file", func(t *testing.T) {
		l, _ := codes(t, start)
		if got := l.Redeem(secret, time.Now()); got != none {
			t.Errorf("no folder: %q", got)
		}
		mint(t, l, "BBBBBBBBBBBBBBBBBBBBBB")
		if got := l.Redeem(secret, time.Now()); got != none {
			t.Errorf("no file: %q", got)
		}
	})
	t.Run("the name alone", func(t *testing.T) {
		l, _ := codes(t, start)
		mint(t, l, secret)
		if got := l.Redeem(NameOf(secret), time.Now()); got != "not a login secret" {
			t.Errorf("%q", got)
		}
	})
	t.Run("a folder others can write", func(t *testing.T) {
		l, dir := codes(t, start)
		mint(t, l, secret)
		must(t, os.Chmod(dir, 0o777))
		if got := l.Redeem(secret, time.Now()); got != dir+" isn't a folder that only root can write" {
			t.Errorf("%q", got)
		}
		must(t, os.Chmod(dir, 0o755))
		must(t, os.Chmod(l.UserDir(), 0o775))
		if got := l.Redeem(secret, time.Now()); got != l.UserDir()+" isn't a folder that only root can write" {
			t.Errorf("%q", got)
		}
	})
	t.Run("not root's", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "codes")
		l := New(config.Config{TestHumanCodeDir: dir, TestHumanCodeRootUID: strconv.Itoa(os.Getuid() + 1)}, start)
		mint(t, l, secret)
		if got := l.Redeem(secret, time.Now()); got != dir+" isn't a folder that only root can write" {
			t.Errorf("%q", got)
		}
	})
	t.Run("a file others can write", func(t *testing.T) {
		l, _ := codes(t, start)
		must(t, os.Chmod(mint(t, l, secret), 0o666))
		if got := l.Redeem(secret, time.Now()); got != "that code's file isn't root's" {
			t.Errorf("%q", got)
		}
	})
	t.Run("a folder, not a file", func(t *testing.T) {
		l, _ := codes(t, start)
		p := mint(t, l, secret)
		must(t, os.Remove(p))
		must(t, os.Mkdir(p, 0o755))
		if got := l.Redeem(secret, time.Now()); got != "that code's file isn't root's" {
			t.Errorf("%q", got)
		}
	})
	t.Run("a symlink to root's file", func(t *testing.T) {
		l, _ := codes(t, start)
		other := mint(t, l, "BBBBBBBBBBBBBBBBBBBBBB")
		must(t, os.Symlink(other, filepath.Join(l.UserDir(), NameOf(secret))))
		if got := l.Redeem(secret, time.Now()); got != none {
			t.Errorf("%q", got)
		}
	})
	t.Run("a symlinked folder", func(t *testing.T) {
		l, dir := codes(t, start)
		mint(t, l, secret)
		real := dir + "-real"
		must(t, os.Rename(dir, real))
		must(t, os.Symlink(real, dir))
		if got := l.Redeem(secret, time.Now()); got != dir+" isn't a folder that only root can write" {
			t.Errorf("%q", got)
		}
	})
	t.Run("made before the daemon started", func(t *testing.T) {
		l, _ := codes(t, time.Now().Add(time.Hour))
		mint(t, l, secret)
		if got := l.Redeem(secret, time.Now()); got != "that code was made before stam started; reload the page for a new one" {
			t.Errorf("%q", got)
		}
	})
	t.Run("expired", func(t *testing.T) {
		l, _ := codes(t, start)
		mint(t, l, secret)
		if got := l.Redeem(secret, time.Now().Add(CodeTTL+time.Second)); got != "that code has expired; reload the page for a new one" {
			t.Errorf("%q", got)
		}
	})
	t.Run("good once", func(t *testing.T) {
		l, _ := codes(t, start)
		mint(t, l, secret)
		if got := l.Redeem(secret, time.Now()); got != "" {
			t.Fatalf("a good code: %q", got)
		}
		if got := l.Redeem(secret, time.Now()); got != "that login was already used; reload the page for a new code" {
			t.Errorf("reused: %q", got)
		}
	})
}

// TestSessions: a session lasts 12 hours, is kept only as its token's hash, and ends on logout or EndAll; a login
// whose generation EndAll moved on starts none.
func TestSessions(t *testing.T) {
	l, _ := codes(t, time.Now())
	now := time.Now()
	tok, exp, ok := l.Start(now, l.Gen())
	if !ok || len(tok) != 43 || exp != now.Add(SessionTTL).UnixMilli() {
		t.Fatalf("token %d chars, expires %d", len(tok), exp)
	}
	for h := range l.sessions {
		if h == tok {
			t.Fatal("the token is kept as it is")
		}
	}
	if !l.Live(tok, now) || l.Live("", now) || l.Live(tok+"x", now) {
		t.Fatal("Live")
	}
	if l.Live(tok, now.Add(SessionTTL)) || l.Live(tok, now) {
		t.Fatal("an expired session lives, or comes back")
	}
	tok, _, _ = l.Start(now, l.Gen())
	if !l.End(tok) || l.End(tok) || l.Live(tok, now) {
		t.Fatal("End")
	}
	gen := l.Gen()
	tok, _, _ = l.Start(now, gen)
	l.EndAll()
	if l.Live(tok, now) {
		t.Fatal("EndAll")
	}
	if tok, _, ok := l.Start(now, gen); ok || tok != "" || len(l.sessions) != 0 {
		t.Fatal("a login from before EndAll started a session")
	}
	if _, _, ok := l.Start(now, l.Gen()); !ok {
		t.Fatal("a login after EndAll started none")
	}
}

// TestSessionToken: a Bearer, or ?token= only on a mail attachment's GET.
func TestSessionToken(t *testing.T) {
	for _, c := range []struct{ method, path, query, auth, want string }{
		{"GET", "/api/voice", "", "Bearer s1", "s1"},
		{"GET", "/api/voice", "token=s2", "", ""},
		{"GET", "/api/mail/m1/attachments/a.mp3", "token=s3", "", "s3"},
		{"POST", "/api/mail/m1/attachments/a.mp3", "token=s4", "", ""},
		{"GET", "/api/shells/sh-1/tty", "token=s5", "", ""},
		{"GET", "/api/voice", "", "Basic s6", ""},
	} {
		if got := SessionToken(c.method, c.path, c.query, c.auth); got != c.want {
			t.Errorf("%+v: %q", c, got)
		}
	}
}

// TestDirect: a browser on this machine is a loopback connection whose socket this user (not root) owns; a peer's
// relay or a forwarded agent never is.
func TestDirect(t *testing.T) {
	var direct bool
	var uid int
	var found bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		direct = Direct(r)
		uid, found = SocketUID(r)
	}))
	defer ts.Close()
	get := func(h map[string]string) {
		t.Helper()
		req, _ := http.NewRequest("GET", ts.URL, nil)
		for k, v := range h {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		must(t, err)
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}
	get(nil)
	if !found || uid != os.Getuid() || !direct {
		t.Fatalf("socket uid %d (found %v), direct %v", uid, found, direct)
	}
	for _, h := range []string{"X-Stam-Local", "X-Stam-Agent"} {
		get(map[string]string{h: "1"})
		if direct {
			t.Errorf("%s is direct", h)
		}
	}
	// A request with no connection of its own (a recorder) has no socket to read.
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:1"
	if Direct(r) {
		t.Error("a request with no socket is direct")
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// TestSocketUIDTable: the client's own socket is found by its ports (local the client's, remote the daemon's), in
// tcp or tcp6, and a root-owned one (tailscale serve) is never a direct connection.
func TestSocketUIDTable(t *testing.T) {
	dir := t.TempDir()
	tcp, tcp6 := filepath.Join(dir, "tcp"), filepath.Join(dir, "tcp6")
	old := procNetTCP
	procNetTCP = []string{tcp, tcp6}
	t.Cleanup(func() { procNetTCP = old })
	head := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
	row := func(local, remote, uid string) string {
		return "   0: " + local + " " + remote + " 01 00000000:00000000 00:00000000 00000000  " + uid + "        0 1 1\n"
	}
	write := func(p string, rows ...string) { must(t, os.WriteFile(p, []byte(head+strings.Join(rows, "")), 0o600)) }
	// 40000 is 9C40, 7878 is 1EC6; 127.0.0.1 is 0100007F, 127.0.0.2 0200007F.
	const client, daemon = "0100007F:9C40", "0100007F:1EC6"
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:40000"
	r = r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 7878}))

	me := strconv.Itoa(os.Getuid())
	if me == "0" {
		t.Skip("run as root: no non-root uid of the daemon's own")
	}
	// A root forwarder's socket (tailscale serve), after a socket of this user's with the same ports on other addresses
	// and the daemon's own end (the reverse pair).
	write(tcp, row("0200007F:9C40", daemon, me), row(daemon, client, "4242"), row(client, daemon, "0"))
	write(tcp6)
	if uid, ok := SocketUID(r); !ok || uid != 0 {
		t.Fatalf("uid %d, %v", uid, ok)
	}
	if Direct(r) {
		t.Error("a root-owned socket is direct")
	}
	write(tcp, row("0200007F:9C40", daemon, "0"), row(client, daemon, me))
	if !Direct(r) {
		t.Error("this user's socket isn't direct")
	}
	// A closed connection's row with the same tuple (TIME_WAIT, 06, listed as root's) is no second owner.
	write(tcp, strings.Replace(row(client, daemon, "0"), " 01 ", " 06 ", 1), row(client, daemon, me))
	if !Direct(r) {
		t.Error("a TIME_WAIT row with the same tuple hid this user's socket")
	}
	// Another non-root user's socket isn't this daemon's human.
	other := strconv.Itoa(os.Getuid() + 1)
	write(tcp, row(client, daemon, other))
	if uid, ok := SocketUID(r); !ok || uid != os.Getuid()+1 || Direct(r) {
		t.Errorf("another user's socket: uid %d, %v, direct %v", uid, ok, Direct(r))
	}
	// On an IPv6 socket an IPv4 connection is listed v4-mapped.
	const mapped = "0000000000000000FFFF0000"
	write(tcp)
	write(tcp6, row(mapped+client, mapped+daemon, me))
	if !Direct(r) {
		t.Error("a v4-mapped row isn't read")
	}
	// Listed twice, or not at all: no owner.
	write(tcp, row(client, daemon, me))
	if _, ok := SocketUID(r); ok {
		t.Error("two rows gave an owner")
	}
	write(tcp)
	write(tcp6)
	if _, ok := SocketUID(r); ok {
		t.Error("no row gave an owner")
	}
	// IPv6 loopback, in the IPv6 table only.
	const one = "00000000000000000000000001000000"
	write(tcp, row(client, daemon, me))
	write(tcp6, row(one+":9C40", one+":1EC6", me))
	r6 := httptest.NewRequest("GET", "/", nil)
	r6.RemoteAddr = "[::1]:40000"
	r6 = r6.WithContext(context.WithValue(r6.Context(), http.LocalAddrContextKey, &net.TCPAddr{IP: net.IPv6loopback, Port: 7878}))
	if uid, ok := SocketUID(r6); !ok || uid != os.Getuid() || !Direct(r6) {
		t.Errorf("::1: uid %d, %v", uid, ok)
	}
	r.RemoteAddr = "10.0.0.2:40000"
	if Direct(r) {
		t.Error("a connection from another machine is direct")
	}
}

// TestKernelNow: a file made right after KernelNow is never stamped before it (time.Now can be a tick ahead of a
// file's ctime).
func TestKernelNow(t *testing.T) {
	dir := t.TempDir()
	// Every file is made before any is read back: a read of a ctime moves the kernel to finer stamps for a while.
	starts := make([]time.Time, 200)
	for i := range starts {
		starts[i] = KernelNow()
		must(t, os.WriteFile(filepath.Join(dir, strconv.Itoa(i)), nil, 0o600))
	}
	for i, start := range starts {
		info, err := os.Stat(filepath.Join(dir, strconv.Itoa(i)))
		must(t, err)
		if ctime := statCtime(info.Sys().(*syscall.Stat_t)); ctime.Before(start) {
			t.Fatalf("a file made after the start is stamped %v before it", start.Sub(ctime))
		}
	}
}

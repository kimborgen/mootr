// Package localhuman is src/local-human.ts, the local human login (S-613): on one machine without Tailscale, the human
// proves who they are with a one-time secret that only their browser holds, vouched for by root. The login page draws a
// random 128-bit secret S, keeps it in memory, and shows N = NameOf(S) in the command to run:
// `sudo /usr/bin/install -d -m 755 /run/stam-human /run/stam-human/<uid> && sudo /usr/bin/install -m 644 /dev/null
// /run/stam-human/<uid>/N`. Only coreutils runs as root, never stam's code, which the human's user (and so any agent)
// can edit. The page then posts S to POST /api/human/login on 127.0.0.1: a root-owned empty file at <uid>/NameOf(S), in
// root-owned folders, created within the last 5 minutes and since the daemon started, and not used before, buys one
// session.
//
// Agents run as the human's Unix user: they can read the terminal and N, but can't make a root-owned file without
// root, nor find S from N. A session token lives only in this process's memory (as its hash) and in the page's
// localStorage; it expires after 12 hours or on restart. Linux only for now; elsewhere it fails closed.
package localhuman

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"stam/internal/config"
)

const (
	// CodeTTL is how long after root made it a code is good.
	CodeTTL = 5 * time.Minute
	// SessionTTL is how long a session lasts.
	SessionTTL = 12 * time.Hour
	// LinuxOnly is the refusal elsewhere.
	LinuxOnly = "local login works only on Linux for now"
)

var (
	secretRe = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
	digits   = regexp.MustCompile(`^\d+$`)
)

// Login holds the codes used and the sessions started since this daemon did.
type Login struct {
	dir     string
	rootUID uint32
	// sudoAnswer is the test's answer to whether sudo is passwordless ("1" or "0"), empty to ask sudo.
	sudoAnswer string
	// started is when this daemon started: a code made before it was for an earlier daemon, whose uses are forgotten.
	started time.Time

	mu       sync.Mutex
	used     map[string]bool
	sessions map[string]time.Time
	// gen is the enabled generation: EndAll moves it on, so a login whose code was redeemed before the setting went off
	// starts no session after.
	gen uint64

	sudoOnce sync.Once
	sudo     bool
}

// New is the login of a daemon started at started. Tests point the folder elsewhere and name the uid that stands in
// for root, in a marked test home only (config.Load reads them there alone).
func New(cfg config.Config, started time.Time) *Login {
	l := &Login{dir: "/run/stam-human", sudoAnswer: cfg.TestPasswordlessSudo, started: started,
		used: map[string]bool{}, sessions: map[string]time.Time{}}
	if cfg.TestHumanCodeDir != "" {
		l.dir = cfg.TestHumanCodeDir
	}
	if n, err := strconv.ParseUint(cfg.TestHumanCodeRootUID, 10, 32); err == nil && digits.MatchString(cfg.TestHumanCodeRootUID) {
		l.rootUID = uint32(n)
	}
	return l
}

// UserDir is this user's folder of codes, which the page names in its command.
func (l *Login) UserDir() string { return filepath.Join(l.dir, strconv.Itoa(os.Getuid())) }

func sha(s string) [sha256.Size]byte { return sha256.Sum256([]byte(s)) }

// NameOf is the name a secret is vouched for under: the first 128 bits of its SHA-256, in RFC 4648 base32, lower case
// with no padding (26 characters). The web page computes the same (web/src/local-login.tsx).
func NameOf(secret string) string {
	sum := sha(secret)
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:16]))
}

// rootOwned is owned by root and writable by nobody else.
func (l *Login) rootOwned(st *syscall.Stat_t) bool { return st.Uid == l.rootUID && st.Mode&0o022 == 0 }

// Redeem is src/local-human.ts redeemCode: whether root vouched for secret, for this daemon's user. Each is good once:
// its name is kept as used, since the daemon can't remove a root-owned file. The file's contents are never read. It
// returns "" when good, else why not.
func (l *Login) Redeem(secret any, now time.Time) string {
	if runtime.GOOS != "linux" {
		return LinuxOnly
	}
	s, ok := secret.(string)
	if !ok || !secretRe.MatchString(s) {
		return "not a login secret"
	}
	name := NameOf(s)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.used[name] {
		return "that login was already used; reload the page for a new code"
	}
	unreadable := func(dir string) string {
		return "stam can't read " + dir + ": run the command again (it sets the folders to 755)"
	}
	const none = "no such code yet: run the command above first"
	for _, dir := range []string{l.dir, l.UserDir()} {
		info, err := os.Lstat(dir)
		if err != nil {
			if errors.Is(err, fs.ErrPermission) {
				return unreadable(filepath.Dir(dir))
			}
			return none
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !info.IsDir() || !ok || !l.rootOwned(st) {
			return dir + " isn't a folder that only root can write"
		}
	}
	// O_NOFOLLOW: a symlink to a root-owned file elsewhere is no code.
	fd, err := syscall.Open(filepath.Join(l.UserDir(), name), syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return unreadable(l.UserDir())
		}
		return none
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return none
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || !l.rootOwned(&st) {
		return "that code's file isn't root's"
	}
	ctime := statCtime(&st)
	if ctime.Before(l.started) {
		return "that code was made before stam started; reload the page for a new one"
	}
	if now.Sub(ctime) > CodeTTL {
		return "that code has expired; reload the page for a new one"
	}
	l.used[name] = true
	return ""
}

// PasswordlessSudo is whether this user has passwordless sudo (S-2121): there an agent is root, and this login keeps no
// agent out, so the page warns. Asked once, the first time the page asks (`sudo -n true` runs only `true`, and fails at
// once where sudo wants a password); a change to sudoers shows after a restart. A test answers instead, so no test
// runs sudo.
func (l *Login) PasswordlessSudo() bool {
	if l.sudoAnswer != "" {
		return l.sudoAnswer == "1"
	}
	l.sudoOnce.Do(func() {
		cmd := exec.Command("sudo", "-n", "true")
		done := make(chan error, 1)
		if err := cmd.Start(); err != nil {
			return
		}
		go func() { done <- cmd.Wait() }()
		select {
		case err := <-done:
			l.sudo = err == nil
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	})
	return l.sudo
}

func key(token string) string {
	sum := sha(token)
	return hex.EncodeToString(sum[:])
}

// Gen is the enabled generation, read before a login's checks and given to Start.
func (l *Login) Gen() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.gen
}

// Start begins a session: its token (32 random bytes, base64url) and when it expires, in ms since the epoch. Only the
// token's hash is kept. It starts none (ok false) when the setting went off since gen was read.
func (l *Login) Start(now time.Time, gen uint64) (token string, expires int64, ok bool) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	exp := now.Add(SessionTTL)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.gen != gen {
		return "", 0, false
	}
	l.sessions[key(token)] = exp
	return token, exp.UnixMilli(), true
}

// Live is whether token is a session's that hasn't expired; an expired one is forgotten. Keyed by the token's hash, so
// a lookup's timing says nothing about the token.
func (l *Login) Live(token string, now time.Time) bool {
	if token == "" {
		return false
	}
	h := key(token)
	l.mu.Lock()
	defer l.mu.Unlock()
	exp, ok := l.sessions[h]
	if !ok {
		return false
	}
	if !exp.After(now) {
		delete(l.sessions, h)
	}
	return exp.After(now)
}

// End ends token's session; false when there was none.
func (l *Login) End(token string) bool {
	if token == "" {
		return false
	}
	h := key(token)
	l.mu.Lock()
	defer l.mu.Unlock()
	_, ok := l.sessions[h]
	delete(l.sessions, h)
	return ok
}

// EndAll ends every session and moves the enabled generation on, as when the setting is seen off.
func (l *Login) EndAll() {
	l.mu.Lock()
	defer l.mu.Unlock()
	clear(l.sessions)
	l.gen++
}

var mediaPath = regexp.MustCompile(`^/api/mail/[A-Za-z0-9_-]+/attachments/`)

// SessionToken is the session token a request carries: its Bearer, or ?token= only where a browser can't send a header
// (a mail attachment's media player; a terminal socket uses a ticket, S-742).
func SessionToken(method, path, query, authorization string) string {
	if t, ok := strings.CutPrefix(authorization, "Bearer "); ok {
		return t
	}
	if method == "GET" && mediaPath.MatchString(path) {
		if v, err := url.ParseQuery(query); err == nil {
			return v.Get("token")
		}
	}
	return ""
}

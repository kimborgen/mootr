package server

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
	"unsafe"

	"github.com/coder/websocket"
	"github.com/creack/pty"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/peers"
)

// The terminal sockets (src/daemon.ts server.on('upgrade') and attachTerminal, src/ticket.ts): a WebSocket on
// /api/agents/:id/tty or /api/shells/:id/tty is the human's terminal into that tmux session, through a PTY running
// `tmux attach`. A browser can't send a header on a WebSocket, so the page buys a one-time ticket with an authenticated
// request and opens the socket with ?ticket=; the CLI and peers may still use ?token=, which auth.humanStrict refuses for
// the shared token. Another machine's terminal is relayed from its daemon's socket, or under strict answered 409 so the
// web opens it there itself.
//
// Every viewer of a session shares one size, the last one asked for (a group): the window is `manual` while any viewer
// is attached, and back to `latest` when the last one goes. A PTY ends with its socket, when its session ends (an
// archive kills it), and when the daemon stops (StartTerminals). Nothing survives a restart but the tmux sessions: the
// sockets drop, and the restarted daemon sets every window back to `latest` (ResetWindowSizes).

// ttyPath is the terminal socket paths, as TS matches the URL's pathname.
var ttyPath = regexp.MustCompile(`^/api/(agents|shells)/([\w-]+)/tty$`)

const (
	ticketTTL = 30 * time.Second
	// termDefault is a first viewer's size when it gives none.
	termCols, termRows = 100, 30
)

// ticketKinds are the sockets a ticket may be bought for.
var ticketKinds = []string{"tty"}

type ticket struct {
	kind, path string
	trusted    bool
	expires    time.Time
}

// tickets are src/ticket.ts's: random, kept only as a hash, good once, for 30 s, and only for the kind and path they
// were issued for. A ticket remembers whether the request that bought it proved the human. Memory only: a restart
// forgets them, and the page buys another.
type tickets struct {
	mu sync.Mutex
	m  map[[sha256.Size]byte]ticket
}

func (t *tickets) issue(kind, path string, trusted bool, now time.Time) (string, time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.m == nil {
		t.m = map[[sha256.Size]byte]ticket{}
	}
	for h, x := range t.m {
		if !x.expires.After(now) {
			delete(t.m, h)
		}
	}
	raw := make([]byte, 24)
	_, _ = rand.Read(raw)
	tok := base64.RawURLEncoding.EncodeToString(raw)
	exp := now.Add(ticketTTL)
	t.m[sha256.Sum256([]byte(tok))] = ticket{kind: kind, path: path, trusted: trusted, expires: exp}
	return tok, exp
}

// redeem spends the ticket whatever the outcome: one tried for the wrong kind or path is gone.
func (t *tickets) redeem(tok, kind, path string, now time.Time) (trusted, ok bool) {
	if tok == "" {
		return false, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	h := sha256.Sum256([]byte(tok))
	x, there := t.m[h]
	if !there {
		return false, false
	}
	delete(t.m, h)
	if x.expires.After(now) && x.kind == kind && x.path == path {
		return x.trusted, true
	}
	return false, false
}

func (s *Server) ticketRoutes() {
	s.handle("POST /api/tickets", s.ticketRoute)
}

// ticketRoute is POST /api/tickets: a one-time ticket for a terminal socket, for the human (S-742).
func (s *Server) ticketRoute(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if !w.human {
		return nil, Errorf(http.StatusForbidden, "sockets are for the human")
	}
	kind, path := "", ""
	if v := get(w.body, "kind"); v != nil {
		kind = jsjson.ToString(v)
	}
	if v := get(w.body, "path"); v != nil {
		path = jsjson.ToString(v)
	}
	if kind != "tty" {
		return nil, Errorf(http.StatusBadRequest, "kind must be one of %s", strings.Join(ticketKinds, ", "))
	}
	if !ttyPath.MatchString(path) {
		return nil, Errorf(http.StatusBadRequest, "path must be a terminal socket path")
	}
	// The ticket stands for this request: it carries the human's proof only when the request did, and never an agent's
	// token's (Owned).
	tok, exp := s.tickets.issue(kind, path, c.Owned, time.Now())
	return struct {
		Ticket  string `json:"ticket"`
		Expires int64  `json:"expires"`
	}{tok, exp.UnixMilli()}, nil
}

// isUpgrade is whether Node would hand the request to the server's 'upgrade' event: it asks to switch protocols.
func isUpgrade(r *http.Request) bool {
	if r.Header.Get("Upgrade") == "" {
		return false
	}
	for _, v := range r.Header.Values("Connection") {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), "upgrade") {
				return true
			}
		}
	}
	return false
}

// destroy drops the connection with no answer, as socket.destroy() does.
func destroy(w http.ResponseWriter) {
	if hj, ok := w.(http.Hijacker); ok {
		if conn, _, err := hj.Hijack(); err == nil {
			conn.Close()
			return
		}
	}
	// No hijacking (a test recorder): a bare 400 stands in.
	w.WriteHeader(http.StatusBadRequest)
}

// answerRaw writes a raw HTTP answer on the socket and closes it, as socket.end(text) does.
func answerRaw(w http.ResponseWriter, status int, typ string, body []byte) {
	if hj, ok := w.(http.Hijacker); ok {
		if conn, buf, err := hj.Hijack(); err == nil {
			fmt.Fprintf(buf, "HTTP/1.1 %d %s\r\ncontent-type: %s\r\ncontent-length: %d\r\nconnection: close\r\n\r\n", status, http.StatusText(status), typ, len(body))
			buf.Write(body)
			buf.Flush()
			conn.Close()
			return
		}
	}
	w.Header().Set("Content-Type", typ)
	w.WriteHeader(status)
	w.Write(body)
}

// tokenAuth is whether ?token= opens a terminal socket: the peer token unless strict refuses it, the shared token only
// with strict off.
func (s *Server) tokenAuth(tok string) bool {
	if s.auth.IsPeer(tok) && !s.strictRefuses("terminal socket opened with the peer token", true) {
		return true
	}
	return s.auth.IsShared(tok) && !s.settings.Get().Auth.HumanStrict
}

// tokenOk is tokenAuth that also logs the shared token's use, which strict would refuse.
func (s *Server) tokenOk(tok string) bool {
	if s.auth.IsShared(tok) {
		s.strictRefuses("terminal socket opened with ?token=", true)
	}
	return s.tokenAuth(tok)
}

// ttyUpgrade is the 'upgrade' event: every protocol switch comes here, and only a terminal socket that passes is
// accepted. Anything else is dropped with no answer, as TS destroys the socket.
func (s *Server) ttyUpgrade(w http.ResponseWriter, r *http.Request) {
	path := r.URL.EscapedPath()
	m := ttyPath.FindStringSubmatch(path)
	q := r.URL.Query()
	now := time.Now()
	var tkTrusted, tkOK bool
	if m != nil {
		tkTrusted, tkOK = s.tickets.redeem(q.Get("ticket"), "tty", path, now)
	}
	strict := s.settings.Get().Auth.HumanStrict
	// A ticket stands for the request that bought it; one bought without the human's proof is no good under strict.
	if tkOK && !tkTrusted && strict {
		destroy(w)
		return
	}
	tok := q.Get("token")
	if (!s.auth.TrustedHuman(r) && !tkOK && !s.tokenOk(tok)) || m == nil {
		destroy(w)
		return
	}
	// A terminal opened on the human's proof alone must come from this daemon's own page: a socket from another site
	// would get the human's terminal (S-414).
	origin := strings.ToLower(r.Header.Get("Origin"))
	if !(tkOK && !tkTrusted) && !s.tokenAuth(tok) && (!s.ownHost(r.Host) || (origin != "" && !s.sameOrigin(origin) && !s.peerUIOrigins(r.Context())[origin])) {
		destroy(w)
		return
	}
	cols, rows := sizeParam(q.Get("cols")), sizeParam(q.Get("rows"))
	ctx := r.Context()
	if m[1] == "shells" {
		if machine := q.Get("machine"); machine != "" && machine != s.cfg.Machine {
			peer, ok := s.peers.ByName(machine)
			if !ok {
				destroy(w)
				return
			}
			s.relayTerminal(w, r, peer, path)
			return
		}
		if !strings.HasPrefix(m[2], "sh-") || !s.tmux.HasSession(ctx, m[2]) {
			destroy(w)
			return
		}
		s.attachTerminal(w, r, m[2], cols, rows)
		return
	}
	a, err := s.db.GetAgent(ctx, m[2])
	if errors.Is(err, db.ErrNotFound) {
		hit, found, err := s.peers.Locate(ctx, s.db, m[2])
		var amb *peers.AmbiguousError
		if errors.As(err, &amb) {
			answerRaw(w, http.StatusConflict, "text/plain", []byte(amb.Msg))
			return
		}
		if err != nil || found != peers.Found || hit.Peer == nil {
			if err != nil {
				slog.Error("tty " + m[2] + ": " + err.Error())
			}
			destroy(w)
			return
		}
		s.relayTerminal(w, r, *hit.Peer, "/api/agents/"+hit.Agent.ID+"/tty")
		return
	}
	if err != nil || !s.tmux.HasSession(ctx, a.ID) {
		destroy(w)
		return
	}
	s.attachTerminal(w, r, a.ID, cols, rows)
}

// sizeParam is Number(param) as a size: a positive whole number, else 0 (none given).
func sizeParam(v string) int {
	if v == "" {
		return 0
	}
	f := jsjson.ToNumber(v)
	if f != f || f < 1 || f > 10000 {
		return 0
	}
	return int(math.Trunc(f))
}

// relayTerminal pipes a terminal on another machine from its daemon's terminal socket. The human's proof holds only on
// the daemon the browser reaches, so under strict the socket is answered 409 naming the machine and its serve origin,
// and the web opens it there itself (S-544).
func (s *Server) relayTerminal(w http.ResponseWriter, r *http.Request, peer config.Peer, path string) {
	if !s.enterTerminal() {
		destroy(w)
		return
	}
	defer s.terms.handlers.Done()
	if s.settings.Get().Auth.HumanStrict {
		body := map[string]any{"error": "a terminal on " + peer.Name + " is opened from stam's web UI on " + peer.Name, "refusal": "human-on-machine", "machine": peer.Name}
		if o := s.peerServeOrigin(peer.URL); o != nil {
			body["origin"] = *o
		}
		b, _ := json.Marshal(body)
		answerRaw(w, http.StatusConflict, "application/json", b)
		return
	}
	s.logOnce("relay "+peer.Name+" a terminal socket", func(prefix string) string {
		return fmt.Sprintf("%s: relaying a terminal socket to %s as the human", prefix, peer.Name)
	})
	q := r.URL.Query()
	q.Set("token", peer.Bearer())
	q.Del("machine")
	q.Del("ticket")
	target := strings.TrimRight(peer.URL, "/")
	target = "ws" + strings.TrimPrefix(target, "http") + path + "?" + q.Encode()
	// The dial ends with the daemon's stop too: Shutdown doesn't cancel a request that will be hijacked.
	life, endLife := s.termLife(r.Context())
	dialCtx, cancel := context.WithTimeout(life, 10*time.Second)
	// The connection under the socket is kept, so the stop can cut a close handshake short (closeSocket).
	var upRaw net.Conn
	// A clone of the default transport, so the proxy settings and timeouts stay.
	dialer := http.DefaultTransport.(*http.Transport).Clone()
	dial := dialer.DialContext
	dialer.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, err := dial(ctx, network, addr)
		upRaw = c
		return c, err
	}
	defer dialer.CloseIdleConnections()
	up, _, err := websocket.Dial(dialCtx, target, &websocket.DialOptions{HTTPClient: &http.Client{Transport: dialer}})
	cancel()
	endLife()
	if err != nil {
		destroy(w)
		return
	}
	up.SetReadLimit(-1)
	client, clientRaw, err := accept(w, r)
	if err != nil {
		up.CloseNow()
		return
	}
	client.SetReadLimit(-1)
	ctx, stop := s.termLife(context.Background())
	defer stop()
	pipe := func(from, to *websocket.Conn) {
		defer stop()
		for {
			typ, data, err := from.Read(ctx)
			if err != nil {
				return
			}
			if to.Write(ctx, typ, data) != nil {
				return
			}
		}
	}
	// Both directions end before the handler does, so none outlives the stop's wait.
	piped := make(chan struct{})
	go func() {
		defer close(piped)
		pipe(up, client)
	}()
	pipe(client, up)
	s.closeSocket(up, upRaw, websocket.StatusNormalClosure, "")
	s.closeSocket(client, clientRaw, websocket.StatusNormalClosure, "")
	<-piped
}

// closeSocket closes a terminal socket with the close handshake (code and reason), which waits up to 5 s for the other
// end's answer. The stop cuts that short: the socket is dropped at once when the daemon is stopping, and its connection
// (raw) closed as soon as the stop starts, so a client that never answers can't hold the stop's wait. (A CloseNow
// during a Close only waits for it.) Every close of a terminal socket goes through here, a failed start's too.
func (s *Server) closeSocket(ws *websocket.Conn, raw net.Conn, code websocket.StatusCode, reason string) {
	done := s.termDone()
	select {
	case <-done:
		ws.CloseNow()
		return
	default:
	}
	closed := make(chan struct{})
	go func() {
		select {
		case <-done:
			if raw != nil {
				raw.Close()
			}
		case <-closed:
		}
	}()
	ws.Close(code, reason)
	close(closed)
}

// hijacked keeps the connection websocket.Accept takes over.
type hijacked struct {
	http.ResponseWriter
	conn net.Conn
}

func (h *hijacked) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	c, rw, err := http.NewResponseController(h.ResponseWriter).Hijack()
	h.conn = c
	return c, rw, err
}

// accept is websocket.Accept, with the connection under the socket.
func accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, net.Conn, error) {
	h := &hijacked{ResponseWriter: w}
	ws, err := websocket.Accept(h, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	return ws, h.conn, err
}

// termLife is a context that ends with parent, or when the daemon stops (the context StartTerminals got).
func (s *Server) termLife(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	if done := s.termDone(); done != nil {
		go func() {
			select {
			case <-done:
				cancel()
			case <-ctx.Done():
			}
		}()
	}
	return ctx, cancel
}

// terminals is attachTerminal's viewers: one group per session, with the size every viewer shares. mu guards the groups
// and is never held over a socket write: each viewer's size frames go out from its own sender.
type terminals struct {
	mu     sync.Mutex
	groups map[string]*termGroup
	done   <-chan struct{}
	// viewed is the sessions with a viewer, read without mu for the status line.
	viewed sync.Map
	// handlers counts the terminal sockets open (attachTerminal, relayTerminal): a hijacked socket isn't one
	// http.Server.Shutdown waits for, so the stop waits here (WaitTerminals). stopping refuses a new one once it began.
	handlers sync.WaitGroup
	stopping bool
}

type termGroup struct {
	cols, rows int
	views      map[*termView]bool
}

type termView struct {
	id  string
	ws  *websocket.Conn
	pty *os.File
	// closed is closed when the PTY is.
	closed chan struct{}
	// size is the size frame not yet sent, latest wins; kick wakes the sender.
	smu  sync.Mutex
	size *[2]int
	kick chan struct{}
}

// Seams for tests: how a size frame and the socket's input reach their ends, and what the PTY runs.
var (
	sendFrame = func(ctx context.Context, v *termView, b []byte) error {
		return v.ws.Write(ctx, websocket.MessageText, b)
	}
	ptyWrite = writePty
	// ptyBlocked is told each time a PTY write has to wait for room.
	ptyBlocked = func(*termView) {}
	// attachCommand is the process a viewer's PTY runs: tmux attach.
	attachCommand = func(bin string, args []string) *exec.Cmd { return exec.Command(bin, args...) }
)

// queueSize sends the viewer a size frame from its sender; never blocks.
func (v *termView) queueSize(cols, rows int) {
	v.smu.Lock()
	v.size = &[2]int{cols, rows}
	v.smu.Unlock()
	select {
	case v.kick <- struct{}{}:
	default:
	}
}

// sendSizes sends each size queued, in order, until ctx ends; a newer size replaces one not yet sent.
func (v *termView) sendSizes(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-v.kick:
		}
		v.smu.Lock()
		size := v.size
		v.size = nil
		v.smu.Unlock()
		if size != nil && sendFrame(ctx, v, controlFrame(size[0], size[1])) != nil {
			return
		}
	}
}

// StartTerminals sets every session's windows back to `latest`, as TS's boot does, since a crash leaves them `manual`
// with no viewer left to reset them; and ends every terminal socket, and its PTY, when ctx ends.
func (s *Server) StartTerminals(ctx context.Context) {
	s.tmux.ResetWindowSizes(ctx)
	s.terms.mu.Lock()
	s.terms.done = ctx.Done()
	s.terms.mu.Unlock()
}

// enterTerminal counts a terminal socket's handler for WaitTerminals; false once the stop began, to refuse it.
func (s *Server) enterTerminal() bool {
	s.terms.mu.Lock()
	defer s.terms.mu.Unlock()
	if s.terms.stopping {
		return false
	}
	// The daemon's stop began (its lifecycle ended) before WaitTerminals: a socket opened now would outlive it.
	if s.terms.done != nil {
		select {
		case <-s.terms.done:
			return false
		default:
		}
	}
	s.terms.handlers.Add(1)
	return true
}

// WaitTerminals is the stop's wait for the terminal sockets, after the context StartTerminals got ended them: no new
// one opens, and it returns once each handler has hung up its PTY and reaped it, or ctx ends first.
func (s *Server) WaitTerminals(ctx context.Context) error {
	s.terms.mu.Lock()
	s.terms.stopping = true
	s.terms.mu.Unlock()
	done := make(chan struct{})
	go func() {
		s.terms.handlers.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) termDone() <-chan struct{} {
	s.terms.mu.Lock()
	defer s.terms.mu.Unlock()
	return s.terms.done
}

// TerminalViewers is whether a web terminal has the session open, for the status line's `viewed`.
func (s *Server) TerminalViewers(id string) bool {
	_, ok := s.terms.viewed.Load(id)
	return ok
}

// controlFrame is the size message a viewer gets: a NUL, then JSON.
func controlFrame(cols, rows int) []byte {
	b, _ := json.Marshal(map[string][2]int{"size": {cols, rows}})
	return append([]byte{0}, b...)
}

// setSize gives the group's window and every PTY in it the size, and queues it for each viewer; s.terms.mu is held.
func (s *Server) setSize(id string, g *termGroup, cols, rows int) {
	g.cols, g.rows = cols, rows
	s.tmux.ResizeWindow(context.Background(), id, cols, rows)
	for v := range g.views {
		_ = setPtySize(v.pty, cols, rows)
		v.queueSize(cols, rows)
	}
}

// How long a hung-up attach has to exit before it is sent SIGCONT and SIGTERM, and then SIGKILL.
var termHangupWait = 2 * time.Second

// attachTerminal is src/daemon.ts attachTerminal: the socket becomes a PTY running `tmux attach` on the session. A new
// viewer takes over the size, as typing in it would; the first one sizes the window even with no size given (0x0 is
// the default 100x30), so the window never keeps the size it had before the web took it.
func (s *Server) attachTerminal(w http.ResponseWriter, r *http.Request, id string, cols, rows int) {
	if !s.enterTerminal() {
		destroy(w)
		return
	}
	defer s.terms.handlers.Done()
	ws, raw, err := accept(w, r)
	if err != nil {
		return
	}
	ws.SetReadLimit(-1)
	defer ws.CloseNow()
	ctx := context.Background()

	s.terms.mu.Lock()
	done := s.terms.done
	if s.terms.groups == nil {
		s.terms.groups = map[string]*termGroup{}
	}
	g := s.terms.groups[id]
	first := g == nil
	if first {
		g = &termGroup{cols: termCols, rows: termRows, views: map[*termView]bool{}}
		if cols > 0 {
			g.cols = cols
		}
		if rows > 0 {
			g.rows = rows
		}
		s.terms.groups[id] = g
		s.terms.viewed.Store(id, true)
		// The viewers set the window's size, not the clients of `stam attach`.
		s.tmux.SetWindowSize(ctx, id, "manual")
	}
	cmd := attachCommand(s.tmux.Binary(), s.tmux.AttachArgs(id))
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	f, err := startPty(cmd, g.cols, g.rows)
	if err != nil {
		s.leaveGroup(id, g, nil)
		s.terms.mu.Unlock()
		s.closeSocket(ws, raw, websocket.StatusInternalError, "no terminal")
		return
	}
	v := &termView{id: id, ws: ws, pty: f, closed: make(chan struct{}), kick: make(chan struct{}, 1)}
	g.views[v] = true
	switch {
	case first:
		s.setSize(id, g, g.cols, g.rows)
	case cols > 0 && rows > 0:
		s.setSize(id, g, cols, rows)
	default:
		v.queueSize(g.cols, g.rows)
	}
	s.terms.mu.Unlock()

	stop, quit := context.WithCancel(ctx)
	defer quit()
	sent := make(chan struct{})
	go func() {
		defer close(sent)
		v.sendSizes(stop)
	}()
	// The attach is hung up (SIGHUP to its process group, as node-pty's kill does) and its PTY closed as soon as the
	// socket, the session or the daemon ends, from here, so a write stuck on a PTY nobody reads returns.
	var hung sync.Once
	hangup := func() {
		hung.Do(func() {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGHUP)
			f.Close()
			close(v.closed)
		})
	}
	go func() {
		select {
		case <-stop.Done():
		case <-done:
			quit()
		}
		hangup()
	}()
	// The PTY's output goes to the socket as text, whole characters only: a browser drops a socket whose text frame
	// isn't UTF-8.
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		defer quit()
		rd := bufio.NewReaderSize(f, 32<<10)
		buf := make([]byte, 32<<10)
		var carry []byte
		for {
			n, err := rd.Read(buf)
			if n > 0 {
				out, rest := utf8Chunk(append(carry, buf[:n]...))
				carry = rest
				if len(out) > 0 && ws.Write(stop, websocket.MessageText, out) != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	for {
		_, data, err := ws.Read(stop)
		if err != nil {
			break
		}
		if len(data) > 0 && data[0] == 0 {
			var sz struct{ Cols, Rows float64 }
			if json.Unmarshal(data[1:], &sz) == nil && sz.Cols > 0 && sz.Rows > 0 {
				c, rw := int(sz.Cols), int(sz.Rows)
				s.terms.mu.Lock()
				if c != g.cols || rw != g.rows {
					s.setSize(id, g, c, rw)
				}
				s.terms.mu.Unlock()
			}
			continue
		}
		if _, err := ptyWrite(v, data); err != nil {
			break
		}
	}
	quit()
	hangup()
	reap(cmd)
	<-exited
	s.terms.mu.Lock()
	s.leaveGroup(id, g, v)
	s.terms.mu.Unlock()
	s.closeSocket(ws, raw, websocket.StatusNormalClosure, "")
	// The size sender ends with stop; waiting for it here means no sender outlives the handler or the stop's wait.
	<-sent
}

// reap waits for a hung-up attach, and if it hasn't gone in termHangupWait (a stopped one can't take the SIGHUP)
// continues and terminates its group, then kills it.
func reap(cmd *exec.Cmd) {
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()
	pg := -cmd.Process.Pid
	for _, sigs := range [][]syscall.Signal{{syscall.SIGCONT, syscall.SIGTERM}, {syscall.SIGKILL}} {
		select {
		case <-exited:
			return
		case <-time.After(termHangupWait):
		}
		for _, sig := range sigs {
			_ = syscall.Kill(pg, sig)
		}
	}
	<-exited
}

// leaveGroup drops a viewer; with none left the window fits its clients again, as tmux does. s.terms.mu is held.
func (s *Server) leaveGroup(id string, g *termGroup, v *termView) {
	delete(g.views, v)
	if len(g.views) == 0 && s.terms.groups[id] == g {
		delete(s.terms.groups, id)
		s.terms.viewed.Delete(id)
		s.tmux.SetWindowSize(context.Background(), id, "latest")
	}
}

// startPty is pty.StartWithSize with the PTY made non-blocking, so the runtime polls it and closing it ends a read or
// write in progress (creack/pty leaves it blocking, where a close waits for them).
func startPty(cmd *exec.Cmd, cols, rows int) (*os.File, error) {
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	fd, _, errno := syscall.Syscall(syscall.SYS_FCNTL, f.Fd(), syscall.F_DUPFD_CLOEXEC, 0)
	f.Close()
	if errno != 0 {
		err = errno
	} else if err = syscall.SetNonblock(int(fd), true); err != nil {
		syscall.Close(int(fd))
	}
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	return os.NewFile(fd, "/dev/ptmx"), nil
}

// writePty writes all of b to the viewer's PTY, waiting in the runtime's poller while the PTY is full (ptyBlocked), so
// closing the PTY ends the wait.
func writePty(v *termView, b []byte) (int, error) {
	sc, err := v.pty.SyscallConn()
	if err != nil {
		return 0, err
	}
	n := 0
	var werr error
	err = sc.Write(func(fd uintptr) bool {
		for n < len(b) {
			m, err := syscall.Write(int(fd), b[n:])
			if m > 0 {
				n += m
			}
			switch {
			case err == syscall.EAGAIN:
				ptyBlocked(v)
				return false
			case err == syscall.EINTR:
			case err != nil:
				werr = err
				return true
			case m == 0:
				werr = io.ErrShortWrite
				return true
			}
		}
		return true
	})
	if err == nil {
		err = werr
	}
	return n, err
}

// setPtySize is pty.Setsize without f.Fd(), which would make the PTY blocking again.
func setPtySize(f *os.File, cols, rows int) error {
	sc, err := f.SyscallConn()
	if err != nil {
		return err
	}
	ws := pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}
	var errno syscall.Errno
	if err := sc.Control(func(fd uintptr) {
		_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
	}); err != nil {
		return err
	}
	if errno != 0 {
		return errno
	}
	return nil
}

// utf8Chunk is b's whole characters, invalid bytes as U+FFFD as Node's decoder gives them, and the start of a character
// cut at the end, kept for the next read.
func utf8Chunk(b []byte) (out, rest []byte) {
	cut := len(b)
	// A character cut at the end is at most 3 bytes of a 4-byte sequence.
	for i := len(b) - 1; i >= 0 && i >= len(b)-3; i-- {
		c := b[i]
		if c < 0x80 {
			break
		}
		if c >= 0xC0 {
			need := 2
			if c >= 0xF0 {
				need = 4
			} else if c >= 0xE0 {
				need = 3
			}
			if len(b)-i < need && !utf8.FullRune(b[i:]) {
				cut = i
			}
			break
		}
	}
	whole := b[:cut]
	if utf8.Valid(whole) {
		return append([]byte(nil), whole...), append([]byte(nil), b[cut:]...)
	}
	for len(whole) > 0 {
		r, n := utf8.DecodeRune(whole)
		if r == utf8.RuneError && n == 1 {
			out = append(out, "\uFFFD"...)
		} else {
			out = append(out, whole[:n]...)
		}
		whole = whole[n:]
	}
	return out, append([]byte(nil), b[cut:]...)
}

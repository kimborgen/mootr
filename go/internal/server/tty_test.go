package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"

	"stam/internal/tmux"
)

// TestTickets: a ticket is good once, for 30 s, and only for the kind and path it was bought for; a wrong try spends it.
// It carries whether the request that bought it proved the human.
func TestTickets(t *testing.T) {
	var tk tickets
	now := time.Now()
	const path = "/api/shells/sh-a/tty"
	tok, exp := tk.issue("tty", path, true, now)
	if len(tok) != 32 || !exp.Equal(now.Add(ticketTTL)) {
		t.Fatalf("ticket %q expires %v", tok, exp)
	}
	if trusted, ok := tk.redeem(tok, "tty", path, now); !ok || !trusted {
		t.Fatalf("redeem: trusted %v ok %v", trusted, ok)
	}
	if _, ok := tk.redeem(tok, "tty", path, now); ok {
		t.Fatal("a ticket was good twice")
	}
	for _, c := range []struct {
		name, kind, path string
		at               time.Time
	}{
		{"another path", "tty", "/api/shells/sh-b/tty", now},
		{"another kind", "pty", path, now},
		{"expired", "tty", path, now.Add(ticketTTL)},
	} {
		tok, _ := tk.issue("tty", path, false, now)
		if _, ok := tk.redeem(tok, c.kind, c.path, c.at); ok {
			t.Errorf("%s: redeemed", c.name)
		}
		if _, ok := tk.redeem(tok, "tty", path, now); ok {
			t.Errorf("%s: the ticket survived a wrong try", c.name)
		}
	}
	tok, _ = tk.issue("tty", path, false, now)
	if trusted, ok := tk.redeem(tok, "tty", path, now); !ok || trusted {
		t.Errorf("an untrusted ticket: trusted %v ok %v", trusted, ok)
	}
	if _, ok := tk.redeem("", "tty", path, now); ok {
		t.Error("no ticket redeemed")
	}
}

// TestTicketRoute: tickets are sold to the human only, for a terminal socket path; one is trusted only when the
// request carried the human's proof.
func TestTicketRoute(t *testing.T) {
	f := relayFixture(t, "http://127.0.0.1:1", "", nil)
	body := `{"kind":"tty","path":"/api/shells/sh-a/tty"}`
	for _, c := range []struct {
		name   string
		call   call
		status int
		msg    string
	}{
		{"the shared token", call{token: sharedTok}, 403, "sockets are for the human"},
		{"an agent", call{token: agentTok, header: map[string]string{"X-Stam-Human": "1"}}, 403, "sockets are for the human"},
		{"an agent with the test key", call{token: agentTok, header: humanHdr}, 403, "sockets are for the human"},
		{"a bad kind", call{header: humanHdr, body: `{"kind":"x","path":"/api/shells/sh-a/tty"}`}, 400, "kind must be one of tty"},
		{"a bad path", call{header: humanHdr, body: `{"kind":"tty","path":"/api/agents"}`}, 400, "path must be a terminal socket path"},
	} {
		c.call.method, c.call.path = "POST", "/api/tickets"
		if c.call.body == "" {
			c.call.body = body
		}
		rec := f.do(c.call)
		if rec.Code != c.status || envelope(t, rec)["error"] != c.msg {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body)
		}
	}
	buy := func(c call) (trusted bool) {
		t.Helper()
		c.method, c.path, c.body = "POST", "/api/tickets", body
		rec := f.do(c)
		var out struct {
			Ticket  string
			Expires int64
		}
		if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &out) != nil || out.Ticket == "" || out.Expires <= time.Now().UnixMilli() {
			t.Fatalf("buy: %d %s", rec.Code, rec.Body)
		}
		trusted, ok := f.srv.tickets.redeem(out.Ticket, "tty", "/api/shells/sh-a/tty", time.Now())
		if !ok {
			t.Fatal("the ticket sold isn't good")
		}
		return trusted
	}
	if !buy(call{header: humanHdr}) {
		t.Error("the human's ticket isn't trusted")
	}
	if buy(call{token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}}) {
		t.Error("the shared token's ticket is trusted")
	}
	// Under strict the shared and peer tokens' x-stam-human is no human: no ticket is sold.
	strict := relayFixture(t, "http://127.0.0.1:1", `"auth":{"humanStrict":true}`, nil)
	for _, tok := range []string{sharedTok, peerTok} {
		rec := strict.do(call{method: "POST", path: "/api/tickets", token: tok, header: map[string]string{"X-Stam-Human": "1"}, body: body})
		if rec.Code != 403 || envelope(t, rec)["error"] != "sockets are for the human" {
			t.Errorf("strict, %s: %d %s", tok, rec.Code, rec.Body)
		}
	}
}

// TestShellRoutes: a terminal is the human's to start, kill and type into; another machine's is forwarded, and an id
// TS wouldn't match is no route. The list is open to any token.
func TestShellRoutes(t *testing.T) {
	f, _, tc := termFixture(t, "")
	for _, c := range []struct {
		name   string
		call   call
		status int
		msg    string
	}{
		{"start, an agent", call{path: "/api/shells", token: agentTok, header: map[string]string{"X-Stam-Human": "1"}}, 403, "terminals are for the human"},
		{"start, an agent with the test key", call{path: "/api/shells", token: agentTok, header: humanHdr}, 403, "terminals are for the human"},
		{"kill, an agent", call{path: "/api/shells/sh-x/kill", token: agentTok}, 403, "terminals are for the human"},
		{"input, an agent", call{path: "/api/shells/sh-x/input", token: agentTok, body: `{"text":"rm -rf ~"}`}, 403, "terminals are for the human"},
		{"input, not a shell", call{path: "/api/shells/s-1/input", header: humanHdr}, 404, "no route POST /api/shells/s-1/input"},
		{"input, no such shell", call{path: "/api/shells/sh-none/input", header: humanHdr, body: `{"text":"x"}`}, 404, "no terminal sh-none"},
		{"start, an unknown machine", call{path: "/api/shells", header: humanHdr, body: `{"machine":"nowhere"}`}, 404, "no peer machine nowhere"},
	} {
		c.call.method = "POST"
		if c.call.body == "" {
			c.call.body = "{}"
		}
		rec := f.do(c.call)
		if rec.Code != c.status || envelope(t, rec)["error"] != c.msg {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body)
		}
	}
	if n := len(tc.ListShells(context.Background(), "here")); n != 0 {
		t.Fatalf("a refused start made %d terminals", n)
	}

	// The human starts one, types into it and kills it; the list shows it to any token.
	cwd := t.TempDir()
	rec := f.do(call{method: "POST", path: "/api/shells", header: humanHdr, body: `{"cwd":"` + cwd + `"}`})
	var sh tmux.Shell
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &sh) != nil || !shellRef.MatchString(sh.ID) || sh.Cwd != cwd || sh.Machine != "here" {
		t.Fatalf("start: %d %s", rec.Code, rec.Body)
	}
	rec = f.do(call{path: "/api/shells", token: agentTok})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"id":"`+sh.ID+`"`) {
		t.Fatalf("list: %d %s", rec.Code, rec.Body)
	}
	rec = f.do(call{method: "POST", path: "/api/shells/" + sh.ID + "/input", header: humanHdr, body: `{"text":"echo typed-$((40+2))\n"}`})
	if rec.Code != 200 || rec.Body.String() != `{"sent":true}` {
		t.Fatalf("input: %d %s", rec.Code, rec.Body)
	}
	eventually(t, "the typing to run", func() bool {
		s, _ := tc.CapturePane(context.Background(), sh.ID)
		return strings.Contains(s, "typed-42")
	})
	rec = f.do(call{method: "POST", path: "/api/shells/" + sh.ID + "/kill", header: humanHdr, body: "{}"})
	if rec.Code != 200 || rec.Body.String() != `{"killed":"`+sh.ID+`"}` || tc.HasSession(context.Background(), sh.ID) {
		t.Fatalf("kill: %d %s", rec.Code, rec.Body)
	}
}

// TestShellRoutesStrict: under strict the shared and peer tokens' x-stam-human is no human: they start, kill and type
// into no terminal (S-638). With strict off TS takes both as the human, and so does Go.
func TestShellRoutesStrict(t *testing.T) {
	f, _, tc := termFixture(t, `"auth":{"humanStrict":true}`)
	shellSession(t, tc, "sh-s1")
	claim := map[string]string{"X-Stam-Human": "1"}
	for _, tok := range []string{sharedTok, peerTok} {
		for _, c := range []struct{ path, body string }{
			{"/api/shells", `{}`},
			{"/api/shells/sh-s1/kill", `{}`},
			{"/api/shells/sh-s1/input", `{"text":"echo strict-$((40+2))\n"}`},
		} {
			rec := f.do(call{method: "POST", path: c.path, token: tok, header: claim, body: c.body})
			if rec.Code != 403 || envelope(t, rec)["error"] != "terminals are for the human" {
				t.Errorf("%s with %s: %d %s", c.path, tok, rec.Code, rec.Body)
			}
		}
	}
	if !tc.HasSession(context.Background(), "sh-s1") {
		t.Fatal("a refused kill killed the terminal")
	}
	if n := len(tc.ListShells(context.Background(), "here")); n != 1 {
		t.Errorf("a refused start made a terminal: %d", n)
	}
	if s, _ := tc.CapturePane(context.Background(), "sh-s1"); strings.Contains(s, "strict-42") {
		t.Error("a refused input was typed")
	}
	// The human's proof still works under strict.
	rec := f.do(call{method: "POST", path: "/api/shells/sh-s1/kill", header: humanHdr, body: `{}`})
	if rec.Code != 200 || tc.HasSession(context.Background(), "sh-s1") {
		t.Fatalf("the human's kill under strict: %d %s", rec.Code, rec.Body)
	}
}

// TestShellForwarded: another machine's terminal goes to its daemon as the human, under strict too, through the
// relay's human carry.
func TestShellForwarded(t *testing.T) {
	var got []string
	// The peer's answers carry fields of its own (a token, another machine): none of them reaches the page.
	replies := map[string]string{
		"/api/shells":              `{"id":"sh-new","cwd":"/w","machine":"elsewhere","token":"leak"}`,
		"/api/shells/sh-far/kill":  `{"killed":"sh-other","token":"leak"}`,
		"/api/shells/sh-far/input": `{"sent":true,"token":"leak"}`,
	}
	status := 200
	far := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		if status != 200 {
			w.WriteHeader(status)
			fmt.Fprint(w, `{"error":"answer on far","refusal":"human-on-machine","machine":"far","origin":"https://far.example","token":"leak"}`)
			return
		}
		fmt.Fprint(w, replies[r.URL.Path])
	}))
	defer far.Close()
	f := relayFixture(t, far.URL, "", nil)
	for _, c := range []struct{ path, body, want string }{
		{"/api/shells", `{"machine":"far","cwd":"/w"}`, `{"id":"sh-new","cwd":"/w","machine":"far"}`},
		{"/api/shells/sh-far/kill", `{"machine":"far"}`, `{"killed":"sh-far"}`},
		{"/api/shells/sh-far/input", `{"machine":"far","text":"x"}`, `{"sent":true}`},
	} {
		rec := f.do(call{method: "POST", path: c.path, header: humanHdr, body: c.body})
		if rec.Code != 200 || rec.Body.String() != c.want {
			t.Errorf("%s: %d %s, want %s", c.path, rec.Code, rec.Body, c.want)
		}
	}
	if len(got) != 3 || got[1] != "POST /api/shells/sh-far/kill Bearer "+peerTok {
		t.Fatalf("the peer got %q", got)
	}
	// A peer's refusal stays an error with its own status, without the peer's refusal fields.
	status = 409
	for _, path := range []string{"/api/shells", "/api/shells/sh-far/kill", "/api/shells/sh-far/input"} {
		rec := f.do(call{method: "POST", path: path, header: humanHdr, body: `{"machine":"far"}`})
		if rec.Code != 409 || rec.Body.String() != `{"error":"answer on far"}` {
			t.Errorf("%s with the peer's 409: %d %s", path, rec.Code, rec.Body)
		}
	}
	// An agent's write never reaches the peer.
	n := len(got)
	f.do(call{method: "POST", path: "/api/shells/sh-far/kill", token: agentTok, body: `{"machine":"far"}`})
	if len(got) != n {
		t.Fatalf("an agent's kill was forwarded: %q", got)
	}
}

// termFixture is relayFixture with a tmux server of the test's own as the daemon's, served on a real listener whose
// address is one of the daemon's hosts.
func termFixture(t *testing.T, settings string) (*fixture, *httptest.Server, *tmux.Client) {
	t.Helper()
	return termFixtureAt(t, "http://127.0.0.1:1", settings)
}

// termFixtureAt is termFixture with the peer `far` at peerURL.
func termFixtureAt(t *testing.T, peerURL, settings string) (*fixture, *httptest.Server, *tmux.Client) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	f := relayFixture(t, peerURL, settings, nil)
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	socket := "stam-test-tty-" + hex.EncodeToString(b)
	tc := &tmux.Client{Socket: socket, TempDir: t.TempDir()}
	t.Cleanup(func() {
		tc.Run(context.Background(), nil, "kill-server")
		tmp := os.Getenv("TMUX_TMPDIR")
		if tmp == "" {
			tmp = "/tmp"
		}
		os.Remove(filepath.Join(tmp, "tmux-"+strconv.Itoa(os.Getuid()), socket))
	})
	f.srv.tmux = tc
	ts := httptest.NewServer(f.srv)
	t.Cleanup(ts.Close)
	f.srv.hosts[strings.TrimPrefix(ts.URL, "http://")] = true
	return f, ts, tc
}

// shellSession starts a terminal running sh, as the human's would be, named id.
func shellSession(t *testing.T, tc *tmux.Client, id string) {
	t.Helper()
	if r := tc.Run(context.Background(), nil, "new-session", "-d", "-s", id, "-x", "80", "-y", "24", "sh"); r.Status != 0 {
		t.Fatalf("new-session: %s", r.Stderr)
	}
}

// upgrades is whether a raw WebSocket upgrade of path, with the headers, is accepted (a 101): a refusal is a dropped
// socket, or for a relay under strict an answer.
func upgrades(t *testing.T, ts *httptest.Server, path string, hdr map[string]string) (bool, string) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(ts.URL, "http://"))
	must(t, err)
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	req := "GET " + path + " HTTP/1.1\r\nHost: " + strings.TrimPrefix(ts.URL, "http://") + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
	for k, v := range hdr {
		req += k + ": " + v + "\r\n"
	}
	_, err = conn.Write([]byte(req + "\r\n"))
	must(t, err)
	line, _ := bufio.NewReader(conn).ReadString('\n')
	return strings.HasPrefix(line, "HTTP/1.1 101 "), line
}

// TestTTYUpgradeRefusals: a terminal socket opens only on the human's proof (from its own page or a peer's), a ticket,
// or a token strict allows; any other upgrade, and one from another site on the human's proof alone, is dropped.
func TestTTYUpgradeRefusals(t *testing.T) {
	for _, strict := range []bool{false, true} {
		t.Run(fmt.Sprintf("strict %v", strict), func(t *testing.T) {
			f, ts, tc := termFixture(t, fmt.Sprintf(`"auth":{"humanStrict":%v}`, strict))
			shellSession(t, tc, "sh-t1")
			key := map[string]string{"X-Stam-Test-Human": humanKey}
			p := "/api/shells/sh-t1/tty"
			human, _ := f.srv.tickets.issue("tty", p, true, time.Now())
			shared, _ := f.srv.tickets.issue("tty", p, false, time.Now())
			other, _ := f.srv.tickets.issue("tty", "/api/shells/sh-t2/tty", true, time.Now())
			for _, c := range []struct {
				name string
				path string
				hdr  map[string]string
				want bool
			}{
				{"no credential", p, nil, false},
				{"not a terminal path", "/api/agents", key, false},
				{"a bad token", p + "?token=nope", nil, false},
				{"an agent's token", p + "?token=" + agentTok, nil, false},
				{"a ticket for another path", p + "?ticket=" + other, nil, false},
				{"no such shell", "/api/shells/sh-none/tty", key, false},
				{"not a shell's id", "/api/shells/s-1/tty", key, false},
				{"the human from another site", p, map[string]string{"X-Stam-Test-Human": humanKey, "Origin": "http://elsewhere"}, false},
				{"the human from another host", p, map[string]string{"X-Stam-Test-Human": humanKey, "Host": "evil.example"}, false},
				{"the shared token", p + "?token=" + sharedTok, nil, !strict},
				{"the peer token", p + "?token=" + peerTok, nil, !strict},
				{"a ticket the shared token bought", p + "?ticket=" + shared, nil, !strict},
				{"a ticket the human bought", p + "?ticket=" + human, nil, true},
				{"the human", p, key, true},
				{"the human from its own page", p, map[string]string{"X-Stam-Test-Human": humanKey, "Origin": ts.URL}, true},
				// The peer far's UI origin (its daemon url).
				{"the human from a peer's page", p, map[string]string{"X-Stam-Test-Human": humanKey, "Origin": "http://127.0.0.1:1"}, true},
			} {
				hdr := c.hdr
				if host, ok := hdr["Host"]; ok {
					// A second Host header isn't sent: the request line's absolute form names the host instead.
					delete(hdr, "Host")
					c.path = "http://" + host + c.path
				}
				if got, line := upgrades(t, ts, c.path, hdr); got != c.want {
					t.Errorf("%s: upgraded %v (%q)", c.name, got, line)
				}
			}
			// A ticket is good once.
			if got, _ := upgrades(t, ts, p+"?ticket="+human, nil); got {
				t.Error("a spent ticket opened a socket")
			}
		})
	}
}

// TestTTYRelayStrict: under strict a terminal on another machine isn't relayed (the human's proof holds only here): it
// is answered 409 with the machine, for the web to open it there.
func TestTTYRelayStrict(t *testing.T) {
	_, ts, _ := termFixture(t, `"auth":{"humanStrict":true}`)
	got, line := upgrades(t, ts, "/api/shells/sh-far/tty?machine=far", map[string]string{"X-Stam-Test-Human": humanKey})
	if got || !strings.HasPrefix(line, "HTTP/1.1 409 ") {
		t.Fatalf("got %q", line)
	}
}

// viewer is one web terminal on a session.
type viewer struct {
	ws  *websocket.Conn
	out strings.Builder
}

func openTerminal(t *testing.T, ts *httptest.Server, id, size string) *viewer {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	u := "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/shells/" + id + "/tty" + size
	ws, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: http.Header{"X-Stam-Test-Human": {humanKey}}})
	must(t, err)
	t.Cleanup(func() { ws.CloseNow() })
	return &viewer{ws: ws}
}

// next is the viewer's next control frame, collecting the terminal's output before it.
func (v *viewer) next(t *testing.T) [2]int {
	t.Helper()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, data, err := v.ws.Read(ctx)
		cancel()
		must(t, err)
		if len(data) > 0 && data[0] == 0 {
			var c struct{ Size [2]int }
			must(t, json.Unmarshal(data[1:], &c))
			return c.Size
		}
		v.out.Write(data)
	}
}

// until reads the terminal's output until it holds want.
func (v *viewer) until(t *testing.T, want string) {
	t.Helper()
	for !strings.Contains(v.out.String(), want) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, data, err := v.ws.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("never saw %q in %q: %v", want, v.out.String(), err)
		}
		v.out.Write(data)
	}
}

func tmuxSays(tc *tmux.Client, args ...string) string {
	return strings.TrimSpace(tc.Run(context.Background(), nil, args...).Stdout)
}

// TestTerminal: a web terminal types into the session and shows it; its viewers share the last size asked for, with
// the window `manual` while any is attached; each PTY ends with its socket, and with the last the window is `latest`.
func TestTerminal(t *testing.T) {
	f, ts, tc := termFixture(t, "")
	shellSession(t, tc, "sh-t1")
	size := func() string { return tmuxSays(tc, "display", "-p", "-t", "=sh-t1:", "#{window_width}x#{window_height}") }
	mode := func() string { return tmuxSays(tc, "show-options", "-w", "-v", "-t", "=sh-t1:", "window-size") }
	clients := func() int { return len(strings.Fields(tmuxSays(tc, "list-clients", "-t", "=sh-t1", "-F", "#{client_pid}"))) }

	a := openTerminal(t, ts, "sh-t1", "?cols=90&rows=20")
	if got := a.next(t); got != [2]int{90, 20} {
		t.Fatalf("first size %v", got)
	}
	if size() != "90x20" || mode() != "manual" || !f.srv.TerminalViewers("sh-t1") {
		t.Fatalf("window %s %s, viewed %v", size(), mode(), f.srv.TerminalViewers("sh-t1"))
	}
	must(t, a.ws.Write(context.Background(), websocket.MessageText, []byte("echo web-$((40+2))\r")))
	a.until(t, "web-42")

	// A second viewer with a size takes it over, for both.
	b := openTerminal(t, ts, "sh-t1", "?cols=70&rows=15")
	if got := b.next(t); got != [2]int{70, 15} {
		t.Fatalf("b's size %v", got)
	}
	if got := a.next(t); got != [2]int{70, 15} {
		t.Fatalf("a's size %v", got)
	}
	// A resize from a viewer reaches the other.
	must(t, a.ws.Write(context.Background(), websocket.MessageText, append([]byte{0}, `{"cols":60,"rows":12}`...)))
	if got := b.next(t); got != [2]int{60, 12} {
		t.Fatalf("b after a's resize %v", got)
	}
	eventually(t, "the window resized", func() bool { return size() == "60x12" })
	if n := clients(); n != 2 {
		t.Fatalf("%d attached clients", n)
	}

	b.ws.Close(websocket.StatusNormalClosure, "")
	eventually(t, "b's PTY ends", func() bool { return clients() == 1 })
	if mode() != "manual" {
		t.Fatal("the window went back to latest with a viewer left")
	}
	a.ws.Close(websocket.StatusNormalClosure, "")
	eventually(t, "a's PTY ends", func() bool { return clients() == 0 && !f.srv.TerminalViewers("sh-t1") })
	eventually(t, "the window fits its clients again", func() bool { return mode() == "latest" })
}

// TestTerminalEnds: an open terminal ends, with its PTY, when the daemon stops and when its session ends (an archive
// kills it).
func TestTerminalEnds(t *testing.T) {
	f, ts, tc := termFixture(t, "")
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	f.srv.StartTerminals(ctx)
	shellSession(t, tc, "sh-t1")
	shellSession(t, tc, "sh-t2")
	clients := func() int { return len(strings.Fields(tmuxSays(tc, "list-clients", "-F", "#{client_pid}"))) }
	a := openTerminal(t, ts, "sh-t1", "")
	if got := a.next(t); got != [2]int{termCols, termRows} {
		t.Fatalf("default size %v", got)
	}
	b := openTerminal(t, ts, "sh-t2", "")
	b.next(t)
	eventually(t, "two attaches", func() bool { return clients() == 2 })

	tc.Run(context.Background(), nil, "kill-session", "-t", "=sh-t2")
	eventually(t, "the killed session's viewer ends", func() bool { return !f.srv.TerminalViewers("sh-t2") })
	b.closes(t)

	// The daemon's stop, as serve runs it: the context ends, then the stop waits for every terminal handler. A socket
	// asked for in between opens nothing.
	stop()
	if got, line := upgrades(t, ts, "/api/shells/sh-t1/tty", map[string]string{"X-Stam-Test-Human": humanKey}); got {
		t.Errorf("a terminal opened after the lifecycle ended: %q", line)
	}
	wait, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	must(t, f.srv.WaitTerminals(wait))
	if f.srv.TerminalViewers("sh-t1") {
		t.Error("a viewer is left after the stop")
	}
	a.closes(t)
	eventually(t, "the daemon's stop ends the PTY", func() bool { return clients() == 0 })
	if !tc.HasSession(context.Background(), "sh-t1") {
		t.Error("the daemon's stop ended the terminal's session: it should survive a restart")
	}
	if got, line := upgrades(t, ts, "/api/shells/sh-t1/tty", map[string]string{"X-Stam-Test-Human": humanKey}); got {
		t.Errorf("a terminal opened after the stop began: %q", line)
	}
}

// TestTerminalStuckWrite: a write to a PTY nobody reads doesn't hold the stop: the PTY is closed on the stop, which
// ends the write.
func TestTerminalStuckWrite(t *testing.T) {
	f, ts, tc := termFixture(t, "")
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	f.srv.StartTerminals(ctx)
	shellSession(t, tc, "sh-t1")
	stuck := make(chan struct{})
	old := ptyWrite
	ptyWrite = func(v *termView, b []byte) (int, error) {
		close(stuck)
		<-v.closed
		return 0, os.ErrClosed
	}
	t.Cleanup(func() { ptyWrite = old })
	a := openTerminal(t, ts, "sh-t1", "")
	a.next(t)
	must(t, a.ws.Write(context.Background(), websocket.MessageText, []byte("x")))
	<-stuck
	stop()
	wait, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := f.srv.WaitTerminals(wait); err != nil {
		t.Fatalf("the stop waited on a stuck write: %v", err)
	}
}

// TestTerminalStuckPty: a real PTY whose attach never reads (raw mode, then stopped), fed more than the PTY holds, so
// the handler's write is stuck in the kernel: the stop still ends the handler, since closing the PTY ends the write.
func TestTerminalStuckPty(t *testing.T) {
	old := termHangupWait
	termHangupWait = 50 * time.Millisecond
	t.Cleanup(func() { termHangupWait = old })
	oldCmd, oldWrite, oldBlocked := attachCommand, ptyWrite, ptyBlocked
	// The child says when raw mode is on (canonical mode would drop input instead of blocking the writer), then stops.
	child := make(chan *exec.Cmd, 1)
	attachCommand = func(string, []string) *exec.Cmd {
		cmd := exec.Command("sh", "-c", "stty raw -echo; printf 'RAW-%s\\n' ready; kill -STOP $$; exec sleep 100")
		child <- cmd
		return cmd
	}
	blocked := make(chan struct{}, 1)
	ptyBlocked = func(*termView) {
		select {
		case blocked <- struct{}{}:
		default:
		}
	}
	var returned atomic.Bool
	ptyWrite = func(v *termView, b []byte) (int, error) {
		n, err := oldWrite(v, b)
		returned.Store(true)
		return n, err
	}
	t.Cleanup(func() { attachCommand, ptyWrite, ptyBlocked = oldCmd, oldWrite, oldBlocked })
	f, ts, tc := termFixture(t, "")
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	f.srv.StartTerminals(ctx)
	shellSession(t, tc, "sh-t1")
	a := openTerminal(t, ts, "sh-t1", "")
	cmd := <-child
	a.until(t, "RAW-ready")
	stat := filepath.Join("/proc", strconv.Itoa(cmd.Process.Pid), "stat")
	eventually(t, "the attach stops", func() bool {
		b, err := os.ReadFile(stat)
		// The state follows the command's name in parentheses: T is stopped.
		return err == nil && strings.Contains(string(b), ") T ")
	})
	must(t, a.ws.Write(context.Background(), websocket.MessageBinary, bytes.Repeat([]byte("a"), 1<<20)))
	// 1 MiB can't go into a PTY nobody reads: the write fills it and waits for room until the stop closes the PTY.
	select {
	case <-blocked:
	case <-time.After(10 * time.Second):
		t.Fatalf("the write to a PTY nobody reads never waited for room (returned: %v): is the PTY non-blocking?", returned.Load())
	}
	if returned.Load() {
		t.Fatal("the write to a PTY nobody reads returned: it never blocked")
	}
	stop()
	wait, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := f.srv.WaitTerminals(wait); err != nil {
		t.Fatalf("the stop waited on the handler (write still pending: %v): %v", !returned.Load(), err)
	}
	if !returned.Load() {
		t.Fatal("the handler ended with its write still pending")
	}
}

// rawTerminal opens a terminal socket on sh-t1 from a raw client that reads frames but never answers a close; frame
// reads the server's next frame and returns its opcode.
func rawTerminal(t *testing.T, ts *httptest.Server) (conn net.Conn, frame func() byte) {
	t.Helper()
	host := strings.TrimPrefix(ts.URL, "http://")
	conn, err := net.Dial("tcp", host)
	must(t, err)
	t.Cleanup(func() { conn.Close() })
	_, err = conn.Write([]byte("GET /api/shells/sh-t1/tty HTTP/1.1\r\nHost: " + host + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nX-Stam-Test-Human: " + humanKey + "\r\n\r\n"))
	must(t, err)
	rd := bufio.NewReader(conn)
	for {
		line, err := rd.ReadString('\n')
		must(t, err)
		if line == "\r\n" {
			break
		}
	}
	must(t, conn.SetReadDeadline(time.Now().Add(10*time.Second)))
	return conn, func() byte {
		t.Helper()
		h := make([]byte, 2)
		_, err := io.ReadFull(rd, h)
		must(t, err)
		n := int(h[1] & 0x7f)
		switch n {
		case 126:
			ext := make([]byte, 2)
			_, err = io.ReadFull(rd, ext)
			n = int(ext[0])<<8 | int(ext[1])
		case 127:
			ext := make([]byte, 8)
			_, err = io.ReadFull(rd, ext)
			n = int(ext[6])<<8 | int(ext[7])
		}
		must(t, err)
		_, err = io.CopyN(io.Discard, rd, int64(n))
		must(t, err)
		return h[0] & 0x0f
	}
}

// TestTerminalCloseUnanswered: a handler that ends closes its socket with the handshake, after a failed PTY write or a
// failed start; a client that never answers the close frame doesn't hold the stop, which drops the socket at once.
func TestTerminalCloseUnanswered(t *testing.T) {
	for _, c := range []struct {
		name string
		// attach is the attach command's binary and arguments.
		attach []string
		// input is whether the client sends input to end the handler (the PTY write refuses it).
		input bool
	}{
		// A silent attach: no output is being written when the handler ends (a write cut short drops the socket
		// without a close frame).
		{"a failed write", []string{"sleep", "100"}, true},
		// The PTY never starts: the handler closes the socket at once.
		{"a failed start", []string{filepath.Join(t.TempDir(), "no-such-binary")}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			old, oldCmd := ptyWrite, attachCommand
			ptyWrite = func(*termView, []byte) (int, error) { return 0, os.ErrClosed }
			attachCommand = func(string, []string) *exec.Cmd { return exec.Command(c.attach[0], c.attach[1:]...) }
			t.Cleanup(func() { ptyWrite, attachCommand = old, oldCmd })
			f, ts, tc := termFixture(t, "")
			ctx, stop := context.WithCancel(context.Background())
			defer stop()
			f.srv.StartTerminals(ctx)
			shellSession(t, tc, "sh-t1")
			conn, frame := rawTerminal(t, ts)
			if c.input {
				// The size frame first, so no write is under way when the handler ends (one cut short drops the
				// socket with no close frame).
				frame()
				// One masked text frame of input, which the PTY write refuses.
				mask := []byte{1, 2, 3, 4}
				_, err := conn.Write([]byte{0x81, 0x80 | 1, mask[0], mask[1], mask[2], mask[3], 'x' ^ mask[0]})
				must(t, err)
			}
			// The server's close frame: the handler is in the handshake, waiting for an answer.
			if op := frame(); op != 0x8 {
				t.Fatalf("frame %#x, not a close", op)
			}
			stop()
			wait, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := f.srv.WaitTerminals(wait); err != nil {
				t.Fatalf("the stop waited on an unanswered close: %v", err)
			}
		})
	}
}

// TestTerminalRelayStop: the stop ends a relay still dialling a peer that never answers, well inside the dial's own
// 10 s timeout.
func TestTerminalRelayStop(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	t.Cleanup(func() { ln.Close() })
	accepted := make(chan net.Conn, 1)
	go func() {
		if c, err := ln.Accept(); err == nil {
			accepted <- c
		}
	}()
	f, ts, _ := termFixtureAt(t, "http://"+ln.Addr().String(), "")
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	f.srv.StartTerminals(ctx)
	// The browser's upgrade, off the test's goroutine: it waits on the relay.
	conn, err := net.Dial("tcp", strings.TrimPrefix(ts.URL, "http://"))
	must(t, err)
	t.Cleanup(func() { conn.Close() })
	_, err = conn.Write([]byte("GET /api/shells/sh-far/tty?machine=far HTTP/1.1\r\nHost: " + strings.TrimPrefix(ts.URL, "http://") +
		"\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
		"X-Stam-Test-Human: " + humanKey + "\r\n\r\n"))
	must(t, err)
	peer := <-accepted
	t.Cleanup(func() { peer.Close() })
	stop()
	wait, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := f.srv.WaitTerminals(wait); err != nil {
		t.Fatalf("the stop waited on a relay's dial: %v", err)
	}
}

// TestTerminalSenderJoined: a viewer's size sender has ended when the stop's wait returns.
func TestTerminalSenderJoined(t *testing.T) {
	var ended atomic.Bool
	entered := make(chan struct{}, 1)
	old := sendFrame
	sendFrame = func(ctx context.Context, v *termView, b []byte) error {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-ctx.Done()
		// The sender's last step takes a while: the wait must still see it end.
		time.Sleep(200 * time.Millisecond)
		ended.Store(true)
		return ctx.Err()
	}
	t.Cleanup(func() { sendFrame = old })
	f, ts, tc := termFixture(t, "")
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	f.srv.StartTerminals(ctx)
	shellSession(t, tc, "sh-t1")
	openTerminal(t, ts, "sh-t1", "")
	<-entered
	stop()
	wait, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	must(t, f.srv.WaitTerminals(wait))
	if !ended.Load() {
		t.Error("a size sender outlived the stop's wait")
	}
}

// TestReapStopped: an attach that can't take the SIGHUP (stopped) is continued and terminated, so it can't hold its
// handler.
func TestReapStopped(t *testing.T) {
	old := termHangupWait
	termHangupWait = 50 * time.Millisecond
	t.Cleanup(func() { termHangupWait = old })
	cmd := exec.Command("sleep", "100")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	must(t, cmd.Start())
	must(t, syscall.Kill(cmd.Process.Pid, syscall.SIGSTOP))
	done := make(chan struct{})
	go func() {
		reap(cmd)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("a stopped attach held reap")
	}
}

// TestTerminalSlowViewer: a viewer whose socket takes no size frame holds up no other session: another opens, is
// seen, and leaves.
func TestTerminalSlowViewer(t *testing.T) {
	f, ts, tc := termFixture(t, "")
	shellSession(t, tc, "sh-slow")
	shellSession(t, tc, "sh-fast")
	release := make(chan struct{})
	old := sendFrame
	sendFrame = func(ctx context.Context, v *termView, b []byte) error {
		if v.id == "sh-slow" {
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return old(ctx, v, b)
	}
	t.Cleanup(func() { sendFrame = old })
	// The handlers end before the seam is put back.
	ctx, stop := context.WithCancel(context.Background())
	f.srv.StartTerminals(ctx)
	t.Cleanup(func() {
		close(release)
		stop()
		wait, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		must(t, f.srv.WaitTerminals(wait))
	})
	openTerminal(t, ts, "sh-slow", "?cols=90&rows=20")
	eventually(t, "the slow viewer attached", func() bool { return f.srv.TerminalViewers("sh-slow") })
	// The other session's attach, first frame and leave, off the test's goroutine so a hold-up fails rather than hangs.
	done := make(chan string, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		u := "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/shells/sh-fast/tty"
		ws, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: http.Header{"X-Stam-Test-Human": {humanKey}}})
		if err != nil {
			done <- err.Error()
			return
		}
		defer ws.CloseNow()
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				done <- err.Error()
				return
			}
			if len(data) > 0 && data[0] == 0 {
				break
			}
		}
		if !f.srv.TerminalViewers("sh-fast") {
			done <- "not viewed"
			return
		}
		ws.Close(websocket.StatusNormalClosure, "")
		done <- ""
	}()
	select {
	case msg := <-done:
		if msg != "" {
			t.Fatal(msg)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a viewer taking no frames held up another session's attach")
	}
	eventually(t, "the other session's viewer left", func() bool { return !f.srv.TerminalViewers("sh-fast") })
}

// closes reads the viewer until its socket closes, failing if it stays open.
func (v *viewer) closes(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		if _, _, err := v.ws.Read(ctx); err != nil {
			if ctx.Err() != nil {
				t.Fatal("the socket stayed open")
			}
			return
		}
	}
}

// TestUTF8Chunk: a PTY's output goes out as whole characters, a cut one kept for the next read and a bad byte as
// U+FFFD, as Node's decoder gives them.
func TestUTF8Chunk(t *testing.T) {
	euro := "\u20ac" // 3 bytes
	for _, c := range []struct{ in, out, rest string }{
		{"plain", "plain", ""},
		{"a" + euro, "a" + euro, ""},
		{"a" + euro[:1], "a", euro[:1]},
		{"a" + euro[:2], "a", euro[:2]},
		{"a\U0001F600"[:4], "a", "\U0001F600"[:3]},
		{"a\xffb", "a\uFFFDb", ""},
		{"\xff" + euro[:2], "\uFFFD", euro[:2]},
	} {
		out, rest := utf8Chunk([]byte(c.in))
		if string(out) != c.out || string(rest) != c.rest {
			t.Errorf("%q: %q + %q", c.in, out, rest)
		}
	}
	// A cut character finishes with the next read.
	out, rest := utf8Chunk([]byte("x" + euro[:1]))
	out2, _ := utf8Chunk(append(rest, euro[1:]...))
	if string(out)+string(out2) != "x"+euro {
		t.Errorf("joined %q", string(out)+string(out2))
	}
}

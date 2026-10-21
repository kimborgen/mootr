package peers

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsfmt"
)

const (
	sharedTok = "peer-shared-secret-token"
	peerTok   = "peer-daemon-secret-token"
)

// seenCall is what a fake peer's daemon saw of a call.
type seenCall struct {
	method, path, body string
	h                  http.Header
}

type fakePeer struct {
	*httptest.Server
	mu    sync.Mutex
	calls []seenCall
}

func newPeer(t *testing.T, h func(w http.ResponseWriter, r *http.Request)) *fakePeer {
	t.Helper()
	f := &fakePeer{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.calls = append(f.calls, seenCall{r.Method, r.URL.RequestURI(), string(b), r.Header.Clone()})
		f.mu.Unlock()
		h(w, r)
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakePeer) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakePeer) last() seenCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[len(f.calls)-1]
}

func newClient(t *testing.T, peers ...config.Peer) *Client {
	t.Helper()
	return New(Options{
		Settings: func() config.Settings { return config.Settings{Peers: peers} },
		Machine:  "here",
		Getenv: func(k string) string {
			return map[string]string{"STAM_PEER_PROBE_MS": "150", "STAM_PEER_CHECK_MS": "100"}[k]
		},
	})
}

func peerOf(f *fakePeer, name string) config.Peer {
	return config.Peer{Name: name, URL: f.URL + "/", Token: sharedTok, PeerToken: peerTok}
}

func ok(w http.ResponseWriter, body string) {
	w.Header().Set("content-type", "application/json")
	io.WriteString(w, body)
}

// A call carries the peer token (else the shared one), x-stam-local, x-stam-human only for the relayed human, and the agent
// it acts for; its body is JSON and an empty reply is {}.
func TestCallHeaders(t *testing.T) {
	f := newPeer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/empty" {
			return
		}
		ok(w, `{"ok":true}`)
	})
	p := peerOf(f, "far")
	c := newClient(t, p)
	ctx := context.Background()

	r, err := c.Call(ctx, p, "POST", "/api/x?y=1", map[string]any{"a": 1}, DefaultTimeout, false, nil)
	if err != nil || r.Status != 200 || r.Data.Text("ok") != "" || jsfmt.Compact(r.Data) != `{"ok":true}` {
		t.Fatalf("call = %+v, %v", r, err)
	}
	got := f.last()
	if got.method != "POST" || got.path != "/api/x?y=1" || got.body != `{"a":1}` {
		t.Errorf("the peer saw %+v", got)
	}
	if got.h.Get("authorization") != "Bearer "+peerTok || got.h.Get("x-stam-local") != "1" || got.h.Get("content-type") != "application/json" {
		t.Errorf("headers %v", got.h)
	}
	for _, h := range []string{"x-stam-human", "x-stam-agent", "x-stam-agent-boss", "x-stam-agent-assistant", "x-stam-branch-scope"} {
		if got.h.Get(h) != "" {
			t.Errorf("a daemon's own call carries %s", h)
		}
	}

	if _, err := c.Call(ctx, p, "GET", "/api/x", nil, DefaultTimeout, true, &Via{Agent: "a1", Boss: true, Assistant: true, Scope: "tree"}); err != nil {
		t.Fatal(err)
	}
	got = f.last()
	if got.body != "" || got.h.Get("x-stam-human") != "1" || got.h.Get("x-stam-agent") != "a1" || got.h.Get("x-stam-agent-boss") != "1" ||
		got.h.Get("x-stam-agent-assistant") != "1" || got.h.Get("x-stam-branch-scope") != "tree" {
		t.Errorf("a relayed call: %+v", got)
	}
	if _, err := c.Call(ctx, p, "GET", "/api/x", nil, DefaultTimeout, false, &Via{Agent: "a2"}); err != nil {
		t.Fatal(err)
	}
	if got = f.last(); got.h.Get("x-stam-agent") != "a2" || got.h.Get("x-stam-agent-boss") != "" || got.h.Get("x-stam-agent-assistant") != "" || got.h.Get("x-stam-branch-scope") != "" {
		t.Errorf("a plain agent's call: %v", got.h)
	}

	// With no peer token the shared one is the bearer.
	q := config.Peer{Name: "far", URL: f.URL, Token: sharedTok}
	if _, err := c.Call(ctx, q, "GET", "/api/x", nil, DefaultTimeout, false, nil); err != nil || f.last().h.Get("authorization") != "Bearer "+sharedTok {
		t.Errorf("fallback bearer: %v %v", err, f.last().h)
	}
	r, err = c.Call(ctx, p, "GET", "/api/empty", nil, DefaultTimeout, false, nil)
	if err != nil || jsfmt.Compact(r.Data) != "{}" {
		t.Errorf("an empty reply: %+v %v", r, err)
	}
}

// A call that cannot connect or runs past its deadline marks the peer down; a call to a down peer probes it first and
// answers at once while it is down; any answer marks it up.
func TestDownMarking(t *testing.T) {
	var slow atomic.Bool
	var healthy atomic.Bool
	healthy.Store(true)
	f := newPeer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			if !healthy.Load() {
				time.Sleep(400 * time.Millisecond)
			}
			ok(w, `{"release":null}`)
			return
		}
		if slow.Load() {
			time.Sleep(300 * time.Millisecond)
		}
		ok(w, `[]`)
	})
	p := peerOf(f, "far")
	c := newClient(t, p)
	ctx := context.Background()

	slow.Store(true)
	start := time.Now()
	if _, err := c.Call(ctx, p, "GET", "/api/x", nil, 60*time.Millisecond, false, nil); err == nil {
		t.Fatal("a call past its deadline succeeded")
	}
	if time.Since(start) > 250*time.Millisecond {
		t.Errorf("the deadline was not kept: %v", time.Since(start))
	}
	if c.Up("far") {
		t.Fatal("the peer was not marked down")
	}
	// Down and the probe finds it slow: the call answers at once, unreachable.
	healthy.Store(false)
	start = time.Now()
	if _, err := c.Call(ctx, p, "GET", "/api/x", nil, DefaultTimeout, false, nil); err == nil || !strings.Contains(err.Error(), "far is unreachable") {
		t.Fatalf("a call to a down peer: %v", err)
	}
	if time.Since(start) > 300*time.Millisecond {
		t.Errorf("the probe was not the short check: %v", time.Since(start))
	}
	// A list skips it without a call.
	n := f.count()
	if rows, bad := c.FanOutReport(ctx, "/api/x", nil); len(rows) != 0 || !bad {
		t.Errorf("fan-out over a down peer: %v %v", rows, bad)
	}
	if f.count() != n {
		t.Error("a list called a down peer before its retry time")
	}
	// It comes back: the probe finds it, the call goes through and marks it up.
	healthy.Store(true)
	slow.Store(false)
	if _, err := c.Call(ctx, p, "GET", "/api/x", nil, DefaultTimeout, false, nil); err != nil {
		t.Fatalf("after it came back: %v", err)
	}
	if !c.Up("far") {
		t.Error("the peer was not marked up")
	}
}

// After the retry time a list starts the background probe, and the peer returns to the lists once it answers.
func TestFanOut(t *testing.T) {
	a := newPeer(t, func(w http.ResponseWriter, r *http.Request) { ok(w, `[{"id":"a1"},{"id":"a2"}]`) })
	b := newPeer(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500); ok(w, `{"error":"boom"}`) })
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	c := newClient(t, peerOf(a, "a"), peerOf(b, "b"), config.Peer{Name: "dead", URL: deadURL, Token: sharedTok})
	rows, bad := c.FanOutReport(context.Background(), "/api/agents", &Via{Agent: "x"})
	if len(rows) != 2 || rows[0].Text("id") != "a1" || !bad {
		t.Errorf("rows %v unreachable %v", rows, bad)
	}
	if a.last().h.Get("x-stam-agent") != "x" {
		t.Error("a fan-out drops the agent it acts for")
	}
	if c.Up("dead") || !c.Up("a") || !c.Up("b") {
		t.Errorf("down-marking: dead up %v, a up %v, b up %v (an answer of any status is up)", c.Up("dead"), c.Up("a"), c.Up("b"))
	}

	// The dead peer is skipped until its retry time, then probed in the background.
	time.Sleep(200 * time.Millisecond)
	if !c.skipDown(config.Peer{Name: "dead", URL: deadURL}) {
		t.Error("a down peer is not skipped")
	}
}

// The deadline of Raw covers the headers, not the body that follows.
func TestRawKeepsTheBodyPastTheCheck(t *testing.T) {
	f := newPeer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		time.Sleep(450 * time.Millisecond)
		io.WriteString(w, "late bytes")
	})
	p := peerOf(f, "far")
	c := newClient(t, p)
	res := c.Raw(context.Background(), p, "/api/files/x", map[string]string{"range": "bytes=0-"}, true)
	if res == nil {
		t.Fatal("no response")
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil || string(b) != "late bytes" {
		t.Errorf("body %q, %v", b, err)
	}
	got := f.last()
	if got.h.Get("range") != "bytes=0-" || got.h.Get("x-stam-human") != "1" || got.h.Get("accept-encoding") != "identity" || got.h.Get("authorization") != "Bearer "+peerTok {
		t.Errorf("headers %v", got.h)
	}
	// A peer that does not answer in time is nil, and down.
	slow := newPeer(t, func(w http.ResponseWriter, r *http.Request) { time.Sleep(500 * time.Millisecond); ok(w, "{}") })
	q := peerOf(slow, "slow")
	c2 := newClient(t, q)
	if r := c2.Raw(context.Background(), q, "/api/x", nil, false); r != nil || c2.Up("slow") {
		t.Errorf("a peer past the check: %v up %v", r, c2.Up("slow"))
	}
}

// A peer's token does not reach an error, even when the transport quotes it.
func TestTokensStayOutOfErrors(t *testing.T) {
	p := config.Peer{Name: "far", URL: "http://127.0.0.1:1", Token: sharedTok, PeerToken: peerTok}
	c := newClient(t, p)
	_, err := c.Call(context.Background(), p, "GET", "/api/x", nil, time.Second, false, nil)
	if err == nil {
		t.Fatal("no error")
	}
	for _, tok := range []string{sharedTok, peerTok} {
		if strings.Contains(err.Error(), tok) {
			t.Errorf("the error quotes a token: %v", err)
		}
	}
	e := scrub(p, io.ErrUnexpectedEOF)
	if e != io.ErrUnexpectedEOF {
		t.Error("an error without a token changed")
	}
	if got := scrub(p, &quoting{"echo " + peerTok + " and " + sharedTok}).Error(); strings.Contains(got, peerTok) || strings.Contains(got, sharedTok) || !strings.Contains(got, "[redacted]") {
		t.Errorf("scrub = %q", got)
	}
	if s := p.Token.String(); strings.Contains(s, sharedTok) {
		t.Error("a Secret renders")
	}
}

type quoting struct{ s string }

func (q *quoting) Error() string { return q.s }

// The agent a name means: an exact id wins, a live agent beats one that is not, and two that still match are an error.
func TestPick(t *testing.T) {
	a := func(id, name, machine, lc string) Hit {
		return Hit{Agent: Agent{ID: id, Name: name, Machine: machine, Lifecycle: lc}}
	}
	for _, tc := range []struct {
		what string
		ref  string
		hits []Hit
		want string
		err  string
	}{
		{"none", "x", nil, "", ""},
		{"one", "x", []Hit{a("a1", "x", "m", "active")}, "a1", ""},
		{"an exact id beats a live name", "a1", []Hit{a("a1", "old", "m", "archived"), a("a2", "a1", "m", "active")}, "a1", ""},
		{"a live name beats an archived one", "x", []Hit{a("a1", "x", "m", "archived"), a("a2", "x", "n", "active")}, "a2", ""},
		{"shut down is not live", "x", []Hit{a("a1", "x", "m", "shut_down"), a("a2", "x", "n", "paused")}, "a2", ""},
		{"two live", "x", []Hit{a("a1", "x", "m", "active"), a("a2", "x", "n", "paused")}, "", "x matches more than one agent: x (a1, m, active), x (a2, n, paused)"},
		{"all archived", "x", []Hit{a("a1", "x", "m", "archived"), a("a2", "x", "n", "archived")}, "", "x matches more than one agent"},
	} {
		got, err := Pick(tc.ref, tc.hits)
		if tc.err != "" {
			var amb *AmbiguousError
			if err == nil || !strings.Contains(err.Error(), tc.err) || !asAmbiguous(err, &amb) {
				t.Errorf("%s: %v", tc.what, err)
			}
			continue
		}
		if err != nil || (tc.want == "") != (got == nil) || (got != nil && got.Agent.ID != tc.want) {
			t.Errorf("%s: %+v %v", tc.what, got, err)
		}
	}
}

func asAmbiguous(err error, out **AmbiguousError) bool {
	e, ok := err.(*AmbiguousError)
	*out = e
	return ok
}

type store struct {
	twin     map[string]db.PeerAgentRef
	remember []db.PeerAgentSeen
}

func (s *store) PeerAgentByID(_ context.Context, id string) (db.PeerAgentRef, bool, error) {
	t, ok := s.twin[id]
	return t, ok, nil
}

func (s *store) RememberPeerAgent(_ context.Context, a db.PeerAgentSeen) error {
	s.remember = append(s.remember, a)
	return nil
}

// Locate asks every peer for the exact name, remembers only another machine's agents, and tells absent from unreachable.
func TestLocate(t *testing.T) {
	has := newPeer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agents/worker":
			ok(w, `{"id":"w1","name":"worker","machine":"far","lifecycle":"active","parent_id":"boss","activity":"working"}`)
		case "/api/agents/echo":
			ok(w, `{"id":"e1","name":"echo","machine":"here","lifecycle":"active"}`)
		case "/api/agents/a b":
			ok(w, `{"id":"s1","name":"a b","machine":"far"}`)
		default:
			w.WriteHeader(404)
			ok(w, `{"error":"no agent"}`)
		}
	})
	none := newPeer(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404); ok(w, `{"error":"no agent"}`) })
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	st := &store{}
	c := newClient(t, peerOf(has, "far"), peerOf(none, "other"))
	ctx := context.Background()

	hit, state, err := c.Locate(ctx, st, "worker")
	if err != nil || state != Found || hit.Peer.Name != "far" || hit.Agent.ID != "w1" {
		t.Fatalf("worker: %+v %v %v", hit, state, err)
	}
	if len(st.remember) != 1 || st.remember[0].ID != "w1" || st.remember[0].ParentID != "boss" || st.remember[0].Activity != "working" {
		t.Errorf("remembered %+v", st.remember)
	}
	if _, state, _ := c.Locate(ctx, st, "nobody"); state != Absent {
		t.Errorf("nobody: %v", state)
	}
	if _, state, _ := c.Locate(ctx, st, "echo"); state != Found || len(st.remember) != 1 {
		t.Errorf("an echo of this machine's own agent is stored as a twin: %v %+v", state, st.remember)
	}
	if hit, _, _ := c.Locate(ctx, st, "a b"); hit == nil || hit.Agent.ID != "s1" {
		t.Errorf("a name with a space is encoded as encodeURIComponent does: %+v", hit)
	}
	c2 := newClient(t, peerOf(none, "other"), config.Peer{Name: "dead", URL: deadURL, Token: sharedTok})
	if _, state, _ := c2.Locate(ctx, st, "worker"); state != Unreachable {
		t.Errorf("a peer that did not answer: %v", state)
	}
	if m := c.MachineOf(ctx, "worker"); m != "far" {
		t.Errorf("machine of worker = %q", m)
	}
	if m := c.MachineOf(ctx, "echo"); m != "" {
		t.Errorf("machine of this machine's own agent = %q", m)
	}
	if got := st.twin; got != nil {
		t.Error("twin map touched")
	}
}

func TestRefuseAmbiguousID(t *testing.T) {
	st := &store{twin: map[string]db.PeerAgentRef{"a1": {ID: "a1", Name: "there", Machine: "far"}, "a2": {ID: "a2", Name: "me", Machine: "here"}}}
	ctx := context.Background()
	err := RefuseAmbiguousID(ctx, st, "a1", "here-agent", "here")
	if err == nil || err.Error() != "a1 matches an agent on more than one machine: here-agent (here) and there (far); address it by name, not by id" {
		t.Errorf("twin on another machine: %v", err)
	}
	if err := RefuseAmbiguousID(ctx, st, "a2", "me", "here"); err != nil {
		t.Errorf("a row for this very machine is not a twin: %v", err)
	}
	if err := RefuseAmbiguousID(ctx, st, "a3", "x", "here"); err != nil {
		t.Errorf("no twin: %v", err)
	}
}

func TestEncodeURIComponent(t *testing.T) {
	for in, want := range map[string]string{"abc-_.!~*'()": "abc-_.!~*'()", "a b/c?d&e": "a%20b%2Fc%3Fd%26e", "é": "%C3%A9", "@x:y": "%40x%3Ay"} {
		if got := EncodeURIComponent(in); got != want {
			t.Errorf("%q = %q, want %q", in, got, want)
		}
	}
}

// EnsureUp runs the start command once for callers that arrive together, and polls the health until the peer answers;
// EnsureCurrent deploys when the release differs, and warns where TS does.
func TestEnsureUpAndCurrent(t *testing.T) {
	home := t.TempDir()
	var up atomic.Bool
	var release atomic.Value
	release.Store("old")
	f := newPeer(t, func(w http.ResponseWriter, r *http.Request) {
		if !up.Load() {
			hj, _ := w.(http.Hijacker)
			c, _, _ := hj.Hijack()
			c.Close()
			return
		}
		ok(w, `{"release":"`+release.Load().(string)+`"}`)
	})
	marker := home + "/started"
	p := peerOf(f, "far")
	p.Start = "echo run >> " + marker + "; sleep 0.3"
	p.Deploy = "echo \"$STAM_PEER $STAM_RELEASE\" > " + home + "/deployed"
	c := New(Options{
		Settings: func() config.Settings { return config.Settings{Peers: []config.Peer{p}} },
		Machine:  "here", Home: home, Release: "new",
		Getenv: func(k string) string {
			return map[string]string{"STAM_PEER_START_TIMEOUT_MS": "8000", "STAM_PEER_DEPLOY_TIMEOUT_MS": "8000"}[k]
		},
	})
	go func() { time.Sleep(500 * time.Millisecond); up.Store(true) }()
	var wg sync.WaitGroup
	errs := make([]error, 3)
	for i := range errs {
		wg.Add(1)
		go func() { defer wg.Done(); errs[i] = c.EnsureUp(p) }()
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			t.Errorf("EnsureUp: %v", e)
		}
	}
	if b := readFile(t, marker); strings.Count(b, "run") != 1 {
		t.Errorf("the start command ran %q", b)
	}

	// On another release: the deploy command runs with STAM_RELEASE and STAM_PEER, and the peer is polled until it reports it.
	go func() { time.Sleep(300 * time.Millisecond); release.Store("new") }()
	if w := c.EnsureCurrent(p); w != "" {
		t.Errorf("deploy warning %q", w)
	}
	if b := readFile(t, home+"/deployed"); strings.TrimSpace(b) != "far new" {
		t.Errorf("deploy env %q", b)
	}
	if w := c.EnsureCurrent(p); w != "" {
		t.Errorf("already current: %q", w)
	}

	// A hold, a staged merge, and the watcher's own release stop the deploy with a warning.
	release.Store("old")
	writeFile(t, home+"/deploy-hold", "")
	if w := c.EnsureCurrent(p); w != "far isn't on new: a deploy hold is in place, so far keeps its release" {
		t.Errorf("hold: %q", w)
	}
	writeFile(t, home+"/deploy-staged.json", "{}")
	if w := c.EnsureCurrent(p); !strings.Contains(w, "a staged merge waits for its hold") {
		t.Errorf("staged: %q", w)
	}
	removeFile(t, home+"/deploy-staged.json")
	removeFile(t, home+"/deploy-hold")
	writeFile(t, home+"/deploy-storage-sha", "ffff000000\n")
	if w := c.EnsureCurrent(p); !strings.Contains(w, "the deploy watcher owns far's release") {
		t.Errorf("watcher: %q", w)
	}
}

// A start command that fails, or that is missing, is an error that names why and quotes its last lines.
func TestEnsureUpFailures(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	u := dead.URL
	dead.Close()
	c := New(Options{Settings: func() config.Settings { return config.Settings{} }, Machine: "here", Getenv: func(k string) string { return map[string]string{"STAM_PEER_START_TIMEOUT_MS": "3000"}[k] }})
	if err := c.EnsureUp(config.Peer{Name: "x", URL: u}); err == nil || err.Error() != "x is unreachable and didn't start: no start command in settings.json (peers[].start)" {
		t.Errorf("no start: %v", err)
	}
	err := c.EnsureUp(config.Peer{Name: "x", URL: u, Start: "echo broke; exit 3"})
	if err == nil || err.Error() != "x is unreachable and didn't start: its start command exited with 3\nbroke" {
		t.Errorf("exit 3: %v", err)
	}
	if err := c.EnsureUp(config.Peer{Name: "x", URL: u, Start: "sleep 5"}); err == nil || !strings.Contains(err.Error(), "its start command ran past the deadline") {
		t.Errorf("late: %v", err)
	}
	if err := c.EnsureUp(config.Peer{Name: "x", URL: u, Start: "true"}); err == nil || !strings.Contains(err.Error(), "didn't answer /api/health before the deadline") {
		t.Errorf("silent: %v", err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func writeFile(t *testing.T, path, s string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

func removeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
}

// Stream pipes an open GET through as it arrives, with the agent headers and no content-type of its own, and stops when the
// browser goes.
func TestStream(t *testing.T) {
	gone := make(chan struct{})
	f := newPeer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(200)
		io.WriteString(w, "data: one\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(gone)
	})
	p := peerOf(f, "far")
	c := newClient(t, p)
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.Stream(r, p, "/api/agents/w1/view", w, &Via{Agent: "a1"})
	}))
	defer front.Close()
	res, err := http.Get(front.URL)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 11)
	if _, err := io.ReadFull(res.Body, buf); err != nil || string(buf) != "data: one\n\n" {
		t.Fatalf("first chunk %q, %v", buf, err)
	}
	if ct := res.Header.Get("content-type"); ct != "text/event-stream" || res.Header.Get("cache-control") != "no-cache" || res.Header.Get("x-accel-buffering") != "no" {
		t.Errorf("headers %v", res.Header)
	}
	got := f.last()
	if got.h.Get("x-stam-agent") != "a1" || got.h.Get("x-stam-local") != "1" || got.h.Get("authorization") != "Bearer "+peerTok || got.h.Get("content-type") != "" {
		t.Errorf("upstream headers %v", got.h)
	}
	res.Body.Close()
	select {
	case <-gone:
	case <-time.After(3 * time.Second):
		t.Error("the peer's stream stayed open after the browser left")
	}
}

// A command that leaves something running with its pipes, or that ignores SIGTERM, cannot hold the caller: Wait is bounded,
// and the group gets SIGKILL after the grace.
func TestRunCommandIsBounded(t *testing.T) {
	oldTerm, oldPipe := termGrace, pipeGrace
	termGrace, pipeGrace = 300*time.Millisecond, 300*time.Millisecond
	t.Cleanup(func() { termGrace, pipeGrace = oldTerm, oldPipe })
	dir := t.TempDir()
	stray := func(file string) {
		t.Helper()
		b, err := os.ReadFile(file)
		if err != nil {
			return
		}
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
			syscall.Kill(pid, syscall.SIGKILL)
		}
	}

	pidfile := dir + "/pid"
	t.Cleanup(func() { stray(pidfile) })
	start := time.Now()
	code, tail := runCommand("sleep 30 & echo $! > "+pidfile+"; echo hi", os.Environ(), time.Now().Add(10*time.Second))
	if code != 0 || len(tail) != 1 || tail[0] != "hi" || time.Since(start) > 3*time.Second {
		t.Errorf("a command that leaves a background process: code %d, tail %v, %v", code, tail, time.Since(start))
	}

	start = time.Now()
	code, tail = runCommand("trap '' TERM; echo going; sleep 30", os.Environ(), time.Now().Add(1500*time.Millisecond))
	if code != lateCode || time.Since(start) > 8*time.Second {
		t.Errorf("a command that ignores SIGTERM: code %d, %v", code, time.Since(start))
	}
	if len(tail) != 1 || tail[0] != "going" {
		t.Errorf("its tail %v", tail)
	}

	start = time.Now()
	if code, _ := runCommand("exit 7", os.Environ(), time.Now().Add(time.Minute)); code != 7 {
		t.Errorf("exit code %d", code)
	}
	if code, tail := runCommand("seq 1 30", os.Environ(), time.Now().Add(time.Minute)); code != 0 || len(tail) != 10 || tail[0] != "21" || tail[9] != "30" {
		t.Errorf("tail of 30 lines: %d %v", code, tail)
	}
	// A line longer than the scanner's buffer does not block the command.
	if code, _ := runCommand("head -c 3000000 /dev/zero | tr '\\0' x; echo done", os.Environ(), time.Now().Add(20*time.Second)); code != 0 {
		t.Errorf("a very long line: code %d", code)
	}
	if time.Since(start) > 15*time.Second {
		t.Errorf("slow: %v", time.Since(start))
	}
}

// A caller that gives up says nothing about the peer: it stays up. Its own deadline does mark it down.
func TestCancelledCallerDoesNotMarkDown(t *testing.T) {
	release := make(chan struct{})
	f := newPeer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			ok(w, "{}")
			return
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
		ok(w, "{}")
	})
	defer close(release)
	p := peerOf(f, "far")
	c := newClient(t, p)

	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(80 * time.Millisecond); cancel() }()
	if _, err := c.Call(ctx, p, "GET", "/api/slow", nil, DefaultTimeout, false, nil); err == nil {
		t.Fatal("a cancelled call succeeded")
	}
	if !c.Up("far") {
		t.Error("a cancelled caller marked the peer down")
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	go func() { time.Sleep(80 * time.Millisecond); cancel2() }()
	if r := c.Raw(ctx2, p, "/api/slow", nil, false); r != nil {
		t.Error("a cancelled raw call answered")
	}
	if !c.Up("far") {
		t.Error("a cancelled raw caller marked the peer down")
	}
	// Its own deadline is the peer's fault.
	if _, err := c.Call(context.Background(), p, "GET", "/api/slow", nil, 80*time.Millisecond, false, nil); err == nil || c.Up("far") {
		t.Errorf("a call past its own deadline: %v up %v", err, c.Up("far"))
	}
}

// A list over no peers is [], not null, and the via headers of a verdict relay ride along.
func TestEmptyFanOutAndReviewHeaders(t *testing.T) {
	c := newClient(t)
	rows, bad := c.FanOutReport(context.Background(), "/api/x", nil)
	if rows == nil || bad || jsfmt.Compact(jsfmt.ArrayValue(rows)) != "[]" {
		t.Errorf("rows %v bad %v", rows, bad)
	}
	h := http.Header{}
	(&Via{Agent: "a1", ReviewRole: "reviewer", OwnBranches: []string{"stam/<x>&y", "main"}}).headers(h)
	if h.Get("x-stam-review-role") != "reviewer" || h.Get("x-stam-own-branches") != `["stam/<x>&y","main"]` {
		t.Errorf("headers %v", h)
	}
	h = http.Header{}
	(&Via{Agent: "a1", ReviewRole: "other"}).headers(h)
	if h.Get("x-stam-review-role") != "other" || h.Get("x-stam-own-branches") != "" {
		t.Errorf("unknown branches: %v", h)
	}
	h = http.Header{}
	(&Via{Agent: "a1", OwnBranches: []string{"x"}}).headers(h)
	if h.Get("x-stam-review-role") != "" || h.Get("x-stam-own-branches") != "" {
		t.Errorf("branches without a role: %v", h)
	}
}

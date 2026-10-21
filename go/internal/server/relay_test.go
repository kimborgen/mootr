package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"stam/internal/db"
	"stam/internal/jsfmt"
)

// The relay of a request about an agent on another machine (relay.go). Two Go daemons run on their own homes and sockets:
// "here", which knows only achild, and "far", the seeded daemon with the rest, reached through here's settings.peers. A
// recording wrapper in front of far shows what here sent it.

type seenReq struct {
	method, path, query, body string
	header                    http.Header
}

// peerServer is a daemon on a socket that records the requests it gets; h answers them (a stub or a daemon).
type peerServer struct {
	ts   *httptest.Server
	mu   sync.Mutex
	reqs []seenReq
}

func newPeerServer(t *testing.T, h http.Handler) *peerServer {
	p := &peerServer{}
	p.ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(strings.NewReader(string(b)))
		p.mu.Lock()
		p.reqs = append(p.reqs, seenReq{r.Method, r.URL.Path, r.URL.RawQuery, string(b), r.Header.Clone()})
		p.mu.Unlock()
		h.ServeHTTP(w, r)
	}))
	t.Cleanup(p.ts.Close)
	return p
}

func (p *peerServer) seen() []seenReq {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]seenReq(nil), p.reqs...)
}

// last is the newest request that is not a health probe.
func (p *peerServer) last(t *testing.T) seenReq {
	t.Helper()
	rs := p.seen()
	for i := len(rs) - 1; i >= 0; i-- {
		if rs[i].path != "/api/health" {
			return rs[i]
		}
	}
	t.Fatal("the peer got no request")
	return seenReq{}
}

// relayFixture is the daemon "here" with one agent (achild) and a peer called "far" at url.
func relayFixture(t *testing.T, url string, settings string, env map[string]string) *fixture {
	t.Helper()
	vars := map[string]string{"STAM_MACHINE": "here", "STAM_TEST_HUMAN_KEY": humanKey}
	for k, v := range env {
		vars[k] = v
	}
	f := newFixture(t, vars)
	f.sql("PRAGMA foreign_keys = OFF")
	f.sql("DELETE FROM agents WHERE id != 'achild'")
	f.sql("UPDATE agents SET parent_id = NULL WHERE id = 'achild'")
	peer := `{"name":"far","url":"` + url + `","token":"` + sharedTok + `","peerToken":"` + peerTok + `"}`
	if settings != "" {
		settings += ","
	}
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{`+settings+`"peers":[`+peer+`]}`), 0o600))
	return f
}

func farDaemon(t *testing.T) (*fixture, *peerServer) {
	t.Helper()
	far := newFixture(t, map[string]string{"STAM_MACHINE": "far"})
	return far, newPeerServer(t, far.srv)
}

var humanHdr = map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1"}

func TestRelayToAGoDaemon(t *testing.T) {
	far, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", nil)

	// An agent here answers here; one only far has is far's answer, by id or by name, byte for byte.
	want := far.do(call{path: "/api/agents/aboss", token: sharedTok}).Body.String()
	for _, ref := range []string{"aboss", "boss"} {
		rec := f.do(call{path: "/api/agents/" + ref, token: sharedTok})
		if rec.Code != 200 || rec.Body.String() != want {
			t.Fatalf("GET %s relayed: %d %s\nwant %s", ref, rec.Code, rec.Body.String(), want)
		}
	}
	got := ps.last(t)
	if got.method != "GET" || got.header.Get("x-stam-local") != "1" || got.header.Get("authorization") != "Bearer "+peerTok || got.header.Get("x-stam-human") != "" || got.header.Get("x-stam-agent") != "" {
		t.Errorf("what far got: %+v", got)
	}
	if rec := f.do(call{path: "/api/agents/achild", token: sharedTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"id":"achild"`) {
		t.Errorf("an agent here: %d %s", rec.Code, rec.Body.String())
	}
	// An agent nobody has is a 404; so is a view of it.
	for _, p := range []string{"/api/agents/nosuch", "/api/agents/nosuch/view", "/api/agents/nosuch/events"} {
		if rec := f.do(call{path: p, token: sharedTok}); rec.Code != 404 || errorOf(t, rec) != "no agent nosuch" {
			t.Errorf("GET %s: %d %s", p, rec.Code, rec.Body.String())
		}
	}
	// What far sends back is not rewritten, an error included, and the query rides along.
	rec := f.do(call{path: "/api/agents/aboss/events?limit=1", token: sharedTok})
	if wantEv := far.do(call{path: "/api/agents/aboss/events?limit=1", token: sharedTok}); rec.Code != wantEv.Code || rec.Body.String() != wantEv.Body.String() || ps.last(t).query != "limit=1" {
		t.Errorf("events: %d %s, far says %d %s (query %q)", rec.Code, rec.Body.String(), wantEv.Code, wantEv.Body.String(), ps.last(t).query)
	}

	// An agent's token is the agent it names: far gets it as the forwarded agent, with its flags, and judges it there.
	rec = f.do(call{method: "POST", path: "/api/agents/aboss/kill", token: agentTok, body: `{}`})
	if rec.Code != 403 || errorOf(t, rec) != "only the human and the assistant may kill" {
		t.Errorf("an agent kills far's agent: %d %s", rec.Code, rec.Body.String())
	}
	got = ps.last(t)
	if got.header.Get("x-stam-agent") != "achild" || got.header.Get("x-stam-agent-boss") != "" || got.header.Get("x-stam-agent-assistant") != "" || !strings.Contains(got.body, `"by":"achild"`) {
		t.Errorf("the forwarded agent: %+v", got)
	}
	// ... as the chief of staff, which far can't tell, it is a boss.
	f.sql("UPDATE agents SET name = 'cos' WHERE id = 'achild'")
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"chiefOfStaff":"cos","peers":[{"name":"far","url":"`+ps.ts.URL+`","token":"`+sharedTok+`","peerToken":"`+peerTok+`"}]}`), 0o600))
	f.do(call{method: "POST", path: "/api/agents/aboss/kill", token: agentTok, body: `{}`})
	if got = ps.last(t); got.header.Get("x-stam-agent-boss") != "1" {
		t.Errorf("the chief of staff's headers: %+v", got.header)
	}
	f.sql("UPDATE agents SET name = 'child' WHERE id = 'achild'")

	// An agent's own token proves nothing of a peer, whatever the headers say: x-stam-local from it is ignored, so the
	// request is relayed like any agent's.
	rec = f.do(call{path: "/api/agents/aboss", token: agentTok, header: map[string]string{"X-Stam-Local": "1"}})
	if rec.Code != 200 || ps.last(t).header.Get("x-stam-agent") != "achild" {
		t.Errorf("an agent sending x-stam-local: %d %s %v", rec.Code, rec.Body.String(), ps.last(t).header)
	}
	// A peer's own call is never relayed on (it would loop): far's agent is no agent here.
	rec = f.do(call{path: "/api/agents/aboss", token: peerTok, header: map[string]string{"X-Stam-Local": "1"}})
	if rec.Code != 404 {
		t.Errorf("a peer's call for an agent not here: %d %s", rec.Code, rec.Body.String())
	}
}

func TestRelayRefusals(t *testing.T) {
	far, ps := farDaemon(t)
	_ = far
	f := relayFixture(t, ps.ts.URL, "", nil)
	before := len(ps.seen())

	// The human's view sends are sent from the machine that has the agent.
	for _, p := range []string{"prompt", "interrupt", "permission"} {
		rec := f.do(call{method: "POST", path: "/api/agents/aboss/view/" + p, token: sharedTok, body: `{}`})
		if rec.Code != 409 || errorOf(t, rec) != "aboss runs on far; send to its view from stam on far" {
			t.Errorf("view/%s: %d %s", p, rec.Code, rec.Body.String())
		}
	}
	// A notice is queued by a peer's daemon for its own agent, never relayed for a caller.
	rec := f.do(call{method: "POST", path: "/api/agents/aboss/notice", token: sharedTok, body: `{}`})
	if rec.Code != 403 || errorOf(t, rec) != "only a peer can queue a notice" {
		t.Errorf("notice: %d %s", rec.Code, rec.Body.String())
	}
	// The human's default view of a peer's agent stays here: not relayed, and here has no such agent route.
	rec = f.do(call{method: "POST", path: "/api/agents/aboss/default-view", token: sharedTok, body: `{}`})
	if rec.Code != 404 || strings.Contains(rec.Body.String(), "no agent") {
		t.Errorf("default-view: %d %s", rec.Code, rec.Body.String())
	}
	if n := len(ps.seen()) - before; n > 3 {
		// Locate asks far once per refused request that gets that far; the view sends are refused after the lookup.
		t.Logf("far was asked %d times", n)
	}
	// A body that isn't JSON is refused before anything is forwarded; an agent's must be an object.
	if rec := f.do(call{method: "POST", path: "/api/agents/aboss/kill", token: sharedTok, body: `{`}); rec.Code != 400 {
		t.Errorf("bad JSON: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.do(call{method: "POST", path: "/api/agents/aboss/kill", token: agentTok, body: `[1]`}); rec.Code != 400 {
		t.Errorf("an agent's array: %d %s", rec.Code, rec.Body.String())
	}
}

func TestRelayStrict(t *testing.T) {
	_, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, `"auth":{"humanStrict":true}`, nil)

	// The shared token naming no agent is nobody's: far would take it for a peer's own, so here refuses it.
	rec := f.do(call{method: "POST", path: "/api/agents/aboss/kill", token: sharedTok, body: `{}`})
	if rec.Code != 403 || errorOf(t, rec) != "only the human, or an agent naming itself (by), controls another machine's agent" {
		t.Errorf("strict, no by: %d %s", rec.Code, rec.Body.String())
	}
	// Naming an agent makes it that agent's; an agent's own token names itself.
	rec = f.do(call{method: "POST", path: "/api/agents/aboss/kill", token: sharedTok, body: `{"by":"nobody"}`})
	if rec.Code != 403 || errorOf(t, rec) != "only the human and the assistant may kill" {
		t.Errorf("strict, by an agent: %d %s", rec.Code, rec.Body.String())
	}
	// The human's write is far's to take, from far's page: 409 naming the machine and, in a test daemon, its origin.
	rec = f.do(call{method: "POST", path: "/api/agents/aboss/kill", header: humanHdr, body: `{}`})
	if rec.Code != 409 {
		t.Fatalf("strict, the human: %d %s", rec.Code, rec.Body.String())
	}
	v, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	if v.Text("refusal") != "human-on-machine" || v.Text("machine") != "far" || v.Text("origin") != ps.ts.URL ||
		v.Text("error") != "POST /api/agents/aboss/kill on far is the human's; do it from stam's web UI on far" {
		t.Errorf("the refusal: %s", rec.Body.String())
	}
	// A human read goes on as an ordinary call: no human header.
	if rec = f.do(call{path: "/api/agents/aboss", header: humanHdr}); rec.Code != 200 || ps.last(t).header.Get("x-stam-human") != "" {
		t.Errorf("strict, a human read: %d %s %v", rec.Code, rec.Body.String(), ps.last(t).header)
	}
	// ... and a human write that names an agent is that agent's.
	rec = f.do(call{method: "POST", path: "/api/agents/aboss/kill", header: humanHdr, body: `{"by":"achild"}`})
	if rec.Code != 403 || ps.last(t).header.Get("x-stam-human") != "" {
		t.Errorf("strict, the human naming an agent: %d %s", rec.Code, rec.Body.String())
	}
}

func TestRelayHumanNotStrict(t *testing.T) {
	_, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", nil)
	// With strict off the relay carries the human as before, and the shared token's write with no by goes on as a peer's.
	f.do(call{path: "/api/agents/aboss", header: humanHdr})
	if ps.last(t).header.Get("x-stam-human") != "1" {
		t.Errorf("not strict, a human read: %v", ps.last(t).header)
	}
	rec := f.do(call{method: "POST", path: "/api/agents/aboss/kill", token: sharedTok, body: `{}`})
	if rec.Code != 501 || ps.last(t).header.Get("x-stam-human") != "" {
		t.Errorf("not strict, the shared token with no by: %d %s", rec.Code, rec.Body.String())
	}
}

// A peer's 409 that names a machine and origin is its own refusal; only this daemon names an origin.
func TestRelayOwnRefusal(t *testing.T) {
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			writeError(w, HumanOnMachine("elsewhere", "evil", ptr("https://evil.example")))
			return
		}
		writeJSON(w, 200, map[string]any{"id": "aboss", "name": "boss", "machine": "far", "lifecycle": "active"})
	}))
	f := relayFixture(t, stub.ts.URL, "", nil)
	rec := f.do(call{method: "POST", path: "/api/agents/aboss/kill", token: sharedTok, body: `{"by":"nobody"}`})
	if rec.Code != 409 || strings.Contains(rec.Body.String(), "evil") || strings.Contains(rec.Body.String(), "refusal") || errorOf(t, rec) != "elsewhere" {
		t.Errorf("a peer's refusal: %d %s", rec.Code, rec.Body.String())
	}
}

func ptr(s string) *string { return &s }

// A relayed spawn: the peer is started or answers, the new agent is remembered here, a staged merge is a warning.
func TestRelaySpawn(t *testing.T) {
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/health":
			writeJSON(w, 200, map[string]any{"ok": true})
		case r.Method == "POST" && r.URL.Path == "/api/agents":
			writeJSON(w, 201, map[string]any{"id": "afar1", "name": "newbie", "machine": "far", "lifecycle": "active", "parent_id": "achild"})
		case r.URL.Path == "/api/agents/afar1/forget":
			writeJSON(w, 200, map[string]any{"result": "forgotten"})
		default:
			writeJSON(w, 200, map[string]any{"id": "afar1", "name": "newbie", "machine": "far", "lifecycle": "active"})
		}
	}))
	f := relayFixture(t, stub.ts.URL, "", map[string]string{"STAM_RELEASE_ID": "r1"})
	must(t, os.WriteFile(filepath.Join(f.home, "deploy-staged.json"), []byte(`{}`), 0o600))

	rec := f.do(call{method: "POST", path: "/api/agents", token: agentTok, body: `{"name":"newbie","machine":"far","harness":"claude"}`})
	if rec.Code != 201 {
		t.Fatalf("spawn on far: %d %s", rec.Code, rec.Body.String())
	}
	v, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	if v.Text("id") != "afar1" || !strings.Contains(v.Text("warning"), "a staged merge waits for its hold") {
		t.Errorf("the reply: %s", rec.Body.String())
	}
	got := stub.last(t)
	if got.method != "POST" || got.path != "/api/agents" || !strings.Contains(got.body, `"machine":"far"`) || !strings.Contains(got.body, `"by":"achild"`) || got.header.Get("x-stam-agent") != "achild" {
		t.Errorf("what far got: %+v", got)
	}
	ref, ok, err := f.db.PeerAgentByID(context.Background(), "afar1")
	if err != nil || !ok || ref.Machine != "far" || ref.Name != "newbie" {
		t.Errorf("the new agent is remembered: %+v %v %v", ref, ok, err)
	}
	// A spawn named for this machine is this daemon's own, not a relay.
	if rec = f.do(call{method: "POST", path: "/api/agents", token: sharedTok, body: `{"name":"x","machine":"here","harness":"claude"}`}); rec.Code == 201 && strings.Contains(rec.Body.String(), "afar1") {
		t.Errorf("a spawn on this machine was relayed: %s", rec.Body.String())
	}

	// Forgetting a peer's agent through here takes the human's default view of it with it.
	f.sql("INSERT INTO agent_views (agent_id, view, updated_at) VALUES ('afar1', 'terminal', 'now')")
	if f.count("SELECT count(*) FROM agent_views WHERE agent_id = 'afar1'") != 1 {
		t.Fatal("no view row to clear")
	}
	if rec = f.do(call{method: "POST", path: "/api/agents/afar1/forget", token: agentTok, body: `{}`}); rec.Code != 200 {
		t.Fatalf("forget: %d %s", rec.Code, rec.Body.String())
	}
	if f.count("SELECT count(*) FROM agent_views WHERE agent_id = 'afar1'") != 0 {
		t.Error("the view row stayed")
	}
}

// Ring members spawned on a peer are remembered on that peer, the ring itself is not.
func TestRelaySpawnRing(t *testing.T) {
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			writeJSON(w, 200, map[string]any{"ok": true})
			return
		}
		writeJSON(w, 201, map[string]any{"id": "ring1", "kind": "ring", "members": []any{map[string]any{"id": "am1", "name": "m1"}, map[string]any{"id": "am2"}}, "moderator": map[string]any{"id": "amod", "name": "mod"}})
	}))
	f := relayFixture(t, stub.ts.URL, "", nil)
	if rec := f.do(call{method: "POST", path: "/api/agents", token: sharedTok, header: humanHdr, body: `{"machine":"far","kind":"ring"}`}); rec.Code != 201 {
		t.Fatalf("ring spawn: %d %s", rec.Code, rec.Body.String())
	}
	ctx := context.Background()
	for _, id := range []string{"am1", "amod"} {
		if ref, ok, _ := f.db.PeerAgentByID(ctx, id); !ok || ref.Machine != "far" {
			t.Errorf("%s remembered: %+v %v", id, ref, ok)
		}
	}
	for _, id := range []string{"ring1", "am2"} {
		if _, ok, _ := f.db.PeerAgentByID(ctx, id); ok {
			t.Errorf("%s was remembered", id)
		}
	}
}

// The agent view's event stream is piped, not read whole.
func TestRelayViewStream(t *testing.T) {
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agents/aboss":
			writeJSON(w, 200, map[string]any{"id": "aboss", "name": "boss", "machine": "far", "lifecycle": "active"})
		case "/api/agents/aboss/view":
			w.Header().Set("content-type", "text/event-stream")
			w.WriteHeader(200)
			io.WriteString(w, "data: one\n\n")
			w.(http.Flusher).Flush()
			io.WriteString(w, "data: two\n\n")
		}
	}))
	f := relayFixture(t, stub.ts.URL, "", nil)
	rec := f.do(call{path: "/api/agents/aboss/view?since=3", token: sharedTok})
	if rec.Code != 200 || rec.Header().Get("content-type") != "text/event-stream" || rec.Body.String() != "data: one\n\ndata: two\n\n" || rec.Header().Get("cache-control") != "no-cache" {
		t.Errorf("the piped view: %d %v %q", rec.Code, rec.Header(), rec.Body.String())
	}
	if got := stub.last(t); got.query != "since=3" || got.header.Get("x-stam-local") != "1" {
		t.Errorf("what far got: %+v", got)
	}
}

// An id that an agent here and an agent on another machine both have can't say which is meant (S-577).
func TestRelayAmbiguousID(t *testing.T) {
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"id": "achild", "name": "other", "machine": "far", "lifecycle": "active"})
	}))
	f := relayFixture(t, stub.ts.URL, "", nil)
	must(t, f.db.RememberPeerAgent(context.Background(), db.PeerAgentSeen{ID: "achild", Name: "other", Machine: "far", Lifecycle: "active"}))
	rec := f.do(call{path: "/api/agents/achild", token: sharedTok})
	if rec.Code != 409 || !strings.Contains(errorOf(t, rec), "achild matches an agent on more than one machine: child (") || !strings.Contains(errorOf(t, rec), "other (far); address it by name, not by id") {
		t.Errorf("an ambiguous id: %d %s", rec.Code, rec.Body.String())
	}
	// An agent naming itself is not ambiguous, and neither is a name.
	if rec = f.do(call{path: "/api/agents/achild", token: agentTok}); rec.Code != 200 {
		t.Errorf("the agent itself: %d %s", rec.Code, rec.Body.String())
	}
	if rec = f.do(call{path: "/api/agents/child", token: sharedTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"id":"achild"`) {
		t.Errorf("by name: %d %s", rec.Code, rec.Body.String())
	}
	// Two agents on peers that a name means are an error that lists both.
	two := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"id": "afar9", "name": "twin", "machine": "far", "lifecycle": "active"})
	}))
	g := relayFixture(t, two.ts.URL, "", nil)
	must(t, os.WriteFile(filepath.Join(g.home, "settings.json"), []byte(`{"peers":[{"name":"far","url":"`+two.ts.URL+`","token":"`+sharedTok+`","peerToken":"`+peerTok+`"},{"name":"far2","url":"`+two.ts.URL+`","token":"`+sharedTok+`","peerToken":"`+peerTok+`"}]}`), 0o600))
	rec = g.do(call{path: "/api/agents/twin", token: sharedTok})
	if rec.Code != 409 || !strings.Contains(errorOf(t, rec), "twin matches more than one agent") {
		t.Errorf("two agents a name means: %d %s", rec.Code, rec.Body.String())
	}
}

// A peer that is gone fails the relay as an error, with no token in it, and the peer is marked down.
func TestRelayPeerDown(t *testing.T) {
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := stub.ts.URL
	stub.ts.Close()
	f := relayFixture(t, url, "", nil)
	rec := f.do(call{path: "/api/agents/aboss", token: sharedTok})
	if rec.Code != 404 || errorOf(t, rec) != "no agent aboss" {
		t.Errorf("the peer is down, so the agent isn't found: %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(call{method: "POST", path: "/api/agents", token: sharedTok, body: `{"name":"x","machine":"far","harness":"claude"}`})
	if rec.Code != 503 || strings.Contains(rec.Body.String(), sharedTok) || strings.Contains(rec.Body.String(), peerTok) {
		t.Errorf("a spawn on a peer that won't start: %d %s", rec.Code, rec.Body.String())
	}
}

// The mailbox routes act as the agent in the path, checked before the relay (S-242): an agent of far's is far's to judge, so
// the request goes there as the forwarded agent; one here is judged here, and refused before anything is forwarded.
func TestRelayActingChecks(t *testing.T) {
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/aboss/inbox" {
			writeJSON(w, 200, []any{})
			return
		}
		writeJSON(w, 200, map[string]any{"id": "aboss", "name": "boss", "machine": "far", "lifecycle": "active"})
	}))
	f := relayFixture(t, stub.ts.URL, "", nil)
	rec := f.do(call{path: "/api/agents/aboss/inbox", token: agentTok})
	if rec.Code != 200 || stub.last(t).header.Get("x-stam-agent") != "achild" {
		t.Errorf("an agent reading far's inbox: %d %s %v", rec.Code, rec.Body.String(), stub.last(t).header)
	}
	f.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT 'bother', 'other', role, machine, harness, cwd, lifecycle, activity, created_at, updated_at FROM agents WHERE id = 'achild'")
	before := len(stub.seen())
	rec = f.do(call{path: "/api/agents/bother/inbox", token: agentTok})
	if rec.Code != 403 || len(stub.seen()) != before {
		t.Errorf("an agent reading a sibling's inbox: %d %s", rec.Code, rec.Body.String())
	}
}

// A caller that gives up mid-spawn does not cancel it: the peer's reply still comes back and the new agent is remembered.
func TestRelaySpawnSurvivesCallerCancel(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			writeJSON(w, 200, map[string]any{"ok": true})
			return
		}
		close(started)
		<-release
		writeJSON(w, 201, map[string]any{"id": "afar2", "name": "late", "machine": "far", "lifecycle": "active"})
	}))
	f := relayFixture(t, stub.ts.URL, "", nil)
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("POST", "/api/agents", strings.NewReader(`{"name":"late","machine":"far","harness":"claude"}`)).WithContext(ctx)
	req.Host = "127.0.0.1:7999"
	req.Header.Set("Authorization", "Bearer "+sharedTok)
	done := make(chan struct{})
	go func() { defer close(done); f.srv.ServeHTTP(httptest.NewRecorder(), req) }()
	<-started
	cancel()
	close(release)
	<-done
	if ref, ok, err := f.db.PeerAgentByID(context.Background(), "afar2"); err != nil || !ok || ref.Machine != "far" {
		t.Errorf("the spawn that finished after its caller left is remembered: %+v %v %v", ref, ok, err)
	}
	if !f.srv.peers.Up("far") {
		t.Error("a caller that left marked the peer down")
	}
}

// An agent's token is the agent it names, in a relayed write as anywhere: naming another agent is refused here, and
// nothing is forwarded.
func TestRelayAgentCannotNameAnother(t *testing.T) {
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"id": "aboss", "name": "boss", "machine": "far", "lifecycle": "active"})
	}))
	f := relayFixture(t, stub.ts.URL, "", nil)
	f.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT 'bother', 'other', role, machine, harness, cwd, lifecycle, activity, created_at, updated_at FROM agents WHERE id = 'achild'")
	n := len(stub.seen())
	for _, key := range []string{"by", "from", "self"} {
		rec := f.do(call{method: "POST", path: "/api/agents/aboss/kill", token: agentTok, body: `{"` + key + `":"bother"}`})
		if rec.Code != 403 || !strings.Contains(errorOf(t, rec), "can't act as bother") {
			t.Errorf("%s: %d %s", key, rec.Code, rec.Body.String())
		}
	}
	if len(stub.seen()) != n {
		t.Error("a refused write was forwarded")
	}
}

// The `as` query names the viewer on a read too: the OpenCode server may name only an OpenCode agent, and an agent's own
// token is itself, checked before the relay.
func TestRelayResolvesAsQuery(t *testing.T) {
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"id": "aboss", "name": "boss", "machine": "far", "lifecycle": "active"})
	}))
	f := relayFixture(t, stub.ts.URL, "", nil)
	n := len(stub.seen())
	// The key is decoded before it is compared: an encoded `as` is the same query.
	for _, p := range []string{"/api/agents/aboss?as=achild", "/api/agents/aboss?as=", "/api/agents/achild?as=achild", "/api/agents/aboss?%61s=achild", "/api/agents/aboss?a%73=achild", "/api/agents/aboss?%61%73=achild"} {
		if rec := f.do(call{path: p, token: serverTok}); rec.Code != 403 || !strings.Contains(errorOf(t, rec), "the OpenCode server can't act as") {
			t.Errorf("OpenCode GET %s: %d %s", p, rec.Code, rec.Body.String())
		}
	}
	if len(stub.seen()) != n {
		t.Error("a refused read was forwarded")
	}
	if rec := f.do(call{path: "/api/agents/aboss?as=", token: serverTok}); errorOf(t, rec) != "the OpenCode server can't act as no one" {
		t.Errorf("OpenCode naming no one: %d %s", rec.Code, rec.Body.String())
	}
	// An agent naming itself, or no one, is itself; naming another is refused. The resolved name is what is forwarded.
	if rec := f.do(call{path: "/api/agents/aboss?x=1&as=child", token: agentTok}); rec.Code != 200 || stub.last(t).query != "x=1&as=achild" {
		t.Errorf("an agent's own as: %d %s %q", rec.Code, rec.Body.String(), stub.last(t).query)
	}
	if rec := f.do(call{path: "/api/agents/aboss?as=aboss", token: agentTok}); rec.Code != 403 {
		t.Errorf("an agent naming another: %d %s", rec.Code, rec.Body.String())
	}
}

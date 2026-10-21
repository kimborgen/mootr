package server

import (
	"net/http"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

// The ITSA-home proxy (relay.go itsaHome): "here" has settings home "far", a Go daemon on its own home and socket that is
// the home. A recording wrapper in front of far shows what here sent it.

func TestItsaProxyToAGoDaemon(t *testing.T) {
	far, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, `"home":"far"`, nil)

	// A create through here lands on far, as the human carried (strict is off), and the answer is far's.
	rec := f.do(call{method: "POST", path: "/api/itsas", token: sharedTok, header: human, body: `{"title":"proxied"}`})
	if rec.Code != 200 {
		t.Fatalf("create through here: %d %s", rec.Code, rec.Body.String())
	}
	if far.count("SELECT count(*) FROM itsas WHERE title = 'proxied'") != 1 || f.count("SELECT count(*) FROM itsas WHERE title = 'proxied'") != 0 {
		t.Error("the ITSA is not only on far")
	}
	got := ps.last(t)
	if got.method != "POST" || got.path != "/api/itsas" || got.header.Get("x-stam-local") != "1" || got.header.Get("x-stam-human") != "1" || got.header.Get("authorization") != "Bearer "+peerTok {
		t.Errorf("what far got: %+v", got)
	}
	v, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	key := v.Text("key")
	if key == "" {
		t.Fatalf("no key in %s", rec.Body.String())
	}
	// Reads are far's bytes, with the query.
	for _, p := range []string{"/api/itsas", "/api/itsas/" + key, "/api/itsas/statuses"} {
		want := far.do(call{path: p, token: sharedTok})
		if got := f.do(call{path: p, token: sharedTok}); got.Code != want.Code || got.Body.String() != want.Body.String() {
			t.Errorf("GET %s: %d %s, far says %d %s", p, got.Code, got.Body.String(), want.Code, want.Body.String())
		}
	}
	f.do(call{path: "/api/itsas?status=todo", token: sharedTok})
	if ps.last(t).query != "status=todo" {
		t.Errorf("the query: %+v", ps.last(t))
	}

	// An agent's token is the agent it names, forwarded with its flags; its body is resolved first.
	f.do(call{method: "POST", path: "/api/itsas/" + key + "/post", token: agentTok, body: `{"body":"hi"}`})
	got = ps.last(t)
	if got.header.Get("x-stam-agent") != "achild" || !strings.Contains(got.body, `"by":"achild"`) || got.header.Get("x-stam-human") != "" {
		t.Errorf("an agent's post: %+v", got)
	}
	// Reads an agent's token never makes are refused here, before the proxy.
	n := len(ps.seen())
	for p, msg := range map[string]string{
		"/api/itsas/attention": "an agent's token can't read what waits on the human",
		"/api/itsas/queue":     "an agent's token can't read the merge queue",
		"/api/itsas/S-1/cost":  "an agent's token can't read an ITSA's cost",
	} {
		if rec := f.do(call{path: p, token: agentTok}); rec.Code != 403 || errorOf(t, rec) != msg {
			t.Errorf("%s: %d %s", p, rec.Code, rec.Body.String())
		}
	}
	if len(ps.seen()) != n {
		t.Error("a refused read was forwarded")
	}
	// The OpenCode server names its agent, or may not read threads; the home then sees the agent it names.
	if rec := f.do(call{path: "/api/itsas/" + key + "/thread", token: serverTok}); rec.Code != 403 || errorOf(t, rec) != "the OpenCode server must name the agent that reads the threads" {
		t.Errorf("OpenCode, no agent named: %d %s", rec.Code, rec.Body.String())
	}
	f.sql("UPDATE agents SET harness = 'opencode' WHERE id = 'achild'")
	f.do(call{path: "/api/itsas/" + key + "/thread?as=achild", token: serverTok})
	if got = ps.last(t); got.header.Get("x-stam-agent") != "achild" {
		t.Errorf("OpenCode naming an agent: %+v", got)
	}
	// A branch link by an agent needs this daemon's branch owners, which is not ported.
	if rec := f.do(call{method: "POST", path: "/api/itsas/" + key + "/links", token: agentTok, body: `{"system":"branch","external_id":"b","repo":"r"}`}); rec.Code != 501 || !strings.Contains(errorOf(t, rec), "branch owners") {
		t.Errorf("an agent's branch link: %d %s", rec.Code, rec.Body.String())
	}
	// A peer's own call is this daemon's, never proxied (it would loop).
	n = len(ps.seen())
	f.do(call{path: "/api/itsas", token: peerTok, header: map[string]string{"X-Stam-Local": "1"}})
	if len(ps.seen()) != n {
		t.Error("a peer's own call was proxied")
	}
}

func TestItsaProxyStrict(t *testing.T) {
	_, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, `"home":"far","auth":{"humanStrict":true}`, nil)
	// The human's write is far's to take, from far's page.
	rec := f.do(call{method: "POST", path: "/api/itsas", header: humanHdr, body: `{"title":"x"}`})
	v, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	if rec.Code != 409 || v.Text("refusal") != "human-on-machine" || v.Text("machine") != "far" || v.Text("origin") != ps.ts.URL ||
		v.Text("error") != "POST /api/itsas on far is the human's; do it from stam's web UI on far" {
		t.Errorf("strict, the human: %d %s", rec.Code, rec.Body.String())
	}
	// The id is not in the line: it names the route.
	rec = f.do(call{method: "PATCH", path: "/api/itsas/S-12", header: humanHdr, body: `{"title":"x"}`})
	if rec.Code != 409 || errorOf(t, rec) != "PATCH /api/itsas/:id on far is the human's; do it from stam's web UI on far" {
		t.Errorf("strict, a patch: %d %s", rec.Code, rec.Body.String())
	}
	// A read goes on as an ordinary call, and a write naming an agent is that agent's.
	if rec = f.do(call{path: "/api/itsas", header: humanHdr}); rec.Code != 200 || ps.last(t).header.Get("x-stam-human") != "" {
		t.Errorf("strict, a read: %d %s", rec.Code, rec.Body.String())
	}
	f.do(call{method: "POST", path: "/api/itsas", header: humanHdr, body: `{"title":"x","by":"achild"}`})
	if got := ps.last(t); got.header.Get("x-stam-human") != "" || got.method != "POST" {
		t.Errorf("strict, the human naming an agent: %+v", got)
	}
}

func TestItsaProxyPeerDownAndStubs(t *testing.T) {
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			writeError(w, HumanOnMachine("elsewhere", "evil", ptr("https://evil.example")))
			return
		}
		writeJSON(w, 200, map[string]any{"path": r.URL.Path})
	}))
	f := relayFixture(t, stub.ts.URL, `"home":"far","requirements":{"enabled":true}`, nil)
	// Retros, processes and requirements ride to the home; a peer's own refusal is stripped.
	for _, p := range []string{"/api/retros?kind=idea", "/api/processes", "/api/processes/dev-change", "/api/requirements"} {
		rec := f.do(call{path: p, token: sharedTok})
		if rec.Code != 200 || newest(stub).path != strings.SplitN(p, "?", 2)[0] || !strings.Contains(rec.Body.String(), strings.SplitN(p, "?", 2)[0]) {
			t.Errorf("GET %s: %d %s %+v", p, rec.Code, rec.Body.String(), stub.last(t))
		}
	}
	if q := stub.seen()[0].query; q != "kind=idea" && stub.seen()[0].path == "/api/retros" {
		t.Errorf("the retros query: %q", q)
	}
	rec := f.do(call{method: "POST", path: "/api/itsas", token: sharedTok, body: `{"title":"x","by":"nobody"}`})
	if rec.Code != 409 || strings.Contains(rec.Body.String(), "evil") || errorOf(t, rec) != "elsewhere" {
		t.Errorf("a home's refusal: %d %s", rec.Code, rec.Body.String())
	}
	// A path that is not an ITSA route is not proxied.
	n := len(stub.seen())
	if rec = f.do(call{path: "/api/retroscope", token: sharedTok}); rec.Code != 404 || len(stub.seen()) != n {
		t.Errorf("/api/retroscope: %d %s", rec.Code, rec.Body.String())
	}
	// Requirements are off unless enabled, on every daemon, before the proxy.
	g := relayFixture(t, stub.ts.URL, `"home":"far"`, nil)
	n = len(stub.seen())
	if rec = g.do(call{path: "/api/requirements", token: sharedTok}); rec.Code != 404 || errorOf(t, rec) != "requirements are off (settings.requirements.enabled)" || len(stub.seen()) != n {
		t.Errorf("requirements off: %d %s", rec.Code, rec.Body.String())
	}
	// The home is gone: 503 naming it, and no token anywhere.
	stub.ts.Close()
	rec = f.do(call{path: "/api/itsas", token: sharedTok})
	if rec.Code != 503 || !strings.HasPrefix(errorOf(t, rec), "far (the ITSA home) is unreachable: ") || strings.Contains(rec.Body.String(), sharedTok) || strings.Contains(rec.Body.String(), peerTok) {
		t.Errorf("home down: %d %s", rec.Code, rec.Body.String())
	}
}

// newest is a stub's newest request that is not a health probe, without a *testing.T.
func newest(p *peerServer) seenReq {
	rs := p.seen()
	for i := len(rs) - 1; i >= 0; i-- {
		if rs[i].path != "/api/health" {
			return rs[i]
		}
	}
	return seenReq{}
}

// The `as` query is resolved once, before the proxy (resolveActors): the OpenCode server naming an agent that is not an
// OpenCode one, or an agent naming another, is refused here and the home gets nothing; a name becomes the agent's id, which
// is what the home sees and what the boss check is made on.
func TestItsaProxyResolvesAs(t *testing.T) {
	_, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, `"home":"far","chiefOfStaff":"cos"`, nil)
	f.sql("INSERT INTO agents (id, name, role, machine, harness, cwd, lifecycle, activity, created_at, updated_at) SELECT 'bother', 'other', role, machine, harness, cwd, lifecycle, activity, created_at, updated_at FROM agents WHERE id = 'achild'")
	n := len(ps.seen())
	for _, tc := range []struct{ token, path string }{
		{serverTok, "/api/itsas/S-1/threads?as=achild"},
		{serverTok, "/api/itsas/S-1/threads?as=nobody"},
		{serverTok, "/api/itsas/S-1/threads?%61s=achild"},
		{serverTok, "/api/itsas/S-1/threads?a%73=achild"},
		{serverTok, "/api/itsas/S-1/threads?%61%73=achild"},
		{agentTok, "/api/itsas/S-1/thread?%61s=bother"},
		{agentTok, "/api/itsas/S-1/thread?as=bother"},
		{agentTok, "/api/agents/aboss?as=bother"},
	} {
		if rec := f.do(call{path: tc.path, token: tc.token}); rec.Code != 403 {
			t.Errorf("%s: %d %s", tc.path, rec.Code, rec.Body.String())
		}
	}
	if len(ps.seen()) != n {
		t.Error("a refused read was forwarded")
	}
	// An OpenCode agent named by its name is its id, and as the chief of staff it is a boss.
	f.sql("UPDATE agents SET harness = 'opencode', name = 'cos' WHERE id = 'achild'")
	if rec := f.do(call{path: "/api/itsas/S-1/threads?as=cos", token: serverTok}); rec.Code == 403 && strings.Contains(rec.Body.String(), "can't act as") {
		t.Fatalf("an OpenCode agent by name: %s", rec.Body.String())
	}
	got := ps.last(t)
	if got.query != "as=achild" || got.header.Get("x-stam-agent") != "achild" || got.header.Get("x-stam-agent-boss") != "1" {
		t.Errorf("what the home got: %+v", got)
	}
}

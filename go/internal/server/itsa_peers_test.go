package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

// incident-marked answers what src/itsa-owners.ts incidentMarkedHere does on the same rows: a mark on the ITSA or on an
// ancestor, none on an unknown ITSA, a missing parent or a loop.
func TestItsaIncidentMarkedMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/itsa-owners.ts")
	}
	home := filepath.Join(t.TempDir(), "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/peerref.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("peerref.mjs: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "expect.json"))
	must(t, err)
	want, err := jsfmt.Parse(raw)
	must(t, err)
	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.pre.db"))
	cases, _ := want.Get("cases")
	marked := 0
	for _, c := range cases.Items {
		ref := c.Text("ref")
		rec := f.do(call{path: "/api/itsas/incident-marked?itsa=" + ref, token: peerTok, header: map[string]string{"X-Stam-Local": "1"}})
		got, _ := jsfmt.Parse(rec.Body.Bytes())
		g, _ := got.Get("marked")
		w, _ := c.Get("marked")
		if rec.Code != 200 || g.Bool != w.Bool {
			t.Errorf("incident-marked %q: %d %s, TS %v", ref, rec.Code, rec.Body.String(), w.Bool)
		}
		if w.Bool {
			marked++
		}
	}
	if marked == 0 || marked == len(cases.Items) {
		t.Errorf("%d of %d refs marked: the reference tests nothing", marked, len(cases.Items))
	}
}

// The peer hooks are a peer's alone: anything else is refused 403 first, as src/daemon.ts does before it proxies. A peer's
// call is checked as TS checks it, then answered 501 where it would act for a spawn on another machine.
func TestItsaPeerHooks(t *testing.T) {
	f := newFixture(t, nil)
	peer := map[string]string{"X-Stam-Local": "1"}
	paths := []struct{ method, path string }{
		{"POST", "/api/itsas/join-parent"}, {"POST", "/api/itsas/join"}, {"POST", "/api/itsas/leave"}, {"POST", "/api/itsas/may-participate"},
		{"POST", "/api/itsas/owner-stopped"}, {"POST", "/api/itsas/unown-agent"}, {"GET", "/api/itsas/incident-marked"},
	}
	for _, p := range paths {
		// Whatever the method: the check is on the path, before the route table.
		for _, m := range []string{"GET", "POST", "PUT", "DELETE"} {
			if rec := f.do(call{method: m, path: p.path, token: sharedTok, body: `{}`}); rec.Code != 403 || !strings.Contains(rec.Body.String(), "only a peer can call this") {
				t.Errorf("%s %s: %d %s", m, p.path, rec.Code, rec.Body.String())
			}
		}
		for _, tok := range []string{sharedTok, agentTok} {
			rec := f.do(call{method: p.method, path: p.path, token: tok, body: `{}`})
			if rec.Code != 403 || !strings.Contains(rec.Body.String(), "only a peer can call this") {
				t.Errorf("%s %s with %s: %d %s", p.method, p.path, tok, rec.Code, rec.Body.String())
			}
		}
	}
	for _, tc := range []struct {
		path, body string
		code       int
		msg        string
	}{
		{"/api/itsas/join-parent", `{"agent":"a"}`, 400, "join-parent needs agent and parent"},
		{"/api/itsas/join", `{"itsa":"S-1"}`, 400, "join needs itsa and agent"},
		{"/api/itsas/leave", `{"agent":"a"}`, 400, "leave needs itsa and agent"},
		{"/api/itsas/may-participate", `{}`, 400, "may-participate needs itsa"},
		{"/api/itsas/join-parent", `{"agent":"a","parent":"b"}`, 501, "not ported"},
		{"/api/itsas/join", `{"itsa":"S-1","agent":"a"}`, 501, "not ported"},
		{"/api/itsas/leave", `{"itsa":"S-1","agent":"a"}`, 501, "not ported"},
		{"/api/itsas/may-participate", `{"itsa":"S-1"}`, 501, "not ported"},
		// An agent of this machine is no peer's to report.
		{"/api/itsas/owner-stopped", `{"id":"achild","name":"child","what":"archived"}`, 403, "only a peer holding that agent can report its stop"},
		{"/api/itsas/unown-agent", `{"id":"achild","name":"child"}`, 403, "only a peer holding that archived agent can unown its ITSAs"},
		// One this daemon does not know needs the peers to say.
		{"/api/itsas/owner-stopped", `{"id":"nobody","name":"n","what":"archived"}`, 501, "peers"},
		{"/api/itsas/unown-agent", `{"id":"nobody","name":"n"}`, 501, "peers"},
	} {
		rec := f.do(call{method: "POST", path: tc.path, token: peerTok, header: peer, body: tc.body})
		if rec.Code != tc.code || !strings.Contains(rec.Body.String(), tc.msg) {
			t.Errorf("POST %s %s: %d %s, want %d %q", tc.path, tc.body, rec.Code, rec.Body.String(), tc.code, tc.msg)
		}
	}
}

package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

// farAsk is a Go daemon "far" whose achild holds a pending request for the human, and the request's id.
func farAsk(t *testing.T) (*fixture, *peerServer, string) {
	t.Helper()
	far, ps := farDaemon(t)
	far.sql("UPDATE agents SET lifecycle = 'active' WHERE id IN ('aboss', 'achild')")
	return far, ps, far.ask(`{"action":"deploy","reason":"r","audience":"human"}`)
}

// An answer to a request another machine holds goes to that machine (permission_relay.go): the one the body names, or the
// peer that has it. The body loses its machine on the way.
func TestPermissionAnswerRelay(t *testing.T) {
	far, ps, id := farAsk(t)
	f := relayFixture(t, ps.ts.URL, "", nil)

	if code, body := f.answerAs(sharedTok, human, id, `{"approve":false,"machine":"nowhere"}`); code != 404 || !strings.Contains(body, "no peer machine nowhere") {
		t.Errorf("an unknown machine: %d %s", code, body)
	}
	if far.status(id) != "pending" {
		t.Fatalf("far's request is %s after a refused answer", far.status(id))
	}
	// The service worker's direct attempt may quote a bearer: no token reaches the log or far.
	logs := captureServerLogs(t)
	direct := `fetch failed\nagain: 401 {\"auth\":\"Bearer outside-token-1234\",\"short\":\"Bearer abc123\",\"basic\":\"Basic YTpi\",\"echo\":\"` + peerTok + ` ` + sharedTok + `\"}`
	if code, body := f.answerAs(sharedTok, human, id, `{"approve":false,"note":"no","direct":"`+direct+`"}`); code != 200 {
		t.Fatalf("the human's answer relayed: %d %s", code, body)
	}
	if l := logs.String(); !strings.Contains(l, "relayed after the direct attempt failed") || strings.Contains(l, "outside-token-1234") || strings.Contains(l, "abc123") || strings.Contains(l, "YTpi") || strings.Contains(l, peerTok) || strings.Contains(l, sharedTok) {
		t.Errorf("the direct attempt's log line: %s", l)
	}
	if got := far.status(id); got == "pending" {
		t.Errorf("far's request is still pending")
	}
	last := ps.last(t)
	if last.header.Get("x-stam-human") != "1" || strings.Contains(last.body, "machine") || strings.Contains(last.body, "direct") || !strings.Contains(last.body, `"note":"no"`) {
		t.Errorf("what far got: %s %v", last.body, last.header)
	}
}

// Under auth.humanStrict the human's answer is never carried to a peer: with no machine named, each peer is probed as a
// non-human, and the 409 names the one that holds the request, not the first one asked.
func TestPermissionAnswerRelayStrict(t *testing.T) {
	far, ps, id := farAsk(t)
	_, near := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", map[string]string{})
	peer := func(name, url string) string {
		return `{"name":"` + name + `","url":"` + url + `","token":"` + sharedTok + `","peerToken":"` + peerTok + `"}`
	}
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"auth":{"humanStrict":true},"peers":[`+peer("near", near.ts.URL)+`,`+peer("far", ps.ts.URL)+`]}`), 0o600))

	for _, body := range []string{`{"approve":true}`, `{"approve":true,"by":"human"}`} {
		rec := f.sendH("POST", "/api/permissions/"+id+"/answer", "", humanHdr, body)
		if rec.Code != 409 {
			t.Fatalf("strict, the human's answer %s: %d %s", body, rec.Code, rec.Body.String())
		}
		v, err := jsfmt.Parse(rec.Body.Bytes())
		must(t, err)
		if v.Text("refusal") != "human-on-machine" || v.Text("machine") != "far" || v.Text("error") != "a permission answer on far is the human's; do it from stam's web UI on far" {
			t.Errorf("the refusal: %s", rec.Body.String())
		}
	}
	// Naming the machine refuses before anything is sent.
	n := len(ps.seen())
	if rec := f.sendH("POST", "/api/permissions/"+id+"/answer", "", humanHdr, `{"approve":true,"machine":"far"}`); rec.Code != 409 || len(ps.seen()) != n {
		t.Errorf("strict, the human naming far: %d %s, far got %d requests", rec.Code, rec.Body.String(), len(ps.seen())-n)
	}
	if far.status(id) != "pending" {
		t.Errorf("far's request is %s after the human's answers were refused", far.status(id))
	}
	for _, p := range []*peerServer{near, ps} {
		for _, r := range p.seen() {
			if r.header.Get("x-stam-human") != "" || strings.Contains(r.body, `"by"`) {
				t.Errorf("a peer got the human or a by: %s %s %v", r.path, r.body, r.header)
			}
		}
	}
}

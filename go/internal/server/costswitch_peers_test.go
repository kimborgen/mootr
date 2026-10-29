package server

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/db"
)

// costSwitchFixture is a daemon whose lifecycle knows the preset cheap, with settings (no braces) and these peers.
func costSwitchFixture(t *testing.T, settings string) *fixture {
	t.Helper()
	f := newFixture(t, nil)
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "registry"), 0o700))
	must(t, os.WriteFile(filepath.Join(root, "registry", "defaults.json"), []byte(`{"presets":{"cheap":{"harness":"claude","model":"cheap-model"}}}`), 0o600))
	withLifeRoot(f, root)
	f.srv.life.SetCostMail(f.srv.sendFromSystemMail, f.srv.withdrawQuietly)
	f.sql("UPDATE agents SET activity = 'idle' WHERE id IN ('achild', 'aboss')")
	writeFile(t, filepath.Join(f.home, "settings.json"), `{`+settings+`}`)
	return f
}

// A cost_switch on another machine's agent goes to the daemon that runs it, as the manager the call names (S-923), and
// that daemon's answer is the caller's. A peer's own call is never relayed, and a peer that may hold the agent and
// doesn't answer is a 503 naming its machine.
func TestCostSwitchRelayed(t *testing.T) {
	twin := newStubHome(t)
	f := costSwitchFixture(t, `"auth":{"humanStrict":true},"peers":[{"name":"twin","url":"`+twin.URL+`","token":"test-peer-token"}]`)
	twin.answer("GET /api/agents/kid", 200, `{"id":"akid","name":"kid","machine":"twin","lifecycle":"active"}`)
	twin.answer("POST /api/cost/switch", 200, `{"status":"quiescing","from":"kid","to":"kid-t2","preset":"cheap","minutes":0}`)
	sw := func(token string, h map[string]string, body string) (int, string) {
		rec := f.sendH("POST", "/api/cost/switch", token, h, body)
		return rec.Code, rec.Body.String()
	}

	code, body := sw(bossTok, nil, `{"agent":"kid","preset":"cheap","by":"aboss","soft_stop_minutes":0}`)
	if code != 200 || !strings.Contains(body, `"to":"kid-t2"`) {
		t.Fatalf("relayed: %d %s", code, body)
	}
	if got := twin.got("POST /api/cost/switch"); len(got) != 1 || !strings.Contains(got[0], "via=aboss ") || !strings.Contains(got[0], `"by":"aboss"`) || !strings.Contains(got[0], `"agent":"kid"`) {
		t.Errorf("the forward: %q", got)
	}

	// The holder's refusal is the caller's, with its message.
	twin.answer("POST /api/cost/switch", 403, `{"error":"boss may not manage cost for kid's tree"}`)
	if code, body := sw(bossTok, nil, `{"agent":"kid","preset":"cheap","by":"aboss"}`); code != 403 || !strings.Contains(body, "boss may not manage cost for kid's tree") {
		t.Errorf("a refusal: %d %s", code, body)
	}

	// Under strict, the shared token with no by is no one the peer can check.
	sent := len(twin.got("POST /api/cost/switch"))
	if code, body := sw(sharedTok, nil, `{"agent":"kid","preset":"cheap"}`); code != 403 || !strings.Contains(body, "only the human, or an agent naming itself (by), switches another machine's agent") {
		t.Errorf("the shared token with no by: %d %s", code, body)
	}
	// A peer's own call is this daemon's: kid isn't here.
	if code, body := sw(peerTok, map[string]string{"X-Stam-Local": "1"}, `{"agent":"kid","preset":"cheap","by":"aboss"}`); code != 400 || !strings.Contains(body, "no agent kid") {
		t.Errorf("a peer's call: %d %s", code, body)
	}
	// An agent no peer has is this daemon's "no agent".
	if code, body := sw(bossTok, nil, `{"agent":"ghost","preset":"cheap","by":"aboss"}`); code != 400 || !strings.Contains(body, "no agent ghost") {
		t.Errorf("no agent: %d %s", code, body)
	}
	if got := len(twin.got("POST /api/cost/switch")); got != sent {
		t.Errorf("%d more forwards", got-sent)
	}

	// The peer that holds kid is down: a 503 that names it, not "no agent".
	down := newStubHome(t)
	down.Close()
	g := costSwitchFixture(t, `"peers":[{"name":"twin","url":"`+down.URL+`","token":"test-peer-token"}]`)
	must(t, g.db.RememberPeerAgent(context.Background(), db.PeerAgentSeen{ID: "akid", Name: "kid", Machine: "twin"}))
	rec := g.sendH("POST", "/api/cost/switch", bossTok, nil, `{"agent":"kid","preset":"cheap","by":"aboss"}`)
	if rec.Code != 503 || !strings.Contains(rec.Body.String(), "kid runs on twin, which doesn't answer") {
		t.Errorf("a down peer: %d %s", rec.Code, rec.Body.String())
	}
}

// The daemon that runs the agent takes the manager from a peer's forward (src/daemon.ts remoteManager): only an agent a
// peer answers for with that id, acting as itself. It may switch as the chief of staff by name, as the assistant the peer
// vouches for, or as an ancestor through the parents peers listed; anyone else is refused as a local manager would be.
func TestCostSwitchRemoteManager(t *testing.T) {
	main := newFarPeer(t, map[string]string{
		"amgr":   `{"id":"amgr","name":"mgr","machine":"main","lifecycle":"active"}`,
		"aother": `{"id":"aother","name":"other","machine":"main","lifecycle":"active"}`,
		"acos":   `{"id":"acos","name":"cos","machine":"main","lifecycle":"active"}`,
		"aimp":   `{"id":"aelse","name":"imp","machine":"main","lifecycle":"active"}`,
	})
	f := costSwitchFixture(t, `"chiefOfStaff":"cos","peers":[{"name":"main","url":"`+main.URL+`","token":"test-peer-token"}]`)
	// child's parent is mid, an agent of main whose parent main listed as mgr.
	f.sql("UPDATE agents SET parent_id = 'amid' WHERE id = 'achild'")
	must(t, f.db.RememberPeerAgent(context.Background(), db.PeerAgentSeen{ID: "amid", Name: "mid", Machine: "main", Parents: []string{"amgr"}}))
	fwd := func(token, via string, extra map[string]string, body string) (int, string) {
		h := map[string]string{"X-Stam-Local": "1", "X-Stam-Agent": via}
		for k, v := range extra {
			h[k] = v
		}
		rec := f.sendH("POST", "/api/cost/switch", token, h, body)
		return rec.Code, rec.Body.String()
	}
	child := func(by string) string {
		return `{"agent":"achild","preset":"cheap","by":"` + by + `","soft_stop_minutes":0}`
	}
	// This fixture has no templates, so an admitted switch fails at the takeover prompt: past every permission check.
	const admitted = "switching child to cheap failed"

	if code, body := fwd(peerTok, "aother", nil, child("aother")); code != 403 || !strings.Contains(body, "may not manage cost for child's tree") {
		t.Errorf("an unrelated manager: %d %s", code, body)
	}
	if code, body := fwd(peerTok, "aghost", nil, child("aghost")); code != 404 || !strings.Contains(body, "no agent aghost") {
		t.Errorf("a manager no peer has: %d %s", code, body)
	}
	// The forward acts for other, so it can't name the chief of staff.
	if code, body := fwd(peerTok, "aother", nil, child("acos")); code < 400 || strings.Contains(body, admitted) {
		t.Errorf("a forward naming another manager: %d %s", code, body)
	}
	// A peer answering for another id under that ref is no match.
	if code, body := fwd(peerTok, "aimp", nil, child("aimp")); code != 404 {
		t.Errorf("a peer's other agent: %d %s", code, body)
	}
	if code, body := fwd(peerTok, "amgr", nil, child("amgr")); code != 400 || !strings.Contains(body, admitted) {
		t.Errorf("a grandparent through a peer's parents: %d %s", code, body)
	}
	if code, body := fwd(peerTok, "acos", nil, child("acos")); code != 400 || !strings.Contains(body, admitted) {
		t.Errorf("the chief of staff by name: %d %s", code, body)
	}
	if code, body := fwd(peerTok, "aother", map[string]string{"X-Stam-Agent-Assistant": "1"}, child("aother")); code != 400 || !strings.Contains(body, admitted) {
		t.Errorf("the assistant the peer vouches for: %d %s", code, body)
	}
	// Only the peer's forward names one: the peer token without x-stam-local is the shared token, which can't be amgr.
	rec := f.sendH("POST", "/api/cost/switch", peerTok, map[string]string{"X-Stam-Agent": "amgr"}, child("amgr"))
	if rec.Code != 403 || strings.Contains(rec.Body.String(), admitted) {
		t.Errorf("the peer token without x-stam-local: %d %s", rec.Code, rec.Body.String())
	}
}

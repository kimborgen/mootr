package server

import (
	"net/http"
	"strings"
	"testing"
)

// A box on another machine (src/daemon.ts mayActAsRemote, S-263): an agent here may read it only when the box's own daemon
// confirms, by answering a probe of the box's inbox as that agent. A refusal, a peer answering for another id, an agent no
// peer has and a peer that doesn't answer are each a 403, and so is the OpenCode server naming it. A peer's refusal that
// echoes a URL and a token, and a transport error naming the peer's address, show in neither the 403 nor the logs.
func TestRemoteBoxRead(t *testing.T) {
	const leakURL, leakTok = "https://sentinel.invalid/secret-path", "sentinel-token-value"
	logs := captureServerLogs(t)
	peerURL := ""
	far := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agents/bkid", "/api/agents/bstranger", "/api/agents/bdrop":
			id := strings.TrimPrefix(r.URL.Path, "/api/agents/")
			writeJSON(w, 200, map[string]any{"id": id, "name": id, "machine": "far", "lifecycle": "active"})
		case "/api/agents/bother":
			// A peer answering for an id that isn't the one asked.
			writeJSON(w, 200, map[string]any{"id": "bsomeone", "name": "bother", "machine": "far", "lifecycle": "active"})
		case "/api/agents/bkid/inbox":
			// A probe with no agent comes from the peer token alone, which a real peer takes as the shared token and
			// answers: only the caller check here refuses the OpenCode server.
			if a := r.Header.Get("X-Stam-Agent"); a == "achild" || a == "" {
				writeJSON(w, 200, []any{})
				return
			}
			writeError(w, Errorf(http.StatusForbidden, "no"))
		case "/api/agents/bother/inbox":
			// bother's would pass: only the id check refuses it.
			if r.Header.Get("X-Stam-Agent") == "achild" {
				writeJSON(w, 200, []any{})
				return
			}
			writeError(w, Errorf(http.StatusForbidden, "no"))
		case "/api/agents/bdrop/inbox":
			// The peer drops the probe's connection: no answer.
			if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
				conn.Close()
			}
		case "/api/agents/bstranger/inbox":
			// A refusal that echoes what it was sent, and more.
			writeError(w, Errorf(http.StatusForbidden, "no: %s %s/api Bearer %s %s", leakURL, peerURL, leakTok, peerTok))
		case "/api/agents/bsomeone/inbox":
			writeError(w, Errorf(http.StatusForbidden, "no"))
		default:
			writeError(w, Errorf(http.StatusNotFound, "no agent"))
		}
	}))
	peerURL = far.ts.URL
	f := relayFixture(t, far.ts.URL, "", nil)
	// secrets are what no answer or log may show: the sentinels, the tokens and the peer's address.
	secrets := []string{leakURL, leakTok, peerTok, sharedTok, far.ts.URL, strings.TrimPrefix(far.ts.URL, "http://")}
	read := func(token, box string) int {
		rec := f.sendH("GET", "/api/threads/m1?box="+box, token, nil, "")
		for _, x := range secrets {
			if strings.Contains(rec.Body.String(), x) {
				t.Errorf("box %s: the answer shows %q: %s", box, x, rec.Body.String())
			}
		}
		return rec.Code
	}
	if code := read(agentTok, "bkid"); code != 200 {
		t.Errorf("a box its daemon confirms: %d", code)
	}
	probe := far.last(t)
	for _, r := range far.seen() {
		if r.path == "/api/agents/bkid/inbox" {
			probe = r
		}
	}
	if probe.method != "GET" || probe.path != "/api/agents/bkid/inbox" || probe.query != "limit=0" || probe.header.Get("X-Stam-Agent") != "achild" || probe.header.Get("X-Stam-Local") != "1" {
		t.Errorf("the probe: %+v", probe)
	}
	for _, tc := range []struct{ name, token, box string }{
		{"a box its daemon refuses", agentTok, "bstranger"},
		{"a peer answering for another id", agentTok, "bother"},
		{"a box no peer has", agentTok, "bnobody"},
		{"a probe that gets no answer", agentTok, "bdrop"},
		{"the OpenCode server", serverTok, "bkid"},
	} {
		if code := read(tc.token, tc.box); code != 403 {
			t.Errorf("%s: %d", tc.name, code)
		}
	}
	far.ts.Close()
	if code := read(agentTok, "bkid"); code != 403 {
		t.Errorf("a peer that doesn't answer: %d", code)
	}
	for _, x := range secrets {
		if strings.Contains(logs.String(), x) {
			t.Errorf("the logs show %q", x)
		}
	}
}

// POST /api/push/notify: only a peer daemon relays a notification. An agent's token, with or without x-stam-local, and the
// shared token are refused; a peer's relay is 501 while the web push isn't ported.
func TestPushNotifyOnlyFromAPeer(t *testing.T) {
	f := newFixture(t, nil)
	body := `{"machine":"far","holder":"far","close":true,"thread_id":"m1","mail_ids":["m1"]}`
	for _, tc := range []struct {
		name, token string
		header      map[string]string
		code        int
	}{
		{"an agent", agentTok, nil, 403},
		{"an agent forging x-stam-local", agentTok, map[string]string{"X-Stam-Local": "1"}, 403},
		{"the shared token", sharedTok, nil, 403},
		{"a peer", peerTok, map[string]string{"X-Stam-Local": "1"}, 501},
	} {
		if rec := f.sendH("POST", "/api/push/notify", tc.token, tc.header, body); rec.Code != tc.code {
			t.Errorf("%s: %d %s", tc.name, rec.Code, rec.Body.String())
		}
	}
}

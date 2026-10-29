package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// wait_for on an agent of another machine (src/waits.ts peerTarget, S-275): a target a peer answers for, by name or id,
// takes the wait, and its one notice goes to that peer; the target's reply, forwarded here, clears the wait. With the
// peer down, a target this daemon has met before on a peer it still has takes the wait too. An archived target is
// refused, and so are one the peer answers it no longer has and one known only on a machine no longer in the settings.
func TestWaitForPeerTarget(t *testing.T) {
	var down atomic.Bool
	far := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if down.Load() {
			if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
				conn.Close()
			}
			return
		}
		switch r.URL.Path {
		case "/api/agents/bkid", "/api/agents/kidname":
			writeJSON(w, 200, map[string]any{"id": "bkid", "name": "kidname", "machine": "far", "lifecycle": "active"})
		case "/api/agents/bold":
			writeJSON(w, 200, map[string]any{"id": "bold", "name": "bold", "machine": "far", "lifecycle": "archived"})
		case "/api/agents/bkid/notice":
			writeJSON(w, 200, map[string]any{})
		default:
			writeError(w, Errorf(http.StatusNotFound, "no agent"))
		}
	}))
	f := relayFixture(t, far.ts.URL, "", nil)
	// The notice's text is the repo's own template.
	root := t.TempDir()
	tpl, err := os.ReadFile(filepath.Join("..", "..", "..", "templates", "wait-for.md"))
	must(t, err)
	must(t, os.MkdirAll(filepath.Join(root, "templates"), 0o700))
	must(t, os.WriteFile(filepath.Join(root, "templates", "wait-for.md"), tpl, 0o600))
	withLifeRoot(f, root)
	f.srv.life.SetTellPeer(f.srv.tellWhere)
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'idle' WHERE id = 'achild'")
	declare := func(target string) (int, string) {
		rec := f.sendH("POST", "/api/agents/achild/waits/declared", agentTok, nil, `{"on":"agent","target":"`+target+`","by":"achild"}`)
		return rec.Code, rec.Body.String()
	}

	code, body := declare("kidname")
	if code != 200 {
		t.Fatalf("a target on far, by name: %d %s", code, body)
	}
	if got := f.text("SELECT target || ' ' || detail FROM waits WHERE agent_id = 'achild'"); got != "bkid reply from kidname" {
		t.Errorf("the wait: %q", got)
	}
	notice := func() string {
		for _, r := range far.seen() {
			if r.method == "POST" && r.path == "/api/agents/bkid/notice" {
				return r.body
			}
		}
		return ""
	}
	for deadline := time.Now().Add(5 * time.Second); notice() == "" && time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
	}
	if n := notice(); !strings.Contains(n, "child is waiting for your reply") {
		t.Errorf("far's notice for bkid: %q", n)
	}
	// The reply, forwarded from far, clears it.
	reply := `{"from":"bkid","to":["achild"],"subject":"reply","body":"here","forwarded":{"from_name":"kidname"},"mail_id":"m00a0001","thread_id":"m00a0001"}`
	if rec := f.sendH("POST", "/api/mail", peerTok, peerLocal, reply); rec.Code != 200 {
		t.Fatalf("the forwarded reply: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild'"); n != 0 {
		t.Errorf("the reply left %d waits", n)
	}

	if code, body := declare("bold"); code != 400 || !strings.Contains(body, "no agent bold (archived)") {
		t.Errorf("an archived target on far: %d %s", code, body)
	}
	if code, body := declare("bnobody"); code != 400 || !strings.Contains(body, "no agent bnobody") {
		t.Errorf("a target nobody has: %d %s", code, body)
	}
	// Met before, but far answers it has no such agent now: no agent.
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('bstale', 'stale-one', 'far', '2026-10-01T00:00:00.000Z')")
	if code, body := declare("stale-one"); code != 400 || !strings.Contains(body, "no agent stale-one") {
		t.Errorf("a target met before that far no longer has: %d %s", code, body)
	}

	// far is down: met before, on far, it takes the wait by id; archived when last seen, it is refused.
	down.Store(true)
	if code, body := declare("bkid"); code != 200 {
		t.Errorf("a target met before, its peer down: %d %s", code, body)
	}
	f.sql("INSERT INTO peer_agents (id, name, machine, lifecycle, updated_at) VALUES ('bgone', 'gone-one', 'far', 'archived', '2026-10-01T00:00:00.000Z')")
	if code, body := declare("gone-one"); code != 400 || !strings.Contains(body, "no agent gone-one (archived)") {
		t.Errorf("an archived target met before, its peer down: %d %s", code, body)
	}
	if code, body := declare("bnobody"); code != 400 || !strings.Contains(body, "no agent bnobody") {
		t.Errorf("a target nobody has, a peer down: %d %s", code, body)
	}
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('belse', 'else-one', 'elsewhere', '2026-10-01T00:00:00.000Z')")
	if code, body := declare("else-one"); code != 400 || !strings.Contains(body, "no agent else-one") {
		t.Errorf("a target met before on a machine no longer in the settings, a peer down: %d %s", code, body)
	}
}

// A target name two peers each answer for, with different ids, is ambiguous: a 409 that names both, and no wait.
func TestWaitForPeerTargetAmbiguous(t *testing.T) {
	answer := func(id string) *peerServer {
		return newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/agents/dup" {
				writeJSON(w, 200, map[string]any{"id": id, "name": "dup", "lifecycle": "active"})
				return
			}
			writeError(w, Errorf(http.StatusNotFound, "no agent"))
		}))
	}
	one, two := answer("bone"), answer("btwo")
	f := relayFixture(t, one.ts.URL, "", nil)
	peer := func(name, url string) string {
		return `{"name":"` + name + `","url":"` + url + `","token":"` + sharedTok + `","peerToken":"` + peerTok + `"}`
	}
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"peers":[`+peer("far", one.ts.URL)+`,`+peer("yon", two.ts.URL)+`]}`), 0o600))
	withLife(f)
	rec := f.sendH("POST", "/api/agents/achild/waits/declared", agentTok, nil, `{"on":"agent","target":"dup","by":"achild"}`)
	if rec.Code != 409 || !strings.Contains(rec.Body.String(), "bone") || !strings.Contains(rec.Body.String(), "btwo") {
		t.Errorf("an ambiguous target: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.count("SELECT count(*) FROM waits"); n != 0 {
		t.Errorf("an ambiguous target left %d waits", n)
	}
}

// The memory of an agent on a peer stands in for that peer only while it doesn't answer: with far answering it has no
// such agent and yon down, an agent remembered on far is no agent, though one remembered on yon takes the wait. With both
// down, a name remembered for two live agents, one on each, is ambiguous. A refusal writes no wait, nudge or event.
func TestWaitForPeerTargetCached(t *testing.T) {
	var farDown atomic.Bool
	peer := func(down func() bool) *peerServer {
		return newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if down() {
				if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
					conn.Close()
				}
				return
			}
			writeError(w, Errorf(http.StatusNotFound, "no agent"))
		}))
	}
	far, yon := peer(farDown.Load), peer(func() bool { return true })
	f := relayFixture(t, far.ts.URL, "", nil)
	cfg := func(name, url string) string {
		return `{"name":"` + name + `","url":"` + url + `","token":"` + sharedTok + `","peerToken":"` + peerTok + `"}`
	}
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"peers":[`+cfg("far", far.ts.URL)+`,`+cfg("yon", yon.ts.URL)+`]}`), 0o600))
	withLife(f)
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'idle' WHERE id = 'achild'")
	f.sql(`INSERT INTO peer_agents (id, name, machine, lifecycle, updated_at) VALUES
		('bfar', 'far-one', 'far', 'active', '2026-10-01T00:00:00.000Z'),
		('byon', 'yon-one', 'yon', 'active', '2026-10-01T00:00:00.000Z'),
		('bdup1', 'dup', 'far', 'active', '2026-10-01T00:00:00.000Z'),
		('bdup2', 'dup', 'yon', 'active', '2026-10-01T00:00:00.000Z')`)
	declare := func(target string) (int, string) {
		rec := f.sendH("POST", "/api/agents/achild/waits/declared", agentTok, nil, `{"on":"agent","target":"`+target+`","by":"achild"}`)
		return rec.Code, rec.Body.String()
	}
	none := func(what string) {
		t.Helper()
		for _, q := range []string{"SELECT count(*) FROM waits", "SELECT count(*) FROM wait_nudges", "SELECT count(*) FROM events WHERE type = 'wait:nudged'"} {
			if n := f.count(q); n != 0 {
				t.Errorf("%s: %s is %d", what, q, n)
			}
		}
	}

	for _, ref := range []string{"far-one", "bfar"} {
		if code, body := declare(ref); code != 400 || !strings.Contains(body, "no agent "+ref) {
			t.Errorf("%s, remembered on far, which answers it has none, yon down: %d %s", ref, code, body)
		}
	}
	none("far answers it has none")
	if code, body := declare("yon-one"); code != 200 {
		t.Errorf("yon-one, remembered on yon, which is down: %d %s", code, body)
	}
	f.sql("DELETE FROM waits")
	f.sql("DELETE FROM wait_nudges")
	f.sql("DELETE FROM events")

	farDown.Store(true)
	if code, body := declare("dup"); code != 409 || !strings.Contains(body, "bdup1") || !strings.Contains(body, "bdup2") {
		t.Errorf("dup, remembered on both, both down: %d %s", code, body)
	}
	none("an ambiguous remembered name")
	if code, body := declare("bdup2"); code != 200 {
		t.Errorf("bdup2 by id, both down: %d %s", code, body)
	}
}

// A remote target gets its one notice after the wait is committed, and a repeated declare sends no second one.
func TestWaitForPeerTargetNoticeOnce(t *testing.T) {
	var rows atomic.Pointer[func() int]
	var committed atomic.Int64
	committed.Store(-1)
	far := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agents/bkid", "/api/agents/kidname":
			writeJSON(w, 200, map[string]any{"id": "bkid", "name": "kidname", "machine": "far", "lifecycle": "active"})
		case "/api/agents/bkid/notice":
			committed.Store(int64((*rows.Load())()))
			writeJSON(w, 200, map[string]any{})
		default:
			writeError(w, Errorf(http.StatusNotFound, "no agent"))
		}
	}))
	f := relayFixture(t, far.ts.URL, "", nil)
	count := func() int { return f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild' AND target = 'bkid'") }
	rows.Store(&count)
	root := t.TempDir()
	tpl, err := os.ReadFile(filepath.Join("..", "..", "..", "templates", "wait-for.md"))
	must(t, err)
	must(t, os.MkdirAll(filepath.Join(root, "templates"), 0o700))
	must(t, os.WriteFile(filepath.Join(root, "templates", "wait-for.md"), tpl, 0o600))
	withLifeRoot(f, root)
	f.srv.life.SetTellPeer(f.srv.tellWhere)
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'idle' WHERE id = 'achild'")
	for i := 0; i < 2; i++ {
		if rec := f.sendH("POST", "/api/agents/achild/waits/declared", agentTok, nil, `{"on":"agent","target":"kidname","by":"achild"}`); rec.Code != 200 {
			t.Fatalf("declare %d: %d %s", i, rec.Code, rec.Body.String())
		}
		// The first notice lands before the second declare, so the rows it sees are the first declare's alone.
		for deadline := time.Now().Add(5 * time.Second); i == 0 && committed.Load() == -1 && time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		}
	}
	// Every notice the declares started has been sent once the background work ends.
	f.srv.life.Wait()
	n := 0
	for _, r := range far.seen() {
		if r.method == "POST" && r.path == "/api/agents/bkid/notice" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("far got %d notices for two declares", n)
	}
	if c := committed.Load(); c != 1 {
		t.Errorf("the wait rows when far got the notice: %d", c)
	}
}

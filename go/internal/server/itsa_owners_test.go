package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"stam/internal/jsfmt"
)

// farPeer is a peer daemon holding the agents in agents (id to its JSON), recording the notices and owner-stopped reports
// it is sent.
type farPeer struct {
	*httptest.Server
	mu   sync.Mutex
	got  []string
	fail bool
}

func newFarPeer(t *testing.T, agents map[string]string) *farPeer {
	p := &farPeer{}
	p.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		path := r.URL.Path
		switch {
		case r.Method == "POST" && (strings.HasSuffix(path, "/notice") || path == "/api/itsas/owner-stopped"):
			p.mu.Lock()
			p.got = append(p.got, path+" "+string(b))
			fail := p.fail
			p.mu.Unlock()
			if fail {
				w.WriteHeader(http.StatusForbidden)
				io.WriteString(w, `{"error":"no"}`)
				return
			}
			io.WriteString(w, `{"ok":true}`)
		case r.Method == "GET" && strings.HasPrefix(path, "/api/agents/"):
			if a, ok := agents[strings.TrimPrefix(path, "/api/agents/")]; ok {
				io.WriteString(w, a)
				return
			}
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, `{"error":"no agent"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(p.Close)
	return p
}

func (p *farPeer) received() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.got...)
}

// TestItsaOwnerNotices: a child ITSA that closes, blocks or waits on the human tells its parent's owner, once per change;
// a quiet move, a change the owner made, a human-owned parent and ownerNotices off tell nobody.
func TestItsaOwnerNotices(t *testing.T) {
	f := newFixture(t, nil)
	n := &notices{}
	f.srv.noticeHook = n.add
	parent := f.createItsa(`{"title":"parent","owner":"boss"}`)
	kid := f.createItsa(`{"title":"kid","parent":"` + parent + `"}`)
	pk, kk := parent, kid
	want := func(status, why string) string {
		return "aboss: [stam] ITSA " + kk + ` "kid", a child of your ` + pk + ", is now " + status + why + ". Look at it with `itsa_get " + kk + "` if it needs you."
	}
	if rec := f.post2("PATCH", "/api/itsas/"+kid, `{"status":"blocked"}`); rec.Code != 200 {
		t.Fatalf("blocked: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the blocked notice", func() bool { return len(n.all()) == 1 })
	if got := n.all()[0]; got != want("blocked", "") {
		t.Errorf("blocked:\n got %s\nwant %s", got, want("blocked", ""))
	}
	f.post2("PATCH", "/api/itsas/"+kid, `{"status":"in_progress"}`)
	f.post2("PATCH", "/api/itsas/"+kid, `{"status":"done"}`)
	until(t, "the closed notice", func() bool { return len(n.all()) == 2 })
	if got := n.all()[1]; got != want("done", " (closed)") {
		t.Errorf("closed: %s", got)
	}
	// Created into a closed status under the parent.
	if rec := f.post2("POST", "/api/itsas", `{"title":"born closed","parent":"`+parent+`","status":"done"}`); rec.Code != 200 {
		t.Fatalf("born closed: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the created notice", func() bool { return len(n.all()) == 3 })
	// Told nothing, checked in step: the owner's own change, notices off, an owner not running, and a human-owned parent.
	ctx := context.Background()
	x, _, err := f.db.FindItsa(ctx, kid)
	must(t, err)
	quiet := func(what string, x jsfmt.Value, actor string) {
		t.Helper()
		before := len(n.all())
		must(t, f.srv.tellParentOwner(ctx, x, actor, ""))
		if got := n.all(); len(got) != before {
			t.Errorf("%s told: %q", what, got[before:])
		}
	}
	quiet("the owner's own change", x, "aboss")
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"itsa":{"ownerNotices":"off"}}`)
	quiet("notices off", x, "human")
	writeFile(t, filepath.Join(f.home, "settings.json"), `{}`)
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'aboss'")
	quiet("a shut-down owner", x, "human")
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id = 'aboss'")
	// A human-owned parent, and notices off.
	hp := f.createItsa(`{"title":"hp","owner":"human"}`)
	hk := f.createItsa(`{"title":"hk","parent":"` + hp + `"}`)
	f.post2("PATCH", "/api/itsas/"+hk, `{"status":"blocked"}`)
	hx, _, err := f.db.FindItsa(ctx, hk)
	must(t, err)
	quiet("a human-owned parent", hx, "achild")
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"itsa":{"ownerNotices":"off"}}`)
	f.post2("PATCH", "/api/itsas/"+kid, `{"status":"blocked"}`)
	// With notices off, the change starts no notice at all: checked in step, not by timing.
	if x, _, err = f.db.FindItsa(ctx, kid); err != nil {
		t.Fatal(err)
	}
	if f.srv.ownerStatusNotice(ctx, x, "human") {
		t.Error("notices off started a notice")
	}
	// A later notice proves the ones before it were handled: each runs on its own goroutine.
	writeFile(t, filepath.Join(f.home, "settings.json"), `{}`)
	f.post2("PATCH", "/api/itsas/"+kid, `{"status":"in_progress"}`)
	f.post2("PATCH", "/api/itsas/"+kid, `{"status":"done"}`)
	until(t, "the last notice", func() bool { return len(n.all()) >= 4 })
	if got := n.all(); len(got) != 4 {
		t.Errorf("notices %q", got)
	}
}

// TestItsaOwnerPeer: a parent owned by an agent on a peer gets the notice through that peer's daemon; one the peer
// doesn't hold, or a peer that is down, gets nothing and fails nothing.
func TestItsaOwnerPeer(t *testing.T) {
	far := newFarPeer(t, map[string]string{"afar1": `{"id":"afar1","name":"far","machine":"elsewhere","lifecycle":"active"}`})
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"peers":[{"name":"elsewhere","url":"`+far.URL+`","token":"test-peer-token"}]}`)
	parent := f.createItsa(`{"title":"parent"}`)
	f.sql("UPDATE itsas SET owner = 'afar1' WHERE key = ?", parent)
	kid := f.createItsa(`{"title":"kid","parent":"` + parent + `"}`)
	if rec := f.post2("PATCH", "/api/itsas/"+kid, `{"status":"blocked"}`); rec.Code != 200 {
		t.Fatalf("blocked: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the peer's notice", func() bool { return len(far.received()) == 1 })
	if got := far.received()[0]; !strings.HasPrefix(got, "/api/agents/afar1/notice ") || !strings.Contains(got, "is now blocked.") {
		t.Errorf("sent %s", got)
	}
	// The peer down: the write still succeeds.
	far.Close()
	if rec := f.post2("PATCH", "/api/itsas/"+kid, `{"status":"done"}`); rec.Code != 200 {
		t.Errorf("done with the peer down: %d %s", rec.Code, rec.Body.String())
	}
}

// TestOwnerStopped: on the ITSA home, an owner that stopped tells the owner of each parent, once with all its open
// children there; off the home, the home is told.
func TestOwnerStopped(t *testing.T) {
	f := newFixture(t, nil)
	n := &notices{}
	f.srv.noticeHook = n.add
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"itsa":{"home":"`+f.cfg.Machine+`"}}`)
	parent := f.createItsa(`{"title":"parent","owner":"boss"}`)
	for _, body := range []string{
		`{"title":"one","owner":"child","parent":"` + parent + `"}`,
		`{"title":"two","owner":"child","parent":"` + parent + `"}`,
		`{"title":"shut","owner":"child","parent":"` + parent + `","status":"done"}`,
		`{"title":"loose","owner":"child"}`,
	} {
		f.createItsa(body)
	}
	pk := parent
	k1, k2 := f.count1("SELECT key FROM itsas WHERE title = 'one'"), f.count1("SELECT key FROM itsas WHERE title = 'two'")
	// The create of "shut" (closed, under boss's parent) tells boss on its own goroutine: wait for it, so the stop
	// notice is the second.
	until(t, "the close notice", func() bool { return len(n.all()) == 1 })
	f.srv.ownerStopped(context.Background(), "achild", "child", "errored")
	want := "aboss: [stam] child errored. These are children of your " + pk + ": " + k1 + ` "one" (backlog), ` + k2 + ` "two" (backlog).`
	until(t, "the stop notice", func() bool { return len(n.all()) == 2 })
	if got := n.all()[1]; got != want {
		t.Errorf("stop:\n got %s\nwant %s", got, want)
	}
	// Off the home: the home hears.
	far := newFarPeer(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"itsa":{"home":"farhome"},"peers":[{"name":"farhome","url":"`+far.URL+`","token":"test-peer-token"}]}`)
	f.srv.ownerStopped(context.Background(), "achild", "child", "was shut down")
	if got := far.received(); len(got) != 1 || got[0] != `/api/itsas/owner-stopped {"id":"achild","name":"child","what":"was shut down"}` {
		t.Errorf("the home heard %q", got)
	}
}

// TestTellWhere: the outcome of a notice: told here or through the peer that holds the agent, which a mode the agent's own
// record doesn't want skips; absent when every peer says no such agent; unreachable while a peer may hold it but doesn't
// answer; an error when the peer refuses.
func TestTellWhere(t *testing.T) {
	far := newFarPeer(t, map[string]string{
		"afar1": `{"id":"afar1","name":"far","machine":"elsewhere","lifecycle":"active","child_notices":"none"}`,
		"afar2": `{"id":"afar2","name":"far2","machine":"elsewhere","lifecycle":"active"}`,
	})
	f := newFixture(t, nil)
	n := &notices{}
	f.srv.noticeHook = n.add
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"peers":[{"name":"elsewhere","url":"`+far.URL+`","token":"test-peer-token"}]}`)
	ctx := context.Background()
	check := func(id, want, outcome string) {
		t.Helper()
		got, err := f.srv.tellWhere(ctx, id, "hi", want)
		if err != nil || got != outcome {
			t.Errorf("%s (%s): %s %v, want %s", id, want, got, err, outcome)
		}
	}
	check("afar1", "tree-idle", "told")
	check("afar2", "tree-idle", "told")
	check("anobody", "", "absent")
	if got := far.received(); len(got) != 1 || !strings.HasPrefix(got[0], "/api/agents/afar2/notice ") {
		t.Errorf("the peer got %q", got)
	}
	// Here, the agent's own mode counts the same way.
	f.sql("UPDATE agents SET child_notices = 'none' WHERE id = 'aboss'")
	check("aboss", "tree-idle", "told")
	check("achild", "tree-idle", "told")
	if got := n.all(); len(got) != 1 || got[0] != "achild: hi" {
		t.Errorf("here %q", got)
	}
	far.mu.Lock()
	far.fail = true
	far.mu.Unlock()
	if _, err := f.srv.tellWhere(ctx, "afar2", "hi", ""); err == nil || !strings.Contains(err.Error(), "refused") {
		t.Errorf("a refusal: %v", err)
	}
	far.Close()
	check("anobody", "", "unreachable")
}

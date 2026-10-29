package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// stubHome is an ITSA home that records each call (method, path, the forwarded agent and the body) and answers each path
// with the status and body set for it, else 404.
type stubHome struct {
	*httptest.Server
	mu      sync.Mutex
	calls   []string
	answers map[string]stubAnswer
}

type stubAnswer struct {
	status int
	body   string
}

func newStubHome(t *testing.T) *stubHome {
	h := &stubHome{answers: map[string]stubAnswer{}}
	h.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		key := r.Method + " " + r.URL.Path
		h.mu.Lock()
		h.calls = append(h.calls, key+" via="+r.Header.Get("X-Stam-Agent")+" "+string(b))
		a, ok := h.answers[key]
		h.mu.Unlock()
		if !ok {
			a = stubAnswer{404, `{"error":"no route"}`}
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(a.status)
		io.WriteString(w, a.body)
	}))
	t.Cleanup(h.Close)
	return h
}

func (h *stubHome) answer(key string, status int, body string) {
	h.mu.Lock()
	h.answers[key] = stubAnswer{status, body}
	h.mu.Unlock()
}

// got is the calls to key so far.
func (h *stubHome) got(key string) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, c := range h.calls {
		if strings.HasPrefix(c, key+" ") {
			out = append(out, c)
		}
	}
	return out
}

func offHomeSettings(h *stubHome, extra string) string {
	return `{` + extra + `"itsa":{"home":"homebox"},"peers":[{"name":"homebox","url":"` + h.URL + `","token":"test-peer-token"}]}`
}

// Off the ITSA home a spawn's ITSA steps are asked of the home, as the agent asking for the spawn (src/itsa-owners.ts):
// the ITSA it owns (its view, then the owner set by compare on the home), the ITSAs it joins (may-participate, join), and
// its parent's open ITSA. The home's refusal is the spawn's 403, before the agent runs.
func TestSpawnOffHome(t *testing.T) {
	h := newStubHome(t)
	f := spawnFixture(t)
	f.setProcessSettings(offHomeSettings(h, ""))

	// The parent's ITSA, joined through the home in the background.
	h.answer("POST /api/itsas/join-parent", 200, `{"key":"S-3"}`)
	id, _ := f.spawned(bossTok, `"name":"h1","by":"aboss"`)
	until(t, "the parent join on the home", func() bool { return len(h.got("POST /api/itsas/join-parent")) == 1 })
	if got := h.got("POST /api/itsas/join-parent")[0]; !strings.Contains(got, `"agent":"`+id+`"`) || !strings.Contains(got, `"parent":"aboss"`) {
		t.Errorf("join-parent %s", got)
	}

	// The ITSA the spawn names: read from the home, then the owner set there as the asking agent.
	h.answer("GET /api/itsas/S-7", 200, `{"id":"ix7","key":"S-7","title":"far work","status":"in_progress","owner":"aold","summary":null,"body":"","parent_chain":[],"links":[]}`)
	h.answer("PATCH /api/itsas/ix7", 200, `{"itsa":{"id":"ix7","owner":"anew"},"changes":{"owner":{"from":"aold","to":"anew"}}}`)
	id2, _ := f.spawned(bossTok, `"name":"h2","by":"aboss","itsa":"S-7"`)
	patch := h.got("PATCH /api/itsas/ix7")
	if len(patch) != 1 || !strings.Contains(patch[0], "via=aboss ") || !strings.Contains(patch[0], `"owner":"`+id2+`"`) || !strings.Contains(patch[0], `"by":"aboss"`) {
		t.Errorf("the owner on the home: %q", patch)
	}
	if got := f.text("SELECT first_prompt FROM agents WHERE id = ?", id2); !strings.Contains(got, "S-7") || !strings.Contains(got, "far work") {
		t.Errorf("the first prompt doesn't name S-7: %q", got)
	}

	// The home refuses the owner: the spawn is refused.
	h.answer("PATCH /api/itsas/ix7", 403, `{"error":"boss may not change S-7"}`)
	if rec := f.spawn(bossTok, `"name":"h3","by":"aboss","itsa":"S-7"`); rec.Code != 403 || !strings.Contains(rec.Body.String(), "boss may not change S-7") {
		t.Errorf("a refused owner: %d %s", rec.Code, rec.Body.String())
	}

	// participate: the home says no before any row.
	h.answer("POST /api/itsas/may-participate", 403, `{"error":"no"}`)
	if rec := f.spawn(bossTok, `"name":"h4","by":"aboss","participate":["S-8"]`); rec.Code != 403 {
		t.Errorf("a refused participate: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.db.GetAgent(context.Background(), "h4"); err == nil {
		t.Error("the refused spawn made a row")
	}
	if got := h.got("POST /api/itsas/may-participate"); len(got) != 1 || !strings.Contains(got[0], "via=aboss ") || !strings.Contains(got[0], `"itsa":"S-8"`) {
		t.Errorf("may-participate %q", got)
	}
	// It says yes: the agent joins on the home.
	h.answer("POST /api/itsas/may-participate", 200, `{"ok":true}`)
	h.answer("POST /api/itsas/join", 200, `{"ok":true}`)
	id5, _ := f.spawned(bossTok, `"name":"h5","by":"aboss","participate":["S-8"]`)
	if got := h.got("POST /api/itsas/join"); len(got) != 1 || !strings.Contains(got[0], "via=aboss ") || !strings.Contains(got[0], `"agent":"`+id5+`"`) {
		t.Errorf("join %q", got)
	}

	// A home error that echoes the home's address names the home instead, refused (403) or not.
	host := strings.TrimPrefix(h.URL, "http://")
	for _, status := range []int{403, 500} {
		h.answer("POST /api/itsas/may-participate", status, `{"error":"no at `+h.URL+`/api/itsas (`+host+`)"}`)
		rec := f.spawn(bossTok, `"name":"h6","by":"aboss","participate":["S-8"]`)
		if body := rec.Body.String(); rec.Code < 400 || strings.Contains(body, host) || !strings.Contains(body, "no at homebox/api/itsas (homebox)") {
			t.Errorf("%d echoed: %d %s", status, rec.Code, body)
		}
	}
}

// Off the ITSA home with ITSAs not required, a spawn with a parent joins no ITSA and never asks the home.
func TestSpawnOffHomeNotRequired(t *testing.T) {
	h := newStubHome(t)
	f := spawnFixture(t)
	f.setProcessSettings(`{"itsa":{"home":"homebox","required":false},"peers":[{"name":"homebox","url":"` + h.URL + `","token":"test-peer-token"}]}`)
	f.spawned(bossTok, `"name":"h1","by":"aboss"`)
	if got := h.got("POST /api/itsas/join-parent"); len(got) != 0 {
		t.Errorf("asked the home: %q", got)
	}
}

// Off the ITSA home a forgotten or archived agent's unown is queued, then sent to the home; the row goes only when the home
// takes it. A forget waits for it. The retry sends what is left, drops a row whose agent runs again or a forget that was
// refused and left the agent here, and gives up on one the home refuses for good.
func TestUnownOffHome(t *testing.T) {
	t.Setenv("STAM_ITSA_RETRY_MS", "1")
	h := newStubHome(t)
	f := spawnFixture(t)
	f.setProcessSettings(offHomeSettings(h, ""))
	ctx := context.Background()
	rows := func() string {
		return f.text("SELECT ifnull(group_concat(agent_id || ':' || how), '') FROM itsa_pending_unown")
	}

	// The home takes it: the forget goes on, and no row is left.
	h.answer("POST /api/itsas/unown-agent", 200, `{}`)
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'agone'")
	if rec := f.post2("POST", "/api/agents/agone/forget", `{}`); rec.Code != 200 {
		t.Fatalf("forget: %d %s", rec.Code, rec.Body.String())
	}
	if got := h.got("POST /api/itsas/unown-agent"); len(got) != 1 || !strings.Contains(got[0], `"id":"agone"`) || !strings.Contains(got[0], `"how":"forgotten"`) {
		t.Errorf("unown-agent %q", got)
	}
	if got := rows(); got != "" {
		t.Errorf("rows left %q", got)
	}

	// The home is down: the forget is refused and the agent kept.
	h.answer("POST /api/itsas/unown-agent", 503, `{"error":"no peer answered; try again"}`)
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'acodex'")
	if rec := f.post2("POST", "/api/agents/acodex/forget", `{}`); rec.Code == 200 {
		t.Fatalf("forget with the home down: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := f.db.GetAgent(ctx, "acodex"); err != nil {
		t.Fatal("the refused forget removed the agent")
	}
	if got := rows(); got != "acodex:forgotten" {
		t.Errorf("rows %q", got)
	}
	// The retry: a forget that was refused left the agent, so its row goes without a send.
	sent := len(h.got("POST /api/itsas/unown-agent"))
	f.srv.retryPendingUnowns(ctx)
	if got := rows(); got != "" || len(h.got("POST /api/itsas/unown-agent")) != sent {
		t.Errorf("after the retry: rows %q, %d sends", got, len(h.got("POST /api/itsas/unown-agent"))-sent)
	}

	// An archive's row, the home down: kept, then sent once the home answers.
	f.sql("UPDATE agents SET lifecycle = 'archived', type = 'developer' WHERE id = 'achild'")
	must(t, f.db.QueueUnown(ctx, "achild", "child", "archived", strPtr("developer")))
	f.srv.retryPendingUnowns(ctx)
	if got := rows(); got != "achild:archived" {
		t.Fatalf("a failed send dropped the row: %q", got)
	}
	h.answer("POST /api/itsas/unown-agent", 200, `{}`)
	until(t, "the retry's send", func() bool { f.srv.retryPendingUnowns(ctx); return rows() == "" })
	last := h.got("POST /api/itsas/unown-agent")
	if got := last[len(last)-1]; !strings.Contains(got, `"id":"achild"`) || !strings.Contains(got, `"how":"archived"`) || !strings.Contains(got, `"type":"developer"`) || !strings.Contains(got, `"parent":"aboss"`) {
		t.Errorf("the retried unown %s", got)
	}

	// The home refuses it for good: the row is given up.
	must(t, f.db.QueueUnown(ctx, "achild", "child", "archived", nil))
	h.answer("POST /api/itsas/unown-agent", 403, `{"error":"only a peer holding that archived agent can unown its ITSAs"}`)
	f.srv.retryPendingUnowns(ctx)
	if got := rows(); got != "" {
		t.Errorf("a refused row stays: %q", got)
	}

	// The agent runs again: its row goes without a send.
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id = 'achild'")
	must(t, f.db.QueueUnown(ctx, "achild", "child", "archived", nil))
	sent = len(h.got("POST /api/itsas/unown-agent"))
	f.srv.retryPendingUnowns(ctx)
	if got := rows(); got != "" || len(h.got("POST /api/itsas/unown-agent")) != sent {
		t.Errorf("a running agent's row: %q, %d sends", got, len(h.got("POST /api/itsas/unown-agent"))-sent)
	}
}

// A retry pass that runs between a forget's queue and its send leaves that row to the forget: it would read it as a
// refused forget and drop it, and the forget would then go on without the home. The home is down, so the forget is
// refused once the home was asked; only then does the retry drop the row.
func TestUnownForgetRace(t *testing.T) {
	h := newStubHome(t)
	f := spawnFixture(t)
	f.setProcessSettings(offHomeSettings(h, ""))
	ctx := context.Background()
	h.answer("POST /api/itsas/unown-agent", 503, `{"error":"no peer answered; try again"}`)
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'agone'")
	f.srv.unowns.queued = func() { f.srv.retryPendingUnowns(ctx) }
	rec := f.post2("POST", "/api/agents/agone/forget", `{}`)
	f.srv.unowns.queued = nil
	if rec.Code == 200 {
		t.Fatalf("the forget went on with the home down: %s", rec.Body.String())
	}
	if _, err := f.db.GetAgent(ctx, "agone"); err != nil {
		t.Fatal("the refused forget removed the agent")
	}
	if got := h.got("POST /api/itsas/unown-agent"); len(got) != 1 || !strings.Contains(got[0], `"id":"agone"`) {
		t.Errorf("the forget didn't ask the home: %q", got)
	}
	rows := func() string {
		return f.text("SELECT ifnull(group_concat(agent_id || ':' || how), '') FROM itsa_pending_unown")
	}
	if got := rows(); got != "agone:forgotten" {
		t.Errorf("rows %q", got)
	}
	f.srv.retryPendingUnowns(ctx)
	if got := rows(); got != "" {
		t.Errorf("the refused forget's row stays: %q", got)
	}
	// A send with no row queued fails closed: it is never a send that went through.
	if err := f.srv.sendUnown(ctx, "agone"); err == nil {
		t.Error("a send with no row queued succeeded")
	}
}

// The other order: an unown that starts while a retry pass holds its agent waits for the pass to end, so the pass can't
// drop the unown's row mid-way; a retry pass skips an agent an unown holds. A panicking row still releases its claim.
func TestUnownClaimBothWays(t *testing.T) {
	var u unownRetry
	release, ok := u.claim("a", true)
	if !ok {
		t.Fatal("a free agent wasn't claimed")
	}
	got := make(chan func())
	go func() { r, _ := u.claim("a", false); got <- r }()
	select {
	case <-got:
		t.Fatal("an unown entered while a retry pass held its agent")
	case <-time.After(100 * time.Millisecond):
	}
	release()
	var second func()
	select {
	case second = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("the unown never got its claim")
	}
	if _, ok := u.claim("a", true); ok {
		t.Error("a retry pass entered while an unown held its agent")
	}
	second()

	h := newStubHome(t)
	f := spawnFixture(t)
	f.setProcessSettings(offHomeSettings(h, ""))
	ctx := context.Background()
	f.sql("UPDATE agents SET lifecycle = 'archived' WHERE id = 'achild'")
	must(t, f.db.QueueUnown(ctx, "achild", "child", "archived", nil))
	f.srv.unowns.claimed = func(string) { panic("row") }
	func() {
		defer func() { _ = recover() }()
		f.srv.retryPendingUnowns(ctx)
	}()
	f.srv.unowns.claimed = nil
	if _, ok := f.srv.unowns.claim("achild", true); !ok {
		t.Error("a panicking row kept its claim")
	}
}

// GET /api/itsas/:id/incident (S-3324): a mark on the ITSA or an ancestor, read on the home; off the home it is the home's
// answer.
func TestItsaIncidentRoute(t *testing.T) {
	f := newFixture(t, nil)
	epic := f.createItsa(`{"title":"epic"}`)
	kid := f.createItsa(`{"title":"kid","parent":"` + epic + `"}`)
	marked := func(f *fixture, ref string) string {
		rec := f.do(call{path: "/api/itsas/" + ref + "/incident", token: sharedTok})
		return rec.Body.String()
	}
	if got := marked(f, kid); got != `{"marked":false}` {
		t.Errorf("unmarked: %s", got)
	}
	f.sql("UPDATE itsas SET incident = 1 WHERE key = ?", epic)
	if got := marked(f, kid); got != `{"marked":true}` {
		t.Errorf("an ancestor's mark: %s", got)
	}

	// Off the home the route is the home's: it is proxied there, like every ITSA route.
	h := newStubHome(t)
	g := newFixture(t, nil)
	writeFile(t, g.home+"/settings.json", offHomeSettings(h, ""))
	h.answer("GET /api/itsas/S-4/incident", 200, `{"marked":true}`)
	if got := marked(g, "S-4"); got != `{"marked":true}` {
		t.Errorf("off the home: %s", got)
	}
	if got := h.got("GET /api/itsas/S-4/incident"); len(got) != 1 {
		t.Errorf("asks of the home: %q", got)
	}
}

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
	"time"
)

// TestCostSwitchRoute: POST /api/cost/switch switches for the agent named (by) or the human with no by; a caller that is
// neither, and a manager outside the tree, get a 403, an unknown agent a 404, and any other refusal or failure a 400,
// with the switch's own message. A working agent's switch answers quiescing at once and goes on in the background,
// where its failure reaches the manager.
func TestCostSwitchRoute(t *testing.T) {
	f := newFixture(t, nil)
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "registry"), 0o700))
	must(t, os.WriteFile(filepath.Join(root, "registry", "defaults.json"), []byte(`{"presets":{"cheap":{"harness":"claude","model":"cheap-model"}}}`), 0o600))
	withLifeRoot(f, root)
	// withLifeRoot gives the server its lifecycle after New: the cost mail is wired here.
	f.srv.life.SetCostMail(f.srv.sendFromSystemMail, f.srv.withdrawQuietly)
	f.sql("UPDATE agents SET activity = 'idle' WHERE id IN ('achild', 'aboss')")
	human := map[string]string{"X-Stam-Human": "1"}
	for _, tc := range []struct {
		name, token string
		header      map[string]string
		body        string
		status      int
		want        string
	}{
		{"no by and not the human", sharedTok, nil, `{"agent":"achild","preset":"cheap"}`, 403, "cost_switch needs an agent (by) or the human"},
		{"outside its tree", agentTok, nil, `{"agent":"aboss","preset":"cheap"}`, 403, "child may not manage cost for boss's tree"},
		{"an unknown manager", sharedTok, nil, `{"agent":"achild","preset":"cheap","by":"anone"}`, 404, "no agent anone"},
		{"an unknown agent", sharedTok, human, `{"agent":"ghost","preset":"cheap"}`, 400, "no agent ghost"},
		{"no such preset", sharedTok, human, `{"agent":"achild","preset":"nope"}`, 400, "no preset nope; see stam registry"},
		// soft_stop_minutes is a number as JS reads one: "soon" is NaN, which no deadline can be made of.
		{"a soft stop that is no number", sharedTok, human, `{"agent":"achild","preset":"cheap","soft_stop_minutes":"soon"}`, 400, "Invalid time value"},
		// This fixture has no templates, so the switch fails after its move, at the takeover prompt, and is rolled back;
		// the predecessor's resume can't render its note either.
		{"a switch that fails", bossTok, nil, `{"agent":"achild","preset":"cheap","soft_stop_minutes":0}`, 400,
			"switching child to cheap failed, and child was left shut down (no template cost-switch-failed): no template takeover"},
	} {
		rec := f.do(call{method: "POST", path: "/api/cost/switch", token: tc.token, header: tc.header, body: tc.body})
		if rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("%s: %d %s, want %d %s", tc.name, rec.Code, rec.Body.String(), tc.status, tc.want)
		}
	}
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'working' WHERE id = 'achild'")
	rec := f.do(call{method: "POST", path: "/api/cost/switch", token: bossTok, body: `{"agent":"achild","preset":"cheap","soft_stop_minutes":0}`})
	if want := `{"status":"quiescing","from":"child","to":"child-t2","preset":"cheap","minutes":0}`; rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != want {
		t.Fatalf("working: %d %s, want %s", rec.Code, rec.Body.String(), want)
	}
	until(t, "the failure to reach the manager", func() bool {
		return f.count("SELECT count(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'aboss' AND m.subject = '[stam] cost_switch of child failed'") == 1
	})
	// With no soft_stop_minutes, settings.cost.softStopMinutes: 10 by default.
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'working' WHERE id = 'aboss'")
	rec = f.do(call{method: "POST", path: "/api/cost/switch", token: sharedTok, header: human, body: `{"agent":"aboss","preset":"cheap"}`})
	if want := `{"status":"quiescing","from":"boss","to":"boss-t2","preset":"cheap","minutes":10}`; rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != want {
		t.Fatalf("default soft stop: %d %s, want %s", rec.Code, rec.Body.String(), want)
	}
}

// TestItsaRetryTiming: the hand-off retry waits STAM_ITSA_RETRY_MS (MOOTR_ first, 30 s when unset or no positive
// number), doubling per failure in a row up to an hour.
func TestItsaRetryTiming(t *testing.T) {
	for _, tc := range []struct {
		env  map[string]string
		want time.Duration
	}{
		{nil, 30 * time.Second},
		{map[string]string{"STAM_ITSA_RETRY_MS": "250"}, 250 * time.Millisecond},
		{map[string]string{"STAM_ITSA_RETRY_MS": "250", "MOOTR_ITSA_RETRY_MS": "40"}, 40 * time.Millisecond},
		{map[string]string{"STAM_ITSA_RETRY_MS": "-5"}, 30 * time.Second},
		{map[string]string{"STAM_ITSA_RETRY_MS": "soon"}, 30 * time.Second},
	} {
		if got := itsaRetryEvery(func(k string) string { return tc.env[k] }); got != tc.want {
			t.Errorf("%v: %v, want %v", tc.env, got, tc.want)
		}
	}
	for fails, want := range map[int]time.Duration{1: 30 * time.Second, 2: time.Minute, 3: 2 * time.Minute, 8: time.Hour, 50: time.Hour} {
		if got := retryDelay(30*time.Second, fails); got != want {
			t.Errorf("after %d failures: %v, want %v", fails, got, want)
		}
	}
}

// itsaHome is a stub ITSA home that answers POST /api/itsas/switch-owner with the status and body set, recording each
// body it is sent.
type itsaHome struct {
	*httptest.Server
	mu     sync.Mutex
	status int
	answer string
	got    []string
}

func newItsaHome(t *testing.T) *itsaHome {
	h := &itsaHome{status: 200, answer: `{"moved":["S-1","S-2"]}`}
	h.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		h.mu.Lock()
		defer h.mu.Unlock()
		if r.URL.Path != "/api/itsas/switch-owner" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		h.got = append(h.got, string(b))
		w.WriteHeader(h.status)
		io.WriteString(w, h.answer)
	}))
	t.Cleanup(h.Close)
	return h
}

func (h *itsaHome) set(status int, answer string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.status, h.answer = status, answer
}

func (h *itsaHome) calls() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.got)
}

// TestHandOffSwitchedItsas (S-3636): off the ITSA home, a switch asks the home to move the predecessor's ITSAs to its
// successor and records the answer; on the home it asks nothing. A home that fails leaves one itsa-owner-failed event per
// outage and is asked again by the retry pass once its backoff is over, a refusal (403) is final, and a home that
// doesn't answer is named without its URL. A restart seeds the hand-offs still owed from the events, and a pass drops
// one whose predecessor no longer forwards.
func TestHandOffSwitchedItsas(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	ctx := context.Background()
	home := newItsaHome(t)
	steps := func() []string {
		evs, err := f.db.ListEvents(ctx, "achild", 50, "cost:switch")
		must(t, err)
		var out []string
		for _, e := range evs {
			out = append(out, *e.Data)
		}
		return out
	}
	pred, err := f.db.GetAgent(ctx, "achild")
	must(t, err)
	succ, err := f.db.GetAgent(ctx, "aboss")
	must(t, err)

	writeFile(t, filepath.Join(f.home, "settings.json"), `{"itsa":{"home":"`+f.cfg.Machine+`"}}`)
	f.srv.handOffSwitchedItsas(ctx, pred, succ)
	if home.calls() != 0 || len(steps()) != 0 {
		t.Fatalf("on the home: %d calls, %v", home.calls(), steps())
	}

	writeFile(t, filepath.Join(f.home, "settings.json"), `{"itsa":{"home":"farhome"},"peers":[{"name":"farhome","url":"`+home.URL+`","token":"test-peer-token"}]}`)
	f.srv.handOffSwitchedItsas(ctx, pred, succ)
	if got := home.got; len(got) != 1 || got[0] != `{"from":"achild","to":"aboss"}` {
		t.Errorf("the home got %q", got)
	}
	if s := steps(); len(s) != 1 || s[0] != `{"step":"itsa-owner","to":"boss","itsas":2}` {
		t.Errorf("steps %q", s)
	}

	home.set(500, `{"error":"busy"}`)
	f.srv.handOffSwitchedItsas(ctx, pred, succ)
	f.srv.handOffSwitchedItsas(ctx, pred, succ)
	if s := steps(); len(s) != 2 || s[1] != `{"step":"itsa-owner-failed","to":"boss","error":"the ITSA home farhome refused: busy"}` {
		t.Errorf("steps %q", s)
	}
	f.srv.switched.mu.Lock()
	b := f.srv.switched.backoff["achild"]
	f.srv.switched.mu.Unlock()
	if b.fails != 2 || time.Until(b.next) < 50*time.Second {
		t.Errorf("backoff %+v", b)
	}
	// The retry pass asks only once the backoff is over, and only while the predecessor forwards to a successor.
	f.sql("UPDATE agents SET forwarded_to = 'aboss' WHERE id = 'achild'")
	home.set(200, `{"moved":[]}`)
	calls := home.calls()
	f.srv.retrySwitchedItsas(ctx)
	if home.calls() != calls {
		t.Error("asked before the backoff was over")
	}
	f.srv.switched.mu.Lock()
	f.srv.switched.backoff["achild"] = switchBackoff{fails: 2}
	f.srv.switched.mu.Unlock()
	f.srv.retrySwitchedItsas(ctx)
	if s := steps(); home.calls() != calls+1 || s[len(s)-1] != `{"step":"itsa-owner","to":"boss","itsas":0}` || f.srv.switched.pending["achild"] {
		t.Errorf("retry: %d calls, steps %q", home.calls(), s)
	}

	home.set(403, `{"error":"only a peer holding a switched agent can move its ITSAs"}`)
	f.srv.handOffSwitchedItsas(ctx, pred, succ)
	if s := steps(); s[len(s)-1] != `{"step":"itsa-owner-refused","to":"boss","error":"the ITSA home farhome refused: only a peer holding a switched agent can move its ITSAs"}` || f.srv.switched.pending["achild"] {
		t.Errorf("refused: %q", s)
	}

	home.Close()
	f.srv.handOffSwitchedItsas(ctx, pred, succ)
	s := steps()
	if last := s[len(s)-1]; last != `{"step":"itsa-owner-failed","to":"boss","error":"the ITSA home did not answer"}` || strings.Contains(last, "127.0.0.1") {
		t.Errorf("down: %q", last)
	}

	// A restart: nothing in memory, the failure seeded from the events; a predecessor that no longer forwards is dropped.
	f.srv.switched = switchedState{}
	f.srv.seedSwitchedItsas(ctx)
	if !f.srv.switched.pending["achild"] {
		t.Fatal("the restart didn't seed the owed hand-off")
	}
	f.sql("UPDATE agents SET forwarded_to = NULL WHERE id = 'achild'")
	f.srv.retrySwitchedItsas(ctx)
	if f.srv.switched.pending["achild"] || f.srv.switched.passes != 1 {
		t.Errorf("pending %v after %d passes", f.srv.switched.pending, f.srv.switched.passes)
	}

	// A hand-off whose latest event is its success isn't owed after a restart.
	f.sql("UPDATE agents SET forwarded_to = 'aboss' WHERE id = 'achild'")
	f.srv.addEvent(ctx, "achild", "cost:switch", itsaOwnerEvent{Step: "itsa-owner", To: "boss", Itsas: 1})
	f.srv.switched = switchedState{}
	f.srv.seedSwitchedItsas(ctx)
	if f.srv.switched.pending["achild"] {
		t.Error("a hand-off that succeeded was seeded")
	}
}

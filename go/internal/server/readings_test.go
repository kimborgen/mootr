package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"stam/internal/decide"
)

// TestUsageReadings: GET /api/usage/readings answers a peer with this machine's windows per account, and nobody else.
func TestUsageReadings(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"cost":{"accounts":{"max":{"match":{"harness":"claude"},"paid":false}}}}`), 0o600))
	must(t, f.db.SaveSubscription(context.Background(), "claude", `{"five_hour":{"used_percentage":40,"resets_at":1800000000}}`, "2026-10-21T10:00:00.000Z"))
	rec := f.do(call{path: "/api/usage/readings", token: peerTok, header: peerLocal})
	if rec.Code != 200 || rec.Body.String() != `{"max":{"match":{"harness":"claude"},"windows":{"five_hour":{"pct":40,"resets_at":1800000000,"at":1792576800000}}}}` {
		t.Errorf("a peer: %d %s", rec.Code, rec.Body.String())
	}
	for _, tok := range []string{sharedTok, agentTok} {
		if rec := f.do(call{path: "/api/usage/readings", token: tok}); rec.Code != 403 || !strings.Contains(rec.Body.String(), "only a peer can read readings") {
			t.Errorf("%s: %d %s", tok, rec.Code, rec.Body.String())
		}
	}
}

// TestUsageSpend: GET /api/usage/spend answers a peer with this machine's paid totals by period, and nobody else.
func TestUsageSpend(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"cost":{"accounts":{"openrouter":{"match":{"harness":"opencode","model":"openrouter/"}}}}}`), 0o600))
	f.sql("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('achild', ?, 'opencode', 'openrouter/x', 'openrouter', 2.5)", time.Now().UTC().Format("2006-01-02"))
	rec := f.do(call{path: "/api/usage/spend", token: peerTok, header: peerLocal})
	if rec.Code != 200 || rec.Body.String() != `{"global":{"day":2.5,"week":2.5,"month":2.5,"cap":2.5},"accounts":{"openrouter":{"day":2.5,"week":2.5,"month":2.5,"cap":2.5}}}` {
		t.Errorf("a peer: %d %s", rec.Code, rec.Body.String())
	}
	for _, tok := range []string{sharedTok, agentTok} {
		if rec := f.do(call{path: "/api/usage/spend", token: tok}); rec.Code != 403 || !strings.Contains(rec.Body.String(), "only a peer can read spend") {
			t.Errorf("%s: %d %s", tok, rec.Code, rec.Body.String())
		}
	}
}

// TestDecideHeldByBudget: the decision model's calls are held once the system budget is spent, with no request sent,
// and a call's spend has the budgets evaluated (src/decide.ts with providerHeld and ledgerChanged).
func TestDecideHeldByBudget(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		io.WriteString(w, `{"model":"m","answers":{"yes":{"type":"noul","noul":0.5}},"usage":{"input_tokens":1,"output_tokens":1,"cost":5}}`)
	}))
	defer srv.Close()
	t.Setenv("STAM_OPENROUTER_URL", srv.URL)
	t.Setenv("OPENROUTER_API_KEY", "sk-or-test-key")
	f := newFixture(t, nil)
	withLife(f)
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"cost":{"accounts":{"openrouter-system":{"match":{"harness":"stam"},"budget":{"usd":8,"per":"day"}},"cx":{"match":{"harness":"claude"}}},"global":{"budget":{"usd":9,"per":"day"}}}}`), 0o600))
	f.sql("UPDATE agents SET lifecycle = 'active', harness = 'claude', model = NULL")
	ask := func() *decide.Failure {
		_, fail := f.srv.decide.Decide(context.Background(), "s", []decide.Named{{Name: "yes", Question: decide.Noul("q")}}, "decide:test", 0)
		return fail
	}
	for i := 0; i < 2; i++ {
		if fail := ask(); fail != nil {
			t.Fatalf("call %d: %+v", i, fail)
		}
	}
	// The second call's $10 passed the global $9: the ledger change stops the managed agents.
	deadline := time.Now().Add(10 * time.Second)
	for f.count("SELECT count(*) FROM blockers WHERE kind = 'budget' AND account = 'global'") == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the decision model's spend didn't evaluate the global budget")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if fail := ask(); fail == nil || fail.Error != "the system day budget of $8 is spent" || calls != 2 {
		t.Errorf("held: %+v, %d calls", fail, calls)
	}
}

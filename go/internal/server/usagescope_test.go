package server

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

// scopeSummary leaves an agent only its own trees' shares, as src/usage-scope.ts does: a window's agents and trees, its
// history, the trees (nested, with one "other" tree summing the rest), by_agent with an "other" row, the allocations,
// the 5-minute cache agents and the blocked list; everything else as it is.
const scopeFixture = `{"note":"n","accounts":[` +
	`{"account":"max","shares":{"five_hour":{"percent":40,"agents":[{"id":"me","percent":10},{"id":"x","percent":20}],` +
	`"by_agent":[{"id":"me","percent":10.12345},{"id":"x","percent":20.00004},{"id":"y","percent":0.1}],"trees":[{"id":"root"},{"id":"x"}],` +
	`"history":{"days":[1],"trees":[{"id":"root"},{"id":"x"}],"agents":[{"id":"y"}]}},"seven_day":null}},` +
	`{"account":"codex","shares":null}],` +
	`"trees":[{"id":"root","name":"root","cost_usd":1.5,"tokens":10,"shares":{"max":{"five_hour":{"estimate":true,"percent":5}}},` +
	`"children":[{"id":"me","name":"me","cost_usd":1,"tokens":4,"shares":{},"children":[]},{"id":"sib","name":"sib","cost_usd":0.25,"tokens":2,` +
	`"shares":{"max":{"five_hour":{"estimate":true,"percent":1.5}}},"children":[]}]},` +
	`{"id":"x","name":"x","cost_usd":2.00005,"tokens":7,"shares":{"max":{"five_hour":{"estimate":true,"percent":3.33333},"seven_day":{"estimate":true,"percent":1}}},"children":[]},` +
	`{"id":"y","name":"y","cost_usd":0.1,"tokens":3,"shares":{"max":{"five_hour":{"estimate":true,"percent":null}}}}],` +
	`"by_agent":[{"agent_id":"me","cost_usd":1,"tokens_in":5},{"agent_id":"x","cost_usd":"2","tokens_in":7,"tokens_out":null},{"agent_id":"y","cost_usd":0.33333,"tokens_in":"x"}],` +
	`"allocations":[{"id":"al1","root_id":"root"},{"id":"al2","root_id":"x"}],` +
	`"cache":{"cold_turns":3,"ttl_5m_agents":[{"agent_id":"me"},{"agent_id":"x"}]},` +
	`"blocked":[{"agent_id":"x","reason":"r"},{"agent_id":"sib","reason":"s"}],"machines":[{"name":"m"}]}`

func TestScopeSummaryMatchesTS(t *testing.T) {
	for _, visible := range [][]string{{"root", "me", "sib"}, {"me"}, {"root", "me", "sib", "x", "y"}} {
		vis := `["` + strings.Join(visible, `","`) + `"]`
		var stderr bytes.Buffer
		cmd := exec.Command("node", "--no-warnings", "testdata/scoperef.mjs", scopeFixture, vis)
		cmd.Stderr = &stderr
		raw, err := cmd.Output()
		if err != nil {
			t.Fatalf("scoperef.mjs: %v\n%s", err, stderr.String())
		}
		in, err := jsfmt.Parse([]byte(scopeFixture))
		must(t, err)
		set := map[string]bool{}
		for _, id := range visible {
			set[id] = true
		}
		if got, want := jsfmt.Compact(scopeSummary(in, set)), strings.TrimSpace(string(raw)); got != want {
			t.Errorf("visible %v differs\n go: %s\n ts: %s", visible, got, want)
		}
	}
}

// usageTree resolves an agent by id or name, and an unknown one to nil; a lookup that fails for any other reason
// returns the error, as TS's throwing getAgent fails the request. mayReadTree lets the unknown agent through and
// judges a known one on its id.
func TestMayReadTree(t *testing.T) {
	f := newFixture(t, nil)
	for _, a := range [][2]string{{"amine", "mine"}, {"aother", "other-tree"}} {
		f.sql(`INSERT INTO agents (id, name, lifecycle, activity, harness, machine, cwd, created_at, updated_at) VALUES (?, ?, 'active', 'idle', 'claude', 'test-machine', '/tmp', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`, a[0], a[1])
	}
	visible := map[string]bool{"amine": true}
	ctx := context.Background()
	for _, c := range []struct {
		tree string
		want bool
	}{
		{"nobody", true},      // unknown: let through
		{"amine", true},       // an id inside visible
		{"mine", true},        // a name whose id is inside visible
		{"aother", false},     // a known agent outside it
		{"other-tree", false}, // a name that resolves to an id outside it
	} {
		root, err := f.srv.usageTree(ctx, c.tree)
		if got := mayReadTree(visible, root); err != nil || got != c.want {
			t.Errorf("mayReadTree(%q) = %v, %v; want %v", c.tree, got, err, c.want)
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if root, err := f.srv.usageTree(cancelled, "nobody"); err == nil || root != nil {
		t.Errorf("a failed lookup gave %v, %v; want nil and the error", root, err)
	}
}

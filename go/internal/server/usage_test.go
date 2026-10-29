package server

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"testing"

	"stam/internal/db"
)

// GET /api/usage (src/daemon.ts): the summary with each machine's load and the paid spend per machine; an agents=
// filter it can't read is a 400; an agent's token sees its own and its ancestors' trees only, others' as "other", and
// may not ask for another tree; a failed tree check refuses with a 500 and no summary.
func TestUsageRoute(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	f.sql("DELETE FROM usage")
	f.sql(`INSERT INTO agents (id, name, lifecycle, activity, harness, machine, cwd, created_at, updated_at) VALUES ('astr', 'stranger', 'active', 'idle', 'claude', 'test-machine', '/tmp', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
	f.sql(`INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in) VALUES ('achild', date('now'), 'claude', 'm', '', 1.5, 10), ('astr', date('now'), 'claude', 'm', '', 2.25, 20)`)

	keysOf := func(body string) map[string]json.RawMessage {
		var m map[string]json.RawMessage
		must(t, json.Unmarshal([]byte(body), &m))
		return m
	}
	rec := f.do(call{path: "/api/usage?days=7", token: sharedTok})
	if rec.Code != 200 {
		t.Fatalf("the shared token: %d %s", rec.Code, rec.Body)
	}
	all := keysOf(rec.Body.String())
	for _, k := range []string{"note", "accounts", "trees", "by_agent", "cache", "agent_types", "machines", "paid_spend_by_machine"} {
		if _, ok := all[k]; !ok {
			t.Errorf("the summary lacks %s: %s", k, rec.Body)
		}
	}
	// Each machine is the compact entry usage_info reads, and nothing else (no url, token or peer state).
	var machines []map[string]json.RawMessage
	must(t, json.Unmarshal(all["machines"], &machines))
	if len(machines) == 0 {
		t.Fatalf("no machines: %s", all["machines"])
	}
	for _, m := range machines {
		var keys []string
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		if got, want := strings.Join(keys, ","), "agents,cores,cpu_pct,load_1m,name,online,ram_pct,ram_total_gb,ram_used_gb,swap_pct"; got != want {
			t.Errorf("a machine entry's fields: %s, want %s", got, want)
		}
	}
	// A peer's own (X-Stam-Local) call gets the summary without the paid spend per machine.
	rec = f.do(call{path: "/api/usage?days=7", token: peerTok, header: map[string]string{"X-Stam-Local": "1"}})
	if rec.Code != 200 {
		t.Fatalf("a peer's local call: %d %s", rec.Code, rec.Body)
	}
	if local := keysOf(rec.Body.String()); local["paid_spend_by_machine"] != nil || local["machines"] == nil {
		t.Errorf("a peer's local call has paid_spend_by_machine or lacks machines: %s", rec.Body)
	}
	if !strings.Contains(string(all["by_agent"]), `"agent":"stranger"`) {
		t.Errorf("the shared token's by_agent lacks the stranger: %s", all["by_agent"])
	}
	if rec := f.do(call{path: "/api/usage?agents=bogus", token: sharedTok}); rec.Code != 400 || !strings.Contains(rec.Body.String(), "bogus") {
		t.Errorf("an unknown type: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/usage?agents=developer", token: sharedTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"filtered_agents":["developer"]`) {
		t.Errorf("a type filter: %d %s", rec.Code, rec.Body)
	}

	// An agent's token: the stranger's spend is the "other" row.
	rec = f.do(call{path: "/api/usage", token: agentTok})
	if rec.Code != 200 {
		t.Fatalf("an agent's token: %d %s", rec.Code, rec.Body)
	}
	scoped := string(keysOf(rec.Body.String())["by_agent"])
	if strings.Contains(scoped, "stranger") || !strings.Contains(scoped, `"agent_id":"other","agent":"other","cost_usd":2.25`) {
		t.Errorf("an agent's by_agent: %s", scoped)
	}
	if rec := f.do(call{path: "/api/usage?tree=astr", token: agentTok}); rec.Code != 403 || !strings.Contains(rec.Body.String(), "not astr's") {
		t.Errorf("another tree: %d %s", rec.Code, rec.Body)
	}
	// Its own tree: the tree view right after the allocations, for the resolved agent.
	if rec := f.do(call{path: "/api/usage?tree=achild", token: agentTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"allocations":[],"tree":{"note":`) || !strings.Contains(string(keysOf(rec.Body.String())["tree"]), `"id":"achild"`) {
		t.Errorf("its own tree: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/usage?tree=nobody", token: agentTok}); rec.Code != 404 {
		t.Errorf("an unknown tree: %d %s", rec.Code, rec.Body)
	}

	// An agent named after a hidden agent's id: tree= resolves to one row once, and the check and the tree view judge
	// that row. The lookup picks each row in turn, as GetAgent's unordered `id = ? OR name = ?` may; the ref is one the
	// database doesn't hold, so a second lookup that bypasses the first (and might pick the other row) would 404.
	f.sql(`INSERT INTO agents (id, name, parent_id, lifecycle, activity, harness, machine, cwd, created_at, updated_at) VALUES ('aimpostor', 'astr', 'achild', 'active', 'idle', 'claude', 'test-machine', '/tmp', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
	var looked []string
	for _, pick := range []db.Agent{{ID: "astr", Name: "stranger"}, {ID: "aimpostor", Name: "astr"}} {
		f.srv.treeLookup = func(_ context.Context, ref string) (db.Agent, error) {
			looked = append(looked, ref)
			return pick, nil
		}
		looked = nil
		rec := f.do(call{path: "/api/usage?tree=ghost", token: agentTok})
		if len(looked) != 1 {
			t.Errorf("tree= looked the agent up %d times, want once", len(looked))
		}
		switch pick.ID {
		case "astr": // the hidden stranger: refused
			if rec.Code != 403 {
				t.Errorf("tree= resolving to the stranger: %d %s", rec.Code, rec.Body)
			}
		case "aimpostor": // the visible agent named astr: its own tree view, never the stranger's
			if rec.Code != 200 || !strings.Contains(string(keysOf(rec.Body.String())["tree"]), `"agent":"astr","id":"aimpostor"`) {
				t.Errorf("tree= resolving to the visible agent: %d %s", rec.Code, rec.Body)
			}
		}
	}

	// A tree check whose lookup fails refuses with a 500 and no summary.
	f.srv.treeLookup = func(context.Context, string) (db.Agent, error) { return db.Agent{}, errors.New("disk I/O error") }
	rec = f.do(call{path: "/api/usage?tree=aboss", token: agentTok})
	if rec.Code != 500 || !strings.Contains(rec.Body.String(), "could not check which trees") || strings.Contains(rec.Body.String(), "cost_usd") {
		t.Errorf("a failed tree check: %d %s", rec.Code, rec.Body)
	}
}

// GET /api/usage/issues (src/daemon.ts): every ITSA's cost for the shared token; an agent's token sees only the ITSAs
// it belongs to, with the totals and per-config rows kept; days limits the samples.
func TestUsageIssuesRoute(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	// S-72 is closed, so its spend makes a per-config row.
	for _, x := range [][4]string{{"iown", "S-71", "achild", "in_progress"}, {"ielse", "S-72", "astr", "done"}} {
		f.sql("INSERT INTO itsas (id, key, title, status, kind, owner, created_by, created_at, updated_at) VALUES (?, ?, 't', ?, 'issue', ?, 'human', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')", x[0], x[1], x[3], x[2])
	}
	f.sql(`INSERT INTO agents (id, name, lifecycle, activity, harness, machine, cwd, created_at, updated_at) VALUES ('astr', 'stranger', 'active', 'idle', 'claude', 'test-machine', '/tmp', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
	f.sql("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in) VALUES ('achild', '', 'claude', 'm', strftime('%Y-%m-%dT%H:%M:00.000Z', 'now'), 1.5, 10), ('astr', '', 'claude', 'm', strftime('%Y-%m-%dT%H:%M:00.000Z', 'now'), 2.25, 20)")
	keysOf := func(body string) map[string]json.RawMessage {
		var m map[string]json.RawMessage
		must(t, json.Unmarshal([]byte(body), &m))
		return m
	}
	rec := f.do(call{path: "/api/usage/issues", token: sharedTok})
	all := keysOf(rec.Body.String())
	if rec.Code != 200 || !strings.Contains(string(all["issues"]), `"key":"S-72"`) || !strings.Contains(string(all["issues"]), `"key":"S-71"`) || string(all["since"]) != "null" {
		t.Fatalf("the shared token: %d %s", rec.Code, rec.Body)
	}
	rec = f.do(call{path: "/api/usage/issues?days=7", token: agentTok})
	scoped := keysOf(rec.Body.String())
	if rec.Code != 200 || strings.Contains(string(scoped["issues"]), "S-72") || !strings.Contains(string(scoped["issues"]), `"key":"S-71"`) {
		t.Errorf("an agent's token: %d %s", rec.Code, rec.Body)
	}
	if string(scoped["all"]) != string(all["all"]) || string(scoped["since"]) == "null" {
		t.Errorf("an agent's token keeps the totals and days sets since: %s vs %s", scoped["all"], all["all"])
	}
	if string(scoped["by_config"]) != string(all["by_config"]) || string(scoped["unattributed"]) != string(all["unattributed"]) || !strings.Contains(string(all["by_config"]), `"config":`) {
		t.Errorf("an agent's token keeps the per-config rows: %s vs %s", scoped["by_config"], all["by_config"])
	}
	// A membership check that fails leaves the ITSA out, not the answer.
	f.srv.usageItsaCheck = func(_ context.Context, _, key string) (bool, error) {
		if key == "S-71" {
			return false, errors.New("disk I/O error")
		}
		return true, nil
	}
	rec = f.do(call{path: "/api/usage/issues", token: agentTok})
	failed := keysOf(rec.Body.String())
	if rec.Code != 200 || strings.Contains(string(failed["issues"]), "S-71") || !strings.Contains(string(failed["issues"]), `"key":"S-72"`) {
		t.Errorf("a failing membership check: %d %s", rec.Code, rec.Body)
	}
}

// GET /api/usage/series (src/daemon.ts): a bad group or days is a 400; an agent's token sees a hidden agent's spend as
// Other in an agent series, and an ITSA it doesn't belong to as Other in an ITSA series.
func TestUsageSeriesRoute(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	f.sql("DELETE FROM usage")
	f.sql(`INSERT INTO agents (id, name, lifecycle, activity, harness, machine, cwd, created_at, updated_at) VALUES ('astr', 'stranger', 'active', 'idle', 'claude', 'test-machine', '/tmp', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
	f.sql(`INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in) VALUES ('achild', date('now'), 'claude', 'm', '', 1.5, 10), ('astr', date('now'), 'claude', 'm', '', 2.25, 20)`)
	f.sql("INSERT INTO itsas (id, key, title, status, kind, owner, created_by, created_at, updated_at) VALUES ('ielse', 'S-72', 't', 'in_progress', 'issue', 'astr', 'human', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
	f.sql("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in) VALUES ('astr', '', 'claude', 'm', strftime('%Y-%m-%dT%H:%M:00.000Z', 'now', '-10 minutes'), 2.25, 20)")
	for _, bad := range []struct{ path, want string }{
		{"/api/usage/series?group=nope", "group must be one of tree, model, harness, agent, itsa, not nope"},
		{"/api/usage/series?days=0", "days must be a number from 1 to 400, not 0"},
		{"/api/usage/series?days=x", "days must be a number from 1 to 400, not x"},
	} {
		if rec := f.do(call{path: bad.path, token: sharedTok}); rec.Code != 400 || !strings.Contains(rec.Body.String(), bad.want) {
			t.Errorf("%s: %d %s", bad.path, rec.Code, rec.Body)
		}
	}
	if rec := f.do(call{path: "/api/usage/series?group=agent&days=7", token: sharedTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"id":"astr","name":"stranger"`) {
		t.Errorf("the shared token's agent series: %d %s", rec.Code, rec.Body)
	}
	rec := f.do(call{path: "/api/usage/series?group=agent&days=7", token: agentTok})
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "stranger") || !strings.Contains(rec.Body.String(), `"groups":[{"id":"achild"`) || !strings.Contains(rec.Body.String(), `{"id":"other","name":"Other"}`) {
		t.Errorf("an agent's agent series: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/usage/series?group=itsa&days=1", token: sharedTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"id":"S-72"`) {
		t.Errorf("the shared token's ITSA series: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/usage/series?group=itsa&days=1", token: agentTok}); rec.Code != 200 || strings.Contains(rec.Body.String(), "S-72") || !strings.Contains(rec.Body.String(), `"groups":[{"id":"other","name":"Other"}]`) {
		t.Errorf("an agent's ITSA series: %d %s", rec.Code, rec.Body)
	}
	// An ITSA it belongs to is its own group, checked once per request however many samples name it.
	f.sql("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in) VALUES ('astr', '', 'claude', 'm', strftime('%Y-%m-%dT%H:%M:00.000Z', 'now', '-20 minutes'), 1, 5)")
	checks := map[string]int{}
	f.srv.usageItsaCheck = func(_ context.Context, _, key string) (bool, error) { checks[key]++; return key == "S-72", nil }
	if rec := f.do(call{path: "/api/usage/series?group=itsa&days=1", token: agentTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"groups":[{"id":"S-72"`) || checks["S-72"] != 1 {
		t.Errorf("an ITSA it belongs to: %d %v %s", rec.Code, checks, rec.Body)
	}
	// A failing membership check is a no: the ITSA is Other.
	f.srv.usageItsaCheck = func(context.Context, string, string) (bool, error) { return true, errors.New("disk I/O error") }
	if rec := f.do(call{path: "/api/usage/series?group=itsa&days=1", token: agentTok}); rec.Code != 200 || strings.Contains(rec.Body.String(), "S-72") || !strings.Contains(rec.Body.String(), `"groups":[{"id":"other","name":"Other"}]`) {
		t.Errorf("a failing membership check: %d %s", rec.Code, rec.Body)
	}
	// Agents it may see that can't be listed refuse, with no series.
	f.srv.usageVisible = func(context.Context, string) (map[string]bool, error) { return nil, errors.New("disk I/O error") }
	if rec := f.do(call{path: "/api/usage/series?group=agent&days=7", token: agentTok}); rec.Code != 500 || strings.Contains(rec.Body.String(), "groups") {
		t.Errorf("a failing visible agents: %d %s", rec.Code, rec.Body)
	}
}

// GET /api/usage/scope (src/daemon.ts): one of tree, itsa or agent, or a model and/or harness, else a 400; an unknown
// agent or ITSA is a 404, a bad days, since or bucket a 400; an agent's token may drill only into the trees it may see
// and the ITSAs it belongs to, and its rows hold only the agents it may see.
func TestUsageScopeRoute(t *testing.T) {
	f := newFixture(t, nil)
	withLife(f)
	f.sql("DELETE FROM usage")
	f.sql(`INSERT INTO agents (id, name, lifecycle, activity, harness, machine, cwd, created_at, updated_at) VALUES ('astr', 'stranger', 'active', 'idle', 'claude', 'test-machine', '/tmp', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
	f.sql(`INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in) VALUES ('achild', date('now'), 'claude', 'm', '', 1.5, 10), ('astr', date('now'), 'claude', 'm', '', 2.25, 20)`)
	f.sql("INSERT INTO itsas (id, key, title, status, kind, owner, created_by, created_at, updated_at) VALUES ('ielse', 'S-72', 't', 'in_progress', 'issue', 'astr', 'human', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')")
	for _, bad := range []struct {
		path string
		code int
		want string
	}{
		{"/api/usage/scope?tree=achild&itsa=S-72", 400, "scope takes one of tree, itsa or agent, or a harness and/or model"},
		{"/api/usage/scope?agent=achild&model=m", 400, "scope takes one of tree, itsa or agent, or a harness and/or model"},
		{"/api/usage/scope?tree=", 400, "scope needs one of tree, itsa, model, harness or agent"},
		{"/api/usage/scope?tree=ghost", 404, "no agent ghost"},
		{"/api/usage/scope?itsa=S-999", 404, "no ITSA S-999"},
		{"/api/usage/scope?harness=claude&days=401", 400, "days must be a number from 1 to 400, not 401"},
		{"/api/usage/scope?itsa=S-72&since=yesterday", 400, "since must be an ISO time, not yesterday"},
		{"/api/usage/scope?itsa=S-72&bucket=week", 400, "bucket must be hour or day, not week"},
	} {
		if rec := f.do(call{path: bad.path, token: sharedTok}); rec.Code != bad.code || !strings.Contains(rec.Body.String(), bad.want) {
			t.Errorf("%s: %d %s", bad.path, rec.Code, rec.Body)
		}
	}
	// The shared token drills anywhere; a name resolves to its agent's id, an ITSA's id to its key.
	if rec := f.do(call{path: "/api/usage/scope?tree=stranger&days=7", token: sharedTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"id":"astr"`) || !strings.Contains(rec.Body.String(), `"cost_usd":2.25`) {
		t.Errorf("the shared token's tree: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/usage/scope?itsa=ielse&since=2026-01-01T00:00:00.000Z&bucket=day", token: sharedTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"key":"S-72"`) {
		t.Errorf("the shared token's ITSA: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/usage/scope?model=m&days=7", token: sharedTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), "stranger") {
		t.Errorf("the shared token's model: %d %s", rec.Code, rec.Body)
	}
	// An agent's token: no stranger's tree, no ITSA it isn't in, and a model's rows without the stranger.
	if rec := f.do(call{path: "/api/usage/scope?tree=stranger", token: agentTok}); rec.Code != 403 || !strings.Contains(rec.Body.String(), "an agent reads the usage of its own tree and its ancestors' trees only, not astr's") {
		t.Errorf("an agent's stranger tree: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/usage/scope?itsa=S-72", token: agentTok}); rec.Code != 403 || !strings.Contains(rec.Body.String(), "an agent reads the cost of the ITSAs it belongs to only, not S-72") {
		t.Errorf("an agent's stranger ITSA: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/usage/scope?tree=achild&days=7", token: agentTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"cost_usd":1.5`) {
		t.Errorf("an agent's own tree: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/usage/scope?model=m&days=7", token: agentTok}); rec.Code != 200 || strings.Contains(rec.Body.String(), "stranger") || strings.Contains(rec.Body.String(), "astr") || !strings.Contains(rec.Body.String(), `"id":"achild"`) {
		t.Errorf("an agent's model: %d %s", rec.Code, rec.Body)
	}
	// An ITSA it belongs to, checked once per request; a failing check is a no.
	checks := map[string]int{}
	f.srv.usageItsaCheck = func(_ context.Context, _, key string) (bool, error) { checks[key]++; return key == "S-72", nil }
	if rec := f.do(call{path: "/api/usage/scope?itsa=S-72", token: agentTok}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"key":"S-72"`) || checks["S-72"] != 1 {
		t.Errorf("an agent's own ITSA: %d %v %s", rec.Code, checks, rec.Body)
	}
	f.srv.usageItsaCheck = func(context.Context, string, string) (bool, error) { return true, errors.New("disk I/O error") }
	if rec := f.do(call{path: "/api/usage/scope?itsa=S-72", token: agentTok}); rec.Code != 403 || !strings.Contains(rec.Body.String(), "not S-72") {
		t.Errorf("a failing membership check: %d %s", rec.Code, rec.Body)
	}
	// A failed tree lookup, or agents it may see that can't be listed, refuse with no scope.
	f.srv.usageVisible = func(context.Context, string) (map[string]bool, error) { return nil, errors.New("disk I/O error") }
	if rec := f.do(call{path: "/api/usage/scope?model=m", token: agentTok}); rec.Code != 500 || strings.Contains(rec.Body.String(), "totals") {
		t.Errorf("a failing visible agents: %d %s", rec.Code, rec.Body)
	}
	f.srv.treeLookup = func(context.Context, string) (db.Agent, error) { return db.Agent{}, errors.New("disk I/O error") }
	if rec := f.do(call{path: "/api/usage/scope?tree=achild", token: agentTok}); rec.Code != 500 || !strings.Contains(rec.Body.String(), "could not check which trees this agent may read") {
		t.Errorf("a failing tree lookup: %d %s", rec.Code, rec.Body)
	}
	// So does a failed ITSA lookup.
	f.sql("ALTER TABLE itsas RENAME TO itsas_gone")
	if rec := f.do(call{path: "/api/usage/scope?itsa=S-72", token: sharedTok}); rec.Code != 500 || strings.Contains(rec.Body.String(), "totals") {
		t.Errorf("a failing ITSA lookup: %d %s", rec.Code, rec.Body)
	}
}

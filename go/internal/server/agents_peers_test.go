package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

// GET /api/agents lists the peers' agents after this daemon's (agents_peers.go): filtered by this request's state,
// remembered here, with this daemon's default views. A peer's own request lists only its own, and a peer that is down
// adds nothing.
func TestAgentListMergesPeers(t *testing.T) {
	far, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", nil)
	ctx := context.Background()
	// far has an achild too: here's is the one listed, and the peer's row never replaces it (the web keys agents by id).
	far.sql("UPDATE agents SET role = 'far-copy' WHERE id = 'achild'")
	f.sql("INSERT OR REPLACE INTO agent_views (agent_id, view, updated_at) VALUES ('aboss', 'terminal', 's')")
	ids := func(rec *httptest.ResponseRecorder) map[string]map[string]any {
		t.Helper()
		var rows []map[string]any
		if rec.Code != 200 {
			t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
		}
		must(t, json.Unmarshal(rec.Body.Bytes(), &rows))
		out := map[string]map[string]any{}
		for _, r := range rows {
			id := r["id"].(string)
			if out[id] != nil {
				t.Errorf("%s is listed twice", id)
			}
			out[id] = r
		}
		return out
	}
	farLive := ids(far.do(call{path: "/api/agents", token: sharedTok}))
	got := ids(f.do(call{path: "/api/agents", token: sharedTok}))
	if a := got["achild"]; a == nil || a["role"] == "far-copy" || len(got) != len(farLive) {
		t.Fatalf("merged list has %d agents, want far's %d with here's achild: %v", len(got), len(farLive), a)
	}
	boss := got["aboss"]
	if boss["machine"] == "here" || boss["first_prompt"] != nil || boss["cost_raw"] != nil || boss["default_view"] != "terminal" {
		t.Errorf("far's boss as listed here: %v", boss)
	}
	if _, found, err := f.db.PeerAgentByID(ctx, "aboss"); err != nil || !found {
		t.Errorf("far's listed agent was not remembered: %v %v", found, err)
	}
	// A state far's list and this one share; an `ids` naming far's agent keeps only it.
	if got := ids(f.do(call{path: "/api/agents?ids=aboss", token: sharedTok})); len(got) != 1 || got["aboss"] == nil {
		t.Errorf("ids=aboss: %v", got)
	}
	// A peer's own request is this daemon's list only.
	if got := ids(f.do(call{path: "/api/agents", token: peerTok, header: map[string]string{"x-stam-local": "1"}})); len(got) != 1 {
		t.Errorf("a peer's request listed %d agents, want achild only", len(got))
	}
	// Here's achild archived is out of the live list, and far's live achild still doesn't stand in for it.
	f.sql("UPDATE agents SET lifecycle = 'archived' WHERE id = 'achild'")
	if got := ids(f.do(call{path: "/api/agents", token: sharedTok})); got["achild"] != nil || len(got) != len(farLive)-1 {
		t.Errorf("with here's achild archived: %d agents, achild %v", len(got), got["achild"])
	}
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id = 'achild'")
	ps.ts.Close()
	if got := ids(f.do(call{path: "/api/agents", token: sharedTok})); len(got) != 1 {
		t.Errorf("with far down the list has %d agents, want achild only", len(got))
	}
}

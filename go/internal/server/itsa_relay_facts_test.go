package server

import (
	"strings"
	"testing"
)

// S-4163: an agent posts to an ITSA whose home is a peer, through the raw API. This daemon attaches the routing facts of its
// own agent (relay_route, the seeded achild: not exempt, parent acodex) and drops any the agent's body brought, so the home
// receives the facts this daemon read, never a forged exempt flag.
func TestItsaPostFactsComeFromTheSender(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	far, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, `"itsa":{"home":"far"}`, nil)
	key := far.createItsa(`{"title":"Home owned","owner":"aboss","participants":["human"]}`)
	far.sql("INSERT INTO itsa_participants (itsa_id, agent_id) SELECT id, 'achild' FROM itsas WHERE key = ?", key)
	f.sql("UPDATE agents SET model = NULL WHERE id = 'achild'")

	rec := f.sendH("POST", "/api/itsas/"+key+"/post", agentTok, nil, `{"body":"Result","to":["human"],"relay_route":{"exempt":true,"parent":"aboss"}}`)
	if rec.Code != 200 {
		t.Fatalf("the agent's post through the home: %d %s", rec.Code, rec.Body.String())
	}
	got := ps.last(t).body
	if !strings.Contains(got, `"relay_route":{"exempt":false,"parent":"acodex"}`) {
		t.Errorf("the home didn't get this daemon's facts for the agent: %s", got)
	}
	if strings.Contains(got, `"exempt":true`) {
		t.Errorf("a forged exempt flag reached the home: %s", got)
	}
}

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/db"
)

// refusalOf is the refusal of an ask by agent id, with the live reviewers read once, as requestPermission reads them.
func refusalOf(t *testing.T, f *fixture, id, action, reason, audience string) string {
	t.Helper()
	live, err := f.srv.liveReviewers(context.Background(), f.agentObj(id))
	return askRefusalFor(action, reason, audience, live, err)
}

// TestAskRefusalMatchesTS runs the cases of testdata/permref-cases.json through src/permissions.ts refusalFor on a copy of
// a home (testdata/permref.mjs) and through refusalFor here, and compares every refusal (S-3253). The SQL steps change
// the agents' lifecycles on both sides.
func TestAskRefusalMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/permissions.ts")
	}
	home := filepath.Join(t.TempDir(), "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/permref.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("permref.mjs: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "expect.json"))
	must(t, err)
	var want []struct{ Name, Refused string }
	must(t, json.Unmarshal(raw, &want))
	casesRaw, err := os.ReadFile("testdata/permref-cases.json")
	must(t, err)
	var cases []struct{ SQL, Name, Agent, Action, Reason, Audience string }
	must(t, json.Unmarshal(casesRaw, &cases))

	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.pre.db"))
	i := 0
	for _, c := range cases {
		if c.SQL != "" {
			f.sql(c.SQL)
			continue
		}
		got := refusalOf(t, f, c.Agent, c.Action, c.Reason, c.Audience)
		if i >= len(want) {
			t.Fatalf("%s: TS has no answer for this case", c.Name)
		}
		if want[i].Name != c.Name || want[i].Refused != got {
			t.Errorf("%s: Go refuses %q, TS %q", c.Name, got, want[i].Refused)
		}
		i++
	}
	if i != len(want) {
		t.Errorf("%d cases ran, TS gave %d", i, len(want))
	}
}

// A blank action is refused before anything is stored, mailed or shown, at every audience: the request comes back 400
// and no permission request, mail or wait is written.
func TestAskRefusalBlankActionStoresNothing(t *testing.T) {
	f, _ := permFixture(t)
	before := f.count("SELECT count(*) FROM permission_requests") + f.count("SELECT count(*) FROM mail") + f.count("SELECT count(*) FROM waits")
	for _, body := range []string{
		`{"action":"","reason":"why","audience":"human"}`,
		`{"action":"  \n\t","reason":"why","audience":"delegate"}`,
		`{"action":" ","reason":"why"}`,
	} {
		rec := f.sendH("POST", "/api/permissions", agentTok, nil, body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "`action` is required") {
			t.Errorf("%s: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	if got := f.count("SELECT count(*) FROM permission_requests") + f.count("SELECT count(*) FROM mail") + f.count("SELECT count(*) FROM waits"); got != before {
		t.Errorf("%d rows written, was %d", got, before)
	}
}

// A blank reason is refused where the ask reaches the human: a human ask, and a delegate ask whose parent is paused, so
// no reviewer is live. Nothing is stored.
func TestAskRefusalBlankReasonToTheHuman(t *testing.T) {
	f, _ := permFixture(t)
	f.sql("UPDATE agents SET lifecycle = 'paused' WHERE id = 'aboss'")
	before := f.count("SELECT count(*) FROM permission_requests")
	for _, body := range []string{
		`{"action":"git push","reason":"","audience":"human"}`,
		`{"action":"git push","reason":" \t","audience":"delegate"}`,
	} {
		rec := f.sendH("POST", "/api/permissions", agentTok, nil, body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "`reason` is required when the request reaches your user") {
			t.Errorf("%s: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	if got := f.count("SELECT count(*) FROM permission_requests"); got != before {
		t.Errorf("%d requests, was %d", got, before)
	}
}

// A blank reason is accepted on a delegate ask while a live parent can decide it: the ask does not reach the human.
func TestAskRefusalBlankReasonToALiveReviewer(t *testing.T) {
	f, _ := permFixture(t)
	id := f.ask(`{"action":"git push","reason":"","audience":"delegate"}`)
	if got := f.count("SELECT count(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.permission_id = ? AND r.agent_id = 'aboss'", id); got != 1 {
		t.Errorf("%d mails to the parent", got)
	}
}

// A reviewer lookup that fails fails closed: the ask counts as reaching the human, so the reason is required, and nothing
// is stored. The child's parent is not local and the peer table is gone, so the lookup errors.
func TestAskRefusalReviewerLookupErrorRequiresReason(t *testing.T) {
	f, _ := permFixture(t)
	f.sql("UPDATE agents SET parent_id = 'afar-gone' WHERE id = 'achild'")
	f.sql("DROP TABLE peer_agents")
	if got := refusalOf(t, f, "achild", "git push", "", "delegate"); !strings.Contains(got, "`reason` is required") {
		t.Errorf("a failed reviewer lookup: %q", got)
	}
	if got := refusalOf(t, f, "achild", "git push", "ship it", "delegate"); got != "" {
		t.Errorf("a failed reviewer lookup with a reason: %q", got)
	}
}

// The refusal and the routing read one lookup of the live reviewers. The parent is live for the first lookup and gone for
// any later one: a second lookup would route the blank-reason ask to the human, past the refusal that let it through.
// One lookup sends the ask to the parent, and it is accepted.
func TestAskRefusalOneReviewerLookup(t *testing.T) {
	f, _ := permFixture(t)
	calls := 0
	f.srv.liveReviewersHook = func(ctx context.Context, a db.Agent) ([]string, error) {
		calls++
		if calls == 1 {
			return []string{"aboss"}, nil
		}
		return nil, nil
	}
	id := f.ask(`{"action":"git push","reason":"","audience":"delegate"}`)
	if calls != 1 {
		t.Errorf("%d reviewer lookups for one ask", calls)
	}
	if got := f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild' AND kind = 'agent' AND target = 'aboss' AND data = ?", id); got != 1 {
		t.Errorf("%d waits on the parent", got)
	}
}

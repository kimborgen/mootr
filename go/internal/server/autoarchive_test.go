package server

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/db"
	"stam/internal/jsfmt"
)

// A mail of a test case: from the agent a1 to the human (read unless the JSON says otherwise), from the human, or between
// agents, at the minute given.
func agentMail(id string, min int, extra string) string {
	return fmt.Sprintf(`{"id":%q,"from_id":"a1","created_at":"2026-10-14T06:%02d:00.000Z","kind":"comment","body":"Done: merged.","itsa_id":"i1","recipients":[{"id":"human","read_at":"2026-10-14T07:00:00Z","withdrawn_at":null}]%s}`, id, min, extra)
}

func humanMail(id string, min int, extra string) string {
	return fmt.Sprintf(`{"id":%q,"from_id":"human","created_at":"2026-10-14T06:%02d:00.000Z","kind":"comment","body":"It works","itsa_id":"i1","recipients":[{"id":"a1","read_at":null}]%s}`, id, min, extra)
}

func betweenMail(id string, min int, extra string) string {
	return fmt.Sprintf(`{"id":%q,"from_id":"a2","created_at":"2026-10-14T06:%02d:00.000Z","kind":"comment","body":"Can you check this?","itsa_id":"i1","recipients":[{"id":"a1","read_at":null}]%s}`, id, min, extra)
}

// TestThreadResolvedMatchesTS judges threads with threadResolved and humanWaited and with src/thread-resolved.ts and
// src/auto-archive.ts (testdata/resolvedref.mjs): each clause of the rule, the request threads and the waits.
func TestThreadResolvedMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/thread-resolved.ts")
	}
	closed := `{"i1":"2026-10-14T23:00:00.000Z"}`
	req := func(id string, min int, status string, extra string) string {
		perm := `,"permission":{"status":"` + status + `"}`
		if status == "" {
			perm = ""
		}
		return agentMail(id, min, `,"itsa_id":null,"kind":null,"body":"Permission: push","permission_id":"p`+id+`"`+perm+extra)
	}
	thread := func(mails ...string) string { return `{"thread_id":"t1","mails":[` + strings.Join(mails, ",") + `]}` }
	type tc struct{ thread, closed, open, waits string }
	cases := []tc{
		{thread(agentMail("m1", 10, ""), humanMail("m2", 11, "")), closed, `[]`, `[]`},
		{thread(humanMail("m1", 10, ""), agentMail("m2", 11, "")), closed, `[]`, `[]`},
		{thread(agentMail("m1", 10, ""), humanMail("m2", 11, ""), betweenMail("m3", 12, "")), closed, `[]`, `[]`},
		{thread(agentMail("m1", 10, `,"itsa_id":null`), humanMail("m2", 11, `,"itsa_id":null`)), closed, `[]`, `[]`},
		{thread(req("1", 10, "approved", ""), req("2", 11, "withdrawn", ""), req("3", 12, "expired", "")), closed, `[]`, `[]`},
		{thread(req("1", 10, "approved", `,"recipients":[{"id":"human","read_at":null,"withdrawn_at":"2026-10-14T07:00:00Z"}]`)), closed, `[]`, `[]`},
		{thread(req("1", 10, "pending", "")), closed, `[]`, `[]`},
		{thread(req("1", 10, "", "")), closed, `[]`, `[]`},
		{thread(req("1", 10, "approved", ""), humanMail("m2", 11, `,"itsa_id":null`)), closed, `[]`, `[]`},
		{thread(agentMail("m1", 10, "")), closed, `["m1"]`, `[]`},
		{thread(agentMail("m1", 10, `,"recipients":[{"id":"human","read_at":null,"withdrawn_at":null}]`)), closed, `[]`, `[]`},
		{thread(agentMail("m1", 10, `,"body":"Which one?  "`)), closed, `[]`, `[]`},
		{thread(agentMail("m1", 10, `,"kind":"ask"`)), closed, `[]`, `[]`},
		{thread(agentMail("m1", 10, `,"body":"Pick:\n`+"```decision\\nA?\\n- A\\n- B\\n```"+`"`)), closed, `[]`, `[]`},
		{thread(agentMail("m1", 10, "")), `{"i1":null}`, `[]`, `[]`},
		{thread(agentMail("m1", 10, "")), `{}`, `[]`, `[]`},
		{thread(agentMail("m1", 10, "")), `{"i1":"2026-10-14T06:05:00.000Z"}`, `[]`, `[]`},
		{thread(agentMail("m1", 10, ""), humanMail("m2", 11, "")), `{"i1":"2026-10-14T06:10:30.000Z"}`, `[]`, `[]`},
		{thread(agentMail("m1", 10, `,"itsa_id":null,"about_itsa":"i2"`)), `{"i2":"2026-10-14T23:00:00.000Z"}`, `[]`, `[]`},
		{thread(agentMail("m1", 10, "")), closed, `[]`, `[{"thread":"t1","target":null,"agent":"a9"}]`},
		{thread(agentMail("m1", 10, "")), closed, `[]`, `[{"thread":"t2","target":null,"agent":"a1"}]`},
		{thread(agentMail("m1", 10, "")), closed, `[]`, `[{"thread":null,"target":"m1","agent":"a9"}]`},
		{thread(req("1", 10, "approved", "")), closed, `[]`, `[{"thread":null,"target":"p1","agent":"a1"}]`},
		{thread(agentMail("m1", 10, "")), closed, `[]`, `[{"thread":null,"target":null,"agent":"a1"}]`},
		{thread(agentMail("m1", 10, ""), humanMail("m2", 11, "")), closed, `[]`, `[{"thread":null,"target":null,"agent":"a1"}]`},
		{thread(agentMail("m1", 10, ""), humanMail("m2", 11, "")), closed, `[]`, `[{"thread":null,"target":null,"agent":"a9"}]`},
		{thread(agentMail("m1", 10, ""), humanMail("m2", 11, "")), closed, `[]`, `[{"thread":null,"target":null,"agent":null}]`},
	}
	var in []string
	for _, c := range cases {
		in = append(in, `{"thread":`+c.thread+`,"closed":`+c.closed+`,"open":`+c.open+`,"waits":`+c.waits+`}`)
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "cases.json")
	if err := os.WriteFile(file, []byte("["+strings.Join(in, ",")+"]"), 0o600); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(dir, "home")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("node", "--no-warnings", "testdata/resolvedref.mjs", file, home).Output()
	if err != nil {
		t.Fatalf("resolvedref.mjs: %v", err)
	}
	var want []struct {
		Waited  bool
		Verdict string
	}
	if err := json.Unmarshal(out, &want); err != nil || len(want) != len(cases) {
		t.Fatalf("resolvedref.mjs answered %d verdicts for %d cases: %v %s", len(want), len(cases), err, out)
	}
	resolvedCount := 0
	for i, c := range cases {
		tv, err := jsfmt.Parse([]byte(c.thread))
		if err != nil {
			t.Fatal(err)
		}
		ms, _ := tv.Get("mails")
		th := db.ThreadGroup{ThreadID: tv.Text("thread_id"), Mails: ms.Items}
		var waits []db.HumanWait
		if err := json.Unmarshal([]byte(c.waits), &waits); err != nil {
			t.Fatal(err)
		}
		var cl map[string]*string
		if err := json.Unmarshal([]byte(c.closed), &cl); err != nil {
			t.Fatal(err)
		}
		var open []string
		if err := json.Unmarshal([]byte(c.open), &open); err != nil {
			t.Fatal(err)
		}
		ok, why := threadResolved(th, resolvedCtx{
			itsaClosedAt: func(id string) (string, bool) {
				if at := cl[id]; at != nil && *at != "" {
					return *at, true
				}
				return "", false
			},
			decisionOpen: func(id string) bool { return contains(open, id) },
			humanWaited:  func(t db.ThreadGroup) bool { return humanWaited(t, waits) },
		})
		got := "not: " + why
		if ok {
			got = "resolved: " + why
			resolvedCount++
		}
		if got != want[i].Verdict {
			t.Errorf("case %d: go %q, ts %q", i, got, want[i].Verdict)
		}
		if w := humanWaited(th, waits); w != want[i].Waited {
			t.Errorf("case %d: go waited %v, ts %v", i, w, want[i].Waited)
		}
	}
	if resolvedCount == 0 || resolvedCount == len(cases) {
		t.Errorf("%d of %d cases resolved: the cases don't cover both sides", resolvedCount, len(cases))
	}
}

// foldMails joins copies of one mail from several daemons as src/db.ts foldMails does: recipients join, a read on any
// copy counts, and the first copy's attachments and title stay unless it has none.
func TestFoldMails(t *testing.T) {
	parse := func(s string) jsfmt.Value {
		v, err := jsfmt.Parse([]byte(s))
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	mails := []jsfmt.Value{
		parse(`{"id":"m1","title":null,"recipients":[{"id":"a1","read_at":null}],"attachments":[]}`),
		parse(`{"id":"m2","recipients":[]}`),
		parse(`{"id":"m1","title":"T","recipients":[{"id":"a1","read_at":"R"},{"id":"human","read_at":null}],"attachments":[{"name":"x"}]}`),
		parse(`{"id":"m1","title":"U","recipients":[{"id":"a1","read_at":"S"}],"attachments":[{"name":"y"}]}`),
	}
	got := foldMails(mails)
	want := `[{"id":"m1","title":"T","recipients":[{"id":"a1","read_at":"R"},{"id":"human","read_at":null}],"attachments":[{"name":"x"}]},{"id":"m2","recipients":[]}]`
	if s := jsfmt.Compact(jsfmt.ArrayValue(got)); s != want {
		t.Errorf("folded\n got: %s\nwant: %s", s, want)
	}
	// The inputs are left as they were.
	if s := jsfmt.Compact(mails[0]); s != `{"id":"m1","title":null,"recipients":[{"id":"a1","read_at":null}],"attachments":[]}` {
		t.Errorf("the first copy changed: %s", s)
	}
}

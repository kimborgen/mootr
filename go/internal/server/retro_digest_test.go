package server

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/auth"
	"stam/internal/jsjson"
)

// digestCases are the pure cases digestref.mjs runs through src/retro-digest.ts: digests and the Retros view over fixed
// rows, loop lines, diff word counts and Answers lines, labels and recipients.
func digestCases() map[string]any {
	str := func(s string) *string { return &s }
	yes, no := true, false
	item := func(key, kind, target, evidence string, plusOnes int, created string, report *bool) digestItem {
		return digestItem{ID: "i" + key, Key: key, Title: "T " + key, Status: "backlog", CreatedAt: created, Kind: kind, Target: target, Evidence: evidence, PlusOnes: plusOnes, Report: report}
	}
	var many []digestItem
	for _, k := range []string{"S-9", "S-10", "S-2", "S-11", "s-3"} {
		many = append(many, item(k, "improve", "CLAUDE.md", "gate", 1, "2026-10-12T00:00:00.000Z", &no))
	}
	var archived []digestArchived
	for _, n := range []string{"a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12"} {
		archived = append(archived, digestArchived{Name: n})
	}
	archived = append(archived, digestArchived{Name: "ok", HasRound: true}, digestArchived{Name: "why", Reason: str("stuck")}, digestArchived{Name: "blank", Reason: str("")})
	empty := []digestItem{}
	digests := []map[string]any{
		{"week": "2026-W01", "rows": digestRows{Items: empty, Rounds: []digestRound{}, Archived: []digestArchived{}}},
		// Recurrence alone is not news.
		{"week": "2026-W02", "rows": digestRows{Items: empty, Rounds: []digestRound{}, Archived: []digestArchived{}, Loop: &loopRows{Since: "2026-10-10", Items: []loopItem{{Key: "S-1", Target: "x", CreatedAt: "2026-10-01", PlusOnes: []string{"2026-10-05"}}}, Answers: []loopAnswer{{Proposal: "S-2", Item: "S-1", ClosedAt: "2026-10-02"}}, Words: []wordDelta{}}}},
		{"week": "2026-10-12", "rows": digestRows{
			Items: append(append([]digestItem{}, many...),
				item("S-20", "Beta", "b", "none", 0, "2026-10-12T00:00:00.000Z", nil),
				item("S-21", "alpha", "a", "none", 0, "2026-10-12T00:00:00.000Z", nil),
				item("S-22", "beta", "c", "", 0, "2026-10-13T00:00:00.000Z", nil),
				item("S-23", "bug", "send_mail", "none", 0, "2026-10-13T00:00:00.000Z", &yes),
				item("S-24", "improve", "claude.md", "human", 0, "2026-10-14T00:00:00.000Z", &no),
				item("S-25", "improve", "Claude.md", "odd", 3, "2026-10-14T00:00:00.000Z", &no),
			),
			Rounds: []digestRound{
				{Name: "r1", Model: str("opus"), Type: str("developer"), Effort: map[string]float64{"reading": 33.5, "testing": 66.5}, Measured: map[string]float64{}},
				{Name: "r2", Model: str("opus"), Type: str("developer"), Effort: map[string]float64{"reading": 10}, Measured: map[string]float64{"reading": 70, "waiting": 30}},
				{Name: "r3", Model: str("Haiku"), Type: nil, Effort: map[string]float64{"coordination": 100}},
				{Name: "r4", Model: nil, Type: str("reviewer"), Effort: map[string]float64{"review_fixes": 12.5}, Measured: map[string]float64{"review_fixes": 2.5}},
			},
			Live:     []digestLive{{Name: "l1", Model: str("opus"), Type: str("developer"), Measured: map[string]float64{"reading": 10, "implementing": 90}}, {Name: "l2", Measured: map[string]float64{"waiting": 100}}},
			Archived: archived,
			Loop:     &loopRows{Since: "2026-10-10", Items: []loopItem{{Key: "S-9", Target: "CLAUDE.md", CreatedAt: "2026-10-12", PlusOnes: []string{"2026-10-13"}}}, Answers: []loopAnswer{}, Words: []wordDelta{{File: "AGENTS.md", Delta: -3}}},
		}},
		// Live rows only, and a gap that is positive.
		{"week": "2026-W43", "rows": digestRows{Items: empty, Rounds: []digestRound{{Name: "g", Model: str("m"), Type: str("t"), Effort: map[string]float64{"testing": 10}, Measured: map[string]float64{"testing": 35}}}, Archived: []digestArchived{}, Live: []digestLive{{Name: "z", Measured: map[string]float64{}}}}},
	}
	loopItems := []loopItem{}
	for i, tg := range []string{"t1", "t2", "t3", "t4", "t5", "t6", "T1", " none ", "t2"} {
		loopItems = append(loopItems, loopItem{Key: "S-" + string(rune('a'+i)), Target: tg, CreatedAt: "2026-10-1" + string(rune('0'+i)), PlusOnes: []string{"2026-10-09", "2026-10-15"}})
	}
	var answers []loopAnswer
	for i := range 8 {
		answers = append(answers, loopAnswer{Proposal: "P-" + string(rune('1'+i)), Item: loopItems[i].Key, ClosedAt: "2026-10-1" + string(rune('0'+i))})
	}
	answers = append(answers, loopAnswer{Proposal: "P-9", Item: "S-missing", ClosedAt: "2026-10-01"}, loopAnswer{Proposal: "P-0", Item: "S-a", ClosedAt: "2026-10-01"})
	loops := []map[string]any{
		{"archived": 4, "loop": loopRows{Since: "2026-10-10", Items: loopItems, Answers: answers, Words: []wordDelta{{File: "CLAUDE.md", Delta: -5}, {File: "AGENTS.md", Delta: 2}}}},
		{"archived": 8, "loop": loopRows{Since: "2026-10-13", Items: loopItems[:3], Answers: []loopAnswer{}, Words: []wordDelta{}}},
		{"archived": 3, "loop": loopRows{Since: "2026-10-10", Items: loopItems[:1], Answers: []loopAnswer{}, Words: []wordDelta{}}},
		{"archived": 0, "loop": loopRows{Since: "2026-12-01", Items: []loopItem{}, Answers: []loopAnswer{}, Words: []wordDelta{}}},
	}
	bodies := []string{
		"",
		"Answers: S-1, S-1,T-2 x-3 S-04 S-5x\n\n```diff\n+++ b/CLAUDE.md\n+a b\n-c\n```",
		"intro\n  Answers:\n  S-7, S-8\nAnswers: S-9",
		"XAnswers: S-1\r\n\tAnswers:\tS-2\r\nS-3",
		"line\u2028Answers: S-4\u2029S-5",
		"```diff\n--- a/AGENTS.md\n+one\n``` \nmore\n+two\n```\n",
		"```diff\r\n+++ b/CLAUDE.md\n+x\n```",
		"```diff\n+++ b/CLAUDE.md\n+no close",
		"text ```diff\n+++ b/CLAUDE.md\n+x\n```\n```diff\ndiff --git a/a b/templates/type-x.md\n+ one\u00a0two\n-\n+three\r\n```",
		"```diff\n```",
		"```diff\n--- a/templates/type-x/y.md\n+a\n+++ b/CLAUDE.md\r\n+b\ndiff --git a/x b/AGENTS.md\n+c d e\n-c d e\n```",
	}
	labels := []map[string]string{
		{"at": "2026-01-01T12:00:00.000Z", "day": "mon"}, {"at": "2027-01-01T12:00:00.000Z", "day": "fri"},
		{"at": "2024-12-30T12:00:00.000Z", "day": "sun"}, {"at": "2026-10-25T12:00:00.000Z", "day": "daily"}, {"at": "2026-03-09T12:00:00.000Z", "day": "tue"},
	}
	recipients := []map[string]any{
		{"retros": map[string]any{"owner": "o", "participants": []string{"p", "human", "o", "q", "p"}}, "live": []string{"o", "p", "human"}, "cos": "cos"},
		{"retros": map[string]any{"owner": "o", "participants": []string{"cos", "p"}}, "live": []string{"p", "cos"}, "cos": "cos"},
		{"retros": nil, "live": []string{}, "cos": "cos"},
		{"retros": map[string]any{"owner": nil, "participants": []string{}}, "live": []string{}, "cos": nil},
		{"retros": nil, "live": []string{}, "cos": "human"},
	}
	epicItems := []map[string]any{
		{"key": "S-1", "body": "Kind: idea\nOn: S-10 the work\nReporter: a (m, t)\n\nx"},
		{"key": "S-2", "body": "Kind: idea\nOn: S-11\nReporter: b\n\nx"},
		{"key": "S-3", "body": "Kind: idea\nOn: S-10\nReporter: c (m, t)\n\nx"},
		{"key": "S-4", "body": "Kind: idea\nOn: S-99\nReporter: d\n\nx"},
		{"key": "S-5", "body": "Kind: idea\nReporter: e\n\nOn: S-10"},
		{"key": "S-6", "body": "Kind: idea\nOn: S-10\nReporter:  (m, t)\n\nx"},
		{"key": "S-7", "body": "Kind: idea\nOn: S-11\tlater\nReporter: \tb\t\n\nx"},
		{"key": "S-8", "body": nil},
	}
	cfg := map[string]any{"minReporters": 3, "maxWindowShare": 50}
	share := func(n float64) *float64 { return &n }
	epic := func(kind string, sh *float64, c map[string]any, items []map[string]any) map[string]any {
		return map[string]any{"epic": map[string]any{"key": "S-10", "kind": kind}, "subtree": []string{"S-10", "S-11"}, "items": items, "share": sh, "cfg": c}
	}
	epics := []map[string]any{
		epic("issue", share(1), cfg, epicItems),
		epic("project", share(10), cfg, epicItems),
		epic("project", share(50), cfg, epicItems),
		epic("initiative", nil, cfg, epicItems),
		epic("project", share(0), cfg, epicItems[:2]),
		epic("initiative", share(99.5), map[string]any{"minReporters": 1, "maxWindowShare": 100}, epicItems[4:]),
		epic("project", nil, cfg, epicItems[3:6]),
		// b and `b (x, y)` are one reporter: two in all, so no offer.
		epic("project", nil, cfg, append([]map[string]any{{"key": "S-9", "body": "Kind: idea\nOn: S-10\nReporter: b (x, y)\n\nx"}}, epicItems[:2]...)),
	}
	return map[string]any{"epics": epics, "digests": digests, "loops": loops, "bodies": bodies, "labels": labels, "recipients": recipients}
}

// stringifyT is the server's JSON.stringify of v.
func stringifyT(t *testing.T, v any) string {
	t.Helper()
	b, err := stringify(v)
	must(t, err)
	return string(b)
}

// TestRetroDigestMatchesTS runs src/retro-digest.ts (testdata/digestref.mjs) over a seeded home and the pure cases, and
// the Go port over the same stam.db and cases: the Retros view, an agent type's memory, the digest, and each case must
// be the same.
func TestRetroDigestMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/retro-digest.ts")
	}
	cases := digestCases()
	root := t.TempDir()
	casesFile := filepath.Join(root, "cases.json")
	raw, err := json.Marshal(cases)
	must(t, err)
	must(t, os.WriteFile(casesFile, raw, 0o600))
	home := filepath.Join(root, "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/digestref.mjs", home, casesFile).CombinedOutput(); err != nil {
		t.Fatalf("digestref.mjs: %v\n%s", err, out)
	}
	expectRaw, err := os.ReadFile(filepath.Join(home, "expect.json"))
	must(t, err)
	var want struct {
		Since          string     `json:"since"`
		Retros         string     `json:"retros"`
		RetrosType     string     `json:"retrosType"`
		RetrosReviewer string     `json:"retrosReviewer"`
		Digest         *string    `json:"digest"`
		Digests        []*string  `json:"digests"`
		RetrosOf       []string   `json:"retrosOf"`
		Loops          [][]string `json:"loops"`
		Words          []json.RawMessage
		Answers        [][]string `json:"answers"`
		Labels         []string   `json:"labels"`
		Recipients     [][]string `json:"recipients"`
		Epic           struct {
			Key   string  `json:"key"`
			Offer *string `json:"offer"`
		} `json:"epic"`
		Epics []*string `json:"epics"`
	}
	must(t, json.Unmarshal(expectRaw, &want))

	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.pre.db"))
	for _, c := range []struct{ path, want string }{
		{"/api/retros?since=" + want.Since, want.Retros},
		{"/api/retros?type=developer", want.RetrosType},
		{"/api/retros?type=reviewer", want.RetrosReviewer},
	} {
		rec := f.post2("GET", c.path, "")
		if got := strings.TrimSpace(rec.Body.String()); rec.Code != 200 || got != c.want {
			t.Errorf("GET %s: %d\n got %s\nwant %s", c.path, rec.Code, got, c.want)
		}
	}
	if !strings.Contains(want.Retros, `"report":true`) || !strings.Contains(want.Retros, `"without":["agone"]`) || !strings.Contains(want.RetrosType, `"status":"done"`) {
		t.Errorf("the seeded view tests too little: %s", want.Retros)
	}
	// Closing the seeded epic offers its retro, after the reads above.
	rec := f.post2("PATCH", "/api/itsas/"+want.Epic.Key, `{"status":"done"}`)
	var closed struct {
		RetroOffer *string `json:"retro_offer"`
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &closed))
	if rec.Code != 200 || want.Epic.Offer == nil || deref(closed.RetroOffer) != *want.Epic.Offer || !strings.Contains(*want.Epic.Offer, "Write the epic retro yourself") {
		t.Errorf("closing the epic: %d %s\nwant %q", rec.Code, rec.Body, deref(want.Epic.Offer))
	}
	rows, err := f.srv.gatherRetros(context.Background(), want.Since, true)
	must(t, err)
	got, ok := buildDigest(rows, "2026-W42")
	if want.Digest == nil || !ok || got != *want.Digest {
		t.Errorf("digest:\n got %q\nwant %q", got, deref(want.Digest))
	}
	for _, part := range []string{"(live, not archived)", "measured 40%", "agone: it was stuck", "Recurrence: ", "Instruction words: ", "more items without evidence"} {
		if want.Digest == nil || !strings.Contains(*want.Digest, part) {
			t.Errorf("the seeded digest lacks %q, so it tests too little", part)
		}
	}

	// The pure cases, decoded from the JSON TS read so both sides see the same rows.
	var in struct {
		Digests []struct {
			Week string     `json:"week"`
			Rows digestRows `json:"rows"`
		} `json:"digests"`
		Loops []struct {
			Archived int      `json:"archived"`
			Loop     loopRows `json:"loop"`
		} `json:"loops"`
		Bodies []string                   `json:"bodies"`
		Labels []struct{ At, Day string } `json:"labels"`
		Epics  []struct {
			Epic    struct{ Key, Kind string } `json:"epic"`
			Subtree []string                   `json:"subtree"`
			Items   []struct {
				Key  string  `json:"key"`
				Body *string `json:"body"`
			} `json:"items"`
			Share *float64 `json:"share"`
			Cfg   struct {
				MinReporters   int     `json:"minReporters"`
				MaxWindowShare float64 `json:"maxWindowShare"`
			} `json:"cfg"`
		} `json:"epics"`
		Recipients []struct {
			Retros *struct {
				Owner        *string  `json:"owner"`
				Participants []string `json:"participants"`
			} `json:"retros"`
			Live []string `json:"live"`
			Cos  *string  `json:"cos"`
		} `json:"recipients"`
	}
	must(t, json.Unmarshal(raw, &in))
	if len(want.Digests) != len(in.Digests) || len(want.Loops) != len(in.Loops) || len(want.Words) != len(in.Bodies) || len(want.Labels) != len(in.Labels) || len(want.Recipients) != len(in.Recipients) {
		t.Fatalf("digestref.mjs answered %d digests, %d loops, %d bodies, %d labels, %d recipients", len(want.Digests), len(want.Loops), len(want.Words), len(want.Labels), len(want.Recipients))
	}
	sent := 0
	for i, c := range in.Digests {
		got, ok := buildDigest(c.Rows, c.Week)
		if w := want.Digests[i]; (w != nil) != ok || (ok && got != *w) {
			t.Errorf("digest case %d:\n got %q\nwant %q", i, got, deref(w))
		}
		if ok {
			sent++
		}
		if got, w := stringifyT(t, buildRetros(c.Rows)), want.RetrosOf[i]; got != w {
			t.Errorf("retros case %d:\n got %s\nwant %s", i, got, w)
		}
	}
	if sent == 0 || sent == len(in.Digests) {
		t.Errorf("%d of %d digest cases sent: the cases test too little", sent, len(in.Digests))
	}
	for i, c := range in.Loops {
		if got, w := strings.Join(loopLines(c.Loop, c.Archived), "\n"), strings.Join(want.Loops[i], "\n"); got != w {
			t.Errorf("loop case %d:\n got %s\nwant %s", i, got, w)
		}
	}
	for i, b := range in.Bodies {
		words := wordsInDiff(b)
		if words == nil {
			words = []wordDelta{}
		}
		if got, w := stringifyT(t, words), string(want.Words[i]); got != w {
			t.Errorf("words of body %d %q: got %s, want %s", i, b, got, w)
		}
		if got, w := strings.Join(answersOf(b), ","), strings.Join(want.Answers[i], ","); got != w {
			t.Errorf("answers of body %d %q: got %s, want %s", i, b, got, w)
		}
	}
	for i, l := range in.Labels {
		at, err := time.Parse(time.RFC3339Nano, l.At)
		must(t, err)
		if got := digestLabel(at.Local(), l.Day); got != want.Labels[i] {
			t.Errorf("label of %s %s: got %s, want %s", l.At, l.Day, got, want.Labels[i])
		}
	}
	if len(want.Epics) != len(in.Epics) {
		t.Fatalf("digestref.mjs answered %d epics", len(want.Epics))
	}
	offers := 0
	for i, c := range in.Epics {
		sub := map[string]bool{}
		for _, k := range c.Subtree {
			sub[k] = true
		}
		var items []epicItem
		for _, x := range c.Items {
			b := ""
			if x.Body != nil {
				b = *x.Body
			}
			items = append(items, epicItem{x.Key, b})
		}
		got, err := epicOffer(c.Epic.Key, c.Epic.Kind, sub, items, c.Share, c.Cfg.MinReporters, c.Cfg.MaxWindowShare,
			func(vars map[string]string) (string, error) { return f.srv.render("retro-epic", vars) })
		must(t, err)
		w := want.Epics[i]
		if (w == nil) != (got == "") || (w != nil && got != *w) {
			t.Errorf("epic case %d:\n got %q\nwant %q", i, got, deref(w))
		}
		if w != nil {
			offers++
		}
	}
	if offers == 0 || offers == len(in.Epics) {
		t.Errorf("%d of %d epic cases offer: the cases test too little", offers, len(in.Epics))
	}
	for i, r := range in.Recipients {
		owner, participants := "", []string(nil)
		if r.Retros != nil {
			owner, participants = deref(r.Retros.Owner), r.Retros.Participants
		}
		live := func(ref string) bool {
			for _, x := range r.Live {
				if x == ref {
					return true
				}
			}
			return false
		}
		if got, w := strings.Join(digestRecipients(owner, participants, live, deref(r.Cos)), ","), strings.Join(want.Recipients[i], ","); got != w {
			t.Errorf("recipients case %d: got %s, want %s", i, got, w)
		}
	}
}

// TestRetrosRoute: a bad since or type is a 400, as in TS.
func TestRetrosRoute(t *testing.T) {
	f := newFixture(t, nil)
	for _, c := range []struct{ path, want string }{
		{"/api/retros?since=yesterday", "since must be an ISO time"},
		{"/api/retros?type=a%20b", "type must be an agent type name"},
	} {
		if rec := f.post2("GET", c.path, ""); rec.Code != 400 || !strings.Contains(rec.Body.String(), c.want) {
			t.Errorf("GET %s: %d %s", c.path, rec.Code, rec.Body)
		}
	}
	for _, p := range []string{"/api/retros", "/api/retros?since=2026-10-01", "/api/retros?since=2026-10-01T00:00:00%2B02:00"} {
		if rec := f.post2("GET", p, ""); rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), `{"items":[`) {
			t.Errorf("GET %s: %d %s", p, rec.Code, rec.Body)
		}
	}
}

// TestRetroDigestSend: POST /api/retros/digest refuses an agent's token; the digest goes to the Retros owner, records
// lastDigest, reads from it the next time, and says when there is nothing new or nobody to send it to.
func TestRetroDigestSend(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to seed the home")
	}
	root := t.TempDir()
	casesFile := filepath.Join(root, "cases.json")
	must(t, os.WriteFile(casesFile, []byte(`{"epics":[],"digests":[],"loops":[],"bodies":[],"labels":[],"recipients":[]}`), 0o600))
	home := filepath.Join(root, "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/digestref.mjs", home, casesFile).CombinedOutput(); err != nil {
		t.Fatalf("digestref.mjs: %v\n%s", err, out)
	}
	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.pre.db"))
	ctx := context.Background()
	// The fixture's agent token, on a seeded agent.
	must(t, f.db.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "UPDATE agents SET token_hash = ? WHERE id = 'adev3'", &sqlitex.ExecOptions{Args: []any{auth.Hash(agentTok)}})
	}))

	if rec := f.send("POST", "/api/retros/digest", agentTok, "{}"); rec.Code != 403 || !strings.Contains(rec.Body.String(), "send the retro digest") {
		t.Errorf("an agent's token: %d %s", rec.Code, rec.Body)
	}
	if rec := f.post2("POST", "/api/retros/digest", "{}"); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"sent":false,"to":null,"reason":"no Retros owner or chief of staff to send it"}` {
		t.Errorf("nobody to send it: %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(filepath.Join(f.home, "settings.json")); err == nil {
		t.Error("nobody to send it: lastDigest recorded")
	}
	f.createItsa(`{"title":"Retros","kind":"retros","owner":"adev1","participants":["adev2","alive"],"by":"human"}`)
	must(t, f.db.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "UPDATE agents SET lifecycle = 'archived' WHERE id = 'adev2'", nil)
	}))

	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	res, err := f.srv.sendDigest(ctx, now)
	must(t, err)
	if !res.Sent || deref(res.To) != "dev1, livey" || res.Reason != "" {
		t.Errorf("first digest = %+v %s", res, deref(res.To))
	}
	if last := lastDigest(t, f); last != "2026-10-16T12:00:00.000Z" {
		t.Errorf("lastDigest = %q", last)
	}
	// From the last digest on: a +1 after it is news.
	res, err = f.srv.sendDigest(ctx, now.Add(time.Hour))
	must(t, err)
	if !res.Sent {
		t.Errorf("second digest = %+v", res)
	}
	// Since 2026-10-16T13:00, the +1s of 10-17 and 10-18 are news.
	res, err = f.srv.sendDigest(ctx, time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC))
	must(t, err)
	if !res.Sent {
		t.Errorf("third digest = %+v", res)
	}
	res, err = f.srv.sendDigest(ctx, time.Date(2026, 12, 2, 0, 0, 0, 0, time.UTC))
	must(t, err)
	if res.Sent || res.Reason != "nothing new since the last digest" || deref(res.To) != "dev1, livey" {
		t.Errorf("nothing new = %+v", res)
	}
	if last := lastDigest(t, f); last != "2026-12-02T00:00:00.000Z" {
		t.Errorf("nothing new: lastDigest = %q", last)
	}
	var subjects []string
	must(t, f.db.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT subject FROM mail WHERE from_id = 'system:retro' ORDER BY created_at", &sqlitex.ExecOptions{
			ResultFunc: func(stmt *sqlite.Stmt) error { subjects = append(subjects, stmt.ColumnText(0)); return nil }})
	}))
	if len(subjects) != 3 || subjects[0] != "Retro digest: 2026-10-16" {
		t.Errorf("digest mail subjects = %v", subjects)
	}
}

func lastDigest(t *testing.T, f *fixture) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(f.home, "settings.json"))
	must(t, err)
	v, err := jsjson.Parse(b)
	must(t, err)
	r, _ := v.(*jsjson.Object).Get("retro")
	l, _ := r.(*jsjson.Object).Get("lastDigest")
	s, _ := l.(string)
	return s
}

package lifecycle

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// issueFixture is the summary fixture with ITSAs: its samples split over ITSAs an agent owned while they were active,
// took part in, or neither; an owner change; a manager's spend that sets no config; a project over two issues; and the
// issues typicalIssue leaves out for their kind, status, age or close time.
func issueFixture(t *testing.T) *live {
	l := summaryFixture(t)
	at := func(minutesAgo float64) string { return isoMs(summaryNow - minutesAgo*60_000) }
	// The agents existed before the samples, so the owner and participant rules apply.
	l.exec("UPDATE agents SET created_at = ?", at(60*24*3))
	// A 7-day window for the worth, rising with the 5-hour one.
	for i, used := range []float64{40, 41, 42, 42, 43, 44, 45, 46} {
		l.exec("INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES ('claude', 'seven_day', ?, ?, ?)", at(float64(240-i*30)), used, summaryNow/1000+3*86_400)
	}
	// A manager's spend: it counts toward its ITSA's cost but never sets the config.
	for i := 1; i < 4; i++ {
		l.exec("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out) VALUES ('sr', 'max', 'claude', 'claude-sonnet-5-5', ?, 3, 100, 10)", isoMs(floorBucket(summaryNow-float64(i*40)*60_000)))
	}
	day := func(d float64) string { return at(60 * 24 * d) }
	for _, x := range []struct{ id, kind, status, owner, created, closed, parent string }{
		{"i1", "issue", "done", "sd1", day(2), at(60), "i5"},     // sd1's until it closed an hour ago
		{"i2", "issue", "in_progress", "sd1", at(180), "", "i5"}, // sd1's too while both are active; sd2 takes part
		{"i3", "issue", "done", "sr", day(10), at(30), ""},       // sd2's, then the manager's from two hours ago
		{"i4", "issue", "done", "sd2", day(40), at(20), ""},      // created before the samples are kept
		{"i5", "project", "done", "sd2", day(2), at(20), ""},     // not an issue
		{"i6", "issue", "canceled", "sx", day(2), day(29), ""},   // closed too long ago
		{"i7", "issue", "wont_do", "so", day(1), at(10), ""},     // so's: no samples, no cost
		{"i8", "issue", "done", "sd2", day(1), at(5), ""},        // sd2's alone
	} {
		var closed, parent any
		if x.closed != "" {
			closed = x.closed
		}
		if x.parent != "" {
			parent = x.parent
		}
		l.exec("INSERT INTO itsas (id, key, kind, title, status, owner, parent_id, created_by, created_at, updated_at, closed_at) VALUES (?, ?, ?, 't', ?, ?, ?, 'human', ?, ?, ?)",
			x.id, "S-"+x.id, x.kind, x.status, x.owner, parent, x.created, x.created, closed)
		l.exec("INSERT INTO itsa_events (itsa_id, ts, type, data) VALUES (?, ?, 'created', ?)", x.id, x.created, `{"status":"in_progress"}`)
		if x.closed != "" {
			l.exec("INSERT INTO itsa_events (itsa_id, ts, type, data) VALUES (?, ?, 'status', ?)", x.id, x.closed, `{"from":"in_progress","to":"`+x.status+`"}`)
		}
	}
	l.exec("INSERT INTO itsa_events (itsa_id, ts, type, data) VALUES ('i3', ?, 'owner', ?)", at(120), `{"from":"sd2","to":"sr"}`)
	l.exec("INSERT INTO itsa_participants (itsa_id, agent_id) VALUES ('i2', 'sd2'), ('i8', 'sd1')")
	return l
}

// TypicalIssue over the same rows as src/issue-costs.ts typicalIssue (testdata/usageref.mjs on a copy of the
// database, its clock fixed at summaryNow), compared as JSON text.
func TestTypicalIssueMatchesTS(t *testing.T) {
	l := issueFixture(t)

	configs := []string{"claude · claude-opus-5-5", "claude · claude-haiku-5-5", "claude · claude-sonnet-5-5", "codex · unknown"}
	var got []jsjson.Value
	for _, c := range configs {
		v, err := l.life.TypicalIssue(l.ctx, c, summaryNow)
		if err != nil {
			t.Fatal(err)
		}
		if v == nil {
			got = append(got, nil)
		} else {
			got = append(got, v)
		}
	}
	g := jsjson.Stringify(got, "")
	cj, _ := json.Marshal(configs)
	w := usageRef(t, l, summarySettings, summaryRegistry, summaryNow, "typical", "", string(cj))
	if g != w {
		t.Errorf("typical issues differ\n go: %s\n ts: %s", g, w)
	}
	// What the comparison stands on: configs with a count, a median and a numeric weekly percent.
	for _, want := range []string{`"config":"claude · claude-opus-5-5","n":1,"median_cost_usd":2,"median_weekly_percent":65.57}`,
		`"config":"claude · claude-haiku-5-5","n":2,"median_cost_usd":4.566667,"median_weekly_percent":149.73}`} {
		if !strings.Contains(g, want) {
			t.Errorf("typical issues lack %s: %s", want, g)
		}
	}

	// The summary's tree view (usage_info tree=) for a developer: its tree summary, allocations and typical issue,
	// right after the allocations; built for the agent the route resolved, so its id is that agent's.
	for _, id := range []string{"sd1", "so"} {
		root, err := l.db.GetAgent(l.ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		sum, err := l.life.UsageSummary(l.ctx, SummaryOptions{Days: 14, TypeOf: summaryTypes, Now: summaryNow, Tree: &root})
		if err != nil {
			t.Fatal(err)
		}
		g := jsjson.Stringify(sum, "")
		if w := usageRef(t, l, summarySettings, summaryRegistry, summaryNow, "summary", "", "14", "null", id); g != w {
			t.Errorf("summary with tree %s differs\n go: %s\n ts: %s", id, g, w)
		}
		tree, _ := sum.Get("tree")
		if got, _ := tree.(*jsjson.Object).Get("id"); got != root.ID {
			t.Errorf("tree %s: the view's id is %v, want %s", id, got, root.ID)
		}
		keys := strings.Join(sum.Keys(), ",")
		if !strings.Contains(keys, "allocations,tree,today") {
			t.Errorf("tree %s: keys %s", id, keys)
		}
		if id == "sd1" && !strings.Contains(g, `"typical_issue":{"estimate":true`) {
			t.Errorf("tree sd1 has no typical issue: %s", g)
		}
	}
}

// IssueCosts (GET /api/usage/issues) over the same rows as src/issue-costs.ts issueCosts with the daemon's display
// context, compared as JSON text: every ITSA's own and total spend (a project over two issues), agents, config, weekly
// percent and units; the per-config rows with units; and the unattributed and whole spend, over every sample and the
// last day.
func TestIssueCostsMatchesTS(t *testing.T) {
	l := issueFixture(t)
	// The 7-day window in the readings, so the snapshot has its worth: the week and real units and weekly percents.
	resets := strconv.FormatFloat(summaryNow/1000+3*86_400, 'f', -1, 64)
	l.exec("UPDATE subscriptions SET data = ? WHERE name = 'claude'", `{"five_hour":{"used_percentage":31,"resets_at":`+strconv.FormatFloat(summaryNow/1000+3600, 'f', -1, 64)+`},"seven_day":{"used_percentage":46,"resets_at":`+resets+`}}`)
	// Spend no ITSA explains (an agent with none), and sd1's spend three days ago, outside days=1.
	l.exec("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES ('gone', 'codex', 'codex', 'gpt-6', ?, 0.7, 50, 5, 3, 1)", isoMs(floorBucket(summaryNow-30*60_000)))
	l.exec("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out) VALUES ('sd1', 'max', 'claude', 'claude-opus-5-5', ?, 1.25, 10, 1)", isoMs(floorBucket(summaryNow-3*dayMs)))
	one := 1.0
	for _, days := range []*float64{nil, &one} {
		got, err := l.life.IssueCosts(l.ctx, days, summaryNow)
		if err != nil {
			t.Fatal(err)
		}
		g := jsjson.Stringify(got, "")
		arg := "null"
		if days != nil {
			arg = "1"
		}
		if w := usageRef(t, l, summarySettings, summaryRegistry, summaryNow, "issues", "", arg); g != w {
			t.Errorf("days %s: issue costs differ\n go: %s\n ts: %s", arg, g, w)
		}
		// What the comparison stands on: the project's total holds its issues', and a config row has units.
		if days == nil {
			var parsed struct {
				Issues []struct {
					Key string
					Own struct {
						CostUSD float64 `json:"cost_usd"`
					}
					Total struct {
						CostUSD float64 `json:"cost_usd"`
					}
				}
			}
			if err := json.Unmarshal([]byte(g), &parsed); err != nil {
				t.Fatal(err)
			}
			for _, x := range parsed.Issues {
				if x.Key == "S-i5" && (x.Own.CostUSD != 0.083333 || x.Total.CostUSD != 4.416667) {
					t.Errorf("the project S-i5: own %v, total %v; want 0.083333 and its issues' 4.416667", x.Own.CostUSD, x.Total.CostUSD)
				}
			}
			for _, want := range []string{`"key":"S-i5"`, `"week":{"n":2,"median":149.725,`, `"unattributed":{"cost_usd":0.7,`} {
				if !strings.Contains(g, want) {
					t.Errorf("issue costs lack %s: %s", want, g)
				}
			}
		}
	}
}

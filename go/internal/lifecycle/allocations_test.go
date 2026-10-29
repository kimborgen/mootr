package lifecycle

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// The tests of allocations.go. TestAllocationsMatchesTS runs each case on the Go allocations and on src/allocations.ts
// (testdata/allocref.mjs) and compares every step's result as TS prints it: a set's stored row and overlap warning or
// refusal, a clear's count, the view with each tree's use and projection, and the cost notices a check raises with the
// mail they send. Allocation and notice ids are random and set_at is the wall clock, so they are compared by position.

// The reading's name (claude, the harness) isn't its account's (max), so a check that took one for the other fails.
const allocSettings = `{"chiefOfStaff":"n-ccos","cost":{"accounts":{"max":{"match":{"harness":"claude"}},` +
	`"api":{"match":{"harness":"codex"},"paid":true},"openrouter":{"match":{"harness":"opencode"}}}}}`

type allocUsage struct {
	Agent   string  `json:"agent"`
	Day     string  `json:"day"`
	Account string  `json:"account"`
	Cost    float64 `json:"cost"`
	Paid    float64 `json:"paid"`
}

type allocRow struct {
	ID     string  `json:"id"`
	Root   string  `json:"root"`
	Amount float64 `json:"amount"`
}

type allocStep struct {
	Op      string          `json:"op"` // set, clear, view, checkWindow, checkUsd, usage
	By      string          `json:"by,omitempty"`
	Input   json.RawMessage `json:"input,omitempty"`
	IDFrom  *int            `json:"idFrom,omitempty"` // clear: the id of the allocation an earlier set step stored
	Tree    string          `json:"tree,omitempty"`
	Name    string          `json:"name,omitempty"`
	Window  string          `json:"window,omitempty"`
	Account string          `json:"account,omitempty"`
	Usage   []allocUsage    `json:"usage,omitempty"`
	Now     float64         `json:"now,omitempty"` // ms after T0
}

type allocCase struct {
	Name    string      `json:"name"`
	Agents  []attrAgent `json:"agents"`
	Adopted [][2]string `json:"adopted,omitempty"`
	Peers   []attrPeer  `json:"peers,omitempty"`
	// Rows are allocations stored as they are, such as one on a peer's agent, which set can't make.
	Rows     []allocRow    `json:"rows,omitempty"`
	Samples  []attrSample  `json:"samples,omitempty"`
	Readings []attrReading `json:"readings,omitempty"`
	Usage    []allocUsage  `json:"usage,omitempty"`
	Steps    []allocStep   `json:"steps"`
}

func set(by, input string) allocStep {
	return allocStep{Op: "set", By: by, Input: json.RawMessage(input)}
}

func clr(by, input string) allocStep {
	return allocStep{Op: "clear", By: by, Input: json.RawMessage(input)}
}

func clrID(by string, step int) allocStep {
	return allocStep{Op: "clear", By: by, Input: json.RawMessage(`{}`), IDFrom: &step}
}

var allocTree = []attrAgent{{ID: "ccos"}, {ID: "cmgr", Parent: "ccos"}, {ID: "cdev", Parent: "cmgr"}, {ID: "cdv2", Parent: "cmgr"}, {ID: "coth"}}

func allocCases() []allocCase {
	R1 := f64(reset1)
	five := "five_hour"
	win := func(tree string, pct any) string {
		b, _ := json.Marshal(pct)
		return `{"tree":"` + tree + `","account":"max","kind":"window","window":"five_hour","percent":` + string(b) + `}`
	}
	usd := func(tree, account, period string, amount any) string {
		b, _ := json.Marshal(amount)
		return `{"tree":"` + tree + `","account":"` + account + `","kind":"usd","period":"` + period + `","amount":` + string(b) + `}`
	}
	day := "2026-10-11"
	return []allocCase{
		{Name: "set and overlap", Agents: allocTree, Steps: []allocStep{
			set("ccos", win("cmgr", 50)),
			set("cmgr", win("cdev", 30)),
			set("cmgr", win("n-cdv2", "30")),
			set("cmgr", `{"tree":"cdev","account":"max","kind":"window","window":" five_hour ","percent":10,"note":"  keep it small "}`),
			set(humanID, `{"tree":"coth","account":" max ","kind":"window","window":"five_hour","percent":5,"note":"   "}`),
			{Op: "view"},
			{Op: "view", Tree: "cdev"},
		}},
		{Name: "refusals", Agents: allocTree, Steps: []allocStep{
			set("cdev", win("cmgr", 10)),
			set("cdv2", win("cdev", 10)),
			set("ccos", win("nobody", 10)),
			set("ccos", `{"account":"max","kind":"window","window":"five_hour","percent":10}`),
			set("ccos", `{"tree":0,"account":"max","kind":"window","window":"five_hour","percent":10}`),
			set("ccos", `{"tree":"cmgr","account":"  ","kind":"window","window":"five_hour","percent":10}`),
			set("ccos", `{"tree":"cmgr","account":"max","kind":"Window","window":"five_hour","percent":10}`),
			set("ccos", `{"tree":"cmgr","account":"max","kind":5,"window":"five_hour","percent":10}`),
			set("ccos", `{"tree":"cmgr","account":"max","kind":"window","percent":10}`),
			set("ccos", win("cmgr", 0)),
			set("ccos", win("cmgr", "abc")),
			set("ccos", win("cmgr", -3)),
			set("ccos", win("cmgr", nil)),
			set("ccos", usd("cmgr", "openrouter", "year", 5)),
			set("ccos", `{"tree":"cmgr","account":"openrouter","kind":"usd","period":"day"}`),
			set("ccos", usd("cmgr", "openrouter", " week ", "12")),
			set("stam", win("cdev", 7)),
			set("cmgr", win("cmgr", 7)),
			set("cdev", win("cdev", 8)),
		}},
		{Name: "usd overlap", Agents: allocTree, Adopted: [][2]string{{"cdev", "ccos"}}, Steps: []allocStep{
			set(humanID, usd("ccos", "openrouter", "day", 10)),
			set("ccos", usd("cmgr", "openrouter", "day", 6)),
			set("cmgr", usd("cdev", "openrouter", "day", 5)),
			set("cmgr", usd("cdv2", "openrouter", "day", 4)),
			set(humanID, usd("ccos", "openrouter", "week", 0.3)),
			set("ccos", usd("cmgr", "openrouter", "week", 0.1)),
			set("ccos", usd("cdev", "openrouter", "week", 0.2)),
			set(humanID, win("ccos", 12.5)),
			set("ccos", win("cmgr", 7.25)),
			set("ccos", win("cdev", 5.5)),
		}},
		{Name: "a peer's child", Agents: allocTree, Peers: []attrPeer{{ID: "cpeer", Parents: []string{"cmgr"}}},
			Rows: []allocRow{{ID: "al-0000beef", Root: "cpeer", Amount: 4}}, Steps: []allocStep{
				set("ccos", usd("cmgr", "openrouter", "day", 6)),
				set("cmgr", usd("cdev", "openrouter", "day", 3)),
			}},
		{Name: "clear", Agents: allocTree, Steps: []allocStep{
			set("ccos", win("cmgr", 50)),
			set("ccos", usd("cmgr", "openrouter", "day", 3)),
			clrID("cdev", 0),
			clr("ccos", `{"id":"al-nothing"}`),
			clrID("ccos", 0),
			clr("ccos", `{"tree":"cmgr","account":"openrouter","kind":"usd","period":"day","window":"five_hour"}`),
			clr("ccos", `{"tree":"cmgr","account":"openrouter","kind":"usd","period":"day"}`),
			clr("ccos", `{"tree":"cmgr","account":"max","window":"five_hour"}`),
			clr("ccos", `{"account":"max"}`),
			clr("cdv2", `{"tree":"cmgr","account":"max","window":"five_hour"}`),
			{Op: "view"},
		}},
		{Name: "usd notices", Agents: allocTree,
			Usage: []allocUsage{{"cdev", day, "openrouter", 5, 0}, {"cdv2", day, "openrouter", 3.5, 0}, {"coth", "2026-10-01", "openrouter", 0.9, 0},
				{"cdev", "2026-10-06", "api", 100, 15}, {"cdev", "2026-10-04", "api", 1, 50}, {"cdv2", "2026-10-05", "api", 0, 1},
				{"cdv2", "2026-10-07", "api", 0, 0.004}},
			Steps: []allocStep{
				set("ccos", usd("cmgr", "openrouter", "day", 10)),
				set("ccos", `{"tree":"cmgr","account":"api","kind":"usd","period":"week","amount":20,"note":"the API key"}`),
				set("ccos", usd("coth", "openrouter", "month", 1)),
				{Op: "checkUsd", Account: "openrouter", Now: 360 * minute},
				{Op: "checkUsd", Account: "api", Now: 360 * minute},
				{Op: "checkUsd", Account: "openrouter", Now: 361 * minute},
				{Op: "usage", Usage: []allocUsage{{"cmgr", day, "openrouter", 2, 0}, {"cdev", day, "api", 0, 1}}},
				{Op: "checkUsd", Account: "openrouter", Now: 362 * minute},
				{Op: "checkUsd", Account: "api", Now: 362 * minute},
				{Op: "checkUsd", Account: "", Now: 362 * minute},
				// 0.9 + 0.1 is 0.9999999999999999: rounded to cents it is the whole allocation, so 100%.
				{Op: "usage", Usage: []allocUsage{{"coth", "2026-10-02", "openrouter", 0.1, 0}}},
				{Op: "checkUsd", Account: "openrouter", Now: 363 * minute},
				{Op: "view", Now: 362 * minute},
			}},
		{Name: "window notices", Agents: append(append([]attrAgent{}, allocTree...), attrAgent{ID: "cout"}),
			Samples:  []attrSample{smp("cdev", 5, 1000), smp("cdv2", 5, 1000), smp("cout", 5, 1000), smp("coth", 5, 500), smp("cdev", 10, 1000), smp("cout", 10, 1000)},
			Readings: []attrReading{rd(0, 10, R1, five), rd(5, 14, R1, five), rd(10, 17, R1, five)},
			Steps: []allocStep{
				set("ccos", win("cmgr", 3)),
				set("ccos", `{"tree":"coth","account":"max","kind":"window","window":"five_hour","percent":0.5,"note":"a small tree"}`),
				set("ccos", win("cout", 50)),
				set("ccos", `{"tree":"cmgr","account":"max","kind":"window","window":"seven_day","percent":1}`),
				{Op: "checkWindow", Name: "claude", Window: five, Now: 14 * minute},
				{Op: "checkWindow", Name: "claude", Window: five, Now: 15 * minute},
				{Op: "checkWindow", Name: "claude", Window: "seven_day", Now: 15 * minute},
				{Op: "checkWindow", Name: "codex:x", Window: five, Now: 15 * minute},
				{Op: "view", Now: 15 * minute},
			}},
		{Name: "window projection", Agents: allocTree,
			Samples:  []attrSample{smp("cdev", 5, 2000), smp("cdev", 10, 2000), smp("cdev", 20, 2000), smp("cdv2", 30, 2000)},
			Readings: []attrReading{rd(0, 40, nil, five), rd(5, 42, nil, five), rd(30, 48, nil, five)},
			Steps: []allocStep{
				set("ccos", win("cmgr", 9)),
				set("ccos", win("cdev", 7.5)),
				set("ccos", win("cdv2", 2.5)),
				{Op: "checkWindow", Name: "claude", Window: five, Now: 35 * minute},
				{Op: "view", Now: 35 * minute},
			}},
		{Name: "window resets first", Agents: allocTree,
			Samples:  []attrSample{smp("cdev", 5, 2000), smp("cdev", 10, 2000), smp("cdev", 20, 2000), smp("cdev", 30, 2000)},
			Readings: []attrReading{rd(0, 40, nil, five), rd(5, 42, nil, five), rd(30, 48, f64((attrT0+60*minute)/1000), five)},
			Steps: []allocStep{
				set("ccos", win("cdev", 60)),
				{Op: "checkWindow", Name: "claude", Window: five, Now: 35 * minute},
			}},
	}
}

var (
	allocIDs   = regexp.MustCompile(`\b(al|cn)-[0-9a-f]{8}\b`)
	allocSetAt = regexp.MustCompile(`"set_at":"[^"]*"`)
)

// normalizeAllocs puts each id a case's results name in order of first appearance, and set_at aside; a check's mail is
// sorted, since TS and Go send it in no set order.
func normalizeAllocs(results []string) []string {
	names := map[string]string{}
	out := make([]string, len(results))
	for i, r := range results {
		r = allocSetAt.ReplaceAllString(r, `"set_at":"T"`)
		r = allocIDs.ReplaceAllStringFunc(r, func(id string) string {
			if names[id] == "" {
				names[id] = id[:3] + strconv.Itoa(len(names)+1)
			}
			return names[id]
		})
		var check struct {
			Notices []string `json:"notices"`
			Mails   []string `json:"mails"`
		}
		if strings.HasPrefix(r, `{"notices":`) && json.Unmarshal([]byte(r), &check) == nil {
			sort.Strings(check.Mails)
			b, _ := json.MarshalIndent(check, "", " ")
			r = string(b)
		}
		out[i] = r
	}
	return out
}

func strArray(items []string) jsfmt.Value {
	vs := make([]jsfmt.Value, len(items))
	for i, s := range items {
		vs[i] = jsfmt.StringValue(s)
	}
	return jsfmt.ArrayValue(vs)
}

func errJSON(err error) string {
	v := jsfmt.Value{Kind: jsfmt.Object}
	v.Set("error", jsfmt.StringValue(err.Error()))
	return jsfmt.Compact(v)
}

func allocInput(t *testing.T, raw json.RawMessage) AllocationInput {
	t.Helper()
	v, err := jsjson.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	o, _ := v.(*jsjson.Object)
	get := func(k string) jsjson.Value { x, _ := o.Get(k); return x }
	return AllocationInput{ID: get("id"), Tree: get("tree"), Account: get("account"), Kind: get("kind"), Window: get("window"),
		Percent: get("percent"), Amount: get("amount"), Period: get("period"), Note: get("note")}
}

func (l *live) allocUsage(rows []allocUsage) {
	for _, u := range rows {
		l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, paid_estimate_usd) VALUES (?, ?, 'claude', 'test-a', ?, ?, ?)", u.Agent, u.Day, u.Account, u.Cost, u.Paid)
	}
}

// runAllocCase seeds one case on a fresh daemon and runs its steps on the Go allocations.
func runAllocCase(t *testing.T, c allocCase) []string {
	t.Helper()
	l, box := newCostLive(t, allocSettings)
	if err := os.WriteFile(filepath.Join(l.home, "registry.json"), []byte(attrRegistry), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tbl := range []string{"usage", "usage_samples", "window_readings", "agent_parents", "peer_agents"} {
		l.exec("DELETE FROM " + tbl)
	}
	for _, a := range c.Agents {
		var p *string
		if a.Parent != "" {
			p = &a.Parent
		}
		if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: a.ID, Name: "n-" + a.ID, Role: "test", Machine: "test-machine", Harness: "claude", Cwd: l.work, ParentID: p}); err != nil {
			t.Fatal(err)
		}
	}
	for _, e := range c.Adopted {
		l.exec("INSERT INTO agent_parents (child_id, parent_id) VALUES (?, ?)", e[0], e[1])
	}
	for _, p := range c.Peers {
		parents, _ := json.Marshal(p.Parents)
		l.exec("INSERT INTO peer_agents (id, name, machine, updated_at, parents) VALUES (?, ?, 'peer', ?, ?)", p.ID, "n-"+p.ID, isoMs(attrT0), string(parents))
	}
	if len(c.Rows) > 0 {
		l.life.Allocations(l.ctx, "")
	}
	for _, r := range c.Rows {
		l.exec("INSERT INTO allocations (id, root_id, account, kind, window, percent, amount, period, set_by, set_at, note) VALUES (?, ?, 'openrouter', 'usd', '', NULL, ?, 'day', 'human', ?, NULL)", r.ID, r.Root, r.Amount, isoMs(attrT0))
	}
	for _, s := range c.Samples {
		l.exec("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, 'max', 'claude', 'test-a', ?, ?, 0, 0, 0)",
			s.Agent, isoMs(attrT0+s.Minute*minute), s.In)
	}
	for _, r := range c.Readings {
		w := r.Window
		if w == "" {
			w = "five_hour"
		}
		var resets any
		if r.Resets != nil {
			resets = *r.Resets
		}
		l.exec("INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES ('claude', ?, ?, ?, ?)", w, isoMs(attrT0+r.At), r.Used, resets)
	}
	l.allocUsage(c.Usage)
	noticesSeen, mailSeen := 0, 0
	ids := map[int]string{}
	var out []string
	for i, s := range c.Steps {
		now := time.UnixMilli(int64(attrT0 + s.Now))
		var r string
		switch s.Op {
		case "set":
			// As TS's set, the wall clock, a millisecond apart per set.
			for last := time.Now().UnixMilli(); time.Now().UnixMilli() == last; {
			}
			a, warning, err := l.life.SetAllocation(l.ctx, allocInput(t, s.Input), s.By, time.Now())
			if err != nil {
				r = errJSON(err)
				break
			}
			ids[i] = a.ID
			v := jsfmt.Value{Kind: jsfmt.Object}
			v.Set("allocation", AllocationJSON(a))
			v.Set("warning", jsOptText(warning))
			r = jsfmt.Compact(v)
		case "clear":
			in := allocInput(t, s.Input)
			if s.IDFrom != nil {
				in.ID = ids[*s.IDFrom]
			}
			n, err := l.life.ClearAllocation(l.ctx, in, s.By)
			if err != nil {
				r = errJSON(err)
				break
			}
			r = `{"cleared":` + strconv.Itoa(n) + `}`
		case "view":
			views, err := l.life.AllocationViews(l.ctx, s.Tree, now)
			if err != nil {
				t.Fatal(err)
			}
			r = jsfmt.Compact(jsfmt.ArrayValue(views))
		case "usage":
			l.allocUsage(s.Usage)
			r = `"usage"`
		default:
			if s.Op == "checkWindow" {
				l.life.checkWindowAllocations(l.ctx, s.Name, s.Window, now)
			} else {
				l.life.checkUsdAllocations(l.ctx, s.Account, now)
			}
			l.until("the notices' mail", func() bool { return l.life.bgRunning.Load() == 0 })
			var notices []string
			if l.query("SELECT count(*) FROM sqlite_master WHERE name = 'cost_notices'") == "1" {
				for _, line := range strings.Split(l.query("SELECT group_concat(id || '|' || key || '|' || kind || '|' || account || '|' || window || '|' || coalesce(agent_id, 'null') || '|' || managers, char(10)) FROM (SELECT * FROM cost_notices ORDER BY created_at, rowid)"), "\n") {
					if line != "" {
						notices = append(notices, line)
					}
				}
			}
			mails := box.mails()
			v := jsfmt.Value{Kind: jsfmt.Object}
			v.Set("notices", strArray(notices[noticesSeen:]))
			v.Set("mails", strArray(mails[mailSeen:]))
			noticesSeen, mailSeen = len(notices), len(mails)
			r = jsfmt.Compact(v)
		}
		out = append(out, r)
	}
	return out
}

func TestAllocationsMatchesTS(t *testing.T) {
	cases := allocCases()
	for i := range cases {
		for j := range cases[i].Steps {
			if cases[i].Steps[j].Input == nil {
				cases[i].Steps[j].Input = json.RawMessage(`{}`)
			}
		}
	}
	in, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd := exec.Command("node", "--no-warnings", "testdata/allocref.mjs", string(in), allocSettings, attrRegistry)
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("allocref.mjs: %v\n%s", err, stderr.String())
	}
	var want map[string][]string
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("allocref.mjs output %q: %v", raw, err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got, exp := normalizeAllocs(runAllocCase(t, c)), normalizeAllocs(want[c.Name])
			if !reflect.DeepEqual(got, exp) {
				for i := range c.Steps {
					var g, w string
					if i < len(got) {
						g = got[i]
					}
					if i < len(exp) {
						w = exp[i]
					}
					if g != w {
						t.Errorf("step %d (%s):\nGo: %s\nTS: %s", i, c.Steps[i].Op, g, w)
					}
				}
			}
		})
	}
}

// TestUsageAllocations: a window reading checks the window allocations on its account, and a usage report the usd
// allocations on its account, so the reading or report that passes one raises its notice.
func TestUsageAllocations(t *testing.T) {
	l, _, _ := newWindowLive(t, "necessary")
	l.setSettings(strings.Replace(withHumanMail("necessary"), "[80,95]", "[]", 1))
	t0 := time.Date(2026, 10, 11, 10, 0, 0, 0, time.UTC)
	seedProjection(l, t0)
	window := AllocationInput{Tree: "cost", Account: "max", Kind: "window", Window: "five_hour", Percent: 0.5}
	if _, _, err := l.life.SetAllocation(l.ctx, window, humanID, t0); err != nil {
		t.Fatal(err)
	}
	if err := l.life.reportSubscription(l.ctx, "claude", jsjson.NewObject("five_hour", jsjson.NewObject("used_percentage", 98.0)), t0.Add(31*time.Minute)); err != nil {
		t.Fatal(err)
	}
	// The window is projected to reach 100% within 30 minutes too.
	if got := strings.Join(l.notices(), " "); got != `projection|["cos","cost"]| allocation|["cos","cost"]|cost` {
		t.Errorf("after the reading: %s", got)
	}
	l.setSettings(`{"chiefOfStaff":"n-cos","cost":{"accounts":{"openrouter":{"match":{"harness":"claude"}}}}}`)
	spend := AllocationInput{Tree: "cost", Account: "openrouter", Kind: "usd", Period: "day", Amount: 1.0}
	if _, _, err := l.life.SetAllocation(l.ctx, spend, humanID, t0); err != nil {
		t.Fatal(err)
	}
	a, err := l.db.GetAgent(l.ctx, "dev")
	if err != nil {
		t.Fatal(err)
	}
	cost := 1.5
	if err := l.life.reportUsage(l.ctx, a, usageReport{counts: [5]*float64{&cost}}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := l.notices(); len(got) != 3 || got[2] != `allocation|["cos","cost"]|cost` {
		t.Errorf("after the report: %v", got)
	}
}

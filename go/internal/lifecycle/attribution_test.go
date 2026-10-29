package lifecycle

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// The tests of attribution.go. TestAttributionMatchesTS runs every case of test/attribution.test.mjs, and more, on the Go
// estimate and on src/attribution.ts (testdata/attrref.mjs), and compares each interval, share, projection and tree
// share as TS prints them: the fit, the outlier and reset rules, the projection's caps and notes, and the tree walk
// (adopted parents and a peer's children) are TS's to the last digit.

const attrSettings = `{"chiefOfStaff":"at-cos","cost":{"accounts":{"claude":{"match":{"harness":"claude"}}}}}`

// attrRegistry prices the test models in the user's registry.json, as test/attribution.test.mjs does, plus a context
// variant whose entry has no input: it has no price, and hides the base model's.
const attrRegistry = `{"prices":{"test-a":{"input":1,"output":1,"cacheRead":1,"cacheWrite":1},"test-b":{"input":2,"output":4,"cacheRead":null,"cacheWrite":3},` +
	`"claude-opus-5-5":{"input":4,"output":20,"cacheRead":0.2,"cacheWrite":5},"test-c":{"input":3},"test-c[1m]":{"output":2}}}`

type attrAgent struct {
	ID     string `json:"id"`
	Parent string `json:"parent,omitempty"`
}

type attrPeer struct {
	ID      string   `json:"id"`
	Parents []string `json:"parents"`
}

type attrSample struct {
	Agent  string  `json:"agent"`
	Minute float64 `json:"minute"`
	Model  string  `json:"model,omitempty"`
	In     float64 `json:"in,omitempty"`
	Out    float64 `json:"out,omitempty"`
	CR     float64 `json:"cr,omitempty"`
	CW     float64 `json:"cw,omitempty"`
}

type attrReading struct {
	At     float64  `json:"at"` // milliseconds after T0
	Used   float64  `json:"used"`
	Resets *float64 `json:"resets,omitempty"`
	Window string   `json:"window,omitempty"`
}

type attrQuery struct {
	Kind   string   `json:"kind"` // calibrate or shares
	Window string   `json:"window"`
	From   float64  `json:"from,omitempty"`  // calibrate: ms after T0
	Since  *float64 `json:"since,omitempty"` // shares: ms after T0, nil for the window's period
	Now    float64  `json:"now"`
	Tree   string   `json:"tree,omitempty"`
}

type attrCase struct {
	Name     string        `json:"name"`
	Agents   []attrAgent   `json:"agents,omitempty"`
	Adopted  [][2]string   `json:"adopted,omitempty"`
	Peers    []attrPeer    `json:"peers,omitempty"`
	Samples  []attrSample  `json:"samples,omitempty"`
	Readings []attrReading `json:"readings,omitempty"`
	Queries  []attrQuery   `json:"queries"`
}

// attrResult is one query's result in attrref.mjs's format.
type attrResult struct {
	Intervals  []string `json:"intervals,omitempty"`
	Scale      string   `json:"scale,omitempty"`
	Current    string   `json:"current,omitempty"`
	Shares     string   `json:"shares,omitempty"`
	Projection string   `json:"projection,omitempty"`
	Members    []string `json:"members,omitempty"`
	Tree       string   `json:"tree,omitempty"`
}

var attrT0 = float64(time.Date(2026, 10, 11, 10, 0, 0, 0, time.UTC).UnixMilli())

const minute = 60_000.0

func f64(v float64) *float64 { return &v }

var (
	reset1 = (attrT0 + 300*minute) / 1000
	reset2 = reset1 + 5*3600
)

// rd is test/attribution.test.mjs reading: thirty seconds into the minute.
func rd(m, used float64, resets *float64, window string) attrReading {
	return attrReading{At: m*minute + 30_000, Used: used, Resets: resets, Window: window}
}

func smp(agent string, m, tokens float64) attrSample {
	return attrSample{Agent: agent, Minute: m, In: tokens}
}

func cal(window string, from, now float64) attrQuery {
	return attrQuery{Kind: "calibrate", Window: window, From: from * minute, Now: now * minute}
}

func shr(window string, since *float64, now float64, tree string) attrQuery {
	var s *float64
	if since != nil {
		s = f64(*since * minute)
	}
	return attrQuery{Kind: "shares", Window: window, Since: s, Now: now * minute, Tree: tree}
}

var zero = f64(0)

func attrCases() []attrCase {
	R1, R2 := f64(reset1), f64(reset2)
	five, seven := "five_hour", "seven_day"
	pastReset := reset1*1000 + 5*minute - attrT0
	return []attrCase{
		{Name: "calibration", Agents: []attrAgent{{ID: "at-a"}, {ID: "at-b"}},
			Samples:  []attrSample{smp("at-a", 5, 1000), smp("at-b", 5, 500), smp("at-a", 10, 500), smp("at-a", 15, 2000)},
			Readings: []attrReading{rd(0, 10, R1, five), rd(10, 12, R1, five), rd(20, 14.2, R1, five)},
			Queries:  []attrQuery{cal(five, -1, 30), shr(five, zero, 30, "")}},
		{Name: "other and a miss", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 5, 2000), smp("at-a", 15, 2000)},
			Readings: []attrReading{rd(0, 10, R1, five), rd(5, 12, R1, five), rd(10, 13, R1, five), rd(15, 17, R1, five)},
			Queries:  []attrQuery{cal(five, -1, 20), shr(five, zero, 20, "")}},
		{Name: "window reset", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 285, 1000), smp("at-a", 295, 5000), smp("at-a", 300, 3000)},
			Readings: []attrReading{rd(280, 90, R1, five), rd(285, 91, R1, five), rd(300, 6, R2, five)},
			Queries:  []attrQuery{cal(five, 0, 310), shr(five, nil, 310, "")}},
		{Name: "tree DAG", Agents: []attrAgent{{ID: "at-root"}, {ID: "at-x", Parent: "at-root"}, {ID: "at-y", Parent: "at-root"}, {ID: "at-z", Parent: "at-x"}, {ID: "at-out"}},
			Adopted:  [][2]string{{"at-z", "at-y"}},
			Samples:  []attrSample{smp("at-x", 5, 1000), smp("at-y", 5, 1000), smp("at-z", 5, 1000), smp("at-out", 5, 1000)},
			Readings: []attrReading{rd(0, 10, R1, five), rd(5, 14, R1, five)},
			Queries:  []attrQuery{shr(five, zero, 10, "at-root"), shr(five, zero, 10, "at-x"), shr(five, zero, 10, "at-y"), shr(five, zero, 10, "at-out")}},
		{Name: "a peer's children", Agents: []attrAgent{{ID: "at-root"}, {ID: "at-local", Parent: "at-peer"}, {ID: "at-dev", Parent: "at-root"}, {ID: "at-far", Parent: "at-peer2"}},
			Peers:    []attrPeer{{ID: "at-peer", Parents: []string{"at-root", "at-else"}}, {ID: "at-peer2", Parents: []string{"at-else"}}},
			Samples:  []attrSample{smp("at-local", 5, 1000), smp("at-dev", 5, 3000), smp("at-far", 5, 500)},
			Readings: []attrReading{rd(0, 10, R1, five), rd(5, 14, R1, five)},
			Queries:  []attrQuery{shr(five, zero, 10, "at-root"), shr(five, zero, 10, "at-peer")}},
		{Name: "projection", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 5, 2000), smp("at-a", 10, 2000), smp("at-a", 20, 2000), smp("at-a", 30, 2000)},
			Readings: []attrReading{rd(0, 40, nil, five), rd(5, 42, nil, five), rd(30, 48, nil, five)},
			Queries:  []attrQuery{shr(five, zero, 35, ""), shr(five, nil, 35, "")}},
		{Name: "projection resets first", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 5, 2000), smp("at-a", 10, 2000), smp("at-a", 20, 2000), smp("at-a", 30, 2000)},
			Readings: []attrReading{rd(0, 40, nil, five), rd(5, 42, nil, five), rd(30, 48, f64((attrT0+60*minute)/1000), five)},
			Queries:  []attrQuery{shr(five, zero, 35, "")}},
		{Name: "no readings", Agents: []attrAgent{{ID: "at-a"}}, Samples: []attrSample{smp("at-a", 5, 2000)},
			Queries: []attrQuery{shr(five, zero, 35, ""), cal(five, 0, 35)}},
		{Name: "one reading", Agents: []attrAgent{{ID: "at-a"}}, Samples: []attrSample{smp("at-a", 5, 2000)},
			Readings: []attrReading{rd(5, 42, R1, five)},
			Queries:  []attrQuery{shr(five, zero, 35, ""), shr(five, nil, 35, "")}},
		{Name: "flat readings", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 5, 1000), smp("at-a", 10, 2000), smp("at-a", 20, 2000), smp("at-a", 30, 2000)},
			Readings: []attrReading{rd(0, 40, nil, five), rd(5, 41, nil, five), rd(30, 41, nil, five)},
			Queries:  []attrQuery{shr(five, zero, 35, "")}},
		{Name: "capped at the readings", Agents: []attrAgent{{ID: "at-b"}},
			Samples:  []attrSample{smp("at-b", 5, 1000), smp("at-b", 10, 2000), smp("at-b", 20, 2000), smp("at-b", 30, 2000)},
			Readings: []attrReading{rd(0, 40, nil, five), rd(5, 50, nil, five), rd(30, 52, nil, five)},
			Queries:  []attrQuery{shr(five, zero, 35, "")}},
		{Name: "no stam use lately", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 5, 1000)},
			Readings: []attrReading{rd(0, 40, nil, five), rd(5, 50, nil, five), rd(30, 52, nil, five)},
			Queries:  []attrQuery{shr(five, zero, 70, "")}},
		{Name: "already at 100", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 5, 1000), smp("at-a", 20, 1000)},
			Readings: []attrReading{rd(0, 90, R1, five), rd(5, 95, R1, five), rd(20, 100, R1, five)},
			Queries:  []attrQuery{shr(five, zero, 25, "")}},
		{Name: "reset inside the 30 minutes", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 2, 1000), smp("at-a", 7, 1000), smp("at-a", 10, 2000), smp("at-a", 20, 2000), smp("at-a", 30, 2000)},
			Readings: []attrReading{rd(0, 52, R1, seven), rd(8, 2, R2, seven), rd(30, 51, R2, seven)},
			Queries:  []attrQuery{shr(seven, zero, 35, "")}},
		{Name: "bogus low", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 2, 1000), smp("at-a", 12, 1000)},
			Readings: []attrReading{rd(0, 52, R1, seven), rd(8, 2, R1, seven), rd(30, 51, R1, seven)},
			Queries:  []attrQuery{cal(seven, 0, 35), shr(seven, zero, 35, "")}},
		{Name: "drop past the reset time", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 2, 1000)},
			Readings: []attrReading{rd(0, 52, R1, seven), {At: pastReset, Used: 3, Resets: R1, Window: seven}},
			Queries:  []attrQuery{{Kind: "calibrate", Window: seven, Now: pastReset + 10*minute}}},
		{Name: "bogus high", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 2, 1000), smp("at-a", 12, 1000), smp("at-a", 17, 1000)},
			Readings: []attrReading{rd(0, 40, R1, seven), rd(8, 95, R1, seven), rd(15, 41, R1, seven), rd(25, 43, R1, seven)},
			Queries:  []attrQuery{cal(seven, 0, 35), shr(seven, zero, 35, ""), cal(seven, 5, 35)}},
		{Name: "a lasting small drop", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 2, 1000), smp("at-a", 12, 1000)},
			Readings: []attrReading{rd(0, 52, R1, seven), rd(8, 51, R1, seven), rd(15, 51, R1, seven), rd(20, 53, R1, seven)},
			Queries:  []attrQuery{cal(seven, 0, 35), shr(seven, zero, 35, "")}},
		{Name: "a fall with no reset time", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 2, 1000)},
			Readings: []attrReading{rd(0, 52, nil, seven), rd(8, 3, nil, seven)},
			Queries:  []attrQuery{cal(seven, 0, 35)}},
		{Name: "a bogus high across ranges", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", 25, 1000), smp("at-a", 8*60+30, 1000), smp("at-a", 8*60+40, 1000)},
			Readings: []attrReading{rd(0, 40, R1, seven), rd(10, 95, R1, seven), rd(20, 41, R1, seven), rd(8*60+25, 42, R1, seven), rd(8*60+45, 43, R1, seven)},
			Queries:  []attrQuery{cal(seven, 0, 8*60+50), shr(seven, zero, 8*60+50, "")}},
		{Name: "readings in one bucket", Agents: []attrAgent{{ID: "at-a"}},
			Samples: []attrSample{smp("at-a", 5, 1000), smp("at-a", 10, 1000)},
			Readings: []attrReading{rd(0, 10, R1, five), {At: 6 * minute, Used: 11, Resets: R1}, {At: 7 * minute, Used: 12, Resets: R1},
				{At: 9*minute + 59_000, Used: 12.5, Resets: R1}, rd(12, 14, R1, five)},
			Queries: []attrQuery{cal(five, 0, 20), shr(five, zero, 20, "")}},
		{Name: "prices", Agents: []attrAgent{{ID: "at-p"}, {ID: "at-q"}, {ID: "at-r"}, {ID: "at-s"}},
			Samples: []attrSample{
				{Agent: "at-p", Minute: 5, Model: "claude-opus-5-5", In: 10, Out: 1, CR: 100, CW: 2},
				{Agent: "at-q", Minute: 5, Model: "claude-opus-5-5[1m]", In: 10, Out: 1, CR: 100, CW: 2},
				{Agent: "at-r", Minute: 5, Model: "test-b", In: 10, Out: 1, CR: 100, CW: 2},
				{Agent: "at-s", Minute: 5, Model: "no-such-model", In: 10, Out: 1, CR: 100, CW: 2},
				{Agent: "at-s", Minute: 10, Model: "test-c[1m]", In: 10, Out: 1, CR: 100, CW: 2},
				{Agent: "at-p", Minute: 10, Model: "test-c", In: 7, Out: 3},
			},
			Readings: []attrReading{rd(0, 10, R1, five), rd(5, 13, R1, five), rd(10, 13.7, R1, five)},
			Queries:  []attrQuery{cal(five, 0, 15)}},
		{Name: "window start", Agents: []attrAgent{{ID: "at-a"}},
			Samples:  []attrSample{smp("at-a", -300, 1000), smp("at-a", 5, 1000)},
			Readings: []attrReading{rd(-305, 1, nil, five), rd(-300, 3, nil, five), rd(0, 10, nil, five), rd(5, 12, nil, five)},
			Queries:  []attrQuery{shr(five, nil, 10, ""), shr(seven, nil, 10, ""), shr("other_window", nil, 10, "")}},
	}
}

// attrNum is String(n) for an estimate's number, null for none.
func attrNum(v *float64) string {
	if v == nil {
		return "null"
	}
	return jsjson.Number(*v)
}

// attrMap is a share map as sorted key=value pairs, each with prefix.
func attrMap(prefix string, m map[string]float64) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+jsjson.Number(v))
	}
	sort.Strings(out)
	for i := range out {
		out[i] = prefix + out[i]
	}
	return out
}

func orNull(s *string) string {
	if s == nil {
		return "null"
	}
	return *s
}

// runAttrCase seeds one case on a fresh daemon and runs its queries on the Go estimate.
func runAttrCase(t *testing.T, c attrCase) []attrResult {
	t.Helper()
	l, _ := newCostLive(t, attrSettings)
	if err := os.WriteFile(filepath.Join(l.home, "registry.json"), []byte(attrRegistry), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tbl := range []string{"usage_samples", "window_readings", "agent_parents", "peer_agents"} {
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
	for _, s := range c.Samples {
		model := s.Model
		if model == "" {
			model = "test-a"
		}
		l.exec("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, 'claude', 'claude', ?, ?, ?, ?, ?, ?)",
			s.Agent, model, isoMs(attrT0+s.Minute*minute), s.In, s.Out, s.CR, s.CW)
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
	var out []attrResult
	for _, q := range c.Queries {
		now := attrT0 + q.Now
		if q.Kind == "calibrate" {
			cal, err := l.life.calibrate(l.ctx, "claude", q.Window, attrT0+q.From, now)
			if err != nil {
				t.Fatal(err)
			}
			r := attrResult{Scale: attrNum(cal.scale), Intervals: []string{}}
			for _, iv := range cal.intervals {
				fields := []string{iv.from, iv.to, jsjson.Number(iv.change), jsjson.Number(iv.weighted), attrNum(iv.scaleBefore), attrNum(iv.scale), iv.reset,
					jsjson.Number(iv.explained), jsjson.Number(iv.other)}
				fields = append(append(fields, attrMap("a:", iv.agents)...), attrMap("m:", iv.models)...)
				r.Intervals = append(r.Intervals, strings.Join(fields, " "))
			}
			if cal.current != nil {
				r.Current = isoMs(cal.current.at) + " " + jsjson.Number(cal.current.used) + " " + attrNum(cal.current.resetsAt)
			}
			out = append(out, r)
			continue
		}
		var since *float64
		if q.Since != nil {
			since = f64(attrT0 + *q.Since)
		}
		s, err := l.life.windowSharesOf(l.ctx, "claude", q.Window, since, now)
		if err != nil {
			t.Fatal(err)
		}
		fields := []string{s.since, jsjson.Number(s.change), jsjson.Number(s.other), attrNum(s.scale), strconv.Itoa(s.intervals)}
		fields = append(append(fields, attrMap("a:", s.agents)...), attrMap("m:", s.models)...)
		p := s.projection
		r := attrResult{Shares: strings.Join(fields, " "),
			Projection: strings.Join([]string{attrNum(p.usedPercentage), attrNum(p.percentPerHour), orNull(p.reaches100At), orNull(p.resetsAt), p.note}, " | ")}
		if q.Tree != "" {
			members, err := l.life.treeMembers(l.ctx, q.Tree)
			if err != nil {
				t.Fatal(err)
			}
			share, err := l.life.treeShare(l.ctx, q.Tree, s)
			if err != nil {
				t.Fatal(err)
			}
			r.Members, r.Tree = members, jsjson.Number(share)
		}
		out = append(out, r)
	}
	return out
}

func TestAttributionMatchesTS(t *testing.T) {
	cases := attrCases()
	in, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd := exec.Command("node", "--no-warnings", "testdata/attrref.mjs", string(in), attrSettings, attrRegistry)
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("attrref.mjs: %v\n%s", err, stderr.String())
	}
	var want map[string][]attrResult
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("attrref.mjs output %q: %v", raw, err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got := runAttrCase(t, c)
			if !reflect.DeepEqual(got, want[c.Name]) {
				g, _ := json.MarshalIndent(got, "", " ")
				w, _ := json.MarshalIndent(want[c.Name], "", " ")
				t.Errorf("Go:\n%s\nTS:\n%s", g, w)
			}
		})
	}
}

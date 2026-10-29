package lifecycle

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// SpendSeries (GET /api/usage/series) over the same rows as src/usage-drill.ts spendSeries (testdata/usageref.mjs on a
// copy of the database, its clock fixed at summaryNow), compared as JSON text: every group by day and by hour, with
// more than five groups folding into Other, a tree DAG, the previous period, and an agent's token's scoping (hidden
// agents and unreadable ITSAs as Other).
func TestSpendSeriesMatchesTS(t *testing.T) {
	l := issueFixture(t)
	// A peer root above the codex agent: its remembered name stands in, and the tree groups under it.
	l.exec("INSERT INTO peer_agents (id, name, machine, parents, updated_at) VALUES ('ptop', 'peer-top', 'far', NULL, ?), ('sx', 's-codex', 'far', '[\"ptop\"]', ?)", isoMs(summaryNow), isoMs(summaryNow))
	// Spend in the previous period, by agents outside the current legend too.
	l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in) VALUES ('old1', ?, 'claude', 'm-old', 'max', 4, 10), ('sd1', ?, 'claude', 'claude-opus-5-5', 'max', 0.5, 5)", utcDay(summaryNow-10*dayMs), utcDay(summaryNow-9*dayMs))
	l.exec("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in) VALUES ('old2', 'max', 'claude', '', ?, 0.75, 7)", isoMs(floorBucket(summaryNow-30*60*60_000)))
	type c struct {
		days           float64
		group          string
		visible, itsas []string
	}
	scopedVisible, scopedItsas := []string{"sr", "sd1", "sd2"}, []string{"S-i1"}
	var cases []c
	for _, g := range SeriesGroups {
		for _, d := range []float64{1, 7, 14} {
			cases = append(cases, c{d, g, nil, nil})
		}
		cases = append(cases, c{7, g, scopedVisible, scopedItsas}, c{1, g, scopedVisible, scopedItsas})
	}
	js := func(xs []string) string {
		if xs == nil {
			return "null"
		}
		b, _ := json.Marshal(xs)
		return string(b)
	}
	for _, x := range cases {
		o := SeriesOptions{Days: x.days, Group: x.group, Now: summaryNow}
		if x.visible != nil {
			o.Visible = setOf(x.visible)
			allowed := setOf(x.itsas)
			o.MayItsa = func(k string) bool { return allowed[k] }
		}
		got, err := l.life.SpendSeries(l.ctx, o)
		if err != nil {
			t.Fatal(err)
		}
		g := jsjson.Stringify(got, "")
		w := usageRef(t, l, summarySettings, summaryRegistry, summaryNow, "series", "", strconv.FormatFloat(x.days, 'f', -1, 64), x.group, js(x.visible), js(x.itsas))
		if g != w {
			t.Errorf("days %v group %s visible %v: series differ\n go: %s\n ts: %s", x.days, x.group, x.visible, g, w)
		}
	}
	// What the comparison stands on: an agent series with Other, a tree under the peer root, an ITSA series, and an
	// agent's token's agent and ITSA series with what it may not see as Other.
	scoped := func(days float64, group string) SeriesOptions {
		allowed := setOf(scopedItsas)
		return SeriesOptions{Days: days, Group: group, Visible: setOf(scopedVisible), MayItsa: func(k string) bool { return allowed[k] }}
	}
	for _, want := range []struct {
		o    SeriesOptions
		text string
	}{
		{SeriesOptions{Days: 14, Group: "agent"}, `{"id":"other","name":"Other"}]`},
		{SeriesOptions{Days: 14, Group: "tree"}, `{"id":"ptop","name":"peer-top"}`},
		{SeriesOptions{Days: 1, Group: "itsa"}, `{"id":"S-i3","name":"S-i3"}`},
		{scoped(7, "agent"), `{"id":"other","name":"Other"}`},
		{scoped(1, "itsa"), `{"id":"other","name":"Other"}`},
	} {
		want.o.Now = summaryNow
		got, err := l.life.SpendSeries(l.ctx, want.o)
		if err != nil {
			t.Fatal(err)
		}
		if g := jsjson.Stringify(got, ""); !strings.Contains(g, want.text) {
			t.Errorf("%s series lacks %s: %s", want.o.Group, want.text, g)
		}
	}
}

// DrillScope (GET /api/usage/scope) over the same rows as src/usage-drill.ts drillScope, compared as JSON text: a tree,
// an agent, a model (bare, `harness · model`, and with a harness), a harness, and ITSAs (a project over two issues, a
// leaf, its own span by hour and by day), each by day and by hour, and scoped to an agent's token.
func TestDrillScopeMatchesTS(t *testing.T) {
	l := issueFixture(t)
	resets := strconv.FormatFloat(summaryNow/1000+3*86_400, 'f', -1, 64)
	l.exec("UPDATE subscriptions SET data = ? WHERE name = 'claude'", `{"five_hour":{"used_percentage":31,"resets_at":`+strconv.FormatFloat(summaryNow/1000+3600, 'f', -1, 64)+`},"seven_day":{"used_percentage":46,"resets_at":`+resets+`}}`)
	since := summaryNow - 5*60*60_000
	type c struct {
		Days    float64  `json:"days"`
		Kind    string   `json:"kind"`
		Ref     string   `json:"ref"`
		Harness string   `json:"harness,omitempty"`
		Since   *float64 `json:"since,omitempty"`
		Bucket  string   `json:"bucket,omitempty"`
		Visible []string `json:"visible,omitempty"`
		Itsas   []string `json:"itsas,omitempty"`
	}
	var cases []c
	for _, d := range []float64{1, 14} {
		cases = append(cases,
			c{Days: d, Kind: "tree", Ref: "sr"}, c{Days: d, Kind: "tree", Ref: "so"}, c{Days: d, Kind: "agent", Ref: "sd1"},
			c{Days: d, Kind: "model", Ref: "claude-opus-5-5"}, c{Days: d, Kind: "model", Ref: "claude · claude-haiku-5-5"},
			c{Days: d, Kind: "model", Ref: "claude-opus-5-5", Harness: "claude"}, c{Days: d, Kind: "harness", Ref: "claude"},
			c{Days: d, Kind: "itsa", Ref: "S-i5"}, c{Days: d, Kind: "itsa", Ref: "S-i3"},
			c{Days: d, Kind: "tree", Ref: "sr", Visible: []string{"sr", "sd1"}}, c{Days: d, Kind: "itsa", Ref: "S-i5", Visible: []string{"sd1"}, Itsas: []string{"S-i2"}})
	}
	cases = append(cases, c{Days: 14, Kind: "itsa", Ref: "S-i5", Since: &since, Bucket: "hour"}, c{Days: 14, Kind: "itsa", Ref: "S-i5", Since: &since, Bucket: "day"})
	for _, x := range cases {
		o := ScopeOptions{Days: x.Days, Kind: x.Kind, Ref: x.Ref, Harness: x.Harness, Since: x.Since, Bucket: x.Bucket, Now: summaryNow}
		if x.Visible != nil {
			o.Visible = setOf(x.Visible)
			allowed := setOf(x.Itsas)
			o.MayItsa = func(k string) bool { return allowed[k] }
		}
		got, err := l.life.DrillScope(l.ctx, o)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(x)
		w := usageRef(t, l, summarySettings, summaryRegistry, summaryNow, "scope", "", string(b))
		if x.Kind == "itsa" {
			got, w = withoutAliasedOwnModes(t, got, w)
		}
		if g := jsjson.Stringify(got, ""); g != w {
			t.Errorf("%s: scope differs\n go: %s\n ts: %s", b, g, w)
		}
	}
	// What the comparison stands on: sd2 is in sr's tree but hidden from the scoped token, and S-i5's child S-i1 is an
	// ITSA the scoped token doesn't belong to.
	scoped := func(o ScopeOptions) ScopeOptions {
		allowed := setOf([]string{"S-i2"})
		o.Visible, o.MayItsa = setOf([]string{"sr", "sd1"}), func(k string) bool { return allowed[k] }
		return o
	}
	for _, want := range []struct {
		o        ScopeOptions
		has, not []string
	}{
		{ScopeOptions{Days: 14, Kind: "tree", Ref: "sr"}, []string{`"id":"sd1"`, `"id":"sd2"`}, nil},
		{scoped(ScopeOptions{Days: 14, Kind: "tree", Ref: "sr"}), []string{`"id":"sd1"`}, []string{`"sd2"`}},
		{ScopeOptions{Days: 14, Kind: "itsa", Ref: "S-i5"}, []string{`"key":"S-i1"`, `"key":"S-i2"`}, nil},
		{scoped(ScopeOptions{Days: 14, Kind: "itsa", Ref: "S-i5"}), []string{`"key":"S-i2"`}, []string{`"key":"S-i1"`}},
	} {
		want.o.Now = summaryNow
		got, err := l.life.DrillScope(l.ctx, want.o)
		if err != nil {
			t.Fatal(err)
		}
		g := jsjson.Stringify(got, "")
		for _, s := range want.has {
			if !strings.Contains(g, s) {
				t.Errorf("%s %s scoped %v lacks %s: %s", want.o.Kind, want.o.Ref, want.o.Visible != nil, s, g)
			}
		}
		for _, s := range want.not {
			if strings.Contains(g, s) {
				t.Errorf("%s %s scoped %v has %s: %s", want.o.Kind, want.o.Ref, want.o.Visible != nil, s, g)
			}
		}
	}
	// An ITSA that is gone by the time the scope reads it.
	if _, err := l.life.DrillScope(l.ctx, ScopeOptions{Days: 14, Kind: "itsa", Ref: "S-gone", Now: summaryNow}); !errors.As(err, new(ErrNoItsa)) {
		t.Errorf("a gone ITSA: %v", err)
	}
}

// withoutAliasedOwnModes drops totals.own.modes from both sides of an ITSA scope whose children have spend: TS's
// itsaScope copies own with {...a}, which shares its modes object, so adding the children's cost changes own's modes
// too (S-3878). Go keeps own's modes as own's cost alone, and the test checks that instead.
func withoutAliasedOwnModes(t *testing.T, got *jsjson.Object, ts string) (*jsjson.Object, string) {
	t.Helper()
	totals := func(o *jsjson.Object) *jsjson.Object { v, _ := o.Get("totals"); return v.(*jsjson.Object) }
	part := func(o *jsjson.Object, k string) *jsjson.Object { v, _ := totals(o).Get(k); return v.(*jsjson.Object) }
	if cost, _ := part(got, "children").Get("cost_usd"); jsjson.ToNumber(cost) == 0 {
		return got, ts
	}
	own := part(got, "own")
	cost, _ := own.Get("cost_usd")
	modes, _ := own.Get("modes")
	if api, _ := modes.(*jsjson.Object).Get("api"); jsjson.ToNumber(api) != jsjson.ToNumber(cost) {
		t.Errorf("own.modes.api %v, want own's cost %v", api, cost)
	}
	v, err := jsjson.Parse([]byte(ts))
	if err != nil {
		t.Fatal(err)
	}
	g := jsjson.Clone(got).(*jsjson.Object)
	part(g, "own").Delete("modes")
	part(v.(*jsjson.Object), "own").Delete("modes")
	return g, jsjson.Stringify(v, "")
}

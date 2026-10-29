package lifecycle

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"sort"
	"strings"
	"testing"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// The cost display (costdisplay.go) on the cases of testdata/displayref.mjs, against src/cost-display.ts: the account
// kinds, convert with and without the window shares, the rounding, raw sums and their modes, the modes' sum, and tree
// sums over shared descendants. Each result is compared as JSON text.

const displaySettings = `{"cost":{"accounts":{"max":{"match":{"harness":"claude"}},"paidmax":{"match":{"harness":"claude","model":"claude-opus"},"paid":true},` +
	`"or":{"match":{"harness":"opencode","model":"openrouter/"}},"orfree":{"match":{"harness":"opencode","model":"x/"},"provider":"x","paid":false},` +
	`"zed":{"match":{"harness":"opencode","model":"zed/"},"provider":"zed"},"codex":{"match":{"harness":"codex"}}}}}`

type displayCtx struct {
	Kinds  map[string]string             `json:"kinds"`
	Worths map[string]map[string]float64 `json:"worths"`
	Prices map[string]float64            `json:"prices"`
}

func (c displayCtx) Kind(a string) string {
	if k, ok := c.Kinds[a]; ok {
		return k
	}
	return "none"
}

func (c displayCtx) Worth(a, w string) *float64 {
	if v, ok := c.Worths[a][w]; ok {
		return &v
	}
	return nil
}

func (c displayCtx) Price(a string) *float64 {
	if v, ok := c.Prices[a]; ok {
		return &v
	}
	return nil
}

type rawPart map[string]struct {
	API           float64  `json:"api"`
	Kind          string   `json:"kind"`
	WorthSevenDay *float64 `json:"worth_seven_day"`
	FiveHour      *float64 `json:"five_hour"`
	SevenDay      *float64 `json:"seven_day"`
}

type displayCase struct {
	Kinds   []string           `json:"kinds,omitempty"`
	Convert [][2]any           `json:"convert,omitempty"`
	Ctx     *displayCtx        `json:"ctx,omitempty"`
	WP      map[string]any     `json:"windowPercent,omitempty"`
	Round   bool               `json:"round,omitempty"`
	Raw     []rawPart          `json:"raw,omitempty"`
	Prices  map[string]float64 `json:"prices,omitempty"`
	Tree    *struct {
		IDs      []string            `json:"ids"`
		Children map[string][]string `json:"children"`
		Own      map[string]struct {
			N float64 `json:"n"`
		} `json:"own"`
	} `json:"tree,omitempty"`
	Add []map[string]any `json:"add,omitempty"`
}

func TestCostDisplayMatchesTS(t *testing.T) {
	ctx := &displayCtx{
		Kinds:  map[string]string{"max": "subscription", "codex": "subscription", "or": "paid", "": "none"},
		Worths: map[string]map[string]float64{"max": {"five_hour": 40, "seven_day": 700}, "codex": {"five_hour": 0}},
		Prices: map[string]float64{"max": 200},
	}
	f := func(v float64) *float64 { return &v }
	cases := []displayCase{
		{Kinds: []string{"max", "paidmax", "or", "orfree", "zed", "codex", "openrouter", "openrouter-system", "", "nobody"}},
		{Convert: [][2]any{{"max", 3.3}, {"or", 1.25}, {"", 0.5}}, Ctx: ctx},
		{Convert: [][2]any{{"max", 3.3}, {"codex", 1}}, Ctx: ctx},
		{Convert: [][2]any{{"max", 1.0 / 3}, {"or", 0.1}}, Ctx: ctx, Round: true},
		{Convert: [][2]any{{"max", 2}}, Ctx: ctx, WP: map[string]any{"five_hour": 12.5, "seven_day": nil}},
		{Convert: [][2]any{{"or", 2}}, Ctx: ctx, WP: map[string]any{"five_hour": 12.5, "seven_day": 3}},
		{Convert: [][2]any{}, Ctx: ctx},
		{Raw: []rawPart{
			{"max": {API: 2, Kind: "subscription", WorthSevenDay: nil, FiveHour: f(1), SevenDay: f(0.5)}},
			{"max": {API: 1, Kind: "subscription", WorthSevenDay: f(700), FiveHour: f(2), SevenDay: f(0.25)}, "or": {API: 0.4, Kind: "paid"}},
		}, Prices: map[string]float64{"max": 200}},
		{Raw: []rawPart{{"codex": {API: 1, Kind: "subscription", WorthSevenDay: f(10), FiveHour: nil, SevenDay: f(1)}}}, Prices: map[string]float64{}},
		{Add: []map[string]any{{"api": 1, "five_hour": 2, "seven_day": nil, "subscription": 3, "paid_usd": 0.5}, {"api": 0.25, "five_hour": 1, "seven_day": 4, "subscription": 1, "paid_usd": 0}}},
	}
	tree := &struct {
		IDs      []string            `json:"ids"`
		Children map[string][]string `json:"children"`
		Own      map[string]struct {
			N float64 `json:"n"`
		} `json:"own"`
	}{IDs: []string{"r", "a", "b", "c", "d", "lone"}, Children: map[string][]string{"r": {"a", "b"}, "a": {"c", "c"}, "b": {"c", "d"}, "c": {"r"}}}
	tree.Own = map[string]struct {
		N float64 `json:"n"`
	}{"r": {1}, "a": {2}, "b": {4}, "c": {8}, "d": {16}, "lone": {32}}
	cases = append(cases, displayCase{Tree: tree})

	in, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd := exec.Command("node", "--no-warnings", "testdata/displayref.mjs", displaySettings, string(in))
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("displayref.mjs: %v\n%s", err, stderr.String())
	}
	want := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(want) != len(cases) {
		t.Fatalf("displayref.mjs gave %d results for %d cases", len(want), len(cases))
	}
	set, err := config.ParseSettings([]byte(displaySettings), "test-machine")
	if err != nil {
		t.Fatal(err)
	}
	optPtr := func(v any) *float64 {
		if n, ok := v.(float64); ok {
			return &n
		}
		if n, ok := v.(int); ok {
			x := float64(n)
			return &x
		}
		return nil
	}
	num := func(v any) float64 {
		if p := optPtr(v); p != nil {
			return *p
		}
		return 0
	}
	for i, c := range cases {
		var got jsjson.Value
		switch {
		case c.Kinds != nil:
			kind := KindResolver(set)
			var out []jsjson.Value
			for _, a := range c.Kinds {
				out = append(out, kind(a))
			}
			got = out
		case c.Convert != nil:
			var by []AccountCost
			for _, p := range c.Convert {
				by = append(by, AccountCost{Account: p[0].(string), API: num(p[1])})
			}
			var wp *WindowPercent
			if c.WP != nil {
				wp = &WindowPercent{FiveHour: optPtr(c.WP["five_hour"]), SevenDay: optPtr(c.WP["seven_day"])}
			}
			m := Convert(by, *c.Ctx, wp)
			if c.Round {
				m = RoundModes(m)
			}
			got = m.JSON()
		case c.Raw != nil:
			total := NewRaw()
			for _, part := range c.Raw {
				// The parts' accounts in the literal's order, as the TS object has them.
				names := make([]string, 0, len(part))
				for a := range part {
					names = append(names, a)
				}
				sort.Slice(names, func(i, j int) bool { return names[i] == "max" || (names[j] != "max" && names[i] < names[j]) })
				p := NewRaw()
				for _, a := range names {
					x := part[a]
					p.Order, p.By[a] = append(p.Order, a), &RawAcct{API: x.API, Kind: x.Kind, WorthSevenDay: x.WorthSevenDay, FiveHour: x.FiveHour, SevenDay: x.SevenDay}
				}
				AddRaw(total, p)
			}
			got = jsjson.NewObject("raw", total.JSON(), "modes", RawToModes(total, c.Prices).JSON())
		case c.Tree != nil:
			own := map[string]float64{}
			for k, v := range c.Tree.Own {
				own[k] = v.N
			}
			sums := TreeSums(c.Tree.IDs, c.Tree.Children, own, func() float64 { return 0 }, func(into *float64, from float64) { *into += from })
			o := jsjson.NewObject()
			for _, id := range c.Tree.IDs {
				o.Set(id, sums[id])
			}
			got = o
		case c.Add != nil:
			total := ZeroModes()
			for _, m := range c.Add {
				AddModes(&total, Modes{API: num(m["api"]), FiveHour: optPtr(m["five_hour"]), SevenDay: optPtr(m["seven_day"]), Subscription: optPtr(m["subscription"]), PaidUSD: num(m["paid_usd"])})
			}
			got = total.JSON()
		}
		if g := jsjson.Stringify(got, ""); g != want[i] {
			t.Errorf("case %d differs\n go: %s\n ts: %s", i, g, want[i])
		}
	}
}

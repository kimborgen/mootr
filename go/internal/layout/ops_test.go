package layout

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// lines is what layoutref.mjs prints for each case, done the Go way: each op's layout, error or typeerror, and whether
// the layout after it is valid; whether the last layout is valid, each op described, and the last layout's dead image tabs.
func lines(t *testing.T, c *jsjson.Object) []string {
	t.Helper()
	n := 0
	made := func() string { n++; return "n" + strconv.Itoa(n) }
	l, _ := get(c, "layout").(*jsjson.Object)
	ops, _ := get(c, "ops").([]jsjson.Value)
	var out []string
	for _, op := range ops {
		next, err := Apply(l, op, made)
		switch {
		case err != nil && strings.HasPrefix(err.Error(), "not a layout op this layout can take"):
			out = append(out, "typeerror")
		case err != nil:
			out = append(out, "error: "+err.Error())
		default:
			l = next
			out = append(out, jsjson.Stringify(l, ""))
		}
		out = append(out, "valid: "+strconv.FormatBool(Valid(l)))
	}
	out = append(out, "valid: "+strconv.FormatBool(Valid(l)))
	for _, op := range ops {
		if name, _ := get(op, "op").(string); opNames[name] {
			out = append(out, "describe: "+DescribeOp(op))
		} else {
			out = append(out, "describe: -")
		}
	}
	dead := "-"
	if Valid(l) {
		list := []jsjson.Value{}
		for _, op := range DeadImageTabOps(l, func(page string) bool { return page == "live" }) {
			list = append(list, op)
		}
		dead = jsjson.Stringify(list, "")
	}
	return append(out, "dead: "+dead)
}

// The Go ops are src/layout-ops.ts's, byte for byte: every op, its errors, the checks and the descriptions, on the cases
// in testdata/ops-cases.json.
func TestOpsMatchTS(t *testing.T) {
	in, err := os.ReadFile("testdata/ops-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", "--no-warnings", "testdata/layoutref.mjs")
	cmd.Stdin = bytes.NewReader(in)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("layoutref.mjs: %v\n%s", err, stderr.String())
	}
	var want [][]string
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	parsed, err := jsjson.Parse(in)
	if err != nil {
		t.Fatal(err)
	}
	cases := parsed.([]jsjson.Value)
	if len(cases) != len(want) {
		t.Fatalf("%d cases, TS answered %d", len(cases), len(want))
	}
	for i, c := range cases {
		got := lines(t, c.(*jsjson.Object))
		if len(got) != len(want[i]) {
			t.Errorf("case %d: %d lines, TS %d\n go: %s\n ts: %s", i, len(got), len(want[i]), strings.Join(got, "\n     "), strings.Join(want[i], "\n     "))
			continue
		}
		for j := range got {
			if got[j] != want[i][j] {
				t.Errorf("case %d line %d differs\n go: %s\n ts: %s", i, j, got[j], want[i][j])
			}
		}
	}
}

// Apply never changes the layout it is given.
func TestApplyLeavesItsInputAlone(t *testing.T) {
	l, err := jsjson.Parse([]byte(`{"version":1,"current":null,"agentWorlds":{"_home":{"root":{"id":"p","tabs":["a","b"],"active":"a"},"focused":"p"}},"worlds":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	before := jsjson.Stringify(l, "")
	op, _ := jsjson.Parse([]byte(`{"op":"split","world":"main","pane":"p","side":"right"}`))
	if _, err := Apply(l.(*jsjson.Object), op, func() string { return "x" }); err != nil {
		t.Fatal(err)
	}
	if after := jsjson.Stringify(l, ""); after != before {
		t.Errorf("Apply changed its input:\n before %s\n after  %s", before, after)
	}
}

package ring

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

type refOut struct {
	Line []struct {
		T string
		M bool
		V string
	}
	Of []struct {
		T, X string
		G    *string
		V    any
	}
	Split []struct {
		T string
		I int
		V string
	}
}

// The pure parts of src/ring.ts: which PR a ring reviews, a member's verdict and the split line, compared with TS over a matrix.
func TestPureMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/ring.ts")
	}
	out := filepath.Join(t.TempDir(), "out.json")
	if b, err := exec.Command("node", "--no-warnings", "testdata/ringref.mjs", out).CombinedOutput(); err != nil {
		t.Fatalf("node: %v\n%s", err, b)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var ref refOut
	if err := json.Unmarshal(raw, &ref); err != nil {
		t.Fatal(err)
	}
	for _, c := range ref.Line {
		if got := VerdictLine(c.T, c.M); got != c.V {
			t.Errorf("VerdictLine(%q, %v):\n go: %q\n ts: %q", c.T, c.M, got, c.V)
		}
	}
	for _, c := range ref.Of {
		got, err := VerdictOf(c.T, c.X, c.G)
		switch want := c.V.(type) {
		case nil:
			if err != nil || got != "" {
				t.Errorf("VerdictOf(%q, %q, %v): %q %v, ts none", c.T, c.X, c.G, got, err)
			}
		case string:
			if err != nil || got != want {
				t.Errorf("VerdictOf(%q, %q, %v): %q %v, ts %q", c.T, c.X, c.G, got, err, want)
			}
		case map[string]any:
			if err == nil || err.Error() != want["error"] {
				t.Errorf("VerdictOf(%q, %q, %v): %q %v, ts error %v", c.T, c.X, c.G, got, err, want["error"])
			}
		}
	}
	subsets := [][]Sub{
		nil, {{Agent: "a", Verdict: "approve"}}, {{Agent: "a", Verdict: "approve"}, {Agent: "b", Verdict: "approve"}},
		{{Agent: "a", Verdict: "approve"}, {Agent: "b", Verdict: "request_changes"}}, {{Agent: "a"}, {Agent: "b"}},
		{{Agent: "a", Verdict: "approve"}, {Agent: "b"}}, {{Agent: "a", Verdict: "request_changes"}},
	}
	for _, c := range ref.Split {
		if got := SplitLine(c.T, subsets[c.I], func(id string) string { return "n-" + id }); got != c.V {
			t.Errorf("SplitLine(%q, %d): %q, ts %q", c.T, c.I, got, c.V)
		}
	}
	if len(ref.Line) < 20 || len(ref.Of) < 500 || len(ref.Split) < 50 {
		t.Errorf("the matrix is too small: %d %d %d", len(ref.Line), len(ref.Of), len(ref.Split))
	}
}

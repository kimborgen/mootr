package steps

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"stam/internal/jsjson"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

// StoredArgs and the probability's two decimals are src/steps.ts storedArgs and toFixed(2), for arguments of every size and
// shape the history keeps.
func TestStoredArgsAndToFixedMatchTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/steps.ts")
	}
	long := strings.Repeat("abcé€😀", 400)
	wide := map[string]any{}
	for i := 0; i < 400; i++ {
		wide["key"+strings.Repeat("k", i%7)+string(rune('a'+i%26))+string(rune('A'+i/26))] = "value " + strings.Repeat("v", i%40)
	}
	cases := []any{
		map[string]any{},
		map[string]any{"command": "ls -la"},
		map[string]any{"command": long},
		map[string]any{"a": long, "b": long, "c": long, "d": long, "e": long},
		map[string]any{"nested": map[string]any{"body": long, "list": []any{long, 1, nil, true, long}}},
		[]any{long, long, long, long, long, long, long, long},
		wide,
		map[string]any{"ünï": "çödé", "n": 1.5, "big": 1e21, "neg": -0.0},
	}
	probs := []float64{0, 1, 0.5, 0.005, 0.015, 0.025, 0.035, 0.045, 0.125, 0.135, 0.145, 0.995, 0.994999, 0.2, 0.9, 0.57, 1.005, 0.1 + 0.2, 0.285, 0.675}
	dir := t.TempDir()
	in, err := json.Marshal(map[string]any{"cases": cases, "probs": probs})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "in.json"), in, 0o600); err != nil {
		t.Fatal(err)
	}
	script := `import { readFileSync } from 'node:fs';
const steps = await import(process.argv[2]);
const { cases, probs } = JSON.parse(readFileSync(process.argv[3], 'utf8'));
console.log(JSON.stringify({ stored: cases.map((c) => steps.storedArgs(c)), fixed: probs.map((p) => p.toFixed(2)) }));
process.exit(0);`
	if err := os.WriteFile(filepath.Join(dir, "ref.mjs"), []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := filepath.Abs("../../../src/steps.ts")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", "--no-warnings", filepath.Join(dir, "ref.mjs"), "file://"+src, filepath.Join(dir, "in.json"))
	cmd.Env = append(os.Environ(), "STAM_HOME="+filepath.Join(dir, "home"), "STAM_MACHINE=test-machine", "STAM_EMBEDDER=stub")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ref.mjs: %v\n%s", err, out)
	}
	var want struct {
		Stored []string
		Fixed  []string
	}
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	for i, c := range cases {
		raw, _ := json.Marshal(c)
		args, err := jsfmt.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := StoredArgs(args); got != want.Stored[i] {
			t.Errorf("case %d: StoredArgs\n go: %s\n ts: %s", i, got, want.Stored[i])
		}
	}
	for i, p := range probs {
		if got := ToFixed2(p); got != want.Fixed[i] {
			t.Errorf("ToFixed2(%v) = %s, TS %s", p, got, want.Fixed[i])
		}
	}
}

// A table that could not be made (a busy database) is made by the next call, not refused until a restart.
func TestTableRetriesAfterAFailure(t *testing.T) {
	calls := 0
	s := &Store{makeTables: func(context.Context) error {
		calls++
		if calls == 1 {
			return errors.New("database is locked")
		}
		return nil
	}}
	if err := s.table(context.Background()); err == nil {
		t.Fatal("the first attempt should fail")
	}
	if err := s.table(context.Background()); err != nil {
		t.Fatalf("the second attempt: %v", err)
	}
	if err := s.table(context.Background()); err != nil || calls != 2 {
		t.Errorf("a made table is not made again: %v after %d calls", err, calls)
	}
}

// Number(text) as JavaScript reads a request's number: 0x, 0o and 0b integers, blanks, and what is not a number.
func TestJSNumber(t *testing.T) {
	for in, want := range map[string]float64{"0x10": 16, "0X1f": 31, "0o17": 15, "0b101": 5, " 7 ": 7, "": 0, "1e3": 1000, ".5": 0.5, "-0x1": math.NaN(), "0x": math.NaN(), "1_0": math.NaN(), "0xg": math.NaN(), "abc": math.NaN()} {
		got := JSNumber(in)
		if got != want && !(math.IsNaN(got) && math.IsNaN(want)) {
			t.Errorf("Number(%q) = %v, want %v", in, got, want)
		}
	}
}

// The preview's example line keeps an array's arguments as `0: x` pairs, as Object.entries gives them.
func TestArgsLine(t *testing.T) {
	arr, _ := jsjson.Parse([]byte(`["a",{"b":1},"self"]`))
	if got := argsLine(arr); got != `0: a · 1: {"b":1} · 2: self` {
		t.Errorf("array: %q", got)
	}
	obj, _ := jsjson.Parse([]byte(`{"self":"x","cmd":"ls   -l\n"}`))
	if got := argsLine(obj); got != "cmd: ls -l " {
		t.Errorf("object: %q", got)
	}
	if got := argsLine(jsjson.NewObject()); got != "(no arguments)" {
		t.Errorf("empty: %q", got)
	}
}

package process

import (
	"math"
	"strings"
	"testing"
)

// A boundary's minutes can be any number `yaml` reads: Infinity and NaN print as null in the API (JSON.stringify), -0 as 0.
// A JSON fixture can't hold them, so they are here.
func TestBoundaryMinutesOfNonFiniteNumbers(t *testing.T) {
	const base = "process: tiny\nlanes:\n  human: { type: human }\nnodes:\n  s: { kind: start, lane: human, triggers: [{ source: manual }] }\n  a: { kind: agent, lane: human, boundary: [{ on: timeout, minutes: MIN }] }\n  e: { kind: end, lane: human, status: done }\nedges:\n  - [s, a]\n  - [a, e]\n"
	for in, check := range map[string]func(float64) bool{
		".inf": func(f float64) bool { return math.IsInf(f, 1) }, "-.Inf": func(f float64) bool { return math.IsInf(f, -1) },
		".NaN": math.IsNaN, "-0": func(f float64) bool { return f == 0 && math.Signbit(f) }, "0o17": func(f float64) bool { return f == 15 },
	} {
		text := strings.ReplaceAll(base, "MIN", in)
		def, errs := ParseText(text, ParseOptions{File: "processes/tiny.yaml"})
		if def == nil || len(errs) > 0 {
			t.Fatalf("%s: %v", in, errs)
		}
		b := def.Nodes["a"].Boundary
		if len(b) != 1 || !b[0].HasMinutes || !check(b[0].Minutes) {
			t.Errorf("minutes of %s: %+v", in, b)
		}
	}
}

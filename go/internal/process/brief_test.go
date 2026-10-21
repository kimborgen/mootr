package process

import "testing"

// A process's own text for a type comes before the fallback prose, and a type no process has a lane for gets the fallback.
func TestNextStepsPrefersAProcess(t *testing.T) {
	def := &Def{
		ID:        "p",
		LaneNames: []string{"dev"},
		Lanes:     map[string]Lane{"dev": {Type: "developer"}},
		NodeIDs:   []string{"code"},
		Nodes:     map[string]*Node{"code": {ID: "code", Kind: "agent", Lane: "dev", Brief: "Do the work."}},
	}
	if got := NextSteps([]*Def{def}, "developer"); got != "Do the work." {
		t.Errorf("developer: %q", got)
	}
	if got := NextSteps([]*Def{def}, "reviewer"); got != FallbackNextSteps("reviewer") || got == "" {
		t.Errorf("reviewer has no lane: %q", got)
	}
	if got := NextSteps(nil, "developer"); got != FallbackNextSteps("developer") {
		t.Errorf("no process: %q", got)
	}
	for _, typ := range []string{"coordinator", "reviewer-opus"} {
		if FallbackNextSteps(typ) == "" {
			t.Errorf("%s has no fallback", typ)
		}
	}
	if FallbackNextSteps("advisor") != "" {
		t.Errorf("advisor has a fallback")
	}
}

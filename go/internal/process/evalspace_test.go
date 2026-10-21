package process

import "testing"

// JS \-s reads the Unicode spaces, the BOM and the line separators around a condition; so does this port.
func TestEvalConditionJSSpace(t *testing.T) {
	facts := map[string]string{"answered": "true", "verdict": "pass"}
	for when, want := range map[string]bool{
		"\u00a0answered\u00a0":            true,
		"\ufeffanswered":                  true,
		"answered\u2028":                  true,
		"\u3000verdict\u2003==\u00a0pass": true,
		"verdict != \u202fpass\u205f":     false,
		"answered\u200b":                  false, // a zero-width space is not \-s
		"ans wered":                       false,
	} {
		if got := EvalCondition(when, facts); got != want {
			t.Errorf("EvalCondition(%q) = %v, want %v", when, got, want)
		}
	}
}

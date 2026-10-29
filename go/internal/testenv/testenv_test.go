package testenv

import (
	"os"
	"testing"
)

func TestScrubDropsBothNames(t *testing.T) {
	for _, k := range []string{"MOOTR_HOME", "STAM_HOME", "MOOTR_TOKEN", "STAM_TOKEN", "MOOTR_PORT", "STAM_MACHINE", "OPENROUTER_API_KEY"} {
		t.Setenv(k, "live")
	}
	t.Setenv("STAM_EMBEDDER", "stub")
	Scrub()
	for _, k := range []string{"MOOTR_HOME", "STAM_HOME", "MOOTR_TOKEN", "STAM_TOKEN", "MOOTR_PORT", "STAM_MACHINE", "OPENROUTER_API_KEY"} {
		if _, ok := os.LookupEnv(k); ok {
			t.Errorf("%s survived Scrub", k)
		}
	}
	if os.Getenv("STAM_EMBEDDER") != "stub" {
		t.Error("Scrub removed a name outside its list")
	}
}

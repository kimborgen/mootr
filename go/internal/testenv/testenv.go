// Package testenv scrubs the process environment a Go test inherits (S-3140). A TS reader takes MOOTR_X before STAM_X, and a
// stam agent's environment carries both names, so a stray one sends the node child a Go test starts to the live home, daemon or
// token. Call Scrub from an init in each test package that runs node; the test then sets what it needs.
package testenv

import "os"

// names are the variables that reach the live home, daemon or identity, without their STAM_/MOOTR_ prefix.
var names = []string{"HOME", "PORT", "URL", "TOKEN", "MACHINE", "AGENT_ID", "TMUX_SOCKET"}

// Scrub removes each name under both prefixes, and stam's own OpenRouter key, so a test that polls the credit (the Go
// daemon's start does, src/credits.ts) can never reach OpenRouter with a real one.
func Scrub() {
	for _, n := range names {
		os.Unsetenv("STAM_" + n)
		os.Unsetenv("MOOTR_" + n)
	}
	os.Unsetenv("OPENROUTER_API_KEY")
}

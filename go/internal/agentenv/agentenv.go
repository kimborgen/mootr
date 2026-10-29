// Package agentenv names the variables that carry an agent's identity and token (S-3329; src/env.ts AGENT_IDENTITY). A
// process that isn't that agent must not inherit any of them, under either name: the daemon's start, the compactor and the
// tmux panes all scrub this list.
package agentenv

import "strings"

// Identity is the STAM_ names of an agent's identity and token.
var Identity = []string{"STAM_AGENT_ID", "STAM_AGENT_NAME", "STAM_TOKEN"}

// Names is Identity with each name's MOOTR_ twin after it (src/env.ts withMootrTwins).
func Names() []string {
	out := make([]string, 0, 2*len(Identity))
	for _, n := range Identity {
		out = append(out, n, "MOOTR_"+strings.TrimPrefix(n, "STAM_"))
	}
	return out
}

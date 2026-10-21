// Package adapters holds what every harness adapter shares (src/adapters/types.ts): the launch spec an adapter builds,
// and the env lifecycle adds to it when it starts the agent's tmux session (S-2804).
package adapters

import "stam/internal/tmux"

// LaunchSpec is the command that starts a harness and the env it adds. The command never carries the agent's prompt,
// system prompt or token: every process on the machine sees command lines (`ps`), and a broad `pkill -f PATTERN`
// matches them.
type LaunchSpec struct {
	Argv []string
	Env  tmux.Env
}

// SessionVars is what lifecycle adds to a launch spec's env for the agent's tmux session (src/lifecycle.ts
// startHarness).
type SessionVars struct {
	AgentID string
	// URL is the daemon's STAM_URL.
	URL string
	// Token is the agent's own launch token (S-237): it reaches the session only through new-session.conf, never argv.
	Token string
	// ReviewDir and ReviewTmp are a reviewer's clone and test folder (S-912, S-1330), "" when it has none.
	ReviewDir string
	ReviewTmp string
}

// SessionEnv is the session's env in TS's order: `{...spec.env, STAM_REVIEW_DIR?, STAM_TEST_TMPDIR?, STAM_AGENT_ID,
// STAM_URL, STAM_TOKEN}`, where a key the spec already holds keeps its place and takes the later value.
func SessionEnv(spec tmux.Env, v SessionVars) tmux.Env {
	env := append(tmux.Env{}, spec...)
	if v.ReviewDir != "" {
		env = env.Set("STAM_REVIEW_DIR", v.ReviewDir)
	}
	if v.ReviewTmp != "" {
		env = env.Set("STAM_TEST_TMPDIR", v.ReviewTmp)
	}
	env = env.Set("STAM_AGENT_ID", v.AgentID)
	env = env.Set("STAM_URL", v.URL)
	return env.Set("STAM_TOKEN", v.Token)
}

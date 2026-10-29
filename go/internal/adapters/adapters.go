// Package adapters holds what every harness adapter shares (src/adapters/types.ts): the launch spec an adapter builds,
// and the env lifecycle adds to it when it starts the agent's tmux session (S-2804).
package adapters

import (
	"os"
	"path/filepath"
	"strconv"

	"stam/internal/jsjson"
	"stam/internal/tmux"
)

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

// GoBinDir is the Go toolchain's bin dir under the env's HOME, else the daemon's (S-3666; src/env.ts goBinDir): "" when the
// directory isn't there. Only its presence decides.
func GoBinDir(env tmux.Env) string {
	home, ok := env.Get("HOME")
	if !ok {
		home = os.Getenv("HOME")
	}
	if home == "" {
		return ""
	}
	bin := filepath.Join(home, ".local", "go", "bin")
	if fi, err := os.Stat(bin); err != nil || !fi.IsDir() {
		return ""
	}
	return bin
}

// GoBinArgv is argv run through the shell with bin put first on the shell's own PATH (S-3666; src/env.ts withGoBinArgv): the
// startup files have run by then, so every dir they add stays, and a dir already on PATH isn't added again. bin "" leaves argv as it is.
func GoBinArgv(argv []string, bin string) []string {
	if bin == "" {
		return argv
	}
	script := `case ":$PATH:" in *":$1:"*) ;; *) PATH="$1:$PATH" ;; esac; export PATH; shift; exec "$@"`
	return append([]string{"/bin/sh", "-c", script, "sh", bin}, argv...)
}

// McpServer is one of the extra MCP servers settings.mcpServers names. Server is nil for an entry that is truthy but no
// object, which reads as one with no fields, as in TS.
type McpServer struct {
	Name   string
	Server *jsjson.Object
}

// McpServers is src/instructions.ts extraMcpServers over settings.mcpServers: the entries that are truthy and not
// `enabled: false`, in Object.entries' order (an object's keys in JavaScript order, an array's indices).
func McpServers(v jsjson.Value) []McpServer {
	var out []McpServer
	for _, name := range entryKeys(v) {
		s := entry(v, name)
		// `s && s.enabled !== false`.
		if !jsjson.Truthy(s) {
			continue
		}
		o, _ := s.(*jsjson.Object)
		if en, ok := o.Get("enabled"); ok && en == false {
			continue
		}
		out = append(out, McpServer{Name: name, Server: o})
	}
	return out
}

// entryKeys is Object.entries' keys of settings.mcpServers: an object's in JavaScript order, an array's indices.
func entryKeys(v jsjson.Value) []string {
	switch x := v.(type) {
	case *jsjson.Object:
		return x.Keys()
	case []jsjson.Value:
		keys := make([]string, len(x))
		for i := range x {
			keys[i] = strconv.Itoa(i)
		}
		return keys
	}
	return nil
}

func entry(v jsjson.Value, key string) jsjson.Value {
	switch x := v.(type) {
	case *jsjson.Object:
		val, _ := x.Get(key)
		return val
	case []jsjson.Value:
		i, _ := strconv.Atoi(key)
		return x[i]
	}
	return nil
}

// Skill is a skill folder (one holding SKILL.md): its name, path, and source, "claude" or "stam".
type Skill struct{ Name, Path, Source string }

// SkillFolders is src/instructions.ts skillFolders: the skill folders of ~/.claude/skills, then of STAM_HOME/skills,
// where a stam skill replaces a user skill of the same name in its place (as the TS Map does).
func SkillFolders(home, userHome string) []Skill {
	byName := map[string]Skill{}
	var order []string
	for _, src := range []struct{ source, dir string }{{"claude", filepath.Join(userHome, ".claude", "skills")}, {"stam", filepath.Join(home, "skills")}} {
		entries, err := os.ReadDir(src.dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			n := e.Name()
			if _, err := os.Stat(filepath.Join(src.dir, n, "SKILL.md")); err != nil {
				continue
			}
			if _, seen := byName[n]; !seen {
				order = append(order, n)
			}
			byName[n] = Skill{Name: n, Path: filepath.Join(src.dir, n), Source: src.source}
		}
	}
	out := make([]Skill, 0, len(order))
	for _, n := range order {
		out = append(out, byName[n])
	}
	return out
}

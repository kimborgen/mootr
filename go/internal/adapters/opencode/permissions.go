package opencode

import (
	"path/filepath"

	"stam/internal/adapters"
	"stam/internal/jsjson"
)

// Permission is one of a session's permission rules, as OpenCode's session API takes it.
type Permission struct {
	Action   string `json:"action"`
	Resource string `json:"resource"`
	Effect   string `json:"effect"`
}

// SessionPermissions is src/adapters/opencode.ts sessionPermissions: a new session's rules, every tool allowed in bypass,
// asked in default (S-1967), and OpenCode's own rules in auto; a resume applies them again. The secret files (S-1888) are
// denied in every mode: OpenCode takes the session's rules after its own and the last matching rule wins, so a deny here
// holds over bypass's allow and default's asks. cwd is the agent's folder: OpenCode names a file inside it, or inside
// its project root, relative to that folder, so those forms are denied too (S-1891).
func SessionPermissions(mode, cwd, home, userHome string) []Permission {
	var out []Permission
	switch mode {
	case "bypass":
		out = append(out, Permission{"*", "*", "allow"})
	case "default":
		out = append(out, Permission{"*", "*", "ask"})
	}
	for _, p := range secretResources(cwd, home, userHome) {
		out = append(out, Permission{"read", p, "deny"}, Permission{"edit", p, "deny"})
	}
	for _, p := range adapters.SecretCommandPatterns() {
		out = append(out, Permission{"shell", p, "deny"})
	}
	return out
}

// PermissionsJSON is the rules as the session API's body takes them.
func PermissionsJSON(ps []Permission) []jsjson.Value {
	out := make([]jsjson.Value, len(ps))
	for i, p := range ps {
		out[i] = jsjson.NewObject("action", p.Action, "resource", p.Resource, "effect", p.Effect)
	}
	return out
}

// secretResources is src/adapters/opencode.ts secretResources: each secret file as a session may name it, absolute, by
// its real path where a symlink holds it, and relative to the agent's folder as given and as real. OpenCode names a file
// relative to the session's directory, in its project or not (`../stam/token`), so naming every secret from the folder
// denies whatever project OpenCode finds. This guards canonical-path reads only; it is no boundary against an agent that
// means to read the file.
func secretResources(cwd, home, userHome string) []string {
	abs := adapters.SecretPaths(home, userHome)
	if cwd == "" {
		return abs
	}
	secrets := unique(append(append([]string{}, abs...), mapped(abs, realOrSelf)...))
	given, _ := filepath.Abs(cwd)
	dirs := unique([]string{given, realOrSelf(given)})
	out := append([]string{}, secrets...)
	for _, d := range dirs {
		for _, p := range secrets {
			out = append(out, relative(d, p))
		}
	}
	return unique(out)
}

// relative is node's path.relative for absolute paths: "" for the same path.
func relative(from, to string) string {
	r, err := filepath.Rel(from, to)
	if err != nil || r == "." {
		return ""
	}
	return r
}

// realOrSelf is a path's real path, or the path itself when it doesn't exist.
func realOrSelf(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		if r, err := filepath.Abs(r); err == nil {
			return r
		}
	}
	return p
}

func mapped(list []string, f func(string) string) []string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = f(s)
	}
	return out
}

// unique is `[...new Set(list)]`: the first of each, in order.
func unique(list []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range list {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

package adapters

import (
	"path/filepath"

	"stam/internal/config"
)

// SecretFiles is src/secret-files.ts SECRET_FILES: the files under a home that hold credentials, which every harness
// denies (S-1888). A `*` is a glob in each harness's rule syntax (secrets.json.* covers the secret store's in-flight temp
// files).
var SecretFiles = []string{"token", "peer-token", "mcp-lease-token", "mcp-lease-token.*", "settings.json", "settings.shared.json",
	"settings.json.*", "opencode.env", "voice.env", "mcp-auth.json", "secrets.json", "secrets.json.*"}

// SecretHomes is src/secret-files.ts secretHomes: the homes whose secrets are denied, STAM_HOME as given and resolved (a
// symlinked home is read through either path), plus both spellings of the default home (S-903, S-3347).
func SecretHomes(home, userHome string) []string {
	homes := []string{home}
	if r, err := filepath.EvalSymlinks(home); err == nil {
		if r, err = filepath.Abs(r); err == nil {
			homes = append(homes, r)
		}
	}
	homes = append(homes, config.DefaultHomes(userHome)...)
	seen := map[string]bool{}
	var out []string
	for _, h := range homes {
		if !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	return out
}

// SecretPaths is src/secret-files.ts secretPaths: every secret file under every such home.
func SecretPaths(home, userHome string) []string {
	var out []string
	for _, h := range SecretHomes(home, userHome) {
		for _, f := range SecretFiles {
			out = append(out, h+"/"+f)
		}
	}
	return out
}

// SecretCommandPatterns is src/secret-files.ts secretCommandPatterns: command-text patterns for a shell tool. Best
// effort: the path rules are the real gate.
func SecretCommandPatterns() []string {
	var out []string
	for _, f := range SecretFiles {
		out = append(out, "*stam/"+f+"*", "*mootr/"+f+"*")
	}
	return out
}

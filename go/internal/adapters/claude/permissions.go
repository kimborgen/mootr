package claude

import (
	"path/filepath"
	"strconv"
)

// Permission rules stam writes into every Claude Code agent's settings (src/adapters/claude-permissions.ts, S-570).
// Only read-only commands are allowed: an allow rule skips auto mode's classifier, whose false denials stalled agents
// on read-only `cat`, `sed -n`, `grep` and `git status`. The deny rules keep `cat` and `grep` away from stam's secrets;
// Bash patterns match command text, not resolved paths, so they are best effort. The Read rules deny the token files by
// resolved path too (S-743).

var gitRead = []string{"status", "diff", "log", "show", "rev-parse", "merge-base", "ls-files"}
var readCmds = []string{"ls", "cat", "head", "tail", "wc", "grep", "sed -n"}

// DefaultHome is src/config.ts DEFAULT_STAM_HOME: ~/.local/share/stam.
func DefaultHome(userHome string) string { return filepath.Join(userHome, ".local", "share", "stam") }

// AllowRules is the read-only commands every agent may run without a prompt, and the images it may read.
func AllowRules(userHome string, uid int) []string {
	var out []string
	for _, c := range gitRead {
		out = append(out, "Bash(git "+c+":*)")
	}
	out = append(out, "Bash(git remote -v)", "Bash(git branch --show-current)", "Bash(git branch -a)", "Bash(git branch --list:*)")
	for _, c := range readCmds {
		out = append(out, "Bash("+c+":*)")
	}
	// `//` makes a Read path absolute. Images only: a worktree can hold a `.env`.
	return append(out, "Read(/"+DefaultHome(userHome)+"/worktrees/**/*.png)", "Read(//tmp/claude-"+strconv.Itoa(uid)+"/**/*.png)")
}

// SecretHomes is the homes whose secrets are denied: STAM_HOME as given and resolved (a symlinked home is read through
// either path), plus the default home (S-903).
func SecretHomes(home, userHome string) []string {
	homes := []string{home}
	if r, err := filepath.EvalSymlinks(home); err == nil {
		if r, err = filepath.Abs(r); err == nil {
			homes = append(homes, r)
		}
	}
	homes = append(homes, DefaultHome(userHome))
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

// SecretFiles is src/secret-files.ts SECRET_FILES: the files under a home that hold credentials. A `*` is a glob in
// each harness's rule syntax (secrets.json.* covers the secret store's in-flight temp files).
var SecretFiles = []string{"token", "peer-token", "settings.json", "settings.shared.json", "settings.json.*", "opencode.env", "voice.env",
	"mcp-auth.json", "secrets.json", "secrets.json.*"}

// DenyRules is the secrets no agent may read or write, by command text and by path (src/adapters/claude-permissions.ts
// denyRules, S-1891): each secret file is denied to Read, and to Edit and Write too (S-1888: a Write could replace a
// settings file the daemon reads).
func DenyRules(home, userHome string) []string {
	out := []string{"Bash(*stam/stam.db*)"}
	for _, f := range SecretFiles {
		out = append(out, "Bash(*stam/"+f+"*)")
	}
	out = append(out, "Bash(*stam/registry.json*)", "Bash(cat *.env)", "Bash(*/.ssh/*)")
	for _, h := range SecretHomes(home, userHome) {
		for _, f := range SecretFiles {
			p := "/" + h + "/" + f
			out = append(out, "Read("+p+")", "Edit("+p+")", "Write("+p+")")
		}
	}
	return out
}

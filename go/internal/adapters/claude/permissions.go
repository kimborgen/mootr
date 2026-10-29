package claude

import (
	"path/filepath"
	"strconv"

	"stam/internal/adapters"
	"stam/internal/config"
)

// Permission rules stam writes into every Claude Code agent's settings (src/adapters/claude-permissions.ts, S-570).
// Only read-only commands are allowed: an allow rule skips auto mode's classifier, whose false denials stalled agents
// on read-only `cat`, `sed -n`, `grep` and `git status`. The deny rules keep `cat` and `grep` away from stam's secrets;
// Bash patterns match command text, not resolved paths, so they are best effort. The Read rules deny the token files by
// resolved path too (S-743).

var gitRead = []string{"status", "diff", "log", "show", "rev-parse", "merge-base", "ls-files"}
var readCmds = []string{"ls", "cat", "head", "tail", "wc", "grep", "sed -n"}

// DefaultHome is src/config.ts DEFAULT_STAM_HOME: config.DefaultHome: a real ~/.local/share/stam, else mootr. A home
// that can't be inspected gets the stam path here, since these are only rule patterns.
func DefaultHome(userHome string) string {
	if h, err := config.DefaultHome(userHome); err == nil {
		return h
	}
	return filepath.Join(userHome, ".local", "share", "stam")
}

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
	for _, h := range DefaultHomes(userHome) {
		out = append(out, "Read(/"+h+"/worktrees/**/*.png)")
	}
	return append(out, "Read(//tmp/claude-"+strconv.Itoa(uid)+"/**/*.png)")
}

// DefaultHomes is src/config.ts DEFAULT_HOMES: both spellings of the default home, whether or not either exists, so a
// path guard matches a read through the stam symlink and through the mootr folder (S-3347).
func DefaultHomes(userHome string) []string {
	return []string{filepath.Join(userHome, ".local", "share", "stam"), filepath.Join(userHome, ".local", "share", "mootr")}
}

// DenyRules is the secrets no agent may read or write, by command text and by path (src/adapters/claude-permissions.ts
// denyRules, S-1891): each secret file is denied to Read, and to Edit and Write too (S-1888: a Write could replace a
// settings file the daemon reads).
func DenyRules(home, userHome string) []string {
	out := []string{"Bash(*stam/stam.db*)", "Bash(*mootr/stam.db*)"}
	for _, f := range adapters.SecretFiles {
		out = append(out, "Bash(*stam/"+f+"*)", "Bash(*mootr/"+f+"*)")
	}
	out = append(out, "Bash(*stam/registry.json*)", "Bash(*mootr/registry.json*)", "Bash(cat *.env)", "Bash(*/.ssh/*)")
	for _, h := range adapters.SecretHomes(home, userHome) {
		for _, f := range adapters.SecretFiles {
			p := "/" + h + "/" + f
			out = append(out, "Read("+p+")", "Edit("+p+")", "Write("+p+")")
		}
	}
	return out
}

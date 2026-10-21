package templates

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"stam/internal/jsjson"
)

// Instructions across harnesses (src/instructions.ts). Each harness loads only its own instruction files (Claude Code:
// CLAUDE.md and CLAUDE.local.md; OpenCode and Codex: AGENTS.md) and only from the folder it starts in and its parents.
// stam tells every agent about the instruction files its harness skips, including ones in subfolders of a multi-repo
// workspace, and adds the user's instructions for all agents.

var native = map[string][]string{
	"claude":   {"CLAUDE.md", "CLAUDE.local.md"},
	"opencode": {"AGENTS.md"},
	"codex":    {"AGENTS.md"},
}

var allFiles = []string{"CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"}

var skipDirs = map[string]bool{"node_modules": true, ".git": true, "dist": true, "build": true, ".venv": true, "venv": true, "__pycache__": true, ".cache": true}

// GitTimeout bounds the `git rev-parse` that finds a working folder's repo root.
const GitTimeout = 10 * time.Second

// GlobalInstructions is STAM_HOME/instructions.md, the user's text for all agents; "" when there is none.
func (s *Set) GlobalInstructions() string {
	b, err := os.ReadFile(filepath.Join(s.Home, "instructions.md"))
	if err != nil {
		return ""
	}
	return string(b)
}

// top is the folder the walk up from cwd stops at: the git root, or the user's home folder.
func (s *Set) top(ctx context.Context, cwd string) string {
	ctx, cancel := context.WithTimeout(ctx, GitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", cwd, "rev-parse", "--show-toplevel")
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		return s.UserHome
	}
	return jsjson.Trim(string(out))
}

// upwardDirs is the working folder and its parents up to the git root (or home), nearest first.
func (s *Set) upwardDirs(ctx context.Context, cwd string) []string {
	stop := s.top(ctx, cwd)
	var out []string
	for d := cwd; ; d = dirname(d) {
		out = append(out, d)
		if d == stop || d == dirname(d) || !strings.HasPrefix(d, stop) {
			break
		}
	}
	return out
}

func (s *Set) upwards(ctx context.Context, cwd string) []string {
	var out []string
	for _, d := range s.upwardDirs(ctx, cwd) {
		for _, f := range allFiles {
			if p := join(d, f); exists(p) {
				out = append(out, p)
			}
		}
	}
	return out
}

// downwards is the instruction files below the working folder, two levels deep, which no harness loads when it starts
// in the parent folder.
func downwards(cwd string) []string {
	var out []string
	var walk func(d string, level int)
	walk = func(d string, level int) {
		if level > 2 {
			return
		}
		entries, err := os.ReadDir(d)
		if err != nil {
			return
		}
		for _, e := range entries {
			n := e.Name()
			if skipDirs[n] || strings.HasPrefix(n, ".") {
				continue
			}
			p := join(d, n)
			if info, err := os.Stat(p); err != nil || !info.IsDir() {
				continue
			}
			for _, f := range allFiles {
				if exists(join(p, f)) {
					out = append(out, join(p, f))
				}
			}
			walk(p, level+1)
		}
	}
	walk(cwd, 1)
	return out
}

// globalFiles is the other harnesses' user-global instruction files, which this harness doesn't load.
func (s *Set) globalFiles(harness string) []string {
	claudeGlobal := filepath.Join(s.UserHome, ".claude", "CLAUDE.md")
	codexGlobal := filepath.Join(s.UserHome, ".codex", "AGENTS.md")
	var out []string
	if harness != "claude" && exists(claudeGlobal) {
		out = append(out, claudeGlobal)
	}
	if harness != "codex" && exists(codexGlobal) {
		out = append(out, codexGlobal)
	}
	return out
}

// InstructionsDetail is the Instructions section's pieces: the user's text for all agents (trimmed), and the note
// naming the files this harness skips ("" when there are none).
func (s *Set) InstructionsDetail(ctx context.Context, harness, cwd string) (global, note string) {
	nat := native[harness]
	var here []string
	for _, f := range s.upwards(ctx, cwd) {
		if !contains(nat, filepath.Base(f)) {
			here = append(here, f)
		}
	}
	below := downwards(cwd)
	globals := s.globalFiles(harness)
	var lines []string
	if len(here) > 0 || len(globals) > 0 {
		lines = append(lines, "Read these instruction files before you start; your harness does not load them on its own. Where they speak to another harness, follow their intent:")
		for _, f := range append(globals, here...) {
			lines = append(lines, "- "+f)
		}
	}
	if len(below) > 0 {
		lines = append(lines, "", "Subfolders of your workspace have their own instruction files. Before working in one of these folders, read its file:")
		for _, f := range below {
			rel, err := filepath.Rel(cwd, f)
			if err != nil {
				rel = f
			}
			lines = append(lines, "- "+rel)
		}
	}
	return jsjson.Trim(s.GlobalInstructions()), strings.Join(lines, "\n")
}

// InstructionsPrompt is the Instructions section of an agent's system prompt, "" when there is nothing to say.
func (s *Set) InstructionsPrompt(ctx context.Context, harness, cwd string) (string, error) {
	global, note := s.InstructionsDetail(ctx, harness, cwd)
	if global == "" && note == "" {
		return "", nil
	}
	return s.Render("instruction-files", map[string]string{"global": global, "files": note}, "")
}

// dirname is node's path.posix.dirname: trailing slashes go before the last segment does, so "/a/b/" is "/a".
func dirname(p string) string {
	if p == "" {
		return "."
	}
	t := strings.TrimRight(p, "/")
	if t == "" {
		return "/"
	}
	i := strings.LastIndex(t, "/")
	switch {
	case i < 0:
		return "."
	case i == 0:
		return "/"
	}
	return strings.TrimRight(t[:i], "/")
}

// join is node's path.join for these paths: filepath.Join, which cleans the same way.
func join(elem ...string) string { return filepath.Join(elem...) }

func contains(a []string, s string) bool {
	for _, x := range a {
		if x == s {
			return true
		}
	}
	return false
}

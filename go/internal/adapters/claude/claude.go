// Package claude is the launch half of the Claude Code adapter (src/adapters/claude.ts launch, S-2804): it writes the
// agent's claude-settings.json (hooks and statusline pointing at `stam hook` and `stam statusline`), claude-mcp.json
// and system-prompt.md into STAM_HOME/agents/ID, byte for byte as the TS daemon does, and builds the launch command and
// env.
//
// Not yet ported: hook handling, screen scraping, dialogs, compaction and transcript parsing. The system prompt's
// slots that come from other modules (org, cost, lessons, workspace, ITSAs, requirements) and the workspaces shared
// with the agent come in as Parts, which those modules' ports fill.
package claude

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"syscall"

	"stam/internal/adapters"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/templates"
	"stam/internal/tmux"
)

// HookEvents are the Claude Code hook events stam listens to.
var HookEvents = []string{
	"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop",
	"StopFailure", "SessionEnd", "PreCompact", "PostCompact",
}

// Env is what a launch reads besides the agent.
type Env struct {
	// Home is STAM_HOME.
	Home string
	// UserHome is $HOME: ~/.claude/settings.json (the user's statusline) and the default home the deny rules name.
	UserHome string
	// Bin is stam's own command (src/config.ts STAM_BIN: RELEASES/current/bin/stam in a release, ROOT/bin/stam in a
	// checkout).
	Bin string
	// ClaudeBin is Claude Code's binary: STAM_CLAUDE_BIN, else "claude". Tests point it at the scripted fake.
	ClaudeBin string
	// TestTmpBase is the test base folder (TestTmpBase), "" when there is none.
	TestTmpBase string
	// UID is the user's id, in the /tmp/claude-UID allow rule.
	UID       int
	Templates *templates.Set
	Settings  config.Settings
}

// Parts are the system prompt's slots other modules render, and the workspaces shared with the agent.
type Parts struct {
	Org, Cost, Lessons, Workspace, Itsa, Requirements string
	// Granted is the paths of the workspaces shared with the agent (src/workspace-share.ts grantedPaths).
	Granted []string
}

// TestTmpBase is src/config.ts testTmpBase: STAM_TEST_TMPDIR, else ~/.cache/stam-test (XDG_CACHE_HOME first) when /tmp
// is a tmpfs, else "". TS asks `stat -f`; this asks statfs, so no process runs.
func TestTmpBase(getenv func(string) string, userHome string) string {
	if d := getenv("STAM_TEST_TMPDIR"); d != "" {
		return d
	}
	var st syscall.Statfs_t
	const tmpfsMagic = 0x01021994
	if syscall.Statfs("/tmp", &st) != nil || st.Type != tmpfsMagic {
		return ""
	}
	cache := getenv("XDG_CACHE_HOME")
	if cache == "" {
		cache = filepath.Join(userHome, ".cache")
	}
	return filepath.Join(cache, "stam-test")
}

// AgentDir is STAM_HOME/agents/ID, made and kept 0700 with its parent (src/config.ts agentDir): it holds the agent's
// harness configs, some with secrets.
func AgentDir(home, id string) (string, error) {
	agents := filepath.Join(home, "agents")
	dir := filepath.Join(agents, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(agents, 0o700); err != nil {
		return "", err
	}
	return dir, os.Chmod(dir, 0o700)
}

// Launch writes the agent's three Claude Code files and returns the command that starts it: a fresh session with the
// agent's session id, or a resume of it.
func Launch(ctx context.Context, e Env, a db.Agent, resume bool, p Parts) (adapters.LaunchSpec, error) {
	dir, err := AgentDir(e.Home, a.ID)
	if err != nil {
		return adapters.LaunchSpec{}, err
	}
	settingsFile := filepath.Join(dir, "claude-settings.json")
	if err := os.WriteFile(settingsFile, []byte(jsjson.Stringify(e.settings(a, p), "  ")), 0o666); err != nil {
		return adapters.LaunchSpec{}, err
	}
	// The mcp-config file holds env values and header values, so it is private to the user. As in TS, the mode applies
	// when the file is made; an existing file keeps its own.
	mcpFile := filepath.Join(dir, "claude-mcp.json")
	if err := os.WriteFile(mcpFile, []byte(jsjson.Stringify(e.mcpConfig(), "  ")), 0o600); err != nil {
		return adapters.LaunchSpec{}, err
	}
	prompt, err := e.systemPrompt(ctx, a, p)
	if err != nil {
		return adapters.LaunchSpec{}, err
	}
	promptFile := filepath.Join(dir, "system-prompt.md")
	if err := os.WriteFile(promptFile, []byte(prompt), 0o666); err != nil {
		return adapters.LaunchSpec{}, err
	}
	bin := e.ClaudeBin
	if bin == "" {
		bin = "claude"
	}
	session := "--session-id"
	if resume {
		session = "--resume"
	}
	// The stam MCP server doubles as a Claude Code channel, which lets stam start a turn in an idle session without
	// typing into its input box.
	argv := []string{bin, session, deref(a.SessionID), "--settings", settingsFile, "--mcp-config", mcpFile,
		"--dangerously-load-development-channels", "server:stam", "--append-system-prompt-file", promptFile}
	plugin, err := PluginDir(e.Home, e.UserHome)
	if err != nil {
		return adapters.LaunchSpec{}, err
	}
	if plugin != "" {
		argv = append(argv, "--plugin-dir", plugin)
	}
	if m := deref(a.Model); m != "" {
		argv = append(argv, "--model", m)
	}
	if ef := deref(a.Effort); ef != "" {
		argv = append(argv, "--effort", ef)
	}
	mode := "auto"
	switch a.PermissionMode {
	case "bypass":
		mode = "bypassPermissions"
	case "default":
		mode = "default"
	}
	argv = append(argv, "--permission-mode", mode)
	var env tmux.Env
	if usl := userStatusLine(e.UserHome); usl != "" {
		env = env.Set("STAM_USER_STATUSLINE", usl)
	}
	return adapters.LaunchSpec{Argv: argv, Env: env}, nil
}

// settings is claude-settings.json.
func (e Env) settings(a db.Agent, p Parts) *jsjson.Object {
	hook := func() *jsjson.Object { return jsjson.NewObject("type", "command", "command", e.Bin+" hook claude") }
	hooks := jsjson.NewObject()
	for _, ev := range HookEvents {
		hooks.Set(ev, []jsjson.Value{jsjson.NewObject("hooks", []jsjson.Value{hook()})})
	}
	// The guard runs before Bash only, and is the one hook that can refuse a command. A hang would stall the agent's
	// tool call, so the guard gives up after 5 s and lets it run.
	guard := jsjson.NewObject("type", "command", "command", e.Bin+" guard", "timeout", 5)
	hooks.Set("PreToolUse", []jsjson.Value{
		jsjson.NewObject("hooks", []jsjson.Value{hook()}),
		jsjson.NewObject("matcher", "Bash", "hooks", []jsjson.Value{guard}),
	})
	// The test base folder, the agent's own workspace, and the workspaces shared with it (S-896): outside these,
	// reading a folder stops the agent on a dialog.
	var extra []jsjson.Value
	if e.TestTmpBase != "" {
		extra = append(extra, e.TestTmpBase)
	}
	if w := deref(a.PersonalWorkspace); w != "" {
		extra = append(extra, w)
	}
	for _, g := range p.Granted {
		extra = append(extra, g)
	}
	perms := jsjson.NewObject("allow", append([]string{"mcp__stam"}, AllowRules(e.UserHome, e.UID)...), "deny", DenyRules(e.Home, e.UserHome))
	if len(extra) > 0 {
		perms.Set("additionalDirectories", extra)
	}
	return jsjson.NewObject(
		"hooks", hooks,
		"statusLine", jsjson.NewObject("type", "command", "command", e.Bin+" statusline claude", "padding", 0),
		// stam's own tools are pre-approved; read-only commands are pre-approved and secrets denied (S-570).
		"permissions", perms,
		// stam compacts idle agents itself (S-2238); Claude Code's own idle compaction would race it.
		"idleCompaction", false,
	)
}

// mcpConfig is claude-mcp.json: settings.mcpServers that are enabled, in Claude Code's format, then stam's own. A url
// server needs its type: Claude Code reads `http` as a streamable HTTP server. An auth server is reached through stam's
// proxy, never its url or a header: the token lives in the daemon (mcp-auth.ts).
func (e Env) mcpConfig() *jsjson.Object {
	servers := jsjson.NewObject()
	for _, name := range entryKeys(e.Settings.McpServers) {
		s := entry(e.Settings.McpServers, name)
		// extraMcpServers: `s && s.enabled !== false`.
		if !jsjson.Truthy(s) {
			continue
		}
		o, _ := s.(*jsjson.Object)
		if en, ok := o.Get("enabled"); ok && en == false {
			continue
		}
		get := func(k string) (jsjson.Value, bool) { return o.Get(k) }
		auth, _ := get("auth")
		url, _ := get("url")
		out := jsjson.NewObject()
		switch {
		case jsjson.Truthy(auth):
			out.Set("command", e.Bin)
			out.Set("args", []jsjson.Value{"mcp-proxy", name})
		case jsjson.Truthy(url):
			out.Set("type", "http")
			out.Set("url", url)
			if h, _ := get("headers"); jsjson.Truthy(h) {
				out.Set("headers", h)
			}
		default:
			if c, ok := get("command"); ok {
				out.Set("command", c)
			}
			for _, k := range []string{"args", "env"} {
				if v, _ := get(k); jsjson.Truthy(v) {
					out.Set(k, v)
				}
			}
		}
		servers.Set(name, out)
	}
	servers.Set("stam", jsjson.NewObject("command", e.Bin, "args", []jsjson.Value{"mcp"}))
	return jsjson.NewObject("mcpServers", servers)
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

// systemPrompt is system-prompt.md: the system-prompt template for the agent's type with every slot filled.
func (e Env) systemPrompt(ctx context.Context, a db.Agent, p Parts) (string, error) {
	t := e.Templates
	typ := deref(a.Type)
	instructions, err := t.InstructionsPrompt(ctx, "claude", a.Cwd)
	if err != nil {
		return "", err
	}
	retro, err := t.Render("retro", nil, typ)
	if err != nil {
		return "", err
	}
	humanMail, err := t.HumanMailPrompt(a.Model, typ)
	if err != nil {
		return "", err
	}
	role := a.Role
	if role == "" {
		role = "not set"
	}
	return t.Render("system-prompt", map[string]string{
		"id": a.ID, "name": a.Name, "machine": a.Machine, "role": role, "org": p.Org, "instructions": instructions,
		"cost": p.Cost, "retro": retro, "lessons": p.Lessons, "workspace": p.Workspace, "itsa": p.Itsa,
		"requirements": p.Requirements, "human_mail": humanMail,
	}, typ)
}

// userStatusLine is the user's own statusline command from ~/.claude/settings.json, which stam's statusline forwards
// to after reporting to the daemon; "" when there is none.
func userStatusLine(userHome string) string {
	b, err := os.ReadFile(filepath.Join(userHome, ".claude", "settings.json"))
	if err != nil {
		return ""
	}
	var s struct {
		StatusLine struct {
			Type    any `json:"type"`
			Command any `json:"command"`
		} `json:"statusLine"`
	}
	if json.Unmarshal(b, &s) != nil || s.StatusLine.Type != "command" {
		return ""
	}
	c, _ := s.StatusLine.Command.(string)
	return c
}

// PluginDir is a Claude Code plugin holding stam's own skills (Claude Code already has the user's), rebuilt on every
// launch in STAM_HOME/claude-plugin; "" when stam has none (src/instructions.ts claudePluginDir).
func PluginDir(home, userHome string) (string, error) {
	own := ownSkills(home, userHome)
	if len(own) == 0 {
		return "", nil
	}
	dir := filepath.Join(home, "claude-plugin")
	if err := os.RemoveAll(dir); err != nil {
		return "", err
	}
	for _, d := range []string{filepath.Join(dir, ".claude-plugin"), filepath.Join(dir, "skills")} {
		if err := os.MkdirAll(d, 0o777); err != nil {
			return "", err
		}
	}
	manifest := jsjson.NewObject("name", "stam-skills", "description", "Skills managed by stam", "version", "1.0.0")
	if err := os.WriteFile(filepath.Join(dir, ".claude-plugin", "plugin.json"), []byte(jsjson.Stringify(manifest, "  ")), 0o666); err != nil {
		return "", err
	}
	for _, s := range own {
		if err := os.Symlink(s.path, filepath.Join(dir, "skills", s.name)); err != nil {
			return "", err
		}
	}
	return dir, nil
}

type skill struct{ name, path string }

// ownSkills is src/instructions.ts skillFolders filtered to stam's: the skill folders (holding SKILL.md) of
// ~/.claude/skills, then of STAM_HOME/skills, where a stam skill replaces a user skill of the same name in its place
// (as the TS Map does), keeping only stam's.
func ownSkills(home, userHome string) []skill {
	byName := map[string]string{}
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
			byName[n] = src.source
		}
	}
	var out []skill
	for _, n := range order {
		if byName[n] == "stam" {
			out = append(out, skill{n, filepath.Join(home, "skills", n)})
		}
	}
	return out
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

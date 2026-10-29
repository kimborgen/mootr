// Package opencode is the OpenCode adapter (src/adapters/opencode.ts, S-4237). stam runs its own OpenCode server, one
// for every OpenCode agent, and each agent is a TUI attached to it.
//
// Ported so far: the config the server reads (WriteConfig: opencode.json with the provider blocks and MCP servers, the
// plugin, the skills), each session's permission rules, and the error classes of a failed turn. Not yet: the server,
// its event stream, launch, prompts, stop, asks and the agent view.
package opencode

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"stam/internal/adapters"
	"stam/internal/config"
	"stam/internal/jsjson"
)

// Env is what the config reads.
type Env struct {
	// Home is STAM_HOME, which holds the server's config folder (ConfigDir).
	Home string
	// UserHome is $HOME: ~/.claude/skills, and the default homes whose secrets are denied.
	UserHome string
	// Root is the checkout or release the plugin's source is copied from (src/config.ts ROOT).
	Root string
	// Bin is stam's own command (src/config.ts STAM_BIN), which the MCP servers run.
	Bin      string
	Settings config.Settings
	// Registry is src/registry.ts registry (config.Registry): the models and prices the provider blocks list.
	Registry *jsjson.Object
	// Getenv reads the daemon's environment, where a provider's key variable is looked up first.
	Getenv func(string) string
}

// ConfigDir is the server's OPENCODE_CONFIG_DIR, STAM_HOME/opencode.
func ConfigDir(home string) string { return filepath.Join(home, "opencode") }

// PluginSource is the plugin's source under root, copied into the config folder as it is.
func PluginSource(root string) string {
	return filepath.Join(root, "src", "adapters", "opencode-plugin", "index.ts")
}

// WriteConfig is src/adapters/opencode.ts writeConfig, rewritten on every daemon start (OpenCode reloads it): the
// plugin, opencode.json, and the skills linked into the config folder. A key never lands in opencode.json: a provider
// block names its key's variable, which only the server's environment holds (Providers).
func WriteConfig(e Env) error {
	dir := ConfigDir(e.Home)
	if err := os.MkdirAll(filepath.Join(dir, "plugins", "stam"), 0o777); err != nil {
		return err
	}
	if err := copyFile(PluginSource(e.Root), filepath.Join(dir, "plugins", "stam", "index.ts")); err != nil {
		return err
	}
	blocks := Providers(e).Blocks
	servers, err := McpServers(e.Settings, e.Bin)
	if err != nil {
		return err
	}
	cfg := jsjson.NewObject("$schema", "https://opencode.ai/config.json")
	if blocks.Len() > 0 {
		cfg.Set("provider", blocks)
	}
	cfg.Set("mcp", jsjson.NewObject("servers", servers))
	if err := os.WriteFile(filepath.Join(dir, "opencode.json"), []byte(jsjson.Stringify(cfg, "  ")), 0o666); err != nil {
		return err
	}
	return LinkSkills(filepath.Join(dir, "skills"), e.Home, e.UserHome)
}

// copyFile is copyFileSync: the source's bytes and mode, over any file already there.
func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	st, err := os.Stat(src)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dst, b, st.Mode().Perm()); err != nil {
		return err
	}
	return os.Chmod(dst, st.Mode().Perm())
}

// McpServers is src/adapters/opencode.ts opencodeMcpServers: settings.mcpServers in OpenCode's format, then stam's own.
// An auth server is reached through stam's proxy, never its url or a header; a remote one's headers pass through. An
// args that TS's spread can't iterate is an error, as TS's writeConfig throws.
func McpServers(s config.Settings, bin string) (*jsjson.Object, error) {
	servers := jsjson.NewObject()
	for _, m := range adapters.McpServers(s.McpServers) {
		o := m.Server
		auth, _ := o.Get("auth")
		url, _ := o.Get("url")
		out := jsjson.NewObject()
		switch {
		case jsjson.Truthy(auth):
			out.Set("type", "local")
			out.Set("command", []jsjson.Value{bin, "mcp-proxy", m.Name})
		case jsjson.Truthy(url):
			out.Set("type", "remote")
			out.Set("url", url)
			if h, _ := o.Get("headers"); jsjson.Truthy(h) {
				out.Set("headers", h)
			}
		default:
			command, _ := o.Get("command")
			argv := []jsjson.Value{command}
			// `[s.command, ...(s.args ?? [])]`: an array's items, a string's characters.
			switch args, _ := o.Get("args"); a := args.(type) {
			case nil:
			case []jsjson.Value:
				argv = append(argv, a...)
			case string:
				for _, r := range a {
					argv = append(argv, string(r))
				}
			default:
				return nil, fmt.Errorf("settings.mcpServers.%s.args is not iterable", m.Name)
			}
			out.Set("type", "local")
			out.Set("command", argv)
			// `environment: s.env`, which JSON.stringify leaves out when s has no env.
			if env, ok := o.Get("env"); ok {
				out.Set("environment", env)
			}
		}
		servers.Set(m.Name, out)
	}
	servers.Set("stam", jsjson.NewObject("type", "local", "command", []jsjson.Value{bin, "mcp"}))
	return servers, nil
}

// LinkSkills is src/instructions.ts linkSkills: every skill linked into a harness's skills folder, replacing the links
// stam made before. Only links into stam's skill folders are removed or replaced; a real file or someone else's link
// stays, and a skill of the same name is then left unlinked. A target that is, or sits inside, a source folder is left
// alone, so stam's skills are never written into one.
func LinkSkills(target, home, userHome string) error {
	if err := os.MkdirAll(target, 0o777); err != nil {
		return err
	}
	sources := []string{filepath.Join(userHome, ".claude", "skills"), filepath.Join(home, "skills")}
	t := realOrResolved(target)
	for _, d := range sources {
		if rd := realOrResolved(d); t == rd || strings.HasPrefix(t, rd+string(filepath.Separator)) {
			return nil
		}
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if p := filepath.Join(target, e.Name()); ourLink(p, sources) {
			if err := os.Remove(p); err != nil {
				return err
			}
		}
	}
	for _, s := range adapters.SkillFolders(home, userHome) {
		p := filepath.Join(target, s.Name)
		if _, err := os.Stat(p); err == nil {
			continue
		}
		if fi, err := os.Lstat(p); err == nil && fi.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if err := os.Symlink(s.Path, p); err != nil {
			return err
		}
	}
	return nil
}

// ourLink is src/instructions.ts isOurLink: a symlink stam made, pointing straight at SOURCE/NAME under its own name.
func ourLink(p string, sources []string) bool {
	fi, err := os.Lstat(p)
	if err != nil || fi.Mode()&os.ModeSymlink == 0 {
		return false
	}
	to, err := os.Readlink(p)
	if err != nil {
		return false
	}
	for _, d := range sources {
		if to == filepath.Join(d, filepath.Base(p)) {
			return true
		}
	}
	return false
}

// realOrResolved is src/instructions.ts real: the real path, else the absolute one.
func realOrResolved(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		if r, err := filepath.Abs(r); err == nil {
			return r
		}
	}
	r, _ := filepath.Abs(p)
	return r
}

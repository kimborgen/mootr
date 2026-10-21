package claude

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"stam/internal/api"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/templates"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

// tsAgent is the agent as ts-launch.mjs takes it.
type tsAgent struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	Role              string  `json:"role"`
	Machine           string  `json:"machine"`
	Model             *string `json:"model"`
	Effort            *string `json:"effort"`
	Cwd               string  `json:"cwd"`
	SessionID         *string `json:"session_id"`
	Type              *string `json:"type"`
	PermissionMode    string  `json:"permission_mode"`
	PersonalWorkspace *string `json:"personal_workspace"`
}

func (a tsAgent) dbAgent() db.Agent {
	return db.Agent{ID: a.ID, Name: a.Name, Role: a.Role, Machine: a.Machine, Harness: "claude", Model: a.Model, Effort: a.Effort,
		Cwd: a.Cwd, SessionID: a.SessionID, Type: a.Type, PermissionMode: api.AgentPermissionMode(a.PermissionMode), PersonalWorkspace: a.PersonalWorkspace}
}

type tsFile struct {
	Text string      `json:"text"`
	Mode os.FileMode `json:"mode"`
}

type tsLaunch struct {
	Spec struct {
		Argv []string          `json:"argv"`
		Env  map[string]string `json:"env"`
	} `json:"spec"`
	Files    map[string]tsFile `json:"files"`
	DirModes struct {
		Agents os.FileMode `json:"agents"`
		Agent  os.FileMode `json:"agent"`
	} `json:"dirModes"`
	Plugin *struct {
		Manifest string             `json:"manifest"`
		Skills   map[string]*string `json:"skills"`
	} `json:"plugin"`
	Bin   string `json:"bin"`
	Parts struct {
		Org          string   `json:"org"`
		Cost         string   `json:"cost"`
		Lessons      string   `json:"lessons"`
		Workspace    string   `json:"workspace"`
		Itsa         string   `json:"itsa"`
		Requirements string   `json:"requirements"`
		Granted      []string `json:"granted"`
	} `json:"parts"`
}

type scenario struct {
	name     string
	agent    tsAgent
	grants   []string
	resume   bool
	settings string
	registry string
	// userSettings is the user's ~/.claude/settings.json, "" for none.
	userSettings string
	stamSkills   []string
	userSkills   []string
}

func str(s string) *string { return &s }

const richSettings = `{
  "humanMail": {"when": "everything"},
  "mcpServers": {
    "zeta": {"command": "zeta-mcp", "args": ["--x", "<&>"], "env": {"B": "2", "A": "1", "10": "ten", "2": "two"}},
    "10": {"url": "https://example.test/mcp", "headers": {"X-Key": "header-value"}},
    "authy": {"url": "https://example.test/auth", "auth": {"type": "gh"}, "headers": {"H": "v"}},
    "off": {"command": "never", "enabled": false},
    "on": {"command": "on-mcp", "enabled": true, "args": [], "env": {}},
    "nullcmd": {"command": null},
    "bare": {},
    "weird": "not an object",
    "nothing": null,
    "stam": {"command": "user-stam"},
    "emptyurl": {"url": "", "command": "fallback", "args": ["a"]},
    "nums": {"command": "n", "args": [1, 1.5, 1e21, -0, 1e-7], "env": {"S": "line\nnext \"q\""}}
  }
}`

// TestLaunchMatchesTS launches agents with TS's adapter and with Go's, in the same test home, and wants every file
// (bytes and mode), the launch argv and env, the agent folder modes and the plugin folder to match.
func TestLaunchMatchesTS(t *testing.T) {
	for _, sc := range []scenario{
		{
			name: "developer",
			agent: tsAgent{ID: "a1dev", Name: "dev-one", Role: "developer", Machine: "test-machine", Model: str("claude-haiku-5-5"), Effort: str("high"),
				SessionID: str("11111111-2222-3333-4444-555555555555"), Type: str("developer"), PermissionMode: "bypass"},
			grants:       []string{"/srv/shared-b", "/srv/shared-a"},
			resume:       true,
			settings:     richSettings,
			registry:     `{"types": {"developer": {"blocks": {"off": ["shared-machine"], "order": ["mail-conventions"]}}}}`,
			userSettings: `{"statusLine": {"type": "command", "command": "printf '%s' \"$PWD\""}}`,
			stamSkills:   []string{"skill-b", "skill-a", "both"},
			userSkills:   []string{"both", "user-only"},
		},
		{
			name:  "minimal",
			agent: tsAgent{ID: "a2min", Name: "plain", Machine: "test-machine", SessionID: str("s-2"), PermissionMode: "default"},
		},
		{
			name: "manager",
			agent: tsAgent{ID: "a3mgr", Name: "boss", Role: "manager", Machine: "test-machine", Model: str("claude-opus-5-5"), SessionID: str("s-3"),
				Type: str("manager"), PermissionMode: "auto"},
			settings:     `{"mcpServers": ["first", {"command": "second"}]}`,
			userSettings: `{"statusLine": {"type": "static", "command": "nope"}}`,
		},
	} {
		t.Run(sc.name, func(t *testing.T) { runScenario(t, sc) })
	}
}

func runScenario(t *testing.T, sc scenario) {
	base := t.TempDir()
	home, userHome := filepath.Join(base, "home"), filepath.Join(base, "user")
	testTmp := filepath.Join(base, "test-tmp")
	cwd := filepath.Join(base, "work", sc.name)
	t.Setenv("GIT_CEILING_DIRECTORIES", base)
	write(t, filepath.Join(cwd, "AGENTS.md"), "x\n")
	write(t, filepath.Join(cwd, "sub", "CLAUDE.md"), "x\n")
	write(t, filepath.Join(home, "instructions.md"), "All agents: be brief.\n")
	if sc.settings != "" {
		write(t, filepath.Join(home, "settings.json"), sc.settings)
	}
	if sc.registry != "" {
		write(t, filepath.Join(home, "registry.json"), sc.registry)
	}
	if sc.userSettings != "" {
		write(t, filepath.Join(userHome, ".claude", "settings.json"), sc.userSettings)
	}
	for _, s := range sc.stamSkills {
		write(t, filepath.Join(home, "skills", s, "SKILL.md"), "---\ndescription: d\n---\n")
	}
	for _, s := range sc.userSkills {
		write(t, filepath.Join(userHome, ".claude", "skills", s, "SKILL.md"), "---\ndescription: d\n---\n")
	}
	if sc.agent.PersonalWorkspace == nil && sc.name == "developer" {
		sc.agent.PersonalWorkspace = str(filepath.Join(base, "personal"))
	}
	sc.agent.Cwd = cwd
	claudeBin := filepath.Join(base, "bin", "fake-claude")

	// TS first: it makes the home's stam.db, then writes the agent's files.
	in, _ := json.Marshal(map[string]any{"agent": sc.agent, "grants": sc.grants, "resume": sc.resume})
	cmd := exec.Command("node", "testdata/ts-launch.mjs", home, userHome)
	cmd.Env = append(os.Environ(), "STAM_TEST_TMPDIR="+testTmp, "STAM_CLAUDE_BIN="+claudeBin)
	cmd.Stdin = strings.NewReader(string(in))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ts-launch.mjs: %v\n%s", err, stderr.String())
	}
	var ts tsLaunch
	if err := json.Unmarshal(out, &ts); err != nil {
		t.Fatalf("ts-launch.mjs output: %v", err)
	}
	// Go's launch writes the same paths: clear TS's files first, so each is made afresh, with its mode on create.
	agentDir := filepath.Join(home, "agents", sc.agent.ID)
	for name := range ts.Files {
		if err := os.Remove(filepath.Join(agentDir, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.RemoveAll(filepath.Join(home, "claude-plugin")); err != nil {
		t.Fatal(err)
	}
	settingsBytes, _ := os.ReadFile(filepath.Join(home, "settings.json"))
	s, err := config.ParseSettings(settingsBytes, "test-machine")
	if err != nil {
		t.Fatal(err)
	}
	env := Env{
		Home: home, UserHome: userHome, Bin: ts.Bin, ClaudeBin: claudeBin,
		TestTmpBase: TestTmpBase(func(k string) string { return map[string]string{"STAM_TEST_TMPDIR": testTmp}[k] }, userHome),
		UID:         os.Getuid(), Settings: s,
		Templates: &templates.Set{Root: repoRoot(t), Home: home, UserHome: userHome, Settings: func() config.Settings { return s }},
	}
	parts := Parts{Org: ts.Parts.Org, Cost: ts.Parts.Cost, Lessons: ts.Parts.Lessons, Workspace: ts.Parts.Workspace, Itsa: ts.Parts.Itsa,
		Requirements: ts.Parts.Requirements, Granted: ts.Parts.Granted}
	if sc.grants != nil && len(parts.Granted) != len(sc.grants) {
		t.Fatalf("TS granted %v, want the fixture's %v", parts.Granted, sc.grants)
	}
	spec, err := Launch(context.Background(), env, sc.agent.dbAgent(), sc.resume, parts)
	if err != nil {
		t.Fatal(err)
	}

	if !reflect.DeepEqual(spec.Argv, ts.Spec.Argv) {
		t.Errorf("argv:\n  go %q\n  ts %q", spec.Argv, ts.Spec.Argv)
	}
	goEnv := map[string]string{}
	for _, v := range spec.Env {
		goEnv[v.Key] = v.Value
	}
	if len(goEnv) != len(ts.Spec.Env) || (len(goEnv) > 0 && !reflect.DeepEqual(goEnv, ts.Spec.Env)) {
		t.Errorf("env:\n  go %q\n  ts %q", goEnv, ts.Spec.Env)
	}
	entries, err := os.ReadDir(agentDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(ts.Files) {
		t.Errorf("Go wrote %d files, TS %d", len(entries), len(ts.Files))
	}
	for name, want := range ts.Files {
		p := filepath.Join(agentDir, name)
		got, err := os.ReadFile(p)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if string(got) != want.Text {
			t.Errorf("%s differs:\n--- go\n%s\n--- ts\n%s", name, got, want.Text)
		}
		info, _ := os.Stat(p)
		if info.Mode().Perm() != want.Mode {
			t.Errorf("%s mode: go %o, ts %o", name, info.Mode().Perm(), want.Mode)
		}
	}
	for _, d := range []struct {
		path string
		want os.FileMode
	}{{filepath.Join(home, "agents"), ts.DirModes.Agents}, {agentDir, ts.DirModes.Agent}} {
		if info, err := os.Stat(d.path); err != nil || info.Mode().Perm() != d.want {
			t.Errorf("%s mode: go %v, ts %o", d.path, info.Mode().Perm(), d.want)
		}
	}
	pluginDir := filepath.Join(home, "claude-plugin")
	if ts.Plugin == nil {
		if _, err := os.Stat(pluginDir); err == nil {
			t.Error("Go made a plugin folder, TS none")
		}
	} else {
		manifest, err := os.ReadFile(filepath.Join(pluginDir, ".claude-plugin", "plugin.json"))
		if err != nil || string(manifest) != ts.Plugin.Manifest {
			t.Errorf("plugin.json: go %q (%v), ts %q", manifest, err, ts.Plugin.Manifest)
		}
		skills, _ := os.ReadDir(filepath.Join(pluginDir, "skills"))
		got := map[string]*string{}
		for _, e := range skills {
			l, err := os.Readlink(filepath.Join(pluginDir, "skills", e.Name()))
			if err == nil {
				got[e.Name()] = &l
			} else {
				got[e.Name()] = nil
			}
		}
		if !reflect.DeepEqual(got, ts.Plugin.Skills) {
			t.Errorf("plugin skills: go %v, ts %v", got, ts.Plugin.Skills)
		}
	}
}

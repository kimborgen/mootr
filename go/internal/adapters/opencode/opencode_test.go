package opencode

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"stam/internal/config"
	"stam/internal/jsjson"
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

// tsConfig is ts-config.mjs's output.
type tsConfig struct {
	Bin         string          `json:"bin"`
	Permissions [][]Permission  `json:"permissions"`
	Classify    []*string       `json:"classify"`
	Mcp         json.RawMessage `json:"mcp"`
	McpError    string          `json:"mcpError"`
	Providers   struct {
		Blocks     json.RawMessage   `json:"blocks"`
		Env        map[string]string `json:"env"`
		Collisions []string          `json:"collisions"`
	} `json:"providers"`
	WriteError string  `json:"writeError"`
	Files      tsFiles `json:"files"`
}

// tsFiles is the config folder: nil for a file or folder that isn't there.
type tsFiles struct {
	Config     *string                   `json:"config"`
	Plugin     *string                   `json:"plugin"`
	PluginMode os.FileMode               `json:"pluginMode"`
	Skills     map[string]map[string]any `json:"skills"`
}

type scenario struct {
	name     string
	settings string
	registry string
	secrets  string
	// stale makes the skills folder hold what an earlier start left: a link stam made to a skill since removed, a link
	// someone else made, and a real file named as a skill.
	stale bool
	// linkedHome runs with STAM_HOME a symlink to the real home.
	linkedHome bool
}

const providerSettings = `{
  "providers": {
    "zeta": {"kind": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "apiKey": {"env": "TEST_OC_ZETA_KEY"}},
    "local": {"kind": "openai-compatible", "baseUrl": "  http://127.0.0.1:11434/v1//  "},
    "openrouter": {"kind": "openai-compatible", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": {"env": "TEST_OC_ZETA_KEY"}},
    "az-res": {"kind": "azure", "endpoint": "https://MyRes.openai.azure.com/openai/", "apiVersion": "2024-10-21", "deployment": "gpt-dep", "apiKey": {"secret": "az-key"}},
    "az-v1": {"kind": "azure", "endpoint": "https://gw.example.com/openai/v1/", "apiVersion": "2024-10-21", "apiKey": {"env": "TEST_OC_UNSET"}},
    "az-base": {"kind": "azure", "endpoint": "https://gw.example.com/", "apiVersion": "v1", "deployment": "known"},
    "rock": {"kind": "bedrock", "region": "eu-west-1", "profile": "dev", "endpoint": "https://Bedrock.Example.com:443", "apiKey": {"secret": "rock-key"}},
    "bad-rock": {"kind": "bedrock", "region": "EU WEST"},
    "-dash": {"kind": "openai-compatible", "baseUrl": "https://x.example.com"},
    "my-az": {"kind": "openai-compatible", "baseUrl": "https://a.example.com", "apiKey": {"env": "TEST_OC_ZETA_KEY"}},
    "my_az": {"kind": "openai-compatible", "baseUrl": "https://b.example.com", "apiKey": {"env": "TEST_OC_ZETA_KEY"}},
    "none": {"kind": "anthropic"},
    "7": {"kind": "openai-compatible", "baseUrl": "https://seven.example.com"}
  },
  "mcpServers": {
    "linear": {"url": "https://mcp.linear.app/sse", "headers": {"x-team": "a"}},
    "gh": {"auth": {"type": "oauth"}, "url": "https://gh.example.com/mcp"},
    "plain": {"command": "node", "args": ["srv.js", "--flag"], "env": {"A": "1"}},
    "bare": {"command": "bare-mcp"},
    "chars": {"command": "x", "args": "ab"},
    "off": {"command": "nope", "enabled": false},
    "nullish": null
  }
}`

const providerRegistry = `{
  "models": {
    "zeta/gpt-a": {"name": "GPT A", "harnesses": ["opencode", "codex"]},
    "zeta/gpt-b": {"harnesses": ["codex"]},
    "zeta/gpt-c": {"name": ""},
    "zeta/gpt-d": {"harnesses": "claude,opencode"},
    "az-res/gpt-dep": {"name": "Dep"},
    "az-base/known": {},
    "rock/claude-x": {"name": "X"},
    "zetaish/other": {"name": "not zeta's"}
  },
  "prices": {
    "zeta/gpt-a": {"input": 2.5, "output": 10, "cacheRead": 0.25},
    "zeta/gpt-c": {"input": 1, "output": "9"},
    "rock/claude-x": {"input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75}
  }
}`

const providerSecrets = `{"secrets": {"az-key": {"value": "az-secret-value", "slot": "stam"}, "rock-key": {"value": "rock-secret-value", "env": "TEST_OC_ROCK_OVERRIDE"}}, "imported": []}`

func TestConfigMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	t.Setenv("TEST_OC_ZETA_KEY", "zeta-env-value")
	for _, sc := range []scenario{
		{name: "providers", settings: providerSettings, registry: providerRegistry, secrets: providerSecrets, stale: true},
		{name: "linked-home", settings: `{"mcpServers": [{"command": "arr"}]}`, linkedHome: true},
		{name: "empty"},
		{name: "args-not-iterable", settings: `{"mcpServers": {"n": {"command": "x", "args": 5}}}`},
		{name: "registry-throws", settings: providerSettings, registry: `{"models": {"zeta/gpt-a": {"harnesses": 5}}}`, secrets: providerSecrets},
	} {
		t.Run(sc.name, func(t *testing.T) { runScenario(t, sc) })
	}
}

func runScenario(t *testing.T, sc scenario) {
	base := t.TempDir()
	realHome, userHome := filepath.Join(base, "home"), filepath.Join(base, "user")
	if err := os.MkdirAll(realHome, 0o700); err != nil {
		t.Fatal(err)
	}
	home := realHome
	if sc.linkedHome {
		home = filepath.Join(base, "home-link")
		if err := os.Symlink(realHome, home); err != nil {
			t.Fatal(err)
		}
	}
	if sc.settings != "" {
		write(t, filepath.Join(realHome, "settings.json"), sc.settings)
	}
	if sc.registry != "" {
		write(t, filepath.Join(realHome, "registry.json"), sc.registry)
	}
	if sc.secrets != "" {
		write(t, filepath.Join(realHome, "secrets.json"), sc.secrets)
	}
	write(t, filepath.Join(userHome, ".claude", "skills", "mine", "SKILL.md"), "---\ndescription: d\n---\n")
	write(t, filepath.Join(userHome, ".claude", "skills", "both", "SKILL.md"), "---\ndescription: d\n---\n")
	write(t, filepath.Join(realHome, "skills", "both", "SKILL.md"), "---\ndescription: d\n---\n")
	write(t, filepath.Join(realHome, "skills", "ours", "SKILL.md"), "---\ndescription: d\n---\n")
	write(t, filepath.Join(realHome, "skills", "nofile", "README.md"), "x\n")
	work := filepath.Join(base, "work", "agent")
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	workLink := filepath.Join(base, "work-link")
	if err := os.Symlink(work, workLink); err != nil {
		t.Fatal(err)
	}
	skillsDir := filepath.Join(home, "opencode", "skills")
	stale := func() {
		if !sc.stale {
			return
		}
		if err := os.MkdirAll(skillsDir, 0o700); err != nil {
			t.Fatal(err)
		}
		_ = os.Remove(filepath.Join(skillsDir, "gone"))
		_ = os.Remove(filepath.Join(skillsDir, "theirs"))
		if err := os.Symlink(filepath.Join(home, "skills", "gone"), filepath.Join(skillsDir, "gone")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("/elsewhere/theirs", filepath.Join(skillsDir, "theirs")); err != nil {
			t.Fatal(err)
		}
		write(t, filepath.Join(skillsDir, "mine"), "a real file\n")
	}
	stale()

	type permCase struct {
		Mode string `json:"mode"`
		Cwd  string `json:"cwd"`
	}
	perms := []permCase{{"bypass", work}, {"default", workLink}, {"auto", work}, {"bypass", ""}}
	classify := []string{
		`{"type": "session.execution.failed", "data": {"error": {"type": "provider.quota", "status": 500}}}`,
		`{"type": "session.execution.failed", "data": {"error": {"type": "other", "status": 429}}}`,
		`{"type": "session.execution.failed", "data": {"error": {"type": ["provider.auth"]}}}`,
		`{"type": "session.execution.failed", "data": {"error": null}, "error": {"status": 503}}`,
		`{"type": "session.execution.failed", "data": {"error": {"status": 404}}}`,
		`{"type": "session.execution.failed", "data": {"error": {"status": "429"}}}`,
		`{"type": "session.execution.failed", "data": {"error": {"status": 408}}}`,
		`{"type": "session.execution.failed", "data": {}}`,
		`{"type": "session.execution.failed", "data": {"error": "boom"}}`,
		`{"type": "session.execution.succeeded", "data": {"error": {"type": "provider.quota"}}}`,
	}
	events := make([]json.RawMessage, len(classify))
	for i, c := range classify {
		events[i] = json.RawMessage(c)
	}
	in, _ := json.Marshal(map[string]any{"permissions": perms, "classify": events})
	cmd := exec.Command("node", "testdata/ts-config.mjs", home, userHome)
	cmd.Stdin = strings.NewReader(string(in))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ts-config.mjs: %v\n%s", err, stderr.String())
	}
	var ts tsConfig
	if err := json.Unmarshal(out, &ts); err != nil {
		t.Fatalf("ts-config.mjs output: %v\n%s", err, out)
	}

	settingsBytes, _ := os.ReadFile(filepath.Join(realHome, "settings.json"))
	s, err := config.ParseSettings(settingsBytes, "test-machine")
	if err != nil {
		t.Fatal(err)
	}
	e := Env{Home: home, UserHome: userHome, Root: repoRoot(t), Bin: ts.Bin, Settings: s,
		Registry: config.Registry(repoRoot(t), home, "test-machine"), Getenv: os.Getenv}

	for i, c := range perms {
		got := SessionPermissions(c.Mode, c.Cwd, home, userHome)
		if !reflect.DeepEqual(got, ts.Permissions[i]) {
			t.Errorf("permissions %s %q:\n  go %v\n  ts %v", c.Mode, c.Cwd, got, ts.Permissions[i])
		}
	}
	for i, c := range classify {
		v, err := jsjson.Parse([]byte(c))
		if err != nil {
			t.Fatal(err)
		}
		want := ""
		if ts.Classify[i] != nil {
			want = *ts.Classify[i]
		}
		if got := ClassifyError(v); got != want {
			t.Errorf("classify %s: go %q, ts %q", c, got, want)
		}
	}

	mcp, err := McpServers(s, ts.Bin)
	switch {
	case ts.McpError != "":
		if err == nil {
			t.Errorf("mcp: TS throws %q, Go gives %s", ts.McpError, jsjson.Stringify(mcp, ""))
		}
	case err != nil:
		t.Errorf("mcp: %v", err)
	default:
		sameJSON(t, "mcp", jsjson.Stringify(mcp, ""), string(ts.Mcp))
	}

	p := Providers(e)
	sameJSON(t, "provider blocks", jsjson.Stringify(p.Blocks, ""), string(ts.Providers.Blocks))
	goEnv := map[string]string{}
	for _, v := range p.Env {
		goEnv[v.Key] = v.Value
	}
	if len(goEnv) != len(ts.Providers.Env) || (len(goEnv) > 0 && !reflect.DeepEqual(goEnv, ts.Providers.Env)) {
		t.Errorf("provider env:\n  go %q\n  ts %q", goEnv, ts.Providers.Env)
	}
	if !reflect.DeepEqual(p.Collisions, ts.Providers.Collisions) && (len(p.Collisions) > 0 || len(ts.Providers.Collisions) > 0) {
		t.Errorf("collisions: go %q, ts %q", p.Collisions, ts.Providers.Collisions)
	}

	// Go's writeConfig over a clean folder, and over what Go left, gives TS's folder; a write that fails leaves the folder
	// as TS's does.
	for _, clean := range []bool{true, false} {
		if clean {
			if err := os.RemoveAll(filepath.Join(home, "opencode")); err != nil {
				t.Fatal(err)
			}
			stale()
		}
		err := WriteConfig(e)
		if (err != nil) != (ts.WriteError != "") {
			t.Errorf("WriteConfig (clean %v): go %v, ts %q", clean, err, ts.WriteError)
		}
		got := readFolder(t, filepath.Join(home, "opencode"))
		if !reflect.DeepEqual(got, ts.Files) {
			t.Errorf("config folder (clean %v):\n  go %+v\n  ts %+v", clean, got, ts.Files)
		}
	}
}

// readFolder is the config folder as ts-config.mjs prints it.
func readFolder(t *testing.T, dir string) tsFiles {
	t.Helper()
	var f tsFiles
	if b, err := os.ReadFile(filepath.Join(dir, "opencode.json")); err == nil {
		s := string(b)
		f.Config = &s
	}
	plugin := filepath.Join(dir, "plugins", "stam", "index.ts")
	if b, err := os.ReadFile(plugin); err == nil {
		s := string(b)
		f.Plugin = &s
		st, err := os.Stat(plugin)
		if err != nil {
			t.Fatal(err)
		}
		f.PluginMode = st.Mode().Perm()
	}
	if entries, err := os.ReadDir(filepath.Join(dir, "skills")); err == nil {
		f.Skills = map[string]map[string]any{}
		for _, en := range entries {
			p := filepath.Join(dir, "skills", en.Name())
			if to, err := os.Readlink(p); err == nil {
				f.Skills[en.Name()] = map[string]any{"link": to}
			} else {
				f.Skills[en.Name()] = map[string]any{"file": true}
			}
		}
	}
	return f
}

// sameJSON compares two JSON texts by value and key order, as their compact jsjson forms.
func sameJSON(t *testing.T, what, got, want string) {
	t.Helper()
	w, err := jsjson.Parse([]byte(want))
	if err != nil {
		t.Fatalf("%s: TS gave %q: %v", what, want, err)
	}
	if ws := jsjson.Stringify(w, ""); got != ws {
		t.Errorf("%s:\n  go %s\n  ts %s", what, got, ws)
	}
}

// A provider's key reaches the server's env alone: never opencode.json (S-2118).
func TestKeysStayOutOfTheConfig(t *testing.T) {
	base := t.TempDir()
	home, userHome := filepath.Join(base, "home"), filepath.Join(base, "user")
	write(t, filepath.Join(home, "secrets.json"), providerSecrets)
	t.Setenv("TEST_OC_ZETA_KEY", "zeta-env-value")
	s, err := config.ParseSettings([]byte(providerSettings), "test-machine")
	if err != nil {
		t.Fatal(err)
	}
	e := Env{Home: home, UserHome: userHome, Root: repoRoot(t), Bin: "/bin/stam", Settings: s, Registry: jsjson.NewObject(), Getenv: os.Getenv}
	if err := WriteConfig(e); err != nil {
		t.Fatal(err)
	}
	cfg, err := os.ReadFile(filepath.Join(ConfigDir(home), "opencode.json"))
	if err != nil {
		t.Fatal(err)
	}
	p := Providers(e)
	want := map[string]string{"STAM_PROVIDER_ZETA_KEY": "zeta-env-value", "STAM_PROVIDER_AZ_RES_KEY": "az-secret-value", "STAM_PROVIDER_ROCK_KEY": "rock-secret-value"}
	for k, v := range want {
		if got, _ := p.Env.Get(k); got != v {
			t.Errorf("env %s = %q, want the key", k, got)
		}
		if strings.Contains(string(cfg), v) {
			t.Errorf("opencode.json holds %s's key", k)
		}
		if !strings.Contains(string(cfg), "{env:"+k+"}") {
			t.Errorf("opencode.json doesn't name %s", k)
		}
	}
	if len(p.Env) != len(want) {
		t.Errorf("env holds %d keys, want %d: %v", len(p.Env), len(want), p.Env)
	}
}

package secrets

import (
	"os"
	"path/filepath"
	"testing"
)

// TestKeyFor: src/secrets.ts keyFor. The key: the environment, then the secret store's value for that variable in the stam slot (first by name), then opencode.env.
func TestKeyFor(t *testing.T) {
	home := t.TempDir()
	env := map[string]string{}
	get := func(k string) string { return env[k] }
	if KeyFor(home, "OPENROUTER_API_KEY", get) != "" {
		t.Error("a key from nothing")
	}
	write := func(name, text string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(home, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("opencode.env", "# c\nOPENROUTER_API_KEY=\"legacy\"\nOTHER=x\nlower=1\n")
	if got := KeyFor(home, "OPENROUTER_API_KEY", get); got != "legacy" {
		t.Errorf("opencode.env: %q", got)
	}
	write("secrets.json", `{"secrets":{"b-key":{"value":"from-b","slot":"stam","env":"OPENROUTER_API_KEY"},"a-agent":{"value":"agent","slot":"agent","env":"OPENROUTER_API_KEY"},"a-key":{"value":"from-a","provider":"openrouter","env":"OPENROUTER_API_KEY"},"BAD NAME":{"value":"x","env":"OPENROUTER_API_KEY"},"empty":{"value":"","env":"OPENROUTER_API_KEY"}},"imported":["opencode.env"]}`)
	if got := KeyFor(home, "OPENROUTER_API_KEY", get); got != "from-a" {
		t.Errorf("the store, first by name in the stam slot: %q", got)
	}
	env["OPENROUTER_API_KEY"] = "from-env"
	if got := KeyFor(home, "OPENROUTER_API_KEY", get); got != "from-env" {
		t.Errorf("the environment first: %q", got)
	}
	// Once imported, opencode.env's key lines are the store's: a store without the key does not fall back to them.
	delete(env, "OPENROUTER_API_KEY")
	write("secrets.json", `{"secrets":{},"imported":["opencode.env"]}`)
	if got := KeyFor(home, "OPENROUTER_API_KEY", get); got != "" {
		t.Errorf("an imported opencode.env: %q", got)
	}
	// A broken store reads as empty, and the legacy lines serve.
	write("secrets.json", `{not json`)
	if got := KeyFor(home, "OPENROUTER_API_KEY", get); got != "legacy" {
		t.Errorf("a broken store: %q", got)
	}
	// A symlink is not followed.
	real := filepath.Join(t.TempDir(), "real.json")
	if err := os.WriteFile(real, []byte(`{"secrets":{"k":{"value":"linked","env":"OPENROUTER_API_KEY"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(home, "secrets.json"))
	if err := os.Symlink(real, filepath.Join(home, "secrets.json")); err != nil {
		t.Fatal(err)
	}
	if got := KeyFor(home, "OPENROUTER_API_KEY", get); got != "legacy" {
		t.Errorf("a symlinked store: %q", got)
	}
}

// TestGet: src/secrets.ts getSecret. A named secret's value, its variable's from the environment when set.
func TestGet(t *testing.T) {
	home := t.TempDir()
	env := map[string]string{}
	get := func(k string) string { return env[k] }
	if err := os.WriteFile(filepath.Join(home, "secrets.json"), []byte(`{"secrets":{"oai":{"value":"stored","env":"OPENAI_API_KEY"},"plain":{"value":"p"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if Get(home, "oai", get) != "stored" || Get(home, "plain", get) != "p" || Get(home, "none", get) != "" {
		t.Error("the stored values")
	}
	env["OPENAI_API_KEY"] = "from-env"
	if Get(home, "oai", get) != "from-env" {
		t.Error("the environment over the stored value")
	}
}

// TestAgentEnv: src/secrets.ts agentEnv. opencode.env's lines (key lines only until imported), then the agent slot by
// variable (first by name), then the environment over any of them.
func TestAgentEnv(t *testing.T) {
	home := t.TempDir()
	env := map[string]string{}
	get := func(k string) string { return env[k] }
	if got := AgentEnv(home, get); len(got) != 0 {
		t.Errorf("an env from nothing: %v", got)
	}
	write := func(name, text string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(home, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("opencode.env", "OPENROUTER_API_KEY=legacy\nOTHER=x\n")
	write("secrets.json", `{"secrets":{"b-agent":{"value":"from-b","slot":"agent","env":"OPENROUTER_API_KEY"},"a-agent":{"value":"from-a","slot":"agent","env":"OPENROUTER_API_KEY"},"stam-key":{"value":"stam-only","slot":"stam","env":"STAM_ONLY_KEY"},"no-env":{"value":"v","slot":"agent"}},"imported":[]}`)
	want := map[string]string{"OPENROUTER_API_KEY": "from-a", "OTHER": "x"}
	if got := AgentEnv(home, get); !equal(got, want) {
		t.Errorf("store over opencode.env, first name wins, stam slot left out: %v", got)
	}
	write("secrets.json", `{"secrets":{},"imported":["opencode.env"]}`)
	if got := AgentEnv(home, get); !equal(got, map[string]string{"OTHER": "x"}) {
		t.Errorf("an imported opencode.env keeps only its other lines: %v", got)
	}
	env["OTHER"] = "from-env"
	env["UNRELATED"] = "y"
	if got := AgentEnv(home, get); !equal(got, map[string]string{"OTHER": "from-env"}) {
		t.Errorf("the environment over a variable it names, and only those: %v", got)
	}
}

func equal(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

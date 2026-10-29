package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

const (
	importedKey = "sk-imported-abcdefgh-1111"
	setKey      = "sk-set-by-human-ijklmn-2222"
)

// secretCases run in Go and through testdata/secretsref.mjs in TS (src/secrets.ts); each must give the same results
// and leave the same secrets.json, times blanked.
var secretCases = map[string]any{
	"opencodeEnv": "OPENROUTER_API_KEY='" + importedKey + "'\nOPENCODE_MODEL=x\nGH_TOKEN=\nBAD-LINE=1\n",
	"ops": []any{
		map[string]any{"list": true},
		map[string]any{"set": []any{"openai-main", map[string]any{"value": "  " + setKey + " ", "provider": "openai"}}},
		map[string]any{"set": []any{"zeta", map[string]any{"value": "short", "slot": "agent", "env": "ZETA_KEY"}}},
		map[string]any{"set": []any{"alpha", map[string]any{"value": "a-key-long-enough"}}},
		map[string]any{"set": []any{"zeta", map[string]any{"value": "short2", "env": nil}}},
		map[string]any{"set": []any{"Bad..Name", map[string]any{"value": "x"}}},
		map[string]any{"set": []any{"ok", map[string]any{"value": "   "}}},
		map[string]any{"set": []any{"ok", map[string]any{"value": 5}}},
		map[string]any{"set": []any{"ok", map[string]any{"value": "two\nlines"}}},
		map[string]any{"set": []any{"ok", map[string]any{"value": "has space"}}},
		map[string]any{"set": []any{"ok", map[string]any{"value": "pässword"}}},
		map[string]any{"set": []any{"ok", map[string]any{"value": strings.Repeat("k", 8193)}}},
		map[string]any{"set": []any{"ok", map[string]any{"value": "v", "slot": "other"}}},
		map[string]any{"set": []any{"ok", map[string]any{"value": "v", "env": "lower"}}},
		map[string]any{"set": []any{"ok", map[string]any{"value": "v", "provider": 3}}},
		map[string]any{"set": []any{"ok", []any{1}}},
		map[string]any{"test": []any{"openai-main", false, "401: bad key " + setKey + " or sk-or-v1-0123456789abcdef"}},
		map[string]any{"test": []any{"nobody", true, ""}},
		map[string]any{"remove": "alpha"},
		map[string]any{"remove": "alpha"},
		map[string]any{"list": true},
	},
	"names": []any{
		map[string]any{"mcp": "linear"}, map[string]any{"mcp": "a b"}, map[string]any{"mcp": "a-b"}, map[string]any{"mcp": "--Weird Name!"},
		map[string]any{"mcp": strings.Repeat("long", 20)}, map[string]any{"mcp": "ünï"}, map[string]any{"mcp": ""},
		map[string]any{"env": "OPENROUTER_API_KEY"}, map[string]any{"env": "GH_TOKEN"}, map[string]any{"env": "_KEY"}, map[string]any{"env": "X_SECRET"},
		map[string]any{"scrub": []any{"no key here", "k"}}, map[string]any{"scrub": []any{strings.Repeat("é ", 150), "zz"}},
	},
}

// runSecretCases is secretsref.mjs in Go, on a fresh home.
func runSecretCases(t *testing.T, input map[string]any) map[string]any {
	t.Helper()
	home := t.TempDir()
	if env, _ := input["opencodeEnv"].(string); env != "" {
		if err := os.WriteFile(filepath.Join(home, "opencode.env"), []byte(env), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s := NewSecrets(home, func(string) string { return "" })
	s.Init()
	blank := func(in SecretInfo) any {
		in.SetAt = ""
		if in.Test != nil {
			tc := *in.Test
			tc.At = ""
			in.Test = &tc
		}
		return in
	}
	errOr := func(v any, err error) any {
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return v
	}
	var ops []any
	for _, raw := range input["ops"].([]any) {
		op := raw.(map[string]any)
		switch {
		case op["list"] != nil:
			list, err := s.List()
			out := []any{}
			for _, in := range list {
				out = append(out, blank(in))
			}
			ops = append(ops, errOr(out, err))
		case op["set"] != nil:
			a := op["set"].([]any)
			b, _ := json.Marshal(a[1])
			body, err := jsjson.Parse(b)
			if err != nil {
				t.Fatal(err)
			}
			in, err := s.Set(a[0].(string), body)
			ops = append(ops, errOr(blank(in), err))
		case op["remove"] != nil:
			ok, err := s.Remove(op["remove"].(string))
			ops = append(ops, errOr(ok, err))
		case op["test"] != nil:
			a := op["test"].([]any)
			ops = append(ops, errOr(nil, s.RecordTest(a[0].(string), a[1].(bool), a[2].(string))))
		}
	}
	var names []any
	for _, raw := range input["names"].([]any) {
		n := raw.(map[string]any)
		switch {
		case n["mcp"] != nil:
			if name, ok := McpClientSecretName(n["mcp"].(string)); ok {
				names = append(names, name)
			} else {
				names = append(names, nil)
			}
		case n["env"] != nil:
			names = append(names, NameForEnv(n["env"].(string)))
		default:
			a := n["scrub"].([]any)
			names = append(names, Scrub(a[0].(string), a[1].(string)))
		}
	}
	file, _ := os.ReadFile(filepath.Join(home, "secrets.json"))
	blanked := regexp.MustCompile(`"(setAt|at)": "[^"]*"`).ReplaceAllString(string(file), `"$1": ""`)
	return map[string]any{"ops": ops, "names": names, "file": blanked}
}

// TestSecretsMatchTS: the store's validation, messages, info, import, names, scrub and file match src/secrets.ts, run by
// testdata/secretsref.mjs.
func TestSecretsMatchTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	arg, _ := json.Marshal(secretCases)
	cmd := exec.Command("node", "--no-warnings", "testdata/secretsref.mjs", string(arg))
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("secretsref.mjs: %v", err)
	}
	var want any
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	gotJSON, _ := json.Marshal(runSecretCases(t, secretCases))
	var got any
	if err := json.Unmarshal(gotJSON, &got); err != nil {
		t.Fatal(err)
	}
	g, w := got.(map[string]any), want.(map[string]any)
	for _, k := range []string{"ops", "names", "file"} {
		gj, _ := json.MarshalIndent(g[k], "", " ")
		wj, _ := json.MarshalIndent(w[k], "", " ")
		if string(gj) != string(wj) {
			t.Errorf("%s differ:\nGo: %s\nTS: %s", k, gj, wj)
		}
	}
}

// TestSecretsNeverRender: a value never shows in an info, an error, or fmt of the store's types.
func TestSecretsNeverRender(t *testing.T) {
	out := fmt.Sprintf("%v %+v %#v", runSecretCases(t, secretCases)["ops"], NewSecrets("x", nil), secretEntry{Value: setKey})
	if strings.Contains(out, setKey) || strings.Contains(out, importedKey) || strings.Contains(out, setKey[:len(setKey)-5]) {
		t.Errorf("a value rendered: %s", out)
	}
}

// TestSecretsFile: secrets.json is written mode 600, a looser one is narrowed, and every problem other than a missing
// file (a symlink, a directory, bad JSON, no read permission) refuses writes and lists, which leave it as it is, while
// Get reads it as empty.
func TestSecretsFile(t *testing.T) {
	home := t.TempDir()
	s := NewSecrets(home, func(string) string { return "" })
	file := filepath.Join(home, "secrets.json")
	if list, err := s.List(); err != nil || len(list) != 0 {
		t.Fatalf("a missing file: %v %v", list, err)
	}
	body := jsjson.NewObject("value", setKey)
	if _, err := s.Set("a", body); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(file); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode: %v %v", info, err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.Chmod(file, 0o644))
	if v, ok := s.Get("a"); !ok || v.Reveal() != setKey {
		t.Fatalf("after chmod 644: %v", ok)
	}
	if info, _ := os.Stat(file); info.Mode().Perm() != 0o600 {
		t.Errorf("a 644 file wasn't narrowed: %v", info.Mode())
	}
	other := filepath.Join(home, "other.json")
	data, _ := os.ReadFile(file)
	must(os.WriteFile(other, data, 0o600))
	breakWith := map[string]func(){
		"a symlink":   func() { must(os.Remove(file)); must(os.Symlink(other, file)) },
		"a directory": func() { must(os.Remove(file)); must(os.Mkdir(file, 0o700)) },
		"bad JSON":    func() { must(os.RemoveAll(file)); must(os.WriteFile(file, []byte("{nope"), 0o600)) },
	}
	if os.Getuid() != 0 {
		breakWith["no read permission"] = func() { must(os.RemoveAll(file)); must(os.WriteFile(file, data, 0o200)) }
	}
	for name, breakIt := range breakWith {
		breakIt()
		var se *SecretError
		if _, err := s.List(); !errors.As(err, &se) || !se.File {
			t.Errorf("%s: List %v", name, err)
		}
		if _, err := s.Set("b", body); !errors.As(err, &se) || !se.File || strings.Contains(err.Error(), setKey) {
			t.Errorf("%s: Set %v", name, err)
		}
		if _, err := s.Remove("a"); !errors.As(err, &se) || !se.File {
			t.Errorf("%s: Remove %v", name, err)
		}
		if _, _, _, err := s.Stored("a"); !errors.As(err, &se) || !se.File {
			t.Errorf("%s: Stored %v", name, err)
		}
		if _, ok := s.Get("a"); ok {
			t.Errorf("%s: Get read a value", name)
		}
	}
	if got, _ := os.ReadFile(other); string(got) != string(data) {
		t.Errorf("the symlink's target changed")
	}
}

// TestSecretsImportOnce: opencode.env's keys import once; a secret the human deletes isn't brought back, and the
// environment overrides a secret that stands for its variable.
func TestSecretsImportOnce(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "opencode.env"), []byte("OPENROUTER_API_KEY="+importedKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{}
	s := NewSecrets(home, func(k string) string { return env[k] })
	s.Init()
	if v, ok := s.Get("openrouter-agent"); !ok || v.Reveal() != importedKey {
		t.Fatalf("not imported: %v", ok)
	}
	if ok, err := s.Remove("openrouter"); !ok || err != nil {
		t.Fatal(ok, err)
	}
	s.Init()
	if _, ok := s.Get("openrouter"); ok {
		t.Errorf("a deleted import came back")
	}
	env["OPENROUTER_API_KEY"] = "from-env"
	if v, _ := s.Get("openrouter-agent"); v.Reveal() != "from-env" {
		t.Errorf("the environment didn't override")
	}
	list, _ := s.List()
	if len(list) != 1 || list[0].OverriddenBy == nil || *list[0].OverriddenBy != "env" {
		t.Errorf("list: %+v", list)
	}
}

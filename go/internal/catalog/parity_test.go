package catalog

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// runTS runs testdata/catref.mjs on input and returns what it prints.
func runTS(t *testing.T, input any) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	in, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", "--no-warnings", "testdata/catref.mjs")
	cmd.Stdin = bytes.NewReader(in)
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("catref.mjs: %v", err)
	}
	return string(out)
}

// same fails with each Go and TS result side by side when the lists differ.
func same(t *testing.T, labels []string, goOut []jsjson.Value, tsOut string) {
	t.Helper()
	got := jsjson.Stringify(goOut, "")
	if got == tsOut {
		return
	}
	var w []json.RawMessage
	if err := json.Unmarshal([]byte(tsOut), &w); err != nil || len(w) != len(goOut) {
		t.Fatalf("Go and TS differ:\n go %s\n ts %s", got, tsOut)
	}
	for i, g := range goOut {
		if gs := jsjson.Stringify(g, ""); gs != string(w[i]) {
			t.Errorf("%s:\n go %s\n ts %s", labels[i], gs, w[i])
		}
	}
}

// TestTinyModelsMatchTS: src/tiny-models.ts tinyModels and src/settings.ts permissionModesOf over settings files that
// set, blank, mistype and leave out each key they read.
func TestTinyModelsMatchTS(t *testing.T) {
	texts := []string{
		`{}`,
		`{"decisions":{"mailCheck":false,"mailGate":false,"suggestRescore":true,"model":"x/decide"},"mail":{"titles":{"model":"  m/title  "}},"instructions":{"summaries":{"model":"m/sum"}}}`,
		`{"tiny":{"toolSummary":{"enabled":true,"model":"  ","instructions":"  "},"toolNames":{"enabled":false,"model":"n/m"},"mailTitles":{"titleInstructions":"Own title.","summaryInstructions":" "},"blockSummaries":{"instructions":"Own block."}}}`,
		`{"tiny":{"toolSummary":{"enabled":"yes","model":5,"instructions":"Mine"},"toolNames":{"enabled":0}},"activity":{"classify":{"enabled":true,"maxUsdPerDay":-1,"concurrency":3.7}}}`,
		`{"tiny":"bad","mail":[],"activity":{"classify":{"maxUsdPerDay":0.5,"concurrency":0}},"decisions":{"mailCheck":"no"}}`,
		`{"permissionModes":{"harness":{"codex":"bypass","zed":"default","claude":"nope","7":"auto"},"types":{"reviewer":"bypass","b":"inherit","2":"default","a":"auto"}}}`,
		`{"permissionModes":{"harness":[],"types":"x"}}`,
	}
	var labels []string
	var goOut []jsjson.Value
	for _, text := range texts {
		s, err := config.ParseSettings([]byte(text), "test")
		if err != nil {
			t.Fatal(err)
		}
		labels = append(labels, text)
		goOut = append(goOut, []jsjson.Value{TinyModels(s), s.PermissionModes.JSON()})
	}
	same(t, labels, goOut, runTS(t, map[string]any{"op": "tiny", "texts": texts}))
}

// TestHarnessModelsMatchTS: src/model-catalog.ts harnessModels over the shipped registry with a user registry that adds
// models with and without names, prices and harness lists.
func TestHarnessModelsMatchTS(t *testing.T) {
	reg := map[string]any{
		"models": map[string]any{
			"own-any":     map[string]any{"name": "Own any"},
			"own-codex":   map[string]any{"harnesses": []string{"codex"}, "name": ""},
			"own-str":     map[string]any{"harnesses": "opencode,claude"},
			"own-empty":   map[string]any{"harnesses": []string{}},
			"own-unnamed": map[string]any{"name": 5},
		},
		"prices": map[string]any{"own-any": map[string]any{"input": 1.5, "output": 3}, "own-codex": map[string]any{"input": 0}},
	}
	home := t.TempDir()
	b, _ := json.Marshal(reg)
	if err := os.WriteFile(filepath.Join(home, "registry.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	root, _ := filepath.Abs("../../..")
	registry := config.Registry(root, home, "test")
	harnesses := []string{"", "claude", "codex", "opencode", "nope"}
	var goOut []jsjson.Value
	for _, h := range harnesses {
		goOut = append(goOut, HarnessModels(registry, h))
	}
	same(t, harnesses, goOut, runTS(t, map[string]any{"op": "harness", "registry": reg, "harnesses": harnesses}))
}

// TestOpenRouterMatchesTS: src/llm/openrouter.ts listModels against a loopback fake that answers each call with the
// next of a list of bodies: prices as strings, numbers and junk, entries without an id, a body that isn't JSON, and
// error statuses.
func TestOpenRouterMatchesTS(t *testing.T) {
	answers := []struct {
		status int
		body   string
	}{
		{200, `{"data":[{"id":"a/b","name":"A B","pricing":{"prompt":"0.0000015","completion":"0.000002"}},{"id":"c","pricing":{"prompt":"","completion":"-1"}},{"name":"no id"},{"id":5},{"id":"d","name":"","pricing":{"prompt":0.0000001234567,"completion":" 0.5 "}},{"id":"e","pricing":{"prompt":"0x10","completion":true}},{"id":"f","pricing":null}]}`},
		{200, `not json`},
		{200, `{"data":{"id":"x"}}`},
		{503, `{}`},
		{302, ``},
	}
	var paths []string
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path+" "+r.Header.Get("accept"))
		a := answers[n%len(answers)]
		n++
		if a.status == 302 {
			w.Header().Set("location", "http://127.0.0.1:1/")
		}
		w.WriteHeader(a.status)
		_, _ = w.Write([]byte(a.body))
	}))
	defer srv.Close()
	o := NewOpenRouter(func() string { return srv.URL })
	var labels []string
	var goOut []jsjson.Value
	for i := range answers {
		m, err := o.fetch(context.Background())
		labels = append(labels, answers[i].body)
		if err != nil {
			goOut = append(goOut, jsjson.NewObject("error", err.Error()))
		} else {
			goOut = append(goOut, m)
		}
	}
	goPaths := append([]string(nil), paths...)
	paths, n = nil, 0
	same(t, labels, goOut, runTS(t, map[string]any{"op": "openrouter", "base": srv.URL, "calls": len(answers)}))
	if strings.Join(goPaths, "\n") != strings.Join(paths, "\n") {
		t.Errorf("requests: go %q, ts %q", goPaths, paths)
	}
}

// TestOnboardingMatchesTS: src/onboarding.ts onboardingStatus over a fixture home with some harness logins, API key
// variables, a Mac, repos that exist or not (one derived through a symlink), and with and without a chief of staff.
func TestOnboardingMatchesTS(t *testing.T) {
	home := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(home, ".codex"), 0o700))
	must(os.WriteFile(filepath.Join(home, ".codex", "auth.json"), []byte(`{}`), 0o600))
	xdg := filepath.Join(home, "xdg")
	must(os.MkdirAll(filepath.Join(xdg, "opencode"), 0o700))
	must(os.WriteFile(filepath.Join(xdg, "opencode", "auth.json"), []byte(`{}`), 0o600))
	repo := filepath.Join(home, "repo")
	must(os.MkdirAll(repo, 0o700))
	must(os.Symlink(repo, filepath.Join(home, "repo-link")))
	v := func(s string) *string { return &s }
	cos := "cos"
	type in struct {
		versions map[string]*string
		env      map[string]string
		platform string
		repos    []Repo
		derived  map[string]string
		cos      *string
		local    bool
	}
	cases := []in{
		{versions: map[string]*string{"claude": nil, "opencode": nil, "codex": nil}, env: map[string]string{}, platform: "linux"},
		{versions: map[string]*string{"claude": v("2.1.0 (Claude Code)"), "opencode": v(""), "codex": v("codex 0.9")}, env: map[string]string{"XDG_DATA_HOME": xdg}, platform: "linux",
			repos: []Repo{{"mine", repo}, {"gone", filepath.Join(home, "gone")}, {"self", filepath.Join(home, "repo-link")}}, derived: map[string]string{"self": repo}, cos: &cos, local: true},
		{versions: map[string]*string{"claude": v("2"), "opencode": nil, "codex": nil}, env: map[string]string{"CLAUDE_CONFIG_DIR": filepath.Join(home, "nope")}, platform: "darwin",
			repos: []Repo{{"self", repo}}, derived: map[string]string{"self": filepath.Join(home, "repo-link")}},
		{versions: map[string]*string{"claude": v("2"), "opencode": v("1"), "codex": v("1")}, env: map[string]string{"ANTHROPIC_API_KEY": "k", "CODEX_HOME": filepath.Join(home, "none")}, platform: "linux", cos: &cos},
	}
	var labels []string
	var goOut []jsjson.Value
	var tsIn []any
	for i, c := range cases {
		env := c.env
		goOut = append(goOut, Onboarding(OnboardingInput{Versions: c.versions, Providers: "unknown", LocalHuman: c.local, Repos: c.repos, DerivedRepos: c.derived,
			Cos: c.cos, Home: home, Getenv: func(k string) string { return env[k] }, Platform: c.platform}))
		labels = append(labels, string(rune('a'+i)))
		versions := jsjson.NewObject()
		for _, h := range Harnesses {
			var x jsjson.Value
			if p := c.versions[h]; p != nil {
				x = *p
			}
			versions.Set(h, x)
		}
		repos := jsjson.NewObject()
		for _, r := range c.repos {
			repos.Set(r.Name, r.Path)
		}
		var cosV jsjson.Value
		if c.cos != nil {
			cosV = *c.cos
		}
		derived := jsjson.NewObject()
		for k, p := range c.derived {
			derived.Set(k, p)
		}
		envO := jsjson.NewObject()
		for k, x := range c.env {
			envO.Set(k, x)
		}
		tsIn = append(tsIn, json.RawMessage(jsjson.Stringify(jsjson.NewObject("versions", versions, "providers", "unknown", "localHuman", c.local, "repos", repos,
			"derivedRepos", derived, "cos", cosV, "home", home, "env", envO, "platform", c.platform), "")))
	}
	same(t, labels, goOut, runTS(t, map[string]any{"op": "onboarding", "inputs": tsIn}))
}

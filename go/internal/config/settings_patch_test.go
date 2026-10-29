package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"stam/internal/jsjson"
)

const patchRegistry = `{"presets":{"cheap":{"harness":"opencode","model":"openrouter/x"}},"harnesses":{"codex":{}}}`

// patchCases are the settings write cases run through Go and src/settings.ts: a patch over a file, a redaction, and a
// whole file's check.
var patchCases = []string{
	`{"patch":{"current":"{\"a\":1,\"boardViews\":{\"v1\":{\"m\":1},\"v2\":{\"m\":2}},\"z\":true}\n","patch":{"a":2,"boardViews":{"v2":null,"v3":{"m":3}},"n":{"x":[1,2]}},"fill":false}}`,
	`{"patch":{"current":"{\"a\":1,\"boardViews\":{\"v1\":{\"m\":1}}}","patch":{"a":2,"boardViews":{"v1":{"m":9},"v4":{"m":4}},"workViews":{"w":{}}},"fill":true}}`,
	`{"patch":{"current":"{\"boardViews\":[{\"m\":0}]}","patch":{"boardViews":{"x":1},"workViews":"nope"},"fill":false}}`,
	`{"patch":{"current":"{\"retro\":{\"lastDigest\":\"2026-10-01\",\"digest\":{\"enabled\":true}},\"resourceWarn\":{\"enabled\":true}}","patch":{"retro":{"digest":{"enabled":false},"lastDigest":"x"},"resourceWarn":{"enabled":false,"lastWarned":{"cpu":1}}},"fill":false}}`,
	`{"patch":{"current":"not json","patch":{"a":1},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"fallbackMinutes":0}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"softStopMinutes":-1}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"instructions":5}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"display":{"mode":"weekly"}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"display":{"prices":{"max":-2}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"display":[]}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude","model":3}}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude"},"provider":""}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude"}},"b":{"match":{"harness":"claude","model":"x"}}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude"},"onError":"explode"}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude"},"onSubExhausted":"continue"}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude"},"onSubExhausted":{"action":"take-over","to":["b"]}},"b":{"match":{"harness":"codex"},"onSubExhausted":{"action":"take-over","to":["a"]}}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude"},"onSubExhausted":{"action":"take-over","to":["cheap"]}},"o":{"match":{"harness":"opencode","model":"openrouter/"},"paid":true,"onBudgetExhausted":"continue"}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude"},"onSubExhausted":{"action":"take-over","to":["nobody"]}}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude"},"onSubExhausted":{"action":"take-over","to":["a"]}}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude"},"onSubExhausted":{"action":"wait","else":"later"}}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude"},"onSubExhausted":{"to":"x"}}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude"},"onSubExhausted":{"action":"wait","to":[1]}}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"accounts":{"a":{"match":{"harness":"claude"},"onSubExhausted":7}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"onError":{"action":"take-over","to":["codex"]},"accounts":{"a":{"match":{"harness":"codex"}}}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"global":{"onExhausted":"nap"}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"cost":{"global":{"subscriptionWork":"maybe"}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"requirements":{"keyPrefix":"R1"}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"requirements":{"keyPrefix":""}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"harness":{"gemini":{}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"harness":{"claude":{"promptCacheTtl":"2h"}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"harness":{"claude":{"autoCompactWindow":99999.5}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"harness":{"claude":{"nope":1}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"harness":{"codex":{"model_auto_compact_token_limit":null},"claude":{"idleCompaction":true,"autoCompactWindow":200000}}},"fill":false}}`,
	`{"patch":{"current":"{}","patch":{"harness":"x"},"fill":false}}`,
	`{"redact":"{\"peers\":[{\"name\":\"p\",\"token\":\"T1\",\"peerToken\":\"T2\"}],\"apiKey\":null,\"x\":{\"password\":0,\"remote-secret\":{\"url\":\"u\",\"authorization\":\"B\"}}}"}`,
	`{"redact":"{\"mcpServers\":{\"s\":{\"command\":\"c\",\"env\":{\"K\":\"V\",\"N\":{\"deep\":1}},\"headers\":[\"h\"],\"auth\":{\"client_secret\":{\"secret\":\"mcp-s.client\"}}},\"t\":{\"auth\":{\"client_secret\":\"PLAIN\"}},\"u\":{\"auth\":{\"client_secret\":{\"secret\":\"Not A Name\"}}}}}"}`,
	`{"redact":"{\"providers\":{\"az\":{\"kind\":\"azure\",\"apiKey\":{\"env\":\"AZ_KEY\",\"secret\":\"az-key\"}},\"bad\":{\"apiKey\":{\"secret\":\"../etc\"}},\"plain\":{\"apiKey\":\"sk-1\"}}}"}`,
	`{"redact":"{not json"}`,
	`{"redact":"[{\"token\":\"t\"},\"x\"]"}`,
	`{"file":"{\"cost\":{\"accounts\":{\"a\":{}}}}"}`,
	`{"file":"{\"harness\":{\"claude\":{\"promptCacheTtl\":1}}}"}`,
	`{"file":"{\"requirements\":{\"keyPrefix\":\"9\"}}"}`,
	`{"file":"5"}`,
}

// goPatchCase is one case's Go result, printed as JSON.stringify prints the TS one.
func goPatchCase(t *testing.T, raw string, registry *jsjson.Object) string {
	t.Helper()
	v, err := jsjson.Parse([]byte(raw))
	if err != nil {
		t.Fatalf("case %s: %v", raw, err)
	}
	c := v.(*jsjson.Object)
	if p, ok := c.Get("patch"); ok {
		cur, _ := obj(p).Get("current")
		patch, _ := obj(p).Get("patch")
		fill, _ := obj(p).Get("fill")
		text, problem := Patched(cur.(string), obj(patch), fill == true, registry)
		if problem != nil {
			return jsjson.Stringify(jsjson.NewObject("problem", problem.Problem, "field", problem.Field), "")
		}
		return jsjson.Stringify(jsjson.NewObject("text", text), "")
	}
	if r, ok := c.Get("redact"); ok {
		return jsjson.Stringify(RedactText(r.(string)), "")
	}
	f, _ := c.Get("file")
	user, err := jsjson.Parse([]byte(f.(string)))
	if err != nil {
		t.Fatalf("case %s: %v", raw, err)
	}
	if p := FileProblem(user, registry); p != nil {
		return jsjson.Stringify(jsjson.NewObject("problem", p.Problem, "field", p.Field), "")
	}
	return "null"
}

// TestPatchedMatchesTS runs every case through src/settings.ts (testdata/patchref.mjs) and the Go port, and wants the
// same text, problem or redaction from both.
func TestPatchedMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "registry.json"), []byte(patchRegistry), 0o600); err != nil {
		t.Fatal(err)
	}
	registry := Registry("../../..", home, "test")
	cmd := exec.Command("node", "--no-warnings", "testdata/patchref.mjs", "["+strings.Join(patchCases, ",")+"]", patchRegistry)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("patchref.mjs: %v\n%s", err, stderr.String())
	}
	out, err := jsjson.Parse(stdout.Bytes())
	if err != nil {
		t.Fatalf("patchref.mjs output %q: %v", stdout.String(), err)
	}
	want := out.([]jsjson.Value)
	if len(want) != len(patchCases) {
		t.Fatalf("patchref.mjs gave %d results for %d cases", len(want), len(patchCases))
	}
	for i, c := range patchCases {
		if got, w := goPatchCase(t, c, registry), jsjson.Stringify(want[i], ""); got != w {
			t.Errorf("case %d %s:\n go %s\n ts %s", i, c, got, w)
		}
	}
}

// TestRedactKeepsNoSecret: no value of a credential reaches the redacted text.
func TestRedactKeepsNoSecret(t *testing.T) {
	text := `{"peers":[{"name":"p","token":"SECRET-1","peerToken":"SECRET-2"}],"mcpServers":{"s":{"env":{"K":"SECRET-3"},"headers":{"Authorization":"SECRET-4"}}},"providers":{"x":{"apiKey":"SECRET-5"}}}`
	got := RedactText(text)
	if strings.Contains(got, "SECRET") {
		t.Errorf("a secret survived redaction: %s", got)
	}
}

// TestUpdateConcurrent: writers sent at once each add their own key, and every key is in the file at the end (one
// read-modify-write at a time); the file is 0600 and no temp file is left.
func TestUpdateConcurrent(t *testing.T) {
	home := t.TempDir()
	f := NewSettingsFile(home, "m")
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			err := f.Update(func(cur string) (string, error) {
				user := ParseObject(cur)
				user.Set(fmt.Sprintf("k%d", i), float64(i))
				return Text(user), nil
			})
			if err != nil {
				t.Error(err)
			}
			f.Get()
		}(i)
	}
	wg.Wait()
	text, err := f.Text()
	if err != nil {
		t.Fatal(err)
	}
	user := ParseObject(text)
	for i := 0; i < 40; i++ {
		if _, ok := user.Get(fmt.Sprintf("k%d", i)); !ok {
			t.Errorf("k%d was lost: %s", i, text)
		}
	}
	info, err := os.Stat(filepath.Join(home, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v, want 0600", info.Mode().Perm())
	}
	entries, _ := os.ReadDir(home)
	if len(entries) != 1 {
		t.Errorf("files left in the home: %v", entries)
	}
}

// TestUpdateRefusedWritesNothing: a change that fails leaves the file as it was, and Get keeps reading it.
func TestUpdateRefusedWritesNothing(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "settings.json")
	before := "{\n  \"chiefOfStaff\": \"cos\"\n}\n"
	if err := os.WriteFile(path, []byte(before), 0o600); err != nil {
		t.Fatal(err)
	}
	f := NewSettingsFile(home, "m")
	err := f.Update(func(cur string) (string, error) {
		_, p := Patched(cur, jsjson.NewObject("cost", jsjson.NewObject("fallbackMinutes", -1.0)), false, jsjson.NewObject())
		return "", p
	})
	var p *Problem
	if !errors.As(err, &p) || p.Field != "cost" {
		t.Fatalf("Update = %v, want the cost problem", err)
	}
	if b, _ := os.ReadFile(path); string(b) != before {
		t.Errorf("the file changed: %s", b)
	}
	if got := f.Get().ChiefOfStaff; got != "cos" {
		t.Errorf("ChiefOfStaff = %q", got)
	}
}

// TestUpdateSeenByGet: a write is read by the next Get even when size and mtime don't move.
func TestUpdateSeenByGet(t *testing.T) {
	home := t.TempDir()
	f := NewSettingsFile(home, "m")
	for _, name := range []string{"aaa", "bbb"} {
		if err := f.SetShared("chiefOfStaff", name); err != nil {
			t.Fatal(err)
		}
		if got := f.Get().ChiefOfStaff; got != name {
			t.Errorf("ChiefOfStaff = %q, want %q", got, name)
		}
	}
}

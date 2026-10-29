package config

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// sharedCases run in Go and through testdata/sharedref.mjs in TS; each must give the same result.
var sharedCases = []string{
	`{"parts":{"home":"a","peers":[1],"context":{"warnTokens":5},"itsa":{"home":"a","keyPrefix":"S"},"debug":{"stallMs":9},"retro":{"lastDigest":"x","steward":{"enabled":false}}}}`,
	`{"parts":{"itsa":{"repos":{"p":"/p"}},"resourceWarn":{"lastWarned":{"cpu":1},"enabled":true},"auth":{"humanStrict":true,"localHuman":null}}}`,
	`{"parts":{"itsa":"not an object","debug":null,"files":{"roots":[]}}}`,
	`{"parts":[1,2]}`,
	`{"split":[{"mail":{"titles":{"model":"m2"}}},false,{"mail":{"titles":{"model":"m1"}}}]}`,
	`{"split":[{"mail":{"titles":{"model":"m1"}}},false,{"mail":{"titles":{"model":"m1"}}}]}`,
	`{"split":[{"debug":{"stallMs":250},"itsa":{"repos":{"p2":"/p2"}}},false,{"debug":{},"itsa":{"keyPrefix":"H"}}]}`,
	`{"split":[{"itsa":{"keyPrefix":"P","repos":{"p3":"/p3"}}},false,{"itsa":{"keyPrefix":"H"}}]}`,
	`{"split":[{"itsa":{"keyPrefix":"H","repos":{"p3":"/p3"}}},false,{"itsa":{"keyPrefix":"H"}}]}`,
	`{"split":[{"boardViews":{"v1":{"name":"browser copy"}},"mail":{"titles":{"model":"ignored"}}},true,{"boardViews":{"v1":{"name":"one"}}}]}`,
	`{"split":[{"boardViews":{"v2":{"name":"two"}},"workViews":{}},true,{"boardViews":{"v1":{"name":"one"}}}]}`,
	`{"split":[{"chiefOfStaff":"x"},false,null]}`,
	`{"split":[{"resourceWarn":{"enabled":false,"lastWarned":{"cpu":123}}},false,{"resourceWarn":{"enabled":false}}]}`,
	`{"withLocal":["{\"mail\":{\"titles\":{\"model\":\"m\"}},\"itsa\":{\"keyPrefix\":\"H\"}}",{"itsa":{"repos":{"a":"/a"}},"debug":{"stallMs":3},"mail":{"x":1}}]}`,
	`{"withLocal":["not json",{"home":"h"}]}`,
	`{"withLocal":["{\"itsa\":\"flat\"}",{"itsa":{"home":"h"}}]}`,
	`{"unredact":[{"peers":[{"name":"p","token":"[redacted]"}],"debug":{"stallMs":1}},"{\"peers\":[{\"name\":\"p\",\"token\":\"T\"}]}"]}`,
	`{"unredact":[{"mcpServers":{"s":{"command":"other","env":{"K":"[redacted]"}}}},"{\"mcpServers\":{\"s\":{\"command\":\"c\",\"env\":{\"K\":\"V\"}}}}"]}`,
	`{"unredact":[{"x":{"token":"[redacted]"}},"{}"]}`,
	`{"payload":{"settings":"{\"home\":\"h\",\"peers\":[{\"name\":\"p\",\"token\":\"T\"}],\"mail\":{\"titles\":{\"model\":\"m1\"}},\"itsa\":{\"repos\":{\"h\":\"/h\"},\"keyPrefix\":\"H\"},\"n\":1.5e3}","registry":"{\"types\":{\"x\":{\"role\":\"r\"}}}","instructions":"Be brief.\n","templates":{"type-x.md":"X","type-y_z.md":"Y","other.md":"no","type-bad.txt":"no"}}}`,
	`{"payload":{"settings":null,"registry":"[1]","instructions":null,"templates":null}}`,
	`{"payload":{"settings":"","registry":"not json","instructions":"","templates":{}}}`,
	`{"payload":{"settings":"{ not json","registry":null,"instructions":null,"templates":null}}`,
}

// goSharedCase is a case's result from the Go port, as JSON.
func goSharedCase(t *testing.T, raw string) string {
	t.Helper()
	v, err := jsjson.Parse([]byte(raw))
	if err != nil {
		t.Fatalf("case %s: %v", raw, err)
	}
	c := v.(*jsjson.Object)
	if p, ok := c.Get("parts"); ok {
		return jsjson.Stringify([]jsjson.Value{LocalPart(p), SharedPart(p)}, "")
	}
	if s, ok := c.Get("split"); ok {
		a := s.([]jsjson.Value)
		local, shared := SplitPatch(a[0].(*jsjson.Object), a[1] == true, obj(a[2]))
		return jsjson.Stringify(jsjson.NewObject("local", local, "shared", shared), "")
	}
	if w, ok := c.Get("withLocal"); ok {
		a := w.([]jsjson.Value)
		return jsjson.Stringify(WithLocalKeys(a[0].(string), a[1].(*jsjson.Object)), "")
	}
	if u, ok := c.Get("unredact"); ok {
		a := u.([]jsjson.Value)
		out, err := UnredactedChange(Change{Kind: "patch", Patch: a[0].(*jsjson.Object)}, a[1].(string))
		if err != nil {
			return jsjson.Stringify(jsjson.NewObject("error", err.Error()), "")
		}
		return jsjson.Stringify(jsjson.NewObject("value", out), "")
	}
	p, _ := c.Get("payload")
	home := t.TempDir()
	put := func(name string, v jsjson.Value) {
		if s, ok := v.(string); ok {
			if err := os.WriteFile(filepath.Join(home, name), []byte(s), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	reg, _ := obj(p).Get("registry")
	ins, _ := obj(p).Get("instructions")
	put("registry.json", reg)
	put("instructions.md", ins)
	if tpl, _ := obj(p).Get("templates"); obj(tpl) != nil {
		if err := os.Mkdir(filepath.Join(home, "templates"), 0o700); err != nil {
			t.Fatal(err)
		}
		for _, k := range obj(tpl).Keys() {
			x, _ := obj(tpl).Get(k)
			put(filepath.Join("templates", k), x)
		}
	}
	text, _ := obj(p).Get("settings")
	str, _ := text.(string)
	if p := SharedPayload(home, str); p != nil {
		return jsjson.Stringify(p, "")
	}
	return "null"
}

// TestSharedMatchesTS: the split of a peer's change, the local and shared parts, the local keys written into a text,
// the unredacted change and the home's payload (its rev included) are TS's, byte for byte: src/settings.ts,
// src/permissions.ts and src/settings-sync.ts, run by testdata/sharedref.mjs.
func TestSharedMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	cmd := exec.Command("node", "--no-warnings", "testdata/sharedref.mjs", "["+strings.Join(sharedCases, ",")+"]")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("sharedref.mjs: %v\n%s", err, stderr.String())
	}
	out, err := jsjson.Parse(stdout.Bytes())
	if err != nil {
		t.Fatalf("sharedref.mjs output %q: %v", stdout.String(), err)
	}
	want := out.([]jsjson.Value)
	if len(want) != len(sharedCases) {
		t.Fatalf("sharedref.mjs gave %d results for %d cases", len(want), len(sharedCases))
	}
	for i, c := range sharedCases {
		if got, w := goSharedCase(t, c), jsjson.Stringify(want[i], ""); got != w {
			t.Errorf("case %d %s:\n go %s\n ts %s", i, c, got, w)
		}
	}
}

// TestDefaultsMatchTS: settings_defaults.json is what testdata/gendefaults.mjs prints now, from src/settings.ts DEFAULTS.
func TestDefaultsMatchTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	cmd := exec.Command("node", "--no-warnings", "testdata/gendefaults.mjs")
	cmd.Env = append(os.Environ(), "STAM_HOME="+t.TempDir(), "STAM_TMUX_SOCKET=defaults-ref", "STAM_MACHINE=test")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("gendefaults.mjs: %v\n%s", err, stderr.String())
	}
	if stdout.String() != string(defaultsJSON) {
		t.Errorf("settings_defaults.json is stale: run node go/internal/config/testdata/gendefaults.mjs > go/internal/config/settings_defaults.json")
	}
}

// peerFile is a non-home daemon's settings: its own file, and the home's cache when cache isn't "".
func peerFile(t *testing.T, own, cache string) *SettingsFile {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "settings.json"), []byte(own), 0o600); err != nil {
		t.Fatal(err)
	}
	if cache != "" {
		if err := os.WriteFile(filepath.Join(home, "settings.shared.json"), []byte(cache), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return NewSettingsFile(home, "peer")
}

// TestPeerReadsTheCache: a non-home daemon reads shared keys from the cache and its local keys from its own file; with
// no cache it reads its file whole; a corrupt cache keeps the last good settings.
func TestPeerReadsTheCache(t *testing.T) {
	own := `{"home":"h","chiefOfStaff":"mine","itsa":{"repos":{"p":"/p"},"keyPrefix":"P"},"peers":[{"name":"h","url":"http://h"}]}`
	f := peerFile(t, own, "")
	if s := f.Get(); s.ChiefOfStaff != "mine" || s.Itsa.KeyPrefix != "P" || f.IsHome() {
		t.Fatalf("no cache: %+v", s)
	}
	if err := f.WriteSharedCache(`{"rev":"r1","settings":{"chiefOfStaff":"theirs","itsa":{"keyPrefix":"H","repos":{"h":"/h"}},"peers":[]}}`); err != nil {
		t.Fatal(err)
	}
	s := f.Get()
	if s.ChiefOfStaff != "theirs" || s.Itsa.KeyPrefix != "H" || s.Itsa.Repos["p"] != "/p" || s.Itsa.Repos["h"] != "" || len(s.Peers) != 1 || s.Home != "h" {
		t.Errorf("with the cache: %+v", s)
	}
	text, err := f.EffectiveText()
	if err != nil || text != "{\n  \"chiefOfStaff\": \"theirs\",\n  \"itsa\": {\n    \"keyPrefix\": \"H\",\n    \"repos\": {\n      \"p\": \"/p\"\n    }\n  },\n  \"home\": \"h\",\n  \"peers\": [\n    {\n      \"name\": \"h\",\n      \"url\": \"http://h\"\n    }\n  ]\n}\n" {
		t.Errorf("effective text: %q %v", text, err)
	}
	if err := os.WriteFile(f.SharedPath(), []byte("{ corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if s := f.Get(); s.ChiefOfStaff != "theirs" {
		t.Errorf("a corrupt cache dropped the last good settings: %+v", s)
	}
	if v := f.View(); jsjson.Stringify(getPathOr(v, "home"), "") != `"h"` {
		t.Errorf("the view's home: %s", jsjson.Stringify(v, ""))
	}
}

// TestSetSettingOnAPeer: a non-home daemon writes the local part of a setting and drops a changed shared part with a
// warning; a caller spreading the current value warns nothing.
func TestSetSettingOnAPeer(t *testing.T) {
	f := peerFile(t, `{"home":"h"}`, `{"rev":"r","settings":{"chiefOfStaff":"c","resourceWarn":{"enabled":false}}}`)
	cur, _ := f.View().Get("resourceWarn")
	value := jsjson.Clone(cur).(*jsjson.Object)
	value.Set("lastWarned", jsjson.NewObject("cpu", 123.0))
	if w, err := f.SetSetting("resourceWarn", value); err != nil || w != "" {
		t.Errorf("bookkeeping: %q %v", w, err)
	}
	if w, err := f.SetSetting("chiefOfStaff", "other"); err != nil || w != "settings: chiefOfStaff is shared and lives on h; not changed here" {
		t.Errorf("a shared key: %q %v", w, err)
	}
	text, _ := f.Text()
	if text != "{\n  \"home\": \"h\",\n  \"resourceWarn\": {\n    \"lastWarned\": {\n      \"cpu\": 123\n    }\n  }\n}\n" {
		t.Errorf("the peer's file: %s", text)
	}
}

// TestOnReload: the reload listeners hear each write here at once, with no read after it, and a hand edit at the next
// read; a read of an unchanged file tells them nothing.
func TestOnReload(t *testing.T) {
	home := t.TempDir()
	f := NewSettingsFile(home, "m")
	var seen []bool
	f.OnReload(func(s Settings) { seen = append(seen, s.Auth.LocalHuman) })
	if _, err := f.SetSetting("auth", jsjson.NewObject("localHuman", true)); err != nil {
		t.Fatal(err)
	}
	if len(seen) == 0 || !seen[len(seen)-1] {
		t.Fatalf("a write wasn't heard: %v", seen)
	}
	n := len(seen)
	f.Get()
	if len(seen) != n {
		t.Errorf("an unchanged read was heard: %v", seen)
	}
	if err := os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{"auth":{"localHuman":false}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if len(seen) != n {
		t.Errorf("a hand edit was heard before a read: %v", seen)
	}
	f.Get()
	if len(seen) != n+1 || seen[n] {
		t.Errorf("a hand edit wasn't heard at the next read: %v", seen)
	}
	// A file caught empty mid-rewrite (truncated, not yet written) is not valid JSON: the last good settings stay,
	// and no hook hears the defaults.
	if err := os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{"auth":{"localHuman":true}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	f.Get()
	n = len(seen)
	if err := os.WriteFile(filepath.Join(home, "settings.json"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if s := f.Get(); !s.Auth.LocalHuman || len(seen) != n {
		t.Errorf("an empty file read as the defaults: localHuman %v, heard %v", s.Auth.LocalHuman, seen[n:])
	}
}

// TestReloadOrder: while a read's hooks run, no later read can return: the reload lock is held from the read of the
// changed file through its hooks.
func TestReloadOrder(t *testing.T) {
	home := t.TempDir()
	f := NewSettingsFile(home, "m")
	f.Get()
	in, release := make(chan struct{}), make(chan struct{})
	f.OnReload(func(Settings) {
		in <- struct{}{}
		<-release
	})
	if err := os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{"auth":{"localHuman":false}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.Get()
	}()
	<-in
	if f.reload.TryLock() {
		f.reload.Unlock()
		t.Error("a read's hooks run with the reload lock free: a later read can see a newer state first")
	}
	close(release)
	<-done
}

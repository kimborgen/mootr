package config

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"stam/internal/jsjson"
)

// migrateCase is one home for `stam settings migrate`: its settings.json (nil for none), settings.shared.json (nil for
// none), an earlier backup (nil for none) and whether to apply.
type migrateCase struct {
	name                    string
	settings, cache, backup *string
	apply                   bool
}

func ptr(s string) *string { return &s }

const migratePeer = `{
  "home": "main",
  "peers": [{"name": "main", "url": "http://main", "token": "PEER-TOKEN"}],
  "itsa": {"home": "main", "keyPrefix": "S"},
  "chiefOfStaff": "cos",
  "boardViews": {"b": {"mode": "status"}, "gone": null},
  "mcpServers": {"gh": {"command": "gh-mcp", "args": ["--token", "ghp_SECRET", "--header", "Authorization: Bearer X", "API_KEY=abc", "--api-key=zzz", "plain"], "env": {"GH": "v"}}},
  "emptyObj": {},
  "list": [1, 2]
}`

const migrateCache = `{"rev": "r1", "settings": {
  "chiefOfStaff": "cos",
  "boardViews": {"b": {"mode": "subtree"}},
  "mcpServers": {"gh": {"command": "gh-mcp", "args": ["--token", "ghp_OTHER"]}},
  "itsa": {"keyPrefix": "S", "statuses": ["todo"]},
  "onlyHome": true
}}`

var migrateCases = []migrateCase{
	{name: "the home", settings: ptr(`{"home": "peer"}`)},
	{name: "no settings", settings: nil},
	{name: "no cache", settings: ptr(`{"home": "main", "chiefOfStaff": "x"}`)},
	{name: "dry run", settings: ptr(migratePeer), cache: ptr(migrateCache)},
	{name: "nothing to remove", settings: ptr(`{"home": "main"}`), cache: ptr(migrateCache), apply: true},
	{name: "apply", settings: ptr(migratePeer), cache: ptr(migrateCache), apply: true},
	{name: "apply over the same backup", settings: ptr(migratePeer), cache: ptr(migrateCache), backup: ptr(migratePeer), apply: true},
	{name: "apply over another backup", settings: ptr(migratePeer), cache: ptr(migrateCache), backup: ptr(`{"old": 1}`), apply: true},
}

// setUp writes a case's files into a fresh home.
func (c migrateCase) setUp(t *testing.T) string {
	home := t.TempDir()
	write := func(name string, s *string) {
		if s != nil {
			if err := os.WriteFile(filepath.Join(home, name), []byte(*s), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	write("settings.json", c.settings)
	write("settings.shared.json", c.cache)
	write("settings.json.pre-S380", c.backup)
	return home
}

var backupStamp = regexp.MustCompile(`pre-S380\.[0-9TZ-]+`)

// outcome is what a run leaves, the home's path and backup times blanked: the code, text, result, settings.json and
// the backups.
func outcome(t *testing.T, home string, code int, text string, result any) string {
	t.Helper()
	files := map[string]string{}
	entries, _ := os.ReadDir(home)
	var names []string
	for _, e := range entries {
		if n := e.Name(); n == "settings.json" || strings.HasPrefix(n, "settings.json.pre-S380") {
			b, _ := os.ReadFile(filepath.Join(home, n))
			files[backupStamp.ReplaceAllString(n, "pre-S380.STAMP")] = string(b)
			names = append(names, n)
		}
	}
	sort.Strings(names)
	r, _ := json.Marshal(result)
	out, _ := json.MarshalIndent(map[string]any{"code": code, "text": text, "result": json.RawMessage(r), "files": files}, "", " ")
	return backupStamp.ReplaceAllString(strings.ReplaceAll(string(out), home, "HOME"), "pre-S380.STAMP")
}

// TestMigrateMatchesTS: `stam settings migrate`'s report, --json result, rewritten file and backups match
// src/settings-migrate.ts (with src/settings.ts), run by testdata/migrateref.mjs on the same files.
func TestMigrateMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	for _, c := range migrateCases {
		t.Run(c.name, func(t *testing.T) {
			tsHome := c.setUp(t)
			arg := ""
			if c.apply {
				arg = "--apply"
			}
			cmd := exec.Command("node", "--no-warnings", "testdata/migrateref.mjs", tsHome, "peer", arg)
			cmd.Stderr = os.Stderr
			raw, err := cmd.Output()
			if err != nil {
				t.Fatalf("migrateref.mjs: %v", err)
			}
			var ts struct {
				Code   int             `json:"code"`
				Text   string          `json:"text"`
				Result json.RawMessage `json:"result"`
			}
			if err := json.Unmarshal(raw, &ts); err != nil {
				t.Fatal(err)
			}
			if ts.Text == "" || (c.apply && c.cache != nil && c.name != "nothing to remove" && !strings.Contains(ts.Text, "removed")) {
				t.Fatalf("TS gave no report: %s", raw)
			}
			var tsResult any
			_ = json.Unmarshal(ts.Result, &tsResult)
			goHome := c.setUp(t)
			code, text, result := Migrate(goHome, "peer", c.apply, time.Now())
			var goResult any
			_ = json.Unmarshal([]byte(jsjson.Stringify(result, "")), &goResult)
			if g, w := outcome(t, goHome, code, text, goResult), outcome(t, tsHome, ts.Code, ts.Text, tsResult); g != w {
				t.Errorf("Go:\n%s\nTS:\n%s", g, w)
			}
		})
	}
}

// TestMigrateRefuses: a settings.json that doesn't parse is refused without quoting it and left as it is.
func TestMigrateRefuses(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{"token": "SECRET-VALUE"`), 0o600); err != nil {
		t.Fatal(err)
	}
	if code, text, _ := Migrate(home, "peer", true, time.Now()); code != 1 || strings.Contains(text, "SECRET") || !strings.Contains(text, "not valid JSON") {
		t.Errorf("bad JSON: %d %s", code, text)
	}
	if out, _ := os.ReadFile(filepath.Join(home, "settings.json")); string(out) != `{"token": "SECRET-VALUE"` {
		t.Errorf("bad JSON was rewritten: %s", out)
	}
}

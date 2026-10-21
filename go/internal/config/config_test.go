package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"stam/internal/jsjson"
)

func home(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	h := filepath.Join(root, "home")
	if err := os.Mkdir(h, 0o700); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(h, "token"), "tok\n", 0o640)
	write(t, filepath.Join(h, "peer-token"), "  peer \n", 0o644)
	return h
}

func write(t *testing.T, path, s string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(s), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func envOf(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestLoad(t *testing.T) {
	h := home(t)
	c, err := Load(envOf(map[string]string{"STAM_HOME": h, "STAM_PORT": "8123", "STAM_BIND": "127.0.0.1, 192.0.2.1,", "STAM_MACHINE": "m1"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Home != h || c.Port != 8123 || c.Machine != "m1" || !reflect.DeepEqual(c.Binds, []string{"127.0.0.1", "192.0.2.1"}) {
		t.Fatalf("config = %+v", c)
	}
	if c.Token.Reveal() != "tok" || c.PeerToken.Reveal() != "peer" {
		t.Fatal("tokens not read and trimmed")
	}
	if c.Live || c.TestHome || c.TestHooks || c.TmuxSocket != "stam" || c.DBPath() != filepath.Join(h, "stam.db") {
		t.Fatalf("config = %+v", c)
	}
}

// TestTokenFilesAreOnlyRead: Load changes neither a token file's bytes nor its mode.
func TestTokenFilesAreOnlyRead(t *testing.T) {
	h := home(t)
	before := map[string]os.FileMode{}
	for _, n := range []string{"token", "peer-token"} {
		info, err := os.Stat(filepath.Join(h, n))
		if err != nil {
			t.Fatal(err)
		}
		before[n] = info.Mode()
	}
	if _, err := Load(envOf(map[string]string{"STAM_HOME": h})); err != nil {
		t.Fatal(err)
	}
	for n, mode := range before {
		info, _ := os.Stat(filepath.Join(h, n))
		if info.Mode() != mode {
			t.Errorf("%s mode %v, was %v", n, info.Mode(), mode)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(h, "token")); string(b) != "tok\n" {
		t.Errorf("token rewritten: %q", b)
	}
}

func TestLoadRefuses(t *testing.T) {
	if _, err := Load(envOf(map[string]string{})); err == nil || !strings.Contains(err.Error(), "STAM_HOME") {
		t.Errorf("an unset STAM_HOME: %v", err)
	}
	h := home(t)
	if _, err := Load(envOf(map[string]string{"STAM_HOME": h, "STAM_PORT": "x"})); err == nil {
		t.Error("a bad port loaded")
	}
	write(t, filepath.Join(h, "token"), " \n", 0o600)
	if _, err := Load(envOf(map[string]string{"STAM_HOME": h})); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Errorf("an empty token: %v", err)
	}
	os.Remove(filepath.Join(h, "token"))
	if _, err := Load(envOf(map[string]string{"STAM_HOME": h})); err == nil || !strings.Contains(err.Error(), "never creates") {
		t.Errorf("a missing token: %v", err)
	}
	if _, err := os.Stat(filepath.Join(h, "token")); err == nil {
		t.Error("Load created the token file")
	}
}

func TestTestHome(t *testing.T) {
	h := home(t)
	env := map[string]string{"STAM_HOME": h, "STAM_TEST_COST_HOOKS": "1", "STAM_TMUX_SOCKET": "stam-test-1", "STAM_TEST_HUMAN_KEY": "k"}
	c, _ := Load(envOf(env))
	if c.TestHome || c.TestHooks || c.TestHumanKey != "" {
		t.Fatalf("no marker: %+v", c)
	}
	write(t, filepath.Join(h, TestHomeMarker), "", 0o600)
	c, _ = Load(envOf(env))
	if c.TestHome {
		t.Fatal("a marker without the owner file is a test home")
	}
	write(t, filepath.Join(filepath.Dir(h), "owner"), "x", 0o600)
	c, _ = Load(envOf(env))
	if !c.TestHome || !c.TestHooks || c.TestHumanKey.Reveal() != "k" {
		t.Fatalf("test home: %+v", c)
	}
	env["STAM_TMUX_SOCKET"] = "stam"
	if c, _ = Load(envOf(env)); c.TestHooks {
		t.Fatal("test hooks on a non-test tmux socket")
	}
	env["STAM_TMUX_SOCKET"], env["STAM_TEST_COST_HOOKS"] = "stam-test-1", "true"
	if c, _ = Load(envOf(env)); c.TestHooks {
		t.Fatal("test hooks with STAM_TEST_COST_HOOKS other than 1")
	}
}

func TestParseSettings(t *testing.T) {
	d, err := ParseSettings(nil, "m1")
	if err != nil {
		t.Fatal(err)
	}
	hm := HumanMailSettings{When: "necessary", Models: map[string]bool{"claude-haiku-5-5": false}}
	itsaDefaults := func(home string, required bool) ItsaSettings {
		return ItsaSettings{Home: home, Required: required, KeyPrefix: "S", Statuses: defaultStatuses, Actions: defaultActions(), Repos: map[string]string{}, MainBranch: "main", PrOpenOrigin: "origin", PrOpenGh: "gh", OwnerNotices: true}
	}
	preset, home := "standard", "~"
	defaults := func(s Settings) Settings {
		s.ChildNotices = "tree-idle"
		s.PermissionModes = PermissionModes{Harness: map[string]string{"claude": "auto", "codex": "auto", "opencode": "auto"}, Types: map[string]string{}}
		s.SpawnDefaults = SpawnDefaults{Preset: &preset, Cwd: &home}
		s.StartingTimeoutMinutes = 10
		s.MailGate = true
		s.DecisionsModel = "microsoft/microsoft-decision-1"
		s.Requirements = RequirementsSettings{Approval: "human", KeyPrefix: "R", DemoteMinFlags: 5, DefaultThreshold: 0.8, DefaultMode: "observe", DailyCapUsd: 1}
		s.StaleWorkingMinutes, s.FinalRoundMinutes, s.RetroReminders = 10, 3, true
		s.DialogEscalateMinutes = 10
		s.Context = ContextSettings{WarnTokens: 300_000, InstructTokens: 400_000, EnforceTokens: 500_000}
		s.IdleCompaction = IdleCompactionSettings{Enabled: true, IdleMinutes: 50, GrowthTokens: 50_000, MinTokens: 100_000}
		s.ExitRecovery = ExitRecoverySettings{PercentOfWindow: 85, WindowTokens: 350_000, RepeatMinutes: 5}
		s.Process = ProcessSettings{Run: "dry-run", MaxSpawnsPerHour: 3}
		return s
	}
	want := defaults(Settings{Home: "m1", Auth: AuthSettings{SharedTokenClaims: true}, Itsa: itsaDefaults("m1", true), CostMode: "api", HumanMail: hm})
	if !reflect.DeepEqual(d, want) {
		t.Fatalf("defaults = %+v", d)
	}
	s, err := ParseSettings([]byte(`{"chiefOfStaff":"cos","auth":{"sharedTokenClaims":false,"humanStrict":true,"localHuman":"yes"},
		"itsa":{"home":"m2","required":false},"cost":{"display":{"mode":"bogus"}}}`), "m1")
	if err != nil {
		t.Fatal(err)
	}
	want = defaults(Settings{Home: "m2", ChiefOfStaff: "cos", Auth: AuthSettings{HumanStrict: true}, Itsa: itsaDefaults("m2", false), CostMode: "api", HumanMail: hm})
	if !reflect.DeepEqual(s, want) {
		t.Fatalf("settings = %+v", s)
	}
	if s, _ := ParseSettings([]byte(`{"home":"h","itsa":{"home":null},"chiefOfStaff":3}`), "m1"); s.Home != "h" || s.Itsa.Home != "h" || s.ChiefOfStaff != "" {
		t.Fatalf("home precedence: %+v", s)
	}
	if s, _ := ParseSettings([]byte(`{"home":"h","itsa":{"home":"m2"}}`), "m1"); s.Home != "h" || s.Itsa.Home != "h" {
		t.Fatalf("home wins over itsa.home (homeOf): %+v", s)
	}
	for in, want := range map[string]ProcessSettings{
		`{"process":{"run":"on","maxSpawnsPerHour":0}}`:         {Run: "on", MaxSpawnsPerHour: 0},
		`{"process":{"run":"off","maxSpawnsPerHour":7}}`:        {Run: "off", MaxSpawnsPerHour: 7},
		`{"process":{"run":"sometimes","maxSpawnsPerHour":-1}}`: {Run: "dry-run", MaxSpawnsPerHour: 3},
		`{"process":{"maxSpawnsPerHour":2.5}}`:                  {Run: "dry-run", MaxSpawnsPerHour: 3},
	} {
		if s, _ := ParseSettings([]byte(in), "m1"); s.Process != want {
			t.Fatalf("%s: process = %+v, want %+v", in, s.Process, want)
		}
	}
	if s, _ := ParseSettings([]byte(`{"itsa":{"ownerNotices":"off"},"requirements":{"enabled":true}}`), "m1"); s.Itsa.OwnerNotices || !s.RequirementsEnabled {
		t.Fatalf("ownerNotices off and requirements on: %+v", s)
	}
	if s, _ := ParseSettings([]byte(`{"itsa":{"ownerNotices":"on"},"requirements":{"enabled":"yes"}}`), "m1"); !s.Itsa.OwnerNotices || s.RequirementsEnabled {
		t.Fatalf("ownerNotices on and requirements not true: %+v", s)
	}
	if s, _ := ParseSettings([]byte(`{"cost":{"display":{"mode":"paid_usd"}}}`), "m1"); s.CostMode != "api" {
		t.Fatalf("paid_usd isn't a display mode: %q", s.CostMode)
	}
	s, _ = ParseSettings([]byte(`{"humanMail":{"when":"important","models":{"m1":false,"m2":"no","claude-haiku-5-5":true}},"mcpServers":{"b":{},"a":{}}}`), "m1")
	if s.HumanMail.When != "important" || s.HumanMail.MayMail("m1") || !s.HumanMail.MayMail("m2") || !s.HumanMail.MayMail("claude-haiku-5-5") || !s.HumanMail.MayMail("") {
		t.Fatalf("humanMail: %+v", s.HumanMail)
	}
	if o, ok := s.McpServers.(*jsjson.Object); !ok || strings.Join(o.Keys(), ",") != "b,a" {
		t.Fatalf("mcpServers keeps the file's order: %#v", s.McpServers)
	}
	for _, doc := range []string{`{"humanMail":{"when":"sometimes"},"mcpServers":null}`, `{"mcpServers":"x"}`} {
		if s, _ := ParseSettings([]byte(doc), "m1"); s.HumanMail.When != "necessary" || s.McpServers != nil {
			t.Fatalf("%s: %+v", doc, s)
		}
	}
	if s, _ := ParseSettings([]byte(`{"mcpServers":[{}]}`), "m1"); s.McpServers == nil {
		t.Fatal("an array of servers is read by index, as Object.entries does")
	}
	s, _ = ParseSettings([]byte(`{"childNotices":"turn","permissionModes":{"harness":{"claude":"bypass","codex":"nope"},"types":{"developer":"default","x":"inherit"}},"spawnDefaults":{"preset":null,"cwd":"/w"}}`), "m1")
	pm := s.PermissionModes
	if s.ChildNotices != "turn" || pm.Harness["codex"] != "auto" || pm.EffectiveMode("claude", "") != "bypass" || pm.EffectiveMode("claude", "developer") != "default" ||
		pm.EffectiveMode("claude", "x") != "bypass" || pm.EffectiveMode("pi", "") != "auto" {
		t.Fatalf("childNotices, permissionModes: %+v", s)
	}
	if s, _ := ParseSettings([]byte(`{"startingTimeoutMinutes":0.5}`), "m1"); s.StartingTimeoutMinutes != 0.5 {
		t.Fatalf("startingTimeoutMinutes: %v", s.StartingTimeoutMinutes)
	}
	if s, _ := ParseSettings([]byte(`{"startingTimeoutMinutes":-1}`), "m1"); s.StartingTimeoutMinutes != 10 {
		t.Fatalf("a non-positive startingTimeoutMinutes keeps the default: %v", s.StartingTimeoutMinutes)
	}
	if s.SpawnDefaults.Preset != nil || s.SpawnDefaults.Cwd == nil || *s.SpawnDefaults.Cwd != "/w" {
		t.Fatalf("spawnDefaults: %+v", s.SpawnDefaults)
	}
}

// decisions.mailGate is on unless the file says false (src/settings.ts).
func TestMailGateSetting(t *testing.T) {
	for _, tc := range []struct {
		json string
		gate bool
	}{{`{}`, true}, {`{"decisions":{"mailGate":false}}`, false}, {`{"decisions":{"mailGate":"no"}}`, true}, {`{"decisions":{"mailGate":null}}`, true}} {
		if s, _ := ParseSettings([]byte(tc.json), "m1"); s.MailGate != tc.gate {
			t.Errorf("%s: MailGate = %v", tc.json, s.MailGate)
		}
	}
}

// itsa.statuses, itsa.actions and itsa.keyPrefix read as src/settings.ts does: a non-empty status list replaces the
// defaults, an action list replaces its status's, and an empty prefix is the default S.
func TestItsaSettings(t *testing.T) {
	s, _ := ParseSettings([]byte(`{"itsa":{"keyPrefix":"TEAM-S","statuses":[{"name":"open","category":"active","human":true},{"name":"fin","category":"closed"},7],
		"actions":{"open":[{"id":"ok","label":"OK","to":"fin","text":"bogus"},{"id":"","label":"x","to":"fin"},{"id":"n","label":"N"}],"needs_input":"no"}}}`), "m1")
	if s.Itsa.KeyPrefix != "TEAM-S" {
		t.Errorf("prefix = %q", s.Itsa.KeyPrefix)
	}
	if want := []ItsaStatus{{"open", "active", true}, {"fin", "closed", false}, {"", "", false}}; !reflect.DeepEqual(s.Itsa.Statuses, want) {
		t.Errorf("statuses = %+v", s.Itsa.Statuses)
	}
	if got := s.Itsa.Actions["open"]; !reflect.DeepEqual(got, []HumanAction{{"ok", "OK", "fin", "optional"}}) {
		t.Errorf("open actions = %+v", got)
	}
	if got := s.Itsa.Actions["needs_input"]; len(got) != 1 || got[0].ID != "answer" {
		t.Errorf("a non-array list kept the default? %+v", got)
	}
	if e, _ := ParseSettings([]byte(`{"itsa":{"keyPrefix":"","statuses":[]}}`), "m1"); e.Itsa.KeyPrefix != "S" || len(e.Itsa.Statuses) != len(defaultStatuses) {
		t.Errorf("empty values: %+v", e.Itsa)
	}
}

func TestSettingsFileRereadsAndKeepsLastGood(t *testing.T) {
	h := home(t)
	f := NewSettingsFile(h, "m1")
	if f.Get().ChiefOfStaff != "" {
		t.Fatal("a missing file isn't the defaults")
	}
	path := filepath.Join(h, "settings.json")
	write(t, path, `{"chiefOfStaff":"a"}`, 0o600)
	if got := f.Get().ChiefOfStaff; got != "a" {
		t.Fatalf("chiefOfStaff = %q, want a", got)
	}
	write(t, path, `{"chiefOfStaff":`, 0o600)
	os.Chtimes(path, time.Now(), time.Now().Add(time.Second))
	if got := f.Get().ChiefOfStaff; got != "a" {
		t.Fatalf("a broken file: chiefOfStaff = %q, want the last good a", got)
	}
	write(t, path, `{"chiefOfStaff":"bb"}`, 0o600)
	os.Chtimes(path, time.Now(), time.Now().Add(2*time.Second))
	if got := f.Get().ChiefOfStaff; got != "bb" {
		t.Fatalf("chiefOfStaff = %q, want bb", got)
	}
}

// settings.peers is the file's list of objects; the tokens are secrets and the peer token wins as the bearer.
func TestSettingsPeers(t *testing.T) {
	s, err := ParseSettings([]byte(`{"peers":[{"name":"a","url":"http://a/","token":"t1","peerToken":"p1","start":"up","deploy":"dp"},{"name":"b","url":"http://b","token":"t2"},"junk",null,7]}`), "m")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Peers) != 2 || s.Peers[0].Name != "a" || s.Peers[0].URL != "http://a/" || s.Peers[0].Start != "up" || s.Peers[0].Deploy != "dp" {
		t.Fatalf("peers = %+v", s.Peers)
	}
	if s.Peers[0].Bearer() != "p1" || s.Peers[1].Bearer() != "t2" {
		t.Errorf("bearers %q %q", s.Peers[0].Bearer(), s.Peers[1].Bearer())
	}
	if out := fmt.Sprintf("%v %+v %#v", s.Peers[0], s.Peers[0], s.Peers[0]); strings.Contains(out, "t1") || strings.Contains(out, "p1") {
		t.Errorf("a peer renders its token: %s", out)
	}
	if b, _ := json.Marshal(s.Peers); strings.Contains(string(b), "t1") || strings.Contains(string(b), "p1") {
		t.Errorf("a peer marshals its token: %s", b)
	}
	if s, _ := ParseSettings([]byte(`{"peers":"x"}`), "m"); len(s.Peers) != 0 {
		t.Error("a peers that is not a list")
	}
}

// TestParseLifecycleSettings: the keys the lifecycle reads, as src/settings.ts parses them: a stale-working limit must
// be positive and a final round may be 0; the reminders are off only on false; the nested objects merge key by key.
func TestParseLifecycleSettings(t *testing.T) {
	s, err := ParseSettings([]byte(`{"staleWorkingMinutes":-1,"dialogEscalateMinutes":0,"archive":{"finalRoundMinutes":0},"retro":{"reminders":{"enabled":false}},
		"context":{"warnTokens":1},"idleCompaction":{"enabled":false},"exitRecovery":{"repeatMinutes":0}}`), "m1")
	if err != nil {
		t.Fatal(err)
	}
	if s.StaleWorkingMinutes != 10 || s.FinalRoundMinutes != 0 || s.RetroReminders {
		t.Errorf("stale %v, final round %v, reminders %v", s.StaleWorkingMinutes, s.FinalRoundMinutes, s.RetroReminders)
	}
	// A dialog may go to the human at once (0); a negative wait is the default.
	if s.DialogEscalateMinutes != 0 {
		t.Errorf("dialog escalate %v, want 0", s.DialogEscalateMinutes)
	}
	if s, _ := ParseSettings([]byte(`{"dialogEscalateMinutes":-1}`), "m1"); s.DialogEscalateMinutes != 10 {
		t.Errorf("dialog escalate %v for -1, want 10", s.DialogEscalateMinutes)
	}
	if s.Context != (ContextSettings{WarnTokens: 1, InstructTokens: 400_000, EnforceTokens: 500_000}) {
		t.Errorf("context = %+v", s.Context)
	}
	if s.IdleCompaction != (IdleCompactionSettings{IdleMinutes: 50, GrowthTokens: 50_000, MinTokens: 100_000}) {
		t.Errorf("idle compaction = %+v", s.IdleCompaction)
	}
	if s.ExitRecovery != (ExitRecoverySettings{PercentOfWindow: 85, WindowTokens: 350_000, RepeatMinutes: 0}) {
		t.Errorf("exit recovery = %+v", s.ExitRecovery)
	}
	s, _ = ParseSettings([]byte(`{"staleWorkingMinutes":0.5,"archive":{"finalRoundMinutes":-2},"retro":{"reminders":{"enabled":0}}}`), "m1")
	if s.StaleWorkingMinutes != 0.5 || s.FinalRoundMinutes != 3 || !s.RetroReminders {
		t.Errorf("stale %v, final round %v, reminders %v", s.StaleWorkingMinutes, s.FinalRoundMinutes, s.RetroReminders)
	}
}

// TestCostAccounts: cost.accounts is read with its matches, paid and provider; the longest model prefix wins, an agent
// no account matches is unmanaged, and accounts that fail a check (no harness, a bad model or provider, two matches
// covering one harness and model) read as none, with the problem named.
func TestCostAccounts(t *testing.T) {
	s, err := ParseSettings([]byte(`{"cost":{"accounts":{
		"claude-max":{"match":{"harness":"claude"},"paid":true,"provider":"anthropic"},
		"or":{"match":{"harness":"opencode","model":"openrouter/"},"paid":"yes"},
		"or-deep":{"match":{"harness":"codex","model":"gpt-6"}}}}}`), "m")
	if err != nil {
		t.Fatal(err)
	}
	if s.CostProblem != "" || len(s.CostAccounts) != 3 {
		t.Fatalf("accounts %+v, problem %q", s.CostAccounts, s.CostProblem)
	}
	if a := s.CostAccounts["claude-max"]; a.Harness != "claude" || a.Model != nil || a.Paid == nil || !*a.Paid || a.Provider == nil || *a.Provider != "anthropic" {
		t.Errorf("claude-max: %+v", a)
	}
	if a := s.CostAccounts["or"]; a.Paid != nil || a.Model == nil || *a.Model != "openrouter/" {
		t.Errorf("or: %+v", a)
	}
	str := func(v string) *string { return &v }
	for _, c := range []struct {
		harness string
		model   *string
		want    string
	}{
		{"claude", nil, "claude-max"},
		{"claude", str("claude-opus-5-5"), "claude-max"},
		{"opencode", str("openrouter/deepseek"), "or"},
		{"opencode", str("anthropic/x"), ""},
		{"opencode", nil, ""},
		{"codex", str("gpt-6.1-sol"), "or-deep"},
		{"gemini", nil, ""},
	} {
		if got := s.AccountFor(c.harness, c.model); got != c.want {
			t.Errorf("AccountFor(%s, %v) = %q, want %q", c.harness, deref(c.model), got, c.want)
		}
	}
	// The longest prefix of two that don't overlap can't tie; a shorter prefix of the same model would overlap.
	s, _ = ParseSettings([]byte(`{"cost":{"accounts":{"a":{"match":{"harness":"x","model":"m-1"}},"b":{"match":{"harness":"x","model":"m-2"}}}}}`), "m")
	if s.AccountFor("x", str("m-2b")) != "b" || s.AccountFor("x", str("m-1")) != "a" {
		t.Error("prefix match")
	}
	for doc, want := range map[string]string{
		`{"cost":{"accounts":{"a":{"match":{}}}}}`:                                                                      "account a has no match.harness",
		`{"cost":{"accounts":{"a":{}}}}`:                                                                                "account a has no match.harness",
		`{"cost":{"accounts":{"a":{"match":{"harness":"x","model":3}}}}}`:                                               "account a has a bad match.model",
		`{"cost":{"accounts":{"a":{"match":{"harness":"x"},"provider":""}}}}`:                                           "account a has a bad provider",
		`{"cost":{"accounts":{"a":{"match":{"harness":"x"}},"b":{"match":{"harness":"x","model":"m"}}}}}`:               "accounts a and b both match the same harness and model",
		`{"cost":{"accounts":{"a":{"match":{"harness":"x","model":"m"}},"b":{"match":{"harness":"x","model":"m-1"}}}}}`: "accounts a and b both match the same harness and model",
	} {
		s, err := ParseSettings([]byte(doc), "m")
		if err != nil || s.CostProblem != want || s.CostAccounts != nil {
			t.Errorf("%s: problem %q, accounts %v, err %v; want %q", doc, s.CostProblem, s.CostAccounts, err, want)
		}
	}
	if s, _ := ParseSettings([]byte(`{"cost":{"accounts":{"a":{"match":{"harness":"x"}},"b":{"match":{"harness":"y"}}}}}`), "m"); s.CostProblem != "" || len(s.CostAccounts) != 2 {
		t.Errorf("other harnesses overlap: %q", s.CostProblem)
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

// TestCostProblemLogged: a cost.accounts problem is logged when the file is read, once per distinct problem: a reread
// with the same problem stays quiet, and the problem coming back after a fix is logged again.
func TestCostProblemLogged(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	h := home(t)
	f := NewSettingsFile(h, "m1")
	path := filepath.Join(h, "settings.json")
	bad := `{"cost":{"accounts":{"x":{"match":{}}}}}`
	step := func(body string, at time.Duration, want int) {
		t.Helper()
		write(t, path, body, 0o600)
		os.Chtimes(path, time.Now(), time.Now().Add(at))
		f.Get()
		if got := strings.Count(buf.String(), "cost.accounts is invalid"); got != want {
			t.Fatalf("%d warnings, want %d: %s", got, want, buf.String())
		}
	}
	step(bad, time.Second, 1)
	step(bad+" ", 2*time.Second, 1)
	step(`{}`, 3*time.Second, 1)
	step(bad, 4*time.Second, 2)
	if !strings.Contains(buf.String(), "problem=") {
		t.Errorf("the problem isn't named: %s", buf.String())
	}
}

// settings.decisions.model, the configured providers' ids and whether the system account has a budget (src/decide.ts reads them).
func TestDecisionSettings(t *testing.T) {
	s, err := ParseSettings(nil, "m")
	if err != nil || s.DecisionsModel != "microsoft/microsoft-decision-1" || len(s.ProviderIDs) != 0 || s.SystemBudget {
		t.Fatalf("defaults: %+v %v", s, err)
	}
	s, err = ParseSettings([]byte(`{"decisions":{"model":"myazure:gpt-4o"},"providers":{"zeta":{"kind":"openai-compatible","baseUrl":"https://z.example/v1"},"myazure":{"kind":"azure","endpoint":"https://a.example","apiVersion":"2024-02-01"},"br":{"kind":"bedrock","region":"us-east-1"},"brbad":{"kind":"bedrock","region":"US East"},"brpath":{"kind":"bedrock","region":"eu-west-1","endpoint":"https://b.example/path"},"brhttp":{"kind":"bedrock","region":"eu-west-1","endpoint":"http://b.example"},"empty":{},"nokind":{"baseUrl":"https://x"},"nourl":{"kind":"openai-compatible","baseUrl":"  "},"noversion":{"kind":"azure","endpoint":"https://a.example"},"str":"x"},"cost":{"accounts":{"openrouter-system":{"budget":{"usd":1,"per":"day"}}}}}`), "m")
	if err != nil || s.DecisionsModel != "myazure:gpt-4o" || strings.Join(s.ProviderIDs, ",") != "br,myazure,zeta" || !s.SystemBudget {
		t.Errorf("set: %+v %v", s, err)
	}
	// A budget of null, accounts or providers of the wrong type, and a model that is not a string, are as unset.
	for _, raw := range []string{`{"cost":{"accounts":{"openrouter-system":{"budget":null}}}}`, `{"cost":{"accounts":[1]},"providers":[1],"decisions":{"model":5}}`, `{"cost":{"accounts":{"openrouter-system":3}}}`} {
		if s, err = ParseSettings([]byte(raw), "m"); err != nil || s.SystemBudget || len(s.ProviderIDs) != 0 || s.DecisionsModel != "microsoft/microsoft-decision-1" {
			t.Errorf("%s: %+v %v", raw, s, err)
		}
	}
}

// settings.requirements besides `enabled`, with src/settings.ts's defaults for anything missing or of the wrong kind.
func TestRequirementsSettings(t *testing.T) {
	s, err := ParseSettings([]byte(`{"requirements":{"enabled":true,"approval":"cos","keyPrefix":"REQ","demoteMinFlags":3,"defaultThreshold":0.5,"defaultMode":"enforce"}}`), "m")
	want := RequirementsSettings{Approval: "cos", KeyPrefix: "REQ", DemoteMinFlags: 3, DefaultThreshold: 0.5, DefaultMode: "enforce", DailyCapUsd: 1}
	if err != nil || s.Requirements != want {
		t.Errorf("%+v %v", s.Requirements, err)
	}
	s, _ = ParseSettings([]byte(`{"requirements":{"approval":"anyone","keyPrefix":"R-1","demoteMinFlags":0,"defaultThreshold":2,"defaultMode":"loud"}}`), "m")
	if s.Requirements != (RequirementsSettings{Approval: "human", KeyPrefix: "R", DemoteMinFlags: 5, DefaultThreshold: 0.8, DefaultMode: "observe", DailyCapUsd: 1}) {
		t.Errorf("bad values: %+v", s.Requirements)
	}
	s, _ = ParseSettings([]byte(`{"requirements":{"demoteMinFlags":2.5}}`), "m")
	if s.Requirements.DemoteMinFlags != 5 {
		t.Errorf("a fraction: %+v", s.Requirements)
	}
}

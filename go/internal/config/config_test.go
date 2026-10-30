package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
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
	env := map[string]string{"STAM_HOME": h, "STAM_TEST_COST_HOOKS": "1", "STAM_TMUX_SOCKET": "stam-test-1", "STAM_TEST_HUMAN_KEY": "k", "STAM_TEST_INPUT_BARRIER": "/b"}
	c, _ := Load(envOf(env))
	if c.TestHome || c.TestHooks || c.TestHumanKey != "" || c.TestInputBarrier != "" {
		t.Fatalf("no marker: %+v", c)
	}
	write(t, filepath.Join(h, TestHomeMarker), "", 0o600)
	c, _ = Load(envOf(env))
	if c.TestHome {
		t.Fatal("a marker without the owner file is a test home")
	}
	write(t, filepath.Join(filepath.Dir(h), "owner"), "x", 0o600)
	c, _ = Load(envOf(env))
	if !c.TestHome || !c.TestHooks || c.TestHumanKey.Reveal() != "k" || c.TestInputBarrier != "/b" {
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
		s.PermissionModes = PermissionModes{Harness: map[string]string{"claude": "auto", "codex": "auto", "opencode": "auto"}, Types: map[string]string{}, HarnessKeys: []string{"claude", "codex", "opencode"}}
		s.Tiny = TinySettings{MailCheck: true, ToolSummary: ToolSummarySettings{Model: "google/gemma-3-4b-it"}, ToolNames: ToolNamesSettings{Enabled: true, Model: "google/gemma-3-4b-it"}, Classify: ClassifySettings{MaxUsdPerDay: 0.2, Concurrency: 2}}
		s.SpawnDefaults = SpawnDefaults{Preset: &preset, Cwd: &home}
		s.StartingTimeoutMinutes = 10
		s.StuckStartMinutes = 15
		s.MailGate = true
		s.DecisionsModel = "microsoft/microsoft-decision-1"
		s.Requirements = RequirementsSettings{Approval: "human", KeyPrefix: "R", DemoteMinFlags: 5, DefaultThreshold: 0.8, DefaultMode: "observe", DailyCapUsd: 1}
		s.StaleWorkingMinutes, s.FinalRoundMinutes, s.RetroReminders = 10, 3, true
		s.RetroLessons = RetroLessons{Enabled: true, K: 4}
		s.DialogEscalateMinutes = 10
		s.DeveloperCap = 6
		s.Banners = []Banner{{Harness: "claude", Match: `Teach auto mode about your environment\?`, Keys: []string{"Escape"}}}
		s.Context = ContextSettings{WarnTokens: 300_000, InstructTokens: 400_000, EnforceTokens: 500_000}
		s.IdleCompaction = IdleCompactionSettings{Enabled: true, IdleMinutes: 50, GrowthTokens: 50_000, MinTokens: 100_000}
		s.ExitRecovery = ExitRecoverySettings{PercentOfWindow: 85, WindowTokens: 350_000, RepeatMinutes: 5}
		s.Process = ProcessSettings{Run: "dry-run", MaxSpawnsPerHour: 3}
		s.Rest = RestSettings{Enabled: true, Types: map[string]bool{"cos": false, "assistant": false}}
		s.CostOnError, s.CostFallbackMinutes, s.CostSoftStopMinutes = &CostAction{Action: "soft-stop", Else: "wait"}, 15, 10
		s.OpenRouterWarnUSD, s.OpenRouterSystemReserveUSD = 2, 1
		s.SubscriptionWarnPercent = []float64{80, 95}
		s.WatchLinear = parseWatchLinear(nil)
		s.ResourceWarn = parseResourceWarn(nil)
		s.WatchGithubSeconds = 60
		s.CostShape = parseCostShape(nil, nil)
		s.Diff = DiffSettings{Classes: DiffClassDefaults, FetchSeconds: 60, RefreshSeconds: 20, MaxPrRefs: 100}
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
	if s, _ := ParseSettings([]byte(`{"stuckStartMinutes":0}`), "m1"); s.StuckStartMinutes != 0 {
		t.Fatalf("stuckStartMinutes 0 turns the check off: %v", s.StuckStartMinutes)
	}
	if s, _ := ParseSettings([]byte(`{"stuckStartMinutes":-1}`), "m1"); s.StuckStartMinutes != 15 {
		t.Fatalf("a negative stuckStartMinutes keeps the default: %v", s.StuckStartMinutes)
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
	// Banners: a list replaces the default, keeping the entries with a string harness and match, and their string keys.
	b, _ := ParseSettings([]byte(`{"banners":[{"harness":"codex","match":"Update\\?","keys":["Escape",5,"Enter"]},{"harness":"claude"},{"match":"x"},7]}`), "m1")
	if !reflect.DeepEqual(b.Banners, []Banner{{Harness: "codex", Match: `Update\?`, Keys: []string{"Escape", "Enter"}}}) {
		t.Errorf("banners %+v", b.Banners)
	}
	if b, _ := ParseSettings([]byte(`{"banners":[]}`), "m1"); len(b.Banners) != 0 {
		t.Errorf("an empty list %+v", b.Banners)
	}
	if b, _ := ParseSettings([]byte(`{"banners":{}}`), "m1"); len(b.Banners) != 1 {
		t.Errorf("not a list %+v", b.Banners)
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

// TestCostActions: an account's action fields, as a name or an object (else wait unless named); cost.onError, soft-stop
// unless the file names it, null included; cost.instructions; cost.fallbackMinutes, 15 unless a number; and
// cost.softStopMinutes, 10 unless a number.
func TestCostActions(t *testing.T) {
	s, err := ParseSettings([]byte(`{"cost":{"accounts":{"a":{"match":{"harness":"claude"},"onError":"continue",
		"onSubExhausted":{"action":"take-over","to":["b",3],"else":"hard-stop"},"onCreditsOut":{"action":"wait"},"onBillingUnknown":{"to":["b"]}},
		"b":{"match":{"harness":"codex"}}},"onError":{"action":"wait"},"instructions":" save money ","fallbackMinutes":0.5,"softStopMinutes":0.25}}`), "m")
	if err != nil || s.CostProblem != "" {
		t.Fatal(err, s.CostProblem)
	}
	want := map[string]CostAction{
		"onError":        {Action: "continue", Else: "wait"},
		"onSubExhausted": {Action: "take-over", To: []string{"b"}, Else: "hard-stop"},
		"onCreditsOut":   {Action: "wait", Else: "wait"},
	}
	if got := s.CostAccounts["a"].Actions; !reflect.DeepEqual(got, want) {
		t.Errorf("actions %+v", got)
	}
	if s.CostAccounts["b"].Actions != nil {
		t.Errorf("b actions %+v", s.CostAccounts["b"].Actions)
	}
	if !reflect.DeepEqual(s.CostOnError, &CostAction{Action: "wait", Else: "wait"}) || s.CostInstructions != " save money " || s.CostFallbackMinutes != 0.5 ||
		s.CostSoftStopMinutes != 0.25 {
		t.Errorf("onError %+v, instructions %q, minutes %v, soft stop %v", s.CostOnError, s.CostInstructions, s.CostFallbackMinutes, s.CostSoftStopMinutes)
	}
	if s, _ := ParseSettings([]byte(`{"cost":{"onError":null,"fallbackMinutes":"5","softStopMinutes":"5","instructions":3}}`), "m"); s.CostOnError != nil ||
		s.CostFallbackMinutes != 15 || s.CostSoftStopMinutes != 10 || s.CostInstructions != "" {
		t.Errorf("null onError %+v, minutes %v, soft stop %v, instructions %q", s.CostOnError, s.CostFallbackMinutes, s.CostSoftStopMinutes, s.CostInstructions)
	}
	if s, _ := ParseSettings([]byte(`{"cost":{"accounts":{}}}`), "m"); s.CostOnError == nil || s.CostOnError.Action != "soft-stop" {
		t.Errorf("default onError %+v", s.CostOnError)
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

// settings.decisions.model and the configured providers' ids (src/decide.ts reads them).
func TestDecisionSettings(t *testing.T) {
	s, err := ParseSettings(nil, "m")
	if err != nil || s.DecisionsModel != "microsoft/microsoft-decision-1" || len(s.ProviderIDs) != 0 || len(s.ProviderNames) != 0 {
		t.Fatalf("defaults: %+v %v", s, err)
	}
	s, err = ParseSettings([]byte(`{"decisions":{"model":"myazure:gpt-4o"},"providers":{"zeta":{"kind":"openai-compatible","baseUrl":"https://z.example/v1"},"myazure":{"kind":"azure","endpoint":"https://a.example","apiVersion":"2024-02-01"},"br":{"kind":"bedrock","region":"us-east-1"},"brbad":{"kind":"bedrock","region":"US East"},"brpath":{"kind":"bedrock","region":"eu-west-1","endpoint":"https://b.example/path"},"brhttp":{"kind":"bedrock","region":"eu-west-1","endpoint":"http://b.example"},"empty":{},"nokind":{"baseUrl":"https://x"},"nourl":{"kind":"openai-compatible","baseUrl":"  "},"noversion":{"kind":"azure","endpoint":"https://a.example"},"str":"x"}}`), "m")
	if err != nil || s.DecisionsModel != "myazure:gpt-4o" || strings.Join(s.ProviderIDs, ",") != "br,myazure,zeta" {
		t.Errorf("set: %+v %v", s, err)
	}
	// Every key counts as a provider an account may be billed by, parsed or not.
	if got := strings.Join(s.ProviderNames, ","); got != "br,brbad,brhttp,brpath,empty,myazure,nokind,nourl,noversion,str,zeta" {
		t.Errorf("names %s", got)
	}
	// Providers of the wrong type, and a model that is not a string, are as unset.
	if s, err = ParseSettings([]byte(`{"providers":[1],"decisions":{"model":5}}`), "m"); err != nil || len(s.ProviderIDs) != 0 || len(s.ProviderNames) != 0 || s.DecisionsModel != "microsoft/microsoft-decision-1" {
		t.Errorf("%+v %v", s, err)
	}
}

// TestBudgetSettings: an account's budget and cost.global.budget (src/settings.ts CostBudget), unchecked as in TS.
func TestBudgetSettings(t *testing.T) {
	s, err := ParseSettings([]byte(`{"cost":{"global":{"budget":{"usd":4,"per":"week","raiseSteps":[1,"x",3]},"onExhausted":"soft-stop"},"accounts":{"or":{"match":{"harness":"opencode"},"budget":{"usd":10,"per":"cap"}},"cx":{"match":{"harness":"codex"},"budget":null},"odd":{"match":{"harness":"claude"},"budget":{"usd":"ten","per":5}},"num":{"match":{"harness":"stam"},"budget":3}}}}`), "m")
	if err != nil {
		t.Fatal(err)
	}
	if g := s.GlobalBudget; g == nil || g.USD != 4 || g.Per != "week" || fmt.Sprint(g.RaiseSteps) != "[1 3]" || s.GlobalOnExhausted != "soft-stop" {
		t.Errorf("global %+v", g)
	}
	if b := s.CostAccounts["or"].Budget; b == nil || b.USD != 10 || b.Per != "cap" || b.RaiseSteps != nil {
		t.Errorf("or %+v", b)
	}
	if s.CostAccounts["cx"].Budget != nil || s.CostAccounts["num"].Budget != nil {
		t.Error("a null budget, or one that isn't an object, is none")
	}
	if b := s.CostAccounts["odd"].Budget; b == nil || !math.IsNaN(b.USD) || b.Per != "" {
		t.Errorf("odd %+v", b)
	}
	if s, _ = ParseSettings(nil, "m"); s.GlobalBudget != nil {
		t.Error("no global budget by default")
	}
}

// cost.openrouterWarnUsd and cost.openrouterSystemReserveUsd: TS's defaults when missing; a named warning that is null or
// not a number is never, and a reserve that isn't a number is the default.
func TestCreditSettings(t *testing.T) {
	cases := []struct {
		cost          string
		warn, reserve float64
	}{
		{``, 2, 1},
		{`"openrouterWarnUsd":5,"openrouterSystemReserveUsd":0.5`, 5, 0.5},
		{`"openrouterWarnUsd":null,"openrouterSystemReserveUsd":null`, 0, 1},
		{`"openrouterWarnUsd":"3","openrouterSystemReserveUsd":"2"`, 0, 1},
		{`"openrouterWarnUsd":0,"openrouterSystemReserveUsd":0`, 0, 0},
	}
	for _, c := range cases {
		s, err := ParseSettings([]byte(`{"cost":{`+c.cost+`}}`), "m")
		if err != nil || s.OpenRouterWarnUSD != c.warn || s.OpenRouterSystemReserveUSD != c.reserve {
			t.Errorf("%s: warn %v reserve %v %v", c.cost, s.OpenRouterWarnUSD, s.OpenRouterSystemReserveUSD, err)
		}
	}
	if s, _ := ParseSettings(nil, "m"); s.OpenRouterWarnUSD != 2 || s.OpenRouterSystemReserveUSD != 1 {
		t.Errorf("no file: %v %v", s.OpenRouterWarnUSD, s.OpenRouterSystemReserveUSD)
	}
}

// cost.subscriptionWarnPercent and cost.dailyWarnUsd: src/settings.ts's defaults, a named key replacing them, and values
// of the wrong kind warning at none.
func TestWarnSettings(t *testing.T) {
	cases := []struct {
		cost    string
		percent []float64
		daily   float64
	}{
		{``, []float64{80, 95}, 0},
		{`"subscriptionWarnPercent":[50],"dailyWarnUsd":20`, []float64{50}, 20},
		{`"subscriptionWarnPercent":[],"dailyWarnUsd":null`, nil, 0},
		{`"subscriptionWarnPercent":null,"dailyWarnUsd":"5"`, nil, 0},
		{`"subscriptionWarnPercent":[70,"90",99.5]`, []float64{70, 99.5}, 0},
	}
	for _, c := range cases {
		s, err := ParseSettings([]byte(`{"cost":{`+c.cost+`}}`), "m")
		if err != nil || !reflect.DeepEqual(s.SubscriptionWarnPercent, c.percent) || s.DailyWarnUSD != c.daily {
			t.Errorf("%s: percent %v daily %v %v", c.cost, s.SubscriptionWarnPercent, s.DailyWarnUSD, err)
		}
	}
	if s, _ := ParseSettings(nil, "m"); !reflect.DeepEqual(s.SubscriptionWarnPercent, []float64{80, 95}) || s.DailyWarnUSD != 0 {
		t.Errorf("no file: %v %v", s.SubscriptionWarnPercent, s.DailyWarnUSD)
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

// settings.retro.lessons as src/settings.ts reads it: on unless false; k an integer clamped to 1-8, else 4.
func TestRetroLessons(t *testing.T) {
	for _, c := range []struct {
		raw  string
		want RetroLessons
	}{
		{`{}`, RetroLessons{true, 4}},
		{`{"retro":{"lessons":{"enabled":false,"k":2}}}`, RetroLessons{false, 2}},
		{`{"retro":{"lessons":{"enabled":0,"k":20}}}`, RetroLessons{true, 8}},
		{`{"retro":{"lessons":{"k":0}}}`, RetroLessons{true, 1}},
		{`{"retro":{"lessons":{"k":-3}}}`, RetroLessons{true, 1}},
		{`{"retro":{"lessons":{"k":2.5}}}`, RetroLessons{true, 4}},
		{`{"retro":{"lessons":{"k":"3"}}}`, RetroLessons{true, 4}},
		{`{"retro":{"lessons":null}}`, RetroLessons{true, 4}},
	} {
		s, err := ParseSettings([]byte(c.raw), "m1")
		if err != nil {
			t.Fatal(err)
		}
		if s.RetroLessons != c.want {
			t.Errorf("%s: %+v, want %+v", c.raw, s.RetroLessons, c.want)
		}
	}
}

// TestParseDeveloperCap: developerCap is a whole number from 0, else 6 (src/settings.ts); itsa.prOpen.storage names the
// storage remote.
func TestParseDeveloperCap(t *testing.T) {
	for in, want := range map[string]int{`{}`: 6, `{"developerCap":0}`: 0, `{"developerCap":2}`: 2, `{"developerCap":-1}`: 6, `{"developerCap":1.5}`: 6, `{"developerCap":"3"}`: 6} {
		s, err := ParseSettings([]byte(in), "m1")
		if err != nil || s.DeveloperCap != want {
			t.Errorf("%s: %d %v, want %d", in, s.DeveloperCap, err, want)
		}
	}
	s, err := ParseSettings([]byte(`{"itsa":{"prOpen":{"storage":"storage"}}}`), "m1")
	if err != nil || s.Itsa.PrOpenStorage != "storage" {
		t.Errorf("prOpen.storage: %q %v", s.Itsa.PrOpenStorage, err)
	}
}

// settings.diff as src/settings.ts reads it: a class given as an array takes its non-blank strings, anything else keeps
// the default; the numbers are Number()s, a null refreshSeconds is 0 and a missing one the default.
func TestDiffSettings(t *testing.T) {
	for text, want := range map[string]DiffSettings{
		`{}`: {Classes: DiffClassDefaults, FetchSeconds: 60, RefreshSeconds: 20, MaxPrRefs: 100},
		`{"diff":{"classes":{"tests":["t/", " ", 3, "*.t"],"docs":"x","other":["y"]},"fetchSeconds":"5","refreshSeconds":null,"maxPrRefs":2.7}}`: {
			Classes:      map[string][]string{"tests": {"t/", "*.t"}, "lockfiles": DiffClassDefaults["lockfiles"], "generated": DiffClassDefaults["generated"], "docs": DiffClassDefaults["docs"]},
			FetchSeconds: 5, RefreshSeconds: 0, MaxPrRefs: 2},
		`{"diff":{"fetchSeconds":0,"refreshSeconds":-1,"maxPrRefs":0.5}}`: {Classes: DiffClassDefaults, FetchSeconds: 60, RefreshSeconds: 20, MaxPrRefs: 100},
		`{"diff":{"classes":{"docs":[]},"refreshSeconds":"0"}}`: {Classes: map[string][]string{"tests": DiffClassDefaults["tests"], "lockfiles": DiffClassDefaults["lockfiles"], "generated": DiffClassDefaults["generated"], "docs": {}},
			FetchSeconds: 60, RefreshSeconds: 0, MaxPrRefs: 100},
		// A wrong type costs only that key's defaults, never the whole settings file.
		`{"diff":{"classes":[],"fetchSeconds":7}}`: {Classes: DiffClassDefaults, FetchSeconds: 7, RefreshSeconds: 20, MaxPrRefs: 100},
		`{"diff":{"classes":"x","maxPrRefs":[]}}`:  {Classes: DiffClassDefaults, FetchSeconds: 60, RefreshSeconds: 20, MaxPrRefs: 100},
		`{"diff":[]}`:  {Classes: DiffClassDefaults, FetchSeconds: 60, RefreshSeconds: 20, MaxPrRefs: 100},
		`{"diff":"x"}`: {Classes: DiffClassDefaults, FetchSeconds: 60, RefreshSeconds: 20, MaxPrRefs: 100},
		`{"diff":{"classes":null,"refreshSeconds":1e300}}`: {Classes: DiffClassDefaults, FetchSeconds: 60, RefreshSeconds: 1e300, MaxPrRefs: 100},
	} {
		s, err := ParseSettings([]byte(text), "m1")
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(s.Diff, want) {
			t.Errorf("%s: %+v, want %+v", text, s.Diff, want)
		}
	}
}

func TestWatchGithubSeconds(t *testing.T) {
	for raw, want := range map[string]float64{`{}`: 60, `{"watch":{"githubSeconds":1}}`: 1, `{"watch":{"githubSeconds":0}}`: 0, `{"watch":{"githubSeconds":"x"}}`: 60} {
		s, err := ParseSettings([]byte(raw), "m1")
		if err != nil || s.WatchGithubSeconds != want {
			t.Errorf("%s: %v %v", raw, s.WatchGithubSeconds, err)
		}
	}
}

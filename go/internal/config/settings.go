package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"stam/internal/jsjson"
)

// Settings is the part of settings.json (src/settings.ts) the ported routes read, with the TS defaults. Each later
// module adds the keys it needs, parsed the way src/settings.ts parses them.
//
// Not yet ported: the shared-settings cache a non-home daemon reads (settings.shared.json), and every key no Go route
// reads.
type Settings struct {
	// Home is the settings home (homeOf): `home`, else `itsa.home`, else this machine.
	Home string
	// ChiefOfStaff is the chief of staff's name or id; empty when none is set.
	ChiefOfStaff string
	Auth         AuthSettings
	Itsa         ItsaSettings
	// CostMode is cost.display.mode: api, five_hour, seven_day or subscription, else api (src/cost-display.ts).
	CostMode string
	// CostAccounts is cost.accounts (src/accounts.ts): which provider login or key an agent bills to, by name. Empty
	// when the file names none or its accounts fail the checks below (CostProblem says why).
	CostAccounts map[string]CostAccount
	// CostProblem is the first problem with cost.accounts, "" when there is none. Only the account checks of
	// src/accounts.ts validate are ported: a match.harness, a string match.model, a non-empty provider, and no two
	// matches covering one harness and model. TS keeps the last valid cost config on a bad one and refuses to save
	// one; here bad accounts read as none.
	CostProblem string
	// MailGate is decisions.mailGate: an agent's mail to the human is checked by the decision model (S-983). On unless
	// the file says false.
	MailGate  bool
	HumanMail HumanMailSettings
	// RequirementsEnabled is requirements.enabled: the requirement checks run on ITSA changes. Off unless the file says true.
	RequirementsEnabled bool
	// Requirements are the rest of settings.requirements (src/settings.ts), with its defaults.
	Requirements RequirementsSettings
	// DecisionsModel is settings.decisions.model: the decision model stam asks, `provider:model` or an OpenRouter id.
	DecisionsModel string
	// ProviderIDs are the keys of settings.providers: the configured providers a model name may start with.
	ProviderIDs []string
	// SystemBudget is whether cost.accounts.openrouter-system has a budget, which holds stam's own model calls once spent.
	SystemBudget bool
	// McpServers is settings.mcpServers as the file holds it, in its key order (an object, or an array, which TS's
	// Object.entries reads by index); nil when it is missing or not an object (src/settings.ts).
	McpServers jsjson.Value
	// ChildNotices is what a new agent hears of its children: turn, tree-idle or none, else tree-idle.
	ChildNotices string
	// PermissionModes is settings.permissionModes: the mode per harness (claude, codex and opencode auto by default) and
	// per agent type, each default, auto or bypass; any other value is dropped.
	PermissionModes PermissionModes
	// SpawnDefaults is what a spawn with no harness, model, preset or type gets (preset standard, cwd ~).
	SpawnDefaults SpawnDefaults
	// StartingTimeoutMinutes is how long an agent may stay starting with no harness process before it is marked
	// stopped: a positive number, else 10.
	StartingTimeoutMinutes float64
	// Peers is settings.peers: the other machines' daemons (src/peers.ts).
	Peers []Peer
	// StaleWorkingMinutes is how long a working agent at its prompt may go without a hook before its turn is taken to
	// have ended: a positive number, else 10.
	StaleWorkingMinutes float64
	// DialogEscalateMinutes is how long a harness dialog waits on the agent's parent and the chief of staff before it
	// goes to the human (src/permissions.ts escalateStaleDialogs): a number of at least 0, else 10.
	DialogEscalateMinutes float64
	// FinalRoundMinutes is settings.archive.finalRoundMinutes: how long a stop waits for the agent's final round, a
	// number of at least 0, else 3.
	FinalRoundMinutes float64
	// RetroReminders is settings.retro.reminders.enabled: on unless the file says false.
	RetroReminders bool
	Context        ContextSettings
	IdleCompaction IdleCompactionSettings
	ExitRecovery   ExitRecoverySettings
	// Process is settings.process (S-946): what a stage entry does.
	Process ProcessSettings
}

// ProcessSettings is settings.process: Run is off, dry-run or on, else dry-run; MaxSpawnsPerHour is an integer of at least 0,
// else 3.
type ProcessSettings struct {
	Run              string
	MaxSpawnsPerHour int
}

// CostAccount is one cost account: the harness, and the model prefix when it names one, it matches; paid (nil unless
// the file gives a boolean); and the provider it names, nil for none.
type CostAccount struct {
	Harness  string
	Model    *string
	Paid     *bool
	Provider *string
}

// Matches is src/accounts.ts matchAccount's test for one account, and the prefix length it matched by (0 for a
// harness-only match): -1 when it doesn't match.
func (c CostAccount) Matches(harness string, model *string) int {
	if c.Harness != harness {
		return -1
	}
	if c.Model == nil {
		return 0
	}
	m := ""
	if model != nil {
		m = *model
	}
	if !strings.HasPrefix(m, *c.Model) {
		return -1
	}
	return len(*c.Model)
}

// AccountFor is src/accounts.ts accountFor: the account whose match covers the harness and model, the longest model
// prefix winning, or "" for an unmanaged agent.
func (s Settings) AccountFor(harness string, model *string) string {
	best, bestLen := "", -1
	for name, acct := range s.CostAccounts {
		// Valid accounts never tie (no two overlap); the name breaks one anyway, so the answer doesn't vary.
		if n := acct.Matches(harness, model); n > bestLen || (n == bestLen && n >= 0 && name < best) {
			best, bestLen = name, n
		}
	}
	return best
}

// parseAccounts reads cost.accounts with the account checks of src/accounts.ts validate; it returns the first problem
// instead of accounts when one fails.
func parseAccounts(v any) (map[string]CostAccount, string) {
	m, _ := v.(map[string]any)
	if len(m) == 0 {
		return nil, ""
	}
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	out := map[string]CostAccount{}
	for _, name := range names {
		acct, _ := m[name].(map[string]any)
		match, _ := acct["match"].(map[string]any)
		harness, _ := match["harness"].(string)
		if harness == "" {
			return nil, "account " + name + " has no match.harness"
		}
		a := CostAccount{Harness: harness}
		switch model := match["model"].(type) {
		case nil:
		case string:
			a.Model = &model
		default:
			return nil, "account " + name + " has a bad match.model"
		}
		switch p := acct["provider"].(type) {
		case nil:
		case string:
			if p == "" {
				return nil, "account " + name + " has a bad provider"
			}
			a.Provider = &p
		default:
			return nil, "account " + name + " has a bad provider"
		}
		if paid, ok := acct["paid"].(bool); ok {
			a.Paid = &paid
		}
		out[name] = a
	}
	for i, x := range names {
		for _, y := range names[i+1:] {
			if overlaps(out[x], out[y]) {
				return nil, "accounts " + x + " and " + y + " both match the same harness and model"
			}
		}
	}
	return out, ""
}

// overlaps is src/accounts.ts overlaps: some harness and model would bill to both.
func overlaps(a, b CostAccount) bool {
	if a.Harness != b.Harness {
		return false
	}
	if a.Model == nil || b.Model == nil {
		return true
	}
	return strings.HasPrefix(*a.Model, *b.Model) || strings.HasPrefix(*b.Model, *a.Model)
}

// Peer is one entry of settings.peers. The tokens are secrets: they never render in a log, an error or a response.
type Peer struct {
	Name, URL string
	// Token is the shared token of the peer's daemon; PeerToken the one it accepts from daemons (its STAM_HOME/peer-token,
	// S-545), which wins when set.
	Token, PeerToken Secret
	// Start is a shell command that starts the machine when it is down; Deploy one that deploys a release to it (S-236).
	Start, Deploy string
}

// Bearer is the token a call to this peer carries: its peer token, else its shared one.
func (p Peer) Bearer() string {
	if p.PeerToken != "" {
		return p.PeerToken.Reveal()
	}
	return p.Token.Reveal()
}

// ContextSettings is settings.context: the context sizes at which an agent is warned, told to compact, and compacted.
type ContextSettings struct {
	WarnTokens, InstructTokens, EnforceTokens float64
}

// IdleCompactionSettings is settings.idleCompaction: compacting an agent idle past its prompt cache's lifetime.
type IdleCompactionSettings struct {
	Enabled                              bool
	IdleMinutes, GrowthTokens, MinTokens float64
}

// ExitRecoverySettings is settings.exitRecovery: a harness that exits at percentOfWindow of windowTokens is resumed
// once, to compact first, unless it did within repeatMinutes (S-220).
type ExitRecoverySettings struct {
	PercentOfWindow, WindowTokens, RepeatMinutes float64
}

// PermissionModes is settings.permissionModes.
type PermissionModes struct {
	Harness map[string]string
	Types   map[string]string
}

// EffectiveMode is src/permission-modes.ts effectiveMode: the type's mode, else the harness's, else auto.
func (p PermissionModes) EffectiveMode(harness, typ string) string {
	if m, ok := p.Types[typ]; ok && typ != "" && IsPermissionMode(m) {
		return m
	}
	if m := p.Harness[harness]; IsPermissionMode(m) {
		return m
	}
	return "auto"
}

// IsPermissionMode is src/permission-modes.ts isMode.
func IsPermissionMode(m string) bool { return m == "default" || m == "auto" || m == "bypass" }

// SpawnDefaults is settings.spawnDefaults; a nil field is null.
type SpawnDefaults struct {
	Preset, Cwd *string
}

// HumanMailSettings is settings.humanMail: when stam mails the human, and the models that may not.
type HumanMailSettings struct {
	// When is necessary, important or everything, else necessary.
	When string
	// Models maps a model to whether its agents may mail the human; claude-haiku-5-5 false by default.
	Models map[string]bool
}

// MayMail is src/settings.ts mayMailHuman: an empty or unknown model may; only an explicit false keeps one from.
func (h HumanMailSettings) MayMail(model string) bool {
	may, named := h.Models[model]
	return model == "" || !named || may
}

// Allows is src/settings.ts humanMailAllows: whether stam may mail the human at this level (necessary, important, everything).
func (h HumanMailSettings) Allows(level string) bool {
	rank := map[string]int{"necessary": 0, "important": 1, "everything": 2}
	return rank[h.When] >= rank[level]
}

// AuthSettings is settings.auth.
type AuthSettings struct {
	SharedTokenClaims bool
	HumanStrict       bool
	LocalHuman        bool
}

// ItsaSettings is settings.itsa.
type ItsaSettings struct {
	// Home is the ITSA home: homeOf, the same as Settings.Home (src/settings.ts), so `home` wins over `itsa.home`.
	Home     string
	Required bool
	// KeyPrefix starts readable keys (`S-42`); S unless the file names another.
	KeyPrefix string
	// Statuses is the editable status set, in order: the file's, else the defaults.
	Statuses []ItsaStatus
	// Actions is what the human can do to an ITSA in a human status, by status: the defaults, each status's list replaced
	// by the file's.
	Actions map[string][]HumanAction
	// Repos is itsa.repos from the file: a repo's name to its canonical path. TS adds the checkout it runs from under its
	// directory name (derivedRepos); this daemon does not derive one yet, so only the file's are here.
	Repos map[string]string
	// PrOpenGithub is itsa.prOpen.github: the GitHub repo (OWNER/NAME) whose pull requests the ITSAs link. TS reads the origin of the
	// prOpen checkout when it is empty; this daemon does not.
	PrOpenGithub string
	// PrOpenRepo is itsa.prOpen.repo: the name in Repos the pull requests are opened from; PrOpenOrigin the remote (origin) and
	// PrOpenGh the gh program (gh).
	PrOpenRepo, PrOpenOrigin, PrOpenGh string
	// MainBranch is itsa.mainBranch: the branch a diff is taken against.
	MainBranch string
	// OwnerNotices is itsa.ownerNotices: a child that is blocked, closed or waits on the human tells its parent's owner. On
	// unless the file says off.
	OwnerNotices bool
}

// ItsaStatus is one entry of settings.itsa.statuses. Entries are kept as written (src/itsa.ts statuses() filters them).
type ItsaStatus struct {
	Name, Category string
	Human          bool
}

// HumanAction is one button on an ITSA that waits on the human (settings.itsa.actions).
type HumanAction struct {
	ID, Label, To string
	// Text is none, optional or required.
	Text string
}

var defaultStatuses = func() []ItsaStatus {
	var out []ItsaStatus
	for _, g := range []struct {
		category string
		names    []string
		human    []string
	}{
		{"backlog", []string{"idea", "backlog", "icebox"}, nil},
		{"ready", []string{"todo", "ready", "scheduled"}, nil},
		{"active", []string{"planning", "in_progress", "delegated", "waiting", "blocked", "needs_input", "needs_approval"}, []string{"needs_input", "needs_approval"}},
		{"review", []string{"in_review", "testing", "needs_review", "needs_test", "ready_to_merge", "merging", "deploying"}, []string{"needs_review", "needs_test"}},
		{"closed", []string{"done", "canceled", "duplicate", "wont_do"}, nil},
	} {
		for _, n := range g.names {
			h := false
			for _, x := range g.human {
				h = h || x == n
			}
			out = append(out, ItsaStatus{n, g.category, h})
		}
	}
	return out
}()

func defaultActions() map[string][]HumanAction {
	changes := HumanAction{"changes", "Request changes", "in_progress", "required"}
	return map[string][]HumanAction{
		"needs_input":    {{"answer", "Answer", "in_progress", "required"}},
		"needs_approval": {{"approve", "Approve", "in_progress", "optional"}, changes},
		"needs_review":   {{"approve", "Approve", "ready_to_merge", "optional"}, changes},
		"needs_test":     {{"approve", "Approve", "done", "optional"}, changes},
	}
}

// costModes is src/cost-display.ts COST_MODES.
var costModes = map[string]bool{"api": true, "five_hour": true, "seven_day": true, "subscription": true}

// ParseSettings reads a settings.json document over the defaults, as src/settings.ts does for these keys.
func ParseSettings(data []byte, machine string) (Settings, error) {
	var user struct {
		Home         any `json:"home"`
		ChiefOfStaff any `json:"chiefOfStaff"`
		Auth         struct {
			SharedTokenClaims any `json:"sharedTokenClaims"`
			HumanStrict       any `json:"humanStrict"`
			LocalHuman        any `json:"localHuman"`
		} `json:"auth"`
		Itsa struct {
			Home       any `json:"home"`
			Required   any `json:"required"`
			KeyPrefix  any `json:"keyPrefix"`
			Statuses   any `json:"statuses"`
			Actions    any `json:"actions"`
			Repos      any `json:"repos"`
			MainBranch any `json:"mainBranch"`
			PrOpen     struct {
				Github any `json:"github"`
				Repo   any `json:"repo"`
				Origin any `json:"origin"`
				Gh     any `json:"gh"`
			} `json:"prOpen"`
			// OwnerNotices is on unless the file says "off".
			OwnerNotices any `json:"ownerNotices"`
		} `json:"itsa"`
		Requirements struct {
			Enabled          any `json:"enabled"`
			Approval         any `json:"approval"`
			KeyPrefix        any `json:"keyPrefix"`
			DemoteMinFlags   any `json:"demoteMinFlags"`
			DailyCapUsd      any `json:"dailyCapUsd"`
			DefaultThreshold any `json:"defaultThreshold"`
			DefaultMode      any `json:"defaultMode"`
		} `json:"requirements"`
		Cost struct {
			Display struct {
				Mode any `json:"mode"`
			} `json:"display"`
			Accounts any `json:"accounts"`
		} `json:"cost"`
		Providers any `json:"providers"`
		HumanMail struct {
			When   any `json:"when"`
			Models any `json:"models"`
		} `json:"humanMail"`
		ChildNotices    any `json:"childNotices"`
		PermissionModes struct {
			Harness any `json:"harness"`
			Types   any `json:"types"`
		} `json:"permissionModes"`
		SpawnDefaults          map[string]any `json:"spawnDefaults"`
		StartingTimeoutMinutes any            `json:"startingTimeoutMinutes"`
		Peers                  any            `json:"peers"`
		StaleWorkingMinutes    any            `json:"staleWorkingMinutes"`
		DialogEscalateMinutes  any            `json:"dialogEscalateMinutes"`
		Archive                struct {
			FinalRoundMinutes any `json:"finalRoundMinutes"`
		} `json:"archive"`
		Retro struct {
			Reminders struct {
				Enabled any `json:"enabled"`
			} `json:"reminders"`
		} `json:"retro"`
		Process struct {
			Run              any `json:"run"`
			MaxSpawnsPerHour any `json:"maxSpawnsPerHour"`
		} `json:"process"`
		Context        map[string]any `json:"context"`
		IdleCompaction map[string]any `json:"idleCompaction"`
		ExitRecovery   map[string]any `json:"exitRecovery"`
		Decisions      struct {
			Model    any `json:"model"`
			MailGate any `json:"mailGate"`
		} `json:"decisions"`
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &user); err != nil {
			return Settings{}, err
		}
	}
	str := func(v any) string { s, _ := v.(string); return s }
	s := Settings{
		ChiefOfStaff: str(user.ChiefOfStaff),
		Auth: AuthSettings{
			SharedTokenClaims: user.Auth.SharedTokenClaims != false,
			HumanStrict:       user.Auth.HumanStrict == true,
			LocalHuman:        user.Auth.LocalHuman == true,
		},
		Itsa:     ItsaSettings{Required: user.Itsa.Required != false, KeyPrefix: or(str(user.Itsa.KeyPrefix), "S"), Statuses: itsaStatuses(user.Itsa.Statuses), Actions: itsaActions(user.Itsa.Actions), Repos: itsaRepos(user.Itsa.Repos), MainBranch: or(str(user.Itsa.MainBranch), "main"), PrOpenGithub: str(user.Itsa.PrOpen.Github), PrOpenRepo: str(user.Itsa.PrOpen.Repo), PrOpenOrigin: or(str(user.Itsa.PrOpen.Origin), "origin"), PrOpenGh: or(str(user.Itsa.PrOpen.Gh), "gh"), OwnerNotices: user.Itsa.OwnerNotices != "off"},
		CostMode: "api",
		MailGate: user.Decisions.MailGate != false,

		RequirementsEnabled: user.Requirements.Enabled == true,
		Requirements:        requirementsSettings(user.Requirements.Approval, user.Requirements.KeyPrefix, user.Requirements.DemoteMinFlags, user.Requirements.DefaultThreshold, user.Requirements.DefaultMode, user.Requirements.DailyCapUsd),
		DecisionsModel:      or(str(user.Decisions.Model), "microsoft/microsoft-decision-1"),
	}
	if m, ok := user.Providers.(map[string]any); ok {
		for id, v := range m {
			if providerParses(v) {
				s.ProviderIDs = append(s.ProviderIDs, id)
			}
		}
	}
	sort.Strings(s.ProviderIDs)
	if accounts, ok := user.Cost.Accounts.(map[string]any); ok {
		if acct, ok := accounts["openrouter-system"].(map[string]any); ok {
			// `budget ?? null`: a budget that is set and not null.
			s.SystemBudget = acct["budget"] != nil
		}
	}
	s.Home = or(str(user.Home), or(str(user.Itsa.Home), machine))
	s.Itsa.Home = s.Home
	if m := str(user.Cost.Display.Mode); costModes[m] {
		s.CostMode = m
	}
	s.CostAccounts, s.CostProblem = parseAccounts(user.Cost.Accounts)
	s.HumanMail = HumanMailSettings{When: "necessary", Models: map[string]bool{"claude-haiku-5-5": false}}
	if w := str(user.HumanMail.When); w == "necessary" || w == "important" || w == "everything" {
		s.HumanMail.When = w
	}
	// A file that names only some models keeps the defaults for the rest; a value that isn't a boolean is dropped.
	if m, ok := user.HumanMail.Models.(map[string]any); ok {
		for k, v := range m {
			if b, ok := v.(bool); ok {
				s.HumanMail.Models[k] = b
			}
		}
	}
	s.ChildNotices = "tree-idle"
	if c := str(user.ChildNotices); c == "turn" || c == "tree-idle" || c == "none" {
		s.ChildNotices = c
	}
	s.PermissionModes = PermissionModes{
		Harness: map[string]string{"claude": "auto", "codex": "auto", "opencode": "auto"},
		Types:   map[string]string{},
	}
	for _, f := range []struct {
		v   any
		out map[string]string
	}{{user.PermissionModes.Harness, s.PermissionModes.Harness}, {user.PermissionModes.Types, s.PermissionModes.Types}} {
		m, _ := f.v.(map[string]any)
		for k, v := range m {
			if mode := str(v); IsPermissionMode(mode) {
				f.out[k] = mode
			}
		}
	}
	// `{ ...DEFAULTS.spawnDefaults, ...user.spawnDefaults }`: a key the file sets wins, whatever its value; only a
	// string is used here, anything else reads as null.
	preset, cwd := "standard", "~"
	s.SpawnDefaults = SpawnDefaults{Preset: &preset, Cwd: &cwd}
	for k, field := range map[string]**string{"preset": &s.SpawnDefaults.Preset, "cwd": &s.SpawnDefaults.Cwd} {
		if v, ok := user.SpawnDefaults[k]; ok {
			if t, isStr := v.(string); isStr {
				*field = &t
			} else {
				*field = nil
			}
		}
	}
	// `Array.isArray(user.peers) ? user.peers : []`; an entry that is not an object cannot name a peer and is dropped.
	if list, ok := user.Peers.([]any); ok {
		for _, e := range list {
			if m, ok := e.(map[string]any); ok {
				s.Peers = append(s.Peers, Peer{Name: str(m["name"]), URL: str(m["url"]), Token: Secret(str(m["token"])), PeerToken: Secret(str(m["peerToken"])), Start: str(m["start"]), Deploy: str(m["deploy"])})
			}
		}
	}
	s.StartingTimeoutMinutes = 10
	if n, ok := user.StartingTimeoutMinutes.(float64); ok && n > 0 {
		s.StartingTimeoutMinutes = n
	}
	s.StaleWorkingMinutes = 10
	if n, ok := user.StaleWorkingMinutes.(float64); ok && n > 0 {
		s.StaleWorkingMinutes = n
	}
	s.DialogEscalateMinutes = 10
	if n, ok := user.DialogEscalateMinutes.(float64); ok && n >= 0 {
		s.DialogEscalateMinutes = n
	}
	s.FinalRoundMinutes = 3
	if n, ok := user.Archive.FinalRoundMinutes.(float64); ok && n >= 0 {
		s.FinalRoundMinutes = n
	}
	s.RetroReminders = user.Retro.Reminders.Enabled != false
	// `{ ...DEFAULTS.x, ...user.x }`: a key the file sets wins. Only a number is used here; TS would carry another
	// value through and compare with it, which no valid file does.
	num := func(m map[string]any, k string, def float64) float64 {
		if n, ok := m[k].(float64); ok {
			return n
		}
		return def
	}
	s.Context = ContextSettings{WarnTokens: num(user.Context, "warnTokens", 300_000), InstructTokens: num(user.Context, "instructTokens", 400_000),
		EnforceTokens: num(user.Context, "enforceTokens", 500_000)}
	s.IdleCompaction = IdleCompactionSettings{Enabled: true, IdleMinutes: num(user.IdleCompaction, "idleMinutes", 50),
		GrowthTokens: num(user.IdleCompaction, "growthTokens", 50_000), MinTokens: num(user.IdleCompaction, "minTokens", 100_000)}
	if v, ok := user.IdleCompaction["enabled"]; ok {
		s.IdleCompaction.Enabled = v != nil && v != false && v != 0.0 && v != ""
	}
	s.ExitRecovery = ExitRecoverySettings{PercentOfWindow: num(user.ExitRecovery, "percentOfWindow", 85),
		WindowTokens: num(user.ExitRecovery, "windowTokens", 350_000), RepeatMinutes: num(user.ExitRecovery, "repeatMinutes", 5)}
	s.Process = ProcessSettings{Run: "dry-run", MaxSpawnsPerHour: 3}
	if r := str(user.Process.Run); r == "off" || r == "dry-run" || r == "on" {
		s.Process.Run = r
	}
	if n, ok := user.Process.MaxSpawnsPerHour.(float64); ok && n >= 0 && n == math.Trunc(n) {
		s.Process.MaxSpawnsPerHour = int(n)
	}
	if len(data) > 0 {
		doc, err := jsjson.Parse(data)
		if err != nil {
			return Settings{}, err
		}
		if o, ok := doc.(*jsjson.Object); ok {
			// `user.mcpServers && typeof user.mcpServers === 'object'`: an array counts, null doesn't.
			switch v, _ := o.Get("mcpServers"); v.(type) {
			case *jsjson.Object, []jsjson.Value:
				s.McpServers = v
			}
		}
	}
	return s, nil
}

// itsaStatuses is the file's list when it is a non-empty array, else the defaults (src/settings.ts). An entry is kept as
// written; one that is not an object, or has no string name or category, reads as the empty strings TS's filters reject.
func itsaStatuses(v any) []ItsaStatus {
	list, ok := v.([]any)
	if !ok || len(list) == 0 {
		return defaultStatuses
	}
	out := make([]ItsaStatus, 0, len(list))
	for _, e := range list {
		m, _ := e.(map[string]any)
		name, _ := m["name"].(string)
		category, _ := m["category"].(string)
		out = append(out, ItsaStatus{name, category, truthy(m["human"])})
	}
	return out
}

// truthy is a decoded JSON value's JS truthiness.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	}
	return true
}

// itsaActions lays the file's lists over the defaults (src/settings.ts itsaActions): an entry without string id, label
// and to, or with an empty id or to, is dropped; text is none, optional or required, else optional.
func itsaActions(v any) map[string][]HumanAction {
	out := defaultActions()
	user, ok := v.(map[string]any)
	if !ok {
		return out
	}
	for status, raw := range user {
		list, ok := raw.([]any)
		if !ok {
			continue
		}
		kept := []HumanAction{}
		for _, e := range list {
			a, _ := e.(map[string]any)
			id, idOK := a["id"].(string)
			label, labelOK := a["label"].(string)
			to, toOK := a["to"].(string)
			if !idOK || !labelOK || !toOK || id == "" || to == "" {
				continue
			}
			text, _ := a["text"].(string)
			if text != "none" && text != "optional" && text != "required" {
				text = "optional"
			}
			kept = append(kept, HumanAction{id, label, to, text})
		}
		out[status] = kept
	}
	return out
}

// itsaRepos is the file's itsa.repos as src/settings.ts reads it: each entry with a non-empty string path, as its real path.
func itsaRepos(v any) map[string]string {
	out := map[string]string{}
	m, _ := v.(map[string]any)
	for name, p := range m {
		if path, ok := p.(string); ok && path != "" {
			if real, err := filepath.EvalSymlinks(path); err == nil {
				path = real
			}
			out[name] = path
		}
	}
	return out
}

// SettingsFile is STAM_HOME/settings.json, read again when its size or mtime changes. A file that fails to parse keeps
// the last good value (the defaults before one), as src/settings.ts does, and is read again on the next call.
type SettingsFile struct {
	path    string
	machine string

	mu   sync.Mutex
	key  fileKey
	good Settings
	ok   bool
	// costWarned is the cost.accounts problem last logged, so each distinct problem is logged once.
	costWarned string
}

type fileKey struct {
	size  int64
	mtime time.Time
}

// NewSettingsFile returns the settings of home on machine.
func NewSettingsFile(home, machine string) *SettingsFile {
	return &SettingsFile{path: filepath.Join(home, "settings.json"), machine: machine}
}

// Get returns the current settings.
func (f *SettingsFile) Get() Settings {
	f.mu.Lock()
	defer f.mu.Unlock()
	info, err := os.Stat(f.path)
	var key fileKey
	if err == nil {
		key = fileKey{size: info.Size(), mtime: info.ModTime()}
	}
	if f.ok && key == f.key {
		return f.good
	}
	data, err := os.ReadFile(f.path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		slog.Warn("settings.json unreadable; keeping the last good settings", "err", err)
		return f.fallback()
	}
	s, err := ParseSettings(data, f.machine)
	if err != nil {
		// The parse error can quote the file, which holds peers' tokens: log only that it failed.
		slog.Warn("settings.json is not valid JSON; keeping the last good settings")
		return f.fallback()
	}
	f.key, f.good, f.ok = key, s, true
	if s.CostProblem != f.costWarned && s.CostProblem != "" {
		slog.Warn("settings.json cost.accounts is invalid; no agent bills to an account", "problem", s.CostProblem)
	}
	f.costWarned = s.CostProblem
	return s
}

func (f *SettingsFile) fallback() Settings {
	if f.ok {
		return f.good
	}
	s, _ := ParseSettings(nil, f.machine)
	return s
}

// providerParses is whether src/llm/index.ts registers a settings.providers entry: parseProviderConfig (src/llm/openai.ts) or
// parseBedrockConfig (src/llm/bedrock.ts) accepts it. An entry neither accepts is skipped, so a model naming it is not a
// provider's.
func providerParses(v any) bool {
	o, ok := v.(map[string]any)
	if !ok {
		return false
	}
	str := func(k string) string {
		s, _ := o[k].(string)
		return jsjson.Trim(s)
	}
	switch o["kind"] {
	case "openai-compatible":
		return str("baseUrl") != ""
	case "azure":
		return str("endpoint") != "" && str("apiVersion") != ""
	case "bedrock":
		region := str("region")
		if region == "" {
			return false
		}
		for _, c := range region {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
		return str("endpoint") == "" || endpointOrigin(str("endpoint"))
	}
	return false
}

// endpointOrigin is whether src/llm/bedrock.ts endpointOrigin gives an origin: https with no userinfo, path, query or
// fragment (plain http only on the loopback).
func endpointOrigin(v string) bool {
	u, err := url.Parse(v)
	if err != nil || u.Host == "" {
		return false
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if !(u.Scheme == "https" || (u.Scheme == "http" && loopback)) {
		return false
	}
	return u.User == nil && (u.Path == "" || u.Path == "/") && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && !strings.Contains(v, "#")
}

// RequirementsSettings is settings.requirements besides `enabled`.
type RequirementsSettings struct {
	// Approval is who approves a draft into force: human, cos or any.
	Approval string
	// KeyPrefix is the letters before a requirement's number (R-1).
	KeyPrefix string
	// DemoteMinFlags is how many `violates` verdicts a requirement needs before false positives demote it.
	DemoteMinFlags   int
	DefaultThreshold float64
	DefaultMode      string
	// DailyCapUsd is what requirement checks may spend in a UTC day.
	DailyCapUsd float64
}

var reReqKeyPrefix = regexp.MustCompile(`^[A-Za-z]+$`)

func requirementsSettings(approval, prefix, minFlags, threshold, mode, cap any) RequirementsSettings {
	r := RequirementsSettings{Approval: "human", KeyPrefix: "R", DemoteMinFlags: 5, DefaultThreshold: 0.8, DefaultMode: "observe", DailyCapUsd: 1}
	if n, ok := cap.(float64); ok && n >= 0 {
		r.DailyCapUsd = n
	}
	if a, ok := approval.(string); ok && (a == "human" || a == "cos" || a == "any") {
		r.Approval = a
	}
	if p, ok := prefix.(string); ok && reReqKeyPrefix.MatchString(p) {
		r.KeyPrefix = p
	}
	if n, ok := minFlags.(float64); ok && n == float64(int(n)) && n >= 1 {
		r.DemoteMinFlags = int(n)
	}
	if n, ok := threshold.(float64); ok && n >= 0 && n <= 1 {
		r.DefaultThreshold = n
	}
	if m, ok := mode.(string); ok && (m == "observe" || m == "inform" || m == "enforce") {
		r.DefaultMode = m
	}
	return r
}

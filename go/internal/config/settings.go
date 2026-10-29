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
// A non-home daemon reads every key but its machine-local ones from the home's shared cache (settings_shared.go). Not
// yet ported: every key no Go route reads.
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
	// CostOnError is cost.onError, the action for an error blocker on an account without its own: soft-stop by default,
	// nil when the file sets it to null or to something that isn't an action.
	CostOnError *CostAction
	// CostInstructions is cost.instructions, the user's free-text cost instructions; "" when unset or not a string.
	CostInstructions string
	// CostFallbackMinutes is cost.fallbackMinutes: how long a cost notice waits for its manager before the fallback
	// runs, a number, else 15.
	CostFallbackMinutes float64
	// CostSoftStopMinutes is cost.softStopMinutes: how long cost_switch lets a working agent finish its step before the
	// interrupt, a number, else 10.
	CostSoftStopMinutes float64
	// MailGate is decisions.mailGate: an agent's mail to the human is checked by the decision model (S-983). On unless
	// the file says false.
	MailGate  bool
	HumanMail HumanMailSettings
	// Tiny are the tiny-step models' keys (settings_tiny.go).
	Tiny TinySettings
	// SearchOff is search.embedder 'off': search by keyword only (src/embed.ts provider). Any other value is the local
	// embedder, the default.
	SearchOff bool
	// RequirementsEnabled is requirements.enabled: the requirement checks run on ITSA changes. Off unless the file says true.
	RequirementsEnabled bool
	// Requirements are the rest of settings.requirements (src/settings.ts), with its defaults.
	Requirements RequirementsSettings
	// DecisionsModel is settings.decisions.model: the decision model stam asks, `provider:model` or an OpenRouter id.
	DecisionsModel string
	// ProviderIDs are the keys of settings.providers: the configured providers a model name may start with.
	ProviderIDs []string
	// ProviderNames are every key of settings.providers, parsed or not (Object.hasOwn(settings().providers, id)), sorted:
	// an OpenCode account whose match.model is `ID/...` for one of them is billed by it (src/accounts.ts
	// payPerTokenProvider).
	ProviderNames []string
	// ProviderKeySecrets is each provider's apiKey reference, settings.providers[id].apiKey.secret, by id: the secret a
	// key test of that provider uses (src/llm/index.ts testTargets).
	ProviderKeySecrets map[string]string
	// Providers is settings.providers as the file holds it, an object, else nil: the model layer builds its adapters from
	// it (src/llm/index.ts sync).
	Providers map[string]any
	// ProviderOrder is Providers' keys in the file's order, as Object.entries reads them: the OpenCode adapter writes its
	// provider blocks in it (src/adapters/opencode-providers.ts).
	ProviderOrder []string
	// GlobalBudget is cost.global.budget, the budget over all paid spend; nil when unset.
	GlobalBudget *CostBudget
	// GlobalOnExhausted is cost.global.onExhausted, the fallback action for the global budget's blocker; "" when unset
	// or not a string.
	GlobalOnExhausted string
	// OpenRouterWarnUSD is cost.openrouterWarnUsd, the OpenRouter balance below which the human hears once per top-up
	// (src/credits.ts): 2 by default, 0 for never (null, or a value that isn't a number).
	OpenRouterWarnUSD float64
	// OpenRouterSystemReserveUSD is cost.openrouterSystemReserveUsd, the dollars of the shared OpenRouter credit kept for
	// stam's own calls when openrouter-system has no budget (src/budgets.ts systemReserve): 1 unless a number.
	OpenRouterSystemReserveUSD float64
	// SubscriptionWarnPercent is cost.subscriptionWarnPercent, the window percentages that warn the managers and the
	// human once per window and reset (src/usage.ts reportSubscription): [80, 95] by default. Entries that aren't numbers
	// are dropped, and a value that isn't an array warns at none (TS would throw out of the report, or compare a string).
	SubscriptionWarnPercent []float64
	// DailyWarnUSD is cost.dailyWarnUsd, today's agent spend that mails the human once a day (src/usage.ts
	// checkDailySpend): 0 for never, the default, and for a value that isn't a number (TS would compare a string).
	DailyWarnUSD float64
	// McpServers is settings.mcpServers as the file holds it, in its key order (an object, or an array, which TS's
	// Object.entries reads by index); nil when it is missing or not an object (src/settings.ts).
	McpServers jsjson.Value
	Diff       DiffSettings
	// FilesRoots is files.roots: the folders the human's Files API may read on this machine (S-1525, src/files.ts), the
	// non-blank strings of the array; nil when the file sets none, which means the default roots.
	FilesRoots []string
	// ChildNotices is what a new agent hears of its children: turn, tree-idle or none, else tree-idle.
	ChildNotices string
	// DeveloperCap is settings.developerCap: how many developers run on a machine at once, 0 for no cap, else 6.
	DeveloperCap int
	// PermissionModes is settings.permissionModes: the mode per harness (claude, codex and opencode auto by default) and
	// per agent type, each default, auto or bypass; any other value is dropped.
	PermissionModes PermissionModes
	// SpawnDefaults is what a spawn with no harness, model, preset or type gets (preset standard, cwd ~).
	SpawnDefaults SpawnDefaults
	// StartingTimeoutMinutes is how long an agent may stay starting with no harness process before it is marked
	// stopped: a positive number, else 10.
	StartingTimeoutMinutes float64
	// StuckStartMinutes is settings.stuckStartMinutes (S-3250): an agent still starting with a live harness this many
	// minutes after its launch never reached a turn, so it is restarted once, then errored. A number from 0 (off), else 15.
	StuckStartMinutes float64
	// Peers is settings.peers: the other machines' daemons (src/peers.ts).
	Peers []Peer
	// StaleWorkingMinutes is how long a working agent at its prompt may go without a hook before its turn is taken to
	// have ended: a positive number, else 10.
	StaleWorkingMinutes float64
	// Banners is settings.banners: harness menus that pop up over an idle agent's input and block delivery, and the keys
	// that dismiss one. A list replaces the default; an entry without a string harness and match is dropped.
	Banners []Banner
	// DialogEscalateMinutes is how long a harness dialog waits on the agent's parent and the chief of staff before it
	// goes to the human (src/permissions.ts escalateStaleDialogs): a number of at least 0, else 10.
	DialogEscalateMinutes float64
	// FinalRoundMinutes is settings.archive.finalRoundMinutes: how long a stop waits for the agent's final round, a
	// number of at least 0, else 3.
	FinalRoundMinutes float64
	// RetroReminders is settings.retro.reminders.enabled: on unless the file says false.
	RetroReminders bool
	// RetroLessons is settings.retro.lessons (S-725): the k retro items nearest an agent's task, at spawn and after a
	// compaction. On unless the file says false; k an integer clamped to 1-8, else 4.
	RetroLessons   RetroLessons
	Context        ContextSettings
	IdleCompaction IdleCompactionSettings
	ExitRecovery   ExitRecoverySettings
	// Process is settings.process (S-946): what a stage entry does.
	Process ProcessSettings
	// CostShape is cost.accounts' order and match objects and cost.display.prices (costshape.go).
	CostShape CostShape
	// ResourceWarn is settings.resourceWarn (resourcewarn.go).
	ResourceWarn ResourceWarn
}

// ProcessSettings is settings.process: Run is off, dry-run or on, else dry-run; MaxSpawnsPerHour is an integer of at least 0,
// else 3.
type ProcessSettings struct {
	Run              string
	MaxSpawnsPerHour int
}

// CostAccount is one cost account: the harness, and the model prefix when it names one, it matches; paid (nil unless
// the file gives a boolean); the provider it names, nil for none; lowCreditsUsd, the balance a credits-out clears at
// (nil unless the file gives a number); and the actions its fields name (onSubExhausted, onBudgetExhausted,
// onCreditsOut, onBillingUnknown, onError), by field.
type CostAccount struct {
	Harness       string
	Model         *string
	Paid          *bool
	Provider      *string
	LowCreditsUSD *float64
	Actions       map[string]CostAction
	// Budget is the account's budget, nil when unset.
	Budget *CostBudget
}

// CostBudget is src/settings.ts CostBudget: paid dollars per period (day, week or month in UTC, or cap for all time).
// TS doesn't check a budget: USD is NaN when the file's usd isn't a number, which no spend reaches, and Per is "" when
// per isn't a string, which counts by the day as periodStart does. RaiseSteps keeps the numbers of raiseSteps.
type CostBudget struct {
	USD        float64
	Per        string
	RaiseSteps []float64
}

// parseBudget reads a budget: an object, else none. TS takes any value that isn't null; one that isn't an object has
// no usd, so it never counts as spent there, and it counts as none here.
func parseBudget(v any) *CostBudget {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	b := &CostBudget{USD: math.NaN()}
	if usd, ok := m["usd"].(float64); ok {
		b.USD = usd
	}
	b.Per, _ = m["per"].(string)
	steps, _ := m["raiseSteps"].([]any)
	for _, x := range steps {
		if n, ok := x.(float64); ok {
			b.RaiseSteps = append(b.RaiseSteps, n)
		}
	}
	return b
}

// CostAction is src/settings.ts CostAction: an action name, or an object with its take-over targets and the action
// after them. A bare name has no targets and else wait. The names aren't checked here (src/accounts.ts validate does,
// and refuses the file); an unknown one works as wait where it runs.
type CostAction struct {
	Action string
	To     []string
	Else   string
}

// costActionFields is src/accounts.ts ACTION_FIELDS.
var costActionFields = []string{"onSubExhausted", "onBudgetExhausted", "onCreditsOut", "onBillingUnknown", "onError"}

// parseAction reads one action field: a string, or an object with a string action. Anything else, null included, is
// none.
func parseAction(v any) (CostAction, bool) {
	switch a := v.(type) {
	case string:
		return CostAction{Action: a, Else: "wait"}, true
	case map[string]any:
		name, ok := a["action"].(string)
		if !ok {
			return CostAction{}, false
		}
		out := CostAction{Action: name, Else: "wait"}
		if e, ok := a["else"].(string); ok {
			out.Else = e
		}
		to, _ := a["to"].([]any)
		for _, t := range to {
			if s, ok := t.(string); ok {
				out.To = append(out.To, s)
			}
		}
		return out, true
	}
	return CostAction{}, false
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
		if low, ok := acct["lowCreditsUsd"].(float64); ok {
			a.LowCreditsUSD = &low
		}
		a.Budget = parseBudget(acct["budget"])
		for _, field := range costActionFields {
			if action, ok := parseAction(acct[field]); ok {
				if a.Actions == nil {
					a.Actions = map[string]CostAction{}
				}
				a.Actions[field] = action
			}
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
	// S-545), which wins when set. LeaseToken is the value of the peer's STAM_HOME/mcp-lease-token, the only bearer its
	// MCP lease routes accept (S-3176); a machine that leases from that peer holds it.
	Token, PeerToken, LeaseToken Secret
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
	// HarnessKeys and TypeKeys are the maps' keys in JavaScript's order: the defaults first, then the file's.
	HarnessKeys, TypeKeys []string
}

// JSON is the modes as src/settings.ts permissionModesOf gives them, {harness, types}, in its key order.
func (p PermissionModes) JSON() *jsjson.Object {
	h, t := jsjson.NewObject(), jsjson.NewObject()
	for _, k := range p.HarnessKeys {
		h.Set(k, p.Harness[k])
	}
	for _, k := range p.TypeKeys {
		t.Set(k, p.Types[k])
	}
	return jsjson.NewObject("harness", h, "types", t)
}

// parsePermissionModes is src/settings.ts permissionModesOf: only known modes survive; a harness keeps its default
// for a missing or unknown one, and a type with an unknown one inherits.
func parsePermissionModes(data []byte) PermissionModes {
	p := PermissionModes{
		Harness:     map[string]string{"claude": "auto", "codex": "auto", "opencode": "auto"},
		Types:       map[string]string{},
		HarnessKeys: []string{"claude", "codex", "opencode"},
	}
	root, _ := jsjson.Parse(data)
	pm, _ := member(root, "permissionModes")
	// The objects keep JavaScript's key order, a number-like name first.
	h, t := jsjson.NewObject(), jsjson.NewObject()
	for _, k := range p.HarnessKeys {
		h.Set(k, "auto")
	}
	for _, f := range []struct {
		key  string
		into *jsjson.Object
		m    map[string]string
	}{{"harness", h, p.Harness}, {"types", t, p.Types}} {
		v, _ := member(pm, f.key)
		src := obj(v)
		for _, k := range src.Keys() {
			v, _ := src.Get(k)
			if m, _ := v.(string); IsPermissionMode(m) {
				f.into.Set(k, m)
				f.m[k] = m
			}
		}
	}
	p.HarnessKeys, p.TypeKeys = h.Keys(), t.Keys()
	return p
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

// RetroLessons is settings.retro.lessons.
type RetroLessons struct {
	Enabled bool
	K       int
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
	// PrOpenStorage is itsa.prOpen.storage: the remote a checkout's PR branches live on besides origin, "" when unset.
	PrOpenStorage string
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
				Github  any `json:"github"`
				Repo    any `json:"repo"`
				Origin  any `json:"origin"`
				Gh      any `json:"gh"`
				Storage any `json:"storage"`
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
			Global   struct {
				Budget      any `json:"budget"`
				OnExhausted any `json:"onExhausted"`
			} `json:"global"`
			OnError                    any `json:"onError"`
			Instructions               any `json:"instructions"`
			FallbackMinutes            any `json:"fallbackMinutes"`
			SoftStopMinutes            any `json:"softStopMinutes"`
			OpenrouterWarnUsd          any `json:"openrouterWarnUsd"`
			OpenrouterSystemReserveUsd any `json:"openrouterSystemReserveUsd"`
			SubscriptionWarnPercent    any `json:"subscriptionWarnPercent"`
			DailyWarnUsd               any `json:"dailyWarnUsd"`
		} `json:"cost"`
		Providers any `json:"providers"`
		HumanMail struct {
			When   any `json:"when"`
			Models any `json:"models"`
		} `json:"humanMail"`
		Files struct {
			Roots any `json:"roots"`
		} `json:"files"`
		// Diff is type-checked by key, as TS reads it, so a wrong type there costs only its own defaults.
		Diff any `json:"diff"`
		ChildNotices    any `json:"childNotices"`
		DeveloperCap    any `json:"developerCap"`
		PermissionModes struct {
			Harness any `json:"harness"`
			Types   any `json:"types"`
		} `json:"permissionModes"`
		SpawnDefaults          map[string]any `json:"spawnDefaults"`
		StartingTimeoutMinutes any            `json:"startingTimeoutMinutes"`
		StuckStartMinutes      any            `json:"stuckStartMinutes"`
		Peers                  any            `json:"peers"`
		StaleWorkingMinutes    any            `json:"staleWorkingMinutes"`
		DialogEscalateMinutes  any            `json:"dialogEscalateMinutes"`
		Banners                any            `json:"banners"`
		Archive                struct {
			FinalRoundMinutes any `json:"finalRoundMinutes"`
		} `json:"archive"`
		Retro struct {
			Reminders struct {
				Enabled any `json:"enabled"`
			} `json:"reminders"`
			Lessons struct {
				Enabled any `json:"enabled"`
				K       any `json:"k"`
			} `json:"lessons"`
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
		Search struct {
			Embedder any `json:"embedder"`
		} `json:"search"`
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
		Itsa:      ItsaSettings{Required: user.Itsa.Required != false, KeyPrefix: or(str(user.Itsa.KeyPrefix), "S"), Statuses: itsaStatuses(user.Itsa.Statuses), Actions: itsaActions(user.Itsa.Actions), Repos: itsaRepos(user.Itsa.Repos), MainBranch: or(str(user.Itsa.MainBranch), "main"), PrOpenGithub: str(user.Itsa.PrOpen.Github), PrOpenRepo: str(user.Itsa.PrOpen.Repo), PrOpenOrigin: or(str(user.Itsa.PrOpen.Origin), "origin"), PrOpenGh: or(str(user.Itsa.PrOpen.Gh), "gh"), PrOpenStorage: str(user.Itsa.PrOpen.Storage), OwnerNotices: user.Itsa.OwnerNotices != "off"},
		CostMode:  "api",
		MailGate:  user.Decisions.MailGate != false,
		SearchOff: user.Search.Embedder == "off",

		RequirementsEnabled: user.Requirements.Enabled == true,
		Requirements:        requirementsSettings(user.Requirements.Approval, user.Requirements.KeyPrefix, user.Requirements.DemoteMinFlags, user.Requirements.DefaultThreshold, user.Requirements.DefaultMode, user.Requirements.DailyCapUsd),
		DecisionsModel:      or(str(user.Decisions.Model), "microsoft/microsoft-decision-1"),
	}
	if m, ok := user.Providers.(map[string]any); ok {
		s.Providers = m
		for id, v := range m {
			if ProviderParses(v) {
				s.ProviderIDs = append(s.ProviderIDs, id)
			}
		}
	}
	sort.Strings(s.ProviderIDs)
	if m, ok := user.Providers.(map[string]any); ok {
		for id, v := range m {
			s.ProviderNames = append(s.ProviderNames, id)
			if p, ok := v.(map[string]any); ok {
				if k, ok := p["apiKey"].(map[string]any); ok {
					if name, ok := k["secret"].(string); ok {
						if s.ProviderKeySecrets == nil {
							s.ProviderKeySecrets = map[string]string{}
						}
						s.ProviderKeySecrets[id] = name
					}
				}
			}
		}
	}
	sort.Strings(s.ProviderNames)
	s.GlobalBudget = parseBudget(user.Cost.Global.Budget)
	s.GlobalOnExhausted = str(user.Cost.Global.OnExhausted)
	s.ResourceWarn = parseResourceWarn(data)
	s.Tiny = parseTiny(data)
	s.Home = or(str(user.Home), or(str(user.Itsa.Home), machine))
	s.Itsa.Home = s.Home
	if m := str(user.Cost.Display.Mode); costModes[m] {
		s.CostMode = m
	}
	s.CostAccounts, s.CostProblem = parseAccounts(user.Cost.Accounts)
	s.CostShape = parseCostShape(data, s.CostAccounts)
	// `{ ...DEFAULTS.cost, ...user.cost }`: onError is soft-stop unless the file names the key, even as null.
	soft := CostAction{Action: "soft-stop", Else: "wait"}
	s.CostOnError = &soft
	var keys struct {
		Cost map[string]json.RawMessage `json:"cost"`
	}
	if len(data) > 0 && json.Unmarshal(data, &keys) == nil {
		if _, named := keys.Cost["onError"]; named {
			s.CostOnError = nil
			if action, ok := parseAction(user.Cost.OnError); ok {
				s.CostOnError = &action
			}
		}
	}
	s.CostInstructions = str(user.Cost.Instructions)
	// `{ ...DEFAULTS.cost, ...user.cost }` keeps 2 unless the file names the key; credits.ts warns only on a truthy
	// threshold, so null is never. A value that isn't a number counts as never here (TS would compare a string).
	s.OpenRouterWarnUSD = 2
	if _, named := keys.Cost["openrouterWarnUsd"]; named {
		s.OpenRouterWarnUSD, _ = user.Cost.OpenrouterWarnUsd.(float64)
	}
	s.OpenRouterSystemReserveUSD = 1
	if r, ok := user.Cost.OpenrouterSystemReserveUsd.(float64); ok {
		s.OpenRouterSystemReserveUSD = r
	}
	s.SubscriptionWarnPercent = []float64{80, 95}
	if _, named := keys.Cost["subscriptionWarnPercent"]; named {
		s.SubscriptionWarnPercent = nil
		list, _ := user.Cost.SubscriptionWarnPercent.([]any)
		for _, v := range list {
			if n, ok := v.(float64); ok {
				s.SubscriptionWarnPercent = append(s.SubscriptionWarnPercent, n)
			}
		}
	}
	s.DailyWarnUSD, _ = user.Cost.DailyWarnUsd.(float64)
	s.CostFallbackMinutes = 15
	if m, ok := user.Cost.FallbackMinutes.(float64); ok {
		s.CostFallbackMinutes = m
	}
	s.CostSoftStopMinutes = 10
	if m, ok := user.Cost.SoftStopMinutes.(float64); ok {
		s.CostSoftStopMinutes = m
	}
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
	s.Diff = parseDiff(user.Diff)
	if roots, ok := user.Files.Roots.([]any); ok {
		s.FilesRoots = []string{}
		for _, r := range roots {
			if r, ok := r.(string); ok && strings.TrimSpace(r) != "" {
				s.FilesRoots = append(s.FilesRoots, r)
			}
		}
	}
	s.ChildNotices = "tree-idle"
	if c := str(user.ChildNotices); c == "turn" || c == "tree-idle" || c == "none" {
		s.ChildNotices = c
	}
	// Number.isInteger(n) && n >= 0, else the default.
	s.DeveloperCap = 6
	if n, ok := user.DeveloperCap.(float64); ok && n >= 0 && n == math.Trunc(n) && n <= math.MaxInt32 {
		s.DeveloperCap = int(n)
	}
	s.PermissionModes = parsePermissionModes(data)
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
				s.Peers = append(s.Peers, Peer{Name: str(m["name"]), URL: str(m["url"]), Token: Secret(str(m["token"])), PeerToken: Secret(str(m["peerToken"])), LeaseToken: Secret(str(m["leaseToken"])), Start: str(m["start"]), Deploy: str(m["deploy"])})
			}
		}
	}
	s.StartingTimeoutMinutes = 10
	if n, ok := user.StartingTimeoutMinutes.(float64); ok && n > 0 {
		s.StartingTimeoutMinutes = n
	}
	s.StuckStartMinutes = 15
	if n, ok := user.StuckStartMinutes.(float64); ok && n >= 0 {
		s.StuckStartMinutes = n
	}
	s.StaleWorkingMinutes = 10
	if n, ok := user.StaleWorkingMinutes.(float64); ok && n > 0 {
		s.StaleWorkingMinutes = n
	}
	s.Banners = parseBanners(user.Banners)
	s.DialogEscalateMinutes = 10
	if n, ok := user.DialogEscalateMinutes.(float64); ok && n >= 0 {
		s.DialogEscalateMinutes = n
	}
	s.FinalRoundMinutes = 3
	if n, ok := user.Archive.FinalRoundMinutes.(float64); ok && n >= 0 {
		s.FinalRoundMinutes = n
	}
	s.RetroReminders = user.Retro.Reminders.Enabled != false
	s.RetroLessons = RetroLessons{Enabled: user.Retro.Lessons.Enabled != false, K: 4}
	if k, ok := user.Retro.Lessons.K.(float64); ok && k == math.Trunc(k) && !math.IsInf(k, 0) {
		s.RetroLessons.K = int(math.Min(8, math.Max(1, k)))
	}
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
			if p, ok := o.Get("providers"); ok {
				if po, ok := p.(*jsjson.Object); ok && s.Providers != nil {
					s.ProviderOrder = po.Keys()
				}
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

	// wmu makes each write one read-modify-write (Update): two writers never interleave, so none loses another's change.
	wmu sync.Mutex
	mu  sync.Mutex
	// key and sharedKey are the stat of settings.json and of the shared cache good was read from.
	key       fileKey
	sharedKey fileKey
	good      Settings
	ok        bool
	// costWarned is the cost.accounts problem last logged, so each distinct problem is logged once.
	costWarned string
	// listeners are told after a write (OnChange); reloaded after each read of a changed file (OnReload).
	listeners []func()
	reloaded  []func(Settings)
	// reload orders the reads: a Get that read a changed file runs its OnReload hooks before any later Get returns, so
	// none acts on a newer state (local login back on) before an earlier one's hooks (sessions ended) have run. Lock
	// order: wmu, reload, mu. A hook never reaches back into the settings: it would wait for itself.
	reload sync.Mutex
}

// ReloadPause, when set, runs in a Get between reading a changed file and its OnReload hooks: a test holds a read there.
var ReloadPause func()

type fileKey struct {
	size  int64
	mtime time.Time
}

// NewSettingsFile returns the settings of home on machine.
func NewSettingsFile(home, machine string) *SettingsFile {
	return &SettingsFile{path: filepath.Join(home, "settings.json"), machine: machine}
}

// Get returns the current settings. When it read them again from a changed file, the OnReload listeners are told
// before it, or any later Get, returns (reload).
func (f *SettingsFile) Get() Settings {
	f.reload.Lock()
	defer f.reload.Unlock()
	s, fresh := f.get()
	if fresh {
		if ReloadPause != nil {
			ReloadPause()
		}
		f.mu.Lock()
		reloaded := append([]func(Settings){}, f.reloaded...)
		f.mu.Unlock()
		for _, fn := range reloaded {
			fn(s)
		}
	}
	return s
}

// OnReload calls fn with the settings each time Get reads them again from a changed file: a hand edit is seen at the
// next read, a write here too. fn runs under the reload lock and must not read or write the settings.
func (f *SettingsFile) OnReload(fn func(Settings)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reloaded = append(f.reloaded, fn)
}

// get is Get's read: the settings, and whether they were read again from the file.
func (f *SettingsFile) get() (Settings, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key, sharedKey := statKey(f.path), statKey(f.SharedPath())
	if f.ok && key == f.key && sharedKey == f.sharedKey {
		return f.good, false
	}
	data, err := os.ReadFile(f.path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		slog.Warn("settings.json unreadable; keeping the last good settings", "err", err)
		return f.fallback(), false
	}
	// A file that is there but empty is not valid JSON, as TS reads it: most often one caught mid-rewrite, whose
	// defaults would turn auth.localHuman off and end every login.
	if err == nil && len(data) == 0 {
		slog.Warn("settings.json is not valid JSON; keeping the last good settings")
		return f.fallback(), false
	}
	// A non-home daemon reads shared keys from the cache, with only its local keys from the file. No cache yet: the file
	// whole, so nothing changes until a cache is written.
	if user, perr := jsjson.Parse(data); len(data) > 0 && perr == nil && homeOf(user, f.machine) != f.machine {
		if cached, cerr := os.ReadFile(f.SharedPath()); cerr == nil {
			cache := parseSharedCache(cached)
			// A corrupt cache keeps the last good value if it was for this home, kept under the current stat key so it
			// isn't read again on every call.
			if cache == nil && f.ok && f.good.Home == homeOf(user, f.machine) {
				slog.Warn("settings.shared.json is not valid JSON; keeping the last good settings")
				f.key, f.sharedKey = key, sharedKey
				return f.good, false
			}
			if cache != nil {
				data = []byte(Text(merged(cache.Settings, user)))
			}
		}
	}
	s, err := ParseSettings(data, f.machine)
	if err != nil {
		// The parse error can quote the file, which holds peers' tokens: log only that it failed.
		slog.Warn("settings.json is not valid JSON; keeping the last good settings")
		return f.fallback(), false
	}
	f.key, f.sharedKey, f.good, f.ok = key, sharedKey, s, true
	if s.CostProblem != f.costWarned && s.CostProblem != "" {
		slog.Warn("settings.json cost.accounts is invalid; no agent bills to an account", "problem", s.CostProblem)
	}
	f.costWarned = s.CostProblem
	return s, true
}

func (f *SettingsFile) fallback() Settings {
	if f.ok {
		return f.good
	}
	s, _ := ParseSettings(nil, f.machine)
	return s
}

// ProviderParses is whether src/llm/index.ts registers a settings.providers entry: parseProviderConfig (src/llm/openai.ts) or
// parseBedrockConfig (src/llm/bedrock.ts) accepts it. An entry neither accepts is skipped, so a model naming it is not a
// provider's.
func ProviderParses(v any) bool {
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
	_, ok := EndpointOrigin(v)
	return ok
}

// EndpointOrigin is src/llm/bedrock.ts endpointOrigin: an endpoint as an origin, https with no userinfo, path, query or
// fragment (plain http only on the loopback). The origin is the URL's: its host lowercased and a default port dropped.
func EndpointOrigin(v string) (string, bool) {
	u, err := url.Parse(v)
	if err != nil || u.Host == "" {
		return "", false
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if !(u.Scheme == "https" || (u.Scheme == "http" && loopback)) {
		return "", false
	}
	if !(u.User == nil && (u.Path == "" || u.Path == "/") && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && !strings.Contains(v, "#")) {
		return "", false
	}
	host := strings.ToLower(u.Host)
	if p := u.Port(); (u.Scheme == "https" && p == "443") || (u.Scheme == "http" && p == "80") {
		host = strings.TrimSuffix(host, ":"+p)
	}
	return u.Scheme + "://" + host, true
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

// Banner is one entry of settings.banners: on an idle agent of the harness whose screen matches Match (a regular
// expression), stam sends Keys. Match is Go's RE2, where \s is ASCII whitespace only: it misses the no-break space
// Claude Code draws after its marks, which JavaScript's \s matches, so such a pattern never matches here (it fails
// closed: no keys are sent). Write [\s\x{00a0}] where a no-break space may come.
type Banner struct {
	Harness string   `json:"harness"`
	Match   string   `json:"match"`
	Keys    []string `json:"keys"`
}

// defaultBanners is src/settings.ts DEFAULTS.banners. Escape cancels a menu without touching a draft.
var defaultBanners = []Banner{{Harness: "claude", Match: `Teach auto mode about your environment\?`, Keys: []string{"Escape"}}}

// parseBanners is `Array.isArray(user.banners) ? user.banners : DEFAULTS.banners`, keeping only entries this daemon can
// act on: a string harness and match, and the string keys.
func parseBanners(v any) []Banner {
	list, ok := v.([]any)
	if !ok {
		return defaultBanners
	}
	out := []Banner{}
	for _, e := range list {
		o, _ := e.(map[string]any)
		h, hok := o["harness"].(string)
		m, mok := o["match"].(string)
		if !hok || !mok {
			continue
		}
		b := Banner{Harness: h, Match: m, Keys: []string{}}
		keys, _ := o["keys"].([]any)
		for _, k := range keys {
			if k, ok := k.(string); ok {
				b.Keys = append(b.Keys, k)
			}
		}
		out = append(out, b)
	}
	return out
}

// DiffSettings is settings.diff, the PR diff API (S-1530, src/diff.ts), with src/settings.ts's defaults.
type DiffSettings struct {
	// Classes are the file patterns per class (tests, lockfiles, generated, docs), which the viewer's "meat" mode hides. A
	// class the file gives as an array takes its non-blank strings; any other class keeps its default.
	Classes map[string][]string
	// FetchSeconds is the longest a git fetch of a PR may run: a number over 0, else 60.
	FetchSeconds float64
	// RefreshSeconds is how long a fetched head is reused: a number from 0, else 20.
	RefreshSeconds float64
	// MaxPrRefs is how many PRs the cache repo keeps: a number from 1, floored, else 100.
	MaxPrRefs int
}

// DiffClassDefaults are src/settings.ts DEFAULTS.diff.classes.
var DiffClassDefaults = map[string][]string{
	"tests":     {"test/", "tests/", "__tests__/", "fixtures/", "__snapshots__/", "*.test.*", "*.spec.*", "*.snap"},
	"lockfiles": {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "Cargo.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "go.sum", "Gemfile.lock", "composer.lock"},
	"generated": {"dist/", "build/", "vendor/", "node_modules/", "*.min.*", "*.map"},
	"docs":      {"docs/", "*.md"},
}

// parseDiff is src/settings.ts's diff: each key type-checked alone, so a wrong type there (`diff: []`, `classes: "x"`)
// costs only its own defaults, and a null refreshSeconds (0) is told from a missing one (the default).
func parseDiff(raw any) DiffSettings {
	d := DiffSettings{Classes: map[string][]string{}, FetchSeconds: 60, RefreshSeconds: 20, MaxPrRefs: 100}
	user, _ := raw.(map[string]any)
	classes, _ := user["classes"].(map[string]any)
	fetch, maxRefs := user["fetchSeconds"], user["maxPrRefs"]
	refresh, hasRefresh := user["refreshSeconds"]
	for k, def := range DiffClassDefaults {
		list, ok := classes[k].([]any)
		if !ok {
			d.Classes[k] = def
			continue
		}
		d.Classes[k] = []string{}
		for _, x := range list {
			if x, ok := x.(string); ok && jsjson.Trim(x) != "" {
				d.Classes[k] = append(d.Classes[k], x)
			}
		}
	}
	if n := jsjson.ToNumber(fetch); n > 0 {
		d.FetchSeconds = n
	}
	if hasRefresh {
		if n := jsjson.ToNumber(refresh); n >= 0 {
			d.RefreshSeconds = n
		}
	}
	if n := jsjson.ToNumber(maxRefs); n >= 1 {
		d.MaxPrRefs = int(math.Min(math.Floor(n), math.MaxInt32))
	}
	return d
}

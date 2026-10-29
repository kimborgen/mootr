package config

import (
	"math"
	"regexp"
	"strings"

	"stam/internal/jsjson"
)

// The settings write path of src/settings.ts (S-3071): the text a patch makes, the checks a file must pass before it is
// written, and the redacted text an agent reads. Everything here is pure; SettingsFile writes.

// LocalKeys is src/settings.ts LOCAL_KEYS: the settings that belong to this machine only (S-380), as dotted paths.
var LocalKeys = []string{"home", "peers", "itsa.home", "itsa.repos", "search.embedder", "debug.stallMs", "files.roots", "auth.humanStrict", "auth.localHuman", "resourceWarn.lastWarned", "retro.lastDigest"}

// viewRecords is src/settings.ts VIEW_RECORDS: settings whose value is a record of views keyed by id, which a patch
// merges per id (S-293).
var viewRecords = map[string]bool{"boardViews": true, "workViews": true, "sidebarCols": true, "sidebarPanes": true, "motion": true, "cardLayouts": true, "agentsTableCols": true}

// daemonOwned is src/settings.ts DAEMON_OWNED: the sub-keys the daemon writes itself; a patch that replaces their
// top-level key keeps the file's value for them.
var daemonOwned = [][2]string{{"retro", "lastDigest"}, {"resourceWarn", "lastWarned"}}

// Problem is src/settings.ts PatchProblem: why a settings file is refused, and which part of it.
type Problem struct {
	Field   string
	Problem string
}

// Error is the route's 400 message.
func (p *Problem) Error() string { return p.Field + " config rejected: " + p.Problem }

// Redacted is src/settings.ts REDACTED.
const Redacted = redacted

var (
	secretKey  = regexp.MustCompile(`(?i)(token|secret|password|apikey|api_key|authorization)$`)
	reqPrefix  = regexp.MustCompile(`^[A-Za-z]+$`)
	costModeOf = []string{"api", "five_hour", "seven_day", "subscription"}
	actionsOf  = []string{"continue", "soft-stop", "hard-stop", "wait", "take-over"}
)

// obj is the value as an object, nil when it isn't one.
func obj(v jsjson.Value) *jsjson.Object {
	o, _ := v.(*jsjson.Object)
	return o
}

// member is `v?.[k]`: undefined (absent) when v is no object or lacks k.
func member(v jsjson.Value, k string) (jsjson.Value, bool) {
	return obj(v).Get(k)
}

// pairs is Object.entries of an object or an array; nothing for any other value.
func pairs(v jsjson.Value) [][2]any {
	var out [][2]any
	switch x := v.(type) {
	case *jsjson.Object:
		for _, k := range x.Keys() {
			e, _ := x.Get(k)
			out = append(out, [2]any{k, e})
		}
	case []jsjson.Value:
		for i, e := range x {
			out = append(out, [2]any{jsjson.Number(float64(i)), e})
		}
	}
	return out
}

// isObject is `v && typeof v === 'object'`: an object or an array.
func isObject(v jsjson.Value) bool {
	switch v.(type) {
	case *jsjson.Object, []jsjson.Value:
		return true
	}
	return false
}

// spread is `{ ...v }` of an object or an array as a new object; an empty one for anything else.
func spread(v jsjson.Value) *jsjson.Object {
	out := jsjson.NewObject()
	for _, p := range pairs(v) {
		out.Set(p[0].(string), p[1])
	}
	return out
}

// ParseObject is JSON.parse of a settings text, as the patch path reads it: anything that doesn't parse to an object
// is an empty one. (TS keeps a file that is a JSON array, setting keys it then doesn't print, and throws on a number
// or string; here such a file is replaced like one that doesn't parse.)
func ParseObject(text string) *jsjson.Object {
	v, err := jsjson.Parse([]byte(text))
	if o := obj(v); err == nil && o != nil {
		return o
	}
	return jsjson.NewObject()
}

// Text is a settings object as src/settings.ts writes it: two-space JSON and a newline.
func Text(v jsjson.Value) string { return jsjson.Stringify(v, "  ") + "\n" }

// RedactValue is src/settings.ts redactValue: a parsed settings value with credentials replaced by Redacted. A key
// named like a credential, and every value of an MCP server's env and headers, is redacted; a provider's
// apiKey.secret and an MCP server's auth.client_secret.secret name a secret in the store, so a name shows.
func RedactValue(parsed jsjson.Value) jsjson.Value {
	var scrub func(v jsjson.Value) jsjson.Value
	scrub = func(v jsjson.Value) jsjson.Value {
		switch x := v.(type) {
		case []jsjson.Value:
			out := make([]jsjson.Value, len(x))
			for i, e := range x {
				out[i] = scrub(e)
			}
			return out
		case *jsjson.Object:
			out := jsjson.NewObject()
			for _, k := range x.Keys() {
				e, _ := x.Get(k)
				// A key named like a credential holds one as a value; an object under it is a container.
				if secretKey.MatchString(k) && !isObject(e) {
					out.Set(k, Redacted)
				} else {
					out.Set(k, scrub(e))
				}
			}
			return out
		}
		return v
	}
	out := scrub(parsed)
	// keepName puts back section.ID.holder.secret from parsed where it is a secret's name and the redacted copy still
	// has holder as an object.
	keepName := func(section string, holder ...string) {
		sec, _ := member(out, section)
		for _, p := range pairs(sec) {
			id := p[0].(string)
			name, _ := member(parsed, section)
			h := p[1]
			for _, k := range append([]string{id}, holder...) {
				name, _ = memberAny(name, k)
			}
			name, _ = memberAny(name, "secret")
			for _, k := range holder {
				h, _ = memberAny(h, k)
			}
			if n, ok := name.(string); ok && obj(h) != nil && secretName.MatchString(n) {
				obj(h).Set("secret", n)
			}
		}
	}
	keepName("providers", "apiKey")
	if servers, _ := member(out, "mcpServers"); isObject(servers) {
		for _, p := range pairs(servers) {
			for _, field := range []string{"env", "headers"} {
				f, _ := memberAny(p[1], field)
				switch x := f.(type) {
				case *jsjson.Object:
					for _, k := range x.Keys() {
						x.Set(k, Redacted)
					}
				case []jsjson.Value:
					for i := range x {
						x[i] = Redacted
					}
				}
			}
		}
	}
	keepName("mcpServers", "auth", "client_secret")
	return out
}

// memberAny is `v?.[k]` for an object or an array.
func memberAny(v jsjson.Value, k string) (jsjson.Value, bool) {
	for _, p := range pairs(v) {
		if p[0].(string) == k {
			return p[1], true
		}
	}
	return nil, false
}

// RedactText is src/settings.ts redactSettingsText: the settings text as an agent may read it. A text that isn't JSON
// reads as an empty object.
func RedactText(text string) string {
	v, err := jsjson.Parse([]byte(text))
	if err != nil {
		return "{}\n"
	}
	return Text(RedactValue(v))
}

// Patched is src/settings.ts patchedSettingsText: the text a patch makes over current, without writing it. A top-level
// key replaces its value, except a view record, which merges per id (null deletes a view); with fill, a view record
// only adds the ids current lacks and other keys are left alone. The daemon's own sub-keys keep current's values.
// registry is the merged registry, which the cost check resolves take-over targets in.
func Patched(current string, patch *jsjson.Object, fill bool, registry *jsjson.Object) (string, *Problem) {
	user := ParseObject(current)
	prev := jsjson.Clone(user).(*jsjson.Object)
	for _, k := range patch.Keys() {
		v, _ := patch.Get(k)
		v = jsjson.Clone(v)
		if viewRecords[k] {
			if obj(v) == nil {
				continue
			}
			had, _ := user.Get(k)
			cur := spread(had)
			next := spread(had)
			for _, id := range obj(v).Keys() {
				x, _ := obj(v).Get(id)
				if _, in := cur.Get(id); fill && in {
					continue
				}
				if x == nil {
					next.Delete(id)
				} else {
					next.Set(id, x)
				}
			}
			user.Set(k, next)
		} else if !fill {
			user.Set(k, v)
		}
	}
	if !fill {
		for _, d := range daemonOwned {
			if _, in := patch.Get(d[0]); !in {
				continue
			}
			top, _ := user.Get(d[0])
			o := obj(top)
			if o == nil {
				continue
			}
			p, _ := prev.Get(d[0])
			if had, ok := member(p, d[1]); ok {
				o.Set(d[1], had)
			} else {
				o.Delete(d[1])
			}
		}
	}
	if p := CostProblem(user, registry); p != "" {
		return "", &Problem{"cost", p}
	}
	if p := RequirementsProblem(user); p != "" {
		return "", &Problem{"requirements", p}
	}
	if p := HarnessProblem(user); p != "" {
		return "", &Problem{"harness", p}
	}
	return Text(user), nil
}

// FileProblem is src/settings.ts fileProblem: the problem in a whole settings file about to be saved, the cost config
// then settings.harness, or nil.
func FileProblem(user jsjson.Value, registry *jsjson.Object) *Problem {
	if p := CostProblem(user, registry); p != "" {
		return &Problem{"cost", p}
	}
	if p := HarnessProblem(user); p != "" {
		return &Problem{"harness", p}
	}
	return nil
}

// RequirementsProblem is src/settings.ts requirementsProblem: requirements.keyPrefix is letters only, or empty.
func RequirementsProblem(user jsjson.Value) string {
	req, _ := member(user, "requirements")
	p, ok := member(req, "keyPrefix")
	if !ok || p == nil || p == "" {
		return ""
	}
	if s, isStr := p.(string); isStr && reqPrefix.MatchString(s) {
		return ""
	}
	return "requirements.keyPrefix must be letters only, such as R"
}

// harnessKey is one key of src/settings.ts HARNESS_KEYS.
type harnessKey struct {
	name string
	ok   func(v jsjson.Value) bool
	want string
}

func ttl(v jsjson.Value) bool { return v == "5m" || v == "1h" }

func wholeIn(lo, hi float64) func(v jsjson.Value) bool {
	return func(v jsjson.Value) bool {
		f, ok := v.(float64)
		return ok && f == math.Trunc(f) && !math.IsInf(f, 0) && f >= lo && f <= hi
	}
}

// harnessKeys is src/settings.ts HARNESS_KEYS, in its order.
var harnessKeys = []struct {
	name string
	keys []harnessKey
}{
	{"claude", []harnessKey{
		{"promptCacheTtl", ttl, `"5m" or "1h"`},
		{"subagentPromptCacheTtl", ttl, `"5m" or "1h"`},
		{"idleCompaction", func(v jsjson.Value) bool { _, ok := v.(bool); return ok }, "true or false"},
		{"autoCompactWindow", wholeIn(100_000, 1_000_000), "a whole number of tokens from 100000 to 1000000"},
	}},
	{"codex", []harnessKey{
		{"model_auto_compact_token_limit", wholeIn(1, 1<<53-1), "a whole number of tokens above 0"},
	}},
}

// HarnessProblem is src/settings.ts harnessProblem: an unknown harness or key in settings.harness, or a value the
// harness wouldn't take. A missing or null key is fine.
func HarnessProblem(user jsjson.Value) string {
	h, ok := member(user, "harness")
	if !ok {
		return ""
	}
	if obj(h) == nil {
		return "harness must be an object"
	}
	names := make([]string, len(harnessKeys))
	for i, s := range harnessKeys {
		names[i] = s.name
	}
	for _, name := range obj(h).Keys() {
		keys, _ := obj(h).Get(name)
		var spec []harnessKey
		found := false
		for _, s := range harnessKeys {
			if s.name == name {
				spec, found = s.keys, true
			}
		}
		if !found {
			return "harness." + name + " is not a harness stam sets (" + strings.Join(names, ", ") + ")"
		}
		if obj(keys) == nil {
			return "harness." + name + " must be an object"
		}
		known := make([]string, len(spec))
		for i, k := range spec {
			known[i] = k.name
		}
		for _, k := range obj(keys).Keys() {
			v, _ := obj(keys).Get(k)
			var key *harnessKey
			for i := range spec {
				if spec[i].name == k {
					key = &spec[i]
				}
			}
			if key == nil {
				return "harness." + name + "." + k + " is not a setting stam passes on (" + strings.Join(known, ", ") + ")"
			}
			if v != nil && !key.ok(v) {
				return "harness." + name + "." + k + " must be " + key.want
			}
		}
	}
	return ""
}

// CostProblem is src/settings.ts costProblem: src/accounts.ts validate of `{ ...DEFAULTS.cost, ...user.cost }`, the
// first problem as a sentence, or "".
func CostProblem(user jsjson.Value, registry *jsjson.Object) string {
	userCost, _ := member(user, "cost")
	cost := jsjson.NewObject(
		"subscriptionWarnPercent", []jsjson.Value{80.0, 95.0}, "dailyWarnUsd", nil, "openrouterWarnUsd", 2.0, "openrouterSystemReserveUsd", 1.0,
		"global", nil, "accounts", jsjson.NewObject(), "onError", "soft-stop", "instructions", "", "fallbackMinutes", 15.0, "softStopMinutes", 10.0,
		"display", jsjson.NewObject("mode", "api", "prices", jsjson.NewObject()))
	for _, p := range pairs(userCost) {
		cost.Set(p[0].(string), p[1])
	}
	return validateCost(cost, registry)
}

func isNullish(v jsjson.Value, ok bool) bool { return !ok || v == nil }

func finite(v jsjson.Value) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && !math.IsNaN(f)
}

func oneOf(v jsjson.Value, list []string) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// show is src/accounts.ts show (JSON.stringify): undefined prints as undefined.
func show(v jsjson.Value, ok bool) string {
	if !ok {
		return "undefined"
	}
	return jsjson.Stringify(v, "")
}

var actionFields = []string{"onSubExhausted", "onBudgetExhausted", "onCreditsOut", "onBillingUnknown", "onError"}

// validateCost is src/accounts.ts validate.
func validateCost(cost *jsjson.Object, registry *jsjson.Object) string {
	if v, ok := cost.Get("instructions"); !isNullish(v, ok) {
		if _, s := v.(string); !s {
			return "cost.instructions must be a string"
		}
	}
	if v, ok := cost.Get("fallbackMinutes"); !isNullish(v, ok) {
		if f, fin := finite(v); !fin || f <= 0 {
			return "cost.fallbackMinutes must be a positive number"
		}
	}
	if v, ok := cost.Get("softStopMinutes"); !isNullish(v, ok) {
		if f, fin := finite(v); !fin || f < 0 {
			return "cost.softStopMinutes must be a number of minutes, 0 or more"
		}
	}
	if p := displayProblem(cost.Get("display")); p != "" {
		return p
	}
	accounts, _ := cost.Get("accounts")
	if accounts == nil {
		accounts = jsjson.NewObject()
	}
	accts := accountPairs(accounts)
	for _, a := range accts {
		m, _ := memberAny(a.v, "match")
		h, _ := memberAny(m, "harness")
		if hs, _ := h.(string); !jsjson.Truthy(m) || hs == "" {
			return "account " + a.name + " has no match.harness"
		}
		if mm, ok := memberAny(m, "model"); !isNullish(mm, ok) {
			if _, s := mm.(string); !s {
				return "account " + a.name + " has a bad match.model"
			}
		}
		if p, ok := memberAny(a.v, "provider"); !isNullish(p, ok) {
			if ps, _ := p.(string); ps == "" {
				return "account " + a.name + " has a bad provider"
			}
		}
	}
	for i := range accts {
		for j := i + 1; j < len(accts); j++ {
			if matchesOverlap(accts[i].v, accts[j].v) {
				return "accounts " + accts[i].name + " and " + accts[j].name + " both match the same harness and model"
			}
		}
	}
	c := costCheck{cost: cost, accounts: accts, registry: registry}
	for _, a := range accts {
		for _, field := range actionFields {
			action, inherited := c.effective(a, field)
			where := a.name + "." + field
			if inherited {
				where = "onError (inherited by " + a.name + ")"
			}
			if p := c.checkAction(where, action, a.name, inherited); p != "" {
				return p
			}
			paid, _ := memberAny(a.v, "paid")
			if paid != true {
				for _, n := range actionNames(action) {
					if n == "continue" {
						return where + ": continue needs paid: true on " + a.name + ", since it spends past the limit"
					}
				}
			}
		}
	}
	if g, _ := cost.Get("global"); jsjson.Truthy(g) {
		if v, ok := memberAny(g, "onExhausted"); !isNullish(v, ok) && !oneOf(v, actionsOf) {
			return "global.onExhausted: unknown action " + show(v, ok)
		}
		if v, ok := memberAny(g, "subscriptionWork"); !isNullish(v, ok) && !oneOf(v, []string{"continue", "stop"}) {
			return "global.subscriptionWork must be continue or stop"
		}
	}
	onError, has := cost.Get("onError")
	if !has {
		onError = nil
	}
	if p := c.checkAction("onError", onError, "", false); p != "" {
		return p
	}
	if cycle := c.findCycle(); cycle != nil {
		return "take-over cycle: " + strings.Join(cycle, " -> ")
	}
	return ""
}

// displayProblem is src/cost-display.ts displayProblem.
func displayProblem(d jsjson.Value, ok bool) string {
	if isNullish(d, ok) {
		return ""
	}
	o := obj(d)
	if o == nil {
		return "cost.display must be an object"
	}
	if mode, ok := o.Get("mode"); !isNullish(mode, ok) && !oneOf(mode, costModeOf) {
		return "cost.display.mode must be one of " + strings.Join(costModeOf, ", ")
	}
	if prices, ok := o.Get("prices"); !isNullish(prices, ok) {
		if obj(prices) == nil {
			return "cost.display.prices must be an object of account to USD per month"
		}
		for _, account := range obj(prices).Keys() {
			p, _ := obj(prices).Get(account)
			if f, fin := finite(p); !fin || f <= 0 {
				return "cost.display.prices." + account + " must be a positive number of USD per month"
			}
		}
	}
	return ""
}

type account struct {
	name string
	v    jsjson.Value
}

// accountPairs is Object.entries(cost.accounts): a string's characters count too, as in JavaScript.
func accountPairs(v jsjson.Value) []account {
	var out []account
	if s, ok := v.(string); ok {
		for i, ch := range []rune(s) {
			out = append(out, account{jsjson.Number(float64(i)), string(ch)})
		}
		return out
	}
	for _, p := range pairs(v) {
		out = append(out, account{p[0].(string), p[1]})
	}
	return out
}

// matchesOverlap is src/accounts.ts overlaps of two accounts' matches.
func matchesOverlap(a, b jsjson.Value) bool {
	ma, _ := memberAny(a, "match")
	mb, _ := memberAny(b, "match")
	ha, _ := memberAny(ma, "harness")
	hb, _ := memberAny(mb, "harness")
	if ha != hb {
		return false
	}
	xa, oka := memberAny(ma, "model")
	xb, okb := memberAny(mb, "model")
	if isNullish(xa, oka) || isNullish(xb, okb) {
		return true
	}
	sa, _ := xa.(string)
	sb, _ := xb.(string)
	return strings.HasPrefix(sa, sb) || strings.HasPrefix(sb, sa)
}

type costCheck struct {
	cost     *jsjson.Object
	accounts []account
	registry *jsjson.Object
}

func (c costCheck) account(name string) (account, bool) {
	for _, a := range c.accounts {
		if a.name == name {
			return a, true
		}
	}
	return account{}, false
}

// effective is src/accounts.ts effective: an account's own action for a field, or the inherited cost.onError.
func (c costCheck) effective(a account, field string) (jsjson.Value, bool) {
	own, ok := memberAny(a.v, field)
	if onError, has := c.cost.Get("onError"); isNullish(own, ok) && field == "onError" && !isNullish(onError, has) {
		return onError, true
	}
	if !ok {
		return nil, false
	}
	return own, false
}

// targets is src/accounts.ts targets: the take-over targets an action names.
func targets(action jsjson.Value) []string {
	to, _ := member(action, "to")
	var out []string
	if a, ok := to.([]jsjson.Value); ok {
		for _, t := range a {
			if s, ok := t.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

// actionNames is src/accounts.ts actionNames: an action's own name and its else.
func actionNames(action jsjson.Value) []string {
	if s, ok := action.(string); ok {
		return []string{s}
	}
	var out []string
	for _, k := range []string{"action", "else"} {
		if s, ok := memberAny(action, k); ok {
			if str, isStr := s.(string); isStr {
				out = append(out, str)
			}
		}
	}
	return out
}

// checkAction is src/accounts.ts checkAction.
func (c costCheck) checkAction(where string, action jsjson.Value, from string, inherited bool) string {
	if action == nil {
		return ""
	}
	if s, ok := action.(string); ok {
		if oneOf(s, actionsOf) {
			return ""
		}
		return where + ": unknown action " + s
	}
	if !isObject(action) {
		return where + ": action must be a name or an object"
	}
	a, aok := memberAny(action, "action")
	if !oneOf(a, actionsOf) {
		return where + ": unknown action " + show(a, aok)
	}
	if e, ok := memberAny(action, "else"); !isNullish(e, ok) && !oneOf(e, actionsOf) {
		return where + ": unknown else action " + show(e, ok)
	}
	if to, ok := memberAny(action, "to"); !isNullish(to, ok) {
		list, isList := to.([]jsjson.Value)
		for _, t := range list {
			if _, s := t.(string); !s {
				isList = false
			}
		}
		if !isList {
			return where + ": to must be a list of names"
		}
	}
	for _, t := range targets(action) {
		to := c.resolveTarget(t)
		if to == "" {
			return where + ": " + t + " matches no account"
		}
		if from != "" && to == from && !inherited {
			return where + ": " + t + " resolves to " + to + ", the same account"
		}
	}
	return ""
}

// resolveTarget is src/accounts.ts resolveTarget: an account, a preset or a harness, as an account name, or "".
func (c costCheck) resolveTarget(name string) string {
	if _, ok := c.account(name); ok {
		return name
	}
	presets, _ := c.registry.Get("presets")
	if p, _ := member(presets, name); jsjson.Truthy(p) {
		h, _ := memberAny(p, "harness")
		hs, _ := h.(string)
		m, _ := memberAny(p, "model")
		ms, _ := m.(string)
		return c.matchAccount(hs, ms)
	}
	harnesses, _ := c.registry.Get("harnesses")
	if h, _ := member(harnesses, name); jsjson.Truthy(h) {
		return c.matchAccount(name, "")
	}
	return ""
}

// matchAccount is src/accounts.ts matchAccount: the account whose match covers harness and model, the longest model
// prefix winning, or "".
func (c costCheck) matchAccount(harness, model string) string {
	best, bestLen := "", -1
	for _, a := range c.accounts {
		m, _ := memberAny(a.v, "match")
		if h, _ := memberAny(m, "harness"); !jsjson.Truthy(m) || h != harness {
			continue
		}
		mm, ok := memberAny(m, "model")
		prefix, _ := mm.(string)
		if !isNullish(mm, ok) && !strings.HasPrefix(model, prefix) {
			continue
		}
		if n := len(utf16Units(prefix)); n > bestLen {
			best, bestLen = a.name, n
		}
	}
	return best
}

func utf16Units(s string) []rune {
	var out []rune
	for _, r := range s {
		out = append(out, r)
		if r > 0xFFFF {
			out = append(out, 0)
		}
	}
	return out
}

// edges is src/accounts.ts edges: the accounts an account's effective actions can move work to.
func (c costCheck) edges(a account) []string {
	var out []string
	seen := map[string]bool{}
	for _, field := range actionFields {
		action, inherited := c.effective(a, field)
		for _, t := range targets(action) {
			if to := c.resolveTarget(t); to != "" && !(inherited && to == a.name) && !seen[to] {
				seen[to] = true
				out = append(out, to)
			}
		}
	}
	return out
}

// findCycle is src/accounts.ts findCycle: the take-over cycle between accounts, or nil.
func (c costCheck) findCycle() []string {
	state := map[string]int{}
	var stack []string
	var visit func(a account) []string
	visit = func(a account) []string {
		state[a.name] = 1
		stack = append(stack, a.name)
		for _, to := range c.edges(a) {
			next, ok := c.account(to)
			if !ok {
				continue
			}
			switch state[to] {
			case 1:
				for i, n := range stack {
					if n == to {
						return append(append([]string{}, stack[i:]...), to)
					}
				}
			case 0:
				if found := visit(next); found != nil {
					return found
				}
			}
		}
		stack = stack[:len(stack)-1]
		state[a.name] = 2
		return nil
	}
	for _, a := range c.accounts {
		if state[a.name] == 0 {
			if found := visit(a); found != nil {
				return found
			}
		}
	}
	return nil
}

package lifecycle

import (
	"context"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// Paid spend from stam's own ledger (src/readings.ts, S-2848 B5a), which the budgets measure: a provider's reading is a
// cumulative total or a balance, not a per-period figure.
//   - billed: an OpenRouter account's cost_usd, which src/reconcile.ts scales to billed dollars.
//   - estimate: a Claude account's paid_estimate_usd, the growth in status-line cost while a window reads 100%.
//   - priced: any other pay-per-token provider's tokens at the registry's prices for each row's model, or the cost the
//     harness reported for a model with no price.
//   - none: Codex reports no cost.
//
// Each account's reading for the Usage page and usage_info is readings.go's.

// periodStart is src/readings.ts periodStart: the first day in a budget period, as the usage table's day, and false for a
// cap (all time). Weeks start on Monday, months on the first, in UTC. A per that is none of these counts by the day.
func periodStart(per string, now time.Time) (string, bool) {
	if per == "cap" {
		return "", false
	}
	at := now.UTC().Truncate(24 * time.Hour)
	switch per {
	case "week":
		at = at.AddDate(0, 0, -((int(at.Weekday()) + 6) % 7))
	case "month":
		at = at.AddDate(0, 0, 1-at.Day())
	}
	return at.Format("2006-01-02"), true
}

// sincePtr is periodStart as the ledger queries take it: nil for all time.
func sincePtr(per string, now time.Time) *string {
	if s, ok := periodStart(per, now); ok {
		return &s
	}
	return nil
}

// payPerTokenProvider is src/accounts.ts payPerTokenProvider: the provider that bills the account per token, or "" for a
// subscription or unmanaged one: openrouter for an OpenRouter account, the account's own provider, or for OpenCode the
// configured provider its match.model names as `ID/`.
func payPerTokenProvider(set config.Settings, acct config.CostAccount, name string) string {
	if isOpenRouter(acct, name) {
		return "openrouter"
	}
	if acct.Provider != nil && *acct.Provider != "" {
		return *acct.Provider
	}
	if acct.Harness != "opencode" || acct.Model == nil || !strings.Contains(*acct.Model, "/") {
		return ""
	}
	prefix, _, _ := strings.Cut(*acct.Model, "/")
	for _, id := range set.ProviderNames {
		if prefix != "" && id == prefix {
			return prefix
		}
	}
	return ""
}

// openRouterAccounts is src/accounts.ts openRouterAccounts: every account billed to the OpenRouter credit, whatever its
// name, and openrouter and openrouter-system always.
func openRouterAccounts(set config.Settings) []string {
	var out []string
	has := map[string]bool{}
	for _, name := range sortedAccounts(set) {
		if isOpenRouter(set.CostAccounts[name], name) {
			out, has[name] = append(out, name), true
		}
	}
	for _, n := range []string{"openrouter", systemAccount} {
		if !has[n] {
			out = append(out, n)
		}
	}
	return out
}

// sortedAccounts is the configured accounts' names in name order. TS walks them in the file's order; every use here sums
// or sets per account, so the order changes nothing.
func sortedAccounts(set config.Settings) []string {
	out := make([]string, 0, len(set.CostAccounts))
	for name := range set.CostAccounts {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// spendBasis is src/readings.ts Basis: how an account's paid spend is read from the ledger.
type spendBasis string

const (
	basisBilled   spendBasis = "billed"
	basisPriced   spendBasis = "priced"
	basisEstimate spendBasis = "estimate"
	basisNone     spendBasis = "none"
)

// basisOf is src/readings.ts basisOf.
func basisOf(set config.Settings, acct config.CostAccount, name string) spendBasis {
	if isOpenRouter(acct, name) {
		return basisBilled
	}
	if payPerTokenProvider(set, acct, name) != "" {
		return basisPriced
	}
	if acct.Harness == "codex" {
		return basisNone
	}
	return basisEstimate
}

// price is src/attribution.ts Price: input per million tokens, and the other kinds, nil where unpriced. An entry that
// isn't valid (not an object, or no numeric input) has no price, and still hides the model's entry without a context
// suffix, as priceOf's `prices[model] ?? prices[base]` does.
type price struct {
	valid                         bool
	input                         float64
	output, cacheRead, cacheWrite *float64
}

// prices is registry().prices: the shipped registry's prices (registry/defaults.json), with the user registry (the home's cached copy on a peer)'s
// entries replacing them by model and a null entry removing one. A file that is missing or not JSON counts as empty, as in
// Capabilities. An entry with no numeric input has no price.
func (l *Lifecycle) prices() map[string]price {
	out := map[string]price{}
	defaults, _ := readJSON(filepath.Join(l.claude.Templates.Root, "registry", "defaults.json"))
	user := jsjson.Value(l.claude.Templates.UserRegistry())
	for _, doc := range []jsjson.Value{defaults, user} {
		sec, _ := field(doc, "prices").(*jsjson.Object)
		for _, model := range sec.Keys() {
			v, _ := sec.Get(model)
			delete(out, model)
			if v == nil {
				continue
			}
			in, ok := field(v, "input").(float64)
			if _, obj := v.(*jsjson.Object); !ok || !obj {
				out[model] = price{}
				continue
			}
			num := func(k string) *float64 {
				if n, ok := field(v, k).(float64); ok {
					return &n
				}
				return nil
			}
			out[model] = price{valid: true, input: in, output: num("output"), cacheRead: num("cacheRead"), cacheWrite: num("cacheWrite")}
		}
	}
	return out
}

// contextSuffix is the `[1m]` a model's context variant ends with (src/attribution.ts priceOf's /\[.*\]$/).
var contextSuffix = regexp.MustCompile(`\[.*\]$`)

// priceUsd is src/attribution.ts priceUsd: tokens' cost in USD at the registry's prices for the model (an exact key, or
// the key without a context suffix); a missing output or cache price is the input's. False when the model has no price.
func priceUsd(prices map[string]price, model string, in, out, cacheRead, cacheWrite float64) (float64, bool) {
	p, ok := priceOf(prices, model)
	if !ok {
		return 0, false
	}
	return p.weigh(in, out, cacheRead, cacheWrite) / 1e6, true
}

// priceOf is src/attribution.ts priceOf: the model's entry, or the entry without its context suffix when the model has
// none; false when that entry has no price.
func priceOf(prices map[string]price, model string) (price, bool) {
	p, ok := prices[model]
	if !ok {
		p = prices[contextSuffix.ReplaceAllString(model, "")]
	}
	return p, p.valid
}

// weigh is src/attribution.ts weighted for a priced model: tokens times USD per million tokens, a missing output or cache
// price being the input's. The products are explicit conversions so no platform fuses them, and the sum's order is TS's.
func (p price) weigh(in, out, cacheRead, cacheWrite float64) float64 {
	at := func(v *float64) float64 {
		if v == nil {
			return p.input
		}
		return *v
	}
	return float64(in*p.input) + float64(out*at(p.output)) + float64(cacheRead*at(p.cacheRead)) + float64(cacheWrite*at(p.cacheWrite))
}

// pricedSpend is src/readings.ts pricedSpend: an account's spend from since (nil for all time) at the registry's
// per-model prices, or, for a model with no price, the cost the harness reported.
func (l *Lifecycle) pricedSpend(ctx context.Context, account string, since *string, prices map[string]price) (float64, error) {
	rows, err := l.db.SpendByModel(ctx, account, since)
	if err != nil {
		return 0, err
	}
	usd := 0.0
	for _, r := range rows {
		if r.Model != nil && *r.Model != "" {
			if p, ok := priceUsd(prices, *r.Model, r.In, r.Out, r.CacheRead, r.CacheWrite); ok {
				usd += p
				continue
			}
		}
		usd += r.Cost
	}
	return usd, nil
}

// spentFor is src/readings.ts spentFor: what an account spent over a budget period, from the ledger column its basis
// reads; ok is false when it has no paid ledger (Codex).
func (l *Lifecycle) spentFor(ctx context.Context, name string, basis spendBasis, per string, now time.Time) (float64, bool, error) {
	since := sincePtr(per, now)
	switch basis {
	case basisNone:
		return 0, false, nil
	case basisPriced:
		usd, err := l.pricedSpend(ctx, name, since, l.prices())
		return usd, err == nil, err
	case basisBilled:
		usd, err := l.db.Ledger(ctx, name, "cost_usd", since)
		return usd, err == nil, err
	}
	usd, err := l.db.Ledger(ctx, name, "paid_estimate_usd", since)
	return usd, err == nil, err
}

// paidSpentIn is src/readings.ts paidSpentIn: an account's paid spend over a budget period; ok is false when it isn't
// configured or has no paid ledger (Codex).
func (l *Lifecycle) paidSpentIn(ctx context.Context, account, per string, now time.Time) (float64, bool, error) {
	set := l.settings.Get()
	acct, ok := set.CostAccounts[account]
	if !ok {
		return 0, false, nil
	}
	return l.spentFor(ctx, account, basisOf(set, acct, account), per, now)
}

// paidSpentAll is src/readings.ts paidSpentAll: all paid spend over a budget period, summed from the whole ledger
// whatever accounts are configured now. A row is billed when its account is an OpenRouter account today or it was
// written by OpenCode on an openrouter/ model, so a deleted account's billed dollars still count; a configured
// pay-per-token account's rows count at the registry's prices; every other row counts by its paid estimate.
func (l *Lifecycle) paidSpentAll(ctx context.Context, per string, now time.Time) (float64, error) {
	set := l.settings.Get()
	since := sincePtr(per, now)
	names := openRouterAccounts(set)
	billed := map[string]bool{}
	for _, n := range names {
		billed[n] = true
	}
	var priced []string
	for _, n := range sortedAccounts(set) {
		if !billed[n] && basisOf(set, set.CostAccounts[n], n) == basisPriced {
			priced = append(priced, n)
		}
	}
	sum, err := l.db.PaidSpentAll(ctx, names, priced, since)
	if err != nil || len(priced) == 0 {
		return sum, err
	}
	// TS adds the priced accounts' total, summed from 0, to the ledger's sum: the same order of float additions.
	prices, rest := l.prices(), 0.0
	for _, n := range priced {
		usd, err := l.pricedSpend(ctx, n, since, prices)
		if err != nil {
			return 0, err
		}
		rest += usd
	}
	return sum + rest, nil
}

package lifecycle

import (
	"stam/internal/config"
	"stam/internal/jsjson"
)

// Cost display (src/cost-display.ts, S-316, S-3807): a cost in every unit the human can choose (settings.cost.display.mode),
// so the UI switches mode without refetching.
//
//	api            API-equivalent $ (what the harness reports)
//	five_hour      % of the 5-hour window, seven_day: % of the 7-day window
//	subscription   $ at what the subscription costs: api$ x monthly price / API-equivalent use per month (the 7-day
//	               worth x 30/7)
//	paid_usd       real money: spend on accounts billed per use (OpenRouter, paid: true), $ in every mode
//
// Spend with no configured account ('') counts toward api only. A converted value is nil when it can't be computed: the
// worth isn't calibrated, or no price is set for the account. Values add up, so a tree is the sum of its members',
// nil if any part is.

// Modes is src/cost-display.ts Modes.
type Modes struct {
	API                              float64
	FiveHour, SevenDay, Subscription *float64
	PaidUSD                          float64
}

func fp(f float64) *float64 { return &f }

// ZeroModes is zeroModes.
func ZeroModes() Modes { return Modes{FiveHour: fp(0), SevenDay: fp(0), Subscription: fp(0)} }

func addNullable(a, b *float64) *float64 {
	if a == nil || b == nil {
		return nil
	}
	return fp(*a + *b)
}

// AddModes is addModes: s added into t.
func AddModes(t *Modes, s Modes) {
	t.API += s.API
	t.PaidUSD += s.PaidUSD
	t.FiveHour, t.SevenDay, t.Subscription = addNullable(t.FiveHour, s.FiveHour), addNullable(t.SevenDay, s.SevenDay), addNullable(t.Subscription, s.Subscription)
}

// RoundModes is roundModes: $ to the millionth, percentages and subscription $ to the hundredth.
func RoundModes(m Modes) Modes {
	r := func(n float64) float64 { return round(n*1e6) / 1e6 }
	r2 := func(n *float64) *float64 {
		if n == nil {
			return nil
		}
		return fp(round(*n*100) / 100)
	}
	return Modes{API: r(m.API), FiveHour: r2(m.FiveHour), SevenDay: r2(m.SevenDay), Subscription: r2(m.Subscription), PaidUSD: r(m.PaidUSD)}
}

// JSON is the modes as their JSON object, in TS's key order.
func (m Modes) JSON() *jsjson.Object {
	opt := func(p *float64) jsjson.Value {
		if p == nil {
			return nil
		}
		return *p
	}
	return jsjson.NewObject("api", m.API, "five_hour", opt(m.FiveHour), "seven_day", opt(m.SevenDay), "subscription", opt(m.Subscription), "paid_usd", m.PaidUSD)
}

// DisplayCtx is src/cost-display.ts Ctx: how accounts are billed and what a window is worth.
type DisplayCtx interface {
	// Kind is subscription (configured, not paid), paid (pay-per-token, or paid: true; an explicit paid: false wins),
	// else none.
	Kind(account string) string
	// Worth is a full window's worth in API-equivalent $ (mid), nil when not calibrated.
	Worth(account, window string) *float64
	// Price is the account's subscription price in USD per month, nil when none is set.
	Price(account string) *float64
}

// KindResolver is src/cost-display.ts kindResolver over one read of the settings.
func KindResolver(set config.Settings) func(account string) string {
	openrouter := map[string]bool{}
	for _, n := range openRouterAccounts(set) {
		openrouter[n] = true
	}
	return func(account string) string {
		acct, ok := set.CostAccounts[account]
		paidFalse := ok && acct.Paid != nil && !*acct.Paid
		paidTrue := ok && acct.Paid != nil && *acct.Paid
		if !paidFalse && (openrouter[account] || paidTrue || (ok && payPerTokenProvider(set, acct, account) != "")) {
			return "paid"
		}
		if ok {
			return "subscription"
		}
		return "none"
	}
}

// AccountCost is one account's API-equivalent $, an entry of the Map convert takes, in its insertion order.
type AccountCost struct {
	Account string
	API     float64
}

func subscriptionUsd(ctx DisplayCtx, account string, api float64) *float64 {
	price, worth := ctx.Price(account), ctx.Worth(account, "seven_day")
	if price == nil || worth == nil || *worth <= 0 {
		return nil
	}
	return fp((api * *price) / ((*worth * 30) / 7))
}

// WindowPercent is convert's windowPercent: the spend's share of the current windows, when the caller has it.
type WindowPercent struct{ FiveHour, SevenDay *float64 }

// Convert is src/cost-display.ts convert: cost per account into the modes. windowPercent, when not nil, is the spend's
// share of the current windows; else each window's percent is the cost over the window's worth.
func Convert(byAccount []AccountCost, ctx DisplayCtx, windowPercent *WindowPercent) Modes {
	m := ZeroModes()
	for _, c := range byAccount {
		m.API += c.API
		kind := ctx.Kind(c.Account)
		if kind == "paid" {
			m.PaidUSD += c.API
		}
		if kind != "subscription" {
			continue
		}
		if m.Subscription != nil {
			if s := subscriptionUsd(ctx, c.Account, c.API); s != nil {
				m.Subscription = fp(*m.Subscription + *s)
			} else {
				m.Subscription = nil
			}
		}
		if windowPercent == nil {
			for _, w := range []string{"five_hour", "seven_day"} {
				cur := &m.FiveHour
				if w == "seven_day" {
					cur = &m.SevenDay
				}
				worth := ctx.Worth(c.Account, w)
				if *cur == nil || worth == nil || *worth <= 0 {
					*cur = nil
				} else {
					*cur = fp(**cur + (100*c.API)/(*worth))
				}
			}
		}
	}
	if windowPercent != nil {
		hasSub := false
		for _, c := range byAccount {
			hasSub = hasSub || ctx.Kind(c.Account) == "subscription"
		}
		if hasSub {
			m.FiveHour, m.SevenDay = windowPercent.FiveHour, windowPercent.SevenDay
		} else {
			m.FiveHour, m.SevenDay = fp(0), fp(0)
		}
	}
	return m
}

// RawAcct is src/cost-display.ts RawAcct: what an agent (or a tree) spent on one account before conversion, for the
// daemon serving the UI to convert with its own prices.
type RawAcct struct {
	API                float64
	Kind               string
	WorthSevenDay      *float64
	FiveHour, SevenDay *float64
}

// Raw is src/cost-display.ts Raw: per account, in insertion order.
type Raw struct {
	Order []string
	By    map[string]*RawAcct
}

func NewRaw() *Raw { return &Raw{By: map[string]*RawAcct{}} }

// JSON is the raw cost as its JSON object: each account's {api, kind, worth_seven_day, five_hour, seven_day}.
func (r *Raw) JSON() *jsjson.Object {
	opt := func(p *float64) jsjson.Value {
		if p == nil {
			return nil
		}
		return *p
	}
	out := jsjson.NewObject()
	for _, a := range r.Order {
		x := r.By[a]
		out.Set(a, jsjson.NewObject("api", x.API, "kind", x.Kind, "worth_seven_day", opt(x.WorthSevenDay), "five_hour", opt(x.FiveHour), "seven_day", opt(x.SevenDay)))
	}
	return out
}

// AddRaw is addRaw: s added into t.
func AddRaw(t *Raw, s *Raw) {
	for _, a := range s.Order {
		r := s.By[a]
		x, ok := t.By[a]
		if !ok {
			c := *r
			t.Order, t.By[a] = append(t.Order, a), &c
			continue
		}
		x.API += r.API
		if x.WorthSevenDay == nil {
			x.WorthSevenDay = r.WorthSevenDay
		}
		x.FiveHour, x.SevenDay = addNullable(x.FiveHour, r.FiveHour), addNullable(x.SevenDay, r.SevenDay)
	}
}

// RawToModes is rawToModes: the modes for a raw cost, with this daemon's subscription prices.
func RawToModes(raw *Raw, prices map[string]float64) Modes {
	m := ZeroModes()
	for _, account := range raw.Order {
		r := raw.By[account]
		m.API += r.API
		if r.Kind == "paid" {
			m.PaidUSD += r.API
		}
		if r.Kind != "subscription" {
			continue
		}
		m.FiveHour, m.SevenDay = addNullable(m.FiveHour, r.FiveHour), addNullable(m.SevenDay, r.SevenDay)
		price, ok := prices[account]
		if m.Subscription == nil || !ok || r.WorthSevenDay == nil || *r.WorthSevenDay <= 0 {
			m.Subscription = nil
		} else {
			m.Subscription = fp(*m.Subscription + (r.API*price)/((*r.WorthSevenDay*30)/7))
		}
	}
	return m
}

// TreeSums is src/cost-display.ts treeSums: each node's own value summed over itself and every descendant, each
// descendant once even where agents have several parents.
func TreeSums[T any](ids []string, children map[string][]string, own map[string]T, zero func() T, add func(into *T, from T)) map[string]T {
	out, sum := map[string]T{}, map[string]T{}
	shared, parentCount := map[string]bool{}, map[string]int{}
	uniq := func(xs []string) []string {
		seen, out := map[string]bool{}, []string{}
		for _, x := range xs {
			if !seen[x] {
				seen[x], out = true, append(out, x)
			}
		}
		return out
	}
	for _, kids := range children {
		for _, k := range uniq(kids) {
			parentCount[k]++
		}
	}
	state := map[string]int{}
	var visit func(id string)
	visit = func(id string) {
		if state[id] != 0 {
			return
		}
		state[id] = 1
		acc := zero()
		if v, ok := own[id]; ok {
			add(&acc, v)
		}
		sh := false
		for _, k := range uniq(children[id]) {
			if state[k] == 1 {
				continue
			}
			visit(k)
			add(&acc, sum[k])
			if shared[k] || parentCount[k] > 1 {
				sh = true
			}
		}
		sum[id], shared[id], state[id] = acc, sh, 2
	}
	for _, id := range ids {
		visit(id)
	}
	for _, id := range ids {
		if !shared[id] {
			out[id] = sum[id]
			continue
		}
		acc := zero()
		seen := map[string]bool{}
		stack := []string{id}
		for len(stack) > 0 {
			cur := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if seen[cur] {
				continue
			}
			seen[cur] = true
			if v, ok := own[cur]; ok {
				add(&acc, v)
			}
			stack = append(stack, children[cur]...)
		}
		out[id] = acc
	}
	return out
}

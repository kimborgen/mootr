package config

import (
	"math"

	"stam/internal/jsjson"
)

// The parts of settings.cost a reading shows as the file holds them (src/readings.ts accountReadings walks
// cost.accounts with Object.entries and returns each account's match as it is): the accounts' order, their match
// objects, and cost.display.prices.
type CostShape struct {
	// AccountOrder is cost.accounts' names in the file's (JavaScript's) key order; empty when CostAccounts is.
	AccountOrder []string
	// AccountMatch is each account's match object as written.
	AccountMatch map[string]jsjson.Value
	// DisplayPrices is cost.display.prices: an account's subscription price in USD per month (src/cost-display.ts
	// costDisplay). Only a positive finite number counts, as displayProblem accepts.
	DisplayPrices map[string]float64
}

// parseCostShape reads the CostShape of a settings file; accounts are kept only when CostAccounts parsed.
func parseCostShape(data []byte, accounts map[string]CostAccount) CostShape {
	out := CostShape{AccountMatch: map[string]jsjson.Value{}, DisplayPrices: map[string]float64{}}
	if len(data) == 0 {
		return out
	}
	doc, err := jsjson.Parse(data)
	if err != nil {
		return out
	}
	get := func(v jsjson.Value, k string) jsjson.Value {
		o, _ := v.(*jsjson.Object)
		x, _ := o.Get(k)
		return x
	}
	cost := get(doc, "cost")
	if accts, ok := get(cost, "accounts").(*jsjson.Object); ok && len(accounts) > 0 {
		for _, name := range accts.Keys() {
			if _, ok := accounts[name]; !ok {
				continue
			}
			v, _ := accts.Get(name)
			out.AccountOrder = append(out.AccountOrder, name)
			out.AccountMatch[name] = get(v, "match")
		}
	}
	if prices, ok := get(get(cost, "display"), "prices").(*jsjson.Object); ok {
		for _, k := range prices.Keys() {
			v, _ := prices.Get(k)
			if p, ok := v.(float64); ok && !math.IsInf(p, 0) && !math.IsNaN(p) && p > 0 {
				out.DisplayPrices[k] = p
			}
		}
	}
	return out
}

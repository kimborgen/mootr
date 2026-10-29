package db

import "context"

// UsageCounters is src/usage.ts USAGE_COUNTERS, in its order.
var UsageCounters = []string{"cost_usd", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write"}

// UsageSums is one agent's usage rows in a scope: how many (N), and each counter's sum by UsageCounters.
type UsageSums struct {
	N    int
	Sums [5]float64
}

// AgentUsage is src/usage.ts agentUsage's queries: the agent's usage over its whole life and on day, and the model of
// its latest usage row with one ("" when none).
func (d *DB) AgentUsage(ctx context.Context, id, day string) (life, today UsageSums, lastModel string, err error) {
	sums := "COUNT(*) AS n"
	for _, c := range UsageCounters {
		sums += ", SUM(" + c + ") AS " + c
	}
	scan := func(out *UsageSums) func(c *cols) {
		return func(c *cols) {
			out.N = c.stmt.ColumnInt(0)
			for i := range out.Sums {
				out.Sums[i] = c.stmt.ColumnFloat(i + 1)
			}
		}
	}
	if err = d.read(ctx, "SELECT "+sums+" FROM usage WHERE agent_id = ?", scan(&life), id); err != nil {
		return life, today, "", wrap("agent usage", err)
	}
	if err = d.read(ctx, "SELECT "+sums+" FROM usage WHERE agent_id = ? AND day = ?", scan(&today), id, day); err != nil {
		return life, today, "", wrap("agent usage", err)
	}
	err = d.read(ctx, "SELECT model FROM usage WHERE agent_id = ? AND model IS NOT NULL AND model <> '' ORDER BY day DESC LIMIT 1",
		func(c *cols) { lastModel = c.text() }, id)
	return life, today, lastModel, wrap("agent usage", err)
}

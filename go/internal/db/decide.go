package db

import (
	"context"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// SystemAccount is src/settings.ts SYSTEM_ACCOUNT: the account stam's own model calls are billed to.
const SystemAccount = "openrouter-system"

// RecordDecideSpend is src/decide.ts recordSpend's usage row for a call through OpenRouter, on the openrouter-system
// account.
func (d *DB) RecordDecideSpend(ctx context.Context, purpose string, cost float64, tokensIn, tokensOut int64) error {
	return d.RecordSpend(ctx, purpose, "openrouter", SystemAccount, cost, tokensIn, tokensOut)
}

// RecordSpend is src/decide.ts recordCost: one model call stam made for itself, for the pseudo-agent `stam` with the
// purpose as the model, on the provider and account that served it, so the Usage view shows it by agent and by model.
// Same-day calls on one account add up. The `decide` event that goes with it is the caller's.
func (d *DB) RecordSpend(ctx context.Context, purpose, provider, account string, cost float64, tokensIn, tokensOut int64) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, `INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out)
       VALUES ('stam', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd,
         tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out, model = excluded.model`,
			&sqlitex.ExecOptions{Args: []any{time.Now().UTC().Format("2006-01-02"), provider, purpose, account, cost, tokensIn, tokensOut}})
	})
	return wrap("record spend", err)
}

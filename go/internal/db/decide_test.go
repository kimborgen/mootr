package db

import (
	"context"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// Same-day calls for one purpose add up in the one usage row of the `stam` pseudo-agent, as src/decide.ts recordCost does.
func TestRecordDecideSpend(t *testing.T) {
	ctx := context.Background()
	d := openTest(t, testDB(t))
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(d.RecordDecideSpend(ctx, "decide:mail-check", 0.25, 10, 2))
	must(d.RecordDecideSpend(ctx, "decide:step:st1", 0.5, 5, 1))
	var n int
	var cost float64
	var in, out int
	var model, harness, account string
	must(d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT count(*), sum(cost_usd), sum(tokens_in), sum(tokens_out), max(model), max(harness), max(account) FROM usage WHERE agent_id = 'stam'", &sqlitex.ExecOptions{ResultFunc: func(s *sqlite.Stmt) error {
			n, cost, in, out = s.ColumnInt(0), s.ColumnFloat(1), s.ColumnInt(2), s.ColumnInt(3)
			model, harness, account = s.ColumnText(4), s.ColumnText(5), s.ColumnText(6)
			return nil
		}})
	}))
	// One row per (agent, day, account): the second purpose adds to it and names the model.
	if n != 1 || cost != 0.75 || in != 15 || out != 3 || model != "decide:step:st1" || harness != "openrouter" || account != SystemAccount {
		t.Errorf("usage rows %d, cost %v, in %d, out %d, model %q, harness %q, account %q", n, cost, in, out, model, harness, account)
	}
}

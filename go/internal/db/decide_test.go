package db

import (
	"context"
	"errors"
	"testing"

	"stam/internal/jsjson"
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

// A call through another provider books to that provider's system account, in a row of its own (src/decide.ts recordCost
// with `to`).
func TestRecordSpendTo(t *testing.T) {
	ctx := context.Background()
	d := openTest(t, testDB(t))
	if err := d.RecordDecideSpend(ctx, "tool-name", 0.25, 10, 2); err != nil {
		t.Fatal(err)
	}
	if err := d.RecordSpend(ctx, "tool-name", "oai", "oai-system", 0.5, 5, 1); err != nil {
		t.Fatal(err)
	}
	rows, err := d.Objects(ctx, "SELECT harness, account, cost_usd FROM usage WHERE agent_id = 'stam' ORDER BY account")
	if err != nil {
		t.Fatal(err)
	}
	list := make([]jsjson.Value, len(rows))
	for i, r := range rows {
		list[i] = r
	}
	if got := jsjson.Stringify(list, ""); got != `[{"harness":"oai","account":"oai-system","cost_usd":0.5},{"harness":"openrouter","account":"openrouter-system","cost_usd":0.25}]` {
		t.Errorf("usage rows %s", got)
	}
}

// The tiny steps' stores (src/db.ts): a tool summary is replaced only by one asked with another config, a tool's label
// is stored once, and a block summary is replaced.
func TestTinyStores(t *testing.T) {
	ctx := context.Background()
	d := openTest(t, testDB(t))
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := d.ToolSummary(ctx, "a", "c1", "h"); !errors.Is(err, ErrNotFound) {
		t.Errorf("a missing summary: %v", err)
	}
	must(d.SetToolSummary(ctx, "a", "c1", "h", "Read", "reading", "m", "cfg1"))
	must(d.SetToolSummary(ctx, "a", "c1", "h", "Read2", "same config", "m", "cfg1"))
	if s, err := d.ToolSummary(ctx, "a", "c1", "h"); err != nil || s.Tool != "Read" || s.ConfigHash == nil || *s.ConfigHash != "cfg1" {
		t.Errorf("same config replaced the summary: %+v %v", s, err)
	}
	must(d.SetToolSummary(ctx, "a", "c1", "h", "Look", "new config", "m", "cfg2"))
	if s, _ := d.ToolSummary(ctx, "a", "c1", "h"); s.Tool != "Look" || s.Doing != "new config" {
		t.Errorf("a new config kept the old summary: %+v", s)
	}
	if l, err := d.ToolName(ctx, "claude", "x"); err != nil || l != "" {
		t.Errorf("a missing label: %q %v", l, err)
	}
	must(d.SetToolName(ctx, "claude", "x", "Do x", "m"))
	must(d.SetToolName(ctx, "claude", "x", "Other", "m"))
	if l, _ := d.ToolName(ctx, "claude", "x"); l != "Do x" {
		t.Errorf("the label: %q", l)
	}
	must(d.SetBlockSummary(ctx, "b", "one", "m", "c1"))
	must(d.SetBlockSummary(ctx, "b", "two", "m", "c2"))
	if s, c, err := d.BlockSummary(ctx, "b"); err != nil || s != "two" || c == nil || *c != "c2" {
		t.Errorf("the block summary: %q %v %v", s, c, err)
	}
}

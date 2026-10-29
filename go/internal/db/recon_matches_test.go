package db

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"reflect"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsjson"
)

// TestReconcileMatchesTS runs each case's steps on Reconcile and on src/reconcile.ts (testdata/reconref.mjs) and
// compares every usage row and ledger_recon's row, to the last bit: the bill's arithmetic, the carry, the decision
// model's exact cost and the snapshot are TS's, not only the literal expectations the lifecycle tests port.

type reconStep struct {
	Op      string  `json:"op"`
	Agent   string  `json:"agent,omitempty"`
	Day     string  `json:"day,omitempty"`
	Account string  `json:"account,omitempty"`
	USD     float64 `json:"usd,omitempty"`
	Total   float64 `json:"total,omitempty"`
}

type reconCase struct {
	Name  string      `json:"name"`
	Steps []reconStep `json:"steps"`
}

type reconResult struct {
	Usage []string `json:"usage"`
	Recon string   `json:"recon"`
}

// reconAccounts is what src/accounts.ts openRouterAccounts gives for reconref.mjs's settings.
var reconAccounts = []string{"or-team", "openrouter", "openrouter-system"}

func rep(agent, day, account string, usd float64) reconStep {
	return reconStep{Op: "report", Agent: agent, Day: day, Account: account, USD: usd}
}

var (
	snap  = reconStep{Op: "snap"}
	exact = func(usd float64) reconStep { return reconStep{Op: "exact", USD: usd} }
	bill  = func(total float64) reconStep { return reconStep{Op: "reconcile", Total: total} }
)

const d1, d2 = "2026-10-21", "2026-10-22"

var reconCases = []reconCase{
	{"first poll sets the baseline", []reconStep{rep("a", d1, "or-team", 1.25), exact(0.1), snap, bill(10)}},
	{"scales to the bill", []reconStep{snap, bill(10), rep("a", d1, "or-team", 1), rep("b", d1, "openrouter", 3), snap, bill(11.1)}},
	{"a third of a cent", []reconStep{snap, bill(3.3), rep("a", d1, "or-team", 0.7), rep("a", d2, "or-team", 0.2), rep("b", d2, "openrouter-system", 0.13), snap, bill(3.6)}},
	{"report during the poll", []reconStep{snap, bill(10), rep("a", d1, "or-team", 1), snap, rep("a", d1, "or-team", 1), bill(10.5), snap, bill(11)}},
	{"bill above the report", []reconStep{snap, bill(10), rep("a", d1, "or-team", 1), snap, bill(13), snap, bill(13)}},
	{"carry for one poll", []reconStep{snap, bill(10), snap, bill(12), rep("a", d1, "or-team", 4), snap, bill(12), snap, bill(12.5)}},
	{"carry is dropped after one poll", []reconStep{snap, bill(10), snap, bill(12), snap, bill(12), rep("a", d1, "or-team", 4), snap, bill(12)}},
	{"total went down", []reconStep{snap, bill(10), rep("a", d1, "or-team", 1), snap, bill(5), rep("a", d1, "or-team", 1), snap, bill(5.5)}},
	{"no bill keeps it pending", []reconStep{snap, bill(10), rep("a", d1, "or-team", 1), snap, bill(10), snap, bill(10.25)}},
	{"decision cost exact", []reconStep{snap, bill(10), exact(0.3), rep("a", d1, "or-team", 1), snap, bill(10.8)}},
	{"decision cost partly billed", []reconStep{snap, bill(10), exact(0.3), snap, bill(10.1), snap, bill(10.4)}},
	{"decision cost above the bill", []reconStep{snap, bill(10), exact(2), rep("a", d1, "or-team", 1), snap, bill(10.5), snap, bill(12)}},
	{"decision before the first poll", []reconStep{exact(0.4), snap, bill(10), exact(0.2), snap, bill(10.2)}},
	{"non-positive decision costs", []reconStep{exact(0), exact(-1), snap, bill(1), snap, bill(1.5)}},
	{"subscription rows untouched", []reconStep{snap, bill(10), rep("a", d1, "claude", 5), rep("a", d1, "or-team", 2), snap, bill(11)}},
	{"many rows", []reconStep{snap, bill(0.0001), rep("a", d1, "or-team", 0.011), rep("b", d1, "or-team", 0.0207), rep("c", d1, "openrouter", 0.3),
		rep("a", d2, "or-team", 0.0049), rep("d", d2, "openrouter-system", 1.000001), snap, bill(0.9871), rep("a", d2, "or-team", 0.07), snap, bill(1.2)}},
}

// reconState is every usage row and ledger_recon's row, formatted as reconref.mjs formats them.
func reconState(t *testing.T, d *DB) reconResult {
	t.Helper()
	num := func(stmt *sqlite.Stmt, i int) string {
		if stmt.ColumnType(i) == sqlite.TypeNull {
			return "NULL"
		}
		return jsjson.Number(stmt.ColumnFloat(i))
	}
	r := reconResult{Usage: []string{}}
	err := d.Read(context.Background(), func(conn *sqlite.Conn) error {
		if err := sqlitex.Execute(conn, "SELECT agent_id, day, account, cost_usd, unreconciled_usd FROM usage ORDER BY agent_id, day, account", &sqlitex.ExecOptions{
			ResultFunc: func(stmt *sqlite.Stmt) error {
				r.Usage = append(r.Usage, strings.Join([]string{stmt.ColumnText(0), stmt.ColumnText(1), stmt.ColumnText(2), num(stmt, 3), num(stmt, 4)}, "|"))
				return nil
			}}); err != nil {
			return err
		}
		return sqlitex.Execute(conn, "SELECT billed_used, carry, exact_pending FROM ledger_recon WHERE id = 1", &sqlitex.ExecOptions{
			ResultFunc: func(stmt *sqlite.Stmt) error {
				r.Recon = num(stmt, 0) + "|" + num(stmt, 1) + "|" + num(stmt, 2)
				return nil
			}})
	})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestReconcileMatchesTS(t *testing.T) {
	in, err := json.Marshal(reconCases)
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd := exec.Command("node", "--no-warnings", "testdata/reconref.mjs", string(in))
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("reconref.mjs: %v\n%s", err, stderr.String())
	}
	var want map[string]reconResult
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatalf("reconref.mjs output %q: %v", out, err)
	}
	ctx := context.Background()
	for _, c := range reconCases {
		t.Run(c.Name, func(t *testing.T) {
			d := openTest(t, testDB(t))
			if err := d.Write(ctx, func(conn *sqlite.Conn) error {
				return sqlitex.ExecuteScript(conn, "DELETE FROM usage; DELETE FROM ledger_recon", nil)
			}); err != nil {
				t.Fatal(err)
			}
			var snapshot []ReconRow
			for _, s := range c.Steps {
				switch s.Op {
				case "report":
					u := s.USD
					if s.Account == "claude" {
						u = 0
					}
					err = d.Write(ctx, func(conn *sqlite.Conn) error {
						return runSQL(conn, `INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, unreconciled_usd) VALUES (?, ?, 'opencode', 'openrouter/m', ?, ?, ?)
							ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, unreconciled_usd = unreconciled_usd + excluded.unreconciled_usd`,
							s.Agent, s.Day, s.Account, s.USD, u)
					})
				case "exact":
					err = d.AddExactPending(ctx, s.USD)
				case "snap":
					snapshot, err = d.ReconSnapshot(ctx, reconAccounts)
				case "reconcile":
					err = d.Reconcile(ctx, snapshot, s.Total)
				}
				if err != nil {
					t.Fatalf("%s: %v", s.Op, err)
				}
			}
			if got := reconState(t, d); !reflect.DeepEqual(got, want[c.Name]) {
				t.Errorf("Go %+v\nTS %+v", got, want[c.Name])
			}
		})
	}
}

package lifecycle

import (
	"context"
	"time"

	"stam/internal/db"
)

// Reconciles stam's OpenRouter ledger with what OpenRouter bills (src/reconcile.ts, S-106, S-2848 B5b). OpenCode prices
// a message from list prices, which come out above the bill, so the ledger (usage.cost_usd on the OpenRouter accounts)
// would overstate spend. Each credits poll gives total_usage; the change since the last reconciled poll is the bill,
// delta. The rows' reported cost since then is usage.unreconciled_usd; the decision model's own cost (billed money,
// already exact) is ledger_recon.exact_pending and is taken out of the bill first:
//
//	avail = delta + carry;  matched = min(exact, avail);  B = avail - matched
//	                                                B is the bill for OpenCode's reported cost
//	P = sum(unreconciled_usd)                       what OpenCode reported
//	f = min(1, B / P);  cost_usd -= unreconciled_usd * (1 - f);  unreconciled_usd -= itself
//
// so reported cost stays the weight and billed dollars land in the ledger the budgets read.
//   - The pending amounts are snapshotted before /credits is read, and only that snapshot is reconciled; a report
//     landing during the poll stays pending for the next one.
//   - A bill with nothing reported yet (P = 0) or more than reported (B > P) is carried to the next poll, for one poll
//     only, so another machine's spend on the same key can't pile up and hide local over-reporting. B <= 0 with P > 0
//     scales nothing and keeps the pending amounts.
//   - Decision cost is read inside the transaction, after /credits returned: a decision that finished before the total
//     was computed is already in this bill. Only the matched amount is cleared.
//   - Scaling, clearing the snapshot and moving the billed baseline are one transaction (db.Reconcile), so a restart
//     mid-poll never scales twice.
//   - The first poll only sets the baseline; history isn't rewritten.

// reconSnapshot is src/reconcile.ts snapshot: what is pending now on the OpenRouter accounts. Take it before reading
// /credits.
func (l *Lifecycle) reconSnapshot(ctx context.Context) ([]db.ReconRow, error) {
	return l.db.ReconSnapshot(ctx, openRouterAccounts(l.settings.Get()))
}

// reconcileLedger is src/reconcile.ts reconcile: the snapshot scaled to the bill, then every budget evaluated, since
// scaling can bring one below its limit and lift a stop set at list price. A failed transaction changes nothing and
// evaluates nothing.
func (l *Lifecycle) reconcileLedger(ctx context.Context, snap []db.ReconRow, totalUsage float64) error {
	if err := l.db.Reconcile(ctx, snap, totalUsage); err != nil {
		return err
	}
	l.EvaluateAllBudgets(time.Now(), budgetsReconciled)
	return nil
}

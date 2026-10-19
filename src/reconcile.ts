// Reconciles stam's OpenRouter ledger with what OpenRouter bills. OpenCode prices a message
// from list prices, which come out above the bill, so the ledger (`usage.cost_usd` on the
// OpenRouter accounts) would overstate spend. Each credits poll gives total_usage; the
// change since the last reconciled poll is the bill, delta. The rows' reported cost since
// then is `usage.unreconciled_usd`; the decision model's own cost (decide.ts, billed money,
// already exact) is `ledger_recon.exact_pending` and is taken out of the bill first:
//   avail = delta + carry;  matched = min(exact, avail);  B = avail - matched
//                                                   B is the bill for OpenCode's reported cost
//   P = sum(unreconciled_usd)                       what OpenCode reported
//   f = min(1, B / P);  cost_usd -= unreconciled_usd * (1 - f);  unreconciled_usd -= itself
// so reported cost stays the weight and billed dollars land in the ledger that readings.ts,
// allocations and the Usage page read. Ordering and failure:
//   - The pending amounts are snapshotted before /credits is read, and only that snapshot is
//     reconciled; a report landing during the poll stays pending for the next one.
//   - A bill with nothing reported yet (P = 0) or more than reported (B > P) is carried to
//     the next poll as `carry`, for one poll only: only this poll's new bill carries on, so
//     another machine's spend on the same key (storage's agents, which can't be split out)
//     can't pile up and hide local over-reporting. B <= 0 with P > 0 scales nothing and
//     keeps the pending amounts.
//   - Decision cost is read inside the transaction, after /credits returned, not from the
//     snapshot: a decision that finished before the total was computed is already in this
//     bill. Only the matched amount is cleared; the rest stays pending for a later bill.
//     credits.ts reconciles as soon as /credits returns, before the /key call. The remaining
//     gap is the /credits round trip: a decision landing in it can stay off by its own cost.
//   - A report that lands after the snapshot of the poll that sees its bill waits for the
//     next poll; one delayed past that poll can miss its own bill and is scaled against a
//     later one.
//   - Scaling, clearing the snapshot and moving the billed baseline are one transaction,
//     apart from the warning mail, so a restart mid-poll never scales twice.
//   - The first poll only sets the baseline. Rows from before this release stay at
//     OpenCode's reported cost: history isn't rewritten. usage_samples keep reported cost
//     as attribution weights.
import * as db from './db.ts';
import { openRouterAccounts } from './accounts.ts';
import { ledgerChanged } from './budgets.ts';

export interface Snapshot {
  rows: { agent_id: string; day: string; account: string; u: number }[];
}

function ensureRow(): void {
  db.open().prepare('INSERT OR IGNORE INTO ledger_recon (id) VALUES (1)').run();
}

// Called by decide.ts for each call: billed money to take out of the next bill.
export function addExactPending(usd: number): void {
  if (!(usd > 0)) return;
  ensureRow();
  db.open().prepare('UPDATE ledger_recon SET exact_pending = exact_pending + ? WHERE id = 1').run(usd);
}

// What is pending now. Take it before reading /credits.
export function snapshot(): Snapshot {
  ensureRow();
  const d = db.open();
  const accounts = openRouterAccounts();
  const marks = accounts.map(() => '?').join(',');
  const rows = d.prepare(`SELECT agent_id, day, account, unreconciled_usd AS u FROM usage WHERE unreconciled_usd > 0 AND account IN (${marks})`).all(...accounts) as Snapshot['rows'];
  return { rows };
}

export function reconcile(snap: Snapshot, totalUsage: number): void {
  ensureRow();
  db.transaction(() => {
    const d = db.open();
    const st = d.prepare('SELECT billed_used, carry, exact_pending FROM ledger_recon WHERE id = 1').get() as { billed_used: number | null; carry: number; exact_pending: number };
    const clear = d.prepare('UPDATE usage SET unreconciled_usd = MAX(0, unreconciled_usd - ?) WHERE agent_id = ? AND day = ? AND account = ?');
    const scale = d.prepare('UPDATE usage SET cost_usd = MAX(0, cost_usd - ? * ?) WHERE agent_id = ? AND day = ? AND account = ?');
    const P = snap.rows.reduce((n, r) => n + r.u, 0);
    // First poll, or a total that went down: nothing billed to compare, so only move the baseline.
    if (st.billed_used == null || totalUsage < st.billed_used) {
      for (const r of snap.rows) clear.run(r.u, r.agent_id, r.day, r.account);
      d.prepare('UPDATE ledger_recon SET billed_used = ?, carry = 0, exact_pending = 0 WHERE id = 1').run(totalUsage);
      return;
    }
    const delta = totalUsage - st.billed_used;
    const avail = delta + st.carry;
    const matched = Math.min(st.exact_pending, avail); // read now, after /credits: a decision's cost is billed when it returns
    const B = avail - matched;
    let leftover = 0;
    if (P > 0 && B > 0) {
      const f = Math.min(1, B / P);
      for (const r of snap.rows) {
        scale.run(r.u, 1 - f, r.agent_id, r.day, r.account);
        clear.run(r.u, r.agent_id, r.day, r.account);
      }
      leftover = B - P * f;
    } else if (P === 0) leftover = Math.max(0, B);
    const carry = Math.min(leftover, Math.max(0, delta - matched));
    d.prepare('UPDATE ledger_recon SET billed_used = ?, carry = ?, exact_pending = MAX(0, exact_pending - ?) WHERE id = 1').run(totalUsage, carry, matched);
  });
  // Scaling can bring a budget below its limit; a stop set at list price lifts here.
  ledgerChanged('reconciled');
}

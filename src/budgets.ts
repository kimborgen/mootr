// Budget blockers (docs/cost-policy.md, Rule enforcement: `budget:SCOPE`). SCOPE is an account
// name, or `global` for all paid spend on the machine. When a scope's paid spend in the
// budget's period reaches the budget, every managed agent in scope gets a `budget` blocker;
// it clears when spend falls below the budget again, which happens when the period rolls over
// or when the human raises the budget (a settings change). Only a settings change by the
// human raises a budget: no agent tool does.
//
// evaluateBudgets(scope) is idempotent, as rules.ts's evaluateRules is: an unchanged blocker
// writes nothing, and a refreshed one keeps its `since`. It runs when paid spend is recorded
// (usage.report), when settings change, at daemon start, and at a scope's period rollover.
// Spend is read from the ledger, so a restart loses nothing. Unmanaged agents are never blocked.
//
// Notices: at 90% the managers of the trees in scope hear once per scope, period and budget; a
// blocker set or cleared goes to each agent's manager (blockers.ts). When the budget is
// reached the human gets one mail from stam per scope, period and budget amount, with a
// Decision to raise it or keep stopped; the mail is retried on the next evaluation if it
// couldn't be sent.
import * as db from './db.ts';
import { settings, humanMailAllows, isSettingsHome, type CostBudget } from './settings.ts';
import { peersSpent } from './peer-spend.ts';
import { accountFor, SYSTEM_ACCOUNT } from './accounts.ts';
import { periodStart, paidSpentIn, paidSpentAll, STALE_MS } from './readings.ts';
import * as blockers from './blockers.ts';
import { sendFromSystem, HUMAN } from './mail.ts';
import { render } from './templates.ts';
import * as costNotices from './cost-notices.ts';
import { pollCreditsIfAny } from './credit-poller.ts';

export const GLOBAL = 'global';
const WARN_AT = 0.9;
// The reserve notice fires when the credit is within this multiple of the reserve.
const NEAR_RESERVE = 2;

const budgetOf = (scope: string): CostBudget | null => {
  const cost = settings().cost;
  return (scope === GLOBAL ? cost.global?.budget : cost.accounts?.[scope]?.budget) ?? null;
};

// Every scope with a budget, and every scope still carrying a budget blocker (its budget may
// have been removed from settings).
function scopes(): string[] {
  const cost = settings().cost;
  const out = new Set<string>();
  if (cost.global?.budget) out.add(GLOBAL);
  out.add(AGENT_POOL); // its reserve rule needs no budget
  for (const [name, a] of Object.entries(cost.accounts ?? {})) if (a?.budget) out.add(name);
  for (const r of db.open().prepare("SELECT DISTINCT account FROM blockers WHERE kind = 'budget'").all() as { account: string }[]) out.add(r.account);
  return [...out];
}

// The agents a scope's budget stops: those on the account, or every managed agent for the
// global scope. Archived and unmanaged agents are left alone.
const agentsIn = (scope: string) => db.listAgents().filter((a) => db.isLive(a) && (scope === GLOBAL ? accountFor(a) != null : accountFor(a) === scope));

// Paid dollars spent against the budget in its own period, on all machines; the global scope sums
// the whole ledger over the global period, including accounts no longer configured.
function spentIn(scope: string, b: CostBudget, now: number): number | null {
  const here = scope === GLOBAL ? paidSpentAll(b.per, now) : paidSpentIn(scope, b.per, now);
  // A budget counts every machine's spend (S-395): the peers' last known totals join this machine's.
  return here == null ? null : here + peersSpent(scope, b.per, now);
}

// Why a new agent on this account may not start: the account's own budget or the global one
// is spent. Read from the ledger, so it holds with no agent on the scope yet. Null when
// neither is.
export function spawnHeld(account: string, now: number = Date.now()): string | null {
  if (account === AGENT_POOL) {
    const r = reserveState(now);
    // A balance that may have moved (held, near the reserve, or too old to read) is refreshed, so
    // a top-up with no OpenRouter agent running still lifts the hold.
    if (r.held || r.stale || (r.remaining != null && r.remaining <= r.reserve * NEAR_RESERVE)) pollCreditsIfAny();
    if (r.held) return reserveReason(r.reserve);
  }
  for (const scope of [account, GLOBAL]) {
    const b = budgetOf(scope);
    const spent = b ? spentIn(scope, b, now) : null;
    if (b && spent != null && spent >= b.usd) return `${scope === GLOBAL ? 'the global' : `account ${account}'s`} ${what(b)} of $${b.usd} is spent`;
  }
  return null;
}

// Why stam's own model calls (mail gate, summaries, decisions) may not run: the system account's
// budget is spent. Agents' `openrouter` budget never holds them. Null when it isn't (or none is set).
export function systemHeld(now: number = Date.now()): string | null {
  return accountHeld(SYSTEM_ACCOUNT, now);
}

// The same for stam's own calls through another provider: its `<provider>-system` account (S-3245).
// OpenRouter's is the system account itself.
export function providerHeld(provider: string, now: number = Date.now()): string | null {
  return accountHeld(provider === 'openrouter' ? SYSTEM_ACCOUNT : `${provider}-system`, now);
}

function accountHeld(account: string, now: number): string | null {
  const b = budgetOf(account);
  const spent = b ? spentIn(account, b, now) : null;
  return b && spent != null && spent >= b.usd ? `the ${account === SYSTEM_ACCOUNT ? 'system' : account} ${what(b)} of $${b.usd} is spent` : null;
}

// The OpenRouter agents' account: it shares one credit with stam's own calls (openrouter-system).
const AGENT_POOL = 'openrouter';

// What stam keeps of the shared OpenRouter credit for its own model calls: the unspent part of the
// system account's budget, or cost.openrouterSystemReserveUsd when that account has none.
function systemReserve(now: number): number {
  const b = budgetOf(SYSTEM_ACCOUNT);
  if (b) return Math.max(0, b.usd - (spentIn(SYSTEM_ACCOUNT, b, now) ?? 0));
  return settings().cost.openrouterSystemReserveUsd ?? 1;
}

// The last OpenRouter credit reading (credits.ts keeps it in the subscriptions table) against the
// reserve. `basis` names the credit capacity, which a top-up changes. A reading the poll didn't
// fetch whole in the last STALE_MS is `stale` and never holds anything, as in rules.ts.
function reserveState(now: number): { remaining: number | null; reserve: number; held: boolean; stale: boolean; basis: string } {
  const row = db.open().prepare("SELECT data FROM subscriptions WHERE name = 'openrouter'").get() as { data: string } | undefined;
  let c: { remaining?: unknown; total?: unknown; key_limit?: unknown; observed_at?: unknown } | undefined;
  try {
    c = row ? JSON.parse(row.data)?.credits : undefined;
  } catch {}
  const reserve = systemReserve(now);
  const seen = Date.parse(String(c?.observed_at ?? ''));
  const fresh = typeof c?.remaining === 'number' && Number.isFinite(seen) && now - seen <= STALE_MS;
  const remaining = fresh ? (c!.remaining as number) : null;
  return { remaining, reserve, held: remaining != null && reserve > 0 && remaining <= reserve, stale: !fresh, basis: `${c?.total}:${c?.key_limit}` };
}

// The system reserve and the credit left above it, for the Usage page's System card (S-1203).
// `remaining` is null when the last reading is stale, as in the hold.
export function creditReserve(now: number = Date.now()): { reserve: number; remaining: number | null } {
  const r = reserveState(now);
  return { reserve: r.reserve, remaining: r.remaining };
}

// The poll hook lives in credit-poller.ts, so credits.ts (which imports this module) can register it
// without a cycle; re-exported here for callers that already import it from budgets.
export { setCreditPoller } from './credit-poller.ts';

// The blocker's reason carries no amount, so a moving reserve doesn't rewrite it on every poll.
const RESERVE_BLOCK = "The OpenRouter credit is down to the reserve kept for stam's own model calls; it clears on a top-up";
const reserveReason = (reserve: number) => `The OpenRouter credit is at the $${round(reserve)} kept for stam's own model calls; it clears on a top-up`;

// A spawn the human forced onto a spent scope carries the budget blocker from the start.
export async function attachSpawn(agent: db.Agent): Promise<void> {
  const account = accountFor(agent);
  if (account) await onSpend(account);
}

const round = (n: number) => Math.round(n * 100) / 100;
const what = (b: CostBudget) => (b.per === 'cap' ? 'cap' : `${b.per} budget`);
const period = (b: CostBudget, now: number) => periodStart(b.per, now) ?? 'cap';

// The first instant of the next period, or null for a cap.
function nextPeriod(per: CostBudget['per'], now: number): number | null {
  const start = periodStart(per, now);
  if (!start) return null;
  const d = new Date(Date.parse(start));
  if (per === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (per === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

// One evaluation per scope at a time, in arrival order.
const chains = new Map<string, Promise<void>>();
export function evaluateBudgets(scope: string, now: number = Date.now(), cause?: Cause): Promise<void> {
  const next = (chains.get(scope) ?? Promise.resolve()).then(() => evaluate(scope, now, cause)).catch((e) => {
    console.error(`cost budget for ${scope}:`, e);
  });
  chains.set(scope, next);
  return next;
}

// Every scope, as at daemon start and after a settings change.
export function evaluateAll(now: number = Date.now(), cause?: Cause): Promise<void> {
  return Promise.all(scopes().map((s) => evaluateBudgets(s, now, cause))).then(() => {});
}

// Why an evaluation runs when it is not a spend report or a settings change: `reconciled` means
// the ledger was corrected to the billed amount (reconcile.ts), which can lift a stop.
export type Cause = 'reconciled';

// Every writer of the paid ledger that isn't usage.report calls this after its write: the
// decision model's own spend (decide.ts), and the OpenRouter reconciliation (reconcile.ts).
// A future ledger-write helper passes through here too.
export function ledgerChanged(cause?: Cause): void {
  void evaluateAll(Date.now(), cause);
}

// The scopes a paid-spend report on this account can move: the account and the global one.
export function onSpend(account: string, now: number = Date.now()): Promise<void> {
  return Promise.all([evaluateBudgets(account, now), evaluateBudgets(GLOBAL, now)]).then(() => {});
}

// Every agent in the scope carries the budget blocker with this reason and clear condition.
async function hold(scope: string, reason: string, clear: Record<string, unknown>, existing: blockers.Blocker[]): Promise<void> {
  const inScope = agentsIn(scope);
  // An agent a settings change moved out of scope keeps nothing of this budget.
  for (const x of existing.filter((x) => !inScope.some((a) => a.id === x.agent_id))) {
    db.addEvent(x.agent_id, 'cost:rule', { rule: 'budget', account: scope, action: 'clear', reason: x.reason, cleared: 'the agent is no longer in this budget\'s scope' });
    await blockers.clearBlocker(x.agent_id, 'budget', scope, 'the agent is no longer in this budget\'s scope');
  }
  for (const a of inScope) {
    const have = blockers.blockers(a).find((x) => x.kind === 'budget' && x.account === scope);
    if (have && have.reason === reason && JSON.stringify(have.clear) === JSON.stringify(clear)) continue;
    if (!have || have.reason !== reason) db.addEvent(a.id, 'cost:rule', { rule: 'budget', account: scope, action: 'set', reason });
    await blockers.addBlocker(a, { kind: 'budget', account: scope, reason, clear });
  }
}

async function evaluate(scope: string, now: number, cause?: Cause): Promise<void> {
  const b = budgetOf(scope);
  const spent = b ? spentIn(scope, b, now) : null;
  const over = b != null && spent != null && spent >= b.usd;
  const existing = blockers.blockersFor(scope).filter((x) => x.kind === 'budget');
  // The agents' OpenRouter scope is also held while the shared credit is down to the system's reserve.
  const credit = scope === AGENT_POOL && !over ? reserveState(now) : null;
  if (credit?.held) {
    await hold(scope, RESERVE_BLOCK, { reserve: true }, existing);
    return;
  }
  // A reading gone stale decides nothing: a standing hold stays until a fresh balance clears it.
  if (credit?.stale && existing.some((x) => x.clear?.reserve != null)) return pollCreditsIfAny();
  if (credit?.remaining != null && isSettingsHome() && credit.reserve > 0 && credit.remaining <= credit.reserve * NEAR_RESERVE) costNotices.reserveNear(credit.remaining, credit.reserve, credit.basis, now);
  if (!over) {
    const why = existing.length && existing.every((x) => x.clear?.reserve != null)
      ? 'the OpenRouter credit was topped up above the system reserve'
      : !b
      ? 'the budget was removed'
      : existing.some((x) => x.clear?.usd !== b.usd)
        ? `the budget was raised to $${b.usd}`
        : cause === 'reconciled'
          ? 'the ledger was corrected to the billed amount and the budget is no longer spent'
          : 'the period rolled over';
    for (const x of existing) {
      db.addEvent(x.agent_id, 'cost:rule', { rule: 'budget', account: scope, action: 'clear', reason: x.reason, cleared: why });
      await blockers.clearBlocker(x.agent_id, 'budget', scope, why);
    }
    if (b && spent != null && spent >= b.usd * WARN_AT && isSettingsHome()) warn(scope, b, spent, now);
    return;
  }
  const reason = `${scope === GLOBAL ? 'The global' : `The ${scope}`} ${what(b)} of $${b.usd} is spent`;
  const clear = { per: b.per, usd: b.usd, period: period(b, now) };
  schedule(scope, b, now);
  await hold(scope, reason, clear, existing);
  // Only the settings home mails: every machine blocks its own agents, but the human hears once.
  if (isSettingsHome()) await mailHuman(scope, b, spent, now);
}

// The managers of the trees in scope, once each.
function managersIn(scope: string): string[] {
  const out = new Set<string>();
  for (const a of agentsIn(scope)) if (a.lifecycle === 'active') for (const m of costNotices.managerOf(a.id)) out.add(m);
  return [...out];
}

function warn(scope: string, b: CostBudget, spent: number, now: number): void {
  // The system account has no agents: its notice goes to the chief of staff (or the human).
  if (scope === SYSTEM_ACCOUNT) return costNotices.budgetLow(scope, `${scope}:${period(b, now)}:${b.usd}`, spent, b.usd, what(b), costNotices.chiefOfStaffIds(), now);
  costNotices.budgetLow(scope, `${scope}:${period(b, now)}:${b.usd}`, spent, b.usd, what(b), managersIn(scope), now);
}

// One timer per scope, at the next period rollover while the scope is stopped, so the stop
// lifts without a spend report or a restart. A cap has no rollover.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
function schedule(scope: string, b: CostBudget, now: number): void {
  clearTimeout(timers.get(scope));
  timers.delete(scope);
  const at = nextPeriod(b.per, now);
  if (at == null) return;
  const t = setTimeout(() => {
    timers.delete(scope);
    void evaluateBudgets(scope);
  }, Math.min(Math.max(0, at + 1000 - Date.now()), 2 ** 31 - 1));
  t.unref?.();
  timers.set(scope, t);
}

// Once per scope, period and budget amount, kept in a table of its own.
function mailed(key: string): boolean {
  db.open().exec('CREATE TABLE IF NOT EXISTS budget_mails (key TEXT PRIMARY KEY, created_at TEXT NOT NULL)');
  return db.open().prepare('SELECT 1 AS n FROM budget_mails WHERE key = ?').get(key) != null;
}

// Mail from stam with the raise Decision. The options are the budget plus each raise step
// (`raiseSteps`, added to the budget; default half and the whole of it). A mail that couldn't
// be sent isn't recorded, so the next evaluation sends it again.
async function mailHuman(scope: string, b: CostBudget, spent: number, now: number): Promise<void> {
  const key = `${scope}:${period(b, now)}:${b.usd}`;
  if (!humanMailAllows('necessary') || mailed(key)) return;
  const steps = b.raiseSteps?.length ? b.raiseSteps : [b.usd / 2, b.usd];
  const options = steps.slice(0, 3).map((s) => `- Raise to $${round(b.usd + s)}: $${round(s)} more`).join('\n');
  const agents = agentsIn(scope).map((a) => a.name);
  const system = scope === SYSTEM_ACCOUNT;
  const body = render('budget-reached', {
    scope,
    what: what(b),
    spent: spent.toFixed(2),
    usd: String(b.usd),
    stopped: system
      ? "Stam's own model calls (mail gate, titles, summaries, decisions) are skipped"
      : `Stam has stopped the agents on ${scope} (${agents.slice(0, 6).join(', ') + (agents.length > 6 ? `, and ${agents.length - 6} more` : '') || 'none'})`,
    keep: system ? 'the calls stay skipped' : 'the agents stay stopped',
    rollover: b.per === 'cap' ? 'A cap holds until you raise it.' : `${system ? 'The calls resume' : 'They resume'} when the ${b.per} rolls over, or when you raise it.`,
    options,
    path: scope === GLOBAL ? 'cost.global.budget.usd' : `cost.accounts.${scope}.budget.usd`,
  });
  let sent = false;
  try {
    sent = await send([HUMAN], `[stam] ${scope} ${what(b)} reached: raise it or keep stopped`, body);
  } catch {}
  if (!sent) return retry(scope, key);
  tries.delete(key);
  db.open().prepare('INSERT OR IGNORE INTO budget_mails (key, created_at) VALUES (?, ?)').run(key, new Date(now).toISOString());
}

// A mail that couldn't be sent is tried again after 1, 2, 4, 8 and 16 minutes, then left to the
// next evaluation. A restart starts over, since daemon start evaluates every scope and the
// unsent mail isn't recorded.
let send: (to: string[], subject: string, body: string) => Promise<boolean> = (to, subject, body) => sendFromSystem('budgets', to, subject, body);
let delays = [1, 2, 4, 8, 16].map((m) => m * 60_000);
const tries = new Map<string, number>();
function retry(scope: string, key: string): void {
  const i = tries.get(key) ?? 0;
  if (i >= delays.length) return;
  tries.set(key, i + 1);
  const t = setTimeout(() => void evaluateBudgets(scope), delays[i]);
  t.unref?.();
}
// Tests replace the sender and shorten the delays.
export function setMailTesting(o: { send?: typeof send; delays?: number[] }): void {
  if (o.send) send = o.send;
  if (o.delays) delays = o.delays;
  tries.clear();
}

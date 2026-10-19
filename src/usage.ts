// Usage and cost: per-agent spend and tokens by day, subscription windows, and
// threshold mail to the human. Harnesses report cumulative numbers per session
// (Claude Code: statusline cost and the transcript's tokens, API-equivalent; OpenCode:
// session cost and tokens). Each counter below is tracked on its own: a drop restarts only
// that counter, and a counter that wasn't reported keeps its baseline. tokens_in is
// uncached input only; tokens_out includes reasoning tokens; cache read and cache write are
// their own columns, so the same four numbers can be summed per harness.
import * as db from './db.ts';
import * as cacheCold from './cache-cold.ts';
import { settings, humanMailAllows } from './settings.ts';
import { accountFor, isOpenRouter, SYSTEM_ACCOUNT } from './accounts.ts';
import { accountReadings, STALE_MS } from './readings.ts';
import { timed } from './stall.ts';
import { render } from './templates.ts';
import { sendMail, HUMAN } from './mail.ts';
import * as blockers from './blockers.ts';
import * as costNotices from './cost-notices.ts';
import * as budgets from './budgets.ts';
import * as allocations from './allocations.ts';
import { onReading, evaluateRules } from './rules.ts';
import { onReading as onPauseReading } from './cost-pause.ts';
import { convert, costDisplay, kindResolver, roundModes, zeroModes, type Ctx, type Modes } from './cost-display.ts';
import { typicalIssue } from './issue-costs.ts';
import { kindCosts, type KindCosts, windowShares,windowStart, windowSummary, treeTotals, treeSummary, historyCalibration, withSampleMemo, ESTIMATE_NOTE, type CachedWindow, type TreeNode } from './attribution.ts';
import * as events from './events.ts';
import { typeOf } from './agent-class.ts';

const warned = new Set<string>();
const day = () => new Date().toISOString().slice(0, 10);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

// The per-bucket samples and window readings are pruned to this many days, at most once an
// hour (the tables are scanned on every report, so the throttle keeps that off the hot path).
const SAMPLE_BUCKET_MS = 5 * 60_000;
const PRUNE_MS = 3_600_000;
let lastPrune = 0;

// The UTC start of the 5-minute bucket containing `t`, as an ISO string.
export function bucketOf(t: number): string {
  return new Date(Math.floor(t / SAMPLE_BUCKET_MS) * SAMPLE_BUCKET_MS).toISOString();
}

// The baseline format. Bumping it makes older baselines incomparable, so the first reading
// replaces them and records nothing, instead of being read as a session restart.
const BASELINE_VERSION = 2;
const COUNTERS = ['cost', 'tin', 'tout', 'tcr', 'tcw'] as const;
type Counter = (typeof COUNTERS)[number];

// An account that bills to the OpenRouter credit, by its match and not its name.
function orAccount(account: string): boolean {
  const acct = settings().cost.accounts?.[account];
  return account === 'openrouter' || account === SYSTEM_ACCOUNT || (acct != null && isOpenRouter(acct, account));
}

// Records a cumulative report. Counters are independent: a drop in one restarts only it, an
// absent one keeps its baseline, and a new session identity (a new transcript or session
// id) restarts the token counters only, so a new session's totals count from zero without
// subtracting another session's, while cost keeps its own line. `now` is the report's time,
// injectable for tests; it fixes the day and the sample bucket.
export function report(
  a: db.Agent,
  cumulative: {
    cost?: number;
    tokensIn?: number;
    tokensOut?: number;
    tokensCacheRead?: number;
    tokensCacheWrite?: number;
    session?: string | null;
    // The counters are cumulative for the session id and never reset inside it (OpenCode):
    // a lower reading is a stale or out-of-order read, not a restart, so it records nothing
    // and keeps the higher baseline. A new session id starts every counter at zero.
    sessionCumulative?: boolean;
  },
  now: number = Date.now(),
): void {
  const given: Record<Counter, number | undefined> = {
    cost: cumulative.cost,
    tin: cumulative.tokensIn,
    tout: cumulative.tokensOut,
    tcr: cumulative.tokensCacheRead,
    tcw: cumulative.tokensCacheWrite,
  };
  if (COUNTERS.every((k) => given[k] === undefined)) return;
  // The baseline lives on the agent, so it survives daemon restarts; a new agent has none.
  let old: Record<string, unknown> | null = null;
  try {
    old = a.usage_last ? JSON.parse(a.usage_last) : null;
  } catch {
    old = null;
  }
  // An older baseline: seed the new format from this reading and record nothing, so a
  // change in what a harness counts is never mistaken for a session restart.
  if (old && old.v !== BASELINE_VERSION) {
    const seed: Record<string, unknown> = { v: BASELINE_VERSION };
    if (cumulative.session != null) seed.id = cumulative.session;
    for (const k of COUNTERS) if (given[k] !== undefined) seed[k] = given[k];
    db.updateAgent(a.id, { usage_last: JSON.stringify(seed) });
    return;
  }
  const base = old ?? {};
  const idChanged = cumulative.session != null && cumulative.session !== base.id;
  const next: Record<string, unknown> = { v: BASELINE_VERSION };
  if (cumulative.session != null) next.id = cumulative.session;
  else if (base.id !== undefined) next.id = base.id;
  const delta: Record<Counter, number> = { cost: 0, tin: 0, tout: 0, tcr: 0, tcw: 0 };
  let changed = idChanged;
  for (const k of COUNTERS) {
    const value = given[k];
    if (value === undefined) {
      // Not reported now: keep the baseline, unless a new session resets the token counters.
      next[k] = idChanged && k !== 'cost' ? 0 : base[k];
      continue;
    }
    const kept = typeof base[k] === 'number' ? (base[k] as number) : 0;
    const prev = idChanged && (k !== 'cost' || cumulative.sessionCumulative) ? 0 : kept;
    if (cumulative.sessionCumulative && !idChanged && value < prev) {
      next[k] = prev;
      continue;
    }
    delta[k] = value >= prev ? value - prev : value;
    next[k] = value;
    if (value !== base[k]) changed = true;
  }
  if (!changed && COUNTERS.every((k) => delta[k] <= 0)) return;
  db.updateAgent(a.id, { usage_last: JSON.stringify(next) });
  if (COUNTERS.every((k) => delta[k] <= 0)) return;
  const account = accountFor(a) ?? '';
  // A paid account's statusline cost counts as paid estimate only while a reported window
  // reads 100%: that is when the harness has left the subscription and started charging
  // (docs/cost-policy.md, build step 3).
  const paidEstimate = account !== '' && settings().cost.accounts[account]?.paid === true && windowAt100(a.harness) ? delta.cost : 0;
  // The same growth on a paid: false account is paid spend the user's rule forbids.
  if (account !== '' && settings().cost.accounts[account]?.paid === false && delta.cost > 0 && windowAt100(a.harness, now))
    void evaluateRules(account, { paid: { source: `${a.name}'s cost grew $${delta.cost.toFixed(4)} while a window read 100%` } }, now);
  db.open()
    .prepare(
      `INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, paid_estimate_usd, unreconciled_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd,
         tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out,
         tokens_cache_read = tokens_cache_read + excluded.tokens_cache_read, tokens_cache_write = tokens_cache_write + excluded.tokens_cache_write,
         paid_estimate_usd = paid_estimate_usd + excluded.paid_estimate_usd,
         unreconciled_usd = unreconciled_usd + excluded.unreconciled_usd, model = excluded.model`,
    )
    .run(a.id, dayOf(now), a.harness, a.model, account, delta.cost, delta.tin, delta.tout, delta.tcr, delta.tcw, paidEstimate, orAccount(account) ? delta.cost : 0);
  recordSample(a, account, delta, now);
  pruneSamples(now);
  // The system view's cost animation (S-456): the agent's total is filled in at flush.
  events.agentChanged(a.id, {});
  // The tree allocations on this account get a usd check when paid spend grows (step 10).
  if (account) allocations.checkUsd(account, now);
  if (account) void budgets.onSpend(account, now);
  checkDailySpend();
}

// Adds this report's delta to its 5-minute bucket, the same numbers as the daily row, so a
// later step can split a window's percentage change among the agents that ran in the
// interval (docs/cost-policy.md, build step 6). model is part of the key; a null model is
// stored as '' so the upsert's conflict matches, as account does for an unmanaged agent.
function recordSample(a: db.Agent, account: string, delta: Record<Counter, number>, now: number): void {
  db.open()
    .prepare(
      `INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, bucket, account, model) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd,
         tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out,
         tokens_cache_read = tokens_cache_read + excluded.tokens_cache_read, tokens_cache_write = tokens_cache_write + excluded.tokens_cache_write,
         harness = excluded.harness`,
    )
    .run(a.id, account, a.harness, a.model ?? '', bucketOf(now), delta.cost, delta.tin, delta.tout, delta.tcr, delta.tcw);
}

// Keeps usage_samples and window_readings to the last SAMPLE_RETENTION_MS, at most once an hour.
export function pruneSamples(now: number): void {
  if (now - lastPrune < PRUNE_MS) return;
  lastPrune = now;
  const since = new Date(now - db.SAMPLE_RETENTION_MS).toISOString();
  const d = db.open();
  d.prepare('DELETE FROM usage_samples WHERE bucket < ?').run(since);
  d.prepare('DELETE FROM window_readings WHERE at < ?').run(since);
}

const SUBSCRIPTION_SAME_MS = 10_000;
const lastSubscription = new Map<string, { text: string; at: number }>();

// Records one statusline refresh. The windows are stored before the cost, so report()
// classifies the cost against this refresh's windows, not the previous one's. A refresh with
// neither windows nor counters does nothing.
export function reportStatusline(
  a: db.Agent,
  f: {
    cost?: number;
    tokensIn?: number;
    tokensOut?: number;
    tokensCacheRead?: number;
    tokensCacheWrite?: number;
    session?: string | null;
    subscription?: Record<string, { used_percentage?: number; resets_at?: number }>;
  },
): void {
  if (f.subscription) {
    // The same reading as the last one for this harness, inside SUBSCRIPTION_SAME_MS, changes nothing
    // reportSubscription records, so it skips its queries (S-2126). A change goes through at once.
    const text = JSON.stringify(f.subscription);
    const last = lastSubscription.get(a.harness);
    const now = Date.now();
    if (!last || last.text !== text || now - last.at >= SUBSCRIPTION_SAME_MS) {
      lastSubscription.set(a.harness, { text, at: now });
      reportSubscription(a.harness, f.subscription);
    }
  }
  if (f.cost !== undefined || f.tokensIn !== undefined || f.tokensCacheRead !== undefined) report(a, f);
}

// True when the harness's latest subscription reading has a window at 100% that is fresh and
// has not reset: the point at which a paid account's extra usage starts. An exhausted window
// whose resets_at has passed has reset, and a reading older than STALE_MS is unknown, so
// neither keeps the estimate accruing. Malformed data is treated as not at 100%.
function windowAt100(harness: string, now: number = Date.now()): boolean {
  const row = db.open().prepare('SELECT data, updated_at FROM subscriptions WHERE name = ?').get(harness) as { data: string; updated_at: string } | undefined;
  if (!row) return false;
  const age = Date.parse(row.updated_at);
  if (Number.isFinite(age) && now - age > STALE_MS) return false;
  try {
    const data = JSON.parse(row.data);
    return Object.values(data ?? {}).some((w) => {
      const win = w as { used_percentage?: unknown; resets_at?: unknown };
      if (typeof win?.used_percentage !== 'number' || win.used_percentage < 100) return false;
      return typeof win.resets_at !== 'number' || win.resets_at * 1000 > now;
    });
  } catch {
    return false;
  }
}

// Subscription windows, for example Claude's five_hour and seven_day rate limits. A reading
// may carry extra keys beside the windows (Codex's credits and planType); they are stored
// but never warned on, having no used_percentage. `now` is the reading's time, injectable
// for tests.
export function reportSubscription(name: string, windows: Record<string, unknown>, now: number = Date.now()): void {
  const at = new Date(now).toISOString();
  const prevRow = db.open().prepare('SELECT data FROM subscriptions WHERE name = ?').get(name) as { data: string } | undefined;
  db.open()
    .prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(name, JSON.stringify(windows), at);
  for (const [window, value] of Object.entries(windows)) {
    const w = value as { used_percentage: number; resets_at?: number } | null;
    if (w?.used_percentage == null) continue;
    recordWindowReading(name, window, w, at);
    for (const threshold of settings().cost.subscriptionWarnPercent) {
      const key = `${name}:${window}:${threshold}:${w.resets_at}`;
      if (w.used_percentage < threshold || warned.has(key)) continue;
      warned.add(key);
      // The responsible managers hear first; the human only when humanMail.when allows it.
      costNotices.windowWarning(name, window, w.used_percentage, threshold, w.resets_at, now);
      const running = db.listAgents().filter((x) => x.lifecycle === 'active' && x.harness === name).map((x) => x.name);
      mailHuman(
        `${name} ${window.replace('_', '-')} usage at ${w.used_percentage}%`,
        render('subscription-warning', {
          name,
          window: window.replace('_', '-'),
          percent: w.used_percentage,
          threshold,
          resets: w.resets_at ? new Date(w.resets_at * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'at an unknown time',
          agents: running.join(', ') || 'none',
        }),
      );
    }
    // A window burning toward 100% within 30 minutes warns its managers (throttled).
    costNotices.checkProjection(name, window, now);
    // A tree allocation on this window is checked at 80% and 100% of the allocation, once
    // per reset (step 10); it never sets a blocker.
    allocations.checkWindow(name, window, now);
  }
  pruneSamples(now);
  let prev: Record<string, any> | null = null;
  try {
    prev = prevRow ? JSON.parse(prevRow.data) : null;
  } catch {}
  void onReading(name, prev, windows as Record<string, any>, now);
  // A cost pause waiting on this account's window may now be clearable.
  onPauseReading(name, now);
  // Subscription windows changed (an unchanged reading is the common case on every
  // statusline refresh): tell the web to refetch /api/usage (S-456).
  if (JSON.stringify(prev) !== JSON.stringify(windows)) events.emitEvent('usage.changed', {});
}

// One row per change in a window's percentage or reset time, so the span between two rows is
// a percentage change a later step attributes (docs/cost-policy.md, build step 6). An
// unchanged reading, the common case on every statusline refresh, writes nothing.
function recordWindowReading(name: string, window: string, w: { used_percentage: number; resets_at?: number }, at: string): void {
  const resets = typeof w.resets_at === 'number' ? w.resets_at : null;
  const last = db.open().prepare('SELECT used_percentage, resets_at FROM window_readings WHERE name = ? AND window = ? ORDER BY at DESC LIMIT 1').get(name, window) as
    | { used_percentage: number | null; resets_at: number | null }
    | undefined;
  if (last && last.used_percentage === w.used_percentage && last.resets_at === resets) return;
  db.open().prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)').run(name, window, at, w.used_percentage, resets);
}

function checkDailySpend(): void {
  const threshold = settings().cost.dailyWarnUsd;
  if (!threshold) return;
  const key = `daily:${day()}`;
  if (warned.has(key)) return;
  const spent = (db.open().prepare('SELECT SUM(cost_usd) AS s FROM usage WHERE day = ?').get(day()) as { s: number | null }).s ?? 0;
  if (spent < threshold) return;
  warned.add(key);
  const top = (db.open().prepare('SELECT agent_id, cost_usd FROM usage WHERE day = ? ORDER BY cost_usd DESC LIMIT 5').all(day()) as { agent_id: string; cost_usd: number }[])
    .map((r) => `${db.getAgent(r.agent_id)?.name ?? r.agent_id} $${r.cost_usd.toFixed(2)}`)
    .join(', ');
  mailHuman(`Daily spend passed $${threshold}`, render('daily-spend-warning', { spent: spent.toFixed(2), threshold, top }));
}

// Mail to the human needs a sender; the first running agent stands in, as stam itself has no
// mailbox. A warning is 'important': under the default humanMail.when 'necessary' the
// responsible manager handles it and the human is not mailed (docs/cost-policy.md, step 11).
function mailHuman(subject: string, body: string, level: 'necessary' | 'important' | 'everything' = 'important'): void {
  if (!humanMailAllows(level)) return;
  const sender = db.listAgents().find((a) => a.lifecycle === 'active');
  if (sender) sendMail({ from: sender.id, to: [HUMAN], subject: `[stam] ${subject}`, body, from_stam: true }).catch(() => {});
}

export interface UsageSample {
  agent_id: string;
  account: string;
  harness: string;
  model: string;
  bucket: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

// The per-bucket samples for an account from `since` (inclusive) to `until` (exclusive), two
// ISO instants, oldest first. The next step (attribution) sums these per interval.
export function samples(account: string, since: string, until: string): UsageSample[] {
  return db.open()
    .prepare('SELECT * FROM usage_samples WHERE account = ? AND bucket >= ? AND bucket < ? ORDER BY bucket, agent_id, model')
    .all(account, since, until) as unknown as UsageSample[];
}

// The attribution the Usage page needs is one pass over the samples, window readings and the
// ledger. The page polls it, so it is memoized for 30 seconds and the same pass feeds the
// per-account window shares and the tree totals.
const SNAPSHOT_TTL_MS = 30_000;
interface Snapshot {
  shares: Record<string, Record<string, unknown>>;
  trees: TreeNode[];
  // Each window's shares and history calibration, for usage_info tree=.
  windows: CachedWindow[];
}
let snapshotMemo: { key: string; at: number; value: Snapshot } | null = null;

// Drops the memo. Tests call it between synthetic states; nothing in the daemon does.
export function resetSnapshotMemo(): void {
  snapshotMemo = null;
}

function snapshot(reads: { account: string; windows: Record<string, unknown> }[], days: number, now: number): Snapshot {
  return withSampleMemo(() => snapshotUncached(reads, days, now));
}

function snapshotUncached(reads: { account: string; windows: Record<string, unknown> }[], days: number, now: number): Snapshot {
  const key = days + '|' + reads.map((r) => r.account + ':' + Object.keys(r.windows).sort().join(',')).join(';');
  if (snapshotMemo && snapshotMemo.key === key && now >= snapshotMemo.at && now - snapshotMemo.at < SNAPSHOT_TTL_MS) return snapshotMemo.value;
  const shares: Record<string, Record<string, unknown>> = {};
  const windows: CachedWindow[] = [];
  for (const r of reads) {
    if (!Object.keys(r.windows).length) continue;
    for (const window of Object.keys(r.windows)) {
      // The long calibration first: its samples serve the window's shorter range (withSampleMemo).
      const cal = timed('snapshot: history calibration', () => historyCalibration(r.account, window, now));
      const s = timed('snapshot: window shares', () => windowShares(r.account, window, undefined, now));
      windows.push({ account: r.account, window, shares: s, cal });
      (shares[r.account] ??= {})[window] = timed('snapshot: window summary', () => windowSummary(r.account, window, s, now, cal));
    }
  }
  const value = { shares, trees: timed('snapshot: tree totals', () => treeTotals(days, now, windows, snapshotCtx(shares))), windows };
  snapshotMemo = { key, at: now, value };
  return value;
}

// The display context for the cost units the Usage page shows (src/cost-display.ts), built from
// the snapshot's own window shares so it costs no second calibration: kind and price from the
// settings, worth from the shares the snapshot just computed (null when a window isn't calibrated).
function snapshotCtx(shares: Record<string, Record<string, unknown>>): Ctx {
  const { prices } = costDisplay();
  return {
    kind: kindResolver(),
    worth: (account, window) => (shares[account]?.[window] as { worth?: { worth_usd?: { mid?: number } | null } } | undefined)?.worth?.worth_usd?.mid ?? null,
    price: (account) => prices[account] ?? null,
  };
}

// The API-equivalent spend per account for a `usage` query, the raw input to convert (S-316).
function accountsOf(where: string, params: any[] = []): Map<string, number> {
  const rows = db.open().prepare(`SELECT account, SUM(cost_usd) AS c FROM usage${where} GROUP BY account`).all(...params) as { account: string; c: number | null }[];
  return new Map(rows.map((r) => [r.account, Number(r.c) || 0]));
}

// The modes for each key of a `usage` query grouped further by account: `keySql` is a column (or
// expression) and `where` a clause with `?` placeholders. One query per table, no per-row reads.
function modesBy(keySql: string, where: string, params: any[], ctx: Ctx): Map<string, Modes> {
  const rows = db.open().prepare(`SELECT ${keySql} AS k, account, SUM(cost_usd) AS c FROM usage${where} GROUP BY k, account`).all(...params) as { k: string; account: string; c: number | null }[];
  const byKey = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = byKey.get(r.k);
    if (!m) byKey.set(r.k, (m = new Map()));
    m.set(r.account, (m.get(r.account) ?? 0) + (Number(r.c) || 0));
  }
  return new Map([...byKey].map(([k, m]) => [k, roundModes(convert(m, ctx))]));
}

// The 30-second snapshot's window shares and worths, for the cost display (src/cost-display.ts):
// an agent's estimated share of each current window per account, and a full window's worth per
// account. Never calibrates on its own beyond the snapshot the Usage page shares.
// The windows' worth from the last snapshot, whatever its age, without computing one (S-1009): the
// activity views read it, so a request never runs the 14-day calibration (a few hundred ms live). A
// stale or missing snapshot is refreshed in the background, once; until the first one, worth is null.
let worthRefresh: ReturnType<typeof setTimeout> | null = null;
export function cachedWorth(now: number = Date.now()): (account: string, window: 'five_hour' | 'seven_day') => number | null {
  const memo = snapshotMemo;
  if ((!memo || now - memo.at >= SNAPSHOT_TTL_MS) && !worthRefresh) {
    worthRefresh = setTimeout(() => {
      worthRefresh = null;
      try {
        displayContext();
      } catch (e) {
        console.error(`usage snapshot: ${e instanceof Error ? e.message : e}`);
      }
    }, 0);
    worthRefresh.unref?.();
  }
  const shares = memo?.value.shares ?? {};
  return (account, window) => (shares[account]?.[window] as { worth?: { worth_usd?: { mid?: number } | null } } | undefined)?.worth?.worth_usd?.mid ?? null;
}

export function displayContext(now: number = Date.now()): {
  worth(account: string, window: 'five_hour' | 'seven_day'): number | null;
  // The agent's share of the account's current window in percent: 0 when it has no use in it,
  // null when the window isn't calibrated and the agent has spend in it.
  share(agentId: string, account: string, window: 'five_hour' | 'seven_day'): number | null;
} {
  const snap = timed('agents: snapshot', () => snapshot(timed('snapshot: account readings', () => accountReadings(now)), 14, now));
  const worth = (account: string, window: string): number | null => {
    const w = (snap.shares[account]?.[window] as { worth?: { worth_usd?: { mid?: number } | null } } | undefined)?.worth;
    return w?.worth_usd?.mid ?? null;
  };
  // Spend per agent since the window began, for accounts that aren't calibrated; read on demand.
  const recent = new Map<string, Map<string, number>>();
  const spendIn = (account: string, window: string): Map<string, number> => {
    const k = account + '|' + window;
    if (!recent.has(k)) {
      const rows = db.open()
        .prepare('SELECT agent_id, SUM(cost_usd) AS c FROM usage_samples WHERE account = ? AND bucket >= ? GROUP BY agent_id')
        .all(account, new Date(windowStart(account, window, now)).toISOString()) as { agent_id: string; c: number }[];
      recent.set(k, new Map(rows.map((r) => [r.agent_id, r.c])));
    }
    return recent.get(k)!;
  };
  return {
    worth,
    share(agentId, account, window) {
      const w = snap.windows.find((x) => x.account === account && x.window === window);
      if (w && w.shares.scale != null) return w.shares.agents[agentId] ?? 0;
      return (spendIn(account, window).get(agentId) ?? 0) > 0 ? null : 0;
    },
  };
}

// One tree for usage_info tree=AGENT: its shares, history and pattern projection, allocations, and
// what a finished issue with its root's config typically used (build step 9).
function treeView(tree: string, windows: CachedWindow[], now: number): Record<string, unknown> {
  const root = db.getAgent(tree);
  return {
    ...treeSummary(tree, now, windows),
    allocations: allocations.view(root?.id ?? tree),
    typical_issue: root ? typicalIssue(`${root.harness} · ${root.model || 'unknown'}`) : null,
  };
}

// The ids in the usage table whose agent type (src/agent-class.ts, the one the Activity summary uses) is in `keep`.
// An id with no registry row, such as stam's own decide spend, is `untyped`.
function keptAgentIds(keep: Set<string>): Set<string> {
  const cos = settings().chiefOfStaff;
  const ids = (db.open().prepare('SELECT DISTINCT agent_id FROM usage').all() as { agent_id: string }[]).map((r) => r.agent_id);
  return new Set(ids.filter((id) => {
    const a = db.getAgent(id);
    return keep.has(a ? typeOf(a, cos) : 'untyped');
  }));
}

// `tree`, an agent id, adds that tree's estimated share of each window (usage_info tree=AGENT). `keep`, a set of
// agent types (parseAgentFilter), limits by_day, by_model, by_agent, by_account, today and trees to agents of those
// types in every cost unit; the windows, allocations, reserve and limits stay account-wide. Null keeps every agent.
export function summary(days = 14, tree?: string, keep: Set<string> | null = null): unknown {
  const now = Date.now();
  const d = db.open();
  // Today is the calendar day, not the last 24 hours: days=1 starts at today's rows.
  const since = days <= 1 ? day() : new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const reads = accountReadings(now);
  const snapUnfiltered = snapshot(reads, days, now);
  const kept = keep ? keptAgentIds(keep) : null;
  // The window shares are account-wide; only the trees' own sums narrow to the kept agents.
  const snap = kept ? { ...snapUnfiltered, trees: withSampleMemo(() => treeTotals(days, now, snapUnfiltered.windows, snapshotCtx(snapUnfiltered.shares), kept)) } : snapUnfiltered;
  // `where` (a clause with `?` placeholders, or '') and its params, narrowed to the kept agents.
  const only = (where: string, params: any[] = []): [string, any[]] =>
    kept ? [`${where ? where + ' AND' : ' WHERE'} agent_id IN (SELECT value FROM json_each(?))`, [...params, JSON.stringify([...kept])]] : [where, params];
  const agentSql = kept ? ' AND agent_id IN (SELECT value FROM json_each(?))' : '';
  const agentArg: string[] = kept ? [JSON.stringify([...kept])] : [];
  const subs = (d.prepare('SELECT name, data, updated_at FROM subscriptions').all() as { name: string; data: string; updated_at: string }[]).map((s) => ({
    name: s.name,
    windows: JSON.parse(s.data),
    updated_at: s.updated_at,
  }));
  // Per-agent tokens and cost for two more scopes beside the period's rows below: today and
  // the agent's whole life. Keyed by agent id, absent when the agent has no rows in that
  // scope, so a missing counter can read as missing rather than 0 (see totalsFor).
  const life = totalsByAgent(...only(''));
  const todayByAgent = totalsByAgent(...only(' WHERE day = ?', [day()]));
  const todayByModel = totalsByModel(...only(' WHERE day = ?', [day()]));
  const lifeByModel = totalsByModel(...only(''));
  const decideRows = !keep || keep.has('untyped') ? decideDayRows() : [];
  const decidePeriod = decideSpend(decideRows, (x) => x >= since);
  const decideToday = decideSpend(decideRows, (x) => x === day());
  const decideLife = decideSpend(decideRows, () => true);
  // Every row's cost in all four display units (S-316, S-333), from the snapshot's own window
  // worths, so the Usage page's Measure control switches without another fetch. `api` is the
  // API-equivalent dollars above; where a unit can't be computed for a row it is null, and the
  // UI shows a dash rather than an invented number.
  const ctx = snapshotCtx(snap.shares);
  const todayModes = roundModes(convert(accountsOf(...only(' WHERE day = ?', [day()])), ctx));
  const dayModes = modesBy('day', ...only(' WHERE day >= ?', [since]), ctx);
  const modelModes = modesBy("harness || char(0) || COALESCE(model, '')", ...only(' WHERE day >= ?', [since]), ctx);
  const agentModes = modesBy('agent_id', ...only(' WHERE day >= ?', [since]), ctx);
  const todayModelModes = modesBy("harness || char(0) || COALESCE(model, '')", ...only(' WHERE day = ?', [day()]), ctx);
  const lifeModelModes = modesBy("harness || char(0) || COALESCE(model, '')", ...only(''), ctx);
  const todayAgentModes = modesBy('agent_id', ...only(' WHERE day = ?', [day()]), ctx);
  const lifeAgentModes = modesBy('agent_id', ...only(''), ctx);
  const accountModes = modesBy('account', ...only(' WHERE day >= ?', [since]), ctx);
  // Stam's decide spend runs on openrouter (a paid account), so its units are all paid.
  const decideModes = (cost: number) => roundModes(convert(new Map([['openrouter', cost]]), ctx));
  return {
    note: 'cost_usd is what the harness reports: API-equivalent for Claude Code (not billed on a subscription), provider cost for OpenCode.',
    // The Settings default cost unit (cost.display.mode), so the Usage page's Measure control
    // starts on it (S-663).
    display_mode: costDisplay().mode,
    // The user's free-text cost instructions, so a manager reading usage_info has them.
    instructions: settings().cost.instructions ?? '',
    subscriptions: subs,
    // The OpenRouter system reserve and the credit left above it, for the System card (S-1203).
    openrouter_reserve: budgets.creditReserve(now),
    // Per-account cost readings (docs/cost-policy.md, build step 3): windows and freshness,
    // paid spend by period with its source, and the account's budget and what is left. Each
    // account's `shares` (build step 7) carries, per window, the top and the full agent, tree
    // and model shares, the daily history, the worth estimate, `other`, and the projection.
    accounts: reads.map((r) => ({ ...r, shares: Object.keys(r.windows).length ? snap.shares[r.account] ?? null : null })),
    shares_note: ESTIMATE_NOTE,
    // Every tree (root agent) with its total API-equivalent cost and tokens over the period
    // and its share of each window, nested for the Usage page's collapsible tree.
    trees: snap.trees,
    // Every tree allocation with its current use, and the same for one tree when asked
    // (docs/cost-policy.md, build step 10). Allocations are never enforced.
    allocations: allocations.view(undefined),
    ...(tree ? { tree: treeView(tree, snap.windows, now) } : {}),
    today: { ...(d.prepare('SELECT ROUND(SUM(cost_usd), 4) AS cost_usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(tokens_cache_read) AS tokens_cache_read, SUM(tokens_cache_write) AS tokens_cache_write FROM usage WHERE day = ?' + agentSql).get(day(), ...agentArg) as Record<string, unknown>), modes: todayModes },
    by_day: (d.prepare('SELECT day, ROUND(SUM(cost_usd), 4) AS cost_usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(tokens_cache_read) AS tokens_cache_read, SUM(tokens_cache_write) AS tokens_cache_write FROM usage WHERE day >= ?' + agentSql + ' GROUP BY day ORDER BY day').all(since, ...agentArg) as { day: string }[]).map((r) => ({ ...r, modes: dayModes.get(r.day) ?? zeroModes() })),
    // Each row also carries `today` and `lifetime` totals for its harness and model, with the
    // same missing-counter semantics as by_agent, for the By model table's columns.
    // Stam's decide spend is split by purpose from the decide events, not the usage rows (see
    // decideSpend), so those rows are left out here.
    by_model: [
      ...(d.prepare("SELECT harness, model, ROUND(SUM(cost_usd), 4) AS cost_usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(tokens_cache_read) AS tokens_cache_read, SUM(tokens_cache_write) AS tokens_cache_write FROM usage WHERE day >= ? AND NOT (agent_id = 'stam' AND account IN ('openrouter', 'openrouter-system'))" + agentSql + ' GROUP BY harness, model').all(since, ...agentArg) as any[]).map((r) => {
        const key = modelKey(r.harness, r.model);
        // The API-equivalent cost per token kind and in total (S-1440), for the period and for
        // each scope's own counters.
        const priced = (t: UsageTotals): UsageTotals & KindCosts => ({ ...t, ...kindCosts(r.model, t) });
        return {
          ...r,
          ...kindCosts(r.model, r),
          modes: modelModes.get(key) ?? zeroModes(),
          today: priced(totalsFor(r.harness, todayByModel.get(key), todayModelModes.get(key))),
          lifetime: priced(totalsFor(r.harness, lifeByModel.get(key), lifeModelModes.get(key))),
        };
      }),
      ...[...decidePeriod].map(([purpose, s]) => ({
        harness: 'openrouter',
        model: purpose,
        cost_usd: Math.round(s.cost_usd * 1e4) / 1e4,
        modes: decideModes(s.cost_usd),
        tokens_in: s.tokens_in,
        tokens_out: s.tokens_out,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        today: totalsFor('openrouter', decideToday.get(purpose), decideModes(decideToday.get(purpose)?.cost_usd ?? 0)),
        lifetime: totalsFor('openrouter', decideLife.get(purpose), decideModes(decideLife.get(purpose)?.cost_usd ?? 0)),
      })),
    ].sort((a, b) => b.cost_usd - a.cost_usd),
    // The top-level numbers are the period's totals, as before; each row also names the
    // agent, its harness and model, and carries `today` and `lifetime` totals with the same
    // missing-counter semantics as agentUsage (S-95), for the per-agent table's columns.
    by_agent: (d.prepare('SELECT agent_id, ROUND(SUM(cost_usd), 4) AS cost_usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(tokens_cache_read) AS tokens_cache_read, SUM(tokens_cache_write) AS tokens_cache_write FROM usage WHERE day >= ?' + agentSql + ' GROUP BY agent_id ORDER BY 2 DESC LIMIT 30').all(since, ...agentArg) as any[]).map((r) => {
      const a = db.getAgent(r.agent_id);
      const harness = a?.harness ?? '';
      return {
        ...r,
        agent: a?.name ?? r.agent_id,
        // The agent type the Agents tab filters by (S-1491, src/agent-class.ts).
        type: a ? typeOf(a, settings().chiefOfStaff) : 'untyped',
        harness,
        model: a?.model ?? null,
        modes: agentModes.get(r.agent_id) ?? zeroModes(),
        today: totalsFor(harness, todayByAgent.get(r.agent_id), todayAgentModes.get(r.agent_id)),
        lifetime: totalsFor(harness, life.get(r.agent_id), lifeAgentModes.get(r.agent_id)),
      };
    }),
    // Agents stam holds for cost, with each blocker. See blockers.ts.
    blocked: blockers.blocked(),
    by_account: (d.prepare('SELECT account, ROUND(SUM(cost_usd), 4) AS cost_usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(tokens_cache_read) AS tokens_cache_read, SUM(tokens_cache_write) AS tokens_cache_write FROM usage WHERE day >= ?' + agentSql + ' GROUP BY account ORDER BY 2 DESC').all(since, ...agentArg) as { account: string }[]).map((r) => ({ ...r, modes: accountModes.get(r.account) ?? zeroModes() })),
    // How many 5-minute samples are kept, so the Usage view can say the per-interval data
    // exists without reading it (build step 6). The samples themselves are the next step's.
    sample_count: (d.prepare('SELECT COUNT(*) AS n FROM usage_samples').get() as { n: number }).n,
    // Echo of the filter that was applied (sorted types), null when unfiltered; an older daemon omits it, so a page
    // never labels unfiltered numbers as filtered (S-1753).
    filtered_agents: keep ? [...keep].sort() : null,
    // Cold turns after a wake or a compaction, and agents on the 5-minute cache window (S-2236).
    cache: cacheCold.summary(since, kept ? ' AND agent_id IN (SELECT value FROM json_each(?))' : '', agentArg),
    // Agents with spend in the period per type, ignoring the filter, for the Agent types bar.
    agent_types: agentTypeCounts(since),
  };
}

function agentTypeCounts(since: string): { type: string; count: number }[] {
  const cos = settings().chiefOfStaff;
  const n = new Map<string, number>();
  for (const r of db.open().prepare('SELECT DISTINCT agent_id FROM usage WHERE day >= ?').all(since) as { agent_id: string }[]) {
    const a = db.getAgent(r.agent_id);
    const t = a ? typeOf(a, cos) : 'untyped';
    n.set(t, (n.get(t) ?? 0) + 1);
  }
  return [...n].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

// --- One agent's own usage (S-95) ---------------------------------------------------
//
// The four token counters and cost, per agent, for today and for its whole life, so the
// agent's own view can show them. A counter the harness doesn't report is null rather than
// 0, so the UI can show it as missing: Codex reports tokens but no cost (src/adapters/
// codex.ts), so a Codex agent's cost reads as missing, not as "$0". A counter is also null
// when the agent has no usage rows in that scope: it hasn't had a model turn yet.

// Stam's decide spend per purpose and day (decide.ts), one row per (purpose, day), from the
// `decide` events in one query. The usage row for stam on openrouter keeps only the last
// purpose, so the By model view reads the split from here.
interface DecideDayRow { purpose: string; day: string; n: number; cost_usd: number; tokens_in: number; tokens_out: number }
export const DECIDE_DAY_SQL = `SELECT COALESCE(json_extract(data, '$.purpose'), '') AS purpose, substr(ts, 1, 10) AS day, COUNT(*) AS n,
    SUM(COALESCE(json_extract(data, '$.cost'), 0)) AS cost_usd,
    SUM(COALESCE(json_extract(data, '$.tokens_in'), 0)) AS tokens_in,
    SUM(COALESCE(json_extract(data, '$.tokens_out'), 0)) AS tokens_out
  FROM events WHERE agent_id = 'stam' AND type = 'decide' GROUP BY purpose, day`;
function decideDayRows(): DecideDayRow[] {
  return db.open().prepare(DECIDE_DAY_SQL).all() as unknown as DecideDayRow[];
}

// The rows of the days `inDay` accepts, summed per purpose.
function decideSpend(rows: DecideDayRow[], inDay: (day: string) => boolean): Map<string, { n: number; cost_usd: number; tokens_in: number; tokens_out: number }> {
  const out = new Map<string, { n: number; cost_usd: number; tokens_in: number; tokens_out: number }>();
  for (const r of rows) {
    if (!inDay(r.day)) continue;
    const s = out.get(r.purpose) ?? { n: 0, cost_usd: 0, tokens_in: 0, tokens_out: 0 };
    s.n += r.n;
    s.cost_usd += Number(r.cost_usd) || 0;
    s.tokens_in += Number(r.tokens_in) || 0;
    s.tokens_out += Number(r.tokens_out) || 0;
    out.set(r.purpose, s);
  }
  return out;
}

export const USAGE_COUNTERS = ['cost_usd', 'tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write'] as const;
export type UsageCounter = (typeof USAGE_COUNTERS)[number];

// Which counters each harness reports. Claude Code and OpenCode report all five (OpenCode
// sends cost and every token kind); Codex reports the four token kinds and no cost. An
// unknown harness is assumed to report everything, since nothing else is known about it.
const HARNESS_COUNTERS: Record<string, readonly UsageCounter[]> = {
  claude: USAGE_COUNTERS,
  opencode: USAGE_COUNTERS,
  codex: ['tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write'],
};

export interface UsageTotals {
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  // The cost in every display unit (src/cost-display.ts), when the caller has the raw
  // per-account spend; absent for callers that only want the API-equivalent dollars.
  modes?: Modes;
}

export interface AgentUsage {
  agent_id: string;
  harness: string;
  model: string | null;
  lifetime: UsageTotals;
  today: UsageTotals;
}

const NO_TOTALS: UsageTotals = { cost_usd: null, tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_write: null };

// Turns one grouped SUM row into totals, nulling the counters the harness doesn't report
// and every counter when the agent has no rows in scope (COUNT is 0).
function totalsFor(harness: string, row: (Partial<Record<UsageCounter, number>> & { n?: number }) | undefined, modes?: Modes | null): UsageTotals {
  const out: UsageTotals = { ...NO_TOTALS };
  if (modes !== undefined) out.modes = modes ?? zeroModes();
  if (!row || !row.n) return out;
  const reports = new Set(HARNESS_COUNTERS[harness] ?? USAGE_COUNTERS);
  for (const k of USAGE_COUNTERS) if (reports.has(k)) out[k] = Number(row[k] ?? 0);
  return out;
}

type TotalsRow = Partial<Record<UsageCounter, number>> & { n: number };

// Every agent's counted rows, keyed by agent id, for one scope: `where` is '' or a clause
// with `?` placeholders and its params. An integer `n` is kept so totalsFor can tell an
// agent with no rows in the scope (absent from the map) from one whose counters are 0.
function totalsByAgent(where: string, params: any[] = []): Map<string, TotalsRow> {
  const cols = USAGE_COUNTERS.map((c) => `SUM(${c}) AS ${c}`).join(', ');
  const rows = db.open().prepare(`SELECT agent_id, COUNT(*) AS n, ${cols} FROM usage${where} GROUP BY agent_id`).all(...params) as (TotalsRow & { agent_id: string })[];
  return new Map(rows.map((r) => [r.agent_id, r]));
}

// The same, keyed by harness and model, for the By model table: `where` as totalsByAgent.
function totalsByModel(where: string, params: any[] = []): Map<string, TotalsRow> {
  const cols = USAGE_COUNTERS.map((c) => `SUM(${c}) AS ${c}`).join(', ');
  const rows = db.open().prepare(`SELECT harness, model, COUNT(*) AS n, ${cols} FROM usage${where} GROUP BY harness, model`).all(...params) as (TotalsRow & { harness: string; model: string | null })[];
  return new Map(rows.map((r) => [modelKey(r.harness, r.model), r]));
}

const modelKey = (harness: string, model: string | null) => `${harness}\u0000${model ?? ''}`;

// The per-agent usage one agent's view shows: its harness and model, and its token and cost
// totals for today and for its whole life.
export function agentUsage(a: db.Agent): AgentUsage {
  const d = db.open();
  const cols = USAGE_COUNTERS.map((c) => `SUM(${c}) AS ${c}`).join(', ');
  const life = d.prepare(`SELECT COUNT(*) AS n, ${cols} FROM usage WHERE agent_id = ?`).get(a.id) as Partial<Record<UsageCounter, number>> & { n: number };
  const today = d.prepare(`SELECT COUNT(*) AS n, ${cols} FROM usage WHERE agent_id = ? AND day = ?`).get(a.id, day()) as Partial<Record<UsageCounter, number>> & { n: number };
  // The model it actually ran when its configured model is unknown, so an agent on the
  // harness's default model still names what it used.
  const last = d.prepare("SELECT model FROM usage WHERE agent_id = ? AND model IS NOT NULL AND model <> '' ORDER BY day DESC LIMIT 1").get(a.id) as { model: string } | undefined;
  return {
    agent_id: a.id,
    harness: a.harness,
    model: a.model ?? last?.model ?? null,
    lifetime: totalsFor(a.harness, life),
    today: totalsFor(a.harness, today),
  };
}

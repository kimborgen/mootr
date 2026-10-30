// The user's rules that need no budget (docs/cost-policy.md, Rule enforcement): stam sets and
// clears the window, paid-forbidden and credits-out blockers from fresh readings and from the
// adapters' cost signals. Every trigger goes through evaluateRules(account), which is
// idempotent: re-adding a blocker keeps its `since`, and an unchanged one writes nothing.
//
//   window:ACCOUNT        set when `paid: false` and a window reads 100% in a fresh reading,
//                         or on a `limit` signal (its deadline: the exhausted windows, else the
//                         fresh window that resets soonest, else '*' with none known); cleared per window by a fresh reading taken
//                         after it was set that reads below 100%, or by the timer past its resets_at.
//                         A fresh reading of the same account on a peer counts too (peer-readings.ts,
//                         S-2367): the clear takes the newest reading on any machine, while a set
//                         takes only this machine's own readings, and a peer's never sets one.
//                         A window that re-sets within FLAP_MS of its last clear is held for
//                         FLAP_MS more: its clear needs a reading below 100% after the hold.
//   paid-forbidden:ACCOUNT set when paid spend appears on a `paid: false` account (Claude
//                         statusline cost growing while a window reads 100%, or a Codex
//                         credits balance that drops); cleared by a fresh reading taken after
//                         the window's resets_at.
//   credits-out:ACCOUNT   set by a verified balance <= 0 (OpenRouter; a `paid: true` Codex
//                         account without window headroom), Codex spendControlReached, or a
//                         `credits` signal; cleared by a fresh balance >= lowCreditsUsd (Codex:
//                         also window headroom). Claude reports no balance: its credits-out is
//                         cleared by the account's probe (cost-probes.ts), which a credits
//                         signal starts.
//
// A window or paid-forbidden blocker whose windows all have a resets_at also clears on a timer
// at resets_at plus RESET_MARGIN, with no fresh reading (a `cost:rule` clear marked
// `unconfirmed`): with every agent on an account paused, nothing may report a reading. If the
// limit still holds, the next turn's limit signal or reading sets it again.
//
// A blocker is one row per agent and account, so `window` holds all of the account's
// exhausted windows in its `clear.windows`. A reading older than STALE_MS never sets or
// clears anything, and estimates never touch a blocker. Unmanaged agents are never blocked.
// A blocker set during a turn pauses the agent with the pause notice; the turn finishes and
// the admission gate refuses the next one.
import * as db from './db.ts';
import { settings, type CostAccount } from './settings.ts';
import { accountFor } from './accounts.ts';
import { STALE_MS } from './readings.ts';
import * as blockers from './blockers.ts';
import type { BlockerKind } from './blockers.ts';
import * as probes from './cost-probes.ts';
import { peerWindows, type Served } from './peer-readings.ts';

type RuleKind = Extract<BlockerKind, 'window' | 'paid-forbidden' | 'credits-out'>;

export interface Win {
  pct: number;
  resets_at: number | null; // seconds
  at: number; // when the reading was taken, ms
}
interface Reading {
  windows: Record<string, Win>;
  balance: { usd: number; at: number } | null;
  spendControl: { reached: boolean; at: number } | null;
}
// What a window blocker waits for, per window; '*' when a limit error named no window.
interface WaitWin {
  pct: number | null;
  resets_at: number | null;
  after: string;
  // The limit error that set it, if one did.
  source?: string;
  // ms before which a reading can't clear it: set when it re-sets within FLAP_MS of a clear.
  hold?: number;
}
export interface Trigger {
  // A cost:signal's class, or paid spend seen by usage.report or a Codex balance.
  signal?: { class: 'limit' | 'credits'; source: string; message?: string };
  paid?: { source: string };
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const iso = (t: number) => new Date(t).toISOString();
const utc = (s: number) => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

function isOpenRouter(acct: CostAccount): boolean {
  return acct.match.harness === 'opencode' && (acct.match.model ?? '').startsWith('openrouter/');
}

// The subscriptions entries an account reads: its harness's (Codex's other buckets as
// `codex:ID`, their windows named `ID/WINDOW`), or OpenRouter's credit poll.
function readingFor(acct: CostAccount): Reading {
  const rows = db.open().prepare('SELECT name, data, updated_at FROM subscriptions').all() as { name: string; data: string; updated_at: string }[];
  const r: Reading = { windows: {}, balance: null, spendControl: null };
  for (const row of rows) {
    let data: Record<string, any>;
    try {
      data = JSON.parse(row.data) ?? {};
    } catch {
      continue;
    }
    const at = Date.parse(row.updated_at);
    if (!Number.isFinite(at)) continue;
    if (isOpenRouter(acct)) {
      // Only a balance the poll fetched counts, at the time it fetched it: a failed poll
      // rewrites the entry with the last figures and a new updated_at.
      const usd = num(data?.credits?.remaining);
      const seen = Date.parse(String(data?.credits?.observed_at ?? ''));
      if (row.name === 'openrouter' && usd != null && Number.isFinite(seen)) r.balance = { usd, at: seen };
      continue;
    }
    const h = acct.match.harness;
    if (row.name !== h && !row.name.startsWith(`${h}:`)) continue;
    const prefix = row.name === h ? '' : `${row.name.slice(h.length + 1)}/`;
    for (const [name, w] of Object.entries(data)) {
      const pct = num((w as any)?.used_percentage);
      if (pct == null) continue;
      r.windows[prefix + name] = { pct, resets_at: num((w as any)?.resets_at), at };
    }
    if (row.name === h) {
      const usd = num(data.credits?.balance);
      if (usd != null) r.balance = { usd, at };
      if (typeof data.spendControlReached === 'boolean') r.spendControl = { reached: data.spendControlReached, at };
    }
  }
  return r;
}

// The reset time a limit message names, in ms: "try again at 3:25 PM" or "15:25" (the next such
// time of day, in the daemon's timezone), or the dated form Codex writes for a longer limit,
// "Try again at Oct 17th, 2026 9:05 AM" (that date, local time). Null, so the default hold
// applies, when it names no time, names a date it can't read, or names a zone (UTC, GMT, Z,
// an offset), since only local time is understood. Codex truncates to the minute, so a time up
// to an hour past means now, and only an older one means tomorrow.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function parseResetTime(message: string | undefined, now: number): number | null {
  const text = message ?? '';
  const t = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?/i.exec(text);
  if (!t) return null;
  if (/^\s*(?:UTC|GMT|Z\b|[+-]\d{2}:?\d{2})/i.test(text.slice(t.index + t[0].length))) return null;
  let h = Number(t[1]);
  const min = Number(t[2]);
  const ap = t[3]?.[0]?.toLowerCase();
  if (min > 59 || (ap ? h < 1 || h > 12 : h > 23)) return null;
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  const dated = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(text);
  const d = new Date(now);
  if (dated) {
    d.setFullYear(Number(dated[3]), MONTHS.indexOf(dated[1].toLowerCase()), Number(dated[2]));
  } else if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d/i.test(text)) {
    return null;
  }
  d.setHours(h, min, 0, 0);
  if (!dated && d.getTime() <= now) {
    if (now - d.getTime() <= 60 * 60_000) return now;
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}
// With no reset time in the message, hold this long.
export const DEFAULT_HOLD_MS = 30 * 60_000;
// A window that re-sets within this long of its last clear is held for this long more, so a
// reading that flips it (a source at 100% with a stale reset, a usage hovering at 100%) can't
// pause and unpause the account in a loop. 10 minutes: the statusline reports about once a
// minute and a window's usage moves over minutes, so a real re-hit is rare and costs at most
// 10 more minutes of pause, while the 37-second flap of S-2365 falls well inside it.
export const FLAP_MS = 10 * 60_000;
// Tests start each case with no clears remembered.
export function forgetWindowClears(): void {
  db.clearWindowClears();
}
// The hold a window re-setting at `now` gets, if it cleared within FLAP_MS. The clears are in
// the window_clears table, so a restart keeps them.
function flapHold(account: string, name: string, now: number): number | undefined {
  const at = db.windowClearAt(account, name);
  return at != null && now - at < FLAP_MS ? now + FLAP_MS : undefined;
}

const fresh = (at: number, now: number) => now - at <= STALE_MS;
let resetMarginMs = 60_000;
// Tests shorten the margin.
export function setResetMargin(ms: number): void {
  resetMarginMs = ms;
}
// The margin past a window's resets_at before it clears unconfirmed. A cost pause uses the
// same margin, so its reset timer lifts at the same moment the rule blocker's does.
export function resetMargin(): number {
  return resetMarginMs;
}

// The windows of an account, each at its newest reading on any machine, fresh or stale, with
// each one's percentage, reset time, and reading time. Used by cost_pause to pick the default
// window and to watch for a reset; it never writes.
export function accountWindows(account: string, now: number = Date.now()): Record<string, Win> {
  const acct = settings().cost.accounts?.[account];
  if (!acct?.match) return {};
  return acrossMachines(account, acct, readingFor(acct).windows, now).all;
}

// What this machine's own readings say, per configured account, for a peer's peer-readings.ts
// (S-2367). Only the windows: a peer compares the match, so it never takes this account for its own.
export function servedReadings(): Served {
  const out: Served = {};
  for (const [name, acct] of Object.entries(settings().cost.accounts ?? {})) {
    if (!acct?.match) continue;
    out[name] = { match: acct.match, windows: readingFor(acct).windows };
  }
  return out;
}

// Each window at its newest reading across this machine and its peers (S-2367). `all` is what
// a clear reads. `own` is what a set reads: this machine's windows taken after the newest peer
// reading below 100% seen for that window (window_resets). Such a local reading is overtaken, and
// stays so: a later peer reading at 100% doesn't bring it back. A peer's window that no local
// reading covers never sets anything.
function acrossMachines(account: string, acct: CostAccount, local: Record<string, Win>, now: number): { all: Record<string, Win>; own: Record<string, Win> } {
  const all: Record<string, Win> = { ...local };
  const d = db.open();
  for (const [name, w] of Object.entries(peerWindows(account, acct.match, now))) {
    if (w.pct < 100) d.prepare('INSERT INTO window_resets (account, window, at) VALUES (?, ?, ?) ON CONFLICT (account, window) DO UPDATE SET at = MAX(at, excluded.at)').run(account, name, w.at);
    if (!all[name] || w.at > all[name].at) all[name] = w;
  }
  const own = Object.fromEntries(
    Object.entries(local).filter(([name, w]) => {
      const reset = d.prepare('SELECT at FROM window_resets WHERE account = ? AND window = ?').get(account, name) as { at: number } | undefined;
      return !reset || w.at >= reset.at;
    }),
  );
  return { all, own };
}
// A window wait whose reset time, plus the margin, has passed.
// A window's timer deadline: its reset plus the margin, or its flap hold's end when that is later.
const deadline = (w: WaitWin) => Math.max(w.resets_at! * 1000 + resetMarginMs, w.hold ?? 0);
const timedOut = (w: WaitWin, now: number) => w.resets_at != null && now >= deadline(w);
// A window that reads 100% and hasn't reset.
const full = (w: Win, now: number) => w.pct >= 100 && (w.resets_at == null || w.resets_at * 1000 > now);

// One evaluation per account at a time, in arrival order.
const chains = new Map<string, Promise<void>>();
// A call from outside the wake timer is new input, so an overdue wake that already fired may fire again.
export function evaluateRules(account: string, trigger: Trigger = {}, now: number = Date.now()): Promise<void> {
  firedLate.delete(account);
  return enqueue(account, trigger, now);
}
function enqueue(account: string, trigger: Trigger, now: number): Promise<void> {
  const next = (chains.get(account) ?? Promise.resolve()).then(() => evaluate(account, trigger, now)).catch((e) => {
    console.error(`cost rules for ${account}:`, e);
  });
  chains.set(account, next);
  return next;
}

// Every configured account, as at daemon start.
export function evaluateAll(now: number = Date.now()): Promise<void> {
  return Promise.all(Object.keys(settings().cost.accounts ?? {}).map((a) => evaluateRules(a, {}, now))).then(() => {});
}

// A reading was stored under this subscriptions name ('claude', 'codex', 'codex:ID', or
// 'openrouter'): evaluate the accounts it covers. `prev` is the entry it replaced, for a
// Codex credits balance that dropped.
export function onReading(name: string, prev: Record<string, any> | null, next: Record<string, any> | null, now: number = Date.now()): Promise<void> {
  const out: Promise<void>[] = [];
  for (const [account, acct] of Object.entries(settings().cost.accounts ?? {})) {
    if (!acct?.match) continue;
    const covers = name === 'openrouter' ? isOpenRouter(acct) : !isOpenRouter(acct) && (name === acct.match.harness || name.startsWith(`${acct.match.harness}:`));
    if (!covers) continue;
    const was = num(prev?.credits?.balance);
    const is = num(next?.credits?.balance);
    const dropped = name === acct.match.harness && was != null && is != null && is < was;
    out.push(evaluateRules(account, dropped ? { paid: { source: `credits balance fell from ${was} to ${is}` } } : {}, now));
  }
  return Promise.all(out).then(() => {});
}

// Records an adapter's cost signal and evaluates the agent's account on a limit or credits one.
// A transient or auth one sets the error blocker (cost-probes.ts); a Claude credits one starts
// the probe that clears its credits-out.
export function signal(agentId: string, data: { source: string; class: string } & Record<string, unknown>): void {
  db.addEvent(agentId, 'cost:signal', data);
  const a = db.getAgent(agentId);
  const account = a && accountFor(a);
  if (!account) return;
  if (data.class === 'transient' || data.class === 'auth') {
    void probes.onError(agentId, data.class, describe(data)).catch((e) => console.error(`cost error for ${account}:`, e));
    return;
  }
  if (data.class !== 'limit' && data.class !== 'credits') return;
  // Before the evaluation is queued: a probe success already on the chain is older than it.
  if (data.class === 'credits' && settings().cost.accounts?.[account]?.match.harness === 'claude') probes.start(account);
  const message = typeof data.message === 'string' ? data.message : undefined;
  const done = evaluateRules(account, { signal: { class: data.class, source: describe(data), message } });
  // The credits-out it set keeps a probe, even if the one started above came due first (S-4574).
  if (data.class === 'credits') void done.then(() => probes.ensure(account)).catch(() => {});
  // A reviewer that dies on a limit right after its spawn goes to the reviewer fallback (S-381).
  if (data.class === 'limit' && (data.source === 'turn/completed' || data.source === 'StopFailure')) void done.then(() => import('./cost-fallback.ts')).then((m) => m.relaunchReviewerAtSpawn(agentId)).catch((e) => console.error(`reviewer relaunch for ${agentId}:`, e));
}

// The account's probe of generation `gen` succeeded: a Claude credits-out clears, in the
// evaluation order, unless a newer failure came first.
export function probeCleared(account: string, why: string, gen: number): Promise<void> {
  const next = (chains.get(account) ?? Promise.resolve()).then(() => (probes.generation(account) === gen ? apply(account, 'credits-out', null, why) : undefined)).catch((e) => {
    console.error(`cost rules for ${account}:`, e);
  });
  chains.set(account, next);
  return next;
}

const describe = (d: Record<string, unknown>) => {
  const detail = d.error ?? d.codexErrorInfo ?? d.rateLimitReachedType ?? (d.spendControlReached ? 'spendControlReached' : null);
  return `${d.source}${detail ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`;
};

// The agents a rule applies to: every live agent on the account. Archived or shut-down
// agents keep no blocker, so a long-finished tree isn't held or notified (S-787).
const agentsOn = (account: string) => db.listAgents().filter((a) => db.isLive(a) && accountFor(a) === account);

interface Want {
  reason: string;
  clear: Record<string, unknown> | null;
}
interface Step {
  kind: RuleKind;
  want: Want | null;
  why: string;
  unconfirmed: boolean;
}

// What the rules want for the account now: each rule kind's blocker, or none. Reads
// the readings and the account's blocker rows. Its only writes are the account_holds row
// (set on a limit message, deleted once a reading clears or the time passes) and the trigger's
// source text, which gains the 30-minute note.
function plan(account: string, trigger: Trigger, now: number): Step[] {
  const acct = settings().cost.accounts?.[account];
  if (!acct?.match) return [];
  const r = readingFor(acct);
  const { all, own } = acrossMachines(account, acct, r.windows, now);
  // Clears read the newest reading on any machine; sets read only this machine's own.
  const m: Reading = { ...r, windows: all };
  const unpaid = acct.paid === false;
  const freshFull = Object.entries(own).filter(([, w]) => fresh(w.at, now) && full(w, now));
  const existing = (kind: RuleKind) => blockers.blockersFor(account).filter((b) => b.kind === kind);
  const steps: Step[] = [];

  // window
  {
    const cur: Record<string, WaitWin> = {};
    for (const b of existing('window')) Object.assign(cur, (b.clear?.windows as Record<string, WaitWin>) ?? {});
    // A hold from an earlier limit error, kept past its agents.
    const hold = heldUntil(account, now);
    if (hold && !cur['*']) cur['*'] = { pct: null, resets_at: hold.resets_at / 1000, after: hold.since, source: hold.source };
    const next: Record<string, WaitWin> = {};
    let confirmed = false;
    let unconfirmed = false;
    for (const [name, w] of Object.entries(cur)) {
      if (windowCleared(name, w, m, now)) confirmed = true;
      else if (timedOut(w, now)) unconfirmed = true;
      else next[name] = w;
    }
    if (unpaid)
      for (const [name, w] of freshFull)
        next[name] = { ...cur[name], pct: w.pct, resets_at: w.resets_at, after: cur[name]?.after ?? iso(w.at), hold: cur[name]?.hold ?? flapHold(account, name, now) };
    if (trigger.signal?.class === 'limit') {
      // The exhausted windows; with none, the fresh window that resets soonest, as the
      // deadline; with no reset time known, '*'.
      let named: [string, Win | null][] = freshFull;
      if (!named.length) {
        const soonest = Object.entries(own)
          .filter(([, w]) => fresh(w.at, now) && w.resets_at != null && w.resets_at * 1000 > now)
          .sort((a, b) => a[1].resets_at! - b[1].resets_at!)[0];
        named = soonest ? [soonest] : [['*', null]];
      }
      for (const [name, w] of named) {
        let resets = w?.resets_at ?? null;
        // No window reading: the reset time the message names, else a conservative default.
        if (name === '*' && trigger.signal.message != null) {
          const at = parseResetTime(trigger.signal.message, now);
          resets = (at ?? now + DEFAULT_HOLD_MS) / 1000;
          if (at == null) {
            trigger.signal = { ...trigger.signal, source: `${trigger.signal.source}; no reset time in the message, held 30 minutes` };
          }
          holdAccount(account, resets * 1000, trigger.signal.source, iso(now));
        }
        next[name] = { pct: w?.pct ?? null, resets_at: resets, after: iso(now), source: trigger.signal.source, hold: cur[name]?.hold ?? flapHold(account, name, now) };
      }
    }
    if (confirmed && hold && !next['*']) db.open().prepare('DELETE FROM account_holds WHERE account = ?').run(account);
    const u = unconfirmed && !confirmed;
    const why = trigger.signal?.class === 'limit' ? `a limit error, ${trigger.signal.source}` : u ? RESET_PASSED : 'a fresh reading';
    steps.push({ kind: 'window', want: Object.keys(next).length ? { reason: windowReason(next), clear: { windows: next } } : null, why, unconfirmed: u });
  }

  // paid-forbidden
  {
    const cur = existing('paid-forbidden')[0];
    const confirmed = cur != null && paidCleared(cur.clear as any, m, now);
    const wins = Object.values(((cur?.clear as any)?.windows ?? {}) as Record<string, WaitWin>);
    const unconfirmed = cur != null && !confirmed && wins.length > 0 && wins.every((w) => timedOut(w, now));
    let want: Want | null = cur && !confirmed && !unconfirmed ? { reason: cur.reason, clear: cur.clear } : null;
    if (unpaid && trigger.paid && !want) {
      // It clears when the exhausted windows reset; with none exhausted, the next to reset.
      let wins: [string, Win][] = freshFull;
      if (!wins.length) {
        const soonest = Object.entries(own).filter(([, w]) => fresh(w.at, now) && w.resets_at != null && w.resets_at * 1000 > now).sort((a, b) => a[1].resets_at! - b[1].resets_at!)[0];
        wins = soonest ? [soonest] : [];
      }
      const windows = Object.fromEntries(wins.map(([n, w]) => [n, { pct: w.pct, resets_at: w.resets_at, after: iso(now) }]));
      const resets = wins.length ? wins.map(([n, w]) => `${n} ${w.resets_at ? `resets ${utc(w.resets_at)}` : 'resets at an unknown time'}`).join('; ') : 'no window known; clears when a fresh reading shows none at 100%';
      want = { reason: `paid spend on a paid: false account: ${trigger.paid.source}; clears when ${resets}`, clear: { windows, after: iso(now) } };
    }
    steps.push({ kind: 'paid-forbidden', want, why: trigger.paid ? trigger.paid.source : unconfirmed ? RESET_PASSED : 'the window reset', unconfirmed });
  }

  // credits-out
  {
    const low = acct.lowCreditsUsd ?? 0.01;
    const cur = existing('credits-out')[0];
    const out = creditsOutReading(acct, r, freshFull.length > 0, now);
    const claude = acct.match.harness === 'claude';
    let want: Want | null = null;
    const keep = (reason: string) => (cur?.reason === reason ? cur.clear! : { after: iso(now) });
    if (out) want = { reason: out, clear: keep(out) };
    else if (trigger.signal?.class === 'credits') {
      const then = claude
        ? `Claude reports no balance, so stam probes the account (1, 2, 4, 8, 16 minutes, then every 16) and clears this when one succeeds`
        : `clears when a fresh balance reads at least $${low}`;
      want = { reason: `a credits error, ${trigger.signal.source}; ${then}`, clear: { after: iso(now) } };
    } else if (cur && !creditsCleared(acct, cur.clear as any, m, low, now)) want = { reason: cur.reason, clear: cur.clear! };
    const why = out ?? (trigger.signal ? trigger.signal.source : `a fresh balance of at least $${low}`);
    steps.push({ kind: 'credits-out', want, why, unconfirmed: false });
  }
  return steps;
}

// The account holds, as rows that outlive the agents that hit the limit.
function holdAccount(account: string, resetsAt: number, source: string, since: string): void {
  db.open().prepare('INSERT OR REPLACE INTO account_holds (account, resets_at, source, since) VALUES (?, ?, ?, ?)').run(account, resetsAt, source, since);
}
function heldUntil(account: string, now: number): { resets_at: number; source: string; since: string } | null {
  const row = db.open().prepare('SELECT resets_at, source, since FROM account_holds WHERE account = ?').get(account) as { resets_at: number; source: string; since: string } | undefined;
  if (!row) return null;
  if (now >= row.resets_at + resetMarginMs) {
    db.open().prepare('DELETE FROM account_holds WHERE account = ?').run(account);
    return null;
  }
  return row;
}

async function evaluate(account: string, trigger: Trigger, now: number): Promise<void> {
  const steps = plan(account, trigger, now);
  // The timer goes in before any pause is delivered, which can take a while.
  schedule(account, steps, now);
  for (const s of steps) await apply(account, s.kind, s.want, s.why, s.unconfirmed, now);
}

// The rule blockers a new agent on the account would carry now, from fresh readings and the
// account's blockers, whether or not any agent is on it yet. The spawn gate uses it.
export function spawnBlockers(account: string, now: number = Date.now()): { kind: RuleKind; reason: string; clear: Record<string, unknown> | null }[] {
  return plan(account, {}, now).flatMap((s) => (s.want ? [{ kind: s.kind, ...s.want }] : []));
}

// The windows of an unpaid account that this machine's own readings put at 100% with a valid reset
// still ahead, however old the reading is. A codex reading goes stale once no codex agent runs
// (S-382), and plan() then sees no fresh window; but a window cannot reset before its reset time.
// Eligibility is acrossMachines' `own`, as for a set: a local 100% overtaken by a peer reading
// (window_resets, kept after the peer cache ages out) does not count. Used only to pick a reviewer
// fallback type (admission.heldForFallback); it never refuses a spawn (S-905).
export function exhaustedWindows(account: string, now: number = Date.now()): { name: string; reason: string }[] {
  const acct = settings().cost.accounts?.[account];
  if (!acct?.match || acct.paid !== false) return [];
  const { own } = acrossMachines(account, acct, readingFor(acct).windows, now);
  return Object.entries(own)
    .filter(([, w]) => w.pct >= 100 && w.resets_at != null && w.resets_at * 1000 > now)
    .map(([name, w]) => ({ name, reason: `${name} at ${w.pct}%, resets ${iso(w.resets_at! * 1000)}` }));
}

// Gives a new agent, before its launch, the rule blockers its account carries: a spawn the
// human forced onto a blocked account starts held, as every other agent on it is.
export async function attachSpawn(agent: db.Agent): Promise<void> {
  const account = accountFor(agent);
  if (!account) return;
  for (const b of spawnBlockers(account)) {
    db.addEvent(agent.id, 'cost:rule', { rule: b.kind, account, action: 'set', reason: b.reason });
    await blockers.addBlocker(agent, { kind: b.kind, account, reason: b.reason, clear: b.clear });
  }
}

// A window's wait is over when a fresh reading taken after it was set reads below 100%, and its
// hold, if any, has passed. A reading at 100% never clears it, whatever its resets_at says: a
// stale reset time would otherwise clear and re-set the window on every reading (S-2365); a
// window past its reset clears on the timer instead (unconfirmed). '*' (a limit error that named
// no window) needs every window clear.
function windowCleared(name: string, w: WaitWin, r: Reading, now: number): boolean {
  if ((w.hold ?? 0) > now) return false;
  const after = Date.parse(w.after);
  const ok = (x: Win) => fresh(x.at, now) && x.at > after && x.pct < 100;
  if (name === '*') {
    const all = Object.values(r.windows);
    return all.length > 0 && all.every(ok);
  }
  const x = r.windows[name];
  return x != null && ok(x);
}

// Paid-forbidden waits for every listed window to reset, confirmed by a fresh reading taken
// after its resets_at (or, with no resets_at, one that reads below 100%).
function paidCleared(clear: { windows?: Record<string, WaitWin>; after?: string } | null, r: Reading, now: number): boolean {
  const after = Date.parse(clear?.after ?? '');
  const wins = Object.entries(clear?.windows ?? {});
  if (!wins.length) {
    const all = Object.values(r.windows);
    return all.length > 0 && all.every((x) => fresh(x.at, now) && x.at > after && !full(x, now));
  }
  return wins.every(([name, w]) => {
    const x = r.windows[name];
    if (!x || !fresh(x.at, now) || x.at <= after) return false;
    return w.resets_at != null ? x.at >= w.resets_at * 1000 && !full(x, now) : !full(x, now);
  });
}

// Why a fresh reading says the account's credits are out, or null.
function creditsOutReading(acct: CostAccount, r: Reading, noHeadroom: boolean, now: number): string | null {
  const b = r.balance && fresh(r.balance.at, now) ? r.balance.usd : null;
  if (isOpenRouter(acct)) return b != null && b <= 0 ? `OpenRouter credit balance is $${b.toFixed(2)}` : null;
  if (r.spendControl?.reached && fresh(r.spendControl.at, now)) return 'the provider reports its spend control reached';
  // A paid: false account at zero with its windows exhausted is the window rule's case.
  if (acct.paid === true && b != null && b <= 0 && noHeadroom) return `credits balance is ${b} and no window has headroom`;
  return null;
}

// Credits-out clears on a fresh reading taken after it was set: a balance at least `low`,
// or for Codex, no spend control and a window with headroom. Claude has no balance reading.
function creditsCleared(acct: CostAccount, clear: { after?: string } | null, r: Reading, low: number, now: number): boolean {
  const after = Date.parse(clear?.after ?? '');
  const b = r.balance && fresh(r.balance.at, now) && r.balance.at > after ? r.balance.usd : null;
  if (b != null && b >= low) return true;
  if (acct.match.harness !== 'codex') return false;
  if (r.spendControl && fresh(r.spendControl.at, now) && r.spendControl.at > after && r.spendControl.reached) return false;
  const wins = Object.values(r.windows).filter((x) => fresh(x.at, now) && x.at > after);
  return wins.length > 0 && wins.every((x) => !full(x, now));
}

function windowReason(wins: Record<string, WaitWin>): string {
  return Object.entries(wins)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, w]) => {
      const by = w.source ? `limit error (${w.source}): ` : '';
      return name === '*'
        ? `${by}no window named; waits for a fresh reading with every window below 100%`
        : `${by}${name} at ${w.pct ?? '?'}%, resets ${w.resets_at ? utc(w.resets_at) : 'at an unknown time'}`;
    })
    .join('; ');
}

// Lets the event loop run between agents, so a fleet-wide pause or resume doesn't hold it for the sum of the
// agents' work (S-2369). Safe because passes on an account run one after another (the chain in evaluateRules), and
// each agent's own changes stay in lifecycle.serial.
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

// Brings every agent on the account to the wanted state: the blocker with this reason and
// clear condition, or none. Writes and events happen only on a change.
async function apply(account: string, kind: RuleKind, want: { reason: string; clear: Record<string, unknown> | null } | null, why: string, unconfirmed = false, now = Date.now()): Promise<void> {
  if (!want) {
    for (const b of blockers.blockersFor(account).filter((x) => x.kind === kind)) {
      await yieldLoop();
      db.addEvent(b.agent_id, 'cost:rule', { rule: kind, account, action: 'clear', reason: b.reason, cleared: why, ...(unconfirmed ? { unconfirmed: true } : {}) });
      await blockers.clearBlocker(b.agent_id, kind, account, why, kind === 'window' ? { names: windowNames(b.clear), at: now } : undefined);
    }
    return;
  }
  for (const a of agentsOn(account)) {
    await yieldLoop();
    const have = blockers.blockers(a).find((x) => x.kind === kind && x.account === account);
    if (have && have.reason === want.reason && JSON.stringify(have.clear) === JSON.stringify(want.clear)) continue;
    if (!have || have.reason !== want.reason) db.addEvent(a.id, 'cost:rule', { rule: kind, account, action: 'set', reason: want.reason });
    // A window the new wait drops was cleared while the others stay blocked: its history goes in with the change.
    const kept = windowNames(want.clear);
    const dropped = kind === 'window' && have ? windowNames(have.clear).filter((name) => !kept.includes(name)) : [];
    await blockers.addBlocker(a, { kind, account, reason: want.reason, clear: want.clear, clears: dropped.length ? { names: dropped, at: now } : undefined });
  }
}

// The window names a window blocker's clear condition waits for.
function windowNames(clear: Record<string, unknown> | null): string[] {
  return Object.keys((clear as { windows?: Record<string, unknown> } | null)?.windows ?? {});
}

const RESET_PASSED = 'its reset time passed; no fresh reading confirmed it';

// One timer per account, at the earliest time a planned wait times out: a window, or a
// paid-forbidden once all its windows have. A time already passed
// gets one immediate re-evaluation, so a deadline that passed while a pause was delivered
// isn't lost.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
// The longest delay a timer takes; a wake further out re-arms at each cap. Tests lower it.
let maxTimerMs = 2 ** 31 - 1;
export function setMaxTimer(ms: number): void {
  maxTimerMs = ms;
}
const dues = new Map<string, number>();
const firedLate = new Map<string, number>();
// When the account's timer next evaluates, or null: tests check a hold's wake-up.
export function pendingWake(account: string): number | null {
  return dues.get(account) ?? null;
}
// `now` is the evaluation's time, the one the steps were planned at. A hold still in force then
// wakes the account at its end, even when the wall clock has passed that end already: the wake
// is then immediate, so a reading the hold refused is judged again.
function schedule(account: string, steps: Step[], now: number): void {
  clearTimeout(timers.get(account));
  timers.delete(account);
  dues.delete(account);
  let due = Infinity;
  for (const s of steps) {
    if (!s.want) continue;
    const wins = Object.values(((s.want.clear as any)?.windows ?? {}) as Record<string, WaitWin>);
    // A window wakes at its hold's end, so a reading the hold rejected is judged again then, and at its deadline.
    if (s.kind === 'window')
      for (const w of wins) {
        if (w.hold != null && w.hold > now) due = Math.min(due, w.hold);
        if (w.resets_at != null) due = Math.min(due, deadline(w));
      }
    const times = wins.map((w) => (w.resets_at == null ? null : w.resets_at * 1000 + resetMarginMs));
    if (s.kind === 'paid-forbidden' && times.length && times.every((t) => t != null)) due = Math.min(due, Math.max(...(times as number[])));
  }
  if (due === Infinity) return;
  const wall = Date.now();
  // An overdue wake fires once. The mark is set when the timer fires, not here: a later
  // evaluation may replace a timer that never ran, and that wake must still happen.
  if (due <= wall && firedLate.get(account) === due) return;
  const capped = due - wall > maxTimerMs;
  const t = setTimeout(() => {
    timers.delete(account);
    dues.delete(account);
    // Only the deadline wake counts as fired; a capped one may be evaluated short of the due time.
    // Only the deadline wake counts as fired; a capped one may be evaluated short of the due time.
    if (!capped) firedLate.set(account, due);
    // A wake armed for the deadline itself is never evaluated earlier than it: a timer can fire a
    // millisecond early, or the evaluation can wait behind a pause delivery, and a `now` short of the
    // deadline would leave the wake marked fired. A capped wake evaluates at real time and re-arms.
    void enqueue(account, {}, capped ? Date.now() : Math.max(Date.now(), due));
  }, Math.min(Math.max(0, due - wall), maxTimerMs));
  t.unref?.();
  timers.set(account, t);
  dues.set(account, due);
}

// Cost pauses (docs/cost-policy.md, build step 12): a manager pauses a tree until a
// subscription window resets or until a set time, and stam lifts the pause by itself.
//
// The pause is a `manual` cost blocker on every agent in the tree, recording who set it,
// why, and what clears it. As a blocker it is its own lifecycle owner: the first one pauses
// the agent through lifecycle's normal path, and clearing the last one resumes it. The clear,
// the admission gate, and the resume after a clear reuse blockers.ts and admission.ts as
// they are; this module only decides when the clear condition is met.
//
//   until=reset  clears when a fresh reading of the window, taken after the pause was set,
//                reads below the percentage it had then; or, with no fresh reading, when the
//                window's resets_at plus the rule margin (rules.ts's 60 s) passes, marked
//                unconfirmed.
//   until=TIME   clears when the wall-clock time T passes.
//
// Every reading calls evaluatePauses(), and a timer per pause calls it at the clear time, so
// a paused tree that reports no reading still lifts. The reading may be a peer's of the same
// account (S-2367): a window reads at its newest reading on any machine. A tree also covers
// agents spawned into it later: attachSpawn gives a new agent the pause its parent chain carries.
import * as db from './db.ts';
import * as tree from './tree.ts';
import * as blockers from './blockers.ts';
import type { Blocker } from './blockers.ts';
import * as costNotices from './cost-notices.ts';
import * as rules from './rules.ts';
import { STALE_MS } from './readings.ts';
import { accountFor } from './accounts.ts';
import { assertMayManageTree } from './cost-auth.ts';

// What clears a manual pause. Stored as the blocker's `clear` JSON.
export interface PauseClear {
  kind: 'reset' | 'time';
  // The agent (id) or 'human' that set it.
  by: string;
  // When the pause was set, iso: a reset reading must be taken after this.
  after: string;
  // until=reset.
  account?: string;
  window?: string;
  // The window's percentage when the pause was set; a fresh reading below it confirms the reset.
  pct?: number | null;
  resets_at?: number | null; // seconds, the timer's basis
  // until=time.
  until?: string;
}

export interface PauseOptions {
  // The tree root: an agent id or name.
  root: string;
  // The manager: an agent id, or 'human'.
  by: string;
  // 'reset', or an ISO time. Omitted only when clearing.
  until?: string;
  account?: string;
  window?: string;
  reason?: string;
  clear?: boolean;
}

export interface PauseResult {
  root: string;
  action: 'paused' | 'cleared';
  // The agents the pause was set on, or cleared from, by name.
  agents: string[];
  // A sentence for what the pause waits for; empty when cleared.
  until: string;
  // The cost notice ids this call acknowledged.
  acked: string[];
}

const KIND = 'manual' as const;
const iso = (t: number) => new Date(t).toISOString();
const fresh = (at: number, now: number) => now - at <= STALE_MS;

function mustAgent(ref: string): db.Agent {
  const a = db.getAgent(ref);
  if (!a) throw new Error(`no agent ${ref}`);
  return a;
}

// The root and its descendants, in tree order, archived ones left out.
export function treeAgents(root: db.Agent): db.Agent[] {
  const out: db.Agent[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const a = db.getAgent(id);
    if (a && a.lifecycle !== 'archived') out.push(a);
    for (const c of tree.childrenOf(id)) walk(c);
  };
  walk(root.id);
  return out;
}

// The account a tree bills to: the first managed agent in it. Null when none is managed.
export function accountOfTree(root: db.Agent): string | null {
  for (const a of treeAgents(root)) {
    const account = accountFor(a);
    if (account) return account;
  }
  return null;
}

export function manualBlocker(agent: db.Agent): Blocker | undefined {
  return blockers.blockers(agent).find((b) => b.kind === KIND);
}

// The manual pause the agent's parent chain carries, if any: a spawn into a paused tree
// inherits it.
function pauseOnChain(agent: db.Agent): Blocker | undefined {
  const seen = new Set<string>();
  const stack = db.parentsOf(agent);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const p = db.getAgent(id);
    if (!p) continue;
    const b = manualBlocker(p);
    if (b) return b;
    stack.push(...db.parentsOf(p));
  }
  return undefined;
}

// Gives a new agent, before its launch, the pause its parent chain carries, so a tree stays
// paused for agents spawned into it while the pause holds.
export async function attachSpawn(agent: db.Agent): Promise<void> {
  const b = pauseOnChain(agent);
  if (!b) return;
  const clear = b.clear as unknown as PauseClear;
  db.addEvent(agent.id, 'cost:pause', { action: 'inherited', by: clear.by, reason: b.reason });
  await blockers.addBlocker(agent, { kind: KIND, reason: b.reason, clear: b.clear as Record<string, unknown> });
}

// The window closest to 100% among an account's fresh readings, for the default until=reset.
function closestWindow(account: string, now: number): { window: string; win: rules.Win } | undefined {
  const wins = Object.entries(rules.accountWindows(account, now)).filter(([, w]) => fresh(w.at, now));
  wins.sort(([, a], [, b]) => Math.abs(100 - a.pct) - Math.abs(100 - b.pct) || b.pct - a.pct || 0);
  return wins.length ? { window: wins[0][0], win: wins[0][1] } : undefined;
}

// Turns the caller's until/account/window into a clear condition, or throws what is missing.
function resolveClear(opts: PauseOptions, root: db.Agent, now: number): { clear: PauseClear; reason: string } {
  const byName = opts.by === 'human' ? 'the human' : db.getAgent(opts.by)?.name ?? opts.by;
  if (opts.until === 'reset') {
    const account = opts.account ?? accountOfTree(root);
    if (!account) throw new Error(`no cost account in ${root.name}'s tree; pass account`);
    const wins = rules.accountWindows(account, now);
    let window = opts.window;
    if (!window) {
      const pick = closestWindow(account, now);
      if (!pick) throw new Error(`no fresh window reading on ${account}; pass window`);
      window = pick.window;
    }
    const w = wins[window];
    const pct = w?.pct ?? null;
    const resets = w?.resets_at ?? null;
    const what = pct == null ? `${account}'s ${window} resets` : `${account}'s ${window} (at ${pct}%) resets`;
    return {
      clear: { kind: 'reset', by: opts.by, after: iso(now), account, window, pct, resets_at: resets },
      reason: opts.reason ?? `${byName} paused the tree until ${what}`,
    };
  }
  const at = Date.parse(String(opts.until ?? ''));
  if (!Number.isFinite(at)) throw new Error(`until must be "reset" or an ISO time, not ${JSON.stringify(opts.until)}`);
  const until = iso(at);
  return {
    clear: { kind: 'time', by: opts.by, after: iso(now), until },
    reason: opts.reason ?? `${byName} paused the tree until ${until}`,
  };
}

// Acknowledge the open cost notices about the tree, as the acting manager; `via` names the
// tool. cost_allocate on a tree acknowledges through this too.
export function ackTree(root: db.Agent, by: string, via = 'cost_pause'): string[] {
  const ids = treeAgents(root).map((a) => a.id);
  const out: string[] = [];
  for (const n of costNotices.openNotices(ids, accountOfTree(root) ?? undefined)) {
    if (costNotices.ack(n.id, by, via).ok) out.push(n.id);
  }
  return out;
}

// Pauses a tree until its window resets or a set time, or clears an existing pause early.
export async function costPause(opts: PauseOptions): Promise<PauseResult> {
  const root = mustAgent(opts.root);
  assertMayManageTree(opts.by, root);
  const agents = treeAgents(root);
  const acked = ackTree(root, opts.by);

  if (opts.clear) {
    const names: string[] = [];
    for (const a of agents) {
      if (!manualBlocker(a)) continue;
      db.addEvent(a.id, 'cost:pause', { action: 'clear', by: opts.by, requested: true });
      await blockers.clearBlocker(a, KIND, '', `cleared by ${opts.by === 'human' ? 'the human' : db.getAgent(opts.by)?.name ?? opts.by}`);
      names.push(a.name);
    }
    reschedule();
    return { root: root.name, action: 'cleared', agents: names, until: '', acked };
  }

  if (opts.until == null || opts.until === '') throw new Error('cost_pause needs until=reset or an ISO time, or clear');
  const { clear, reason } = resolveClear(opts, root, Date.now());
  const names: string[] = [];
  for (const a of agents) {
    db.addEvent(a.id, 'cost:pause', { action: 'set', by: opts.by, reason, clear });
    await blockers.addBlocker(a, { kind: KIND, reason, clear: clear as unknown as Record<string, unknown> });
    names.push(a.name);
  }
  reschedule();
  return { root: root.name, action: 'paused', agents: names, until: reason, acked };
}

// How a pause clears now, or null while it waits. `unconfirmed` marks a clear with no fresh
// reading to confirm it, like rules.ts's timer clears.
function cleared(c: PauseClear, now: number): { text: string; unconfirmed: boolean } | null {
  if (c.kind === 'time') {
    const at = Date.parse(String(c.until ?? ''));
    return Number.isFinite(at) && now >= at ? { text: `the set time ${c.until} passed`, unconfirmed: false } : null;
  }
  const after = Date.parse(c.after);
  const w = c.account && c.window ? rules.accountWindows(c.account, now)[c.window] : undefined;
  if (w && fresh(w.at, now) && w.at > after) {
    const old = c.pct ?? 100;
    if (w.pct < old) return { text: `a fresh reading of ${c.window} on ${c.account} is ${w.pct}%, below the ${old}% when it was paused`, unconfirmed: false };
  }
  if (c.resets_at != null && now >= c.resets_at * 1000 + rules.resetMargin()) {
    return { text: `the ${c.window} window on ${c.account} reset (${iso(c.resets_at * 1000)}) and no fresh reading confirmed it`, unconfirmed: true };
  }
  return null;
}

// Lifts every manual pause whose clear condition is met, then schedules the next timer. Called
// on every reading and at each pause's clear time (and once at daemon start).
export async function evaluatePauses(now: number = Date.now()): Promise<void> {
  for (const a of db.listAgents()) {
    const b = manualBlocker(a);
    if (!b?.clear) continue;
    const verdict = cleared(b.clear as unknown as PauseClear, now);
    if (!verdict) continue;
    db.addEvent(a.id, 'cost:pause', { action: 'clear', cleared: verdict.text, ...(verdict.unconfirmed ? { unconfirmed: true } : {}) });
    await blockers.clearBlocker(a, KIND, '', verdict.text);
  }
  schedule();
}

// A reading was stored under this subscriptions name; a manual pause may now be clearable.
export function onReading(_name: string, now: number = Date.now()): void {
  void evaluatePauses(now);
}

let timer: ReturnType<typeof setTimeout> | undefined;
function schedule(now: number = Date.now()): void {
  clearTimeout(timer);
  timer = undefined;
  let due = Infinity;
  for (const a of db.listAgents()) {
    const c = manualBlocker(a)?.clear as PauseClear | undefined;
    if (!c) continue;
    if (c.kind === 'time') {
      const at = Date.parse(String(c.until ?? ''));
      if (Number.isFinite(at)) due = Math.min(due, at);
    } else if (c.resets_at != null) {
      due = Math.min(due, c.resets_at * 1000 + rules.resetMargin());
    }
  }
  if (due === Infinity) return;
  timer = setTimeout(() => void evaluatePauses(), Math.min(Math.max(0, due - now), 2 ** 31 - 1));
  timer.unref?.();
}

// (Re)schedules the timers for the pauses already stored, as at daemon start.
export function reschedule(now: number = Date.now()): void {
  schedule(now);
}

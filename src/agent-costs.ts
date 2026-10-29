// Own and tree cost per agent in every display unit, for GET /api/agents (S-316,
// src/cost-display.ts). Each agent's spend is kept raw per account (Raw): one pass over the
// usage rows and agent links, the worth and window shares from the 30 s usage snapshot (never a
// fresh calibration), memoized for 30 s as the snapshot is. The units are converted per request
// with this daemon's prices, so a peer's agents, which arrive as raw spend, are shown the same
// way. Local agents only: a tree is summed over the local agents' own spend, through every parent
// link this daemon knows. A local tree counts a local child of a peer parent, but never the
// peer agents' own spend, which their machine holds.
import * as db from './db.ts';
import * as tree from './tree.ts';
import { displayContext } from './usage.ts';
import { addRaw, costDisplay, type CostDisplay, kindResolver, rawToModes, roundModes, treeSums, type Ctx, type CostMode, type Modes, type Raw } from './cost-display.ts';
import { settings } from './settings.ts';
import { timed } from './stall.ts';

export interface AgentCost {
  mode: CostMode;
  own: Modes;
  tree: Modes;
}
export interface AgentRaw {
  own: Raw;
  tree: Raw;
}

const TTL_MS = 30_000;
let memo: { at: number; key: string; graph: string; raw: Map<string, AgentRaw> } | null = null;

// Drops the memo. Tests call it between synthetic states; nothing in the daemon does.
export function resetAgentCostsMemo(): void {
  memo = null;
}

// Every agent's raw own and tree spend per account.
export function agentRaw(agents: Pick<db.Agent, 'id' | 'parent_id'>[], now: number = Date.now()): Map<string, AgentRaw> {
  const key = JSON.stringify(settings().cost.accounts ?? {});
  // The agents and their parent links, so a reparent, adopt or forget shows at once.
  const edges = tree.edges(agents);
  const graph = edges.map(([c, p]) => `${c}:${p}`).sort().join(',') + '|' + agents.map((a) => a.id).sort().join(',');
  if (memo && memo.key === key && memo.graph === graph && now >= memo.at && now - memo.at < TTL_MS) return memo.raw;
  const kind = kindResolver();
  const ctx = timed('agents: display context', () => displayContext(now));
  const byAccount = db.costByAgentAccount();
  const ids = agents.map((a) => a.id);
  const children = new Map<string, string[]>();
  const link = (child: string, parent: string) => {
    // A parent that isn't in `agents` (a peer agent) stays a pass-through node: treeSums reads no spend for it.
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(child);
  };
  for (const [child, parent] of edges) link(child, parent);
  const own = new Map<string, Raw>();
  for (const id of ids) {
    const raw: Raw = {};
    for (const [account, api] of byAccount.get(id) ?? []) {
      const k = kind(account);
      const sub = k === 'subscription';
      raw[account] = {
        api,
        kind: k,
        worth_seven_day: sub ? ctx.worth(account, 'seven_day') : null,
        five_hour: sub ? timed('agents: share', () => ctx.share(id, account, 'five_hour')) : 0,
        seven_day: sub ? timed('agents: share', () => ctx.share(id, account, 'seven_day')) : 0,
      };
    }
    own.set(id, raw);
  }
  const sums = timed('agents: tree sums', () => treeSums<Raw>(ids, children, own, () => ({}), addRaw));
  const out = new Map<string, AgentRaw>();
  for (const id of ids) out.set(id, { own: own.get(id)!, tree: sums.get(id)! });
  memo = { at: now, key, graph, raw: out };
  return out;
}

// The listed rows and every agent's raw spend from one synchronous read, so an agent created while the caller awaited
// something else is in both: `read` runs first, and the links (a superset of any rows read) after it (S-3840).
export function listWithRaw(read: () => db.Agent[], now: number = Date.now()): { listed: db.Agent[]; raws: Map<string, AgentRaw> } {
  const listed = read();
  const raws = agentRaw(db.agentLinks(), now);
  return { listed, raws };
}

// Raw spend into the modes, with this daemon's prices and mode.
export function toCost(raw: AgentRaw, display: CostDisplay = costDisplay()): AgentCost {
  const { mode, prices } = display;
  return { mode, own: roundModes(rawToModes(raw.own, prices)), tree: roundModes(rawToModes(raw.tree, prices)) };
}

export function agentCosts(agents: db.Agent[], now: number = Date.now()): Map<string, AgentCost> {
  const raw = agentRaw(agents, now);
  const display = costDisplay();
  return new Map(agents.map((a) => [a.id, toCost(raw.get(a.id)!, display)]));
}

// A peer's agent as the UI shows it: its raw spend converted with this daemon's prices and
// mode. A peer on an older release sends `cost` without `cost_raw`: its numbers are kept, with
// this daemon's mode and the subscription $ null, since its prices can't be known to match.
export function withOwnCost<T extends { cost_raw?: AgentRaw; cost?: AgentCost }>(a: T, display: CostDisplay = costDisplay()): Omit<T, 'cost_raw'> & { cost?: AgentCost } {
  const { cost_raw, ...rest } = a;
  if (cost_raw) return { ...rest, cost: toCost(cost_raw, display) };
  if (rest.cost) {
    const c = rest.cost;
    return { ...rest, cost: { mode: display.mode, own: { ...c.own, subscription: null }, tree: { ...c.tree, subscription: null } } };
  }
  return rest;
}

// Account kinds, prices and window worths for ITSA costs (issue-costs), from the cached snapshot.
export function displayCtx(now: number = Date.now()): Ctx {
  const { prices } = costDisplay();
  return { kind: kindResolver(), worth: displayContext(now).worth, price: (account) => prices[account] ?? null };
}

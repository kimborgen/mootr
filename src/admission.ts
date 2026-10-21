// The admission gate (build step 5 of docs/cost-policy.md): stam calls admit() before it
// starts any model turn: an agent with cost blockers isn't admitted. A refusal records a
// 'cost:refused' event; the caller keeps the turn's input (mail stays unread and unpushed)
// until the blockers clear. The human's direct prompt is the human's choice: it is admitted
// with a 'cost:override' event. In-turn notices aren't new turns and don't come here.
// Human and parent pauses aren't checked here: they hold launches and unpauses as before
// (lifecycle.isHeld), and a paused agent still gets its mail as a prompt.
import * as db from './db.ts';
import { accountFor } from './accounts.ts';
import { spawnBlockers, exhaustedWindows } from './rules.ts';
import { spawnHeld } from './budgets.ts';
import { admitsProbe } from './cost-probes.ts';

export type TurnKind = 'mail' | 'ring' | 'prompt' | 'human' | 'compact' | 'resume' | 'restart' | 'unpause' | 'spawn';

// Account-wide blockers: one on any agent of an account stops new agents spawning onto it.
// A budget blocker or a take-over belongs to a scope or an agent, not to the account's capacity;
// a spent budget refuses a spawn by the ledger instead (accountHeld).
const ACCOUNT_WIDE = ['window', 'paid-forbidden', 'credits-out', 'error'];

export type Admission = { ok: true } | { ok: false; reason: string };

// An agent whose turn is its account's probe (cost-probes.ts) runs past the blockers the
// probe tests; they stay in place for the rest of the account.
const blockedBy = (a: db.Agent) =>
  db
    .blockerRows(a.id)
    .filter((b) => !admitsProbe(a.id, b.kind, b.account))
    .map((b) => `${b.kind}${b.account ? ` on ${b.account}` : ''}: ${b.reason}`);

// Why the agent must stay paused, cost blockers first, then pause owners; null when nothing holds it.
export function heldBy(a: db.Agent): string | null {
  const owners: string[] = a.paused_by ? JSON.parse(a.paused_by) : [];
  const held = [...blockedBy(a), ...owners.map((o) => `paused by ${o === 'human' ? 'the human' : (db.getAgent(o)?.name ?? o)}`)];
  return held.length ? held.join('; ') : null;
}

// Whether stam may start a turn of `kind` on the agent now.
export function admit(agent: string | db.Agent, kind: TurnKind): Admission {
  const a = db.getAgent(typeof agent === 'string' ? agent : agent.id);
  if (!a) return { ok: false, reason: 'no such agent' };
  // Taken over by a live successor (cost_switch): no turn at all, not even the human's.
  const s = a.forwarded_to ? db.getAgent(a.forwarded_to) : undefined;
  if (s && s.lifecycle !== 'archived') {
    const reason = `taken over by ${s.name}`;
    db.addEvent(a.id, 'cost:refused', { kind, reason });
    return { ok: false, reason };
  }
  const blocked = blockedBy(a);
  if (!blocked.length) return { ok: true };
  const reason = blocked.join('; ');
  if (kind === 'human') {
    db.addEvent(a.id, 'cost:override', { kind, held: reason });
    return { ok: true };
  }
  db.addEvent(a.id, 'cost:refused', { kind, reason });
  return { ok: false, reason };
}

// Whether a reviewer type or chain entry should pick another type: the account is held as accountHeld
// says, or its own window reads exhausted on a stale reading with the reset still ahead (exhaustedWindows,
// S-905). Only the fallback choice uses this; it never refuses a spawn, which stays on accountHeld.
export function heldForFallback(spec: { harness: string; model?: string | null }): { account: string; reason: string } | null {
  const held = accountHeld(spec);
  if (held) return held;
  const account = accountFor(spec);
  if (!account) return null;
  const windows = exhaustedWindows(account);
  return windows.length ? { account, reason: `account ${account} is blocked: ${windows.map((w) => `window (${w.reason})`).join('; ')}` } : null;
}

// Why a new agent may not spawn onto the account its harness and model bill to, or null.
export function accountHeld(spec: { harness: string; model?: string | null }): { account: string; reason: string } | null {
  const account = accountFor(spec);
  if (!account) return null;
  const rows = db.open().prepare('SELECT kind, reason FROM blockers WHERE account = ? ORDER BY since, rowid').all(account) as { kind: string; reason: string }[];
  // The cost rules decide from fresh readings too, so an exhausted account with no agent on
  // it yet still refuses the first spawn.
  const wide = [...rows, ...spawnBlockers(account)].filter((b) => ACCOUNT_WIDE.includes(b.kind));
  // A spent budget refuses it too, whether or not any agent carries the blocker yet.
  const budget = spawnHeld(account);
  if (budget) return { account, reason: `account ${account} is blocked: budget (${budget})${wide.length ? `; ${wide.map((b) => `${b.kind} (${b.reason})`).join('; ')}` : ''}` };
  if (!wide.length) return null;
  const kinds = [...new Set(wide.map((b) => b.kind))];
  return { account, reason: `account ${account} is blocked: ${kinds.map((k) => `${k} (${wide.find((b) => b.kind === k)!.reason})`).join('; ')}` };
}

// The gate for a new agent, before its workspace exists. An account-wide blocker refuses the
// spawn with a 'cost:refused' event on the requester (`by`, or the human), and throws the
// reason. `force` is the human's alone: the spawn goes ahead, and the caller records the
// returned override as a 'cost:override' event on the new agent once it exists.
export function admitSpawn(spec: { name: string; harness: string; model?: string | null; by?: string; human: boolean; force?: boolean }): { account: string; reason: string } | null {
  const held = accountHeld(spec);
  if (!held) return null;
  if (spec.human && spec.force) return held;
  db.addEvent(spec.by ?? 'human', 'cost:refused', { kind: 'spawn', name: spec.name, ...held });
  throw new Error(`can't spawn ${spec.name}: ${held.reason}. Only the human can spawn it anyway, with force.`);
}

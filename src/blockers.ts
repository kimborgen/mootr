// Cost blockers: why stam keeps an agent paused (build step 5 of docs/cost-policy.md).
// Each agent carries a set of independent blockers, each with its own clear condition,
// persisted in the blockers table. The first blocker pauses the agent through the normal
// pause path with stam as the owner; when the last one clears, stam unpauses it, unless
// the human or an agent also paused it (agents.paused_by), a pause stam never lifts.
// Every change runs in lifecycle.serial, one at a time with the agent's pauses and unpauses.
import * as db from './db.ts';
import * as lifecycle from './lifecycle.ts';
import { render } from './templates.ts';
import { schedulePush } from './mail.ts';
import { blockerChanged } from './cost-notices.ts';

export type BlockerKind = 'window' | 'paid-forbidden' | 'budget' | 'credits-out' | 'billing-unknown' | 'error' | 'taken-over' | 'manual';
export const BLOCKER_KINDS: BlockerKind[] = ['window', 'paid-forbidden', 'budget', 'credits-out', 'billing-unknown', 'error', 'taken-over', 'manual'];

export interface Blocker {
  agent_id: string;
  kind: BlockerKind;
  // The account, or budget scope, it applies to; '' when none.
  account: string;
  reason: string;
  since: string;
  // What clears it, such as { resets_at }; read by later steps.
  clear: Record<string, unknown> | null;
}

type Row = Omit<Blocker, 'clear'> & { clear: string | null };
const parse = (r: Row): Blocker => ({ ...r, clear: r.clear ? JSON.parse(r.clear) : null });

function mustAgent(ref: string | db.Agent): db.Agent {
  const a = typeof ref === 'string' ? db.getAgent(ref) : db.getAgent(ref.id);
  if (!a) throw new Error(`no agent ${typeof ref === 'string' ? ref : ref.id}`);
  return a;
}

export function blockers(agent: string | db.Agent): Blocker[] {
  const id = typeof agent === 'string' ? (db.getAgent(agent)?.id ?? agent) : agent.id;
  return (db.blockerRows(id) as Row[]).map(parse);
}

// Every agent's blockers, as blockers(agent) gives them, in one query (GET /api/agents).
export function blockersByAgent(): Map<string, Blocker[]> {
  const out = new Map<string, Blocker[]>();
  for (const r of db.open().prepare('SELECT * FROM blockers ORDER BY since, rowid').all() as unknown as Row[]) {
    (out.get(r.agent_id) ?? out.set(r.agent_id, []).get(r.agent_id)!).push(parse(r));
  }
  return out;
}

export function blockersFor(account: string): Blocker[] {
  return (db.open().prepare('SELECT * FROM blockers WHERE account = ? ORDER BY since, rowid').all(account) as unknown as Row[]).map(parse);
}

// Every blocked agent, for the Usage summary.
export function blocked(): { agent_id: string; agent: string; lifecycle: string; paused_by: string[]; blockers: Blocker[] }[] {
  const all = (db.open().prepare('SELECT * FROM blockers ORDER BY since, rowid').all() as unknown as Row[]).map(parse);
  const ids = [...new Set(all.map((b) => b.agent_id))];
  return ids.map((id) => {
    const a = db.getAgent(id);
    return { agent_id: id, agent: a?.name ?? id, lifecycle: a?.lifecycle ?? 'unknown', paused_by: a ? lifecycle.pauseOwners(a) : [], blockers: all.filter((b) => b.agent_id === id) };
  });
}

// Adds a blocker, or refreshes its reason and clear condition while keeping its `since`.
// An active agent is paused with stam as the owner; any other state only records it.
export function addBlocker(
  agent: string | db.Agent,
  b: { kind: BlockerKind; account?: string; reason: string; clear?: Record<string, unknown> | null },
): Promise<Blocker> {
  if (!BLOCKER_KINDS.includes(b.kind)) return Promise.reject(new Error(`unknown blocker kind ${b.kind}`));
  const a = mustAgent(agent);
  const account = b.account ?? '';
  return lifecycle.serial(a.id, async () => {
    // A refresh of an existing blocker keeps its `since`; only a new one notifies the manager.
    const existed = blockers(a.id).some((x) => x.kind === b.kind && x.account === account);
    db.open()
      .prepare(
        `INSERT INTO blockers (agent_id, kind, account, reason, since, clear) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, kind, account) DO UPDATE SET reason = excluded.reason, clear = excluded.clear`,
      )
      .run(a.id, b.kind, account, b.reason, new Date().toISOString(), b.clear ? JSON.stringify(b.clear) : null);
    db.addEvent(a.id, 'blocker:add', { kind: b.kind, account, reason: b.reason });
    if (db.getAgent(a.id)!.lifecycle === 'active') await lifecycle.pauseNow(a.id, null);
    const result = blockers(a.id).find((x) => x.kind === b.kind && x.account === account)!;
    if (!existed) blockerChanged(a.id, b.kind, account, 'set', b.reason, result.since);
    return result;
  });
}

// Removes a blocker. When it was the last and no one else paused the agent, unpauses it
// with cost-resumed.md naming what cleared; `cleared` says how, such as "a fresh reading".
// Returns whether the agent was unpaused.
export function clearBlocker(agent: string | db.Agent, kind: BlockerKind, account = '', cleared = ''): Promise<boolean> {
  const a = mustAgent(agent);
  return lifecycle.serial(a.id, async () => {
    const gone = blockers(a.id).find((x) => x.kind === kind && x.account === account);
    if (!gone) return false;
    db.open().prepare('DELETE FROM blockers WHERE agent_id = ? AND kind = ? AND account = ?').run(a.id, kind, account);
    db.addEvent(a.id, 'blocker:clear', { kind, account, cleared });
    // The blocked agent's manager hears the blocker cleared, whoever cleared it.
    blockerChanged(a.id, kind, account, 'clear', cleared || gone.reason, new Date().toISOString());
    // Mail and notices the blockers held back go in now, even to an agent that stays paused
    // for the human or a parent: a paused agent gets mail as before.
    if (!db.blockerRows(a.id).length) schedulePush(a.id);
    const now = db.getAgent(a.id)!;
    if (now.lifecycle !== 'paused' || lifecycle.isHeld(now)) return false;
    await lifecycle.resumeNow(a.id, render('cost-resumed', { blocker: account ? `${kind} on ${account}` : kind, reason: gone.reason, cleared: cleared || 'its condition cleared' }));
    return true;
  });
}

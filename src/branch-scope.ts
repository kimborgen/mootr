// Who owns a branch (S-581): the agent whose worktree was made on it. pr_open pushes, and a branch
// link names, only a branch outside every other agent's worktree. A daemon knows only its own agents,
// so the caller's daemon answers for its machine and sends the answer with a forwarded call (Via.scope,
// read from a peer only); the ITSA home adds its own agents, and asks its peers when the caller is local.
import * as db from './db.ts';
import { descendants } from './org.ts';
import { peers, peerCall, type Via } from './peers.ts';

export type Scope = 'tree' | 'foreign' | 'none';

export function parseScope(v: unknown): Scope | undefined {
  return v === 'tree' || v === 'foreign' || v === 'none' ? v : undefined;
}

// The branch an agent's worktree was made on (workspace.ts), if it has one.
function worktreeBranch(a: db.Agent): string | null {
  try {
    return a.workspace ? (JSON.parse(a.workspace)?.worktree?.branch ?? null) : null;
  } catch {
    return null;
  }
}

// How the branch stands among this daemon's agents, for `agent`: 'foreign' if any agent that isn't
// archived and isn't in the agent's tree (itself and its descendants) has a worktree on it, even when
// another one in the tree does too; else 'tree' if one in the tree has; else 'none'. A stopped agent
// (shut_down, failed) still owns its branch: only archiving gives it up.
//
// A predecessor whose work cost_switch moved to a member of the tree (agents.forwarded_to, recorded by the
// switch, in the database) is in the tree too: its successor holds the same worktree and branch (S-923).
export function localScope(agent: string, branch: string): Scope {
  if (!agent || !branch) return 'none';
  const id = db.getAgent(agent)?.id ?? agent;
  const tree = new Set([id, ...descendants(id)]);
  const handedTo = (a: db.Agent): boolean => {
    const seen = new Set<string>();
    for (let cur: db.Agent | undefined = a; cur?.forwarded_to && !seen.has(cur.id); cur = db.getAgent(cur.forwarded_to)) {
      seen.add(cur.id);
      if (tree.has(cur.forwarded_to)) return true;
    }
    return false;
  };
  const owners = db.listAgents().filter((a) => a.lifecycle !== 'archived' && worktreeBranch(a) === branch);
  if (owners.some((a) => !tree.has(a.id) && !handedTo(a))) return 'foreign';
  return owners.length ? 'tree' : 'none';
}

// The scope across machines, 'foreign' winning over 'tree'. The caller's own daemon already answered
// (via.scope) for a forwarded call; this daemon adds its own agents. For a call from this daemon's
// agent, every peer answers too. For a forwarded call only the caller's daemon and this one are
// checked: this daemon doesn't ask its other peers, so with a third machine its owners would be missed.
// A peer that doesn't answer (stopped, unreachable) counts as not owning the branch (S-1477): a
// stopped machine is never started for this check, and a home branch's push must not wait on it.
export async function branchScope(via: Via, branch: string): Promise<Scope> {
  const found: Scope[] = [via.scope ?? 'none', localScope(via.agent, branch)];
  if (via.scope === undefined) {
    for (const p of peers()) {
      try {
        const r = await peerCall(p, 'GET', `/api/pr/branch-scope?agent=${encodeURIComponent(via.agent)}&branch=${encodeURIComponent(branch)}`);
        found.push((r.status === 200 ? parseScope(r.data?.scope) : undefined) ?? 'none');
      } catch {
        found.push('none');
      }
    }
  }
  if (found.includes('foreign')) return 'foreign';
  if (found.includes('tree')) return 'tree';
  return 'none';
}

export function foreignRefusal(via: Via, branch: string, verb: string): string {
  const name = db.getAgent(via.agent)?.name ?? via.agent;
  return `${name} can't ${verb} ${branch}: it is the worktree branch of another agent, outside ${name}'s own tree (rule 1: only the owner's tree pushes it, whatever links it has).`;
}

// Why an agent may not link a branch to an ITSA, or null.
export async function linkRefusal(via: Via, branch: string): Promise<string | null> {
  const scope = await branchScope(via, branch);
  return scope === 'foreign' ? foreignRefusal(via, branch, 'link') : null;
}

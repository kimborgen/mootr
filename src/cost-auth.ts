// Who may manage cost for a tree (docs/cost-policy.md, Manager tools): the human, the chief
// of staff, or a manager whose own tree contains the tree's root. Shared by the manager
// tools (cost_pause, and cost_allocate beside it) so they agree on permissions.
import * as db from './db.ts';
import { chiefOfStaff } from './org.ts';

// An error that means "not allowed", distinct from a bad request; a route maps it to 403.
export class Forbidden extends Error {
  readonly forbidden = true;
}

// Whether `by` may manage the tree rooted at `root`. `by` is an agent id or 'human'.
// Allowed: the human, stam's own cost fallback ('stam', cost-fallback.ts; never an HTTP
// caller), the executive assistant, the chief of staff, the root itself, or any ancestor of
// the root (a manager of a tree inside its own tree). Anyone else is refused.
// The assistant and the chief of staff match allocations.canSet, which delegates here.
export function mayManageTree(by: string, root: db.Agent): boolean {
  if (by === 'human' || by === 'stam') return true;
  const a = db.getAgent(by);
  if (!a) return false;
  if (a.kind === 'assistant') return true;
  if (by === root.id) return true;
  if (chiefOfStaff()?.id === by) return true;
  const seen = new Set<string>();
  const stack = db.parentsOf(root);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === by) return true;
    const p = db.getAgent(id);
    if (p) stack.push(...db.parentsOf(p));
  }
  return false;
}

// Throws a Forbidden, naming both, when `by` may not manage `root`'s tree.
export function assertMayManageTree(by: string, root: db.Agent): void {
  if (!mayManageTree(by, root)) {
    const who = by === 'human' ? 'the human' : db.getAgent(by)?.name ?? by;
    throw new Forbidden(`${who} may not manage cost for ${root.name}'s tree: only the human, the chief of staff, or a manager of a tree inside its own tree may`);
  }
}

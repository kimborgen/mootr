// The reviewer fallback chain (S-412): a reviewer type whose account is held falls to the first
// free type of its `fallbackChain`. Used by the spawn, the cost take-over, and the S-381 relaunch.
import { agentTypes, fallbackChain, type AgentTarget } from './agent-types.ts';
import { accountFor } from './accounts.ts';
import { accountHeld } from './admission.ts';

// A type's own harness, model, and effort; null for a ring type (it has no harness).
export function typeTarget(name: string): AgentTarget | null {
  const t = agentTypes()[name];
  return t?.harness ? { harness: t.harness, model: t.model, effort: t.effort } : null;
}

// The first type in the chain of `name` that can run now: not a ring, not billed to `blocked`,
// and its account not held. `reasons` says why each skipped type was skipped.
export function freeFallback(name: string, blocked?: string | null): { type: string | null; target: AgentTarget | null; reasons: string[] } {
  const reasons: string[] = [];
  for (const n of fallbackChain(name)) {
    const target = typeTarget(n);
    if (!target) { reasons.push(`${n} is a ring type`); continue; }
    const account = accountFor(target);
    if (blocked && account === blocked) { reasons.push(`${n} bills to the same account (${blocked})`); continue; }
    const held = accountHeld(target);
    if (held) { reasons.push(`${n}: ${held.reason}`); continue; }
    return { type: n, target, reasons };
  }
  if (!reasons.length) reasons.push(`${name} has no fallback type`);
  return { type: null, target: null, reasons };
}

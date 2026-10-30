// The one place an agent's children and descendants are read. The local db knows only this machine's
// agents; children on a peer machine are known from peer_agents. Walking db.childrenOf alone misses
// them (S-1156, S-1379, S-1384), so every tree walk goes through here; test/tree.test.mjs refuses
// db.childrenOf, and raw agent_parents or agent parent_id walks, anywhere else (S-1447).
import * as db from './db.ts';

// Direct children, local and on peers, each id once.
export function childrenOf(id: string): string[] {
  return [...new Set([...db.childrenOf(id), ...db.peerChildrenOf(id)])];
}

// childrenOf for a whole walk: the peer links are read once, not once per node. Each read parses every
// remembered peer agent, so a walk of a big tree took seconds (S-4356).
export function childrenReader(): (id: string) => string[] {
  const peers = new Map<string, string[]>();
  for (const l of db.peerParentLinks()) {
    const list = peers.get(l.parent_id);
    if (list) list.push(l.child_id);
    else peers.set(l.parent_id, [l.child_id]);
  }
  return (id) => [...new Set([...db.childrenOf(id), ...(peers.get(id) ?? [])])];
}

// Every child below `id`, at any depth, `id` itself excluded.
export function descendantsOf(id: string, seen = new Set<string>()): Set<string> {
  const children = childrenReader();
  const walk = (p: string) => {
    for (const c of children(p)) {
      if (seen.has(c)) continue;
      seen.add(c);
      walk(c);
    }
  };
  walk(id);
  return seen;
}

// Every parent link, as [child, parent], each once: the spawning parent of each of `agents`, the adopting
// parents, and the parents remembered for peer agents. Callers that index a whole snapshot (attribution,
// the Usage page, agent costs) read this instead of agent_parents, so peer children are in their graph.
export function edges(agents: Pick<db.Agent, 'id' | 'parent_id'>[] = db.listAgents()): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  const add = (child: string, parent: string) => {
    const k = `${child}\u0000${parent}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push([child, parent]);
  };
  for (const a of agents) if (a.parent_id) add(a.id, a.parent_id);
  for (const e of db.adoptedParentLinks()) add(e.child_id, e.parent_id);
  for (const e of db.peerParentLinks()) add(e.child_id, e.parent_id);
  return out;
}

// How many agents below `id` are busy (S-1652), local and on peers, in one recursive query (S-1025):
// db.busyDescendantCount walks the parent links of this machine's agents and of the remembered peer agents.
export function busyDescendantCount(id: string): number {
  return db.busyDescendantCount(id);
}

// busyDescendantCount for every agent at once (S-1725), for the startup rebuild: one count per agent was a
// subtree query each, about a second at real scale while the deploy probes health. Each busy agent adds one to
// every agent above it, each once, so an adopted agent reached by two paths still counts once, as in the query.
// Agents with no busy descendant are left out.
export function busyDescendantCounts(parents = parentMap()): Map<string, number> {
  const counts = new Map<string, number>();
  for (const busy of db.busyIds()) for (const p of ancestorsIn(parents, busy)) counts.set(p, (counts.get(p) ?? 0) + 1);
  return counts;
}

// Every agent's parents, from edges: child -> parents.
export function parentMap(agents?: Pick<db.Agent, 'id' | 'parent_id'>[]): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const [child, parent] of edges(agents)) (parents.get(child) ?? parents.set(child, []).get(child)!).push(parent);
  return parents;
}

// Every agent above `id` in a parentMap, each once, nearest first; `id` itself only when a cycle leads back to it.
export function ancestorsIn(parents: Map<string, string[]>, id: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = -1; i < out.length; i++) {
    for (const p of parents.get(i < 0 ? id : out[i]) ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

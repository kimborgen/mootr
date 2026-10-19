// Which agents' activity items changed (S-1009): every write to activity_items (ingest, the rule and
// model classifiers, the cost rescale) calls touched(agentId, since), and the activity summary rebuilds
// only those agents' digests, from `since` (ms: the earliest start an item changed at) when it is given,
// else whole. This module imports nothing, so any writer can import it without a cycle.
type Listener = (agentId: string, since: number | null) => void;
const listeners = new Set<Listener>();

export function touched(agentId: string, since: number | null = null): void {
  for (const fn of listeners) fn(agentId, since);
}

export function onTouched(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Waits a harness reports itself (source 'hook'): background work an adapter sees still
// running when the agent's turn ends. Each adapter keeps its own list of what runs and
// replaces the agent's hook waits with it.
import * as db from '../db.ts';

export interface HookWait {
  target: string;
  detail: string;
  until?: string | null;
  data?: unknown;
}

export function hookWaits(agentId: string, kind?: string): db.Wait[] {
  return db.listWaits(agentId).filter((w) => w.source === 'hook' && (!kind || w.kind === kind));
}

// Makes the agent's hook waits of one kind exactly `want`, keyed by target; kept waits keep
// their since.
export function replaceHookWaits(agentId: string, kind: string, want: HookWait[]): void {
  const have = hookWaits(agentId, kind);
  for (const w of have) if (!want.some((x) => x.target === w.target)) db.clearWait(w.id);
  for (const x of want) {
    if (have.some((w) => w.target === x.target)) continue;
    db.addWait({ agent_id: agentId, kind, source: 'hook', target: x.target, detail: x.detail, until: x.until ?? null, data: x.data == null ? null : JSON.stringify(x.data) });
  }
}

export function clearHookWaits(agentId: string): void {
  for (const w of hookWaits(agentId)) db.clearWait(w.id);
}

// Load numbers for a standing agent (S-919, step 2b of S-874): the three numbers the growth
// proposal reads, plus the size of its personal workspace. Shown in find_agents and on the type page.
//   open_itsas       ITSAs it owns in a ready or active category status
//   median_lead_s    median of created_at to closed_at over the last `LEAD_N` ITSAs it owned and closed
//                    (the lead time `/api/activity?by=agent` reports per ITSA, src/activity-stats.ts)
//   context_tokens   its context size against context_threshold, the size at which compaction is enforced
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as db from './db.ts';
import * as itsa from './itsa.ts';
import { percentile } from './activity-stats.ts';
import { enforceThreshold } from './context.ts';

export const LEAD_N = 10;
// A runaway workspace is counted up to this many entries, so a poll never walks a huge tree.
export const WORKSPACE_WALK_CAP = 5000;

export interface AgentLoad {
  open_itsas: number;
  median_lead_s: number | null;
  lead_n: number;
  context_tokens: number | null;
  context_threshold: number;
  context_ratio: number | null;
  workspace_bytes: number | null;
  workspace_files: number | null;
  // True when the walk stopped at the cap, so the size is a lower bound.
  workspace_capped?: boolean;
}

export function workspaceSize(path: string | null | undefined): { bytes: number; files: number; capped: boolean } | null {
  if (!path || !existsSync(path)) return null;
  let bytes = 0;
  let files = 0;
  let seen = 0; // files and folders, so a tree of empty folders is capped too
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // a folder that vanished or can't be read counts as empty
    }
    for (const e of entries) {
      if (seen >= WORKSPACE_WALK_CAP) return { bytes, files, capped: true };
      seen++;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          bytes += lstatSync(p).size;
          files++;
        } catch {}
      }
    }
  }
  return { bytes, files, capped: false };
}

export function loadOf(a: db.Agent): AgentLoad {
  const d = db.open();
  const open = new Set(itsa.statuses().filter((s) => s.category === 'ready' || s.category === 'active').map((s) => s.name));
  const owned = d.prepare('SELECT status FROM itsas WHERE owner = ?').all(a.id) as { status: string }[];
  // Only work that was done counts: canceled, duplicate and wont_do are closed but not done.
  const notDone = itsa.statuses().filter((s) => s.category === 'closed' && s.name !== 'done').map((s) => s.name);
  const closed = d
    .prepare(`SELECT created_at, closed_at FROM itsas WHERE owner = ? AND closed_at IS NOT NULL AND status NOT IN (${notDone.map(() => '?').join(',') || "''"}) ORDER BY closed_at DESC LIMIT ?`)
    .all(a.id, ...notDone, LEAD_N) as { created_at: string; closed_at: string }[];
  const leads = closed.map((x) => (Date.parse(x.closed_at) - Date.parse(x.created_at)) / 1000).filter((s) => Number.isFinite(s) && s >= 0);
  const threshold = enforceThreshold(a);
  const tokens = a.context_tokens ?? null;
  const ws = workspaceSize(a.personal_workspace);
  return {
    open_itsas: owned.filter((x) => open.has(x.status)).length,
    median_lead_s: percentile(leads, 0.5),
    lead_n: leads.length,
    context_tokens: tokens,
    context_threshold: threshold,
    context_ratio: tokens == null ? null : Math.round((tokens / threshold) * 1000) / 1000,
    workspace_bytes: ws?.bytes ?? null,
    workspace_files: ws?.files ?? null,
    ...(ws?.capped ? { workspace_capped: true } : {}),
  };
}

// `GET /api/agents` is polled every couple of seconds by each open tab, so the load is kept per agent
// for LOAD_TTL_MS. An archived agent has none.
export const LOAD_TTL_MS = 60_000;
const cache = new Map<string, { at: number; load: AgentLoad }>();
// The agents with a cached load, for tests of the expiry sweep.
export const cachedAgentIds = (): string[] => [...cache.keys()];

export function cachedLoadOf(a: db.Agent, now = Date.now()): AgentLoad | null {
  if (a.lifecycle === 'archived') {
    cache.delete(a.id);
    return null;
  }
  const hit = cache.get(a.id);
  if (hit && now - hit.at < LOAD_TTL_MS) return hit.load;
  const load = loadOf(a);
  // Entries past the TTL are dead weight (an archived agent is never asked again): drop them.
  for (const [id, e] of cache) if (now - e.at >= LOAD_TTL_MS) cache.delete(id);
  cache.set(a.id, { at: now, load });
  return load;
}

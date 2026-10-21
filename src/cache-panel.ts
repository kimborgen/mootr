// Settings › Prompt caching (S-2239): each live agent's detected cache window, from the `cache:ttl`
// events the cold-wake measurement records (S-2236, cache-cold.ts), with the account it bills to, so
// the page can warn when a subscription agent writes 5-minute caches (it has spilled into credits).
// Read only. It fans out like the machines route: a peer's own request gets this machine's agents.
import { MACHINE } from './config.ts';
import { peers, peerCall } from './peers.ts';
import { accountFor } from './accounts.ts';
import { settings } from './settings.ts';
import * as db from './db.ts';
import { TTL_AGENTS_SQL } from './cache-cold.ts';

export interface CacheAgent {
  id: string;
  name: string;
  machine: string;
  harness: string;
  model: string | null;
  lifecycle: string;
  // The account it bills to, and whether that account pays per token (credits or an API key).
  account: string | null;
  paid: boolean;
  // The latest detected window and since when: a `cache:ttl` event is recorded only when the window
  // changes. Null before the first measured turn.
  ttl: '1h' | '5m' | null;
  ttl_at: string | null;
}

export function localCacheAgents(): CacheAgent[] {
  // The latest `cache:ttl` event per agent: `ts` is when its window last changed.
  const ttls = new Map((db.open().prepare(`${TTL_AGENTS_SQL} GROUP BY agent_id)`).all() as { agent_id: string; ttl: '1h' | '5m'; ts: string }[]).map((r) => [r.agent_id, r]));
  const accounts = settings().cost.accounts ?? {};
  return db
    .listAgents()
    .filter((a) => a.machine === MACHINE && a.lifecycle !== 'archived')
    .map((a) => {
      const account = accountFor(a);
      const t = ttls.get(a.id);
      return { id: a.id, name: a.name, machine: a.machine, harness: a.harness, model: a.model ?? null, lifecycle: a.lifecycle, account, paid: account ? accounts[account]?.paid === true : false, ttl: t?.ttl ?? null, ttl_at: t?.ts ?? null };
    });
}

// This machine's agents plus each peer's. A peer that doesn't answer is named in `offline`; one that
// answers 404 runs a release without this route and is named in `outdated`.
export async function cacheAgents(local = false): Promise<{ agents: CacheAgent[]; offline: string[]; outdated: string[] }> {
  const here = localCacheAgents();
  if (local) return { agents: here, offline: [], outdated: [] };
  const offline: string[] = [];
  const outdated: string[] = [];
  const rest = await Promise.all(
    peers().map(async (p) => {
      try {
        const r = await peerCall(p, 'GET', '/api/cache/agents', undefined, 4000);
        if (r.status === 404) {
          outdated.push(p.name);
          return [];
        }
        const list = (r.data as { agents?: CacheAgent[] } | undefined)?.agents;
        if (r.status !== 200 || !Array.isArray(list)) throw new Error(`status ${r.status}`);
        return list;
      } catch {
        offline.push(p.name);
        return [];
      }
    }),
  );
  return { agents: [...here, ...rest.flat()], offline, outdated };
}

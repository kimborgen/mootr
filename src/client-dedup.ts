// A web client that retries a send (the prompt input's outbox) tags each request with a
// `client_id`. The first request with an id runs; a repeat within TTL_MS from the same caller
// on the same path, whether the first is still running or already answered, gets the first
// one's answer and does not run again. A failed first request is forgotten, so the retry runs,
// and so is one whose result `keep` refuses (a route that wrote its own response, which a
// repeat can't be handed): the repeat then runs normally. The caller is part of the key, so
// one credential can't take another's answer. The map lives in memory: a daemon restart
// forgets every id, and a send retried across one can arrive twice.
const TTL_MS = 5 * 60_000

interface Entry { at: number; run: Promise<unknown> }
const seen = new Map<string, Entry>()

export interface DedupOpts { keep?: (result: unknown) => boolean; now?: number }

export async function dedupByClientId<T>(scope: string, clientId: unknown, run: () => Promise<T>, { keep = () => true, now = Date.now() }: DedupOpts = {}): Promise<T> {
  if (typeof clientId !== 'string' || !clientId || clientId.length > 100) return run()
  for (const [k, e] of seen) if (now - e.at > TTL_MS) seen.delete(k)
  const key = `${scope}|${clientId}`
  const hit = seen.get(key)
  if (hit) {
    try {
      const first = (await hit.run) as T
      if (keep(first)) return first
    } catch {}
    return run()
  }
  const p = run()
  seen.set(key, { at: now, run: p })
  p.then((r) => { if (!keep(r) && seen.get(key)?.run === p) seen.delete(key) }, () => { if (seen.get(key)?.run === p) seen.delete(key) })
  return p
}

export const forgetClientIds = () => seen.clear()

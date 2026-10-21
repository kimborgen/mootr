// The page's side of go to declaration (S-1532, `GET /api/decl`): a name at a repo's commit, or in a file of a
// checkout on its machine. While the index builds the daemon answers 202 and this polls, so the caller sees one answer.
import { token } from '../api'

export interface DeclMatch { path: string; line: number; col: number; kind: string; text: string }
export type DeclResult =
  | { state: 'ready'; repo: string; sha: string; name: string; from?: string; matches: DeclMatch[]; total: number; root: { host: string; path: string } }
  | { state: 'no-repo' }

export type DeclQuery = { repo: string; sha: string; name: string; from?: string } | { host: string; file: string; name: string }

export class DeclFail extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export const declUrl = (q: DeclQuery): string => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v))
  return `/api/decl?${p}`
}

export interface LookupOptions {
  signal?: AbortSignal
  // Called once when the daemon says the index is still building.
  onBuilding?: () => void
  pollMs?: number
  // Give up after this many 202s.
  maxPolls?: number
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((ok, fail) => {
  const t = setTimeout(ok, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); fail(new DOMException('aborted', 'AbortError')) }, { once: true })
})

export async function lookupDecl(q: DeclQuery, o: LookupOptions = {}): Promise<DeclResult> {
  const { pollMs = 1000, maxPolls = 120 } = o
  let told = false
  for (let i = 0; ; i++) {
    const r = await fetch(declUrl(q), { signal: o.signal, headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' } })
    if (r.status === 202) {
      if (!told) { told = true; o.onBuilding?.() }
      if (i >= maxPolls) throw new DeclFail('The declaration index is still building. Try again in a minute.', 202)
      await wait(pollMs, o.signal)
      continue
    }
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new DeclFail((d as { error?: string }).error || `HTTP ${r.status}`, r.status)
    return d as DeclResult
  }
}

// Whether a name has a declaration, for the Ctrl/Cmd hover underline: answers kept per query, a building index says no.
// `from` only ranks matches, never filters them, so the answer is the same wherever in the file it is asked from: the
// query is kept and asked without it, one entry per name (S-2104 review).
const known = new Map<string, Promise<boolean>>()
export function hasDecl(q: DeclQuery): Promise<boolean> {
  const bare: DeclQuery = 'repo' in q ? { repo: q.repo, sha: q.sha, name: q.name } : { host: q.host, file: q.file, name: q.name }
  const key = declUrl(bare)
  let hit = known.get(key)
  if (!hit) {
    hit = lookupDecl(bare, { maxPolls: 0 }).then((r) => r.state === 'ready' && r.matches.length > 0, () => { known.delete(key); return false })
    known.set(key, hit)
    while (known.size > 500) known.delete(known.keys().next().value!)
  }
  return hit
}
export const _resetKnown = () => known.clear()

// The page's side of the PR diff API (S-1530, `GET /api/diff` and `GET /api/diff/file`). A file's two sides are
// fetched with the `head` and `base` shas the list returned, so a push after the list doesn't change them under the view.
import { token } from '../api'
import type { PrList } from './diffModel'

export class DiffFail extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

const headers = () => ({ authorization: 'Bearer ' + token, 'x-stam-human': '1' })

async function fail(r: Response): Promise<DiffFail> {
  const d = await r.json().catch(() => ({}))
  const said = (d as { error?: string }).error
  const why = r.status === 504 ? 'Fetching the PR timed out. Try again.' : r.status === 502 ? `Fetching the PR failed${said ? `: ${said}` : ''}.` : said || `HTTP ${r.status}`
  return new DiffFail(why, r.status)
}

export const diffListUrl = (repo: string, pr: number): string => `/api/diff?repo=${encodeURIComponent(repo)}&pr=${pr}`

export async function fetchDiffList(repo: string, pr: number, signal?: AbortSignal): Promise<PrList> {
  const r = await fetch(diffListUrl(repo, pr), { signal, headers: headers() })
  if (!r.ok) throw await fail(r)
  return r.json()
}

export interface SideRef { repo: string; pr: number; head: string; base: string }
export const diffFileUrl = (s: SideRef, path: string, side: 'base' | 'head', all = false): string =>
  `/api/diff/file?repo=${encodeURIComponent(s.repo)}&pr=${s.pr}&path=${encodeURIComponent(path)}&side=${side}&head=${s.head}&base=${s.base}${all ? '&all=1' : ''}`

// One side of a file. `missing`: no side asked for (an added file's base, a deleted file's head). `binary`: not text, with its size and no body read.
// `large`: over the text cap (the server cut it) or over the byte limit, never drawn as a diff.
export type Side =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'binary'; size: number }
  | { kind: 'large'; size: number }

export async function fetchSide(s: SideRef, path: string, side: 'base' | 'head', signal?: AbortSignal): Promise<Side> {
  const r = await fetch(diffFileUrl(s, path, side), { signal, headers: headers() })
  // A 404 is an error, not an absent side: the server also says 404 when the head or base left its cache (a force-push), and the view must not then draw the whole file as added or deleted.
  if (r.status === 413) return { kind: 'large', size: 0 }
  if (!r.ok) throw await fail(r)
  const type = r.headers.get('content-type') ?? ''
  const size = Number(r.headers.get('x-stam-size') ?? r.headers.get('content-length') ?? 0)
  // An SVG is served as an image but is text, and a diff of its source is what a review wants.
  if (!type.startsWith('text/') && !type.startsWith('image/svg+xml')) { void r.body?.cancel(); return { kind: 'binary', size } }
  if (r.headers.get('x-stam-truncated') === '1') { void r.body?.cancel(); return { kind: 'large', size } }
  return { kind: 'text', text: await r.text() }
}

// The whole head (or base) file as a blob, for the download of a file too large to diff.
export async function fetchWhole(s: SideRef, path: string, side: 'base' | 'head'): Promise<Blob> {
  const r = await fetch(diffFileUrl(s, path, side, true), { headers: headers() })
  if (!r.ok) throw await fail(r)
  return r.blob()
}

// The repos the diff API serves (S-1533): each name in `settings.itsa.repos` with the GitHub `OWNER/REPO` its origin
// names, and — S-2104, so a pasted patch can be matched against the checkout and labelled with where it came from — the
// checkout's own path and its HEAD, and the machine those checkouts are on (`host`, which is not this page's daemon when
// the ITSA home is another one). Path, sha and host are absent from an older daemon's answer, which a patch then resolves
// without its writer's base still answering, if the entry carries one.
export interface DiffRepo { name: string; github: string | null; path?: string; sha?: string | null; host?: string }
export async function fetchDiffRepos(signal?: AbortSignal): Promise<DiffRepo[]> {
  const r = await fetch('/api/diff/repos', { signal, headers: headers() })
  if (!r.ok) throw await fail(r)
  const d = await r.json() as { machine?: string; repos?: DiffRepo[] }
  const host = typeof d.machine === 'string' ? d.machine : undefined
  return Array.isArray(d.repos) ? d.repos.map((x) => (host ? { ...x, host } : x)) : []
}

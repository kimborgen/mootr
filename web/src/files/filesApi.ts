// The page's side of the Files API (S-1525, `GET /api/files/list|read?host=&path=`). Every refusal comes
// back as a FilesFail the views draw: a stopped peer (503 {state:'stopped'}) offers Start, and a strict-mode
// 409 `human-on-machine` names that machine's own page, as a write does (api.ts).
import { api, machinePage, token } from '../api'

export interface Entry { name: string; kind: 'file' | 'dir' | 'symlink'; size: number; mtime: number }
export type Listing = { roots: { path: string; name: string }[] } | { path: string; entries: Entry[] }

export class FilesFail extends Error {
  status: number
  stopped: boolean
  page?: { machine: string; origin?: string }
  constructor(message: string, status: number, stopped = false, page?: { machine: string; origin?: string }) { super(message); this.status = status; this.stopped = stopped; this.page = page }
}

const url = (what: 'list' | 'read', host: string, path: string, all = false) =>
  `/api/files/${what}?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}${all ? '&all=1' : ''}`

async function fail(r: Response): Promise<FilesFail> {
  const d = await r.json().catch(() => ({}))
  const stopped = r.status === 503 && (d as { state?: string }).state === 'stopped'
  return new FilesFail((d as { error?: string }).error || `HTTP ${r.status}`, r.status, stopped, r.status === 409 ? machinePage(d) : undefined)
}

export async function listFiles(host: string, path: string, signal?: AbortSignal): Promise<Listing> {
  const r = await fetch(url('list', host, path), { signal, headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' } })
  if (!r.ok) throw await fail(r)
  return r.json()
}

// A PDF above this is not loaded into the viewer (PDFium rasters in a WASM heap capped at 2 GB): the view offers Download.
export const PDF_MAX = 50 * 1024 * 1024

export interface Body { type: string; size: number; truncated: boolean; text?: string; blob?: Blob }
// Reads a file. Text comes back as text; an image, and a PDF up to PDF_MAX, as a blob; anything else is not
// downloaded here (a video can be large): its body is cancelled once the headers say what it is.
export async function readFile(host: string, path: string, all = false, signal?: AbortSignal): Promise<Body> {
  const r = await fetch(url('read', host, path, all), { signal, headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' } })
  if (!r.ok) throw await fail(r)
  const type = r.headers.get('content-type') ?? 'application/octet-stream'
  const size = Number(r.headers.get('x-stam-size') ?? r.headers.get('content-length') ?? 0)
  const truncated = r.headers.get('x-stam-truncated') === '1'
  if (type.startsWith('text/')) return { type, size, truncated, text: await r.text() }
  if (type.startsWith('image/') || (type.startsWith('application/pdf') && size <= PDF_MAX)) return { type, size, truncated, blob: await r.blob() }
  void r.body?.cancel()
  return { type, size, truncated }
}

// The file's bytes as a blob, for the Download link (the read needs the token a plain link can't carry).
export async function downloadBlob(host: string, path: string): Promise<Blob> {
  const r = await fetch(url('read', host, path, true), { headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' } })
  if (!r.ok) throw await fail(r)
  return r.blob()
}

// Starts a stopped peer (the daemon's ensureUp, the start a spawn on a peer uses).
export const startMachine = (name: string) => api<{ ok: true }>('POST', `/api/machines/${encodeURIComponent(name)}/start`, {})

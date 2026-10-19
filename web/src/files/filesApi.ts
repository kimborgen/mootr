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
// An image above this is not read into the tab (a mislabelled multi-GB `.png` would be): the view offers Download.
export const IMAGE_MAX = 50 * 1024 * 1024
// Download builds the whole file as a blob in the tab (the read needs the token a link can't carry), so above this it
// is refused. Streaming a bigger one needs a token-in-URL or ticket download, a separate auth change.
export const DOWNLOAD_MAX = 500 * 1024 * 1024
export const tooBigToDownload = (size: number) => `${baseMb(size)} MB is too large to download in the browser.`
// A download stopped by the byte count knows only that the file is past the cap, not its size.
const overCap = () => `Over ${baseMb(DOWNLOAD_MAX)} MB is too large to download in the browser.`
const baseMb = (size: number) => Math.max(1, Math.round(size / 1024 / 1024))

export interface Body { type: string; size: number; truncated: boolean; text?: string; blob?: Blob }
// Reads a file. Text comes back as text; an image up to IMAGE_MAX, and a PDF up to PDF_MAX, as a blob; anything else is not
// downloaded here (a video can be large): its body is cancelled once the headers say what it is.
export async function readFile(host: string, path: string, all = false, signal?: AbortSignal): Promise<Body> {
  const r = await fetch(url('read', host, path, all), { signal, headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' } })
  if (!r.ok) throw await fail(r)
  const type = r.headers.get('content-type') ?? 'application/octet-stream'
  const size = Number(r.headers.get('x-stam-size') ?? r.headers.get('content-length') ?? 0)
  const truncated = r.headers.get('x-stam-truncated') === '1'
  if (type.startsWith('text/')) return { type, size, truncated, text: await r.text() }
  const cap = type.startsWith('image/') ? IMAGE_MAX : type.startsWith('application/pdf') ? PDF_MAX : 0
  if (cap && size <= cap) {
    // The header can be missing or wrong: the bytes are counted too, and past the cap the read stops.
    const blob = await readCapped(r, cap, type)
    if (blob) return { type, size, truncated, blob }
    return { type, size: Math.max(size, cap + 1), truncated }
  }
  void r.body?.cancel()
  return { type, size, truncated }
}

// The body as a blob, read in chunks; null (body cancelled) once it passes `max` bytes. `onChunk` gets the bytes so far.
async function readCapped(r: Response, max: number, type: string, onChunk?: (got: number) => void): Promise<Blob | null> {
  // No streams: the body can only be read whole, so the cap is checked after the read. downloadBlob has already refused a
  // size header past the cap, so this is only reached for a body whose size the headers didn't say.
  if (!r.body?.getReader) {
    const b = await r.blob()
    return b.size > max ? null : b
  }
  const reader = r.body.getReader()
  const parts: Uint8Array[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    got += value.length
    if (got > max) { void reader.cancel(); return null }
    parts.push(value)
    onChunk?.(got)
  }
  return new Blob(parts as BlobPart[], { type })
}

// The file's bytes as a blob, for the Download link (the read needs the token a plain link can't carry). Over
// DOWNLOAD_MAX (by the size header, or by the bytes when it is missing) the body is cancelled and it throws;
// `onProgress` gets 0..1 while it streams, when the size is known.
export async function downloadBlob(host: string, path: string, onProgress?: (done: number) => void, signal?: AbortSignal): Promise<Blob> {
  const r = await fetch(url('read', host, path, true), { signal, headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' } })
  if (!r.ok) throw await fail(r)
  const size = Number(r.headers.get('x-stam-size') ?? r.headers.get('content-length') ?? 0)
  if (size > DOWNLOAD_MAX) { void r.body?.cancel(); throw new Error(tooBigToDownload(size)) }
  const type = r.headers.get('content-type') ?? 'application/octet-stream'
  const blob = await readCapped(r, DOWNLOAD_MAX, type, onProgress && size ? (got) => onProgress(Math.min(1, got / size)) : undefined)
  if (!blob) throw new Error(overCap())
  return blob
}

// Starts a stopped peer (the daemon's ensureUp, the start a spawn on a peer uses).
export const startMachine = (name: string) => api<{ ok: true }>('POST', `/api/machines/${encodeURIComponent(name)}/start`, {})

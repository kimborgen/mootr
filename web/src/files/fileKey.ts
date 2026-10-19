// The file view's key and what it dispatches on (S-1526): `file:HOST:PATH` with an optional `#Lline`,
// a path split into breadcrumbs, and the kind of viewer a file gets. Pure, so it is tested alone.

export interface FileRef { host: string; path: string; line?: number }

export const fileKey = (host: string, path: string, line?: number): string => `file:${host}:${path}${line ? `#L${line}` : ''}`

// The deep link for a file (`#file=HOST:PATH[#Lline]`): the path is encoded so `+` and `&` survive, its slashes stay.
export const fileHref = (host: string, path: string, line?: number): string => `#file=${encodeURIComponent(host)}:${encodeURIComponent(path).replace(/%2F/g, '/')}${line ? `#L${line}` : ''}`

// A key `file:HOST:/abs/path[#Lline]`, or null. A host has no colon; a path is absolute.
export function parseFileKey(key: string): FileRef | null {
  const m = /^file:([^:/]+):(\/.*)$/.exec(key)
  if (!m) return null
  const line = /^(.*)#L(\d+)$/.exec(m[2])
  return line ? { host: m[1], path: line[1], line: Number(line[2]) } : { host: m[1], path: m[2] }
}

// A deep link's value (`#file=HOST:PATH`) is the key without its `file:` prefix.
export const parseFileLink = (v: string): FileRef | null => parseFileKey('file:' + v)

export interface Crumb { name: string; path: string }
// '/a/b/c.ts' is a, b, c.ts, each with the path that opens it; the root '/' is not a crumb.
export function crumbs(path: string): Crumb[] {
  const parts = path.split('/').filter(Boolean)
  return parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))
}

export const parentOf = (path: string): string => path.replace(/\/[^/]*$/, '') || '/'
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export type Kind = 'image' | 'pdf' | 'markdown' | 'text' | 'download'

const IMAGE = /^(png|jpe?g|gif|webp|svg)$/
const MARKDOWN = /^(md|markdown)$/

// The viewer for a file. The server's content type (it sniffs the bytes) wins over the extension: a
// `text/*` answer is text, an image is an image, a PDF is a PDF, and everything else (video, audio,
// binaries) is a download for now. Without a content type yet, the extension guesses, which decides whether the
// page fetches the body as text.
export function kindOf(name: string, contentType?: string | null): Kind {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const type = contentType?.split(';')[0].trim().toLowerCase()
  if (type) {
    if (type.startsWith('image/')) return 'image'
    if (type === 'application/pdf') return 'pdf'
    if (type.startsWith('text/')) return MARKDOWN.test(ext) ? 'markdown' : 'text'
    return 'download'
  }
  if (IMAGE.test(ext)) return 'image'
  if (MARKDOWN.test(ext)) return 'markdown'
  if (ext === 'pdf') return 'pdf'
  if (/^(mp4|webm|mov|m4v|mp3|wav|ogg|m4a|zip|gz|tar|bin)$/.test(ext)) return 'download'
  return 'text'
}

// Recent files, per viewer. A failing storage reads as empty and writes nothing.
const RECENT = 'stam/files-recent'
const RECENT_MAX = 12
export function readRecent(): FileRef[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT) || '[]')
    return Array.isArray(v) ? v.filter((r) => r && typeof r.host === 'string' && typeof r.path === 'string').slice(0, RECENT_MAX) : []
  } catch { return [] }
}
// Views showing the list re-read it when a file is pushed.
const recentListeners = new Set<() => void>()
export const onRecent = (fn: () => void): (() => void) => { recentListeners.add(fn); return () => { recentListeners.delete(fn) } }
export function pushRecent(ref: FileRef): FileRef[] {
  const next = [{ host: ref.host, path: ref.path }, ...readRecent().filter((r) => r.host !== ref.host || r.path !== ref.path)].slice(0, RECENT_MAX)
  try { localStorage.setItem(RECENT, JSON.stringify(next)) } catch {}
  for (const fn of recentListeners) fn()
  return next
}

// The path box: `/abs/path` on the machine shown first, `HOST:/abs/path` on another, `~/x` is not expanded here
// (the daemon expands it for the host it runs on, so it passes through as given).
export function pathBoxTarget(text: string, here: string): { host: string; path: string } | null {
  const t = text.trim()
  const m = /^([^:/\s]+):(\/.*|~.*)$/.exec(t)
  if (m) return { host: m[1], path: m[2] }
  return t.startsWith('/') || t.startsWith('~') ? { host: here, path: t } : null
}

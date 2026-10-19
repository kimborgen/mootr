// File paths in rendered Markdown become links to the file view (S-1529): `src/daemon.ts:3613`,
// `/home/user/projects/stam2/web/src/App.tsx:12`, `web/src/files/open.ts`. Pure text matching and DOM
// wrapping, so it is tested alone; a click opens the file through open.ts.
//
// Rules: a path links only if it has a known extension, or starts with a known project folder, or is
// absolute with an extension. A URL never links. A relative path resolves against the base's `cwd`
// (the sender's or the viewed agent's working directory, on that agent's machine); with no `cwd` it
// is left as text. `~/x` is left as text too: a view's key never holds `~`.
import { fileHref } from './fileKey'
import { openFile } from './open'

export interface FileBase { host: string; cwd?: string }

const EXT = 'ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|css|scss|html|htm|py|sh|bash|zsh|rs|go|java|c|h|cpp|hpp|rb|php|sql|yml|yaml|toml|ini|env|txt|log|csv|tsv|xml|svg|png|jpe?g|gif|webp|pdf|diff|patch|lock|conf|service|timer'
const PREFIX = '(?:src|web|docs|test|tests|scripts|bin|lib|app|packages|public|config)'
// A path: optional anchor, directories, a name. Not preceded by a word character, a slash, a dot, or a colon (a URL's `//host/x`).
const PATH = new RegExp(
  `(?<![\\w/.:@~+-])((?:\\.{1,2}/|/)?(?:[\\w@+.-]+/)*(?:[\\w@+-][\\w@+.-]*\\.(?:${EXT})|[\\w@+-](?:[\\w@+.-]*[\\w@+-])?))(?::(\\d+)(?::\\d+)?)?(?![\\w/-])`,
  'gi',
)
// A first segment that is a domain (`github.com/`, `docs.github.com/`, `bun.sh/`): a dotted name whose last label is no file extension, or one that is both.
const DOMAIN_ALSO_EXT = new Set(['sh', 'io', 'ai', 'md', 'py', 'rs', 'pl', 'cc', 'so', 'ms'])
const EXT_SET = new Set(EXT.split('|'))
const isHost = (raw: string): boolean => {
  const m = /^((?:[\w-]+\.)+([a-z]{2,}))\//i.exec(raw)
  return !!m && (!EXT_SET.has(m[2].toLowerCase()) || DOMAIN_ALSO_EXT.has(m[2].toLowerCase()))
}

export interface PathHit { start: number; end: number; path: string; line?: number }

export function findPaths(text: string): PathHit[] {
  const hits: PathHit[] = []
  for (const m of text.matchAll(PATH)) {
    const raw = m[1]
    if (isHost(raw)) continue
    const ext = new RegExp(`\\.(?:${EXT})$`, 'i').test(raw)
    // Without an extension, a path needs a known project folder first (`web/x`, not `a/web/x`) or `/home/`.
    if (!ext && !new RegExp(`^(?:\\./)?${PREFIX}/`).test(raw) && !raw.startsWith('/home/')) continue
    // A bare name (`Node.js`) reads as a word unless it has a line (`daemon.ts:12`) or is a `.js` or `.sh` name (`bun.sh` is a site).
    if (!raw.includes('/') && !m[2] && /\.(js|sh)$/i.test(raw)) continue
    hits.push({ start: m.index!, end: m.index! + m[0].length, path: raw, line: m[2] ? Number(m[2]) : undefined })
  }
  return hits
}

// An absolute path, from a hit's path and the base; null when it can't be resolved.
export function resolvePath(path: string, base: FileBase): string | null {
  if (path.startsWith('/')) return normalize(path)
  if (!base.cwd) return null
  return normalize(base.cwd.replace(/\/$/, '') + '/' + path)
}
function normalize(p: string): string | null {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!out.length) return null; out.pop() } else out.push(part)
  }
  return '/' + out.join('/')
}

// A text node this long is not prose with paths in it; skipped so a pathological run can't stall the page.
const MAX_TEXT = 20_000
const SKIP = 'a, pre, button, svg, textarea, script, style, .katex, .mb-embed, .mb-chart, .mb-diagram'

// Wraps each path in `el`'s text in a link. Inline code counts (agents put paths in backticks); code
// blocks, links, and embeds don't. Idempotent: a wrapped path sits in an `a`, which is skipped.
export function linkFilePaths(el: HTMLElement, base: FileBase): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!(n.parentElement?.closest(SKIP))) nodes.push(n as Text)
  for (const node of nodes) {
    const text = node.data
    if (text.length > MAX_TEXT) continue
    const frag = document.createDocumentFragment()
    let at = 0
    for (const h of findPaths(text)) {
      const abs = resolvePath(h.path, base)
      if (!abs) continue
      frag.append(text.slice(at, h.start))
      const a = document.createElement('a')
      a.className = 'file-link'
      a.href = fileHref(base.host, abs, h.line)
      a.dataset.fileHost = base.host
      a.dataset.filePath = abs
      if (h.line) a.dataset.fileLine = String(h.line)
      a.title = `Open ${abs}${h.line ? ' at line ' + h.line : ''} on ${base.host}`
      a.textContent = text.slice(h.start, h.end)
      frag.append(a)
      at = h.end
    }
    if (!at) continue
    frag.append(text.slice(at))
    node.replaceWith(frag)
  }
}

// A click on a path link opens the file view at its line. True when it handled the click.
export function fileLinkClick(e: { target: EventTarget | null; preventDefault(): void; metaKey?: boolean; ctrlKey?: boolean; button?: number }): boolean {
  const a = (e.target as Element | null)?.closest?.<HTMLElement>('a.file-link')
  if (!a?.dataset.filePath) return false
  if (e.metaKey || e.ctrlKey || (e.button ?? 0) !== 0) return false
  e.preventDefault()
  openFile(a.dataset.fileHost!, a.dataset.filePath, a.dataset.fileLine ? Number(a.dataset.fileLine) : undefined)
  return true
}


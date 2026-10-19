// Reference links (S-1484): a reference in running text, such as "#494" or "Settings › Spending", becomes
// a link. A resolver says what a reference can mean; one target is a plain link, several are a link that
// opens a picker (refClicks.ts). Resolvers are pluggable: refResolvers.ts registers the app's, and a new
// kind of reference is one more `registerRefResolver` call. This file is pure (no store, no UI) so the
// mail renderer can call it.
export interface RefTarget {
  // Its name in the picker, and a line saying what it is.
  label: string
  hint: string
  // Either a URL (opens in a new tab) or an in-app action such as `itsa:ID` or `settings:spend`
  // (refClicks.ts runs it).
  url?: string
  action?: string
}
export interface RefResolver {
  id: string
  // Global; the whole match is the text that becomes the link.
  pattern: RegExp
  // What this match can mean, best first; none leaves the text alone.
  resolve: (m: RegExpExecArray) => RefTarget[]
}

const resolvers: RefResolver[] = []
export function registerRefResolver(r: RefResolver): void {
  const at = resolvers.findIndex((x) => x.id === r.id)
  if (at >= 0) resolvers[at] = r
  else resolvers.push(r)
}
export const clearRefResolvers = () => { resolvers.length = 0 }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// The link for a match with these targets.
export function refHtml(text: string, targets: RefTarget[]): string {
  const t = targets[0]
  if (targets.length > 1) {
    return `<a href="#" class="reflink multi" data-ref-pick="${esc(JSON.stringify(targets))}" aria-haspopup="menu" title="${targets.length} matches: tap to choose">${esc(text)}</a>`
  }
  if (t.url) return `<a href="${esc(t.url)}" class="reflink" target="_blank" rel="noopener" title="${esc(t.hint)}">${esc(text)}</a>`
  return `<a href="#" class="reflink" data-ref-act="${esc(t.action)}" title="${esc(t.hint)}">${esc(text)}</a>`
}

// Links every reference in the text nodes under `root`, except inside code, links and buttons.
export function refLinks(root: ParentNode): void {
  for (const r of resolvers) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest('code, pre, a, button, h1, h2, h3, h4, h5, h6') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    })
    const nodes: Text[] = []
    while (walk.nextNode()) nodes.push(walk.currentNode as Text)
    for (const n of nodes) {
      const text = n.textContent ?? ''
      const re = new RegExp(r.pattern.source, r.pattern.flags.includes('g') ? r.pattern.flags : r.pattern.flags + 'g')
      let out = ''
      let last = 0
      let hit = false
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (!m[0]) { re.lastIndex++; continue }
        const targets = r.resolve(m)
        if (!targets.length) continue
        hit = true
        out += esc(text.slice(last, m.index)) + refHtml(m[0], targets)
        last = m.index + m[0].length
      }
      if (!hit) continue
      const span = document.createElement('span')
      span.innerHTML = out + esc(text.slice(last))
      n.replaceWith(...span.childNodes)
    }
  }
}

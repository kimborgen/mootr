// What a click on a reference link does (S-1484): a link with one in-app target runs its action, a link with
// several opens a picker listing them. One document-level handler (main.tsx), so every place that renders
// mail Markdown gets it. Actions are registered by prefix: `itsa:ID`, `settings:KEY`.
import { openWorld } from '../actions'
import * as shell from '../shell/layout'
import { showMenu } from '../ui/menu'
import type { RefTarget } from './refs'

const actions = new Map<string, (arg: string) => void>()
export const registerRefAction = (prefix: string, fn: (arg: string) => void) => { actions.set(prefix, fn) }

registerRefAction('itsa', (id) => shell.showAgentWorld('w:itsa:' + id))
// The keys ConfigView reads to open a section, plus an event for when Settings is already on screen (Search.tsx does the same).
registerRefAction('settings', (key) => {
  try { localStorage.setItem('stam/settings-section', key); localStorage.removeItem('stam/settings-item') } catch {}
  openWorld('config')
  window.dispatchEvent(new CustomEvent('stam:open-setting', { detail: { section: key } }))
})

export function runRef(t: RefTarget): void {
  if (t.url) { if (/^https:\/\//i.test(t.url)) window.open(t.url, '_blank', 'noopener'); return }
  const i = (t.action ?? '').indexOf(':')
  actions.get((t.action ?? '').slice(0, i))?.((t.action ?? '').slice(i + 1))
}

// True when the click was on a reference link.
export function handleRefClick(e: MouseEvent): boolean {
  const a = (e.target as Element).closest<HTMLElement>('a.reflink')
  if (!a) return false
  const act = a.dataset.refAct
  const pick = a.dataset.refPick
  if (act) { e.preventDefault(); runRef({ label: '', hint: '', action: act }); return true }
  if (!pick) return false // a plain link: the browser opens it
  e.preventDefault()
  let targets: RefTarget[] = []
  try { targets = JSON.parse(pick) } catch { return true }
  const r = a.getBoundingClientRect()
  showMenu(r.left, r.bottom + 4, targets.map((t) => ({ label: t.label, hint: t.hint, icon: t.url ? 'external-link' : 'arrow-right', action: () => runRef(t) })), a)
  return true
}

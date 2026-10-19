// ITSAs in the web UI: the status vocabulary (a glyph whose shape is the category and whose
// colour is the tone), the roll-up bar, and what the human does to an ITSA (open its world,
// set its status or owner, add a child). The sidebar's Issues section and the ITSA view
// share them. See docs/itsa-design.md.
import type { CSSProperties } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { api } from '../api'
import { esc, live } from '../format'
import { Glyph, PlainGlyph } from '../Glyph'
import { nameFor } from '../mail/ThreadPanel'
import * as shell from '../shell/layout'
import { optimistic } from '../optimistic'
import { byId, getData, refreshItsas } from '../store'
import { type MenuItem } from '../ui/menu'
import type { Itsa, ItsaCategory, ItsaStatus, Rollup } from '../types'

// An owner's update's health: a dot and a label in a status tone.
export const HEALTH: Record<string, { label: string; tone: string }> = {
  on_track: { label: 'On track', tone: 'var(--status-success-fg)' },
  at_risk: { label: 'At risk', tone: 'var(--status-warning-fg)' },
  off_track: { label: 'Off track', tone: 'var(--status-error-fg)' },
}

export const CATEGORIES: ItsaCategory[] = ['backlog', 'ready', 'active', 'review', 'closed']
export const CATEGORY_LABEL: Record<ItsaCategory, string> = { backlog: 'Backlog', ready: 'Ready', active: 'Active', review: 'Review', closed: 'Closed' }

// A status the settings don't know (renamed since) still shows, as backlog.
export function statusInfo(name: string): ItsaStatus {
  return getData().itsaStatuses.find((s) => s.name === name) ?? { name, category: 'backlog', human: false }
}
export const statusLabel = (name: string) => name.replace(/_/g, ' ')
export const isClosed = (it: Pick<Itsa, 'status'>) => statusInfo(it.status).category === 'closed'
export const waitsOnHuman = (it: Pick<Itsa, 'status'>) => statusInfo(it.status).human

// The ITSAs an agent shows as its own on its tab (S-1452): the ones it owns that aren't closed,
// less any with an owned, open ancestor. A project and its issues show the project; a closed
// ancestor hides nothing. Stops on a parent loop.
export function topOwned(all: Itsa[], agentId: string): Itsa[] {
  const mine = all.filter((x) => x.owner === agentId && !isClosed(x))
  const ids = new Set(mine.map((x) => x.id))
  const parent = new Map(all.map((x) => [x.id, x.parent_id]))
  const hasOwnedAbove = (x: Itsa) => {
    const seen = new Set([x.id])
    for (let p = x.parent_id; p && !seen.has(p); p = parent.get(p) ?? null) { if (ids.has(p)) return true; seen.add(p) }
    return false
  }
  return mine.filter((x) => !hasOwnedAbove(x))
}

// The tone token (tokens-stam.css, --is-*) for a status.
export function toneOf(s: ItsaStatus): string {
  if (s.human || s.name === 'blocked') return 'waiting'
  if (s.category === 'closed') return getData().itsaStatuses.find((x) => x.category === 'closed')?.name === s.name ? 'done' : 'closed'
  return s.category
}
export const toneVar = (name: string) => `var(--is-${toneOf(statusInfo(name))})`

// The status glyph, on Lucide's xs grid: a dashed ring for backlog, a ring for ready, a
// half-filled ring for active, three quarters for review, a tick for done, a cross for the
// other closed statuses.
export function StatusGlyph({ status, title }: { status: string; title?: string }) {
  const s = statusInfo(status)
  const tone = toneOf(s)
  return (
    <svg className={`sglyph ${s.category}`} viewBox="0 0 14 14" width="14" height="14" style={{ '--tc': `var(--is-${tone})` } as CSSProperties} role="img" aria-label={title ?? statusLabel(status)}>
      {title ? <title>{title}</title> : null}
      <circle cx="7" cy="7" r="5.75" fill="none" stroke="var(--tc)" strokeWidth="1.5" strokeDasharray={s.category === 'backlog' ? '2.2 2.3' : undefined} />
      {s.category === 'active' ? <path d="M7 7V3.5A3.5 3.5 0 0 1 7 10.5Z" fill="var(--tc)" /> : null}
      {s.category === 'review' ? <path d="M7 7V3.5A3.5 3.5 0 1 1 3.5 7Z" fill="var(--tc)" /> : null}
      {s.category === 'closed' ? (tone === 'done'
        ? <path d="M4.6 7.2 6.3 8.9 9.5 5.4" fill="none" stroke="var(--tc)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M5 5 9 9M9 5 5 9" fill="none" stroke="var(--tc)" strokeWidth="1.5" strokeLinecap="round" />) : null}
    </svg>
  )
}

// An S-N key in mail text: the status glyph, then the key, linked to the ITSA. The status name
// and title go in the link's title and accessible name. Built from the store, so a status change
// re-renders the key (Rendered depends on the ITSA list).
export function itsaKeyLink(key: string): string | null {
  const it = getData().itsas.find((i) => i.key === key)
  if (!it) return null
  const label = `${it.key}, ${statusLabel(it.status)}: ${it.title}`
  const glyph = renderToStaticMarkup(<StatusGlyph status={it.status} />)
  return `<a href="#" class="itsalink" data-open-itsa="${it.id}" title="${esc(label)}" aria-label="${esc(label)}"><span class="itsa-key-status" aria-hidden="true">${glyph}</span>${esc(it.key)}</a>`
}

// Counts of an ITSA's direct children by category, from the full list.
export function rollupOf(id: string, all: Itsa[]): Rollup {
  const r: Rollup = { backlog: 0, ready: 0, active: 0, review: 0, closed: 0 }
  for (const x of all) if (x.parent_id === id) r[statusInfo(x.status).category]++
  return r
}
export const rollupTotal = (r: Rollup) => CATEGORIES.reduce((n, c) => n + r[c], 0)
export const rollupText = (r: Rollup) => {
  const parts = CATEGORIES.filter((c) => r[c]).map((c) => `${r[c]} ${CATEGORY_LABEL[c].toLowerCase()}`)
  return `${r.closed} of ${rollupTotal(r)} closed${parts.length ? ' · ' + parts.join(', ') : ''}`
}

// The roll-up bar: closed children in success, active and review in progress, the rest
// the track. Its title spells the counts out.
export function RollupBar({ r, wide }: { r: Rollup; wide?: boolean }) {
  const total = rollupTotal(r)
  if (!total) return null
  const pct = (n: number) => `${(n / total) * 100}%`
  return (
    <span className={'rollup' + (wide ? ' wide' : '')} title={rollupText(r)} aria-label={rollupText(r)} role="img">
      <i className="closed" style={{ width: pct(r.closed) }} /><i className="moving" style={{ width: pct(r.active + r.review) }} />
    </span>
  )
}

// An owner or participant: an agent's mark with its state ring, or the human.
export function PersonGlyph({ id }: { id: string | null }) {
  if (!id) return <span className="glyph plain nobody" />
  const a = byId(id)
  return a ? <Glyph agent={a} /> : <PlainGlyph name={id === 'human' ? 'user' : 'bot'} />
}
export const personName = (id: string | null) => (id ? nameFor(id) : 'No owner')

// --- What the human does ----------------------------------------------------------------

export const itsaWorld = (id: string) => 'w:itsa:' + id
export const openItsa = (id: string) => shell.showAgentWorld(itsaWorld(id))
// An ITSA named in a mail (a chip, an S-N key in the body or the subject). On a phone it is a
// pushed view: its own world, so Back returns to the thread (S-24's history). On the desktop
// it opens in the thread's right split, beside the thread: the pane's right neighbour when
// there is one (reused), else a new split. `from` is the element clicked, whose pane it is.
export function openFromMail(id: string, from: Element | null) {
  if (shell.isPhone()) return openItsa(id)
  const main = shell.mainWorld()
  const pane = from?.closest<HTMLElement>('.pane[data-id]')?.dataset.id ?? shell.focusedLeaf(main)?.id
  const at = besideLeaf(main, pane)
  shell.open('main', 'itsa:' + id, at ? { pane: at } : { pane, split: 'right' })
}
// The first leaf of the row split's child to the right of a pane, if it has one.
function besideLeaf(w: shell.World, pane: string | undefined): string | undefined {
  const l = shell.leafById(w, pane)
  const p = l && shell.parentOf(w.root, l)
  if (!p || p.parent.split !== 'row') return undefined
  const right = p.parent.children[p.index + 1]
  return right ? shell.leaves(right)[0]?.id : undefined
}
// A board: an ITSA's, as a tab in its world, or every root's, in a world of its own.
export const openBoard = (id: string | null) => {
  if (!id) return shell.showAgentWorld('w:board:all')
  shell.showAgentWorld(itsaWorld(id))
  shell.open('main', 'board:' + id)
}
export const openedItsa = () => { const cw = shell.currentWorld(); return cw?.startsWith('w:itsa:') ? cw.slice(7) : null }

// Changes the status or owner as the human. The change shows at once (pending) and a refusal
// rolls it back with a toast; resolves true when the daemon took it.
export function setItsa(id: string, patch: { status?: string; owner?: string | null }): Promise<boolean> {
  return optimistic({
    apply: (d) => ({ ...d, itsas: d.itsas.map((x) => (x.id === id ? { ...x, ...patch, pending: true } : x)) }),
    send: () => api('PATCH', `/api/itsas/${id}`, patch).then(() => refreshItsas()),
    settled: (p) => { const x = p.itsas.find((i) => i.id === id); return !!x && (patch.status === undefined || x.status === patch.status) && (patch.owner === undefined || x.owner === patch.owner) },
    failed: "Couldn't change it",
  })
}

// A new child shows at once, under its parent, as pending until the daemon has it. Resolves the
// new ITSA, or null after a refusal (which toasts).
export async function createItsa(parent: string | null, title: string): Promise<Itsa | null> {
  let made: Itsa | null = null
  const now = new Date().toISOString()
  const copy = { id: `pending-${now}`, key: '', parent_id: parent, kind: null, title, summary: null, body: null, status: 'backlog', owner: null, thread_id: null, created_by: 'human', created_at: now, updated_at: now, closed_at: null, pending: true } as Itsa
  const ok = await optimistic({
    apply: (d) => ({ ...d, itsas: [...d.itsas, copy] }),
    send: () => api<Itsa>('POST', '/api/itsas', { parent, title }).then((it) => { made = it; return refreshItsas() }),
    settled: (p) => !!made && p.itsas.some((x) => x.id === made?.id),
    failed: "Couldn't add it",
  })
  return ok ? made : null
}

// The optimistic rows still worth showing under a parent: one is dropped once the saved child is in
// the fetched list (matched by title, made since the row was), whether the POST answer or the event
// that added it arrived first. The overlay itself waits for the polled list, which can be later.
export function unsavedKids(adds: Itsa[], saved: { title: string; created_at: string }[]): Itsa[] {
  return adds.filter((a) => !saved.some((c) => c.title === a.title && Date.parse(c.created_at) >= Date.parse(a.created_at) - 300000))
}

// The status picker: every status by category, the current one ticked. A menu on a desktop,
// a sheet on a phone.
export function statusMenu(it: Itsa, done?: () => void): MenuItem[] {
  const all = getData().itsaStatuses
  return CATEGORIES.flatMap((c) => {
    const ss = all.filter((s) => s.category === c)
    return ss.length ? [{ section: CATEGORY_LABEL[c] } as MenuItem, ...ss.map((s): MenuItem => ({
      label: statusLabel(s.name), glyph: <StatusGlyph status={s.name} />, checked: s.name === it.status, hint: s.human ? 'waits on you' : undefined,
      action: () => { if (s.name !== it.status) setItsa(it.id, { status: s.name }).then(() => done?.()) },
    }))] : []
  })
}

// The owner picker: the human, nobody, then every running agent.
export function ownerMenu(it: Itsa, done?: () => void): MenuItem[] {
  const pick = (owner: string | null) => () => { if (owner !== it.owner) setItsa(it.id, { owner }).then(() => done?.()) }
  const agents = getData().agents.filter((a) => live(a) && a.kind !== 'assistant').sort((x, y) => x.name.localeCompare(y.name))
  const cur = it.owner && !agents.some((a) => a.id === it.owner) && it.owner !== 'human' ? byId(it.owner) : undefined
  return [{ section: 'Owner' },
    { label: 'You', glyph: <PersonGlyph id="human" />, checked: it.owner === 'human', action: pick('human') },
    { label: 'No owner', glyph: <PersonGlyph id={null} />, checked: !it.owner, action: pick(null) },
    ...(agents.length || cur ? [{ section: 'Agents' } as MenuItem] : []),
    ...(cur ? [{ label: cur.name, glyph: <Glyph agent={cur} />, checked: true, action: () => {} } as MenuItem] : []),
    ...agents.map((a): MenuItem => ({ label: a.name, glyph: <Glyph agent={a} />, checked: a.id === it.owner, title: a.role ?? undefined, action: pick(a.id) }))]
}

// What a waiting agent waits for, said short: the tree's icon, the tab's badges, the details
// list, and the tooltip share these. Ranked as the daemon ranks them
// (src/db.ts WAIT_RANK), so the first wait is the one the state names.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DragEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { selectAgent, selectThread } from './actions'
import { Icon } from './Icon'
import { usePhone } from './ui/phone'
import { byId, getData, permThread, useData } from './store'
import { openItsa, StatusGlyph, statusLabel, topOwned, waitsOnHuman } from './itsa/itsa'
import type { Agent, Itsa, Wait } from './types'

const RANK = ['human', 'agent', 'children', 'job', 'timer', 'event']
const rank = (w: Wait) => (RANK.indexOf(w.kind) + RANK.length + 1) % (RANK.length + 1)
export const WAIT_ICON: Record<string, string> = { human: 'user', agent: 'reply', children: 'network', job: 'terminal', timer: 'clock', event: 'radio' }

export const waitsOf = (a: Agent) => [...(a.waits ?? [])].sort((x, y) => rank(x) - rank(y))
export const clock = (t: string | number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
// Time left, as `4m`, `2h`, `3d`.
export function left(t: string) {
  const s = (new Date(t).getTime() - Date.now()) / 1000
  return s < 3600 ? Math.max(0, Math.ceil(s / 60)) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd'
}

export function waitLabel(w: Wait) {
  if (w.kind === 'agent') { const t = w.target ? byId(w.target) : undefined; return w.detail ?? `${t?.name ?? w.target ?? 'an agent'}'s reply` }
  if (w.kind === 'timer' && w.until) return `timer ${clock(w.until)}`
  return w.detail ?? (w.kind === 'human' ? 'you' : w.target ? `${w.kind} ${w.target}` : w.kind)
}

// Where a wait's link goes: the agent it waits for, or the permission request's thread.
function go(w: Wait): (() => void) | null {
  if (!w.target) return null
  if (w.kind === 'agent' && byId(w.target)) return () => selectAgent(w.target!)
  const tid = w.kind === 'human' ? permThread(w.target) : undefined
  return tid ? () => selectThread(tid) : null
}

export function WaitLink({ w }: { w: Wait }) {
  const to = go(w)
  const label = waitLabel(w)
  return to ? <a href="#" className={w.kind === 'human' ? 'urgent' : ''} onClick={(e) => { e.preventDefault(); to() }}>{label}</a> : <span className={w.kind === 'human' ? 'urgent' : ''}>{label}</span>
}

// The tree row's mark for the top wait. A human wait on a pending request is the approval
// badge's already, so it adds nothing; any other human wait is as loud as that badge.
export function WaitMark({ a }: { a: Agent }) {
  const w = waitsOf(a)[0]
  if (!w || (w.kind === 'human' && a.pending_requests)) return null
  const title = 'Waiting for ' + waitsOf(a).map(waitLabel).join(', ')
  if (w.kind === 'human') return <span className="badge warn" title={title}><Icon name="user" size="xs" /></span>
  return <span className="wait-mark" title={title}><Icon name={WAIT_ICON[w.kind] ?? 'clock'} size="xs" />{w.kind === 'timer' && w.until ? left(w.until) : null}</span>
}

// One shared ticker for every countdown on screen: a single interval runs while any badge is
// mounted, and each badge redraws on the second. `setClock` injects the time source for tests.
let nowFn: () => number = Date.now
export const setClock = (f: (() => number) | null) => { nowFn = f ?? Date.now; tick() }
const subs = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
const tick = () => subs.forEach((f) => f())
const subscribe = (f: () => void) => {
  subs.add(f)
  timer ??= setInterval(tick, 1000)
  return () => { subs.delete(f); if (!subs.size && timer) { clearInterval(timer); timer = undefined } }
}
const nowSecond = () => Math.floor(nowFn() / 1000)
export const useNow = () => useSyncExternalStore(subscribe, nowSecond) * 1000

// Time left at `now`, as `45s` under a minute, then `4m`, `2h`, `3d`.
export function countdown(until: string | number, now: number) {
  const s = Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000))
  // One rule for every unit: round up, and move to the next unit when the rounding reaches it.
  if (s < 60) return s + 's'
  const m = Math.ceil(s / 60), h = Math.ceil(s / 3600)
  return m < 60 ? m + 'm' : h < 24 ? h + 'h' : Math.ceil(s / 86400) + 'd'
}

// A timer badge's text. Only a timer badge mounts it, so the 1 Hz ticker redraws these and nothing else.
function TimerText({ until }: { until: number }) {
  return <>{countdown(until, useNow())}</>
}

// A human wait on a pending request is the tab's approval badge already (as in WaitMark).
const badgeWaits = (a: Agent) => waitsOf(a).filter((w) => !(w.kind === 'human' && a.pending_requests))

// How a tab shows its waits (S-1659): one badge per kind; one combined badge when those don't
// fit beside the name; nothing in the strip when even that doesn't fit, and then the active
// tab's thin bar (WaitThinBar) carries them.
export type Fit = 'each' | 'folded' | 'none'
const MODES: Fit[] = ['each', 'folded', 'none']
const fits = new Map<string, Fit>()
const fitSubs = new Set<() => void>()
const setFit = (key: string, f: Fit | null) => {
  if ((fits.get(key) ?? null) === f) return
  if (f) fits.set(key, f); else fits.delete(key)
  fitSubs.forEach((s) => s())
}
const subscribeFit = (f: () => void) => { fitSubs.add(f); return () => { fitSubs.delete(f) } }
// A tab's fit by its tab key (the strip's `data-key`), so two tabs of one agent fit apart.
export const useFit = (key: string | undefined): Fit => useSyncExternalStore(subscribeFit, () => (key && fits.get(key)) || 'each')

// The least a tab's name keeps, from its token.
const nameMin = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--size-tab-name-min')) || 0

// One badge per kind, with its count or the soonest timer's time left.
function KindBadges({ ws, phone }: { ws: Wait[]; phone: boolean }) {
  const kinds = [...new Set(ws.map((w) => w.kind))]
  return <>{kinds.map((kind) => {
    const of = ws.filter((w) => w.kind === kind)
    const until = kind === 'timer' ? Math.min(...of.filter((w) => w.until).map((w) => new Date(w.until!).getTime())) : NaN
    const text = Number.isFinite(until) ? <TimerText until={until} /> : of.length > 1 ? String(of.length) : ''
    const name = 'Waiting for ' + of.map(waitLabel).join(', ')
    // A phone's tap target is 44 px and a tab has no room for that: there a badge only informs, and a tap selects the tab; the details list holds the links.
    const to = phone ? null : of.map(go).find(Boolean) ?? null
    const cls = `badge wait-badge ${kind === 'human' ? 'warn' : ''}`
    const inner = <><Icon name={WAIT_ICON[kind] ?? 'clock'} size="xs" />{text}</>
    return to
      ? <button type="button" key={kind} className={cls} data-wait={kind} title={name} aria-label={name} onClick={(e) => { e.stopPropagation(); to() }}>{inner}</button>
      : <span key={kind} className={cls} data-wait={kind} title={name} aria-label={name} role="img">{inner}</span>
  })}</>
}

// The room a tab's name has if this slot and the sibling slot `also` (which yields to it) took no
// width: the tab's inner width less every other child and the gaps between them. It leaves out the
// slot, `also` and their gaps, so it is the same whatever mode the slot shows: a mode that changed
// the room would let the fit cycle between two modes (React #185). Summing what the other children
// really take, not reading the label's width, keeps it exact when the label is squeezed to nothing.
// Null when the tab isn't laid out (a hidden pane, or no tab around it).
const roomFor = (wrap: HTMLElement, also?: string): { r: number; gap: number } | null => {
  const tab = wrap.closest<HTMLElement>('.tab')
  if (!tab) return null
  const cs = getComputedStyle(tab)
  const inner = tab.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
  if (inner <= 0) return null
  const gap = parseFloat(cs.columnGap) || 0
  const label = tab.querySelector('.label')
  const alsoEl = also ? tab.querySelector(also) : null
  const others = [...tab.children].filter((c): c is HTMLElement => c !== label && c !== wrap && c !== alsoEl && (c as HTMLElement).offsetWidth > 0)
  return { r: inner - others.reduce((n, c) => n + c.offsetWidth, 0) - gap * others.length, gap }
}

// The fit of a tab's badge slot (S-1659; shared with the ITSA chips, S-1452): measured after every
// render, and whenever the tab resizes. The rendered mode's width is kept, and the mode that fits is
// the one the store holds. An unmeasured mode counts as fitting, so it renders once and is measured
// then. A resize, a changed tab width or a changed `sig` drops what was kept and starts again from
// each, so a bad early read can't pin the tab to none. `key` is the store key of this slot's fit.
export function useTabFit(key: string, sig: string, wrap: RefObject<HTMLElement | null>, also?: string): Fit {
  // The slot's own fit is the hook's state: the store reached the render too late in the browser
  // (the story's tight tab kept all six badges, S-1659). The store only tells the thin bar.
  const [fit, setFitState] = useState<Fit>('each')
  const fitNow = useRef<Fit>('each')
  fitNow.current = fit
  const sized = useRef<Partial<Record<Fit, number>>>({})
  const lastTab = useRef(0)
  const lastSig = useRef('')
  const flips = useRef(0)
  const lastW = useRef<number | undefined>(undefined)
  const measure = (resized = false) => {
    const el = wrap.current
    if (!el) return setFit(key, null)
    const shown = fitNow.current
    const room = roomFor(el, also)
    if (!room || !nameMin()) return // not laid out: keep what there is
    // The tab's own width, not the room: the room shrinks when the badges outgrow the tab, so it
    // changes with the mode, which would start the fit over on every pass.
    const tabW = el.closest<HTMLElement>('.tab')?.offsetWidth ?? 0
    if (resized || tabW !== lastTab.current || sig !== lastSig.current)  sized.current = {}
    lastTab.current = tabW
    lastSig.current = sig
    if (shown !== 'none') sized.current[shown] = el.offsetWidth
    // A shown slot takes its width and one gap; a hidden one (width 0) takes neither.
    const ok = (w?: number) => room.r - (w ? w + room.gap : 0) >= nameMin()
    let f: Fit = ok(sized.current.each) ? 'each' : ok(sized.current.folded) ? 'folded' : 'none'
    // A safety net against a cycle: going to a roomier mode (a reset starts from `each`, a resize or
    // a sibling's change can reopen one) is allowed only a few times in one task, after which the
    // slot keeps the narrower mode it has. A narrower mode is always allowed, so it never ends
    // squeezing the name under its floor (a guard that froze the slot mid-descent did, S-1452).
    if (MODES.indexOf(f) < MODES.indexOf(shown)) { if (++flips.current > 4) f = shown; else setTimeout(() => { flips.current = 0 }) }
    fitNow.current = f; setFitState(f); setFit(key, f)
  }
  useLayoutEffect(() => { measure() })
  useLayoutEffect(() => {
    const tab = wrap.current?.closest('.tab')
    if (!tab || typeof ResizeObserver === 'undefined') return
    // A callback whose width is the one already seen (a height change, or the observer's own echo of a
    // fit change) keeps what was measured: starting over from `each` on every one flashed the badges
    // `each`, measured them too wide and folded them again, for ever. A call with no entry is a resize.
    const ro = new ResizeObserver((entries) => {
      const w = entries?.[0]?.contentRect.width
      if (w !== undefined && w === lastW.current) return
      lastW.current = w
      measure(true)
    })
    ro.observe(tab)
    return () => ro.disconnect()
  }, [key])
  useLayoutEffect(() => () => setFit(key, null), [key])
  return fit
}

// The popover of a folded badge (S-1659), shared by the wait badges and the ITSA pill: it lives
// only while `canPop` holds, closes on Escape (its focus goes back to the badge), on a press outside
// the badge, when the strip scrolls, and on a resize, and its first link takes focus when it opens.
// Kept inside the viewport's right edge: once it has its width, it moves left if it would overflow.
export function useBadgePop(wrap: RefObject<HTMLElement | null>, canPop: boolean) {
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const badgeRef = useRef<HTMLButtonElement>(null)
  const open = !!pop && canPop
  useEffect(() => { if (pop && !canPop) setPop(null) }, [pop, canPop])
  useEffect(() => {
    if (!open) return
    const strip = wrap.current?.closest('.tabs')
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPop(null); badgeRef.current?.focus() } }
    const out = (e: PointerEvent) => { const t = e.target as Node; if (!wrap.current?.contains(t) && !popRef.current?.contains(t)) setPop(null) }
    const close = () => setPop(null)
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', out)
    strip?.addEventListener('scroll', close)
    window.addEventListener('resize', close)
    ;(popRef.current?.querySelector<HTMLElement>('a') ?? popRef.current)?.focus()
    return () => {
      document.removeEventListener('keydown', key)
      document.removeEventListener('pointerdown', out)
      strip?.removeEventListener('scroll', close)
      window.removeEventListener('resize', close)
    }
  }, [open])
  useLayoutEffect(() => {
    const el = popRef.current
    if (!el || !pop) return
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-3')) || 0
    const x = Math.max(0, Math.min(pop.x, document.documentElement.clientWidth - el.offsetWidth - gap))
    if (x !== pop.x) setPop({ ...pop, x })
  }, [pop])
  // The click that opens or closes it: from the badge, at its lower left.
  const toggle = (e: MouseEvent<HTMLElement>) => { e.stopPropagation(); if (open) return setPop(null); const r = e.currentTarget.getBoundingClientRect(); setPop({ x: r.left, y: r.bottom + 4 }) }
  return { pop, setPop, open, popRef, badgeRef, toggle }
}

export function PopPortal({ pop, popRef, label, onClose, children }: { pop: { x: number; y: number }; popRef: RefObject<HTMLDivElement | null>; label: string; onClose: () => void; children: ReactNode }) {
  return createPortal(<div ref={popRef} className="wait-pop" role="dialog" aria-label={label} tabIndex={-1} style={{ left: pop.x, top: pop.y }}
    // A portal's events bubble through the tab in React, so a middle click or a menu here must not reach it.
    onClick={(e) => { e.stopPropagation(); onClose() }} onAuxClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
    {children}
  </div>, document.body)
}

// A tab's wait badges (S-1433 PR 3, folded and popover in S-1659): one per wait kind, an icon
// plus a count, or the time left for a timer (the soonest). When they don't fit beside the name,
// they fold into one combined badge, and a desktop click on it opens the list of waits. On a
// desktop, clicking a badge goes to where its first wait points (the agent or the request) and
// never selects the tab under it. `tabKey` is the strip's key for the tab, which keys its fit.
// The waits come first in the tab and keep their room before the ITSA chips (S-1452).
export function WaitBadges({ id, tabKey = id }: { id: string; tabKey?: string }) {
  useData()
  const phone = usePhone()
  const a = byId(id)
  const ws = a && a.lifecycle === 'active' ? badgeWaits(a) : []
  const wrap = useRef<HTMLSpanElement>(null)
  // What the fit was measured against: the kinds and counts of the waits. A change in them starts
  // the fit again, so a shorter list is measured fresh (S-1659).
  const fit = useTabFit(tabKey, ws.map((w) => w.kind).join(), wrap, '.itsa-chips')
  // The popover lives only while the folded badge is on a desktop: any other fit closes it.
  const { pop, setPop, open, popRef, badgeRef, toggle } = useBadgePop(wrap, !phone && fit === 'folded' && ws.length > 0)
  if (!ws.length || fit === 'none') return <span ref={wrap} className="wait-badges" />
  if (fit === 'each') return <span ref={wrap} className="wait-badges"><KindBadges ws={ws} phone={phone} /></span>
  // Folded: the top wait's icon and the total, warning-coloured if any kind is a wait on the human.
  const name = 'Waiting for ' + ws.map(waitLabel).join(', ')
  const cls = `badge wait-badge ${ws.some((w) => w.kind === 'human') ? 'warn' : ''}`
  const inner = <><Icon name={WAIT_ICON[ws[0].kind] ?? 'clock'} size="xs" />{ws.length}</>
  if (phone) return <span ref={wrap} className="wait-badges"><span className={cls} data-wait="folded" title={name} aria-label={name} role="img">{inner}</span></span>
  return <span ref={wrap} className="wait-badges">
    <button ref={badgeRef} type="button" className={cls} data-wait="folded" title={name} aria-label={name} aria-haspopup="dialog" aria-expanded={open}
      onClick={toggle}>{inner}</button>
    {open && pop ? <PopPortal pop={pop} popRef={popRef} label={name} onClose={() => setPop(null)}>
      {ws.map((w, i) => <WaitLink key={w.id ?? i} w={w} />)}
    </PopPortal> : null}
  </span>
}

// A tab's links to the ITSAs its agent owns at the top (S-1452, `topOwned`): a chip with the key
// and the status glyph each, the title in the tooltip. A click opens the ITSA and never reaches the
// tab (no select, no middle-click close). When the chips don't fit beside the name they fold into
// one pill, `N ITSAs`, whose popover lists them; if even the pill doesn't fit, the active tab's thin
// bar holds the chips. The pill takes a tap on a phone too: it is the only way there to an ITSA.
// The chips come after the wait badges and give way to them: the waits are state, the chips links.
const stop = { onMouseDown: (e: MouseEvent) => e.stopPropagation(), onDragStart: (e: DragEvent) => { e.preventDefault(); e.stopPropagation() }, onAuxClick: (e: MouseEvent) => e.stopPropagation(), onContextMenu: (e: MouseEvent) => e.stopPropagation() }
const itsaFitKey = (k: string) => k + '#itsa'
const chipTitle = (x: Itsa) => `${x.key} ${x.title} · ${statusLabel(x.status)}${waitsOnHuman(x) ? ': waits on you' : ''}`

function Chips({ xs }: { xs: Itsa[] }) {
  return <>{xs.map((x) => (
    <button type="button" key={x.id} className={`ichip itsa-chip${waitsOnHuman(x) ? ' waits' : ''}`} data-itsa={x.id} title={chipTitle(x)} aria-label={chipTitle(x)} draggable={false} {...stop}
      onClick={(e) => { e.stopPropagation(); openItsa(x.id) }}><StatusGlyph status={x.status} />{x.key}</button>
  ))}</>
}

export function ItsaChips({ id, tabKey = id }: { id: string; tabKey?: string }) {
  useData()
  const xs = topOwned(getData().itsas, id)
  const wrap = useRef<HTMLSpanElement>(null)
  // The waits' own mode changes the room the chips have: follow it, so the chips measure again.
  useFit(tabKey)
  const fit = useTabFit(itsaFitKey(tabKey), xs.map((x) => x.id).join(), wrap)
  const { pop, setPop, open, popRef, badgeRef, toggle } = useBadgePop(wrap, fit === 'folded' && xs.length > 1)
  if (!xs.length || fit === 'none') return <span ref={wrap} className="itsa-chips" />
  // One ITSA is a chip already: its fold would only be a longer way to the same link.
  if (fit === 'each' || xs.length === 1) return <span ref={wrap} className="itsa-chips"><Chips xs={xs} /></span>
  const name = `${xs.length} ITSAs: ${xs.map((x) => x.key).join(', ')}`
  return <span ref={wrap} className="itsa-chips">
    <button ref={badgeRef} type="button" className={`ichip itsa-chip${xs.some(waitsOnHuman) ? ' waits' : ''}`} data-itsa="folded" title={name} aria-label={name} aria-haspopup="dialog" aria-expanded={open} {...stop} onClick={toggle}>{xs.length} ITSAs</button>
    {open && pop ? <PopPortal pop={pop} popRef={popRef} label={name} onClose={() => setPop(null)}>
      {xs.map((x) => <a key={x.id} href="#" className={waitsOnHuman(x) ? 'urgent' : ''} title={chipTitle(x)} data-itsa={x.id} onClick={(e) => { e.preventDefault(); openItsa(x.id) }}><StatusGlyph status={x.status} /> {x.key} {x.title}</a>)}
    </PopPortal> : null}
  </span>
}

// The active tab's thin bar (S-1659): under the tab bar, 18 px, shown when even one badge doesn't
// fit the tab (its fit is `none`). It holds the tab's per-kind badges in full; on a phone they
// inform, as in the strip. It holds waits only: a view's Reconnecting is its own line at the foot of the
// conversation (OwnView), on a desktop and on a phone, so one view shows it once.
export function WaitThinBar({ k }: { k?: string | null }) {
  useData()
  const phone = usePhone()
  const fit = useFit(k ?? undefined)
  const chipFit = useFit(k ? itsaFitKey(k) : undefined)
  // A story's key may carry a `#suffix` to keep its states apart; the agent is the part before it.
  const id = k && /^(agent|view):/.test(k) ? k.slice(k.indexOf(':') + 1).split('#')[0] : undefined
  const a = id ? byId(id) : undefined
  const ws = a && a.lifecycle === 'active' ? badgeWaits(a) : []
  const xs = id ? topOwned(getData().itsas, id) : []
  const showWaits = fit === 'none' && ws.length > 0, showChips = chipFit === 'none' && xs.length > 0
  if (!showWaits && !showChips) return null
  return <div className={`wait-thin${showChips ? ' has-chips' : ''}`}>{showWaits ? <KindBadges ws={ws} phone={phone} /> : null}{showChips ? <Chips xs={xs} /> : null}</div>
}

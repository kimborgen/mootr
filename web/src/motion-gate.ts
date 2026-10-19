// The motion gate (S-696): decides whether one kind of animation may run right now. A kind may
// animate when the master and its own toggle are on (Settings › Motion, kept in the human's
// settings so it follows Kim across devices), the browser doesn't ask for reduced motion, the
// element is on screen, and its scroll container isn't scrolling (or stopped under SCROLL_QUIET_MS
// ago). The system view is exempt: it doesn't call the gate. Later sidebar changes add a kind to
// MOTION_KINDS and call canAnimate (plain code) or useMotion (React); the settings page lists the
// kinds from that one array.
import { settingsRecord } from './settings-views'

export interface MotionKind { id: string; label: string; help: string }

export const MOTION_KINDS: MotionKind[] = [
  { id: 'stamps', label: 'Status stamps', help: 'The ring, ITSA chip, and unread badge animate when their state changes.' },
  { id: 'spend', label: 'Spend bar', help: 'The spend bar animates as the amount changes.' },
  { id: 'mail', label: 'Mail motion', help: 'Mail rows animate when mail arrives or is read.' },
  { id: 'issue-events', label: 'Issue events', help: 'A row animates when an event happens on its issue.' },
  { id: 'spawn-archive', label: 'Spawn and archive', help: 'Rows animate in when an agent spawns and out when it is archived.' },
]

// How long after the last scroll event a container still counts as scrolling.
export const SCROLL_QUIET_MS = 150
// The settings record id of the master toggle; each kind uses its own id.
export const MASTER = 'all'

// Stored as a record of id to boolean; absent means on.
const store = settingsRecord<boolean>({ field: 'motion', legacy: 'stam/motion', clean: (x) => x !== false })
let prefs: Record<string, boolean> = {}
const listeners = new Set<() => void>()
const emit = () => { for (const l of [...listeners]) l() }

export function subscribeMotion(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// Reads the stored toggles; until it resolves, everything counts as on.
let loading: Promise<Record<string, boolean>> | null = null
export function loadMotion(): Promise<Record<string, boolean>> {
  loading ??= store.load().then((all) => { prefs = { ...all, ...prefs }; emit(); return prefs }, (e) => { loading = null; throw e })
  return loading
}

export const motionPrefs = (): Record<string, boolean> => prefs
export const motionOn = (id: string): boolean => prefs[id] !== false

// Sets the master or one kind on this page now, and saves it to settings.
export function setMotion(id: string, on: boolean): void {
  prefs = { ...prefs, [id]: on }
  store.save(id, on)
  emit()
}

// For tests: replace the toggles without touching settings.
export function setMotionPrefs(next: Record<string, boolean>): void {
  prefs = { ...next }
  emit()
}

const REDUCE = '(prefers-reduced-motion: reduce)'
let mediaWatching = false
// The device setting can change while the page is open: tell subscribers when it does.
function watchMedia() {
  if (mediaWatching || typeof matchMedia !== 'function') return
  mediaWatching = true
  matchMedia(REDUCE).addEventListener?.('change', emit)
}

export function reducedMotion(): boolean {
  watchMedia()
  return typeof matchMedia === 'function' && matchMedia(REDUCE).matches
}

// --- Scrolling: the last scroll time of each element that scrolled. A capture listener on the
// document hears every container, as scroll events don't bubble.
const lastScroll = new WeakMap<EventTarget, number>()
let quietTimer: ReturnType<typeof setTimeout> | undefined
let scrollWatching = false

function watchScroll() {
  if (scrollWatching || typeof document === 'undefined') return
  scrollWatching = true
  document.addEventListener('scroll', (e) => {
    const target = e.target === document ? document.documentElement : e.target!
    const now = Date.now()
    const before = lastScroll.get(target)
    lastScroll.set(target, now)
    // Tell subscribers when this container starts scrolling, even if another is still inside its window.
    if (before === undefined || now - before >= SCROLL_QUIET_MS) emit()
    // And when the last one has stopped.
    clearTimeout(quietTimer)
    quietTimer = setTimeout(emit, SCROLL_QUIET_MS)
  }, { capture: true, passive: true })
}

// Whether el, or an ancestor, scrolled within the quiet window.
export function isScrolling(el: Element, now = Date.now()): boolean {
  for (let x: Element | null = el; x; x = x.parentElement) {
    const t = lastScroll.get(x)
    if (t !== undefined && now - t < SCROLL_QUIET_MS) return true
  }
  return false
}

// --- Visibility: one IntersectionObserver for every element watched.
const visible = new WeakMap<Element, boolean>()
let io: IntersectionObserver | null = null

// How many hooks watch each element, so one stopping doesn't unobserve it for another.
const watchers = new Map<Element, number>()

export function watchVisible(el: Element): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {}
  io ??= new IntersectionObserver((entries) => {
    for (const e of entries) visible.set(e.target, e.isIntersecting)
    emit()
  })
  const n = watchers.get(el) ?? 0
  watchers.set(el, n + 1)
  if (!n) io.observe(el)
  let done = false
  return () => {
    if (done) return
    done = true
    const left = (watchers.get(el) ?? 1) - 1
    if (left > 0) { watchers.set(el, left); return }
    watchers.delete(el)
    io?.unobserve(el)
    visible.delete(el)
  }
}

const outside = (r: DOMRect, b: { top: number; left: number; bottom: number; right: number }) =>
  r.bottom < b.top || r.top > b.bottom || r.right < b.left || r.left > b.right

// Whether el is on screen. The observer's answer when it has one; before its first answer (a row
// just mounted), one measurement against the viewport and each scroll container around it.
export function isVisible(el: Element): boolean {
  const seen = visible.get(el)
  if (seen !== undefined) return seen
  const r = el.getBoundingClientRect()
  if (outside(r, { top: 0, left: 0, bottom: innerHeight, right: innerWidth })) return false
  for (let x = el.parentElement; x; x = x.parentElement) {
    const o = getComputedStyle(x).overflowY
    if ((o === 'auto' || o === 'scroll' || o === 'hidden') && outside(r, x.getBoundingClientRect())) return false
  }
  return true
}

// The plain gate. Without an element, only the settings and reduced motion decide.
export function canAnimate(kind: string, el?: Element | null): boolean {
  if (!motionOn(MASTER) || !motionOn(kind) || reducedMotion()) return false
  if (!el) return true
  watchScroll()
  return isVisible(el) && !isScrolling(el)
}

// Starts watching scroll for canAnimate callers that never subscribe.
export const startMotionGate = watchScroll

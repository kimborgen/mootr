// The one context menu, and the one transient notice bar. The design system bans toast
// stacks: status renders at its source. What has no source on screen (a menu action's
// result) gets one bar at the top centre, which a newer notice replaces.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Icon } from '../Icon'

export type MenuItem =
  | 'sep'
  | { section: string }
  | { label: string; icon?: string; glyph?: ReactNode; hint?: string; title?: string; danger?: boolean; disabled?: boolean; action?: (r: DOMRect) => void
      // The entry opens another menu: announced as such.
      popup?: boolean
      // An option among others: true marks the current one, false the rest.
      checked?: boolean
      // A multi-select option (Columns): its ticked state is a checkbox, not a radio.
      checkbox?: boolean }

// A popover is a menu's surface holding content instead of items: a sheet on a phone too.
// `above`: y is the trigger's top, and the popover opens upward from it, capped to the room there.
interface MenuState { x: number; y: number; items: MenuItem[]; body?: ReactNode; label?: string; above?: boolean; trigger: Element | null; restore: Element | null }
let menu: MenuState | null = null
let notice: { text: string; err: boolean; n: number } | null = null
let v = 0
const ls = new Set<() => void>()
const bump = () => { v++; for (const fn of ls) fn() }
const useUi = () => useSyncExternalStore((fn) => { ls.add(fn); return () => { ls.delete(fn) } }, () => v)

// `restore` is where focus goes back to on Escape when it isn't the trigger or the focused element.
export function showMenu(x: number, y: number, items: MenuItem[], trigger?: Element | null, restore?: Element | null) {
  if (menu && trigger && menu.trigger === trigger) return hideMenu()
  menu = { x, y, items, trigger: trigger ?? null, restore: restore ?? trigger ?? document.activeElement }
  bump()
}
export function showPopover(x: number, y: number, label: string, body: ReactNode, trigger?: Element | null, above = false) {
  if (menu && trigger && menu.trigger === trigger) return hideMenu()
  menu = { x, y, items: [], body, label, above, trigger: trigger ?? null, restore: trigger ?? document.activeElement }
  bump()
}
export function hideMenu(restore = false) {
  if (!menu) return
  const back = menu.restore
  menu = null
  bump()
  if (restore) (back as HTMLElement | null)?.focus?.()
}
// Whether a menu is open, and a subscription for the browser history: a back press closes it.
export const menuOpen = () => !!menu
export function onMenuChange(fn: () => void) { ls.add(fn); return () => { ls.delete(fn) } }

// Eats the click the current touch makes; a touch that ends without one (a scroll) is
// forgotten at the next pointerdown. A sheet's scrim is only a shadow, so the tap that
// closes a sheet calls it: that tap only closes, it presses nothing under the scrim.
export function swallowNextClick() {
  const eat = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); off() }
  const off = () => { removeEventListener('click', eat, true); removeEventListener('pointerdown', off, true) }
  addEventListener('click', eat, true)
  addEventListener('pointerdown', off, true)
}

let timer = 0
export function toast(text: string, err = false) {
  notice = { text, err, n: (notice?.n ?? 0) + 1 }
  bump()
  clearTimeout(timer)
  timer = window.setTimeout(() => { notice = null; bump() }, err ? 7000 : 3500)
}

function Menu({ m }: { m: MenuState }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current!
    // Opens upward from the trigger, and shrinks to the room above it (the rows scroll inside).
    if (m.above) el.style.maxHeight = Math.max(120, Math.min(m.y - 12, innerHeight * 0.75)) + 'px'
    const r = el.getBoundingClientRect()
    el.style.left = Math.max(12, Math.min(m.x, innerWidth - r.width - 12)) + 'px'
    el.style.top = Math.max(12, m.above ? Math.min(m.y - r.height, innerHeight - r.height - 12) : Math.min(m.y, innerHeight - r.height - 12)) + 'px'
    const first = el.querySelector<HTMLButtonElement>('button[aria-checked=true]:not(:disabled)') ?? el.querySelector<HTMLButtonElement>('button:not(:disabled)')
    if (m.body) el.focus()
    else first?.focus()
  }, [m])
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target as Element
      if (!ref.current || ref.current.contains(t) || (m.trigger && m.trigger.contains(t))) return
      hideMenu()
      // On a phone the menu is a sheet over a scrim that is only a shadow, so the tap that
      // closes it lands on what lies under the scrim. That tap only closes; it presses nothing.
      if (e.pointerType === 'touch') swallowNextClick()
    }
    const blur = () => hideMenu()
    const id = setTimeout(() => { document.addEventListener('pointerdown', outside, true); addEventListener('blur', blur) })
    return () => { clearTimeout(id); document.removeEventListener('pointerdown', outside, true); removeEventListener('blur', blur) }
  }, [m])
  const key = (e: React.KeyboardEvent) => {
    const bs = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const at = bs.indexOf(document.activeElement as HTMLButtonElement)
    // Up and Down move between lines, options and date or number steps in these fields, so the menu
    // leaves them alone there; from a one-line text field (the Columns search) they still reach the items (S-1997).
    const t = e.target
    const steps = t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && /^(date|time|datetime-local|month|week|number|range)$/.test(t.type))
    if (e.key === 'ArrowDown' && !steps) { e.preventDefault(); bs[(at + 1) % bs.length]?.focus() }
    if (e.key === 'ArrowUp' && !steps) { e.preventDefault(); bs[(at - 1 + bs.length) % bs.length]?.focus() }
    // In a text field Home and End move the caret, so the menu leaves them to the browser.
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
    if (e.key === 'Home' && !typing) bs[0]?.focus()
    if (e.key === 'End' && !typing) bs[bs.length - 1]?.focus()
    // Esc closes the menu alone: an overlay under it (the Alt+A prompt) stays open.
    if (e.key === 'Escape') { e.stopPropagation(); hideMenu(true) }
  }
  // The browser's own menu never opens over ours, except in a text field, where it holds paste and spelling (S-2073).
  const context = (e: React.MouseEvent) => { if (!(e.target as Element).closest('input, textarea')) e.preventDefault() }
  if (m.body) return <div className="menu popover" role="dialog" aria-label={m.label} tabIndex={-1} ref={ref} onKeyDown={key} onContextMenu={context} style={{ left: m.x, top: m.y }}>{m.body}</div>
  return (
    <div className="menu" role="menu" ref={ref} onKeyDown={key} onContextMenu={context} style={{ left: m.x, top: m.y }}>
      {m.items.map((it, n) => {
        if (it === 'sep') return <hr key={n} />
        if ('section' in it) return [n > 0 ? <hr key={n + 'h'} /> : null, <div key={n} className="label eyebrow">{it.section}</div>]
        return (
          <button key={n} role={it.checked === undefined ? 'menuitem' : it.checkbox ? 'menuitemcheckbox' : 'menuitemradio'} aria-checked={it.checked} aria-haspopup={it.popup ? 'menu' : undefined} className={it.danger ? 'danger' : ''} disabled={!!it.disabled} title={it.title}
            onClick={() => { const r = ref.current!.getBoundingClientRect(); hideMenu(); it.action?.(r) }}>
            {it.glyph ?? (it.icon || it.checked === undefined ? <Icon name={it.icon ?? 'chevron-right'} /> : null)}<span className="ml">{it.label}</span>{it.hint ? <span className="kbd">{it.hint}</span> : null}
            {it.checked === undefined ? null : <span className={'tick' + (it.checked ? '' : ' off')}><Icon name="check" /></span>}
          </button>
        )
      })}
    </div>
  )
}

export function MenuLayer() {
  useUi()
  return (
    <>
      {menu ? <Menu m={menu} /> : null}
      <div id="toasts">{notice ? <div key={notice.n} className={'toast' + (notice.err ? ' err' : '')} role={notice.err ? 'alert' : 'status'}>{notice.text}</div> : null}</div>
    </>
  )
}

// The desktop sidebar body (S-1421): a vertical stack of panes, each with a tab strip and one tab's
// content showing. The layout is data (sidebar-panes.ts); TABS is the registry, so a new sidebar
// entry is one more id here. Every tab of a pane stays mounted (hidden when not showing), so a
// list keeps its scroll and state when you come back to it. The phone doesn't use this: it shows
// the sections one at a time from `st.mobile`.
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { openWorld } from './actions'
import { CostSide } from './CostSide'
import { Icon, type IconName } from './Icon'
import { MachinesSide } from './MachinesSide'
import { MailSide } from './MailSide'
import { HistorySide } from './HistorySide'
import { IssuesSide } from './itsa/IssuesSide'
import { ReqSide } from './req/ReqSide'
import { useShell } from './shell/layout'
import { activate, ariaRange, pairFrac, resizePair, resolveSizes, separatorKey, setSidebarPanes, setSidebarSizes, tabKey, useSidebarPanes } from './sidebar-panes'
import { Tree } from './Tree'

// `page` opens the tab's full page, when there is one; the nav bar reuses it through openTabPage.
// `shown`: the tab is on screen (its pane's active tab, and the sidebar open). Tabs that read data only while shown use it.
interface TabDef { label: string; icon: IconName; page?: () => void; render: (left: RefObject<HTMLElement | null>, shown: boolean) => ReactNode }

// The requirements list sits under the issues, in the issues tab: both are the work agents track.
export const TABS: Record<string, TabDef> = {
  agents: { label: 'Agents', icon: 'users', page: () => openWorld('agents'), render: () => <Tree /> },
  issues: { label: 'Issues', icon: 'list-checks', page: () => openWorld('work'), render: (left) => <><IssuesSide leftRef={left} pane /><ReqSide /></> },
  mail: { label: 'Mail', icon: 'mail', page: () => openWorld('inbox'), render: (left) => <MailSide leftRef={left} pane /> },
  history: { label: 'History', icon: 'clock', render: () => <HistorySide /> },
  cost: { label: 'Cost', icon: 'gauge', page: () => openWorld('usage'), render: (_left, shown) => <CostSide shown={shown} /> },
  machines: { label: 'Machines', icon: 'server', render: (_left, shown) => <MachinesSide pane shown={shown} /> },
}
// Opens a tab's full page; false when the tab has none.
export function openTabPage(id: string): boolean {
  const open = TABS[id]?.page
  if (open) open()
  return !!open
}
const KNOWN = Object.keys(TABS)

// The two panes a separator sits between, their heights, and the least each may keep (the CSS minimum).
function around(sep: HTMLElement) {
  const a = sep.previousElementSibling as HTMLElement, b = sep.nextElementSibling as HTMLElement
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
  return { a, b, start: ra.height, total: ra.height + rb.height, min: parseFloat(getComputedStyle(a).minHeight) || 0 }
}

export function SidebarPanes({ left }: { left: RefObject<HTMLElement | null> }) {
  const { panes, tabBar, sizes: stored } = useSidebarPanes(KNOWN)
  const { open } = useShell()
  const sizes = resolveSizes(stored, panes.length)
  const strips = useRef<Record<number, HTMLDivElement | null>>({})
  const root = useRef<HTMLDivElement>(null)
  // Each separator's share of its pair that a pane must keep, measured; it follows the sidebar's height.
  const [mins, setMins] = useState<number[]>([])
  useEffect(() => {
    const el = root.current
    if (!el) return
    const measure = () => {
      const next = [...el.querySelectorAll<HTMLElement>(':scope > .sep')].map((sep) => { const { total, min } = around(sep); return total > 0 ? min / total : 0 })
      setMins((old) => (old.length === next.length && old.every((v, k) => v === next[k]) ? old : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [panes.length, stored])
  // A click shows the tab in its pane, and opens the tab's page when it has one (S-1428). The sidebar keeps its panes while the page is open.
  const click = (i: number, id: string) => { pick(i, id); openTabPage(id) }
  const pick = (i: number, id: string) => setSidebarPanes(activate(panes, i, id))
  const key = (i: number, e: KeyboardEvent) => {
    const cur = (e.target as HTMLElement).closest<HTMLElement>('[role=tab]')?.dataset.tab
    const next = cur ? tabKey(panes[i].tabs, cur, e.key) : null
    if (!next) return
    e.preventDefault()
    pick(i, next)
    strips.current[i]?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus()
  }
  // The separator under pane `i`: the drag moves both panes live and saves once, on release.
  const drag = (i: number, e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const sep = e.currentTarget
    const { a, b, start, total, min } = around(sep)
    const y0 = e.clientY
    sep.setPointerCapture(e.pointerId)
    sep.classList.add('drag')
    let next = sizes
    // From where the pane's bottom edge was and how far the pointer went, so a press anywhere on the
    // gutter moves nothing until the pointer does.
    const move = (ev: globalThis.PointerEvent) => {
      next = resizePair(sizes, i, (start + ev.clientY - y0) / total, min / total)
      a.style.flex = `${next[i]} 1 0%`
      b.style.flex = `${next[i + 1]} 1 0%`
    }
    const end = (save: boolean) => {
      sep.classList.remove('drag')
      sep.removeEventListener('pointermove', move)
      sep.removeEventListener('pointerup', up)
      sep.removeEventListener('pointercancel', cancel)
      if (save && next !== sizes) setSidebarSizes(next)
      else if (!save) { a.style.flex = `${sizes[i]} 1 0%`; b.style.flex = `${sizes[i + 1]} 1 0%` }
    }
    const up = () => end(true)
    // A cancelled drag (the browser took the pointer) puts the panes back and saves nothing.
    const cancel = () => end(false)
    sep.addEventListener('pointermove', move)
    sep.addEventListener('pointerup', up)
    sep.addEventListener('pointercancel', cancel)
  }
  const sepKey = (i: number, e: KeyboardEvent<HTMLDivElement>) => {
    const { a, total, min } = around(e.currentTarget)
    const frac = a.getBoundingClientRect().height / total
    const to = separatorKey(frac, e.key, min / total)
    if (to === null) return
    e.preventDefault()
    const next = resizePair(sizes, i, to, min / total)
    if (next !== sizes) setSidebarSizes(next)
  }
  return <div className="side-panes" id="side-panes" data-tab-bar={tabBar} ref={root}>
    {panes.map((p, i) => <Fragment key={i}>
      {i > 0 ? <div className="sep h" role="separator" aria-orientation="horizontal" tabIndex={0} data-sep={i - 1}
        aria-label={`Resize ${TABS[panes[i - 1].active].label} and ${TABS[p.active].label}`}
        aria-valuemin={ariaRange(mins[i - 1] ?? 0).min} aria-valuemax={ariaRange(mins[i - 1] ?? 0).max} aria-valuenow={Math.round(100 * pairFrac(sizes, i - 1))}
        onPointerDown={(e) => drag(i - 1, e)} onKeyDown={(e) => sepKey(i - 1, e)} onDoubleClick={() => setSidebarSizes(null)} /> : null}
      <div className="side-pane" data-pane={i} style={{ flexGrow: sizes[i] }}>
      {p.tabs.length > 1 ? <div className="pane-tabs" role="tablist" aria-label="Sidebar" ref={(el) => { strips.current[i] = el }} onKeyDown={(e) => key(i, e)}>
        {p.tabs.map((id) => <button key={id} type="button" role="tab" id={`pane-tab-${id}`} data-tab={id} className="pane-tab" aria-selected={p.active === id}
          aria-controls={`pane-body-${id}`} tabIndex={p.active === id ? 0 : -1} onClick={() => click(i, id)}><Icon name={TABS[id].icon} size="xs" />{TABS[id].label}</button>)}
      </div> : null}
      {p.tabs.map((id) => <div key={id} className="pane-body" id={`pane-body-${id}`} role={p.tabs.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={p.tabs.length > 1 ? `pane-tab-${id}` : undefined} hidden={p.active !== id}>{TABS[id].render(left, open.left && p.active === id)}</div>)}
      </div>
    </Fragment>)}
  </div>
}

// The desktop sidebar body (S-1421): a vertical stack of panes, each with a tab strip and one tab's
// content showing. The layout is data (sidebar-panes.ts); TABS is the registry, so a new sidebar
// entry is one more id here. Every tab of a pane stays mounted (hidden when not showing), so a
// list keeps its scroll and state when you come back to it. The phone doesn't use this: it shows
// the sections one at a time from `st.mobile`.
import { useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { openWorld } from './actions'
import { CostSide } from './CostSide'
import { Icon, type IconName } from './Icon'
import { MachinesSide } from './MachinesSide'
import { MailSide } from './MailSide'
import { HistorySide } from './HistorySide'
import { IssuesSide } from './itsa/IssuesSide'
import { ReqSide } from './req/ReqSide'
import { activate, setSidebarPanes, tabKey, useSidebarPanes } from './sidebar-panes'
import { Tree } from './Tree'

// `page` opens the tab's full page, when there is one; the nav bar reuses it through openTabPage.
interface TabDef { label: string; icon: IconName; page?: () => void; render: (left: RefObject<HTMLElement | null>) => ReactNode }

// The requirements list sits under the issues, in the issues tab: both are the work agents track.
export const TABS: Record<string, TabDef> = {
  agents: { label: 'Agents', icon: 'users', page: () => openWorld('agents'), render: () => <Tree /> },
  issues: { label: 'Issues', icon: 'list-checks', page: () => openWorld('work'), render: (left) => <><IssuesSide leftRef={left} pane /><ReqSide /></> },
  mail: { label: 'Mail', icon: 'mail', page: () => openWorld('inbox'), render: (left) => <MailSide leftRef={left} pane /> },
  history: { label: 'History', icon: 'clock', render: () => <HistorySide /> },
  cost: { label: 'Cost', icon: 'gauge', page: () => openWorld('usage'), render: () => <CostSide /> },
  machines: { label: 'Machines', icon: 'server', render: () => <MachinesSide pane /> },
}
// Opens a tab's full page; false when the tab has none.
export function openTabPage(id: string): boolean {
  const open = TABS[id]?.page
  if (open) open()
  return !!open
}
const KNOWN = Object.keys(TABS)
// Taller panes first: the agents get the most room, then the mail, then the rest.
const GROW = [3, 2, 1]

export function SidebarPanes({ left }: { left: RefObject<HTMLElement | null> }) {
  const { panes, tabBar } = useSidebarPanes(KNOWN)
  const strips = useRef<Record<number, HTMLDivElement | null>>({})
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
  return <div className="side-panes" id="side-panes" data-tab-bar={tabBar}>
    {panes.map((p, i) => <div className="side-pane" key={i} data-pane={i} style={{ flexGrow: GROW[i] ?? 1 }}>
      {p.tabs.length > 1 ? <div className="pane-tabs" role="tablist" aria-label="Sidebar" ref={(el) => { strips.current[i] = el }} onKeyDown={(e) => key(i, e)}>
        {p.tabs.map((id) => <button key={id} type="button" role="tab" id={`pane-tab-${id}`} data-tab={id} className="pane-tab" aria-selected={p.active === id}
          aria-controls={`pane-body-${id}`} tabIndex={p.active === id ? 0 : -1} onClick={() => click(i, id)}><Icon name={TABS[id].icon} size="xs" />{TABS[id].label}</button>)}
      </div> : null}
      {p.tabs.map((id) => <div key={id} className="pane-body" id={`pane-body-${id}`} role={p.tabs.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={p.tabs.length > 1 ? `pane-tab-${id}` : undefined} hidden={p.active !== id}>{TABS[id].render(left)}</div>)}
    </div>)}
  </div>
}

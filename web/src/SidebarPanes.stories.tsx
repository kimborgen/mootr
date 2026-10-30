import { SidebarPanes, TABS } from './SidebarPanes'
import { DEFAULT_PANES, setSidebarPanes, setSidebarSizes, setTabBar } from './sidebar-panes'
import { ds, type Story } from './stories/types'

const left = { current: null }
const column = () => <div className="tree-side" style={{ width: '100%', height: 560, display: 'flex', flexDirection: 'column' }}><SidebarPanes left={left} /></div>
const layout = (panes: typeof DEFAULT_PANES, tabBar: 'compact' | 'regular' = 'compact', sizes: number[] | null = null) => () => { setSidebarPanes(panes); setTabBar(tabBar); setSidebarSizes(sizes) }

export const stories: Story[] = [{
  name: 'Sidebar panes',
  group: 'Tree and shell',
  what: 'The body of the desktop left sidebar: a vertical stack of panes. A pane with two or more tabs has a tab strip and shows one tab\'s list; a pane with one tab has no strip and shows that list with its own header. The default layout is Agents and Issues in the first pane, Mail with History in the second, and Cost with Machines in the third (Cost showing). Requirements sit under the issues, in the Issues tab.',
  when: 'The left sidebar on a desktop (above 760 px). A phone does not draw panes: it shows Agents, Mail, and Issues one at a time from the bottom navigation. The layout is kept in settings as `sidebarPanes`, so it follows the human to every device; a tab id the page does not know is dropped, and a tab left out of the layout is not shown.',
  code: ['web/src/SidebarPanes.tsx#SidebarPanes', 'web/src/SidebarPanes.tsx#TABS'],
  rules: [
    'Tabs are `role="tab"` in a `role="tablist"`; the showing tab has `tabindex` 0 and the rest -1. ArrowRight and ArrowLeft move to the next and previous tab, wrapping, and Home and End jump to the first and last; the moved-to tab shows and takes focus.',
    'Clicking or arrowing to a tab shows it and keeps the choice in settings; clicking the showing tab opens that tab\'s full page when it has one (Issues opens the Work page, Mail the Inbox page, Cost the Usage page). Every tab of a pane stays mounted and is hidden when not showing, so a list keeps its scroll.',
    'The tab strip is `--size-pane-tab-compact`, half of `--size-tab-bar`, by default; the setting `tabBar: "regular"` makes it `--size-tab-bar`. The showing tab takes `--tab-bg-active` and a 2 px `--tab-indicator-focused` line (' + ds('Density') + ').',
    'Panes share the height by ratio, 3, 2, 1 until the human drags (a pane past the third weighs 1), with a `--size-side-pane-min` minimum; each pane scrolls its own list. Between two panes sits a separator (`role="separator"`, `aria-orientation="horizontal"`, focusable, `aria-valuenow` the upper pane\'s percent of the pair). Dragging it with a mouse, pen, or finger moves the two panes live and saves the ratios once, on release; neither pane goes below the minimum. Up and Down (or Left and Right) step 5% of the pair, Home and End go to the limits, and a double-click resets every pane to 3/2/1. The ratios are kept in settings with the layout, so they follow the human to every desktop and survive a reload; a record without ratios, or whose count differs from the panes, takes 3/2/1.',
  ],
  states: [
    { name: 'Default layout', setup: layout(DEFAULT_PANES), render: column },
    { name: 'Issues tab showing', setup: layout([{ tabs: ['agents', 'issues'], active: 'issues' }, DEFAULT_PANES[1], DEFAULT_PANES[2]]), render: column },
    { name: 'Resized panes', setup: layout(DEFAULT_PANES, 'compact', [1, 4, 1]), render: column },
    { name: 'Regular tab strip', setup: layout(DEFAULT_PANES, 'regular'), render: column },
    { name: 'Every tab in one pane', setup: layout([{ tabs: Object.keys(TABS), active: 'mail' }]), render: column },
  ],
}]

import { SidebarPanes, TABS } from './SidebarPanes'
import { DEFAULT_PANES, setSidebarPanes, setTabBar } from './sidebar-panes'
import { ds, type Story } from './stories/types'

const left = { current: null }
const column = () => <div className="tree-side" style={{ width: '100%', height: 560, display: 'flex', flexDirection: 'column' }}><SidebarPanes left={left} /></div>
const layout = (panes: typeof DEFAULT_PANES, tabBar: 'compact' | 'regular' = 'compact') => () => { setSidebarPanes(panes); setTabBar(tabBar) }

export const stories: Story[] = [{
  name: 'Sidebar panes',
  group: 'Tree and shell',
  what: 'The body of the desktop left sidebar: a vertical stack of panes. A pane with two or more tabs has a tab strip and shows one tab\'s list; a pane with one tab has no strip and shows that list with its own header. The default layout is Agents and Issues in the first pane, Mail in the second, and Cost with Machines in the third (Cost showing). Requirements sit under the issues, in the Issues tab.',
  when: 'The left sidebar on a desktop (above 760 px). A phone does not draw panes: it shows Agents, Mail, and Issues one at a time from the bottom navigation. The layout is kept in settings as `sidebarPanes`, so it follows the human to every device; a tab id the page does not know is dropped, and a tab left out of the layout is not shown.',
  code: ['web/src/SidebarPanes.tsx#SidebarPanes', 'web/src/SidebarPanes.tsx#TABS'],
  rules: [
    'Tabs are `role="tab"` in a `role="tablist"`; the showing tab has `tabindex` 0 and the rest -1. ArrowRight and ArrowLeft move to the next and previous tab, wrapping, and Home and End jump to the first and last; the moved-to tab shows and takes focus.',
    'Clicking or arrowing to a tab shows it and keeps the choice in settings; clicking the showing tab opens that tab\'s full page when it has one (Issues opens the Work page). Every tab of a pane stays mounted and is hidden when not showing, so a list keeps its scroll.',
    'The tab strip is `--size-pane-tab-compact`, half of `--size-tab-bar`, by default; the setting `tabBar: "regular"` makes it `--size-tab-bar`. The showing tab takes `--tab-bg-active` and a 2 px `--tab-indicator-focused` line (' + ds('Density') + ').',
    'Panes share the height by weight (3, 2, 1) with a `96px` minimum; each pane scrolls its own list. The lists have no resize separator or fold of their own inside a pane.',
  ],
  states: [
    { name: 'Default layout', setup: layout(DEFAULT_PANES), render: column },
    { name: 'Issues tab showing', setup: layout([{ tabs: ['agents', 'issues'], active: 'issues' }, DEFAULT_PANES[1], DEFAULT_PANES[2]]), render: column },
    { name: 'Regular tab strip', setup: layout(DEFAULT_PANES, 'regular'), render: column },
    { name: 'Every tab in one pane', setup: layout([{ tabs: Object.keys(TABS), active: 'mail' }]), render: column },
  ],
}]

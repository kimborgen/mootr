import { DEFAULT_PANES, setSidebarPanes, setTabBar } from '../sidebar-panes'
import { ds, type Story } from '../stories/types'
import { SidebarSettings } from './SidebarSettings'

const layout = (panes: typeof DEFAULT_PANES, tabBar: 'compact' | 'regular' = 'compact') => () => { setSidebarPanes(panes); setTabBar(tabBar) }

export const stories: Story[] = [{
  name: 'Sidebar settings',
  group: 'Settings',
  what: 'Settings › Sidebar: the panes of the desktop sidebar top to bottom, the tabs each holds in order, each pane\'s default tab, the tab bar height, and the tabs no pane holds.',
  when: 'Settings, in the Sidebar section. The section also shows on a phone, which ignores the layout and shows its sections one at a time.',
  code: ['web/src/views/SidebarSettings.tsx#SidebarSettings', 'web/src/sidebar-panes.ts#movePane'],
  rules: [
    'Every edit applies at once and is saved as `sidebarPanes` through the same path as picking a tab in the sidebar; there is no drag and drop, so everything works from the keyboard.',
    'Per pane: move up, move down, remove (its tabs become unused). Per tab: move up or down, move to another pane or a new pane, remove to unused, and a radio that picks the pane\'s default tab.',
    'A pane left with no tab is dropped, there are at most four panes, and the last pane and the last tab can\'t be removed.',
    'Tab bar height is a choice of compact or regular; the defaults row has **Save current as my default**, **Revert to my default** (disabled until one is saved) and **Revert to mootr\'s default** (3 panes of 2 tabs, compact strip). A revert replaces the whole live layout and touches no other setting; the saved default is a separate record that live edits never change.',
    'Controls are touch height (`--size-hit-touch`) on a phone (' + ds('Density') + ').',
  ],
  states: [
    { name: 'Default layout', setup: layout(DEFAULT_PANES), render: () => <SidebarSettings /> },
    { name: 'Unused tab and regular strip', setup: layout([{ tabs: ['agents', 'issues'], active: 'issues' }, DEFAULT_PANES[1]], 'regular'), render: () => <SidebarSettings /> },
  ],
}]

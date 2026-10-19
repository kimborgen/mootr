import { MainWorld } from './MainWorld'
import { AGENTS } from '../stories/fixtures'
import { rapidThreads } from '../stories/mailFixtures'
import { setRapid } from '../views/rapid'
import { pane, seedShell } from '../stories/shell'
import { sse, ds, type Story } from '../stories/types'
import { ViewPortals } from '../views/registry'
import type { Agent } from '../types'

// Main, drawn as the app draws it: inside the centre column, at a pane's height.
const Main = () => <div id="center" style={{ height: 420 }}><MainWorld /><ViewPortals /></div>

const world = (agent: string, root: Parameters<typeof seedShell>[0]['worlds'][string]) => seedShell({ current: agent, worlds: { [agent]: root } })
const split = (dir: 'row' | 'col', ...tabs: string[]) => ({
  root: { id: 's1', split: dir, sizes: tabs.map(() => 1), children: tabs.map((t, i) => ({ id: 'p' + i, tabs: [t], active: t })) },
  focused: 'p0',
})
// An agent with stam's view of its conversation, so its pane gets the switch.
const WITH_VIEW: Agent[] = AGENTS.map((a) => (a.id === 'fx-dev' ? { ...a, view: { can_stream: true, can_send: true, can_interrupt: true, can_approve: true } } : a))
const viewRoute = { 'GET /api/agents/fx-dev/view': sse([{ type: 'state', state: { agent: 'fx-dev', harness: 'claude', capabilities: { can_stream: true, can_send: true, can_interrupt: true, can_approve: true }, running: false, messages: [], permissions: [], older: null } }]) }

const one = world('fx-dev', pane('p0', ['details:fx-dev']))
const tabs = world('fx-dev', pane('p0', ['details:fx-dev', 'details:fx-review', 'details:fx-ops']))
const waiting = world('fx-dev', pane('p0', ['agent:fx-dev', 'agent:fx-review', 'agent:fx-ops', 'agent:fx-wait']))
const row = world('fx-dev', split('row', 'details:fx-dev', 'details:fx-review'))
const col = world('fx-dev', split('col', 'details:fx-dev', 'details:fx-review'))
const empty = world('fx-dev', pane('p0', []))
const sw = world('fx-dev', pane('p0', ['view:fx-dev']))
const agentOne = world('fx-dev', pane('p0', ['agent:fx-dev']))
const none = seedShell({ current: null, worlds: {} })

export const stories: Story[] = [{
  name: 'Main world',
  group: 'Tree and shell',
  what: "The current world's layout in the centre of the app. A split holds panes side by side or stacked, with a separator between them; a pane holds a tab strip and its views. Tabs drag between panes, an agent dragged in from the tree opens as a tab, and a drop on a pane's edge splits it that way. An agent's world starts as one pane with its terminal or conversation.",
  when: "Always, in `#w-main`, for whichever world is current: an agent's, a mail thread's, Settings, Usage, an ITSA. Selecting an agent in the tree, or an agent sending you somewhere, changes the world; the layout belongs to the daemon and is shared by every device, while which world each device shows is its own.",
  code: ['web/src/shell/MainWorld.tsx#MainWorld', 'web/src/shell/MainWorld.tsx#ViewSwitch', 'web/src/shell/Tab.tsx#Tab', 'web/src/shell/Tab.tsx#TabBar'],
  rules: [
    'The tab strip is `--size-tab-bar` (36 px) high on a desktop and `--size-hit-touch` plus its 1 px border on a phone. A tab (`shell/Tab.tsx`: glyph, title, chips, close, plus an actions slot at the strip\'s end) shows the view\'s icon, a title, a badge in the chips slot, and a close button that appears on hover. An agent\'s terminal, conversation and rapid-fire tabs are titled with its name only; details and instructions keep their suffix. Tabs split the strip evenly down to `--size-tab-min` (120 px, 96 px on a phone), then scroll; the active tab of the focused pane carries `--tab-indicator-focused`. The strip scrolls sideways with the wheel when it overflows.',
    'The strip hides when a world shows one thing (one pane with one tab); "Show tab bar" in the pane menu overrides, and an agent that has both a terminal and a conversation always shows it, for the switch between them (' + ds('Tabs and pane header') + ').',
    'A split\'s children share its width or height in proportion to their sizes, and a separator drags between neighbours, never shrinking either below 60 px. The pane the pointer last pressed is focused.',
    'On a phone (760 px and below) main shows only the focused pane, and its strip lists every tab in the world and ends with a menu button (the pane menu, since there is no hover or right-click). A terminal adds a keyboard button; a mail thread adds Archive; an open conversation adds Stop while its turn runs.',
    'The terminal and conversation switch is a segmented control of icons only on a desktop (a tooltip and an `aria-label` name each choice, the pressed one is accent-filled), at the right end of the tab strip, and one button that shows the other view on a phone. Choosing it replaces the tab in the same place and is remembered for that agent.',
    'The conversation\'s rapid-fire mode (S-1004) is the switch\'s third choice on a desktop, and on a phone a ⚡ toggle beside it while the conversation shows, accent-subtle when on (`.icon-btn.on`). It is remembered per agent on this device.',
    'A staged image\'s tab (`image:PAGE.N`, S-1475) belongs to the page that opened it: the layout is shared with the human\'s other devices, so a page hides the image tabs it has no images for, in the strip and in a phone\'s strip, and never closes them.',
    'An agent\'s tab carries its waits as badges (`shell/Tab` chips, `waits.tsx#WaitBadges`), one per kind: an icon and a count, or the time left for a timer (`4m`, then `45s`). A tight tab folds them into one combined badge, and a desktop click on it opens the list of waits (a popover). On a desktop a click on a badge opens what it waits on and never selects the tab; on a phone a badge only informs (its tap target would be under 44 px), and the details list holds the links; the waiting bar under the app header is gone. After the badges, the tab carries chips for the ITSAs its agent owns at the top (`waits.tsx#ItsaChips`, S-1452), which give way to the waits and fold into an `N ITSAs` pill; see the Agent tab ITSA chips story. When even one badge does not fit, the active tab\'s thin bar under the strip (`waits.tsx#WaitThinBar`, `--size-tab-bar-thin`) holds them, A view\'s Reconnecting stays in the view.',
    'An agent\'s world always shows its tab bar, even with one tab, because the bar carries the agent\'s waits.',
    'A tab moves only within its own area: dropping it in another world toasts "Tabs move only within their own area." A drop on an edge previews the new split with `--split-preview-fill`.',
  ],
  states: [
    { name: 'No agent selected', data: { agents: AGENTS }, ...none, render: Main },
    { name: 'One tab', data: { agents: AGENTS }, ...one, render: Main },
    { name: 'One agent tab, with its tab bar', data: { agents: AGENTS }, ...agentOne, render: Main },
    { name: 'Several tabs', data: { agents: AGENTS }, ...tabs, render: Main },
    { name: 'Tabs with wait badges', data: { agents: AGENTS }, ...waiting, render: Main },
    { name: 'Split side by side', data: { agents: AGENTS }, ...row, render: Main },
    { name: 'Split stacked', data: { agents: AGENTS }, ...col, render: Main },
    { name: 'Empty pane', data: { agents: AGENTS }, ...empty, render: Main },
    { name: 'Terminal and conversation switch', data: { agents: WITH_VIEW }, ...sw, routes: { ...sw.routes, ...viewRoute }, setup: () => { setRapid('fx-dev', false); sw.setup() }, render: Main },
    { name: 'Rapid-fire mode', data: { agents: WITH_VIEW, humanThreads: rapidThreads(8) }, ...sw, setup: () => { setRapid('fx-dev', true); sw.setup() }, render: Main },
  ],
}]

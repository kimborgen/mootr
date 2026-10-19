import { HistorySide } from './HistorySide'
import { HISTORY_MAX, type HistoryState } from './history-model'
import type { Story } from './stories/types'
import { ds } from './stories/types'

const list = (keys: string[], marker = keys.length - 1): HistoryState => ({ entries: keys.map((key, pos) => ({ key, pos })), marker })
const side = (state: HistoryState, width = '100%') => () => <div className="tree-side" style={{ width, height: 280, display: 'flex', flexDirection: 'column' }}><HistorySide state={state} /></div>
const SOME = ['w:work', 'fx-dev', 'w:config', 'fx-review', 'w:usage', 'fx-ops']

export const stories: Story[] = [{
  name: 'History',
  group: 'Tree and shell',
  what: 'The things you showed in main, newest on top, one row each: an agent, a thread, an issue, or a page (Work, Settings, Usage, System, and so on), with its icon and name as the sidebar shows them elsewhere. The one showing is marked. A row jumps there, as pressing back or forward that many times would; the list stays where it is. A thing that no longer exists stays in the list, dimmed, and is skipped by back and forward.',
  when: 'The History tab of the sidebar, in the Mail pane by default (the layout is synced; the list is not). On a phone it is the History switch on the Mail tab\'s row of switches. Search, menus, the image viewer and the assistant add no entries.',
  code: ['web/src/HistorySide.tsx#HistorySide', 'web/src/history-model.ts#visit', 'web/src/nav-history.ts#jumpToEntry'],
  rules: [
    'One entry per thing: changing its view mode, Settings section or Usage tab updates the entry in place, and showing the current thing again adds nothing.',
    'Going back moves the marker down the list and forward moves it up; a new visit after going back prunes the entries above the marker, then goes on top.',
    'Kept per browser tab, up to ' + HISTORY_MAX + ' entries, with no persistence. It reads the browser\'s own history (`nav-history.ts`), so back on the mouse, the phone and the browser agree with it.',
    'Rows are `--size-row-tree` tall, `--size-hit-touch` on a phone, and the marked row uses the selected-row colours (' + ds('Density') + ').',
    'A dead entry is dimmed with the word `gone` and can\'t be opened; a dead entry is never shown by dimming alone, the row also says `gone` (' + ds('State vocabulary') + ').',
    'An empty list says where entries come from, never a blank pane (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: 'Empty', render: side(list([])) },
    { name: 'Marker in the middle', render: side(list(SOME, 3)) },
    { name: 'A dead entry', render: side(list(['w:work', 'gone-agent', 'fx-dev', 'w:itsa:gone-issue', 'w:usage'], 4)) },
    { name: 'Phone width', render: side(list(SOME, 5), '390px') },
    { name: 'At the cap', render: side(list(Array.from({ length: HISTORY_MAX }, (_, i) => (i % 2 ? 'w:work' : 'fx-dev')), 20)) },
  ],
}]

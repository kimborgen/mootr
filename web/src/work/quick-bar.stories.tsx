import { useState } from 'react'
import { ds, type Story } from '../stories/types'
import { QuickBar } from './quick-bar'
import { toggleQuick, type QuickId } from './quick'

function Bar({ start = [], phone = false }: { start?: QuickId[]; phone?: boolean }) {
  const [on, setOn] = useState<QuickId[]>(start)
  return <div className="work-view" style={{ height: 120 }}><QuickBar className={phone ? 'wg-quick' : ''} on={on} onToggle={(id) => setOn((cur) => toggleQuick(cur, id))} /></div>
}

export const stories: Story[] = [{
  name: 'Work quick filters',
  group: 'ITSA and work',
  what: 'Six one-tap toggles for the Work page: Waiting on you (a status that waits on the human), Mine (the human owns it or takes part), Stale (active, no update in 2 days), Blocked, In review (the review category), and Has PR (a GitHub pull request link). Each is a named preset; the ones on combine with AND, and with the column filters.',
  when: 'A "Quick" row under the Work bar on the desktop table, and a row under the header of the glance on a phone or a pane under 900 px. The layout keeps which are on, so a saved view carries them.',
  code: ['web/src/work/quick-bar.tsx#QuickBar', 'web/src/work/quick.ts#QUICK', 'web/src/work/quick.ts#quickKeeps', 'web/src/work/views.ts#setQuick'],
  rules: [
    'A chip is a toggle button (`aria-pressed`); on, it takes `--accent-subtle` with `--accent-text` and an `--accent` border, off it is a hairline `--border-default` chip (' + ds('State vocabulary') + ').',
    'On the phone every chip is at least `--size-hit-touch` (44 px) tall and the row scrolls sideways without a scrollbar; the "Quick" label is left out there (' + ds('Touch targets') + ').',
    'Stale reads `updated_at`, which moves on status and field changes, not on comments.',
    'A chip on counts in "N of M", in the phone Filter button\'s badge, and in whether the glance shows the list of matches. Clear all removes them with the column filters. Needs you is never filtered.',
  ],
  states: [
    { name: 'Desktop, none on', render: () => <Bar /> },
    { name: 'Desktop, two on', render: () => <Bar start={['waiting', 'pr']} /> },
    { name: 'Phone, one on', render: () => <Bar start={['mine']} phone /> },
  ],
}]

import { useState } from 'react'
import { ds, type Story } from '../stories/types'
import { ViewTabs } from './view-tabs'

const VIEWS = [{ id: 'v1', name: 'Review queue' }, { id: 'v2', name: 'By agent' }, { id: 'v3', name: 'Stale and blocked' }]

function Strip({ start = '', dirty = false, many = false }: { start?: string; dirty?: boolean; many?: boolean }) {
  const [cur, setCur] = useState(start)
  const views = many ? [...VIEWS, ...VIEWS.map((v) => ({ id: v.id + 'b', name: v.name + ' (copy)' })), ...VIEWS.map((v) => ({ id: v.id + 'c', name: v.name + ' (old)' }))] : VIEWS
  return <div className="work-view" style={{ height: 80, width: many ? 520 : undefined }}><ViewTabs views={views} current={cur} dirty={dirty} onPick={setCur} /></div>
}

export const stories: Story[] = [{
  name: 'Work view tabs',
  group: 'ITSA and work',
  what: 'The saved Work views as a tab strip over the table: Default first, then each saved view in the order it was saved. One click switches the view; the current tab has an accent underline, and a dot on it means the layout was edited after the view was saved.',
  when: 'Under the Work bar on the desktop table. A phone, or a pane under 900 px, has the view picker in the glance header instead (see the Work glance story). Save (overwrite the current view), Revert (drop the edits), Save as… and Delete are in the View menu.',
  code: ['web/src/work/view-tabs.tsx#ViewTabs', 'web/src/work/views.ts#isDirty', 'web/src/work/views.ts#saveView', 'web/src/work/views.ts#revertView'],
  rules: [
    'The strip is a `tablist`: the current tab is `aria-selected` and the only one in the tab order; the arrow keys, Home and End move focus between tabs, and Enter or Space switches (' + ds('State vocabulary') + ').',
    'A view is edited when its columns, order, grouping, Open or All, sort, column filters or quick filters differ from what was saved; a column width never marks it. The dot is `--accent`, with the label "Edited since saved". Default is edited when it differs from the default layout.',
    'Save is off on Default, which only Save as can keep, and on a view that is as saved. Revert is off on a view that is as saved.',
    'The strip scrolls sideways without a scrollbar when the views do not fit; a tab is `--space-8` tall and its name does not wrap (' + ds('Tables, tree, and empty states') + ').',
  ],
  states: [
    { name: 'Default current', render: () => <Strip /> },
    { name: 'A saved view current, edited (the dot)', render: () => <Strip start="v1" dirty /> },
    { name: 'Many views, scrolling sideways', render: () => <Strip start="v2" many /> },
  ],
}]

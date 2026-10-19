import { useState } from 'react'
import { ds, type Story } from '../stories/types'
import { FilterEditor } from './filter-editors'
import type { ColFilter, FilterKind, FilterValue } from './sortfilter'

const STATUSES: FilterValue[] = [
  { value: 'in_progress', label: 'In progress', n: 8 }, { value: 'in_review', label: 'In review', n: 3 },
  { value: 'testing', label: 'Testing', n: 2 }, { value: 'blocked', label: 'Blocked', n: 1 }, { value: '', label: '(Blank)', n: 4 },
]

// An editor with its own state, as the header menu holds it: the filter it reports is the one it shows.
function Live({ kind, start = null, options = [] }: { kind: FilterKind; start?: ColFilter | null; options?: FilterValue[] }) {
  const [f, setF] = useState<ColFilter | null>(start)
  return <div className="menu popover" style={{ position: 'static' }}><div className="rm"><FilterEditor kind={kind} filter={f} options={options} onChange={setF} /></div></div>
}

export const stories: Story[] = [{
  name: 'Work filter editors',
  group: 'ITSA and work',
  what: 'The filter editor in a Work column\'s header menu, one for each kind of filter: a checklist of values with counts and a search box, text that a cell contains, a min and max range, date presets with a from and to day, has or has none, and Yes or No. Each edit applies at once; an edit that leaves nothing filtered removes the filter.',
  when: 'In the popover the header\'s ▾ button opens (Alt and the down arrow on a focused header), under the sort items, and from a filter token in the active-filter row. A column with two kinds (Branch: has or text) shows a switch between them.',
  code: ['web/src/work/filter-editors.tsx#FilterEditor', 'web/src/work/filter-editors.tsx#ValuesEditor', 'web/src/work/filter-editors.tsx#TextEditor', 'web/src/work/filter-editors.tsx#RangeEditor', 'web/src/work/filter-editors.tsx#DateEditor', 'web/src/work/filter-editors.tsx#HasEditor', 'web/src/work/filter-editors.tsx#CheckEditor', 'web/src/work/header-menu.tsx#HeaderMenuBody', 'web/src/work/sortfilter.ts#ColFilter'],
  rules: [
    'The values checklist starts with every value ticked, which is no filter; unticking one hides it as an exclude rule (so a value that appears later shows), and ticking it again removes the filter. Inside an include list (Filter to this value) unticking stays an include list. A row with no value is "(Blank)". All and None act on the values the search shows.',
    'A standing exclude rule (Exclude this value on a cell, or unticking with no filter) reads in the same checklist: the excluded values are unticked and every other value, including one that first appears later, is ticked. A row listing several values (agents) is hidden when any one is excluded. Its token reads `Status ≠ Blocked`.',
    'Rows are the menu\'s checklist rows (`.rm-row`): the label, the count in `--text-muted`, and the tick on the right (' + ds('Menus') + '). Inputs and the From and To fields are the menu\'s search field. Only design tokens.',
    'Home and End in the Search values box move the caret to the start and end of the text; they don\'t jump to the first and last row of the menu.',
    'Choosing the chosen preset or choice again clears it. A number field keeps what is typed and filters once it parses.',
  ],
  states: [
    { name: 'Values, nothing filtered', render: () => <Live kind="values" options={STATUSES} /> },
    { name: 'Values, two ticked', render: () => <Live kind="values" options={STATUSES} start={{ kind: 'values', values: ['in_review', 'testing'] }} /> },
    { name: 'Values, an exclude rule (Blocked hidden)', render: () => <Live kind="values" options={STATUSES} start={{ kind: 'values', not: ['blocked'] }} /> },
    { name: 'Text', render: () => <Live kind="text" start={{ kind: 'text', q: 'stam/' }} /> },
    { name: 'Range', render: () => <Live kind="range" start={{ kind: 'range', min: 1 }} /> },
    { name: 'Date, a preset and a from day', render: () => <Live kind="date" start={{ kind: 'date', preset: '7d', from: '2026-10-01' }} /> },
    { name: 'Has', render: () => <Live kind="has" start={{ kind: 'has', has: true }} /> },
    { name: 'Yes or No', render: () => <Live kind="check" /> },
  ],
}]

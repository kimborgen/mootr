import { useEffect } from 'react'
import { SvStage } from '../stories/system'
import { ds, type Story } from '../stories/types'
import { FindBox, FindButton, FindDrop, useFind } from './Find'
import type { Findable } from './scale'

// Eight agents in the tree's order, with the ITSAs each owns.
const ENTRIES: Findable[] = [
  { id: 'f-cos', name: 'fixture-cos', itsas: [{ key: 'FX-1', title: 'Fixture epic: a faster tree' }] },
  { id: 'f-dev', name: 'fixture-dev', itsas: [{ key: 'FX-2', title: 'Lay out the tree' }] },
  { id: 'f-dev2', name: 'fixture-dev-two', itsas: [{ key: 'FX-6', title: 'Fold the managers' }] },
  { id: 'f-review', name: 'fixture-review', itsas: [{ key: 'FX-3', title: 'Review the layout' }] },
  { id: 'f-ops', name: 'fixture-ops', itsas: [{ key: 'FX-4', title: 'Deploy the preview' }] },
  { id: 'f-search', name: 'fixture-search', itsas: [{ key: 'FX-7', title: 'Search the system view' }] },
  { id: 'f-broken', name: 'fixture-broken', itsas: [] },
  { id: 'f-paused', name: 'fixture-paused', itsas: [] },
]

// Find as the view wires it: the button, the box once open, and the drop over the stage. `q` is what
// has been typed by the time the state draws; `narrow` is the phone's, where the box sits in the drop.
function FindDemo({ q, narrow = false, open = !!q }: { q: string; narrow?: boolean; open?: boolean }) {
  const f = useFind(ENTRIES, () => {})
  useEffect(() => { if (open) { f.set(q); f.show(true) } }, [])
  return <>
    <div style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', alignItems: 'center' }}>
      {!narrow && f.open ? <FindBox f={f} autoFocus /> : <FindButton f={f} label={!narrow} />}
    </div>
    <FindDrop f={f} narrow={narrow} />
  </>
}
const demo = (q: string, o: { narrow?: boolean; open?: boolean } = {}) => <SvStage world={false} height={260}>{() => <FindDemo q={q} {...o} />}</SvStage>

export const stories: Story[] = [{
  name: 'Find in the system view',
  group: 'System view',
  what: 'Find an agent in the system view by name, or by the key or title of an ITSA it owns. A button in the header opens a box; matches drop over the stage, best first, each with the agent\'s name and, when an ITSA matched, its key and title. Picking one shows its card: the view zooms to it (the phone\'s canvas pans to it), unfolding the managers above it, and opens its details.',
  when: 'The **Find** button in the `w:system` header (an icon on a phone, an icon and a word on a desktop). On a desktop the box takes the header\'s room while it is open and the instruments it hides come back when it closes; on a phone it opens over the top of the stage. The drop shows once something is typed.',
  code: ['web/src/system/Find.tsx#useFind', 'web/src/system/Find.tsx#FindBox', 'web/src/system/Find.tsx#FindButton', 'web/src/system/Find.tsx#FindDrop'],
  rules: [
    'Ranking, best first: a name that starts with the text, a name holding every word typed, an ITSA key (exact, or a prefix once a digit is typed), then an ITSA title holding every word. Case is ignored, ties keep the tree\'s order, and at most 8 show.',
    'Only open ITSAs an agent owns are searched. Nothing matching says so in plain muted text, naming what was typed (' + ds('Empty, loading, and error') + ').',
    'The box is a combobox: the arrow keys move the highlight (wrapping), Enter picks, Escape clears and closes. A press on a result keeps the box\'s focus, so its blur doesn\'t close the list before the click lands.',
    'On a phone the box and the results sit in a sheet at the top of the stage, with the box and each result at least `--size-hit-touch` tall; on a desktop the drop is a menu (`--menu-bg`, `--shadow-raised`) over the stage\'s top right.',
  ],
  states: [
    { name: 'Closed', render: () => demo('', { open: false }) },
    { name: 'Searching by name', render: () => demo('dev') },
    { name: 'Matching an ITSA', render: () => demo('fx-4') },
    { name: 'Nothing matches', render: () => demo('zzz') },
    { name: 'On a phone', render: () => demo('search', { narrow: true }) },
  ],
}]

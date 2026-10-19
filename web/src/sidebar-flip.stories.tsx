// The agents sidebar's spawn and archive motion (S-700): a new row grows out of its parent's row,
// an archived row collapses into it, and the rows below move by FLIP. It lives in sidebar-flip.tsx
// (RowFlip, drawn inside the tree) and goes through the S-696 gate as the 'spawn-archive' kind.
import { useState } from 'react'
import { StateGlyph } from './Glyph'
import { RowFlip } from './sidebar-flip'
import { TreeRow } from './sidebar-motion'
import { emitAgentEvent } from './store'
import { Side } from './stories/helpers'
import { ds, type Story } from './stories/types'

interface R { id: string; parent?: string; depth: number }
const START: R[] = [{ id: 'cos', depth: 0 }, { id: 'manager', parent: 'cos', depth: 1 }, { id: 'reviewer', parent: 'cos', depth: 1 }, { id: 'mail-dev', depth: 0 }]

// The rows of a tree as the sidebar draws them (class `node`, `data-id`, `data-parent`), each the
// real class, with the real RowFlip inside the list. The buttons fire the same events the daemon's
// stream does, so the motion replays here.
function Demo() {
  const [rows, setRows] = useState(START)
  const [n, setN] = useState(1)
  // An owned issue's status changing nudges every row: the nudge adds onto a grow in flight.
  const [issue, setIssue] = useState(0)
  const spawn = () => {
    const id = `dev-${n}`
    setN(n + 1)
    emitAgentEvent({ type: 'spawned', id, parent: 'manager' })
    setRows((r) => { const at = r.findIndex((x) => x.id === 'manager'); const next = r.slice(); next.splice(at + 1, 0, { id, parent: 'manager', depth: 2 }); return next })
  }
  const archive = () => {
    const last = [...rows].reverse().find((x) => x.depth === 2)
    if (!last) return
    emitAgentEvent({ type: 'archived', id: last.id, parent: null })
    setRows((r) => r.filter((x) => x.id !== last.id))
  }
  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-3)' }}>
        <button id="df-spawn" className="btn" onClick={spawn}>Spawn</button>
        <button id="df-archive" className="btn" onClick={archive}>Archive</button>
        <button id="df-nudge" className="btn" onClick={() => setIssue(issue + 1)}>Issue event</button>
      </div>
      <Side>
        <div className="tree" role="tree" style={{ flex: 'none', height: 'calc(var(--size-row-tree) * 8)' }}>
          {rows.map((r) => (
            <TreeRow key={r.id} event={`S-1:${issue}`} waiting={false} className="node" data-id={r.id} data-parent={r.parent} style={{ paddingLeft: 8 + r.depth * 14 }}>
              <span className="stamp"><StateGlyph state="idle" /></span>
              <span className="name">{r.id}</span>
            </TreeRow>
          ))}
          <RowFlip />
        </div>
      </Side>
    </>
  )
}

export const stories: Story[] = [{
  name: 'Sidebar spawn and archive',
  group: 'Tree and shell',
  what: 'The agents sidebar\'s motion when an agent spawns or is archived: the new row grows out of its parent\'s row (from the parent\'s place, transparent and slightly small, to its slot), an archived row collapses back into its parent\'s row and fades before it leaves, and the rows below move to their new places by FLIP.',
  when: 'In the agent tree, on a real spawn or archive event from the daemon\'s stream. The buttons here fire the same events; a row on screen at load, or one a refresh brings, appears at once.',
  code: ['web/src/sidebar-flip.tsx#RowFlip', 'web/src/row-flip.ts#flipDeltas'],
  rules: [
    'Only a live `agent.spawned` or `agent.archived` event animates; a load, a poll or a refresh never does.',
    'Gate: `canAnimate(\'spawn-archive\', el)` runs when the event\'s row appears. With the master or the kind off in Settings › Motion, under reduced motion, while the tree scrolls, or for rows outside the list, the rows jump to their places (' + ds('Motion') + ', ' + ds('Reduced motion') + ').',
    'Transform and opacity only, never height, top or margin; the scale starts at 0.96, never 0. Duration and easing come from the `--duration-slow` and `--ease-out` tokens, read through a throwaway probe.',
    'FLIP is keyed by agent id. A new event stops the running rows and restarts each from where it is drawn, so no row is left mid-transform.',
    'The grow and FLIP are native plays: the transform adds onto the row\'s own (so an issue nudge during a grow adds to it), and the fade is a play of its own that replaces.',
    'An archived row plays as a ghost in its own layer, hidden from assistive tech and out of the tree\'s rows, and is removed when it ends.',
  ],
  states: [
    { name: 'Replay an event', render: () => <Demo /> },
  ],
}]

// The agents sidebar's row motion (S-698): the spend hairline under a row's cost, and the stamp
// a mark gives when its state changes. The three pieces live in sidebar-motion.tsx, and each goes
// through the S-696 motion gate, so they run only when the row is on screen, the tree isn't
// scrolling, reduced motion is off, and the kind is on in Settings › Motion.
import { useState, type CSSProperties } from 'react'
import { StateGlyph } from './Glyph'
import { StatusGlyph } from './itsa/itsa'
import { SpendBar, Stamp, TreeRow } from './sidebar-motion'
import { Side } from './stories/helpers'
import { ds, type Story } from './stories/types'

// A row's marks and its cost, at the values a checker can replay: the state ring, the owned
// ITSA's chip, the unread badge, and the spend hairline (own spend against the biggest shown).
function Demo() {
  const [v, setV] = useState({ state: 'working', status: 'in_review', unread: 3, cost: 12.7 })
  const step = (p: Partial<typeof v>) => setV((o) => ({ ...o, ...p }))
  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-3)' }}>
        <button id="dm-stamp" className="btn" onClick={() => step({ state: v.state === 'working' ? 'blocked' : 'working' })}>State</button>
        <button id="dm-spend" className="btn" onClick={() => step({ cost: +(v.cost + 18).toFixed(2) })}>Spend</button>
        <button id="dm-issue" className="btn" onClick={() => step({ status: v.status === 'needs_review' ? 'in_review' : 'needs_review' })}>Issue</button>
        <button id="dm-mail" className="btn" onClick={() => step({ unread: v.unread + 2 })}>Mail</button>
      </div>
      <Side>
        <Row state="idle" status="in_progress" unread={0} cost={41.2} max={41.2} />
        <Row state={v.state} status={v.status} unread={v.unread} cost={v.cost} max={41.2} />
        <Row state="waiting" status="needs_review" unread={1} cost={2.2} max={41.2} />
      </Side>
    </>
  )
}

// One row, as the tree draws it: the mark's stamp, the chip's, the badge's, and the cost's
// hairline, each the real component.
function Row({ state, status, unread, cost, max }: { state: string; status: string; unread: number; cost: number; max: number }) {
  return (
    <TreeRow event={`S-1:${status}`} waiting={status === 'needs_review'} className="node" data-demo="row">
      <Stamp value={state} className="stamp"><StateGlyph state={state} /></Stamp>
      <span className="name">fixture-dev</span>
      <span className="meta">
        <Stamp value={status} className="ichip" style={{ '--tc': 'var(--is-review)' } as CSSProperties}><StatusGlyph status={status} />S-1</Stamp>
        <Stamp value={unread} increaseOnly className="badge">{unread}</Stamp>
        <span className="cost">
          <span className="cost-row"><span className="cost-own">${cost.toFixed(2)}</span></span>
          <SpendBar value={cost} max={max} />
        </span>
      </span>
    </TreeRow>
  )
}

export const stories: Story[] = [{
  name: 'Sidebar row motion',
  group: 'Tree and shell',
  what: 'The agents sidebar\'s row motion: a hairline spend bar under each row\'s cost (the agent\'s own spend against the biggest spender shown, on a square-root scale, easing by transform: scaleX as spend grows and flashing --st-working for fresh spend), a one-off stamp when a mark\'s state changes (the ring, the ITSA chip, the unread badge), and a one-off nudge when a row\'s owned issue changes status.',
  when: 'In the agent tree (the sidebar\'s Agents section), on every live row. The buttons here replay each event so the motion can be seen; in the app the daemon\'s events drive it.',
  code: ['web/src/sidebar-motion.tsx#Stamp', 'web/src/sidebar-motion.tsx#SpendBar', 'web/src/sidebar-motion.tsx#TreeRow'],
  rules: [
    'Every trigger calls `canAnimate(kind, el)` at that moment: nothing moves while the tree scrolls, for an off-screen row, under reduced motion, or with the kind off in Settings › Motion (' + ds('Motion') + ').',
    'Transform and opacity only, no `transition: all`, no `scale(0)`, no ease-in, no glow, gradient, toast or pill (docs/design-system.md, `.claude/skills/system-view-motion`).',
    'The duration and easing tokens are read through a throwaway probe, never written onto the mark, so no mark is left carrying an implicit `transition: all`; a coalesced change never stops the stamp in flight, and a bar draws its first width without a sweep or a flash.',
    'A stamp settles from 1.15 with a slight turn on `SPRINGS.stamp`; a burst coalesces into one. Stamps carry the ring\'s own colour change, so reduced motion keeps the news without the movement (' + ds('Reduced motion') + ').',
    'The spend bar is a hairline below the cost\'s numbers; the cost figure itself never rolls or counts up.',
    'Tokens only: `--border-subtle` for the track, `--border-strong` for the fill, `--st-working` for fresh spend, `--space-05` for the hairline.',
  ],
  states: [
    { name: 'Replay an event', render: () => <Demo /> },
    {
      name: 'Spend shares',
      render: () => <Side>
        <Row state="working" status="in_progress" unread={0} cost={41.2} max={41.2} />
        <Row state="idle" status="in_review" unread={2} cost={12.7} max={41.2} />
        <Row state="waiting" status="needs_review" unread={0} cost={0.84} max={41.2} />
        <Row state="blocked" status="backlog" unread={0} cost={0} max={41.2} />
      </Side>,
    },
  ],
}]

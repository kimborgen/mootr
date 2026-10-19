import { useEffect, useState } from 'react'
import { costShort, money } from '../format'
import { SvStage } from '../stories/system'
import { ds, type Story } from '../stories/types'
import { Rise, Roll } from './Roll'

const whole = (v: number) => String(Math.round(v))
const pct = (v: number) => Math.round(v) + '%'
const dollars = (v: number) => costShort(v, 'api')

// Plays values in turn: the first at once, each next after its delay in ms, as polls would bring them.
function useValues(first: number, steps: [number, number][]): number {
  const [v, set] = useState(first)
  useEffect(() => {
    const ts = steps.map(([delay, value]) => setTimeout(() => set(value), delay))
    return () => ts.forEach(clearTimeout)
  }, [])
  return v
}
const Line = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <p style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', padding: '0 var(--space-4)', margin: 'var(--space-3) 0' }}><span className="muted" style={{ minWidth: 'var(--size-pane-min)' }}>{label}</span>{children}</p>
)
const stage = (node: React.ReactNode, height = 140) => <SvStage world={false} height={height}>{() => <div style={{ paddingTop: 'var(--space-2)' }}>{node}</div>}</SvStage>

function Rolling() {
  const agents = useValues(6, [[500, 9]])
  const meter = useValues(42, [[500, 87]])
  const spend = useValues(12.4, [[500, 14.9]])
  return <>
    <Line label="Agents"><b><Roll value={agents} fmt={whole} /></b></Line>
    <Line label="A window meter"><b><Roll value={meter} fmt={pct} /></b></Line>
    <Line label="The day's spend"><b className="sv-spend"><Roll value={spend} fmt={money} /><Rise value={spend} fmt={money} /></b></Line>
  </>
}
// A cost that grows three times in a row: the rolls run into each other, and the rises add up to one.
function Burst() {
  const v = useValues(1.4, [[400, 1.9], [800, 2.6], [1100, 3.3]])
  return <Line label="An agent's cost"><span className="sv-cost"><Roll className="own" value={v} fmt={dollars} /><Rise value={v} fmt={dollars} /></span></Line>
}
function AtRest() {
  return <>
    <Line label="Agents"><b><Roll value={6} fmt={whole} /></b></Line>
    <Line label="A cost"><span className="sv-cost"><Roll className="own" value={2.4} fmt={dollars} /><Rise value={2.4} fmt={dollars} /></span></Line>
    <Line label="Unknown"><span className="sv-cost"><span className="own">{costShort(null, 'api')}</span></span></Line>
  </>
}

export const stories: Story[] = [{
  name: 'Number roll',
  group: 'System view',
  what: 'A number on the system view that rolls to each new value instead of jumping, and the "+$" that rises over a cost as it grows. A card\'s cost, the header\'s agent and ITSA counts, the subscription window meters, the day\'s spend and a roll-up\'s done count are all rolls; a rise shows how much a cost just grew by, so the change is read as well as seen.',
  when: 'Anywhere the `w:system` view shows a count, a percentage or a cost, whenever a poll or a stream event brings a new value. A cost in dollars or a subscription also raises the "+$"; a cost in a window\'s percent rolls without one. These states play a few changes for you, once, as the state draws.',
  code: ['web/src/system/Roll.tsx#Roll', 'web/src/system/Roll.tsx#Rise', 'web/src/system/Roll.tsx#TimingContext'],
  rules: [
    'The roll lasts `--duration-tick` (two slows) on the ease-out curve; reduced motion zeroes the token, so the number is at its value at once. React renders once per new value, never per frame: each frame writes the number\'s text directly, and only when the text changes.',
    'Figures are tabular, so the width of a number does not shake as it counts (the view sets `font-variant-numeric: tabular-nums`).',
    'A value that arrives while a roll is running keeps that roll\'s end, so the number skips the frames between and never lags the data by more than one roll. A roll with less than a frame left snaps.',
    'The rise is "+" and the amount in the cost\'s own format, drifting from a `space-1` below its start to a `space-2` above it while it fades in and out over `--duration-focus` (five slows); it is muted text, `--text-muted`. A growth that arrives in the first half of a rise adds to it, so a busy agent shows one rising sum, and growth under 0.01 waits until it adds up to that; a drop resets the base.',
    'Nothing here loops: a quiet system is a still page (' + ds('First principle: Calm at rest; instruments on approach') + ').',
  ],
  states: [
    { name: 'At rest', render: () => stage(<AtRest />) },
    { name: 'Values roll', render: () => stage(<Rolling />, 160) },
    { name: 'Growth in a burst', render: () => stage(<Burst />, 100) },
  ],
}]

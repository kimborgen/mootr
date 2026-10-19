import { useState } from 'react'
import { SpendCharts } from './SpendCharts'
import type { ColorMap, DrillKind } from './math'
import { series } from '../story-data'
import { OnMount } from '../../stories/helpers'
import { ds, type Story } from '../../stories/types'

type Kind = 'tree' | 'itsa' | 'model' | 'harness'
const S = {
  week: (g: Kind) => series(g, 7),
  month: (g: Kind) => series(g, 30),
  today: (g: Kind) => series(g, 24, 'hour', 0.4),
}

// The grouping buttons work here: each kind has its own invented series.
function Spend({ make, first = 'tree', loading, error, empty, allAgents }: { make: (g: Kind) => ReturnType<typeof series>; first?: Kind; loading?: boolean; error?: string; empty?: boolean; allAgents?: boolean }) {
  const [group, setGroup] = useState<DrillKind>(first)
  const [colors] = useState<ColorMap>(() => new Map())
  const s = loading || error ? null : empty ? { ...make(group as Kind), rows: [] } : make(group as Kind)
  return (
    <div className="pad usage">
      <SpendCharts series={s} loading={loading} error={error} onRetry={() => {}} group={group} onGroup={setGroup} onDrill={() => {}} colors={colors} allAgents={allAgents} />
    </div>
  )
}
// Moves the pointer over the fourth column, as a hover would, so its tooltip shows.
const hover = (el: HTMLElement) => el.querySelector('[data-i="3"]')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))

export const stories: Story[] = [{
  name: 'Spend charts',
  group: 'Settings',
  what: 'Two panels for the Usage overview, drawn in plain SVG from what the daemon sends: spend per day (per hour for Today) as stacked columns, grouped by tree, ITSA, model or harness, with the previous period dimmed beside it; and "Where it went", a ranked bar list of the same groups with each one\'s cost and share of the period. A segment or a bar drills into that group\'s details.',
  when: 'In the Usage page\'s Overview tab, below the cost instructions, through the wiring component that reads the page\'s period. It draws nothing the daemon did not send: no rows or no spend gives a plain message.',
  code: ['web/src/usage/charts/SpendCharts.tsx#SpendCharts', 'web/src/usage/charts/SpendCharts.tsx#Columns', 'web/src/usage/charts/SpendCharts.tsx#periodLabel'],
  rules: [
    'With an agent type filter set (`allAgents`) each panel title carries a muted "All agents" label, since the spend counts every agent (S-1845).',
    'The two panels sit side by side, about two thirds and one third (`.uc` columns of 2fr and 1fr); at 760 px and narrower they stack. A panel is `--surface-raised` with a `--border-subtle` border, `--radius-md` corners and `--space-4` padding (`--space-3` on a phone).',
    'A group keeps the series colour slot it first got, `--series-1` to `--series-6` in order, so a changed period or grouping never repaints it; Other and Unattributed are `--text-muted` and are not drillable. Grouped by harness, the columns use `--h-claude`, `--h-codex` and `--h-opencode` (' + ds('Color semantics') + ').',
    'Columns are at most 24 px wide and 72% of their slot, stacked bottom to top in legend order with a 2 px gap; only the top segment has rounded corners. The scale has three ticks, chosen as 1, 2, 2.5 or 5 times a power of ten.',
    'The previous period\'s columns show dimmed (opacity 0.4) only for daily periods of up to 14 days, and a note says so; Today and longer periods draw no previous columns.',
    'Hover or focus shows a tooltip with each segment\'s cost and the total. The chart is a keyboard group: left and right move between columns, up and down between a column\'s segments, Enter drills into the segment. A bar in the list is at least 44 px tall (a literal in `style.css`), and legend keys are 44 px tall at 480 px and narrower.',
    'No spend shows "No spend in this period"; loading shows the loading mark (`Loading`); a failure shows "Could not load spend: …" in `--status-error-fg`, with a Retry text button in `--accent-text` (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: 'Seven days, by tree', render: () => <Spend make={S.week} /> },
    { name: 'Seven days, by harness', render: () => <Spend make={S.week} first="harness" /> },
    { name: 'Seven days, by model', render: () => <Spend make={S.week} first="model" /> },
    { name: 'Seven days, by ITSA', render: () => <Spend make={S.week} first="itsa" /> },
    { name: '30 days (no previous period)', render: () => <Spend make={S.month} /> },
    { name: 'Today (hourly)', render: () => <Spend make={S.today} /> },
    { name: 'A column hovered', render: () => <OnMount run={hover}><Spend make={S.week} /></OnMount> },
    { name: 'Filtered to a type, labelled All agents', render: () => <Spend make={S.week} allAgents /> },
    { name: 'Loading', render: () => <Spend make={S.week} loading /> },
    { name: 'Error', render: () => <Spend make={S.week} error="HTTP 503: fixture: spend series unavailable" /> },
    { name: 'No spend', render: () => <Spend make={S.week} empty /> },
  ],
}]

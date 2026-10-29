import { ds, type Story } from '../stories/types'
import type { Ask } from '../types'
import { NeedsYouList } from './NeedsYouList'

// Invented fixtures only: agent names, homes and asks are made up for the story.
const HOMES = ['fixture-home', 'fixture-storage', 'fixture-a-very-long-home-name-that-truncates-in-its-chip']
const KINDS: Ask['kind'][] = ['request', 'dialog', 'settings', 'input', 'itsa', 'decision']
const NAMES = ['fixture-dev', 'fixture-review', 'fixture-a-very-long-agent-name-to-check-the-row-width-holds', 'fixture-ops']
const WHATS: Record<Ask['kind'], string> = {
  request: 'Permission request',
  dialog: 'Harness dialog',
  settings: 'Settings change',
  input: 'Suggested input',
  itsa: 'Hold the release until the fixture settles',
  decision: 'Pick a fixture release channel',
}
const OUTCOMES = ['approved', 'denied', 'typed', 'failed', 'expired', 'withdrawn', 'answered', 'superseded', 'answered in a long reply that was then superseded by a later decision']

// A fixed day, so every row's age reads the same on every run.
const DAY = Date.parse('2026-10-24T12:00:00.000Z')
const at = (minutesAgo: number) => new Date(DAY - minutesAgo * 60_000).toISOString()

// Many asks of every kind across two homes: long agent names, the settled ones in the last day and their outcomes.
function manyAsks(open: number, settled: number): Ask[] {
  const rows: Ask[] = []
  for (let i = 0; i < open; i++) {
    const kind = KINDS[i % KINDS.length]
    rows.push({
      key: `${kind}:open-${i}`, kind, state: 'open', outcome: null, what: WHATS[kind],
      agent_id: `a${i % NAMES.length}`, agent_name: NAMES[i % NAMES.length], machine: HOMES[i % HOMES.length],
      thread_id: `t-open-${i}`, itsa_id: kind === 'itsa' ? `i-open-${i}` : null, since: at(5 + i * 9), settled_at: null,
    })
  }
  for (let i = 0; i < settled; i++) {
    const kind = KINDS[(i + 2) % KINDS.length]
    rows.push({
      key: `${kind}:settled-${i}`, kind, state: 'settled', outcome: OUTCOMES[i % OUTCOMES.length], what: WHATS[kind],
      agent_id: `a${i % NAMES.length}`, agent_name: NAMES[i % NAMES.length], machine: HOMES[(i + 1) % HOMES.length],
      thread_id: `t-settled-${i}`, itsa_id: null, since: at(120 + i * 30), settled_at: at(10 + i * 37),
    })
  }
  return rows
}

// The realistic-scale list: a few dozen asks, every kind, two homes, settled rows.
export const MANY_ASKS = manyAsks(24, 18)

export const stories: Story[] = [{
  name: 'Needs you list',
  group: 'Mail',
  what: 'The Needs you list in the mailbox (S-3831): every ask waiting on you, oldest first, then the asks settled in the last day with their outcome, dimmed. Each row is the ask kind, the agent, a one-line what, the home it is held on, and its age.',
  when: 'Opened from the Needs you (N) entry that heads the mail rail: the desktop left sidebar\'s Mail pane, and the mailbox on a phone.',
  code: ['web/src/mail/NeedsYouList.tsx#NeedsYouList'],
  rules: [
    'Rows are `.mrow`, so they take the mail row sizes; on a phone the row is a touch target (' + ds('Density') + ').',
    'A row is never answered from the list: a tap opens the ITSA or the thread, where the ask card answers it.',
    'A permission row shows its kind label only, never its text (the endpoint sends the kind).',
  ],
  states: [
    { name: 'Empty', render: () => <NeedsYouList asks={[]} /> },
    { name: 'Few asks', render: () => <NeedsYouList asks={MANY_ASKS.slice(0, 3)} /> },
    { name: 'Many asks', render: () => <NeedsYouList asks={MANY_ASKS} /> },
    { name: 'Settled only', render: () => <NeedsYouList asks={MANY_ASKS.filter((a) => a.state === 'settled')} /> },
  ],
}]

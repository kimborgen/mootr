// Mail motion in the agents sidebar (S-699): a small envelope riding the tree's indent gutter from
// the sender's row to the recipient's unread badge, and the stamp the badge gives as it lands. The
// buttons here replay what the daemon's live stream sends — a mail, then the recipient's count —
// so the flight can be seen; in the app the stream drives it.
import { useState } from 'react'
import { applyLiveEvent, byId } from './store'
import { agent } from './stories/fixtures'
import { Side } from './stories/helpers'
import { ds, type Story } from './stories/types'
import { Tree } from './Tree'
import type { Agent } from './types'

// A chief of staff, a manager, and a developer and a reviewer under it: the rows a mail flies
// between when the demo presses a button.
const NESTED: Agent[] = [
  agent({ id: 'm-cos', name: 'fixture-cos', role: 'chief of staff', chief_of_staff: true }),
  agent({ id: 'm-mgr', name: 'fixture-manager', role: 'manager', parents: ['m-cos'], activity: 'working', created_at: '2026-10-01T09:01:00.000Z' }),
  agent({ id: 'm-dev', name: 'fixture-dev', role: 'developer', parents: ['m-mgr'], activity: 'working', created_at: '2026-10-01T09:02:00.000Z' }),
  agent({ id: 'm-rev', name: 'fixture-review', role: 'reviewer', harness: 'codex', model: 'gpt-6.1-sol', parents: ['m-mgr'], created_at: '2026-10-01T09:03:00.000Z' }),
]
// Many rows under the managers, for a list taller than the box it is shown in: mail to a row below
// the fold leaves at the list's own bottom edge.
const LONG: Agent[] = [
  NESTED[0],
  ...Array.from({ length: 3 }, (_, m) => agent({ id: `n-m${m}`, name: `fixture-manager-${m + 1}`, role: 'manager', parents: ['m-cos'], created_at: `2026-10-01T09:1${m}:00.000Z` })),
  ...Array.from({ length: 12 }, (_, i) => agent({ id: `n-a${i}`, name: `fixture-agent-${i + 1}`, role: 'developer', parents: [`n-m${i % 3}`], activity: 'idle', created_at: `2026-10-01T10:${String(i).padStart(2, '0')}:00.000Z` })),
]

// The daemon's two events, as the buttons send them: the mail on the live stream, and the
// recipient's own count, which is what stamps the badge as the envelope lands.
function Demo({ from = 'm-dev', to = 'm-rev', height }: { from?: string; to?: string; height?: number }) {
  const [sent, setSent] = useState(0)
  const send = (sender: string, target: string, times = 1) => {
    setSent((n) => n + times)
    if (target !== 'human') {
      const unread = (byId(target)?.unread ?? 0) + times
      applyLiveEvent('agent.changed', { id: target, unread, state: 'active' })
    }
    for (let i = 0; i < times; i++) applyLiveEvent('mail.sent', { id: `demo-${sent + i}`, from: sender, to: [target], thread: null, ask: false })
  }
  return (
    <Side>
      <div className="story-pad" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        <button id="mb-row" className="btn" onClick={() => send(from, to)}>Between two rows</button>
        <button id="mb-burst" className="btn" onClick={() => send(from, to, 3)}>A burst of three</button>
        <button id="mb-you" className="btn" onClick={() => send(from, 'human')}>To you</button>
        <button id="mb-from-you" className="btn" onClick={() => send('human', to)}>From you</button>
      </div>
      {height ? <div style={{ height, overflow: 'hidden' }}><Tree /></div> : <Tree />}
    </Side>
  )
}

export const stories: Story[] = [{
  name: 'Sidebar mail motion',
  group: 'Tree and shell',
  what: 'The agents sidebar\'s mail motion: when mail is sent between two agents the tree shows, a small envelope rides the indent gutter from the sender\'s row to the recipient\'s, along the trunk at the leftmost of the two rails, and lands on the recipient\'s unread badge, which stamps as the count arrives. An end with no row on screen — a scrolled-away agent, or the human, who has no row at all — becomes the list\'s own top or bottom edge, so the envelope enters or leaves clipped to the list. A burst between the same pair rides one flight with a small count.',
  when: 'In the agent tree (the sidebar\'s Agents section), on the live stream\'s `mail.sent` events — the same events the system view\'s sheets fly on. The buttons here replay them; in the app nothing calls this by hand.',
  code: ['web/src/sidebar-mail.tsx#MailFlights', 'web/src/sidebar-flights.ts#plan', 'web/src/sidebar-flights.ts#gutterRoute', 'web/src/sidebar-flights.ts#edgeEnd'],
  rules: [
    'Every flight asks `canAnimate(\'mail\', el)` at its start: nothing flies while the tree scrolls, for a tree that isn\'t on screen, under reduced motion, or with Mail motion off in Settings › Motion (' + ds('Motion') + ').',
    'Transform and opacity only, eased by Motion on the token durations (`--duration-flight` for the longest hop across the list, down to 5/11 of it for a short one) and `--ease-flight`; no `transition: all`, no `scale(0)`, no ease-in, no glow, gradient, toast or pill. The tokens are read through `tokenMs`\'s throwaway probe (S-1023), never through the flying layer, which would otherwise carry an implicit `transition: all`.',
    'At most six envelopes in the air; past that the mail lands without flying, and the badge still stamps.',
    'The route keeps to the gutter: the trunk is the leftmost of the two rows\' rails, so a flight never crosses a row\'s text. The envelope is `--accent-text` at `--icon-xs`; a burst\'s count is a neutral badge.',
    'An end whose point the list doesn\'t show — a row scrolled away, a landing point below the fold, or the human, who has no row — is clipped to the list\'s own top or bottom edge, where the flight fades in or out.',
    'Under reduced motion the travel goes and the news stays: the badge still stamps, and the row still shows its new count (' + ds('Reduced motion') + ').',
  ],
  states: [
    { name: 'Replay a flight', data: { agents: NESTED }, render: () => <Demo /> },
    { name: 'Clipped at the list edge', data: { agents: LONG }, render: () => <Demo from="n-a0" to="n-a11" height={220} /> },
    { name: 'Between the fixture agents', data: {}, render: () => <Demo from="fx-dev" to="fx-review" /> },
    { name: 'Mail to you and from you', data: { agents: NESTED }, render: () => <Demo from="m-cos" to="m-dev" /> },
  ],
}]

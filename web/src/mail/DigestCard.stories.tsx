import { DigestCard } from './DigestCard'
import { ds, type Story } from '../stories/types'
import type { Digest } from './digest'

const now = Date.now()
const ago = (h: number) => new Date(now - h * 36e5).toISOString()
const window = { since: ago(9), until: ago(0) }

const full: Digest = {
  window,
  dismissedAt: null,
  happened: {
    merged: [
      { pr: 912, title: 'Digest card dev', itsa: 'S-2822', at: ago(2) },
      { pr: 905, title: 'Phone mail header', itsa: 'S-2810', at: ago(4) },
    ],
    closed: [{ itsa: 'S-2805', title: 'Retro search ranking', at: ago(3) }],
    spawned: [{ agent: 'fixture-dev', at: ago(6) }],
    archived: [{ agent: 'fixture-old', at: ago(7) }],
    spend: { usd: 1.4, byHarness: { 'claude-code': 1.1, codex: 0.3 } },
  },
  needs: [
    { kind: 'decision', ref: 'S-2801', title: 'Token lifetime', since: ago(5), new: true },
    { kind: 'permission', ref: 'fixture-dev', title: 'Run a shell command', since: ago(8), new: false },
  ],
  next: {
    itsas: [{ key: 'S-2822', title: 'Away digest card', status: 'in_progress', owner: 'digest-card-dev' }],
    working: [{ agent: 'fixture-dev', itsa: 'S-2822', detail: 'writing the card' }],
  },
}

const noop = () => {}
const card = (d: Digest, startOpen = true) => <div className="story-inbox" style={{ padding: 'var(--space-3)' }}><DigestCard digest={d} onDismiss={noop} onNeeds={noop} onItsa={noop} agentId={(n) => n} onAgent={noop} startOpen={startOpen} /></div>

export const stories: Story[] = [{
  name: 'Away digest card',
  group: 'Mail',
  what: 'The "While you were away" card at the top of the Inbox: what happened in the window the human was away for (merged PRs, closed ITSAs, agents spawned and archived, spend), what needs them (a summary that scrolls to the Inbox\'s Needs you group, new ones marked), and what runs next. It collapses to one line and dismisses for the window it shows.',
  when: 'The Inbox page, when `/api/digest` has a window that is not dismissed. Hidden when the digest is missing, fails, or has no window.',
  code: ['web/src/mail/DigestCard.tsx#DigestCard'],
  rules: [
    'Lines are touch targets of `--size-hit-touch` on a phone and `--size-hit-min` on desktop; the card uses only the tokens (' + ds('Density') + ').',
    'Needs you is a summary, not a second list: the Inbox\'s Needs you group stays the source of truth.',
    'The collapsed card is one line: the title, then the counts.',
  ],
  states: [
    { name: 'Expanded', render: () => card(full) },
    { name: 'Long, with more counts', render: () => card({ ...full, happened: { ...full.happened, more: { merged: 4, closed: 2 } }, needsMore: 5, next: { ...full.next, more: { itsas: 2, working: 3 } }, needs: [...full.needs, ...full.needs, ...full.needs] }) },
    { name: 'Nothing happened', render: () => card({ ...full, happened: { merged: [], closed: [], spawned: [], archived: [], spend: { usd: 0 } }, needs: [], next: { itsas: [], working: [] } }) },
    { name: 'Collapsed', render: () => card(full, false) },
  ],
}]

import { humanRowsOf } from '../mail/thread-index'
import { agentTooltip, viewMeta } from './registry'
import { Row } from '../stories/helpers'
import { byName } from '../stories/fixtures'
import { type Story } from '../stories/types'
import { setRapid } from './rapid'

const KEYS = ['agent:fx-dev', 'view:fx-dev', 'details:fx-dev', 'instructions:fx-dev', 'mail:human', 'work', 'system', 'compliance', 'config', 'usage', 'inbox', 'diff:fixture-repo#512']
const tab = (key: string) => {
  const m = viewMeta(key)
  return <span title={m.tooltip} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>{m.icon}<span>{m.title}</span>{m.badge ? <span className={`badge ${m.badgeClass ?? ''}`}>{m.badge}</span> : null}</span>
}

export const stories: Story[] = [{
  name: 'World tabs',
  group: 'Tree and shell',
  what: 'How each view in a world is named on its tab: its icon, its title, its hover tooltip, and a badge for unread mail or a waiting permission request. A view is a tab of an agent\'s world (its terminal, its conversation, details, instructions, its inbox) or a page of the main world (Work, System, Compliance, Settings, Usage). The registry also renders every view once into its own element, which panes adopt, so a view that is not on screen waits alive in a hidden store.',
  when: 'In every tab strip and sidebar entry that names a view. The titles are computed from the live store, so an agent\'s name and a thread\'s subject appear as soon as they are known; the agent tooltip lists its state, role, harness and model, context size, spend, machine and folder, unread mail, and waits; a resting agent adds a line with what it waits for and when it wakes (`resting · waits for PR #12 · wakes ~14:20`, in the viewer\'s clock).',
  code: ['web/src/views/registry.tsx#viewMeta', 'web/src/views/registry.tsx#agentTooltip', 'web/src/views/registry.tsx#ViewPortals'],
  rules: [
    '`view:ID` is the conversation, or its rapid-fire mode (S-1004) where this device picked that for the agent. An agent\'s terminal, conversation and rapid-fire tabs are titled with its name only (S-1433); details, instructions and inventory keep their suffix.',
    'A view key is `agent:ID`, `view:ID`, `details:ID`, `instructions:ID`, `mail:ID` (`mail:human` is the human\'s), `thread:ID`, `itsa:ID`, `image:ID` (a staged image, titled by the image shown; a page shows only its own, S-1475), `req:KEY`, `board:ID`, `shell:MACHINE:ID`, `diff:REPO#N` (one PR\'s diff, titled "PR #N"), or one of `work`, `system`, `compliance`, `config`, `usage`, `inbox` (the Inbox page, `w:inbox`, titled "Inbox" with the unread count as its badge).',
    'An agent tab\'s icon is the agent\'s state mark; the badge is the count of waiting permission requests (`warn`), else unread mail.',
    'A saved tab whose agent is gone is dropped on reload (`keepKey`); the pages (`config`, `usage`, `work`, `system`, `inbox`) are always kept.',
  ],
  states: [
    { name: 'Tab titles', setup: () => setRapid('fx-dev', false), render: () => <Row items={KEYS.map((k) => ({ label: k, node: tab(k) }))} /> },
    { name: 'Rapid-fire tab', setup: () => setRapid('fx-dev', true), render: () => tab('view:fx-dev') },
    // A thread's tab: its short title, and its tooltip with the full subject, the people and the count (S-2311).
    { name: 'Thread tab', data: { humanRows: humanRowsOf([{ thread_id: 'tf-reg', mails: [{ id: 'tf-reg-m1', from_id: 'fx-dev', subject: 'Re: `Deploy` plan for the staging gate', body: '', created_at: '2026-10-19T09:00:00Z', title: 'Deploy plan', recipients: [{ id: 'human', read_at: null }], agents: [] }] }] as never) } as never, render: () => <Row items={[{ label: 'thread:tf-reg', node: tab('thread:tf-reg') }]} /> },
    { name: 'Agent tooltip', render: () => <pre className="code">{agentTooltip(byName('fixture-ops'))}</pre> },
    { name: 'Agent tooltip, resting', render: () => <pre className="code">{agentTooltip({ ...byName('fixture-paused'), resting: { reason: 'wait', waits: [{ id: 'rw1', kind: 'event', target: null, detail: 'PR #12', since: '2026-10-01T09:00:00.000Z', until: null }], expected_wake: new Date(Date.now() + 3 * 3600_000).toISOString() } })}</pre> },
  ],
}]

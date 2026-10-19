import { DetailsView } from './DetailsView'
import { OnMount } from '../stories/helpers'
import { AGENTS, agent } from '../stories/fixtures'
import { pending, reply, type Story } from '../stories/types'

const usage = {
  harness: 'claude', model: 'claude-opus-5-5',
  today: { cost_usd: 1.42, tokens_in: 82000, tokens_out: 9400, tokens_cache_read: 640000, tokens_cache_write: 31000 },
  lifetime: { cost_usd: 18.9, tokens_in: 1200000, tokens_out: 140000, tokens_cache_read: 9800000, tokens_cache_write: 410000 },
}
const files = [{ name: 'CLAUDE.md', text: '# Fixture instructions\nWork in the fixture worktree.' }]
const events = [{ type: 'pushed', ts: '2026-10-01T09:05:00.000Z', data: 'a fixture prompt' }, { type: 'mail:in', ts: '2026-10-01T09:06:00.000Z', data: 'fixture mail' }]
const routes = (id: string) => ({ [`GET /api/agents/${id}/usage`]: usage, [`GET /api/agents/${id}/files`]: files, [`GET /api/agents/${id}/events`]: events })
const openFold = (el: HTMLElement) => { const d = el.querySelector('details.fold') as HTMLDetailsElement; d.open = true; d.dispatchEvent(new Event('toggle')) }

const CHILD = agent({ id: 'fx-kid', name: 'fixture-kid', parents: ['fx-dev'], activity: 'idle' })
const WITH_KID = [...AGENTS, CHILD].map((a) => ({ ...a, context_window: 1000000 }))
const view = (id: string) => () => <DetailsView id={id} />

export const stories: Story[] = [{
  name: 'Agent details',
  group: 'Tree and shell',
  what: "A tab in an agent's world with its state, actions, and facts: the harness and model, how full its context is against the warning and compaction thresholds, its permission mode, who is told when its children finish, its machine and folder, its parents and children, and its tokens and cost today and for its life. The actions are pause or unpause, restart, compact, and its inbox; a stopped agent offers Resume instead. A resting agent adds the whole resting badge under its state: what it waits for and when it wakes, wrapping inside the badge however long the wait. A fold at the bottom lists the files stam gives the agent and its recent stam actions.",
  when: "An agent's `details:ID` tab: menu → the agent's details, or the More menu on its tree row. Its files and events load the first time the fold opens, and again on each later open; its usage loads with the tab. If the agent is no longer in the list the tab says it is gone.",
  code: ['web/src/views/DetailsView.tsx#DetailsView', 'web/src/views/DetailsView.tsx#UsageTable', 'web/src/views/DetailsView.tsx#Fold'],
  rules: [
    "The facts are a two-column grid (92 px labels in `--text-muted`, values in tabular figures); a value that can't fit wraps anywhere rather than scroll.",
    'The context meter is a 6 px track in `--status-neutral-bg` with a fill in `--st-working`, `--st-blocked`, or `--st-errored` by the agent\'s context level, and two hairlines in `--border-strong` for the warning and the asked-to-compact thresholds.',
    'A token or cost the harness does not report, or the agent has not reported, reads as an em dash and never as 0; a failed usage request leaves the table out.',
    'While an action runs, Pause, Restart, Compact, and Resume are disabled so two never overlap; Inbox stays enabled. The permission-mode select is shown only for a running agent; a declined or failed switch snaps the permission select back. The select offers Follow settings (the mode Settings give it is shown beside it), Ask on Claude Code only, Auto, and Bypass; Bypass shows a warning under it.',
  ],
  states: [
    { name: 'Working agent', data: { agents: WITH_KID }, routes: routes('fx-dev'), render: view('fx-dev') },
    { name: 'Parent with children', data: { agents: WITH_KID }, routes: routes('fx-cos'), render: view('fx-cos') },
    { name: 'Waiting', data: { agents: WITH_KID }, routes: routes('fx-review'), render: view('fx-review') },
    { name: 'Blocked, bypass mode', data: { agents: AGENTS.map((a) => (a.id === 'fx-ops' ? { ...a, permission_mode: 'bypass', unread: 2 } : a)) }, routes: routes('fx-ops'), render: view('fx-ops') },
    { name: 'Paused', data: { agents: WITH_KID }, routes: routes('fx-paused'), render: view('fx-paused') },
    { name: 'Stopped', data: { agents: WITH_KID }, routes: routes('fx-old'), render: view('fx-old') },
    { name: 'Usage unreachable', data: { agents: WITH_KID }, routes: { 'GET /api/agents/fx-dev/usage': reply(503, { error: 'fixture: no usage' }) }, render: view('fx-dev') },
    { name: 'Fold open', data: { agents: WITH_KID }, routes: routes('fx-dev'), render: () => <OnMount run={openFold}><DetailsView id="fx-dev" /></OnMount> },
    { name: 'Fold loading', data: { agents: WITH_KID }, routes: { ...routes('fx-dev'), 'GET /api/agents/fx-dev/files': pending() }, render: () => <OnMount run={openFold}><DetailsView id="fx-dev" /></OnMount> },
    { name: 'Agent gone', routes: {}, render: view('fx-missing') },
    { name: 'Resting, long wait', data: { agents: [...AGENTS.filter((a) => a.id !== 'fx-paused'), agent({ id: 'fx-paused', name: 'fixture-paused', lifecycle: 'paused', activity: null, resting: { reason: 'wait', waits: [{ id: 'rw', kind: 'event', target: null, detail: 'PR #1234 checks and review from the fixture-reviewer-with-a-very-long-name, then the merge queue', since: '2026-10-01T09:00:00.000Z', until: null }], expected_wake: '2026-10-30T14:20:00.000Z' } })] }, routes: routes('fx-paused'), render: view('fx-paused') },
  ],
}]

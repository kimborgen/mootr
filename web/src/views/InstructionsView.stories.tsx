import { InstructionsView } from './InstructionsView'
import { OnMount } from '../stories/helpers'
import { pressEach } from '../stories/settingsFixtures'
import { ds, pending, reply, type Story } from '../stories/types'

const PARTS = [
  { label: 'Base system prompt', source: 'stam', origin: 'system-prompt', format: 'markdown', text: '# fixture-dev\n\nYou are an agent in stam.\n\n- Work in `/home/fixture/project`.\n- Mail your parent when you are done.' },
  { label: 'Type: developer', source: 'stam', origin: 'type-developer', format: 'markdown', text: 'You make one small change per task.' },
  { label: 'Workspace', source: 'stam-generated', format: 'text', text: 'Machine: fixture-machine\nFolder: /home/fixture/project' },
  { label: 'CLAUDE.md', source: 'repo', path: '/home/fixture/project/CLAUDE.md', format: 'markdown', text: '# Project\n\nRun the tests before you report.' },
  { label: 'Your global instructions', source: 'user-global', path: '/home/fixture/.claude/CLAUDE.md', format: 'text', text: 'Keep answers short.' },
]
const route = (body: unknown) => ({ 'GET /api/agents/fx-dev/instructions': body })

export const stories: Story[] = [{
  name: 'Agent instructions',
  group: 'Settings',
  what: 'A tab of an agent\'s world listing everything it receives at its next start, in the order it arrives: stam\'s rendered system-prompt parts, the files its harness loads itself, and its first prompt. It is read-only and an outline: every part starts collapsed with its source badge, size in lines, and path, so it fits one screen. stam\'s own parts link to the Settings editor; repo files are shown as they are.',
  when: 'The Instructions tab of an agent (view key `instructions:ID`). It loads `GET /api/agents/ID/instructions` when it opens. Restart shows while the agent is live, because changes reach it only after a restart.',
  code: ['web/src/views/InstructionsView.tsx#InstructionsView'],
  rules: [
    'A part row is at least `--size-row-menu` tall; its source badge is `stam`, `stam · generated`, `repo`, or `user-global`, and its size is tabular figures in `--text-muted`.',
    'Edit in Settings appears only on a part stam owns: it sets the Settings section and item (`stam/settings-section`, `stam/settings-item`) and opens Settings on that text.',
    'Markdown parts render sanitized; text parts show as code. Expand all and Collapse all are text buttons (' + ds('Buttons') + ').',
    'Loading shows the loading mark (`Loading`) and a failed load is one muted line; an agent that is gone says "This agent is gone." (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: 'Collapsed', routes: route({ parts: PARTS }), render: () => <InstructionsView id="fx-dev" /> },
    { name: 'Expanded', routes: route({ parts: PARTS }), render: () => <OnMount run={pressEach('Expand all')}><InstructionsView id="fx-dev" /></OnMount> },
    { name: 'No parts yet', routes: route({ parts: [] }), render: () => <InstructionsView id="fx-dev" /> },
    { name: 'Loading', routes: route(pending()), render: () => <InstructionsView id="fx-dev" /> },
    { name: 'Failed to load', routes: route(reply(503, { error: 'fixture: the daemon is unreachable' })), render: () => <InstructionsView id="fx-dev" /> },
    { name: 'Agent is gone', render: () => <InstructionsView id="fx-nobody" /> },
  ],
}]

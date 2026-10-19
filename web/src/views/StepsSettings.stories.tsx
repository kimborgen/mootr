import { StepsSettings } from './StepsSettings'
import { OnMount } from '../stories/helpers'
import { pressEach } from '../stories/settingsFixtures'
import { ds, pending, reply, type Story } from '../stories/types'

const T = '2026-10-01T09:00:00.000Z'
const STEPS = [
  { id: 'fx-s1', name: 'Mail about spending', trigger: { kind: 'event', event: 'mail-to-human' }, question: 'Is this about spending money?', threshold: 0.5, action: 'flag', enabled: true, builtin: 'spend', created_at: T, updated_at: T },
  { id: 'fx-s2', name: 'Hard to undo', trigger: { kind: 'tool', tool: 'spawn_agent' }, question: 'Would this call do something hard to undo, such as starting an agent on the production machine?', threshold: 0.7, action: 'deny-if-yes', enabled: true, builtin: null, created_at: T, updated_at: T },
  { id: 'fx-s3', name: 'New agent needs a task', trigger: { kind: 'event', event: 'agent-spawned' }, question: 'Does the new agent have a clear task?', threshold: 0.5, action: 'notify', enabled: false, builtin: null, created_at: T, updated_at: T },
]
const TOOLS = { groups: [{ name: 'Agents', tools: [{ name: 'spawn_agent', description: 'Start a new agent.' }, { name: 'whoami', description: 'Your own registry entry.' }] }] }
const base = (steps = STEPS) => ({ 'GET /api/steps': { steps, events: ['mail-to-human', 'itsa-created', 'itsa-status', 'agent-spawned'] }, 'GET /api/tools': TOOLS })
const LOG = { decisions: [
  { id: 3, step_id: 'fx-s2', ts: new Date(Date.now() - 600000).toISOString(), subject: 'tool:spawn_agent', p: 0.91, answer: true, action: 'denied', error: null },
  { id: 2, step_id: 'fx-s2', ts: new Date(Date.now() - 7200000).toISOString(), subject: 'tool:spawn_agent', p: 0.12, answer: false, action: 'allowed', error: null },
  { id: 1, step_id: 'fx-s2', ts: new Date(Date.now() - 86400000).toISOString(), subject: 'tool:spawn_agent', p: null, answer: null, action: 'failed-open', error: 'fixture: the model did not answer' },
] }
const EXAMPLES = { examples: [
  { subject: 'tool:spawn_agent', summary: 'spawn_agent for a docs change', p: 0.08, answer: false },
  { subject: 'tool:spawn_agent', summary: 'spawn_agent on fixture-prod', p: 0.88, answer: true },
  { subject: 'tool:spawn_agent', summary: 'spawn_agent with no task', p: null, answer: null, error: 'fixture: timed out' },
] }

export const stories: Story[] = [{
  name: 'Decision steps settings',
  group: 'Settings',
  what: 'Yes/no questions the decision model answers each time a tool is about to run or something happens, such as a mail to you. A step has a trigger (an event, or a tool), a question, and what a yes does: deny or allow the call, flag it, mail you, or note it on the item. The list shows each step with an on box that saves at once; a step opens in a form to change it, test it on its last 5, 10, or 20 examples, and read its newest decisions.',
  when: 'Settings, Decision steps (`decisions`). Add a step in Settings, Tools opens the new-step form with that tool picked. Steps are shared by all machines, so a peer without the home\'s page shows the list read-only.',
  code: ['web/src/views/StepsSettings.tsx#StepsSettings', 'web/src/views/StepsSettings.tsx#nameFrom', 'web/src/views/StepsSettings.tsx#triggerWords'],
  rules: [
    'The on box is a checkbox (' + ds('Checkboxes and badges') + ') and flips at once, then the daemon\'s answer settles it; a refusal shows as a notice and reloads the list. A step that is off dims its name and trigger to `--text-muted` and carries an Off badge.',
    'A built-in step shows a Built in badge: it can be changed or turned off, not deleted.',
    'A step\'s question shows on one line in the list, ellipsized; on a phone it wraps to two lines and each row is at least `--size-hit-touch` tall.',
    'An answer is a badge: Yes in `progress`, No neutral, Error in `err`; the model\'s confidence is a percentage in tabular figures. Test on recent acts on nothing and logs nothing; if the form has unsaved changes the button reads "Save and test".',
    'Save is disabled until the form differs from the saved step. Errors show under the form as an alert in `--status-error-fg`.',
  ],
  states: [
    { name: 'Steps', routes: base(), render: () => <StepsSettings /> },
    { name: 'No steps', routes: base([]), render: () => <StepsSettings /> },
    { name: 'A step open', routes: { ...base(), 'GET /api/steps/fx-s2/log?limit=50': LOG }, render: () => <OnMount run={pressEach('Hard to undo')}><StepsSettings /></OnMount> },
    { name: 'Tested on recent', routes: { ...base(), 'GET /api/steps/fx-s2/log?limit=50': LOG, 'POST /api/steps/fx-s2/preview': EXAMPLES }, render: () => <OnMount run={pressEach('Hard to undo', 'Test')}><StepsSettings /></OnMount> },
    { name: 'New step for a tool', routes: base(), render: () => <StepsSettings addTool="spawn_agent" /> },
    { name: 'No decisions yet', routes: { ...base(), 'GET /api/steps/fx-s1/log?limit=50': { decisions: [] } }, render: () => <OnMount run={pressEach('Mail about spending')}><StepsSettings /></OnMount> },
    { name: 'Loading', routes: { 'GET /api/steps': pending(), 'GET /api/tools': TOOLS }, render: () => <StepsSettings /> },
    { name: 'Failed to load', routes: { 'GET /api/steps': reply(503, { error: 'fixture: the daemon is unreachable' }), 'GET /api/tools': TOOLS }, render: () => <StepsSettings /> },
  ],
}]

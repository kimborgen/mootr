import { OwnView } from './OwnView'
import { reply, sse, ds, type Story } from '../stories/types'
import type { ViewMessage, ViewPart, ViewPermission, ViewState } from './ownview-model'

const NOW = Date.now()
const at = (minAgo: number) => NOW - minAgo * 60000
const text = (t: string): ViewPart => ({ type: 'text', text: t })
const tool = (id: string, name: string, input: unknown, status: 'pending' | 'running' | 'done' | 'error', output?: string): ViewPart => ({ type: 'tool', id, name, input, status, output })
const msg = (id: string, role: ViewMessage['role'], min: number, parts: ViewPart[], o: Partial<ViewMessage> = {}): ViewMessage => ({ id, role, at: at(min), parts, ...o })

const CAN = { can_stream: true, can_send: true, can_interrupt: true, can_approve: true }
const state = (messages: ViewMessage[], o: Partial<ViewState> = {}): ViewState => ({ agent: 'fx-dev', harness: 'claude', capabilities: CAN, running: false, messages, permissions: [], older: null, ...o })

const TALK: ViewMessage[] = [
  msg('m1', 'user', 12, [text('Add a fixture test for the tree, then run it.')]),
  msg('m2', 'assistant', 11, [
    { type: 'reasoning', text: 'The tree has a test file already; I will extend it.' },
    tool('t1', 'Read', { file_path: 'web/src/Tree.test.tsx' }, 'done', '42 lines'),
    tool('t2', 'Edit', { file_path: 'web/src/Tree.test.tsx' }, 'done', 'edited'),
    tool('t3', 'Bash', { command: 'npx vitest run web/src/Tree.test.tsx' }, 'error', '1 failed: expected 3, got 2'),
    text('The test fails: the tree shows two rows, not three. I will look at the filter next.'),
  ]),
]
const ASK: ViewPermission = { id: 'p1', action: 'Bash', resources: ['rm -rf fixture-dir'], tool: 't9' }
const MAIL: ViewMessage = msg('mail1', 'user', 5, [{ type: 'mail', id: 'mp1', from_id: 'fx-cos', from: 'fixture-cos', subject: 'Fixture: please also check the phone', body: 'Please run the phone check once the test passes.', thread: 'th-1', read_at: at(4) }], { kind: 'mail' })

// A realistic day: Kim's prompt, mail in from Kim and from agents with their notices, mail the
// agent sent, and long runs of tool calls between them.
const mailIn = (id: string, min: number, from_id: string, subject: string, body: string): ViewMessage => msg(`mail:${id}`, 'user', min, [{ type: 'mail', id, from_id, from: from_id, subject, body, thread: `th-${id}`, read_at: at(min - 0.5) }], { kind: 'mail' })
const mailOut = (id: string, min: number, to: string, subject: string, body: string): ViewMessage => msg(`mail:${id}`, 'user', min, [{ type: 'mail', id, from_id: 'fx-dev', from: 'fixture-dev', subject, body, thread: `th-${id}`, read_at: null, to: [{ id: to, name: to, read_at: at(min - 1) }] }], { kind: 'mail' })
const notice = (id: string, min: number, body: string): ViewMessage => msg(id, 'system', min, [text(body)], { kind: 'notice' })
const work = (id: string, min: number, n: number, said: string): ViewMessage => msg(id, 'assistant', min, [
  ...Array.from({ length: n }, (_, k) => tool(`${id}-t${k}`, k % 3 ? 'Read' : 'Bash', k % 3 ? { file_path: `web/src/file${k}.tsx` } : { command: `npx vitest run part${k}` }, 'done', `${k + 3} passed`)),
  text(said),
])
const DAY: ViewMessage[] = [
  msg('d1', 'user', 300, [text('Fix the tree filter and add a test.')]),
  work('d2', 299, 9, 'The filter compared names case-sensitively. Fixed in `Tree.tsx`; the new test passes.'),
  mailOut('o1', 280, 'human', 'Tree filter fixed', 'One commit, tests green. Branch `fixture/tree`.'),
  mailIn('i1', 240, 'human', 'Also the phone layout', 'Check the tree at 360 px too; the rows looked cramped yesterday.'),
  notice('n1', 239.9, '[stam] You have 1 unread mail. Read it with the stam `read_mail` tool and act on it.'),
  work('d3', 239, 14, 'At 360 px the rows were 28 px; they are touch height now.'),
  mailIn('i2', 200, 'fx-review', 'Review: two nits', 'Rename `rowH` to `rowHeight`, and drop the unused import in `Tree.test.tsx`.'),
  notice('n2', 199.9, '[stam] You have 1 unread mail. Read it with the stam `read_mail` tool and act on it.'),
  work('d4', 199, 4, 'Both nits fixed.'),
  mailOut('o2', 190, 'fx-review', 'Nits fixed', 'Pushed; please re-check.'),
  notice('n3', 120, 'Child fixture-review finished.\n\nThe review passed with no further comments.'),
  work('d5', 119, 2, 'Review passed; reporting to the manager.'),
]

const stream = (s: ViewState) => ({ 'GET /api/agents/fx-dev/view': sse([{ type: 'state', state: s }]) })
// The view fills its pane, so the frame gives it a pane's height.
const Pane = () => <div style={{ height: 560 }}><OwnView id="fx-dev" onGone={() => {}} /></div>
const state1 = (name: string, s: ViewState) => ({ name, routes: stream(s), render: () => <Pane /> })
// The Tool summary step on, with a summary for each call of the conversation (S-1481).
const SUMMARIES = { 'POST /api/tool-summaries': { enabled: true, pending: [], summaries: {
  t1: { tool: 'read file', doing: 'reading the tree test before extending it' },
  t2: { tool: 'edit file', doing: 'adding a third row to the tree test' },
  t3: { tool: 'run tests', doing: 'running the tree test after the edit' },
} } }

export const stories: Story[] = [{
  name: 'Own view',
  group: 'Tree and shell',
  what: "stam's own view of an agent: its conversation drawn by stam, beside its terminal, which stays the fallback. Both show one session. Messages come live from the daemon's view stream; text goes through the mail renderer, so every mail component works in chat. A run of tool calls folds into one drawer, reasoning folds under Thinking, a mail to or from the agent shows as a card with its read state, and a permission request is answered here where the harness allows. While a turn runs, a working indicator sits where the next output will appear. The conversation reads as turns, like messages in a mail thread: each input (the human's message, a mail into the agent, a stam notice) is a card on top, and the agent's response runs full width below until the next input.",
  when: "An agent's `view:ID` tab in main, when its harness has a view; the executive assistant's or a chief of staff's drop-down uses it too. The switch in the pane's strip (a button on a phone) chooses between it and the terminal. If the daemon refuses the view (a 4xx), the terminal takes its place in every world that shows it.",
  code: ['web/src/views/OwnView.tsx#OwnView', 'web/src/views/ownview-model.ts#activity', 'web/src/views/ownview-model.ts#toolRuns', 'web/src/views/ownview-model.ts#layout', 'web/src/views/ownview-model.ts#turns', 'web/src/views/ownview-model.ts#turnKind'],
  rules: [
    "A file path in the conversation (S-1529) opens the file view at its line: in agent prose and notices, in a Read, Edit or Write call's path, and in a mail card. A relative path resolves in the viewed agent's cwd on its machine; in a mail card it resolves in the sender's cwd, and stays text when the sender is not in the registry.",
    "A stream event redraws only the turn that changed: turns keep their object when their input and items are the same messages, so a long conversation doesn't redraw every turn (S-1566).",
    "Agent prose spans the whole column, as wide as tool rows and cards; mail bodies and notices in the conversation keep the 75ch mail measure (S-1479).",
    'Until the first state arrives the view shows the loading mark (`Loading`), large, where the conversation will be.',
    'The conversation column is at most `--measure-conversation` (48rem) wide, centred in a scrolling pane padded `--pad-pane`; the newest message stays in sight.',
    "A tool's status is its icon and its colour together: pending `--text-muted`, running `--st-working`, done `--st-idle`, error `--st-errored`. A run of tool calls is one drawer, closed by default; its header counts the calls and shows the latest, so progress stays in view.",
    "With the Tool summary step on (S-1481), the tool groups on screen ask for their calls' summaries, the latest group and its latest call first; groups above or below the viewport aren't asked. A summary landing redraws only its own call and group.",
    'A permission that waits has a `--status-warning-fg` border and Allow once, Always, and Deny buttons; once answered, or when the harness cannot take the answer here, it reads as a status line ("Answer it in the terminal.").',
    'The working indicator is three dots in `--st-working` passing a slow wave over `--duration-working` while a tool runs or the agent writes, and breathing together while it thinks; a waiting permission stills it to a warning line, and reduced motion stills the dots (' + ds('Motion') + ').',
    'There is no bar under the conversation: the agent\'s tab icon carries its state (working, idle), and while a turn runs with an empty prompt input its send button is Stop. A view whose stream drops shows Reconnecting at the foot of the conversation, on a desktop and a phone. A failed stop shows under the prompt input, in error ink, and clears when the turn ends.',
    "Each input opens a turn, like a message in a mail thread: the human's message and mail to or from the human sit raised on `--surface-raised`, with a coloured rail and a \"From you\" or \"To you\" chip (S-1482), mail between agents on `--surface-page`, and a stam notice is one muted line that opens on a tap; a hairline (`--border-subtle`) separates turns.",
    'From another machine the view is read-only: sending, stopping, and answering go only through the daemon the browser reaches.',
  ],
  states: [
    state1('Conversation', state(TALK)),
    { name: 'Tool calls summarised', routes: { ...stream(state(TALK)), ...SUMMARIES }, render: () => <Pane /> },
    state1('Working: a tool runs', state(
      [...TALK.slice(0, 1), msg('m2', 'assistant', 1, [tool('t1', 'Bash', { command: 'npx vitest run' }, 'running')], { running: true })], { running: true })),
    state1('Working: writing', state(
      [...TALK.slice(0, 1), msg('m2', 'assistant', 1, [text('Looking at the filter now. The cause is')], { running: true })], { running: true })),
    state1('A permission asks', state(
      [...TALK.slice(0, 1), msg('m2', 'assistant', 1, [tool('t9', 'Bash', { command: 'rm -rf fixture-dir' }, 'pending'), { type: 'permission', id: 'p1', action: 'Bash', resources: ['rm -rf fixture-dir'], tool: 't9', status: 'asked' }], { running: true })],
      { running: true, permissions: [ASK] })),
    state1('Mail in the conversation', state([...TALK, MAIL])),
    state1('A long day in turns', state(DAY)),
    state1('Earlier messages to load', state(TALK, { older: 'cursor-1' })),
    state1('Read-only: prompts go to the terminal', state(TALK, { capabilities: { ...CAN, can_send: false, can_interrupt: false, can_approve: false } })),
    state1('No messages yet', state([])),
    { name: 'Loading', routes: { 'GET /api/agents/fx-dev/view': sse([]) }, render: () => <Pane /> },
    { name: 'The daemon refuses the view', routes: { 'GET /api/agents/fx-dev/view': reply(404, { error: 'fixture: this agent has no view' }) }, render: () => <Pane /> },
  ],
}]

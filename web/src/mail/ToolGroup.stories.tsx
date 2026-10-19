import { ToolCall, ToolGroup, type ToolCallItem } from './ToolGroup'
import { resetToolNames, seedNamesEnabled, seedToolName } from './tool-names'
import { resetToolSummaries, seedEnabled, seedToolSummary } from './tool-summaries'
import { OnMount } from '../stories/helpers'
import { ds, type Story } from '../stories/types'

const openFirst = (el: HTMLElement) => { el.querySelector('details')!.open = true }

const RUN: ToolCallItem[] = [
  { id: 't1', name: 'Read', input: { file_path: 'web/src/Tree.test.tsx' }, result: '42 lines', status: 'done' },
  { id: 't2', name: 'Edit', input: { file_path: 'web/src/Tree.test.tsx', old_string: 'rows(2)', new_string: 'rows(3)' }, result: 'edited', status: 'done' },
  { id: 't3', name: 'Bash', input: { command: 'npx vitest run web/src/Tree.test.tsx' }, result: '1 failed: expected 3, got 2', status: 'error' },
]
const AGENT = 'fixture-dev'
const MCP: ToolCallItem[] = [
  { id: 'm1', name: 'mcp__stam__send_mail', input: { to: 'convo-mgr', subject: 'Branch ready' }, result: 'sent', status: 'done' },
  { id: 'm2', name: 'mcp__claude_ai_Gmail__search_threads', input: { query: 'from:kim' }, result: '3 threads', status: 'done' },
]
// Both tools named: the label of the tool part, the server in front.
const named = () => { resetToolNames(); resetToolSummaries(); seedEnabled(false); seedNamesEnabled(true); seedToolName(AGENT, 'send_mail', { label: 'Send mail' }); seedToolName(AGENT, 'search_threads', { label: 'Search threads' }) }
// The daemon couldn't name them (no model or key): the prettified raw names.
const unnamed = () => { resetToolNames(); resetToolSummaries(); seedEnabled(false); seedNamesEnabled(false) }
const SUMS: Record<string, { tool: string; doing: string }> = {
  t1: { tool: 'read file', doing: 'reading the tree test to find the row count' },
  t2: { tool: 'edit file', doing: 'changing the tree test to expect three rows' },
  t3: { tool: 'run tests', doing: 'running the tree test after the edit' },
}
// The step on, every call of the run summarised.
const summarised = () => { resetToolSummaries(); seedEnabled(true); for (const t of RUN) seedToolSummary(AGENT, t.id, { s: SUMS[t.id], seen: 0 }) }
// The step on and the calls just shown, their summaries not here yet: they wait, drawn invisible.
// The wait starts far ahead, so the frame keeps showing it.
const waiting = () => { resetToolSummaries(); seedEnabled(true); for (const t of RUN) seedToolSummary(AGENT, t.id, { seen: Date.now() + 3_600_000 }) }
// The step on, the wait over with no summary: the calls show raw.
const timedOut = () => { resetToolSummaries(); seedEnabled(true); for (const t of RUN) seedToolSummary(AGENT, t.id, { seen: 0 }) }
// The daemon still at work on every call, so the state the frame seeds holds.
const STILL = { 'POST /api/tool-summaries': { enabled: true, summaries: {}, pending: RUN.map((t) => t.id) } }
// Raw first, then the summaries land and fade in over it.
const landLate = () => { for (const t of RUN) seedToolSummary(AGENT, t.id, { s: SUMS[t.id] }) }

export const stories: Story[] = [{
  name: 'Tool calls',
  group: 'Mail',
  what: "An agent's tool calls as the conversation draws them (S-1483). A tool call is one row: its status icon, name, and one-line input; open, its full input and its result. A tool group is a run of calls in one drawer, closed by default, whose header counts the calls and shows the latest, so progress stays in view while it's closed. A call carries a small icon by its tool (S-1934): the stam mark for stam MCP tools, a terminal for Bash, a file for Read and Write, a pencil for Edit, a magnifier for Grep and Glob, a globe for web tools, people for Agent, a plug for any other MCP server, and a wrench for a tool nothing knows. A call is named by its tool's label, one per tool (S-1933): a built-in as Read or Web search, an MCP tool with its server in front as stam · Send mail; the raw name is the hover title. With the Tool summary tiny model on (S-1481, off by default), a call reads as its summary instead: the tool in plain English, then what the agent is doing; open, the raw name and input come first.",
  when: "In an agent's own view (`web/src/views/OwnView.tsx`): each run of consecutive tool calls in a message is a group, broken by text, thinking, or a permission card. A lone call outside a run (inside a split message) is a plain tool call. Summaries are asked for only while the group shows (`web/src/mail/tool-summaries.ts`), the latest group and its latest call first.",
  code: ['web/src/mail/ToolGroup.tsx#ToolGroup', 'web/src/mail/ToolGroup.tsx#ToolCall'],
  rules: [
    "The icon (`src/tool-icons.ts`) is chosen from the harness and tool name alone, with no model call: the built-ins by their label in every harness's spelling (`Bash`, `exec_command`, `bash` are all a terminal). It is decoration, `aria-hidden`, drawn `--text-muted` at the small size between the status and the label, so a row doesn't grow or wrap.",
    "A tool's name is its stored label (`web/src/mail/tool-names.ts`): the built-ins of each harness are labelled in code, any other tool is named once by the summaries tiny model and kept, so a tool is named once however many agents show it. An MCP tool (`mcp__server__tool`) reads `server · Label`; the label is for the tool part only. Without a label, with the model off or the key missing, the name reads prettified: `mcp__stam__send_mail` is `stam · Send mail`, `Bash` stays `Bash`.",
    "A Read, Edit or Write call's one-line input, when it is the file's path, is a link to the file view (S-1529); a relative path resolves in the viewed agent's cwd. A click on it opens the file and does not toggle the call.",
    "A call's status is its icon and its colour together: pending `--text-muted`, running `--st-working`, done `--st-idle`, error `--st-errored`; an error's result is `--status-error-fg`.",
    'Rows are `--size-control` high, `--size-hit-touch` on a phone; the one-line input cuts with an ellipsis in `--font-mono` (' + ds('Density') + '). A summary is in the body font, its sentence cut with an ellipsis.',
    'Input and result scroll inside a code box at most twelve table rows high, so a long output never pushes the conversation away.',
    'A call waits up to `--duration-summary-hold` for its summary, drawn invisible so nothing moves; then it shows raw. A summary that lands after that fades in over the raw line, the raw out at `--duration-base` `--ease-in` and the summary in at `--duration-slow` `--ease-out` (' + ds('Motion') + '); reduced motion zeroes both. With the step off nothing waits.',
    "A call streamed into a group while its summary is held leaves the header on the previous call's line, so the header never goes blank; the new line fades in when its summary lands or its hold ends. Open, a call's sentence wraps instead of cutting.",
  ],
  states: [
    { name: 'Group of three, closed', render: () => <ToolGroup tools={RUN} /> },
    { name: 'Group open', render: () => <OnMount run={openFirst}><ToolGroup tools={RUN} /></OnMount> },
    { name: 'One call running', render: () => <ToolGroup tools={[{ id: 't4', name: 'Bash', input: { command: 'npm test' }, status: 'running' }]} /> },
    { name: 'Call, done, open', render: () => <OnMount run={openFirst}><ToolCall {...RUN[1]} /></OnMount> },
    { name: 'Call, empty result', render: () => <ToolCall name="Bash" input={{ command: 'true' }} result="" status="done" /> },
    { name: 'Call, pending', render: () => <ToolCall name="WebFetch" input={{ url: 'https://example.com/a/very/long/path/that/cuts/at/the/edge/of/a/phone' }} status="pending" /> },
    { name: 'Summarised, closed', setup: summarised, render: () => <ToolGroup tools={RUN} agent={AGENT} /> },
    { name: 'Summarised, open', setup: summarised, render: () => <OnMount run={(el) => { openFirst(el); el.querySelector<HTMLDetailsElement>('.ov-tools-rows details')!.open = true }}><ToolGroup tools={RUN} agent={AGENT} /></OnMount> },
    { name: 'Waiting for its summary', setup: waiting, routes: STILL, render: () => <ToolGroup tools={RUN} agent={AGENT} /> },
    { name: 'No summary in time: raw', setup: timedOut, routes: STILL, render: () => <ToolGroup tools={RUN} agent={AGENT} /> },
    { name: 'Summary lands late: fades in', setup: timedOut, routes: STILL, render: () => <OnMount run={landLate}><ToolGroup tools={RUN} agent={AGENT} /></OnMount> },
    { name: 'Icons by tool', render: () => <ToolGroup tools={[{ id: 'i1', name: 'Bash', status: 'done' }, { id: 'i2', name: 'Read', status: 'done' }, { id: 'i3', name: 'Edit', status: 'done' }, { id: 'i4', name: 'Grep', status: 'done' }, { id: 'i5', name: 'WebFetch', status: 'done' }, { id: 'i6', name: 'Task', status: 'done' }, { id: 'i7', name: 'mcp__stam__send_mail', status: 'done' }, { id: 'i8', name: 'mcp__x__y', status: 'done' }]} />, },
    { name: 'MCP tools, named', setup: named, render: () => <ToolGroup tools={MCP} agent={AGENT} /> },
    { name: 'MCP tools, open', setup: named, render: () => <OnMount run={(el) => { openFirst(el); for (const d of el.querySelectorAll<HTMLDetailsElement>('.ov-tools-rows details')) d.open = true }}><ToolGroup tools={MCP} agent={AGENT} /></OnMount> },
    { name: 'MCP tools, no label: prettified', setup: unnamed, render: () => <ToolGroup tools={MCP} agent={AGENT} /> },
    { name: 'Step off: raw, no wait', setup: () => { resetToolSummaries(); seedEnabled(false) }, render: () => <ToolGroup tools={RUN} agent={AGENT} /> },
  ],
}]

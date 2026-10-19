import { TypeView } from './TypeView'
import { large, small } from './inventory-fixture'
import { agent, AGENTS } from '../stories/fixtures'
import { ds, pending, reply, type Story } from '../stories/types'
import { OnMount } from '../stories/helpers'
import type { Agent, Itsa } from '../types'

const reg = {
  harnesses: { claude: {}, codex: {}, opencode: {} },
  types: {
    developer: { description: 'Makes one small, focused change on its own branch and reports to its parent.', harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
    reviewer: { description: 'Reviews one branch and posts a verdict.', harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' },
  },
}
const catalog = {
  blocks: [
    { id: 'stam-mcp-and-trust', title: 'The stam tools and who to trust', summary: 'How mail from the user and from other agents is trusted, and which tools reach stam.', tokens: 420, template: 'system-prompt', rendered: true, applies: true },
    { id: 'waiting-and-subscribing', title: 'Waiting and subscribing', summary: 'Declare a wait, subscribe to outside events, and schedule a note to yourself.', tokens: 310, template: 'system-prompt', rendered: true, applies: true },
    { id: 'shared-machine', title: 'The shared machine', summary: 'Other agents share the machine: never stop processes by a broad pattern.', tokens: 190, template: 'system-prompt', rendered: true, applies: true },
    { id: 'retro-record', title: 'Record a retro', summary: 'When something notable happens, record it with the retro tool.', tokens: 260, template: 'retro', rendered: true, applies: true },
  ],
  replacements: [{ path: 'blocks/_replace/short-waiting.md', id: 'short-waiting', title: 'Waiting, short', summary: 'A shorter wait rule.', tokens: 90 }],
}
const withBlocks = { ...reg, types: { ...reg.types, developer: { ...reg.types.developer, blocks: { off: ['shared-machine'], replace: { 'waiting-and-subscribing': 'blocks/_replace/short-waiting.md' }, order: ['waiting-and-subscribing', 'stam-mcp-and-trust', 'shared-machine'] } } } }
const stat = (median: number) => ({ n: 9, median, p75: median * 1.6 })
const activity = { note: 'fixture', by: 'type', since: '2026-09-14T00:00:00.000Z', rows: [{ type: 'developer', n: 9, working_s: stat(1500), waiting_s: stat(5400), cost_usd: stat(1.84), review_rounds: stat(1) }] }
const devs: Agent[] = Array.from({ length: 30 }, (_, i) => agent({
  id: `fx-d${i}`, name: `fixture-dev-${i + 1}`, type: 'developer', cost_usd: 0.4 + i / 7,
  lifecycle: i < 3 ? 'active' : i < 5 ? 'paused' : 'archived', activity: i < 3 ? 'working' : null,
  updated_at: new Date(Date.UTC(2026, 9, 14, 12, 0) - i * 3_600_000).toISOString(),
}))
const prop = (n: number, status: string, title: string, body: string): Itsa => ({
  id: `fx-p${n}`, key: `S-9${n}`, parent_id: null, kind: 'proposal', title, summary: null, body, status, owner: 'fx-cos', thread_id: null,
  created_by: 'fx-cos', created_at: '2026-10-10T09:00:00.000Z', updated_at: `2026-10-1${n}T09:00:00.000Z`, closed_at: null,
})
const itsas: Itsa[] = [
  prop(1, 'needs_approval', 'Developer: say when to open the pull request', 'Edits `templates/type-developer.md`: add a step before "report".'),
  prop(2, 'done', 'Reviewer: shorter verdicts', 'Edits `type-reviewer`.'),
  prop(3, 'in_progress', 'Developer: keep scratch files in ./tmp', 'Changes type-developer, section Working rules.'),
  { ...prop(4, 'todo', 'Not a proposal', 'type-developer mentioned in a plain issue'), kind: 'issue' },
]
const specialist = (i: number, ratio: number | null): Agent => agent({
  id: `fx-s${i}`, name: `fixture-specialist-${i}`, type: 'developer', standing: 1, lifecycle: 'active', activity: 'idle',
  updated_at: new Date(Date.UTC(2026, 9, 14, 13, 0) - i * 60_000).toISOString(),
  load: { open_itsas: i + 1, median_lead_s: i === 2 ? null : 5400 * (i + 1), lead_n: i === 2 ? 0 : 10, context_tokens: ratio == null ? null : Math.round(ratio * 500000), context_threshold: 500000, context_ratio: ratio, workspace_bytes: i === 2 ? null : 48_000 * (i + 1), workspace_files: i === 2 ? null : 12 * (i + 1) },
})
const specialists = [specialist(0, 0.82), specialist(1, 0.4), specialist(2, null)]
const seed = { agents: [...AGENTS, ...devs], itsas }
const memory = { items: [
  { id: 'fx-r1', key: 'S-701', title: 'Test run repeated after a green gate', kind: 'improve', target: 'developer-change', plusOnes: 3, status: 'idea', created_at: '2026-10-12T09:00:00.000Z', evidence: 'gate' },
  { id: 'fx-r2', key: 'S-702', title: 'Scratch files in ./tmp avoided a harness dialog', kind: 'went_well', target: 'none', plusOnes: 1, status: 'done', created_at: '2026-10-11T09:00:00.000Z', evidence: 'human' },
  { id: 'fx-r3', key: 'S-703', title: 'Instruction says chain commands, the harness blocks it', kind: 'instruction', target: 'type-developer', plusOnes: 0, status: 'in_progress', created_at: '2026-10-10T09:00:00.000Z', evidence: 'none' },
], effort: [], coverage: { archived: 0, withRound: 0, without: [] } }
const skillList = [
  { name: 'fixture-style', path: '/home/fixture/.claude/skills/fixture-style', source: 'user', description: 'How to write every answer: lead with the outcome, keep it short.', tokens: 2500, extraTokens: 0, reaches: { claude: 'native', opencode: 'native', codex: 'native' }, attachedTo: ['developer'], bodySummary: { state: 'off' } },
  { name: 'fixture-brainstorm', path: '/home/fixture/.stam/skills/fixture-brainstorm', source: 'stam', description: 'Parallel divergent ideation under several frames, then scoring and pruning.', tokens: 2900, extraTokens: 0, reaches: { claude: 'native', opencode: 'native', codex: 'native' }, attachedTo: [], bodySummary: { state: 'off' } },
]
const withSkills = { ...reg, types: { ...reg.types, developer: { ...reg.types.developer, skills: ['fixture-style'] } } }
const withGoneSkill = { ...reg, types: { ...reg.types, developer: { ...reg.types.developer, skills: ['fixture-style', 'fixture-removed'] } } }
const routes = { 'GET /api/skills': skillList, 'GET /api/retros?type=developer': memory, 'GET /api/blocks/composing': catalog, 'GET /api/config/settings': { text: '{}' }, 'GET /api/registry': reg, 'GET /api/types/developer/inventory': large, 'GET /api/activity?by=type': activity }
const tab = (label: string) => (host: HTMLElement) => { [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')].find((b) => b.textContent === label)?.click() }

export const stories: Story[] = [{
  name: 'Type page',
  group: 'Settings',
  what: 'One agent type in a page of its own: its description and preset (harness, model, effort), then five tabs. Instructions starts with the composer: a switch per block (off strikes it through and writes `blocks.off`), a replacement picker for the files in `blocks/_replace/`, Move up and Move down icon buttons beside the token badge (`blocks.order`), and a sticky footer with the running token total, Discard, Save and Preview as agent, which opens the saved type\'s inventory for a synthetic agent on each harness; saving goes through `POST /api/types/NAME`, from a peer to the home, and a peer with no home page sees it read-only. Below it are the type\'s composed blocks as the Inventory\'s cards, with a picker for the other harnesses it can run on and the token total. Skills lists every skill stam can deliver with a switch to attach it to the type (`skills` in the registry); an attached skill reaches the type\'s agents as a "Skills available" block, one line of name, description and the path to its `SKILL.md`, after the type\'s instructions and before its memory, on every harness; the footer shows the block\'s tokens, and saving goes through `POST /api/types/NAME`, human-only. Memory lists the type\'s retro items, open and done, that its agents reported or that target `type-NAME` or one of its block ids, ranked by evidence, then +1s, as the Retros page ranks them; the curated notes block, "Before you start", is one of the Instructions cards when the type has one. Agents starts with the type\'s standing specialists, each with its load from the daemon (ITSAs it owns that are ready or active, median lead time over its last ten closed ITSAs, context size as a share of the compaction threshold, and its workspace size in bytes and files); then it lists its live agents first, then the 12 most recent, over the median cost and the median working and waiting time of its closed ITSAs. Proposals lists the retro-loop proposals that name the type\'s template, `type-NAME`. Only the composer writes.',
  when: 'Settings › Agent types › a type › Type page, and an agent\'s menu in the tree or the pane menu, "The NAME type" (world `w:type:NAME`).',
  code: ['web/src/views/TypeView.tsx#TypeView', 'web/src/views/TypeView.tsx#proposalTouches', 'web/src/views/TypeView.tsx#agentsOfType', 'web/src/views/TypeView.tsx#specialistsOf', 'web/src/views/TypeComposer.tsx#TypeComposer', 'web/src/views/TypeSkills.tsx#TypeSkills', 'web/src/views/type-skills.ts#blockTokens', 'web/src/views/type-compose.ts#blocksPayload'],
  rules: [
    'A specialist row is an agent row with a second line of load numbers: open ITSAs, lead time, context as a percent of the threshold, and workspace size. A number that has no data reads "–", never a zero; a workspace walk cut at 5,000 files ends in "+".',
    'Tabs are the Usage tabs: `--size-tab-bar` high, `--size-hit-touch` on a phone, the selected one underlined by `--tab-indicator-focused` (' + ds('Density') + ').',
    'Memory rows are the Retros page\'s `retro-row`: key, title, kind chip, status chip, target and +1 count, `--size-hit-touch` high and wrapping on a phone.',
    'Agent and proposal rows are `surface-raised` with a hairline and no shadow, `--size-row-menu` high and `--size-hit-touch` on a phone; the state or status is a chip with a word, never colour alone.',
    'The composer\'s switches, Move up and Move down icon buttons (labelled for screen readers) and selects are `--size-hit-touch` on a phone, where order is changed by buttons, not by drag; each block is one compact row of switch, badge and arrows, so more blocks fit a screen. It is calm at rest: no animation; an off block is struck through and says "off" in its label, so state never rests on colour. Its footer is sticky, `surface-pane` over a `--border-default` hairline. On a phone it is one row, the token count (the "before the first turn" note and the saved total are dropped) beside an icon-only Preview as agent, Discard and Save, so the block list keeps most of the screen.',
    'The Skills tab reuses the composer\'s rows, switches and sticky footer, so the same sizes and the same read-only rule hold. An attached skill says "attached" in its switch label; a skill that is no longer installed is named in a note and dropped on the next save, never an error.',
    'The block cards are the Inventory\'s, unchanged. Only design-system tokens; the page adds no colour, size or duration.',
  ],
  states: [
    { name: 'Instructions, realistic scale', data: seed, routes, render: () => <TypeView name="developer" /> },
    { name: 'Composer, a type with blocks switched off and replaced', data: seed, routes: { ...routes, 'GET /api/registry': withBlocks }, render: () => <TypeView name="developer" /> },
    { name: 'Composer, read-only on a peer', data: seed, routes: { ...routes, 'GET /api/config/settings': { text: '{}', home: 'fixture-home' } }, render: () => <TypeView name="developer" /> },
    { name: 'Composer, loading', data: seed, routes: { ...routes, 'GET /api/blocks/composing': pending() }, render: () => <TypeView name="developer" /> },
    { name: 'Composer, block list did not load', data: seed, routes: { ...routes, 'GET /api/blocks/composing': reply(503, { error: 'fixture: unreachable' }) }, render: () => <TypeView name="developer" /> },
    { name: 'Instructions, few blocks', data: seed, routes: { ...routes, 'GET /api/types/developer/inventory': small }, render: () => <TypeView name="developer" /> },
    { name: 'Skills, loading', data: seed, routes: { ...routes, 'GET /api/skills': pending() }, render: () => <OnMount run={tab('Skills')}><TypeView name="developer" /></OnMount> },
    { name: 'Skills, none attached', data: seed, routes, render: () => <OnMount run={tab('Skills')}><TypeView name="developer" /></OnMount> },
    { name: 'Skills, one attached', data: seed, routes: { ...routes, 'GET /api/registry': withSkills }, render: () => <OnMount run={tab('Skills')}><TypeView name="developer" /></OnMount> },
    { name: 'Skills, one no longer installed', data: seed, routes: { ...routes, 'GET /api/registry': withGoneSkill }, render: () => <OnMount run={tab('Skills')}><TypeView name="developer" /></OnMount> },
    { name: 'Skills, read-only on a peer', data: seed, routes: { ...routes, 'GET /api/registry': withSkills, 'GET /api/config/settings': { text: '{}', home: 'fixture-home' } }, render: () => <OnMount run={tab('Skills')}><TypeView name="developer" /></OnMount> },
    { name: 'Skills, list did not load', data: seed, routes: { ...routes, 'GET /api/skills': reply(503, { error: 'fixture: unreachable' }) }, render: () => <OnMount run={tab('Skills')}><TypeView name="developer" /></OnMount> },
    { name: 'Memory', data: seed, routes, render: () => <OnMount run={tab('Memory')}><TypeView name="developer" /></OnMount> },
    { name: 'Memory, none', data: seed, routes: { ...routes, 'GET /api/retros?type=developer': { ...memory, items: [] } }, render: () => <OnMount run={tab('Memory')}><TypeView name="developer" /></OnMount> },
    { name: 'Agents', data: seed, routes, render: () => <OnMount run={tab('Agents')}><TypeView name="developer" /></OnMount> },
    { name: 'Agents, loading', data: { ...seed, agents: [], loaded: { agents: false, mail: true, itsas: true } }, routes, render: () => <OnMount run={tab('Agents')}><TypeView name="developer" /></OnMount> },
    { name: 'Agents, with standing specialists', data: { ...seed, agents: [...seed.agents, ...specialists] }, routes, render: () => <OnMount run={tab('Agents')}><TypeView name="developer" /></OnMount> },
    { name: 'Agents, no medians yet', data: seed, routes: { ...routes, 'GET /api/activity?by=type': { ...activity, rows: [] } }, render: () => <OnMount run={tab('Agents')}><TypeView name="developer" /></OnMount> },
    { name: 'Proposals', data: seed, routes, render: () => <OnMount run={tab('Proposals')}><TypeView name="developer" /></OnMount> },
    { name: 'Proposals, none', data: { ...seed, itsas: [] }, routes, render: () => <OnMount run={tab('Proposals')}><TypeView name="developer" /></OnMount> },
    { name: 'Inventory error', data: seed, routes: { ...routes, 'GET /api/types/developer/inventory': reply(503, { error: 'fixture: unreachable' }) }, render: () => <TypeView name="developer" /> },
    { name: 'Unknown type', data: seed, routes, render: () => <TypeView name="ghost" /> },
  ],
}]

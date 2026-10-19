import { SpawnPanel, HarnessMark, spawnMenu } from './spawn'
import { byName } from './stories/fixtures'
import { OnMount, Row } from './stories/helpers'
import { ds, reply, type Story } from './stories/types'

// An invented registry: the harnesses, their models and efforts, presets and agent types.
const REGISTRY = {
  harnesses: { claude: { efforts: ['low', 'medium', 'high'] }, codex: { efforts: ['low', 'medium', 'high'] }, opencode: {} },
  models: {
    'claude-opus-5-5': { harnesses: ['claude'], efforts: ['low', 'medium', 'high'] },
    'claude-haiku-5-5': { harnesses: ['claude'] },
    'gpt-6.1-sol': { harnesses: ['codex'], efforts: ['low', 'medium', 'high'] },
    'openrouter/fixture/flash': { harnesses: ['opencode'] },
  },
  presets: {
    standard: { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', description: 'The default for new agents' },
    cheap: { harness: 'claude', model: 'claude-haiku-5-5', description: 'Small, clear work' },
    review: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'low', description: 'Reads a diff' },
  },
  types: {
    developer: { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', description: 'Makes one small change' },
    reviewer: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'low', description: 'Reviews a branch' },
  },
}
const ROUTES = {
  'GET /api/registry': REGISTRY,
  'GET /api/config/settings': { text: JSON.stringify({ spawnDefaults: { preset: 'standard', cwd: '~' } }) },
}
const click = (el: HTMLElement, text: string) => [...el.ownerDocument.querySelectorAll<HTMLElement>('.menu [role^=menuitem]')].find((b) => b.textContent?.includes(text))?.click()
const openMenu = (base = {}) => () => { void spawnMenu(12, 12, base) }
// Opens the quick menu, then its More options… entry, which opens the panel.
const openPanel = (el: HTMLElement) => { void spawnMenu(12, 12).then(() => click(el, 'More options')) }
// Drives a Pick row to show its options menu.
const pick = (label: string) => (el: HTMLElement) => { openPanel(el); setTimeout(() => el.ownerDocument.querySelector<HTMLElement>(`.sp-row[data-pick="${label}"]`)?.click(), 60) }

export const stories: Story[] = [{
  name: 'Add-agent menu',
  group: 'Tree and shell',
  what: "The quick menu for adding an agent. The defaults come first and add one with a single click, then each agent type, each preset, and each harness as a submenu of its models, each with its efforts. More options… opens the full panel. From an agent's own menu, the same list adds a child of that agent.",
  when: "The + button above the agent tree (`web/src/Tree.tsx`) and an agent's **Add child agent…** item (`web/src/actions.tsx#agentMenu`). It waits for the registry once, then shows what it has while it refreshes.",
  code: ['web/src/spawn.tsx#spawnMenu', 'web/src/spawn.tsx#spawn', 'web/src/spawn.tsx#HarnessMark', 'web/src/spawn.tsx#modelName'],
  rules: [
    'A menu row is `--size-row-menu`; on a phone `--size-hit-touch` (' + ds('Density') + ').',
    'The harness mark carries its hue (`--h-claude`, `--h-codex`, `--h-opencode`) and no state ring, because no agent exists yet.',
    'Adding selects the new agent and shows one toast; nothing animates.',
  ],
  states: [
    { name: 'Top level', height: 440, routes: ROUTES, render: () => <OnMount run={openMenu()} /> },
    { name: 'Adding a child', height: 440, routes: ROUTES, render: () => <OnMount run={openMenu({ parent: byName('fixture-dev').id })} /> },
    { name: 'Registry unreachable', height: 220, routes: { ...ROUTES, 'GET /api/registry': reply(503, { error: 'fixture: unreachable' }) }, render: () => <OnMount run={openMenu()} /> },
  ],
}, {
  name: 'Harness mark',
  group: 'Primitives',
  what: "A harness's icon in its hue, with no state ring: for a choice of harness before an agent exists (the add menu, the panel's rows). An unknown harness shows a generic bot.",
  when: "Beside every harness, preset and type in the add-agent menu and panel (`web/src/spawn.tsx#spawnMenu`).",
  code: ['web/src/spawn.tsx#HarnessMark'],
  rules: ['Only the harness hue colours it, so a colour never means two things (' + ds('In stam') + ').'],
  states: [{ name: 'Each harness', render: () => <Row items={['claude', 'codex', 'opencode', 'unknown'].map((h) => ({ label: h, node: <HarnessMark harness={h} /> }))} /> }],
}, {
  name: 'Add-agent panel',
  group: 'Tree and shell',
  what: "Everything about a new agent in one form: type, harness, model, effort, folder, worktree, standing, workspace, parent, permission mode, an optional name, and a first prompt. Each choice is a row that opens a menu of options; the folder row can switch to a typed path. Picking a type fills the harness, model and effort, which stay changeable. A harness change keeps the model and effort it supports, else the default. A failed add shows the error under the fields and keeps what was typed.",
  when: "**More options…** in the add-agent menu (`web/src/spawn.tsx#spawnMenu`). On a phone it is a sheet that shrinks above the keyboard; Escape or a press outside closes it, Ctrl+Enter adds.",
  code: ['web/src/spawn.tsx#SpawnPanel', 'web/src/spawn.tsx#spawnPanelOpen', 'web/src/spawn.tsx#closeSpawnPanel'],
  rules: [
    'A row is `--size-row-menu`; on a phone `--size-hit-touch` (' + ds('Density') + '). The sheet sits at `--z-modal`.',
    'Bypass permissions uses the `danger` tone and says it never asks; Auto mode is the default.',
    'The focus returns to the row after a pick, and ArrowUp and ArrowDown move between rows, so the form works by keyboard alone.',
    'Standing (pauses when idle instead of finishing) and Workspace (a personal notes folder, kept when the agent is archived) are sent only when ticked; ticking Standing ticks Workspace, which stays changeable.',
    'Name is limited to lowercase letters, digits and hyphens as it is typed.',
  ],
  states: [
    { name: 'Defaults', height: 700, routes: ROUTES, render: () => <><OnMount run={openPanel} /><SpawnPanel /></> },
    { name: 'Model options open', height: 700, routes: ROUTES, render: () => <><OnMount run={pick('Model')} /><SpawnPanel /></> },
    { name: 'Harness options open', height: 700, routes: ROUTES, render: () => <><OnMount run={pick('Harness')} /><SpawnPanel /></> },
    { name: 'Standing with a workspace', height: 760, routes: ROUTES, render: () => <><OnMount run={(el) => { openPanel(el); setTimeout(() => [...el.ownerDocument.querySelectorAll<HTMLInputElement>('.spawn-panel .sp-check input')].find((i) => i.parentElement?.textContent?.startsWith('Standing'))?.click(), 80) }} /><SpawnPanel /></> },
    { name: 'Add fails', height: 700, routes: { ...ROUTES, 'POST /api/agents': reply(400, { error: 'fixture: the folder does not exist' }) },
      render: () => <><OnMount run={(el) => { openPanel(el); setTimeout(() => el.ownerDocument.querySelector<HTMLElement>('.spawn-panel button[type=submit]')?.click(), 80) }} /><SpawnPanel /></> },
  ],
}]

// What the Settings stories share: an invented settings.json, registry, templates and tool
// catalogue, and the routes that serve them (the stub in fixtures.ts answers by route). Nothing
// here comes from a live daemon: names are fixture-*, hosts are example.com, tokens are fake.
import { reply } from './types'
import type { CacheAgent } from '../views/CacheSettings'

export const SETTINGS = {
  assistant: { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', cwd: '' },
  assistantDefault: 'assistant',
  chiefOfStaff: 'fixture-cos',
  spawnDefaults: { preset: 'fixture-dev', cwd: '~' },
  agentView: { default: 'terminal' },
  humanMail: { when: 'necessary', models: { 'claude-haiku-5-5': false } },
  decisions: { mailCheck: true },
  promptDefaultMode: 'mail',
  mail: { titles: { model: '' } },
  tiny: { toolSummary: { enabled: false, model: 'google/gemma-3-4b-it', instructions: '' }, toolNames: { enabled: true, model: 'google/gemma-3-4b-it' }, mailTitles: { titleInstructions: '', summaryInstructions: '' }, blockSummaries: { instructions: '' } },
  activity: { classify: { enabled: true, maxUsdPerDay: 0.5, concurrency: 2 } },
  context: { warnTokens: 150000, instructTokens: 200000, enforceTokens: 250000 },
  idleCompaction: { enabled: true, growthTokens: 40000, idleMinutes: 50, minTokens: 60000 },
  rest: { enabled: true, afterMinutes: 20, graceMinutes: 2 },
  cost: {
    instructions: 'Keep reviewers on the cheap model unless the change touches shared code.',
    dailyWarnUsd: 25,
    subscriptionWarnPercent: [50, 80, 95],
    display: { mode: 'api', prices: { 'fixture-claude': 200 } },
    accounts: { 'fixture-claude': {}, 'fixture-codex': {} },
  },
  peers: [{ name: 'fixture-peer', url: 'https://fixture-peer.example.com', token: 'fixture-token' }],
  resourceWarn: { enabled: true, loadPerCore: 1.5, ramAvailableGb: 2, swapPct: 50, diskPct: 85, repeatMinutes: 30, recipients: [] },
  requirements: { enabled: false },
  mcpServers: {
    'fixture-docs': { url: 'https://mcp.example.com/mcp', auth: { type: 'oauth' } },
    'fixture-files': { command: 'npx', args: ['-y', 'fixture-files-mcp', '--root', '/home/fixture/project'], env: { FIXTURE_KEY: 'fixture-secret' } },
    'fixture-off': { command: 'fixture-mcp', enabled: false },
  },
  banners: [],
}

// What GET /api/tiny-models returns (src/tiny-models.ts), shortened.
const NO_PROMPT = { default: '', editable: false, path: null }
export const TINY_MODELS = [
  { id: 'decisions', label: 'Decisions', enabled: true, model: 'microsoft/microsoft-decision-1', usedBy: 'Mail checks, decision steps, requirement checks, activity classifier', purpose: 'Answers a fixed question about a piece of state.', toggle: null, modelPath: 'decisions.model', instructions: { ...NO_PROMPT, note: 'Its questions live in src/mail-check.ts.' }, extras: [
    { path: 'decisions.mailCheck', kind: 'bool', label: 'Check my mail', help: 'Ask whether each mail to you follows the rules.' },
    { path: 'decisions.mailGate', kind: 'bool', label: 'Check mail before it is sent', help: 'Refuse a mail that fails the check.' }] },
  { id: 'mailTitles', label: 'Mail titles', enabled: false, model: '', usedBy: null, purpose: 'Gives every mail a title of one to three words.', toggle: null, modelPath: 'mail.titles.model', instructions: { default: 'You title mail. Answer with a title of one to three words.', editable: true, path: 'tiny.mailTitles.titleInstructions', note: 'Titles a mail. An empty model turns the step off.' }, more: [{ label: 'Summary prompt', default: 'You title and summarize mail. First line: "Title: ", then "Summary: " and a condensed version of the mail.', editable: true, path: 'tiny.mailTitles.summaryInstructions', note: 'Titles a mail to you and also summarises it for the swipe cards. The reply must keep the "Title:" and "Summary:" lines.' }], extras: [] },
  { id: 'blockSummaries', label: 'Instruction summaries', enabled: false, model: '', usedBy: null, purpose: 'Summarises each instruction block.', toggle: null, modelPath: 'instructions.summaries.model', instructions: { default: 'You summarise one block of standing instructions.', editable: true, path: 'tiny.blockSummaries.instructions' }, extras: [] },
  { id: 'activityClassify', label: 'Activity classifier', enabled: false, model: 'microsoft/microsoft-decision-1', usedBy: null, purpose: 'Labels the activity items the rules cannot settle.', toggle: 'activity.classify.enabled', modelPath: 'decisions.model', instructions: NO_PROMPT, extras: [
    { path: 'activity.classify.maxUsdPerDay', kind: 'number', label: 'Daily cap', help: 'No more than this is spent in a UTC day.', unit: '$', min: 0, step: 0.05 }] },
  { id: 'toolSummary', label: 'Tool summary', enabled: false, model: 'google/gemma-3-4b-it', usedBy: null, purpose: 'Summarises one tool call into two fields.', toggle: 'tiny.toolSummary.enabled', modelPath: 'tiny.toolSummary.model', instructions: { default: 'Summarise one tool call. Answer with JSON: {"tool": "...", "doing": "..."}.', editable: true, path: 'tiny.toolSummary.instructions' }, extras: [] },
  { id: 'toolNames', label: 'Tool names', enabled: true, model: 'google/gemma-3-4b-it', usedBy: null, purpose: 'Names each tool once in plain English.', toggle: 'tiny.toolNames.enabled', modelPath: 'tiny.toolNames.model', instructions: { default: 'You name one tool an AI coding agent can call.', editable: false, path: null }, extras: [] },
]

export const REGISTRY = {
  harnesses: { claude: { efforts: ['low', 'medium', 'high'] }, codex: { efforts: ['low', 'medium', 'high'] }, opencode: {} },
  models: {
    'claude-opus-5-5': { harnesses: ['claude'] }, 'claude-sonnet-5-5': { harnesses: ['claude'] }, 'claude-haiku-5-5': { harnesses: ['claude'] },
    'gpt-6.1-sol': { harnesses: ['codex'] }, 'openrouter/fixture/flash': { harnesses: ['opencode'] },
  },
  presets: {
    'fixture-dev': { harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', description: 'A developer for one small change.' },
    'fixture-review': { harness: 'codex', model: 'gpt-6.1-sol', effort: 'low', description: 'A reviewer with a cheap window.' },
    'fixture-flash': { harness: 'opencode', model: 'openrouter/fixture/flash', description: 'Cheap work on OpenRouter.' },
  },
  defaultReviewer: 'fixture-reviewer',
  types: {
    developer: { description: 'Makes one small, focused change.', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', brief: 'Task: {{task}}\n\nWhen you are done, mail {{parent}}.' },
    'fixture-tester': { description: 'Runs the tests and reports.', harness: 'opencode', model: 'openrouter/fixture/flash', child_notices: 'none', visibility: { reach: 'parent' } },
    'fixture-reviewer': { description: 'Reviews a branch.', harness: 'codex', model: 'gpt-6.1-sol', effort: 'low', review: { fallback: 'fixture-backup', ring: null } },
    'fixture-backup': { description: 'Reviews when the first account is held.', harness: 'claude', model: 'claude-opus-5-5', effort: 'low', review: { fallback: null, ring: null } },
    'fixture-ring': { description: 'Two reviewers take turns.', harness: '', review: { fallback: null, ring: { format: 'rounds', members: ['fixture-reviewer', 'fixture-backup'], moderator: null, maxRounds: 3 } } },
  },
}

// What GET /api/permission-modes returns (src/permission-modes.ts): Ask is offered for Claude only.
const mode = (harness: string, offered: boolean) => [
  { mode: 'default', label: 'Ask', harness: `${harness} asks`, offered },
  { mode: 'auto', label: 'Auto', harness: `${harness} auto`, offered: true },
  { mode: 'bypass', label: 'Bypass', harness: `${harness} bypass`, offered: true },
]
export const PERMISSION_MODES = {
  settings: { harness: { claude: 'auto', codex: 'auto', opencode: 'auto' }, types: {} },
  harnesses: { claude: mode('--permission-mode', true), codex: mode('codex', false), opencode: mode('opencode', false) },
  types: ['developer', 'fixture-tester'],
  stale: [] as unknown[],
}
export const STALE_AGENTS = [
  { id: 'fx-dev', name: 'fixture-dev', harness: 'claude', type: 'developer', mode: 'auto', want: 'bypass', inPlace: true, failed: null },
  { id: 'fx-oc', name: 'fixture-flash', harness: 'opencode', type: 'fixture-tester', mode: 'auto', want: 'bypass', inPlace: false, failed: null },
  { id: 'fx-down', name: 'fixture-review', harness: 'codex', type: null, mode: 'auto', want: 'bypass', inPlace: true, failed: 'fixture: the launch failed' },
]

export const TEMPLATES = [
  { name: 'system-prompt', text: '# {{name}}\n\nYou are an agent in stam. Work in {{cwd}}.', overridden: false },
  { name: 'chief-of-staff', text: 'You coordinate the other agents.', overridden: true },
  { name: 'assistant', text: 'You route what the human writes.', overridden: false },
  { name: 'type-developer', text: 'You make one small change per task.', overridden: false },
  { name: 'mail-to-human', text: 'Mail the human only for a decision.', overridden: false },
  { name: 'mail-arrived', text: 'You have mail from {{from}}.', overridden: false },
  { name: 'permission-asked', text: '{{name}} asks: {{what}}', overridden: true },
]

// The scope fields GET /api/config/settings sends beside the file's text (settings-scope.ts).
export interface Scope { home?: string; local?: string[]; stale?: boolean; fetchedAt?: string | null; homeWeb?: string }
export const LOCAL = ['home', 'peers', 'itsa.home', 'itsa.repos', 'resourceWarn.lastWarned']

export const settingsRoutes = (scope: Scope = { home: 'fixture-machine', local: LOCAL }, settings: unknown = SETTINGS): Record<string, unknown> => ({
  'GET /api/config/settings': { text: JSON.stringify(settings), ...scope },
  'GET /api/registry': REGISTRY,
  'GET /api/tiny-models': { models: TINY_MODELS },
  'GET /api/assistant': { agent: null },
  'GET /api/templates': TEMPLATES,
  'GET /api/config/instructions': { text: '# My instructions\n\nPrefer small commits.' },
  'GET /api/config/registry': { text: '{}' },
  'GET /api/models?kind=harness&harness=claude': { models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5', in: 5, out: 25 }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', in: 3, out: 15 }, { id: 'claude-haiku-5-5', name: 'Haiku 5.5', in: 1, out: 5 }] },
  'GET /api/models?kind=harness&harness=codex': { models: [{ id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', in: 2, out: 10 }] },
  'GET /api/models?kind=harness&harness=opencode': { models: [{ id: 'openrouter/fixture/flash', name: 'Fixture Flash', in: 0.1, out: 0.4 }] },
  'GET /api/models?kind=openrouter': { models: [{ id: 'fixture/small', name: 'Fixture Small', in: 0.05, out: 0.1 }] },
  'GET /api/itsas/fields': [],
  'GET /api/permission-modes': PERMISSION_MODES,
  'PATCH /api/config/settings': { text: JSON.stringify(settings) },
  'GET /api/cache/agents': { agents: CACHE_AGENTS, offline: [] },
})

// Settings › Prompt caching (S-2239): each agent's detected cache window, as GET /api/cache/agents sends it.
const ttlAt = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString()
export const cacheAgent = (name: string, o: Partial<CacheAgent> = {}): CacheAgent => ({ id: `fx-${name}`, name, machine: 'fixture-machine', harness: 'claude', model: 'claude-opus-5-5', lifecycle: 'active', account: 'fixture-claude', paid: false, ttl: '1h', ttl_at: ttlAt(3), ...o })
export const CACHE_AGENTS: CacheAgent[] = [
  cacheAgent('fixture-dev'),
  cacheAgent('fixture-waiter', { ttl_at: ttlAt(40), lifecycle: 'paused' }),
  cacheAgent('fixture-new', { ttl: null, ttl_at: null }),
  cacheAgent('fixture-review', { harness: 'codex', model: 'gpt-6.1-sol', account: 'fixture-codex', ttl: null, ttl_at: null }),
]

// A save that the daemon refuses, and one that waits for the human (a 202 {requested}).
export const SAVE_REFUSED = { 'PATCH /api/config/settings': reply(403, { error: 'fixture: settings.json is read-only' }) }
export const SAVE_ASKS = { 'PATCH /api/config/settings': reply(202, { requested: 'fixture-req-1' }) }

// Waits for `find` to return an element (a list drawn after its fetch), then runs `act` on it.
function when<T extends HTMLElement>(find: () => T | undefined, act: (found: T) => void) {
  const go = () => {
    const f = find()
    if (f) act(f)
    else setTimeout(go, 20)
  }
  go()
}
const labelled = (root: ParentNode, sel: string, text: string) => [...root.querySelectorAll<HTMLElement>(sel)].find((x) => x.textContent?.startsWith(text))

// Opens the Settings section with this label, as a tap on its nav item does.
export const openSection = (label: string) => (el: HTMLElement) => when(() => labelled(el, '.settings-nav .item', label), (b) => b.click())

// Opens a section, then presses the button in its body that starts with `text` (a choice card,
// a segment, a list row), as a reader would.
export const pressIn = (label: string, text: string) => (el: HTMLElement) =>
  when(() => labelled(el, '.settings-nav .item', label), (b) => {
    b.click()
    when(() => labelled(el, '.settings-body button', text), (x) => x.click())
  })

// Presses, one after another, the first button (or row button) whose text starts with each label,
// waiting for each to appear: a list opening a form, a form opening a panel.
export const pressEach = (...labels: string[]) => (el: HTMLElement) => {
  const next = (i: number) => {
    if (i >= labels.length) return
    when(() => labelled(el, 'button, summary', labels[i]), (b) => { b.click(); setTimeout(() => next(i + 1), 30) })
  }
  next(0)
}

// @vitest-environment jsdom
// Smoke tests: each view renders from a stubbed daemon and its main interactions call the API.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as shell from '../shell/layout'
import { Glyph } from '../Glyph'
import { showLegend, STATES } from '../legend'
import { setData } from '../store'
import { MenuLayer } from '../ui/menu'
import type { Agent } from '../types'
import { ConfigView } from './ConfigView'
import { SECTIONS } from './configSections'
import { DetailsView } from './DetailsView'
import { agentTooltip } from './registry'
import { UsageView } from './UsageView'
import { DEFAULT_STATE, getUsageState, setUsageState, type UsageTab } from '../usage/state'
import { nameFrom } from './StepsSettings'
import { WaitMark } from '../waits'
import { WorkColumnsSettings } from './WorkColumnsSettings'
import { SkillsSettings } from './SkillsSettings'
import { SUMMARY, SUMMARY_EMPTY } from '../usage/activity/summaryFixture'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a1', name: 'lead', harness: 'claude', model: 'claude-opus-4-8', lifecycle: 'active', activity: 'idle', machine: 'alpha',
  cwd: '/work', created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z', context_tokens: 100000, context_level: 0,
  context_window: 1000000, cost_usd: 1.5, permission_mode: 'auto', parents: [], unread: 2, ...over,
})

const SETTINGS = {
  assistant: { harness: 'claude', model: 'claude-opus-4-8', effort: null, cwd: '' },
  spawnDefaults: { preset: 'fast', cwd: '~' }, humanMail: { when: 'necessary' },
  context: { warnTokens: 300000, instructTokens: 400000, enforceTokens: 500000 },
  idleCompaction: { enabled: true, idleMinutes: 30, growthTokens: 50000, minTokens: 100000 },
  cost: { dailyWarnUsd: null, subscriptionWarnPercent: [50] }, peers: [],
  mcpServers: {
    local: { command: 'npx', args: ['-y', 'srv'], env: { API_KEY: 'sekret' } },
    remote: { url: 'https://mcp.example.com/mcp', auth: { type: 'oauth' } },
    slack: { url: 'https://mcp.slack.com/mcp', auth: { type: 'oauth' } },
    'slack-app': { url: 'https://mcp.slack.com/mcp', auth: { type: 'oauth', client_id: 'A1', client_secret: 's' } },
  },
}
const REGISTRY = {
  harnesses: { claude: { efforts: ['low', 'high'] }, codex: { efforts: [] } },
  models: { 'claude-opus-4-8': { harnesses: ['claude'] }, 'gpt-5': { harnesses: ['codex'] } },
  presets: { fast: { harness: 'claude', model: 'claude-opus-4-8', description: 'Quick' } },
}
const USAGE = {
  today: { cost_usd: 4.2, tokens_in: 12000, tokens_out: 3000 },
  subscriptions: [],
  accounts: [
    { account: 'claude-max', match: { harness: 'claude' },
      windows: { five_hour: { used_percentage: 40, resets_at: 1800000000 }, seven_day: { used_percentage: 12 } },
      updated_at: '2026-10-11T00:00:00Z', age_ms: 1000, stale: false,
      paid: { today: { usd: 0, source: 'estimate' }, week: { usd: 0, source: 'estimate' }, month: { usd: 0, source: 'estimate' } },
      balance: null, budget: null,
      shares: { five_hour: { estimate: true, since: '2026-10-11T00:00:00Z', change: 8, other: 7,
        agents: [{ agent: 'lead', id: 'a1', percent: 0.4 }], trees: [{ root: 'lead', id: 'a1', percent: 1 }],
        by_agent: [{ agent: 'lead', id: 'a1', percent: 0.4 }], by_tree: [{ root: 'lead', id: 'a1', percent: 1 }],
        by_model: [{ model: 'opus', percent: 0.4 }], by_day: [{ day: '2026-10-10', percent: 2 }, { day: '2026-10-11', percent: 6 }],
        worth: { estimate: true, worth_usd: { low: 90, mid: 120, high: 160 }, used_usd: 20, left_usd: 100, percent_used: 40, samples: 10 },
        projection: { estimate: true, used_percentage: 40, percent_per_hour: 5, reaches_100_at: null, resets_at: '2026-10-11T19:00:00.000Z', note: 'resets before reaching 100%' } } } },
    { account: 'openrouter', match: { harness: 'opencode', model: 'openrouter/' }, windows: {}, updated_at: null, age_ms: null, stale: false,
      paid: { today: { usd: 0.16, source: 'exact' }, week: { usd: 0.16, source: 'exact' }, month: { usd: 0.16, source: 'exact' } },
      balance: 0.75, budget: null, shares: null },
  ],
  allocations: [] as unknown[],
  trees: [{ id: 'a1', name: 'lead', cost_usd: 4, tokens: 100, shares: { 'claude-max': { five_hour: { estimate: true, percent: 3 } } }, children: [{ id: 'c1', name: 'kid', cost_usd: 1, tokens: 10, shares: {}, children: [] }] }],
  blocked: [] as unknown[],
  instructions: 'Never spend extra credits on Claude or Codex.',
  by_day: [{ day: '2026-10-10', cost_usd: 3, tokens_in: 9000 }], by_model: [
    {
      harness: 'claude', model: 'opus', cost_usd: 3,
      today: { cost_usd: 1.5, tokens_in: 1200, tokens_out: 300, tokens_cache_read: 5000, tokens_cache_write: null },
      lifetime: { cost_usd: 3, tokens_in: 9000, tokens_out: 2000, tokens_cache_read: 40000, tokens_cache_write: 800 },
    },
    {
      harness: 'codex', model: 'gpt-5', cost_usd: 0,
      today: { cost_usd: null, tokens_in: 50, tokens_out: 5, tokens_cache_read: 0, tokens_cache_write: 0 },
      lifetime: { cost_usd: null, tokens_in: 500, tokens_out: 50, tokens_cache_read: 0, tokens_cache_write: 0 },
    },
  ],
  by_agent: [{
    agent: 'lead', harness: 'claude', model: 'opus', cost_usd: 3, tokens_in: 10000, tokens_out: 2000, tokens_cache_read: 30000, tokens_cache_write: 600,
    today: { cost_usd: 1.5, tokens_in: 1200, tokens_out: 300, tokens_cache_read: 5000, tokens_cache_write: null },
    lifetime: { cost_usd: null, tokens_in: 9000, tokens_out: 2000, tokens_cache_read: 40000, tokens_cache_write: 800 },
  }], note: 'Estimates.',
}
const ISSUE = (over: Record<string, unknown>) => ({
  key: 'S-1', title: 'Fix it', kind: 'issue', status: 'done', closed_at: new Date(Date.now() - 86_400_000).toISOString(),
  own: { cost_usd: 2, tokens_in: 1000, tokens_out: 500, tokens_cache_read: 3000, tokens_cache_write: 200, manager_cost_usd: 0 },
  total: { cost_usd: 2, tokens_in: 1000, tokens_out: 500, tokens_cache_read: 3000, tokens_cache_write: 200 },
  agents: 1, config: 'claude · claude-haiku-5-5', weekly_percent: 1.5, ...over,
})
const ISSUES = {
  note: 'Claude and Codex $ are API-equivalent.',
  issues: [
    ISSUE({ key: 'S-1', title: 'Fix it', own: { cost_usd: 2, tokens_in: 1000, tokens_out: 500, tokens_cache_read: 3000, tokens_cache_write: 200, manager_cost_usd: 0.5 } }),
    ISSUE({ key: 'S-2', title: 'Deepseek fix', status: 'canceled', own: { cost_usd: 0.4, tokens_in: 100, tokens_out: 50, tokens_cache_read: 0, tokens_cache_write: 0, manager_cost_usd: 0 }, config: 'opencode · openrouter/deepseek-v4-flash', weekly_percent: null }),
    ISSUE({ key: 'S-3', title: 'Not an issue', kind: 'project', own: { cost_usd: 9, tokens_in: 1, tokens_out: 1, tokens_cache_read: 0, tokens_cache_write: 0, manager_cost_usd: 0 } }),
    ISSUE({ key: 'S-4', title: 'Still open', status: 'in_progress', own: { cost_usd: 7, tokens_in: 1, tokens_out: 1, tokens_cache_read: 0, tokens_cache_write: 0, manager_cost_usd: 0 } }),
  ],
  by_config: [
    { config: 'claude · claude-haiku-5-5', n: 2, median: 1.2, average: 1.2, min: 0.4, max: 2, median_weekly_percent: 1.5 },
    { config: 'opencode · openrouter/deepseek-v4-flash', n: 1, median: 0.4, average: 0.4, min: 0.4, max: 0.4, median_weekly_percent: null },
  ],
  unattributed: { cost_usd: 0.25, tokens_in: 10, tokens_out: 5, tokens_cache_read: 0, tokens_cache_write: 0 },
}

let calls: { method: string; path: string; body?: unknown }[]
let root: Root
let host: HTMLElement

function stubFetch(extra: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    '/api/config/settings': { text: JSON.stringify(SETTINGS) }, '/api/registry': REGISTRY, '/api/assistant': { agent: null },
    '/api/config/instructions': { text: 'team rules' },
    '/api/templates': [
      { name: 'banner', text: 'hello {{name}}', overridden: false },
      { name: 'system-prompt', text: 'sys {{name}}', overridden: false },
      { name: 'chief-of-staff', text: 'boss {{name}}', overridden: false },
      { name: 'assistant', text: 'asst {{name}}', overridden: false },
      { name: 'mail-to-human', text: 'mail {{when}}', overridden: false },
      { name: 'human-mail-when-necessary', text: 'when needed', overridden: true },
      { name: 'human-mail-when-important', text: 'when important', overridden: false },
      { name: 'human-mail-when-everything', text: 'always', overridden: false },
      { name: 'instruction-files', text: 'files', overridden: false },
      { name: 'workspace-instructions', text: 'workspace', overridden: false },
      { name: 'permission-request', text: 'permission {{name}}', overridden: false },
    ], '/api/usage': USAGE,
    '/api/agents/a1/usage': {
      agent_id: 'a1', harness: 'claude', model: 'claude-opus-4-8',
      lifetime: { cost_usd: 1.5, tokens_in: 1500000, tokens_out: 25000, tokens_cache_read: 3000000, tokens_cache_write: 40000 },
      today: { cost_usd: 0.5, tokens_in: 12000, tokens_out: 3000, tokens_cache_read: null, tokens_cache_write: null },
    },
    '/api/agents/a1/files': [{ name: 'AGENTS.md', text: 'rules' }], '/api/agents/a1/events': [{ type: 'mail:x', ts: '2026-10-11T01:02:03Z', data: 'd' }, { type: 'other', ts: '2026-10-11T01:02:04Z' }],
    '/api/usage/issues': ISSUES,
    '/api/agents': [agent(), agent({ id: 'c1', name: 'kid', parents: ['a1'] })], '/api/permissions?status=pending&audience=human': [],
    '/api/mcp/status': { servers: [{ name: 'remote', type: 'oauth', logged_in: true, expires_at: null }] },
    ...extra,
  }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body as string) : undefined })
    return { ok: true, status: 200, json: async () => routes[path] ?? routes[path.split('?')[0]] ?? {} }
  }))
}
// Makes the issues call fail with a message; every other call answers as stubbed.
function failIssues(message: string) {
  const ok = globalThis.fetch as unknown as (p: string, i?: RequestInit) => Promise<unknown>
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/usage/issues') { calls.push({ method: 'GET', path }); throw new Error(message) }
    return ok(path, init)
  }))
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const mount = async (el: React.ReactElement) => { await act(async () => { root.render(el) }); await flush() }

beforeEach(() => {
  calls = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setData({ agents: [agent(), agent({ id: 'c1', name: 'kid', parents: ['a1'] })], machine: 'alpha' })
  stubFetch()
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); try { localStorage.clear() } catch {} })

// A row's cells as text, leaving out the phone-only line, which is a second line under the name.
const cellsOf = (tr: Element) => [...tr.querySelectorAll('td')].map((td) => [...td.childNodes].filter((n) => !(n instanceof Element && n.classList.contains('phone-only'))).map((n) => n.textContent).join(''))
// Opens a tab through the shared state, the way the tab buttons and later items do.
const openTab = async (tab: UsageTab) => { await act(async () => { setUsageState({ tab }) }); await flush() }
const clickBtn = async (el: Element | undefined) => { await act(async () => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await flush() }
const btn = (label: string) => [...host.querySelectorAll('.usage button')].find((b) => b.textContent?.trim().startsWith(label))
const periodBtn = (label: string) => [...host.querySelectorAll('.usage-controls [aria-label=Period] button')].find((b) => b.textContent === label)
describe('UsageView', () => {
  beforeEach(() => { setUsageState({ ...DEFAULT_STATE }) })
  it('renders the limits band and tiles on the Overview tab and the other tabs on their own', async () => {
    await mount(<UsageView />)
    expect(host.querySelectorAll('.usage .lim-band > .lim-cards > .lim-card').length).toBe(2)
    expect(host.textContent).toContain('claude-max')
    expect(host.textContent).toContain('5-hour')
    expect(host.textContent).toContain('Week')
    expect(host.textContent).toContain('$4.20')
    expect(host.querySelectorAll('.usage-table table.data').length).toBe(0)
    expect([...host.querySelectorAll('.usage-tabs [role=tab]')].map((t) => t.textContent)).toEqual(['Overview', 'Activity', 'Issues', 'Models', 'Trees', 'Agents', 'Days'])
    expect(host.querySelector('.usage-tabs [aria-selected=true]')?.textContent).toBe('Overview')
  })
  it('a tab button, the period and the measure go into the shared state; a period change reloads with days', async () => {
    await mount(<UsageView />)
    await clickBtn(btn('Models'))
    expect(getUsageState().tab).toBe('models')
    expect(host.querySelectorAll('table.data').length).toBe(1)
    await clickBtn(btn('30 days'))
    expect(getUsageState().days).toBe(30)
    expect(calls.map((c) => c.path)).toContain('/api/usage?days=29')
    await clickBtn(btn('All time'))
    expect(getUsageState().days).toBe(0)
    expect(calls.map((c) => c.path)).toContain('/api/usage?days=365')
    expect(host.querySelectorAll('.usage-scope').length).toBe(0)
    // All three measures are live (S-663); the choice goes into the shared state.
    expect((btn('% of week') as HTMLButtonElement).disabled).toBe(false)
    expect((btn('API $') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
    await clickBtn(btn('Real $'))
    expect(getUsageState().measure).toBe('real')
    expect((btn('Real $') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
  })
  it('a tab with no data says so plainly', async () => {
    stubFetch({ '/api/usage': { ...USAGE, by_model: [], by_agent: [], by_day: [], trees: [] }, '/api/usage/issues': { ...ISSUES, issues: [], by_config: [] } })
    await mount(<UsageView />)
    for (const [tab, text] of [['models', 'No model spend yet'], ['agents', 'No agent spend yet'], ['days', 'No spend in this period'], ['trees', 'No trees with spend yet'], ['issues', 'No issues closed in this period']] as const) {
      await openTab(tab)
      expect(host.querySelector('.usage-panel')?.textContent).toContain(text)
    }
  })
  it('activity (S-1011): one summary call for the period; tiles, the clock, categories and bottlenecks', async () => {
    stubFetch({ '/api/activity?by=summary&days=7': SUMMARY })
    await mount(<UsageView />)
    expect(host.querySelector('.ax-grid')).toBeNull()
    await openTab('activity')
    // Only the summary: the old by=agent|model|type calls block the daemon.
    expect(calls.map((c) => c.path).filter((p) => p.startsWith('/api/activity'))).toEqual(['/api/activity?by=summary&days=7'])
    expect([...host.querySelectorAll('.ax-tiles .mb-mlabel')].map((x) => x.textContent)).toEqual(['Working', 'Waiting on you', 'Friction', 'Cost per working hour'])
    expect(host.querySelector('.ax-scope')?.textContent).toContain('whole system')
    expect(host.querySelectorAll('.ax-time [data-group]').length).toBe(5)
    expect(host.querySelectorAll('.ax-bn').length).toBe(8)
    expect(host.querySelector('.ax-bottlenecks .ax-more')?.textContent).toBe('Show all 10')
  })
  it('the Settings link opens the Activity tab', async () => {
    stubFetch({ '/api/activity?by=summary&days=7': SUMMARY_EMPTY })
    await mount(<UsageView />)
    expect(host.querySelector('.activity-tab')).toBeNull()
    await openTab('activity')
    expect(host.querySelector('.activity-tab')?.textContent).toContain('No agent activity in this window yet')
    expect(host.querySelector('.usage-tabs [aria-selected=true]')?.textContent).toBe('Activity')
  })
  it('activity (S-1011): a failed window change clears the old window and shows an error with Retry', async () => {
    stubFetch({ '/api/activity?by=summary&days=7': SUMMARY, '/api/activity?by=summary&days=30': SUMMARY })
    const ok = globalThis.fetch as unknown as (p: string, i?: RequestInit) => Promise<unknown>
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (fail && path.includes('days=30')) throw new Error('boom')
      return ok(path, init)
    }))
    await mount(<UsageView />)
    await openTab('activity')
    expect(host.querySelector('.ax-tiles')).not.toBeNull()
    await clickBtn(periodBtn('30 days')) // the Activity tab follows the page Period
    expect(host.querySelector('.ax-tiles')).toBeNull()
    expect(host.querySelector('.act-error')?.textContent).toContain('boom')
    fail = false
    await act(async () => { [...host.querySelectorAll('.act-error button')][0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(host.querySelector('.act-error')).toBeNull()
    expect(host.querySelector('.ax-tiles')).not.toBeNull()
  })
  it('agents: follow the page period, a missing counter as an em dash, a share bar per row', async () => {
    await mount(<UsageView />)
    await openTab('agents')
    const row = () => [...host.querySelectorAll('.usage-agents tbody tr')].find((tr) => tr.textContent?.includes('lead'))
    expect(row()?.querySelector('.muted')?.textContent).toBe('Claude Code · opus')
    expect(row()?.querySelector('.hdot')).not.toBeNull()
    // Name, In, Out, Cache read, Cache write, Cost, Share: seven columns, not thirteen.
    expect(host.querySelectorAll('.usage-agents th').length).toBe(7)
    const cells = () => [...(row()?.querySelectorAll('td') ?? [])].map((td) => td.textContent)
    // The default scope is the period: the API's top-level sums.
    expect(cells().slice(1, 6)).toEqual(['10k', '2k', '30k', '600', '$3.00'])
    await clickBtn(periodBtn('Today'))
    expect(cells().slice(1, 6)).toEqual(['1k', '300', '5k', '—', '$1.50'])
    await clickBtn(periodBtn('All time'))
    expect(cells().slice(1, 6)).toEqual(['9k', '2k', '40k', '800', '—'])
    expect(row()?.querySelector('.share-cell .meter i')).toBeNull()
    await clickBtn(periodBtn('Today'))
    expect(row()?.querySelector('.share-cell .meter i')).not.toBeNull()
  })
  it('models: short names with a harness column; a column sorts and flips on a second press', async () => {
    await mount(<UsageView />)
    await openTab('models')
    await clickBtn(periodBtn('All time'))
    const rows = () => [...host.querySelectorAll('.usage-models tbody tr')].filter((tr) => tr.querySelector('td'))
    const opus = rows().find((tr) => tr.textContent?.includes('opus'))
    expect(opus?.querySelector('td')?.textContent?.startsWith('opus')).toBe(true)
    expect(opus?.querySelectorAll('td')[1]?.textContent).toBe('Claude Code')
    expect([...(opus?.querySelectorAll('td') ?? [])].map((td) => td.textContent).slice(2, 9)).toEqual(['9k', '2k', '40k', '800', '—', '', '$3.00'])
    // Codex reports no cost: its cost cell is an em dash, not $0, and it sorts last by cost.
    const codex = rows().find((tr) => tr.textContent?.includes('gpt-5'))
    expect([...(codex?.querySelectorAll('td') ?? [])].map((td) => td.textContent).slice(2, 9)).toEqual(['500', '50', '0', '0', '—', '', '—'])
    expect(rows().at(-1)).toBe(codex)
    const head = (label: string) => [...host.querySelectorAll('.usage-models th .sort')].find((b) => b.textContent?.startsWith(label))!
    await clickBtn(head('Model'))
    expect(host.querySelector('.usage-models th[aria-sort=ascending]')?.textContent).toContain('Model')
    expect(rows().map((tr) => tr.querySelector('td')?.textContent?.slice(0, 3))).toEqual([...rows().map((tr) => tr.querySelector('td')?.textContent?.slice(0, 3))].sort())
    await clickBtn(head('Model'))
    expect(host.querySelector('.usage-models th[aria-sort=descending]')).not.toBeNull()
  })
  it('at a phone width the token columns fold into one muted line under the name', async () => {
    await mount(<UsageView />)
    await openTab('agents')
    const tr = [...host.querySelectorAll('.usage-agents tbody tr')].find((t) => t.textContent?.includes('lead'))!
    expect(tr.querySelector('.phone-only')?.textContent).toBe('10k in · 2k out · 31k cache')
    expect(tr.querySelectorAll('td.wide').length).toBe(4)
  })
  it('shows the OpenRouter balance and exact paid spend', async () => {
    await mount(<UsageView />)
    const card = [...host.querySelectorAll('.usage .lim-card')].find((c) => c.textContent?.includes('openrouter'))!
    expect(card.textContent).toContain('Credit')
    expect(card.textContent).toContain('$0.75')
    expect(card.textContent).toContain('left')
    expect(card.textContent).toContain('$0.16 spent this month')
  })
  it('never shows an unknown paid amount, or a 0 estimate on a subscription, as spend', async () => {
    const paid = (usd: number, source: 'unknown' | 'estimate') => ({ today: { usd, source }, week: { usd, source }, month: { usd, source } })
    stubFetch({ '/api/usage': { ...USAGE, accounts: [{ ...USAGE.accounts[0], paid: paid(0.12, 'unknown') }, { ...USAGE.accounts[0], account: 'claude-two', paid: paid(0, 'estimate') }] } })
    await mount(<UsageView />)
    const cards = host.querySelector('.usage .lim-band')?.textContent ?? ''
    expect(cards).not.toContain('$0.12')
    expect(cards).not.toContain('$0.00')
    expect(cards).not.toContain('unknown')
    expect(host.querySelector('.usage .tiles')?.textContent).toContain('—') // Real money: nothing known
  })
  it('shows an empty state when nothing is configured', async () => {
    stubFetch({ '/api/usage': { today: { cost_usd: 0, tokens_in: 0, tokens_out: 0 }, subscriptions: [], accounts: [], blocked: [], by_day: [], by_model: [], by_agent: [], note: '' } })
    await mount(<UsageView />)
    expect(host.textContent).toContain('No cost readings yet')
    expect(host.querySelectorAll('table.data').length).toBe(0)
  })
  it('puts a blocked agent at the top with its kind, reason and an Open link', async () => {
    stubFetch({ '/api/usage': { ...USAGE, blocked: [{ agent_id: 'a1', agent: 'lead', lifecycle: 'paused', paused_by: ['stam'], blockers: [{ kind: 'window', account: 'claude-max', reason: 'five_hour reached 100%', since: '2026-10-11T00:00:00Z', clear: null }] }] } })
    await mount(<UsageView />)
    const callout = host.querySelector('.usage-panel')!.firstElementChild!
    expect(callout.classList.contains('lim-blocked')).toBe(true)
    expect(callout.textContent).toContain('Blocked')
    expect(callout.textContent).toContain('lead')
    expect(callout.textContent).toContain('five_hour reached 100%')
    expect([...callout.querySelectorAll('button')].some((b) => b.textContent === 'Open')).toBe(true)
  })
  it('shows no blocked callout when no agent is blocked', async () => {
    await mount(<UsageView />)
    expect(host.querySelector('.usage .lim-blocked')).toBeNull()
  })
  it('marks a stale reading', async () => {
    stubFetch({ '/api/usage': { ...USAGE, accounts: [{ ...USAGE.accounts[0], stale: true, age_ms: 3 * 3600_000 }] } })
    await mount(<UsageView />)
    expect(host.textContent).toContain('stale')
  })
  it('shows an allocation at 100% under its account, in warning ink', async () => {
    stubFetch({ '/api/usage': { ...USAGE, allocations: [{ id: 'al1', root: 'cost', root_id: 'ahgcb', account: 'claude-max', kind: 'window', window: 'five_hour', percent: 30, amount: null, period: '', used: 30, used_percent: 100 }] } })
    await mount(<UsageView />)
    const alloc = host.querySelector('.usage .lim-card .lim-alloc')
    expect(alloc?.textContent).toContain('cost: 30% of 5-hour · 30% used')
    expect(alloc?.classList.contains('lim-warn')).toBe(true)
  })
  it('draws a window that reaches 100% before its reset in warning ink, with the time', async () => {
    const acct = JSON.parse(JSON.stringify(USAGE.accounts[0]))
    acct.shares.five_hour.projection = { estimate: true, used_percentage: 40, percent_per_hour: 20, reaches_100_at: '2026-10-11T12:34:00.000Z', resets_at: '2026-10-11T19:00:00.000Z' }
    stubFetch({ '/api/usage': { ...USAGE, accounts: [acct] } })
    await mount(<UsageView />)
    const card = host.querySelector('.usage .lim-card')!
    expect(card.querySelector('.lim-meter.warn .proj')).not.toBeNull()
    expect(card.querySelector('.lim-note.lim-warn')?.textContent).toMatch(/^100% ≈ /)
  })
  it('collapses the limits band to one line on a drilled scope', async () => {
    await act(async () => { setUsageState({ scope: { kind: 'tree', id: 'a1' } }) })
    await mount(<UsageView />)
    expect(host.querySelector('.usage .lim-compact')?.textContent).toContain('claude-max')
    expect(host.querySelector('.usage .lim-compact')?.textContent).toContain('5-hour 40%')
    expect(host.querySelector('.usage .lim-card')).toBeNull()
  })
  it('shows the four headline tiles; the Days tab has spend per day as bars and a sortable table', async () => {
    await mount(<UsageView />)
    const tiles = [...host.querySelectorAll('.usage .tiles .tile')].map((t) => t.textContent ?? '')
    expect(tiles).toHaveLength(4)
    expect(tiles[0]).toContain('Spend')
    expect(tiles[1]).toContain('Real money')
    expect(tiles[2]).toContain('Issues finished')
    expect(tiles[3]).toContain('Today')
    expect(tiles[3]).toContain('$4.20')
    await openTab('days')
    expect(host.querySelectorAll('.usage .dbars .dbar').length).toBe(1)
    expect(host.querySelector('.usage-days tbody tr:nth-child(2)')?.textContent).toContain('2026-10-10')
  })
  it('the Issues tab shows an error with Retry when the issues fail to load', async () => {
    const ok = globalThis.fetch as unknown as (p: string, i?: RequestInit) => Promise<unknown>
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (fail && path.startsWith('/api/usage/issues')) throw new Error('boom')
      return ok(path, init)
    }))
    await mount(<UsageView />)
    await openTab('issues')
    expect(host.querySelector('.usage-panel [role=alert]')?.textContent).toContain('boom')
    expect(host.querySelector('.usage-panel .stam-loader')).toBeNull()
    fail = false
    await clickBtn(host.querySelector('.usage-panel [role=alert] button')!)
    expect(host.querySelector('.usage-configs')).not.toBeNull()
  })
  it('shows each tree\'s total with its agents inside', async () => {
    await mount(<UsageView />)
    await openTab('trees')
    const totals = host.querySelector('.usage .tree-totals')
    expect(totals?.textContent).toContain('lead')
    expect(totals?.textContent).toContain('$4.00')
    expect(totals?.textContent).toContain('kid')
    expect(totals?.textContent).toContain('claude-max 5-hour 3%')
  })
  it('lists the issues closed in the period, most expensive first, with status, costs, agents and week share', async () => {
    await mount(<UsageView />)
    await openTab('issues')
    const rows = [...host.querySelectorAll('.usage-issue-list tbody tr')].map(cellsOf).filter((r) => r.length)
    // S-3 is a project and S-4 is still open; both leave the closed list.
    expect(rows).toEqual([
      ['S-1 Fix it', 'done', 'Haiku 5.5 · Claude Code', '$2.00', '$2.00', '1', '≈1.5%'],
      ['S-2 Deepseek fix', 'canceled', 'DeepSeek v4 flash · OpenCode', '$0.40', '$2.00', '1', 'paid'],
    ])
  })
  it('filters by status and drills to the ITSA on a row click', async () => {
    await mount(<UsageView />)
    await openTab('issues')
    const status = (label: string) => [...host.querySelectorAll('[aria-label="Status"] button')].find((b) => b.textContent === label) as HTMLElement
    await act(async () => { status('Open').click() })
    expect([...host.querySelectorAll('.usage-issue-list tbody tr')].map(cellsOf).filter((r) => r.length).map((r) => r[0])).toEqual(['S-4 Still open'])
    expect(host.querySelector('.usage-sub')?.textContent).toContain('1 issue open')
    await act(async () => { status('All').click() })
    expect(host.querySelector('.usage-sub')?.textContent).toContain('3 issues: closed in the period, and open')
    expect(host.querySelectorAll('.usage-issue-list tbody tr.click').length).toBe(3)
    await act(async () => { (host.querySelector('.usage-issue-list tr.click') as HTMLElement).click() })
    // The drill shows on the Overview, so the row leaves the Issues tab.
    expect(getUsageState().scope).toEqual({ kind: 'itsa', id: 'S-4' })
    expect(getUsageState().tab).toBe('overview')
    setUsageState({ scope: null })
  })
  it('sorts the issue list by a column', async () => {
    await mount(<UsageView />)
    await openTab('issues')
    await act(async () => { (host.querySelector('.usage-issue-list th button') as HTMLElement).click() })
    expect([...host.querySelectorAll('.usage-issue-list tbody tr')].map(cellsOf).filter((r) => r.length).map((r) => r[0])).toEqual(['S-1 Fix it', 'S-2 Deepseek fix'])
    expect(host.querySelector('.usage-issue-list th[aria-sort="ascending"]')?.textContent).toContain('Issue')
  })
  it('shows the closed issues\' cost by configuration, with the median, average, range and weekly share', async () => {
    await mount(<UsageView />)
    await openTab('issues')
    const rows = [...host.querySelectorAll('.usage-configs tbody tr')].map(cellsOf).filter((r) => r.length)
    expect(rows).toEqual([
      ['Haiku 5.5 · Claude Code', '2', '$1.20', '$1.20', '$0.40–$2.00', '≈1.5%'],
      ['DeepSeek v4 flash · OpenCode', '1', '$0.40', '$0.40', '$0.40–$0.40', 'paid'],
    ])
  })
  it('puts the status, configuration, total, agents and week under an issue at a phone width', async () => {
    await mount(<UsageView />)
    await openTab('issues')
    const lines = [...host.querySelectorAll('.usage-issue-list tbody tr .phone-only')].map((el) => el.textContent)
    expect(lines[0]).toBe('done · Haiku 5.5 · Claude Code · total $2.00 · 1 agent · week ≈1.5%')
    expect(lines[1]).toContain('week paid')
  })
  it('puts the average, range and weekly share under a configuration\'s name at a phone width', async () => {
    await mount(<UsageView />)
    await openTab('issues')
    const line = host.querySelector('.usage-configs tbody tr .phone-only')
    expect(line?.textContent).toBe('Average $1.20 · Range $0.40–$2.00 · Week ≈1.5%')
  })
  it('shows an empty state when no issue closed in the period', async () => {
    stubFetch({ '/api/usage/issues': { ...ISSUES, issues: [], by_config: [] } })
    await mount(<UsageView />)
    await openTab('issues')
    expect(host.textContent).toContain('No issues closed in this period')
    expect(host.querySelector('.usage-configs')).toBeNull()
  })
  it('shows an error with Retry when the issues fail to load, and loads again', async () => {
    failIssues('boom')
    await mount(<UsageView />)
    await openTab('issues')
    expect(host.querySelector('.uc-error')?.textContent).toContain('boom')
    const before = calls.filter((c) => c.path === '/api/usage/issues').length
    await act(async () => { (host.querySelector('.uc-error button') as HTMLElement).click() })
    expect(calls.filter((c) => c.path === '/api/usage/issues').length).toBe(before + 1)
  })
  it('puts the finished issues panel on the Overview, each cost against its median', async () => {
    await mount(<UsageView />)
    const panel = host.querySelector('.fin-issues')
    expect(panel?.textContent).toContain('Finished issues')
    expect(panel?.textContent).toContain('All 2 →')
    const rows = [...panel!.querySelectorAll('tbody tr')].map(cellsOf).filter((r) => r.length)
    expect(rows[0]).toEqual(['S-1 Fix it', '—', 'Haiku 5.5 · Claude Code', '$2.00', '1.7× median', '≈1.5%'])
    // $0.40 against a $0.40 median is typical.
    expect(rows[1][4]).toBe('typical')
    expect(panel!.querySelector('.vs b')).not.toBeNull()
    await act(async () => { (panel!.querySelector('.uc-head a') as HTMLElement).click() })
    expect(getUsageState().tab).toBe('issues')
    setUsageState({ tab: 'overview' })
  })
  it('limits the finished issues panel to the top five', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ISSUE({ key: `S-${10 + i}`, title: `Job ${i}`, own: { cost_usd: 1 + i, tokens_in: 1, tokens_out: 1, tokens_cache_read: 0, tokens_cache_write: 0, manager_cost_usd: 0 } }))
    stubFetch({ '/api/usage/issues': { ...ISSUES, issues: many } })
    await mount(<UsageView />)
    const keys = [...host.querySelectorAll('.fin-issues tbody tr')].map(cellsOf).filter((r) => r.length).map((r) => r[0])
    expect(keys).toEqual(['S-16 Job 6', 'S-15 Job 5', 'S-14 Job 4', 'S-13 Job 3', 'S-12 Job 2'])
    expect(host.querySelector('.fin-issues')?.textContent).toContain('All 7 →')
  })
  it('shows the finished issues panel empty', async () => {
    stubFetch({ '/api/usage/issues': { ...ISSUES, issues: [] } })
    await mount(<UsageView />)
    expect(host.querySelector('.fin-issues')?.textContent).toContain('No issues finished in this period')
  })
  it('shows the finished issues panel with an error and Retry', async () => {
    failIssues('down')
    await mount(<UsageView />)
    expect(host.querySelector('.fin-issues .uc-error')?.textContent).toContain('down')
  })
  it('reloads when shown turns true', async () => {
    await mount(<UsageView shown={false} />)
    expect(calls.length).toBe(0)
    await mount(<UsageView shown />)
    expect(calls.map((c) => c.path).filter((x) => !x.startsWith('/api/usage/series'))).toEqual(['/api/usage?days=6', '/api/usage/issues'])
  })
})

describe('DetailsView', () => {
  it('renders the agent and loads files lazily', async () => {
    await mount(<DetailsView id="a1" />)
    expect(host.querySelector('h2')?.textContent).toContain('lead')
    expect(host.querySelector('dl.kv')?.textContent).toContain('/work')
    expect(host.querySelector('dl.kv')?.textContent).toContain('kid')
    // Its tokens and cost load on mount; the files fold still waits.
    expect(calls.map((c) => c.path)).toEqual(['/api/agents/a1/usage'])
    const fold = host.querySelector('details.fold')!
    await act(async () => { fold.setAttribute('open', ''); fold.dispatchEvent(new Event('toggle')) })
    await flush()
    expect(host.querySelector('.files')?.textContent).toContain('rules')
    expect(host.querySelector('.files')?.textContent).toContain('mail:x')
    expect(host.querySelector('.files')?.textContent).not.toContain('other')
  })
  it('snaps the permission select back when the switch is declined', async () => {
    vi.stubGlobal('confirm', () => false)
    await mount(<DetailsView id="a1" />)
    const sel = host.querySelector('select')!
    // An auto agent with no recorded source follows the settings.
    expect(sel.value).toBe('settings')
    await act(async () => { sel.value = 'bypass'; sel.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    expect(host.querySelector('select')!.value).toBe('settings')
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })
  it('offers Ask on Claude only, and Follow settings posts mode settings', async () => {
    vi.stubGlobal('confirm', () => true)
    // A Claude agent the human pinned to bypass: it shows its own mode, with no settings note.
    setData({ agents: [agent({ permission_mode: 'bypass', permission_source: 'manual' })], machine: 'alpha' })
    await mount(<DetailsView id="a1" />)
    const opts = () => [...host.querySelector('select')!.querySelectorAll('option')].map((o) => o.value)
    expect(opts()).toEqual(['settings', 'default', 'auto', 'bypass'])
    const sel = host.querySelector('select')!
    expect(sel.value).toBe('bypass')
    expect(host.querySelector('dl.kv')?.textContent).not.toContain('from Settings')
    await act(async () => { sel.value = 'settings'; sel.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    expect(calls.find((c) => c.path === '/api/agents/a1/permission-mode')).toMatchObject({ method: 'POST', body: { mode: 'settings' } })
  })
  it('shows the settings as the source of an agent that follows them, and offers no Ask off Claude', async () => {
    setData({ agents: [agent({ harness: 'codex', permission_mode: 'bypass', permission_source: 'settings' })], machine: 'alpha' })
    await mount(<DetailsView id="a1" />)
    const sel = host.querySelector('select')!
    expect(sel.value).toBe('settings')
    expect([...sel.querySelectorAll('option')].map((o) => o.value)).toEqual(['settings', 'auto', 'bypass'])
    expect(host.querySelector('dl.kv')?.textContent).toContain('bypass, from Settings')
  })
  it('runs an action', async () => {
    await mount(<DetailsView id="a1" />)
    const restart = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Restart')!
    await act(async () => { restart.click() })
    await flush()
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ method: 'POST', path: '/api/agents/a1/restart' })
  })
  it('shows today and lifetime tokens and cost, a missing field as an em dash', async () => {
    stubFetch({
      '/api/agents/a1/usage': {
        agent_id: 'a1', harness: 'codex', model: 'gpt-6.1-sol',
        lifetime: { cost_usd: null, tokens_in: 1500000, tokens_out: 25000, tokens_cache_read: 3000000, tokens_cache_write: 40000 },
        today: { cost_usd: null, tokens_in: 12000, tokens_out: null, tokens_cache_read: null, tokens_cache_write: null },
      },
    })
    await mount(<DetailsView id="a1" />)
    const table = host.querySelector('table.usage-tokens')!
    expect(table).toBeTruthy()
    const row = (label: string) => [...table.querySelectorAll('tr')].find((r) => r.textContent?.startsWith(label))!
    expect(host.textContent).toContain('Today')
    expect(host.textContent).toContain('Lifetime')
    expect(row('Input').textContent).toBe('Input12k1.5M')
    expect(row('Cost').textContent).toBe('Cost——') // Codex reports no cost: missing, never $0
    expect(row('Output').textContent).toBe('Output—25k')
    expect(row('Cache write').textContent).toBe('Cache write—40k')
  })
  it('lists the waits, top first, with since and until, and links an agent wait', async () => {
    const until = new Date(Date.now() + 4 * 60000).toISOString()
    const waits = [
      { id: 'w1', kind: 'timer', until, since: '2026-10-11T00:00:00Z', source: 'hook' },
      { id: 'w2', kind: 'children', detail: '2 children', since: '2026-10-11T00:00:00Z', source: 'stam' },
      { id: 'w3', kind: 'agent', target: 'c1', since: '2026-10-11T00:00:00Z', source: 'declared' },
    ]
    const a = agent({ activity: 'waiting', waits })
    setData({ agents: [a, agent({ id: 'c1', name: 'kid', parents: ['a1'] })], machine: 'alpha' })
    await mount(<DetailsView id="a1" />)
    const items = [...host.querySelectorAll('.wait-list li')].map((li) => li.textContent)
    expect(items[0]).toContain("kid's reply")
    expect(items[1]).toContain('2 children')
    expect(items[2]).toMatch(/^timer \d\d:\d\d \(in 4m\) · since /)
    expect(host.querySelector('.wait-list a')?.textContent).toBe("kid's reply")
    expect(agentTooltip(a)).toContain("Waiting for kid's reply\nWaiting for 2 children\nWaiting for timer")
  })
  it('gives an event wait the radio icon in the tree and the details, with its detail as the label', async () => {
    const w = { id: 'w4', kind: 'event', detail: 'github:acme/app#12', since: '2026-10-11T00:00:00Z', source: 'declared' }
    const a = agent({ activity: 'waiting', waits: [w] })
    setData({ agents: [a], machine: 'alpha' })
    await mount(<WaitMark a={a} />)
    expect(host.querySelector('.wait-mark .lucide-radio')).not.toBeNull()
    expect(host.querySelector('.wait-mark')?.getAttribute('title')).toBe('Waiting for github:acme/app#12')
    await mount(<DetailsView id="a1" />)
    expect(host.querySelector('.wait-list li .lucide-radio')).not.toBeNull()
    expect(host.querySelector('.wait-list a, .wait-list span.muted')).not.toBeNull()
    expect(host.querySelector('.wait-list li')?.textContent).toContain('github:acme/app#12')
  })
  it('shows a gone agent', async () => {
    await mount(<DetailsView id="zzz" />)
    expect(host.textContent).toContain('This agent is gone.')
  })
})

describe('ConfigView', () => {
  it('renders sections and remembers the chosen one', async () => {
    await mount(<ConfigView />)
    expect(host.querySelector('.settings-inner h2')?.textContent).toBe('Executive assistant')
    const nav = [...host.querySelectorAll<HTMLButtonElement>('.settings-nav button.item')]
    expect(nav.length).toBe(SECTIONS.length) // from the list, so a PR that adds a section needn't edit a count
    expect(new Set(SECTIONS.map((s) => s.key)).size).toBe(SECTIONS.length)
    // After the sections, one link to the stories page (S-647).
    expect(host.querySelector('.settings-nav a.item')?.getAttribute('href')).toBe('/stories')
    await act(async () => { nav.find((b) => b.textContent?.includes('Context and compaction'))!.click() })
    expect(host.querySelector('.settings-inner h2')?.textContent).toBe('Context and compaction')
    expect(localStorage.getItem('stam/settings-section')).toBe('context')
  })
  it('opens Agent types for an old reviewers link, since reviewers are agent types now', async () => {
    localStorage.setItem('stam/settings-section', 'reviewers')
    await mount(<ConfigView />)
    expect(host.querySelector('.settings-inner h2')?.textContent).toBe('Agent types')
    expect(host.querySelector('.settings-nav .item.sel')?.textContent).toBe('Agent types')
    localStorage.removeItem('stam/settings-section')
  })
  it('gives the activity classifier its own section, linked to the Usage page', async () => {
    localStorage.setItem('stam/settings-section', 'activity')
    await mount(<ConfigView />)
    expect(host.querySelector('.settings-inner h2')?.textContent).toBe('Activity')
    expect(host.textContent).toContain('Classify activity')
    expect(host.textContent).toContain('Daily cap')
    expect(host.textContent).toContain('Items at once')
    expect(host.textContent).toContain('Classify since')
    expect(host.querySelector('.settings-inner a[href="#usage"]')).not.toBeNull()
    localStorage.removeItem('stam/settings-section')
  })
  it('saves a choice at once and keeps the model valid for the harness', async () => {
    await mount(<ConfigView />)
    const codex = [...host.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent?.includes('Codex'))!
    await act(async () => { codex.click() })
    await flush()
    const post = calls.find((c) => c.method === 'PATCH')!
    expect(post.path).toBe('/api/config/settings')
    const saved = (post.body as { patch: Record<string, any> }).patch
    expect(saved.assistant).toMatchObject({ harness: 'codex', model: 'gpt-5', effort: null })
    expect(host.querySelector('.saved')?.textContent).toContain('Saved')
  })
  it('adds a subscription percent with Enter', async () => {
    localStorage.setItem('stam/settings-section', 'spend')
    await mount(<ConfigView />)
    const input = host.querySelector<HTMLInputElement>('.num.small input')!
    input.value = '80'
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
    const post = calls.find((c) => c.method === 'PATCH')!
    expect((post.body as { patch: Record<string, any> }).patch.cost.subscriptionWarnPercent).toEqual([50, 80])
  })
  it('Settings › Spending: sets the agents and system OpenRouter budgets, creating the system account, and clears one', async () => {
    localStorage.setItem('stam/settings-section', 'spend')
    await mount(<ConfigView />)
    const row = (label: string) => [...host.querySelectorAll('.set-row')].find((r) => r.querySelector('.set-label b')?.textContent === label)!
    const change = async (el: Element, value: string) => { (el as HTMLInputElement).value = value; await act(async () => { el.dispatchEvent(new Event('change', { bubbles: true })) }); await flush() }
    const sent = () => (calls.filter((c) => c.method === 'PATCH').at(-1)!.body as { patch: Record<string, any> }).patch.cost.accounts
    // The period waits for an amount.
    expect(row('System').querySelector<HTMLButtonElement>('.seg button')!.disabled).toBe(true)
    await change(row('System').querySelector('input[type=number]')!, '3')
    expect(sent()['openrouter-system']).toEqual({ match: { harness: 'stam' }, budget: { usd: 3, per: 'month' } })
    await act(async () => { [...row('System').querySelectorAll('.seg button')].find((b) => b.textContent === 'day')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(sent()['openrouter-system'].budget).toEqual({ usd: 3, per: 'day' })
    await change(row('Agents').querySelector('input[type=number]')!, '20')
    expect(sent().openrouter.budget).toEqual({ usd: 20, per: 'month' })
    // With no agents account yet, the daemon needs a match: OpenRouter models on OpenCode.
    expect(sent().openrouter.match).toEqual({ harness: 'opencode', model: 'openrouter/' })
    await change(row('Agents').querySelector('input[type=number]')!, '')
    expect(sent().openrouter.budget).toBeNull()
    await change(row('System reserve').querySelector('input[type=number]')!, '2')
    expect((calls.filter((c) => c.method === 'PATCH').at(-1)!.body as { patch: Record<string, any> }).patch.cost.openrouterSystemReserveUsd).toBe(2)
    localStorage.removeItem('stam/settings-section')
  })
  it('Settings › Spending: a provider budget goes on the provider\'s own account, created under a key that may hold a dot (S-2119)', async () => {
    const providers = {
      'azure.eu': { kind: 'azure', endpoint: 'https://r.openai.azure.com', apiVersion: 'v1' },
      oa: { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' },
      mine: { kind: 'openai-compatible', baseUrl: 'https://x.example/v1' },
      br: { kind: 'bedrock', region: 'eu-west-1' },
    }
    // `oa` is also an unrelated Claude account's name; `mine` already has an account matching its models.
    const accounts = { oa: { match: { harness: 'claude' } }, 'mine-acct': { match: { harness: 'opencode', model: 'mine/m' } } }
    stubFetch({ '/api/config/settings': { text: JSON.stringify({ ...SETTINGS, providers, cost: { ...SETTINGS.cost, accounts } }) } })
    localStorage.setItem('stam/settings-section', 'spend')
    await mount(<ConfigView />)
    const row = (label: string) => [...host.querySelectorAll('.set-row')].find((r) => r.querySelector('.set-label b')?.textContent === label)!
    const change = async (el: Element, value: string) => { (el as HTMLInputElement).value = value; await act(async () => { el.dispatchEvent(new Event('change', { bubbles: true })) }); await flush() }
    const sent = () => (calls.filter((c) => c.method === 'PATCH').at(-1)!.body as { patch: Record<string, any> }).patch.cost.accounts
    await change(row('azure.eu').querySelector('input[type=number]')!, '5')
    expect(sent()['azure.eu']).toEqual({ match: { harness: 'opencode', model: 'azure.eu/' }, provider: 'azure.eu', budget: { usd: 5, per: 'month' } })
    expect(sent().azure).toBeUndefined()
    await change(row('oa').querySelector('input[type=number]')!, '7')
    expect(sent()['oa-provider']).toEqual({ match: { harness: 'opencode', model: 'oa/' }, provider: 'oa', budget: { usd: 7, per: 'month' } })
    expect(sent().oa).toEqual({ match: { harness: 'claude' } })
    await change(row('mine').querySelector('input[type=number]')!, '9')
    expect(sent()['mine-acct']).toEqual({ match: { harness: 'opencode', model: 'mine/m' }, budget: { usd: 9, per: 'month' } })
    expect(sent().mine).toBeUndefined()
    localStorage.removeItem('stam/settings-section')
  })
  it('Settings › Spending: a harness-only OpenCode account covers a provider\'s models, so its row names that account and adds none', async () => {
    const providers = { br: { kind: 'bedrock', region: 'eu-west-1' } }
    const accounts = { opencode: { match: { harness: 'opencode' } } }
    stubFetch({ '/api/config/settings': { text: JSON.stringify({ ...SETTINGS, providers, cost: { ...SETTINGS.cost, accounts } }) } })
    localStorage.setItem('stam/settings-section', 'spend')
    await mount(<ConfigView />)
    const row = [...host.querySelectorAll('.set-row')].find((r) => r.querySelector('.set-label b')?.textContent === 'br')!
    expect(row.querySelector('input')).toBeNull()
    expect(row.textContent).toContain('Billed to the account opencode')
    localStorage.removeItem('stam/settings-section')
  })
  it('Settings › Requirements: defaults shown, turning on saves and notes observe, a percentage saves as a fraction, Import waits for on', async () => {
    localStorage.setItem('stam/settings-section', 'requirements')
    await mount(<ConfigView />)
    expect(host.querySelector('.settings-inner h2')?.textContent).toBe('Requirements')
    for (const label of ['Who approves drafts', 'Default threshold', 'Default mode', 'Daily cap', 'Key prefix', 'Demote after', 'Import']) expect(host.textContent).toContain(label)
    expect(host.querySelector('[data-req-observe-note]')).toBeNull()
    expect(host.querySelector<HTMLButtonElement>('[data-req-import]')!.disabled).toBe(true)
    expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('Only you')
    const pct = host.querySelector<HTMLInputElement>('[data-kind="pct"]')!
    expect(pct.value).toBe('80')
    const on = host.querySelector<HTMLInputElement>('[data-req-enabled]')!
    on.checked = true
    await act(async () => { on.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    expect((calls.filter((c) => c.method === 'PATCH').at(-1)!.body as { patch: Record<string, any> }).patch.requirements).toEqual({ enabled: true })
    expect(host.querySelector('[data-req-observe-note]')?.textContent).toContain('start in observe')
    expect(host.querySelector<HTMLButtonElement>('[data-req-import]')!.disabled).toBe(false)
    const t = host.querySelector<HTMLInputElement>('[data-kind="pct"]')!
    t.value = '65'
    await act(async () => { t.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    expect((calls.filter((c) => c.method === 'PATCH').at(-1)!.body as { patch: Record<string, any> }).patch.requirements).toEqual({ enabled: true, defaultThreshold: 0.65 })
    localStorage.removeItem('stam/settings-section')
  })
  it('Settings › Retros: shows the digest and loop settings, and a change sends the whole retro object', async () => {
    localStorage.setItem('stam/settings-section', 'retros')
    const retro = { digest: { enabled: true, day: 'daily', hour: 9 }, lastDigest: '2026-10-13T09:00:00.000Z', steward: { enabled: true }, epic: { minReporters: 3, maxWindowShare: 50 } }
    stubFetch({ '/api/config/settings': { text: JSON.stringify({ ...SETTINGS, retro }) } })
    await mount(<ConfigView />)
    expect(host.querySelector('.settings-inner h2')?.textContent).toBe('Retros')
    for (const label of ['Send the digest', 'Day', 'Hour', 'Last digest', 'Retro steward', 'Reminders', 'Reporters needed', 'Window share limit']) expect(host.textContent).toContain(label)
    const rows = [...host.querySelectorAll('.set-row')]
    expect(rows.find((r) => r.textContent?.includes('Reminders'))!.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true)
    const day = host.querySelector<HTMLSelectElement>('select[aria-label="Digest day"]')!
    expect(day.value).toBe('daily')
    day.value = 'fri'
    await act(async () => { day.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    const sent = (calls.filter((c) => c.method === 'PATCH').at(-1)!.body as { patch: Record<string, any> }).patch.retro
    expect(sent.digest).toEqual({ enabled: true, day: 'fri', hour: 9 })
    expect(sent.steward).toEqual({ enabled: true })
    expect(sent.epic).toEqual({ minReporters: 3, maxWindowShare: 50 })
    // The daemon owns lastDigest: the page doesn't send its copy.
    expect('lastDigest' in sent).toBe(false)
    // But the page still shows it: a change doesn't blank Last digest to "Never".
    const last = [...host.querySelectorAll('.set-row')].find((r) => r.textContent?.includes('Last digest'))!
    const shown = last.querySelector('.muted')!.textContent ?? ''
    expect(shown).not.toBe('Never')
    expect(shown).toMatch(/ago|just now/)
    localStorage.removeItem('stam/settings-section')
  })
  it('Settings › Retros: two changes before the first save returns both survive (S-712)', async () => {
    localStorage.setItem('stam/settings-section', 'retros')
    const retro = { digest: { enabled: true, day: 'daily', hour: 9 }, lastDigest: '2026-10-13T09:00:00.000Z', steward: { enabled: true } }
    stubFetch({ '/api/config/settings': { text: JSON.stringify({ ...SETTINGS, retro }) } })
    await mount(<ConfigView />)
    const day = host.querySelector<HTMLSelectElement>('select[aria-label="Digest day"]')!
    const steward = [...host.querySelectorAll('.set-row')].find((r) => r.textContent?.includes('Retro steward'))!.querySelector<HTMLInputElement>('input[type=checkbox]')!
    // Change Day, then the steward checkbox before the first save comes back: the second change
    // must not be built from a stale `retro` object that would drop the first.
    await act(async () => {
      day.value = 'fri'
      day.dispatchEvent(new Event('change', { bubbles: true }))
      steward.click()
    })
    await flush()
    const sent = (calls.filter((c) => c.method === 'PATCH').at(-1)!.body as { patch: Record<string, any> }).patch.retro
    expect(sent.digest.day).toBe('fri')
    expect(sent.steward.enabled).toBe(false)
    expect('lastDigest' in sent).toBe(false)
    localStorage.removeItem('stam/settings-section')
  })
  it('saves the cost instructions on change', async () => {
    localStorage.setItem('stam/settings-section', 'spend')
    await mount(<ConfigView />)
    const area = host.querySelector<HTMLTextAreaElement>('.set-field textarea')!
    expect(area).toBeTruthy()
    area.value = 'Never spend extra credits on Claude or Codex.'
    await act(async () => { area.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    const post = calls.find((c) => c.method === 'PATCH')!
    expect((post.body as { patch: Record<string, any> }).patch.cost.instructions).toBe('Never spend extra credits on Claude or Codex.')
  })
  it('saves the mail titles model, empty by default (S-297)', async () => {
    localStorage.setItem('stam/settings-section', 'mail')
    await mount(<ConfigView />)
    expect(host.textContent).toContain('Mail titles')
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Mail titles model"]')!
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Off')
    // Typed into the picker (a free-text id), then Enter saves it.
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, 'google/gemma-3-4b-it')
    await act(async () => { input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
    const post = calls.find((c) => c.method === 'PATCH')!
    expect((post.body as { patch: Record<string, any> }).patch.mail).toEqual({ titles: { model: 'google/gemma-3-4b-it' } })
    localStorage.removeItem('stam/settings-section')
  })
  it('saves the cost display mode and a subscription price, and says when a price is missing', async () => {
    const cost = { ...SETTINGS.cost, accounts: { 'claude-max': { match: { harness: 'claude' }, paid: false }, 'codex-pro': { match: { harness: 'codex' } }, openrouter: { match: { harness: 'opencode' }, subscription: false } } }
    stubFetch({ '/api/config/settings': { text: JSON.stringify({ ...SETTINGS, cost }) } })
    localStorage.setItem('stam/settings-section', 'spend')
    await mount(<ConfigView />)
    const modes = [...host.querySelectorAll<HTMLButtonElement>('.choice')]
    expect(modes.map((b) => b.querySelector('b')?.textContent)).toEqual(['API equivalent', '% of the 5-hour window', '% of the 7-day window', 'Subscription'])
    expect(modes[0].className).toContain('on')
    expect(host.textContent).not.toContain('openrouter')
    await act(async () => { modes[3].click() })
    await flush()
    expect(host.textContent).toContain("No price yet, so Subscription can't show this account's cost.")
    const price = host.querySelector<HTMLInputElement>('input[placeholder=Price]')!
    price.value = '200'
    await act(async () => { price.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    const post = calls.filter((c) => c.method === 'PATCH').at(-1)!
    expect((post.body as { patch: Record<string, any> }).patch.cost.display).toEqual({ mode: 'subscription', prices: { 'claude-max': 200 } })
  })
  it('keeps the accounts, deletes a cleared price, and sends nothing for an invalid one', async () => {
    const accounts = { 'claude-max': { match: { harness: 'claude' } }, 'codex-pro': { match: { harness: 'codex' } } }
    stubFetch({ '/api/config/settings': { text: JSON.stringify({ ...SETTINGS, cost: { ...SETTINGS.cost, accounts, display: { mode: 'subscription', prices: { 'claude-max': 200 } } } }) } })
    localStorage.setItem('stam/settings-section', 'spend')
    await mount(<ConfigView />)
    const field = (name: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${name} price, USD per month"]`)!
    const change = async (el: HTMLInputElement, value: string) => {
      el.value = value
      await act(async () => { el.dispatchEvent(new Event('change', { bubbles: true })) })
      await flush()
    }
    const patches = () => calls.filter((c) => c.method === 'PATCH')
    for (const bad of ['0', '-5']) {
      await change(field('claude-max'), bad)
      expect(patches()).toHaveLength(0)
      expect(field('claude-max').value).toBe('200')
    }
    await change(field('codex-pro'), '')
    expect(patches()).toHaveLength(0)
    await change(field('claude-max'), '')
    const post = patches().at(-1)!
    const patch = (post.body as { patch: Record<string, any> }).patch.cost
    expect(patch.accounts).toEqual(accounts)
    expect(patch.display).toEqual({ mode: 'subscription', prices: {} })
  })
  it('shows the no-price note until a price is set', async () => {
    const accounts = { 'codex-pro': { match: { harness: 'codex' } } }
    stubFetch({ '/api/config/settings': { text: JSON.stringify({ ...SETTINGS, cost: { ...SETTINGS.cost, accounts, display: { mode: 'subscription', prices: {} } } }) } })
    localStorage.setItem('stam/settings-section', 'spend')
    await mount(<ConfigView />)
    const note = "No price yet, so Subscription can't show this account's cost."
    expect(host.textContent).toContain(note)
    const price = host.querySelector<HTMLInputElement>('input[aria-label="codex-pro price, USD per month"]')!
    price.value = '20'
    await act(async () => { price.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    expect(host.textContent).not.toContain(note)
  })
  it('marks the mode cards as a radio group', async () => {
    localStorage.setItem('stam/settings-section', 'spend')
    await mount(<ConfigView />)
    const group = host.querySelector('[role=radiogroup]')!
    const radios = [...group.querySelectorAll('[role=radio]')]
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false'])
  })
  it('saves a number on change', async () => {
    localStorage.setItem('stam/settings-section', 'context')
    await mount(<ConfigView />)
    const input = host.querySelector<HTMLInputElement>('input[type=number]')!
    input.value = '250'
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush()
    const post = calls.find((c) => c.method === 'PATCH')!
    expect((post.body as { patch: Record<string, any> }).patch.context.warnTokens).toBe(250000)
  })
  it('lists agent types and saves one from its form', async () => {
    stubFetch({ '/api/registry': { ...REGISTRY, types: { tester: { harness: 'claude', model: 'claude-opus-4-8', effort: 'low', description: 'Writes tests.', brief: 'Do {{task}}' } } } })
    localStorage.setItem('stam/settings-section', 'types')
    await mount(<ConfigView />)
    expect(host.querySelector('.settings-inner h2')?.textContent).toBe('Agent types')
    const card = host.querySelector<HTMLButtonElement>('.type-cards [data-type=tester]')!
    expect(card.textContent).toContain('Writes tests.')
    await act(async () => { card.click() })
    const high = [...host.querySelectorAll<HTMLButtonElement>('.type-form .seg button')].find((b) => b.textContent === 'high')!
    await act(async () => { high.click() })
    const tree = [...host.querySelectorAll<HTMLButtonElement>('.type-form .seg button')].find((b) => b.textContent === 'Its tree')!
    await act(async () => { tree.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.type-form button[type=submit]')!.click() })
    await flush()
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/types/tester')!
    expect(post.body).toMatchObject({ harness: 'claude', model: 'claude-opus-4-8', effort: 'high', visibility: { reach: 'tree' }, brief: 'Do {{task}}' })
  })
  it('tags reviewer types, shows a ring as its members, and keeps a reviewer type\'s review when saved', async () => {
    const review = { fallback: 'reviewer-opus', ring: null }
    stubFetch({ '/api/registry': { ...REGISTRY, types: {
      reviewer: { harness: 'codex', model: 'gpt-5', effort: null, description: 'Reviews.', review },
      'reviewer-opus': { harness: 'claude', model: 'claude-opus-4-8', effort: 'low', description: 'Backup.', review: { fallback: null, ring: null } },
      'review-ring': { harness: '', model: null, effort: null, description: 'A ring.', review: { fallback: 'reviewer', ring: { format: 'rounds', members: ['reviewer', 'reviewer-opus'], moderator: null, maxRounds: 3 } } },
    } } })
    localStorage.setItem('stam/settings-section', 'types')
    await mount(<ConfigView />)
    const card = host.querySelector<HTMLButtonElement>('.type-cards [data-type=reviewer]')!
    expect(card.querySelector('.chip')?.textContent).toBe('Reviewer')
    expect(card.textContent).toContain('falls back to reviewer-opus')
    expect(host.querySelector('.type-cards [data-type=reviewer-opus] .chip')?.textContent).toBe('Reviewer')
    expect(host.querySelector('.type-cards [data-type=reviewer-opus]')!.textContent).not.toContain('falls back')
    const ring = host.querySelector<HTMLButtonElement>('.type-cards [data-type=review-ring]')!
    expect(ring.textContent).toContain('Ring · 2 members')
    expect(ring.textContent).not.toContain('Harness default')
    await act(async () => { card.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.type-form button[type=submit]')!.click() })
    await flush()
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/types/reviewer')!
    expect(post.body).toMatchObject({ harness: 'codex', review })
  })
  it('groups reviewers first, marks the default, and edits a ring\'s members', async () => {
    const rv = (fallback: string | null, ring: unknown = null) => ({ harness: ring ? '' : 'codex', model: null, effort: null, review: { fallback, ring } })
    stubFetch({ '/api/registry': { ...REGISTRY, defaultReviewer: 'reviewer', types: {
      developer: { harness: 'claude', model: null, effort: null },
      reviewer: rv(null),
      'reviewer-opus': rv(null),
      'review-ring': rv(null, { format: 'rounds', members: ['reviewer', 'reviewer-opus'], moderator: null, maxRounds: 3 }),
    } } })
    localStorage.setItem('stam/settings-section', 'types')
    await mount(<ConfigView />)
    const groups = [...host.querySelectorAll('.type-cards')].map((g) => [...g.querySelectorAll('[data-type]')].map((c) => c.getAttribute('data-type')))
    expect(groups).toEqual([['reviewer', 'reviewer-opus', 'review-ring'], ['developer']])
    expect(host.querySelector('.type-cards [data-type=reviewer]')!.textContent).toContain('Default')
    await act(async () => { host.querySelector<HTMLButtonElement>('.type-cards [data-type=review-ring]')!.click() })
    expect(host.querySelector('.type-form .seg button.on')?.textContent).not.toBe('Claude')
    expect(host.querySelector('.type-form select[name=model]')).toBeNull()
    await act(async () => { host.querySelector<HTMLButtonElement>('.type-form [aria-label="Move member 2 up"]')!.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.type-form button[type=submit]')!.click() })
    await flush()
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/types/review-ring')!
    expect(post.body).toMatchObject({ harness: '', review: { ring: { members: ['reviewer-opus', 'reviewer'] } } })
    expect(post.body).not.toHaveProperty('default')
  })
  it('adds a type and removes one', async () => {
    vi.stubGlobal('confirm', () => true)
    stubFetch({ '/api/registry': { ...REGISTRY, types: { tester: { harness: 'claude', model: null, effort: null } } } })
    localStorage.setItem('stam/settings-section', 'types')
    await mount(<ConfigView />)
    const add = [...host.querySelectorAll<HTMLButtonElement>('.settings-inner button')].find((b) => b.textContent === 'Add a type')!
    await act(async () => { add.click() })
    const name = host.querySelector<HTMLInputElement>('.type-form input[name=name]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Doc Writer')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { host.querySelector<HTMLButtonElement>('.type-form button[type=submit]')!.click() })
    await flush()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/types/doc-writer')).toBe(true)
    await act(async () => { host.querySelector<HTMLButtonElement>('.type-cards [data-type=tester]')!.click() })
    const remove = [...host.querySelectorAll<HTMLButtonElement>('.type-form button')].find((b) => b.textContent === 'Remove')!
    await act(async () => { remove.click() })
    await flush()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/types/tester')).toBe(true)
  })
  it('groups each agent type\'s instructions with the others', async () => {
    stubFetch({
      '/api/registry': { ...REGISTRY, types: { tester: { harness: 'claude' } } },
      '/api/templates': [{ name: 'system-prompt', text: 'sys', overridden: false }, { name: 'type-tester', text: 'TEST RULES', overridden: false }],
    })
    setData({ agents: [agent({ type: 'tester' })], machine: 'alpha' })
    localStorage.setItem('stam/settings-section', 'instructions')
    localStorage.setItem('stam/settings-item', 'type-tester')
    await mount(<ConfigView />)
    const heads = [...host.querySelectorAll('.tpl-group > span:first-child')].map((s) => s.textContent)
    expect(heads).toContain('Type: tester')
    expect(host.querySelector('.tpl-editor .tpl-head')?.textContent).toContain('Applies to lead')
    expect(host.querySelector<HTMLTextAreaElement>('.tpl-editor textarea')?.value).toBe('TEST RULES')
  })
  it('keeps the instruction summaries model out of Mail', async () => {
    localStorage.setItem('stam/settings-section', 'mail')
    await mount(<ConfigView />)
    expect(host.querySelector('input[aria-label="Mail titles model"]')).toBeTruthy()
    expect(host.querySelector('input[aria-label="Instruction summaries model"]')).toBeNull()
    localStorage.removeItem('stam/settings-section')
  })
  it('shows the instruction summaries model next to Inventory by type', async () => {
    localStorage.setItem('stam/settings-section', 'instructions')
    await mount(<ConfigView />)
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Instruction summaries model"]')!
    expect(input).toBeTruthy()
    expect(host.querySelector('.set-row')?.textContent).toContain('Instruction summaries')
    expect(host.textContent).toContain('Inventory by type')
    localStorage.removeItem('stam/settings-section')
  })
  it('groups the instruction texts by agent type', async () => {
    localStorage.setItem('stam/settings-section', 'instructions')
    await mount(<ConfigView />)
    expect(host.querySelector('.settings-inner h2')?.textContent).toBe('Instructions')
    const heads = [...host.querySelectorAll('.tpl-group > span:first-child')].map((s) => s.textContent)
    expect(heads).toEqual(['All agents', 'Chief of staff', 'Executive assistant', 'Mail to you', 'Instruction files'])
    expect(host.querySelector('.tpl-list .item.sel')?.textContent).toContain('Your instructions')
    expect(host.querySelector('.tpl-editor .tpl-head')?.textContent).toContain('Applies to')
  })
  it('saves the all-agents instructions file', async () => {
    localStorage.setItem('stam/settings-section', 'instructions')
    await mount(<ConfigView />)
    const save = [...host.querySelectorAll<HTMLButtonElement>('.tpl-editor button')].find((b) => b.textContent === 'Save')!
    await act(async () => { save.click() })
    await flush()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/config/instructions')).toBe(true)
  })
  it('saves an instruction template and resets an edited one', async () => {
    vi.stubGlobal('confirm', () => true)
    localStorage.setItem('stam/settings-section', 'instructions')
    await mount(<ConfigView />)
    const item = [...host.querySelectorAll<HTMLButtonElement>('.tpl-list .item')].find((b) => b.textContent?.includes('Necessary'))!
    await act(async () => { item.click() })
    await flush()
    const save = [...host.querySelectorAll<HTMLButtonElement>('.tpl-editor button')].find((b) => b.textContent === 'Save')!
    await act(async () => { save.click() })
    await flush()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/templates/human-mail-when-necessary')).toBe(true)
    const reset = [...host.querySelectorAll<HTMLButtonElement>('.tpl-editor button')].find((b) => b.textContent === 'Reset to default')!
    await act(async () => { reset.click() })
    await flush()
    const post = calls.filter((c) => c.method === 'POST' && c.path === '/api/templates/human-mail-when-necessary').at(-1)!
    expect(post.body).toMatchObject({ reset: true })
  })
  it('opens the deep-linked item and clears it', async () => {
    localStorage.setItem('stam/settings-section', 'instructions')
    localStorage.setItem('stam/settings-item', 'chief-of-staff')
    await mount(<ConfigView />)
    expect(host.querySelector('.tpl-editor .tpl-head')?.textContent).toContain('chief-of-staff.md')
    expect(host.querySelector('.tpl-list .item.sel')?.textContent).toContain('Chief of staff')
    expect(localStorage.getItem('stam/settings-item')).toBeNull()
  })
  it('shows the list again when Settings is reopened after a deep link', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    localStorage.setItem('stam/settings-section', 'instructions')
    localStorage.setItem('stam/settings-item', 'chief-of-staff')
    await act(async () => { shell.showAgentWorld('w:config') })
    await mount(<ConfigView />)
    expect(host.querySelector('.tpl-layout')?.className).toContain('editing')
    await act(async () => { shell.showAgentWorld(null) })
    await flush()
    await act(async () => { shell.showAgentWorld('w:config') })
    await flush()
    expect(host.querySelector('.tpl-layout')?.className).not.toContain('editing')
    expect(host.querySelector('.tpl-list .item.sel')?.textContent).toContain('Chief of staff')
    await act(async () => { shell.showAgentWorld(null) })
  })
  it('lists only notices under Messages', async () => {
    localStorage.setItem('stam/settings-section', 'messages')
    await mount(<ConfigView />)
    const items = [...host.querySelectorAll('.tpl-list .item')].map((b) => b.textContent)
    expect(items.some((t) => t?.includes('permission-request'))).toBe(true)
    expect(items.some((t) => t?.includes('system-prompt'))).toBe(false)
    expect(items.some((t) => t?.includes('chief-of-staff'))).toBe(false)
  })
})

describe('ConfigView context section', () => {
  it('shows the growth field once, with the thresholds', async () => {
    localStorage.setItem('stam/settings-section', 'context')
    await mount(<ConfigView />)
    const rows = [...host.querySelectorAll('.set-row')].map((r) => r.querySelector('b')?.textContent)
    expect(rows.filter((r) => r?.startsWith('After a compaction'))).toHaveLength(1)
    expect(rows.indexOf('Compact at')).toBe(2)
    expect(rows[3]).toMatch(/^After a compaction/)
    expect(rows).not.toContain('When grown by')
  })
})

describe('state marks and legend', () => {
  it('gives each state a shape besides its colour, and dims stopped agents', async () => {
    await mount(<>{(['working', 'waiting', 'idle', 'blocked', 'errored'] as const).map((s) => <Glyph key={s} agent={agent({ id: s, activity: s })} />)}
      <Glyph agent={agent({ id: 'p', lifecycle: 'paused' })} /><Glyph agent={agent({ id: 's', lifecycle: 'shut_down' })} /></>)
    const g = (s: string) => host.querySelector(`.glyph[data-state="${s}"]`)!
    expect(g('working').querySelector('.pip')).not.toBeNull()
    expect(g('idle').querySelector('.pip')).toBeNull()
    for (const s of ['blocked', 'errored', 'paused']) expect(g(s).querySelector('.pip svg')).not.toBeNull()
    expect(g('waiting').querySelector('.pip svg')).toBeNull()
    expect(g('shut_down').classList.contains('off')).toBe(true)
  })
  it('opens the legend from the ? and closes on Escape', async () => {
    await mount(<><button id="q">?</button><MenuLayer /></>)
    await act(async () => { showLegend(host.querySelector<HTMLElement>('#q')!) })
    const pop = document.querySelector('.menu.popover[role=dialog]')!
    expect(pop).not.toBeNull()
    expect(pop.querySelectorAll('[data-legend]').length).toBe(STATES.length)
    expect(pop.textContent).toContain('Needs your approval')
    await act(async () => { pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.querySelector('.menu.popover')).toBeNull()
  })
  it('names the state and what it means in the row tooltip', () => {
    expect(agentTooltip(agent({ activity: 'blocked', activity_detail: 'permission Bash' }))).toContain('lead · blocked (permission Bash)\nBlocked: stopped at a prompt')
  })
})

describe('ConfigView MCP section', () => {
  it('lists the servers with kind, login state, and masked values', async () => {
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    expect(host.querySelector('.settings-inner h2')?.textContent).toBe('MCP servers')
    expect(host.querySelectorAll('.mcp-row').length).toBe(4)
    expect(host.textContent).toContain('remote · https://mcp.example.com/mcp')
    expect(host.textContent).toContain('OAuth')
    expect(host.textContent).toContain('logged in')
    // The env value is stored, never shown: only its name appears.
    expect(host.querySelector('.mcp-row[data-server=local]')?.textContent).toContain('env API_KEY')
    expect(host.textContent).not.toContain('sekret')
  })
  it('a peer shows the home\u2019s login state with no Log in button (S-3178)', async () => {
    stubFetch({ '/api/mcp/status': { servers: [
      { name: 'remote', type: 'oauth', logged_in: true, expires_at: null, leased_from: 'home-box' },
      { name: 'slack', type: 'oauth', logged_in: false, expires_at: null, local_grant: true },
    ], home: { name: 'home-box', reachable: true } } })
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    const remote = host.querySelector('.mcp-row[data-server=remote]')!
    expect(remote.textContent).toContain('Logged in on home-box')
    expect([...remote.querySelectorAll('button')].some((b) => b.textContent?.includes('Log in'))).toBe(false)
    expect(host.querySelector('.mcp-row[data-server=slack]')?.textContent).toContain('Not shared by home-box')
    // Only the peer's own old grant gets a logout, under its own name.
    expect([...host.querySelectorAll<HTMLButtonElement>('.mcp-row[data-server=slack] button')].some((b) => b.textContent === 'Remove local login')).toBe(true)
    expect([...remote.querySelectorAll<HTMLButtonElement>('button')].some((b) => b.textContent === 'Remove local login')).toBe(false)
  })
  it('a peer whose home is down shows the home unreachable, not a stale logged in', async () => {
    stubFetch({ '/api/mcp/status': { servers: [], home: { name: 'home-box', reachable: false, error: 'the home home-box is unreachable' } } })
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    const remote = host.querySelector('.mcp-row[data-server=remote]')!
    expect(remote.textContent).toContain('home-box unreachable')
    expect(remote.textContent).not.toContain('Logged in on home-box')
    expect(host.textContent).toContain('the home home-box is unreachable')
    expect([...remote.querySelectorAll('button')].some((b) => b.textContent?.includes('Log in'))).toBe(false)
  })
  it('a peer whose home is down shows the home error once, above the list, not under each row (S-3178)', async () => {
    stubFetch({ '/api/mcp/status': { servers: [], home: { name: 'home-box', reachable: false, error: 'the home home-box is unreachable' } } })
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    const rows = [...host.querySelectorAll('.mcp-row[data-server]')].filter((r) => r.textContent?.includes('unreachable'))
    expect(rows.length).toBeGreaterThan(1)
    expect(host.textContent?.split('the home home-box is unreachable').length - 1).toBe(1)
    expect(rows.every((r) => !r.textContent?.includes('the home home-box is unreachable'))).toBe(true)
  })
  it('a peer edit form has no Share with peers box (the home form keeps it, see the save test) (S-3178)', async () => {
    stubFetch({ '/api/mcp/status': { servers: [], home: { name: 'home-box', reachable: true } } })
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.mcp-row[data-server=remote] button')].find((b) => b.textContent === 'Edit')!.click() })
    await flush()
    expect([...host.querySelectorAll<HTMLElement>('.set-row')].some((r) => r.textContent?.includes('Share with peers'))).toBe(false)
  })
  it('the Share with peers box saves shareWithPeers through the settings save (S-3178)', async () => {
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.mcp-row[data-server=remote] button')].find((b) => b.textContent === 'Edit')!.click() })
    await flush()
    const box = [...host.querySelectorAll<HTMLElement>('.set-row')].find((r) => r.textContent?.includes('Share with peers'))!.querySelector<HTMLInputElement>('input[type=checkbox]')!
    expect(box.checked).toBe(false)
    await act(async () => { box.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.mcp-form button[type=submit]')!.click() })
    await flush()
    const post = calls.find((c) => c.method === 'PATCH' && c.path === '/api/config/settings')!
    const saved = (post.body as { patch: Record<string, any> }).patch
    expect(saved.mcpServers.remote.shareWithPeers).toBe(true)
    expect(saved.mcpServers.slack.shareWithPeers).toBeUndefined()
  })
  it('asks for a Slack app\u2019s client ID under a Slack URL, and not once it has one', async () => {
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    const edit = () => [...host.querySelectorAll<HTMLButtonElement>('.mcp-row[data-server=slack] button')].find((b) => b.textContent === 'Edit')!
    await act(async () => { edit().click() })
    await flush()
    expect(host.querySelector('.mcp-slack-note')?.textContent).toBe("Slack needs a Slack app's client ID and secret: see docs/slack.md")
    await act(async () => { host.querySelector<HTMLButtonElement>('.mcp-back')!.click() })
    await flush()
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.mcp-row[data-server=slack-app] button')].find((b) => b.textContent === 'Edit')!.click() })
    await flush()
    expect(host.querySelector('.mcp-slack-note')).toBeNull()
  })
  it('tests a server and shows its tool count', async () => {
    stubFetch({ '/api/mcp/local/test': { ok: true, tools: ['read', 'write', 'list'] } })
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    const test = [...host.querySelectorAll<HTMLButtonElement>('.mcp-row[data-server=local] button')].find((b) => b.textContent === 'Test')!
    await act(async () => { test.click() })
    await flush()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/mcp/local/test')).toBe(true)
    expect(host.querySelector('.mcp-row[data-server=local] .mcp-result')?.textContent).toContain('3 tools')
  })
  it('parses a pasted config and adds its servers', async () => {
    stubFetch({ '/api/mcp/parse': { servers: { pasted: { url: 'https://x.example/mcp' } }, notes: ['pasted: uses an env var'] } })
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    const area = host.querySelector<HTMLTextAreaElement>('.mcp-add textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '{"mcpServers":{"pasted":{"url":"https://x.example/mcp"}}}')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const preview = [...host.querySelectorAll<HTMLButtonElement>('.mcp-add button')].find((b) => b.textContent === 'Preview')!
    await act(async () => { preview.click() })
    await flush()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/mcp/parse')).toBe(true)
    expect(host.querySelector('.mcp-preview')?.textContent).toContain('pasted')
    expect(host.querySelector('.mcp-add')?.textContent).toContain('uses an env var')
    const add = [...host.querySelectorAll<HTMLButtonElement>('.mcp-preview button')].find((b) => b.textContent === 'Add')!
    await act(async () => { add.click() })
    await flush()
    const post = calls.find((c) => c.method === 'PATCH' && c.path === '/api/config/settings')!
    const saved = (post.body as { patch: Record<string, any> }).patch
    expect(saved.mcpServers.pasted).toEqual({ url: 'https://x.example/mcp' })
    expect(saved.mcpServers.local).toBeTruthy()
  })
  it('removes a server', async () => {
    vi.stubGlobal('confirm', () => true)
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    const rm = [...host.querySelectorAll<HTMLButtonElement>('.mcp-row[data-server=local] button')].find((b) => b.textContent === 'Remove')!
    await act(async () => { rm.click() })
    await flush()
    const post = calls.find((c) => c.method === 'PATCH' && c.path === '/api/config/settings')!
    const saved = (post.body as { patch: Record<string, any> }).patch
    expect(saved.mcpServers.local).toBeUndefined()
    expect(saved.mcpServers.remote).toBeTruthy()
  })
  it('saves only the keys it changed, so a view saved elsewhere since it opened survives', async () => {
    vi.stubGlobal('confirm', () => true)
    localStorage.setItem('stam/settings-section', 'mcp')
    const live = { text: JSON.stringify(SETTINGS) }
    stubFetch({ '/api/config/settings': live })
    await mount(<ConfigView />)
    // Another page saves a Work view after this one loaded the settings.
    live.text = JSON.stringify({ ...SETTINGS, workViews: { work: { views: [], current: '', cols: [], group: 'issues', show: 'open' } } })
    const rm = [...host.querySelectorAll<HTMLButtonElement>('.mcp-row[data-server=local] button')].find((b) => b.textContent === 'Remove')!
    await act(async () => { rm.click() })
    await flush()
    const post = calls.find((c) => c.method === 'PATCH' && c.path === '/api/config/settings')!
    const saved = (post.body as { patch: Record<string, any> }).patch
    expect(saved.mcpServers.local).toBeUndefined()
    expect(saved.workViews).toBeUndefined()
  })
  it('imports the harnesses\' servers, preselecting the new ones', async () => {
    stubFetch({ '/api/mcp/import': { servers: [
      { name: 'ctx', server: { command: 'ctx' }, group: '.mcp.json', file: '/w/.mcp.json', status: 'new' },
      { name: 'github', server: { url: 'https://api.githubcopilot.com/mcp/' }, group: '~/.claude.json', file: '~/.claude.json', status: 'new' },
      { name: 'local', server: { command: 'node' }, group: '~/.claude.json', file: '~/.claude.json', status: 'same' },
      { name: 'remote', server: { url: 'https://other/mcp' }, group: '~/.claude.json', file: '~/.claude.json', status: 'differs', differences: ['url: https://old → https://other'] },
    ] } })
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    const open = [...host.querySelectorAll<HTMLButtonElement>('.mcp-tools button')].find((b) => b.textContent?.includes('Import from harnesses'))!
    await act(async () => { open.click() })
    await flush()
    expect(calls.some((c) => c.method === 'GET' && c.path === '/api/mcp/import')).toBe(true)
    expect(host.querySelectorAll('.mcp-import-row').length).toBe(4)
    // New ones are preselected; an identical one and a clash are not.
    expect([...host.querySelectorAll<HTMLInputElement>('.mcp-import-row input[type=checkbox]')].filter((c) => c.checked).length).toBe(2)
    expect(host.querySelector('.mcp-import-row[data-import=local]')?.textContent).toContain('already added')
    expect(host.querySelector('.mcp-import-row[data-import=remote]')?.textContent).toContain('differs')
    expect(host.querySelector('.mcp-import-row[data-import=remote]')?.textContent).toContain('url: https://old → https://other')
    // GitHub's server defaults to the GitHub CLI login.
    expect(host.querySelector('.mcp-import-row[data-import=github]')?.textContent).toContain('GitHub CLI login')
    const add = [...host.querySelectorAll<HTMLButtonElement>('.mcp-import button')].find((b) => b.textContent === 'Add selected')!
    await act(async () => { add.click() })
    await flush()
    const post = calls.find((c) => c.method === 'PATCH' && c.path === '/api/config/settings')!
    const saved = (post.body as { patch: Record<string, any> }).patch
    expect(saved.mcpServers.ctx).toEqual({ command: 'ctx' })
    expect(saved.mcpServers.github).toEqual({ url: 'https://api.githubcopilot.com/mcp/', auth: { type: 'gh' } })
    expect(saved.mcpServers.remote.auth).toEqual({ type: 'oauth' })
  })
  it('defaults GitHub\'s server to the GitHub CLI login and notes an SSE url', async () => {
    stubFetch({ '/api/mcp/parse': { servers: { github: { url: 'https://api.githubcopilot.com/mcp/' }, sse: { url: 'https://x/sse' } }, notes: ["sse: stam connects over streamable HTTP; use the server's /mcp URL if it has one"] } })
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    const area = host.querySelector<HTMLTextAreaElement>('.mcp-add textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'x')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const preview = [...host.querySelectorAll<HTMLButtonElement>('.mcp-add button')].find((b) => b.textContent === 'Preview')!
    await act(async () => { preview.click() })
    await flush()
    const gh = host.querySelector('.mcp-prev-row[data-preview=github]')!
    expect([...gh.querySelectorAll('.seg button')].find((b) => b.textContent === 'GitHub CLI')?.className).toContain('on')
    expect(host.querySelector('.mcp-prev-row[data-preview=sse]')?.textContent).toContain('streamable HTTP')
  })
  it('browses the public registry and adds a server through its form', async () => {
    stubFetch({
      '/api/mcp/registry': { servers: [
        { name: 'com.example/docs', title: 'Example Docs', description: 'Docs.', version: '1.0.0', websiteUrl: 'https://docs.example.com', options: [{ kind: 'remote', label: 'Remote · https://docs.example.com/mcp', server: { url: 'https://docs.example.com/mcp' }, fields: [] }] },
        { name: 'com.example/token', title: 'Token Service', description: 'Needs a token.', version: '2.0.0', options: [{ kind: 'remote', label: 'Remote · https://token.example.com/mcp', server: { url: 'https://token.example.com/mcp' }, fields: [{ name: 'Authorization', description: 'A token.', required: true, secret: true, in: 'headers' }] }] },
      ] },
      '/api/mcp/registry/probe': { auth: 'oauth' },
    })
    localStorage.setItem('stam/settings-section', 'mcp')
    await mount(<ConfigView />)
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.mcp-tools button')].find((b) => b.textContent === 'Browse registry')!.click() })
    // The search is debounced.
    await act(async () => { await new Promise((r) => setTimeout(r, 350)) })
    expect(host.querySelectorAll('.mcp-reg-row').length).toBe(2)
    const docs = host.querySelector('.mcp-reg-row[data-registry="com.example/docs"]')!
    expect(docs.textContent).toContain('Example Docs')
    expect(docs.textContent).toContain('v1.0.0')
    // A server that needs a token: Add opens a form, and the secret field is a password.
    await act(async () => { host.querySelector<HTMLButtonElement>('.mcp-reg-row[data-registry="com.example/token"] button')!.click() })
    await flush()
    expect(host.querySelector('#mcp-reg-add')).toBeTruthy()
    const pw = host.querySelector<HTMLInputElement>('#mcp-reg-add input[type=password]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(pw, 'tok-123')
      pw.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('#mcp-reg-add button')].find((b) => b.textContent === 'Add')!.click() })
    await flush()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/mcp/registry/probe')).toBe(true)
    const post = calls.find((c) => c.method === 'PATCH' && c.path === '/api/config/settings')!
    const saved = (post.body as { patch: Record<string, any> }).patch
    expect(saved.mcpServers.token).toEqual({ url: 'https://token.example.com/mcp', headers: { Authorization: 'tok-123' }, auth: { type: 'oauth' } })
  })
})

describe('ConfigView Decision steps section', () => {
  const STEPS = {
    events: ['mail-to-human', 'itsa-created', 'itsa-status', 'agent-spawned'],
    steps: [
      { id: 'st1', name: 'Money mail', trigger: { kind: 'tool', tool: 'send_mail' }, question: 'Does this mail ask for money?', threshold: 0.5, action: 'deny-if-yes', enabled: true, builtin: null, created_at: '', updated_at: '' },
      { id: 'st2', name: 'Cost mail', trigger: { kind: 'event', event: 'mail-to-human' }, question: 'Is it about cost?', threshold: 0.7, action: 'notify', enabled: false, builtin: 'cost', created_at: '', updated_at: '' },
    ],
  }
  const TOOLS = { groups: [{ name: 'Mail', tools: [{ name: 'send_mail', description: 'Send mail.', inputSchema: {} }] }, { name: 'ITSAs', tools: [{ name: 'itsa_set', description: 'Change an ITSA.', inputSchema: {} }] }], harnessTools: { note: '' } }
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, v: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  }
  const open = async (extra: Record<string, unknown> = {}) => {
    stubFetch({ '/api/steps': STEPS, '/api/tools': TOOLS, ...extra })
    localStorage.setItem('stam/settings-section', 'steps')
    await mount(<ConfigView />)
  }
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text))!

  it('names a step after the question\'s first words', () => {
    expect(nameFrom('Does this mail ask Dana for money?')).toBe('Does this mail ask Dana for money')
    expect(nameFrom('  Is the agent about to delete files outside its worktree or push to main? ')).toBe('Is the agent about to delete files')
  })
  it('lists the steps in plain words and saves on/off at once', async () => {
    await open()
    expect(host.querySelector('.settings-inner h2')?.textContent).toBe('Decision steps')
    const rows = [...host.querySelectorAll('.step-row')]
    expect(rows.length).toBe(2)
    expect(rows[0].textContent).toContain('Before send_mail · Deny the call if yes')
    expect(rows[1].textContent).toContain('Each mail to you · Mail me')
    expect(rows[1].querySelector('.badge')?.textContent).toBe('Built in')
    await act(async () => { rows[0].querySelector<HTMLInputElement>('input[type=checkbox]')!.click() })
    await flush()
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/api/steps/st1', body: { enabled: false } })
  })
  it('adds a step: a trigger, a question, an action, and save', async () => {
    await open()
    await act(async () => { host.querySelector<HTMLButtonElement>('#add-step')!.click() })
    const select = host.querySelector<HTMLSelectElement>('select[name=trigger]')!
    // An event trigger offers the event actions.
    expect([...host.querySelectorAll('.step-actions .choice b')].map((b) => b.textContent)).toEqual(['Flag', 'Mail me', 'Note it on the item'])
    await act(async () => { setValue(select, 'tool:send_mail') })
    expect([...host.querySelectorAll('.step-actions .choice b')].map((b) => b.textContent)).toEqual(['Deny the call if yes', 'Allow the call only if yes'])
    expect(host.querySelector('.step-tool-desc')?.textContent).toBe('Send mail.')
    await act(async () => { setValue(host.querySelector<HTMLTextAreaElement>('textarea[name=question]')!, 'Does this mail ask for money?') })
    await act(async () => { button('Add step').click() })
    await flush()
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/steps')?.body).toEqual({
      trigger: { kind: 'tool', tool: 'send_mail' }, question: 'Does this mail ask for money?', action: 'deny-if-yes', name: 'Does this mail ask for money', threshold: 0.5,
    })
  })
  it('opens with a tool picked from Settings › Tools', async () => {
    stubFetch({ '/api/steps': STEPS, '/api/tools': TOOLS })
    localStorage.setItem('stam/settings-section', 'tools')
    await mount(<ConfigView />)
    await act(async () => { button('Add a step').click() })
    await flush()
    expect(host.querySelector('.settings-inner h2')?.textContent).toBe('Decision steps')
    expect(host.querySelector<HTMLSelectElement>('select[name=trigger]')?.value).toBe('tool:send_mail')
  })
  it('tests a step on recent examples and shows its decisions', async () => {
    await open({
      '/api/steps/st1/preview': { examples: [{ subject: 'tool:send_mail', summary: 'helper: pay me', p: 0.82, answer: true }, { subject: 'tool:send_mail', summary: 'helper: hi', p: 0.1, answer: false }] },
      '/api/steps/st1/log?limit=50': { decisions: [
        { id: 2, step_id: 'st1', ts: new Date().toISOString(), subject: 'tool:send_mail', p: 0.9, answer: true, action: 'denied', error: null },
        { id: 1, step_id: 'st1', ts: new Date().toISOString(), subject: 'tool:send_mail', p: null, answer: null, action: 'failed-open', error: 'timeout' },
      ] },
    })
    await act(async () => { host.querySelector<HTMLButtonElement>('.step-row[data-step=st1] .step-open')!.click() })
    await flush()
    const decs = [...host.querySelectorAll('.step-dec')].map((d) => d.textContent)
    expect(decs[0]).toMatch(/^YesA call of send_mail.*Denied90%$/)
    expect(decs[1]).toMatch(/Failed open: timeout/)
    await act(async () => { button('Last 10').click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('#step-test')!.click() })
    await flush()
    expect(calls.find((c) => c.path === '/api/steps/st1/preview')?.body).toEqual({ n: 10 })
    expect([...host.querySelectorAll('.step-ex')].map((x) => x.textContent)).toEqual(['Yeshelper: pay me82%', 'Nohelper: hi10%'])
    expect(host.querySelector('.step-sum')?.textContent).toBe('Yes on 1 of 2, at 0.5 or more.')
  })
  it('shows the API\'s note when there are no examples', async () => {
    await open({ '/api/steps/st1/preview': { examples: [], note: 'stam has no recorded calls of send_mail yet' }, '/api/steps/st1/log?limit=50': { decisions: [] } })
    await act(async () => { host.querySelector<HTMLButtonElement>('.step-row[data-step=st1] .step-open')!.click() })
    await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('#step-test')!.click() })
    await flush()
    expect(host.querySelector('.step-note')?.textContent).toBe('stam has no recorded calls of send_mail yet')
    expect(host.textContent).toContain('No decisions yet.')
  })
})

describe('WorkColumnsSettings', () => {
  const FIELDS = [
    { id: 'f1', key: 'stage', label: 'Stage', type: 'choice', options: [{ value: 'dev', label: 'Dev', tone: 'accent' }, { value: 'review', label: 'Review', tone: 'warn' }], description: 'Where the work is', hint: null, width: 'm', align: 'start', card: 'chip', position: 0 },
    { id: 'f2', key: 'due', label: 'Due', type: 'date', options: null, description: null, hint: null, width: 's', align: 'end', card: 'meta', position: 1 },
  ]
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
    Object.getOwnPropertyDescriptor((el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement).prototype, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const rowIds = () => [...host.querySelectorAll('.wcol-row')].map((r) => r.getAttribute('data-col'))
  // The Table tab, where the show, hide and order rows are; the section opens on Fields.
  const toTable = async () => { await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.wcol-tabs [role=tab]')].find((b) => b.textContent === 'Table')!.click() }) }

  it('opens on the Fields tab, with the tabs as a tab list and the other three hidden', async () => {
    stubFetch({ '/api/itsas/fields': FIELDS })
    await mount(<WorkColumnsSettings cos="boss" />)
    expect(location.hash).not.toContain('cfg')
    expect([...host.querySelectorAll('.wcol-tabs [role=tab]')].map((b) => b.textContent)).toEqual(['Fields', 'Table', 'Issue card', 'Agent card'])
    expect(host.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('Fields')
    expect(host.textContent).toContain('Agents define fields through @boss.')
    expect(host.querySelectorAll('.fld-row').length).toBe(2)
    expect(host.querySelector('.fld-row')?.textContent).toContain('Applies to: All kinds')
    expect(host.querySelector('.fld-row')?.textContent).toContain('Shown in:')
    expect(host.querySelector('.wcol-row')).toBeNull()
  })

  it('lists built-in and custom columns in one order, with the chief of staff note and tones', async () => {
    stubFetch({ '/api/itsas/fields': FIELDS })
    await mount(<WorkColumnsSettings cos="boss" />)
    await toTable()
    expect(host.textContent).toContain("Show, hide and order the Work page's columns.")
    expect(host.textContent).not.toContain('chief of staff')
    const ids = rowIds()
    expect(ids[0]).toBe('work')
    expect(ids.slice(-2)).toEqual(['field:f1', 'field:f2'])
    expect(host.querySelector('[data-col=work] input')).toBeNull()
    expect(host.querySelector('.wcol-edit')).toBeNull()
    expect([...host.querySelectorAll('[data-col="field:f1"] .wcol-opts .badge')].map((b) => b.className)).toEqual(['badge progress', 'badge warn'])
    expect(host.querySelector('.wcol-empty')).toBeNull()
  })

  it('moves a custom column past another and writes the fields order', async () => {
    stubFetch({ '/api/itsas/fields': FIELDS, '/api/itsas/fields/order': [{ ...FIELDS[1], position: 0 }, { ...FIELDS[0], position: 1 }] })
    await mount(<WorkColumnsSettings cos={null} />)
    await toTable()
    expect(host.textContent).not.toContain('chief of staff')
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Move Due up"]')!.click() })
    await flush()
    expect(calls.find((c) => c.path === '/api/itsas/fields/order')?.body).toEqual({ order: ['f2', 'f1'] })
    expect(rowIds().slice(-2)).toEqual(['field:f2', 'field:f1'])
  })

  it('keeps focus on the other arrow when the pressed one disables', async () => {
    stubFetch({ '/api/itsas/fields': FIELDS, '/api/itsas/fields/order': FIELDS })
    await mount(<WorkColumnsSettings cos={null} />)
    await toTable()
    const up = host.querySelector<HTMLButtonElement>('[aria-label="Move Agents up"]')!
    up.focus()
    await act(async () => { up.click() })
    await flush()
    expect(up.disabled).toBe(true)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move Agents down')
  })

  it('makes each option\'s tones a native radio group', async () => {
    stubFetch({ '/api/itsas/fields': FIELDS })
    await mount(<WorkColumnsSettings cos={null} />)
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Edit Stage"]')!.click() })
    const radios = [...host.querySelectorAll<HTMLInputElement>('[data-opt="1"] input[type=radio]')]
    expect(radios.map((r) => [r.name, r.value, r.checked])).toEqual([
      ['opt-tone-1', 'ok', false], ['opt-tone-1', 'warn', true], ['opt-tone-1', 'bad', false], ['opt-tone-1', 'muted', false], ['opt-tone-1', 'accent', false]])
  })

  it('keeps the list and offers Retry when a reload fails', async () => {
    stubFetch({ '/api/itsas/fields': FIELDS })
    await mount(<WorkColumnsSettings cos={null} />)
    const ok = globalThis.fetch as unknown as (p: string, i?: RequestInit) => Promise<unknown>
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => (path === '/api/itsas/fields' && (init?.method ?? 'GET') === 'GET' && fail
      ? { ok: false, status: 502, json: async () => ({ error: 'home daemon unreachable' }) } : ok(path, init))))
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Edit Due"]')!.click() })
    await act(async () => { host.querySelector<HTMLFormElement>('.wcol-form')!.requestSubmit() })
    await flush()
    expect(host.querySelector('.wcol-error')?.textContent).toContain('home daemon unreachable')
    expect(host.querySelectorAll('.fld-row').length).toBe(2)
    fail = false
    const retry = [...host.querySelectorAll<HTMLButtonElement>('.wcol-error button')].find((b) => b.textContent === 'Retry')!
    await act(async () => { retry.click() })
    await flush()
    expect(host.querySelector('.wcol-error')).toBeNull()
  })

  it('shows one line and the Add button with no fields, and adds one with a derived key', async () => {
    stubFetch({ '/api/itsas/fields': [] })
    await mount(<WorkColumnsSettings cos={null} />)
    expect(host.querySelector('.wcol-empty')?.textContent).toContain('No fields yet.')
    await act(async () => { host.querySelector<HTMLButtonElement>('#add-field')!.click() })
    await act(async () => { setValue(host.querySelector<HTMLInputElement>('input[name=label]')!, 'Due date') })
    const date = [...host.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent === 'Date')!
    await act(async () => { date.click() })
    await act(async () => { setValue(host.querySelector<HTMLTextAreaElement>('textarea[name=description]')!, 'When it is due') })
    await act(async () => { host.querySelector<HTMLFormElement>('.wcol-form')!.requestSubmit() })
    await flush()
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/itsas/fields')?.body).toEqual({
      key: 'due-date', label: 'Due date', type: 'date', options: null, description: 'When it is due', hint: null, width: 'm', align: 'start', kinds: null, card: 'meta',
    })
  })

  it('says any agent may define fields when no chief of staff is set', async () => {
    stubFetch({ '/api/itsas/fields': [] })
    await mount(<WorkColumnsSettings cos={null} />)
    expect(host.textContent).toContain('No chief of staff is set, so any agent may define fields.')
  })

  it('ticks an offered kind typed in another case, under its own spelling', async () => {
    stubFetch({ '/api/itsas/fields': [] })
    await mount(<WorkColumnsSettings cos={null} />)
    await act(async () => { host.querySelector<HTMLButtonElement>('#add-field')!.click() })
    const add = async (kind: string) => {
      await act(async () => { setValue(host.querySelector<HTMLInputElement>('input[name=kind-add]')!, kind) })
      await act(async () => { host.querySelector<HTMLButtonElement>('.wcol-kind-add .btn')!.click() })
    }
    await add('issue')
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="kind-issue"]')!.click() })
    expect(host.querySelector<HTMLInputElement>('input[name="kind-issue"]')!.checked).toBe(false)
    await add('ISSUE')
    expect(host.querySelectorAll('input[name="kind-issue"]').length).toBe(1)
    expect(host.querySelector<HTMLInputElement>('input[name="kind-issue"]')!.checked).toBe(true)
  })

  it('limits a field to the kinds picked, from the kinds in use or typed in', async () => {
    stubFetch({ '/api/itsas/fields': [] })
    await mount(<WorkColumnsSettings cos={null} />)
    await act(async () => { host.querySelector<HTMLButtonElement>('#add-field')!.click() })
    await act(async () => { setValue(host.querySelector<HTMLInputElement>('input[name=label]')!, 'Stage') })
    await act(async () => { setValue(host.querySelector<HTMLInputElement>('input[name=kind-add]')!, 'project') })
    await act(async () => { host.querySelector<HTMLButtonElement>('.wcol-kind-add .btn')!.click() })
    expect(host.querySelector<HTMLInputElement>('input[name="kind-project"]')!.checked).toBe(true)
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="kind-project"]')!.click() })
    expect(host.querySelector<HTMLInputElement>('input[name="kind-all"]')!.checked).toBe(true)
    await act(async () => { host.querySelector<HTMLInputElement>('input[name="kind-project"]')!.click() })
    await act(async () => { host.querySelector<HTMLFormElement>('.wcol-form')!.requestSubmit() })
    await flush()
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/itsas/fields')?.body).toMatchObject({ label: 'Stage', kinds: ['project'] })
  })

  it("shows the daemon's refusal inline", async () => {
    stubFetch({ '/api/itsas/fields': FIELDS })
    const ok = globalThis.fetch as unknown as (p: string, i?: RequestInit) => Promise<unknown>
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => (init?.method === 'PATCH'
      ? { ok: false, status: 400, json: async () => ({ error: 'field due (number): expected a number' }) } : ok(path, init))))
    await mount(<WorkColumnsSettings cos={null} />)
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Edit Due"]')!.click() })
    const num = [...host.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent === 'Number')!
    await act(async () => { num.click() })
    expect(host.textContent).toContain('Values already set must fit the new type.')
    await act(async () => { host.querySelector<HTMLFormElement>('.wcol-form')!.requestSubmit() })
    await flush()
    expect(host.querySelector('.wcol-form .sp-error')?.textContent).toBe('field due (number): expected a number')
  })
})

describe('WorkColumnsSettings Issue card tab', () => {
  // The phone breakpoint, as the page's usePhone reads it: `phone` answers the (max-width) query.
  const viewport = (phone: boolean) => {
    window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia
  }
  afterEach(() => { delete (window as { matchMedia?: unknown }).matchMedia })
  const selected = () => host.querySelector('[role=tab][aria-selected=true]')?.textContent
  const tabNames = () => [...host.querySelectorAll('.wcol-tabs [role=tab]')].map((b) => b.textContent)

  it('opens on the Issue card tab on a desktop, as the #cfg=fields/issue link asks', async () => {
    viewport(false)
    localStorage.setItem('stam/fields-tab', 'issue')
    stubFetch({ '/api/itsas/fields': [] })
    await mount(<WorkColumnsSettings cos={null} />)
    expect(tabNames()).toEqual(['Fields', 'Table', 'Issue card', 'Agent card'])
    expect(selected()).toBe('Issue card')
    expect(host.querySelector('.ice')).not.toBeNull()
  })

  it('opens the touch editor on a phone, with the same tabs', async () => {
    viewport(true)
    localStorage.setItem('stam/fields-tab', 'issue')
    stubFetch({ '/api/itsas/fields': [] })
    await mount(<WorkColumnsSettings cos={null} />)
    expect(tabNames()).toEqual(['Fields', 'Table', 'Issue card', 'Agent card'])
    expect(selected()).toBe('Issue card')
    expect(host.querySelector('.ipe')).not.toBeNull()
    expect(host.querySelector('.ice')).toBeNull()
  })
})

describe('SkillsSettings import and update', () => {
  const skill = (extra = {}) => ({ name: 'fixture-imported', path: '/h/skills/fixture-imported', source: 'imported', description: 'd', tokens: 10, extraTokens: 0, reaches: { claude: 'native', opencode: 'native', codex: 'native' }, bodySummary: { state: 'off' }, origin: { url: 'https://github.com/o/r', path: 'skills/fixture-imported', commit: '3f2a9c1d8e', date: '2026-10-12T10:00:00Z' }, ...extra })

  it('posts the source to /api/skills/import and clears the field', async () => {
    stubFetch({ '/api/skills': [], '/api/skills/updates': {} })
    await mount(<SkillsSettings />)
    const input = host.querySelector<HTMLInputElement>('.skill-import input')!
    expect(host.querySelector<HTMLButtonElement>('.skill-import button')!.disabled).toBe(true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'o/r/skills/x')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { host.querySelector<HTMLFormElement>('.skill-import')!.requestSubmit() })
    await flush()
    expect(calls.find((c) => c.path === '/api/skills/import')?.body).toEqual({ source: 'o/r/skills/x' })
    expect(host.querySelector<HTMLInputElement>('.skill-import input')!.value).toBe('')
  })

  it('shows the refusal under the field and keeps the source', async () => {
    stubFetch({ '/api/skills': [], '/api/skills/updates': {} })
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => (init?.method === 'POST'
      ? { ok: false, status: 400, json: async () => ({ error: 'a skill called "x" already exists' }) }
      : { ok: true, status: 200, json: async () => (path === '/api/skills' ? [] : {}) })))
    await mount(<SkillsSettings />)
    const input = host.querySelector<HTMLInputElement>('.skill-import input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'o/r/x')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { host.querySelector<HTMLFormElement>('.skill-import')!.requestSubmit() })
    await flush()
    expect(host.querySelector('.skill-import .sp-error')?.textContent).toBe('a skill called "x" already exists')
    expect(host.querySelector<HTMLInputElement>('.skill-import input')!.value).toBe('o/r/x')
  })

  it('offers Update only when the origin moved, and posts the name', async () => {
    stubFetch({ '/api/skills': [skill()], '/api/skills/updates': { 'fixture-imported': { moved: true, commit: 'b71c0de' } } })
    await mount(<SkillsSettings />)
    expect(host.textContent).toContain('Update available')
    expect(host.textContent).toContain('o/r/skills/fixture-imported @ 3f2a9c1')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.skill-origin button')].find((b) => b.textContent === 'Update')!.click() })
    await flush()
    expect(calls.find((c) => c.path === '/api/skills/update')?.body).toEqual({ name: 'fixture-imported' })
  })

  it('shows a refused Update beside its button, not under Import', async () => {
    const routes: Record<string, unknown> = { '/api/skills': [skill()], '/api/skills/updates': { 'fixture-imported': { moved: true } } }
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => (init?.method === 'POST'
      ? { ok: false, status: 400, json: async () => ({ error: 'the origin\'s skill is now called "x"' }) }
      : { ok: true, status: 200, json: async () => routes[path] ?? {} })))
    await mount(<SkillsSettings />)
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.skill-origin button')].find((b) => b.textContent === 'Update')!.click() })
    await flush()
    expect(host.querySelector('.skill-origin .sp-error')?.textContent).toBe('the origin\'s skill is now called "x"')
    expect(host.querySelector('.skill-import .sp-error')).toBeNull()
  })

  it('shows no Update when the origin has not moved', async () => {
    stubFetch({ '/api/skills': [skill()], '/api/skills/updates': { 'fixture-imported': { moved: false, commit: '3f2a9c1d8e' } } })
    await mount(<SkillsSettings />)
    expect(host.textContent).not.toContain('Update available')
    expect(host.querySelector('.skill-origin button')).toBeNull()
  })
})

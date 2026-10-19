// Invented data for the Usage stories (docs/stories.md): every name is fixture-*, every number made
// up, nothing from a live database. It builds the answers of GET /api/usage, /api/usage/issues,
// /api/usage/series, /api/usage/scope and /api/activity, in the shapes of ./types.ts, ./charts/math.ts
// and ./drill/types.ts.
import { reply } from '../stories/types'
import type { DrillKind, Series, SeriesGroupInfo, SeriesRow } from './charts/math'
import type { ScopeAgent, ScopeAnswer, ScopeItsa, ScopeModel, ScopeWindow, Tot, Typical } from './drill/types'
import type {
  Account, AgentRow, Allocation, BlockedAgent, ConfigRow, IssueRow, Issues, Modes, ModelRow, Totals, TreeNode, Usage, WindowShares,
} from './types'
import { SUMMARY, SUMMARY_DEV_MANAGER, SUMMARY_DEVELOPERS, SUMMARY_EMPTY } from './activity/summaryFixture'

const DAY = 86_400_000
const MIN = 60_000
const dayKey = (ago: number) => new Date(Date.now() - ago * DAY).toISOString().slice(0, 10)
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString()
const epoch = (ms: number) => Math.floor((Date.now() + ms) / 1000)
// A repeatable wobble in [0, 1), so a series looks like use without a random number.
const wob = (i: number, j = 0) => { const x = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453; return x - Math.floor(x) }

const totals = (cost: number | null, tin: number | null, tout: number | null, cr: number | null, cw: number | null): Totals => ({ cost_usd: cost, tokens_in: tin, tokens_out: tout, tokens_cache_read: cr, tokens_cache_write: cw })

// --- Accounts: one near 100% on both windows, one at 100% on its 5-hour window, one paid by balance.
const shares = (percent: number, change: number, hours: number): WindowShares => ({
  estimate: true,
  since: inMs(-5 * 60 * MIN),
  change,
  other: 6,
  agents: [
    { id: 'fx-a1', agent: 'fixture-dev-1', percent: 18 },
    { id: 'fx-a2', agent: 'fixture-dev-2', percent: 11 },
    { id: 'fx-a3', agent: 'fixture-review-1', percent: 3 },
  ],
  trees: [{ id: 'fx-t1', root: 'fixture-tree-a', percent: 24 }, { id: 'fx-t2', root: 'fixture-tree-b', percent: 8 }],
  by_agent: [
    { id: 'fx-a1', agent: 'fixture-dev-1', percent: 18 }, { id: 'fx-a2', agent: 'fixture-dev-2', percent: 11 },
    { id: 'fx-a3', agent: 'fixture-review-1', percent: 3 }, { id: 'fx-a4', agent: 'fixture-docs-1', percent: 2 },
  ],
  by_tree: [{ id: 'fx-t1', root: 'fixture-tree-a', percent: 24 }, { id: 'fx-t2', root: 'fixture-tree-b', percent: 8 }],
  by_model: [{ model: 'claude-opus-5-5', percent: 29 }, { model: 'claude-sonnet-5-5', percent: 3 }],
  by_day: [{ day: dayKey(1), percent: 9 }, { day: dayKey(0), percent: 23 }],
  worth: { estimate: true, worth_usd: { low: 28, mid: 34, high: 41 }, used_usd: 32.6, left_usd: 1.4, percent_used: percent, samples: 14 },
  projection: { estimate: true, used_percentage: percent, percent_per_hour: 12.4, reaches_100_at: percent >= 100 ? null : inMs(hours * 60 * MIN), resets_at: inMs(180 * MIN), note: percent >= 100 ? 'already at 100%' : undefined },
})

export const ACCOUNT_CLAUDE: Account = {
  account: 'fixture-claude-max',
  match: { harness: 'claude' },
  windows: { five_hour: { used_percentage: 96, resets_at: epoch(95 * MIN) }, seven_day: { used_percentage: 91, resets_at: epoch(2 * DAY) } },
  updated_at: inMs(-2 * MIN), age_ms: 2 * MIN, stale: false,
  paid: { today: { usd: null, source: 'unknown' }, week: { usd: null, source: 'unknown' }, month: { usd: null, source: 'unknown' } },
  balance: null, budget: null,
  shares: { five_hour: shares(96, 38, 0.3), seven_day: shares(91, 52, 9) },
}
// A quiet week and a busy last day (S-1523): the 7-day pace ends the week near 70%, the 24h pace hits 100% first.
export const ACCOUNT_BUSY_DAY: Account = {
  ...ACCOUNT_CLAUDE,
  account: 'fixture-claude-busy-day',
  windows: { seven_day: { used_percentage: 58, resets_at: epoch(2 * DAY) } },
  shares: {
    seven_day: {
      ...shares(58, 40, 0),
      projection: {
        estimate: true, used_percentage: 58, percent_per_hour: 1.2, reaches_100_at: null, resets_at: inMs(2 * DAY),
        pace_7d: { estimate: true, percent_per_hour: 0.3, covered_hours: 160, at_reset: 72, reaches_100_at: null },
        pace_24h: { estimate: true, percent_per_hour: 1.6, covered_hours: 22, at_reset: 100, reaches_100_at: inMs(26 * 60 * MIN) },
      },
    },
  },
}
export const ACCOUNT_CODEX: Account = {
  account: 'fixture-codex-plus',
  match: { harness: 'codex' },
  windows: { five_hour: { used_percentage: 100, resets_at: epoch(40 * MIN) }, seven_day: { used_percentage: 83, resets_at: epoch(4 * DAY) } },
  updated_at: inMs(-4 * MIN), age_ms: 4 * MIN, stale: false,
  paid: { today: { usd: null, source: 'unknown' }, week: { usd: null, source: 'unknown' }, month: { usd: null, source: 'unknown' } },
  balance: null, budget: null,
  shares: null,
}
export const ACCOUNT_OPENCODE: Account = {
  account: 'fixture-openrouter',
  match: { harness: 'opencode' },
  windows: {},
  updated_at: inMs(-10 * MIN), age_ms: 10 * MIN, stale: false,
  paid: { today: { usd: 1.84, source: 'exact' }, week: { usd: 11.2, source: 'exact' }, month: { usd: 46.8, source: 'estimate' } },
  balance: 3.2,
  budget: { usd: 50, per: 'month', spent: 46.8, remaining: 3.2 },
  shares: null,
}
// The two OpenRouter budgets (S-1077): the agents' account near its cap, and stam's own calls on their own account.
const agentsBudget = (spent: number): Account => ({ ...ACCOUNT_OPENCODE, account: 'openrouter', balance: null, budget: { usd: 50, per: 'month', spent, remaining: 50 - spent } })
const systemBudget = (spent: number | null, usd = 3): Account => ({ ...ACCOUNT_OPENCODE, account: 'openrouter-system', match: { harness: 'stam' }, balance: null, budget: spent == null ? null : { usd, per: 'day', spent, remaining: usd - spent } })
export const ACCOUNT_OR_AGENTS = agentsBudget(41)
export const ACCOUNT_OR_SYSTEM = systemBudget(0.6)
export const ACCOUNT_OR_AGENTS_SPENT = agentsBudget(50)
export const ACCOUNT_OR_SYSTEM_LOW = systemBudget(2.7)
export const ACCOUNT_OR_SYSTEM_UNSET = systemBudget(null)
// The same Claude account with a reading three hours old.
export const ACCOUNT_STALE: Account = { ...ACCOUNT_CLAUDE, account: 'fixture-claude-old', stale: true, age_ms: 3 * 60 * MIN, updated_at: inMs(-3 * 60 * MIN), shares: null }

export const BLOCKED: BlockedAgent[] = [{
  agent_id: 'fx-b1', agent: 'fixture-dev-3', lifecycle: 'paused', paused_by: ['fixture-cos'],
  blockers: [{ kind: 'window', account: 'fixture-codex-plus', reason: 'The 5-hour window is at 100%; it resets in 40 minutes.', since: inMs(-20 * MIN), clear: null }],
}]

export const ALLOCATIONS: Allocation[] = [
  { id: 'al1', root: 'fixture-tree-a', root_id: 'fx-t1', account: 'fixture-claude-max', kind: 'window', window: 'seven_day', percent: 40, amount: null, period: 'week', used: 36, used_percent: 90 },
  { id: 'al2', root: 'fixture-tree-b', root_id: 'fx-t2', account: 'fixture-openrouter', kind: 'usd', window: '', percent: null, amount: 10, period: 'day', used: 10.4, used_percent: 104 },
  { id: 'al3', root: 'fixture-tree-c', root_id: 'fx-t3', account: 'fixture-claude-max', kind: 'window', window: 'five_hour', percent: 20, amount: null, period: 'week', used: 5, used_percent: 25 },
]

// --- Rows: three harnesses, and 36 agents.
const MODELS: { harness: string; model: string }[] = [
  { harness: 'claude', model: 'claude-opus-5-5' }, { harness: 'claude', model: 'claude-sonnet-5-5' }, { harness: 'claude', model: 'claude-haiku-5-5' },
  { harness: 'codex', model: 'gpt-6.1-sol' }, { harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash' },
]
// API prices in USD per million tokens (in, out, cache read, cache write); null = unverified.
const PRICES: Record<string, [number, number, number | null, number | null] | null> = {
  'claude-opus-5-5': [4, 20, 0.2, 5], 'claude-sonnet-5-5': [1, 5, 0.1, 1.25], 'claude-haiku-5-5': [0.4, 2, 0.04, 0.5],
  'gpt-6.1-sol': [1.5, 8, 0.15, null], 'openrouter/deepseek/deepseek-v4.1-flash': [0.2, 0.8, null, null], 'fixture-unpriced-model': null,
}
// A row's totals with the daemon's per-kind API-equivalent costs (src/attribution.ts kindCosts) and
// its share of the week: null for a model off a subscription's price list, 0 for one not on a subscription.
const priced = (model: string, t: Totals, week: number | null): Totals => {
  const p = PRICES[model.replace(/\[.*\]$/, '')]
  const usd = (tokens: number | null, i: number) => (p == null || tokens == null || p[i] == null ? null : (tokens * (p[i] as number)) / 1e6)
  const parts = [usd(t.tokens_in, 0), usd(t.tokens_out, 1), usd(t.tokens_cache_read, 2), usd(t.tokens_cache_write, 3)]
  const reported = [t.tokens_in, t.tokens_out, t.tokens_cache_read, t.tokens_cache_write].map((x, i) => [x, parts[i]] as const).filter(([x]) => x != null)
  const total = p != null && reported.every(([, c]) => c != null) ? reported.reduce((x, [, c]) => x + c!, 0) : null
  const modes = week == null ? undefined : { api: t.cost_usd ?? 0, five_hour: week, seven_day: week, subscription: week ? week / 4 : 0, paid_usd: 0 }
  return { ...t, cost_in: parts[0], cost_out: parts[1], cost_cache_read: parts[2], cost_cache_write: parts[3], cost_api_total: total, ...(modes ? { modes } : {}) }
}
const weekOf = (harness: string, f: number): number => (harness === 'opencode' ? 0 : f * (harness === 'claude' ? 30 : 12))
export const BY_MODEL: ModelRow[] = [
  ...MODELS.map((x, i) => {
    const cost = [41.6, 12.3, 3.1, 9.8, 4.2][i]
    const noCache = x.harness === 'opencode'
    const t = (f: number) => priced(x.model, totals(+(cost * f).toFixed(2), Math.round(cost * 90_000 * f), Math.round(cost * 9_000 * f), noCache ? null : Math.round(cost * 600_000 * f), noCache ? null : Math.round(cost * 40_000 * f)), weekOf(x.harness, [1, 0.3, 0.08, 1, 1][i] * f))
    return { ...x, ...t(1), cost_usd: cost, today: t(0.2), lifetime: t(3.4) }
  }),
  // A long session: a huge cache read dwarfs every other count, which is what made the columns confusing.
  ...[{ harness: 'claude', model: 'claude-opus-5-5[1m]', cost: 58.4 }].map((x) => {
    const t = (f: number) => priced(x.model, totals(+(x.cost * f).toFixed(2), Math.round(210_000 * f), Math.round(640_000 * f), Math.round(412_000_000 * f), Math.round(9_800_000 * f)), 41 * f)
    return { harness: x.harness, model: x.model, ...t(1), cost_usd: x.cost, today: t(0.2), lifetime: t(3.4) }
  }),
  // A model with no verified price: every cost reads as a dash.
  ...[{ harness: 'opencode', model: 'fixture-unpriced-model', cost: 0.6 }].map((x) => {
    const t = (f: number) => priced(x.model, totals(+(x.cost * f).toFixed(2), Math.round(480_000 * f), Math.round(61_000 * f), null, null), 0)
    return { harness: x.harness, model: x.model, ...t(1), cost_usd: x.cost, today: t(0.2), lifetime: t(3.4) }
  }),
]

const AGENT_KINDS = ['dev', 'review', 'docs', 'ops', 'test']
// 40 agents across every agent type (S-1491): the chief of staff, the assistant and intake lead, then the registry's
// types in turn, developers the most, and untyped agents (a few of them archived in the live system).
const TYPE_ROWS: [string, string][] = [['fixture-cos', 'chief-of-staff'], ['fixture-assistant', 'assistant'], ['fixture-intake', 'intake']]
export const TYPE_CYCLE = ['developer', 'developer', 'manager', 'reviewer', 'developer', 'untyped', 'manager', 'advisor', 'developer', 'coordinator', 'reviewer-opus', 'developer', 'reviewer-fallback', 'retro-steward']
export const BY_AGENT: AgentRow[] = Array.from({ length: 40 }, (_, i) => {
  const m = MODELS[i % MODELS.length]
  const cost = +(0.4 + wob(i) * 9).toFixed(2)
  const noCache = m.harness === 'opencode'
  const t = (f: number) => totals(+(cost * f).toFixed(2), Math.round(cost * 80_000 * f), Math.round(cost * 8_000 * f), noCache ? null : Math.round(cost * 500_000 * f), noCache ? null : Math.round(cost * 30_000 * f))
  return { agent_id: `fx-ag-${i}`, agent: TYPE_ROWS[i]?.[0] ?? `fixture-${AGENT_KINDS[i % AGENT_KINDS.length]}-${String(i + 1).padStart(2, '0')}`, type: TYPE_ROWS[i]?.[1] ?? TYPE_CYCLE[(i - 3) % TYPE_CYCLE.length], harness: m.harness, model: m.model, ...t(1), today: t(0.15), lifetime: t(2.2) }
})

const node = (id: string, name: string, cost: number, children: TreeNode[] = [], pct?: number): TreeNode => ({
  id, name, cost_usd: cost, tokens: Math.round(cost * 100_000), children,
  shares: pct ? { 'fixture-claude-max': { seven_day: { estimate: true, percent: pct } } } : {},
})
export const TREES: TreeNode[] = [
  node('fx-t1', 'fixture-tree-a', 38.4, [
    node('fx-t1a', 'fixture-dev-01', 14.2, [node('fx-t1a1', 'fixture-test-05', 2.9), node('fx-t1a2', 'fixture-review-02', 4.1)], 12),
    node('fx-t1b', 'fixture-docs-03', 6.3),
  ], 41),
  node('fx-t2', 'fixture-tree-b', 11.7, [node('fx-t2a', 'fixture-ops-04', 3.2)], 9),
  node('fx-t3', 'fixture-tree-c', 0.8),
]

export const BY_DAY = Array.from({ length: 7 }, (_, i) => {
  const cost = +(5 + wob(i, 3) * 14).toFixed(2)
  return { day: dayKey(6 - i), cost_usd: cost, tokens_in: Math.round(cost * 90_000), tokens_out: Math.round(cost * 9_000) }
})

const NOTE = 'API-equivalent dollars: what the tokens would cost at API prices. Subscription use is not billed per token.'

export const USAGE: Usage = {
  today: { cost_usd: 18.35, tokens_in: 1_650_000, tokens_out: 165_000, tokens_cache_read: 11_200_000, tokens_cache_write: 830_000 },
  subscriptions: [{ name: 'fixture-claude-max', windows: {} }],
  accounts: [ACCOUNT_CLAUDE, ACCOUNT_CODEX, ACCOUNT_OPENCODE],
  allocations: ALLOCATIONS,
  trees: TREES,
  blocked: BLOCKED,
  instructions: 'Keep reviews on the cheaper reviewer model, and pause low-priority trees when a window passes 90%.',
  shares_note: 'Shares are estimates from stam\'s own samples of each window.',
  by_day: BY_DAY, by_model: BY_MODEL, by_agent: BY_AGENT, note: NOTE,
}
// The same page filtered to developers (S-1753): rows and sums of that type only, the bar's counts and the
// account-wide limits unchanged. A third of the spend, the way the daemon's per-type sums add up.
const sc = (n: number | null | undefined, f: number) => (n == null ? n : +(n * f).toFixed(2))
const scale = <T extends Partial<Totals>>(t: T, f: number): T => ({ ...t, cost_usd: sc(t.cost_usd, f), tokens_in: sc(t.tokens_in, f), tokens_out: sc(t.tokens_out, f), tokens_cache_read: sc(t.tokens_cache_read, f), tokens_cache_write: sc(t.tokens_cache_write, f),
  cost_in: sc(t.cost_in, f), cost_out: sc(t.cost_out, f), cost_cache_read: sc(t.cost_cache_read, f), cost_cache_write: sc(t.cost_cache_write, f), cost_api_total: sc(t.cost_api_total, f), modes: undefined })
const scaleTree = (n: TreeNode, f: number): TreeNode => ({ ...n, cost_usd: +(n.cost_usd * f).toFixed(2), tokens: Math.round(n.tokens * f), modes: undefined, children: n.children.map((c) => scaleTree(c, f)) })
const DEV_TYPES = BY_AGENT.reduce<Record<string, number>>((m, r) => ({ ...m, [r.type!]: (m[r.type!] ?? 0) + 1 }), {})
export const USAGE_FILTERED: Usage = {
  ...USAGE,
  filtered_agents: ['developer'],
  agent_types: Object.entries(DEV_TYPES).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  by_agent: BY_AGENT.filter((r) => r.type === 'developer'),
  by_day: BY_DAY.map((d) => ({ ...d, cost_usd: +(d.cost_usd / 3).toFixed(2), tokens_in: Math.round(d.tokens_in / 3), modes: undefined })),
  by_model: BY_MODEL.map((m) => ({ ...scale(m, 1 / 3), today: scale(m.today, 1 / 3), lifetime: scale(m.lifetime, 1 / 3) })),
  trees: TREES.slice(0, 2).map((t) => scaleTree(t, 1 / 3)),
  today: { ...USAGE.today, cost_usd: +(USAGE.today.cost_usd / 3).toFixed(2), modes: undefined },
}
// Nothing reported yet: no accounts, no spend.
export const USAGE_EMPTY: Usage = {
  today: { cost_usd: 0, tokens_in: 0, tokens_out: 0 }, subscriptions: [], accounts: [], allocations: [], trees: [], blocked: [], by_day: [], by_model: [], by_agent: [], note: NOTE,
}
export const USAGE_STALE: Usage = { ...USAGE, accounts: [ACCOUNT_STALE, ACCOUNT_CODEX, ACCOUNT_OPENCODE], blocked: [], allocations: [] }
// A calm week: low windows, no block, no allocation.
export const USAGE_CALM: Usage = {
  ...USAGE, blocked: [], allocations: [],
  accounts: [
    { ...ACCOUNT_CLAUDE, windows: { five_hour: { used_percentage: 12, resets_at: epoch(250 * MIN) }, seven_day: { used_percentage: 34, resets_at: epoch(5 * DAY) } }, shares: null },
    { ...ACCOUNT_CODEX, windows: { five_hour: { used_percentage: 8, resets_at: epoch(270 * MIN) }, seven_day: { used_percentage: 21, resets_at: epoch(6 * DAY) } } },
  ],
}

// --- Issues
const tok = (cost: number) => ({ cost_usd: cost, tokens_in: Math.round(cost * 90_000), tokens_out: Math.round(cost * 9_000), tokens_cache_read: Math.round(cost * 500_000), tokens_cache_write: Math.round(cost * 30_000) })
const CONFIGS = ['claude · claude-opus-5-5', 'claude · claude-sonnet-5-5', 'codex · gpt-6.1-sol', 'opencode · openrouter/deepseek/deepseek-v4.1-flash']
export const ISSUES: Issues = {
  note: 'Cost per closed issue.',
  issues: Array.from({ length: 12 }, (_, i): IssueRow => {
    const cost = +(14 - i * 1.05).toFixed(2)
    const config = CONFIGS[i % CONFIGS.length]
    return {
      key: `FX-${200 + i}`, title: ['Fixture: tidy the parser', 'Fixture: add a retry', 'Fixture: split the module', 'Fixture: document the flags'][i % 4],
      kind: 'issue', status: i === 9 ? 'canceled' : 'done', closed_at: inMs(-i * DAY),
      own: { ...tok(cost), manager_cost_usd: i % 3 === 0 ? 1.2 : 0 }, total: tok(cost + 2), agents: 1 + (i % 4), config,
      weekly_percent: config.startsWith('claude') || config.startsWith('codex') ? 2 + i : null,
    }
  }),
  by_config: CONFIGS.map((config, i): ConfigRow => ({ config, n: 9 - i * 2, median: 4.2 - i * 0.7, average: 5.1 - i * 0.8, min: 0.4, max: 14 - i * 3, median_weekly_percent: i < 3 ? 3 + i : null })),
  unattributed: tok(6.4),
}
export const ISSUES_EMPTY: Issues = { note: '', issues: [], by_config: [], unattributed: tok(0) }
// A busy period: 36 issues closed over the last six days, long titles, every configuration, and a
// few that spent nothing (the Finished issues panel lists only the ones with spend).
export const ISSUES_MANY: Issues = {
  note: 'Cost per closed issue.',
  issues: Array.from({ length: 36 }, (_, i): IssueRow => {
    const cost = +(26 - i * 0.6).toFixed(2)
    const config = CONFIGS[i % CONFIGS.length]
    const spent = i % 9 !== 4
    return {
      key: `FX-${400 + i}`, title: ['Fixture: split the long migration into steps', 'Fixture: keep the retry delay between attempts', 'Fixture: name the cache key after the tenant', 'Fixture: log the refused write once'][i % 4],
      kind: 'issue', status: i % 13 === 10 ? 'canceled' : 'done', closed_at: inMs(-(i % 6) * DAY - i * 60_000),
      own: spent ? { ...tok(cost), manager_cost_usd: i % 4 === 0 ? 1.4 : 0 } : { ...tok(0), manager_cost_usd: 0 },
      total: tok(spent ? cost + 2 : 0), agents: 1 + (i % 5), config,
      weekly_percent: config.startsWith('claude') || config.startsWith('codex') ? 1 + (i % 6) : null,
    }
  }),
  by_config: ISSUES.by_config,
  unattributed: tok(6.4),
}

// --- Spend per bucket (GET /api/usage/series)
const GROUPS: Record<string, SeriesGroupInfo[]> = {
  tree: [{ id: 't1', name: 'fixture-tree-a' }, { id: 't2', name: 'fixture-tree-b' }, { id: 't3', name: 'fixture-tree-c' }, { id: 'other', name: 'Other' }],
  itsa: [{ id: 'i1', name: 'FX-201' }, { id: 'i2', name: 'FX-202' }, { id: 'i3', name: 'FX-203' }, { id: 'unattributed', name: 'Unattributed' }],
  model: [
    { id: 'claude · claude-opus-5-5', name: 'Opus 5.5', harness: 'claude' }, { id: 'claude · claude-sonnet-5-5', name: 'Sonnet 5.5', harness: 'claude' },
    { id: 'codex · gpt-6.1-sol', name: 'gpt-6.1-sol', harness: 'codex' }, { id: 'opencode · deepseek-v4.1-flash', name: 'DeepSeek v4.1 flash', harness: 'opencode' },
  ],
  harness: [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }, { id: 'opencode', name: 'OpenCode' }],
}
export function series(group: 'tree' | 'itsa' | 'model' | 'harness', n: number, bucket: 'day' | 'hour' = 'day', scale = 1): Series {
  const groups = GROUPS[group]
  const row = (t: string, i: number, shift: number): SeriesRow => {
    const g: SeriesRow['groups'] = {}
    groups.forEach((x, j) => { g[x.id] = { cost_usd: +((wob(i + shift, j) * (4 - j * 0.8) + 0.2) * scale).toFixed(2) } })
    return { t, cost_usd: +Object.values(g).reduce((a, b) => a + b.cost_usd, 0).toFixed(2), groups: g }
  }
  const rows = Array.from({ length: n }, (_, i) => {
    const t = bucket === 'hour'
      ? new Date(new Date().setUTCHours(i, 0, 0, 0)).toISOString().slice(0, 13) + ':00:00.000Z'
      : dayKey(n - 1 - i)
    return row(t, i, 0)
  })
  const previous_rows = bucket === 'day' ? Array.from({ length: n }, (_, i) => row(dayKey(2 * n - 1 - i), i, 40)) : undefined
  const sum = (rs: SeriesRow[]) => +rs.reduce((a, r) => a + r.cost_usd, 0).toFixed(2)
  return { days: n, group, bucket, groups, rows, previous_rows, total: { cost_usd: sum(rows) }, previous: { cost_usd: previous_rows ? sum(previous_rows) : 0 } }
}
// The stub answers for every period and grouping the page asks for: 1 day (hourly), 7 days (6), 30 days and all time (29).
export function seriesRoutes(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const g of ['tree', 'itsa', 'model', 'harness'] as const) {
    out[`GET /api/usage/series?days=1&group=${g}`] = series(g, 24, 'hour', 0.4)
    out[`GET /api/usage/series?days=6&group=${g}`] = series(g, 7)
    out[`GET /api/usage/series?days=29&group=${g}`] = series(g, 30)
  }
  return out
}
export const SERIES_EMPTY_ROUTES = { 'GET /api/usage/series': { ...series('tree', 7), rows: [], previous_rows: [], total: { cost_usd: 0 } } }
export const SERIES_ERROR_ROUTES = { 'GET /api/usage/series': reply(503, { error: 'fixture: spend series unavailable' }) }

// --- Activity (GET /api/activity?by=summary, S-1011): the summary fixtures, for each period the
// tab asks (a rolling window: today 1, 7 and 30 days, all time a year).
export function activityRoutes(): Record<string, unknown> {
  return {
    ...Object.fromEntries([1, 7, 30, 365].map((d) => [`GET /api/activity?by=summary&days=${d}`, { ...SUMMARY, days: d }])),
    // The Agents control's presets (S-1444).
    'GET /api/activity?by=summary&days=7&agents=developer': SUMMARY_DEVELOPERS,
    'GET /api/activity?by=summary&days=7&agents=developer%2Cmanager': SUMMARY_DEV_MANAGER,
  }
}
export const ACTIVITY_EMPTY_ROUTES = { 'GET /api/activity': SUMMARY_EMPTY }

// --- One drilled scope (GET /api/usage/scope, src/usage-drill.ts, S-661)
const round2 = (x: number) => Math.round(x * 100) / 100
// Every row carries its cost in the page's display units (S-663), the way the daemon sends it: the
// API-equivalent dollars, its share of a subscription window, the subscription dollars, and paid spend.
const scopeModes = (api: number): Modes => ({ api, five_hour: null, seven_day: +(api / 20).toFixed(1), subscription: round2(api * 0.4), paid_usd: round2(api * 0.1) })
const scopeTot = (cost: number, tin: number, tout: number): Tot => ({ cost_usd: cost, tokens_in: tin, tokens_out: tout, tokens_cache_read: Math.round(tin * 6), tokens_cache_write: Math.round(tin * 0.4), modes: scopeModes(cost) })
const configOf = (a: ScopeAgent) => `${a.harness} · ${a.model}`
const add = (rows: ScopeAgent[], k: 'cost_usd' | 'tokens_in' | 'tokens_out') => rows.reduce((a, x) => a + x[k], 0)

// A scope's agents, ranked by cost: 24 of them, so the agents table has more rows than fit.
export const SCOPE_AGENTS: ScopeAgent[] = Array.from({ length: 24 }, (_, i) => {
  const m = MODELS[i % MODELS.length]
  const cost = +(9.7 - i * 0.34 + wob(i, 11)).toFixed(2)
  const tin = Math.round(cost * 90_000)
  return {
    id: `fx-sc-${i}`, name: `fixture-${AGENT_KINDS[i % AGENT_KINDS.length]}-${String(i + 1).padStart(2, '0')}`,
    role: ['manager', 'developer', 'reviewer', 'docs', 'ops'][i % 5], harness: m.harness, model: m.model,
    ...scopeTot(cost, tin, Math.round(tin / 10)),
  }
})
export const SCOPE_WINDOWS: ScopeWindow[] = [
  { account: 'fixture-claude-max', window: 'seven_day', percent: 41, worth_usd: 120 },
  { account: 'fixture-claude-max', window: 'five_hour', percent: 62, worth_usd: 34 },
]
// What closed issues of the scope's configuration cost, on average: the typical tile.
export const SCOPE_TYPICAL: Typical = { estimate: true, config: 'claude · claude-opus-5-5', n: 6, median_cost_usd: 9.4, median_weekly_percent: 3 }
export const SCOPE_CHILDREN: ScopeItsa[] = [
  { key: 'S-912', title: 'Tokenizer for mixed scripts', status: 'in_review', owner: 'fx-review', cost_usd: 4.8 },
  { key: 'S-917', title: 'Write the migration guide', status: 'done', owner: 'fx-dev', cost_usd: 1.2 },
  { key: 'S-916', title: 'Ranking experiments', status: 'backlog', owner: null, cost_usd: 0.4 },
]

export interface ScopeOptions {
  // How many of SCOPE_AGENTS are in the scope; the first eight of them also carry the chart's legend.
  agents?: number
  days?: number
  // The chart's buckets; the rows default to one per bucket.
  rows?: number
  bucket?: 'day' | 'hour'
  // An ITSA scope: the totals split into the ITSA's own spend and its children's, and its children listed.
  itsa?: boolean
  // A childless ITSA with no closed issue of its configuration: the two tiles that then read "—".
  childless?: boolean
  windows?: ScopeWindow[]
  empty?: boolean
}

export function scopeAnswer(scope: ScopeAnswer['scope'], o: ScopeOptions = {}): ScopeAnswer {
  const days = o.days ?? 6
  const bucket = o.bucket ?? 'day'
  const agents = o.empty ? [] : SCOPE_AGENTS.slice(0, o.agents ?? SCOPE_AGENTS.length)
  const rows: SeriesRow[] = o.empty ? [] : Array.from({ length: o.rows ?? days }, (_, i) => {
    const t = bucket === 'hour'
      ? new Date(new Date().setUTCHours(i, 0, 0, 0)).toISOString().slice(0, 13) + ':00:00.000Z'
      : dayKey((o.rows ?? days) - 1 - i)
    const groups: SeriesRow['groups'] = {}
    let total = 0
    for (const [j, a] of agents.slice(0, 8).entries()) {
      const v = +(wob(i + j, j) * 3 + 0.1).toFixed(2)
      groups[a.id] = { cost_usd: v }
      total += v
    }
    return { t, cost_usd: +total.toFixed(2), groups }
  })
  const total = scopeTot(round2(add(agents, 'cost_usd')), add(agents, 'tokens_in'), add(agents, 'tokens_out'))
  const own = scopeTot(round2(total.cost_usd * 0.4), Math.round(total.tokens_in * 0.4), Math.round(total.tokens_out * 0.4))
  const children = scopeTot(round2(total.cost_usd - own.cost_usd), total.tokens_in - own.tokens_in, total.tokens_out - own.tokens_out)
  const by_model: ScopeModel[] = [...new Set(agents.map(configOf))].map((k) => {
    const mine = agents.filter((a) => configOf(a) === k)
    const [harness, model] = k.split(' · ')
    return { harness: harness!, model: model!, ...scopeTot(round2(add(mine, 'cost_usd')), add(mine, 'tokens_in'), add(mine, 'tokens_out')) }
  })
  return {
    days, bucket, scope,
    totals: o.itsa ? { own, children, total } : total,
    windows: o.empty ? [] : (o.windows ?? SCOPE_WINDOWS),
    timeseries: { group: 'agent', groups: agents.slice(0, 8).map((a) => ({ id: a.id, name: a.name })), rows },
    by_agent: agents,
    by_model,
    itsas: o.itsa ? (o.childless ? [] : SCOPE_CHILDREN) : undefined,
    typical: o.itsa && !o.childless ? SCOPE_TYPICAL : null,
  }
}

// The stub key ScopedView asks for, built the way ./drill/useScope.ts builds it.
export function scopeRoute(kind: DrillKind, id: string, o: { days?: number; since?: string; bucket?: 'day' | 'hour' } = {}): string {
  const q = `days=${o.days ?? 6}&${kind}=${encodeURIComponent(id)}`
  return `GET /api/usage/scope?${q}${o.since ? `&since=${encodeURIComponent(o.since)}&bucket=${o.bucket ?? 'day'}` : ''}`
}

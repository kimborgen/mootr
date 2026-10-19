// An invented activity summary (S-1011) for the stories and tests: the shape of
// GET /api/activity?by=summary, with every clock group, eight categories (so "N more" shows), and ten
// bottlenecks (so "Show all" shows), one of them mostly a single long pause; finished-issue configs and
// ten trees (S-1012).
import type { ActConfig, ActModelCost, ActSummary, ActTypeCost, ActTree, ActTreeRow, Modes } from '../types'

const H = 3600
const modes = (api: number): Modes => ({ api, paid_usd: api * 0.1, five_hour: null, seven_day: api / 20, subscription: api * 0.4 })
const cat = (key: string, label: string, h: number, usd: number) => ({ key, label, seconds: h * H, cost_usd: usd, modes: modes(usd), estimated: true, leaves: {} })
const who = (n: number) => [
  { id: 'fx-dev', name: 'fixture-dev', seconds: n * 0.4 * H },
  { id: 'fx-review', name: 'fixture-review', seconds: n * 0.2 * H },
]

const sp = (median: number, p75: number, n = 10) => ({ n, median, p75 })
const cfg = (key: { model?: string; type?: string }, n: number, usd: [number, number], workMin: number, leadH: number, reviews: number): ActConfig => ({
  ...key, n,
  working_s: sp(workMin * 60, workMin * 90, n), waiting_s: sp(workMin * 120, workMin * 200, n), cost_usd: sp(usd[0], usd[1], n),
  cost_modes: { api: sp(usd[0], usd[1], n), seven_day: sp(usd[0] / 20, usd[1] / 20, n), real: sp(usd[0] * 0.4, usd[1] * 0.4, n), paid_usd: sp(0, 0, n), five_hour: sp(0, 0, 0), subscription: sp(usd[0] * 0.4, usd[1] * 0.4, n) },
  lead_s: sp(leadH * H, leadH * 1.5 * H, n), review_rounds: sp(reviews, reviews + 1, n),
})
// Closed work issues by model, by type, and by both: four configs, so the range marks compare.
export const CONFIGS: NonNullable<ActSummary['configs']> = {
  n: 124,
  by_model: [
    cfg({ model: 'claude · claude-opus-5-5' }, 62, [0.69, 1.4], 21, 3.4, 1),
    cfg({ model: 'claude · claude-haiku-5-5' }, 31, [0.7, 0.95], 16, 2.1, 1),
    cfg({ model: 'opencode · openrouter/deepseek/deepseek-v4.1-flash' }, 19, [1.36, 1.6], 4, 1.8, 1),
    cfg({ model: 'codex · gpt-6.1-sol' }, 12, [1.6, 2.4], 7, 60, 2),
  ],
  by_type: [
    cfg({ type: 'developer' }, 88, [0.8, 1.3], 18, 3, 1),
    cfg({ type: 'manager' }, 24, [2.2, 3.1], 40, 9, 2),
    cfg({ type: 'reviewer' }, 12, [0.3, 0.5], 6, 1, 0),
  ],
  by_model_type: [
    cfg({ model: 'claude · claude-opus-5-5', type: 'manager' }, 24, [2.2, 3.1], 40, 9, 2),
    cfg({ model: 'claude · claude-haiku-5-5', type: 'developer' }, 31, [0.7, 0.95], 16, 2.1, 1),
    cfg({ model: 'opencode · openrouter/deepseek/deepseek-v4.1-flash', type: 'developer' }, 19, [1.36, 1.6], 4, 1.8, 1),
  ],
}
const node = (id: string, type: string, harness: string, agents: number, usd: number, hrs: [number, number, number, number, number]): ActTreeRow => ({
  id, name: id, type, harness, model: harness === 'claude' ? 'claude-opus-5-5' : null, agents,
  working_s: hrs[0] * H, others_s: hrs[1] * H, you_s: hrs[2] * H, friction_s: hrs[3] * H, idle_s: hrs[4] * H, cost_usd: usd, modes: modes(usd),
})
// Ten roots (so "Show all" shows); cos has seven children (so its "N more" shows).
export const TREES: ActTree[] = [
  { ...node('cos', 'chief-of-staff', 'claude', 214, 1690, [141, 520, 40, 60, 30]), children: [
    node('gh-process', 'manager', 'claude', 18, 212, [11, 60, 8, 2, 1]),
    node('system-view', 'manager', 'claude', 22, 140, [9, 70, 1, 1, 3]),
    node('human-auth', 'manager', 'claude', 12, 98, [6, 30, 0, 20, 1]),
    node('dash-page', 'developer', 'opencode', 1, 40, [3, 2, 0, 6, 0]),
    node('steps', 'developer', 'claude', 1, 22, [2, 1, 0, 0, 1]),
    node('retro-steward', 'developer', 'claude', 1, 12, [1, 0, 0, 0, 13]),
    node('requirements', 'manager', 'codex', 3, 9, [1, 2, 0, 3, 0]),
  ] },
  { ...node('release', 'coordinator', 'claude', 1, 61, [27, 10, 0, 12, 0]), children: [] },
  { ...node('intake', 'intake', 'claude', 3, 12, [1, 0, 2, 0, 18]), children: [node('intake-helper', 'developer', 'opencode', 1, 2, [0.5, 0, 0, 0, 2])] },
  ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x, i) => ({ ...node(`fixture-${x}`, 'developer', 'opencode', 1, 8 - i, [1, 1, 0, 0.2 * i, 0]), children: [] })),
]

// Every type present in the window, before any filter, with its agent count (sums to the 214 agents).
export const TYPES = [
  { type: 'developer', count: 112 }, { type: 'manager', count: 41 }, { type: 'reviewer', count: 18 }, { type: 'untyped', count: 14 },
  { type: 'reviewer-opus', count: 9 }, { type: 'advisor', count: 6 }, { type: 'coordinator', count: 4 }, { type: 'reviewer-fallback', count: 3 },
  { type: 'retro-steward', count: 3 }, { type: 'assistant', count: 1 }, { type: 'chief-of-staff', count: 1 }, { type: 'intake', count: 1 },
  { type: 'ring', count: 1 },
]

// Cost and working hours by agent type (the cost sums to the $1,900 and the hours to the 196 h of SUMMARY).
const TYPE_COST: Record<string, [number, number]> = {
  developer: [790, 88], manager: [480, 41], reviewer: [140, 12], untyped: [110, 9], 'reviewer-opus': [70, 6], advisor: [50, 4], coordinator: [90, 14],
  'reviewer-fallback': [20, 2], 'retro-steward': [30, 3], assistant: [45, 5], 'chief-of-staff': [60, 8], intake: [8, 1], ring: [7, 3],
}
export const BY_TYPE: ActTypeCost[] = TYPES.map((t) => ({ type: t.type, count: t.count, working_s: TYPE_COST[t.type][1] * H, cost_usd: TYPE_COST[t.type][0], modes: modes(TYPE_COST[t.type][0]) }))
export const BY_MODEL: ActModelCost[] = [
  ['claude · claude-opus-5-5', 120, 120, 1300], ['claude · claude-haiku-5-5', 52, 40, 260], ['opencode · openrouter/deepseek/deepseek-v4.1-flash', 30, 20, 190], ['codex · gpt-6.1-sol', 12, 16, 150],
].map(([model, count, h, usd]) => ({ model: model as string, count: count as number, working_s: (h as number) * H, cost_usd: usd as number, modes: modes(usd as number) }))

export const SUMMARY: ActSummary = {
  days: 7,
  since: '2026-10-08T12:00:00.000Z',
  until: '2026-10-15T12:00:00.000Z',
  scope: { kind: 'all' },
  filter: { agents: 'all', types: TYPES },
  agents: 214,
  clock: {
    total_s: 1030 * H,
    groups: [
      { key: 'working', label: 'Working', seconds: 196 * H, leaves: {} },
      { key: 'friction', label: 'Friction', seconds: 110 * H, leaves: {} },
      { key: 'others', label: 'Other agents and jobs', seconds: 537 * H, leaves: {} },
      { key: 'you', label: 'Waiting on you', seconds: 79 * H, leaves: {} },
      { key: 'idle', label: 'Idle', seconds: 108 * H, leaves: {} },
    ],
  },
  tiles: {
    working_s: 196 * H,
    you: { seconds: 79 * H, reply_s: 36 * H, prompt_s: 43 * H, permission_s: 0 },
    friction: { seconds: 110 * H, parts: { 'throttle.cost': 52 * H, 'tool.sleep': 35 * H, 'throttle.scheduler': 15 * H, 'model.stall': 8 * H } },
    cost: { cost_usd: 1900, modes: modes(1900) },
    cost_per_working_hour: { cost_usd: 9.69, modes: modes(9.69) },
    working_by_day: [20, 24, 31, 26, 35, 30, 30].map((h, i) => ({ day: `2026-10-${String(9 + i).padStart(2, '0')}`, working_s: h * H })),
  },
  working_by_category: [
    cat('verify', 'Verifying', 45.5, 91), cat('communicate', 'Communicating', 32, 800), cat('integrate', 'Integrating', 21.6, 120),
    cat('understand', 'Understanding', 20.3, 410), cat('produce', 'Producing', 20.2, 117), cat('self', 'Self', 16.9, 152),
    cat('track', 'Tracking', 22, 160), cat('plan', 'Planning', 17.5, 50),
  ],
  bottlenecks: [
    ['idle.none', 'Idle', 'idle', 108, 116],
    ['throttle.cost', 'Cost pause or rate limit', 'friction', 52, 7],
    ['human.prompt', 'Waiting on a new prompt from the human', 'you', 43, 28],
    ['tool.test', 'Running tests', 'working', 42, 370],
    ['human.reply', "Waiting on the human's reply", 'you', 36, 20],
    ['tool.sleep', 'Sleeping or polling in a tool', 'friction', 35, 132],
    ['agent.release', 'Waiting on a merge, deploy or review', 'others', 24, 60],
    ['throttle.scheduler', 'Queued for capacity', 'friction', 15, 9],
    ['model.stall', 'Model API error or retry', 'friction', 8, 16],
    ['tool.build', 'Running a build', 'working', 3, 40],
  ].map(([key, label, group, h, agents]) => ({
    key: key as string, label: label as string, group: group as ActSummary['bottlenecks'][number]['group'], seconds: (h as number) * H, agents: agents as number, top: who(h as number),
    longest: key === 'throttle.cost' ? { seconds: 30 * H, agent: 'fx-ops', name: 'fixture-ops', start: '2026-10-10T08:00:00.000Z' } : { seconds: H, agent: 'fx-dev', name: 'fixture-dev', start: '2026-10-11T08:00:00.000Z' },
  })),
  configs: CONFIGS,
  trees: TREES,
  by_type: BY_TYPE,
  by_model: BY_MODEL,
}

// One agent's scope: a small window with no friction, no categories and one bottleneck.
export const SUMMARY_AGENT: ActSummary = {
  ...SUMMARY,
  scope: { kind: 'agent', id: 'fx-dev', name: 'fixture-dev' },
  agents: 1,
  clock: { total_s: 5 * H, groups: [{ key: 'working', label: 'Working', seconds: 3 * H, leaves: {} }, { key: 'you', label: 'Waiting on you', seconds: 2 * H, leaves: {} }] },
  tiles: { ...SUMMARY.tiles, working_s: 3 * H, you: { seconds: 2 * H, reply_s: 2 * H, prompt_s: 0, permission_s: 0 }, friction: { seconds: 0, parts: {} }, cost: { cost_usd: 6, modes: modes(6) }, cost_per_working_hour: { cost_usd: 2, modes: modes(2) } },
  working_by_category: [],
  configs: { n: 0, by_model: [], by_type: [], by_model_type: [] },
  trees: [{ ...node('fx-dev', 'developer', 'claude', 1, 6, [3, 0, 2, 0, 0]), children: [] }],
  by_type: [{ type: 'developer', count: 1, working_s: 3 * H, cost_usd: 6, modes: modes(6) }],
  by_model: [{ model: 'claude · claude-opus-5-5', count: 1, working_s: 3 * H, cost_usd: 6, modes: modes(6) }],
  bottlenecks: [{ key: 'human.reply', label: "Waiting on the human's reply", group: 'you', seconds: 2 * H, agents: 1, top: [{ id: 'fx-dev', name: 'fixture-dev', seconds: 2 * H }], longest: { seconds: 1.5 * H, agent: 'fx-dev', name: 'fixture-dev', start: '2026-10-14T08:00:00.000Z' } }],
}

export const SUMMARY_EMPTY: ActSummary = {
  ...SUMMARY,
  agents: 0,
  clock: { total_s: 0, groups: [] },
  tiles: { working_s: 0, you: { seconds: 0, reply_s: 0, prompt_s: 0, permission_s: 0 }, friction: { seconds: 0, parts: {} }, cost: { cost_usd: 0, modes: modes(0) }, cost_per_working_hour: null, working_by_day: [] },
  working_by_category: [],
  bottlenecks: [],
  configs: { n: 0, by_model: [], by_type: [], by_model_type: [] },
  trees: [],
  by_type: [],
  by_model: [],
}

// The same answer for an agent-type filter (S-1491): the daemon's `filter.agents` label, the agents counted, and
// every time and cost scaled to the types kept; the trees keep only the roots and children of those types. The
// type list stays the unfiltered one, so the control keeps its buttons.
const SCALED = /seconds|_s$|^s$|cost|usd|^api$|^real$|^week$|^five_hour$|^seven_day$|^subscription$|^paid_usd$/
const scaled = <T,>(v: T, f: number, key = ''): T => {
  if (Array.isArray(v)) return v.map((x) => scaled(x, f, key)) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scaled(x, f, k)])) as T
  return (typeof v === 'number' && SCALED.test(key) ? v * f : v) as T
}
const filtered = (types: string[], f: number): ActSummary => {
  const keep = (t: ActTreeRow) => types.includes(t.type ?? '')
  const s = scaled(SUMMARY, f)
  return {
    ...s, by_type: s.by_type?.filter((t) => types.includes(t.type)), agents: TYPES.filter((t) => types.includes(t.type)).reduce((n, t) => n + t.count, 0), filter: { agents: [...types].sort().join(','), types: TYPES },
    trees: (SUMMARY.trees ?? []).flatMap((t) => (keep(t) ? [{ ...scaled(t, f), children: t.children.filter(keep) }] : t.children.some(keep) ? t.children.filter(keep).map((c) => ({ ...scaled(c, f), children: [] })) : [])),
  }
}
export const SUMMARY_DEVELOPERS = filtered(['developer'], 0.45)
export const SUMMARY_DEV_MANAGER = filtered(['developer', 'manager'], 0.78)

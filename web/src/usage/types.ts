// The shapes the Usage page reads: GET /api/usage, /api/usage/issues and /api/activity.

// A row's cost in every display unit (src/cost-display.ts, S-316): API-equivalent dollars, its
// share of each subscription window in percent, the subscription dollars, and the real paid
// spend. A unit that can't be computed is null, so the page shows a dash.
export interface Modes { api: number; five_hour: number | null; seven_day: number | null; subscription: number | null; paid_usd: number }

export interface Window { used_percentage?: number; resets_at?: number }
export interface PaidPeriod { usd: number | null; source: 'exact' | 'estimate' | 'unknown' }
// A flat-rate forecast at the window's average rate over the last 7 days or 24 hours (S-1523);
// null on the projection when the readings cover too few hours.
export interface Pace {
  estimate: true
  percent_per_hour: number
  covered_hours: number
  at_reset: number | null
  reaches_100_at: string | null
}
export interface Projection {
  estimate: true
  used_percentage: number | null
  percent_per_hour: number | null
  reaches_100_at: string | null
  resets_at: string | null
  note?: string
  pace_7d?: Pace | null
  pace_24h?: Pace | null
}
export interface ShareItem { id: string; agent?: string; root?: string; percent: number }
export interface ModelShare { model: string | null; percent: number }
export interface DayShare { day: string; percent: number }
export interface Worth {
  estimate: true
  worth_usd: { low: number; mid: number; high: number } | null
  used_usd: number | null
  left_usd: number | null
  percent_used: number | null
  samples: number
}
export interface WindowShares {
  estimate: true
  since: string
  change: number
  other: number
  agents: ShareItem[]
  trees: ShareItem[]
  by_agent?: ShareItem[]
  by_tree?: ShareItem[]
  by_model?: ModelShare[]
  by_day?: DayShare[]
  worth?: Worth
  projection: Projection
}
export interface Reserve { reserve: number; remaining: number | null }
export interface Budget { usd: number; per: string; spent: number | null; remaining: number | null }
export interface Account {
  account: string
  match: { harness: string; model?: string }
  // The provider that bills it per token (S-2119): `openrouter`, a settings.providers id, or null.
  provider?: string | null
  windows: Record<string, Window>
  updated_at: string | null
  age_ms: number | null
  stale: boolean
  paid: { today: PaidPeriod; week: PaidPeriod; month: PaidPeriod }
  balance: number | null
  budget: Budget | null
  shares: Record<string, WindowShares> | null
}
export interface Blocker { kind: string; account: string; reason: string; since: string; clear: unknown }
export interface BlockedAgent { agent_id: string; agent: string; lifecycle: string; paused_by: string[]; blockers: Blocker[] }
// A tree allocation as src/allocations.ts views it: a percent of an account's window, or
// dollars per period, with its current use. Never enforced.
export interface Allocation {
  id: string
  root: string
  root_id: string
  account: string
  kind: 'window' | 'usd'
  window: string
  percent: number | null
  amount: number | null
  period: string
  used: number
  used_percent: number | null
}
// A tree (root agent) with its subtree cost and tokens and its share of each window.
export interface TreeNode {
  id: string
  name: string
  cost_usd: number
  tokens: number
  // The subtree's cost in every display unit, when the daemon sends it (S-663).
  modes?: Modes
  shares: Record<string, Record<string, { estimate: true; percent: number }>>
  children: TreeNode[]
}
export interface Usage {
  today: { cost_usd: number; tokens_in: number; tokens_out: number; tokens_cache_read?: number; tokens_cache_write?: number; modes?: Modes }
  subscriptions: { name: string; windows: Record<string, unknown> }[]
  // The OpenRouter system reserve and the credit left above it; remaining is null when stale (S-1203).
  openrouter_reserve?: Reserve | null
  accounts?: Account[]
  allocations?: Allocation[]
  trees?: TreeNode[]
  blocked?: BlockedAgent[]
  // The Settings default cost unit (cost.display.mode), the Measure control's default (S-663).
  display_mode?: string
  instructions?: string
  shares_note?: string
  by_day: { day: string; cost_usd: number; tokens_in: number; tokens_out?: number | null; modes?: Modes }[]
  by_model: ModelRow[]
  by_agent: AgentRow[]
  note: string
  // The agent types the daemon filtered by (S-1753), null when unfiltered; absent from a daemon that ignores `agents=`.
  filtered_agents?: string[] | null
  // Agents with spend in the period per type, whatever the filter, for the Agent types bar.
  agent_types?: { type: string; count: number }[]
}

// Token counters and cost for one row of a By agent or By model table. A counter its harness
// doesn't report, or nothing has reported yet, is null and reads as an em dash.
export interface Totals {
  cost_usd: number | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
  // The cost in every display unit, when the daemon sends it (src/cost-display.ts, S-663).
  modes?: Modes
  // API-equivalent cost per token kind and in total, on by-model rows (S-1440); null where the
  // model's price is null, absent from an older daemon.
  cost_in?: number | null
  cost_out?: number | null
  cost_cache_read?: number | null
  cost_cache_write?: number | null
  cost_api_total?: number | null
}
// One agent's row of the by-agent table (`summary().by_agent`, S-95).
export interface AgentRow {
  agent_id?: string
  agent: string
  // The agent type the Agents tab filters by (S-1491): the registry type, or chief-of-staff, assistant, intake, untyped.
  type?: string
  harness: string
  model: string | null
  cost_usd?: number | null
  tokens_in?: number | null
  tokens_out?: number | null
  tokens_cache_read?: number | null
  tokens_cache_write?: number | null
  // The row's period cost in every display unit (S-663).
  modes?: Modes
  today: Totals
  lifetime: Totals
}
// One harness and model's row of the by-model table (`summary().by_model`).
export interface ModelRow {
  harness: string
  model: string | null
  cost_usd: number
  // The period's token counters, as the API sums them over `days`; null where a harness reports none.
  tokens_in?: number | null
  tokens_out?: number | null
  tokens_cache_read?: number | null
  tokens_cache_write?: number | null
  // The row's period cost in every display unit (S-663).
  modes?: Modes
  // The period's API-equivalent cost per token kind and in total (S-1440).
  cost_in?: number | null
  cost_out?: number | null
  cost_cache_read?: number | null
  cost_cache_write?: number | null
  cost_api_total?: number | null
  today: Totals
  lifetime: Totals
}
// Spend per issue (GET /api/usage/issues, src/issue-costs.ts): each ITSA's own and total cost,
// and per configuration the stats over closed issues.
export interface IssueTokens { cost_usd: number; tokens_in: number; tokens_out: number; tokens_cache_read: number; tokens_cache_write: number }
export interface IssueRow {
  key: string
  title: string
  kind: string | null
  status: string
  closed_at: string | null
  own: IssueTokens & { manager_cost_usd: number }
  total: IssueTokens
  agents: number
  config: string | null
  weekly_percent: number | null
  // The issue's own and total cost in every display unit (S-663); absent from an older daemon.
  cost?: { mode: string; own: Modes; total: Modes }
}
// One cost measure's stats over a configuration's closed issues (S-663); a measure with no value
// on any issue is all null, never a $0.
export interface UnitStats { n: number; median: number | null; average: number | null; min: number | null; max: number | null }
export interface ConfigRow {
  config: string
  n: number
  median: number
  average: number
  min: number
  max: number
  median_weekly_percent: number | null
  // The same stats in every measure the page offers; absent from an older daemon.
  units?: Partial<Record<'api' | 'week' | 'real', UnitStats>>
}
export interface Issues { note: string; issues: IssueRow[]; by_config: ConfigRow[]; unattributed: IssueTokens }

// Activity (S-1009): GET /api/activity?by=summary, the Activity tab's one answer. Seconds are
// agent-hours of clock; costs carry every Measure mode (a mode that can't be computed is null).
export type ClockGroupKey = 'working' | 'friction' | 'others' | 'you' | 'idle'
export interface ActCost { cost_usd: number; modes?: Modes | null }
export interface ActSummary {
  days: number
  since: string
  until: string
  scope: { kind: 'all' | 'tree' | 'agent' | 'itsa'; id?: string; key?: string; name?: string }
  // The types counted, 'all' or a comma list, and every type present in the window before the filter, with its agent count (S-1491).
  filter?: { agents: string; types?: { type: string; count: number }[] }
  // The kept agents' cost (every Measure mode) and working time per agent type and per harness · model (S-1491).
  by_type?: ActTypeCost[]
  by_model?: ActModelCost[]
  agents: number
  // True while the daemon still builds its digests after a restart: the figures are partial (S-1206).
  warming?: boolean
  clock: { total_s: number; groups: { key: ClockGroupKey; label: string; seconds: number; leaves: Record<string, number> }[] }
  tiles: {
    working_s: number
    you: { seconds: number; reply_s: number; prompt_s: number; permission_s: number }
    friction: { seconds: number; parts: Record<string, number> }
    cost: ActCost
    cost_per_working_hour: ActCost | null
    working_by_day: { day: string; working_s: number }[]
  }
  working_by_category: (ActCost & { key: string; label: string; seconds: number; estimated?: boolean; leaves: Record<string, number> })[]
  bottlenecks: ActBottleneck[]
  labels?: Record<string, string>
  configs?: { n: number; by_model: ActConfig[]; by_type: ActConfig[]; by_model_type: ActConfig[] }
  trees?: ActTree[]
}
export interface ActTypeCost extends ActCost { type: string; count: number; working_s: number }
export interface ActModelCost extends ActCost { model: string; count: number; working_s: number }
// Median and p75 over the closed work issues of one group; null when there were none.
export interface ActSpread { n: number; median: number | null; p75: number | null }
// One group of closed work issues (S-1012): `model` is "harness · model id", `type` the agent type.
export interface ActConfig {
  model?: string
  type?: string
  n: number
  working_s: ActSpread
  waiting_s: ActSpread
  cost_usd: ActSpread
  cost_modes?: Partial<Record<keyof Modes | 'real', ActSpread>>
  lead_s: ActSpread
  review_rounds: ActSpread
}
// A root agent (or a root's direct child) with its subtree's clock groups and cost over the scope.
export interface ActTreeRow {
  id: string
  name: string
  type: string | null
  harness: string | null
  model: string | null
  agents: number
  working_s: number
  friction_s: number
  others_s: number
  you_s: number
  idle_s: number
  cost_usd: number
  modes?: Modes | null
}
export interface ActTree extends ActTreeRow { children: ActTreeRow[] }
export interface ActBottleneck {
  key: string
  label: string
  group: ClockGroupKey
  seconds: number
  agents: number
  top: { id: string; name: string; seconds: number }[]
  longest: { seconds: number; agent: string; name: string; start: string } | null
}

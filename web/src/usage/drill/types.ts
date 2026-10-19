// The shape of GET /api/usage/scope (src/usage-drill.ts): one drilled tree, ITSA, model, harness or agent.
import type { DrillKind, SeriesGroupInfo, SeriesRow } from '../charts/math'
import type { Modes } from '../types'

export interface Tot { cost_usd: number; tokens_in: number; tokens_out: number; tokens_cache_read: number; tokens_cache_write: number; modes?: Modes }
// An ITSA scope's totals split into its own spend, its descendants', and both.
export interface ItsaTotals { own: Tot; children: Tot; total: Tot }
export interface ScopeWindow { account: string; window: string; percent: number | null; worth_usd: number | null }
export interface ScopeAgent extends Tot { id: string; name: string; role: string | null; harness: string | null; model: string | null }
export interface ScopeModel extends Tot { harness: string; model: string }
export interface ScopeItsa { key: string; title: string; status: string; owner: string | null; cost_usd: number; modes?: Modes }
export interface Typical { estimate: true; config: string; n: number; median_cost_usd: number; median_weekly_percent: number | null }
export interface ScopeAnswer {
  days: number
  bucket: 'day' | 'hour'
  scope: { kind: DrillKind; id: string; name: string; key?: string; harness?: string }
  totals: Tot | ItsaTotals
  windows: ScopeWindow[]
  timeseries: { group: 'agent'; groups: SeriesGroupInfo[]; rows: SeriesRow[] }
  by_agent: ScopeAgent[]
  by_model: ScopeModel[]
  itsas?: ScopeItsa[]
  typical?: Typical | null
}

// The Usage page's view state: which tab, the period, the measure, and the drill scope. It lives
// here so the history place (nav-history.ts) can record it: back and forward then move between
// states, and a reload restores them. Later items call `setUsageState` to open a tab or drill in.
import { useSyncExternalStore } from 'react'
import { DEFAULT_FILTER, decodeFilter, filterParam, legacyTokens, type AgentFilter } from './agentFilter'

export const TABS = ['overview', 'activity', 'issues', 'models', 'trees', 'agents', 'days'] as const
export type UsageTab = (typeof TABS)[number]
// Days of history; 0 is all time.
export const PERIODS = [1, 7, 30, 0] as const
export type UsagePeriod = (typeof PERIODS)[number]
export const MEASURES = ['api', 'week', 'real'] as const
export type UsageMeasure = (typeof MEASURES)[number]
// What Activity counts in: agent-hours, or cost in the Measure (S-1491).
export const MODES = ['time', 'cost'] as const
export type UsageMode = (typeof MODES)[number]
export const SCOPE_KINDS = ['tree', 'itsa', 'model', 'harness', 'agent'] as const
export interface UsageScope { kind: (typeof SCOPE_KINDS)[number]; id: string }
export interface UsageState { tab: UsageTab; days: UsagePeriod; measure: UsageMeasure; scope: UsageScope | null
  // Activity's Time | Cost switch; the other tabs ignore it.
  mode: UsageMode
  // The agent types the tabs count, none for all (S-1491, S-1753); Issues ignores it.
  agents: AgentFilter }

// The days to ask the usage API for. The API's `days=N` covers N+1 calendar days (today and the N
// before), and a period of N days is N calendar days ending today, so it asks for N-1. Today asks
// for 1 (hourly buckets); all time asks for a year, the retention the page can draw.
export const apiDays = (p: UsagePeriod) => (p === 0 ? 365 : p <= 1 ? 1 : p - 1)

export const DEFAULT_STATE: UsageState = { tab: 'overview', days: 7, measure: 'api', scope: null, mode: 'time', agents: DEFAULT_FILTER }

let state: UsageState = DEFAULT_STATE
const listeners = new Set<() => void>()

// The Measure control defaults to the Settings cost unit, but only until a measure is chosen: the
// human's click, a copied link's hash, or a restored history entry all pin it (S-663).
let pinned = false
export const pinMeasure = () => { pinned = true }
export const measurePinned = () => pinned

export const getUsageState = () => state
export const onUsageChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

// Merges a change into the state. A new object is made only when something differs.
export function setUsageState(patch: Partial<UsageState>) {
  const next = { ...state, ...patch }
  if (next.tab === state.tab && next.days === state.days && next.measure === state.measure && next.mode === state.mode
    && next.scope?.kind === state.scope?.kind && next.scope?.id === state.scope?.id
    && next.agents.join() === state.agents.join()) return
  state = next
  listeners.forEach((f) => f())
}

export const useUsageState = () => useSyncExternalStore(onUsageChange, getUsageState)

// The state as a string for a history entry, and back. Anything unreadable falls to the default.
export const encodeUsage = (s: UsageState) => JSON.stringify(s)
export function decodeUsage(v: unknown): UsageState {
  try {
    const o = (typeof v === 'string' ? JSON.parse(v) : v) as Partial<UsageState> | null
    const scope = o?.scope && (SCOPE_KINDS as readonly string[]).includes(o.scope.kind) && typeof o.scope.id === 'string' ? o.scope : null
    // A history entry that carries a measure keeps it, and stops the Settings default applying.
    if ((MEASURES as readonly string[]).includes(o?.measure as string)) pinMeasure()
    return {
      tab: (TABS as readonly string[]).includes(o?.tab as string) ? o!.tab! : DEFAULT_STATE.tab,
      days: (PERIODS as readonly number[]).includes(o?.days as number) ? o!.days! : DEFAULT_STATE.days,
      measure: (MEASURES as readonly string[]).includes(o?.measure as string) ? o!.measure! : DEFAULT_STATE.measure,
      scope,
      mode: (MODES as readonly string[]).includes(o?.mode as string) ? o!.mode! : DEFAULT_STATE.mode,
      agents: decodeFilter(o?.agents),
    }
  } catch { return DEFAULT_STATE }
}
// The state in a deep link's hash, `view=usage&tab=models&period=7d&scope=tree:ID`, and back. A
// copied link opens the same view; only what differs from the default is written.
const PERIOD_TOKEN: Record<number, string> = { 1: 'today', 7: '7d', 30: '30d', 0: 'all' }
export function usageHash(s: UsageState): string {
  const h = new URLSearchParams({ view: 'usage', tab: s.tab, period: PERIOD_TOKEN[s.days] })
  if (s.measure !== DEFAULT_STATE.measure) h.set('measure', s.measure)
  if (s.mode !== DEFAULT_STATE.mode) h.set('mode', s.mode)
  if (s.scope) h.set('scope', `${s.scope.kind}:${s.scope.id}`)
  if (s.agents.length) h.set('types', filterParam(s.agents))
  return '#' + h.toString()
}
export function parseUsageHash(h: URLSearchParams): Partial<UsageState> {
  const out: Partial<UsageState> = {}
  const tab = h.get('tab')
  if ((TABS as readonly string[]).includes(tab as string)) out.tab = tab as UsageTab
  const period = Object.entries(PERIOD_TOKEN).find(([, t]) => t === h.get('period'))
  if (period) out.days = Number(period[0]) as UsagePeriod
  const measure = h.get('measure')
  if ((MEASURES as readonly string[]).includes(measure as string)) out.measure = measure as UsageMeasure
  // `types=a,b`; a link from before (S-1444) carried `agents=work` or `agents=custom&classes=a,b`: kept as tokens the daemon resolves.
  const types = h.get('types')
  if (types !== null) out.agents = decodeFilter(types.split(',').filter(Boolean))
  else if (legacyTokens(h.get('agents'), (h.get('classes') ?? '').split(',')).length) out.agents = legacyTokens(h.get('agents'), (h.get('classes') ?? '').split(','))
  const mode = h.get('mode')
  if ((MODES as readonly string[]).includes(mode as string)) out.mode = mode as UsageMode
  const scope = h.get('scope')
  const i = scope ? scope.indexOf(':') : -1
  if (scope && i > 0 && (SCOPE_KINDS as readonly string[]).includes(scope.slice(0, i))) out.scope = { kind: scope.slice(0, i) as UsageScope['kind'], id: scope.slice(i + 1) }
  return out
}

// Sets the state from a history entry without notifying nav-history's recorder twice: the
// recorder ignores changes while it applies.
export const restoreUsage = (v: unknown) => setUsageState(decodeUsage(v))

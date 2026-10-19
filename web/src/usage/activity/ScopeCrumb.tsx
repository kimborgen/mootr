// The scope crumb above the Activity tiles (S-1011): "All agents › whole system", or, once the page is
// drilled into a tree, an ITSA or an agent (S-661's scope in state.ts), "All agents › tree cos" with
// All agents clearing it. A model or harness scope isn't one the summary reads, so it says the whole
// system shows. A filtered set of agent types (S-1491) is named after the scope, so a filtered number is never
// read as the whole. Today is a rolling window here, not Overview's since midnight, so it says "last 24 h".
import { filterLabel, isFiltered, type AgentFilter } from '../agentFilter'
import { setUsageState, type UsagePeriod, type UsageScope } from '../state'
import type { ActSummary } from '../types'
import { SUMMARY_SCOPES } from './useSummary'

const KIND: Record<string, string> = { tree: 'tree', itsa: 'ITSA', agent: 'agent', model: 'model', harness: 'harness' }

export function ScopeCrumb({ scope, answer, days, filter }: { scope: UsageScope | null; answer?: ActSummary['scope'] | null; days?: UsagePeriod; filter?: AgentFilter }) {
  const read = scope && SUMMARY_SCOPES.has(scope.kind)
  // The server's name for the scope once it answers; the id until then.
  const name = answer && answer.kind !== 'all' ? (answer.kind === 'itsa' ? answer.key : answer.name) ?? answer.id : scope?.id
  return (
    <nav className="ax-scope" aria-label="Scope">
      {scope ? <button type="button" className="ax-crumb" onClick={() => setUsageState({ scope: null })}>All agents</button> : <span>All agents</span>}
      <span className="ax-sep" aria-hidden>›</span>
      {read ? <><span className="muted">{KIND[scope.kind]}</span><b>{name}</b></> : <b>whole system</b>}
      {scope && !read ? <span className="muted">· activity can't scope to a {KIND[scope.kind]}</span> : null}
      {filter && isFiltered(filter) ? <span className="ax-filter"><span className="muted">· types</span><b>{filterLabel(filter)}</b></span> : null}
      {days === 1 ? <span className="muted ax-window">· last 24 h</span> : null}
    </nav>
  )
}

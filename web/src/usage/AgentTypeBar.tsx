// The Agent types control of Usage › Activity and Agents (S-1491): one toggle per agent type present in the
// window, labelled with the type and its agent count, then All. Taking none counts every agent. The types
// come from the summary (Activity) or the by-agent rows (Agents); the choice is the page's `agents` state.
import { filterLabel, isFiltered, isLegacyToken, toggleType, type TypeCount } from './agentFilter'
import { setUsageState, useUsageState } from './state'
import type { Usage } from './types'

// The types of a list of rows, largest first, each with its count.
export function countTypes(rows: { type?: string }[]): TypeCount[] {
  const n = new Map<string, number>()
  for (const r of rows) if (r.type) n.set(r.type, (n.get(r.type) ?? 0) + 1)
  return [...n].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
}

// The Agent types bar of the usage tabs fed by /api/usage (Overview, Models, Trees, Agents, Days), with a note
// when a filter is active (S-1753). The note follows what the daemon says it applied, so an older daemon that
// ignores `agents=` is never read as filtered. Counts come from the unfiltered `agent_types`. `olderNote` words
// the older-daemon case for a tab that filters its rows in the page.
export function UsageFilter({ u, scopeNote, olderNote = 'This daemon does not filter usage by agent type: the numbers count every agent.' }: { u: Usage; scopeNote?: string; olderNote?: string }) {
  const { agents } = useUsageState()
  const applied = u.filtered_agents ?? []
  const note = !isFiltered(agents) ? null
    : u.filtered_agents === undefined ? olderNote
    : applied.length ? `Showing only ${filterLabel(applied)}.${scopeNote ? ' ' + scopeNote : ''}` : null
  return <><AgentTypeBar types={u.agent_types ?? countTypes(u.by_agent)} />{note ? <p className="muted usage-filter-note">{note}</p> : null}</>
}

// The caption of a panel that counts every agent while a type filter is set (S-1845), beside its title.
export function AllAgentsLabel() {
  return <span className="muted usage-all-label">All agents</span>
}

export function AgentTypeBar({ types }: { types: TypeCount[] }) {
  const { agents } = useUsageState()
  // A type kept in the selection stays a button even when the window has none of it, so it can be cleared.
  const shown = [...types, ...agents.filter((a) => !isLegacyToken(a) && !types.some((t) => t.type === a)).map((type) => ({ type, count: 0 }))]
  return (
    <div className="usage-filter">
      <span className="usage-filter-name" id="usage-types-label">Agent types</span>
      <div className="seg usage-types" role="group" aria-labelledby="usage-types-label">
        <button type="button" className={agents.length ? '' : 'on'} aria-pressed={!agents.length} onClick={() => setUsageState({ agents: [] })}>All</button>
        {shown.map((t) => {
          const on = agents.includes(t.type)
          return (
            <button key={t.type} type="button" className={on ? 'on' : ''} aria-pressed={on} onClick={() => setUsageState({ agents: toggleType(agents, t.type) })}>
              {t.type} <span className="n">{t.count}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Trees: each tree's total cost, a fold per node, indented one tree step a level like the agent tree.
// The cost follows the page's Measure control (S-663).
import { Icon } from '../Icon'
import { measureText, measureValue } from './measure'
import { useUsageState, type UsageMeasure } from './state'
import { UsageFilter } from './AgentTypeBar'
import type { TreeNode, Usage } from './types'
import { winLabel } from './shared'

// The per-tree total: a fold per node, indented one tree step a level, like the agent tree. The
// daemon dedupes a DAG's subtree totals; a node under several parents shows under each.
function CostTreeNode({ node, depth, measure }: { node: TreeNode; depth: number; measure: UsageMeasure }) {
  const indent = { paddingLeft: `calc(${depth} * var(--space-3))` }
  const shares = Object.entries(node.shares).flatMap(([acct, wins]) => Object.entries(wins).map(([w, v]) => `${acct} ${winLabel(w)} ${v.percent}%`))
  const cost = measure === 'api' ? measureText(node.cost_usd, measure) : measureText(measureValue(node.modes, measure), measure)
  const row = (
    <>
      <span className="tname">{node.name}{shares.length ? <span className="muted"> · {shares.join(' · ')}</span> : null}</span>
      <span className="tcost" title={`${node.name}: ${cost} over the period`}>{cost}</span>
    </>
  )
  if (!node.children.length) return <div className="tnode" style={indent}>{row}</div>
  return (
    <details className="tfold" open={depth === 0}>
      <summary className="tnode" style={indent}>
        <Icon name="chevron-right" size="xs" />
        {row}
      </summary>
      {node.children.map((c) => <CostTreeNode key={c.id} node={c} depth={depth + 1} measure={measure} />)}
    </details>
  )
}


// `u` is the usage answer, for the Agent types bar; the stories and tests pass the nodes alone.
export function TreesTab({ nodes, u }: { nodes: TreeNode[]; u?: Usage }) {
  const { measure } = useUsageState()
  const bar = u ? <UsageFilter u={u} scopeNote="Each total counts only those agents." /> : null
  if (!nodes.length) return <>{bar}<p className="muted">{u?.filtered_agents?.length ? 'No tree has spend by these types in this period' : 'No trees with spend yet'}</p></>
  return (
    <>
      {bar}
      <div className="tree-totals">
        {nodes.map((n) => <CostTreeNode key={n.id} node={n} depth={0} measure={measure} />)}
      </div>
    </>
  )
}

// The bulk bar under the Agents table (S-3117): "N selected" and the actions for the checked agents. Each button counts how
// many agents it applies to, and a button that applies to none is disabled. Archive and a mode change confirm first, and
// name the count; Pause and Resume run at once, as the agent menu's do. A confirm holds the ids and the names it shows,
// never the agents: bulkAction reads each agent again when the human confirms.
// On a phone (`compact`, S-3282) the bar is one row: each action is its icon over its name and count, a disabled one stays
// tappable and says why in the summary line, and Clear goes, since Done leaves the mode and the header says how many are selected.
import { bulkAction } from './actions'
import { applies, confirmNames, MODES, reasonOf, type BulkAct } from './agents-bulk'
import { live } from './format'
import { Icon } from './Icon'
import { hideMenu, showMenu, showPopover, toast } from './ui/menu'
import type { Agent } from './types'

export interface AgentsBulkProps {
  // The checked agents, read from the page's list at the time of the render.
  agents: Agent[]
  onClear: () => void
  // The phone's one-row form (S-3282).
  compact?: boolean
}

const plural = (n: number) => `${n} ${n === 1 ? 'agent' : 'agents'}`

// The confirm a bulk action asks first: its count, up to five names, and what the action does. The popover opens above
// the trigger, as the bar sits at the foot of the table.
function confirmBulk(at: DOMRect, act: BulkAct, ids: string[], names: string[], lead: string, note: string, go: string) {
  const shown = confirmNames(names)
  showPopover(at.left, at.top - 4, lead, <div className="agents-confirm" data-bulk-confirm>
    <p className="agents-confirm-lead">{lead}</p>
    <ul className="agents-confirm-names">
      {shown.names.map((n) => <li key={n}>{n}</li>)}
      {shown.more ? <li className="muted">and {shown.more} more</li> : null}
    </ul>
    <p className="muted">{note}</p>
    <div className="agents-confirm-actions">
      <button type="button" className="btn" onClick={() => hideMenu(true)}>Cancel</button>
      <button type="button" className="btn danger" onClick={() => { hideMenu(); bulkAction(ids, act) }}>{go}</button>
    </div>
  </div>, null, true)
}

export function AgentsBulk({ agents, onClear, compact = false }: AgentsBulkProps) {
  const count = (act: BulkAct) => agents.filter((a) => applies(a, act)).length
  const pause = count({ kind: 'pause' })
  const resume = count({ kind: 'resume' })
  const archive = count({ kind: 'archive' })
  const modeable = agents.some(live)
  const ids = agents.map((a) => a.id)
  // The agents an action applies to, as the confirm names them: their ids and names, read now.
  const pick = (act: BulkAct) => agents.filter((a) => applies(a, act))
  // The phone's button: its icon over its name, and the count once it applies to any. A disabled one takes a tap and
  // says why (reasonOf); the desk's is disabled, and its reason is its title.
  const named = (name: string, n: number) => (n ? `${name} ${n}` : name)
  const off = (act: BulkAct, n: number) => (compact ? { 'aria-disabled': n ? undefined : true } : { disabled: !n, title: n ? undefined : reasonOf(agents, act) })
  const run = (act: BulkAct, n: number, go: () => void) => { if (n || !compact) go(); else toast(reasonOf(agents, act)) }
  return <div className={'agents-bulk' + (compact ? ' compact' : '')} role="toolbar" aria-label="Selected agents" data-agents-bulk>
    {compact ? null : <span className="agents-bulk-count" data-bulk-count>{agents.length} selected</span>}
    <button type="button" className="btn" data-bulk="pause" data-count={pause} {...off({ kind: 'pause' }, pause)} aria-label={compact ? named('Pause', pause) : undefined}
      onClick={() => run({ kind: 'pause' }, pause, () => bulkAction(ids, { kind: 'pause' }))}>{compact ? <><Icon name="pause" size="xs" /><span className="agents-bulk-n">{named('Pause', pause)}</span></> : <>Pause {pause}</>}</button>
    <button type="button" className="btn" data-bulk="resume" data-count={resume} {...off({ kind: 'resume' }, resume)} aria-label={compact ? named('Resume', resume) : undefined}
      onClick={() => run({ kind: 'resume' }, resume, () => bulkAction(ids, { kind: 'resume' }))}>{compact ? <><Icon name="play" size="xs" /><span className="agents-bulk-n">{named('Resume', resume)}</span></> : <>Resume {resume}</>}</button>
    <button type="button" className="btn" data-bulk="archive" data-count={archive} {...off({ kind: 'archive' }, archive)} aria-label={compact ? named('Archive', archive) : undefined}
      onClick={(e) => {
        if (!archive && compact) return toast(reasonOf(agents, { kind: 'archive' }))
        const list = pick({ kind: 'archive' })
        confirmBulk(e.currentTarget.getBoundingClientRect(), { kind: 'archive' }, list.map((a) => a.id), list.map((a) => a.name), `Archive ${plural(list.length)}?`,
          'Each shuts down, and a worktree it owns is removed (its branch stays).', `Archive ${list.length}`)
      }}>{compact ? <><Icon name="archive" size="xs" /><span className="agents-bulk-n">{named('Archive', archive)}</span></> : <>Archive… {archive}</>}</button>
    <button type="button" className="btn" data-bulk="mode" {...off({ kind: 'mode', mode: 'auto' }, modeable ? 1 : 0)} aria-haspopup="menu" aria-label={compact ? 'Mode' : undefined}
      onClick={(e) => {
        if (!modeable && compact) return toast(reasonOf(agents, { kind: 'mode', mode: 'auto' }))
        const r = e.currentTarget.getBoundingClientRect()
        showMenu(r.left, r.top - 4, [{ section: 'Permission mode' }, ...MODES.map((m) => {
          const act: BulkAct = { kind: 'mode', mode: m.id }
          const list = pick(act)
          const shown = list.map((a) => [a.id, a.name] as const)
          return { label: `${m.label} ${list.length}`, disabled: !list.length, action: (at: DOMRect) => {
            confirmBulk(at, act, shown.map(([id]) => id), shown.map(([, name]) => name), `Switch ${plural(shown.length)} to ${m.label}?`, 'They restart after their current step.', `Switch ${shown.length}`)
          } }
        })], e.currentTarget)
      }}>{compact ? <><Icon name="sliders-horizontal" size="xs" /><span className="agents-bulk-n">Mode</span></> : <>Mode <Icon name="chevron-down" size="xs" /></>}</button>
    {compact ? null : <button type="button" className="btn text" data-bulk="clear" onClick={onClear}>Clear</button>}
  </div>
}

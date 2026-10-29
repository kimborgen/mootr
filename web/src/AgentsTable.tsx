// The Agents table, the desktop Agents page's body (S-1432): one row per agent at `--size-row-table`, under a
// sticky header that sorts by any column. Its lines come from buildLines (agents-table.ts), so the page and the
// sidebar share one rule for what shows and in what order. A row's parts are the sidebar's (Tree.tsx and waits.tsx).
// Columns drop by priority as the table narrows (container queries in style.css), and a long text truncates with
// its full value as the tooltip.
import { memo, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { selectAgent } from './actions'
import { ago, live, model, modelCode, stateOf } from './format'
import { Glyph } from './Glyph'
import { Icon } from './Icon'
import { CostCell, CtxBar } from './Tree'
import { StatusGlyph, statusLabel, toneVar, waitsOnHuman } from './itsa/itsa'
import { Stamp } from './sidebar-motion'
import { useUi, setUi, getUi } from './ui/state'
import { agentTooltip } from './views/registry'
import { WaitMark } from './waits'
import { OpenAskLink, openAskRow } from './mail/OpenAskLink'
import { useData } from './store'
import { COLUMNS, activityOf, whenOf, type ColumnId, type Facts, type Group, type Line, type Sort, type SortCol } from './agents-table'
import type { Agent, Ask, CostMode, Itsa } from './types'
import type { CSSProperties } from 'react'

export interface AgentsTableProps {
  lines: Line[]
  facts: Facts
  // How the lines are grouped: a tree folds its children, the other groupings don't.
  group: Group
  // A stopped or archived list: its columns drop in a different order (style.css), its age kept.
  gone?: boolean
  // The picked columns, in the order they show. The name column always shows.
  cols: ColumnId[]
  sort: Sort | null
  // The agent the keyboard or a click picked.
  cursor: string | null
  // The daemon's context limit before it compacts an agent.
  enforce: number
  onSort: (col: SortCol) => void
  onPick: (id: string) => void
  // The checked agents (S-3117), by id, and whether all, some or none of the rows in view are checked. A checkbox click
  // toggles its row; with Shift it checks the rows from the last one toggled. Neither changes the picked row.
  checked: ReadonlySet<string>
  checkAll: 'all' | 'some' | 'none'
  onCheck: (id: string, shift: boolean) => void
  onCheckAll: () => void
  // What the table shows when it has no rows.
  empty?: ReactNode
}

// Column headers: the label, and the sort the header shows.
const LABEL: Record<SortCol, string> = Object.fromEntries([['name', 'Agent'], ...COLUMNS.map((c) => [c.id, c.label])]) as Record<SortCol, string>
// The narrow columns show an icon in their header, the sidebar's way; the label stays as its aria-label and title.
const HEAD_ICON: Partial<Record<SortCol, string>> = { wait: 'alarm-clock', context: 'gauge', unread: 'mail' }

interface RowProps {
  a: Agent
  depth: number
  dup: boolean
  kids: number
  // Whether the agent has children in any scope, for its cost's tree figure.
  hasKids: boolean
  foldable: boolean
  open: boolean
  itsa: Itsa | undefined
  // The open ask the agent waits on, from the parent's store read (S-3977), so a row redraws when the ask lands.
  ask: Ask | undefined
  cols: ColumnId[]
  costMode: CostMode
  costMax: number
  enforce: number
  selected: boolean
  checked: boolean
}

// One agent's row. Memoised on its own inputs, so a poll that changes other agents doesn't redraw it.
const AgentRow = memo(function AgentRow({ a, depth, dup, kids, hasKids, foldable, open, itsa, ask, cols, costMode, costMax, enforce, selected, checked }: RowProps) {
  const m = model(a)
  const cell = (c: ColumnId) => {
    switch (c) {
      case 'role': return <td key={c} className="ac-role ellipsis" title={a.role ?? a.type ?? ''}>{a.role ?? a.type ?? '–'}</td>
      case 'model': return <td key={c} className="ac-model" title={m.label}><span className="chip mcode" style={{ '--mc': m.color } as CSSProperties}>{modelCode(a.model)}</span>{a.effort ? <span className="muted"> {a.effort}</span> : null}</td>
      case 'machine': return <td key={c} className="ac-machine ellipsis" title={`${a.machine}: ${a.cwd}`}>{a.machine}</td>
      case 'itsa': return <td key={c} className="ac-itsa">{itsa
        ? <Stamp value={itsa.status} className={`ichip${waitsOnHuman(itsa) ? ' waits' : ''}`} style={{ '--tc': toneVar(itsa.status) } as CSSProperties} title={`${itsa.key} ${itsa.title} · ${statusLabel(itsa.status)}`}>
          <StatusGlyph status={itsa.status} />{itsa.key}</Stamp>
        : '–'}</td>
      case 'activity': return <td key={c} className="ac-activity ellipsis" title={activityOf(a)}>{ask ? <OpenAskLink row={ask} /> : activityOf(a)}</td>
      case 'wait': return <td key={c} className="ac-wait">{live(a) ? <WaitMark a={a} /> : null}</td>
      case 'context': return <td key={c} className="ac-context">{live(a) ? <CtxBar a={a} enforce={enforce} /> : '–'}</td>
      case 'cost': return <td key={c} className="ac-cost">{a.cost ? <CostCell id={a.id} cost={a.cost} parent={hasKids} max={costMax} costMode={costMode} /> : '–'}</td>
      case 'unread': return <td key={c} className="ac-unread">{a.unread ? <span className="badge warn" title={`${a.unread} unread mail`}>{a.unread}</span> : null}</td>
      case 'age': return <td key={c} className="ac-age" title={whenOf(a)}>{ago(whenOf(a))}</td>
    }
  }
  return <tr className={`at-row${selected ? ' sel' : ''}${checked ? ' chk' : ''}${live(a) ? '' : ' off'}${dup ? ' dup' : ''}`} data-agent-row={a.id} data-dup={dup ? 1 : undefined} aria-selected={selected} title={agentTooltip(a)}>
    <td className="ac-check" data-check-cell><input type="checkbox" className="agents-check" checked={checked} readOnly tabIndex={-1} aria-label={`Select ${a.name}`} /></td>
    <td className="ac-name">
      <span className="at-name" style={{ paddingLeft: depth * 14 }}>
        <span className={`chev ${open ? 'open' : ''}`} data-chev={foldable && kids && !dup ? 1 : undefined}>{foldable && kids && !dup ? <Icon name="chevron-right" size="xs" /> : null}</span>
        <Stamp value={stateOf(a)} className="stamp"><Glyph agent={a} /></Stamp>
        <span className="name">{a.name}</span>
        {a.chief_of_staff ? <span className="muted" title="Chief of staff"><Icon name="crown" size="xs" /></span> : null}
        {a.kind === 'assistant' ? <span className="asst-tag" title="Your executive assistant"><Icon name="bot" size="xs" /></span> : null}
        {dup ? <span className="muted" title="Also a child of another parent"><Icon name="link" size="xs" /></span> : null}
      </span>
    </td>
    {cols.map(cell)}
  </tr>
}, (p, q) => p.a === q.a && p.depth === q.depth && p.dup === q.dup && p.kids === q.kids && p.hasKids === q.hasKids && p.foldable === q.foldable && p.open === q.open && p.itsa === q.itsa && p.ask === q.ask
  && p.cols === q.cols && p.costMode === q.costMode && p.costMax === q.costMax && p.enforce === q.enforce && p.selected === q.selected && p.checked === q.checked)

// The table: a header that sorts, then the lines. A click picks a row and a double click opens its agent (as the
// sidebar's row does); a chevron folds its children, the sidebar's folds. A checkbox checks its row, and Shift-click
// checks the rows from the last one toggled (S-3117); a click on either never changes the picked row.
export function AgentsTable({ lines, facts, group, gone, cols, sort, cursor, enforce, checked, checkAll, onSort, onPick, onCheck, onCheckAll, empty }: AgentsTableProps) {
  const ui = useUi()
  const { asks } = useData()
  const wrap = useRef<HTMLDivElement>(null)
  const tree = group === 'tree'
  const costMax = useMemo(() => lines.reduce((m, l) => (l.kind === 'agent' && l.agent.cost ? Math.max(m, l.agent.cost.own[facts.costMode] ?? 0) : m), 0), [lines, facts])
  // Keeps the picked row in view as the keyboard moves it.
  useEffect(() => { if (cursor) wrap.current?.querySelector<HTMLElement>(`[data-agent-row="${cursor}"]`)?.scrollIntoView?.({ block: 'nearest' }) }, [cursor])

  const head = (c: SortCol, cls: string) => {
    const on = sort?.col === c
    return <th key={c} className={cls} aria-sort={on ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="at-sort" aria-label={LABEL[c]} title={LABEL[c]} onClick={() => onSort(c)}>{HEAD_ICON[c] ? <Icon name={HEAD_ICON[c]!} size="xs" /> : LABEL[c]}{on ?<span className={`at-dir ${sort!.dir}`}><Icon name="chevron-down" size="xs" /></span> : null}</button>
    </th>
  }
  const pickOf = (e: { target: EventTarget }) => (e.target as HTMLElement).closest<HTMLElement>('tr[data-agent-row]')
  const onCheckCell = (e: { target: EventTarget }) => (e.target as HTMLElement).closest('[data-check-cell]')
  return <div className="agents-table-wrap" ref={wrap} tabIndex={0}>
    <table className={`data agents-table${gone ? ' agents-gone' : ''}`}>
      <thead><tr>
        <th className="ac-check"><input type="checkbox" className="agents-check" data-check-all aria-label="Select every agent in view" checked={checkAll === 'all'} readOnly
          ref={(el) => { if (el) el.indeterminate = checkAll === 'some' }} onMouseDown={(e) => e.preventDefault()} onClick={onCheckAll} /></th>
        {head('name', 'ac-name')}{cols.map((c) => head(c, 'ac-' + c))}
      </tr></thead>
      <tbody
        // A checkbox or a Shift-click keeps focus where it is, so Esc, x, j and k still reach the page's keys.
        onMouseDown={(e) => { if (onCheckCell(e) || (e.shiftKey && pickOf(e))) e.preventDefault() }}
        onClick={(e) => {
          const tr = pickOf(e)
          if (!tr) return
          if (onCheckCell(e)) return onCheck(tr.dataset.agentRow!, e.shiftKey)
          const chev = (e.target as HTMLElement).closest<HTMLElement>('[data-chev="1"]')
          if (chev) return setUi({ collapsed: { ...getUi().collapsed, [tr.dataset.agentRow!]: !getUi().collapsed[tr.dataset.agentRow!] } })
          if (e.shiftKey) return onCheck(tr.dataset.agentRow!, true)
          onPick(tr.dataset.agentRow!)
        }}
        onDoubleClick={(e) => { const tr = pickOf(e); if (tr && !onCheckCell(e)) selectAgent(tr.dataset.agentRow!) }}>
        {lines.map((l) => l.kind === 'group'
          ? <tr key={'g:' + l.key} className="at-group"><th colSpan={cols.length + 2} scope="colgroup">{l.label} <span className="count">{l.count}</span></th></tr>
          : <AgentRow key={l.agent.id + (l.dup ? ':dup' : '')} a={l.agent} depth={l.depth} dup={l.dup} kids={facts.kids.get(l.agent.id) ?? 0} hasKids={facts.hasKids.has(l.agent.id)} foldable={tree}
            open={!ui.collapsed[l.agent.id]} itsa={facts.owned.get(l.agent.id)} ask={openAskRow(l.agent.open_ask, asks)} cols={cols} costMode={facts.costMode} costMax={costMax} enforce={enforce} selected={l.agent.id === cursor} checked={checked.has(l.agent.id)} />)}
      </tbody>
    </table>
    {lines.length ? null : empty}
  </div>
}

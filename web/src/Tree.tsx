// The agent tree: the org tree of running agents (an agent with several parents also shows,
// linked, under each), then active rings, then stopped agents. Each row packs the harness
// mark in its state ring (the ? in the header explains the marks; legend.tsx), the model, a context bar, unread mail, a waiting approval, the top
// wait, bypass mode, chief of staff, and the machine when it isn't this one. A small envelope
// flies along the gutter between the rows a mail went between (sidebar-mail.tsx, S-699).
import { useRef, type CSSProperties } from 'react'
import { agentMenu, openInbox, selectAgent, selectThread } from './actions'
import { spawnMenu } from './spawn'
import { costCell, costTitle, k, live, model, modelCode, stateOf, treeAgents } from './format'
import { Glyph } from './Glyph'
import { RowFlip } from './sidebar-flip'
import { MailFlights } from './sidebar-mail'
import { SpendBar, Stamp, TreeRow } from './sidebar-motion'
import { Icon } from './Icon'
import { Loading } from './Loading'
import { showLegend } from './legend'
import { currentWorld, useShell } from './shell/layout'
import { permThread, useData } from './store'
import { useLongPress } from './ui/longpress'
import { showMenu, type MenuItem } from './ui/menu'
import { getUi, setUi, useUi } from './ui/state'
import { agentTooltip } from './views/registry'
import { RestBadge, WaitMark } from './waits'
import { isClosed, openItsa, StatusGlyph, statusLabel, toneVar, waitsOnHuman } from './itsa/itsa'
import { FieldValue } from './work/field-columns'
import { useWorkExtras } from './work/data'
import { liveCols, pickable, rowValues, setSidebarCols, toggleCol, useSidebarCols, MAX_SIDEBAR_COLS } from './sidebar-cols'
import type { Field } from './itsa/fields'
import type { Badge } from './system/model'
import type { Agent, AgentCost, CostMode } from './types'

// One picked column's value in a row, or a dash so the columns line up down the tree. A built-in
// column is a glyph (Tests, a failure count) and a field a few characters; the full value is the tooltip.
function ColCell({ b, label }: { b: Badge | null; label: string }) {
  if (!b) return <span className="wcol g empty" role="cell" title={`${label}: none`} aria-label={`${label}: none`}>–</span>
  if (b.kind === 'field') return <span className="wcol f" role="cell" title={`${label}: ${String(b.v)}`}><FieldValue f={b.f} v={b.v} /></span>
  const mark = b.tone === 'ok' ? (b.id === 'tests' ? 'check' : 'circle-check') : b.tone === 'err' ? 'circle-x' : b.id === 'health' ? 'triangle-alert' : 'circle-dot'
  const fails = b.id === 'tests' && b.tone === 'err' ? /^\d+/.exec(b.word)?.[0] : null
  return <span className="wcol g" role="cell" title={b.title} aria-label={b.title}><span className={('badge ' + b.tone).trim()}>{fails ?? <Icon name={mark} size="xs" />}</span></span>
}

// An agent's context bar: its tokens against the limit where the daemon compacts it. The sidebar's row and the Agents table share it.
export function CtxBar({ a, enforce }: { a: Agent; enforce: number }) {
  const pct = Math.min(100, ((a.context_tokens ?? 0) / enforce) * 100)
  return <span className={`ctxbar l${a.context_level ?? 0}`} title={`Context ${k(a.context_tokens)} of ${k(enforce)} before forced compaction`}><i style={{ width: pct + '%' }} /></span>
}

// An agent's cost: its own, and its tree's when it has children, with the spend hairline scaled to `max`.
// The sidebar's row and the Agents table share it.
export function CostCell({ id, cost, parent, max, costMode }: { id: string; cost: AgentCost; parent: boolean; max: number; costMode: CostMode }) {
  const text = costTitle(cost, parent)
  return <span className="cost" data-cost={id} title={text} aria-label={text}>
    <span className="cost-row"><span className="cost-own">{costCell(cost.own, cost.mode)}</span>{parent ? <span className="cost-tree">/{costCell(cost.tree, cost.mode)}</span> : null}</span>
    <SpendBar value={cost.own[costMode]} max={max} />
  </span>
}

// The columns menu of a row's Work columns, from the sidebar's header button and the Agents page's (S-1428).
function colsItems(fields: Field[], picked: string[]): MenuItem[] {
  return [{ section: 'Work columns on each row' }, ...pickable(fields).map((c) => {
    const at = picked.indexOf(c.id)
    return { label: c.label, checked: at >= 0, checkbox: true, glyph: <span className="colnum">{at >= 0 ? at + 1 : ''}</span>,
      disabled: at < 0 && picked.length >= MAX_SIDEBAR_COLS, action: () => setSidebarCols(toggleCol(picked, c.id)) }
  }), 'sep', { label: 'None: show the role', checked: picked.length === 0, action: () => setSidebarCols([]) }]
}

// The tree's two header buttons: the columns on each row, and what the marks mean. The sidebar's tree header and the
// Agents page's header both show them.
export function TreeTools() {
  const extras = useWorkExtras()
  const picked = liveCols(useSidebarCols(), extras.fields)
  const fields = extras.fields ?? []
  return <>
    <button className="icon-btn help" data-cols-open title="Work columns on each row" aria-label="Work columns on each row" aria-haspopup="menu"
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, colsItems(fields, picked), e.currentTarget) }}><Icon name="columns-2" size="xs" /></button>
    <button className="icon-btn" data-legend-open title="What the marks mean" aria-label="What the marks mean" aria-haspopup="dialog" onClick={(e) => showLegend(e.currentTarget)}><Icon name="circle-help" size="xs" /></button>
  </>
}

export function Tree({ page }: { page?: boolean }) {
  const d = useData()
  const ui = useUi()
  useShell()
  const el = useRef<HTMLDivElement>(null)
  const lp = useLongPress((at) => showMenu(at.x, at.y, agentMenu(byIdIn(at.el.dataset.id!))), '.node[data-id]')
  const { agents, machine, thresholds, rings } = d
  const extras = useWorkExtras()
  const picked = liveCols(useSidebarCols(), extras.fields)
  const fields = extras.fields ?? []
  const labelOf = (id: string) => pickable(fields).find((c) => c.id === id)?.label ?? id
  const q = ui.filter.toLowerCase()
  const match = (a: Agent) => !q || [a.name, a.role, a.model, a.harness, a.machine, a.cwd].some((x) => String(x ?? '').toLowerCase().includes(q))
  const running = agents.filter(live)
  const shown = treeAgents(agents)
  const ids = new Set(shown.map((a) => a.id))
  const kidsOf = (id: string) => shown.filter((a) => (a.parents ?? []).includes(id)).sort((x, y) => x.created_at.localeCompare(y.created_at))
  // Show an agent when it or a descendant matches the filter.
  const visible = (a: Agent, seen = new Set<string>()): boolean => { if (seen.has(a.id)) return false; seen.add(a.id); return match(a) || kidsOf(a.id).some((c) => visible(c, seen)) }
  const roots = shown.filter((a) => !(a.parents ?? []).some((p) => ids.has(p)))
    .sort((x, y) => (Number(y.kind === 'assistant') - Number(x.kind === 'assistant')) || (Number(y.chief_of_staff ?? 0) - Number(x.chief_of_staff ?? 0)) || x.created_at.localeCompare(y.created_at))
  const placed = new Set<string>()
  const cw = currentWorld()
  const stopped = agents.filter((a) => !ids.has(a.id) && match(a)).sort((x, y) => y.updated_at.localeCompare(x.updated_at))
  // The rows this render shows, for the spend hairline's scale (each row's own spend against the
  // biggest spender shown, sqrt). Walks the same tree the rows do.
  const shownIds = new Set<string>()
  const markShown = (a: Agent, dup: boolean) => {
    shownIds.add(a.id)
    if (dup || ui.collapsed[a.id]) return
    const kids = kidsOf(a.id)
    if (kids.length) for (const c of kids.filter((c) => visible(c))) markShown(c, false)
  }
  for (const a of roots) if (visible(a)) markShown(a, false)
  if (ui.stoppedOpen) for (const a of stopped.slice(0, 40)) shownIds.add(a.id)
  const costMode = shown.find((a) => a.cost)?.cost?.mode ?? 'api'
  const maxOwn = d.agents.reduce((m, a) => (shownIds.has(a.id) && a.cost ? Math.max(m, a.cost.own[costMode] ?? 0) : m), 0)
  const rows: React.ReactNode[] = []
  const row = (a: Agent, depth: number, dup: boolean, path = '') => {
    const kids = kidsOf(a.id)
    // The cost's words: the tooltip, and the name a screen reader reads (touch shows no tooltip).
    const costText = a.cost ? costTitle(a.cost, kids.length > 0) : ''
    const open = !ui.collapsed[a.id]
    const m = model(a)
    // The ITSAs this agent owns and hasn't closed: a chip with the key (a count when several),
    // in the colour of the one that needs attention most (waiting on you first).
    const owns = d.itsas.filter((x) => x.owner === a.id && !isClosed(x))
    const shown = owns.find(waitsOnHuman) ?? owns[0]
    // Every owned issue's status, for the row's one-off nudge when any of them changes; the nudge
    // is stronger while one of them waits on the human.
    const ownSig = owns.map((x) => `${x.id}:${x.status}`).sort().join(',')
    const fk = a.id + (dup ? ':dup' : '')
    rows.push(
      <TreeRow key={path + '/' + a.id} event={ownSig} waiting={owns.some(waitsOnHuman)}
        className={`node ${a.id === cw ? 'sel' : ''} ${live(a) ? '' : 'off'} ${dup ? 'dup' : ''} ${ui.treeFocus === fk ? 'focus' : ''}`} data-id={a.id} data-dup={dup ? 1 : ''} data-parent={path && path !== 'stopped' ? path.slice(path.lastIndexOf('/') + 1) : undefined} data-sec={path === 'stopped' ? 'stopped' : undefined}
        draggable style={{ paddingLeft: 8 + depth * 14 }} title={picked.length && costText ? agentTooltip(a) + '\n' + costText : agentTooltip(a)} role="treeitem" aria-expanded={kids.length ? open : undefined}>
        {Array.from({ length: depth }, (_, i) => <span key={i} className="guide" style={{ left: 20 + i * 14 }} />)}
        <span className={`chev ${open ? 'open' : ''}`} data-chev={kids.length && !dup ? 1 : ''}>{kids.length && !dup ? <Icon name="chevron-right" size="xs" /> : null}</span>
        <Stamp value={stateOf(a)} className="stamp"><Glyph agent={a} /></Stamp>
        <span className="name">{a.name}</span>
        {a.chief_of_staff ? <span className="muted" title="Chief of staff"><Icon name="crown" size="xs" /></span> : null}
        {a.kind === 'assistant' ? <span className="asst-tag" title="Your executive assistant (Alt+C)"><Icon name="bot" size="xs" /></span> : null}
        {dup ? <span className="muted" title="Also a child of another parent"><Icon name="link" size="xs" /></span> : null}
        {picked.length && !a.pending
          ? <span className="wcols" role="row">{rowValues(shown, picked, fields).map((b, i) => <ColCell key={picked[i]} b={b} label={labelOf(picked[i])} />)}</span>
          : <span className="role" data-pending={a.pending || undefined} aria-live={a.pending ? 'polite' : undefined}>{a.pending ? `${a.pending}…` : a.role}</span>}
        <span className="meta">
          {shown ? <Stamp value={shown.status} className={`ichip${waitsOnHuman(shown) ? ' waits' : ''}`} data-owns={a.id} style={{ '--tc': toneVar(shown.status) } as CSSProperties}
            title={owns.length === 1 ? `Owns ${shown.key} ${shown.title} · ${statusLabel(shown.status)}${waitsOnHuman(shown) ? ': waits on you' : ''}` : `Owns ${owns.length} ITSAs: ${owns.map((x) => x.key).join(', ')}${owns.some(waitsOnHuman) ? `; ${owns.filter(waitsOnHuman).length} wait on you` : ''}`}>
            <StatusGlyph status={shown.status} />{owns.length === 1 ? shown.key : owns.length}</Stamp> : null}
          {a.pending_requests ? <span className="badge warn" data-ask={a.id} title="Waiting for your approval: open the request"><Icon name="shield-alert" size="xs" /></span> : null}
          {a.resting ? <RestBadge a={a} mode="compact" /> : live(a) ? <WaitMark a={a} /> : null}
          {live(a) || a.unread ? <Stamp value={a.unread ?? 0} increaseOnly className={'badge' + (a.unread ? '' : ' empty')} data-inbox={a.id} title={`${a.unread ?? 0} unread mail for ${a.name}: open its inbox`}>{a.unread}</Stamp> : null}
          {a.permission_mode === 'bypass' ? <span style={{ color: 'var(--st-errored)' }} title="Bypass permissions"><Icon name="zap" size="xs" /></span> : null}
          {a.machine !== machine ? <span className="muted" title={`Runs on ${a.machine}`}><Icon name="server" size="xs" /></span> : null}
          {a.in_itsa === false ? <span className="muted" title="Not in any ITSA"><Icon name="list-checks" size="xs" /></span> : null}
          {live(a) ? <CtxBar a={a} enforce={thresholds.enforceTokens} /> : null}
          {a.cost ? <CostCell id={a.id} cost={a.cost} parent={kids.length > 0} max={maxOwn} costMode={costMode} /> : null}
          <span className="chip mcode" style={{ '--mc': m.color } as CSSProperties}>{modelCode(a.model)}</span>
        </span>
        <span className="hover-actions">
          {live(a) ? <button className="icon-btn" data-add={a.id} title="Add a child agent" aria-label="Add a child agent"><Icon name="plus" size="xs" /></button> : null}
          <button className="icon-btn" data-more={a.id} title="More" aria-label="More actions"><Icon name="ellipsis" size="xs" /></button>
        </span>
      </TreeRow>)
    if (kids.length && open && !dup) for (const c of kids.filter((c) => visible(c))) { const dd = placed.has(c.id); placed.add(c.id); row(c, depth + 1, dd, path + '/' + a.id) }
  }
  for (const a of roots) if (visible(a)) { placed.add(a.id); row(a, 0, false) }
  const runningRows = rows.splice(0)
  if (ui.stoppedOpen) for (const a of stopped.slice(0, 40)) row(a, 0, false, 'stopped')

  const nodes = () => [...el.current!.querySelectorAll<HTMLElement>('.node[data-id]')]
  const byIdIn = (id: string) => agents.find((a) => a.id === id)
  const click = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-section="stopped"]')) return setUi({ stoppedOpen: !getUi().stoppedOpen })
    const add = t.closest<HTMLElement>('[data-add]')
    if (add) { const r = add.getBoundingClientRect(); return spawnMenu(r.left, r.bottom + 4, { parent: add.dataset.add }, add) }
    const ask = t.closest<HTMLElement>('[data-ask]')
    if (ask) { const r = d.perms.find((x) => x.agent_id === ask.dataset.ask); const tid = r && permThread(r.id); if (tid) return selectThread(tid) }
    const owns = t.closest<HTMLElement>('[data-owns]')
    if (owns) {
      const mine = d.itsas.filter((x) => x.owner === owns.dataset.owns && !isClosed(x))
      if (mine.length === 1) return openItsa(mine[0].id)
      const r = owns.getBoundingClientRect()
      return showMenu(r.left, r.bottom + 4, [{ section: 'Owned ITSAs' }, ...mine.map((x) => ({ label: `${x.key} ${x.title}`, glyph: <StatusGlyph status={x.status} />, hint: waitsOnHuman(x) ? 'waits on you' : statusLabel(x.status), action: () => openItsa(x.id) }))], owns)
    }
    const inbox = t.closest<HTMLElement>('[data-inbox]')
    if (inbox) return openInbox(inbox.dataset.inbox!)
    const more = t.closest<HTMLElement>('[data-more]')
    if (more) { const r = more.getBoundingClientRect(); return showMenu(r.left, r.bottom + 4, agentMenu(byIdIn(more.dataset.more!)), more) }
    const node = t.closest<HTMLElement>('.node[data-id]')
    if (!node) return
    if (t.closest('[data-chev="1"]')) return setUi({ collapsed: { ...getUi().collapsed, [node.dataset.id!]: !getUi().collapsed[node.dataset.id!] } })
    setUi({ treeFocus: node.dataset.id! + (node.dataset.dup ? ':dup' : '') })
    selectAgent(node.dataset.id!)
  }
  // Keyboard: up and down move, right opens a parent, left closes it, Enter opens the agent.
  const key = (e: React.KeyboardEvent) => {
    const ns = nodes()
    const i = ns.findIndex((n) => n.classList.contains('focus'))
    const cur = ns[i]
    const go = (j: number) => { const n = ns[Math.max(0, Math.min(ns.length - 1, j))]; if (!n) return; setUi({ treeFocus: n.dataset.id! + (n.dataset.dup ? ':dup' : '') }); n.scrollIntoView({ block: 'nearest' }) }
    const fold = (id: string, on: boolean) => setUi({ collapsed: { ...getUi().collapsed, [id]: on } })
    if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i < 0 ? 0 : i - 1) }
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(ns.length - 1)
    else if (cur && e.key === 'Enter') selectAgent(cur.dataset.id!)
    else if (cur && e.key === 'ArrowRight' && ui.collapsed[cur.dataset.id!]) fold(cur.dataset.id!, false)
    else if (cur && e.key === 'ArrowLeft' && cur.querySelector('[data-chev="1"]') && !ui.collapsed[cur.dataset.id!]) fold(cur.dataset.id!, true)
  }
  return (
    <div className="tree" id={page ? undefined : 'tree'} data-cols={picked.length || undefined} ref={el} tabIndex={0} role="tree" onClick={click} {...lp} onKeyDown={(e) => { lp.onKeyDown(e); if (!e.defaultPrevented) key(e) }}
      onDragStart={(e) => { const node = (e.target as Element).closest<HTMLElement>('.node[data-id]'); if (!node) return; e.dataTransfer.setData('text/stam-agent', node.dataset.id!); e.dataTransfer.effectAllowed = 'copy' }}>
      {d.error && !agents.length ? <div className="pad muted">{d.error}{location.protocol === 'https:' ? '' : <>. Open the link that <code>stam web</code> prints.</>}</div> : <>
        {page ? null : <div className="section eyebrow" data-section="running">Agents <span className="count">{running.length}</span><TreeTools /></div>}
        {runningRows}
        {!running.length ? (d.loaded.agents ? <div className="pad muted">No agents running. Press <Icon name="plus" size="xs" /> to add one.</div> : <Loading />) : null}
        {rings.length ? <>
          <div className="section eyebrow">Rings <span className="count">{rings.length}</span></div>
          {rings.map((r) => <div key={r.id} className="node" style={{ paddingLeft: 30 }} title={`${r.format} ring, round ${r.round} of ${r.max_rounds}, ${r.status}`}>
            <span className="glyph" style={{ '--sc': `var(--st-${r.status === 'running' ? 'working' : 'blocked'})` } as CSSProperties}><Icon name="users" /><span className="ring" /></span>
            <span className="name">{r.name}</span><span className="role">{r.format} · round {r.round}/{r.max_rounds}</span></div>)}
        </> : null}
        {stopped.length ? <div className="section eyebrow" data-section="stopped"><span className={`chev ${ui.stoppedOpen ? 'open' : ''}`} style={{ width: 16, display: 'grid', placeItems: 'center' }}><Icon name="chevron-right" size="xs" /></span>Stopped <span className="count">{stopped.length}</span></div> : null}
        {rows}
      </>}
      <MailFlights tree={el} />
      <RowFlip />
    </div>
  )
}


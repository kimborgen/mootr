// The process view, `w:process` (S-873): a read-only drawing of a process from
// `GET /api/processes` (S-872, loaded from YAML by S-871). React Flow draws auto-laid-out nodes
// (Dagre, layout.ts) left-to-right on a wide pane and top-to-bottom under 600 px, with a lane band
// per lane. Each node carries a count badge (badge.ts); tapping one lists its ITSAs in a side sheet
// (a bottom sheet on a narrow pane) that opens the ITSA as the Work page does. Its counts refetch
// when the ITSA list changes, and at most every 15 s.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Handle, MarkerType, Position, ReactFlow, type Connection, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { selectIssue } from '../actions'
import { api } from '../api'
import { Icon } from '../Icon'
import { StatusGlyph } from '../itsa/itsa'
import { useData } from '../store'
import { badgeFor, type CountBadge } from './badge'
import { addEdge, addNode, changed, diffLines, draftFrom, mergeIntoSource, toYaml, validate, type Draft, type Issue } from './edit'
import { DRAG_KIND, EditBar, EditPanel, GLYPH, IssueList, type PanelMode, type SaveState } from './ProcessEditor'
import { layoutColumn, layoutProcess, laneLabel, routeEdges, type Direction, type Metrics, type Placed } from './layout'
import type { NodeKind, Process, ProcessNode, ProcessTrigger, ProcessesResponse } from './types'
import './process.css'
import { Loading } from '../Loading'

interface ProcData extends Record<string, unknown> {
  id: string
  node: ProcessNode
  badge: CountBadge | null
  dir: Direction
  // The phone column: a row card, the lane named on it, and handles for the side loops.
  row: boolean
  lane: string
  selected: boolean
  // Editing: the node is a connection target, and may carry a problem the validator found.
  editing: boolean
  bad: boolean
  onOpen: (id: string) => void
}
interface LaneData extends Record<string, unknown> { label: string }

function ProcNode({ data }: NodeProps) {
  const { id, node, badge, dir, row, lane, selected, editing, bad, onOpen } = data as unknown as ProcData
  const kind = node.kind
  const label = node.label ?? id
  // Drag-to-connect is for the wide drawing; the phone connects from the node's sheet.
  const connectable = editing && !row
  const circle = kind === 'start' || kind === 'end' || kind === 'wait'
  const diamond = kind === 'exclusive' || kind === 'parallel'
  const markers = node.boundary?.length
    ? <span className="proc-boundary" title={node.boundary.map((b) => (b.action ? `${b.on} → ${b.action}` : b.on)).join(', ')} />
    : null
  return (
    <div className={`proc-node k-${kind}` + (row ? ' row' : '') + (selected ? ' selected' : '') + (bad ? ' bad' : '')} data-node={id} data-kind={kind}>
      <button type="button" className="proc-hit" onClick={() => onOpen(id)} aria-label={`${label}, ${kind}`}>
        {diamond
          ? <span className="proc-diamond"><i><b>{kind === 'parallel' ? '+' : '×'}</b></i></span>
          : circle
            ? <span className="proc-circle"><Icon name={GLYPH[kind]} size="xs" /></span>
            : <span className="proc-glyph"><Icon name={GLYPH[kind]} size="xs" /></span>}
        <span className="proc-main">
          {row ? <span className="proc-lane-cap">{lane}</span> : null}
          <span className="proc-label">{label}</span>
          {kind === 'start' && node.triggers?.length
            ? <span className="proc-chips">{node.triggers.slice(0, 3).map((t, i) => <span key={i} className="proc-chip" title={t.label ?? t.source}>{t.source}{triggerDetail(t) ? ' · ' + triggerDetail(t) : ''}</span>)}{node.triggers.length > 3 ? <span className="proc-chip">+{node.triggers.length - 3}</span> : null}</span>
            : null}
          {kind === 'script' && node.run ? <span className="proc-sub">{node.run}</span> : null}
          {kind === 'wait' && node.event ? <span className="proc-sub">{node.event}</span> : null}
          {kind === 'human' && node.ask ? <span className="proc-sub">{node.ask}</span> : null}
          {kind === 'end' && node.status ? <span className="proc-sub">{node.status}</span> : null}
        </span>
        {badge ? <span className={`proc-badge${badge.muted ? ' zero' : ''}`} title={`${badge.text} ${badge.text === '1' ? 'ITSA' : 'ITSAs'}`}>{badge.text}</span> : null}
      </button>
      {node.call ? <span className="proc-call" title={`Sub-process: ${node.call}`}><Icon name="plus" size="xs" /></span> : null}
      {markers}
      <Handle id="t" type="target" position={dir === 'LR' ? Position.Left : Position.Top} className="proc-handle" isConnectable={connectable} />
      <Handle id="s" type="source" position={dir === 'LR' ? Position.Right : Position.Bottom} className="proc-handle" isConnectable={connectable} />
      {!row && dir === 'LR' ? <>
        <Handle id="bt" type="target" position={Position.Bottom} className="proc-handle" isConnectable={false} />
        <Handle id="bs" type="source" position={Position.Bottom} className="proc-handle" isConnectable={false} />
      </> : null}
      {row ? <>
        <Handle id="rt" type="target" position={Position.Right} className="proc-handle" isConnectable={false} />
        <Handle id="rs" type="source" position={Position.Right} className="proc-handle" isConnectable={false} />
      </> : null}
    </div>
  )
}

function LaneNode({ data }: NodeProps) {
  const { label } = data as unknown as LaneData
  return <div className="proc-lane"><span className="proc-lane-label">{label}</span></div>
}

const NODE_TYPES = { proc: ProcNode, lane: LaneNode }

// A trigger's chip detail: its type, its subject, its actor, or a timer's cron — whichever it has.
function triggerDetail(t: ProcessTrigger): string {
  return t.types?.[0] ?? t.subjects?.[0] ?? t.actors?.[0] ?? (t.source === 'timer' ? t.cron ?? '' : '')
}

// The geometry the layout needs, read from the token-derived CSS vars (process.css), as the
// system view reads its own.
function readMetrics(host: HTMLElement): Metrics {
  const probe = document.createElement('div')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  host.appendChild(probe)
  // A var that does not resolve (a test environment with no stylesheets) falls back to the value
  // it is built from, so the layout never sees a zero-size box.
  const val = (name: string, fallback: number, height = false) => {
    probe.style.width = ''
    probe.style.height = ''
    if (height) probe.style.height = `var(${name})`
    else probe.style.width = `var(${name})`
    const r = probe.getBoundingClientRect()
    const v = height ? r.height : r.width
    return v > 0 ? v : fallback
  }
  const metrics: Metrics = {
    boxes: {
      start: { w: val('--proc-w-start', 240), h: val('--proc-h-start', 120, true) },
      end: { w: val('--proc-w-end', 144), h: val('--proc-h-end', 80, true) },
      wait: { w: val('--proc-w-wait', 144), h: val('--proc-h-wait', 80, true) },
      agent: { w: val('--proc-w-task', 192), h: val('--proc-h-task', 64, true) },
      human: { w: val('--proc-w-task', 192), h: val('--proc-h-task', 64, true) },
      script: { w: val('--proc-w-task', 192), h: val('--proc-h-task', 64, true) },
      exclusive: { w: val('--proc-w-dia', 72), h: val('--proc-h-dia', 96, true) },
      parallel: { w: val('--proc-w-dia', 72), h: val('--proc-h-dia', 96, true) },
    },
    lanePad: val('--proc-lane-pad', 16),
    laneGap: val('--proc-lane-gap', 12),
    margin: val('--proc-margin', 24),
    nodesep: val('--proc-nodesep', 32),
    ranksep: val('--proc-ranksep', 48),
    rowH: val('--proc-h-row', 64, true),
    rowHStart: val('--proc-h-row-start', 96, true),
    rowGap: val('--proc-row-gap', 24),
    edgeStep: val('--proc-edge-step', 8),
  }
  probe.remove()
  return metrics
}

function useSize(el: { current: HTMLElement | null }) {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const e = el.current
    if (!e) return
    setSize({ w: e.clientWidth, h: e.clientHeight })
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setSize({ w: e.clientWidth, h: e.clientHeight }))
    ro.observe(e)
    return () => ro.disconnect()
  }, [el])
  return size
}

// Below this pane width the flow runs top to bottom, as the system view's tree becomes an outline.
export const WIDE_BELOW = 600
// A wide drawing opens no smaller than this, so its text stays readable; the user pans for the rest.
const MIN_START_ZOOM = 0.8

export function ProcessView({ viewKey }: { viewKey: string }) {
  const { itsas, itsaStatuses, agents } = useData()
  const root = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const size = useSize(body)
  const narrow = size.w > 0 && size.w < WIDE_BELOW
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [res, setRes] = useState<ProcessesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pid, setPid] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  // Editing (S-1083): a working copy of the process, what the file reads as before the edit, and the panel that edits it.
  const [draft, setDraft] = useState<Draft | null>(null)
  const [baseline, setBaseline] = useState('')
  const [saving, setSaving] = useState<{ busy: boolean; error: string | null; saved: SaveState['saved'] }>({ busy: false, error: null, saved: null })
  const [panel, setPanel] = useState<PanelMode | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const flow = useRef<ReactFlowInstance | null>(null)
  const editing = draft !== null

  useLayoutEffect(() => { if (root.current && !metrics) setMetrics(readMetrics(root.current)) }, [metrics])

  // The counts follow the ITSAs: refetch when the list changes (itsa.changed reaches the store),
  // and at most every 15 s as a fallback.
  const itsaSig = useMemo(() => itsas.map((x) => `${x.id}:${x.status}:${x.owner ?? ''}`).join('|'), [itsas])
  // An unchanged body keeps the old object, so a poll doesn't rebuild the nodes (React Flow hides a rebuilt node until it measures it again).
  const lastBody = useRef('')
  const refresh = useCallback(() => {
    api<ProcessesResponse>('GET', '/api/processes').then(
      (r) => {
        const text = JSON.stringify(r)
        if (text !== lastBody.current) { lastBody.current = text; setRes(r) }
        setError(null)
      },
      (e: Error) => setError(e.message || 'Could not load the processes'),
    )
  }, [])
  useEffect(() => { refresh() }, [refresh, itsaSig])
  // The poll runs only while the pane is on screen (a view not shown waits in a hidden store) and
  // the page is visible; it refetches at once when the pane comes back.
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const e = root.current
    if (!e || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => setShown(entries[entries.length - 1].isIntersecting))
    io.observe(e)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    if (!shown) return
    refresh()
    const t = setInterval(() => { if (!document.hidden) refresh() }, 15_000)
    return () => clearInterval(t)
  }, [refresh, shown])

  const processes = res?.processes ?? []
  const served = processes.find((p) => p.id === pid) ?? processes[0] ?? null
  const pidNow = served?.id ?? null
  useEffect(() => { if (pid !== pidNow) { setPid(pidNow); setSel(null) } }, [pid, pidNow])
  // The drawing is the draft while editing (the live counts stay the served ones), else the served process.
  const process = useMemo<Process | null>(() => (draft && served ? { ...draft, counts: served.counts } : served), [draft, served])
  const known = useMemo(() => [...new Set([...itsaStatuses.map((s) => s.name), ...Object.values(served?.nodes ?? {}).flatMap((n) => n.statuses ?? [])])], [itsaStatuses, served])
  // The registry's agent types (served with the processes) check a lane's `type` and `fallback` as the daemon does; an older daemon sends none, and the check is skipped.
  const registry = useMemo(() => (res?.types ? new Set(res.types) : undefined), [res?.types])
  const issues = useMemo<Issue[]>(() => (draft ? validate(draft, known, registry, processes.map((p) => p.id)) : []), [draft, known, registry, processes])
  // What the file would read as: the file's own text patched where the draft differs (comments kept), else the draft written out.
  const proposed = useMemo(() => (draft ? (served?.source ? mergeIntoSource(served.source, draft) : toYaml(draft)) : ''), [draft, served?.source])
  const diff = useMemo(() => (draft ? diffLines(baseline, proposed) : []), [draft, baseline, proposed])
  const changes = diff.reduce((n, l, i) => n + (l.kind !== 'same' && (i === 0 || diff[i - 1].kind === 'same') ? 1 : 0), 0)
  const types = useMemo(() => (res?.types ?? [...new Set(agents.map((a) => a.type).filter((t): t is string => Boolean(t)))]).slice().sort(), [res?.types, agents])
  const startEdit = () => { if (!served) return; const d = draftFrom(served); setBaseline(served.source ?? toYaml(d)); setSaving({ busy: false, error: null, saved: null }); setDraft(d); setPanel(null); setSel(null); setConfirmDiscard(false) }
  const save = (summary: string) => {
    if (!served || !draft) return
    setSaving({ busy: true, error: null, saved: null })
    api<NonNullable<SaveState['saved']> & { branch: string }>('POST', `/api/processes/${encodeURIComponent(served.id)}/proposal`, { yaml: proposed, summary, base: served.source }).then(
      (r) => setSaving({ busy: false, error: null, saved: { key: r.key, id: r.id, pr: r.pr } }),
      (e: Error) => setSaving({ busy: false, error: e.message || 'The proposal could not be saved', saved: null }),
    )
  }
  const blocked = issues.length ? `Fix the ${issues.length === 1 ? 'problem' : issues.length + ' problems'} first.` : !changed(diff) ? 'There is no change to save.' : null
  const stopEdit = () => { setDraft(null); setPanel(null); setConfirmDiscard(false) }
  useEffect(() => { stopEdit() }, [pidNow])
  const selId = editing ? (panel?.k === 'node' ? panel.id : null) : sel
  const openNode = (id: string) => { if (editing) setPanel({ k: 'node', id }); else setSel(id) }
  const addAt = (kind: NodeKind, lane: string, label: string) => {
    if (!draft) return
    const r = addNode(draft, kind, lane, label)
    setDraft(r.draft)
    setPanel({ k: 'node', id: r.id })
  }
  const pickIssue = (i: Issue) => {
    if (i.node && draft?.nodes[i.node]) setPanel({ k: 'node', id: i.node })
    else if (i.edge !== undefined && draft?.edges[i.edge] && draft.nodes[draft.edges[i.edge].from]) setPanel({ k: 'node', id: draft.edges[i.edge].from })
    else if (i.lane) setPanel({ k: 'lanes' })
    else setPanel({ k: 'review' })
  }
  const onDrop = (e: DragEvent) => {
    const kind = e.dataTransfer.getData(DRAG_KIND) as NodeKind
    if (!kind || !draft || !flow.current) return
    e.preventDefault()
    const at = flow.current.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const band = layout?.lanes.find((b) => at.y >= b.y && at.y <= b.y + b.h)
    addAt(kind, band?.id ?? Object.keys(draft.lanes)[0] ?? '', '')
  }

  const dir: Direction = narrow ? 'TB' : 'LR'
  const layout = useMemo(() => (process && metrics && size.w > 0 && !narrow ? layoutProcess(process, 'LR', metrics) : null), [process, metrics, narrow, size.w])
  const column = useMemo(() => (process && metrics && narrow ? layoutColumn(process, metrics, size.w) : null), [process, metrics, narrow, size.w])

  const rfNodes = useMemo<Node[]>(() => {
    if (!process) return []
    const nodeData = (n: Placed) => ({ id: n.id, node: process.nodes[n.id], badge: badgeFor(n.id, process.nodes[n.id], process.counts), dir, row: narrow, lane: laneLabel(process.nodes[n.id].lane, process), selected: n.id === selId, editing, bad: issues.some((i) => i.node === n.id), onOpen: openNode })
    if (column) {
      return column.nodes.map((n): Node => ({
        id: n.id, type: 'proc', position: { x: n.x, y: n.y }, data: nodeData(n),
        draggable: false, selectable: false, connectable: false, focusable: false,
        sourcePosition: Position.Bottom, targetPosition: Position.Top,
        width: n.w, height: n.h, zIndex: 1,
      }))
    }
    if (!layout) return []
    const lanes: Node[] = layout.lanes.map((b) => ({
      id: 'lane:' + b.id, type: 'lane', position: { x: b.x, y: b.y }, data: { label: b.label },
      draggable: false, selectable: false, connectable: false, focusable: false, width: b.w, height: b.h, zIndex: 0,
    }))
    const nodes: Node[] = layout.nodes.map((n: Placed): Node => {
      return {
        id: n.id, type: 'proc', position: { x: n.x, y: n.y },
        data: nodeData(n),
        draggable: false, selectable: false, connectable: false, focusable: false,
        sourcePosition: dir === 'LR' ? Position.Right : Position.Bottom,
        targetPosition: dir === 'LR' ? Position.Left : Position.Top,
        width: n.w, height: n.h, zIndex: 1,
      }
    })
    return [...lanes, ...nodes]
  }, [process, layout, column, dir, narrow, selId, editing, issues])

  const rfEdges = useMemo<Edge[]>(() => {
    if (!process) return []
    const at0 = process.edges.map((e, k) => ({ e, k })).filter((x) => process.nodes[x.e.from] && process.nodes[x.e.to])
    const valid = at0.map((x) => x.e)
    const bad = (i: number) => (issues.some((x) => x.edge === at0[i].k) ? 'bad' : undefined)
    const routes = column ? routeEdges(column.order, valid) : null
    const step = metrics?.edgeStep ?? 8
    // On the wide drawing a back edge (its target left of its source) leaves and enters by the
    // bottom and loops under the nodes, so it doesn't run through them or their labels; nested
    // loops get their own depth.
    const at = new Map((layout?.nodes ?? []).map((n) => [n.id, n]))
    const backs = valid.map((e, i) => (at.get(e.to) && at.get(e.from) && at.get(e.to)!.x < at.get(e.from)!.x ? i : -1)).filter((i) => i >= 0)
      .sort((a, b) => Math.abs(at.get(valid[a].to)!.x - at.get(valid[a].from)!.x) - Math.abs(at.get(valid[b].to)!.x - at.get(valid[b].from)!.x))
    return valid.map((e, i): Edge => {
      const r = routes?.[i]
      const back = backs.indexOf(i)
      if (!r && back >= 0) {
        return {
          id: `e${i}`, source: e.from, target: e.to, label: e.label ?? e.when, type: 'smoothstep',
          ...{ sourceHandle: 'bs', targetHandle: 'bt', pathOptions: { offset: step * (back + 2), borderRadius: step } },
          markerEnd: { type: MarkerType.ArrowClosed }, focusable: false, selectable: false, className: bad(i),
        }
      }
      return {
        id: `e${i}`, source: e.from, target: e.to, type: 'smoothstep',
        // A side loop's gutter is too narrow for its label, which would run off the pane over the loop; only the straight edges are labelled.
        ...(r?.side ? {} : { label: e.label ?? e.when }),
        // In the column a non-neighbour edge leaves and enters by the right side and loops through the gutter.
        ...(r?.side ? { sourceHandle: 'rs', targetHandle: 'rt', pathOptions: { offset: step * (r.k + 1), borderRadius: step } } : { sourceHandle: 's', targetHandle: 't' }),
        markerEnd: { type: MarkerType.ArrowClosed }, focusable: false, selectable: false, className: bad(i),
      }
    })
  }, [process, column, layout, metrics, issues])

  // The first view: a column fits the pane's width (zoom 1, pan down); a wide drawing starts at its
  // top left, as large as the pane fits but never under MIN_START_ZOOM, so its text stays legible.
  // Only the width decides: the lanes stack down the page, so a drawing that fits across at
  // MIN_START_ZOOM or more shows its whole width, and the pane scrolls it down.
  const startZoom = layout && size.w > 0
    ? Math.max(MIN_START_ZOOM, Math.min(1, size.w / layout.width))
    : 1

  const layoutReady = Boolean(layout || column)
  const inFlight = process?.counts ? Object.values(process.counts).reduce((n, c) => n + c.count, 0) : null
  const selNode = !editing && sel && process ? process.nodes[sel] : null

  return (
    <div className={'proc' + (narrow ? ' narrow' : '') + (editing ? ' editing' : '')} ref={root} data-view={viewKey} data-dir={dir}>
      <header className="proc-head">
        <h2>Process</h2>
        {processes.length > 1
          ? <select className="proc-pick" aria-label="Process" value={pidNow ?? ''} disabled={editing} onChange={(e) => setPid(e.target.value)}>
              {processes.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          : process ? <span className="proc-count">{process.title}</span> : null}
        {editing ? <span className="proc-mode">Editing</span> : null}
        <span className="spacer" />
        {inFlight !== null && !editing ? <span className="proc-count">{inFlight} {inFlight === 1 ? 'ITSA' : 'ITSAs'} in flight</span> : null}
        {editing ? (
          <>
            <button type="button" className={'btn' + (confirmDiscard ? ' danger' : '')} data-act="discard" onClick={() => { if (!changed(diff) || confirmDiscard) stopEdit(); else setConfirmDiscard(true) }} onBlur={() => setConfirmDiscard(false)}>
              {confirmDiscard ? 'Discard the changes?' : 'Discard'}
            </button>
            <button type="button" className="btn primary" disabled={Boolean(blocked) || Boolean(saving.saved)} title={blocked ?? 'Review the change and save it as a proposal'} data-act="save-proposal" onClick={() => setPanel({ k: 'review' })}>Save as proposal</button>
          </>
        ) : served && layoutReady ? <button type="button" className="btn" data-act="edit" onClick={startEdit}><Icon name="pencil" size="xs" />Edit</button> : null}
      </header>
      {editing ? <EditBar narrow={narrow} mode={panel} changes={changes} errors={issues.length} onMode={setPanel} /> : null}
      {editing && issues.length ? <IssueList issues={issues} onPick={pickIssue} /> : null}
      {res?.errors?.length
        ? <ul className="proc-errors">{res.errors.map((e) => <li key={e.file}><span className="file">{e.file}</span> — {e.message}</li>)}</ul>
        : null}
      <div className="proc-body" ref={body}>
        {error
          ? <div className="empty-pane"><h3>Couldn't load the processes</h3><p>{error}</p><button type="button" className="btn" onClick={refresh}>Retry</button></div>
          : !res ? <Loading className="empty-pane" size="lg" label="Loading the processes" />
            : !process ? <div className="empty-pane"><h3>No processes yet</h3><p>Processes come from the <code>processes/</code> files; an error above says why one didn't load.</p></div>
              : layout || column
                ? <>
                    <div className="proc-flow" onDragOver={(e) => { if (editing && e.dataTransfer.types.includes(DRAG_KIND)) e.preventDefault() }} onDrop={onDrop}>
                      <ReactFlow
                        key={process.id + ':' + dir}
                        nodes={rfNodes} edges={rfEdges} nodeTypes={NODE_TYPES}
                        nodesDraggable={false} nodesConnectable={editing && !narrow} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
                        defaultViewport={{ x: 0, y: 0, zoom: startZoom }}
                        translateExtent={column ? [[0, 0], [column.width, column.height]] : undefined}
                        minZoom={narrow ? 1 : 0.35} maxZoom={2}
                        onNodeClick={(_, n) => { if (process.nodes[n.id]) openNode(n.id) }}
                        onInit={(i) => { flow.current = i }}
                        onConnect={(c: Connection) => { if (draft && c.source && c.target) setDraft(addEdge(draft, c.source, c.target)) }}
                        proOptions={{ hideAttribution: true }}
                        aria-label={`${process.title} process`}
                      />
                    </div>
                    {editing && draft && panel ? (
                      <EditPanel mode={panel} draft={draft} issues={issues} narrow={narrow} statuses={known} types={types} processIds={processes.map((p) => p.id)} diff={diff}
                        onChange={setDraft} onMode={setPanel} onAdd={addAt}
                        save={{ blocked, busy: saving.busy, error: saving.error, saved: saving.saved, onSave: save, onOpen: (id) => { stopEdit(); selectIssue(id) }, onDone: stopEdit }} />
                    ) : null}
                    {selNode ? (
                      <Sheet nid={sel!} self={process} node={selNode} narrow={narrow} onClose={() => setSel(null)} />
                    ) : null}
                  </>
                : null}
      </div>
    </div>
  )
}

// The node's ITSAs: a side sheet on a desktop, a bottom sheet on a narrow pane. Each row opens the
// ITSA as the Work page does.
export function Sheet({ nid, self, node, narrow, onClose }: { nid: string; self: Process; node: ProcessNode; narrow: boolean; onClose: () => void }) {
  const itsas = self.counts?.[nid]?.itsas ?? []
  const rows: ReactNode = itsas.length
    ? <div className="proc-itsas">{itsas.map((it) => (
        <button key={it.id} type="button" className="proc-itsa" data-itsa={it.id} onClick={() => { onClose(); selectIssue(it.id) }} title={it.title}>
          <StatusGlyph status={it.status} />
          <span className="proc-key">{it.key}</span>
          <span className="proc-title">{it.title}</span>
          {it.owner ? <span className="proc-owner">{it.owner}</span> : null}
        </button>
      ))}</div>
    : <p className="proc-sub">{node.statuses?.length ? 'No ITSAs sit here right now.' : 'This node holds no ITSAs.'}</p>
  const label = node.label ?? nid
  return (
    <aside className={'proc-sheet' + (narrow ? ' narrow' : '')} aria-label={`${label} details`} onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose() } }}>
      {narrow ? <span className="proc-grip" aria-hidden="true" /> : null}
      <div className="proc-ph">
        <h3>{label}</h3>
        <button type="button" className="icon-btn proc-close" onClick={onClose} title="Close (Esc)" aria-label="Close"><Icon name="x" /></button>
      </div>
      <p className="proc-sub">{node.kind} · {laneLabel(node.lane, self)}{node.statuses?.length ? ' · ' + node.statuses.join(', ') : ''}{node.doneWhen ? ` · done when ${node.doneWhen}` : ''}</p>
      <div className="eyebrow">ITSAs{itsas.length ? ` · ${itsas.length}` : ''}</div>
      {rows}
    </aside>
  )
}

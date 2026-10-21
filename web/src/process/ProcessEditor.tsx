// The process editor's panels (S-1083, step 5a): the bar over the drawing, the node palette, the
// error list, and the side panel (a bottom sheet on a narrow pane) that edits a node and its edges,
// adds a node, edits the lanes, or shows the YAML diff. The model is edit.ts; the view that holds
// the draft is ProcessView.tsx. Nothing here saves: Save as proposal is 5b.
import { useState, type DragEvent, type ReactNode } from 'react'
import { Icon } from '../Icon'
import {
  addEdge, addLane, deleteEdge, deleteLane, deleteNode, hunks, renameNode, setKind, updateEdge, updateLane, updateNode,
  BUILTIN_LANE_TYPES, END_STATUSES, HUMAN_ASKS, KINDS, type Draft, type DiffLine, type Issue,
} from './edit'
import type { NodeKind, ProcessNode } from './types'

export const GLYPH: Record<NodeKind, string> = {
  start: 'play', end: 'check', wait: 'clock', agent: 'bot', human: 'user', script: 'braces',
  exclusive: 'circle-help', parallel: 'plus',
}
const KIND_HELP: Record<NodeKind, string> = {
  start: 'Where it begins', end: 'Where it finishes', agent: 'An agent works', human: 'Waits on a person',
  script: 'Runs a command', exclusive: 'Takes one path', parallel: 'Splits or joins', wait: 'Waits for an event',
}
const TRIGGER_SOURCES = ['mail', 'github', 'slack', 'feedback', 'retro', 'itsa', 'timer', 'manual']

// Saving the edit as a proposal (S-1084): what the Review panel needs to offer it, and what came of it.
export interface SaveState {
  // Why saving isn't offered right now (problems, no change), or null when it is.
  blocked: string | null
  busy: boolean
  error: string | null
  saved: { key: string; id: string; pr: { number: number; url: string } } | null
  onSave: (summary: string) => void
  onOpen: (id: string) => void
  onDone: () => void
}

export type PanelMode = { k: 'node'; id: string } | { k: 'add' } | { k: 'lanes' } | { k: 'review' }

export const DRAG_KIND = 'application/x-stam-process-kind'

// ---- The bar and the palette -----------------------------------------------------------------

export function EditBar({ narrow, mode, changes, errors, onMode }: {
  narrow: boolean; mode: PanelMode | null; changes: number; errors: number; onMode: (m: PanelMode | null) => void
}) {
  const btn = (m: PanelMode, icon: string, text: string, extra?: ReactNode) => (
    <button type="button" className={'btn' + (mode?.k === m.k ? ' active' : '')} data-edit={m.k} aria-pressed={mode?.k === m.k} onClick={() => onMode(mode?.k === m.k ? null : m)}>
      <Icon name={icon} size="xs" />{text}{extra}
    </button>
  )
  return (
    <div className="proc-bar" role="toolbar" aria-label="Edit the process">
      {btn({ k: 'add' }, 'plus', 'Add node')}
      {btn({ k: 'lanes' }, 'columns-2', 'Lanes')}
      {btn({ k: 'review' }, 'git-pull-request', 'Review', errors || changes ? <span className={'proc-pill' + (errors ? ' bad' : '')} title={errors ? `${errors} ${errors === 1 ? 'problem' : 'problems'}` : `${changes} ${changes === 1 ? 'change' : 'changes'}`}>{errors ? <><Icon name="circle-alert" size="xs" />{errors}</> : changes}</span> : null)}
      {!narrow ? <Palette /> : null}
    </div>
  )
}

// Desktop: the kinds to drag onto a lane of the drawing.
function Palette() {
  const start = (e: DragEvent, kind: NodeKind) => { e.dataTransfer.setData(DRAG_KIND, kind); e.dataTransfer.effectAllowed = 'copy' }
  return (
    <div className="proc-palette" aria-label="Drag a node onto a lane">
      <span className="proc-hint">Drag onto a lane</span>
      {KINDS.map((k) => (
        <span key={k} className="proc-kind" draggable data-palette={k} title={KIND_HELP[k]} onDragStart={(e) => start(e, k)}>
          <Icon name={GLYPH[k]} size="xs" />{k}
        </span>
      ))}
    </div>
  )
}

export function IssueList({ issues, onPick }: { issues: Issue[]; onPick: (i: Issue) => void }) {
  if (!issues.length) return null
  return (
    <ul className="proc-issues" aria-label="Problems">
      {issues.map((i, n) => (
        <li key={n}>
          <button type="button" className="proc-issue" onClick={() => onPick(i)}><Icon name="circle-alert" size="xs" /><span>{i.message}</span></button>
        </li>
      ))}
    </ul>
  )
}

// ---- The panel -------------------------------------------------------------------------------

export interface PanelProps {
  mode: PanelMode
  draft: Draft
  issues: Issue[]
  narrow: boolean
  statuses: string[]
  types: string[]
  processIds: string[]
  diff: DiffLine[]
  onChange: (d: Draft) => void
  onMode: (m: PanelMode | null) => void
  onAdd: (kind: NodeKind, lane: string, label: string) => void
  save: SaveState
}

export function EditPanel(p: PanelProps) {
  const { mode, narrow } = p
  const title = mode.k === 'node' ? (p.draft.nodes[mode.id]?.label || mode.id) : mode.k === 'add' ? 'Add a node' : mode.k === 'lanes' ? 'Lanes' : 'Review the change'
  return (
    <aside className={'proc-sheet proc-edit' + (narrow ? ' narrow' : '') + (mode.k === 'review' ? ' wide' : '')} aria-label={title} data-panel={mode.k}
      onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); p.onMode(null) } }}>
      {narrow ? <span className="proc-grip" aria-hidden="true" /> : null}
      <div className="proc-ph">
        <h3>{title}</h3>
        <button type="button" className="icon-btn proc-close" onClick={() => p.onMode(null)} title="Close (Esc)" aria-label="Close"><Icon name="x" /></button>
      </div>
      {mode.k === 'node' && p.draft.nodes[mode.id] ? <NodeForm key={mode.id} {...p} id={mode.id} /> : null}
      {mode.k === 'add' ? <AddForm {...p} /> : null}
      {mode.k === 'lanes' ? <LanesForm {...p} /> : null}
      {mode.k === 'review' ? <Review {...p} /> : null}
    </aside>
  )
}

const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="proc-field"><span className="eyebrow">{label}</span>{children}{hint ? <span className="proc-sub">{hint}</span> : null}</label>
)

function AddForm({ draft, onAdd }: PanelProps) {
  const lanes = Object.keys(draft.lanes)
  const [kind, setK] = useState<NodeKind>('agent')
  const [lane, setLane] = useState(lanes[0] ?? '')
  const [label, setLabel] = useState('')
  const add = () => { onAdd(kind, lane, label.trim()); setLabel('') }
  return (
    <>
      <div className="proc-kinds" role="radiogroup" aria-label="Kind">
        {KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={'proc-kindbtn' + (kind === k ? ' on' : '')} data-kind-pick={k} onClick={() => setK(k)}>
            <Icon name={GLYPH[k]} size="xs" /><span>{k}</span>
          </button>
        ))}
      </div>
      <p className="proc-sub">{KIND_HELP[kind]}</p>
      <Field label="Lane">
        <select value={lane} onChange={(e) => setLane(e.target.value)} aria-label="Lane">
          {lanes.map((l) => <option key={l} value={l}>{draft.lanes[l].label ?? draft.lanes[l].type} ({l})</option>)}
        </select>
      </Field>
      <Field label="Label"><input value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && lane) { e.preventDefault(); add() } }} enterKeyHint="done" placeholder="What happens here" aria-label="Label" /></Field>
      <button type="button" className="btn primary" disabled={!lane} data-act="add-node" onClick={add}>Add {kind} node</button>
    </>
  )
}

function NodeForm({ id, draft, issues, statuses, processIds, onChange, onMode }: PanelProps & { id: string }) {
  const n = draft.nodes[id]
  const [newId, setNewId] = useState(id)
  const [idBad, setIdBad] = useState(false)
  const set = (patch: Partial<ProcessNode>) => onChange(updateNode(draft, id, patch))
  const mine = issues.filter((i) => i.node === id)
  const taken = new Set(Object.values(draft.nodes).flatMap((x) => x.statuses ?? []))
  const free = statuses.filter((s) => !taken.has(s))
  const out = draft.edges.map((e, i) => ({ e, i })).filter((x) => x.e.from === id)
  const inn = draft.edges.map((e, i) => ({ e, i })).filter((x) => x.e.to === id)
  const reachable = Object.keys(draft.nodes).filter((k) => k !== id && !draft.edges.some((e) => e.from === id && e.to === k))
  const nameOf = (k: string) => draft.nodes[k]?.label || k
  const commitId = () => {
    if (newId === id) { setIdBad(false); return }
    const next = renameNode(draft, id, newId)
    if (next === draft) { setIdBad(true); return }
    setIdBad(false)
    onChange(next)
    onMode({ k: 'node', id: newId })
  }
  return (
    <>
      {mine.length ? <ul className="proc-field-errors">{mine.map((i, k) => <li key={k}>{i.message}</li>)}</ul> : null}
      <Field label="Label"><input value={n.label ?? ''} onChange={(e) => set({ label: e.target.value })} aria-label="Label" /></Field>
      <div className="proc-row2">
        <Field label="Kind">
          <select value={n.kind} onChange={(e) => onChange(setKind(draft, id, e.target.value as NodeKind))} aria-label="Kind">{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
        </Field>
        <Field label="Lane">
          <select value={n.lane} onChange={(e) => set({ lane: e.target.value })} aria-label="Lane">
            {!draft.lanes[n.lane] ? <option value={n.lane}>{n.lane} (missing)</option> : null}
            {Object.keys(draft.lanes).map((l) => <option key={l} value={l}>{draft.lanes[l].label ?? draft.lanes[l].type}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Id" hint={idBad ? 'A lowercase slug, not used by another node.' : undefined}>
        <input value={newId} className={idBad ? 'bad' : ''} onChange={(e) => setNewId(e.target.value)} onBlur={commitId} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitId() } }} aria-label="Id" />
      </Field>
      {n.kind === 'human' ? (
        <Field label="Ask"><select value={n.ask ?? ''} onChange={(e) => set({ ask: e.target.value })} aria-label="Ask">{HUMAN_ASKS.map((a) => <option key={a} value={a}>{a}</option>)}</select></Field>
      ) : null}
      {n.kind === 'end' ? (
        <Field label="Closes the ITSA as"><select value={n.status ?? ''} onChange={(e) => set({ status: e.target.value })} aria-label="Status">{END_STATUSES.map((a) => <option key={a} value={a}>{a}</option>)}</select></Field>
      ) : null}
      {n.kind === 'script' ? <Field label="Run"><input value={n.run ?? ''} onChange={(e) => set({ run: e.target.value })} placeholder="npm run build" aria-label="Run" /></Field> : null}
      {n.kind === 'wait' ? <Field label="Event"><input value={n.event ?? ''} onChange={(e) => set({ event: e.target.value })} placeholder="deploy" aria-label="Event" /></Field> : null}
      {n.kind === 'agent' ? (
        <Field label="Calls the process" hint="A sub-process, optional.">
          <select value={n.call ?? ''} onChange={(e) => set({ call: e.target.value })} aria-label="Calls">
            <option value="">none</option>{processIds.filter((x) => x !== draft.id).map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
      ) : null}
      {n.kind === 'start' ? <Triggers node={n} onSet={set} /> : null}
      <div className="proc-field">
        <span className="eyebrow">Statuses</span>
        <div className="proc-chiprow">
          {(n.statuses ?? []).map((s) => (
            <span key={s} className="proc-chip">{s}<button type="button" className="proc-chipx" aria-label={`Remove ${s}`} onClick={() => set({ statuses: (n.statuses ?? []).filter((x) => x !== s) })}><Icon name="x" size="xs" /></button></span>
          ))}
          {!(n.statuses ?? []).length ? <span className="proc-sub">No ITSAs are counted here.</span> : null}
        </div>
        <select value="" onChange={(e) => { if (e.target.value) set({ statuses: [...(n.statuses ?? []), e.target.value] }) }} aria-label="Add a status">
          <option value="">Add a status…</option>{free.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <Field label="Done when"><input value={n.doneWhen ?? ''} onChange={(e) => set({ doneWhen: e.target.value })} aria-label="Done when" /></Field>
      <Field label="Brief" hint="Text this step adds to its lane's brief.">
        <textarea rows={3} value={n.brief ?? ''} onChange={(e) => set({ brief: e.target.value })} aria-label="Brief" />
      </Field>

      <div className="eyebrow">Leads to</div>
      {out.length ? out.map(({ e, i }) => (
        <div key={i} className="proc-edge" data-edge={i}>
          <div className="proc-edge-head"><Icon name="corner-down-left" size="xs" /><span className="proc-edge-to">{nameOf(e.to)}</span>
            <button type="button" className="icon-btn" onClick={() => onChange(deleteEdge(draft, i))} title="Delete the edge" aria-label={`Delete the edge to ${nameOf(e.to)}`}><Icon name="trash-2" size="xs" /></button></div>
          <div className="proc-row2">
            <input value={e.when ?? ''} onChange={(ev) => onChange(updateEdge(draft, i, { when: ev.target.value }))} placeholder="when" aria-label={`When, edge to ${nameOf(e.to)}`} />
            <input value={e.label ?? ''} onChange={(ev) => onChange(updateEdge(draft, i, { label: ev.target.value }))} placeholder="label" aria-label={`Label, edge to ${nameOf(e.to)}`} />
          </div>
        </div>
      )) : <p className="proc-sub">Nothing follows this node.</p>}
      <select value="" onChange={(e) => { if (e.target.value) onChange(addEdge(draft, id, e.target.value)) }} aria-label="Connect to" data-act="connect">
        <option value="">Connect to…</option>{reachable.map((k) => <option key={k} value={k}>{nameOf(k)} ({draft.nodes[k].kind})</option>)}
      </select>
      {inn.length ? <>
        <div className="eyebrow">Comes from</div>
        {inn.map(({ e, i }) => (
          <div key={i} className="proc-edge-head"><Icon name="corner-left-up" size="xs" /><span className="proc-edge-to">{nameOf(e.from)}{e.label || e.when ? ` · ${e.label ?? e.when}` : ''}</span>
            <button type="button" className="icon-btn" onClick={() => onChange(deleteEdge(draft, i))} title="Delete the edge" aria-label={`Delete the edge from ${nameOf(e.from)}`}><Icon name="trash-2" size="xs" /></button></div>
        ))}
      </> : null}
      <button type="button" className="btn danger" data-act="delete-node" onClick={() => { onChange(deleteNode(draft, id)); onMode(null) }}><Icon name="trash-2" size="xs" />Delete node</button>
    </>
  )
}

function Triggers({ node, onSet }: { node: ProcessNode; onSet: (p: Partial<ProcessNode>) => void }) {
  const list = node.triggers ?? []
  const put = (i: number, patch: Record<string, unknown>) => onSet({ triggers: list.map((t, k) => (k === i ? { ...t, ...patch } : t)) })
  return (
    <div className="proc-field">
      <span className="eyebrow">Triggers</span>
      {list.map((t, i) => (
        <div key={i} className="proc-row2">
          <select value={t.source} onChange={(e) => put(i, { source: e.target.value })} aria-label={`Trigger ${i + 1} source`}>
            {[...new Set([...TRIGGER_SOURCES, t.source])].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {t.source === 'timer'
            ? <input value={t.cron ?? ''} onChange={(e) => put(i, { cron: e.target.value })} placeholder="cron" aria-label={`Trigger ${i + 1} cron`} />
            : <input value={t.label ?? ''} onChange={(e) => put(i, { label: e.target.value })} placeholder="label" aria-label={`Trigger ${i + 1} label`} />}
          <button type="button" className="icon-btn" onClick={() => onSet({ triggers: list.filter((_, k) => k !== i) })} aria-label={`Remove trigger ${i + 1}`}><Icon name="trash-2" size="xs" /></button>
        </div>
      ))}
      <button type="button" className="btn" onClick={() => onSet({ triggers: [...list, { source: 'manual' }] })}><Icon name="plus" size="xs" />Add a trigger</button>
    </div>
  )
}

function LanesForm({ draft, types, onChange }: PanelProps) {
  const [type, setType] = useState('')
  const used = (k: string) => Object.values(draft.nodes).filter((n) => n.lane === k).length
  const options = [...new Set([...BUILTIN_LANE_TYPES, ...types, ...Object.values(draft.lanes).map((l) => l.type)])].sort()
  return (
    <>
      <datalist id="proc-lane-types">{options.map((t) => <option key={t} value={t} />)}</datalist>
      {Object.entries(draft.lanes).map(([k, l]) => (
        <div key={k} className="proc-lane-form" data-lane={k}>
          <div className="proc-edge-head"><span className="proc-edge-to">{l.label ?? l.type}</span><span className="proc-sub">{k} · {used(k)} {used(k) === 1 ? 'node' : 'nodes'}</span>
            <button type="button" className="icon-btn" onClick={() => onChange(deleteLane(draft, k))} title="Delete the lane" aria-label={`Delete the ${k} lane`}><Icon name="trash-2" size="xs" /></button></div>
          <div className="proc-row2">
            <Field label="Type"><input list="proc-lane-types" value={l.type} onChange={(e) => onChange(updateLane(draft, k, { type: e.target.value }))} aria-label={`${k} type`} /></Field>
            <Field label="Label"><input value={l.label ?? ''} onChange={(e) => onChange(updateLane(draft, k, { label: e.target.value }))} aria-label={`${k} label`} /></Field>
          </div>
          <div className="proc-row2">
            <Field label="Fallback"><input list="proc-lane-types" value={l.fallback ?? ''} onChange={(e) => onChange(updateLane(draft, k, { fallback: e.target.value }))} aria-label={`${k} fallback`} /></Field>
            <Field label="Machine"><input value={l.machine ?? ''} onChange={(e) => onChange(updateLane(draft, k, { machine: e.target.value }))} aria-label={`${k} machine`} /></Field>
          </div>
        </div>
      ))}
      <div className="eyebrow">New lane</div>
      <div className="proc-row2">
        <input list="proc-lane-types" value={type} onChange={(e) => setType(e.target.value)} placeholder="Type, such as reviewer" aria-label="New lane type" />
        <button type="button" className="btn primary" disabled={!type.trim()} data-act="add-lane" onClick={() => { onChange(addLane(draft, type.trim()).draft); setType('') }}>Add lane</button>
      </div>
    </>
  )
}

function Review({ diff, issues, save }: PanelProps) {
  const cut = hunks(diff, 2)
  const same = !diff.some((l) => l.kind !== 'same')
  const [summary, setSummary] = useState('')
  if (save.saved) {
    const { key, id, pr } = save.saved
    return (
      <div className="proc-saved" data-saved={key}>
        <p><Icon name="check" size="xs" /><span>Proposed as <strong>{key}</strong>. It waits for your approval; nothing changes until you approve it and the pull request merges.</span></p>
        <div className="proc-foot">
          <button type="button" className="btn primary" data-act="open-proposal" onClick={() => save.onOpen(id)}>Open {key}</button>
          <a className="btn" href={pr.url} target="_blank" rel="noreferrer">PR #{pr.number}</a>
          <button type="button" className="btn" data-act="done" onClick={save.onDone}>Done</button>
        </div>
      </div>
    )
  }
  return (
    <>
      {issues.length ? <ul className="proc-field-errors">{issues.map((i, k) => <li key={k}>{i.message}</li>)}</ul> : null}
      <p className="proc-sub">{same ? 'No change from the file.' : 'What the file would become, against the file as the daemon loaded it.'}</p>
      {!same ? (
        <pre className="proc-diff" aria-label="YAML diff">
          {cut.map((l, i) => <div key={i} className={'d-' + l.kind}><span className="d-mark">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>{l.text}</div>)}
        </pre>
      ) : null}
      <Field label="Summary" hint="What the change does and why. It is the proposal's text and the pull request's.">
        <textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="Summary" disabled={save.busy} />
      </Field>
      {save.error ? <ul className="proc-field-errors" role="alert"><li>{save.error}</li></ul> : null}
      <div className="proc-foot">
        <button type="button" className="btn primary" disabled={Boolean(save.blocked) || !summary.trim() || save.busy} data-act="save-proposal" onClick={() => save.onSave(summary.trim())}>
          {save.busy ? 'Saving…' : 'Save as proposal'}
        </button>
        <span className="proc-sub">{save.blocked ?? (!summary.trim() ? 'Add a summary.' : 'Opens a pull request and asks you to approve it.')}</span>
      </div>
    </>
  )
}

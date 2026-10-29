// Settings › Fields and cards (S-364, S-1438 PRs 5-8). Tabs, addressable by URL (`#cfg=fields/fields|table|issue|agent`):
// Fields is the field definitions, a list with what each applies to and where it shows, and the add, edit and
// remove form (a field is an ITSA field every agent reads; agents define them through the chief of staff, and
// `assertMayDefine` on the daemon guards the write). Table is every Work column in the order the Work page shows
// them: each row shows or hides its column and moves it (drag on a desktop, up and down by touch or keyboard), and
// the locked columns (views.ts LOCKED) stay put. Show, hide, and order write the Work page's working layout in
// settings (work/views.ts), and a custom column's move also writes the fields' order. Issue card is the desktop
// card editor (IssueCardEditor), and on a phone the touch editor (IssueCardPhoneEditor). Agent card is the agent card's editor
// (AgentCardEditor, and AgentCardPhoneEditor on a phone).
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { api } from '../api'
import { Icon } from '../Icon'
import { toast } from '../ui/menu'
import { WORK_COLUMNS } from '../work/columns'
import {
  FIELD_TONES, FIELD_TYPES, TONE_CLASS, TONE_LABEL, fetchFields, fieldColId, workColumnIds,
  type Field, type FieldType,
} from '../itsa/fields'
import { loadStore, loadWork, moveBy, setShown, type Layout, type ViewStore } from '../work/views'
import { saveCardLayout, useCardLayout, type CardLayout } from '../card-layout'
import { resetAgentLayout } from '../agent-layout'
import { resetIssueLayout } from '../itsa/issue-layout'
import { IssueCardEditor } from '../itsa/IssueCardEditor'
import { IssueCardPhoneEditor } from '../itsa/IssueCardPhoneEditor'
import { AgentCardEditor, AgentCardPhoneEditor } from '../system/AgentCardEditor'
import { cardItemsFor } from '../work/card-items'
import { useWorkExtras } from '../work/data'
import { useData } from '../store'
import { Row, Seg } from './TypesSettings'
import { appliesTo, columnRows, dropOn, fieldOrder, formOf, keyFrom, moveItem, newOption, payloadOf, shownIn, writeLayout, type ColumnRow, type FieldForm } from './work-columns'
import { Loading } from '../Loading'
import { usePhone } from '../ui/phone'

const BUILTIN = WORK_COLUMNS.map((c) => c.id)
const LABELS: Record<string, string> = Object.fromEntries(WORK_COLUMNS.map((c) => [c.id, c.label || c.id[0].toUpperCase() + c.id.slice(1)]))
const TYPE_LABEL: Record<FieldType, string> = { text: 'Text', number: 'Number', choice: 'Choice', link: 'Link', date: 'Date', check: 'Check' }
const TYPE_HELP: Record<FieldType, string> = {
  text: 'Any text.', number: 'A number.', choice: 'One of the options below.', link: 'An http or https URL.', date: 'A date (YYYY-MM-DD).', check: 'Yes or no.',
}

// The tabs of the section, and the one the section opens on. The Issue card tab is the card editor: the desktop one
// (IssueCardEditor, S-1438 PR 6) or, on a phone, the touch one (IssueCardPhoneEditor, PR 7).
export type FieldsTab = 'fields' | 'table' | 'issue' | 'agent'
const TABS: { key: FieldsTab; label: string }[] = [
  { key: 'fields', label: 'Fields' }, { key: 'table', label: 'Table' }, { key: 'issue', label: 'Issue card' }, { key: 'agent', label: 'Agent card' },
]
export const TAB_KEY = 'stam/fields-tab'
const tabOf = (t: string | null | undefined): FieldsTab => (TABS.some((x) => x.key === t) ? (t as FieldsTab) : 'fields')
function readTab(): FieldsTab {
  try { return tabOf(localStorage.getItem(TAB_KEY)) } catch { return 'fields' }
}

// After a move the arrow pressed keeps focus; when the move disabled it (the column reached an
// end), the other arrow takes it, so the keyboard never drops to the page.
function keepFocus(scope: ParentNode | null | undefined, up: string, down: string, dir: number) {
  const [pressed, other] = (dir < 0 ? [up, down] : [down, up]).map((sel) => scope?.querySelector<HTMLButtonElement>(sel))
  ;(pressed && !pressed.disabled ? pressed : other && !other.disabled ? other : null)?.focus()
}

// Whether a drag is over the lower half of the row: the column then lands below it.
const lowerHalf = (e: DragEvent<HTMLElement>) => { const b = e.currentTarget.getBoundingClientRect(); return e.clientY > b.top + b.height / 2 }


// `cos` is the chief of staff's name while one is set.
export function WorkColumnsSettings({ cos }: { cos: string | null }) {
  const [fields, setFields] = useState<Field[] | null>(null)
  const [store, setStore] = useState<ViewStore | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<FieldsTab>(readTab)
  const phone = usePhone()
  // The field open in the form: a field id, 'new', or null for the tab.
  const [open, setOpen] = useState<string | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; below: boolean } | null>(null)
  // The row whose arrow was pressed, to keep focus on it after the move.
  const [moved, setMoved] = useState<{ id: string; dir: number } | null>(null)
  const list = useRef<HTMLDivElement>(null)
  // Field order writes go one at a time, and only the latest one's answer is kept.
  const orderQueue = useRef<Promise<unknown>>(Promise.resolve())
  const orderSeq = useRef(0)
  const issue = useCardLayout('issue', fields ?? [])
  const agent = useCardLayout('agent', fields ?? [])
  const itsas = useData().itsas
  const agents = useData().agents
  const extras = useWorkExtras()
  // The kinds in use: the kinds the form offers, besides any a field already has.
  const kindsInUse = [...new Set((itsas ?? []).map((i) => i.kind).filter((k): k is string => !!k))].sort()

  const load = async () => {
    try {
      const [fs] = await Promise.all([fetchFields(), loadWork()])
      setFields(fs)
      setStore(loadStore(workColumnIds(BUILTIN, fs)))
      setError(null)
      return fs
    } catch (e) { setError((e as Error).message); return null }
  }
  useEffect(() => { void load() }, [])
  // A deep link (`#cfg=fields/table`) or the search palette picks the tab while the section is open.
  useEffect(() => {
    const on = (e: Event) => { const t = (e as CustomEvent<{ tab?: string }>).detail?.tab; if (t) setTab(tabOf(t)) }
    addEventListener('stam:open-setting', on as EventListener)
    return () => removeEventListener('stam:open-setting', on as EventListener)
  }, [])
  useEffect(() => {
    if (!moved) return
    const row = [...(list.current?.querySelectorAll('.wcol-row') ?? [])].find((e) => e.getAttribute('data-col') === moved.id)
    keepFocus(row, '.wcol-up', '.wcol-down', moved.dir)
    setMoved(null)
  }, [moved, store])

  // A failed load keeps whatever list shows, with the reason and a way to try again.
  const failed = error ? (
    <div className="wcol-error" role="alert"><span className="sp-error">{error}</span>
      <button type="button" className="btn" onClick={() => void load()}><Icon name="rotate-ccw" />Retry</button></div>
  ) : null
  if (!fields || !store) return failed ?? <Loading className="muted" />
  const ids = workColumnIds(BUILTIN, fields)

  // Saves the layout over what settings hold now, then the fields' order if a custom column moved.
  const relayout = (fn: (l: Layout, ids: string[]) => Layout, fs = fields, settled = false) => {
    const cur = workColumnIds(BUILTIN, fs)
    const next = writeLayout(cur, fn, settled)
    setStore(next)
    window.dispatchEvent(new CustomEvent('stam:work-layout'))
    const order = fieldOrder(next.layout, cur, fs)
    if (!order) return
    const seq = ++orderSeq.current
    orderQueue.current = orderQueue.current.then(async () => {
      try {
        const got = await api<Field[]>('POST', '/api/itsas/fields/order', { order })
        if (seq === orderSeq.current) setFields(got)
      } catch (e) { toast((e as Error).message) }
    })
  }

  if (open !== null) {
    const field = fields.find((f) => f.id === open) ?? null
    return <FieldEditor key={open} field={field} taken={fields.filter((f) => f.id !== open).map((f) => f.key)} kindsInUse={kindsInUse}
      onDone={async (saved) => {
        setOpen(null)
        if (!saved) return
        const fs = await load()
        // A new field shows at once, at the end of the Table.
        if (fs && open === 'new') relayout((l, cur) => setShown(l, cur, fieldColId(saved), true), fs, true)
      }}
      onRemoved={async () => {
        setOpen(null)
        const fs = await load()
        // The removed field leaves the layout too.
        if (fs) relayout((l) => l, fs, true)
      }} />
  }

  const cols = store.layout.cols
  const current = tab
  const tabs = (
    <div className="seg wcol-tabs" role="tablist" aria-label="Fields and cards">
      {TABS.map((t) => (
        <button key={t.key} type="button" role="tab" id={`cfg-tab-${t.key}`} aria-selected={current === t.key} aria-controls="cfg-tabpanel"
          className={current === t.key ? 'on' : ''} onClick={() => { setTab(t.key); try { localStorage.setItem(TAB_KEY, t.key) } catch {} }}>{t.label}</button>
      ))}
    </div>
  )

  if (current === 'issue') {
    const cardEditor = { layout: issue, items: cardItemsFor('issue', fields), fields, itsas: itsas ?? [], extras, onChange: (next: CardLayout) => saveCardLayout('issue', next), onReset: () => saveCardLayout('issue', resetIssueLayout(fields)) }
    return (
      <div role="tabpanel" id="cfg-tabpanel" aria-labelledby="cfg-tab-issue">
        {tabs}
        <p className="lede">The card's slots: what a board card and an issue show, and in which slot. Changes save at once.</p>
        {failed}
        {phone ? <IssueCardPhoneEditor {...cardEditor} /> : <IssueCardEditor {...cardEditor} />}
      </div>
    )
  }

  if (current === 'agent') {
    const cardEditor = { layout: agent, issue, items: cardItemsFor('agent', fields), fields, agents: agents ?? [], itsas: itsas ?? [], extras, onChange: (next: CardLayout) => saveCardLayout('agent', next), onReset: () => saveCardLayout('agent', resetAgentLayout(fields)) }
    return (
      <div role="tabpanel" id="cfg-tabpanel" aria-labelledby="cfg-tab-agent">
        {tabs}
        <p className="lede">The agent card's slots: what a system view card shows, and in which slot. Changes save at once.</p>
        {failed}
        {phone ? <AgentCardPhoneEditor {...cardEditor} /> : <AgentCardEditor {...cardEditor} />}
      </div>
    )
  }

  if (current === 'table') {
    const rows = columnRows(store.layout, ids, LABELS, fields)
    const view = store.current ? store.views.find((v) => v.id === store.current)?.name : null
    return (
      <div role="tabpanel" id="cfg-tabpanel" aria-labelledby="cfg-tab-table">
        {tabs}
        <p className="lede">Show, hide and order the Work page's columns.</p>
        <p className="muted wcol-note">What shows, and in what order, is the Work page's layout{view ? <>: now your view <b>{view}</b></> : null}. Locked columns stay where they are.</p>
        {failed}
        <div className="set-card wcol-card" role="list" aria-label="Work columns" ref={list}>
          {rows.map((r) => (
            <ColumnRowView key={r.id} r={r} dragging={drag === r.id} over={over?.id === r.id && drag !== r.id ? (over.below ? 'below' : 'above') : null}
              onShow={(on) => relayout((l, cur) => setShown(l, cur, r.id, on))}
              onMove={(d) => { relayout((l, cur) => moveBy(l, cur, r.id, d)); setMoved({ id: r.id, dir: d }) }}
              onDragStart={() => setDrag(r.id)}
              onDragOver={(below) => setOver({ id: r.id, below })}
              onDrop={(below) => { const from = drag; setDrag(null); setOver(null); if (from) relayout((l, cur) => dropOn(l, cur, from, r.id, below)) }}
              onDragEnd={() => { setDrag(null); setOver(null) }} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div role="tabpanel" id="cfg-tabpanel" aria-labelledby="cfg-tab-fields">
      {tabs}
      <p className="lede">{cos ? <>Agents define fields through @{cos}.</> : 'No chief of staff is set, so any agent may define fields.'}</p>
      {failed}
      {fields.length ? (
        <ul className="fld-list" aria-label="Fields">
          {fields.map((f) => (
            <li key={f.id}>
              <button type="button" className="fld-row" aria-label={`Edit ${f.label}`} onClick={() => setOpen(f.id)}>
                <span className="fld-main">
                  <span className="wcol-head"><b>{f.label}</b><span className="badge">{TYPE_LABEL[f.type]}</span></span>
                  <span className="wcol-meta">{f.key}</span>
                  <span className="fld-line">Applies to: {appliesTo(f)}</span>
                  <span className="fld-line">Shown in: {shownIn(f, cols, issue)}</span>
                </span>
                <Icon name="pencil" size="xs" />
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="muted wcol-empty">No fields yet. Add one for something every agent fills in, such as a stage or a due date.</p>}
      <button type="button" className="btn" id="add-field" onClick={() => setOpen('new')}><Icon name="plus" />Add field</button>
    </div>
  )
}

function ColumnRowView({ r, dragging, over, onShow, onMove, onDragStart, onDragOver, onDrop, onDragEnd }: {
  r: ColumnRow; dragging: boolean; over: 'above' | 'below' | null
  onShow: (on: boolean) => void; onMove: (delta: number) => void
  onDragStart: () => void; onDragOver: (below: boolean) => void; onDrop: (below: boolean) => void; onDragEnd: () => void
}) {
  const movable = r.shown && !r.locked
  const f = r.field
  const meta = r.locked ? 'Always shown, always in place' : f ? `${TYPE_LABEL[f.type]} · ${f.key}` : null
  return (
    <div role="listitem" data-col={r.id} className={`wcol-row ${r.shown ? '' : 'off'} ${dragging ? 'dragging' : ''} ${over ? 'over ' + over : ''}`}
      draggable={movable} onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); onDragStart() }}
      onDragOver={(e) => { e.preventDefault(); onDragOver(lowerHalf(e)) }} onDrop={(e) => { e.preventDefault(); onDrop(lowerHalf(e)) }} onDragEnd={onDragEnd}>
      <span className={`wcol-grip ${movable ? '' : 'none'}`} aria-hidden="true">{movable ? <Icon name="grip-vertical" size="xs" /> : null}</span>
      <label className="wcol-show" title={r.locked ? 'Always shown' : r.shown ? 'Shown' : 'Hidden'}>
        {r.locked ? <Icon name="lock" size="xs" /> : <input type="checkbox" checked={r.shown} aria-label={`Show ${r.label}`} onChange={(e) => onShow(e.target.checked)} />}
      </label>
      <span className="wcol-main">
        <span className="wcol-head"><b>{r.label}</b>{f ? <span className="badge progress">Custom</span> : null}{r.shown ? null : <span className="badge">Hidden</span>}</span>
        {meta ? <span className="wcol-meta">{meta}</span> : null}
        {f?.description ? <span className="wcol-desc">{f.description}</span> : null}
        {f?.type === 'choice' && f.options?.length ? (
          <span className="wcol-opts">{f.options.map((o) => <span key={o.value} className={`badge ${o.tone ? TONE_CLASS[o.tone] : ''}`}>{o.label}</span>)}</span>
        ) : null}
      </span>
      {r.locked ? null : (
        <span className="wcol-ctl">
          <button type="button" className="icon-btn wcol-up" aria-label={`Move ${r.label} up`} title={r.shown ? 'Move up' : 'Show it to move it'} disabled={!r.canUp} onClick={() => onMove(-1)}><Icon name="arrow-up" size="xs" /></button>
          <button type="button" className="icon-btn wcol-down" aria-label={`Move ${r.label} down`} title={r.shown ? 'Move down' : 'Show it to move it'} disabled={!r.canDown} onClick={() => onMove(1)}><Icon name="arrow-down" size="xs" /></button>
        </span>
      )}
    </div>
  )
}

// Adds a field, or changes or removes one. Saving shows the daemon's reason inline when it refuses, such as a type
// change that values already set don't fit, or a kind the daemon won't store.
function FieldEditor({ field, taken, kindsInUse, onDone, onRemoved }: {
  field: Field | null; taken: string[]; kindsInUse: string[]; onDone: (saved: Field | null) => Promise<void>; onRemoved: () => Promise<void>
}) {
  const isNew = !field
  const [form, setForm] = useState<FieldForm>(() => formOf(field))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [kindIn, setKindIn] = useState('')
  // The kinds offered: the kinds in use, and the ones typed in here, so unticking one keeps its box to tick again.
  const [kindList, setKindList] = useState(() => [...new Set([...kindsInUse, ...form.kinds])])
  const set = (patch: Partial<FieldForm>) => { setErr(''); setForm((f) => ({ ...f, ...patch })) }
  // The option whose arrow was pressed, at its new index, to keep focus on it.
  const [movedOpt, setMovedOpt] = useState<{ i: number; dir: number } | null>(null)
  const moveOpt = (i: number, dir: number) => { set({ options: moveItem(form.options, i, dir) }); setMovedOpt({ i: i + dir, dir }) }
  const setOpt = (i: number, patch: Partial<FieldForm['options'][number]>) => set({ options: form.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) })
  const pickType = (type: FieldType) => set({ type, options: type === 'choice' && !form.options.length ? [newOption(), newOption()] : form.options })
  const toggleKind = (k: string) => set({ kinds: form.kinds.includes(k) ? form.kinds.filter((x) => x !== k) : [...form.kinds, k] })
  // A kind typed in, kept if it isn't in the list already (the daemon matches kinds ignoring case).
  const addKind = () => {
    const typed = kindIn.trim()
    setKindIn('')
    if (!typed) return
    // A kind already offered is ticked under its own spelling, whatever the case typed.
    const k = kindList.find((x) => x.toLowerCase() === typed.toLowerCase()) ?? typed
    if (!kindList.includes(k)) setKindList([...kindList, k])
    if (!form.kinds.some((x) => x.toLowerCase() === k.toLowerCase())) set({ kinds: [...form.kinds, k] })
  }
  const onKindKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); addKind() } }
  const derived = keyFrom(form.label, taken)
  // The form opens at its top, wherever the list was scrolled.
  const top = useRef<HTMLFormElement>(null)
  useEffect(() => { top.current?.closest('.settings-body')?.scrollTo?.(0, 0) }, [])
  useEffect(() => {
    if (!movedOpt) return
    keepFocus(top.current?.querySelector(`[data-opt="${movedOpt.i}"]`), '.wcol-up', '.wcol-down', movedOpt.dir)
    setMovedOpt(null)
  }, [movedOpt])

  async function save() {
    if (!form.label.trim()) return setErr('Give the field a name.')
    setBusy(true)
    try {
      const body = payloadOf(form, taken, field?.key)
      const saved = isNew ? await api<Field>('POST', '/api/itsas/fields', body) : await api<Field>('PATCH', `/api/itsas/fields/${field.id}`, body)
      toast(isNew ? `Added the ${saved.label} field` : `Saved the ${saved.label} field`)
      await onDone(saved)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  async function remove() {
    if (!field || !confirm(`Remove the ${field.label} field? Its values on every ITSA go with it, for every agent and view.`)) return
    try {
      const r = await api<{ values: number }>('DELETE', `/api/itsas/fields/${field.id}`)
      toast(`Removed the ${field.label} field${r.values ? ` and its values on ${r.values} ITSA${r.values === 1 ? '' : 's'}` : ''}`)
      await onRemoved()
    } catch (e) { setErr((e as Error).message) }
  }

  return (
    <form ref={top} className="type-form wcol-form" aria-label={isNew ? 'New field' : `Field ${field.label}`} onSubmit={(e) => { e.preventDefault(); void save() }}>
      <button type="button" className="btn type-back" onClick={() => void onDone(null)}><Icon name="arrow-left" size="xs" />Fields</button>
      <h2 className="wcol-title">{isNew ? 'New field' : field.label}</h2>
      <div className="set-card">
        <Row label="Name" help="The field's header." cls="grow">
          <input type="text" className="wide" name="label" value={form.label} placeholder="Stage" maxLength={60} autoComplete="off" onChange={(e) => set({ label: e.target.value })} />
        </Row>
        <Row label="Type" help={TYPE_HELP[form.type] + (isNew || form.type === field.type ? '' : ' Values already set must fit the new type.')}>
          <Seg value={form.type} opts={FIELD_TYPES.map((t) => ({ v: t, label: TYPE_LABEL[t] }))} onPick={pickType} />
        </Row>
        <Row label="Applies to" help="Every kind, or only the kinds picked: other ITSAs don't show the field." cls="grow">
          <div className="wcol-kinds" role="group" aria-label="Applies to">
            <label className="check"><input type="checkbox" name="kind-all" checked={!form.kinds.length} onChange={() => set({ kinds: [] })} />All kinds</label>
            {kindList.map((k) => (
              <label className="check" key={k}><input type="checkbox" name={`kind-${k}`} checked={form.kinds.includes(k)} onChange={() => toggleKind(k)} />{k}</label>
            ))}
            <span className="wcol-kind-add">
              <input type="text" name="kind-add" aria-label="Another kind" placeholder="Another kind" value={kindIn} spellCheck={false} autoCapitalize="none" autoComplete="off"
                onChange={(e) => setKindIn(e.target.value)} onKeyDown={onKindKey} />
              <button type="button" className="btn" disabled={!kindIn.trim()} onClick={addKind}>Add kind</button>
            </span>
          </div>
        </Row>
      </div>

      {form.type === 'choice' ? (
        <>
          <h3>Options</h3>
          <p className="muted wcol-sub">What agents pick from, in this order. The tone colours the option's chip.</p>
          <div className="wcol-optlist">
            {form.options.map((o, i) => (
              <div className="wcol-opt" key={i} data-opt={i}>
                <div className="wcol-opt-a">
                  <input type="text" name={`opt-label-${i}`} aria-label={`Option ${i + 1} label`} placeholder="Label" value={o.label} autoComplete="off" onChange={(e) => setOpt(i, { label: e.target.value })} />
                  <input type="text" name={`opt-value-${i}`} aria-label={`Option ${i + 1} value`} className="wcol-opt-value" placeholder={o.label.trim() ? keyFrom(o.label) : 'value'} value={o.value}
                    spellCheck={false} autoCapitalize="none" autoComplete="off" onChange={(e) => setOpt(i, { value: e.target.value })} />
                  <button type="button" className="icon-btn wcol-opt-x" aria-label={`Remove option ${i + 1}`} title="Remove" onClick={() => set({ options: form.options.filter((_, j) => j !== i) })}><Icon name="x" size="xs" /></button>
                </div>
                <div className="wcol-opt-b">
                  <div className="wcol-tones" role="radiogroup" aria-label={`Option ${i + 1} tone`}>
                    {FIELD_TONES.map((t) => (
                      <label key={t} data-tone={t} className={`wcol-tone ${o.tone === t ? 'on' : ''}`} title={TONE_LABEL[t]}>
                        <input type="radio" name={`opt-tone-${i}`} value={t} checked={o.tone === t} aria-label={TONE_LABEL[t]} onChange={() => setOpt(i, { tone: t })} />
                        <span className={`badge ${TONE_CLASS[t]}`} aria-hidden="true">Aa</span>
                      </label>
                    ))}
                  </div>
                  <span className="wcol-opt-moves">
                    <button type="button" className="icon-btn wcol-up" aria-label={`Move option ${i + 1} up`} title="Move up" disabled={i === 0} onClick={() => moveOpt(i, -1)}><Icon name="arrow-up" size="xs" /></button>
                    <button type="button" className="icon-btn wcol-down" aria-label={`Move option ${i + 1} down`} title="Move down" disabled={i === form.options.length - 1} onClick={() => moveOpt(i, 1)}><Icon name="arrow-down" size="xs" /></button>
                  </span>
                </div>
              </div>
            ))}
          </div>
          <button type="button" className="btn wcol-add-opt" onClick={() => set({ options: [...form.options, newOption()] })}><Icon name="plus" />Add option</button>
        </>
      ) : null}

      <h3>For agents and the header</h3>
      <div className="set-card">
        <div className="set-field">
          <b>What agents put here</b>
          <p>Agents read this to fill the field on their ITSAs.</p>
          <textarea name="description" rows={2} value={form.description} placeholder="The stage the work is in: dev while building, review once a reviewer has it." onChange={(e) => set({ description: e.target.value })} />
        </div>
        <Row label="Hint" help="The header's tooltip." cls="grow">
          <input type="text" className="wide" name="hint" value={form.hint} placeholder="Where the work is" autoComplete="off" onChange={(e) => set({ hint: e.target.value })} />
        </Row>
      </div>

      <h3>Layout</h3>
      <div className="set-card">
        <Row label="Width"><Seg value={form.width} opts={[{ v: 's' as const, label: 'Small' }, { v: 'm' as const, label: 'Medium' }, { v: 'l' as const, label: 'Large' }]} onPick={(width) => set({ width })} /></Row>
        <Row label="Alignment" help="Numbers read best on the right."><Seg value={form.align} opts={[{ v: 'start' as const, label: 'Left' }, { v: 'end' as const, label: 'Right' }]} onPick={(align) => set({ align })} /></Row>
        <Row label="On the phone's card: chip / meta line" help="Where it shows on a phone's Work card: a chip beside the status, or the detail line below. The issue and agent cards place a field in their own tabs.">
          <Seg value={form.card} opts={[{ v: 'chip' as const, label: 'Chip' }, { v: 'meta' as const, label: 'Detail line' }]} onPick={(card) => set({ card })} />
        </Row>
      </div>

      <details className="step-more wcol-more">
        <summary>More</summary>
        <Row label="Key" help={`Agents set values by this key. Empty: ${derived || 'from the name'}.`} cls="grow">
          <input type="text" className="wide" name="key" value={form.key} placeholder={derived} spellCheck={false} autoCapitalize="none" autoComplete="off" maxLength={32}
            onChange={(e) => set({ key: e.target.value.toLowerCase() })} />
        </Row>
      </details>

      {err ? <p className="sp-error" role="alert">{err}</p> : null}
      <div className="row type-actions">
        <button type="submit" className="btn primary" disabled={busy}>{isNew ? 'Add field' : 'Save'}</button>
        <button type="button" className="btn" onClick={() => void onDone(null)}>Cancel</button>
        <span className="spacer" />
        {!isNew ? <button type="button" className="btn danger" onClick={() => void remove()}><Icon name="trash-2" />Remove</button> : null}
      </div>
    </form>
  )
}

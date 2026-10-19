// The filter editors of the Work header menu (S-1513), one per filter kind (sortfilter.ts), and the
// words a filter reads as in the active-filter row. Each editor is controlled by the column's
// current filter and reports the next one, or null when the edit leaves nothing filtered; the
// menu applies it at once. The rows reuse the recipient menu's checklist look (`.rm-*`).
import { useRef, useState } from 'react'
import { Icon } from '../Icon'
import { DATE_PRESETS, type ColFilter, type DatePreset, type FilterKind, type FilterValue } from './sortfilter'

type Of<K extends FilterKind> = Extract<ColFilter, { kind: K }>
interface EditorProps<K extends FilterKind> { filter: Of<K> | null; onChange: (f: Of<K> | null) => void }

export const KIND_LABEL: Record<FilterKind, string> = { values: 'Values', text: 'Contains', range: 'Range', date: 'Date', has: 'Has', check: 'Yes / No' }
export const PRESET_LABEL: Record<DatePreset, string> = { hour: 'Last hour', today: 'Today', '7d': 'Last 7 days', older2d: 'Older than 2 days', older7d: 'Older than 7 days' }

// A row of a checklist or a radio group: its label, an optional count, and the tick.
function Row({ role, on, label, n, onClick }: { role: 'checkbox' | 'radio'; on: boolean; label: string; n?: number; onClick: () => void }) {
  return <button type="button" role={role} aria-checked={on} className="rm-row" onClick={onClick}>
    <span className="ml">{label}</span>{n === undefined ? null : <span className="muted fm-n">{n}</span>}
    <span className={'tick' + (on ? '' : ' off')}><Icon name="check" /></span>
  </button>
}

// The distinct values with counts, as a checklist with a search box. Nothing filtered = every value
// ticked; ticking them all again drops the filter. All and None act on the values the search shows.
// A column with no filter, or a standing exclude rule (`not`), edits the rule: unticking adds to it,
// ticking removes from it, so a value that appears later stays ticked. Only an include list
// (`values`) stays an include list, and None makes an empty one.
export function ValuesEditor({ options, filter, onChange }: EditorProps<'values'> & { options: FilterValue[] }) {
  const [q, setQ] = useState('')
  const include = !!filter?.values
  const hidden = new Set(filter?.not)
  const picked = new Set(filter?.values ?? options.map((o) => o.value))
  for (const v of hidden) picked.delete(v)
  const needle = q.trim().toLowerCase()
  const shown = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options
  const set = (next: Set<string>) => {
    // Nothing ticked is an empty include list, so ticking one then picks it alone.
    if (include || (options.length && options.every((o) => !next.has(o.value)))) return onChange(options.every((o) => next.has(o.value)) ? null : { kind: 'values', values: [...next] })
    // A rule value the options no longer list stays in the rule.
    const not = [...[...hidden].filter((v) => !options.some((o) => o.value === v)), ...options.filter((o) => !next.has(o.value)).map((o) => o.value)]
    onChange(not.length ? { kind: 'values', not } : null)
  }
  const toggle = (v: string) => { const n = new Set(picked); if (n.has(v)) n.delete(v); else n.add(v); set(n) }
  const all = (on: boolean) => { const n = new Set(picked); for (const o of shown) { if (on) n.add(o.value); else n.delete(o.value) } set(n) }
  return <div className="fm-values">
    <input className="rm-search" type="search" value={q} placeholder="Search values" aria-label="Search values" autoComplete="off" spellCheck={false} onChange={(e) => setQ(e.target.value)} />
    <div className="fm-bulk">
      <button type="button" className="btn text" disabled={!shown.length} onClick={() => all(true)}>All</button>
      <button type="button" className="btn text" disabled={!shown.length} onClick={() => all(false)}>None</button>
    </div>
    <div className="rm-list" role="group" aria-label="Values">
      {shown.map((o) => <Row key={o.value} role="checkbox" on={picked.has(o.value)} label={o.label} n={o.n} onClick={() => toggle(o.value)} />)}
      {!shown.length ? <div className="rm-none muted">No value matches</div> : null}
    </div>
  </div>
}

export function TextEditor({ filter, onChange }: EditorProps<'text'>) {
  return <input className="rm-search" type="search" value={filter?.q ?? ''} placeholder="Contains" aria-label="Contains" autoComplete="off" spellCheck={false}
    onChange={(e) => onChange(e.target.value.trim() ? { kind: 'text', q: e.target.value } : null)} />
}

// A number field that keeps what is typed (a lone "-" or "1.") and reports the number once it parses.
function NumField({ label, value, onValue }: { label: string; value: number | undefined; onValue: (n: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  // The value this field last reported (or started with). `value` differing from it means the filter
  // changed from elsewhere (Clear filter, the token's ×): show it. Half-typed text ("-", "1e") reports
  // nothing, so it is never replaced.
  const reported = useRef(value)
  if (value !== reported.current) { reported.current = value; setText(value === undefined ? '' : String(value)) }
  return <input className="rm-search" type="text" inputMode="decimal" value={text} placeholder={label} aria-label={label} autoComplete="off"
    onChange={(e) => {
      const t = e.target.value
      setText(t)
      if (!t.trim()) { reported.current = undefined; onValue(undefined) }
      else if (Number.isFinite(Number(t))) { reported.current = Number(t); onValue(Number(t)) }
    }} />
}

export function RangeEditor({ filter, onChange }: EditorProps<'range'>) {
  const set = (min: number | undefined, max: number | undefined) => onChange(min === undefined && max === undefined ? null : { kind: 'range', ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) })
  return <div className="fm-pair">
    <NumField label="Min" value={filter?.min} onValue={(n) => set(n, filter?.max)} />
    <NumField label="Max" value={filter?.max} onValue={(n) => set(filter?.min, n)} />
  </div>
}

export function DateEditor({ filter, onChange }: EditorProps<'date'>) {
  const set = (next: { preset?: DatePreset; from?: string; to?: string }) => onChange(next.preset || next.from || next.to ? { kind: 'date', ...(next.preset ? { preset: next.preset } : {}), ...(next.from ? { from: next.from } : {}), ...(next.to ? { to: next.to } : {}) } : null)
  const cur = { preset: filter?.preset, from: filter?.from, to: filter?.to }
  return <div className="fm-date">
    <div role="radiogroup" aria-label="Date presets">
      {DATE_PRESETS.map((p) => <Row key={p} role="radio" on={cur.preset === p} label={PRESET_LABEL[p]} onClick={() => set({ ...cur, preset: cur.preset === p ? undefined : p })} />)}
    </div>
    <div className="fm-pair">
      <label className="fm-field">From<input className="rm-search" type="date" value={cur.from ?? ''} aria-label="From" onChange={(e) => set({ ...cur, from: e.target.value || undefined })} /></label>
      <label className="fm-field">To<input className="rm-search" type="date" value={cur.to ?? ''} aria-label="To" onChange={(e) => set({ ...cur, to: e.target.value || undefined })} /></label>
    </div>
  </div>
}

// Choose one of a few labelled values; choosing the chosen one again clears it.
function Choice<T extends boolean>({ label, options, value, onPick }: { label: string; options: [string, T][]; value: T | undefined; onPick: (v: T | undefined) => void }) {
  return <div role="radiogroup" aria-label={label}>
    {options.map(([text, v]) => <Row key={text} role="radio" on={value === v} label={text} onClick={() => onPick(value === v ? undefined : v)} />)}
  </div>
}

export function HasEditor({ filter, onChange }: EditorProps<'has'>) {
  return <Choice label="Has" options={[['Has one or more', true], ['Has none', false]]} value={filter?.has} onPick={(v) => onChange(v === undefined ? null : { kind: 'has', has: v })} />
}

export function CheckEditor({ filter, onChange }: EditorProps<'check'>) {
  return <Choice label="Yes or no" options={[['Yes', true], ['No', false]]} value={filter?.value} onPick={(v) => onChange(v === undefined ? null : { kind: 'check', value: v })} />
}

// The editor for one kind. `options` is the checklist's values (values kind only).
export function FilterEditor({ kind, filter, options, onChange }: { kind: FilterKind; filter: ColFilter | null; options: FilterValue[]; onChange: (f: ColFilter | null) => void }) {
  const of = <K extends FilterKind>(k: K) => (filter?.kind === k ? (filter as Of<K>) : null)
  switch (kind) {
    case 'values': return <ValuesEditor options={options} filter={of('values')} onChange={onChange} />
    case 'text': return <TextEditor filter={of('text')} onChange={onChange} />
    case 'range': return <RangeEditor filter={of('range')} onChange={onChange} />
    case 'date': return <DateEditor filter={of('date')} onChange={onChange} />
    case 'has': return <HasEditor filter={of('has')} onChange={onChange} />
    case 'check': return <CheckEditor filter={of('check')} onChange={onChange} />
  }
}

// What a filter says, for its token: the part after "Status:".
export function describeFilter(f: ColFilter, options: FilterValue[] = []): string {
  switch (f.kind) {
    case 'values': {
      const name = (v: string) => options.find((o) => o.value === v)?.label ?? (v === '' ? '(Blank)' : v)
      const [inc, not] = [f.values ? (f.values.length ? f.values.map(name).join(', ') : 'none') : '', f.not?.length ? `≠ ${f.not.map(name).join(', ')}` : '']
      return [inc, not].filter(Boolean).join('; ')
    }
    case 'text': return `contains “${f.q.trim()}”`
    case 'range': return f.min !== undefined && f.max !== undefined ? `${f.min} to ${f.max}` : f.min !== undefined ? `at least ${f.min}` : `at most ${f.max}`
    case 'date': return [f.preset ? PRESET_LABEL[f.preset] : '', f.from ? `from ${f.from}` : '', f.to ? `to ${f.to}` : ''].filter(Boolean).join(', ')
    case 'has': return f.has ? 'has some' : 'has none'
    case 'check': return f.value ? 'Yes' : 'No'
  }
}

// A filter's token: "Status: Todo, Done", or "Status ≠ blocked" for a standing exclude rule.
export const filterText = (label: string, f: ColFilter, options: FilterValue[] = []) => `${label}${f.kind === 'values' && !f.values ? ' ' : ': '}${describeFilter(f, options)}`

// Settings › Tiny models (S-1480): the cheap model calls stam makes for itself, one page each. The
// list shows every step with its model and whether it is on; a page shows its on/off, its model, its
// own settings and its instructions. The registry (labels, setting paths, default and read-only
// instruction text) comes from the daemon's GET /api/tiny-models; the values shown are read from the
// settings object, so a change shows at once. Each control writes through ConfigView's deep-path setter.
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Icon } from '../Icon'
import { ProviderModelPicker, usableProviders, type ProviderCfg } from './ProvidersSettings'

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
export interface TinyExtra { path: string; kind: 'bool' | 'number'; label: string; help: string; unit?: string; min?: number; max?: number; step?: number }
export interface Instr { default: string; editable: boolean; path: string | null; note?: string }
export interface TinyModel {
  id: string
  // The daemon's resolved values, shown when the settings file lacks the key.
  enabled: boolean
  model: string
  usedBy: string | null
  label: string
  purpose: string
  toggle: string | null
  modelPath: string
  instructions: Instr
  // A second prompt of the step (mail titles: the summary prompt), labelled.
  more?: (Instr & { label: string })[]
  extras: TinyExtra[]
}

const KEY = 'stam/settings-tiny'
const getPath = (o: unknown, path: string): Json | undefined => path.split('.').reduce<unknown>((x, key) => (x as Record<string, unknown> | undefined)?.[key], o) as Json | undefined

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return <div className="set-row"><div className="set-label"><b>{label}</b>{help ? <p>{help}</p> : null}</div><div className="set-ctl">{children}</div></div>
}

// Whether a step is on, from the settings: its checkbox, or for the steps without one, a model
// (mail titles, instruction summaries). Decisions has no on/off: its model is shared by several steps.
// A key the settings file lacks falls back to the daemon's resolved value from the registry.
export function modelOf(m: TinyModel, s: unknown): string {
  return (getPath(s, m.modelPath) as string | undefined) ?? m.model
}
export function isOn(m: TinyModel, s: unknown): boolean {
  if (m.toggle) return (getPath(s, m.toggle) as boolean | undefined) ?? m.enabled
  return !!modelOf(m, s)
}

function Num({ extra, value, disabled, title, set }: { extra: TinyExtra; value: number; disabled: boolean; title?: string; set: (path: string, v: Json) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const n = Number(draft)
    const d = draft
    setDraft(null)
    if (d !== null && d !== '' && Number.isFinite(n) && n !== value) set(extra.path, Math.min(extra.max ?? Infinity, Math.max(extra.min ?? 0, n)))
  }
  return (
    <span className="num">
      <input type="number" aria-label={extra.label} min={extra.min} max={extra.max} step={extra.step} disabled={disabled} title={title} value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
      {extra.unit ? <span className="unit">{extra.unit}</span> : null}
    </span>
  )
}

function Instructions({ i, name, s, disabled, title, set }: { i: Instr; name: string; s: unknown; disabled: boolean; title?: string; set: (path: string, v: Json) => void }) {
  const { default: dflt, editable, path, note } = i
  const saved = path ? ((getPath(s, path) as string | undefined) ?? '') : ''
  const shown = saved.trim() ? saved : dflt
  const [draft, setDraft] = useState<string | null>(null)
  if (!editable || !path) {
    return (
      <>
        {shown ? <pre className="tiny-instr" aria-label={`${name}, read-only`}>{shown}</pre> : null}
        <p className="muted">{note ?? 'These instructions are fixed in code and cannot be edited here.'}</p>
      </>
    )
  }
  const commit = () => {
    const d = draft
    setDraft(null)
    // The default text saves as empty, so a later change to the shipped default reaches this setting.
    if (d !== null && d !== shown) set(path, d.trim() === dflt.trim() ? '' : d)
  }
  return (
    <>
      <textarea className="tiny-instr" aria-label={name} rows={10} spellCheck={false} disabled={disabled} title={title} value={draft ?? shown}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      <div className="row-actions">
        <button type="button" className="btn" disabled={disabled || !saved.trim()} title={title} onClick={() => { setDraft(null); set(path, '') }}><Icon name="rotate-ccw" size="xs" />Reset to default</button>
        <span className="muted">{saved.trim() ? 'Edited.' : 'Shipped default.'}</span>
      </div>
      {note ? <p className="muted">{note}</p> : null}
    </>
  )
}

export function TinyModelsSettings({ s, disabled = false, why, set, initial }: { s: unknown; disabled?: boolean; why?: string; set: (path: string, v: Json) => void; initial?: string | null }) {
  const [models, setModels] = useState<TinyModel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [id, setId] = useState<string | null>(() => {
    if (initial !== undefined) return initial
    try { return localStorage.getItem(KEY) } catch { return null }
  })
  useEffect(() => {
    let live = true
    api<{ models: TinyModel[] }>('GET', '/api/tiny-models').then((r) => { if (live) setModels(r.models) }, (e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [])
  const open = (next: string | null) => {
    setId(next)
    try { if (next) localStorage.setItem(KEY, next); else localStorage.removeItem(KEY) } catch { /* private window: the page still works */ }
  }
  const title = disabled ? why : undefined
  if (error) return <p className="muted">{error}</p>
  if (!models) return <p className="muted">Loading…</p>
  const m = models.find((x) => x.id === id)
  if (!m) {
    return (
      <>
        <p className="lede">The cheap models mootr calls for itself, apart from your agents. Each has its own page: on or off, the model, its settings and its instructions. Spend shows on the Usage page.</p>
        <div className="set-card tiny-list">
          {models.map((x) => {
            const model = modelOf(x, s)
            return (
              <button type="button" key={x.id} className="tiny-item" onClick={() => open(x.id)}>
                <span className="tiny-name"><b>{x.label}</b><span className="muted">{x.purpose}</span></span>
                <span className="meta">{x.usedBy ? model : `${isOn(x, s) ? 'On' : 'Off'}${model ? ` · ${model}` : ''}`}</span>
                <Icon name="chevron-right" size="xs" />
              </button>
            )
          })}
        </div>
      </>
    )
  }
  const on = isOn(m, s)
  const model = modelOf(m, s)
  const optionalModel = !m.toggle && !m.usedBy
  // The configured providers (Settings › Model providers, S-2115) a step can use besides OpenRouter: complete ones only.
  const ids = usableProviders(((s as { providers?: Record<string, ProviderCfg> } | null)?.providers) ?? {})
  const via = ids.length ? ' From OpenRouter or a provider under Model providers.' : ''

  return (
    <>
      <p><button type="button" className="btn" onClick={() => open(null)}><Icon name="chevron-left" size="xs" />All tiny models</button></p>
      <p className="lede">{m.purpose}</p>
      <div className="set-card">
        {m.usedBy
          ? <Row label="Used by" help="One model serves all of these, and each has its own switch elsewhere. Changing the model changes it for every one."><span>{m.usedBy}</span></Row>
          : (
            <Row label="Status" help={m.toggle ? 'Off: the step asks nothing and spends nothing.' : 'On when a model is set. Clear the model to turn it off.'}>
              {m.toggle
                ? <label className="check" title={title}><input type="checkbox" disabled={disabled} checked={on} onChange={(e) => set(m.toggle!, e.target.checked)} />On</label>
                : <span className="chip">{on ? 'On' : 'Off'}</span>}
            </Row>
          )}
        <Row label="Model" help={m.id === 'activityClassify' ? 'It uses the decision model, shared with the mail checks.' : optionalModel ? (via ? `A small, cheap model is enough, such as google/gemma-3-4b-it.${via} Empty: off.` : 'An OpenRouter model. A small, cheap one is enough, such as google/gemma-3-4b-it. Empty: off.') : via ? `A cheap model is enough.${via}` : 'An OpenRouter model id. A cheap one is enough.'}>
          <ProviderModelPicker ids={ids} value={model} placeholder={optionalModel ? 'Off' : 'Default'} label={`${m.label} model`} disabled={disabled} title={title} onChange={(v) => set(m.modelPath, v)} />
        </Row>
        {m.extras.map((x) => (
          <Row key={x.path} label={x.label} help={x.help}>
            {x.kind === 'bool'
              ? <label className="check" title={title}><input type="checkbox" aria-label={x.label} disabled={disabled} checked={!!getPath(s, x.path)} onChange={(e) => set(x.path, e.target.checked)} />On</label>
              : <Num extra={x} value={(getPath(s, x.path) as number | undefined) ?? 0} disabled={disabled} title={title} set={set} />}
          </Row>
        ))}
      </div>
      <h3>Instructions</h3>
      <div className="set-card tiny-instr-card"><Instructions i={m.instructions} name="Instructions" s={s} disabled={disabled} title={title} set={set} /></div>
      {(m.more ?? []).map((x) => (
        <div key={x.label}>
          <h3>{x.label}</h3>
          <div className="set-card tiny-instr-card"><Instructions i={x} name={x.label} s={s} disabled={disabled} title={title} set={set} /></div>
        </div>
      ))}
    </>
  )
}

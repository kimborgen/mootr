// The type composer (S-892, stage 2 of S-868): on the type page's Instructions tab, the editing half.
// The blocks of the templates every agent gets, each with a switch (off strikes it through), Move up
// and Move down icon buttons beside the token badge, and, where blocks/_replace/ has files, a replacement. A sticky footer (one compact row on the phone) shows
// the running token total and saves through `POST /api/types/NAME` (human-only, shared: on a peer it
// goes to the home, and with no home page the composer is read-only). "Preview as agent" opens the
// type's inventory for a synthetic agent on each harness; it shows the saved type, so it waits for a save.
import { useEffect, useState } from 'react'
import { api, homeApi } from '../api'
import { Icon } from '../Icon'
import { HARNESS } from '../format'
import { readOnly, scopeOf, writesToHome, type SettingsReply, type SettingsScope } from '../settings-scope'
import { useData } from '../store'
import { toast } from '../ui/menu'
import { InventoryBody, useInventory } from './InventoryView'
import { typePayload, type TypeDef } from './type-form'
import { blocksPayload, draftOf, moveBlock, sameDraft, setOff, setReplacement, totalFor, type Catalog, type Draft, type TypeBlocks } from './type-compose'
import { Loading } from '../Loading'

const tok = (n: number) => `${n.toLocaleString('en-US')} tok`
const TEMPLATE: Record<string, string> = {
  'system-prompt': 'System prompt', retro: 'Retro', 'mail-to-human': 'Mail to the human', 'mail-to-human-restricted': 'Mail to the human, restricted',
}

function Preview({ name, harness, own }: { name: string; harness: string; own: boolean }) {
  const { loaded, refresh } = useInventory(`/api/types/${encodeURIComponent(name)}/inventory?harness=${encodeURIComponent(harness)}`)
  return (
    <details className="fold inv-layer comp-preview" data-harness={harness} open={own}>
      <summary><span className="inv-head"><Icon name="chevron-right" size="xs" /><h3 className="inv-title">As a {HARNESS[harness] ?? harness} agent</h3>
        {loaded.state === 'ok' ? <span className="badge">{tok(loaded.inv.totalTokens)}</span> : null}</span></summary>
      {loaded.state === 'loading' ? <Loading className="muted" />
        : loaded.state === 'error' ? <p className="muted">{loaded.message}</p>
        : <InventoryBody inv={loaded.inv} gaveUp={loaded.gaveUp} onRefresh={refresh} />}
    </details>
  )
}

export function TypeComposer({ name, def, defaultReviewer, harnesses, harness, inventoryTotal, onSaved }: {
  name: string; harness: string; def: TypeDef & { blocks?: TypeBlocks | null }; defaultReviewer?: string; harnesses: string[]; inventoryTotal: number | null; onSaved: () => void
}) {
  const { machine } = useData()
  const [cat, setCat] = useState<Catalog | 'error' | null>(null)
  const [scope, setScope] = useState<SettingsScope | null>(null)
  const [saved, setSaved] = useState<Draft | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(false)
  useEffect(() => {
    let on = true
    api<SettingsReply>('GET', '/api/config/settings').then((s) => on && setScope(scopeOf(s, machine)), () => {})
    return () => { on = false }
  }, [machine])
  // The catalog says which mail rules the agent gets, which depends on the harness the page shows.
  useEffect(() => {
    let on = true
    api<Catalog>('GET', `/api/blocks/composing?type=${encodeURIComponent(name)}${harness ? `&harness=${encodeURIComponent(harness)}` : ''}`).then((c) => on && setCat(c), () => on && setCat((o) => o ?? 'error'))
    return () => { on = false }
  }, [name, harness])
  // The saved draft follows the registry's copy of the type: a save, or a change from elsewhere.
  const savedKey = JSON.stringify(def.blocks ?? null)
  useEffect(() => {
    if (!cat || cat === 'error') return
    const d = draftOf(def.blocks, cat)
    setSaved(d)
    setDraft((cur) => (cur && saved && !sameDraft(cur, saved) ? cur : d))
  }, [cat, savedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (cat === null || !saved || !draft) return cat === 'error' ? <p className="muted">The block list didn't load.</p> : <Loading className="muted" />
  if (cat === 'error') return <p className="muted">The block list didn't load.</p>
  const ro = readOnly('agentTypes', scope)
  const dirty = !sameDraft(draft, saved)
  const total = inventoryTotal == null ? null : totalFor(inventoryTotal, cat, saved, draft)
  const set = (d: Draft) => { setErr(''); setDraft(d) }
  const rep = new Map(cat.replacements.map((r) => [r.path, r]))
  const byId = new Map(cat.blocks.map((b) => [b.id, b]))
  const templates = [...new Set(cat.blocks.map((b) => b.template))]

  async function save() {
    if (!cat || cat === 'error' || !draft) return
    setBusy(true)
    setErr('')
    try {
      const body = { ...typePayload(def, defaultReviewer === name), blocks: blocksPayload(cat, draft) ?? null }
      if (writesToHome(scope)) {
        await homeApi(scope.homeWeb, scope.home, 'POST', `/api/types/${name}`, body)
        await api('POST', '/api/config/settings/sync').catch(() => {})
      } else await api('POST', `/api/types/${name}`, body)
      toast(`Saved the ${name} blocks`)
      setPreview(false)
      onSaved()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <section className="comp" aria-label={`Compose the ${name} blocks`}>
      <h3 className="comp-h">Blocks</h3>
      <p className="muted comp-lede">Switch a block off or swap it for another text, and set the order. Agents of {name} get the change after they restart.{ro ? ` Shared by all machines; change it on ${scope?.home}.` : ''}</p>
      {templates.map((t) => {
        const ids = draft.order.filter((id) => byId.get(id)?.template === t)
        const overridden = !byId.get(ids[0])?.rendered
        return (
          <div key={t} className="comp-group" data-template={t}>
            <h4>{TEMPLATE[t] ?? t}</h4>
            {overridden ? <p className="muted">A whole file replaces this template, so its blocks can't change per type.</p> : null}
            {!overridden && !byId.get(ids[0])?.applies ? <p className="muted">An agent with this model gets the other mail rules, so these blocks add nothing to the total.</p> : null}
            <ul className="comp-list">
              {ids.map((id, i) => {
                const b = byId.get(id)!
                const off = draft.off.includes(id)
                const to = draft.replace[id] ?? ''
                const r = rep.get(to)
                return (
                  <li key={id} className="comp-row" data-block={id} data-off={off || undefined}>
                    <label className="comp-switch">
                      <input type="checkbox" role="switch" checked={!off} disabled={ro || overridden} aria-label={`${b.title}: ${off ? 'off' : 'on'}`} onChange={(e) => set(setOff(draft, id, !e.target.checked))} />
                      <span className={off ? 'inv-title inv-struck' : 'inv-title'}>{b.title}</span>
                    </label>
                    <span className="badge" title={`about ${(r?.tokens ?? b.tokens)} tokens`}>{tok(off ? 0 : r?.tokens ?? b.tokens)}</span>
                    <span className="comp-move">
                      <button type="button" className="icon-btn" disabled={ro || overridden || i === 0} aria-label={`Move ${b.title} up`} title="Move up" onClick={() => set(moveBlock(draft, cat, id, -1))}><Icon name="arrow-up" size="xs" /></button>
                      <button type="button" className="icon-btn" disabled={ro || overridden || i === ids.length - 1} aria-label={`Move ${b.title} down`} title="Move down" onClick={() => set(moveBlock(draft, cat, id, 1))}><Icon name="arrow-down" size="xs" /></button>
                    </span>
                    <span className="inv-sum comp-sum">{b.summary}</span>
                    {cat.replacements.length && !off ? (
                      <label className="comp-rep">Text <select value={to} disabled={ro || overridden} onChange={(e) => set(setReplacement(draft, id, e.target.value))}>
                        <option value="">The global text</option>
                        {cat.replacements.map((x) => <option key={x.path} value={x.path}>{x.title} · {tok(x.tokens)}</option>)}
                        {to && !r ? <option value={to}>{to} (missing)</option> : null}
                      </select></label>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
      {preview ? <div className="comp-previews" aria-label="Preview as agent">{harnesses.map((h) => <Preview key={h} name={name} harness={h} own={h === def.harness} />)}</div> : null}
      <div className="comp-foot" role="group" aria-label="Token total and actions">
        <span className="comp-total"><b>{total == null ? '–' : total.toLocaleString('en-US')}</b> tokens<span className="comp-tail"> before the first turn{dirty && total != null && inventoryTotal != null ? <span className="muted"> (saved: {inventoryTotal.toLocaleString('en-US')})</span> : null}</span></span>
        {err ? <span className="comp-err" role="alert">{err}</span> : null}
        <span className="comp-actions">
          <button type="button" className="btn" aria-pressed={preview} aria-label="Preview as agent" disabled={dirty} title={dirty ? 'Save first: the preview shows the saved type.' : 'Preview as agent'} onClick={() => setPreview((p) => !p)}><Icon name="search" size="xs" /><span className="comp-lbl">Preview as agent</span></button>
          <button type="button" className="btn" disabled={!dirty || busy} onClick={() => set(saved)}>Discard</button>
          <button type="button" className="btn primary" disabled={!dirty || busy || ro} onClick={() => void save()}>Save</button>
        </span>
      </div>
    </section>
  )
}

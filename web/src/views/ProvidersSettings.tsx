// Settings › Model providers (S-2115): where stam's own model calls go, and the keys they use.
// OpenRouter is built in; an OpenAI-compatible server, Azure OpenAI or Bedrock is a provider config in
// settings.providers (shared by every machine), keyed by the id a model is prefixed with (`myazure:gpt-4o`).
// Keys live in this machine's secret store (src/secrets.ts), never in the settings: a provider names its
// key as `apiKey: {secret: NAME}`. The key field is write-only: it shows the last 4 characters at most,
// Replace writes a new value (PUT /api/secrets/NAME), and Test asks the provider whether it takes the
// stored key (POST /api/secrets/NAME/test). No route returns a value, so this page never holds one
// except while the human types it.
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { Icon } from '../Icon'
import { ModelPicker } from './ModelPicker'
import { Row, Seg } from './TypesSettings'

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
type Kind = 'openai-compatible' | 'azure' | 'bedrock'
export interface ProviderCfg {
  kind?: Kind | string
  baseUrl?: string
  endpoint?: string
  apiVersion?: string
  deployment?: string
  region?: string
  profile?: string
  apiKey?: { env?: string; secret?: string }
}
export interface SecretInfo {
  name: string
  provider: string
  slot: 'stam' | 'agent'
  env: string | null
  last4: string
  setAt: string
  test: { ok: boolean; at: string; detail?: string } | null
  overriddenBy: 'env' | null
}
// The store as the page knows it: its secrets, or why it can't be read (a broken secrets.json is a 409).
export type Store = { secrets: SecretInfo[] } | { broken: string } | { error: string } | null

const KINDS: { v: Kind; label: string }[] = [
  { v: 'openai-compatible', label: 'OpenAI-compatible' },
  { v: 'azure', label: 'Azure OpenAI' },
  { v: 'bedrock', label: 'Bedrock' },
]
// The fields each kind needs before the daemon uses it, as src/llm parses them.
const REQUIRED: Record<Kind, (keyof ProviderCfg)[]> = { 'openai-compatible': ['baseUrl'], azure: ['endpoint', 'apiVersion'], bedrock: ['region'] }
const LABELS: Partial<Record<keyof ProviderCfg, string>> = { baseUrl: 'Base URL', endpoint: 'Endpoint', apiVersion: 'API version', region: 'Region' }
export const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const OPENROUTER_ENV = 'OPENROUTER_API_KEY'

// The address fields of every kind: a kind switch drops them, so one kind's field is never read as another's.
const ADDRESS: (keyof ProviderCfg)[] = ['baseUrl', 'endpoint', 'apiVersion', 'deployment', 'region', 'profile']
// The secret a provider's key is stored as: the one its config names, else the provider id, which the
// store's name rule already accepts; when a secret of that name is one no card stored (another
// provider's, an agents' key, or one imported from opencode.env, which names its variable even under
// this provider), the first free `ID-N`, so a first key never replaces another's.
export function secretFor(id: string, cfg: ProviderCfg, secrets: SecretInfo[]): string {
  if (cfg.apiKey?.secret) return cfg.apiKey.secret
  const taken = (n: string) => secrets.some((x) => x.name === n && (x.provider !== id || !!x.env || x.slot === 'agent'))
  let name = id
  for (let n = 2; taken(name); n++) name = `${id}-${n}`
  return name
}
// The providers a step can name: complete, so the daemon registers them, and never `openrouter`,
// which is built in (a `providers.openrouter` entry is ignored).
export function usableProviders(providers: Record<string, ProviderCfg>): string[] {
  return Object.keys(providers).filter((id) => id !== 'openrouter' && !missing(providers[id]).length).sort()
}
export function missing(cfg: ProviderCfg): string[] {
  const need = REQUIRED[cfg.kind as Kind]
  if (!need) return ['a kind']
  return need.filter((f) => !String(cfg[f] ?? '').trim()).map((f) => LABELS[f] ?? f)
}

export function useSecrets(): [Store, () => void] {
  const [store, setStore] = useState<Store>(null)
  const load = useCallback(() => {
    api<{ secrets: SecretInfo[] }>('GET', '/api/secrets').then(
      (r) => setStore({ secrets: r.secrets }),
      (e: Error) => setStore(e instanceof ApiError && e.status === 409 ? { broken: e.message } : { error: e.message }),
    )
  }, [])
  useEffect(load, [load])
  return [store, load]
}

const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// One key: masked, with Replace (or Add key), Test and Delete. `env` is the variable the secret stands
// for, when it stands for one; `onLinked` runs after each save, so the provider config can name it.
export function KeyField({ name, provider, env, info, broken, label, onLinked, reload }: {
  name: string; provider: string; env?: string; info: SecretInfo | undefined; broken: boolean; label: string
  onLinked?: () => void; reload: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'delete'>('')
  const [err, setErr] = useState('')
  const [tested, setTested] = useState<{ ok: boolean; detail: string } | null>(null)
  const act = async (what: 'save' | 'test' | 'delete', fn: () => Promise<unknown>) => {
    setBusy(what)
    setErr('')
    try {
      await fn()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
      reload()
    }
  }
  const save = () => act('save', async () => {
    await api('PUT', `/api/secrets/${encodeURIComponent(name)}`, { value, provider, ...(env ? { env } : {}) })
    setValue('')
    setEditing(false)
    setTested(null)
    onLinked?.()
  })
  const test = () => act('test', async () => {
    const r = await api<{ ok: boolean; detail: string }>('POST', `/api/secrets/${encodeURIComponent(name)}/test`, { provider })
    setTested({ ok: r.ok, detail: r.detail })
  })
  const remove = () => act('delete', async () => {
    await api('DELETE', `/api/secrets/${encodeURIComponent(name)}`)
    setTested(null)
  })
  const last = tested ?? (info?.test ? { ok: info.test.ok, detail: info.test.detail ?? '' } : null)
  return (
    <div className="prov-key">
      <div className="prov-key-line">
        <span className="prov-key-mask" aria-label={`${label} key`}>{info ? <>••••{info.last4 ? <code>{info.last4}</code> : null}</> : <span className="muted">No key</span>}</span>
        {last ? <span className={`badge ${last.ok ? 'ok' : 'err'}`} title={last.detail}>{last.ok ? 'Works' : 'Refused'}</span> : null}
        {!editing ? (
          <span className="prov-key-acts">
            <button type="button" className="btn" disabled={broken || !!busy} onClick={() => { setEditing(true); setErr('') }}>{info ? 'Replace' : 'Add key'}</button>
            <button type="button" className="btn" disabled={broken || !info || !!busy} onClick={() => void test()}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
            {info ? <button type="button" className="btn danger" disabled={broken || !!busy} onClick={() => void remove()}><Icon name="trash-2" size="xs" />Delete key</button> : null}
          </span>
        ) : null}
      </div>
      {editing ? (
        <form className="prov-key-edit" onSubmit={(e) => { e.preventDefault(); if (value.trim()) void save() }}>
          <input type="password" aria-label={`New ${label} key`} value={value} placeholder="Paste the key" autoComplete="new-password" spellCheck={false} autoFocus onChange={(e) => setValue(e.target.value)} />
          <button type="submit" className="btn primary" disabled={!value.trim() || !!busy}>Save key</button>
          <button type="button" className="btn" disabled={!!busy} onClick={() => { setEditing(false); setValue('') }}>Cancel</button>
        </form>
      ) : null}
      {last && !last.ok && last.detail ? <p className="muted">{last.detail}</p> : null}
      {info?.test && !tested ? <p className="muted">Tested {when(info.test.at)}.</p> : null}
      {info?.overriddenBy === 'env' && info.env ? <p className="muted">On this machine the environment variable <code>{info.env}</code> overrides this key.</p> : null}
      {err ? <p className="sp-error" role="alert">{err}</p> : null}
    </div>
  )
}

// A text field that saves when it loses focus or on Enter.
function Field({ label, value, placeholder, disabled, title, onSave }: { label: string; value: string; placeholder?: string; disabled: boolean; title?: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const d = draft
    setDraft(null)
    if (d !== null && d.trim() !== value) onSave(d.trim())
  }
  return (
    <input type="text" className="wide" aria-label={label} value={draft ?? value} placeholder={placeholder} spellCheck={false} autoComplete="off" disabled={disabled} title={title}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
  )
}

function ProviderCard({ id, cfg, secret, info, broken, disabled, title, set, remove, reload }: {
  id: string; cfg: ProviderCfg; secret: string; info: SecretInfo | undefined; broken: boolean; disabled: boolean; title?: string
  set: (path: string, v: Json) => void; remove: () => void; reload: () => void
}) {
  const p = (f: string) => `providers.${id}.${f}`
  const kind = cfg.kind as Kind
  const gaps = missing(cfg)
  const switchKind = (v: Kind) => {
    if (disabled || v === kind) return
    const next: ProviderCfg = { ...cfg, kind: v }
    for (const f of ADDRESS) delete next[f]
    set(`providers.${id}`, next as Json)
  }
  const field = (f: keyof ProviderCfg, label: string, placeholder: string, help?: string) => (
    <Row label={label} help={help}><Field label={`${id} ${label}`} value={String(cfg[f] ?? '')} placeholder={placeholder} disabled={disabled} title={title} onSave={(v) => set(p(f), v || null)} /></Row>
  )
  return (
    <section className="set-card prov-card" aria-label={`Provider ${id}`}>
      <div className="prov-head">
        <b>{id}</b>
        <span className="muted">Models as <code>{id}:MODEL</code></span>
        <button type="button" className="btn danger" disabled={disabled} title={title} onClick={remove}><Icon name="trash-2" size="xs" />Remove</button>
      </div>
      {gaps.length ? <div className="set-note warn"><Icon name="triangle-alert" size="xs" /><span>Not used until it has {gaps.join(' and ')}.</span></div> : null}
      <Row label="Kind"><Seg value={kind} opts={KINDS} onPick={switchKind} /></Row>
      {kind === 'openai-compatible' ? field('baseUrl', 'Base URL', 'https://api.openai.com/v1', 'Up to and including the version path. A local Ollama is http://localhost:11434/v1.') : null}
      {kind === 'azure' ? <>
        {field('endpoint', 'Endpoint', 'https://RESOURCE.openai.azure.com')}
        {field('apiVersion', 'API version', '2024-10-21', 'v1 uses the version-less API.')}
        {field('deployment', 'Deployment', 'Optional', 'Empty: the model name is the deployment.')}
      </> : null}
      {kind === 'bedrock' ? <>
        {field('region', 'Region', 'us-east-1')}
        {field('endpoint', 'Endpoint', 'Optional', 'An https origin, for a VPC endpoint. Empty: the region’s own.')}
        {field('profile', 'AWS profile', 'Optional', 'Read only this profile’s keys. Empty: the environment, then AWS_PROFILE or default, then the instance role.')}
      </> : null}
      <Row label="Key" help={kind === 'bedrock' && !cfg.apiKey?.env && !cfg.apiKey?.secret
        ? <>None: calls are signed with this machine’s AWS credentials. A Bedrock API key added here is used instead, stored as <code>{secret}</code>.</>
        : cfg.apiKey?.env && !cfg.apiKey.secret
        ? <>Read from the environment variable <code>{cfg.apiKey.env}</code> on each machine.</>
        : <>Stored on this machine as <code>{secret}</code>. Each machine keeps its own.</>}>
        <KeyField name={secret} provider={id} info={info} broken={broken} label={id} reload={reload}
          onLinked={() => { if (!disabled && cfg.apiKey?.secret !== secret) set(p('apiKey'), { ...(cfg.apiKey ?? {}), secret }) }} />
      </Row>
    </section>
  )
}

function AddProvider({ taken, names, disabled, title, add }: { taken: string[]; names: string[]; disabled: boolean; title?: string; add: (id: string, kind: Kind) => void }) {
  const [id, setId] = useState('')
  const [kind, setKind] = useState<Kind>('openai-compatible')
  const clean = id.trim()
  const why = !clean ? '' : !PROVIDER_ID.test(clean) ? 'Lower-case letters, digits, dash and underscore, starting with a letter or digit.' : clean === 'openrouter' || taken.includes(clean) ? `There is a provider ${clean} already.`
    : names.includes(clean) ? `A key named ${clean} is stored already, for another use; pick another id.` : ''
  return (
    <form className="set-card prov-add" onSubmit={(e) => { e.preventDefault(); if (clean && !why) { add(clean, kind); setId('') } }}>
      <Row label="Id" help="Models from it are named ID:MODEL."><input type="text" aria-label="New provider id" value={id} placeholder="myazure" spellCheck={false} autoComplete="off" disabled={disabled} title={title} onChange={(e) => setId(e.target.value)} /></Row>
      <Row label="Kind"><Seg value={kind} opts={KINDS} onPick={setKind} /></Row>
      {why ? <p className="sp-error" role="alert">{why}</p> : null}
      <div className="row-actions"><button type="submit" className="btn primary" disabled={disabled || !clean || !!why} title={title}><Icon name="plus" size="xs" />Add provider</button></div>
    </form>
  )
}

export function ProvidersSettings({ s, disabled = false, why, set, store: given, reload: givenReload }: {
  s: unknown; disabled?: boolean; why?: string; set: (path: string, v: Json) => void
  // For stories and tests: a fixed store instead of the daemon's.
  store?: Store; reload?: () => void
}) {
  const [own, ownReload] = useSecrets()
  const store = given !== undefined ? given : own
  const reload = givenReload ?? ownReload
  const providers = ((s as { providers?: Record<string, ProviderCfg> } | null)?.providers ?? {}) as Record<string, ProviderCfg>
  const title = disabled ? why : undefined
  const secrets = store && 'secrets' in store ? store.secrets : []
  const broken = !!store && 'broken' in store
  const byName = (n: string) => secrets.find((x) => x.name === n)
  const orKey = secrets.filter((x) => x.env === OPENROUTER_ENV && x.slot === 'stam').sort((a, b) => a.name.localeCompare(b.name))[0]
  // A `providers.openrouter` entry is ignored: OpenRouter is built in, and its key is the one above.
  const ids = Object.keys(providers).filter((id) => id !== 'openrouter').sort()
  const names = secrets.map((x) => x.name)
  const remove = (id: string) => {
    const next = { ...providers }
    delete next[id]
    set('providers', next as Json)
  }
  return (
    <>
      <p className="lede">Where mootr’s own model calls go: the tiny models and the decision checks, not your agents. OpenRouter is built in; add an OpenAI-compatible server, Azure OpenAI or Bedrock, then pick it for a step under Tiny models.</p>
      <p className="muted">Keys stay on this machine, in its secret store, and are never shown again once saved. Keys in <code>opencode.env</code> were copied in once; a key added to that file later is ignored, so enter it here.</p>
      {broken ? (
        <div className="set-note warn" role="alert"><Icon name="triangle-alert" size="xs" /><span>This machine’s secret store, <code>secrets.json</code>, can’t be read: {(store as { broken: string }).broken}. Until it is fixed, mootr uses the keys in <code>opencode.env</code> and the environment, so a key you deleted can be in use again, and no key can be changed here.</span></div>
      ) : null}
      {store && 'error' in store ? <p className="sp-error" role="alert">{store.error}</p> : null}
      {store === null ? <p className="muted">Loading…</p> : null}
      <h3>OpenRouter</h3>
      <div className="set-card prov-card" aria-label="Provider openrouter">
        <Row label="Key" help={<>Built in. Models with no provider prefix use it. Stored on this machine as <code>{orKey?.name ?? 'openrouter'}</code>.</>}>
          <KeyField name={orKey?.name ?? 'openrouter'} provider="openrouter" env={OPENROUTER_ENV} info={orKey} broken={broken} label="OpenRouter" reload={reload} />
        </Row>
      </div>
      {'openrouter' in providers ? (
        <div className="set-note warn prov-ignored"><Icon name="triangle-alert" size="xs" /><span>Settings has a provider entry named <code>openrouter</code>. It is ignored: OpenRouter is built in and uses the key above.</span>
          <button type="button" className="btn danger" disabled={disabled} title={title} onClick={() => remove('openrouter')}><Icon name="trash-2" size="xs" />Remove</button></div>
      ) : null}
      {ids.length ? <h3>Your providers</h3> : null}
      {ids.map((id) => {
        const secret = secretFor(id, providers[id], secrets)
        return <ProviderCard key={id} id={id} cfg={providers[id]} secret={secret} info={byName(secret)} broken={broken} disabled={disabled} title={title} set={set} remove={() => remove(id)} reload={reload} />
      })}
      <h3>Add a provider</h3>
      <AddProvider taken={ids} names={names} disabled={disabled} title={title} add={(id, kind) => set(`providers.${id}`, kind === 'bedrock' ? { kind } : { kind, apiKey: { secret: id } })} />
    </>
  )
}

// A step's model as `provider:model` (S-2115): the provider's id before the first colon when it is a
// configured provider, else OpenRouter takes the whole string, as the daemon's parseModelRef does
// (OpenRouter ids such as `meta-llama/llama-3:free` contain colons).
export function splitModelRef(value: string, ids: string[]): { provider: string; model: string } {
  const i = value.indexOf(':')
  if (i > 0 && ids.includes(value.slice(0, i))) return { provider: value.slice(0, i), model: value.slice(i + 1) }
  return { provider: 'openrouter', model: value }
}
export const joinModelRef = (provider: string, model: string) => (provider === 'openrouter' || !model ? model : `${provider}:${model}`)

// A tiny-model step's provider and model. With no configured provider it is the OpenRouter picker alone,
// as before. Switching provider keeps the model text, and writes nothing while the model is empty.
export function ProviderModelPicker({ ids, value, label, placeholder, disabled, title, onChange }: {
  ids: string[]; value: string; label: string; placeholder?: string; disabled?: boolean; title?: string; onChange: (v: string) => void
}) {
  const cur = splitModelRef(value, ids)
  const [provider, setProvider] = useState(cur.provider)
  useEffect(() => setProvider(cur.provider), [cur.provider])
  const picker = provider === 'openrouter'
    ? <ModelPicker kind="openrouter" value={cur.model} placeholder={placeholder} label={label} disabled={disabled} title={title} onChange={(m) => onChange(joinModelRef('openrouter', m))} />
    : <Field label={label} value={cur.model} placeholder="Model or deployment" disabled={!!disabled} title={title} onSave={(m) => onChange(joinModelRef(provider, m))} />
  if (!ids.length) return picker
  return (
    <span className="prov-model">
      <select aria-label={`${label} provider`} value={provider} disabled={disabled} title={title}
        onChange={(e) => { const p = e.target.value; setProvider(p); if (cur.model) onChange(joinModelRef(p, cur.model)) }}>
        <option value="openrouter">OpenRouter</option>
        {ids.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
      {picker}
    </span>
  )
}

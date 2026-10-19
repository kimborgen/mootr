// The Inventory (S-879, stage 1 of S-868): everything one agent, or one agent type on one harness,
// receives, as layers of blocks. Each block shows a title, its size in tokens, a two-line summary
// and where it came from; tap to read its full text. Read-only. A summary a model is still writing
// reads "summary pending", and the view asks again until none is.
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Glyph } from '../Glyph'
import { Icon } from '../Icon'
import { byId } from '../store'
import { Loading } from '../Loading'

export interface InvBlock {
  id: string
  title: string
  headingPath: string[]
  tokens: number
  hash: string
  format: 'markdown' | 'text' | 'json'
  text: string
  summary?: string
  summaryState: 'auto' | 'pending' | 'off' | 'failed' | 'source'
  // Per-type composition: set on the entries the system prompt adds for a type's off/replace blocks.
  state?: 'off' | 'replaced' | 'replaces'
  by?: string
}
export interface InvLayer { key: string; label: string; source: string; path?: string; origin?: string; tokens: number; blocks: InvBlock[] }
export interface InvFlag { kind: string; message: string; layer?: string }
export interface Inv {
  agent?: { id: string; name: string; type: string | null; harness: string; model: string | null }
  type?: string
  harness: string
  totalTokens: number
  layers: InvLayer[]
  flags: InvFlag[]
}
type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; inv: Inv; gaveUp: boolean }

// How long to wait before asking again while a summary is pending.
export const POLL_MS = 3000
// Stop asking after this long, whatever is still pending (a summary that never comes).
export const POLL_MAX_MS = 120_000
const SOURCE: Record<string, string> = { stam: 'mootr', 'stam-generated': 'mootr · generated', repo: 'repo', 'user-global': 'user-global', skill: 'skill', mcp: 'MCP' }
const md = (text: string) => DOMPurify.sanitize(marked.parse(text) as string)
const tok = (n: number) => `${n.toLocaleString('en-US')} tok`
const pending = (inv: Inv) => inv.layers.some((l) => l.blocks.some((b) => b.summaryState === 'pending'))

export function useInventory(url: string): { loaded: Loaded; refresh: () => void } {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [round, setRound] = useState(0)
  useEffect(() => {
    let on = true
    const until = Date.now() + POLL_MAX_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      api<Inv>('GET', url).then(
        (inv) => {
          if (!on) return
          const more = pending(inv) && Date.now() < until
          setLoaded({ state: 'ok', inv, gaveUp: pending(inv) && !more })
          if (more) timer = setTimeout(load, POLL_MS)
        },
        (e) => on && setLoaded({ state: 'error', message: (e as Error).message }),
      )
    }
    setLoaded((l) => (round && l.state === 'ok' ? l : { state: 'loading' }))
    if (url) load()
    return () => { on = false; clearTimeout(timer) }
  }, [url, round])
  return { loaded, refresh: () => setRound((r) => r + 1) }
}

function Summary({ b, gaveUp }: { b: InvBlock; gaveUp?: boolean }) {
  if (b.summary) return <span className="inv-sum">{b.summary}</span>
  if (b.summaryState === 'pending') return <span className="inv-sum muted">{gaveUp ? 'Summary not ready yet' : 'Summary pending…'}</span>
  if (b.summaryState === 'failed') return <span className="inv-sum muted">Summary failed</span>
  return <span className="inv-sum muted">No summary: summaries are off</span>
}

// Composition state in words and a glyph, never colour alone; off and replaced blocks are struck through.
const STATE_CHIP = {
  off: (by?: string) => `⊘ Switched off by ${by ?? 'its type'}`,
  replaced: (by?: string) => `⊘ Replaced by ${by ?? 'its type'}`,
  replaces: (by?: string) => `⇄ Replaces global (${by ?? 'its type'})`,
} as const

function Card({ b, gaveUp }: { b: InvBlock; gaveUp?: boolean }) {
  const [open, setOpen] = useState(false)
  const path = b.headingPath.slice(0, -1).join(' › ')
  return (
    <details className="fold inv-card" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="inv-head">
          <Icon name="chevron-right" size="xs" />
          <span className={b.state === 'off' || b.state === 'replaced' ? 'inv-title inv-struck' : 'inv-title'}>{b.title}</span>
          <span className="badge" title={`about ${b.tokens} tokens`}>{tok(b.tokens)}</span>
        </span>
        <Summary b={b} gaveUp={gaveUp} />
        <span className="inv-chips">
          {b.state ? <span className="chip">{STATE_CHIP[b.state](b.by)}</span> : null}
          {path ? <span className="chip">{path}</span> : null}
          {b.summaryState === 'auto' ? <span className="chip" title="Written by a model; the text is the source of truth">auto</span> : null}
          {b.summaryState === 'source' ? <span className="chip" title="The tool's own description">tool description</span> : null}
        </span>
      </summary>
      {open ? (b.format === 'markdown'
        ? <div className="md inst-text" dangerouslySetInnerHTML={{ __html: md(b.text) }} />
        : <pre className={`code${b.format === 'json' ? ' mono' : ''}`}>{b.text}</pre>) : null}
    </details>
  )
}

function Layer({ l, gaveUp }: { l: InvLayer; gaveUp?: boolean }) {
  return (
    <details className="fold inv-layer" open={l.key !== 'mcp-tools'}>
      <summary>
        <span className="inv-head">
          <Icon name="chevron-right" size="xs" />
          <h3 className="inv-title">{l.label}</h3>
          <span className="chip">{SOURCE[l.source] ?? l.source}</span>
          <span className="badge">{tok(l.tokens)}</span>
        </span>
        {l.path ? <span className="inst-path mono" title={l.path}>{l.path}</span> : null}
      </summary>
      {l.blocks.length ? l.blocks.map((b) => <Card key={b.id} b={b} gaveUp={gaveUp} />) : <p className="muted">Empty.</p>}
    </details>
  )
}

export function InventoryBody({ inv, gaveUp, onRefresh }: { inv: Inv; gaveUp?: boolean; onRefresh?: () => void }) {
  const share = (n: number) => `${Math.max(1, Math.round((100 * n) / Math.max(inv.totalTokens, 1)))}%`
  return (
    <>
      {gaveUp && onRefresh ? (
        <div className="actions-row inv-stale">
          <span className="muted">Some summaries aren't ready yet.</span>
          <button className="btn" onClick={onRefresh}><Icon name="rotate-ccw" />Refresh</button>
        </div>
      ) : null}
      <div className="inv-total"><b>{inv.totalTokens.toLocaleString('en-US')}</b> tokens before the first turn, estimated (characters ÷ 4). The harness's own built-in prompt isn't counted.</div>
      <ul className="inv-sizes">
        {inv.layers.map((l) => (
          <li key={l.key} className={l.key === 'mcp-tools' ? 'mcp' : ''}>
            <span className="inv-size-name">{l.label}</span>
            <span className="inv-bar" aria-hidden="true"><span style={{ width: share(l.tokens) }} /></span>
            <span className="inst-size">{l.tokens.toLocaleString('en-US')}</span>
          </li>
        ))}
      </ul>
      <h3 className="inv-flags-h">Flags</h3>
      {inv.flags.length
        ? <ul className="inv-flags">{inv.flags.map((f, i) => <li key={i}><span className="badge warn">{f.kind}</span> {f.message}</li>)}</ul>
        : <p className="muted">Nothing to flag.</p>}
      {inv.layers.map((l) => <Layer key={l.key} l={l} gaveUp={gaveUp} />)}
    </>
  )
}

// One agent's inventory: the `inventory:ID` tab.
export function InventoryView({ id }: { id: string }) {
  const a = byId(id)
  const { loaded, refresh } = useInventory(`/api/agents/${id}/inventory`)
  if (!a) return <div className="details pad"><div className="empty-pane"><p>This agent is gone.</p></div></div>
  return (
    <div className="details pad instructions inventory">
      <h2><Glyph agent={a} />{a.name} · inventory</h2>
      <div className="sub">Everything {a.name} receives, in the order it arrives. Read-only; changes reach it after a restart.</div>
      {loaded.state === 'loading' ? <Loading className="muted" />
        : loaded.state === 'error' ? <p className="muted">{loaded.message}</p>
        : <InventoryBody inv={loaded.inv} gaveUp={loaded.gaveUp} onRefresh={refresh} />}
    </div>
  )
}

// The inventory of an agent type on a harness: the `inventory` tab, with a type and a harness picker.
export function TypeInventoryView() {
  const [reg, setReg] = useState<{ types: string[]; harnesses: string[]; harnessOf: Record<string, string> } | null>(null)
  const [type, setType] = useState('')
  const [harness, setHarness] = useState('')
  useEffect(() => {
    let on = true
    api<{ types?: Record<string, { harness?: string }>; harnesses?: Record<string, unknown> }>('GET', '/api/registry').then((r) => {
      if (!on) return
      const types = Object.keys(r.types ?? {})
      setReg({ types, harnesses: Object.keys(r.harnesses ?? {}), harnessOf: Object.fromEntries(types.map((t) => [t, r.types?.[t]?.harness ?? ''])) })
      setType((t) => t || types[0] || '')
    }, () => on && setReg({ types: [], harnesses: [], harnessOf: {} }))
    return () => { on = false }
  }, [])
  const { loaded, refresh } = useInventory(type ? `/api/types/${type}/inventory${harness ? `?harness=${encodeURIComponent(harness)}` : ''}` : '')
  return (
    <div className="details pad instructions inventory">
      <h2><Icon name="layers" />Inventory by type</h2>
      <div className="sub">Everything an agent of a type receives on a harness, before it has a task. Read-only.</div>
      <div className="actions-row inv-pick">
        <label>Type <select value={type} onChange={(e) => setType(e.target.value)}>{(reg?.types ?? []).map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Harness <select value={harness} onChange={(e) => setHarness(e.target.value)}>
          <option value="">{type && reg?.harnessOf[type] ? `${reg.harnessOf[type]} (the type's own)` : "The type's own"}</option>
          {(reg?.harnesses ?? []).map((h) => <option key={h} value={h}>{h}</option>)}
        </select></label>
      </div>
      {!reg || (type && loaded.state === 'loading') ? <Loading className="muted" />
        : !type ? <p className="muted">No agent types.</p>
        : loaded.state === 'error' ? <p className="muted">{loaded.message}</p>
        : loaded.state === 'ok' ? <InventoryBody inv={loaded.inv} gaveUp={loaded.gaveUp} onRefresh={refresh} /> : null}
    </div>
  )
}

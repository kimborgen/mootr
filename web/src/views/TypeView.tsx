// The type page (S-887, stage 2 of S-868): one agent type in its own world, `w:type:NAME` (view key
// `type:NAME`). A header (description, preset) and five tabs:
//  - Instructions: the composer (S-892) to switch blocks off, swap or reorder them, then the type's
//    composed blocks as the Inventory's cards, per harness it can run on.
//  - Skills (S-891): attach skills to the type; its agents get a "Skills available" block in their prompt.
//  - Memory (S-888): the retro items its agents reported or that target the type, open and done,
//    ranked as the Retros page ranks them (`GET /api/retros?type=NAME`). The type's curated notes
//    block, "Before you start", shows with the other blocks under Instructions.
//  - Agents: its standing specialists with their load (S-919), then its live and recent agents, with the median cost and time over its closed ITSAs
//    (`GET /api/activity?by=type`).
//  - Proposals: retro-loop `proposal` ITSAs that touch the type, matched by `proposalTouches`.
import { useEffect, useState } from 'react'
import { api } from '../api'
import { selectAgent, openWorld } from '../actions'
import { Glyph } from '../Glyph'
import { Icon } from '../Icon'
import { HARNESS, ago, live, model, money, stateLabel } from '../format'
import { openItsa, StatusGlyph, statusLabel } from '../itsa/itsa'
import { useData } from '../store'
import type { Agent, Itsa, RetrosView } from '../types'
import { InventoryBody, useInventory } from './InventoryView'
import { TypeComposer } from './TypeComposer'
import { TypeSkills } from './TypeSkills'
import type { TypeBlocks } from './type-compose'
import { Loading } from '../Loading'

interface TypeDef { description?: string; harness?: string; model?: string | null; effort?: string | null; brief?: string | null; review?: { ring?: unknown } | null; blocks?: TypeBlocks | null; skills?: string[] | null }
interface Reg { types?: Record<string, TypeDef>; harnesses?: Record<string, unknown>; defaultReviewer?: string }
interface Spread { n: number; median: number | null; p75: number | null }
interface ActivityRow { type: string; n: number; working_s: Spread; waiting_s: Spread; cost_usd: Spread; review_rounds: Spread }
type Tab = 'instructions' | 'skills' | 'memory' | 'agents' | 'proposals'
const TABS: { id: Tab; label: string }[] = [{ id: 'instructions', label: 'Instructions' }, { id: 'skills', label: 'Skills' }, { id: 'memory', label: 'Memory' }, { id: 'agents', label: 'Agents' }, { id: 'proposals', label: 'Proposals' }]
// How many agents of the type the Agents tab lists: every live one, then the most recent others.
export const RECENT_AGENTS = 12

// Whether a retro-loop proposal touches the type: its title, summary or body names the type's
// template file `type-NAME` (the retro steward targets templates by that name), as a whole word so
// `dev` doesn't match `type-developer`. Block-level matching waits for the steward to target block ids.
export function proposalTouches(x: Pick<Itsa, 'kind' | 'title' | 'summary' | 'body'>, type: string): boolean {
  if (x.kind !== 'proposal') return false
  const esc = type.replace(/[^a-z0-9-]/gi, '\\$&')
  return new RegExp(`(^|[^a-z0-9-])type-${esc}(?![a-z0-9-])`, 'i').test(`${x.title}\n${x.summary ?? ''}\n${x.body ?? ''}`)
}

// The agents the Agents tab lists: live ones first, then the most recently changed, capped.
export function agentsOfType(agents: Agent[], type: string): Agent[] {
  const mine = agents.filter((a) => a.type === type)
  const up = (a: Agent, b: Agent) => b.updated_at.localeCompare(a.updated_at)
  return [...mine.filter(live).sort(up), ...mine.filter((a) => !live(a)).sort(up).slice(0, RECENT_AGENTS)]
}

// The type's standing agents that are still around (not archived), most recently changed first.
export function specialistsOf(agents: Agent[], type: string): Agent[] {
  return agents.filter((a) => a.type === type && a.standing && a.lifecycle !== 'archived').sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export const bytes = (n: number | null | undefined, capped?: boolean) => {
  if (n == null) return '–'
  const v = n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
  return capped ? `${v}+` : v
}

const dur = (s: number | null | undefined) => (s == null ? '–' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`)

function Instructions({ name, harnesses, own, def, defaultReviewer, onSaved }: { name: string; harnesses: string[]; own: string; def: TypeDef; defaultReviewer?: string; onSaved: () => void }) {
  const [harness, setHarness] = useState('')
  const { loaded, refresh } = useInventory(`/api/types/${encodeURIComponent(name)}/inventory${harness ? `?harness=${encodeURIComponent(harness)}` : ''}`)
  return (
    <>
      {def.review?.ring ? null : (
        <TypeComposer name={name} def={def as never} defaultReviewer={defaultReviewer} harnesses={harnesses} harness={harness} inventoryTotal={loaded.state === 'ok' ? loaded.inv.totalTokens : null} onSaved={() => { refresh(); onSaved() }} />
      )}
      <div className="actions-row inv-pick">
        <label>Harness <select value={harness} onChange={(e) => setHarness(e.target.value)}>
          <option value="">{own ? `${HARNESS[own] ?? own} (the type's own)` : "The type's own"}</option>
          {harnesses.filter((h) => h !== own).map((h) => <option key={h} value={h}>{HARNESS[h] ?? h}</option>)}
        </select></label>
      </div>
      {loaded.state === 'loading' ? <Loading className="muted" />
        : loaded.state === 'error' ? <p className="muted">{loaded.message}</p>
        : <InventoryBody inv={loaded.inv} gaveUp={loaded.gaveUp} onRefresh={refresh} />}
    </>
  )
}

function Memory({ name }: { name: string }) {
  const { mailTick } = useData()
  const [data, setData] = useState<RetrosView | 'error' | null>(null)
  useEffect(() => {
    let on = true
    api<RetrosView>('GET', `/api/retros?type=${encodeURIComponent(name)}`).then((r) => on && setData(r), () => on && setData('error'))
    return () => { on = false }
  }, [name, mailTick])
  if (data === 'error') return <p className="muted">The retro items didn't load.</p>
  if (!data) return <Loading className="muted" />
  return data.items.length ? (
    <div className="retro-items" data-type-memory>
      {data.items.map((x) => (
        <button type="button" key={x.id} className="retro-row" data-itsa={x.key} onClick={() => openItsa(x.id)} title={`${x.key} · ${x.title}`}>
          <span className="ikey">{x.key}</span><span className="ititle">{x.title}</span>
          <span className="chip kind">{x.kind}</span><span className="chip">{statusLabel(x.status)}</span>
          {x.target && x.target !== 'none' ? <code>{x.target}</code> : null}{x.plusOnes > 0 ? <span className="plus">+{x.plusOnes}</span> : null}
        </button>
      ))}
    </div>
  ) : <p className="muted">No retro item is open or done for this type yet. Items its agents file, or aimed at <code>type-{name}</code> or one of its blocks, show here.</p>
}

function Agents({ name }: { name: string }) {
  const { agents, loaded } = useData()
  const [rows, setRows] = useState<ActivityRow[] | 'error' | null>(null)
  useEffect(() => {
    let on = true
    api<{ rows: ActivityRow[] }>('GET', '/api/activity?by=type').then((r) => on && setRows(r.rows), () => on && setRows('error'))
    return () => { on = false }
  }, [])
  const row = Array.isArray(rows) ? rows.find((r) => r.type === name) : undefined
  const list = agentsOfType(agents, name)
  const specialists = specialistsOf(agents, name)
  return (
    <>
      {rows === 'error' ? <p className="muted">The cost and time figures didn't load.</p>
        : row ? <dl className="type-stats">
          <div><dt>Closed ITSAs</dt><dd>{row.n}</dd></div>
          <div><dt>Median cost</dt><dd>{row.cost_usd.median == null ? '–' : money(row.cost_usd.median)}</dd></div>
          <div><dt>Median working</dt><dd>{dur(row.working_s.median)}</dd></div>
          <div><dt>Median waiting</dt><dd>{dur(row.waiting_s.median)}</dd></div>
        </dl>
        : rows ? <p className="muted">No closed ITSA is attributed to this type yet, so there are no medians.</p> : null}
      {specialists.length ? <>
        <h3>Specialists</h3>
        <ul className="type-agents" data-specialists>
          {specialists.map((a) => {
            const l = a.load
            return (
              <li key={a.id}>
                <button type="button" className="type-agent type-specialist" data-agent={a.id} onClick={() => selectAgent(a.id)}>
                  <Glyph agent={a} /><b>{a.name}</b>
                  <span className="chip">{stateLabel(a)}</span>
                  {l ? <span className="meta">
                    <span data-load="open">{l.open_itsas} open</span> · <span data-load="lead">lead {dur(l.median_lead_s)}{l.lead_n ? ` of ${l.lead_n}` : ''}</span> · <span data-load="context">context {l.context_ratio == null ? '–' : `${Math.round(l.context_ratio * 100)}%`}</span> · <span data-load="workspace">workspace {bytes(l.workspace_bytes, l.workspace_capped)}{l.workspace_files != null ? `, ${l.workspace_files} files` : ''}</span>
                  </span> : <span className="meta">no load numbers</span>}
                </button>
              </li>
            )
          })}
        </ul>
        <h3>All agents</h3>
      </> : null}
      {list.length ? <ul className="type-agents">
        {list.map((a) => (
          <li key={a.id}>
            <button type="button" className="type-agent" data-agent={a.id} onClick={() => selectAgent(a.id)}>
              <Glyph agent={a} /><b>{a.name}</b>
              <span className="chip">{stateLabel(a)}</span>
              <span className="meta">{model(a).label}{a.cost_usd ? ` · ${money(a.cost_usd)}` : ''} · {ago(a.updated_at)}</span>
            </button>
          </li>
        ))}
      </ul> : loaded.agents ? <p className="muted">No agent of this type yet.</p> : <Loading className="muted" />}
    </>
  )
}

function Proposals({ name }: { name: string }) {
  const { itsas } = useData()
  const list = itsas.filter((x) => proposalTouches(x, name)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return list.length ? (
    <ul className="type-agents">
      {list.map((x) => (
        <li key={x.id}>
          <button type="button" className="type-agent" data-itsa={x.key} onClick={() => openItsa(x.id)}>
            <StatusGlyph status={x.status} /><b>{x.key}</b><span className="type-title">{x.title}</span>
            <span className="chip">{statusLabel(x.status)}</span>
            <span className="meta">{ago(x.updated_at)}</span>
          </button>
        </li>
      ))}
    </ul>
  ) : <p className="muted">No proposal names this type. A proposal shows here when its title, summary or body mentions <code>type-{name}</code>.</p>
}

export function TypeView({ name }: { name: string }) {
  const [tab, setTab] = useState<Tab>('instructions')
  const [reg, setReg] = useState<Reg | null | 'error'>(null)
  const [rev, setRev] = useState(0)
  useEffect(() => {
    let on = true
    api<Reg>('GET', '/api/registry').then((r) => on && setReg(r), () => on && setReg('error'))
    return () => { on = false }
  }, [rev])
  const t = reg && reg !== 'error' ? reg.types?.[name] : undefined
  const harnesses = reg && reg !== 'error' ? Object.keys(reg.harnesses ?? {}) : []
  return (
    <div className="details pad instructions inventory type-page">
      <h2><Icon name="layers" />{name}</h2>
      {reg === null ? <Loading className="muted" />
        : reg === 'error' ? <p className="muted">The registry didn't load.</p>
        : !t ? <p className="muted">There is no agent type named {name}.</p>
        : <>
          {t.description ? <div className="sub">{t.description}</div> : null}
          <div className="type-preset">
            {t.harness ? <span className="chip">{HARNESS[t.harness] ?? t.harness}</span> : <span className="chip">Ring</span>}
            {t.model ? <span className="chip">{model({ model: t.model, harness: t.harness }).label}</span> : null}
            {t.effort ? <span className="chip">effort {t.effort}</span> : null}
            <button type="button" className="btn" onClick={() => { try { localStorage.setItem('stam/settings-section', 'types') } catch {} openWorld('config') }}><Icon name="settings" />Edit in Settings</button>
          </div>
          <div className="usage-tabs" role="tablist" aria-label={`${name} type`}>
            {TABS.map((x) => <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)}>{x.label}</button>)}
          </div>
          {tab === 'instructions' ? <Instructions name={name} harnesses={harnesses} own={t.harness ?? ''} def={t} defaultReviewer={reg.defaultReviewer} onSaved={() => setRev((n) => n + 1)} />
            : tab === 'skills' ? <TypeSkills name={name} def={t as never} defaultReviewer={reg.defaultReviewer} onSaved={() => setRev((n) => n + 1)} />
            : tab === 'memory' ? <Memory name={name} />
            : tab === 'agents' ? <Agents name={name} />
            : <Proposals name={name} />}
        </>}
    </div>
  )
}

// Settings › Agent types: the saved roles a manager spawns by name (src/agent-types.ts).
// A list of the types, each opening a form for its preset, defaults, and brief; its
// instructions are edited under Instructions, where the form links. Saving writes the
// user's registry.json through /api/types; removing a shipped type hides it.
import { useState, type ReactNode } from 'react'
import { api } from '../api'
import { Icon } from '../Icon'
import { HARNESS, model } from '../format'
import { toast } from '../ui/menu'
import type { Agent } from '../types'
import { RING_FORMATS, moveMember, patchRing, setReviewer, setReviewsAs, targetOf, typePayload, type TypeDef } from './type-form'

// A reviewer type (S-412) has `review`: its fallback reviewer type, and a ring of other types when it has one.
export type AgentType = TypeDef
interface Registry {
  defaultReviewer?: string
  harnesses: Record<string, { efforts?: string[] }>
  models: Record<string, { harnesses?: string[] }>
  types?: Record<string, AgentType>
}

const NOTICES = [{ v: null, label: 'Default' }, { v: 'turn', label: 'Every turn' }, { v: 'tree-idle', label: 'Tree idle' }, { v: 'none', label: 'None' }]
const REACH = [{ v: null, label: 'Default' }, { v: 'all', label: 'Everyone' }, { v: 'tree', label: 'Its tree' }, { v: 'parent', label: 'Its parents' }]
const PLACEHOLDERS = ['task', 'parent', 'name', 'type', 'cwd', 'branch']

export function Row({ label, help, children, cls = '' }: { label: ReactNode; help?: ReactNode; children: ReactNode; cls?: string }) {
  return <div className={`set-row ${cls}`}><div className="set-label"><b>{label}</b>{help ? <p>{help}</p> : null}</div><div className="set-ctl">{children}</div></div>
}
export function Seg<T>({ value, opts, onPick }: { value: T; opts: { v: T; label?: string; html?: ReactNode }[]; onPick: (v: T) => void }) {
  return <div className="seg">{opts.map((o) => <button type="button" key={String(o.v)} className={o.v === value ? 'on' : ''} onClick={() => onPick(o.v)}>{o.html ?? o.label}</button>)}</div>
}
export const hico = (h: string) => <span className="hico" style={{ color: `var(--h-${h})` }}><Icon name={h in HARNESS ? h : 'bot'} /></span>

// A read-only form: a fieldset disables every control in it. Otherwise no wrapper, so the text keeps its ink.
function Ro({ off, why, children }: { off: boolean; why?: string; children: ReactNode }) {
  return off ? <fieldset className="ro" disabled title={why}>{children}</fieldset> : <>{children}</>
}

// How a type is saved: through this daemon, or on a peer through the settings home (S-414).
type Write = (method: string, path: string, body?: unknown) => Promise<unknown>

// `readOnly`: a peer without the home's page (S-405) lists the types and opens them to view, but changes nothing.
export function TypesSettings({ reg, agents, onChanged, openInstructions, openType, write = api, readOnly = false, why }: {
  reg: Registry; agents: Agent[]; onChanged: () => Promise<void>; openInstructions: (type: string) => void; openType?: (type: string) => void; write?: Write; readOnly?: boolean; why?: string
}) {
  // The type being edited: its name, or '' for a new one; null shows the list.
  const [editing, setEditing] = useState<string | null>(null)
  const types = Object.entries(reg.types ?? {})
  if (editing !== null) return <TypeForm key={editing} name={editing} reg={reg} write={write} readOnly={readOnly} why={why} onDone={async (changed) => { if (changed) await onChanged(); setEditing(null) }} openInstructions={openInstructions} openType={openType} />
  const card = ([name, t]: [string, AgentType]) => {
    const users = agents.filter((a) => a.type === name && (a.lifecycle === 'active' || a.lifecycle === 'paused')).length
    return (
      <button type="button" key={name} className="choice" data-type={name} onClick={() => setEditing(name)}>
        <span className="choice-top">{hico(t.harness)}<b>{name}</b>{t.review ? <span className="chip">Reviewer</span> : null}{name === reg.defaultReviewer ? <span className="chip">Default</span> : null}<span className="meta">{t.review?.ring ? `Ring · ${t.review.ring.members.length} members` : <>{model(t).label}{t.effort ? ' · ' + t.effort : ''}</>}</span>
          {t.review?.fallback ? <span className="meta">falls back to {t.review.fallback}</span> : null}
          {users ? <span className="meta type-users">{users} running</span> : null}<Icon name="chevron-right" size="xs" /></span>
        {t.description ? <span className="desc">{t.description}</span> : null}
      </button>
    )
  }
  const reviewers = types.filter(([, t]) => t.review)
  const others = types.filter(([, t]) => !t.review)
  return (
    <>
      <p className="lede">Saved roles a manager spawns by name, such as a developer or a reviewer. Each brings its harness, model, and effort, its own instructions, and a brief its first task is written into.</p>
      {reviewers.length ? <><h3 className="type-group">Reviewers</h3><div className="choice-cards type-cards" data-group="reviewers">{reviewers.map(card)}</div></> : null}
      <h3 className="type-group">Agent types</h3>
      <div className="choice-cards type-cards" data-group="types">
        {others.map(card)}
        {others.length ? null : <p className="muted">No other agent types.</p>}
      </div>
      {readOnly ? null : <div className="row type-add">
        <button className="btn" id="add-reviewer" onClick={() => setEditing('+reviewer')}><Icon name="plus" />Add a reviewer</button>
        <button className="btn" id="add-type" onClick={() => setEditing('')}><Icon name="plus" />Add a type</button>
      </div>}
    </>
  )
}

function TypeForm({ name, reg, write, readOnly, why, onDone, openInstructions, openType }: { name: string; reg: Registry; write: Write; readOnly: boolean; why?: string; onDone: (changed: boolean) => Promise<void>; openInstructions: (type: string) => void; openType?: (type: string) => void }) {
  // '+reviewer' starts a new type with the Reviewer toggle on.
  const asReviewer = name === '+reviewer'
  const isNew = name === '' || asReviewer
  const start: AgentType = reg.types?.[name] ?? setReviewer({ harness: 'claude', model: null, effort: null, description: '' }, asReviewer)
  const [t, setT] = useState<AgentType>(start)
  const [typeName, setTypeName] = useState(isNew ? '' : name)
  // The harness, model, and effort a type had before it became a ring, for the way back.
  const [stash, setStash] = useState<ReturnType<typeof targetOf> | null>(null)
  const [isDefault, setIsDefault] = useState(!isNew && reg.defaultReviewer === name)
  const wasDefault = !isNew && reg.defaultReviewer === name
  const allTypes = Object.keys(reg.types ?? {}).filter((n) => n !== name)
  const reviewerTypes = allTypes.filter((n) => reg.types?.[n]?.review)
  const ring = t.review?.ring ?? null
  const [err, setErr] = useState('')
  const set = (patch: Partial<AgentType>) => { setErr(''); setT((o) => ({ ...o, ...patch })) }
  const models = Object.entries(reg.models).filter(([, m]) => !m.harnesses || m.harnesses.includes(t.harness)).map(([id]) => id)
  if (t.model && !models.includes(t.model)) models.unshift(t.model)
  const efforts = reg.harnesses[t.harness]?.efforts ?? []
  // A harness change keeps the model and effort only when the new harness has them.
  const pickHarness = (h: string) => {
    const ok = Object.entries(reg.models).filter(([, m]) => !m.harnesses || m.harnesses.includes(h)).map(([id]) => id)
    set({ harness: h, model: t.model && ok.includes(t.model) ? t.model : ok[0] ?? null, effort: t.effort && (reg.harnesses[h]?.efforts ?? []).includes(t.effort) ? t.effort : null })
  }

  async function save() {
    const n = typeName.trim()
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(n)) return setErr('The name takes lowercase letters, digits, and dashes.')
    if (ring && ring.members.length < 2) return setErr('A ring needs at least 2 members.')
    if (ring && !(ring.maxRounds >= 1)) return setErr('Max rounds is a whole number, 1 or more.')
    if (ring && ring.members.some((m) => !m)) return setErr('Pick a type for every member.')
    if (isNew && reg.types?.[n]) return setErr(`A type named ${n} exists.`)
    try {
      await write('POST', `/api/types/${n}`, typePayload(t, isDefault))
      toast(`Saved the ${n} type`)
      await onDone(true)
    } catch (e) { setErr((e as Error).message) }
  }
  async function remove() {
    if (!confirm(`Remove the ${name} type? Agents already running as ${name} keep their instructions until they restart.`)) return
    try {
      await write('DELETE', `/api/types/${name}`)
      toast(`Removed the ${name} type`)
      await onDone(true)
    } catch (e) { setErr((e as Error).message) }
  }

  return (
    <form className="type-form" aria-label={isNew ? 'New agent type' : `Agent type ${name}`} onSubmit={(e) => { e.preventDefault(); void save() }}>
      <button type="button" className="btn type-back" onClick={() => void onDone(false)}><Icon name="arrow-left" size="xs" />Agent types</button>
      <Ro off={readOnly} why={why}>
      <div className="set-card">
        <Row label="Name" help={isNew ? 'Managers spawn it by this name.' : undefined}>
          {isNew ? <input type="text" className="wide" name="name" value={typeName} placeholder="tester" spellCheck={false} autoComplete="off" autoCapitalize="none" maxLength={41}
            onChange={(e) => { setErr(''); setTypeName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-')) }} /> : <b>{name}</b>}
        </Row>
        <Row label="When to use it" help="Managers read this to pick a type." cls="grow">
          <input type="text" className="wide" name="description" value={t.description ?? ''} placeholder="What it is for" onChange={(e) => set({ description: e.target.value })} />
        </Row>
        {ring ? null : <>
          <Row label="Harness"><Seg value={t.harness} opts={Object.keys(reg.harnesses).map((h) => ({ v: h, html: <>{hico(h)}{HARNESS[h] ?? h}</> }))} onPick={pickHarness} /></Row>
          <Row label="Model">
          <select name="model" value={t.model ?? ''} onChange={(e) => set({ model: e.target.value || null })}>
            <option value="">Harness default</option>
            {models.map((id) => <option key={id} value={id}>{model({ harness: t.harness, model: id }).label} · {id}</option>)}
          </select>
          </Row>
          <Row label="Effort">{efforts.length ? <Seg value={t.effort ?? null} opts={[{ v: null, label: 'Default' }, ...efforts.map((e) => ({ v: e as string | null, label: e }))]} onPick={(v) => set({ effort: v })} /> : <span className="muted">This harness has no effort setting.</span>}</Row>
        </>}
        <Row label="Hears about its children" help="Default follows the setting for all agents.">
          <Seg value={t.child_notices ?? null} opts={NOTICES} onPick={(v) => set({ child_notices: v })} />
        </Row>
        <Row label="May mail" help="Besides its parents, the chief of staff, and you.">
          <Seg value={t.visibility?.reach ?? null} opts={REACH} onPick={(v) => set({ visibility: v ? { ...t.visibility, reach: v } : null })} />
        </Row>
      </div>
      <h3>Review</h3>
      <div className="set-card review-card">
        <Row label="Reviewer" help="A reviewer type can review work and be made the default reviewer.">
          <Seg value={Boolean(t.review)} opts={[{ v: false, label: 'No' }, { v: true, label: 'Yes' }]} onPick={(v) => { if (!v) setIsDefault(false); set(setReviewer(t, v)) }} />
        </Row>
        {t.review ? <>
          <Row label="Default reviewer" cls="default-row" help={wasDefault ? 'To change it, make another type the default.' : 'The type a plain review uses.'}>
            <Seg value={isDefault} opts={[{ v: false, label: 'No' }, { v: true, label: 'Yes' }]} onPick={(v) => { if (wasDefault && !v) return; setErr(''); setIsDefault(v) }} />
          </Row>
          <Row label="Reviews as"><Seg value={ring ? 'ring' : 'one'} opts={[{ v: 'one', label: 'One agent' }, { v: 'ring', label: 'Ring' }]}
            onPick={(v) => { if (v === 'ring' && !ring) setStash(targetOf(t)); set(setReviewsAs(t, v === 'ring', allTypes, Object.keys(reg.harnesses)[0] ?? 'claude', stash)) }} /></Row>
          {ring ? <>
            <Row label="Format" help={RING_FORMATS.find((f) => f.v === ring.format)?.help}>
              <Seg value={ring.format} opts={RING_FORMATS} onPick={(v) => set(patchRing(t, { format: v }))} />
            </Row>
            <Row label="Members" help="In turn order. At least 2." cls="ring-members">
              <div className="ring-list">
                {ring.members.map((m, i) => (
                  <div className="ring-member" key={i} data-member={i}>
                    <select aria-label={`Member ${i + 1}`} value={m} onChange={(e) => set(patchRing(t, { members: ring.members.map((x, j) => j === i ? e.target.value : x) }))}>
                      {m && !allTypes.includes(m) ? <option value={m}>{m}</option> : <option value="">Pick a type</option>}
                      {allTypes.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <button type="button" className="btn ring-btn" aria-label={`Move member ${i + 1} up`} disabled={i === 0} onClick={() => set(patchRing(t, { members: moveMember(ring.members, i, -1) }))}><Icon name="arrow-up" size="xs" /></button>
                    <button type="button" className="btn ring-btn" aria-label={`Move member ${i + 1} down`} disabled={i === ring.members.length - 1} onClick={() => set(patchRing(t, { members: moveMember(ring.members, i, 1) }))}><Icon name="arrow-down" size="xs" /></button>
                    <button type="button" className="btn ring-btn" aria-label={`Remove member ${i + 1}`} onClick={() => set(patchRing(t, { members: ring.members.filter((_, j) => j !== i) }))}><Icon name="trash-2" size="xs" /></button>
                  </div>
                ))}
                <button type="button" className="btn ring-add" onClick={() => set(patchRing(t, { members: [...ring.members, allTypes.find((n) => !ring.members.includes(n)) ?? ''] }))}><Icon name="plus" size="xs" />Add a member</button>
              </div>
            </Row>
            <Row label="Moderator" help={ring.moderator ? (ring.moderator.decides ? 'Reads the ring and decides the verdict.' : 'Keeps the ring moving; the members decide.') : 'No moderator.'}>
              <div className="ring-mod">
                <Seg value={ring.moderator ? (ring.moderator.decides ? 'decides' : 'facilitates') : 'none'} opts={[{ v: 'none', label: 'None' }, { v: 'facilitates', label: 'Facilitates' }, { v: 'decides', label: 'Decides' }]}
                  onPick={(v) => set(patchRing(t, { moderator: v === 'none' ? null : { type: ring.moderator?.type ?? allTypes[0] ?? '', decides: v === 'decides' } }))} />
                {ring.moderator ? <select aria-label="Moderator type" value={ring.moderator.type} onChange={(e) => set(patchRing(t, { moderator: { type: e.target.value, decides: ring.moderator!.decides } }))}>
                  {!allTypes.includes(ring.moderator.type) ? <option value={ring.moderator.type}>{ring.moderator.type || 'Pick a type'}</option> : null}
                  {allTypes.map((n) => <option key={n} value={n}>{n}</option>)}
                </select> : null}
              </div>
            </Row>
            <Row label="Max rounds" help="1 or more.">
              <input type="number" name="maxRounds" min={1} step={1} value={ring.maxRounds || ''} onChange={(e) => set(patchRing(t, { maxRounds: Math.max(0, Math.floor(Number(e.target.value))) }))} />
            </Row>
          </> : null}
          <Row label="Fallback reviewer" help="Takes over when this one's account is held.">
            <select name="fallback" value={t.review.fallback ?? ''} onChange={(e) => set({ review: { ...t.review!, fallback: e.target.value || null } })}>
              <option value="">None</option>
              {reviewerTypes.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Row>
        </> : null}
      </div>
      <h3>Brief</h3>
      <p className="muted">Its first prompt, with the spawner's task in it. Empty: the task alone. Placeholders: {PLACEHOLDERS.map((p, i) => <span key={p}>{i ? ', ' : ''}<code>{`{{${p}}}`}</code></span>)}, and any the spawner passes.</p>
      <div className="set-card text-card">
        <textarea name="brief" spellCheck={false} value={t.brief ?? ''} placeholder={'Task: {{task}}\n\nWhen you are done, mail {{parent}}.'} onChange={(e) => set({ brief: e.target.value })} />
      </div>
      </Ro>
      {!isNew ? <div className="type-instr"><span className="muted">Its standing instructions, added to its system prompt, are edited with the other instructions.</span>
        <button type="button" className="btn" onClick={() => openInstructions(name)}><Icon name="file-text" />Edit instructions</button>
        {openType ? <button type="button" className="btn" onClick={() => openType(name)}><Icon name="layers" />Type page</button> : null}</div> : null}
      {err ? <p className="sp-error" role="alert">{err}</p> : null}
      {readOnly ? null : <div className="row type-actions">
        <button type="submit" className="btn primary">{isNew ? 'Add type' : 'Save'}</button>
        <button type="button" className="btn" onClick={() => void onDone(false)}>Cancel</button>
        <span className="spacer" />
        {!isNew ? <button type="button" className="btn danger" onClick={() => void remove()}><Icon name="trash-2" />Remove</button> : null}
      </div>}
    </form>
  )
}

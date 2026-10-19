// Adding an agent. The + button opens a quick menu: the defaults first (one click, as
// before), then each agent type, each preset, then each harness's models and their
// efforts as submenus.
// "More options…" opens a panel where everything else is picked from options too: type, folder,
// worktree, parent, permission mode, plus an optional name and first prompt.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { selectAgent } from './actions'
import { api } from './api'
import { HARNESS, live } from './format'
import { Glyph } from './Glyph'
import { Icon } from './Icon'
import { byId, getData, refresh, setData } from './store'
import { showMenu, swallowNextClick, toast, type MenuItem } from './ui/menu'
import { getUi, setUi } from './ui/state'
import type { Agent } from './types'
import { modeLabel, offeredModes, type PermissionMode, type PermissionModes } from './permission-modes'

interface Preset { harness: string; model?: string | null; effort?: string | null; description?: string }
interface Registry {
  harnesses: Record<string, { description?: string; efforts?: string[] }>
  models: Record<string, { harnesses?: string[]; efforts?: string[] }>
  presets: Record<string, Preset>
  types?: Record<string, Preset>
}
export interface SpawnBody {
  name?: string; type?: string; harness?: string; model?: string; effort?: string; preset?: string; cwd?: string
  worktree?: boolean; parent?: string; permission_mode?: PermissionMode; prompt?: string
  standing?: boolean; workspace?: true | string
}

// --- The registry and the defaults ------------------------------------------------------
// The daemon's own defaults for settings.spawnDefaults (src/settings.ts), for a
// settings.json that doesn't set them.
let defaults: { preset: string | null; cwd: string | null } = { preset: 'standard', cwd: '~' }
let reg: Registry | null = null
// Settings › permission modes: the mode a new agent starts in, and what each harness offers.
let modes: PermissionModes | null = null
async function load() {
  const [r, s, pm] = await Promise.all([
    api<Registry>('GET', '/api/registry'),
    api<{ text: string }>('GET', '/api/config/settings').then((x) => JSON.parse(x.text) as { spawnDefaults?: typeof defaults }).catch(() => ({ spawnDefaults: undefined })),
    api<PermissionModes>('GET', '/api/permission-modes').catch(() => null),
  ])
  reg = r
  modes = pm
  defaults = { preset: 'standard', cwd: '~', ...s.spawnDefaults }
}
// The first menu waits for the registry; later ones show what they have and refresh it.
async function ready() {
  if (reg) return void load().catch(() => {})
  try { await load() } catch {}
}

// A picked mode stays when the harness offers it; otherwise the agent follows the settings again.
const modeFor = (h: string, m: PermissionMode | null) => (m && (modes?.harnesses[h]?.some((x) => x.mode === m && x.offered) ?? m !== 'default') ? m : null)
const harnesses = () => Object.keys(reg?.harnesses ?? HARNESS)
const modelsFor = (h: string) => Object.entries(reg?.models ?? {}).filter(([, m]) => m.harnesses?.includes(h)).map(([id]) => id)
const effortsFor = (h: string, m: string | null) => (m ? reg?.models[m]?.efforts : undefined) ?? reg?.harnesses[h]?.efforts ?? []
// A model's short name: Claude's as "opus 5.5", the rest as the id's last part.
export function modelName(m: string | null | undefined) {
  if (!m) return 'default model'
  const c = m.match(/claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/)
  return c ? `${c[1]} ${c[2]}.${c[3]}` : m.split('/').pop()!
}
const summary = (p: { model?: string | null; effort?: string | null }) => modelName(p.model) + (p.effort ? ' · ' + p.effort : '')
const harnessName = (h: string) => HARNESS[h] ?? h

// A harness's mark without a state ring: no agent exists yet.
export function HarnessMark({ harness }: { harness: string }) {
  return <span className="hico" style={{ color: `var(--h-${harness}, var(--text-secondary))` }}><Icon name={harness in HARNESS ? harness : 'bot'} /></span>
}

// --- Folders: the ones last used here, then running agents' ----------------------------
const RECENT = 'stam/recent-folders'
const recent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT) ?? '[]') } catch { return [] } }
function remember(cwd: string) {
  try { localStorage.setItem(RECENT, JSON.stringify([cwd, ...recent().filter((f) => f !== cwd)].slice(0, 8))) } catch {}
}
function folders(): string[] {
  const d = getData()
  const out = new Set(recent())
  // Worktrees and the assistant's folder belong to their agents.
  const agents = d.agents.filter((a) => a.machine === d.machine && a.kind !== 'assistant' && !/\/worktrees\//.test(a.cwd))
  for (const a of agents.sort((x, y) => y.updated_at.localeCompare(x.updated_at))) out.add(a.cwd)
  return [...out].slice(0, 12)
}
// The home folder as ~, worked out from the folders themselves.
const tilde = (f: string) => f.replace(/^\/(home|Users)\/[^/]+(?=\/|$)|^\/root(?=\/|$)/, '~')

// --- Adding -------------------------------------------------------------------------------
// A ring reviewer type answers with the ring and the agents it started, not an agent.
export interface RingStarted { kind: 'ring'; ring: { id: string; name: string }; members: { id: string; name: string }[]; moderator: { id: string; name: string } | null; cwd: string }
const isRing = (a: Agent | RingStarted): a is RingStarted => a.kind === 'ring'
async function addAgent(body: SpawnBody): Promise<Agent | RingStarted> {
  const a = await api<Agent | RingStarted>('POST', '/api/agents', body)
  if (body.cwd) remember(body.cwd)
  if (isRing(a)) {
    // The members are agents the daemon lists on the next refresh; the ring itself isn't one.
    const n = a.members.length + (a.moderator ? 1 : 0)
    toast(`Started ring ${a.ring.name} with ${n} members`)
    if (a.members[0]) selectAgent(a.members[0].id)
    refresh()
    return a
  }
  const ag = a
  setData({ agents: [...getData().agents, { ...ag, parents: ag.parent_id ? [ag.parent_id] : [] }] })
  toast(`Added ${ag.name}: ${modelName(ag.model)} in ${tilde(ag.cwd)}`)
  if (ag.parent_id) setUi({ collapsed: { ...getUi().collapsed, [ag.parent_id]: false } })
  selectAgent(ag.id)
  refresh()
  return ag
}
// With an empty body, settings.spawnDefaults pick the preset and folder, and the name is free.
export const spawn = (body: SpawnBody) => addAgent(body).catch((e: Error) => toast(e.message, true))

// --- The quick menu ---------------------------------------------------------------------
type Base = { parent?: string }
// Opens the menu at (x, y); a second click on `trigger` closes it.
export async function spawnMenu(x: number, y: number, base: Base = {}, trigger?: Element | null) {
  await ready()
  const p = byId(base.parent)
  const dp = defaults.preset ? reg?.presets[defaults.preset] : undefined
  const sub = (items: MenuItem[]) => (r: DOMRect) => showMenu(r.left, r.top, items, trigger)
  const more = (c: Partial<Choice>) => () => openPanel({ ...fresh(base), ...c }, x, y, trigger)
  showMenu(x, y, [
    { section: p ? `Add a child of ${p.name}` : 'Add an agent' },
    { label: 'With the defaults', glyph: <HarnessMark harness={dp?.harness ?? 'claude'} />, hint: dp ? summary(dp) : undefined,
      title: `Preset ${defaults.preset ?? 'none'}, in ${defaults.cwd ?? 'the daemon\'s folder'}`, action: () => spawn({ ...base }) },
    ...(Object.keys(reg?.types ?? {}).length ? [{ section: 'Agent types' } as MenuItem] : []),
    ...Object.entries(reg?.types ?? {}).map(([k, t]): MenuItem => (
      { label: k, glyph: <HarnessMark harness={t.harness} />, hint: summary(t), title: t.description, action: () => spawn({ ...base, type: k }) })),
    { section: 'Presets' },
    ...Object.entries(reg?.presets ?? {}).filter(([k]) => k !== defaults.preset).map(([k, pr]): MenuItem => (
      { label: k, glyph: <HarnessMark harness={pr.harness} />, hint: summary(pr), title: pr.description, action: () => spawn({ ...base, preset: k }) })),
    { section: 'Pick a model' },
    ...harnesses().map((h): MenuItem => ({ label: harnessName(h) + '…', glyph: <HarnessMark harness={h} />, action: sub(modelItems(h, base, sub, more)) })),
    'sep',
    { label: 'More options…', icon: 'sliders-horizontal', action: more({}) },
  ], trigger)
}

type Sub = (items: MenuItem[]) => (r: DOMRect) => void
type More = (c: Partial<Choice>) => () => void
function modelItems(h: string, base: Base, sub: Sub, more: More): MenuItem[] {
  const pick = (m: string | null): MenuItem => {
    const efforts = effortsFor(h, m)
    const body = { ...base, harness: h, ...(m ? { model: m } : {}) }
    return { label: (m ? modelName(m) : 'Harness default') + (efforts.length ? '…' : ''), title: m ?? `${harnessName(h)} picks its model`, icon: m ? 'cpu' : 'circle-dot',
      action: efforts.length ? sub([{ section: `${modelName(m)}: effort` },
        { label: 'Default effort', icon: 'circle-dot', action: () => spawn(body) },
        ...efforts.map((e): MenuItem => ({ label: e, icon: 'gauge', action: () => spawn({ ...body, effort: e }) })),
        'sep', { label: 'More options…', icon: 'sliders-horizontal', action: more({ harness: h, model: m }) }]) : () => spawn(body) }
  }
  return [{ section: `${harnessName(h)}: model` }, pick(null), ...modelsFor(h).map(pick),
    // The defaults' model and effort stay when they're this harness's.
    'sep', { label: 'More options…', icon: 'sliders-horizontal', action: more(h === fresh(base).harness ? {} : { harness: h, model: null, effort: null }) }]
}

// --- The panel: every choice ------------------------------------------------------------
interface Choice {
  type: string | null; harness: string; model: string | null; effort: string | null
  cwd: string | null; cwdTyped: boolean; worktree: boolean; parent: string | null
  mode: PermissionMode | null; name: string; prompt: string; standing: boolean; workspace: boolean
}
// What the defaults pick, as choices.
function fresh(base: Base): Choice {
  const dp = defaults.preset ? reg?.presets[defaults.preset] : undefined
  return { type: null, harness: dp?.harness ?? 'claude', model: dp?.model ?? null, effort: dp?.effort ?? null, cwd: null, cwdTyped: false,
    worktree: false, parent: base.parent ?? null, mode: null, name: '', prompt: '', standing: false, workspace: false }
}

let panel: { choice: Choice; x: number; y: number; n: number; trigger: Element | null } | null = null
let pv = 0
const pls = new Set<() => void>()
const bump = () => { pv++; for (const fn of pls) fn() }
const usePanel = () => { useSyncExternalStore((fn) => { pls.add(fn); return () => { pls.delete(fn) } }, () => pv); return panel }
function openPanel(choice: Choice, x: number, y: number, trigger?: Element | null) {
  panel = { choice, x, y, n: (panel?.n ?? 0) + 1, trigger: trigger ?? null }
  bump()
}
function closePanel(restore = false) {
  const t = panel?.trigger
  panel = null
  bump()
  if (restore) (t as HTMLElement | null)?.focus?.()
}
// Whether the add panel is open, a subscription and a close for the browser history: a back
// press closes it.
export const spawnPanelOpen = () => !!panel
export function onSpawnPanelChange(fn: () => void) { pls.add(fn); return () => { pls.delete(fn) } }
export const closeSpawnPanel = (restore = false) => closePanel(restore)

// A choice picked from a menu of options: a row with its label and the current value.
function Pick({ icon, label, value, options, disabled }: { icon: string; label: string; value: React.ReactNode; options: () => MenuItem[]; disabled?: boolean }) {
  return (
    <button type="button" className="sp-row" aria-haspopup="menu" disabled={disabled} data-pick={label}
      onClick={(e) => {
        const b = e.currentTarget
        const r = b.getBoundingClientRect()
        // After a pick, the focus comes back to the row, for the keyboard.
        const back = (it: MenuItem): MenuItem => (typeof it === 'object' && 'label' in it && it.action ? { ...it, action: (m) => { b.focus(); it.action!(m) } } : it)
        showMenu(r.left + r.width / 3, r.bottom + 2, [{ section: label }, ...options().map(back)], b)
      }}>
      <Icon name={icon} /><span className="sp-label">{label}</span><span className="sp-value">{value}</span><Icon name="chevron-down" size="xs" />
    </button>
  )
}

export function SpawnPanel() {
  const pn = usePanel()
  return pn ? <Panel key={pn.n} pn={pn} /> : null
}

function Panel({ pn }: { pn: NonNullable<typeof panel> }) {
  const d = getData()
  const [c, setC] = useState<Choice>(pn.choice)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const ref = useRef<HTMLFormElement>(null)
  const set = (patch: Partial<Choice>) => { setErr(''); setC((o) => ({ ...o, ...patch })) }

  useLayoutEffect(() => {
    const el = ref.current!
    const r = el.getBoundingClientRect()
    el.style.left = Math.max(12, Math.min(pn.x, innerWidth - r.width - 12)) + 'px'
    el.style.top = Math.max(12, Math.min(pn.y, innerHeight - r.height - 12)) + 'px'
    el.querySelector<HTMLButtonElement>('.sp-row')?.focus()
  }, [pn])
  useEffect(() => {
    // A press outside closes the panel; its own option menus are outside it but belong to it.
    // The listener attaches at once, not after a timeout: the click that opened the panel
    // targeted the menu and has already finished, so it can't reach this one, and a press
    // right after opening still closes the panel.
    const outside = (e: PointerEvent) => {
      const t = e.target as Element
      if (ref.current?.contains(t) || t.closest?.('.menu') || pn.trigger?.contains(t)) return
      closePanel()
      if (e.pointerType === 'touch') swallowNextClick()
    }
    document.addEventListener('pointerdown', outside, true)
    // On a phone the keyboard shrinks the sheet: the field being typed into stays in sight.
    // phone.ts sets the sheet's new height in the next frame, so this looks one later.
    let raf = 0
    const fit = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = document.activeElement
        if (el && ref.current?.contains(el) && el.matches('input:not([type=checkbox]), textarea')) el.scrollIntoView({ block: 'nearest' })
      }))
    }
    visualViewport?.addEventListener('resize', fit)
    addEventListener('resize', fit)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('pointerdown', outside, true)
      visualViewport?.removeEventListener('resize', fit)
      removeEventListener('resize', fit)
    }
  }, [pn])

  // Picking a harness keeps the model and effort it supports, or falls back to its default.
  const pickHarness = (h: string) => {
    const m = c.model && modelsFor(h).includes(c.model) ? c.model : null
    set({ harness: h, model: m, effort: c.effort && effortsFor(h, m).includes(c.effort) ? c.effort : null, mode: modeFor(h, c.mode) })
  }
  const pickModel = (m: string | null) => set({ model: m, effort: c.effort && effortsFor(c.harness, m).includes(c.effort) ? c.effort : null })
  // A type brings its harness, model, and effort, which stay changeable after.
  const pickType = (t: string | null) => {
    const ty = t ? reg?.types?.[t] : undefined
    set(ty ? { type: t, harness: ty.harness, model: ty.model ?? null, effort: ty.effort ?? null, mode: modeFor(ty.harness, c.mode) } : { type: null })
  }
  const types = Object.entries(reg?.types ?? {})
  const efforts = effortsFor(c.harness, c.model)
  const parents = d.agents.filter(live)
  // What Settings give this harness and type, and the modes the harness offers here.
  const fromSettings = ((c.type && modes?.settings.types[c.type] !== 'inherit' ? modes?.settings.types[c.type] : undefined) ?? modes?.settings.harness[c.harness] ?? 'auto') as PermissionMode
  const pickable = offeredModes(modes?.harnesses[c.harness] ?? [{ mode: 'auto', label: 'Auto', harness: '', offered: true }, { mode: 'bypass', label: 'Bypass', harness: '', offered: true }])
  const parent = byId(c.parent)
  const opt = (label: string, checked: boolean, action: () => void, extra: Partial<Extract<MenuItem, { label: string }>> = {}): MenuItem => ({ label, checked, action, ...extra })

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      await addAgent({
        ...(c.type ? { type: c.type } : {}), harness: c.harness, ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}),
        ...(c.cwd?.trim() ? { cwd: c.cwd.trim() } : {}), ...(c.worktree ? { worktree: true } : {}), ...(c.parent ? { parent: c.parent } : {}),
        // Left out unless the human picked one: any mode sent is a pick of their own, which the agent keeps over the settings.
        ...(c.mode ? { permission_mode: c.mode } : {}), ...(c.name ? { name: c.name } : {}), ...(c.prompt.trim() ? { prompt: c.prompt } : {}),
        ...(c.standing ? { standing: true } : {}), ...(c.workspace ? { workspace: true as const } : {}),
      })
      closePanel()
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }
  const key = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (e.key === 'Escape') { e.preventDefault(); closePanel(true) }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && t.matches('.sp-row, .sp-check input')) {
      e.preventDefault()
      const rows = [...ref.current!.querySelectorAll<HTMLElement>('.sp-row:not(:disabled), .sp-check input, .sp-field input, .sp-field textarea')]
      rows[Math.max(0, Math.min(rows.length - 1, rows.indexOf(t) + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    }
  }
  const home = defaults.cwd ?? '~'

  return (
    <form className="spawn-panel" ref={ref} aria-label="Add an agent" onKeyDown={key} onSubmit={(e) => { e.preventDefault(); submit() }}>
      <header><span className="label eyebrow">Add an agent</span><span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={() => closePanel(true)}><Icon name="x" /></button></header>
      {types.length ? <Pick icon="users" label="Type" value={c.type ?? 'None'}
        options={() => [opt('None', !c.type, () => pickType(null)), ...types.map(([k, t]) => opt(k, k === c.type, () => pickType(k), { glyph: <HarnessMark harness={t.harness} />, hint: summary(t), title: t.description }))]} /> : null}
      <Pick icon="bot" label="Harness" value={<><HarnessMark harness={c.harness} />{harnessName(c.harness)}</>}
        options={() => harnesses().map((h) => opt(harnessName(h), h === c.harness, () => pickHarness(h), { glyph: <HarnessMark harness={h} /> }))} />
      <Pick icon="cpu" label="Model" value={c.model ? modelName(c.model) : 'Harness default'}
        options={() => [opt('Harness default', !c.model, () => pickModel(null)), ...modelsFor(c.harness).map((m) => opt(modelName(m), m === c.model, () => pickModel(m), { title: m }))]} />
      <Pick icon="gauge" label="Effort" value={!efforts.length ? 'Not offered' : c.effort ?? 'Default'} disabled={!efforts.length}
        options={() => [opt('Default', !c.effort, () => set({ effort: null })), ...efforts.map((e) => opt(e, e === c.effort, () => set({ effort: e })))]} />
      {c.cwdTyped
        ? <label className="sp-field"><Icon name="folder" /><span className="sp-label">Folder</span>
            <input autoFocus value={c.cwd ?? ''} placeholder="/path/to/folder" spellCheck={false} autoComplete="off" onChange={(e) => set({ cwd: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Escape' && c.cwd === '') { e.stopPropagation(); set({ cwdTyped: false, cwd: null }) } }} /></label>
        : <Pick icon="folder" label="Folder" value={<span title={c.cwd ?? home}>{tilde(c.cwd ?? home)}</span>}
            options={() => [opt(tilde(home), !c.cwd, () => set({ cwd: null }), { hint: 'default' }),
              ...folders().filter((f) => f !== home).map((f) => opt(tilde(f), f === c.cwd, () => set({ cwd: f }), { title: f })),
              'sep', { label: 'Another folder…', icon: 'folder', action: () => set({ cwdTyped: true, cwd: '' }) }]} />}
      <label className="sp-row sp-check"><Icon name="git-branch" /><span className="sp-label">Worktree</span>
        <span className="sp-value">{c.worktree ? 'its own branch' : 'off'}</span>
        <input type="checkbox" checked={c.worktree} onChange={(e) => set({ worktree: e.target.checked })} /></label>
      <label className="sp-row sp-check"><Icon name="pause" /><span className="sp-label">Standing</span>
        <span className="sp-value">{c.standing ? 'pauses when idle' : 'off'}</span>
        <input type="checkbox" checked={c.standing} onChange={(e) => set({ standing: e.target.checked, workspace: e.target.checked })} /></label>
      <label className="sp-row sp-check"><Icon name="file-text" /><span className="sp-label">Workspace</span>
        <span className="sp-value">{c.workspace ? 'its own notes folder' : 'off'}</span>
        <input type="checkbox" checked={c.workspace} onChange={(e) => set({ workspace: e.target.checked })} /></label>
      <Pick icon="network" label="Parent" value={parent ? <><Glyph agent={parent} />{parent.name}</> : 'None'}
        options={() => [opt('None', !c.parent, () => set({ parent: null })), ...parents.map((a) => opt(a.name, a.id === c.parent, () => set({ parent: a.id }), { glyph: <Glyph agent={a} /> }))]} />
      <Pick icon={c.mode === 'bypass' ? 'zap' : 'shield'} label="Permissions" value={c.mode ? modeLabel(c.mode) : `Settings: ${modeLabel(fromSettings)}`}
        options={() => [opt(`Follow settings: ${modeLabel(fromSettings)}`, !c.mode, () => set({ mode: null }), { icon: 'settings', hint: 'Settings › Permission modes' }),
          ...pickable.map((m) => opt(modeLabel(m.mode), c.mode === m.mode, () => set({ mode: m.mode }), m.mode === 'bypass' ? { icon: 'zap', danger: true, hint: 'never asks' } : { icon: 'shield', hint: m.mode === 'default' ? 'asks for each action' : 'asks when unsure' }))]} />
      {c.mode === 'bypass' ? <p className="sp-warn" role="alert">Bypass runs every action without asking. This agent keeps it until you change it.</p> : null}
      <label className="sp-field"><Icon name="tag" /><span className="sp-label">Name</span>
        <input value={c.name} placeholder="generated" spellCheck={false} autoComplete="off" autoCapitalize="none" maxLength={41}
          onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-') })} /></label>
      <label className="sp-field sp-prompt"><Icon name="message-square" /><span className="sp-label">First prompt</span>
        <textarea rows={3} value={c.prompt} placeholder={c.type ? 'Optional: its task, filled into the type\'s brief' : 'Optional: what it starts on'} onChange={(e) => set({ prompt: e.target.value })} /></label>
      {err ? <p className="sp-error" role="alert">{err}</p> : null}
      <footer><span className="kbd">Ctrl+Enter</span><span className="spacer" />
        <button type="button" className="btn" onClick={() => closePanel(true)}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Adding…' : 'Add agent'}</button></footer>
    </form>
  )
}

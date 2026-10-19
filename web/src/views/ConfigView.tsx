// Settings: forms over settings.json, each change saving at once, with plain editors for
// the texts stam sends agents and the rarer settings. The settings object is edited in
// place, as it was before React, and `rev` re-renders (and remounts the controls, so they
// show what was saved).
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, homeApi, token } from '../api'
import { openAssistant, openType, openWorld, setDefaultView } from '../actions'
import { Glyph } from '../Glyph'
import { settingShown } from '../nav-history'
import { NotifySettings } from './NotifySettings'
import { isLocalSession, logout } from '../local-login'
import { ClassifySince } from './ClassifySince'
import { openUsageActivity } from './UsageView'
import { SkillsSettings } from './SkillsSettings'
import { ToolsSettings } from './ToolsSettings'
import { RetroSettings, type Retro } from './RetroSettings'
import { TreeCheckSettings, type TreeCheck } from './TreeCheckSettings'
import { StepsSettings } from './StepsSettings'
import { TinyModelsSettings } from './TinyModelsSettings'
import { Icon } from '../Icon'
import { readOnly, scopeOf, staleNote, writesToHome, type SettingsReply, type SettingsScope } from '../settings-scope'
import { buildPatch, revertKeys, saveNote, savePeer, settleSave, type PatchReply, type SaveOutcome } from '../settings-save'
import { HARNESS, model, stateLabel } from '../format'
import { useShell } from '../shell/layout'
import { chiefAssistants, loadThresholds, refresh, useData } from '../store'
import { toast } from '../ui/menu'
import type { Agent } from '../types'
import { TypesSettings, type AgentType } from './TypesSettings'
import { PermissionModesSettings } from './PermissionModesSettings'
import { McpSettings, type Servers } from './McpSettings'
import { ModelPicker } from './ModelPicker'
import { WorkColumnsSettings } from './WorkColumnsSettings'
import { MotionSettings } from './MotionSettings'
import { SidebarSettings } from './SidebarSettings'
import { ReqImport } from '../req/ReqImport'
import { refreshReq } from '../req/store'
import { SECTIONS } from './configSections'

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
type Obj = { [k: string]: Json }
interface Registry {
  harnesses: Record<string, { efforts?: string[] }>
  models: Record<string, { harnesses?: string[] }>
  presets: Record<string, { harness: string; model?: string | null; effort?: string | null; description?: string }>
  types?: Record<string, AgentType>
}
interface Template { name: string; text: string; overridden?: boolean }
interface Assistant { agent?: Agent | null }
interface Loaded { s: Obj; reg: Registry; asst: Assistant; templates: Template[]; scope: SettingsScope }

const getPath = (o: unknown, path: string): Json | undefined => path.split('.').reduce<unknown>((x, key) => (x as Record<string, unknown> | undefined)?.[key], o) as Json | undefined
function setPath(o: Obj, path: string, v: Json) {
  const ks = path.split('.')
  const last = ks.pop()!
  let x = o as Record<string, Json>
  for (const key of ks) x = (x[key] ??= {}) as Record<string, Json>
  x[last] = v
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// The models that may not mail the human by default: the same as DEFAULTS.humanMail.models in src/settings.ts.
const MAIL_MODEL_DEFAULTS: Record<string, boolean> = { 'claude-haiku-5-5': false }
// The requirements settings a fresh settings.json leaves out: the same as DEFAULTS.requirements in src/settings.ts.
const REQ_DEFAULTS = { approval: 'human', defaultThreshold: 0.8, defaultMode: 'observe', dailyCapUsd: 1, keyPrefix: 'R', demoteMinFlags: 5 }

// How cost is shown (cost.display.mode, src/cost-display.ts), one card each with its explanation.
const COST_MODES = [
  { v: 'api', label: 'API equivalent', desc: 'What the tokens would cost at API prices.' },
  { v: 'five_hour', label: '% of the 5-hour window', desc: 'The share of the current 5-hour window used.' },
  { v: 'seven_day', label: '% of the 7-day window', desc: 'The share of the current 7-day window used.' },
  { v: 'subscription', label: 'Subscription', desc: 'API-equivalent cost × the account\'s monthly price ÷ estimated API-equivalent use per month.' },
]
const HARNESS_ICON: Record<string, string> = { claude: 'claude', codex: 'codex', opencode: 'opencode' }
const SECTION_KEY = 'stam/settings-section'
const ITEM_KEY = 'stam/settings-item'
// Sections that moved: an old link or saved section opens the section they became.
// Reviewers are agent types now (S-412), so Settings › Reviewers opens Agent types.
const SECTION_ALIASES: Record<string, string> = { reviewers: 'types' }
const TEXT_SECTIONS = ['instructions', 'advanced', 'messages']

// The instruction templates, grouped by the type of agent they apply to. `instructions.md`
// has no template: it is the user's own file, read and written through the config endpoint.
interface InstrItem { name: string; label: string; file?: boolean; active?: boolean }
interface InstrGroup { key: string; label: string; names: string[]; items: InstrItem[] }
function instructionGroups(s: Obj, agents: Agent[], types: string[] = []): InstrGroup[] {
  const all = agents.map((a) => a.name)
  const cos = agents.filter((a) => a.chief_of_staff).map((a) => a.name)
  const asst = agents.filter((a) => a.kind === 'assistant').map((a) => a.name)
  const when = (((s.humanMail ?? {}) as Obj).when as string | undefined) ?? 'necessary'
  return [
    { key: 'all', label: 'All agents', names: all, items: [
      { name: 'instructions', label: 'Your instructions', file: true }, { name: 'system-prompt', label: 'Base system prompt' },
    ] },
    { key: 'cos', label: 'Chief of staff', names: cos, items: [{ name: 'chief-of-staff', label: 'Chief of staff' }] },
    { key: 'asst', label: 'Executive assistant', names: asst, items: [{ name: 'assistant', label: 'Executive assistant' }] },
    ...types.map((t) => ({ key: `type-${t}`, label: `Type: ${t}`, names: agents.filter((a) => a.type === t).map((a) => a.name), items: [{ name: `type-${t}`, label: t }] })),
    { key: 'mail', label: 'Mail to you', names: all, items: [
      { name: 'mail-to-human', label: 'Mail rules' }, { name: 'mail-to-human-restricted', label: 'Mail rules, restricted model' }, { name: 'human-mail-when-necessary', label: 'Necessary', active: when === 'necessary' },
      { name: 'human-mail-when-important', label: 'Important', active: when === 'important' }, { name: 'human-mail-when-everything', label: 'Everything', active: when === 'everything' },
    ] },
    { key: 'files', label: 'Instruction files', names: all, items: [
      { name: 'instruction-files', label: 'Instruction files' }, { name: 'workspace-instructions', label: 'Workspace instructions' },
    ] },
  ]
}
// Everything the Instructions section owns, agent types' instructions included; "Messages
// stam sends" lists the rest (the notices).
const INSTRUCTION_TEMPLATES = new Set(instructionGroups({}, []).flatMap((g) => g.items.map((i) => i.name)).filter((n) => n !== 'instructions'))
const isInstruction = (name: string) => INSTRUCTION_TEMPLATES.has(name) || name.startsWith('type-')

// An input that saves on the browser's own "change" (leaving the field, or Enter), not on
// every keystroke, as number and text fields did before.
function ChangeInput({ onValue, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> & { onValue: (el: HTMLInputElement) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const cb = useRef(onValue)
  cb.current = onValue
  useEffect(() => {
    const el = ref.current!
    const h = () => cb.current(el)
    el.addEventListener('change', h)
    return () => el.removeEventListener('change', h)
  }, [])
  return <input ref={ref} {...props} />
}

// A multi-line field, saving on the browser's own "change" like ChangeInput.
function ChangeTextarea({ onValue, ...props }: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> & { onValue: (el: HTMLTextAreaElement) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const cb = useRef(onValue)
  cb.current = onValue
  useEffect(() => {
    const el = ref.current!
    const h = () => cb.current(el)
    el.addEventListener('change', h)
    return () => el.removeEventListener('change', h)
  }, [])
  return <textarea ref={ref} {...props} />
}

function Row({ label, help, children, cls = '' }: { label: ReactNode; help?: ReactNode; children: ReactNode; cls?: string }) {
  return <div className={`set-row ${cls}`}><div className="set-label"><b>{label}</b>{help ? <p>{help}</p> : null}</div><div className="set-ctl">{children}</div></div>
}

// Controls for a shared setting on a peer: disabled, with the reason on hover. A fieldset disables
// every control inside it, so a control that isn't built by a helper below can use it too.
function Ro({ off, why, children }: { off: boolean; why: string; children: ReactNode }) {
  return off ? <fieldset className="ro" disabled title={why}>{children}</fieldset> : <>{children}</>
}

// Where the settings live: on the home a line saying so, on a peer a pointer to the home, and a
// warning when the copy of the shared settings may be behind (S-405).
function ScopeNote({ scope, machine, url }: { scope: SettingsScope; machine: string; url?: string }) {
  if (!scope.home) return null
  const stale = staleNote(scope)
  return (
    <>
      <div className="set-note scope-note">
        <Icon name="info" size="xs" />
        {scope.peer && scope.homeWeb ? (
          <span>Shared settings live on <b>{scope.home}</b>; changes to them are saved there. Settings tagged <span className="chip scope-tag">This machine</span> are kept here.</span>
        ) : scope.peer ? (
          <span>Shared settings live on {url && /^https?:\/\//.test(url) ? <a href={url} target="_blank" rel="noreferrer">{scope.home}</a> : <b>{scope.home}</b>}. Change them there. Settings tagged <span className="chip scope-tag">This machine</span> are kept here.</span>
        ) : (
          <span>Settings are shared by all machines; kept on <b>{scope.home || machine}</b>. Settings tagged <span className="chip scope-tag">This machine</span> belong to this machine only.</span>
        )}
      </div>
      {stale ? <div className="set-note scope-stale" role="status"><Icon name="triangle-alert" size="xs" /><span>{stale}</span></div> : null}
    </>
  )
}

export function ConfigView() {
  const { machine, agents } = useData()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // The settings as this page loaded them, to tell which keys it changed (see save).
  const base = useRef<Obj>({})
  const [error, setError] = useState<string | null>(null)
  const [rev, setRev] = useState(0)
  const [sec, setSec] = useState(() => { try { return localStorage.getItem(SECTION_KEY) || 'assistant' } catch { return 'assistant' } })
  const [tpl, setTpl] = useState<string | undefined>()
  const [edit, setEdit] = useState(false)
  const [status, setStatus] = useState<ReactNode>(null)
  const [msgs, setMsgs] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // A tool picked in Settings › Tools to add a decision step for; taken when Decision steps opens.
  const [stepTool, setStepTool] = useState<string | null>(null)
  const d = useRef<Loaded | null>(null)
  d.current = loaded

  useEffect(() => {
    (async () => {
      try {
        const [st, reg, asst, templates] = await Promise.all([
          api<SettingsReply>('GET', '/api/config/settings'), api<Registry>('GET', '/api/registry'),
          api<Assistant>('GET', '/api/assistant'), api<Template[]>('GET', '/api/templates'),
        ])
        base.current = JSON.parse(st.text) as Obj
        setLoaded({ s: JSON.parse(st.text) as Obj, reg, asst, templates, scope: scopeOf(st, machine) })
      } catch (e) { setError((e as Error).message) }
    })()
  }, [])

  const rerender = () => { setRev((n) => n + 1); setMsgs({}) }
  const msg = (key: string, text: string) => setMsgs((m) => ({ ...m, [key]: text }))

  // Deep link: another view asks Settings to open one item by setting stam/settings-item
  // (with stam/settings-section naming the section). It is taken once, when Settings shows,
  // then cleared, so a later open starts fresh. On the phone that means the item's editor,
  // and a normal open the list; a link never leaves the editor showing behind it.
  const shown = useShell().current === 'w:config'
  const takeLink = () => {
    try {
      const item = localStorage.getItem(ITEM_KEY)
      if (!item) return false
      const section = localStorage.getItem(SECTION_KEY)
      if (section) setSec(section)
      setTpl(item)
      setEdit(true)
      localStorage.removeItem(ITEM_KEY)
      return true
    } catch { return false }
  }
  const prevShown = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    const before = prevShown.current
    prevShown.current = shown
    if (before === undefined) { takeLink(); return }
    if (shown && !before && !takeLink()) setEdit(false)
  }, [shown])

  // The search palette hands a section or item over as an event, so it works whether
  // Settings is opening fresh (the keys above) or already on screen.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ section?: string; item?: string }>).detail ?? {}
      if (d.section) setSec(d.section)
      setTpl(d.item)
      setEdit(!!d.item)
    }
    addEventListener('stam:open-setting', on as EventListener)
    return () => removeEventListener('stam:open-setting', on as EventListener)
  }, [])

  const sectionKey = SECTIONS.find((x) => x.key === (SECTION_ALIASES[sec] ?? sec))?.key ?? SECTIONS[0].key
  // Moving between Settings sections is a place of its own, so back steps between them.
  useEffect(() => { settingShown(sectionKey) }, [sectionKey])
  const templates = loaded?.templates
  const groups = loaded && sectionKey === 'instructions' ? instructionGroups(loaded.s, agents, Object.keys(loaded.reg.types ?? {})) : []
  const items: InstrItem[] = sectionKey === 'instructions' ? groups.flatMap((g) => g.items) : (templates ?? []).filter((t) => !isInstruction(t.name)).map((t) => ({ name: t.name, label: t.name }))
  const curName = tpl && items.some((x) => x.name === tpl) ? tpl : items[0]?.name
  const curTpl = templates?.find((x) => x.name === curName)

  // The text editors fill in after the section renders, from the daemon or the settings.
  useEffect(() => {
    if (!loaded || !TEXT_SECTIONS.includes(sectionKey)) return
    let live = true
    ;(async () => {
      const { s } = loaded
      const next: Record<string, string> = {}
      if (sectionKey === 'instructions') {
        next.instructions = (await api<{ text: string }>('GET', '/api/config/instructions')).text
        next.tpl = curTpl?.text ?? ''
      }
      if (sectionKey === 'advanced') {
        next.registry = (await api<{ text: string }>('GET', '/api/config/registry')).text
        next.settings = JSON.stringify(s, null, 2)
        next.banners = JSON.stringify(s.banners ?? [], null, 2)
      }
      if (sectionKey === 'messages') next.tpl = curTpl?.text ?? ''
      if (live) setDrafts((x) => ({ ...x, ...next }))
    })().catch(() => {})
    return () => { live = false }
  }, [loaded, sectionKey, rev, curTpl?.name, curTpl?.text])

  if (!loaded) {
    return (
      <div className="settings-view"><nav className="settings-nav" /><div className="settings-body"><div className="settings-inner">{error ? <p className="muted">{error}</p> : null}</div></div></div>
    )
  }
  const { s, reg, asst, scope } = loaded
  const ro = (path: string) => readOnly(path, scope)
  const why = `Shared by all machines; change it on ${scope.home}.`
  const update = (patch: Partial<Loaded>) => setLoaded({ ...loaded, ...patch })
  // A shared write (agent types, the instructions for all agents): on a peer that knows the home's page
  // it goes there (S-414), then this daemon fetches the home's new copy so what it shows next is current.
  async function sharedWrite<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!writesToHome(scope)) return api<T>(method, path, body)
    const r = await homeApi<T>(scope.homeWeb, scope.home, method, path, body)
    await api('POST', '/api/config/settings/sync').catch(() => {})
    return r
  }

  // Only the top-level keys this page changed are sent, as a patch the daemon applies to the file
  // (S-293). A view record merges per id there, so a view another page saved since this one loaded
  // stays. The keys this page didn't change take what the daemon now holds.
  async function save(): Promise<SaveOutcome> {
    // The latest settings: an advanced edit replaces the whole object on the loaded copy after this render.
    const cur = (d.current ?? loaded)!.s
    const { patch, removed } = buildPatch(cur, base.current)
    // The daemon owns its bookkeeping (S-712): a retro patch never carries the page's `lastDigest`,
    // which could be older than a digest sent since. The page keeps it only for display, read from
    // `base` (the daemon's copy), not sent. Copy first: patch.retro is the live `cur.retro`.
    if (patch.retro && typeof patch.retro === 'object' && !Array.isArray(patch.retro)) {
      patch.retro = { ...(patch.retro as Obj) }
      delete (patch.retro as Obj).lastDigest
    }
    let outcome: SaveOutcome = 'saved'
    try {
      // The settings file has no top-level delete: say so rather than report a save that kept the key.
      if (removed.length) {
        for (const k of removed) cur[k] = JSON.parse(JSON.stringify(base.current[k]))
        const msg = `Can't delete top-level key${removed.length > 1 ? 's' : ''} ${removed.join(', ')}; set ${removed.length > 1 ? 'them' : 'it'} to a value instead.`
        setStatus(msg)
        // Said where the phone shows it too.
        toast(msg, true)
        rerender()
        return 'error'
      }
      if (Object.keys(patch).length && writesToHome(scope)) {
        // A peer sends the shared part to the home and the local part here (S-414, settings-save.ts).
        const r = await savePeer({
          home: (p) => homeApi(scope.homeWeb, scope.home, 'PATCH', '/api/config/settings', { patch: p }),
          local: (p) => api<PatchReply>('PATCH', '/api/config/settings', { patch: p, localOnly: true }),
          sync: () => api('POST', '/api/config/settings/sync'),
        }, cur, base.current, patch, scope.local, scope.home)
        base.current = r.base
        outcome = r.outcome
        if (r.outcome === 'error') {
          setStatus(r.message)
          // Said where the phone shows it too.
          toast(r.message ?? 'Not saved', true)
        } else if (r.outcome === 'requested') setStatus(<><Icon name="send" size="xs" />{r.message ?? <>Sent for approval{r.requestId ? ` (request ${r.requestId})` : ''}</>}</>)
        else setStatus(<><Icon name="check" size="xs" />Saved</>)
      } else if (Object.keys(patch).length) {
        const r = await api<PatchReply>('PATCH', '/api/config/settings', { patch })
        const done = settleSave(r, cur, base.current, patch)
        base.current = done.base
        // A 202 is an ask to the human (S-362): nothing is saved yet, so the page must not say it is.
        if (done.requested) {
          outcome = 'requested'
          setStatus(<><Icon name="send" size="xs" />Sent for approval{done.requestId ? ` (request ${done.requestId})` : ''}</>)
        } else setStatus(<><Icon name="check" size="xs" />Saved</>)
      } else setStatus(<><Icon name="check" size="xs" />Saved</>)
      void loadThresholds()
    } catch (e) {
      // The daemon refused the change: the keys sent go back to what it holds, so the controls show that.
      revertKeys(cur, base.current, Object.keys(patch))
      setStatus((e as Error).message)
      // Said where the phone shows it too: the status line is hidden at 760 px and under.
      toast((e as Error).message, true)
      outcome = 'error'
    }
    rerender()
    return outcome
  }
  function set(path: string, v: Json) {
    setPath(s, path, v)
    // A harness change keeps the model and effort valid for it.
    if (path === 'assistant.harness') {
      const a = s.assistant as Obj
      const ok = Object.entries(reg.models).filter(([, m]) => !m.harnesses || m.harnesses.includes(v as string)).map(([id]) => id)
      if (!ok.includes(a.model as string)) a.model = ok[0] ?? null
      if (!(reg.harnesses[v as string]?.efforts ?? []).includes(a.effort as string)) a.effort = null
    }
    void save()
  }
  const fromInput = (el: HTMLInputElement | HTMLTextAreaElement): Json => {
    const kind = el.dataset.kind
    if (kind === 'bool') return (el as HTMLInputElement).checked
    if (kind === 'k') return Math.round(Number(el.value) * 1000)
    if (kind === 'pct') return Math.min(1, Math.max(0, Number(el.value) / 100))
    if (kind === 'num') return el.value === '' && el.dataset.null ? null : Number(el.value)
    return el.value
  }
  const onInput = (path: string) => (el: HTMLInputElement | HTMLTextAreaElement) => set(path, fromInput(el))

  // --- Controls: each carries the settings path it edits.
  const seg = (path: string, opts: { v: Json; label?: string; html?: ReactNode }[], dflt?: Json) => {
    const v = getPath(s, path) ?? dflt
    return (
      <div className="seg">{opts.map((o) => (
        <button type="button" key={JSON.stringify(o.v)} className={same(o.v, v ?? null) ? 'on' : ''} disabled={ro(path)} title={ro(path) ? why : undefined} onClick={() => set(path, o.v)}>{o.html ?? o.label}</button>
      ))}</div>
    )
  }
  // `pct` shows a 0-1 setting as a percentage; `dflt` is what an unset setting shows.
  const num = (path: string, { k = false, pct = false, unit = '', min = 0, max, step = 1, nullable = false, dflt }: { k?: boolean; pct?: boolean; unit?: string; min?: number; max?: number; step?: number; nullable?: boolean; dflt?: number } = {}) => {
    const v = getPath(s, path) ?? dflt
    const shown = v == null ? '' : k ? (v as number) / 1000 : pct ? Math.round((v as number) * 100) : (v as number)
    return (
      <span className="num">
        <ChangeInput type="number" min={min} max={max} step={step} disabled={ro(path)} title={ro(path) ? why : undefined} data-kind={k ? 'k' : pct ? 'pct' : 'num'} data-null={nullable ? '1' : undefined} defaultValue={shown} placeholder={nullable ? 'Off' : undefined} onValue={onInput(path)} />
        {unit ? <span className="unit">{unit}</span> : null}
      </span>
    )
  }
  const text = (path: string, placeholder = '') => (
    <ChangeInput type="text" className="wide" disabled={ro(path)} title={ro(path) ? why : undefined} data-kind="text" defaultValue={(getPath(s, path) as string | undefined) ?? ''} placeholder={placeholder} spellCheck={false} onValue={onInput(path)} />
  )
  // A multi-line text setting: free text, saved on leaving the field.
  const longtext = (path: string, placeholder = '') => (
    <ChangeTextarea disabled={ro(path)} title={ro(path) ? why : undefined} data-kind="text" defaultValue={(getPath(s, path) as string | undefined) ?? ''} placeholder={placeholder} spellCheck={false} onValue={onInput(path)} />
  )
  // A checkbox: paper forms have checkboxes; the design system bans toggle switches.
  const toggle = (path: string, label = 'On') => (
    <label className="check" title={ro(path) ? why : undefined}><ChangeInput type="checkbox" disabled={ro(path)} data-kind="bool" defaultChecked={!!getPath(s, path)} onValue={onInput(path)} />{label}</label>
  )
  const cards = (path: string, opts: { v: Json; label: string; icon?: ReactNode; meta?: ReactNode; desc?: string }[], dflt: Json | undefined, label: string) => {
    const v = getPath(s, path) ?? dflt
    return (
      <div className="choice-cards" role="radiogroup" aria-label={label}>{opts.map((o) => (
        <button type="button" role="radio" aria-checked={same(o.v, v)} disabled={ro(path)} title={ro(path) ? why : undefined} key={JSON.stringify(o.v)} className={`choice ${same(o.v, v) ? 'on' : ''}`} onClick={() => set(path, o.v)}>
          <span className="choice-top">{o.icon}<b>{o.label}</b>{o.meta ? <span className="meta">{o.meta}</span> : null}<span className="radio" /></span>
          {o.desc ? <span className="desc">{o.desc}</span> : null}
        </button>
      ))}</div>
    )
  }
  const hico = (h: string) => <span className="hico" style={{ color: `var(--h-${h})` }}><Icon name={HARNESS_ICON[h] ?? 'bot'} /></span>
  const harnessSeg = (path: string) => seg(path, Object.keys(reg.harnesses).map((h) => ({ v: h, html: <>{hico(h)}{HARNESS[h] ?? h}</> })))
  const modelSelect = (path: string, harness: string) => (
    <ModelPicker kind="harness" harness={harness} value={(getPath(s, path) as string | undefined) ?? ''} label="Model" disabled={ro(path)} title={ro(path) ? why : undefined} onChange={(id) => set(path, id || null)} />
  )
  const effortSeg = (path: string, harness: string) => {
    const efforts = reg.harnesses[harness]?.efforts ?? []
    return efforts.length ? seg(path, [{ v: null, label: 'Default' }, ...efforts.map((e) => ({ v: e, label: e }))]) : <span className="muted">This harness has no effort setting.</span>
  }

  // --- Actions
  async function runAssistant(kind: 'start' | 'replace', button: HTMLButtonElement) {
    if (kind === 'replace' && !confirm('Start a new assistant with these settings? The current one stops and stays in the tree, renamed.')) return
    button.disabled = true
    try { await api('POST', `/api/assistant/${kind}`); toast('The assistant is starting.') } catch (err) { toast((err as Error).message, true) }
    await refresh()
    update({ asst: await api<Assistant>('GET', '/api/assistant') })
    rerender()
  }
  async function saveFile(key: string) {
    const text = drafts[key] ?? ''
    try {
      if (key === 'instructions' || key === 'registry') {
        if (key === 'instructions') await sharedWrite('POST', '/api/config/instructions', { text })
        else await api('POST', '/api/config/' + key, { text })
        msg(key, 'Saved.')
        if (key === 'registry') update({ reg: await api<Registry>('GET', '/api/registry') })
        return
      }
      if (key === 'settings') loaded!.s = JSON.parse(text) as Obj
      else s[key] = JSON.parse(text) as Json
      msg(key, saveNote(await save()))
    } catch (err) { msg(key, (err as Error).message) }
  }
  async function saveTpl(reset: boolean) {
    if (!curTpl) return
    if (reset && !confirm(`Reset ${curTpl.name} to the shipped default?`)) return
    try {
      const t = await api<Template>('POST', '/api/templates/' + curTpl.name, reset ? { reset: true } : { text: drafts.tpl ?? '' })
      update({ templates: loaded!.templates.map((x) => (x.name === t.name ? t : x)) })
      rerender()
      msg('tpl', reset ? 'Reset.' : 'Saved.')
    } catch (err) { msg('tpl', (err as Error).message) }
  }
  const draft = (key: string, cls?: string) => (
    <textarea className={cls} spellCheck={false} value={drafts[key] ?? ''} onChange={(e) => setDrafts((x) => ({ ...x, [key]: e.target.value }))} />
  )
  const textCard = (key: string, cls?: string) => (
    <div className="set-card text-card">{draft(key, cls)}<div className="row"><button className="btn primary" onClick={() => void saveFile(key)}>Save</button><span className="muted msg">{msgs[key]}</span></div></div>
  )

  // --- Sections
  const sections: Record<string, () => ReactNode> = {
    assistant() {
      const c = (s.assistant ?? {}) as Obj
      const a = asst?.agent ?? undefined
      const isLive = a && (a.lifecycle === 'active' || a.lifecycle === 'paused')
      const differs = a && (a.harness !== c.harness || (a.model ?? null) !== (c.model ?? null) || (a.effort ?? null) !== (c.effort ?? null))
      const dflt = (s.assistantDefault as string | undefined) || 'assistant'
      const opts = [{ v: 'assistant', label: 'Executive assistant' }, ...chiefAssistants().map((x) => ({ v: x.name, label: `${x.name}, chief of staff's assistant` }))]
      if (!opts.some((o) => o.v === dflt)) opts.push({ v: dflt, label: `${dflt} (not running)` })
      return (
        <>
          <p className="lede">Your executive assistant routes what you write to it to the right agent, starts new agents, and manages mootr for you. Message it from the prompt input's <Icon name="bot" size="xs" /> button, or open it with <span className="kbd">Alt+C</span>.</p>
          <div className="set-card status-card">
            {a ? (
              <><Glyph agent={a} /><div><b>{a.name}</b><div className="muted">{stateLabel(a)} · {model(a).label}{a.effort ? ' · ' + a.effort : ''}</div></div></>
            ) : (
              <><span className="glyph plain"><Icon name="bot" size="xs" /></span><div><b>Not started yet</b><div className="muted">It starts the first time you message it.</div></div></>
            )}
            <span className="spacer" />
            {a ? <button className="btn" onClick={() => openAssistant(true)}><Icon name="terminal" />Open</button> : null}
            {!isLive ? <button className="btn primary" onClick={(e) => void runAssistant('start', e.currentTarget)}><Icon name="play" />Start</button> : null}
          </div>
          {differs ? (
            <div className="set-note"><Icon name="info" size="xs" /><span>{a.name} runs {model(a).label}{a.effort ? ' · ' + a.effort : ''}. A running agent can't switch harness or model, so these settings apply to a new assistant.</span><button className="btn primary" onClick={(e) => void runAssistant('replace', e.currentTarget)}>Restart with these settings</button></div>
          ) : null}
          <div className="set-card">
            <Row label="Harness" help="The coding agent program it runs in.">{harnessSeg('assistant.harness')}</Row>
            <Row label="Model">{modelSelect('assistant.model', c.harness as string)}</Row>
            <Row label="Effort" help="How hard the model thinks before it answers.">{effortSeg('assistant.effort', c.harness as string)}</Row>
            <Row label="Folder" help="Where it starts. Empty: a folder of its own in mootr's data folder.">{text('assistant.cwd', 'Its own folder')}</Row>
          </div>
          <div className="set-card">
            <Row label="Assistant tab opens on" help="The assistant the Assistant tab opens on. A device that picks another in the tab's switch keeps its pick.">
              <select defaultValue={dflt} disabled={ro('assistantDefault')} title={ro('assistantDefault') ? why : undefined} onChange={(e) => set('assistantDefault', e.target.value)}>
                {opts.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
              </select>
            </Row>
          </div>
        </>
      )
    },
    permissions() {
      const types = Object.fromEntries(Object.entries(reg.types ?? {}).filter(([, t]) => t.harness).map(([n, t]) => [n, { harness: t.harness }]))
      return <PermissionModesSettings value={s.permissionModes as { harness?: Record<string, string>; types?: Record<string, string> } | undefined} types={types} harnesses={Object.keys(reg.harnesses)} rev={rev}
        set={(next) => set('permissionModes', next)} readOnly={ro('permissionModes')} why={why} />
    },
    agents() {
      const presets = Object.entries(reg.presets)
      return (
        <>
          <p className="lede">What <b>+</b> in the sidebar starts, with no questions asked.</p>
          <div className="set-card">
            <Row label="Preset">{''}</Row>
            {cards('spawnDefaults.preset', presets.map(([key, p]) => ({ v: key, label: key, icon: hico(p.harness), meta: `${model(p).label}${p.effort ? ' · ' + p.effort : ''}`, desc: p.description })), undefined, 'Preset')}
            <Row label="Folder" help={<>Where new agents start. <code>~</code> is your home folder.</>}>{text('spawnDefaults.cwd', '~')}</Row>
          </div>
        </>
      )
    },
    view() {
      const own = agents.filter((a) => a.view && a.default_view)
      return (
        <>
          <p className="lede">What shows when you select an agent: its terminal, or mootr's view of its conversation. Switch any agent between the two with <b>Terminal</b> and <b>Conversation</b> above it; it opens in what you picked from then on.</p>
          <div className="set-card">
            <Row label="Agents open in" help="For agents you haven't switched yet.">{''}</Row>
            {cards('agentView.default', [
              { v: 'terminal', label: 'Terminal', icon: <Icon name="terminal" />, desc: 'The harness itself, as it runs in tmux. Every agent has one.' },
              { v: 'conversation', label: 'Conversation', icon: <Icon name="message-square" />, desc: "mootr's view of the conversation, for harnesses that have one. Agents without one open in their terminal." },
            ], undefined, 'Agents open in')}
          </div>
          {own.length ? (
            <div className="set-note"><span>Switched by you: {own.map((a) => `${a.name} (${a.default_view})`).join(', ')}.</span>
              <button className="btn" type="button" onClick={() => { for (const a of own) void setDefaultView(a, null) }}>Use this default for them too</button></div>
          ) : null}
        </>
      )
    },
    types() {
      const openInstructions = (t: string) => {
        setSec('instructions')
        try { localStorage.setItem(SECTION_KEY, 'instructions') } catch {}
        setTpl(`type-${t}`)
        setEdit(true)
        rerender()
      }
      const changed = async () => {
        const [r, templates] = await Promise.all([api<Registry>('GET', '/api/registry'), api<Template[]>('GET', '/api/templates')])
        update({ reg: r, templates })
      }
      return <TypesSettings reg={reg} agents={agents} onChanged={changed} openInstructions={openInstructions} openType={openType} write={sharedWrite} readOnly={ro('agentTypes')} why={why} />
    },
    requirements() {
      const on = getPath(s, 'requirements.enabled') === true
      const rq = (key: string) => `requirements.${key}`
      // Turning them on or off shows or hides them everywhere at once, not at the next poll.
      const enable = (el: HTMLInputElement) => { setPath(s, 'requirements.enabled', el.checked); void save().then(() => refreshReq()) }
      return (
        <>
          <p className="lede">An optional tree of requirements. A model checks mail, issues, branches, and tool calls against them; a check is an indication, never proof.</p>
          <div className="set-card" data-req-settings>
            <Row label="Requirements" help="Shows them in the sidebar and checks work against them. Off, nothing is checked or shown.">
              <label className="check" title={ro(rq('enabled')) ? why : undefined}><ChangeInput type="checkbox" data-req-enabled disabled={ro(rq('enabled'))} defaultChecked={on} onValue={enable} />On</label>
            </Row>
            {on ? <div className="set-note" data-req-observe-note><Icon name="info" size="xs" /><span>Seeded and imported requirements start in observe: their checks are recorded and nobody is told until you change their mode.</span></div> : null}
            <Row label="Who approves drafts" help="Who may put a drafted requirement in force.">{''}</Row>
            {cards(rq('approval'), [
              { v: 'human', label: 'Only you', icon: <Icon name="user" />, desc: 'Every draft waits for you.' },
              { v: 'cos', label: 'Chief of staff or you', icon: <Icon name="crown" />, desc: 'The chief of staff approves drafts it didn\'t write.' },
              { v: 'any', label: 'Anyone', icon: <Icon name="users" />, desc: 'Any agent may approve a draft, its own included.' },
            ], REQ_DEFAULTS.approval, 'Who approves drafts')}
            <Row label="Default threshold" help="How likely a violation must be before a new requirement acts on it.">{num(rq('defaultThreshold'), { pct: true, unit: '%', min: 0, max: 100, step: 5, dflt: REQ_DEFAULTS.defaultThreshold })}</Row>
            <Row label="Default mode" help="What a new requirement does on a likely violation: record it, tell whoever caused it, or also hold the merge.">
              {seg(rq('defaultMode'), [{ v: 'observe', label: 'Observe' }, { v: 'inform', label: 'Inform' }, { v: 'enforce', label: 'Enforce' }], REQ_DEFAULTS.defaultMode)}
            </Row>
            <Row label="Daily cap" help="The most the checks may spend on the model in a day; past it they pause until the next day.">{num(rq('dailyCapUsd'), { unit: 'USD', min: 0, step: 0.5, dflt: REQ_DEFAULTS.dailyCapUsd })}</Row>
            <Row label="Key prefix" help="Starts each new requirement's key, as in R-12. Letters only.">
              <ChangeInput type="text" className="wide" pattern="[A-Za-z]+" title="Letters only, such as R" disabled={ro(rq('keyPrefix'))} data-kind="text" defaultValue={(getPath(s, rq('keyPrefix')) as string | undefined) ?? ''} placeholder={REQ_DEFAULTS.keyPrefix} spellCheck={false} onValue={onInput(rq('keyPrefix'))} />
            </Row>
            <Row label="Demote after" help="A requirement drops to observe for false positives only once it has this many likely violations.">{num(rq('demoteMinFlags'), { unit: 'flags', min: 1, dflt: REQ_DEFAULTS.demoteMinFlags })}</Row>
          </div>
          <div className="set-card">
            <Row label="Import" help={<>Create requirements from a JSON file: a list, or <code>{'{"requirements": [...]}'}</code>, parents first.</>}><ReqImport enabled={on} /></Row>
          </div>
        </>
      )
    },
    workcols() {
      const cos = s.chiefOfStaff as string | undefined
      return <Ro off={ro('workViews')} why={why}><WorkColumnsSettings cos={cos ? agents.find((a) => a.id === cos || a.name === cos)?.name ?? cos : null} /></Ro>
    },
    mail() {
      return (
        <>
          <p className="lede">How often agents mail you. Every mail to you is written to stand alone: short, outcome first, one issue per thread.</p>
          <div className="set-card">{cards('humanMail.when', [
            { v: 'necessary', label: 'Only when necessary', icon: <Icon name="shield-alert" />, desc: 'A decision only you can make, something broken you must know about now, or a result you asked for. No progress updates.' },
            { v: 'important', label: 'Important things', icon: <Icon name="info" />, desc: 'Also finished work and findings that change the plan. No routine progress.' },
            { v: 'everything', label: 'Everything', icon: <Icon name="mail" />, desc: 'Follow all work: starts, key decisions, problems, and finishes, each in its own thread.' },
          ], undefined, 'When to mail you')}</div>
          <div className="set-card">
            <h3>Who may mail you</h3>
            <p className="muted">Which models' agents may mail you or move an ITSA to a status that waits on you. An agent that may not hands it to its parent, which decides what reaches you.</p>
            {Object.keys(reg.models).sort().map((m) => {
              // The effective map: the defaults, then the file's own entries, as the daemon reads them.
              const mm = { ...MAIL_MODEL_DEFAULTS, ...((((s.humanMail ?? {}) as Obj).models ?? {}) as Obj) } as Record<string, boolean>
              return (
                <Row key={m} label={m} cls="model-row">
                  <label className="check" title={ro('humanMail') ? why : undefined}><ChangeInput type="checkbox" disabled={ro('humanMail')} data-kind="bool" defaultChecked={mm[m] !== false} onValue={(el) => set('humanMail.models', { ...mm, [m]: el.checked })} />May mail you</label>
                </Row>
              )
            })}
          </div>
          <div className="set-card">
            <Row label="Check my mail" help="Ask the decision model whether each mail to you follows the rules above, and show the verdict on the message.">{toggle('decisions.mailCheck')}</Row>
            <Row label="Check mail before it is sent" help="Ask the decision model about an agent's mail to you before it is delivered. A mail you don't need, or one with fluff, is refused and the agent fixes it. An agent that disagrees resends with a reason, and you see a mark with that reason on the message. If the check can't run, the mail goes through.">{toggle('decisions.mailGate')}</Row>
            <Row label="Prompt input starts in" help="Mail: what you type is mailed to the agent, and the answer comes to your mail. Direct: it is typed into the agent's terminal. A prompt input can switch for itself; this sets where each starts.">
              <select defaultValue={s.promptDefaultMode === 'direct' ? 'direct' : 'mail'} disabled={ro('promptDefaultMode')} title={ro('promptDefaultMode') ? why : undefined} onChange={(e) => set('promptDefaultMode', e.target.value)}>
                <option value="mail">Mail</option>
                <option value="direct">Direct</option>
              </select>
            </Row>
            <Row label="Mail titles" help="An OpenRouter model that gives every mail a title of one to three words, shown next to its subject, and every mail to you a one-line summary for the swipe cards. A small, cheap model is enough, such as google/gemma-3-4b-it. Empty: off, nothing is spent."><ModelPicker kind="openrouter" value={(getPath(s, 'mail.titles.model') as string | undefined) ?? ''} placeholder="Off" label="Mail titles model" disabled={ro('mail.titles.model')} title={ro('mail.titles.model') ? why : undefined} onChange={(id) => set('mail.titles.model', id)} /></Row>
          </div>
        </>
      )
    },
    activity() {
      return (
        <>
          <p className="lede">What each agent spends its time and cost on. See the breakdown on the <a href="#usage" onClick={(e) => { e.preventDefault(); openUsageActivity() }}>Usage page</a>.</p>
          <div className="set-card">
            <Row label="Classify activity" help="Ask the decision model what each activity item the rules can't settle is for, a few at a time. Off by default: nothing is spent until you turn it on.">{toggle('activity.classify.enabled')}</Row>
            <Row label="Daily cap" help="No more than this is spent on classifying activity in a UTC day.">{num('activity.classify.maxUsdPerDay', { unit: '$', min: 0, step: 0.05 })}</Row>
            <Row label="Items at once" help="How many items are classified in parallel. More than 4 hits OpenRouter's rate limit.">{num('activity.classify.concurrency', { min: 1, max: 4 })}</Row>
            <Row label="Classify since…" help="Label the open items from a date now, not only new ones. Spends OpenRouter credit, up to the daily cap, and needs the classifier on.">
              <Ro off={ro('activity')} why={why}><ClassifySince /></Ro>
            </Row>
          </div>
        </>
      )
    },
    notifications: () => <Ro off={ro('notify')} why={why}><NotifySettings /></Ro>,
    chief: () => <TreeCheckSettings treeCheck={(s.treeCheck ?? {}) as TreeCheck} disabled={ro('treeCheck')} why={why} set={set} onEdit={() => setSec('messages')} />,
    retros: () => <RetroSettings retro={(s.retro ?? {}) as Retro} lastDigest={(base.current.retro as Obj | undefined)?.lastDigest as string | null | undefined} disabled={ro('retro')} why={why} set={set} />,
    skills: () => <SkillsSettings />,
    motion: () => <Ro off={ro('motion')} why={why}><MotionSettings /></Ro>,
    sidebar: () => <SidebarSettings />,
    tools: () => <ToolsSettings onAddStep={(t) => { setStepTool(t); setSec('steps') }} />,
    tiny: () => <TinyModelsSettings s={s} disabled={ro('tiny')} why={why} set={set} />,
    steps: () => <Ro off={ro('decisions')} why={why}><StepsSettings key={stepTool ?? ''} addTool={stepTool} /></Ro>,
    context() {
      const c = (s.context ?? {}) as Record<string, number>
      const max = c.enforceTokens || 1
      const mark = (v: number, cls: string, label: string) => <b className={cls} style={{ left: `${Math.min(100, (v / max) * 100)}%` }} title={label} />
      const k = { k: true, unit: 'k tokens', step: 10 }
      return (
        <>
          <p className="lede">Long conversations cost more and get worse. mootr warns an agent, then asks it to compact, then compacts it when its turn ends.</p>
          <div className="set-card">
            <div className="ctx-bar"><i />{mark(c.warnTokens, 'w', 'Warning')}{mark(c.instructTokens, 'a', 'Asked to compact')}{mark(c.enforceTokens, 'e', 'Compacted')}</div>
            <Row label="Warn at" help="The agent hears it is getting long.">{num('context.warnTokens', k)}</Row>
            <Row label="Ask to compact at" help="The agent is asked to compact itself.">{num('context.instructTokens', k)}</Row>
            <Row label="Compact at" help="mootr compacts it when its turn ends.">{num('context.enforceTokens', k)}</Row>
            <Row label="After a compaction, count only once grown by" help="A threshold counts only once the context has grown this much past its size right after the last compaction. Also the growth that triggers compaction while idle.">{num('idleCompaction.growthTokens', k)}</Row>
          </div>
          <h3>Compaction while idle</h3>
          <div className="set-card">
            <Row label="Compact idle agents" help="Prompt caches expire after about an hour, so an idle agent compacts before then.">{toggle('idleCompaction.enabled')}</Row>
            <Row label="After idle for">{num('idleCompaction.idleMinutes', { unit: 'minutes', min: 1 })}</Row>
            <Row label="And at least">{num('idleCompaction.minTokens', k)}</Row>
          </div>
        </>
      )
    },
    spend() {
      const pcts = ((getPath(s, 'cost.subscriptionWarnPercent') ?? []) as number[])
      const mode = getPath(s, 'cost.display.mode') ?? 'api'
      const prices = (getPath(s, 'cost.display.prices') ?? {}) as Record<string, number>
      const accounts = (getPath(s, 'cost.accounts') ?? {}) as Record<string, { subscription?: boolean }>
      const subAccounts = Object.keys(accounts).filter((name) => accounts[name]?.subscription !== false && name !== 'openrouter-system')
      // An empty price removes the account's price; a finite positive number sets it. Anything else
      // resets the field to the stored price and saves nothing.
      const setPrice = (name: string) => (el: HTMLInputElement) => {
        const stored = (getPath(s, 'cost.display.prices') ?? {}) as Obj
        const text = el.value.trim()
        if (text === '') {
          if (!(name in stored)) return
          delete stored[name]
        } else {
          const n = Number(text)
          if (!(Number.isFinite(n) && n > 0)) { el.value = stored[name] == null ? '' : String(stored[name]); return }
          if (stored[name] === n) return
          const cost = (s.cost ??= {}) as Obj
          const display = (cost.display ??= {}) as Obj
          ;((display.prices ??= {}) as Obj)[name] = n
        }
        void save()
      }
      const addPct = (el: HTMLInputElement) => {
        const v = Math.round(Number(el.value))
        if (!(v > 0 && v <= 100)) return
        const cost = (s.cost ??= {}) as Obj
        const list = ((cost.subscriptionWarnPercent ??= []) as number[])
        if (!list.includes(v)) list.push(v)
        list.sort((x, y) => x - y)
        void save()
      }
      // One OpenRouter budget (cost.accounts.<name>.budget): an amount and a period. The system account is
      // created on first use with a match no agent has (docs/cost-policy.md); clearing the amount removes
      // only the budget.
      const budgetRow = (name: string, label: string, help: string) => {
        const path = `cost.accounts.${name}.budget`
        const b = getPath(s, path) as { usd?: number; per?: string } | null | undefined
        const per = b?.per ?? 'month'
        const setAmount = (el: HTMLInputElement) => {
          const n = Number(el.value)
          if (el.value === '' || n === 0) { set(path, null); return }
          if (!(Number.isFinite(n) && n > 0)) { el.value = b?.usd == null ? '' : String(b.usd); return }
          // The daemon refuses an account with no match: the agents account matches OpenRouter models on OpenCode.
          if (getPath(s, `cost.accounts.${name}.match`) == null) setPath(s, `cost.accounts.${name}.match`, name === 'openrouter-system' ? { harness: 'stam' } : { harness: 'opencode', model: 'openrouter/' })
          set(path, { ...b, usd: n, per } as Json)
        }
        return (
          <Row label={label} help={help}>
            <span className="budget-ctl">
              <span className="num">
                <ChangeInput type="number" min={0} step={1} disabled={ro('cost')} title={ro('cost') ? why : undefined} data-kind="num" aria-label={`${label} budget, USD`} defaultValue={b?.usd ?? ''} placeholder="Off" onValue={setAmount} />
                <span className="unit">USD</span>
              </span>
              <span className="seg" role="group" aria-label={`${label} budget period`}>{(['day', 'week', 'month', 'cap'] as const).map((p) => (
                <button type="button" key={p} className={per === p ? 'on' : ''} disabled={ro('cost') || b?.usd == null} title={ro('cost') ? why : b?.usd == null ? 'Set an amount first' : undefined} onClick={() => set(path, { ...b, usd: b!.usd, per: p } as Json)}>{p === 'cap' ? 'Until raised' : p}</button>
              ))}</span>
            </span>
          </Row>
        )
      }
      return (
        <>
          <p className="lede">mootr mails you when spending crosses these lines, and gives your cost instructions to the agents who manage cost.</p>
          <h3>OpenRouter budgets</h3>
          <div className="set-card">
            {budgetRow('openrouter', 'Agents', 'What agents on OpenRouter models may spend. A spent agents budget never stops mootr\'s own calls. Empty: no cap.')}
            {budgetRow('openrouter-system', 'System', 'What mootr\'s own model calls may spend: the mail gate, summaries, titles and decisions. Spent: those calls pause. Empty: no cap.')}
            <Row label="System reserve" help="Credit kept for mootr's own calls when there is no system budget: new OpenRouter agents are held while the credit is at or below it.">{num('cost.openrouterSystemReserveUsd', { unit: 'USD', dflt: 1, step: 0.5 })}</Row>
          </div>
          <div className="set-card">
            <div className="set-field">
              <b>Cost instructions</b>
              <p>Free text for the agents who manage cost — the chief of staff and any agent with children. mootr puts it in their instructions and in <code>usage_info</code>. Empty: no Cost section.</p>
              {longtext('cost.instructions', 'How managers should manage cost…')}
            </div>
          </div>
          <div className="set-card">
            <Row label="Daily spend" help="Mail you when today's spend across agents passes this. Empty: never.">{num('cost.dailyWarnUsd', { unit: 'USD', step: 1, nullable: true })}</Row>
            <Row label="Subscription windows" help="Mail you when a window (such as Claude's 5-hour and weekly limits) passes each of these.">
              <Ro off={ro('cost.subscriptionWarnPercent')} why={why}><div className="chips">
                {pcts.map((p, i) => (
                  <span className="chip-edit" key={p}>{p}%<button aria-label={`Remove ${p}%`} onClick={() => { (getPath(s, 'cost.subscriptionWarnPercent') as number[]).splice(i, 1); void save() }}><Icon name="x" size="xs" /></button></span>
                ))}
                <span className="num small"><input type="number" min={1} max={100} placeholder="Add" onKeyDown={(e) => { if (e.key === 'Enter') addPct(e.currentTarget) }} /><span className="unit">%</span></span>
              </div></Ro>
            </Row>
          </div>
          <h3>How cost is shown</h3>
          <div className="set-card">
            {cards('cost.display.mode', COST_MODES, 'api', 'How cost is shown')}
          </div>
          <div className="set-card">
            {subAccounts.length ? subAccounts.map((name) => (
              <Row key={name} label={name} help={mode === 'subscription' && prices[name] == null ? "No price yet, so Subscription can't show this account's cost." : 'USD per month. Used by the Subscription mode only.'}>
                <span className="num">
                  <ChangeInput type="number" min={0} step={1} disabled={ro('cost')} title={ro('cost') ? why : undefined} data-kind="num" aria-label={`${name} price, USD per month`} defaultValue={prices[name] ?? ''} placeholder="Price" onValue={setPrice(name)} />
                  <span className="unit">USD/month</span>
                </span>
              </Row>
            )) : <p className="muted">No subscription accounts.</p>}
          </div>
        </>
      )
    },
    machines() {
      const peers = (s.peers ?? []) as { name: string; url: string; token: string }[]
      return (
        <>
          <p className="lede">Other machines' mootr daemons. Agents on any machine see and mail each other. This machine is <b>{machine}</b>. <span className="chip scope-tag">This machine</span></p>
          <div className="set-card">
            {peers.length ? peers.map((p, i) => (
              <div className="peer-row" key={i}>
                <Icon name="server" />
                <ChangeInput type="text" data-kind="text" defaultValue={p.name} placeholder="Name" spellCheck={false} onValue={onInput(`peers.${i}.name`)} />
                <ChangeInput type="text" className="wide" data-kind="text" defaultValue={p.url} placeholder="http://machine:7878" spellCheck={false} onValue={onInput(`peers.${i}.url`)} />
                <ChangeInput type="password" data-kind="text" defaultValue={p.token} placeholder="Token" autoComplete="off" onValue={onInput(`peers.${i}.token`)} />
                <button className="icon-btn" title={`Remove ${p.name}`} onClick={() => { if (!confirm(`Remove ${p.name || 'this machine'}?`)) return; peers.splice(i, 1); void save() }}><Icon name="trash-2" /></button>
              </div>
            )) : <p className="muted">No other machines.</p>}
            <button className="btn" onClick={() => { ((s.peers ??= []) as Json[]).push({ name: '', url: 'http://', token: '' }); void save() }}><Icon name="plus" />Add a machine</button>
          </div>
        </>
      )
    },
    resources() {
      const list = (getPath(s, 'resourceWarn.recipients') as string[] | undefined) ?? []
      return (
        <>
          <p className="lede">Mail to the recipients when this machine's load, free memory, swap, or root disk crosses a line. Load, memory, and swap mail again every repeat interval while they stay across; the disk mails once per crossing.</p>
          <div className="set-card">
            <Row label="Warn" help="Off: no resource mail from this machine.">{toggle('resourceWarn.enabled', 'On')}</Row>
            <Row label="CPU load" help="The one-minute load average per core. Mail above this.">{num('resourceWarn.loadPerCore', { step: 0.1 })}</Row>
            <Row label="Free RAM" help="Mail when available memory is under this.">{num('resourceWarn.ramAvailableGb', { step: 0.5, unit: 'GB' })}</Row>
            <Row label="Swap used" help="Mail when swap used is over this share.">{num('resourceWarn.swapPct', { step: 5, unit: '%' })}</Row>
            <Row label="Disk used" help="Mail once when the root disk is fuller than this share; again after it drops 5 points below and crosses it once more.">{num('resourceWarn.diskPct', { step: 5, unit: '%' })}</Row>
            <Row label="Repeat" help="While a line stays crossed, mail again after this many minutes.">{num('resourceWarn.repeatMinutes', { unit: 'minutes' })}</Row>
            <Row label="Recipients" help="Agent names, or human, comma-separated. Empty: the chief of staff.">
              <ChangeInput type="text" className="wide" disabled={ro('resourceWarn.recipients')} title={ro('resourceWarn.recipients') ? why : undefined} data-kind="text" defaultValue={list.join(', ')} placeholder="Chief of staff" spellCheck={false}
                onValue={(el) => set('resourceWarn.recipients', el.value.split(',').map((x) => x.trim()).filter(Boolean))} />
            </Row>
          </div>
        </>
      )
    },
    mcp() {
      return <Ro off={ro('mcpServers')} why={why}><McpSettings servers={(s.mcpServers ?? {}) as Servers} onChange={(next) => { s.mcpServers = next as Json; void save() }} /></Ro>
    },
    instructions() {
      const group = groups.find((g) => g.items.some((i) => i.name === curName)) ?? groups[0]
      if (!group) return <p className="muted">No instruction texts.</p>
      const item = group.items.find((i) => i.name === curName) ?? group.items[0]
      const who = group.names.length ? group.names.join(', ') : 'no agent of this type right now'
      const key = item.file ? 'instructions' : 'tpl'
      return (
        <>
          <p className="lede">What mootr tells each type of agent, at its next start. Markdown; mootr fills in the <code>{'{{name}}'}</code> placeholders. Instruction files in the repo (<code>CLAUDE.md</code>, <code>AGENTS.md</code>) stay in the repo and are visible per agent.</p>
          <p className="lede"><button className="btn" onClick={() => openWorld('inventory')}><Icon name="layers" size="xs" />Inventory by type</button> Every layer and block an agent of a type receives, with sizes and summaries.</p>
          <div className="set-card">
            <Row label="Instruction summaries" help="An OpenRouter model that writes a two-line summary of each block in the Inventory, cached until the block's text changes. A small, cheap model is enough, such as the one for Mail titles. Empty: off, nothing is spent."><ModelPicker kind="openrouter" value={(getPath(s, 'instructions.summaries.model') as string | undefined) ?? ''} placeholder="Off" label="Instruction summaries model" disabled={ro('instructions.summaries.model')} title={ro('instructions.summaries.model') ? why : undefined} onChange={(id) => set('instructions.summaries.model', id)} /></Row>
          </div>
          <div className={`tpl-layout instr${edit ? ' editing' : ''}`}>
            <div className="tpl-list">
              {groups.map((g) => (
                <Fragment key={g.key}>
                  <div className="tpl-group"><span>{g.label}</span><span className="who">{g.names.length ? g.names.join(', ') : 'no agent right now'}</span></div>
                  {g.items.map((it) => (
                    <button key={it.name} className={`item ${it.name === curName ? 'sel' : ''}`} onClick={() => { setTpl(it.name); setEdit(true); rerender() }}>
                      <span className="tpl-name">{it.label}</span>
                      {it.name.startsWith('human-mail-when-') ? <span className="muted">{it.active ? 'active' : 'inactive'}</span> : null}
                      {templates?.find((t) => t.name === it.name)?.overridden ? <span className="dot" title="Edited" /> : null}
                    </button>
                  ))}
                </Fragment>
              ))}
            </div>
            <div className="set-card text-card tpl-editor">
              <button className="btn tpl-back" onClick={() => setEdit(false)}><Icon name="arrow-left" size="xs" />Instructions</button>
              <div className="tpl-head"><b>{group.label} · {item.name}.md</b><span className="muted">Applies to {who}. Edits apply at the agent's next start.</span></div>
              {draft(key)}
              <div className="row">
                <button className="btn primary" onClick={() => void (item.file ? saveFile('instructions') : saveTpl(false))}>Save</button>
                {!item.file ? <button className="btn" hidden={!curTpl?.overridden} onClick={() => void saveTpl(true)}>Reset to default</button> : null}
                <span className="muted msg">{msgs[key]}</span>
              </div>
            </div>
          </div>
        </>
      )
    },
    messages() {
      const notices = loaded!.templates.filter((x) => !isInstruction(x.name))
      return (
        <>
          <p className="lede">The notices mootr sends agents when something happens, such as mail arriving or a permission request. mootr fills in the <code>{'{{name}}'}</code> placeholders.</p>
          <div className="tpl-layout">
            <div className="tpl-list">{notices.map((x) => (
              <button key={x.name} className={`item ${x.name === curTpl?.name ? 'sel' : ''}`} onClick={() => { setTpl(x.name); rerender() }}>{x.name}{x.overridden ? <span className="dot" title="Edited" /> : null}</button>
            ))}</div>
            <div className="set-card text-card">
              {draft('tpl')}
              <div className="row"><button className="btn primary" onClick={() => void saveTpl(false)}>Save</button><button className="btn" hidden={!curTpl?.overridden} onClick={() => void saveTpl(true)}>Reset to default</button><span className="muted msg">{msgs.tpl}</span></div>
            </div>
          </div>
        </>
      )
    },
    advanced() {
      const block = (key: string, label: string, help: ReactNode) => <><h3>{label}</h3><p className="muted">{help}</p>{textCard(key, 'code')}</>
      return (
        <>
          <p className="lede">Settings with no form yet, as JSON.</p>
          {block('banners', 'Harness menus to dismiss', "Menus that pop up over an idle agent's input and block delivery; mootr sends the keys.")}
          {block('registry', 'Registry', 'Presets, models, and harnesses that replace the shipped defaults by key (registry.json).')}
          {block('settings', 'All settings', 'The whole settings.json.')}
        </>
      )
    },
  }

  const current = SECTIONS.find((x) => x.key === sectionKey)!
  return (
    <div className="settings-view">
      <nav className="settings-nav">
        <div className="eyebrow">Settings</div>
        {SECTIONS.map((x) => (
          <button key={x.key} className={`item ${x.key === sectionKey ? 'sel' : ''}`} onClick={() => { setSec(x.key); setStepTool(null); try { localStorage.setItem(SECTION_KEY, x.key) } catch {} setStatus(null); setMsgs({}) }}>
            <Icon name={x.icon} /><span>{x.label}</span>
          </button>
        ))}
        {/* The stories page: every component with its states and rules (docs/stories.md). */}
        <a className="item" href="/stories" target="_blank" rel="noreferrer"><Icon name="layout-list" /><span>Component stories</span></a>
        {isLocalSession() && <button className="item" id="local-logout" onClick={() => void logout(token)}><Icon name="log-out" /><span>Log out</span></button>}
        <div className="saved muted" aria-live="polite">{status}</div>
      </nav>
      <div className="settings-body">
        <div className="settings-inner" key={rev}>
          <h2>{current.label}</h2>
          <ScopeNote scope={scope} machine={machine} url={(((s.peers ?? []) as { name: string; url: string }[]).find((p) => p.name === scope.home))?.url} />
          {sections[current.key]()}
        </div>
      </div>
    </div>
  )
}

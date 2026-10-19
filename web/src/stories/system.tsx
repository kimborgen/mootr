// What the system view's stories share: invented agent graphs with their ITSAs and spend, a
// stage to draw one card on, and a scene that arranges an event (mail, a spawn, an archive) once
// the view has drawn. Nothing here is real: every name is a fixture (fixtures.ts).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import { getData, setData, type Data } from '../store'
import { readTiming, type Timing } from '../system/springs'
import { TimingContext } from '../system/Roll'
import type { Agent, AgentCost, CostModes, Itsa, ItsaAttention, Wait } from '../types'
import { agent } from './fixtures'
import { STATUSES } from './mailFixtures'

const T0 = '2026-10-01T09:00:00.000Z'
const TODAY = new Date().toISOString()
const inMinutes = (m: number) => new Date(Date.now() + m * 60000).toISOString()
const modes = (api: number): CostModes => ({ api, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 })
// An agent's spend in API dollars: its own, and with the agents under it.
export const cost = (own: number, tree = own): AgentCost => ({ mode: 'api', own: modes(own), tree: modes(tree) })
const wait = (kind: string, o: Partial<Wait> = {}): Wait => ({ id: `w-${kind}`, kind, since: T0, source: 'wait_for', ...o })

export function itsa(o: Partial<Itsa> & { id: string; key: string; title: string }): Itsa {
  return { parent_id: null, kind: 'issue', summary: null, body: null, status: 'in_progress', owner: null, thread_id: null, created_by: 'human', created_at: T0, updated_at: T0, closed_at: null, links: [], participants: [], ...o }
}
export const worker = (id: string, name: string, parent: string, o: Partial<Agent> = {}) => agent({ id, name, parents: [parent], role: 'developer', ...o })

// Six agents under a chief of staff: every harness (Claude Code, Codex, OpenCode) and the states a
// card shows: working, waiting, blocked on you, errored, paused.
const SMALL: Agent[] = [
  agent({ id: 'sv-cos', name: 'fixture-cos', role: 'chief of staff', chief_of_staff: true, cost: cost(3.2, 7.1), unread: 0 }),
  worker('sv-dev', 'fixture-dev', 'sv-cos', { activity: 'working', activity_detail: 'Editing the tree layout', context_tokens: 310000, context_level: 1, cost: cost(2.4), unread: 2 }),
  worker('sv-review', 'fixture-review', 'sv-cos', { role: 'reviewer', harness: 'codex', model: 'gpt-6.1-sol', activity: 'waiting', waits: [wait('timer', { until: inMinutes(4) })], cost: cost(0.8), unread: 1, context_tokens: 90000 }),
  worker('sv-ops', 'fixture-ops', 'sv-cos', { harness: 'opencode', model: 'openrouter/fixture/flash', activity: 'blocked', pending_requests: 1, waits: [wait('human', { target: 'perm-1' })], cost: cost(0.3), context_tokens: 40000 }),
  worker('sv-broken', 'fixture-broken', 'sv-cos', { harness: 'codex', model: 'gpt-6.1-sol', activity: 'errored', cost: cost(0.1), context_tokens: 480000, context_level: 2 }),
  worker('sv-paused', 'fixture-paused', 'sv-cos', { harness: 'opencode', model: 'openrouter/fixture/flash', lifecycle: 'paused', activity: null, cost: cost(0.05) }),
]
const SMALL_ITSAS: Itsa[] = [
  itsa({ id: 'si-1', key: 'FX-1', title: 'Fixture epic: a faster tree', owner: 'sv-cos' }),
  itsa({ id: 'si-2', key: 'FX-2', title: 'Lay out the tree', parent_id: 'si-1', owner: 'sv-dev', health: 'at_risk' }),
  itsa({ id: 'si-3', key: 'FX-3', title: 'Review the layout', parent_id: 'si-1', owner: 'sv-review', status: 'in_review' }),
  itsa({ id: 'si-4', key: 'FX-4', title: 'Deploy the preview', parent_id: 'si-1', owner: 'sv-ops', status: 'needs_approval' }),
  itsa({ id: 'si-5', key: 'FX-5', title: 'Name the wires', parent_id: 'si-1', owner: 'sv-dev', status: 'done', closed_at: TODAY }),
]

// Three managers with four or five agents each, across all three harnesses and every state.
const HARNESS = [
  { harness: 'claude', model: 'claude-opus-5-5' }, { harness: 'codex', model: 'gpt-6.1-sol' }, { harness: 'opencode', model: 'openrouter/fixture/flash' }, { harness: 'claude', model: 'claude-haiku-5-5' },
]
const STATE: Partial<Agent>[] = [
  { activity: 'working' }, { activity: 'idle' }, { activity: 'working', context_tokens: 300000, context_level: 1 }, { activity: 'blocked', pending_requests: 1 },
  { activity: 'waiting', waits: [wait('agent', { target: 'sv-cos' })] }, { activity: 'errored' }, { lifecycle: 'paused', activity: null }, { activity: 'idle' },
]
function large(): { agents: Agent[]; itsas: Itsa[] } {
  const agents: Agent[] = [
    agent({ id: 'sv-cos', name: 'fixture-cos', role: 'chief of staff', chief_of_staff: true, cost: cost(6.4, 42.3), unread: 0 }),
    worker('sv-assist', 'fixture-assistant', 'sv-cos', { role: 'assistant', cost: cost(0.6), unread: 1 }),
  ]
  const itsas: Itsa[] = [itsa({ id: 'li-0', key: 'FX-100', title: 'Fixture initiative: the whole system', owner: 'sv-cos' })]
  let n = 0
  for (const [m, topic] of ['storybook', 'billing', 'search'].entries()) {
    const mid = `sv-mgr${m}`
    agents.push(worker(mid, `fixture-${topic}`, 'sv-cos', { role: 'manager', activity: m === 1 ? 'blocked' : 'working', cost: cost(1.1 + m, 9 + m * 3), unread: m, context_tokens: 150000 }))
    itsas.push(itsa({ id: `li-m${m}`, key: `FX-${101 + m}`, title: `Fixture project: ${topic}`, parent_id: 'li-0', owner: mid }))
    for (let k = 0; k < 4 + (m % 2); k++, n++) {
      const id = `sv-w${n}`
      const h = HARNESS[n % HARNESS.length]
      agents.push(worker(id, `fixture-${topic}-${k + 1}`, mid, { ...h, ...STATE[n % STATE.length], cost: cost(0.2 + ((n * 37) % 90) / 20), unread: n % 3 === 0 ? 1 + (n % 2) : 0 }))
      const status = ['in_progress', 'in_review', 'in_progress', 'needs_input', 'in_progress', 'done', 'in_progress', 'in_review'][n % 8]
      itsas.push(itsa({ id: `li-${id}`, key: `FX-${110 + n}`, title: `Fixture task ${n + 1} of ${topic}`, parent_id: `li-m${m}`, owner: id, status, closed_at: status === 'done' ? TODAY : null }))
    }
  }
  return { agents, itsas }
}
const LARGE = large()

// The ITSA ask that the human's card counts ("1 waiting on you").
const ASK: ItsaAttention = { ...SMALL_ITSAS[3], since: T0, actions: [], ask_thread_id: null, ask_mail_id: null }

export type Scale = 'small' | 'large'
// The store for a state: the agents, their ITSAs and statuses, the human's unread count, and the
// one ITSA waiting on them.
export function systemData(scale: Scale = 'small'): Partial<Data> {
  const g = scale === 'small' ? { agents: SMALL, itsas: SMALL_ITSAS } : LARGE
  return { agents: g.agents, itsas: g.itsas, itsaStatuses: STATUSES, unread: 3, attention: scale === 'small' ? [ASK] : [{ ...g.itsas.find((i) => i.status === 'needs_input')!, since: T0, actions: [] }] }
}

// GET /api/usage for the header's instruments: an account's windows, and the day's spend.
export const USAGE = {
  today: { cost_usd: 12.4 },
  accounts: [
    { account: 'fixture-claude', match: { harness: 'claude' }, windows: { five_hour: { used_percentage: 86 }, seven_day: { used_percentage: 18 } } },
    { account: 'fixture-codex', match: { harness: 'codex' }, windows: { five_hour: { used_percentage: 41 }, seven_day: { used_percentage: 12 } } },
  ],
  by_day: Array.from({ length: 14 }, (_, i) => ({ day: `2026-09-${String(17 + i).padStart(2, '0')}`, cost_usd: 4 + ((i * 7) % 9) })),
}
export const USAGE_ROUTES = { 'GET /api/usage': USAGE }

// The agents with one changed or added, for a state's event: it reads the store as it stands.
export const withAgent = (a: Agent) => setData({ agents: [...getData().agents.filter((x) => x.id !== a.id), a] })
export const patchAgent = (id: string, p: Partial<Agent>) => setData({ agents: getData().agents.map((x) => (x.id === id ? { ...x, ...p } : x)) })
export const patchItsa = (id: string, p: Partial<Itsa>) => setData({ itsas: getData().itsas.map((x) => (x.id === id ? { ...x, ...p } : x)) })

interface Deckish { geo: unknown; mail(m: { id: string; from: string; to: string[]; ask: boolean; thread: string | null }): void }
interface Debug { systemDeck?: Deckish }
// The view hands its flight deck to `window.stamDebug`, which only exists where the app set it up:
// make it exist before the view draws.
export function ensureDebug(): void {
  const w = window as unknown as { stamDebug?: Debug }
  w.stamDebug ??= {}
}
const deckNow = () => (window as unknown as { stamDebug?: Debug }).stamDebug?.systemDeck

export interface Act {
  wait: (ms: number) => Promise<void>
  // Resolves when the view has laid out its cards, so an event that needs a card's place can run.
  drawn: () => Promise<boolean>
  mail: (id: string, from: string, to: string[], ask?: boolean) => void
  alive: () => boolean
}
// Draws children in a box of a given height, then runs `act` once: it plays an event for a reader
// who opens the story, the way the live stream would bring it. Cancelled when the state goes.
export function Scene({ act, height = 560, children }: { act?: (a: Act) => Promise<void>; height?: number; children: ReactNode }) {
  useEffect(() => {
    if (!act) return
    let dead = false
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const drawn = async () => {
      for (let i = 0; i < 100 && !dead; i++) {
        if (deckNow()?.geo && document.querySelector('[data-card]')) return true
        await wait(30)
      }
      return false
    }
    const mail: Act['mail'] = (id, from, to, ask = false) => deckNow()?.mail({ id, from, to, ask, thread: null })
    void act({ wait, drawn, mail, alive: () => !dead }).catch(() => {})
    return () => { dead = true }
  }, [])
  return <div style={{ height, display: 'flex', flexDirection: 'column' }}>{children}</div>
}

// The px values of the sizing tokens a card is laid out in, read through a probe as the view does.
export interface SvPx { card: number; cardH: number; orbMin: number; orbMax: number; orbHuman: number; stackOver: number; pad: number; rowGap: number; starLabelW: number; starLabelH: number; starLabelGap: number }
// A stage for a single card, orb, or instrument: the view's frame (`.sv`) with the motion tokens
// read as the view reads them, so Motion's springs and the rolls take their lengths from the tokens
// and reduced motion zeroes them.
export function SvStage({ height = 200, far = false, world = true, children }: { height?: number | ((px: SvPx) => number); far?: boolean; world?: boolean; children: (px: SvPx) => ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLElement>(null)
  const [px, setPx] = useState<SvPx | null>(null)
  const [timing, setTiming] = useState<Timing>({ slow: 0, tick: 0, keep: 0, ease: null })
  useLayoutEffect(() => {
    const p = probe.current!
    const v = (name: string) => { p.style.width = `var(${name})`; return p.getBoundingClientRect().width }
    setPx({ card: v('--sv-card-w'), cardH: v('--sv-card-h'), orbMin: v('--sv-orb-min'), orbMax: v('--sv-orb-max'), orbHuman: v('--sv-orb-human'), stackOver: v('--sv-stack-over'), pad: v('--sv-pad'), rowGap: v('--sv-row-gap'), starLabelW: v('--sv-star-label-w'), starLabelH: v('--sv-star-label-h'), starLabelGap: v('--sv-star-label-gap') })
    setTiming(readTiming(p))
  }, [])
  return (
    <MotionConfig reducedMotion="user"><TimingContext.Provider value={timing}>
      <div ref={root} className="sv" style={{ height: typeof height === 'function' ? (px ? height(px) : 0) : height }}>
        <i ref={probe} className="sv-probe" aria-hidden="true" />
        <div className="sv-body"><div className={'sv-stage' + (far ? ' far' : '')}>
          {px ? (world ? <div className="sv-world" style={{ width: '100%', height: '100%' }}>{children(px)}</div> : children(px)) : null}
        </div></div>
      </div>
    </TimingContext.Provider></MotionConfig>
  )
}

// Renders children with `late` false, then true after `after` ms: one change a state plays for a
// reader who opens it (a status, a spend, an unread count). Cancelled when the state goes.
export function Later({ after = 400, children }: { after?: number; children: (late: boolean) => ReactNode }) {
  const [late, set] = useState(false)
  useEffect(() => { const t = setTimeout(() => set(true), after); return () => clearTimeout(t) }, [after])
  return <>{children(late)}</>
}

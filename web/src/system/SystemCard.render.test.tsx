// @vitest-environment jsdom
// What a poll costs the system view's cards (S-3179 review): a poll that changes one agent re-renders only that card,
// and a poll that changes nothing a card draws re-renders none. Card calls motion's useIsPresent once per render, and
// nothing else in the card does, so that call counts the card's renders.
import { act, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cardItemMap } from '../itsa/IssueCard'
import { useCardLayout } from '../card-layout'
import { defaultCardLayout } from '../card-layout'
import { setData } from '../store'
import { agent } from '../stories/fixtures'
import type { Agent, Itsa } from '../types'
import type { WorkExtras } from '../work/data'
import type { Badge } from './model'
import { CardLayoutsContext, type CardLayouts, type CardModel, cardSig, SystemCard, issueCxSig } from './SystemCard'

const renders = vi.hoisted(() => ({ n: 0 }))
const api = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api, sendAsHuman: vi.fn() }))
vi.mock('motion/react', async (orig) => {
  const m = await orig<typeof import('motion/react')>()
  return { ...m, useIsPresent: () => { renders.n++; return m.useIsPresent() } }
})

const NO_EXTRAS: WorkExtras = { costs: null, activity: null, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }
const LAYOUTS: CardLayouts = { agent: defaultCardLayout('agent'), issue: defaultCardLayout('issue'), items: cardItemMap([]), fields: [] }

// A card's model, built the way the view builds one: its agent, activity and the cell context it carries.
const model = (a: Agent, o: Partial<CardModel> = {}): CardModel => ({
  id: a.id, short: a.name, agent: a, activity: 'Working', it: null, owns: 0, badges: [] as Badge[],
  cx: { now: 0, extras: NO_EXTRAS }, cxSig: issueCxSig(null, NO_EXTRAS),
  unread: 0, ctx: 0, ctxLevel: 0, kids: 0, folded: null, hit: '', rollup: null, ...o,
})

const AGENTS = [
  agent({ id: 'rc-a', name: 'fixture-a' }),
  agent({ id: 'rc-b', name: 'fixture-b' }),
  agent({ id: 'rc-c', name: 'fixture-c' }),
]

// The view's shape: one context value, and one card per model, each with its sig, as SystemView draws them.
function Cards({ models, layouts = LAYOUTS }: { models: CardModel[]; layouts?: CardLayouts }) {
  return (
    <CardLayoutsContext.Provider value={layouts}>
      {models.map((m, i) => (
        <SystemCard key={m.id} m={m} sig={cardSig(m)} place={{ x: i * 240, y: 0, w: 216 }} selected={false} enter={null} jump={false} far="" />
      ))}
    </CardLayoutsContext.Provider>
  )
}

const roots: Root[] = []
beforeEach(() => {
  setData({ itsaStatuses: [{ name: 'in_progress', category: 'active', human: false }] } as never)
})
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => { r.unmount() })
  document.body.innerHTML = ''
  vi.useRealTimers()
})

// Mounts the cards and returns a poll: a setter for the models, as the view's next render gives them.
async function mount(first: CardModel[]) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  let set: (ms: CardModel[]) => void = () => {}
  function Host() {
    const [ms, setMs] = useState(first)
    set = setMs
    return <Cards models={ms} />
  }
  await act(async () => { root.render(<Host />) })
  renders.n = 0
  return (ms: CardModel[]) => act(async () => { set(ms) })
}

describe('a poll and the system view cards (S-3179 review)', () => {
  it('re-renders only the card whose agent changed', async () => {
    const poll = await mount(AGENTS.map((a) => model(a)))
    await poll([model(AGENTS[0]), model(AGENTS[1], { activity: 'Waiting for a reply' }), model(AGENTS[2])])
    expect(renders.n).toBe(1)
  })

  it('re-renders no card when a poll changes nothing a card draws, even with new objects and new extras', async () => {
    const poll = await mount(AGENTS.map((a) => model(a)))
    // refreshWorkExtras replaces the extras object each poll: a new object, the same content, the same sigs.
    await poll(AGENTS.map((a) => model(a, { cx: { now: 1, extras: { ...NO_EXTRAS } } })))
    expect(renders.n).toBe(0)
  })

  it('re-renders a GitHub-linked ITSA\'s card when its watch changes, and no other card', async () => {
    const linked = { id: 'rc-l', key: 'FX-7', status: 'in_progress', title: 'Linked', links: [{ n: 1, system: 'github', external_id: null, url: 'https://github.com/o/r/pull/7' }] } as unknown as Itsa
    const itsaOf = (id: string) => (id === 'rc-b' ? linked : null)
    const poll = await mount(AGENTS.map((a) => model(a, { it: itsaOf(a.id), cxSig: issueCxSig(itsaOf(a.id), NO_EXTRAS) })))
    const watch = { 'o/r#7': { state: 'open' } } as unknown as WorkExtras['watch']
    await poll(AGENTS.map((a) => model(a, { it: itsaOf(a.id), cxSig: issueCxSig(itsaOf(a.id), { ...NO_EXTRAS, watch }) })))
    expect(renders.n).toBe(1)
  })
})

describe('a settings refresh and the system view cards (S-3179 review)', () => {
  it('re-renders no card when the settings refresh brings the same layouts', async () => {
    vi.useFakeTimers()
    // The record as main and this branch write it: a stored agent layout that has seen its fields, and a stored issue layout.
    const settings = { cardLayouts: {
      agent: { slots: { HEAD: ['model', 'cost'], ISSUE: ['issue'], BADGES: ['health'], FOOT: ['activity'] }, hairline: true, seen: ['field:f1'] },
      issue: { slots: { TOP: ['parent', 'kind', 'health'], META: ['status', 'rollup', 'links', 'owner'], BADGES: [], FOOT: [] }, titleLines: 3, seen: [] },
    } }
    api.mockReset()
    api.mockImplementation((method: string, path: string) => (method === 'GET' && path === '/api/config/settings'
      ? Promise.resolve({ text: JSON.stringify(settings) })
      : Promise.reject(new Error(`unexpected ${method} ${path}`))))
    const models = AGENTS.map((a) => model(a))
    let force: () => void = () => {}
    function Host() {
      const [, tick] = useState(0)
      force = () => tick((n) => n + 1)
      const agent = useCardLayout('agent')
      const issue = useCardLayout('issue')
      const layouts = useMemo<CardLayouts>(() => ({ agent, issue, items: cardItemMap([]), fields: [] }), [agent, issue])
      return <Cards models={models} layouts={layouts} />
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => { root.render(<Host />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const reads = () => api.mock.calls.filter(([method, path]) => method === 'GET' && path === '/api/config/settings').length
    const before = reads()
    renders.n = 0
    // A poll: the settings are read again (new record objects, the same content), then the page re-renders.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    await act(async () => { force() })
    // One read for the whole page: the agent and the issue layout share one poll (S-4610).
    expect(reads()).toBe(before + 1)
    expect(renders.n).toBe(0)
  })
})

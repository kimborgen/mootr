// @vitest-environment jsdom
// The Agents table's header and rows (S-1432): the header sorts and says which way, and a row click picks its agent. Its
// checkboxes (S-3117) check a row without picking it, and a Shift-click says so.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentsTable } from './AgentsTable'
import { buildLines, factsOf, type ColumnId } from './agents-table'
import { api } from './api'
import { getData, refreshAgents, setData } from './store'
import { agent } from './stories/fixtures'
import type { Agent } from './types'

vi.mock('./api', () => ({ api: vi.fn(async () => ({})), hash: new URLSearchParams() }))

// How many times each agent's row draws its glyph: a row that redraws draws it again (S-3292).
const glyphs = vi.hoisted(() => new Map<string, number>())
vi.mock('./Glyph', async (orig) => {
  const real = await orig<typeof import('./Glyph')>()
  return { ...real, Glyph: ({ agent: a }: { agent: Agent }) => { glyphs.set(a.id, (glyphs.get(a.id) ?? 0) + 1); return <real.Glyph agent={a} /> } }
})

const AGENTS: Agent[] = [
  agent({ id: 'ta-cos', name: 'fixture-cos', chief_of_staff: true, created_at: '2026-10-01T09:00:00.000Z' }),
  agent({ id: 'ta-dev', name: 'fixture-dev', parents: ['ta-cos'], created_at: '2026-10-01T09:01:00.000Z', cost: { mode: 'api', own: { api: 2, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, tree: { api: 2, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } } }),
]
const COLS: ColumnId[] = ['role', 'wait', 'context', 'cost', 'unread']

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => { r.unmount() })
  document.body.innerHTML = ''
})

// The table over these agents, with its lines built as the page builds them on each render.
function table(agents: Agent[], sort: { col: 'name' | 'cost'; dir: 'asc' | 'desc' } | null, onSort: () => void, onPick: () => void, checked: string[], onCheck: () => void) {
  const f = factsOf(agents, [], 'fixture-machine')
  const lines = buildLines(agents, f, { group: 'tree', query: '', sort, collapsed: {} })
  return <AgentsTable lines={lines} facts={f} group="tree" cols={COLS} sort={sort} cursor={null} enforce={200000} onSort={onSort} onPick={onPick}
    checked={new Set(checked)} checkAll={checked.length ? 'some' : 'none'} onCheck={onCheck} onCheckAll={vi.fn()} />
}

// Mounts the table over the given lines, and returns its element and root.
async function mount(sort: { col: 'name' | 'cost'; dir: 'asc' | 'desc' } | null, onSort = vi.fn(), onPick = vi.fn(), checked: string[] = [], onCheck = vi.fn()) {
  setData({ agents: AGENTS, itsas: [], loaded: { agents: true, mail: true, itsas: true } } as never)
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => { root.render(table(AGENTS, sort, onSort, onPick, checked, onCheck)) })
  return { el, root, onSort, onPick, onCheck }
}

describe('the Agents table', () => {
  it('says which column is sorted and which way', async () => {
    const { el } = await mount({ col: 'cost', dir: 'desc' })
    const th = (cls: string) => el.querySelector(`th.ac-${cls}`)!
    expect(th('cost').getAttribute('aria-sort')).toBe('descending')
    expect(th('role').getAttribute('aria-sort')).toBe('none')
    expect(th('cost').querySelector('.at-dir.desc')).not.toBeNull()
  })

  it('sorts by the header that is clicked', async () => {
    const { el, onSort } = await mount(null)
    await act(async () => { el.querySelector<HTMLButtonElement>('th.ac-cost .at-sort')!.click() })
    expect(onSort).toHaveBeenCalledWith('cost')
  })

  it('names the narrow headers by an icon, not a cut-off word', async () => {
    const { el } = await mount(null)
    for (const c of ['wait', 'unread']) {
      const btn = el.querySelector(`th.ac-${c} .at-sort`)!
      expect(btn.textContent).toBe('')
      expect(btn.querySelector('svg')).not.toBeNull()
      expect(btn.getAttribute('aria-label')).toBe(c === 'wait' ? 'Wait' : 'Unread')
    }
  })

  it('draws a context bar for a live agent', async () => {
    const { el } = await mount(null)
    expect(el.querySelector('tr[data-agent-row="ta-dev"] td.ac-context .ctxbar')).not.toBeNull()
  })

  it('picks the agent of a clicked row, and shows its folds under its parent', async () => {
    const { el, onPick } = await mount(null)
    expect(el.querySelectorAll('tr[data-agent-row]')).toHaveLength(2)
    await act(async () => { el.querySelector<HTMLElement>('tr[data-agent-row="ta-dev"] .name')!.click() })
    expect(onPick).toHaveBeenCalledWith('ta-dev')
  })

  it('checks a row from its checkbox, without picking it', async () => {
    const { el, onPick, onCheck } = await mount(null)
    await act(async () => { el.querySelector<HTMLElement>('tr[data-agent-row="ta-dev"] td.ac-check')!.click() })
    expect(onCheck).toHaveBeenCalledWith('ta-dev', false)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('passes a Shift-click on a checkbox as a range', async () => {
    const { el, onCheck } = await mount(null)
    await act(async () => { el.querySelector<HTMLElement>('tr[data-agent-row="ta-dev"] td.ac-check')!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })) })
    expect(onCheck).toHaveBeenCalledWith('ta-dev', true)
  })

  it('shows a checked row with its box ticked, and the header box mixed when only some are checked', async () => {
    const { el } = await mount(null, vi.fn(), vi.fn(), ['ta-dev'])
    expect(el.querySelector('tr[data-agent-row="ta-dev"]')!.classList.contains('chk')).toBe(true)
    expect(el.querySelector<HTMLInputElement>('tr[data-agent-row="ta-dev"] input.agents-check')!.checked).toBe(true)
    expect(el.querySelector<HTMLInputElement>('tr[data-agent-row="ta-cos"] input.agents-check')!.checked).toBe(false)
    expect(el.querySelector<HTMLInputElement>('th input[data-check-all]')!.indeterminate).toBe(true)
  })

  it('redraws only the row of the agent a poll changed (S-3292)', async () => {
    const { root } = await mount(null)
    glyphs.clear()
    // The live poll, then the first read of the archived agents (none).
    vi.mocked(api).mockResolvedValueOnce(AGENTS.map((a) => (a.id === 'ta-dev' ? { ...a, unread: 3 } : { ...a }))).mockResolvedValueOnce([])
    await act(async () => { await refreshAgents() })
    await act(async () => { root.render(table(getData().agents, null, vi.fn(), vi.fn(), [], vi.fn())) })
    expect(glyphs.get('ta-dev')).toBe(1)
    expect(glyphs.get('ta-cos') ?? 0).toBe(0)
  })
})

// The open ask link (S-3977): an agent's row takes the ask from the store as it lands, so a row drawn before the ask
// shows the link once it arrives, and drops it when the ask settles.
describe('the open ask link in the Activity column', () => {
  it('appears when the ask lands after the row drew, and goes when the ask settles', async () => {
    const waiting = agent({ id: 'ta-ask', name: 'fixture-asker', open_ask: 'request:fx-ask', created_at: '2026-10-01T09:02:00.000Z' })
    setData({ agents: [waiting], itsas: [], asks: [], loaded: { agents: true, mail: true, itsas: true } } as never)
    const f = factsOf([waiting], [], 'fixture-machine')
    const lines = buildLines([waiting], f, { group: 'tree', query: '', sort: null, collapsed: {} })
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    roots.push(root)
    await act(async () => { root.render(<AgentsTable lines={lines} facts={f} group="tree" cols={['activity']} sort={null} cursor={null} enforce={200000} onSort={vi.fn()} onPick={vi.fn()}
      checked={new Set()} checkAll="none" onCheck={vi.fn()} onCheckAll={vi.fn()} />) })
    expect(el.querySelector('[data-open-ask]')).toBeNull()
    const ask = { key: 'request:fx-ask', kind: 'request', state: 'open', outcome: null, what: 'Permission request', agent_id: 'ta-ask', agent_name: 'fixture-asker', machine: 'fixture-machine', thread_id: 'fx-thread', itsa_id: null, since: '2026-10-01T09:02:00.000Z', settled_at: null } as const
    await act(async () => { setData({ asks: [ask] } as never) })
    expect(el.querySelector('[data-open-ask]')?.textContent).toBe('Open ask')
    await act(async () => { setData({ asks: [{ ...ask, state: 'settled', outcome: 'approved', settled_at: '2026-10-01T09:05:00.000Z' }] } as never) })
    expect(el.querySelector('[data-open-ask]')).toBeNull()
  })
})

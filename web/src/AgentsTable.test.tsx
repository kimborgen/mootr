// @vitest-environment jsdom
// The Agents table's header and rows (S-1432): the header sorts and says which way, and a row click picks its agent.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentsTable } from './AgentsTable'
import { buildLines, factsOf, type ColumnId } from './agents-table'
import { setData } from './store'
import { agent } from './stories/fixtures'
import type { Agent } from './types'

vi.mock('./api', () => ({ api: vi.fn(async () => ({})), hash: new URLSearchParams() }))

const AGENTS: Agent[] = [
  agent({ id: 'ta-cos', name: 'fixture-cos', chief_of_staff: true, created_at: '2026-10-01T09:00:00.000Z' }),
  agent({ id: 'ta-dev', name: 'fixture-dev', parents: ['ta-cos'], created_at: '2026-10-01T09:01:00.000Z', cost: { mode: 'api', own: { api: 2, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, tree: { api: 2, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } } }),
]
const COLS: ColumnId[] = ['role', 'wait', 'context', 'cost', 'unread']

const roots: Root[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => { r.unmount() })
  document.body.innerHTML = ''
})

// Mounts the table over the given lines, and returns its element.
async function mount(sort: { col: 'name' | 'cost'; dir: 'asc' | 'desc' } | null, onSort = vi.fn(), onPick = vi.fn()) {
  setData({ agents: AGENTS, itsas: [], loaded: { agents: true, mail: true, itsas: true } } as never)
  const f = factsOf(AGENTS, [], 'fixture-machine')
  const lines = buildLines(AGENTS, f, { group: 'tree', query: '', sort, collapsed: {} })
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => { root.render(<AgentsTable lines={lines} facts={f} group="tree" cols={COLS} sort={sort} cursor={null} enforce={200000} onSort={onSort} onPick={onPick} />) })
  return { el, onSort, onPick }
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
})

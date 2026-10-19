// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_STATE, setUsageState } from './state'
import { Overview } from './Overview'
import { USAGE_FILTERED } from './story-data'
import type { Usage } from './types'

// The drill scope's view fetches its own data; these tests only read the page around it.
vi.mock('./drill/Drill', async (importOriginal) => ({ ...(await importOriginal<typeof import('./drill/Drill')>()), ScopedView: () => null }))

const paths: string[] = []
// The tree series has a previous period; the ITSA one (built from samples) does not.
vi.mock('../api', () => ({
  api: vi.fn(async (_m: string, path: string) => {
    paths.push(path)
    const group = new URL('http://x' + path).searchParams.get('group')
    return {
      days: 6, group, bucket: 'day', groups: [{ id: 'r1', name: 'root' }],
      rows: [{ t: '2026-10-14', cost_usd: 12, groups: { r1: { cost_usd: 12 } } }],
      total: { cost_usd: group === 'tree' ? 365 : 12 }, previous: { cost_usd: group === 'tree' ? 310 : 0 },
    }
  }),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const u = { today: { cost_usd: 5, tokens_in: 0, tokens_out: 0 }, subscriptions: [], accounts: [], by_day: [{ day: '2026-10-14', cost_usd: 365, tokens_in: 0 }], by_model: [], by_agent: [], note: '' } as unknown as Usage
let root: Root | undefined
let host: HTMLElement | undefined
beforeEach(() => { paths.length = 0; setUsageState({ ...DEFAULT_STATE }) })
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = undefined })

describe('Overview Spend tile', () => {
  it('keeps its total and change when the charts group by ITSA', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(<Overview u={u} issues={null} issuesError={null} retryIssues={() => {}} days={7} />) })
    const tile = () => host!.querySelector('.tiles .tile')!.textContent ?? ''
    expect(tile()).toContain('$365')
    expect(tile()).toContain('18% vs the 7 days before')
    expect(paths.filter((p) => p.includes('group=tree'))).toHaveLength(1) // one fetch, shared with the charts
    await act(async () => { [...host!.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent === 'ITSA')!.click() })
    expect(paths.some((p) => p.includes('group=itsa'))).toBe(true)
    expect(tile()).toContain('$365')
    expect(tile()).toContain('18% vs the 7 days before')
  })
})

describe('Overview while filtered to a type', () => {
  const titles = () => [...host!.querySelectorAll('.uc-title')].map((t) => t.textContent)
  const note = () => host!.querySelector('.usage-filter-note')?.textContent ?? ''
  const labels = () => [...host!.querySelectorAll('.usage-all-label')].map((t) => t.textContent)
  const render = async (state: Partial<typeof DEFAULT_STATE>) => {
    setUsageState({ ...DEFAULT_STATE, agents: ['developer'], ...state })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(<Overview u={USAGE_FILTERED} issues={null} issuesError={null} retryIssues={() => {}} days={7} />) })
  }

  it('keeps the charts and the finished issues, each labelled All agents, and drops the Spend tile change', async () => {
    await render({})
    expect(host!.querySelector('section[aria-label="Spend overview"]')).not.toBeNull()
    expect(titles()).toEqual(['Spend per day', 'Where it went', 'Finished issues'])
    expect(labels()).toEqual(['All agents', 'All agents', 'All agents'])
    const tile = host!.querySelector('.tiles .tile')!.textContent ?? ''
    expect(tile).not.toContain('vs the')
    expect(note()).toContain('Showing only developer')
    expect(note()).toContain('Spend and Today count')
    expect(note()).not.toContain('The drill below')
  })

  it('fetches the all-agents series while filtered', async () => {
    await render({})
    expect(paths.some((p) => p.includes('group=tree'))).toBe(true)
  })

  it('says the drill counts every agent when a drill scope is set', async () => {
    await render({ scope: { kind: 'tree', id: 'r1' } })
    expect(host!.querySelector('.tiles')).toBeNull()
    expect(note()).toContain('Showing only developer')
    expect(note()).toContain('The drill below')
    expect(note()).not.toContain('Spend and Today count')
  })
})

describe('Overview unfiltered', () => {
  const labels = () => [...host!.querySelectorAll('.usage-all-label')].map((t) => t.textContent)
  it('shows no All agents label', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(<Overview u={u} issues={null} issuesError={null} retryIssues={() => {}} days={7} />) })
    expect(labels()).toEqual([])
    expect(host!.querySelector('section[aria-label="Spend overview"]')).not.toBeNull()
    expect(host!.querySelector('.usage-filter-note')).toBeNull()
  })

  it('shows no filter note on a drill scope with no type filter', async () => {
    setUsageState({ ...DEFAULT_STATE, scope: { kind: 'tree', id: 'r1' } })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(<Overview u={u} issues={null} issuesError={null} retryIssues={() => {}} days={7} />) })
    expect(host.querySelector('.usage-filter-note')).toBeNull()
  })
})

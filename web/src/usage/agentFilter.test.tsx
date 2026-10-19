// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_STATE, getUsageState, setUsageState } from './state'
import { UsageView } from './UsageView'
import { SUMMARY } from './activity/summaryFixture'
import { summaryPath } from './activity/useSummary'
import type { AgentRow, Usage } from './types'

const paths: string[] = []
const row = (agent: string, type: string, usd: number): AgentRow => ({
  agent_id: agent, agent, type, harness: 'claude', model: 'claude-opus-5-5', cost_usd: usd,
  today: { cost_usd: usd, tokens_in: 1, tokens_out: 1, tokens_cache_read: 0, tokens_cache_write: 0 },
  lifetime: { cost_usd: usd, tokens_in: 1, tokens_out: 1, tokens_cache_read: 0, tokens_cache_write: 0 },
})
const u = {
  today: { cost_usd: 5, tokens_in: 0, tokens_out: 0 }, subscriptions: [], accounts: [], by_day: [], by_model: [], note: '',
  by_agent: [row('cos', 'chief-of-staff', 9), row('assistant', 'assistant', 8), row('lead', 'manager', 7), row('builder', 'developer', 6), row('builder2', 'developer', 5)],
} as unknown as Usage
vi.mock('../api', () => ({
  api: vi.fn(async (_m: string, path: string) => {
    paths.push(path)
    if (path.startsWith('/api/activity')) {
      // The daemon maps an older preset or class list to its types and answers with them.
      const a = new URLSearchParams(path.split('?')[1]).get('agents')
      const resolved = a === 'work' ? 'developer,manager,untyped' : a === '+manager,+other' ? 'manager,untyped' : a
      return resolved ? { ...SUMMARY, filter: { ...SUMMARY.filter!, agents: resolved } } : SUMMARY
    }
    if (path.startsWith('/api/usage/issues')) return { issues: [], by_config: [], unattributed: {} }
    if (path.startsWith('/api/usage?')) {
      // Like the daemon: filter the by-agent rows, echo the filter, count types over every agent.
      const a = new URLSearchParams(path.split('?')[1]).get('agents')
      const keep = a ? a.split(',') : null
      const types = u.by_agent.map((r) => r.type!)
      return { ...u, by_agent: keep ? u.by_agent.filter((r) => keep.includes(r.type!)) : u.by_agent, filtered_agents: keep ? [...keep].sort() : null,
        agent_types: [...new Set(types)].map((type) => ({ type, count: types.filter((t) => t === type).length })).sort((x, y) => y.count - x.count || x.type.localeCompare(y.type)) }
    }
    return {}
  }),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const click = async (el: Element | null | undefined) => { await act(async () => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await flush() }
const group = () => host.querySelector('.usage-types')
const btn = (label: string) => [...(group()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label)
const labels = () => [...(group()?.querySelectorAll('button') ?? [])].map((b) => b.textContent)
const names = () => [...host.querySelectorAll('table.data tbody tr')].map((r) => r.querySelector('td')?.textContent ?? '').filter(Boolean)

beforeEach(async () => {
  paths.length = 0
  setUsageState({ ...DEFAULT_STATE })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(<UsageView />) })
  await flush()
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('the Agent types control', () => {
  it('shows on every tab but Issues', async () => {
    await act(async () => { setUsageState({ tab: 'issues' }) }); await flush()
    expect(host.querySelector('.usage-filter')).toBeNull()
    for (const tab of ['overview', 'activity', 'models', 'trees', 'agents', 'days'] as const) {
      await act(async () => { setUsageState({ tab }) }); await flush()
      expect(host.querySelector('.usage-filter'), tab).not.toBeNull()
    }
  })

  it('has one button per type present with its agent count, and All, pressed', async () => {
    await act(async () => { setUsageState({ tab: 'activity' }) }); await flush()
    expect(labels()).toEqual(['All', ...SUMMARY.filter!.types!.map((t) => `${t.type} ${t.count}`)])
    expect(btn('All')?.getAttribute('aria-pressed')).toBe('true')
    expect(btn('developer 112')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('asks Activity again with the types picked, names them in the crumb, and All resets', async () => {
    await act(async () => { setUsageState({ tab: 'activity' }) }); await flush()
    expect(paths.filter((p) => p.startsWith('/api/activity')).at(-1)).toBe('/api/activity?by=summary&days=7')
    expect(host.querySelector('.ax-filter')).toBeNull()
    await click(btn('manager 41'))
    expect(getUsageState().agents).toEqual(['manager'])
    expect(paths.filter((p) => p.startsWith('/api/activity')).at(-1)).toBe('/api/activity?by=summary&days=7&agents=manager')
    expect(btn('manager 41')?.getAttribute('aria-pressed')).toBe('true')
    expect(btn('All')?.getAttribute('aria-pressed')).toBe('false')
    await click(btn('developer 112'))
    expect(paths.filter((p) => p.startsWith('/api/activity')).at(-1)).toBe(`/api/activity?by=summary&days=7&agents=${encodeURIComponent('developer,manager')}`)
    expect(host.querySelector('.ax-scope .ax-filter')?.textContent).toContain('developer, manager')
    expect(labels().length, 'the buttons stay while the new answer loads').toBe(SUMMARY.filter!.types!.length + 1)
    await click(btn('manager 41'))
    await click(btn('developer 112'))
    expect(getUsageState().agents, 'none picked counts all').toEqual([])
    expect(btn('All')?.getAttribute('aria-pressed')).toBe('true')
    await click(btn('untyped 14'))
    await click(btn('All'))
    expect(getUsageState().agents).toEqual([])
    expect(host.querySelector('.ax-filter')).toBeNull()
  })

  it('shows on Agents with the types of its rows, and filters them', async () => {
    await act(async () => { setUsageState({ tab: 'agents' }) }); await flush()
    expect(labels()).toEqual(['All', 'developer 2', 'assistant 1', 'chief-of-staff 1', 'manager 1'])
    expect(names()).toHaveLength(5)
    expect(host.querySelector('.usage-filter-note')).toBeNull()
    await click(btn('developer 2'))
    expect(names()).toHaveLength(2)
    expect(host.querySelector('.usage-filter-note')?.textContent).toBe('Showing only developer.')
    expect(labels(), 'the counts do not shrink to the selection').toEqual(['All', 'developer 2', 'assistant 1', 'chief-of-staff 1', 'manager 1'])
    await click(btn('manager 1'))
    expect(names()).toHaveLength(3)
    await click(btn('All'))
    expect(names()).toHaveLength(5)
  })

  it('asks /api/usage with the selection, again when it changes, and notes it on Overview, Models, Trees and Days', async () => {
    expect(paths.filter((p) => p.startsWith('/api/usage?')).at(-1)).toBe('/api/usage?days=6')
    await act(async () => { setUsageState({ tab: 'overview', agents: ['manager', 'developer'] }) }); await flush()
    expect(paths.filter((p) => p.startsWith('/api/usage?')).at(-1)).toBe('/api/usage?days=6&agents=developer%2Cmanager')
    expect(host.querySelector('.usage-filter-note')?.textContent).toContain('Limits, subscription windows, real money, the charts and finished issues count every agent')
    for (const tab of ['models', 'trees', 'days'] as const) {
      await act(async () => { setUsageState({ tab }) }); await flush()
      expect(host.querySelector('.usage-filter-note')?.textContent, tab).toContain('Showing only developer, manager.')
    }
  })

  it('does not call unfiltered numbers filtered when the daemon ignores agents=', async () => {
    const { api } = await import('../api')
    vi.mocked(api).mockImplementationOnce(async () => ({ ...u }))
    await act(async () => { setUsageState({ tab: 'models', agents: ['manager'] }) }); await flush()
    const note = host.querySelector('.usage-filter-note')?.textContent ?? ''
    expect(note).toContain('does not filter usage')
    expect(note).not.toContain('Showing only')
  })
})

describe('a saved link from before agent types', () => {
  it.each([
    ['work', ['work'], 'work', ['developer', 'manager', 'untyped']],
    ['a class list', ['+manager', '+other'], '%2Bmanager%2C%2Bother', ['manager', 'untyped']],
  ])('%s: asks the daemon with the old value, adopts the types it answers with, and never counts all meanwhile', async (_n, saved, param, types) => {
    await act(async () => { setUsageState({ tab: 'activity', agents: saved }) }); await flush(); await flush()
    expect(paths.some((p) => p.startsWith('/api/activity') && p.includes(`agents=${param}`))).toBe(true)
    expect(getUsageState().agents).toEqual(types)
    expect(paths.filter((p) => p.startsWith('/api/activity')).at(-1)).toContain(`agents=${encodeURIComponent(types.join(','))}`)
    expect(host.querySelector('.ax-scope .ax-filter')?.textContent).toContain(types.join(', '))
  })
  it('does not hide cos on the Agents tab from an old link: the rows stay until the types arrive', async () => {
    await act(async () => { setUsageState({ tab: 'agents', agents: ['work'] }) }); await flush(); await flush()
    expect(getUsageState().agents).toEqual(['developer', 'manager', 'untyped'])
    expect(names().join('|')).not.toContain('assistant')
  })
})

describe('the summary path', () => {
  it('adds agents only when the filter is not All', () => {
    expect(summaryPath(7, null)).toBe('/api/activity?by=summary&days=7')
    expect(summaryPath(7, null, DEFAULT_STATE.agents)).toBe('/api/activity?by=summary&days=7')
    expect(summaryPath(7, { kind: 'tree', id: 'x' }, ['manager', 'developer'])).toBe('/api/activity?by=summary&days=7&scope=tree%3Ax&agents=developer%2Cmanager')
  })
})

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityTab } from '../Activity'
import { AgentTrees } from './AgentTrees'
import { DEFAULT_STATE, getUsageState, setUsageState } from '../state'
import { SUMMARY, SUMMARY_AGENT, TREES } from './summaryFixture'
import { measureText } from '../measure'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let paths: string[]
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const click = async (el: Element | null | undefined) => { await act(async () => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await flush() }
const btn = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)

beforeEach(() => {
  paths = []
  setUsageState({ ...DEFAULT_STATE, tab: 'activity' })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    paths.push(path)
    return { ok: true, status: 200, json: async () => (path.includes('scope=') ? SUMMARY_AGENT : SUMMARY) }
  }))
  host = document.createElement('div')
  host.className = 'usage'
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); setUsageState(DEFAULT_STATE) })

const mount = async () => { await act(async () => { root.render(<ActivityTab shown />) }); await flush() }

describe('Activity tab (S-1011)', () => {
  it('fills the tiles from the summary', async () => {
    await mount()
    const notes = [...host.querySelectorAll('.ax-tiles .tile')].map((t) => [t.querySelector('.mb-mval')?.textContent, t.querySelector('.mb-mnote')?.textContent])
    expect(notes).toEqual([
      ['196\u00a0h', 'agent-hours, 19% of 1,030\u00a0h on the clock'],
      ['79\u00a0h', 'replies 36\u00a0h · new prompts 43\u00a0h'],
      ['110\u00a0h', 'incl. cost pauses 52\u00a0h, polling 35\u00a0h'],
      ['$9.69', 'Communicating takes 42% of it (est.)'],
    ])
    expect(host.querySelector('.ax-tiles .tile-spark path')).not.toBeNull()
  })
  it('the cost-per-hour note never names Unclassified', async () => {
    const unc = { key: 'unclassified', label: 'Unclassified', seconds: 400 * 3600, cost_usd: 5000, modes: { api: 5000, paid_usd: 0, five_hour: null, seven_day: null, subscription: null }, estimated: true, leaves: {} }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ...SUMMARY, working_by_category: [unc, ...SUMMARY.working_by_category] }) })))
    await mount()
    expect(host.querySelectorAll('.ax-tiles .mb-mnote')[3].textContent).toMatch(/^Communicating takes \d+% of it \(est\.\)$/)
    const last = [...host.querySelectorAll('.ax-time [data-category]')].at(-1)
    expect(last?.getAttribute('data-category')).toBe('unclassified')
    expect(last?.classList.contains('muted')).toBe(true)
  })
  it('says the figures are partial while the daemon is warming, and Refresh asks again (S-1206)', async () => {
    await mount()
    expect(host.querySelector('.ax-warming')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async (path: string) => { paths.push(path); return { ok: true, status: 200, json: async () => ({ ...SUMMARY, warming: true }) } }))
    await act(async () => { setUsageState({ days: 30 }) })
    await flush()
    expect(host.querySelector('.ax-warming')?.textContent).toMatch(/Still warming/)
    expect(host.querySelector('.ax-tiles')).not.toBeNull()
    const n = paths.length
    await click(btn('Refresh'))
    expect(paths.length).toBe(n + 1)
  })
  it('follows the Measure without asking again', async () => {
    await mount()
    await act(async () => { setUsageState({ measure: 'week' }) })
    expect(host.querySelectorAll('.ax-tiles .mb-mval')[3].textContent).toBe('0.5%')
    await act(async () => { setUsageState({ measure: 'real' }) })
    expect(host.querySelectorAll('.ax-tiles .mb-mval')[3].textContent).toBe('$4.85')
    // Only one call: the Measure changes no data.
    expect(paths.length).toBe(1)
  })
  it('Where the time goes: the clock legend, then categories by time', async () => {
    await mount()
    const rows = (sel: string) => [...host.querySelectorAll(`.ax-time ${sel}`)].map((r) => [r.querySelector('.nm')?.textContent, r.querySelector('.v')?.textContent, r.querySelector('.s')?.textContent])
    expect(rows('[data-group]')[0]).toEqual(['Working', '196\u00a0h', '19%'])
    expect(rows('[data-group]')[2]).toEqual(['On you', '79\u00a0h', '8%'])
    expect(rows('[data-category]').map((r) => r[0])).toEqual(['Verifying', 'Communicating', 'Tracking', 'Integrating', 'Understanding', '3 more'])
  })
  it('Bottlenecks: the top eight, a you tag, agents and the long pause, then Show all', async () => {
    await mount()
    const bn = () => [...host.querySelectorAll('.ax-bn')]
    expect(bn().length).toBe(8)
    expect(bn()[2].querySelector('.ax-tag.you')?.textContent).toBe('you')
    expect(bn()[0].querySelector('.ax-tag')).toBeNull()
    expect(bn()[1].querySelector('.who')?.textContent).toBe('7 agents, one 30\u00a0h pause · fixture-dev 21\u00a0h · fixture-review 10\u00a0h')
    expect((bn()[0].querySelector('.meter i') as HTMLElement).style.width).toBe('100%')
    await click(btn('Show all 10'))
    expect(bn().length).toBe(10)
    expect(btn('Show top 8')).toBeDefined()
  })
  it('reads the drill scope; the crumb clears it', async () => {
    setUsageState({ scope: { kind: 'agent', id: 'fx-dev' } })
    await mount()
    expect(paths).toEqual(['/api/activity?by=summary&days=7&scope=agent%3Afx-dev'])
    expect(host.querySelector('.ax-scope')?.textContent).toBe('All agents›agentfixture-dev')
    expect(host.querySelector('.ax-time .ax-none')?.textContent).toBe('No working time in this window yet')
    await click(host.querySelector('.ax-crumb'))
    expect(paths.at(-1)).toBe('/api/activity?by=summary&days=7')
    expect(host.querySelector('.ax-scope')?.textContent).toBe('All agents›whole system')
  })
  it('Today is the last 24 hours, and says so', async () => {
    setUsageState({ days: 1 })
    await mount()
    expect(paths).toEqual(['/api/activity?by=summary&days=1'])
    expect(host.querySelector('.ax-scope .ax-window')?.textContent).toBe('· last 24 h')
  })
  it('a model scope is not one activity reads: the whole system shows, and says so', async () => {
    setUsageState({ scope: { kind: 'model', id: 'claude-opus-5-5' } })
    await mount()
    expect(paths).toEqual(['/api/activity?by=summary&days=7'])
    expect(host.querySelector('.ax-scope')?.textContent).toContain("activity can't scope to a model")
  })
  it('What finished issues cost: a range mark and the median in the Measure, by model, type or both (S-1012)', async () => {
    await mount()
    const rows = () => [...host.querySelectorAll('.ax-cfg tbody tr')]
    const cells = (r: Element) => [...r.querySelectorAll('td')].map((td) => (td.classList.contains('ax-cost') ? td.querySelector('.v')?.textContent : td.childNodes[0]?.textContent ?? ''))
    expect(rows().map((r) => r.querySelector('.ax-cfg-name')?.childNodes[1]?.textContent)).toEqual(['Opus 5.5', 'Haiku 5.5', 'DeepSeek v4.1 flash', 'gpt-6.1-sol'])
    expect(cells(rows()[0]).slice(1)).toEqual(['62', '$0.69', '21\u00a0min', '3.4\u00a0h', '1'])
    expect(rows()[0].querySelector('.phone-only')?.textContent).toBe('Lead 3.4\u00a0h · Reviews 1')
    // Scaled to the largest p75 shown (Codex $2.40): Opus's dot at $0.69, its tick at $1.40.
    const mark = (r: Element, c: string) => parseFloat((r.querySelector(`.ax-range .${c}`) as HTMLElement).style.left)
    expect(mark(rows()[0], 'dt')).toBeCloseTo(28.75)
    expect(mark(rows()[0], 'tk')).toBeCloseTo(58.33)
    expect(mark(rows()[3], 'tk')).toBe(100)
    await act(async () => { setUsageState({ measure: 'week' }) })
    expect(cells(rows()[0])[2]).toBe('<0.1%')
    await click(btn('Type'))
    expect(rows().map((r) => r.querySelector('.ax-cfg-name')?.childNodes[0]?.textContent)).toEqual(['developer', 'manager', 'reviewer'])
    await click(btn('Both'))
    expect(rows()[0].querySelector('.ax-cfg-name')?.textContent).toContain('Opus 5.5 · manager')
  })
  it('Agents by tree: top eight roots, a root\'s top three children, sorted by the switch (S-1012)', async () => {
    await mount()
    const roots = () => [...host.querySelectorAll('.ax-tree:not(.child)')].map((r) => r.querySelector('b')?.textContent)
    expect(roots()).toEqual(['cos', 'release', 'fixture-a', 'fixture-b', 'fixture-c', 'fixture-d', 'fixture-e', 'fixture-f'])
    const cos = host.querySelector('.ax-tree-group')!
    expect([...cos.querySelectorAll('.ax-tree.child b')].map((b) => b.textContent)).toEqual(['gh-process', 'system-view', 'human-auth'])
    expect(cos.querySelector('.ax-tree-more')?.textContent).toBe('4 more under cos')
    expect(host.querySelector('.ax-tree[data-id="gh-process"]')?.textContent).toBe('gh-process · manager · 18 agents11\u00a0h')
    // The bar is the tree's own clock: working is 141 of 791 h.
    const bar = [...host.querySelectorAll('.ax-tree[data-id="cos"] .ax-stack i')] as HTMLElement[]
    expect(bar.length).toBe(5)
    expect(parseFloat(bar[0].style.width)).toBeCloseTo(17.83, 1)
    await click(btn('Friction'))
    expect(roots().slice(0, 2)).toEqual(['cos', 'release'])
    expect(btn('Cost'), 'the sort has no cost lead; Cost is the page switch').toBeTruthy()
    await click(host.querySelector('.ax-trees .ax-more'))
    expect(roots().length).toBe(10)
  })
  it('a tapped tree, child or agent name scopes the whole tab (S-1012)', async () => {
    await mount()
    await click(host.querySelector('.ax-tree[data-id="gh-process"]'))
    expect(getUsageState().scope).toEqual({ kind: 'tree', id: 'gh-process' })
    expect(paths.at(-1)).toBe('/api/activity?by=summary&days=7&scope=tree%3Agh-process')
    await click(host.querySelector('.ax-crumb'))
    await click(host.querySelector('.ax-bn .ax-agent-name'))
    expect(getUsageState().scope).toEqual({ kind: 'agent', id: 'fx-dev' })
    expect(paths.at(-1)).toBe('/api/activity?by=summary&days=7&scope=agent%3Afx-dev')
    // Scoped to one tree, every child lists: no "N more".
    expect(host.querySelectorAll('.ax-tree').length).toBe(1)
    expect(host.querySelector('.ax-configs .ax-none')?.textContent).toBe('No closed work issues in this window yet')
  })
  it('Agents by tree scoped to one tree: its top ten children, then Show all (S-1012)', async () => {
    const kids = Array.from({ length: 14 }, (_, i) => ({ ...TREES[0].children[0], id: `kid-${i}`, name: `kid-${i}`, cost_usd: 100 - i, working_s: (100 - i) * 3600, modes: null }))
    await act(async () => { root.render(<AgentTrees trees={[{ ...TREES[0], children: kids }]} measure="api" mode="time" />) })
    const shown = () => [...host.querySelectorAll('.ax-tree.child b')].map((b) => b.textContent)
    expect(shown()).toEqual(kids.slice(0, 10).map((k) => k.name))
    await click(btn('Show all 14'))
    expect(shown().length).toBe(14)
    await click(btn('Show top 10'))
    expect(shown().length).toBe(10)
    // Not one tree: three children a root, the rest one tap into the tree.
    await act(async () => { root.render(<AgentTrees trees={[{ ...TREES[0], children: kids }, TREES[1]]} measure="api" mode="time" />) })
    expect(shown().length).toBe(3)
    expect(host.querySelector('.ax-tree-more')?.textContent).toBe('11 more under cos')
  })
  it('Show all resets when the scope changes to another tree, or back to every tree', async () => {
    const kidsOf = (tag: string) => Array.from({ length: 14 }, (_, i) => ({ ...TREES[0].children[0], id: `${tag}-${i}`, name: `${tag}-${i}`, cost_usd: 100 - i, working_s: (100 - i) * 3600, modes: null }))
    const render = (trees: typeof TREES) => act(async () => { root.render(<AgentTrees trees={trees} measure="api" mode="time" />) })
    const shown = () => host.querySelectorAll('.ax-tree.child').length
    await render([{ ...TREES[0], children: kidsOf('a') }])
    await click(btn('Show all 14'))
    expect(shown()).toBe(14)
    // The same tree again (a refreshed answer) keeps it open.
    await render([{ ...TREES[0], children: kidsOf('a') }])
    expect(shown()).toBe(14)
    // Another tree starts closed.
    await render([{ ...TREES[1], children: kidsOf('b') }])
    expect(shown()).toBe(10)
    expect(btn('Show all 14')).toBeTruthy()
    // So does every tree again after one tree.
    await click(btn('Show all 14'))
    await render(TREES)
    await render([{ ...TREES[1], children: kidsOf('b') }])
    expect(shown()).toBe(10)
  })
})

describe('Activity in Cost mode (S-1491)', () => {
  const costMode = async () => { await mount(); await click(btn('Cost')) }
  const tiles = () => [...host.querySelectorAll('.ax-tiles .tile')].map((t) => [t.querySelector('.mb-mlabel, .mb-mkey, .tile-label')?.textContent, t.querySelector('.mb-mval')?.textContent])
  it('is a page switch, kept in the state, and asks nothing again', async () => {
    await mount()
    expect(btn('Time')?.getAttribute('aria-pressed')).toBe('true')
    await click(btn('Cost'))
    expect(getUsageState().mode).toBe('cost')
    expect(btn('Cost')?.getAttribute('aria-pressed')).toBe('true')
    expect(paths.length, 'the same answer serves both').toBe(1)
  })
  it('the tiles are cost: total, per working hour, the top type and the top tree with their shares', async () => {
    await costMode()
    expect(tiles().map((t) => t[1])).toEqual(['$1900', '$9.69', 'developer · 42%', 'cos · 89%'])
    expect(host.querySelector('.ax-nocost')?.textContent).toContain('no recorded cost')
    expect(host.querySelector('.ax-tiles')?.textContent).not.toMatch(/\d\u00a0h\b|on the clock/)
    expect(host.querySelectorAll('.ax-tiles .mb-mnote')[1].textContent).toBe('per working agent-hour')
  })
  it('Where the cost goes: the categories by estimated cost, no clock bar, no hours', async () => {
    await costMode()
    expect(host.querySelector('.ax-time h3')?.textContent).toBe('Where the cost goes')
    expect(host.querySelector('.ax-time [data-group]')).toBeNull()
    const rows = [...host.querySelectorAll('.ax-time [data-category]')].map((r) => [r.querySelector('.nm')?.textContent, r.querySelector('.v')?.textContent, r.querySelector('.s')?.textContent])
    expect(rows[0]).toEqual(['Communicating', '$800', 'est. 42%'])
    expect(host.querySelector('.ax-time')?.textContent).not.toMatch(/\u00a0h\b/)
  })
  it('Cost by agent type, then Cost by model instead of Bottlenecks; trees sort by cost without hours', async () => {
    await costMode()
    expect(host.querySelector('.ax-types h3')?.textContent).toBe('Cost by agent type')
    expect([...host.querySelectorAll('.ax-types .ax-share')].map((r) => r.querySelector('.nm')?.textContent).slice(0, 3)).toEqual(['developer', 'manager', 'reviewer'])
    expect(host.querySelector('.ax-types .ax-share .v')?.textContent).toBe('$790')
    expect(host.querySelector('.ax-types .ax-share .who')?.textContent).toBe('112 agents · 42%')
    expect(host.querySelector('.ax-bottlenecks h3')?.textContent).toBe('Cost by model')
    expect(host.querySelector('.ax-bn')).toBeNull()
    expect(host.querySelector('.ax-trees .ax-tree[data-id="cos"] .v')?.textContent).toBe('$1690')
    expect(host.querySelector('.ax-trees')?.textContent).not.toMatch(/\u00a0h\b/)
    expect(host.querySelector('.ax-trees [aria-label="Sort by"]')).toBeNull()
    expect(host.querySelector('.ax-trees .ax-legend')).toBeNull()
  })
  it('Time by agent type in Time mode: the same rows in working hours', async () => {
    await mount()
    expect(host.querySelector('.ax-types h3')?.textContent).toBe('Time by agent type')
    expect(host.querySelector('.ax-types .ax-share .v')?.textContent).toBe('88\u00a0h')
  })
  it('follows the Measure: % of week, and a mode that is not known is a dash, never time', async () => {
    await costMode()
    await act(async () => { setUsageState({ measure: 'week' }) })
    expect(tiles()[0][1]).toBe(measureText(95, 'week'))
    await act(async () => { setUsageState({ measure: 'real' }) })
    expect(tiles()[0][1]).toBe('$950')
  })
  it('a tapped type counts only that type', async () => {
    await costMode()
    await click(host.querySelector('.ax-types .ax-agent-name'))
    expect(getUsageState().agents).toEqual(['developer'])
  })
})

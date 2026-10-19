import { describe, expect, it } from 'vitest'
import { LAYOUT_V, activate, addPane, DEFAULT_PANES, MAX_PANES, movePane, moveTab, removePane, removeTab, sanitizePanes, sanitizeTabBar, sendTab, tabKey, unusedTabs } from './sidebar-panes'

const KNOWN = ['agents', 'issues', 'mail', 'machines']
const WITH_COST = [...KNOWN, 'cost']

describe('sidebar pane layout', () => {
  it('takes the defaults when nothing usable is stored', () => {
    for (const x of [undefined, null, 'x', {}, { panes: 'a' }, { panes: [] }, { panes: [{ tabs: ['nope'] }] }]) expect(sanitizePanes(x, KNOWN)).toEqual(DEFAULT_PANES)
  })
  it('drops unknown tab ids, repeats, and panes left empty', () => {
    const got = sanitizePanes({ panes: [{ tabs: ['agents', 'gone', 'agents', 3], active: 'agents' }, { tabs: ['gone'], active: 'gone' }, { tabs: ['agents', 'mail'], active: 'mail' }] }, KNOWN)
    expect(got).toEqual([{ tabs: ['agents'], active: 'agents' }, { tabs: ['mail'], active: 'mail' }])
  })
  it('does not show a tab the layout leaves out', () => {
    const got = sanitizePanes({ panes: [{ tabs: ['mail'], active: 'mail' }] }, KNOWN)
    expect(got.flatMap((p) => p.tabs)).toEqual(['mail'])
  })
  it('falls back to the first tab when active is not in the pane', () => {
    expect(sanitizePanes({ panes: [{ tabs: ['agents', 'issues'], active: 'mail' }] }, KNOWN)[0].active).toBe('agents')
    expect(sanitizePanes({ panes: [{ tabs: ['agents', 'issues'] }] }, KNOWN)[0].active).toBe('agents')
  })
  it('keeps at most MAX_PANES panes', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ tabs: ['t' + i], active: 't' + i }))
    expect(sanitizePanes({ panes: many }, many.map((m) => m.tabs[0]))).toHaveLength(MAX_PANES)
  })
  it('does not share the defaults with the caller', () => {
    const a = sanitizePanes(null, KNOWN)
    a[0].tabs.push('x')
    expect(DEFAULT_PANES[0].tabs).toEqual(['agents', 'issues'])
  })
})

describe('the cost tab migration', () => {
  const old = { panes: [{ tabs: ['agents', 'issues'], active: 'agents' }, { tabs: ['mail'], active: 'mail' }, { tabs: ['machines'], active: 'machines' }] }
  it('defaults to the cost tab showing in the machines pane', () => {
    expect(DEFAULT_PANES[2]).toEqual({ tabs: ['cost', 'machines'], active: 'cost' })
  })
  it('adds cost once to the pane holding machines, keeping that pane\'s showing tab', () => {
    const got = sanitizePanes(old, WITH_COST)
    expect(got[2]).toEqual({ tabs: ['machines', 'cost'], active: 'machines' })
  })
  it('adds cost to the last pane when machines is not in the layout', () => {
    const got = sanitizePanes({ panes: [{ tabs: ['agents'], active: 'agents' }, { tabs: ['mail'], active: 'mail' }] }, WITH_COST)
    expect(got[1].tabs).toEqual(['mail', 'cost'])
  })
  it('leaves a layout saved at the current version alone, so a removed cost stays removed', () => {
    expect(sanitizePanes({ ...old, v: LAYOUT_V }, WITH_COST)).toEqual(old.panes)
  })
  it('does not duplicate a cost tab the layout already has', () => {
    const got = sanitizePanes({ panes: [{ tabs: ['cost'], active: 'cost' }, ...old.panes] }, WITH_COST)
    expect(got.flatMap((p) => p.tabs).filter((t) => t === 'cost')).toHaveLength(1)
  })
  it('does nothing when the page has no cost tab', () => {
    expect(sanitizePanes(old, ['agents', 'issues', 'mail', 'machines'])).toEqual(old.panes)
  })
})

describe('activating a tab', () => {
  it('changes only that pane, and only to one of its tabs', () => {
    const next = activate(DEFAULT_PANES, 0, 'issues')
    expect(next[0].active).toBe('issues')
    expect(next[1]).toBe(DEFAULT_PANES[1])
    expect(activate(DEFAULT_PANES, 0, 'mail')).toBe(DEFAULT_PANES)
    expect(activate(DEFAULT_PANES, 0, 'agents')).toBe(DEFAULT_PANES)
    expect(activate(DEFAULT_PANES, 7, 'agents')).toBe(DEFAULT_PANES)
  })
})

describe('tab keys', () => {
  const tabs = ['a', 'b', 'c']
  it('steps with wrap, and jumps to the ends', () => {
    expect(tabKey(tabs, 'a', 'ArrowRight')).toBe('b')
    expect(tabKey(tabs, 'c', 'ArrowRight')).toBe('a')
    expect(tabKey(tabs, 'a', 'ArrowLeft')).toBe('c')
    expect(tabKey(tabs, 'b', 'Home')).toBe('a')
    expect(tabKey(tabs, 'b', 'End')).toBe('c')
  })
  it('ignores other keys and unknown tabs', () => {
    expect(tabKey(tabs, 'a', 'Enter')).toBeNull()
    expect(tabKey(tabs, 'z', 'ArrowRight')).toBeNull()
  })
})

describe('tab strip height', () => {
  it('is compact unless the stored value says regular', () => {
    expect(sanitizeTabBar({ tabBar: 'regular' })).toBe('regular')
    expect(sanitizeTabBar({ tabBar: 'huge' })).toBe('compact')
    expect(sanitizeTabBar(null)).toBe('compact')
  })
})

describe('sidebar layout edits (S-1422)', () => {
  const L = () => [{ tabs: ['agents', 'issues'], active: 'agents' }, { tabs: ['mail'], active: 'mail' }, { tabs: ['machines'], active: 'machines' }]
  it('lists tabs no pane holds', () => {
    expect(unusedTabs(L(), [...KNOWN, 'cost'])).toEqual(['cost'])
  })
  it('moves a pane up and down and stops at the ends', () => {
    expect(movePane(L(), 1, -1).map((p) => p.tabs[0])).toEqual(['mail', 'agents', 'machines'])
    expect(movePane(L(), 2, 1)).toEqual(L())
    expect(movePane(L(), 0, -1)).toEqual(L())
  })
  it('removes a pane but keeps the last one', () => {
    expect(removePane(L(), 1).map((p) => p.tabs[0])).toEqual(['agents', 'machines'])
    expect(removePane([{ tabs: ['mail'], active: 'mail' }], 0)).toHaveLength(1)
  })
  it('adds a pane for a tab and respects MAX_PANES', () => {
    const got = addPane([{ tabs: ['agents', 'issues'], active: 'agents' }], 'issues')
    expect(got).toEqual([{ tabs: ['agents'], active: 'agents' }, { tabs: ['issues'], active: 'issues' }])
    const full = Array.from({ length: MAX_PANES }, (_, i) => ({ tabs: ['t' + i], active: 't' + i }))
    expect(addPane(full, 'x')).toBe(full)
  })
  it('moves a tab within its pane', () => {
    expect(moveTab(L(), 'issues', -1)[0].tabs).toEqual(['issues', 'agents'])
    expect(moveTab(L(), 'issues', 1)).toEqual(L())
  })
  it('sends a tab to another pane and fixes the pane it left', () => {
    const got = sendTab(L(), 'agents', 1)
    expect(got[0]).toEqual({ tabs: ['issues'], active: 'issues' })
    expect(got[1].tabs).toEqual(['mail', 'agents'])
    const merged = sendTab(L(), 'mail', 0)
    expect(merged.map((p) => p.tabs)).toEqual([['agents', 'issues', 'mail'], ['machines']])
    expect(sendTab(L(), 'mail', 9)).toEqual(L())
  })
  it('sends an unused tab into a pane', () => {
    expect(sendTab(L(), 'cost', 2)[2].tabs).toEqual(['machines', 'cost'])
  })
  it('removes a tab and the pane it empties, but never the last tab', () => {
    expect(removeTab(L(), 'mail').map((p) => p.tabs)).toEqual([['agents', 'issues'], ['machines']])
    expect(removeTab(L(), 'agents')[0]).toEqual({ tabs: ['issues'], active: 'issues' })
    const one = [{ tabs: ['mail'], active: 'mail' }]
    expect(removeTab(one, 'mail')).toBe(one)
  })
  it('edited layouts survive the stored-value cleaning unchanged', () => {
    const edited = sendTab(addPane(L(), 'issues'), 'machines', 0)
    expect(sanitizePanes({ panes: edited }, KNOWN)).toEqual(edited)
  })
})

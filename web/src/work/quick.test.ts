import { describe, expect, it } from 'vitest'
import type { Itsa } from '../types'
import { cleanQuick, quickKeeps, toggleQuick, type StatusLookup } from './quick'
import { groupFlat } from './model'
import { clearFilters, defaultLayout, setFilter, setQuick, useView, type SavedView } from './views'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const st: StatusLookup = {
  category: (s) => ({ in_progress: 'active', waiting: 'active', blocked: 'active', in_review: 'review', done: 'closed' }[s] ?? 'backlog'),
  human: (s) => s === 'needs_input',
}
const mk = (more: Partial<Itsa>) => ({ id: 'x', key: 'S-1', title: 't', summary: null, status: 'in_progress', parent_id: null, owner: 'a1', updated_at: '2026-10-18T11:00:00Z', links: [], participants: [], ...more }) as unknown as Itsa
const keeps = (on: Parameters<typeof quickKeeps>[0], i: Itsa) => quickKeeps(on, i, st, NOW)

describe('quick filters', () => {
  it('waiting is a human status', () => {
    expect(keeps(['waiting'], mk({ status: 'needs_input' }))).toBe(true)
    expect(keeps(['waiting'], mk({ status: 'in_progress' }))).toBe(false)
  })
  it('mine is the human as owner or participant', () => {
    expect(keeps(['mine'], mk({ owner: 'human' }))).toBe(true)
    expect(keeps(['mine'], mk({ participants: ['a1', 'human'] }))).toBe(true)
    expect(keeps(['mine'], mk({ participants: ['a1'] }))).toBe(false)
  })
  it('stale is active with no update in 2 days', () => {
    expect(keeps(['stale'], mk({ updated_at: '2026-10-15T00:00:00Z' }))).toBe(true)
    expect(keeps(['stale'], mk({ updated_at: '2026-10-17T00:00:00Z' }))).toBe(false)
    expect(keeps(['stale'], mk({ status: 'in_review', updated_at: '2026-10-01T00:00:00Z' }))).toBe(false)
  })
  it('blocked, in review and has a PR (an issue or repo link is not one)', () => {
    expect(keeps(['blocked'], mk({ status: 'blocked' }))).toBe(true)
    expect(keeps(['blocked'], mk({}))).toBe(false)
    expect(keeps(['review'], mk({ status: 'in_review' }))).toBe(true)
    expect(keeps(['review'], mk({}))).toBe(false)
    const pr = { n: 1, system: 'github', url: 'https://github.com/o/r/pull/1' }
    expect(keeps(['pr'], mk({ links: [pr] as never }))).toBe(true)
    expect(keeps(['pr'], mk({ links: [{ n: 2, system: 'branch', url: '' }] as never }))).toBe(false)
    expect(keeps(['pr'], mk({ links: [{ n: 3, system: 'github', url: 'https://github.com/o/r/issues/7' }] as never }))).toBe(false)
    expect(keeps(['pr'], mk({ links: [{ n: 4, system: 'github', url: 'https://github.com/o/r' }] as never }))).toBe(false)
  })
  it('several are ANDed, none keeps all', () => {
    const both = mk({ status: 'in_review', owner: 'human' })
    expect(keeps(['mine', 'review'], both)).toBe(true)
    expect(keeps(['mine', 'blocked'], both)).toBe(false)
    expect(keeps([], both)).toBe(true)
    expect(keeps(undefined, both)).toBe(true)
  })
  it('cleans a stored list and toggles', () => {
    expect(cleanQuick(['pr', 'bogus', 'mine', 'pr'])).toEqual(['mine', 'pr'])
    expect(cleanQuick('x')).toEqual([])
    expect(toggleQuick(['mine'], 'pr')).toEqual(['mine', 'pr'])
    expect(toggleQuick(['mine', 'pr'], 'mine')).toEqual(['pr'])
  })
})

describe('quick filters in the layout and the rows', () => {
  const ids = ['work', 'status']
  it('setQuick toggles, keeps filters, and an empty list is absent', () => {
    const l = setFilter(defaultLayout(ids), 'status', { kind: 'values', values: ['x'] })
    const on = setQuick(l, 'mine')
    expect(on.quick).toEqual(['mine'])
    expect(on.filters).toBeTruthy()
    expect('quick' in setQuick(on, 'mine')).toBe(false)
  })
  it('Clear all removes the quick filters too', () => {
    expect(clearFilters(setQuick(defaultLayout(ids), 'pr')).quick).toBeUndefined()
  })
  it('a saved view keeps them, and a layout without the key has none', () => {
    const view = { id: 'v', name: 'v', show: 'open', cols: ids, group: 'issues', widths: {}, quick: ['stale'] } as SavedView
    const store = { views: [view], current: '', layout: defaultLayout(ids), show: 'open' as const }
    expect(useView(store, 'v', ids).layout.quick).toEqual(['stale'])
    expect(defaultLayout(ids).quick).toBeUndefined()
  })
  it('rows pass only when every quick filter holds', () => {
    const all = [mk({ id: 'a', owner: 'human' }), mk({ id: 'b', owner: 'human', status: 'blocked' }), mk({ id: 'c' })]
    const ids = (quick: never[] | string[]) => groupFlat(all, { show: 'all', text: '', closed: () => false, quick: quick as never, status: st, cx: { now: NOW, extras: {} as never } })[0].rows.map((r) => r.it.id).sort()
    expect(ids([])).toEqual(['a', 'b', 'c'])
    expect(ids(['mine'])).toEqual(['a', 'b'])
    expect(ids(['mine', 'blocked'])).toEqual(['b'])
  })
})

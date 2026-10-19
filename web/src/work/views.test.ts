import { cleanFilters } from './sortfilter'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layout, ViewStore } from './views'
import { clampWidth, clearFilters, setFilter, setSort, setSortKeys, settle, defaultLayout, deleteView, emptyStore, fullOrder, isDirty, moveBy, moveTo, revertView, saveAs, saveView, setGroup, setShown, setWidth, useView, VIEWS_KEY } from './views'

const IDS = ['work', 'status', 'agents', 'branch', 'github', 'test', 'linear', 'link', 'cost', 'health', 'updated']

// The daemon's settings file, as GET returns it and POST replaces it.
const api = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api }))
let settings: Record<string, unknown> = {}

// A minimal localStorage, so the tests run in the node environment.
const mem = new Map<string, string>()
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  mem.clear()
  settings = {}
  api.mockReset()
  api.mockImplementation((method: string, path: string, body?: { patch: Record<string, Record<string, unknown>>; fill?: boolean }) => {
    if (method === 'GET' && path === '/api/config/settings') return Promise.resolve({ text: JSON.stringify(settings) })
    if (method === 'PATCH' && path === '/api/config/settings') {
      for (const [k, v] of Object.entries(body!.patch)) {
        const cur = (settings[k] ?? {}) as Record<string, unknown>
        const next = { ...cur }
        for (const [id, x] of Object.entries(v)) {
          if (body!.fill && id in cur) continue
          if (x === null) delete next[id]; else next[id] = x
        }
        settings[k] = next
      }
      return Promise.resolve({})
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`))
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) }, removeItem: (k: string) => { mem.delete(k) } },
  })
})

// A fresh page: the views as they load from settings (or the browser's copy, once).
async function page() {
  vi.resetModules()
  const v = await import('./views')
  await v.loadWork()
  return v
}

describe('layout', () => {
  it('reorders but keeps work first', () => {
    const l = defaultLayout(IDS)
    expect(moveTo(l, IDS, 'status', 99).cols).toEqual(['work', 'agents', 'branch', 'github', 'test', 'linear', 'link', 'cost', 'health', 'updated', 'status'])
    expect(moveTo(l, IDS, 'cost', 0).cols[0]).toBe('work')
    expect(moveBy(l, IDS, 'health', 5).cols.at(-1)).toBe('health')
    expect(moveBy(l, IDS, 'work', 1)).toEqual(l)
  })

  it('moves one step by delta and ignores columns not shown', () => {
    const l = defaultLayout(IDS)
    expect(moveBy(l, IDS, 'agents', -1).cols.slice(0, 4)).toEqual(['work', 'agents', 'status', 'branch'])
    const hidden = setShown(l, IDS, 'cost', false)
    expect(moveBy(hidden, IDS, 'cost', 1)).toEqual(hidden)
  })

  it('hides and shows a column, returning a shown one to its registry place', () => {
    const hidden = setShown(defaultLayout(IDS), IDS, 'branch', false)
    expect(hidden.cols).not.toContain('branch')
    expect(setShown(hidden, IDS, 'branch', true).cols).toEqual(IDS)
    expect(setShown(hidden, IDS, 'work', false).cols).toContain('work')
  })

  it('lists hidden columns in the menu at their registry place', () => {
    const hidden = setShown(defaultLayout(IDS), IDS, 'cost', false)
    expect(fullOrder(hidden.cols, IDS)).toEqual(IDS)
  })

  it('clamps resized widths to 48 to 800 px and resets with null', () => {
    expect(clampWidth(10)).toBe(48)
    expect(clampWidth(5000)).toBe(800)
    const w = setWidth(defaultLayout(IDS), 'branch', 1200)
    expect(w.widths.branch).toBe(800)
    expect(setWidth(w, 'branch', null).widths).toEqual({})
  })
})

describe('views storage', () => {
  it('saves the views to settings, not this browser, and loads them back', async () => {
    const v = await page()
    let s = emptyStore(IDS)
    s = { ...s, layout: setShown(s.layout, IDS, 'cost', false) }
    s = saveAs(s, '  Costs  ', 'all', IDS, 'v1')
    v.saveStore(s)
    await vi.runAllTimersAsync()
    const saved = settings.workViews as Record<string, Record<string, unknown>>
    expect(saved.v1).toEqual({ name: 'Costs', show: 'all', cols: s.layout.cols, group: 'issues' })
    expect(saved.work).toEqual({ current: 'v1', show: 'open', cols: s.layout.cols, group: 'issues' })
    expect(mem.has(VIEWS_KEY)).toBe(false)
    const back = (await page()).loadStore(IDS)
    expect(back.views).toEqual([{ id: 'v1', name: 'Costs', show: 'all', cols: s.layout.cols, widths: {}, group: 'issues' }])
    expect(back.current).toBe('v1')
    expect(back.show).toBe('open')
    const d = deleteView(back, 'v1', IDS)
    expect(d.views).toEqual([])
    expect(d.current).toBe('')
    expect(d.layout.cols).toEqual(IDS)
  })

  it('keeps column widths on this device, per view, out of settings', async () => {
    const v = await page()
    const s = saveAs({ ...emptyStore(IDS), layout: setWidth(defaultLayout(IDS), 'cost', 200) }, 'Wide', 'open', IDS, 'w')
    v.saveStore(s)
    await vi.runAllTimersAsync()
    expect(JSON.stringify(settings)).not.toContain('widths')
    expect(JSON.parse(mem.get('stam/work-widths')!)).toEqual({ '': { cost: 200 }, w: { cost: 200 } })
    expect((await page()).loadStore(IDS).views[0].widths).toEqual({ cost: 200 })
  })

  it('switches to Default and back, keeping the saved columns and widths', async () => {
    const saved = { ...emptyStore(IDS), layout: setWidth(setShown(defaultLayout(IDS), IDS, 'branch', false), 'cost', 200) }
    const s = saveAs(saved, 'Lean', 'open', IDS, 'v1')
    const onDefault = useView(s, '', IDS)
    expect(onDefault.layout).toEqual(defaultLayout(IDS))
    const back = useView(onDefault, 'v1', IDS)
    expect(back.layout.cols).not.toContain('branch')
    expect(back.layout.widths).toEqual({ cost: 200 })
  })

  it('deleting a view that is not current keeps the layout', () => {
    const s = saveAs(emptyStore(IDS), 'A', 'open', IDS, 'a')
    const moved = { ...s, current: '', layout: moveBy(s.layout, IDS, 'agents', 1) }
    expect(deleteView(moved, 'a', IDS).layout).toEqual(moved.layout)
  })

  it('keeps a stored layout with work first', async () => {
    settings = { workViews: { work: { cols: ['cost', 'work'], group: 'issues', show: 'open' } } }
    expect((await page()).loadStore(IDS).layout.cols).toEqual(['work', 'cost'])
  })

  // S-363: the one Links column became a column per kind of link, and the actions column went.
  it('turns a stored Links column into the link columns, in its place, and drops actions', async () => {
    settings = { workViews: {
      work: { cols: ['work', 'cost', 'links', 'status', 'actions'], group: 'issues', show: 'open' },
      v: { name: 'Mine', cols: ['work', 'links', 'github', 'actions'], group: 'flat', show: 'all' },
    } }
    const s = (await page()).loadStore(IDS)
    expect(s.layout.cols).toEqual(['work', 'cost', 'branch', 'github', 'test', 'linear', 'link', 'status'])
    expect(s.views[0].cols).toEqual(['work', 'branch', 'github', 'test', 'linear', 'link'])
  })

  it('falls back to the default when the stored value is not a store', async () => {
    settings = { workViews: 'nope' }
    expect((await page()).loadStore(IDS)).toEqual(emptyStore(IDS))
  })

  it('drops unknown columns, bad widths, and malformed views', async () => {
    settings = { workViews: {
      work: { current: 'x', cols: 'work' },
      x: { name: 'Ok', cols: ['work', 'nope', 'status', 'status'], show: 'bogus' },
      y: { name: '   ', cols: ['work'] },
      z: { show: 'open' },
    } }
    mem.set('stam/work-widths', JSON.stringify({ x: { status: 9999, nope: 3, cost: 'wide' }, '': null }))
    const s = (await page()).loadStore(IDS)
    expect(s.views).toEqual([{ id: 'x', name: 'Ok', cols: ['work', 'status'], widths: { status: 800 }, show: 'open', group: 'issues' }])
    expect(s.current).toBe('x')
    // Columns that aren't a list leave only the locked one.
    expect(s.layout).toEqual({ cols: ['work'], group: 'issues', widths: {} })
  })

  it('keeps the grouping with the layout and in saved views, and falls back to Issues', async () => {
    const grouped = setGroup(defaultLayout(IDS), 'agents')
    expect(defaultLayout(IDS).group).toBe('issues')
    const v = await page()
    v.saveStore(saveAs({ ...emptyStore(IDS), layout: grouped }, 'By agent', 'open', IDS, 'g'))
    await vi.runAllTimersAsync()
    const back = (await page()).loadStore(IDS)
    expect(back.layout.group).toBe('agents')
    expect(back.views[0].group).toBe('agents')
    // Switching to Default resets it; the saved view brings it back.
    expect(useView(back, '', IDS).layout.group).toBe('issues')
    expect(useView(back, 'g', IDS).layout.group).toBe('agents')
    // A stored group that isn't one of the modes is Issues.
    settings = { workViews: { work: { cols: IDS, group: 'tree', show: 'open' }, b: { name: 'Bad', cols: IDS, group: 'tree' } } }
    expect((await page()).loadStore(IDS).layout.group).toBe('issues')
    expect((await page()).loadStore(IDS).views[0].group).toBe('issues')
  })

  it('sets the grouping without touching the columns', () => {
    const l = setShown(defaultLayout(IDS), IDS, 'branch', false)
    expect(setGroup(l, 'flat')).toEqual({ ...l, group: 'flat' })
  })

  it('treats a current id that no view has as Default', async () => {
    settings = { workViews: { work: { current: 'gone', cols: IDS, group: 'issues', show: 'open' } } }
    expect((await page()).loadStore(IDS).current).toBe('')
  })

  it('a width change writes this device only, and sends no settings request', async () => {
    const v = await page()
    const before = api.mock.calls.length
    v.saveWidthsOf({ ...emptyStore(IDS), layout: setWidth(defaultLayout(IDS), 'cost', 200) })
    await vi.runAllTimersAsync()
    expect(api.mock.calls.slice(before)).toEqual([])
    expect(JSON.parse(mem.get('stam/work-widths')!)).toEqual({ '': { cost: 200 } })
  })

  it('saving a store that holds what settings hold sends nothing', async () => {
    const v = await page()
    v.saveStore(saveAs(emptyStore(IDS), 'Same', 'open', IDS, 'same'))
    await vi.runAllTimersAsync()
    const before = api.mock.calls.length
    v.saveStore(v.loadStore(IDS))
    await vi.runAllTimersAsync()
    expect(api.mock.calls.slice(before)).toEqual([])
  })

  it('keeps the open/all filter with the views', async () => {
    const v = await page()
    const s: ViewStore = { ...emptyStore(IDS), show: 'all' }
    v.saveStore(s)
    await vi.runAllTimersAsync()
    expect((await page()).loadStore(IDS).show).toBe('all')
  })

  it('migrates the browser copy once: views to settings, widths and the filter stay here', async () => {
    mem.set(VIEWS_KEY, JSON.stringify({
      views: [{ id: 'v1', name: 'Costs', show: 'all', cols: IDS, widths: { cost: 300 }, group: 'flat' }],
      current: 'v1',
      layout: { cols: IDS, widths: { status: 120 }, group: 'issues' },
    }))
    mem.set('stam/work', JSON.stringify({ show: 'all', folded: { x: true } }))
    const s = (await page()).loadStore(IDS)
    expect(s.current).toBe('v1')
    expect(s.show).toBe('all')
    expect(s.layout.widths).toEqual({ status: 120 })
    await vi.runAllTimersAsync()
    expect(mem.has(VIEWS_KEY)).toBe(false)
    expect(Object.keys(settings.workViews as object).sort()).toEqual(['v1', 'work'])
    expect((settings.workViews as Record<string, unknown>).v1).toMatchObject({ name: 'Costs', show: 'all' })
    expect(JSON.parse(mem.get('stam/work-widths')!)).toEqual({ '': { status: 120 }, v1: { cost: 300 } })
  })

  it('survives storage that throws', async () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } } })
    const v = await page()
    expect(v.loadStore(IDS)).toEqual(emptyStore(IDS))
    expect(() => v.saveStore(emptyStore(IDS))).not.toThrow()
  })
})

// ITSA fields among the columns (S-369): `field:<id>` ids, and which ones a layout has seen.
describe('field columns in a layout', () => {
  const F = [...IDS, 'field:f1', 'field:f2']

  it('keeps field ids and puts the default layout\'s seen list at the fields', () => {
    const l = defaultLayout(F)
    expect(l.cols).toEqual(F)
    expect(l.seen).toEqual(['f1', 'f2'])
    expect(setShown(l, F, 'field:f1', false).cols).not.toContain('field:f1')
    expect(moveTo(l, F, 'field:f2', 1).cols.slice(0, 3)).toEqual(['work', 'field:f2', 'status'])
  })

  it('shows a field the layout never saw, at its place, and keeps a hidden seen one hidden', () => {
    const stored = ['work', 'status', 'cost']
    expect(settle(stored, undefined, F).cols).toEqual(['work', 'status', 'cost', 'field:f1', 'field:f2'])
    expect(settle(stored, ['f1'], F)).toEqual({ cols: ['work', 'status', 'cost', 'field:f2'], seen: ['f1', 'f2'] })
    expect(settle(stored, ['f1', 'f2'], F).cols).toEqual(stored)
  })

  it('a layout from before fields reveals the fields only, not the built-ins it hid', () => {
    const hidden = ['work', 'status']
    expect(settle(hidden, undefined, F).cols).toEqual(['work', 'status', 'field:f1', 'field:f2'])
  })

  it('a removed field drops out of the columns and the seen list', () => {
    const ids = [...IDS, 'field:f2']
    expect(settle(['work', 'field:f1', 'field:f2'], ['f1', 'f2'], ids)).toEqual({ cols: ['work', 'field:f2'], seen: ['f2'] })
  })

  it('a new field takes its registry place among the shown columns', () => {
    const ids = ['work', 'status', 'field:f1', 'cost']
    expect(settle(['work', 'status', 'cost'], [], ids).cols).toEqual(['work', 'status', 'field:f1', 'cost'])
  })

  it('stores the seen list with the layout and each view, and loads a store without one as unseen', async () => {
    const v = await page()
    let s = emptyStore(F)
    s = { ...s, layout: setShown(s.layout, F, 'field:f1', false) }
    s = saveAs(s, 'V', 'open', F, 'v1')
    v.saveStore(s)
    await vi.runAllTimersAsync()
    const saved = settings.workViews as Record<string, Record<string, unknown>>
    expect(saved.work.seen).toEqual(['f1', 'f2'])
    expect(saved.v1.seen).toEqual(['f1', 'f2'])
    const back = (await page()).loadStore(F)
    expect(back.layout.cols).not.toContain('field:f1')
    expect(back.views[0].cols).not.toContain('field:f1')
    settings = { workViews: { work: { show: 'open', cols: ['work', 'status'], group: 'issues' } } }
    expect((await page()).loadStore(F).layout.cols).toEqual(['work', 'status', 'field:f1', 'field:f2'])
  })

  it('layouts loaded before the fields are known don\'t drop them from settings', async () => {
    settings = { workViews: { work: { show: 'open', cols: ['work', 'field:f1'], group: 'issues', seen: ['f1'] } } }
    const early = (await page()).loadStore(IDS)
    expect(early.layout.cols).toEqual(['work'])
    expect((settings.workViews as Record<string, { cols: string[] }>).work.cols).toEqual(['work', 'field:f1'])
    expect((await page()).loadStore(F).layout.cols).toEqual(['work', 'field:f1', 'field:f2'])
  })

  // A save never drops or adds a field the page doesn't know; only a settled one writes the fields as they are.
  it('passes unknown field columns, seen entries and widths through a save, at their stored place', async () => {
    settings = { workViews: { work: { show: 'open', cols: ['work', 'field:f1', 'status', 'field:f9', 'cost'], group: 'issues', seen: ['f1', 'f9'] } } }
    mem.set('stam/work-widths', JSON.stringify({ '': { 'field:f9': 150, cost: 90 } }))
    const v = await page()
    const ids = [...IDS]
    const store = { ...emptyStore(ids), layout: { cols: ['work', 'status', 'cost'], widths: { cost: 120 }, group: 'flat' as const } }
    v.saveStore(store, ids)
    await vi.runAllTimersAsync()
    expect((settings.workViews as Record<string, { cols: string[]; seen: string[] }>).work).toMatchObject({ group: 'flat', cols: ['work', 'field:f1', 'status', 'field:f9', 'cost'], seen: ['f1', 'f9'] })
    expect(JSON.parse(mem.get('stam/work-widths')!)['']).toEqual({ cost: 120, 'field:f9': 150 })
  })

  it('writes the fields as they are when the layout is settled against a loaded list', async () => {
    settings = { workViews: { work: { show: 'open', cols: ['work', 'field:f9', 'status'], group: 'issues', seen: ['f9'] } } }
    mem.set('stam/work-widths', JSON.stringify({ '': { 'field:f9': 150 } }))
    const v = await page()
    v.saveStore({ ...emptyStore(IDS), layout: { cols: ['work', 'status'], widths: {}, group: 'issues' } }, IDS, true)
    await vi.runAllTimersAsync()
    const w = (settings.workViews as Record<string, { cols: string[]; seen?: string[] }>).work
    expect(w.cols).toEqual(['work', 'status'])
    expect(w.seen).toBeUndefined()
    expect(JSON.parse(mem.get('stam/work-widths')!)['']).toEqual({})
  })
})

describe('sort and filters in a layout', () => {
  const base = defaultLayout(IDS)
  const dirs = (l: ReturnType<typeof defaultLayout>) => (l.sort ?? []).map((k) => `${k.col}:${k.dir}`)

  it('a plain sort replaces the keys with this one; null removes the key', () => {
    const a = setSort(base, 'status', 'asc', false)
    expect(dirs(setSort(a, 'cost', 'desc', false))).toEqual(['cost:desc'])
    expect(dirs(setSort(a, 'status', 'desc', false))).toEqual(['status:desc'])
    expect(setSort(a, 'status', null, false)).toEqual(base)
    expect('sort' in setSort(a, 'status', null, true)).toBe(false)
  })

  it('setSortKeys replaces the whole sort, drops repeats, keeps the filters, and an empty list removes it', () => {
    const f = setFilter(base, 'status', { kind: 'values', values: ['done'] })
    const a = setSortKeys(f, [{ col: 'cost', dir: 'desc' }, { col: 'status', dir: 'asc' }, { col: 'cost', dir: 'asc' }])
    expect(dirs(a)).toEqual(['cost:desc', 'status:asc'])
    expect(a.filters).toEqual(f.filters)
    expect(setSortKeys(a, [])).toEqual(f)
  })

  it('an added sort appends a key, updates one in place, or removes it, leaving the others', () => {
    const a = setSort(setSort(base, 'status', 'asc', false), 'cost', 'desc', true)
    expect(dirs(a)).toEqual(['status:asc', 'cost:desc'])
    expect(dirs(setSort(a, 'status', 'desc', true))).toEqual(['status:desc', 'cost:desc'])
    expect(dirs(setSort(a, 'status', null, true))).toEqual(['cost:desc'])
    expect(dirs(setSort(a, 'status', null, false))).toEqual(['cost:desc'])
    expect(setSort(base, 'gone', null, true)).toEqual(base)
  })

  it('sets, replaces, and removes a filter, and clears them all but keeps the sort', () => {
    const a = setFilter(setSort(base, 'status', 'asc', false), 'status', { kind: 'values', values: ['todo'] })
    const b = setFilter(a, 'cost', { kind: 'range', min: 1 })
    expect(b.filters).toEqual({ status: { kind: 'values', values: ['todo'] }, cost: { kind: 'range', min: 1 } })
    expect(setFilter(b, 'status', { kind: 'values', values: [] }).filters!.status).toEqual({ kind: 'values', values: [] })
    expect(setFilter(b, 'status', null).filters).toEqual({ cost: { kind: 'range', min: 1 } })
    expect(setFilter(a, 'status', null)).toEqual(setSort(base, 'status', 'asc', false))
    expect(clearFilters(b)).toEqual(setSort(base, 'status', 'asc', false))
    expect(base).toEqual(defaultLayout(IDS))
  })

  it('stores sort and filters with the layout and each view, and a view brings them back', async () => {
    const v = await page()
    let st = v.loadStore(IDS)
    st = { ...st, layout: setFilter(setSort(st.layout, 'status', 'desc', false), 'cost', { kind: 'range', max: 5 }) }
    st = v.saveAs(st, 'Mine', 'open', IDS, 'v1')
    v.saveStore(st)
    await vi.runAllTimersAsync()
    expect((settings.workViews as Record<string, unknown>).work).toMatchObject({ sort: [{ col: 'status', dir: 'desc' }], filters: { cost: { kind: 'range', max: 5 } } })
    const back = (await page()).loadStore(IDS)
    expect(back.layout.sort).toEqual([{ col: 'status', dir: 'desc' }])
    expect(back.views[0].filters).toEqual({ cost: { kind: 'range', max: 5 } })
    const other = v.useView(v.useView(back, '', IDS), 'v1', IDS)
    expect(other.layout.filters).toEqual({ cost: { kind: 'range', max: 5 } })
    expect(v.useView(back, '', IDS).layout.sort).toBeUndefined()
  })

  it('stores the quick filters with the layout and each view; a missing or bogus key loads as none', async () => {
    const v = await page()
    let st = v.loadStore(IDS)
    st = { ...st, layout: { ...st.layout, quick: ['stale', 'pr'] } }
    st = v.saveAs(st, 'Q', 'open', IDS, 'v1')
    v.saveStore(st)
    await vi.runAllTimersAsync()
    expect((settings.workViews as Record<string, unknown>).work).toMatchObject({ quick: ['stale', 'pr'] })
    const back = (await page()).loadStore(IDS)
    expect(back.layout.quick).toEqual(['stale', 'pr'])
    expect(back.views[0].quick).toEqual(['stale', 'pr'])
    expect(v.useView(back, '', IDS).layout.quick).toBeUndefined()
    expect(v.useView(back, 'v1', IDS).layout.quick).toEqual(['stale', 'pr'])
    settings = { workViews: { work: { cols: ['work'] }, x: { name: 'V', cols: ['work'], quick: ['bogus'] } } }
    const bad = (await page()).loadStore(IDS)
    expect(bad.layout.quick).toBeUndefined()
    expect(bad.views[0].quick).toBeUndefined()
  })

  it('loads a stored layout with bad sort or filters cleanly, dropping unknown columns and malformed filters', async () => {
    settings = { workViews: {
      work: { cols: ['work', 'status'], sort: [{ col: 'nope', dir: 'asc' }, { col: 'status', dir: 'sideways' }, { col: 'cost', dir: 'desc' }, 7],
        filters: { status: { kind: 'values', values: 'todo' }, cost: { kind: 'range', min: 'x' }, health: { kind: 'has', has: true }, ghost: { kind: 'has', has: true } } },
      x: { name: 'V', cols: ['work'], sort: 'status', filters: ['a'] },
      y: { name: 'W', cols: ['work'], sort: [{ col: 'gone', dir: 'asc' }], filters: { gone: { kind: 'has', has: true } } },
    } }
    const s = (await page()).loadStore(IDS)
    expect(s.layout.sort).toEqual([{ col: 'cost', dir: 'desc' }])
    expect(s.layout.filters).toEqual({ health: { kind: 'has', has: true } })
    expect(s.views.map((v) => [v.sort, v.filters])).toEqual([[undefined, undefined], [undefined, undefined]])
    settings = { workViews: 5 }
    expect((await page()).loadStore(IDS)).toEqual(emptyStore(IDS))
  })

  it('a save keeps the sort and filters of a field column the page does not know', async () => {
    const stored = () => ({ workViews: { work: { cols: ['work', 'field:f1'], sort: [{ col: 'status', dir: 'asc' }, { col: 'field:f1', dir: 'asc' }], filters: { 'field:f1': { kind: 'has', has: true } } } } })
    const saved = async (edit: (l: Layout) => Layout) => {
      settings = stored()
      const v = await page()
      const st = v.loadStore(IDS)
      expect(st.layout.sort).toEqual([{ col: 'status', dir: 'asc' }])
      v.saveStore({ ...st, layout: edit(st.layout) }, IDS)
      await vi.runAllTimersAsync()
      return (settings.workViews as Record<string, Record<string, unknown>>).work
    }
    // Adding a key or flipping one keeps the hidden key and the filter.
    expect(await saved((l) => setSort(l, 'status', 'desc', false))).toMatchObject({ sort: [{ col: 'status', dir: 'desc' }, { col: 'field:f1', dir: 'asc' }], filters: { 'field:f1': { kind: 'has', has: true } } })
    expect((await saved((l) => setSort(l, 'cost', 'asc', true))).sort).toEqual([{ col: 'status', dir: 'asc' }, { col: 'cost', dir: 'asc' }, { col: 'field:f1', dir: 'asc' }])
    // A replace that drops the known key is a new sort: no hidden second key.
    expect((await saved((l) => setSort(l, 'cost', 'asc', false))).sort).toEqual([{ col: 'cost', dir: 'asc' }])
    expect((await saved((l) => setSort(l, 'status', null, false))).sort).toBeUndefined()
  })
})

describe('saved view tabs', () => {
  const fresh = (): ViewStore => emptyStore(IDS)
  const saved = (layout: Layout) => saveAs({ ...fresh(), layout }, 'Mine', 'open', IDS, 'v1')

  it('a saved view keeps each of sort, filters and quick through Save as, a save and a reload, and Default has none', async () => {
    const v = await page()
    const cases: [string, Partial<Layout>][] = [
      ['sort', { sort: [{ col: 'cost', dir: 'desc' }] }],
      ['filters', { filters: { status: { kind: 'values', values: ['todo'] } } }],
      ['quick', { quick: ['mine'] }],
    ]
    for (const [key, part] of cases) {
      settings = {}
      mem.clear()
      const p = await page()
      let st = p.saveAs({ ...p.loadStore(IDS), layout: { ...defaultLayout(IDS), ...part } }, 'V', 'open', IDS, 'v1')
      st = p.useView(p.useView(st, '', IDS), 'v1', IDS)
      expect((st.layout as unknown as Record<string, unknown>)[key], key).toEqual((part as Record<string, unknown>)[key])
      p.saveStore(st)
      await vi.runAllTimersAsync()
      const back = (await page()).loadStore(IDS)
      expect((back.views[0] as unknown as Record<string, unknown>)[key], key).toEqual((part as Record<string, unknown>)[key])
      expect((back.layout as unknown as Record<string, unknown>)[key], key).toEqual((part as Record<string, unknown>)[key])
      expect((v.useView(back, '', IDS).layout as unknown as Record<string, unknown>)[key], key).toBeUndefined()
    }
  })

  it('a view is clean as saved, and edits to sort, a filter, a quick filter, columns, grouping or show mark it', () => {
    const st = saved(setSort(defaultLayout(IDS), 'cost', 'asc', false))
    expect(isDirty(st, IDS)).toBe(false)
    const edits: Layout[] = [
      setSort(st.layout, 'cost', 'desc', false),
      setFilter(st.layout, 'status', { kind: 'values', values: ['done'] }),
      { ...st.layout, quick: ['stale'] },
      setShown(st.layout, IDS, 'cost', false),
      setGroup(st.layout, 'flat'),
    ]
    for (const layout of edits) expect(isDirty({ ...st, layout }, IDS)).toBe(true)
    expect(isDirty({ ...st, show: 'all' }, IDS)).toBe(true)
  })

  it('the chip on the Glance (setGroup to issues) returns a view saved without a column grouping to clean', () => {
    const st = saved(setSort(defaultLayout(IDS), 'cost', 'asc', false))
    const grouped = { ...st, layout: setGroup(st.layout, 'column', 'status') }
    expect(isDirty(grouped, IDS)).toBe(true)
    expect(isDirty({ ...grouped, layout: setGroup(grouped.layout, 'issues') }, IDS)).toBe(false)
  })

  it('a resize does not mark a view edited, and Default is dirty once it is changed', () => {
    const st = saved(defaultLayout(IDS))
    expect(isDirty({ ...st, layout: setWidth(st.layout, 'cost', 300) }, IDS)).toBe(false)
    const def = fresh()
    expect(isDirty(def, IDS)).toBe(false)
    expect(isDirty({ ...def, layout: setFilter(def.layout, 'cost', { kind: 'range', min: 1 }) }, IDS)).toBe(true)
  })

  it('the order a filter\'s values, or the quick filters, were ticked in does not mark a view edited', () => {
    const st = saved({ ...setFilter(defaultLayout(IDS), 'status', { kind: 'values', values: ['a', 'b'] }), quick: ['stale', 'pr'] })
    const reordered = { ...setFilter(st.layout, 'status', { kind: 'values', values: ['b', 'a'] }), quick: ['pr', 'stale'] as Layout['quick'] }
    expect(isDirty({ ...st, layout: reordered }, IDS)).toBe(false)
    expect(isDirty({ ...st, layout: setFilter(st.layout, 'status', { kind: 'values', values: ['a'] }) }, IDS)).toBe(true)
  })

  it('a not rule round-trips a saved view, and its order does not mark it edited', () => {
    const st = saved(setFilter(defaultLayout(IDS), 'status', { kind: 'values', not: ['a', 'b'] }))
    expect(st.layout.filters).toEqual({ status: { kind: 'values', not: ['a', 'b'] } })
    expect(cleanFilters(JSON.parse(JSON.stringify(st.layout.filters)))).toEqual(st.layout.filters)
    expect(isDirty({ ...st, layout: setFilter(st.layout, 'status', { kind: 'values', not: ['b', 'a'] }) }, IDS)).toBe(false)
    expect(isDirty({ ...st, layout: setFilter(st.layout, 'status', { kind: 'values', not: ['a'] }) }, IDS)).toBe(true)
  })

  it('Save overwrites the current view with the working layout, and clears the mark', () => {
    let st = saved(setSort(defaultLayout(IDS), 'cost', 'asc', false))
    st = { ...st, layout: clearFilters(setFilter({ ...setSort(st.layout, 'status', 'desc', false), quick: ['pr'] }, 'cost', { kind: 'range', max: 2 })), show: 'all' }
    st = { ...st, layout: { ...st.layout, quick: ['pr'] } }
    const out = saveView(st, IDS)
    expect(out.views[0]).toMatchObject({ id: 'v1', name: 'Mine', show: 'all', sort: [{ col: 'status', dir: 'desc' }], quick: ['pr'] })
    expect(isDirty(out, IDS)).toBe(false)
    // an edit that removed the sort leaves the view without one
    expect(saveView({ ...st, layout: setSort(st.layout, 'status', null, false) }, IDS).views[0].sort).toBeUndefined()
    expect(saveView(fresh(), IDS)).toEqual(fresh())
  })

  it('Revert drops the unsaved edits, show included, and Default goes back to the default layout', () => {
    const st = saved(setSort(defaultLayout(IDS), 'cost', 'asc', false))
    const edited = { ...st, show: 'all' as const, layout: setFilter(setGroup(st.layout, 'agents'), 'status', { kind: 'values', values: ['todo'] }) }
    const back = revertView(edited, IDS)
    expect(back.show).toBe('open')
    expect(back.layout.sort).toEqual([{ col: 'cost', dir: 'asc' }])
    expect(back.layout.filters).toBeUndefined()
    expect(back.layout.group).toBe('issues')
    expect(isDirty(back, IDS)).toBe(false)
    const def = revertView({ ...fresh(), show: 'all', layout: setSort(defaultLayout(IDS), 'cost', 'asc', false) }, IDS)
    expect(def.layout).toEqual(defaultLayout(IDS))
    expect(def.show).toBe('open')
  })
})

describe('grouping by a column (S-1520)', () => {
  const by = (col: string) => setGroup(defaultLayout(IDS), 'column', col)

  it('setGroup keeps the column only for a column grouping', () => {
    expect(by('status')).toMatchObject({ group: 'column', groupBy: 'status' })
    expect('groupBy' in setGroup(by('status'), 'flat')).toBe(false)
    expect('groupBy' in setGroup(by('status'), 'column')).toBe(false)
    expect(setGroup(by('status'), 'column', 'health').groupBy).toBe('health')
  })

  it('a saved view keeps the column through Save as, a reload and Default', async () => {
    const p = await page()
    let st = p.saveAs({ ...p.loadStore(IDS), layout: by('health') }, 'V', 'open', IDS, 'v1')
    st = p.useView(p.useView(st, '', IDS), 'v1', IDS)
    expect(st.layout).toMatchObject({ group: 'column', groupBy: 'health' })
    p.saveStore(st)
    await vi.runAllTimersAsync()
    const back = (await page()).loadStore(IDS)
    expect(back.views[0]).toMatchObject({ group: 'column', groupBy: 'health' })
    expect(back.layout).toMatchObject({ group: 'column', groupBy: 'health' })
    expect(p.useView(back, '', IDS).layout.group).toBe('issues')
    expect(p.useView(back, '', IDS).layout.groupBy).toBeUndefined()
  })

  it('a stored column grouping with no column is the issue tree, and a column the page lacks stays as stored', async () => {
    settings = { workViews: { work: { show: 'open', cols: ['work'], group: 'column' } } }
    expect((await page()).loadStore(IDS).layout.group).toBe('issues')
    settings = { workViews: { work: { show: 'open', cols: ['work'], group: 'column', groupBy: 'field:gone' } } }
    expect((await page()).loadStore(IDS).layout).toMatchObject({ group: 'column', groupBy: 'field:gone' })
  })

  it('a view is clean as saved; another column, or leaving the column grouping, marks it edited', () => {
    const st = saveAs({ ...emptyStore(IDS), layout: by('status') }, 'V', 'open', IDS, 'v1')
    expect(isDirty(st, IDS)).toBe(false)
    expect(isDirty({ ...st, layout: by('health') }, IDS)).toBe(true)
    expect(isDirty({ ...st, layout: setGroup(st.layout, 'issues') }, IDS)).toBe(true)
    expect(isDirty({ ...emptyStore(IDS), layout: by('status') }, IDS)).toBe(true)
  })

  it('the dirty check ignores the key order of a stored filter beside the grouping', () => {
    const st = saveAs({ ...emptyStore(IDS), layout: setFilter(by('status'), 'health', { kind: 'values', values: ['a', 'b'] }) }, 'V', 'open', IDS, 'v1')
    expect(isDirty({ ...st, layout: setFilter(st.layout, 'health', { kind: 'values', values: ['b', 'a'] }) }, IDS)).toBe(false)
  })
})

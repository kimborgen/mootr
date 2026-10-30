// The sidebar reads only the field definitions; the costs, activity and PR states are read only while
// the view that draws them is on screen (S-4670). A burst of ITSA changes costs one fields read.
// @vitest-environment jsdom
import { StrictMode, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Field } from '../itsa/fields'

const apiMock = vi.hoisted(() => vi.fn())
const fieldsMock = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api: apiMock }))
vi.mock('../itsa/fields', () => ({ fetchFields: fieldsMock }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const extrasReads = () => apiMock.mock.calls.filter(([, p]) => /^\/api\/(usage|activity|watch)/.test(String(p))).length
const costReads = () => apiMock.mock.calls.filter(([, p]) => String(p).startsWith('/api/usage')).length
const fieldReads = () => fieldsMock.mock.calls.length

let roots: { unmount: () => void }[] = []

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-29T08:00:00Z'))
  apiMock.mockReset()
  fieldsMock.mockReset()
  apiMock.mockImplementation((_m: string, path: string) => Promise.resolve(path.startsWith('/api/activity') ? { rows: [] } : {}))
  fieldsMock.mockResolvedValue([])
  roots = []
})
afterEach(() => {
  for (const r of roots) r.unmount()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup() {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ViewKeyContext, viewElement, shownChanged } = await import('../shell/layout')
  const data = await import('./data')
  const store = await import('../store')
  // Mounted the way the sidebar (fields only) and a view (extras, keyed by its view or its context) mount them.
  const seen: (Field[] | null)[] = []
  const WorkFieldsProbe = () => { seen.push(data.useWorkFields().fields); return null }
  const WorkExtrasProbe = ({ viewKey }: { viewKey?: string }) => { data.useWorkExtras(viewKey); return null }
  const mount = async (node: ReactElement) => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => { root.render(node) })
    return root
  }
  const run = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  // A main world holding one view element, shown or hidden as the view is in its pane.
  const view = (key: string, shown: boolean) => {
    let main = document.getElementById('w-main')
    if (!main) { main = document.createElement('section'); main.id = 'w-main'; document.body.append(main) }
    const el = viewElement(key)
    el.hidden = !shown
    main.append(el)
    return el
  }
  return { act, data, store, seen, ViewKeyContext, shownChanged, WorkFieldsProbe, WorkExtrasProbe, mount, run, view }
}

describe('the sidebar tree', () => {
  it('makes no costs, activity or watch reads', async () => {
    const { WorkFieldsProbe, mount, run } = await setup()
    await mount(<WorkFieldsProbe />)
    await run(3 * 60_000)
    expect(extrasReads()).toBe(0)
    expect(fieldReads()).toBeGreaterThan(0)
  })

  it('reads the fields once per burst of ITSA changes', async () => {
    const { WorkFieldsProbe, store, mount, run, act } = await setup()
    await mount(<WorkFieldsProbe />)
    await run(1_000)
    const before = fieldReads()
    await act(async () => {
      for (let i = 0; i < 5; i++) store.setData({ itsas: [] })
    })
    await run(1_000)
    expect(fieldReads()).toBe(before + 1)
  })

  it('a forced read goes through a pending debounced one, which it replaces, and the fields are fresh', async () => {
    const { WorkFieldsProbe, store, data, seen, mount, run, act } = await setup()
    await mount(<WorkFieldsProbe />)
    await run(1_000)
    const before = fieldReads()
    await act(async () => { store.setData({ itsas: [] }) })
    fieldsMock.mockResolvedValue([{ id: 'new' }])
    await act(async () => { await data.refreshFields(true) })
    expect(fieldReads()).toBe(before + 1)
    await run(1_000)
    expect(fieldReads()).toBe(before + 1)
    expect(seen.at(-1)).toEqual([{ id: 'new' }])
  })

  it('a forced read during an in-flight read runs again after it', async () => {
    const { data, WorkFieldsProbe, mount, run, act } = await setup()
    await mount(<WorkFieldsProbe />)
    await run(1_000)
    let resolveFirst: (v: unknown) => void = () => {}
    fieldsMock.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r }))
    const before = fieldReads()
    await act(async () => { void data.refreshFields(true) })
    expect(fieldReads()).toBe(before + 1)
    await act(async () => { void data.refreshFields(true) })
    expect(fieldReads()).toBe(before + 1)
    await act(async () => { resolveFirst([]); await vi.advanceTimersByTimeAsync(0) })
    expect(fieldReads()).toBe(before + 2)
  })
})

describe('the Work, System and Board views', () => {
  it('poll the extras while on screen', async () => {
    const { WorkExtrasProbe, view, mount, run } = await setup()
    view('work:shown', true)
    await mount(<WorkExtrasProbe viewKey="work:shown" />)
    expect(costReads()).toBe(1)
    await run(2 * 60_000)
    expect(costReads()).toBe(3)
  })

  it("don't poll the extras while hidden, and catch up when shown", async () => {
    const { WorkExtrasProbe, view, shownChanged, mount, run, act } = await setup()
    const el = view('work:hidden', false)
    await mount(<WorkExtrasProbe viewKey="work:hidden" />)
    await run(3 * 60_000)
    expect(extrasReads()).toBe(0)
    await act(async () => { el.hidden = false; shownChanged() })
    expect(costReads()).toBe(1)
    await run(60_000)
    expect(costReads()).toBe(2)
  })

  it("don't poll while the tab is hidden, and catch up when it shows", async () => {
    const { WorkExtrasProbe, view, mount, run, act } = await setup()
    view('work:tab', true)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await mount(<WorkExtrasProbe viewKey="work:tab" />)
    await run(3 * 60_000)
    expect(extrasReads()).toBe(0)
    hidden.mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(costReads()).toBe(1)
  })
})

describe('a settings preview (no view key, in its view)', () => {
  it('reads nothing while its view is parked, and once at once when shown', async () => {
    const { WorkExtrasProbe, ViewKeyContext, view, shownChanged, mount, run, act } = await setup()
    const el = view('config', false)
    await mount(<ViewKeyContext.Provider value="config"><WorkExtrasProbe /></ViewKeyContext.Provider>)
    await run(5 * 60_000)
    expect(extrasReads()).toBe(0)
    await act(async () => { el.hidden = false; shownChanged() })
    expect(costReads()).toBe(1)
  })
})

describe('the poll lifecycle', () => {
  it('stops once the last reader unmounts', async () => {
    const { WorkExtrasProbe, view, mount, run } = await setup()
    view('work:a', true)
    view('board:b', true)
    const a = await mount(<WorkExtrasProbe viewKey="work:a" />)
    const b = await mount(<WorkExtrasProbe viewKey="board:b" />)
    await run(60_000)
    a.unmount()
    await run(60_000)
    b.unmount()
    const at = extrasReads()
    await run(3 * 60_000)
    expect(extrasReads()).toBe(at)
  })

  it('runs one poll and balances its cleanup under StrictMode', async () => {
    const { WorkExtrasProbe, view, mount, run } = await setup()
    view('work:strict', true)
    const root = await mount(<StrictMode><WorkExtrasProbe viewKey="work:strict" /></StrictMode>)
    const at = costReads()
    await run(2 * 60_000)
    expect(costReads() - at).toBe(2)
    root.unmount()
    const after = costReads()
    await run(3 * 60_000)
    expect(costReads()).toBe(after)
  })

  it('refetches the costs when the cost unit changes while shown', async () => {
    const { WorkExtrasProbe, view, store, mount, act } = await setup()
    view('work:unit', true)
    await mount(<WorkExtrasProbe viewKey="work:unit" />)
    const before = costReads()
    await act(async () => { store.setData({ costMode: store.getData().costMode === 'api' ? 'five_hour' : 'api' }) })
    expect(costReads()).toBe(before + 1)
  })
})

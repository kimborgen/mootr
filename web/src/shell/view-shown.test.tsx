// A view on screen reloads on each mailTick; a view hidden in the main world waits, and reloads
// once when it shows again, however many ticks it missed.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from '../store'
import { MailView } from '../views/MailView'
import { shownChanged, useViewShown, viewElement, viewHandle, viewStore } from './layout'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let main: HTMLElement
let roots: Root[]
let loads: string[]

beforeEach(() => {
  roots = []
  loads = []
  main = document.createElement('section')
  main.id = 'w-main'
  document.body.append(main)
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.startsWith('/api/agents/')) loads.push(path)
    const data: unknown[] = []
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) }
  }))
})
afterEach(() => {
  for (const r of roots) act(() => r.unmount())
  main.remove()
  vi.unstubAllGlobals()
})

// A mail view in its element, which sits in the main world's pane when shown and is hidden when not.
function mount(key: string, shown: boolean) {
  const el = viewElement(key)
  main.append(el)
  el.hidden = !shown
  shownChanged()
  const root = createRoot(el)
  roots.push(root)
  act(() => root.render(<MailView owner="a1" viewKey={key} />))
  return el
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const tick = () => act(async () => { store.setData({ mailTick: store.getData().mailTick + 1 }) })
// A show as MainWorld makes it: the pane adopts the view, then calls its registered show handler.
const show = (key: string, el: HTMLElement) => act(async () => {
  el.hidden = false
  shownChanged()
  viewHandle(key)?.show?.()
})

describe('the shown state', () => {
  it('an unchanged notification re-renders no subscriber', async () => {
    let renders = 0
    const Probe = () => { renders++; useViewShown('mail:probe'); return null }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => { root.render(<Probe />) })
    const n = renders
    act(() => { shownChanged(); shownChanged(); shownChanged() })
    await flush()
    expect(renders).toBe(n)
    host.remove()
  })
})

describe('a view on screen', () => {
  it('refetches on every tick', async () => {
    mount('mail:shown', true)
    await flush()
    const n = loads.length
    await tick()
    await tick()
    await flush()
    expect(loads.length).toBe(n + 2)
  })
})

describe('a view hidden in the main world', () => {
  it("doesn't refetch on a tick", async () => {
    mount('mail:hidden', false)
    await flush()
    const n = loads.length
    await tick()
    await tick()
    await flush()
    expect(loads.length).toBe(n)
  })

  it('refetches once when it is shown again, for the ticks it missed', async () => {
    const el = mount('mail:shown-again', false)
    await flush()
    const n = loads.length
    await tick()
    await tick()
    await tick()
    await flush()
    expect(loads.length).toBe(n)
    await show('mail:shown-again', el)
    await flush()
    expect(loads.length).toBe(n + 1)
    // Shown now: each tick refetches again.
    await tick()
    await flush()
    expect(loads.length).toBe(n + 2)
  })

  it('a show with no missed tick loads nothing', async () => {
    const el = mount('mail:no-miss', false)
    await flush()
    const n = loads.length
    await show('mail:no-miss', el)
    await flush()
    expect(loads.length).toBe(n)
  })

  it('a view parked in the store (not in the main world) is not shown and loads nothing on a tick', async () => {
    const el = mount('mail:parked', true)
    await flush()
    const n = loads.length
    // Parked: the pane gave the view back to the store, which sits outside #w-main.
    act(() => { viewStore().append(el); shownChanged() })
    await tick()
    await flush()
    expect(loads.length).toBe(n)
  })
})

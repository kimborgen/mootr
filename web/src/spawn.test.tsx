// @vitest-environment jsdom
// S-286: on a phone the add-agent panel is a sheet over a scrim that is only a shadow, so
// the tap that closes it lands on what lies under the scrim. It must only close the panel.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeSpawnPanel, SpawnPanel, spawn, spawnMenu } from './spawn'
import { getData } from './store'
import { hideMenu, MenuLayer } from './ui/menu'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // The registry fetch fails; the menu still opens with the built-in harnesses.
  // jsdom has no visualViewport; the panel follows it for the phone keyboard.
  vi.stubGlobal('visualViewport', null)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
})
afterEach(() => { closeSpawnPanel(); hideMenu(); act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals() })

const tapOn = (el: Element, pointerType: string) => {
  const down = new Event('pointerdown', { bubbles: true, cancelable: true })
  Object.defineProperty(down, 'pointerType', { value: pointerType })
  el.dispatchEvent(down)
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}
// The panel open, with a button outside it that counts its presses.
const openPanel = async () => {
  const under = document.createElement('button')
  let pressed = 0
  under.addEventListener('click', () => pressed++)
  document.body.append(under)
  act(() => { root.render(<><MenuLayer /><SpawnPanel /></>) })
  await act(() => spawnMenu(0, 0))
  const more = [...document.querySelectorAll<HTMLButtonElement>('.menu button')].find((b) => b.textContent?.includes('More options'))!
  act(() => { more.click() })
  expect(document.querySelector('.spawn-panel')).not.toBeNull()
  return { under, pressed: () => pressed }
}

describe('closing the add-agent panel by a tap outside', () => {
  it('a touch closes it and presses nothing; the next tap presses', async () => {
    const { under, pressed } = await openPanel()
    act(() => { tapOn(under, 'touch') })
    expect(document.querySelector('.spawn-panel')).toBeNull()
    expect(pressed()).toBe(0)
    act(() => { tapOn(under, 'touch') })
    expect(pressed()).toBe(1)
  })

  it('a mouse click outside still reaches what it clicked', async () => {
    const { under, pressed } = await openPanel()
    act(() => { tapOn(under, 'mouse') })
    expect(document.querySelector('.spawn-panel')).toBeNull()
    expect(pressed()).toBe(1)
  })
})

describe('spawning a ring reviewer type', () => {
  it('answers with a ring: no agent row is added for it, and the toast names its members', async () => {
    const ring = { kind: 'ring', ring: { id: 'r1', name: 'rr' }, members: [{ id: 'a1', name: 'rr-1' }, { id: 'a2', name: 'rr-2' }], moderator: null, cwd: '/x' }
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: { method?: string }) => ({ ok: init?.method === 'POST', status: init?.method === 'POST' ? 200 : 500, json: async () => (init?.method === 'POST' ? ring : {}) })))
    act(() => { root.render(<MenuLayer />) })
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    const before = getData().agents
    await act(() => spawn({ type: 'review-ring', prompt: 'x' }))
    expect(getData().agents).toBe(before)
    expect(document.body.textContent).toContain('Started ring rr with 2 members')
  })
})

describe('standing and workspace choices', () => {
  const tick = (label: string) => act(() => { [...document.querySelectorAll<HTMLInputElement>('.spawn-panel .sp-check input')].find((i) => i.parentElement?.textContent?.startsWith(label))!.click() })
  const send = async () => {
    const fetchMock = vi.fn(async (_u: string, init?: { method?: string }) => ({ ok: init?.method === 'POST', status: init?.method === 'POST' ? 200 : 500, json: async () => (init?.method === 'POST' ? { id: 'a1', name: 'x', cwd: '/x', model: null } : {}) }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    await act(async () => { document.querySelector<HTMLButtonElement>('.spawn-panel button[type=submit]')!.click() })
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST')!
    return JSON.parse((post[1] as unknown as { body: string }).body) as Record<string, unknown>
  }
  it('sends neither field when neither is ticked', async () => {
    await openPanel()
    const b = await send()
    expect('standing' in b || 'workspace' in b).toBe(false)
  })
  it('ticking standing ticks workspace too, and both are sent', async () => {
    await openPanel()
    tick('Standing')
    const b = await send()
    expect(b.standing).toBe(true)
    expect(b.workspace).toBe(true)
  })
  it('workspace alone is sent without standing', async () => {
    await openPanel()
    tick('Workspace')
    expect(await send()).toMatchObject({ workspace: true })
  })
})

describe('permission mode choice', () => {
  const send = async () => {
    const fetchMock = vi.fn(async (_u: string, init?: { method?: string }) => ({ ok: init?.method === 'POST', status: init?.method === 'POST' ? 200 : 500, json: async () => (init?.method === 'POST' ? { id: 'a1', name: 'x', cwd: '/x', model: null } : {}) }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    await act(async () => { document.querySelector<HTMLButtonElement>('.spawn-panel button[type=submit]')!.click() })
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST')!
    return JSON.parse((post[1] as unknown as { body: string }).body) as Record<string, unknown>
  }
  it('leaves permission_mode out unless the human picks one (S-2071)', async () => {
    await openPanel()
    expect(document.querySelector('.spawn-panel [data-pick="Permissions"] .sp-value')?.textContent).toContain('Settings')
    expect('permission_mode' in (await send())).toBe(false)
  })
  it('sends the mode the human picks, and warns about bypass', async () => {
    await openPanel()
    await act(async () => { document.querySelector<HTMLElement>('.spawn-panel [data-pick="Permissions"]')!.click() })
    const item = [...document.querySelectorAll<HTMLElement>('.menu [role^=menuitem]')].find((i) => i.textContent?.startsWith('Bypass'))!
    await act(async () => { item.click() })
    expect(document.querySelector('.spawn-panel .sp-warn')?.textContent).toContain('without asking')
    expect(await send()).toMatchObject({ permission_mode: 'bypass' })
  })
})

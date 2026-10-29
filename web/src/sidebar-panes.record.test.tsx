// @vitest-environment jsdom
// A saved layout that lacks `cost` at the current version keeps it out through the settings record:
// the cleaned value keeps its version, so the loader doesn't read it as an old layout (S-1423).
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => vi.fn())
const sendAsHuman = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ api, sendAsHuman }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KNOWN = ['agents', 'issues', 'mail', 'machines', 'cost']
const LAYOUT = [{ tabs: ['agents', 'issues'], active: 'agents' }, { tabs: ['mail'], active: 'mail' }, { tabs: ['machines'], active: 'machines' }]

async function shown(stored: Record<string, unknown>) {
  vi.resetModules()
  localStorage.clear()
  api.mockReset()
  api.mockImplementation((method: string, path: string) => (method === 'GET' && path === '/api/config/settings'
    ? Promise.resolve({ text: JSON.stringify({ sidebarPanes: { main: stored } }) }) : Promise.resolve({ text: '{}' })))
  const { useSidebarPanes } = await import('./sidebar-panes')
  let tabs: string[] = []
  function Probe() { tabs = useSidebarPanes(KNOWN).panes.flatMap((p) => p.tabs); return null }
  const host = document.createElement('div')
  await act(async () => { createRoot(host).render(<Probe />) })
  await act(async () => { await Promise.resolve() })
  return tabs
}

describe('the saved sidebar layout', () => {
  beforeEach(() => { vi.useRealTimers() })
  it('keeps cost out when a v2 layout lacks it', async () => {
    expect(await shown({ panes: LAYOUT, tabBar: 'compact', v: 2 })).not.toContain('cost')
  })
  it('adds cost once to a layout saved before v2', async () => {
    expect(await shown({ panes: LAYOUT, tabBar: 'compact' })).toContain('cost')
  })
})

// The user default is a second record (id `default`) read back from settings, so it survives a reload
// and a daemon restart; a revert writes only `main` of `sidebarPanes` (S-3810).
describe('the saved sidebar default', () => {
  async function load(stored: Record<string, unknown>) {
    vi.resetModules()
    localStorage.clear()
    api.mockReset()
    sendAsHuman.mockReset()
    api.mockImplementation((method: string, path: string) => (method === 'GET' && path === '/api/config/settings'
      ? Promise.resolve({ text: JSON.stringify({ sidebarPanes: stored }) }) : Promise.resolve({ text: '{}' })))
    const m = await import('./sidebar-panes')
    let has = false
    function Probe() { has = m.useHasUserDefault(); m.useSidebarPanes(KNOWN); return null }
    await act(async () => { createRoot(document.createElement('div')).render(<Probe />) })
    await act(async () => { await Promise.resolve() })
    return { m, has: () => has }
  }
  it('is read back after a reload and reverts the whole live record', async () => {
    const { m, has } = await load({ main: { panes: LAYOUT, tabBar: 'compact', v: 3 }, default: { panes: [{ tabs: ['mail'], active: 'mail' }], tabBar: 'regular', v: 3 } })
    expect(has()).toBe(true)
    expect(m.revertToUserDefault()).toBe(true)
    expect(m.currentPanes()).toEqual([{ tabs: ['mail'], active: 'mail' }])
    expect(m.userDefault()?.tabBar).toBe('regular')
  })
  it('without a saved default has none to revert to, and mootr\'s default still works', async () => {
    const { m, has } = await load({ main: { panes: LAYOUT, tabBar: 'regular', v: 3 } })
    expect(has()).toBe(false)
    expect(m.revertToUserDefault()).toBe(false)
    expect(m.currentPanes()).toEqual(LAYOUT)
    m.revertToMootrDefault()
    expect(m.currentPanes().length).toBe(3)
  })
})

describe('saving the default', () => {
  it('sends it in the settings PATCH, and a reload from that record reverts to it', async () => {
    vi.resetModules()
    localStorage.clear()
    api.mockReset()
    vi.useFakeTimers()
    api.mockImplementation((method: string, path: string) => (method === 'GET' && path === '/api/config/settings'
      ? Promise.resolve({ text: JSON.stringify({ sidebarPanes: { main: { panes: LAYOUT, tabBar: 'compact', v: 3 } } }) }) : Promise.resolve({ text: '{}' })))
    const m = await import('./sidebar-panes')
    function Probe() { m.useSidebarPanes(KNOWN); return null }
    await act(async () => { createRoot(document.createElement('div')).render(<Probe />) })
    await act(async () => { await Promise.resolve() })
    m.setSidebarPanes([{ tabs: ['mail'], active: 'mail' }])
    m.setTabBar('regular')
    m.saveUserDefault()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    vi.useRealTimers()
    const patches = api.mock.calls.filter((c) => c[0] === 'PATCH').map((c) => c[2].patch.sidebarPanes)
    const sent = patches.find((p) => p.default)?.default
    expect(sent).toEqual({ panes: [{ tabs: ['mail'], active: 'mail' }], tabBar: 'regular', v: 3 })
    // A reload: a fresh page whose settings hold only what was sent.
    vi.resetModules()
    api.mockReset()
    api.mockImplementation((method: string, path: string) => (method === 'GET' && path === '/api/config/settings'
      ? Promise.resolve({ text: JSON.stringify({ sidebarPanes: { main: { panes: LAYOUT, tabBar: 'compact', v: 3 }, default: sent } }) }) : Promise.resolve({ text: '{}' })))
    const r = await import('./sidebar-panes')
    function Probe2() { r.useHasUserDefault(); r.useSidebarPanes(KNOWN); return null }
    await act(async () => { createRoot(document.createElement('div')).render(<Probe2 />) })
    await act(async () => { await Promise.resolve() })
    expect(r.revertToUserDefault()).toBe(true)
    expect(r.currentPanes()).toEqual([{ tabs: ['mail'], active: 'mail' }])
  })
})

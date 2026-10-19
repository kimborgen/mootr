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

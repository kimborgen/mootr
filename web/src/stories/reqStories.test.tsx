// @vitest-environment jsdom
// S-653: the requirement stories start each state from a clean requirement store, and the import
// stories really pick a file: each outcome's note and API call are asserted, not just drawn.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { getReq } from '../req/store'
import { stories as importStories } from '../req/ReqImport.stories'
import { applyState, installFixtures } from './fixtures'
import { loadReqs, REQ_ON, REQS } from './reqFixtures'
import { reply } from './types'

beforeAll(() => {
  installFixtures()
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia
  vi.stubGlobal('visualViewport', { addEventListener() {}, removeEventListener() {} })
})

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })

describe('the requirement store between states', () => {
  it('is reset by applyState, so an error state reads nothing from an earlier one', async () => {
    applyState({ routes: REQ_ON, setup: loadReqs })
    await settle()
    expect(getReq()).toMatchObject({ enabled: true, loaded: true, error: null })
    expect(getReq().reqs).toHaveLength(REQS.length)

    applyState()
    expect(getReq()).toMatchObject({ enabled: false, loaded: false, error: null, reqs: [] })

    applyState({ routes: { 'GET /api/req-enabled': reply(503, { error: 'fixture: down' }) }, setup: loadReqs })
    await settle()
    expect(getReq()).toMatchObject({ enabled: false, loaded: true, error: 'fixture: down', reqs: [] })
  })

  it('drops a read that was still in flight when the state changed', async () => {
    applyState({ routes: REQ_ON, setup: loadReqs })
    applyState()
    await settle()
    expect(getReq()).toMatchObject({ enabled: false, loaded: false, reqs: [] })
  })
})

describe('the import stories', () => {
  const run = async (name: string) => {
    const st = importStories[0].states.find((s) => s.name === name)!
    applyState(st)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const before = window.stamStories!.apiCalls.length
    await act(async () => { root.render(st.render()) })
    await settle()
    const note = host.querySelector<HTMLElement>('[data-req-import-note]')
    const calls = window.stamStories!.apiCalls.slice(before)
    act(() => root.unmount())
    host.remove()
    return { note, calls }
  }

  it('Imported: posts the file and says how many were made and which approval was asked', async () => {
    const { note, calls } = await run('Imported')
    expect(calls).toContain('POST /api/requirements/batch')
    expect(note?.textContent).toBe('Imported 2 requirements (R-8, R-9). Approval asked in S-950.')
    expect(note?.getAttribute('role')).toBe('status')
  })

  it('Not JSON: refuses before anything is sent', async () => {
    const { note, calls } = await run('Not JSON')
    expect(calls).not.toContain('POST /api/requirements/batch')
    expect(note?.textContent).toBe('The file is not JSON.')
    expect(note?.getAttribute('role')).toBe('alert')
  })

  it('Refused by the daemon: shows the daemon\'s reason as an alert', async () => {
    const { note, calls } = await run('Refused by the daemon')
    expect(calls).toContain('POST /api/requirements/batch')
    expect(note?.textContent).toBe('fixture: R-8 names a parent that does not exist')
    expect(note?.getAttribute('role')).toBe('alert')
  })
})

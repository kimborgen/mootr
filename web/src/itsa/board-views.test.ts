import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prefs } from './board-views'

// The daemon's settings file: GET returns it as text; PATCH merges a partial object the way
// settings.ts's patchSettings does (a view record per id, null deletes, fill adds only missing ids).
const api = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api, sendAsHuman: vi.fn() }))

let settings: Record<string, unknown> = {}
let fail = false
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  localStorage.clear()
  settings = { chiefOfStaff: 'cos' }
  fail = false
  api.mockReset()
  api.mockImplementation((method: string, path: string, body?: { patch: Record<string, Record<string, unknown>>; fill?: boolean }) => {
    if (method === 'GET' && path === '/api/config/settings') return Promise.resolve({ text: JSON.stringify(settings) })
    if (method === 'PATCH' && path === '/api/config/settings') {
      if (fail) return Promise.reject(new Error('HTTP 500'))
      for (const [k, v] of Object.entries(body!.patch)) {
        if (k === 'boardViews') {
          const cur = (settings[k] ?? {}) as Record<string, unknown>
          const next = { ...cur }
          for (const [id, x] of Object.entries(v)) {
            if (body!.fill && id in cur) continue
            if (x === null) delete next[id]; else next[id] = x
          }
          settings[k] = next
        } else settings[k] = v
      }
      return Promise.resolve({ text: JSON.stringify(settings) })
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`))
  })
})

// A fresh page, as a new load would have.
async function page() {
  vi.resetModules()
  return await import('./board-views')
}
const patches = () => api.mock.calls.filter((c) => c[0] === 'PATCH')
const LEGACY = { mode: 'status', scope: 'subtree', closedFolded: true, closedAll: false }
const DEF: Prefs = { mode: 'category', scope: 'children', closedFolded: false, closedAll: false }
const pref = (p: Partial<Prefs>): Prefs => ({ ...DEF, ...p })

describe('board views in settings', () => {
  it('reads views from settings, folds from this device, and leaves other settings alone', async () => {
    settings = { boardViews: { 'board:all': { mode: 'status', scope: 'subtree' } }, chiefOfStaff: 'cos' }
    localStorage.setItem('stam/board-folded', JSON.stringify({ 'board:all': true }))
    const b = await page()
    expect(await b.loadPrefs('board:all')).toEqual(pref({ mode: 'status', scope: 'subtree', closedFolded: true }))
    expect(b.prefsFor('board:none')).toEqual(DEF)
    expect(patches()).toHaveLength(0) // nothing to move in, so nothing is sent
  })

  it('gives a missing or invalid view the defaults, field by field', async () => {
    settings = { boardViews: { a: { mode: 'nope', scope: 'subtree', closedFolded: 'yes' }, b: 7, c: [] } }
    const b = await page()
    await b.loadPrefs('x')
    expect(b.prefsFor('a')).toEqual(pref({ scope: 'subtree' }))
    expect(b.prefsFor('b')).toEqual(DEF)
    expect(b.prefsFor('c').mode).toBe('category')
  })

  it('moves this browser’s copy in once, filling only the boards the server lacks, and keeps folds here', async () => {
    settings = { boardViews: { 'board:all': { mode: 'category', scope: 'children', closedAll: true } } }
    localStorage.setItem('stam/board', JSON.stringify({ 'board:all': LEGACY, 'board:two': { mode: 'status' } }))
    const b = await page()
    expect((await b.loadPrefs('board:all'))).toEqual(pref({ closedAll: true, closedFolded: true }))
    expect((await b.loadPrefs('board:two')).mode).toBe('status')
    await vi.runAllTimersAsync()
    expect(settings.boardViews).toEqual({ 'board:all': { mode: 'category', scope: 'children', closedAll: true }, 'board:two': { mode: 'status', scope: 'children', closedAll: false } })
    expect(localStorage.getItem('stam/board')).toBeNull()
    expect(JSON.parse(localStorage.getItem('stam/board-folded')!)).toEqual({ 'board:all': true })
    // Another load on this browser doesn't read the copy again: a stray copy is ignored.
    localStorage.setItem('stam/board', JSON.stringify({ 'board:two': { mode: 'subtree' } }))
    const again = await page()
    await again.loadPrefs('board:two')
    expect(again.prefsFor('board:two').mode).toBe('status')
    expect(patches()).toHaveLength(1)
  })

  it('keeps the browser copy when the move fails, so the next load retries', async () => {
    localStorage.setItem('stam/board', JSON.stringify({ 'board:all': LEGACY }))
    fail = true
    const b = await page()
    await expect(b.loadPrefs('board:all')).rejects.toThrow()
    fail = false
    const retry = await page()
    await retry.loadPrefs('board:all')
    expect(settings.boardViews).toEqual({ 'board:all': { mode: 'status', scope: 'subtree', closedAll: false } })
    expect(localStorage.getItem('stam/board')).toBeNull()
  })

  it('sends one patch for a burst of changes to one board', async () => {
    const b = await page()
    await b.loadPrefs('board:all')
    b.saveView('board:all', pref({ mode: 'status' }))
    b.saveView('board:all', pref({ mode: 'status', scope: 'subtree' }))
    b.saveView('board:all', pref({ mode: 'status', scope: 'subtree', closedAll: true }))
    expect(patches()).toHaveLength(0)
    await vi.runAllTimersAsync()
    expect(patches()).toHaveLength(1)
    expect(settings.boardViews).toEqual({ 'board:all': { mode: 'status', scope: 'subtree', closedAll: true } })
  })

  it('sends only the board that changed, so another device’s board survives', async () => {
    settings = { boardViews: { 'board:phone': { mode: 'status', scope: 'subtree', closedAll: false } } }
    const b = await page()
    await b.loadPrefs('board:all')
    b.saveView('board:all', pref({ mode: 'status' }))
    await vi.runAllTimersAsync()
    expect(patches().at(-1)![1]).toBe('/api/config/settings')
    expect((patches().at(-1)![2] as { patch: { boardViews: object } }).patch.boardViews).toEqual({ 'board:all': { mode: 'status', scope: 'children', closedAll: false } })
    expect(settings.boardViews).toEqual({ 'board:phone': { mode: 'status', scope: 'subtree', closedAll: false }, 'board:all': { mode: 'status', scope: 'children', closedAll: false } })
  })

  it('sends nothing when only the fold changes', async () => {
    const b = await page()
    await b.loadPrefs('board:all')
    b.saveView('board:all', pref({ closedFolded: true }))
    await vi.runAllTimersAsync()
    expect(patches()).toHaveLength(0)
    expect(b.prefsFor('board:all').closedFolded).toBe(true)
  })

  it('keeps a change whose write failed, and sends it with the next one', async () => {
    const b = await page()
    await b.loadPrefs('board:all')
    fail = true
    b.saveView('board:a', pref({ mode: 'status' }))
    await vi.runAllTimersAsync()
    expect(settings.boardViews).toBeUndefined()
    fail = false
    b.saveView('board:b', pref({ scope: 'subtree' }))
    await vi.runAllTimersAsync()
    expect(settings.boardViews).toEqual({ 'board:a': { mode: 'status', scope: 'children', closedAll: false }, 'board:b': { mode: 'category', scope: 'subtree', closedAll: false } })
  })

  it('keeps a change made before the views loaded', async () => {
    const b = await page()
    b.saveView('board:all', pref({ mode: 'status' }))
    expect((await b.loadPrefs('board:all')).mode).toBe('status')
    await vi.runAllTimersAsync()
    expect(settings.boardViews).toEqual({ 'board:all': { mode: 'status', scope: 'children', closedAll: false } })
  })
})

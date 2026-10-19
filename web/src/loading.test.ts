// A list shows its loading mark until its first load succeeds, then its empty state, even when
// the list stays empty. The fetches are stubbed; the store reads them through api().
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()
vi.mock('./api', () => ({ api: (...a: unknown[]) => api(...a), hash: new URLSearchParams() }))

describe('loaded-once flags', () => {
  beforeEach(() => { vi.resetModules(); api.mockReset() })

  it('marks ITSAs loaded after an empty first load, and not before', async () => {
    const store = await import('./store')
    expect(store.getData().loaded.itsas).toBe(false)
    api.mockImplementation(async (_m: string, path: string) => (path === '/api/itsas/statuses' ? { statuses: [] } : []))
    await store.refreshItsas()
    expect(store.getData().loaded.itsas).toBe(true)
    expect(store.getData().itsas).toEqual([])
  })

  it('keeps the loading mark when the first load fails', async () => {
    const store = await import('./store')
    api.mockRejectedValue(new Error('down'))
    await store.refreshItsas()
    expect(store.getData().loaded.itsas).toBe(false)
    expect(store.getData().itsaError).toBe('down')
  })

  it('marks agents loaded on the first successful refresh', async () => {
    const store = await import('./store')
    api.mockImplementation(async (_m: string, path: string) => (path === '/api/agents' ? [] : []))
    await store.refresh()
    expect(store.getData().loaded.agents).toBe(true)
    expect(store.getData().loaded.mail).toBe(false)
  })
})

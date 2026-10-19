// The Work page reads the activity report at most every ten minutes (S-2094): it blocks the daemon for
// seconds at today's scale, while the costs and PR states keep their one-minute refresh.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api: apiMock }))

const activityCalls = () => apiMock.mock.calls.filter(([, p]) => String(p).startsWith('/api/activity')).length
const costCalls = () => apiMock.mock.calls.filter(([, p]) => String(p).startsWith('/api/usage/issues')).length

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T08:00:00Z'))
  apiMock.mockReset()
  apiMock.mockImplementation((_m: string, path: string) => Promise.resolve(path.startsWith('/api/activity') ? { rows: [] } : {}))
})
afterEach(() => { vi.useRealTimers() })

describe('refreshWorkExtras', () => {
  it('reads the activity report every ten minutes, the costs every minute', async () => {
    const { refreshWorkExtras, getWorkExtras } = await import('./data')
    await refreshWorkExtras()
    expect([activityCalls(), costCalls()]).toEqual([1, 1])
    for (let m = 1; m < 10; m++) {
      vi.setSystemTime(new Date(Date.parse('2026-10-19T08:00:00Z') + m * 60_000))
      await refreshWorkExtras()
    }
    expect([activityCalls(), costCalls()]).toEqual([1, 10])
    expect(getWorkExtras().activity).toEqual({ rows: [] })
    vi.setSystemTime(new Date('2026-10-19T08:10:00Z'))
    await refreshWorkExtras()
    expect(activityCalls()).toBe(2)
  })

  it('reads it on a forced refresh', async () => {
    const { refreshWorkExtras } = await import('./data')
    await refreshWorkExtras()
    await refreshWorkExtras(true)
    expect(activityCalls()).toBe(2)
  })

  it('reads nothing while the tab is hidden, and a forced refresh still reads', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const { refreshWorkExtras } = await import('./data')
    await refreshWorkExtras()
    expect(apiMock).not.toHaveBeenCalled()
    await refreshWorkExtras(true)
    expect(activityCalls()).toBe(1)
    hidden.mockRestore()
  })
})

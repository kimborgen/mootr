import { beforeEach, describe, expect, it, vi } from 'vitest'

// The settings file as the daemon has it. GET reads it; PATCH merges a partial object.
const api = vi.hoisted(() => vi.fn())
const sendAsHuman = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ api, sendAsHuman }))

let settings: Record<string, unknown> = {}
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  localStorage.clear()
  settings = {}
  api.mockReset()
  sendAsHuman.mockReset()
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
      return Promise.resolve({ text: JSON.stringify(settings) })
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`))
  })
})

async function record() {
  const { settingsRecord } = await import('./settings-views')
  const r = settingsRecord<{ n: number }>({ field: 'things', legacy: 'stam/things', clean: (x) => ({ n: typeof (x as { n?: unknown })?.n === 'number' ? (x as { n: number }).n : 0 }) })
  await r.load()
  return r
}
const patches = () => api.mock.calls.filter((c) => c[0] === 'PATCH')

describe('settings records', () => {
  it('sends only the view that changed, so views another page saved survive', async () => {
    settings = { chiefOfStaff: 'cos', things: { other: { n: 1 } } }
    const r = await record()
    r.save('a', { n: 2 })
    await vi.runAllTimersAsync()
    expect(patches().at(-1)![2]).toEqual({ patch: { things: { a: { n: 2 } } } })
    expect(settings).toEqual({ chiefOfStaff: 'cos', things: { other: { n: 1 }, a: { n: 2 } } })
  })

  it('two pages each save their own view, and both survive', async () => {
    const one = await record()
    const two = await record()
    one.save('a', { n: 1 })
    two.save('b', { n: 2 })
    await vi.runAllTimersAsync()
    expect(settings.things).toEqual({ a: { n: 1 }, b: { n: 2 } })
  })

  it('sends nothing for a view that is what the file already holds', async () => {
    settings = { things: { a: { n: 2 } } }
    const r = await record()
    r.save('a', { n: 2 })
    await vi.runAllTimersAsync()
    expect(patches()).toHaveLength(0)
  })

  it('a view saved twice before the write goes out is sent with its latest value, once', async () => {
    const r = await record()
    r.save('a', { n: 1 })
    r.save('a', { n: 1 })
    r.save('a', { n: 2 })
    await vi.runAllTimersAsync()
    expect(patches()).toHaveLength(1)
    expect(settings.things).toEqual({ a: { n: 2 } })
  })

  it('changing a view back to what the daemon holds, before the write, sends nothing', async () => {
    settings = { things: { a: { n: 2 } } }
    const r = await record()
    r.save('a', { n: 3 })
    r.save('a', { n: 2 })
    await vi.runAllTimersAsync()
    expect(patches()).toHaveLength(0)
  })

  it('a change back made while a write is in flight is sent after it', async () => {
    settings = { things: { a: { n: 0 } } }
    const r = await record()
    let release!: () => void
    const hold = new Promise<void>((res) => { release = res })
    const real = api.getMockImplementation()!
    api.mockImplementationOnce(async (m: string, p: string, b: unknown) => { await hold; return real(m, p, b) })
    r.save('a', { n: 1 })
    await vi.advanceTimersByTimeAsync(500)
    r.save('a', { n: 0 })
    release()
    await vi.runAllTimersAsync()
    expect(settings.things).toEqual({ a: { n: 0 } })
  })

  it('a view moved in from this browser is not sent again while it is unchanged', async () => {
    localStorage.setItem('stam/things', JSON.stringify({ a: { n: 1 } }))
    const r = await record()
    expect(settings.things).toEqual({ a: { n: 1 } })
    // Another device changes the view; this page's unchanged copy must not write it back.
    settings.things = { a: { n: 2 } }
    r.save('a', { n: 1 })
    await vi.runAllTimersAsync()
    expect(patches()).toHaveLength(1) // only the move's
    expect(settings.things).toEqual({ a: { n: 2 } })
  })

  it('a non-home daemon refusing the move (409) marks it done and keeps this browser\'s views', async () => {
    localStorage.setItem('stam/things', JSON.stringify({ a: { n: 1 } }))
    settings = { things: { b: { n: 2 } } }
    const ok = api.getMockImplementation()!
    api.mockImplementation((method: string, path: string, body?: { fill?: boolean }) =>
      method === 'PATCH' && body?.fill ? Promise.reject(Object.assign(new Error('shared settings live on home'), { status: 409 })) : ok(method, path, body))
    const { settingsRecord } = await import('./settings-views')
    const opts = { field: 'things', legacy: 'stam/things', clean: (x: unknown) => ({ n: (x as { n: number }).n }) }
    expect(await settingsRecord<{ n: number }>(opts).load()).toEqual({ a: { n: 1 }, b: { n: 2 } })
    expect(localStorage.getItem('stam/moved:things')).toBe('1')
    expect(localStorage.getItem('stam/things')).not.toBeNull()
    // The next load doesn't try the move again.
    vi.resetModules()
    await (await import('./settings-views')).settingsRecord<{ n: number }>(opts).load()
    expect(patches()).toHaveLength(1)
  })

  it('deletes a view with a patch that holds null for it', async () => {
    settings = { things: { a: { n: 2 }, b: { n: 3 } } }
    const r = await record()
    r.remove('a')
    await vi.runAllTimersAsync()
    expect(patches().at(-1)![2]).toEqual({ patch: { things: { a: null } } })
    expect(settings.things).toEqual({ b: { n: 3 } })
  })

  it('sends a change that is still waiting when the page is closing, as a patch', async () => {
    settings = { chiefOfStaff: 'cos', things: { other: { n: 1 } } }
    const r = await record()
    r.save('a', { n: 2 })
    // Nothing has waited out the debounce yet; the page is going away.
    window.dispatchEvent(new Event('pagehide'))
    expect(sendAsHuman).toHaveBeenCalledTimes(1)
    expect(sendAsHuman.mock.calls[0]).toEqual(['PATCH', '/api/config/settings', { patch: { things: { a: { n: 2 } } } }])
    // The debounced write finds nothing left to send.
    await vi.runAllTimersAsync()
    expect(patches()).toHaveLength(0)
  })
})

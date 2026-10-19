// Rapid-fire paging by agent (S-1121): the refresh asks the daemon for the open agent's threads
// with `with=ID` in every box, and Load older asks for 60 more, so old threads stay reachable.
import { describe, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => [] as string[])
// `hold` makes the next with= answers wait for `release`.
const slow = vi.hoisted(() => { const s = { hold: false, gate: null as Promise<void> | null, release: () => {} }; return s })
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  api: vi.fn(async (_m: string, path: string) => {
    calls.push(path)
    if (slow.hold && path.includes('with=dev')) {
      slow.gate ??= new Promise<void>((r) => { slow.release = () => { slow.gate = null; r() } })
      await slow.gate
    }
    if (!path.startsWith('/api/agents/human/threads') || !path.includes('with=')) return []
    const limit = Number(/limit=(\d+)/.exec(path)![1])
    // 130 inbox threads with dev; the other boxes hold none.
    const n = path.includes('archived=1') || path.includes('deferred=1') ? 0 : Math.min(limit, 130)
    return Array.from({ length: n }, (_, i) => ({ thread_id: 'd' + i, mails: [{ id: 'm' + i, thread_id: 'd' + i, from_id: 'human', subject: 's', body: 'b', created_at: new Date(Date.UTC(2026, 9, 15, 0, 130 - i)).toISOString(), recipients: [{ id: 'dev', read_at: null }] }] }))
  }),
}))
import { getData } from '../store'
import { rapidOlder, refreshSlow, watchRapid } from '../store'
import { rapidThreads } from './rapid'

const withCalls = () => calls.filter((c) => c.includes('with=dev'))

describe('rapid-fire paging', () => {
  it('fetches the agent\'s threads in every box, then 60 more on Load older, and stops when a box runs out', async () => {
    const stop = watchRapid('dev')
    await vi.waitFor(() => expect(getData().rapidWith.dev?.threads.length).toBe(60))
    expect(withCalls().slice(0, 3)).toEqual([
      '/api/agents/human/threads?limit=60&with=dev',
      '/api/agents/human/threads?limit=60&with=dev&archived=1',
      '/api/agents/human/threads?limit=60&with=dev&deferred=1',
    ])
    expect(getData().rapidWith.dev.more).toBe(true)
    await rapidOlder('dev')
    expect(getData().rapidWith.dev.threads.length).toBe(120)
    await rapidOlder('dev')
    expect(getData().rapidWith.dev).toMatchObject({ more: false })
    expect(getData().rapidWith.dev.threads.length).toBe(130)
    expect(rapidThreads('dev', getData())).toHaveLength(130)
    stop()
  })

  it('keeps the list when a slower, earlier refresh finishes after Load older\'s', async () => {
    const stop = watchRapid('dev')
    await vi.waitFor(() => expect(getData().rapidWith.dev?.threads.length).toBe(60))
    // A poll that began at limit 60 answers late; Load older's refresh answers first.
    slow.hold = true
    const early = refreshSlow()
    slow.hold = false
    await rapidOlder('dev')
    expect(getData().rapidWith.dev.threads.length).toBe(120)
    slow.release()
    await early
    expect(getData().rapidWith.dev.threads.length).toBe(120)
    stop()
  })

  it('stops fetching only when the last pane showing the agent closes', async () => {
    const stopA = watchRapid('dev')
    const stopB = watchRapid('dev')
    stopA()
    calls.length = 0
    await refreshSlow()
    expect(withCalls().length).toBe(3)
    stopB()
    calls.length = 0
    await refreshSlow()
    expect(withCalls()).toEqual([])
  })
})

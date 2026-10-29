// @vitest-environment jsdom
// The bulk actions' requests (S-3117): a bulk action reports a failed agent by name, archives a checked child through its
// parent's cascade without sending it again, counts "already archived" as done, and a single agent's action still toasts
// and refreshes as agentMenu expects.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentAction, bulkAction } from './actions'
import { api } from './api'
import { setData } from './store'
import { refresh } from './store'
import { toast } from './ui/menu'
import { agent } from './stories/fixtures'
import type { Agent } from './types'

vi.mock('./api', () => ({ api: vi.fn(), sendAsHuman: vi.fn(), hash: new URLSearchParams() }))
vi.mock('./store', async (orig) => ({ ...(await orig<typeof import('./store')>()), refresh: vi.fn(async () => {}) }))
vi.mock('./ui/menu', async (orig) => ({ ...(await orig<typeof import('./ui/menu')>()), toast: vi.fn() }))

const A = agent({ id: 'ba-a', name: 'fixture-a', lifecycle: 'active' })
const B = agent({ id: 'ba-b', name: 'fixture-b', lifecycle: 'active' })
const P = agent({ id: 'ba-p', name: 'fixture-parent', lifecycle: 'active' })
const C = agent({ id: 'ba-c', name: 'fixture-child', lifecycle: 'active', parents: ['ba-p'] })

// Replies by path: a request to a path in `fail` is refused with its message; the rest answer with `reply`.
function daemon(reply: Record<string, unknown>, fail: Record<string, string> = {}, agents: Agent[] = []) {
  vi.mocked(api).mockImplementation(async (method: string, path: string) => {
    if (path.split('?')[0] === '/api/agents' && method === 'GET') return agents
    const hit = Object.keys(fail).find((p) => path === p)
    if (hit) throw new Error(fail[hit])
    return reply[path] ?? { result: 'done' }
  })
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(toast).mockReset()
  vi.mocked(refresh).mockClear()
})

describe('bulkAction', () => {
  it('reports a failed agent by name, and the agents that went through', async () => {
    setData({ agents: [A, B], itsas: [] } as never)
    daemon({}, { '/api/agents/ba-b/pause': 'busy' })
    await bulkAction(['ba-a', 'ba-b'], { kind: 'pause' })
    expect(toast).toHaveBeenCalledWith('Paused 1, 1 failed: fixture-b (busy)', true)
    expect(refresh).toHaveBeenCalled()
  })

  it('reads each agent now, so an agent that is gone or no longer eligible is skipped', async () => {
    setData({ agents: [A], itsas: [] } as never)
    daemon({})
    await bulkAction(['ba-a', 'ba-missing'], { kind: 'pause' })
    expect(vi.mocked(api).mock.calls.map((c) => c[1])).toEqual(['/api/agents/ba-a/pause'])
    expect(toast).toHaveBeenCalledWith('Paused 1', false)
  })

  it('sends a checked child no request when its checked parent archive reaches it, and reports it archived', async () => {
    setData({ agents: [P, C], itsas: [] } as never)
    daemon(
      { '/api/agents/ba-p/archive': { result: 'done; also archived idle fixture-child' } },
      {},
      [P, agent({ ...C, lifecycle: 'archived' })],
    )
    await bulkAction(['ba-p', 'ba-c'], { kind: 'archive' })
    expect(vi.mocked(api).mock.calls.map((c) => c[1])).toEqual(['/api/agents/ba-p/archive', '/api/agents?ids=ba-c'])
    expect(toast).toHaveBeenCalledWith('Archived 2. Notes: fixture-parent: also archived idle fixture-child', false)
  })

  it('reports a child the cascade did not archive as failed, with the cascade\'s own note', async () => {
    setData({ agents: [P, C], itsas: [] } as never)
    daemon(
      { '/api/agents/ba-p/archive': { result: "done; couldn't archive fixture-child" } },
      {},
      [P, C],
    )
    await bulkAction(['ba-p', 'ba-c'], { kind: 'archive' })
    expect(toast).toHaveBeenCalledWith("Archived 1, 1 failed: fixture-child (couldn't archive fixture-child). Notes: fixture-parent: couldn't archive fixture-child", true)
  })

  it('reports a child whose parent archive is queued as queued, not archived', async () => {
    setData({ agents: [P, C], itsas: [] } as never)
    daemon({ '/api/agents/ba-p/archive': { result: 'waiting for fixture-parent to finish its step' } }, {}, [P, C])
    await bulkAction(['ba-p', 'ba-c'], { kind: 'archive' })
    expect(toast).toHaveBeenCalledWith('2 queued: fixture-parent, fixture-child', false)
  })

  it('counts an archive the daemon refused as already archived as done', async () => {
    setData({ agents: [A], itsas: [] } as never)
    daemon({}, { '/api/agents/ba-a/archive': 'fixture-a is already archived' })
    await bulkAction(['ba-a'], { kind: 'archive' })
    expect(toast).toHaveBeenCalledWith('Archived 1', false)
  })
})

describe('agentAction', () => {
  it('still toasts the agent\'s result and refreshes when it is not quiet, as agentMenu expects', async () => {
    setData({ agents: [A], itsas: [] } as never)
    daemon({ '/api/agents/ba-a/pause': { result: 'paused it' } })
    const out = await agentAction(A, 'pause')
    expect(toast).toHaveBeenCalledWith('fixture-a: paused it')
    expect(refresh).toHaveBeenCalled()
    expect(out).toEqual({ ok: true, result: 'paused it' })
  })

  it('stays quiet when asked to, and returns the outcome for the caller', async () => {
    setData({ agents: [A], itsas: [] } as never)
    daemon({}, { '/api/agents/ba-a/pause': 'busy' })
    const out = await agentAction(A, 'pause', undefined, true)
    expect(toast).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(out).toEqual({ ok: false, reason: 'busy' })
  })
})

// The daemon's own answers, as lifecycle.ts gives them: a pause returns "paused", a resume "resuming". A pause, resume or
// mode change is done when it is ok, never queued, so its toast counts it as done.
describe('bulk pause, resume and mode answers', () => {
  const PA = agent({ id: 'bp-a', name: 'fixture-pa', lifecycle: 'active' })
  const PB = agent({ id: 'bp-b', name: 'fixture-pb', lifecycle: 'active' })
  const PAUSED1 = agent({ id: 'bp-c', name: 'fixture-pc', lifecycle: 'paused' })
  const PAUSED2 = agent({ id: 'bp-d', name: 'fixture-pd', lifecycle: 'paused' })

  it('pause toasts "Paused 2" for the daemon\'s "paused" answer', async () => {
    setData({ agents: [PA, PB], itsas: [] } as never)
    daemon({ '/api/agents/bp-a/pause': { result: 'paused' }, '/api/agents/bp-b/pause': { result: 'paused' } })
    await bulkAction(['bp-a', 'bp-b'], { kind: 'pause' })
    expect(toast).toHaveBeenCalledWith('Paused 2', false)
  })

  it('resume toasts "Resumed 2" for the daemon\'s "resuming" answer, not as queued', async () => {
    setData({ agents: [PAUSED1, PAUSED2], itsas: [] } as never)
    daemon({ '/api/agents/bp-c/unpause': { result: 'resuming' }, '/api/agents/bp-d/unpause': { result: 'resuming' } })
    await bulkAction(['bp-c', 'bp-d'], { kind: 'resume' })
    expect(toast).toHaveBeenCalledWith('Resumed 2', false)
  })

  it('a mode change toasts its count, whatever the route answers', async () => {
    setData({ agents: [PA, PB], itsas: [] } as never)
    daemon({ '/api/agents/bp-a/permission-mode': { result: 'permission mode changed to bypass' }, '/api/agents/bp-b/permission-mode': { result: 'permission mode changed to bypass' } })
    await bulkAction(['bp-a', 'bp-b'], { kind: 'mode', mode: 'bypass' })
    expect(toast).toHaveBeenCalledWith('Switched 2 to Bypass permissions', false)
  })
})

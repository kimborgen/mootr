// @vitest-environment jsdom
// The sidebar tree row of a blocked agent links to the open ask it waits on (S-3982), as the Agents page does: the link
// shows only while that ask's row is open in the store, and a tap goes to the ask's card, not to the agent's row.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ask } from './types'

const selectThread = vi.fn()
const selectAgent = vi.fn()
vi.mock('./actions', async (orig) => ({ ...(await orig<object>()), selectThread: (t: string) => selectThread(t), selectAgent: (a: string) => selectAgent(a) }))
vi.mock('./api', () => ({ api: vi.fn(async () => []), hash: new URLSearchParams() }))

import { Tree } from './Tree'
import { setData } from './store'
import { agent } from './stories/fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = '2026-10-25T09:00:00.000Z'
const ask = (over: Partial<Ask>): Ask => ({
  key: 'request:fx-k1', kind: 'request', state: 'open', outcome: null, what: 'Permission request', agent_id: 'k-dev', agent_name: 'fixture-blocked',
  machine: 'fixture-machine', thread_id: 'fx-k-thread', itsa_id: null, since: T0, settled_at: null, ...over,
})
const AGENTS = [
  agent({ id: 'k-dev', name: 'fixture-blocked', role: 'developer', activity: 'waiting', open_ask: 'request:fx-k1' }),
  agent({ id: 'k-free', name: 'fixture-free', role: 'developer', activity: 'idle', open_ask: null }),
]

const roots: Root[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => { r.unmount() })
  document.body.innerHTML = ''
  selectThread.mockClear()
  selectAgent.mockClear()
})

// The tree over these agents and asks, as the store holds them.
async function mount(asks: Ask[]) {
  setData({ agents: AGENTS, itsas: [], asks, loaded: { agents: true, mail: true, itsas: true } } as never)
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  roots.push(root)
  await act(async () => { root.render(<Tree />) })
  return el
}

describe('the sidebar tree row of a blocked agent', () => {
  it('links to its open ask, by the list\'s key', async () => {
    const el = await mount([ask({})])
    const link = el.querySelector<HTMLButtonElement>('[data-open-ask="request:fx-k1"]')
    expect(link?.textContent).toContain('Open ask')
    expect(el.querySelectorAll('[data-open-ask]').length).toBe(1)
  })

  it('shows no link once the ask settles', async () => {
    const el = await mount([ask({ state: 'settled', outcome: 'approved', settled_at: T0 })])
    expect(el.querySelector('[data-open-ask]')).toBeNull()
  })

  it('goes to the ask\'s card, not to the agent\'s row', async () => {
    const el = await mount([ask({})])
    await act(async () => { el.querySelector<HTMLButtonElement>('[data-open-ask]')!.click() })
    expect(selectThread).toHaveBeenCalledWith('fx-k-thread')
    expect(selectAgent).not.toHaveBeenCalled()
  })
})

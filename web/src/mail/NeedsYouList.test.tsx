// @vitest-environment jsdom
// A Needs you row opens what the waiting list opens (S-3953): an ITSA, else its thread when the human holds it,
// else its agent. A thread on a peer that the human doesn't hold opens the agent, as the waiting list does.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Ask } from '../types'

const selectThread = vi.fn()
const selectAgent = vi.fn()
const env = { held: [] as string[] }
vi.mock('../actions', async (orig) => ({ ...(await orig<object>()), selectThread: (t: string) => selectThread(t), selectAgent: (a: string) => selectAgent(a) }))
vi.mock('../itsa/itsa', async (orig) => ({ ...(await orig<object>()), openItsa: vi.fn() }))
// The threads the human holds, as the waiting list reads them.
vi.mock('../store', async (orig) => ({ ...(await orig<object>()), getData: () => ({ humanThreads: env.held.map((thread_id) => ({ thread_id, mails: [] })), humanArchived: [], humanDeferred: [] }) }))

import { NeedsYouList } from './NeedsYouList'

const ask = (over: Partial<Ask>): Ask => ({
  key: 'request:fx-1', kind: 'request', state: 'open', outcome: null, what: 'Permission request',
  agent_id: 'fx-agent', agent_name: 'fixture-dev', machine: 'fixture-home', thread_id: 'fx-thread', itsa_id: null, since: new Date().toISOString(), settled_at: null,
  ...over,
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null
async function renderRow(a: Ask): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<NeedsYouList asks={[a]} />) })
  return host.querySelector<HTMLElement>('[data-ask]')!
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  env.held = []
  selectThread.mockClear()
  selectAgent.mockClear()
})

describe('a Needs you row opens what the waiting list opens', () => {
  it('a thread the human holds opens the thread', async () => {
    env.held = ['fx-thread']
    ;(await renderRow(ask({}))).click()
    expect(selectThread).toHaveBeenCalledWith('fx-thread')
    expect(selectAgent).not.toHaveBeenCalled()
  })

  it('a peer thread the human does not hold opens the agent', async () => {
    ;(await renderRow(ask({ thread_id: 'fx-peer-mail' }))).click()
    expect(selectAgent).toHaveBeenCalledWith('fx-agent')
    expect(selectThread).not.toHaveBeenCalled()
  })

  it('a thread with no agent opens the thread', async () => {
    ;(await renderRow(ask({ agent_id: null, agent_name: null, thread_id: 'fx-peer-mail' }))).click()
    expect(selectThread).toHaveBeenCalledWith('fx-peer-mail')
    expect(selectAgent).not.toHaveBeenCalled()
  })
})

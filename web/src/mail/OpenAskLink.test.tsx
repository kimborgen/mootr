// @vitest-environment jsdom
// The link from an agent or an ITSA to the ask it waits on (S-3977): it stands for the open row of the Needs you list with
// that key, and goes when the row is gone or settled. A tap goes straight to the ask's card: an ITSA ask to its ITSA, any
// other to its home thread. It is a button, so Enter works without a key handler.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Ask } from '../types'

const selectThread = vi.fn()
const selectAgent = vi.fn()
const openItsa = vi.fn()
vi.mock('../actions', async (orig) => ({ ...(await orig<object>()), selectThread: (t: string) => selectThread(t), selectAgent: (a: string) => selectAgent(a) }))
vi.mock('../itsa/itsa', async (orig) => ({ ...(await orig<object>()), openItsa: (id: string) => openItsa(id) }))
vi.mock('../store', async (orig) => ({ ...(await orig<object>()), getData: () => ({ asks: [] }) }))

import { OpenAskLink, openAskRow } from './OpenAskLink'

const ask = (over: Partial<Ask>): Ask => ({
  key: 'request:fx-1', kind: 'request', state: 'open', outcome: null, what: 'Permission request',
  agent_id: 'fx-agent', agent_name: 'fixture-dev', machine: 'fixture-home', thread_id: 'fx-thread', itsa_id: null, since: new Date().toISOString(), settled_at: null,
  ...over,
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null
async function render(row: Ask): Promise<HTMLButtonElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<OpenAskLink row={row} />) })
  return host.querySelector<HTMLButtonElement>('[data-open-ask]')!
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  selectThread.mockClear()
  selectAgent.mockClear()
  openItsa.mockClear()
})

describe('the link to an open ask', () => {
  it('is a button that says Open ask, titled with the kind and that the human owes it', async () => {
    const el = await render(ask({}))
    expect(el.tagName).toBe('BUTTON')
    expect(el.type).toBe('button')
    expect(el.textContent).toBe('Open ask')
    expect(el.getAttribute('data-open-ask')).toBe('request:fx-1')
    expect(el.title).toBe('Permission · waiting on you')
  })

  it('a permission or mail ask goes to its home thread, the card where it is answered', async () => {
    ;(await render(ask({}))).click()
    expect(selectThread).toHaveBeenCalledWith('fx-thread')
    expect(openItsa).not.toHaveBeenCalled()
  })

  it('an ITSA ask goes to its ITSA, the Waiting-on-you card, not through the Needs you list', async () => {
    ;(await render(ask({ key: 'itsa:fx-itsa', kind: 'itsa', itsa_id: 'fx-itsa' }))).click()
    expect(openItsa).toHaveBeenCalledWith('fx-itsa')
    expect(selectThread).not.toHaveBeenCalled()
  })

  it('a row with no thread goes to its agent', async () => {
    ;(await render(ask({ thread_id: null }))).click()
    expect(selectAgent).toHaveBeenCalledWith('fx-agent')
  })
})

describe('the row an agent or ITSA links to', () => {
  it('is the open row with that key, and none once it settles or is gone', () => {
    const open = ask({})
    const settled = ask({ key: 'request:fx-2', state: 'settled', outcome: 'approved', settled_at: new Date().toISOString() })
    expect(openAskRow('request:fx-1', [open, settled])).toBe(open)
    expect(openAskRow('request:fx-2', [open, settled])).toBeUndefined()
    expect(openAskRow('request:fx-3', [open, settled])).toBeUndefined()
    expect(openAskRow(null, [open])).toBeUndefined()
  })
})

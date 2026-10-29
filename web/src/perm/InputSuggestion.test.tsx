// @vitest-environment jsdom
// The suggested input card (S-422): the text as written, the approval's hash, and which status
// shows once the server moves on from the answer the human gave.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InputSuggestion } from './InputSuggestion'
import { sha256Hex } from './input'
import type { Permission } from '../types'

const archive = vi.fn()
const restart = vi.fn()
let agentActivity = 'idle'
vi.mock('../actions', () => ({ archiveThreadAndAdvance: (t: string) => archive(t), agentAction: (a: { id: string }, action: string) => restart(a.id, action) }))
vi.mock('../store', () => ({ byId: (id: string) => (id === 'a1' ? { id: 'a1', name: 'tess', activity: agentActivity } : undefined), refresh: vi.fn(), refreshSlow: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TEXT = 'make the tests pass\n  (keep  the spacing)'
const base: Permission = {
  id: 'p1', agent_id: 'a1', agent_name: 'tess', machine: 'alpha', kind: 'input', status: 'pending',
  reason: 'The build is red.', text: TEXT, sha256: null, expires_at: new Date(Date.now() + 240_000).toISOString(),
  action: 'suggest input', created_at: new Date().toISOString(),
}

let host: HTMLElement
let root: Root
let posts: { path: string; body: any }[]
let answer: Record<string, unknown>

beforeEach(() => {
  posts = []
  archive.mockClear()
  restart.mockClear()
  agentActivity = 'idle'
  answer = { outcome: 'held' }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(init.body as string) })
    await new Promise((r) => setTimeout(r, 30)) // answers late on purpose: a click helper that waits a fixed time fails
    return { ok: true, status: 200, json: async () => answer }
  }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const view = (p: Permission, canAnswer = true) => act(() => root.render(<InputSuggestion p={p} canAnswer={canAnswer} />))
const text = () => host.textContent ?? ''
// The answer's hash, the POST, and the state after it are async: let them settle inside act. The card
// disables its buttons while it works (busy) and enables or removes them when done, so wait on that,
// not on a timer: a fixed wait let a loaded run assert before the answer's state had landed.
const working = () => host.querySelector('[data-input-approve][disabled], [data-input-deny][disabled], [data-input-restart][disabled]') !== null
const click = async (sel: string) => {
  act(() => { (host.querySelector(sel) as HTMLButtonElement).click() })
  // setBusy(true) runs in the click, so a card that is not busy now means the wait would pass on nothing.
  expect(working()).toBe(true)
  const giveUp = Date.now() + 2000
  while (working()) {
    if (Date.now() > giveUp) throw new Error('card still busy after click')
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
}

describe('InputSuggestion', () => {
  it('shows the agent, the reason, and the text as written', () => {
    view(base)
    expect(text()).toContain('→ @tess on alpha')
    expect(text()).toContain('The build is red.')
    expect(host.querySelector('[data-input-text]')?.textContent).toBe(TEXT)
  })

  it('approves with the hash of the text on screen, never the server field', async () => {
    view({ ...base, sha256: 'not-the-hash' })
    await click('[data-input-approve]')
    expect(posts).toEqual([{ path: '/api/permissions/p1/answer', body: { approve: true, text_sha256: await sha256Hex(TEXT) } }])
  })

  it('denies without a hash', async () => {
    view(base)
    answer = { outcome: 'denied' }
    await click('[data-input-deny]')
    expect(posts[0].body).toEqual({ approve: false })
  })

  it('shows the held answer, then the server status once it moves on: held → approved', async () => {
    view(base)
    await click('[data-input-approve]')
    expect(text()).toContain('Held: types when @tess is idle')
    view({ ...base, status: 'approved' })
    expect(text()).not.toContain('Held')
    expect(text()).toContain('Approved')
  })

  it('held → expired shows Expired, not the held answer', async () => {
    view(base)
    await click('[data-input-approve]')
    view({ ...base, status: 'expired' })
    expect(text()).not.toContain('Held')
    expect(text()).toContain('Expired')
  })

  it('held → withdrawn shows Withdrawn, not the held answer', async () => {
    view(base)
    await click('[data-input-approve]')
    view({ ...base, status: 'withdrawn' })
    expect(text()).not.toContain('Held')
    expect(text()).toContain('Withdrawn')
  })

  it('shows a plain error from the daemon, such as a 409 from another machine', async () => {
    view(base)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'approve from stam on other-box' }) })))
    await click('[data-input-approve]')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('approve from stam on other-box')
  })

  // S-500 follow-up: an answered card drops Approve, Deny, and the expiry, and says who answered and when.
  it('once answered, drops the buttons and the expiry and names who answered', async () => {
    answer = { outcome: 'typed' }
    act(() => root.render(<InputSuggestion p={base} canAnswer note={<p>Only you can approve it.</p>} />))
    expect(text()).toContain('expires in')
    expect(text()).toContain('Only you can approve it.')
    await click('[data-input-approve]')
    expect(text()).not.toContain('Only you can approve it.')
    expect(host.querySelector('[data-input-approve]')).toBeNull()
    expect(host.querySelector('[data-input-deny]')).toBeNull()
    expect(text()).not.toContain('expires in')
    expect(host.querySelector('[data-input-status]')?.textContent).toBe('Typed into @tess · by you · just now')
    view({ ...base, status: 'approved', decided_by: 'human', decided_at: new Date(Date.now() - 300_000).toISOString() })
    expect(host.querySelector('[data-input-status]')?.textContent).toBe('Typed into @tess · by you · 5 min ago')
    view({ ...base, status: 'expired' })
    expect(host.querySelector('[data-input-status]')?.textContent).toBe('Expired')
  })

  // S-524: an answer archives the thread like a reply; a failed one keeps it open.
  it('archives its thread after an approve or a deny, not after a failed answer', async () => {
    act(() => root.render(<InputSuggestion p={base} canAnswer thread="t1" />))
    await click('[data-input-approve]')
    expect(archive).toHaveBeenCalledWith('t1')
    archive.mockClear()
    act(() => root.render(<InputSuggestion key="p2" p={{ ...base, id: "p2" }} canAnswer thread="t2" />))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'approve from stam on other-box' }) })))
    await click('[data-input-approve]')
    expect(archive).not.toHaveBeenCalled()
  })

  it('shows an "already held" refusal as the daemon words it (a hash mismatch), not as the held state', async () => {
    view(base)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'request p1 is already held' }) })))
    await click('[data-input-approve]')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('request p1 is already held')
  })

  it('keeps the thread open when the approved input did not go in', async () => {
    for (const outcome of ['failed', 'cancelled', 'expired']) {
      answer = { outcome }
      act(() => root.render(<InputSuggestion key={outcome} p={{ ...base, id: outcome }} canAnswer thread="t" />))
      await click('[data-input-approve]')
    }
    expect(archive).not.toHaveBeenCalled()
    answer = { outcome: 'held' }
    act(() => root.render(<InputSuggestion key="h" p={{ ...base, id: 'h' }} canAnswer thread="t" />))
    await click('[data-input-approve]')
    expect(archive).toHaveBeenCalledWith('t')
  })

  it('a held approval blocked by text in the box names the text and offers a restart (S-534)', async () => {
    view({ ...base, status: 'held', note: 'box:half a command' })
    expect(host.querySelector('[data-input-box]')?.textContent).toContain("@tess's box holds text: half a command")
    expect(host.querySelector('[data-input-approve]')).toBeNull()
    expect(host.querySelector('[data-input-status]')?.textContent).toContain("Held: @tess's box isn't empty")
    expect(text()).not.toContain('types when')
    await click('[data-input-restart]')
    expect(restart).toHaveBeenCalledWith('a1', 'restart')
  })

  it('no Restart while the agent is working: it would cut its turn', () => {
    agentActivity = 'working'
    view({ ...base, status: 'held', note: 'box:half a command' })
    expect(host.querySelector('[data-input-box]')).not.toBeNull()
    expect(host.querySelector('[data-input-restart]')).toBeNull()
  })

  it('a held approval waiting on a busy agent shows no box line', () => {
    view({ ...base, status: 'held', note: 'approved' })
    expect(host.querySelector('[data-input-box]')).toBeNull()
    expect(text()).toContain('Held: types when @tess is idle')
  })

  it('an answer held by a draft keeps the mail open; held for another reason archives it', async () => {
    const withThread = () => act(() => root.render(<InputSuggestion p={base} canAnswer thread="t1" />))
    answer = { outcome: 'held', why: 'draft' }
    withThread()
    await click('[data-input-approve]')
    expect(text()).toContain("Held: @tess's box isn't empty")
    expect(archive).not.toHaveBeenCalled()
    act(() => root.render(<InputSuggestion key="p2" p={{ ...base, id: 'p2' }} canAnswer thread="t1" />))
    answer = { outcome: 'held', why: 'busy' }
    await click('[data-input-approve]')
    expect(archive).toHaveBeenCalledWith('t1')
  })
})

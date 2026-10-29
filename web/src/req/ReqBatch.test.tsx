// @vitest-environment jsdom
// S-568 review: turning Requirements off while a batch approval is open must hand the ITSA its
// body back. ReqBatch reports `false` once the batch is off, so ItsaView stops hiding the body.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReqBatch } from './ReqBatch'

const hoisted = vi.hoisted(() => ({ enabled: true, get: vi.fn() }))
vi.mock('../api', () => ({ api: (...args: unknown[]) => hoisted.get(...args) }))
vi.mock('./store', () => ({ useReq: () => ({ enabled: hoisted.enabled }), refreshReq: () => Promise.resolve() }))
vi.mock('./parts', () => ({ openReq: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const it1 = { id: 'a1', kind: 'requirement-approval', closed_at: null, updated_at: 'u1' }
const view = {
  itsa: 'S-24',
  items: [{ key: 'R-4', title: 'One line per draft', text: 'The approval shall list each draft.', rationale: 'Dana approves what they read.', rev: 1, status: 'draft', dropped: false }],
}

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  hoisted.enabled = true
  hoisted.get = vi.fn(() => Promise.resolve(view))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('ReqBatch', () => {
  it('reports the revision its shown drafts were read with, and keeps it while a reload is slow (S-2998)', async () => {
    let resolveSlow: (v: unknown) => void = () => {}
    hoisted.get = vi.fn(() => Promise.resolve({ ...view, rev: 'revA' }))
    const onBatch = vi.fn()
    await act(async () => root.render(<ReqBatch it={it1} onBatch={onBatch} />))
    await flush()
    expect(onBatch).toHaveBeenLastCalledWith(true, 'revA')
    // The ITSA changed (u2); the batch's reload answers late, so the old drafts and their revision stay.
    hoisted.get = vi.fn(() => new Promise((r) => { resolveSlow = r }))
    await act(async () => root.render(<ReqBatch it={{ ...it1, updated_at: 'u2' }} onBatch={onBatch} />))
    await flush()
    expect(onBatch).toHaveBeenLastCalledWith(true, 'revA')
    expect(host.querySelector('.rq-batch-shall')?.textContent).toBe('The approval shall list each draft.')
    await act(async () => { resolveSlow({ ...view, rev: 'revB', items: [{ ...view.items[0], text: 'Changed text.' }] }) })
    await flush()
    expect(onBatch).toHaveBeenLastCalledWith(true, 'revB')
    expect(host.querySelector('.rq-batch-shall')?.textContent).toBe('Changed text.')
  })

  it('reports the batch and lists its drafts while requirements are on', async () => {
    const onBatch = vi.fn()
    await act(async () => root.render(<ReqBatch it={it1} onBatch={onBatch} />))
    await flush()
    expect(onBatch).toHaveBeenLastCalledWith(true, undefined)
    expect(host.querySelector('[data-req-batch]')).not.toBeNull()
  })

  it('reports no batch once requirements are turned off, though the batch was loaded', async () => {
    const onBatch = vi.fn()
    await act(async () => root.render(<ReqBatch it={it1} onBatch={onBatch} />))
    await flush()
    expect(onBatch).toHaveBeenLastCalledWith(true, undefined)
    hoisted.enabled = false
    await act(async () => root.render(<ReqBatch it={it1} onBatch={onBatch} />))
    await flush()
    expect(onBatch).toHaveBeenLastCalledWith(false)
    expect(host.querySelector('[data-req-batch]')).toBeNull()
  })

  it('reports no batch for a single-draft ask whose batch fetch fails', async () => {
    hoisted.get = vi.fn(() => Promise.reject(new Error('no requirement approval a1')))
    const onBatch = vi.fn()
    await act(async () => root.render(<ReqBatch it={it1} onBatch={onBatch} />))
    await flush()
    expect(onBatch).toHaveBeenLastCalledWith(false)
  })
})

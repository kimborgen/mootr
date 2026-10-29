import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { ATTEMPT_TIMEOUT_MS, addDraft, dismiss, getRows, loadOutbox, resetOutbox, submit, take, setTitle, type OutboxRow, type Persist } from './outbox'

// Storage by row id, as IndexedDB keeps it; `live` names the tabs that count as open.
const memory = (liveTabs: string[] = []) => {
  const db = new Map<string, OutboxRow>()
  const p = {
    load: async () => [...db.values()].map((r) => JSON.parse(JSON.stringify(r)) as OutboxRow),
    apply: async (puts: OutboxRow[], removes: string[]) => { for (const r of puts) db.set(r.id, JSON.parse(JSON.stringify(r))); for (const id of removes) db.delete(id) },
    live: async (tab: string) => liveTabs.includes(tab),
    get saved() { return [...db.values()] },
    db,
  }
  return p satisfies Persist & { saved: OutboxRow[] }
}
const row = (send: (id: string) => Promise<unknown>, key = 'agent:a1', text = 'hi') => submit({ key, text, files: [], mode: 'direct', send })
// Lets the pump run what is ready without moving the clock.
const settle = async () => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0) }

beforeEach(() => { vi.useFakeTimers(); resetOutbox(memory()) })
afterEach(() => { vi.useRealTimers() })

describe('outbox', () => {
  it('shows a pending row at once and removes it when the send succeeds', async () => {
    let ok = () => {}
    row(() => new Promise<void>((r) => { ok = r }))
    expect(getRows('agent:a1')).toMatchObject([{ kind: 'pending', text: 'hi' }])
    await settle(); ok(); await settle()
    expect(getRows()).toEqual([])
  })

  it('sends one target\'s rows in order, and other targets in parallel', async () => {
    const log: string[] = []
    const gates: Record<string, () => void> = {}
    const send = (n: string) => () => { log.push('start ' + n); return new Promise<void>((r) => { gates[n] = () => { log.push('end ' + n); r() } }) }
    row(send('1')); row(send('2')); row(send('x'), 'agent:b2')
    await settle()
    expect(log).toEqual(['start 1', 'start x'])
    gates[1](); await settle()
    expect(log).toEqual(['start 1', 'start x', 'end 1', 'start 2'])
    gates[2](); gates.x(); await settle()
    expect(getRows()).toEqual([])
  })

  it('retries a network error with backoff, keeps the row pending, and sends the same client id', async () => {
    const ids: string[] = []
    let up = false
    row(async (id) => { ids.push(id); if (!up) throw new TypeError('Failed to fetch') })
    await settle()
    expect(getRows()[0]).toMatchObject({ kind: 'pending', attempts: 1, error: 'Failed to fetch' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(ids).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ids).toHaveLength(3)
    up = true
    await vi.advanceTimersByTimeAsync(4000)
    expect(getRows()).toEqual([])
    expect(new Set(ids).size).toBe(1)
  })

  // A send left waiting for its retry when the outbox is reset (a test ending, a fixture) must not fire
  // into the fresh outbox, nor show up in its rows: the next test would see a stray request.
  it('a reset leaves no retry of the old outbox to send', async () => {
    const sent: string[] = []
    row(async () => { sent.push('first'); if (sent.length === 1) throw new TypeError('Failed to fetch') })
    await settle()
    expect(sent).toEqual(['first'])
    resetOutbox(memory())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(sent).toEqual(['first'])
    expect(getRows()).toEqual([])
  })

  it('retries a 5xx but fails a 4xx at once', async () => {
    let n = 0
    row(async () => { if (n++ === 0) throw new ApiError('boom', 502) })
    await settle(); expect(getRows()[0].kind).toBe('pending')
    await vi.advanceTimersByTimeAsync(1000); expect(getRows()).toEqual([])
    row(async () => { throw new ApiError('Select an agent first', 409) }, 'agent:b2')
    await settle()
    expect(getRows()[0]).toMatchObject({ kind: 'failed', error: 'Select an agent first', attempts: 1 })
  })

  it('fails after 60 s of failed attempts', async () => {
    row(async () => { throw new TypeError('Failed to fetch') })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(getRows()[0].kind).toBe('pending')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(getRows()[0]).toMatchObject({ kind: 'failed', error: 'Failed to fetch' })
  })

  it('counts an attempt that hangs as a failed one', async () => {
    let n = 0
    row(() => (n++ === 0 ? new Promise(() => {}) : Promise.resolve()))
    await vi.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS)
    expect(getRows()[0]).toMatchObject({ kind: 'pending', error: 'The daemon did not answer in time' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(getRows()).toEqual([])
  })

  it('does not hold up the next row behind a failed one', async () => {
    const sent: string[] = []
    row(async () => { throw new ApiError('no', 400) })
    row(async () => { sent.push('second') })
    await settle()
    expect(sent).toEqual(['second'])
    expect(getRows().map((r) => r.kind)).toEqual(['failed'])
  })

  it('takes a failed row out for the box, but not a pending one', async () => {
    let ok = () => {}
    const pending = row(() => new Promise<void>((r) => { ok = r }))
    await settle()
    expect(take(pending)).toBeNull()
    ok(); await settle()
    const id = submit({ key: 'k', text: 'a\nb', files: [{ name: 'f.png', type: 'image/png', size: 1, content_b64: 'AA', url: 'data:image/png;base64,AA' }], mode: 'mail', send: async () => { throw new ApiError('no', 403) } })
    await settle()
    const r = take(id)!
    expect(r).toMatchObject({ kind: 'failed', text: 'a\nb', mode: 'mail' })
    expect(r.files[0].url).toContain('data:image/png')
    expect(getRows()).toEqual([])
  })

  it('brings rows back after a reload, pending ones as failed', async () => {
    const store = memory()
    resetOutbox(store, 'tab-1')
    row(() => new Promise(() => {}), 'agent:a1', 'lost')
    row(async () => { throw new ApiError('no', 400) }, 'agent:b2', 'refused')
    await settle()
    expect(store.saved).toHaveLength(2)
    // The page reloads: memory is gone, storage stays, and the tab is the same one.
    resetOutbox(store, 'tab-1')
    await loadOutbox()
    expect(getRows().map((r) => [r.text, r.kind])).toEqual([['lost', 'failed'], ['refused', 'failed']])
    expect(getRows()[0].error).toMatch(/reload/)
  })

  it('keeps a draft across a reload, with its files and mode', async () => {
    const store = memory()
    resetOutbox(store, 'tab-1')
    const file = { name: 'a.png', type: 'image/png', size: 1, content_b64: 'AA', url: 'data:image/png;base64,AA' }
    const id = addDraft('agent:a1', 'half a thought', [file], 'mail')
    await settle()
    resetOutbox(store, 'tab-1')
    await loadOutbox()
    expect(getRows()).toMatchObject([{ id, kind: 'draft', text: 'half a thought', mode: 'mail', files: [file] }])
  })

  it('keeps the cc of a row across a reload, pending ones as failed, and of a draft', async () => {
    const store = memory()
    resetOutbox(store, 'tab-1')
    submit({ key: 'agent:a1', text: 'lost', files: [], mode: 'mail', cc: ['c1', 'c2'], send: () => new Promise(() => {}) })
    const d = addDraft('agent:a1', 'half', [], 'mail', ['c3'])
    await settle()
    resetOutbox(store, 'tab-1')
    await loadOutbox()
    expect(getRows().map((r) => [r.kind, r.cc])).toEqual([['failed', ['c1', 'c2']], ['draft', ['c3']]])
    expect(take(d)!.cc).toEqual(['c3'])
  })

  it('shows a title set while the row is still showing', async () => {
    const id = row(() => new Promise(() => {}))
    setTitle(id, 'Deploy plan')
    expect(getRows()[0].title).toBe('Deploy plan')
  })

  it('fails a send that threw before any request went out, without retrying', async () => {
    let n = 0
    row(async () => { n++; throw new Error('Select an agent or terminal pane first.') })
    await settle()
    expect(getRows()[0]).toMatchObject({ kind: 'failed', error: 'Select an agent or terminal pane first.' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(n).toBe(1)
  })

  it('sends a message put back again under its old id, once its id is free', async () => {
    const ids: string[] = []
    const id = row(async (cid) => { ids.push(cid); throw new ApiError('no', 403) })
    await settle()
    take(id)
    submit({ id, key: 'agent:a1', text: 'hi', files: [], mode: 'direct', send: async (cid) => { ids.push(cid) } })
    await settle()
    expect(ids).toEqual([id, id])
    expect(getRows()).toEqual([])
  })

  it('leaves a live tab\'s rows alone and adopts a closed tab\'s, pending ones as failed', async () => {
    const store = memory(['tab-live'])
    const mk = (id: string, tab: string, kind: OutboxRow['kind']): OutboxRow => ({ id, key: 'agent:a1', kind, text: id, files: [], mode: 'direct', created: 1, attempts: 1, tab })
    for (const r of [mk('theirs', 'tab-live', 'pending'), mk('gone', 'tab-dead', 'pending'), mk('gone-draft', 'tab-dead', 'draft'), mk('old', '', 'pending')]) store.db.set(r.id, r)
    resetOutbox(store, 'tab-me')
    await loadOutbox()
    expect(getRows().map((r) => [r.id, r.kind]).sort()).toEqual([['gone', 'failed'], ['gone-draft', 'draft'], ['old', 'failed']])
    await settle()
    // The live tab's record is untouched; the adopted ones are now this tab's.
    expect(store.db.get('theirs')).toMatchObject({ kind: 'pending', tab: 'tab-live' })
    expect(store.db.get('gone')).toMatchObject({ kind: 'failed' })
    // Taking one out removes only its own record.
    take('gone'); await settle()
    expect(store.db.has('gone')).toBe(false)
    expect(store.db.has('theirs')).toBe(true)
  })

  it('adopts stored rows inside the adopt lock, so two tabs starting together do not both take them', async () => {
    const asked: string[] = []
    vi.stubGlobal('navigator', { locks: { request: async (name: string, a: unknown, b?: unknown) => { asked.push(name); const cb = (typeof a === 'function' ? a : b) as (l: unknown) => unknown; return cb({}) } } })
    resetOutbox(memory(), 'tab-me')
    await loadOutbox()
    vi.unstubAllGlobals()
    expect(asked).toContain('stam-outbox-adopt')
  })

  it('stamps a row made before the tab id was known with it once it is', async () => {
    const store = memory()
    resetOutbox(store)
    row(() => new Promise(() => {}))
    expect(getRows()[0].tab).toBeFalsy()
    await loadOutbox()
    await settle()
    const tab = getRows()[0].tab
    expect(tab).toBeTruthy()
    expect(store.db.get(getRows()[0].id)?.tab).toBe(tab)
  })
})

describe('a message that failed', () => {
  const MIN = 60_000
  const fails = (text = 'lost words\nsecond', key = 'agent:a1') => submit({ key, target: 'helper', text, files: [], mode: 'direct', send: async () => { throw new ApiError('refused', 409) } })

  it('stays a red row in the prompt input, and nothing is mailed', async () => {
    fails()
    await settle()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(getRows()).toMatchObject([{ kind: 'failed', text: 'lost words\nsecond', error: 'refused' }])
  })

  it('is put back by take, and an untouched row keeps waiting', async () => {
    const a = fails('one')
    const b = fails('two', 'agent:b2')
    await settle()
    expect(take(a)).toMatchObject({ text: 'one' })
    expect(getRows().map((r) => r.id)).toEqual([b])
    dismiss(b)
    expect(getRows()).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { buildPatch, saveNote, savePeer, settleSave, type Obj } from './settings-save'

describe('settleSave (S-418)', () => {
  it('a 202 is an ask: nothing is merged into the base, and the sent keys go back to what the daemon holds', () => {
    const base = { 'assistant': { model: 'a' }, 'view': 'x' }
    const cur = { 'assistant': { model: 'b' }, 'view': 'y' }
    const patch = { assistant: { model: 'b' } }
    const r = settleSave({ requested: 'req-1' }, cur, base, patch)
    expect(r.requested).toBe(true)
    expect(r.requestId).toBe('req-1')
    expect(r.base).toBe(base)
    expect(base).toEqual({ assistant: { model: 'a' }, view: 'x' })
    expect(cur.assistant).toEqual({ model: 'a' })
    // A key the page didn't send keeps what the page shows.
    expect(cur.view).toBe('y')
  })

  it('a 202 on a key the daemon has none of removes it from the page', () => {
    const cur = { notify: { on: true } }
    const r = settleSave({ requested: 'req-2' }, cur, {}, { notify: { on: true } })
    expect(r.requested).toBe(true)
    expect(cur).toEqual({})
  })

  it('a 200 is saved: the base becomes the file the daemon now holds', () => {
    const base = { a: 1 }
    const cur = { a: 2, b: 'local' }
    const now = { a: 2, b: 'shared' }
    const r = settleSave({ text: JSON.stringify(now) }, cur, base, { a: 2 })
    expect(r.requested).toBe(false)
    expect(r.base).toEqual(now)
    expect(cur).toEqual({ a: 2, b: 'shared' })
  })

  it('a 200 with no body still takes the patch into the base', () => {
    const base = { a: 1 }
    const r = settleSave({ text: undefined }, { a: 2 }, base, { a: 2 })
    expect(r.requested).toBe(false)
    expect(r.base).toEqual({ a: 2 })
  })
})

describe('saveNote (S-418)', () => {
  it('a 202 says it was sent for approval, not saved', () => {
    expect(saveNote('requested')).toBe('Sent for approval.')
  })

  it('a 200 says saved, and a refused save never says saved', () => {
    expect(saveNote('saved')).toBe('Saved.')
    expect(saveNote('error')).toBe('Not saved; see the error message.')
  })
})

describe('savePeer (S-414)', () => {
  const local = ['home', 'peers', 'itsa.home']
  const io = (o: { home?: () => Promise<unknown>; local?: () => Promise<{ requested?: string }> }) => {
    const calls: string[] = []
    return {
      calls,
      io: {
        home: (p: Obj) => { calls.push('home ' + Object.keys(p).join(',')); return (o.home ?? (() => Promise.resolve({})))() },
        local: (p: Obj) => { calls.push('local ' + Object.keys(p).join(',')); return (o.local ?? (() => Promise.resolve({ text: '{}' })))() },
        sync: () => { calls.push('sync'); return Promise.resolve() },
      },
    }
  }
  it('sends the shared part to the home, the local part here, and saves both', async () => {
    const base: Obj = { cost: { a: 1 }, peers: [] }
    const cur: Obj = { cost: { a: 2 }, peers: [{ name: 'x' }] }
    const t = io({})
    const r = await savePeer(t.io, cur, base, { cost: cur.cost, peers: cur.peers }, local, 'home')
    expect(t.calls).toEqual(['home cost', 'sync', 'local peers'])
    expect(r.outcome).toBe('saved')
    expect(r.base).toEqual(cur)
  })
  it('an unreachable home saves nothing: no local write, the controls go back', async () => {
    const base: Obj = { cost: { a: 1 }, peers: [] }
    const cur: Obj = { cost: { a: 2 }, peers: [{ name: 'x' }] }
    const t = io({ home: () => Promise.reject(new Error("Can't reach home; nothing was saved.")) })
    const r = await savePeer(t.io, cur, base, { cost: cur.cost, peers: cur.peers }, local, 'home')
    expect(t.calls).toEqual(['home cost'])
    expect(r).toMatchObject({ outcome: 'error', message: "Can't reach home; nothing was saved." })
    expect(cur).toEqual(base)
  })
  it('a home write that took and a local one that failed keeps the shared keys saved and says only the local part failed', async () => {
    const base: Obj = { cost: { a: 1 }, peers: [] }
    const cur: Obj = { cost: { a: 2 }, peers: [{ name: 'x' }] }
    const t = io({ local: () => Promise.reject(new Error('boom')) })
    const r = await savePeer(t.io, cur, base, { cost: cur.cost, peers: cur.peers }, local, 'home')
    expect(t.calls).toEqual(['home cost', 'sync', 'local peers'])
    expect(r.outcome).toBe('error')
    expect(r.message).toBe("Saved on home; this machine's settings weren't: boom")
    expect(r.base.cost).toEqual({ a: 2 })
    expect(cur).toEqual({ cost: { a: 2 }, peers: [] })
  })
  it('a local part that becomes an ask is reported as sent for approval, the shared part saved', async () => {
    const base: Obj = { cost: { a: 1 }, peers: [] }
    const cur: Obj = { cost: { a: 2 }, peers: [{ name: 'x' }] }
    const r = await savePeer(io({ local: () => Promise.resolve({ requested: 'p1' }) }).io, cur, base, { cost: cur.cost, peers: cur.peers }, local, 'home')
    expect(r).toMatchObject({ outcome: 'requested', requestId: 'p1' })
    expect(r.base.cost).toEqual({ a: 2 })
    expect(cur.peers).toEqual([])
  })
})

describe('buildPatch (S-294)', () => {
  it('a view dropped from a view record goes as a null for its id', () => {
    const base = { boardViews: { a: { n: 1 }, b: { n: 2 } }, x: 1 }
    const cur = { boardViews: { a: { n: 1 } }, x: 1 }
    expect(buildPatch(cur, base)).toEqual({ patch: { boardViews: { a: { n: 1 }, b: null } }, removed: [] })
    expect(cur.boardViews).toEqual({ a: { n: 1 } })
  })
  it('a deleted Agents table view goes as a null for its id, so the daemon drops it', () => {
    const base = { agentsTableCols: { main: { cols: ['role'], group: 'tree' } } }
    const cur = { agentsTableCols: {} }
    expect(buildPatch(cur, base)).toEqual({ patch: { agentsTableCols: { main: null } }, removed: [] })
  })
  it('a dropped top-level key is reported, not sent', () => {
    expect(buildPatch({ x: 1 }, { x: 1, y: 2 })).toEqual({ patch: {}, removed: ['y'] })
  })
})

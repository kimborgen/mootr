// A deferred thread stays deferred on a system notice, and comes back on mail from a person or an
// agent (S-1971). The split is the shared rule of src/defer-split.ts, which src/db.ts runs too.
import { describe, expect, it } from 'vitest'
import { splitDeferredThreads } from '../../src/defer-split.ts'

const mail = (id: string, extra: { from_id?: string; notice?: number } = {}) => ({ id, from_id: 'a1', recipients: [{ id: 'human' }], ...extra })
const thread = (id: string, ...mails: ReturnType<typeof mail>[]) => ({ thread_id: id, mails })
const recorded = (...ids: string[]) => new Map([['t1', new Set(ids)]])

describe('splitDeferredThreads', () => {
  it('keeps a deferred thread deferred on a system notice from a script or from stam', () => {
    const t = thread('t1', mail('m1'), mail('m2', { from_id: 'system:deploy', notice: 1 }), mail('m3', { from_id: 'a2', notice: 1 }))
    const { rest, deferred } = splitDeferredThreads('human', [t], recorded('m1'))
    expect(rest).toEqual([])
    expect(deferred).toEqual([t])
  })

  it('revives a deferred thread on mail from a person or an agent', () => {
    const t = thread('t1', mail('m1'), mail('m2', { from_id: 'a2' }))
    const { rest, deferred } = splitDeferredThreads('human', [t], recorded('m1'))
    expect(rest).toEqual([t])
    expect(deferred).toEqual([])
  })

  it('keeps a thread in the keep set out of the deferred list', () => {
    const t = thread('t1', mail('m1'))
    const { rest } = splitDeferredThreads('human', [t], recorded('m1'), new Set(['t1']))
    expect(rest).toEqual([t])
  })
})

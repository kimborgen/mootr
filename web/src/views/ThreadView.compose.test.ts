// @vitest-environment jsdom
// What a reply sends (S-1516): staged answers, the untouched pick blocks "as suggested", then the typed text.
import { describe, expect, it } from 'vitest'
import { composeReply } from './ThreadView'

const pick = { mailId: 'm1', key: 'm1:0', q: 'Which parts?', labels: ['Alpha', 'Gamma'] }
const choice = { kind: 'choice', mailId: 'm2', q: 'Ship it?', body: 'Chose **Yes**.', label: 'Yes' }

describe('composeReply', () => {
  it('answers an untouched pick block as suggested when the reply answers a decision, in order, before the typed text', () => {
    const r = composeReply([choice] as never, [pick], 'thanks')
    expect(r.body).toBe('> Ship it?\n\nChose **Yes**.\n\n> Which parts?\n\nPicked **Alpha**, **Gamma** (as suggested).\n\nthanks')
  })
  it('adds nothing to a plain typed reply', () => {
    expect(composeReply([], [pick], 'hi').body).toBe('hi')
  })
  it('leaves the suggestions out of a send that answers a permission, so its text stays the permission note', () => {
    const perm = [choice, { kind: 'perm', mailId: 'm3', id: 'p1', approve: true, action: 'run' }] as never
    expect(composeReply(perm, [pick], '').body).toBe('> Ship it?\n\nChose **Yes**.')
    const only = [{ kind: 'perm', mailId: 'm3', id: 'p1', approve: true, action: 'run' }] as never
    const r = composeReply(only, [pick], '')
    expect(r.body).toBe('')
    expect(r.perms).toHaveLength(1)
  })
  it('names the mails its answers are on, so the reply goes to their askers (S-1366)', () => {
    expect(composeReply([choice] as never, [pick], 'thanks').answered).toEqual(['m2', 'm1'])
    expect(composeReply([{ kind: 'itsa', mailId: 'm4', itsa: 'i1', action: 'approve', label: 'Approve' }] as never, [pick], '').answered).toEqual([])
  })
  it('adds nothing to an ITSA action, which takes the typed text as its comment', () => {
    const act = [{ kind: 'itsa', mailId: 'm4', itsa: 'i1', action: 'approve', label: 'Approve' }] as never
    expect(composeReply(act, [pick], 'ok').body).toBe('')
  })
})

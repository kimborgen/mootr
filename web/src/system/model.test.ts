import { describe, expect, it } from 'vitest'
import type { Field } from '../itsa/fields'
import type { Agent, Itsa, ItsaStatus } from '../types'
import { cardBadges, contextShare, HUMAN, itsaCounts, ownedItsa, rollupOf, stateCounts, statesOf, statusMoves, systemNodes } from './model'
import { meters, sparkPath } from './usage'

const agent = (o: Partial<Agent>): Agent => ({ id: 'a', name: 'a', harness: 'claude', lifecycle: 'active', machine: 'm', cwd: '/', created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z', ...o })
const itsa = (o: Partial<Itsa>): Itsa => ({ id: 'i', key: 'S-1', parent_id: null, kind: null, title: 't', summary: null, body: null, status: 'in_progress', owner: null, thread_id: null, created_by: 'x', created_at: '', updated_at: '', closed_at: null, ...o })
const field = (o: Partial<Field>): Field => ({ id: 'f', key: 'stage', label: 'Stage', type: 'choice', options: [{ value: 'dev', label: 'dev', tone: null }], description: null, hint: null, width: 's', align: 'start', card: 'chip', position: 0, ...o })

describe('cardBadges: the Work columns a card shows', () => {
  const it0 = itsa({
    health: 'at_risk', fields: { stage: 'dev', note: 'hello' },
    links: [{ n: 1, system: 'branch', url: 'stam/x', label: null, meta: { review: { verdict: 'approve' }, tests: { passed: 12, failed: 2 } } } as never],
  })
  const fields = [field({ id: 'f1', key: 'stage', card: 'chip' }), field({ id: 'f2', key: 'note', type: 'text', card: 'meta' })]
  const all = ['work', 'status', 'health', 'review', 'tests', 'field:f1', 'field:f2', 'cost']

  it('shows health, review, tests, and each field with a value, in the layout order', () => {
    const b = cardBadges(it0, all, fields)
    expect(b.map((x) => x.id)).toEqual(['health', 'review', 'tests', 'field:f1', 'field:f2'])
    expect(b[0]).toMatchObject({ word: 'at risk', tone: 'warn' })
    expect(b[1]).toMatchObject({ word: 'approved', tone: 'ok' })
    expect(b[2]).toMatchObject({ word: '2 failed of 14', tone: 'err' })
  })
  it('follows the order and the hidden columns of the Work layout', () => {
    expect(cardBadges(it0, ['field:f1', 'tests'], fields).map((x) => x.id)).toEqual(['field:f1', 'tests'])
  })
  it('leaves out an on-track health and a field with no value, and shows a field whatever its card setting', () => {
    const quiet = itsa({ health: 'on_track', fields: { note: 'x' } })
    expect(cardBadges(quiet, all, fields).map((x) => x.id)).toEqual(['field:f2'])
  })
})

describe('the tree and the counts', () => {
  const agents = [
    agent({ id: 'w', name: 'worker', parents: ['c'], created_at: '2026-10-13T02:00:00Z' }),
    agent({ id: 'c', name: 'cos', chief_of_staff: 1, created_at: '2026-10-13T03:00:00Z' }),
    agent({ id: 'r', name: 'root', created_at: '2026-10-13T01:00:00Z', activity: 'blocked' }),
    agent({ id: 'gone', name: 'gone', lifecycle: 'archived' }),
    agent({ id: 'p', name: 'paused', lifecycle: 'paused', parents: ['c'] }),
  ]
  it('hangs the roots from the human, chiefs of staff first, and drops archived agents', () => {
    expect(systemNodes(agents).map(({ id, parent }) => ({ id, parent }))).toEqual([
      { id: HUMAN, parent: null }, { id: 'c', parent: HUMAN }, { id: 'p', parent: 'c' }, { id: 'r', parent: HUMAN }, { id: 'w', parent: 'c' },
    ])
  })
  it("carries each agent's own spend in API dollars, for the Stars orbs", () => {
    const spent = [agent({ id: 'a', cost: { mode: 'api', own: { api: 2.5 } }, cost_usd: 9 } as never), agent({ id: 'b', cost_usd: 1.25 }), agent({ id: 'c' })]
    expect(systemNodes(spent).map((n) => n.cost)).toEqual([undefined, 2.5, 1.25, 0])
  })
  it('counts live agents by state', () => {
    expect(stateCounts(agents)).toEqual({ total: 4, by: { idle: 2, blocked: 1, paused: 1 } })
    expect(statesOf(agents)).toEqual([{ state: 'idle', n: 2 }, { state: 'blocked', n: 1 }, { state: 'paused', n: 1 }])
  })
  it('picks the owned ITSA waiting on the human first, among open ones', () => {
    const cat = (s: string) => (s === 'done' ? 'closed' : 'active')
    const human = (s: string) => s === 'needs_input'
    const list = [itsa({ id: '1', owner: 'w', status: 'done' }), itsa({ id: '2', owner: 'w' }), itsa({ id: '3', owner: 'w', status: 'needs_input' })]
    expect(ownedItsa('w', list, cat, human)).toMatchObject({ it: { id: '3' }, count: 2 })
    expect(ownedItsa('x', list, cat, human)).toBeNull()
  })
  it('counts ITSAs active, in review, and done today', () => {
    const st: ItsaStatus[] = [{ name: 'in_progress', category: 'active', human: false }, { name: 'in_review', category: 'review', human: false }, { name: 'done', category: 'closed', human: false }, { name: 'canceled', category: 'closed', human: false }]
    const now = new Date(2026, 9, 13, 15)
    const list = [itsa({ status: 'in_progress' }), itsa({ status: 'in_review' }), itsa({ status: 'done', closed_at: new Date(2026, 9, 13, 9).toISOString() }),
      itsa({ status: 'done', closed_at: new Date(2026, 9, 12, 9).toISOString() }), itsa({ status: 'canceled', closed_at: new Date(2026, 9, 13, 9).toISOString() })]
    expect(itsaCounts(list, st, now)).toEqual({ active: 1, review: 1, doneToday: 1 })
  })
  it('measures context against the compaction limit, within 0 and 1', () => {
    expect(contextShare({ context_tokens: 250 }, 500)).toBe(0.5)
    expect(contextShare({ context_tokens: 900 }, 500)).toBe(1)
    expect(contextShare({ context_tokens: null }, 500)).toBe(0)
  })
})

describe('the header instruments', () => {
  it('reads one meter per window, the week as a minor one', () => {
    const m = meters({ today: { cost_usd: 1 }, accounts: [{ account: 'claude-max', match: { harness: 'claude' }, windows: { five_hour: { used_percentage: 45 }, seven_day: { used_percentage: 46 } } }, { account: 'codex', match: { harness: 'codex' }, windows: { five_hour: { used_percentage: 88 } } }] })
    expect(m.map((x) => [x.label, x.pct, x.minor])).toEqual([['Claude 5 h', 45, false], ['week', 46, true], ['Codex 5 h', 88, false]])
  })
  it('draws the spend line in its box', () => {
    expect(sparkPath([{ cost_usd: 0 }], 72, 20)).toBe('')
    expect(sparkPath([{ cost_usd: 0 }, { cost_usd: 10 }], 72, 20)).toBe('M0.0 19.0L72.0 1.0')
  })
})

describe('ITSA motion (S-463)', () => {
  const cat = (s: string) => (s === 'done' ? 'closed' : 'active')
  it('statusMoves: the ITSAs whose status changed, and which reached done', () => {
    const prev = [itsa({ id: 'i1', status: 'in_progress', owner: 'a1', parent_id: 'p' }), itsa({ id: 'i2', status: 'in_review', owner: 'a2' })]
    const next = [itsa({ id: 'i1', status: 'done', owner: 'a1', parent_id: 'p' }), itsa({ id: 'i2', status: 'in_review', owner: 'a2' }), itsa({ id: 'i3', status: 'todo' })]
    expect(statusMoves(prev, next, 'done')).toEqual([{ id: 'i1', owner: 'a1', parent: 'p', from: 'in_progress', to: 'done', done: true }])
    expect(statusMoves(next, [itsa({ id: 'i2', status: 'ready_to_merge', owner: 'a2' })], 'done')[0]).toMatchObject({ id: 'i2', done: false })
  })
  it('rollupOf: children done of all, leaving out those whose done sheet is on its way', () => {
    const kids = [itsa({ id: 'k1', parent_id: 'p', status: 'done' }), itsa({ id: 'k2', parent_id: 'p', status: 'done' }), itsa({ id: 'k3', parent_id: 'p', status: 'in_progress' })]
    expect(rollupOf({ id: 'p' }, kids, 'done')).toEqual({ done: 2, total: 3 })
    expect(rollupOf({ id: 'p' }, kids, 'done', new Set(['k2']))).toEqual({ done: 1, total: 3 })
    expect(rollupOf({ id: 'x' }, kids, 'done')).toBeNull()
  })
  it('rollupOf: a child reopened mid-flight no longer counts against the others', () => {
    // A done before; B's sheet in the air, then B reopens: the parent shows A, not 0.
    const kids = [itsa({ id: 'A', parent_id: 'p', status: 'done' }), itsa({ id: 'B', parent_id: 'p', status: 'in_progress' })]
    expect(rollupOf({ id: 'p' }, kids, 'done', new Set(['B']))).toEqual({ done: 1, total: 2 })
    // B moved to another parent mid-flight: neither roll-up waits for it here.
    const moved = [kids[0], itsa({ id: 'B', parent_id: 'q', status: 'done' })]
    expect(rollupOf({ id: 'p' }, moved, 'done', new Set(['B']))).toEqual({ done: 1, total: 1 })
  })
  it('rollupOf: the new parent counts a reparented child once its sheet is let go (S-462)', () => {
    const moved = [itsa({ id: 'A', parent_id: 'p', status: 'done' }), itsa({ id: 'B', parent_id: 'q', status: 'done' }), itsa({ id: 'C', parent_id: 'q', status: 'todo' })]
    // While the deck still carries B (to p), q leaves it out: it is on its way.
    expect(rollupOf({ id: 'q' }, moved, 'done', new Set(['B']))).toEqual({ done: 0, total: 2 })
    // The view's dropDone lets B go, as it is no longer done under p: q counts it.
    expect(rollupOf({ id: 'q' }, moved, 'done', new Set())).toEqual({ done: 1, total: 2 })
  })
  it('rollupOf: a burst of completions waits for every sheet', () => {
    const kids = ['a', 'b', 'c', 'd'].map((id) => itsa({ id, parent_id: 'p', status: 'done' }))
    expect(rollupOf({ id: 'p' }, kids, 'done', new Set(['a', 'b', 'c']))).toEqual({ done: 1, total: 4 })
    expect(rollupOf({ id: 'p' }, kids, 'done', new Set(['c']))).toEqual({ done: 3, total: 4 })
  })
  it('ownedItsa keeps a just-done ITSA first, a moment', () => {
    const list = [itsa({ id: 'd', owner: 'a', status: 'done' }), itsa({ id: 'o', owner: 'a', status: 'in_progress' })]
    expect(ownedItsa('a', list, cat, () => false)?.it.id).toBe('o')
    expect(ownedItsa('a', list, cat, () => false, new Set(['d']))).toMatchObject({ it: { id: 'd' }, count: 2 })
  })
})

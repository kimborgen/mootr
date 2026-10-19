// The Work page's phone glance (S-301): what's moving, grouped by root issue, and what's ready
// to try, with the Needs-you rows, the backlog, and closed work left out.
import { describe, expect, it } from 'vitest'
import type { Itsa, ItsaCategory } from '../types'
import { costIndex, glance, LOOSE, rootsOf, type GlanceOptions } from './glance'

const CAT: Record<string, ItsaCategory> = {
  idea: 'backlog', backlog: 'backlog', todo: 'ready', in_progress: 'active', blocked: 'active', needs_input: 'active',
  in_review: 'review', needs_review: 'review', done: 'closed',
}
const HUMAN = new Set(['needs_input', 'needs_review'])

let n = 0
const x = (id: string, status: string, more: Partial<Itsa> = {}): Itsa => ({
  id, key: 'S-' + id, parent_id: null, kind: null, title: 'T' + id, summary: null, body: null, status, owner: null,
  thread_id: null, created_by: 'h', created_at: '', updated_at: `2026-01-01T00:00:${String(n++).padStart(2, '0')}Z`, closed_at: null, ...more,
})

const opts = (more: Partial<GlanceOptions> = {}): GlanceOptions =>
  ({ category: (s) => CAT[s] ?? 'backlog', human: (s) => HUMAN.has(s), agentState: () => undefined, needs: new Set(), ...more })

const shape = (g: ReturnType<typeof glance>) => ({ moving: g.moving.map((m) => [m.id, m.items.map((i) => i.id)]), toTry: g.toTry.map((i) => i.id) })

describe('glance', () => {
  it('groups moving work under its root, newest first, and leaves out backlog, ready, closed, and human', () => {
    const all = [
      x('R', 'todo'), x('a', 'in_progress', { parent_id: 'R' }), x('b', 'idea', { parent_id: 'R' }),
      x('c', 'blocked', { parent_id: 'a' }), x('d', 'done', { parent_id: 'R' }), x('e', 'needs_input', { parent_id: 'R' }),
    ]
    expect(shape(glance(all, opts()))).toEqual({ moving: [['R', ['c', 'a']]], toTry: [] })
  })

  it('a moving root leads its group; a moving root with nothing under it is a loose row', () => {
    const all = [x('R', 'in_progress'), x('a', 'in_progress', { parent_id: 'R' }), x('L', 'in_progress')]
    const g = glance(all, opts())
    expect(shape(g)).toEqual({ moving: [['R', ['R', 'a']], [LOOSE, ['L']]], toTry: [] })
    expect(g.moving[1].root).toBeNull()
  })

  it('leaves out what the Needs-you rows show', () => {
    const all = [x('a', 'in_progress'), x('b', 'in_review')]
    expect(shape(glance(all, opts({ needs: new Set(['a', 'b']) })))).toEqual({ moving: [], toTry: [] })
  })

  it('an ITSA with a working agent moves whatever its status, short of the backlog', () => {
    const all = [x('a', 'todo', { owner: 'kid' }), x('b', 'todo', { owner: 'idle' }), x('c', 'backlog', { owner: 'kid' }), x('d', 'idea', { participants: ['kid'] })]
    const agentState = (id: string) => ({ kid: 'working', idle: 'idle' } as Record<string, string>)[id]
    expect(shape(glance(all, opts({ agentState })))).toEqual({ moving: [[LOOSE, ['a']]], toTry: [] })
  })

  it('ready to try: in review, or open with a test link, but not from the backlog', () => {
    const test = { links: [{ n: 1, system: 'staging', external_id: null, url: 'https://staging.example.com' }] } as Partial<Itsa>
    const all = [x('r', 'in_review'), x('t', 'in_progress', test), x('i', 'idea', test), x('d', 'done', test)]
    expect(shape(glance(all, opts()))).toEqual({ moving: [], toTry: ['t', 'r'] })
  })

  it('survives a parent cycle in old data', () => {
    const all = [x('a', 'in_progress', { parent_id: 'b' }), x('b', 'in_progress', { parent_id: 'a' })]
    expect(glance(all, opts()).moving.flatMap((g) => g.items.map((i) => i.id)).sort()).toEqual(['a', 'b'])
  })
})

// The glance runs on every poll, so its work must grow with the ITSAs, not their square: a
// parent walk is memoised (a 300-deep chain costs one step per ITSA), and the agent and cost
// lookups are map hits. Counted, not timed.
describe('glance at scale', () => {
  const N = 300
  // A 300-deep chain under one root, every link in progress with two agents.
  const chain = Array.from({ length: N }, (_, i) => x('c' + i, 'in_progress', { parent_id: i ? 'c' + (i - 1) : null, owner: 'a' + i, participants: ['a' + ((i + 1) % N)] }))

  it('reads each parent once over a 300-deep chain', () => {
    let reads = 0
    const counted = chain.map((c) => { const p = c.parent_id; return Object.defineProperty({ ...c }, 'parent_id', { get: () => { reads++; return p }, enumerable: true }) as Itsa })
    const root = rootsOf(counted)
    const ids = counted.map((c) => root(c).id)
    expect(new Set(ids)).toEqual(new Set(['c0']))
    expect(reads).toBeLessThanOrEqual(2 * N)
  })

  it('looks up each agent on an ITSA at most once', () => {
    let lookups = 0
    // Ready, not active: each moves only through its agents, the last of its two working.
    const ready = chain.map((c) => ({ ...c, status: 'todo' }))
    const states = new Map(Array.from({ length: N }, (_, i) => ['a' + i, i % 2 ? 'working' : 'idle']))
    const g = glance(ready, opts({ agentState: (id) => { lookups++; return states.get(id) } }))
    expect(g.moving).toHaveLength(1)
    expect(g.moving[0].items).toHaveLength(N)
    expect(g.moving[0].items[0].id).toBe('c0')
    expect(lookups).toBeLessThanOrEqual(2 * N)
  })

  it('indexes 300 cost rows by key', () => {
    const report = { note: '', issues: Array.from({ length: N }, (_, i) => ({ key: 'S-c' + i, total: { cost_usd: i } })) } as unknown as Parameters<typeof costIndex>[0]
    const ix = costIndex(report)
    expect(ix.size).toBe(N)
    expect(ix.get('S-c299')).toBe(299)
  })
})

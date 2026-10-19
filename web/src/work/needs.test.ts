// The Work page's Needs-you group: one row per waiting thing (from useWaiting) plus each
// merge-queue ITSA, oldest first, with no ITSA listed twice.
import { describe, expect, it } from 'vitest'
import type { BranchFacts, ItsaAttention, ItsaQueueRow, Permission } from '../types'
import type { WaitingRow } from '../itsa/WaitingList'
import { attentionItsaIds, factLine, needsRows } from './needs'

const attention = (id: string, since: string): ItsaAttention => ({
  id, key: 'S-' + id, parent_id: null, kind: null, title: 'Title ' + id, summary: null, body: null, status: 'needs_review',
  owner: 'kid', thread_id: null, created_by: 'kid', created_at: since, updated_at: since, closed_at: null,
  since, actions: [{ id: 'approve', label: 'Approve', to: 'ready_to_merge', text: 'optional' }],
})

const perm: Permission = { id: 'p1', agent_id: 'kid', status: 'pending', action: 'Run the full suite', created_at: '2026-01-01T00:00:00Z' }

const wait = (key: string, since: string, more: Partial<WaitingRow> = {}): WaitingRow =>
  ({ key, who: 'kid', what: 'What', why: 'asks', since, icon: 'user', open: () => {}, ...more })

const facts = (more: Partial<BranchFacts> = {}): BranchFacts =>
  ({ repo: 'r', branch: 'b', path: '/x', head: 'abc', diff: { files: 1, insertions: 412, deletions: 38 }, mergeable: true, behind: 3, error: null, ...more })

const q = (id: string, updated_at: string, f: Partial<BranchFacts> = {}): ItsaQueueRow =>
  ({ id, key: 'S-9', title: 'Queue me', owner: 'kid', updated_at, link: { n: 2, branch: 'clean', repo: 'r' }, facts: facts(f) })

describe('needsRows', () => {
  it('lists the waiting rows and the queue, oldest first', () => {
    const rows = needsRows([
      wait('i:A', '2026-01-02T00:00:00Z', { icon: 'itsa', itsa: attention('A', '2026-01-02T00:00:00Z') }),
      wait('w:1', '2026-01-01T00:00:00Z', { perm, agent: undefined, threadId: 't1' }),
    ], [q('Q', '2026-01-03T00:00:00Z')])
    expect(rows.map((r) => [r.key, r.kind])).toEqual([['w:1', 'perm'], ['i:A', 'itsa'], ['q:Q:2', 'merge']])
  })

  it('drops a queue row whose ITSA is already a waiting row', () => {
    const a = attention('A', '2026-01-02T00:00:00Z')
    const rows = needsRows([wait('i:A', a.since, { icon: 'itsa', itsa: a })], [q('A', '2026-01-05T00:00:00Z')])
    expect(rows.map((r) => r.key)).toEqual(['i:A'])
  })

  it('an attention row keeps its ITSA and its actions', () => {
    const a = attention('A', '2026-01-02T00:00:00Z')
    const [r] = needsRows([wait('i:A', a.since, { icon: 'itsa', itsa: a })], [])
    expect(r.it).toBe(a)
    expect(r.itsaId).toBe('A')
    expect(r.actions.map((x) => x.id)).toEqual(['approve'])
  })

  it('a permission request stands in as a needs_approval row, with its thread', () => {
    const [r] = needsRows([wait('p:p1', '2026-01-01T00:00:00Z', { perm, agent: { id: 'kid', name: 'kid' } as WaitingRow['agent'], threadId: 't1' })], [])
    expect([r.kind, r.it.status, r.it.title, r.it.owner, r.threadId]).toEqual(['perm', 'needs_approval', 'What', 'kid', 't1'])
    expect(r.perm).toBe(perm)
  })

  it('an agent\u2019s human wait stands in as a needs_input row', () => {
    const agent = { id: 'kid', name: 'kid' } as WaitingRow['agent']
    const [r] = needsRows([wait('w:1', '2026-01-01T00:00:00Z', { agent })], [])
    expect([r.kind, r.it.status, r.itsaId]).toEqual(['wait', 'needs_input', null])
  })

  it('a merge row carries the branch facts and the ITSA is ready_to_merge', () => {
    const [r] = needsRows([], [q('Q', '2026-01-03T00:00:00Z')])
    expect([r.it.key, r.it.status, r.it.summary]).toEqual(['S-9', 'ready_to_merge', '+412 −38 · merges cleanly · 3 behind main'])
    expect(r.queue?.link.branch).toBe('clean')
  })

  it('attentionItsaIds names every ITSA the group covers', () => {
    const a = attention('A', '2026-01-02T00:00:00Z')
    const ids = attentionItsaIds(needsRows([wait('i:A', a.since, { icon: 'itsa', itsa: a }), wait('p:p1', '2026-01-01T00:00:00Z', { perm })], [q('Q', '2026-01-03T00:00:00Z')]))
    expect([...ids].sort()).toEqual(['A', 'Q'])
  })
})

describe('factLine', () => {
  it('says the diff, the merge, and how far behind', () => {
    expect(factLine(facts())).toBe('+412 −38 · merges cleanly · 3 behind main')
  })

  it('says a conflict, and drops a zero behind', () => {
    expect(factLine(facts({ mergeable: false, behind: 0 }))).toBe('+412 −38 · conflicts')
  })

  it('says why when the branch could not be read', () => {
    expect(factLine(facts({ error: 'no branch clean in r', diff: null, mergeable: null, behind: null }))).toBe('no branch clean in r')
  })
})

describe('the merge queue row and requirements', () => {
  it('adds the conformity line after the facts, with the hold first', () => {
    const row = { ...q('Q', '2026-01-03T00:00:00Z'), conformity: { checked: true, hold: true, lines: [{ key: 'R-7', verdict: 'violates' as const, p_violates: 0.91, mode: 'enforce', severity: 'major' }] } }
    expect(needsRows([], [row])[0].it.summary).toBe('+412 −38 · merges cleanly · 3 behind main · Merge held · R-7 likely violates 91%')
    expect(needsRows([], [q('Q', '2026-01-03T00:00:00Z')])[0].it.summary).toBe('+412 −38 · merges cleanly · 3 behind main')
  })
})

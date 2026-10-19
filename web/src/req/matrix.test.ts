// The compliance matrix's data: columns from the merge queue or an ITSA subtree, the latest verdict
// per requirement and subject (a branch's older head marked stale, waived marked), tree order, and
// obsolete requirements left out.
import { describe, expect, it } from 'vitest'
import { buildMatrix, cellFor, cellState, flaggedPerSubject, queueSubjects, subtreeSubjects } from './matrix'
import type { LatestVerdict, Requirement } from './model'

let n = 0
const v = (subject: string, verdict: LatestVerdict['verdict'], more: Partial<LatestVerdict> = {}): LatestVerdict =>
  ({ id: ++n, subject, verdict, p_violates: verdict === 'violates' ? 0.9 : 0.05, waived: null, ts: '2026-10-14T00:00:00Z', ...more })
const req = (id: string, parent: string | null, latest: LatestVerdict[] = [], more: Partial<Requirement> = {}): Requirement => ({
  id, key: 'R-' + id, parent_id: parent, level: null, title: 'T' + id, text: null, rationale: null, source: null, verification: null, scope: null,
  severity: 'minor', mode: 'inform', threshold: 0.8, status: 'in_force', owner: null, version: 1, links: [], latest, ...more,
})
const qrow = (id: string, branch: string, head: string | null) => ({
  id, key: 'S-' + id, title: 'Work ' + id, link: { n: 1, branch, repo: 'stam2' },
  facts: { repo: 'stam2', branch, path: null, head, diff: null, mergeable: null, behind: null, error: null },
})
const itsa = (id: string, parent: string | null, closed = false) => ({ id, key: 'S-' + id, title: 'I' + id, parent_id: parent, closed_at: closed ? '2026-10-13T00:00:00Z' : null })

describe('queueSubjects', () => {
  it('one column per branch in queue order, matched at its head, any head by prefix', () => {
    const s = queueSubjects([qrow('1', 'stam/a', 'abc1234'), qrow('2', 'stam/b', null), qrow('3', 'stam/a', 'abc1234')])
    expect(s.map((x) => x.id)).toEqual(['branch:stam2/stam/a', 'branch:stam2/stam/b'])
    expect(s[0]).toMatchObject({ label: 'stam/a', itsaId: '1', refs: ['branch:stam2/stam/a@abc1234'], prefix: 'branch:stam2/stam/a@' })
    expect(s[0].title).toBe('stam/a · S-1 Work 1')
    expect(s[1].refs).toEqual([])
  })
})

describe('subtreeSubjects', () => {
  it('the root first, then its open descendants depth first; closed ones below the root left out', () => {
    const xs = [itsa('1', null, true), itsa('2', '1'), itsa('3', '2'), itsa('4', '1', true), itsa('5', '4'), itsa('6', null)]
    expect(subtreeSubjects(xs, '1').map((x) => x.id)).toEqual(['itsa:S-1', 'itsa:S-2', 'itsa:S-3'])
    expect(subtreeSubjects(xs, 'S-2').map((x) => x.label)).toEqual(['S-2', 'S-3'])
    expect(subtreeSubjects(xs, '2')[0]).toMatchObject({ title: 'S-2 I2', itsaId: '2', refs: ['itsa:S-2', 'itsa:2'] })
    expect(subtreeSubjects(xs, 'nope')).toEqual([])
  })
})

describe('cellFor', () => {
  const [a] = queueSubjects([qrow('1', 'stam/a', 'new1234')])
  it('the newest verdict on the subject now wins over an older head', () => {
    const older = v('branch:stam2/stam/a@old1234', 'violates')
    const now = v('branch:stam2/stam/a@new1234', 'conforms')
    expect(cellFor([older, now], a)).toMatchObject({ id: now.id, verdict: 'conforms', stale: false })
    // Without one at the head, an older head's verdict shows, stale.
    expect(cellFor([older], a)).toMatchObject({ id: older.id, verdict: 'violates', stale: true })
    expect(cellFor([v('branch:stam2/stam/ab@new1234', 'violates')], a)).toBeNull()
    expect(cellFor(undefined, a)).toBeNull()
  })
  it('an ITSA by key or id; a waived verdict keeps its verdict, marked', () => {
    const [s] = subtreeSubjects([itsa('9', null)], '9')
    expect(cellFor([v('itsa:9', 'violates', { waived: 'false_positive' })], s)).toMatchObject({ verdict: 'violates', waived: 'false_positive', stale: false })
    expect(cellState(cellFor([v('itsa:S-9', 'na')], s))).toBe('na')
    expect(cellState(null)).toBe('none')
  })
})

describe('buildMatrix', () => {
  it('rows in tree order with depth, obsolete left out, a cell per subject', () => {
    const subjects = subtreeSubjects([itsa('1', null), itsa('2', '1')], '1')
    const reqs = [
      req('c', 'a', [v('itsa:S-2', 'violates')]),
      req('a', null, [v('itsa:S-1', 'conforms')]),
      req('b', null, [], { status: 'obsolete' }),
      req('d', 'b', [v('itsa:S-1', 'unsure')]),
    ]
    const m = buildMatrix(reqs, subjects)
    expect(m.rows.map((r) => [r.req.key, r.depth])).toEqual([['R-a', 0], ['R-c', 1]])
    expect(m.rows.map((r) => r.cells.map(cellState))).toEqual([['conforms', 'none'], ['none', 'violates']])
    expect(flaggedPerSubject(m)).toEqual([0, 1])
  })
  it('a waived or stale violation is not counted as flagged', () => {
    const subjects = queueSubjects([qrow('1', 'stam/a', 'h1')])
    const m = buildMatrix([req('a', null, [v('branch:stam2/stam/a@h0', 'violates')]), req('b', null, [v('branch:stam2/stam/a@h1', 'violates', { waived: 'accepted_deviation' })])], subjects)
    expect(flaggedPerSubject(m)).toEqual([0])
  })
})

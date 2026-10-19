// Requirements in the web: a requirement's state from its latest verdicts, the tree's roll-up
// (subtree counts of requirements in force, waived verdicts left out), the wording as an indication, the merge queue's
// conformity line, and an ITSA's linked requirements.
import { describe, expect, it } from 'vitest'
import { conformityText, linkedTo, rollups, rollupText, stateOf, verdictWord, type LatestVerdict, type Requirement } from './model'

let n = 0
const v = (verdict: LatestVerdict['verdict'], more: Partial<LatestVerdict> = {}): LatestVerdict =>
  ({ id: ++n, subject: `mail:m${n}`, verdict, p_violates: verdict === 'violates' ? 0.9 : 0.05, waived: null, ts: '2026-10-14T00:00:00Z', ...more })
const req = (id: string, parent: string | null, latest: LatestVerdict[] = [], more: Partial<Requirement> = {}): Requirement => ({
  id, key: 'R-' + id, parent_id: parent, level: null, title: 'T' + id, text: null, rationale: null, source: null, verification: null, scope: null,
  severity: 'minor', mode: 'inform', threshold: 0.8, status: 'in_force', owner: null, version: 1, links: [], latest, ...more,
})

describe('stateOf', () => {
  it('a likely violation wins, then unsure, then conforms; nothing or only n/a is unverified', () => {
    expect(stateOf([v('conforms'), v('violates'), v('unsure')])).toBe('violates')
    expect(stateOf([v('conforms'), v('unsure')])).toBe('unsure')
    expect(stateOf([v('conforms'), v('na')])).toBe('conforms')
    expect(stateOf([v('na')])).toBe('unverified')
    expect(stateOf([])).toBe('unverified')
    expect(stateOf(undefined)).toBe('unverified')
  })
  it('leaves waived verdicts out', () => {
    expect(stateOf([v('violates', { waived: 'false_positive' }), v('conforms')])).toBe('conforms')
    expect(stateOf([v('violates', { waived: 'accepted_deviation' })])).toBe('unverified')
  })
})

describe('rollups', () => {
  it('counts each subtree, itself included, by state', () => {
    const tree = [
      req('1', null),
      req('2', '1', [v('violates')]),
      req('3', '1', [v('conforms')]),
      req('4', '3', [v('unsure')]),
      req('5', null, [v('conforms')]),
    ]
    const r = rollups(tree)
    expect(r.get('1')).toEqual({ conforms: 1, violates: 1, unsure: 1, unverified: 1 })
    expect(r.get('3')).toEqual({ conforms: 1, violates: 0, unsure: 1, unverified: 0 })
    expect(r.get('4')).toEqual({ conforms: 0, violates: 0, unsure: 1, unverified: 0 })
    expect(r.get('5')).toEqual({ conforms: 1, violates: 0, unsure: 0, unverified: 0 })
  })
  it('counts only requirements in force: a draft or suspended child adds nothing to its parent', () => {
    const r = rollups([req('1', null, [v('conforms')]), req('2', '1', [v('violates')], { status: 'draft' }), req('3', '1', [v('violates')], { status: 'suspended' })])
    expect(r.get('1')).toEqual({ conforms: 1, violates: 0, unsure: 0, unverified: 0 })
    expect(r.get('2')).toEqual({ conforms: 0, violates: 0, unsure: 0, unverified: 0 })
  })
  it('leaves obsolete requirements out, survives a cycle, and roots an orphan', () => {
    const r = rollups([req('a', 'b', [v('violates')]), req('b', 'a'), req('c', null, [], { status: 'obsolete' }), req('d', 'gone', [v('conforms')])])
    expect(r.get('c')).toEqual({ conforms: 0, violates: 0, unsure: 0, unverified: 0 })
    expect(r.get('d')?.conforms).toBe(1)
    expect((r.get('a')?.violates ?? 0) + (r.get('a')?.unverified ?? 0)).toBe(2)
  })
  it('says the counts in words, as likely', () => {
    expect(rollupText({ conforms: 2, violates: 1, unsure: 0, unverified: 0 })).toBe('2 likely conform · 1 likely violates')
  })
})

describe('words', () => {
  it('words a verdict as an indication, never as fact', () => {
    expect(verdictWord('violates', 0.91)).toBe('likely violates 91%')
    expect(verdictWord('conforms')).toBe('likely conforms')
    expect(verdictWord('na')).toBe('likely not applicable')
    for (const x of ['violates', 'conforms', 'na', 'unsure'] as const) expect(verdictWord(x, 0.5)).not.toMatch(/^(violates|conforms)/)
  })
  it('the merge queue line names likely violations and the hold', () => {
    expect(conformityText(null)).toBe('')
    expect(conformityText({ checked: false, lines: [], hold: false })).toBe('requirements not checked')
    const lines = [
      { key: 'R-7', verdict: 'violates' as const, p_violates: 0.91, mode: 'enforce', severity: 'major' },
      { key: 'R-8', verdict: 'conforms' as const, p_violates: 0.02, mode: 'inform', severity: 'minor' },
      { key: 'R-9', verdict: 'unsure' as const, p_violates: 0.6, mode: 'inform', severity: 'minor' },
    ]
    expect(conformityText({ checked: true, lines, hold: true })).toBe('Merge held · R-7 likely violates 91% · 1 unsure · 1 likely conforms')
    expect(conformityText({ checked: true, lines: lines.slice(1, 2), hold: false })).toBe('1 likely conforms')
  })
})

describe('linkedTo', () => {
  it('lists the requirements linked to an ITSA, by key or id, with their latest verdict on it', () => {
    const on = v('violates', { subject: 'itsa:S-4' })
    const reqs = [
      req('10', null, [v('conforms'), on], { key: 'R-10', links: [{ id: 1, target_kind: 'itsa', target: 'S-4', role: 'allocated_to' }] }),
      req('2', null, [], { key: 'R-2', links: [{ id: 2, target_kind: 'itsa', target: 'i4', role: 'implements' }] }),
      req('3', null, [], { key: 'R-3', links: [{ id: 3, target_kind: 'itsa', target: 'S-5', role: 'implements' }] }),
    ]
    const rows = linkedTo({ id: 'i4', key: 'S-4' }, reqs)
    expect(rows.map((r) => [r.req.key, r.role, r.verdict?.id ?? null])).toEqual([['R-2', 'implements', null], ['R-10', 'allocated_to', on.id]])
  })
})

describe('subject labels', () => {
  it('a branch by its name, a pasted text never by its hash, the daemon\'s label first', async () => {
    const { subjectLabel, verdictLabel } = await import('./model')
    expect(subjectLabel('branch:stam2/stam/req-ui@abc1234')).toBe('stam/req-ui')
    expect(subjectLabel('branch:stam2/stam/req-ui')).toBe('stam/req-ui')
    expect(subjectLabel('text:0123abcd')).toBe('pasted text')
    expect(subjectLabel('mail:m12')).toBe('mail:m12')
    expect(verdictLabel({ subject: 'mail:m12', label: 'Deploy plan' })).toBe('Deploy plan')
    expect(verdictLabel({ subject: 'text:0123abcd', label: '' })).toBe('pasted text')
  })
})

// The process editor's model (S-1083): add, connect, delete, validate, and the YAML round trip.
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { parseProcessText } from '../../../src/process-validate.ts'
import {
  addEdge, addLane, addNode, changed, deleteEdge, deleteLane, deleteNode, diffLines, draftFrom, hunks, mergeIntoSource,
  renameNode, setKind, toYaml, updateEdge, updateLane, updateNode, validate,
} from './edit'
import { DEV_CHANGE } from './fixture'

const STATUSES = ['in_progress', 'in_review', 'needs_approval', 'ready_to_merge', 'merging', 'deploying', 'todo', 'done']
const SMALL = `# A small process
process: small
title: Small
lanes:
  human: { type: human }   # the person
  dev: { type: developer, label: Developer }
nodes:
  begin:
    kind: start
    lane: human
    triggers:
      - { source: manual }
  work:
    kind: agent
    lane: dev
    label: Do the work   # the step
    statuses: [in_progress]
  fin:
    kind: end
    lane: dev
    status: done
edges:
  - [begin, work]
  - [work, fin, { when: ok, label: fine }]
`

const small = () => {
  const { process, errors } = parseProcessText(SMALL, { file: 'small.yaml', knownStatuses: new Set(STATUSES) })
  expect(errors).toEqual([])
  return draftFrom({ ...process!, nodes: Object.fromEntries(Object.entries(process!.nodes).map(([k, n]) => [k, n])) } as never)
}

describe('round trip', () => {
  it('writes a draft the loader reads back as the same process', () => {
    const d = small()
    const again = parseProcessText(toYaml(d), { file: 'small.yaml', knownStatuses: new Set(STATUSES) })
    expect(again.errors).toEqual([])
    expect(again.process!.edges).toEqual(d.edges)
    expect(Object.keys(again.process!.nodes)).toEqual(['begin', 'work', 'fin'])
  })

  it('writes a served process as a valid file, edges on one line', () => {
    const d = draftFrom(DEV_CHANGE)
    const text = toYaml(d)
    expect(parse(text).process).toBe('dev-change')
    expect(text).toMatch(/- \[request, [a-z-]+\]/)
    expect(validate(d, STATUSES)).toEqual([])
  })
})

describe('changes', () => {
  it('adds a node that starts valid, in a fresh id', () => {
    const d = small()
    const a = addNode(d, 'human', 'human', 'Approve it')
    expect(a.id).toBe('approve-it')
    expect(a.draft.nodes['approve-it']).toMatchObject({ kind: 'human', lane: 'human', ask: 'approve' })
    const b = addNode(a.draft, 'human', 'human', 'Approve it')
    expect(b.id).toBe('approve-it-2')
    expect(validate(addNode(d, 'end', 'dev').draft, STATUSES)).toEqual([])
    expect(validate(addNode(d, 'start', 'human').draft, STATUSES)).toEqual([])
    expect(d.nodes['approve-it']).toBeUndefined()
  })

  it('connects two nodes once, and refuses a self loop or a repeat', () => {
    const d = small()
    expect(addEdge(d, 'begin', 'fin').edges).toHaveLength(3)
    expect(addEdge(d, 'begin', 'work')).toBe(d)
    expect(addEdge(d, 'work', 'work')).toBe(d)
    expect(addEdge(d, 'work', 'nowhere')).toBe(d)
  })

  it('edits an edge, and drops an emptied when or label', () => {
    const d = updateEdge(small(), 1, { when: '', label: 'ok' })
    expect(d.edges[1]).toEqual({ from: 'work', to: 'fin', label: 'ok' })
    expect(deleteEdge(d, 1).edges).toHaveLength(1)
  })

  it('deletes a node with its edges', () => {
    const d = deleteNode(small(), 'work')
    expect(Object.keys(d.nodes)).toEqual(['begin', 'fin'])
    expect(d.edges).toEqual([])
  })

  it('renames a node through its edges, and refuses a taken or bad id', () => {
    const d = renameNode(small(), 'work', 'build')
    expect(d.edges.map((e) => [e.from, e.to])).toEqual([['begin', 'build'], ['build', 'fin']])
    expect(Object.keys(d.nodes)).toEqual(['begin', 'build', 'fin'])
    const s = small()
    expect(renameNode(s, 'work', 'fin')).toBe(s)
    expect(renameNode(s, 'work', 'Bad Id')).toBe(s)
  })

  it('keeps a renamed node\'s own id in step with its key', () => {
    const d = small()
    d.nodes.work.id = 'work'
    expect(renameNode(d, 'work', 'build').nodes.build.id).toBe('build')
  })

  it('changes a kind and drops the fields of the old one', () => {
    const d = setKind(setKind(small(), 'fin', 'human'), 'fin', 'script')
    expect(d.nodes.fin.status).toBeUndefined()
    expect(d.nodes.fin.ask).toBeUndefined()
    expect(updateNode(d, 'fin', { run: 'x.sh' }).nodes.fin.run).toBe('x.sh')
  })

  it('adds, edits, and deletes a lane', () => {
    const a = addLane(small(), 'reviewer', 'Reviewer')
    expect(a.key).toBe('reviewer')
    const b = updateLane(a.draft, 'reviewer', { fallback: 'cos', machine: 'storage' })
    expect(b.lanes.reviewer).toEqual({ type: 'reviewer', label: 'Reviewer', fallback: 'cos', machine: 'storage' })
    expect(updateLane(b, 'reviewer', { fallback: '' }).lanes.reviewer.fallback).toBeUndefined()
    expect(deleteLane(b, 'reviewer').lanes.reviewer).toBeUndefined()
  })
})

describe('validation', () => {
  it('has no errors for a good draft', () => {
    expect(validate(small(), STATUSES)).toEqual([])
  })

  it('marks a node whose lane was deleted', () => {
    const issues = validate(deleteLane(small(), 'dev'), STATUSES)
    expect(issues.map((i) => i.node)).toContain('work')
    expect(issues.some((i) => /unknown lane "dev"/.test(i.message))).toBe(true)
  })

  it('marks a start node with an incoming edge, and an end with an outgoing one', () => {
    const a = validate(addEdge(small(), 'fin', 'begin'), STATUSES)
    expect(a.map((i) => i.node).sort()).toEqual(['begin', 'fin'])
  })

  it('marks an unknown status and a status on two nodes', () => {
    const a = validate(updateNode(small(), 'work', { statuses: ['nope'] }), STATUSES)
    expect(a).toEqual([{ message: 'node "work": unknown ITSA status "nope"', node: 'work' }])
    const b = validate(updateNode(small(), 'fin', { statuses: ['in_progress'] }), STATUSES)
    expect(b.map((i) => i.node)).toEqual(['fin'])
  })

  it('marks the node a field is missing on', () => {
    const d = updateNode(small(), 'begin', { triggers: [] })
    expect(validate(d, STATUSES)).toEqual([{ message: 'start node "begin" needs at least one trigger', node: 'begin' }])
    expect(validate(updateNode(small(), 'fin', { status: undefined }), STATUSES)[0].node).toBe('fin')
  })

  it('marks the edge to a node that is not there', () => {
    const d = { ...small(), edges: [...small().edges, { from: 'work', to: 'gone' }] }
    const issues = validate(d, STATUSES)
    expect(issues).toEqual([{ message: 'edge work -> gone: unknown node "gone"', edge: 2 }])
  })

  it('is the loader\'s own check: the same messages for the same file', () => {
    const d = updateNode(small(), 'work', { lane: 'ghost' })
    const loader = parseProcessText(toYaml(d), { file: 'small.yaml', knownStatuses: new Set(STATUSES) }).errors
    expect(validate(d, STATUSES).map((i) => `small.yaml: ${i.message}`)).toEqual(loader)
  })
})

describe('against the registry', () => {
  it('marks a lane type or fallback the registry does not know', () => {
    const types = new Set(['developer', 'human'])
    expect(validate(small(), STATUSES, types)).toEqual([])
    const a = validate(updateLane(small(), 'dev', { type: 'developr' }), STATUSES, types)
    expect(a).toEqual([{ message: 'lane "dev": unknown agent type "developr"', lane: 'dev' }])
    const b = validate(updateLane(small(), 'dev', { fallback: 'nobody' }), STATUSES, types)
    expect(b.map((i) => i.lane)).toEqual(['dev'])
    expect(validate(updateLane(small(), 'dev', { type: 'developr' }), STATUSES)).toEqual([])
  })
})

describe('call targets', () => {
  it('marks a call to a process that is not loaded', () => {
    const d = updateNode(small(), 'work', { call: 'ghost' })
    expect(validate(d, STATUSES, undefined, ['small', 'other'])).toEqual([{ message: 'node "work": call "ghost" is not a loaded process', node: 'work' }])
    expect(validate(updateNode(small(), 'work', { call: 'other' }), STATUSES, undefined, ['small', 'other'])).toEqual([])
    expect(validate(d, STATUSES)).toEqual([])
  })
})

describe('the diff', () => {
  it('shows nothing for no change, and the added lines for an added node', () => {
    const d = small()
    const base = toYaml(d)
    expect(changed(diffLines(base, toYaml(d)))).toBe(false)
    const lines = diffLines(base, toYaml(addNode(d, 'script', 'dev', 'Run it').draft))
    expect(lines.filter((l) => l.kind === 'del')).toEqual([])
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.text)).toContain('  run-it:')
  })

  it('shows a rename as a delete and an add, with hunks cut to the context', () => {
    const base = toYaml(small())
    const lines = diffLines(base, toYaml(updateNode(small(), 'work', { label: 'Build' })))
    expect(lines.filter((l) => l.kind !== 'same').map((l) => `${l.kind}:${l.text.trim()}`)).toEqual(['del:label: Do the work', 'add:label: Build'])
    const cut = hunks(lines, 1)
    expect(cut.length).toBeLessThan(lines.length)
    expect(cut.some((l) => l.text === '…')).toBe(true)
  })
})

describe('merging into the source', () => {
  it('keeps the comments of what did not change', () => {
    const out = mergeIntoSource(SMALL, updateNode(small(), 'fin', { label: 'Finish' }))
    expect(out).toContain('# A small process')
    expect(out).toContain('# the person')
    expect(out).toContain('# the step')
    expect(parse(out).nodes.fin.label).toBe('Finish')
  })

  it('adds a node and an edge, and removes a deleted node', () => {
    const a = addNode(small(), 'script', 'dev', 'Run it')
    const withEdge = addEdge(a.draft, 'work', a.id)
    const out = mergeIntoSource(SMALL, withEdge)
    expect(parse(out).nodes['run-it'].kind).toBe('script')
    expect(parse(out).edges).toContainEqual(['work', 'run-it'])
    expect(out).toContain('# the step')
    const gone = mergeIntoSource(SMALL, deleteNode(small(), 'work'))
    expect(parse(gone).nodes.work).toBeUndefined()
    expect(parseProcessText(out, { file: 'small.yaml', knownStatuses: new Set(STATUSES) }).errors).toEqual([])
  })

  it('changes nothing for an unchanged draft', () => {
    expect(mergeIntoSource(SMALL, small())).toBe(SMALL)
  })
})

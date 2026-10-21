// The Agents table's lines (S-1432): the sidebar's tree order and folds, the groupings, the sort among siblings,
// and the columns the human picks.
import { beforeAll, describe, expect, it } from 'vitest'
import { ALL_COLS, SCOPES, buildLines, factsOf, nextSort, orderOf, sanitizeCols, sanitizeGroup, activityOf, sanitizeScope, scopeAgents, scopeCounts, sortValue, toggleCol, whenOf, type Group, type Line, type Scope } from './agents-table'
import { stateLabel } from './format'
import { setData } from './store'
import { agent } from './stories/fixtures'
import type { Agent, Itsa } from './types'

const itsa = (id: string, key: string, owner: string | null, status = 'in_progress'): Itsa => ({
  id, key, title: 'Fixture ' + key, status, owner, parent_id: null, kind: 'issue', summary: null, body: null, created_by: 'fx', thread_id: null,
  created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:00:00.000Z', closed_at: null,
} as unknown as Itsa)

const cost = (own: number) => ({ mode: 'api' as const, own: { api: own, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, tree: { api: own, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } })
// cos > mgr > dev, and cos > solo; dev also has mgr2 as a second parent (so it shows twice).
const FLEET: Agent[] = [
  agent({ id: 'cos', name: 'fixture-cos', chief_of_staff: true, created_at: '2026-10-01T09:00:00.000Z' }),
  agent({ id: 'mgr', name: 'fixture-mgr', parents: ['cos'], created_at: '2026-10-01T09:01:00.000Z' }),
  agent({ id: 'mgr2', name: 'fixture-mgr2', parents: ['cos'], created_at: '2026-10-01T09:02:00.000Z', machine: 'box-two' }),
  agent({ id: 'dev', name: 'fixture-dev', parents: ['mgr', 'mgr2'], created_at: '2026-10-01T09:03:00.000Z', machine: 'box-two', cost: cost(4) }),
  agent({ id: 'solo', name: 'fixture-solo', parents: ['cos'], created_at: '2026-10-01T09:04:00.000Z', cost: cost(9) }),
]
// Stopped and archived agents (S-2937), beside the fleet; one live agent is waiting on a timer.
const GONE: Agent[] = [
  agent({ id: 'off', name: 'fixture-off', lifecycle: 'shut_down', created_at: '2026-10-01T08:00:00.000Z', updated_at: '2026-10-05T08:00:00.000Z' }),
  agent({ id: 'arc', name: 'fixture-arc', lifecycle: 'archived', created_at: '2026-10-01T07:00:00.000Z', updated_at: '2026-10-06T08:00:00.000Z' }),
  agent({ id: 'wait', name: 'fixture-wait', waits: [{ id: 'w', kind: 'timer', since: '2026-10-01T09:00:00.000Z', source: 'wait_for' } as never], created_at: '2026-10-01T09:05:00.000Z' }),
]
const WORLD = [...FLEET, ...GONE]

// The statuses' categories come from the daemon; a closed one (done) leaves the ITSA out of the groups.
beforeAll(() => setData({ itsaStatuses: [{ name: 'in_progress', category: 'active', human: false }, { name: 'done', category: 'closed', human: false }] } as never))

const ids = (lines: Line[]) => lines.map((l) => (l.kind === 'agent' ? (l.dup ? l.agent.id + '*' : l.agent.id) : '#' + l.label))
const opts = (o: Partial<{ group: Group; query: string; sort: { col: 'name' | 'cost'; dir: 'asc' | 'desc' } | null; collapsed: Record<string, boolean>; scope: Scope }> = {}) =>
  ({ group: 'tree', query: '', sort: null, collapsed: {}, ...o }) as Parameters<typeof buildLines>[2]

describe('the columns and the view', () => {
  it('shows every column when nothing is stored, and keeps the order a list was picked in', () => {
    expect(sanitizeCols(undefined)).toEqual(ALL_COLS)
    expect(sanitizeCols(['cost', 'role', 'cost', 'nope'])).toEqual(['cost', 'role'])
    expect(sanitizeCols([])).toEqual([])
  })

  it('appends a picked column and removes a picked one', () => {
    expect(toggleCol(['cost', 'role'], 'age')).toEqual(['cost', 'role', 'age'])
    expect(toggleCol(['cost', 'role'], 'cost')).toEqual(['role'])
  })

  it('reads an unknown grouping as the tree', () => {
    expect(sanitizeGroup('machine')).toBe('machine')
    expect(sanitizeGroup('by-colour')).toBe('tree')
  })

  it('cycles a header through ascending, descending and no sort', () => {
    const asc = nextSort(null, 'cost')
    expect(asc).toEqual({ col: 'cost', dir: 'asc' })
    expect(nextSort(asc, 'cost')).toEqual({ col: 'cost', dir: 'desc' })
    expect(nextSort({ col: 'cost', dir: 'desc' }, 'cost')).toBeNull()
    expect(nextSort(asc, 'name')).toEqual({ col: 'name', dir: 'asc' })
  })
})

describe('the tree', () => {
  it('shows the sidebar order, children under their parent, and an agent with two parents under each', () => {
    const f = factsOf(FLEET, [], 'fixture-machine')
    expect(ids(buildLines(FLEET, f, opts()))).toEqual(['cos', 'mgr', 'dev', 'mgr2', 'dev*', 'solo'])
  })

  it('hides the children of a folded agent', () => {
    const f = factsOf(FLEET, [], 'fixture-machine')
    // With mgr folded, dev is first placed under mgr2, so it isn't a second place.
    expect(ids(buildLines(FLEET, f, opts({ collapsed: { mgr: true } })))).toEqual(['cos', 'mgr', 'mgr2', 'dev', 'solo'])
  })

  it('keeps a parent of a matching child, and drops an agent that matches nothing', () => {
    const f = factsOf(FLEET, [], 'fixture-machine')
    expect(ids(buildLines(FLEET, f, opts({ query: 'DEV' })))).toEqual(['cos', 'mgr', 'dev', 'mgr2', 'dev*'])
  })

  it('sorts among siblings when a column is sorted, and keeps the tree', () => {
    const f = factsOf(FLEET, [], 'fixture-machine')
    // Costliest first among each parent's children: solo, then the two managers (no cost, by name), then dev under mgr.
    expect(ids(buildLines(FLEET, f, opts({ sort: { col: 'cost', dir: 'desc' } })))).toEqual(['cos', 'solo', 'mgr', 'dev', 'mgr2', 'dev*'])
  })
})

describe('the groupings', () => {
  it('groups by machine, this machine first, each group under its own line', () => {
    const f = factsOf(FLEET, [], 'fixture-machine')
    const lines = buildLines(FLEET, f, opts({ group: 'machine' }))
    expect(ids(lines)).toEqual(['#fixture-machine', 'cos', 'mgr', 'solo', '#box-two', 'mgr2', 'dev'])
  })

  it('groups by ITSA, the agents with none last', () => {
    const itsas = [itsa('i1', 'S-1', 'dev'), itsa('i2', 'S-2', 'cos', 'done')]
    const f = factsOf(FLEET, itsas, 'fixture-machine')
    const lines = buildLines(FLEET, f, opts({ group: 'itsa' }))
    const groups = lines.filter((l) => l.kind === 'group').map((l) => (l.kind === 'group' ? l.label : ''))
    expect(groups).toEqual(['S-1 Fixture S-1', 'Not in an ITSA'])
    expect(orderOf(lines)).toEqual(['dev', 'cos', 'mgr', 'mgr2', 'solo'])
  })

  it('flattens every agent, sorted by cost when asked', () => {
    const f = factsOf(FLEET, [], 'fixture-machine')
    expect(ids(buildLines(FLEET, f, opts({ group: 'flat', sort: { col: 'cost', dir: 'desc' } })))).toEqual(['solo', 'dev', 'cos', 'mgr', 'mgr2'])
  })

  it('sorts Activity by the text the cell shows, the state label when there is no detail', () => {
    const f = factsOf([], [], 'fixture-machine')
    const detailed = agent({ id: 'sv-a', name: 'sv-a', activity_detail: 'zz waiting' })
    const bare = agent({ id: 'sv-b', name: 'sv-b', activity_detail: null })
    expect(sortValue('activity', detailed, f)).toBe('zz waiting')
    expect(sortValue('activity', bare, f)).toBe(stateLabel(bare))
  })

  it('lists each agent once for the keyboard, even when it shows twice in the tree', () => {
    const f = factsOf(FLEET, [], 'fixture-machine')
    expect(orderOf(buildLines(FLEET, f, opts()))).toEqual(['cos', 'mgr', 'dev', 'mgr2', 'solo'])
  })
})

describe('the scopes (S-2937)', () => {
  it('reads an unknown scope as Live', () => {
    expect(SCOPES.map((x) => x.id)).toEqual(['live', 'waiting', 'stopped', 'archived'])
    expect(sanitizeScope('archived')).toBe('archived')
    expect(sanitizeScope('everything')).toBe('live')
  })

  it('lists the live tree for Live, the top-waiting live agents for Waiting, and each lifecycle for Stopped and Archived', () => {
    expect(scopeAgents(WORLD, 'live').map((a) => a.id)).not.toContain('arc')
    expect(scopeAgents(WORLD, 'waiting').map((a) => a.id)).toEqual(['wait'])
    expect(scopeAgents(WORLD, 'stopped').map((a) => a.id)).toEqual(['off'])
    expect(scopeAgents(WORLD, 'archived').map((a) => a.id)).toEqual(['arc'])
  })

  it('counts each chip, with Live as the running agents whatever the scope', () => {
    expect(scopeCounts(WORLD)).toEqual({ live: 6, waiting: 1, stopped: 1, archived: 1 })
  })

  it('counts a live agent with a permission request open as waiting, and not a stopped one', () => {
    const asking = agent({ id: 'ask', name: 'fixture-ask', pending_requests: 1, created_at: '2026-10-01T09:06:00.000Z' })
    const stoppedAsking = agent({ id: 'off-ask', name: 'fixture-off-ask', lifecycle: 'shut_down', pending_requests: 1 })
    expect(scopeAgents([...GONE, asking, stoppedAsking], 'waiting').map((x) => x.id)).toEqual(['wait', 'ask'])
  })

  it('shows archived as the activity, whatever a stale detail says', () => {
    const f = factsOf([], [], 'fixture-machine')
    const stale = agent({ id: 'stale', name: 'fixture-stale', lifecycle: 'archived', activity_detail: 'Editing a file' })
    expect(activityOf(stale)).toBe('archived')
    expect(sortValue('activity', stale, f)).toBe('archived')
  })

  it('lists a thousand archived agents once each, and finds one by its name', () => {
    const many = Array.from({ length: 1000 }, (_, i) => agent({ id: `ar-${i}`, name: `fixture-archived-${i}`, lifecycle: 'archived', parents: i ? ['ar-0'] : [] }))
    const f = factsOf(many, [], 'fixture-machine')
    const all = buildLines(many, f, opts({ scope: 'archived' }))
    expect(all).toHaveLength(1000)
    expect(orderOf(all)).toHaveLength(1000)
    const one = buildLines(many, f, opts({ scope: 'archived', query: 'archived-999' }))
    expect(ids(one)).toEqual(['ar-0', 'ar-999'])
  })

  it('lists the stopped and archived agents in the table, with the time they changed as their age', () => {
    const f = factsOf(WORLD, [], 'fixture-machine')
    expect(ids(buildLines(WORLD, f, opts({ scope: 'archived', group: 'flat' })))).toEqual(['arc'])
    expect(whenOf(GONE[1])).toBe('2026-10-06T08:00:00.000Z')
    expect(whenOf(FLEET[0])).toBe(FLEET[0].created_at)
    expect(sortValue('age', GONE[1], f)).toBe(Date.parse('2026-10-06T08:00:00.000Z'))
  })
})

// A paused epic rolls up as waiting on the Work page (S-4103): in_progress, every open child todo or
// backlog, and its owner idle for a day. Display only: the stored status and sort keep in_progress.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { setData } from '../store'
import type { Agent, Itsa } from '../types'
import { WORK_COLUMNS, type CellContext } from './columns'
import { pausedEpic } from './paused'

const NOW = Date.parse('2026-10-25T15:50:00Z')
const DAY_AGO = '2026-10-24T15:00:00Z'
const HOUR_AGO = '2026-10-25T14:50:00Z'
const STATUSES = [
  { name: 'backlog', category: 'backlog', human: false }, { name: 'todo', category: 'ready', human: false },
  { name: 'in_progress', category: 'active', human: false }, { name: 'waiting', category: 'active', human: false },
  { name: 'in_review', category: 'review', human: false }, { name: 'done', category: 'closed', human: false },
]
const category = (s: string) => STATUSES.find((x) => x.name === s)!.category as never
const mk = (id: string, status: string, parent_id: string | null = null): Itsa =>
  ({ id, key: `S-${id}`, title: id, summary: null, status, owner: id === 'epic' ? 'a1' : null, parent_id, participants: [], links: [], fields: {}, updated_at: '2026-10-19T00:00:00Z' }) as unknown as Itsa
const owner = (idle_since: string | null) => ({ id: 'a1', name: 'oss-mgr', harness: 'claude', lifecycle: 'active', machine: 'm', cwd: '/', activity: idle_since ? 'idle' : 'working', idle_since }) as unknown as Agent
const tree = (...kids: string[]) => [mk('epic', 'in_progress'), ...kids.map((s, i) => mk(`c${i}`, s, 'epic'))]

describe('pausedEpic', () => {
  const paused = (all: Itsa[], idle: string | null) => pausedEpic(all[0], all, owner(idle), NOW, category)
  it('every open child todo or backlog, owner idle a day: waiting', () => {
    expect(paused(tree('todo', 'backlog', 'done'), DAY_AGO)).toBe(true)
  })
  it('an active or review child keeps it', () => {
    expect(paused(tree('todo', 'in_progress'), DAY_AGO)).toBe(false)
    expect(paused(tree('backlog', 'in_review'), DAY_AGO)).toBe(false)
  })
  it('an owner active within the day, or working, keeps it', () => {
    expect(paused(tree('todo'), HOUR_AGO)).toBe(false)
    expect(paused(tree('todo'), null)).toBe(false)
    expect(pausedEpic(tree('todo')[0], tree('todo'), undefined, NOW, category)).toBe(false)
  })
  it('no open child, or not in_progress, keeps it', () => {
    expect(paused(tree('done'), DAY_AGO)).toBe(false)
    expect(paused(tree(), DAY_AGO)).toBe(false)
    const all = tree('todo'); all[0] = { ...all[0], status: 'todo' }
    expect(paused(all, DAY_AGO)).toBe(false)
  })
})

describe('the status cell', () => {
  const col = WORK_COLUMNS.find((c) => c.id === 'status')!
  const cx = { now: NOW, extras: { costs: null, activity: null, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 } } as unknown as CellContext
  const cell = (all: Itsa[]) => renderToStaticMarkup(<>{col.render({ it: all[0], depth: 0, context: false }, cx)}</>)
  const load = (all: Itsa[], idle: string | null) => setData({ itsas: all, agents: [owner(idle)], itsaStatuses: STATUSES } as never)
  beforeEach(() => setData({ itsas: [], agents: [] } as never))

  it('shows a paused epic as waiting, with why, and sorts it by its stored status', () => {
    const all = tree('todo', 'backlog')
    load(all, DAY_AGO)
    const html = cell(all)
    expect(html).toContain('>waiting</span>')
    expect(html).toContain('data-paused')
    expect(col.sortValue!({ it: all[0], depth: 0, context: false }, cx)).toContain('in_progress')
  })
  it('leaves one with an active child, or a recently active owner, as in progress', () => {
    let all = tree('todo', 'in_progress')
    load(all, DAY_AGO)
    expect(cell(all)).toContain('>in progress</span>')
    all = tree('todo')
    load(all, HOUR_AGO)
    expect(cell(all)).toContain('>in progress</span>')
    expect(cell(all)).not.toContain('data-paused')
  })
})

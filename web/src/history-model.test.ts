import { describe, expect, it } from 'vitest'
import { drop, emptyHistory, HISTORY_MAX, settle, skipDead, step, visit, type HistoryState } from './history-model'

const keys = (s: HistoryState) => s.entries.map((e) => e.key)
const run = (...ks: string[]) => ks.reduce((s, k, i) => visit(s, k, i), emptyHistory())

describe('the sidebar history model', () => {
  it('a visit goes on top and becomes the marker', () => {
    const s = run('a', 'b', 'c')
    expect(keys(s)).toEqual(['a', 'b', 'c'])
    expect(s.marker).toBe(2)
  })
  it('the same thing again adds nothing, and a changed view updates the entry in place', () => {
    const s = run('a', 'b')
    expect(visit(s, 'b', 1)).toBe(s)
    const moved = visit(s, 'b', 5)
    expect(keys(moved)).toEqual(['a', 'b'])
    expect(moved.entries[1].pos).toBe(5)
  })
  it('back moves the marker down and forward up, and the list stays', () => {
    let s = run('a', 'b', 'c')
    s = settle(s, 'b', 1)
    expect(s.marker).toBe(1)
    s = settle(s, 'a', 0)
    expect(s.marker).toBe(0)
    s = settle(s, 'b', 1)
    expect(keys(s)).toEqual(['a', 'b', 'c'])
    expect(s.marker).toBe(1)
  })
  it('a visit after going back prunes the entries above the marker, then goes on top', () => {
    const s = visit(settle(run('a', 'b', 'c'), 'a', 0), 'd', 1)
    expect(keys(s)).toEqual(['a', 'd'])
    expect(s.marker).toBe(1)
  })
  it('a jump to a row is the same as back N times: the browser lands on its position', () => {
    const s = settle(run('a', 'b', 'c', 'd'), 'b', 1)
    expect(s.marker).toBe(1)
    expect(keys(s)).toEqual(['a', 'b', 'c', 'd'])
  })
  it('a thing visited twice settles on the entry nearest the browser position', () => {
    const s = run('a', 'b', 'a')
    expect(settle(s, 'a', 0).marker).toBe(0)
    expect(settle(s, 'a', 2).marker).toBe(2)
  })
  it('keeps at most 50 entries, dropping the oldest', () => {
    const s = run(...Array.from({ length: HISTORY_MAX + 5 }, (_, i) => 'k' + i))
    expect(s.entries).toHaveLength(HISTORY_MAX)
    expect(s.entries[0].key).toBe('k5')
    expect(s.marker).toBe(HISTORY_MAX - 1)
  })
  it('a thing older than the whole list goes at the bottom', () => {
    const s = settle(visit(visit(emptyHistory(), 'b', 4), 'c', 5), 'a', 3)
    expect(keys(s)).toEqual(['a', 'b', 'c'])
    expect(s.marker).toBe(0)
  })
  it('step skips dead entries and finds none past the ends', () => {
    const s = run('a', 'b', 'c', 'd')
    const alive = (k: string) => k !== 'b' && k !== 'c'
    expect(step(s, -1, alive)).toBe(0)
    expect(step(s, -1, alive, 3)).toBe(0)
    expect(step(s, 1, alive, 0)).toBe(3)
    expect(step(s, 1, alive)).toBe(-1)
  })
  it('a push that is not a new visit drops the entries the browser dropped', () => {
    const back = settle(run('a', 'b', 'c'), 'a', 0)
    const s = drop(back, 1)
    expect(keys(s)).toEqual(['a'])
    expect(s.marker).toBe(0)
    expect(drop(run('a', 'b'), 5)).toEqual(run('a', 'b'))
  })
  it('going back past the oldest entry at the cap keeps the list, trimming the newest', () => {
    const full = settle(run(...Array.from({ length: HISTORY_MAX }, (_, i) => 'k' + i)), 'k0', 0)
    const s = settle({ ...full, entries: full.entries.map((e) => ({ ...e, pos: e.pos + 1 })) }, 'older', 0)
    expect(s.entries).toHaveLength(HISTORY_MAX)
    expect(s.entries[0].key).toBe('older')
    expect(s.entries[1].key).toBe('k0')
    expect(s.entries[HISTORY_MAX - 1].key).toBe('k' + (HISTORY_MAX - 2))
    expect(s.marker).toBe(0)
  })
  it('a dead target is skipped only when the list holds it and a live entry lies that way', () => {
    const s = run('a', 'b', 'c', 'd')
    const alive = (k: string) => k !== 'c'
    expect(skipDead(s, 'c', 2, 3, alive)).toBe(-1)
    expect(skipDead(s, 'c', 2, 1, alive)).toBe(1)
    expect(skipDead(s, 'gone', 2, 3, alive)).toBeNull()
    expect(skipDead(s, 'c', 2, 3, (k) => k === 'd')).toBeNull()
  })
})

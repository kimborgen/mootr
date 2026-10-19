import { describe, expect, it } from 'vitest'
import { liveCols, pickable, rowValues, sanitizeCols, toggleCol } from './sidebar-cols'
import type { Field } from './itsa/fields'
import type { Itsa } from './types'

const f = (id: string, position: number, card = 'none', type = 'text'): Field =>
  ({ id, key: id, label: 'L' + id, type, options: null, description: null, hint: null, width: 'm', align: 'start', card, position }) as unknown as Field

describe('sidebar columns setting', () => {
  it('keeps at most two distinct string ids', () => {
    expect(sanitizeCols({ cols: ['review', 'review', 'tests', 'health'] })).toEqual(['review', 'tests'])
    expect(sanitizeCols({ cols: [1, '', 'tests'] })).toEqual(['tests'])
    expect(sanitizeCols(null)).toEqual([])
    expect(sanitizeCols({ cols: 'review' })).toEqual([])
  })
  it('numbers picks by order and refuses a third', () => {
    expect(toggleCol([], 'review')).toEqual(['review'])
    expect(toggleCol(['review'], 'tests')).toEqual(['review', 'tests'])
    expect(toggleCol(['review', 'tests'], 'health')).toEqual(['review', 'tests'])
    expect(toggleCol(['review', 'tests'], 'review')).toEqual(['tests'])
  })
  it('lists the built-ins, then fields by position, and drops deleted fields', () => {
    expect(pickable([f('b', 2), f('a', 1)]).map((c) => c.id)).toEqual(['review', 'tests', 'health', 'field:a', 'field:b'])
    expect(liveCols(['field:gone', 'tests'], [f('a', 1)])).toEqual(['tests'])
    expect(liveCols(['field:a'], null)).toEqual(['field:a'])
  })
})

describe('row values', () => {
  const it0 = { id: 'i', health: 'at_risk', fields: { a: 'x' }, links: [] } as unknown as Itsa
  it('gives a badge for a value and null (a dash) for none, in the picked order', () => {
    const v = rowValues(it0, ['field:a', 'review'], [f('a', 1)])
    expect(v[0]).toMatchObject({ kind: 'field', id: 'field:a', v: 'x' })
    expect(v[1]).toBeNull()
  })
  it('shows a field whatever its card setting, and health only off track', () => {
    expect(rowValues(it0, ['health'], [])[0]).toMatchObject({ kind: 'word', word: 'at risk' })
    expect(rowValues({ ...it0, health: 'on_track' } as Itsa, ['health'], [])[0]).toBeNull()
  })
  it('is all dashes for an agent with no ITSA', () => {
    expect(rowValues(undefined, ['review', 'tests'], [])).toEqual([null, null])
  })
})

// @vitest-environment jsdom
// The ITSA view's Fields block (S-3834): every field in the Work order with its label and value, and an
// empty value as an empty row, not a hidden one.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Field } from '../itsa/fields'

vi.mock('../api', () => ({ api: vi.fn() }))

import { Events, FieldsBlock, fieldsText } from './ItsaView'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const f = (over: Partial<Field>): Field => ({ id: 'f1', key: 'stage', label: 'Stage', type: 'choice', options: [{ value: 'code', label: 'Code', tone: null }], description: null, hint: null, width: 'm', align: 'start', card: 'chip', position: 0, ...over })
const FIELDS: Field[] = [
  f({ id: 'f2', key: 'note', label: 'Note', type: 'text', options: null, position: 2 }),
  f({}),
  f({ id: 'f3', key: 'due', label: 'Due', type: 'date', options: null, position: 1, kinds: ['epic'] }),
]

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const show = (it: { fields?: Record<string, unknown>; kind: string | null }, fields: Field[] | null) => act(async () => { root.render(<FieldsBlock it={it} fields={fields} />) })

describe('FieldsBlock', () => {
  it('lists every field by position with its label and value', async () => {
    await show({ kind: 'issue', fields: { stage: 'code', note: 'hello' } }, FIELDS)
    expect([...host.querySelectorAll('dt')].map((x) => x.textContent)).toEqual(['Stage', 'Due', 'Note'])
    expect(host.querySelector('[data-field="stage"]')?.textContent).toBe('Code')
    expect(host.querySelector('[data-field="note"]')?.textContent).toBe('hello')
  })

  it('keeps an empty field as an empty row', async () => {
    await show({ kind: 'issue', fields: {} }, FIELDS)
    expect(host.querySelectorAll('dt').length).toBe(3)
    for (const k of ['stage', 'note']) {
      const dd = host.querySelector(`[data-field="${k}"]`)
      expect(dd?.textContent).toBe('')
      expect(dd?.hasAttribute('data-empty')).toBe(true)
    }
  })

  it('says a field limited to other kinds is not used here, even if a value is stored', async () => {
    await show({ kind: 'issue', fields: { due: '2026-11-03' } }, FIELDS)
    const dd = host.querySelector('[data-field="due"]')
    expect(dd?.textContent).toBe('Not used on issues')
    expect(dd?.hasAttribute('data-na')).toBe(true)
    await show({ kind: 'epic', fields: { due: '2026-11-03' } }, FIELDS)
    expect(host.querySelector('[data-field="due"]')?.hasAttribute('data-na')).toBe(false)
    expect(host.querySelector('[data-field="due"] time')).not.toBeNull()
  })

  it('draws nothing before the fields load', async () => {
    await show({ kind: 'issue', fields: {} }, null)
    expect(host.querySelector('[data-itsa-fields]')).toBeNull()
  })
})

describe('field events', () => {
  it('reads a set value, several fields, and a cleared field by the field labels', () => {
    expect(fieldsText({ stage: 'code' }, FIELDS)).toBe('set Stage to Code')
    expect(fieldsText({ stage: 'code', note: 'x' }, FIELDS)).toBe('set Stage, Note')
    expect(fieldsText({ stage: null }, FIELDS)).toBe('cleared Stage')
    expect(fieldsText({ stage: 'code', note: '' }, FIELDS)).toBe('set Stage to Code and cleared Note')
    expect(fieldsText({ gone: 'v' }, FIELDS)).toBe('set gone to v')
  })

  it('formats dates and checks like the Work cell', () => {
    const more = [...FIELDS, f({ id: 'f4', key: 'ship', label: 'Shipped', type: 'check', options: null, position: 3 })]
    expect(fieldsText({ due: '2026-11-03' }, more)).toMatch(/^set Due to .*3/)
    expect(fieldsText({ due: '2026-11-03' }, more)).not.toContain('2026-11-03')
    expect(fieldsText({ ship: true }, more)).toBe('set Shipped to Yes')
    expect(fieldsText({ ship: false }, more)).toBe('set Shipped to No')
    expect(fieldsText({ ship: null }, more)).toBe('cleared Shipped')
  })

  it('shows as the activity line, not as "fields"', async () => {
    const e = { id: 1, ts: new Date().toISOString(), actor: null, type: 'fields', data: JSON.stringify({ from: { stage: null }, to: { stage: 'code' } }) }
    await act(async () => { root.render(<Events events={[e]} fields={FIELDS} />) })
    expect(host.querySelector('li')?.textContent).toContain('set Stage to Code')
    expect(host.querySelector('li')?.textContent).not.toMatch(/You fields/)
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fieldApplies, type Field } from '../itsa/fields'
import type { Itsa } from '../types'
import { fieldColumn, fieldColumns, fmtDay, isEmpty, linkHost, valueOf, withFieldFit } from './field-columns'

let n = 0
const field = (over: Partial<Field>): Field => ({
  id: `f${n++}`, key: 'k', label: 'K', type: 'text', options: null, description: null, hint: null, width: 'm', align: 'start', card: 'meta', position: 0, ...over,
})
const itsa = (fields: Record<string, unknown>) => ({ id: 'i', key: 'S-1', fields } as unknown as Itsa)
const cell = (f: Field, v: unknown) => renderToStaticMarkup(<>{fieldColumn(f).render({ it: itsa({ [f.key]: v }), depth: 0, context: false }, { now: 0, extras: {} as never })}</>)

describe('field columns', () => {
  it('ids by field id, label, hint, width track and alignment from the field', () => {
    const f = field({ id: 'abc', key: 'k', label: 'Owner team', hint: 'Who owns it', width: 'l', align: 'end' })
    const c = fieldColumn(f)
    expect([c.id, c.label, c.hint, c.align]).toEqual(['field:abc', 'Owner team', 'Who owns it', 'end'])
    expect(c.width).toContain('var(--space-12) * 3')
    expect(fieldColumn(field({ width: 's' })).width).toBe('calc(var(--space-12))')
    expect(fieldColumn(field({ type: 'number' })).align).toBe('end')
    expect(fieldColumn(field({ hint: null })).hint).toBeUndefined()
  })

  it('a field limited to kinds shows no value on another kind', () => {
    const f = field({ key: 'stage', kinds: ['issue'] })
    const issue = { id: 'i', key: 'S-1', kind: 'Issue', fields: { stage: 'dev' } } as unknown as Itsa
    const project = { id: 'p', key: 'S-2', kind: 'project', fields: { stage: 'dev' } } as unknown as Itsa
    expect(valueOf(issue, f)).toBe('dev')
    expect(valueOf(project, f)).toBeUndefined()
    expect(renderToStaticMarkup(<>{fieldColumn(f).render({ it: project, depth: 0, context: false }, { now: 0, extras: {} as never })}</>)).toBe('')
    expect(fieldApplies(field({ kinds: null }), null)).toBe(true)
    expect(fieldApplies(f, undefined)).toBe(false)
  })

  it('orders the columns by field position', () => {
    const a = field({ id: 'a', position: 2 }), b = field({ id: 'b', position: 1 })
    expect(fieldColumns([a, b]).map((c) => c.id)).toEqual(['field:b', 'field:a'])
  })

  describe('dropping as the pane narrows', () => {
    const col = (id: string, hideBelow?: number) => ({ id, label: id, width: '', hideBelow, render: () => null }) as never
    const A = field({ id: 'a', width: 's' }), B = field({ id: 'b', width: 'l' })
    const fit = (cols: ReturnType<typeof col>[]) => withFieldFit(cols, [A, B]).map((c) => c.hideBelow)

    it('the fields at the end drop first: past the widest built-in, by their room', () => {
      expect(fit([col('work'), col('time', 1400), col('field:a'), col('field:b')])).toEqual([undefined, 1400, 1600, 1600])
      expect(fit([col('work'), col('time', 1400), col('field:b'), col('field:a')])).toEqual([undefined, 1400, 1480, 1480])
    })

    it('a field never drops before a column to its right: it takes the smallest threshold after it', () => {
      expect(fit([col('work'), col('time', 1400), col('field:a'), col('window', 1320), col('updated', 1032)])).toEqual([undefined, 1400, 1032, 1320, 1032])
    })

    it('a field right after Time stays visible at 1,450 px, with Window and Updated after it', () => {
      const [, , h] = fit([col('work'), col('time', 1400), col('field:a'), col('window', 1320), col('updated', 1032)])
      expect(1450 >= h!).toBe(true)
    })

    it('a field before a column that never drops never drops', () => {
      expect(fit([col('work'), col('field:a'), col('status'), col('time', 1400)])).toEqual([undefined, undefined, undefined, 1400])
    })

    it('a field moved before Time stays visible where Time and what follows it drop', () => {
      const hideBelow = fit([col('work'), col('branch', 948), col('field:a'), col('time', 1400), col('window', 1320)])
      expect(hideBelow).toEqual([undefined, 948, 1320, 1400, 1320])
      expect(hideBelow[2]! <= hideBelow[3]!).toBe(true)
    })

    it('leaves the built-ins as they are', () => {
      expect(fit([col('work'), col('time', 1400), col('cost')])).toEqual([undefined, 1400, undefined])
    })
  })

  it('text is truncated with the full text in its title', () => {
    expect(cell(field({ key: 't' }), 'a long note')).toBe('<span class="w-ftext" title="a long note">a long note</span>')
  })

  it('a number is a tabular, end-aligned value', () => {
    const f = field({ key: 'n', type: 'number' })
    expect(cell(f, 42)).toContain('class="w-fnum">42<')
    expect(cell(f, 0)).toContain('>0<')
  })

  it('a choice is its option label in a badge with the tone class', () => {
    const f = field({ key: 'c', type: 'choice', options: [{ value: 'a', label: 'Alpha', tone: 'ok' }, { value: 'b', label: 'Beta', tone: 'bad' }, { value: 'c', label: 'Gamma', tone: 'muted' }, { value: 'd', label: 'Delta', tone: 'accent' }, { value: 'e', label: 'Eps', tone: 'warn' }] })
    expect(cell(f, 'a')).toContain('class="badge ok"')
    expect(cell(f, 'b')).toContain('badge err')
    expect(cell(f, 'c')).toContain('class="badge"')
    expect(cell(f, 'd')).toContain('badge progress')
    expect(cell(f, 'e')).toContain('badge warn')
    expect(cell(f, 'a')).toContain('>Alpha<')
    expect(cell(f, 'gone')).toContain('>gone<')
  })

  it('a link opens in a new tab and is labelled by its host', () => {
    const html = cell(field({ key: 'l', type: 'link' }), 'https://www.example.com/a/b')
    expect(html).toContain('href="https://www.example.com/a/b"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('noopener')
    expect(html).toContain('>example.com<')
    expect(linkHost('not a url')).toBe('not a url')
  })

  it('a date reads as a calendar day, with no time zone shift', () => {
    expect(fmtDay('2026-03-05', new Date(2026, 5, 1))).toBe(new Date(2026, 2, 5).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
    expect(fmtDay('2025-12-31', new Date(2026, 5, 1))).toContain('2025')
    expect(cell(field({ key: 'd', type: 'date' }), '2026-03-05')).toContain('dateTime="2026-03-05"')
  })

  it('a check is a glyph when on, and nothing when off', () => {
    const f = field({ key: 'ck', type: 'check' })
    expect(cell(f, true)).toContain('w-fcheck')
    expect(cell(f, false)).toBe('')
  })

  it('an empty value renders nothing, like the other columns', () => {
    for (const type of ['text', 'number', 'choice', 'link', 'date', 'check'] as const) {
      const f = field({ key: 'e', type })
      expect([type, cell(f, undefined)]).toEqual([type, ''])
      expect([type, cell(f, null)]).toEqual([type, ''])
    }
    expect(cell(field({ key: 'e' }), '')).toBe('')
    expect([isEmpty(0), isEmpty(false), isEmpty('x')]).toEqual([false, true, false])
  })
})

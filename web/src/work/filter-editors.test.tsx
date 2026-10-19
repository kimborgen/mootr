// @vitest-environment jsdom
// The Work header menu's filter editors (S-1513): each reports the next filter, or null when nothing is left filtered.
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeFilter, FilterEditor } from './filter-editors'
import type { ColFilter, FilterKind, FilterValue } from './sortfilter'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTS: FilterValue[] = [{ value: 'a', label: 'Alpha', n: 3 }, { value: 'b', label: 'Beta', n: 2 }, { value: '', label: '(Blank)', n: 1 }]
let host: HTMLDivElement
let root: Root
let seen: (ColFilter | null)[]
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); seen = [] })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

const show = (kind: FilterKind, filter: ColFilter | null = null) => act(async () => {
  root.render(<FilterEditor kind={kind} filter={filter} options={OPTS} onChange={(f) => seen.push(f)} />)
})
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click() })
const type = (el: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const rows = () => [...host.querySelectorAll('.rm-row')]
const names = () => rows().map((r) => r.querySelector('.ml')?.textContent)

describe('values editor', () => {
  it('lists every value with its count, all ticked when nothing is filtered', async () => {
    await show('values')
    expect(names()).toEqual(['Alpha', 'Beta', '(Blank)'])
    expect(rows().map((r) => r.querySelector('.fm-n')?.textContent)).toEqual(['3', '2', '1'])
    expect(rows().every((r) => r.getAttribute('aria-checked') === 'true')).toBe(true)
  })

  it('unticking one filters to the rest; ticking the last back drops the filter', async () => {
    await show('values')
    await click(rows()[1])
    expect(seen.at(-1)).toEqual({ kind: 'values', values: ['a', ''] })
    await show('values', { kind: 'values', values: ['a', ''] })
    await click(rows()[1])
    expect(seen.at(-1)).toBeNull()
  })

  it('searches the labels, and None and All act on what the search shows', async () => {
    await show('values')
    await type(host.querySelector('input[type=search]')!, 'ta')
    expect(names()).toEqual(['Beta'])
    await click([...host.querySelectorAll('.fm-bulk button')].find((b) => b.textContent === 'None'))
    expect(seen.at(-1)).toEqual({ kind: 'values', values: ['a', ''] })
    await type(host.querySelector('input[type=search]')!, 'zzz')
    expect(host.querySelector('.rm-none')?.textContent).toBe('No value matches')
  })
})

describe('values search keys', () => {
  it('Home and End stay in the search box instead of reaching the menu', async () => {
    const outer = vi.fn()
    document.body.addEventListener('keydown', outer)
    await show('values')
    const input = host.querySelector('input[type=search]')!
    for (const k of ['Home', 'End']) await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: k })) })
    expect(outer).not.toHaveBeenCalled()
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'a' })) })
    expect(outer).toHaveBeenCalledTimes(1)
    document.body.removeEventListener('keydown', outer)
  })
})

describe('other editors', () => {
  it('text: reports the text, and null when it is emptied', async () => {
    await show('text')
    await type(host.querySelector('input')!, 'stam/')
    expect(seen.at(-1)).toEqual({ kind: 'text', q: 'stam/' })
    await type(host.querySelector('input')!, '  ')
    expect(seen.at(-1)).toBeNull()
  })

  it('range: min and max report as numbers, and null when both are empty', async () => {
    await show('range', { kind: 'range', min: 2 })
    const inputs = () => [...host.querySelectorAll('input')]
    const [min, max] = inputs()
    expect(min.value).toBe('2')
    await type(max, '9')
    expect(seen.at(-1)).toEqual({ kind: 'range', min: 2, max: 9 })
    await show('range', { kind: 'range', min: 2, max: 9 })
    await type(inputs()[0], '')
    expect(seen.at(-1)).toEqual({ kind: 'range', max: 9 })
  })

  it('range: half-typed input stays, and a filter cleared from elsewhere empties the field', async () => {
    await show('range', { kind: 'range', min: 5 })
    const min = () => host.querySelectorAll('input')[0]
    await type(min(), '-')
    expect(min().value).toBe('-')
    await type(min(), '1e')
    expect(min().value).toBe('1e')
    expect(seen).toEqual([])
    await type(min(), '12')
    expect(seen.at(-1)).toEqual({ kind: 'range', min: 12 })
    await show('range', { kind: 'range', min: 12 })
    expect(min().value).toBe('12')
    await show('range', null)
    expect(min().value).toBe('')
  })

  it('date: a preset toggles, and from and to combine with it', async () => {
    await show('date')
    await click(rows().find((r) => r.textContent?.includes('Last 7 days')))
    expect(seen.at(-1)).toEqual({ kind: 'date', preset: '7d' })
    await show('date', { kind: 'date', preset: '7d' })
    await type(host.querySelector('input[aria-label=From]')!, '2026-10-01')
    expect(seen.at(-1)).toEqual({ kind: 'date', preset: '7d', from: '2026-10-01' })
    await click(rows().find((r) => r.textContent?.includes('Last 7 days')))
    expect(seen.at(-1)).toBeNull()
  })

  it('has: has some, has none, and the chosen one again clears', async () => {
    await show('has')
    await click(rows()[1])
    expect(seen.at(-1)).toEqual({ kind: 'has', has: false })
    await show('has', { kind: 'has', has: false })
    await click(rows()[1])
    expect(seen.at(-1)).toBeNull()
  })

  it('check: Yes, No, and the chosen one again clears', async () => {
    await show('check')
    await click(rows()[0])
    expect(seen.at(-1)).toEqual({ kind: 'check', value: true })
    await show('check', { kind: 'check', value: true })
    await click(rows()[0])
    expect(seen.at(-1)).toBeNull()
  })
})

describe('describeFilter', () => {
  it('says each kind in words', () => {
    expect(describeFilter({ kind: 'values', values: ['a', ''] }, OPTS)).toBe('Alpha, (Blank)')
    expect(describeFilter({ kind: 'values', values: [] })).toBe('none')
    expect(describeFilter({ kind: 'text', q: ' x ' })).toBe('contains “x”')
    expect(describeFilter({ kind: 'range', min: 1, max: 5 })).toBe('1 to 5')
    expect(describeFilter({ kind: 'range', max: 5 })).toBe('at most 5')
    expect(describeFilter({ kind: 'date', preset: 'today', from: '2026-10-01' })).toBe('Today, from 2026-10-01')
    expect(describeFilter({ kind: 'has', has: true })).toBe('has some')
    expect(describeFilter({ kind: 'check', value: false })).toBe('No')
  })
})


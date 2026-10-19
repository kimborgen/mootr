// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SpendCharts } from './SpendCharts'
import type { DrillTarget, Series } from './math'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLElement | undefined
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = undefined })

const row = (t: string, a: number, b: number) => ({ t, cost_usd: a + b, groups: { a: { cost_usd: a }, other: { cost_usd: b } } })
const S: Series = {
  days: 2, group: 'tree', bucket: 'day',
  groups: [{ id: 'a', name: 'alpha' }, { id: 'other', name: 'Other' }],
  rows: [row('2026-10-13', 4, 1), row('2026-10-14', 2, 0)],
  total: { cost_usd: 7 }, previous: { cost_usd: 0 },
}

function mount(series: Series | null, onDrill: (t: DrillTarget) => void = () => {}, extra: { error?: string | null; onRetry?: () => void } = {}) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<SpendCharts series={series} error={extra.error} onRetry={extra.onRetry} group="tree" onGroup={() => {}} onDrill={onDrill} colors={new Map()} />))
  return host
}

describe('SpendCharts', () => {
  it('says there is no spend, with no chart, for empty input', () => {
    const h = mount({ ...S, rows: [] })
    expect(h.textContent).toContain('No spend in this period')
    expect(h.querySelector('svg')).toBeNull()
    act(() => root!.unmount()); h.remove()
    expect(mount({ ...S, rows: [row('2026-10-14', 0, 0)] }).textContent).toContain('No spend in this period')
  })

  it('draws a column per bucket, ranks the list with Other last, and shares', () => {
    const h = mount(S)
    expect(h.querySelectorAll('.uc-col')).toHaveLength(2)
    const bars = [...h.querySelectorAll('.uc-bar')].map((b) => b.textContent)
    expect(bars[0]).toContain('alpha')
    expect(bars[0]).toContain('86%')
    expect(bars[1]).toContain('Other')
    expect((h.querySelector('.uc-bar:last-child') as HTMLButtonElement).disabled).toBe(true)
  })

  it('drills on a segment click and a bar click, never on Other', () => {
    const drill = vi.fn()
    const h = mount(S, drill)
    act(() => { (h.querySelector('.uc-seg') as SVGElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(drill).toHaveBeenLastCalledWith({ kind: 'tree', id: 'a' })
    act(() => { (h.querySelector('.uc-bar') as HTMLButtonElement).click() })
    expect(drill).toHaveBeenCalledTimes(2)
    act(() => { (h.querySelector('.uc-bar:last-child') as HTMLButtonElement).click() })
    expect(drill).toHaveBeenCalledTimes(2)
  })

  it('moves real focus with the arrow keys and drills with Enter', () => {
    const drill = vi.fn()
    const h = mount(S, drill)
    const cols = h.querySelectorAll<SVGGElement>('.uc-col')
    act(() => { cols[1].focus() })
    const press = (k: string) => act(() => { (document.activeElement as Element).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
    press('ArrowLeft')
    expect(document.activeElement).toBe(cols[0])
    press('ArrowDown') // the column's lowest segment: alpha
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Oct 13, alpha $4.00')
    press('Enter')
    expect(drill).toHaveBeenLastCalledWith({ kind: 'tree', id: 'a' })
    press('ArrowUp') // the segment above: Other, not drillable
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Oct 13, Other $1.00')
    press('Enter')
    expect(drill).toHaveBeenCalledTimes(1)
    press('ArrowRight')
    expect(document.activeElement).toBe(cols[1])
  })

  it('names every column and segment for a screen reader', () => {
    const h = mount(S)
    expect(h.querySelector('.uc-col')?.getAttribute('aria-label')).toBe('Oct 13: $5.00')
    expect(h.querySelector('.uc-seg')?.getAttribute('aria-label')).toBe('Oct 13, alpha $4.00')
  })

  it('shows an error with Retry, not the empty message, when the fetch failed', () => {
    const retry = vi.fn()
    const h = mount(null, () => {}, { error: 'HTTP 500', onRetry: retry })
    expect(h.querySelector('[role=alert]')?.textContent).toContain('HTTP 500')
    expect(h.textContent).not.toContain('No spend in this period')
    act(() => { (h.querySelector('[role=alert] button') as HTMLButtonElement).click() })
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('shows a tooltip with every group on hover', () => {
    const h = mount(S)
    act(() => { h.querySelector('.uc-col')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(h.querySelector('.uc-tip')?.textContent).toContain('alpha')
  })

  it('captions the previous columns with the period label and marks them in the tooltip', () => {
    const withPrev: Series = { ...S, previous_rows: [row('2026-10-11', 1, 0), row('2026-10-12', 2, 0)] }
    const h = mount(withPrev)
    expect(h.querySelector('.uc-spend .uc-note')?.textContent).toBe('The previous 2 days are dimmed, for comparison.')
    expect(h.querySelectorAll('.uc-col.prev')).toHaveLength(2)
    act(() => { h.querySelector('.uc-col')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(h.querySelector('.uc-tip-h')?.textContent).toContain('Previous period')
  })

  it('caps a column at 24 px and leaves zero-spend groups out of the legend, list and tooltip', () => {
    const z: Series = { ...S, groups: [{ id: 'a', name: 'alpha' }, { id: 'z', name: 'zero' }, { id: 'other', name: 'Other' }], rows: [{ t: '2026-10-14', cost_usd: 2, groups: { a: { cost_usd: 2 }, z: { cost_usd: 0 }, other: { cost_usd: 0 } } }] }
    const h = mount(z)
    expect(Number(h.querySelector('.uc-seg')!.getAttribute('width') ?? 24)).toBeLessThanOrEqual(24)
    expect(h.textContent).not.toContain('zero')
    expect(h.querySelectorAll('.uc-bar')).toHaveLength(1)
    act(() => { h.querySelector('.uc-col')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(h.querySelector('.uc-tip')?.textContent).not.toContain('zero')
  })
})

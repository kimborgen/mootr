import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defaultCardLayout, type CardLayout } from '../card-layout'
import { ACTIVITY, COSTS } from '../stories/workFixtures'
import type { WorkExtras } from '../work/data'
import type { Itsa } from '../types'
import { IssueCard, cardItemMap, type IssueCardState } from './IssueCard'

const extras: WorkExtras = { costs: COSTS, activity: ACTIVITY, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }
const cx = { now: Date.parse('2026-10-20T12:00:00Z'), extras }
const itsa = { id: 'i1', key: 'S-911', title: 'Replace the index files', status: 'in_progress', kind: 'issue', parent_id: null, owner: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-20T11:00:00Z', fields: {}, links: [] } as unknown as Itsa
const actions = { onOpen: () => {}, onPointerDown: () => {}, onKeyDown: () => {}, onMenu: () => {} }
const state = (over: Partial<IssueCardState> = {}): IssueCardState => ({ column: 'active', mode: 'category', parentKey: null, dragging: false, items: cardItemMap([]), fields: [], cx, ...over })
const draw = (layout: CardLayout, s = state(), size: 'board' | 'nested' = 'board') =>
  renderToStaticMarkup(<IssueCard itsa={itsa} layout={layout} size={size} state={s} actions={actions} />)

describe('IssueCard', () => {
  it('draws the default layout: key, title, and status in META, with no badges or foot', () => {
    const html = draw(defaultCardLayout('issue'))
    expect(html).toContain('S-911')
    expect(html).toContain('Replace the index files')
    expect(html).toContain('bc-status')
    expect(html).not.toContain('bc-badges')
    expect(html).not.toContain('bc-foot')
  })

  it('leaves status out of META when the column already says it', () => {
    expect(draw(defaultCardLayout('issue'), state({ column: 'in_progress', mode: 'status' }))).not.toContain('bc-status')
  })

  it('draws a status moved to BADGES as a badge, not in META', () => {
    const layout: CardLayout = { slots: { TOP: ['parent', 'kind', 'health'], META: ['rollup', 'links', 'owner'], BADGES: ['status'], FOOT: [] }, titleLines: 3, seen: [] }
    const html = draw(layout)
    expect(html).toContain('<div class="bc-badges">')
    expect(html).toContain('class="badge')
    expect(html).not.toContain('bc-status')
  })

  it('without a menu action (the phone Glance) it draws no ⋯ button and no move hint, and wraps items in cells when asked', () => {
    const html = renderToStaticMarkup(<IssueCard itsa={itsa} layout={defaultCardLayout('issue')} size="board" state={state({ cells: true })} actions={{ onOpen: () => {}, onKeyDown: () => {} }} />)
    expect(html).not.toContain('bc-menu')
    expect(html).not.toContain('Shift and arrows')
    expect(html).toContain('<span class="ic-cell" data-cell="status">')
    expect(draw(defaultCardLayout('issue'))).not.toContain('ic-cell')
  })

  it('nested: its first row is the status, key and title, with no box or menu of its own', () => {
    const html = draw(defaultCardLayout('issue'), state(), 'nested')
    expect(html).toContain('class="ic-nested"')
    expect(html).toContain('class="ic-row ic-head"')
    expect(html).toContain('S-911')
    expect(html).toContain('Replace the index files')
    expect(html).not.toContain('bcard')
    expect(html).not.toContain('bc-menu')
    // META is the board's; the nested card draws only the rows the layout gives BADGES and FOOT.
    expect(html).not.toContain('bc-meta')
    expect(html).not.toContain('ic-badges')
    expect(html).not.toContain('ic-foot')
  })

  it('nested: draws the layout\'s BADGES and FOOT rows, and leaves the owner out', () => {
    const layout: CardLayout = { slots: { TOP: [], META: [], BADGES: ['status', 'owner'], FOOT: ['updated'] }, titleLines: 3, seen: [] }
    const html = draw(layout, state(), 'nested')
    expect(html).toContain('class="ic-row ic-badges"')
    expect(html).toContain('class="badge')
    expect(html).toContain('class="ic-row ic-foot"')
    expect(html).not.toContain('title="Owner')
  })

  it('nested: leaves out the BADGES items the agent card draws, so a field in both layouts draws once', () => {
    const layout: CardLayout = { slots: { TOP: [], META: [], BADGES: ['status'], FOOT: [] }, titleLines: 3, seen: [] }
    const html = draw(layout, state(), 'nested')
    expect(html).toContain('class="ic-row ic-badges"')
    const skipped = renderToStaticMarkup(<IssueCard itsa={itsa} layout={layout} size="nested" state={state()} actions={actions} nested={{ skip: ['status'] }} />)
    expect(skipped).not.toContain('class="ic-row ic-badges"')
  })

  it('clamps the title to the layout lines', () => {
    expect(draw({ ...defaultCardLayout('issue'), titleLines: 1 })).toContain('-webkit-line-clamp:1')
  })

  it('draws the parent key only when the board passes one', () => {
    const layout = { ...defaultCardLayout('issue'), slots: { TOP: ['parent'], META: [], BADGES: [], FOOT: [] } }
    expect(draw(layout)).not.toContain('bc-parent')
    expect(draw(layout, state({ parentKey: 'S-1' }))).toContain('S-1')
  })

  it('draws the parent badge in BADGES only when the board passes a parent key, as the inline form does', () => {
    const layout: CardLayout = { slots: { TOP: [], META: [], BADGES: ['parent'], FOOT: [] }, titleLines: 3, seen: [] }
    expect(draw(layout)).not.toContain('bc-badges')
    const html = draw(layout, state({ parentKey: 'S-1' }))
    expect(html).toContain('<div class="bc-badges">')
    expect(html).toContain('S-1')
    expect(html).toContain('title="Parent"')
  })

  it('draws the needs-you mark once, in TOP, and never from a layout slot', () => {
    const html = draw({ slots: { TOP: [], META: ['needs'], BADGES: ['needs'], FOOT: [] }, titleLines: 3, seen: [] })
    expect(html).not.toContain('bc-meta')
    expect(html).not.toContain('bc-badges')
  })

  it('pushes the health dot in TOP and the owner in META to the right with a spacer', () => {
    const x = { ...itsa, owner: 'fx-dev', health: 'at_risk' } as Itsa
    const html = renderToStaticMarkup(<IssueCard itsa={x} layout={defaultCardLayout('issue')} size="board" state={state()} actions={actions} />)
    const top = html.slice(html.indexOf('bc-top'), html.indexOf('bc-title'))
    expect(top.indexOf('class="spacer"')).toBeLessThan(top.indexOf('hdot'))
    const meta = html.slice(html.indexOf('bc-meta'))
    expect(meta.indexOf('class="spacer"')).toBeLessThan(meta.indexOf('Owner:'))
  })
})

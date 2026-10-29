import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCardLayout, type CardLayout } from '../card-layout'
import { FIELDS, TREE } from '../stories/itsaFixtures'
import { ACTIVITY, COSTS } from '../stories/workFixtures'
import { cardItemsFor } from '../work/card-items'
import type { WorkExtras } from '../work/data'
import { MenuLayer } from '../ui/menu'
import { IssueCardPhoneEditor } from './IssueCardPhoneEditor'
import { availableItems } from './issue-layout'

const extras: WorkExtras = { costs: COSTS, activity: ACTIVITY, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }
const items = cardItemsFor('issue', FIELDS)
const ids = items.map((i) => i.id)

// A layout with a full Meta (its cap is 5) and a full Top (cap 3) in the cases that need one.
const base = (slots: Partial<CardLayout['slots']>): CardLayout => ({ ...defaultCardLayout('issue'), slots: { TOP: ['parent'], META: ['status', 'rollup', 'links', 'owner', 'updated'], BADGES: ['health'], FOOT: [], ...slots }, chosen: true })

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // jsdom has no layout or hit testing: the drop target is whatever a test says the pointer is over.
  document.elementFromPoint = () => null
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (document as { elementFromPoint?: unknown }).elementFromPoint
})

// Draws the editor, with the menu layer its sheets open in; returns what it hands up on each change.
async function draw(layout: CardLayout) {
  const onChange = vi.fn()
  await act(async () => {
    root.render(<><IssueCardPhoneEditor layout={layout} items={items} fields={FIELDS} itsas={TREE} extras={extras} onChange={onChange} onReset={() => {}} /><MenuLayer /></>)
  })
  const click = async (sel: string) => { await act(async () => { host.querySelector<HTMLElement>(sel)!.click() }) }
  return { onChange, click }
}
const rowOf = (item: string) => `[data-item="${item}"]`
const ctl = (item: string, act: string) => `${rowOf(item)} [data-act=${act}]`
const sheetItem = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('.ipe-sheet-item')].find((b) => b.textContent?.startsWith(text))!

describe('IssueCardPhoneEditor', () => {
  it('draws the preview, the locked key and title, and one list per slot with its controls', async () => {
    await draw(base({}))
    expect(host.querySelector('.ipe-preview-card .bcard')).not.toBeNull()
    expect(host.querySelector('[aria-label="Top"] .ipe-row.locked')?.textContent).toContain('Key')
    expect(host.querySelector('[aria-label="Title"] .ipe-row.locked')?.textContent).toContain('Title')
    const row = host.querySelector(rowOf('status'))!
    expect(row.querySelector<HTMLElement>('.ipe-handle')).not.toBeNull()
    expect(row.querySelector('[data-act=up]')).not.toBeNull()
    expect(row.querySelector('[data-act=down]')).not.toBeNull()
    expect(row.querySelector('[data-act=menu]')).not.toBeNull()
    // A locked row has no controls: nothing to move.
    expect(host.querySelector('[aria-label="Top"] .ipe-row.locked .ipe-controls button')).toBeNull()
  })

  it('moves an item down across a slot boundary: the last Meta item goes first in Badges', async () => {
    const { onChange, click } = await draw(base({ META: ['status', 'updated'], BADGES: ['health'] }))
    await click(ctl('updated', 'down'))
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.META).toEqual(['status'])
    expect(next.slots.BADGES).toEqual(['updated', 'health'])
  })

  it('moves an item up across a slot boundary into the end of the slot above', async () => {
    // Meta has room, so the step up from Badges lands there (a full Meta is the skip test's case).
    const { onChange, click } = await draw(base({ META: ['status'], TOP: ['parent'], BADGES: ['health'] }))
    await click(ctl('health', 'up'))
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.BADGES).toEqual([])
    expect(next.slots.META).toEqual(['status', 'health'])
    expect(next.slots.TOP).toEqual(['parent'])
  })

  it('moves an item up within its slot, by swapping with the one above', async () => {
    const { onChange, click } = await draw(base({ META: ['status', 'updated'], BADGES: ['health'] }))
    await click(ctl('updated', 'up'))
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.META).toEqual(['updated', 'status'])
    expect(next.slots.TOP).toEqual(['parent'])
  })

  it('moves an item up within Top, and stays in Top', async () => {
    const { onChange, click } = await draw(base({ TOP: ['parent', 'kind'], META: ['status'], BADGES: [] }))
    await click(ctl('kind', 'up'))
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.TOP).toEqual(['kind', 'parent'])
    expect(next.slots.META).toEqual(['status'])
  })

  it('moves an item down within Foot, past the one below it', async () => {
    const { onChange, click } = await draw(base({ FOOT: ['status', 'updated'], META: ['links'], BADGES: [] }))
    await click(ctl('status', 'down'))
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.FOOT).toEqual(['updated', 'status'])
  })

  it('disables ↓ on the last Foot row: it has nowhere to go, and Hide is in the ⋯ sheet', async () => {
    await draw(base({ FOOT: ['status', 'updated'], META: ['links'], BADGES: [] }))
    expect(host.querySelector<HTMLButtonElement>(ctl('updated', 'down'))!.disabled).toBe(true)
  })

  it('skips a slot at its cap: a step up from Badges passes a full Meta and lands in Top', async () => {
    const { onChange, click } = await draw(base({ TOP: ['parent'], BADGES: ['health'] }))
    await click(ctl('health', 'up'))
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.META).toEqual(['status', 'rollup', 'links', 'owner', 'updated'])
    expect(next.slots.TOP).toEqual(['parent', 'health'])
  })

  it('refuses a step into a full slot: nothing is written, and the reason shows under that slot', async () => {
    const { onChange, click } = await draw(base({ TOP: ['parent', 'kind', 'rollup'], META: ['status'], BADGES: [] }))
    await click(ctl('status', 'up'))
    expect(onChange).not.toHaveBeenCalled()
    expect(host.querySelector('[aria-label="Top"] .ipe-refusal')?.textContent).toBe('Top is full: it holds at most 3')
    expect(host.querySelector('.ipe-said')?.textContent).toContain("can't go to Top")
  })

  it('a Move-to sheet disables a choice the slot refuses, and says why', async () => {
    const { onChange, click } = await draw(base({ TOP: ['parent', 'kind', 'rollup'], META: ['status'], BADGES: [] }))
    await click(ctl('status', 'menu'))
    const top = sheetItem('Move to Top')
    expect(top.disabled).toBe(true)
    expect(top.textContent).toContain('Top is full: it holds at most 3')
    expect(sheetItem('Move to Badges').disabled).toBe(false)
    await act(async () => { sheetItem('Move to Badges').click() })
    expect((onChange.mock.calls[0][0] as CardLayout).slots.BADGES).toEqual(['status'])
  })

  it('the Add sheet lists the hidden items, and a row adds its item to the slot it names', async () => {
    const hidden = availableItems(base({ TOP: ['parent'], BADGES: ['health'] }), ids)
    const { onChange, click } = await draw(base({ TOP: ['parent'], BADGES: ['health'] }))
    await click('.ipe-add')
    expect(host.querySelectorAll('.ipe-add-row')).toHaveLength(hidden.length)
    await act(async () => { host.querySelector<HTMLButtonElement>('.ipe-add-row .btn')!.click() })
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.TOP).toEqual(['parent', hidden[0]])
    expect(next.chosen).toBe(true)
  })

  it('a long press that is scrolled away writes nothing, and does not lift the row', async () => {
    vi.useFakeTimers()
    try {
      const { onChange } = await draw(base({ META: ['status', 'updated'], BADGES: ['health'] }))
      const handle = host.querySelector<HTMLElement>(`${rowOf('updated')} .ipe-handle`)!
      await pointer('pointerdown', handle, 0, 0)
      await pointer('pointermove', window, 0, 30)
      await act(async () => { vi.advanceTimersByTime(1000) })
      await pointer('pointerup', window, 0, 30)
      expect(onChange).not.toHaveBeenCalled()
      expect(host.querySelector('.ipe-row.dragging')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('a long press lifted and let go in place writes nothing', async () => {
    vi.useFakeTimers()
    try {
      const { onChange } = await draw(base({ META: ['status', 'updated'], BADGES: ['health'] }))
      const handle = host.querySelector<HTMLElement>(`${rowOf('updated')} .ipe-handle`)!
      await pointer('pointerdown', handle, 0, 0)
      await act(async () => { vi.advanceTimersByTime(400) })
      expect(host.querySelector('.ipe-row.dragging')).not.toBeNull()
      await pointer('pointerup', window, 0, 0)
      expect(onChange).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('a long press cancelled with Escape writes nothing, even when released over a slot', async () => {
    vi.useFakeTimers()
    try {
      const { onChange } = await draw(base({ META: ['status', 'updated'], BADGES: ['health'] }))
      const badges = host.querySelector<HTMLElement>('[aria-label="Badges"]')!
      document.elementFromPoint = () => badges
      const handle = host.querySelector<HTMLElement>(`${rowOf('updated')} .ipe-handle`)!
      await pointer('pointerdown', handle, 0, 0)
      await act(async () => { vi.advanceTimersByTime(400) })
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      await pointer('pointerup', window, 0, 50)
      expect(onChange).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('a long press dropped in another slot writes once, with the item at the drop place', async () => {
    vi.useFakeTimers()
    try {
      const { onChange } = await draw(base({ META: ['status', 'updated'], BADGES: ['health'] }))
      const badges = host.querySelector<HTMLElement>('[aria-label="Badges"]')!
      document.elementFromPoint = () => badges
      const handle = host.querySelector<HTMLElement>(`${rowOf('updated')} .ipe-handle`)!
      await pointer('pointerdown', handle, 0, 0)
      await act(async () => { vi.advanceTimersByTime(400) })
      await pointer('pointermove', window, 0, 50)
      await pointer('pointerup', window, 0, 50)
      expect(onChange).toHaveBeenCalledTimes(1)
      const next = onChange.mock.calls[0][0] as CardLayout
      expect(next.slots.META).toEqual(['status'])
      expect(next.slots.BADGES).toEqual(['health', 'updated'])
    } finally { vi.useRealTimers() }
  })

  it('a long press released over a full slot writes nothing, and says why it is refused', async () => {
    vi.useFakeTimers()
    try {
      const { onChange } = await draw(base({ TOP: ['parent', 'kind', 'rollup'], META: ['status', 'updated'], BADGES: [] }))
      const top = host.querySelector<HTMLElement>('[aria-label="Top"]')!
      document.elementFromPoint = () => top
      const handle = host.querySelector<HTMLElement>(`${rowOf('updated')} .ipe-handle`)!
      await pointer('pointerdown', handle, 0, 0)
      await act(async () => { vi.advanceTimersByTime(400) })
      await pointer('pointermove', window, 0, 20)
      expect(host.querySelector('[aria-label="Top"] .ipe-refusal')?.textContent).toBe('Top is full: it holds at most 3')
      await pointer('pointerup', window, 0, 20)
      expect(onChange).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})

// A pointer event at a point, as the window or an element gets it.
const pointer = (type: string, target: EventTarget, x: number, y: number) => act(async () => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }))
})

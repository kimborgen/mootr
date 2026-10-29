import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCardLayout, type CardLayout } from '../card-layout'
import { FIELDS, TREE } from '../stories/itsaFixtures'
import { ACTIVITY, COSTS } from '../stories/workFixtures'
import { cardItemsFor } from '../work/card-items'
import type { WorkExtras } from '../work/data'
import { IssueCardEditor } from './IssueCardEditor'
import { moveTo, slotOf } from './issue-layout'

const extras: WorkExtras = { costs: COSTS, activity: ACTIVITY, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }
const items = cardItemsFor('issue', FIELDS)

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

// Draws the editor with a layout; returns what it hands up on each change.
async function draw(layout: CardLayout) {
  const onChange = vi.fn()
  await act(async () => {
    root.render(<IssueCardEditor layout={layout} items={items} fields={FIELDS} itsas={TREE} extras={extras} onChange={onChange} onReset={() => {}} />)
  })
  return { onChange, click: async (sel: string) => { await act(async () => { host.querySelector<HTMLElement>(sel)!.click() }) } }
}

describe('IssueCardEditor', () => {
  it('draws the preview and every slot row, with the locked key and title', async () => {
    await draw(defaultCardLayout('issue'))
    expect(host.querySelector('.ice-preview-card .bcard')).not.toBeNull()
    for (const slot of ['TITLE', 'TOP', 'META', 'BADGES', 'FOOT']) expect(host.querySelector(`[data-slot="${slot}"]`)).not.toBeNull()
    expect(host.querySelector('[data-slot="TOP"] .ice-chip.locked')?.textContent).toContain('Key')
    expect(host.querySelector('[data-slot="TITLE"] .ice-chip.locked')?.textContent).toContain('Title')
  })

  it('shows the status in the preview, which is not a column of the board', async () => {
    await draw(defaultCardLayout('issue'))
    expect(host.querySelector('.ice-preview-card .bc-status')).not.toBeNull()
  })

  it('previews the open ITSA that fills the most slots, not a closed one', async () => {
    const closed = { ...TREE[0], id: 'c1', key: 'S-C1', status: 'done', owner: null, fields: {} }
    const open = { ...TREE[0], id: 'o1', key: 'S-O1', status: 'in_progress', owner: 'helper', fields: { stage: 'Build' } }
    await act(async () => {
      root.render(<IssueCardEditor layout={defaultCardLayout('issue')} items={items} fields={FIELDS} itsas={[closed, open]} extras={extras} onChange={() => {}} onReset={() => {}} />)
    })
    expect(host.querySelector('.ice-pick select')).not.toBeNull()
    expect((host.querySelector('.ice-pick select') as HTMLSelectElement).value).toBe('o1')
  })

  it('names the links item, so a hidden one is listed and can go back on the card', async () => {
    await draw(defaultCardLayout('issue'))
    expect(host.querySelector('[data-slot="META"] [data-item="links"]')?.textContent).toBe('Links')
  })

  it('adds a hidden item from the + menu into its slot, and hands the new layout up', async () => {
    const { onChange, click } = await draw(defaultCardLayout('issue'))
    await click('[aria-label="Add to Badges"]')
    await act(async () => { host.querySelector<HTMLButtonElement>('[role=menu] [role=menuitem]')!.click() })
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.BADGES).toHaveLength(1)
    expect(next.chosen).toBe(true)
  })

  it('disables the + of a slot at its cap, and says why in its name and tooltip', async () => {
    const full = { ...defaultCardLayout('issue'), slots: { ...defaultCardLayout('issue').slots, META: ['status', 'rollup', 'links', 'owner', 'updated'] } }
    await draw(full)
    const add = host.querySelector<HTMLButtonElement>('[data-slot="META"] .ice-add')!
    expect(add.disabled).toBe(true)
    expect(add.getAttribute('aria-label')).toBe('Add to Meta: Meta holds at most 5')
    expect(add.title).toBe('Meta holds at most 5')
  })

  it('moves a chip to another slot from its ⋯ menu', async () => {
    const { onChange, click } = await draw(defaultCardLayout('issue'))
    await click('[aria-label="Options for Status"]')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[role=menu] [role=menuitem]')].find((b) => b.textContent === 'Move to Badges')!.click() })
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.BADGES).toEqual(['status'])
    expect(next.slots.META).not.toContain('status')
  })

  it('sets the title lines and says so in the status line', async () => {
    const { onChange } = await draw(defaultCardLayout('issue'))
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[role=radio]')].find((b) => b.textContent === '2')!.click() })
    expect((onChange.mock.calls[0][0] as CardLayout).titleLines).toBe(2)
    expect(host.querySelector('.ice-said')?.textContent).toContain('Title on 2 lines')
  })

  it('offers neither Work nor a link kind while links is placed, which the card draws as one item', async () => {
    await draw(defaultCardLayout('issue'))
    const offered = [...host.querySelectorAll<HTMLButtonElement>('.ice-avail')].map((b) => b.textContent)
    expect(offered).not.toContain('Work')
    expect(offered).not.toContain('GitHub')
    expect(offered).not.toContain('Links')
  })

  it('closes an open menu on Escape and gives focus back to the button that opened it', async () => {
    const { click } = await draw(defaultCardLayout('issue'))
    await click('[aria-label="Options for Status"]')
    expect(host.querySelector('.ice-menu')).not.toBeNull()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(host.querySelector('.ice-menu')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Options for Status')
  })

  it('closes an open menu on a press outside it', async () => {
    const { click } = await draw(defaultCardLayout('issue'))
    await click('[aria-label="Options for Status"]')
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(host.querySelector('.ice-menu')).toBeNull()
  })

  it('shows the empty Available line when every item is on the card', async () => {
    const all = items.map((i) => i.id).filter((i) => i !== 'key' && i !== 'title')
    const layout = { ...defaultCardLayout('issue'), slots: { TOP: [], META: [], BADGES: all, FOOT: [] }, chosen: true }
    await draw(layout)
    expect(host.querySelector('.ice-available .ice-none')?.textContent).toContain('Every field is on the card')
  })
})

// The same layout for the moves below: Badges is empty, so a move to its start is also its end (the menu's append).
const emptyBadges = (): CardLayout => ({ ...defaultCardLayout('issue'), slots: { ...defaultCardLayout('issue').slots, BADGES: [] }, chosen: true })
const press = (el: Element, key: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
const pointer = (type: string, target: EventTarget, x: number, y: number) => act(async () => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }))
})
// A drag: press on a chip, move to the row under (x, y), release. elementFromPoint is what the browser answers for the pointer.
async function dragTo(chip: Element, row: Element | null, x = 10, y = 10) {
  const was = document.elementFromPoint
  document.elementFromPoint = () => row as Element
  await pointer('pointerdown', chip, 0, 0)
  await pointer('pointermove', window, x, y)
  await pointer('pointerup', window, x, y)
  document.elementFromPoint = was
  // The release's click is cleared on the next task, as in a browser.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
}

describe('IssueCardEditor drag and keys', () => {
  beforeEach(() => { document.elementFromPoint = () => null })
  afterEach(() => { delete (document as { elementFromPoint?: unknown }).elementFromPoint })
  it('moves an item one way with keys, by drag, and from its menu, to the same layout', async () => {
    const start = emptyBadges()
    const expected = moveTo(start, 'owner', { slot: 'BADGES', index: 0 })
    const keys = await draw(start)
    await press(host.querySelector('[data-item="owner"]')!, ' ')
    await press(host.querySelector('[data-item="owner"]')!, 'ArrowDown')
    await press(host.querySelector('[data-item="owner"]')!, ' ')
    expect(keys.onChange.mock.calls[0][0]).toEqual(expected)

    const dragged = await draw(start)
    await dragTo(host.querySelector('[data-item="owner"]')!, host.querySelector('[data-slot="BADGES"]'))
    expect(dragged.onChange.mock.calls[0][0]).toEqual(expected)

    const menued = await draw(start)
    await menued.click('[aria-label="Options for Owner"]')
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[role=menu] [role=menuitem]')].find((b) => b.textContent === 'Move to Badges')!.click() })
    expect(menued.onChange.mock.calls[0][0]).toEqual(expected)
  })

  it('draws a key-lifted chip at its candidate place, raised, with no gap', async () => {
    await draw(emptyBadges())
    await press(host.querySelector('[data-item="owner"]')!, ' ')
    await press(host.querySelector('[data-item="owner"]')!, 'ArrowDown')
    expect(host.querySelector('[data-slot="BADGES"] [data-item="owner"]')).not.toBeNull()
    expect(host.querySelector('.ice-gap')).toBeNull()
    expect(host.querySelector('[data-item="owner"]')!.className).toContain('raised')
    expect(host.querySelector('[data-item="owner"]')!.className).not.toContain('dragging')
    expect(document.activeElement?.getAttribute('data-item')).toBe('owner')
  })

  it('cancels a pointer drag on Escape: the release after it writes nothing and shows no refusal', async () => {
    const { onChange } = await draw(emptyBadges())
    document.elementFromPoint = () => host.querySelector('[data-slot="BADGES"]')
    await pointer('pointerdown', host.querySelector('[data-item="owner"]')!, 0, 0)
    await pointer('pointermove', window, 10, 10)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await pointer('pointerup', window, 10, 10)
    expect(onChange).not.toHaveBeenCalled()
    expect(host.querySelector('.ice-refusal')).toBeNull()
    expect(host.querySelector('.ice-said')?.textContent).toContain('Owner back in Meta')
  })

  it('cancels a key lift when focus leaves the editor', async () => {
    const { onChange } = await draw(emptyBadges())
    const owner = host.querySelector<HTMLElement>('[data-item="owner"]')!
    owner.focus()
    await press(owner, ' ')
    await act(async () => { owner.blur() })
    await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
    expect(onChange).not.toHaveBeenCalled()
    expect(host.querySelector('.ice-said')?.textContent).toContain('Owner back in Meta')
  })

  it('writes once per drop, and not for a lift or a step', async () => {
    const { onChange } = await draw(emptyBadges())
    await press(host.querySelector('[data-item="owner"]')!, ' ')
    await press(host.querySelector('[data-item="owner"]')!, 'ArrowDown')
    expect(onChange).not.toHaveBeenCalled()
    await press(host.querySelector('[data-item="owner"]')!, ' ')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when a lift is cancelled with Escape, and says it is back', async () => {
    const { onChange } = await draw(emptyBadges())
    await press(host.querySelector('[data-item="owner"]')!, ' ')
    await press(host.querySelector('[data-item="owner"]')!, 'ArrowDown')
    await press(host.querySelector('[data-item="owner"]')!, 'Escape')
    expect(onChange).not.toHaveBeenCalled()
    expect(host.querySelector('.ice-said')?.textContent).toContain('Owner back in Meta')
  })

  it('writes nothing for a pointer drag that is cancelled, or dropped where it was', async () => {
    const { onChange } = await draw(emptyBadges())
    const chip = host.querySelector('[data-item="owner"]')!
    await pointer('pointerdown', chip, 0, 0)
    await pointer('pointermove', window, 10, 10)
    await pointer('pointercancel', window, 10, 10)
    await dragTo(chip, host.querySelector('[data-slot="META"]'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stops the Escape that cancels a lift, so the pane under the editor does not also close', async () => {
    await draw(emptyBadges())
    await press(host.querySelector('[data-item="owner"]')!, ' ')
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    await press(host.querySelector('[data-item="owner"]')!, 'Escape')
    window.removeEventListener('keydown', spy)
    expect(spy).not.toHaveBeenCalled()
  })

  it('stops the Escape that closes a menu the same way', async () => {
    const { click } = await draw(emptyBadges())
    await click('[aria-label="Options for Status"]')
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    window.removeEventListener('keydown', spy)
    expect(host.querySelector('.ice-menu')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses a drop past a slot cap, keeps the layout, and shows the reason in that slot', async () => {
    const full: CardLayout = { ...defaultCardLayout('issue'), slots: { TOP: ['parent', 'kind'], META: ['status', 'rollup', 'links', 'owner', 'health'], BADGES: [], FOOT: [] }, chosen: true }
    const { onChange } = await draw(full)
    await dragTo(host.querySelector('.ice-avail[data-item="updated"]')!, host.querySelector('[data-slot="META"]'))
    expect(onChange).not.toHaveBeenCalled()
    expect(host.querySelector('[data-slot="META"] .ice-refusal')?.textContent).toBe('Meta is full: it holds at most 5')
  })

  it('hides a chip dropped on the Available list', async () => {
    const { onChange } = await draw(defaultCardLayout('issue'))
    await dragTo(host.querySelector('[data-item="owner"]')!, host.querySelector('[data-drop="AVAILABLE"]'))
    expect(slotOf(onChange.mock.calls[0][0], 'owner')).toBeNull()
  })

  it('announces each step and the drop in the one polite region', async () => {
    await draw(emptyBadges())
    const said = () => host.querySelector('.ice-said')?.textContent
    await press(host.querySelector('[data-item="owner"]')!, ' ')
    expect(said()).toContain('Owner lifted, Meta, position 4')
    await press(host.querySelector('[data-item="owner"]')!, 'ArrowDown')
    expect(said()).toBe('Owner, Badges, position 1')
    expect(host.querySelector('.ice-said')?.getAttribute('aria-live')).toBe('polite')
  })

  it('moves focus along the row with the arrows, when nothing is lifted', async () => {
    await draw(emptyBadges())
    host.querySelector<HTMLElement>('[data-item="owner"]')!.focus()
    await press(host.querySelector('[data-item="owner"]')!, 'ArrowLeft')
    expect(document.activeElement?.getAttribute('data-item')).toBe('links')
  })
})

import { describe, expect, it } from 'vitest'
import { defaultCardLayout, seedIssueLayout, type CardLayout } from '../card-layout'
import { availableItems, canPlace, destination, hideItem, moveTo, placeItem, placedItems, refusal, resetIssueLayout, sameSlots, setTitleLines, slotOf } from './issue-layout'

const base = (): CardLayout => defaultCardLayout('issue')
const ALL = ['parent', 'kind', 'health', 'status', 'rollup', 'links', 'owner', 'updated', 'key', 'title', 'field:a']

describe('availableItems', () => {
  it('lists the items no slot holds, and never a locked one', () => {
    const got = availableItems(base(), ALL)
    expect(got).toEqual(['updated', 'field:a'])
  })
  it('keeps the order it is given', () => {
    expect(availableItems(base(), ['field:b', 'updated', 'field:a'])).toEqual(['field:b', 'updated', 'field:a'])
  })
})

describe('placeItem', () => {
  it('moves an item into a slot at an index, and takes it out of the slot it was in', () => {
    const next = placeItem(base(), 'status', 'BADGES', 0)
    expect(next.slots.BADGES).toEqual(['status'])
    expect(next.slots.META).toEqual(['rollup', 'links', 'owner'])
    expect(slotOf(next, 'status')).toBe('BADGES')
  })
  it('appends at the end by default and clamps a bad index', () => {
    const next = placeItem(base(), 'updated', 'FOOT', 99)
    expect(next.slots.FOOT).toEqual(['updated'])
    expect(placeItem(base(), 'updated', 'FOOT', -4).slots.FOOT).toEqual(['updated'])
  })
  it('marks the layout as chosen by the human', () => {
    expect(placeItem(base(), 'updated', 'FOOT').chosen).toBe(true)
  })
  it('refuses a slot that is at its cap, and returns the same layout', () => {
    const full = placeItem(base(), 'updated', 'META')
    expect(full.slots.META).toHaveLength(5)
    expect(placeItem(full, 'field:a', 'META')).toBe(full)
  })
  it('lets an item move within a full slot, since it does not count against its own cap', () => {
    const full = placeItem(base(), 'updated', 'META')
    const moved = placeItem(full, 'updated', 'META', 0)
    expect(moved.slots.META[0]).toBe('updated')
    expect(moved.slots.META).toHaveLength(5)
  })
  it('refuses a locked item, and a slot that is not one of the issue card\'s', () => {
    const l = base()
    expect(placeItem(l, 'key', 'TOP')).toBe(l)
    expect(placeItem(l, 'title', 'META')).toBe(l)
    expect(placeItem(l, 'updated', 'TITLE')).toBe(l)
  })
  it('caps TOP at three and FOOT at three, and leaves BADGES open', () => {
    const top = placeItem(base(), 'updated', 'TOP')
    expect(top.slots.TOP).toHaveLength(3)
    expect(canPlace(top, 'field:a', 'TOP')).toBe(false)
    const badges = ALL.reduce((l, i) => placeItem(l, i, 'BADGES'), base())
    expect(badges.slots.BADGES).toHaveLength(9)
    expect(canPlace(badges, 'field:z', 'BADGES')).toBe(true)
  })
})

describe('hideItem', () => {
  it('takes an item out of its slot and leaves it hidden', () => {
    const next = hideItem(base(), 'owner')
    expect(slotOf(next, 'owner')).toBeNull()
    expect(next.chosen).toBe(true)
  })
  it('returns the same layout for an item that is not placed', () => {
    const l = base()
    expect(hideItem(l, 'updated')).toBe(l)
  })
  it('keeps a hidden field in seen, so it is not offered again', () => {
    const l = { ...base(), seen: ['field:a'] }
    expect(hideItem(l, 'field:a').seen).toEqual(['field:a'])
  })
})

describe('canPlace', () => {
  it('counts only the other items in the slot', () => {
    const full = placeItem(base(), 'updated', 'META')
    expect(canPlace(full, 'status', 'META')).toBe(true)
    expect(canPlace(full, 'field:a', 'META')).toBe(false)
  })
})

describe('setTitleLines and resetIssueLayout', () => {
  it('sets the title lines and marks the layout chosen', () => {
    const next = setTitleLines(base(), 1)
    expect(next.titleLines).toBe(1)
    expect(next.chosen).toBe(true)
  })
  it('resets to the seeded layout as a choice', () => {
    const reset = resetIssueLayout([{ id: 'a', card: 'chip', position: 1 }])
    expect(reset.slots.BADGES).toEqual(['field:a'])
    expect(reset.chosen).toBe(true)
  })
})

describe('placedItems', () => {
  it('holds every item any slot holds', () => {
    expect([...placedItems(base())].sort()).toEqual(['health', 'kind', 'links', 'owner', 'parent', 'rollup', 'status'])
  })
})

describe('locked items', () => {
  it('never offers the Work item, which the registry marks locked', () => {
    expect(availableItems(base(), ['work', 'updated'])).toEqual(['updated'])
  })
  it('refuses to place the Work item, and returns the layout as it was', () => {
    const l = base()
    expect(canPlace(l, 'work', 'META')).toBe(false)
    expect(placeItem(l, 'work', 'META')).toBe(l)
  })
})

describe('Links and the link kinds', () => {
  const noLinks = hideItem(base(), 'links')
  it('blocks the five kinds while links is placed, and leaves them out of Available', () => {
    expect(availableItems(base(), ['branch', 'github', 'updated'])).toEqual(['updated'])
    const l = base()
    expect(placeItem(l, 'github', 'BADGES')).toBe(l)
    expect(canPlace(l, 'branch', 'BADGES')).toBe(false)
  })
  it('blocks links while any kind is placed, and leaves it out of Available', () => {
    const withKind = placeItem(noLinks, 'github', 'BADGES')
    expect(withKind.slots.BADGES).toEqual(['github'])
    expect(availableItems(withKind, ['links', 'updated'])).toEqual(['updated'])
    expect(placeItem(withKind, 'links', 'META')).toBe(withKind)
  })
  it('offers links and the kinds again once none of the other kind is placed', () => {
    expect(availableItems(noLinks, ['links', 'branch', 'updated'])).toEqual(['links', 'branch', 'updated'])
    expect(placeItem(noLinks, 'links', 'META').slots.META).toContain('links')
  })
})

describe('Reset to default', () => {
  it('is the seed the migration writes, marked chosen', () => {
    const fields = [{ id: 'a', card: 'chip' as const, position: 1 }, { id: 'b', card: 'meta' as const, position: 2 }]
    const { chosen, ...rest } = resetIssueLayout(fields)
    expect(chosen).toBe(true)
    expect(rest).toEqual(seedIssueLayout(fields))
  })
})

describe('refusal', () => {
  it('gives the reason a move is refused, and null when it may go', () => {
    expect(refusal(base(), 'key', 'TOP')).toBe('locked')
    expect(refusal(base(), 'work', 'META')).toBe('locked')
    expect(refusal(base(), 'updated', 'TITLE')).toBe('slot')
    expect(refusal(base(), 'updated', 'BADGES')).toBeNull()
  })
  it('says a slot is full, and does not count the item against its own cap', () => {
    const full = placeItem(base(), 'updated', 'META')
    expect(refusal(full, 'field:a', 'META')).toBe('full')
    expect(refusal(full, 'status', 'META')).toBeNull()
  })
  it('says Links and a kind clash', () => {
    const withKind = placeItem(hideItem(base(), 'links'), 'github', 'BADGES')
    expect(refusal(withKind, 'links', 'META')).toBe('links')
    expect(refusal(base(), 'branch', 'BADGES')).toBe('links')
  })
})

describe('destination', () => {
  it('moves left and right within the slot, and stops at its ends', () => {
    expect(destination(base(), 'rollup', 'left')).toEqual({ slot: 'META', index: 0 })
    expect(destination(base(), 'rollup', 'right')).toEqual({ slot: 'META', index: 2 })
    expect(destination(base(), 'status', 'left')).toBeNull()
  })
  it('moves down into the next slot at its start, and up into the one above at its end', () => {
    expect(destination(base(), 'owner', 'down')).toEqual({ slot: 'BADGES', index: 0 })
    expect(destination(base(), 'owner', 'up')).toEqual({ slot: 'TOP', index: base().slots.TOP.length })
    expect(destination(base(), 'parent', 'up')).toBeNull()
  })
  it('hides an item going down from FOOT, since Available is the slot after it', () => {
    const foot = placeItem(base(), 'updated', 'FOOT')
    expect(destination(foot, 'updated', 'down')).toBe('hide')
  })
  it('enters FOOT at its end going up from Available, and goes nowhere else from there', () => {
    expect(destination(base(), 'updated', 'up')).toEqual({ slot: 'FOOT', index: 0 })
    expect(destination(base(), 'updated', 'down')).toBeNull()
  })
})

describe('moveTo', () => {
  it('applies a destination through the same model calls the menu uses', () => {
    expect(moveTo(base(), 'status', { slot: 'BADGES', index: 0 })).toEqual(placeItem(base(), 'status', 'BADGES', 0))
    expect(moveTo(base(), 'owner', 'hide')).toEqual(hideItem(base(), 'owner'))
  })
  it('lands a move past a cap as the layout it was, and a Work item the same way', () => {
    const full = placeItem(base(), 'updated', 'META')
    expect(moveTo(full, 'field:a', { slot: 'META', index: 0 })).toBe(full)
    const l = base()
    expect(moveTo(l, 'work', { slot: 'META', index: 0 })).toBe(l)
  })
})

describe('sameSlots', () => {
  it('says two layouts put every item in the same order, and not otherwise', () => {
    expect(sameSlots(base(), placeItem(base(), 'status', 'META', 0))).toBe(true)
    expect(sameSlots(base(), placeItem(base(), 'status', 'BADGES', 0))).toBe(false)
  })
})

describe('destination skips a slot at its cap', () => {
  const metaFull = (): CardLayout => ({ ...base(), slots: { TOP: ['parent'], META: ['status', 'rollup', 'owner', 'updated', 'health'], BADGES: [], FOOT: [] }, chosen: true })
  it('steps down past a full Meta to the first slot that takes the item, at its start', () => {
    expect(destination(metaFull(), 'parent', 'down')).toEqual({ slot: 'BADGES', index: 0 })
  })
  it('steps up past a full Meta to Top, at its end', () => {
    const l = { ...base(), slots: { TOP: ['parent'], META: ['status', 'rollup', 'owner', 'updated', 'health'], BADGES: ['kind'], FOOT: [] }, chosen: true }
    expect(destination(l, 'kind', 'up')).toEqual({ slot: 'TOP', index: 1 })
  })
  it('hides an item going down when every slot below it is full, since Available takes it', () => {
    const l = { ...base(), slots: { TOP: ['parent', 'kind', 'health'], META: ['status', 'rollup', 'owner', 'updated', 'links'], BADGES: ['field:a'], FOOT: ['field:b', 'field:c', 'field:d'] }, chosen: true }
    expect(destination(l, 'field:a', 'down')).toBe('hide')
  })
})

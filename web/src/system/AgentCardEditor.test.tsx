// @vitest-environment jsdom
// The agent card editor (S-1438 PR 8): the desktop and phone editors over the agent layout. A move goes through the model and
// hands up one layout; a refused move writes nothing and says why; the ISSUE switch sets the nested card on or off.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCardLayout, type CardLayout } from '../card-layout'
import { FIELDS, TREE } from '../stories/itsaFixtures'
import { ACTIVITY, COSTS } from '../stories/workFixtures'
import { agent } from '../stories/fixtures'
import { cardItemsFor } from '../work/card-items'
import type { WorkExtras } from '../work/data'
import { AgentCardEditor, AgentCardPhoneEditor } from './AgentCardEditor'

const extras: WorkExtras = { costs: COSTS, activity: ACTIVITY, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }
const items = cardItemsFor('agent', FIELDS)
const AGENTS = [agent({ id: 'ac-a', name: 'fixture-a' }), agent({ id: 'ac-b', name: 'fixture-b' })]

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const props = (layout: CardLayout, onChange = vi.fn()) => ({
  layout, issue: defaultCardLayout('issue'), items, fields: FIELDS, agents: AGENTS, itsas: TREE, extras, onChange, onReset: () => {},
})
async function draw(layout: CardLayout, phone = false) {
  const onChange = vi.fn()
  const p = props(layout, onChange)
  await act(async () => { root.render(phone ? <AgentCardPhoneEditor {...p} /> : <AgentCardEditor {...p} />) })
  const click = async (sel: string) => { await act(async () => { host.querySelector<HTMLElement>(sel)!.click() }) }
  const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) }) }
  return { onChange, click, key }
}
const menuItem = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('[role=menu] [role=menuitem]')].find((b) => b.textContent === text)!

describe('AgentCardEditor, desktop', () => {
  it('draws the locked mark and name in HEAD, the ISSUE switch on, the hairline, and the real card as the preview', async () => {
    await draw(defaultCardLayout('agent'))
    expect(host.querySelector('[data-slot="HEAD"] .ice-chip.locked')?.textContent).toContain('Mark')
    expect(host.querySelectorAll('[data-slot="HEAD"] .ice-chip.locked')).toHaveLength(2)
    expect(host.querySelector<HTMLInputElement>('[data-slot="ISSUE"] input[role=switch]')?.checked).toBe(true)
    expect(host.querySelector('[aria-label="Context hairline"]')).not.toBeNull()
    expect(host.querySelector('.ice-preview-card .sv-card')).not.toBeNull()
  })

  it('sizes the preview by its empty BADGES row, as the system view does: no badges is a zero row', async () => {
    const empty = { ...defaultCardLayout('agent'), slots: { ...defaultCardLayout('agent').slots, BADGES: [] } }
    await draw(empty)
    const preview = host.querySelector<HTMLElement>('.aec-preview')!
    expect(preview.style.getPropertyValue('--sv-badges-h')).toBe('calc(var(--space-4) * 0)')
    expect(preview.style.getPropertyValue('--sv-foot-h')).toBe('calc(var(--space-4) * 1)')
  })

  it('turns the nested issue card off through the ISSUE switch, and hands up the layout with ISSUE empty', async () => {
    const { onChange, click } = await draw(defaultCardLayout('agent'))
    await click('[data-slot="ISSUE"] input[role=switch]')
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.ISSUE).toEqual([])
    expect(next.chosen).toBe(true)
  })

  it('moves a badge from BADGES to FOOT from its ⋯ menu, in one write', async () => {
    const { onChange, click } = await draw(defaultCardLayout('agent'))
    await click('[aria-label="Options for Health"]')
    await act(async () => { menuItem('Move to Foot').click() })
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.FOOT).toEqual(['activity', 'health'])
    expect(next.slots.BADGES).toEqual(['review', 'tests'])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('moves a badge with the keys: Space lifts, the arrow steps, and Space drops it once', async () => {
    const { onChange, key } = await draw(defaultCardLayout('agent'))
    const chip = host.querySelector('[data-slot="BADGES"] [data-item="health"]')!
    await key(chip, ' ')
    await key(chip, 'ArrowRight')
    await key(chip, ' ')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect((onChange.mock.calls[0][0] as CardLayout).slots.BADGES).toEqual(['review', 'health', 'tests'])
  })

  it('moves Cost from HEAD to the start of BADGES with the keys: Space lifts, ArrowDown steps over ISSUE, Space drops', async () => {
    const { onChange, key } = await draw(defaultCardLayout('agent'))
    // A step that lands the chip in another row remounts it, and the focus follows it (CardEditor), so each key goes to the chip as it is now.
    const cost = () => host.querySelector('[data-item="cost"]')!
    await key(cost(), ' ')
    await key(cost(), 'ArrowDown')
    await key(cost(), ' ')
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.HEAD).toEqual(['model'])
    expect(next.slots.BADGES).toEqual(['cost', 'health', 'review', 'tests'])
  })

  it('leaves the locked name out of every slot and the Available list, so it can never be moved', async () => {
    await draw(defaultCardLayout('agent'))
    expect(host.querySelector('[data-item="name"]')).toBeNull()
    expect(host.querySelector('[aria-label="Available"] [data-item="name"]')).toBeNull()
  })

  it('refuses a move the model refuses, shows why in its menu, and writes nothing', async () => {
    const { onChange, click } = await draw(defaultCardLayout('agent'))
    await click('[aria-label="Options for Model"]')
    const toIssue = menuItem('Move to Issue')
    expect(toIssue.disabled).toBe(true)
    expect(toIssue.title).toBe("Model doesn't go in Issue")
    await act(async () => { toIssue.click() })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('AgentCardPhoneEditor', () => {
  it('moves a row up and down within its slot, by its ↑ and ↓', async () => {
    const { onChange, click } = await draw(defaultCardLayout('agent'), true)
    await click('[data-item="model"] [data-act=down]')
    expect((onChange.mock.calls[0][0] as CardLayout).slots.HEAD).toEqual(['cost', 'model'])
  })

  it('moves the first FOOT row up into the end of BADGES, across a slot boundary', async () => {
    const { onChange, click } = await draw(defaultCardLayout('agent'), true)
    await click('[data-item="activity"] [data-act=up]')
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.BADGES).toEqual(['health', 'review', 'tests', 'activity'])
    expect(next.slots.FOOT).toEqual([])
  })

  it('moves the last BADGES row down into the start of FOOT', async () => {
    const { onChange, click } = await draw(defaultCardLayout('agent'), true)
    await click('[data-item="tests"] [data-act=down]')
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.FOOT).toEqual(['tests', 'activity'])
  })

  it('moves a ↓ from the last HEAD row over ISSUE into the start of BADGES, in one write', async () => {
    const { onChange, click } = await draw(defaultCardLayout('agent'), true)
    await click('[data-item="cost"] [data-act=down]')
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.HEAD).toEqual(['model'])
    expect(next.slots.BADGES).toEqual(['cost', 'health', 'review', 'tests'])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('moves a ↑ from the first BADGES row over ISSUE into the end of HEAD', async () => {
    const { onChange, click } = await draw(defaultCardLayout('agent'), true)
    await click('[data-item="health"] [data-act=up]')
    const next = onChange.mock.calls[0][0] as CardLayout
    expect(next.slots.HEAD).toEqual(['model', 'cost', 'health'])
    expect(next.slots.BADGES).toEqual(['review', 'tests'])
  })
})

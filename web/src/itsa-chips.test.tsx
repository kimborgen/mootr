// @vitest-environment jsdom
// ITSA chips on an agent's tab (S-1452): the topmost owned ITSAs, folded into a pill when they don't fit.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tab } from './shell/Tab'
import { setData } from './store'
import type { Agent, Itsa, ItsaStatus } from './types'
import { ItsaChips, setClock, WaitBadges, WaitThinBar } from './waits'

const openItsa = vi.hoisted(() => vi.fn())
vi.mock('./itsa/itsa', async (orig) => ({ ...(await orig<typeof import('./itsa/itsa')>()), openItsa }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent = { id: 'a1', name: 'lead', harness: 'claude', model: 'm', lifecycle: 'active', activity: 'idle', machine: 'alpha', cwd: '/w', created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z', parents: [] } as unknown as Agent
const x = (id: string, o: Partial<Itsa> = {}): Itsa => ({ id, key: 'S-' + id, title: 'Title ' + id, parent_id: null, status: 'in_progress', owner: 'a1', ...o } as Itsa)
const statuses: ItsaStatus[] = [{ name: 'in_progress', category: 'active', human: false }, { name: 'done', category: 'closed', human: false }, { name: 'needs_input', category: 'active', human: true }]

type RO = (entries?: { contentRect: { width: number } }[]) => void
const observers: RO[] = []
let host: HTMLDivElement, root: Root, room = 300
const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
const RO = globalThis.ResizeObserver

const chipsW = (el: Element) => [...el.children].filter((c) => !c.classList.contains('wait-pop')).length * 40
beforeEach(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { constructor(cb: RO) { observers.push(cb) } observe() {} disconnect() {} } as unknown as typeof ResizeObserver
  document.documentElement.style.setProperty('--size-tab-name-min', '48px')
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) {
    if (this.classList.contains('itsa-chips')) return chipsW(this)
    if (this.classList.contains('wait-badges')) return this.children.length * 30
    return 0
  } })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return this.classList.contains('tab') ? room : 0 } })
  openItsa.mockClear()
  observers.length = 0
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width); delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth; document.documentElement.style.removeProperty('--size-tab-name-min'); globalThis.ResizeObserver = RO })

const onSelect = vi.fn(), onClose = vi.fn()
const mount = async (itsas: Itsa[], thin = false) => {
  onSelect.mockClear(); onClose.mockClear()
  setData({ agents: [agent], itsas, itsaStatuses: statuses })
  await act(async () => { root.render(<><div className="tabs"><Tab id="agent:a1" title="lead" glyph={null} chips={<ItsaChips id="a1" tabKey="agent:a1" />} onSelect={onSelect} onClose={onClose} /></div>{thin ? <WaitThinBar k="agent:a1" /> : null}</>) })
}
const keys = () => [...host.querySelectorAll('.tab [data-itsa]')].map((b) => b.textContent)

// A flex gap between the tab's children, as its stylesheet gives it: the fit counts one per shown slot.
const gapCss = document.createElement('style')
gapCss.textContent = '.tab { column-gap: 6px; }'
beforeEach(() => { document.head.append(gapCss) })
afterEach(() => { gapCss.remove() })

describe('ItsaChips beside wait badges', () => {
  const w = (kind: string) => ({ id: 'w-' + kind, kind, since: '2026-10-18T11:00:00Z', source: 'wait_for' })
  const both = async (r: number) => {
    room = r
    setData({ agents: [{ ...agent, waits: [w('children'), w('job'), w('timer')] } as Agent], itsas: [x('1'), x('2')], itsaStatuses: statuses })
    await act(async () => { root.render(<div className="tabs"><Tab id="agent:a1" title="lead" glyph={null} chips={<><WaitBadges id="a1" tabKey="agent:a1" /><ItsaChips id="a1" tabKey="agent:a1" /></>} onSelect={onSelect} /></div>) })
    const n = (s: string) => host.querySelectorAll(`.tab ${s}`).length
    room = 300
    return { waits: n('[data-wait]'), chips: n('[data-itsa]') }
  }
  it('keeps everything while there is room', async () => { expect(await both(400)).toEqual({ waits: 3, chips: 2 }) })
  it('folds the chips before the waits: the waits keep their room first', async () => {
    const s = await both(190)
    expect(s.waits).toBe(3)
    expect(s.chips).toBe(1)
  })
  it('settles when nothing fits, without a render loop', async () => { await both(40) })
  it('measures again when only the waits shrink, and the chips take the room', async () => {
    const waits = (n: number) => ({ ...agent, waits: [w('children'), w('job'), w('timer')].slice(0, n) } as Agent)
    room = 150
    const render = async (n: number) => {
      setData({ agents: [waits(n)], itsas: [x('1'), x('2')], itsaStatuses: statuses })
      await act(async () => { root.render(<div className="tabs"><Tab id="agent:a1" title="lead" glyph={null} chips={<><WaitBadges id="a1" tabKey="agent:a1" /><ItsaChips id="a1" tabKey="agent:a1" /></>} onSelect={onSelect} /></div>) })
    }
    await render(3)
    expect(host.querySelectorAll('.tab [data-itsa]').length).toBe(0)
    await render(1)
    expect([...host.querySelectorAll('.tab [data-itsa]')].map((b) => b.textContent)).toEqual(['2 ITSAs'])
    room = 300
  })
})

describe('ItsaChips', () => {
  it('shows nothing for an agent that owns none', async () => {
    await mount([x('1', { owner: 'b' })])
    expect(host.querySelector('[data-itsa]')).toBeNull()
  })
  it('shows only the top ITSA of an owned chain, with its title in the tooltip', async () => {
    await mount([x('1'), x('2', { parent_id: '1' }), x('3', { parent_id: '2' })])
    expect(keys()).toEqual(['S-1'])
    expect(host.querySelector('[data-itsa]')?.getAttribute('title')).toBe('S-1 Title 1 · in progress')
  })
  it('shows siblings as chips while they fit, and updates when an ITSA closes or changes owner', async () => {
    await mount([x('1'), x('2')])
    expect(keys()).toEqual(['S-1', 'S-2'])
    await mount([x('1'), x('2', { status: 'done' })])
    expect(keys()).toEqual(['S-1'])
    await mount([x('1', { owner: 'b' }), x('2')])
    expect(keys()).toEqual(['S-2'])
  })
  it('marks an ITSA that waits on the human', async () => {
    await mount([x('1', { status: 'needs_input' })])
    expect(host.querySelector('[data-itsa]')?.classList.contains('waits')).toBe(true)
  })
  it('opens the ITSA on a click, and the click never selects the tab', async () => {
    await mount([x('1')])
    await act(async () => { host.querySelector<HTMLElement>('[data-itsa="1"]')!.click() })
    expect(openItsa).toHaveBeenCalledWith('1')
    expect(onSelect).not.toHaveBeenCalled()
  })
  it('does not close the tab on a middle click or select it on a press or a menu', async () => {
    await mount([x('1')])
    const chip = host.querySelector<HTMLElement>('[data-itsa="1"]')!
    await act(async () => { chip.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })) })
    await act(async () => { chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    expect(onClose).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })
  it('folds several into one pill when they do not fit, and the popover opens one without selecting the tab', async () => {
    room = 150
    await mount([x('1'), x('2'), x('3')])
    expect(keys()).toEqual(['3 ITSAs'])
    await act(async () => { host.querySelector<HTMLElement>('[data-itsa=folded]')!.click() })
    expect(onSelect).not.toHaveBeenCalled()
    const pop = document.querySelector('.wait-pop')!
    expect(pop.textContent).toContain('S-2 Title 2')
    await act(async () => { pop.querySelector<HTMLElement>('[data-itsa="2"]')!.click() })
    expect(openItsa).toHaveBeenCalledWith('2')
    expect(document.querySelector('.wait-pop')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
    room = 300
  })
  it('keeps a lone ITSA a chip however tight the tab is', async () => {
    room = 100
    await mount([x('1')])
    expect(keys()).toEqual(['S-1'])
    room = 300
  })
  it('puts the chips in the thin bar when even the pill leaves the name too little', async () => {
    room = 70
    await mount([x('1'), x('2')], true)
    expect(host.querySelector('.tab [data-itsa]')).toBeNull()
    expect([...host.querySelectorAll('.wait-thin [data-itsa]')].map((b) => b.textContent)).toEqual(['S-1', 'S-2'])
    room = 300
  })
})

// The room doesn't change with the slot's own mode, so a room a hair over or under the floor settles in
// one mode instead of cycling between two (React #185). A gap of 6 px sits between a tab's children.
describe('fit near the floor', () => {
  const w = (kind: string) => ({ id: 'w-' + kind, kind, since: '2026-10-18T11:00:00Z', source: 'wait_for' })
  const at = async (r: number, which: 'waits' | 'chips') => {
    room = r
    setData({ agents: [{ ...agent, waits: which === 'waits' ? [w('children'), w('job'), w('timer')] : [] } as Agent], itsas: which === 'chips' ? [x('1'), x('2')] : [], itsaStatuses: statuses })
    await act(async () => { root.render(<div className="tabs"><Tab id="agent:a1" title="lead" glyph={null} chips={which === 'waits' ? <WaitBadges id="a1" tabKey="agent:a1" /> : <ItsaChips id="a1" tabKey="agent:a1" />} onSelect={() => {}} /></div>) })
    const shown = () => [...host.querySelectorAll('.tab [data-wait], .tab [data-itsa]')].map((b) => b.getAttribute('data-wait') ?? b.getAttribute('data-itsa'))
    const first = shown()
    // Everything measured again, as on a resize: the same mode, not the other one.
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    expect(shown()).toEqual(first)
    room = 300
    return first
  }
  // Three badges are 90 px, two chips 80; each plus its gap, then 48 px of name: 144 and 134.
  it('keeps every wait badge at the exact floor', async () => { expect(await at(144, 'waits')).toHaveLength(3) })
  it('folds the wait badges a pixel under it, and not for the 6 px band above', async () => { expect(await at(143, 'waits')).toEqual(['folded']) })
  it('keeps both chips at the exact floor', async () => { expect(await at(134, 'chips')).toHaveLength(2) })
  it('folds the chips a pixel under it', async () => { expect(await at(133, 'chips')).toEqual(['folded']) })
})

describe('a drag from a chip', () => {
  it('does not start the tab\'s drag', async () => {
    const onDragStart = vi.fn()
    setData({ agents: [agent], itsas: [x('1')], itsaStatuses: statuses })
    await act(async () => { root.render(<Tab id="agent:a1" title="lead" glyph={null} chips={<ItsaChips id="a1" tabKey="agent:a1" />} onSelect={() => {}} onDragStart={onDragStart} draggable />) })
    const chip = host.querySelector<HTMLElement>('[data-itsa="1"]')!
    expect(chip.getAttribute('draggable')).toBe('false')
    await act(async () => { chip.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true })) })
    expect(onDragStart).not.toHaveBeenCalled()
  })
  // A browser starts the drag on the draggable tab, so the dragstart arrives there: it is the press that tells them apart (S-1872).
  it('cancels the tab\'s dragstart when the press began on a chip, and not when it began on the name', async () => {
    const onDragStart = vi.fn()
    setData({ agents: [agent], itsas: [x('1')], itsaStatuses: statuses })
    await act(async () => { root.render(<Tab id="agent:a1" title="lead" glyph={null} chips={<ItsaChips id="a1" tabKey="agent:a1" />} onSelect={() => {}} onDragStart={onDragStart} draggable />) })
    const tabEl = host.querySelector<HTMLElement>('.tab')!
    host.querySelector<HTMLElement>('[data-itsa="1"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    const fromChip = new Event('dragstart', { bubbles: true, cancelable: true })
    await act(async () => { tabEl.dispatchEvent(fromChip) })
    expect(fromChip.defaultPrevented).toBe(true)
    expect(onDragStart).not.toHaveBeenCalled()
    host.querySelector<HTMLElement>('.label')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    const fromName = new Event('dragstart', { bubbles: true, cancelable: true })
    await act(async () => { tabEl.dispatchEvent(fromName) })
    expect(fromName.defaultPrevented).toBe(false)
    expect(onDragStart).toHaveBeenCalledTimes(1)
  })
})

// The chips are measured with the wait badges beside them, and a timer's text is part of the badge's width: a badge
// that grows a character (`1m` to `59s`) takes room the chips had measured, so they measure again (S-1872).
describe('a timer whose text grows', () => {
  let now = Date.parse('2026-10-18T12:00:00Z')
  beforeEach(() => {
    vi.useFakeTimers()
    setClock(() => now)
    // A badge is 30 px and 6 px a character of its text; the chips are 40 px each, as above.
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) {
      if (this.classList.contains('itsa-chips')) return chipsW(this)
      if (this.classList.contains('wait-badges')) return this.children.length * 30 + (this.textContent?.length ?? 0) * 6
      return 0
    } })
  })
  afterEach(() => { setClock(null); vi.useRealTimers(); room = 300 })
  it('re-measures the chips when the text grows, so the name keeps its floor', async () => {
    // Beside `1m` (42 px) two chips (80 px) and their gaps leave the name 52 px: each. Beside `59s` (48 px) it is 46 px: folded.
    room = 186
    const timer = { id: 'w-t', kind: 'timer', since: '2026-10-18T11:00:00Z', source: 'wait_for', until: new Date(now + 60_000).toISOString() }
    setData({ agents: [{ ...agent, waits: [timer] } as Agent], itsas: [x('1'), x('2')], itsaStatuses: statuses })
    await act(async () => { root.render(<div className="tabs"><Tab id="agent:a1" title="lead" glyph={null} chips={<><WaitBadges id="a1" tabKey="agent:a1" /><ItsaChips id="a1" tabKey="agent:a1" /></>} onSelect={() => {}} /></div>) })
    expect(host.querySelector('[data-wait=timer]')?.textContent).toBe('1m')
    expect(host.querySelector('.tab [data-itsa="folded"]')).toBeNull()
    now += 1000
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(host.querySelector('[data-wait=timer]')?.textContent).toBe('59s')
    expect(host.querySelector('.tab [data-itsa="folded"]')).not.toBeNull()
  })
})

describe('a resize callback', () => {
  const w = (kind: string) => ({ id: 'w-' + kind, kind, since: '2026-10-18T11:00:00Z', source: 'wait_for' })
  it('with the width already seen keeps what was measured, and a new width starts again', async () => {
    room = 120
    setData({ agents: [{ ...agent, waits: [w('children'), w('job'), w('timer')] } as Agent], itsas: [], itsaStatuses: statuses })
    await act(async () => { root.render(<div className="tabs"><Tab id="agent:a1" title="lead" glyph={null} chips={<WaitBadges id="a1" tabKey="agent:a1" />} onSelect={() => {}} /></div>) })
    const folded = () => host.querySelectorAll('[data-wait=folded]').length
    expect(folded()).toBe(1)
    // A reset starts from `each`, which draws the per-kind badges for a moment: watch for them.
    let flashed = false
    const mo = new MutationObserver((rs) => { if (rs.some((r) => [...r.addedNodes].some((n) => n instanceof Element && (n.matches('[data-wait]:not([data-wait=folded])') || n.querySelector('[data-wait]:not([data-wait=folded])'))))) flashed = true })
    mo.observe(host, { childList: true, subtree: true })
    const cb = observers[0]
    await act(async () => { cb([{ contentRect: { width: 157 } }]) })
    flashed = false
    await act(async () => { cb([{ contentRect: { width: 157 } }]) })
    expect(flashed).toBe(false)
    expect(folded()).toBe(1)
    await act(async () => { cb([{ contentRect: { width: 158 } }]) })
    expect(flashed).toBe(true)
    expect(folded()).toBe(1)
    mo.disconnect()
    room = 300
  })
})

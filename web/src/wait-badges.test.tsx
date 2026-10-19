// @vitest-environment jsdom
// Wait badges on an agent's tab (S-1433 PR 3): one per kind, a countdown from an injected clock.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tab } from './shell/Tab'
import { setData } from './store'
import type { Agent, Wait } from './types'
import { countdown, setClock, WaitBadges, WaitThinBar } from './waits'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-10-18T12:00:00Z')
const w = (kind: string, o: Partial<Wait> = {}): Wait => ({ id: 'w-' + kind + (o.detail ?? ''), kind, since: '2026-10-18T11:00:00Z', source: 'wait_for', ...o })
const agent = (waits: Wait[]): Agent => ({
  id: 'a1', name: 'lead', harness: 'claude', model: 'm', lifecycle: 'active', activity: 'waiting', machine: 'alpha', cwd: '/w',
  created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z', parents: [], waits,
} as Agent)

let host: HTMLDivElement, root: Root, now = T0, phone = false
beforeEach(() => { phone = false; window.matchMedia = ((q: string) => ({ matches: phone && q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia; vi.useFakeTimers(); now = T0; setClock(() => now); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); setClock(null); vi.useRealTimers() })

describe('countdown', () => {
  it('says seconds under a minute, then minutes, hours, days', () => {
    expect(countdown(T0 + 45_000, T0)).toBe('45s')
    expect(countdown(T0 + 4 * 60_000, T0)).toBe('4m')
    expect(countdown(T0 + 61_000, T0)).toBe('2m')
    expect(countdown(T0 + 2 * 3600_000, T0)).toBe('2h')
    expect(countdown(T0 + 3 * 86400_000, T0)).toBe('3d')
    expect(countdown(T0 - 5000, T0)).toBe('0s')
    expect(countdown(T0 + 59 * 60_000 + 30_000, T0)).toBe('1h')
    expect(countdown(T0 + 23 * 3600_000 + 40 * 60_000, T0)).toBe('1d')
  })
})

describe('WaitBadges', () => {
  const mount = async (a: Agent, onSelect = vi.fn()) => {
    setData({ agents: [a] })
    await act(async () => { root.render(<Tab id="agent:a1" title="lead" glyph={null} chips={<WaitBadges id="a1" />} onSelect={onSelect} />) })
    return onSelect
  }
  it('draws one badge per kind with a count, named for its wait', async () => {
    await mount(agent([w('children', { detail: 'a' }), w('children', { detail: 'b' }), w('job', { detail: 'job npm test' }), w('human')]))
    const kinds = [...host.querySelectorAll('[data-wait]')].map((b) => b.getAttribute('data-wait'))
    expect(kinds).toEqual(['human', 'children', 'job'])
    expect(host.querySelector('[data-wait=children]')?.textContent).toBe('2')
    expect(host.querySelector('[data-wait=job]')?.getAttribute('aria-label')).toBe('Waiting for job npm test')
    expect(host.querySelector('[data-wait=job]')?.getAttribute('title')).toBe('Waiting for job npm test')
  })
  it('counts a timer down on the shared ticker', async () => {
    await mount(agent([w('timer', { until: new Date(T0 + 70_000).toISOString() })]))
    const t = () => host.querySelector('[data-wait=timer]')?.textContent
    expect(t()).toBe('2m')
    now = T0 + 20_000
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(t()).toBe('50s')
    now = T0 + 69_000
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(t()).toBe('1s')
  })
  it('shows the soonest of several timers', async () => {
    await mount(agent([w('timer', { id: 't1', until: new Date(T0 + 600_000).toISOString() }), w('timer', { id: 't2', until: new Date(T0 + 90_000).toISOString() })]))
    expect(host.querySelector('[data-wait=timer]')?.textContent).toBe('2m')
  })
  it('does not select the tab when a badge is clicked', async () => {
    const onSelect = await mount(agent([w('agent', { target: 'a1' })]))
    await act(async () => { host.querySelector<HTMLElement>('[data-wait=agent]')!.click() })
    expect(onSelect).not.toHaveBeenCalled()
  })
  it('is informational only on a phone, where a tap selects the tab', async () => {
    phone = true
    const onSelect = await mount(agent([w('agent', { target: 'a1' })]))
    expect(host.querySelector('button[data-wait]')).toBeNull()
    await act(async () => { host.querySelector<HTMLElement>('[data-wait=agent]')!.click() })
    expect(onSelect).toHaveBeenCalled()
  })
  it('leaves a human wait to the approval badge when a request is pending', async () => {
    await mount({ ...agent([w('human', { target: 'p1' }), w('job', { detail: 'j' })]), pending_requests: 1 })
    expect([...host.querySelectorAll('[data-wait]')].map((b) => b.getAttribute('data-wait'))).toEqual(['job'])
    await mount(agent([w('human', { target: 'p1' })]))
    expect(host.querySelector('[data-wait=human]')).not.toBeNull()
  })
  it('draws nothing for an agent that waits for nothing', async () => {
    await mount(agent([]))
    expect(host.querySelector('[data-wait]')).toBeNull()
  })
})

// Fit (S-1659): jsdom has no layout, so a tab's width is stubbed. The label takes what the room
// leaves beside the badges, and each badge is 30 px, so a tab of `room` px holds the badges while
// they fit beside a name of at least 48 px (the token).
describe('a tight tab', () => {
  let room = 200
  const rooms: Record<string, number> = {}
  // A width that overrides the badges' own, so a test can make the first read bad.
  let wrapW: number | undefined
  let fire = () => {}
  // A badge is a child of the chips that is not the popover (which is fixed, so takes no room).
  const badges = (el: Element) => [...el.children].filter((c) => !c.classList.contains('wait-pop')).length
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
  const RO = globalThis.ResizeObserver
  beforeEach(() => {
    globalThis.ResizeObserver = class { constructor(cb: () => void) { fire = cb } observe() {} disconnect() {} } as unknown as typeof ResizeObserver
    document.documentElement.style.setProperty('--size-tab-name-min', '48px')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) {
      if (this.classList.contains('wait-badges')) return wrapW ?? badges(this) * 30
      return 0
    } })
    // The tab's own width is the room: its other children (the label, a glyph) take none here.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return this.classList.contains('tab') ? rooms[this.getAttribute('data-key') ?? ''] ?? room : 0 } })
  })
  afterEach(() => { Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width); delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth; document.documentElement.style.removeProperty('--size-tab-name-min'); globalThis.ResizeObserver = RO })
  const three = [w('children', { detail: 'a' }), w('job', { detail: 'job npm test' }), w('timer', { until: new Date(T0 + 600_000).toISOString() })]
  const tab = async (ws: Wait[], thin = false) => {
    setData({ agents: [agent(ws)] })
    await act(async () => { root.render(<><Tab id="agent:a1" title="lead" glyph={null} chips={<WaitBadges id="a1" tabKey="agent:a1" />} onSelect={onSelect} />{thin ? <WaitThinBar k="agent:a1" /> : null}</>) })
  }
  const onSelect = vi.fn()
  beforeEach(() => onSelect.mockClear())

  it('keeps one badge per kind while they fit beside the name', async () => {
    room = 200
    await tab(three)
    expect([...host.querySelectorAll('[data-wait]')].map((b) => b.getAttribute('data-wait'))).toEqual(['children', 'job', 'timer'])
  })
  it('folds them into one combined badge with the total, when they do not', async () => {
    room = 100
    await tab(three)
    const folded = host.querySelectorAll('[data-wait]')
    expect(folded.length).toBe(1)
    expect(folded[0].getAttribute('data-wait')).toBe('folded')
    expect(folded[0].textContent).toBe('3')
    expect(folded[0].getAttribute('aria-label')).toMatch(/^Waiting for a, job npm test, timer \d/)
  })
  it('warns on the folded badge when any kind waits on the human', async () => {
    room = 100
    await tab([...three, w('human', { target: 'p1' })])
    expect(host.querySelector('[data-wait=folded]')?.classList.contains('warn')).toBe(true)
  })
  it('hides the strip badges when even the folded one does not fit, and the thin bar carries them', async () => {
    room = 60
    await tab(three, true)
    expect(host.querySelector('.tabs [data-wait]') ?? host.querySelector('.tab [data-wait]')).toBeNull()
    expect(host.querySelectorAll('.wait-thin [data-wait]').length).toBe(3)
  })
  it('opens the list of waits from the folded badge without selecting the tab, and closes on Escape', async () => {
    room = 100
    await tab(three)
    await act(async () => { host.querySelector<HTMLElement>('[data-wait=folded]')!.click() })
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.querySelector('.wait-pop')?.textContent).toContain('job npm test')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('.wait-pop')).toBeNull()
  })
  it('closes the popover on a press outside the badge', async () => {
    room = 100
    await tab(three)
    await act(async () => { host.querySelector<HTMLElement>('[data-wait=folded]')!.click() })
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(document.querySelector('.wait-pop')).toBeNull()
  })
  it('keeps each tab\'s own fit, whatever the other tabs fit', async () => {
    // Two tabs of two agents, each with its own room: the tight one folds, the roomy one keeps its badges.
    rooms['agent:a1'] = 100
    rooms['agent:a2'] = 300
    setData({ agents: [agent(three), { ...agent(three), id: 'a2', name: 'other' }] })
    await act(async () => { root.render(<><Tab id="agent:a1" title="lead" glyph={null} chips={<WaitBadges id="a1" tabKey="agent:a1" />} onSelect={onSelect} />
      <Tab id="agent:a2" title="other" glyph={null} chips={<WaitBadges id="a2" tabKey="agent:a2" />} onSelect={onSelect} /></>) })
    expect(host.querySelector('[data-key="agent:a1"] [data-wait=folded]')).not.toBeNull()
    expect(host.querySelectorAll('[data-key="agent:a2"] [data-wait]').length).toBe(3)
    delete rooms['agent:a1']; delete rooms['agent:a2']
  })
  it('recovers from a bad first measurement on the next resize', async () => {
    // Every mode reads huge at first, so the tab ends up none; a resize, with the widths normal again, starts over.
    wrapW = 1000
    await tab(three)
    expect(host.querySelector('.wait-thin, [data-wait]')).toBeNull()
    wrapW = undefined
    await act(async () => { fire() })
    expect(host.querySelector('[data-wait=folded]')).not.toBeNull()
  })
  it('measures again when the waits shrink: one kind fits, so it is each', async () => {
    room = 100
    await tab(three)
    expect(host.querySelector('[data-wait=folded]')).not.toBeNull()
    await tab([three[0]])
    expect(host.querySelector('[data-wait=folded]')).toBeNull()
    expect([...host.querySelectorAll('[data-wait]')].map((b) => b.getAttribute('data-wait'))).toEqual(['children'])
  })
  it('closes the popover when the tab is no longer folded, and does not bring it back', async () => {
    room = 100
    await tab(three)
    await act(async () => { host.querySelector<HTMLElement>('[data-wait=folded]')!.click() })
    expect(document.querySelector('.wait-pop')).not.toBeNull()
    room = 200
    await act(async () => { fire() })
    expect(document.querySelector('.wait-pop')).toBeNull()
    room = 100
    await act(async () => { fire() })
    expect(document.querySelector('.wait-pop')).toBeNull()
  })
  it('stays open for a scroll elsewhere, and closes on a scroll of its own strip', async () => {
    room = 100
    setData({ agents: [agent(three)] })
    await act(async () => { root.render(<div className="tabs"><Tab id="agent:a1" title="lead" glyph={null} chips={<WaitBadges id="a1" tabKey="agent:a1" />} onSelect={onSelect} /></div>) })
    await act(async () => { host.querySelector<HTMLElement>('[data-wait=folded]')!.click() })
    await act(async () => { document.body.dispatchEvent(new Event('scroll')) })
    expect(document.querySelector('.wait-pop')).not.toBeNull()
    await act(async () => { host.querySelector<HTMLElement>('.tabs')!.dispatchEvent(new Event('scroll')) })
    expect(document.querySelector('.wait-pop')).toBeNull()
  })
  it('returns focus to the folded badge on Escape', async () => {
    room = 100
    await tab(three)
    const badge = host.querySelector<HTMLElement>('[data-wait=folded]')!
    await act(async () => { badge.click() })
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('.wait-pop')).toBeNull()
    expect(document.activeElement).toBe(badge)
  })
  it('keeps a middle click or a menu on the popover from closing the tab', async () => {
    room = 100
    const onClose = vi.fn()
    setData({ agents: [agent(three)] })
    await act(async () => { root.render(<Tab id="agent:a1" title="lead" glyph={null} chips={<WaitBadges id="a1" tabKey="agent:a1" />} onSelect={onSelect} onClose={onClose} />) })
    await act(async () => { host.querySelector<HTMLElement>('[data-wait=folded]')!.click() })
    const pop = document.querySelector('.wait-pop')!
    await act(async () => { pop.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })) })
    expect(onClose).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
// A mail thread's tab chips (S-2311): the wait mark, the linked ITSAs and the agent marks, fitted as
// the tab narrows: the agents fold to one mark and +N, the ITSAs fold to a pill, the agents go to the thin bar.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tab } from './shell/Tab'
import { humanRowsOf } from './mail/thread-index'
import { setData } from './store'
import type { Agent, Itsa, ItsaStatus, Mail, Thread } from './types'
import { ThreadChips, WaitThinBar } from './waits'

vi.mock('./itsa/itsa', async (orig) => ({ ...(await orig<typeof import('./itsa/itsa')>()), openItsa: vi.fn(), openFromMail: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent = (id: string) => ({ id, name: id + '-name', harness: 'claude', model: 'm', lifecycle: 'active', activity: 'idle', machine: 'alpha', cwd: '/w', created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z', parents: [] }) as unknown as Agent
const itsa = (id: string): Itsa => ({ id, key: 'S-' + id, title: 'Title ' + id, parent_id: null, status: 'in_progress', owner: 'a1' }) as unknown as Itsa
const statuses: ItsaStatus[] = [{ name: 'in_progress', category: 'active', human: false }]
// Three agents on the thread, three ITSAs linked by its mail, and one unread mail for the human.
const mails = [
  { id: 'm1', from_id: 'a1', subject: 'Deploy plan', body: '', created_at: '2026-10-19T10:00:00Z', title: 'Deploy plan',
    recipients: [{ id: 'human', read_at: null }, { id: 'a2', read_at: null }], itsas: [{ id: '1', key: 'S-1', title: '', status: '', source: 'itsa' }, { id: '2', key: 'S-2', title: '', status: '', source: 'itsa' }], about_itsa: '3', agents: ['a3'] },
] as unknown as Mail[]
const thread: Thread = { thread_id: 't1', mails }

type RO = (entries?: { contentRect: { width: number } }[]) => void
const observers: RO[] = []
let host: HTMLDivElement, root: Root, room = 400
const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
const RO = globalThis.ResizeObserver

const chipsW = (el: Element) => el.children.length * 40
beforeEach(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { constructor(cb: RO) { observers.push(cb) } observe() {} disconnect() {} } as unknown as typeof ResizeObserver
  document.documentElement.style.setProperty('--size-tab-name-min', '48px')
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) {
    if (this.classList.contains('itsa-chips')) return chipsW(this)
    if (this.classList.contains('wait-badges') || this.classList.contains('agent-marks')) return this.children.length * 30
    if (this.classList.contains('lucide')) return 16
    if (this.classList.contains('label')) return 40
    if (this.classList.contains('icon-btn')) return 44
    return 0
  } })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return this.classList.contains('tab') ? room : 0 } })
  observers.length = 0
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount()); host.remove()
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width)
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  document.documentElement.style.removeProperty('--size-tab-name-min')
  globalThis.ResizeObserver = RO
})

// A flex gap between the tab's children, as its stylesheet gives it: the fit counts one per shown slot.
const gapCss = document.createElement('style')
gapCss.textContent = '.tab { column-gap: 6px; }'
beforeEach(() => { document.head.append(gapCss) })
afterEach(() => { gapCss.remove() })

const mount = async (r: number, thin = false) => {
  room = r
  setData({ agents: ['a1', 'a2', 'a3'].map(agent), itsas: ['1', '2', '3'].map(itsa), itsaStatuses: statuses, humanRows: humanRowsOf([thread]), openThreads: [], decisions: [], attention: [] } as never)
  await act(async () => { root.render(<><div className="tabs"><Tab id="thread:t1" title="Deploy plan" glyph={null} chips={<ThreadChips tid="t1" tabKey="thread:t1" />} onSelect={() => {}} /></div>{thin ? <WaitThinBar k="thread:t1" /> : null}</>) })
}
const tab = () => host.querySelector('.tab')!

// A thread tab's ITSA chip opens its ITSA beside the thread, as a mail's key does (S-93), not in place (S-1872).
describe('a thread tab\'s ITSA chip', () => {
  it('opens its ITSA beside the thread', async () => {
    const { openFromMail, openItsa } = await import('./itsa/itsa')
    await mount(400)
    await act(async () => { tab().querySelector<HTMLElement>('[data-itsa="1"]')!.click() })
    expect(openFromMail).toHaveBeenCalledWith('1', expect.any(Element))
    expect(openItsa).not.toHaveBeenCalled()
  })
})

describe('a thread tab\'s chips, fitted as one budget (S-1471 §2a)', () => {
  // With three ITSAs (40 px a chip, 120 whole) and three agents (30 px a mark, 90 whole, 60 folded),
  // the steps need 306, 276, 196, 130, 84 and 48 px of tab. The thin bar holds what the tab dropped.
  it('shows everything when the tab has room for it all', async () => {
    await mount(400, true)
    expect(tab().querySelector('[data-wait="unread"]')?.textContent).toBe('1')
    expect(tab().querySelectorAll('[data-itsa]').length).toBe(3)
    expect([...tab().querySelectorAll('.agent-marks [data-open-agent]')].map((b) => b.getAttribute('data-open-agent'))).toEqual(['a3', 'a1'])
    expect(tab().querySelector('.agent-more')?.textContent).toBe('+1')
    expect(host.querySelector('.wait-thin')).toBeNull()
  })

  it('folds the agents to one mark and +N first, the ITSAs still each', async () => {
    await mount(300, true)
    expect(tab().querySelectorAll('.agent-marks [data-open-agent]').length).toBe(1)
    expect(tab().querySelector('.agent-more')?.textContent).toBe('+2')
    expect(tab().querySelectorAll('[data-itsa]').length).toBe(3)
    expect(host.querySelector('.wait-thin')).toBeNull()
  })

  it('then folds the ITSAs to their pill, with the agents still folded', async () => {
    await mount(250, true)
    expect(tab().querySelector('[data-itsa="folded"]')?.textContent).toBe('3 ITSAs')
    expect(tab().querySelectorAll('.agent-marks [data-open-agent]').length).toBe(1)
    expect(host.querySelector('.wait-thin')).toBeNull()
  })

  it('then sends the agents to the thin bar, the ITSA pill still in the tab', async () => {
    await mount(150, true)
    expect(tab().querySelector('[data-itsa="folded"]')?.textContent).toBe('3 ITSAs')
    expect(tab().querySelector('.agent-marks')?.children.length).toBe(0)
    expect(host.querySelectorAll('.wait-thin [data-open-agent]').length).toBe(3)
    expect(host.querySelector('.wait-thin [data-itsa]')).toBeNull()
  })

  it('then sends the ITSAs to the thin bar too, the wait mark still in the tab', async () => {
    await mount(100, true)
    expect(tab().querySelector('[data-itsa]')).toBeNull()
    expect(tab().querySelector('[data-wait="unread"]')).not.toBeNull()
    expect(host.querySelectorAll('.wait-thin [data-itsa]').length).toBe(3)
    expect(host.querySelectorAll('.wait-thin [data-open-agent]').length).toBe(3)
  })

  it('takes the wait mark last, to the thin bar', async () => {
    await mount(60, true)
    expect(tab().querySelector('[data-wait]')).toBeNull()
    expect(host.querySelector('.wait-thin [data-wait="unread"]')).not.toBeNull()
  })
})

// A phone-sized tab (S-2311): a glyph and a close button take room the name needs, and the padding is
// the tab's own. At 227 px the name keeps its 48 px floor only once the agents are gone to the thin bar.
describe('a phone-sized thread tab', () => {
  const padCss = document.createElement('style')
  padCss.textContent = '.tab { padding: 0 6px 0 12px; }'
  beforeEach(() => { document.head.append(padCss) })
  afterEach(() => { padCss.remove() })

  it('keeps the name above its floor by sending the agents to the thin bar', async () => {
    room = 227
    setData({ agents: ['a1', 'a2', 'a3'].map(agent), itsas: ['1', '2', '3'].map(itsa), itsaStatuses: statuses, humanRows: humanRowsOf([thread]), openThreads: [], decisions: [], attention: [] } as never)
    await act(async () => { root.render(<><div className="tabs"><Tab id="thread:t1" title="Deploy plan" glyph={<span className="lucide" />} chips={<ThreadChips tid="t1" tabKey="thread:t1" />} onSelect={() => {}} onClose={() => {}} /></div><WaitThinBar k="thread:t1" /></>) })
    expect(tab().querySelector('.agent-marks')?.children.length).toBe(0)
    expect(host.querySelectorAll('.wait-thin [data-open-agent]').length).toBe(3)
  })

  // A name the layout truncates below its floor (40 px of text cut off, as on the real phone page) means
  // the step shown is too wide: the fit steps narrower until the name is whole, whatever the model said.
  it('steps narrower while the name is truncated under its floor', async () => {
    room = 400
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return this.classList.contains('label') ? 90 : 0 } })
    try {
      setData({ agents: ['a1', 'a2', 'a3'].map(agent), itsas: ['1', '2', '3'].map(itsa), itsaStatuses: statuses, humanRows: humanRowsOf([thread]), openThreads: [], decisions: [], attention: [] } as never)
      await act(async () => { root.render(<div className="tabs"><Tab id="thread:t1" title="Deploy plan" glyph={<span className="lucide" />} chips={<ThreadChips tid="t1" tabKey="thread:t1" />} onSelect={() => {}} onClose={() => {}} /></div>) })
      expect(tab().querySelector('.agent-marks')?.children.length).toBe(0)
      expect(tab().querySelector('[data-itsa]')).toBeNull()
    } finally {
      if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll)
      else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth
    }
  })
})

// The fit follows the tab's own size as the observer reports it (a resize), and the thread's agents (a `sig` change).
describe('a thread tab\'s chips follow its width and its agents', () => {
  const resize = async (w: number) => {
    room = w
    await act(async () => { for (const cb of observers) cb([{ contentRect: { width: w } }]) })
  }
  const seed = (ids: string[], ms: Mail[] = mails) => setData({ agents: ids.map(agent), itsas: ['1', '2', '3'].map(itsa), itsaStatuses: statuses, humanRows: humanRowsOf([{ thread_id: 't1', mails: ms }]), openThreads: [], decisions: [], attention: [] } as never)

  it('folds the chips as the tab narrows to 150, then brings them all back at 400', async () => {
    await mount(400, true)
    expect(tab().querySelectorAll('[data-itsa]').length).toBe(3)
    await resize(150)
    expect(tab().querySelector('.agent-marks')?.children.length).toBe(0)
    expect(tab().querySelector('[data-itsa="folded"]')?.textContent).toBe('3 ITSAs')
    expect(host.querySelectorAll('.wait-thin [data-open-agent]').length).toBe(3)
    await resize(400)
    expect(tab().querySelectorAll('[data-itsa]').length).toBe(3)
    expect(tab().querySelector('.agent-more')?.textContent).toBe('+1')
    expect(host.querySelector('.wait-thin')).toBeNull()
  })

  it('counts a fourth agent in the thread as +2 once the chips measure again', async () => {
    await mount(400)
    expect(tab().querySelector('.agent-more')?.textContent).toBe('+1')
    await act(async () => { seed(['a1', 'a2', 'a3', 'a4'], [{ ...mails[0], agents: ['a3', 'a4'] }] as Mail[]) })
    expect(tab().querySelector('.agent-more')?.textContent).toBe('+2')
  })

  // A name the layout truncates while the agents show in full: the fit steps narrower once, and the roomier
  // step is not tried again on each render. The label is read once per measure, so a settled squeeze reads it a few times.
  it('steps narrower once for a squeezed name and keeps that step', async () => {
    room = 400
    let reads = 0
    let squeezed = true
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get(this: HTMLElement) {
      if (!this.classList.contains('label')) return 0
      reads++
      return squeezed && tab().querySelectorAll('.agent-marks [data-open-agent]').length > 1 ? 90 : 0
    } })
    try {
      await mount(400)
      expect(tab().querySelectorAll('.agent-marks [data-open-agent]').length).toBe(1)
      expect(tab().querySelector('.agent-more')?.textContent).toBe('+2')
      expect(reads).toBeLessThanOrEqual(3)
      // The name no longer truncates and the tab is wider: the ceiling from the squeeze resets, so both agents show again.
      squeezed = false
      await resize(500)
      expect(tab().querySelectorAll('.agent-marks [data-open-agent]').length).toBe(2)
    } finally {
      if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll)
      else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth
    }
  })
})

// The flip guard of the thread's chips (S-1872): a roomier step is taken only four times in one task. The fifth holds
// the narrower step while it still fits, and the held step measures again once the counter clears.
describe('a thread tab\'s chips, held by the flip guard', () => {
  const resize = async (w: number) => {
    room = w
    await act(async () => { for (const cb of observers) cb([{ contentRect: { width: w } }]) })
  }
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); room = 400 })
  it('holds the fifth roomier step, and measures again once the count clears', async () => {
    await mount(400)
    // Narrow to the folded steps, then four roomier steps back to each, each one a flip.
    await resize(200)
    for (let i = 0; i < 4; i++) { await resize(310); await resize(200) }
    // The fifth roomier step: the folded step still fits at 310, so it is held.
    await resize(310)
    expect(tab().querySelector('[data-itsa="folded"]')).not.toBeNull()
    // The counter clears between tasks: the held step measures again, and the roomy step is taken.
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(tab().querySelectorAll('[data-itsa]').length).toBe(3)
  })
})

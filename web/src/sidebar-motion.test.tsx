// @vitest-environment jsdom
// S-698: the sidebar's row motion triggers, through the S-696 gate. A stamp on a changed mark,
// one stamp per burst, a spend bar that eases only when spend grows, and a nudge when a row's
// owned issue changes status. Nothing fires when the gate says no.
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMotionPrefs } from './motion-gate'
import { nudgePx, SpendBar, Stamp, TreeRow } from './sidebar-motion'

// Motion's `animate` is stubbed, so a test can see each run and whether it was stopped: the
// coalescing and first-draw rules are about which runs start and stop, not about the frames.
const runs = vi.hoisted(() => [] as { stopped: number }[])
vi.mock('motion/react', () => ({
  animate: () => { const run = { stopped: 0 }; runs.push(run); return { stop: () => { run.stopped++ } } },
}))

let root: Root | undefined
let host: HTMLDivElement | undefined
// Mounts once and returns the element; `show` re-renders the same tree, as a store change would.
const mount = (el: ReactElement): HTMLElement => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(el))
  return host.firstElementChild as HTMLElement
}
const show = (el: ReactElement) => act(() => root!.render(el))

beforeEach(() => { runs.length = 0; setMotionPrefs({}) })
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.unstubAllGlobals()
  setMotionPrefs({})
})

describe('a stamp', () => {
  it('marks a change of its value, once, not its mount', () => {
    const el = mount(<Stamp value="idle"><span className="glyph" /></Stamp>)
    expect(el.dataset.stamps).toBeUndefined()
    show(<Stamp value="working"><span className="glyph" /></Stamp>)
    expect(el.dataset.stamps).toBe('1')
  })
  it('coalesces a burst into one stamp', () => {
    const el = mount(<Stamp value={0} />)
    show(<Stamp value={1} />)
    show(<Stamp value={2} />)
    show(<Stamp value={3} />)
    expect(el.dataset.stamps).toBe('1')
  })
  it('does not stop an in-flight stamp when a coalesced change arrives', () => {
    const el = mount(<Stamp value={0} />)
    show(<Stamp value={1} />)
    expect(runs.length).toBe(1)
    // A change inside the coalesce window starts nothing and must leave the running stamp alone:
    // stopping it mid-flight would freeze the mark at up to scale(1.15) rotate(-6deg).
    show(<Stamp value={2} />)
    expect(runs.length).toBe(1)
    expect(runs[0].stopped).toBe(0)
    expect(el.dataset.stamps).toBe('1')
  })
  it('leaves the mark itself untouched when it reads its timing', () => {
    const kid = <span className="glyph" />
    const el = mount(<Stamp value={0}>{kid}</Stamp>)
    show(<Stamp value={1}>{kid}</Stamp>)
    expect(el.dataset.stamps).toBe('1')
    // The tokens are read through a throwaway probe (system/springs.ts, S-1023), so the mark keeps
    // no inline `transition-duration` (its default `transition-property: all` would fade its hover,
    // tone, and colour) and is left with just the child it had.
    expect(el.style.transitionDuration).toBe('')
    expect(el.children.length).toBe(1)
  })
  it('stamps the unread badge when mail lands, not when it is read', () => {
    const el = mount(<Stamp value={1} increaseOnly className="badge" />)
    show(<Stamp value={4} increaseOnly className="badge" />)
    expect(el.dataset.stamps).toBe('1')
    show(<Stamp value={3} increaseOnly className="badge" />)
    expect(el.dataset.stamps).toBe('1')
  })
  it('does not stamp with its kind off, or the master off', () => {
    const el = mount(<Stamp value="idle" />)
    setMotionPrefs({ stamps: false })
    show(<Stamp value="working" />)
    expect(el.dataset.stamps).toBeUndefined()
    setMotionPrefs({ all: false })
    show(<Stamp value="blocked" />)
    expect(el.dataset.stamps).toBeUndefined()
  })
  it('does not stamp under reduced motion', () => {
    const el = mount(<Stamp value="idle" />)
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }))
    show(<Stamp value="working" />)
    expect(el.dataset.stamps).toBeUndefined()
  })
})

describe('the spend bar', () => {
  it('flashes fresh as spend grows', () => {
    const on = mount(<SpendBar value={25} max={100} />)
    show(<SpendBar value={81} max={100} />)
    expect(on.querySelector('i')!.classList.contains('fresh')).toBe(true)
    expect(runs.length).toBe(1)
  })
  it('draws its first width without a sweep or a flash', () => {
    const on = mount(<SpendBar value={64} max={100} />)
    const fill = on.querySelector('i')!
    expect(fill.style.transform).toBe('scaleX(0.8)')
    expect(fill.classList.contains('fresh')).toBe(false)
    expect(runs.length).toBe(0)
  })
  it('jumps straight to its new width, with no flash, with its kind off', () => {
    setMotionPrefs({ spend: false })
    const on = mount(<SpendBar value={25} max={100} />)
    const fill = on.querySelector('i')!
    show(<SpendBar value={100} max={100} />)
    expect(fill.classList.contains('fresh')).toBe(false)
    expect(fill.style.transform).toBe('scaleX(1)')
  })
  it('scales by the square root of the shown max, and shows nothing at 0', () => {
    setMotionPrefs({ spend: false })
    const el = mount(<SpendBar value={null} max={40} />)
    expect(el.querySelector('i')!.style.transform).toBe('scaleX(0)')
    // 4 of 40: sqrt(0.1) ≈ 0.32.
    show(<SpendBar value={4} max={40} />)
    expect(parseFloat(/scaleX\(([\d.]+)\)/.exec(el.querySelector('i')!.style.transform)![1])).toBeCloseTo(0.316, 2)
  })
})

describe('the issue-event row', () => {
  it('nudges when its owned issue changes status, not on its first render', () => {
    const el = mount(<TreeRow event="i1:in_progress" waiting={false} />)
    expect(el.dataset.nudge).toBeUndefined()
    show(<TreeRow event="i1:in_review" waiting={false} />)
    expect(el.dataset.nudge).toBe('1')
  })
  it('does not nudge with its kind off', () => {
    const el = mount(<TreeRow event="i1:in_progress" waiting={false} />)
    setMotionPrefs({ 'issue-events': false })
    show(<TreeRow event="i1:in_review" waiting={false} />)
    expect(el.dataset.nudge).toBeUndefined()
  })
  it('plays the nudge natively on add when the gate is on, and cancels it on unmount', () => {
    const plays: { el: Element; frames: unknown; opts: KeyframeAnimationOptions; cancelled: number }[] = []
    Element.prototype.animate = function (this: Element, frames: unknown, opts: KeyframeAnimationOptions) {
      const play = { el: this, frames, opts, cancelled: 0 }
      plays.push(play)
      return { cancel: () => { play.cancelled++ } } as unknown as Animation
    } as typeof Element.prototype.animate
    try {
      const el = mount(<TreeRow event="i1:in_progress" waiting={false} />)
      show(<TreeRow event="i1:in_review" waiting={false} />)
      expect(plays).toHaveLength(1)
      expect(plays[0].el).toBe(el)
      // It adds onto the row's other transforms (the spawn and FLIP plays), never replaces them.
      expect(plays[0].opts.composite).toBe('add')
      expect(plays[0].frames).toEqual({ transform: ['translateX(0px)', 'translateX(4px)', 'translateX(0px)'] })
      act(() => root!.unmount())
      root = undefined
      expect(plays[0].cancelled).toBe(1)
    } finally {
      delete (Element.prototype as { animate?: unknown }).animate
    }
  })
  it('plays no nudge with its kind off', () => {
    let calls = 0
    Element.prototype.animate = (() => { calls++; return {} }) as unknown as typeof Element.prototype.animate
    try {
      mount(<TreeRow event="i1:in_progress" waiting={false} />)
      setMotionPrefs({ 'issue-events': false })
      show(<TreeRow event="i1:in_review" waiting={false} />)
      expect(calls).toBe(0)
    } finally {
      delete (Element.prototype as { animate?: unknown }).animate
    }
  })
  it('nudges further when the issue starts waiting on the human', () => {
    expect(nudgePx(false, false)).toBe(4)
    expect(nudgePx(false, true)).toBe(4)
    expect(nudgePx(true, false)).toBe(7)
    // A change between two waiting statuses is still an event, at the ordinary length.
    expect(nudgePx(true, true)).toBe(4)
  })
})

// @vitest-environment jsdom
// S-700: the sidebar's spawn and archive motion. A row grows out of its parent on a real spawn
// event, an archived row collapses into its parent and leaves, the rows around them FLIP, and
// nothing moves at load, on a refresh without an event, or when the gate says no. A second event
// restarts from where the rows are drawn, and a nudge on the same row doesn't end the play.
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMotionPrefs, startMotionGate } from './motion-gate'
import { clampTravel, flipDeltas, nearViewport, Pending, PENDING_MS } from './row-flip'
import { RowFlip } from './sidebar-flip'
import { TreeRow } from './sidebar-motion'
import { applyLiveEvent } from './store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('motion/react', () => ({ animate: () => ({ stop: () => {} }) }))
vi.mock('./system/springs', async (orig) => ({ ...(await orig<typeof import('./system/springs')>()), readTiming: () => ({ slow: 220, tick: 440, keep: 0, ease: null }) }))

// jsdom has no Web Animations: each `animate` call is recorded with its keyframes and options, and
// the test sets its progress and finishes or sees it cancelled.
interface Play { el: Element; frames: Record<string, string | number>[]; opts: KeyframeAnimationOptions; cancelled: number; progress: number; finish: () => void }
const plays: Play[] = []
const animateOn = function (this: Element, frames: Record<string, string | number>[], opts: KeyframeAnimationOptions) {
  // A property-indexed keyframe object (the nudge's) is the same list of frames.
  if (!Array.isArray(frames)) {
    const [prop, values] = Object.entries(frames as Record<string, string[]>)[0]
    frames = values.map((v) => ({ [prop]: v }))
  }
  const play: Play = { el: this, frames, opts, cancelled: 0, progress: 0, finish: () => anim.onfinish?.({} as AnimationPlaybackEvent) }
  const anim = {
    onfinish: null as null | ((e: AnimationPlaybackEvent) => void),
    cancel: () => { play.cancelled++ },
    effect: { getComputedTiming: () => ({ progress: play.progress }) },
  }
  plays.push(play)
  return anim
}
const all = () => plays

let root: Root | undefined
let host: HTMLDivElement | undefined
// jsdom lays nothing out: a row's top is its `data-top`.
Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return Number((this as HTMLElement).dataset.top ?? 0) } })
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 24 } })

interface R { id: string; parent?: string; open?: boolean }
const tree = { current: null as HTMLElement | null }
const Tree = ({ rows, evt = '' }: { rows: R[]; evt?: string }) => (
  <div className="tree" ref={(n) => { tree.current = n; if (n) Object.defineProperty(n, 'clientHeight', { value: 400, configurable: true }) }}>
    {rows.map((r, i) => <TreeRow key={r.id} event={evt} waiting={false} className="node" data-id={r.id} data-parent={r.parent} data-top={i * 24} aria-expanded={r.open === false ? false : undefined}>{r.id}</TreeRow>)}
    <RowFlip />
  </div>
)
const mount = (el: ReactElement) => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root!.render(el)) }
const show = (rows: R[], evt = '') => act(() => root!.render(<Tree rows={rows} evt={evt} />))
const event = (type: 'agent.spawned' | 'agent.archived', id: string, parent_id: string | null = null) => act(() => { applyLiveEvent(type, { id, parent_id }) })
const row = (id: string) => host!.querySelector<HTMLElement>(`.node[data-id="${id}"]`)
const A = { id: 'a' }
const B = { id: 'b', parent: 'a' }
const C = { id: 'c' }
// A row's plays: the transform ones, and the fades (`op`), which are plays of their own.
const of = (id: string) => all().filter((p) => p.el === row(id) && p.frames.every((f) => 'transform' in f))
const op = (id: string) => all().filter((p) => p.el === row(id) && p.frames.every((f) => 'opacity' in f))

// Only `Date` is faked: the gate counts a scroll for 150 ms, so each test starts well past the
// last one's.
let clock = new Date('2026-10-15T10:00:00Z').getTime()
beforeEach(() => {
  plays.length = 0
  setMotionPrefs({})
  vi.stubGlobal('fetch', () => new Promise(() => {}))
  Element.prototype.animate = animateOn as unknown as typeof Element.prototype.animate
  clock += 10_000
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
})
afterEach(() => {
  vi.useRealTimers()
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.unstubAllGlobals()
  setMotionPrefs({})
})

describe('the pure parts', () => {
  it('flips the rows that moved, and only those', () => {
    const d = flipDeltas(new Map([['a', 0], ['b', 24], ['c', 48]]), new Map([['a', 0], ['b', 24], ['c', 72], ['n', 48]]), new Map())
    expect([...d]).toEqual([['c', -24]])
  })
  it('restarts an interrupted row from where it is drawn', () => {
    const d = flipDeltas(new Map([['c', 72]]), new Map([['c', 96]]), new Map([['c', -10]]))
    expect(d.get('c')).toBe(-34)
  })
  it('drops an event nobody showed a row for, and consumes it once', () => {
    const p = new Pending()
    p.add('a', 1000)
    expect(p.take('a', 1000 + PENDING_MS + 1)).toBe(false)
    p.add('a', 1000)
    expect(p.take('a', 1500)).toBe(true)
    expect(p.take('a', 1500)).toBe(false)
  })
  it('prunes old events on every read and write', () => {
    const p = new Pending()
    p.add('old', 0)
    p.add('fresh', PENDING_MS + 10)
    expect(p.size).toBe(1)
    p.add('x', PENDING_MS + 20)
    expect(p.has('fresh', 2 * PENDING_MS + 100)).toBe(false)
    expect(p.size).toBe(0)
  })
  it('keeps a band of rows around the viewport', () => {
    expect(nearViewport(0, 24, 0, 100)).toBe(true)
    expect(nearViewport(1000, 24, 0, 100)).toBe(false)
  })
  it('clamps a long travel to a few rows', () => {
    expect(clampTravel(-1000, 24)).toBe(-96)
    expect(clampTravel(30, 24)).toBe(30)
  })
})

describe('a spawn', () => {
  it('grows the new row out of its parent and moves the rows below', () => {
    mount(<Tree rows={[A, C]} />)
    expect(all()).toHaveLength(0)
    event('agent.spawned', 'b', 'a')
    show([A, B, C])
    const [grow] = of('b')
    // From the parent's place (24 px up), transparent and slightly small, to its slot, added to
    // whatever transform the row already carries.
    expect(grow.frames.map((f) => f.transform)).toEqual(['translateY(-24px) scale(0.96)', 'translateY(0px) scale(1)'])
    expect(grow.opts.composite).toBe('add')
    // The fade can't add (it would clamp at the row's own 1), so it replaces, as its own play.
    expect(op('b')[0].frames.map((f) => f.opacity)).toEqual([0, 1])
    expect(op('b')[0].opts.composite).toBe('replace')
    expect(of('c')[0].frames.map((f) => f.transform)).toEqual(['translateY(-24px)', 'translateY(0px)'])
    // Transform and opacity only.
    for (const p of all()) expect(p.frames.every((f) => Object.keys(f).every((k) => k === 'transform' || k === 'opacity'))).toBe(true)
  })
  it('travels at most a few rows from a far parent', () => {
    const rows: R[] = [A, ...Array.from({ length: 10 }, (_, i) => ({ id: `r${i}` }))]
    mount(<Tree rows={rows} />)
    event('agent.spawned', 'z', 'a')
    show([...rows, { id: 'z', parent: 'a' }])
    expect(of('z')[0].frames[0].transform).toBe('translateY(-96px) scale(0.96)')
  })
  it('leaves no inline style behind', () => {
    mount(<Tree rows={[A, C]} />)
    event('agent.spawned', 'b', 'a')
    show([A, B, C])
    for (const p of all()) p.finish()
    expect(row('b')!.getAttribute('style')).toBeNull()
    expect(all().length).toBe(3)
  })
  it('is not an event when the parent is collapsed: the user\'s expand does not animate', () => {
    mount(<Tree rows={[{ id: 'a', open: false }, C]} />)
    event('agent.spawned', 'b', 'a')
    show([{ id: 'a', open: false }, C])
    // The user expands the parent: the child's row appears with no spawn behind it.
    show([A, B, C])
    expect(all()).toHaveLength(0)
  })
})

describe('no event, no motion', () => {
  it('does not animate the rows at load', () => {
    mount(<Tree rows={[A, B, C]} />)
    expect(all()).toHaveLength(0)
  })
  it('does not animate rows a refresh brings without a spawn event', () => {
    mount(<Tree rows={[A, C]} />)
    show([A, B, C])
    expect(all()).toHaveLength(0)
  })
  it('does not animate an archive that has no event (a poll)', () => {
    mount(<Tree rows={[A, B, C]} />)
    show([A, C])
    expect(all()).toHaveLength(0)
    expect(host!.querySelector('.row-ghosts')!.children).toHaveLength(0)
  })
  it('does not animate with the kind off, the master off, or under reduced motion', () => {
    mount(<Tree rows={[A, C]} />)
    setMotionPrefs({ 'spawn-archive': false })
    event('agent.spawned', 'b', 'a')
    show([A, B, C])
    expect(all()).toHaveLength(0)
    setMotionPrefs({ all: false })
    event('agent.spawned', 'd')
    show([A, B, C, { id: 'd' }])
    expect(all()).toHaveLength(0)
    setMotionPrefs({})
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }))
    event('agent.spawned', 'e')
    show([A, B, C, { id: 'd' }, { id: 'e' }])
    expect(all()).toHaveLength(0)
  })
  it('does not animate while the tree scrolls', () => {
    mount(<Tree rows={[A, C]} />)
    startMotionGate()
    // Any element's scroll event is heard by the gate's capture listener, once it is watching.
    act(() => { tree.current!.dispatchEvent(new Event('scroll')) })
    event('agent.spawned', 'b', 'a')
    act(() => { tree.current!.dispatchEvent(new Event('scroll')) })
    show([A, B, C])
    expect(all()).toHaveLength(0)
  })
})

describe('an archive', () => {
  it('collapses the row into its parent as a ghost, and removes it when done', () => {
    mount(<Tree rows={[A, B, C]} />)
    event('agent.archived', 'b')
    show([A, C])
    const layer = host!.querySelector('.row-ghosts')!
    const ghost = layer.children[0] as HTMLElement
    expect(ghost.textContent).toBe('b')
    expect(ghost.hasAttribute('data-id')).toBe(false)
    expect(ghost.getAttribute('aria-hidden')).toBe('true')
    const out = all().find((p) => p.el === ghost)!
    expect(out.frames.map((f) => f.transform)).toEqual(['translateY(0px) scale(1)', 'translateY(-24px) scale(0.96)'])
    expect(all().find((p) => p.el === ghost && 'opacity' in p.frames[0])!.frames.map((f) => f.opacity)).toEqual([1, 0])
    // The row below moves up by FLIP at the same time.
    expect(of('c')[0].frames.map((f) => f.transform)).toEqual(['translateY(24px)', 'translateY(0px)'])
    out.finish()
    expect(layer.children).toHaveLength(0)
  })
  it('starts a row archived mid-play from where it is drawn', () => {
    mount(<Tree rows={[A, C]} />)
    event('agent.spawned', 'b', 'a')
    show([A, B, C])
    const grow = of('b')[0]
    // Halfway through its grow: 12 px above its slot, half faded in.
    grow.progress = 0.5
    const fadeIn = op('b')[0]
    fadeIn.progress = 0.5
    event('agent.archived', 'b')
    show([A, C])
    expect(grow.cancelled).toBe(1)
    expect(fadeIn.cancelled).toBe(1)
    const ghost = host!.querySelector('.row-ghosts')!.children[0]
    const mine = all().filter((p) => p.el === ghost)
    const out = mine.filter((p) => 'transform' in p.frames[0]).at(-1)!
    expect(out).not.toBe(grow)
    expect(out.frames[0].transform).toBe('translateY(-12px) scale(1)')
    expect(mine.filter((p) => 'opacity' in p.frames[0]).at(-1)!.frames[0].opacity).toBe(0.5)
  })
})

describe('interruption', () => {
  it('cancels the running rows and restarts them from where they are drawn', () => {
    mount(<Tree rows={[A, C]} />)
    event('agent.spawned', 'b', 'a')
    show([A, B, C])
    const first = of('c')[0]
    // Halfway: c is drawn 12 px above its place.
    first.progress = 0.5
    event('agent.spawned', 'd', 'a')
    show([A, { id: 'd', parent: 'a' }, B, C])
    expect(first.cancelled).toBe(1)
    const again = of('c').at(-1)!
    expect(again).not.toBe(first)
    // Its old top 72 plus the 12 px it was above, less its new top 96.
    expect(again.frames[0].transform).toBe('translateY(-36px)')
  })
  it('leaves a running row alone when a render brings no event', () => {
    mount(<Tree rows={[A, C]} />)
    event('agent.spawned', 'b', 'a')
    show([A, B, C])
    const n = all().length
    show([A, B, C])
    expect(all()).toHaveLength(n)
    expect(all().every((p) => p.cancelled === 0)).toBe(true)
  })
  it('a row\'s nudge during a grow adds onto it: neither play ends, and nothing is left behind', () => {
    mount(<Tree rows={[A, C]} />)
    event('agent.spawned', 'b', 'a')
    show([A, B, C])
    const grow = of('b')[0]
    // The issue nudge is a native play on `add` too, so it sits beside the grow, not over it.
    show([A, B, C], 'S-1:in_review')
    const nudge = of('b').find((p) => p !== grow && p.frames[0].transform === 'translateX(0px)')
    expect(nudge).toBeDefined()
    expect(nudge!.opts.composite).toBe('add')
    expect(grow.cancelled).toBe(0)
    grow.finish()
    expect(row('b')!.getAttribute('style')).toBeNull()
    // Nothing is left to cancel: an event after it finds no run to read.
    event('agent.spawned', 'd')
    show([A, B, C, { id: 'd' }], 'S-1:in_review')
    expect(grow.cancelled).toBe(0)
  })
})

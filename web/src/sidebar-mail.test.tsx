// @vitest-environment jsdom
// S-699: the agents sidebar's mail motion at the trigger, through the S-696 gate. A mail sent
// between two rows of the tree starts one envelope; a burst between the same pair rides it with a
// count; nothing starts with the kind off, under reduced motion, while the tree scrolls, or when
// an end has no row to fly to.
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMotionPrefs } from './motion-gate'
import { MailFlights } from './sidebar-mail'
import { applyLiveEvent } from './store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined
const mount = (el: ReactElement): HTMLElement => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(el))
  return host.firstElementChild as HTMLElement
}
// A row as the tree draws it: its id, its indent, and its unread badge.
const row = (id: string, depth: number, unread: number) => (
  <div className="node" data-id={id} style={{ paddingLeft: 8 + depth * 14 }}>
    <span className="name">{id}</span>
    <span className="meta">
      {unread ? <span className="badge" data-inbox={id}>{unread}</span> : <span className="badge empty" data-inbox={id} />}
    </span>
  </div>
)
// A tree with three rows: a chief of staff, a manager under it, and a developer under that.
const treeWith = (extra: ReactElement[] = []) => {
  const tree: { current: HTMLElement | null } = { current: null }
  const el = mount(
    <div className="tree" ref={(n) => { tree.current = n }}>
      {row('a', 0, 0)}{row('b', 1, 0)}{row('c', 2, 2)}
      <MailFlights tree={tree} />
      {extra}
    </div>,
  )
  return { el, tree }
}
// jsdom lays nothing out, so a test that needs a row inside or outside the list gives it a box:
// the rows' tops in the list, and the badge inside its row.
const stub = (el: Element, top: number, left: number, width: number, height: number) => {
  el.getBoundingClientRect = () => ({ top, left, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
}
const layOut = (tree: HTMLElement, rows: { id: string; top: number }[], list = 100) => {
  Object.defineProperty(tree, 'clientHeight', { value: list, configurable: true })
  Object.defineProperty(tree, 'scrollTop', { value: 0, configurable: true })
  for (const r of rows) {
    const el = tree.querySelector<HTMLElement>(`.node[data-id="${r.id}"]`)
    if (!el) continue
    stub(el, r.top, 0, 300, 24)
    const badge = el.querySelector<HTMLElement>('[data-inbox]')
    if (badge) stub(badge, r.top + 4, 250, 18, 16)
  }
}
const mail = (from: string, to: string[], id = 'm1') => act(() => { applyLiveEvent('mail.sent', { id, from, to, thread: null, ask: false }) })
const flying = () => [...host!.querySelectorAll<HTMLElement>('.mail-fly')]

beforeEach(() => { setMotionPrefs({}) })
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.unstubAllGlobals()
  setMotionPrefs({})
})

describe('a mail between two rows', () => {
  it('flies one envelope from the sender to the recipient', () => {
    const { el } = treeWith()
    expect(flying()).toHaveLength(0)
    mail('a', ['c'])
    const fly = flying()
    expect(fly).toHaveLength(1)
    expect(fly[0].dataset.from).toBe('a')
    expect(fly[0].dataset.to).toBe('c')
    // It starts on the sender's rail and then moves by transform alone.
    expect(fly[0].style.transform).toMatch(/^translate3d\(/)
    expect(el.querySelector('.mail-fly')).toBe(fly[0])
  })
  it('coalesces a burst between the same pair into one flight, with a count', () => {
    treeWith()
    mail('a', ['b'], 'm1')
    mail('a', ['b'], 'm2')
    mail('a', ['b'], 'm3')
    expect(flying()).toHaveLength(1)
    expect(flying()[0].querySelector('.n')?.textContent).toBe('3')
  })
  it('flies one envelope per recipient row', () => {
    treeWith()
    mail('a', ['b', 'c'])
    expect(flying().map((f) => f.dataset.to)).toEqual(['b', 'c'])
  })
  it('takes the human to the top of the list, since they have no row', () => {
    treeWith()
    mail('a', ['human'])
    expect(flying().map((f) => f.dataset.to)).toEqual(['human'])
  })
  it('reads the flight tokens through a throwaway probe, never the flying layer', () => {
    const { el } = treeWith()
    mail('a', ['b'])
    expect(flying()).toHaveLength(1)
    // The tokens come from a probe `tokenMs` removes again, so nothing writes a transition onto a
    // live element and no probe is left behind.
    expect(el.querySelector('.motion-probe')).toBeNull()
    expect(document.querySelector('.motion-probe')).toBeNull()
    expect(el.querySelector<HTMLElement>('.mail-flights')!.style.transitionDuration).toBe('')
  })
})

describe('an end the list does not show', () => {
  it('clips the flight to the list edge when its landing point is below the fold', () => {
    const { tree } = treeWith()
    layOut(tree.current!, [{ id: 'a', top: 10 }, { id: 'c', top: 300 }])
    mail('a', ['c'])
    expect(flying()).toHaveLength(1)
    expect(flying()[0].dataset.exits).toBe('1')
  })
  it('lands on the badge when both ends are shown', () => {
    const { tree } = treeWith()
    layOut(tree.current!, [{ id: 'a', top: 10 }, { id: 'b', top: 60 }])
    mail('a', ['b'])
    expect(flying()[0].dataset.exits).toBeUndefined()
  })
  it('flies nothing when neither end is shown', () => {
    const { tree } = treeWith()
    layOut(tree.current!, [{ id: 'a', top: 300 }, { id: 'c', top: 400 }])
    mail('a', ['c'])
    expect(flying()).toHaveLength(0)
  })
})

describe('the motion gate', () => {
  it('flies nothing with the mail kind off, or the master off', () => {
    treeWith()
    setMotionPrefs({ mail: false })
    mail('a', ['b'])
    expect(flying()).toHaveLength(0)
    setMotionPrefs({ all: false })
    mail('a', ['b'], 'm2')
    expect(flying()).toHaveLength(0)
  })
  it('flies nothing under reduced motion', () => {
    treeWith()
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }))
    mail('a', ['b'])
    expect(flying()).toHaveLength(0)
  })
  it('flies nothing while the tree scrolls', () => {
    const { tree } = treeWith()
    tree.current!.dispatchEvent(new Event('scroll'))
    mail('a', ['b'])
    expect(flying()).toHaveLength(0)
  })
})

describe('mail that cannot fly', () => {
  it('lands at once when the recipient has no row in the tree', () => {
    treeWith()
    mail('a', ['gone'])
    expect(flying()).toHaveLength(0)
  })
  it('lands at once when the sender has no row', () => {
    treeWith()
    mail('stam', ['b'])
    expect(flying()).toHaveLength(0)
  })
  it('lands at once when an agent mails itself', () => {
    treeWith()
    mail('b', ['b'])
    expect(flying()).toHaveLength(0)
  })
})

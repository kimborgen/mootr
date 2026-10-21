import { afterEach, describe, expect, it, vi } from 'vitest'
import { bottomColumn, focused, placeBottom } from './bottom-column'

// A box at x..x+w in the page, as getBoundingClientRect reports it (jsdom lays nothing out).
function box(x: number, w: number, cls = ''): HTMLElement {
  const el = document.createElement('div')
  if (cls) el.className = cls
  el.getBoundingClientRect = () => ({ left: x, right: x + w, width: w, top: 0, bottom: 0, height: 0, x, y: 0, toJSON() { return {} } }) as DOMRect
  return el
}

// #center at 0..1440 holds #w-main, with one focused pane of `paneBox` whose views are `views`
// (each a hidden tab or not, with its column at `col` if it has one), and the bottom input.
function build(paneBox: [number, number], views: { hidden?: boolean; col?: [number, number] }[]) {
  const center = box(0, 1440)
  const main = document.createElement('div')
  main.id = 'w-main'
  const pane = box(...paneBox, 'pane focused')
  const body = box(paneBox[0], paneBox[1], 'pane-body')
  pane.append(body)
  main.append(pane)
  center.append(main)
  const bottom = box(0, 1440)
  center.append(bottom)
  const els = views.map((v, i) => {
    const el = document.createElement('div')
    el.dataset.key = 'view:' + i
    el.hidden = !!v.hidden
    if (v.col) el.append(box(...v.col, 'ov-col'))
    body.append(el)
    return el
  })
  document.body.append(center)
  return { center, bottom, pane, views: els }
}

afterEach(() => { document.body.innerHTML = '' })

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('placeBottom: the input\'s content edges are the column\'s (S-2284)', () => {
  it('with a column: the side padding puts the content at the column\'s edges, the box stays full width', () => {
    // A 400 px pane at 600..1000 whose messages\' column is inset by --pad-pane (12 px) each side.
    const { bottom, pane, center } = build([600, 400], [{ col: [612, 376] }])
    placeBottom(bottom, pane, center.querySelector('.ov-col'))
    expect(bottom.style.paddingLeft).toBe('612px')
    expect(bottom.style.paddingRight).toBe('452px')
    expect(bottom.style.marginLeft).toBe('')
    expect(bottom.style.marginRight).toBe('')
  })

  it('a column inside a wider pane is centred, so a scrollbar on the pane does not shift the input', () => {
    // The column is 768 wide, centred in a 1000 px pane at 0..1000, with a 15 px scrollbar on the right.
    const { bottom, pane, center } = build([0, 1000], [{ col: [116, 768] }])
    placeBottom(bottom, pane, center.querySelector('.ov-col'))
    expect(bottom.style.paddingLeft).toBe('116px')
    expect(bottom.style.paddingRight).toBe('556px')
  })

  it('without a column, the pane\'s width with the pane gutter', () => {
    const { bottom, pane } = build([0, 300], [{}])
    placeBottom(bottom, pane, null)
    expect(bottom.style.paddingLeft).toBe('calc(0px + var(--pad-pane))')
    expect(bottom.style.paddingRight).toBe('calc(1140px + var(--pad-pane))')
  })

  it('without a pane, the padding is the class\'s again', () => {
    const { bottom } = build([520, 920], [{}])
    bottom.style.paddingLeft = '520px'
    bottom.style.paddingRight = '0px'
    placeBottom(bottom, null, null)
    expect(bottom.style.paddingLeft).toBe('')
    expect(bottom.style.paddingRight).toBe('')
  })
})

describe('focused: the column is the active view\'s, with a box (S-2284)', () => {
  it('a hidden tab\'s column is skipped for the shown view\'s, even with a box of its own', () => {
    // The first tab is hidden, and its column has a box; the second, shown, is the one to read.
    const { views } = build([0, 1000], [{ hidden: true, col: [100, 800] }, { col: [116, 768] }])
    const { column } = focused()
    expect(column).toBe(views[1].querySelector('.ov-col'))
  })

  it('a column with no box is no column', () => {
    build([0, 1000], [{ col: [0, 0] }])
    expect(focused().column).toBeNull()
  })

  it('no column when only a hidden tab has one', () => {
    build([0, 1000], [{ hidden: true, col: [0, 0] }, {}])
    expect(focused().column).toBeNull()
  })
})

describe('bottomColumn: the input follows the column as it mounts and changes (S-2284)', () => {
  it('a tab switch, where only `hidden` flips, re-places the input on the shown view\'s column', async () => {
    const { bottom, views } = build([0, 1000], [{ col: [116, 768] }, { hidden: true, col: [200, 500] }])
    const c = bottomColumn(bottom, () => true)
    expect(bottom.style.paddingLeft).toBe('116px')
    views[0].hidden = true
    views[1].hidden = false
    await tick()
    expect(bottom.style.paddingLeft).toBe('200px')
    expect(bottom.style.paddingRight).toBe('740px')
    c.disconnect()
  })

  it('a message appended inside the column does not look the column up again', async () => {
    const { bottom, views } = build([0, 1000], [{ col: [116, 768] }])
    const c = bottomColumn(bottom, () => true)
    const column = views[0].querySelector('.ov-col')!
    const spy = vi.spyOn(Element.prototype, 'querySelectorAll')
    const msg = document.createElement('div')
    column.append(msg)
    msg.append('a streamed block')
    await tick()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    c.disconnect()
  })

  it('a message that brings a scrollbar moves the column, and the input follows it with no lookup', async () => {
    // The column is centred at 116..884 in a 1000 px pane; then a scrollbar takes 15 px and the
    // column centres 7.5 px further left, at 108..876.
    const { bottom, views } = build([0, 1000], [{ col: [116, 768] }])
    const c = bottomColumn(bottom, () => true)
    expect(bottom.style.paddingLeft).toBe('116px')
    const column = views[0].querySelector<HTMLElement>('.ov-col')!
    const spy = vi.spyOn(Element.prototype, 'querySelectorAll')
    column.getBoundingClientRect = () => ({ left: 108, right: 876, width: 768, top: 0, bottom: 0, height: 0, x: 108, y: 0, toJSON() { return {} } }) as DOMRect
    column.append(document.createElement('div'))
    await tick()
    expect(bottom.style.paddingLeft).toBe('108px')
    expect(bottom.style.paddingRight).toBe('564px')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    c.disconnect()
  })

  it('a column that mounts after the pane is picked up', async () => {
    const { bottom, views } = build([0, 1000], [{}])
    const c = bottomColumn(bottom, () => true)
    expect(bottom.style.paddingLeft).toBe('calc(0px + var(--pad-pane))')
    // The view's messages mount after its stream loads.
    views[0].append(box(116, 768, 'ov-col'))
    await tick()
    expect(bottom.style.paddingLeft).toBe('116px')
    expect(bottom.style.paddingRight).toBe('556px')
    c.disconnect()
  })

  it('off, the input keeps the class\'s padding', () => {
    const { bottom } = build([0, 1000], [{ col: [116, 768] }])
    const c = bottomColumn(bottom, () => false)
    expect(bottom.style.paddingLeft).toBe('')
    c.disconnect()
  })
})

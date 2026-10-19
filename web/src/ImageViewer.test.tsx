// @vitest-environment jsdom
// S-86: which click on an image opens the full-screen viewer, and which doesn't (a compare
// block's slider drag must keep sliding, not open the viewer).
import { afterEach, describe, expect, it } from 'vitest'
import { closeImage, installImageViewer } from './ImageViewer'
import { getUi } from './ui/state'

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined; closeImage(); document.body.innerHTML = '' })

const down = (el: Element, x: number, y: number) => el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }))
const move = (el: Element, x: number, y: number) => el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))
const up = (el: Element, x: number, y: number) => el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: x, clientY: y }))
const click = (el: Element, x: number, y: number) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }))

describe('installImageViewer', () => {
  it('opens a mail body image', () => {
    cleanup = installImageViewer()
    document.body.innerHTML = '<div class="md"><img src="https://x.test/a.png" alt="A chart"></div>'
    click(document.querySelector('img')!, 10, 10)
    expect(getUi().viewer).toEqual({ src: 'https://x.test/a.png', alt: 'A chart' })
  })

  it('opens an attachment-strip image', () => {
    cleanup = installImageViewer()
    document.body.innerHTML = '<div class="att-imgs"><a class="att-img"><img src="blob:x" alt="shot.png"></a></div>'
    click(document.querySelector('img')!, 10, 10)
    expect(getUi().viewer?.src).toBe('blob:x')
  })

  it('leaves images outside mail alone', () => {
    cleanup = installImageViewer()
    document.body.innerHTML = '<img src="https://x.test/logo.png">'
    click(document.querySelector('img')!, 10, 10)
    expect(getUi().viewer).toBe(null)
  })

  it('opens a compared image on a tap but not on a slider drag', () => {
    cleanup = installImageViewer()
    document.body.innerHTML = '<div class="md"><figure class="mb-compare"><div class="mb-cmp-stage">'
      + '<img class="after" src="https://x.test/after.png" alt="After"><img class="before" src="https://x.test/before.png" alt="Before">'
      + '<input data-compare type="range" min="0" max="100" value="50"></div></figure></div>'
    const range = document.querySelector('input')!
    down(range, 100, 100)
    up(range, 100, 100)
    expect(getUi().viewer).toEqual({ src: 'https://x.test/after.png', alt: 'After' })
    closeImage()
    down(range, 100, 100)
    move(range, 130, 100)
    up(range, 130, 100)
    expect(getUi().viewer).toBe(null)
  })
})

// @vitest-environment jsdom
// S-1475: where a staged image's tab opens, and the arrows through the staged images.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const world = { root: null as unknown, focused: 'a' }
const open = vi.fn()
const setFocus = vi.fn()
let phone = false
vi.mock('./shell/layout', () => ({
  mainWorld: () => world,
  leaves: (r: { leaves: { id: string; active: string | null; tabs: string[] }[] }) => r.leaves,
  focusedLeaf: (w: { root: { leaves: { id: string }[] }; focused: string }) => w.root.leaves.find((l) => l.id === w.focused) ?? w.root.leaves[0],
  activeIn: () => (world.root as { leaves: { id: string; active: string | null }[] }).leaves.find((l) => l.id === world.focused)?.active ?? null,
  isPhone: () => phone,
  open: (...a: unknown[]) => open(...a),
  setFocus: (...a: unknown[]) => setFocus(...a),
  registerView: () => () => {},
}))
import { getUi } from './ui/state'
import { closeImage } from './ImageViewer'
import { bottomTarget } from './composer-target'
import { addImageSet, foreignImage, imagePlacement, imageSet, inputMain, openStagedImage } from './image-tab'
import { ImageTabView } from './views/ImageTabView'
import { viewContext } from './actions'

const panes = (...ids: string[]) => { world.root = { leaves: ids.map((id) => { const [i, active] = id.split('='); return { id: i, active: active ?? null, tabs: active ? [active] : [] } }) } }
const imgs = [{ src: 'blob:1', alt: 'one.png' }, { src: 'blob:2', alt: 'two.png' }, { src: 'blob:3', alt: 'three.png' }]

beforeEach(() => { open.mockClear(); setFocus.mockClear(); phone = false; world.focused = 'a' })
afterEach(() => { closeImage() })

describe('imagePlacement', () => {
  it('splits a new pane to the right when main has one pane', () => {
    panes('a')
    expect(imagePlacement()).toEqual({ pane: 'a', split: 'right' })
  })
  it('uses the pane opposite the focused one when main has two', () => {
    panes('a', 'b')
    expect(imagePlacement()).toEqual({ pane: 'b' })
    world.focused = 'b'
    expect(imagePlacement()).toEqual({ pane: 'a' })
  })
  it('adds a tab to the focused pane when main has more', () => {
    panes('a', 'b', 'c')
    world.focused = 'b'
    expect(imagePlacement()).toEqual({ pane: 'b' })
  })
})

describe('imagePlacement with an image tab shown', () => {
  it('goes opposite the pane the input writes for, not the focused image pane', () => {
    bottomTarget('agent:t1')
    panes('a=agent:t1', 'b=image:x.1')
    world.focused = 'b'
    expect(imagePlacement()).toEqual({ pane: 'b' })
    panes('b=image:x.1', 'a=agent:t1')
    expect(imagePlacement()).toEqual({ pane: 'b' })
  })
  it('adds a tab to the target pane when main has more than two', () => {
    bottomTarget('agent:t1')
    panes('a=image:x.1', 'b=agent:t1', 'c')
    world.focused = 'a'
    expect(imagePlacement()).toEqual({ pane: 'b' })
  })
  it('puts focus back on the target pane when it opens', () => {
    bottomTarget('agent:t1')
    panes('a=agent:t1', 'b=image:x.1')
    world.focused = 'b'
    openStagedImage(imgs, 0)
    expect(setFocus).toHaveBeenCalledWith('main', 'a')
  })
})

describe('inputMain: what the prompt input follows', () => {
  it('is the focused pane\'s tab, and under our own image tab the tab the input came from', () => {
    bottomTarget('view:a1')
    panes('a=view:a1', 'b')
    expect(inputMain()).toBe('view:a1')
    const own = 'image:' + addImageSet(imgs, 0)
    panes('a=' + own, 'b')
    expect(inputMain()).toBe('view:a1')
  })
  it('skips an image tab of another page', () => {
    bottomTarget('thread:t9')
    world.root = { leaves: [{ id: 'a', active: 'image:zzzz.1', tabs: ['image:zzzz.1', 'thread:t9'] }] }
    expect(inputMain()).toBe('thread:t9')
  })
})

describe('image tabs of other pages', () => {
  it('are foreign here: hidden, never taken for ours', () => {
    const id = addImageSet(imgs, 0)
    expect(foreignImage('image:' + id)).toBe(false)
    expect(foreignImage('image:zzzz.9')).toBe(true)
    expect(foreignImage('agent:a')).toBe(false)
  })
})

describe('openStagedImage', () => {
  it('opens an image tab in main with the clicked image', () => {
    panes('a')
    openStagedImage(imgs, 1)
    const [w, key, where] = open.mock.calls[0]
    expect(w).toBe('main')
    expect(key).toMatch(/^image:[a-z0-9]+\.\d+$/)
    expect(where).toEqual({ pane: 'a', split: 'right' })
    expect(imageSet(key.slice(6))).toMatchObject({ index: 1 })
    // The input keeps writing for the pane it wrote for.
    expect(setFocus).toHaveBeenCalledWith('main', 'a')
  })
  it('keeps the full-screen viewer on a phone', () => {
    phone = true
    panes('a')
    openStagedImage(imgs, 2)
    expect(open).not.toHaveBeenCalled()
    expect(getUi().viewer).toEqual({ src: 'blob:3', alt: 'three.png' })
  })
})

describe('ImageTabView', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
  afterEach(() => { act(() => root.unmount()); host.remove() })

  const mount = async (index: number) => {
    panes('a')
    openStagedImage(imgs, index)
    const id = (open.mock.calls[0][1] as string).slice(6)
    await act(async () => { root.render(<ImageTabView id={id} viewKey={'image:' + id} />) })
    return id
  }
  const src = () => host.querySelector<HTMLImageElement>('img.iv-img')!.getAttribute('src')

  it('steps with the arrow keys and the buttons, and stops at the ends', async () => {
    await mount(0)
    expect(src()).toBe('blob:1')
    expect(host.querySelector<HTMLButtonElement>('.it-prev')!.disabled).toBe(true)
    const view = host.querySelector<HTMLElement>('.it-view')!
    await act(async () => { view.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true })) })
    expect(src()).toBe('blob:1')
    await act(async () => { view.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(src()).toBe('blob:2')
    await act(async () => { host.querySelector<HTMLButtonElement>('.it-next')!.click() })
    expect(src()).toBe('blob:3')
    expect(host.querySelector<HTMLButtonElement>('.it-next')!.disabled).toBe(true)
    await act(async () => { view.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(src()).toBe('blob:3')
    await act(async () => { view.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(src()).toBe('blob:2')
    expect(host.querySelector('.it-count')!.textContent).toBe('2 / 3')
  })

  it('shows no arrows for a single image', async () => {
    panes('a')
    openStagedImage([imgs[0]], 0)
    const id = (open.mock.calls[0][1] as string).slice(6)
    await act(async () => { root.render(<ImageTabView id={id} viewKey={'image:' + id} />) })
    expect(host.querySelector('.it-prev')).toBe(null)
  })
})

describe('viewContext with an image tab shown', () => {
  it('names the input\'s main tab, not the image tab', () => {
    panes('a=config')
    bottomTarget('config')
    panes('a=image:' + addImageSet(imgs, 0))
    expect(viewContext()).toBe('the settings')
  })
})

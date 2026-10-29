// S-1475: a staged image in the prompt input opens in a world tab (`image:PAGE.N`), with the arrows
// stepping through the images that were staged when it opened. The tab's images live here, not in
// the key (they are `data:` urls of this page), and the layout is shared with the human's other
// devices, so each page numbers its tabs under its own random PAGE: a tab of another page, or of
// this one before a reload, has nothing to show here and is hidden (`foreignImage`). The daemon closes
// the tabs of a page whose layout stream has been gone for a minute (src/layout.ts), so they don't linger.
import { useSyncExternalStore } from 'react'
import { openImage } from './ImageViewer'
import { targetKey } from './composer-target'
import { PAGE } from './page'
import * as shell from './shell/layout'

export interface TabImage { src: string; alt: string }
interface ImageSet { images: TabImage[]; index: number }

const sets = new Map<string, ImageSet>()
const listeners = new Set<() => void>()
let version = 0
const bump = () => { version++; for (const fn of listeners) fn() }
let n = 0
// An `image:` tab this page has no images for: another device's, or this one's from before a reload.
export const foreignImage = (key: string) => key.startsWith('image:') && !sets.has(key.slice(6))

export const imageSet = (id: string) => sets.get(id)
export function useImageSet(id: string) {
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => version)
  return sets.get(id)
}
export function stepImage(id: string, by: number) {
  const s = sets.get(id)
  if (!s) return
  const index = Math.max(0, Math.min(s.images.length - 1, s.index + by))
  if (index !== s.index) { s.index = index; bump() }
}
export function dropImageSet(id: string) { if (sets.delete(id)) bump() }

// The tab a pane shows: its active one, but a foreign image tab is hidden, so the first visible tab shows
// (`MainWorld`).
export function visibleActive(l: shell.Leaf): string | null {
  if (l.active && foreignImage(l.active)) return l.tabs.find((k) => !foreignImage(k)) ?? null
  return l.active
}

// What the prompt input follows in main: the focused pane's visible tab, except an image tab, which only
// shows what the input holds: then the tab the input's target came from.
export function inputMain(): string | null {
  const a = visibleActive(shell.focusedLeaf(shell.mainWorld()))
  return a?.startsWith('image:') ? targetKey() : a
}

// The pane the prompt input writes for: the focused one, unless that one shows an image tab, which only
// shows what the input holds; then the pane showing the tab the input's target came from.
function targetPane(): shell.Leaf {
  const w = shell.mainWorld()
  const focused = shell.focusedLeaf(w)
  if (!focused.active?.startsWith('image:')) return focused
  const key = targetKey()
  return shell.leaves(w.root).find((l) => key && l.active === key) ?? focused
}

// Where the tab goes in the main world. One pane: a new pane to its right. Two: the one opposite the
// target pane. More: a new tab in the target pane.
export function imagePlacement(): { pane?: string; split?: 'right' } {
  const w = shell.mainWorld()
  const all = shell.leaves(w.root)
  const target = targetPane()
  if (all.length === 1) return { pane: target.id, split: 'right' }
  if (all.length === 2) return { pane: all.find((l) => l.id !== target.id)!.id }
  return { pane: target.id }
}

export function addImageSet(images: TabImage[], index: number) {
  const id = PAGE + '.' + ++n
  sets.set(id, { images, index })
  return id
}

// A staged image was clicked: `images` are the image files staged, `index` the one clicked. A
// phone keeps the full-screen viewer; a desktop opens (or fills) a tab.
export function openStagedImage(images: TabImage[], index: number) {
  if (!images[index]) return
  if (shell.isPhone()) { openImage(images[index].src, images[index].alt); return }
  // The input keeps writing for the pane it wrote for: the tab opens beside it, not in its place.
  const target = targetPane().id
  shell.open('main', 'image:' + addImageSet(images, index), imagePlacement())
  shell.setFocus('main', target)
}

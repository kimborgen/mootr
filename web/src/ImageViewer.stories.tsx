import { openImage } from './ImageViewer'
import { ImageTabView } from './views/ImageTabView'
import { addImageSet } from './image-tab'
import { OnMount } from './stories/helpers'
import { ds, type Story } from './stories/types'

const base = import.meta.env.BASE_URL

export const stories: Story[] = [{
  name: 'Image viewer',
  group: 'Primitives',
  what: 'An image from mail alone, full screen, with pinch-zoom and pan, so a phone never zooms the whole page. A double-tap zooms in on the point and back; the wheel zooms on a desktop.',
  when: "A tap or click on an image in a mail body or a mail's attachment strip, or a tap on a compare block (not a drag of its slider). A backdrop tap, the ✕, a swipe down, Escape, or the phone's Back closes it.",
  code: ['web/src/ImageViewer.tsx#ImageViewer', 'web/src/ImageViewer.tsx#openImage', 'web/src/ImageViewer.tsx#installImageViewer'],
  rules: [
    'It sits at `--z-modal` over `--surface-scrim`; the scrim fades opacity only, never a backdrop blur (' + ds('Developer rules') + ').',
    'The ✕ is a `--size-hit-touch` target clear of the safe area.',
    'Zoom and pan track the fingers 1:1 with no smoothing (' + ds('Never animated') + ').',
  ],
  states: [
    { name: 'Vector image', height: 480, render: () => <OnMount run={() => openImage(base + 'icon.svg', 'The stam mark')} /> },
    { name: 'Raster image', height: 480, render: () => <OnMount run={() => openImage(base + 'icon-512.png', 'The stam app icon')} /> },
  ],
}, {
  name: 'Image tab',
  group: 'Primitives',
  what: "A staged image in a pane of the main world: the image viewer's picture with zoom and pan, and arrows at its sides to the previous and next staged image, with its place (2 / 3) below.",
  when: "A click on a staged image in the prompt input on a desktop. With one pane in main it opens in a new pane to the right; with two, in the pane opposite the focused one; with more, as a new tab in the focused pane. The arrow keys step through the images while the tab is focused. A phone opens the full-screen viewer instead.",
  code: ['web/src/views/ImageTabView.tsx#ImageTabView', 'web/src/ImageViewer.tsx#ZoomImage', 'web/src/image-tab.ts#openStagedImage'],
  rules: [
    'The arrows are `icon-btn`s of `--size-hit-touch`, disabled at the ends of the set, never hidden by colour alone; with one image there are none.',
    'The pane keeps the viewer\'s grounded `--pdf-viewport-bg`; the picture and its zoom are the viewer\'s own (`ZoomImage`).',
  ],
  states: [
    { name: 'Several images', render: () => <div style={{ height: 360 }}><ImageTabView id={addImageSet([{ src: base + 'icon-512.png', alt: 'The stam app icon' }, { src: base + 'icon.svg', alt: 'The stam mark' }], 0)} viewKey="image:story" /></div> },
    { name: 'One image', render: () => <div style={{ height: 360 }}><ImageTabView id={addImageSet([{ src: base + 'icon.svg', alt: 'The stam mark' }], 0)} viewKey="image:story1" /></div> },
  ],
}]

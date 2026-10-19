// A staged image in a world tab (S-1475): the image viewer's zoom and pan in a pane, with arrows
// (buttons, and the arrow keys) to the previous and next staged image.
import { useEffect, useRef } from 'react'
import { Icon } from '../Icon'
import { ZoomImage } from '../ImageViewer'
import { dropImageSet, stepImage, useImageSet } from '../image-tab'
import { registerView } from '../shell/layout'

export function ImageTabView({ id, viewKey }: { id: string; viewKey: string }) {
  const s = useImageSet(id)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => registerView(viewKey, { focus: () => root.current?.focus() }), [viewKey])
  useEffect(() => () => dropImageSet(id), [id])
  if (!s) return <div className="it-view it-none muted">This image is no longer staged</div>
  const img = s.images[s.index]
  const many = s.images.length > 1
  return (
    <div className="it-view" ref={root} tabIndex={0} aria-label={img.alt || 'Staged image'}
      onKeyDown={(e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); stepImage(id, e.key === 'ArrowLeft' ? -1 : 1) }
      }}>
      <ZoomImage src={img.src} alt={img.alt} />
      {many
        ? <>
            <button className="icon-btn it-prev" type="button" title="Previous image (←)" aria-label="Previous image" disabled={s.index === 0} onClick={() => stepImage(id, -1)}><Icon name="arrow-left" /></button>
            <button className="icon-btn it-next" type="button" title="Next image (→)" aria-label="Next image" disabled={s.index === s.images.length - 1} onClick={() => stepImage(id, 1)}><Icon name="arrow-right" /></button>
            <div className="it-count muted" aria-live="polite">{s.index + 1} / {s.images.length}</div>
          </>
        : null}
    </div>
  )
}

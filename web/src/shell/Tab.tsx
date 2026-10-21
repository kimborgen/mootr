// The tab anatomy every tab strip shares (S-1433): [glyph] title [chips] [close], with a
// bar that holds the tabs and, at its right end, an actions slot (the view switch, S-1433
// PR 2). Slots, not props per feature, so wait badges and ITSA links (later PRs) and the
// mail tabs (S-1471) fill the chips slot without a second tab component.
import { useRef, type DragEventHandler, type ReactNode, type Ref } from 'react'
import { Icon } from '../Icon'

// The chips a press on the tab can start on: an ITSA chip, a wait badge, an agent mark (S-1872).
const CHIP = '[data-itsa], [data-wait], [data-open-agent]'

export interface TabProps {
  id: string
  active?: boolean
  dropBefore?: boolean
  draggable?: boolean
  title: string
  tooltip?: string
  glyph: ReactNode
  chips?: ReactNode
  onSelect: () => void
  onClose?: () => void
  onDragStart?: DragEventHandler<HTMLDivElement>
  onDragEnd?: DragEventHandler<HTMLDivElement>
}

export function Tab(p: TabProps) {
  // Where the press began. A chip's own stopPropagation keeps the press from the tab's bubbling handlers,
  // so this records it in the capture phase. A drag starts on the tab, so its dragstart is the place to stop it.
  // A pointer press, not a mouse one: a touch or pen drag fires dragstart with no mousedown before it.
  const pressed = useRef<EventTarget | null>(null)
  return (
    <div className={`tab ${p.active ? 'active' : ''} ${p.dropBefore ? 'drop-before' : ''}`} draggable={p.draggable} data-key={p.id} title={p.tooltip ?? p.title}
      onClick={p.onSelect} onAuxClick={(e) => { if (e.button === 1) p.onClose?.() }}
      onPointerDownCapture={(e) => { pressed.current = e.target }}
      onDragStart={(e) => {
        if (pressed.current instanceof Element && pressed.current.closest(CHIP)) { e.preventDefault(); return }
        p.onDragStart?.(e)
      }} onDragEnd={p.onDragEnd}>
      {p.glyph}<span className="label">{p.title}</span>{p.chips}
      {p.onClose ? <button className="icon-btn close" aria-label={`Close ${p.title}`} onClick={(e) => { e.stopPropagation(); p.onClose!() }}><Icon name="x" size="xs" /></button> : null}
    </div>
  )
}

export function TabBar({ tabsRef, children, actions }: { tabsRef?: Ref<HTMLDivElement>; children: ReactNode; actions?: ReactNode }) {
  return <div className="tabbar"><div className="tabs" ref={tabsRef}>{children}</div>{actions}</div>
}

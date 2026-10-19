// The tab anatomy every tab strip shares (S-1433): [glyph] title [chips] [close], with a
// bar that holds the tabs and, at its right end, an actions slot (the view switch, S-1433
// PR 2). Slots, not props per feature, so wait badges and ITSA links (later PRs) and the
// mail tabs (S-1471) fill the chips slot without a second tab component.
import type { DragEventHandler, ReactNode, Ref } from 'react'
import { Icon } from '../Icon'

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
  return (
    <div className={`tab ${p.active ? 'active' : ''} ${p.dropBefore ? 'drop-before' : ''}`} draggable={p.draggable} data-key={p.id} title={p.tooltip ?? p.title}
      onClick={p.onSelect} onAuxClick={(e) => { if (e.button === 1) p.onClose?.() }} onDragStart={p.onDragStart} onDragEnd={p.onDragEnd}>
      {p.glyph}<span className="label">{p.title}</span>{p.chips}
      {p.onClose ? <button className="icon-btn close" aria-label={`Close ${p.title}`} onClick={(e) => { e.stopPropagation(); p.onClose!() }}><Icon name="x" size="xs" /></button> : null}
    </div>
  )
}

export function TabBar({ tabsRef, children, actions }: { tabsRef?: Ref<HTMLDivElement>; children: ReactNode; actions?: ReactNode }) {
  return <div className="tabbar"><div className="tabs" ref={tabsRef}>{children}</div>{actions}</div>
}

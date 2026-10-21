// The issue card (S-1438 PR 3): one ITSA drawn from the issue card layout (card-layout.ts). Its five
// slots, TOP, TITLE, META, BADGES and FOOT, take their items from the card-item registry; an empty
// slot takes no height. The key, the title, the needs-you badge and the ⋯ menu are drawn in every
// layout. `board` is the kanban card; `nested`, inside a system-view agent card, comes in PR 4.
import { Fragment, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Icon } from '../Icon'
import { useLongPress } from '../ui/longpress'
import type { CardLayout } from '../card-layout'
import { badge, type CellContext } from '../work/columns'
import { cardItems, type CardItem } from '../work/card-items'
import type { Field } from './fields'
import { LINK_KINDS } from '../work/links'
import type { Itsa } from '../types'
import { statusInfo, statusLabel, waitsOnHuman } from './itsa'
import type { Mode } from './board-views'

export type IssueCardSize = 'board' | 'nested'

// Every card item by id, for one page's fields. A board builds it once per render and shares it with its cards.
export const cardItemMap = (fields: Field[]): Map<string, CardItem> => new Map(cardItems(fields).map((i) => [i.id, i]))

// What the card reads from where it sits: the column it is in, the parent's key when the board shows
// subtrees (else null), the card items by id, and the fields and context its items draw from.
export interface IssueCardState {
  column: string
  mode: Mode
  parentKey: string | null
  dragging: boolean
  items: Map<string, CardItem>
  fields: Field[]
  cx: CellContext
}

// The card's gestures, given by its board.
export interface IssueCardActions {
  onOpen: () => void
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
  onMenu: (el: HTMLElement, at?: { x: number; y: number }) => void
}

// The layout's `links` stands for every link kind, in the order the Work columns give them.
const expand = (ids: string[]) => ids.flatMap((id) => (id === 'links' ? [...LINK_KINDS] : [id]))

// The items that sit at a row's right end (the board's health and the owner): a spacer goes before the
// first of them, so they push right as they did before the layout.
const TRAILING = ['health', 'owner']

// The nodes a slot draws, in order, from the registry's inline or chip form. A form that draws nothing
// is left out, so an empty item takes no room.
function drawn(ids: string[], form: 'inline' | 'chip', it: Itsa, s: IssueCardState): { id: string; node: ReactNode }[] {
  return expand(ids).flatMap((id): { id: string; node: ReactNode }[] => {
    if (id === 'status' && s.mode !== 'category' && s.column === it.status) return []
    // The parent is drawn only when the board passes one (it shows subtrees), in either form.
    if (id === 'parent') {
      if (!s.parentKey) return []
      return [{ id, node: form === 'inline' ? <span className="bc-parent" title="Parent"><Icon name="corner-left-up" size="xs" />{s.parentKey}</span> : badge(s.parentKey, 'Parent') }]
    }
    const node = s.items.get(id)?.[form]?.({ it, agent: null, cx: s.cx })
    return node === null || node === undefined || node === false ? [] : [{ id, node }]
  })
}

// A slot's nodes with the spacer before its first trailing item, if it has one.
const withSpacer = (items: { id: string; node: ReactNode }[]): ReactNode[] => {
  const at = items.findIndex((i) => TRAILING.includes(i.id))
  return items.flatMap((i, n) => (n === at
    ? [<span key="spacer" className="spacer" />, <Fragment key={i.id}>{i.node}</Fragment>]
    : [<Fragment key={i.id}>{i.node}</Fragment>]))
}

export function IssueCard({ itsa: x, layout, size, state: s, actions: a }: {
  itsa: Itsa; layout: CardLayout; size: IssueCardSize; state: IssueCardState; actions: IssueCardActions
}) {
  // The key (m, the context-menu key, Shift+F10) stays with the board's own key handler.
  const { onKeyDown: _k, ...lp } = useLongPress((at) => a.onMenu(at.el, at.how === 'key' ? undefined : at))
  // The system view's nested card lands in PR 4; until then it draws nothing.
  if (size === 'nested') return null
  const st = statusInfo(x.status)
  const human = waitsOnHuman(x)
  const top = drawn(layout.slots.TOP ?? [], 'inline', x, s)
  const meta = drawn(layout.slots.META ?? [], 'inline', x, s)
  const badges = drawn(layout.slots.BADGES ?? [], 'chip', x, s)
  const foot = drawn(layout.slots.FOOT ?? [], 'inline', x, s)
  // The needs-you mark and the menu sit at the right end of TOP, after the spacer unless the layout's own trailing items already push.
  const topPushed = top.some((i) => TRAILING.includes(i.id))
  return (
    <div className={'bcard' + (s.dragging ? ' dragging' : '') + (st.category === 'closed' ? ' closed' : '')} data-card={x.id} data-status={x.status} role="button" tabIndex={0}
      aria-roledescription="card" aria-label={`${x.key} ${x.title}, ${statusLabel(x.status)}${human ? ', waits on you' : ''}. Shift and arrows move it`}
      onClick={a.onOpen} onKeyDown={a.onKeyDown} {...lp} onPointerDown={(e) => { lp.onPointerDown(e); a.onPointerDown(e) }}>
      <div className="bc-top">
        <span className="ikey">{x.key}</span>
        {withSpacer(top)}
        {topPushed ? null : <span className="spacer" />}
        {human ? <span className="badge warn" title={`${statusLabel(x.status)}: waits on you`}><Icon name="user" size="xs" /></span> : null}
        <button type="button" className="icon-btn bc-menu" aria-label={`Move ${x.key}`} title="Move to…" tabIndex={-1}
          onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); a.onMenu(e.currentTarget) }}><Icon name="ellipsis" size="xs" /></button>
      </div>
      <div className="bc-title" style={{ WebkitLineClamp: layout.titleLines ?? 3 } as CSSProperties}>{x.title}</div>
      {meta.length ? <div className="bc-meta">{withSpacer(meta)}</div> : null}
      {badges.length ? <div className="bc-badges">{badges.map((i) => <Fragment key={i.id}>{i.node}</Fragment>)}</div> : null}
      {foot.length ? <div className="bc-foot">{foot.map((i) => <Fragment key={i.id}>{i.node}</Fragment>)}</div> : null}
    </div>
  )
}

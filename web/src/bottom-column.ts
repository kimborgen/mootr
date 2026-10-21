import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import * as shell from './shell/layout'

// The bottom prompt input (S-2284) takes the focused pane's column, so its content edges are the
// column's edges: the messages' column of an agent's conversation (`.ov-col`) or a mail thread's
// (`.thread-head`, centred at --measure-conversation). The input's own box stays full width, so its
// hairline and background span the centre; only its content moves. A pane without a column keeps
// the pane's width with the pane gutter. Other worlds and a phone keep the class's own padding.
const FOCUSED = '#w-main .pane.focused'
const COLUMN = '.ov-col, .thread-head'
const ACTIVE_VIEW = '.pane-body > [data-key]'
const MUTATIONS: MutationObserverInit = { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] }

// The focused pane, and the column of its active view (a hidden tab's view keeps its column,
// with no box, so only the shown view is read). A column with no width is no column.
export function focused(): { pane: Element | null; column: Element | null } {
  const pane = document.querySelector(FOCUSED)
  const view = pane ? [...pane.querySelectorAll<HTMLElement>(ACTIVE_VIEW)].find((el) => !el.hidden) : undefined
  const column = view ? [...view.querySelectorAll(COLUMN)].find((el) => el.getBoundingClientRect().width > 0) ?? null : null
  return { pane, column }
}

// Puts the input's content edges at the column's (or, without one, the pane's) edges, measured from
// the centre (#center), as side padding on the input. Without a pane the padding is the class's.
export function placeBottom(bottom: HTMLElement, pane: Element | null, column: Element | null) {
  const center = bottom.parentElement
  if (!pane || !center) {
    bottom.style.paddingLeft = ''
    bottom.style.paddingRight = ''
    return
  }
  const c = center.getBoundingClientRect()
  const edge = (column ?? pane).getBoundingClientRect()
  const left = Math.max(0, edge.left - c.left), right = Math.max(0, c.right - edge.right)
  // Without a column the pane's gutter stays, as the input's own padding has it. A value that
  // hasn't changed is not written again.
  const l = column ? `${left}px` : `calc(${left}px + var(--pad-pane))`
  const r = column ? `${right}px` : `calc(${right}px + var(--pad-pane))`
  if (bottom.style.paddingLeft !== l) bottom.style.paddingLeft = l
  if (bottom.style.paddingRight !== r) bottom.style.paddingRight = r
}

// A mutation that can move the column: a view added or removed in the pane's body, or a view's
// `hidden` flipped (a tab switch). A change inside a view (a message streaming in) can't.
const moves = (r: MutationRecord) => r.type === 'attributes' || (r.target as Element).classList?.contains('pane-body')

// Keeps the input on the focused pane's column while `isOn` holds. It re-places on a focus change
// (`sync`), when the column mounts or changes in the pane (a MutationObserver on the pane), and when
// the pane, its column or the centre is resized (a ResizeObserver). `disconnect` ends both.
export function bottomColumn(bottom: HTMLElement, isOn: () => boolean) {
  let pane: Element | null = null
  let column: Element | null = null
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => placeBottom(bottom, pane, column))
  // The column is looked up again only when it is missing or gone, or when a tab moved; otherwise a
  // streamed message costs no lookup here. It still re-places with the cached column, since a
  // message can overflow the view and bring a scrollbar that shifts a centred column.
  const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
    if (!column || !column.isConnected || records.some(moves)) sync()
    else placeBottom(bottom, pane, column)
  })

  function sync() {
    const cur = isOn() && !shell.isPhone() ? focused() : { pane: null, column: null }
    if (cur.pane !== pane || cur.column !== column) {
      pane = cur.pane
      column = cur.column
      mo?.disconnect()
      if (pane) mo?.observe(pane, MUTATIONS)
      ro?.disconnect()
      for (const el of [bottom.parentElement, pane, column]) if (el) ro?.observe(el)
    }
    placeBottom(bottom, pane, column)
  }

  sync()
  return {
    sync,
    disconnect() {
      ro?.disconnect()
      mo?.disconnect()
      pane = null
      column = null
    },
  }
}

// The hook: `on` says whether the input takes the focused pane's column (a desktop conversation or
// thread). It re-syncs after every render, so a focus change moves the input.
export function useBottomColumn(ref: RefObject<HTMLElement | null>, on: boolean) {
  const isOn = useRef(on)
  const column = useRef<ReturnType<typeof bottomColumn> | null>(null)

  useLayoutEffect(() => {
    isOn.current = on
    column.current?.sync()
  })

  useEffect(() => {
    const bottom = ref.current
    if (!bottom) return
    const c = bottomColumn(bottom, () => isOn.current)
    column.current = c
    return () => { c.disconnect(); column.current = null }
  }, [])
}

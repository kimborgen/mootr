// The board (view key `board:ID` for an ITSA, `board:all` for every root): one column per
// category, or per status, with a card per ITSA. Scope is the direct children (or the roots)
// or the whole subtree flattened, where each card names its parent. Dragging a card to
// another column sets its status as the human (the category's first status, or the exact
// status), and dragging within a column orders it through `rank`; both show at once and
// roll back if the daemon refuses. The keyboard moves focus with the arrows, moves the card
// with Shift and the arrows, and opens "Move to…" with M or the menu key. The closed
// column folds, and shows only the most recently closed. Live through the store's polling.
// On a phone (360-430 px) one column shows at a time, full width, chosen by the strip of column
// chips with their counts or by a sideways swipe. A long press (or the card's menu) opens the
// move sheet, and a tap opens the ITSA. The desktop is unchanged.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { api } from '../api'
import { Icon } from '../Icon'
import { isPhone, refreshTabs, registerView } from '../shell/layout'
import { getData, refreshItsas, useData } from '../store'
import type { Itsa, ItsaCategory } from '../types'
import { useLongPress } from '../ui/longpress'
import { showMenu, toast, type MenuItem } from '../ui/menu'
import { CATEGORIES, CATEGORY_LABEL, HEALTH, openItsa, PersonGlyph, personName, RollupBar, rollupOf, rollupTotal, StatusGlyph, statusInfo, statusLabel, toneVar, waitsOnHuman } from './itsa'
import { loadPrefs, prefsFor, saveView, type Mode, type Prefs, type Scope } from './board-views'

// The closed column shows this many, most recently closed first, until asked for all.
const CLOSED_SHOWN = 10

// A column: what it holds, and the status a card dropped on it takes.
interface Col { id: string; label: string; category: ItsaCategory; target: string; statuses: string[] }

function columnsFor(mode: Mode): Col[] {
  const all = getData().itsaStatuses
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
  if (mode === 'status') return all.map((s) => ({ id: s.name, label: cap(statusLabel(s.name)), category: s.category, target: s.name, statuses: [s.name] }))
  return CATEGORIES.flatMap((c) => {
    const ss = all.filter((s) => s.category === c).map((s) => s.name)
    return ss.length ? [{ id: c, label: CATEGORY_LABEL[c], category: c, target: ss[0], statuses: ss }] : []
  })
}

// Order within a column: `rank` once set by a drag, else creation time, on one scale.
export const rankOf = (x: Pick<Itsa, 'rank' | 'created_at'>) => x.rank ?? Date.parse(x.created_at)
const closedAt = (x: Itsa) => Date.parse(x.closed_at ?? x.updated_at)

// The ITSAs a board holds: the scope's children (or the roots), or everything below it.
function inScope(all: Itsa[], id: string | null, scope: Scope): Itsa[] {
  const known = new Set(all.map((x) => x.id))
  const parentOf = (x: Itsa) => (x.parent_id && known.has(x.parent_id) ? x.parent_id : null)
  if (scope === 'children') return all.filter((x) => parentOf(x) === id)
  if (!id) return all
  const below = new Set<string>([id])
  // Parents come before children in creation order mostly, but reparenting breaks that.
  for (let grew = true; grew;) {
    grew = false
    for (const x of all) { const p = parentOf(x); if (p && below.has(p) && !below.has(x.id)) { below.add(x.id); grew = true } }
  }
  below.delete(id)
  return all.filter((x) => below.has(x.id))
}

const END = '\u0000end'
const LINK_ICON: Record<string, string> = { github: 'git-branch' }

function Card({ x, col, mode, parentKey, dragging, onOpen, onPointerDown, onKeyDown, onMenu }: {
  x: Itsa; col: Col; mode: Mode; parentKey: string | null; dragging: boolean; onOpen: () => void
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  onMenu: (el: HTMLElement, at?: { x: number; y: number }) => void
}) {
  const st = statusInfo(x.status)
  const r = rollupOf(x.id, getData().itsas)
  const h = x.health ? HEALTH[x.health] : null
  const human = waitsOnHuman(x)
  const chip = mode === 'category' || col.id !== x.status
  const links = x.links ?? []
  // The key (m, the context-menu key, Shift+F10) stays with the board's own key handler.
  const { onKeyDown: _k, ...lp } = useLongPress((at) => onMenu(at.el, at.how === 'key' ? undefined : at))
  return (
    <div className={'bcard' + (dragging ? ' dragging' : '') + (st.category === 'closed' ? ' closed' : '')} data-card={x.id} data-status={x.status} role="button" tabIndex={0}
      aria-roledescription="card" aria-label={`${x.key} ${x.title}, ${statusLabel(x.status)}${human ? ', waits on you' : ''}. Shift and arrows move it`}
      onClick={onOpen} onKeyDown={onKeyDown} {...lp} onPointerDown={(e) => { lp.onPointerDown(e); onPointerDown(e) }}>
      <div className="bc-top">
        <span className="ikey">{x.key}</span>
        {parentKey ? <span className="bc-parent" title="Parent"><Icon name="corner-left-up" size="xs" />{parentKey}</span> : null}
        {x.kind ? <span className="chip kind">{x.kind}</span> : null}
        <span className="spacer" />
        {h ? <span className="hdot" style={{ color: h.tone }} title={`${h.label}, from the owner's latest update`} role="img" aria-label={h.label}><i /></span> : null}
        {human ? <span className="badge warn" title={`${statusLabel(x.status)}: waits on you`}><Icon name="user" size="xs" /></span> : null}
        <button type="button" className="icon-btn bc-menu" aria-label={`Move ${x.key}`} title="Move to…" tabIndex={-1}
          onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onMenu(e.currentTarget) }}><Icon name="ellipsis" size="xs" /></button>
      </div>
      <div className="bc-title">{x.title}</div>
      {chip || rollupTotal(r) || links.length || x.owner ? <div className="bc-meta">
        {chip ? <span className="bc-status" style={{ color: toneVar(x.status) }}><StatusGlyph status={x.status} />{statusLabel(x.status)}</span> : null}
        <RollupBar r={r} />
        {links.length ? <span className="bc-links">{links.map((l) => (
          <a key={l.n} href={l.url} target="_blank" rel="noreferrer noopener" title={l.external_id ?? l.url} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <Icon name={LINK_ICON[l.system] ?? 'link'} size="xs" /></a>))}</span> : null}
        <span className="spacer" />
        {x.owner ? <span title={`Owner: ${personName(x.owner)}`}><PersonGlyph id={x.owner} /></span> : null}
      </div> : null}
    </div>
  )
}

export function Board({ id, viewKey }: { id: string | null; viewKey: string }) {
  const { itsas } = useData()
  const prefsKey = id ?? 'all'
  const [prefs, setPrefsState] = useState<Prefs>(() => prefsFor(prefsKey))
  useEffect(() => { loadPrefs(prefsKey).then(setPrefsState).catch(() => {}) }, [prefsKey])
  const setPrefs = (p: Partial<Prefs>) => setPrefsState((cur) => { const n = { ...cur, ...p }; saveView(prefsKey, n); return n })
  // Moves shown before the daemon confirms them, by ITSA id; `seq` tells a newer move's apart.
  const [over, setOver] = useState<Record<string, { status?: string; rank?: number; seq: number }>>({})
  const seq = useRef(0)
  const [drag, setDrag] = useState<{ id: string; col: string | null; index: number } | null>(null)
  const refocus = useRef<string | null>(null)
  // A drag ends in a click on the card; that click isn't an open.
  const dragged = useRef(false)
  // The phone: the column showing, and a touch's start for a swipe.
  const [phoneCol, setPhoneCol] = useState<string | null>(null)
  const swipeAt = useRef<{ x: number; y: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => registerView(viewKey, { focus: () => root.current?.querySelector<HTMLElement>('.bcard')?.focus() }), [viewKey])
  useEffect(() => { refreshTabs() }, [itsas.length])

  const self = id ? itsas.find((x) => x.id === id) : null
  const cols = columnsFor(prefs.mode)
  const shown = inScope(itsas, id, prefs.scope).map((x) => (over[x.id] ? { ...x, ...over[x.id] } : x))
  const colOf = (x: Itsa) => (prefs.mode === 'category'
    ? cols.find((c) => c.category === statusInfo(x.status).category)
    : cols.find((c) => c.id === x.status) ?? cols.find((c) => c.category === statusInfo(x.status).category))
  const byCol = new Map<string, Itsa[]>(cols.map((c) => [c.id, []]))
  for (const x of shown) { const c = colOf(x); if (c) byCol.get(c.id)!.push(x) }
  for (const c of cols) byCol.get(c.id)!.sort(c.category === 'closed' ? (a, b) => closedAt(b) - closedAt(a) : (a, b) => rankOf(a) - rankOf(b) || a.created_at.localeCompare(b.created_at))
  // What each column shows: the closed ones only the most recent, unless asked for all.
  const visible = (c: Col) => { const xs = byCol.get(c.id)!; return c.category === 'closed' && !prefs.closedAll ? xs.slice(0, CLOSED_SHOWN) : xs }
  const keyOf = new Map(itsas.map((x) => [x.id, x.key]))
  const phone = isPhone()
  // The phone's column: the one chosen, else the first with cards, else the first.
  const active = phone ? cols.find((c) => c.id === phoneCol) ?? cols.find((c) => byCol.get(c.id)!.length) ?? cols[0] : null
  // A sideways swipe, or a tap on a chip, shows another column; an edge stops it.
  const step = (d: number) => { const j = cols.findIndex((c) => c.id === active?.id) + d; if (j >= 0 && j < cols.length) setPhoneCol(cols[j].id) }

  useLayoutEffect(() => {
    if (!refocus.current) return
    root.current?.querySelector<HTMLElement>(`.bcard[data-card="${refocus.current}"]`)?.focus()
    refocus.current = null
  })

  // Moves a card to a column, before the card now at `index` among the others there (the
  // end when past them); without an index it keeps its rank. A closed column orders by
  // when things closed, so a drop there only sets the status.
  async function move(x: Itsa, col: Col, index?: number) {
    const patch: { status?: string; rank?: number } = {}
    if (!col.statuses.includes(x.status)) patch.status = col.target
    const others = byCol.get(col.id)!.filter((y) => y.id !== x.id)
    let renumber: Itsa[] | null = null
    if (index !== undefined && col.category !== 'closed') {
      const cur = byCol.get(col.id)!.findIndex((y) => y.id === x.id)
      if (cur !== index || patch.status) {
        const prev = others[index - 1], next = others[index]
        const r = prev && next ? (rankOf(prev) + rankOf(next)) / 2 : prev ? rankOf(prev) + 1000 : next ? rankOf(next) - 1000 : rankOf(x)
        // Halved too often to fit between two neighbours: space the whole column again.
        if ((prev && r === rankOf(prev)) || (next && r === rankOf(next))) renumber = [...others.slice(0, index), x, ...others.slice(index)]
        else if (r !== rankOf(x)) patch.rank = r
      }
    }
    if (renumber) {
      const base = rankOf(renumber[0])
      return Promise.all(renumber.map((y, i) => save(y, { ...(y.id === x.id ? patch : {}), rank: base + i * 1000 })))
    }
    return save(x, patch)
  }
  async function save(x: Itsa, patch: { status?: string; rank?: number }) {
    if (!Object.keys(patch).length) return
    const n = ++seq.current
    setOver((o) => ({ ...o, [x.id]: { ...o[x.id], ...patch, seq: n } }))
    try {
      await api('PATCH', `/api/itsas/${x.id}`, patch)
      await refreshItsas()
    } catch (e) {
      toast(`Couldn't move ${x.key}: ${(e as Error).message}`, true)
    } finally {
      setOver((o) => { if (o[x.id]?.seq !== n) return o; const c = { ...o }; delete c[x.id]; return c })
    }
  }

  // "Move to…": every column but the card's own, and opening it.
  function menuFor(x: Itsa, el: HTMLElement, at?: { x: number; y: number }) {
    const here = colOf(x)
    const items: MenuItem[] = [{ label: 'Open', icon: 'arrow-right', action: () => openItsa(x.id) }, { section: 'Move to' }]
    for (const c of cols) items.push({ label: c.label, glyph: <StatusGlyph status={c.target} />, checked: c.id === here?.id, hint: prefs.mode === 'category' && c.id !== here?.id ? statusLabel(c.target) : undefined,
      action: () => { if (c.id !== here?.id) { refocus.current = x.id; if (c.category === 'closed') setPrefs({ closedFolded: false }); move(x, c) } } })
    const r = el.getBoundingClientRect()
    showMenu(at?.x ?? r.left, at?.y ?? r.bottom + 4, items, el)
  }

  // Arrows move the focus between cards; with Shift they move the card.
  function key(e: React.KeyboardEvent<HTMLDivElement>, x: Itsa) {
    if (e.target !== e.currentTarget) return
    const ci = cols.findIndex((c) => c.id === colOf(x)?.id)
    const list = visible(cols[ci])
    const i = list.findIndex((y) => y.id === x.id)
    const focus = (y?: Itsa) => { if (y) root.current?.querySelector<HTMLElement>(`.bcard[data-card="${y.id}"]`)?.focus() }
    // The nearest column either way that shows a card, skipping a folded closed one.
    const nextCol = (d: number, from = ci) => { for (let j = from + d; j >= 0 && j < cols.length; j += d) if (!(cols[j].category === 'closed' && prefs.closedFolded)) return j; return -1 }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItsa(x.id); return }
    if (e.key === 'm' || e.key === 'M' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); menuFor(x, e.currentTarget); return }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
    e.preventDefault()
    const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown'
    const d = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1
    if (!e.shiftKey) {
      if (vertical) return focus(list[i + d])
      // The nearest column that way with a card in it.
      for (let j = nextCol(d), at = ci; j >= 0; at = j, j = nextCol(d, at)) {
        const there = visible(cols[j])
        if (there.length) return focus(there[Math.min(i, there.length - 1)])
      }
      return
    }
    refocus.current = x.id
    if (vertical) { if (cols[ci].category !== 'closed' && list[i + d]) move(x, cols[ci], d < 0 ? i - 1 : i + 1) }
    else { const j = nextCol(d); if (j >= 0) move(x, cols[j]) }
  }

  // A drag with the mouse or a pen: the card dims in place and a ghost follows the pointer
  // 1:1; the column under it takes the drop fill and a line marks where the card lands.
  // Touch keeps scrolling the board (the phone moves cards through the menu).
  function down(e: React.PointerEvent<HTMLDivElement>, x: Itsa) {
    if (e.button !== 0 || e.pointerType === 'touch' || isPhone()) return
    const el = e.currentTarget
    const box = el.getBoundingClientRect()
    const x0 = e.clientX, y0 = e.clientY
    let ghost: HTMLElement | null = null
    let target: { col: Col; index: number } | null = null
    const where = (cx: number, cy: number) => {
      const colEl = document.elementFromPoint(cx, cy)?.closest<HTMLElement>('.bcol[data-col]')
      const col = colEl && root.current?.contains(colEl) ? cols.find((c) => c.id === colEl.dataset.col) : undefined
      if (!col) return null
      const cards = [...colEl!.querySelectorAll<HTMLElement>('.bcard')].filter((c) => c.dataset.card !== x.id)
      const index = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return cy < r.top + r.height / 2 })
      return { col, index: index < 0 ? cards.length : index }
    }
    const moveTo = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return
        ghost = el.cloneNode(true) as HTMLElement
        ghost.classList.add('ghost')
        ghost.removeAttribute('data-card')
        Object.assign(ghost.style, { width: box.width + 'px' })
        document.body.append(ghost)
        document.body.classList.add('board-dragging')
      }
      ghost.style.transform = `translate(${ev.clientX - x0 + box.left}px, ${ev.clientY - y0 + box.top}px)`
      // Near either edge of the lanes, they scroll that way, so a far column can be reached.
      const lanes = root.current?.querySelector<HTMLElement>('.board-cols')
      if (lanes) {
        const r = lanes.getBoundingClientRect(), edge = r.width / 12
        if (ev.clientX < r.left + edge) lanes.scrollLeft -= edge / 2
        else if (ev.clientX > r.right - edge) lanes.scrollLeft += edge / 2
      }
      target = where(ev.clientX, ev.clientY)
      setDrag({ id: x.id, col: target?.col.id ?? null, index: target?.index ?? -1 })
    }
    const end = (drop: boolean) => {
      removeEventListener('pointermove', moveTo)
      removeEventListener('pointerup', up)
      removeEventListener('keydown', esc, true)
      if (!ghost) return
      ghost.remove()
      document.body.classList.remove('board-dragging')
      setDrag(null)
      dragged.current = true
      setTimeout(() => { dragged.current = false }, 0)
      if (drop && target) move(x, target.col, target.index)
    }
    const up = () => end(true)
    const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(false) } }
    addEventListener('pointermove', moveTo)
    addEventListener('pointerup', up)
    addEventListener('keydown', esc, true)
  }

  const title = id ? (self ? <><span className="ikey">{self.key}</span>{self.title}</> : 'Board') : 'All issues'
  const total = shown.length
  return (
    <div className="board-view" ref={root} data-board={prefsKey} data-mode={prefs.mode} data-scope={prefs.scope}>
      <div className="board-bar">
        <h2>{title}</h2>
        <span className="count" title={`${total} on this board`}>{total}</span>
        {self ? <button type="button" className="btn text" onClick={() => openItsa(self.id)}>Open</button> : null}
        <span className="spacer" />
        <div className="seg" role="radiogroup" aria-label="Scope">
          <button type="button" role="radio" aria-checked={prefs.scope === 'children'} className={prefs.scope === 'children' ? 'on' : ''} data-scope-btn="children" onClick={() => setPrefs({ scope: 'children' })}>{id ? 'Children' : 'Roots'}</button>
          <button type="button" role="radio" aria-checked={prefs.scope === 'subtree'} className={prefs.scope === 'subtree' ? 'on' : ''} data-scope-btn="subtree" onClick={() => setPrefs({ scope: 'subtree' })}>{id ? 'Whole subtree' : 'Everything'}</button>
        </div>
        <div className="seg" role="radiogroup" aria-label="Columns">
          <button type="button" role="radio" aria-checked={prefs.mode === 'category'} className={prefs.mode === 'category' ? 'on' : ''} data-mode-btn="category" onClick={() => setPrefs({ mode: 'category' })}>Categories</button>
          <button type="button" role="radio" aria-checked={prefs.mode === 'status'} className={prefs.mode === 'status' ? 'on' : ''} data-mode-btn="status" onClick={() => setPrefs({ mode: 'status' })}>Statuses</button>
        </div>
      </div>
      {phone ? <div className="board-strip" role="tablist" aria-label="Board columns">{cols.map((c) => (
        <button key={c.id} type="button" role="tab" aria-selected={c.id === active?.id} data-col-chip={c.id} onClick={() => setPhoneCol(c.id)}>
          <StatusGlyph status={c.target} /><span className="bcol-name">{c.label}</span><span className="count">{byCol.get(c.id)!.length}</span></button>))}</div> : null}
      <div className={'board-cols' + (phone ? ' one' : '')} role="list" aria-label="Columns"
        onTouchStart={phone ? (e) => { const t = e.touches[0]; swipeAt.current = { x: t.clientX, y: t.clientY } } : undefined}
        onTouchEnd={phone ? (e) => {
          const s0 = swipeAt.current
          swipeAt.current = null
          const t = e.changedTouches[0]
          if (!s0 || !t) return
          const dx = t.clientX - s0.x, dy = t.clientY - s0.y
          if (Math.abs(dx) > 48 && Math.abs(dx) > 1.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1)
        } : undefined}>
        {cols.map((c) => {
          if (phone && c.id !== active?.id) return null
          const all = byCol.get(c.id)!
          const xs = visible(c)
          const closed = c.category === 'closed'
          const folded = closed && prefs.closedFolded && !phone
          const target = drag && drag.col === c.id
          const st = statusInfo(c.target)
          // Where a dragged card lands: before this card, or at the end.
          const others = target && !closed ? xs.filter((x) => x.id !== drag!.id) : []
          const line = target && !closed ? others[drag!.index]?.id ?? END : null
          if (folded) return (
            <div key={c.id} className={'bcol folded' + (target ? ' drop' : '')} data-col={c.id} role="listitem">
              <button type="button" className="bcol-unfold" aria-expanded={false} title={`Show ${c.label.toLowerCase()}`} onClick={() => setPrefs({ closedFolded: false })}>
                <StatusGlyph status={c.target} /><span className="bcol-name">{c.label}</span><span className="count">{all.length}</span></button>
            </div>)
          return (
            <div key={c.id} className={'bcol' + (target ? ' drop' : '') + (!all.length ? ' empty' : '')} data-col={c.id} data-category={c.category} role="listitem" aria-label={`${c.label}, ${all.length}`}>
              <div className="bcol-head" style={{ '--tc': toneVar(c.target) } as CSSProperties}>
                <StatusGlyph status={c.target} />
                <span className="bcol-name">{c.label}</span>
                {st.human && prefs.mode === 'status' ? <span className="badge warn" title="Waits on you"><Icon name="user" size="xs" /></span> : null}
                <span className="count">{all.length}</span>
                <span className="spacer" />
                {closed ? <button type="button" className="icon-btn bcol-fold" aria-expanded title={`Fold ${c.label.toLowerCase()}`} aria-label={`Fold ${c.label.toLowerCase()}`} onClick={() => setPrefs({ closedFolded: true })}><Icon name="minimize-2" size="xs" /></button> : null}
              </div>
              <div className="bcol-cards">
                {xs.map((x) => (
                  <div key={x.id} className="bslot">
                    {line === x.id ? <div className="bdrop-line" /> : null}
                    <Card x={x} col={c} mode={prefs.mode} parentKey={prefs.scope === 'subtree' && x.parent_id && x.parent_id !== id ? keyOf.get(x.parent_id) ?? null : null}
                      dragging={drag?.id === x.id} onOpen={() => { if (!dragged.current) openItsa(x.id) }} onPointerDown={(e) => down(e, x)} onKeyDown={(e) => key(e, x)} onMenu={(el, at) => menuFor(x, el, at)} />
                  </div>))}
                {line === END ? <div className="bdrop-line" /> : null}
                {!xs.length ? <p className="bcol-empty muted">{target ? 'Drop here' : 'Nothing here'}</p> : null}
                {closed && all.length > CLOSED_SHOWN ? <button type="button" className="btn text bcol-more" onClick={() => setPrefs({ closedAll: !prefs.closedAll })}>
                  {prefs.closedAll ? `Show the ${CLOSED_SHOWN} most recent` : `Show all ${all.length}`}</button> : null}
              </div>
            </div>)
        })}
      </div>
    </div>
  )
}
